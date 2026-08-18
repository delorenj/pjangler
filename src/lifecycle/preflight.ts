import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import YAML from "yaml";
import hermesTemplateManifest from "../../hermes-template-assets.json" with { type: "json" };
import { spawnSync } from "../utils/child-process";

export interface LifecycleEligibilityResult {
  ok: boolean;
  error?: string;
}

export interface TrustedCopierResult extends LifecycleEligibilityResult {
  executable?: string;
  realExecutable?: string;
  layout?: string;
  identity?: TrustedCopierIdentity;
  hermesTemplate?: TrustedHermesTemplateIdentity;
}

export interface TrustedHermesTemplateFile {
  path: string;
  gitBlob: string;
  sha256: string;
  mode: "100644" | "100755";
  contentBase64: string;
}

export interface TrustedHermesTemplateIdentity {
  commit: string;
  root: string;
  files: readonly TrustedHermesTemplateFile[];
}

export interface MaterializedHermesTemplate {
  /** Private construction worktree, retained only for cleanup and diagnostics. */
  path: string;
  /** Data-only Git bundle passed to Copier; it has no executable repo config. */
  source: string;
  ref: string;
  cleanup(): void;
}

export interface TrustedHermesTemplateResult extends LifecycleEligibilityResult {
  identity?: TrustedHermesTemplateIdentity;
}

export interface TrustedCopierFileIdentity {
  path: string;
  realPath: string;
  sha256: string;
  size: number;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  gid: number;
}

/**
 * Read-only provenance captured before an MCP apply.
 *
 * `executable` is the canonical launcher, not the PATH entry. Callers must
 * revalidate the full identity immediately before their first write and then
 * invoke this exact path. This makes a PATH swap irrelevant and detects a
 * package/launcher replacement between the handler preflight and execution.
 */
export interface TrustedCopierIdentity {
  executable: string;
  resolvedFrom: string;
  layout: "uv-tool";
  version: string;
  toolRoot: string;
  interpreter: TrustedCopierFileIdentity;
  files: readonly TrustedCopierFileIdentity[];
}

export interface TrustedCopierOptions {
  targetDir: string;
  env?: NodeJS.ProcessEnv;
  /** Test-only dependency injection. MCP callers always use the OS account home. */
  homeDir?: string;
  temporaryDir?: string;
  /** Kept for API compatibility; mutable layout allowlists are no longer trusted. */
  systemRoots?: readonly string[];
}

export interface RenderedHermesEligibilityOptions {
  pjanglerRoot: string;
  targetDir: string;
  roleDir: string;
  targetRepo: string;
  role: string;
  agentId: string;
  trustedHermesTemplate?: TrustedHermesTemplateIdentity;
}

/**
 * Immutable Hermes lifecycle assets captured from the pinned submodule tree.
 *
 * The SHA-256 values are used by source checkouts and npm installations alike;
 * the Git blob ids make the generating tree independently auditable without
 * requiring `.git` metadata at runtime. Release tests prove each pair directly
 * against `git show <commit>:<path>` before publication.
 */
type HermesManifestEntry = { gitBlob: string; sha256: string; mode: "100644" | "100755" };
type HermesManifest = { version: number; commit: string; files: Record<string, HermesManifestEntry> };
const HERMES_MANIFEST = hermesTemplateManifest as HermesManifest;
export const HERMES_TEMPLATE_ATTESTATION = Object.freeze({
  commit: HERMES_MANIFEST.commit,
  files: Object.freeze(HERMES_MANIFEST.files),
});

function containedBy(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realDirectoryContained(root: string, candidate: string, label: string): LifecycleEligibilityResult {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!containedBy(absoluteRoot, absoluteCandidate)) {
    return { ok: false, error: `${label} escapes its canonical root` };
  }
  try {
    const rootStat = lstatSync(absoluteRoot);
    const candidateStat = lstatSync(absoluteCandidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, error: `${label} canonical root must be a real directory` };
    }
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      return { ok: false, error: `${label} must be a real directory` };
    }
    const rootReal = realpathSync(absoluteRoot);
    const candidateReal = realpathSync(absoluteCandidate);
    if (!containedBy(rootReal, candidateReal)) {
      return { ok: false, error: `${label} escapes its canonical root through a symlinked ancestor` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function firstExecutableOnPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const rawEntry of (env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry || process.cwd();
    const candidate = resolve(entry, process.platform === "win32" ? "copier.exe" : "copier");
    try {
      accessSync(candidate, constants.X_OK);
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // Continue to the next PATH entry. Resolution itself must never execute a
      // candidate, because a shadowed program is exactly what this gate rejects.
    }
  }
  return undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("base64url");
}

function fingerprint(path: string): TrustedCopierFileIdentity {
  const absolute = resolve(path);
  const realPath = realpathSync(absolute);
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  return {
    path: absolute,
    realPath,
    sha256: sha256(realPath),
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function sameFingerprint(expected: TrustedCopierFileIdentity): LifecycleEligibilityResult {
  try {
    const actual = fingerprint(expected.path);
    for (const key of ["realPath", "sha256", "size", "device", "inode", "mode", "uid", "gid"] as const) {
      if (actual[key] !== expected[key]) {
        return { ok: false, error: `trusted Copier identity changed at ${expected.path} (${key})` };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `trusted Copier identity is unavailable at ${expected.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function consoleScriptContract(path: string): LifecycleEligibilityResult & { interpreter?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8").slice(0, 32 * 1024);
  } catch (error) {
    return { ok: false, error: `cannot read Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return { ok: false, error: "Copier launcher has no executable shebang" };
  const shebang = firstLine.slice(2).trim().split(/\s+/);
  if (shebang.length !== 1 || !isAbsolute(shebang[0] ?? "")) {
    return { ok: false, error: "Copier launcher must use one absolute Python interpreter" };
  }
  const interpreterPath = resolve(shebang[0]!);
  const interpreter = basename(interpreterPath);
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
    return { ok: false, error: "Copier launcher is not an absolute Python console script" };
  }
  if (!/from\s+copier\.__main__\s+import\s+CopierApp/.test(text) || !/CopierApp\.run\s*\(/.test(text)) {
    return { ok: false, error: "Copier launcher does not match the Copier 9 console-script contract" };
  }
  return { ok: true, interpreter: interpreterPath };
}

function defaultUvToolRoots(home: string): string[] {
  return [
    join(home, ".local", "share", "uv", "tools", "copier"),
    join(home, "Library", "Application Support", "uv", "tools", "copier"),
  ].map((path) => resolve(path));
}

function locateUvSitePackages(toolRoot: string): string {
  const lib = join(toolRoot, "lib");
  const candidates: string[] = [];
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^python\d+(?:\.\d+)*$/.test(entry.name)) continue;
    const sitePackages = join(lib, entry.name, "site-packages");
    if (existsSync(sitePackages)) candidates.push(sitePackages);
  }
  if (candidates.length !== 1) throw new Error(`expected one UV Copier site-packages directory, found ${candidates.length}`);
  return realpathSync(candidates[0]!);
}

function parseRecordLine(line: string): { relativePath: string; digest: string; size: number } | undefined {
  // Copier's wheel paths contain no CSV quoting. Reject rather than attempting
  // a permissive parse if a future/unexpected distribution does.
  if (!line || line.includes('"')) return undefined;
  const parts = line.split(",");
  if (parts.length !== 3 || !parts[1]?.startsWith("sha256=") || !/^\d+$/.test(parts[2] ?? "")) return undefined;
  return {
    relativePath: parts[0]!,
    digest: parts[1]!.slice("sha256=".length),
    size: Number(parts[2]),
  };
}

function attestUvCopier(candidate: string, realCandidate: string, home: string): TrustedCopierResult {
  const toolRoot = defaultUvToolRoots(home).find((root) => realCandidate === join(root, "bin", "copier"));
  if (!toolRoot) {
    return { ok: false, error: `refusing untrusted PATH-shadowed Copier executable: ${candidate}` };
  }

  const supportedEntries = new Set([
    join(home, ".local", "bin", "copier"),
    join(toolRoot, "bin", "copier"),
  ].map((path) => resolve(path)));
  if (!supportedEntries.has(resolve(candidate))) {
    return { ok: false, error: `refusing non-canonical UV Copier entry point: ${candidate}` };
  }

  try {
    const launcher = consoleScriptContract(realCandidate);
    if (!launcher.ok || !launcher.interpreter) {
      return { ...launcher, executable: realCandidate, realExecutable: realCandidate };
    }
    const expectedInterpreter = join(toolRoot, "bin", basename(launcher.interpreter));
    if (resolve(launcher.interpreter) !== resolve(expectedInterpreter)) {
      return { ok: false, error: "UV Copier launcher interpreter is outside the attested tool environment" };
    }

    const interpreterReal = realpathSync(launcher.interpreter);
    const uvPythonRoots = [
      join(home, ".local", "share", "uv", "python"),
      join(home, "Library", "Application Support", "uv", "python"),
    ];
    if (!uvPythonRoots.some((root) => containedBy(root, interpreterReal))) {
      return { ok: false, error: "UV Copier interpreter is not managed by the canonical UV Python installation" };
    }

    const receiptPath = join(toolRoot, "uv-receipt.toml");
    const receipt = readFileSync(receiptPath, "utf8");
    if (!/requirements\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["']/.test(receipt)
      || !/entrypoints\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["'][\s\S]*?from\s*=\s*["']copier["']/.test(receipt)) {
      return { ok: false, error: "UV tool receipt does not bind the copier entry point to the Copier package" };
    }

    const sitePackages = locateUvSitePackages(toolRoot);
    const distInfos = readdirSync(sitePackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^copier-[^-]+\.dist-info$/i.test(entry.name))
      .map((entry) => join(sitePackages, entry.name));
    if (distInfos.length !== 1) {
      return { ok: false, error: `expected one installed Copier distribution, found ${distInfos.length}` };
    }
    const distInfo = realpathSync(distInfos[0]!);
    const metadataPath = join(distInfo, "METADATA");
    const entryPointsPath = join(distInfo, "entry_points.txt");
    const recordPath = join(distInfo, "RECORD");
    const metadata = readFileSync(metadataPath, "utf8");
    const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (name?.toLowerCase() !== "copier" || !version || !/^9(?:\.|$)/.test(version)) {
      return { ok: false, error: "installed distribution is not a Copier 9 package" };
    }
    const entryPoints = readFileSync(entryPointsPath, "utf8");
    if (!/^copier\s*=\s*copier\.__main__:CopierApp\.run\s*$/m.test(entryPoints)) {
      return { ok: false, error: "installed Copier distribution has an unexpected console entry point" };
    }

    const recordEntries = readFileSync(recordPath, "utf8")
      .split(/\r?\n/)
      .map(parseRecordLine)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const selected = recordEntries.filter((entry) => {
      const normalized = entry.relativePath.replaceAll("\\", "/");
      return normalized.startsWith("copier/")
        || normalized === `${basename(distInfo)}/METADATA`
        || normalized === `${basename(distInfo)}/entry_points.txt`
        || normalized === "../../../bin/copier";
    });
    if (!selected.some((entry) => entry.relativePath === "../../../bin/copier")
      || !selected.some((entry) => entry.relativePath.replaceAll("\\", "/") === "copier/__main__.py")) {
      return { ok: false, error: "Copier RECORD does not bind its launcher and package entry point" };
    }

    const attestedFiles = new Map<string, TrustedCopierFileIdentity>();
    for (const entry of selected) {
      const path = resolve(sitePackages, entry.relativePath);
      const allowed = path === realCandidate || containedBy(sitePackages, path);
      if (!allowed) return { ok: false, error: `Copier RECORD path escapes the tool environment: ${entry.relativePath}` };
      const actualDigest = sha256(path);
      const actualSize = statSync(path).size;
      if (actualDigest !== entry.digest || actualSize !== entry.size) {
        return { ok: false, error: `Copier RECORD integrity mismatch: ${entry.relativePath}` };
      }
      attestedFiles.set(resolve(path), fingerprint(path));
    }
    for (const path of [realCandidate, join(toolRoot, "pyvenv.cfg"), receiptPath, metadataPath, entryPointsPath, recordPath]) {
      attestedFiles.set(resolve(path), fingerprint(path));
    }

    const identity: TrustedCopierIdentity = {
      executable: realCandidate,
      resolvedFrom: resolve(candidate),
      layout: "uv-tool",
      version,
      toolRoot,
      interpreter: fingerprint(launcher.interpreter),
      files: [...attestedFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
    return {
      ok: true,
      executable: identity.executable,
      realExecutable: identity.executable,
      layout: identity.layout,
      identity,
    };
  } catch (error) {
    return { ok: false, error: `cannot attest UV Copier installation: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function verifyTrustedCopierIdentity(identity: TrustedCopierIdentity): LifecycleEligibilityResult {
  if (!isAbsolute(identity.executable) || resolve(identity.executable) !== resolve(identity.files.find((file) => file.path === identity.executable)?.path ?? "")) {
    return { ok: false, error: "trusted Copier identity has no canonical absolute launcher" };
  }
  const interpreter = sameFingerprint(identity.interpreter);
  if (!interpreter.ok) return interpreter;
  for (const file of identity.files) {
    const verified = sameFingerprint(file);
    if (!verified.ok) return verified;
  }
  return { ok: true };
}

/**
 * Resolve and attest Copier without executing it.
 *
 * MCP apply paths accept the first PATH match only when it resolves to the
 * canonical Copier UV tool for the operating-system account. Layout or
 * launcher text alone is not provenance: the UV receipt, absolute interpreter,
 * Copier 9 distribution metadata, entry point, PEP-376 RECORD hashes, package
 * files, venv metadata, and interpreter are bound into an identity. pip-user,
 * pipx, pyenv, Homebrew, and arbitrary system locations remain usable by the
 * interactive CLI but fail closed for MCP apply unless a future implementation
 * can establish an equally strong package identity. An earlier shadow is never
 * skipped in favor of a later executable.
 */
export function preflightTrustedCopier(options: TrustedCopierOptions): TrustedCopierResult {
  const env = options.env ?? process.env;
  // Do not let an ambient HOME redirect the trust root. Tests can inject a
  // synthetic account home explicitly; production MCP callers cannot.
  const home = resolve(options.homeDir ?? userInfo().homedir);
  const temporary = resolve(options.temporaryDir ?? tmpdir());
  const target = resolve(options.targetDir);
  const candidate = firstExecutableOnPath(env);
  if (!candidate) return { ok: false, error: "copier not found on PATH" };

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: `cannot resolve Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }

  for (const [label, root] of [["target", target], ["temporary", temporary]] as const) {
    if (containedBy(root, candidate) || containedBy(root, realCandidate)) {
      return { ok: false, error: `refusing ${label}-local Copier executable: ${candidate}` };
    }
  }

  return attestUvCopier(candidate, realCandidate, home);
}

function regularContainedFile(root: string, path: string, label: string): LifecycleEligibilityResult {
  try {
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(path);
    if (!containedBy(rootReal, fileReal)) return { ok: false, error: `${label} escapes its vendored template root` };
    if (!lstatSync(path).isFile()) return { ok: false, error: `${label} is not a regular file` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseCopierConfig(templateRoot: string, label: string): { result: LifecycleEligibilityResult; config?: Record<string, unknown> } {
  const configPath = join(templateRoot, "copier.yml");
  const file = regularContainedFile(templateRoot, configPath, `${label} copier.yml`);
  if (!file.ok) return { result: file };
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: { ok: false, error: `${label} copier.yml must contain a mapping` } };
    }
    const config = parsed as Record<string, unknown>;
    if (config._subdirectory !== "template") {
      return { result: { ok: false, error: `${label} copier.yml must render the template subdirectory` } };
    }
    if (!/^9(?:\.|$)/.test(String(config._min_copier_version ?? ""))) {
      return { result: { ok: false, error: `${label} requires an unsupported Copier contract` } };
    }
    return { result: { ok: true }, config };
  } catch (error) {
    return { result: { ok: false, error: `${label} copier.yml is invalid: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

function requireFiles(templateRoot: string, files: readonly string[], label: string): LifecycleEligibilityResult {
  for (const rel of files) {
    const result = regularContainedFile(templateRoot, join(templateRoot, rel), `${label} ${rel}`);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function gitMode(mode: number): "100644" | "100755" {
  return mode & 0o111 ? "100755" : "100644";
}

function templateInventory(templateRoot: string): string[] {
  const files = ["copier.yml"];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`symlink is forbidden: ${relativePath}`);
      if (metadata.isDirectory()) {
        walk(path, relativePath);
      } else if (metadata.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`non-regular entry is forbidden: ${relativePath}`);
      }
    }
  };
  walk(join(templateRoot, "template"), "template");
  return files.sort();
}

function readStableTemplateFile(
  templateRoot: string,
  relativePath: string,
  expected: HermesManifestEntry,
): Buffer {
  const path = join(templateRoot, relativePath);
  const regular = regularContainedFile(templateRoot, path, `pinned Hermes asset ${relativePath}`);
  if (!regular.ok) throw new Error(regular.error);
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("not a regular file");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    for (const field of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"] as const) {
      if (before[field] !== after[field]) throw new Error(`changed while read (${field})`);
    }
    if (gitMode(Number(after.mode)) !== expected.mode) throw new Error("Git executable mode mismatch");
    const digest = createHash("sha256").update(bytes).digest("base64url");
    if (digest !== expected.sha256) throw new Error("content digest mismatch");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function captureAttestedHermesTemplate(templateRoot: string): TrustedHermesTemplateResult {
  const root = resolve(templateRoot);
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, error: "pinned Hermes template root must be a real directory" };
    }
    const expectedPaths = Object.keys(HERMES_TEMPLATE_ATTESTATION.files).sort();
    const actualPaths = templateInventory(root);
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      const missing = expectedPaths.filter((path) => !actualPaths.includes(path));
      const extra = actualPaths.filter((path) => !expectedPaths.includes(path));
      return {
        ok: false,
        error: `pinned Hermes template inventory mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`,
      };
    }
    const files = expectedPaths.map((relativePath): TrustedHermesTemplateFile => {
      const expected = HERMES_TEMPLATE_ATTESTATION.files[relativePath];
      if (!expected) throw new Error(`manifest entry disappeared: ${relativePath}`);
      const bytes = readStableTemplateFile(root, relativePath, expected);
      return Object.freeze({
        path: relativePath,
        gitBlob: expected.gitBlob,
        sha256: expected.sha256,
        mode: expected.mode,
        contentBase64: bytes.toString("base64"),
      });
    });
    return {
      ok: true,
      identity: Object.freeze({
        commit: HERMES_TEMPLATE_ATTESTATION.commit,
        root,
        files: Object.freeze(files),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `cannot attest pinned Hermes template: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function verifyTrustedHermesTemplateIdentity(identity: TrustedHermesTemplateIdentity): LifecycleEligibilityResult {
  if (identity.commit !== HERMES_TEMPLATE_ATTESTATION.commit) {
    return { ok: false, error: "trusted Hermes template commit changed" };
  }
  const expectedPaths = Object.keys(HERMES_TEMPLATE_ATTESTATION.files).sort();
  const actualPaths = identity.files.map((entry) => entry.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths) || new Set(actualPaths).size !== actualPaths.length) {
    return { ok: false, error: "trusted Hermes template inventory changed" };
  }
  for (const entry of identity.files) {
    const expected = HERMES_TEMPLATE_ATTESTATION.files[entry.path];
    if (!expected || entry.gitBlob !== expected.gitBlob || entry.sha256 !== expected.sha256 || entry.mode !== expected.mode) {
      return { ok: false, error: `trusted Hermes template metadata changed: ${entry.path}` };
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(entry.contentBase64, "base64");
    } catch {
      return { ok: false, error: `trusted Hermes template bytes are invalid: ${entry.path}` };
    }
    if (createHash("sha256").update(bytes).digest("base64url") !== expected.sha256) {
      return { ok: false, error: `trusted Hermes template bytes changed: ${entry.path}` };
    }
  }
  return { ok: true };
}

type SnapshotTreeNode = {
  directories: Map<string, SnapshotTreeNode>;
  files: Map<string, TrustedHermesTemplateFile>;
};

function writeSnapshotGitObject(
  gitDirectory: string,
  kind: "blob" | "tree" | "commit",
  body: Buffer,
): string {
  const object = Buffer.concat([Buffer.from(`${kind} ${body.byteLength}\0`), body]);
  const objectId = createHash("sha1").update(object).digest("hex");
  const objectPath = join(gitDirectory, "objects", objectId.slice(0, 2), objectId.slice(2));
  mkdirSync(dirname(objectPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(objectPath, deflateSync(object), { flag: "wx", mode: 0o400 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: Buffer;
    try {
      existing = inflateSync(readFileSync(objectPath));
    } catch {
      throw new Error("trusted Hermes snapshot Git object was replaced during construction");
    }
    if (!existing.equals(object)) {
      throw new Error("trusted Hermes snapshot Git object changed during construction");
    }
  }
  return objectId;
}

function buildSnapshotGitTree(
  gitDirectory: string,
  node: SnapshotTreeNode,
): string {
  const records: Array<{ sortKey: string; bytes: Buffer }> = [];
  for (const [name, file] of node.files) {
    const blob = writeSnapshotGitObject(
      gitDirectory,
      "blob",
      Buffer.from(file.contentBase64, "base64"),
    );
    records.push({
      sortKey: name,
      bytes: Buffer.concat([
        Buffer.from(`${file.mode} ${name}\0`),
        Buffer.from(blob, "hex"),
      ]),
    });
  }
  for (const [name, directory] of node.directories) {
    const tree = buildSnapshotGitTree(gitDirectory, directory);
    records.push({
      // Git compares a tree name as if it had a trailing slash.
      sortKey: `${name}/`,
      bytes: Buffer.concat([
        Buffer.from(`40000 ${name}\0`),
        Buffer.from(tree, "hex"),
      ]),
    });
  }
  records.sort((left, right) => Buffer.compare(Buffer.from(left.sortKey), Buffer.from(right.sortKey)));
  return writeSnapshotGitObject(
    gitDirectory,
    "tree",
    Buffer.concat(records.map((record) => record.bytes)),
  );
}

function initializeContentAddressedTemplateRepo(
  directory: string,
  files: readonly TrustedHermesTemplateFile[],
): string {
  const root: SnapshotTreeNode = { directories: new Map(), files: new Map() };
  for (const file of files) {
    const components = file.path.split("/");
    const filename = components.pop();
    if (!filename || components.some((component) => !component || component === "." || component === "..")) {
      throw new Error(`trusted Hermes template path is unsafe: ${file.path}`);
    }
    let node = root;
    for (const component of components) {
      if (node.files.has(component)) {
        throw new Error(`trusted Hermes template path conflicts with a file: ${file.path}`);
      }
      let child = node.directories.get(component);
      if (!child) {
        child = { directories: new Map(), files: new Map() };
        node.directories.set(component, child);
      }
      node = child;
    }
    if (node.files.has(filename) || node.directories.has(filename)) {
      throw new Error(`trusted Hermes template path is duplicated: ${file.path}`);
    }
    node.files.set(filename, file);
  }

  const gitDirectory = join(directory, ".git");
  mkdirSync(join(gitDirectory, "objects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(gitDirectory, "refs", "heads"), { recursive: true, mode: 0o700 });
  const tree = buildSnapshotGitTree(gitDirectory, root);
  const commitBody = Buffer.from([
    `tree ${tree}`,
    "author pjangler immutable snapshot <noreply@pjangler.invalid> 1 +0000",
    "committer pjangler immutable snapshot <noreply@pjangler.invalid> 1 +0000",
    "",
    "PJAN-67 content-addressed Hermes template snapshot",
    "",
  ].join("\n"));
  const commit = writeSnapshotGitObject(gitDirectory, "commit", commitBody);
  writeFileSync(join(gitDirectory, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = false",
    "",
  ].join("\n"), { flag: "wx", mode: 0o400 });
  writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/snapshot\n", { flag: "wx", mode: 0o400 });
  writeFileSync(join(gitDirectory, "refs", "heads", "snapshot"), `${commit}\n`, { flag: "wx", mode: 0o400 });
  return commit;
}

function createContentAddressedTemplateBundle(
  directory: string,
): { descriptor: number; source: string } {
  const bundle = join(directory, "pjangler-hermes-template.bundle");
  const result = spawnSync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "-C", directory,
      "bundle", "create", bundle, "refs/heads/snapshot",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`cannot seal trusted Hermes template bundle: ${String(result.stderr ?? "").trim() || `git exited ${result.status ?? "unknown"}`}`);
  }
  chmodSync(bundle, 0o400);
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = openSync(bundle, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || bytes.byteLength === 0) throw new Error("trusted Hermes template bundle is invalid");
    for (const field of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"] as const) {
      if (before[field] !== after[field]) throw new Error(`trusted Hermes template bundle changed while read (${field})`);
    }
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  if (process.platform === "linux" && existsSync(`/proc/${process.pid}/fd`)) {
    // The only execution handle is a still-open regular-file descriptor owned
    // by this already-running MCP process. Removing its pathname prevents a
    // same-UID actor from swapping the source to a repo with executable config;
    // Copier/Git open the exact inode through /proc while this descriptor lives.
    try {
      unlinkSync(bundle);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
    return {
      descriptor,
      source: `git+/proc/${process.pid}/fd/${descriptor}`,
    };
  }
  // Portable fallback: this is still a data-only bundle pinned to an exact
  // content-addressed commit. A same-user replacement can only preserve those
  // bytes or make Git fail; it cannot introduce executable repository config.
  return {
    descriptor,
    source: `git+${bundle}`,
  };
}

export function materializeTrustedHermesTemplate(identity: TrustedHermesTemplateIdentity): MaterializedHermesTemplate {
  const verified = verifyTrustedHermesTemplateIdentity(identity);
  if (!verified.ok) throw new Error(verified.error ?? "trusted Hermes template identity is invalid");
  const directory = mkdtempSync(join(tmpdir(), "pjangler-hermes-template-"));
  try {
    chmodSync(directory, 0o700);
    for (const entry of identity.files) {
      const path = resolve(directory, entry.path);
      if (!containedBy(directory, path)) throw new Error("trusted Hermes template path escaped its snapshot");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(entry.contentBase64, "base64"), {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    }
    const recaptured = captureAttestedHermesTemplate(directory);
    if (!recaptured.ok) throw new Error(recaptured.error ?? "materialized Hermes template failed attestation");
    // Copier receives an exact commit id, never HEAD or the owner-writable
    // worktree. A same-UID edit after this boundary can only make Git reject a
    // corrupt object; it cannot substitute different bytes for the pinned
    // content-addressed tree.
    const ref = initializeContentAddressedTemplateRepo(directory, identity.files);
    const bundle = createContentAddressedTemplateBundle(directory);
    let closed = false;
    return {
      path: directory,
      source: bundle.source,
      ref,
      cleanup() {
        if (!closed) {
          closeSync(bundle.descriptor);
          closed = true;
        }
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function attestPinnedHermesTemplate(templateRoot: string): LifecycleEligibilityResult {
  const captured = captureAttestedHermesTemplate(templateRoot);
  return captured.ok ? { ok: true } : captured;
}

export function preflightCommonProjectTemplate(pjanglerRoot: string): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "commonproject");
  const contained = realDirectoryContained(resolve(pjanglerRoot), templateRoot, "CommonProject template");
  if (!contained.ok) return contained;
  const parsed = parseCopierConfig(templateRoot, "CommonProject template");
  if (!parsed.result.ok) return parsed.result;
  const files = requireFiles(templateRoot, [
    "template/.project.json.jinja",
    "template/.copier-answers.yml.jinja",
    "template/.env.op",
    "template/AGENTS.md.jinja",
    "template/mise.toml.jinja",
  ], "CommonProject template");
  if (!files.ok) return files;
  const projectJson = readFileSync(join(templateRoot, "template", ".project.json.jinja"), "utf8");
  for (const key of ["project_name", "project_slug", "repo_path", "ticket_provider", "agents"]) {
    if (!projectJson.includes(`\"${key}\"`)) return { ok: false, error: `CommonProject projection is missing ${key}` };
  }
  return { ok: true };
}

export function preflightHermesTemplate(pjanglerRoot: string, env: NodeJS.ProcessEnv = process.env): TrustedHermesTemplateResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "hermes-agent");
  const contained = realDirectoryContained(resolve(pjanglerRoot), templateRoot, "Hermes template");
  if (!contained.ok) return contained;
  const explicit = env.PJANGLER_HERMES_TEMPLATE?.trim();
  if (explicit) {
    try {
      if (realpathSync(resolve(explicit)) !== realpathSync(templateRoot)) {
        return { ok: false, error: "MCP Hermes apply requires the version-locked vendored template" };
      }
    } catch (error) {
      return { ok: false, error: `Hermes template override is unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const parsed = parseCopierConfig(templateRoot, "Hermes template");
  if (!parsed.result.ok) return parsed.result;
  const required = requireFiles(templateRoot, [
    "template/role.yaml.jinja",
    "template/SOUL.md.jinja",
    "template/hermes.jinja",
    "template/.scripts/_lib.sh",
    "template/.scripts/lib/fleet-env.sh",
    "template/.scripts/lib/parse-fleet-env.py",
    "template/.scripts/heartbeat.sh",
    "template/.scripts/01-config.sh",
    "template/.scripts/05-fleet-env.sh",
    "template/.scripts/10-hermes-profile.sh",
    "template/.scripts/20-runtime-repo.sh",
    "template/.scripts/42-ticket-provider.sh",
    "template/.scripts/70-systemd.sh",
    "template/.scripts/80-registry.sh",
  ], "Hermes template");
  if (!required.ok) return required;
  const pinned = captureAttestedHermesTemplate(templateRoot);
  if (!pinned.ok) return pinned;

  const role = readFileSync(join(templateRoot, "template", "role.yaml.jinja"), "utf8");
  if (!/^bloodbank:\s*$[\s\S]*?^\s+enabled:\s+(?:true|false)\s*$/m.test(role)) {
    return { ok: false, error: "Hermes role projection must declare bloodbank.enabled as a strict boolean" };
  }
  const library = readFileSync(join(templateRoot, "template", ".scripts", "_lib.sh"), "utf8");
  if (!library.includes("PJANGLER_PROJECT_ROOT") || !library.includes('"$explicit"/agents/hermes/*')) {
    return { ok: false, error: "Hermes project-root resolver must honor the explicitly contained MCP target" };
  }
  const skipPlane = readFileSync(join(templateRoot, "template", ".scripts", "42-ticket-provider.sh"), "utf8");
  const guard = skipPlane.indexOf('if [[ "${SKIP_PLANE:-0}" == "1" ]]');
  const firstSource = skipPlane.search(/^source\s/m);
  if (guard < 0 || firstSource < 0 || guard > firstSource) {
    return { ok: false, error: "Hermes ticket-provider skip guard must precede all sourced provider/config logic" };
  }
  for (const script of ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "80-registry.sh"]) {
    const text = readFileSync(join(templateRoot, "template", ".scripts", script), "utf8");
    const hostGuard = text.indexOf('if [[ "${SKIP_HOST_STATE:-0}" == "1" ]]');
    const source = text.search(/^source\s/m);
    if (hostGuard < 0 || source < 0 || hostGuard > source) {
      return { ok: false, error: `Hermes ${script} host-state guard must precede all sourced config/fleet logic` };
    }
  }
  const tasks = Array.isArray(parsed.config?._tasks) ? parsed.config._tasks.map(String) : [];
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    if (!tasks.some((task) => task.includes(script))) return { ok: false, error: `Hermes copier task list is missing ${script}` };
  }
  return { ok: true, identity: pinned.identity };
}

/**
 * Validate the trusted Copier projection before any host-global script runs.
 *
 * The executable and version-locked template were attested before Copier was
 * launched. This second, read-only gate proves that the rendered identity,
 * strict lifecycle metadata, local project registration, and every script we
 * may execute in the host/external tails are exactly the expected projection.
 */
export function preflightRenderedHermes(options: RenderedHermesEligibilityOptions): LifecycleEligibilityResult {
  const target = resolve(options.targetDir);
  const roleDir = resolve(options.roleDir);
  if (!containedBy(target, roleDir)) return { ok: false, error: "rendered Hermes role escapes its project target" };
  const physicalContainment = realDirectoryContained(target, roleDir, "rendered Hermes role");
  if (!physicalContainment.ok) return physicalContainment;
  try {
    const stat = lstatSync(roleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "rendered Hermes role must be a real directory" };
    }
  } catch (error) {
    return { ok: false, error: `rendered Hermes role is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const templateScripts = join(resolve(options.pjanglerRoot), "templates", "hermes-agent", "template", ".scripts");
  let capturedScripts: ReadonlyMap<string, Buffer> | undefined;
  if (options.trustedHermesTemplate) {
    const verified = verifyTrustedHermesTemplateIdentity(options.trustedHermesTemplate);
    if (!verified.ok) return verified;
    capturedScripts = new Map(
      options.trustedHermesTemplate.files
        .filter((entry) => entry.path.startsWith("template/.scripts/"))
        .map((entry) => [entry.path.slice("template/.scripts/".length), Buffer.from(entry.contentBase64, "base64")]),
    );
  } else {
    const pinned = attestPinnedHermesTemplate(join(resolve(options.pjanglerRoot), "templates", "hermes-agent"));
    if (!pinned.ok) return pinned;
  }
  const renderedScripts = join(roleDir, ".scripts");
  const requiredFiles = [
    "role.yaml",
    "SOUL.md",
    "hermes",
    ".gitignore",
    ".runtime-scaffold/README.md",
    ".scripts/lib/fleet-env.sh",
    ".scripts/lib/parse-fleet-env.py",
    ".scripts/heartbeat.sh",
    ...["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]
      .map((script) => `.scripts/${script}`),
  ];
  const required = requireFiles(roleDir, requiredFiles, "rendered Hermes role");
  if (!required.ok) return required;

  for (const script of ["_lib.sh", "heartbeat.sh", "lib/fleet-env.sh", "lib/parse-fleet-env.py", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    try {
      const expected = capturedScripts?.get(script) ?? readFileSync(join(templateScripts, script));
      if (!readFileSync(join(renderedScripts, script)).equals(expected)) {
        return { ok: false, error: `rendered Hermes script differs from the attested template: ${script}` };
      }
    } catch (error) {
      return { ok: false, error: `cannot attest rendered Hermes script ${script}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  let role: Record<string, unknown>;
  try {
    const parsed = YAML.parse(readFileSync(join(roleDir, "role.yaml"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "rendered Hermes role.yaml must contain a mapping" };
    }
    role = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: `rendered Hermes role.yaml is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.repo !== options.targetRepo || role.role !== options.role || role.agent_id !== options.agentId) {
    return { ok: false, error: "rendered Hermes role identity does not match the requested repo/role/agent" };
  }
  const bloodbank = role.bloodbank as Record<string, unknown> | undefined;
  if (!bloodbank || typeof bloodbank.enabled !== "boolean") {
    return { ok: false, error: "rendered Hermes bloodbank.enabled must be a strict boolean" };
  }
  const deployment = role.deployment as Record<string, unknown> | undefined;
  if (!deployment || deployment.local_only !== true || deployment.systemd !== "deferred") {
    return { ok: false, error: "rendered Hermes deployment must remain local-only/deferred until external grants run" };
  }

  const manifestPath = join(target, ".project.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const agents = manifest.agents as Record<string, Record<string, unknown>> | undefined;
      const declared = agents?.[options.agentId];
      if (!declared
        || declared.role !== options.role
        || declared.role_dir !== relative(target, roleDir)
        || declared.provisioning_state !== "provisioned") {
        return { ok: false, error: "rendered Hermes role is not canonically registered in .project.json" };
      }
    } catch (error) {
      return { ok: false, error: `cannot validate rendered Hermes project registration: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}

export function preflightMcpLifecycle(options: {
  pjanglerRoot: string;
  targetDir: string;
  commonProject: boolean;
  hermes: boolean;
  env?: NodeJS.ProcessEnv;
}): TrustedCopierResult {
  const copier = preflightTrustedCopier({ targetDir: options.targetDir, env: options.env });
  if (!copier.ok) return copier;
  if (options.commonProject) {
    const common = preflightCommonProjectTemplate(options.pjanglerRoot);
    if (!common.ok) return { ...common, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  if (options.hermes) {
    const hermes = preflightHermesTemplate(options.pjanglerRoot, options.env);
    if (!hermes.ok) {
      return {
        ok: false,
        error: hermes.error,
        executable: copier.executable,
        realExecutable: copier.realExecutable,
      };
    }
    if (!hermes.identity) {
      return { ok: false, error: "Hermes template attestation returned no immutable identity" };
    }
    return { ...copier, hermesTemplate: hermes.identity };
  }
  return copier;
}
