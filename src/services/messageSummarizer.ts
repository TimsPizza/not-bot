import { 
  TextChannel, 
  Message, 
  Collection,
  ChannelType,
  User
} from 'discord.js';
import { 
  SummaryConfig, 
  SummaryRequest, 
  SummaryResult, 
  MessageBatch,
  SimpleMessage,
  SupportedLanguage 
} from '../types';
import { ConfigService } from '../config';
import { callChatCompletionApi } from '../llm/openai_client';
import loggerService from '../logger';

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
    requestUser: User
  ): Promise<SummaryResult> {
    // 验证请求
    await this.validateSummaryRequest(channel, requestUser, config);

    // 获取目标消息
    const targetMessage = await this.fetchTargetMessage(channel, targetMessageId);
    
    // 创建总结请求记录
    const summaryRequest: SummaryRequest = {
      targetMessage: this.convertToSimpleMessage(targetMessage),
      config,
      requestUser: {
        id: requestUser.id,
        username: requestUser.username,
        displayName: requestUser.displayName || requestUser.username
      },
      timestamp: new Date()
    };

    const requestId = `${channel.id}_${targetMessageId}_${Date.now()}`;
    this.activeSummaries.set(requestId, summaryRequest);

    try {
      // 获取消息批次
      const messageBatch = await this.fetchMessageBatch(channel, targetMessage, config);
      
      // 检查语言配置
      const languageConfig = await this.getLanguageConfigForGuild(channel.guildId!);
      
      // 格式化消息内容
      const formattedMessages = this.formatMessagesForSummary(messageBatch.messages);
      
      // 生成总结
      const summary = await this.generateSummary(
        formattedMessages, 
        config, 
        languageConfig,
        messageBatch
      );

      // 创建结果
      const result: SummaryResult = {
        summary,
        messageCount: messageBatch.messages.length,
        direction: this.getDirectionDisplayName(config.direction),
        timeRange: {
          start: new Date(Math.min(...messageBatch.messages.map(m => m.timestamp))),
          end: new Date(Math.max(...messageBatch.messages.map(m => m.timestamp)))
        },
        requestId
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
    config: SummaryConfig
  ): Promise<void> {
    const globalConfig = this.configService.getConfig();
    const serverConfig = this.configService.getServerConfig(channel.guildId!);

    // 检查功能是否启用
    if (!globalConfig.summary?.enabled) {
      throw new Error('总结功能已被全局禁用');
    }

    if (serverConfig?.summarySettings && !serverConfig.summarySettings.enabled) {
      throw new Error('总结功能在此服务器被禁用');
    }

    // 检查频道权限
    if (serverConfig?.summarySettings?.bannedChannels?.includes(channel.id)) {
      throw new Error('此频道禁止使用总结功能');
    }

    // 检查用户权限
    if (serverConfig?.summarySettings?.allowedRoles && serverConfig.summarySettings.allowedRoles.length > 0) {
      const member = await channel.guild.members.fetch(user.id);
      const hasPermission = serverConfig.summarySettings.allowedRoles.some(roleId =>
        member.roles.cache.has(roleId)
      );
      if (!hasPermission) {
        throw new Error('您没有使用总结功能的权限');
      }
    }

    // 检查冷却时间
    const cooldownRemaining = this.getCooldownRemaining(user.id);
    if (cooldownRemaining > 0) {
      throw new Error(`请等待 ${cooldownRemaining} 秒后再次使用总结功能`);
    }

    // 检查并发限制
    const maxConcurrent = globalConfig.summary?.maxConcurrentSummaries || 5;
    if (this.activeSummaries.size >= maxConcurrent) {
      throw new Error('系统繁忙，请稍后再试');
    }

    // 验证消息数量
    const minMessages = globalConfig.summary?.minMessages || 3;
    const maxMessages = serverConfig?.summarySettings?.maxMessagesPerSummary || 
                       globalConfig.summary?.maxMessages || 50;
    
    if (config.count < minMessages || config.count > maxMessages) {
      throw new Error(`消息数量必须在 ${minMessages}-${maxMessages} 之间`);
    }
  }

  /**
   * 获取目标消息
   */
  private async fetchTargetMessage(channel: TextChannel, messageId: string): Promise<Message> {
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      loggerService.logger.error(`Failed to fetch target message ${messageId}:`, error);
      throw new Error('无法找到指定的消息，可能已被删除');
    }
  }

  /**
   * 根据配置获取消息批次
   */
  private async fetchMessageBatch(
    channel: TextChannel,
    targetMessage: Message,
    config: SummaryConfig
  ): Promise<MessageBatch> {
    let messages: Message[];
    
    switch (config.direction) {
      case 'forward':
        messages = await this.fetchForwardMessages(channel, targetMessage, config.count);
        break;
      case 'backward':
        messages = await this.fetchBackwardMessages(channel, targetMessage, config.count);
        break;
      case 'around':
        messages = await this.fetchAroundMessages(channel, targetMessage, config.count);
        break;
      default:
        throw new Error('无效的总结方向');
    }

    // 过滤和排序消息
    const filteredMessages = this.filterMessages(messages);
    const simpleMessages = filteredMessages.map(m => this.convertToSimpleMessage(m));

    return {
      messages: simpleMessages,
      direction: config.direction,
      anchorMessage: this.convertToSimpleMessage(targetMessage),
      totalCount: simpleMessages.length
    };
  }

  /**
   * 获取向前的消息
   */
  private async fetchForwardMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number
  ): Promise<Message[]> {
    const messages = await channel.messages.fetch({
      after: targetMessage.id,
      limit: count
    });
    return Array.from(messages.values()).reverse(); // 按时间正序
  }

  /**
   * 获取向后的消息
   */
  private async fetchBackwardMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number
  ): Promise<Message[]> {
    const messages = await channel.messages.fetch({
      before: targetMessage.id,
      limit: count
    });
    return Array.from(messages.values()); // 已经是时间倒序，保持这个顺序
  }

  /**
   * 获取围绕目标消息的消息
   */
  private async fetchAroundMessages(
    channel: TextChannel,
    targetMessage: Message,
    count: number
  ): Promise<Message[]> {
    const halfCount = Math.floor(count / 2);
    const remainingCount = count - halfCount;

    // 获取前半部分
    const beforeMessages = await channel.messages.fetch({
      before: targetMessage.id,
      limit: halfCount
    });

    // 获取后半部分
    const afterMessages = await channel.messages.fetch({
      after: targetMessage.id,
      limit: remainingCount
    });

    // 合并并按时间排序
    const allMessages = [
      ...Array.from(beforeMessages.values()).reverse(),
      targetMessage,
      ...Array.from(afterMessages.values()).reverse()
    ];

    return allMessages;
  }

  /**
   * 过滤无效的消息
   */
  private filterMessages(messages: Message[]): Message[] {
    return messages.filter(message => {
      // 过滤系统消息
      if (message.system) return false;
      
      // 过滤空消息
      if (!message.content && message.attachments.size === 0 && message.embeds.length === 0) {
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
      mentionedUsers: message.mentions.users.map(user => user.id),
      mentionedRoles: message.mentions.roles.map(role => role.id),
      mentionsEveryone: message.mentions.everyone,
      isBot: message.author.bot,
      reference: message.reference ? {
        messageId: message.reference.messageId || null,
        channelId: message.reference.channelId || null,
        guildId: message.reference.guildId || null
      } : undefined,
      hasAttachments: message.attachments.size > 0,
      hasEmbeds: message.embeds.length > 0,
      hasBeenRepliedTo: false // 总结功能不需要这个字段
    };
  }

  /**
   * 格式化消息用于LLM处理
   */
  private formatMessagesForSummary(messages: SimpleMessage[]): string {
    return messages.map(message => {
      const timestamp = new Date(message.timestamp).toLocaleString('zh-CN');
      // 使用用户名而不是用户ID，为了可读性
      let content = `[${timestamp}] ${message.authorUsername}: ${message.content}`;
      
      if (message.hasAttachments) {
        content += ' [包含附件]';
      }
      
      if (message.hasEmbeds) {
        content += ' [包含嵌入内容]';
      }
      
      return content;
    }).join('\n');
  }

  /**
   * 使用LLM生成总结
   */
  private async generateSummary(
    formattedMessages: string,
    config: SummaryConfig,
    languageConfig: any,
    messageBatch: MessageBatch
  ): Promise<string> {
    // 确定目标语言
    let targetLanguage = 'auto';
    if (languageConfig?.primary && languageConfig.primary !== SupportedLanguage.Auto) {
      targetLanguage = this.getLanguageDisplayName(languageConfig.primary);
    }

    // 构建提示词 - 使用简化的提示词生成
    const summaryPrompt = this.buildSummaryPrompt(
      formattedMessages,
      config,
      targetLanguage,
      messageBatch
    );

    try {
      const globalConfig = this.configService.getConfig();
      const response = await callChatCompletionApi(
        'main',
        globalConfig.primaryLlmModel,
        [
          { role: 'system', content: '你是一个专业的聊天记录总结助手。请根据用户指定的语言和要求，提供清晰、有用的聊天记录总结。' },
          { role: 'user', content: summaryPrompt }
        ],
        0.95,
        1500
      );
      
      if (!response) {
        throw new Error('LLM返回空响应');
      }
      
      return response.trim();
    } catch (error) {
      loggerService.logger.error('Failed to generate summary:', error);
      throw new Error('生成总结时发生错误，请稍后重试');
    }
  }

  /**
   * 构建总结提示词
   */
  private buildSummaryPrompt(
    formattedMessages: string,
    config: SummaryConfig,
    targetLanguage: string,
    messageBatch: MessageBatch
  ): string {
    const directionText = this.getDirectionDescription(config.direction);
    const timeRange = this.formatTimeRange(messageBatch);
    
    // 构建用户映射表（用户名 -> Discord mention格式）
    const userMap = new Map<string, string>();
    messageBatch.messages.forEach(message => {
      userMap.set(message.authorUsername, `<@${message.authorId}>`);
    });
    
    const userMappingText = Array.from(userMap.entries())
      .map(([username, mention]) => `${username} -> ${mention}`)
      .join('\n');
    
    return `请分析以下Discord频道的聊天记录，并提供一个清晰、有用的总结。

**总结要求：**
1. 使用语言：${targetLanguage === 'auto' ? '根据聊天内容自动选择最合适的语言' : targetLanguage}
2. 提取主要话题和关键信息
3. 保持客观中性的语调
4. 重点关注有价值的讨论内容
5. 忽略无关的闲聊或系统消息
6. 如果涉及敏感内容，请谨慎处理
7. **重要：在总结中提到用户时，必须使用Discord mention格式，不要使用用户名或用户ID**

**用户映射表（用于在总结中正确引用用户）：**
${userMappingText}

**聊天记录信息：**
- 总结方向：${directionText}
- 消息数量：${messageBatch.totalCount}条
- 时间范围：${timeRange}

**聊天记录：**
${formattedMessages}

请提供一个结构化的总结，包含：
- 📋 主要话题
- 💬 关键讨论点  
- 🎯 重要结论或决定
- 📌 需要关注的事项（如有）

**注意：当在总结中提到具体用户时，请使用上述用户映射表中的Discord mention格式（如<@123456789>），这样用户名会在Discord中显示为可点击的蓝色链接。**`;
  }

  /**
   * 获取总结方向的描述
   */
  private getDirectionDescription(direction: string): string {
    const descriptions = {
      forward: '总结从指定消息开始之后的对话发展',
      backward: '总结导致指定消息产生的之前讨论内容',
      around: '总结围绕指定消息前后的完整讨论过程'
    };
    return descriptions[direction as keyof typeof descriptions] || direction;
  }

  /**
   * 获取服务器的语言配置
   */
  private async getLanguageConfigForGuild(guildId: string): Promise<any> {
    const serverConfig = this.configService.getServerConfig(guildId);
    return serverConfig?.languageConfig || this.configService.getConfig().language;
  }

  /**
   * 格式化时间范围
   */
  private formatTimeRange(messageBatch: MessageBatch): string {
    const start = new Date(Math.min(...messageBatch.messages.map(m => m.timestamp)));
    const end = new Date(Math.max(...messageBatch.messages.map(m => m.timestamp)));
    
    return `${start.toLocaleString('zh-CN')} 至 ${end.toLocaleString('zh-CN')}`;
  }

  /**
   * 获取方向显示名称
   */
  private getDirectionDisplayName(direction: string): string {
    const names = {
      forward: '📈 向前总结',
      backward: '📉 向后总结',
      around: '🎯 围绕总结'
    };
    return names[direction as keyof typeof names] || direction;
  }

  /**
   * 获取语言显示名称
   */
  private getLanguageDisplayName(languageCode: string): string {
    const config = this.configService.getConfig();
    const supportedLanguages = config.language?.supportedLanguages || [];
    const language = supportedLanguages.find(lang => lang.code === languageCode);
    return language?.name || languageCode;
  }

  /**
   * 设置用户冷却时间
   */
  private setCooldown(userId: string): void {
    const config = this.configService.getConfig();
    const cooldownSeconds = config.summary?.cooldownSeconds || 30;
    this.cooldowns.set(userId, Date.now() + (cooldownSeconds * 1000));
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