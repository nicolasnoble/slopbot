import "dotenv/config";
import type { McpServerConfig, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface BotConfig {
  discordToken: string;
  anthropicApiKey: string | undefined;
  channels: Map<string, string>; // channel name → CWD path
  claudeConfigDir: string; // Path to .claude config directory (credentials, plans, etc.)
  claudeModel: string | undefined;
  editRateMs: number;
  permissionMode: PermissionMode;
  sessionTimeoutMinutes: number;
  maxTotalTurns: number;
  /** Max random delay (ms) added when auto-accepting tool permissions. 0 = no delay. */
  toolAcceptDelayMs: number;
  mcpServers: Record<string, McpServerConfig> | undefined;
  debug: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseChannels(): Map<string, string> {
  const raw = process.env["CHANNELS"];
  if (raw) {
    const map = new Map<string, string>();
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Split on first ":" only, to support paths with colons
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Invalid CHANNELS entry (missing ':'): "${trimmed}". Expected format: channel:/path/to/dir`);
      }
      const channel = trimmed.slice(0, colonIdx).trim();
      const path = trimmed.slice(colonIdx + 1).trim();
      if (!channel || !path) {
        throw new Error(`Invalid CHANNELS entry: "${trimmed}". Both channel name and path are required.`);
      }
      if (!isAbsolute(path)) {
        throw new Error(`CHANNELS path for "${channel}" is not absolute: "${path}"`);
      }
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error(`CHANNELS path for "${channel}" does not exist or is not a directory: "${path}"`);
      }
      map.set(channel, path);
    }
    if (map.size === 0) {
      throw new Error("CHANNELS env var is set but contains no valid entries.");
    }
    return map;
  }

  // Fallback: construct single-entry map from legacy env vars
  const watchChannel = process.env["WATCH_CHANNEL"] ?? "claude";
  const claudeCwd = process.env["CLAUDE_CWD"] ?? process.cwd();
  return new Map([[watchChannel, claudeCwd]]);
}

function loadMcpServers(): Record<string, McpServerConfig> | undefined {
  const path = process.env["MCP_CONFIG"] || join(process.cwd(), "mcp.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse MCP config from ${path}:`, err);
    return undefined;
  }
}

export const config: BotConfig = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  anthropicApiKey: process.env["ANTHROPIC_API_KEY"] || undefined,
  channels: parseChannels(),
  claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"),
  claudeModel: process.env["CLAUDE_MODEL"] || undefined,
  editRateMs: parseInt(process.env["EDIT_RATE_MS"] ?? "1500", 10),
  permissionMode: (process.env["PERMISSION_MODE"] as PermissionMode) ?? "bypassPermissions",
  sessionTimeoutMinutes: parseInt(process.env["SESSION_TIMEOUT_MINUTES"] ?? "60", 10),
  maxTotalTurns: parseInt(process.env["MAX_TOTAL_TURNS"] ?? "200", 10),
  toolAcceptDelayMs: parseInt(process.env["TOOL_ACCEPT_DELAY_MS"] ?? "0", 10),
  mcpServers: loadMcpServers(),
  debug: process.env["DEBUG"] === "true" || process.env["DEBUG"] === "1",
};
