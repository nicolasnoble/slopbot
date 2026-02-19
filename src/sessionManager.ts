import type { ThreadChannel } from "discord.js";
import type { SessionInfo, BackgroundTask } from "./types.js";
import { config } from "./config.js";
import { debug } from "./debug.js";
import { persistSessionId, removePersistedSession, persistCost } from "./sessionStore.js";

const sessions = new Map<string, SessionInfo>();

/** Background tasks per thread. */
const bgTasks = new Map<string, BackgroundTask[]>();

/** Per-thread ID counter for background tasks. */
const bgIdCounters = new Map<string, number>();

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
    contextTokens: 0,
    contextWindow: 0,
    contextWarned: false,
    isBackground: false,
    bgTaskId: null,
    currentPromptLabel: null,
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
  abortAllBgTasks(threadId);
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
  session.contextTokens = 0;
  session.contextWindow = 0;
  session.contextWarned = false;
  session.isBackground = false;
  session.bgTaskId = null;
  session.currentPromptLabel = null;
  session.messageQueue = [];
  session.lastActivity = Date.now();
  abortAllBgTasks(threadId);
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

// ── Background task management ──────────────────────────────────────

/** Move the current foreground session to background tasks.
 *  Returns the BackgroundTask, or null if there's no busy session. */
export function backgroundSession(threadId: string, label: string): BackgroundTask | null {
  const session = sessions.get(threadId);
  if (!session || !session.busy) return null;

  const counter = (bgIdCounters.get(threadId) ?? 0) + 1;
  bgIdCounters.set(threadId, counter);

  session.isBackground = true;
  session.bgTaskId = counter;

  const task: BackgroundTask = {
    id: counter,
    session,
    label,
    startedAt: Date.now(),
  };

  const tasks = bgTasks.get(threadId) ?? [];
  tasks.push(task);
  bgTasks.set(threadId, tasks);

  // Detach from the sessions map so a new foreground session can be created
  sessions.delete(threadId);

  debug("session", `Backgrounded session in thread ${threadId} as bg #${counter}: "${label}"`);
  return task;
}

/** Create a new foreground session inheriting sessionId and cost/context data. */
export function createForegroundSession(
  threadId: string,
  thread: ThreadChannel,
  cwd: string,
  inheritFrom: SessionInfo,
): SessionInfo {
  const session = createSession(threadId, thread, cwd);
  session.sessionId = inheritFrom.sessionId;
  session.totalCost = inheritFrom.totalCost;
  session.contextTokens = inheritFrom.contextTokens;
  session.contextWindow = inheritFrom.contextWindow;
  session.contextWarned = inheritFrom.contextWarned;
  return session;
}

export function getBgTasks(threadId: string): BackgroundTask[] {
  return bgTasks.get(threadId) ?? [];
}

export function removeBgTask(threadId: string, taskId: number): void {
  const tasks = bgTasks.get(threadId);
  if (!tasks) return;
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1) {
    tasks.splice(idx, 1);
    debug("session", `Removed bg task #${taskId} from thread ${threadId} (${tasks.length} remaining)`);
  }
  if (tasks.length === 0) {
    bgTasks.delete(threadId);
  }
}

/** Abort a specific background task by ID. Returns true if found. */
export function abortBgTask(threadId: string, taskId: number): boolean {
  const tasks = bgTasks.get(threadId);
  if (!tasks) return false;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return false;

  task.session.abortController.abort();
  if (task.session.inputChannel) {
    task.session.inputChannel.close();
  }
  if (task.session.query) {
    task.session.query.close();
  }
  task.session.messageQueue = [];
  task.session.autoResume = false;
  task.session.pendingQuestion = null;
  task.session.pendingPlanApproval = null;
  task.session.abortController = new AbortController();
  debug("session", `Aborted bg task #${taskId} in thread ${threadId}`);
  return true;
}

/** Abort all background tasks for a thread. */
export function abortAllBgTasks(threadId: string): number {
  const tasks = bgTasks.get(threadId) ?? [];
  for (const task of tasks) {
    task.session.abortController.abort();
    if (task.session.inputChannel) {
      task.session.inputChannel.close();
    }
    if (task.session.query) {
      task.session.query.close();
    }
    task.session.messageQueue = [];
    task.session.autoResume = false;
    task.session.pendingQuestion = null;
    task.session.pendingPlanApproval = null;
  }
  const count = tasks.length;
  bgTasks.delete(threadId);
  if (count > 0) {
    debug("session", `Aborted all ${count} bg task(s) in thread ${threadId}`);
  }
  return count;
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
      abortAllBgTasks(threadId);
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
