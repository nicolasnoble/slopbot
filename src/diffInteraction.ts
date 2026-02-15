import type { ButtonInteraction } from "discord.js";
import { getDiff, formatDiff } from "./diffStore.js";
import { buildDiffCardEmbed, buildShowDiffButton, buildHideDiffButton } from "./diffCard.js";
import { debug } from "./debug.js";
import { escapeCodeFences } from "./messageSplitter.js";

const MAX_DIFF_LENGTH = 20_000;
const MAX_CHUNK_SIZE = 1950 - "```diff\n\n```".length;

export async function handleDiffButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Hide diff — restore the original card
  if (customId.startsWith("hide-diff:")) {
    const diffId = customId.slice("hide-".length); // "diff:..."
    const entry = getDiff(diffId);

    if (!entry) {
      await interaction.reply({
        content: "This diff has expired.",
        ephemeral: true,
      });
      return;
    }

    const embed = buildDiffCardEmbed({
      filePath: entry.filePath,
      linesAdded: entry.linesAdded,
      linesRemoved: entry.linesRemoved,
      isNewFile: entry.isNewFile,
      cwd: entry.cwd,
    });
    const row = buildShowDiffButton(diffId);

    await interaction.update({
      content: "",
      embeds: [embed],
      components: [row],
    });

    debug("diff", `Collapsed diff: ${diffId}`);
    return;
  }

  // Show diff — expand the card into diff content
  const entry = getDiff(customId);

  if (!entry) {
    await interaction.reply({
      content: "This diff has expired.",
      ephemeral: true,
    });
    return;
  }

  let diffText = formatDiff(entry);

  // Truncate extremely large diffs
  let truncated = false;
  if (diffText.length > MAX_DIFF_LENGTH) {
    diffText = diffText.slice(0, MAX_DIFF_LENGTH);
    truncated = true;
  }

  // Split into chunks that fit in Discord messages
  const chunks: string[] = [];
  let remaining = diffText;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    const splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_SIZE);
    const actualSplit =
      splitAt > MAX_CHUNK_SIZE * 0.5 ? splitAt + 1 : MAX_CHUNK_SIZE;
    chunks.push(remaining.slice(0, actualSplit));
    remaining = remaining.slice(actualSplit);
  }

  debug(
    "diff",
    `Sending diff for ${customId}: ${chunks.length} chunk(s), ${diffText.length} chars`,
  );

  const hideDiffRow = buildHideDiffButton(customId);
  const truncatedSuffix = "\n*Diff truncated (exceeded 20,000 characters)*";

  // Replace the original card message with the first diff chunk + hide button
  await interaction.update({
    content: `\`\`\`diff\n${escapeCodeFences(chunks[0]!)}\n\`\`\`${truncated && chunks.length === 1 ? truncatedSuffix : ""}`,
    embeds: [],
    components: [hideDiffRow],
  });

  // Send remaining chunks as follow-ups
  for (let i = 1; i < chunks.length; i++) {
    const suffix =
      truncated && i === chunks.length - 1 ? truncatedSuffix : "";
    await interaction.followUp({
      content: `\`\`\`diff\n${escapeCodeFences(chunks[i]!)}\n\`\`\`${suffix}`,
    });
  }
}
