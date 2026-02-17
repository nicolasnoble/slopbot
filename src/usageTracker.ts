import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { debug } from "./debug.js";
import { config } from "./config.js";

const CREDENTIALS_PATH = join(config.claudeConfigDir, ".credentials.json");
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

export type AlertLevel = "none" | "warning" | "critical";

export interface WindowProjection {
  windowName: string;
  currentUtilization: number;
  projectedUtilization: number;
  timeRemainingMs: number;
  totalWindowMs: number;
  elapsedMs: number;
  alertLevel: AlertLevel;
}

/** Total window durations for each window type. */
const WINDOW_DURATIONS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  seven_day_opus: 7 * 24 * 60 * 60 * 1000,
  seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
  seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
  seven_day_cowork: 7 * 24 * 60 * 60 * 1000,
};

/** Display labels for each window type. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-Hour Window",
  seven_day: "7-Day Window",
  seven_day_opus: "7-Day Opus",
  seven_day_sonnet: "7-Day Sonnet",
  seven_day_oauth_apps: "7-Day OAuth Apps",
  seven_day_cowork: "7-Day Cowork",
};

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
    throw new Error(`No OAuth credentials found. Make sure Claude Code is logged in (\`${CREDENTIALS_PATH}\` must exist with \`user:profile\` scope).`);
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

/**
 * Compute end-of-window utilization projections via linear extrapolation.
 *
 * For each active window: elapsed = totalDuration - timeRemaining,
 * then projected = current × (total / elapsed).
 * Skips projection if elapsed < 1 minute (window just reset).
 */
export function computeProjections(data: UsageData): WindowProjection[] {
  const projections: WindowProjection[] = [];
  const now = Date.now();

  const windowKeys = [
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_oauth_apps",
    "seven_day_cowork",
  ] as const;

  for (const key of windowKeys) {
    const window = data[key];
    if (!window) continue;

    const totalMs = WINDOW_DURATIONS[key]!;
    const resetAt = new Date(window.resets_at).getTime();
    const timeRemainingMs = Math.max(0, resetAt - now);
    const elapsedMs = totalMs - timeRemainingMs;

    // Skip projection if window just reset (< 1 minute elapsed)
    const ONE_MINUTE = 60 * 1000;
    if (elapsedMs < ONE_MINUTE) {
      projections.push({
        windowName: key,
        currentUtilization: window.utilization,
        projectedUtilization: window.utilization,
        timeRemainingMs,
        totalWindowMs: totalMs,
        elapsedMs,
        alertLevel: "none",
      });
      continue;
    }

    const projected = window.utilization * (totalMs / elapsedMs);
    const projectedRounded = Math.round(projected * 10) / 10;

    let alertLevel: AlertLevel = "none";
    if (projectedRounded >= 100) {
      alertLevel = "critical";
    } else if (projectedRounded >= 80) {
      alertLevel = "warning";
    }

    projections.push({
      windowName: key,
      currentUtilization: window.utilization,
      projectedUtilization: projectedRounded,
      timeRemainingMs,
      totalWindowMs: totalMs,
      elapsedMs,
      alertLevel,
    });
  }

  return projections;
}

/** Format a reset timestamp into a human-readable relative time. */
function formatResetTime(isoString: string): string {
  const resetAt = new Date(isoString);
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();

  if (diffMs <= 0) return "now";

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Build a usage bar like: ████████░░░░░░░░░░░░ 40% */
function usageBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty) + ` ${pct}%`;
}

/** Format a single usage window block with optional projection. */
function formatWindowBlock(
  key: string,
  window: UsageWindow,
  projections?: WindowProjection[],
): string[] {
  const label = WINDOW_LABELS[key] ?? key;
  const reset = formatResetTime(window.resets_at);
  const lines: string[] = [];

  lines.push(`**${label}**`);
  lines.push(`\`${usageBar(window.utilization)}\``);
  lines.push(`Resets in ${reset}`);

  if (projections) {
    const proj = projections.find((p) => p.windowName === key);
    if (proj && proj.elapsedMs >= 60_000) {
      let projLine = `Projected at reset: ${proj.projectedUtilization}%`;
      if (proj.alertLevel === "critical") {
        projLine += ` 🚨 **[RATE LIMIT LIKELY]**`;
      } else if (proj.alertLevel === "warning") {
        projLine += ` ⚠️ **[HIGH USAGE]**`;
      }
      lines.push(projLine);
    }
  }

  lines.push("");
  return lines;
}

/** Format usage data into a Discord-friendly embed-style message. */
export function formatUsageMessage(data: UsageData, projections?: WindowProjection[]): string {
  const lines: string[] = ["**Claude Usage**", ""];

  const windowKeys = [
    "five_hour",
    "seven_day",
    "seven_day_sonnet",
    "seven_day_opus",
    "seven_day_cowork",
    "seven_day_oauth_apps",
  ] as const;

  for (const key of windowKeys) {
    const window = data[key];
    if (window) {
      lines.push(...formatWindowBlock(key, window, projections));
    }
  }

  if (data.extra_usage?.is_enabled) {
    const eu = data.extra_usage;
    lines.push(`**Extra Usage**`);
    if (eu.monthly_limit != null && eu.used_credits != null) {
      // API returns cents — convert to dollars
      const usedDollars = eu.used_credits / 100;
      const limitDollars = eu.monthly_limit / 100;
      lines.push(`$${usedDollars.toFixed(2)} / $${limitDollars.toFixed(2)}`);
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
