import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { SimpleMessage } from "@/types";
import { getDb } from "../client";
import {
  channelMessages,
  messageRoleMentions,
  messageUserMentions,
} from "../schema";
import { upsertChannel, updateChannelStateAfterMessages } from "./channelsRepository";

type ChannelPersistenceMeta = {
  channelId: string;
  serverId: string | null;
  type: "guild_text" | "dm";
  ownerUserId?: string | null;
};

type PersistMessagesOptions = ChannelPersistenceMeta & {
  messages: SimpleMessage[];
};

export function persistMessages(options: PersistMessagesOptions): void {
  const { channelId, serverId, type, ownerUserId, messages } = options;
  if (!messages.length) {
    return;
  }

  upsertChannel({ channelId, serverId, type, ownerUserId });

  const db = getDb();

  db.transaction((tx) => {
    for (const message of messages) {
      tx
        .insert(channelMessages)
        .values({
          messageId: message.id,
          channelId: message.channelId,
          serverId: message.guildId ?? null,
          authorId: message.authorId,
          authorUsername: message.authorUsername,
          content: message.content,
          timestamp: message.timestamp,
          isBot: message.isBot ?? false,
          mentionsEveryone: message.mentionsEveryone ?? false,
          hasAttachments: message.hasAttachments ?? false,
          hasEmbeds: message.hasEmbeds ?? false,
          respondedTo: message.respondedTo ?? false,
          hasBeenRepliedTo: message.hasBeenRepliedTo ?? false,
          referenceMessageId: message.reference?.messageId ?? null,
          referenceChannelId: message.reference?.channelId ?? null,
          referenceGuildId: message.reference?.guildId ?? null,
        })
        .onConflictDoUpdate({
          target: channelMessages.messageId,
          set: {
            content: message.content,
            timestamp: message.timestamp,
            authorUsername: message.authorUsername,
            isBot: message.isBot ?? false,
            mentionsEveryone: message.mentionsEveryone ?? false,
            hasAttachments: message.hasAttachments ?? false,
            hasEmbeds: message.hasEmbeds ?? false,
            respondedTo: message.respondedTo ?? false,
            hasBeenRepliedTo: message.hasBeenRepliedTo ?? false,
            referenceMessageId: message.reference?.messageId ?? null,
            referenceChannelId: message.reference?.channelId ?? null,
            referenceGuildId: message.reference?.guildId ?? null,
          },
        })
        .run();

      tx
        .delete(messageUserMentions)
        .where(eq(messageUserMentions.messageId, message.id))
        .run();
      if (message.mentionedUsers?.length) {
        tx
          .insert(messageUserMentions)
          .values(
            message.mentionedUsers.map((userId) => ({
              messageId: message.id,
              userId,
            })),
          )
          .run();
      }

      tx
        .delete(messageRoleMentions)
        .where(eq(messageRoleMentions.messageId, message.id))
        .run();
      if (message.mentionedRoles?.length) {
        tx
          .insert(messageRoleMentions)
          .values(
            message.mentionedRoles.map((roleId) => ({
              messageId: message.id,
              roleId,
            })),
          )
          .run();
      }
    }
  });

  const lastMessageTimestamp = messages[messages.length - 1]!.timestamp;
  updateChannelStateAfterMessages(
    channelId,
    lastMessageTimestamp,
    messages.length,
    messages[messages.length - 1]?.id,
  );

}

export function getRecentMessages(
  channelId: string,
  limit: number,
  minTimestamp?: number,
): SimpleMessage[] {
  const db = getDb();
  const whereClause = minTimestamp
    ? and(
        eq(channelMessages.channelId, channelId),
        gte(channelMessages.timestamp, minTimestamp),
      )
    : eq(channelMessages.channelId, channelId);

  const rows = db
    .select()
    .from(channelMessages)
    .where(whereClause)
    .orderBy(desc(channelMessages.timestamp))
    .limit(limit)
    .all();

  if (!rows.length) {
    return [];
  }

  const messageIds = rows.map((row) => row.messageId);

  const userMentions = db
    .select()
    .from(messageUserMentions)
    .where(inArray(messageUserMentions.messageId, messageIds))
    .all();

  const roleMentions = db
    .select()
    .from(messageRoleMentions)
    .where(inArray(messageRoleMentions.messageId, messageIds))
    .all();

  const userMentionMap = new Map<string, string[]>();
  for (const mention of userMentions) {
    const list = userMentionMap.get(mention.messageId) ?? [];
    list.push(mention.userId);
    userMentionMap.set(mention.messageId, list);
  }

  const roleMentionMap = new Map<string, string[]>();
  for (const mention of roleMentions) {
    const list = roleMentionMap.get(mention.messageId) ?? [];
    list.push(mention.roleId);
    roleMentionMap.set(mention.messageId, list);
  }

  return rows
    .map<SimpleMessage>((row) => ({
      id: row.messageId,
      channelId: row.channelId,
      guildId: row.serverId ?? null,
      authorId: row.authorId,
      authorUsername: row.authorUsername ?? "",
      content: row.content,
      timestamp: row.timestamp,
      mentionedUsers: userMentionMap.get(row.messageId) ?? [],
      mentionedRoles: roleMentionMap.get(row.messageId) ?? [],
      mentionsEveryone: Boolean(row.mentionsEveryone),
      isBot: Boolean(row.isBot),
      respondedTo: Boolean(row.respondedTo),
      hasBeenRepliedTo: Boolean(row.hasBeenRepliedTo),
      hasAttachments: Boolean(row.hasAttachments),
      hasEmbeds: Boolean(row.hasEmbeds),
      reference: row.referenceMessageId
        ? {
            messageId: row.referenceMessageId,
            channelId: row.referenceChannelId ?? null,
            guildId: row.referenceGuildId ?? null,
          }
        : undefined,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function markMessageResponded(channelId: string, messageId: string): void {
  const db = getDb();
  db
    .update(channelMessages)
    .set({ respondedTo: true })
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageId, messageId),
      ),
    )
    .run();
}
