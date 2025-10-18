import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../client";
import { channelEmotions } from "../schema";

export interface ChannelEmotionRecord {
  channelId: string;
  userId: string;
  affinity: number;
  annoyance: number;
  trust: number;
  curiosity: number;
  lastInteractionAt: number;
  lastDecayAt: number;
  evidence: unknown;
  updatedAt: number;
}

function rowToRecord(
  row: typeof channelEmotions.$inferSelect,
): ChannelEmotionRecord {
  return {
    channelId: row.channelId,
    userId: row.userId,
    affinity: row.affinity ?? 0,
    annoyance: row.annoyance ?? 0,
    trust: row.trust ?? 0,
    curiosity: row.curiosity ?? 0,
    lastInteractionAt: row.lastInteractionAt ?? Date.now(),
    lastDecayAt: row.lastDecayAt ?? Date.now(),
    evidence: row.evidence ? safeParse(row.evidence) : null,
    updatedAt: row.updatedAt ?? Date.now(),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getChannelEmotion(
  channelId: string,
  userId: string,
): ChannelEmotionRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(channelEmotions)
    .where(
      and(eq(channelEmotions.channelId, channelId), eq(channelEmotions.userId, userId)),
    )
    .get();

  return row ? rowToRecord(row) : null;
}

export function upsertChannelEmotion(
  record: ChannelEmotionRecord,
): void {
  const db = getDb();
  const timestamp = Date.now();

  db
    .insert(channelEmotions)
    .values({
      channelId: record.channelId,
      userId: record.userId,
      affinity: record.affinity,
      annoyance: record.annoyance,
      trust: record.trust,
      curiosity: record.curiosity,
      lastInteractionAt: record.lastInteractionAt,
      lastDecayAt: record.lastDecayAt,
      evidence: record.evidence ? JSON.stringify(record.evidence) : null,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [channelEmotions.channelId, channelEmotions.userId],
      set: {
        affinity: record.affinity,
        annoyance: record.annoyance,
        trust: record.trust,
        curiosity: record.curiosity,
        lastInteractionAt: record.lastInteractionAt,
        lastDecayAt: record.lastDecayAt,
        evidence: record.evidence ? JSON.stringify(record.evidence) : null,
        updatedAt: timestamp,
      },
    })
    .run();
}

export function listTopChannelEmotions(
  channelId: string,
  limit = 10,
): ChannelEmotionRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(channelEmotions)
    .where(eq(channelEmotions.channelId, channelId))
    .orderBy(desc(channelEmotions.lastInteractionAt))
    .limit(limit)
    .all();

  return rows.map(rowToRecord);
}
