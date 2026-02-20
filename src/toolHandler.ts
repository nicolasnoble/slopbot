import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { EmbedBuilder } from "discord.js";
import type { SessionInfo, AskUserQuestionItem, PlanApprovalResult } from "./types.js";
import { debug } from "./debug.js";
import { buildFlatOptions, renderQuestionEmbed } from "./questionRenderer.js";
import { splitMessageSimple, wrapTablesInCodeBlocks } from "./messageSplitter.js";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Create a canUseTool callback for a given session.
 * Handles AskUserQuestion by rendering an embed and waiting for user reply.
 * Handles ExitPlanMode by showing the plan and waiting for approval.
 * Auto-allows everything else.
 */
export function createCanUseTool(
  session: SessionInfo,
  onToolUse?: (toolName: string, input: Record<string, unknown>, toolUseID: string) => void,
  pauseTyping?: () => Promise<void>,
): CanUseTool {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options
  ): Promise<PermissionResult> => {
    debug("tool", `canUseTool called: ${toolName} (toolUseID=${options.toolUseID}, agentID=${options.agentID ?? "main"})`);

    if (toolName === "AskUserQuestion") {
      await pauseTyping?.();
      return handleAskUserQuestion(session, input);
    }

    if (toolName === "ExitPlanMode") {
      await pauseTyping?.();
      return handleExitPlanMode(session, input);
    }

    // Notify caller about tool usage (for status display + image tracking)
    onToolUse?.(toolName, input, options.toolUseID);

    // Random delay before auto-accepting to avoid overwhelming the SDK transport
    if (config.toolAcceptDelayMs > 0) {
      const delay = Math.floor(Math.random() * config.toolAcceptDelayMs);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }

    // Auto-allow all other tools
    debug("tool", `Auto-allowing: ${toolName} (agentID=${options.agentID ?? "main"})`);
    return { behavior: "allow", updatedInput: input };
  };
}

async function handleAskUserQuestion(
  session: SessionInfo,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  const questions = input["questions"] as AskUserQuestionItem[] | undefined;
  if (!questions || questions.length === 0) {
    return { behavior: "allow", updatedInput: input };
  }

  // Background tasks: auto-select first option for each question
  if (session.isBackground) {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.header] = q.options[0]?.label ?? "";
    }
    const bgTag = session.bgTaskId != null ? `**[bg #${session.bgTaskId}]** ` : "";
    const picked = questions.map((q) => `${q.header}: ${q.options[0]?.label ?? "?"}`).join(", ");
    await session.thread.send(`${bgTag}Auto-selected defaults: ${picked}`).catch(() => {});
    debug("tool", `AskUserQuestion (background): auto-selected defaults: ${JSON.stringify(answers)}`);
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  debug("tool", `AskUserQuestion: ${questions.length} question(s), headers=[${questions.map(q => q.header).join(", ")}]`);

  // Build flat option mapping and initialize interactive state
  const flatOptions = buildFlatOptions(questions);
  const selections = new Map<number, Set<number>>();
  const otherText = new Map<number, string>();
  for (let qi = 0; qi < questions.length; qi++) {
    selections.set(qi, new Set());
  }

  // Render the initial embed (nothing selected) and capture the message
  const embed = renderQuestionEmbed(questions, flatOptions, selections, otherText, null);
  const embedMessage = await session.thread.send({ embeds: [embed] });

  // Create a promise that will be resolved when the user submits
  debug("tool", "Waiting for user reply (interactive mode)...");
  const answers = await new Promise<Record<string, string>>((resolve) => {
    session.pendingQuestion = {
      questions,
      resolve,
      embedMessage,
      selections,
      otherText,
      awaitingOtherForQuestion: null,
      flatOptions,
    };
  });

  // Clear the pending question
  session.pendingQuestion = null;

  debug("tool", `AskUserQuestion resolved: ${JSON.stringify(answers)}`);

  // Return the answers as updated input
  return {
    behavior: "allow",
    updatedInput: { ...input, answers },
  };
}

async function handleExitPlanMode(
  session: SessionInfo,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  debug("tool", "ExitPlanMode called — looking for plan file");

  // Background tasks: auto-approve the plan
  if (session.isBackground) {
    const bgTag = session.bgTaskId != null ? `**[bg #${session.bgTaskId}]** ` : "";
    await session.thread.send(`${bgTag}Auto-approved plan.`).catch(() => {});
    debug("tool", "ExitPlanMode (background): auto-approved");
    return { behavior: "allow", updatedInput: input };
  }

  // Find and read the most recent plan file
  const planContent = findLatestPlan();

  if (planContent) {
    // Send the plan content to Discord, split if needed
    const chunks = splitMessageSimple(wrapTablesInCodeBlocks(planContent));
    for (const chunk of chunks) {
      await session.thread.send(chunk);
    }
  } else {
    debug("tool", `No plan file found in ${config.claudeConfigDir}/plans/`);
  }

  // Send approval prompt
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Plan Review")
    .setDescription(
      planContent
        ? "Review the plan above. Reply to approve or reject."
        : "Claude wants to proceed with its plan. Reply to approve or reject."
    )
    .addFields({
      name: "Options",
      value: [
        "**1.** Approve & clear context — approve, then start fresh",
        "**2.** Approve — proceed with full context",
        "**3.** Reject — ask Claude to revise",
        "Or type feedback to send back to Claude",
      ].join("\n"),
    })
    .setFooter({
      text: 'Reply "1"/"clear", "2"/"approve", "3"/"reject", or type feedback.',
    });

  await session.thread.send({ embeds: [embed] });

  // Wait for user reply
  debug("tool", "Waiting for plan approval...");
  const result = await new Promise<PlanApprovalResult>((resolve) => {
    session.pendingPlanApproval = { resolve };
  });

  session.pendingPlanApproval = null;

  if (result.approved) {
    if (result.clearContext) {
      debug("tool", "Plan approved with clear context — aborting current query, will start fresh session");
      session.clearContextOnComplete = true;
      session.planToImplement = planContent;
      // Abort the current query so Claude doesn't implement with stale context.
      // The finally block in runAgent will clear the session and queue the plan
      // for implementation on a fresh session.
      // Defer the abort so the SDK can finish writing the permission response
      // before the transport is torn down (otherwise transport.write() throws
      // "Operation aborted" because the abort controller is already signaled).
      setTimeout(() => session.abortController.abort(), 0);
      return { behavior: "allow", updatedInput: input };
    } else {
      debug("tool", "Plan approved by user");
    }
    // Pass through the original input (preserves allowedPrompts for the SDK)
    return { behavior: "allow", updatedInput: input };
  } else {
    const message = result.feedback
      ? `The user rejected the plan with feedback: ${result.feedback}`
      : "The user rejected the plan. Please revise.";
    debug("tool", `Plan rejected: ${message}`);
    return { behavior: "deny", message };
  }
}

/**
 * Find and read the most recently modified plan file from the Claude config plans directory.
 * Returns the file content or null if no plan files exist.
 */
function findLatestPlan(): string | null {
  const plansDir = join(config.claudeConfigDir, "plans");
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fullPath = join(plansDir, f);
        const stat = statSync(fullPath);
        return { path: fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    // Only consider files modified in the last 5 minutes (likely from this session)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recent = files[0]!;
    if (recent.mtime < fiveMinutesAgo) {
      debug("tool", `Latest plan file is ${Math.round((Date.now() - recent.mtime) / 1000)}s old, skipping`);
      return null;
    }

    const content = readFileSync(recent.path, "utf-8");
    debug("tool", `Read plan file: ${recent.path} (${content.length} chars)`);
    return content;
  } catch (err) {
    debug("tool", `Error reading plan files: ${err}`);
    return null;
  }
}
