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

export interface TreeSnapshotOptions {
  /**
   * Repo-relative roots to walk instead of the whole tree. Keys stay relative to
   * `root`, so scoped and whole-tree snapshots diff the same way; an absent root
   * is simply absent (its later creation is a change).
   */
  roots?: readonly string[];
  /**
   * Record an entry the walk may not read (EACCES/EPERM) as a metadata
   * fingerprint instead of throwing. mtime/ctime still move on any write or
   * chmod, so a change to the unreadable entry is still a change.
   */
  tolerateUnreadable?: boolean;
}

const unreadable = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" ? code : undefined;
};

/**
 * Snapshot operator-visible project files while excluding Git internals and
 * runtime state. With no options this is the whole tree and any read failure
 * throws, exactly as before PJAN-178.
 */
export function snapshotTree(root: string, options: TreeSnapshotOptions = {}): TreeSnapshot {
  const snapshot: TreeSnapshot = new Map();
  const tolerate = Boolean(options.tolerateUnreadable);
  const walk = (current: string): void => {
    let lstat;
    try { lstat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      const code = tolerate ? unreadable(error) : undefined;
      if (!code) throw error;
      snapshot.set(relative(root, current) || ".", `unreadable:${code}`);
      return;
    }
    const stat = lstat;
    const rel = relative(root, current) || ".";
    if (excludedFromTreeSnapshot(rel, current)) return;
    const fingerprint = (code: string) => `unreadable:${code}:${stat.mode & 0o7777}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (stat.isSymbolicLink()) {
      snapshot.set(rel, `link:${readlinkSync(current)}`);
    } else if (stat.isFile()) {
      let bytes: Buffer;
      try { bytes = readFileSync(current); }
      catch (error) {
        const code = tolerate ? unreadable(error) : undefined;
        if (!code) throw error;
        snapshot.set(rel, `file:${fingerprint(code)}`);
        return;
      }
      snapshot.set(rel, `file:${createHash("sha256").update(bytes).digest("hex")}:${stat.mode & 0o7777}`);
    } else if (stat.isDirectory()) {
      let names: string[];
      try { names = readdirSync(current); }
      catch (error) {
        const code = tolerate ? unreadable(error) : undefined;
        if (!code) throw error;
        snapshot.set(rel, `dir:${fingerprint(code)}`);
        return;
      }
      snapshot.set(rel, `dir:${stat.mode & 0o7777}`);
      for (const name of names) walk(join(current, name));
    } else {
      snapshot.set(rel, `other:${stat.mode}`);
    }
  };
  // A nested root (".claude/skills") is only walked when every ancestor is a
  // real directory. The whole-tree walk never followed a symlinked `.claude`
  // (it recorded the link) nor descended a regular file named `.claude`; a scoped
  // walk must not either, or it would watch paths outside the repo or throw
  // ENOTDIR. A non-directory ancestor is recorded as the entry it is.
  const scopedWalk = (scoped: string): void => {
    const parts = scoped.split(/[\\/]/).filter(Boolean);
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestor = join(root, ...parts.slice(0, depth));
      try {
        const stat = lstatSync(ancestor);
        if (stat.isDirectory()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      }
      walk(ancestor); // records a link/file/unreadable ancestor, or throws as the whole-tree walk would
      return;
    }
    walk(join(root, scoped));
  };
  for (const scoped of options.roots ?? ["."]) scopedWalk(scoped);
  return snapshot;
}

export function changedTreePaths(root: string, before: TreeSnapshot, after: TreeSnapshot): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => join(root, path))
    .sort();
}
