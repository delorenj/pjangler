#!/usr/bin/env node
// `dist/prompt-refresh.js <root> <cachePath>` — the detached half of the
// pjangler prompt's 33GOD pipeline segments (see ./prompt-pipeline.ts).
//
// `pjangler-prompt` spawns this, unref'd, whenever its cache is stale, and never
// waits for it. It computes the two slow facts and atomically replaces the
// cache file, then releases the lock the prompt took:
//
//   candybars  GET $CANDYBAR_API_URL/candybars (default http://127.0.0.1:8700),
//              counting registered (non-archived) rows in the whole registry and
//              those tagged `project:<repo>`. <repo> is candybar's own project
//              name: the main checkout's basename, so a linked worktree counts
//              as its repo (candybar/src/candybar/project.py, find_project).
//   crank      ONLY for a project OUTSIDE zellij (inside a pane `pjangler-prompt` reads the arbiter's
//              per-pane hash directly and this child computes no crank at all): the project's resolved
//              tab, asked of the arbiter (crank_resolve) the way `pj crank` does — ON/OFF and the
//              interval are the arbiter's verdict, never re-derived here.
//   uptime     How long crank has been ON without a break: the oldest arbiter `since` (crank:p:*)
//              among the tab's ON panes.
//   next crank The tab's interval and newest beat row; the prompt does the countdown
//              math at render time so it keeps moving between refreshes.
//   stalled    The engine heartbeat (crank:engine scan_ms) is absent or older than CRANK_STALL_AFTER_MS.
//   pin        The hermes-agent-template commit Flume pins (`HEAD:templates/hermes-agent` in
//              $FLUME_ROOT, default ~/code/33GOD/flume), so the prompt can say a PM is behind it.
//
// A fact that cannot be read is written as null and the prompt hides that
// segment. It is never guessed: "crank off" when Redis is down would be a lie.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { contextFor, currentProjectNames } from "./crank/cli";
import { canon, keyScopeOf, redis, snapshotCrank, storedTabKeys } from "./crank/index";
import { redisEndpoint } from "./crank/redisEndpoint";
import { redisPipeline, replyToHash } from "./crank/resp";
import { CRANK_STALL_AFTER_MS, PIPELINE_CACHE_VERSION, zellijPane, type CandybarCounts, type CrankState, type PipelineCache } from "./prompt-pipeline";

const CANDYBAR_DEFAULT_API_URL = "http://127.0.0.1:8700";
const CANDYBAR_TIMEOUT_MS = 3_000;
const PROJECT_TAG_PREFIX = "project:";
const CANDYBARS_DIR = ".candybars";
const CANDYBAR_PROJECT_FILE = ".candybar.toml";
/** Cache files nobody has refreshed for this long belong to dead panes/sessions and are swept. */
const CACHE_SWEEP_AFTER_MS = 24 * 3600_000;

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const out = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
    const value = (out.stdout ?? "").trim();
    return out.status === 0 && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Candybar's project name for `dir` — a port of candybar/src/candybar/project.py find_project +
 * _git_project_name, so the `project:<name>` tag we count is the one candybar writes. Keep in sync.
 *   - in git: the toplevel's basename, except a linked worktree takes its main checkout's name
 *     (`--git-common-dir` is `<main>/.git`), a bare repo's worktree takes `<bare>` minus `.git`,
 *     and a submodule (`.git/modules/<name>`) keeps its toplevel basename;
 *   - outside git: the nearest ancestor holding `.candybars/` or `.candybar.toml`, else none.
 */
export function candybarProjectName(dir: string): string | undefined {
  let here: string;
  try {
    here = realpathSync(dir);
  } catch {
    return undefined;
  }
  const top = git(here, "rev-parse", "--show-toplevel");
  if (top) {
    const topName = basename(top);
    const common = git(here, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common) return topName;
    let name: string;
    if (basename(common) === ".git") name = basename(dirname(common));
    else if (basename(dirname(common)) === "modules") return topName;
    else name = basename(common).replace(/\.git$/, "");
    return name && name !== topName ? name : topName;
  }
  for (let candidate = here; ; candidate = dirname(candidate)) {
    if (isDir(join(candidate, CANDYBARS_DIR)) || isFile(join(candidate, CANDYBAR_PROJECT_FILE))) return basename(candidate);
    if (dirname(candidate) === candidate) return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Count registered (non-archived) rows overall and for one project tag. Pure. */
export function countCandybars(rows: unknown, projectName: string | undefined): CandybarCounts | null {
  if (!Array.isArray(rows)) return null;
  // No candybar project here => nothing can be tagged for it; the registry total still counts.
  const tag = projectName ? `${PROJECT_TAG_PREFIX}${projectName}` : undefined;
  let total = 0;
  let project = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { archived?: unknown; tags?: unknown };
    if (r.archived === true) continue;
    total++;
    if (tag && Array.isArray(r.tags) && r.tags.includes(tag)) project++;
  }
  return { project, total };
}

export async function readCandybars(root: string, env: NodeJS.ProcessEnv = process.env): Promise<CandybarCounts | null> {
  const base = (env.CANDYBAR_API_URL || CANDYBAR_DEFAULT_API_URL).replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/candybars`, { signal: AbortSignal.timeout(CANDYBAR_TIMEOUT_MS) });
    if (!response.ok) return null;
    return countCandybars(await response.json(), candybarProjectName(root));
  } catch {
    return null;
  }
}

/** The fields of a crank:p hash the project path reads (HMGET order). */
export const ARBITER_PANE_FIELDS = ["on", "since", "tab", "tab_key", "keys"] as const;

function jsonList(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * When a project's tab has been ON without a break: the oldest `since` among the arbiter's ON panes
 * that this tab governs. A pane belongs to the tab when a key governing it is one of the project's
 * keys, or when its tab name canonicalises to the tab's. Pure; undefined = no such pane (unknown).
 */
export function tabOnSinceMs(
  panes: Record<string, string>[],
  tab: string,
  tabKeys: string[],
): number | undefined {
  const want = canon(tab);
  let best: number | undefined;
  for (const pane of panes) {
    if (pane.on !== "1") continue;
    const since = Number(pane.since);
    if (!Number.isFinite(since) || since <= 0) continue;
    const governs = jsonList(pane.keys).some((key) => tabKeys.includes(key));
    const named = !!want && (canon(pane.tab) === want || canon(pane.tab_key) === want);
    if ((governs || named) && (best === undefined || since < best)) best = since;
  }
  return best;
}

/**
 * The arbiter's facts a project's ON segment needs, over one pipelined connection each round:
 * the engine heartbeat and every resolved pane (crank:idx:panes -> HMGET). undefined = Redis did
 * not answer (the timing stays unknown; it is never invented).
 */
export async function readArbiterFacts(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 2_000,
): Promise<{ engineScanMs?: number; panes: Record<string, string>[] } | undefined> {
  const endpoint = redisEndpoint(env);
  const first = await redisPipeline(endpoint, [["SMEMBERS", "crank:idx:panes"], ["HGETALL", "crank:engine"]], timeoutMs);
  if (!first) return undefined;
  const members = Array.isArray(first[0]) ? first[0].filter((m): m is string => typeof m === "string") : [];
  const scan = Number(replyToHash(first[1])?.scan_ms);
  const engineScanMs = Number.isFinite(scan) && scan > 0 ? scan : undefined;
  if (!members.length) return { engineScanMs, panes: [] };
  const second = await redisPipeline(endpoint, members.map((key) => ["HMGET", key, ...ARBITER_PANE_FIELDS]), timeoutMs);
  if (!second) return undefined;
  const panes: Record<string, string>[] = [];
  for (const reply of second) {
    if (!Array.isArray(reply)) continue;
    const row: Record<string, string> = {};
    ARBITER_PANE_FIELDS.forEach((field, i) => {
      const value = reply[i];
      if (typeof value === "string") row[field] = value;
    });
    panes.push(row);
  }
  return { engineScanMs, panes };
}

/**
 * The crank state of the project at the cwd, for a shell OUTSIDE zellij (scope "project"). ON/OFF and
 * the interval are the arbiter's verdict (via snapshotCrank -> crank_resolve). null = Redis or the
 * arbiter did not answer: the segment is hidden, never guessed OFF.
 */
export async function readCrank(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): Promise<CrankState | null> {
  try {
    const store = redis();
    if (!store.ping()) return null;
    const keys = storedTabKeys(store);
    const project = currentProjectNames();
    const ctx = contextFor(project, store);
    const snapshot = snapshotCrank(store, ctx.resolution.tab, keys, nowMs, 0, keyScopeOf(ctx));
    const state: CrankState = { enabled: snapshot.enabled === true, interval: snapshot.interval, scope: "project" };
    if (!state.enabled) return state;
    if (snapshot.lastRunMs !== undefined) state.lastRunMs = snapshot.lastRunMs;
    const facts = await readArbiterFacts(env);
    if (!facts) return state;
    const onSince = tabOnSinceMs(facts.panes, ctx.resolution.tab, snapshot.keys);
    if (onSince !== undefined) state.onSinceMs = onSince;
    if (facts.engineScanMs !== undefined) state.engineScanMs = facts.engineScanMs;
    // No heartbeat at all is as stalled as an old one: nothing is resolving crank.
    if (facts.engineScanMs === undefined || nowMs - facts.engineScanMs > CRANK_STALL_AFTER_MS) state.stalled = true;
    return state;
  } catch {
    return null;
  }
}

export function writeCacheAtomically(cachePath: string, cache: PipelineCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, cachePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw error;
  }
}

/** Delete cache/lock/tmp files in `dir` untouched for CACHE_SWEEP_AFTER_MS (dead panes, old sessions). */
export function sweepCacheDir(dir: string, nowMs: number = Date.now(), keep?: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.json(\.lock|\.\d+\.tmp)?$/.test(name)) continue;
    const path = join(dir, name);
    if (path === keep) continue;
    try {
      if (nowMs - statSync(path).mtimeMs > CACHE_SWEEP_AFTER_MS) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // raced with another sweeper
    }
  }
  return removed;
}

/** The template commit Flume pins: its committed gitlink, never a worktree. null = unknown. */
export function readTemplatePin(env: NodeJS.ProcessEnv = process.env): string | null {
  const flume = env.FLUME_ROOT || join(env.HOME || homedir(), "code", "33GOD", "flume");
  const result = spawnSync("git", ["--no-optional-locks", "-C", flume, "rev-parse", "HEAD:templates/hermes-agent"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rev = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(rev) ? rev : null;
}

async function main(): Promise<void> {
  const [root, cachePath] = process.argv.slice(2);
  if (!root || !cachePath) return;
  try {
    // Sequential on purpose: readCrank is spawnSync-bound and would starve an in-flight fetch anyway.
    // Inside a zellij pane the prompt reads crank straight from the arbiter, so the cache carries none.
    const candybars = await readCandybars(root);
    const crank = zellijPane(process.env) ? null : await readCrank(process.env, Date.now());
    const templatePin = readTemplatePin();
    writeCacheAtomically(cachePath, { v: PIPELINE_CACHE_VERSION, writtenAtMs: Date.now(), root, candybars, crank, templatePin });
    sweepCacheDir(dirname(cachePath), Date.now(), cachePath);
  } catch {
    // A refresher that fails leaves the old cache; the prompt ages it out.
  } finally {
    try {
      unlinkSync(`${cachePath}.lock`);
    } catch {
      // already gone
    }
  }
}

if (process.argv[1] && /prompt-refresh\.js$/.test(process.argv[1])) void main();
