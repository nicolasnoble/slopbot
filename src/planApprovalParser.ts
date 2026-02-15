import type { PlanApprovalResult } from "./types.js";

/**
 * Parse a user reply as a plan approval/rejection.
 *
 * Options:
 *   1 / clear / clear context → approve + clear context
 *   2 / approve / yes / ...   → approve (keep context)
 *   3 / reject / no / ...     → reject
 *   anything else             → reject with feedback
 */
export function parsePlanApproval(text: string): PlanApprovalResult {
  const trimmed = text.trim().toLowerCase();

  // Option 1: Approve & clear context
  if (
    trimmed === "1" ||
    trimmed === "clear" ||
    trimmed === "clear context"
  ) {
    return { approved: true, clearContext: true };
  }

  // Option 2: Approve (keep context)
  if (
    trimmed === "2" ||
    trimmed === "approve" ||
    trimmed === "approved" ||
    trimmed === "yes" ||
    trimmed === "y" ||
    trimmed === "lgtm" ||
    trimmed === "looks good" ||
    trimmed === "ok" ||
    trimmed === "go" ||
    trimmed === "go ahead" ||
    trimmed === "proceed"
  ) {
    return { approved: true };
  }

  // Option 3: Reject (no feedback)
  if (
    trimmed === "3" ||
    trimmed === "reject" ||
    trimmed === "rejected" ||
    trimmed === "no" ||
    trimmed === "n" ||
    trimmed === "revise"
  ) {
    return { approved: false };
  }

  // Anything else is rejection with the text as feedback
  return { approved: false, feedback: text.trim() };
}
