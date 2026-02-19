import type { Message, ThreadChannel } from "discord.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { AsyncChannel } from "./asyncChannel.js";

export interface FlatOption {
  globalIndex: number;    // 1-based, as shown in embed
  questionIndex: number;  // 0-based
  label: string;
  isOther: boolean;
}

export interface PendingQuestion {
  questions: AskUserQuestionItem[];
  resolve: (answers: Record<string, string>) => void;
  embedMessage: Message | null;
  selections: Map<number, Set<number>>;      // questionIdx → selected globalIndices
  otherText: Map<number, string>;            // questionIdx → custom text
  awaitingOtherForQuestion: number | null;   // which question needs freeform text
  flatOptions: FlatOption[];
}

export interface PlanApprovalResult {
  approved: boolean;
  feedback?: string;
  clearContext?: boolean;
}

export interface PendingPlanApproval {
  resolve: (result: PlanApprovalResult) => void;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface SessionInfo {
  sessionId: string | null;
  threadId: string;
  thread: ThreadChannel;
  cwd: string;
  abortController: AbortController;
  pendingQuestion: PendingQuestion | null;
  pendingPlanApproval: PendingPlanApproval | null;
  busy: boolean;
  lastActivity: number;
  query: Query | null;
  messageQueue: string[];
  inputChannel: AsyncChannel<string> | null;
  totalCost: number;
  clearContextOnComplete: boolean;
  /** Plan content to implement on a fresh session (set by "approve & clear context"). */
  planToImplement: string | null;
  /** Total turns accumulated across auto-resumes within a single user request. */
  turnCount: number;
  /** When true, the agent will auto-resume after hitting maxTurns. */
  autoResume: boolean;
  /** Last known input token count (from the most recent result message). */
  contextTokens: number;
  /** Context window size for the model used in this session. */
  contextWindow: number;
  /** Whether the 80% context warning has already been posted. */
  contextWarned: boolean;
  /** Whether this session is running as a background task. */
  isBackground: boolean;
  /** The background task ID (null if foreground). */
  bgTaskId: number | null;
  /** Label describing what this session is working on (used for !jobs). */
  currentPromptLabel: string | null;
}

export interface BackgroundTask {
  id: number;
  session: SessionInfo;
  label: string;
  startedAt: number;
}

export interface ToolLogEntry {
  name: string;
  detail: string;
}

/** Tracks a single tool's Discord card through its lifecycle. */
export interface ToolCard {
  /** The Discord message for this card (null while send is in-flight). */
  message: Message | null;
  /** Resolves when the Discord message has been sent. */
  ready: Promise<Message>;
  name: string;
  detail: string;
  /** When true, this card shows a persistent diff embed and should not be auto-deleted. */
  isDiffCard?: boolean;
}

/** Tracks a tool_use content block being streamed (input JSON accumulated incrementally). */
export interface PartialToolInput {
  toolUseId: string;
  name: string;
  json: string;
}

export interface StreamState {
  currentMessage: Message | null;
  accumulatedText: string;
  lastEditTime: number;
  editTimer: ReturnType<typeof setTimeout> | null;
  /** In-flight doEdit promise, so finalizeMessage can await it. */
  pendingEdit: Promise<void> | null;
  /** Temporary status message shown while Claude works. */
  statusMessage: Message | null;
  /** Tool call counts for the current turn (reset after each text response). */
  toolCounts: Record<string, number>;
  /** Ordered log of tool calls for the current turn, shown in the status embed. */
  toolLog: ToolLogEntry[];
  /** Last text we finalized, to avoid re-sending from partial assistant messages. */
  lastFinalizedText: string;
  /** Interval that keeps the typing indicator alive while status is shown. */
  typingInterval: ReturnType<typeof setInterval> | null;
  /** Image file paths accessed/created by tools during the current turn. */
  imageFiles: Set<string>;
  /** Active tool cards keyed by tool_use_id. Supports parallel tools. */
  toolCards: Map<string, ToolCard>;
  /** Tracks partial tool inputs during streaming, keyed by content block index. */
  partialToolInputs: Map<number, PartialToolInput>;
}
