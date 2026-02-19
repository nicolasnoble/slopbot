import { EmbedBuilder, type ThreadChannel } from "discord.js";
import type { SessionInfo, DiagnosticHooks } from "./types.js";
import { runAgent } from "./agentRunner.js";
import { removePersistedSession } from "./sessionStore.js";
import { debug } from "./debug.js";

/** Recorded event from a tool result during the stress test. */
interface ToolEvent {
  index: number;
  toolName: string;
  toolUseId: string;
  isError: boolean;
  contentSnippet: string;
  timestamp: number;
}

/** Summary of the stress test results. */
interface StressResults {
  totalTools: number;
  succeeded: number;
  failed: number;
  events: ToolEvent[];
  stderrLines: string[];
  startTime: number;
  endTime: number;
}

// Files to read during the stress test - all small project source files
const TARGET_FILES = [
  "src/debug.ts",
  "src/config.ts",
  "src/types.ts",
  "src/replyParser.ts",
  "src/planApprovalParser.ts",
  "src/asyncChannel.ts",
  "src/questionRenderer.ts",
  "src/diffCard.ts",
  "src/diffStore.ts",
  "src/diffInteraction.ts",
  "src/attachments.ts",
  "src/messageSplitter.ts",
  "src/sessionStore.ts",
  "src/sessionManager.ts",
  "src/usageTracker.ts",
  "src/usageMonitor.ts",
  "src/toolHandler.ts",
  "src/messageHandler.ts",
  "src/agentRunner.ts",
  "src/index.ts",
  "package.json",
  "tsconfig.json",
  "README.md",
  ".env.example",
  "CLAUDE.md",
];

function buildStressPrompt(cwd: string): string {
  const filePaths = TARGET_FILES.map((f) => `${cwd}/${f}`);
  const fileList = filePaths.map((f, i) => `${i + 1}. ${f}`).join("\n");

  return [
    "Count the lines in each of the files listed below. Read them one at a time",
    "using the Read tool (one Read call per file, no parallelization, no Task tool,",
    "no Glob, no Grep). For each file, report the line count like: `file.ts: N lines`.",
    "If a file doesn't exist, note that and move on to the next.",
    "",
    "Files:",
    fileList,
    "",
    'When done with all files, finish with: "All done."',
  ].join("\n");
}

/**
 * Run a stress test in the given thread, measuring tool call throughput
 * and detecting failures.
 */
export async function runStressTest(
  session: SessionInfo,
  thread: ThreadChannel,
): Promise<void> {
  await thread.send("**Starting stress test** - firing ~25 sequential Read tool calls...");

  const events: ToolEvent[] = [];
  const stderrLines: string[] = [];
  let toolIndex = 0;
  const startTime = Date.now();

  const hooks: DiagnosticHooks = {
    onToolResult: (info) => {
      toolIndex++;
      events.push({
        index: toolIndex,
        toolName: info.toolName,
        toolUseId: info.toolUseId,
        isError: info.isError,
        contentSnippet: info.content.slice(0, 120),
        timestamp: info.timestamp,
      });
      debug("stress", `Tool #${toolIndex} ${info.toolName} ${info.isError ? "FAIL" : "OK"} (${info.toolUseId})`);
    },
    onStderr: (data) => {
      const line = data.trim();
      if (line) {
        stderrLines.push(`[T+${((Date.now() - startTime) / 1000).toFixed(1)}s] ${line}`);
      }
    },
  };

  // Start a fresh Claude session so the stress prompt isn't confused by prior context
  const savedSessionId = session.sessionId;
  session.sessionId = null;

  const prompt = buildStressPrompt(session.cwd);

  try {
    await runAgent(session, prompt, thread, hooks);
  } catch (err) {
    await thread.send(`**Stress test error:** ${err instanceof Error ? err.message : String(err)}`);
  }

  // Restore the original session ID so the thread can continue normally.
  // If the stress test created a new session ID, discard it (we don't persist
  // the throwaway session).
  if (session.sessionId !== savedSessionId) {
    removePersistedSession(session.threadId);
  }
  session.sessionId = savedSessionId;

  const endTime = Date.now();
  const results: StressResults = {
    totalTools: events.length,
    succeeded: events.filter((e) => !e.isError).length,
    failed: events.filter((e) => e.isError).length,
    events,
    stderrLines,
    startTime,
    endTime,
  };

  await postResults(thread, results);
}

/** Post formatted stress test results to the thread. */
async function postResults(thread: ThreadChannel, results: StressResults): Promise<void> {
  const duration = ((results.endTime - results.startTime) / 1000).toFixed(1);
  const firstFailure = results.events.find((e) => e.isError);
  const failureOffset = firstFailure
    ? `T+${((firstFailure.timestamp - results.startTime) / 1000).toFixed(1)}s (tool #${firstFailure.index})`
    : "none";

  // Main summary embed
  const embed = new EmbedBuilder()
    .setColor(results.failed > 0 ? 0xed4245 : 0x57f287)
    .setTitle("Stress Test Results")
    .addFields(
      { name: "Duration", value: `${duration}s`, inline: true },
      { name: "Total tools", value: `${results.totalTools}`, inline: true },
      { name: "Succeeded", value: `${results.succeeded}`, inline: true },
      { name: "Failed", value: `${results.failed}`, inline: true },
      { name: "First failure", value: failureOffset, inline: true },
    );

  // Compute inter-tool timing
  if (results.events.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < results.events.length; i++) {
      gaps.push(results.events[i]!.timestamp - results.events[i - 1]!.timestamp);
    }
    const avgGap = (gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000).toFixed(2);
    const minGap = (Math.min(...gaps) / 1000).toFixed(2);
    const maxGap = (Math.max(...gaps) / 1000).toFixed(2);
    embed.addFields({
      name: "Inter-tool timing",
      value: `avg ${avgGap}s, min ${minGap}s, max ${maxGap}s`,
    });
  }

  await thread.send({ embeds: [embed] });

  // Timeline: show each tool result
  const timelineLines = results.events.map((e) => {
    const offset = ((e.timestamp - results.startTime) / 1000).toFixed(1);
    const status = e.isError ? "FAIL" : "OK";
    const snippet = e.contentSnippet ? ` - ${e.contentSnippet.slice(0, 60)}` : "";
    return `\`T+${offset.padStart(5)}s\` #${String(e.index).padStart(2)} ${e.toolName} [${status}]${snippet}`;
  });

  if (timelineLines.length > 0) {
    // Split timeline into chunks that fit Discord's 2000 char limit
    let chunk = "**Tool timeline:**\n";
    for (const line of timelineLines) {
      if (chunk.length + line.length + 1 > 1950) {
        await thread.send(chunk);
        chunk = "";
      }
      chunk += line + "\n";
    }
    if (chunk) await thread.send(chunk);
  }

  // Failed tool details
  const failures = results.events.filter((e) => e.isError);
  if (failures.length > 0) {
    let failMsg = "**Failed tools:**\n";
    for (const f of failures.slice(0, 20)) {
      const offset = ((f.timestamp - results.startTime) / 1000).toFixed(1);
      failMsg += `#${f.index} at T+${offset}s - ${f.toolName}: \`${f.contentSnippet.slice(0, 100)}\`\n`;
    }
    if (failures.length > 20) {
      failMsg += `... and ${failures.length - 20} more\n`;
    }
    await thread.send(failMsg);
  }

  // Stderr output (if any interesting lines)
  const interestingStderr = results.stderrLines.filter(
    (l) => l.includes("error") || l.includes("Error") || l.includes("rate") ||
           l.includes("limit") || l.includes("throttl") || l.includes("closed") ||
           l.includes("permission") || l.includes("abort"),
  );
  if (interestingStderr.length > 0) {
    let stderrMsg = "**Interesting stderr:**\n```\n";
    for (const line of interestingStderr.slice(0, 30)) {
      if (stderrMsg.length + line.length > 1900) break;
      stderrMsg += line + "\n";
    }
    stderrMsg += "```";
    await thread.send(stderrMsg);
  }
}
