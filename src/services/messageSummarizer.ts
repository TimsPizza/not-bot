import { PromptBuilder } from "@/prompt";
import { Message, TextChannel, User } from "discord.js";
import { ConfigService } from "../config";
import { callChatCompletionApi } from "../llm/openai_client";
import loggerService from "../logger";
import {
  MessageBatch,
  SimpleMessage,
  SummaryConfig,
  SummaryRequest,
  SummaryResult,
  SupportedLanguage,
} from "../types";

export class MessageSummarizer {
  private static instance: MessageSummarizer;
  private configService: ConfigService;
  private activeSummaries: Map<string, SummaryRequest> = new Map();
  private cooldowns: Map<string, number> = new Map();

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): MessageSummarizer {
    if (!MessageSummarizer.instance) {
      MessageSummarizer.instance = new MessageSummarizer();
    }
    return MessageSummarizer.instance;
  }

  /**
   * 执行消息总结的主要方法
   */
  async summarizeMessages(
    channel: TextChannel,
    targetMessageId: string,
    config: SummaryConfig,
    requestUser: User,
  ): Promise<SummaryResult> {
    // 验证请求
    await this.validateSummaryRequest(channel, requestUser, config);

    // 获取目标消息
    const targetMessage = await this.fetchTargetMessage(
      channel,
      targetMessageId,
    );

    // 创建总结请求记录
    const summaryRequest: SummaryRequest = {
      targetMessage: this.convertToSimpleMessage(targetMessage),
      config,
      requestUser: {
        id: requestUser.id,
        username: requestUser.username,
        displayName: requestUser.displayName || requestUser.username,
      },
      timestamp: new Date(),
    };

    const requestId = `${channel.id}_${targetMessageId}_${Date.now()}`;
    this.activeSummaries.set(requestId, summaryRequest);

    try {
      // 获取消息批次
      const messageBatch = await this.fetchMessageBatch(
        channel,
        targetMessage,
        config,
      );

      // 检查语言配置
      const languageConfig = await this.getLanguageConfigForGuild(
        channel.guildId!,
      );

      // 格式化消息内容
      const formattedMessages = this.formatMessagesForSummary(
        messageBatch.messages,
      );

      // 生成总结
      const summary = await this.generateSummary(
        formattedMessages,
        config,
        languageConfig,
        messageBatch,
      );

      // 创建结果
      const sortedMessages = messageBatch.messages.sort(
        (a, b) => a.timestamp - b.timestamp,
      );

      if (sortedMessages.length === 0) {
        throw new Error("No valid messages found");
      }

      const startMessage = sortedMessages[0]!; // 类型断言：已检查数组长度
      const endMessage = sortedMessages[sortedMessages.length - 1]!; // 类型断言：已检查数组长度

      const result: SummaryResult = {
        summary,
        messageCount: messageBatch.messages.length,
        direction: this.getDirectionDisplayName(config.direction),
        messageRange: {
          startMessage: {
            id: startMessage.id,
            url: this.buildMessageUrl(startMessage),
            timestamp: new Date(startMessage.timestamp),
          },
          endMessage: {
            id: endMessage.id,
            url: this.buildMessageUrl(endMessage),
            timestamp: new Date(endMessage.timestamp),
          },
        },
        requestId,
      };

      // 设置冷却时间
      this.setCooldown(requestUser.id);

      return result;
    } finally {
      // 清理活跃总结记录
      this.activeSummaries.delete(requestId);
    }
  }

  /**
   * 验证总结请求的合法性
   */
  private async validateSummaryRequest(
    channel: TextChannel,
    user: User,
    config: SummaryConfig,
  ): Promise<void> {
    const globalConfig = this.configService.getConfig();
    const serverConfig = this.configService.getServerConfig(channel.guildId!);

    // 检查功能是否启用
    if (!globalConfig.summary?.enabled) {
      throw new Error("总结功能已被全局禁用");
    }

    if (
      serverConfig?.summarySettings &&
      !serverConfig.summarySettings.enabled
    ) {
      throw new Error("总结功能在此服务器被禁用");
    }

    // 检查频道权限
    if (serverConfig?.summarySettings?.bannedChannels?.includes(channel.id)) {
      throw new Error("此频道禁止使用总结功能");
    }

    // 检查用户权限
    if (
      serverConfig?.summarySettings?.allowedRoles &&
      serverConfig.summarySettings.allowedRoles.length > 0
    ) {
      const member = await channel.guild.members.fetch(user.id);
      const hasPermission = serverConfig.summarySettings.allowedRoles.some(
        (roleId) => member.roles.cache.has(roleId),
      );
      if (!hasPermission) {
        throw new Error(
          "You do not have permission to use the summary feature",
        );
      }
    }

    // 检查冷却时间
    const cooldownRemaining = this.getCooldownRemaining(user.id);
    if (cooldownRemaining > 0) {
      throw new Error(
        `Please wait ${cooldownRemaining} seconds before using the summary feature again`,
      );
    }

    // 检查并发限制
    const maxConcurrent = globalConfig.summary?.maxConcurrentSummaries || 5;
    if (this.activeSummaries.size >= maxConcurrent) {
      throw new Error("System is busy, please try again later");
    }

    // 验证消息数量
    const minMessages = globalConfig.summary?.minMessages || 3;
    const maxMessages =
      serverConfig?.summarySettings?.maxMessagesPerSummary ||
      globalConfig.summary?.maxMessages ||
      200;

    if (config.count < minMessages || config.count > maxMessages) {
      throw new Error(
        `The message count must be between ${minMessages}-${maxMessages}`,
      );
    }
  }

  /**
   * 获取目标消息
   */
  private async fetchTargetMessage(
    channel: TextChannel,
    messageId: string,
  ): Promise<Message> {
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      loggerService.logger.error(
        { err: error, messageId, guildId: channel.guildId },
        "Failed to fetch target message",
      );
      throw new Error("The specified message was not found, possibly deleted");
    }
  }

  /**
   * 根据配置获取消息批次
   */
  private async fetchMessageBatch(
    channel: TextChannel,
    targetMessage: Message,
    config: SummaryConfig,
  ): Promise<MessageBatch> {
    let messages: Message[];

    switch (config.direction) {
      case "forward":
        messages = await this.fetchForwardMessages(
          channel,
          targetMessage,
          config.count,
        );
        break;
      case "backward":
        messages = await this.fetchBackwardMessages(
          channel,
          targetMessage,
          config.count,
        );
        break;
      case "around":
        messages = await this.fetchAroundMessages(
          channel,
          targetMessage,
          config.count,
        );
        break;
      default:
        throw new Error("Invalid summary direction");
    }

    // 过滤和排序消息
    const filteredMessages = this.filterMessages(messages);
    const simpleMessages = filteredMessages.map((m) =>
      this.convertToSimpleMessage(m),
    );

    return {
      messages: simpleMessages,
      direction: config.direction,
      anchorMessage: this.convertToSimpleMessage(targetMessage),
      totalCount: simpleMessages.length,
    };
  }

  /**
   * 获取向前的消息
   */
  private async fetchForwardMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number,
  ): Promise<Message[]> {
    const messages = await channel.messages.fetch({
      after: targetMessage.id,
      limit: count,
    });
    return Array.from(messages.values()).reverse(); // 按时间正序
  }

  /**
   * 获取向后的消息
   */
  private async fetchBackwardMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number,
  ): Promise<Message[]> {
    const messages = await channel.messages.fetch({
      before: targetMessage.id,
      limit: count,
    });
    return Array.from(messages.values()); // 已经是时间倒序，保持这个顺序
  }

  /**
   * 获取围绕目标消息的消息
   */
  private async fetchAroundMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number,
  ): Promise<Message[]> {
    const halfCount = Math.floor(count / 2);
    const remainingCount = count - halfCount;

    // 获取前半部分
    const beforeMessages = await channel.messages.fetch({
      before: targetMessage.id,
      limit: halfCount,
    });

    // 获取后半部分
    const afterMessages = await channel.messages.fetch({
      after: targetMessage.id,
      limit: remainingCount,
    });

    // 合并并按时间排序
    const allMessages = [
      ...Array.from(beforeMessages.values()).reverse(),
      targetMessage,
      ...Array.from(afterMessages.values()).reverse(),
    ];

    return allMessages;
  }

  /**
   * 过滤无效的消息
   */
  private filterMessages(messages: Message[]): Message[] {
    return messages.filter((message) => {
      // 过滤系统消息
      if (message.system) return false;

      // 过滤空消息
      if (
        !message.content &&
        message.attachments.size === 0 &&
        message.embeds.length === 0
      ) {
        return false;
      }

      // 过滤过短的消息（只有表情符号等）
      if (message.content && message.content.trim().length < 2) {
        return false;
      }

      return true;
    });
  }

  /**
   * 转换为SimpleMessage格式
   */
  private convertToSimpleMessage(message: Message): SimpleMessage {
    return {
      id: message.id,
      content: message.content,
      channelId: message.channelId,
      guildId: message.guildId || null,
      authorId: message.author.id,
      authorUsername: message.author.username,
      timestamp: message.createdTimestamp,
      mentionedUsers: message.mentions.users.map((user) => user.id),
      mentionedRoles: message.mentions.roles.map((role) => role.id),
      mentionsEveryone: message.mentions.everyone,
      isBot: message.author.bot,
      reference: message.reference
        ? {
            messageId: message.reference.messageId || null,
            channelId: message.reference.channelId || null,
            guildId: message.reference.guildId || null,
          }
        : undefined,
      hasAttachments: message.attachments.size > 0,
      hasEmbeds: message.embeds.length > 0,
      hasBeenRepliedTo: false, // 总结功能不需要这个字段
    };
  }

  /**
   * 格式化消息用于LLM处理
   */
  private formatMessagesForSummary(messages: SimpleMessage[]): string {
    return messages
      .map((message) => {
        const timestamp = new Date(message.timestamp).toLocaleString("zh-CN");
        // 使用用户名而不是用户ID，为了可读性
        let content = `[${timestamp}] ${message.authorUsername}: ${message.content}`;

        if (message.hasAttachments) {
          content += " [Contains attachments]";
        }

        if (message.hasEmbeds) {
          content += " [Contains embedded content]";
        }

        return content;
      })
      .join("\n");
  }

  /**
   * 使用LLM生成总结
   */
  private async generateSummary(
    formattedMessages: string,
    config: SummaryConfig,
    languageConfig: any,
    messageBatch: MessageBatch,
  ): Promise<string> {
    const personaPrompts = this.configService.getPersonaPrompts();
    const summaryPromptTemplate =
      personaPrompts?.summary_prompts?.basic_summary ?? null;

    let targetLanguageName = "根据聊天内容自动选择最合适的语言";
    const primaryLanguageCode: string =
      languageConfig?.primary ?? SupportedLanguage.Auto;
    if (
      languageConfig?.primary &&
      languageConfig.primary !== SupportedLanguage.Auto
    ) {
      targetLanguageName = this.getLanguageDisplayName(languageConfig.primary);
    }

    const userMappingText = this.buildUserMappingText(messageBatch);
    const timeRange = this.formatTimeRange(messageBatch);

    const prompt = PromptBuilder.build({
      useCase: "summary",
      summaryPromptTemplate,
      personaPrompts,
      summaryConfig: config,
      formattedMessages,
      userMappingText,
      messageBatch,
      targetLanguageName,
      primaryLanguageCode,
      timeRange,
    });

    try {
      const globalConfig = this.configService.getConfig();
      const response = await callChatCompletionApi(
        "main",
        globalConfig.primaryLlmModel,
        prompt.messages,
        prompt.temperature,
        prompt.maxTokens,
      );

      if (!response) {
        throw new Error("LLM returned empty response");
      }

      return response.trim();
    } catch (error) {
      loggerService.logger.error({ err: error }, "Failed to generate summary");
      throw new Error("Error generating summary, please try again later");
    }
  }

  private buildUserMappingText(messageBatch: MessageBatch): string {
    const userMap = new Map<string, string>();
    messageBatch.messages.forEach((message) => {
      userMap.set(message.authorUsername, `<@${message.authorId}>`);
    });

    const result = Array.from(userMap.entries())
      .map(([username, mention]) => `${username} -> ${mention}`)
      .join("\n");

    return result;
  }

  /**
   * 获取服务器的语言配置
   */
  private async getLanguageConfigForGuild(guildId: string): Promise<any> {
    const serverConfig = this.configService.getServerConfig(guildId);
    return (
      serverConfig?.languageConfig || this.configService.getConfig().language
    );
  }

  /**
   * 格式化时间范围
   */
  private formatTimeRange(messageBatch: MessageBatch): string {
    const start = new Date(
      Math.min(...messageBatch.messages.map((m) => m.timestamp)),
    );
    const end = new Date(
      Math.max(...messageBatch.messages.map((m) => m.timestamp)),
    );

    return `${start.toLocaleString("zh-CN")} 至 ${end.toLocaleString("zh-CN")}`;
  }

  /**
   * 获取方向显示名称
   */
  private getDirectionDisplayName(direction: string): string {
    const names = {
      forward: "📈 Later",
      backward: "📉 Earlier",
      around: "🎯 Around",
    };
    return names[direction as keyof typeof names] || direction;
  }

  /**
   * 获取语言显示名称
   */
  private getLanguageDisplayName(languageCode: string): string {
    const config = this.configService.getConfig();
    const supportedLanguages = config.language?.supportedLanguages || [];
    const language = supportedLanguages.find(
      (lang) => lang.code === languageCode,
    );
    return language?.name || languageCode;
  }

  /**
   * 设置用户冷却时间
   */
  private setCooldown(userId: string): void {
    const config = this.configService.getConfig();
    const cooldownSeconds = config.summary?.cooldownSeconds || 30;
    this.cooldowns.set(userId, Date.now() + cooldownSeconds * 1000);
  }

  /**
   * 获取剩余冷却时间
   */
  private getCooldownRemaining(userId: string): number {
    const cooldownEnd = this.cooldowns.get(userId);
    if (!cooldownEnd) return 0;

    const remaining = Math.max(0, cooldownEnd - Date.now());
    if (remaining === 0) {
      this.cooldowns.delete(userId);
    }

    return Math.ceil(remaining / 1000);
  }

  /**
   * 构建Discord消息链接
   */
  private buildMessageUrl(message: SimpleMessage): string {
    // Discord消息链接格式: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
    const guildId = message.guildId || "@me"; // DM频道使用 @me
    return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
  }

  /**
   * 清理过期的冷却时间记录
   */
  public cleanupCooldowns(): void {
    const now = Date.now();
    for (const [userId, cooldownEnd] of this.cooldowns.entries()) {
      if (cooldownEnd <= now) {
        this.cooldowns.delete(userId);
      }
    }
  }
}
