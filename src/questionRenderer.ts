import { EmbedBuilder } from "discord.js";
import type { AskUserQuestionItem, FlatOption } from "./types.js";

/**
 * Build a flat list of options across all questions, each with a 1-based globalIndex.
 */
export function buildFlatOptions(questions: AskUserQuestionItem[]): FlatOption[] {
  const flat: FlatOption[] = [];
  let globalIndex = 1;

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    for (const opt of q.options) {
      flat.push({ globalIndex, questionIndex: qi, label: opt.label, isOther: false });
      globalIndex++;
    }
    // "Other" option
    flat.push({ globalIndex, questionIndex: qi, label: "Other", isOther: true });
    globalIndex++;
  }

  return flat;
}

/**
 * Render AskUserQuestion items as a Discord embed with numbered options
 * and selection indicators.
 */
export function renderQuestionEmbed(
  questions: AskUserQuestionItem[],
  flatOptions: FlatOption[],
  selections: Map<number, Set<number>>,
  otherText: Map<number, string>,
  awaitingOtherForQuestion: number | null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("Claude needs your input");

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const selected = selections.get(qi) ?? new Set<number>();
    const qOptions = flatOptions.filter((o) => o.questionIndex === qi);
    const lines: string[] = [];

    for (const opt of qOptions) {
      const isSelected = selected.has(opt.globalIndex);

      let bullet: string;
      if (q.multiSelect) {
        bullet = isSelected ? "☑" : "☐";
      } else {
        bullet = isSelected ? "●" : "○";
      }

      let line = `${bullet} **${opt.globalIndex}.** ${opt.label}`;
      if (!opt.isOther) {
        const orig = q.options.find((o) => o.label === opt.label);
        if (orig?.description) line += ` — ${orig.description}`;
      } else {
        line += " — Provide your own answer";
        const text = otherText.get(qi);
        if (isSelected && text) {
          line += `\n    *${text}*`;
        }
      }

      lines.push(line);
    }

    embed.addFields({
      name: `${q.header}: ${q.question}`,
      value: lines.join("\n"),
    });
  }

  if (awaitingOtherForQuestion !== null) {
    const q = questions[awaitingOtherForQuestion];
    embed.setFooter({
      text: `Type your custom answer for "${q?.header ?? "this question"}"...`,
    });
  } else {
    embed.setFooter({
      text: "Type a number to toggle, or 'submit' to confirm.",
    });
  }

  return embed;
}
