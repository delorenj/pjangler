#!/usr/bin/env node

// src/mcp-server.ts
import { existsSync as existsSync17, statSync as statSync5 } from "node:fs";
import { basename as basename6, dirname as dirname10, join as join22, resolve as resolve9 } from "node:path";
import { fileURLToPath as fileURLToPath7 } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/recipes/Recipe.ts
import { homedir } from "node:os";
import { resolve } from "node:path";

// src/commands/Command.ts
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
var Command = class {
  context;
  constructor(context) {
    this.context = context;
  }
  /**
   * Format message with [DRY RUN] prefix if in dry-run mode
   */
  formatMessage(message) {
    return this.context.dryRun ? `[DRY RUN] ${message}` : message;
  }
  fileExists(filePath) {
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
};

// src/utils/style.ts
var env = process.env;
function detectColor() {
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== void 0 && force !== "") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}
var colorEnabled = detectColor();
function sgr(open, close) {
  const prefix = `\x1B[${open}m`;
  const suffix = `\x1B[${close}m`;
  return (value) => colorEnabled ? `${prefix}${value}${suffix}` : String(value);
}
var bold = sgr(1, 22);
var dim = sgr(2, 22);
var italic = sgr(3, 23);
var underline = sgr(4, 24);
var red = sgr(31, 39);
var green = sgr(32, 39);
var yellow = sgr(33, 39);
var blue = sgr(34, 39);
var magenta = sgr(35, 39);
var cyan = sgr(36, 39);
var gray = sgr(90, 39);
var glyph = {
  pass: "\u2714",
  fail: "\u2716",
  warn: "\u26A0",
  skip: "\u25CB",
  info: "\u2139",
  arrow: "\u21B3",
  bullet: "\u2022",
  dot: "\xB7",
  add: "+",
  chevron: "\u25B8",
  pointer: "\u276F"
};
var STATUS_STYLES = {
  pass: { glyph: glyph.pass, color: green, label: "pass" },
  fail: { glyph: glyph.fail, color: red, label: "fail" },
  warn: { glyph: glyph.warn, color: yellow, label: "warn" },
  skip: { glyph: glyph.skip, color: gray, label: "skip" },
  applied: { glyph: glyph.pass, color: green, label: "applied" },
  noop: { glyph: glyph.skip, color: gray, label: "noop" },
  blocked: { glyph: glyph.fail, color: red, label: "blocked" },
  skipped: { glyph: glyph.skip, color: gray, label: "skipped" }
};
function statusStyle(status) {
  return STATUS_STYLES[status] ?? { glyph: glyph.dot, color: dim, label: status };
}
function joinDot(fragments) {
  return fragments.join(dim(` ${glyph.dot} `));
}
var ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}
function visibleWidth(value) {
  return stripAnsi(value).length;
}
function truncateVisible(value, width) {
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  if (plain.length !== value.length) return width <= 1 ? "\u2026" : `${plain.slice(0, width - 1)}\u2026`;
  return width <= 1 ? "\u2026" : `${value.slice(0, width - 1)}\u2026`;
}
function terminalWidth(stream = process.stdout, fallback = 100) {
  const columns = stream.columns;
  return typeof columns === "number" && columns > 0 ? columns : fallback;
}
function wrapVisible(text2, width) {
  if (width <= 0) return [text2];
  const lines = [];
  let current = "";
  for (const word of text2.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
    } else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (visibleWidth(current) > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  lines.push(current);
  return lines;
}

// src/recipes/Recipe.ts
function commandStatus(result, dryRun) {
  if (result.outcome) return result.outcome;
  if (!result.success) return "failed";
  if (dryRun && result.filePath) return "planned";
  return result.filePath ? "changed" : "unchanged";
}
function mergeInitResults(recipeId, dryRun, results) {
  return {
    recipeId,
    ok: results.every((result) => result.ok),
    dryRun,
    changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
    logs: results.flatMap((result) => result.logs),
    errors: results.flatMap((result) => result.errors),
    phases: results.flatMap((result) => result.phases)
  };
}
var Recipe = class {
  ingredientTypes = [];
  compatibilityContext;
  constructor(context) {
    this.compatibilityContext = context;
  }
  addIngredient(CommandClass) {
    this.ingredientTypes.push(CommandClass);
    return this;
  }
  async invokeIngredients(ctx) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    for (const CommandClass of this.ingredientTypes) {
      const command = new CommandClass(ctx);
      const result = await command.invoke();
      const status = commandStatus(result, Boolean(ctx.dryRun));
      const phaseChangedFiles = status === "changed" && result.filePath ? [resolve(ctx.targetDir, result.filePath)] : [];
      phases.push({ id: CommandClass.name, status, changedFiles: phaseChangedFiles, message: result.message || void 0 });
      if (result.message) logs.push(result.message);
      changedFiles.push(...phaseChangedFiles);
      if (status === "failed" || status === "cancelled") errors.push(result.message || `${CommandClass.name} ${status}`);
      if (status === "failed" || status === "cancelled") break;
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
  }
  /** Initialize missing/drifted state using only this recipe's owned checks. */
  async initializeOwnedChecks(ctx) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    for (const check of this.checks) {
      const finding = check.audit(ctx);
      if (finding.status === "pass" || finding.status === "skip") {
        phases.push({ id: check.id, status: finding.status === "skip" ? "skipped" : "unchanged", changedFiles: [], message: finding.summary });
        continue;
      }
      if (!finding.fixable) {
        phases.push({ id: check.id, status: "failed", changedFiles: [], message: finding.summary });
        errors.push(`${check.id}: ${finding.summary}`);
        break;
      }
      const migrated = await check.migrate(ctx, finding);
      const status = migrated.status === "applied" ? ctx.dryRun ? "planned" : "changed" : migrated.status === "noop" ? "unchanged" : migrated.status === "skipped" ? "skipped" : "failed";
      const actualChanges = status === "changed" ? migrated.changedFiles : [];
      phases.push({ id: check.id, status, changedFiles: actualChanges, message: migrated.summary });
      logs.push(`${check.id}: ${migrated.summary}`);
      changedFiles.push(...actualChanges);
      if (status === "failed") {
        errors.push(`${check.id}: ${migrated.summary}`);
        break;
      }
      if (!ctx.dryRun) {
        const postcondition = check.audit(ctx);
        if (postcondition.status !== "pass" && postcondition.status !== "skip") {
          const detail = postcondition.details.length ? ` (${postcondition.details.join("; ")})` : "";
          errors.push(`${check.id}: init postcondition failed: ${postcondition.summary}${detail}`);
          phases.push({ id: `${check.id}:postcondition`, status: "failed", changedFiles: [], message: postcondition.summary });
          break;
        }
      }
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
  }
  audit(ctx) {
    return this.checks.map((check) => ({ ...check.audit(ctx), recipeId: this.metadata.id }));
  }
  migrate(ctx, ruleIds) {
    const selected = this.checks.filter((check) => ruleIds.includes(check.id));
    return selected.map((check) => ({ ...check.migrate(ctx, check.audit(ctx)), recipeId: this.metadata.id }));
  }
  /** @deprecated Compatibility alias; registry dispatch is authoritative. */
  async execute(input) {
    if (!this.compatibilityContext) throw new Error(`${this.metadata.id}.execute requires a compatibility context`);
    const targetDir = resolve(this.compatibilityContext.targetDir);
    const ctx = {
      ...this.compatibilityContext,
      targetDir,
      repoRoot: targetDir,
      pjanglerRoot: resolve(new URL("../..", import.meta.url).pathname),
      homeDir: homedir(),
      dryRun: Boolean(this.compatibilityContext.dryRun),
      force: Boolean(this.compatibilityContext.force)
    };
    console.log("");
    console.log(`  ${cyan(bold(glyph.chevron))} ${bold(`Initializing ${this.metadata.id} subsystem`)}${ctx.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
    console.log("");
    const result = await this.init(ctx, input);
    for (const line of result.logs) console.log(line.split("\n").map((part) => part ? `  ${part}` : part).join("\n"));
    for (const error of result.errors) console.error(error);
    if (!ctx.dryRun && result.ok) this.printNextSteps();
    if (ctx.dryRun) {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${dim("Dry-run complete \u2014 no files were modified.")}`);
      console.log(`  ${dim("Remove --dry-run to apply changes.")}`);
    }
  }
};

// src/parity/rules.ts
import { existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync, readFileSync as readFileSync2, readlinkSync, readdirSync as readdirSync2, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync as writeFileSync2, chmodSync, copyFileSync, rmSync } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join3, relative as relative2, resolve as resolve3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash as createHash2 } from "node:crypto";

// src/utils/child-process.ts
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync
} from "node:child_process";

// src/utils/child-environment.ts
var SUBPROCESS_INJECTION_KEYS = /* @__PURE__ */ new Set([
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "BASH_ENV",
  "ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "BASH_COMPAT",
  "BASH_LOADABLES_PATH",
  "BASH_XTRACEFD",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "NODE_OPTIONS",
  "NODE_PATH",
  "GLIBC_TUNABLES"
]);
var GNU_DYNAMIC_LOADER_CONTROL_KEYS = /* @__PURE__ */ new Set([
  "LD_ASSUME_KERNEL",
  "LD_AUDIT",
  "LD_BIND_NOT",
  "LD_BIND_NOW",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_DYNAMIC_WEAK",
  "LD_HWCAP_MASK",
  "LD_LIBRARY_PATH",
  "LD_ORIGIN_PATH",
  "LD_POINTER_GUARD",
  "LD_PREFER_MAP_32BIT_EXEC",
  "LD_PRELOAD",
  "LD_PROFILE",
  "LD_PROFILE_OUTPUT",
  "LD_SHOW_AUXV",
  "LD_TRACE_LOADED_OBJECTS",
  "LD_TRACE_PRELINKING",
  "LD_USE_LOAD_BIAS",
  "LD_VERBOSE",
  "LD_WARN"
]);
function isSubprocessInjectionKey(key) {
  if (SUBPROCESS_INJECTION_KEYS.has(key)) return true;
  if (key.startsWith("BASH_FUNC_")) return true;
  if (key.startsWith("DYLD_")) return true;
  const abiNeutralKey = key.replace(/_(?:32|64)$/, "");
  return GNU_DYNAMIC_LOADER_CONTROL_KEYS.has(abiNeutralKey);
}
function hardenSubprocessEnvironment(source = process.env, overrides = {}) {
  const env2 = { ...source, ...overrides };
  for (const key of Object.keys(env2)) {
    if (isSubprocessInjectionKey(key)) delete env2[key];
  }
  env2.PYTHONNOUSERSITE = "1";
  env2.PYTHONSAFEPATH = "1";
  return env2;
}

// src/utils/child-process.ts
function hardenedOptions(options) {
  const supplied = options ?? {};
  return {
    ...supplied,
    env: hardenSubprocessEnvironment(supplied.env ?? process.env)
  };
}
var spawnSync = ((command, argsOrOptions, maybeOptions) => {
  if (Array.isArray(argsOrOptions)) {
    return nodeSpawnSync(command, argsOrOptions, hardenedOptions(maybeOptions));
  }
  return nodeSpawnSync(command, hardenedOptions(argsOrOptions));
});

// src/parity/rules.ts
import YAML from "yaml";

// src/recipes/supported-clis.ts
var SUPPORTED_CLIS = Object.freeze([
  { id: "claude", name: "Claude", bmadTool: "claude-code", projectRoot: ".claude", skillsRoot: ".claude/skills" },
  { id: "codex", name: "Codex", bmadTool: "codex", projectRoot: ".codex", skillsRoot: ".codex/skills" },
  { id: "gemini", name: "Gemini", bmadTool: "gemini", projectRoot: ".gemini", skillsRoot: ".gemini/skills" },
  { id: "copilot", name: "Copilot", bmadTool: "github-copilot", projectRoot: ".copilot", skillsRoot: ".copilot/skills" },
  { id: "opencode", name: "OpenCode", bmadTool: "opencode", projectRoot: ".opencode", skillsRoot: ".opencode/skills" },
  { id: "kimi", name: "Kimi", bmadTool: "kimi-code", projectRoot: ".kimi-code", skillsRoot: ".kimi-code/skills" }
]);
var SUPPORTED_BMAD_TOOLS = SUPPORTED_CLIS.map((cli) => cli.bmadTool);
var SUPPORTED_CLI_ROOTS = SUPPORTED_CLIS.map((cli) => cli.projectRoot);

// src/parity/pack.ts
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join as join2, relative, resolve as resolve2, sep } from "node:path";
var PackUnavailableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PackUnavailableError";
  }
};
var CANONICAL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
function readRegularFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Pack entry is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function hashRegularFile(path) {
  return sha256(readRegularFile(path));
}
function isRegularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function assertRealDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PackUnavailableError(`${label} is not present: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return path;
}
function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const part of relativePath.split("/")) {
    if (!part) continue;
    current = join2(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new PackUnavailableError(`Pack path is not present: ${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked pack path component: ${current}`);
  }
  return current;
}
function validatePathComponent(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || basename(value) !== value) {
    throw new Error(`${label} must be one path component: ${JSON.stringify(value)}`);
  }
  return value;
}
function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\\") || value.startsWith("/")) throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}
function optionalStringArray(value, label) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of skill names`);
  return value.map((item) => validatePathComponent(item, `${label} entry`));
}
function optionalBoolean(value, label) {
  if (value === void 0 || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function normalizePackEntry(raw) {
  let source;
  if (typeof raw === "string") {
    const trimmed2 = raw.trim();
    const at = trimmed2.indexOf("@");
    source = at >= 0 ? { name: trimmed2.slice(0, at), version: trimmed2.slice(at + 1) } : { name: trimmed2 };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    source = raw;
  } else {
    throw new Error(`Pack entry must be a string or object: ${JSON.stringify(raw)}`);
  }
  const name = validatePathComponent(source.name, "Pack name");
  const entry = {
    name,
    optional: optionalBoolean(source.optional, `Pack ${name} optional`),
    sealed: optionalBoolean(source.sealed, `Pack ${name} sealed`),
    flatten: optionalBoolean(source.flatten, `Pack ${name} flatten`)
  };
  if (source.version !== void 0 && source.version !== null) {
    entry.version = validatePathComponent(source.version, `Pack ${name} version`);
  }
  if (source.source !== void 0 && source.source !== null) {
    if (typeof source.source !== "string") throw new Error(`Pack ${name} source must be a string`);
    entry.source = source.source;
  }
  if (source.registry !== void 0 && source.registry !== null) {
    if (typeof source.registry !== "string") throw new Error(`Pack ${name} registry must be a string`);
    entry.registry = source.registry;
  }
  if (source.registry_path !== void 0 && source.registry_path !== null) {
    entry.registryPath = safeRelativePath(source.registry_path, `pack ${name} registry_path`);
  }
  if (entry.source && entry.registryPath) {
    throw new Error(`Pack ${name} may not set both \`source\` and \`registry_path\``);
  }
  entry.include = optionalStringArray(source.include, `Pack ${name} include`);
  entry.exclude = optionalStringArray(source.exclude, `Pack ${name} exclude`);
  return entry;
}
function versionSegments(text2) {
  return text2.split(/[._]/).filter(Boolean).map((chunk) => /^\d+$/.test(chunk) ? [0, Number.parseInt(chunk, 10), ""] : [1, 0, chunk]);
}
function compareSegments(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left) return -1;
    if (!right) return 1;
    if (left[0] !== right[0]) return left[0] - right[0];
    if (left[1] !== right[1]) return left[1] - right[1];
    if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1;
  }
  return 0;
}
function compareVersions(a, b) {
  const splitAt = (value) => {
    const index = value.indexOf("-");
    return index < 0 ? [value, "", false] : [value.slice(0, index), value.slice(index + 1), true];
  };
  const [aRelease, aPre, aHasPre] = splitAt(a);
  const [bRelease, bPre, bHasPre] = splitAt(b);
  const release = compareSegments(versionSegments(aRelease), versionSegments(bRelease));
  if (release !== 0) return release;
  const aRank = aHasPre ? 0 : 1;
  const bRank = bHasPre ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  return compareSegments(versionSegments(aPre), versionSegments(bPre));
}
function selectPackVersion(packDir) {
  const versions = [];
  for (const name of readdirSync(packDir).sort()) {
    if (name.startsWith(".")) continue;
    const stat = lstatSync(join2(packDir, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (isRegularFile(join2(packDir, name, "SKILL.md"))) return null;
    versions.push(name);
  }
  if (!versions.length) return null;
  return versions.reduce((best, candidate) => compareVersions(candidate, best) > 0 ? candidate : best);
}
function stripTomlComment(line) {
  let out = "";
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        out += ch + (line[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}
function bracketDepth(text2) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text2.length; index += 1) {
    const ch = text2[index];
    if (quote) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  return depth;
}
function unescapeBasicString(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape) => {
    if (escape.startsWith("u")) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n":
        return "\n";
      case "t":
        return "	";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return escape;
    }
  });
}
function parseTomlStringArray(body, label) {
  const items = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let remainder = "";
  let cursor = 0;
  let match;
  while (match = pattern.exec(body)) {
    remainder += body.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    items.push(match[1] !== void 0 ? unescapeBasicString(match[1]) : match[2]);
  }
  remainder += body.slice(cursor);
  if (/[^\s[\],]/.test(remainder)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return items;
}
function parseTomlScalar(raw) {
  const value = raw.trim();
  if (!value) return void 0;
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/);
    return match ? unescapeBasicString(match[1]) : void 0;
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match ? match[1] : void 0;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?[0-9][0-9_]*$/.test(value)) return Number.parseInt(value.replace(/_/g, ""), 10);
  return void 0;
}
function parseTomlTables(content) {
  const tables = /* @__PURE__ */ new Map();
  const tableFor = (name) => {
    let table = tables.get(name);
    if (!table) {
      table = /* @__PURE__ */ new Map();
      tables.set(name, table);
    }
    return table;
  };
  let current = tableFor("");
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^[\]]+?)\s*\]\]?$/);
    if (header) {
      current = tableFor(header[1]);
      continue;
    }
    const assignment = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    let key = assignment[1];
    if (key.startsWith('"')) key = unescapeBasicString(key.slice(1, -1));
    else if (key.startsWith("'")) key = key.slice(1, -1);
    const raw = assignment[2];
    const multiline = raw.match(/^("""|''')/);
    if (multiline) {
      const delimiter3 = multiline[1];
      if (raw.slice(3).includes(delimiter3)) continue;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index].includes(delimiter3)) break;
      }
      continue;
    }
    if (raw.startsWith("[")) {
      let body = raw;
      let depth = bracketDepth(raw);
      let cursor = index;
      while (depth > 0 && cursor + 1 < lines.length) {
        cursor += 1;
        const chunk = stripTomlComment(lines[cursor]);
        body += `
${chunk}`;
        depth += bracketDepth(chunk);
      }
      if (depth > 0) throw new Error(`Unterminated TOML array for key ${JSON.stringify(key)}`);
      index = cursor;
      current.set(key, parseTomlStringArray(body, `${JSON.stringify(key)}`));
      continue;
    }
    const scalar = parseTomlScalar(raw);
    current.set(key, scalar ?? null);
  }
  return tables;
}
function readPackMetadata(root) {
  const path = join2(root, "pack.toml");
  const stat = (() => {
    try {
      return lstatSync(path);
    } catch {
      return void 0;
    }
  })();
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Pack metadata is not a regular file: ${path}`);
  let tables;
  try {
    tables = parseTomlTables(readRegularFile(path).toString("utf8"));
  } catch (error) {
    throw new Error(`Pack metadata at ${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pack = tables.get("pack");
  const freeform = tables.get("freeform");
  const policy = tables.get("policy");
  const sourceTable = tables.get("source");
  const declared = freeform?.get("skills");
  if (declared !== void 0 && !Array.isArray(declared)) {
    throw new Error(`Pack metadata at ${path} [freeform].skills must be an array of strings`);
  }
  const payloadFiles = sourceTable?.get("payload_files");
  const name = pack?.get("name");
  const version = pack?.get("version");
  return {
    name: typeof name === "string" ? name : void 0,
    version: typeof version === "string" ? version : void 0,
    skills: Array.isArray(declared) ? [...declared] : [],
    // `immutable = true` alone deliberately does NOT imply sealed.
    sealed: policy?.get("sealed") === true,
    flatten: policy?.get("flatten") === true,
    payloadFiles: typeof payloadFiles === "number" ? payloadFiles : void 0
  };
}
function packFlattenEnabled(metadata, entry) {
  return entry.flatten === true || metadata?.flatten === true;
}
function packContainerLeaves(containerDir) {
  const leaves = [];
  const symlinked = [];
  const visit = (directory, prefix) => {
    let children;
    try {
      children = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const child of children) {
      if (child.startsWith(".") || child.startsWith("_")) continue;
      const childPath = join2(directory, child);
      const relativePath = prefix ? `${prefix}/${child}` : child;
      let stat;
      try {
        stat = lstatSync(childPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        symlinked.push(relativePath);
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (isRegularFile(join2(childPath, "SKILL.md"))) {
        leaves.push(relativePath);
        continue;
      }
      visit(childPath, relativePath);
    }
  };
  visit(containerDir, "");
  return { leaves, symlinked };
}
function hasFlattenableChildren(directory) {
  return packContainerLeaves(directory).leaves.length > 0;
}
function expandPackInventory(root, declared, entry, flatten) {
  if (!flatten) {
    return {
      inventory: declared.map((name) => ({ name, path: name, declaredEntry: name })),
      warnings: []
    };
  }
  const inventory = [];
  const warnings = [];
  const origin = /* @__PURE__ */ new Map();
  const claim = (member, declaredAsIs = false) => {
    if (!declaredAsIs && !CANONICAL_NAME_PATTERN.test(member.name)) {
      warnings.push(
        `Pack ${entry.name} leaf ${JSON.stringify(member.name)} at ${member.path} is not a canonical skill name (${CANONICAL_NAME_PATTERN.source}); skipping`
      );
      return false;
    }
    validatePathComponent(member.name, `Pack ${entry.name} skill name`);
    const previous = origin.get(member.name);
    if (previous !== void 0) {
      throw new Error(
        `Pack ${entry.name} flattens to a duplicate skill name ${JSON.stringify(member.name)}: ${join2(root, previous)} and ${join2(root, member.path)}`
      );
    }
    origin.set(member.name, member.path);
    inventory.push(member);
    return true;
  };
  for (const declaredEntry of declared) {
    const declaredDir = join2(root, declaredEntry);
    assertRealDirectory(declaredDir, `Pack skill ${declaredEntry}`);
    if (isRegularFile(join2(declaredDir, "SKILL.md"))) {
      claim({ name: declaredEntry, path: declaredEntry, declaredEntry }, true);
      continue;
    }
    const { leaves, symlinked } = packContainerLeaves(declaredDir);
    for (const child of symlinked) {
      warnings.push(`Pack ${entry.name} member ${declaredEntry}/${child} is a symlink; skipping`);
    }
    let contributed = 0;
    for (const leafPath of leaves) {
      if (claim({ name: basename(leafPath), path: `${declaredEntry}/${leafPath}`, declaredEntry })) {
        contributed += 1;
      }
    }
    if (contributed === 0) {
      warnings.push(
        `Pack ${entry.name} declared entry ${JSON.stringify(declaredEntry)} is a container that contributes no skills`
      );
    }
  }
  return { inventory, warnings };
}
function packDeclaredSkills(root, metadata, entry, flatten = false) {
  if (metadata) {
    if (metadata.name !== entry.name) {
      throw new Error(`Pack ${entry.name} pack.toml declares name ${JSON.stringify(metadata.name ?? null)}`);
    }
    if (entry.version && metadata.version !== entry.version) {
      throw new Error(
        `Pack ${entry.name} pack.toml declares version ${JSON.stringify(metadata.version ?? null)}, manifest pins ${JSON.stringify(entry.version)}`
      );
    }
    const declared2 = metadata.skills.map((name) => validatePathComponent(name, `Pack ${entry.name} skill name`));
    if (new Set(declared2).size !== declared2.length) {
      throw new Error(`Pack ${entry.name} pack.toml declares duplicate skills`);
    }
    return declared2;
  }
  const declared = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const stat = lstatSync(join2(root, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!isRegularFile(join2(root, name, "SKILL.md"))) {
      if (!flatten || !hasFlattenableChildren(join2(root, name))) continue;
    }
    declared.push(validatePathComponent(name, `Pack ${entry.name} skill name`));
  }
  return declared;
}
function walkPackSubtree(root, relativeRoot, files, directories) {
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join2(directory, name);
      const key = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Pack payload may not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        directories.add(key);
        visit(path);
      } else if (stat.isFile()) {
        files.set(key, hashRegularFile(path));
      } else {
        throw new Error(`Pack payload may contain only regular files and directories: ${path}`);
      }
    }
  };
  directories.add(relativeRoot);
  visit(join2(root, relativeRoot));
}
function packPayload(root, metadata, declared, flatten = false) {
  const files = /* @__PURE__ */ new Map();
  const directories = /* @__PURE__ */ new Set();
  if (metadata) files.set("pack.toml", hashRegularFile(join2(root, "pack.toml")));
  for (const name of declared) {
    const skillDir = join2(root, name);
    assertRealDirectory(skillDir, `Pack skill ${name}`);
    if (!flatten && !isRegularFile(join2(skillDir, "SKILL.md"))) {
      throw new PackUnavailableError(`Pack skill ${name} is missing a regular SKILL.md: ${skillDir}`);
    }
    walkPackSubtree(root, name, files, directories);
  }
  return { files, directories };
}
function parsePackChecksums(root) {
  const raw = readRegularFile(join2(root, "SHA256SUMS")).toString("utf8");
  const expected = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS entry in ${root}: ${line}`);
    const path = safeRelativePath(match[2], "checksum path");
    if (expected.has(path)) throw new Error(`Duplicate SHA256SUMS entry in ${root}: ${path}`);
    expected.set(path, match[1]);
  }
  return expected;
}
function verifySealedPack(root, files, directories) {
  const expected = parsePackChecksums(root);
  const missing = [...files.keys()].filter((path) => !expected.has(path)).sort();
  if (missing.length) {
    throw new Error(`Pack payload at ${root} is not covered by SHA256SUMS: ${JSON.stringify(missing.slice(0, 5))}`);
  }
  for (const [path, digest] of files) {
    if (expected.get(path) !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }
  for (const path of [...expected.keys()].sort()) {
    if (files.has(path)) continue;
    const digest = expected.get(path);
    let actual;
    try {
      assertNoSymlinkComponents(root, path);
      actual = hashRegularFile(join2(root, path));
    } catch (error) {
      if (error instanceof PackUnavailableError) {
        throw new Error(`SHA256SUMS at ${root} references a missing path: ${path}`);
      }
      throw error;
    }
    if (actual !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }
  const covered = /* @__PURE__ */ new Set();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) covered.add(parts.slice(0, index).join("/"));
  }
  const unauthenticated = [...directories].filter((directory) => !covered.has(directory)).sort();
  if (unauthenticated.length) {
    throw new Error(
      `Pack at ${root} contains unauthenticated empty directories: ${JSON.stringify(unauthenticated.slice(0, 5))}`
    );
  }
}
function validatePack(packRoot, entry) {
  const root = resolve2(packRoot);
  assertRealDirectory(root, `Pack ${entry.name} root`);
  const metadata = readPackMetadata(root);
  const flatten = packFlattenEnabled(metadata, entry);
  const declared = packDeclaredSkills(root, metadata, entry, flatten);
  const sealed = entry.sealed === true || metadata?.sealed === true;
  const { files, directories } = packPayload(root, metadata, declared, flatten);
  if (metadata?.payloadFiles !== void 0) {
    const actual = [...files.keys()].filter((path) => path !== "pack.toml").length;
    if (actual !== metadata.payloadFiles) {
      throw new Error(`Pack at ${root} declares ${metadata.payloadFiles} payload files but has ${actual}`);
    }
  }
  if (sealed) {
    if (!isRegularFile(join2(root, "SHA256SUMS"))) throw new Error(`Sealed pack at ${root} has no regular SHA256SUMS`);
    verifySealedPack(root, files, directories);
  }
  const { inventory, warnings } = expandPackInventory(root, declared, entry, flatten);
  let members = inventory;
  if (entry.include) {
    const wanted = new Set(entry.include);
    members = members.filter((member) => wanted.has(member.name));
  }
  if (entry.exclude?.length) {
    const unwanted = new Set(entry.exclude);
    members = members.filter((member) => !unwanted.has(member.name));
  }
  const memberPaths = /* @__PURE__ */ new Map();
  for (const member of members) {
    memberPaths.set(member.name, join2(root, ...member.path.split("/")));
  }
  return {
    name: entry.name,
    version: entry.version,
    root,
    declared,
    inventory,
    inventoryNames: inventory.map((member) => member.name),
    members: members.map((member) => member.name),
    memberPaths,
    flatten,
    warnings,
    sealed,
    payloadFiles: [...files.keys()].filter((path) => path !== "pack.toml").length
  };
}

// src/parity/rules.ts
var BMAD_PACK_VERSION = "6.10.1-next.31";
var BMAD_PACK_NAME = "bmad";
var LINK_AGENTFILES_SCRIPT = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'";
var MATERIALIZE_ENV_SCRIPT_REL = ".mise/scripts/materialize-env.sh";
var OP_INJECT_SCRIPT = `'{{config_root}}/${MATERIALIZE_ENV_SCRIPT_REL}'`;
var PROVISION_PACKS_SCRIPT_REL = ".mise/scripts/provision-packs.py";
var LEGACY_PROVISION_SCRIPT_REL = ".mise/scripts/provision-bmad-skills.py";
var SYNC_SKILLS_SCRIPT_REL = ".mise/scripts/sync-skills.py";
var LINK_AGENTFILES_TASK = "link:agentfiles";
var SKILLS_SYNC_TASK = "skills:sync";
var PROVISION_PACKS_TASK = "skills:provision:packs";
var LEGACY_PROVISION_TASK = "skills-provision-bmad";
var RETIRED_TASK_RENAMES = [
  ["link-agentfiles", LINK_AGENTFILES_TASK],
  ["skills-sync", SKILLS_SYNC_TASK],
  ["skills-provision-packs", PROVISION_PACKS_TASK],
  ["hooks-sync", "hooks:sync"],
  ["hooks-check", "hooks:check"],
  ["hooks-uninstall", "hooks:uninstall"],
  ["hindsight-setup", "hindsight:setup"]
];
function taskHeader(name) {
  return `[tasks."${name}"]`;
}
function taskHeaderPattern(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]$`);
}
var PROVISION_PACKS_SCRIPT = `python3 '{{config_root}}/${PROVISION_PACKS_SCRIPT_REL}'`;
var LEGACY_PROVISION_BMAD_SKILLS_SCRIPT = `python3 '{{config_root}}/${LEGACY_PROVISION_SCRIPT_REL}'`;
var SYNC_SKILLS_SCRIPT = `python3 '{{config_root}}/${SYNC_SKILLS_SCRIPT_REL}' --scope project`;
var SKILLS_SCHEMA_URL = "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json";
var RETIRED_SKILLS_SCHEMA_URLS = [
  "https://raw.githubusercontent.com/skillex/schemas/main/skills.schema.json"
];
var SKILLS_REGISTRY_URL = "https://github.com/delorenj/skillex.git";
var SKILLS_BACKUP_DIRNAME = "skills.bak";
var SKILLS_REGISTRY_SKILL_DIRS = ["all-skills", "skills"];
var BMAD_SKILL_NAME_PREFIX = "bmad-";
var PROJECT_CLI_SKILL_DIRS = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".opencode/skills",
  ".kimi-code/skills"
];
var CANONICAL_CLI_SKILLS_ALIAS = "../.agents/skills";
var HOOKS_COMMENT_HEADER = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.`;
var LINK_AGENTFILES_HOOK_ENTRIES = [
  LINK_AGENTFILES_SCRIPT,
  PROVISION_PACKS_SCRIPT,
  SYNC_SKILLS_SCRIPT
];
var LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
patterns = ["AGENTS.md"]
task = "${LINK_AGENTFILES_TASK}"

[[watch_files]]
patterns = [".agents/skills.json"]
task = "${SKILLS_SYNC_TASK}"

${taskHeader(LINK_AGENTFILES_TASK)}
description = "Symlink all agent files to AGENTS.md"
run = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'"

${taskHeader(SKILLS_SYNC_TASK)}
description = "Sync skills from manifest to local CLI dirs"
depends = ["${PROVISION_PACKS_TASK}"]
run = ${JSON.stringify(SYNC_SKILLS_SCRIPT)}

${taskHeader(PROVISION_PACKS_TASK)}
description = "Provision every Skillex pack declared in .agents/skills.json"
run = ${JSON.stringify(PROVISION_PACKS_SCRIPT)}`;
var VERSIONING_BLOCK = `# >>> mise-versioning >>>  (managed block \u2014 do not edit by hand; re-run init to update)
[tasks."version"]
description = "Print the current version (vX.Y.Z)"
run = "'{{config_root}}/.mise/scripts/versioning.sh' current"

[tasks."version:bump"]
description = "Bump patch version: vX.Y.Z -> vX.Y.(Z+1)"
alias = "version:bump-patch"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump patch"

[tasks."version:bump-minor"]
description = "Bump minor version: vX.Y.Z -> vX.(Y+1).0"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump minor"

[tasks."version:bump-major"]
description = "Bump major version: vX.Y.Z -> v(X+1).0.0"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump major"

[tasks."version:check"]
description = "Verify every versioned file is in parity"
run = "'{{config_root}}/.mise/scripts/versioning.sh' check"

[tasks."version:sync"]
description = "Force every versioned file up to the highest version"
run = "'{{config_root}}/.mise/scripts/versioning.sh' sync"
# <<< mise-versioning <<<`;
function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n");
}
function readText(path) {
  return normalizeNewlines(readFileSync2(path, "utf8"));
}
function safeReadText(path) {
  return existsSync2(path) ? readText(path) : null;
}
function ensureParent(path) {
  mkdirSync2(dirname2(path), { recursive: true });
}
function writeText(path, content) {
  ensureParent(path);
  writeFileSync2(path, content);
}
function tryParseJson(text2) {
  if (!text2) return null;
  try {
    return JSON.parse(text2);
  } catch {
    return null;
  }
}
function slugifyRepoName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function titleCaseSlug(slug) {
  return slug.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function readSymlinkTarget(path) {
  if (!existsSync2(path)) return null;
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
function ensureSymlink(path, target, dryRun) {
  if (existsSync2(path)) {
    const stat = lstatSync2(path);
    if (stat.isSymbolicLink()) {
      const current = readSymlinkTarget(path);
      if (current === target) return { changed: false };
      if (!dryRun) {
        unlinkSync(path);
        symlinkSync(target, path);
      }
      return { changed: true };
    }
    return { changed: false, blocked: `${relative2(process.cwd(), path) || path} exists and is not a symlink` };
  }
  if (!dryRun) symlinkSync(target, path);
  return { changed: true };
}
function bootstrapAgentsFile(repoRoot, dryRun) {
  const agentsPath = join3(repoRoot, "AGENTS.md");
  if (existsSync2(agentsPath)) return { changedFiles: [], details: [] };
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const source = join3(repoRoot, file);
    if (!existsSync2(source)) continue;
    const stat = lstatSync2(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!dryRun) renameSync(source, agentsPath);
      return { changedFiles: [agentsPath], details: [`Moved ${file} to AGENTS.md before wiring agent-file symlinks`] };
    }
    return { changedFiles: [], details: [], blocked: `${file} exists but is not a regular file; cannot promote to AGENTS.md` };
  }
  const readmePath = join3(repoRoot, "README.md");
  if (existsSync2(readmePath)) {
    const stat = lstatSync2(readmePath);
    if (!stat.isFile()) return { changedFiles: [], details: [], blocked: "README.md exists but is not a regular file; cannot copy to AGENTS.md" };
    if (!dryRun) copyFileSync(readmePath, agentsPath);
    return { changedFiles: [agentsPath], details: ["Copied README.md to AGENTS.md before wiring agent-file symlinks"] };
  }
  return { changedFiles: [], details: [], blocked: "AGENTS.md missing and no CLAUDE.md, GEMINI.md, or README.md source exists" };
}
function yamlGet(text2, keyPath) {
  const parts = keyPath.split(".");
  const lines = text2.split("\n");
  let start = 0;
  let indent = 0;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const key = parts[idx];
    let found = false;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const currentIndent = match[1].length;
      const currentKey = match[2].trim();
      const rest = match[3].trim();
      if (idx > 0 && currentIndent < indent) break;
      if (currentIndent !== indent || currentKey !== key) continue;
      found = true;
      if (idx === parts.length - 1) {
        return rest.replace(/^['"]|['"]$/g, "").trim();
      }
      start = i + 1;
      indent = currentIndent + 2;
      break;
    }
    if (!found) return "";
  }
  return "";
}
function discoverRoles(repoRoot) {
  const rolesDir = join3(repoRoot, "agents", "hermes");
  if (!existsSync2(rolesDir)) return [];
  return readdirSync2(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const roleDir = join3(rolesDir, entry.name);
    const roleYamlPath = join3(roleDir, "role.yaml");
    if (!existsSync2(roleYamlPath)) return null;
    const text2 = readText(roleYamlPath);
    const runtimeRepoRaw = yamlGet(text2, "runtime.github_repo");
    return {
      role: yamlGet(text2, "role") || entry.name,
      roleDir,
      roleYamlPath,
      repo: yamlGet(text2, "repo"),
      agentId: yamlGet(text2, "agent_id"),
      profileName: yamlGet(text2, "profile") || yamlGet(text2, "agent_id"),
      displayName: yamlGet(text2, "display_name"),
      purpose: yamlGet(text2, "purpose"),
      botHandle: yamlGet(text2, "telegram.bot_username"),
      runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
      runtimeOwner: yamlGet(text2, "runtime.github_owner"),
      planeWorkspace: yamlGet(text2, "ticket_provider.workspace") || yamlGet(text2, "plane.workspace"),
      ticketProviderName: yamlGet(text2, "ticket_provider.name"),
      ticketProviderBoardId: yamlGet(text2, "ticket_provider.board_id"),
      ticketProviderIdentifier: yamlGet(text2, "plane.identifier"),
      bloodbankEnabled: yamlGet(text2, "bloodbank.enabled"),
      deploymentSystemd: yamlGet(text2, "deployment.systemd"),
      legacyReconcileEnabled: yamlGet(text2, "reconcile.enabled"),
      legacyReconcileGraceHours: yamlGet(text2, "reconcile.grace_hours"),
      legacyReconcileAutoReview: yamlGet(text2, "reconcile.auto_review"),
      legacyScrumGraceHours: yamlGet(text2, "scrum_master.grace_hours"),
      legacyScrumAutoReview: yamlGet(text2, "scrum_master.auto_review")
    };
  }).filter((value) => Boolean(value));
}
function registryPath(homeDir) {
  return join3(homeDir, ".hermes", "agents-registry.yaml");
}
var LEGACY_SYSTEMD_KEYS = ["consumer_unit", "checkpoint_timer"];
function legacyConsumerUnitPath(homeDir, agentId) {
  return join3(homeDir, ".config", "systemd", "user", `hermes-${agentId}-consumer.service`);
}
function systemctlUser(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}
function templateScript(ctx, name) {
  const source = join3(ctx.pjanglerRoot, ".mise", "scripts", name);
  return existsSync2(source) ? readText(source) : void 0;
}
function templateVersioningScript(ctx) {
  return templateScript(ctx, "versioning.sh");
}
function templateLinkAgentfilesScript(ctx) {
  return templateScript(ctx, "link-agentfiles.sh");
}
function templateMaterializeEnvScript(ctx) {
  const source = join3(ctx.pjanglerRoot, "templates", "commonproject", "template", MATERIALIZE_ENV_SCRIPT_REL);
  return existsSync2(source) ? readText(source) : void 0;
}
function resolveAgentHooksLayer(ctx) {
  const override = process.env.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  if (existsSync2(join3(ctx.repoRoot, ".agents", "hooks", "sync.py"))) return true;
  return !existsSync2(join3(ctx.homeDir, ".agents", "hooks"));
}
function evaluateMiseConditionals(template, agentHooksLayer) {
  const out = [];
  let depth = 0;
  let skipDepth = 0;
  for (const line of template.split("\n")) {
    const stmt = line.trim();
    const ifMatch = /^\{%-?\s*if\s+(\w+)\s*-?%\}$/.exec(stmt);
    if (ifMatch) {
      depth += 1;
      const truthy = ifMatch[1] === "agent_hooks_layer" ? agentHooksLayer : false;
      if (skipDepth === 0 && !truthy) skipDepth = depth;
      continue;
    }
    if (/^\{%-?\s*endif\s*-?%\}$/.test(stmt)) {
      if (skipDepth === depth) skipDepth = 0;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (skipDepth === 0) out.push(line);
  }
  return out.join("\n");
}
function renderGeneratedProjectMiseToml(ctx, template) {
  const project = readProjectJson(ctx);
  const projectName = String(project?.project_name ?? basename2(ctx.repoRoot) ?? "project");
  return evaluateMiseConditionals(template, resolveAgentHooksLayer(ctx)).replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1").replace(/\{\{\s*project_name\s*\}\}/g, projectName);
}
function ensureMiseTomlFromTemplate(ctx, changedFiles) {
  const targetPath = join3(ctx.repoRoot, "mise.toml");
  if (existsSync2(targetPath)) return false;
  const sourcePath = join3(ctx.pjanglerRoot, "templates", "commonproject", "template", "mise.toml.jinja");
  if (!existsSync2(sourcePath)) return false;
  changedFiles.push(targetPath);
  if (!ctx.dryRun) {
    writeText(targetPath, renderGeneratedProjectMiseToml(ctx, readText(sourcePath)));
  }
  return true;
}
function templateCommonProjectText(ctx, rel) {
  const path = join3(ctx.pjanglerRoot, "templates", "commonproject", "template", rel);
  return existsSync2(path) ? readText(path) : void 0;
}
function validateSkillName(name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename2(name) !== name) {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
  return name;
}
function lstatIfPresent(path) {
  try {
    return lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function isContainedBy(root, target) {
  const rel = relative2(root, target);
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
function prepareSafeProjectSkillsDirs(ctx) {
  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsDir = join3(projectRoot, ".agents");
  const skillsDir = join3(agentsDir, "skills");
  for (const path of [agentsDir, skillsDir]) {
    if (!isContainedBy(projectRoot, path)) throw new Error(`Project skills path escapes repository: ${path}`);
    const stat = lstatIfPresent(path);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlinked project skills directory: ${path}`);
    if (stat && !stat.isDirectory()) throw new Error(`Project skills path is not a directory: ${path}`);
  }
  if (!ctx.dryRun) {
    if (!existsSync2(agentsDir)) mkdirSync2(agentsDir, { recursive: false });
    if (!existsSync2(skillsDir)) mkdirSync2(skillsDir, { recursive: false });
    for (const path of [agentsDir, skillsDir]) {
      if (lstatSync2(path).isSymbolicLink() || !lstatSync2(path).isDirectory()) {
        throw new Error(`Unsafe project skills directory after creation: ${path}`);
      }
      if (!isContainedBy(projectRoot, realpathSync(path))) {
        throw new Error(`Resolved project skills directory escapes repository: ${path}`);
      }
    }
  }
  return { agentsDir, skillsDir };
}
function projectSkillTopologyIssues(repoRoot) {
  const issues = [];
  let projectRoot;
  try {
    projectRoot = realpathSync(repoRoot);
  } catch (error) {
    return [`Project root is not a readable real directory: ${error instanceof Error ? error.message : String(error)}`];
  }
  const managedSkills = join3(projectRoot, ".agents", "skills");
  for (const rel of PROJECT_CLI_SKILL_DIRS) {
    const cliDir = join3(projectRoot, rel);
    const parent = dirname2(cliDir);
    const parentStat = lstatIfPresent(parent);
    if (!parentStat) continue;
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      issues.push(`${rel} has an unsafe symlinked/non-directory parent`);
      continue;
    }
    if (!isContainedBy(projectRoot, realOrSelf(parent))) {
      issues.push(`${rel} parent resolves outside the project`);
      continue;
    }
    const stat = lstatIfPresent(cliDir);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      let rawTarget = "";
      try {
        rawTarget = readlinkSync(cliDir);
      } catch {
        issues.push(`${rel} is an unreadable skills directory symlink`);
        continue;
      }
      if (rawTarget !== CANONICAL_CLI_SKILLS_ALIAS) {
        issues.push(`${rel} is an unsupported skills directory symlink`);
        continue;
      }
      const managedStat = lstatIfPresent(managedSkills);
      if (!managedStat || managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
        issues.push(`${rel} canonical alias target .agents/skills is missing or unsafe`);
        continue;
      }
      try {
        if (realpathSync(cliDir) !== realpathSync(managedSkills)) {
          issues.push(`${rel} canonical alias resolves outside .agents/skills`);
        }
      } catch {
        issues.push(`${rel} canonical alias is broken`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      issues.push(`${rel} is not a directory`);
      continue;
    }
    if (!isContainedBy(projectRoot, realOrSelf(cliDir))) {
      issues.push(`${rel} resolves outside the project`);
    }
  }
  return issues;
}
function packRootOverride(name) {
  const generic = process.env[`PJ_PACK_ROOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]?.trim();
  if (generic) return resolve3(generic);
  if (name === BMAD_PACK_NAME) {
    const legacy = process.env.PJ_BMAD_PACK_ROOT?.trim();
    if (legacy) return resolve3(legacy);
  }
  return void 0;
}
function bmadPackEntry() {
  return { name: BMAD_PACK_NAME, version: BMAD_PACK_VERSION, optional: false, sealed: true, flatten: false };
}
function packMemberPath(pack, name) {
  const target = pack.memberPaths.get(validateSkillName(name));
  if (!target) throw new Error(`Pack ${pack.name} has no resolved path for member ${JSON.stringify(name)}`);
  return target;
}
function packProjectionSignature(pack) {
  return JSON.stringify(pack.members.map((name) => [name, pack.memberPaths.get(name) ?? null]));
}
function registryCacheDirName(registryUrl) {
  const cacheName = registryUrl.replace(/[^a-zA-Z0-9]/g, "_");
  if (!cacheName) {
    throw new Error(`Registry URL has no usable cache directory name: ${JSON.stringify(registryUrl)}`);
  }
  return cacheName;
}
function packRegistryRoots(ctx, registryUrl) {
  const explicit = process.env.PJ_SKILLS_REGISTRY_ROOT?.trim();
  if (explicit) return [resolve3(explicit)];
  const cacheName = registryCacheDirName(registryUrl);
  return [
    join3(ctx.homeDir, ".agents", ".cache", "registries", cacheName),
    join3(ctx.homeDir, "code", "skillex")
  ];
}
function resolvePackRoot(ctx, entry) {
  const override = packRootOverride(entry.name);
  if (override) {
    assertRealDirectory(override, `Pack ${entry.name} root`);
    return { root: override, description: "env override" };
  }
  if (entry.source) {
    if (entry.source.startsWith("file:")) {
      let local;
      try {
        local = resolve3(fileURLToPath(entry.source));
      } catch (error) {
        throw new Error(`Pack ${entry.name} source is not a usable file URI: ${entry.source}`);
      }
      assertRealDirectory(local, `Pack ${entry.name} root`);
      return { root: local, description: entry.source };
    }
    const cached = join3(ctx.homeDir, ".agents", ".cache", "skills", validatePathComponent(entry.name, "Pack name"));
    assertRealDirectory(cached, `Pack ${entry.name} clone cache`);
    return { root: cached, description: entry.source };
  }
  const registryUrl = entry.registry ?? SKILLS_REGISTRY_URL;
  const matches = [];
  let firstUnavailable;
  for (const candidate of packRegistryRoots(ctx, registryUrl)) {
    const stat = lstatIfPresent(candidate);
    if (!stat || !(stat.isDirectory() || stat.isSymbolicLink() && existsSync2(candidate))) continue;
    try {
      matches.push(resolvePackRootInRegistry(realpathSync(candidate), entry));
    } catch (error) {
      if (!(error instanceof PackUnavailableError)) throw error;
      firstUnavailable ??= error;
    }
  }
  if (!matches.length) {
    throw firstUnavailable ?? new PackUnavailableError(`No registry checkout available for ${registryUrl}`);
  }
  const chosen = matches.find((match) => match.attested) ?? matches[0];
  return { root: chosen.root, description: `${registryUrl}:${chosen.relativePath}` };
}
function packRootAttests(root, entry) {
  const metadata = readPackMetadata(root);
  if (!metadata) return false;
  if (metadata.name !== entry.name) {
    throw new Error(
      `Pack ${entry.name} pack.toml declares name ${JSON.stringify(metadata.name)}`
    );
  }
  if (entry.version && metadata.version !== entry.version) {
    throw new Error(
      `Pack ${entry.name} pack.toml declares version ${JSON.stringify(metadata.version)}, manifest pins ${JSON.stringify(entry.version)}`
    );
  }
  return true;
}
function resolvePackRootInRegistry(registryRoot, entry) {
  let relativePath;
  if (entry.registryPath) {
    relativePath = safeRelativePath(entry.registryPath, `pack ${entry.name} registry_path`);
  } else {
    relativePath = `packs/${entry.name}`;
    const packDir = join3(registryRoot, relativePath);
    assertNoSymlinkComponents(registryRoot, relativePath);
    assertRealDirectory(packDir, `Pack ${entry.name} directory`);
    if (entry.version) {
      relativePath = `${relativePath}/${entry.version}`;
    } else if (!isRegularFile(join3(packDir, "pack.toml"))) {
      const selected = selectPackVersion(packDir);
      if (selected !== null) relativePath = `${relativePath}/${selected}`;
    }
  }
  assertNoSymlinkComponents(registryRoot, relativePath);
  const root = join3(registryRoot, relativePath);
  assertRealDirectory(root, `Pack ${entry.name} root`);
  return { root, relativePath, attested: packRootAttests(root, entry) };
}
function manifestPackEntries(manifest) {
  const raw = manifest?.packs;
  if (raw === void 0 || raw === null) return { entries: [], errors: [] };
  if (!Array.isArray(raw)) return { entries: [], errors: [".agents/skills.json packs must be an array"] };
  const entries = [];
  const errors = [];
  for (const item of raw) {
    try {
      entries.push(normalizePackEntry(item));
    } catch (error) {
      errors.push(`.agents/skills.json packs[] entry is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}
function buildPackPlan(ctx, manifest) {
  const plan = {
    manifestSkills: [],
    projections: /* @__PURE__ */ new Map(),
    ownershipRoots: [],
    implicitRoots: [],
    resolved: [],
    declared: [],
    errors: [],
    warnings: [],
    packWarnings: [],
    bmadDeclared: false
  };
  const { entries, errors } = manifestPackEntries(manifest);
  plan.errors.push(...errors);
  plan.bmadDeclared = entries.some((entry) => entry.name === BMAD_PACK_NAME);
  if (!plan.bmadDeclared) {
    const entry = bmadPackEntry();
    let root;
    try {
      root = resolvePackRoot(ctx, entry).root;
      const pack = validatePack(root, entry);
      const resolved = { entry, root, pack };
      plan.resolved.push(resolved);
      plan.implicitRoots.push(root);
      plan.ownershipRoots.push(root);
      plan.packWarnings.push(...pack.warnings);
      for (const name of pack.members) {
        const target = packMemberPath(pack, name);
        plan.projections.set(name, target);
        plan.manifestSkills.push({ name, source: pathToFileURL(target).href });
      }
    } catch (error) {
      plan.errors.push(
        `BMAD Skillex pack ${BMAD_PACK_VERSION} is not trusted at ${root ?? "its resolved pack root"}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  for (const entry of entries) {
    try {
      const { root } = resolvePackRoot(ctx, entry);
      const pack = validatePack(root, entry);
      const familyRoot = basename2(dirname2(root)) === entry.name ? dirname2(root) : void 0;
      const resolved = { entry, root, pack, familyRoot };
      plan.resolved.push(resolved);
      plan.declared.push(resolved);
      plan.ownershipRoots.push(root);
      if (familyRoot) plan.ownershipRoots.push(familyRoot);
      plan.packWarnings.push(...pack.warnings);
      for (const name of pack.members) {
        plan.projections.set(name, packMemberPath(pack, name));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (entry.optional && error instanceof PackUnavailableError) {
        plan.warnings.push(`Optional pack ${entry.name} is unavailable and was skipped: ${message}`);
      } else {
        plan.errors.push(`Skillex pack ${entry.name} could not be resolved: ${message}`);
      }
    }
  }
  if (plan.declared.length) {
    const managedNames = new Set(plan.manifestSkills.map((entry) => entry.name));
    for (const entry of Array.isArray(manifest?.skills) ? manifest.skills : []) {
      const name = skillManifestEntryName(entry);
      if (!name || !plan.projections.has(name)) continue;
      if (managedNames.has(name) || isRedundantDeclaredPackEntry(entry, plan)) continue;
      plan.projections.delete(name);
    }
  }
  return plan;
}
function assertPackPlanUnchanged(plan) {
  for (const item of plan.resolved) {
    const again = validatePack(item.root, item.entry);
    if (packProjectionSignature(again) !== packProjectionSignature(item.pack)) {
      throw new Error(`Pack ${item.entry.name} inventory changed after preflight`);
    }
  }
}
function skillManifestEntryName(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return void 0;
  const name = entry.name;
  return typeof name === "string" ? name : void 0;
}
function manifestEntrySourcePath(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const source = entry.source;
  if (typeof source !== "string" || !source.startsWith("file:")) return void 0;
  try {
    return resolve3(fileURLToPath(source));
  } catch {
    return void 0;
  }
}
function isPackManagedManifestEntry(entry, expectedNames, packRoots) {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  if (expectedNames.has(name)) return true;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  return basename2(sourcePath) === name && packRoots.some((root) => isContainedBy(root, sourcePath));
}
function isRedundantDeclaredPackEntry(entry, plan) {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  for (const declared of plan.declared) {
    if (isContainedBy(declared.pack.root, sourcePath)) return true;
    if (declared.familyRoot && declared.pack.inventoryNames.includes(name) && isContainedBy(declared.familyRoot, sourcePath)) {
      return true;
    }
  }
  return false;
}
function canonicalSkillsManifest(ctx, current, plan = buildPackPlan(ctx, current)) {
  const existing = Array.isArray(current?.skills) ? current.skills : [];
  const expectedNames = new Set(plan.manifestSkills.map((entry) => entry.name));
  return `${JSON.stringify(
    {
      ...current ?? {},
      $schema: SKILLS_SCHEMA_URL,
      inherit_global: true,
      registry: SKILLS_REGISTRY_URL,
      skills: [
        ...existing.filter(
          (entry) => !isPackManagedManifestEntry(entry, expectedNames, plan.implicitRoots) && !isRedundantDeclaredPackEntry(entry, plan)
        ),
        ...plan.manifestSkills
      ]
    },
    null,
    2
  )}
`;
}
function skillsBackupDir(repoRoot) {
  return join3(repoRoot, ".agents", SKILLS_BACKUP_DIRNAME);
}
function skillsRegistryRoots(ctx) {
  return packRegistryRoots(ctx, SKILLS_REGISTRY_URL);
}
function availableSkillsRegistryRoots(ctx) {
  return skillsRegistryRoots(ctx).filter(
    (root) => SKILLS_REGISTRY_SKILL_DIRS.some((dir) => existsSync2(join3(root, dir)))
  );
}
function digestSkillEntry(root) {
  const hash = createHash2("sha256");
  try {
    const stat = lstatSync2(root);
    if (stat.isSymbolicLink()) return null;
    if (stat.isFile()) {
      const content = readFileSync2(root);
      hash.update(`file\0\0${content.length}\0`);
      hash.update(content);
      return hash.digest("hex");
    }
    if (!stat.isDirectory()) return null;
    const walk = (dir, rel) => {
      for (const name of readdirSync2(dir).sort()) {
        const full = join3(dir, name);
        const entryRel = rel ? `${rel}/${name}` : name;
        const entryStat = lstatSync2(full);
        if (entryStat.isSymbolicLink()) return false;
        if (entryStat.isDirectory()) {
          hash.update(`dir\0${entryRel}\0`);
          if (!walk(full, entryRel)) return false;
        } else if (entryStat.isFile()) {
          const content = readFileSync2(full);
          hash.update(`file\0${entryRel}\0${content.length}\0`);
          hash.update(content);
        } else {
          return false;
        }
      }
      return true;
    };
    hash.update("dir\0");
    return walk(root, "") ? hash.digest("hex") : null;
  } catch {
    return null;
  }
}
function legacyCommittedSkillNames(skillsDir, backupDir, expectedNames, packRoots, manifestNames) {
  const stat = lstatIfPresent(skillsDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
  const names = [];
  let entries;
  try {
    entries = readdirSync2(skillsDir).sort();
  } catch {
    return [];
  }
  for (const name of entries) {
    if (expectedNames.has(name) || manifestNames.has(name)) continue;
    if (name.startsWith(BMAD_SKILL_NAME_PREFIX)) continue;
    const path = join3(skillsDir, name);
    let linkTarget = null;
    try {
      linkTarget = lstatSync2(path).isSymbolicLink() ? resolve3(dirname2(path), readlinkSync(path)) : null;
    } catch {
      linkTarget = null;
    }
    if (linkTarget && (packRoots.some((root) => isContainedBy(root, linkTarget)) || isContainedBy(backupDir, linkTarget))) {
      continue;
    }
    names.push(name);
  }
  return names;
}
function planLegacyCommittedSkill(skillsDir, backupDir, registryRoots, name) {
  const backupTarget = join3(backupDir, name);
  const localDescription = (reason) => `${name} -> file://${backupTarget} (${reason}; kept local)`;
  const digest = digestSkillEntry(join3(skillsDir, name));
  if (!digest) {
    return { name, description: localDescription("entry is a symlink or is not byte-comparable") };
  }
  if (!registryRoots.length) {
    return { name, description: localDescription("no local registry checkout to compare against") };
  }
  for (const root of registryRoots) {
    for (const dir of SKILLS_REGISTRY_SKILL_DIRS) {
      const candidate = join3(root, dir, name);
      if (!existsSync2(candidate)) continue;
      if (digestSkillEntry(candidate) !== digest) continue;
      return {
        name,
        registryPath: `${dir}/${name}`,
        description: `${name} -> registry_path ${dir}/${name} (exact content match)`
      };
    }
  }
  return { name, description: localDescription("no exact registry content match") };
}
function migrateLegacyCommittedSkills(ctx, changedFiles) {
  const details = [];
  const agentsDir = join3(ctx.repoRoot, ".agents");
  const skillsDir = join3(agentsDir, "skills");
  const backupDir = skillsBackupDir(ctx.repoRoot);
  const manifestPath = join3(agentsDir, "skills.json");
  const rawManifest = safeReadText(manifestPath);
  const manifest = tryParseJson(rawManifest);
  if (rawManifest !== null && manifest === null) {
    return details;
  }
  const packPlan = buildPackPlan(ctx, manifest);
  const expectedNames = new Set(packPlan.projections.keys());
  const manifestSkills = Array.isArray(manifest?.skills) ? [...manifest.skills] : [];
  const manifestNames = new Set(
    manifestSkills.map(skillManifestEntryName).filter((name) => Boolean(name))
  );
  const names = legacyCommittedSkillNames(skillsDir, backupDir, expectedNames, packPlan.ownershipRoots, manifestNames);
  if (!names.length) return details;
  const registryRoots = availableSkillsRegistryRoots(ctx);
  if (!registryRoots.length) {
    details.push(
      `No local ${SKILLS_REGISTRY_URL} checkout is available; registry matching is skipped (set PJ_SKILLS_REGISTRY_ROOT or let skills-sync clone the registry)`
    );
  }
  const plans = names.map((name) => planLegacyCommittedSkill(skillsDir, backupDir, registryRoots, name));
  if (!ctx.acceptRegistryMatches) {
    for (const plan of plans) details.push(`proposed mapping: ${plan.description}`);
    details.push(
      `${plans.length} legacy committed skill(s) left untouched; re-run with --accept-registry-matches to apply`
    );
    return details;
  }
  const applied = [];
  for (const plan of plans) {
    const from = join3(skillsDir, plan.name);
    const to = join3(backupDir, plan.name);
    if (lstatIfPresent(to)) {
      details.push(`skipped ${plan.name}: ${to} already exists and would be overwritten`);
      continue;
    }
    if (!changedFiles.includes(to)) changedFiles.push(to);
    if (!ctx.dryRun) {
      mkdirSync2(backupDir, { recursive: true });
      renameSync(from, to);
    }
    manifestSkills.push(
      plan.registryPath ? { name: plan.name, registry_path: plan.registryPath } : { name: plan.name, source: pathToFileURL(to).href }
    );
    applied.push(plan);
    details.push(`mapped ${plan.description}`);
  }
  if (!applied.length) return details;
  const merged = { ...manifest ?? {}, skills: manifestSkills };
  let nextManifest;
  try {
    nextManifest = canonicalSkillsManifest(ctx, merged);
  } catch {
    nextManifest = `${JSON.stringify(merged, null, 2)}
`;
  }
  if (nextManifest !== rawManifest) {
    if (!changedFiles.includes(manifestPath)) changedFiles.push(manifestPath);
    if (!ctx.dryRun) writeText(manifestPath, nextManifest);
  }
  return details;
}
function removeProjectEntry(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function normalizeExecutableTemplate(ctx, target, expected, changedFiles) {
  const stat = lstatIfPresent(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Refusing non-regular managed executable target: ${target}`);
  }
  const contentChanged = !stat || safeReadText(target) !== expected;
  const modeChanged = !stat || (Number(stat.mode) & 73) === 0;
  if (!contentChanged && !modeChanged) return;
  if (!changedFiles.includes(target)) changedFiles.push(target);
  if (ctx.dryRun) return;
  if (contentChanged) {
    writeText(target, expected);
  }
  const beforeChmod = lstatIfPresent(target);
  if (!beforeChmod?.isFile() || beforeChmod.isSymbolicLink()) {
    throw new Error(`Refusing changed managed executable target: ${target}`);
  }
  chmodSync(target, 493);
}
function atomicWriteBuffer(path, content, mode, temporary) {
  writeFileSync2(temporary, content, { flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}
function provisionBmadSkills(ctx, preservedManifest, hooks = {}) {
  let initialDirs;
  try {
    initialDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const initialManifestPath = join3(initialDirs.agentsDir, "skills.json");
  const initialManifestStat = lstatIfPresent(initialManifestPath);
  if (initialManifestStat?.isSymbolicLink() || initialManifestStat && !initialManifestStat.isFile()) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${initialManifestPath}` };
  }
  const declaringManifest = preservedManifest ?? tryParseJson(initialManifestStat ? readRegularFile(initialManifestPath).toString("utf8") : null);
  const plan = buildPackPlan(ctx, declaringManifest);
  if (plan.errors.length) {
    return { ok: false, changedFiles: [], error: plan.errors.join("; ") };
  }
  const packSkills = plan.manifestSkills;
  hooks.afterPreflight?.();
  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsPath = join3(projectRoot, ".agents");
  const skillsPath = join3(agentsPath, "skills");
  const agentsExisted = Boolean(lstatIfPresent(agentsPath));
  const skillsExisted = Boolean(lstatIfPresent(skillsPath));
  let preflightDirs;
  try {
    preflightDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const manifestPath = join3(preflightDirs.agentsDir, "skills.json");
  const manifestStat = lstatIfPresent(manifestPath);
  if (manifestStat?.isSymbolicLink() || manifestStat && !manifestStat.isFile()) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${manifestPath}` };
  }
  const manifestBytes = manifestStat ? readRegularFile(manifestPath) : null;
  const manifestMode = manifestStat ? Number(manifestStat.mode) & 511 : 420;
  let currentManifest = {};
  if (manifestBytes !== null) {
    try {
      const parsed = JSON.parse(manifestBytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain a JSON object");
      currentManifest = parsed;
      if (currentManifest.skills !== void 0 && !Array.isArray(currentManifest.skills)) throw new Error("skills must be an array");
    } catch (error) {
      return { ok: false, changedFiles: [], error: `Invalid existing skills manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  let safeDirs;
  try {
    safeDirs = prepareSafeProjectSkillsDirs(ctx);
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const nextManifest = canonicalSkillsManifest(ctx, preservedManifest ?? currentManifest, plan);
  const skillsDir = safeDirs.skillsDir;
  const resolvedSkillsDir = ctx.dryRun && !existsSync2(skillsDir) ? skillsDir : realpathSync(skillsDir);
  const expected = new Map(plan.projections);
  const expectedNames = new Set(expected.keys());
  const ownershipManifest = preservedManifest ?? currentManifest;
  const managedManifestNames = new Set(
    (Array.isArray(ownershipManifest.skills) ? ownershipManifest.skills : []).filter((entry) => isPackManagedManifestEntry(entry, expectedNames, plan.ownershipRoots)).map(skillManifestEntryName).filter((name) => Boolean(name))
  );
  const affected = /* @__PURE__ */ new Set();
  const staleManagedNames = /* @__PURE__ */ new Set();
  const originalCorrectLinks = /* @__PURE__ */ new Map();
  if (existsSync2(skillsDir)) {
    for (const name of readdirSync2(skillsDir)) {
      validateSkillName(name);
      if (dirname2(join3(resolvedSkillsDir, name)) !== resolvedSkillsDir) {
        return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
      }
      const entryPath = join3(skillsDir, name);
      let linkTargetsPack = false;
      try {
        const linkTarget = lstatSync2(entryPath).isSymbolicLink() ? resolve3(dirname2(entryPath), readlinkSync(entryPath)) : null;
        linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget));
      } catch {
        linkTargetsPack = false;
      }
      if (!expected.has(name) && !managedManifestNames.has(name) && !linkTargetsPack) continue;
      const target = expected.get(name);
      let correct = false;
      try {
        correct = Boolean(target) && lstatSync2(entryPath).isSymbolicLink() && resolve3(dirname2(entryPath), readlinkSync(entryPath)) === target;
      } catch {
        correct = false;
      }
      if (correct) originalCorrectLinks.set(name, readlinkSync(join3(skillsDir, name)));
      else {
        affected.add(name);
        if (!target) staleManagedNames.add(name);
      }
    }
  }
  for (const [name, target] of expected) {
    const link = join3(resolvedSkillsDir, validateSkillName(name));
    if (dirname2(link) !== resolvedSkillsDir) {
      return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
    }
    let correct = false;
    try {
      correct = lstatSync2(link).isSymbolicLink() && resolve3(dirname2(link), readlinkSync(link)) === target;
    } catch {
      correct = false;
    }
    if (!correct) affected.add(name);
  }
  const manifestChanged = manifestBytes?.toString("utf8") !== nextManifest;
  const changedFiles = [
    ...manifestChanged ? [manifestPath] : [],
    ...affected.size ? [skillsDir] : []
  ];
  if (ctx.dryRun || changedFiles.length === 0) {
    try {
      assertPackPlanUnchanged(plan);
      return { ok: true, changedFiles, packWarnings: plan.packWarnings };
    } catch (error) {
      return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  const transaction = mkdtempSync(join3(safeDirs.agentsDir, ".bmad-transaction-"));
  const backup = join3(transaction, "entries");
  mkdirSync2(backup);
  const moved = [];
  const rollback = () => {
    const errors = [];
    try {
      for (const name of affected) {
        removeProjectEntry(join3(skillsDir, validateSkillName(name)));
      }
      for (const name of originalCorrectLinks.keys()) {
        removeProjectEntry(join3(skillsDir, validateSkillName(name)));
      }
    } catch (error) {
      errors.push(`remove applied projection: ${String(error)}`);
    }
    for (const name of [...moved].reverse()) {
      try {
        renameSync(join3(backup, name), join3(skillsDir, name));
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    for (const [name, rawTarget] of originalCorrectLinks) {
      try {
        symlinkSync(rawTarget, join3(skillsDir, name), "dir");
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    try {
      if (manifestBytes === null) removeProjectEntry(manifestPath);
      else atomicWriteBuffer(manifestPath, manifestBytes, manifestMode, join3(transaction, "manifest.restore"));
    } catch (error) {
      errors.push(`restore manifest: ${String(error)}`);
    }
    rmSync(transaction, { recursive: true, force: true });
    try {
      if (!skillsExisted && existsSync2(skillsDir) && readdirSync2(skillsDir).length === 0) rmdirSync(skillsDir);
      if (!agentsExisted && existsSync2(safeDirs.agentsDir) && readdirSync2(safeDirs.agentsDir).length === 0) rmdirSync(safeDirs.agentsDir);
    } catch (error) {
      errors.push(`remove created directories: ${String(error)}`);
    }
    if (errors.length) throw new Error(`BMAD rollback was incomplete: ${errors.join("; ")}`);
  };
  try {
    for (const name of affected) {
      const entry = join3(skillsDir, name);
      if (lstatIfPresent(entry)) {
        renameSync(entry, join3(backup, name));
        moved.push(name);
      }
    }
    let index = 0;
    for (const [name, target] of expected) {
      index += 1;
      const link = join3(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync2(link).isSymbolicLink() && resolve3(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (correct) continue;
      if (hooks.createLink) hooks.createLink(target, link, index);
      else symlinkSync(target, link, "dir");
    }
    if (manifestChanged) {
      atomicWriteBuffer(manifestPath, Buffer.from(nextManifest), manifestMode, join3(transaction, "manifest.next"));
    }
    assertPackPlanUnchanged(plan);
    hooks.afterApply?.(manifestPath, skillsDir);
    for (const name of staleManagedNames) {
      if (lstatIfPresent(join3(skillsDir, name))) {
        throw new Error(`Applied BMAD projection retained stale managed entry: ${name}`);
      }
    }
    for (const [name, target] of expected) {
      const link = join3(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync2(link).isSymbolicLink() && resolve3(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (!correct) throw new Error(`Applied BMAD projection link differs from plan: ${name}`);
    }
    const finalManifestStat = lstatIfPresent(manifestPath);
    if (!finalManifestStat || finalManifestStat.isSymbolicLink() || !finalManifestStat.isFile() || (Number(finalManifestStat.mode) & 511) !== manifestMode || readFileSync2(manifestPath).toString("utf8") !== nextManifest) {
      throw new Error("Applied BMAD skills manifest differs from planned bytes or mode");
    }
    const finalManifest = JSON.parse(readFileSync2(manifestPath, "utf8"));
    if (finalManifest.$schema !== SKILLS_SCHEMA_URL || finalManifest.inherit_global !== true || finalManifest.registry !== SKILLS_REGISTRY_URL || !Array.isArray(finalManifest.skills)) {
      throw new Error("Applied BMAD skills manifest schema differs from plan");
    }
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      return { ok: false, changedFiles: [], error: `BMAD provisioning failed (${String(error)}); ${String(rollbackError)}` };
    }
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  rmSync(transaction, { recursive: true });
  return { ok: true, changedFiles, packWarnings: plan.packWarnings };
}
function templateVersionFilesConf(ctx, repoRoot) {
  const packageJson = join3(repoRoot, "package.json");
  return existsSync2(packageJson) ? "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\njson package.json\ngittag .\n" : "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\ngittag .\n";
}
function replaceOrAppendManagedBlock(text2, startMarker, block, beforePattern) {
  if (startMarker.test(text2)) {
    return text2.replace(/# >>> mise-versioning >>>[\s\S]*?# <<< mise-versioning <<</, block);
  }
  if (beforePattern) {
    const match = text2.match(beforePattern);
    if (match && typeof match.index === "number") {
      return `${text2.slice(0, match.index).replace(/\s*$/, "\n\n")}${block}

${text2.slice(match.index)}`;
    }
  }
  return `${text2.replace(/\s*$/, "")}

${block}
`;
}
var BASE_MISE_PATH_ENTRIES = [".mise/scripts", "agents/hermes/pm"];
var CONDITIONAL_HERMES_PATHS = ["agents/hermes/pm/hermes", "agent/hermes/pm/hermes"];
function requiredMisePathEntries(ctx) {
  const required = [...BASE_MISE_PATH_ENTRIES];
  for (const candidate of CONDITIONAL_HERMES_PATHS) {
    if (existsSync2(join3(ctx.repoRoot, candidate)) && !required.includes(candidate)) required.push(candidate);
  }
  return required;
}
function upsertMisePath(text2, required = BASE_MISE_PATH_ENTRIES) {
  const render = (values) => `_.path = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const envMatch = text2.match(/(^|\n)(\[env\][\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!envMatch || typeof envMatch.index !== "number") {
    return `[env]
${render(required)}

${text2.replace(/^\s+/, "")}`;
  }
  const prefix = text2.slice(0, envMatch.index + envMatch[1].length);
  const section2 = envMatch[2];
  const suffix = text2.slice(envMatch.index + envMatch[1].length + section2.length);
  const pathLine = section2.match(/^_\.path\s*=\s*\[([^\]]*)\]\s*$/m);
  if (!pathLine) {
    return `${prefix}${section2.replace(/\n?$/, "\n")}${render(required)}${suffix}`;
  }
  const current = [...pathLine[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const merged = [...current];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  const nextLine = render(merged);
  if (pathLine[0] === nextLine) return text2;
  return `${prefix}${section2.replace(pathLine[0], nextLine)}${suffix}`;
}
function removeTomlSection(text2, headerPattern, marker, options) {
  const lines = text2.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!headerPattern.test(lines[i])) continue;
    if (marker) {
      let hasMarker = false;
      for (let j = i + 1; j < lines.length && !/^\[[^\]]+\]/.test(lines[j]); j++) {
        if (marker.test(lines[j])) {
          hasMarker = true;
          break;
        }
      }
      if (!hasMarker) continue;
    }
    start = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\[[^\]]+\]/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end === -1) end = lines.length;
    break;
  }
  if (start === -1) return text2;
  while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) {
    end--;
  }
  if (options?.includePrecedingComments) {
    while (start > 0 && lines[start - 1].trim().startsWith("#")) {
      start--;
    }
  }
  const result = lines.slice(0, start).concat(lines.slice(end)).join("\n");
  return result.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
function insertTomlBlockBeforeVersioning(text2, block) {
  const versioningIndex = text2.indexOf("# >>> mise-versioning >>>");
  if (versioningIndex >= 0) {
    return `${text2.slice(0, versioningIndex).replace(/\s*$/, "\n\n")}${block}

${text2.slice(versioningIndex)}`;
  }
  return `${text2.replace(/\s*$/, "")}

${block}
`;
}
function insertHookBlock(text2, block) {
  const structural = /^(?:\[\[watch_files\]\]|\[tasks(?:\.|\]))/m.exec(text2);
  const versioningIndex = text2.indexOf("# >>> mise-versioning >>>");
  const candidates = [structural?.index, versioningIndex >= 0 ? versioningIndex : void 0].filter((value) => value !== void 0);
  if (candidates.length) {
    const index = Math.min(...candidates);
    return `${text2.slice(0, index).replace(/\s*$/, "\n\n")}${block}

${text2.slice(index)}`;
  }
  return `${text2.replace(/\s*$/, "")}

${block}
`;
}
function extractTomlStrings(text2) {
  const values = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of text2.matchAll(stringPattern)) {
    if (match[1] !== void 0) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch {
        values.push(match[1]);
      }
    } else if (match[2] !== void 0) {
      values.push(match[2]);
    }
  }
  return values;
}
function stripTomlStringsAndComments(line) {
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''").replace(/#.*$/, "");
}
function normalizeOpInjectPath(raw) {
  let path = raw.trim();
  if (path.startsWith("'") && path.endsWith("'") || path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path.replace(/^\{\{config_root\}\}\//, "").replace(/^\.\//, "");
}
var QUOTED_OR_BARE = String.raw`("[^"]*"|'[^']*'|\S+)`;
function opInjectOutputTarget(value) {
  const trimmed2 = value.trim();
  const start = trimmed2.search(/\bop\s+inject\b/);
  if (start < 0) return null;
  const tail = trimmed2.slice(start);
  const mv = new RegExp(String.raw`\bmv\s+(?:-\S+\s+)*${QUOTED_OR_BARE}\s+${QUOTED_OR_BARE}`).exec(tail);
  if (mv?.[2]) return normalizeOpInjectPath(mv[2]);
  const redirect = new RegExp(String.raw`>\s*${QUOTED_OR_BARE}`).exec(tail);
  if (redirect?.[1]) return normalizeOpInjectPath(redirect[1]);
  const flag = new RegExp(String.raw`\s(?:-o|--out(?:put)?)[=\s]\s*${QUOTED_OR_BARE}`).exec(tail);
  if (flag?.[1]) return normalizeOpInjectPath(flag[1]);
  return null;
}
function isOpInjectHookEntry(value) {
  const trimmed2 = value.trim();
  if (trimmed2 === OP_INJECT_SCRIPT) return true;
  return opInjectOutputTarget(trimmed2) === ".env";
}
function truncatingOpInjectEntries(enterHooks) {
  return enterHooks.filter((value) => value.trim() !== OP_INJECT_SCRIPT && isOpInjectHookEntry(value));
}
function tomlValueSpanEnd(lines, start, limit) {
  let depth = 0;
  let j = start;
  for (; j < limit; j++) {
    for (const ch of stripTomlStringsAndComments(lines[j])) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    if (depth <= 0) break;
  }
  return Math.min(j, limit - 1) + 1;
}
function stripHookBlocks(text2) {
  const lines = text2.split("\n");
  const enter = [];
  const leave = [];
  const records = [];
  const drop = new Array(lines.length).fill(false);
  const isHeader = (line) => /^\[/.test(line.trim());
  for (let i = 0; i < lines.length; i++) {
    const trimmed2 = lines[i].trim();
    const tableMatch = /^\[\[\s*hooks\.(enter|leave)\s*\]\]$/.exec(trimmed2);
    if (tableMatch) {
      const kind = tableMatch[1];
      const bucket = kind === "enter" ? enter : leave;
      let recordScript;
      let j = i + 1;
      for (; j < lines.length && !isHeader(lines[j]); j++) {
        if (lines[j].trim().startsWith("# >>> mise-versioning >>>")) break;
        const scriptMatch = /^\s*script\s*=\s*(.+)$/.exec(lines[j]);
        if (scriptMatch) {
          const value = extractTomlStrings(scriptMatch[1])[0];
          if (value !== void 0) {
            recordScript = value;
            bucket.push(value);
          }
        }
      }
      for (let k = i; k < j; k++) drop[k] = true;
      records.push({ kind, script: recordScript, raw: lines.slice(i, j).join("\n").replace(/\n+$/, "") });
      i = j - 1;
      continue;
    }
    if (trimmed2 === "[hooks]") {
      let j = i + 1;
      let lastDrop = i;
      while (j < lines.length && !isHeader(lines[j])) {
        const keyMatch = /^\s*(enter|leave)\s*=/.exec(lines[j]);
        if (keyMatch) {
          const bucket = keyMatch[1] === "enter" ? enter : leave;
          const end = tomlValueSpanEnd(lines, j, lines.length);
          const chunk = lines.slice(j, end).filter((line) => !/^\s*#/.test(line)).join("\n");
          for (const value of extractTomlStrings(chunk)) {
            bucket.push(value);
            records.push({ kind: keyMatch[1], script: value, raw: `[[hooks.${keyMatch[1]}]]
script = ${JSON.stringify(value)}` });
          }
          lastDrop = end - 1;
          j = end;
        } else if (/^\s*\]\s*$/.test(lines[j])) {
          lastDrop = j;
          j++;
        } else {
          j++;
        }
      }
      for (let k = i; k <= lastDrop; k++) drop[k] = true;
      i = j - 1;
      continue;
    }
  }
  const kept = lines.filter((_, idx) => !drop[idx]).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  return { text: kept, enter, leave, records };
}
function ownedOpInjectScriptsOutsideEnter(text2) {
  const findings = [];
  let table = "";
  for (const [index, line] of text2.split("\n").entries()) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].replace(/[\[\]\s]/g, "");
      continue;
    }
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") continue;
    const value = extractTomlStrings(script[1])[0];
    if (value !== void 0 && isOpInjectHookEntry(value)) findings.push({ line: index + 1, value });
  }
  return findings;
}
function removeOwnedOpInjectScriptsOutsideEnter(text2) {
  let table = "";
  return text2.split("\n").filter((line) => {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].replace(/[\[\]\s]/g, "");
      return true;
    }
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") return true;
    const value = extractTomlStrings(script[1])[0];
    return value === void 0 || !isOpInjectHookEntry(value);
  }).join("\n");
}
function renderHookTables(scripts, kind) {
  return scripts.map((script) => `[[hooks.${kind}]]
script = ${JSON.stringify(script)}`);
}
function isMiseCoreHookEntry(value) {
  const trimmed2 = value.trim();
  if (isOpInjectHookEntry(trimmed2)) return false;
  return trimmed2 === SYNC_SKILLS_SCRIPT || trimmed2 === PROVISION_PACKS_SCRIPT || trimmed2 === LEGACY_PROVISION_BMAD_SKILLS_SCRIPT || /sync-skills(?:\.py)?["']?\s+--scope project/.test(trimmed2) || /provision-(?:packs|bmad-skills)\.py/.test(trimmed2) || /link-(?:project-skills-to-clis|agentfiles)\.sh'?\s*$/.test(trimmed2) || /unlink-project-skills-from-clis\.sh'?\s*$/.test(trimmed2);
}
function reconcileHookOwner(text2, owns, canonicalScripts, header = "") {
  const { text: stripped, records } = stripHookBlocks(text2);
  const canonicalRecords = renderHookTables(canonicalScripts, "enter");
  const output = [];
  let inserted = false;
  for (const record of records) {
    if (owns(record)) {
      if (!inserted) {
        output.push(...canonicalRecords);
        inserted = true;
      }
      continue;
    }
    output.push(record.raw);
  }
  if (!inserted) output.unshift(...canonicalRecords);
  const effectiveHeader = header || (stripped.includes(HOOKS_COMMENT_HEADER) ? HOOKS_COMMENT_HEADER : "");
  const withoutManagedHeader = effectiveHeader ? stripped.replace(HOOKS_COMMENT_HEADER, "").replace(/\n{3,}/g, "\n\n") : stripped;
  const block = [effectiveHeader, ...output].filter(Boolean).join("\n");
  return insertHookBlock(withoutManagedHeader, block);
}
function upsertLinkAgentfilesHooks(text2) {
  return reconcileHookOwner(
    text2,
    (record) => record.kind === "enter" && Boolean(record.script && isMiseCoreHookEntry(record.script)),
    LINK_AGENTFILES_HOOK_ENTRIES,
    HOOKS_COMMENT_HEADER
  );
}
function upsertOpInjectHook(text2) {
  const withoutStrays = removeOwnedOpInjectScriptsOutsideEnter(text2);
  return reconcileHookOwner(
    withoutStrays,
    (record) => record.kind === "enter" && Boolean(record.script && isOpInjectHookEntry(record.script)),
    [OP_INJECT_SCRIPT]
  );
}
function retiredTaskNameIssues(text2) {
  const issues = [];
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const present = new RegExp(
      `^\\[tasks\\.(?:"${esc}"|${esc})\\]|^\\s*task\\s*=\\s*"${esc}"|^\\s*depends\\s*=\\s*\\[[^\\]]*"${esc}"`,
      "m"
    ).test(text2);
    if (present) issues.push(`mise.toml still uses the retired task name "${oldName}" (renamed to "${newName}")`);
  }
  return issues;
}
function renameRetiredMiseTasks(text2) {
  let out = text2;
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]`, "gm"), taskHeader(newName));
    out = out.replace(new RegExp(`^(\\s*task\\s*=\\s*)"${esc}"`, "gm"), `$1"${newName}"`);
    out = out.replace(new RegExp(`\\bmise run ${esc}\\b`, "g"), `mise run ${newName}`);
  }
  return out.replace(/^(\s*depends\s*=\s*)(\[[^\]]*\])/gm, (_whole, head, arr) => {
    let next = arr;
    for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
      next = next.split(`"${oldName}"`).join(`"${newName}"`);
    }
    return head + next;
  });
}
function upsertLinkAgentfilesBlock(text2, ctx) {
  const withPath = upsertMisePath(renameRetiredMiseTasks(text2), requiredMisePathEntries(ctx));
  let cleaned = removeTomlSection(withPath, taskHeaderPattern(LINK_AGENTFILES_TASK), /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-agentfiles\]$/, /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(SKILLS_SYNC_TASK), void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-sync\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(PROVISION_PACKS_TASK), void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-packs\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-bmad\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-project-skills-to-clis\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.unlink-project-skills-from-clis\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-relink\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /AGENTS\.md/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /\.agents\/skills\.json/, { includePrecedingComments: false });
  cleaned = upsertLinkAgentfilesHooks(cleaned);
  return insertTomlBlockBeforeVersioning(cleaned, LINK_AGENTFILES_WATCH_TASK_BLOCK);
}
function readProjectJson(ctx) {
  return tryParseJson(safeReadText(join3(ctx.repoRoot, ".project.json")));
}
function readDeclaredAgents(ctx) {
  const project = readProjectJson(ctx);
  const agents = project?.agents;
  if (!agents || typeof agents !== "object") return [];
  return Object.entries(agents).map(([agentId, value]) => {
    const entry = typeof value === "object" && value !== null ? value : {};
    return {
      agentId,
      role: typeof entry.role === "string" ? entry.role : void 0,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : void 0,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir"))
    };
  });
}
function readRoleYamlAt(roleDir) {
  const roleYamlPath = join3(roleDir, "role.yaml");
  if (!existsSync2(roleYamlPath)) return null;
  const text2 = readText(roleYamlPath);
  return {
    role: yamlGet(text2, "role"),
    agentId: yamlGet(text2, "agent_id"),
    providerName: yamlGet(text2, "ticket_provider.name"),
    text: text2
  };
}
function validateDeclaredAgent(ctx, declared) {
  const details = [];
  if (!declared.roleDir) {
    details.push(`agents.${declared.agentId}.role_dir missing`);
    return { valid: false, details };
  }
  const roleDir = resolve3(ctx.repoRoot, declared.roleDir);
  if (!existsSync2(roleDir)) {
    details.push(`agents.${declared.agentId}.role_dir ${declared.roleDir} does not exist`);
    return { valid: false, roleDir, details };
  }
  const roleYaml = readRoleYamlAt(roleDir);
  if (!roleYaml) {
    details.push(`agents.${declared.agentId}.role_dir ${declared.roleDir} missing role.yaml`);
    return { valid: false, roleDir, details };
  }
  if (declared.role !== roleYaml.role) {
    details.push(`agents.${declared.agentId}.role should be ${roleYaml.role} (declared ${declared.role})`);
  }
  if (declared.agentId !== roleYaml.agentId) {
    details.push(`agents.${declared.agentId} should map to agent_id ${roleYaml.agentId}`);
  }
  if (roleYaml.providerName) {
    const dispatcher = join3(roleDir, ".scripts", "lib", "ticket-provider.sh");
    if (!existsSync2(dispatcher)) {
      details.push(`agents.${declared.agentId} provider dispatcher ${relative2(ctx.repoRoot, dispatcher)} missing`);
    }
    const provider = join3(roleDir, ".scripts", "providers", `${roleYaml.providerName}.sh`);
    if (!existsSync2(provider)) {
      details.push(`agents.${declared.agentId} provider script ${relative2(ctx.repoRoot, provider)} missing`);
    }
  }
  return { valid: details.length === 0, role: roleYaml.role, agentId: roleYaml.agentId, roleDir, details };
}
function boolSetting(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}
function numberSetting(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function canonicalProjectJson(ctx) {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = typeof existing.project_slug === "string" && existing.project_slug ? existing.project_slug : slugifyRepoName(basename2(ctx.repoRoot));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String((existing.ticket_provider?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String((existing.ticket_provider?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String((existing.ticket_provider?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String((existing.ticket_provider?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    state: String((existing.ticket_provider?.state ?? (firstRole?.ticketProviderBoardId ? "linked" : "planned")) || "planned")
  };
  if (ticketProvider.board_id && ticketProvider.state === "planned") ticketProvider.state = "linked";
  const existingAgents = existing.agents ?? {};
  const discoveredAgents = Object.fromEntries(
    roles.map((role) => [
      role.agentId || `${slug}-${role.role}`,
      {
        role: role.role,
        role_dir: relative2(ctx.repoRoot, role.roleDir)
      }
    ])
  );
  const agents = Object.fromEntries(
    Object.entries(discoveredAgents).map(([agentId, discovered]) => {
      const existingAgent = existingAgents[agentId] ?? {};
      const extras = Object.fromEntries(Object.entries(existingAgent).filter(([key]) => key !== "role" && key !== "role_dir"));
      return [agentId, { role: discovered.role, role_dir: discovered.role_dir, ...extras }];
    })
  );
  const dropped = [];
  for (const [declaredAgentId, entry] of Object.entries(existingAgents)) {
    const declared = {
      agentId: declaredAgentId,
      role: typeof entry.role === "string" ? entry.role : void 0,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : void 0,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir"))
    };
    const validated = validateDeclaredAgent(ctx, declared);
    if (!validated.valid || !validated.role || !validated.agentId || !validated.roleDir) {
      dropped.push(declaredAgentId);
      continue;
    }
    agents[validated.agentId] = {
      role: validated.role,
      role_dir: relative2(ctx.repoRoot, validated.roleDir),
      ...declared.extras
    };
  }
  const existingAutomation = existing.automation ?? {};
  const existingReconcile = existingAutomation.reconcile ?? {};
  const legacyEnabled = roles.find((role) => role.legacyReconcileEnabled)?.legacyReconcileEnabled;
  const legacyGrace = roles.find((role) => role.legacyReconcileGraceHours || role.legacyScrumGraceHours);
  const legacyAutoReview = roles.find((role) => role.legacyReconcileAutoReview || role.legacyScrumAutoReview);
  const automation = {
    ...existingAutomation,
    reconcile: {
      enabled: boolSetting(existingReconcile.enabled, boolSetting(legacyEnabled, false)),
      grace_hours: numberSetting(existingReconcile.grace_hours, numberSetting(legacyGrace?.legacyReconcileGraceHours || legacyGrace?.legacyScrumGraceHours, 0)),
      auto_review: boolSetting(existingReconcile.auto_review, boolSetting(legacyAutoReview?.legacyReconcileAutoReview || legacyAutoReview?.legacyScrumAutoReview, true))
    }
  };
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_slug: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents,
    automation,
    dropped
  };
}
function projectJsonFinding(ctx) {
  const projectPath = join3(ctx.repoRoot, ".project.json");
  const planeJsonPath = join3(ctx.repoRoot, ".plane.json");
  const details = [];
  const data = readProjectJson(ctx);
  const roles = discoverRoles(ctx.repoRoot);
  if (!existsSync2(projectPath)) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json missing", details: [], fixable: true };
  }
  if (!data) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json is not valid JSON", details: [], fixable: true };
  }
  for (const key of ["project_name", "project_description", "project_slug", "repo_path", "ticket_provider", "agents", "automation"]) {
    if (!(key in data)) details.push(`missing key: ${key}`);
  }
  if (data.repo_path !== ctx.repoRoot) details.push(`repo_path should be ${ctx.repoRoot}`);
  const agents = data.agents ?? {};
  for (const role of roles) {
    const agent = agents[role.agentId];
    if (!agent) {
      details.push(`agents.${role.agentId} missing`);
      continue;
    }
    if (agent.role !== role.role) details.push(`agents.${role.agentId}.role should be ${role.role}`);
    if (agent.role_dir !== relative2(ctx.repoRoot, role.roleDir)) {
      details.push(`agents.${role.agentId}.role_dir should be ${relative2(ctx.repoRoot, role.roleDir)}`);
    }
  }
  const declaredAgents = readDeclaredAgents(ctx);
  if (declaredAgents.length > 0) {
    for (const declared of declaredAgents) {
      details.push(...validateDeclaredAgent(ctx, declared).details);
    }
  }
  const ticketProvider = data.ticket_provider ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id", "state"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if ("board_url" in ticketProvider) details.push("ticket_provider.board_url should be removed; derive it from provider/workspace/board_id");
  if (!ticketProvider.board_id && roles.some((role) => role.ticketProviderBoardId)) {
    details.push("ticket_provider.board_id missing even though legacy role.yaml contains a board binding");
  }
  const automation = data.automation ?? {};
  const reconcile = automation.reconcile ?? {};
  for (const key of ["enabled", "grace_hours", "auto_review"]) {
    if (!(key in reconcile)) details.push(`automation.reconcile.${key} missing`);
  }
  if (existsSync2(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
  return {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: details.length === 0 ? "pass" : "fail",
    summary: details.length === 0 ? ".project.json matches canonical parity contract" : `${details.length} parity issue(s) detected`,
    details,
    fixable: true
  };
}
function renderSoul(role) {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm" ? `Direct and brief. Decision-forward. No throat-clearing, no apologies, no "I'll help you with that" preambles.` : "Direct and brief.";
  const roleSpecific = role.role === "pm" ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checks runtime health; when this repo opts into reconciliation (\`automation.reconcile.enabled\` in repo-root \`.project.json\`), the same heartbeat also runs your continuous board-reconciliation pass out-of-band (\`.scripts/sentinel.prompt.md\`, \`--source cron\`), kept separate from your interactive session memory.` : `You operate as the ${role.role} agent for this repo.`;
  return `# ${role.displayName || role.agentId}

You are **${role.displayName || role.agentId}** \u2014 a Hermes agent provisioned to work inside the
\`${role.repo}\` repository.

## Identity

| | |
| --- | --- |
| Agent ID | \`${role.agentId}\` |
| Profile | \`${role.profileName || role.agentId}\` |
| Repo | \`${role.repo}\` |
| Role | \`${role.role}\` |
| Telegram | \`${telegram}\` |
| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |

## Scope

You operate only within the working directory of \`${role.repo}\`. HERMES_HOME is the real named profile at \`~/.hermes/profiles/${role.profileName || role.agentId}\`; shared config/auth/skills remain linked to fleet truth while owned state lives in ignored \`./runtime/\`. The launcher supplies the project root through process-local \`TERMINAL_CWD\` and never persists it into shared config.

## Tone

${tone}

## Role-specific behavior

${roleSpecific}

## Memory hygiene

Your memory is stored locally at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.
`;
}
function renderHermesWrapper(role, templateRoleDir) {
  return readText(join3(templateRoleDir, "hermes.jinja")).replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId);
}
function templateFiles(sourceDir, current = sourceDir) {
  if (!existsSync2(current)) return [];
  const files = [];
  for (const entry of readdirSync2(current, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    const sourcePath = join3(current, entry.name);
    if (entry.isDirectory()) files.push(...templateFiles(sourceDir, sourcePath));
    else if (entry.isFile()) files.push(relative2(sourceDir, sourcePath));
  }
  return files.sort();
}
function managedHermesScaffoldRoles(ctx) {
  const discovered = discoverRoles(ctx.repoRoot);
  const declared = readDeclaredAgents(ctx).filter((entry) => entry.role === "pm" || entry.role === "director");
  if (declared.length === 0) {
    const orchestrators = discovered.filter((role) => role.role === "pm" || role.role === "director");
    const blockers2 = orchestrators.filter((role) => roleBloodbankEnabled(role) === null).map((role) => `${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
    return {
      roles: orchestrators.filter((role) => roleBloodbankEnabled(role) !== null),
      blockers: blockers2
    };
  }
  const roles = [];
  const blockers = [];
  for (const entry of declared) {
    if (!entry.roleDir) {
      blockers.push(`agents.${entry.agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve3(ctx.repoRoot, entry.roleDir);
    if (!isContainedBy(ctx.repoRoot, roleDir)) {
      blockers.push(`agents.${entry.agentId}.role_dir resolves outside the project`);
      continue;
    }
    const role = discovered.find((candidate) => resolve3(candidate.roleDir) === roleDir);
    if (!role) {
      blockers.push(`agents.${entry.agentId}.role_dir ${entry.roleDir} missing role.yaml`);
      continue;
    }
    if (role.agentId !== entry.agentId || role.role !== entry.role) {
      blockers.push(`agents.${entry.agentId} identity does not match ${entry.roleDir}/role.yaml`);
      continue;
    }
    if (roleBloodbankEnabled(role) === null) {
      blockers.push(`${entry.roleDir}/role.yaml bloodbank.enabled must be the strict YAML boolean true or false`);
      continue;
    }
    roles.push(role);
  }
  return { roles, blockers };
}
function renderSentinelPrompt(role, templateRoleDir) {
  return readText(join3(templateRoleDir, ".scripts", "sentinel.prompt.md.jinja")).replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId).replace(/\{\{\s*role\s*\}\}/g, role.role).replace(/\{\{\s*target_repo\s*\}\}/g, role.repo).replace(/\{\{\s*display_name\s*\}\}/g, role.displayName || role.agentId).replace(/\{\{\s*ticket_provider\s*\}\}/g, role.ticketProviderName || "plane");
}
function copyMissingRecursive(sourceDir, targetDir, changedFiles, dryRun, skip) {
  if (!existsSync2(sourceDir)) return;
  mkdirSync2(targetDir, { recursive: true });
  for (const entry of readdirSync2(sourceDir, { withFileTypes: true })) {
    const sourcePath = join3(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join3(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync2(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}
function runtimeSubmodulePath(repoRoot, role) {
  const rolePath = relative2(repoRoot, role.roleDir).replace(/\\/g, "/");
  if (!/^agents\/hermes\/[^/]+$/.test(rolePath)) return null;
  return `${rolePath}/runtime`;
}
function submoduleSectionHasPath(section2, targetPath) {
  return section2.split(/\r?\n/).some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}
function hasRuntimeSubmoduleMapping(repoRoot, role) {
  const gitmodulesPath = join3(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  const sections = current.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  return Boolean(targetPath && sections.some((section2) => submoduleSectionHasPath(section2, targetPath)));
}
function removeRuntimeSubmoduleMapping(repoRoot, role, changedFiles, dryRun) {
  const gitmodulesPath = join3(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  if (!hasRuntimeSubmoduleMapping(repoRoot, role)) return [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  if (!targetPath) return [];
  const next = current.replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section2) => submoduleSectionHasPath(section2, targetPath) ? "" : section2).replace(/\n{3,}/g, "\n\n").trim();
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, next ? `${next}
` : "");
  return [gitmodulesPath];
}
function retireRuntimeSubmodule(repoRoot, role, changedFiles, dryRun) {
  const runtimePath = runtimeSubmodulePath(repoRoot, role);
  if (!runtimePath) {
    return { ok: false, details: [], error: `refusing unsafe runtime path for ${role.roleDir}` };
  }
  const probe = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (probe.status !== 0) {
    return { ok: false, details: [], error: `failed to inspect runtime index at ${runtimePath}: ${probe.stderr.trim() || `exit ${probe.status}`}` };
  }
  const details = [];
  if (probe.stdout.trim()) {
    details.push(`untrack ${runtimePath}`);
    if (dryRun) {
      changedFiles.push(runtimePath);
    } else {
      const removal = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      if (removal.status !== 0) {
        return { ok: false, details, error: `failed to untrack ${runtimePath}: ${removal.stderr.trim() || `exit ${removal.status}`}` };
      }
      const verification = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      if (verification.status !== 0 || verification.stdout.trim()) {
        return {
          ok: false,
          details,
          error: verification.status !== 0 ? `failed to verify untracked runtime ${runtimePath}: ${verification.stderr.trim() || `exit ${verification.status}`}` : `runtime remains tracked after index-only removal: ${runtimePath}`
        };
      }
      changedFiles.push(runtimePath);
    }
  }
  if (hasRuntimeSubmoduleMapping(repoRoot, role)) {
    details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
    removeRuntimeSubmoduleMapping(repoRoot, role, changedFiles, dryRun);
  }
  return { ok: true, details };
}
function upsertRegistryEntry(role, homeDir, changedFiles, dryRun) {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const enabled = roleBloodbankEnabled(role);
  if (enabled === null) return null;
  const block = `  ${role.agentId}:
    repo: ${role.repo}
    role: ${role.role}
    display_name: ${JSON.stringify(role.displayName || role.agentId)}
    project_path: ${ctxEscape(role.roleDir ? dirname2(dirname2(dirname2(role.roleDir))) : "")}
    role_dir: ${ctxEscape(role.roleDir)}
    profile_name: ${role.profileName || role.agentId}
    telegram:
      bot_username: ${ctxEscape(role.botHandle)}
    plane:
      workspace: ${ctxEscape(role.planeWorkspace)}
      project_id: ${ctxEscape(role.ticketProviderBoardId)}
      identifier: ${ctxEscape(role.ticketProviderIdentifier)}
    runtime_repo: ${ctxEscape(role.runtimeRepo)}
    bloodbank:
      enabled: ${enabled ? "true" : "false"}
      gateway_scope: fleet
      target_agent_id: ${role.agentId}
    systemd:
      gateway_unit: hermes-${role.agentId}-gateway.service
      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer
`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:
${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function roleBloodbankEnabled(role) {
  if (role.bloodbankEnabled === "" || role.bloodbankEnabled === "false") return false;
  if (role.bloodbankEnabled === "true") return true;
  return null;
}
function profileMetaInheritsDefault(path) {
  const text2 = safeReadText(path);
  return Boolean(
    text2 && /^config:\s*$/m.test(text2) && /^\s+inherit_from:\s*default\s*$/m.test(text2) && /^\s+save_mode:\s*delta\s*$/m.test(text2)
  );
}
function upsertInheritedProfileMeta(path, changedFiles, dryRun) {
  const current = safeReadText(path) ?? "";
  const lines = current.split("\n");
  let next;
  const start = lines.findIndex((line) => /^config:\s*$/.test(line));
  if (!current.trim()) {
    next = "config:\n  inherit_from: default\n  save_mode: delta\n";
  } else if (start === -1) {
    next = `${current.replace(/\s*$/, "\n")}config:
  inherit_from: default
  save_mode: delta
`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^[^#\s][^:]*:\s*/.test(lines[end] ?? "")) end++;
    let hasInherit = false;
    let hasSave = false;
    for (let idx = start + 1; idx < end; idx++) {
      if (/^\s+inherit_from:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  inherit_from: default";
        hasInherit = true;
      } else if (/^\s+save_mode:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  save_mode: delta";
        hasSave = true;
      }
    }
    const inserts = [];
    if (!hasInherit) inserts.push("  inherit_from: default");
    if (!hasSave) inserts.push("  save_mode: delta");
    if (inserts.length) lines.splice(end, 0, ...inserts);
    next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }
  if (next === current) return null;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function ctxEscape(value) {
  return JSON.stringify(value || "");
}
function checkUnit(unit) {
  const enabled = systemctlUser(["is-enabled", unit]).ok;
  const active = systemctlUser(["is-active", unit]).ok;
  return { enabled, active };
}
var BMAD_NPM_PACKAGE = "bmad-method";
var BMAD_INSTALLER_VERSION = "6.11.1-next.1";
var BMAD_TARGET_CHANNEL = "next";
var BMAD_DIST_TAGS_TTL_MS = 60 * 60 * 1e3;
var DEFAULT_BMAD_MODULES = ["bmm", "bmb", "cis"];
var BMAD_INSTALL_TOOLS = SUPPORTED_BMAD_TOOLS;
function manifestBmadModules(repoRoot) {
  const manifestPath = join3(repoRoot, "_bmad", "_config", "manifest.yaml");
  const raw = safeReadText(manifestPath);
  if (raw === null) return { status: "absent" };
  try {
    const parsed = YAML.parse(raw);
    if (!Array.isArray(parsed?.modules)) {
      return { status: "invalid", error: `${manifestPath} must define a modules array` };
    }
    const declared = [];
    for (const entry of parsed.modules) {
      const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.name : void 0;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        return { status: "invalid", error: `${manifestPath} contains an invalid module entry` };
      }
      if (name !== "core" && name !== "custom") declared.push(name);
    }
    return { status: "valid", modules: Array.from(new Set(declared)) };
  } catch (error) {
    return {
      status: "invalid",
      error: `Could not parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function configuredBmadModules(repoRoot) {
  const raw = safeReadText(join3(repoRoot, "_bmad", "config.toml"));
  if (raw === null) return void 0;
  const modules = [...raw.matchAll(/^\[modules\.([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*$/gm)].map((match) => match[1]);
  return Array.from(new Set(modules));
}
function selectedBmadModules(repoRoot) {
  const manifest = manifestBmadModules(repoRoot);
  if (manifest.status === "valid") return manifest.modules;
  if (manifest.status === "invalid") throw new Error(manifest.error);
  return configuredBmadModules(repoRoot) ?? [...DEFAULT_BMAD_MODULES];
}
function requiredBmadSentinels(repoRoot, modules = selectedBmadModules(repoRoot)) {
  return [
    join3("core", "config.yaml"),
    join3("config.toml"),
    join3("_config", "manifest.yaml"),
    ...modules.map((module) => join3(module, "config.yaml"))
  ];
}
function canonicalBmadProjectName(repoRoot) {
  const project = readProjectJson({ repoRoot });
  const declared = typeof project?.project_name === "string" ? project.project_name.trim() : "";
  return declared || basename2(repoRoot);
}
function bmadProjectNameIssues(repoRoot) {
  const expected = canonicalBmadProjectName(repoRoot);
  const paths = [];
  const details = [];
  const configToml = join3(repoRoot, "_bmad", "config.toml");
  const tomlText = safeReadText(configToml);
  const tomlMatch = tomlText?.match(/^project_name\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m);
  let tomlName;
  if (tomlMatch) {
    try {
      tomlName = JSON.parse(`"${tomlMatch[1]}"`);
    } catch {
      tomlName = void 0;
    }
  }
  if (tomlName !== expected) {
    paths.push(configToml);
    details.push(`_bmad/config.toml project_name must be ${JSON.stringify(expected)}`);
  }
  const bmadRoot = join3(repoRoot, "_bmad");
  if (existsSync2(bmadRoot)) {
    for (const name of readdirSync2(bmadRoot)) {
      const configPath = join3(bmadRoot, name, "config.yaml");
      const raw = safeReadText(configPath);
      if (raw === null) continue;
      let actual;
      try {
        actual = YAML.parse(raw)?.project_name;
      } catch {
        actual = void 0;
      }
      if (actual !== expected) {
        paths.push(configPath);
        details.push(`_bmad/${name}/config.yaml project_name must be ${JSON.stringify(expected)}`);
      }
    }
  }
  return { paths: [...new Set(paths)].sort(), details };
}
function bmadInstallerInvocation(version = BMAD_INSTALLER_VERSION) {
  const explicit = process.env.PJ_BMAD_INSTALLER?.trim();
  if (explicit) return { command: resolve3(explicit), prefixArgs: [] };
  return {
    command: "npx",
    prefixArgs: ["-y", `${BMAD_NPM_PACKAGE}@${version}`]
  };
}
function bmadInstallerArgs(repoRoot, modules = selectedBmadModules(repoRoot)) {
  const installerModules = modules.length ? modules.join(",") : "core";
  return [
    "install",
    "--yes",
    "--directory",
    repoRoot,
    "--modules",
    installerModules,
    "--tools",
    BMAD_INSTALL_TOOLS.join(","),
    "--set",
    `core.project_name=${canonicalBmadProjectName(repoRoot)}`
  ];
}
function bmadInstallDisplay(repoRoot, modules = selectedBmadModules(repoRoot), version = BMAD_INSTALLER_VERSION) {
  const invocation = bmadInstallerInvocation(version);
  return [invocation.command, ...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)].join(" ").replace(BMAD_INSTALL_TOOLS.join(","), "...");
}
function preflightBmadLifecycle(ctx) {
  const packPlan = buildPackPlan(ctx, null);
  if (packPlan.errors.length) {
    return { ok: false, error: packPlan.errors.join("; ") };
  }
  const invocation = bmadInstallerInvocation();
  const probe = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: 3e4
  });
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || probe.error?.message || "installer probe failed").trim();
    return {
      ok: false,
      error: `Pinned BMAD installer ${BMAD_NPM_PACKAGE}@${BMAD_INSTALLER_VERSION} is unavailable: ${detail}`
    };
  }
  const versionOutput = `${probe.stdout ?? ""}
${probe.stderr ?? ""}`;
  const reportedVersions = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [];
  if (!reportedVersions.includes(BMAD_INSTALLER_VERSION)) {
    return {
      ok: false,
      error: `BMAD installer version mismatch: expected ${BMAD_INSTALLER_VERSION}, received ${versionOutput.trim() || "no version output"}`
    };
  }
  return { ok: true };
}
function runBmadInstall(repoRoot, modules = selectedBmadModules(repoRoot), version = BMAD_INSTALLER_VERSION) {
  const invocation = bmadInstallerInvocation(version);
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.error?.message || "Unknown error" };
  }
  return { ok: true };
}
function readInstalledBmadVersion(repoRoot) {
  const raw = safeReadText(join3(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return void 0;
  try {
    const parsed = YAML.parse(raw);
    const version = parsed?.installation?.version;
    return typeof version === "string" && version.trim() ? version.trim() : void 0;
  } catch {
    return void 0;
  }
}
function bmadCachePath(homeDir) {
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join3(homeDir, ".cache");
  return join3(cacheRoot, "pjangler", "bmad-dist-tags.json");
}
function readBmadDistTagsCache(homeDir) {
  const raw = safeReadText(bmadCachePath(homeDir));
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.fetchedAt === "number" && parsed.distTags && typeof parsed.distTags === "object") {
      return parsed;
    }
  } catch {
  }
  return void 0;
}
function fetchBmadDistTags() {
  const result = spawnSync("npm", ["view", BMAD_NPM_PACKAGE, "dist-tags", "--json"], {
    encoding: "utf8",
    timeout: 8e3
  });
  if (result.status !== 0 || !result.stdout.trim()) return void 0;
  try {
    const parsed = JSON.parse(result.stdout);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") return void 0;
    const tags = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") tags[key] = value;
    }
    return Object.keys(tags).length ? tags : void 0;
  } catch {
    return void 0;
  }
}
function resolveBmadDistTags(homeDir) {
  const cached = readBmadDistTagsCache(homeDir);
  if (cached && Date.now() - cached.fetchedAt < BMAD_DIST_TAGS_TTL_MS) {
    return { distTags: cached.distTags, stale: false };
  }
  const fetched = fetchBmadDistTags();
  if (fetched) {
    try {
      const path = bmadCachePath(homeDir);
      mkdirSync2(dirname2(path), { recursive: true });
      writeFileSync2(path, JSON.stringify({ fetchedAt: Date.now(), distTags: fetched }, null, 2));
    } catch {
    }
    return { distTags: fetched, stale: false };
  }
  if (cached) return { distTags: cached.distTags, stale: true };
  return void 0;
}
function compareBmadVersions(a, b) {
  const parse = (v) => {
    const [core = "0", pre = ""] = v.replace(/^v/, "").split("-", 2);
    const parts = core.split(".");
    const n = (i) => parseInt(parts[i] ?? "0", 10) || 0;
    return { nums: [n(0), n(1), n(2)], pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const ida = pa.pre.split(".");
  const idb = pb.pre.split(".");
  for (let i = 0; i < Math.max(ida.length, idb.length); i++) {
    const xa = ida[i];
    const xb = idb[i];
    if (xa === void 0) return -1;
    if (xb === void 0) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}
var SHARED_PROFILE_ENTRIES = ["config.yaml", ".env", "skills"];
var OWNED_PROFILE_ENTRIES = [
  "memories",
  "sessions",
  "workspace",
  "logs",
  "cron",
  "plans",
  "hooks",
  "pairing",
  "audio_cache",
  "image_cache"
];
var OWNED_PROFILE_FILES = ["SOUL.md", "state.db", "kanban.db"];
function fleetHome(ctx) {
  return process.env.HERMES_FLEET_HOME || join3(ctx.homeDir, ".hermes");
}
function fleetBinPath(ctx) {
  const candidates = [
    process.env.HERMES_FLEET_BIN,
    join3(fleetHome(ctx), "hermes-agent", ".venv", "bin", "hermes"),
    join3(fleetHome(ctx), "hermes-agent", "venv", "bin", "hermes"),
    join3(ctx.homeDir, ".local", "bin", "hermes")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync2(candidate)) ?? "";
}
function singletonPlan(ctx, role) {
  const fleetRoot = fleetHome(ctx);
  const profileName = role.profileName || role.agentId;
  const profileDir = join3(fleetRoot, "profiles", profileName);
  const runtimeDir = join3(role.roleDir, "runtime");
  const links = [];
  for (const entry of SHARED_PROFILE_ENTRIES) {
    links.push({ path: join3(profileDir, entry), target: join3(fleetRoot, entry), ensureTargetDir: entry === "skills" });
  }
  for (const entry of OWNED_PROFILE_ENTRIES) {
    links.push({ path: join3(profileDir, entry), target: join3(runtimeDir, entry), ensureTargetDir: true });
  }
  for (const entry of OWNED_PROFILE_FILES) {
    links.push({ path: join3(profileDir, entry), target: join3(runtimeDir, entry), ensureTargetDir: false });
  }
  const sharedSeeds = ["config.yaml", "auth.json", ".env"].map((entry) => ({
    rootPath: join3(fleetRoot, entry),
    runtimePath: join3(runtimeDir, entry)
  }));
  return { fleetRoot, profileDir, runtimeDir, links, sharedSeeds };
}
function isDanglingLink(path) {
  try {
    return lstatSync2(path).isSymbolicLink() && !existsSync2(path);
  } catch {
    return false;
  }
}
function linkState(path, target) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "not-a-symlink";
  try {
    return readlinkSync(path) === target ? "ok" : "wrong-target";
  } catch {
    return "wrong-target";
  }
}
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function profileUnits(role) {
  return [
    `hermes-${role.agentId}-gateway.service`,
    `hermes-${role.agentId}-heartbeat.service`,
    `hermes-${role.agentId}-heartbeat.timer`,
    `hermes-${role.agentId}-checkpoint.service`
  ];
}
function readRegistry(registryPath2) {
  const raw = safeReadText(registryPath2);
  if (raw === null) return null;
  try {
    const doc = YAML.parse(raw);
    return doc?.agents ?? {};
  } catch {
    return null;
  }
}
function declaredAgentIds(repoRoot) {
  return declaredAgentEntries(repoRoot).map(([agentId]) => agentId);
}
function declaredAgentEntries(repoRoot) {
  const raw = safeReadText(join3(repoRoot, ".project.json"));
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw);
    return Object.entries(doc.agents ?? {}).map(([agentId, entry]) => [agentId, entry ?? {}]);
  } catch {
    return [];
  }
}
function ownedRegistryEntries(registry, repoRoot) {
  const want = realOrSelf(repoRoot);
  const owned = [];
  for (const [agentId, raw] of Object.entries(registry)) {
    const entry = raw ?? {};
    const roleDir = String(entry.role_dir ?? "");
    if (!roleDir) continue;
    if (realOrSelf(dirname2(dirname2(dirname2(roleDir)))) !== want) continue;
    owned.push([agentId, entry]);
  }
  return owned;
}
function unprovisionedRoleAgents(registry, repoRoot, canonical) {
  const blockers = /* @__PURE__ */ new Map();
  const record = (agentId, roleDir, source) => {
    const current = blockers.get(agentId) ?? { roleDir, sources: /* @__PURE__ */ new Set() };
    if (!current.roleDir && roleDir) current.roleDir = roleDir;
    current.sources.add(source);
    blockers.set(agentId, current);
  };
  for (const [agentId, entry] of ownedRegistryEntries(registry, repoRoot)) {
    if (canonical.has(agentId)) continue;
    const roleDir = String(entry.role_dir ?? "");
    if (!roleDir || !existsSync2(join3(roleDir, "role.yaml"))) record(agentId, roleDir, "registry");
  }
  for (const [agentId, entry] of declaredAgentEntries(repoRoot)) {
    if (canonical.has(agentId)) continue;
    const configured = String(entry.role_dir ?? "");
    const roleDir = configured ? resolve3(repoRoot, configured) : "";
    if (!roleDir || !existsSync2(join3(roleDir, "role.yaml"))) record(agentId, roleDir, ".project.json");
  }
  return [...blockers.entries()].map(([agentId, value]) => ({
    agentId,
    roleDir: value.roleDir,
    sources: [...value.sources]
  }));
}
function dropDeclaredAgent(ctx, agentId, changedFiles, details) {
  const path = join3(ctx.repoRoot, ".project.json");
  const raw = safeReadText(path);
  if (raw === null) return;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!doc.agents || !(agentId in doc.agents)) return;
  delete doc.agents[agentId];
  details.push(`drop agent "${agentId}" from .project.json`);
  changedFiles.push(path);
  if (!ctx.dryRun) writeText(path, `${JSON.stringify(doc, null, 2)}
`);
}
function isProfileHomeExpr(assigned) {
  const bare = assigned.replace(/^["']|["']$/g, "");
  return bare === "$FLEET_HOME/profiles/$PROFILE_NAME" || /^\$\{?HERMES_FLEET_HOME.*\}?\/profiles\//.test(bare) || /\/\.hermes\/profiles\/[^/]+$/.test(bare);
}
function rewriteLauncher(text2, profileName) {
  let next = text2;
  const assigned = /^HERMES_HOME=(.*)$/m.exec(next)?.[1]?.trim();
  if (assigned !== void 0 && !isProfileHomeExpr(assigned)) {
    const name = profileName ? `\${HERMES_PROFILE_NAME:-${profileName}}` : '${HERMES_PROFILE_NAME:-$(basename "$ROLE_DIR")}';
    next = next.replace(
      /^HERMES_HOME=(.*)$/m,
      [
        `RUNTIME_HOME=$1`,
        `FLEET_HOME="\${HERMES_FLEET_HOME:-$HOME/.hermes}"`,
        `PROFILE_NAME="${name}"`,
        `# Singleton-runtime contract: HERMES_HOME MUST be the named profile dir.`,
        `HERMES_HOME="$FLEET_HOME/profiles/$PROFILE_NAME"`
      ].join("\n")
    );
    next = next.replace(
      /if \[\[ ! -d "\$HERMES_HOME" \]\]; then\n(\s*)echo "hermes: local runtime not provisioned at \$HERMES_HOME"/,
      'if [[ ! -d "$RUNTIME_HOME" ]]; then\n$1echo "hermes: local runtime not provisioned at $RUNTIME_HOME"'
    );
  }
  next = next.replace(/^HERMES_OAUTH_FILE=.*\n/m, "");
  next = next.replace(/\s*HERMES_OAUTH_FILE="\$HERMES_OAUTH_FILE"/g, "");
  next = next.replace(
    /^.*\/home\/delorenj\/code\/hermes-agent\/\.venv\/bin\/hermes.*$/m,
    (line) => line.replace("/home/delorenj/code/hermes-agent/.venv/bin/hermes", "$HOME/.hermes/hermes-agent/.venv/bin/hermes")
  );
  return next;
}
function isValidOpReference(value) {
  if (!value.startsWith("op://") || /[\[\]{}<>]/.test(value)) return false;
  const withoutScheme = value.slice("op://".length);
  const fragmentIndex = withoutScheme.indexOf("#");
  if (fragmentIndex >= 0) return false;
  const queryIndex = withoutScheme.indexOf("?");
  const pathPart = queryIndex >= 0 ? withoutScheme.slice(0, queryIndex) : withoutScheme;
  const queryPart = queryIndex >= 0 ? withoutScheme.slice(queryIndex + 1) : "";
  const parts = pathPart.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part)) return false;
  try {
    for (const part of parts) decodeURIComponent(part);
  } catch {
    return false;
  }
  if (queryIndex >= 0 && !/^attribute=[A-Za-z0-9._~-]+$/.test(queryPart)) return false;
  return true;
}
function malformedOpReferences(text2) {
  const occurrences = [];
  const lines = text2.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(/op:\/\/[^\s"'`]+/g)) {
      const value = match[0];
      if (!isValidOpReference(value)) {
        occurrences.push({ line: index + 1, value, commentOnly: line.trimStart().startsWith("#") });
      }
    }
  }
  return occurrences;
}
function removeMalformedCommentOpReferences(text2) {
  let changed = false;
  const lines = text2.split("\n").map((line) => {
    if (!line.trimStart().startsWith("#")) return line;
    return line.replace(/op:\/\/[^\s"'`]+/g, (value) => {
      if (isValidOpReference(value)) return value;
      changed = true;
      return "<invalid 1Password reference removed by pjangler>";
    });
  });
  return { text: lines.join("\n"), changed };
}
var UNSUPPORTED_BMAD_ROOTS = {
  ".agent": "antigravity",
  ".adal": "adal",
  ".bob": "bob",
  ".cline": "cline",
  ".codebuddy": "codebuddy",
  ".codewhale": "codewhale",
  ".cortex": "cortex",
  ".cursor": "cursor",
  ".factory": "droid",
  ".firebender": "firebender",
  ".iflow": "iflow",
  ".junie": "junie",
  ".kiro": "kiro",
  ".kode": "kode",
  ".neovate": "neovate",
  ".ona": "ona",
  ".qoder": "qoder",
  ".qwen": "qwen",
  ".trae": "trae",
  ".zcode": "zcode",
  ".zencoder": "zencoder"
};
function parseCsvRows(text2) {
  const rows = [];
  let row = [];
  let field2 = "";
  let quoted = false;
  for (let index = 0; index < text2.length; index++) {
    const char = text2[index];
    if (quoted) {
      if (char === '"' && text2[index + 1] === '"') {
        field2 += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field2 += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field2);
      field2 = "";
    } else if (char === "\n") {
      row.push(field2.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field2 = "";
    } else {
      field2 += char;
    }
  }
  if (field2 || row.length) {
    row.push(field2.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
function csvObjects(text2) {
  const [headers, ...rows] = parseCsvRows(text2);
  if (!headers?.length) return [];
  return rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}
function installedBmadTools(repoRoot) {
  const raw = safeReadText(join3(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return /* @__PURE__ */ new Set();
  try {
    const parsed = YAML.parse(raw);
    return new Set(Array.isArray(parsed?.ides) ? parsed.ides.filter((entry) => typeof entry === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function bmadCliProjectionInventory(repoRoot) {
  const filesText = safeReadText(join3(repoRoot, "_bmad", "_config", "files-manifest.csv"));
  const skillsText = safeReadText(join3(repoRoot, "_bmad", "_config", "skill-manifest.csv"));
  if (!filesText || !skillsText) return { files: /* @__PURE__ */ new Map(), error: "BMAD files/skill manifests are missing" };
  const fileHashes = /* @__PURE__ */ new Map();
  for (const row of csvObjects(filesText)) {
    const hash = row.hash ?? "";
    if (row.path && /^[a-f0-9]{64}$/i.test(hash)) fileHashes.set(row.path.replace(/^_bmad\//, ""), hash.toLowerCase());
  }
  const projected = /* @__PURE__ */ new Map();
  for (const row of csvObjects(skillsText)) {
    const canonicalId = row.canonicalId ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(canonicalId)) continue;
    const skillPath = (row.path ?? "").replace(/^_bmad\//, "");
    if (!skillPath.endsWith("/SKILL.md")) continue;
    const sourceRoot = dirname2(skillPath);
    for (const [sourcePath, hash] of fileHashes) {
      if (sourcePath !== `${sourceRoot}/SKILL.md` && !sourcePath.startsWith(`${sourceRoot}/`)) continue;
      const suffix = relative2(sourceRoot, sourcePath);
      if (!suffix || suffix.startsWith("..")) continue;
      projected.set(join3("skills", canonicalId, suffix), hash);
    }
  }
  return projected.size ? { files: projected } : { files: projected, error: "BMAD manifests contain no projected skill inventory" };
}
function inventoryFilesUnder(root, current = root) {
  if (!existsSync2(current)) return { files: [], unsafe: [] };
  const stat = lstatSync2(current);
  const rel = relative2(root, current) || ".";
  if (stat.isSymbolicLink()) return { files: [], unsafe: [rel] };
  if (stat.isFile()) return { files: [relative2(root, current)], unsafe: [] };
  if (!stat.isDirectory()) return { files: [], unsafe: [rel] };
  const result = { files: [], unsafe: [] };
  for (const name of readdirSync2(current)) {
    const child = inventoryFilesUnder(root, join3(current, name));
    result.files.push(...child.files);
    result.unsafe.push(...child.unsafe);
  }
  return result;
}
function unsupportedRootAttestation(repoRoot, rootName) {
  const root = join3(repoRoot, rootName);
  const stat = lstatSync2(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { safe: false, reason: `${rootName} is not a regular generated directory` };
  const installerTool = UNSUPPORTED_BMAD_ROOTS[rootName];
  if (!installedBmadTools(repoRoot).has(installerTool)) {
    return { safe: false, reason: `BMAD installer metadata does not declare tool ${installerTool}` };
  }
  const inventory = bmadCliProjectionInventory(repoRoot);
  if (inventory.error) return { safe: false, reason: inventory.error };
  const walked = inventoryFilesUnder(root);
  if (walked.unsafe.length) return { safe: false, reason: `${rootName}/${walked.unsafe[0]} is a symlink or non-regular entry` };
  if (!walked.files.length) return { safe: false, reason: `${rootName} has no installer-owned files` };
  for (const rel of walked.files) {
    const expectedHash = inventory.files.get(rel);
    if (!expectedHash) return { safe: false, reason: `${rootName}/${rel} is outside the BMAD generated inventory` };
    const actualHash = createHash2("sha256").update(readFileSync2(join3(root, rel))).digest("hex");
    if (actualHash !== expectedHash) return { safe: false, reason: `${rootName}/${rel} was locally modified after generation` };
  }
  return { safe: true, reason: `${walked.files.length} file(s) match BMAD installer inventory and hashes` };
}
function createMiseChecks() {
  return [
    {
      id: "mise.config-root",
      title: "mise config_root + AGENTS link hooks",
      audit: (ctx) => {
        const misePath = join3(ctx.repoRoot, "mise.toml");
        if (!existsSync2(misePath)) {
          return { id: "mise.config-root", title: "mise config_root + AGENTS link hooks", status: "fail", summary: "mise.toml missing", details: [], fixable: true };
        }
        const text2 = readText(misePath);
        const details = [];
        const linkAgentfilesPath = join3(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
        if (!existsSync2(linkAgentfilesPath)) details.push(".mise/scripts/link-agentfiles.sh missing");
        const pathValues = [...(text2.match(/^_\.path\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        const missingPathValues = requiredMisePathEntries(ctx).filter((value) => !pathValues.includes(value));
        if (missingPathValues.length) details.push(`[env]._.path should include ${missingPathValues.join(", ")}`);
        if (!text2.includes("'{{config_root}}/.mise/scripts/link-agentfiles.sh'")) details.push("link-agentfiles hook must use single-quoted {{config_root}} guard");
        if (!text2.includes('patterns = ["AGENTS.md"]')) details.push("watch_files must monitor AGENTS.md");
        if (!text2.includes(`task = "${LINK_AGENTFILES_TASK}"`)) details.push(`watch_files must dispatch the ${LINK_AGENTFILES_TASK} task`);
        details.push(...retiredTaskNameIssues(text2));
        return {
          id: "mise.config-root",
          title: "mise config_root + AGENTS link hooks",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "mise AGENTS-linking parity verified" : `${details.length} issue(s) detected in mise AGENTS-linking contract`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const path = join3(ctx.repoRoot, "mise.toml");
        const changedFiles = [];
        const details = [];
        if (!existsSync2(path)) {
          if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
            return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
          }
          details.push("Initialized mise.toml from generated-project template");
          if (ctx.dryRun) {
            return { id: finding.id, title: finding.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
          }
        }
        let text2 = readText(path);
        const next = upsertLinkAgentfilesBlock(text2, ctx);
        if (next !== text2) {
          if (!changedFiles.includes(path)) changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, next);
          text2 = next;
        }
        const linkAgentfilesPath = join3(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
        const expectedScript = templateLinkAgentfilesScript(ctx);
        if (expectedScript === void 0) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/link-agentfiles.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
        }
        if (safeReadText(linkAgentfilesPath) !== expectedScript) {
          changedFiles.push(linkAgentfilesPath);
          if (!ctx.dryRun) {
            writeText(linkAgentfilesPath, expectedScript);
            chmodSync(linkAgentfilesPath, 493);
          }
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
          changedFiles,
          details: changedFiles.length ? [`Normalized hooks/watch_files/tasks."${LINK_AGENTFILES_TASK}" block and script`] : []
        };
      }
    },
    {
      id: "mise.versioning",
      title: "managed mise versioning block",
      audit: (ctx) => {
        const details = [];
        const misePath = join3(ctx.repoRoot, "mise.toml");
        const versioningPath = join3(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
        const manifestPath = join3(ctx.repoRoot, ".mise", "version-files.conf");
        const text2 = safeReadText(misePath);
        if (!text2?.includes("# >>> mise-versioning >>>")) details.push("mise versioning managed block missing");
        if (!existsSync2(versioningPath)) details.push(".mise/scripts/versioning.sh missing");
        if (!existsSync2(manifestPath)) details.push(".mise/version-files.conf missing");
        return {
          id: "mise.versioning",
          title: "managed mise versioning block",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "mise versioning parity verified" : `${details.length} versioning issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const details = [];
        const misePath = join3(ctx.repoRoot, "mise.toml");
        if (!existsSync2(misePath)) {
          if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
            return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
          }
          details.push("Initialized mise.toml from generated-project template");
          if (ctx.dryRun) {
            return { id: finding.id, title: finding.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
          }
        }
        const currentMise = readText(misePath);
        let cleanedMise = currentMise;
        if (!currentMise.includes("# >>> mise-versioning >>>")) {
          const taskNames = ["version", "version:bump", "version:bump-patch", "version:bump-minor", "version:bump-major", "version:check", "version:sync"];
          for (const taskName of taskNames) {
            const escaped = taskName.replace(/:/g, "\\:");
            const headerPattern = new RegExp(`^\\[tasks\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]$`);
            cleanedMise = removeTomlSection(cleanedMise, headerPattern);
          }
        }
        const nextMise = replaceOrAppendManagedBlock(cleanedMise, /# >>> mise-versioning >>>/, VERSIONING_BLOCK, /^\[tasks\.build\]/m);
        if (nextMise !== currentMise) {
          if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
          if (!ctx.dryRun) writeText(misePath, nextMise);
        }
        const versioningPath = join3(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
        const expectedScript = templateVersioningScript(ctx);
        if (expectedScript === void 0) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/versioning.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
        }
        if (safeReadText(versioningPath) !== expectedScript) {
          changedFiles.push(versioningPath);
          if (!ctx.dryRun) {
            writeText(versioningPath, expectedScript);
            chmodSync(versioningPath, 493);
          }
        }
        const manifestPath = join3(ctx.repoRoot, ".mise", "version-files.conf");
        const expectedManifest = templateVersionFilesConf(ctx, ctx.repoRoot);
        if (safeReadText(manifestPath) !== expectedManifest) {
          changedFiles.push(manifestPath);
          if (!ctx.dryRun) writeText(manifestPath, expectedManifest);
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Versioning block/script/manifest normalized" : "No changes required",
          changedFiles,
          details: []
        };
      }
    }
  ];
}
function createAgentHooksChecks() {
  return [
    {
      id: "skills.project-manifest",
      title: "Skillex project skills manifest",
      audit: (ctx) => {
        const details = [];
        const manifestPath = join3(ctx.repoRoot, ".agents", "skills.json");
        const legacyDir = join3(ctx.repoRoot, ".agents", "skills");
        const localExamplePath = join3(ctx.repoRoot, ".agents", "local.example.json");
        const misePath = join3(ctx.repoRoot, "mise.toml");
        let fixable = true;
        const manifest = tryParseJson(safeReadText(manifestPath));
        const plan = buildPackPlan(ctx, manifest);
        if (plan.errors.length) {
          details.push(...plan.errors);
          fixable = false;
        }
        const packAdvisories = [
          ...plan.warnings.length ? [`${plan.warnings.length} optional pack(s) skipped`] : [],
          ...plan.packWarnings
        ];
        const expectedBmad = plan.manifestSkills;
        const expectedByName = new Map(plan.projections);
        const expectedNames = new Set(expectedByName.keys());
        const managedManifestNames = new Set(expectedBmad.map((entry) => entry.name));
        if (!manifest) {
          details.push(".agents/skills.json missing or invalid JSON");
        } else {
          if (manifest.inherit_global !== true) details.push(".agents/skills.json should set inherit_global: true");
          if (manifest.registry !== SKILLS_REGISTRY_URL) details.push(`.agents/skills.json should set registry to ${SKILLS_REGISTRY_URL}`);
          if (typeof manifest.$schema === "string" && RETIRED_SKILLS_SCHEMA_URLS.includes(manifest.$schema)) {
            details.push(`.agents/skills.json $schema still points at the retired ${manifest.$schema}; it should be ${SKILLS_SCHEMA_URL}`);
          } else if (manifest.$schema !== SKILLS_SCHEMA_URL) {
            details.push(`.agents/skills.json should set $schema to ${SKILLS_SCHEMA_URL}`);
          }
          if (!Array.isArray(manifest.skills)) {
            details.push(".agents/skills.json should define a skills array");
          } else {
            const actualBmad = new Map(
              manifest.skills.filter((entry) => Boolean(entry) && typeof entry === "object" && isPackManagedManifestEntry(entry, managedManifestNames, plan.implicitRoots)).map((entry) => [String(entry.name), String(entry.source ?? "")])
            );
            const stale = expectedBmad.filter((entry) => actualBmad.get(entry.name) !== entry.source);
            if (stale.length > 0 || actualBmad.size !== expectedBmad.length) {
              details.push(`.agents/skills.json should record all ${expectedBmad.length} BMAD ${BMAD_PACK_VERSION} pack entries as file:// sources`);
            }
            const redundant = manifest.skills.filter((entry) => isRedundantDeclaredPackEntry(entry, plan)).map(skillManifestEntryName).filter((name) => Boolean(name));
            if (redundant.length) {
              details.push(
                `.agents/skills.json skills[] duplicates ${redundant.length} declared pack member(s) and should drop them: ${redundant.join(", ")}`
              );
            }
          }
        }
        const invalidBmadLinkNames = /* @__PURE__ */ new Set();
        if (existsSync2(legacyDir)) {
          for (const name of readdirSync2(legacyDir)) {
            const expected = expectedByName.get(name);
            const path = join3(legacyDir, name);
            let linkTargetsPack = false;
            try {
              const linkTarget = lstatSync2(path).isSymbolicLink() ? resolve3(dirname2(path), readlinkSync(path)) : null;
              linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget));
            } catch {
              linkTargetsPack = false;
            }
            if (!expected && !linkTargetsPack) continue;
            try {
              if (!expected || !lstatSync2(path).isSymbolicLink() || resolve3(dirname2(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
            } catch {
              invalidBmadLinkNames.add(name);
            }
          }
          for (const [name, expected] of expectedByName) {
            const path = join3(legacyDir, name);
            try {
              if (!lstatSync2(path).isSymbolicLink() || resolve3(dirname2(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
            } catch {
              invalidBmadLinkNames.add(name);
            }
          }
        } else {
          for (const name of expectedByName.keys()) invalidBmadLinkNames.add(name);
        }
        if (invalidBmadLinkNames.size > 0) {
          details.push(`${invalidBmadLinkNames.size} managed pack skill path(s) should be symlinks into their declared Skillex pack`);
        }
        const manifestNames = new Set(
          (Array.isArray(manifest?.skills) ? manifest.skills : []).map(skillManifestEntryName).filter((name) => Boolean(name))
        );
        const unmanagedSkillNames = legacyCommittedSkillNames(
          legacyDir,
          skillsBackupDir(ctx.repoRoot),
          expectedNames,
          plan.ownershipRoots,
          manifestNames
        );
        for (const name of unmanagedSkillNames) {
          details.push(`.agents/skills/${name} is committed but absent from .agents/skills.json`);
        }
        if (unmanagedSkillNames.length) {
          details.push(
            `Run \`pj migrate skills.project-manifest --accept-registry-matches\` to map ${unmanagedSkillNames.length} unmanaged committed skill(s) into the manifest`
          );
        }
        for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
          if (existsSync2(join3(ctx.repoRoot, rel))) details.push(`${rel} is a legacy symlink-era script and should be removed`);
        }
        const localExample = tryParseJson(safeReadText(localExamplePath));
        if (localExample && Object.prototype.hasOwnProperty.call(localExample, "skills")) {
          details.push(".agents/local.example.json still documents legacy skills overrides; drop the skills section");
        }
        if (existsSync2(join3(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL))) {
          details.push(`${LEGACY_PROVISION_SCRIPT_REL} is the retired BMAD-only provisioner and should be replaced by ${PROVISION_PACKS_SCRIPT_REL}`);
        }
        const mise = safeReadText(misePath);
        if (!mise?.includes(SYNC_SKILLS_SCRIPT)) details.push("mise.toml should run the shipped project-local sync-skills.py engine via config_root");
        if (!mise?.includes(PROVISION_PACKS_SCRIPT)) details.push("mise.toml should provision declared Skillex packs before syncing skills");
        if (mise?.includes(SYNC_SKILLS_SCRIPT) && mise.includes(PROVISION_PACKS_SCRIPT) && mise.indexOf(PROVISION_PACKS_SCRIPT) > mise.indexOf(SYNC_SKILLS_SCRIPT)) {
          details.push("mise.toml should run the pack provisioner before project skill sync");
        }
        if (mise?.includes(LEGACY_PROVISION_TASK) || mise?.includes("provision-bmad-skills.py")) {
          details.push(`mise.toml still references the retired ${LEGACY_PROVISION_TASK} task/provision-bmad-skills.py script`);
        }
        if (mise?.includes('script = "sync-skills.py --scope project"') || mise?.includes('run = "sync-skills.py --scope project"')) {
          details.push("mise.toml still invokes the missing bare sync-skills.py executable");
        }
        if (!mise?.includes('patterns = [".agents/skills.json"]')) details.push("mise.toml should watch .agents/skills.json");
        if (!mise?.includes(taskHeader(SKILLS_SYNC_TASK))) details.push(`mise.toml should define a ${SKILLS_SYNC_TASK} task`);
        if (!mise?.includes(`depends = ["${PROVISION_PACKS_TASK}"]`)) details.push(`${SKILLS_SYNC_TASK} task should depend on ${PROVISION_PACKS_TASK}`);
        if (mise) details.push(...retiredTaskNameIssues(mise));
        for (const [rel, label] of [
          [PROVISION_PACKS_SCRIPT_REL, "Skillex pack provisioning script"],
          [SYNC_SKILLS_SCRIPT_REL, "Project-local skills sync engine"]
        ]) {
          const target = join3(ctx.repoRoot, rel);
          const expected = templateCommonProjectText(ctx, rel);
          const stat = lstatIfPresent(target);
          if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
            details.push(`${label} is missing or unsafe`);
            if (stat) fixable = false;
          } else {
            if (expected === void 0 || safeReadText(target) !== expected) details.push(`${label} differs from the shipped template`);
            if ((Number(stat.mode) & 73) === 0) details.push(`${label} is not executable`);
          }
        }
        const topologyIssues = projectSkillTopologyIssues(ctx.repoRoot);
        if (topologyIssues.length) {
          details.push(...topologyIssues.map((issue) => `CLI skill topology: ${issue}`));
          fixable = false;
        }
        if (mise?.includes("link-project-skills-to-clis.sh") || mise?.includes("unlink-project-skills-from-clis.sh") || mise?.includes("[tasks.skills-relink]")) {
          details.push("mise.toml still contains legacy skill-link wiring");
        }
        return {
          id: "skills.project-manifest",
          title: "Skillex project skills manifest",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? `Skillex skills manifest parity verified${packAdvisories.length ? ` (${packAdvisories.join("; ")})` : ""}` : `${details.length} Skillex migration issue(s) detected${unmanagedSkillNames.length ? ` (${unmanagedSkillNames.length} unmanaged committed skill(s): ${unmanagedSkillNames.join(", ")})` : ""}`,
          details,
          fixable
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const details = [];
        const manifestPath = join3(ctx.repoRoot, ".agents", "skills.json");
        const localExamplePath = join3(ctx.repoRoot, ".agents", "local.example.json");
        const misePath = join3(ctx.repoRoot, "mise.toml");
        const provisionScriptPath = join3(ctx.repoRoot, PROVISION_PACKS_SCRIPT_REL);
        const legacyProvisionScriptPath = join3(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL);
        const syncScriptPath = join3(ctx.repoRoot, SYNC_SKILLS_SCRIPT_REL);
        const expectedProvisionScript = templateCommonProjectText(ctx, PROVISION_PACKS_SCRIPT_REL);
        const expectedSyncScript = templateCommonProjectText(ctx, SYNC_SKILLS_SCRIPT_REL);
        const topologyIssues = projectSkillTopologyIssues(ctx.repoRoot);
        if (topologyIssues.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Unsafe project CLI skill topology must be repaired manually",
            changedFiles,
            details: topologyIssues
          };
        }
        if (!expectedProvisionScript || !expectedSyncScript) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "pjangler install is missing a shipped skills executable",
            changedFiles,
            details: [
              ...!expectedProvisionScript ? [`Missing Skillex pack provisioning script template (${PROVISION_PACKS_SCRIPT_REL})`] : [],
              ...!expectedSyncScript ? ["Missing project-local skills sync engine template"] : []
            ]
          };
        }
        const unsafeScriptTargets = [provisionScriptPath, syncScriptPath].filter((path) => {
          const stat = lstatIfPresent(path);
          return Boolean(stat && (!stat.isFile() || stat.isSymbolicLink()));
        });
        if (unsafeScriptTargets.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Refusing non-regular managed skills executable target",
            changedFiles,
            details: unsafeScriptTargets.map((path) => `${path} must be removed or repaired manually`)
          };
        }
        const provisioned = provisionBmadSkills(ctx);
        if (!provisioned.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "A declared Skillex pack is unavailable or untrusted",
            changedFiles,
            details: [provisioned.error ?? "Unknown Skillex pack error"]
          };
        }
        changedFiles.push(...provisioned.changedFiles);
        if (provisioned.changedFiles.includes(manifestPath)) details.push("Normalized .agents/skills.json against the declared Skillex packs");
        details.push(...provisioned.packWarnings ?? []);
        details.push(...migrateLegacyCommittedSkills(ctx, changedFiles));
        for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
          const path = join3(ctx.repoRoot, rel);
          if (existsSync2(path)) {
            changedFiles.push(path);
            if (!ctx.dryRun) unlinkSync(path);
          }
        }
        const templateLocalExample = templateCommonProjectText(ctx, ".agents/local.example.json");
        const currentLocalExample = safeReadText(localExamplePath);
        if (templateLocalExample && currentLocalExample && currentLocalExample !== templateLocalExample) {
          changedFiles.push(localExamplePath);
          if (!ctx.dryRun) writeText(localExamplePath, templateLocalExample);
        }
        normalizeExecutableTemplate(ctx, provisionScriptPath, expectedProvisionScript, changedFiles);
        normalizeExecutableTemplate(ctx, syncScriptPath, expectedSyncScript, changedFiles);
        const legacyProvisionStat = lstatIfPresent(legacyProvisionScriptPath);
        if (legacyProvisionStat) {
          if (legacyProvisionStat.isDirectory() && !legacyProvisionStat.isSymbolicLink()) {
            details.push(`${LEGACY_PROVISION_SCRIPT_REL} is a directory and must be removed manually`);
          } else {
            changedFiles.push(legacyProvisionScriptPath);
            details.push(`Removed the retired ${LEGACY_PROVISION_SCRIPT_REL}`);
            if (!ctx.dryRun) unlinkSync(legacyProvisionScriptPath);
          }
        }
        if (!existsSync2(misePath)) {
          if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
            return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details };
          }
        }
        const currentMise = readText(misePath);
        const nextMise = upsertLinkAgentfilesBlock(currentMise, ctx);
        if (nextMise !== currentMise) {
          if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
          if (!ctx.dryRun) writeText(misePath, nextMise);
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Skillex skills manifest contract normalized" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "sot.agent-symlinks",
      title: "AGENTS/CLAUDE/GEMINI symlink contract",
      audit: (ctx) => {
        const agentsPath = join3(ctx.repoRoot, "AGENTS.md");
        if (!existsSync2(agentsPath)) {
          const fallbackSources = ["CLAUDE.md", "GEMINI.md", "README.md"].filter((file) => existsSync2(join3(ctx.repoRoot, file)));
          if (fallbackSources.length === 0) {
            return { id: "sot.agent-symlinks", title: "AGENTS/CLAUDE/GEMINI symlink contract", status: "skip", summary: "AGENTS.md missing; symlink contract not applicable", details: [], fixable: false };
          }
          return {
            id: "sot.agent-symlinks",
            title: "AGENTS/CLAUDE/GEMINI symlink contract",
            status: "fail",
            summary: "AGENTS.md missing but can be derived from existing project documentation",
            details: [`AGENTS.md can be created from ${fallbackSources[0]}`],
            fixable: true
          };
        }
        const details = [];
        for (const file of ["CLAUDE.md", "GEMINI.md"]) {
          const full = join3(ctx.repoRoot, file);
          const target = readSymlinkTarget(full);
          if (target !== "AGENTS.md") details.push(`${file} should be a symlink to AGENTS.md`);
        }
        return {
          id: "sot.agent-symlinks",
          title: "AGENTS/CLAUDE/GEMINI symlink contract",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Agent documentation symlinks are in parity" : `${details.length} symlink issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const details = [];
        const blockedDetails = [];
        const bootstrap = bootstrapAgentsFile(ctx.repoRoot, ctx.dryRun);
        changedFiles.push(...bootstrap.changedFiles);
        details.push(...bootstrap.details);
        if (bootstrap.blocked) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "AGENTS.md missing; cannot derive canonical agent file", changedFiles, details: [bootstrap.blocked] };
        }
        for (const file of ["CLAUDE.md", "GEMINI.md"]) {
          const full = join3(ctx.repoRoot, file);
          const result = ensureSymlink(full, "AGENTS.md", ctx.dryRun);
          if (result.blocked) blockedDetails.push(result.blocked);
          if (result.changed) changedFiles.push(full);
        }
        return {
          id: finding.id,
          title: finding.title,
          status: blockedDetails.length ? "blocked" : changedFiles.length ? "applied" : "noop",
          summary: blockedDetails.length ? "One or more files could not be replaced safely" : changedFiles.length ? "Symlink contract repaired" : "No changes required",
          changedFiles,
          details: [...details, ...blockedDetails]
        };
      }
    }
  ];
}
function createProjectJsonChecks() {
  return [
    {
      id: "sot.project-json",
      title: "Canonical .project.json",
      audit: projectJsonFinding,
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const blockedDetails = [];
        const droppedDetails = [];
        const path = join3(ctx.repoRoot, ".project.json");
        const existing = readProjectJson(ctx) ?? {};
        const canonical = canonicalProjectJson(ctx);
        for (const agentId of canonical.dropped) {
          const entry = existing.agents?.[agentId];
          const entryRecord = typeof entry === "object" && entry !== null ? entry : void 0;
          const declared = {
            agentId,
            role: typeof entryRecord?.role === "string" ? entryRecord.role : void 0,
            roleDir: typeof entryRecord?.role_dir === "string" ? entryRecord.role_dir : void 0,
            extras: {}
          };
          const validation = validateDeclaredAgent(ctx, declared);
          const reason = validation.details.join("; ") || "invalid";
          droppedDetails.push(`dropped invalid declared agent: ${agentId} (${reason})`);
        }
        const { dropped: _dropped, ...canonicalJson } = canonical;
        const merged = { ...existing, ...canonicalJson };
        const expected = `${JSON.stringify(merged, null, 2)}
`;
        if (safeReadText(path) !== expected) {
          changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, expected);
        }
        const planeJson = join3(ctx.repoRoot, ".plane.json");
        if (existsSync2(planeJson)) {
          const backup = `${planeJson}.migrated-backup`;
          if (existsSync2(backup)) {
            blockedDetails.push(`cannot back up .plane.json because ${relative2(ctx.repoRoot, backup)} already exists`);
          } else {
            changedFiles.push(backup);
            if (!ctx.dryRun) renameSync(planeJson, backup);
          }
        }
        const details = [...droppedDetails, ...blockedDetails];
        return {
          id: finding.id,
          title: finding.title,
          status: blockedDetails.length ? "blocked" : changedFiles.length || droppedDetails.length ? "applied" : "noop",
          summary: blockedDetails.length ? "Project SOT partially blocked" : changedFiles.length || droppedDetails.length ? `Canonical .project.json written; dropped ${droppedDetails.length} invalid declared agent(s)` : "No changes required",
          changedFiles,
          details
        };
      }
    }
  ];
}
function createMiseOpInjectChecks() {
  return [
    {
      id: "secrets.env-op",
      title: ".env.op + gitignore secrets contract",
      audit: (ctx) => {
        const details = [];
        const envOpPath = join3(ctx.repoRoot, ".env.op");
        const envOpExists = existsSync2(envOpPath);
        const envOp = envOpExists ? readText(envOpPath) : void 0;
        const gitignore = safeReadText(join3(ctx.repoRoot, ".gitignore"));
        if (!envOpExists) {
          details.push(".env.op missing");
        } else if (!envOp?.trim()) {
          details.push(".env.op is empty or whitespace-only");
        } else {
          const malformed = malformedOpReferences(envOp);
          if (malformed.length) {
            details.push(`.env.op has malformed op:// reference(s) on line(s): ${Array.from(new Set(malformed.map((entry) => entry.line))).join(", ")}`);
          }
          const invalidLines = envOp.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(({ line }) => line && !line.startsWith("#") && line.includes("=")).filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
          if (invalidLines.length) details.push(`.env.op has non-reference values that do not look like safe literals on line(s): ${invalidLines.map((entry) => entry.number).join(", ")}`);
        }
        if (!gitignore?.includes(".env\n") && !gitignore?.includes(".env\r\n")) details.push(".gitignore should ignore .env");
        if (!gitignore?.includes(".env.*")) details.push(".gitignore should ignore .env.*");
        if (!gitignore?.includes("!.env.op")) details.push(".gitignore should unignore .env.op");
        const misePath = join3(ctx.repoRoot, "mise.toml");
        const miseText = safeReadText(misePath);
        if (!miseText) {
          details.push("mise.toml missing for .env materialization hook");
        } else {
          const enterHookValues = stripHookBlocks(miseText).enter;
          const truncating = truncatingOpInjectEntries(enterHookValues);
          if (truncating.length) details.push(`hooks.enter has ${truncating.length} unsafe legacy .env op-inject hook(s)`);
          const canonicalCount = enterHookValues.filter((value) => value.trim() === OP_INJECT_SCRIPT).length;
          if (canonicalCount !== 1) details.push(`hooks.enter must contain exactly one managed materialize-env hook (found ${canonicalCount})`);
          const strayOwned = ownedOpInjectScriptsOutsideEnter(miseText);
          if (strayOwned.length) details.push(`owned .env materialization appears outside [[hooks.enter]] on line(s): ${strayOwned.map((entry) => entry.line).join(", ")}`);
        }
        const materializePath = join3(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
        const expectedMaterializer = templateMaterializeEnvScript(ctx);
        if (!expectedMaterializer) {
          details.push("pjangler package is missing the managed materialize-env.sh source");
        } else if (safeReadText(materializePath) !== expectedMaterializer) {
          details.push(`${MATERIALIZE_ENV_SCRIPT_REL} missing or drifted`);
        } else if ((lstatSync2(materializePath).mode & 73) === 0) {
          details.push(`${MATERIALIZE_ENV_SCRIPT_REL} is not executable`);
        }
        return {
          id: "secrets.env-op",
          title: ".env.op + gitignore secrets contract",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Secret reference file and ignore rules are in parity" : `${details.length} env parity issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const details = [];
        const envOpPath = join3(ctx.repoRoot, ".env.op");
        const canonicalEnvOpPath = join3(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op");
        if (!existsSync2(canonicalEnvOpPath)) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler package is missing the neutral .env.op template", changedFiles: [], details: [] };
        }
        const canonicalEnvOp = readText(canonicalEnvOpPath);
        if (!existsSync2(envOpPath) || !readText(envOpPath).trim()) {
          changedFiles.push(envOpPath);
          if (!ctx.dryRun) writeText(envOpPath, canonicalEnvOp);
        } else {
          const current = readText(envOpPath);
          const activeMalformed = malformedOpReferences(current).filter((entry) => !entry.commentOnly);
          const invalidActive = current.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(({ line }) => line && !line.startsWith("#") && line.includes("=")).filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
          if (activeMalformed.length || invalidActive.length) {
            details.push(...activeMalformed.length ? [`Malformed active op:// reference(s) remain on line(s) ${Array.from(new Set(activeMalformed.map((entry) => entry.line))).join(", ")}; repair them manually without replacing valid user references`] : []);
            details.push(...invalidActive.length ? [`Unsafe active value(s) remain on line(s) ${invalidActive.map((entry) => entry.number).join(", ")}; repair them manually`] : []);
            return { id: finding.id, title: finding.title, status: "blocked", summary: "Manual cleanup still required", changedFiles: [], details };
          } else {
            const repaired = removeMalformedCommentOpReferences(current);
            const next = repaired.text;
            if (next !== current) {
              changedFiles.push(envOpPath);
              if (!ctx.dryRun) writeText(envOpPath, next);
            }
          }
        }
        const gitignorePath = join3(ctx.repoRoot, ".gitignore");
        const gitignore = safeReadText(gitignorePath) ?? "";
        const requiredBlock = `# Secrets \u2014 .env is materialized from .env.op by \`op inject\` on mise enter,
# staged through a mktemp file and moved into place only on success.
# NEVER commit it. .env.op holds only 1Password references or safe literals and IS committed.
.env
.env.*
!.env.op
`;
        if (!gitignore.includes("!.env.op") || !gitignore.includes(".env.*")) {
          changedFiles.push(gitignorePath);
          if (!ctx.dryRun) writeText(gitignorePath, `${gitignore.replace(/\s*$/, "")}${gitignore.trim() ? "\n\n" : ""}${requiredBlock}`);
        }
        const misePath = join3(ctx.repoRoot, "mise.toml");
        if (!existsSync2(misePath)) {
          if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
            return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and the packaged template is unavailable", changedFiles: [], details: [] };
          }
        }
        if (existsSync2(misePath)) {
          const currentMise = readText(misePath);
          const nextMise = upsertOpInjectHook(currentMise);
          if (nextMise !== currentMise) {
            changedFiles.push(misePath);
            if (!ctx.dryRun) writeText(misePath, nextMise);
          }
        }
        const materializePath = join3(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
        const expectedMaterializer = templateMaterializeEnvScript(ctx);
        if (!expectedMaterializer) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler package is missing materialize-env.sh", changedFiles: [], details: [] };
        }
        if (safeReadText(materializePath) !== expectedMaterializer || existsSync2(materializePath) && (lstatSync2(materializePath).mode & 73) === 0) {
          changedFiles.push(materializePath);
          if (!ctx.dryRun) {
            writeText(materializePath, expectedMaterializer);
            chmodSync(materializePath, 493);
          }
        }
        const uniqueChangedFiles = [...new Set(changedFiles)].sort();
        return {
          id: finding.id,
          title: finding.title,
          status: uniqueChangedFiles.length ? "applied" : "noop",
          summary: uniqueChangedFiles.length ? "Reconciled the canonical .env materialization contract" : "No changes required",
          changedFiles: uniqueChangedFiles,
          details
        };
      }
    }
  ];
}
function createProjectProvenanceChecks() {
  return [
    {
      id: "provenance.copier",
      title: ".copier-answers.yml provenance + drift report",
      audit: (ctx) => {
        const details = [];
        const path = join3(ctx.repoRoot, ".copier-answers.yml");
        const text2 = safeReadText(path);
        const project = readProjectJson(ctx);
        if (!text2) {
          details.push(".copier-answers.yml missing");
        } else {
          if (!text2.startsWith("# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY")) details.push("missing Copier overwrite warning header");
          if (!text2.includes("_src_path:")) details.push("_src_path missing");
          if (project?.project_name) {
            const nameMatch = text2.match(/project_name:\s*(.+)/);
            if (!nameMatch || nameMatch[1]?.trim() !== String(project.project_name)) details.push("project_name drift between .copier-answers.yml and .project.json");
          }
          if (project?.project_description) {
            const descMatch = text2.match(/project_description:\s*([\s\S]*?)(?=\n\w|$)/);
            const yamlDesc = descMatch?.[1]?.replace(/\n\s+/g, " ").trim() ?? "";
            if (yamlDesc !== String(project.project_description)) details.push("project_description drift between .copier-answers.yml and .project.json");
          }
        }
        return {
          id: "provenance.copier",
          title: ".copier-answers.yml provenance + drift report",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Copier provenance is in parity" : `${details.length} provenance issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const project = canonicalProjectJson(ctx);
        const text2 = `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY
_src_path: ${join3(ctx.pjanglerRoot, "templates", "commonproject")}
project_description: ${String(project.project_description)}
project_name: ${String(project.project_name)}
ticket_provider: ${String(project.ticket_provider?.type ?? "plane")}
`;
        const path = join3(ctx.repoRoot, ".copier-answers.yml");
        if (safeReadText(path) !== text2) {
          changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, text2);
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Copier provenance file refreshed" : "No changes required",
          changedFiles,
          details: []
        };
      }
    }
  ];
}
function supportedCliProjectionIssues(repoRoot) {
  const issues = [];
  const managedSkills = join3(repoRoot, ".agents", "skills");
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join3(repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (!rootStat) {
      issues.push(`${rootName} missing`);
      continue;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      issues.push(`${rootName} must be a real configuration directory`);
      continue;
    }
    const skills = join3(root, "skills");
    const skillsStat = lstatIfPresent(skills);
    if (!skillsStat) {
      issues.push(`${rootName}/skills missing`);
      continue;
    }
    let projectedSkills = skills;
    if (skillsStat.isSymbolicLink()) {
      let rawTarget = "";
      try {
        rawTarget = readlinkSync(skills);
      } catch {
        issues.push(`${rootName}/skills is an unreadable symlink`);
        continue;
      }
      if (rawTarget !== CANONICAL_CLI_SKILLS_ALIAS) {
        issues.push(`${rootName}/skills must target ${CANONICAL_CLI_SKILLS_ALIAS}`);
        continue;
      }
      const targetStat = lstatIfPresent(managedSkills);
      if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        issues.push(`${rootName}/skills alias target .agents/skills is missing or unsafe`);
        continue;
      }
      try {
        if (realpathSync(skills) !== realpathSync(managedSkills)) {
          issues.push(`${rootName}/skills resolves outside .agents/skills`);
          continue;
        }
      } catch {
        issues.push(`${rootName}/skills alias is broken`);
        continue;
      }
      projectedSkills = managedSkills;
    } else if (!skillsStat.isDirectory()) {
      issues.push(`${rootName}/skills is not a directory`);
      continue;
    }
    const hasGeneratedSkill = existsSync2(projectedSkills) && readdirSync2(projectedSkills).some((name) => {
      const skillFile = join3(projectedSkills, name, "SKILL.md");
      return existsSync2(skillFile) && lstatSync2(skillFile).isFile();
    });
    if (!hasGeneratedSkill) issues.push(`${rootName}/skills contains no BMAD skill configuration`);
  }
  return issues;
}
var SUPPORTED_CLI_GITIGNORE_BLOCK = `# PJAN-57: all six generated CLI configurations are durable project state.
${SUPPORTED_CLI_ROOTS.flatMap((root) => [`!${root}/`, `!${root}/**`]).join("\n")}`;
function supportedCliGitignoreIssues(repoRoot) {
  const text2 = safeReadText(join3(repoRoot, ".gitignore")) ?? "";
  return SUPPORTED_CLI_ROOTS.flatMap((root) => [
    ...!text2.split(/\r?\n/).includes(`!${root}/`) ? [`.gitignore must unignore ${root}/`] : [],
    ...!text2.split(/\r?\n/).includes(`!${root}/**`) ? [`.gitignore must unignore ${root}/**`] : []
  ]);
}
function ensureSupportedCliGitignore(ctx) {
  if (!supportedCliGitignoreIssues(ctx.repoRoot).length) return [];
  const path = join3(ctx.repoRoot, ".gitignore");
  const current = safeReadText(path) ?? "";
  const next = `${current.replace(/\s*$/, "")}${current.trim() ? "\n\n" : ""}${SUPPORTED_CLI_GITIGNORE_BLOCK}
`;
  if (!ctx.dryRun) writeText(path, next);
  return [path];
}
function ensureSupportedCliProjections(ctx) {
  const changedFiles = [];
  const blockers = [];
  const managedSkills = join3(ctx.repoRoot, ".agents", "skills");
  const managedStat = lstatIfPresent(managedSkills);
  if (!managedStat || managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
    return { changedFiles, blockers: [".agents/skills must be a real BMAD-generated directory before CLI projections can be created"] };
  }
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join3(ctx.repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
      blockers.push(`${rootName} is not a real configuration directory`);
      continue;
    }
    if (!rootStat) {
      changedFiles.push(root);
      if (!ctx.dryRun) mkdirSync2(root, { recursive: false });
    }
    const skills = join3(root, "skills");
    const skillsStat = lstatIfPresent(skills);
    if (!skillsStat) {
      changedFiles.push(skills);
      if (!ctx.dryRun) symlinkSync(CANONICAL_CLI_SKILLS_ALIAS, skills, "dir");
      continue;
    }
    if (skillsStat.isSymbolicLink()) {
      try {
        if (readlinkSync(skills) !== CANONICAL_CLI_SKILLS_ALIAS || realpathSync(skills) !== realpathSync(managedSkills)) {
          blockers.push(`${rootName}/skills is not the managed .agents/skills alias`);
        }
      } catch {
        blockers.push(`${rootName}/skills is an unreadable or broken symlink`);
      }
    } else if (!skillsStat.isDirectory()) {
      blockers.push(`${rootName}/skills is not a directory`);
    }
  }
  return { changedFiles: [...new Set(changedFiles)].sort(), blockers };
}
function createBmadChecks() {
  return [
    {
      id: "bmad.scaffold",
      title: "BMAD modules/docs scaffold",
      audit: (ctx) => {
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: "bmad.scaffold",
            title: "BMAD modules/docs scaffold",
            status: "fail",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            details: [manifestSelection.error],
            fixable: false
          };
        }
        const targetRoot = join3(ctx.repoRoot, "_bmad");
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
        const missing = sentinels.filter((file) => !existsSync2(join3(targetRoot, file)));
        const projectNameIssues = bmadProjectNameIssues(ctx.repoRoot);
        const details = [
          ...missing.map((file) => `_bmad/${file}`),
          ...projectNameIssues.details
        ];
        return {
          id: "bmad.scaffold",
          title: "BMAD modules/docs scaffold",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "BMAD scaffold and project identity parity verified" : `${details.length} BMAD scaffold issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            changedFiles,
            details: [manifestSelection.error]
          };
        }
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        if (ctx.dryRun) {
          const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
          changedFiles.push(...sentinels.map((file) => join3(ctx.repoRoot, "_bmad", file)).filter((path) => !existsSync2(path)));
          changedFiles.push(...bmadProjectNameIssues(ctx.repoRoot).paths);
          return {
            id: finding.id,
            title: finding.title,
            status: changedFiles.length ? "applied" : "noop",
            summary: changedFiles.length ? "Would run non-interactive bmad-method install" : "No changes required",
            changedFiles,
            details: [
              `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules)}`
            ]
          };
        }
        const preservedSkillsManifest = tryParseJson(
          safeReadText(join3(ctx.repoRoot, ".agents", "skills.json"))
        );
        const expectedChangedPaths = [
          ...requiredBmadSentinels(ctx.repoRoot, selectedModules).map((file) => join3(ctx.repoRoot, "_bmad", file)).filter((path) => !existsSync2(path)),
          ...bmadProjectNameIssues(ctx.repoRoot).paths
        ];
        const install = runBmadInstall(ctx.repoRoot, selectedModules);
        if (!install.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: `Failed to run bmad-method install`,
            changedFiles: [],
            details: [install.error ?? "Unknown error"]
          };
        }
        const provisioned = provisionBmadSkills(ctx, preservedSkillsManifest);
        if (!provisioned.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: `BMAD installed but Skillex pack ${BMAD_PACK_VERSION} provisioning failed`,
            changedFiles: [],
            details: [provisioned.error ?? "Unknown BMAD pack error"]
          };
        }
        changedFiles.push(...expectedChangedPaths.filter(existsSync2));
        changedFiles.push(...provisioned.changedFiles);
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? `Installed BMAD scaffold with Skillex pack ${BMAD_PACK_VERSION} skills` : "No changes required",
          changedFiles,
          details: []
        };
      }
    },
    {
      id: "bmad.version",
      title: "BMAD version currency",
      audit: (ctx) => {
        const installed = readInstalledBmadVersion(ctx.repoRoot);
        if (!installed) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "skip",
            summary: existsSync2(join3(ctx.repoRoot, "_bmad")) ? "BMAD installed but version manifest unreadable" : "No BMAD install present",
            details: [],
            fixable: false
          };
        }
        const pinned = ctx.bmadVersionPin?.trim();
        const resolved = pinned ? void 0 : resolveBmadDistTags(ctx.homeDir);
        const available = pinned ?? resolved?.distTags?.[BMAD_TARGET_CHANNEL];
        if (!available) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "skip",
            summary: `BMAD ${installed} installed; latest ${BMAD_TARGET_CHANNEL} version unknown (npm unreachable)`,
            details: [`Could not resolve ${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL} from npm`],
            fixable: false
          };
        }
        const targetLabel = pinned ? `pinned ${available}` : `${BMAD_TARGET_CHANNEL} ${available}`;
        const staleNote = resolved?.stale ? `  ${glyph.dot} cached` : "";
        const comparison = compareBmadVersions(installed, available);
        if (pinned ? comparison === 0 : comparison >= 0) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "pass",
            summary: `BMAD ${installed} is current (${targetLabel})${staleNote}`,
            details: [],
            fixable: false
          };
        }
        const pinnedMismatch = Boolean(pinned && comparison > 0);
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "warn",
          summary: pinnedMismatch ? `BMAD ${installed} does not match ${targetLabel}` : `BMAD ${installed} is behind ${targetLabel} \u2014 upgrade available`,
          details: [
            `installed: ${installed}`,
            pinned ? `required transaction pin: ${available}` : `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
            !pinned && resolved?.distTags.latest ? `stable latest: ${resolved.distTags.latest}` : "",
            "run `pj migrate bmad.version` to upgrade"
          ].filter(Boolean),
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        if (finding.status !== "warn") {
          return {
            id: finding.id,
            title: finding.title,
            status: "noop",
            summary: finding.status === "skip" ? finding.summary : "BMAD already current",
            changedFiles: [],
            details: []
          };
        }
        const installed = readInstalledBmadVersion(ctx.repoRoot);
        const available = ctx.bmadVersionPin?.trim() ?? resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
        const manifestPath = join3(ctx.repoRoot, "_bmad", "_config", "manifest.yaml");
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            changedFiles: [],
            details: [manifestSelection.error]
          };
        }
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        if (ctx.dryRun) {
          return {
            id: finding.id,
            title: finding.title,
            status: "applied",
            summary: `Would upgrade BMAD ${installed ?? "?"} -> ${available ?? BMAD_TARGET_CHANNEL}`,
            changedFiles: [manifestPath],
            details: [
              `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL)}`
            ]
          };
        }
        const preservedSkillsManifest = tryParseJson(
          safeReadText(join3(ctx.repoRoot, ".agents", "skills.json"))
        );
        const install = runBmadInstall(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL);
        if (!install.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Failed to upgrade BMAD via installer",
            changedFiles: [],
            details: [install.error ?? "Unknown error"]
          };
        }
        const provisioned = provisionBmadSkills(ctx, preservedSkillsManifest);
        if (!provisioned.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: `BMAD upgraded but Skillex pack ${BMAD_PACK_VERSION} provisioning failed`,
            changedFiles: [],
            details: [provisioned.error ?? "Unknown BMAD pack error"]
          };
        }
        const nowInstalled = readInstalledBmadVersion(ctx.repoRoot);
        const upgraded = Boolean(nowInstalled && installed && compareBmadVersions(nowInstalled, installed) > 0);
        return {
          id: finding.id,
          title: finding.title,
          status: upgraded ? "applied" : "noop",
          summary: upgraded ? `Upgraded BMAD ${installed} -> ${nowInstalled}` : `BMAD reinstalled (${nowInstalled ?? "?"})`,
          changedFiles: Array.from(/* @__PURE__ */ new Set([
            ...upgraded ? [manifestPath] : [],
            ...provisioned.changedFiles
          ])),
          details: []
        };
      }
    },
    {
      id: "bmad.cli-roots",
      title: "Supported BMAD CLI projection roots",
      audit: (ctx) => {
        const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS);
        const present = unsupportedNames.filter((name) => existsSync2(join3(ctx.repoRoot, name)));
        const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
        const supportedIssues = supportedCliProjectionIssues(ctx.repoRoot);
        const details = [
          ...supportedIssues,
          ...supportedCliGitignoreIssues(ctx.repoRoot),
          ...attestations.map((entry) => `${entry.name}: ${entry.safe ? "generated and safely removable" : `ambiguous/user-owned \u2014 ${entry.reason}`}`)
        ];
        return {
          id: "bmad.cli-roots",
          title: "Supported BMAD CLI projection roots",
          status: details.length ? "fail" : "pass",
          summary: details.length ? `${supportedIssues.length} supported projection issue(s); ${present.length} unsupported root(s)` : "All six supported CLI projections are configured and no unsupported roots are present",
          details,
          fixable: attestations.every((entry) => entry.safe)
        };
      },
      migrate: (ctx, finding) => {
        const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS);
        const present = unsupportedNames.filter((name) => existsSync2(join3(ctx.repoRoot, name)));
        const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
        const blocked = attestations.filter((entry) => !entry.safe);
        if (blocked.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Refusing to remove ambiguous or user-owned CLI projection roots",
            changedFiles: [],
            details: blocked.map((entry) => `${entry.name}: ${entry.reason}`)
          };
        }
        const projectionResult = ensureSupportedCliProjections(ctx);
        if (projectionResult.blockers.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Supported CLI projections contain unsafe or user-owned conflicts",
            changedFiles: [],
            details: projectionResult.blockers
          };
        }
        const gitignoreChanges = ensureSupportedCliGitignore(ctx);
        const removedRoots = attestations.map((entry) => join3(ctx.repoRoot, entry.name));
        if (!ctx.dryRun) for (const path of removedRoots) rmSync(path, { recursive: true, force: true });
        const changedFiles = [.../* @__PURE__ */ new Set([...projectionResult.changedFiles, ...gitignoreChanges, ...removedRoots])].sort();
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? `Reconciled six supported projections and removed ${removedRoots.length} attested unsupported root(s)` : "No changes required",
          changedFiles,
          details: attestations.map((entry) => `${entry.name}: ${entry.reason}`)
        };
      }
    }
  ];
}
function createHermesChecks() {
  return [
    {
      id: "hermes.pm-scaffold",
      title: "Hermes orchestrator scaffold parity",
      audit: (ctx) => {
        const selection = managedHermesScaffoldRoles(ctx);
        if (selection.roles.length === 0 && selection.blockers.length === 0) {
          return { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "skip", summary: "No provisioned pm or director role present", details: [], fixable: false };
        }
        const details = [...selection.blockers];
        const templateRoleDir = join3(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
        const managedScripts = templateFiles(join3(templateRoleDir, ".scripts")).filter((rel) => rel !== "sentinel.prompt.md.jinja");
        for (const role of selection.roles) {
          const prefix = role.agentId || role.role;
          for (const rel of ["role.yaml", "SOUL.md", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md"]) {
            if (!existsSync2(join3(role.roleDir, rel))) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, join3(role.roleDir, rel))}`);
          }
          const wrapper = join3(role.roleDir, "hermes");
          const expectedWrapper = renderHermesWrapper(role, templateRoleDir);
          if (!existsSync2(wrapper)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, wrapper)}`);
          else if (safeReadText(wrapper) !== expectedWrapper) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, wrapper)}`);
          const expectedIgnore = readText(join3(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role);
          const ignorePath = join3(role.roleDir, ".gitignore");
          if (!existsSync2(ignorePath)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, ignorePath)}`);
          else if (safeReadText(ignorePath) !== expectedIgnore) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, ignorePath)}`);
          for (const rel of managedScripts) {
            const source = join3(templateRoleDir, ".scripts", rel);
            const target = join3(role.roleDir, ".scripts", rel);
            if (!existsSync2(target)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, target)}`);
            else if (safeReadText(target) !== readText(source)) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, target)}`);
          }
          const promptPath = join3(role.roleDir, ".scripts", "sentinel.prompt.md");
          if (!existsSync2(promptPath)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, promptPath)}`);
          else if (safeReadText(promptPath) !== renderSentinelPrompt(role, templateRoleDir)) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, promptPath)}`);
          if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) details.push(`${prefix}: .gitmodules contains retired ${role.role} runtime submodule mapping`);
          if (!profileMetaInheritsDefault(join3(role.roleDir, "runtime", "profile.yaml"))) details.push(`${prefix}: runtime/profile.yaml missing inherited default config metadata`);
          const registry = safeReadText(registryPath(ctx.homeDir));
          if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
        }
        return {
          id: "hermes.pm-scaffold",
          title: "Hermes orchestrator scaffold parity",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? `${selection.roles.length} orchestrator scaffold(s) verified` : `${details.length} orchestrator scaffold issue(s) detected`,
          details,
          fixable: selection.blockers.length === 0
        };
      },
      migrate: (ctx, finding) => {
        const selection = managedHermesScaffoldRoles(ctx);
        const changedFiles = [];
        const details = [];
        if (selection.blockers.length > 0) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "Provisioned orchestrator manifest is invalid", changedFiles, details: selection.blockers };
        }
        if (selection.roles.length === 0) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "No provisioned pm or director role present", changedFiles, details: [] };
        }
        const templateRoleDir = join3(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
        const managedScripts = templateFiles(join3(templateRoleDir, ".scripts")).filter((rel) => rel !== "sentinel.prompt.md.jinja");
        for (const role of selection.roles) {
          const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
          details.push(...retirement.details);
          if (!retirement.ok) {
            return { id: finding.id, title: finding.title, status: "blocked", summary: `Failed to retire ${role.role} runtime submodule metadata safely`, changedFiles, details: [retirement.error ?? "unknown runtime retirement failure"] };
          }
          if (!existsSync2(join3(role.roleDir, "SOUL.md"))) writeIfDifferent(join3(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
          writeIfDifferent(join3(role.roleDir, "hermes"), renderHermesWrapper(role, templateRoleDir), ctx.dryRun, changedFiles, 493);
          writeIfDifferent(join3(role.roleDir, ".gitignore"), readText(join3(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role), ctx.dryRun, changedFiles);
          copyMissingRecursive(join3(templateRoleDir, ".runtime-scaffold"), join3(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
          copyMissingRecursive(join3(templateRoleDir, ".runtime-scaffold"), join3(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
          for (const rel of managedScripts) {
            const source = join3(templateRoleDir, ".scripts", rel);
            const executable = (lstatSync2(source).mode & 73) !== 0;
            writeIfDifferent(join3(role.roleDir, ".scripts", rel), readText(source), ctx.dryRun, changedFiles, executable ? 493 : void 0);
          }
          writeIfDifferent(join3(role.roleDir, ".scripts", "sentinel.prompt.md"), renderSentinelPrompt(role, templateRoleDir), ctx.dryRun, changedFiles);
          const profileMetaUpdated = upsertInheritedProfileMeta(join3(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
          if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
          const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
          if (registryUpdated) details.push(`updated ${registryUpdated}`);
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? `${selection.roles.length} orchestrator scaffold(s) normalized` : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.untracked-runtimes",
      title: "Hermes agent runtimes untracked + gitignored",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (roles.length === 0) {
          return {
            id: "hermes.untracked-runtimes",
            title: "Hermes agent runtimes untracked + gitignored",
            status: "skip",
            summary: "No Hermes roles present",
            details: [],
            fixable: false
          };
        }
        const details = [];
        for (const role of roles) {
          const roleRelDir = relative2(ctx.repoRoot, role.roleDir);
          const runtimeRelPath = join3(roleRelDir, "runtime");
          const lsResult = spawnSync("git", ["ls-files", "--stage", runtimeRelPath], {
            cwd: ctx.repoRoot,
            encoding: "utf8"
          });
          if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
            details.push(`submodule runtime is tracked in Git index at ${runtimeRelPath}`);
          }
          if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) {
            details.push(`stale .gitmodules mapping exists for ${runtimeRelPath}`);
          }
          const gitignorePath = join3(role.roleDir, ".gitignore");
          if (existsSync2(gitignorePath)) {
            const content = safeReadText(gitignorePath) ?? "";
            const lines = content.split(/\r?\n/).map((line) => line.trim());
            if (!lines.includes("runtime/") && !lines.includes("runtime")) {
              details.push(`.gitignore missing runtime/ ignore entry in ${relative2(ctx.repoRoot, gitignorePath)}`);
            }
          } else {
            details.push(`.gitignore is missing in ${relative2(ctx.repoRoot, gitignorePath)}`);
          }
        }
        return {
          id: "hermes.untracked-runtimes",
          title: "Hermes agent runtimes untracked + gitignored",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "All Hermes agent runtimes are untracked and gitignored" : `${details.length} issue(s) with untracked/ignored runtimes detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        for (const role of roles) {
          const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
          details.push(...retirement.details);
          if (!retirement.ok) {
            return {
              id: finding.id,
              title: finding.title,
              status: "blocked",
              summary: "Failed to retire Hermes runtime submodule metadata safely",
              changedFiles,
              details: [retirement.error ?? "unknown runtime retirement failure"]
            };
          }
          const gitignorePath = join3(role.roleDir, ".gitignore");
          let content = "";
          let isIgnored = false;
          if (existsSync2(gitignorePath)) {
            content = safeReadText(gitignorePath) ?? "";
            const lines = content.split(/\r?\n/).map((line) => line.trim());
            isIgnored = lines.includes("runtime/") || lines.includes("runtime");
          }
          if (!isIgnored) {
            details.push(`ignore runtime/ in ${relative2(ctx.repoRoot, gitignorePath)}`);
            changedFiles.push(gitignorePath);
            if (!ctx.dryRun) {
              if (content && !content.endsWith("\n")) {
                content += "\n";
              }
              content += "runtime/\n";
              writeText(gitignorePath, content);
            }
          }
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Hermes agent runtimes made untracked and ignored" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "systemd.sentinel",
      title: "Hermes systemd/sentinel units enabled + active",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const requiredRoles = roles.filter((role) => role.deploymentSystemd !== "deferred");
        if (!requiredRoles.length) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "pass", summary: "systemd is intentionally deferred for every local-only Hermes role", details: [], fixable: false };
        }
        const probe = systemctlUser(["is-system-running"]);
        if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "warn", summary: "systemd --user unavailable; unit state not auditable here", details: [], fixable: false };
        }
        const details = [];
        for (const role of requiredRoles) {
          for (const unit of [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`]) {
            const state = checkUnit(unit);
            if (!state.enabled || !state.active) details.push(`${unit} should be enabled+active`);
          }
        }
        return {
          id: "systemd.sentinel",
          title: "Hermes systemd/sentinel units enabled + active",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Hermes user units are enabled and active" : `${details.length} systemd parity issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const roles = discoverRoles(ctx.repoRoot).filter((role) => role.deploymentSystemd !== "deferred");
        const changedFiles = [];
        const details = [];
        if (!roles.length) {
          return { id: finding.id, title: finding.title, status: "skipped", summary: "systemd is intentionally deferred for local-only Hermes roles", changedFiles, details };
        }
        const probe = systemctlUser(["is-system-running"]);
        if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
        }
        for (const role of roles) {
          const sysDir = join3(ctx.homeDir, ".config", "systemd", "user");
          const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`];
          const allUnitsPresent = units.every((unit) => existsSync2(join3(sysDir, unit)));
          const unitsStale = units.some((unit) => {
            const text2 = safeReadText(join3(sysDir, unit));
            if (text2 === null) return true;
            return text2.includes("/agents/hermes/") && !text2.includes(role.roleDir);
          });
          if (allUnitsPresent && !unitsStale) {
            if (ctx.dryRun) {
              details.push(`would run: systemctl --user enable --now ${units.join(" ")}`);
            } else {
              systemctlUser(["daemon-reload"]);
              for (const unit of units) {
                systemctlUser(["enable", "--now", unit]);
              }
            }
            continue;
          }
          for (const script of [join3(role.roleDir, ".scripts", "70-systemd.sh")]) {
            if (!existsSync2(script)) {
              details.push(`script failed: missing ${script}`);
              continue;
            }
            if (ctx.dryRun) {
              details.push(`would run: FORCE_SYSTEMD=1 bash ${script}`);
            } else {
              const result = spawnSync("bash", [script], {
                cwd: role.roleDir,
                encoding: "utf8",
                env: { ...process.env, FORCE_SYSTEMD: "1" }
              });
              if (result.status !== 0) {
                details.push(`script failed: ${script}: ${result.stderr.trim() || result.stdout.trim()}`);
              } else {
                details.push(`regenerated systemd units for ${role.agentId} from ${role.roleDir}`);
              }
            }
          }
        }
        return {
          id: finding.id,
          title: finding.title,
          status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: details.length ? ctx.dryRun ? "Planned systemd remediation commands" : "Attempted systemd remediation" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.runtime-singleton",
      title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "hermes.runtime-singleton", title: "Hermes singleton runtime (shared config/auth, per-agent memory)", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          if (!existsSync2(plan.fleetRoot)) {
            details.push(`fleet root missing at ${plan.fleetRoot}`);
            continue;
          }
          if (!existsSync2(plan.profileDir)) {
            details.push(`profile dir missing: ${plan.profileDir}`);
          } else if (lstatSync2(plan.profileDir).isSymbolicLink()) {
            details.push(`profile dir is a symlink (must be a real dir): ${plan.profileDir}`);
          }
          for (const link of plan.links) {
            const state = linkState(link.path, link.target);
            if (state !== "ok") details.push(`${state}: ${link.path} -> ${link.target}`);
          }
        }
        return {
          id: "hermes.runtime-singleton",
          title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Singleton runtime contract satisfied" : `${details.length} singleton-runtime issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          if (!existsSync2(plan.fleetRoot)) {
            details.push(`blocked: fleet root missing at ${plan.fleetRoot}`);
            continue;
          }
          for (const shared of plan.sharedSeeds) {
            if (existsSync2(shared.rootPath)) continue;
            const donor = existsSync2(shared.runtimePath) ? shared.runtimePath : null;
            if (!donor) continue;
            details.push(`seed fleet ${basename2(shared.rootPath)} from ${donor}`);
            changedFiles.push(shared.rootPath);
            if (!ctx.dryRun) copyFileSync(donor, shared.rootPath);
          }
          if (existsSync2(plan.profileDir) && lstatSync2(plan.profileDir).isSymbolicLink()) {
            details.push(`convert profile symlink to real dir: ${plan.profileDir}`);
            changedFiles.push(plan.profileDir);
            if (!ctx.dryRun) unlinkSync(plan.profileDir);
          }
          if (!existsSync2(plan.profileDir)) {
            details.push(`create profile dir: ${plan.profileDir}`);
            changedFiles.push(plan.profileDir);
            if (!ctx.dryRun) mkdirSync2(plan.profileDir, { recursive: true });
          }
          for (const link of plan.links) {
            const state = linkState(link.path, link.target);
            if (state === "ok") continue;
            if (link.ensureTargetDir && !existsSync2(link.target) && !ctx.dryRun) {
              mkdirSync2(link.target, { recursive: true });
            }
            details.push(`link ${link.path} -> ${link.target}`);
            changedFiles.push(link.path);
            if (ctx.dryRun) continue;
            if (existsSync2(link.path) || isDanglingLink(link.path)) {
              const lst = lstatSync2(link.path);
              if (lst.isSymbolicLink()) {
                unlinkSync(link.path);
              } else {
                const parked = `${link.path}.pre-singleton`;
                renameSync(link.path, parked);
                details.push(`parked pre-existing ${link.path} at ${parked}`);
              }
            }
            ensureParent(link.path);
            symlinkSync(link.target, link.path);
          }
        }
        return {
          id: finding.id,
          title: finding.title,
          status: details.some((d) => d.startsWith("blocked:")) ? "blocked" : changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: changedFiles.length ? ctx.dryRun ? "Planned singleton-runtime wiring" : "Singleton runtime wired" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.profile-wiring",
      title: "Launcher + systemd HERMES_HOME points at the named profile",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "hermes.profile-wiring", title: "Launcher + systemd HERMES_HOME points at the named profile", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          const launcher = join3(role.roleDir, "hermes");
          const text2 = safeReadText(launcher);
          if (text2 === null) {
            details.push(`launcher missing: ${relative2(ctx.repoRoot, launcher)}`);
          } else {
            const assigned = /^HERMES_HOME=(.*)$/m.exec(text2)?.[1]?.trim();
            if (assigned !== void 0 && !isProfileHomeExpr(assigned)) {
              details.push(`launcher sets HERMES_HOME=${assigned} instead of the named profile dir (disables shared auth + profile identity): ${relative2(ctx.repoRoot, launcher)}`);
            }
            if (/HERMES_OAUTH_FILE/.test(text2)) {
              details.push(`launcher exports HERMES_OAUTH_FILE, which Hermes does not implement (dead config): ${relative2(ctx.repoRoot, launcher)}`);
            }
          }
          for (const unit of profileUnits(role)) {
            const unitPath = join3(ctx.homeDir, ".config", "systemd", "user", unit);
            const unitText = safeReadText(unitPath);
            if (unitText === null) continue;
            const current = /^Environment=HERMES_HOME=(.*)$/m.exec(unitText)?.[1]?.trim();
            if (current && current !== plan.profileDir) {
              details.push(`${unit} HERMES_HOME=${current} (expected ${plan.profileDir})`);
            }
            if (/^Environment=HERMES_OAUTH_FILE=/m.test(unitText)) {
              details.push(`${unit} sets HERMES_OAUTH_FILE (dead config)`);
            }
          }
        }
        return {
          id: "hermes.profile-wiring",
          title: "Launcher + systemd HERMES_HOME points at the named profile",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "HERMES_HOME wiring is in parity" : `${details.length} HERMES_HOME wiring issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        let unitsTouched = false;
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          const launcher = join3(role.roleDir, "hermes");
          const text2 = safeReadText(launcher);
          if (text2 !== null) {
            const before = /^HERMES_HOME=(.*)$/m.exec(text2)?.[1]?.trim();
            const rewritten = rewriteLauncher(text2, role.profileName || role.agentId);
            if (rewritten !== text2) {
              const rel = relative2(ctx.repoRoot, launcher);
              if (before !== void 0 && !isProfileHomeExpr(before)) {
                details.push(`rewrite launcher HERMES_HOME ${before} -> ${plan.profileDir}: ${rel}`);
              }
              if (/HERMES_OAUTH_FILE/.test(text2)) {
                details.push(`strip dead HERMES_OAUTH_FILE export: ${rel}`);
              }
              writeIfDifferent(launcher, rewritten, ctx.dryRun, changedFiles, 493);
            }
          }
          for (const unit of profileUnits(role)) {
            const unitPath = join3(ctx.homeDir, ".config", "systemd", "user", unit);
            const unitText = safeReadText(unitPath);
            if (unitText === null) continue;
            let next = unitText.replace(/^Environment=HERMES_HOME=.*$/m, `Environment=HERMES_HOME=${plan.profileDir}`);
            next = next.replace(/^Environment=HERMES_OAUTH_FILE=.*\n/m, "");
            if (next !== unitText) {
              details.push(`repoint ${unit} HERMES_HOME -> ${plan.profileDir}`);
              writeIfDifferent(unitPath, next, ctx.dryRun, changedFiles);
              unitsTouched = true;
            }
          }
        }
        if (unitsTouched && !ctx.dryRun) {
          systemctlUser(["daemon-reload"]);
          details.push("systemctl --user daemon-reload (restart units to pick up the new HERMES_HOME)");
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: changedFiles.length ? ctx.dryRun ? "Planned HERMES_HOME rewiring" : "HERMES_HOME rewired to named profiles" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.registry-parity",
      title: "Fleet registry matches .project.json (no duplicate or stale agents)",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        const details = [];
        let malformedRoleGate = false;
        const registryPath2 = join3(ctx.homeDir, ".hermes", "agents-registry.yaml");
        const registry = readRegistry(registryPath2);
        if (!registry) {
          if (!roles.length && declaredAgentIds(ctx.repoRoot).length === 0) {
            return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles or declared agents present", details: [], fixable: false };
          }
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "warn", summary: `registry unreadable at ${registryPath2}`, details: [], fixable: false };
        }
        const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
        const owned = ownedRegistryEntries(registry, ctx.repoRoot);
        const unprovisioned = unprovisionedRoleAgents(registry, ctx.repoRoot, canonical);
        if (unprovisioned.length) {
          return {
            id: "hermes.registry-parity",
            title: "Fleet registry matches .project.json (no duplicate or stale agents)",
            status: "fail",
            summary: `${unprovisioned.length} unprovisioned Hermes role blocker(s) detected`,
            details: unprovisioned.map(
              ({ agentId, roleDir, sources }) => `agent "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role, do not delete its registry/declaration`
            ),
            fixable: false
          };
        }
        if (canonical.size === 0) {
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles, declarations, or registry entries present", details: [], fixable: false };
        }
        for (const [agentId, entry] of owned) {
          const roleDir = String(entry?.role_dir ?? "");
          if (!canonical.has(agentId)) {
            details.push(`stale/duplicate registry agent "${agentId}" for ${roleDir} (role.yaml declares ${[...canonical].join(", ")})`);
          }
        }
        for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
          details.push(`.project.json declares agent "${extra}" that no role.yaml claims`);
        }
        for (const role of roles) {
          const expectedBloodbankEnabled = roleBloodbankEnabled(role);
          if (expectedBloodbankEnabled === null) {
            details.push(`${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
            malformedRoleGate = true;
          }
          const entry = registry[role.agentId];
          if (!entry) {
            details.push(`registry is missing an entry for ${role.agentId}`);
            continue;
          }
          const entryRoleDir = String(entry.role_dir ?? "");
          if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
            details.push(`registry role_dir for ${role.agentId} is ${entryRoleDir} (expected ${role.roleDir})`);
          }
          const bin = String(entry.hermes?.bin ?? "");
          if (bin && !existsSync2(bin)) {
            details.push(`registry hermes.bin for ${role.agentId} does not exist: ${bin}`);
          }
          const bloodbank = entry.bloodbank ?? {};
          if (typeof bloodbank.enabled !== "boolean") {
            details.push(`registry entry for ${role.agentId} bloodbank.enabled must be a strict boolean`);
          } else if (expectedBloodbankEnabled !== null && bloodbank.enabled !== expectedBloodbankEnabled) {
            details.push(`registry entry for ${role.agentId} bloodbank.enabled must match explicit role value ${expectedBloodbankEnabled}`);
          }
          if (bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
            details.push(`registry entry for ${role.agentId} must advertise bloodbank { gateway_scope: fleet, target_agent_id: ${role.agentId} }`);
          }
          const systemd = entry.systemd ?? {};
          for (const key of LEGACY_SYSTEMD_KEYS) {
            if (systemd[key] !== void 0) {
              details.push(`registry entry for ${role.agentId} carries retired systemd.${key}; the fleet-shared Bloodbank gateway owns command ingress`);
            }
          }
          const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
          if (existsSync2(legacyUnit)) {
            details.push(`retired per-agent consumer unit still on disk: ${legacyUnit}`);
          }
        }
        return {
          id: "hermes.registry-parity",
          title: "Fleet registry matches .project.json (no duplicate or stale agents)",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Fleet registry is in parity" : `${details.length} registry parity issue(s) detected`,
          details,
          fixable: !malformedRoleGate
        };
      },
      migrate: (ctx, finding) => {
        const changedFiles = [];
        const details = [];
        const registryPath2 = join3(ctx.homeDir, ".hermes", "agents-registry.yaml");
        let raw = safeReadText(registryPath2);
        if (raw === null) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: `registry unreadable at ${registryPath2}`, changedFiles, details };
        }
        const roles = discoverRoles(ctx.repoRoot);
        const malformedRoleGates = roles.filter((role) => roleBloodbankEnabled(role) === null);
        if (malformedRoleGates.length > 0) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Registry parity is blocked by malformed role Bloodbank gates",
            changedFiles,
            details: malformedRoleGates.map(
              (role) => `${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`
            )
          };
        }
        const missingRoles = roles.filter((role) => !raw.includes(`${role.agentId}:`));
        for (const role of missingRoles) {
          const updated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
          if (updated) details.push(`add missing fleet registry entry for ${role.agentId}`);
          if (!ctx.dryRun) raw = safeReadText(registryPath2) ?? raw;
        }
        if (ctx.dryRun && missingRoles.length) {
          return { id: finding.id, title: finding.title, status: "skipped", summary: "Planned missing fleet registry entries", changedFiles: [...new Set(changedFiles)], details };
        }
        let doc;
        try {
          doc = YAML.parse(raw);
        } catch {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "registry is not valid YAML", changedFiles, details };
        }
        const agents = doc?.agents ?? {};
        const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
        const unprovisioned = unprovisionedRoleAgents(agents, ctx.repoRoot, canonical);
        if (unprovisioned.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Registry parity is blocked by an unprovisioned Hermes role",
            changedFiles,
            details: unprovisioned.map(
              ({ agentId, roleDir, sources }) => `blocked: "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role without pruning registry/declaration state`
            )
          };
        }
        const fleetBin = fleetBinPath(ctx);
        let dirty = false;
        if (canonical.size === 0) {
          for (const [agentId] of ownedRegistryEntries(agents, ctx.repoRoot)) {
            details.push(`blocked: "${agentId}" has no role.yaml; provision the role instead of pruning the registry`);
          }
          for (const agentId of declaredAgentIds(ctx.repoRoot)) {
            if (!details.some((detail) => detail.includes(`"${agentId}"`))) {
              details.push(`blocked: "${agentId}" is declared but has no role.yaml; provision or restore the role`);
            }
          }
          if (details.length) {
            return {
              id: finding.id,
              title: finding.title,
              status: "blocked",
              summary: "Registry parity is blocked by an unprovisioned Hermes role",
              changedFiles,
              details
            };
          }
        }
        for (const role of roles) {
          const entry = agents[role.agentId];
          if (!entry) continue;
          const entryRoleDir = String(entry.role_dir ?? "");
          if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
            details.push(`repoint ${role.agentId} role_dir -> ${role.roleDir}`);
            entry.role_dir = role.roleDir;
            entry.project_path = ctx.repoRoot;
            dirty = true;
          }
          const bloodbank = entry.bloodbank ?? {};
          const expectedBloodbankEnabled = roleBloodbankEnabled(role) ?? false;
          if (bloodbank.enabled !== expectedBloodbankEnabled || bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
            details.push(`normalize fleet bloodbank routing for ${role.agentId} with enabled=${expectedBloodbankEnabled}`);
            entry.bloodbank = { ...bloodbank, enabled: expectedBloodbankEnabled, gateway_scope: "fleet", target_agent_id: role.agentId };
            dirty = true;
          }
          const systemd = entry.systemd;
          if (systemd) {
            for (const key of LEGACY_SYSTEMD_KEYS) {
              if (systemd[key] !== void 0) {
                details.push(`drop retired systemd.${key} from ${role.agentId}`);
                delete systemd[key];
                dirty = true;
              }
            }
          }
          const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
          if (existsSync2(legacyUnit)) {
            if (ctx.dryRun) {
              details.push(`would remove retired consumer unit ${legacyUnit}`);
            } else {
              systemctlUser(["disable", "--now", basename2(legacyUnit)]);
              rmSync(legacyUnit, { force: true });
              systemctlUser(["daemon-reload"]);
              systemctlUser(["reset-failed"]);
              details.push(`removed retired consumer unit ${legacyUnit}`);
            }
            changedFiles.push(legacyUnit);
          }
        }
        for (const [agentId, entry] of ownedRegistryEntries(agents, ctx.repoRoot)) {
          if (canonical.size > 0 && !canonical.has(agentId)) {
            details.push(`drop stale/duplicate registry agent "${agentId}"`);
            delete agents[agentId];
            dropDeclaredAgent(ctx, agentId, changedFiles, details);
            dirty = true;
            continue;
          }
          const hermes = entry.hermes ?? {};
          if (fleetBin && String(hermes.bin ?? "") !== fleetBin && !existsSync2(String(hermes.bin ?? ""))) {
            details.push(`repoint ${agentId} hermes.bin -> ${fleetBin}`);
            hermes.bin = fleetBin;
            entry.hermes = hermes;
            dirty = true;
          }
          if (hermes.oauth_file) {
            details.push(`drop dead hermes.oauth_file from ${agentId}`);
            delete hermes.oauth_file;
            dirty = true;
          }
        }
        if (canonical.size > 0) {
          for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
            dropDeclaredAgent(ctx, extra, changedFiles, details);
          }
        }
        if (dirty) {
          changedFiles.push(registryPath2);
          if (!ctx.dryRun) {
            doc.agents = agents;
            writeText(registryPath2, YAML.stringify(doc));
          }
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: changedFiles.length ? ctx.dryRun ? "Planned registry repair" : "Fleet registry repaired" : "No changes required",
          changedFiles,
          details
        };
      }
    }
  ];
}
function createProjectMomoChecks() {
  return [
    {
      id: "momo-lifecycle-plane",
      title: "Momo lifecycle-plane readiness profile",
      audit: () => ({
        id: "momo-lifecycle-plane",
        title: "Momo lifecycle-plane readiness profile",
        status: "skip",
        summary: "Momo readiness is an audit-only profile; use audit --profile momo-lifecycle-plane",
        details: [],
        fixable: false
      }),
      migrate: (ctx, finding) => ({
        id: finding.id,
        title: finding.title,
        status: "skipped",
        summary: "report-only profile; migration is intentionally skipped",
        changedFiles: [],
        details: ["Momo lifecycle-plane readiness checks are credential-bearing and are performed only by `audit --profile momo-lifecycle-plane`"]
      })
    }
  ];
}
function createProjectChecks() {
  return [
    ...createProjectJsonChecks(),
    ...createProjectProvenanceChecks(),
    ...createProjectMomoChecks()
  ];
}
function writeIfDifferent(path, content, dryRun, changedFiles, mode) {
  const normalized = content.endsWith("\n") ? content : `${content}
`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
}
function prettyTimestamp(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}
function formatAuditReport(report) {
  const counts = {};
  for (const rule of report.rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const idWidth = report.rules.reduce((width, rule) => Math.max(width, rule.id.length), 0);
  const tally = [];
  if (counts.pass) tally.push(green(`${counts.pass} passed`));
  if (counts.fail) tally.push(red(`${counts.fail} failed`));
  if (counts.warn) tally.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.skip) tally.push(gray(`${counts.skip} skipped`));
  const overall = report.ok ? `${green(glyph.pass)} ${bold("Parity audit passed")}` : `${red(glyph.fail)} ${bold("Parity audit failed")}`;
  const lines = [""];
  lines.push(`  ${overall}${tally.length ? `  ${dim(glyph.dot)}  ${joinDot(tally)}` : ""}`);
  lines.push(`  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(prettyTimestamp(report.auditedAt))}`);
  lines.push("");
  for (const rule of report.rules) {
    const style = statusStyle(rule.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(rule.id.padEnd(idWidth))}  ${rule.summary}`);
    for (const detail of rule.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// src/recipes/AgentHooksRecipe.ts
var AgentHooksRecipe = class extends Recipe {
  checks = createAgentHooksChecks();
  metadata = {
    id: "agent-hooks",
    name: "agent-hooks",
    description: "Project-scoped agent hooks and six-CLI skill topology",
    dependencies: ["mise"],
    commands: ["CopyAgentHooksTree", "WireMiseAgentHooks"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1FA9D} Agent-hooks layer installed!");
    console.log("   Next steps:");
    console.log("   1. mise run skills:sync  # sync .agents/skills.json into local CLI dirs");
    console.log("   2. mise run hooks:sync   # generate .claude/settings.json + inject codex/kimi/hermes");
    console.log("   3. git add .claude/settings.json .agents/hooks .agents/skills.json && commit (codex/kimi/hermes are per-dev)");
    console.log("   4. mise run hindsight:setup   # set HINDSIGHT_OP_KEY_REF to your 1Password item first");
    console.log("   5. Optional per-dev hook opt-out: copy .agents/local.example.json -> .agents/local.json");
  }
};

// src/recipes/BmadRecipe.ts
var BmadRecipe = class extends Recipe {
  checks = createBmadChecks();
  metadata = {
    id: "bmad",
    name: "bmad",
    description: "BMAD methodology and six supported CLI projections",
    dependencies: ["agent-hooks"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("BMAD lifecycle initialized for the six supported CLIs.");
  }
};

// src/commands/AddDockerfile.ts
var AddDockerfile = class extends Command {
  async invoke() {
    const filePath = "Dockerfile";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  Dockerfile already exists"),
        filePath
      };
    }
    const content = `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create Dockerfile" : "\u2705 Created Dockerfile"),
      filePath
    };
  }
};

// src/commands/AddDockerCompose.ts
var AddDockerCompose = class extends Command {
  async invoke() {
    const filePath = "docker-compose.yml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  docker-compose.yml already exists"),
        filePath
      };
    }
    const content = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create docker-compose.yml" : "\u2705 Created docker-compose.yml"),
      filePath
    };
  }
};

// src/commands/AddDockerignore.ts
var AddDockerignore = class extends Command {
  async invoke() {
    const filePath = ".dockerignore";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .dockerignore already exists"),
        filePath
      };
    }
    const content = `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .dockerignore" : "\u2705 Created .dockerignore"),
      filePath
    };
  }
};

// src/recipes/DockerRecipe.ts
var DockerRecipe = class extends Recipe {
  checks = [];
  metadata = {
    id: "docker",
    name: "docker",
    description: "Docker containerization setup",
    dependencies: [],
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"],
    publicRuleIds: []
  };
  constructor(context) {
    super(context);
    this.addIngredient(AddDockerfile).addIngredient(AddDockerCompose).addIngredient(AddDockerignore);
  }
  init(ctx, _input) {
    return this.invokeIngredients(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
};

// src/commands/hermes/EnsureTemplateConfig.ts
import { homedir as homedir3, platform } from "node:os";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5, dirname as dirname4 } from "node:path";

// src/parity/index.ts
import { existsSync as existsSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join4, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function resolvePjanglerRoot() {
  let dir = dirname3(fileURLToPath2(import.meta.url));
  while (dir !== dirname3(dir)) {
    if (existsSync3(join4(dir, "package.json")) && existsSync3(join4(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname3(dir);
  }
  return resolve4(process.cwd());
}
function lifecycleContext(repoArg, dryRun, acceptRegistryMatches = false, overrides = {}) {
  const repoRoot = resolve4(repoArg ?? process.cwd());
  return {
    ...overrides,
    targetDir: repoRoot,
    repoRoot,
    dryRun: overrides.dryRun ?? dryRun,
    force: overrides.force ?? false,
    pjanglerRoot: overrides.pjanglerRoot ?? resolvePjanglerRoot(),
    homeDir: overrides.homeDir ?? homedir2(),
    acceptRegistryMatches: overrides.acceptRegistryMatches ?? acceptRegistryMatches
  };
}
function getParityRuleIds() {
  return [...recipeRegistry.listRuleIds()];
}
function publicAudit(report) {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding)
  };
}
function publicMigration(report) {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result)
  };
}
function runAudit(repoArg) {
  return publicAudit(recipeRegistry.auditRecipes(lifecycleContext(repoArg, true)));
}
function runMigrationForRules(ruleIds, repoArg, dryRun, acceptRegistryMatches = false) {
  return publicMigration(recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches),
    ruleIds
  ));
}
function runMigration(selector, repoArg, dryRun, all, acceptRegistryMatches = false) {
  const ctx = lifecycleContext(repoArg, dryRun, acceptRegistryMatches);
  return publicMigration(all ? recipeRegistry.migrateAll(ctx) : recipeRegistry.migrateRules(ctx, selector ? [selector] : []));
}

// src/commands/hermes/EnsureTemplateConfig.ts
function resolveTemplateConfigPath() {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join5(homedir3(), ".config");
  return join5(base, "hermes-agent-template", "config.toml");
}
function detectHermesBin(home) {
  const candidates = [
    join5(home, "code", "hermes-agent", "venv", "bin", "hermes"),
    join5(home, "code", "hermes-agent", ".venv", "bin", "hermes"),
    join5(home, ".local", "bin", "hermes")
  ];
  for (const c of candidates) {
    if (existsSync4(c)) return c;
  }
  return candidates[0];
}
function renderHostConfig() {
  const home = homedir3();
  const hermesBin = detectHermesBin(home);
  const hermesRepo = join5(home, "code", "hermes-agent");
  const scaffoldDir = join5(home, "code", "hermes-agent-template", "runtime-scaffold");
  const skillsDir = join5(home, ".agents", "skills");
  const pmExternalSkillGlobalDir = join5(home, "code", "skillex", "skill-sets", "global", ".system");
  const pmExternalSkillBmadDir = join5(home, "code", "skillex", "packs", "bmad", BMAD_PACK_VERSION);
  return `# hermes-agent-template \u2014 host configuration
# Bootstrapped by \`pjangler config bootstrap\` for $HOME=${home} (platform=${platform()}).
#
# [fleet] paths below were derived from THIS machine. The identity values in
# [github]/[plane]/[bloodbank] are intentionally left to be confirmed before a
# CLOUD provision (\`pjangler hermes\` without --local); they are unused by the
# default local-only provision.
#
# Resolution precedence per value: env var > ~/.hermes/fleet.env > this file > fallback.

[fleet]
home = "~/.hermes"
hermes_bin = "${hermesBin}"
hermes_repo = "${hermesRepo}"
runtime_scaffold_dir = "${scaffoldDir}"
# Shared fleet source-of-truth env file + fleet registry. ~ is expanded.
fleet_env = "~/.hermes/fleet.env"
registry_file = "~/.hermes/agents-registry.yaml"
canonical_skills_dir = "${skillsDir}"
pm_external_skill_dirs = [
  "${pmExternalSkillGlobalDir}",
  "${pmExternalSkillBmadDir}",
]
symlinked_runtime_skills = []

[github]
# Owner of the per-agent runtime repos (creates <owner>/agent-hm-<repo>-<role>).
# REQUIRED before a cloud provision. Leave empty for local-only runs.
runtime_repo_owner = ""

[plane]
# Plane instance + workspace (one project per agent). Confirm before cloud provision.
base = "https://plane.delo.sh"
workspace = "33god"

[bloodbank]
# NATS endpoint the consumer connects to. For a remote fleet node, point this at
# the bloodbank host over Tailscale rather than localhost.
nats_host = "127.0.0.1"
nats_port = 4222
compose_dir = "~/code/33GOD/bloodbank"
`;
}
var EnsureTemplateConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.deferredExternalEffects && !ctx.applyingDeferredHostEffects) {
      return {
        success: true,
        outcome: "unchanged",
        message: "Hermes host config deferred until rendered lifecycle eligibility passes"
      };
    }
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync4(path);
    if (exists && !force) {
      if (!ctx.quiet) console.log(`\u2713 Config present: ${path}`);
      return { success: true, outcome: "unchanged", message: "" };
    }
    if (ctx.dryRun) {
      if (!ctx.quiet) console.log(`[DRY RUN] Would ${exists ? "overwrite" : "create"} config: ${path}`);
      return { success: true, outcome: "planned", filePath: path, message: "" };
    }
    try {
      mkdirSync3(dirname4(path), { recursive: true });
      writeFileSync3(path, renderHostConfig());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, outcome: "failed", message: `Failed to write ${path}: ${msg}` };
    }
    if (!ctx.quiet) {
      console.log(`\u2713 Bootstrapped config: ${path}`);
      console.log("  Review [github].runtime_repo_owner + [plane] + [bloodbank] before a cloud provision.");
    }
    return { success: true, outcome: "changed", filePath: path, message: "" };
  }
};

// src/commands/hermes/PromptForAgentConfig.ts
import { basename as basename3, join as join6 } from "node:path";
import { readFileSync as readFileSync3 } from "node:fs";
import * as p from "@clack/prompts";

// src/commands/hermes/types.ts
var HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";
function deriveAgentId(repo, role) {
  return `${repo}-${role}`.toLowerCase();
}
function deriveProfileName(repo, role) {
  return deriveAgentId(repo, role);
}

// src/commands/hermes/PromptForAgentConfig.ts
function detectTicketProvider(targetDir) {
  try {
    const t = JSON.parse(readFileSync3(join6(targetDir, ".project.json"), "utf8"))?.ticket_provider?.type;
    return t === "plane" || t === "trello" ? t : void 0;
  } catch {
    return void 0;
  }
}
var PromptForAgentConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    const defaultRepo = basename3(ctx.targetDir).toLowerCase();
    ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
    ctx.role ??= "pm";
    ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
    ctx.soulTone ??= "direct";
    ctx.modelProvider ??= "";
    ctx.modelName ??= "";
    ctx.modelBaseUrl ??= "";
    ctx.modelApiMode ??= "";
    ctx.modelKeyEnv ??= "";
    ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
    ctx.skipEmail ??= true;
    ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
    ctx.profileName = deriveProfileName(ctx.targetRepo, ctx.role);
    if (ctx.quiet && !ctx.yes) {
      return {
        success: false,
        outcome: "failed",
        message: "Quiet Hermes execution must also set yes=true; interactive prompts are unavailable to structured callers"
      };
    }
    if (ctx.yes) {
      ctx.skipTelegram ??= true;
      return {
        success: true,
        message: this.formatMessage(
          `\u2713 Non-interactive mode \u2014 using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        )
      };
    }
    p.intro("\u2695  hermes-agent  \xB7  provision the PM agent for this repo");
    p.log.info(
      `agent ${ctx.agentId}   \xB7   board ${ctx.ticketProvider}   \xB7   tone ${ctx.soulTone}`
    );
    if (ctx.skipTelegram === void 0) {
      const botHandle = `${ctx.targetRepo.replace(/-/g, "_")}_${ctx.role}_bot`;
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${botHandle}) now?`,
        initialValue: true
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }
    return {
      success: true,
      message: this.formatMessage(
        `\u2713 Collected agent config  (agent_id=${ctx.agentId}, profile=${ctx.profileName})`
      )
    };
  }
  cancelled() {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
};

// src/commands/hermes/RunCopierTemplate.ts
import { homedir as homedir5 } from "node:os";
import { join as join10, dirname as dirname7, relative as relative6 } from "node:path";
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import * as p2 from "@clack/prompts";
import YAML4 from "yaml";

// src/project/index.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync7, mkdirSync as mkdirSync4, mkdtempSync as mkdtempSync2, readFileSync as readFileSync6, realpathSync as realpathSync3, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir4, tmpdir as tmpdir2 } from "node:os";
import { basename as basename5, delimiter as delimiter2, dirname as dirname6, isAbsolute as isAbsolute2, join as join9, relative as relative5, resolve as resolve6, sep as sep2, win32 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import YAML3 from "yaml";

// src/utils/tree-diff.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync5, lstatSync as lstatSync3, readFileSync as readFileSync4, readdirSync as readdirSync3, readlinkSync as readlinkSync2 } from "node:fs";
import { join as join7, relative as relative3 } from "node:path";
function snapshotTree(root, current = root, snapshot = /* @__PURE__ */ new Map()) {
  if (!existsSync5(current)) return snapshot;
  const rel = relative3(root, current) || ".";
  if (rel === ".git" || rel.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) return snapshot;
  const stat = lstatSync3(current);
  if (stat.isSymbolicLink()) {
    snapshot.set(rel, `link:${readlinkSync2(current)}`);
  } else if (stat.isFile()) {
    snapshot.set(rel, `file:${createHash3("sha256").update(readFileSync4(current)).digest("hex")}:${stat.mode & 511}`);
  } else if (stat.isDirectory()) {
    snapshot.set(rel, `dir:${stat.mode & 511}`);
    for (const name of readdirSync3(current)) snapshotTree(root, join7(current, name), snapshot);
  } else {
    snapshot.set(rel, `other:${stat.mode}`);
  }
  return snapshot;
}
function changedTreePaths(root, before, after) {
  return [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].filter((path) => path !== "." && before.get(path) !== after.get(path)).map((path) => join7(root, path)).sort();
}

// src/lifecycle/preflight.ts
import { createHash as createHash4 } from "node:crypto";
import {
  accessSync,
  constants as constants2,
  existsSync as existsSync6,
  lstatSync as lstatSync4,
  readFileSync as readFileSync5,
  readdirSync as readdirSync4,
  realpathSync as realpathSync2,
  statSync
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename as basename4, delimiter, isAbsolute, join as join8, relative as relative4, resolve as resolve5 } from "node:path";
import YAML2 from "yaml";
function containedBy(parent, candidate) {
  const rel = relative4(resolve5(parent), resolve5(candidate));
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function firstExecutableOnPath(env2) {
  for (const rawEntry of (env2.PATH ?? "").split(delimiter)) {
    const entry = rawEntry || process.cwd();
    const candidate = resolve5(entry, process.platform === "win32" ? "copier.exe" : "copier");
    try {
      accessSync(candidate, constants2.X_OK);
      const stat = lstatSync4(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
    }
  }
  return void 0;
}
function sha2562(path) {
  return createHash4("sha256").update(readFileSync5(path)).digest("base64url");
}
function fingerprint(path) {
  const absolute = resolve5(path);
  const realPath = realpathSync2(absolute);
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  return {
    path: absolute,
    realPath,
    sha256: sha2562(realPath),
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid
  };
}
function sameFingerprint(expected) {
  try {
    const actual = fingerprint(expected.path);
    for (const key of ["realPath", "sha256", "size", "device", "inode", "mode", "uid", "gid"]) {
      if (actual[key] !== expected[key]) {
        return { ok: false, error: `trusted Copier identity changed at ${expected.path} (${key})` };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `trusted Copier identity is unavailable at ${expected.path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function consoleScriptContract(path) {
  let text2;
  try {
    text2 = readFileSync5(path, "utf8").slice(0, 32 * 1024);
  } catch (error) {
    return { ok: false, error: `cannot read Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
  const firstLine = text2.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return { ok: false, error: "Copier launcher has no executable shebang" };
  const shebang = firstLine.slice(2).trim().split(/\s+/);
  if (shebang.length !== 1 || !isAbsolute(shebang[0] ?? "")) {
    return { ok: false, error: "Copier launcher must use one absolute Python interpreter" };
  }
  const interpreterPath = resolve5(shebang[0]);
  const interpreter = basename4(interpreterPath);
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
    return { ok: false, error: "Copier launcher is not an absolute Python console script" };
  }
  if (!/from\s+copier\.__main__\s+import\s+CopierApp/.test(text2) || !/CopierApp\.run\s*\(/.test(text2)) {
    return { ok: false, error: "Copier launcher does not match the Copier 9 console-script contract" };
  }
  return { ok: true, interpreter: interpreterPath };
}
function defaultUvToolRoots(home) {
  return [
    join8(home, ".local", "share", "uv", "tools", "copier"),
    join8(home, "Library", "Application Support", "uv", "tools", "copier")
  ].map((path) => resolve5(path));
}
function locateUvSitePackages(toolRoot) {
  const lib = join8(toolRoot, "lib");
  const candidates = [];
  for (const entry of readdirSync4(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^python\d+(?:\.\d+)*$/.test(entry.name)) continue;
    const sitePackages = join8(lib, entry.name, "site-packages");
    if (existsSync6(sitePackages)) candidates.push(sitePackages);
  }
  if (candidates.length !== 1) throw new Error(`expected one UV Copier site-packages directory, found ${candidates.length}`);
  return realpathSync2(candidates[0]);
}
function parseRecordLine(line) {
  if (!line || line.includes('"')) return void 0;
  const parts = line.split(",");
  if (parts.length !== 3 || !parts[1]?.startsWith("sha256=") || !/^\d+$/.test(parts[2] ?? "")) return void 0;
  return {
    relativePath: parts[0],
    digest: parts[1].slice("sha256=".length),
    size: Number(parts[2])
  };
}
function attestUvCopier(candidate, realCandidate, home) {
  const toolRoot = defaultUvToolRoots(home).find((root) => realCandidate === join8(root, "bin", "copier"));
  if (!toolRoot) {
    return { ok: false, error: `refusing untrusted PATH-shadowed Copier executable: ${candidate}` };
  }
  const supportedEntries = new Set([
    join8(home, ".local", "bin", "copier"),
    join8(toolRoot, "bin", "copier")
  ].map((path) => resolve5(path)));
  if (!supportedEntries.has(resolve5(candidate))) {
    return { ok: false, error: `refusing non-canonical UV Copier entry point: ${candidate}` };
  }
  try {
    const launcher = consoleScriptContract(realCandidate);
    if (!launcher.ok || !launcher.interpreter) {
      return { ...launcher, executable: realCandidate, realExecutable: realCandidate };
    }
    const expectedInterpreter = join8(toolRoot, "bin", basename4(launcher.interpreter));
    if (resolve5(launcher.interpreter) !== resolve5(expectedInterpreter)) {
      return { ok: false, error: "UV Copier launcher interpreter is outside the attested tool environment" };
    }
    const interpreterReal = realpathSync2(launcher.interpreter);
    const uvPythonRoots = [
      join8(home, ".local", "share", "uv", "python"),
      join8(home, "Library", "Application Support", "uv", "python")
    ];
    if (!uvPythonRoots.some((root) => containedBy(root, interpreterReal))) {
      return { ok: false, error: "UV Copier interpreter is not managed by the canonical UV Python installation" };
    }
    const receiptPath = join8(toolRoot, "uv-receipt.toml");
    const receipt = readFileSync5(receiptPath, "utf8");
    if (!/requirements\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["']/.test(receipt) || !/entrypoints\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["'][\s\S]*?from\s*=\s*["']copier["']/.test(receipt)) {
      return { ok: false, error: "UV tool receipt does not bind the copier entry point to the Copier package" };
    }
    const sitePackages = locateUvSitePackages(toolRoot);
    const distInfos = readdirSync4(sitePackages, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^copier-[^-]+\.dist-info$/i.test(entry.name)).map((entry) => join8(sitePackages, entry.name));
    if (distInfos.length !== 1) {
      return { ok: false, error: `expected one installed Copier distribution, found ${distInfos.length}` };
    }
    const distInfo = realpathSync2(distInfos[0]);
    const metadataPath = join8(distInfo, "METADATA");
    const entryPointsPath = join8(distInfo, "entry_points.txt");
    const recordPath = join8(distInfo, "RECORD");
    const metadata = readFileSync5(metadataPath, "utf8");
    const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (name?.toLowerCase() !== "copier" || !version || !/^9(?:\.|$)/.test(version)) {
      return { ok: false, error: "installed distribution is not a Copier 9 package" };
    }
    const entryPoints = readFileSync5(entryPointsPath, "utf8");
    if (!/^copier\s*=\s*copier\.__main__:CopierApp\.run\s*$/m.test(entryPoints)) {
      return { ok: false, error: "installed Copier distribution has an unexpected console entry point" };
    }
    const recordEntries = readFileSync5(recordPath, "utf8").split(/\r?\n/).map(parseRecordLine).filter((entry) => Boolean(entry));
    const selected = recordEntries.filter((entry) => {
      const normalized = entry.relativePath.replaceAll("\\", "/");
      return normalized.startsWith("copier/") || normalized === `${basename4(distInfo)}/METADATA` || normalized === `${basename4(distInfo)}/entry_points.txt` || normalized === "../../../bin/copier";
    });
    if (!selected.some((entry) => entry.relativePath === "../../../bin/copier") || !selected.some((entry) => entry.relativePath.replaceAll("\\", "/") === "copier/__main__.py")) {
      return { ok: false, error: "Copier RECORD does not bind its launcher and package entry point" };
    }
    const attestedFiles = /* @__PURE__ */ new Map();
    for (const entry of selected) {
      const path = resolve5(sitePackages, entry.relativePath);
      const allowed = path === realCandidate || containedBy(sitePackages, path);
      if (!allowed) return { ok: false, error: `Copier RECORD path escapes the tool environment: ${entry.relativePath}` };
      const actualDigest = sha2562(path);
      const actualSize = statSync(path).size;
      if (actualDigest !== entry.digest || actualSize !== entry.size) {
        return { ok: false, error: `Copier RECORD integrity mismatch: ${entry.relativePath}` };
      }
      attestedFiles.set(resolve5(path), fingerprint(path));
    }
    for (const path of [realCandidate, join8(toolRoot, "pyvenv.cfg"), receiptPath, metadataPath, entryPointsPath, recordPath]) {
      attestedFiles.set(resolve5(path), fingerprint(path));
    }
    const identity = {
      executable: realCandidate,
      resolvedFrom: resolve5(candidate),
      layout: "uv-tool",
      version,
      toolRoot,
      interpreter: fingerprint(launcher.interpreter),
      files: [...attestedFiles.values()].sort((left, right) => left.path.localeCompare(right.path))
    };
    return {
      ok: true,
      executable: identity.executable,
      realExecutable: identity.executable,
      layout: identity.layout,
      identity
    };
  } catch (error) {
    return { ok: false, error: `cannot attest UV Copier installation: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function verifyTrustedCopierIdentity(identity) {
  if (!isAbsolute(identity.executable) || resolve5(identity.executable) !== resolve5(identity.files.find((file) => file.path === identity.executable)?.path ?? "")) {
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
function preflightTrustedCopier(options) {
  const env2 = options.env ?? process.env;
  const home = resolve5(options.homeDir ?? userInfo().homedir);
  const temporary = resolve5(options.temporaryDir ?? tmpdir());
  const target = resolve5(options.targetDir);
  const candidate = firstExecutableOnPath(env2);
  if (!candidate) return { ok: false, error: "copier not found on PATH" };
  let realCandidate;
  try {
    realCandidate = realpathSync2(candidate);
  } catch (error) {
    return { ok: false, error: `cannot resolve Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
  for (const [label, root] of [["target", target], ["temporary", temporary]]) {
    if (containedBy(root, candidate) || containedBy(root, realCandidate)) {
      return { ok: false, error: `refusing ${label}-local Copier executable: ${candidate}` };
    }
  }
  return attestUvCopier(candidate, realCandidate, home);
}
function regularContainedFile(root, path, label) {
  try {
    const rootReal = realpathSync2(root);
    const fileReal = realpathSync2(path);
    if (!containedBy(rootReal, fileReal)) return { ok: false, error: `${label} escapes its vendored template root` };
    if (!lstatSync4(path).isFile()) return { ok: false, error: `${label} is not a regular file` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function parseCopierConfig(templateRoot, label) {
  const configPath = join8(templateRoot, "copier.yml");
  const file = regularContainedFile(templateRoot, configPath, `${label} copier.yml`);
  if (!file.ok) return { result: file };
  try {
    const parsed = YAML2.parse(readFileSync5(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: { ok: false, error: `${label} copier.yml must contain a mapping` } };
    }
    const config = parsed;
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
function requireFiles(templateRoot, files, label) {
  for (const rel of files) {
    const result = regularContainedFile(templateRoot, join8(templateRoot, rel), `${label} ${rel}`);
    if (!result.ok) return result;
  }
  return { ok: true };
}
function preflightCommonProjectTemplate(pjanglerRoot) {
  const templateRoot = join8(resolve5(pjanglerRoot), "templates", "commonproject");
  const parsed = parseCopierConfig(templateRoot, "CommonProject template");
  if (!parsed.result.ok) return parsed.result;
  const files = requireFiles(templateRoot, [
    "template/.project.json.jinja",
    "template/.copier-answers.yml.jinja",
    "template/.env.op",
    "template/AGENTS.md.jinja",
    "template/mise.toml.jinja"
  ], "CommonProject template");
  if (!files.ok) return files;
  const projectJson = readFileSync5(join8(templateRoot, "template", ".project.json.jinja"), "utf8");
  for (const key of ["project_name", "project_slug", "repo_path", "ticket_provider", "agents"]) {
    if (!projectJson.includes(`"${key}"`)) return { ok: false, error: `CommonProject projection is missing ${key}` };
  }
  return { ok: true };
}
function preflightHermesTemplate(pjanglerRoot, env2 = process.env) {
  const templateRoot = join8(resolve5(pjanglerRoot), "templates", "hermes-agent");
  const explicit = env2.PJANGLER_HERMES_TEMPLATE?.trim();
  if (explicit) {
    try {
      if (realpathSync2(resolve5(explicit)) !== realpathSync2(templateRoot)) {
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
    "template/.scripts/lib/parse-fleet-env.py",
    "template/.scripts/01-config.sh",
    "template/.scripts/05-fleet-env.sh",
    "template/.scripts/10-hermes-profile.sh",
    "template/.scripts/20-runtime-repo.sh",
    "template/.scripts/42-ticket-provider.sh",
    "template/.scripts/70-systemd.sh",
    "template/.scripts/80-registry.sh"
  ], "Hermes template");
  if (!required.ok) return required;
  const role = readFileSync5(join8(templateRoot, "template", "role.yaml.jinja"), "utf8");
  if (!/^bloodbank:\s*$[\s\S]*?^\s+enabled:\s+(?:true|false)\s*$/m.test(role)) {
    return { ok: false, error: "Hermes role projection must declare bloodbank.enabled as a strict boolean" };
  }
  const library = readFileSync5(join8(templateRoot, "template", ".scripts", "_lib.sh"), "utf8");
  if (!library.includes("PJANGLER_PROJECT_ROOT") || !library.includes('"$explicit"/agents/hermes/*')) {
    return { ok: false, error: "Hermes project-root resolver must honor the explicitly contained MCP target" };
  }
  const skipPlane = readFileSync5(join8(templateRoot, "template", ".scripts", "42-ticket-provider.sh"), "utf8");
  const guard = skipPlane.indexOf('if [[ "${SKIP_PLANE:-0}" == "1" ]]');
  const firstSource = skipPlane.search(/^source\s/m);
  if (guard < 0 || firstSource < 0 || guard > firstSource) {
    return { ok: false, error: "Hermes ticket-provider skip guard must precede all sourced provider/config logic" };
  }
  for (const script of ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "80-registry.sh"]) {
    const text2 = readFileSync5(join8(templateRoot, "template", ".scripts", script), "utf8");
    const hostGuard = text2.indexOf('if [[ "${SKIP_HOST_STATE:-0}" == "1" ]]');
    const source = text2.search(/^source\s/m);
    if (hostGuard < 0 || source < 0 || hostGuard > source) {
      return { ok: false, error: `Hermes ${script} host-state guard must precede all sourced config/fleet logic` };
    }
  }
  const tasks = Array.isArray(parsed.config?._tasks) ? parsed.config._tasks.map(String) : [];
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    if (!tasks.some((task) => task.includes(script))) return { ok: false, error: `Hermes copier task list is missing ${script}` };
  }
  return { ok: true };
}
function preflightRenderedHermes(options) {
  const target = resolve5(options.targetDir);
  const roleDir = resolve5(options.roleDir);
  if (!containedBy(target, roleDir)) return { ok: false, error: "rendered Hermes role escapes its project target" };
  try {
    const stat = lstatSync4(roleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "rendered Hermes role must be a real directory" };
    }
  } catch (error) {
    return { ok: false, error: `rendered Hermes role is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const templateScripts = join8(resolve5(options.pjanglerRoot), "templates", "hermes-agent", "template", ".scripts");
  const renderedScripts = join8(roleDir, ".scripts");
  const requiredFiles = [
    "role.yaml",
    "SOUL.md",
    "hermes",
    ".gitignore",
    ".runtime-scaffold/README.md",
    ".scripts/lib/parse-fleet-env.py",
    ...["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"].map((script) => `.scripts/${script}`)
  ];
  const required = requireFiles(roleDir, requiredFiles, "rendered Hermes role");
  if (!required.ok) return required;
  for (const script of ["_lib.sh", "lib/parse-fleet-env.py", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    try {
      if (readFileSync5(join8(renderedScripts, script), "utf8") !== readFileSync5(join8(templateScripts, script), "utf8")) {
        return { ok: false, error: `rendered Hermes script differs from the attested template: ${script}` };
      }
    } catch (error) {
      return { ok: false, error: `cannot attest rendered Hermes script ${script}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  let role;
  try {
    const parsed = YAML2.parse(readFileSync5(join8(roleDir, "role.yaml"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "rendered Hermes role.yaml must contain a mapping" };
    }
    role = parsed;
  } catch (error) {
    return { ok: false, error: `rendered Hermes role.yaml is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.repo !== options.targetRepo || role.role !== options.role || role.agent_id !== options.agentId) {
    return { ok: false, error: "rendered Hermes role identity does not match the requested repo/role/agent" };
  }
  const bloodbank = role.bloodbank;
  if (!bloodbank || typeof bloodbank.enabled !== "boolean") {
    return { ok: false, error: "rendered Hermes bloodbank.enabled must be a strict boolean" };
  }
  const deployment = role.deployment;
  if (!deployment || deployment.local_only !== true || deployment.systemd !== "deferred") {
    return { ok: false, error: "rendered Hermes deployment must remain local-only/deferred until external grants run" };
  }
  const manifestPath = join8(target, ".project.json");
  if (existsSync6(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync5(manifestPath, "utf8"));
      const agents = manifest.agents;
      const declared = agents?.[options.agentId];
      if (!declared || declared.role !== options.role || declared.role_dir !== relative4(target, roleDir) || declared.provisioning_state !== "provisioned") {
        return { ok: false, error: "rendered Hermes role is not canonically registered in .project.json" };
      }
    } catch (error) {
      return { ok: false, error: `cannot validate rendered Hermes project registration: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}
function preflightMcpLifecycle(options) {
  const copier = preflightTrustedCopier({ targetDir: options.targetDir, env: options.env });
  if (!copier.ok) return copier;
  if (options.commonProject) {
    const common = preflightCommonProjectTemplate(options.pjanglerRoot);
    if (!common.ok) return { ...common, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  if (options.hermes) {
    const hermes = preflightHermesTemplate(options.pjanglerRoot, options.env);
    if (!hermes.ok) return { ...hermes, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  return copier;
}

// src/project/RegistryStore.ts
import { Pool } from "pg";
function pgRegistryConfigFromEnv(env2 = process.env) {
  return {
    host: env2.PGHOST || "localhost",
    port: parseInt(env2.PGPORT || "5432", 10),
    user: env2.PGUSER || "delorenj",
    password: env2.PGPASSWORD || "",
    database: env2.PGDATABASE || "33god"
  };
}
var PgRegistryStore = class {
  pool;
  constructor(config) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database
    });
  }
  async load() {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT p.id, p.name, p.description, p.slug, p.status,
                p.source_artifacts, p.template, p.automation,
                p.created_at, p.updated_at,
                r.id AS repo_id, r.local_path
         FROM public.projects p
         LEFT JOIN public.repos r ON r.project_id = p.id
         WHERE p.slug IS NOT NULL`
      );
      const projects = createSafeRecord();
      for (const row of rows) {
        const slug = row.slug;
        const ticketProvider = await this.loadTicketProvider(client, row.id);
        const agents = await this.loadAgents(client, row.id, slug);
        projects[slug] = {
          name: row.name ?? "",
          slug,
          repo_path: row.local_path ?? "",
          description: row.description ?? "",
          // Read-time fallback for legacy rows whose status column is NULL.
          // Deliberately NOT the new-project default (PJAN-26 = "active"):
          // load() feeds save()/upsert(), so flipping this would retroactively
          // rewrite every pre-existing NULL-status row to "active" on the next
          // write. New records get their status from planProjectInit().
          status: row.status ?? "planned",
          source_artifacts: row.source_artifacts ?? [],
          template: row.template ?? {
            commonproject: { enabled: false, primary_language: "python" }
          },
          ticket_provider: ticketProvider,
          agents,
          automation: row.automation ?? void 0,
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at.toISOString()
        };
      }
      const registry = {
        schema_version: PROJECT_REGISTRY_SCHEMA_VERSION,
        projects
      };
      validateProjectRegistry(registry);
      return registry;
    } finally {
      client.release();
    }
  }
  async save(registry) {
    validateProjectRegistry(registry);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [slug, record] of Object.entries(registry.projects)) {
        await this.upsertInTx(client, slug, record);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async upsert(slug, record) {
    validateProjectRegistry({
      schema_version: PROJECT_REGISTRY_SCHEMA_VERSION,
      projects: createSafeRecord([[slug, record]])
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.upsertInTx(client, slug, record);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async getBySlug(slug) {
    const registry = await this.load();
    return getOwnRecordValue(registry.projects, slug);
  }
  async getByRepoPath(repoPath) {
    const registry = await this.load();
    return Object.values(registry.projects).find(
      (p6) => p6.repo_path === repoPath
    );
  }
  async close() {
    await this.pool.end();
  }
  // --- private helpers ---
  async upsertInTx(client, slug, record) {
    if (!slug) throw new Error("PgRegistryStore.upsert: slug is required");
    const projectResult = await client.query(
      `INSERT INTO public.projects (name, description, slug, status, source_artifacts, template, automation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) WHERE slug IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         source_artifacts = EXCLUDED.source_artifacts,
         template = EXCLUDED.template,
         automation = EXCLUDED.automation
       RETURNING id`,
      [
        record.name,
        record.description,
        slug,
        record.status,
        JSON.stringify(record.source_artifacts),
        JSON.stringify(record.template),
        record.automation ? JSON.stringify(record.automation) : null
      ]
    );
    const projectId = projectResult.rows[0]?.id;
    if (!projectId) throw new Error(`Failed to upsert project: ${slug}`);
    await client.query(
      `INSERT INTO public.repos (project_id, local_path)
       VALUES ($1, $2)
       ON CONFLICT (local_path)
       DO UPDATE SET project_id = EXCLUDED.project_id
       RETURNING id`,
      [projectId, record.repo_path]
    );
    const repoResult = await client.query(
      `SELECT id FROM public.repos WHERE project_id = $1 AND local_path = $2`,
      [projectId, record.repo_path]
    );
    const repoId = repoResult.rows[0]?.id;
    if (!repoId) throw new Error(`Failed to find repo for project ${slug} at path ${record.repo_path}`);
    await this.upsertTicketProvider(client, projectId, repoId, record.ticket_provider);
    await client.query(
      `DELETE FROM public.project_agents WHERE project_id = $1`,
      [projectId]
    );
    for (const [agentKey, agent] of Object.entries(record.agents)) {
      await client.query(
        `INSERT INTO public.project_agents (repo_id, project_id, agent_key, role, role_dir, provisioning_state)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [repoId, projectId, agentKey, agent.role, agent.role_dir ?? null, agent.provisioning_state]
      );
    }
  }
  async loadTicketProvider(client, projectId) {
    const { rows } = await client.query(
      `SELECT provider_type, workspace, identifier, board_id, state
       FROM public.project_ticket_boards
       WHERE project_id = $1
       LIMIT 1`,
      [projectId]
    );
    if (!rows.length) {
      return { type: "plane", workspace: "33god", identifier: "", board_id: "", state: "planned" };
    }
    const row = rows[0];
    return {
      type: row.provider_type,
      workspace: row.workspace ?? void 0,
      identifier: row.identifier ?? void 0,
      board_id: row.board_id ?? void 0,
      state: row.state ?? void 0
    };
  }
  async loadAgents(client, projectId, slug) {
    const { rows } = await client.query(
      `SELECT agent_key, role, role_dir, provisioning_state
       FROM public.project_agents
       WHERE project_id = $1`,
      [projectId]
    );
    const agents = createSafeRecord();
    for (const row of rows) {
      agents[row.agent_key] = {
        role: row.role,
        provisioning_state: row.provisioning_state,
        role_dir: row.role_dir ?? void 0
      };
    }
    return agents;
  }
  async upsertTicketProvider(client, projectId, repoId, tp) {
    await client.query(
      `DELETE FROM public.project_ticket_boards WHERE project_id = $1`,
      [projectId]
    );
    await client.query(
      `INSERT INTO public.project_ticket_boards
         (repo_id, project_id, provider_type, workspace, identifier, board_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        repoId,
        projectId,
        tp.type,
        tp.workspace ?? null,
        tp.identifier ?? null,
        tp.board_id ?? null,
        tp.state ?? null
      ]
    );
  }
};
var PJ_REGISTRY_PG_ENV = "PJ_REGISTRY_PG";
function isPgRegistryEnabled(env2 = process.env) {
  return env2[PJ_REGISTRY_PG_ENV] === "1" || env2[PJ_REGISTRY_PG_ENV] === "true";
}

// src/project/index.ts
var PROJECT_REGISTRY_ENV = "PJ_PROJECT_REGISTRY";
var PROJECT_SOURCE_SKILL_ROOTS_ENV = "PJ_SOURCE_SKILL_ROOTS";
var TICKET_PROVIDER_ADAPTERS_ENV = "PJ_TICKET_PROVIDER_ADAPTERS";
var PROJECT_REGISTRY_SCHEMA_VERSION = 1;
var DEFAULT_NEW_PROJECT_STATUS = "active";
var BOARD_URL_DEPRECATION_WARNING = "boardUrl is deprecated and ignored; board URLs are derived at runtime and are never persisted.";
function synchronizeCopierIdentity(manifestPath, manifest) {
  const answersPath = join9(dirname6(manifestPath), ".copier-answers.yml");
  if (!existsSync7(answersPath)) return [];
  const current = readFileSync6(answersPath, "utf8");
  const document = YAML3.parseDocument(current);
  if (document.errors.length) return [];
  const name = String(document.get("project_name") ?? "");
  const description = String(document.get("project_description") ?? "");
  if (name === manifest.project_name && description === manifest.project_description) return [];
  document.set("project_name", manifest.project_name);
  document.set("project_description", manifest.project_description);
  const next = String(document);
  if (next === current) return [];
  writeFileSync4(answersPath, next, "utf8");
  return [answersPath];
}
var DEFAULT_SOURCE_SKILL_ROOTS = [
  "/home/delorenj/code/skillex/all-skills",
  join9(homedir4(), ".agents", "skills"),
  join9(homedir4(), ".codex", "skills")
];
function projectRegistryPath(env2 = process.env) {
  return expandHome(env2[PROJECT_REGISTRY_ENV] || join9(homedir4(), ".config", "pjangler", "projects.yaml"));
}
function createSafeRecord(entries = []) {
  const record = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of entries) record[key] = value;
  return record;
}
function getOwnRecordValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : void 0;
}
function emptyProjectRegistry() {
  return { schema_version: PROJECT_REGISTRY_SCHEMA_VERSION, projects: createSafeRecord() };
}
function loadProjectRegistry(path = projectRegistryPath()) {
  if (!existsSync7(path)) return emptyProjectRegistry();
  const raw = YAML3.parse(readFileSync6(path, "utf8"));
  if (raw == null) return emptyProjectRegistry();
  if (!isRecord(raw)) throw new Error(`Project registry must be a mapping: ${path}`);
  const registry = raw;
  const projects = createSafeRecord();
  if (isRecord(registry.projects)) {
    for (const [slug, rawProject] of Object.entries(registry.projects)) {
      if (!isRecord(rawProject)) {
        projects[slug] = rawProject;
        continue;
      }
      projects[slug] = {
        ...rawProject,
        agents: isRecord(rawProject.agents) ? createSafeRecord(Object.entries(rawProject.agents)) : rawProject.agents
      };
    }
  }
  const normalized = {
    schema_version: Number(registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION),
    projects
  };
  validateProjectRegistry(normalized);
  return normalized;
}
function saveProjectRegistry(registry, path = projectRegistryPath()) {
  validateProjectRegistry(registry);
  mkdirSync4(dirname6(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync4(temp, YAML3.stringify(registry, { lineWidth: 0 }), "utf8");
  renameSync2(temp, path);
}
function validateProjectRegistry(registry) {
  if (registry.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project registry schema_version: ${registry.schema_version}`);
  }
  if (!isRecord(registry.projects)) throw new Error("Project registry projects must be a mapping");
  const slugs = /* @__PURE__ */ new Set();
  const repoPaths = /* @__PURE__ */ new Map();
  const identifiers = /* @__PURE__ */ new Map();
  for (const [slug, project] of Object.entries(registry.projects)) {
    validateProjectRecord(project, slug);
    if (slugs.has(project.slug)) throw new Error(`Duplicate project slug: ${project.slug}`);
    slugs.add(project.slug);
    const repoKey = resolve6(project.repo_path);
    const existingRepoSlug = repoPaths.get(repoKey);
    if (existingRepoSlug && existingRepoSlug !== slug) {
      throw new Error(`Duplicate project repo_path: ${project.repo_path} used by ${existingRepoSlug} and ${slug}`);
    }
    repoPaths.set(repoKey, slug);
    const identifier = project.ticket_provider.identifier?.toUpperCase();
    if (identifier) {
      const existingIdentifierSlug = identifiers.get(identifier);
      if (existingIdentifierSlug && existingIdentifierSlug !== slug) {
        throw new Error(`Duplicate project identifier: ${identifier} used by ${existingIdentifierSlug} and ${slug}`);
      }
      identifiers.set(identifier, slug);
    }
  }
}
function normalizeTicketProvider(value) {
  const type = (value || "plane").trim().toLowerCase();
  if (type === "plane" || type === "trello") return type;
  throw new Error(`Unsupported ticket provider: ${value}. Supported providers: plane, trello`);
}
function buildTicketProviderBlock(input) {
  const type = normalizeTicketProvider(input.type);
  const boardId = input.boardId ?? "";
  if (type === "trello") {
    return {
      type,
      workspace: input.workspace ?? "",
      identifier: input.identifier,
      board_id: boardId,
      state: boardId ? "linked" : "planned"
    };
  }
  const workspace = input.workspace ?? "33god";
  return {
    type,
    workspace,
    identifier: input.identifier,
    board_id: boardId,
    state: boardId ? "linked" : "planned"
  };
}
function ticketProviderKeyVar(provider) {
  return provider === "trello" ? "TRELLO_KEY" : "PLANE_API_KEY";
}
function ticketProviderKeyVars(provider) {
  return provider === "trello" ? ["TRELLO_KEY", "TRELLO_TOKEN"] : ["PLANE_API_KEY"];
}
function ticketProviderSecretsPath(env2 = process.env) {
  const base = env2.XDG_CONFIG_HOME || join9(env2.HOME || homedir4(), ".config");
  return join9(base, "zshyzsh", "secrets.zsh");
}
function readShellAssignments(path, keys) {
  const found = {};
  if (!existsSync7(path)) return found;
  let text2;
  try {
    text2 = readFileSync6(path, "utf8");
  } catch {
    return found;
  }
  const wanted = new Set(keys);
  for (const rawLine of text2.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!wanted.has(key) || found[key] !== void 0) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    if (value) found[key] = value;
  }
  return found;
}
function resolveTicketProviderCredentials(input) {
  const env2 = input.env ?? process.env;
  const values = {};
  const sources = {};
  const missing = () => input.keys.filter((key) => !values[key]);
  for (const key of input.keys) {
    const fromEnv = env2[key];
    if (fromEnv) {
      values[key] = fromEnv;
      sources[key] = "environment";
    }
  }
  const candidates = [];
  if (input.repoPath) candidates.push({ path: join9(input.repoPath, ".env"), label: join9(input.repoPath, ".env") });
  const secrets = ticketProviderSecretsPath(env2);
  candidates.push({ path: secrets, label: secrets });
  for (const candidate of candidates) {
    const outstanding = missing();
    if (!outstanding.length) break;
    const assignments = readShellAssignments(candidate.path, outstanding);
    for (const [key, value] of Object.entries(assignments)) {
      values[key] = value;
      sources[key] = candidate.label;
    }
  }
  return { values, sources };
}
function resolveTicketProviderAdapter(provider, env2 = process.env) {
  const file = `${provider}.sh`;
  const candidates = [];
  const override = env2[TICKET_PROVIDER_ADAPTERS_ENV];
  if (override) candidates.push(join9(override, file));
  const relativeRoots = [
    join9("templates", "hermes-agent", "template", ".scripts", "providers"),
    join9("agents", "hermes", "pm", ".scripts", "providers")
  ];
  try {
    let dir = dirname6(fileURLToPath3(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      for (const relativeRoot of relativeRoots) candidates.push(join9(dir, relativeRoot, file));
      const parent = dirname6(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  for (const relativeRoot of relativeRoots) {
    candidates.push(join9(homedir4(), "code", "pjangler", relativeRoot, file));
  }
  return candidates.find((candidate) => existsSync7(candidate));
}
function provisionTicketProviderBoard(action, env2 = process.env) {
  const provider = action.provider;
  const keyVar = ticketProviderKeyVar(provider);
  const { values } = resolveTicketProviderCredentials({
    keys: ticketProviderKeyVars(provider),
    repoPath: action.repoPath,
    env: env2
  });
  if (!values[keyVar]) {
    return {
      ok: true,
      skipped: true,
      logs: [
        `ticket-provider: ${keyVar} not set; skipping ${provider} board creation (state stays "planned"). Set it in the environment, ${join9(action.repoPath, ".env")}, or ${ticketProviderSecretsPath(env2)}, then re-run with --live \u2014 or pass --board-id to link an existing board.`
      ]
    };
  }
  const adapter = resolveTicketProviderAdapter(provider, env2);
  if (!adapter) {
    return {
      ok: false,
      skipped: false,
      logs: [],
      error: `ticket-provider: no ${provider} adapter found. Set ${TICKET_PROVIDER_ADAPTERS_ENV} to a directory containing ${provider}.sh.`
    };
  }
  const redact = (text2) => Object.values(values).reduce((acc, secret) => secret ? acc.split(secret).join("***") : acc, text2);
  const staging = mkdtempSync2(join9(tmpdir2(), "pjangler-tp-"));
  try {
    const providersDir = join9(staging, "agents", "hermes", "pm", ".scripts", "providers");
    mkdirSync4(providersDir, { recursive: true });
    writeFileSync4(
      join9(staging, ".project.json"),
      `${JSON.stringify(
        {
          project_name: action.boardName,
          repo_path: action.repoPath,
          ticket_provider: {
            type: provider,
            workspace: action.workspace,
            identifier: action.identifier,
            board_id: "",
            state: "planned"
          }
        },
        null,
        2
      )}
`,
      "utf8"
    );
    const staged = join9(providersDir, `${provider}.sh`);
    copyFileSync2(adapter, staged);
    const childEnv = hardenSubprocessEnvironment(env2, { ...values, TICKET_PROVIDER: provider });
    if (provider === "plane" && action.workspace) childEnv.PLANE_WORKSPACE = action.workspace;
    const result = spawnSync("sh", [staged, "create_board", action.boardName, action.identifier, action.description], {
      cwd: existsSync7(action.repoPath) ? action.repoPath : staging,
      encoding: "utf8",
      env: childEnv
    });
    if (result.error) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: could not run the ${provider} adapter: ${redact(result.error.message)}`
      };
    }
    const stderr = redact((result.stderr ?? "").trim());
    if (result.status !== 0) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : ""}`
      };
    }
    const stdout = (result.stdout ?? "").trim();
    const lastLine = stdout.split(/\r?\n/).filter((line) => line.trim()).pop() ?? "";
    let parsed;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned unparseable output: ${redact(lastLine) || "(empty)"}`
      };
    }
    const boardId = isRecord(parsed) && typeof parsed.board_id === "string" ? parsed.board_id.trim() : "";
    if (!boardId) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned no board_id`
      };
    }
    const boardUrl = isRecord(parsed) && typeof parsed.board_url === "string" ? parsed.board_url : void 0;
    return {
      ok: true,
      skipped: false,
      boardId,
      boardUrl,
      logs: [`ticket-provider: ${provider} board linked (${action.identifier} \u2192 ${boardId})`]
    };
  } finally {
    rmSync2(staging, { recursive: true, force: true });
  }
}
function defaultProjectAutomation() {
  return {
    reconcile: {
      enabled: false,
      grace_hours: 0,
      auto_review: true
    }
  };
}
function slugifyProjectName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
var SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function validateSafePathSegment(value, label) {
  const normalized = value.trim();
  const unsafe = !normalized || normalized !== value || normalized === "." || normalized === ".." || isAbsolute2(normalized) || win32.isAbsolute(normalized) || normalized.includes("/") || normalized.includes("\\") || !SAFE_PATH_SEGMENT.test(normalized);
  if (unsafe) {
    throw new Error(
      `${label} must be a non-empty safe single path segment using letters, numbers, dots, underscores, or hyphens (no dot segments, absolute paths, separators, or traversal)`
    );
  }
  return normalized;
}
function prospectiveRealPath(path) {
  let cursor = resolve6(path);
  const suffix = [];
  while (!existsSync7(cursor)) {
    const parent = dirname6(cursor);
    if (parent === cursor) return resolve6(path);
    suffix.unshift(basename5(cursor));
    cursor = parent;
  }
  return resolve6(realpathSync3(cursor), ...suffix);
}
function resolveContainedPath(parentDir, candidate, label) {
  const physicalParent = prospectiveRealPath(parentDir);
  const physicalCandidate = prospectiveRealPath(candidate);
  const fromParent = relative5(physicalParent, physicalCandidate);
  if (!fromParent || fromParent === ".." || fromParent.startsWith(`..${sep2}`) || isAbsolute2(fromParent)) {
    throw new Error(`${label} must remain contained beneath parent directory ${resolve6(parentDir)}`);
  }
  return resolve6(candidate);
}
function deriveProjectIdentifier(value) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const identifier = compact.slice(0, 4) || "PROJ";
  return identifier.length >= 2 ? identifier : `${identifier}XX`.slice(0, 4);
}
function normalizeAgentRole(value) {
  return value === void 0 ? "pm" : validateSafePathSegment(value, "Agent role");
}
function resolveAgentHooksLayer2(input, env2 = process.env) {
  if (typeof input === "boolean") return input;
  const override = env2.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return !existsSync7(join9(homedir4(), ".agents", "hooks"));
}
function jsonStable(value) {
  return JSON.stringify(value);
}
function projectRecordEquivalent(a, b) {
  if (!a) return false;
  const { created_at: _aCreated, updated_at: _aUpdated, ...aComparable } = a;
  const { created_at: _bCreated, updated_at: _bUpdated, ...bComparable } = b;
  return jsonStable(aComparable) === jsonStable(bComparable);
}
function defaultProjectTargetDir(name, cwd = process.cwd()) {
  const compactName = name.replace(/[^A-Za-z0-9._-]/g, "");
  const safeName = SAFE_PATH_SEGMENT.test(compactName) ? compactName : slugifyProjectName(name);
  return resolve6(dirname6(resolve6(cwd)), validateSafePathSegment(safeName, "Generated project directory"));
}
function sourceSkillRoots(env2 = process.env) {
  const configuredRoots = (env2[PROJECT_SOURCE_SKILL_ROOTS_ENV] || "").split(delimiter2).map((root) => root.trim()).filter(Boolean);
  const seen = /* @__PURE__ */ new Set();
  const roots = [];
  for (const root of [...DEFAULT_SOURCE_SKILL_ROOTS, ...configuredRoots]) {
    const normalized = resolve6(expandHome(root));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}
function resolveSourceSkillPath(sourceSkill, env2 = process.env) {
  if (!sourceSkill) return void 0;
  const expanded = expandHome(sourceSkill);
  const direct = resolve6(expanded);
  if (existsSync7(direct)) return direct;
  const name = basename5(sourceSkill);
  const roots = sourceSkillRoots(env2);
  for (const root of roots) {
    const candidate = join9(root, name);
    if (existsSync7(candidate)) return candidate;
  }
  const searched = roots.length ? ` Searched roots: ${roots.join(", ")}.` : "";
  const hint = `${searched} Add project-specific roots with ${PROJECT_SOURCE_SKILL_ROOTS_ENV}.`;
  throw new Error(`Source skill not found: ${sourceSkill}.${hint}`);
}
function planProjectInit(input) {
  if (!input.name.trim()) throw new Error("Project name is required");
  const slug = input.projectSlug === void 0 ? validateSafePathSegment(slugifyProjectName(input.name), "Project slug") : validateSafePathSegment(input.projectSlug, "Project slug");
  const agentRole = normalizeAgentRole(input.agentRole);
  const registryPath2 = resolve6(projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }));
  const registry = loadProjectRegistry(registryPath2);
  const now = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
  const targetDir = resolve6(input.targetDir ?? defaultProjectTargetDir(input.name, input.cwd));
  const identifier = (input.projectIdentifier ?? deriveProjectIdentifier(input.name)).toUpperCase();
  const existing = getOwnRecordValue(registry.projects, slug);
  const sourceSkillPath = resolveSourceSkillPath(input.sourceSkill);
  const overwrite = input.overwrite ?? input.force ?? false;
  const agents = createSafeRecord(Object.entries(existing?.agents ?? {}));
  if (input.provisionAgent) {
    agents[agentRole] = {
      role: agentRole,
      provisioning_state: "planned"
    };
  }
  const scaffold = input.scaffold ?? true;
  const candidateProject = {
    name: input.name,
    slug,
    repo_path: targetDir,
    description: input.description ?? "",
    // A project the CLI is bootstrapping is being worked on right now, so a
    // NEW record starts "active" (PJAN-26). This is a default for new records,
    // NOT a migration: an already-registered project keeps whatever lifecycle
    // status it has ("planned"/"active"/"archived"), so re-running init (or the
    // sync path) never rewrites it.
    // NOTE: unrelated to `ticket_provider.state` and `agents.*.provisioning_state`,
    // which are different lifecycles and still default to "planned".
    status: existing?.status ?? DEFAULT_NEW_PROJECT_STATUS,
    source_artifacts: sourceSkillPath ? [{ kind: "skill", path: sourceSkillPath, package_name: input.packageName ?? slug }] : [],
    template: {
      commonproject: {
        enabled: true,
        primary_language: input.primaryLanguage ?? "python"
      }
    },
    ticket_provider: buildTicketProviderBlock({
      type: input.ticketProvider ?? "plane",
      identifier,
      // A board provisioned by an earlier run lives in the registry, not in the
      // CLI flags — inherit it so re-running init re-links instead of minting a
      // second board.
      boardId: input.boardId ?? input.planeProjectId ?? (existing?.ticket_provider?.board_id || void 0),
      workspace: input.boardWorkspace ?? input.planeWorkspace
    }),
    agents,
    automation: existing?.automation ?? defaultProjectAutomation(),
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  const project = {
    ...candidateProject,
    updated_at: projectRecordEquivalent(existing, candidateProject) ? existing.updated_at : now
  };
  validateNoDuplicateProject(registry, project, overwrite);
  const pjanglerRoot = resolve6(input.pjanglerRoot ?? resolvePjanglerRoot2());
  const manifest = projectManifestFromRegistryProject(project);
  const apply = input.apply ?? false;
  const live = input.live ?? false;
  const provisionRuntimeRepo = input.provisionRuntimeRepo ?? live;
  const provisionTicketBoard = input.provisionTicketBoard ?? live;
  const enableSystemd = input.enableSystemd ?? live;
  const skipPlane = input.skipPlane ?? false;
  const boardEnabled = live && provisionTicketBoard && !skipPlane;
  const runtimeRepoEnabled = live && provisionRuntimeRepo;
  const systemdEnabled = live && enableSystemd && process.platform !== "darwin";
  const anyExternalAgentEffect = runtimeRepoEnabled || boardEnabled || systemdEnabled;
  const actions = [
    { kind: "registry.upsert", registryPath: registryPath2, slug, project }
  ];
  if (scaffold) {
    actions.push(buildCommonProjectCopierAction({
      pjanglerRoot,
      targetDir,
      projectName: project.name,
      projectDescription: project.description,
      projectSlug: project.slug,
      ticketProvider: project.ticket_provider.type,
      planeWorkspace: project.ticket_provider.workspace ?? "33god",
      planeProjectId: project.ticket_provider.board_id ?? "",
      ticketWorkspace: project.ticket_provider.workspace ?? "",
      boardId: project.ticket_provider.board_id ?? "",
      projectIdentifier: identifier,
      primaryLanguage: project.template.commonproject.primary_language,
      agentHooksLayer: resolveAgentHooksLayer2(input.agentHooksLayer),
      overwrite
    }));
  }
  actions.push(
    { kind: "project.write-manifest", path: join9(targetDir, ".project.json"), manifest },
    {
      kind: "ticket-provider.create-or-link",
      enabled: boardEnabled,
      live,
      provider: project.ticket_provider.type,
      workspace: project.ticket_provider.workspace ?? "33god",
      identifier,
      repoPath: targetDir,
      boardName: project.name,
      description: project.description || `Ticket board for ${project.slug}`,
      boardId: project.ticket_provider.board_id ?? "",
      state: project.ticket_provider.board_id ? "linked" : "planned",
      reason: skipPlane ? "ticket-provider action disabled by skipPlane=true" : project.ticket_provider.board_id ? "board already linked; no provider call" : !live ? "network/cloud actions require --live" : !provisionTicketBoard ? "ticket-provider action requires explicit provisionTicketBoard=true" : `create or link the ${project.ticket_provider.type} board "${project.name}" (${identifier}) via the ticket-provider adapter`
    },
    {
      kind: "hermes.provision-agent",
      enabled: input.provisionAgent ?? false,
      local: !anyExternalAgentEffect,
      targetDir,
      targetRepo: slug,
      role: agentRole,
      context: {
        skipRuntimeRepo: !runtimeRepoEnabled,
        skipPlane: !boardEnabled,
        // Per-agent Bloodbank consumers are retired. Agent ingress always
        // stays on the fleet-shared gateway, regardless of live/local mode.
        skipBloodbank: true,
        skipSystemd: !systemdEnabled
      }
    }
  );
  return {
    ok: true,
    apply,
    dryRun: !apply,
    live,
    registryPath: registryPath2,
    project,
    manifest,
    actions,
    ...input.boardUrl !== void 0 ? { warnings: [BOARD_URL_DEPRECATION_WARNING] } : {}
  };
}
function linkTicketProviderBoard(plan, action, boardId) {
  const block = buildTicketProviderBlock({
    type: action.provider,
    identifier: action.identifier,
    boardId,
    workspace: action.workspace
  });
  plan.project.ticket_provider = block;
  const manifestProvider = {
    type: block.type,
    workspace: block.workspace ?? "",
    identifier: block.identifier ?? "",
    board_id: block.board_id ?? "",
    state: block.state ?? "linked"
  };
  plan.manifest.ticket_provider = manifestProvider;
  action.boardId = boardId;
  action.state = manifestProvider.state;
  const manifestPath = join9(action.repoPath, ".project.json");
  let next;
  if (existsSync7(manifestPath)) {
    let existing = {};
    try {
      const parsed = JSON.parse(readFileSync6(manifestPath, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      existing = {};
    }
    const existingProvider = isRecord(existing.ticket_provider) ? existing.ticket_provider : {};
    next = { ...existing, ticket_provider: { ...existingProvider, ...manifestProvider } };
  } else {
    mkdirSync4(dirname6(manifestPath), { recursive: true });
    next = plan.manifest;
  }
  const text2 = `${JSON.stringify(next, null, 2)}
`;
  if (!existsSync7(manifestPath) || readFileSync6(manifestPath, "utf8") !== text2) {
    writeFileSync4(manifestPath, text2, "utf8");
    return [manifestPath];
  }
  return [];
}
async function executeProjectInitPlan(plan, options = {}) {
  const logs = [];
  const errors = [];
  const changedFiles = [];
  if (!plan.apply) return { ok: true, plan, logs, errors, changedFiles };
  const registry = loadProjectRegistry(plan.registryPath);
  let pendingRegistryAction;
  for (const action of plan.actions) {
    if (action.kind === "copier.copy.commonproject") {
      if (options.requireTrustedCopier && !options.trustedCopier) {
        errors.push("MCP project apply requires a preflight-attested Copier identity");
        break;
      }
      if (options.trustedCopier) {
        const verified = verifyTrustedCopierIdentity(options.trustedCopier);
        if (!verified.ok) {
          errors.push(`Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`);
          break;
        }
      }
      logs.push(
        action.data.agent_hooks_layer === "false" ? "commonproject: agent-hooks layer skipped (global ~/.agents/hooks detected \u2014 no per-user CLI injection)" : "commonproject: agent-hooks layer included"
      );
      mkdirSync4(dirname6(action.targetDir), { recursive: true });
      const before = snapshotTree(action.targetDir);
      const copierExecutable = options.trustedCopier?.executable ?? action.command[0];
      const copierEnv = hardenSubprocessEnvironment();
      const result = spawnSync(copierExecutable, action.command.slice(1), {
        encoding: "utf8",
        cwd: action.cwd,
        env: copierEnv
      });
      const copierChanges = changedTreePaths(action.targetDir, before, snapshotTree(action.targetDir));
      changedFiles.push(...copierChanges);
      if (result.stdout?.trim()) logs.push(result.stdout.trim());
      if (result.stderr?.trim()) logs.push(result.stderr.trim());
      if (result.error) {
        const code = result.error.code;
        errors.push(
          code === "ENOENT" ? "copier not found on PATH. Install with: uv tool install copier or pip install copier" : `copier failed: ${result.error.message}`
        );
        break;
      }
      if (result.status !== 0) {
        errors.push(`copier exited with status ${result.status ?? "unknown"}`);
        break;
      }
    } else if (action.kind === "project.write-manifest") {
      mkdirSync4(dirname6(action.path), { recursive: true });
      const next = `${JSON.stringify(action.manifest, null, 2)}
`;
      const current = existsSync7(action.path) ? readFileSync6(action.path, "utf8") : void 0;
      if (current !== next) {
        writeFileSync4(action.path, next, "utf8");
        changedFiles.push(action.path);
      }
      changedFiles.push(...synchronizeCopierIdentity(action.path, action.manifest));
    } else if (action.kind === "registry.upsert") {
      pendingRegistryAction = action;
    } else if (action.kind === "ticket-provider.create-or-link") {
      if (!action.enabled) {
        logs.push(`ticket-provider.create-or-link skipped (${action.reason ?? "disabled by plan"})`);
      } else if (action.boardId) {
        logs.push(`ticket-provider: ${action.provider} board already linked (${action.identifier} \u2192 ${action.boardId}); nothing to create`);
      } else {
        const outcome = provisionTicketProviderBoard(action);
        logs.push(...outcome.logs);
        if (!outcome.ok) {
          errors.push(outcome.error ?? `ticket-provider: ${action.provider} board provisioning failed`);
        } else if (outcome.boardId) {
          changedFiles.push(...linkTicketProviderBoard(plan, action, outcome.boardId));
          pendingRegistryAction ??= {
            kind: "registry.upsert",
            registryPath: plan.registryPath,
            slug: plan.project.slug,
            project: plan.project
          };
        }
      }
    } else if (action.kind === "hermes.provision-agent") {
      logs.push(action.enabled ? "hermes.provision-agent planned for the caller to execute" : "hermes.provision-agent skipped");
    }
  }
  if (pendingRegistryAction && errors.length === 0) {
    if (!projectRecordEquivalent(getOwnRecordValue(registry.projects, pendingRegistryAction.slug), pendingRegistryAction.project)) {
      registry.projects[pendingRegistryAction.slug] = pendingRegistryAction.project;
      saveProjectRegistry(registry, pendingRegistryAction.registryPath);
      changedFiles.push(pendingRegistryAction.registryPath);
      if (isPgRegistryEnabled()) {
        try {
          const pgStore = new PgRegistryStore(pgRegistryConfigFromEnv());
          await pgStore.upsert(pendingRegistryAction.slug, pendingRegistryAction.project);
          await pgStore.close();
          logs.push("registry: PG dual-write complete");
        } catch (pgErr) {
          logs.push(`registry: PG dual-write failed (yaml is authoritative): ${pgErr instanceof Error ? pgErr.message : pgErr}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, plan, logs, errors, changedFiles: [...new Set(changedFiles)].sort() };
}
function projectManifestFromRegistryProject(project) {
  const agents = Object.fromEntries(
    Object.entries(project.agents).map(([name, agent]) => [
      `${project.slug}-${name}`,
      {
        role: agent.role,
        role_dir: agent.role_dir,
        provisioning_state: agent.provisioning_state
      }
    ])
  );
  return {
    project_name: project.name,
    project_description: project.description,
    project_slug: project.slug,
    repo_path: project.repo_path,
    ticket_provider: {
      type: project.ticket_provider.type,
      workspace: project.ticket_provider.workspace ?? "",
      identifier: project.ticket_provider.identifier ?? "",
      board_id: project.ticket_provider.board_id ?? "",
      state: project.ticket_provider.state
    },
    agents,
    automation: project.automation ?? defaultProjectAutomation()
  };
}
function getProject(registry, slug) {
  const project = getOwnRecordValue(registry.projects, slug);
  if (!project) throw new Error(`Project not found in registry: ${slug}`);
  return project;
}
function buildCommonProjectCopierAction(input) {
  const templateDir = join9(input.pjanglerRoot, "templates", "commonproject");
  const data = {
    project_name: input.projectName,
    project_description: input.projectDescription ?? "",
    project_slug: input.projectSlug,
    ticket_provider: input.ticketProvider,
    plane_workspace: input.planeWorkspace,
    plane_project_id: input.planeProjectId ?? "",
    ticket_workspace: input.ticketWorkspace ?? input.planeWorkspace,
    board_id: input.boardId ?? input.planeProjectId ?? "",
    project_identifier: input.projectIdentifier,
    primary_language: input.primaryLanguage,
    agent_hooks_layer: input.agentHooksLayer ?? true ? "true" : "false"
  };
  const command = ["copier", "copy", "--trust", "--vcs-ref=HEAD", templateDir, input.targetDir, "--defaults"];
  for (const [key, value] of Object.entries(data)) command.push("--data", `${key}=${value}`);
  if (input.overwrite) command.push("--overwrite");
  return {
    kind: "copier.copy.commonproject",
    cwd: input.pjanglerRoot,
    command,
    targetDir: input.targetDir,
    data,
    overwrite: input.overwrite
  };
}
function resolvePjanglerRoot2() {
  let dir = dirname6(new URL(import.meta.url).pathname);
  while (dir !== dirname6(dir)) {
    if (existsSync7(join9(dir, "package.json")) && existsSync7(join9(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname6(dir);
  }
  return resolve6(process.cwd());
}
function validateNoDuplicateProject(registry, project, overwrite) {
  const existingSameSlug = getOwnRecordValue(registry.projects, project.slug);
  if (existingSameSlug && !overwrite && resolve6(existingSameSlug.repo_path) !== resolve6(project.repo_path)) {
    throw new Error(`Project slug already exists in registry: ${project.slug}`);
  }
  for (const [slug, existing] of Object.entries(registry.projects)) {
    if (slug === project.slug) continue;
    if (resolve6(existing.repo_path) === resolve6(project.repo_path)) {
      throw new Error(`Project repo_path already registered by ${slug}: ${project.repo_path}`);
    }
    if (existing.ticket_provider.identifier && existing.ticket_provider.identifier.toUpperCase() === project.ticket_provider.identifier?.toUpperCase()) {
      throw new Error(`Project identifier already registered by ${slug}: ${project.ticket_provider.identifier}`);
    }
  }
}
function validateProjectRecord(project, key) {
  validateSafePathSegment(key, `Project registry key ${key}`);
  if (!isRecord(project)) throw new Error(`Project ${key} must be a mapping`);
  if (!project.name) throw new Error(`Project ${key} missing name`);
  if (!project.slug) throw new Error(`Project ${key} missing slug`);
  validateSafePathSegment(project.slug, `Project ${key} slug`);
  if (project.slug !== key) throw new Error(`Project key ${key} does not match slug ${project.slug}`);
  if (!project.repo_path) throw new Error(`Project ${key} missing repo_path`);
  if (!Array.isArray(project.source_artifacts)) throw new Error(`Project ${key} source_artifacts must be a list`);
  if (!isRecord(project.ticket_provider)) throw new Error(`Project ${key} ticket_provider must be a mapping`);
  if (!isRecord(project.agents)) throw new Error(`Project ${key} agents must be a mapping`);
  for (const [agentKey, agent] of Object.entries(project.agents)) {
    validateSafePathSegment(agentKey, `Project ${key} agent key ${agentKey}`);
    if (!isRecord(agent)) throw new Error(`Project ${key} agent ${agentKey} must be a mapping`);
    if (typeof agent.role !== "string" || !agent.role) throw new Error(`Project ${key} agent ${agentKey} missing role`);
    validateSafePathSegment(agent.role, `Project ${key} agent ${agentKey} role`);
  }
}
function expandHome(path) {
  if (path === "~") return homedir4();
  if (path.startsWith("~/")) return join9(homedir4(), path.slice(2));
  return path;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/commands/hermes/RunCopierTemplate.ts
var TICKET_PROVIDER_CREDENTIAL_KEYS = /* @__PURE__ */ new Set([
  "PLANE_API_KEY",
  "TRELLO_KEY",
  "TRELLO_TOKEN",
  "LINEAR_API_KEY"
]);
var INTERACTIVE_CHANNEL_CREDENTIAL_KEYS = /* @__PURE__ */ new Set([
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CF_EMAIL_ROUTING_TOKEN"
]);
function scrubTicketProviderCredentials(env2) {
  for (const key of Object.keys(env2)) {
    if (TICKET_PROVIDER_CREDENTIAL_KEYS.has(key) || /^PLANE_[A-Z0-9_]+_API_KEY$/.test(key)) {
      delete env2[key];
    }
  }
}
function scrubInteractiveChannelCredentials(env2) {
  for (const key of INTERACTIVE_CHANNEL_CREDENTIAL_KEYS) delete env2[key];
  delete env2.ENABLE_SLACK;
  delete env2.WIRE_SLACK;
}
function registerRenderedAgent(ctx, roleDir, role) {
  const manifestPath = join10(ctx.targetDir, ".project.json");
  if (!existsSync8(manifestPath) || !ctx.targetRepo) return;
  const current = readFileSync7(manifestPath, "utf8");
  const parsed = JSON.parse(current);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  const manifest = parsed;
  const rawAgents = manifest.agents;
  if (rawAgents !== void 0 && (!rawAgents || typeof rawAgents !== "object" || Array.isArray(rawAgents))) {
    throw new Error(`${manifestPath} agents must contain a JSON object`);
  }
  const agents = rawAgents ?? {};
  const agentId = ctx.agentId ?? deriveAgentId(ctx.targetRepo, role);
  Object.defineProperty(agents, agentId, {
    value: {
      role,
      role_dir: relative6(ctx.targetDir, roleDir),
      provisioning_state: "provisioned"
    },
    configurable: true,
    enumerable: true,
    writable: true
  });
  manifest.agents = agents;
  const next = `${JSON.stringify(manifest, null, 2)}
`;
  if (next !== current) writeFileSync5(manifestPath, next, "utf8");
}
function resolveVendoredTemplate(name) {
  let dir;
  try {
    dir = dirname7(fileURLToPath4(import.meta.url));
  } catch {
    return void 0;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join10(dir, "templates", name);
    if (existsSync8(join10(candidate, "copier.yml"))) return candidate;
    const parent = dirname7(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
var RunCopierTemplate = class extends Command {
  async invoke() {
    const ctx = this.context;
    const {
      targetRepo,
      role,
      agentPurpose,
      soulTone,
      modelProvider,
      modelName,
      modelBaseUrl,
      modelApiMode,
      modelKeyEnv
    } = ctx;
    const ticketProvider = ctx.ticketProvider ?? "plane";
    const profileName = ctx.profileName ?? (targetRepo && role ? deriveProfileName(targetRepo, role) : void 0);
    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)"
      };
    }
    const safeRole = normalizeAgentRole(role);
    ctx.role = safeRole;
    const roleDir = resolveContainedPath(
      ctx.targetDir,
      join10(ctx.targetDir, "agents", "hermes", safeRole),
      "Hermes role directory"
    );
    ctx.roleDir = roleDir;
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${safeRole}`;
    const trustedCopierRequired = Boolean(ctx.deferredExternalEffects && !ctx.dryRun);
    if (trustedCopierRequired && !ctx.trustedCopier) {
      return {
        success: false,
        outcome: "failed",
        message: "MCP Hermes apply requires a preflight-attested Copier identity"
      };
    }
    if (!ctx.trustedCopier) {
      const which = spawnSync("which", ["copier"], {
        encoding: "utf8",
        env: hardenSubprocessEnvironment()
      });
      if (which.status !== 0) {
        return {
          success: false,
          outcome: "failed",
          message: "\u2717 copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`"
        };
      }
    }
    if (existsSync8(join10(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await p2.confirm({
          message: `${safeRole}/role.yaml already exists \u2014 re-render with --overwrite?`,
          initialValue: false
        });
        if (p2.isCancel(proceed) || !proceed) {
          return {
            success: false,
            outcome: "cancelled",
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`
          };
        }
        ctx.force = true;
      }
    }
    const env2 = hardenSubprocessEnvironment(process.env, {
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: ctx.deferredExternalEffects ? "1" : "0",
      // Fresh project targets do not have their own .git directory until the
      // project transaction's final phase. Pin scripts to the caller-resolved
      // root so they can never climb into an enclosing checkout.
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      // Config, fleet env/profile, and registry are host-global state. MCP
      // renders repo-local files first and executes those scripts only after a
      // structural lifecycle gate has accepted the render.
      SKIP_HOST_STATE: ctx.deferredExternalEffects ? "1" : "0",
      // Bloodbank is a fleet-shared Hermes gateway. Never provision the legacy
      // per-profile file consumer, even when an older template still exposes it.
      SKIP_RUNTIME_REPO: ctx.deferredExternalEffects ? "1" : ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.deferredExternalEffects ? "1" : ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: "1",
      SKIP_SYSTEMD: ctx.deferredExternalEffects ? "1" : ctx.skipSystemd ? "1" : "0"
    });
    if (ctx.deferredExternalEffects) scrubInteractiveChannelCredentials(env2);
    if (ctx.deferredExternalEffects || ctx.skipPlane) scrubTicketProviderCredentials(env2);
    const LOCAL_TEMPLATE = join10(homedir5(), "code", "hermes-agent-template");
    const vendored = resolveVendoredTemplate("hermes-agent");
    const templateSrc = process.env.PJANGLER_HERMES_TEMPLATE || vendored || (existsSync8(join10(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);
    const args = [
      "copy",
      templateSrc,
      roleDir,
      "--data",
      `target_repo=${targetRepo}`,
      "--data",
      `role=${safeRole}`,
      "--data",
      `agent_purpose=${agentPurpose ?? ""}`,
      "--data",
      `model_provider=${modelProvider ?? ""}`,
      "--data",
      `model_name=${modelName ?? ""}`,
      "--data",
      `model_base_url=${modelBaseUrl ?? ""}`,
      "--data",
      `model_api_mode=${modelApiMode ?? ""}`,
      "--data",
      `model_key_env=${modelKeyEnv ?? ""}`,
      "--data",
      `profile_name=${profileName ?? ""}`,
      "--data",
      `soul_tone=${soulTone ?? "direct"}`,
      "--data",
      `ticket_provider=${ticketProvider}`,
      "--trust",
      "--vcs-ref=HEAD"
    ];
    if (ctx.force) args.push("--overwrite");
    if (ctx.dryRun) {
      return {
        success: true,
        outcome: "planned",
        filePath: roleDir,
        message: this.formatMessage(`Would run: ${ctx.trustedCopier?.executable ?? "copier"} ${args.join(" ")}`)
      };
    }
    if (ctx.trustedCopier) {
      const verified = verifyTrustedCopierIdentity(ctx.trustedCopier);
      if (!verified.ok) {
        return {
          success: false,
          outcome: "failed",
          message: `Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`
        };
      }
    }
    mkdirSync5(join10(ctx.targetDir, "agents", "hermes"), { recursive: true });
    const spinner4 = ctx.quiet ? void 0 : p2.spinner();
    spinner4?.start(`Running copier copy  (target: agents/hermes/${safeRole})`);
    const copierExecutable = ctx.trustedCopier?.executable ?? "copier";
    const result = spawnSync(copierExecutable, args, ctx.quiet ? { encoding: "utf8", env: env2, cwd: ctx.targetDir } : { stdio: "inherit", env: env2, cwd: ctx.targetDir });
    spinner4?.stop(result.status === 0 ? "\u2713 copier run complete" : "\u2717 copier failed");
    if (result.status !== 0) {
      return {
        success: false,
        outcome: "failed",
        message: `copier exited with status ${result.status}.${ctx.quiet && String(result.stderr ?? "").trim() ? ` ${String(result.stderr).trim()}` : " Check the output above; re-run with the same flags after fixing."}`
      };
    }
    const roleManifest = join10(roleDir, "role.yaml");
    try {
      const current = readFileSync7(roleManifest, "utf8");
      const document = YAML4.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], ctx.deferredExternalEffects ? true : Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], ctx.deferredExternalEffects ? "deferred" : ctx.skipSystemd ? "deferred" : "required");
      const next = String(document);
      if (next !== current) writeFileSync5(roleManifest, next, "utf8");
      registerRenderedAgent(ctx, roleDir, safeRole);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record Hermes deployment mode in ${roleManifest}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      success: true,
      message: `\u2713 Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`
    };
  }
};

// src/commands/hermes/UntrackHermesRuntimes.ts
import { existsSync as existsSync9, readFileSync as readFileSync8, writeFileSync as writeFileSync6, readdirSync as readdirSync5 } from "fs";
import { join as join11 } from "path";
function sectionHasPath(section2, targetPath) {
  return section2.split(/\r?\n/).some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}
function removeSubmodulePath(content, targetPath) {
  return content.replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section2) => sectionHasPath(section2, targetPath) ? "" : section2).replace(/\n{3,}/g, "\n\n").trim();
}
var UntrackHermesRuntimes = class extends Command {
  async invoke() {
    const targetDir = this.context.targetDir;
    const childEnv = hardenSubprocessEnvironment();
    const rolesDir = join11(targetDir, "agents", "hermes");
    if (!existsSync9(rolesDir)) {
      return {
        success: true,
        message: "No Hermes agents found (no agents/hermes directory)."
      };
    }
    const roles = readdirSync5(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (roles.length === 0) {
      return {
        success: true,
        message: "No Hermes agents found."
      };
    }
    let modifiedAny = false;
    const details = [];
    for (const role of roles) {
      const roleDir = join11("agents", "hermes", role);
      const runtimePath = join11(roleDir, "runtime");
      const gitignorePath = join11(roleDir, ".gitignore");
      const gitmodulesPath = join11(targetDir, ".gitmodules");
      let isTracked = false;
      const lsResult = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: targetDir,
        encoding: "utf8",
        env: childEnv
      });
      if (lsResult.status !== 0) {
        return {
          success: false,
          message: `\u2717 Failed to inspect runtime index at ${runtimePath}: ${lsResult.stderr.trim() || `exit ${lsResult.status}`}`
        };
      }
      if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
        isTracked = true;
      }
      let hasStaleMapping = false;
      let gitmodulesContent = "";
      if (existsSync9(gitmodulesPath)) {
        gitmodulesContent = readFileSync8(gitmodulesPath, "utf8");
        const sections = gitmodulesContent.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
        hasStaleMapping = sections.some((section2) => sectionHasPath(section2, runtimePath));
      }
      let isIgnored = false;
      const fullGitignorePath = join11(targetDir, gitignorePath);
      if (existsSync9(fullGitignorePath)) {
        const content = readFileSync8(fullGitignorePath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim());
        isIgnored = lines.includes("runtime/") || lines.includes("runtime");
      }
      if (isTracked || hasStaleMapping || !isIgnored) {
        modifiedAny = true;
        if (isTracked) {
          details.push(`untrack agents/hermes/${role}/runtime`);
          if (!this.context.dryRun) {
            const rmResult = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8",
              env: childEnv
            });
            if (rmResult.status !== 0) {
              return {
                success: false,
                message: `\u2717 Failed to untrack ${runtimePath}: ${rmResult.stderr.trim() || `exit ${rmResult.status}`}`
              };
            }
            const verifyResult = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8",
              env: childEnv
            });
            if (verifyResult.status !== 0 || verifyResult.stdout.trim()) {
              return {
                success: false,
                message: verifyResult.status !== 0 ? `\u2717 Failed to verify untracked runtime ${runtimePath}: ${verifyResult.stderr.trim() || `exit ${verifyResult.status}`}` : `\u2717 Runtime remains tracked after index-only removal: ${runtimePath}`
              };
            }
          }
        }
        if (hasStaleMapping) {
          details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
          if (!this.context.dryRun) {
            const next = removeSubmodulePath(gitmodulesContent, runtimePath);
            writeFileSync6(gitmodulesPath, next ? `${next}
` : "", "utf8");
          }
        }
        if (!isIgnored) {
          details.push(`ignore runtime/ in agents/hermes/${role}/.gitignore`);
          if (!this.context.dryRun) {
            let content = "";
            if (existsSync9(fullGitignorePath)) {
              content = readFileSync8(fullGitignorePath, "utf8");
            }
            if (content && !content.endsWith("\n")) {
              content += "\n";
            }
            content += "runtime/\n";
            writeFileSync6(fullGitignorePath, content, "utf8");
          }
        }
      }
    }
    if (!modifiedAny) {
      return {
        success: true,
        message: "\u2705 All Hermes agent runtimes are already untracked and gitignored."
      };
    }
    const actionText = this.context.dryRun ? "Would make" : "Made";
    return {
      success: true,
      message: `${actionText} Hermes agent runtimes untracked and gitignored:
${details.map((d) => `  - ${d}`).join("\n")}`
    };
  }
};

// src/commands/hermes/WireTelegram.ts
import { join as join12 } from "node:path";
import { existsSync as existsSync10, unlinkSync as unlinkSync2 } from "node:fs";
import * as p3 from "@clack/prompts";
var WireTelegram = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipTelegram) {
      return { success: true, message: "\u2192 Telegram wire-up skipped" };
    }
    if (ctx.quiet) {
      return {
        success: false,
        outcome: "failed",
        message: "Telegram wiring is interactive and unavailable during quiet/non-interactive Hermes execution"
      };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }
    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;
    const vaultTitle = `Telegram-Hermes-${targetRepo.toLowerCase()}-${role.toLowerCase()}`;
    const vaultRef = `op://DeLoSecrets/${vaultTitle}/token`;
    const childEnv = hardenSubprocessEnvironment();
    let token = process.env.TELEGRAM_BOT_TOKEN;
    let source = token ? "env" : null;
    if (!token) {
      const tryOp = spawnSync("op", ["read", vaultRef], { encoding: "utf8", env: childEnv });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
        source = "op";
        p3.log.info(`\u2713 Telegram token loaded from ${vaultRef}`);
      }
    }
    if (!token) {
      p3.log.step("BotFather steps");
      p3.log.info(
        [
          "  1. Open Telegram, message @BotFather",
          "  2. /newbot",
          `  3. Display name:   ${displayName}`,
          `  4. Username:       ${botHandle}   (must end in _bot)`,
          "  5. Copy the HTTP API token from the reply.",
          "  6. /setjoingroups Disable",
          "  7. /setprivacy    Disable"
        ].join("\n")
      );
      const tokenAnswer = await p3.password({
        message: `Paste the bot token for @${botHandle}`,
        mask: "\u2022",
        validate: (v) => {
          const s = String(v ?? "").trim();
          if (!s) return "required";
          if (!/^[0-9]+:.+/.test(s)) return "expected '<digits>:<secret>' shape";
        }
      });
      if (p3.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Telegram skipped (no token).  Re-run later." };
      }
      token = String(tokenAnswer).trim();
      source = "prompt";
      const persist = await p3.confirm({
        message: `Save to ${vaultRef} for next time?`,
        initialValue: true
      });
      if (!p3.isCancel(persist) && persist) {
        const create = spawnSync(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            `--title=${vaultTitle}`,
            `token=${token}`,
            `bot_handle=${botHandle}`
          ],
          { stdio: "inherit", env: childEnv }
        );
        if (create.status !== 0) {
          p3.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const allowedAnswer = await p3.text({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v) => /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v).trim()) ? void 0 : "comma-separated numeric ids"
    });
    if (p3.isCancel(allowedAnswer)) {
      return { success: false, message: "\u2717 Aborted; Telegram step deferred." };
    }
    const script = join12(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync10(script)) {
      return {
        success: false,
        message: `\u2717 ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`
      };
    }
    const marker = join12(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync10(marker)) unlinkSync2(marker);
    const spinner4 = p3.spinner();
    spinner4.start("Verifying token + wiring profile");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: hardenSubprocessEnvironment(process.env, {
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim()
      }),
      cwd: roleDir
    });
    spinner4.stop(result.status === 0 ? "\u2713 Telegram wired" : "\u2717 Telegram step failed");
    if (result.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }
    const sourceLabel = source === "env" ? " (token: env)" : source === "op" ? " (token: op)" : "";
    return { success: true, message: `\u2713 Telegram: @${botHandle} ready${sourceLabel}` };
  }
};
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// src/commands/hermes/WireEmail.ts
import { join as join13 } from "node:path";
import { existsSync as existsSync11, unlinkSync as unlinkSync3 } from "node:fs";
import * as p4 from "@clack/prompts";
var WireEmail = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipEmail) {
      return { success: true, message: "" };
    }
    if (ctx.quiet) {
      return {
        success: false,
        outcome: "failed",
        message: "Email wiring is interactive and unavailable during quiet/non-interactive Hermes execution"
      };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join13(roleDir, ".scripts", "50-email.sh");
    if (!existsSync11(script)) {
      return { success: false, message: `\u2717 ${script} not found` };
    }
    const childEnv = hardenSubprocessEnvironment();
    let token = process.env.CF_EMAIL_ROUTING_TOKEN;
    if (!token) {
      const tryOp = spawnSync(
        "op",
        ["read", "op://DeLoSecrets/Cloudflare-EmailRouting/token"],
        { encoding: "utf8", env: childEnv }
      );
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
      }
    }
    if (!token) {
      p4.log.warn("CF Email Routing token not found.  Required scopes:");
      p4.log.info(
        [
          "  Zone (delo.sh)  \u2192  Email Routing Rules     : Edit",
          "  Zone (delo.sh)  \u2192  Email Routing Settings  : Read",
          "  Account         \u2192  Email Routing Addresses : Read",
          "Create at: https://dash.cloudflare.com/profile/api-tokens"
        ].join("\n")
      );
      const provideNow = await p4.confirm({
        message: "Paste a token now?  (skipping leaves email unwired until you re-run.)",
        initialValue: false
      });
      if (p4.isCancel(provideNow) || !provideNow) {
        return { success: true, message: "\u2192 Email skipped (no token).  Re-run later." };
      }
      const tokenAnswer = await p4.password({
        message: "CF token (will be passed via env, not stored)",
        mask: "\u2022",
        validate: (v) => String(v ?? "").trim() ? void 0 : "required"
      });
      if (p4.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Email skipped (cancelled)" };
      }
      token = String(tokenAnswer).trim();
      const persist = await p4.confirm({
        message: "Save to op://DeLoSecrets/Cloudflare-EmailRouting/token for next time?",
        initialValue: true
      });
      if (!p4.isCancel(persist) && persist) {
        const create = spawnSync(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            "--title=Cloudflare-EmailRouting",
            `token=${token}`
          ],
          { stdio: "inherit", env: childEnv }
        );
        if (create.status !== 0) {
          p4.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const marker = join13(roleDir, ".scripts", ".done-50-email");
    if (existsSync11(marker)) unlinkSync3(marker);
    const spinner4 = p4.spinner();
    spinner4.start("Creating Cloudflare Email Routing rule");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: hardenSubprocessEnvironment(process.env, { SKIP_EMAIL: "0", CF_EMAIL_ROUTING_TOKEN: token }),
      cwd: roleDir
    });
    spinner4.stop(result.status === 0 ? "\u2713 Email rule created" : "\u2717 Email step failed");
    if (result.status !== 0) {
      return { success: false, message: "Email rule creation failed.  See output above." };
    }
    return {
      success: true,
      message: `\u2713 Email: ${targetRepo}-${role}@delo.sh  \u2192  jaradd@gmail.com`
    };
  }
};

// src/commands/hermes/PrintHermesSummary.ts
import * as p5 from "@clack/prompts";
var PrintHermesSummary = class extends Command {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentId, runtimeRepo, skipTelegram, skipEmail } = ctx;
    const botHandle = `${targetRepo?.toLowerCase().replace(/-/g, "_")}_${role?.toLowerCase()}_bot`;
    const email = `${targetRepo}-${role}@delo.sh`;
    const gw = `hermes-${agentId}-gateway.service`;
    const hb = `hermes-${agentId}-heartbeat.timer`;
    const lines = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    if (!skipEmail) lines.push(`email        ${email}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${hb}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("  # Bloodbank commands arrive through the fleet-shared Hermes gateway");
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram) {
      lines.push("");
      lines.push("Wire Telegram later:");
      lines.push("  pjangler hermes-agent          # re-run and answer yes when asked");
    }
    if (!ctx.quiet) {
      p5.note(lines.join("\n"), `Provisioned ${agentId}`);
      p5.outro("Done.");
    }
    return { success: true, outcome: "unchanged", message: "" };
  }
};

// src/commands/hermes/ApplyDeferredExternalEffects.ts
import { existsSync as existsSync12, readFileSync as readFileSync9, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join14 } from "node:path";
import YAML5 from "yaml";
var ApplyDeferredExternalEffects = class extends Command {
  async invoke() {
    const ctx = this.context;
    const selected = ctx.deferredExternalEffects;
    if (!selected || !selected.runtimeRepo && !selected.ticketBoard && !selected.systemd) {
      return { success: true, outcome: "unchanged", message: "Hermes external effects not selected" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred external effects" };
    }
    const env2 = hardenSubprocessEnvironment(process.env, {
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      SKIP_RUNTIME_REPO: selected.runtimeRepo ? "0" : "1",
      SKIP_PLANE: selected.ticketBoard ? "0" : "1",
      SKIP_SYSTEMD: selected.systemd ? "0" : "1"
    });
    scrubInteractiveChannelCredentials(env2);
    if (!selected.ticketBoard) scrubTicketProviderCredentials(env2);
    const roleManifest = join14(ctx.roleDir, "role.yaml");
    const scripts = [
      ...selected.runtimeRepo ? ["20-runtime-repo.sh"] : [],
      ...selected.ticketBoard ? ["42-ticket-provider.sh"] : [],
      ...selected.systemd ? ["70-systemd.sh"] : [],
      // Refresh fleet metadata after a board binding or runtime/systemd state
      // changes. 80-registry.sh is idempotent and performs no provider call.
      "80-registry.sh"
    ];
    const logs = [];
    for (const script of scripts) {
      const path = join14(ctx.roleDir, ".scripts", script);
      if (!existsSync12(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes script is missing: ${path}` };
      }
      const result = spawnSync(path, [], { cwd: ctx.roleDir, env: env2, encoding: "utf8" });
      if (String(result.stdout ?? "").trim()) logs.push(String(result.stdout).trim());
      if (String(result.stderr ?? "").trim()) logs.push(String(result.stderr).trim());
      if (result.error || result.status !== 0) {
        const detail = result.error?.message ?? logs.at(-1) ?? `status ${result.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }
    try {
      const current = readFileSync9(roleManifest, "utf8");
      const document = YAML5.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], selected.systemd ? "required" : "deferred");
      const next = String(document);
      if (next !== current) writeFileSync7(roleManifest, next, "utf8");
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record applied Hermes deployment metadata: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes external effects: ${scripts.join(", ")}${logs.length ? `
${logs.join("\n")}` : ""}`
    };
  }
};

// src/commands/hermes/ApplyDeferredHostEffects.ts
import { existsSync as existsSync13 } from "node:fs";
import { join as join15 } from "node:path";
var ApplyDeferredHostEffects = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (!ctx.deferredExternalEffects) {
      return { success: true, outcome: "unchanged", message: "Hermes host effects use template sequencing" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred host effects" };
    }
    let config;
    ctx.applyingDeferredHostEffects = true;
    try {
      config = await new EnsureTemplateConfig(ctx).invoke();
    } finally {
      ctx.applyingDeferredHostEffects = false;
    }
    if (!config.success) return config;
    const env2 = hardenSubprocessEnvironment(process.env, {
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      SKIP_RUNTIME_REPO: "1",
      SKIP_PLANE: "1",
      SKIP_SYSTEMD: "1"
    });
    scrubTicketProviderCredentials(env2);
    scrubInteractiveChannelCredentials(env2);
    const scripts = ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh"];
    const logs = [];
    for (const script of scripts) {
      const path = join15(ctx.roleDir, ".scripts", script);
      if (!existsSync13(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes host script is missing: ${path}` };
      }
      const result = spawnSync(path, [], { cwd: ctx.roleDir, env: env2, encoding: "utf8" });
      if (String(result.stdout ?? "").trim()) logs.push(String(result.stdout).trim());
      if (String(result.stderr ?? "").trim()) logs.push(String(result.stderr).trim());
      if (result.error || result.status !== 0) {
        const detail = result.error?.message ?? logs.at(-1) ?? `status ${result.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes host effects: ${scripts.join(", ")}${logs.length ? `
${logs.join("\n")}` : ""}`
    };
  }
};

// src/recipes/HermesAgentRecipe.ts
import { resolve as resolve7 } from "node:path";
var HermesAgentRecipe = class extends Recipe {
  checks = createHermesChecks();
  metadata = {
    id: "hermes-agent",
    name: "hermes-agent",
    description: "Add and reconcile a Hermes agent role",
    dependencies: [],
    commands: [
      "EnsureTemplateConfig",
      "PromptForAgentConfig",
      "RunCopierTemplate",
      "UntrackHermesRuntimes",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary"
    ],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  /** Hermes sequencing is fatal/cancel short-circuiting under registry init. */
  async init(ctx, _input) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    const ingredients = [
      EnsureTemplateConfig,
      PromptForAgentConfig,
      RunCopierTemplate,
      UntrackHermesRuntimes,
      WireTelegram,
      WireEmail,
      PrintHermesSummary
    ];
    for (const [ingredientIndex, CommandClass] of ingredients.entries()) {
      if (typeof CommandClass !== "function") {
        throw new TypeError(`Hermes ingredient ${ingredientIndex} is not constructable`);
      }
      const before = ctx.dryRun ? void 0 : snapshotTree(ctx.targetDir);
      const result = await new CommandClass(ctx).invoke();
      const observedChanges = before ? changedTreePaths(ctx.targetDir, before, snapshotTree(ctx.targetDir)) : [];
      let status = result.outcome ?? (result.success ? ctx.dryRun && result.filePath ? "planned" : result.filePath ? "changed" : "unchanged" : "failed");
      if (result.success && !ctx.dryRun && observedChanges.length) status = "changed";
      const declaredChanges = status === "changed" && result.filePath ? [resolve7(ctx.targetDir, result.filePath)] : [];
      const actualChanges = [.../* @__PURE__ */ new Set([...observedChanges, ...declaredChanges])].sort();
      phases.push({ id: CommandClass.name, status, changedFiles: actualChanges, message: result.message || void 0 });
      changedFiles.push(...actualChanges);
      if (result.message) logs.push(result.message);
      if (status === "failed" || status === "cancelled") {
        errors.push(result.message || `${CommandClass.name} ${status}`);
        break;
      }
      if (!ctx.dryRun && CommandClass === RunCopierTemplate && ctx.deferredExternalEffects) {
        const hermesContext2 = ctx;
        const eligibility = hermesContext2.roleDir && hermesContext2.targetRepo && hermesContext2.role && hermesContext2.agentId ? preflightRenderedHermes({
          pjanglerRoot: ctx.pjanglerRoot,
          targetDir: ctx.targetDir,
          roleDir: hermesContext2.roleDir,
          targetRepo: hermesContext2.targetRepo,
          role: hermesContext2.role,
          agentId: hermesContext2.agentId
        }) : { ok: false, error: "Hermes render did not establish role identity" };
        phases.push({
          id: "hermes.rendered-eligibility",
          status: eligibility.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: eligibility.ok ? "Rendered Hermes lifecycle eligibility passed" : eligibility.error
        });
        if (!eligibility.ok) {
          errors.push(`hermes.rendered-eligibility: ${eligibility.error ?? "unknown eligibility failure"}`);
          break;
        }
        const beforeHost = snapshotTree(ctx.targetDir);
        const host = await new ApplyDeferredHostEffects(ctx).invoke();
        const hostChanges = changedTreePaths(ctx.targetDir, beforeHost, snapshotTree(ctx.targetDir));
        phases.push({
          id: "hermes.host-effects",
          status: host.success ? hostChanges.length ? "changed" : "unchanged" : "failed",
          changedFiles: host.success ? hostChanges : [],
          message: host.message || void 0
        });
        changedFiles.push(...hostChanges);
        if (host.message) logs.push(host.message);
        if (!host.success) {
          errors.push(host.message || "Deferred Hermes host effects failed");
          break;
        }
      }
    }
    const commandResult = {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
    if (!commandResult.ok) return commandResult;
    const lifecycle = await this.initializeOwnedChecks(ctx);
    const localResult = mergeInitResults(this.metadata.id, Boolean(ctx.dryRun), [commandResult, lifecycle]);
    if (!localResult.ok || ctx.dryRun) return localResult;
    const hermesContext = ctx;
    if (hermesContext.deferredExternalEffects?.owner !== "hermes") return localResult;
    const selected = hermesContext.deferredExternalEffects;
    if (!selected.runtimeRepo && !selected.ticketBoard && !selected.systemd) return localResult;
    const beforeExternal = snapshotTree(ctx.targetDir);
    const external = await new ApplyDeferredExternalEffects(ctx).invoke();
    const externalChanges = changedTreePaths(ctx.targetDir, beforeExternal, snapshotTree(ctx.targetDir));
    const externalResult = {
      recipeId: this.metadata.id,
      ok: external.success,
      dryRun: false,
      changedFiles: externalChanges,
      logs: external.message ? [external.message] : [],
      errors: external.success ? [] : [external.message || "Deferred Hermes external effects failed"],
      phases: [{
        id: "hermes.external-effects",
        status: external.success ? "changed" : "failed",
        changedFiles: external.success ? externalChanges : [],
        message: external.message || void 0
      }]
    };
    if (!externalResult.ok) return mergeInitResults(this.metadata.id, false, [localResult, externalResult]);
    const findings = this.audit(ctx).filter((finding) => finding.status !== "pass" && finding.status !== "skip");
    const verification = {
      recipeId: this.metadata.id,
      ok: findings.length === 0,
      dryRun: false,
      changedFiles: [],
      logs: [],
      errors: findings.map((finding) => `${finding.id}: ${finding.summary}`),
      phases: [{
        id: "hermes.postcondition-audit",
        status: findings.length ? "failed" : "unchanged",
        changedFiles: [],
        message: findings.length ? "Hermes postcondition audit failed" : "Hermes postcondition audit passed"
      }]
    };
    return mergeInitResults(this.metadata.id, false, [localResult, externalResult, verification]);
  }
  printNextSteps() {
  }
};

// src/recipes/MiseOpInjectRecipe.ts
var MiseOpInjectRecipe = class extends Recipe {
  checks = createMiseOpInjectChecks();
  metadata = {
    id: "mise-op-inject",
    name: "mise-op-inject",
    description: "Canonical .env.op to .env materialization lifecycle",
    dependencies: [],
    commands: ["WireMiseOpInject"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Wired up .env.op 1Password resolution via mise!");
    console.log("   Next steps:");
    console.log("   1. Create .env.op with your op:// secret references");
    console.log("   2. Re-enter the project to run the managed materialization hook");
  }
};

// src/recipes/MiseRecipe.ts
var MiseRecipe = class extends Recipe {
  checks = createMiseChecks();
  metadata = {
    id: "mise",
    name: "mise",
    description: "Mise task runner and environment setup",
    dependencies: ["mise-op-inject"],
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript", "AddMiseCodegraphScript", "AddMiseCodegraphWireScript"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/commands/NodeCommands.ts
var AddPackageJson = class extends Command {
  async invoke() {
    const filePath = "package.json";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  package.json already exists",
        filePath
      };
    }
    const content = `{
  "name": "my-project",
  "version": "1.0.0",
  "description": "A new project",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created package.json",
      filePath
    };
  }
};
var AddReadme = class extends Command {
  async invoke() {
    const filePath = "README.md";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  README.md already exists",
        filePath
      };
    }
    const content = `# My Project

A new project initialized with pjangler.

## Getting Started

1. Install dependencies: \`mise install\`
2. Start development: \`mise run dev\`

## Project Structure

- \`mise.toml\` - Environment configuration
- \`.mise/tasks/\` - Task definitions
- \`src/\` - Source code
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created README.md",
      filePath
    };
  }
};
var AddSrcDirectory = class extends Command {
  async invoke() {
    this.createDirectory("src");
    const indexJsPath = "src/index.js";
    const content = `console.log("Hello, World!");
`;
    this.writeFile(indexJsPath, content);
    return {
      success: true,
      message: "\u2705 Created src/ directory with index.js",
      filePath: "src/index.js"
    };
  }
};

// src/recipes/NodeRecipe.ts
var NodeRecipe = class extends Recipe {
  checks = [];
  metadata = {
    id: "node",
    name: "node",
    description: "Node.js project template",
    dependencies: [],
    commands: ["NodeCommands"],
    publicRuleIds: []
  };
  constructor(context) {
    super(context);
    this.addIngredient(AddPackageJson).addIngredient(AddReadme).addIngredient(AddSrcDirectory);
  }
  init(ctx, _input) {
    return this.invokeIngredients(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/recipes/ProjectRecipe.ts
import { existsSync as existsSync14, readFileSync as readFileSync10, rmSync as rmSync3 } from "node:fs";
import { join as join16 } from "node:path";
var BOOTSTRAP_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Pjangler Lifecycle",
  GIT_AUTHOR_EMAIL: "pjangler@localhost.invalid",
  GIT_COMMITTER_NAME: "Pjangler Lifecycle",
  GIT_COMMITTER_EMAIL: "pjangler@localhost.invalid"
};
var PRODUCTION_RUNTIME = {
  executePlan: executeProjectInitPlan,
  preflightBmad: preflightBmadLifecycle,
  runGit(cwd, args, options) {
    const result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: hardenSubprocessEnvironment(process.env, options?.env)
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error
    };
  }
};
function publicAudit2(report) {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding)
  };
}
function publicMigration2(report) {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result)
  };
}
function hasGitRepository(runtime, targetDir) {
  if (!existsSync14(join16(targetDir, ".git"))) return false;
  return runtime.runGit(targetDir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
}
function refreshPlanFromCanonicalManifest(plan) {
  const manifestPath = join16(plan.project.repo_path, ".project.json");
  const manifest = JSON.parse(readFileSync10(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  const agents = createSafeRecord();
  for (const [agentId, entry] of Object.entries(manifest.agents ?? {})) {
    const rawRole = typeof entry?.role === "string" ? entry.role : "";
    if (!rawRole.trim()) throw new Error(`${manifestPath} agents.${agentId}.role is missing`);
    const role = normalizeAgentRole(rawRole);
    if (Object.hasOwn(agents, role)) throw new Error(`${manifestPath} declares more than one ${role} agent`);
    agents[role] = {
      role,
      role_dir: entry.role_dir,
      provisioning_state: entry.provisioning_state ?? "provisioned"
    };
  }
  const manifestTicket = manifest.ticket_provider;
  if (!manifestTicket || typeof manifestTicket !== "object") {
    throw new Error(`${manifestPath} ticket_provider is missing`);
  }
  const ticketProvider = {
    type: String(manifestTicket.type ?? ""),
    workspace: String(manifestTicket.workspace ?? ""),
    identifier: String(manifestTicket.identifier ?? ""),
    board_id: String(manifestTicket.board_id ?? ""),
    state: manifestTicket.state
  };
  plan.manifest = manifest;
  plan.project.agents = agents;
  plan.project.ticket_provider = ticketProvider;
  for (const action of plan.actions) {
    if (action.kind === "project.write-manifest") action.manifest = manifest;
    if (action.kind === "registry.upsert") action.project = plan.project;
  }
}
var ProjectRecipe = class extends Recipe {
  constructor(runtime = PRODUCTION_RUNTIME) {
    super();
    this.runtime = runtime;
  }
  orchestratesDependencies = true;
  checks = createProjectChecks();
  metadata = {
    id: "project",
    name: "project",
    description: "CommonProject plan, lifecycle composition, audit, and Git boundary",
    dependencies: ["mise", "agent-hooks", "bmad"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  registry;
  attachRegistry(registry) {
    this.registry = registry;
  }
  async init(ctx, input) {
    if (!this.registry) throw new Error("ProjectRecipe is not attached to a RecipeRegistry");
    const normalized = "plan" in input ? input : {
      plan: input,
      mode: input.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync"
    };
    const { plan, mode } = normalized;
    const targetDir = plan.project.repo_path;
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    const targetExistedAtStart = existsSync14(targetDir);
    const transactionContext = {
      ...ctx,
      targetDir,
      repoRoot: targetDir,
      bmadVersionPin: mode === "create" ? BMAD_INSTALLER_VERSION : ctx.bmadVersionPin
    };
    let agentResult;
    let provisionedAgentContext;
    let migrationReport;
    let audit;
    try {
      if (normalized.requireTrustedCopier || normalized.trustedCopier) {
        const trusted = normalized.trustedCopier;
        const verified = trusted ? verifyTrustedCopierIdentity(trusted) : { ok: false, error: "MCP project apply requires a preflight-attested Copier identity" };
        phases.push({
          id: "project.preflight:copier",
          status: verified.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: verified.ok ? "Copier identity revalidated at the project transaction boundary" : `Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`
        });
        if (!verified.ok) {
          errors.push(`Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`);
        }
      }
      if (errors.length === 0 && mode === "create") {
        const preflight = this.runtime.preflightBmad(transactionContext);
        phases.push({
          id: "project.preflight:bmad",
          status: preflight.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: preflight.ok ? "Pinned BMAD installer and sealed pack are available" : preflight.error
        });
        if (!preflight.ok) errors.push(`BMAD preflight failed: ${preflight.error ?? "unknown error"}`);
      }
      const registryActions = plan.actions.filter((action) => action.kind === "registry.upsert");
      const externalPlanActions = plan.actions.filter((action) => action.kind === "ticket-provider.create-or-link");
      const filesystemPlan = {
        ...plan,
        actions: plan.actions.filter((action) => action.kind !== "registry.upsert" && action.kind !== "hermes.provision-agent" && action.kind !== "ticket-provider.create-or-link")
      };
      const planBlocked = errors.length > 0;
      const executed = !planBlocked && filesystemPlan.actions.length ? await this.runtime.executePlan(filesystemPlan, {
        trustedCopier: normalized.trustedCopier,
        requireTrustedCopier: normalized.requireTrustedCopier
      }) : { ok: !planBlocked, plan: filesystemPlan, logs: [], errors: [], changedFiles: [] };
      logs.push(...executed.logs);
      errors.push(...executed.errors);
      changedFiles.push(...executed.changedFiles);
      phases.push({
        id: "project.plan",
        status: planBlocked ? "skipped" : executed.ok ? executed.changedFiles.length ? "changed" : "unchanged" : "failed",
        changedFiles: executed.ok ? executed.changedFiles : [],
        message: planBlocked ? "Project plan skipped after failed preflight" : executed.ok ? "Project plan executed" : executed.errors.join("; ")
      });
      if (errors.length === 0 && executed.ok && mode === "create") {
        const dependencyResult = await this.registry.initDependencies(this.metadata.id, transactionContext, normalized);
        logs.push(...dependencyResult.logs);
        errors.push(...dependencyResult.errors);
        changedFiles.push(...dependencyResult.changedFiles);
        phases.push(...dependencyResult.phases);
      }
      const agentAction = plan.actions.find((action) => action.kind === "hermes.provision-agent" && action.enabled);
      if (errors.length === 0 && agentAction?.kind === "hermes.provision-agent") {
        const agentContext = {
          targetRepo: agentAction.targetRepo,
          role: agentAction.role,
          agentPurpose: `${agentAction.role} agent for ${agentAction.targetRepo}`,
          ticketProvider: plan.project.ticket_provider.type,
          local: agentAction.local,
          force: Boolean(ctx.force),
          skipTelegram: true,
          skipEmail: true,
          skipRuntimeRepo: agentAction.context.skipRuntimeRepo,
          skipPlane: agentAction.context.skipPlane,
          skipBloodbank: agentAction.context.skipBloodbank,
          skipSystemd: agentAction.context.skipSystemd,
          ...normalized.agentContext ?? {},
          targetDir,
          yes: true,
          // Structured callers own stdout and prompt input. Do not allow a
          // nested context object to weaken the transaction's quiet contract.
          quiet: normalized.quiet ?? ctx.quiet ?? false,
          dryRun: false
        };
        provisionedAgentContext = { ...transactionContext, ...agentContext, targetDir, repoRoot: targetDir };
        agentResult = await this.registry.initRecipe(
          "hermes-agent",
          provisionedAgentContext,
          agentContext
        );
        logs.push(...agentResult.logs);
        errors.push(...agentResult.errors);
        changedFiles.push(...agentResult.changedFiles);
        phases.push(...agentResult.phases);
      }
      if (errors.length === 0 && (mode === "create" || agentResult)) {
        const projectLifecycle = await this.initializeOwnedChecks(transactionContext);
        logs.push(...projectLifecycle.logs);
        errors.push(...projectLifecycle.errors);
        changedFiles.push(...projectLifecycle.changedFiles);
        phases.push(...projectLifecycle.phases);
        if (projectLifecycle.ok) {
          try {
            refreshPlanFromCanonicalManifest(plan);
          } catch (error) {
            errors.push(`project manifest refresh failed: ${error instanceof Error ? error.message : String(error)}`);
            phases.push({
              id: "project.manifest-refresh",
              status: "failed",
              changedFiles: [],
              message: errors.at(-1)
            });
          }
        }
      }
      if (errors.length === 0 && normalized.selectedRuleIds?.length) {
        migrationReport = publicMigration2(await this.registry.migrateRules(
          { ...transactionContext, dryRun: false },
          normalized.selectedRuleIds
        ));
        changedFiles.push(...migrationReport.changedFiles);
        phases.push(...migrationReport.results.map((result) => ({
          id: result.id,
          status: result.status === "applied" ? "changed" : result.status === "noop" ? "unchanged" : result.status === "skipped" ? "skipped" : "failed",
          changedFiles: result.status === "applied" ? result.changedFiles : [],
          message: result.summary
        })));
        errors.push(...migrationReport.results.filter((result) => result.status === "blocked").map((result) => `${result.id}: ${result.summary}`));
      }
      const eligibilityAudit = errors.length === 0 ? publicAudit2(this.registry.auditRecipes({ ...transactionContext, dryRun: true })) : void 0;
      audit = eligibilityAudit;
      if (eligibilityAudit && !eligibilityAudit.ok) {
        errors.push(...eligibilityAudit.rules.filter((finding) => finding.status === "fail" || finding.status === "warn").map((finding) => `${finding.id}: ${finding.summary}`));
      }
      phases.push({
        id: "project.audit:eligibility",
        status: eligibilityAudit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: eligibilityAudit?.ok ? "Lifecycle eligibility audit passed before external effects" : "Lifecycle eligibility audit failed or was skipped; external effects remain disabled"
      });
      if (errors.length === 0 && mode === "create") {
        if (hasGitRepository(this.runtime, targetDir)) {
          phases.push({ id: "project.git", status: "unchanged", changedFiles: [], message: "Git repository already initialized" });
        } else {
          const gitPath = join16(targetDir, ".git");
          for (const { args, label, options } of [
            { args: ["init", "--initial-branch=main"], label: "git init" },
            { args: ["add", "-A"], label: "git add" },
            {
              args: ["commit", "--no-gpg-sign", "-m", "chore: initialize project"],
              label: "git commit",
              options: { env: BOOTSTRAP_GIT_IDENTITY }
            }
          ]) {
            const result = this.runtime.runGit(targetDir, args, options);
            if (result.status !== 0) {
              errors.push(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
              phases.push({ id: `project.git:${label}`, status: "failed", changedFiles: changedFiles.includes(gitPath) ? [gitPath] : [], message: errors.at(-1) });
              break;
            }
            if (label === "git init" && existsSync14(gitPath)) changedFiles.push(gitPath);
            logs.push(`${label}: ok`);
          }
          if (errors.length === 0) {
            const repositoryReady = hasGitRepository(this.runtime, targetDir);
            const headReady = repositoryReady && this.runtime.runGit(targetDir, ["rev-parse", "--verify", "HEAD"]).status === 0;
            if (!headReady) {
              errors.push("git postcondition failed: repository or initial commit is missing");
              phases.push({ id: "project.git:postcondition", status: "failed", changedFiles: existsSync14(gitPath) ? [gitPath] : [], message: errors.at(-1) });
            } else {
              if (!changedFiles.includes(gitPath)) changedFiles.push(gitPath);
              phases.push({ id: "project.git", status: "changed", changedFiles: [gitPath], message: "Git repository initialized and committed" });
            }
          }
        }
      }
      const boardEffectArmed = externalPlanActions.some((action) => action.kind === "ticket-provider.create-or-link" && action.enabled);
      if (errors.length === 0 && registryActions.length && !boardEffectArmed) {
        const registryPlan = { ...plan, actions: registryActions };
        const persisted = await this.runtime.executePlan(registryPlan);
        logs.push(...persisted.logs);
        errors.push(...persisted.errors);
        changedFiles.push(...persisted.changedFiles);
        phases.push({
          id: "project.registry",
          status: persisted.ok ? persisted.changedFiles.length ? "changed" : "unchanged" : "failed",
          changedFiles: persisted.ok ? persisted.changedFiles : [],
          message: persisted.ok ? "Project registry persisted" : persisted.errors.join("; ")
        });
      }
      if (errors.length === 0 && externalPlanActions.length) {
        const externalPlan = {
          ...plan,
          actions: boardEffectArmed ? [...externalPlanActions, ...registryActions] : externalPlanActions
        };
        const external = await this.runtime.executePlan(externalPlan);
        logs.push(...external.logs);
        errors.push(...external.errors);
        changedFiles.push(...external.changedFiles);
        phases.push({
          id: "project.external:ticket-provider",
          status: external.ok ? external.changedFiles.length ? "changed" : "unchanged" : "failed",
          changedFiles: external.ok ? external.changedFiles : [],
          message: external.ok ? "Deferred ticket-provider/binding persistence phase completed" : external.errors.join("; ")
        });
      }
      const deferred = provisionedAgentContext?.deferredExternalEffects;
      if (errors.length === 0 && deferred?.owner === "project" && (deferred.runtimeRepo || deferred.ticketBoard || deferred.systemd)) {
        const beforeExternal = snapshotTree(targetDir);
        const external = await new ApplyDeferredExternalEffects(provisionedAgentContext).invoke();
        const externalChanges = changedTreePaths(targetDir, beforeExternal, snapshotTree(targetDir));
        logs.push(...external.message ? [external.message] : []);
        if (!external.success) errors.push(external.message || "Deferred Hermes external effects failed");
        changedFiles.push(...externalChanges);
        phases.push({
          id: "project.external:hermes",
          status: external.success ? "changed" : "failed",
          changedFiles: external.success ? externalChanges : [],
          message: external.message || void 0
        });
      }
      if (errors.length === 0 && (externalPlanActions.length || deferred)) {
        try {
          refreshPlanFromCanonicalManifest(plan);
        } catch (error) {
          errors.push(`project manifest refresh after external effects failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      audit = errors.length === 0 ? publicAudit2(this.registry.auditRecipes({ ...transactionContext, dryRun: true })) : audit;
      if (errors.length === 0 && audit && !audit.ok) {
        errors.push(...audit.rules.filter((finding) => finding.status === "fail" || finding.status === "warn").map((finding) => `${finding.id}: ${finding.summary}`));
      }
      phases.push({
        id: "project.audit",
        status: errors.length === 0 && audit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: errors.length === 0 && audit?.ok ? "Lifecycle postcondition audit passed" : "Lifecycle postcondition audit failed or was skipped"
      });
    } catch (error) {
      errors.push(`project transaction failed: ${error instanceof Error ? error.message : String(error)}`);
      phases.push({
        id: "project.transaction",
        status: "failed",
        changedFiles: [],
        message: errors.at(-1)
      });
    }
    if (errors.length > 0 && mode === "create" && !targetExistedAtStart && existsSync14(targetDir)) {
      try {
        rmSync3(targetDir, { recursive: true, force: true });
        changedFiles.length = 0;
        logs.push(`Rolled back newly-created target: ${targetDir}`);
        phases.push({
          id: "project.rollback",
          status: "changed",
          changedFiles: [],
          message: "Removed the newly-created target after transaction failure"
        });
      } catch (error) {
        errors.push(`fresh-target rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        phases.push({
          id: "project.rollback",
          status: "failed",
          changedFiles: [],
          message: errors.at(-1)
        });
      }
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0 && Boolean(audit?.ok),
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
      plan,
      mode,
      audit,
      selectedOperations: normalized.selectedOperations ?? [],
      selectedParityRules: normalized.selectedRuleIds ?? [],
      migrationReport,
      agentResult
    };
  }
  printNextSteps() {
  }
};

// src/recipes/registry.ts
var RecipeRegistry = class {
  recipes = /* @__PURE__ */ new Map();
  ruleOwners = /* @__PURE__ */ new Map();
  validated = false;
  constructor(recipes = []) {
    for (const recipe of recipes) this.register(recipe);
    if (recipes.length) this.validate();
  }
  register(recipe) {
    if (this.recipes.has(recipe.metadata.id)) throw new Error(`Duplicate recipe id: ${recipe.metadata.id}`);
    const seenLocal = /* @__PURE__ */ new Set();
    for (let index = 0; index < recipe.checks.length; index++) {
      const check = recipe.checks[index];
      if (seenLocal.has(check.id) || this.ruleOwners.has(check.id)) throw new Error(`Duplicate parity rule id: ${check.id}`);
      seenLocal.add(check.id);
      this.ruleOwners.set(check.id, { recipe, checkIndex: index });
    }
    const declared = [...recipe.metadata.publicRuleIds];
    const actual = recipe.checks.map((check) => check.id);
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      throw new Error(`Recipe ${recipe.metadata.id} publicRuleIds do not match its checks`);
    }
    this.recipes.set(recipe.metadata.id, recipe);
    const registryAware = recipe;
    registryAware.attachRegistry?.(this);
    this.validated = false;
    return this;
  }
  validate() {
    for (const recipe of this.recipes.values()) {
      for (const dependency of recipe.metadata.dependencies) {
        if (!this.recipes.has(dependency)) throw new Error(`Unknown dependency ${dependency} for recipe ${recipe.metadata.id}`);
      }
    }
    const visiting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const visit = (id, path) => {
      if (visiting.has(id)) throw new Error(`Recipe dependency cycle: ${[...path, id].join(" -> ")}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const recipe = this.recipes.get(id);
      for (const dependency of recipe.metadata.dependencies) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.recipes.keys()) visit(id, []);
    this.validated = true;
  }
  ensureValid() {
    if (!this.validated) this.validate();
  }
  list() {
    this.ensureValid();
    return [...this.recipes.values()].map((recipe) => recipe.metadata);
  }
  get(recipeId) {
    return this.recipes.get(recipeId);
  }
  ownerOf(ruleId) {
    const owner = this.ruleOwners.get(ruleId);
    if (!owner) return void 0;
    return { recipe: owner.recipe, check: owner.recipe.checks[owner.checkIndex] };
  }
  resolveOrder(recipeId) {
    this.ensureValid();
    if (!this.recipes.has(recipeId)) throw new Error(`Unknown recipe: ${recipeId}`);
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      const recipe = this.recipes.get(id);
      for (const dependency of recipe.metadata.dependencies) visit(dependency);
      seen.add(id);
      ordered.push(recipe);
    };
    visit(recipeId);
    return ordered;
  }
  resolveDependencies(recipeId) {
    return this.resolveOrder(recipeId).filter((recipe) => recipe.metadata.id !== recipeId);
  }
  aggregateInit(recipeId, ctx, results) {
    const selected = results.at(-1) ?? {
      recipeId,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [],
      errors: [],
      phases: []
    };
    return {
      ...selected,
      recipeId,
      ok: results.every((result) => result.ok),
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
      logs: results.flatMap((result) => result.logs),
      errors: results.flatMap((result) => result.errors),
      phases: results.flatMap((result) => result.phases),
      dependencyResults: results.slice(0, -1)
    };
  }
  async initDependencies(recipeId, ctx, input) {
    const results = [];
    for (const dependency of this.resolveDependencies(recipeId)) {
      const result = await dependency.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }
  async initRecipe(recipeId, ctx, input) {
    this.ensureValid();
    const selected = this.recipes.get(recipeId);
    if (!selected) throw new Error(`Unknown recipe: ${recipeId}`);
    if (selected.orchestratesDependencies) return selected.init(ctx, input);
    const results = [];
    for (const recipe of this.resolveOrder(recipeId)) {
      const result = await recipe.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }
  auditRecipes(ctx, recipeIds) {
    this.ensureValid();
    const selected = recipeIds ? recipeIds.map((id) => {
      const recipe = this.recipes.get(id);
      if (!recipe) throw new Error(`Unknown recipe: ${id}`);
      return recipe;
    }) : [...this.recipes.values()];
    const rules = selected.flatMap((recipe) => recipe.audit(ctx).map((finding) => ({ ...finding, recipeId: finding.recipeId ?? recipe.metadata.id })));
    return {
      repo: ctx.repoRoot,
      ok: rules.every((rule) => rule.status === "pass" || rule.status === "skip"),
      auditedAt: (/* @__PURE__ */ new Date()).toISOString(),
      rules
    };
  }
  migrateRules(ctx, ruleIds) {
    this.ensureValid();
    const unknown = ruleIds.filter((id) => !this.ruleOwners.has(id));
    if (unknown.length) throw new Error(`Unknown parity rules: ${unknown.join(", ")}`);
    const results = [];
    for (const id of ruleIds) {
      const owner = this.ruleOwners.get(id);
      try {
        const migrated = owner.recipe.migrate(ctx, [id]);
        results.push(...migrated.map((result) => ({ ...result, recipeId: result.recipeId ?? owner.recipe.metadata.id })));
      } catch (err) {
        const check = owner.recipe.checks[owner.checkIndex];
        results.push({
          id,
          recipeId: owner.recipe.metadata.id,
          title: check.title,
          status: "blocked",
          summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
          changedFiles: [],
          details: []
        });
      }
    }
    return {
      repo: ctx.repoRoot,
      dryRun: Boolean(ctx.dryRun),
      ok: results.every((result) => result.status !== "blocked"),
      selectedRules: [...ruleIds],
      results,
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort()
    };
  }
  migrateAll(ctx) {
    const audit = this.auditRecipes(ctx);
    const ids = audit.rules.filter((rule) => rule.fixable && (rule.status === "fail" || rule.status === "warn")).map((rule) => rule.id);
    return this.migrateRules(ctx, ids);
  }
  listRuleIds() {
    this.ensureValid();
    return [...this.recipes.values()].flatMap((recipe) => recipe.checks.map((check) => check.id));
  }
};

// src/recipes/catalog.ts
var recipeRegistry = new RecipeRegistry([
  new MiseOpInjectRecipe(),
  new MiseRecipe(),
  new AgentHooksRecipe(),
  new BmadRecipe(),
  new DockerRecipe(),
  new NodeRecipe(),
  new HermesAgentRecipe(),
  new ProjectRecipe()
]);

// src/commands/AgentHooksCommands.ts
import { homedir as homedir6 } from "node:os";
import { join as join17, dirname as dirname8 } from "node:path";
import { existsSync as existsSync15, cpSync as cpSync2, mkdirSync as mkdirSync6, readFileSync as readFileSync11, writeFileSync as writeFileSync8 } from "node:fs";
import { fileURLToPath as fileURLToPath5 } from "node:url";
var AGENT_HOOKS_SKIP_MESSAGE = "\u21B7 agent-hooks layer skipped: global ~/.agents/hooks detected (these hooks already run globally).\n   Set PJ_AGENT_HOOKS_LAYER=1 to install the project-scoped layer anyway.";
function resolveTemplateRoot() {
  const candidates = [];
  if (process.env.PJANGLER_COMMONPROJECT_TEMPLATE) {
    candidates.push(process.env.PJANGLER_COMMONPROJECT_TEMPLATE);
  }
  try {
    let dir = dirname8(fileURLToPath5(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join17(dir, "templates", "commonproject", "template"));
      const parent = dirname8(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  candidates.push(join17(homedir6(), "code", "pjangler", "templates", "commonproject", "template"));
  for (const c of candidates) {
    if (existsSync15(join17(c, ".agents", "hooks", "hooks.master.json"))) return c;
  }
  throw new Error(
    "Could not locate the CommonProject template. Set PJANGLER_COMMONPROJECT_TEMPLATE to <repo>/templates/commonproject/template."
  );
}
var CopyAgentHooksTree = class extends Command {
  async invoke() {
    if (!resolveAgentHooksLayer2()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    let templateRoot;
    try {
      templateRoot = resolveTemplateRoot();
    } catch (e) {
      return { success: false, message: `\u26A0\uFE0F  ${e.message}` };
    }
    const items = [
      { rel: ".agents/hooks", dir: true },
      { rel: ".agents/skills.json", dir: false },
      { rel: ".agents/local.example.json", dir: false },
      { rel: ".mise/scripts/hindsight-setup.sh", dir: false }
    ];
    const created = [];
    const skipped = [];
    for (const { rel, dir } of items) {
      const src = join17(templateRoot, rel);
      const dest = join17(this.context.targetDir, rel);
      if (!existsSync15(src)) continue;
      if (existsSync15(dest) && !this.context.force) {
        skipped.push(rel);
        continue;
      }
      if (!this.context.dryRun) {
        mkdirSync6(dirname8(dest), { recursive: true });
        cpSync2(src, dest, { recursive: dir, force: true });
      }
      created.push(rel);
    }
    const verb = this.context.dryRun ? "Would copy" : "Copied";
    const tail = skipped.length ? ` (${skipped.length} already present \u2014 use --force to overwrite)` : "";
    return {
      success: created.length > 0,
      message: this.formatMessage(`\u2705 ${verb} ${created.length} agent-hooks path(s)${tail}`)
    };
  }
};
var WireMiseAgentHooks = class _WireMiseAgentHooks extends Command {
  static MARKER = "# pjangler:agent-hooks";
  static CR = "{{config_root}}";
  // mise's own runtime var — emitted literally
  async invoke() {
    if (!resolveAgentHooksLayer2()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    const misePath = join17(this.context.targetDir, "mise.toml");
    if (!existsSync15(misePath)) {
      return {
        success: false,
        message: "\u26A0\uFE0F  No mise.toml found \u2014 run `pjangler init mise` first, then re-run."
      };
    }
    let content = readFileSync11(misePath, "utf8");
    if (content.includes(_WireMiseAgentHooks.MARKER)) {
      return { success: true, message: this.formatMessage("\u2713 mise.toml already wired for agent-hooks") };
    }
    const cr = _WireMiseAgentHooks.CR;
    const enterAdds = [`  "sync-skills.py --scope project",`, `  "${cr}/.agents/hooks/sync.py --install --quiet",`].join("\n");
    const leaveBlock = [
      "leave = [",
      `  "${cr}/.agents/hooks/sync.py --uninstall --quiet",`,
      "]"
    ].join("\n");
    let wiredHooks = false;
    const enterRe = /(enter\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
    if (enterRe.test(content)) {
      content = content.replace(enterRe, (_m, head, close) => {
        const sep3 = /[,[]\s*$/.test(head) ? "" : ",";
        return `${head}${sep3}
${enterAdds}${close}`;
      });
      const leaveRe = /(leave\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
      if (leaveRe.test(content)) {
        content = content.replace(leaveRe, (_m, head, close) => {
          const sep3 = /[,[]\s*$/.test(head) ? "" : ",";
          return `${head}${sep3}
  "${cr}/.agents/hooks/sync.py --uninstall --quiet",${close}`;
        });
      } else {
        content = content.replace(enterRe, (m) => `${m}
${leaveBlock}`);
      }
      wiredHooks = true;
    }
    const appended = [
      "",
      _WireMiseAgentHooks.MARKER + " (generated \u2014 see .agents/hooks/README.md)",
      // PJAN-61: task names use the colon namespace form. A colon is not legal
      // in a BARE toml key, so every header here MUST stay quoted.
      "[[watch_files]]",
      'patterns = [".agents/skills.json"]',
      'task = "skills:sync"',
      "",
      '[tasks."skills:sync"]',
      'description = "Sync skills from manifest to local CLI dirs"',
      'run = "sync-skills.py --scope project"',
      "",
      "[[watch_files]]",
      'patterns = [".agents/hooks/hooks.master.json"]',
      'task = "hooks:sync"',
      "",
      '[tasks."hooks:sync"]',
      'description = "Fan out hooks.master.json to each agent CLI (claude/codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --install"`,
      "",
      '[tasks."hooks:check"]',
      'description = "Drift gate: verify generated hook configs match hooks.master.json"',
      `run = "${cr}/.agents/hooks/sync.py --check"`,
      "",
      '[tasks."hooks:uninstall"]',
      'description = "Remove per-user agent-hook injections (codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --uninstall"`,
      "",
      '[tasks."hindsight:setup"]',
      `description = "Provision this dev's shared project Hindsight key from 1Password into .env"`,
      `run = "${cr}/.mise/scripts/hindsight-setup.sh"`,
      "",
      _WireMiseAgentHooks.MARKER + ":end",
      ""
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;
    if (!this.context.dryRun) writeFileSync8(misePath, content);
    if (wiredHooks) {
      return { success: true, message: this.formatMessage("\u2705 Wired mise.toml ([hooks] enter/leave + tasks)") };
    }
    return {
      success: true,
      message: this.formatMessage(
        `\u2705 Added agent-hooks tasks to mise.toml.
   \u26A0\uFE0F  Could not find a [hooks].enter array to extend \u2014 add these to your [hooks] block manually:
     enter += "sync-skills.py --scope project", "${cr}/.agents/hooks/sync.py --install --quiet"
     leave += "${cr}/.agents/hooks/sync.py --uninstall --quiet"`
      )
    };
  }
};

// src/commands/AddMiseToml.ts
var AddMiseToml = class extends Command {
  async invoke() {
    const filePath = "mise.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  mise.toml already exists"),
        filePath
      };
    }
    const content = `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create mise.toml" : "\u2705 Created mise.toml"),
      filePath
    };
  }
};

// src/commands/AddMiseBaseToml.ts
var AddMiseBaseToml = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/base.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/base.toml already exists"),
        filePath
      };
    }
    const content = `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "\u2705 Created .mise/tasks/base.toml"),
      filePath
    };
  }
};

// src/commands/AddMiseTasksStructure.ts
var AddMiseTasksStructure = class extends Command {
  async invoke() {
    this.createDirectory(".mise/tasks/scripts");
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise directory structure" : "\u2705 Created .mise directory structure"),
      filePath: ".mise/tasks/scripts"
    };
  }
};

// src/commands/AddMiseBaseScript.ts
var AddMiseBaseScript = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/scripts/base.py";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/scripts/base.py already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env python3
"""Base setup script"""
import os
import sys
from pathlib import Path

def main():
    print("\u{1F527} Setting up base environment...")

    dirs_to_create = ["logs", "temp", "data"]
    for dir_name in dirs_to_create:
        Path(dir_name).mkdir(exist_ok=True)
        print(f"  Created {dir_name}/ directory")

    print("  Base environment setup complete!")
    print("  Run 'mise run dev' to start development")

if __name__ == "__main__":
    main()
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/scripts/base.py" : "\u2705 Created .mise/tasks/scripts/base.py"),
      filePath
    };
  }
};

// src/commands/AddMiseCodegraphScript.ts
import { chmodSync as chmodSync2 } from "fs";
import { join as join18 } from "path";
var AddMiseCodegraphScript = class extends Command {
  async invoke() {
    const filePath = ".mise/scripts/codegraph.sh";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/scripts/codegraph.sh already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env bash
# Auto-generated by pjangler

REPO_ROOT="$(pwd)"
PROJECT_NAME="$(basename "$REPO_ROOT")"
CONTAINER_NAME="codegraph-mcp-$PROJECT_NAME"
CACHE_DIR="$REPO_ROOT/.codegraph"

# Deterministically generate a port based on the repository path
PORT=$(echo -n "$REPO_ROOT" | md5sum | awk '{print $1}' | tr -d 'a-f' | cut -c1-4)
# Ensure port is > 1024
PORT=$(( (PORT % 60000) + 1025 ))

if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
  echo "\u{1F680} Starting CodeGraph MCP Server on port $PORT..."

  # Ensure the container isn't lingering in a stopped state
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  # Run the true Colby McHenry CodeGraph Docker image
  # which we built locally as colbymchenry-codegraph-mcp:latest
  docker run -d \\
    --name "$CONTAINER_NAME" \\
    --restart unless-stopped \\
    -p "$PORT:8045" \\
    -v "$REPO_ROOT:/repo" \\
    colbymchenry-codegraph-mcp:latest >/dev/null

  echo "\u2705 CodeGraph MCP running in background. SSE URL: http://localhost:$PORT/sse"
fi

# Run init inside the container to ensure the index is bootstrapped.
# We run this using the standard codegraph CLI inside the container
docker exec "$CONTAINER_NAME" codegraph init -i /repo >/dev/null 2>&1 || true

# Wire up the MCP server to local agents
WIRE_SCRIPT="$(dirname "$0")/codegraph-wire.sh"
if [ -x "$WIRE_SCRIPT" ]; then
  "$WIRE_SCRIPT"
fi
`;
    this.writeFile(filePath, content);
    if (!this.context.dryRun) {
      chmodSync2(join18(this.context.targetDir, filePath), 493);
    }
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/scripts/codegraph.sh" : "\u2705 Created .mise/scripts/codegraph.sh"),
      filePath
    };
  }
};

// src/commands/AddDotenv.ts
var AddDotenv = class extends Command {
  async invoke() {
    const filePath = ".env";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .env already exists"),
        filePath
      };
    }
    const content = `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .env" : "\u2705 Created .env"),
      filePath
    };
  }
};

// src/commands/WireMiseOpInject.ts
var WireMiseOpInject = class extends Command {
  async invoke() {
    const report = runMigrationForRules(
      ["mise.config-root", "secrets.env-op"],
      this.context.targetDir,
      Boolean(this.context.dryRun)
    );
    const blocked = report.results.filter((result) => result.status === "blocked");
    return {
      success: blocked.length === 0,
      outcome: blocked.length ? "failed" : report.changedFiles.length ? this.context.dryRun ? "planned" : "changed" : "unchanged",
      message: blocked.length ? `\u2717 op-inject lifecycle blocked: ${blocked.map((result) => `${result.id}: ${result.summary}`).join("; ")}` : this.formatMessage(
        `${this.context.dryRun ? "Would wire" : "\u2713 Wired"} atomic .env materialization from .env.op`
      ),
      filePath: report.changedFiles[0]
    };
  }
};

// src/utils/registry.ts
var LEGACY_PUBLIC_RECIPE_IDS = ["mise", "docker", "node", "hermes-agent", "agent-hooks", "mise-op-inject"];
var RECIPE_REGISTRY = Object.freeze(Object.fromEntries(
  LEGACY_PUBLIC_RECIPE_IDS.map((id) => {
    const instance = recipeRegistry.get(id);
    if (!instance) throw new Error(`Production recipe registry is missing ${id}`);
    return [id, Object.freeze({
      name: instance.metadata.name,
      description: instance.metadata.description,
      instance,
      commands: [...instance.metadata.commands]
    })];
  })
));
var COMMAND_REGISTRY = {
  CopyAgentHooksTree: {
    name: "CopyAgentHooksTree",
    description: "Copy the generic agent-hooks tree (hooks SSOT + sync engine + scripts) from the CommonProject template",
    group: "agent-hooks",
    class: CopyAgentHooksTree
  },
  WireMiseAgentHooks: {
    name: "WireMiseAgentHooks",
    description: "Merge agent-hooks enter/leave + tasks into an existing mise.toml (idempotent)",
    group: "agent-hooks",
    class: WireMiseAgentHooks
  },
  AddDockerfile: {
    name: "AddDockerfile",
    description: "Create Dockerfile for containerization",
    group: "docker",
    class: AddDockerfile
  },
  AddDockerCompose: {
    name: "AddDockerCompose",
    description: "Create docker-compose.yml for multi-service setup",
    group: "docker",
    class: AddDockerCompose
  },
  AddDockerignore: {
    name: "AddDockerignore",
    description: "Create .dockerignore file",
    group: "docker",
    class: AddDockerignore
  },
  AddMiseToml: {
    name: "AddMiseToml",
    description: "Create mise.toml for version management",
    group: "mise",
    class: AddMiseToml
  },
  AddMiseBaseToml: {
    name: "AddMiseBaseToml",
    description: "Create base mise configuration",
    group: "mise",
    class: AddMiseBaseToml
  },
  AddMiseTasksStructure: {
    name: "AddMiseTasksStructure",
    description: "Create .mise/tasks directory structure",
    group: "mise",
    class: AddMiseTasksStructure
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddMiseCodegraphScript: {
    name: "AddMiseCodegraphScript",
    description: "Create .mise/scripts/codegraph.sh enter hook",
    group: "mise",
    class: AddMiseCodegraphScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  },
  WireMiseOpInject: {
    name: "WireMiseOpInject",
    description: "Wire up op-inject script to mise.toml for 1Password secret resolution",
    group: "mise",
    class: WireMiseOpInject
  }
};
function getRecipeNames() {
  return Object.keys(RECIPE_REGISTRY);
}
function getRecipeInfo(name) {
  return RECIPE_REGISTRY[name] || null;
}

// src/utils/version.ts
import { readFileSync as readFileSync12 } from "node:fs";
import { dirname as dirname9, join as join19 } from "node:path";
import { fileURLToPath as fileURLToPath6 } from "node:url";
var PJANGLER_VERSION = (() => {
  try {
    let dir = dirname9(fileURLToPath6(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync12(join19(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname9(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return "0.0.0";
})();

// src/describe/index.ts
import { existsSync as existsSync16, readFileSync as readFileSync13, readdirSync as readdirSync6, statSync as statSync4 } from "node:fs";
import { join as join21, resolve as resolve8 } from "node:path";

// src/describe/activity.ts
import { statSync as statSync3 } from "node:fs";
import { join as join20 } from "node:path";
var ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;
var MAX_DIRTY_STATS = 500;
var GIT_TIMEOUT_MS = 5e3;
var GIT_MAX_BUFFER = 16 * 1024 * 1024;
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return void 0;
  return result.stdout;
}
function trimmed(raw) {
  if (raw === void 0) return void 0;
  const value = raw.trim();
  return value === "" ? void 0 : value;
}
function gitLine(repo, args) {
  return trimmed(git(repo, args));
}
function isGitRepo(repo) {
  return gitLine(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
var MINUTE = 60;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var WEEK = 7 * DAY;
var MONTH = 30 * DAY;
var YEAR = 365 * DAY;
function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
function formatRelativeAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < WEEK) return plural(Math.floor(delta / DAY), "day");
  if (delta < MONTH) return plural(Math.floor(delta / WEEK), "week");
  if (delta < YEAR) return plural(Math.floor(delta / MONTH), "month");
  return plural(Math.floor(delta / YEAR), "year");
}
function formatCompactAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}
var REF_ARGS = [
  "for-each-ref",
  "--sort=-committerdate",
  "--format=%(committerdate:unix)%09%(refname:short)",
  "refs/heads",
  "refs/remotes",
  "refs/tags"
];
var WORKTREE_ARGS = ["worktree", "list", "--porcelain"];
var STATUS_ARGS = ["status", "--porcelain", "-z", "--ignore-submodules=dirty"];
function parseRefs(raw) {
  if (raw === void 0) return { count: 0 };
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return { count: 0 };
  const [stamp, name] = lines[0].split("	");
  const unix = Number(stamp);
  if (!Number.isFinite(unix) || unix <= 0) return { count: lines.length };
  return { source: { kind: "ref", label: name ?? "(unnamed ref)", unix }, count: lines.length };
}
function parseWorktrees(raw) {
  if (raw === void 0) return [];
  const entries = [];
  let current = { detached: false };
  const flush = () => {
    if (current.path && current.sha) entries.push({ path: current.path, sha: current.sha, detached: current.detached });
    current = { detached: false };
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.sha = line.slice("HEAD ".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}
function parseWorktreeStamps(raw, entries) {
  if (raw === void 0) return void 0;
  let best;
  for (const line of raw.split("\n")) {
    const [stamp, sha] = line.trim().split(" ");
    const unix = Number(stamp);
    if (!Number.isFinite(unix) || unix <= 0 || !sha) continue;
    if (best && unix <= best.unix) continue;
    const owner = entries.find((entry) => entry.sha === sha);
    const name = owner ? basenameOf(owner.path) : sha.slice(0, 7);
    best = { kind: "worktree", label: owner?.detached ? `${name} (detached)` : name, unix };
  }
  return best;
}
function parseStatusPaths(raw) {
  if (raw === void 0) return [];
  const parts = raw.split("\0").filter((part) => part !== "");
  const paths = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4 || entry[2] !== " ") continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}
function basenameOf(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function uncommittedSource(repo, paths) {
  if (!paths.length) return void 0;
  let newest = 0;
  for (const path of paths.slice(0, MAX_DIRTY_STATS)) {
    try {
      const mtime = Math.floor(statSync3(join20(repo, path)).mtimeMs / 1e3);
      if (mtime > newest) newest = mtime;
    } catch {
    }
  }
  if (newest <= 0) return void 0;
  const label = paths.length === 1 ? "1 uncommitted file" : `${paths.length} uncommitted files`;
  return { kind: "uncommitted", label, unix: newest };
}
var NO_ACTIVITY = {
  updated: null,
  updatedUnix: null,
  relative: "never",
  compact: "\u2014",
  active: false,
  source: null,
  scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 }
};
function emptyActivity() {
  return { ...NO_ACTIVITY, scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 } };
}
function assembleActivity(candidates, scanned, now) {
  let winner = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!winner || candidate.unix >= winner.unix) winner = candidate;
  }
  if (!winner) return { ...NO_ACTIVITY, scanned };
  const nowUnix = Math.floor((now?.getTime() ?? Date.now()) / 1e3);
  const delta = nowUnix - winner.unix;
  return {
    updated: new Date(winner.unix * 1e3).toISOString(),
    updatedUnix: winner.unix,
    relative: formatRelativeAge(delta),
    compact: formatCompactAge(delta),
    active: delta < ACTIVE_WINDOW_SECONDS,
    source: winner,
    scanned
  };
}
function computeRepoActivity(repo, options = {}) {
  if (!isGitRepo(repo)) return emptyActivity();
  const refs = parseRefs(git(repo, REF_ARGS));
  const worktrees = parseWorktrees(git(repo, WORKTREE_ARGS));
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length ? parseWorktreeStamps(git(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees) : void 0;
  const paths = parseStatusPaths(git(repo, STATUS_ARGS));
  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now
  );
}

// src/describe/index.ts
var SUBSYSTEM_MARKERS = {
  "mise-op-inject": [".env.op"],
  mise: ["mise.toml", ".mise.toml", ".mise/config.toml"],
  "agent-hooks": [".agents/skills.json", ".agents/hooks"],
  bmad: ["_bmad"],
  docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  node: ["package.json"],
  "hermes-agent": ["agents/hermes"],
  project: [".project.json"]
};
var LANGUAGE_MARKERS = [
  { file: "package.json", language: "javascript" },
  { file: "pyproject.toml", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "Cargo.toml", language: "rust" },
  { file: "go.mod", language: "go" },
  { file: "pom.xml", language: "jvm" },
  { file: "build.gradle", language: "jvm" },
  { file: "build.gradle.kts", language: "jvm" },
  { file: "Gemfile", language: "ruby" },
  { file: "composer.json", language: "php" }
];
var CONFIG_FILES = [
  { path: ".project.json", purpose: "33GOD project manifest (board binding, agents)", subsystem: "project" },
  { path: ".copier-answers.yml", purpose: "CommonProject render provenance", subsystem: "project" },
  { path: "copier.yml", purpose: "Copier template definition", subsystem: "-" },
  { path: "mise.toml", purpose: "Task runner, env, and enter/leave hooks", subsystem: "mise" },
  { path: ".mise/tasks", purpose: "File-based mise tasks", subsystem: "mise" },
  { path: ".mise/scripts", purpose: "Repo tooling on PATH", subsystem: "mise" },
  { path: ".env.op", purpose: "1Password secret references (materialized to .env)", subsystem: "mise-op-inject" },
  { path: ".env.example", purpose: "Documented environment contract", subsystem: "mise-op-inject" },
  { path: ".agents/skills.json", purpose: "Skillex skill/pack manifest", subsystem: "agent-hooks" },
  { path: ".agents/hooks", purpose: "Project-scoped agent hooks SSOT", subsystem: "agent-hooks" },
  { path: ".claude/settings.json", purpose: "Generated Claude Code hook config", subsystem: "agent-hooks" },
  { path: "_bmad", purpose: "BMAD methodology install", subsystem: "bmad" },
  { path: "_bmad-output", purpose: "BMAD work products", subsystem: "bmad" },
  { path: "AGENTS.md", purpose: "Agent instruction SSOT", subsystem: "-" },
  { path: "agents/hermes", purpose: "Hermes agent roles for this repo", subsystem: "hermes-agent" },
  { path: "Dockerfile", purpose: "Container image definition", subsystem: "docker" },
  { path: "docker-compose.yml", purpose: "Local service composition", subsystem: "docker" },
  { path: "package.json", purpose: "Node package manifest", subsystem: "node" },
  { path: "tsconfig.json", purpose: "TypeScript compiler config", subsystem: "node" },
  { path: "pyproject.toml", purpose: "Python package manifest", subsystem: "-" },
  { path: "Cargo.toml", purpose: "Rust package manifest", subsystem: "-" },
  { path: "go.mod", purpose: "Go module definition", subsystem: "-" },
  { path: ".gitignore", purpose: "Ignore rules", subsystem: "-" },
  { path: ".github/workflows", purpose: "GitHub Actions CI", subsystem: "-" }
];
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync13(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function describeGit(repo, activity) {
  if (!isGitRepo(repo)) return { isRepo: false };
  return {
    isRepo: true,
    branch: gitLine(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: gitLine(repo, ["rev-parse", "--short", "HEAD"]),
    remote: gitLine(repo, ["remote", "get-url", "origin"]),
    dirtyFiles: activity.scanned.dirtyFiles
  };
}
function describeType(repo) {
  const languages = [];
  const roles = [];
  const evidence = [];
  const note2 = (signal, file) => evidence.push(`${signal} (${file})`);
  for (const marker of LANGUAGE_MARKERS) {
    if (!existsSync16(join21(repo, marker.file))) continue;
    if (!languages.includes(marker.language)) {
      languages.push(marker.language);
      note2(marker.language, marker.file);
    }
  }
  try {
    const dotnet = readdirSync6(repo).find((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"));
    if (dotnet && !languages.includes("dotnet")) {
      languages.push("dotnet");
      note2("dotnet", dotnet);
    }
  } catch {
  }
  const pkg = readJson(join21(repo, "package.json"));
  if (pkg) {
    if (existsSync16(join21(repo, "tsconfig.json"))) {
      const index = languages.indexOf("javascript");
      if (index >= 0) languages.splice(index, 1);
      if (!languages.includes("typescript")) {
        languages.unshift("typescript");
        note2("typescript", "tsconfig.json");
      }
    }
    if (pkg.bin) {
      roles.push("cli");
      note2("cli", "package.json#bin");
    }
    if (pkg.workspaces) {
      roles.push("monorepo");
      note2("monorepo", "package.json#workspaces");
    }
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies
    };
    if (Object.keys(dependencies).some((name) => name.startsWith("@modelcontextprotocol/"))) {
      roles.push("mcp-server");
      note2("mcp-server", "package.json#@modelcontextprotocol");
    }
  }
  const roleMarkers = [
    ["copier-template", "copier.yml"],
    ["container-image", "Dockerfile"],
    ["compose-stack", "docker-compose.yml"],
    ["33god-project", ".project.json"],
    ["bmad-project", "_bmad"],
    ["hermes-fleet-host", "agents/hermes"]
  ];
  for (const [role, marker] of roleMarkers) {
    if (!existsSync16(join21(repo, marker))) continue;
    roles.push(role);
    note2(role, marker);
  }
  return { primaryLanguage: languages[0], languages, roles, evidence };
}
function describeIdentity(repo, registryPath2) {
  const manifestPath = join21(repo, ".project.json");
  const manifest = readJson(manifestPath);
  const drift = [];
  let record;
  let registryReadable = true;
  try {
    const registry = loadProjectRegistry(registryPath2);
    const slug = typeof manifest?.project_slug === "string" ? manifest.project_slug : void 0;
    const resolved = resolve8(repo);
    record = (slug ? registry.projects[slug] : void 0) ?? Object.values(registry.projects).find((project) => resolve8(project.repo_path) === resolved);
  } catch (err) {
    registryReadable = false;
    drift.push({ note: `registry unreadable: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (manifest && !record && registryReadable) {
    drift.push({ note: ".project.json exists but this repo is not in the pjangler registry" });
  }
  if (record && !manifest) {
    drift.push({ note: `registered as ${record.slug} but .project.json is missing`, command: "pjangler project doctor" });
  }
  if (record && resolve8(record.repo_path) !== resolve8(repo)) {
    drift.push({ note: `registry repo_path points elsewhere: ${record.repo_path}`, command: "pjangler project doctor" });
  }
  const manifestProvider = manifest?.ticket_provider;
  const provider = manifestProvider ? {
    type: String(manifestProvider.type ?? ""),
    workspace: manifestProvider.workspace,
    identifier: manifestProvider.identifier,
    board_id: manifestProvider.board_id,
    state: manifestProvider.state
  } : record?.ticket_provider;
  if (manifestProvider && record) {
    const fields = [
      ["type", provider?.type, record.ticket_provider.type],
      ["workspace", provider?.workspace, record.ticket_provider.workspace],
      ["identifier", provider?.identifier, record.ticket_provider.identifier],
      ["board_id", provider?.board_id, record.ticket_provider.board_id]
    ];
    for (const [field2, fromManifest, fromRegistry] of fields) {
      if ((fromManifest ?? "") === (fromRegistry ?? "")) continue;
      drift.push({
        note: `ticket_provider.${field2} differs: .project.json has "${fromManifest ?? ""}", registry has "${fromRegistry ?? ""}" \u2014 the manifest is the source of truth, so the registry record needs re-syncing`
      });
    }
  }
  const manifestAgents = manifest?.agents ?? {};
  const agents = record ? Object.entries(record.agents).map(([name, agent]) => ({
    name,
    role: agent.role,
    provisioningState: agent.provisioning_state,
    roleDir: agent.role_dir
  })) : Object.entries(manifestAgents).map(([name, agent]) => ({
    name,
    role: String(agent?.role ?? "unknown"),
    provisioningState: String(agent?.provisioning_state ?? "unknown"),
    roleDir: agent?.role_dir
  }));
  return {
    manifest: Boolean(manifest),
    registered: Boolean(record),
    registryPath: registryPath2,
    slug: record?.slug ?? manifest?.project_slug,
    name: record?.name ?? manifest?.project_name,
    description: record?.description ?? manifest?.project_description,
    ticketProvider: provider ? {
      type: provider.type,
      workspace: provider.workspace,
      identifier: provider.identifier,
      boardId: provider.board_id,
      state: provider.state
    } : void 0,
    agents,
    drift
  };
}
function describeSubsystems(repo, findings) {
  const byRecipe = /* @__PURE__ */ new Map();
  for (const finding of findings) {
    if (!finding.recipeId) continue;
    const bucket = byRecipe.get(finding.recipeId) ?? [];
    bucket.push(finding);
    byRecipe.set(finding.recipeId, bucket);
  }
  return recipeRegistry.list().map((metadata) => {
    const markers = SUBSYSTEM_MARKERS[metadata.id] ?? [];
    const evidence = markers.filter((marker) => existsSync16(join21(repo, marker)));
    const rules = (byRecipe.get(metadata.id) ?? []).map((finding) => ({
      id: finding.id,
      title: finding.title,
      status: finding.status,
      summary: finding.summary,
      fixable: finding.fixable
    }));
    const graded = rules.filter((rule) => rule.status !== "skip");
    const parity = graded.length === 0 ? "unchecked" : graded.every((rule) => rule.status === "pass") ? "ok" : "drift";
    const present = evidence.length > 0;
    const status = !present ? "absent" : parity === "drift" ? "drifted" : "installed";
    return { id: metadata.id, name: metadata.name, description: metadata.description, status, parity, evidence, rules };
  });
}
function describeConfigFiles(repo) {
  return CONFIG_FILES.filter((spec) => existsSync16(join21(repo, spec.path))).map((spec) => ({ path: spec.path, purpose: spec.purpose, subsystem: spec.subsystem }));
}
function describeNextSteps(description, findings) {
  const steps = [];
  if (!description.git.isRepo) {
    steps.push({
      title: "Initialize a git repository",
      reason: "pjangler lifecycle operations and parity rules assume a git work tree",
      source: "lifecycle",
      command: "git init"
    });
  }
  if (!description.identity.manifest) {
    steps.push({
      title: "Register this repo as a 33GOD project",
      reason: "no .project.json \u2014 the board binding and agent roster have nowhere to live",
      source: "lifecycle",
      command: "pjangler init --apply"
    });
  } else if (!description.identity.registered) {
    steps.push({
      title: "Add this project to the pjangler registry",
      reason: ".project.json exists but the central registry has no entry for this repo",
      source: "registry",
      command: `pjangler project init ${description.identity.name ?? ""} --target-dir . --apply`.replace(/\s+/g, " ")
    });
  }
  for (const entry of description.identity.drift) {
    if (entry.note.startsWith(".project.json exists but")) continue;
    steps.push({
      title: "Reconcile project registry drift",
      reason: entry.note,
      source: "registry",
      ...entry.command ? { command: entry.command } : {}
    });
  }
  const failing = findings.filter((finding) => finding.status === "fail" || finding.status === "warn");
  const fixable = failing.filter((finding) => finding.fixable);
  if (fixable.length === 1) {
    const only = fixable[0];
    steps.push({
      title: `Fix ${only.id}`,
      reason: only.summary,
      source: "parity",
      command: `pjangler migrate ${only.id}`,
      rules: [only.id]
    });
  } else if (fixable.length > 1) {
    steps.push({
      title: `Apply ${fixable.length} parity migrations`,
      reason: `${fixable.length} fixable parity rules are failing; migrate --all selects exactly this set`,
      source: "parity",
      command: "pjangler migrate --all",
      rules: fixable.map((finding) => finding.id),
      details: fixable.map((finding) => `${finding.id}: ${finding.summary}`)
    });
  }
  for (const finding of failing) {
    if (finding.fixable) continue;
    steps.push({
      title: `Resolve ${finding.id} manually`,
      reason: `${finding.summary} \u2014 no migration recipe, this one needs hands`,
      source: "parity",
      rules: [finding.id]
    });
  }
  for (const agent of description.identity.agents) {
    if (agent.provisioningState === "provisioned") continue;
    steps.push({
      title: `Provision the ${agent.role} agent`,
      reason: `${agent.name} is ${agent.provisioningState}, not provisioned`,
      source: "agents",
      command: `pjangler hermes-agent --role ${agent.role}`
    });
  }
  return steps;
}
function describeProject(input = {}) {
  const repo = resolve8(input.repoArg ?? process.cwd());
  if (!existsSync16(repo)) throw new Error(`Path does not exist: ${repo}`);
  if (!statSync4(repo).isDirectory()) throw new Error(`Not a directory: ${repo}`);
  const registryPath2 = input.registryPath ?? projectRegistryPath();
  const report = recipeRegistry.auditRecipes(lifecycleContext(repo, true));
  const findings = report.rules;
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const finding of findings) counts[finding.status] += 1;
  const activity = computeRepoActivity(repo, { now: input.now });
  const partial = {
    repo,
    describedAt: report.auditedAt,
    git: describeGit(repo, activity),
    activity,
    type: describeType(repo),
    identity: describeIdentity(repo, registryPath2),
    subsystems: describeSubsystems(repo, findings),
    configFiles: describeConfigFiles(repo),
    parity: { ok: report.ok, counts }
  };
  return { ...partial, nextSteps: describeNextSteps(partial, findings) };
}
var MIN_WIDTH = 60;
var MAX_WIDTH = 120;
var LABEL = 11;
var SUBSYSTEM_STYLE = {
  installed: { glyph: glyph.pass, color: green },
  drifted: { glyph: glyph.warn, color: yellow },
  absent: { glyph: glyph.skip, color: gray }
};
function shortenPath(path, home) {
  const base = home ?? process.env.HOME;
  return base && path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
function section(title, count) {
  return `${bold(title)}${count ? `  ${dim(count)}` : ""}`;
}
function field(label, value) {
  return `  ${dim(padEndRaw(label, LABEL))}${value}`;
}
function padEndRaw(value, width) {
  return value.padEnd(width);
}
function renderDescribe(description, options = {}) {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, options.width ?? 100));
  const { identity, type, git: git2, activity } = description;
  const lines = [""];
  const title = identity.name ?? description.repo.split("/").pop() ?? description.repo;
  const badge = identity.ticketProvider?.identifier ? `  ${cyan(identity.ticketProvider.identifier)}` : "";
  const pulse = activity.updatedUnix ? `${activity.active ? green("\u25CF") : yellow("\u25CB")} ${activity.active ? green(activity.relative) : yellow(activity.relative)}` : dim(`${glyph.skip} never`);
  const left = `  ${bold(title)}${badge}`;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(pulse) - 2);
  lines.push(`${left}${" ".repeat(gap)}${pulse}`);
  if (identity.description) lines.push(`  ${dim(truncateVisible(identity.description, width - 4))}`);
  lines.push(`  ${dim(truncateVisible(shortenPath(description.repo, options.home), width - 4))}`);
  lines.push("");
  const typeFacts = [type.primaryLanguage, ...type.roles].filter(Boolean);
  lines.push(field("type", typeFacts.length ? typeFacts.map((fact) => cyan(fact)).join(dim(" \xB7 ")) : dim("undetermined \u2014 no language or role markers found")));
  if (activity.source) {
    lines.push(field("updated", `${activity.relative} ${dim(`${glyph.dot} ${activity.source.label}`)}`));
  }
  if (identity.ticketProvider) {
    const provider = identity.ticketProvider;
    const board = [provider.type, provider.workspace, provider.identifier].filter(Boolean).join("/");
    lines.push(field("board", `${cyan(board)}${provider.state ? `  ${dim(provider.state)}` : ""}`));
  }
  if (git2.isRepo) {
    const facts = [cyan(git2.branch ?? "?")];
    if (git2.head) facts.push(dim(git2.head));
    facts.push(git2.dirtyFiles ? yellow(`${git2.dirtyFiles} uncommitted`) : green("clean"));
    lines.push(field("git", facts.join(dim(" \xB7 "))));
    if (git2.remote) lines.push(field("remote", dim(truncateVisible(git2.remote, width - LABEL - 4))));
  } else {
    lines.push(field("git", yellow("not a git repository")));
  }
  const registryNote = identity.registered ? green("registered") : yellow("not registered");
  lines.push(field("registry", `${registryNote}  ${dim(shortenPath(identity.registryPath, options.home))}`));
  for (const agent of identity.agents) {
    const state = agent.provisioningState === "provisioned" ? green(agent.provisioningState) : yellow(agent.provisioningState);
    lines.push(field("agent", `${cyan(agent.name)} ${dim(agent.role)}  ${state}`));
  }
  for (const entry of identity.drift) {
    lines.push("");
    for (const [index, wrapped] of wrapVisible(entry.note, width - 6).entries()) {
      lines.push(index === 0 ? `  ${yellow(glyph.warn)} ${wrapped}` : `    ${dim(wrapped)}`);
    }
  }
  lines.push("");
  const present = description.subsystems.filter((subsystem) => subsystem.status !== "absent");
  lines.push(section("Subsystems", `${present.length}/${description.subsystems.length} installed`));
  const nameWidth = description.subsystems.reduce((max, subsystem) => Math.max(max, subsystem.name.length), 0);
  for (const subsystem of description.subsystems) {
    const style = SUBSYSTEM_STYLE[subsystem.status];
    const failing = subsystem.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const detail = subsystem.status === "absent" ? dim(subsystem.description) : failing.length ? yellow(failing.map((rule) => rule.id).join(", ")) : dim(subsystem.evidence.join(", ") || subsystem.description);
    const head = `  ${style.color(style.glyph)} ${style.color(padEndRaw(subsystem.name, nameWidth))}`;
    lines.push(`${head}  ${truncateVisible(detail, Math.max(10, width - nameWidth - 8))}`);
  }
  lines.push("");
  lines.push(section("Config", `${description.configFiles.length} file${description.configFiles.length === 1 ? "" : "s"}`));
  if (!description.configFiles.length) lines.push(`  ${dim("(none found)")}`);
  const pathWidth = description.configFiles.reduce((max, file) => Math.max(max, file.path.length), 0);
  for (const file of description.configFiles) {
    const purpose = truncateVisible(file.purpose, Math.max(10, width - pathWidth - 6));
    lines.push(`  ${cyan(padEndRaw(file.path, pathWidth))}  ${dim(purpose)}`);
  }
  lines.push("");
  const { counts } = description.parity;
  lines.push(`${section("Parity")}  ${[
    counts.pass ? green(`${counts.pass} passed`) : dim("0 passed"),
    counts.fail ? red(`${counts.fail} failed`) : dim("0 failed"),
    counts.warn ? yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`) : dim("0 warnings"),
    dim(`${counts.skip} skipped`)
  ].join(dim(" \xB7 "))}`);
  lines.push("");
  lines.push(section("Next steps", String(description.nextSteps.length)));
  if (!description.nextSteps.length) {
    lines.push(`  ${green(glyph.pass)} ${dim("Nothing pending \u2014 parity is clean and the project is fully registered.")}`);
  }
  for (const [index, step] of description.nextSteps.entries()) {
    lines.push(`  ${cyan(String(index + 1).padStart(2))}  ${bold(step.title)}`);
    const body = step.details?.length ? step.details : [step.reason];
    for (const entry of body) {
      for (const [wrapIndex, wrapped] of wrapVisible(entry, width - 8).entries()) {
        lines.push(`      ${wrapIndex === 0 && step.details?.length ? dim(`${glyph.dot} `) : "  "}${dim(wrapped)}`);
      }
    }
    if (step.command) lines.push(`      ${dim(glyph.pointer)} ${cyan(step.command)}`);
  }
  lines.push("");
  return lines;
}
function formatProjectDescription(description, options = {}) {
  return renderDescribe(description, { width: options.width ?? terminalWidth(), home: options.home }).join("\n");
}

// src/mcp-server.ts
var server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION
});
var TICKET_PROVIDER_SCHEMA = z.enum(["plane", "trello"]);
var BOARD_URL_COMPAT_SCHEMA = z.string().optional().describe("Deprecated compatibility input. Ignored; board URLs are derived at runtime and are never persisted.").meta({ deprecated: true });
function safePathSegmentSchema(label) {
  return z.string().superRefine((value, context) => {
    try {
      validateSafePathSegment(value, label);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
var PROJECT_SLUG_SCHEMA = safePathSegmentSchema("Project slug").describe("A safe single path segment used as the project registry slug.");
var AGENT_ROLE_SCHEMA = safePathSegmentSchema("Agent role").describe("An arbitrary safe single path segment used beneath agents/hermes; not a fixed role enum.");
var TARGET_REPO_SCHEMA = safePathSegmentSchema("Hermes target repository").describe("A safe repository/profile identity segment; defaults to the target directory basename.");
var EXPLICIT_TARGET_DIR_SCHEMA = z.string().refine((value) => value.trim().length > 0, {
  message: "targetDir must be a non-empty explicit path"
});
var INTERACTIVE_RECIPE_IDS = /* @__PURE__ */ new Set(["hermes-agent"]);
var GENERIC_RECIPE_NAMES = getRecipeNames().filter((name) => !INTERACTIVE_RECIPE_IDS.has(name));
if (GENERIC_RECIPE_NAMES.length === 0) throw new Error("No non-interactive recipes are registered for generic MCP execution");
function validateExternalEffectConsent(input, options) {
  const selected = {
    runtimeRepo: input.provisionRuntimeRepo === true,
    ticketBoard: input.provisionTicketBoard === true,
    systemd: input.enableSystemd === true
  };
  const anySelected = selected.runtimeRepo || selected.ticketBoard || selected.systemd;
  if (anySelected && input.live !== true) {
    throw new Error("External Hermes effects require live=true in addition to explicit positive opt-ins");
  }
  if (anySelected && options.requireNonLocal && input.local !== false) {
    throw new Error("External Hermes effects require local=false in addition to live=true and explicit positive opt-ins");
  }
  if (selected.runtimeRepo && input.skipRuntimeRepo === true) {
    throw new Error("provisionRuntimeRepo=true contradicts skipRuntimeRepo=true");
  }
  if (selected.ticketBoard && input.skipPlane === true) {
    throw new Error("provisionTicketBoard=true contradicts skipPlane=true");
  }
  if (selected.systemd && input.skipSystemd === true) {
    throw new Error("enableSystemd=true contradicts skipSystemd=true");
  }
  if (selected.systemd && process.platform === "darwin") {
    throw new Error("enableSystemd=true is unavailable on macOS");
  }
  return selected;
}
function resolveTargetDir(targetDir) {
  const dir = resolve9(targetDir ?? process.cwd());
  if (!existsSync17(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync5(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}
function resolvePjanglerRoot3() {
  let dir = dirname10(fileURLToPath7(import.meta.url));
  while (dir !== dirname10(dir)) {
    if (existsSync17(join22(dir, "package.json")) && existsSync17(join22(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname10(dir);
  }
  throw new Error("Unable to resolve pjangler root");
}
function slugify(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function asText(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}
function publicProjectPlan(plan) {
  return {
    ...plan,
    actions: plan.actions.map((action) => {
      if (action.kind !== "hermes.provision-agent") return action;
      return {
        ...action,
        context: {
          skipRuntimeRepo: action.context.skipRuntimeRepo,
          skipPlane: action.context.skipPlane,
          skipSystemd: action.context.skipSystemd
        }
      };
    })
  };
}
function publicCompositeProjectResponse(payload, plan) {
  const projectedPlan = publicProjectPlan(plan);
  const hasNestedPlan = "plan" in payload;
  const provisionsAgent = plan.actions.some((action) => action.kind === "hermes.provision-agent" && action.enabled);
  return {
    ...payload,
    ...hasNestedPlan ? { plan: projectedPlan } : {},
    ...provisionsAgent ? { bloodbankMode: "fleet-shared" } : {}
  };
}
async function executeRegisteredProjectPlan(plan, agentContext, lifecycleOverrides = {}, trustedCopier) {
  const plannedAgent = plan.actions.find((action) => action.kind === "hermes.provision-agent" && action.enabled);
  const projectInput = {
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    selectedRuleIds: [],
    selectedOperations: plan.actions.map((action) => action.kind),
    trustedCopier,
    requireTrustedCopier: Boolean(
      plan.actions.some((action) => action.kind === "copier.copy.commonproject") || plannedAgent?.kind === "hermes.provision-agent"
    ),
    agentContext: plannedAgent?.kind === "hermes.provision-agent" ? {
      ...agentContext,
      trustedCopier,
      deferredExternalEffects: {
        runtimeRepo: !plannedAgent.context.skipRuntimeRepo,
        ticketBoard: !plannedAgent.context.skipPlane,
        systemd: !plannedAgent.context.skipSystemd,
        owner: "project"
      }
    } : agentContext,
    quiet: true
  };
  return await recipeRegistry.initRecipe(
    "project",
    lifecycleContext(plan.project.repo_path, false, false, {
      ...agentContext,
      ...lifecycleOverrides,
      force: lifecycleOverrides.force ?? agentContext?.force ?? plan.actions.some((action) => action.kind === "copier.copy.commonproject" && action.overwrite),
      live: lifecycleOverrides.live ?? plan.live,
      quiet: lifecycleOverrides.quiet ?? true
    }),
    projectInput
  );
}
function projectPreflightFailure(plan, errors, audit) {
  return {
    recipeId: "project",
    ok: false,
    dryRun: false,
    changedFiles: [],
    logs: [],
    errors: [...errors],
    phases: [{
      id: "project.preflight:lifecycle",
      status: "failed",
      changedFiles: [],
      message: errors.join("; ")
    }],
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    audit,
    selectedOperations: plan.actions.map((action) => action.kind),
    selectedParityRules: []
  };
}
function preflightExistingHermesScaffold(targetDir) {
  if (!existsSync17(join22(targetDir, "agents", "hermes"))) return void 0;
  const owner = recipeRegistry.ownerOf("hermes.pm-scaffold");
  if (!owner) return "Hermes lifecycle owner is unavailable";
  const finding = owner.check.audit(lifecycleContext(targetDir, true));
  if ((finding.status === "fail" || finding.status === "warn") && !finding.fixable) {
    const detail = finding.details.length ? ` (${finding.details.join("; ")})` : "";
    return `${finding.id}: ${finding.summary}${detail}`;
  }
  return void 0;
}
function preflightProjectApply(plan, pjanglerRoot) {
  const createsScaffold = plan.actions.some((action) => action.kind === "copier.copy.commonproject");
  const provisionsAgent = plan.actions.some((action) => action.kind === "hermes.provision-agent" && action.enabled);
  if (!createsScaffold && provisionsAgent) {
    const hermesBlocker = preflightExistingHermesScaffold(plan.project.repo_path);
    if (hermesBlocker) return { failure: projectPreflightFailure(plan, [hermesBlocker]) };
  }
  if (!createsScaffold) {
    const audit = runAudit(plan.project.repo_path);
    const blocking = audit.rules.filter((finding) => {
      if (finding.status === "pass" || finding.status === "skip") return false;
      if (finding.id === "sot.project-json") return false;
      if (provisionsAgent && finding.id.startsWith("hermes.")) return false;
      return true;
    });
    if (blocking.length) {
      return {
        failure: projectPreflightFailure(
          plan,
          blocking.map((finding) => `${finding.id}: ${finding.summary}`),
          audit
        )
      };
    }
  }
  if (createsScaffold || provisionsAgent) {
    const eligibility = preflightMcpLifecycle({
      pjanglerRoot,
      targetDir: plan.project.repo_path,
      commonProject: createsScaffold,
      hermes: provisionsAgent
    });
    if (!eligibility.ok) {
      return {
        failure: projectPreflightFailure(plan, [`Lifecycle preflight failed: ${eligibility.error ?? "unknown eligibility failure"}`])
      };
    }
    if (!eligibility.identity) {
      return {
        failure: projectPreflightFailure(plan, ["Lifecycle preflight failed: Copier attestation returned no executable identity"])
      };
    }
    return { trustedCopier: eligibility.identity };
  }
  return {};
}
function auditSummary(report) {
  const counts = report.rules.reduce((acc, rule) => {
    acc[rule.status] = (acc[rule.status] ?? 0) + 1;
    return acc;
  }, {});
  const nextActions = report.rules.filter((rule) => (rule.status === "fail" || rule.status === "warn") && rule.fixable).map((rule) => `pjangler_migrate_project ${rule.id}`);
  return { counts, nextActions };
}
function migrationSummary(report) {
  const counts = report.results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  return { counts, changedFileCount: report.changedFiles.length };
}
function parityGuidance() {
  return {
    skill: "@33god-projects",
    guidance: "Use these tools before editing a project so the repo SOT, agent files, mise hooks, and Hermes role scaffold are current.",
    workflows: [
      "audit -> pjangler_audit_project",
      "migrate -> pjangler_migrate_project",
      "bootstrap -> pjangler_bootstrap_33god_project",
      "agent provisioning -> pjangler_deploy_hermes_agent"
    ]
  };
}
async function runRecipeWithCapture(recipeName, context) {
  if (!recipeRegistry.get(recipeName)) {
    return {
      success: false,
      logs: [],
      errors: [`Unknown recipe: ${recipeName}. Available: ${getRecipeNames().join(", ")}`]
    };
  }
  try {
    const ctx = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, { ...context, quiet: true });
    const result = await recipeRegistry.initRecipe(recipeName, ctx, {});
    return { success: result.ok, logs: result.logs, errors: result.errors };
  } catch (err) {
    return { success: false, logs: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}
server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes, commands, parity rules, workflows, and @33god-projects tool guidance.",
    inputSchema: z.strictObject({})
  },
  async () => {
    const payload = {
      recipes: Object.values(RECIPE_REGISTRY).filter((r) => !INTERACTIVE_RECIPE_IDS.has(r.name)).map((r) => ({
        name: r.name,
        description: r.description,
        commands: r.commands
      })),
      dedicatedRecipes: [
        {
          name: "hermes-agent",
          description: "Non-interactive Hermes provisioning with explicit local and external-effect consent gates.",
          tool: "pjangler_deploy_hermes_agent"
        }
      ],
      commands: Object.values(COMMAND_REGISTRY).map((c) => ({
        name: c.name,
        description: c.description,
        group: c.group
      })),
      parityRules: getParityRuleIds(),
      recommendedWorkflows: {
        unfamiliarRepo: ["pjangler_describe_project", "pjangler_audit_project"],
        existingProject: ["pjangler_describe_project", "pjangler_audit_project", "pjangler_migrate_project"],
        new33godProject: ["pjangler_project_init", "pjangler_bootstrap_33god_project", "pjangler_audit_project"],
        hermesAgentProvisioning: ["pjangler_deploy_hermes_agent", "pjangler_audit_project"]
      },
      skillSynergy: parityGuidance()
    };
    return asText(payload);
  }
);
server.registerTool(
  "pjangler_list_parity_rules",
  {
    title: "List pjangler parity rules",
    description: "Returns parity rule ids plus brief @33god-projects guidance.",
    inputSchema: z.strictObject({})
  },
  async () => asText({ parityRules: getParityRuleIds(), guidance: parityGuidance() })
);
server.registerTool(
  "pjangler_audit_project",
  {
    title: "Audit project parity",
    description: "Runs pjangler parity audit for a project and returns structured findings with summary counts and next actions.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      json: z.boolean().optional()
    })
  },
  async ({ targetDir, json }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runAudit(resolvedTarget);
      const payload = { ...report, summary: auditSummary(report), guidance: parityGuidance() };
      return asText(json === false ? formatAuditReport(report) : payload);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_migrate_project",
  {
    title: "Migrate project parity",
    description: "Runs one pjangler parity migration rule, or all rules, against a project.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      ruleId: z.string().optional(),
      all: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      acceptRegistryMatches: z.boolean().optional()
    })
  },
  async ({ targetDir, ruleId, all, dryRun, acceptRegistryMatches }) => {
    try {
      const runAll = all ?? false;
      if (!runAll && !ruleId) throw new Error("Either ruleId or all=true is required");
      if (runAll && ruleId) throw new Error("Pass either ruleId or all=true, not both");
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runMigration(ruleId, resolvedTarget, dryRun ?? true, runAll, acceptRegistryMatches ?? false);
      return {
        isError: !report.ok,
        ...asText({
          ok: report.ok,
          repo: report.repo,
          dryRun: report.dryRun,
          selectedRules: report.selectedRules,
          changedFiles: report.changedFiles,
          results: report.results,
          summary: migrationSummary(report)
        })
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_bootstrap_33god_project",
  {
    title: "Bootstrap a new @33god project",
    description: "Create a new CommonProject-based 33god repo with optional non-interactive Hermes provisioning. Preview is the default; each external effect requires live=true plus an explicit positive opt-in.",
    inputSchema: z.strictObject({
      parentDir: z.string().optional(),
      targetDir: z.string().optional(),
      projectName: z.string(),
      projectDescription: z.string().optional(),
      projectSlug: PROJECT_SLUG_SCHEMA.optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      boardId: z.string().optional(),
      boardUrl: BOARD_URL_COMPAT_SCHEMA,
      workspace: z.string().optional(),
      planeWorkspace: z.string().optional(),
      planeProjectId: z.string().optional(),
      projectIdentifier: z.string().optional(),
      primaryLanguage: z.string().optional(),
      skipPlane: z.boolean().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: AGENT_ROLE_SCHEMA.optional(),
      agentPurpose: z.string().optional(),
      local: z.boolean().optional(),
      provisionRuntimeRepo: z.boolean().optional().describe("Explicitly opt in to runtime-repository provisioning; also requires live=true and local=false."),
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true, local=false, and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to systemd installation/enablement; also requires live=true and local=false."),
      force: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      registryPath: z.string().optional(),
      sourceSkill: z.string().optional(),
      live: z.boolean().optional()
    })
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(
        { ...input, skipPlane: input.skipPlane ?? true },
        { requireNonLocal: true }
      );
      const pjanglerRoot = resolvePjanglerRoot3();
      const projectSlug = validateSafePathSegment(input.projectSlug ?? slugify(input.projectName), "Project slug");
      const explicitTargetDir = input.targetDir ? resolve9(input.targetDir) : void 0;
      const parentDir = resolve9(input.parentDir ?? (explicitTargetDir ? dirname10(explicitTargetDir) : process.cwd()));
      if (!existsSync17(parentDir) || !statSync5(parentDir).isDirectory()) throw new Error(`Parent directory does not exist: ${parentDir}`);
      const targetDir = resolveContainedPath(
        parentDir,
        explicitTargetDir ?? join22(parentDir, projectSlug),
        "Bootstrap target"
      );
      const overwrite = input.overwrite ?? input.force ?? false;
      const dryRun = input.dryRun ?? true;
      const local = input.local ?? true;
      const skipPlane = input.skipPlane ?? true;
      const ticketProvider = input.ticketProvider ?? "plane";
      const boardId = input.boardId ?? input.planeProjectId ?? "";
      if (externalEffects.ticketBoard && ticketProvider === "plane" && !boardId) {
        throw new Error("boardId or planeProjectId is required when skipPlane=false for Plane; keep skipPlane=true for safe local bootstrap");
      }
      if (!dryRun && existsSync17(targetDir) && !overwrite) throw new Error(`Target already exists: ${targetDir} (set force/overwrite=true to re-render)`);
      const plan = planProjectInit({
        name: input.projectName,
        description: input.projectDescription,
        targetDir,
        projectSlug,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage ?? "python",
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole ?? "pm",
        apply: !dryRun,
        live: input.live ?? false,
        provisionRuntimeRepo: externalEffects.runtimeRepo,
        provisionTicketBoard: externalEffects.ticketBoard,
        enableSystemd: externalEffects.systemd,
        skipPlane,
        registryPath: input.registryPath,
        projectIdentifier: input.projectIdentifier ?? projectSlug.slice(0, 4).toUpperCase(),
        ticketProvider,
        boardId,
        boardUrl: input.boardUrl,
        boardWorkspace: input.workspace ?? input.planeWorkspace,
        planeWorkspace: input.planeWorkspace ?? "33god",
        planeProjectId: input.planeProjectId,
        pjanglerRoot,
        overwrite
      });
      if (dryRun) {
        return asText(publicCompositeProjectResponse({ ...publicProjectPlan(plan), guidance: parityGuidance() }, plan));
      }
      const preflight = preflightProjectApply(plan, pjanglerRoot);
      if (preflight.failure) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...preflight.failure, ...plan.warnings ? { warnings: plan.warnings } : {}, guidance: parityGuidance() },
            plan
          ))
        };
      }
      const plannedAgent = plan.actions.find((action) => action.kind === "hermes.provision-agent");
      const result = await executeRegisteredProjectPlan(plan, input.provisionAgent ? {
        targetRepo: projectSlug,
        role: input.agentRole ?? "pm",
        agentPurpose: input.agentPurpose ?? `Project manager for ${input.projectName}`,
        local: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.local : local,
        force: overwrite,
        skipTelegram: true,
        skipEmail: true,
        skipRuntimeRepo: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.context.skipRuntimeRepo : true,
        skipPlane: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.context.skipPlane : true,
        skipBloodbank: true,
        skipSystemd: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.context.skipSystemd : true
      } : void 0, {
        force: overwrite,
        live: input.live ?? false,
        quiet: true
      }, preflight.trustedCopier);
      if (!result.ok) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...result, ...plan.warnings ? { warnings: plan.warnings } : {}, guidance: parityGuidance() },
            plan
          ))
        };
      }
      const agentResult = input.provisionAgent ? {
        success: Boolean(result.agentResult?.ok),
        logs: result.agentResult?.logs ?? [],
        errors: result.agentResult?.errors ?? (result.ok ? [] : result.errors)
      } : void 0;
      return asText(publicCompositeProjectResponse(
        { ...result, agentResult, ...plan.warnings ? { warnings: plan.warnings } : {}, guidance: parityGuidance() },
        plan
      ));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_project_init",
  {
    title: "Initialize a pjangler project",
    description: "Plan or apply a registry-backed CommonProject project init. Preview is the default; writes require apply=true and each external effect requires live=true plus an explicit positive opt-in.",
    inputSchema: z.strictObject({
      name: z.string(),
      description: z.string().optional(),
      targetDir: z.string().optional(),
      sourceSkill: z.string().optional(),
      primaryLanguage: z.string().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: AGENT_ROLE_SCHEMA.optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      provisionRuntimeRepo: z.boolean().optional().describe("Explicitly opt in to Hermes runtime-repository provisioning; also requires live=true."),
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to Hermes systemd installation/enablement; also requires live=true."),
      skipPlane: z.boolean().optional().describe("Disable project-board planning and provider invocation even when live=true."),
      slug: PROJECT_SLUG_SCHEMA.optional(),
      identifier: z.string().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      boardId: z.string().optional(),
      boardUrl: BOARD_URL_COMPAT_SCHEMA,
      workspace: z.string().optional(),
      registryPath: z.string().optional(),
      force: z.boolean().optional()
    })
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(input, { requireNonLocal: false });
      const plan = planProjectInit({
        name: input.name,
        description: input.description,
        targetDir: input.targetDir,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage,
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole,
        apply: input.apply ?? false,
        live: input.live ?? false,
        provisionRuntimeRepo: externalEffects.runtimeRepo,
        provisionTicketBoard: externalEffects.ticketBoard,
        enableSystemd: externalEffects.systemd,
        skipPlane: input.skipPlane ?? false,
        projectSlug: input.slug,
        projectIdentifier: input.identifier,
        ticketProvider: input.ticketProvider,
        boardId: input.boardId,
        boardUrl: input.boardUrl,
        boardWorkspace: input.workspace,
        registryPath: input.registryPath,
        force: input.force ?? false,
        overwrite: input.force ?? false,
        scaffold: !(input.targetDir && existsSync17(join22(resolve9(input.targetDir), ".git")))
      });
      if (!input.apply) return asText(publicCompositeProjectResponse(publicProjectPlan(plan), plan));
      const preflight = preflightProjectApply(plan, resolvePjanglerRoot3());
      if (preflight.failure) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...preflight.failure, ...plan.warnings ? { warnings: plan.warnings } : {} },
            plan
          ))
        };
      }
      const result = await executeRegisteredProjectPlan(plan, void 0, {
        force: input.force ?? false,
        live: input.live ?? false,
        quiet: true
      }, preflight.trustedCopier);
      return {
        isError: !result.ok,
        ...asText(publicCompositeProjectResponse(
          { ...result, ...plan.warnings ? { warnings: plan.warnings } : {} },
          plan
        ))
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_project_list",
  {
    title: "List pjangler registry projects",
    description: "Return projects from the pjangler central registry.",
    inputSchema: z.strictObject({
      registryPath: z.string().optional()
    })
  },
  async ({ registryPath: registryPath2 }) => asText(loadProjectRegistry(registryPath2 ?? projectRegistryPath()))
);
server.registerTool(
  "pjangler_project_show",
  {
    title: "Show a pjangler registry project",
    description: "Return one project by slug from the pjangler central registry.",
    inputSchema: z.strictObject({
      slug: PROJECT_SLUG_SCHEMA,
      registryPath: z.string().optional()
    })
  },
  async ({ slug, registryPath: registryPath2 }) => {
    try {
      return asText(getProject(loadProjectRegistry(registryPath2 ?? projectRegistryPath()), slug));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_describe_project",
  {
    title: "Describe a project",
    description: "Reads a repo and returns its detected type, installed pjangler subsystems, config files present, parity counts, and suggested next steps. The orientation call for an agent landing in an unfamiliar repo.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      registryPath: z.string().optional(),
      json: z.boolean().optional()
    })
  },
  async ({ targetDir, registryPath: registryPath2, json }) => {
    try {
      const description = describeProject({
        repoArg: resolveTargetDir(targetDir),
        registryPath: registryPath2 ?? projectRegistryPath()
      });
      return asText(json === false ? formatProjectDescription(description) : description);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_describe_recipe",
  {
    title: "Describe recipe",
    description: "Returns metadata for a specific pjangler recipe.",
    inputSchema: z.strictObject({
      recipe: z.string()
    })
  },
  async ({ recipe }) => {
    const info = getRecipeInfo(recipe);
    if (!info) {
      return {
        isError: true,
        content: [{ type: "text", text: `Recipe not found: ${recipe}` }]
      };
    }
    return asText({
      name: info.name,
      description: info.description,
      commands: info.commands
    });
  }
);
server.registerTool(
  "pjangler_run_recipe",
  {
    title: "Run recipe",
    description: "Preview or apply a non-interactive pjangler recipe against an explicit target directory. Preview is the default; writes require apply=true.",
    inputSchema: z.strictObject({
      recipe: z.enum(GENERIC_RECIPE_NAMES),
      targetDir: EXPLICIT_TARGET_DIR_SCHEMA,
      force: z.boolean().optional(),
      apply: z.boolean().optional()
    })
  },
  async ({ recipe, targetDir, force, apply }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const shouldApply = apply === true;
      const context = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: !shouldApply,
        quiet: true
      };
      const result = await runRecipeWithCapture(recipe, context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe,
          targetDir: resolvedTarget,
          apply: shouldApply,
          dryRun: !shouldApply,
          logs: result.logs,
          errors: result.errors
        })
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
      };
    }
  }
);
server.registerTool(
  "pjangler_deploy_hermes_agent",
  {
    title: "Deploy Hermes agent",
    description: "Preview or apply a non-interactive Hermes agent deployment. Local writes require apply=true. External effects additionally require live=true, local=false, and an explicit positive opt-in for each effect. Bloodbank routing is always fleet-shared.",
    inputSchema: z.strictObject({
      targetDir: EXPLICIT_TARGET_DIR_SCHEMA,
      targetRepo: TARGET_REPO_SCHEMA.optional(),
      role: AGENT_ROLE_SCHEMA,
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      modelBaseUrl: z.string().optional(),
      modelApiMode: z.enum(["", "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse", "codex_app_server"]).optional(),
      modelKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      local: z.boolean().optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      provisionRuntimeRepo: z.boolean().optional().describe("Explicitly opt in to runtime-repository provisioning; requires live=true and local=false."),
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; requires live=true, local=false, and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to systemd installation/enablement; requires live=true, local=false, and skipSystemd!=true."),
      force: z.boolean().optional(),
      skipRuntimeRepo: z.boolean().optional(),
      skipPlane: z.boolean().optional(),
      skipSystemd: z.boolean().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional()
    })
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(input, { requireNonLocal: true });
      const resolvedTarget = resolveTargetDir(input.targetDir);
      const local = input.local ?? true;
      const apply = input.apply === true;
      const live = input.live === true;
      let trustedCopier;
      if (apply) {
        const hermesBlocker = preflightExistingHermesScaffold(resolvedTarget);
        if (hermesBlocker) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: [`Lifecycle preflight failed: ${hermesBlocker}`]
            })
          };
        }
        const eligibility = preflightMcpLifecycle({
          pjanglerRoot: resolvePjanglerRoot3(),
          targetDir: resolvedTarget,
          commonProject: false,
          hermes: true
        });
        if (!eligibility.ok) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: [`Lifecycle preflight failed: ${eligibility.error ?? "unknown eligibility failure"}`]
            })
          };
        }
        if (!eligibility.identity) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: ["Lifecycle preflight failed: Copier attestation returned no executable identity"]
            })
          };
        }
        trustedCopier = eligibility.identity;
      }
      const context = {
        targetDir: resolvedTarget,
        yes: true,
        quiet: true,
        local,
        live,
        targetRepo: input.targetRepo ?? basename6(resolvedTarget),
        role: normalizeAgentRole(input.role),
        agentPurpose: input.agentPurpose,
        soulTone: input.soulTone,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        modelBaseUrl: input.modelBaseUrl,
        modelApiMode: input.modelApiMode,
        modelKeyEnv: input.modelKeyEnv,
        ticketProvider: input.ticketProvider,
        force: input.force ?? false,
        dryRun: !apply,
        // MCP has no prompt-capable Telegram/email inputs. These steps remain
        // unreachable and therefore cannot consume JSON-RPC stdin.
        skipTelegram: true,
        skipEmail: true,
        skipRuntimeRepo: !externalEffects.runtimeRepo,
        skipPlane: !externalEffects.ticketBoard,
        skipBloodbank: true,
        skipSystemd: !externalEffects.systemd || process.platform === "darwin",
        trustedCopier,
        deferredExternalEffects: {
          runtimeRepo: externalEffects.runtimeRepo,
          ticketBoard: externalEffects.ticketBoard,
          systemd: externalEffects.systemd,
          owner: "hermes"
        }
      };
      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe: "hermes-agent",
          targetDir: resolvedTarget,
          apply,
          live,
          bloodbankMode: "fleet-shared",
          guidance: parityGuidance(),
          context: {
            targetRepo: context.targetRepo,
            role: context.role,
            local: context.local,
            dryRun: context.dryRun,
            quiet: context.quiet,
            force: context.force,
            skipRuntimeRepo: context.skipRuntimeRepo,
            skipPlane: context.skipPlane,
            skipSystemd: context.skipSystemd
          },
          logs: result.logs,
          errors: result.errors
        })
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
      };
    }
  }
);
var transport = new StdioServerTransport();
await server.connect(transport);
