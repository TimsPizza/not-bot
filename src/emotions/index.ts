import {
  getChannelEmotion,
  listTopChannelEmotions,
  upsertChannelEmotion,
} from "@/db/datastore";
import loggerService from "@/logger";
import {
  EmotionDeltaSuggestion,
  EmotionMetric,
  EmotionSnapshot,
  EmotionState,
  EmotionThresholdMap,
  PersonaDefinition,
} from "@/types";
import QuickLRU from "quick-lru";

const EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

const MAX_VALUE = 100;
const MIN_VALUE = -100;
const DEFAULT_DELTA_CAP = 8;
const DECAY_PER_HOUR = 5; // Units toward zero per hour of inactivity
const CACHE_SIZE = 2000;

interface ApplyDeltaOptions {
  suggestions: EmotionDeltaSuggestion[];
  persona?: PersonaDefinition | null;
  source?: string;
  timestamp?: number;
}

class EmotionService {
  private static instance: EmotionService;

  private cache = new QuickLRU<string, EmotionState>({ maxSize: CACHE_SIZE });

  public static getInstance(): EmotionService {
    if (!EmotionService.instance) {
      EmotionService.instance = new EmotionService();
    }
    return EmotionService.instance;
  }

  public getState(channelId: string, userId: string): EmotionState {
    const key = this.getCacheKey(channelId, userId);
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, metrics: { ...cached.metrics } };
    }

    const record = getChannelEmotion(channelId, userId);
    if (!record) {
      const state = this.createDefaultState(channelId, userId);
      this.cache.set(key, state);
      return { ...state, metrics: { ...state.metrics } };
    }

    const state: EmotionState = {
      channelId,
      userId,
      metrics: {
        affinity: this.clamp(record.affinity),
        annoyance: this.clamp(record.annoyance),
        trust: this.clamp(record.trust),
        curiosity: this.clamp(record.curiosity),
      },
      lastInteractionAt: record.lastInteractionAt,
      lastDecayAt: record.lastDecayAt,
      evidence:
        record.evidence && typeof record.evidence === "object"
          ? (record.evidence as Record<string, unknown>)
          : {},
    };

    this.cache.set(key, state);
    return { ...state, metrics: { ...state.metrics } };
  }

  public recordInteraction(
    channelId: string,
    userId: string,
    timestamp: number,
  ): EmotionState {
    const state = this.getState(channelId, userId);
    const now = timestamp || Date.now();
    this.applyDecay(state, now);
    state.lastInteractionAt = now;
    this.persist(state);
    return state;
  }

  public applyModelSuggestions(
    channelId: string,
    userId: string,
    options: ApplyDeltaOptions,
  ): EmotionState {
    const state = this.getState(channelId, userId);
    const now = options.timestamp ?? Date.now();

    this.applyDecay(state, now);

    const personaThresholds = options.persona?.emotionThresholds ?? null;
    const deltaCaps = options.persona?.emotionDeltaCaps ?? {};

    for (const suggestion of options.suggestions) {
      if (!EMOTION_METRICS.includes(suggestion.metric)) {
        loggerService.logger.warn(
          { metric: suggestion.metric },
          "Received emotion delta suggestion for unsupported metric.",
        );
        continue;
      }
      const cap = deltaCaps[suggestion.metric] ?? DEFAULT_DELTA_CAP;
      const delta = this.clampDelta(suggestion.delta, cap);
      if (delta === 0) {
        continue;
      }
      const previous = state.metrics[suggestion.metric];
      const next = this.clamp(previous + delta);
      state.metrics[suggestion.metric] = next;
      this.appendEvidence(state, suggestion.metric, previous, next, options.source);
    }

    state.lastInteractionAt = now;
    state.lastDecayAt = now;
    this.persist(state);

    // Re-cache
    const key = this.getCacheKey(channelId, userId);
    this.cache.set(key, { ...state, metrics: { ...state.metrics } });

    if (personaThresholds) {
      this.logThresholdCrossings(userId, state, personaThresholds);
    }

    return { ...state, metrics: { ...state.metrics } };
  }

  public getSnapshots(
    channelId: string,
    persona: PersonaDefinition | null,
    userIds: string[],
    limit = 5,
  ): EmotionSnapshot[] {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    const thresholdMap = persona?.emotionThresholds ?? null;

    const snapshots: EmotionSnapshot[] = uniqueUserIds.map((userId) => ({
      targetUserId: userId,
      state: this.getState(channelId, userId),
      personaThresholds: thresholdMap,
    }));

    if (snapshots.length >= limit) {
      return snapshots.slice(0, limit);
    }

    const remaining = limit - snapshots.length;
    const topFromDb = listTopChannelEmotions(channelId, remaining + 5);
    for (const record of topFromDb) {
      if (uniqueUserIds.includes(record.userId)) {
        continue;
      }
      snapshots.push({
        targetUserId: record.userId,
        state: this.getState(channelId, record.userId),
        personaThresholds: thresholdMap,
      });
      if (snapshots.length >= limit) {
        break;
      }
    }

    return snapshots;
  }

  private applyDecay(state: EmotionState, timestamp: number): void {
    const elapsedMs = Math.max(0, timestamp - (state.lastDecayAt || timestamp));
    if (elapsedMs < 60_000) {
      return;
    }
    const hours = elapsedMs / 3_600_000;
    const decayAmount = Math.floor(hours * DECAY_PER_HOUR);
    if (decayAmount <= 0) {
      return;
    }

    let changed = false;
    for (const metric of EMOTION_METRICS) {
      const value = state.metrics[metric];
      if (value === 0) {
        continue;
      }
      const sign = value > 0 ? 1 : -1;
      const reduced = value - sign * Math.min(decayAmount, Math.abs(value));
      if (reduced !== value) {
        state.metrics[metric] = reduced;
        changed = true;
      }
    }

    if (changed) {
      state.lastDecayAt = timestamp;
    }
  }

  private appendEvidence(
    state: EmotionState,
    metric: EmotionMetric,
    previous: number,
    next: number,
    source?: string,
  ): void {
    const evidence = state.evidence as {
      history?: Array<{
        metric: EmotionMetric;
        previous: number;
        next: number;
        source?: string;
        at: number;
      }>;
    };
    if (!evidence.history) {
      evidence.history = [];
    }
    evidence.history.push({
      metric,
      previous,
      next,
      source,
      at: Date.now(),
    });
    // Keep latest 20 entries max
    if (evidence.history.length > 20) {
      evidence.history.splice(0, evidence.history.length - 20);
    }
    state.evidence = evidence;
  }

  private logThresholdCrossings(
    userId: string,
    state: EmotionState,
    thresholds: EmotionThresholdMap,
  ): void {
    for (const metric of EMOTION_METRICS) {
      const value = state.metrics[metric];
      const lines = thresholds?.[metric];
      if (!lines || !lines.length) {
        continue;
      }
      const bucket = this.resolveBucket(value, lines);
      loggerService.logger.debug(
        {
          userId,
          metric,
          value,
          bucket,
        },
        "Emotion metric updated.",
      );
    }
  }

  private resolveBucket(value: number, thresholds: number[]): number {
    const sorted = [...thresholds].sort((a, b) => a - b);
    let bucket = sorted.length;
    for (let i = 0; i < sorted.length; i += 1) {
      if (value < sorted[i]!) {
        bucket = i;
        break;
      }
    }
    return bucket;
  }

  private persist(state: EmotionState): void {
    upsertChannelEmotion({
      channelId: state.channelId,
      userId: state.userId,
      affinity: state.metrics.affinity,
      annoyance: state.metrics.annoyance,
      trust: state.metrics.trust,
      curiosity: state.metrics.curiosity,
      lastInteractionAt: state.lastInteractionAt,
      lastDecayAt: state.lastDecayAt,
      evidence: state.evidence,
      updatedAt: Date.now(),
    });
  }

  private createDefaultState(channelId: string, userId: string): EmotionState {
    return {
      channelId,
      userId,
      metrics: {
        affinity: 0,
        annoyance: 0,
        trust: 0,
        curiosity: 0,
      },
      lastInteractionAt: Date.now(),
      lastDecayAt: Date.now(),
      evidence: {} as Record<string, unknown>,
    };
  }

  private clamp(value: number): number {
    return Math.max(MIN_VALUE, Math.min(MAX_VALUE, Math.round(value)));
  }

  private clampDelta(delta: number, cap: number): number {
    const bounded = Math.max(-cap, Math.min(cap, delta));
    if (Number.isNaN(bounded) || !Number.isFinite(bounded)) {
      return 0;
    }
    return Math.round(bounded);
  }

  private getCacheKey(channelId: string, userId: string): string {
    return `${channelId}:${userId}`;
  }
}

const emotionService = EmotionService.getInstance();
export default emotionService;
export { EmotionService };
