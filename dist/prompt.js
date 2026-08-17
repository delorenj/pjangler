#!/usr/bin/env node

// src/prompt.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join as join2, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/describe/activity.ts
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
var ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;
var MAX_DIRTY_STATS = 500;
var GIT_TIMEOUT_MS = 5e3;
var GIT_MAX_BUFFER = 16 * 1024 * 1024;
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return void 0;
  return result.stdout;
}
function trimmed(raw) {
  if (raw === void 0) return void 0;
  const value = raw.trim();
  return value === "" ? void 0 : value;
}
function gitLine(repo, args) {
  return trimmed(git(repo, args));
}
function isGitRepo(repo) {
  return gitLine(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
var MINUTE = 60;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var WEEK = 7 * DAY;
var MONTH = 30 * DAY;
var YEAR = 365 * DAY;
function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
function formatRelativeAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < WEEK) return plural(Math.floor(delta / DAY), "day");
  if (delta < MONTH) return plural(Math.floor(delta / WEEK), "week");
  if (delta < YEAR) return plural(Math.floor(delta / MONTH), "month");
  return plural(Math.floor(delta / YEAR), "year");
}
function formatCompactAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}
var REF_ARGS = [
  "for-each-ref",
  "--sort=-committerdate",
  "--format=%(committerdate:unix)%09%(refname:short)",
  "refs/heads",
  "refs/remotes",
  "refs/tags"
];
var WORKTREE_ARGS = ["worktree", "list", "--porcelain"];
var STATUS_ARGS = ["status", "--porcelain", "-z", "--ignore-submodules=dirty"];
function parseRefs(raw) {
  if (raw === void 0) return { count: 0 };
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return { count: 0 };
  const [stamp, name] = lines[0].split("	");
  const unix = Number(stamp);
  if (!Number.isFinite(unix) || unix <= 0) return { count: lines.length };
  return { source: { kind: "ref", label: name ?? "(unnamed ref)", unix }, count: lines.length };
}
function parseWorktrees(raw) {
  if (raw === void 0) return [];
  const entries = [];
  let current = { detached: false };
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
function parseWorktreeStamps(raw, entries) {
  if (raw === void 0) return void 0;
  let best;
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
function parseStatusPaths(raw) {
  if (raw === void 0) return [];
  const parts = raw.split("\0").filter((part) => part !== "");
  const paths = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4 || entry[2] !== " ") continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}
function basenameOf(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function uncommittedSource(repo, paths) {
  if (!paths.length) return void 0;
  let newest = 0;
  for (const path of paths.slice(0, MAX_DIRTY_STATS)) {
    try {
      const mtime = Math.floor(statSync(join(repo, path)).mtimeMs / 1e3);
      if (mtime > newest) newest = mtime;
    } catch {
    }
  }
  if (newest <= 0) return void 0;
  const label = paths.length === 1 ? "1 uncommitted file" : `${paths.length} uncommitted files`;
  return { kind: "uncommitted", label, unix: newest };
}
var NO_ACTIVITY = {
  updated: null,
  updatedUnix: null,
  relative: "never",
  compact: "\u2014",
  active: false,
  source: null,
  scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 }
};
function emptyActivity() {
  return { ...NO_ACTIVITY, scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 } };
}
function assembleActivity(candidates, scanned, now) {
  let winner = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!winner || candidate.unix >= winner.unix) winner = candidate;
  }
  if (!winner) return { ...NO_ACTIVITY, scanned };
  const nowUnix = Math.floor((now?.getTime() ?? Date.now()) / 1e3);
  const delta = nowUnix - winner.unix;
  return {
    updated: new Date(winner.unix * 1e3).toISOString(),
    updatedUnix: winner.unix,
    relative: formatRelativeAge(delta),
    compact: formatCompactAge(delta),
    active: delta < ACTIVE_WINDOW_SECONDS,
    source: winner,
    scanned
  };
}
function computeRepoActivity(repo, options = {}) {
  if (!isGitRepo(repo)) return emptyActivity();
  const refs = parseRefs(git(repo, REF_ARGS));
  const worktrees = parseWorktrees(git(repo, WORKTREE_ARGS));
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length ? parseWorktreeStamps(git(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees) : void 0;
  const paths = parseStatusPaths(git(repo, STATUS_ARGS));
  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now
  );
}

// src/prompt.ts
function findProjectRoot(from) {
  let dir = resolve(from);
  for (; ; ) {
    if (existsSync(join2(dir, ".project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function readPromptFacts(root, now) {
  let slug = basename(root);
  let identifier;
  try {
    const manifest = JSON.parse(readFileSync(join2(root, ".project.json"), "utf8"));
    if (typeof manifest.project_slug === "string" && manifest.project_slug) slug = manifest.project_slug;
    const provider = manifest.ticket_provider;
    if (provider && typeof provider.identifier === "string" && provider.identifier) identifier = provider.identifier;
  } catch {
  }
  const activity = computeRepoActivity(root, { now });
  return {
    root,
    slug,
    identifier,
    age: activity.updatedUnix ? activity.compact : void 0,
    active: activity.active
  };
}
function formatPromptLine(facts) {
  const parts = [facts.slug];
  if (facts.identifier) parts.push(`(${facts.identifier})`);
  const head = parts.join(" ");
  return facts.age ? `${head} \xB7 ${facts.age}` : head;
}
function promptLine(cwd, now) {
  const root = findProjectRoot(cwd);
  if (!root) return void 0;
  return formatPromptLine(readPromptFacts(root, now));
}
function main() {
  try {
    const line = promptLine(process.cwd());
    if (line) process.stdout.write(line);
  } catch {
  }
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMainModule()) main();
export {
  findProjectRoot,
  formatPromptLine,
  promptLine,
  readPromptFacts
};
