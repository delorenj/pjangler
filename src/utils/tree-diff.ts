import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export type TreeSnapshot = Map<string, string>;

const TOP_LEVEL_EXCLUDED = new Set([".git", ".worktrees"]);
// Live processes rewrite these while pj runs: the repo's own Hermes agent home
// (agents/hermes/*/runtime: sqlite WAL, logs, locks), dependency trees, and
// indexes. They are never installer or companion output, so a write there is
// not the subject's write, and a rollback must never rewind a running daemon.
const RUNTIME_SEGMENTS = new Set(["runtime", "node_modules", ".codegraph", "__pycache__"]);
const RUNTIME_SUFFIXES = [".pid", ".sock", ".log", ".db-wal", ".db-shm", ".db-journal"];

/** Git internals, worktrees, and runtime state are outside every tree snapshot. */
export function excludedFromTreeSnapshot(rel: string): boolean {
  if (rel === ".") return false;
  const segments = rel.split(/[\\/]/);
  if (TOP_LEVEL_EXCLUDED.has(segments[0]!)) return true;
  if (segments.some((segment) => RUNTIME_SEGMENTS.has(segment))) return true;
  const name = segments[segments.length - 1]!;
  return RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix));
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
  if (excludedFromTreeSnapshot(rel)) return snapshot;
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
