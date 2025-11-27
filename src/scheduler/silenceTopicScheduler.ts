import configService from "@/config";
import contextManagerService from "@/context";
import emotionService from "@/emotions";
import topicStarterService from "@/llm/topic_starter";
import loggerService from "@/logger";
import { SimpleMessage, StructuredResponseSegment } from "@/types";

type DispatchFn = (
  channelId: string,
  segments: StructuredResponseSegment[],
) => Promise<void>;

interface BackoffState {
  nextAllowedAt: number;
  cooldownMs: number;
}

const CHECK_INTERVAL_MS = 120_000; // 2min
const MIN_SILENCE_MS = 30 * 60 * 1000; // 30min
const MIN_BETWEEN_BOT_MS = 30 * 60 * 1000; // 30min
const BASE_COOLDOWN_MS = 1.5 * 60 * 60 * 1000; // 1.5hr
const BACKOFF_MULTIPLIER = 1.6;
const MAX_BACKOFF_MS = 12 * 60 * 60 * 1000;
const JITTER_MS = 10 * 60 * 1000;
const MAX_CONTEXT_MESSAGES = 100;

let singletonInstance: SilenceTopicScheduler | null = null;

export class SilenceTopicScheduler {
  private timer: NodeJS.Timeout | null = null;
  private backoff: Map<string, BackoffState> = new Map();
  private botId: string | null = null;

  constructor(private readonly dispatch: DispatchFn) {}

  public start(botId: string): void {
    this.botId = botId;
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        loggerService.logger.error(
          { err },
          "SilenceTopicScheduler tick failed.",
        );
      });
    }, CHECK_INTERVAL_MS);
    loggerService.logger.info("SilenceTopicScheduler started.");
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      loggerService.logger.info("SilenceTopicScheduler stopped.");
    }
  }

  public getNextAllowedInSeconds(channelId: string): number | null {
    const state = this.backoff.get(channelId);
    if (!state) {
      return null;
    }
    const delta = state.nextAllowedAt - Date.now();
    return delta > 0 ? Math.ceil(delta / 1000) : 0;
  }

  private async tick(): Promise<void> {
    if (!this.botId) {
      return;
    }

    const contexts = contextManagerService.getCachedContexts();
    if (!contexts.length) {
      return;
    }

    const now = Date.now();
    for (const context of contexts) {
      const lastHumanAt = this.getLastHumanTimestamp(context.messages);
      if (!lastHumanAt) {
        continue;
      }
      const silenceMs = now - lastHumanAt;
      if (silenceMs < MIN_SILENCE_MS) {
        continue;
      }

      const lastBotAt = this.getLastBotTimestamp(context.messages);
      if (lastBotAt && now - lastBotAt < MIN_BETWEEN_BOT_MS) {
        continue;
      }

      const state = this.backoff.get(context.channelId) ?? {
        nextAllowedAt: 0,
        cooldownMs: BASE_COOLDOWN_MS,
      };
      if (now < state.nextAllowedAt) {
        continue;
      }

      const jitterGate = MIN_SILENCE_MS + Math.random() * JITTER_MS;
      if (silenceMs < jitterGate) {
        continue;
      }

      await this.triggerTopic(context, state).catch((err) => {
        loggerService.logger.warn(
          { err, channelId: context.channelId },
          "SilenceTopicScheduler trigger failed.",
        );
      });
    }
  }

  private async triggerTopic(
    context: { channelId: string; serverId: string; messages: SimpleMessage[] },
    state: BackoffState,
  ): Promise<void> {
    if (!this.botId) {
      return;
    }
    const serverConfig =
      context.serverId && context.serverId !== "DM"
        ? configService.getServerConfig(context.serverId)
        : null;
    const personaDefinition =
      (serverConfig
        ? configService.getPersonaDefinitionForContext(
            serverConfig.serverId,
            context.channelId,
          )
        : undefined) ?? configService.getPresetPersona("default");

    const personaPrompts = configService.getPersonaPrompts();
    if (!personaDefinition || !personaPrompts?.systemPrompt) {
      loggerService.logger.warn(
        { channelId: context.channelId },
        "SilenceTopicScheduler missing persona/system prompt; skipping.",
      );
      this.bumpBackoff(context.channelId, state, false);
      return;
    }

    const languageSource =
      serverConfig?.languageConfig ??
      (configService.getConfig().language
        ? {
            primary: configService.getConfig().language!.defaultPrimary,
            fallback: configService.getConfig().language!.defaultFallback,
            autoDetect: configService.getConfig().language!.autoDetectEnabled,
          }
        : undefined);

    const languageConfig = languageSource
      ? {
          primary: languageSource.primary,
          fallback: languageSource.fallback,
          autoDetect: languageSource.autoDetect,
        }
      : undefined;

    const recentMessages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
    const candidateUserIds = this.collectCandidateUserIds(recentMessages);
    const emotionSnapshots = emotionService.getSnapshots(
      context.channelId,
      personaDefinition,
      candidateUserIds,
      5,
    );

    const topicPrompt = this.buildTopicSystemPrompt(
      personaPrompts.systemPrompt,
    );

    const result = await topicStarterService.generateTopicStarter(
      context.channelId,
      topicPrompt,
      personaDefinition.details,
      this.botId,
      languageConfig,
      {
        snapshots: emotionSnapshots,
        deltaCaps: personaDefinition.emotionDeltaCaps,
        pendingProactiveMessages: [],
      },
    );

    if (!result || !result.messages?.length) {
      this.bumpBackoff(context.channelId, state, false);
      return;
    }

    await this.dispatch(context.channelId, result.messages);
    this.resetBackoff(context.channelId, state);
  }

  private collectCandidateUserIds(messages: SimpleMessage[]): string[] {
    const ids = messages
      .filter((m) => !m.isBot)
      .map((m) => m.authorId)
      .filter(Boolean);
    return Array.from(new Set(ids));
  }

  private buildTopicSystemPrompt(base: string): string {
    return [
      base,
      "You are proactively starting a conversation after a quiet period. Goals:",
      "- Find a friendly, low-awkwardness topic based on recent channel history.",
      "- You may @ a preferred user if the emotion context suggests positive affinity or curiosity toward them.",
      "- Avoid promising to execute tasks; focus on opening a light dialogue (questions, observations, quick tips).",
      "- Keep it short and engaging; avoid spammy multiple messages unless necessary for clarity.",
    ].join("\n\n");
  }

  private getLastHumanTimestamp(messages: SimpleMessage[]): number | null {
    const humanMessages = messages.filter((m) => !m.isBot);
    if (!humanMessages.length) {
      return null;
    }
    return humanMessages[humanMessages.length - 1]!.timestamp;
  }

  private getLastBotTimestamp(messages: SimpleMessage[]): number | null {
    const botMessages = messages.filter((m) => m.isBot);
    if (!botMessages.length) {
      return null;
    }
    return botMessages[botMessages.length - 1]!.timestamp;
  }

  private bumpBackoff(
    channelId: string,
    state: BackoffState,
    wasSuccess: boolean,
  ): void {
    const now = Date.now();
    const cooldown = wasSuccess
      ? BASE_COOLDOWN_MS
      : Math.min(state.cooldownMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    this.backoff.set(channelId, {
      cooldownMs: cooldown,
      nextAllowedAt: now + cooldown,
    });
  }

  private resetBackoff(channelId: string, state: BackoffState): void {
    this.backoff.set(channelId, {
      cooldownMs: BASE_COOLDOWN_MS,
      nextAllowedAt: Date.now() + BASE_COOLDOWN_MS,
    });
  }
}
export function setSilenceScheduler(instance: SilenceTopicScheduler): void {
  singletonInstance = instance;
}

export function getSilenceScheduler(): SilenceTopicScheduler | null {
  return singletonInstance;
}

export default SilenceTopicScheduler;
