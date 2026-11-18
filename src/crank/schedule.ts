// Crank interval + next-run math (PJAN-182), with NO imports.
//
// Split out of ./index so the shell prompt (dist/prompt.js, which must boot near node's floor)
// can count down to the next crank at render time without pulling in the crank CLI. ./index
// re-exports everything here, so callers keep importing from "./crank/index".
//
// Keep in sync with zcrank.py: the engine applies exactly this rule when it picks which tabs a
// */5 tick may crank. pjangler only DISPLAYS "due" and "next run"; the engine decides.

export const ZCRANK_INTERVALS = ["5m", "1h", "6h", "1d"] as const;
export type CrankInterval = (typeof ZCRANK_INTERVALS)[number];
/** The global default when zcrank:config has no (valid) interval: "every tick", today's behaviour. */
export const ZCRANK_DEFAULT_INTERVAL: CrankInterval = "5m";
export const INTERVAL_SECONDS: Record<CrankInterval, number> = { "5m": 300, "1h": 3600, "6h": 21600, "1d": 86400 };
/** The crank cron (777c511a009c, clocked by Candybar) ticks every 5 minutes. */
export const ZCRANK_CRON_SECONDS = 300;
/** A slow tab fires on the first tick at/after interval - GRACE, so a 1h tab slips to 55m, not 65m. */
export const ZCRANK_GRACE_SECONDS = 300;
/**
 * The engine judges "due" a few seconds AFTER the tick fires (scan_ts lands at ~:04), so a tab
 * that becomes ready in those seconds is cranked on that tick. Display-only: nextRunMs allows it.
 */
export const ZCRANK_SCAN_SLACK_MS = 5_000;

/** An interval string, or undefined for anything outside the four (garbage reads as absent). */
export function parseInterval(value: string | undefined | null): CrankInterval | undefined {
  const v = (value ?? "").trim();
  return (ZCRANK_INTERVALS as readonly string[]).includes(v) ? (v as CrankInterval) : undefined;
}

/** Due rule: <= 5m is always due; slower tabs are due once now >= last run + interval - GRACE. */
export function isDue(interval: CrankInterval, lastRun: number | undefined, nowMs: number): boolean {
  if (INTERVAL_SECONDS[interval] <= ZCRANK_CRON_SECONDS) return true;
  if (lastRun === undefined) return true;
  return nowMs >= lastRun + (INTERVAL_SECONDS[interval] - ZCRANK_GRACE_SECONDS) * 1000;
}

/**
 * Display-only next run: undefined when crank is OFF, else the first 5-minute wall-clock tick
 * at or after max(now, last run + interval - GRACE - scan slack). A tick landing exactly on `now` counts
 * as "now" (the cron is firing). For <= 5m that is just the next tick.
 */
export function nextRunMs(input: { enabled: boolean; interval: CrankInterval; lastRun: number | undefined; nowMs: number }): number | undefined {
  if (!input.enabled) return undefined;
  const tick = ZCRANK_CRON_SECONDS * 1000;
  let earliest = input.nowMs;
  if (INTERVAL_SECONDS[input.interval] > ZCRANK_CRON_SECONDS && input.lastRun !== undefined) {
    const ready = input.lastRun + (INTERVAL_SECONDS[input.interval] - ZCRANK_GRACE_SECONDS) * 1000;
    earliest = Math.max(earliest, ready - ZCRANK_SCAN_SLACK_MS);
  }
  return Math.ceil(earliest / tick) * tick;
}

// ---------------------------------------------------------------------------
// Next fire for the cron shapes intervalCron() writes (host-local wall clock)
// ---------------------------------------------------------------------------

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const [range = "*", stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 59;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else {
      lo = Number(range);
      hi = stepRaw ? 59 : lo;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Next minute matching a `m h * * *` cron after `nowMs`, scanning at most two days. */
/** (Import-free so the prompt can count down to a v2 binding's own cron.) */
export function nextFire(cron: string, nowMs: number): number | undefined {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (!minute || !hour || dom !== "*" || month !== "*" || dow !== "*") return undefined;
  const start = new Date(nowMs);
  start.setSeconds(0, 0);
  for (let i = 1; i <= 2 * 24 * 60; i++) {
    const at = new Date(start.getTime() + i * 60_000);
    if (fieldMatches(minute, at.getMinutes()) && fieldMatches(hour, at.getHours())) return at.getTime();
  }
  return undefined;
}

