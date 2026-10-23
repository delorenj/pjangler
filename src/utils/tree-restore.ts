import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { excludedFromTreeSnapshot, type TreeSnapshot } from "./tree-diff";

/**
 * Byte-exact tree backups (moved out of src/bmad/companion.ts by PJAN-180; named tree-restore, not
 * tree-backup, because `*-backup.*` is the machine-wide backup-copy pattern).
 *
 * A backup records regular files (bytes + mode), directories (mode) and
 * symlinks (target). Anything else (fifo, socket, device) is invisible to it:
 * never captured, never restored, never deleted.
 */
export type TreeBackupEntry =
  | { kind: "dir"; mode: number }
  | { kind: "link"; target: string }
  | { kind: "file"; mode: number; bytes: Buffer };

export type TreeBackup = Map<string, TreeBackupEntry>;

export interface TreeBackupOptions {
  /** Repo-relative paths (and their subtrees) the capture never enters. */
  exclude?: (rel: string) => boolean;
}

export function captureTreeBackup(root: string, current = root, backup: TreeBackup = new Map(), opts: TreeBackupOptions = {}): TreeBackup {
  let stat;
  try { stat = lstatSync(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return backup;
    throw error;
  }
  const rel = relative(root, current) || ".";
  if (excludedFromTreeSnapshot(rel, current)) return backup;
  if (rel !== "." && opts.exclude?.(rel)) return backup;
  if (stat.isSymbolicLink()) {
    backup.set(rel, { kind: "link", target: readlinkSync(current) });
  } else if (stat.isFile()) {
    backup.set(rel, { kind: "file", mode: stat.mode & 0o7777, bytes: Buffer.from(readFileSync(current)) });
  } else if (stat.isDirectory()) {
    backup.set(rel, { kind: "dir", mode: stat.mode & 0o7777 });
    for (const name of readdirSync(current).sort()) captureTreeBackup(root, join(current, name), backup, opts);
  }
  return backup;
}

/**
 * Capture repo-relative `roots` exactly the way snapshotTree's scoped walk sees
 * them: a root is only descended when every ancestor is a real directory; a
 * symlink or file ancestor is captured as the entry it is and the root behind
 * it is not entered. So backupToSnapshot(captureScopedRoots(r, roots)) and
 * snapshotTree(r, { roots }) describe the same paths.
 */
export function captureScopedRoots(root: string, roots: readonly string[], opts: TreeBackupOptions = {}, backup: TreeBackup = new Map()): TreeBackup {
  for (const scoped of roots) {
    const parts = scoped.split(/[\\/]/).filter(Boolean);
    let stopped = false;
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestor = join(root, ...parts.slice(0, depth));
      let stat;
      try { stat = lstatSync(ancestor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { stopped = true; break; }
        throw error;
      }
      if (stat.isDirectory()) continue;
      captureTreeBackup(root, ancestor, backup, opts);
      stopped = true;
      break;
    }
    if (!stopped) captureTreeBackup(root, join(root, ...parts), backup, opts);
  }
  return backup;
}

/** The snapshotTree strings for a backup: `file:<sha256>:<mode>`, `dir:<mode>`, `link:<target>`. */
export function backupToSnapshot(backup: TreeBackup): TreeSnapshot {
  const snapshot: TreeSnapshot = new Map();
  for (const [rel, entry] of backup) {
    if (entry.kind === "file") snapshot.set(rel, `file:${createHash("sha256").update(entry.bytes).digest("hex")}:${entry.mode}`);
    else if (entry.kind === "dir") snapshot.set(rel, `dir:${entry.mode}`);
    else snapshot.set(rel, `link:${entry.target}`);
  }
  return snapshot;
}

export function restoreSingleEntry(root: string, rel: string, entry: TreeBackupEntry): void {
  const full = rel === "." ? root : join(root, rel);
  let currentStat;
  try { currentStat = lstatSync(full); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entry.kind === "dir") {
    if (currentStat && (!currentStat.isDirectory() || currentStat.isSymbolicLink())) {
      rmSync(full, { recursive: true, force: true });
      currentStat = undefined;
    }
    if (!currentStat) mkdirSync(full, { recursive: true });
    chmodSync(full, entry.mode);
    return;
  }
  if (rel !== ".") mkdirSync(dirname(full), { recursive: true });
  if (entry.kind === "link") {
    if (currentStat) {
      if (currentStat.isSymbolicLink() && readlinkSync(full) === entry.target) return;
      rmSync(full, { recursive: true, force: true });
    }
    symlinkSync(entry.target, full);
    return;
  }
  if (currentStat?.isFile() && !currentStat.isSymbolicLink()) {
    // Untouched entries (the bulk of a whole-tree backup) are left alone; a
    // read-only file (git pack objects are 0444) is replaced via unlink, which
    // needs write permission on the directory, not the file.
    if ((currentStat.mode & 0o7777) === entry.mode && readFileSync(full).equals(entry.bytes)) return;
    unlinkSync(full);
  } else if (currentStat) {
    rmSync(full, { recursive: true, force: true });
  }
  writeFileSync(full, entry.bytes);
  chmodSync(full, entry.mode);
}

/** Whole-tree restore: today's (pre-PJAN-180) rollback, and the fail-closed fallback. */
export function restoreTreeBackup(root: string, backup: TreeBackup): void {
  const current = captureTreeBackup(root);
  // Removing an entry needs write permission on its parent, so every present
  // directory is owner-writable before anything is unlinked.
  for (const [rel, entry] of current.entries()) {
    if (entry.kind === "dir" && (entry.mode & 0o700) !== 0o700) chmodSync(rel === "." ? root : join(root, rel), entry.mode | 0o700);
  }
  const removed = [...current.keys()]
    .filter((rel) => rel !== "." && !backup.has(rel))
    .sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length || b.localeCompare(a));
  for (const rel of removed) {
    const full = join(root, rel);
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(full, { recursive: true, force: true });
      else unlinkSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const dirs = [...backup.entries()]
    .filter((pair): pair is [string, Extract<TreeBackupEntry, { kind: "dir" }>] => pair[1].kind === "dir")
    .sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b)));
  // Owner-writable while children are restored; exact modes are re-applied last.
  for (const [rel, entry] of dirs) restoreSingleEntry(root, rel, { ...entry, mode: entry.mode | 0o700 });
  for (const [rel, entry] of backup.entries()) {
    if (entry.kind !== "dir") restoreSingleEntry(root, rel, entry);
  }
  for (const [rel, entry] of [...dirs].reverse()) {
    chmodSync(rel === "." ? root : join(root, rel), entry.mode);
  }
}
