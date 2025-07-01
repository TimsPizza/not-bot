import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  InteractionResponse,
  Message,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction
} from 'discord.js';
import { MessageSummarizer } from '../../services/messageSummarizer';
import { SummaryConfig } from '../../types';
import { ConfigService } from '../../config';
import loggerService from '../../logger';

export const messageSummaryCommand = {
  name: '📊 Summarize Messages',
  type: ApplicationCommandType.Message,
  
  async execute(interaction: MessageContextMenuCommandInteraction) {
    try {
      const targetMessage = interaction.targetMessage;
      const channel = interaction.channel as TextChannel;

      // 检查基本权限
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({
          content: '❌ Summary feature can only be used in text channels',
          ephemeral: true
        });
        return;
      }

      // 显示总结配置选择器
      await showSummaryConfigSelector(interaction, targetMessage);

    } catch (error) {
      loggerService.logger.error('Error in message summary command:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId
      });
      
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: `❌ ${errorMessage}`,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: `❌ ${errorMessage}`,
          ephemeral: true
        });
      }
    }
  }
};

/**
 * 显示总结配置选择器
 */
async function showSummaryConfigSelector(
  interaction: MessageContextMenuCommandInteraction,
  targetMessage: Message
): Promise<void> {
  const configService = ConfigService.getInstance();
  const globalConfig = configService.getConfig();
  const globalSummaryConfig = globalConfig.summary;
  
  // 获取服务器配置
  const serverId = interaction.guildId;
  const serverConfig = serverId ? configService.getServerConfig(serverId) : null;
  
  loggerService.logger.info(`总结功能检查 - 用户: ${interaction.user.tag}, 频道: ${interaction.channelId}, 服务器: ${serverId}`);
  loggerService.logger.info(`全局总结配置:`, {
    enabled: globalSummaryConfig?.enabled,
    exists: !!globalSummaryConfig
  });
  
  if (serverConfig) {
    loggerService.logger.info(`服务器总结配置:`, {
      enabled: serverConfig.summarySettings?.enabled,
      exists: !!serverConfig.summarySettings,
      serverId: serverId
    });
  }

  // 检查总结功能是否启用（优先检查服务器设置，然后是全局设置）
  let summaryEnabled = false;
  let effectiveConfig: any = null;
  
  if (serverConfig?.summarySettings) {
    // 服务器有自定义设置，使用服务器设置
    summaryEnabled = serverConfig.summarySettings.enabled;
    effectiveConfig = {
      ...globalSummaryConfig,
      ...serverConfig.summarySettings,
      // 合并全局和服务器设置
      minMessages: globalSummaryConfig?.minMessages || 3,
      maxMessages: Math.min(
        serverConfig.summarySettings.maxMessagesPerSummary || 50,
        globalSummaryConfig?.maxMessages || 50
      ),
      presetCounts: globalSummaryConfig?.presetCounts || [5, 10, 15, 20]
    };
    loggerService.logger.info(`使用服务器级总结配置, enabled: ${summaryEnabled}`);
  } else if (globalSummaryConfig) {
    // 服务器没有设置，使用全局默认设置
    summaryEnabled = globalSummaryConfig.enabled;
    effectiveConfig = globalSummaryConfig;
    loggerService.logger.info(`使用全局总结配置, enabled: ${summaryEnabled}`);
  } else {
    // 没有任何配置
    loggerService.logger.warn(`没有找到总结配置 - 全局配置不存在`);
    summaryEnabled = false;
    effectiveConfig = null;
  }

  if (!summaryEnabled) {
    const reason = serverConfig?.summarySettings ? 'server' : 'global';
    loggerService.logger.info(`Summary feature disabled - reason: ${reason} level configuration disabled`);
    await interaction.reply({
      content: `❌ Summary feature is disabled (${reason} level setting)`,
      ephemeral: true
    });
    return;
  }

  if (!effectiveConfig) {
    loggerService.logger.error(`Summary feature configuration error - no valid configuration`);
    await interaction.reply({
      content: '❌ Summary feature configuration error',
      ephemeral: true
    });
    return;
  }

  loggerService.logger.info(`Summary feature enabled, using config:`, {
    minMessages: effectiveConfig.minMessages,
    maxMessages: effectiveConfig.maxMessages,
    presetCounts: effectiveConfig.presetCounts
  });

  // 创建预设数量选择器
  const presetOptions = (effectiveConfig.presetCounts || [5, 10, 15, 20]).map((count: number) => ({
    label: `${count} messages`,
    value: `preset_${count}`,
    description: `Summarize ${count} messages`,
    emoji: '📊'
  }));

  // 添加自定义选项
  presetOptions.push({
    label: '🔧 Custom Count',
    value: 'custom',
    description: `Custom message count (${effectiveConfig.minMessages}-${effectiveConfig.maxMessages} messages)`,
    emoji: '⚙️'
  });

  const countSelectMenu = new StringSelectMenuBuilder()
    .setCustomId(`summary_count_${targetMessage.id}`)
    .setPlaceholder('Select number of messages to summarize...')
    .addOptions(presetOptions);

  // 创建方向选择器
  const directionSelectMenu = new StringSelectMenuBuilder()
    .setCustomId(`summary_direction_${targetMessage.id}`)
    .setPlaceholder('Select summary direction...')
    .addOptions([
      {
        label: '📈 Later',
        value: 'forward',
        description: 'Summarize messages after this message',
        emoji: '📈'
      },
      {
        label: '📉 Earlier', 
        value: 'backward',
        description: 'Summarize messages before this message',
        emoji: '📉'
      },
      {
        label: '🎯 Around',
        value: 'around',
        description: 'Summarize messages around this message',
        emoji: '🎯'
      }
    ]);

  // 创建发送模式选择器
  const sendModeSelectMenu = new StringSelectMenuBuilder()
    .setCustomId(`summary_mode_${targetMessage.id}`)
    .setPlaceholder('Select visibility mode...')
    .addOptions([
      {
        label: '🌍 Public',
        value: 'public',
        description: 'Send summary to channel (visible to everyone)',
        emoji: '🌍'
      },
      {
        label: '🔒 Private',
        value: 'private', 
        description: 'Send summary privately (only you can see)',
        emoji: '🔒'
      }
    ]);

  // 创建确认和取消按钮
  const confirmButton = new ButtonBuilder()
    .setCustomId(`summary_confirm_${targetMessage.id}`)
    .setLabel('Generate Summary')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('✅')
    .setDisabled(true); // 初始禁用，直到所有选项都选择了

  const cancelButton = new ButtonBuilder()
    .setCustomId(`summary_cancel_${targetMessage.id}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('❌');

  const embed = new EmbedBuilder()
    .setTitle('📊 Message Summary Configuration')
    .setDescription(`Configure summary settings for messages around:\n\n> ${targetMessage.content.slice(0, 100)}${targetMessage.content.length > 100 ? '...' : ''}`)
    .addFields(
      { name: '👤 Requested by', value: `${interaction.user}`, inline: true },
      { name: '📅 Target message time', value: `<t:${Math.floor(targetMessage.createdTimestamp / 1000)}:f>`, inline: true },
      { name: '📍 Channel', value: `${interaction.channel}`, inline: true }
    )
    .setColor(0x3498db)
    .setFooter({ text: 'Select all options below, then click "Generate Summary"' });

  const rows = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(countSelectMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(directionSelectMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sendModeSelectMenu),
    new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton)
  ];

  await interaction.reply({
    embeds: [embed],
    components: rows,
    ephemeral: true
  });
}

/**
 * 处理总结配置选择
 */
export async function handleSummaryConfigSelect(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  try {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const action = parts[0];
    const subAction = parts[1];
    const messageId = parts[2];
    
    if (action !== 'summary' || !messageId || !subAction) {
      loggerService.logger.warn(`Invalid summary config selection interaction: ${customId}`, { parts });
      return;
    }

    const validMessageId = messageId as string;
    const value = interaction.values[0];

    if (subAction === 'count' && value === 'custom') {
      // 显示自定义数量输入Modal
      await showCustomCountModal(interaction, validMessageId);
    } else {
      // 只更新状态，不执行总结
      await updateSummaryConfigSelection(interaction, subAction, value, validMessageId);
    }

  } catch (error) {
    loggerService.logger.error('Error handling summary config select:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      customId: interaction.customId,
      userId: interaction.user.id,
      values: interaction.values
    });
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Error processing configuration selection',
        ephemeral: true
      });
    }
  }
}

/**
 * 处理按钮交互（确认/取消）
 */
export async function handleSummaryButtonClick(
  interaction: ButtonInteraction
): Promise<void> {
  try {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const action = parts[0];
    const subAction = parts[1];
    const messageId = parts[2];
    
    if (action !== 'summary' || !messageId) {
      return;
    }

    const stateKey = `${interaction.user.id}_${messageId}`;
    const currentState = configStates.get(stateKey);

    if (subAction === 'cancel') {
      // 取消操作
      configStates.delete(stateKey);
      await interaction.update({
        content: '❌ Summary configuration cancelled',
        embeds: [],
        components: []
      });
      return;
    }

    if (subAction === 'confirm') {
      if (!currentState || !currentState.count || !currentState.direction || !currentState.sendMode) {
        await interaction.reply({
          content: '❌ Please complete all configuration options before confirming',
          ephemeral: true
        });
        return;
      }

      // 显示loading状态
      await interaction.update({
        content: '🤖 Bot is thinking... Generating summary, please wait.',
        embeds: [],
        components: []
      });

      // 执行总结
      const config = currentState as SummaryConfig;
      await executeSummaryWithLoading(interaction, config);
      
      // 清理状态
      configStates.delete(stateKey);
    }

  } catch (error) {
    loggerService.logger.error('Error handling summary button click:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      customId: interaction.customId,
      userId: interaction.user.id
    });
    
    await interaction.reply({
      content: '❌ Error processing button click',
      ephemeral: true
    });
  }
}

/**
 * 显示自定义数量输入Modal
 */
async function showCustomCountModal(
  interaction: StringSelectMenuInteraction,
  messageId: string
): Promise<void> {
  const configService = ConfigService.getInstance();
  const summaryConfig = configService.getConfig().summary;

  const modal = new ModalBuilder()
    .setCustomId(`summary_custom_count_${messageId}`)
    .setTitle('自定义消息数量');

  const countInput = new TextInputBuilder()
    .setCustomId('message_count')
    .setLabel('消息数量')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`请输入 ${summaryConfig?.minMessages || 3} 到 ${summaryConfig?.maxMessages || 50} 之间的数字`)
    .setMinLength(1)
    .setMaxLength(2)
    .setRequired(true);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(countInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

/**
 * 处理自定义数量Modal提交
 */
export async function handleCustomCountModal(
  interaction: ModalSubmitInteraction
): Promise<void> {
  try {
    const customId = interaction.customId;
    const messageId = customId.split('_')[3];
    
    if (!messageId) {
      await interaction.reply({
        content: '❌ 无效的消息ID',
        ephemeral: true
      });
      return;
    }
    
    const count = parseInt(interaction.fields.getTextInputValue('message_count'));

    const configService = ConfigService.getInstance();
    const summaryConfig = configService.getConfig().summary;
    const minMessages = summaryConfig?.minMessages || 3;
    const maxMessages = summaryConfig?.maxMessages || 50;

    if (isNaN(count) || count < minMessages || count > maxMessages) {
      await interaction.reply({
        content: `❌ 请输入有效的数字 (${minMessages}-${maxMessages})`,
        ephemeral: true
      });
      return;
    }

    // 更新配置状态
    await updateSummaryConfigSelection(interaction, 'count', count.toString(), messageId);

  } catch (error) {
    loggerService.logger.error('Error handling custom count modal:', error);
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ 处理自定义数量时发生错误',
        ephemeral: true
      });
    }
  }
}

// 临时存储配置状态（在生产环境中应该使用Redis等持久化存储）
const configStates = new Map<string, Partial<SummaryConfig>>();

/**
 * 更新配置选择状态（新模式：只更新状态，不执行总结）
 */
async function updateSummaryConfigSelection(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  configType: string,
  value: string,
  messageId: string
): Promise<void> {
  if (!interaction.channelId) {
    throw new Error('Unable to get channel information');
  }
  
  const stateKey = `${interaction.user.id}_${messageId}`;
  let currentState = configStates.get(stateKey) || { messageId, channelId: interaction.channelId };

  // 更新配置
  switch (configType) {
    case 'count':
      currentState.count = value.startsWith('preset_') ? 
        parseInt(value.replace('preset_', '')) : 
        parseInt(value);
      break;
    case 'direction':
      currentState.direction = value as 'forward' | 'backward' | 'around';
      break;
    case 'mode':
      currentState.sendMode = value as 'public' | 'private';
      break;
  }

  configStates.set(stateKey, currentState);

  // 更新界面显示当前状态和确认按钮状态
  await updateConfigInterfaceWithButtons(interaction, currentState, messageId);
}

/**
 * 用于loading模式的总结执行函数
 */
async function executeSummaryWithLoading(
  interaction: ButtonInteraction,
  config: SummaryConfig
): Promise<void> {
  try {
    const channel = interaction.channel as TextChannel;
    const summarizer = MessageSummarizer.getInstance();

    // 执行总结
    const result = await summarizer.summarizeMessages(
      channel,
      config.messageId,
      config,
      interaction.user
    );

    // 创建总结结果嵌入
    const resultEmbed = new EmbedBuilder()
      .setTitle('📊 Chat Summary')
      .setDescription(result.summary)
      .addFields(
        { name: '👤 Requested by', value: `${interaction.user}`, inline: true },
        { name: '📊 Message Count', value: `${result.messageCount} messages`, inline: true },
        { name: '📈 Direction', value: result.direction, inline: true },
        { name: '⏰ Time Range', value: `<t:${Math.floor(result.timeRange.start.getTime() / 1000)}:f> to <t:${Math.floor(result.timeRange.end.getTime() / 1000)}:f>`, inline: false }
      )
      .setColor(0x2ecc71)
      .setTimestamp()
      .setFooter({ text: `Summary ID: ${result.requestId}` });

    // 根据发送模式发送结果
    if (config.sendMode === 'public') {
      // 公开发送到频道
      await channel.send({ embeds: [resultEmbed] });
      
      // 更新交互回复
      await interaction.editReply({
        content: '✅ Summary has been sent to the channel!',
        embeds: [],
        components: []
      });
    } else {
      // 私人发送，只有发起者可见
      await interaction.editReply({
        content: '✅ Summary generated successfully!',
        embeds: [resultEmbed],
        components: []
      });
    }

  } catch (error) {
    loggerService.logger.error('Error executing summary with loading:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      config: config,
      userId: interaction.user.id,
      channelId: interaction.channelId
    });
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred while generating summary';
    
    await interaction.editReply({
      content: `❌ ${errorMessage}`,
      embeds: [],
      components: []
    });
  }
}

/**
 * 更新配置界面显示（带按钮状态）
 */
async function updateConfigInterfaceWithButtons(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  config: Partial<SummaryConfig>,
  messageId: string
): Promise<void> {
  const checkMark = '✅';
  const pendingMark = '⏳';

  const statusText = [
    `${config.count ? checkMark : pendingMark} Message Count: ${config.count ? `${config.count} messages` : 'Not set'}`,
    `${config.direction ? checkMark : pendingMark} Direction: ${config.direction ? getDirectionName(config.direction) : 'Not set'}`,
    `${config.sendMode ? checkMark : pendingMark} Visibility: ${config.sendMode ? getSendModeName(config.sendMode) : 'Not set'}`
  ].join('\n');

  const allSelected = config.count && config.direction && config.sendMode;
  
  // 重建按钮，确认按钮根据完成状态启用/禁用
  const confirmButton = new ButtonBuilder()
    .setCustomId(`summary_confirm_${messageId}`)
    .setLabel('Generate Summary')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('✅')
    .setDisabled(!allSelected);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`summary_cancel_${messageId}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('❌');

  const embed = new EmbedBuilder()
    .setTitle('📊 Message Summary Configuration')
    .setDescription('Current configuration status:\n\n' + statusText)
    .setColor(allSelected ? 0x2ecc71 : 0xf39c12)
    .setFooter({ text: allSelected ? 
      'All options selected! Click "Generate Summary" to proceed.' : 
      'Please complete all configuration options above.' });

  // 重建组件，只显示未选择的选择菜单
  const components = [];
  
  if (!allSelected) {
    // 获取全局配置用于重建组件
    const configService = ConfigService.getInstance();
    const globalConfig = configService.getConfig();
    const effectiveConfig = globalConfig.summary;

    // 消息数量选择器（如果未选择）
    if (!config.count) {
      const presetOptions = (effectiveConfig?.presetCounts || [5, 10, 15, 20]).map((count: number) => ({
        label: `${count} messages`,
        value: `preset_${count}`,
        description: `Summarize ${count} messages`,
        emoji: '📊'
      }));

      presetOptions.push({
        label: '🔧 Custom Count',
        value: 'custom',
        description: `Custom message count (${effectiveConfig?.minMessages || 3}-${effectiveConfig?.maxMessages || 50} messages)`,
        emoji: '⚙️'
      });

      const countSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_count_${messageId}`)
        .setPlaceholder('Select number of messages to summarize...')
        .addOptions(presetOptions);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(countSelectMenu));
    }

    // 方向选择器（如果未选择）
    if (!config.direction) {
      const directionSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_direction_${messageId}`)
        .setPlaceholder('Select summary direction...')
        .addOptions([
          {
            label: '📈 Forward',
            value: 'forward',
            description: 'Summarize messages after this message',
            emoji: '📈'
          },
          {
            label: '📉 Backward', 
            value: 'backward',
            description: 'Summarize messages before this message',
            emoji: '📉'
          },
          {
            label: '🎯 Around',
            value: 'around',
            description: 'Summarize messages around this message',
            emoji: '🎯'
          }
        ]);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(directionSelectMenu));
    }

    // 发送模式选择器（如果未选择）
    if (!config.sendMode) {
      const sendModeSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_mode_${messageId}`)
        .setPlaceholder('Select visibility mode...')
        .addOptions([
          {
            label: '🌍 Public',
            value: 'public',
            description: 'Send summary to channel (visible to everyone)',
            emoji: '🌍'
          },
          {
            label: '🔒 Private',
            value: 'private', 
            description: 'Send summary privately (only you can see)',
            emoji: '🔒'
          }
        ]);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sendModeSelectMenu));
    }
  }

  // 总是添加按钮行
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton));

  const updateData = {
    embeds: [embed],
    components: components
  };

  // 根据交互类型选择合适的更新方法
  if (interaction instanceof StringSelectMenuInteraction) {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(updateData);
    } else {
      await interaction.update(updateData);
    }
  } else {
    // ModalSubmitInteraction
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(updateData);
    } else {
      await interaction.reply({
        ...updateData,
        ephemeral: true
      });
    }
  }
}

/**
 * 更新配置界面显示（旧版本，保留兼容性）
 */
async function updateConfigInterface(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  config: Partial<SummaryConfig>,
  messageId: string
): Promise<void> {
  const checkMark = '✅';
  const pendingMark = '⏳';

  const statusText = [
    `${config.count ? checkMark : pendingMark} 消息数量: ${config.count ? `${config.count}条` : '未设置'}`,
    `${config.direction ? checkMark : pendingMark} 总结方向: ${config.direction ? getDirectionName(config.direction) : '未设置'}`,
    `${config.sendMode ? checkMark : pendingMark} 发送模式: ${config.sendMode ? getSendModeName(config.sendMode) : '未设置'}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📊 消息总结配置')
    .setDescription('当前配置状态：\n\n' + statusText)
    .setColor(config.count && config.direction && config.sendMode ? 0x2ecc71 : 0xf39c12)
    .setFooter({ text: config.count && config.direction && config.sendMode ? 
      '配置完成！正在生成总结...' : '请继续完成配置选项' });

  // 重建选择菜单组件，标记已选择的选项
  const components = [];
  
  if (!(config.count && config.direction && config.sendMode)) {
    // 获取全局配置用于重建组件
    const configService = ConfigService.getInstance();
    const globalConfig = configService.getConfig();
    const effectiveConfig = globalConfig.summary;

    // 消息数量选择器（如果未选择）
    if (!config.count) {
      const presetOptions = (effectiveConfig?.presetCounts || [5, 10, 15, 20]).map((count: number) => ({
        label: `${count} 条消息`,
        value: `preset_${count}`,
        description: `总结 ${count} 条消息`,
        emoji: '📊'
      }));

      presetOptions.push({
        label: '🔧 自定义数量',
        value: 'custom',
        description: `自定义消息数量 (${effectiveConfig?.minMessages || 3}-${effectiveConfig?.maxMessages || 50}条)`,
        emoji: '⚙️'
      });

      const countSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_count_${messageId}`)
        .setPlaceholder('选择要总结的消息数量...')
        .addOptions(presetOptions);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(countSelectMenu));
    }

    // 方向选择器（如果未选择）
    if (!config.direction) {
      const directionSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_direction_${messageId}`)
        .setPlaceholder('选择总结方向...')
        .addOptions([
          {
            label: '📈 向前总结',
            value: 'forward',
            description: '总结从此消息开始之后的对话',
            emoji: '📈'
          },
          {
            label: '📉 向后总结', 
            value: 'backward',
            description: '总结导致此消息产生的之前讨论',
            emoji: '📉'
          },
          {
            label: '🎯 围绕总结',
            value: 'around',
            description: '总结围绕此消息前后的讨论',
            emoji: '🎯'
          }
        ]);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(directionSelectMenu));
    }

    // 发送模式选择器（如果未选择）
    if (!config.sendMode) {
      const sendModeSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`summary_mode_${messageId}`)
        .setPlaceholder('选择发送模式...')
        .addOptions([
          {
            label: '🌍 公开到频道',
            value: 'public',
            description: '总结结果将发送到频道，所有人可见',
            emoji: '🌍'
          },
          {
            label: '🔒 仅自己可见',
            value: 'private', 
            description: '总结结果只有您能看到',
            emoji: '🔒'
          }
        ]);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sendModeSelectMenu));
    }
  }

  const updateData = {
    embeds: [embed],
    components: components
  };

  // 根据交互类型选择合适的更新方法
  if (interaction instanceof StringSelectMenuInteraction) {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(updateData);
    } else {
      await interaction.update(updateData);
    }
  } else {
    // ModalSubmitInteraction
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(updateData);
    } else {
      await interaction.reply({
        ...updateData,
        ephemeral: true
      });
    }
  }
}

/**
 * 执行总结
 */
async function executeSummary(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  config: SummaryConfig
): Promise<void> {
  try {
    // 延迟回复，因为总结可能需要一些时间
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    const channel = interaction.channel as TextChannel;
    const summarizer = MessageSummarizer.getInstance();

    // 执行总结
    const result = await summarizer.summarizeMessages(
      channel,
      config.messageId,
      config,
      interaction.user
    );

    // 创建总结结果嵌入
    const resultEmbed = new EmbedBuilder()
      .setTitle('📊 聊天记录总结')
      .setDescription(result.summary)
      .addFields(
        { name: '👤 发起者', value: `${interaction.user}`, inline: true },
        { name: '📊 消息数量', value: `${result.messageCount}条`, inline: true },
        { name: '📈 总结方向', value: result.direction, inline: true },
        { name: '⏰ 时间范围', value: `<t:${Math.floor(result.timeRange.start.getTime() / 1000)}:f> 至 <t:${Math.floor(result.timeRange.end.getTime() / 1000)}:f>`, inline: false }
      )
      .setColor(0x2ecc71)
      .setTimestamp()
      .setFooter({ text: `总结ID: ${result.requestId}` });

    // 根据发送模式发送结果
    if (config.sendMode === 'public') {
      // 公开发送到频道
      await channel.send({ embeds: [resultEmbed] });
      
      // 更新交互回复
      await interaction.editReply({
        content: '✅ 总结已成功发送到频道！',
        embeds: [],
        components: []
      });
    } else {
      // 私人发送，只有发起者可见
      await interaction.editReply({
        content: '✅ 总结生成完成！',
        embeds: [resultEmbed],
        components: []
      });
    }

  } catch (error) {
    loggerService.logger.error('Error executing summary:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      config: config,
      userId: interaction.user.id,
      channelId: interaction.channelId
    });
    
    const errorMessage = error instanceof Error ? error.message : '生成总结时发生未知错误';
    
    await interaction.editReply({
      content: `❌ ${errorMessage}`,
      embeds: [],
      components: []
    });
  }
}

/**
 * 获取方向显示名称
 */
function getDirectionName(direction: string): string {
  const names = {
    forward: '📈 向前总结',
    backward: '📉 向后总结', 
    around: '🎯 围绕总结'
  };
  return names[direction as keyof typeof names] || direction;
}

/**
 * 获取发送模式显示名称
 */
function getSendModeName(sendMode: string): string {
  const names = {
    public: '🌍 公开到频道',
    private: '🔒 仅自己可见'
  };
  return names[sendMode as keyof typeof names] || sendMode;
} 