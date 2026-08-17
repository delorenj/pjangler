// Repo activity — "when was work last done here?"
//
// This replaces the `status` field, which claimed `planned` for 22 of the 27
// registered projects — pjangler itself among them, on a day it had commits.
// A repo in the registry is by definition past planning, so the field never
// varied and never informed.
//
// Activity is temporal instead of categorical, and COMPUTED instead of stored.
// A stored status goes stale the moment someone commits, which is exactly how
// the old one ended up wrong everywhere; deriving it from git at read time
// means it cannot drift, and no cron has to walk every project to keep it
// fresh. (The registry's own `updated_at` is not a substitute: it records the
// last registry write, not the last piece of work.)
//
// "Work" deliberately spans more than the checked-out branch:
//
//   refs        every local branch, remote-tracking branch, and tag
//   worktrees   every linked worktree's HEAD, which catches detached HEADs
//               whose commits are on no ref at all
//   uncommitted changes in the working tree that are not committed yet
//
// That breadth is not theoretical. Across the live registry, the newest work
// in several projects (deckard, intelliforia, slowburns) lives in a worktree,
// so a naive `git log -1` on the checked-out branch reports them as stale.
//
// Honesty note: remote-tracking refs reflect the last fetch, not the live
// remote. Asking the network would mean a round trip per project, which is
// unacceptable on a shell prompt. The winning source is always reported, so a
// reader can see whether the answer came from local or remote state.
//
// Structure: the parsing is pure and the IO is a thin driver, in two flavours
// (sync for one repo, async for scanning the whole registry concurrently).
// The tricky part is the parsing, and keeping it pure means it is unit
// testable without constructing a repo for every edge case.

import { spawn, spawnSync } from "../utils/child-process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** A repo counts as active when the newest work is within this window. */
export const ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;

/** Stop stat-ing dirty files past this many; the newest mtime converges fast. */
const MAX_DIRTY_STATS = 500;

export type ActivityKind = "ref" | "worktree" | "uncommitted";

export interface ActivitySource {
  kind: ActivityKind;
  /** Human label for the winning source: "main", "origin/feat/x", "3 files". */
  label: string;
  unix: number;
}

export interface RepoActivity {
  /** ISO-8601 of the newest work, or null when the repo has no history. */
  updated: string | null;
  updatedUnix: number | null;
  /** "3 hours ago" — or "never" when nothing has happened yet. */
  relative: string;
  /** Compact form for space-constrained surfaces like a shell prompt: "3h". */
  compact: string;
  /** Newest work is within ACTIVE_WINDOW_SECONDS. */
  active: boolean;
  source: ActivitySource | null;
  scanned: { refs: number; worktrees: number; dirtyFiles: number };
}

export interface ActivityOptions {
  /** Injected clock. Tests pass a fixed instant; production passes nothing. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Run a git subcommand in `repo`. Returns raw stdout, or undefined on failure. */
export function git(repo: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return result.stdout;
}

/** Async twin of `git`, so a registry scan can run repos concurrently. */
export function gitAsync(repo: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let size = 0;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, GIT_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += chunk.length;
      if (size > GIT_MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(undefined);
        return;
      }
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : undefined);
    });
  });
}

function trimmed(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/** Run a git subcommand and trim; undefined for failure or empty output. */
export function gitLine(repo: string, args: string[]): string | undefined {
  return trimmed(git(repo, args));
}

export function isGitRepo(repo: string): boolean {
  return gitLine(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * Human relative age. Deterministic and clock-injected so it is testable — no
 * "about a minute" fuzz, because a tool reporting staleness should be precise
 * about which bucket it chose.
 */
export function formatRelativeAge(deltaSeconds: number): string {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < WEEK) return plural(Math.floor(delta / DAY), "day");
  if (delta < MONTH) return plural(Math.floor(delta / WEEK), "week");
  if (delta < YEAR) return plural(Math.floor(delta / MONTH), "month");
  return plural(Math.floor(delta / YEAR), "year");
}

/** Same ladder, one or two characters wide, for prompts: "now", "5m", "3d". */
export function formatCompactAge(deltaSeconds: number): string {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}

// ---------------------------------------------------------------------------
// Commands (pure) — what to ask git
// ---------------------------------------------------------------------------

export const REF_ARGS = [
  "for-each-ref",
  "--sort=-committerdate",
  "--format=%(committerdate:unix)%09%(refname:short)",
  "refs/heads",
  "refs/remotes",
  "refs/tags",
];

export const WORKTREE_ARGS = ["worktree", "list", "--porcelain"];

/**
 * `--porcelain -z` is deliberate: the non-`-z` form C-quotes paths containing
 * spaces or unicode, and un-quoting that correctly is a parser nobody should
 * write. NUL separation sidesteps it.
 *
 * `--ignore-submodules=dirty` is also deliberate, on both cost and correctness
 * grounds. Cost: without it `git status` recurses into every submodule working
 * tree — measured at 100ms on the 33GOD superproject versus under a
 * millisecond with it, which alone would rule out the shell-prompt path.
 * Correctness: a submodule is its own repo with its own registry entry and its
 * own activity, so edits inside it are that project's work, not the
 * superproject's. Committed submodule POINTER moves still count, because those
 * genuinely are changes to this repo.
 */
export const STATUS_ARGS = ["status", "--porcelain", "-z", "--ignore-submodules=dirty"];

// ---------------------------------------------------------------------------
// Parsers (pure) — what git said
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  sha: string;
  detached: boolean;
}

/** Newest ref plus the total ref count, from one sorted ref walk. */
export function parseRefs(raw: string | undefined): { source?: ActivitySource; count: number } {
  if (raw === undefined) return { count: 0 };
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return { count: 0 };

  const [stamp, name] = lines[0]!.split("\t");
  const unix = Number(stamp);
  if (!Number.isFinite(unix) || unix <= 0) return { count: lines.length };
  return { source: { kind: "ref", label: name ?? "(unnamed ref)", unix }, count: lines.length };
}

export function parseWorktrees(raw: string | undefined): WorktreeEntry[] {
  if (raw === undefined) return [];
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; sha?: string; detached: boolean } = { detached: false };
  const flush = () => {
    if (current.path && current.sha) entries.push({ path: current.path, sha: current.sha, detached: current.detached });
    current = { detached: false };
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.sha = line.slice("HEAD ".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

/** Pick the newest worktree HEAD out of a `git show -s --format=%ct %H` batch. */
export function parseWorktreeStamps(raw: string | undefined, entries: readonly WorktreeEntry[]): ActivitySource | undefined {
  if (raw === undefined) return undefined;
  let best: ActivitySource | undefined;
  for (const line of raw.split("\n")) {
    const [stamp, sha] = line.trim().split(" ");
    const unix = Number(stamp);
    if (!Number.isFinite(unix) || unix <= 0 || !sha) continue;
    if (best && unix <= best.unix) continue;
    const owner = entries.find((entry) => entry.sha === sha);
    const name = owner ? basenameOf(owner.path) : sha.slice(0, 7);
    best = { kind: "worktree", label: owner?.detached ? `${name} (detached)` : name, unix };
  }
  return best;
}

/**
 * Paths from `git status --porcelain -z`. Every entry is "XY <path>"; renames
 * and copies are followed by a bare origin path with no status prefix, which
 * is consumed rather than treated as a second change.
 */
export function parseStatusPaths(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const parts = raw.split("\0").filter((part) => part !== "");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]!;
    if (entry.length < 4 || entry[2] !== " ") continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}

function basenameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Newest mtime among uncommitted paths. This is what makes "active" true while
 * you are mid-edit and have not committed yet — the case a commit-only signal
 * misses entirely.
 */
export function uncommittedSource(repo: string, paths: readonly string[]): ActivitySource | undefined {
  if (!paths.length) return undefined;
  let newest = 0;
  for (const path of paths.slice(0, MAX_DIRTY_STATS)) {
    try {
      const mtime = Math.floor(statSync(join(repo, path)).mtimeMs / 1000);
      if (mtime > newest) newest = mtime;
    } catch {
      // Deleted (or unreadable) paths have no mtime to contribute.
    }
  }
  if (newest <= 0) return undefined;
  const label = paths.length === 1 ? "1 uncommitted file" : `${paths.length} uncommitted files`;
  return { kind: "uncommitted", label, unix: newest };
}

// ---------------------------------------------------------------------------
// Assembly (pure)
// ---------------------------------------------------------------------------

const NO_ACTIVITY: RepoActivity = {
  updated: null,
  updatedUnix: null,
  relative: "never",
  compact: "—",
  active: false,
  source: null,
  scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 },
};

/** Empty activity, for a path that is not a git repo at all. */
export function emptyActivity(): RepoActivity {
  return { ...NO_ACTIVITY, scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 } };
}

/**
 * Ties break toward immediacy (uncommitted > worktree > ref): when a commit
 * and a working-tree edit share a second, the edit is the later event.
 */
export function assembleActivity(
  candidates: readonly (ActivitySource | undefined)[],
  scanned: RepoActivity["scanned"],
  now?: Date,
): RepoActivity {
  let winner: ActivitySource | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!winner || candidate.unix >= winner.unix) winner = candidate;
  }
  if (!winner) return { ...NO_ACTIVITY, scanned };

  const nowUnix = Math.floor((now?.getTime() ?? Date.now()) / 1000);
  const delta = nowUnix - winner.unix;
  return {
    updated: new Date(winner.unix * 1000).toISOString(),
    updatedUnix: winner.unix,
    relative: formatRelativeAge(delta),
    compact: formatCompactAge(delta),
    active: delta < ACTIVE_WINDOW_SECONDS,
    source: winner,
    scanned,
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * Newest work across every branch, worktree, and uncommitted change.
 *
 * There is deliberately no "fast, less accurate" variant. The three probes
 * together measure ~8ms of git, and the ~5ms a ref-only shortcut would save
 * comes at the cost of missing detached worktrees entirely — a repo whose work
 * happens in a detached worktree would report months of staleness. That is the
 * exact coverage this function exists to provide, so it is not optional.
 */
export function computeRepoActivity(repo: string, options: ActivityOptions = {}): RepoActivity {
  if (!isGitRepo(repo)) return emptyActivity();

  const refs = parseRefs(git(repo, REF_ARGS));
  const worktrees = parseWorktrees(git(repo, WORKTREE_ARGS));
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length
    ? parseWorktreeStamps(git(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees)
    : undefined;
  const paths = parseStatusPaths(git(repo, STATUS_ARGS));

  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now,
  );
}

/** Async twin of `computeRepoActivity`, for concurrent registry scans. */
export async function computeRepoActivityAsync(repo: string, options: ActivityOptions = {}): Promise<RepoActivity> {
  if (trimmed(await gitAsync(repo, ["rev-parse", "--is-inside-work-tree"])) !== "true") return emptyActivity();

  const [refRaw, worktreeRaw, statusRaw] = await Promise.all([
    gitAsync(repo, REF_ARGS),
    gitAsync(repo, WORKTREE_ARGS),
    gitAsync(repo, STATUS_ARGS),
  ]);

  const refs = parseRefs(refRaw);
  const worktrees = parseWorktrees(worktreeRaw);
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length
    ? parseWorktreeStamps(await gitAsync(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees)
    : undefined;
  const paths = parseStatusPaths(statusRaw);

  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now,
  );
}

/**
 * Activity for many repos at once, keyed by the path passed in.
 *
 * Scanning the live registry serially costs ~450ms across 27 projects, which
 * is a visible stall on `project list`; a bounded pool brings that down to
 * roughly the cost of the slowest repo.
 */
export async function computeRepoActivityBatch(
  repos: readonly string[],
  options: ActivityOptions & { concurrency?: number } = {},
): Promise<Map<string, RepoActivity>> {
  const results = new Map<string, RepoActivity>();
  const unique = [...new Set(repos)];
  const limit = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const repo = unique[cursor++]!;
      try {
        results.set(repo, await computeRepoActivityAsync(repo, options));
      } catch {
        results.set(repo, emptyActivity());
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, unique.length) }, worker));
  return results;
}
