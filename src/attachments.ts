import { AttachmentBuilder, type Attachment } from "discord.js";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { basename, join, resolve, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// Match image paths: absolute (/path/to/img.png), relative (./img.png, dir/img.png),
// or bare filenames (img.png). Handles paths after whitespace, backticks, or at line start.
const FILE_PATH_REGEX = /(?:^|[\s`(])((?:\/|\.{1,2}\/)?[\w./ -]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?=$|[\s`),;:!?])/gmi;

/**
 * Scan text for image file paths that exist on disk and return Discord attachments.
 * Relative paths are resolved against basePath.
 */
export function extractAttachments(text: string, basePath: string): AttachmentBuilder[] {
  const attachments: AttachmentBuilder[] = [];
  const seen = new Set<string>();
  const base = basePath;

  FILE_PATH_REGEX.lastIndex = 0;
  let match;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    let filePath = match[1]!.trim();

    if (!isAbsolute(filePath)) {
      filePath = resolve(base, filePath);
    }

    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (IMAGE_EXTENSIONS.test(filePath) && existsSync(filePath)) {
      attachments.push(
        new AttachmentBuilder(filePath, { name: basename(filePath) })
      );
    }
  }

  return attachments;
}

/**
 * Build Discord attachments from a set of known image file paths (e.g. from tool tracking).
 */
export function attachmentsFromPaths(paths: Iterable<string>): AttachmentBuilder[] {
  const attachments: AttachmentBuilder[] = [];
  for (const filePath of paths) {
    if (existsSync(filePath)) {
      attachments.push(
        new AttachmentBuilder(filePath, { name: basename(filePath) })
      );
    }
  }
  return attachments;
}

const DISCORD_DIR = "Discord";

/**
 * Download Discord message attachments into {cwd}/Discord/.
 * Overwrites existing files with the same name.
 * Returns the list of saved filenames (just the basename).
 */
export async function downloadDiscordAttachments(
  attachments: Attachment[],
  cwd: string,
): Promise<string[]> {
  if (attachments.length === 0) return [];

  const dir = join(cwd, DISCORD_DIR);
  mkdirSync(dir, { recursive: true });

  const saved: string[] = [];

  for (const attachment of attachments) {
    const filename = attachment.name || `file-${attachment.id}`;
    const dest = join(dir, filename);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok || !response.body) {
        console.error(`[attachments] Failed to download ${filename}: ${response.status}`);
        continue;
      }
      const readable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      await pipeline(readable, createWriteStream(dest));
      saved.push(filename);
      console.log(`[attachments] Saved ${filename} to ${dest}`);
    } catch (error) {
      console.error(`[attachments] Error downloading ${filename}:`, error);
    }
  }

  return saved;
}
