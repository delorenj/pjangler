import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PJANGLER_VERSION } from "../utils/version";
import { captureGitSnapshot } from "./git-evidence";
import { sha256Hex } from "./notes";
import type { NotebookModule } from "./module";
import {
  admitCaptureReceipt,
  createOverviewClaim,
  createSessionBaseline,
  deriveSessionKey,
  readOverviewClaim,
  readSessionBaseline,
} from "./state";
import { NOTEBOOK_POLICY_VERSION, NotebookError } from "./types";

export interface ClaudeSessionHookPayloadV1 {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  client_name?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

export interface NotebookHookResultV1 {
  exitCode: 0;
  stdout: string;
  stderr: string;
  outcome: "captured" | "deduplicated" | "retention-pressure" | "state-integrity" | "primed" | "skipped" | "failed-open";
  receiptId?: string;
}

export interface NotebookHookRuntime {
  spawnWorker(receiptId: string, projectSlug: string): void;
  now(): Date;
}

export function captureWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  projectSlug: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    PJ_NOTEBOOK_WORKER_PROJECT_SLUG: projectSlug,
  };
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "OPEN_NOTEBOOK_PASSWORD",
  ] as const) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) result[name] = value;
  }
  const registryPath = source.PJ_PROJECT_REGISTRY;
  if (typeof registryPath === "string" && isAbsolute(registryPath) && !registryPath.includes("\0") && Buffer.byteLength(registryPath, "utf8") <= 4_096) {
    result.PJ_PROJECT_REGISTRY = resolve(registryPath);
  }
  return result;
}

const DEFAULT_RUNTIME: NotebookHookRuntime = {
  now: () => new Date(),
  spawnWorker(receiptId, projectSlug) {
    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [entry, "notebook", "worker", "capture", "--receipt-id", receiptId], {
      detached: true,
      stdio: "ignore",
      env: captureWorkerEnvironment(process.env, projectSlug),
    });
    child.unref();
  },
};

interface SkillExportManifestV1 {
  schema_version: 1;
  skill: "project-notebook";
  files: Array<{ path: string; sha256: string; mode: "0644" | "0755" }>;
}

function bundledSkillCandidates(): string[] {
  const candidates: string[] = [];
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(join(cursor, "dist", "assets", "project-notebook-skill"), join(cursor, "assets", "project-notebook-skill"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function safeSkillRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\0")) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules" || part === "__pycache__")) return false;
  const leaf = parts.at(-1)!.toLowerCase();
  return !(/\.(?:bak(?:-.+)?|orig|pid|sock|log|db-wal|db-shm)$/u.test(leaf) || leaf.endsWith("~") || leaf === ".env" || leaf.startsWith(".env."));
}

function assertOwnedSkillTree(source: string): void {
  assertNoSymlinkComponents(source);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const walk = (directory: string) => {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a non-directory component");
    if (uid !== undefined && directoryStat.uid !== uid) throw new NotebookError("CONFLICT", "Project Notebook skill source is not owned by the current user");
    if (directoryStat.mode & 0o7002) throw new NotebookError("CONFLICT", "Project Notebook skill source has unsafe directory mode bits");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a symlink");
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a non-regular entry");
      else {
        if (uid !== undefined && stat.uid !== uid) throw new NotebookError("CONFLICT", "Project Notebook skill file is not owned by the current user");
        if (stat.mode & 0o7002) throw new NotebookError("CONFLICT", "Project Notebook skill file has unsafe mode bits");
      }
    }
  };
  walk(source);
}

function enumerateSkillPayload(source: string): SkillExportManifestV1["files"] {
  const result: SkillExportManifestV1["files"] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      const rel = relative(source, path).split(sep).join("/");
      if (!rel.includes("/") && (rel === "export-manifest.json" || rel === "SHA256SUMS")) continue;
      if (!safeSkillRelativePath(rel)) throw new NotebookError("CONFLICT", `Project Notebook skill export path is unsafe: ${rel}`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill export contains a symlink");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const expectedMode = rel.endsWith(".sh") || rel.startsWith("scripts/") ? "0755" : "0644";
        result.push({ path: rel, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mode: expectedMode });
      } else throw new NotebookError("CONFLICT", "Project Notebook skill export contains a non-regular entry");
    }
  };
  walk(source);
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function parsePackedManifest(source: string): SkillExportManifestV1 | null {
  const manifestPath = join(source, "export-manifest.json");
  if (!existsSync(manifestPath)) return null;
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("CONFLICT", "Project Notebook skill export manifest is invalid");
  const manifest = value as Partial<SkillExportManifestV1>;
  if (manifest.schema_version !== 1 || manifest.skill !== "project-notebook" || !Array.isArray(manifest.files)) throw new NotebookError("CONFLICT", "Project Notebook skill export manifest is incompatible");
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !/^(?:0644|0755)$/u.test(entry.mode)) throw new NotebookError("CONFLICT", "Project Notebook skill export entry is invalid");
    if (!safeSkillRelativePath(entry.path) || paths.has(entry.path)) throw new NotebookError("CONFLICT", "Project Notebook skill export path is unsafe or duplicated");
    paths.add(entry.path);
    const path = join(source, ...entry.path.split("/"));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill export contains a non-regular entry");
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== entry.sha256) throw new NotebookError("CONFLICT", `Project Notebook skill digest mismatch: ${entry.path}`);
    const actualMode = stat.mode & 0o777;
    const executable = entry.mode === "0755";
    // npm may apply the caller's cooperative umask and unpack 0644/0755 as
    // 0664/0775. The manifest mode is the exact installed-payload mode; source
    // verification accepts only that harmless group-write delta, requires the
    // owner executable bit when declared, and still rejects world/special bits
    // through assertOwnedSkillTree().
    if ((executable && (actualMode & 0o100) === 0) || (!executable && (actualMode & 0o111) !== 0)
      || (actualMode & ~((executable ? 0o755 : 0o644) | 0o020)) !== 0) {
      throw new NotebookError("CONFLICT", `Project Notebook skill mode mismatch: ${entry.path}`);
    }
  }
  const actualPaths = enumerateSkillPayload(source).map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.files.map((entry) => entry.path))) throw new NotebookError("CONFLICT", "Project Notebook skill manifest does not exactly enumerate its payload");
  const sums = `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
  if (!existsSync(join(source, "SHA256SUMS")) || readFileSync(join(source, "SHA256SUMS"), "utf8") !== sums) throw new NotebookError("CONFLICT", "Project Notebook skill SHA256SUMS is missing or stale");
  return manifest as SkillExportManifestV1;
}

function expectedPackedSkill(): { source: string; manifest: SkillExportManifestV1; digest: string } {
  for (const candidate of bundledSkillCandidates()) {
    if (!existsSync(join(candidate, "export-manifest.json"))) continue;
    assertOwnedSkillTree(candidate);
    const manifest = parsePackedManifest(candidate);
    if (!manifest) continue;
    const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    return { source: candidate, manifest, digest };
  }
  throw new NotebookError("NOT_CONFIGURED", "PJángler package has no verified Project Notebook skill export");
}

function isVerifiedCanonicalSkillexProjection(path: string): boolean {
  const normalized = resolve(path).split(sep).join("/");
  if (!normalized.endsWith("/all-skills/project-notebook")) return false;
  try { verifyProjectNotebookSkillExport(path); return true; }
  catch { return false; }
}

export function verifyProjectNotebookSkillExport(source: string): SkillExportManifestV1 {
  const absolute = resolve(source);
  assertOwnedSkillTree(absolute);
  const packed = parsePackedManifest(absolute);
  const actual = packed ?? { schema_version: 1 as const, skill: "project-notebook" as const, files: enumerateSkillPayload(absolute) };
  const expected = expectedPackedSkill();
  if (absolute !== expected.source && JSON.stringify(actual.files) !== JSON.stringify(expected.manifest.files)) {
    throw new NotebookError("CONFLICT", "Configured Project Notebook skill does not match the package-pinned export digest");
  }
  return actual;
}

export function resolveProjectNotebookSkillSource(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PJ_PROJECT_NOTEBOOK_SKILL_ROOT) {
    const explicit = resolve(env.PJ_PROJECT_NOTEBOOK_SKILL_ROOT);
    if (!existsSync(join(explicit, "SKILL.md"))) throw new NotebookError("NOT_CONFIGURED", "Configured Project Notebook skill source is unavailable");
    verifyProjectNotebookSkillExport(explicit);
    return explicit;
  }
  if (env.PJ_SKILLS_REGISTRY_ROOT) {
    const canonical = resolve(env.PJ_SKILLS_REGISTRY_ROOT, "all-skills", "project-notebook");
    if (existsSync(join(canonical, "SKILL.md"))) {
      verifyProjectNotebookSkillExport(canonical);
      return canonical;
    }
  }
  try { return expectedPackedSkill().source; }
  catch { return null; }
}

function verifiedCanonicalSkillexRootProjection(skillsRoot: string, link: string): string | null {
  let rootLink;
  try { rootLink = lstatSync(skillsRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!rootLink.isSymbolicLink()) return null;

  try {
    // Only the exact user-owned Skillex fanout topology may cross this
    // otherwise strict no-symlink boundary. Nothing is created or replaced
    // through the link: the existing projection is authenticated and kept.
    assertNoSymlinkComponents(dirname(skillsRoot));
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && rootLink.uid !== uid) throw new Error("owner");

    const globalRoot = realpathSync(skillsRoot);
    assertNoSymlinkComponents(globalRoot);
    const globalStat = lstatSync(globalRoot);
    if (!globalStat.isDirectory() || globalStat.isSymbolicLink()) throw new Error("root-type");
    if (uid !== undefined && globalStat.uid !== uid) throw new Error("root-owner");
    if (globalStat.mode & 0o7002) throw new Error("root-mode");
    const skillSetsRoot = dirname(globalRoot);
    if (basename(globalRoot) !== "global" || basename(skillSetsRoot) !== "skill-sets") throw new Error("layout");

    const checkoutRoot = dirname(skillSetsRoot);
    const expectedSource = join(checkoutRoot, "all-skills", "project-notebook");
    const linkStat = lstatSync(link);
    if (!linkStat.isSymbolicLink()) throw new Error("projection-type");
    if (uid !== undefined && linkStat.uid !== uid) throw new Error("projection-owner");
    const projectedSource = realpathSync(link);
    if (projectedSource !== realpathSync(expectedSource)) throw new Error("projection-target");
    if (!isVerifiedCanonicalSkillexProjection(projectedSource)) throw new Error("projection-digest");
    return projectedSource;
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw new NotebookError("CONFLICT", "Existing skills root is not a verified canonical Skillex projection");
  }
}

export function installPackagedProjectNotebookSkill(input: { source?: string; env?: NodeJS.ProcessEnv } = {}): { installed: boolean; path: string; digest: string } {
  const env = input.env ?? process.env;
  const source = input.source ?? resolveProjectNotebookSkillSource(env);
  if (!source) throw new NotebookError("NOT_CONFIGURED", "Project Notebook skill source is unavailable");
  const manifest = verifyProjectNotebookSkillExport(source);
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const home = env.HOME;
  if (!home || !resolve(home).startsWith("/")) throw new NotebookError("NOT_CONFIGURED", "A trusted HOME is required to install the Project Notebook skill");
  const skillsRoot = join(home, ".agents", "skills");
  const link = join(skillsRoot, "project-notebook");
  if (verifiedCanonicalSkillexRootProjection(skillsRoot, link)) {
    return { installed: false, path: link, digest };
  }
  const dataRoot = resolve(env.XDG_DATA_HOME || join(home, ".local", "share"), "pjangler", "skills", "project-notebook");
  const payload = join(dataRoot, `${PJANGLER_VERSION}-${digest}`);
  assertNoSymlinkComponents(dirname(dataRoot), true);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(dataRoot);
  const dataStat = lstatSync(dataRoot);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink() || (typeof process.getuid === "function" && dataStat.uid !== process.getuid())) throw new NotebookError("CONFLICT", "Project Notebook skill data root is not a current-user directory");
  chmodSync(dataRoot, 0o700);
  if (!existsSync(payload)) {
    const staging = join(dataRoot, `.staging-${randomUUID()}`);
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    try {
      for (const entry of manifest.files) {
        const destination = join(staging, ...entry.path.split("/"));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
        copyFileSync(join(source, ...entry.path.split("/")), destination);
        const mode = entry.mode === "0755" ? 0o755 : 0o644;
        chmodSync(destination, mode);
        const fd = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const current = fstatSync(fd);
          if (!current.isFile()) throw new NotebookError("CONFLICT", `Installed skill entry is not regular: ${entry.path}`);
          fsyncSync(fd);
        } finally { closeSync(fd); }
      }
      writeFileSync(join(staging, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: "wx" });
      writeFileSync(join(staging, "SHA256SUMS"), `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`, { mode: 0o644, flag: "wx" });
      verifyProjectNotebookSkillExport(staging);
      renameSync(staging, payload);
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  } else {
    const stat = lstatSync(payload);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Installed Project Notebook payload is not a real directory");
    verifyProjectNotebookSkillExport(payload);
  }
  assertNoSymlinkComponents(skillsRoot, true);
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(skillsRoot);
  let linkExists = existsSync(link);
  if (!linkExists) {
    try { lstatSync(link); linkExists = true; } catch { /* absent */ }
  }
  if (linkExists) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Existing Project Notebook skill path is customized or foreign; refusing to replace it");
    const target = realpathSync(link);
    if (target !== realpathSync(payload) && !isVerifiedCanonicalSkillexProjection(target)) throw new NotebookError("CONFLICT", "Existing Project Notebook skill path is customized or foreign; refusing to replace it");
    verifyProjectNotebookSkillExport(target);
    return { installed: false, path: link, digest };
  }
  symlinkSync(payload, link, "dir");
  return { installed: true, path: link, digest };
}

export interface ProjectNotebookHookCheckV1 {
  ok: boolean;
  findings: Array<{ kind: string; event: string; message: string }>;
}

export function inspectProjectNotebookIntegration(env: NodeJS.ProcessEnv = process.env): { skill_installed: boolean; hooks_projected: boolean; details: string[] } {
  const home = env.HOME;
  if (!home) return { skill_installed: false, hooks_projected: false, details: ["HOME is unavailable"] };
  const link = join(home, ".agents", "skills", "project-notebook");
  try {
    const expected = expectedPackedSkill();
    const dataRoot = resolve(env.XDG_DATA_HOME || join(home, ".local", "share"), "pjangler", "skills", "project-notebook");
    const expectedPayload = join(dataRoot, `${PJANGLER_VERSION}-${expected.digest}`);
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return { skill_installed: false, hooks_projected: false, details: ["Project Notebook skill path is not an owned link"] };
    const source = realpathSync(link);
    const packedPayloadMatches = existsSync(expectedPayload) && source === realpathSync(expectedPayload);
    if (!packedPayloadMatches && !isVerifiedCanonicalSkillexProjection(source)) return { skill_installed: false, hooks_projected: false, details: ["Project Notebook skill link targets a foreign or stale payload"] };
    verifyProjectNotebookSkillExport(source);
    const hooks = checkProjectNotebookHooks({ source, env });
    return {
      skill_installed: true,
      hooks_projected: hooks.ok,
      details: hooks.findings.map((finding) => `${finding.kind}:${finding.event}:${finding.message}`).slice(0, 20),
    };
  } catch (error) {
    return { skill_installed: false, hooks_projected: false, details: [boundedDiagnostic(error)] };
  }
}

function projectorArguments(source: string, command: "check" | "install", input: { target: string; stateHome?: string }): string[] {
  const script = join(source, "scripts", "project-hooks.py");
  const args = [script, command, "--master", join(source, "hooks", "hooks.master.json"), "--fragment", join(source, "hooks", "claude.settings.json"), "--target", input.target];
  if (command === "check") args.push("--json");
  else if (input.stateHome) args.push("--state-home", input.stateHome);
  return args;
}

function projectorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  if (env.HOME) result.HOME = env.HOME;
  if (env.XDG_STATE_HOME) result.XDG_STATE_HOME = env.XDG_STATE_HOME;
  return result;
}

export function checkProjectNotebookHooks(input: { source?: string; env?: NodeJS.ProcessEnv; target?: string } = {}): ProjectNotebookHookCheckV1 {
  const env = input.env ?? process.env;
  const source = input.source ?? resolveProjectNotebookSkillSource(env);
  if (!source) throw new NotebookError("NOT_CONFIGURED", "Project Notebook skill source is unavailable; reinstall or rebuild PJangler");
  verifyProjectNotebookSkillExport(source);
  const home = env.HOME;
  if (!home) throw new NotebookError("NOT_CONFIGURED", "HOME is required to check Project Notebook hooks");
  const target = resolve(input.target ?? env.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? join(home, ".claude", "settings.json"));
  const result = spawnSync("/usr/bin/python3", ["-I", ...projectorArguments(source, "check", { target })], { encoding: "utf8", env: projectorEnvironment(env), timeout: 5_000, maxBuffer: 1_048_576 });
  if (result.status !== 0 && result.status !== 1) throw new NotebookError("CONFLICT", (result.stderr || "Project Notebook projector check failed").trim().slice(0, 512));
  try {
    const parsed = JSON.parse(result.stdout) as ProjectNotebookHookCheckV1;
    if (typeof parsed.ok !== "boolean" || !Array.isArray(parsed.findings)) throw new Error("shape");
    return parsed;
  } catch {
    throw new NotebookError("INTERNAL_ERROR", "Project Notebook projector returned invalid check JSON");
  }
}

export function installProjectNotebookIntegration(input: { source?: string; env?: NodeJS.ProcessEnv; target?: string } = {}): { skill: ReturnType<typeof installPackagedProjectNotebookSkill>; hooksChanged: boolean } {
  const env = input.env ?? process.env;
  const skill = installPackagedProjectNotebookSkill({ source: input.source, env });
  const source = realpathSync(skill.path);
  const home = env.HOME;
  if (!home) throw new NotebookError("NOT_CONFIGURED", "HOME is required to install Project Notebook hooks");
  const target = resolve(input.target ?? env.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? join(home, ".claude", "settings.json"));
  const stateHome = resolve(env.XDG_STATE_HOME || join(home, ".local", "state"));
  const result = spawnSync("/usr/bin/python3", ["-I", ...projectorArguments(source, "install", { target, stateHome })], { encoding: "utf8", env: projectorEnvironment(env), timeout: 5_000, maxBuffer: 1_048_576 });
  if (result.status !== 0) {
    if (skill.installed) {
      try {
        const stat = lstatSync(skill.path);
        if (stat.isSymbolicLink() && realpathSync(skill.path) === source) unlinkSync(skill.path);
      } catch { /* preserve the projector error and never remove an unproved path */ }
    }
    throw new NotebookError("CONFLICT", (result.stderr || "Project Notebook hook installation failed").trim().slice(0, 512));
  }
  return { skill, hooksChanged: /\bchanged\b/u.test(result.stdout) };
}

function boundedDiagnostic(value: unknown, max = 512): string {
  const message = value instanceof NotebookError
    ? value.message
    : "Project Notebook encountered an unexpected internal error";
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").slice(0, max);
}

function parsePayload(value: string, maxBytes: number): ClaudeSessionHookPayloadV1 {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Hook payload exceeds its configured ceiling");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new NotebookError("INVALID_INPUT", "Hook payload must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new NotebookError("INVALID_INPUT", "Hook payload must be a JSON object");
  return parsed as ClaudeSessionHookPayloadV1;
}

export function readBoundedHookStdin(maxBytes: number, fd = 0): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(8_192, maxBytes + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new NotebookError("INVALID_INPUT", "Hook stdin exceeds its configured ceiling");
    chunks.push(chunk.subarray(0, count));
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch { throw new NotebookError("INVALID_INPUT", "Hook stdin must be valid UTF-8"); }
}

function assertNoSymlinkComponents(path: string, allowMissing = false): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new NotebookError("INVALID_INPUT", "Hook payload path contains a symlink component");
  }
}

export function readHookPayload(input: { payloadFile?: string; stateRoot: string; maxBytes: number; stdin?: string }): { payload: ClaudeSessionHookPayloadV1; bytes: number } {
  if (!input.payloadFile) {
    const value = input.stdin ?? readBoundedHookStdin(input.maxBytes);
    return { payload: parsePayload(value, input.maxBytes), bytes: Buffer.byteLength(value, "utf8") };
  }
  const root = resolve(input.stateRoot);
  const path = resolve(input.payloadFile);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new NotebookError("INVALID_INPUT", "Hook payload file is outside Notebook XDG state");
  assertNoSymlinkComponents(root);
  assertNoSymlinkComponents(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new NotebookError("INVALID_INPUT", "Hook payload file must be a contained mode-0600 regular file");
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new NotebookError("INVALID_INPUT", "Hook payload file must be owned by the current user");
  if (before.size > input.maxBytes) throw new NotebookError("INVALID_INPUT", "Hook payload file exceeds its configured ceiling");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new NotebookError("INVALID_INPUT", "Hook payload file changed while opening");
    const value = readBoundedHookStdin(input.maxBytes, fd);
    return { payload: parsePayload(value, input.maxBytes), bytes: Buffer.byteLength(value, "utf8") };
  } finally { closeSync(fd); }
}

function identity(payload: ClaudeSessionHookPayloadV1): { sessionId: string; repo: string; client: string } | null {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const repo = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  const client = typeof payload.client_name === "string" ? payload.client_name.trim().toLowerCase() : "claude-code";
  if (!sessionId || !repo) return null;
  if (client !== "claude" && client !== "claude-code") return null;
  return { sessionId, repo, client: "claude-code" };
}

function eventAllowed(payload: ClaudeSessionHookPayloadV1, expected: "SessionStart" | "SessionEnd"): boolean {
  if (payload.hook_event_name === undefined) return true;
  return payload.hook_event_name === expected;
}

function truncateCodePoints(value: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(value);
  if (points.length <= max) return { text: value, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}

export async function runSessionStartHook(module: NotebookModule, payload: ClaudeSessionHookPayloadV1, runtime: NotebookHookRuntime = DEFAULT_RUNTIME): Promise<NotebookHookResultV1> {
  const hookStarted = performance.now();
  try {
    if (!eventAllowed(payload, "SessionStart")) return { exitCode: 0, stdout: "", stderr: "project-notebook: unsupported non-SessionStart event skipped", outcome: "skipped" };
    const id = identity(payload);
    if (!id) return { exitCode: 0, stdout: "", stderr: "project-notebook: missing or unsupported session identity; skipped", outcome: "skipped" };
    const ctx = module.context(id.repo, false);
    if (ctx.config.binding.state !== "linked" || (!ctx.config.policy.session_start_enabled && !ctx.config.policy.session_capture_enabled)) return { exitCode: 0, stdout: "", stderr: "", outcome: "skipped" };
    const budget = ctx.config.limits.hook_session_start_timeout_ms;
    const safetyMargin = Math.min(50, Math.max(1, Math.floor(budget * 0.05)));
    const deadline = hookStarted + Math.max(1, budget - safetyMargin);
    const sessionKey = deriveSessionKey(ctx.config.project_slug, id.client, id.sessionId);
    let baseline = readSessionBaseline(module.stateRoot, ctx.config.project_slug, sessionKey, ctx.config.limits);
    if (!baseline) {
      const snapshot = captureGitSnapshot(ctx.config.repo_path, ctx.config, deadline);
      baseline = createSessionBaseline(module.stateRoot, {
        limits: ctx.config.limits,
        session_key: sessionKey,
        project_slug: ctx.config.project_slug,
        client: id.client,
        created_at: runtime.now().toISOString(),
        repo_path: ctx.config.repo_path,
        git_head: snapshot.head,
        git_status_digest: snapshot.status_digest,
        policy_version: NOTEBOOK_POLICY_VERSION,
        tracked_path_digests: snapshot.tracked_path_digests,
        pre_dirty_paths: snapshot.dirty_paths,
        complete: snapshot.complete,
        incomplete_reasons: snapshot.reasons,
      }).baseline;
    } else if (runtime.now().getTime() >= Date.parse(baseline.created_at) + ctx.config.limits.receiptless_session_retention_seconds * 1_000) {
      return { exitCode: 0, stdout: "", stderr: "project-notebook: SessionStart resume is older than the receiptless baseline grace; skipped without inventing a new boundary", outcome: "failed-open" };
    }
    if (performance.now() >= deadline) return { exitCode: 0, stdout: "", stderr: "project-notebook: SessionStart budget exhausted after recording an incomplete baseline; failed open", outcome: "failed-open" };
    if (!ctx.config.policy.session_start_enabled || ctx.config.binding.state !== "linked") return { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    if (readOverviewClaim(module.stateRoot, ctx.config.project_slug, sessionKey)) return { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    try {
      const overview = await module.overview(id.repo, undefined, deadline);
      const stale = overview.data.drift.length > 0;
      const warning = stale
        ? `PROJECT NOTEBOOK OVERVIEW DRIFT\n${overview.data.drift.map((item) => `${item.path}: ${item.reason}`).join("\n")}\n\n[Stored Overview is stale]\n`
        : "";
      const bounded = truncateCodePoints(overview.data.note.content, ctx.config.policy.overview_max_chars);
      const content = `PROJECT NOTEBOOK\n${warning}${bounded.text}${bounded.truncated ? "\n[Project Notebook Overview truncated]" : ""}\n`;
      const claim = createOverviewClaim(module.stateRoot, {
        session_key: sessionKey,
        project_slug: ctx.config.project_slug,
        created_at: runtime.now().toISOString(),
        overview_note_id: overview.data.note.id,
        content_sha256: sha256Hex(content),
      });
      return claim.created
        ? { exitCode: 0, stdout: content, stderr: "", outcome: "primed" }
        : { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    } catch (error) {
      return { exitCode: 0, stdout: "", stderr: `project-notebook: Overview unavailable: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
    }
  } catch (error) {
    return { exitCode: 0, stdout: "", stderr: `project-notebook: SessionStart failed open: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
  }
}

export function runSessionCloseHook(module: NotebookModule, payload: ClaudeSessionHookPayloadV1, runtime: NotebookHookRuntime = DEFAULT_RUNTIME): NotebookHookResultV1 {
  const started = Date.now();
  try {
    if (!eventAllowed(payload, "SessionEnd")) return { exitCode: 0, stdout: "", stderr: "project-notebook: unsupported non-SessionEnd event skipped", outcome: "skipped" };
    const id = identity(payload);
    if (!id) return { exitCode: 0, stdout: "", stderr: "project-notebook: missing or unsupported session identity; skipped", outcome: "skipped" };
    const ctx = module.context(id.repo, false);
    if (ctx.config.binding.state !== "linked" || !ctx.config.policy.session_capture_enabled) return { exitCode: 0, stdout: "", stderr: "", outcome: "skipped" };
    const sessionKey = deriveSessionKey(ctx.config.project_slug, id.client, id.sessionId);
    const admission = admitCaptureReceipt({
      root: module.stateRoot,
      projectSlug: ctx.config.project_slug,
      repoPath: ctx.config.repo_path,
      sessionKey,
      endRevision: null,
      endStatusDigest: null,
      limits: ctx.config.limits,
      now: runtime.now(),
    });
    if (admission.outcome === "state-integrity") return { exitCode: 0, stdout: "", stderr: admission.diagnostic.slice(0, 2_048), outcome: "state-integrity" };
    if (admission.outcome === "retention-pressure") return { exitCode: 0, stdout: "", stderr: admission.diagnostic.slice(0, 2_048), outcome: "retention-pressure" };
    if (admission.outcome === "deduplicated") return { exitCode: 0, stdout: "", stderr: "", outcome: "deduplicated", receiptId: admission.receipt.receipt_id };
    runtime.spawnWorker(admission.receipt.receipt_id, ctx.config.project_slug);
    const elapsed = Date.now() - started;
    return {
      exitCode: 0,
      stdout: "",
      stderr: elapsed > ctx.config.limits.hook_session_end_timeout_ms ? "project-notebook: capture was durably queued but foreground budget was exceeded" : "",
      outcome: "captured",
      receiptId: admission.receipt.receipt_id,
    };
  } catch (error) {
    return { exitCode: 0, stdout: "", stderr: `project-notebook: SessionEnd failed open: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
  }
}
