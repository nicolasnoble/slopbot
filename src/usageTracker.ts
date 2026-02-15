import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debug } from "./debug.js";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_ENDPOINT = "https://api.anthropic.com/api/oauth/token";

interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

interface UsageWindow {
  utilization: number;
  resets_at: string;
}

interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface UsageData {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
  seven_day_cowork: UsageWindow | null;
  extra_usage: ExtraUsage | null;
}

/** Read OAuth credentials from ~/.claude/.credentials.json */
function readCredentials(): OAuthCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) {
    debug("usage", `Credentials file not found: ${CREDENTIALS_PATH}`);
    return null;
  }

  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as OAuthCredentials;
    if (!parsed.claudeAiOauth?.accessToken) {
      debug("usage", "Credentials file missing claudeAiOauth.accessToken");
      return null;
    }
    return parsed;
  } catch (err) {
    debug("usage", `Failed to read credentials: ${err}`);
    return null;
  }
}

/** Refresh the OAuth access token using the refresh token. */
async function refreshAccessToken(creds: OAuthCredentials): Promise<string | null> {
  try {
    debug("usage", "Refreshing OAuth access token...");
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.claudeAiOauth.refreshToken,
      }),
    });

    if (!res.ok) {
      debug("usage", `Token refresh failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    // Update in-memory credentials (we don't write back to disk — Claude Code manages that)
    creds.claudeAiOauth.accessToken = data.access_token;
    creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
    debug("usage", "Token refreshed successfully");
    return data.access_token;
  } catch (err) {
    debug("usage", `Token refresh error: ${err}`);
    return null;
  }
}

/** Get a valid access token, refreshing if expired. */
async function getAccessToken(): Promise<string | null> {
  const creds = readCredentials();
  if (!creds) return null;

  // Check if token is expired (with 60s buffer)
  if (creds.claudeAiOauth.expiresAt < Date.now() + 60_000) {
    return refreshAccessToken(creds);
  }

  return creds.claudeAiOauth.accessToken;
}

/** Fetch current usage metrics from the Anthropic OAuth API. */
export async function fetchUsage(): Promise<UsageData> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No OAuth credentials found. Make sure Claude Code is logged in (`~/.claude/.credentials.json` must exist with `user:profile` scope).");
  }

  const res = await fetch(USAGE_ENDPOINT, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Usage API returned ${res.status}: ${body}`);
  }

  return (await res.json()) as UsageData;
}

/** Format a reset timestamp into a human-readable relative time. */
function formatResetTime(isoString: string): string {
  const resetAt = new Date(isoString);
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();

  if (diffMs <= 0) return "now";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Build a usage bar like: ████████░░░░░░░░░░░░ 40% */
function usageBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty) + ` ${pct}%`;
}

/** Format usage data into a Discord-friendly embed-style message. */
export function formatUsageMessage(data: UsageData): string {
  const lines: string[] = ["**Claude Usage**", ""];

  if (data.five_hour) {
    const reset = formatResetTime(data.five_hour.resets_at);
    lines.push(`**5-Hour Window**`);
    lines.push(`\`${usageBar(data.five_hour.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.seven_day) {
    const reset = formatResetTime(data.seven_day.resets_at);
    lines.push(`**7-Day Window**`);
    lines.push(`\`${usageBar(data.seven_day.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.seven_day_sonnet) {
    const reset = formatResetTime(data.seven_day_sonnet.resets_at);
    lines.push(`**7-Day Sonnet**`);
    lines.push(`\`${usageBar(data.seven_day_sonnet.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.seven_day_opus) {
    const reset = formatResetTime(data.seven_day_opus.resets_at);
    lines.push(`**7-Day Opus**`);
    lines.push(`\`${usageBar(data.seven_day_opus.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.seven_day_cowork) {
    const reset = formatResetTime(data.seven_day_cowork.resets_at);
    lines.push(`**7-Day Cowork**`);
    lines.push(`\`${usageBar(data.seven_day_cowork.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.seven_day_oauth_apps) {
    const reset = formatResetTime(data.seven_day_oauth_apps.resets_at);
    lines.push(`**7-Day OAuth Apps**`);
    lines.push(`\`${usageBar(data.seven_day_oauth_apps.utilization)}\``);
    lines.push(`Resets in ${reset}`);
    lines.push("");
  }

  if (data.extra_usage?.is_enabled) {
    const eu = data.extra_usage;
    lines.push(`**Extra Usage**`);
    if (eu.monthly_limit != null && eu.used_credits != null) {
      lines.push(`$${eu.used_credits.toFixed(2)} / $${eu.monthly_limit.toFixed(2)}`);
      if (eu.utilization != null) {
        lines.push(`\`${usageBar(eu.utilization)}\``);
      }
    } else {
      lines.push("Enabled (no usage yet)");
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
