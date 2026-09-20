import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";


export interface LifecycleEligibilityResult {
  ok: boolean;
  error?: string;
}


export interface TrustedCopierResult extends LifecycleEligibilityResult {
  executable?: string;
  realExecutable?: string;
  layout?: string;
  identity?: TrustedCopierIdentity;
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


function containedBy(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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


export function preflightCommonProjectTemplate(pjanglerRoot: string): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "commonproject");
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
  for (const key of ["project_name", "repo_path", "ticket_provider", "agents"]) {
    if (!projectJson.includes(`\"${key}\"`)) return { ok: false, error: `CommonProject projection is missing ${key}` };
  }
  if (!projectJson.includes('"project_id"') && !projectJson.includes('"project_slug"')) {
    return { ok: false, error: "CommonProject manifest is missing project_id" };
  }
  return { ok: true };
}


export function preflightMcpLifecycle(options: {
  pjanglerRoot: string;
  targetDir: string;
  commonProject: boolean;
  env?: NodeJS.ProcessEnv;
}): TrustedCopierResult {
  const copier = preflightTrustedCopier({ targetDir: options.targetDir, env: options.env });
  if (!copier.ok) return copier;
  if (options.commonProject) {
    const common = preflightCommonProjectTemplate(options.pjanglerRoot);
    if (!common.ok) return { ...common, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  return copier;
}
