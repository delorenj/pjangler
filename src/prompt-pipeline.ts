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
// This module imports node builtins only. It is bundled into dist/prompt.js,
// whose whole reason to exist is a boot near node's own floor; the heavy crank
// and HTTP code lives in ./prompt-refresh.ts, a separate bundle that only the
// detached child ever loads.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
}

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

function isCrank(value: unknown): value is CrankState {
  const v = value as CrankState;
  return !!v && typeof v.enabled === "boolean" && ["pane", "tab", "project"].includes(v.scope)
    && (v.interval === undefined || typeof v.interval === "string");
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

/** `⚡ crank 5m` when ON, `◌ crank off` when OFF. Always shown when known: absence must not read as OFF. */
export function formatCrank(crank: CrankState): string {
  if (!crank.enabled) return "◌ crank off";
  return crank.interval ? `⚡ crank ${crank.interval}` : "⚡ crank";
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
