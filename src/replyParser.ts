import type { AskUserQuestionItem } from "./types.js";

export interface ParsedAnswer {
  /** Map of question header → selected answer string */
  answers: Record<string, string>;
}

/**
 * Parse a user reply to a numbered question embed.
 *
 * Supports:
 * - "1"          → select option 1
 * - "1,3"        → multi-select options 1 and 3
 * - "1, 3"       → multi-select with spaces
 * - "custom text" → freeform answer applied to first question
 */
export function parseReply(
  text: string,
  questions: AskUserQuestionItem[]
): ParsedAnswer {
  const trimmed = text.trim();
  const answers: Record<string, string> = {};

  // Build a flat list of all options with their global indices
  const flatOptions: { questionIndex: number; label: string; isOther: boolean }[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    for (const opt of q.options) {
      flatOptions.push({ questionIndex: qi, label: opt.label, isOther: false });
    }
    // "Other" option
    flatOptions.push({ questionIndex: qi, label: "Other", isOther: true });
  }

  // Try parsing as comma-separated numbers
  const numberPattern = /^[\d,\s]+$/;
  if (numberPattern.test(trimmed)) {
    const nums = trimmed
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));

    // Group selections by question
    const byQuestion = new Map<number, string[]>();
    for (const num of nums) {
      const idx = num - 1;
      if (idx >= 0 && idx < flatOptions.length) {
        const opt = flatOptions[idx]!;
        if (opt.isOther) continue; // Skip "Other" in numeric mode
        const existing = byQuestion.get(opt.questionIndex) ?? [];
        existing.push(opt.label);
        byQuestion.set(opt.questionIndex, existing);
      }
    }

    for (const [qi, labels] of byQuestion) {
      const q = questions[qi]!;
      answers[q.header] = labels.join(", ");
    }

    // Fill unanswered questions with first option
    for (const q of questions) {
      if (!answers[q.header] && q.options.length > 0) {
        answers[q.header] = q.options[0]!.label;
      }
    }

    return { answers };
  }

  // Freeform text: apply to all questions as a custom answer
  for (const q of questions) {
    answers[q.header] = trimmed;
  }

  return { answers };
}
