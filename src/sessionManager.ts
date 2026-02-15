import type { ThreadChannel } from "discord.js";
import type { SessionInfo } from "./types.js";
import { config } from "./config.js";
import { debug } from "./debug.js";
import { persistSessionId, removePersistedSession, persistCost } from "./sessionStore.js";

const sessions = new Map<string, SessionInfo>();

export function createSession(threadId: string, thread: ThreadChannel, cwd: string): SessionInfo {
  debug("session", `Creating session for thread ${threadId} (cwd: ${cwd})`);
  const session: SessionInfo = {
    sessionId: null,
    threadId,
    thread,
    cwd,
    abortController: new AbortController(),
    pendingQuestion: null,
    pendingPlanApproval: null,
    busy: false,
    lastActivity: Date.now(),
    query: null,
    messageQueue: [],
    inputChannel: null,
    totalCost: 0,
    clearContextOnComplete: false,
    planToImplement: null,
    turnCount: 0,
    autoResume: false,
  };
  sessions.set(threadId, session);
  return session;
}

export function getSession(threadId: string): SessionInfo | undefined {
  return sessions.get(threadId);
}

/** Update a session's Claude sessionId and persist it to disk. */
export function setSessionId(threadId: string, sessionId: string): void {
  const session = sessions.get(threadId);
  if (session) {
    session.sessionId = sessionId;
    persistSessionId(threadId, sessionId, session.cwd);
    debug("session", `Persisted sessionId for thread ${threadId}: ${sessionId}`);
  }
}

export function deleteSession(threadId: string): void {
  debug("session", `Deleting session for thread ${threadId}`);
  const session = sessions.get(threadId);
  if (session) {
    session.abortController.abort();
    if (session.inputChannel) {
      session.inputChannel.close();
      session.inputChannel = null;
    }
    if (session.query) {
      session.query.close();
      session.query = null;
    }
    sessions.delete(threadId);
    removePersistedSession(threadId);
  }
}

/** Reset a session's Claude state while keeping it attached to the same thread. */
export function resetSession(threadId: string): boolean {
  debug("session", `Resetting session for thread ${threadId}`);
  const session = sessions.get(threadId);
  if (!session) return false;

  // Abort any in-flight query
  session.abortController.abort();
  if (session.inputChannel) {
    session.inputChannel.close();
    session.inputChannel = null;
  }
  if (session.query) {
    session.query.close();
    session.query = null;
  }

  // Reset state — next message will start a fresh Claude session
  session.sessionId = null;
  removePersistedSession(threadId);
  session.abortController = new AbortController();
  session.pendingQuestion = null;
  session.pendingPlanApproval = null;
  session.busy = false;
  session.clearContextOnComplete = false;
  session.planToImplement = null;
  session.turnCount = 0;
  session.autoResume = false;
  session.messageQueue = [];
  session.lastActivity = Date.now();
  return true;
}

export function addCost(threadId: string, cost: number): void {
  const session = sessions.get(threadId);
  if (session) {
    session.totalCost += cost;
    persistCost(threadId, session.totalCost);
    debug("session", `Added $${cost.toFixed(4)} to thread ${threadId} (total: $${session.totalCost.toFixed(4)})`);
  }
}

export function touchSession(threadId: string): void {
  const session = sessions.get(threadId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

/** Clean up sessions that have been idle beyond the configured timeout.
 *  Only removes in-memory state — persisted sessionIds are kept so threads
 *  can still resume after the bot evicts them from memory. */
export function cleanupStaleSessions(): void {
  const timeout = config.sessionTimeoutMinutes * 60 * 1000;
  const now = Date.now();

  for (const [threadId, session] of sessions) {
    if (now - session.lastActivity > timeout) {
      console.log(`[session] Evicting idle session for thread ${threadId} (persisted sessionId kept)`);
      session.abortController.abort();
      if (session.inputChannel) {
        session.inputChannel.close();
        session.inputChannel = null;
      }
      if (session.query) {
        session.query.close();
        session.query = null;
      }
      sessions.delete(threadId);
      // Note: we intentionally do NOT call removePersistedSession() here,
      // so the thread can still be resumed from sessions.json later.
    }
  }
}

/** Start periodic cleanup. Returns the interval handle. */
export function startCleanupInterval(): ReturnType<typeof setInterval> {
  // Run cleanup every 10 minutes
  return setInterval(cleanupStaleSessions, 10 * 60 * 1000);
}
