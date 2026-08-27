import { homedir, platform } from "node:os";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

const HERMES_GIT_URL = "https://github.com/delorenj/hermes-agent.git";
const HERMES_GIT_REF = "main";
const HERMES_GIT_SHA = "0408fec7a153e6c32c064acd2b8053917f1525f1";

type ConfigSchema = ReadonlyArray<{
  section: string;
  values: ReadonlyArray<readonly [key: string, value: string]>;
}>;

/** Resolve the one host-global config consumed by the pinned Copier template. */
export function resolveTemplateConfigPath(): string {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function detectHermesInstall(home: string): { bin: string; repo: string } {
  const releaseRoot = join(home, ".local", "share", "hermes-agent", "releases", HERMES_GIT_SHA);
  const devRoot = join(home, "code", "hermes-agent");
  const candidates = [
    join(releaseRoot, ".venv", "bin", "hermes"),
    join(home, ".local", "bin", "hermes"),
    join(devRoot, "venv", "bin", "hermes"),
    join(devRoot, ".venv", "bin", "hermes"),
  ];
  const bin = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  try {
    const resolved = realpathSync(bin);
    const environment = dirname(dirname(resolved));
    if (["venv", ".venv"].includes(environment.split("/").at(-1) ?? "")) {
      return { bin, repo: dirname(environment) };
    }
  } catch {
    // A not-yet-installed pinned release is still the canonical bootstrap guess.
  }
  return { bin, repo: bin.startsWith(devRoot) ? devRoot : releaseRoot };
}

function hostSchema(): ConfigSchema {
  const home = homedir();
  const hermes = detectHermesInstall(home);
  return [
    {
      section: "fleet",
      values: [
        ["hermes_bin", quote(hermes.bin)],
        ["hermes_repo", quote(hermes.repo)],
        ["pjangler_bin", quote("pj")],
        ["hermes_git_url", quote(HERMES_GIT_URL)],
        ["hermes_git_ref", quote(HERMES_GIT_REF)],
        ["hermes_git_sha", quote(HERMES_GIT_SHA)],
        ["runtime_scaffold_dir", quote(join(home, "code", "hermes-agent-template", "runtime-scaffold"))],
        ["fleet_env", quote("~/.hermes/fleet.env")],
        ["registry_file", quote("~/.hermes/agents-registry.yaml")],
        ["oauth_file", quote("~/.hermes/auth.json")],
        ["codex_home", quote("~/.codex")],
        ["canonical_skills_dir", quote(join(home, ".agents", "skills"))],
        ["vox_plugin_name", quote("vox")],
        ["vox_plugin_dir", quote(join(home, "code", "voxxy", "plugins", "tts", "vox"))],
        ["vox_voice", quote("carlin")],
        ["vox_url", quote("https://vox.delo.sh")],
        ["onepassword_vault", quote("DeLoSecrets")],
        ["onepassword_item_prefix", quote("hermes-agent")],
        [
          "symlinked_runtime_skills",
          `[${[
            "delonet-conventions",
            "delonet-dotenv",
            "hermes-pm-template-maintenance",
            "hindsight",
            "33god-projects",
            "subagent-driven-development",
          ].map(quote).join(", ")}]`,
        ],
      ],
    },
    { section: "github", values: [["runtime_repo_owner", quote("")]] },
    {
      section: "plane",
      values: [
        ["base", quote("https://plane.delo.sh")],
        ["workspace", quote("33god")],
      ],
    },
  ];
}

/** Render the current, pinned template schema with host-derived path values. */
export function renderHostConfig(): string {
  const sections = hostSchema()
    .map(({ section, values }) => `[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}`)
    .join("\n\n");
  return `# hermes-agent-template — host configuration\n# Bootstrapped by \`pj config bootstrap\` for $HOME=${homedir()} (platform=${platform()}).\n# Existing values and additional keys are preserved by \`--force\`; it only adds\n# fields missing from the schema pinned in this pjangler release.\n# Resolution precedence: env var > ~/.hermes/fleet.env > this file > fallback.\n\n${sections}\n`;
}

export interface TomlTableHeader {
  kind: "table" | "array-table";
  path: string[];
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
}

type MultilineString = "basic" | "literal" | undefined;

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Track TOML multiline strings so header-looking payload lines stay payload. */
function scanMultilineState(line: string, initial: MultilineString): MultilineString {
  let state = initial;
  let string: "basic" | "literal" | undefined;
  for (let index = 0; index < line.length;) {
    if (state) {
      const marker = state === "basic" ? '\"\"\"' : "'''";
      const close = line.indexOf(marker, index);
      if (close === -1) return state;
      if (state === "basic" && isEscaped(line, close)) {
        index = close + marker.length;
        continue;
      }
      state = undefined;
      index = close + marker.length;
      continue;
    }
    if (string === "basic") {
      if (line[index] === '\"' && !isEscaped(line, index)) string = undefined;
      index += 1;
      continue;
    }
    if (string === "literal") {
      if (line[index] === "'") string = undefined;
      index += 1;
      continue;
    }
    if (line[index] === "#") break;
    if (line.startsWith('\"\"\"', index)) {
      state = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = "literal";
      index += 3;
      continue;
    }
    if (line[index] === '\"') string = "basic";
    else if (line[index] === "'") string = "literal";
    index += 1;
  }
  return state;
}

function parseBasicKey(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a TOML dotted key, including quoted segments, without losing spelling. */
function parseDottedKey(raw: string): string[] | undefined {
  const path: string[] = [];
  let cursor = 0;
  const whitespace = () => {
    while (cursor < raw.length && /[ \t]/.test(raw[cursor]!)) cursor += 1;
  };
  whitespace();
  while (cursor < raw.length) {
    let key: string | undefined;
    if (raw[cursor] === '\"') {
      const start = cursor;
      cursor += 1;
      while (cursor < raw.length) {
        if (raw[cursor] === '\"' && !isEscaped(raw, cursor)) {
          cursor += 1;
          key = parseBasicKey(raw.slice(start, cursor));
          break;
        }
        cursor += 1;
      }
    } else if (raw[cursor] === "'") {
      const end = raw.indexOf("'", cursor + 1);
      if (end !== -1) {
        key = raw.slice(cursor + 1, end);
        cursor = end + 1;
      }
    } else {
      const match = raw.slice(cursor).match(/^[A-Za-z0-9_-]+/);
      if (match) {
        key = match[0];
        cursor += match[0].length;
      }
    }
    if (key === undefined) return undefined;
    path.push(key);
    whitespace();
    if (cursor === raw.length) return path;
    if (raw[cursor] !== ".") return undefined;
    cursor += 1;
    whitespace();
    if (cursor === raw.length) return undefined;
  }
  return path.length ? path : undefined;
}

function parseHeaderLine(line: string): Pick<TomlTableHeader, "kind" | "path"> | undefined {
  const text = line.trimStart();
  if (!text.startsWith("[")) return undefined;
  const kind: TomlTableHeader["kind"] = text.startsWith("[[") ? "array-table" : "table";
  const openLength = kind === "array-table" ? 2 : 1;
  const close = kind === "array-table" ? "]]" : "]";
  let string: "basic" | "literal" | undefined;
  let closeAt = -1;
  for (let cursor = openLength; cursor < text.length; cursor += 1) {
    if (string === "basic") {
      if (text[cursor] === '\"' && !isEscaped(text, cursor)) string = undefined;
      continue;
    }
    if (string === "literal") {
      if (text[cursor] === "'") string = undefined;
      continue;
    }
    if (text[cursor] === '\"') {
      string = "basic";
      continue;
    }
    if (text[cursor] === "'") {
      string = "literal";
      continue;
    }
    if (text.startsWith(close, cursor)) {
      closeAt = cursor;
      break;
    }
  }
  if (closeAt === -1) return undefined;
  const tail = text.slice(closeAt + close.length);
  if (!/^[ \t]*(?:#.*)?$/.test(tail)) return undefined;
  const path = parseDottedKey(text.slice(openLength, closeAt));
  return path ? { kind, path } : undefined;
}

/**
 * Parse table spans while preserving the original document byte-for-byte.
 * Every table owns content only until the next normal OR array-table header.
 */
export function parseTomlTableHeaders(source: string): TomlTableHeader[] {
  const parsed: Array<Omit<TomlTableHeader, "bodyEnd">> = [];
  let offset = 0;
  let multiline: MultilineString;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const segment = match[0];
    if (!segment) break;
    const line = segment.replace(/(?:\r\n|\n|\r)$/, "");
    if (!multiline) {
      const header = parseHeaderLine(line);
      if (header) {
        parsed.push({
          ...header,
          headerStart: offset,
          bodyStart: offset + segment.length,
        });
      }
    }
    multiline = scanMultilineState(line, multiline);
    offset += segment.length;
  }
  return parsed.map((header, index) => ({
    ...header,
    bodyEnd: parsed[index + 1]?.headerStart ?? source.length,
  }));
}

function ownedBareKeys(source: string, table: TomlTableHeader): Set<string> {
  const keys = new Set<string>();
  let multiline: MultilineString;
  const body = source.slice(table.bodyStart, table.bodyEnd);
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const segment = match[0];
    if (!segment) break;
    const line = segment.replace(/(?:\r\n|\n|\r)$/, "");
    if (!multiline) {
      const assignment = line.match(/^\s*((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))\s*=/);
      if (assignment) {
        const path = parseDottedKey(assignment[1]!);
        if (path?.length === 1) keys.add(path[0]!);
      }
    }
    multiline = scanMultilineState(line, multiline);
  }
  return keys;
}

const TOMLLIB_VALIDATE = String.raw`
import sys

try:
    import tomllib
except Exception as exc:
    sys.stderr.write("TOMLLIB_UNAVAILABLE:" + repr(exc))
    raise SystemExit(2)

try:
    source = sys.stdin.buffer.read().decode("utf-8", errors="strict")
    tomllib.loads(source)
except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
    sys.stderr.write("TOML_INVALID:" + exc.__class__.__name__ + ": " + str(exc))
    raise SystemExit(1)
`;

const TOMLLIB_VALIDATION_TIMEOUT_MS = 5_000;

/**
 * Python's isolated mode ignores PYTHON* settings itself. Removing them from
 * the child environment as well keeps project/operator configuration from even
 * reaching the validator process and makes that boundary independently
 * auditable.
 */
function isolatedPythonEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("PYTHON")),
  );
}

/** Validate the exact bytes with the Python tomllib consumer used by Hermes. */
function assertValidTomlBytes(source: Buffer, label: string): void {
  const validation = spawnSync("python3", ["-I", "-S", "-c", TOMLLIB_VALIDATE], {
    input: source,
    encoding: "utf8",
    env: isolatedPythonEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: TOMLLIB_VALIDATION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (validation.error) {
    const code = (validation.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error(
        `${label} validation timed out after ${TOMLLIB_VALIDATION_TIMEOUT_MS}ms`,
      );
    }
    const missing = code === "ENOENT";
    throw new Error(
      missing
        ? `${label} cannot be validated: python3 with tomllib is required but was not found`
        : `${label} validation failed to start: ${validation.error.message}`,
    );
  }
  if (validation.status === 2 || validation.stderr.startsWith("TOMLLIB_UNAVAILABLE:")) {
    throw new Error(`${label} cannot be validated: python3 with tomllib is required (${validation.stderr.replace(/^TOMLLIB_UNAVAILABLE:/, "")})`);
  }
  if (validation.status !== 0) {
    const detail = validation.stderr.replace(/^TOML_INVALID:/, "").trim() || `python3 exited ${validation.status ?? "without a status"}`;
    throw new Error(`${label} is not valid TOML 1.0 for Python tomllib: ${detail}`);
  }
}

function assertValidToml(source: string, label: string): void {
  assertValidTomlBytes(Buffer.from(source, "utf8"), label);
}

/**
 * Add missing pinned-schema fields without replacing operator values, comments,
 * unknown keys, or richer sections. This is intentionally a small TOML-aware
 * merge rather than a parse/stringify round trip, which would erase comments.
 */
export function mergeHostConfig(existing: string): string {
  assertValidToml(existing, "Existing Hermes template config");
  let merged = existing;
  for (const { section, values } of hostSchema()) {
    const tables = parseTomlTableHeaders(merged);
    const matching = tables.filter((table) => table.kind === "table" && table.path.length === 1 && table.path[0] === section);
    if (matching.length > 1) {
      throw new Error(`Cannot merge [${section}]: config contains duplicate table headers`);
    }
    const table = matching[0];
    if (!table) {
      const incompatible = tables.find((candidate) => candidate.path[0] === section);
      if (incompatible) {
        throw new Error(`Cannot merge [${section}]: config defines ${incompatible.kind === "array-table" ? "an array table" : "a child table"} at [${incompatible.path.join(".")}] without an owning [${section}] table`);
      }
      const prefix = merged.length === 0 ? "" : merged.endsWith("\n") ? "\n" : "\n\n";
      merged += `${prefix}[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
      continue;
    }
    const existingKeys = ownedBareKeys(merged, table);
    const missing = values.filter(([key]) => !existingKeys.has(key));
    if (!missing.length) continue;
    const body = merged.slice(table.bodyStart, table.bodyEnd);
    const addition = `${body.length === 0 || body.endsWith("\n") ? "" : "\n"}${missing.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
    merged = `${merged.slice(0, table.bodyEnd)}${addition}${merged.slice(table.bodyEnd)}`;
  }
  // Text preservation is valuable only while the result remains real TOML.
  // Dotted-key and inline-table ownership forms cannot always be extended by
  // inserting a conventional table/key assignment. Fail before the caller
  // touches disk rather than accepting a corrupt but superficially merged file.
  assertValidToml(merged, "Merged Hermes template config");
  return merged;
}

/**
 * Snapshot of an operator-owned regular config. The identity and content hash
 * are checked again immediately before rename so a concurrent writer cannot be
 * silently overwritten by an additive bootstrap prepared from stale bytes.
 */
interface ConfigSnapshot {
  bytes: Buffer;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  hash: string;
}

function describePathType(stats: Stats): string {
  if (stats.isSymbolicLink()) return "symbolic link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "FIFO";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character device";
  if (stats.isBlockDevice()) return "block device";
  return "non-regular file";
}

/** lstat is the first operation on the config leaf, including the no-force path. */
function inspectConfigPath(path: string): Stats | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe Hermes template config path ${path}: expected a regular file, found ${describePathType(stats)}`);
  }
  return stats;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Open without following a replacement symlink and snapshot exact bytes. */
function readRegularConfigSnapshot(path: string, expected?: Stats): ConfigSnapshot {
  const before = inspectConfigPath(path);
  if (!before) throw new Error(`Hermes template config disappeared before it could be read: ${path}`);
  if (expected && (before.dev !== expected.dev || before.ino !== expected.ino)) {
    throw new Error(`Hermes template config changed concurrently before it could be read: ${path}`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Hermes template config changed type or identity while opening: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Hermes template config changed while it was being read: ${path}`);
    }
    return {
      bytes,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      hash: hashBytes(bytes),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertConfigUnchanged(path: string, previous: ConfigSnapshot | undefined): void {
  if (!previous) {
    if (inspectConfigPath(path)) {
      throw new Error(`Hermes template config appeared concurrently before installation: ${path}`);
    }
    return;
  }
  const current = readRegularConfigSnapshot(path);
  if (current.dev !== previous.dev || current.ino !== previous.ino || current.hash !== previous.hash) {
    throw new Error(`Hermes template config changed concurrently; refusing to overwrite operator changes: ${path}`);
  }
}

const CONFIG_TRANSACTION_PREFIX = ".pjangler-config-txn-";
const CONFIG_LOCK_NAME = ".pjangler-config.lock";
const CONFIG_LOCK_WAIT_MS = 10_000;
const CONFIG_LOCK_READY = "PJANGLER_CONFIG_LOCKED";
const TRANSACTION_CANDIDATE = "candidate.toml";
const TRANSACTION_OPERATOR_FILE = "operator-config";
const TRANSACTION_STATE = "state.json";
const TRANSACTION_STATE_NEXT = "state-next.json";

interface ConfigIdentity {
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  hash: string;
}

interface ConfigTransactionMarker {
  version: 1;
  ownerPid: number;
  phase: "prepared" | "committed";
  hadPrevious: boolean;
  candidate: ConfigIdentity;
  previous?: ConfigIdentity;
}

function snapshotIdentity(snapshot: ConfigSnapshot): ConfigIdentity {
  return {
    dev: snapshot.dev,
    ino: snapshot.ino,
    mode: snapshot.mode,
    mtimeMs: snapshot.mtimeMs,
    hash: snapshot.hash,
  };
}

function sameIdentity(actual: ConfigSnapshot | Stats, expected: ConfigIdentity | ConfigSnapshot | Stats): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function assertSnapshotIdentity(actual: ConfigSnapshot, expected: ConfigIdentity | ConfigSnapshot, label: string): void {
  if (
    !sameIdentity(actual, expected) ||
    actual.mode !== expected.mode ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.hash !== expected.hash
  ) {
    throw new Error(`${label} identity, mode, mtime, or bytes differ from the protected operator file`);
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OpenConfigLock {
  descriptor: number;
  path: string;
  identity: Stats;
}

function openConfigLock(path: string): OpenConfigLock {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, CONFIG_LOCK_NAME);
  let existing: Stats | undefined;
  try {
    existing = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Unsafe Hermes config lock ${lockPath}: expected a regular non-symlink file`);
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_CREAT |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      0o600,
    );
  } catch (error) {
    throw new Error(`Cannot safely open Hermes config lock ${lockPath}: ${errorDetail(error)}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size !== 0 ||
      (stats.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) {
      throw new Error(`Unsafe Hermes config lock ${lockPath}: expected an owned, empty, single-link regular file with private mode`);
    }
    return { descriptor, path: lockPath, identity: stats };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertConfigLockPath(lock: OpenConfigLock): void {
  let current: Stats;
  try {
    current = lstatSync(lock.path);
  } catch (error) {
    throw new Error(`Hermes config lock path disappeared after acquisition: ${lock.path}`, { cause: error });
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== lock.identity.dev ||
    current.ino !== lock.identity.ino ||
    current.nlink !== 1 ||
    current.size !== 0 ||
    (current.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && current.uid !== process.getuid())
  ) {
    throw new Error(`Hermes config lock path changed identity or safety properties during acquisition: ${lock.path}`);
  }
}

function stopConfigLockHolder(holder: ChildProcessWithoutNullStreams): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const killTimer = setTimeout(() => holder.kill("SIGKILL"), 2_000);
    const failureTimer = setTimeout(() => {
      reject(new Error("Hermes config lock holder did not exit after SIGKILL"));
    }, 4_000);
    holder.once("exit", () => {
      clearTimeout(killTimer);
      clearTimeout(failureTimer);
      resolve();
    });
    holder.stdin.end();
  });
}

/**
 * Hold the kernel lock on a descriptor opened by this process with O_NOFOLLOW.
 * The trusted holder inherits that descriptor as fd 3 and lives only while its
 * stdin pipe is open. Kernel ownership, rather than a PID marker, makes process
 * death and PID reuse safe without deleting or replacing another writer's lock.
 */
async function acquireConfigLock(path: string): Promise<() => Promise<void>> {
  const lock = openConfigLock(path);
  let holder: ChildProcessWithoutNullStreams;
  try {
    holder = spawn(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--wait",
        String(CONFIG_LOCK_WAIT_MS / 1_000),
        "/proc/self/fd/3",
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(`${CONFIG_LOCK_READY}\n`)}); process.stdin.resume();`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe", lock.descriptor],
      },
    ) as ChildProcessWithoutNullStreams;
  } catch (error) {
    closeSync(lock.descriptor);
    throw new Error(`Failed to start the Hermes config lock holder: ${errorDetail(error)}`, { cause: error });
  }
  closeSync(lock.descriptor);

  let stderr = "";
  holder.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
  });
  holder.stdin.on("error", () => {
    // An early holder exit is reported by the exit listener below.
  });

  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let stdout = "";
    const timeout = setTimeout(() => {
      holder.kill("SIGKILL");
      reject(new Error(`Timed out waiting ${CONFIG_LOCK_WAIT_MS}ms for the Hermes config lock`));
    }, CONFIG_LOCK_WAIT_MS + 1_000);
    holder.once("error", (error) => {
      if (ready) return;
      clearTimeout(timeout);
      reject(new Error(`Hermes config lock holder failed to start: ${error.message}`, { cause: error }));
    });
    holder.once("exit", (code, signal) => {
      if (ready) return;
      clearTimeout(timeout);
      const detail = stderr.trim();
      reject(new Error(
        code === 1
          ? `Timed out waiting ${CONFIG_LOCK_WAIT_MS}ms for the Hermes config lock`
          : `Hermes config lock holder exited before acquisition (code=${code ?? "none"}, signal=${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
      ));
    });
    holder.stdout.on("data", (chunk: Buffer) => {
      if (ready) return;
      stdout += chunk.toString("utf8");
      if (!stdout.includes(`${CONFIG_LOCK_READY}\n`)) return;
      ready = true;
      clearTimeout(timeout);
      resolve();
    });
  });

  try {
    assertConfigLockPath(lock);
  } catch (error) {
    await stopConfigLockHolder(holder);
    throw error;
  }

  return () => stopConfigLockHolder(holder);
}

function writeTransactionMarker(directory: string, marker: ConfigTransactionMarker): void {
  const nextPath = join(directory, TRANSACTION_STATE_NEXT);
  const statePath = join(directory, TRANSACTION_STATE);
  writeFileSync(nextPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(nextPath, statePath);
}

function readTransactionMarker(directory: string): ConfigTransactionMarker {
  const parsed = JSON.parse(readFileSync(join(directory, TRANSACTION_STATE), "utf8")) as Partial<ConfigTransactionMarker>;
  const identityValid = (identity: ConfigIdentity | undefined): identity is ConfigIdentity => Boolean(
    identity &&
    [identity.dev, identity.ino, identity.mode, identity.mtimeMs].every(Number.isFinite) &&
    typeof identity.hash === "string" &&
    /^[0-9a-f]{64}$/.test(identity.hash),
  );
  if (
    parsed.version !== 1 ||
    !Number.isInteger(parsed.ownerPid) ||
    (parsed.phase !== "prepared" && parsed.phase !== "committed") ||
    typeof parsed.hadPrevious !== "boolean" ||
    !identityValid(parsed.candidate) ||
    (parsed.hadPrevious && !identityValid(parsed.previous))
  ) {
    throw new Error("transaction state is missing or invalid");
  }
  return parsed as ConfigTransactionMarker;
}

function inspectTransactionFile(path: string, label: string): Stats | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return stats;
}

/**
 * Recover conservative rollback state left by process death. Transaction
 * directories contain only a 0600 candidate, a hard link to the operator's
 * existing inode, and non-secret identity metadata; all are same-filesystem.
 * Live recovery is called only while holding CONFIG_LOCK_NAME, so every prior
 * PID marker is stale even if that numeric PID has since been reused.
 */
function recoverInterruptedConfigTransactions(path: string, allowMutation: boolean): void {
  const directory = dirname(path);
  if (!existsSync(directory)) return;
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(CONFIG_TRANSACTION_PREFIX)) continue;
    const match = entry.name.match(/^\.pjangler-config-txn-(\d+)-[A-Za-z0-9]+$/);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsafe or malformed Hermes config transaction artifact: ${entry.name}`);
    }
    const transactionDirectory = join(directory, entry.name);
    const transactionStats = lstatSync(transactionDirectory);
    if (
      typeof process.getuid === "function" &&
      transactionStats.uid !== process.getuid()
    ) {
      throw new Error(`Hermes config transaction artifact is owned by another user: ${entry.name}`);
    }
    if (!allowMutation) {
      throw new Error(`interrupted Hermes config transaction requires live recovery before dry-run: ${entry.name}`);
    }

    const allowed = new Set([
      TRANSACTION_CANDIDATE,
      TRANSACTION_OPERATOR_FILE,
      TRANSACTION_STATE,
      TRANSACTION_STATE_NEXT,
    ]);
    const unknown = readdirSync(transactionDirectory).filter((name) => !allowed.has(name));
    if (unknown.length) {
      throw new Error(`Hermes config transaction contains unexpected entries: ${unknown.join(", ")}`);
    }

    const candidatePath = join(transactionDirectory, TRANSACTION_CANDIDATE);
    const operatorPath = join(transactionDirectory, TRANSACTION_OPERATOR_FILE);
    const candidateStats = inspectTransactionFile(candidatePath, "Transaction candidate");
    const operatorStats = inspectTransactionFile(operatorPath, "Protected operator config");
    let marker: ConfigTransactionMarker | undefined;
    let markerError: unknown;
    try {
      marker = readTransactionMarker(transactionDirectory);
    } catch (error) {
      markerError = error;
    }

    if (marker?.phase === "committed") {
      const installed = readRegularConfigSnapshot(path);
      assertSnapshotIdentity(installed, marker.candidate, "Committed Hermes config");
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    // A protected operator inode is authoritative even if the marker was torn.
    // Restore it before parsing, hashing, validating, or removing anything else.
    if (operatorStats) {
      const currentStats = inspectConfigPath(path);
      if (currentStats && sameIdentity(currentStats, operatorStats) && candidateStats) {
        // The process died after linking the original but before installing the
        // candidate. Removing the extra link preserves the already-live inode.
        unlinkSync(operatorPath);
      } else {
        renameSync(operatorPath, path);
      }
      const restored = readRegularConfigSnapshot(path);
      if (marker?.previous) assertSnapshotIdentity(restored, marker.previous, "Recovered Hermes config");
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    if (candidateStats) {
      // Candidate still inside the transaction means no rename occurred.
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    if (!marker && readdirSync(transactionDirectory).length === 0) {
      // A process can die between mkdtemp/chmod and the first candidate write.
      // An empty, correctly named, same-user transaction contains no state to
      // restore and is safe to remove. Non-empty malformed state remains a
      // hard failure so recovery never guesses about a canonical config.
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    if (!marker) {
      throw new Error(`cannot safely recover Hermes config transaction: ${errorDetail(markerError)}`);
    }
    if (marker.hadPrevious) {
      const restored = readRegularConfigSnapshot(path);
      assertSnapshotIdentity(restored, marker.previous!, "Previously restored Hermes config");
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    const installed = inspectConfigPath(path);
    if (installed) {
      const installedSnapshot = readRegularConfigSnapshot(path, installed);
      assertSnapshotIdentity(installedSnapshot, marker.candidate, "Interrupted new Hermes config");
      unlinkSync(path);
    }
    rmSync(transactionDirectory, { recursive: true, force: true });
  }
}

/**
 * Replace one config atomically and prove the exact installed bytes parse. An
 * existing config is hard-linked into a protected 0700 transaction directory
 * before the candidate rename. Any post-install failure first atomically puts
 * that exact inode back; validator availability can never gate restoration.
 */
function installValidatedConfig(path: string, next: string, previous: ConfigSnapshot | undefined): void {
  const nextBytes = Buffer.from(next, "utf8");
  assertValidTomlBytes(nextBytes, "Rendered Hermes template config");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const transactionDirectory = mkdtempSync(join(directory, `${CONFIG_TRANSACTION_PREFIX}${process.pid}-`));
  chmodSync(transactionDirectory, 0o700);
  const stagedPath = join(transactionDirectory, TRANSACTION_CANDIDATE);
  const operatorPath = join(transactionDirectory, TRANSACTION_OPERATOR_FILE);
  let installed = false;
  let operatorArtifactHoldsOriginal = false;
  let retainTransactionForRecovery = false;
  let failure: unknown;
  try {
    const mode = previous?.mode ?? 0o600;
    writeFileSync(stagedPath, nextBytes, { mode });
    const staged = readFileSync(stagedPath);
    if (!staged.equals(nextBytes)) throw new Error("Staged Hermes template config bytes changed before installation");
    assertValidTomlBytes(staged, "Staged Hermes template config");
    const stagedSnapshot = readRegularConfigSnapshot(stagedPath);

    const marker: ConfigTransactionMarker = {
      version: 1,
      ownerPid: process.pid,
      phase: "prepared",
      hadPrevious: previous !== undefined,
      candidate: snapshotIdentity(stagedSnapshot),
      previous: previous ? snapshotIdentity(previous) : undefined,
    };
    writeTransactionMarker(transactionDirectory, marker);

    assertConfigUnchanged(path, previous);

    if (previous) {
      linkSync(path, operatorPath);
      operatorArtifactHoldsOriginal = true;
      const protectedOriginal = readRegularConfigSnapshot(operatorPath);
      assertSnapshotIdentity(protectedOriginal, previous, "Protected Hermes config");
    }

    renameSync(stagedPath, path);
    installed = true;
    const written = readRegularConfigSnapshot(path);
    if (!written.bytes.equals(nextBytes)) throw new Error("Installed Hermes template config bytes differ from the validated candidate");
    assertValidTomlBytes(written.bytes, "Installed Hermes template config");
    assertSnapshotIdentity(written, marker.candidate, "Installed Hermes config");

    // Commit metadata before releasing the original inode. A process death
    // after this point keeps the validated candidate; recovery only cleans the
    // remaining protected link/metadata.
    writeTransactionMarker(transactionDirectory, { ...marker, phase: "committed" });
    if (operatorArtifactHoldsOriginal) {
      unlinkSync(operatorPath);
      operatorArtifactHoldsOriginal = false;
    }
  } catch (error) {
    const primary = errorDetail(error);
    let restorationError: unknown;
    let verificationError: unknown;
    let finalState: "unchanged" | "restored" | "removed" | "unknown" = installed ? "unknown" : "unchanged";

    // Restoration/removal is deliberately the first post-failure operation.
    // In particular, do not invoke the validator that just failed until the
    // operator's original inode is already back at the canonical path.
    if (installed) {
      try {
        if (previous && operatorArtifactHoldsOriginal) {
          renameSync(operatorPath, path);
          operatorArtifactHoldsOriginal = false;
          installed = false;
          finalState = "restored";
        } else if (previous === undefined) {
          unlinkSync(path);
          installed = false;
          finalState = "removed";
        } else {
          throw new Error("protected operator inode is unavailable");
        }
      } catch (restoreFailure) {
        restorationError = restoreFailure;
      }
    } else if (operatorArtifactHoldsOriginal) {
      try {
        // Candidate was never installed; remove only the extra hard link.
        unlinkSync(operatorPath);
        operatorArtifactHoldsOriginal = false;
      } catch (cleanupFailure) {
        restorationError = cleanupFailure;
      }
    }

    if (!restorationError && finalState === "restored" && previous) {
      try {
        const restored = readRegularConfigSnapshot(path);
        assertSnapshotIdentity(restored, previous, "Restored Hermes config");
        // Best-effort consumer verification happens only after exact restoration.
        assertValidTomlBytes(restored.bytes, "Post-restore Hermes template config");
      } catch (postRestoreFailure) {
        verificationError = postRestoreFailure;
      }
    }

    if (restorationError) {
      retainTransactionForRecovery = true;
      failure = new Error(
        `${primary}; restoring the operator's original Hermes config failed: ${errorDetail(restorationError)}; protected transaction state was retained for automatic recovery`,
        { cause: new AggregateError([error, restorationError], "Hermes config installation and restoration both failed") },
      );
    } else if (verificationError) {
      failure = new Error(
        `${primary}; the operator's original Hermes config was restored before post-restore verification failed: ${errorDetail(verificationError)}`,
        { cause: new AggregateError([error, verificationError], "Hermes config installation and post-restore verification both failed") },
      );
    } else if (finalState === "restored") {
      failure = new Error(`${primary}; the operator's original Hermes config was restored`, { cause: error });
    } else if (finalState === "removed") {
      failure = new Error(`${primary}; the unverified newly-created Hermes config was removed`, { cause: error });
    } else {
      failure = new Error(`${primary}; no Hermes config changes were applied`, { cause: error });
    }
  }

  let cleanupError: unknown;
  if (!operatorArtifactHoldsOriginal && !retainTransactionForRecovery) {
    try {
      rmSync(transactionDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    const base = failure
      ? errorDetail(failure)
      : "Hermes config was installed and validated";
    throw new Error(
      `${base}; transaction metadata cleanup failed and will be retried on the next invocation: ${errorDetail(cleanupError)}`,
      {
        cause: new AggregateError(
          failure ? [failure, cleanupError] : [cleanupError],
          "Hermes config transaction cleanup failed",
        ),
      },
    );
  }
  if (failure) {
    throw failure;
  }
}

/** Bootstrap or non-destructively upgrade the pinned Hermes template config. */
export class EnsureTemplateConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.deferredExternalEffects && !ctx.applyingDeferredHostEffects) {
      return {
        success: true,
        outcome: "unchanged",
        message: "Hermes host config deferred until rendered lifecycle eligibility passes",
      };
    }
    const path = resolveTemplateConfigPath();
    if (ctx.dryRun) return this.invokeLocked(ctx, path);

    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireConfigLock(path);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to acquire the whole-window Hermes config lock for ${path}: ${errorDetail(error)}`,
      };
    }
    let result: InvokeResult;
    try {
      result = this.invokeLocked(ctx, path);
    } catch (error) {
      try {
        await release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Hermes config operation threw and its kernel lock holder also failed to exit: ${errorDetail(error)}; ${errorDetail(releaseError)}`,
        );
      }
      throw error;
    }
    try {
      await release();
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        filePath: result.filePath,
        message: `${result.message}; Hermes config lock release failed after the reported operation: ${errorDetail(error)}; no success is claimed`,
      };
    }
    return result;
  }

  private invokeLocked(ctx: HermesAgentContext, path: string): InvokeResult {
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    try {
      recoverInterruptedConfigTransactions(path, !ctx.dryRun);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to recover interrupted Hermes config transaction for ${path}: ${errorDetail(error)}`,
      };
    }
    let pathStats: Stats | undefined;
    try {
      pathStats = inspectConfigPath(path);
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to inspect ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const exists = pathStats !== undefined;
    if (exists && !force) {
      return { success: true, outcome: "unchanged", message: `Config present: ${path}` };
    }

    let next = renderHostConfig();
    let current = "";
    let previous: ConfigSnapshot | undefined;
    try {
      if (exists) {
        previous = readRegularConfigSnapshot(path, pathStats);
        assertValidTomlBytes(previous.bytes, "Existing Hermes template config");
        current = previous.bytes.toString("utf8");
        next = mergeHostConfig(current);
      } else {
        assertValidToml(next, "Rendered Hermes template config");
      }
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to prepare ${path}; no changes were applied: ${errorDetail(error)}` };
    }
    if (exists && next === current) {
      return { success: true, outcome: "unchanged", message: `Config schema already current: ${path}` };
    }
    if (ctx.dryRun) {
      return {
        success: true,
        outcome: "planned",
        filePath: path,
        message: `[DRY RUN] Would ${exists ? "merge missing schema fields into" : "create"} config: ${path}`,
      };
    }

    try {
      installValidatedConfig(path, next, previous);
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to write ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return {
      success: true,
      outcome: "changed",
      filePath: path,
      message: `${exists ? "Updated" : "Bootstrapped"} config without replacing existing values: ${path}`,
    };
  }
}
