import {
  cancelProactiveMessages,
  createProactiveMessage,
  getProactiveMessageByPublicId,
  listDueProactiveMessages,
  listPendingProactiveMessages,
  rescheduleProactiveMessage,
  updateProactiveMessageContent,
  updateProactiveMessageStatus,
} from "@/db/datastore";
import type { ChannelProactiveMessageRow } from "@/db/schema";
import type { ProactiveMessageStatus } from "@/types";

const MAX_PENDING_PER_CHANNEL = 2;

export interface ScheduleProactiveMessageInput {
  channelId: string;
  personaId: string;
  content: string;
  scheduledAt: number;
  reason?: string;
  metadata?: unknown;
}

export interface ProactiveSummary {
  id: string;
  scheduledAt: number;
  contentPreview: string;
  status: ProactiveMessageStatus;
  reason?: string | null;
}

export interface DueProactiveMessage {
  record: ChannelProactiveMessageRow;
}

function enforcePendingLimit(channelId: string): void {
  const pending = listPendingProactiveMessages(channelId);
  if (pending.length >= MAX_PENDING_PER_CHANNEL) {
    throw new Error(
      `Channel ${channelId} already has ${pending.length} scheduled proactive messages`,
    );
  }
}

function summariseContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 77)}...`;
}

export function scheduleProactiveMessage(
  input: ScheduleProactiveMessageInput,
): ChannelProactiveMessageRow {
  enforcePendingLimit(input.channelId);
  if (!Number.isFinite(input.scheduledAt)) {
    throw new Error("scheduledAt must be a valid timestamp");
  }
  return createProactiveMessage(input);
}

export function cancelScheduledMessages(publicIds: string[]): void {
  if (!publicIds.length) return;
  cancelProactiveMessages(publicIds.map((id) => id.toLowerCase()));
}

export function markProactiveMessageStatus(
  publicId: string,
  status: ProactiveMessageStatus,
): void {
  updateProactiveMessageStatus(publicId.toLowerCase(), status);
}

export function rescheduleExistingProactiveMessage(
  publicId: string,
  scheduledAt: number,
  content?: string,
  reason?: string | null,
): void {
  rescheduleProactiveMessage(
    publicId.toLowerCase(),
    scheduledAt,
    content,
    reason ?? null,
  );
}

export function updateProactiveMessageContentText(
  publicId: string,
  content: string,
): void {
  updateProactiveMessageContent(publicId.toLowerCase(), content);
}

export function getPendingSummaries(channelId: string): ProactiveSummary[] {
  const pending = listPendingProactiveMessages(channelId);
  return pending.map((record) => ({
    id: record.publicId,
    scheduledAt: record.scheduledAt,
    contentPreview: summariseContent(record.content),
    status: record.status as ProactiveMessageStatus,
    reason: record.reason,
  }));
}

export function getDueProactiveMessages(now: number): DueProactiveMessage[] {
  return listDueProactiveMessages(now).map((record) => ({ record }));
}

export function findProactiveMessage(
  publicId: string,
): ChannelProactiveMessageRow | null {
  return (
    getProactiveMessageByPublicId(publicId.toLowerCase()) ?? null
  );
}
