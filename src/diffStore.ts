import { debug } from "./debug.js";

export interface DiffEntry {
  filePath: string;
  oldString: string;
  newString: string;
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  cwd: string;
  createdAt: number;
}

const diffMap = new Map<string, DiffEntry>();
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function storeDiff(customId: string, entry: DiffEntry): void {
  diffMap.set(customId, entry);
  debug("diff", `Stored diff: ${customId} (${entry.filePath})`);
}

export function getDiff(customId: string): DiffEntry | undefined {
  return diffMap.get(customId);
}

export function removeDiff(customId: string): void {
  diffMap.delete(customId);
}

/** Format old/new strings as a unified-style diff with -/+ line prefixes. */
export function formatDiff(entry: DiffEntry): string {
  const lines: string[] = [];

  if (entry.oldString) {
    for (const line of entry.oldString.split("\n")) {
      lines.push(`- ${line}`);
    }
  }

  if (entry.newString) {
    for (const line of entry.newString.split("\n")) {
      lines.push(`+ ${line}`);
    }
  }

  return lines.join("\n");
}

function cleanup(): void {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of diffMap) {
    if (now - entry.createdAt > TTL_MS) {
      diffMap.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    debug("diff", `Cleanup removed ${removed} expired diff(s)`);
  }
}

export function startDiffCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
}

export function stopDiffCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
