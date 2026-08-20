import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { canonicalJson, sessionCaptureLogicalId, sha256Hex } from "./notes";
import { parseRemoteMutationJournal } from "./remote-mutation-schema";
import {
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  UNRESOLVED_RECEIPT_STATES,
  type CaptureAdmissionSummaryV1,
  type CaptureIntegrityEntryV1,
  type CaptureReceiptSummaryV1,
  type CaptureReceiptV1,
  type NotebookLimitsV1,
  type OverviewClaimV1,
  type RetentionRefusalReason,
  type RetentionRefusalSummaryV1,
  type RetentionRefusalV1,
  type RemoteMutationJournalSummaryV1,
  type SessionBaselineV1,
} from "./types";

export const NOTEBOOK_STATE_VERSION = "v1";
const SESSION_KEY_RE = /^[a-f0-9]{64}$/u;
const RECEIPT_ID_RE = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const NOTEBOOK_ERROR_CODES = new Set([
  "INVALID_INPUT", "NOT_CONFIGURED", "AUTHENTICATION_FAILED", "NOT_FOUND", "CONFLICT", "CROSS_PROJECT",
  "DRIFT_DETECTED", "THROTTLED", "TIMEOUT", "SERVICE_UNAVAILABLE", "REMOTE_PROTOCOL_ERROR", "INTERNAL_ERROR",
]);
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

export function notebookStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return resolve(base, "pjangler", "notebook", NOTEBOOK_STATE_VERSION);
}

export function deriveSessionKey(projectSlug: string, client: string, clientSessionId: string): string {
  if (!projectSlug || !client || !clientSessionId) throw new NotebookError("INVALID_INPUT", "project slug, client, and client session id are required");
  return createHash("sha256").update(`pjangler-session-v1\0${projectSlug}\0${client}\0${clientSessionId}`, "utf8").digest("hex");
}

export function deriveReceiptId(sessionKey: string): string {
  assertDigest(sessionKey, "session key");
  return sha256Hex(`pjangler-receipt-v1\0${sessionKey}`);
}

export function repoPathDigest(repoPath: string): string {
  return sha256Hex(`pjangler-repo-path-v1\0${resolve(repoPath)}`);
}

function assertDigest(value: string, label: string): void {
  if (!SESSION_KEY_RE.test(value)) throw new NotebookError("INVALID_INPUT", `Invalid ${label}`);
}

function projectStateDir(root: string, projectSlug: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(projectSlug)) throw new NotebookError("INVALID_INPUT", "Invalid project slug for Notebook state");
  return join(resolve(root), "projects", sha256Hex(`pjangler-project-state-v1\0${projectSlug}`));
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) return;
  throw new NotebookError("INTERNAL_ERROR", "Notebook state path escaped its root");
}

function assertNoSymlinkComponents(path: string, allowMissing: boolean): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  let missing = false;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (missing) continue;
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new NotebookError("INTERNAL_ERROR", "Notebook state path contains a symlink component");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowMissing) throw new NotebookError("INTERNAL_ERROR", "Notebook state path does not exist");
      missing = true;
    }
  }
}

/**
 * Open an absolute directory one component at a time with O_NOFOLLOW.  The
 * returned descriptor pins the directory inode, so leaf operations can use
 * /proc/self/fd rather than resolving an attacker-swappable pathname again.
 * Project Notebook state is Linux/XDG scoped; failing closed when procfs is
 * unavailable is safer than silently weakening the containment contract.
 */
function openPinnedDirectory(path: string, root: string, create: boolean): number {
  const absolute = resolve(path);
  const absoluteRoot = resolve(root);
  assertContained(absoluteRoot, absolute);
  if (!existsSync("/proc/self/fd")) throw new NotebookError("INTERNAL_ERROR", "Descriptor-pinned Notebook state requires procfs");

  const parsed = parse(absolute);
  let fd = openSync(parsed.root, DIRECTORY_OPEN_FLAGS);
  let cursor = parsed.root;
  try {
    for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const child = `/proc/self/fd/${fd}/${part}`;
      cursor = join(cursor, part);
      let childFd: number;
      try {
        childFd = openSync(child, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { mkdirSync(child, { mode: 0o700 }); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        childFd = openSync(child, DIRECTORY_OPEN_FLAGS);
      }
      closeSync(fd);
      fd = childFd;
      const stat = fstatSync(fd);
      if (!stat.isDirectory()) throw new NotebookError("INTERNAL_ERROR", "Notebook state path component is not a directory");
      if (cursor === absoluteRoot || relative(absoluteRoot, cursor).startsWith("..") === false) assertOwned(stat);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new NotebookError("INTERNAL_ERROR", "Notebook state path contains a symlink component");
    }
    throw error;
  }
}

function pinnedLeaf(parentFd: number, path: string): string {
  return `/proc/self/fd/${parentFd}/${basename(path)}`;
}

function assertOwned(stat: Stats): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new NotebookError("INTERNAL_ERROR", "Notebook state path is not owned by the current user");
  }
}

function ensureDirectory(path: string, root: string): void {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  assertContained(absoluteRoot, absolute);
  const fd = openPinnedDirectory(absolute, absoluteRoot, true);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new NotebookError("INTERNAL_ERROR", "Notebook state directory is not a real directory");
    assertOwned(stat);
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export interface NotebookStatePaths {
  root: string;
  project: string;
  baselines: string;
  claims: string;
  receipts: string;
  refusals: string;
  journals: string;
  locks: string;
}

function notebookStatePaths(root: string, projectSlug: string): NotebookStatePaths {
  const absoluteRoot = resolve(root);
  const project = projectStateDir(absoluteRoot, projectSlug);
  return {
    root: absoluteRoot,
    project,
    baselines: join(project, "baselines"),
    claims: join(project, "claims"),
    receipts: join(project, "receipts"),
    refusals: join(project, "refusals"),
    journals: join(project, "journals"),
    locks: join(project, "locks"),
  };
}

export function ensureNotebookState(root: string, projectSlug: string): NotebookStatePaths {
  const paths = notebookStatePaths(root, projectSlug);
  const { root: absoluteRoot, project } = paths;
  for (const path of [absoluteRoot, join(absoluteRoot, "projects"), project, paths.baselines, paths.claims, paths.receipts, paths.refusals, paths.journals, paths.locks]) {
    ensureDirectory(path, absoluteRoot);
  }
  return paths;
}

function jsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openPinnedDirectory(path, path, false);
    fsyncSync(fd);
  } catch { /* best effort on filesystems without directory fsync */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

function readStateDirectory(path: string, root: string): Dirent[] {
  const fd = openPinnedDirectory(path, root, false);
  try { return readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true }); }
  finally { closeSync(fd); }
}

export function readNotebookStateDirectory(path: string, root: string): Dirent[] {
  assertContained(root, path);
  return readStateDirectory(path, root);
}

function unlinkStateFile(path: string, root: string, allowMissing = false): boolean {
  assertContained(root, path);
  const parentFd = openPinnedDirectory(dirname(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  let fileFd: number | undefined;
  try {
    try { fileFd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const stat = fstatSync(fileFd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new NotebookError("CONFLICT", "Refusing to remove a suspect Notebook state entry; run pj notebook audit --json");
    }
    assertOwned(stat);
    unlinkSync(target);
    fsyncSync(parentFd);
    return true;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    closeSync(parentFd);
  }
}

function renameStateFile(source: string, target: string, root: string): void {
  if (dirname(source) !== dirname(target)) throw new NotebookError("INTERNAL_ERROR", "Notebook state rename crossed directories");
  const parentFd = openPinnedDirectory(dirname(source), root, false);
  const sourcePath = pinnedLeaf(parentFd, source);
  const targetPath = pinnedLeaf(parentFd, target);
  let sourceFd: number | undefined;
  try {
    sourceFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(sourceFd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new NotebookError("CONFLICT", "Notebook state rename source has an integrity finding");
    assertOwned(stat);
    try {
      lstatSync(targetPath);
      throw new NotebookError("CONFLICT", "Notebook state rename target already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(sourcePath, targetPath);
    fsyncSync(parentFd);
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
    closeSync(parentFd);
  }
}

export function atomicWriteJson(path: string, value: unknown, root: string, afterParentPinned?: () => void): number {
  assertContained(root, path);
  ensureDirectory(dirname(path), root);
  const text = jsonLine(value);
  const parentFd = openPinnedDirectory(dirname(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  const tempName = `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`;
  const temp = `/proc/self/fd/${parentFd}/${tempName}`;
  let existingIdentity: { dev: number | bigint; ino: number | bigint } | null = null;
  try {
    // Deterministic seam for the ancestor/leaf swap regression. Production
    // callers omit it; the operation itself remains pinned to parentFd.
    afterParentPinned?.();
    try {
      const existingFd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const existing = fstatSync(existingFd);
        if (!existing.isFile()) throw new NotebookError("INTERNAL_ERROR", "Refusing to replace a non-regular Notebook state file");
        assertOwned(existing);
        if ((existing.mode & 0o777) !== 0o600) throw new NotebookError("CONFLICT", "Refusing to replace a Notebook state file with unsafe permissions");
        existingIdentity = { dev: existing.dev, ino: existing.ino };
      } finally { closeSync(existingFd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }

    try {
      const current = lstatSync(target);
      if (!existingIdentity || !current.isFile() || current.isSymbolicLink()
        || current.dev !== existingIdentity.dev || current.ino !== existingIdentity.ino) {
        throw new NotebookError("CONFLICT", "Notebook state target changed during atomic update; preserving both entries for audit");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existingIdentity) throw error;
    }
    renameSync(temp, target);
    fsyncSync(parentFd);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    closeSync(parentFd);
  }
  return Buffer.byteLength(text, "utf8");
}

function exclusiveWrite(path: string, text: string, root: string): boolean {
  assertContained(root, path);
  const parentFd = openPinnedDirectory(dirname(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    closeSync(parentFd);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function safeNonnegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number, allowControls = false): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => typeof entry === "string" && entry.length > 0
    && entry.length <= maxChars && (allowControls || !/[\u0000-\u001f\u007f]/u.test(entry)));
}

function parseBaseline(value: unknown): SessionBaselineV1 | null {
  if (!isObject(value) || !hasExactKeys(value, [
    "schema_version", "session_key", "project_slug", "client", "created_at", "repo_path_digest", "git_head",
    "git_status_digest", "policy_version", "tracked_path_digests", "pre_dirty_paths", "complete", "incomplete_reasons",
  ])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (!boundedString(value.project_slug, 128) || !boundedString(value.client, 64) || !isoTimestamp(value.created_at)) return null;
  if (typeof value.repo_path_digest !== "string" || !RECEIPT_ID_RE.test(value.repo_path_digest)) return null;
  if (value.git_head !== null && (typeof value.git_head !== "string" || !GIT_OBJECT_RE.test(value.git_head))) return null;
  if (value.git_status_digest !== null && (typeof value.git_status_digest !== "string" || !RECEIPT_ID_RE.test(value.git_status_digest))) return null;
  if (!boundedString(value.policy_version, 128) || typeof value.complete !== "boolean") return null;
  if (!isObject(value.tracked_path_digests) || Object.keys(value.tracked_path_digests).length > 1_000
    || !Object.entries(value.tracked_path_digests).every(([path, digest]) => path.length > 0 && path.length <= 4_096 && !path.includes("\0") && typeof digest === "string" && RECEIPT_ID_RE.test(digest))) return null;
  if (!boundedStringArray(value.pre_dirty_paths, 2_000, 4_096, true) || (value.pre_dirty_paths as string[]).some((path) => path.includes("\0"))) return null;
  if (!Array.isArray(value.incomplete_reasons) || value.incomplete_reasons.length > 20
    || !value.incomplete_reasons.every((reason) => boundedString(reason, 128))) return null;
  return value as unknown as SessionBaselineV1;
}

function parseClaim(value: unknown): OverviewClaimV1 | null {
  if (!isObject(value) || !hasExactKeys(value, ["schema_version", "session_key", "project_slug", "created_at", "overview_note_id", "content_sha256"])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (!boundedString(value.project_slug, 128) || !isoTimestamp(value.created_at) || !boundedString(value.overview_note_id, 512)) return null;
  if (typeof value.content_sha256 !== "string" || !RECEIPT_ID_RE.test(value.content_sha256)) return null;
  return value as unknown as OverviewClaimV1;
}

function parseReceipt(value: unknown): CaptureReceiptV1 | null {
  const required = [
    "schema_version", "receipt_id", "logical_id", "session_key", "project_slug", "repo_path_digest", "baseline_ref",
    "end_revision", "end_status_digest", "state", "automatic_attempts_used", "automatic_attempt_limit", "manual_retry_count",
    "attempt_origin", "lease_owner", "lease_deadline", "created_at", "updated_at", "exclusion_counts", "summary_mode",
    "note_logical_ids", "remote_note_ids", "error_category", "retryable", "diagnostic", "serialized_bytes",
  ];
  if (!isObject(value) || !hasExactKeys(value, required, ["manual_baseline_ref"])) return null;
  if (value.schema_version !== 1 || typeof value.receipt_id !== "string" || !RECEIPT_ID_RE.test(value.receipt_id)
    || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (value.logical_id !== sessionCaptureLogicalId(value.session_key) || !boundedString(value.project_slug, 128)
    || typeof value.repo_path_digest !== "string" || !RECEIPT_ID_RE.test(value.repo_path_digest)) return null;
  for (const ref of [value.baseline_ref, value.end_revision]) if (ref !== null && !boundedString(ref, 512)) return null;
  if (value.end_status_digest !== null && (typeof value.end_status_digest !== "string" || !RECEIPT_ID_RE.test(value.end_status_digest))) return null;
  if (value.manual_baseline_ref !== undefined && (!boundedString(value.manual_baseline_ref, 512) || value.baseline_ref !== value.manual_baseline_ref)) return null;
  const states = ["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"];
  if (typeof value.state !== "string" || !states.includes(value.state)) return null;
  if (!safeNonnegativeInteger(value.automatic_attempts_used, 1_000_000) || !safeNonnegativeInteger(value.automatic_attempt_limit, 1_000_000)
    || value.automatic_attempt_limit < 1 || value.automatic_attempts_used > value.automatic_attempt_limit
    || !safeNonnegativeInteger(value.manual_retry_count, 1_000_000)) return null;
  if (value.attempt_origin !== "automatic" && value.attempt_origin !== "operator") return null;
  const processing = value.state === "processing";
  if (processing ? (!boundedString(value.lease_owner, 128) || !isoTimestamp(value.lease_deadline)) : (value.lease_owner !== null || value.lease_deadline !== null)) return null;
  if (!isoTimestamp(value.created_at) || !isoTimestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) return null;
  if (!isObject(value.exclusion_counts) || Object.keys(value.exclusion_counts).length > 100
    || !Object.entries(value.exclusion_counts).every(([key, count]) => boundedString(key, 128) && safeNonnegativeInteger(count, 1_000_000))) return null;
  if (value.summary_mode !== null && value.summary_mode !== "configured" && value.summary_mode !== "deterministic-fallback") return null;
  if (!boundedStringArray(value.note_logical_ids, 2_000, 512) || !boundedStringArray(value.remote_note_ids, 2_000, 512)) return null;
  if (value.error_category !== null && (typeof value.error_category !== "string" || !NOTEBOOK_ERROR_CODES.has(value.error_category))) return null;
  if (typeof value.retryable !== "boolean" || (value.diagnostic !== null && !boundedString(value.diagnostic, 4_096))) return null;
  if (!safeNonnegativeInteger(value.serialized_bytes) || value.serialized_bytes < 1) return null;
  if (value.state === "succeeded" && (value.summary_mode === null || value.error_category !== null || value.retryable || value.diagnostic !== null)) return null;
  if (value.state === "failed" && (value.error_category === null || value.diagnostic === null)) return null;
  if (value.state === "blocked-missing-baseline" && (value.error_category !== "CONFLICT" || value.retryable || value.diagnostic === null)) return null;
  return value as unknown as CaptureReceiptV1;
}

function parseRefusal(value: unknown): RetentionRefusalV1 | null {
  if (!isObject(value) || !hasExactKeys(value, [
    "schema_version", "session_key", "baseline_created_at", "refused_at", "reason", "current_count", "current_bytes",
    "candidate_bytes", "max_count", "max_bytes", "next_actions",
  ])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)
    || !isoTimestamp(value.baseline_created_at) || !isoTimestamp(value.refused_at)
    || Date.parse(value.refused_at) < Date.parse(value.baseline_created_at)) return null;
  if (!(value.reason === "count-cap" || value.reason === "byte-cap" || value.reason === "both")) return null;
  if (![value.current_count, value.current_bytes, value.candidate_bytes, value.max_count, value.max_bytes]
    .every((entry) => safeNonnegativeInteger(entry)) || value.candidate_bytes === 0 || value.max_count === 0 || value.max_bytes === 0) return null;
  const countBlocked = (value.current_count as number) + 1 > (value.max_count as number);
  const byteBlocked = (value.current_bytes as number) + (value.candidate_bytes as number) > (value.max_bytes as number);
  if (!countBlocked && !byteBlocked) return null;
  if (value.reason !== capReason(countBlocked, byteBlocked)) return null;
  if (!boundedStringArray(value.next_actions, 2, 2_048) || value.next_actions.length !== 2
    || !value.next_actions[0]!.startsWith("pj notebook capture list ") || !value.next_actions[1]!.startsWith("pj notebook capture retry ")) return null;
  return value as unknown as RetentionRefusalV1;
}

function safeReadJson(path: string, maxBytes: number): { value?: unknown; reason?: CaptureIntegrityEntryV1["reason"]; bytes: number } {
  let parentFd: number;
  try { parentFd = openPinnedDirectory(dirname(path), dirname(path), false); }
  catch { return { reason: "non-regular", bytes: 0 }; }
  let fd: number;
  try { fd = openSync(pinnedLeaf(parentFd, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    closeSync(parentFd);
    return { reason: (error as NodeJS.ErrnoException).code === "ELOOP" ? "non-regular" : "unreadable", bytes: 0 };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { reason: "non-regular", bytes: 0 };
    if ((stat.mode & 0o777) !== 0o600) return { reason: "unsafe-permissions", bytes: stat.size };
    try { assertOwned(stat); } catch { return { reason: "unsafe-permissions", bytes: stat.size }; }
    if ((stat.mode & 0o444) === 0) return { reason: "unreadable", bytes: 0 };
    if (stat.size > maxBytes) return { reason: "oversize", bytes: stat.size };
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8_192, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) return { reason: "oversize", bytes: total };
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || total !== stat.size) return { reason: "unreadable", bytes: total };
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown, bytes: total };
  } catch (error) {
    return { reason: error instanceof SyntaxError || error instanceof TypeError ? "invalid-json" : "unreadable", bytes: 0 };
  } finally { closeSync(fd); closeSync(parentFd); }
}

function safeEntryId(kind: string, name: string): string {
  return `${kind}/${/^[a-zA-Z0-9._-]{1,160}$/u.test(name) ? name : sha256Hex(name).slice(0, 24)}`;
}

function readBaseline(path: string, maxBytes: number): SessionBaselineV1 | null {
  if (!existsSync(path)) return null;
  const read = safeReadJson(path, maxBytes);
  return read.value === undefined ? null : parseBaseline(read.value);
}

function baselineReceiptByteCeiling(limits: NotebookLimitsV1): number {
  return limits.receipt_max_bytes;
}

export interface BaselineCreateInput {
  limits: NotebookLimitsV1;
  session_key: string;
  project_slug: string;
  client: string;
  created_at: string;
  repo_path: string;
  git_head: string | null;
  git_status_digest: string | null;
  policy_version: string;
  tracked_path_digests: Record<string, string>;
  pre_dirty_paths: string[];
  complete: boolean;
  incomplete_reasons: string[];
}

export function createSessionBaseline(root: string, input: BaselineCreateInput): { baseline: SessionBaselineV1; created: boolean } {
  assertDigest(input.session_key, "session key");
  const paths = ensureNotebookState(root, input.project_slug);
  const path = join(paths.baselines, `${input.session_key}.json`);
  const maxBytes = baselineReceiptByteCeiling(input.limits);
  const existing = readBaseline(path, maxBytes);
  if (existing) return { baseline: existing, created: false };
  const baseline: SessionBaselineV1 = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    session_key: input.session_key,
    project_slug: input.project_slug,
    client: input.client.slice(0, 64),
    created_at: input.created_at,
    repo_path_digest: repoPathDigest(input.repo_path),
    git_head: input.git_head,
    git_status_digest: input.git_status_digest,
    policy_version: input.policy_version,
    tracked_path_digests: Object.fromEntries(Object.entries(input.tracked_path_digests).sort(([a], [b]) => a.localeCompare(b, "en")).slice(0, 1_000)),
    pre_dirty_paths: [...new Set(input.pre_dirty_paths)].sort().slice(0, 2_000),
    complete: input.complete,
    incomplete_reasons: input.incomplete_reasons.slice(0, 20).map((item) => item.slice(0, 128)),
  };
  let text = jsonLine(baseline);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    baseline.complete = false;
    baseline.tracked_path_digests = {};
    baseline.pre_dirty_paths = [];
    baseline.incomplete_reasons = [...new Set(["baseline-byte-ceiling", ...baseline.incomplete_reasons])].slice(0, 20);
    text = jsonLine(baseline);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook receipt_max_bytes is too small for a minimal SessionStart baseline");
  }
  if (!parseBaseline(baseline)) throw new NotebookError("INTERNAL_ERROR", "SessionStart baseline failed its own v1 schema validation");
  if (!exclusiveWrite(path, text, paths.root)) {
    const won = readBaseline(path, maxBytes);
    if (!won) throw new NotebookError("INTERNAL_ERROR", "Concurrent baseline creation produced unreadable state");
    return { baseline: won, created: false };
  }
  return { baseline, created: true };
}

export function createOverviewClaim(root: string, input: Omit<OverviewClaimV1, "schema_version">): { claim: OverviewClaimV1; created: boolean } {
  assertDigest(input.session_key, "session key");
  const paths = ensureNotebookState(root, input.project_slug);
  const path = join(paths.claims, `${input.session_key}.overview`);
  if (existsSync(path)) {
    const read = safeReadJson(path, 65_536);
    const existing = read.value === undefined ? null : parseClaim(read.value);
    if (!existing) throw new NotebookError("CONFLICT", "Overview claim has an integrity finding");
    return { claim: existing, created: false };
  }
  const claim: OverviewClaimV1 = { schema_version: NOTEBOOK_SCHEMA_VERSION, ...input };
  if (!exclusiveWrite(path, jsonLine(claim), paths.root)) {
    const read = safeReadJson(path, 65_536);
    const existing = read.value === undefined ? null : parseClaim(read.value);
    if (!existing) throw new NotebookError("CONFLICT", "Concurrent Overview claim creation produced invalid state");
    return { claim: existing, created: false };
  }
  return { claim, created: true };
}

export function readOverviewClaim(root: string, projectSlug: string, sessionKey: string): OverviewClaimV1 | null {
  assertDigest(sessionKey, "session key");
  const paths = notebookStatePaths(root, projectSlug);
  const path = join(paths.claims, `${sessionKey}.overview`);
  if (!existsSync(path)) return null;
  const read = safeReadJson(path, 65_536);
  return read.value === undefined ? null : parseClaim(read.value);
}

export function readSessionBaseline(root: string, projectSlug: string, sessionKey: string, limits: NotebookLimitsV1): SessionBaselineV1 | null {
  assertDigest(sessionKey, "session key");
  const paths = ensureNotebookState(root, projectSlug);
  return readBaseline(join(paths.baselines, `${sessionKey}.json`), baselineReceiptByteCeiling(limits));
}

function acquireLock(paths: NotebookStatePaths, maxWaitMs: number): () => void {
  const lock = join(paths.locks, "admission.lock");
  const deadline = Date.now() + Math.max(1, maxWaitMs);
  const token = randomUUID();
  const record = () => ({
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + Math.max(5_000, maxWaitMs * 20)).toISOString(),
  });
  while (true) {
    if (exclusiveWrite(lock, jsonLine(record()), paths.root)) {
      return () => {
        const current = safeReadJson(lock, 8_192);
        if (current.value && typeof current.value === "object" && !Array.isArray(current.value)
          && (current.value as Record<string, unknown>).token === token) {
          try { unlinkStateFile(lock, paths.root); } catch { /* a recovered lease is no longer ours */ }
        }
      };
    }

    const read = safeReadJson(lock, 8_192);
    const held = read.value && typeof read.value === "object" && !Array.isArray(read.value)
      ? read.value as Record<string, unknown>
      : null;
    const heldToken = typeof held?.token === "string" && /^[a-f0-9-]{16,64}$/iu.test(held.token) ? held.token : null;
    const expiresAt = typeof held?.expires_at === "string" ? Date.parse(held.expires_at) : Number.NaN;
    if (read.reason || !heldToken || !Number.isFinite(expiresAt)) {
      throw new NotebookError("CONFLICT", "Notebook state lock has an integrity finding; preserve it and run pj notebook audit --json");
    }
    if (Date.now() >= expiresAt) {
      // Recovery is serialized by a token-specific claim. A crashed owner can
      // no longer leave admission permanently blocked, and contenders never
      // remove a lock whose token differs from the one they proved stale.
      const recovery = join(paths.locks, `recovery-${heldToken}.lock`);
      const recoveryRecord = jsonLine({ schema_version: NOTEBOOK_SCHEMA_VERSION, stale_token: heldToken, recovery_token: token, expires_at: new Date(Date.now() + 5_000).toISOString() });
      if (exclusiveWrite(recovery, recoveryRecord, paths.root)) {
        try {
          const verify = safeReadJson(lock, 8_192);
          const currentToken = verify.value && typeof verify.value === "object" && !Array.isArray(verify.value)
            ? (verify.value as Record<string, unknown>).token
            : null;
          const currentExpiry = verify.value && typeof verify.value === "object" && !Array.isArray(verify.value)
            ? Date.parse(String((verify.value as Record<string, unknown>).expires_at ?? ""))
            : Number.NaN;
          if (currentToken === heldToken && Number.isFinite(currentExpiry) && Date.now() >= currentExpiry) {
            const recovered = join(paths.locks, `.recovered-${heldToken}-${randomUUID()}.json`);
            renameStateFile(lock, recovered, paths.root);
            unlinkStateFile(recovered, paths.root);
          }
        } finally {
          try { unlinkStateFile(recovery, paths.root); } catch { /* next audit reports a stranded recovery claim */ }
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new NotebookError("TIMEOUT", "Notebook capture admission lock is busy", true);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

export function withNotebookStateLock<T>(root: string, projectSlug: string, maxWaitMs: number, operation: (paths: NotebookStatePaths) => T): T {
  const paths = ensureNotebookState(root, projectSlug);
  const release = acquireLock(paths, maxWaitMs);
  try { return operation(paths); }
  finally { release(); }
}

export function readNotebookStateJson(path: string, root: string, maxBytes: number): { value?: unknown; reason?: CaptureIntegrityEntryV1["reason"]; bytes: number } {
  assertContained(root, path);
  return safeReadJson(path, maxBytes);
}

export function createNotebookStateJsonExclusive(path: string, value: unknown, root: string): boolean {
  return exclusiveWrite(path, jsonLine(value), root);
}

interface ReceiptScan {
  receipts: CaptureReceiptV1[];
  unresolvedCount: number;
  unresolvedBytes: number;
  integrity: CaptureIntegrityEntryV1[];
  integrityCount: number;
  referencedSessions: Set<string>;
}

interface AuxiliaryScan {
  integrity: CaptureIntegrityEntryV1[];
  integrityCount: number;
  knownBytes: number;
  referencedSessions: Set<string>;
  unresolvedJournals: RemoteMutationJournalSummaryV1[];
}

export interface CaptureAdmissionInspectionV1 extends CaptureAdmissionSummaryV1 {
  unresolvedJournals: RemoteMutationJournalSummaryV1[];
}

function addBoundedIntegrity(target: AuxiliaryScan, limits: NotebookLimitsV1, entry: CaptureIntegrityEntryV1, knownBytes = 0): void {
  target.integrityCount += 1;
  target.knownBytes += Math.max(0, knownBytes);
  if (target.integrity.length < limits.integrity_max_entries) target.integrity.push(entry);
}

function journalReference(value: unknown): { sessionKey?: string; unresolved: boolean; summary?: RemoteMutationJournalSummaryV1 } | null {
  const item = parseRemoteMutationJournal(value);
  if (!item) return null;
  const unresolved = item.state !== "committed";
  return {
    ...(item.session_key ? { sessionKey: item.session_key } : {}),
    unresolved,
    ...(unresolved ? { summary: {
      operation_id: item.operation_id,
      kind: item.kind,
      logical_marker: item.logical_marker,
      session_key: item.session_key ?? null,
      state: item.state as "prepared" | "possibly-dispatched" | "reconciled",
      binding_id: item.binding_id ?? null,
      candidate_ids: [...item.candidate_ids],
      result_category: item.result_category,
      next_action: item.next_action,
    } } : {}),
  };
}

function scanAuxiliaryState(paths: NotebookStatePaths, limits: NotebookLimitsV1): AuxiliaryScan {
  const scan: AuxiliaryScan = { integrity: [], integrityCount: 0, knownBytes: 0, referencedSessions: new Set(), unresolvedJournals: [] };
  const specifications = [
    { kind: "baselines", dir: paths.baselines, suffix: ".json", maxBytes: baselineReceiptByteCeiling(limits), parse: parseBaseline, key: (value: SessionBaselineV1) => value.session_key },
    { kind: "claims", dir: paths.claims, suffix: ".overview", maxBytes: limits.receipt_max_bytes, parse: parseClaim, key: (value: OverviewClaimV1) => value.session_key },
    { kind: "refusals", dir: paths.refusals, suffix: ".json", maxBytes: limits.receipt_max_bytes, parse: parseRefusal, key: (value: RetentionRefusalV1) => value.session_key },
  ] as const;
  for (const specification of specifications) {
    if (!existsSync(specification.dir)) continue;
    let entries: Dirent[];
    try { entries = readStateDirectory(specification.dir, paths.root); }
    catch { addBoundedIntegrity(scan, limits, { entry_id: specification.kind, reason: "unreadable" }); continue; }
    for (const entry of entries) {
      const entryId = safeEntryId(specification.kind, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(specification.suffix)) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join(specification.dir, entry.name), specification.maxBytes);
      if (read.reason || read.value === undefined) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const parsed = specification.parse(read.value as never) as SessionBaselineV1 | OverviewClaimV1 | RetentionRefusalV1 | null;
      const expectedKey = parsed ? specification.key(parsed as never) : null;
      const expectedName = expectedKey ? `${expectedKey}${specification.suffix}` : null;
      if (!parsed || expectedName !== entry.name) addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
    }
  }

  if (existsSync(paths.journals)) {
    let entries: Dirent[];
    try { entries = readStateDirectory(paths.journals, paths.root); }
    catch { addBoundedIntegrity(scan, limits, { entry_id: "journals", reason: "unreadable" }); entries = []; }
    for (const entry of entries) {
      const entryId = safeEntryId("journals", entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join(paths.journals, entry.name), limits.receipt_max_bytes);
      if (read.reason || read.value === undefined) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const reference = journalReference(read.value);
      const operationId = reference && typeof (read.value as Record<string, unknown>).operation_id === "string"
        ? (read.value as Record<string, unknown>).operation_id as string
        : null;
      if (!reference || `${operationId}.json` !== entry.name) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
        continue;
      }
      if (reference.unresolved && reference.sessionKey) scan.referencedSessions.add(reference.sessionKey);
      if (reference.summary) scan.unresolvedJournals.push(reference.summary);
    }
  }
  if (existsSync(paths.locks)) {
    let entries: Dirent[];
    try { entries = readStateDirectory(paths.locks, paths.root); }
    catch { addBoundedIntegrity(scan, limits, { entry_id: "locks", reason: "unreadable" }); entries = []; }
    for (const entry of entries) {
      const entryId = safeEntryId("locks", entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join(paths.locks, entry.name), 8_192);
      if (read.reason || read.value === undefined) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const item = read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value as Record<string, unknown> : null;
      const token = entry.name === "admission.lock" ? item?.token : item?.recovery_token;
      const expiry = Date.parse(String(item?.expires_at ?? ""));
      const expectedRecovery = entry.name.startsWith("recovery-") && entry.name.endsWith(".lock") && item?.stale_token === entry.name.slice(9, -5);
      if (!item || item.schema_version !== 1 || typeof token !== "string" || !Number.isFinite(expiry)
        || (entry.name !== "admission.lock" && !expectedRecovery) || Date.now() >= expiry) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
      }
    }
  }
  return scan;
}

function scanReceipts(paths: NotebookStatePaths, limits: NotebookLimitsV1): ReceiptScan {
  const receipts: CaptureReceiptV1[] = [];
  const integrity: CaptureIntegrityEntryV1[] = [];
  const referencedSessions = new Set<string>();
  let unresolvedCount = 0;
  let unresolvedBytes = 0;
  let integrityCount = 0;
  const addIntegrity = (entry: CaptureIntegrityEntryV1, knownBytes = 0) => {
    integrityCount += 1;
    unresolvedCount += 1;
    unresolvedBytes += Math.max(0, knownBytes);
    if (integrity.length < limits.integrity_max_entries) integrity.push(entry);
  };
  if (!existsSync(paths.receipts)) return { receipts, unresolvedCount, unresolvedBytes, referencedSessions, integrity, integrityCount };
  let entries;
  try { entries = readStateDirectory(paths.receipts, paths.root); } catch {
    addIntegrity({ entry_id: "receipts", reason: "unreadable" });
    return { receipts, unresolvedCount, unresolvedBytes, referencedSessions, integrity, integrityCount };
  }
  for (const entry of entries) {
    const entryId = safeEntryId("receipts", entry.name);
    const path = join(paths.receipts, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      addIntegrity({ entry_id: entryId, reason: "non-regular" });
      continue;
    }
    const read = safeReadJson(path, limits.receipt_max_bytes);
    if (read.reason || read.value === undefined) {
      addIntegrity({ entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
      continue;
    }
    const receipt = parseReceipt(read.value);
    if (!receipt || `${receipt.receipt_id}.json` !== entry.name || receipt.serialized_bytes !== read.bytes) {
      addIntegrity({ entry_id: entryId, reason: "invalid-schema" }, read.bytes);
      continue;
    }
    receipts.push(receipt);
    referencedSessions.add(receipt.session_key);
    if (UNRESOLVED_RECEIPT_STATES.has(receipt.state)) {
      unresolvedCount += 1;
      unresolvedBytes += read.bytes;
    }
  }
  return { receipts, unresolvedCount, unresolvedBytes, integrity, integrityCount, referencedSessions };
}

function scanBaselines(paths: NotebookStatePaths, nowMs: number, limits: NotebookLimitsV1, referenced: Set<string>): { current: number; stale: number } {
  let current = 0;
  let stale = 0;
  if (!existsSync(paths.baselines)) return { current, stale };
  for (const entry of readStateDirectory(paths.baselines, paths.root)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const baseline = readBaseline(join(paths.baselines, entry.name), baselineReceiptByteCeiling(limits));
    if (!baseline || referenced.has(baseline.session_key)) continue;
    const expires = Date.parse(baseline.created_at) + limits.receiptless_session_retention_seconds * 1_000;
    if (nowMs >= expires) stale += 1;
    else current += 1;
  }
  return { current, stale };
}

function scanRefusals(paths: NotebookStatePaths, nowMs: number, limits: NotebookLimitsV1, scan: ReceiptScan): RetentionRefusalSummaryV1[] {
  const result: RetentionRefusalSummaryV1[] = [];
  if (!existsSync(paths.refusals)) return result;
  const entries = readStateDirectory(paths.refusals, paths.root)
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .slice(0, limits.refusal_max_entries);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const read = safeReadJson(join(paths.refusals, entry.name), limits.receipt_max_bytes);
    const marker = read.value === undefined ? null : parseRefusal(read.value);
    if (!marker || `${marker.session_key}.json` !== entry.name) continue;
    if (nowMs >= Date.parse(marker.baseline_created_at) + limits.receiptless_session_retention_seconds * 1_000) continue;
    result.push({
      outcome: "capture-refused-history",
      session_key: marker.session_key,
      refused_at: marker.refused_at,
      reason: marker.reason,
      current_count: scan.unresolvedCount,
      current_bytes: scan.unresolvedBytes,
      candidate_bytes: marker.candidate_bytes,
      max_count: limits.unresolved_receipt_max_count,
      max_bytes: limits.unresolved_receipt_max_bytes,
      next_actions: [...marker.next_actions],
    });
  }
  return result.sort((a, b) => a.refused_at.localeCompare(b.refused_at) || a.session_key.localeCompare(b.session_key));
}

export function captureAdmissionSummary(root: string, projectSlug: string, limits: NotebookLimitsV1, now = new Date()): CaptureAdmissionInspectionV1 {
  const paths = notebookStatePaths(root, projectSlug);
  const scan = scanReceipts(paths, limits);
  const auxiliary = scanAuxiliaryState(paths, limits);
  const referenced = new Set([...scan.referencedSessions, ...auxiliary.referencedSessions]);
  const baselines = scanBaselines(paths, now.getTime(), limits, referenced);
  const exact = scan.integrityCount === 0 && auxiliary.integrityCount === 0;
  const integrity = [...scan.integrity, ...auxiliary.integrity].slice(0, limits.integrity_max_entries);
  const integrityCount = scan.integrityCount + auxiliary.integrityCount;
  return {
    unresolved_count: exact ? scan.unresolvedCount : null,
    unresolved_count_lower_bound: scan.unresolvedCount,
    unresolved_bytes: exact ? scan.unresolvedBytes : null,
    unresolved_bytes_lower_bound: scan.unresolvedBytes + auxiliary.knownBytes,
    unmeasurable_entry_count: integrityCount,
    integrity_entries: integrity,
    receipt_caps: { max_count: limits.unresolved_receipt_max_count, max_bytes: limits.unresolved_receipt_max_bytes },
    receiptless_session_count: baselines.current,
    stale_receiptless_session_count: baselines.stale,
    active_refusals: scanRefusals(paths, now.getTime(), limits, scan),
    unresolvedJournals: auxiliary.unresolvedJournals.sort((a, b) => a.operation_id.localeCompare(b.operation_id, "en")).slice(0, limits.integrity_max_entries),
  };
}

export function publicCaptureAdmissionSummary(summary: CaptureAdmissionInspectionV1): CaptureAdmissionSummaryV1 {
  const { unresolvedJournals: _internalJournals, ...publicSummary } = summary;
  return publicSummary;
}

function createCandidate(input: {
  sessionKey: string;
  projectSlug: string;
  repoPath: string;
  baseline: SessionBaselineV1 | null;
  endRevision: string | null;
  endStatusDigest: string | null;
  now: Date;
  limits: NotebookLimitsV1;
}): { receipt: CaptureReceiptV1; text: string; bytes: number } {
  const receiptId = deriveReceiptId(input.sessionKey);
  const timestamp = input.now.toISOString();
  const receipt: CaptureReceiptV1 = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    receipt_id: receiptId,
    logical_id: sessionCaptureLogicalId(input.sessionKey),
    session_key: input.sessionKey,
    project_slug: input.projectSlug,
    repo_path_digest: repoPathDigest(input.repoPath),
    baseline_ref: input.baseline?.git_head ?? null,
    end_revision: input.endRevision,
    end_status_digest: input.endStatusDigest,
    state: "queued",
    automatic_attempts_used: 0,
    automatic_attempt_limit: input.limits.automatic_attempt_limit,
    manual_retry_count: 0,
    attempt_origin: "automatic",
    lease_owner: null,
    lease_deadline: null,
    created_at: timestamp,
    updated_at: timestamp,
    exclusion_counts: {},
    summary_mode: null,
    note_logical_ids: [],
    remote_note_ids: [],
    error_category: null,
    retryable: false,
    diagnostic: null,
    serialized_bytes: 1,
  };
  let text = jsonLine(receipt);
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (receipt.serialized_bytes === bytes) return { receipt, text, bytes };
    receipt.serialized_bytes = bytes;
    text = jsonLine(receipt);
  }
  throw new NotebookError("INTERNAL_ERROR", "Capture receipt serialized size did not converge");
}

function capReason(countBlocked: boolean, byteBlocked: boolean): RetentionRefusalReason {
  return countBlocked && byteBlocked ? "both" : countBlocked ? "count-cap" : "byte-cap";
}

function recoveryActions(receiptId: string, repoPath: string): string[] {
  return [
    `pj notebook capture list ${repoPath}`,
    `pj notebook capture retry ${receiptId} ${repoPath} (add --baseline GIT_REF for blocked-missing-baseline)`,
  ];
}

function removeValidRefusal(paths: NotebookStatePaths, sessionKey: string, limits: NotebookLimitsV1): void {
  const path = join(paths.refusals, `${sessionKey}.json`);
  if (!existsSync(path)) return;
  const read = safeReadJson(path, limits.receipt_max_bytes);
  const marker = read.value === undefined ? null : parseRefusal(read.value);
  if (!marker || marker.session_key !== sessionKey) return;
  unlinkStateFile(path, paths.root);
}

export type CaptureAdmissionResult =
  | { outcome: "deduplicated"; receipt: CaptureReceiptV1 }
  | { outcome: "admitted"; receipt: CaptureReceiptV1; candidate_bytes: number }
  | { outcome: "retention-pressure"; marker: RetentionRefusalV1; diagnostic: string }
  | { outcome: "state-integrity"; summary: CaptureAdmissionSummaryV1; diagnostic: string };

export function admitCaptureReceipt(input: {
  root: string;
  projectSlug: string;
  repoPath: string;
  sessionKey: string;
  endRevision: string | null;
  endStatusDigest: string | null;
  limits: NotebookLimitsV1;
  now?: Date;
}): CaptureAdmissionResult {
  assertDigest(input.sessionKey, "session key");
  const now = input.now ?? new Date();
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, Math.min(100, input.limits.hook_session_end_timeout_ms));
  try {
    const receiptId = deriveReceiptId(input.sessionKey);
    const receiptPath = join(paths.receipts, `${receiptId}.json`);
    if (existsSync(receiptPath)) {
      const read = safeReadJson(receiptPath, input.limits.receipt_max_bytes);
      const receipt = read.value === undefined ? null : parseReceipt(read.value);
      if (receipt && receipt.receipt_id === receiptId && receipt.session_key === input.sessionKey && receipt.serialized_bytes === read.bytes) {
        removeValidRefusal(paths, input.sessionKey, input.limits);
        return { outcome: "deduplicated", receipt };
      }
    }

    const scanBefore = scanReceipts(paths, input.limits);
    const auxiliaryBefore = scanAuxiliaryState(paths, input.limits);
    const referencedBefore = new Set([...scanBefore.referencedSessions, ...auxiliaryBefore.referencedSessions]);
    const baselinePath = join(paths.baselines, `${input.sessionKey}.json`);
    let baseline = readBaseline(baselinePath, baselineReceiptByteCeiling(input.limits));
    if (baseline) {
      const expired = now.getTime() >= Date.parse(baseline.created_at) + input.limits.receiptless_session_retention_seconds * 1_000;
      if (expired && !referencedBefore.has(input.sessionKey) && scanBefore.integrityCount === 0 && auxiliaryBefore.integrityCount === 0) {
        unlinkStateFile(baselinePath, paths.root);
        const claimPath = join(paths.claims, `${input.sessionKey}.overview`);
        unlinkStateFile(claimPath, paths.root, true);
        const refusalPath = join(paths.refusals, `${input.sessionKey}.json`);
        unlinkStateFile(refusalPath, paths.root, true);
        baseline = null;
      }
    }

    const candidate = createCandidate({
      sessionKey: input.sessionKey,
      projectSlug: input.projectSlug,
      repoPath: input.repoPath,
      baseline,
      endRevision: input.endRevision,
      endStatusDigest: input.endStatusDigest,
      now,
      limits: input.limits,
    });
    if (candidate.bytes > input.limits.receipt_max_bytes) throw new NotebookError("INTERNAL_ERROR", "Capture receipt candidate exceeds its per-receipt ceiling");

    const summary = captureAdmissionSummary(input.root, input.projectSlug, input.limits, now);
    if (summary.unmeasurable_entry_count > 0 || summary.unresolved_count === null || summary.unresolved_bytes === null) {
      const ids = summary.integrity_entries.map((entry) => entry.entry_id).join(",");
      return {
        outcome: "state-integrity",
        summary,
        diagnostic: `state-integrity: this session was not captured; unresolved bytes>=${summary.unresolved_bytes_lower_bound} exact=unknown unmeasurable=${summary.unmeasurable_entry_count} entries=${ids}; run pj notebook audit ${input.repoPath} --local-only --json, repair the reported entry in place without deleting it, then rerun pj notebook audit ${input.repoPath} --local-only --json`,
      };
    }

    const countBlocked = summary.unresolved_count + 1 > input.limits.unresolved_receipt_max_count;
    const byteBlocked = summary.unresolved_bytes + candidate.bytes > input.limits.unresolved_receipt_max_bytes;
    if (countBlocked || byteBlocked) {
      const actions = recoveryActions(receiptId, input.repoPath);
      const refusalPath = join(paths.refusals, `${input.sessionKey}.json`);
      const oldRead = existsSync(refusalPath) ? safeReadJson(refusalPath, input.limits.receipt_max_bytes) : undefined;
      const old = oldRead?.value === undefined ? null : parseRefusal(oldRead.value);
      const marker: RetentionRefusalV1 = {
        schema_version: NOTEBOOK_SCHEMA_VERSION,
        session_key: input.sessionKey,
        baseline_created_at: old?.baseline_created_at ?? baseline?.created_at ?? now.toISOString(),
        refused_at: now.toISOString(),
        reason: capReason(countBlocked, byteBlocked),
        current_count: summary.unresolved_count,
        current_bytes: summary.unresolved_bytes,
        candidate_bytes: candidate.bytes,
        max_count: input.limits.unresolved_receipt_max_count,
        max_bytes: input.limits.unresolved_receipt_max_bytes,
        next_actions: actions,
      };
      atomicWriteJson(refusalPath, marker, paths.root);
      return {
        outcome: "retention-pressure",
        marker,
        diagnostic: `retention-pressure: this session was not captured; unresolved count=${marker.current_count}/${marker.max_count} bytes=${marker.current_bytes}/${marker.max_bytes} candidate_bytes=${marker.candidate_bytes} reason=${marker.reason}; run ${actions[0]}, then ${actions[1]}`,
      };
    }

    if (!exclusiveWrite(receiptPath, candidate.text, paths.root)) {
      const read = safeReadJson(receiptPath, input.limits.receipt_max_bytes);
      const receipt = read.value === undefined ? null : parseReceipt(read.value);
      if (!receipt) throw new NotebookError("INTERNAL_ERROR", "Concurrent receipt creation produced invalid state");
      return { outcome: "deduplicated", receipt };
    }
    removeValidRefusal(paths, input.sessionKey, input.limits);
    return { outcome: "admitted", receipt: candidate.receipt, candidate_bytes: candidate.bytes };
  } finally {
    release();
  }
}

export function receiptSummary(receipt: CaptureReceiptV1): CaptureReceiptSummaryV1 {
  return {
    receipt_id: receipt.receipt_id,
    logical_id: receipt.logical_id,
    session_key: receipt.session_key,
    state: receipt.state,
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
    automatic_attempts_used: receipt.automatic_attempts_used,
    automatic_attempt_limit: receipt.automatic_attempt_limit,
    manual_retry_count: receipt.manual_retry_count,
    attempt_origin: receipt.attempt_origin,
    error_category: receipt.error_category,
    retryable: receipt.retryable,
    diagnostic: receipt.diagnostic,
    summary_mode: receipt.summary_mode,
    exclusion_counts: { ...receipt.exclusion_counts },
    note_logical_ids: [...receipt.note_logical_ids],
    remote_note_ids: [...receipt.remote_note_ids],
    serialized_bytes: receipt.serialized_bytes,
  };
}

export function listCaptureReceipts(root: string, projectSlug: string, limits: NotebookLimitsV1, state?: string): CaptureReceiptSummaryV1[] {
  const paths = notebookStatePaths(root, projectSlug);
  const scan = scanReceipts(paths, limits);
  if (scan.integrityCount) throw new NotebookError("CONFLICT", "Notebook capture state has integrity findings", false, { entries: scan.integrityCount });
  if (state && !(["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"] as const).includes(state as never)) {
    throw new NotebookError("INVALID_INPUT", `Unknown capture receipt state: ${state}`);
  }
  return scan.receipts
    .filter((receipt) => !state || receipt.state === state)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.receipt_id.localeCompare(b.receipt_id))
    .map(receiptSummary);
}

export function readCaptureReceipt(root: string, projectSlug: string, receiptId: string, limits: NotebookLimitsV1): CaptureReceiptV1 {
  if (!RECEIPT_ID_RE.test(receiptId)) throw new NotebookError("INVALID_INPUT", "Invalid receipt ID");
  const paths = notebookStatePaths(root, projectSlug);
  const path = join(paths.receipts, `${receiptId}.json`);
  if (!existsSync(path)) throw new NotebookError("NOT_FOUND", `Capture receipt not found: ${receiptId}`);
  const read = safeReadJson(path, limits.receipt_max_bytes);
  const receipt = read.value === undefined ? null : parseReceipt(read.value);
  if (!receipt || receipt.serialized_bytes !== read.bytes) throw new NotebookError("CONFLICT", `Capture receipt has an integrity finding: ${receiptId}`);
  return receipt;
}

function writeReceipt(paths: NotebookStatePaths, receipt: CaptureReceiptV1, limit: number): CaptureReceiptV1 {
  let text = jsonLine(receipt);
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limit) throw new NotebookError("CONFLICT", "Receipt transition exceeds its per-receipt ceiling");
    if (receipt.serialized_bytes === bytes) {
      atomicWriteJson(join(paths.receipts, `${receipt.receipt_id}.json`), receipt, paths.root);
      return receipt;
    }
    receipt.serialized_bytes = bytes;
    text = jsonLine(receipt);
  }
  throw new NotebookError("INTERNAL_ERROR", "Receipt transition size did not converge");
}

export interface CaptureReceiptVersionV1 {
  state: CaptureReceiptV1["state"];
  updated_at: string;
  lease_owner: string | null;
}

export function captureReceiptVersion(receipt: CaptureReceiptV1): CaptureReceiptVersionV1 {
  return { state: receipt.state, updated_at: receipt.updated_at, lease_owner: receipt.lease_owner };
}

function nextReceiptTimestamp(receipt: CaptureReceiptV1, now: Date): string {
  const requested = now.getTime();
  const previous = Date.parse(receipt.updated_at);
  return new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString();
}

export function authorizeCaptureRetry(input: {
  root: string;
  projectSlug: string;
  receiptId: string;
  limits: NotebookLimitsV1;
  baseline?: string;
  validateBaseline?: (gitRef: string) => boolean;
  now?: Date;
}): CaptureReceiptV1 {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1_000);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state === "blocked-missing-baseline") {
      if (!input.baseline) throw new NotebookError("INVALID_INPUT", "blocked-missing-baseline requires --baseline GIT_REF");
      if (!input.validateBaseline?.(input.baseline)) throw new NotebookError("INVALID_INPUT", "--baseline must name a contained committed Git reference");
      receipt.manual_baseline_ref = input.baseline;
      receipt.baseline_ref = input.baseline;
    } else if (receipt.state !== "failed" && receipt.state !== "retry-exhausted") {
      throw new NotebookError("CONFLICT", `Receipt in state ${receipt.state} cannot be retried`);
    }
    receipt.state = "queued";
    receipt.manual_retry_count += 1;
    receipt.attempt_origin = "operator";
    receipt.lease_owner = null;
    receipt.lease_deadline = null;
    receipt.updated_at = nextReceiptTimestamp(receipt, input.now ?? new Date());
    receipt.error_category = null;
    receipt.retryable = false;
    receipt.diagnostic = null;
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally { release(); }
}

export function claimCaptureReceipt(input: {
  root: string;
  projectSlug: string;
  receiptId: string;
  limits: NotebookLimitsV1;
  workerId?: string;
  now?: Date;
}): CaptureReceiptV1 {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1_000);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    const now = input.now ?? new Date();
    const resumingExpiredLease = receipt.state === "processing" && Boolean(receipt.lease_deadline) && Date.parse(receipt.lease_deadline!) <= now.getTime();
    const resumingAutomaticFailure = receipt.state === "failed" && receipt.attempt_origin === "automatic" && receipt.retryable
      && receipt.automatic_attempts_used < receipt.automatic_attempt_limit;
    if (receipt.state !== "queued" && !resumingExpiredLease && !resumingAutomaticFailure) throw new NotebookError("CONFLICT", `Receipt in state ${receipt.state} cannot be claimed`);
    if (receipt.attempt_origin === "automatic") {
      if (receipt.automatic_attempts_used >= receipt.automatic_attempt_limit) {
        if (resumingExpiredLease) {
          receipt.state = "retry-exhausted";
          receipt.lease_owner = null;
          receipt.lease_deadline = null;
          receipt.updated_at = nextReceiptTimestamp(receipt, now);
          receipt.retryable = false;
          receipt.diagnostic = "Expired worker lease exhausted the finite automatic attempt budget";
          writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
        }
        throw new NotebookError("CONFLICT", "Automatic capture attempt budget is exhausted");
      }
      receipt.automatic_attempts_used += 1;
    }
    receipt.state = "processing";
    receipt.lease_owner = (input.workerId ?? `${process.pid}-${randomUUID()}`).slice(0, 128);
    receipt.lease_deadline = new Date(now.getTime() + input.limits.lease_seconds * 1_000).toISOString();
    receipt.updated_at = nextReceiptTimestamp(receipt, now);
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally { release(); }
}

export function renewCaptureReceiptLease(input: {
  root: string;
  projectSlug: string;
  receiptId: string;
  limits: NotebookLimitsV1;
  expected: CaptureReceiptVersionV1;
  now?: Date;
}): CaptureReceiptV1 {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1_000);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state !== "processing" || !receipt.lease_owner
      || receipt.state !== input.expected.state || receipt.updated_at !== input.expected.updated_at || receipt.lease_owner !== input.expected.lease_owner) {
      throw new NotebookError("CONFLICT", "Capture receipt lease changed; stale worker renewal rejected");
    }
    const now = input.now ?? new Date();
    receipt.lease_deadline = new Date(now.getTime() + input.limits.lease_seconds * 1_000).toISOString();
    receipt.updated_at = nextReceiptTimestamp(receipt, now);
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally { release(); }
}

export function transitionCaptureReceipt(input: {
  root: string;
  projectSlug: string;
  receiptId: string;
  limits: NotebookLimitsV1;
  expected: CaptureReceiptVersionV1;
  state: CaptureReceiptV1["state"];
  errorCategory?: CaptureReceiptV1["error_category"];
  retryable?: boolean;
  diagnostic?: string | null;
  exclusionCounts?: Record<string, number>;
  summaryMode?: CaptureReceiptV1["summary_mode"];
  noteLogicalIds?: string[];
  remoteNoteIds?: string[];
  endRevision?: string | null;
  endStatusDigest?: string | null;
  now?: Date;
}): CaptureReceiptV1 {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1_000);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state !== input.expected.state || receipt.updated_at !== input.expected.updated_at || receipt.lease_owner !== input.expected.lease_owner) {
      throw new NotebookError("CONFLICT", "Capture receipt changed after it was claimed; stale worker transition rejected");
    }
    if (receipt.state === "processing" && !receipt.lease_owner) throw new NotebookError("CONFLICT", "Processing receipt has no valid lease owner");
    const allowed: Record<CaptureReceiptV1["state"], ReadonlySet<CaptureReceiptV1["state"]>> = {
      queued: new Set(["processing"]),
      processing: new Set(["succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"]),
      failed: new Set(["queued"]),
      "retry-exhausted": new Set(),
      "blocked-missing-baseline": new Set(),
      succeeded: new Set(),
    };
    if (!allowed[receipt.state].has(input.state)) throw new NotebookError("CONFLICT", `Capture receipt cannot transition from ${receipt.state} to ${input.state}`);
    receipt.state = input.state;
    receipt.updated_at = nextReceiptTimestamp(receipt, input.now ?? new Date());
    receipt.lease_owner = null;
    receipt.lease_deadline = null;
    receipt.error_category = input.errorCategory ?? null;
    receipt.retryable = input.retryable ?? false;
    receipt.diagnostic = input.diagnostic?.slice(0, input.limits.diagnostic_max_chars) ?? null;
    if (input.exclusionCounts) receipt.exclusion_counts = { ...input.exclusionCounts };
    if (input.summaryMode !== undefined) receipt.summary_mode = input.summaryMode;
    if (input.noteLogicalIds) receipt.note_logical_ids = [...new Set(input.noteLogicalIds)].slice(0, 2_000);
    if (input.remoteNoteIds) receipt.remote_note_ids = [...new Set(input.remoteNoteIds)].slice(0, 2_000);
    if (input.endRevision !== undefined) receipt.end_revision = input.endRevision;
    if (input.endStatusDigest !== undefined) receipt.end_status_digest = input.endStatusDigest;
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally { release(); }
}

export function pruneNotebookState(root: string, projectSlug: string, limits: NotebookLimitsV1, now = new Date()): string[] {
  const paths = ensureNotebookState(root, projectSlug);
  const release = acquireLock(paths, 1_000);
  const removed: string[] = [];
  try {
    const scan = scanReceipts(paths, limits);
    const auxiliary = scanAuxiliaryState(paths, limits);
    if (scan.integrityCount || auxiliary.integrityCount) return removed;
    const successCutoff = now.getTime() - limits.receipt_succeeded_retention_days * 86_400_000;
    for (const receipt of scan.receipts) {
      if (receipt.state !== "succeeded" || Date.parse(receipt.updated_at) > successCutoff) continue;
      const path = join(paths.receipts, `${receipt.receipt_id}.json`);
      unlinkStateFile(path, paths.root);
      removed.push(safeEntryId("receipts", basename(path)));
    }
    const remaining = scanReceipts(paths, limits);
    const remainingAuxiliary = scanAuxiliaryState(paths, limits);
    const referenced = new Set([...remaining.referencedSessions, ...remainingAuxiliary.referencedSessions]);
    for (const entry of readStateDirectory(paths.baselines, paths.root)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(paths.baselines, entry.name);
      const baseline = readBaseline(path, baselineReceiptByteCeiling(limits));
      if (!baseline || referenced.has(baseline.session_key)) continue;
      if (now.getTime() < Date.parse(baseline.created_at) + limits.receiptless_session_retention_seconds * 1_000) continue;
      unlinkStateFile(path, paths.root);
      removed.push(safeEntryId("baselines", entry.name));
      const claim = join(paths.claims, `${baseline.session_key}.overview`);
      if (unlinkStateFile(claim, paths.root, true)) removed.push(safeEntryId("claims", basename(claim)));
      const refusal = join(paths.refusals, `${baseline.session_key}.json`);
      if (unlinkStateFile(refusal, paths.root, true)) removed.push(safeEntryId("refusals", basename(refusal)));
    }
    fsyncDirectory(paths.project);
    return removed;
  } finally { release(); }
}

export function currentRetentionPressure(summary: CaptureAdmissionSummaryV1): Array<{ code: "retention-pressure"; session_key?: string; reason: RetentionRefusalReason | "current-usage" }> {
  if (summary.unresolved_count === null || summary.unresolved_bytes === null) return [];
  const findings: Array<{ code: "retention-pressure"; session_key?: string; reason: RetentionRefusalReason | "current-usage" }> = [];
  if (summary.unresolved_count >= summary.receipt_caps.max_count || summary.unresolved_bytes >= summary.receipt_caps.max_bytes) {
    findings.push({ code: "retention-pressure", reason: "current-usage" });
  }
  for (const marker of summary.active_refusals) {
    const countBlocked = summary.unresolved_count + 1 > summary.receipt_caps.max_count;
    const byteBlocked = summary.unresolved_bytes + marker.candidate_bytes > summary.receipt_caps.max_bytes;
    if (countBlocked || byteBlocked) findings.push({ code: "retention-pressure", session_key: marker.session_key, reason: capReason(countBlocked, byteBlocked) });
  }
  return findings;
}

export function statePathForReceipt(root: string, projectSlug: string, receiptId: string): string {
  if (!RECEIPT_ID_RE.test(receiptId)) throw new NotebookError("INVALID_INPUT", "Invalid receipt ID");
  return join(projectStateDir(root, projectSlug), "receipts", `${receiptId}.json`);
}
