import Table from "cli-table3";

const MAX_LENGTH = 1950;

/** Check if a line is a markdown table separator (e.g. |---|---|) */
function isSeparatorLine(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

/** Parse cells from a markdown table row */
function parseCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/**
 * Convert markdown tables to ASCII box-drawing tables via cli-table3,
 * wrapped in code blocks for monospace rendering in Discord.
 * Skips tables already inside code blocks.
 */
export function wrapTablesInCodeBlocks(text: string): string {
  // Split into segments: code blocks vs. regular text
  const parts: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(match[0]); // code block — leave untouched
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  // Process only non-code-block segments
  const tableLineRegex = /^\|.+\|$/;
  const processed = parts.map((part) => {
    if (part.startsWith("```")) return part;

    const lines = part.split("\n");
    const result: string[] = [];
    let tableLines: string[] = [];

    const flushTable = () => {
      if (tableLines.length < 2) {
        result.push(...tableLines);
        tableLines = [];
        return;
      }

      // Parse markdown table into header + rows
      const dataLines = tableLines.filter((l) => !isSeparatorLine(l));
      if (dataLines.length === 0) {
        result.push(...tableLines);
        tableLines = [];
        return;
      }

      const header = parseCells(dataLines[0]!);
      const rows = dataLines.slice(1).map(parseCells);

      const table = new Table({ head: header, style: { head: [], border: [] } });
      for (const row of rows) table.push(row);

      result.push("```");
      result.push(table.toString());
      result.push("```");
      tableLines = [];
    };

    for (const line of lines) {
      if (tableLineRegex.test(line.trim())) {
        tableLines.push(line);
      } else {
        if (tableLines.length > 0) flushTable();
        result.push(line);
      }
    }
    if (tableLines.length > 0) flushTable();

    return result.join("\n");
  });

  return processed.join("");
}

/**
 * Split text into chunks that fit within Discord's 2000 char limit.
 * Respects code block fences across splits.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(openFence ? openFence + "\n" + remaining : remaining);
      break;
    }

    let slice = remaining.slice(0, MAX_LENGTH);

    // If we have an open fence from a previous chunk, prepend it
    if (openFence) {
      // Reserve space for the fence prefix
      const prefix = openFence + "\n";
      slice = remaining.slice(0, MAX_LENGTH - prefix.length);
      slice = prefix + slice;
    }

    // Find a safe split point
    let splitAt = findSplitPoint(slice);

    // Track code fences in this chunk
    const chunkText = slice.slice(0, splitAt);
    const fences = chunkText.match(/^```/gm);
    const fenceCount = fences ? fences.length : 0;

    let finalChunk = chunkText;

    if (openFence) {
      // We already prepended the fence; count all fences in final chunk
      const totalFences = finalChunk.match(/^```/gm);
      const total = totalFences ? totalFences.length : 0;
      if (total % 2 !== 0) {
        // Odd fences means we're inside a code block — close it
        finalChunk += "\n```";
        openFence = findLastOpenFence(finalChunk) ? findLastOpenFence(text.slice(0, text.length - remaining.length + splitAt)) : null;
      } else {
        openFence = null;
      }
    } else if (fenceCount % 2 !== 0) {
      // Odd fences means we opened one without closing — close it
      finalChunk += "\n```";
      openFence = findLastOpenFence(chunkText);
    }

    chunks.push(finalChunk);

    // Advance past what we consumed (excluding the prefix we added)
    const consumed = openFence !== null || fenceCount % 2 !== 0
      ? splitAt - (openFence ? (openFence + "\n").length : 0)
      : splitAt;
    remaining = remaining.slice(Math.max(consumed, splitAt - (chunks.length > 1 && openFence ? (openFence + "\n").length : 0)));

    // Simplify: just track how far we got in the original text
    // Re-derive remaining from what wasn't in the chunk
    const originalConsumed = openFence
      ? splitAt - (openFence + "\n").length
      : splitAt;
    remaining = remaining.length > 0 ? remaining : "";
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Simplified split: just splits at safe boundaries without code block tracking.
 * More reliable for streaming where we rebuild frequently.
 */
export function splitMessageSimple(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, MAX_LENGTH);
    const splitAt = findSplitPoint(slice);

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

function findSplitPoint(text: string): number {
  // Try splitting at a double newline
  const doubleNewline = text.lastIndexOf("\n\n");
  if (doubleNewline > text.length * 0.5) return doubleNewline + 2;

  // Try splitting at a single newline
  const newline = text.lastIndexOf("\n");
  if (newline > text.length * 0.5) return newline + 1;

  // Try splitting at a space
  const space = text.lastIndexOf(" ");
  if (space > text.length * 0.5) return space + 1;

  // Hard split
  return text.length;
}

function findLastOpenFence(text: string): string | null {
  const fenceRegex = /^(```\w*)/gm;
  let lastFence: string | null = null;
  let count = 0;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    count++;
    if (count % 2 !== 0) {
      lastFence = match[1]!;
    } else {
      lastFence = null;
    }
  }
  return lastFence;
}
