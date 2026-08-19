import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { extname, join, parse, relative, resolve, sep } from "node:path";
import { sha256Hex } from "./notes";
import { NotebookError, type EffectiveNotebookConfigV1, type SessionBaselineV1 } from "./types";

export interface GitSnapshotV1 {
  head: string | null;
  status_digest: string | null;
  dirty_paths: string[];
  tracked_path_digests: Record<string, string>;
  complete: boolean;
  reasons: string[];
}

export interface EligibleDocumentV1 {
  path: string;
  source_revision: string;
  content_sha256: string;
  start_content_sha256?: string;
  content: string;
}

export interface GitEvidenceSelectionV1 {
  documents: EligibleDocumentV1[];
  changed_paths: string[];
  exclusions: Record<string, number>;
  end_revision: string | null;
  end_status_digest: string | null;
}

function git(repo: string, args: string[], maxBuffer = 4 * 1024 * 1024, timeout = 5_000): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer, timeout, shell: false });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function statusPaths(value: string): string[] {
  const entries = value.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (/[RC]/u.test(status)) {
      const prior = entries[++index];
      if (prior) paths.push(prior);
    }
  }
  return paths;
}

export function captureGitSnapshot(repoPath: string, config?: EffectiveNotebookConfigV1, deadlineMonotonicMs?: number): GitSnapshotV1 {
  const configuredTimeout = config?.limits.overall_timeout_ms ?? 5_000;
  const remaining = (): number => deadlineMonotonicMs === undefined
    ? configuredTimeout
    : Math.max(0, Math.min(configuredTimeout, Math.floor(deadlineMonotonicMs - performance.now())));
  const boundedGit = (args: string[]) => {
    const timeout = remaining();
    return timeout > 0 ? git(repoPath, args, 4 * 1024 * 1024, timeout) : { ok: false, stdout: "" };
  };
  const headResult = boundedGit(["rev-parse", "--verify", "HEAD"]);
  const statusResult = boundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const reasons: string[] = [];
  if (deadlineMonotonicMs !== undefined && remaining() === 0) reasons.push("hook-deadline-exhausted");
  if (!headResult.ok) reasons.push("missing-committed-head");
  if (!statusResult.ok) reasons.push("git-status-failed");
  const trackedPathDigests: Record<string, string> = {};
  if (config) {
    const trackedResult = boundedGit(["ls-files", "-z"]);
    if (!trackedResult.ok) reasons.push("git-tracked-files-failed");
    else {
      const candidates = trackedResult.stdout.split("\0").filter(Boolean)
        .filter((path) => config.policy.documentation_globs.some((glob) => matchesSimpleGlob(path, glob)))
        .filter((path) => !config.policy.excluded_globs?.some((glob) => matchesSimpleGlob(path, glob)))
        .sort((a, b) => a.localeCompare(b, "en"));
      if (candidates.length > config.limits.list_max_items) reasons.push("tracked-document-limit");
      for (const path of candidates.slice(0, config.limits.list_max_items)) {
        if (deadlineMonotonicMs !== undefined && remaining() === 0) { reasons.push("hook-deadline-exhausted"); break; }
        if (looksGenerated(path)) continue;
        const file = readSafeEvidenceText(repoPath, path, config.limits.source_file_max_bytes);
        if (file.status !== "present") continue;
        trackedPathDigests[path] = file.content_sha256;
      }
    }
  }
  return {
    head: headResult.ok ? headResult.stdout.trim() : null,
    status_digest: statusResult.ok ? sha256Hex(statusResult.stdout) : null,
    dirty_paths: statusResult.ok ? [...new Set(statusPaths(statusResult.stdout))].sort() : [],
    tracked_path_digests: trackedPathDigests,
    complete: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

export function validateCommittedGitRef(repoPath: string, gitRef: string): boolean {
  if (!gitRef || gitRef.length > 256 || gitRef.startsWith("-")) return false;
  return git(repoPath, ["rev-parse", "--verify", `${gitRef}^{commit}`], 64 * 1024).ok;
}

function safeRelative(repoPath: string, relativePath: string): { root: string; candidate: string } | null {
  if (!relativePath || relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.split(/[\\/]/u).includes("..")) return null;
  const root = realpathSync(repoPath);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return null;
  return { root, candidate };
}

export type SafeEvidenceReadV1 =
  | { status: "present"; content: string; content_sha256: string; bytes: number }
  | { status: "excluded"; reason: "unsafe-path" | "not-regular" | "oversize" | "binary" | "secret-like" | "changed-during-read" };

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) return true; }
    catch { return true; }
  }
  return false;
}

export function readSafeEvidenceText(repoPath: string, relativePath: string, maxBytes: number): SafeEvidenceReadV1 {
  const safe = safeRelative(repoPath, relativePath);
  if (!safe || hasSymlinkComponent(safe.root, safe.candidate)) return { status: "excluded", reason: "unsafe-path" };
  let fd: number;
  try { fd = openSync(safe.candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return { status: "excluded", reason: "not-regular" }; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { status: "excluded", reason: "not-regular" };
    if (before.size > maxBytes) return { status: "excluded", reason: "oversize" };
    let physical: string;
    try { physical = realpathSync(`/proc/self/fd/${fd}`); }
    catch { return { status: "excluded", reason: "unsafe-path" }; }
    const physicalRel = relative(safe.root, physical);
    if (physicalRel === ".." || physicalRel.startsWith(`..${sep}`) || physicalRel.startsWith(sep)) return { status: "excluded", reason: "unsafe-path" };
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8_192, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) return { status: "excluded", reason: "oversize" };
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || total !== before.size) return { status: "excluded", reason: "changed-during-read" };
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) return { status: "excluded", reason: "binary" };
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { status: "excluded", reason: "binary" }; }
    if (looksSecret(relativePath, content)) return { status: "excluded", reason: "secret-like" };
    return { status: "present", content, content_sha256: sha256Hex(bytes), bytes: total };
  } finally { closeSync(fd); }
}

function looksGenerated(path: string): boolean {
  return /(^|\/)(dist|build|coverage|node_modules|vendor|\.next|_site)(\/|$)/u.test(path)
    || /(?:\.min\.|\.generated\.|-lock\.)/u.test(path);
}

function looksSecret(path: string, content: string): boolean {
  if (/(^|\/)(\.env(?:\.|$)|id_(?:rsa|ed25519)$)|(?:secret|credential|private[-_]?key)/iu.test(path)) return true;
  return /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|password|token)\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{16,})/iu.test(content);
}

function matchesSimpleGlob(path: string, glob: string): boolean {
  // v1 defaults are suffix globs; support the common bounded subset without a
  // shell or a dependency whose semantics differ by platform.
  if (glob === "**/*.md") return path.toLowerCase().endsWith(".md");
  if (glob === "**/*.mdx") return path.toLowerCase().endsWith(".mdx");
  if (glob.startsWith("**/*.")) return extname(path).toLowerCase() === `.${glob.slice(5).toLowerCase()}`;
  return path === glob;
}

function addExclusion(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

export function selectEligibleDocuments(config: EffectiveNotebookConfigV1, baseline: SessionBaselineV1, manualBaselineRef?: string): GitEvidenceSelectionV1 {
  const repo = config.repo_path;
  const startRef = manualBaselineRef ?? baseline.git_head;
  if (!startRef || !validateCommittedGitRef(repo, startRef)) throw new NotebookError("INVALID_INPUT", "Capture baseline is not a committed Git reference");
  const end = captureGitSnapshot(repo);
  if (!end.head) throw new NotebookError("CONFLICT", "Repository has no committed end revision");

  const committed = git(repo, ["diff", "--name-only", "-z", `${startRef}..${end.head}`], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  const working = git(repo, ["diff", "--name-only", "-z", "HEAD"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  const staged = git(repo, ["diff", "--cached", "--name-only", "-z"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  if (!committed.ok || !working.ok || !staged.ok) throw new NotebookError("INTERNAL_ERROR", "Git evidence selection failed");
  const uncommitted = new Set([...working.stdout.split("\0"), ...staged.stdout.split("\0")].filter(Boolean));
  const allChanged = [...new Set([...committed.stdout.split("\0"), ...uncommitted].filter(Boolean))].sort();
  const changed = allChanged.slice(0, config.limits.list_max_items);
  const trackedResult = git(repo, ["ls-files", "-z"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  if (!trackedResult.ok) throw new NotebookError("INTERNAL_ERROR", "Git tracked-file enumeration failed");
  const tracked = new Set(trackedResult.stdout.split("\0").filter(Boolean));
  const preDirty = new Set(baseline.pre_dirty_paths);
  const exclusions: Record<string, number> = {};
  const documents: EligibleDocumentV1[] = [];
  if (allChanged.length > changed.length) addExclusion(exclusions, "changed-path-limit");

  for (const path of changed) {
    if (manualBaselineRef && uncommitted.has(path)) { addExclusion(exclusions, "manual-baseline-uncommitted"); continue; }
    if (!tracked.has(path)) { addExclusion(exclusions, "untracked"); continue; }
    if (!config.policy.documentation_globs.some((glob) => matchesSimpleGlob(path, glob))) { addExclusion(exclusions, "policy"); continue; }
    if (config.policy.excluded_globs?.some((glob) => matchesSimpleGlob(path, glob))) { addExclusion(exclusions, "excluded"); continue; }
    if (looksGenerated(path)) { addExclusion(exclusions, "generated"); continue; }
    const file = readSafeEvidenceText(repo, path, config.limits.source_file_max_bytes);
    if (file.status !== "present") { addExclusion(exclusions, file.reason); continue; }
    const startDigest = baseline.tracked_path_digests[path];
    if (preDirty.has(path) && (!startDigest || startDigest === file.content_sha256)) {
      addExclusion(exclusions, startDigest ? "pre-existing-dirty-unchanged" : "pre-existing-dirty-unknown");
      continue;
    }
    documents.push({ path, source_revision: end.head, content_sha256: file.content_sha256, ...(startDigest ? { start_content_sha256: startDigest } : {}), content: file.content });
  }
  return {
    documents,
    changed_paths: changed,
    exclusions,
    end_revision: end.head,
    end_status_digest: end.status_digest,
  };
}
