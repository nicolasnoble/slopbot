import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from "discord.js";

function shortenPath(p: string, cwd: string): string {
  if (p.startsWith(cwd + "/")) {
    return p.slice(cwd.length + 1);
  }
  return p;
}

export function buildDiffCardEmbed({
  filePath,
  linesAdded,
  linesRemoved,
  isNewFile,
  cwd,
}: {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  cwd: string;
}): EmbedBuilder {
  const icon = isNewFile ? "\uD83D\uDCDD" : "\u270F\uFE0F";
  const shortPath = shortenPath(filePath, cwd);

  const stats: string[] = [];
  if (linesAdded > 0) stats.push(`+${linesAdded} added`);
  if (linesRemoved > 0) stats.push(`-${linesRemoved} removed`);

  const description = `${icon} \`${shortPath}\`\n${stats.join(" \u00B7 ")}`;

  return new EmbedBuilder().setColor(0x57f287).setDescription(description);
}

export function buildShowDiffButton(
  customId: string,
): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel("\uD83D\uDCC4 Show Diff")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

export function buildHideDiffButton(
  diffCustomId: string,
): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(`hide-${diffCustomId}`)
    .setLabel("\uD83D\uDCC4 Hide Diff")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}
