// The 33GOD pipeline segments of `pjangler-prompt`: how many candybars are
// registered (Candybar, the single clock) and whether crank mode is ON for the
// pane you are typing in (the crank arbiter's resolved state in Redis).
//
// Two facts, two paths.
//
// Crank, in a zellij pane: READ DIRECTLY. The arbiter (crank.lua) keeps one resolved hash per pane,
// crank:p:<session>:terminal_<N>, and an engine heartbeat, crank:engine. The prompt HGETALLs both over
// one pipelined TCP connection (a ~150ms hard budget; ./crank/resp.ts) and renders. No cache, no
// refresher, no `zellij list-panes`: the answer is exactly as fresh as the engine's last */5 scan,
// and nothing here re-implements the on/off rule.
//
// A pane bound to a crank v2 SESSION binding (pj crank, PJAN-214/215) wins over the legacy hash: the
// same pipeline asks FCALL_RO crank_get <session> <pane>, which follows crank:idx:pane:<session>:<pane>
// to crank:b:<binding>. That binding fires on its own Candybar schedule, so its staleness is judged by
// its own last fire against its own interval, not by the legacy engine's heartbeat.
//
// Candybar (an HTTP API), and crank for a project OUTSIDE zellij (the project's resolved tab: needs
// redis-cli and git), are not cheap. A prompt renders on every Enter, so the prompt NEVER computes
// them: it reads a small JSON cache and, when that cache is stale, spawns `dist/prompt-refresh.js`
// detached and returns immediately (stale-while-revalidate). The first prompt in a new place shows
// no such segments; the next one does.
//
// This module imports node builtins (and the import-free ./crank/schedule, ./crank/redisEndpoint and
// ./crank/resp) only. It is bundled into dist/prompt.js, whose whole reason to exist is a boot near
// node's own floor; the heavy crank and HTTP code lives in ./prompt-refresh.ts, a separate bundle
// that only the detached child ever loads.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redisEndpoint } from "./crank/redisEndpoint";
import { redisPipeline, replyToHash } from "./crank/resp";
import { nextFire, nextRunMs, parseInterval } from "./crank/schedule";

export const PIPELINE_CACHE_VERSION = 1;
/** Older than this, the prompt asks for a refresh (and keeps showing what it has). */
export const PIPELINE_REFRESH_AFTER_MS = 60_000;
/** Older than this, the cache is not shown at all: a crank switch from an hour ago is a lie. */
export const PIPELINE_EXPIRE_AFTER_MS = 15 * 60_000;
/** A refresh lock older than this belongs to a child that died; it is taken over. */
export const PIPELINE_LOCK_STALE_MS = 60_000;

export interface CandybarCounts {
  /** Registered (non-archived) candybars tagged `project:<this repo>`. */
  project: number;
  /** Registered (non-archived) candybars in the whole registry. */
  total: number;
}

export interface CrankState {
  enabled: boolean;
  /** The interval the beat visits this tab at (5m|1h|6h|1d). */
  interval?: string;
  /**
   * What decided it: this pane's override, its tab, the project's resolved tab (outside zellij), or
   * a crank v2 binding on the agent session running in this pane.
   */
  scope: "pane" | "tab" | "project" | "session";
  /**
   * Epoch ms crank has been ON without a break since: for a pane, the arbiter's `since` stamp (an
   * edge sets it, an idempotent enable keeps it); for a project outside zellij, the oldest `since`
   * among its tab's ON panes. Absent = unknown.
   */
  onSinceMs?: number;
  /** Epoch ms of this tab's newest beat row; with `interval` it gives the next crank at render time. */
  lastRunMs?: number;
  /** Epoch ms of the engine's last scan (crank:engine scan_ms); for a v2 session, its last fire. */
  engineScanMs?: number;
  /** v2 session: epoch ms of the next scheduled fire as of the last write (rolled forward by intervalMs). */
  nextDueMs?: number;
  /** v2 session: the interval in ms (v2 intervals are any 1-59m, 1-23h or 1d). */
  intervalMs?: number;
  /** v2 session: the binding's own Candybar cron; the countdown reads it at render time. */
  schedule?: string;
  /**
   * The engine had not scanned for CRANK_STALL_AFTER_MS when this was READ (judged at write time:
   * a cache shown 10m later must not turn a healthy engine's normal scan age into a false alarm).
   */
  stalled?: boolean;
}

/** The engine scans every 5m tick; three missed ticks means it is not cranking anything. */
export const CRANK_STALL_AFTER_MS = 15 * 60_000;

/** Total budget (connect, write, read) of the prompt's direct crank read. A prompt must never wait on Redis. */
export const CRANK_READ_TIMEOUT_MS = 150;

export interface PipelineCache {
  v: number;
  writtenAtMs: number;
  root: string;
  /** null = Candybar did not answer (the segment is hidden, never guessed). */
  candybars: CandybarCounts | null;
  /** null = Redis did not answer (the segment is hidden, never guessed). */
  crank: CrankState | null;
  /**
   * The project PM's company identity, as `flume identity manifest <pm> --json` judged it. Absent/null =
   * not known (no PM, Flume missing or silent): the PM segment then shows no identity part at all.
   */
  identity?: IdentitySummary | null;
}

/**
 * What the prompt says about the PM's company identity. `enrolled: false` is a known answer ("id none");
 * an enrolled PM carries the identity-manifest version it is judged against and its required points.
 */
export type IdentitySummary =
  | { enrolled: false }
  | { enrolled: true; version: number; satisfied: number; total: number; /** Present only when not `active`. */ status?: string };

function isIdentity(value: unknown): value is IdentitySummary {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return false;
  if (v.enrolled === false) return true;
  const count = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  return v.enrolled === true && Number.isInteger(v.version) && (v.version as number) > 0
    && count(v.satisfied) && count(v.total) && (v.satisfied as number) <= (v.total as number)
    && (v.status === undefined || (typeof v.status === "string" && /^[a-z]{1,16}$/.test(v.status)));
}

/** `id v1 5/6` (manifest version, required points held/required; `id v1 5/6 suspended` when not active), or `id none` for a PM never enrolled. */
export function formatIdentity(identity: IdentitySummary): string {
  if (!identity.enrolled) return "id none";
  return `id v${identity.version} ${identity.satisfied}/${identity.total}${identity.status ? ` ${identity.status}` : ""}`;
}

/** `$PJ_PROMPT_CACHE_DIR`, else `$XDG_CACHE_HOME/pjangler/prompt`, else `~/.cache/pjangler/prompt`. */
export function pipelineCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PJ_PROMPT_CACHE_DIR) return env.PJ_PROMPT_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "pjangler", "prompt");
}

/**
 * The zellij pane this process runs in: the session (the arbiter's hash is keyed by it) and the
 * `terminal_<N>` pane id. undefined outside zellij (or with either variable unusable).
 */
export function zellijPane(env: NodeJS.ProcessEnv = process.env): { session: string; pane: string } | undefined {
  const session = env.ZELLIJ_SESSION_NAME?.trim();
  const id = env.ZELLIJ_PANE_ID?.trim();
  if (!session || !id || !/^\d+$/.test(id)) return undefined;
  return { session, pane: `terminal_${id}` };
}

/**
 * One cache file per (project root, in-a-zellij-pane or not). Inside a pane the cache holds the
 * candybar counts only (crank is read directly there), outside it also holds the project's crank
 * answer: the two kinds of refresher must not overwrite each other's file.
 */
export function pipelineCachePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const place = zellijPane(env) ? "zellij" : "";
  const key = createHash("sha1").update(`${root}\0${place}`).digest("hex").slice(0, 16);
  return join(pipelineCacheDir(env), `${key}.json`);
}

function isCounts(value: unknown): value is CandybarCounts {
  const v = value as CandybarCounts;
  return !!v && Number.isInteger(v.project) && Number.isInteger(v.total) && v.project >= 0 && v.total >= 0;
}

function optionalMs(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isCrank(value: unknown): value is CrankState {
  const v = value as CrankState;
  return !!v && typeof v.enabled === "boolean" && ["pane", "tab", "project", "session"].includes(v.scope)
    && (v.interval === undefined || typeof v.interval === "string")
    && optionalMs(v.onSinceMs) && optionalMs(v.lastRunMs) && optionalMs(v.engineScanMs)
    && (v.stalled === undefined || typeof v.stalled === "boolean");
}

/** The cache at `path` for `root`, or undefined when absent, unreadable, foreign or the wrong version. */
export function readPipelineCache(path: string, root: string): PipelineCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PipelineCache;
    if (!parsed || parsed.v !== PIPELINE_CACHE_VERSION || parsed.root !== root) return undefined;
    if (typeof parsed.writtenAtMs !== "number" || !Number.isFinite(parsed.writtenAtMs)) return undefined;
    return {
      v: parsed.v,
      writtenAtMs: parsed.writtenAtMs,
      root: parsed.root,
      candybars: isCounts(parsed.candybars) ? parsed.candybars : null,
      crank: isCrank(parsed.crank) ? parsed.crank : null,
      ...(isIdentity(parsed.identity) ? { identity: parsed.identity } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The segments a cache is fit to show at `nowMs`: nothing once it has expired. */
export function freshSegments(cache: PipelineCache | undefined, nowMs: number): Pick<PipelineCache, "candybars" | "crank" | "identity"> {
  if (!cache) return { candybars: null, crank: null };
  const age = nowMs - cache.writtenAtMs;
  // A clock that went backwards (or a cache from the future) is not trusted either.
  if (age > PIPELINE_EXPIRE_AFTER_MS || age < -PIPELINE_REFRESH_AFTER_MS) return { candybars: null, crank: null };
  return { candybars: cache.candybars, crank: cache.crank, ...(cache.identity ? { identity: cache.identity } : {}) };
}

export function needsRefresh(cache: PipelineCache | undefined, nowMs: number): boolean {
  if (!cache) return true;
  const age = nowMs - cache.writtenAtMs;
  return age > PIPELINE_REFRESH_AFTER_MS || age < 0;
}

/** A non-negative epoch-ms field of the arbiter's hash, or undefined (absent, empty, junk). */
function hashMs(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The crank segment from the arbiter's resolved state: `pane` is HGETALL crank:p:<session>:terminal_<N>
 * and `engine` is HGETALL crank:engine (an absent hash is an empty one). undefined = no segment.
 *
 * This is the LEGACY (tab-model) engine, retired by crank v2 (PJAN-216): its switches were turned off,
 * its clock paused, and one last scan left every crank:p at on=0. So the legacy hash is believed only
 * while that engine is demonstrably running — a heartbeat of THIS pane's session no older than
 * CRANK_STALL_AFTER_MS. Anything else (no heartbeat, a stale one, another session's, no hash) is no
 * segment: a retired engine is not "stalled", and its frozen hashes must not read as OFF or ON for a
 * day until their TTL runs out. Stall reporting belongs to v2 (crankFromBinding).
 *
 *   fresh heartbeat of this session + hash on=1 -> ON (since = the arbiter's stamp, interval, last_run)
 *   fresh heartbeat of this session + hash on=0 -> OFF
 *   anything else                              -> undefined
 */
export function crankFromArbiter(
  pane: Record<string, string> | undefined,
  engine: Record<string, string> | undefined,
  nowMs: number,
  session: string,
): CrankState | undefined {
  if (!pane || Object.keys(pane).length === 0) return undefined;
  if (!session || engine?.session !== session) return undefined;
  const heartbeatMs = hashMs(engine?.scan_ms);
  if (heartbeatMs === undefined || nowMs - heartbeatMs > CRANK_STALL_AFTER_MS || heartbeatMs - nowMs > CRANK_STALL_AFTER_MS) {
    return undefined;
  }
  const scope = pane.decided_by === "pane" ? "pane" : "tab";
  const interval = parseInterval(pane.interval);
  if (pane.on === "0") return { enabled: false, scope, ...(interval ? { interval } : {}) };
  if (pane.on !== "1") return undefined;
  const state: CrankState = { enabled: true, scope };
  if (interval) state.interval = interval;
  const since = hashMs(pane.since);
  if (since !== undefined) state.onSinceMs = since;
  const lastRun = hashMs(pane.last_run);
  if (lastRun !== undefined) state.lastRunMs = lastRun;
  state.engineScanMs = heartbeatMs;
  return state;
}

/** A v2 interval (`7m`, `2h`, `1d`) in ms, or undefined. Mirrors pjangler's policy.ts grammar. */
export function v2IntervalMs(value: string | undefined): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(value ?? "");
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === "m" && n >= 1 && n <= 59) return n * 60_000;
  if (unit === "h" && n >= 1 && n <= 23) return n * 3_600_000;
  if (unit === "d" && n === 1) return 86_400_000;
  return undefined;
}

/**
 * The crank segment for a pane bound to a crank v2 session (`binding` is the crank_get reply as a
 * hash; empty = no binding here). A binding is ON while it exists. It is stalled when its newest
 * beat (last fire, else attach; a reclock restarts the clock) is older than two intervals plus five
 * minutes, and never sooner than CRANK_STALL_AFTER_MS: Candybar has stopped firing it. A pointer
 * whose hash expired (`expired=1`, never ended) is stalled outright: absence is never OFF.
 */
export function crankFromBinding(binding: Record<string, string> | undefined, nowMs: number): CrankState | undefined {
  if (!binding?.binding) return undefined;
  if (binding.expired === "1") return { enabled: true, scope: "session", stalled: true };
  const state: CrankState = { enabled: true, scope: "session" };
  if (binding.schedule) state.schedule = binding.schedule;
  if (binding.interval) state.interval = binding.interval;
  const intervalMs = v2IntervalMs(binding.interval);
  if (intervalMs !== undefined) state.intervalMs = intervalMs;
  const since = hashMs(binding.since);
  if (since !== undefined) state.onSinceMs = since;
  const lastFire = hashMs(binding.last_fire);
  if (lastFire !== undefined) state.lastRunMs = lastFire;
  const nextDue = hashMs(binding.next_due);
  if (nextDue !== undefined) state.nextDueMs = nextDue;
  const beats = [lastFire, since, hashMs(binding.reclocked_ms)].filter((v): v is number => v !== undefined);
  const beat = beats.length ? Math.max(...beats) : undefined;
  if (beat !== undefined) {
    state.engineScanMs = beat;
    const allowed = Math.max(CRANK_STALL_AFTER_MS, 2 * (intervalMs ?? 300_000) + 5 * 60_000);
    if (nowMs - beat > allowed) state.stalled = true;
  }
  return state;
}

/**
 * This pane's crank state, read straight from Redis (see the header). Never throws; undefined when
 * not in a zellij pane or Redis did not answer in time: an unreachable Redis is never read as OFF.
 */
export async function readPaneCrank(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): Promise<CrankState | undefined> {
  const where = zellijPane(env);
  if (!where) return undefined;
  const replies = await redisPipeline(redisEndpoint(env), [
    ["HGETALL", `crank:p:${where.session}:${where.pane}`],
    ["HGETALL", "crank:engine"],
    // An arbiter without crank_get (not reloaded yet) answers an error: no binding, the legacy hash decides.
    ["FCALL_RO", "crank_get", "0", where.session, where.pane],
  ], CRANK_READ_TIMEOUT_MS);
  if (!replies) return undefined;
  const session = crankFromBinding(replyToHash(replies[2]), nowMs);
  if (session) return session;
  const pane = replyToHash(replies[0]);
  const engine = replyToHash(replies[1]);
  if (!pane || !engine) return undefined;
  return crankFromArbiter(pane, engine, nowMs, where.session);
}

/**
 * The candybar icon: delorenj/icons `outline/candy`, drawn by the "pjangler Prompt Glyphs" font
 * (scripts/build-prompt-font.py --install) at U+10EF0D in Supplementary PUA-B, where no Nerd Font
 * glyph can shadow it. Keep in sync with GLYPHS in that script. A machine without the font shows
 * tofu: set PJ_PROMPT_CANDYBAR_GLYPH (e.g. to 🍫) there.
 */
export const CANDYBAR_GLYPH = "\u{10EF0D}";

/** `<candy> 3/124` — this project's candybars / the whole registry. */
export function formatCandybars(counts: CandybarCounts, env: NodeJS.ProcessEnv = process.env): string {
  const glyph = env.PJ_PROMPT_CANDYBAR_GLYPH || CANDYBAR_GLYPH;
  return `${glyph} ${counts.project}/${counts.total}`;
}

/** How long crank has run: `22m`, `5h22m`, `3d4h`, `1w3d` (two largest units, a zero second unit dropped). */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  const units: [string, number][] = [["w", 7 * 1440], ["d", 1440], ["h", 60], ["m", 1]];
  const first = units.findIndex(([, size]) => minutes >= size);
  const [bigName, bigSize] = units[first] as [string, number];
  const big = Math.floor(minutes / bigSize);
  const next = units[first + 1];
  const rest = next ? Math.floor((minutes % bigSize) / next[1]) : 0;
  return next && rest ? `${big}${bigName}${rest}${next[0]}` : `${big}${bigName}`;
}

/** Time to the next crank: minutes (`14m`, `2h5m`) until the last minute, then seconds (`42s`), then `now`. */
export function formatCountdown(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h${rest}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * `◌ crank off` when OFF. When ON: `⚡ crank ↑3d4h ↻5m ⏳2m` — how long it has been ON without a
 * break, the interval it cranks at, and the countdown to the next crank (computed at render time,
 * so it keeps counting between cache refreshes). A part whose fact is unknown is left out, never
 * guessed. When the engine had not scanned for CRANK_STALL_AFTER_MS (as the refresher read it) it
 * is not cranking anything, whatever Redis says: `⚠ crank stalled 25m ↻5m`. Always shown when known: absence must not read as OFF.
 */
export function formatCrank(crank: CrankState, nowMs: number = Date.now()): string {
  if (!crank.enabled) return "◌ crank off";
  const interval = crank.interval ? `↻${crank.interval}` : undefined;
  if (crank.stalled) {
    const since = crank.engineScanMs !== undefined ? formatSpan(nowMs - crank.engineScanMs) : undefined;
    return ["⚠ crank stalled", since, interval].filter(Boolean).join(" ");
  }
  const parts = ["⚡ crank"];
  if (crank.onSinceMs !== undefined) parts.push(`↑${formatSpan(nowMs - crank.onSinceMs)}`);
  if (interval) parts.push(interval);
  const parsed = parseInterval(crank.interval);
  const scheduled = crank.schedule ? nextFire(crank.schedule, nowMs) : undefined;
  if (scheduled !== undefined) {
    parts.push(`⏳${formatCountdown(scheduled - nowMs)}`);
  } else if (crank.nextDueMs !== undefined) {
    let next = crank.nextDueMs;
    if (crank.intervalMs && next < nowMs) next += Math.ceil((nowMs - next) / crank.intervalMs) * crank.intervalMs;
    parts.push(`⏳${formatCountdown(next - nowMs)}`);
  } else if (parsed) {
    const next = nextRunMs({ enabled: true, interval: parsed, lastRun: crank.lastRunMs, nowMs });
    if (next !== undefined) parts.push(`⏳${formatCountdown(next - nowMs)}`);
  }
  return parts.join(" ");
}

/**
 * Take the refresh lock (`<cache>.lock`, O_EXCL) so a burst of prompts — five panes in one
 * repo, a held Enter key — starts one child, not twenty. A lock older than
 * PIPELINE_LOCK_STALE_MS is a dead child's and is taken over.
 */
export function takeRefreshLock(cachePath: string, nowMs: number): boolean {
  const lock = `${cachePath}.lock`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (nowMs - statSync(lock).mtimeMs < PIPELINE_LOCK_STALE_MS) return false;
        unlinkSync(lock);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** dist/prompt-refresh.js, next to the running dist/prompt.js. */
export function refreshScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "prompt-refresh.js");
}

/**
 * Start the detached refresher for `root` when the cache is stale. Never blocks and never
 * throws: the child is unref'd with every stdio ignored, so the prompt exits at once.
 * `PJ_PROMPT_NO_REFRESH=1` turns it off (tests, or a machine without the 33GOD stack).
 */
export function maybeRefresh(root: string, cachePath: string, cache: PipelineCache | undefined, nowMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PJ_PROMPT_NO_REFRESH === "1" || !needsRefresh(cache, nowMs)) return false;
  if (!takeRefreshLock(cachePath, nowMs)) return false;
  try {
    const child = spawn(process.execPath, [refreshScriptPath(), root, cachePath], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    try {
      unlinkSync(`${cachePath}.lock`);
    } catch {
      // nothing to release
    }
    return false;
  }
}
