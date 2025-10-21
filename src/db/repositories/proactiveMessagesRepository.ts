import { and, eq, inArray, lte } from "drizzle-orm";
import {
  channelProactiveMessages,
  type ChannelProactiveMessageRow,
} from "../schema";
import { getDb } from "../client";
import type { ProactiveMessageStatus } from "@/types";

const ID_LENGTH = 5;

function encodeBase36(value: number): string {
  const base = value.toString(36);
  if (base.length >= ID_LENGTH) {
    return base.slice(-ID_LENGTH);
  }
  return base.padStart(ID_LENGTH, "0");
}

export interface CreateProactiveMessageInput {
  channelId: string;
  personaId: string;
  content: string;
  scheduledAt: number;
  reason?: string;
  metadata?: unknown;
}

export function createProactiveMessage(
  input: CreateProactiveMessageInput,
): ChannelProactiveMessageRow {
  const db = getDb();
  const placeholder = `tmp_${Math.random().toString(36).slice(2, 2 + ID_LENGTH)}`;

  const result = db
    .insert(channelProactiveMessages)
    .values({
      publicId: placeholder,
      channelId: input.channelId,
      personaId: input.personaId,
      content: input.content,
      scheduledAt: input.scheduledAt,
      status: "scheduled",
      reason: input.reason ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .run();

  const insertedId = Number(result.lastInsertRowid);
  if (!Number.isFinite(insertedId)) {
    throw new Error("Failed to insert proactive message");
  }

  const officialId = encodeBase36(insertedId).toLowerCase();

  db
    .update(channelProactiveMessages)
    .set({
      publicId: officialId,
      updatedAt: Date.now(),
    })
    .where(eq(channelProactiveMessages.id, insertedId))
    .run();

  const created = getProactiveMessageByPublicId(officialId);
  if (!created) {
    throw new Error("Proactive message inserted but could not be retrieved");
  }
  return created;
}

export function getProactiveMessageByPublicId(
  publicId: string,
): ChannelProactiveMessageRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(channelProactiveMessages)
    .where(eq(channelProactiveMessages.publicId, publicId))
    .limit(1)
    .get();
}

export function listPendingProactiveMessages(
  channelId: string,
): ChannelProactiveMessageRow[] {
  const db = getDb();
  return db
    .select()
    .from(channelProactiveMessages)
    .where(
      and(
        eq(channelProactiveMessages.channelId, channelId),
        eq(channelProactiveMessages.status, "scheduled"),
      ),
    )
    .orderBy(channelProactiveMessages.scheduledAt)
    .all();
}

export function listDueProactiveMessages(
  now: number,
): ChannelProactiveMessageRow[] {
  const db = getDb();
  return db
    .select()
    .from(channelProactiveMessages)
    .where(
      and(
        eq(channelProactiveMessages.status, "scheduled"),
        lte(channelProactiveMessages.scheduledAt, now),
      ),
    )
    .orderBy(channelProactiveMessages.scheduledAt)
    .all();
}

export function updateProactiveMessageStatus(
  publicId: string,
  status: ProactiveMessageStatus,
): void {
  const db = getDb();
  db
    .update(channelProactiveMessages)
    .set({
      status,
      updatedAt: Date.now(),
    })
    .where(eq(channelProactiveMessages.publicId, publicId))
    .run();
}

export function updateProactiveMessageContent(
  publicId: string,
  content: string,
): void {
  const db = getDb();
  db
    .update(channelProactiveMessages)
    .set({
      content,
      updatedAt: Date.now(),
    })
    .where(eq(channelProactiveMessages.publicId, publicId))
    .run();
}

export function cancelProactiveMessages(publicIds: string[]): void {
  if (!publicIds.length) {
    return;
  }
  const db = getDb();
  db
    .update(channelProactiveMessages)
    .set({
      status: "cancelled",
      updatedAt: Date.now(),
    })
    .where(inArray(channelProactiveMessages.publicId, publicIds))
    .run();
}

export function rescheduleProactiveMessage(
  publicId: string,
  scheduledAt: number,
  content?: string,
  reason?: string | null,
): void {
  const db = getDb();
  const updatePayload: Record<string, unknown> = {
    scheduledAt,
    updatedAt: Date.now(),
  };

  if (typeof content === "string") {
    updatePayload.content = content;
  }
  if (typeof reason === "string") {
    updatePayload.reason = reason;
  } else if (reason === null) {
    updatePayload.reason = null;
  }

  db
    .update(channelProactiveMessages)
    .set(updatePayload)
    .where(eq(channelProactiveMessages.publicId, publicId))
    .run();
}
