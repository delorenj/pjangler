// Crank-mode switches, project-native (PJAN-174).
//
// The crank engine is zcrank.py + zcrankctl (~/.local/bin), which decide per
// zellij tab whether the operator's crank beat may touch a tab. That state is
// Redis (localhost:6379, db 0): zcrank:tab:<tab> hash {enabled: 0|1},
// zcrank:pane:<tab>:<terminal_id> string overrides, zcrank:log:<tab> JSON rows
// (ts/state/action) capped at 500. This module is the pjangler-side face of
// the same switches: it never edits those scripts and never invents a second
// store — it shells out to `redis-cli --raw` and `zellij ... list-tabs
// --json` exactly the way zcrankctl does, and writes the same keys.
//
// What pjangler adds on top is the project mapping. zcrankctl is tab-native
// (you name a tab); `pj crank` is project-native (you stand in a repo). A
// project maps onto a tab by name only — nothing else correlates them — so:
//
//   1. exact canonical match against a live zellij tab,
//   2. exact canonical match against an existing zcrank:tab:* key,
//   3. prefix match either way against a live tab (zcrankctl's fuzzy rule),
//   4. else the project's own name, stored as-is, and the operator is told.
//
// Tab names carry status suffixes (gruvato 🟢, ...) in zellij; zcrankctl
// strips them before storing, so canon() here strips the same characters.
//
// PJAN-182 adds the interval throttle on top: zcrank:tab:<key> field "interval"
// (5m|1h|6h|1d, absent = follow zcrank:config interval, absent = 5m), the due /
// next-run math, and the enable-time rename migration. The due rule is a
// CONTRACT shared with zcrank.py — keep in sync with zcrank.py (CRON/GRACE,
// beat-row filter, longest-interval-wins).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, type ProjectHandle } from "../project/boardQuery";
import { cyan, dim, green, heading } from "../utils/style";

export const ZCRANK_REDIS_HOST = "127.0.0.1";
export const ZCRANK_REDIS_PORT = 6379;

/**
 * Where Redis lives: the defaults, unless ZCRANK_REDIS_HOST / ZCRANK_REDIS_PORT say
 * otherwise (zcrank.py honours the same two variables, so tests can aim both sides at a
 * throwaway redis-server instead of the live engine's). Read per call, not at import.
 */
export function redisEndpoint(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const port = Number.parseInt(env.ZCRANK_REDIS_PORT ?? "", 10);
  return {
    host: env.ZCRANK_REDIS_HOST?.trim() || ZCRANK_REDIS_HOST,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : ZCRANK_REDIS_PORT,
  };
}
export const ZCRANK_SESSION = "Workspace";
export const ZCRANK_LOG_CAP = 500;

/** Trailing status glyphs and separators zellij appends to tab names. */
const TAB_STATUS_SUFFIX = /[\s🟢🟡🔴🔔⚫✳✻●·─]+$/u;

/** Command runner seam: tests substitute this to fake redis-cli/zellij. */
export type Shell = (command: string, args: string[]) => { stdout: string; status: number };

export const defaultShell: Shell = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { stdout: "", status: 127 };
  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
};

/** Strip a live tab name's status suffix (same rule as zcrankctl). */
export function tabDisplay(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return TAB_STATUS_SUFFIX.test(trimmed) ? trimmed.replace(TAB_STATUS_SUFFIX, "").trim() : trimmed;
}

/**
 * Canonical comparison key: display form, lowercased, letters and digits only, so
 * "green-in-between" and GreenInBetween are one tab (WING-7). Same rule as zcrankctl.
 */
export function canon(name: string | undefined): string {
  return tabDisplay(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---------------------------------------------------------------------------
// Intervals, last runs, due / next-run math (PJAN-182)
// ---------------------------------------------------------------------------
//
// Keep in sync with zcrank.py: the engine applies exactly this rule when it picks which
// tabs a */5 tick may crank. pjangler only DISPLAYS "due" and "next run"; the engine decides.

export const ZCRANK_INTERVALS = ["5m", "1h", "6h", "1d"] as const;
export type CrankInterval = (typeof ZCRANK_INTERVALS)[number];
/** The global default when zcrank:config has no (valid) interval: "every tick", today's behaviour. */
export const ZCRANK_DEFAULT_INTERVAL: CrankInterval = "5m";
export const INTERVAL_SECONDS: Record<CrankInterval, number> = { "5m": 300, "1h": 3600, "6h": 21600, "1d": 86400 };
/** The Hermes crank cron (777c511a009c) ticks every 5 minutes. */
export const ZCRANK_CRON_SECONDS = 300;
/** A slow tab fires on the first tick at/after interval - GRACE, so a 1h tab slips to 55m, not 65m. */
export const ZCRANK_GRACE_SECONDS = 300;
/** Log states pjangler itself writes; every other state is a crank beat row from `zcrankctl log`. */
export const PJANGLER_LOG_STATES: readonly string[] = ["enabled", "disabled", "interval", "renamed"];

/** An interval string, or undefined for anything outside the four (garbage reads as absent). */
export function parseInterval(value: string | undefined | null): CrankInterval | undefined {
  const v = (value ?? "").trim();
  return (ZCRANK_INTERVALS as readonly string[]).includes(v) ? (v as CrankInterval) : undefined;
}

/** The longest valid interval among several keys' values, or undefined when none is set. */
export function longestInterval(values: (string | undefined | null)[]): CrankInterval | undefined {
  let best: CrankInterval | undefined;
  for (const value of values) {
    const parsed = parseInterval(value);
    if (parsed && (!best || INTERVAL_SECONDS[parsed] > INTERVAL_SECONDS[best])) best = parsed;
  }
  return best;
}

/** The interval a tab runs at: its own (longest across its keys) override, else the global default. */
export function effectiveInterval(
  keyIntervals: (string | undefined | null)[],
  global: CrankInterval,
): { interval: CrankInterval; inherited: boolean } {
  const own = longestInterval(keyIntervals);
  return own ? { interval: own, inherited: false } : { interval: global, inherited: true };
}

export interface LogRow {
  ts: string;
  tsMs: number;
  state: string;
  action: string;
}

const STRICT_LOG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A zcrank:log row, or undefined when it is not JSON / has no usable ts. Bad ts sorts as 0. */
export function parseLogRow(raw: string): LogRow | undefined {
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown; state?: unknown; action?: unknown };
    const ts = typeof parsed.ts === "string" ? parsed.ts : "";
    // Strict, like zcrank.py: only YYYY-MM-DDTHH:MM:SSZ is a timestamp. Date.parse would also take
    // "…:00.123Z" or a bare date, which the engine reads as "no run" (PJAN-182 review).
    const ms = STRICT_LOG_TS.test(ts) ? Date.parse(ts) : Number.NaN;
    return {
      ts,
      tsMs: Number.isFinite(ms) ? ms : 0,
      state: typeof parsed.state === "string" ? parsed.state : "?",
      action: typeof parsed.action === "string" ? parsed.action : "",
    };
  } catch {
    return undefined;
  }
}

/** True for a crank beat row (written by `zcrankctl log`), false for a row pjangler wrote. */
export function isBeatRow(row: Pick<LogRow, "state">): boolean {
  return !PJANGLER_LOG_STATES.includes(row.state);
}

/** Beat rows across any number of raw logs, newest first. */
export function beatRows(rawLogs: string[][]): LogRow[] {
  const rows: LogRow[] = [];
  for (const raw of rawLogs) {
    for (const line of raw) {
      const row = parseLogRow(line);
      if (row && isBeatRow(row)) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.tsMs - a.tsMs);
}

/** Epoch ms of the newest beat row across the logs, or undefined when there has been none. */
export function lastRunMs(rawLogs: string[][]): number | undefined {
  const newest = beatRows(rawLogs)[0];
  return newest && newest.tsMs > 0 ? newest.tsMs : undefined;
}

/** Due rule: <= 5m is always due; slower tabs are due once now >= last run + interval - GRACE. */
export function isDue(interval: CrankInterval, lastRun: number | undefined, nowMs: number): boolean {
  if (INTERVAL_SECONDS[interval] <= ZCRANK_CRON_SECONDS) return true;
  if (lastRun === undefined) return true;
  return nowMs >= lastRun + (INTERVAL_SECONDS[interval] - ZCRANK_GRACE_SECONDS) * 1000;
}

/**
 * Display-only next run: undefined when crank is OFF, else the first 5-minute wall-clock tick
 * at or after max(now, last run + interval - GRACE). A tick landing exactly on `now` counts
 * as "now" (the cron is firing). For <= 5m that is just the next tick.
 */
export function nextRunMs(input: { enabled: boolean; interval: CrankInterval; lastRun: number | undefined; nowMs: number }): number | undefined {
  if (!input.enabled) return undefined;
  const tick = ZCRANK_CRON_SECONDS * 1000;
  let earliest = input.nowMs;
  if (INTERVAL_SECONDS[input.interval] > ZCRANK_CRON_SECONDS && input.lastRun !== undefined) {
    earliest = Math.max(earliest, input.lastRun + (INTERVAL_SECONDS[input.interval] - ZCRANK_GRACE_SECONDS) * 1000);
  }
  return Math.ceil(earliest / tick) * tick;
}

/** "4m 12s", "1h 03m", "2d 3h"; seconds granularity under an hour. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** "3m ago" style age of a past instant. */
export function formatAge(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${formatDuration(s)} ago`;
}

// ---------------------------------------------------------------------------
// redis-cli --raw (no client dependency; pjangler adds none)
// ---------------------------------------------------------------------------

export function redis(deps: { shell?: Shell; host?: string; port?: number } = {}) {
  const shell = deps.shell ?? defaultShell;
  const endpoint = redisEndpoint();
  const host = deps.host ?? endpoint.host;
  const port = deps.port ?? endpoint.port;
  const call = (args: string[]) => shell("redis-cli", ["--raw", "-h", host, "-p", String(port), ...args]);
  // A failed redis-cli (Redis gone, error reply) throws: a write that did not land must never read
  // as success, and a dead read must not pose as "no keys / absent" (PJAN-182 review).
  const run = (...args: string[]): string => {
    const result = call(args);
    if (result.status !== 0) throw new Error(`Redis is not answering at ${host}:${port} (${args[0]} failed)`);
    return result.stdout.replace(/\r?\n$/, "");
  };
  const lines = (out: string): string[] => out.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  return {
    /** "host:port" this store talks to, for error messages. */
    endpoint: `${host}:${port}`,
    /** PING -> true only when Redis answers PONG. */
    ping: (): boolean => {
      const result = call(["PING"]);
      return result.status === 0 && result.stdout.replace(/\r?\n$/, "") === "PONG";
    },
    /** GET a plain string key; undefined when absent. */
    getKey: (key: string): string | undefined => {
      const v = run("GET", key);
      return v === "" ? undefined : v;
    },
    /** SET a plain string key (pane overrides). */
    setKey: (key: string, value: string): void => {
      run("SET", key, value);
    },
    /** HGET zcrank:tab:<tab> enabled -> "0"|"1"|undefined (absent). */
    tabEnabled: (tab: string): string | undefined => {
      const v = run("HGET", `zcrank:tab:${tab}`, "enabled");
      return v === "" || v == null ? undefined : v;
    },
    /** HSET zcrank:tab:<tab> enabled 0|1. */
    setTabEnabled: (tab: string, enabled: boolean): void => {
      run("HSET", `zcrank:tab:${tab}`, "enabled", enabled ? "1" : "0");
    },
    /** HGET zcrank:tab:<tab> interval -> a valid interval, else undefined (absent or garbage). */
    tabInterval: (tab: string): CrankInterval | undefined => parseInterval(run("HGET", `zcrank:tab:${tab}`, "interval")),
    /** HSET zcrank:tab:<tab> interval <5m|1h|6h|1d>. */
    setTabInterval: (tab: string, interval: CrankInterval): void => {
      run("HSET", `zcrank:tab:${tab}`, "interval", interval);
    },
    /** HDEL zcrank:tab:<tab> interval — the tab follows the global default again. */
    clearTabInterval: (tab: string): void => {
      run("HDEL", `zcrank:tab:${tab}`, "interval");
    },
    /** HGET zcrank:config interval, falling back to 5m (garbage reads as absent). */
    globalInterval: (): CrankInterval => parseInterval(run("HGET", "zcrank:config", "interval")) ?? ZCRANK_DEFAULT_INTERVAL,
    /** All zcrank:tab:* keys (raw key per line). */
    tabKeys: (): string[] => lines(run("KEYS", "zcrank:tab:*")),
    /** zcrank:pane:<tab>:<terminal_id> keys of exactly this tab (never a colon-named sibling's). */
    paneKeys: (tab: string): string[] => {
      const prefix = `zcrank:pane:${tab}:`;
      return lines(run("KEYS", `${redisGlobEscape(prefix)}*`)).filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes(":"));
    },
    /** DEL the given keys (no-op for none). */
    deleteKeys: (...keys: string[]): void => {
      if (keys.length) run("DEL", ...keys);
    },
    /** RPUSH a log row, then LTRIM to the zcrankctl cap. */
    pushLog: (tab: string, state: string, action: string, ts: string): void => {
      run("RPUSH", `zcrank:log:${tab}`, JSON.stringify({ ts, state, action }));
      run("LTRIM", `zcrank:log:${tab}`, String(-ZCRANK_LOG_CAP), "-1");
    },
    /** LRANGE 0 -1, oldest first (newest last) — zcrankctl's display order. */
    logRows: (tab: string): string[] => lines(run("LRANGE", `zcrank:log:${tab}`, "0", "-1")),
    /**
     * Replace a whole log list atomically (RPUSH to a scratch key, then RENAME over the
     * real one), so the engine's own `zcrankctl log` never sees a half-written list.
     */
    replaceLog: (tab: string, rows: string[]): void => {
      const dest = `zcrank:log:${tab}`;
      if (!rows.length) {
        run("DEL", dest);
        return;
      }
      const scratch = `zcrank:logtmp:${process.pid}:${Date.now()}`;
      run("DEL", scratch);
      run("RPUSH", scratch, ...rows);
      run("RENAME", scratch, dest);
    },
  };
}

export type CrankStore = ReturnType<typeof redis>;

/** Escape redis glob metacharacters so a tab name matches itself in KEYS. */
export function redisGlobEscape(text: string): string {
  return text.replace(/[\\*?\[\]^]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// zellij live tabs
// ---------------------------------------------------------------------------

export interface LiveTab {
  name: string;
  position: number;
}

/**
 * Live zellij tab names for the Workspace session.
 *
 * `env -u ZELLIJ -u ZELLIJ_SESSION_NAME` is required — zellij refuses to
 * operate on itself when invoked from inside a pane — and `timeout 5s`
 * bounds a wedged daemon, both copied from zcrankctl.
 */
export function liveTabs(deps: { shell?: Shell } = {}): LiveTab[] {
  const shell = deps.shell ?? defaultShell;
  const result = shell("env", [
    "-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME",
    "timeout", "5s", "zellij", "-s", ZCRANK_SESSION, "action", "list-tabs", "--json",
  ]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({ name: String(entry.name ?? ""), position: Number(entry.position ?? 0) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Project → tab resolution
// ---------------------------------------------------------------------------

export type TabSource = "live-exact" | "redis-exact" | "live-prefix" | "project-name";

export interface TabResolution {
  /** The name stored under zcrank:tab:<this>. */
  tab: string;
  source: TabSource;
  /** Which candidate name matched ("agent:<handle>" for agent-derived matches). */
  matched: string;
  /** True when no live tab and no Redis key matched, so the project name was stored as-is. */
  storedAsIs: boolean;
  /**
   * The live tab's display name (status glyphs stripped) when the match came from a live
   * tab (live-exact, live-prefix). `tab` may keep an older spelling that already has a key;
   * the live display name is what `pj crank enable` migrates every old key onto (PJAN-182).
   */
  liveTab?: string;
}

/** A project's candidate names for tab matching, in precedence order. */
export interface ProjectNames {
  /** The registry record's display name (or manifest project_name). */
  name: string;
  /** Agent handles with their roles, e.g. { handle: "pile-of-dumb-things-pm", role: "pm" }. */
  agents: { handle: string; role: string }[];
}

/**
 * Every name a project may legitimately answer to on a zellij tab.
 *
 * Tabs are named after the WORK (the operator's own words: "Pile of Dumb
 * Things"), while the registry record may carry the formal project name
 * ("Tower of Lost Things"). The agent handles minted at init —
 * `<tab-slug>-<role>` — are the bridge: "pile-of-dumb-things-pm" minus its
 * role suffix slugifies to exactly the tab's canonical name.
 */
export function candidateNames(project: ProjectNames): string[] {
  const out = [project.name.trim()].filter(Boolean);
  for (const agent of project.agents) {
    const handle = (agent.handle ?? "").trim();
    if (!handle) continue;
    const role = (agent.role ?? "").trim().toLowerCase();
    const base = role && handle.toLowerCase().endsWith(`-${role}`)
      ? handle.slice(0, handle.length - role.length - 1)
      : handle;
    const spaced = base.replace(/[-_]+/g, " ").trim();
    if (spaced && !out.some((existing) => canon(existing) === canon(spaced))) out.push(spaced);
  }
  return out;
}

/**
 * Resolve which zcrank tab a project owns, trying every candidate name
 * through zcrankctl's ladder: live-exact, redis-exact, live-prefix, then
 * the project's own name stored as-is. Never throws for a miss.
 */
export function resolveTabForProject(
  project: ProjectNames,
  live: LiveTab[],
  storedTabs: string[],
): TabResolution {
  const candidates = candidateNames(project);
  // A live tab that already has a key keeps it, even when the name drifted from it in
  // case or punctuation ("green-in-between" vs GreenInBetween). Writing the live spelling
  // instead minted a second key next to it (WING-7). Only an equal canon counts: a colon
  // head ("IPM: Navi" vs IPM) would make sibling tabs share one switch.
  const keyFor = (tab: LiveTab): string => {
    const display = tabDisplay(tab.name);
    if (storedTabs.includes(display)) return display;
    return storedTabs.find((s) => canon(s) && canon(s) === canon(display)) ?? display;
  };
  // 1. Exact match on a live tab (live is the authority): whole names first, then either
  //    side of a colon, so project navi owns the tab "IPM: Navi" but a tab named exactly
  //    "Navi" wins over it.
  const sideSets: ((tab: LiveTab) => string[])[] = [
    (tab) => [tab.name],
    (tab) => tabDisplay(tab.name).split(":"),
  ];
  for (const sides of sideSets) {
    for (const candidate of candidates) {
      for (const tab of live) {
        if (sides(tab).some((side) => canon(side) && canon(side) === canon(candidate))) {
          return { tab: keyFor(tab), source: "live-exact", matched: candidate, storedAsIs: false, liveTab: tabDisplay(tab.name) };
        }
      }
    }
  }
  // 2. Exact match on an existing zcrank:tab:* key (a tab that was cranked
  //    before but is not open now keeps its stored name).
  for (const candidate of candidates) {
    for (const stored of storedTabs) {
      if (canon(stored) && canon(stored) === canon(candidate)) {
        return { tab: stored, source: "redis-exact", matched: candidate, storedAsIs: false };
      }
    }
  }
  // 3. Prefix match either way against a live tab (zcrankctl's fuzzy rule).
  for (const candidate of candidates) {
    const canonical = canon(candidate);
    for (const tab of live) {
      const tabCanonical = canon(tab.name);
      // Empty on either side would match everything (an emoji-only tab, a symbol name).
      if (!canonical || !tabCanonical) continue;
      if (tabCanonical.startsWith(canonical) || canonical.startsWith(tabCanonical)) {
        return { tab: keyFor(tab), source: "live-prefix", matched: candidate, storedAsIs: false, liveTab: tabDisplay(tab.name) };
      }
    }
  }
  // 4. Nothing matches: store the project's own name and say so.
  return { tab: tabDisplay(project.name), source: "project-name", matched: project.name, storedAsIs: true };
}

/** A project's display name: registry record first, then the manifest, then the slug. */
export function projectNameFor(handle: ProjectHandle, registryName?: string): string {
  if (registryName && registryName.trim()) return registryName.trim();
  try {
    const manifest = JSON.parse(readFileSync(join(handle.root, ".project.json"), "utf8")) as Record<string, unknown>;
    const name = manifest.project_name;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // fall through
  }
  return handle.slug;
}

/** Agent handles with roles for a project root: registry record first, then the manifest. */
export function projectAgentsFor(handle: ProjectHandle, registryAgents?: Record<string, { role?: string }>): { handle: string; role: string }[] {
  const fromRecord = Object.entries(registryAgents ?? {})
    .map(([agentHandle, value]) => ({ handle: agentHandle, role: String(value?.role ?? "") }));
  if (fromRecord.length) return fromRecord;
  try {
    const manifest = JSON.parse(readFileSync(join(handle.root, ".project.json"), "utf8")) as Record<string, unknown>;
    const agents = manifest.agents;
    if (agents && typeof agents === "object" && !Array.isArray(agents)) {
      return Object.entries(agents as Record<string, { role?: unknown }>)
        .map(([agentHandle, value]) => ({ handle: agentHandle, role: typeof value?.role === "string" ? value.role : "" }));
    }
  } catch {
    // fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// Keys naming a tab, snapshot, and the writes behind enable / disable / interval
// ---------------------------------------------------------------------------

/** Every stored key that names this tab: the key itself plus each key with an equal canon (WING-7). */
export function keysNamingTab(tab: string, storedKeys: string[]): string[] {
  const c = canon(tab);
  const out: string[] = [];
  if (storedKeys.includes(tab)) out.push(tab);
  for (const key of storedKeys) {
    if (key !== tab && c && canon(key) === c) out.push(key);
  }
  return out;
}

/** Everything a crank screen shows about one project's tab, read from Redis at `nowMs`. */
export interface CrankSnapshot {
  tab: string;
  /** Every key naming the tab (empty when nothing is stored yet). */
  keys: string[];
  /** ON only when every key naming the tab is ON (the engine's rule); undefined when none says. */
  enabled: boolean | undefined;
  /** The longest interval set on any of the keys, if any. */
  override: CrankInterval | undefined;
  global: CrankInterval;
  interval: CrankInterval;
  inherited: boolean;
  lastRunMs: number | undefined;
  /** Newest beat rows first. */
  beats: LogRow[];
  due: boolean;
  nextRunMs: number | undefined;
  /** Every log row across the keys, oldest first (raw JSON strings). */
  log: string[];
  readAtMs: number;
}

/** Read one tab's crank state. Pure reads: never writes. */
export function snapshotCrank(store: CrankStore, tab: string, storedKeys: string[], nowMs: number, beatLimit = 5): CrankSnapshot {
  const keys = keysNamingTab(tab, storedKeys);
  const readKeys = keys.length ? keys : [tab];
  const enabledValues = keys.map((key) => store.tabEnabled(key)).filter((v): v is string => v !== undefined);
  const enabled = enabledValues.length ? keys.length > 0 && keys.every((key) => store.tabEnabled(key) === "1") : undefined;
  const global = store.globalInterval();
  const { interval, inherited } = effectiveInterval(readKeys.map((key) => store.tabInterval(key)), global);
  const logs = readKeys.map((key) => store.logRows(key));
  const lastRun = lastRunMs(logs);
  return {
    tab,
    keys,
    enabled,
    override: inherited ? undefined : interval,
    global,
    interval,
    inherited,
    lastRunMs: lastRun,
    beats: beatRows(logs).slice(0, beatLimit),
    due: isDue(interval, lastRun, nowMs),
    nextRunMs: nextRunMs({ enabled: enabled === true, interval, lastRun, nowMs }),
    log: mergeLogRows(logs.slice(1), logs[0] ?? [], Number.MAX_SAFE_INTEGER),
    readAtMs: nowMs,
  };
}

// --- rename migration ------------------------------------------------------

export interface RenamePlan {
  /** The live tab's display name: the one key everything is merged onto. */
  target: string;
  /** Other stored keys that name this same tab under an old spelling; removed after the merge. */
  oldKeys: string[];
  /** The interval to carry onto the target (longest across the old keys), only when it has none. */
  carryInterval: CrankInterval | undefined;
}

/**
 * Plan the enable-time rename migration (pure). Only when the project resolved to a LIVE tab:
 * the target is that tab's display name, and an old key is any OTHER stored key whose canon
 * equals the canon of one of the project's candidate names or of the live display name.
 * Keys that merely prefix- or colon-match are never touched ("IPM" next to "IPM: Navi" is a
 * sibling tab's switch), and neither is a key that is some OTHER live tab's own spelling.
 */
export function planRenameMigration(input: {
  resolution: TabResolution;
  candidates: string[];
  storedKeys: string[];
  live: LiveTab[];
  intervals: (key: string) => CrankInterval | undefined;
  /** An interval the user chose in the same breath: it wins, so nothing is carried. */
  chosenInterval?: CrankInterval;
}): RenamePlan | undefined {
  const target = input.resolution.liveTab;
  if (!target || (input.resolution.source !== "live-exact" && input.resolution.source !== "live-prefix")) return undefined;
  const targetCanon = canon(target);
  const wanted = new Set([targetCanon, ...input.candidates.map((name) => canon(name))].filter(Boolean));
  const otherLive = new Set(input.live.map((tab) => canon(tab.name)).filter((c) => c && c !== targetCanon));
  const oldKeys = [...new Set(input.storedKeys)].filter((key) => {
    if (key === target) return false;
    const c = canon(key);
    return c !== "" && wanted.has(c) && !otherLive.has(c);
  });
  const carryInterval = input.chosenInterval || input.intervals(target) ? undefined : longestInterval(oldKeys.map((key) => input.intervals(key)));
  return { target, oldKeys, carryInterval };
}

/** Merge log lists by ts (oldest first), keep the newest `cap`. Unparseable rows sort first, stably. */
export function mergeLogRows(others: string[][], base: string[], cap: number = ZCRANK_LOG_CAP): string[] {
  const tagged = [base, ...others].flat().map((raw, order) => ({ raw, order, ms: parseLogRow(raw)?.tsMs ?? 0 }));
  tagged.sort((a, b) => a.ms - b.ms || a.order - b.order);
  const rows = tagged.map((entry) => entry.raw);
  return rows.length > cap ? rows.slice(rows.length - cap) : rows;
}

/**
 * Apply a RenamePlan to Redis: carry interval, merge logs, move pane overrides, drop old tab/log keys.
 * A pane override under an old spelling is MOVED onto the target (a pane turned OFF stays OFF); when
 * both spellings carry one, any OFF wins, which is what the engine does across spellings.
 */
export function applyRenameMigration(store: CrankStore, plan: RenamePlan): void {
  if (plan.carryInterval) store.setTabInterval(plan.target, plan.carryInterval);
  for (const old of plan.oldKeys) {
    const merged = mergeLogRows([store.logRows(old)], store.logRows(plan.target));
    store.replaceLog(plan.target, merged);
    const oldPanes = store.paneKeys(old);
    const prefix = `zcrank:pane:${old}:`;
    for (const paneKey of oldPanes) {
      const targetKey = `zcrank:pane:${plan.target}:${paneKey.slice(prefix.length)}`;
      const oldValue = store.getKey(paneKey);
      const existing = store.getKey(targetKey);
      if (oldValue === undefined) continue;
      const value = existing === undefined ? oldValue : existing === "1" && oldValue === "1" ? "1" : "0";
      if (value !== existing) store.setKey(targetKey, value);
    }
    store.deleteKeys(`zcrank:tab:${old}`, ...oldPanes, `zcrank:log:${old}`);
  }
}

/** What a crank screen needs to resolve a project's tab and write to it. */
export interface CrankContext {
  resolution: TabResolution;
  candidates: string[];
  live: LiveTab[];
  storedKeys: string[];
}

/** Resolve the project onto a tab from the current live tabs and stored keys. */
export function buildCrankContext(project: ProjectNames, live: LiveTab[], storedKeys: string[]): CrankContext {
  return { resolution: resolveTabForProject(project, live, storedKeys), candidates: candidateNames(project), live, storedKeys };
}

/** Stored zcrank:tab:* keys with the prefix stripped. */
export function storedTabKeys(store: CrankStore): string[] {
  return store.tabKeys().map((key) => key.split(":").slice(2).join(":"));
}

export interface EnableResult {
  /** The key crank is now ON under (the live tab's display name when the project resolved to one). */
  tab: string;
  renamed: { from: string; to: string }[];
  interval: CrankInterval | undefined;
}

/**
 * `pj crank enable`, shared by the CLI and the TUI: set enabled=1 under the target key,
 * write the chosen interval, run the rename migration, then log (enabled / interval / renamed).
 * With no live tab nothing migrates and the key is the resolution's, but other spellings that
 * still name the tab are switched ON too (and lose any interval the chosen one must beat).
 */
export function enableCrank(store: CrankStore, ctx: CrankContext, options: { interval?: CrankInterval; now?: Date } = {}): EnableResult {
  const now = options.now ?? new Date();
  const ts = crankTimestamp(now);
  const plan = planRenameMigration({
    resolution: ctx.resolution,
    candidates: ctx.candidates,
    storedKeys: ctx.storedKeys,
    live: ctx.live,
    intervals: (key) => store.tabInterval(key),
    chosenInterval: options.interval,
  });
  const tab = plan?.target ?? ctx.resolution.tab;
  store.setTabEnabled(tab, true);
  if (options.interval) store.setTabInterval(tab, options.interval);
  if (plan) applyRenameMigration(store, plan);
  else {
    // No live tab, so nothing migrates. Other spellings of the key still name this tab to the engine
    // (any OFF wins, the longest interval wins), so bring them along: ON, and the chosen interval
    // not overridden by a stale longer one.
    for (const sibling of keysNamingTab(tab, ctx.storedKeys)) {
      if (sibling === tab) continue;
      store.setTabEnabled(sibling, true);
      if (options.interval) store.clearTabInterval(sibling);
    }
  }
  if (options.interval) store.pushLog(tab, "interval", `pj crank enable: interval ${options.interval}`, ts);
  store.pushLog(tab, "enabled", "pj crank enable", ts);
  const renamed = (plan?.oldKeys ?? []).map((from) => ({ from, to: tab }));
  for (const { from, to } of renamed) store.pushLog(tab, "renamed", `pj crank enable: ${from} -> ${to}`, ts);
  return { tab, renamed, interval: options.interval ?? plan?.carryInterval };
}

/** `pj crank disable`: enabled=0 plus a log row, under the resolved key. */
export function disableCrank(store: CrankStore, tab: string, now: Date = new Date()): void {
  store.setTabEnabled(tab, false);
  store.pushLog(tab, "disabled", "pj crank disable", crankTimestamp(now));
}

/**
 * Set (or, with undefined, reset to the global default) a tab's interval. Written under
 * `tab` and cleared from every other key naming it, so the longest-wins rule across spellings
 * can never override what the operator just picked.
 */
export function setCrankInterval(store: CrankStore, tab: string, storedKeys: string[], interval: CrankInterval | undefined, now: Date = new Date()): void {
  for (const key of keysNamingTab(tab, storedKeys)) {
    if (key !== tab) store.clearTabInterval(key);
  }
  if (interval) store.setTabInterval(tab, interval);
  else store.clearTabInterval(tab);
  const action = interval ? `pj crank tui: interval ${interval}` : `pj crank tui: interval reset to global (${store.globalInterval()})`;
  store.pushLog(tab, "interval", action, crankTimestamp(now));
}

// ---------------------------------------------------------------------------
// Registry view (pj crank list)
// ---------------------------------------------------------------------------

export interface CrankListRow {
  slug: string;
  name: string;
  tab: string;
  crank: "ON" | "OFF" | "—";
  source: TabSource;
  /** Effective interval, and whether it is the global default rather than the tab's own. */
  interval: CrankInterval;
  inherited: boolean;
}

export interface CrankListReport {
  rows: CrankListRow[];
  orphans: { tab: string; enabled: boolean; interval: CrankInterval; inherited: boolean }[];
}

export interface CrankProjectRecord {
  slug: string;
  name: string;
  repoPath: string;
  /** Agent handles with roles, used as extra tab-name candidates. */
  agents: { handle: string; role: string }[];
}

/** Build the crank list from registry projects plus live/stored tab state. */
export function buildCrankList(input: {
  projects: CrankProjectRecord[];
  live: LiveTab[];
  storedTabs: string[];
  tabEnabled: (tab: string) => string | undefined;
  /** A key's own interval; omitted = nothing is overridden. */
  tabInterval?: (tab: string) => CrankInterval | undefined;
  globalInterval?: CrankInterval;
}): CrankListReport {
  const global = input.globalInterval ?? ZCRANK_DEFAULT_INTERVAL;
  const intervalOf = (tab: string) => effectiveInterval(
    (keysNamingTab(tab, input.storedTabs).length ? keysNamingTab(tab, input.storedTabs) : [tab]).map((key) => input.tabInterval?.(key)),
    global,
  );
  const rows: CrankListRow[] = [];
  const consumed = new Set<string>();
  for (const project of input.projects) {
    const resolution = resolveTabForProject(project, input.live, input.storedTabs);
    consumed.add(canon(resolution.tab));
    const enabled = input.tabEnabled(resolution.tab);
    rows.push({
      slug: project.slug,
      name: project.name,
      tab: resolution.tab,
      crank: enabled === "1" ? "ON" : enabled === "0" ? "OFF" : "—",
      source: resolution.source,
      ...intervalOf(resolution.tab),
    });
  }
  const orphans = input.storedTabs
    .filter((stored) => !consumed.has(canon(stored)))
    .map((stored) => ({ tab: stored, enabled: input.tabEnabled(stored) === "1", ...intervalOf(stored) }));
  return { rows, orphans };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `2026-10-20T12:34:56Z`-shaped UTC stamp, matching zcrankctl's log rows. */
export function crankTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One log row as `ts  state  action`, or null when the row is not JSON. */
export function renderLogRow(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown; state?: unknown; action?: unknown };
    const ts = typeof parsed.ts === "string" ? parsed.ts : "";
    const state = typeof parsed.state === "string" ? parsed.state : "?";
    const action = typeof parsed.action === "string" ? parsed.action : "";
    return `${ts}  ${state.padEnd(12)}${action}`;
  } catch {
    return null;
  }
}

export function formatCrankList(report: CrankListReport): string {
  const lines: string[] = [""];
  lines.push(`  ${heading("Crank by project")}`);
  lines.push("");
  const slugWidth = Math.max("PROJECT".length, ...report.rows.map((row) => row.slug.length));
  const tabWidth = Math.max("TAB".length, ...report.rows.map((row) => row.tab.length), ...report.orphans.map((orphan) => orphan.tab.length));
  const intervalCell = (row: { interval: CrankInterval; inherited: boolean }) =>
    row.inherited ? dim(`${row.interval} (global)`) : row.interval;
  lines.push(`  ${"PROJECT".padEnd(slugWidth)}  ${"TAB".padEnd(tabWidth)}  ${"CRANK".padEnd(5)}  INTERVAL`);
  for (const row of report.rows) {
    const state = row.crank === "ON" ? green("ON") : row.crank === "OFF" ? dim("OFF") : dim("—");
    lines.push(`  ${cyan(row.slug.padEnd(slugWidth))}  ${row.tab.padEnd(tabWidth)}  ${state}${" ".repeat(Math.max(0, 5 - (row.crank === "ON" ? 2 : row.crank === "OFF" ? 3 : 1)))}  ${intervalCell(row)}`);
  }
  if (report.orphans.length) {
    lines.push("");
    lines.push(`  ${dim("zcrank keys with no matching project")}`);
    for (const orphan of report.orphans) {
      lines.push(`  ${" ".repeat(slugWidth)}  ${orphan.tab.padEnd(tabWidth)}  ${orphan.enabled ? green("ON ") : dim("OFF")}    ${intervalCell(orphan)}  ${dim("(no project)")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
