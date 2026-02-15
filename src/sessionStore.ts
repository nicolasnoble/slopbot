import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { debug } from "./debug.js";

const STORE_PATH = join(process.cwd(), "sessions.json");
const STORE_TMP_PATH = STORE_PATH + ".tmp";

interface SessionEntry {
  sessionId: string;
  cost: number;
  cwd: string;
}

type StoreData = Record<string, SessionEntry>;

let data: StoreData = {};

// Load persisted data on import (handles old formats gracefully)
try {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Record<string, unknown>;
  for (const [threadId, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      // Migrate old flat format: threadId → sessionId string
      data[threadId] = { sessionId: value, cost: 0, cwd: "" };
    } else if (value && typeof value === "object" && "sessionId" in value) {
      const entry = value as Record<string, unknown>;
      data[threadId] = {
        sessionId: entry.sessionId as string,
        cost: (entry.cost as number) ?? 0,
        cwd: (entry.cwd as string) ?? "",
      };
    }
  }
  const count = Object.keys(data).length;
  if (count > 0) console.log(`[store] Loaded ${count} persisted session(s) from ${STORE_PATH}`);
} catch {
  // File doesn't exist yet — start fresh
}

/** Atomic write: write to a temp file, then rename over the target. */
function persist(): void {
  try {
    writeFileSync(STORE_TMP_PATH, JSON.stringify(data, null, 2));
    renameSync(STORE_TMP_PATH, STORE_PATH);
  } catch (err) {
    console.error("[store] Failed to persist sessions:", err);
  }
}

export function getPersistedSessionId(threadId: string): string | null {
  const entry = data[threadId];
  const id = entry?.sessionId ?? null;
  debug("store", `Lookup thread ${threadId}: ${id ? `found ${id}` : "not found"}`);
  return id;
}

export function getPersistedCwd(threadId: string): string {
  return data[threadId]?.cwd ?? "";
}

export function getPersistedCost(threadId: string): number {
  return data[threadId]?.cost ?? 0;
}

export function persistSessionId(threadId: string, sessionId: string, cwd: string): void {
  const existing = data[threadId];
  data[threadId] = { sessionId, cost: existing?.cost ?? 0, cwd };
  debug("store", `Persisted ${threadId} → ${sessionId} (cwd: ${cwd})`);
  persist();
}

export function persistCost(threadId: string, cost: number): void {
  const entry = data[threadId];
  if (entry) {
    entry.cost = cost;
    persist();
  }
}

export function removePersistedSession(threadId: string): void {
  if (threadId in data) {
    delete data[threadId];
    debug("store", `Removed thread ${threadId}`);
    persist();
  }
}

/** Sum of all persisted session costs. */
export function getTotalCost(): number {
  let total = 0;
  for (const entry of Object.values(data)) {
    total += entry.cost;
  }
  return total;
}
