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
import { basename, join, dirname } from "node:path";
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
  nlink: number;
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
      nlink: opened.nlink,
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
  assertSnapshotIdentity(current, previous, `Hermes template config changed concurrently at ${path}`);
  assertLinkCount(current, 1, `Hermes template config at ${path}`);
}

const CONFIG_TRANSACTION_PREFIX = ".pjangler-config-txn-";
const CONFIG_LOCK_NAME = ".pjangler-config.lock";
const CONFIG_LOCK_WAIT_MS = 10_000;
const CONFIG_LOCK_READY = "PJANGLER_CONFIG_LOCKED";
const TRANSACTION_CANDIDATE = "candidate.toml";
const TRANSACTION_OPERATOR_FILE = "operator-config";
const TRANSACTION_STATE = "state.json";
const TRANSACTION_STATE_NEXT = "state-next.json";
const ATOMIC_RENAME_PYTHON = "/usr/bin/python3";
const ATOMIC_RENAME_TIMEOUT_MS = 5_000;

const RENAMEAT2_HELPER = String.raw`
# PJANGLER_RENAMEAT2_HELPER
import ctypes
import os
import sys

RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2

if len(sys.argv) != 4 or sys.argv[1] not in ("exchange", "noreplace"):
    sys.stderr.write("invalid renameat2 invocation")
    raise SystemExit(2)

mode, source, target = sys.argv[1:]
for value in (source, target):
    parts = value.split("/")
    if not value or value.startswith("/") or any(part in ("", ".", "..") for part in parts) or "\\x00" in value:
        sys.stderr.write("unsafe relative renameat2 path")
        raise SystemExit(2)

libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    sys.stderr.write("renameat2 unavailable")
    raise SystemExit(3)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
flags = RENAME_EXCHANGE if mode == "exchange" else RENAME_NOREPLACE
result = renameat2(3, os.fsencode(source), 3, os.fsencode(target), flags)
if result != 0:
    error = ctypes.get_errno()
    sys.stderr.write("renameat2 failed: " + os.strerror(error))
    raise SystemExit(4)
`;

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
  phase:
    | "prepared"
    | "install-exchange"
    | "installed"
    | "committed"
    | "rollback-exchange"
    | "rollback-capture"
    | "conflict";
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
    throw new Error(`${label}: identity, mode, mtime, or bytes differ from the expected snapshot`);
  }
}

function assertLinkCount(actual: ConfigSnapshot | Stats, expected: number, label: string): void {
  if (actual.nlink !== expected) {
    throw new Error(`${label} has unsafe link count ${actual.nlink}; expected exactly ${expected}`);
  }
}

interface OpenConfigDirectory {
  descriptor: number;
  path: string;
  identity: Stats;
}

function openConfigDirectory(path: string): OpenConfigDirectory {
  const directory = dirname(path);
  const before = lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Unsafe Hermes config directory ${directory}: expected a non-symlink directory`);
  }
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Hermes config directory changed identity while opening: ${directory}`);
    }
    return { descriptor, path: directory, identity: opened };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertConfigDirectoryPath(directory: OpenConfigDirectory): void {
  const current = lstatSync(directory.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== directory.identity.dev ||
    current.ino !== directory.identity.ino
  ) {
    throw new Error(`Hermes config directory changed identity during atomic installation: ${directory.path}`);
  }
}

function trustedAtomicRenamePython(): string {
  if (platform() !== "linux") {
    throw new Error("Atomic Hermes config installation requires Linux renameat2 support");
  }
  let resolved: string;
  try {
    resolved = realpathSync(ATOMIC_RENAME_PYTHON);
  } catch (error) {
    throw new Error(`Atomic Hermes config installation requires ${ATOMIC_RENAME_PYTHON}`, { cause: error });
  }
  const stats = lstatSync(resolved);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (typeof stats.uid === "number" && stats.uid !== 0) ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(`Unsafe atomic rename helper interpreter: ${resolved}`);
  }
  return resolved;
}

function assertSafeRelativeRenamePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe relative path for atomic Hermes config rename: ${JSON.stringify(path)}`);
  }
}

class AtomicRenameOutcomeUnknown extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AtomicRenameOutcomeUnknown";
  }
}

/**
 * Invoke Linux renameat2 against a verified inherited parent dirfd. The fixed,
 * root-owned isolated interpreter cannot import project/PYTHONPATH code, and
 * the syscall is bounded so helper failure never degrades to plain rename.
 */
function atomicRenameAt2(
  configPath: string,
  source: string,
  target: string,
  mode: "exchange" | "noreplace",
): void {
  assertSafeRelativeRenamePath(source);
  assertSafeRelativeRenamePath(target);
  const directory = openConfigDirectory(configPath);
  try {
    assertConfigDirectoryPath(directory);
    let helper: ReturnType<typeof spawnSync>;
    try {
      helper = spawnSync(
        trustedAtomicRenamePython(),
        ["-I", "-S", "-c", RENAMEAT2_HELPER, mode, source, target],
        {
          cwd: "/",
          encoding: "utf8",
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          maxBuffer: 64 * 1024,
          timeout: ATOMIC_RENAME_TIMEOUT_MS,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe", directory.descriptor],
        },
      );
    } catch (error) {
      throw new Error(`Atomic Hermes config ${mode} helper failed before invocation: ${errorDetail(error)}`, { cause: error });
    }
    if (helper.error) {
      const code = (helper.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        throw new AtomicRenameOutcomeUnknown(
          `Atomic Hermes config ${mode} timed out after ${ATOMIC_RENAME_TIMEOUT_MS}ms; syscall completion is unknown`,
          helper.error,
        );
      }
      throw new Error(`Atomic Hermes config ${mode} helper failed to start: ${helper.error.message}`, { cause: helper.error });
    }
    if (helper.status !== 0) {
      throw new Error(
        `Atomic Hermes config ${mode} failed: ${String(helper.stderr).trim() || `helper exited ${helper.status ?? "without a status"}`}`,
      );
    }
    try {
      assertConfigDirectoryPath(directory);
    } catch (error) {
      throw new AtomicRenameOutcomeUnknown(
        `Atomic Hermes config ${mode} completed against an inherited directory whose canonical pathname then changed`,
        error,
      );
    }
  } finally {
    closeSync(directory.descriptor);
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
    ![
      "prepared",
      "install-exchange",
      "installed",
      "committed",
      "rollback-exchange",
      "rollback-capture",
      "conflict",
    ].includes(parsed.phase ?? "") ||
    typeof parsed.hadPrevious !== "boolean" ||
    !identityValid(parsed.candidate) ||
    (parsed.hadPrevious && !identityValid(parsed.previous))
  ) {
    throw new Error("transaction state is missing or invalid");
  }
  return parsed as ConfigTransactionMarker;
}

function manualRecoveryError(directory: string, detail: string, cause?: unknown): Error {
  return new Error(
    `${detail}; the canonical Hermes config was preserved and protected transaction ${directory} was retained for manual recovery`,
    cause === undefined ? undefined : { cause },
  );
}

class AtomicConfigConflict extends Error {
  readonly canonicalPreserved: boolean;

  constructor(message: string, canonicalPreserved: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AtomicConfigConflict";
    this.canonicalPreserved = canonicalPreserved;
  }
}

function markTransactionConflict(directory: string, marker: ConfigTransactionMarker): unknown | undefined {
  try {
    writeTransactionMarker(directory, { ...marker, phase: "conflict" });
    return undefined;
  } catch (error) {
    return error;
  }
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
    const candidateRelative = `${entry.name}/${TRANSACTION_CANDIDATE}`;
    const operatorRelative = `${entry.name}/${TRANSACTION_OPERATOR_FILE}`;
    const configRelative = basename(path);
    const candidateStats = inspectTransactionFile(candidatePath, "Transaction candidate");
    const operatorStats = inspectTransactionFile(operatorPath, "Protected operator config");
    let marker: ConfigTransactionMarker | undefined;
    let markerError: unknown;
    try {
      marker = readTransactionMarker(transactionDirectory);
    } catch (error) {
      markerError = error;
    }

    if (marker?.phase === "conflict") {
      throw manualRecoveryError(
        transactionDirectory,
        "A prior Hermes config transaction recorded a concurrent canonical-path conflict",
      );
    }

    if (marker?.phase === "committed") {
      try {
        const installed = readRegularConfigSnapshot(path);
        assertSnapshotIdentity(installed, marker.candidate, "Committed Hermes config");
        assertLinkCount(installed, 1, "Committed Hermes config");
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Committed Hermes config no longer owns the canonical path: ${errorDetail(error)}`,
          error,
        );
      }
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    if (marker?.phase === "rollback-exchange" && operatorStats && marker.previous) {
      let canonicalAfterRollback: ConfigSnapshot;
      let capturedCandidate: ConfigSnapshot;
      try {
        canonicalAfterRollback = readRegularConfigSnapshot(path);
        capturedCandidate = readRegularConfigSnapshot(operatorPath, operatorStats);
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Interrupted rollback exchange cannot be inspected safely: ${errorDetail(error)}`,
          error,
        );
      }
      const exchangeCompleted = (() => {
        try {
          assertSnapshotIdentity(canonicalAfterRollback, marker.previous!, "Canonical config after interrupted rollback exchange");
          assertLinkCount(canonicalAfterRollback, 1, "Canonical config after interrupted rollback exchange");
          assertSnapshotIdentity(capturedCandidate, marker.candidate, "Candidate captured by interrupted rollback exchange");
          assertLinkCount(capturedCandidate, 1, "Candidate captured by interrupted rollback exchange");
          return true;
        } catch {
          return false;
        }
      })();
      if (exchangeCompleted) {
        unlinkSync(operatorPath);
        rmSync(transactionDirectory, { recursive: true, force: true });
        continue;
      }
      // Pre-syscall rollback intent remains canonical=candidate and
      // operator=previous; the ordinary installed rollback path below can
      // safely perform the exchange. Any third state is refused there.
    }

    if (operatorStats) {
      if (!marker || !marker.hadPrevious || !marker.previous) {
        throw manualRecoveryError(
          transactionDirectory,
          `Protected operator config exists but transaction metadata is torn or incomplete: ${errorDetail(markerError)}`,
          markerError,
        );
      }

      let protectedOriginal: ConfigSnapshot;
      try {
        protectedOriginal = readRegularConfigSnapshot(operatorPath, operatorStats);
        assertSnapshotIdentity(protectedOriginal, marker.previous, "Protected operator config");
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Protected operator config cannot be proven unchanged: ${errorDetail(error)}`,
          error,
        );
      }

      let canonical: ConfigSnapshot;
      try {
        canonical = readRegularConfigSnapshot(path);
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Canonical Hermes config cannot be safely inspected before recovery: ${errorDetail(error)}`,
          error,
        );
      }

      if (candidateStats) {
        const stagedEntry = readRegularConfigSnapshot(candidatePath, candidateStats);
        const isCompletedInstallExchange = (() => {
          if (marker.phase !== "install-exchange") return false;
          try {
            assertSnapshotIdentity(canonical, marker.candidate, "Canonical candidate after interrupted install exchange");
            assertLinkCount(canonical, 1, "Canonical candidate after interrupted install exchange");
            assertSnapshotIdentity(stagedEntry, marker.previous!, "Displaced original after interrupted install exchange");
            assertSnapshotIdentity(protectedOriginal, marker.previous!, "Protected original after interrupted install exchange");
            if (!sameIdentity(stagedEntry, protectedOriginal)) {
              throw new Error("displaced and protected originals are different inodes");
            }
            assertLinkCount(stagedEntry, 2, "Displaced original after interrupted install exchange");
            assertLinkCount(protectedOriginal, 2, "Protected original after interrupted install exchange");
            return true;
          } catch {
            return false;
          }
        })();

        if (isCompletedInstallExchange) {
          let reverseExchanged = false;
          let displacedCanonical: ConfigSnapshot | undefined;
          try {
            // Reverse the exact uncommitted install. If the canonical entry
            // raced after the pre-read, EXCHANGE captures it at stagedPath and
            // the verification failure below exchanges it back.
            atomicRenameAt2(path, candidateRelative, configRelative, "exchange");
            reverseExchanged = true;
            const restoredCanonical = readRegularConfigSnapshot(path);
            displacedCanonical = readRegularConfigSnapshot(candidatePath);
            const stillProtected = readRegularConfigSnapshot(operatorPath);
            assertSnapshotIdentity(restoredCanonical, marker.previous!, "Canonical original after interrupted install reversal");
            assertSnapshotIdentity(stillProtected, marker.previous!, "Protected original after interrupted install reversal");
            if (!sameIdentity(restoredCanonical, stillProtected)) {
              throw new Error("restored and protected originals are different inodes");
            }
            assertLinkCount(restoredCanonical, 2, "Canonical original after interrupted install reversal");
            assertLinkCount(stillProtected, 2, "Protected original after interrupted install reversal");
            assertSnapshotIdentity(displacedCanonical, marker.candidate, "Candidate captured by interrupted install reversal");
            assertLinkCount(displacedCanonical, 1, "Candidate captured by interrupted install reversal");
            unlinkSync(candidatePath);
            unlinkSync(operatorPath);
            reverseExchanged = false;
            const released = readRegularConfigSnapshot(path);
            assertSnapshotIdentity(released, marker.previous!, "Recovered original after interrupted install reversal");
            assertLinkCount(released, 1, "Recovered original after interrupted install reversal");
            rmSync(transactionDirectory, { recursive: true, force: true });
            continue;
          } catch (error) {
            if (reverseExchanged) {
              let reverseError: unknown;
              let reverseVerificationError: unknown;
              try {
                atomicRenameAt2(path, candidateRelative, configRelative, "exchange");
                reverseExchanged = false;
                if (displacedCanonical) {
                  const preservedCanonical = readRegularConfigSnapshot(path);
                  const retainedDisplaced = readRegularConfigSnapshot(candidatePath);
                  assertSnapshotIdentity(preservedCanonical, displacedCanonical, "Canonical config after reversed recovery exchange");
                  assertLinkCount(preservedCanonical, 1, "Canonical config after reversed recovery exchange");
                  assertSnapshotIdentity(retainedDisplaced, marker.previous!, "Displaced original after reversed recovery exchange");
                }
              } catch (reverseFailure) {
                if (reverseExchanged) reverseError = reverseFailure;
                else reverseVerificationError = reverseFailure;
              }
              const detail = `Interrupted install exchange could not be reversed safely: ${errorDetail(error)}${reverseError ? `; restoring the captured canonical entry failed: ${errorDetail(reverseError)}` : ""}${reverseVerificationError ? `; restored state could not be verified: ${errorDetail(reverseVerificationError)}` : ""}`;
              if (!reverseExchanged && displacedCanonical && !reverseVerificationError) {
                throw manualRecoveryError(transactionDirectory, detail, error);
              }
              throw new Error(
                `${detail}; no captured config artifact was discarded and protected transaction ${transactionDirectory} was retained for manual recovery, but the canonical path could not be proven unchanged`,
                { cause: error },
              );
            }
            throw manualRecoveryError(
              transactionDirectory,
              `Interrupted install exchange could not be finalized safely: ${errorDetail(error)}`,
              error,
            );
          }
        }

        try {
          assertSnapshotIdentity(stagedEntry, marker.candidate, "Staged transaction candidate");
          assertLinkCount(stagedEntry, 1, "Staged transaction candidate");
          if (!sameIdentity(canonical, protectedOriginal)) {
            throw new Error("canonical path no longer references the protected operator inode");
          }
          assertSnapshotIdentity(canonical, marker.previous, "Canonical operator config before recovery cleanup");
          assertLinkCount(canonical, 2, "Canonical operator config before recovery cleanup");
          assertLinkCount(protectedOriginal, 2, "Protected operator config before recovery cleanup");
          unlinkSync(operatorPath);
          const released = readRegularConfigSnapshot(path);
          assertSnapshotIdentity(released, marker.previous, "Recovered operator config");
          assertLinkCount(released, 1, "Recovered operator config");
        } catch (error) {
          throw manualRecoveryError(
            transactionDirectory,
            `Pre-install Hermes transaction cannot be cleaned safely: ${errorDetail(error)}`,
            error,
          );
        }
        rmSync(transactionDirectory, { recursive: true, force: true });
        continue;
      }

      if (sameIdentity(canonical, protectedOriginal)) {
        try {
          assertSnapshotIdentity(canonical, marker.previous, "Previously restored Hermes config");
          assertLinkCount(canonical, 2, "Previously restored Hermes config");
          assertLinkCount(protectedOriginal, 2, "Protected operator config after prior restoration");
          unlinkSync(operatorPath);
          const released = readRegularConfigSnapshot(path);
          assertSnapshotIdentity(released, marker.previous, "Recovered Hermes config");
          assertLinkCount(released, 1, "Recovered Hermes config");
        } catch (error) {
          throw manualRecoveryError(
            transactionDirectory,
            `Previously restored Hermes config cannot be finalized safely: ${errorDetail(error)}`,
            error,
          );
        }
        rmSync(transactionDirectory, { recursive: true, force: true });
        continue;
      }

      let recoveryExchanged = false;
      let displacedCanonical: ConfigSnapshot | undefined;
      try {
        assertSnapshotIdentity(canonical, marker.candidate, "Canonical Hermes config before recovery rollback intent");
        assertLinkCount(canonical, 1, "Canonical Hermes config before recovery rollback intent");
        assertSnapshotIdentity(protectedOriginal, marker.previous, "Protected operator config before recovery rollback intent");
        assertLinkCount(protectedOriginal, 1, "Protected operator config before recovery rollback intent");
        linkSync(operatorPath, candidatePath);
        const rollbackOriginal = readRegularConfigSnapshot(operatorPath);
        const rollbackAlias = readRegularConfigSnapshot(candidatePath);
        if (!sameIdentity(rollbackOriginal, rollbackAlias)) {
          throw new Error("recovery rollback protection links do not reference the same original inode");
        }
        assertLinkCount(rollbackOriginal, 2, "Protected original before recovery rollback exchange");
        assertLinkCount(rollbackAlias, 2, "Protected rollback alias before recovery rollback exchange");
        marker = { ...marker, phase: "rollback-exchange" };
        writeTransactionMarker(transactionDirectory, marker);
        // EXCHANGE captures the live canonical entry before putting the
        // protected original back. Verification happens on both results, so a
        // non-cooperating replacement is exchanged back and retained.
        atomicRenameAt2(path, operatorRelative, configRelative, "exchange");
        recoveryExchanged = true;
        const restored = readRegularConfigSnapshot(path);
        displacedCanonical = readRegularConfigSnapshot(operatorPath);
        const retainedOriginal = readRegularConfigSnapshot(candidatePath);
        assertSnapshotIdentity(restored, marker.previous!, "Recovered Hermes config");
        assertSnapshotIdentity(retainedOriginal, marker.previous!, "Retained original during recovery rollback");
        if (!sameIdentity(restored, retainedOriginal)) {
          throw new Error("recovered and retained originals are different inodes");
        }
        assertLinkCount(restored, 2, "Recovered Hermes config");
        assertLinkCount(retainedOriginal, 2, "Retained original during recovery rollback");
        assertSnapshotIdentity(displacedCanonical, marker.candidate, "Candidate captured during recovery rollback");
        assertLinkCount(displacedCanonical, 1, "Candidate captured during recovery rollback");
        unlinkSync(operatorPath);
        unlinkSync(candidatePath);
        recoveryExchanged = false;
      } catch (error) {
        if (!recoveryExchanged) {
          throw manualRecoveryError(
            transactionDirectory,
            `Atomic recovery rollback failed before it could be verified: ${errorDetail(error)}`,
            error,
          );
        }
        try {
          const liveCanonical = readRegularConfigSnapshot(path);
          assertSnapshotIdentity(liveCanonical, marker.previous!, "Canonical original before reversing failed recovery rollback");
        } catch (concurrentReplacement) {
          throw manualRecoveryError(
            transactionDirectory,
            `Canonical Hermes config changed after recovery rollback exchange and was left in place: ${errorDetail(concurrentReplacement)}`,
            new AggregateError([error, concurrentReplacement], "Recovery rollback and canonical verification both failed"),
          );
        }
        let reverseError: unknown;
        let reverseVerificationError: unknown;
        try {
          atomicRenameAt2(path, operatorRelative, configRelative, "exchange");
          recoveryExchanged = false;
          if (displacedCanonical) {
            const preservedCanonical = readRegularConfigSnapshot(path);
            const retainedOriginal = readRegularConfigSnapshot(operatorPath);
            const retainedOriginalAlias = readRegularConfigSnapshot(candidatePath);
            assertSnapshotIdentity(preservedCanonical, displacedCanonical, "Canonical Hermes config after reversed recovery rollback");
            assertLinkCount(preservedCanonical, 1, "Canonical Hermes config after reversed recovery rollback");
            assertSnapshotIdentity(retainedOriginal, marker.previous!, "Protected original after reversed recovery rollback");
            assertSnapshotIdentity(retainedOriginalAlias, marker.previous!, "Protected original alias after reversed recovery rollback");
            if (!sameIdentity(retainedOriginal, retainedOriginalAlias)) {
              throw new Error("protected recovery rollback links diverged after reverse exchange");
            }
            assertLinkCount(retainedOriginal, 2, "Protected original after reversed recovery rollback");
            assertLinkCount(retainedOriginalAlias, 2, "Protected original alias after reversed recovery rollback");
          }
        } catch (reverseFailure) {
          if (recoveryExchanged) reverseError = reverseFailure;
          else reverseVerificationError = reverseFailure;
        }
        const detail = `Canonical Hermes config was not this transaction's candidate during atomic recovery: ${errorDetail(error)}${reverseError ? `; reversing the exchange failed: ${errorDetail(reverseError)}` : ""}${reverseVerificationError ? `; reversed state could not be verified: ${errorDetail(reverseVerificationError)}` : ""}`;
        if (!recoveryExchanged && displacedCanonical && !reverseVerificationError) {
          throw manualRecoveryError(transactionDirectory, detail, error);
        }
        throw new Error(
          `${detail}; no captured config artifact was discarded and protected transaction ${transactionDirectory} was retained for manual recovery, but the canonical path could not be proven unchanged`,
          { cause: error },
        );
      }
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    if (candidateStats) {
      if (!marker) {
        throw manualRecoveryError(
          transactionDirectory,
          `Staged Hermes config exists but transaction metadata is torn or incomplete: ${errorDetail(markerError)}`,
          markerError,
        );
      }
      let stagedCandidate: ConfigSnapshot;
      try {
        stagedCandidate = readRegularConfigSnapshot(candidatePath, candidateStats);
        assertSnapshotIdentity(stagedCandidate, marker.candidate, "Staged transaction candidate before recovery cleanup");
        assertLinkCount(stagedCandidate, 1, "Staged transaction candidate before recovery cleanup");
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Staged transaction entry is not this transaction's candidate and will not be removed: ${errorDetail(error)}`,
          error,
        );
      }
      // For rollback-capture this means the atomic move completed and captured
      // exactly our candidate. For prepared/install intent it means no install
      // consumed the staged candidate. Either way, only the proven candidate is
      // discarded; an unknown inode is never removed by directory cleanup.
      unlinkSync(candidatePath);
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
      try {
        const restored = readRegularConfigSnapshot(path);
        assertSnapshotIdentity(restored, marker.previous!, "Previously restored Hermes config");
        assertLinkCount(restored, 1, "Previously restored Hermes config");
      } catch (error) {
        throw manualRecoveryError(
          transactionDirectory,
          `Protected original is unavailable and canonical state cannot be proven restored: ${errorDetail(error)}`,
          error,
        );
      }
      rmSync(transactionDirectory, { recursive: true, force: true });
      continue;
    }

    const installed = inspectConfigPath(path);
    if (installed) {
      let captured = false;
      let capturedCanonical: ConfigSnapshot | undefined;
      try {
        const liveCandidate = readRegularConfigSnapshot(path, installed);
        assertSnapshotIdentity(liveCandidate, marker.candidate, "Interrupted new Hermes config before recovery capture");
        assertLinkCount(liveCandidate, 1, "Interrupted new Hermes config before recovery capture");
        marker = { ...marker, phase: "rollback-capture" };
        writeTransactionMarker(transactionDirectory, marker);
        atomicRenameAt2(path, configRelative, candidateRelative, "noreplace");
        captured = true;
        capturedCanonical = readRegularConfigSnapshot(candidatePath);
        assertSnapshotIdentity(capturedCanonical, marker.candidate, "Interrupted new Hermes config");
        assertLinkCount(capturedCanonical, 1, "Interrupted new Hermes config");
        unlinkSync(candidatePath);
        captured = false;
      } catch (error) {
        let restoreError: unknown;
        let restoreVerificationError: unknown;
        if (captured) {
          try {
            atomicRenameAt2(path, candidateRelative, configRelative, "noreplace");
            captured = false;
            if (capturedCanonical) {
              const preservedCanonical = readRegularConfigSnapshot(path);
              assertSnapshotIdentity(preservedCanonical, capturedCanonical, "Canonical Hermes config after reversed creation recovery");
              assertLinkCount(preservedCanonical, 1, "Canonical Hermes config after reversed creation recovery");
            }
          } catch (restoreFailure) {
            if (captured) restoreError = restoreFailure;
            else restoreVerificationError = restoreFailure;
          }
        }
        const detail = `Atomic recovery of an interrupted new Hermes config failed: ${errorDetail(error)}${restoreError ? `; restoring the captured path failed: ${errorDetail(restoreError)}` : ""}${restoreVerificationError ? `; restored path could not be verified: ${errorDetail(restoreVerificationError)}` : ""}`;
        if (!captured && (!capturedCanonical || !restoreVerificationError)) {
          throw manualRecoveryError(transactionDirectory, detail, error);
        }
        throw new Error(
          `${detail}; no captured config artifact was discarded and protected transaction ${transactionDirectory} was retained for manual recovery, but the canonical path could not be proven unchanged`,
          { cause: error },
        );
      }
    }
    rmSync(transactionDirectory, { recursive: true, force: true });
  }
}

/**
 * Replace one config atomically and prove the exact installed bytes parse. An
 * existing config is hard-linked into a protected 0700 transaction directory
 * before the candidate rename. A post-install failure restores that inode only
 * while the canonical path still owns this transaction's exact candidate; a
 * concurrent replacement is preserved with protected state for manual recovery.
 * Validator availability can never gate a safe restoration.
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
  const transactionName = basename(transactionDirectory);
  const stagedRelative = `${transactionName}/${TRANSACTION_CANDIDATE}`;
  const operatorRelative = `${transactionName}/${TRANSACTION_OPERATOR_FILE}`;
  const configRelative = basename(path);
  let installed = false;
  let operatorArtifactHoldsOriginal = false;
  let retainTransactionForRecovery = false;
  let marker: ConfigTransactionMarker | undefined;
  let failure: unknown;
  try {
    const mode = previous?.mode ?? 0o600;
    writeFileSync(stagedPath, nextBytes, { mode });
    const staged = readFileSync(stagedPath);
    if (!staged.equals(nextBytes)) throw new Error("Staged Hermes template config bytes changed before installation");
    assertValidTomlBytes(staged, "Staged Hermes template config");
    const stagedSnapshot = readRegularConfigSnapshot(stagedPath);
    assertLinkCount(stagedSnapshot, 1, "Staged Hermes template config");

    marker = {
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
      assertLinkCount(previous, 1, "Original Hermes template config");
      linkSync(path, operatorPath);
      operatorArtifactHoldsOriginal = true;
      const linkedCanonical = readRegularConfigSnapshot(path);
      const protectedOriginal = readRegularConfigSnapshot(operatorPath);
      assertSnapshotIdentity(linkedCanonical, previous, "Canonical Hermes config after protection link");
      assertSnapshotIdentity(protectedOriginal, previous, "Protected Hermes config");
      if (!sameIdentity(linkedCanonical, protectedOriginal)) {
        throw new Error("Canonical and protected Hermes configs do not reference the same inode after linking");
      }
      assertLinkCount(linkedCanonical, 2, "Canonical Hermes config after protection link");
      assertLinkCount(protectedOriginal, 2, "Protected Hermes config after protection link");

      // EXCHANGE is the linearizable install CAS. The exact directory entry
      // observed at the syscall is captured at stagedPath; if it is not the
      // protected original, exchange back before doing anything destructive.
      marker = { ...marker, phase: "install-exchange" };
      writeTransactionMarker(transactionDirectory, marker);
      try {
        atomicRenameAt2(path, stagedRelative, configRelative, "exchange");
      } catch (error) {
        if (error instanceof AtomicRenameOutcomeUnknown) {
          throw new AtomicConfigConflict(
            `Atomic Hermes config install outcome is unknown: ${error.message}`,
            false,
            error,
          );
        }
        throw error;
      }
      installed = true;
      let exchangedOut: ConfigSnapshot | undefined;
      try {
        const installedCandidate = readRegularConfigSnapshot(path);
        exchangedOut = readRegularConfigSnapshot(stagedPath);
        const stillProtected = readRegularConfigSnapshot(operatorPath);
        assertSnapshotIdentity(installedCandidate, marker.candidate, "Atomically installed Hermes candidate");
        assertLinkCount(installedCandidate, 1, "Atomically installed Hermes candidate");
        assertSnapshotIdentity(exchangedOut, previous, "Hermes config captured by atomic install");
        assertSnapshotIdentity(stillProtected, previous, "Protected Hermes config after atomic install");
        if (!sameIdentity(exchangedOut, stillProtected)) {
          throw new Error("Atomic install did not capture the protected operator inode");
        }
        assertLinkCount(exchangedOut, 2, "Hermes config captured by atomic install");
        assertLinkCount(stillProtected, 2, "Protected Hermes config after atomic install");
      } catch (exchangeMismatch) {
        try {
          const liveCandidate = readRegularConfigSnapshot(path);
          assertSnapshotIdentity(liveCandidate, marker.candidate, "Canonical candidate before reversing failed install exchange");
          assertLinkCount(liveCandidate, 1, "Canonical candidate before reversing failed install exchange");
        } catch (concurrentReplacement) {
          throw new AtomicConfigConflict(
            `Canonical Hermes config changed after the install exchange; it was left in place without a reverse exchange: ${errorDetail(concurrentReplacement)}`,
            true,
            new AggregateError(
              [exchangeMismatch, concurrentReplacement],
              "Hermes install exchange and canonical verification both failed",
            ),
          );
        }
        let reverseError: unknown;
        let reverseVerificationError: unknown;
        try {
          atomicRenameAt2(path, stagedRelative, configRelative, "exchange");
          installed = false;
          if (exchangedOut) {
            const restoredCanonical = readRegularConfigSnapshot(path);
            const restoredCandidate = readRegularConfigSnapshot(stagedPath);
            const retainedOriginal = readRegularConfigSnapshot(operatorPath);
            assertSnapshotIdentity(restoredCanonical, exchangedOut, "Canonical Hermes config after reversed install exchange");
            assertLinkCount(restoredCanonical, 1, "Canonical Hermes config after reversed install exchange");
            assertSnapshotIdentity(restoredCandidate, marker.candidate, "Candidate after reversed install exchange");
            assertLinkCount(restoredCandidate, 1, "Candidate after reversed install exchange");
            assertSnapshotIdentity(retainedOriginal, previous, "Protected original after reversed install exchange");
            assertLinkCount(retainedOriginal, 1, "Protected original after reversed install exchange");
          }
        } catch (error) {
          if (installed) reverseError = error;
          else reverseVerificationError = error;
        }
        throw new AtomicConfigConflict(
          `Atomic Hermes config install captured an unexpected canonical inode: ${errorDetail(exchangeMismatch)}${reverseError ? `; reversing the exchange failed: ${errorDetail(reverseError)}` : ""}${reverseVerificationError ? `; reversed state could not be verified: ${errorDetail(reverseVerificationError)}` : ""}`,
          installed === false && Boolean(exchangedOut) && !reverseVerificationError,
          new AggregateError(
            [exchangeMismatch, ...(reverseError ? [reverseError] : []), ...(reverseVerificationError ? [reverseVerificationError] : [])],
            "Hermes config atomic install CAS failed",
          ),
        );
      }
      unlinkSync(stagedPath);
      const singlyProtected = readRegularConfigSnapshot(operatorPath);
      assertSnapshotIdentity(singlyProtected, previous, "Protected Hermes config after displaced-link cleanup");
      assertLinkCount(singlyProtected, 1, "Protected Hermes config after displaced-link cleanup");
    } else {
      // A create must never overwrite a path that appeared after planning.
      marker = { ...marker, phase: "install-exchange" };
      writeTransactionMarker(transactionDirectory, marker);
      try {
        atomicRenameAt2(path, stagedRelative, configRelative, "noreplace");
      } catch (error) {
        if (error instanceof AtomicRenameOutcomeUnknown) {
          throw new AtomicConfigConflict(
            `Atomic Hermes config create outcome is unknown: ${error.message}`,
            false,
            error,
          );
        }
        throw error;
      }
      installed = true;
    }
    marker = { ...marker, phase: "installed" };
    writeTransactionMarker(transactionDirectory, marker);
    const written = readRegularConfigSnapshot(path);
    if (!written.bytes.equals(nextBytes)) throw new Error("Installed Hermes template config bytes differ from the validated candidate");
    assertValidTomlBytes(written.bytes, "Installed Hermes template config");
    assertSnapshotIdentity(written, marker.candidate, "Installed Hermes config");
    assertLinkCount(written, 1, "Installed Hermes config");

    // The committed marker is the success linearization point. Re-read the live
    // canonical leaf after it is durable and before releasing the original;
    // a replacement before that check becomes a retained conflict, while a
    // replacement after it is a post-transaction writer.
    marker = { ...marker, phase: "committed" };
    writeTransactionMarker(transactionDirectory, marker);
    try {
      const committable = readRegularConfigSnapshot(path);
      assertSnapshotIdentity(committable, marker.candidate, "Canonical Hermes config before releasing protected state");
      assertLinkCount(committable, 1, "Canonical Hermes config before releasing protected state");
    } catch (error) {
      throw new AtomicConfigConflict(
        `Canonical Hermes config changed after successful candidate validation: ${errorDetail(error)}`,
        true,
        error,
      );
    }
    if (operatorArtifactHoldsOriginal) {
      unlinkSync(operatorPath);
      operatorArtifactHoldsOriginal = false;
    }
  } catch (error) {
    const primary = errorDetail(error);
    let restorationError: unknown;
    let verificationError: unknown;
    let conflictError: unknown;
    let conflictMarkerError: unknown;
    let finalState: "unchanged" | "restored" | "removed" | "unknown" = installed ? "unknown" : "unchanged";

    if (error instanceof AtomicConfigConflict) {
      conflictError = error;
      retainTransactionForRecovery = true;
      if (marker) conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
    }

    // Restoration/removal is deliberately the first post-failure operation.
    // In particular, do not invoke the validator that just failed until the
    // operator's original inode is already back at the canonical path.
    if (!conflictError && installed) {
      if (!marker) {
        restorationError = new Error("transaction candidate identity is unavailable");
      } else if (previous && operatorArtifactHoldsOriginal) {
        try {
          const liveCandidate = readRegularConfigSnapshot(path);
          const protectedOriginal = readRegularConfigSnapshot(operatorPath);
          assertSnapshotIdentity(liveCandidate, marker.candidate, "Canonical Hermes config before rollback intent");
          assertLinkCount(liveCandidate, 1, "Canonical Hermes config before rollback intent");
          assertSnapshotIdentity(protectedOriginal, previous, "Protected operator config before rollback intent");
          assertLinkCount(protectedOriginal, 1, "Protected operator config before rollback intent");
        } catch (preflightConflict) {
          conflictError = new AtomicConfigConflict(
            `Canonical Hermes config changed before rollback could begin: ${errorDetail(preflightConflict)}`,
            true,
            preflightConflict,
          );
          retainTransactionForRecovery = true;
          conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
        }
        let rollbackExchanged = false;
        let displacedCanonical: ConfigSnapshot | undefined;
        if (!conflictError) try {
          linkSync(operatorPath, stagedPath);
          const protectedRollbackOriginal = readRegularConfigSnapshot(operatorPath);
          const protectedRollbackAlias = readRegularConfigSnapshot(stagedPath);
          assertSnapshotIdentity(protectedRollbackOriginal, previous, "Protected original before rollback exchange");
          assertSnapshotIdentity(protectedRollbackAlias, previous, "Protected rollback alias before rollback exchange");
          if (!sameIdentity(protectedRollbackOriginal, protectedRollbackAlias)) {
            throw new Error("rollback protection links do not reference the same original inode");
          }
          assertLinkCount(protectedRollbackOriginal, 2, "Protected original before rollback exchange");
          assertLinkCount(protectedRollbackAlias, 2, "Protected rollback alias before rollback exchange");
          marker = { ...marker, phase: "rollback-exchange" };
          writeTransactionMarker(transactionDirectory, marker);
          atomicRenameAt2(path, operatorRelative, configRelative, "exchange");
          rollbackExchanged = true;
          const restoredOriginal = readRegularConfigSnapshot(path);
          displacedCanonical = readRegularConfigSnapshot(operatorPath);
          const retainedRollbackOriginal = readRegularConfigSnapshot(stagedPath);
          assertSnapshotIdentity(restoredOriginal, previous, "Restored Hermes config after rollback exchange");
          assertSnapshotIdentity(retainedRollbackOriginal, previous, "Retained original after rollback exchange");
          if (!sameIdentity(restoredOriginal, retainedRollbackOriginal)) {
            throw new Error("restored and retained rollback originals are different inodes");
          }
          assertLinkCount(restoredOriginal, 2, "Restored Hermes config after rollback exchange");
          assertLinkCount(retainedRollbackOriginal, 2, "Retained original after rollback exchange");
          assertSnapshotIdentity(displacedCanonical, marker.candidate, "Hermes candidate captured by rollback exchange");
          assertLinkCount(displacedCanonical, 1, "Hermes candidate captured by rollback exchange");
          unlinkSync(operatorPath);
          operatorArtifactHoldsOriginal = false;
          unlinkSync(stagedPath);
          installed = false;
          finalState = "restored";
        } catch (rollbackFailure) {
          if (!rollbackExchanged) {
            restorationError = rollbackFailure;
          } else {
            let canonicalStillRestored = false;
            try {
              const liveCanonical = readRegularConfigSnapshot(path);
              assertSnapshotIdentity(liveCanonical, previous, "Canonical original before reversing failed rollback exchange");
              canonicalStillRestored = true;
            } catch (concurrentReplacement) {
              conflictError = new AtomicConfigConflict(
                `Canonical Hermes config changed after rollback exchange; it was left in place without a reverse exchange: ${errorDetail(concurrentReplacement)}`,
                true,
                new AggregateError(
                  [rollbackFailure, concurrentReplacement],
                  "Hermes rollback exchange and canonical verification both failed",
                ),
              );
              retainTransactionForRecovery = true;
              conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
            }
            if (!canonicalStillRestored) {
              // Every inode remains at canonical/operator/staged; no reverse is
              // safe once a later writer owns the canonical path.
            } else {
            let reverseError: unknown;
            let reverseVerificationError: unknown;
            try {
              atomicRenameAt2(path, operatorRelative, configRelative, "exchange");
              rollbackExchanged = false;
              installed = true;
              if (displacedCanonical) {
                const preservedCanonical = readRegularConfigSnapshot(path);
                const retainedOriginal = readRegularConfigSnapshot(operatorPath);
                const retainedOriginalAlias = readRegularConfigSnapshot(stagedPath);
                assertSnapshotIdentity(preservedCanonical, displacedCanonical, "Canonical Hermes config after reversed rollback exchange");
                assertLinkCount(preservedCanonical, 1, "Canonical Hermes config after reversed rollback exchange");
                assertSnapshotIdentity(retainedOriginal, previous, "Protected original after reversed rollback exchange");
                assertSnapshotIdentity(retainedOriginalAlias, previous, "Protected original alias after reversed rollback exchange");
                if (!sameIdentity(retainedOriginal, retainedOriginalAlias)) {
                  throw new Error("protected rollback links diverged after reverse exchange");
                }
                assertLinkCount(retainedOriginal, 2, "Protected original after reversed rollback exchange");
                assertLinkCount(retainedOriginalAlias, 2, "Protected original alias after reversed rollback exchange");
              }
            } catch (reverseFailure) {
              if (rollbackExchanged) reverseError = reverseFailure;
              else reverseVerificationError = reverseFailure;
            }
            conflictError = new AtomicConfigConflict(
              `Atomic rollback captured a canonical inode other than this transaction's candidate: ${errorDetail(rollbackFailure)}${reverseError ? `; reversing the rollback exchange failed: ${errorDetail(reverseError)}` : ""}${reverseVerificationError ? `; reversed rollback state could not be verified: ${errorDetail(reverseVerificationError)}` : ""}`,
              !rollbackExchanged && Boolean(displacedCanonical) && !reverseVerificationError,
              new AggregateError(
                [rollbackFailure, ...(reverseError ? [reverseError] : []), ...(reverseVerificationError ? [reverseVerificationError] : [])],
                "Hermes config atomic rollback CAS failed",
              ),
            );
            retainTransactionForRecovery = true;
            conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
            }
          }
        }
      } else if (previous === undefined) {
        try {
          const liveCandidate = readRegularConfigSnapshot(path);
          assertSnapshotIdentity(liveCandidate, marker.candidate, "Canonical new Hermes config before rollback capture");
          assertLinkCount(liveCandidate, 1, "Canonical new Hermes config before rollback capture");
        } catch (preflightConflict) {
          conflictError = new AtomicConfigConflict(
            `Canonical Hermes config changed before new-config rollback could begin: ${errorDetail(preflightConflict)}`,
            true,
            preflightConflict,
          );
          retainTransactionForRecovery = true;
          conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
        }
        let captured = false;
        let capturedCanonical: ConfigSnapshot | undefined;
        if (!conflictError) try {
          marker = { ...marker, phase: "rollback-capture" };
          writeTransactionMarker(transactionDirectory, marker);
          atomicRenameAt2(path, configRelative, stagedRelative, "noreplace");
          captured = true;
          capturedCanonical = readRegularConfigSnapshot(stagedPath);
          assertSnapshotIdentity(capturedCanonical, marker.candidate, "New Hermes candidate captured for rollback");
          assertLinkCount(capturedCanonical, 1, "New Hermes candidate captured for rollback");
          unlinkSync(stagedPath);
          installed = false;
          finalState = "removed";
        } catch (rollbackFailure) {
          if (!captured) {
            restorationError = rollbackFailure;
          } else {
            let restoreError: unknown;
            let restoreVerificationError: unknown;
            try {
              atomicRenameAt2(path, stagedRelative, configRelative, "noreplace");
              captured = false;
              installed = true;
              if (capturedCanonical) {
                const preservedCanonical = readRegularConfigSnapshot(path);
                assertSnapshotIdentity(preservedCanonical, capturedCanonical, "Canonical Hermes config after reversed new-config rollback");
                assertLinkCount(preservedCanonical, 1, "Canonical Hermes config after reversed new-config rollback");
              }
            } catch (restoreFailure) {
              if (captured) restoreError = restoreFailure;
              else restoreVerificationError = restoreFailure;
            }
            conflictError = new AtomicConfigConflict(
              `Atomic new-config rollback captured unexpected operator state: ${errorDetail(rollbackFailure)}${restoreError ? `; restoring the captured path failed: ${errorDetail(restoreError)}` : ""}${restoreVerificationError ? `; restored path could not be verified: ${errorDetail(restoreVerificationError)}` : ""}`,
              !captured && Boolean(capturedCanonical) && !restoreVerificationError,
              new AggregateError(
                [rollbackFailure, ...(restoreError ? [restoreError] : []), ...(restoreVerificationError ? [restoreVerificationError] : [])],
                "Hermes new-config atomic rollback CAS failed",
              ),
            );
            retainTransactionForRecovery = true;
            conflictMarkerError = markTransactionConflict(transactionDirectory, marker);
          }
        }
      } else {
        restorationError = new Error("protected operator inode is unavailable");
      }
    } else if (!conflictError && operatorArtifactHoldsOriginal) {
      try {
        // Candidate was never installed; remove only the extra hard link.
        if (!previous || !marker) throw new Error("pre-install transaction identity is unavailable");
        const canonicalOriginal = readRegularConfigSnapshot(path);
        const protectedOriginal = readRegularConfigSnapshot(operatorPath);
        assertSnapshotIdentity(canonicalOriginal, previous, "Canonical original before releasing unused protection");
        assertSnapshotIdentity(protectedOriginal, previous, "Protected original before releasing unused protection");
        if (!sameIdentity(canonicalOriginal, protectedOriginal)) {
          throw new Error("canonical and protected originals diverged before unused protection could be released");
        }
        assertLinkCount(canonicalOriginal, 2, "Canonical original before releasing unused protection");
        assertLinkCount(protectedOriginal, 2, "Protected original before releasing unused protection");
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
        assertLinkCount(restored, 1, "Restored Hermes config");
        // Best-effort consumer verification happens only after exact restoration.
        assertValidTomlBytes(restored.bytes, "Post-restore Hermes template config");
      } catch (postRestoreFailure) {
        verificationError = postRestoreFailure;
      }
    }

    if (conflictError) {
      const markerDetail = conflictMarkerError
        ? `; additionally failed to record conflict state: ${errorDetail(conflictMarkerError)}`
        : "";
      const detail = error instanceof AtomicConfigConflict
        ? `${primary}${markerDetail}`
        : `${primary}; canonical Hermes config changed after candidate installation: ${errorDetail(conflictError)}${markerDetail}`;
      const cause = new AggregateError(
        [error, conflictError, ...(conflictMarkerError ? [conflictMarkerError] : [])],
        "Hermes config installation failed after a concurrent canonical-path change",
      );
      failure = conflictError instanceof AtomicConfigConflict && !conflictError.canonicalPreserved
        ? new Error(
          `${detail}; no captured config artifact was discarded and protected transaction ${transactionDirectory} was retained for manual recovery, but the canonical path could not be proven unchanged`,
          { cause },
        )
        : manualRecoveryError(transactionDirectory, detail, cause);
    } else if (restorationError) {
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
        assertLinkCount(previous, 1, `Existing Hermes template config ${path}`);
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
