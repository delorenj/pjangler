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
// PJAN-201 adds a second, name-independent correlation: the project's ROOT. A zcrank:tab:<key>
// hash may carry `root` (the project identity that owns the switch), and a live tab is owned by
// the project whose repo holds a strict plurality of its terminal panes' cwds. The engine
// (zcrank.py) and pj then read a tab's switches as: keys whose canon name matches UNION keys whose
// root equals the tab's owner. Renaming a tab no longer orphans its switches. The new FIRST
// resolution rung ("live-cwd") finds a project's tab by where its panes stand, not what the tab
// is called. zellij's list-panes drops pane_cwd for a random subset of panes on every call, so pj
// and the engine fill the gaps from ONE shared memory (pane-cwds.json, 6h, per pane id + tab) and
// retry; a pane that never reports stays unknown and is ignored (rule 3, amended in the PJAN-201 review).
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
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProject, type ProjectHandle } from "../project/boardQuery";
import { cyan, dim, green, heading, yellow } from "../utils/style";
import { engineSummary, type EngineStatus } from "./engine";

export * from "./engine";

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
export type Shell = (command: string, args: string[]) => { stdout: string; status: number; stderr?: string };

export const defaultShell: Shell = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { stdout: "", status: 127 };
  return { stdout: result.stdout ?? "", status: result.status ?? 1, stderr: result.stderr ?? "" };
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
  // -e (redis-tools >= 6.2; CI's apt redis-cli 7.0.15 and the dev box's 8.0.2 both have it)
  // moves a Redis error reply from stdout to stderr and exits non-zero. Without it redis-cli
  // exits 0 on WRONGTYPE/ERR replies, so the error text posed as a value and a failed write
  // read as success (PJAN-186). The exit code — never stdout sniffing — tells a value from an
  // error reply: a stored "WRONGTYPE ..." or "ERR no such key" string still reads back as itself.
  const call = (args: string[]) => shell("redis-cli", ["--raw", "-e", "-h", host, "-p", String(port), ...args]);
  // Fail loudly when the installed redis-cli proves (via its own --help) too old for -e,
  // instead of silently regressing to errors-as-values. An unreadable help page (a fake in
  // tests, an odd PATH) stays permissive: the call goes out with -e and its own failure names it.
  let errorExitSupport: "unprobed" | "yes" | "no" | "unknown" = "unprobed";
  const requireErrorExit = (): void => {
    if (errorExitSupport === "unprobed") {
      const help = shell("redis-cli", ["--help"]);
      errorExitSupport = help.status === 0 && /^usage: redis-cli/im.test(help.stdout)
        ? (/(^|\n)\s+-e\s/.test(help.stdout) ? "yes" : "no")
        : "unknown";
    }
    if (errorExitSupport === "no") {
      throw new Error(
        `redis-cli is too old for the crank store at ${host}:${port}: no -e flag (needs redis-tools >= 6.2) to fail on Redis error replies — upgrade redis-tools`,
      );
    }
  };
  // redis-cli's own failures (never a reply): connection refused ("Could not connect to Redis
  // at ..."), a dropped connection ("Error: ..."), a missing binary or a killed timeout (no
  // stderr at all). Anything else on stderr is the server's error reply, verbatim.
  const notAnswering = (stderr: string): boolean =>
    !stderr || stderr.startsWith("Could not connect to Redis at") || stderr.startsWith("Error: ");
  // A failed redis-cli (Redis gone, error reply) throws: a write that did not land must never read
  // as success, and a dead read must not pose as "no keys / absent" (PJAN-182 review).
  const run = (...args: string[]): string => {
    requireErrorExit();
    const result = call(args);
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      if (notAnswering(stderr)) throw new Error(`Redis is not answering at ${host}:${port} (${args[0]} failed)`);
      throw new Error(`Redis error reply at ${host}:${port}: ${stderr.split("\n")[0]} (${args.join(" ")})`);
    }
    return result.stdout.replace(/\r?\n$/, "");
  };
  const lines = (out: string): string[] => out.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  return {
    /** "host:port" this store talks to, for error messages. */
    endpoint: `${host}:${port}`,
    /** PING -> true only when Redis answers PONG. */
    ping: (): boolean => {
      requireErrorExit();
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
    /** HGET zcrank:tab:<tab> root -> the owning project identity, or undefined (legacy key / absent). */
    tabRoot: (tab: string): string | undefined => {
      const v = run("HGET", `zcrank:tab:${tab}`, "root");
      return v === "" || v == null ? undefined : v;
    },
    /** HSET zcrank:tab:<tab> root <project identity> (PJAN-201). */
    setTabRoot: (tab: string, root: string): void => {
      run("HSET", `zcrank:tab:${tab}`, "root", root);
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
  /** zellij's stable-per-session tab_id (list-tabs), when known. */
  id?: number;
  /** PJAN-201: the project identity holding a strict plurality of the tab's terminal panes, if any. */
  owner?: string;
  /** PJAN-201: how many identified terminal panes each project identity holds in this tab. */
  ownedPanes?: Record<string, number>;
}

/** One zellij pane from `list-panes --json --all` (PJAN-201). */
export interface LivePane {
  id: number;
  tabId?: number;
  tabPosition?: number;
  tabName: string;
  isPlugin: boolean;
  /** pane_cwd; absent for some panes (treated as unknown). */
  cwd?: string;
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
      .map((entry) => {
        const id = Number(entry.tab_id);
        return {
          name: String(entry.name ?? ""),
          position: Number(entry.position ?? 0),
          ...(entry.tab_id !== undefined && entry.tab_id !== null && Number.isInteger(id) ? { id } : {}),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Live zellij panes (every tab, plugins included) for the Workspace session; [] when unreadable.
 * list-panes takes ~4s (measured 2026-11-04), hence 8s like the engine, not the 5s of list-tabs.
 */
export function livePanes(deps: { shell?: Shell } = {}): LivePane[] {
  const shell = deps.shell ?? defaultShell;
  const result = shell("env", [
    "-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME",
    "timeout", "8s", "zellij", "-s", ZCRANK_SESSION, "action", "list-panes", "--json", "--all",
  ]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    const panes: LivePane[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const id = Number(e.id);
      if (!Number.isFinite(id)) continue;
      const tabId = Number(e.tab_id);
      const tabPosition = Number(e.tab_position);
      panes.push({
        id,
        tabId: e.tab_id !== undefined && e.tab_id !== null && Number.isInteger(tabId) ? tabId : undefined,
        tabPosition: e.tab_position !== undefined && e.tab_position !== null && Number.isInteger(tabPosition) ? tabPosition : undefined,
        tabName: String(e.tab_name ?? ""),
        isPlugin: e.is_plugin === true,
        cwd: typeof e.pane_cwd === "string" && e.pane_cwd.trim() ? e.pane_cwd : undefined,
      });
    }
    return panes;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Project identity and tab ownership (PJAN-201)
// ---------------------------------------------------------------------------

/** Per-command memo of dir -> identity (null = looked, none). */
export type IdentityCache = Map<string, string | null>;

/** Total time one scan may spend in `git worktree list` calls (the engine's BUDGET is 20s too). */
export interface IdentityBudget {
  totalMs: number;
  /** Set by the first git call: the instant the budget runs out. */
  untilMs?: number;
}

/**
 * Project identity of a directory: the MAIN worktree path of the repo containing it (the
 * first `worktree <path>` line of `git worktree list --porcelain`), realpath'd. A linked
 * worktree maps to its main repo; a submodule is its own repo. Not a repo, git failing, or
 * a 2s timeout => undefined. Memoised in `cache` for the life of one scan / command.
 */
export function projectIdentity(dir: string | undefined, deps: { shell?: Shell; cache?: IdentityCache; budget?: IdentityBudget } = {}): string | undefined {
  const target = (dir ?? "").trim();
  if (!target) return undefined;
  const cached = deps.cache?.get(target);
  if (cached !== undefined) return cached ?? undefined;
  if (deps.budget) {
    // Like the engine (zcrank_identity.BUDGET): once one scan has spent its git time, the rest
    // get no identity (not cached) instead of stretching the refresh on a slow filesystem.
    deps.budget.untilMs ??= Date.now() + deps.budget.totalMs;
    if (Date.now() > deps.budget.untilMs) return undefined;
  }
  const shell = deps.shell ?? defaultShell;
  let identity: string | undefined;
  try {
    const result = shell("timeout", ["2s", "git", "-C", target, "worktree", "list", "--porcelain"]);
    if (result.status === 0) {
      const first = result.stdout.split("\n").find((line) => line.startsWith("worktree "));
      const path = first?.slice("worktree ".length).replace(/\r$/, "").trim();
      if (path) identity = realpathSync(path);
    }
  } catch {
    identity = undefined;
  }
  deps.cache?.set(target, identity ?? null);
  return identity;
}

/**
 * Attach each live tab's owner: the identity held by a STRICT plurality of its terminal
 * (non-plugin) panes that have an identity. Panes without a cwd or identity are ignored; a
 * tie, or no identified pane, means no owner. Panes join tabs by tab_id (else tab position).
 */
export function withTabOwners(
  tabs: LiveTab[],
  panes: LivePane[],
  identify: (cwd: string) => string | undefined,
  claimed: Iterable<string> = [],
): LiveTab[] {
  const claimedSet = new Set(claimed);
  return tabs.map((tab) => {
    const counts = new Map<string, number>();
    for (const pane of panes) {
      if (pane.isPlugin || !pane.cwd) continue;
      const inTab = tab.id !== undefined && pane.tabId !== undefined ? pane.tabId === tab.id : pane.tabPosition === tab.position;
      if (!inTab) continue;
      const identity = identify(pane.cwd);
      if (identity) counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // A tie at the top goes to the single tied identity some zcrank:tab key already claims as its
    // root (an operator pane from another repo must not orphan the project's switch); zero or
    // several claimed => no owner. Keep in sync with zcrank_identity.tab_owner.
    const tied = ranked.filter(([, n]) => n === ranked[0]?.[1]).map(([identity]) => identity);
    const claimedTied = tied.filter((identity) => claimedSet.has(identity));
    const owner = tied.length === 1 ? tied[0] : claimedTied.length === 1 ? claimedTied[0] : undefined;
    const enriched: LiveTab = { ...tab };
    if (owner) enriched.owner = owner;
    if (ranked.length) enriched.ownedPanes = Object.fromEntries(ranked);
    return enriched;
  });
}

// zellij's list-panes drops pane_cwd for a random subset of terminal panes on every call (measured
// live 2026-11-04: 0..11 of 18 over consecutive calls), which would flap a tab's owner. The engine
// (zcrank_identity.resolve_panes) therefore remembers the last cwd zellij reported per pane in
// ~/.local/state/zcrank/pane-cwds.json and retries. pj reads and writes THE SAME FILE with the same
// rule, so both sides derive a tab's owner from the same inputs. Keep in sync with zcrank_identity.py.

/** A remembered pane cwd is trusted this long when zellij withholds it (engine CWD_TTL). */
export const PANE_CWD_TTL_SECONDS = 6 * 3600;

/** The engine's pane-cwd memory (override: ZCRANK_CWD_CACHE, which the engine honours too). */
export function paneCwdCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCRANK_CWD_CACHE?.trim() || join(homedir(), ".local/state/zcrank/pane-cwds.json");
}

interface CwdEntry {
  cwd?: unknown;
  tab_id?: unknown;
  ts?: unknown;
}

function loadCwdCache(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveCwdCache(path: string, cache: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, path);
  } catch {
    // a cache we cannot write only costs stability, never correctness
  }
}

/** A cache entry younger than the TTL. A malformed entry (junk ts, not an object) is stale, never an error. */
function cwdEntryFresh(entry: unknown, nowSeconds: number): entry is CwdEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const ts = Number((entry as CwdEntry).ts ?? 0);
  return Number.isFinite(ts) && nowSeconds - ts < PANE_CWD_TTL_SECONDS;
}

/**
 * The panes from `fetch()`, each terminal pane's missing cwd filled from the last cwd zellij
 * reported for that same pane (same id AND tab, younger than the TTL). While terminal panes remain
 * unknown, fetch again up to `retries` times and take any cwd the new call has. Reported cwds
 * refresh the shared memory; entries for gone or expired panes are dropped. Never throws.
 */
export function resolvePaneCwds(
  fetch: () => LivePane[],
  opts: { retries?: number; nowMs?: number; cachePath?: string } = {},
): LivePane[] {
  const now = (opts.nowMs ?? Date.now()) / 1000;
  const path = opts.cachePath ?? paneCwdCachePath();
  const get = (): LivePane[] => {
    try {
      const rows = fetch();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const panes = get();
  if (!panes.length) return panes;
  const cache = loadCwdCache(path);
  const sameTab = (entry: CwdEntry, pane: LivePane): boolean => (entry.tab_id ?? null) === (pane.tabId ?? null);
  const fill = (): number => {
    let unknown = 0;
    for (const pane of panes) {
      if (pane.isPlugin) continue;
      const key = String(pane.id);
      if (pane.cwd) {
        cache[key] = { cwd: pane.cwd, tab_id: pane.tabId ?? null, ts: now };
        continue;
      }
      const entry = cache[key];
      if (cwdEntryFresh(entry, now) && sameTab(entry, pane) && typeof entry.cwd === "string" && entry.cwd) {
        pane.cwd = entry.cwd;
      } else {
        unknown++;
      }
    }
    return unknown;
  };
  let unknown = fill();
  for (let attempt = 0; attempt < (opts.retries ?? 0) && unknown; attempt++) {
    const again = new Map(get().filter((pane) => pane.cwd).map((pane) => [pane.id, pane.cwd as string]));
    for (const pane of panes) {
      const cwd = again.get(pane.id);
      if (!pane.isPlugin && !pane.cwd && cwd) pane.cwd = cwd;
    }
    unknown = fill();
  }
  const live = new Set(panes.filter((pane) => !pane.isPlugin).map((pane) => String(pane.id)));
  for (const key of Object.keys(cache)) {
    if (!live.has(key) || !cwdEntryFresh(cache[key], now)) delete cache[key];
  }
  saveCwdCache(path, cache);
  return panes;
}

/**
 * Live tabs with their pane-derived owners, read from zellij. Never throws: no panes => no owners.
 * Pane cwds zellij withholds come from the engine's shared memory, then one retry (`retries`).
 */
export function liveTabsWithOwners(
  deps: { shell?: Shell; retries?: number; nowMs?: number; cachePath?: string; claimed?: Iterable<string> } = {},
): LiveTab[] {
  const tabs = liveTabs(deps);
  if (!tabs.length) return tabs;
  const cache: IdentityCache = new Map();
  const budget: IdentityBudget = { totalMs: IDENTITY_BUDGET_MS };
  const panes = resolvePaneCwds(() => livePanes(deps), { retries: deps.retries ?? 1, nowMs: deps.nowMs, cachePath: deps.cachePath });
  return withTabOwners(tabs, panes, (cwd) => projectIdentity(cwd, { shell: deps.shell, cache, budget }), deps.claimed ?? []);
}

/** Every `root` stored on a zcrank:tab key: the claimed identities that break a tab-owner tie. */
export function claimedRoots(store: CrankStore, keys: string[] = storedTabKeys(store)): string[] {
  return [...new Set(Object.values(storedTabRoots(store, keys)))].sort();
}

const IDENTITY_BUDGET_MS = 20_000;

// ---------------------------------------------------------------------------
// Project → tab resolution
// ---------------------------------------------------------------------------

export type TabSource = "live-cwd" | "live-exact" | "redis-exact" | "live-prefix" | "project-name";

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
  /** PJAN-201: the owner (project identity) of the live tab this resolved to, when it has one. */
  tabOwner?: string;
}

/** What the resolver needs beyond names: the project's identity and which stored key belongs to which root. */
export interface ResolveScope {
  /** The project's identity (main worktree path), when it has one. */
  identity?: string;
  /** Stored key -> its `root` field (absent for legacy keys). */
  roots?: Record<string, string>;
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
 * A live tab that already has a key keeps it, even when the name drifted from it in
 * case or punctuation ("green-in-between" vs GreenInBetween). Writing the live spelling
 * instead minted a second key next to it (WING-7). Only an equal canon counts: a colon
 * head ("IPM: Navi" vs IPM) would make sibling tabs share one switch.
 */
function keyForLiveTab(tab: LiveTab, storedTabs: string[]): string {
  const display = tabDisplay(tab.name);
  if (storedTabs.includes(display)) return display;
  return storedTabs.find((s) => canon(s) && canon(s) === canon(display)) ?? display;
}

/** The live tab (by display name) a resolution points at, to read its owner. */
function ownerOfLiveTab(live: LiveTab[], liveTab: string | undefined): string | undefined {
  if (liveTab === undefined) return undefined;
  return live.find((tab) => tabDisplay(tab.name) === liveTab)?.owner;
}

/**
 * Resolve which zcrank tab a project owns. The first rung (PJAN-201, "live-cwd") is name-free:
 * the live tab(s) whose panes' cwds make this project's identity the strict plurality owner.
 * Then zcrankctl's name ladder: live-exact, redis-exact, live-prefix, then the project's own
 * name stored as-is. Never throws for a miss.
 */
export function resolveTabForProject(
  project: ProjectNames,
  live: LiveTab[],
  storedTabs: string[],
  scope: ResolveScope = {},
): TabResolution {
  const byCwd = resolveByCwd(project, live, storedTabs, scope);
  if (byCwd) return byCwd;
  const resolution = resolveByName(project, live, storedTabs);
  const tabOwner = ownerOfLiveTab(live, resolution.liveTab);
  return tabOwner ? { ...resolution, tabOwner } : resolution;
}

function resolveByCwd(project: ProjectNames, live: LiveTab[], storedTabs: string[], scope: ResolveScope): TabResolution | undefined {
  const identity = scope.identity;
  if (!identity) return undefined;
  const owned = live.filter((tab) => tab.owner === identity);
  if (!owned.length) return undefined;
  const candidateCanons = new Set(candidateNames(project).map((name) => canon(name)).filter(Boolean));
  // Several tabs own this project: a tab whose name matches a candidate first, then the tab
  // holding the most of the project's panes, then the leftmost.
  const ranked = [...owned].sort((a, b) =>
    Number(candidateCanons.has(canon(b.name))) - Number(candidateCanons.has(canon(a.name)))
    || (b.ownedPanes?.[identity] ?? 0) - (a.ownedPanes?.[identity] ?? 0)
    || a.position - b.position);
  const tab = ranked[0];
  if (!tab) return undefined;
  let key = keyForLiveTab(tab, storedTabs);
  if (!storedTabs.includes(key)) {
    // No key names this tab. A rename must not mint a new key: reuse the one already rooted here.
    const rooted = storedTabs.find((stored) => scope.roots?.[stored] === identity);
    if (rooted !== undefined) key = rooted;
  }
  return { tab: key, source: "live-cwd", matched: identity, storedAsIs: false, liveTab: tabDisplay(tab.name), tabOwner: identity };
}

function resolveByName(project: ProjectNames, live: LiveTab[], storedTabs: string[]): TabResolution {
  const candidates = candidateNames(project);
  const keyFor = (tab: LiveTab): string => keyForLiveTab(tab, storedTabs);
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

/** Which keys belong to a live tab by ownership rather than by name (PJAN-201). */
export interface KeyScope {
  /** The live tab's owner (project identity). */
  owner?: string;
  /** Stored key -> its `root`. */
  roots?: Record<string, string>;
}

/**
 * Every stored key that names this tab: the key itself plus each key with an equal canon (WING-7),
 * UNION (PJAN-201) every key whose `root` is the tab's owner. Name matches come first, then root
 * matches in stored order; no duplicates. A tab with neither has no keys (Unlisted = OFF).
 */
export function keysNamingTab(tab: string, storedKeys: string[], scope: KeyScope = {}): string[] {
  const c = canon(tab);
  const out: string[] = [];
  if (storedKeys.includes(tab)) out.push(tab);
  for (const key of storedKeys) {
    if (key !== tab && c && canon(key) === c) out.push(key);
  }
  if (scope.owner) {
    for (const key of storedKeys) {
      if (scope.roots?.[key] === scope.owner && !out.includes(key)) out.push(key);
    }
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
export function snapshotCrank(store: CrankStore, tab: string, storedKeys: string[], nowMs: number, beatLimit = 5, scope: KeyScope = {}): CrankSnapshot {
  const keys = keysNamingTab(tab, storedKeys, scope);
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
 * PJAN-201: a stored key whose `root` is the project's identity is ALSO an old key, even when it
 * is another live tab's spelling (the root says it is this project's switch).
 */
export function planRenameMigration(input: {
  resolution: TabResolution;
  candidates: string[];
  storedKeys: string[];
  live: LiveTab[];
  intervals: (key: string) => CrankInterval | undefined;
  /** An interval the user chose in the same breath: it wins, so nothing is carried. */
  chosenInterval?: CrankInterval;
  /** The project's identity and each stored key's root (PJAN-201). */
  identity?: string;
  roots?: Record<string, string>;
}): RenamePlan | undefined {
  const target = input.resolution.liveTab;
  if (!target || (input.resolution.source !== "live-exact" && input.resolution.source !== "live-prefix" && input.resolution.source !== "live-cwd")) return undefined;
  const targetCanon = canon(target);
  const wanted = new Set([targetCanon, ...input.candidates.map((name) => canon(name))].filter(Boolean));
  const otherLive = new Set(input.live.map((tab) => canon(tab.name)).filter((c) => c && c !== targetCanon));
  const oldKeys = [...new Set(input.storedKeys)].filter((key) => {
    if (key === target) return false;
    if (input.identity && input.roots?.[key] === input.identity) return true;
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
  /** The project's identity (PJAN-201), written as `root` on every key pj writes for it. */
  identity?: string;
  /** Stored key -> root (only keys that carry one). */
  roots: Record<string, string>;
}

/** Resolve the project onto a tab from the current live tabs and stored keys. */
export function buildCrankContext(project: ProjectNames, live: LiveTab[], storedKeys: string[], scope: ResolveScope = {}): CrankContext {
  const roots = scope.roots ?? {};
  return {
    resolution: resolveTabForProject(project, live, storedKeys, { identity: scope.identity, roots }),
    candidates: candidateNames(project),
    live,
    storedKeys,
    identity: scope.identity,
    roots,
  };
}

/** The key scope a resolved context reads under: the live tab's owner plus every stored root. */
export function keyScopeOf(ctx: Pick<CrankContext, "resolution" | "roots">): KeyScope {
  return { owner: ctx.resolution.tabOwner, roots: ctx.roots };
}

/** Stored zcrank:tab:* keys with the prefix stripped. */
export function storedTabKeys(store: CrankStore): string[] {
  return store.tabKeys().map((key) => key.split(":").slice(2).join(":"));
}

/** Stored key -> `root` for the keys that carry one (legacy keys are simply absent). */
export function storedTabRoots(store: CrankStore, keys: string[]): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const key of keys) {
    let root: string | undefined;
    try {
      root = store.tabRoot(key);
    } catch (error) {
      // `root` is advisory: a wrong-typed key (a Redis error reply) simply has none, and the
      // command that really needs that key fails on its own read, in its own words. A Redis that
      // is not answering is not that, and still throws.
      if (!(error instanceof Error) || !error.message.startsWith("Redis error reply")) throw error;
    }
    if (root) roots[key] = root;
  }
  return roots;
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
    identity: ctx.identity,
    roots: ctx.roots,
  });
  const tab = plan?.target ?? ctx.resolution.tab;
  store.setTabEnabled(tab, true);
  writeRoot(store, tab, ctx.identity);
  if (options.interval) store.setTabInterval(tab, options.interval);
  if (plan) applyRenameMigration(store, plan);
  else {
    // No live tab, so nothing migrates. Other spellings of the key still name this tab to the engine
    // (any OFF wins, the longest interval wins), so bring them along: ON, and the chosen interval
    // not overridden by a stale longer one.
    for (const sibling of keysNamingTab(tab, ctx.storedKeys, keyScopeOf(ctx))) {
      if (sibling === tab) continue;
      store.setTabEnabled(sibling, true);
      writeRoot(store, sibling, ctx.identity);
      if (options.interval) store.clearTabInterval(sibling);
    }
  }
  if (options.interval) store.pushLog(tab, "interval", `pj crank enable: interval ${options.interval}`, ts);
  store.pushLog(tab, "enabled", "pj crank enable", ts);
  const renamed = (plan?.oldKeys ?? []).map((from) => ({ from, to: tab }));
  for (const { from, to } of renamed) store.pushLog(tab, "renamed", `pj crank enable: ${from} -> ${to}`, ts);
  return { tab, renamed, interval: options.interval ?? plan?.carryInterval };
}

/** Stamp the project identity on a key pj writes (no-op for a project with no identity). */
function writeRoot(store: CrankStore, tab: string, root: string | undefined): void {
  if (root) store.setTabRoot(tab, root);
}

/** `pj crank disable`: enabled=0 plus a log row, under the resolved key (stamped with `root`). */
export function disableCrank(store: CrankStore, tab: string, now: Date = new Date(), root?: string): void {
  store.setTabEnabled(tab, false);
  writeRoot(store, tab, root);
  store.pushLog(tab, "disabled", "pj crank disable", crankTimestamp(now));
}

/**
 * Set (or, with undefined, reset to the global default) a tab's interval. Written under
 * `tab` and cleared from every other key naming it, so the longest-wins rule across spellings
 * can never override what the operator just picked.
 */
export function setCrankInterval(
  store: CrankStore,
  tab: string,
  storedKeys: string[],
  interval: CrankInterval | undefined,
  now: Date = new Date(),
  scope: KeyScope & { root?: string } = {},
): void {
  for (const key of keysNamingTab(tab, storedKeys, scope)) {
    if (key !== tab) store.clearTabInterval(key);
  }
  if (interval) store.setTabInterval(tab, interval);
  else store.clearTabInterval(tab);
  writeRoot(store, tab, scope.root);
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
  /** The live tab's display name when the project resolved onto a live tab (PJAN-201). */
  liveTab?: string;
}

export interface CrankListReport {
  /** One advisory line about the beat engine; absent when the caller did not read it. */
  engine?: EngineStatus;
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
  /** PJAN-201: a project's identity from its repo path (undefined = none), and each stored key's root. */
  identityOf?: (repoPath: string) => string | undefined;
  roots?: Record<string, string>;
  engine?: EngineStatus;
}): CrankListReport {
  const global = input.globalInterval ?? ZCRANK_DEFAULT_INTERVAL;
  const roots = input.roots ?? {};
  const intervalOf = (tab: string, owner?: string) => {
    const keys = keysNamingTab(tab, input.storedTabs, { owner, roots });
    return effectiveInterval((keys.length ? keys : [tab]).map((key) => input.tabInterval?.(key)), global);
  };
  const rows: CrankListRow[] = [];
  const consumed = new Set<string>();
  const consumedKeys = new Set<string>();
  for (const project of input.projects) {
    const identity = project.repoPath ? input.identityOf?.(project.repoPath) : undefined;
    const resolution = resolveTabForProject(project, input.live, input.storedTabs, { identity, roots });
    consumed.add(canon(resolution.tab));
    const keys = keysNamingTab(resolution.tab, input.storedTabs, { owner: resolution.tabOwner, roots });
    for (const key of keys) consumedKeys.add(key);
    // The engine's rule: ON only when every key naming the tab is ON. A single resolved key
    // (nothing else names the tab) reads exactly as before.
    const values = (keys.length ? keys : [resolution.tab]).map((key) => input.tabEnabled(key)).filter((v): v is string => v !== undefined);
    const enabled = values.length ? (values.every((v) => v === "1") ? "1" : "0") : undefined;
    rows.push({
      slug: project.slug,
      name: project.name,
      tab: resolution.tab,
      crank: enabled === "1" ? "ON" : enabled === "0" ? "OFF" : "—",
      source: resolution.source,
      ...(resolution.liveTab !== undefined ? { liveTab: resolution.liveTab } : {}),
      ...intervalOf(resolution.tab, resolution.tabOwner),
    });
  }
  const orphans = input.storedTabs
    .filter((stored) => !consumed.has(canon(stored)) && !consumedKeys.has(stored))
    .map((stored) => ({ tab: stored, enabled: input.tabEnabled(stored) === "1", ...intervalOf(stored) }));
  return { engine: input.engine, rows, orphans };
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

/** The TAB cell: the live tab for a live-cwd row (with the key when it differs), else the key. */
function tabCell(row: CrankListRow): string {
  if (row.source !== "live-cwd" || row.liveTab === undefined) return row.tab;
  return canon(row.tab) === canon(row.liveTab) ? row.liveTab : `${row.liveTab} (key ${row.tab})`;
}

export function formatCrankList(report: CrankListReport): string {
  const lines: string[] = [""];
  lines.push(`  ${heading("Crank by project")}`);
  if (report.engine) {
    const summary = engineSummary(report.engine);
    // "engine status unknown" already names the engine; a known status gets the label.
    lines.push(summary.tone === "unknown"
      ? `  ${dim(summary.text)}`
      : `  ${summary.tone === "ok" ? green("Engine") : yellow("Engine")} ${summary.tone === "warn" ? yellow(summary.text) : dim(summary.text)}`);
  }
  lines.push("");
  const slugWidth = Math.max("PROJECT".length, ...report.rows.map((row) => row.slug.length));
  const tabWidth = Math.max("TAB".length, ...report.rows.map((row) => tabCell(row).length), ...report.orphans.map((orphan) => orphan.tab.length));
  const intervalCell = (row: { interval: CrankInterval; inherited: boolean }) =>
    row.inherited ? dim(`${row.interval} (global)`) : row.interval;
  lines.push(`  ${"PROJECT".padEnd(slugWidth)}  ${"TAB".padEnd(tabWidth)}  ${"CRANK".padEnd(5)}  INTERVAL`);
  for (const row of report.rows) {
    const state = row.crank === "ON" ? green("ON") : row.crank === "OFF" ? dim("OFF") : dim("—");
    lines.push(`  ${cyan(row.slug.padEnd(slugWidth))}  ${tabCell(row).padEnd(tabWidth)}  ${state}${" ".repeat(Math.max(0, 5 - (row.crank === "ON" ? 2 : row.crank === "OFF" ? 3 : 1)))}  ${intervalCell(row)}`);
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
