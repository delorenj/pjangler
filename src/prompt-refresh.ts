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
//   crank      Inside the zcrank zellij session, the ENGINE's answer for this
//              very pane (zcrank.py crank_enabled): a zcrank:pane override wins
//              (any OFF across spellings wins), else every key naming the live
//              tab — by name, or by `root` == the tab's owner — must be ON;
//              unlisted = OFF. Outside that session there is no pane for the
//              beat to type into, so it reports the project's resolved tab the
//              way `pj crank` does.
//
// A fact that cannot be read is written as null and the prompt hides that
// segment. It is never guessed: "crank off" when Redis is down would be a lie.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { contextFor, currentProjectNames } from "./crank/cli";
import {
  IDENTITY_BUDGET_MS,
  ZCRANK_SESSION,
  keysNamingTab,
  livePanes,
  liveTabs,
  projectIdentity,
  resolvePaneCwds,
  withTabOwners,
  redis,
  snapshotCrank,
  storedTabKeys,
  storedTabRoots,
  tabDisplay,
  keyScopeOf,
  type CrankStore,
  type IdentityBudget,
  type IdentityCache,
} from "./crank/index";
import { PIPELINE_CACHE_VERSION, type CandybarCounts, type CrankState, type PipelineCache } from "./prompt-pipeline";

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

/**
 * zcrank.py crank_enabled(tab_name, pane_id, owner), over pjangler's store. `pane` is the
 * engine's pane id (`terminal_<N>`). Returns which rule decided, so the prompt can say so.
 */
export function engineCrankFor(
  store: Pick<CrankStore, "getKey" | "tabEnabled">,
  tabName: string,
  pane: string | undefined,
  storedKeys: string[],
  scope: { owner?: string; roots?: Record<string, string> },
): { enabled: boolean; decidedBy: "pane" | "tab"; keys: string[] } {
  const name = tabDisplay(tabName);
  const keys = keysNamingTab(name, storedKeys, scope);
  if (pane !== undefined) {
    const owners = [...new Set([...keys, name])].filter(Boolean);
    const found = owners.map((o) => store.getKey(`zcrank:pane:${o}:${pane}`)).filter((v): v is string => v !== undefined);
    if (found.length) return { enabled: found.every((v) => v === "1"), decidedBy: "pane", keys };
  }
  if (!keys.length) return { enabled: false, decidedBy: "tab", keys };
  return { enabled: keys.every((key) => store.tabEnabled(key) === "1"), decidedBy: "tab", keys };
}

export function readCrank(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): CrankState | null {
  try {
    const store = redis();
    if (!store.ping()) return null;
    const keys = storedTabKeys(store);
    const roots = storedTabRoots(store, keys);

    const paneNumber = Number.parseInt(env.ZELLIJ_PANE_ID ?? "", 10);
    if (env.ZELLIJ_SESSION_NAME === ZCRANK_SESSION && Number.isInteger(paneNumber)) {
      // ONE list-panes call (~2.5s on a busy session): it finds this pane's tab AND, only when some
      // key carries a `root` (the engine's own shortcut in zcrank.py scan), feeds the tab owners.
      // retries: 0 — a withheld cwd comes from the engine's shared pane-cwd memory instead.
      const claimed = Object.values(roots);
      const panes = claimed.length ? resolvePaneCwds(() => livePanes(), { retries: 0, nowMs }) : livePanes();
      const me = panes.find((p) => !p.isPlugin && p.id === paneNumber);
      if (me) {
        let owner: string | undefined;
        if (claimed.length) {
          const cache: IdentityCache = new Map();
          const budget: IdentityBudget = { totalMs: IDENTITY_BUDGET_MS };
          const tabs = withTabOwners(liveTabs(), panes, (cwd) => projectIdentity(cwd, { cache, budget }), claimed);
          const tab = tabs.find((t) => me.tabId !== undefined && t.id === me.tabId)
            ?? tabs.find((t) => me.tabPosition !== undefined && t.position === me.tabPosition)
            ?? tabs.find((t) => t.name === me.tabName);
          owner = tab?.owner;
        }
        const scope = { owner, roots };
        const verdict = engineCrankFor(store, me.tabName, `terminal_${paneNumber}`, keys, scope);
        const snapshot = snapshotCrank(store, tabDisplay(me.tabName), keys, nowMs, 0, scope);
        return { enabled: verdict.enabled, interval: snapshot.interval, scope: verdict.decidedBy };
      }
      // We ARE a Workspace pane but could not see ourselves (list-panes failed, timed out, or has not
      // caught up): no answer, not the project's answer. The engine decides by tab, so a project
      // verdict here can be the opposite of what the beat will do.
      return null;
    }

    // Outside the crank session: the project's own switch, resolved exactly as `pj crank` does.
    const project = currentProjectNames();
    const ctx = contextFor(project, store);
    const snapshot = snapshotCrank(store, ctx.resolution.tab, keys, nowMs, 0, keyScopeOf(ctx));
    return { enabled: snapshot.enabled === true, interval: snapshot.interval, scope: "project" };
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

async function main(): Promise<void> {
  const [root, cachePath] = process.argv.slice(2);
  if (!root || !cachePath) return;
  try {
    // Sequential on purpose: readCrank is spawnSync-bound and would starve an in-flight fetch anyway.
    const candybars = await readCandybars(root);
    const crank = readCrank();
    writeCacheAtomically(cachePath, { v: PIPELINE_CACHE_VERSION, writtenAtMs: Date.now(), root, candybars, crank });
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
