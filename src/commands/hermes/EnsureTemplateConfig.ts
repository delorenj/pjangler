import { homedir, platform } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
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

function assertValidToml(source: string, label: string): void {
  try {
    parseToml(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid TOML: ${detail}`);
  }
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
 * Replace one config atomically and prove the exact installed bytes parse.
 * If the post-rename read unexpectedly disagrees, restore the prior bytes (or
 * remove a newly-created file) before reporting failure.
 */
function installValidatedConfig(path: string, next: string, previous: string | undefined): void {
  assertValidToml(next, "Rendered Hermes template config");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const stagingDirectory = mkdtempSync(join(directory, ".pjangler-config-"));
  const stagedPath = join(stagingDirectory, "config.toml");
  let installed = false;
  try {
    const mode = previous === undefined ? 0o600 : statSync(path).mode & 0o777;
    writeFileSync(stagedPath, next, { encoding: "utf8", mode });
    const staged = readFileSync(stagedPath, "utf8");
    if (staged !== next) throw new Error("Staged Hermes template config bytes changed before installation");
    assertValidToml(staged, "Staged Hermes template config");

    renameSync(stagedPath, path);
    installed = true;
    const written = readFileSync(path, "utf8");
    if (written !== next) throw new Error("Installed Hermes template config bytes differ from the validated candidate");
    assertValidToml(written, "Installed Hermes template config");
  } catch (error) {
    if (installed) {
      if (previous === undefined) {
        unlinkSync(path);
      } else {
        const rollbackPath = join(stagingDirectory, "rollback.toml");
        writeFileSync(rollbackPath, previous, { encoding: "utf8", mode: statSync(path).mode & 0o777 });
        assertValidToml(readFileSync(rollbackPath, "utf8"), "Rollback Hermes template config");
        renameSync(rollbackPath, path);
      }
    }
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
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
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync(path);
    if (exists && !force) {
      return { success: true, outcome: "unchanged", message: `Config present: ${path}` };
    }

    let next = renderHostConfig();
    let current = "";
    try {
      if (exists) {
        current = readFileSync(path, "utf8");
        next = mergeHostConfig(current);
      } else {
        assertValidToml(next, "Rendered Hermes template config");
      }
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to prepare ${path}: ${error instanceof Error ? error.message : String(error)}` };
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
      installValidatedConfig(path, next, exists ? current : undefined);
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
