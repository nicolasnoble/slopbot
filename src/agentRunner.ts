import { query, type SDKMessage, type SDKUserMessage, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { EmbedBuilder, type Message, type ThreadChannel } from "discord.js";
import type { SessionInfo, StreamState, ToolCard, PartialToolInput } from "./types.js";
import { config } from "./config.js";
import { touchSession, setSessionId, addCost } from "./sessionManager.js";
import { removePersistedSession } from "./sessionStore.js";
import { debug } from "./debug.js";
import { createCanUseTool } from "./toolHandler.js";
import { splitMessageSimple, wrapTablesInCodeBlocks, escapeCodeFences } from "./messageSplitter.js";
import { extractAttachments, attachmentsFromPaths, IMAGE_EXTENSIONS } from "./attachments.js";
import { storeDiff, getDiff } from "./diffStore.js";
import { buildDiffCardEmbed, buildShowDiffButton } from "./diffCard.js";
import { resolve, isAbsolute, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createAsyncChannel, type AsyncChannel } from "./asyncChannel.js";

// Resolve the bundled CLI path explicitly — the SDK's automatic resolution
// uses "../cli.js" relative to its own module, which breaks under pnpm's
// node_modules layout where the parent directory is @anthropic-ai/, not the
// package root.
const require_ = createRequire(import.meta.url);
const sdkEntry = require_.resolve("@anthropic-ai/claude-agent-sdk");
const claudeCliPath = join(dirname(sdkEntry), "cli.js");

/** Cached list of available models, populated on first session init. */
let cachedModels: ModelInfo[] | null = null;

export function getCachedModels(): ModelInfo[] | null {
  return cachedModels;
}

// ── Status message helpers ──────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string> = {
  Read: "file read",
  Write: "file write",
  Edit: "file edit",
  Bash: "command",
  Grep: "search",
  Glob: "search",
  Task: "task",
  WebFetch: "web fetch",
  WebSearch: "web search",
};

function formatCountsSummary(toolCounts: Record<string, number>): string {
  const entries = Object.entries(toolCounts);
  if (entries.length === 0) return "";

  const categories: Record<string, number> = {};
  for (const [tool, count] of entries) {
    const cat = TOOL_CATEGORIES[tool] ?? tool;
    categories[cat] = (categories[cat] ?? 0) + count;
  }

  const parts = Object.entries(categories).map(([cat, count]) => {
    const plural = count === 1 ? "" : "s";
    return `${count} ${cat}${plural}`;
  });

  return parts.join(" · ");
}

/** Extract a short, human-readable detail string from a tool's input. */
function toolDetail(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return shortenPath((input.file_path as string) ?? "", cwd);
    case "Bash": {
      const cmd = (input.command as string) ?? "";
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "Grep":
      return (input.pattern as string) ?? "";
    case "Glob":
      return (input.pattern as string) ?? "";
    case "WebFetch":
      return (input.url as string) ?? "";
    case "WebSearch":
      return (input.query as string) ?? "";
    case "Task":
      return (input.description as string) ?? "";
    default:
      return "";
  }
}

/** Strip the working directory prefix from a path for display. */
function shortenPath(p: string, cwd: string): string {
  if (p.startsWith(cwd + "/")) {
    return p.slice(cwd.length + 1);
  }
  return p;
}

/** Build a Discord embed showing live status. */
function buildStatusEmbed(state: StreamState): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x5865f2); // Discord blurple

  if (state.toolLog.length === 0) {
    embed.setDescription("*Thinking...*");
    return embed;
  }

  // Show compact status — individual tool cards handle the details
  embed.setDescription("*Working...*");

  const summary = formatCountsSummary(state.toolCounts);
  if (summary) {
    embed.setFooter({ text: summary });
  }

  return embed;
}

async function sendStatus(state: StreamState, thread: ThreadChannel): Promise<void> {
  try {
    // Keep the native "Bot is typing..." indicator active alongside our status
    thread.sendTyping().catch(() => {});
    if (!state.typingInterval) {
      state.typingInterval = setInterval(() => {
        thread.sendTyping().catch(() => {});
      }, 8_000);
    }

    const embed = buildStatusEmbed(state);

    if (state.statusMessage) {
      await state.statusMessage.edit({ content: "", embeds: [embed] });
    } else {
      state.statusMessage = await thread.send({ embeds: [embed] });
    }
  } catch {
    // Status updates are best-effort
  }
}

// ── Tool card helpers ────────────────────────────────────────────────

/** Extract the last N lines from text (truncated to fit in an embed). */
function truncateOutput(text: string, maxLines = 8): string {
  const lines = text.split("\n");
  const selected = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const prefix = lines.length > maxLines ? `... (${lines.length - maxLines} lines hidden)\n` : "";
  let result = prefix + selected.join("\n");
  // Cap total length to avoid exceeding Discord embed limits
  if (result.length > 3800) {
    result = result.slice(-3800);
  }
  return result;
}

/** Build a Discord embed for a single tool card. */
function buildToolCardEmbed(
  name: string,
  detail: string,
  output?: string,
  elapsedSec?: number,
  done?: boolean,
): EmbedBuilder {
  const icon = done ? "\u2705" : "\u23F3";
  const detailStr = detail ? `  \`${detail}\`` : "";
  let description = `${icon} **${name}**${detailStr}`;

  if (output) {
    description += `\n\u2504\u2504\u2504\u2504\u2504\u2504\u2504\u2504\n\`\`\`\n${escapeCodeFences(truncateOutput(output))}\n\`\`\``;
  }

  const embed = new EmbedBuilder()
    .setColor(done ? 0x57f287 : 0x5865f2) // green when done, blurple while running
    .setDescription(description);

  if (elapsedSec != null) {
    embed.setFooter({ text: `\u23F1 ${elapsedSec.toFixed(1)}s` });
  }

  return embed;
}

/** Delete all active tool card messages (best-effort), skipping persistent diff cards. */
async function deleteAllToolCards(state: StreamState): Promise<void> {
  const entries = [...state.toolCards.entries()];
  // Only remove non-diff cards from the map
  for (const [id, card] of entries) {
    if (!card.isDiffCard) {
      state.toolCards.delete(id);
    }
  }
  await Promise.all(
    entries
      .filter(([, card]) => !card.isDiffCard)
      .map(async ([, card]) => {
        try {
          const msg = card.message ?? await card.ready;
          await msg.delete();
        } catch {
          // Already deleted or failed to send
        }
      }),
  );
}


async function clearStatus(state: StreamState): Promise<void> {
  if (state.typingInterval) {
    clearInterval(state.typingInterval);
    state.typingInterval = null;
  }
  if (state.statusMessage) {
    try {
      await state.statusMessage.delete();
    } catch {
      // Already deleted
    }
    state.statusMessage = null;
  }
  await deleteAllToolCards(state);
}

// ── Stream input helper ─────────────────────────────────────────────

/** Transform channel strings into SDKUserMessage objects for streamInput. */
async function* toSDKMessages(
  channel: AsyncChannel<string>,
  session: SessionInfo,
): AsyncGenerator<SDKUserMessage> {
  for await (const text of channel) {
    if (!session.sessionId) continue;
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: session.sessionId,
    };
  }
}

// ── Main agent runner ───────────────────────────────────────────────

/**
 * Run a Claude agent session, streaming results back to a Discord thread.
 */
export async function runAgent(
  session: SessionInfo,
  prompt: string,
  thread: ThreadChannel
): Promise<void> {
  session.busy = true;
  touchSession(session.threadId);

  // Create an async channel so queued messages can be injected mid-stream
  const inputChannel = createAsyncChannel<string>();
  session.inputChannel = inputChannel;

  const state: StreamState = {
    currentMessage: null,
    accumulatedText: "",
    lastEditTime: 0,
    editTimer: null,
    pendingEdit: null,
    statusMessage: null,
    toolCounts: {},
    toolLog: [],
    lastFinalizedText: "",
    typingInterval: null,
    imageFiles: new Set<string>(),
    toolCards: new Map(),
    partialToolInputs: new Map(),
  };

  try {
    // Send initial status
    await sendStatus(state, thread);

    const isResume = session.sessionId !== null;
    debug("agent", `Starting query: ${isResume ? `resume=${session.sessionId}` : "new session"}, model=${config.claudeModel ?? "default"}`);
    debug("agent", `Prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}"`);

    const onToolUse = (toolName: string, input: Record<string, unknown>, toolUseID: string) => {
      const detail = toolDetail(toolName, input, session.cwd);

      // Check if a card was already created from streaming events
      const existingCard = state.toolCards.get(toolUseID);
      if (existingCard) {
        // Update the existing card with the detail from the full input
        existingCard.detail = detail;
        const embed = buildToolCardEmbed(toolName, detail);
        existingCard.ready.then((msg) => {
          msg.edit({ embeds: [embed] }).catch(() => {});
        }).catch(() => {});
        debug("agent", `Updated existing tool card for ${toolName} (${toolUseID})`);
      } else {
        // Only increment counts if we didn't already count this in streaming
        state.toolCounts[toolName] = (state.toolCounts[toolName] ?? 0) + 1;
        state.toolLog.push({ name: toolName, detail });

        // Create a new tool card
        createToolCard(state, thread, toolName, detail, toolUseID);
      }

      // For Edit/Write tools, store diff data and mark as persistent diff card
      if (toolName === "Edit" || toolName === "Write") {
        const card = state.toolCards.get(toolUseID);
        if (card) {
          const filePath = (input.file_path as string) ?? "";
          let oldString = "";
          let newString = "";

          if (toolName === "Edit") {
            oldString = (input.old_string as string) ?? "";
            newString = (input.new_string as string) ?? "";
          } else {
            newString = (input.content as string) ?? "";
          }

          const linesAdded = newString ? newString.split("\n").length : 0;
          const linesRemoved = oldString ? oldString.split("\n").length : 0;

          const customId = `diff:${toolUseID}`;
          storeDiff(customId, {
            filePath,
            oldString,
            newString,
            linesAdded,
            linesRemoved,
            isNewFile: toolName === "Write",
            cwd: session.cwd,
            createdAt: Date.now(),
          });

          card.isDiffCard = true;
        }
      }

      // Track image files accessed or created by tools
      const filePath = (input.file_path ?? input.path) as string | undefined;
      if (filePath && IMAGE_EXTENSIONS.test(filePath)) {
        const resolved = isAbsolute(filePath) ? filePath : resolve(session.cwd, filePath);
        if (existsSync(resolved)) {
          state.imageFiles.add(resolved);
          debug("agent", `Tracked image file: ${resolved}`);
        }
      }

      // Update the status embed with new tool activity counts
      sendStatus(state, thread).catch(() => {});
    };

    const q = query({
      prompt,
      options: {
        ...(isResume ? { resume: session.sessionId! } : {}),
        pathToClaudeCodeExecutable: claudeCliPath,
        model: config.claudeModel,
        cwd: session.cwd,
        settingSources: ["user", "project", "local"],
        permissionMode: config.permissionMode,
        allowDangerouslySkipPermissions: config.permissionMode === "bypassPermissions",
        abortController: session.abortController,
        canUseTool: createCanUseTool(session, onToolUse, async () => {
          // Stop the typing indicator when waiting for user input
          if (state.typingInterval) {
            clearInterval(state.typingInterval);
            state.typingInterval = null;
          }
          if (state.statusMessage) {
            try { await state.statusMessage.delete(); } catch {}
            state.statusMessage = null;
          }
          await deleteAllToolCards(state);
        }),
        includePartialMessages: true,
        maxTurns: 50,
        stderr: (data: string) => {
          debug("agent", `CLI stderr: ${data.trim()}`);
        },
        env: {
          ...process.env,
          CLAUDECODE: undefined, // Prevent "nested session" detection when bot runs inside Claude Code
          ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
        },
      },
    });

    session.query = q;

    // Pipe queued messages from Discord into the SDK between turns
    q.streamInput(toSDKMessages(inputChannel, session)).catch((err) => {
      debug("agent", `streamInput ended: ${err instanceof Error ? err.message : String(err)}`);
    });

    for await (const message of q) {
      touchSession(session.threadId);
      await handleMessage(message, session, state, thread);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("abort")) {
      console.log(`[agent] Session ${session.threadId} aborted`);
    } else if (errMsg.toLowerCase().includes("prompt is too long") || errMsg.toLowerCase().includes("prompt_too_long")) {
      // Context window exceeded — reset session so the next message starts fresh
      console.error(`[agent] Context overflow in session ${session.threadId}, resetting`);
      session.sessionId = null;
      session.turnCount = 0;
      removePersistedSession(session.threadId);
      await thread.send(
        "**Context overflow — conversation too long.** Session has been reset. Your next message will start a fresh conversation."
      ).catch(() => {});
    } else {
      console.error(`[agent] Error in session ${session.threadId}:`, error);
      await thread.send(`**Error:** ${errMsg}`).catch(() => {});
    }
  } finally {
    // Clear any pending edit timer
    if (state.editTimer) clearTimeout(state.editTimer);

    // Wait for any in-flight doEdit
    if (state.pendingEdit) await state.pendingEdit.catch(() => {});

    // Finalize any remaining text
    await finalizeMessage(state, thread);

    // Clean up status message
    await clearStatus(state);

    // NOTE: session.busy intentionally remains TRUE throughout this finally
    // block to prevent a race condition where an incoming Discord message sees
    // busy=false and calls runAgent() concurrently with the queued-message
    // dispatch below.  We only set busy=false at the very end if there is
    // nothing left to process.

    // Drain any unconsumed channel items back to the front of the message queue
    inputChannel.close();
    const drained = inputChannel.drain();
    if (drained.length > 0) {
      session.messageQueue.unshift(...drained);
      debug("agent", `Drained ${drained.length} message(s) from inputChannel back to queue`);
    }
    session.inputChannel = null;
    session.query = null;

    // If "approve & clear context" was selected, reset and implement on a fresh session
    if (session.clearContextOnComplete) {
      session.clearContextOnComplete = false;
      session.sessionId = null;
      session.autoResume = false;
      session.abortController = new AbortController(); // Fresh controller for next query

      const plan = session.planToImplement;
      session.planToImplement = null;

      if (plan) {
        // Queue the plan as the prompt for a fresh session, preserving any
        // user messages that arrived while we were busy
        session.messageQueue.unshift(`Implement the following plan:\n\n${plan}`);
        debug("agent", `Cleared context and queued plan for fresh implementation in thread ${session.threadId}`);
      }
      // Note: we no longer wipe the queue — user messages sent while busy are preserved
    }

    // Auto-resume: inject a continuation prompt at the front of the queue
    if (session.autoResume) {
      session.autoResume = false;
      session.messageQueue.unshift("Continue from where you left off.");
      debug("agent", `Queued auto-resume continuation (total turns so far: ${session.turnCount})`);
    }

    // Process next queued message, if any — keep busy=true to hand off seamlessly
    const nextPrompt = session.messageQueue.shift();
    if (nextPrompt) {
      debug("agent", `Processing queued message (${session.messageQueue.length} remaining)`);
      runAgent(session, nextPrompt, thread).catch((error) => {
        console.error(`[agent] Queued message error in thread ${session.threadId}:`, error);
      });
    } else {
      // Nothing left to process — NOW it's safe to mark idle
      session.busy = false;
    }
  }
}

/** Create a tool card in Discord and register it in state. */
function createToolCard(
  state: StreamState,
  thread: ThreadChannel,
  toolName: string,
  detail: string,
  toolUseId: string,
): void {
  const embed = buildToolCardEmbed(toolName, detail);

  const card: ToolCard = {
    message: null,
    ready: null!,
    name: toolName,
    detail,
  };

  card.ready = (async (): Promise<Message> => {
    const msg = await thread.send({ embeds: [embed] });
    card.message = msg;
    return msg;
  })();

  state.toolCards.set(toolUseId, card);

  card.ready.catch((err) => {
    debug("agent", `Failed to send tool card for ${toolName}: ${err}`);
    state.toolCards.delete(toolUseId);
  });
}

async function handleMessage(
  message: SDKMessage,
  session: SessionInfo,
  state: StreamState,
  thread: ThreadChannel
): Promise<void> {
  debug("agent", `SDK message: type=${message.type}${("subtype" in message) ? `, subtype=${message.subtype}` : ""}`);

  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        setSessionId(session.threadId, message.session_id);
        console.log(`[agent] Session initialized: ${message.session_id}, model: ${message.model}`);

        // Fetch and cache available models on first init
        if (!cachedModels && session.query) {
          session.query.supportedModels().then((models) => {
            cachedModels = models;
            console.log(`[agent] Cached ${models.length} available models`);
          }).catch(() => {
            // Non-critical, ignore
          });
        }
      } else if (message.subtype === "compact_boundary") {
        const raw = message as Record<string, unknown>;
        const tokenCount = raw.pre_compaction_token_count ?? "unknown";
        debug("agent", `Context compacted (pre-compaction tokens: ${tokenCount})`);
        console.log(`[agent] Context compacted in thread ${session.threadId} (pre-compaction tokens: ${tokenCount})`);

        // Brief indicator in Discord
        const notice = await thread.send("*Context compacted — conversation summarized to fit context window*");
        setTimeout(() => { notice.delete().catch(() => {}); }, 8_000);
      }
      break;
    }

    case "stream_event": {
      const event = message.event as StreamEvent;

      if (event.type === "content_block_start") {
        const cb = event.content_block as { type: string; id?: string; name?: string } | undefined;
        if (cb?.type === "tool_use" && cb.id && cb.name) {
          debug("agent", `Streaming tool_use start: ${cb.name} (${cb.id})`);
          const idx = event.index ?? -1;

          // Track partial input for this content block
          state.partialToolInputs.set(idx, {
            toolUseId: cb.id,
            name: cb.name,
            json: "",
          });

          // Create a tool card immediately (will be updated with detail later)
          if (!state.toolCards.has(cb.id)) {
            state.toolCounts[cb.name] = (state.toolCounts[cb.name] ?? 0) + 1;
            state.toolLog.push({ name: cb.name, detail: "" });
            createToolCard(state, thread, cb.name, "", cb.id);
            sendStatus(state, thread).catch(() => {});
          }
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta && "text" in delta && typeof delta.text === "string") {
          state.accumulatedText += delta.text;
          scheduleEdit(state, thread);
        }
        // Accumulate tool input JSON
        if (delta && "partial_json" in delta && typeof delta.partial_json === "string") {
          const idx = event.index ?? -1;
          const partial = state.partialToolInputs.get(idx);
          if (partial) {
            partial.json += delta.partial_json;
          }
        }
      } else if (event.type === "content_block_stop") {
        const idx = event.index ?? -1;
        const partial = state.partialToolInputs.get(idx);
        if (partial) {
          state.partialToolInputs.delete(idx);
          // Parse the accumulated input and update the card with detail
          try {
            const input = JSON.parse(partial.json || "{}") as Record<string, unknown>;
            const detail = toolDetail(partial.name, input, session.cwd);
            const card = state.toolCards.get(partial.toolUseId);
            if (card && detail) {
              card.detail = detail;
              const embed = buildToolCardEmbed(card.name, detail);
              card.ready.then((msg) => {
                msg.edit({ embeds: [embed] }).catch(() => {});
              }).catch(() => {});
            }

            // Store diff data for Edit/Write tools from streaming events.
            // In bypassPermissions mode canUseTool may be skipped, so this
            // ensures diff cards are created regardless of permission mode.
            if ((partial.name === "Edit" || partial.name === "Write") && card) {
              const filePath = (input.file_path as string) ?? "";
              let oldString = "";
              let newString = "";

              if (partial.name === "Edit") {
                oldString = (input.old_string as string) ?? "";
                newString = (input.new_string as string) ?? "";
              } else {
                newString = (input.content as string) ?? "";
              }

              const linesAdded = newString ? newString.split("\n").length : 0;
              const linesRemoved = oldString ? oldString.split("\n").length : 0;

              const customId = `diff:${partial.toolUseId}`;
              storeDiff(customId, {
                filePath,
                oldString,
                newString,
                linesAdded,
                linesRemoved,
                isNewFile: partial.name === "Write",
                cwd: session.cwd,
                createdAt: Date.now(),
              });

              card.isDiffCard = true;
              debug("agent", `Stored diff from streaming for ${partial.name}: ${filePath}`);
            }
          } catch {
            // JSON parse failed — keep card without detail
          }
        }
      }
      break;
    }

    case "assistant": {
      // Full assistant message — extract final text + scan tool_use blocks for image paths
      debug("agent", `Assistant turn: ${message.message.content.length} content blocks, role=${message.message.role}`);
      const content = message.message.content;
      let text = "";
      for (const block of content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          // Track image file paths from tool inputs (works even in bypassPermissions mode)
          const input = block.input as Record<string, unknown> | undefined;
          if (input) {
            const filePath = (input.file_path ?? input.path) as string | undefined;
            if (filePath && IMAGE_EXTENSIONS.test(filePath)) {
              const resolved = isAbsolute(filePath) ? filePath : resolve(session.cwd, filePath);
              if (existsSync(resolved)) {
                state.imageFiles.add(resolved);
                debug("agent", `Tracked image from tool_use (${block.name}): ${resolved}`);
              }
            }
          }
        }
      }

      if (text && text !== state.accumulatedText && text !== state.lastFinalizedText) {
        state.accumulatedText = text;
      }

      // Wait for any in-flight doEdit before finalizing
      if (state.pendingEdit) {
        await state.pendingEdit.catch(() => {});
      }

      // Finalize the current message (send text to Discord)
      await finalizeMessage(state, thread);

      // Only send image attachments when the message has text (i.e., it's a response,
      // not just an intermediate tool invocation). Tracked images accumulate across
      // tool_use-only messages and get sent with the next text response.
      if (text) {
        const textAttachments = extractAttachments(text, session.cwd);
        const toolAttachments = attachmentsFromPaths(state.imageFiles);
        state.imageFiles.clear();

        // Dedupe by filename
        const seen = new Set(textAttachments.map((a) => a.name));
        const allAttachments = [...textAttachments];
        for (const a of toolAttachments) {
          if (!seen.has(a.name)) {
            allAttachments.push(a);
            seen.add(a.name);
          }
        }

        if (allAttachments.length > 0) {
          await thread.send({ files: allAttachments });
        }
      }
      break;
    }

    case "tool_progress": {
      let card = state.toolCards.get(message.tool_use_id);

      // Fallback: create card if it doesn't exist yet (e.g., bypass mode skipped canUseTool)
      if (!card && message.tool_name) {
        debug("agent", `Creating fallback tool card from tool_progress: ${message.tool_name} (${message.tool_use_id})`);
        state.toolCounts[message.tool_name] = (state.toolCounts[message.tool_name] ?? 0) + 1;
        state.toolLog.push({ name: message.tool_name, detail: "" });
        createToolCard(state, thread, message.tool_name, "", message.tool_use_id);
        sendStatus(state, thread).catch(() => {});
        card = state.toolCards.get(message.tool_use_id);
      }

      // Update the matching tool card with elapsed time
      if (card) {
        const embed = buildToolCardEmbed(
          card.name,
          card.detail,
          undefined,
          message.elapsed_time_seconds,
        );
        card.ready.then((msg) => {
          msg.edit({ embeds: [embed] }).catch(() => {});
        }).catch(() => {});
      }
      break;
    }

    case "user": {
      // Extract tool_result blocks from message content to update matching tool cards
      if ("message" in message && message.message?.content) {
        const content = message.message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const block of blocks) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_result" &&
            "tool_use_id" in block &&
            typeof block.tool_use_id === "string"
          ) {
            const toolUseId = block.tool_use_id as string;
            const card = state.toolCards.get(toolUseId);
            if (!card) continue;

            const isError = "is_error" in block && block.is_error === true;

            // Handle diff cards (Edit/Write) — replace with persistent diff card
            if (card.isDiffCard && !isError) {
              state.toolCards.delete(toolUseId);
              const customId = `diff:${toolUseId}`;
              const diffEntry = getDiff(customId);
              if (diffEntry) {
                const diffEmbed = buildDiffCardEmbed({
                  filePath: diffEntry.filePath,
                  linesAdded: diffEntry.linesAdded,
                  linesRemoved: diffEntry.linesRemoved,
                  isNewFile: card.name === "Write",
                  cwd: session.cwd,
                });
                const row = buildShowDiffButton(customId);
                card.ready.then((msg) => {
                  msg.edit({ embeds: [diffEmbed], components: [row] }).catch(() => {});
                }).catch(() => {});
              }
              continue;
            }

            // Extract text from the tool result
            let resultText = "";
            if ("content" in block) {
              if (typeof block.content === "string") {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");
              }
            }

            // Update the card with the result — keep it visible until
            // the next text response triggers clearStatus / deleteAllToolCards
            if (resultText) {
              const embed = buildToolCardEmbed(
                card.name,
                card.detail,
                resultText,
                undefined,
                true,
              );
              card.ready.then((msg) => {
                msg.edit({ embeds: [embed] }).catch(() => {});
              }).catch(() => {});
            } else {
              // No output — mark as done (green check) but keep visible
              const embed = buildToolCardEmbed(
                card.name,
                card.detail,
                undefined,
                undefined,
                true,
              );
              card.ready.then((msg) => {
                msg.edit({ embeds: [embed] }).catch(() => {});
              }).catch(() => {});
            }
          }
        }
      }
      break;
    }

    case "result": {
      if (message.subtype === "success") {
        addCost(session.threadId, message.total_cost_usd);
        session.turnCount = 0;
        console.log(
          `[agent] Session completed: turns=${message.num_turns}, cost=$${message.total_cost_usd.toFixed(4)}, session total=$${session.totalCost.toFixed(4)}`
        );
      } else if (message.subtype === "error_max_turns") {
        addCost(session.threadId, message.total_cost_usd);
        session.turnCount += message.num_turns;

        if (session.turnCount >= config.maxTotalTurns) {
          console.error(`[agent] Reached maximum total turn limit (${config.maxTotalTurns}) in thread ${session.threadId}`);
          await thread.send(`**Reached maximum turn limit (${config.maxTotalTurns} turns).** Session stopped.`);
          session.turnCount = 0;
        } else {
          debug("agent", `Auto-resuming after max turns (${session.turnCount}/${config.maxTotalTurns} total turns)`);
          session.autoResume = true;
        }
      } else {
        const errors = "errors" in message ? message.errors.join(", ") : "Unknown error";
        console.error(`[agent] Session error (${message.subtype}): ${errors}`);

        // If the session ID is stale (server doesn't recognize it), clear it
        // so the next message starts a fresh session instead of failing again.
        if (errors.includes("No conversation found")) {
          session.sessionId = null;
          removePersistedSession(session.threadId);
          await thread.send("**Session expired.** Your next message will start a fresh conversation.");
        } else if (errors.toLowerCase().includes("prompt is too long") || errors.toLowerCase().includes("prompt_too_long")) {
          session.sessionId = null;
          session.turnCount = 0;
          removePersistedSession(session.threadId);
          await thread.send(
            "**Context overflow — conversation too long.** Session has been reset. Your next message will start a fresh conversation."
          );
        } else {
          await thread.send(`**Session ended with error:** ${errors}`);
        }
      }
      break;
    }

    default:
      break;
  }
}

/** Schedule a rate-limited edit to the current Discord message. */
function scheduleEdit(state: StreamState, thread: ThreadChannel): void {
  if (state.editTimer) return; // Already scheduled
  if (state.pendingEdit) return; // doEdit is already in-flight — wait for it to finish

  const elapsed = Date.now() - state.lastEditTime;
  const delay = Math.max(0, config.editRateMs - elapsed);

  state.editTimer = setTimeout(() => {
    state.editTimer = null;
    const p = doEdit(state, thread).catch((err) => {
      console.error("[agent] doEdit error:", err);
    });
    state.pendingEdit = p;
    p.finally(() => {
      if (state.pendingEdit === p) {
        state.pendingEdit = null;
        // If text accumulated while doEdit was in-flight, schedule another edit
        if (state.accumulatedText) {
          scheduleEdit(state, thread);
        }
      }
    });
  }, delay);
}

/** Check if a Discord API error indicates the message was deleted (error 10008). */
function isMessageDeleted(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  return (
    ("code" in err && (err as { code: unknown }).code === 10008) ||
    ("status" in err && (err as { status: unknown }).status === 404)
  );
}

/** Perform the actual message edit with accumulated text. */
async function doEdit(state: StreamState, thread: ThreadChannel): Promise<void> {
  if (!state.accumulatedText) return;

  state.lastEditTime = Date.now();
  const text = wrapTablesInCodeBlocks(state.accumulatedText);
  const chunks = splitMessageSimple(text);

  if (!state.currentMessage) {
    // First text — delete status + tool card and send a new message
    await clearStatus(state);
    state.currentMessage = await thread.send(chunks[0]!);
    return;
  }

  // Edit existing message with first chunk (overflow handled on finalize)
  try {
    await state.currentMessage.edit(chunks[0]!);
  } catch (err: unknown) {
    if (isMessageDeleted(err)) {
      // Message was deleted — clear the reference so finalizeMessage sends a
      // fresh message instead of editing a ghost.
      debug("agent", "doEdit: message was deleted, clearing reference");
      state.currentMessage = null;
    }
    // For transient errors (rate limits etc.), keep the reference — the message
    // still exists and the next edit or finalizeMessage will retry.
  }
}

/** Finalize: send all accumulated text, properly split. */
async function finalizeMessage(
  state: StreamState,
  thread: ThreadChannel
): Promise<void> {
  if (state.editTimer) {
    clearTimeout(state.editTimer);
    state.editTimer = null;
  }

  if (!state.accumulatedText) {
    state.currentMessage = null;
    return;
  }

  const chunks = splitMessageSimple(wrapTablesInCodeBlocks(state.accumulatedText));

  if (state.currentMessage && chunks[0]) {
    // Edit existing message with the final first chunk
    try {
      await state.currentMessage.edit(chunks[0]);
    } catch (err: unknown) {
      // Only send a replacement if the original was actually deleted. For
      // transient errors (rate limits, network hiccups), the existing message
      // still has close-to-final content from a previous doEdit — sending a
      // new one would create a visible duplicate.
      if (isMessageDeleted(err)) {
        debug("agent", "finalizeMessage: message was deleted, sending replacement");
        await clearStatus(state);
        state.currentMessage = await thread.send(chunks[0]);
      } else {
        debug("agent", "finalizeMessage: edit failed (transient), keeping existing message to avoid duplicate");
      }
    }
  } else if (chunks[0]) {
    // No message sent yet — send the first chunk now
    await clearStatus(state);
    state.currentMessage = await thread.send(chunks[0]);
  }

  // Send remaining chunks as new messages
  for (let i = 1; i < chunks.length; i++) {
    await thread.send(chunks[i]!);
  }

  // Reset state for next assistant message
  state.lastFinalizedText = state.accumulatedText;
  state.currentMessage = null;
  state.accumulatedText = "";
  state.lastEditTime = 0;

  // Send a fresh status message for the next turn (if session continues)
  state.toolCounts = {};
  state.toolLog = [];
  await sendStatus(state, thread);
}

// Stream event types for the Anthropic API (used internally, not exported by SDK)
interface StreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    [key: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
