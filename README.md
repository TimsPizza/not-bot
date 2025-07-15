# NOT-BOT

一个基于LLM的智能Discord机器人，具备自动判断聊天时机的决策系统和丰富的人格化功能。

## 🌟 主要特性

### 📝 消息总结功能
- **右键总结**：对任意消息点击右键即可总结前面的对话
- **灵活数量**：支持总结5-50条消息，有预设选项
- **权限控制**：可以限制哪些角色能使用总结功能

### 🧠 智能回复决策
- **双层评估系统**：结合规则评分和LLM深度评估，智能判断什么时候该"插嘴"
- **可调节响应敏感度**：每个服务器可以设置不同的活跃程度
- **上下文感知**：理解聊天历史，避免重复回复已处理的消息

### 🎭 丰富的人格系统
支持多种预设角色，也可以自定义：
- **助手模式**：友善的技术助手，乐于回答问题
- **猫娘模式**：可爱的喵星人，喜欢卖萌撒娇
- **技术宅**：只对科技话题感兴趣的程序员
- **阴阳怪气大师**：精通网络梗文化的调侃专家
- **数字咸鱼**：24小时躺平的佛系群友
- **中二逼王**：狂拽酷炫的自信帝王
- **还有更多有趣角色...**

### ⚙️ 灵活的配置管理
- **按服务器配置**：每个Discord服务器可以有独立设置
- **按频道配置**：不同频道可以使用不同的人格
- **实时配置**：通过斜杠命令即时调整设置，无需重启

### 🌐 多语言支持
- **自动检测**：根据聊天内容自动判断使用什么语言回复
- **多语言人格**：同一个人格可以用不同语言展现相似特性

## 部署指南

### 环境要求
- Node.js 21+ 
- pnpm (推荐) 或 npm
- 两个OpenAI兼容的API服务（主LLM用于回复，辅助LLM用于评估）

### 快速开始

1. **克隆项目**
```bash
git clone <your-repo-url>
cd discord-llm-bot
```

2. **安装依赖**
```bash
pnpm install
# 或者使用 npm install
```

3. **配置环境变量**

复制示例配置文件：
```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的配置：
```bash
# Discord机器人配置
DISCORD_BOT_TOKEN=你的Discord机器人token
DISCORD_CLIENT_ID=你的Discord应用ID

# LLM API配置（需要OpenAI兼容接口）
OPENAI_PRIMARY_API_KEY=主要LLM的API密钥
OPENAI_PRIMARY_BASE_URL=https://api.openai.com/v1
OPENAI_SECONDARY_API_KEY=辅助LLM的API密钥  
OPENAI_SECONDARY_BASE_URL=https://api.openai.com/v1

# 文件路径配置（可选，使用绝对路径）
SERVER_DATA_PATH=/path/to/your/data
PRESET_PERSONAS_PATH=/path/to/your/personas
PERSONA_PROMPT_FILE_PATH=/path/to/your/prompts.yaml
SCORING_RULES_FILE_PATH=/path/to/your/scoring_rules.json
```

4. **配置文件设置**

主要配置在 `config/config.yaml`，可以调整：
- 响应阈值
- 缓冲区设置  
- 上下文管理
- 日志级别等

5. **注册Discord命令**
```bash
pnpm run register-commands
```

6. **启动机器人**
```bash
# 开发模式（自动重启）
pnpm run dev

# 生产模式
pnpm start
```

### Discord机器人设置

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 创建新应用，获取 `CLIENT_ID` 和 `BOT_TOKEN`
3. 在Bot页面开启以下权限：
   - Send Messages
   - Read Message History  
   - Use Slash Commands
   - Read Messages/View Channels
4. 邀请机器人到你的服务器，确保有足够权限

### 基本使用

机器人启动后会自动开始工作，你可以：

- **调整配置**：使用 `/config` 命令查看和修改设置
- **切换人格**：使用 `/config persona set` 为服务器或频道设置角色
- **调节活跃度**：使用 `/config set responsiveness` 调整回复频率
- **管理频道**：使用 `/config channel` 启用或禁用特定频道
- **总结对话**：右键点击消息选择"📊 Summarize Messages"

### 高级配置

#### 自定义人格
在 `<SERVER_DATA_PATH>/<服务器ID>/personas/` 目录下创建JSON文件：
```json
{
  "id": "my_custom_persona",
  "name": "我的自定义角色",
  "description": "角色简介",
  "details": "详细的人格设定和行为指南..."
}
```

#### 调整评分规则
修改 `config/scoring_rules.json` 来改变消息评分逻辑。

#### 修改提示词模板
编辑 `config/prompts.yaml` 来调整机器人的系统提示词。

## 故障排除

**常见问题：**

1. **机器人不回复**
   - 检查频道是否在允许列表中
   - 确认响应阈值设置是否过高
   - 查看日志确认评分和决策过程

2. **配置命令失败**
   - 确保机器人有足够的Discord权限
   - 检查是否已注册斜杠命令

3. **LLM调用失败**  
   - 验证API密钥和端点URL
   - 确认模型名称正确
   - 检查网络连接和API配额

4. **文件权限问题**
   - 确保数据目录有读写权限
   - 检查配置文件路径是否正确

**查看日志：**
```bash
# 修改config.yaml中的logLevel为"debug"获取详细日志
```

## 注意事项

- 首次运行会创建必要的目录结构
- 建议使用绝对路径配置文件位置
- 定期备份数据目录，包含服务器配置和对话上下文
- 监控API使用量，避免超出配额

## 许可证

MIT License

---

如果你在使用过程中遇到问题，可以查看日志文件或提交issue。 