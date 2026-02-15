# Slopbot

> **Disclaimer:** This project has been 100% vibe coded with zero human review of the code. It is very likely full of slop. Use at your own risk. The author assumes no responsibility for any issues arising from its use.

A Discord bot that bridges conversations with Claude via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Post a message in a watched channel, and the bot creates a thread, starts a Claude session, and streams responses back. Follow-up messages in the thread resume the same session.

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- Claude Code installed (`npm i -g @anthropic-ai/claude-code`)
- **One** of the following for Claude authentication:
  - An Anthropic API key (from [console.anthropic.com](https://console.anthropic.com/)), **or**
  - A Claude.ai account — run `claude login` on the host machine to authenticate

### 1. Create a Discord Application & Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** in the top-right corner.
3. Give it a name (e.g. "Slopbot") and click **Create**.

#### Get your bot token

1. In the left sidebar, click **Bot**.
2. Click **Reset Token** (or **Copy** if the token is still visible from creation).
3. Copy the token — you will need it for the `DISCORD_TOKEN` env var. This is the only time Discord shows it; if you lose it, you must reset it.

#### Enable privileged intents

The bot requires the **Message Content** intent to read what users type. Without it, `message.content` will always be an empty string.

1. On the same **Bot** page, scroll down to **Privileged Gateway Intents**.
2. Enable **Message Content Intent** (the toggle should turn blue).
3. Click **Save Changes** if prompted.

> The bot also uses the **Server Members** intent implicitly through `GatewayIntentBits.Guilds`. This is a non-privileged intent and does not need to be toggled on here.

#### Disable "Public Bot" (optional)

If you don't want other people to be able to invite your bot to their servers:

1. On the **Bot** page, find the **Public Bot** toggle near the top.
2. Turn it **off**.

### 2. Invite the Bot to Your Server

You need to generate an invite URL with the correct permissions.

#### Using the Developer Portal (recommended)

1. In the left sidebar, click **OAuth2**.
2. Scroll down to **OAuth2 URL Generator**.
3. Under **Scopes**, check:
   - `bot`
4. Under **Bot Permissions**, check:
   - **Send Messages** — post replies and placeholders
   - **Send Messages in Threads** — respond inside threads it creates
   - **Create Public Threads** — create a thread from each new user message
   - **Manage Messages** — edit its own placeholder messages with streamed content
   - **Embed Links** — render AskUserQuestion embeds
   - **Attach Files** — send image attachments when Claude references local files
   - **Read Message History** — fetch its own messages to edit/delete them
   - **Use External Emojis** *(optional)* — only if your embeds use custom emoji
5. Copy the **Generated URL** at the bottom of the page.
6. Open it in a browser, select your server from the dropdown, and click **Authorize**.

#### Permission integer (manual URL)

If you prefer to construct the URL yourself, the permissions above correspond to the integer `309237770240`. The invite URL format is:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=309237770240&scope=bot
```

Replace `YOUR_APP_ID` with the Application ID from the **General Information** page of the Developer Portal.

#### Summary of required permissions

| Permission | Flag | Why |
|---|---|---|
| Send Messages | `1 << 11` | Send the initial placeholder and error messages |
| Manage Messages | `1 << 13` | Edit its own messages to stream in Claude's response |
| Embed Links | `1 << 14` | Render AskUserQuestion option embeds |
| Attach Files | `1 << 15` | Upload images that Claude references in responses |
| Read Message History | `1 << 16` | Fetch its own messages for editing/deletion |
| Create Public Threads | `1 << 35` | Create a thread from each user message in the watched channel |
| Send Messages in Threads | `1 << 38` | Reply inside the threads the bot creates |

### 3. Set Up the Discord Channel

1. In your Discord server, create a text channel named **#claude** (or whatever you configure in `CHANNELS` / `WATCH_CHANNEL`).
2. The bot watches this channel for new messages. Every message posted there will start a new Claude session inside a thread.

#### Channel permission overrides (optional, recommended)

To keep the channel tidy, you may want to restrict who can post top-level messages. One common pattern:

1. Right-click the `#claude` channel and select **Edit Channel** > **Permissions**.
2. For `@everyone`:
   - **Send Messages** — set to the green checkmark (allow) if everyone should be able to start sessions, or the red X (deny) to restrict it.
   - **Send Messages in Threads** — set to the green checkmark (allow) so everyone can reply in threads.
3. For the bot's role (the role Discord created automatically when you invited it):
   - Make sure all the permissions from the table above are set to the green checkmark (allow), or at minimum not denied. The bot inherits server-level permissions, but explicit channel overrides take precedence.

### 4. Install & Configure the Bot

```bash
git clone <repo-url>
cd slopbot
pnpm install
cp .env.example .env
```

Edit `.env` and fill in your Discord token. For Claude authentication, choose one of the two options:

**Option A — API key:**

```env
DISCORD_TOKEN=paste-your-bot-token-here
ANTHROPIC_API_KEY=sk-ant-...
```

**Option B — Claude.ai account:**

```env
DISCORD_TOKEN=paste-your-bot-token-here
# No ANTHROPIC_API_KEY needed — uses `claude login` session
```

Run `claude login` on the machine before starting the bot. This opens a browser where you authenticate with your Claude.ai account. The session persists across bot restarts.

#### All environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes | — | Bot token from the Developer Portal (step 1) |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key. If unset, falls back to `claude login` session |
| `CHANNELS` | No | — | Multi-channel mapping as comma-separated `channel:path` pairs (e.g. `claude:/home/user/proj1,dev:/home/user/proj2`) |
| `WATCH_CHANNEL` | No | `claude` | Legacy single-channel config — channel name to watch (without `#`). Used as fallback when `CHANNELS` is not set |
| `CLAUDE_CWD` | No | Current directory | Working directory for Claude sessions. Used as fallback when `CHANNELS` is not set |
| `CLAUDE_MODEL` | No | SDK default | Claude model identifier (e.g. `claude-sonnet-4-5-20250929`) |
| `EDIT_RATE_MS` | No | `1500` | Minimum interval between streaming edits (ms) |
| `PERMISSION_MODE` | No | `bypassPermissions` | Claude Agent SDK permission mode |
| `SESSION_TIMEOUT_MINUTES` | No | `60` | Idle time before a session is cleaned up |
| `MAX_TOTAL_TURNS` | No | `200` | Maximum number of agent turns per query |
| `DEBUG` | No | `false` | Enable verbose debug logging (`true` or `1`) |

### 5. Run the Bot

```bash
# Development (auto-restarts on file changes)
pnpm dev

# Production
pnpm build
pnpm start
```

You should see:

```
Ready! Logged in as Slopbot#1234
Watching channel: #claude → /home/user/project
```

## Usage

1. Post a message in a watched channel (e.g. `#claude`).
2. The bot creates a thread and starts streaming Claude's response.
3. Claude's response streams in via live message edits.
4. Reply in the thread to continue the conversation — the same Claude session resumes.
5. If Claude asks a question, a numbered embed appears. Reply with:
   - `1` — select option 1
   - `1,3` — multi-select options 1 and 3
   - Any text — freeform answer

### Commands

| Command | Description |
|---|---|
| `!help` | Show available commands |
| `!clear` | Reset session and start fresh in the current thread |
| `!abort` | Stop the current response |
| `!model <name>` | Switch Claude model (e.g. `!model claude-sonnet-4-5-20250929`) |
| `!cost` | Show session and total API costs |

## Troubleshooting

### Bot comes online but ignores messages

- Make sure **Message Content Intent** is enabled in the Developer Portal (step 1).
- Verify the channel name matches your `CHANNELS` or `WATCH_CHANNEL` config exactly (case-sensitive, no `#` prefix).
- Check that the bot has **Read Messages/View Channels** permission in the channel (granted by default with the `bot` scope, but channel overrides can deny it).

### Bot replies with "Missing Permissions"

- Confirm the bot has **Create Public Threads** and **Send Messages in Threads** in the channel.
- If you set channel-level permission overrides, make sure the bot's role isn't denied any of the required permissions.

### "Missing Access" error in the console

- The bot cannot see the channel. Grant **View Channel** to the bot's role in the channel permission overrides.

### Claude authentication errors

- If using an API key, make sure `ANTHROPIC_API_KEY` is set correctly in `.env`.
- If using a Claude.ai account, run `claude login` on the host machine before starting the bot.
- The `auth_status` event in the console log will indicate if authentication is failing.

### Messages are empty or cut off

- Lower `EDIT_RATE_MS` if edits feel too slow (Discord rate-limits edits to ~5/5s per message, so don't go below `1000`).
- Long responses are automatically split across multiple messages at the 1950-character boundary.

## How It Works

- Each message in a watched channel starts a new Claude Agent SDK session in a new thread.
- Follow-up messages in a thread resume the existing session via `resume: sessionId`.
- Claude's responses stream in real-time via message edits (~1.5s intervals).
- When Claude uses `AskUserQuestion`, numbered options appear as an embed — the agent blocks until the user replies.
- File edits and writes are shown as collapsible diff cards with Show/Hide buttons.
- Sessions auto-expire after the configured timeout (default 60 minutes).

## License

[MIT](LICENSE)
