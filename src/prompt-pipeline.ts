// The 33GOD pipeline segments of `pjangler-prompt`: how many candybars are
// registered (Candybar, the single clock) and whether crank mode is ON for the
// pane you are typing in (zcrank's Redis switches).
//
// Neither fact is cheap. Candybar is an HTTP API and the crank answer needs
// redis-cli plus `zellij action list-panes`, which the engine itself measures
// at seconds on a busy session. A prompt renders on every Enter, so the prompt
// NEVER computes them: it reads a small JSON cache and, when that cache is
// stale, spawns `dist/prompt-refresh.js` detached and returns immediately
// (stale-while-revalidate). The first prompt in a new place shows no pipeline
// segments; the next one does.
//
// This module imports node builtins (and the import-free ./crank/schedule) only. It is bundled into dist/prompt.js,
// whose whole reason to exist is a boot near node's own floor; the heavy crank
// and HTTP code lives in ./prompt-refresh.ts, a separate bundle that only the
// detached child ever loads.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextRunMs, parseInterval } from "./crank/schedule";

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
  /** What decided it: this pane's override, its live tab, or the project's resolved tab (outside zellij). */
  scope: "pane" | "tab" | "project";
  /**
   * Epoch ms crank has been ON without a break since: for a pane, open AND ON at every engine scan
   * since then (zcrank.py on_since.json, sharpened by the `enabled` log row that started it); for a
   * project outside zellij, its tab's last `enabled` row with no `disabled` after it. Absent = unknown.
   */
  onSinceMs?: number;
  /** Epoch ms of this tab's newest beat row; with `interval` it gives the next crank at render time. */
  lastRunMs?: number;
  /** Epoch ms of the engine's last scan (on_since.json scan_ts). */
  engineScanMs?: number;
  /**
   * The engine had not scanned for CRANK_STALL_AFTER_MS when this was READ (judged at write time:
   * a cache shown 10m later must not turn a healthy engine's normal scan age into a false alarm).
   */
  stalled?: boolean;
}

/**
 * The cache "root" of a zellij pane outside any pjangler project. Crank mode belongs to the pane,
 * not the project, so such a pane still gets a crank-only line; its cache is keyed by pane alone.
 */
export const PANE_ONLY_ROOT = "(pane)";

/** The engine scans every 5m tick; three missed ticks means it is not cranking anything. */
export const CRANK_STALL_AFTER_MS = 15 * 60_000;

export interface PipelineCache {
  v: number;
  writtenAtMs: number;
  root: string;
  /** null = Candybar did not answer (the segment is hidden, never guessed). */
  candybars: CandybarCounts | null;
  /** null = Redis did not answer (the segment is hidden, never guessed). */
  crank: CrankState | null;
}

/** `$PJ_PROMPT_CACHE_DIR`, else `$XDG_CACHE_HOME/pjangler/prompt`, else `~/.cache/pjangler/prompt`. */
export function pipelineCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PJ_PROMPT_CACHE_DIR) return env.PJ_PROMPT_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "pjangler", "prompt");
}

/**
 * One cache file per (project root, zellij pane). The crank answer is per pane — a pane
 * override beats its tab — so two panes in one repo must not share a file.
 */
export function pipelineCachePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const pane = env.ZELLIJ_PANE_ID ? `${env.ZELLIJ_SESSION_NAME ?? ""}:${env.ZELLIJ_PANE_ID}` : "";
  const key = createHash("sha1").update(`${root}\0${pane}`).digest("hex").slice(0, 16);
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
  return !!v && typeof v.enabled === "boolean" && ["pane", "tab", "project"].includes(v.scope)
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
    };
  } catch {
    return undefined;
  }
}

/** The segments a cache is fit to show at `nowMs`: nothing once it has expired. */
export function freshSegments(cache: PipelineCache | undefined, nowMs: number): Pick<PipelineCache, "candybars" | "crank"> {
  if (!cache) return { candybars: null, crank: null };
  const age = nowMs - cache.writtenAtMs;
  // A clock that went backwards (or a cache from the future) is not trusted either.
  if (age > PIPELINE_EXPIRE_AFTER_MS || age < -PIPELINE_REFRESH_AFTER_MS) return { candybars: null, crank: null };
  return { candybars: cache.candybars, crank: cache.crank };
}

export function needsRefresh(cache: PipelineCache | undefined, nowMs: number): boolean {
  if (!cache) return true;
  const age = nowMs - cache.writtenAtMs;
  return age > PIPELINE_REFRESH_AFTER_MS || age < 0;
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
  if (parsed) {
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
      cwd: root === PANE_ONLY_ROOT ? homedir() : root,
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
