import type { TextChannel } from "discord.js";
import { fetchUsage, computeProjections, formatUsageMessage } from "./usageTracker.js";
import type { UsageData, WindowProjection } from "./usageTracker.js";
import { debug } from "./debug.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Flattened utilization values for change detection. */
interface UsageSnapshot {
  fiveHour: number | null;
  sevenDay: number | null;
  sevenDayOpus: number | null;
  sevenDaySonnet: number | null;
  sevenDayOauthApps: number | null;
  sevenDayCowork: number | null;
  extraUsageUtilization: number | null;
}

let lastSnapshot: UsageSnapshot | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

/** Extract a snapshot of utilization values from usage data. */
function extractSnapshot(data: UsageData): UsageSnapshot {
  return {
    fiveHour: data.five_hour?.utilization ?? null,
    sevenDay: data.seven_day?.utilization ?? null,
    sevenDayOpus: data.seven_day_opus?.utilization ?? null,
    sevenDaySonnet: data.seven_day_sonnet?.utilization ?? null,
    sevenDayOauthApps: data.seven_day_oauth_apps?.utilization ?? null,
    sevenDayCowork: data.seven_day_cowork?.utilization ?? null,
    extraUsageUtilization: data.extra_usage?.utilization ?? null,
  };
}

/** Compare two snapshots for equality. */
function snapshotsEqual(a: UsageSnapshot, b: UsageSnapshot): boolean {
  return (
    a.fiveHour === b.fiveHour &&
    a.sevenDay === b.sevenDay &&
    a.sevenDayOpus === b.sevenDayOpus &&
    a.sevenDaySonnet === b.sevenDaySonnet &&
    a.sevenDayOauthApps === b.sevenDayOauthApps &&
    a.sevenDayCowork === b.sevenDayCowork &&
    a.extraUsageUtilization === b.extraUsageUtilization
  );
}

/** Build an alert header if any projections have warning/critical levels. */
function buildAlertHeader(projections: WindowProjection[]): string | null {
  const critical = projections.filter((p) => p.alertLevel === "critical");
  const warning = projections.filter((p) => p.alertLevel === "warning");

  if (critical.length > 0) {
    return `🚨 **Usage Alert — Projected Rate Limit**`;
  }
  if (warning.length > 0) {
    return `⚠️ **Usage Alert — High Projected Usage**`;
  }
  return null;
}

/** Fetch usage, detect changes, and post a report if values changed. */
async function checkAndReport(channel: TextChannel): Promise<void> {
  try {
    const data = await fetchUsage();
    const snapshot = extractSnapshot(data);

    // Skip if values haven't changed (but always post on first check)
    if (lastSnapshot && snapshotsEqual(lastSnapshot, snapshot)) {
      debug("monitor", "Usage unchanged, skipping periodic report");
      return;
    }

    lastSnapshot = snapshot;

    const projections = computeProjections(data);
    let message = formatUsageMessage(data, projections);

    // Prepend alert header if any windows have warning/critical projections
    const alertHeader = buildAlertHeader(projections);
    if (alertHeader) {
      message = `${alertHeader}\n\n${message}`;
    }

    await channel.send(message);
    debug("monitor", "Posted periodic usage report");
  } catch (err) {
    console.error("[monitor] Failed to fetch/post usage report:", err);
  }
}

/**
 * Start the periodic usage monitor.
 * Posts usage reports every hour to the given channel (only when values change).
 * The first check runs immediately on startup.
 */
export function startUsageMonitor(channel: TextChannel): void {
  if (monitorInterval) {
    console.warn("[monitor] Usage monitor already running, ignoring duplicate start");
    return;
  }

  console.log(`[monitor] Starting hourly usage monitor in #${channel.name}`);

  // Run first check immediately
  checkAndReport(channel).catch(() => {});

  monitorInterval = setInterval(() => {
    checkAndReport(channel).catch(() => {});
  }, CHECK_INTERVAL_MS);
}

/** Stop the periodic usage monitor. */
export function stopUsageMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    lastSnapshot = null;
    console.log("[monitor] Usage monitor stopped");
  }
}
