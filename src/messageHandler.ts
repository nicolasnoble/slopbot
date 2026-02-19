import {
  type Message,
  type TextChannel,
  type ThreadChannel,
  ChannelType,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { config } from "./config.js";
import type { SessionInfo } from "./types.js";
import {
  createSession,
  getSession,
  resetSession,
  touchSession,
} from "./sessionManager.js";
import { getPersistedSessionId, getPersistedCwd, getPersistedCost, getTotalCost } from "./sessionStore.js";
import { runAgent, getCachedModels } from "./agentRunner.js";
import { debug } from "./debug.js";
import { parsePlanApproval } from "./planApprovalParser.js";
import { downloadDiscordAttachments } from "./attachments.js";
import { renderQuestionEmbed } from "./questionRenderer.js";
import { fetchUsage, formatUsageMessage, computeProjections } from "./usageTracker.js";
import type { PendingQuestion } from "./types.js";

/** Build a visual progress bar for context usage. */
function buildProgressBar(ratio: number): string {
  const filled = Math.round(ratio * 20);
  const empty = 20 - filled;
  const warning = ratio >= 0.8 ? " \u26a0\ufe0f" : "";
  return `\`[${"=".repeat(filled)}${" ".repeat(empty)}]\`${warning}`;
}

/**
 * Handle incoming Discord messages.
 * Routes to the appropriate handler based on context.
 */
export async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  debug("handler", `Incoming message from ${message.author.tag} in ${message.channel.type} channel: "${message.content.slice(0, 80)}"`);

  // Case 1: Message in a thread — could be a follow-up or question answer
  if (
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread
  ) {
    debug("handler", `Routing to thread handler (thread ${message.channel.id})`);
    await handleThreadMessage(message);
    return;
  }

  // Case 2: Message in a watched channel — start a new session
  if (message.channel.type === ChannelType.GuildText) {
    const cwd = config.channels.get(message.channel.name);
    if (cwd) {
      debug("handler", `Routing to new session handler (channel: ${message.channel.name}, cwd: ${cwd})`);
      await handleNewMessage(message, cwd);
      return;
    }
  }

  debug("handler", `Ignoring message in unrelated channel: ${message.channel.type}`);
}

/** Download any attachments and build the prompt with file info appended. */
async function buildPrompt(message: Message, cwd: string): Promise<string> {
  const saved = await downloadDiscordAttachments([...message.attachments.values()], cwd);
  let prompt = message.content;
  if (saved.length > 0) {
    const fileList = saved.map((f) => `Discord/${f}`).join(", ");
    prompt += `\n\n[Attached files saved to: ${fileList}]`;
  }
  return prompt;
}

/** Handle a new message in the watched channel: create thread + session. */
async function handleNewMessage(message: Message, cwd: string): Promise<void> {
  // Intercept !commands before creating a thread
  if (await handleCommand(message, null)) return;

  const channel = message.channel as TextChannel;

  // Create a thread from the message
  const threadName = message.content.slice(0, 95) || "Claude session";
  const thread = await channel.threads.create({
    name: threadName,
    startMessage: message,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  });

  console.log(
    `[handler] New session thread: ${thread.id} for "${threadName}"`
  );

  // Create a session and run the agent
  const session = createSession(thread.id, thread, cwd);
  const prompt = await buildPrompt(message, cwd);

  // Run agent in the background (don't await — we want to keep processing messages)
  runAgent(session, prompt, thread).catch((error) => {
    console.error(`[handler] Agent error in thread ${thread.id}:`, error);
  });
}

/** Try to handle a !command. Session is null when called from the main channel. */
async function handleCommand(message: Message, session: SessionInfo | null): Promise<boolean> {
  const text = message.content.trim();
  if (!text.startsWith("!")) return false;

  const [cmd, ...args] = text.slice(1).split(/\s+/);
  const command = cmd?.toLowerCase();

  switch (command) {
    case "clear": {
      if (!session) { await message.reply("Use this command inside a thread."); return true; }
      resetSession(session.threadId);
      await message.reply("Session cleared. Your next message will start a fresh conversation.");
      return true;
    }

    case "abort": {
      if (!session) { await message.reply("Use this command inside a thread."); return true; }
      if (!session.busy) {
        await message.reply("Nothing is running.");
        return true;
      }
      session.abortController.abort();
      if (session.inputChannel) {
        session.inputChannel.close();
        // Don't null out inputChannel — the finally block in runAgent will
        // drain it and handle cleanup.
      }
      if (session.query) {
        session.query.close();
        // Don't null out query — the finally block handles it.
      }
      // Clear the queue so the finally block doesn't process queued messages
      // after the user explicitly aborted.
      session.messageQueue = [];
      session.autoResume = false;
      // Don't set session.busy = false here — the finally block in runAgent
      // will set it after cleanup, preventing a race condition.
      session.pendingQuestion = null;
      session.pendingPlanApproval = null;
      session.abortController = new AbortController();
      await message.reply("Aborted the current response.");
      return true;
    }

    case "model": {
      const modelName = args.join(" ");
      if (!modelName) {
        const current = config.claudeModel ?? "default";
        const models = getCachedModels();
        const lines = [`**Current model:** \`${current}\``];
        if (models && models.length > 0) {
          lines.push("", "**Available models:**");
          for (const m of models) {
            const isActive = m.value === current;
            const marker = isActive ? " ✅" : "";
            const desc = m.description ? ` — *${m.description}*` : "";
            lines.push(`- \`${m.value}\` — ${m.displayName}${desc}${marker}`);
          }
        }
        lines.push("", "Usage: `!model <name>`");
        await message.reply(lines.join("\n"));
        return true;
      }
      config.claudeModel = modelName;
      await message.reply(`Model switched to \`${modelName}\` for new queries.`);
      return true;
    }

    case "cost": {
      const totalCost = getTotalCost();
      const lines = [];
      if (session) lines.push(`**This session:** $${session.totalCost.toFixed(4)}`);
      lines.push(`**All sessions:** $${totalCost.toFixed(4)}`);
      await message.reply(lines.join("\n"));
      return true;
    }

    case "context": {
      if (!session) { await message.reply("Use this command inside a thread."); return true; }
      if (session.contextWindow === 0) {
        await message.reply("No context data yet - send a message first.");
        return true;
      }
      const pct = ((session.contextTokens / session.contextWindow) * 100).toFixed(1);
      const tokensK = (session.contextTokens / 1000).toFixed(1);
      const windowK = (session.contextWindow / 1000).toFixed(0);
      const bar = buildProgressBar(session.contextTokens / session.contextWindow);
      await message.reply(
        `**Context:** ${tokensK}k / ${windowK}k tokens (${pct}%)\n${bar}`
      );
      return true;
    }

    case "usage": {
      try {
        const data = await fetchUsage();
        const projections = computeProjections(data);
        await message.reply(formatUsageMessage(data, projections));
      } catch (err) {
        await message.reply(`Failed to fetch usage: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case "help": {
      await message.reply(
        [
          "**Commands:**",
          "`!clear` — Reset session, start fresh in this thread",
          "`!abort` — Stop the current response",
          "`!model <name>` — Switch Claude model (e.g. `!model claude-sonnet-4-5-20250929`)",
          "`!cost` — Show session and total API costs",
          "`!context` — Show context window usage for this session",
          "`!usage` — Show Claude account usage limits",
          "`!help` — Show this message",
        ].join("\n")
      );
      return true;
    }

    default:
      return false;
  }
}

/** Handle a message in an existing thread. */
async function handleThreadMessage(message: Message): Promise<void> {
  const threadId = message.channel.id;
  let session = getSession(threadId);

  // Try to restore a persisted session after a bot restart
  if (!session) {
    const persistedId = getPersistedSessionId(threadId);
    if (!persistedId) {
      await message.reply("Session not found — it may have been lost in a crash. Please start a new conversation in the channel.");
      return;
    }

    const cwd = getPersistedCwd(threadId);
    if (!cwd) {
      await message.reply("Session found but working directory is unknown. Please start a new conversation in the channel.");
      return;
    }

    const thread = message.channel as ThreadChannel;
    session = createSession(threadId, thread, cwd);
    session.sessionId = persistedId;
    session.totalCost = getPersistedCost(threadId);
    console.log(`[handler] Restored persisted session for thread ${threadId} (cwd: ${cwd})`);
  }

  touchSession(threadId);

  // Check for !commands first
  if (await handleCommand(message, session)) return;

  // Case A1: There's a pending plan approval — treat this as an approval/rejection
  if (session.pendingPlanApproval) {
    const result = parsePlanApproval(message.content);
    debug("handler", `Parsed plan approval: approved=${result.approved}, clearContext=${result.clearContext ?? false}, feedback=${result.feedback ?? "none"}`);
    // Only delete simple option selections (1/2/3, approve, reject, etc.)
    // Keep freeform feedback visible so the conversation history makes sense
    if (!result.feedback) {
      tryDeleteMessage(message);
    }
    session.pendingPlanApproval.resolve(result);
    return;
  }

  // Case A2: There's a pending question — interactive toggle/submit flow
  if (session.pendingQuestion) {
    await handleInteractiveQuestion(session.pendingQuestion, message);
    return;
  }

  // Case B: Session is busy — inject via streamInput channel if available, else queue
  if (session.busy) {
    const prompt = await buildPrompt(message, session.cwd);
    if (session.inputChannel && !session.inputChannel.closed) {
      session.inputChannel.push(prompt);
      debug("handler", `Injected message via inputChannel in thread ${threadId}`);
    } else {
      session.messageQueue.push(prompt);
      debug("handler", `Queued message in thread ${threadId} (queue size: ${session.messageQueue.length})`);
    }
    return;
  }

  // Case C: Session is idle — send follow-up message (resume session)
  debug("handler", `Follow-up in thread ${threadId}, sessionId=${session.sessionId}, busy=${session.busy}`);
  if (!session.sessionId) {
    await message.reply("Session expired. Please start a new conversation in the channel.");
    return;
  }

  const prompt = await buildPrompt(message, session.cwd);

  runAgent(session, prompt, message.channel as any).catch(
    (error) => {
      console.error(
        `[handler] Follow-up agent error in thread ${threadId}:`,
        error
      );
    }
  );
}

/** Handle interactive question toggle/submit flow. */
async function handleInteractiveQuestion(pq: PendingQuestion, message: Message): Promise<void> {
  const text = message.content.trim();

  // State: awaiting freeform text for an "Other" option
  if (pq.awaitingOtherForQuestion !== null) {
    const qi = pq.awaitingOtherForQuestion;
    pq.otherText.set(qi, text);
    pq.awaitingOtherForQuestion = null;
    debug("handler", `Stored Other text for question ${qi}: "${text}"`);
    // Don't delete — freeform answers provide useful context in the thread
    await updateQuestionEmbed(pq);
    return;
  }

  // "submit" / "done" / "confirm" — finalize
  if (/^(submit|done|confirm)$/i.test(text)) {
    const answers = buildAnswersFromSelections(pq);
    debug("handler", `Interactive submit: ${JSON.stringify(answers)}`);
    tryDeleteMessage(message);
    pq.resolve(answers);
    return;
  }

  // "Number + freeform text" shorthand for Other — e.g. "3 my custom answer"
  const otherShorthand = text.match(/^(\d+)\s+(.+)$/s);
  if (otherShorthand) {
    const num = parseInt(otherShorthand[1]!, 10);
    const freeform = otherShorthand[2]!.trim();
    const opt = pq.flatOptions.find((o) => o.globalIndex === num);

    if (opt?.isOther) {
      const qi = opt.questionIndex;
      const q = pq.questions[qi]!;
      const selected = pq.selections.get(qi) ?? new Set<number>();

      if (!q.multiSelect) {
        selected.clear();
        pq.otherText.delete(qi);
      }
      selected.add(num);
      pq.selections.set(qi, selected);
      pq.otherText.set(qi, freeform);

      debug("handler", `Other shorthand: option ${num}, text="${freeform}"`);
      await updateQuestionEmbed(pq);
      return;
    }
  }

  // Numeric input — toggle selections
  const numberPattern = /^[\d,\s]+$/;
  if (numberPattern.test(text)) {
    const nums = text
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));

    for (const num of nums) {
      const opt = pq.flatOptions.find((o) => o.globalIndex === num);
      if (!opt) continue;

      const qi = opt.questionIndex;
      const selected = pq.selections.get(qi) ?? new Set<number>();
      const q = pq.questions[qi]!;

      if (opt.isOther) {
        // Toggle Other: if already selected, deselect; otherwise select and prompt for text
        if (selected.has(num)) {
          selected.delete(num);
          pq.otherText.delete(qi);
        } else {
          if (!q.multiSelect) selected.clear();
          selected.add(num);
          pq.awaitingOtherForQuestion = qi;
        }
      } else {
        if (selected.has(num)) {
          selected.delete(num);
        } else {
          if (!q.multiSelect) {
            // Radio: clear previous selection (and any Other text)
            selected.clear();
            pq.otherText.delete(qi);
          }
          selected.add(num);
        }
      }

      pq.selections.set(qi, selected);
    }

    debug("handler", `Toggled selections: ${JSON.stringify([...pq.selections.entries()].map(([k, v]) => [k, [...v]]))}`);
    tryDeleteMessage(message);
    await updateQuestionEmbed(pq);
    return;
  }

  // Anything else — send ephemeral hint
  debug("handler", `Unrecognized input during interactive question: "${text.slice(0, 40)}"`);
  const hasOther = pq.flatOptions.some((o) => o.isOther);
  const hint = [
    "Didn't understand that input.",
    "Type a **number** to toggle an option" + (hasOther ? " (e.g. `3 your answer` for Other)" : "") + ",",
    'or **"submit"** to confirm.',
  ].join(" ");
  const reply = await message.reply(hint);
  setTimeout(() => reply.delete().catch(() => {}), 8_000);
}

/** Re-render the question embed in-place. */
async function updateQuestionEmbed(pq: PendingQuestion): Promise<void> {
  if (!pq.embedMessage) return;
  try {
    const embed = renderQuestionEmbed(
      pq.questions,
      pq.flatOptions,
      pq.selections,
      pq.otherText,
      pq.awaitingOtherForQuestion,
    );
    await pq.embedMessage.edit({ embeds: [embed] });
  } catch (err) {
    debug("handler", `Failed to edit question embed: ${err}`);
  }
}

/** Build final answers from current interactive selections. */
function buildAnswersFromSelections(pq: PendingQuestion): Record<string, string> {
  const answers: Record<string, string> = {};

  for (let qi = 0; qi < pq.questions.length; qi++) {
    const q = pq.questions[qi]!;
    const selected = pq.selections.get(qi) ?? new Set<number>();
    const labels: string[] = [];

    for (const globalIdx of selected) {
      const opt = pq.flatOptions.find((o) => o.globalIndex === globalIdx);
      if (!opt) continue;
      if (opt.isOther) {
        const text = pq.otherText.get(qi);
        if (text) labels.push(text);
      } else {
        labels.push(opt.label);
      }
    }

    if (labels.length > 0) {
      answers[q.header] = labels.join(", ");
    } else {
      // Default to first option if nothing selected
      answers[q.header] = q.options[0]?.label ?? "";
    }
  }

  return answers;
}

/** Best-effort delete a user message to keep the thread clean. */
function tryDeleteMessage(message: Message): void {
  message.delete().catch(() => {});
}
