import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export type TreeSnapshot = Map<string, string>;

const TOP_LEVEL_EXCLUDED = new Set([".git", ".worktrees"]);
// Live processes rewrite these while pj runs: the repo's own Hermes agent homes
// (agents/hermes/<agent>/runtime: sqlite, logs, locks), dependency trees,
// indexes, and any sqlite database with a live journal. They are never
// installer or companion output, so a write there is not the subject's write,
// and a rollback must never rewind a running daemon.
const RUNTIME_SEGMENTS = new Set(["node_modules", ".codegraph", "__pycache__"]);
const RUNTIME_SUFFIXES = [".pid", ".sock", ".log", ".db-wal", ".db-shm", ".db-journal"];

/** Git internals, worktrees, and runtime state are outside every tree snapshot. */
export function excludedFromTreeSnapshot(rel: string, full?: string): boolean {
  if (rel === ".") return false;
  const segments = rel.split(/[\\/]/);
  if (TOP_LEVEL_EXCLUDED.has(segments[0]!)) return true;
  if (segments.some((segment) => RUNTIME_SEGMENTS.has(segment))) return true;
  if (segments[0] === "agents" && segments[1] === "hermes" && segments[3] === "runtime") return true;
  const name = segments[segments.length - 1]!;
  if (RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // Rewinding a database without its journal hands sqlite a mismatched pair.
  return Boolean(full && name.endsWith(".db") && (existsSync(`${full}-wal`) || existsSync(`${full}-journal`)));
}

/** Snapshot operator-visible project files while excluding Git internals and runtime state. */
export function snapshotTree(root: string, current = root, snapshot: TreeSnapshot = new Map()): TreeSnapshot {
  let stat;
  try { stat = lstatSync(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
    throw error;
  }
  const rel = relative(root, current) || ".";
  if (excludedFromTreeSnapshot(rel, current)) return snapshot;
  if (stat.isSymbolicLink()) {
    snapshot.set(rel, `link:${readlinkSync(current)}`);
  } else if (stat.isFile()) {
    snapshot.set(rel, `file:${createHash("sha256").update(readFileSync(current)).digest("hex")}:${stat.mode & 0o7777}`);
  } else if (stat.isDirectory()) {
    snapshot.set(rel, `dir:${stat.mode & 0o7777}`);
    for (const name of readdirSync(current)) snapshotTree(root, join(current, name), snapshot);
  } else {
    snapshot.set(rel, `other:${stat.mode}`);
  }
  return snapshot;
}

export function changedTreePaths(root: string, before: TreeSnapshot, after: TreeSnapshot): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => join(root, path))
    .sort();
}
