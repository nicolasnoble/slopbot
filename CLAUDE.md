# Slopbot

Discord bot that bridges conversations with Claude via the Claude Agent SDK.

## Quick Start

```bash
cp .env.example .env   # fill in DISCORD_TOKEN and ANTHROPIC_API_KEY
pnpm install
pnpm dev               # start with tsx (hot-reload friendly)
```

## Architecture

- **Thread-per-message**: Each message in `#claude` creates a Discord thread + new Claude session. Follow-ups in thread resume the session via `resume: sessionId`.
- **Session persistence**: `threadId → sessionId` mappings are persisted to `sessions.json`, so the bot can resume Claude sessions in existing threads after a restart.
- **Streaming edits**: Bot shows a live status message (*Thinking...* / *Working — 3 file reads · 1 command*) while Claude works, then replaces it with the response once text starts streaming. Subsequent chunks are edited in-place every ~1.5s. Messages >1950 chars are split. Status reappears between turns.
- **AskUserQuestion bridge**: When Claude calls `AskUserQuestion`, the `canUseTool` callback renders a numbered embed and creates a Promise. The user replies with a number, and the Promise resolves, unblocking the agent.
- **Plan approval bridge**: When Claude calls `ExitPlanMode`, the bot reads the plan file from `~/.claude/plans/` (most recently modified), sends the content to Discord, and waits for user approval. Reply "1"/"approve" to approve, "2"/"reject" to reject, or type feedback.
- **Permission handling**: All standard tools are pre-approved via `allowedTools`. `AskUserQuestion` and `ExitPlanMode` are intentionally excluded so they route through `canUseTool`, where the Discord bridge renders embeds and waits for user input.
- **Usage tracking**: `!usage` fetches live utilization metrics from Anthropic's OAuth API (`/api/oauth/usage`). Reads credentials from `~/.claude/.credentials.json` (managed by the Claude Code CLI). Requires the `user:profile` OAuth scope — standard `claude` login provides this, but `claude setup-token` does not. Auto-refreshes expired access tokens via the refresh token. Includes end-of-window projections via linear extrapolation (⚠️ ≥80%, 🚨 ≥100%).
- **Usage monitoring**: Hourly periodic checks post usage reports to the first configured channel when values change. Alerts are prepended when projections indicate high usage or likely rate limits.
- **Debug mode**: Set `DEBUG=true` to enable timestamped verbose logging across all modules (message routing, SDK events, tool calls, session lifecycle, store operations).

## Project Structure

```
src/
├── index.ts              # Entry point: Discord client setup + login
├── config.ts             # Env var parsing with defaults
├── debug.ts              # Conditional debug logger (enabled via DEBUG env)
├── types.ts              # Shared TypeScript interfaces
├── sessionManager.ts     # Map<threadId, SessionInfo> + cleanup
├── sessionStore.ts       # Persist threadId→sessionId to sessions.json
├── messageHandler.ts     # messageCreate router
├── agentRunner.ts        # Core: query() + stream processing → Discord
├── toolHandler.ts        # canUseTool: AskUserQuestion + ExitPlanMode bridges
├── questionRenderer.ts   # AskUserQuestion → Discord embed
├── replyParser.ts        # Parse "1", "2,4", freeform answers
├── planApprovalParser.ts # Parse plan approval replies (approve/reject/feedback)
├── usageTracker.ts       # Fetch Claude account usage via OAuth API + projections
├── usageMonitor.ts       # Periodic hourly usage reports with change detection
├── messageSplitter.ts    # Split text >2000 chars
├── attachments.ts        # Detect image paths, create AttachmentBuilder
└── stressTest.ts         # !stress diagnostic: rapid tool call throughput test
```

## Rules

- **Keep `README.md` accurate.** Any user-facing change (new command, new feature, changed behavior, new env var) must be reflected in `README.md` in the same commit. The README is the primary documentation for end users.

## Commands

- `pnpm dev` — run with tsx
- `pnpm build` — compile TypeScript
- `pnpm start` — run compiled JS
- `pnpm typecheck` — type-check without emitting
