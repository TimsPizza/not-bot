# NOT-BOT

An intelligent Discord bot powered by LLM, featuring a smart decision-making system that knows when to jump into conversations and rich personality customization.

## 🌟 Key Features

### 📝 Message Summary Feature
- **Right-click summary**: Right-click any message to summarize preceding conversation
- **Flexible count**: Support summarizing 5-50 messages with preset options
- **Permission control**: Restrict which roles can use summary features

### 🧠 Smart Reply Decision System
- **Dual-layer evaluation**: Combines rule-based scoring with deep LLM assessment to intelligently decide when to "butt in"
- **Adjustable responsiveness**: Each server can set different activity levels
- **Context awareness**: Understands chat history and avoids repeatedly responding to handled messages

### 🎭 Rich Personality System
Supports various preset characters, plus custom ones:
- **Assistant Mode**: Friendly tech helper who loves answering questions
- **Catgirl Mode**: Adorable cat who likes being cute and spoiled
- **Tech Nerd**: Programmer who only gets excited about technology topics
- **Passive-Aggressive Master**: Expert in internet meme culture and gentle roasting
- **Digital Salted Fish**: 24/7 lying-flat zen group member
- **Supreme King**: Swagger chuuni emperor with supreme confidence
- **And many more interesting characters...**

### ⚙️ Flexible Configuration Management
- **Per-server settings**: Each Discord server can have independent configurations
- **Per-channel settings**: Different channels can use different personalities
- **Real-time config**: Adjust settings instantly via slash commands, no restart needed

### 🌐 Multi-language Support
- **Auto-detection**: Automatically detects chat language and responds accordingly
- **Multi-lingual personas**: Same personality can express similar traits in different languages

## Deployment Guide

### Requirements
- Node.js 21+ 
- pnpm (recommended) or npm
- Two OpenAI-compatible API services (primary LLM for responses, secondary for evaluation)

### Quick Start

1. **Clone the project**
```bash
git clone <your-repo-url>
cd discord-llm-bot
```

2. **Install dependencies**
```bash
pnpm install
# or use npm install
```

3. **Configure environment variables**

Copy the example config:
```bash
cp .env.example .env
```

Edit the `.env` file with your configuration:
```bash
# Discord bot configuration
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_app_id

# LLM API configuration (requires OpenAI-compatible endpoints)
OPENAI_PRIMARY_API_KEY=your_primary_llm_api_key
OPENAI_PRIMARY_BASE_URL=https://api.openai.com/v1
OPENAI_SECONDARY_API_KEY=your_secondary_llm_api_key  
OPENAI_SECONDARY_BASE_URL=https://api.openai.com/v1

# File path configuration (optional, use absolute paths)
SERVER_DATA_PATH=/path/to/your/data
PRESET_PERSONAS_PATH=/path/to/your/personas
PERSONA_PROMPT_FILE_PATH=/path/to/your/prompts.yaml
SCORING_RULES_FILE_PATH=/path/to/your/scoring_rules.json
```

4. **Configure settings**

Main configuration is in `config/config.yaml`, where you can adjust:
- Response thresholds
- Buffer settings  
- Context management
- Log levels, etc.

5. **Register Discord commands**
```bash
pnpm run register-commands
```

6. **Start the bot**
```bash
# Development mode (auto-restart)
pnpm run dev

# Production mode
pnpm start
```

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application, get `CLIENT_ID` and `BOT_TOKEN`
3. Enable these permissions on the Bot page:
   - Send Messages
   - Read Message History  
   - Use Slash Commands
   - Read Messages/View Channels
4. Invite the bot to your server with sufficient permissions

### Basic Usage

Once the bot starts, it will automatically begin working. You can:

- **Adjust configuration**: Use `/config` commands to view and modify settings
- **Switch personalities**: Use `/config persona set` to set characters for servers or channels
- **Adjust activity**: Use `/config set responsiveness` to tune reply frequency
- **Manage channels**: Use `/config channel` to enable or disable specific channels
- **Summarize conversations**: Right-click messages and select "📊 Summarize Messages"

### Advanced Configuration

#### Custom Personalities
Create JSON files in `<SERVER_DATA_PATH>/<server_id>/personas/`:
```json
{
  "id": "my_custom_persona",
  "name": "My Custom Character",
  "description": "Character description",
  "details": "Detailed personality settings and behavior guidelines..."
}
```

#### Adjust Scoring Rules
Modify `config/scoring_rules.json` to change message scoring logic.

#### Modify Prompt Templates
Edit `config/prompts.yaml` to adjust the bot's system prompts.

## Troubleshooting

**Common Issues:**

1. **Bot doesn't reply**
   - Check if the channel is in the allowed list
   - Verify response threshold settings aren't too high
   - Review logs to confirm scoring and decision process

2. **Config commands fail**
   - Ensure bot has sufficient Discord permissions
   - Check if slash commands are registered

3. **LLM calls fail**  
   - Verify API keys and endpoint URLs
   - Confirm model names are correct
   - Check network connection and API quotas

4. **File permission issues**
   - Ensure data directories have read/write permissions
   - Verify config file paths are correct

**View logs:**
```bash
# Set logLevel to "debug" in config.yaml for detailed logs
```

## Important Notes

- First run will create necessary directory structures
- Recommend using absolute paths for file configurations
- Regularly backup the data directory, including server configs and conversation contexts
- Monitor API usage to avoid exceeding quotas

## License

ISC License

---

If you encounter issues during usage, check the log files or submit an issue. 