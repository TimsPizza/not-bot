import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { channelState, channels } from "../schema";

type ChannelType = "guild_text" | "dm";

type UpsertChannelParams = {
  channelId: string;
  serverId: string | null;
  type: ChannelType;
  ownerUserId?: string | null;
};

export function upsertChannel(params: UpsertChannelParams): void {
  const db = getDb();
  const { channelId, serverId, type, ownerUserId } = params;
  const timestamp = Date.now();

  db
    .insert(channels)
    .values({
      channelId,
      serverId: serverId ?? null,
      type,
      ownerUserId: ownerUserId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: channels.channelId,
      set: {
        serverId: serverId ?? null,
        type,
        ownerUserId: ownerUserId ?? null,
        updatedAt: timestamp,
      },
    })
    .run();

  db
    .insert(channelState)
    .values({
      channelId,
      messageCount: 0,
      lastMessageTimestamp: null,
      lastProcessedMessageId: null,
      updatedAt: timestamp,
    })
    .onConflictDoNothing()
    .run();
}

export function updateChannelStateAfterMessages(
  channelId: string,
  lastMessageTimestamp: number,
  messageCountIncrement: number,
  lastProcessedMessageId?: string | null,
): void {
  const db = getDb();
  const current = db
    .select()
    .from(channelState)
    .where(eq(channelState.channelId, channelId))
    .get();

  if (!current) {
    return;
  }

  const timestamp = Date.now();
  const nextCount = (current.messageCount ?? 0) + messageCountIncrement;

  db
    .update(channelState)
    .set({
      messageCount: nextCount,
      lastMessageTimestamp,
      lastProcessedMessageId:
        lastProcessedMessageId !== undefined
          ? lastProcessedMessageId
          : current.lastProcessedMessageId,
      updatedAt: timestamp,
    })
    .where(eq(channelState.channelId, channelId))
    .run();
}

export function getChannelState(channelId: string) {
  const db = getDb();
  return db
    .select()
    .from(channelState)
    .where(eq(channelState.channelId, channelId))
    .get();
}
