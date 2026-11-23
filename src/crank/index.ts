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
import { redisEndpoint } from "./redisEndpoint";

export * from "./engine";
export * from "./schedule";
import {
  INTERVAL_SECONDS,
  ZCRANK_DEFAULT_INTERVAL,
  isDue,
  nextRunMs,
  parseInterval,
  type CrankInterval,
} from "./schedule";

export { ZCRANK_REDIS_HOST, ZCRANK_REDIS_PORT, redisEndpoint } from "./redisEndpoint";
export const ZCRANK_SESSION = "Workspace";
export const ZCRANK_LOG_CAP = 500;

/** Trailing status glyphs and separators zellij appends to tab names. */
const TAB_STATUS_SUFFIX = /[\s🟢🟡🔴🔔⚫✳✻●·─]+$/u;

/**
 * Command runner seam: tests substitute this to fake redis-cli/zellij. `options.input` is the
 * command's stdin. `errorCode` is the spawn failure's code (ENOENT, E2BIG, ETIMEDOUT, ...) when the
 * command could not be run at all, never a value the command itself reported.
 */
export type Shell = (
  command: string,
  args: string[],
  options?: { input?: string },
) => { stdout: string; status: number; stderr?: string; errorCode?: string };

export const defaultShell: Shell = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...(options?.input !== undefined ? { input: options.input } : {}) });
  if (result.error) {
    // 127 = could not run it (not installed, argument too long, ...); 124 = the 10 s budget ran out (the
    // shell convention `timeout` uses too). The code says which: callers must not guess "not installed".
    const errorCode = (result.error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return { stdout: "", status: errorCode === "ETIMEDOUT" ? 124 : 127, errorCode };
  }
  return { stdout: result.stdout ?? "", status: result.status ?? 1, stderr: result.stderr ?? "" };
};

/**
 * One argv string may not pass Linux's MAX_ARG_STRLEN (128 KiB), or spawn fails with E2BIG. An
 * argument bigger than this many bytes (half of it, with room to spare) travels on redis-cli's stdin
 * instead (`-X <tag>`), not in argv: still ONE atomic FCALL, with the exact same bytes on the wire.
 * (`-x` would not do: it feeds the LAST argument, and crank_apply's last argument is `by`.)
 */
export const ARGV_LIMIT_BYTES = 64 * 1024;
const STDIN_TAG = "__PJ_STDIN_ARG__";

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
// The pure interval/due/next-run math lives in ./schedule (no imports) so the shell prompt can
// use it without this module; re-exported here so every caller keeps one import path.

/** Log states pjangler itself writes; every other state is a crank beat row from `zcrankctl log`. */
export const PJANGLER_LOG_STATES: readonly string[] = ["enabled", "disabled", "interval", "renamed"];

/**
 * The longest valid interval among several keys' values, or undefined when none is set. Only the
 * enable-time rename migration uses it (which interval to CARRY onto the merged key); the interval
 * a tab actually runs at is the arbiter's (crank_resolve).
 */
export function longestInterval(values: (string | undefined | null)[]): CrankInterval | undefined {
  let best: CrankInterval | undefined;
  for (const value of values) {
    const parsed = parseInterval(value);
    if (parsed && (!best || INTERVAL_SECONDS[parsed] > INTERVAL_SECONDS[best])) best = parsed;
  }
  return best;
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
  const call = (args: string[], input?: string) =>
    shell("redis-cli", ["--raw", "-e", "-h", host, "-p", String(port), ...(input !== undefined ? ["-X", STDIN_TAG] : []), ...args], input !== undefined ? { input } : undefined);
  // Fail loudly when the installed redis-cli proves (via its own --help) too old for -e,
  // instead of silently regressing to errors-as-values. An unreadable help page (a fake in
  // tests, an odd PATH) stays permissive: the call goes out with -e and its own failure names it.
  let errorExitSupport: "unprobed" | "yes" | "no" | "unknown" = "unprobed";
  let stdinArgSupport = true;
  const requireErrorExit = (): void => {
    if (errorExitSupport === "unprobed") {
      const help = shell("redis-cli", ["--help"]);
      errorExitSupport = help.status === 0 && /^usage: redis-cli/im.test(help.stdout)
        ? (/(^|\n)\s+-e\s/.test(help.stdout) ? "yes" : "no")
        : "unknown";
      stdinArgSupport = errorExitSupport !== "yes" || /(^|\n)\s+-X\s/.test(help.stdout);
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
  // redis-cli never ran (spawn failed): say why, in the spawn error's own terms. A missing binary or
  // an argument list that is too long is not "Redis is not answering" (pjangler-4).
  const spawnFailure = (code: string): string => {
    if (code === "ENOENT") return "redis-cli is not installed (not on PATH)";
    if (code === "E2BIG") return "redis-cli could not be started: the argument list is too long (E2BIG)";
    return `redis-cli could not be started (${code})`;
  };
  // A failed redis-cli (Redis gone, error reply) throws: a write that did not land must never read
  // as success, and a dead read must not pose as "no keys / absent" (PJAN-182 review).
  const run = (...rawArgs: string[]): string => {
    requireErrorExit();
    // A command word is never big; the first argument past the argv limit goes on stdin.
    const bigAt = rawArgs.findIndex((arg, i) => i > 0 && Buffer.byteLength(arg) > ARGV_LIMIT_BYTES);
    if (bigAt > 0 && !stdinArgSupport) {
      throw new Error(`redis-cli is too old to carry a ${Buffer.byteLength(rawArgs[bigAt] ?? "")}-byte argument: no -X flag (needs redis-tools >= 7.0) — upgrade redis-tools`);
    }
    const args = bigAt > 0 ? rawArgs.map((arg, i) => (i === bigAt ? STDIN_TAG : arg)) : rawArgs;
    const result = call(args, bigAt > 0 ? rawArgs[bigAt] : undefined);
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      if (result.errorCode && result.errorCode !== "ETIMEDOUT") throw new Error(`${spawnFailure(result.errorCode)} (${args[0]} failed)`);
      if (notAnswering(stderr)) throw new Error(`Redis is not answering at ${host}:${port} (${args[0]} failed)`);
      throw new Error(`Redis error reply at ${host}:${port}: ${stderr.split("\n")[0]} (${args.join(" ")})`);
    }
    return result.stdout.replace(/\r?\n$/, "");
  };
  const lines = (out: string): string[] => out.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  // The crank arbiter (a Redis Functions library, bin/crank.lua in ~/.agents jev-clairic) is the ONLY
  // writer of crank state and the ONLY copy of the on/off + interval rule. Redis forgets functions
  // when it loses its dataset, so a "Function not found" reply is met ONCE with `zcrankctl
  // arbiter-load` and a retry; with no zcrankctl on PATH (or a load that fails) the error names the fix.
  let arbiterReloaded = false;
  const fcall = (verb: "FCALL" | "FCALL_RO", fn: string, ...args: string[]): string => {
    const invoke = () => run(verb, fn, "0", ...args);
    try {
      return invoke();
    } catch (error) {
      if (!(error instanceof Error) || !/function not found/i.test(error.message)) throw error;
      const fix = "run `zcrankctl arbiter-load`";
      if (!arbiterReloaded) {
        arbiterReloaded = true;
        const loaded = shell("zcrankctl", ["arbiter-load"]);
        if (loaded.status === 0) {
          try {
            return invoke();
          } catch (retry) {
            if (!(retry instanceof Error) || !/function not found/i.test(retry.message)) throw retry;
          }
        }
      }
      throw new Error(`the crank arbiter is not loaded in Redis at ${host}:${port} (${fn}: function not found) — ${fix}`);
    }
  };
  /** cjson encodes an EMPTY list as {}: a reader must treat a non-array "edges"/"results" as []. */
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
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
    /** HGET zcrank:tab:<tab> root -> the owning project identity, or undefined (legacy key / absent). */
    tabRoot: (tab: string): string | undefined => {
      const v = run("HGET", `zcrank:tab:${tab}`, "root");
      return v === "" || v == null ? undefined : v;
    },
    /** HGET zcrank:tab:<tab> interval -> a valid interval, else undefined (absent or garbage). */
    tabInterval: (tab: string): CrankInterval | undefined => parseInterval(run("HGET", `zcrank:tab:${tab}`, "interval")),
    /** All zcrank:tab:* keys (raw key per line). */
    tabKeys: (): string[] => lines(run("KEYS", "zcrank:tab:*")),
    /** zcrank:pane:<tab>:<terminal_id> keys of exactly this tab (never a colon-named sibling's). */
    paneKeys: (tab: string): string[] => {
      const prefix = `zcrank:pane:${tab}:`;
      return lines(run("KEYS", `${redisGlobEscape(prefix)}*`)).filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes(":"));
    },
    /** LRANGE 0 -1, oldest first (newest last) — zcrankctl's display order. */
    logRows: (tab: string): string[] => lines(run("LRANGE", `zcrank:log:${tab}`, "0", "-1")),
    /**
     * The rule: ask the arbiter (FCALL_RO crank_resolve) whether crank is ON for these governing
     * keys (and, with `pane`, that pane's override under any of `owners`) and at what interval.
     * Name matching that produces `keys` stays in pjangler; the verdict never does.
     */
    resolve: (query: { keys: string[]; owners?: string[]; pane?: string }): CrankVerdict => {
      const raw = fcall("FCALL_RO", "crank_resolve", JSON.stringify({
        keys: query.keys,
        owners: query.owners ?? [],
        ...(query.pane ? { pane: query.pane } : {}),
      }));
      return parseVerdict(raw);
    },
    /**
     * DEL of a stale zcrank:* key the arbiter's `del` op REFUSES (its registry_key guard rejects any
     * name holding a redis glob character, `*` or `?`, though DEL does not glob). The ONE write that
     * does not go through crank_apply, used only to finish a rename migration whose old tab key is
     * named like that; delete this once crank.lua's guard allows such names.
     */
    purge: (key: string): void => {
      if (!key.startsWith("zcrank:")) throw new Error(`refusing to purge a key outside zcrank:*: ${key}`);
      run("DEL", key);
    },
    /**
     * Every crank write, as ONE atomic FCALL crank_apply. The Lua appends the enabled / interval
     * log rows (only when the value really changed), re-resolves every pane and emits edges.
     * Throws on any failure: a write that did not land never reads as success.
     */
    apply: (ops: CrankOp[], by = "pj"): CrankApplyResult => {
      if (!ops.length) return { changed: 0, results: [], edges: [] };
      const raw = fcall("FCALL", "crank_apply", JSON.stringify(ops), by);
      let parsed: { changed?: unknown; results?: unknown; edges?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new Error(`the crank arbiter answered crank_apply with something that is not JSON: ${raw.slice(0, 80)}`);
      }
      return {
        changed: typeof parsed.changed === "number" ? parsed.changed : 0,
        results: list(parsed.results).map((r) => r === true),
        edges: list(parsed.edges),
      };
    },
    /**
     * Crank v2's live projection of one session binding (crank.lua, "Crank v2 bindings"):
     * crank_attach | crank_fire | crank_end on crank:b:<binding> + crank:idx:pane:<session>:<pane>.
     * Candybar stays the registry; this is what the prompt reads. Throws on any failure.
     */
    binding: (fn: BindingFn, payload: Record<string, unknown>, by = "pj"): BindingWriteResult => {
      const raw = fcall("FCALL", fn, JSON.stringify(payload), by);
      let parsed: { error?: unknown; created?: unknown; ended?: unknown; refused?: unknown; edges?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new Error(`the crank arbiter answered ${fn} with something that is not JSON: ${raw.slice(0, 80)}`);
      }
      if (typeof parsed.error === "string") throw new Error(`the crank arbiter refused ${fn}: ${parsed.error}`);
      return {
        created: parsed.created === true,
        ended: parsed.ended === true,
        ...(typeof parsed.refused === "string" ? { refused: parsed.refused } : {}),
        edges: list(parsed.edges),
      };
    },
  };
}

/** The crank v2 binding writers in crank.lua. */
export type BindingFn = "crank_attach" | "crank_fire" | "crank_end";

export interface BindingWriteResult {
  created: boolean;
  ended: boolean;
  /** "ended": the binding was already ended (tombstone); a late fire never brings it back. */
  refused?: string;
  edges: unknown[];
}

export type CrankStore = ReturnType<typeof redis>;

/** What crank_resolve answers: ON/OFF, what decided it, and the interval (own or inherited). */
export interface CrankVerdict {
  on: boolean;
  decidedBy: "pane" | "tab" | "unlisted";
  interval: CrankInterval;
  /** True when the interval is the global default rather than a key's own. */
  inherited: boolean;
}

function parseVerdict(raw: string): CrankVerdict {
  let parsed: { on?: unknown; decided_by?: unknown; interval?: unknown; inherited?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`the crank arbiter answered crank_resolve with something that is not JSON: ${raw.slice(0, 80)}`);
  }
  const decidedBy = parsed.decided_by === "pane" || parsed.decided_by === "tab" ? parsed.decided_by : "unlisted";
  return {
    on: parsed.on === true,
    decidedBy,
    interval: parseInterval(typeof parsed.interval === "string" ? parsed.interval : undefined) ?? ZCRANK_DEFAULT_INTERVAL,
    inherited: parsed.inherited === true,
  };
}

/** One crank_apply op (see the header of crank.lua, the single writer). */
export type CrankOp =
  | { op: "tab"; key: string; enabled?: boolean; interval?: CrankInterval | ""; root?: string; root_if_absent?: string; action?: string; interval_action?: string; ts?: string }
  | { op: "pane"; owner: string; pane: string; value: "1" | "0" | "" }
  | { op: "clear_panes"; owner: string }
  | { op: "config"; interval: CrankInterval }
  | { op: "log"; key: string; row: string }
  | { op: "replace_log"; key: string; rows: string[] }
  | { op: "del"; key: string };

export interface CrankApplyResult {
  changed: number;
  results: boolean[];
  edges: unknown[];
}

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

/** One entry of `zellij action list-panes --json --all`, every field the crank code reads. */
export interface ListedPane extends LivePane {
  /** zellij's pane title (an agent's terminal title, or the shell prompt); null when absent. */
  title: string | null;
}

/**
 * The ONE parser of `list-panes --json --all` output (livePanes here, `pj crank panes` in ./panes):
 * two readers of the same command must not be able to drift. null = not a pane list (empty,
 * not JSON, not an array); an empty array is a valid parse that the caller judges.
 */
export function parseListPanes(stdout: string): ListedPane[] | null {
  if (!stdout.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const panes: ListedPane[] = [];
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
      title: typeof e.title === "string" ? e.title : null,
    });
  }
  return panes;
}

/** Run `list-panes --json --all` for `session` (read-only). Same command line for every caller. */
export function runListPanes(session: string, shell: Shell): { stdout: string; status: number; stderr?: string } {
  // `env -u ZELLIJ -u ZELLIJ_SESSION_NAME` is required (zellij refuses to act on itself from inside
  // a pane); list-panes takes ~4s (measured 2026-11-04), hence 8s like the engine, not 5s.
  return shell("env", ["-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME", "timeout", "8s", "zellij", "-s", session, "action", "list-panes", "--json", "--all"]);
}

/**
 * Live zellij panes (every tab, plugins included) for the Workspace session; [] when unreadable.
 */
export function livePanes(deps: { shell?: Shell; session?: string } = {}): LivePane[] {
  const shell = deps.shell ?? defaultShell;
  const result = runListPanes(deps.session ?? ZCRANK_SESSION, shell);
  if (result.status !== 0) return [];
  // LivePane is the crank's shape: the listing's title is for `pj crank panes` alone.
  return (parseListPanes(result.stdout) ?? []).map(({ title: _title, ...pane }) => pane);
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
  deps: {
    shell?: Shell;
    retries?: number;
    nowMs?: number;
    cachePath?: string;
    claimed?: Iterable<string>;
    /** Accept a result up to this old from the shared memo, and write a fresh one back. Absent = always ask zellij. */
    memoMs?: number;
    memoPath?: string;
  } = {},
): LiveTab[] {
  const claimed = [...(deps.claimed ?? [])];
  const memoKey = `${ZCRANK_SESSION}|${[...claimed].sort().join("\n")}`;
  const memoFile = deps.memoPath ?? liveTabsMemoPath();
  const now = deps.nowMs ?? Date.now();
  if (deps.memoMs) {
    const hit = readLiveTabsMemo(memoFile, memoKey, now, deps.memoMs);
    if (hit) return hit;
  }
  const tabs = liveTabs(deps);
  if (!tabs.length) return tabs;
  const cache: IdentityCache = new Map();
  const budget: IdentityBudget = { totalMs: IDENTITY_BUDGET_MS };
  const panes = resolvePaneCwds(() => livePanes(deps), { retries: deps.retries ?? 1, nowMs: deps.nowMs, cachePath: deps.cachePath });
  const owned = withTabOwners(tabs, panes, (cwd) => projectIdentity(cwd, { shell: deps.shell, cache, budget }), claimed);
  if (deps.memoMs) writeLiveTabsMemo(memoFile, memoKey, now, owned);
  return owned;
}

/**
 * Shared memo of liveTabsWithOwners for callers that tolerate staleness. Each real read costs the
 * zellij server one `list-tabs --json` plus up to two `list-panes --json --all`; the latter makes
 * the server run `ps` once per pane (~0.08 s each on a busy host). The shell-prompt refresher runs
 * once per project root per minute, so N roots meant N full pane scans a minute for one answer.
 * Override the location with $PJ_LIVE_TABS_MEMO.
 */
export function liveTabsMemoPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PJ_LIVE_TABS_MEMO?.trim() || join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "pjangler", "live-tabs.json");
}

function readLiveTabsMemo(path: string, key: string, nowMs: number, maxAgeMs: number): LiveTab[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { key?: unknown; atMs?: unknown; tabs?: unknown };
    const atMs = Number(parsed.atMs);
    if (parsed.key !== key || !Number.isFinite(atMs) || nowMs - atMs < 0 || nowMs - atMs > maxAgeMs) return null;
    return Array.isArray(parsed.tabs) && parsed.tabs.length ? (parsed.tabs as LiveTab[]) : null;
  } catch {
    return null;
  }
}

function writeLiveTabsMemo(path: string, key: string, nowMs: number, tabs: LiveTab[]): void {
  if (!tabs.length) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, atMs: nowMs, tabs }));
    renameSync(tmp, path);
  } catch {
    // a memo we cannot write only costs one more zellij read
  }
}

/** Every `root` stored on a zcrank:tab key: the claimed identities that break a tab-owner tie. */
export function claimedRoots(store: CrankStore, keys: string[] = storedTabKeys(store)): string[] {
  return [...new Set(Object.values(storedTabRoots(store, keys)))].sort();
}

export const IDENTITY_BUDGET_MS = 20_000;

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

/** Read one tab's crank state. Pure reads: never writes. ON/OFF and the interval are the arbiter's verdict. */
export function snapshotCrank(store: CrankStore, tab: string, storedKeys: string[], nowMs: number, beatLimit = 5, scope: KeyScope = {}): CrankSnapshot {
  const keys = keysNamingTab(tab, storedKeys, scope);
  const readKeys = keys.length ? keys : [tab];
  const verdict = store.resolve({ keys });
  const enabled = verdict.decidedBy === "unlisted" ? undefined : verdict.on;
  const { interval, inherited } = verdict;
  // An inherited interval IS the global default; an own one needs a second question to learn it.
  const global = inherited ? interval : store.resolve({ keys: [] }).interval;
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
 * The crank_apply ops of a RenamePlan: merge every old key's log onto the target (one replace_log),
 * MOVE pane overrides onto the target (a pane turned OFF stays OFF; when both spellings carry one,
 * any OFF wins, which is what the rule does across spellings), then drop the old tab / pane / log
 * keys. Reads are done here; nothing is written until the caller sends the batch.
 */
export function renameMigrationOps(store: CrankStore, plan: RenamePlan): CrankOp[] {
  const ops: CrankOp[] = [];
  const original = store.logRows(plan.target);
  let log = original;
  const panes = new Map<string, string | undefined>();
  for (const old of plan.oldKeys) {
    log = mergeLogRows([store.logRows(old)], log);
    const prefix = `zcrank:pane:${old}:`;
    for (const paneKey of store.paneKeys(old)) {
      const pane = paneKey.slice(prefix.length);
      const oldValue = store.getKey(paneKey);
      if (oldValue === undefined) continue;
      if (!panes.has(pane)) panes.set(pane, store.getKey(`zcrank:pane:${plan.target}:${pane}`));
      const existing = panes.get(pane);
      const value = existing === undefined ? oldValue : existing === "1" && oldValue === "1" ? "1" : "0";
      if (value !== existing) {
        panes.set(pane, value);
        ops.push({ op: "pane", owner: plan.target, pane, value: value === "1" ? "1" : "0" });
      }
    }
    ops.push({ op: "clear_panes", owner: old });
    ops.push({ op: "del", key: `zcrank:tab:${old}` }, { op: "del", key: `zcrank:log:${old}` });
  }
  if (log.length !== original.length || log.some((row, i) => row !== original[i])) {
    ops.unshift({ op: "replace_log", key: plan.target, rows: log });
  }
  return ops;
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
 * `pj crank enable`, shared by the CLI and the TUI: ONE atomic crank_apply carrying everything the
 * command means — enabled=1 and the chosen interval under the target key (the arbiter writes their
 * log rows, only when the value changed), the `root`, the rename migration, and the "renamed" rows.
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
  const interval = options.interval ?? plan?.carryInterval;
  // The log merge (replace_log) goes first: the rows the tab op appends land after it, as they always did.
  const ops: CrankOp[] = plan ? renameMigrationOps(store, plan) : [];
  ops.push({
    op: "tab", key: tab, enabled: true, ts,
    action: "pj crank enable",
    ...(interval ? { interval, interval_action: options.interval ? `pj crank enable: interval ${interval}` : `pj crank enable: interval ${interval} (carried from the old key)` } : {}),
    ...(ctx.identity ? { root: ctx.identity } : {}),
  });
  if (!plan) {
    // No live tab, so nothing migrates. Other spellings of the key still name this tab to the engine
    // (any OFF wins, the longest interval wins), so bring them along: ON, and the chosen interval
    // not overridden by a stale longer one.
    for (const sibling of keysNamingTab(tab, ctx.storedKeys, keyScopeOf(ctx))) {
      if (sibling === tab) continue;
      ops.push({
        op: "tab", key: sibling, enabled: true, ts,
        action: `pj crank enable (spelling of ${tab})`,
        ...(options.interval ? { interval: "" as const, interval_action: `pj crank enable: interval cleared, ${tab} runs at ${options.interval}` } : {}),
        ...(ctx.identity ? { root: ctx.identity } : {}),
      });
    }
  }
  const renamed = (plan?.oldKeys ?? []).map((from) => ({ from, to: tab }));
  for (const { from, to } of renamed) {
    ops.push({ op: "log", key: tab, row: JSON.stringify({ ts, state: "renamed", action: `pj crank enable: ${from} -> ${to}` }) });
  }
  store.apply(ops);
  // The arbiter's `del` skips names with a redis glob character: finish those by hand (see store.purge).
  for (const op of ops) {
    if (op.op === "del" && /[*?]/.test(op.key)) store.purge(op.key);
  }
  return { tab, renamed, interval };
}

/** `pj crank disable`: enabled=0 (and its log row, when it changed) under the resolved key, stamped with `root`. */
export function disableCrank(store: CrankStore, tab: string, now: Date = new Date(), root?: string): void {
  store.apply([{ op: "tab", key: tab, enabled: false, ts: crankTimestamp(now), action: "pj crank disable", ...(root ? { root } : {}) }]);
}

/**
 * Set (or, with undefined, reset to the global default) a tab's interval. Written under
 * `tab` and cleared from every other key naming it, so the longest-wins rule across spellings
 * can never override what the operator just picked. One atomic crank_apply.
 */
export function setCrankInterval(
  store: CrankStore,
  tab: string,
  storedKeys: string[],
  interval: CrankInterval | undefined,
  now: Date = new Date(),
  scope: KeyScope & { root?: string } = {},
): void {
  const ts = crankTimestamp(now);
  const ops: CrankOp[] = [];
  for (const key of keysNamingTab(tab, storedKeys, scope)) {
    if (key !== tab) ops.push({ op: "tab", key, interval: "", ts, interval_action: `pj crank tui: interval cleared, ${tab} decides` });
  }
  const action = interval ? `pj crank tui: interval ${interval}` : `pj crank tui: interval reset to global (${store.resolve({ keys: [] }).interval})`;
  ops.push({ op: "tab", key: tab, interval: interval ?? "", ts, interval_action: action, ...(scope.root ? { root: scope.root } : {}) });
  store.apply(ops);
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

/** Build the crank list from registry projects plus live/stored tab state. ON/OFF and intervals are the arbiter's. */
export function buildCrankList(input: {
  projects: CrankProjectRecord[];
  live: LiveTab[];
  storedTabs: string[];
  /** The rule: the arbiter's verdict (crank_resolve) for a set of governing keys. */
  resolve: (keys: string[]) => CrankVerdict;
  /** PJAN-201: a project's identity from its repo path (undefined = none), and each stored key's root. */
  identityOf?: (repoPath: string) => string | undefined;
  roots?: Record<string, string>;
  engine?: EngineStatus;
}): CrankListReport {
  const roots = input.roots ?? {};
  const rows: CrankListRow[] = [];
  const consumed = new Set<string>();
  const consumedKeys = new Set<string>();
  for (const project of input.projects) {
    const identity = project.repoPath ? input.identityOf?.(project.repoPath) : undefined;
    const resolution = resolveTabForProject(project, input.live, input.storedTabs, { identity, roots });
    consumed.add(canon(resolution.tab));
    const keys = keysNamingTab(resolution.tab, input.storedTabs, { owner: resolution.tabOwner, roots });
    for (const key of keys) consumedKeys.add(key);
    const verdict = input.resolve(keys);
    rows.push({
      slug: project.slug,
      name: project.name,
      tab: resolution.tab,
      crank: verdict.decidedBy === "unlisted" ? "—" : verdict.on ? "ON" : "OFF",
      source: resolution.source,
      ...(resolution.liveTab !== undefined ? { liveTab: resolution.liveTab } : {}),
      interval: verdict.interval,
      inherited: verdict.inherited,
    });
  }
  const orphans = input.storedTabs
    .filter((stored) => !consumed.has(canon(stored)) && !consumedKeys.has(stored))
    .map((stored) => {
      const verdict = input.resolve(keysNamingTab(stored, input.storedTabs, { roots }));
      return { tab: stored, enabled: verdict.on, interval: verdict.interval, inherited: verdict.inherited };
    });
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
