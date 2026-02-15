import { config } from "./config.js";

/**
 * Log a debug message when DEBUG mode is enabled.
 * Messages are prefixed with a tag (e.g. "[agent]") and a timestamp.
 */
export function debug(tag: string, message: string, ...args: unknown[]): void {
  if (!config.debug) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  console.log(`[${ts}] [${tag}] ${message}`, ...args);
}
