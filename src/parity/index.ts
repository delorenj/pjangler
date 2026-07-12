import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, copyFileSync, cpSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { bold, dim, green, red, yellow, gray, glyph, statusStyle, joinDot } from "../utils/style";

export type RuleStatus = "pass" | "fail" | "warn" | "skip";

export interface AuditFinding {
  id: string;
  title: string;
  status: RuleStatus;
  summary: string;
  details: string[];
  fixable: boolean;
}

export interface AuditReport {
  repo: string;
  ok: boolean;
  auditedAt: string;
  rules: AuditFinding[];
}

export interface MigrationRuleResult {
  id: string;
  title: string;
  status: "applied" | "noop" | "blocked" | "skipped";
  summary: string;
  changedFiles: string[];
  details: string[];
}

export interface MigrationReport {
  repo: string;
  dryRun: boolean;
  ok: boolean;
  selectedRules: string[];
  results: MigrationRuleResult[];
  changedFiles: string[];
}

interface RoleMeta {
  role: string;
  roleDir: string;
  roleYamlPath: string;
  repo: string;
  agentId: string;
  profileName: string;
  displayName: string;
  purpose: string;
  botHandle: string;
  runtimeRepo: string;
  runtimeOwner: string;
  planeWorkspace: string;
  ticketProviderName: string;
  ticketProviderBoardId: string;
  ticketProviderIdentifier: string;
  legacyReconcileEnabled: string;
  legacyReconcileGraceHours: string;
  legacyReconcileAutoReview: string;
  legacyScrumGraceHours: string;
  legacyScrumAutoReview: string;
}

interface Context {
  repoRoot: string;
  dryRun: boolean;
  pjanglerRoot: string;
  homeDir: string;
}

interface Rule {
  id: string;
  title: string;
  audit: (ctx: Context) => AuditFinding;
  migrate: (ctx: Context, finding: AuditFinding) => MigrationRuleResult;
}

// mise runs each hook `script`/task `run` value through `sh -c`, expanding the
// `{{config_root}}` tera template first. If the resolved path contains a space
// (e.g. ".../James Brennan/...") an UNQUOTED reference word-splits and fails, so
// every config_root path is wrapped in single quotes. Multiple commands must be
// expressed as an array of `[[hooks.enter]]` tables — mise mangles the
// `enter = [ ... ]` array-of-strings form into one broken argv.
const LINK_AGENTFILES_SCRIPT = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'";
const OP_INJECT_SCRIPT = "op inject -i .env.op > .env";
const CODEGRAPH_SCRIPT =
  "[ -f '{{config_root}}/.mise/scripts/codegraph.sh' ] && '{{config_root}}/.mise/scripts/codegraph.sh' || true";

const HOOKS_COMMENT_HEADER = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.`;

// Canonical managed enter-hook commands, always installed (space-safe).
const LINK_AGENTFILES_HOOK_ENTRIES = [LINK_AGENTFILES_SCRIPT, OP_INJECT_SCRIPT];

const LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
patterns = ["AGENTS.md"]
task = "link-agentfiles"

[tasks.link-agentfiles]
description = "Symlink all agent files to AGENTS.md"
run = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'"`;

const VERSIONING_BLOCK = `# >>> mise-versioning >>>  (managed block — do not edit by hand; re-run init to update)
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

function resolvePjanglerRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Unable to resolve pjangler root");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function readText(path: string): string {
  return normalizeNewlines(readFileSync(path, "utf8"));
}

function safeReadText(path: string): string | null {
  return existsSync(path) ? readText(path) : null;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeText(path: string, content: string): void {
  ensureParent(path);
  writeFileSync(path, content);
}

function tryParseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function slugifyRepoName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isSymlinkTo(path: string, expectedTarget: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) return false;
  try {
    const actual = readlinkSync(path);
    return actual === expectedTarget;
  } catch {
    return false;
  }
}

function readSymlinkTarget(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function ensureSymlink(path: string, target: string, dryRun: boolean): { changed: boolean; blocked?: string } {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const current = readSymlinkTarget(path);
      if (current === target) return { changed: false };
      if (!dryRun) {
        unlinkSync(path);
        symlinkSync(target, path);
      }
      return { changed: true };
    }
    return { changed: false, blocked: `${relative(process.cwd(), path) || path} exists and is not a symlink` };
  }
  if (!dryRun) symlinkSync(target, path);
  return { changed: true };
}

function bootstrapAgentsFile(repoRoot: string, dryRun: boolean): { changedFiles: string[]; details: string[]; blocked?: string } {
  const agentsPath = join(repoRoot, "AGENTS.md");
  if (existsSync(agentsPath)) return { changedFiles: [], details: [] };

  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const source = join(repoRoot, file);
    if (!existsSync(source)) continue;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!dryRun) renameSync(source, agentsPath);
      return { changedFiles: [agentsPath], details: [`Moved ${file} to AGENTS.md before wiring agent-file symlinks`] };
    }
    return { changedFiles: [], details: [], blocked: `${file} exists but is not a regular file; cannot promote to AGENTS.md` };
  }

  const readmePath = join(repoRoot, "README.md");
  if (existsSync(readmePath)) {
    const stat = lstatSync(readmePath);
    if (!stat.isFile()) return { changedFiles: [], details: [], blocked: "README.md exists but is not a regular file; cannot copy to AGENTS.md" };
    if (!dryRun) copyFileSync(readmePath, agentsPath);
    return { changedFiles: [agentsPath], details: ["Copied README.md to AGENTS.md before wiring agent-file symlinks"] };
  }

  return { changedFiles: [], details: [], blocked: "AGENTS.md missing and no CLAUDE.md, GEMINI.md, or README.md source exists" };
}

function yamlGet(text: string, keyPath: string): string {
  const parts = keyPath.split(".");
  const lines = text.split("\n");
  let start = 0;
  let indent = 0;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const key = parts[idx]!;
    let found = false;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const currentIndent = match[1]!.length;
      const currentKey = match[2]!.trim();
      const rest = match[3]!.trim();
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

function discoverRoles(repoRoot: string): RoleMeta[] {
  const rolesDir = join(repoRoot, "agents", "hermes");
  if (!existsSync(rolesDir)) return [];
  return readdirSync(rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const roleDir = join(rolesDir, entry.name);
      const roleYamlPath = join(roleDir, "role.yaml");
      if (!existsSync(roleYamlPath)) return null;
      const text = readText(roleYamlPath);
      const runtimeRepoRaw = yamlGet(text, "runtime.github_repo");
      return {
        role: yamlGet(text, "role") || entry.name,
        roleDir,
        roleYamlPath,
        repo: yamlGet(text, "repo"),
        agentId: yamlGet(text, "agent_id"),
        profileName: yamlGet(text, "profile") || yamlGet(text, "agent_id"),
        displayName: yamlGet(text, "display_name"),
        purpose: yamlGet(text, "purpose"),
        botHandle: yamlGet(text, "telegram.bot_username"),
        runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
        runtimeOwner: yamlGet(text, "runtime.github_owner"),
        planeWorkspace: yamlGet(text, "ticket_provider.workspace") || yamlGet(text, "plane.workspace"),
        ticketProviderName: yamlGet(text, "ticket_provider.name"),
        ticketProviderBoardId: yamlGet(text, "ticket_provider.board_id"),
        ticketProviderIdentifier: yamlGet(text, "plane.identifier"),
        legacyReconcileEnabled: yamlGet(text, "reconcile.enabled"),
        legacyReconcileGraceHours: yamlGet(text, "reconcile.grace_hours"),
        legacyReconcileAutoReview: yamlGet(text, "reconcile.auto_review"),
        legacyScrumGraceHours: yamlGet(text, "scrum_master.grace_hours"),
        legacyScrumAutoReview: yamlGet(text, "scrum_master.auto_review"),
      } satisfies RoleMeta;
    })
    .filter((value): value is RoleMeta => Boolean(value));
}

function registryPath(homeDir: string): string {
  return join(homeDir, ".hermes", "agents-registry.yaml");
}

function fleetEnvPath(homeDir: string): string {
  return join(homeDir, ".hermes", "fleet.env");
}

function systemctlUser(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function relativeRepo(repoRoot: string, path: string): string {
  return relative(repoRoot, path) || ".";
}

function templateScript(ctx: Context, name: string): string | undefined {
  // Shipped in the npm tarball via the package.json files allowlist (PJAN-3);
  // soft-return so a broken install blocks one finding instead of the run.
  const source = join(ctx.pjanglerRoot, ".mise", "scripts", name);
  return existsSync(source) ? readText(source) : undefined;
}

function templateVersioningScript(ctx: Context): string | undefined {
  return templateScript(ctx, "versioning.sh");
}

function templateLinkAgentfilesScript(ctx: Context): string | undefined {
  return templateScript(ctx, "link-agentfiles.sh");
}

/**
 * Resolve whether a generated mise.toml should wire in the project-scoped
 * agent-hooks + skill fan-out layer. Mirrors pjangler's `resolveAgentHooksLayer`
 * (src/project/index.ts): an explicit PJ_AGENT_HOOKS_LAYER override wins; a repo
 * that already carries the hook tree keeps it; otherwise the layer is skipped
 * when a GLOBAL install (~/.agents/hooks) is present, so sync never re-injects the
 * same hooks into the caller's shared per-user CLI configs.
 */
function resolveAgentHooksLayer(ctx: Context): boolean {
  const override = process.env.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  if (existsSync(join(ctx.repoRoot, ".agents", "hooks", "sync.py"))) return true;
  return !existsSync(join(ctx.homeDir, ".agents", "hooks"));
}

/**
 * Evaluate the flat `{% if agent_hooks_layer %}...{% endif %}` conditionals in
 * mise.toml.jinja. Every Jinja statement tag occupies its own line, so we
 * evaluate line-by-line: statement lines are consumed and a block's body is
 * dropped when its condition is falsy. Unknown variables are treated as falsy so
 * an unevaluated (invalid-TOML) Jinja tag can never leak into a generated
 * mise.toml — the root cause of the `TOML parse error ... {%- if
 * agent_hooks_layer %}` crash when the naive renderer only stripped {% raw %}.
 */
function evaluateMiseConditionals(template: string, agentHooksLayer: boolean): string {
  const out: string[] = [];
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

function renderGeneratedProjectMiseToml(ctx: Context, template: string): string {
  const project = readProjectJson(ctx);
  const projectName = String(project?.project_name ?? basename(ctx.repoRoot) ?? "project");
  return evaluateMiseConditionals(template, resolveAgentHooksLayer(ctx))
    .replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1")
    .replace(/\{\{\s*project_name\s*\}\}/g, projectName);
}

function ensureMiseTomlFromTemplate(ctx: Context, changedFiles: string[]): boolean {
  const targetPath = join(ctx.repoRoot, "mise.toml");
  if (existsSync(targetPath)) return false;
  const sourcePath = join(ctx.pjanglerRoot, "templates", "commonproject", "template", "mise.toml.jinja");
  if (!existsSync(sourcePath)) return false;
  changedFiles.push(targetPath);
  if (!ctx.dryRun) {
    writeText(targetPath, renderGeneratedProjectMiseToml(ctx, readText(sourcePath)));
  }
  return true;
}

function templateVersionFilesConf(ctx: Context, repoRoot: string): string {
  const packageJson = join(repoRoot, "package.json");
  return existsSync(packageJson)
    ? "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\njson package.json\ngittag .\n"
    : "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\ngittag .\n";
}

function replaceOrAppendManagedBlock(text: string, startMarker: RegExp, block: string, beforePattern?: RegExp): string {
  if (startMarker.test(text)) {
    return text.replace(/# >>> mise-versioning >>>[\s\S]*?# <<< mise-versioning <<</, block);
  }
  if (beforePattern) {
    const match = text.match(beforePattern);
    if (match && typeof match.index === "number") {
      return `${text.slice(0, match.index).replace(/\s*$/, "\n\n")}${block}\n\n${text.slice(match.index)}`;
    }
  }
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

const BASE_MISE_PATH_ENTRIES = [".mise/scripts", "agents/hermes/pm"];
const CONDITIONAL_HERMES_PATHS = ["agents/hermes/pm/hermes", "agent/hermes/pm/hermes"];

function requiredMisePathEntries(ctx: Context): string[] {
  const required = [...BASE_MISE_PATH_ENTRIES];
  for (const candidate of CONDITIONAL_HERMES_PATHS) {
    if (existsSync(join(ctx.repoRoot, candidate)) && !required.includes(candidate)) required.push(candidate);
  }
  return required;
}

function upsertMisePath(text: string, required = BASE_MISE_PATH_ENTRIES): string {
  const render = (values: string[]) => `_.path = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const envMatch = text.match(/(^|\n)(\[env\][\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!envMatch || typeof envMatch.index !== "number") {
    return `[env]\n${render(required)}\n\n${text.replace(/^\s+/, "")}`;
  }

  const prefix = text.slice(0, envMatch.index + envMatch[1]!.length);
  const section = envMatch[2]!;
  const suffix = text.slice(envMatch.index + envMatch[1]!.length + section.length);
  const pathLine = section.match(/^_\.path\s*=\s*\[([^\]]*)\]\s*$/m);
  if (!pathLine) {
    return `${prefix}${section.replace(/\n?$/, "\n")}${render(required)}${suffix}`;
  }

  const current = [...pathLine[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const merged = [...current];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  const nextLine = render(merged);
  if (pathLine[0] === nextLine) return text;
  return `${prefix}${section.replace(pathLine[0], nextLine)}${suffix}`;
}

function removeTomlSection(text: string, headerPattern: RegExp, marker?: RegExp, options?: { includePrecedingComments?: boolean }): string {
  const lines = text.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!headerPattern.test(lines[i]!)) continue;
    if (marker) {
      let hasMarker = false;
      for (let j = i + 1; j < lines.length && !/^\[[^\]]+\]/.test(lines[j]!); j++) {
        if (marker.test(lines[j]!)) {
          hasMarker = true;
          break;
        }
      }
      if (!hasMarker) continue;
    }
    start = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\[[^\]]+\]/.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    if (end === -1) end = lines.length;
    break;
  }
  if (start === -1) return text;
  // Trailing comment/blank lines directly before the next header belong to that
  // next section (e.g. the `# >>> mise-versioning >>>` marker), so keep them out
  // of the removed range — otherwise re-running a migrate corrupts them.
  while (end > start + 1 && (lines[end - 1]!.trim() === "" || lines[end - 1]!.trim().startsWith("#"))) {
    end--;
  }
  if (options?.includePrecedingComments) {
    while (start > 0 && lines[start - 1]!.trim().startsWith("#")) {
      start--;
    }
  }
  const result = lines.slice(0, start).concat(lines.slice(end)).join("\n");
  return result.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

function insertTomlBlockBeforeVersioning(text: string, block: string): string {
  const versioningIndex = text.indexOf("# >>> mise-versioning >>>");
  if (versioningIndex >= 0) {
    return `${text.slice(0, versioningIndex).replace(/\s*$/, "\n\n")}${block}\n\n${text.slice(versioningIndex)}`;
  }
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

function extractTomlStrings(text: string): string[] {
  const values: string[] = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of text.matchAll(stringPattern)) {
    if (match[1] !== undefined) {
      try {
        values.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        values.push(match[1]);
      }
    } else if (match[2] !== undefined) {
      values.push(match[2]);
    }
  }
  return values;
}

/**
 * Blank out TOML string literals (and any trailing comment) so structural
 * scans can count brackets without being fooled by `[`/`]` that live inside a
 * quoted value — e.g. a hook entry like `"[ -f foo ] && foo || true"`.
 */
function stripTomlStringsAndComments(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/#.*$/, "");
}

function isManagedHookEntry(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === OP_INJECT_SCRIPT) return true;
  // link-agentfiles.sh, with or without wrapping single quotes / path prefix.
  return /link-agentfiles\.sh'?\s*$/.test(trimmed);
}

/**
 * Normalize a preserved hook command so pjangler-managed scripts it references
 * are single-quoted (space-safe). Unknown user commands are kept verbatim.
 */
function normalizeHookScript(script: string): string {
  const trimmed = script.trim();
  if (/codegraph\.sh/.test(trimmed)) return CODEGRAPH_SCRIPT;
  return trimmed;
}

/**
 * Determine the exclusive end line of a (possibly multi-line) TOML value that
 * begins at `start`, counting array brackets outside of string literals so a
 * `]` inside a quoted command can't be mistaken for the array close.
 */
function tomlValueSpanEnd(lines: string[], start: number, limit: number): number {
  let depth = 0;
  let j = start;
  for (; j < limit; j++) {
    for (const ch of stripTomlStringsAndComments(lines[j]!)) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    if (depth <= 0) break;
  }
  return Math.min(j, limit - 1) + 1;
}

/**
 * Remove every mise hook construct from the text — both the `[hooks]` table
 * (with `enter`/`leave` as a string or an array of strings) and any
 * `[[hooks.enter]]`/`[[hooks.leave]]` array-of-tables — and return the stripped
 * text alongside the collected enter/leave commands.
 */
function stripHookBlocks(text: string): { text: string; enter: string[]; leave: string[] } {
  const lines = text.split("\n");
  const enter: string[] = [];
  const leave: string[] = [];
  const drop = new Array<boolean>(lines.length).fill(false);
  const isHeader = (line: string) => /^\[/.test(line.trim());
  // Drop the contiguous comment header directly above a hook construct so a
  // re-run doesn't leave the old header behind and duplicate it.
  const dropPrecedingComments = (idx: number) => {
    for (let k = idx - 1; k >= 0 && !drop[k] && lines[k]!.trim().startsWith("#"); k--) drop[k] = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const tableMatch = /^\[\[\s*hooks\.(enter|leave)\s*\]\]$/.exec(trimmed);
    if (tableMatch) {
      const bucket = tableMatch[1] === "enter" ? enter : leave;
      dropPrecedingComments(i);
      drop[i] = true;
      let j = i + 1;
      // A table body is only its contiguous key=value lines — stop at a blank,
      // comment, or header so trailing lines (e.g. a following versioning
      // marker comment) that belong to the next section are never swallowed.
      for (; j < lines.length; j++) {
        const body = lines[j]!.trim();
        if (body === "" || body.startsWith("#") || isHeader(lines[j]!)) break;
        drop[j] = true;
        const scriptMatch = /^\s*script\s*=\s*(.+)$/.exec(lines[j]!);
        if (scriptMatch) {
          const value = extractTomlStrings(scriptMatch[1]!)[0];
          if (value !== undefined) bucket.push(value);
        }
      }
      i = j - 1;
      continue;
    }
    if (trimmed === "[hooks]") {
      dropPrecedingComments(i);
      let j = i + 1;
      let lastDrop = i; // last line index that is part of the [hooks] table proper
      while (j < lines.length && !isHeader(lines[j]!)) {
        const keyMatch = /^\s*(enter|leave)\s*=/.exec(lines[j]!);
        if (keyMatch) {
          const bucket = keyMatch[1] === "enter" ? enter : leave;
          const end = tomlValueSpanEnd(lines, j, lines.length);
          for (const value of extractTomlStrings(lines.slice(j, end).join("\n"))) bucket.push(value);
          lastDrop = end - 1;
          j = end;
        } else if (/^\s*\]\s*$/.test(lines[j]!)) {
          // Orphan bare-`]` left by a prior buggy run that duplicated the array
          // close — absorb it (self-heal) rather than leaking invalid TOML.
          lastDrop = j;
          j++;
        } else {
          j++;
        }
      }
      // Drop the header through the last key value only; keep trailing
      // comment/blank lines that belong to the following section.
      for (let k = i; k <= lastDrop; k++) drop[k] = true;
      i = j - 1;
      continue;
    }
  }

  const kept = lines
    .filter((_, idx) => !drop[idx])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "\n");
  return { text: kept, enter, leave };
}

function renderHookTables(scripts: string[], kind: "enter" | "leave"): string[] {
  return scripts.map((script) => `[[hooks.${kind}]]\nscript = ${JSON.stringify(script)}`);
}

function dedupePreserve(scripts: string[]): string[] {
  const out: string[] = [];
  for (const script of scripts) {
    if (script && !out.includes(script)) out.push(script);
  }
  return out;
}

function upsertLinkAgentfilesHooks(text: string): string {
  const { text: stripped, enter, leave } = stripHookBlocks(text);
  const preservedEnter = enter.map(normalizeHookScript).filter((script) => !isManagedHookEntry(script));
  const enterScripts = dedupePreserve([...LINK_AGENTFILES_HOOK_ENTRIES, ...preservedEnter]);
  const leaveScripts = dedupePreserve(leave.map(normalizeHookScript));

  const block = [
    HOOKS_COMMENT_HEADER,
    ...renderHookTables(enterScripts, "enter"),
    ...renderHookTables(leaveScripts, "leave"),
  ].join("\n");
  return insertTomlBlockBeforeVersioning(stripped, block);
}

function upsertLinkAgentfilesBlock(text: string, ctx: Context): string {
  const withPath = upsertMisePath(text, requiredMisePathEntries(ctx));
  // Remove stale AGENTS-linking pieces before appending the canonical block.
  let cleaned = removeTomlSection(withPath, /^\[tasks\.link-agentfiles\]$/, /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /AGENTS\.md/, { includePrecedingComments: false });
  cleaned = upsertLinkAgentfilesHooks(cleaned);
  return insertTomlBlockBeforeVersioning(cleaned, LINK_AGENTFILES_WATCH_TASK_BLOCK);
}

function readProjectJson(ctx: Context): Record<string, unknown> | null {
  return tryParseJson(safeReadText(join(ctx.repoRoot, ".project.json")));
}

function roleAgentsMap(roles: RoleMeta[]): Record<string, { role: string; role_dir: string }> {
  return Object.fromEntries(
    roles
      .filter((role) => role.agentId)
      .map((role) => [role.agentId, { role: role.role, role_dir: relativeRepo(role.roleDir.startsWith("/") ? dirname(dirname(dirname(role.roleDir))) : process.cwd(), role.roleDir) }])
  );
}

function boolSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function numberSetting(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function canonicalProjectJson(ctx: Context): Record<string, unknown> {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = String(existing.project_slug ?? slugifyRepoName(dirname(ctx.repoRoot) === ctx.repoRoot ? ctx.repoRoot.split("/").pop() ?? "project" : ctx.repoRoot.split("/").pop() ?? "project"));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    state: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.state ?? (firstRole?.ticketProviderBoardId ? "linked" : "planned")) || "planned"),
  };
  if (ticketProvider.board_id && ticketProvider.state === "planned") ticketProvider.state = "linked";
  const existingAgents = (existing.agents as Record<string, { role?: string; role_dir?: string; provisioning_state?: string }> | undefined) ?? {};
  const discoveredAgents: Record<string, { role: string; role_dir: string }> = Object.fromEntries(
    roles.map((role) => [
      role.agentId || `${slug}-${role.role}`,
      {
        role: role.role,
        role_dir: relative(ctx.repoRoot, role.roleDir),
      },
    ])
  );
  const agents = { ...existingAgents } as Record<string, { role: string; role_dir?: string; provisioning_state?: string }>;
  for (const [agentId, discovered] of Object.entries(discoveredAgents)) {
    const existingAgent = existingAgents[agentId] ?? {};
    agents[agentId] = {
      role: discovered.role,
      role_dir: discovered.role_dir,
      provisioning_state: existingAgent.provisioning_state,
    };
  }
  const existingAutomation = (existing.automation as Record<string, unknown> | undefined) ?? {};
  const existingReconcile = (existingAutomation.reconcile as Record<string, unknown> | undefined) ?? {};
  const legacyEnabled = roles.find((role) => role.legacyReconcileEnabled)?.legacyReconcileEnabled;
  const legacyGrace = roles.find((role) => role.legacyReconcileGraceHours || role.legacyScrumGraceHours);
  const legacyAutoReview = roles.find((role) => role.legacyReconcileAutoReview || role.legacyScrumAutoReview);
  const automation = {
    ...existingAutomation,
    reconcile: {
      enabled: boolSetting(existingReconcile.enabled, boolSetting(legacyEnabled, false)),
      grace_hours: numberSetting(existingReconcile.grace_hours, numberSetting(legacyGrace?.legacyReconcileGraceHours || legacyGrace?.legacyScrumGraceHours, 0)),
      auto_review: boolSetting(existingReconcile.auto_review, boolSetting(legacyAutoReview?.legacyReconcileAutoReview || legacyAutoReview?.legacyScrumAutoReview, true)),
    },
  };
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_slug: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents,
    automation,
  };
}

function projectJsonFinding(ctx: Context): AuditFinding {
  const projectPath = join(ctx.repoRoot, ".project.json");
  const planeJsonPath = join(ctx.repoRoot, ".plane.json");
  const details: string[] = [];
  const data = readProjectJson(ctx);
  const roles = discoverRoles(ctx.repoRoot);
  if (!existsSync(projectPath)) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json missing", details: [], fixable: true };
  }
  if (!data) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json is not valid JSON", details: [], fixable: true };
  }
  for (const key of ["project_name", "project_description", "project_slug", "repo_path", "ticket_provider", "agents", "automation"]) {
    if (!(key in data)) details.push(`missing key: ${key}`);
  }
  if (data.repo_path !== ctx.repoRoot) details.push(`repo_path should be ${ctx.repoRoot}`);
  const agents = (data.agents as Record<string, unknown> | undefined) ?? {};
  for (const role of roles) {
    const agent = agents[role.agentId] as Record<string, unknown> | undefined;
    if (!agent) {
      details.push(`agents.${role.agentId} missing`);
      continue;
    }
    if (agent.role !== role.role) details.push(`agents.${role.agentId}.role should be ${role.role}`);
    if (agent.role_dir !== relative(ctx.repoRoot, role.roleDir)) {
      details.push(`agents.${role.agentId}.role_dir should be ${relative(ctx.repoRoot, role.roleDir)}`);
    }
  }
  const ticketProvider = (data.ticket_provider as Record<string, unknown> | undefined) ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id", "state"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if ("board_url" in ticketProvider) details.push("ticket_provider.board_url should be removed; derive it from provider/workspace/board_id");
  if (!ticketProvider.board_id && roles.some((role) => role.ticketProviderBoardId)) {
    details.push("ticket_provider.board_id missing even though legacy role.yaml contains a board binding");
  }
  const automation = (data.automation as Record<string, unknown> | undefined) ?? {};
  const reconcile = (automation.reconcile as Record<string, unknown> | undefined) ?? {};
  for (const key of ["enabled", "grace_hours", "auto_review"]) {
    if (!(key in reconcile)) details.push(`automation.reconcile.${key} missing`);
  }
  if (existsSync(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
  return {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: details.length === 0 ? "pass" : "fail",
    summary: details.length === 0 ? ".project.json matches canonical parity contract" : `${details.length} parity issue(s) detected`,
    details,
    fixable: true,
  };
}

function renderSoul(role: RoleMeta): string {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm"
    ? "Direct and brief. Decision-forward. No throat-clearing, no apologies, no \"I'll help you with that\" preambles."
    : "Direct and brief.";
  const roleSpecific = role.role === "pm"
    ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checkpoints your runtime; when this repo opts into reconciliation (\`automation.reconcile.enabled\` in repo-root \`.project.json\`), the same heartbeat also runs your continuous board-reconciliation pass out-of-band (\`.scripts/sentinel.prompt.md\`, \`--source cron\`), kept separate from your interactive session memory.`
    : `You operate as the ${role.role} agent for this repo.`;
  const runtimeOwner = role.runtimeOwner || "delorenj";
  return `# ${role.displayName || role.agentId}\n\nYou are **${role.displayName || role.agentId}** — a Hermes agent provisioned to work inside the\n\`${role.repo}\` repository.\n\n## Identity\n\n| | |\n| --- | --- |\n| Agent ID | \`${role.agentId}\` |\n| Profile | \`${role.profileName || role.agentId}\` |\n| Repo | \`${role.repo}\` |\n| Role | \`${role.role}\` |\n| Telegram | \`${telegram}\` |\n| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |\n\n## Scope\n\nYou operate only within the working directory of \`${role.repo}\`. Your HERMES_HOME is the runtime submodule at \`./runtime/\` (repo \`${runtimeOwner}/${role.runtimeRepo}\`), which \`~/.hermes/profiles/${role.profileName || role.agentId}\` symlinks to (so \`--profile\` invocations resolve here too); Hermes loads its \`config.yaml\` directly. Secrets, SOUL, memories, skills, sessions, gateway state, and runtime files all live local to that runtime.\n\n## Tone\n\n${tone}\n\n## Role-specific behavior\n\n${roleSpecific}\n\n## Memory hygiene\n\nYour memory is the submodule at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.\n`;
}

function renderHermesWrapper(role: RoleMeta): string {
  return `#!/usr/bin/env bash
# Launcher for ${role.agentId}. Resolves HERMES_HOME to the runtime submodule.

set -euo pipefail

ROLE_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_HOME="$ROLE_DIR/runtime"

FLEET_ENV="{HERMES_FLEET_ENV:-$HOME/.hermes/fleet.env}"
if [[ -f "$FLEET_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$FLEET_ENV"
fi

HERMES_BIN="{HERMES_BIN:-{HERMES_FLEET_BIN:-/home/delorenj/code/hermes-agent/.venv/bin/hermes}}"
HERMES_OAUTH_FILE="{HERMES_OAUTH_FILE:-{HERMES_FLEET_OAUTH_FILE:-$HOME/.hermes/auth.json}}"
CODEX_HOME="{CODEX_HOME:-{HERMES_FLEET_CODEX_HOME:-$HOME/.codex}}"

FLEET_HOME="{HERMES_FLEET_HOME:-$HOME/.hermes}"
PROFILE_NAME="{HERMES_PROFILE_NAME:-${role.profileName || role.agentId}}"
HERMES_HOME="$RUNTIME_HOME"

if [[ ! -d "$RUNTIME_HOME" ]]; then
  echo "hermes: runtime submodule not initialized at $RUNTIME_HOME" >&2
  echo "  fix: git submodule update --init --recursive" >&2
  exit 1
fi

exec env HERMES_HOME="$HERMES_HOME" HERMES_FLEET_ENV="$FLEET_ENV" \
  HERMES_OAUTH_FILE="$HERMES_OAUTH_FILE" CODEX_HOME="$CODEX_HOME" \
  "$HERMES_BIN" "$@"
`.replace(/\u0010/g, "$" );
}

function copyMissingRecursive(sourceDir: string, targetDir: string, changedFiles: string[], dryRun: boolean, skip?: (source: string) => boolean): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function upsertSubmodule(repoRoot: string, role: RoleMeta, changedFiles: string[], dryRun: boolean): string[] {
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const repoName = role.runtimeRepo || `agent-hm-${role.repo}-${role.role}`;
  const owner = role.runtimeOwner || "delorenj";
  const block = `[submodule "agents/hermes/${role.role}/runtime"]\n\tpath = agents/hermes/${role.role}/runtime\n\turl = git@github.com:${owner}/${repoName}.git\n`;
  const current = safeReadText(gitmodulesPath) ?? "";
  const header = `[submodule "agents/hermes/${role.role}/runtime"]`;
  if (current.includes(header)) return [];
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, `${current.replace(/\s*$/, "")}${current.trim() ? "\n" : ""}${block}`);
  return [gitmodulesPath];
}

function upsertRegistryEntry(role: RoleMeta, homeDir: string, changedFiles: string[], dryRun: boolean): string | null {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const block = `  ${role.agentId}:\n    repo: ${role.repo}\n    role: ${role.role}\n    display_name: ${JSON.stringify(role.displayName || role.agentId)}\n    project_path: ${ctxEscape(role.roleDir ? dirname(dirname(dirname(role.roleDir))) : "")}\n    role_dir: ${ctxEscape(role.roleDir)}\n    profile_name: ${role.profileName || role.agentId}\n    telegram:\n      bot_username: ${ctxEscape(role.botHandle)}\n    plane:\n      workspace: ${ctxEscape(role.planeWorkspace)}\n      project_id: ${ctxEscape(role.ticketProviderBoardId)}\n      identifier: ${ctxEscape(role.ticketProviderIdentifier)}\n    runtime_repo: ${ctxEscape(role.runtimeRepo)}\n    systemd:\n      gateway_unit: hermes-${role.agentId}-gateway.service\n      consumer_unit: hermes-${role.agentId}-consumer.service\n      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer\n`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:\n${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}

function profileMetaInheritsDefault(path: string): boolean {
  const text = safeReadText(path);
  return Boolean(
    text &&
      /^config:\s*$/m.test(text) &&
      /^\s+inherit_from:\s*default\s*$/m.test(text) &&
      /^\s+save_mode:\s*delta\s*$/m.test(text)
  );
}

function upsertInheritedProfileMeta(path: string, changedFiles: string[], dryRun: boolean): string | null {
  const current = safeReadText(path) ?? "";
  const lines = current.split("\n");
  let next: string;
  const start = lines.findIndex((line) => /^config:\s*$/.test(line));

  if (!current.trim()) {
    next = "config:\n  inherit_from: default\n  save_mode: delta\n";
  } else if (start === -1) {
    next = `${current.replace(/\s*$/, "\n")}config:\n  inherit_from: default\n  save_mode: delta\n`;
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

    const inserts: string[] = [];
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

function ctxEscape(value: string): string {
  return JSON.stringify(value || "");
}

function checkUnit(unit: string): { enabled: boolean; active: boolean } {
  const enabled = systemctlUser(["is-enabled", unit]).ok;
  const active = systemctlUser(["is-active", unit]).ok;
  return { enabled, active };
}

// ---------------------------------------------------------------------------
// BMAD version helpers (shared by bmad.scaffold + bmad.version)
// ---------------------------------------------------------------------------

const BMAD_NPM_PACKAGE = "bmad-method";
// pjangler always installs the `next` channel, so parity == what a fresh
// install yields today. Change this one constant to retarget the whole toolchain.
const BMAD_TARGET_CHANNEL = "next";
const BMAD_DIST_TAGS_TTL_MS = 60 * 60 * 1000; // 1h — mirrors the starship BMAD indicator cache

// The tool matrix installed alongside the BMAD modules. Kept in one place so the
// scaffold-install and version-upgrade paths never drift apart.
const BMAD_INSTALL_TOOLS = [
  "claude-code", "codex", "cursor", "github-copilot", "adal", "antigravity-cli",
  "auggie", "goose", "cline", "codebuddy", "codewhale", "command-code", "crush",
  "droid", "firebender", "gemini", "antigravity", "hermes", "bob", "iflow",
  "junie", "kilo", "kimi-code", "kiro", "kode", "mistral-vibe", "mux", "neovate",
  "ona", "openclaw", "opencode", "openhands", "pi", "pochi", "qoder", "qwen",
  "replit", "roo", "rovo-dev", "cortex", "amp", "trae", "warp", "windsurf", "zencoder",
];

function bmadInstallArgs(repoRoot: string): string[] {
  return [
    "-y",
    `${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL}`,
    "install",
    "--yes",
    "--directory",
    repoRoot,
    "--modules",
    "bmm,bmb,cis",
    "--tools",
    BMAD_INSTALL_TOOLS.join(","),
  ];
}

/** Run the non-interactive BMAD installer/upgrader against `repoRoot`. */
function runBmadInstall(repoRoot: string): { ok: boolean; error?: string } {
  const result = spawnSync("npx", bmadInstallArgs(repoRoot), { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.error?.message || "Unknown error" };
  }
  return { ok: true };
}

/** Read `installation.version` from a repo's `_bmad/_config/manifest.yaml`. */
function readInstalledBmadVersion(repoRoot: string): string | undefined {
  const raw = safeReadText(join(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return undefined;
  try {
    const parsed = YAML.parse(raw) as { installation?: { version?: unknown } } | undefined;
    const version = parsed?.installation?.version;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

interface BmadDistTagsCache {
  fetchedAt: number;
  distTags: Record<string, string>;
}

function bmadCachePath(homeDir: string): string {
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join(homeDir, ".cache");
  return join(cacheRoot, "pjangler", "bmad-dist-tags.json");
}

function readBmadDistTagsCache(homeDir: string): BmadDistTagsCache | undefined {
  const raw = safeReadText(bmadCachePath(homeDir));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BmadDistTagsCache;
    if (parsed && typeof parsed.fetchedAt === "number" && parsed.distTags && typeof parsed.distTags === "object") {
      return parsed;
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

function fetchBmadDistTags(): Record<string, string> | undefined {
  const result = spawnSync("npm", ["view", BMAD_NPM_PACKAGE, "dist-tags", "--json"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    // `npm view <pkg> dist-tags --json` returns the tags object directly on some
    // npm versions and a one-element array of it on others — normalize both.
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") return undefined;
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === "string") tags[key] = value;
    }
    return Object.keys(tags).length ? tags : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve BMAD dist-tags, preferring a <1h cache so `pj audit` stays fast and
 * offline-tolerant. On a cache miss it queries npm and repopulates the cache; if
 * npm is unreachable it falls back to a stale cache (flagged), else `undefined`
 * so the caller degrades to a `skip` finding rather than failing the audit.
 */
function resolveBmadDistTags(homeDir: string): { distTags: Record<string, string>; stale: boolean } | undefined {
  const cached = readBmadDistTagsCache(homeDir);
  if (cached && Date.now() - cached.fetchedAt < BMAD_DIST_TAGS_TTL_MS) {
    return { distTags: cached.distTags, stale: false };
  }

  const fetched = fetchBmadDistTags();
  if (fetched) {
    try {
      const path = bmadCachePath(homeDir);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), distTags: fetched } satisfies BmadDistTagsCache, null, 2));
    } catch {
      /* cache write is best-effort */
    }
    return { distTags: fetched, stale: false };
  }

  if (cached) return { distTags: cached.distTags, stale: true };
  return undefined;
}

/**
 * Compare two BMAD versions (semver with an optional `-next.N` prerelease).
 * Returns <0 if a<b, 0 if equal, >0 if a>b. A prerelease sorts below its release
 * (`6.10.1-next.12` < `6.10.1`) per semver precedence rules.
 */
function compareBmadVersions(a: string, b: string): number {
  const parse = (v: string): { nums: [number, number, number]; pre: string } => {
    const [core = "0", pre = ""] = v.replace(/^v/, "").split("-", 2);
    const parts = core.split(".");
    const n = (i: number) => parseInt(parts[i] ?? "0", 10) || 0;
    return { nums: [n(0), n(1), n(2)], pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is the release, b is a prerelease
  if (!pb.pre) return -1; // a is a prerelease, b is the release
  const ida = pa.pre.split(".");
  const idb = pb.pre.split(".");
  for (let i = 0; i < Math.max(ida.length, idb.length); i++) {
    const xa = ida[i];
    const xb = idb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
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

const RULES: Rule[] = [
  {
    id: "mise.config-root",
    title: "mise config_root + AGENTS link hooks",
    audit: (ctx) => {
      const misePath = join(ctx.repoRoot, "mise.toml");
      if (!existsSync(misePath)) {
        return { id: "mise.config-root", title: "mise config_root + AGENTS link hooks", status: "fail", summary: "mise.toml missing", details: [], fixable: true };
      }
      const text = readText(misePath);
      const details: string[] = [];
      const linkAgentfilesPath = join(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      if (!existsSync(linkAgentfilesPath)) details.push(".mise/scripts/link-agentfiles.sh missing");
      const pathValues = [...(text.match(/^_\.path\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      const missingPathValues = requiredMisePathEntries(ctx).filter((value) => !pathValues.includes(value));
      if (missingPathValues.length) details.push(`[env]._.path should include ${missingPathValues.join(", ")}`);
      if (!text.includes("'{{config_root}}/.mise/scripts/link-agentfiles.sh'")) details.push("link-agentfiles hook must use single-quoted {{config_root}} guard");
      if (!text.includes("op inject -i .env.op > .env")) details.push("hooks.enter must materialize .env from .env.op");
      if (!text.includes("patterns = [\"AGENTS.md\"]")) details.push("watch_files must monitor AGENTS.md");
      if (!text.includes("task = \"link-agentfiles\"")) details.push("watch_files must dispatch link-agentfiles task");
      return {
        id: "mise.config-root",
        title: "mise config_root + AGENTS link hooks",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "mise AGENTS-linking parity verified" : `${details.length} issue(s) detected in mise AGENTS-linking contract`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const path = join(ctx.repoRoot, "mise.toml");
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (!existsSync(path)) {
        if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
        }
        details.push("Initialized mise.toml from generated-project template");
        if (ctx.dryRun) {
          return { id: finding.id, title: finding.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
        }
      }
      let text = readText(path);
      const next = upsertLinkAgentfilesBlock(text, ctx);
      if (next !== text) {
        if (!changedFiles.includes(path)) changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, next);
        text = next;
      }
      const linkAgentfilesPath = join(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      const expectedScript = templateLinkAgentfilesScript(ctx);
      if (expectedScript === undefined) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/link-agentfiles.sh — update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(linkAgentfilesPath) !== expectedScript) {
        changedFiles.push(linkAgentfilesPath);
        if (!ctx.dryRun) {
          writeText(linkAgentfilesPath, expectedScript);
          chmodSync(linkAgentfilesPath, 0o755);
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
        changedFiles,
        details: changedFiles.length ? ["Normalized hooks/watch_files/tasks.link-agentfiles block and script"] : [],
      };
    },
  },
  {
    id: "mise.versioning",
    title: "managed mise versioning block",
    audit: (ctx) => {
      const details: string[] = [];
      const misePath = join(ctx.repoRoot, "mise.toml");
      const versioningPath = join(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const manifestPath = join(ctx.repoRoot, ".mise", "version-files.conf");
      const text = safeReadText(misePath);
      if (!text?.includes("# >>> mise-versioning >>>")) details.push("mise versioning managed block missing");
      if (!existsSync(versioningPath)) details.push(".mise/scripts/versioning.sh missing");
      if (!existsSync(manifestPath)) details.push(".mise/version-files.conf missing");
      return {
        id: "mise.versioning",
        title: "managed mise versioning block",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "mise versioning parity verified" : `${details.length} versioning issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const misePath = join(ctx.repoRoot, "mise.toml");
      if (!existsSync(misePath)) {
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
      const versioningPath = join(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const expectedScript = templateVersioningScript(ctx);
      if (expectedScript === undefined) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/versioning.sh — update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(versioningPath) !== expectedScript) {
        changedFiles.push(versioningPath);
        if (!ctx.dryRun) {
          writeText(versioningPath, expectedScript);
          chmodSync(versioningPath, 0o755);
        }
      }
      const manifestPath = join(ctx.repoRoot, ".mise", "version-files.conf");
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
        details: [],
      };
    },
  },
  {
    id: "sot.agent-symlinks",
    title: "AGENTS/CLAUDE/GEMINI symlink contract",
    audit: (ctx) => {
      const agentsPath = join(ctx.repoRoot, "AGENTS.md");
      if (!existsSync(agentsPath)) {
        const fallbackSources = ["CLAUDE.md", "GEMINI.md", "README.md"].filter((file) => existsSync(join(ctx.repoRoot, file)));
        if (fallbackSources.length === 0) {
          return { id: "sot.agent-symlinks", title: "AGENTS/CLAUDE/GEMINI symlink contract", status: "skip", summary: "AGENTS.md missing; symlink contract not applicable", details: [], fixable: false };
        }
        return {
          id: "sot.agent-symlinks",
          title: "AGENTS/CLAUDE/GEMINI symlink contract",
          status: "fail",
          summary: "AGENTS.md missing but can be derived from existing project documentation",
          details: [`AGENTS.md can be created from ${fallbackSources[0]}`],
          fixable: true,
        };
      }
      const details: string[] = [];
      for (const file of ["CLAUDE.md", "GEMINI.md"]) {
        const full = join(ctx.repoRoot, file);
        const target = readSymlinkTarget(full);
        if (target !== "AGENTS.md") details.push(`${file} should be a symlink to AGENTS.md`);
      }
      return {
        id: "sot.agent-symlinks",
        title: "AGENTS/CLAUDE/GEMINI symlink contract",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Agent documentation symlinks are in parity" : `${details.length} symlink issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const blockedDetails: string[] = [];
      const bootstrap = bootstrapAgentsFile(ctx.repoRoot, ctx.dryRun);
      changedFiles.push(...bootstrap.changedFiles);
      details.push(...bootstrap.details);
      if (bootstrap.blocked) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "AGENTS.md missing; cannot derive canonical agent file", changedFiles, details: [bootstrap.blocked] };
      }
      for (const file of ["CLAUDE.md", "GEMINI.md"]) {
        const full = join(ctx.repoRoot, file);
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
        details: [...details, ...blockedDetails],
      };
    },
  },
  {
    id: "sot.project-json",
    title: "Canonical .project.json",
    audit: projectJsonFinding,
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const path = join(ctx.repoRoot, ".project.json");
      const existing = readProjectJson(ctx) ?? {};
      const canonical = canonicalProjectJson(ctx);
      // Merge: canonical keys win, but preserve any extra keys the user added
      const merged = { ...existing, ...canonical };
      const expected = `${JSON.stringify(merged, null, 2)}\n`;
      if (safeReadText(path) !== expected) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, expected);
      }
      const planeJson = join(ctx.repoRoot, ".plane.json");
      if (existsSync(planeJson)) {
        const backup = `${planeJson}.migrated-backup`;
        if (existsSync(backup)) {
          details.push(`cannot back up .plane.json because ${relative(ctx.repoRoot, backup)} already exists`);
        } else {
          changedFiles.push(backup);
          if (!ctx.dryRun) renameSync(planeJson, backup);
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.length ? "blocked" : changedFiles.length ? "applied" : "noop",
        summary: details.length ? "Project SOT partially blocked" : changedFiles.length ? "Canonical .project.json written" : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "secrets.env-op",
    title: ".env.op + gitignore secrets contract",
    audit: (ctx) => {
      const details: string[] = [];
      const envOp = safeReadText(join(ctx.repoRoot, ".env.op"));
      const gitignore = safeReadText(join(ctx.repoRoot, ".gitignore"));
      if (!envOp) {
        details.push(".env.op missing");
      } else {
        const invalidLines = envOp
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#") && line.includes("="))
          .filter((line) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
        if (invalidLines.length) details.push(`.env.op has non-reference values that do not look like safe literals: ${invalidLines.join(", ")}`);
      }
      if (!gitignore?.includes(".env\n") && !gitignore?.includes(".env\r\n")) details.push(".gitignore should ignore .env");
      if (!gitignore?.includes(".env.*")) details.push(".gitignore should ignore .env.*");
      if (!gitignore?.includes("!.env.op")) details.push(".gitignore should unignore .env.op");
      return {
        id: "secrets.env-op",
        title: ".env.op + gitignore secrets contract",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Secret reference file and ignore rules are in parity" : `${details.length} env parity issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const envOpPath = join(ctx.repoRoot, ".env.op");
      if (!existsSync(envOpPath)) {
        changedFiles.push(envOpPath);
        if (!ctx.dryRun) writeText(envOpPath, readText(join(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op")));
      }
      const gitignorePath = join(ctx.repoRoot, ".gitignore");
      const gitignore = safeReadText(gitignorePath) ?? "";
      const requiredBlock = `# Secrets — .env is materialized by \`op inject -i .env.op > .env\` on mise enter.\n# NEVER commit it. .env.op holds only 1Password references or safe literals and IS committed.\n.env\n.env.*\n!.env.op\n`;
      if (!gitignore.includes("!.env.op") || !gitignore.includes(".env.*")) {
        changedFiles.push(gitignorePath);
        if (!ctx.dryRun) writeText(gitignorePath, `${gitignore.replace(/\s*$/, "")}${gitignore.trim() ? "\n\n" : ""}${requiredBlock}`);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.length ? "blocked" : changedFiles.length ? "applied" : "noop",
        summary: details.length ? "Manual cleanup still required" : changedFiles.length ? "Wrote .env.op/gitignore parity files" : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "provenance.copier",
    title: ".copier-answers.yml provenance + drift report",
    audit: (ctx) => {
      const details: string[] = [];
      const path = join(ctx.repoRoot, ".copier-answers.yml");
      const text = safeReadText(path);
      const project = readProjectJson(ctx);
      if (!text) {
        details.push(".copier-answers.yml missing");
      } else {
        if (!text.startsWith("# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY")) details.push("missing Copier overwrite warning header");
        if (!text.includes("_src_path:")) details.push("_src_path missing");
        if (project?.project_name) {
          const nameMatch = text.match(/project_name:\s*(.+)/);
          if (!nameMatch || nameMatch[1]?.trim() !== String(project.project_name)) details.push("project_name drift between .copier-answers.yml and .project.json");
        }
        if (project?.project_description) {
          const descMatch = text.match(/project_description:\s*([\s\S]*?)(?=\n\w|$)/);
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
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const project = canonicalProjectJson(ctx);
      const text = `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY\n_src_path: ${join(ctx.pjanglerRoot, "templates", "commonproject")}\nproject_description: ${String(project.project_description)}\nproject_name: ${String(project.project_name)}\nticket_provider: ${String(((project.ticket_provider as Record<string, unknown>)?.type ?? "plane"))}\n`;
      const path = join(ctx.repoRoot, ".copier-answers.yml");
      if (safeReadText(path) !== text) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, text);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Copier provenance file refreshed" : "No changes required",
        changedFiles,
        details: [],
      };
    },
  },
  {
    id: "bmad.scaffold",
    title: "BMAD modules/docs scaffold",
    audit: (ctx) => {
      const targetRoot = join(ctx.repoRoot, "_bmad");
      const sentinels = [
        join("core", "config.yaml"),
        join("config.toml"),
        join("_config", "manifest.yaml"),
        join("bmm", "config.yaml"),
      ];
      const missing = sentinels.filter((file) => !existsSync(join(targetRoot, file)));
      return {
        id: "bmad.scaffold",
        title: "BMAD modules/docs scaffold",
        status: missing.length === 0 ? "pass" : "fail",
        summary: missing.length === 0 ? "BMAD scaffold parity verified" : `${missing.length} BMAD sentinel file(s) missing`,
        details: missing.map((file) => `_bmad/${file}`),
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      if (ctx.dryRun) {
        for (const detail of finding.details) {
          changedFiles.push(join(ctx.repoRoot, detail));
        }
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Would run non-interactive bmad-method install" : "No changes required",
          changedFiles,
          details: [
            `Would run: npx ${bmadInstallArgs(ctx.repoRoot).join(" ").replace(BMAD_INSTALL_TOOLS.join(","), "...")}`,
          ],
        };
      }

      const install = runBmadInstall(ctx.repoRoot);
      if (!install.ok) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: `Failed to run bmad-method install`,
          changedFiles: [],
          details: [install.error ?? "Unknown error"],
        };
      }

      for (const detail of finding.details) {
        if (existsSync(join(ctx.repoRoot, detail))) {
          changedFiles.push(join(ctx.repoRoot, detail));
        }
      }

      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Installed BMAD scaffold via non-interactive installer" : "No changes required",
        changedFiles,
        details: [],
      };
    },
  },
  {
    id: "bmad.version",
    title: "BMAD version currency",
    audit: (ctx) => {
      const installed = readInstalledBmadVersion(ctx.repoRoot);
      if (!installed) {
        // Absence / unreadable manifest is bmad.scaffold's concern, not ours.
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "skip",
          summary: existsSync(join(ctx.repoRoot, "_bmad"))
            ? "BMAD installed but version manifest unreadable"
            : "No BMAD install present",
          details: [],
          fixable: false,
        };
      }

      const resolved = resolveBmadDistTags(ctx.homeDir);
      const available = resolved?.distTags?.[BMAD_TARGET_CHANNEL];
      if (!available) {
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "skip",
          summary: `BMAD ${installed} installed; latest ${BMAD_TARGET_CHANNEL} version unknown (npm unreachable)`,
          details: [`Could not resolve ${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL} from npm`],
          fixable: false,
        };
      }

      const staleNote = resolved!.stale ? `  ${glyph.dot} cached` : "";
      if (compareBmadVersions(installed, available) >= 0) {
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "pass",
          summary: `BMAD ${installed} is current (${BMAD_TARGET_CHANNEL} ${available})${staleNote}`,
          details: [],
          fixable: false,
        };
      }

      return {
        id: "bmad.version",
        title: "BMAD version currency",
        status: "warn",
        summary: `BMAD ${installed} is behind ${BMAD_TARGET_CHANNEL} ${available} — upgrade available`,
        details: [
          `installed: ${installed}`,
          `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
          resolved!.distTags.latest ? `stable latest: ${resolved!.distTags.latest}` : "",
          "run `pj migrate bmad.version` to upgrade",
        ].filter(Boolean),
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      // Only upgrade on a real drift. skip/pass -> noop keeps `migrate --all`
      // cheap and never triggers a full re-install when BMAD is current/absent.
      if (finding.status !== "warn") {
        return {
          id: finding.id,
          title: finding.title,
          status: "noop",
          summary: finding.status === "skip" ? finding.summary : "BMAD already current",
          changedFiles: [],
          details: [],
        };
      }

      const installed = readInstalledBmadVersion(ctx.repoRoot);
      const available = resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
      const manifestPath = join(ctx.repoRoot, "_bmad", "_config", "manifest.yaml");

      if (ctx.dryRun) {
        return {
          id: finding.id,
          title: finding.title,
          status: "applied",
          summary: `Would upgrade BMAD ${installed ?? "?"} -> ${available ?? BMAD_TARGET_CHANNEL}`,
          changedFiles: [manifestPath],
          details: [
            `Would run: npx ${bmadInstallArgs(ctx.repoRoot).join(" ").replace(BMAD_INSTALL_TOOLS.join(","), "...")}`,
          ],
        };
      }

      const install = runBmadInstall(ctx.repoRoot);
      if (!install.ok) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Failed to upgrade BMAD via installer",
          changedFiles: [],
          details: [install.error ?? "Unknown error"],
        };
      }

      const nowInstalled = readInstalledBmadVersion(ctx.repoRoot);
      const upgraded = Boolean(nowInstalled && installed && compareBmadVersions(nowInstalled, installed) > 0);
      return {
        id: finding.id,
        title: finding.title,
        status: upgraded ? "applied" : "noop",
        summary: upgraded ? `Upgraded BMAD ${installed} -> ${nowInstalled}` : `BMAD reinstalled (${nowInstalled ?? "?"})`,
        changedFiles: upgraded ? [manifestPath] : [],
        details: [],
      };
    },
  },
  {
    id: "hermes.pm-scaffold",
    title: "Hermes PM scaffold parity",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      const role = roles.find((item) => item.role === "pm");
      if (!role) {
        return { id: "hermes.pm-scaffold", title: "Hermes PM scaffold parity", status: "skip", summary: "No pm role present", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const rel of ["role.yaml", "SOUL.md", "hermes", ".gitignore", ".scripts/70-systemd.sh", ".scripts/heartbeat.sh", ".scripts/checkpoint.sh", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md", "runtime/bloodbank-consumer.py"]) {
        if (!existsSync(join(role.roleDir, rel))) details.push(`missing ${relative(ctx.repoRoot, join(role.roleDir, rel))}`);
      }
      const gitmodules = safeReadText(join(ctx.repoRoot, ".gitmodules")) ?? "";
      if (!gitmodules.includes(`agents/hermes/${role.role}/runtime`)) details.push(".gitmodules missing pm runtime submodule entry");
      if (!profileMetaInheritsDefault(join(role.roleDir, "runtime", "profile.yaml"))) {
        details.push("runtime/profile.yaml missing inherited default config metadata");
      }
      const registry = safeReadText(registryPath(ctx.homeDir));
      if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
      return {
        id: "hermes.pm-scaffold",
        title: "Hermes PM scaffold parity",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "PM scaffold parity verified" : `${details.length} PM scaffold issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const role = discoverRoles(ctx.repoRoot).find((item) => item.role === "pm");
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (!role) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No pm role present", changedFiles, details: [] };
      }
      const templateRoleDir = join(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      writeIfDifferent(join(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
      writeIfDifferent(join(role.roleDir, "hermes"), renderHermesWrapper(role), ctx.dryRun, changedFiles, 0o755);
      writeIfDifferent(join(role.roleDir, ".gitignore"), readText(join(templateRoleDir, ".gitignore.jinja")).replace(/\{\{ role \}\}/g, role.role), ctx.dryRun, changedFiles);
      copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join(templateRoleDir, ".scripts"), join(role.roleDir, ".scripts"), changedFiles, ctx.dryRun, (source) => source.endsWith("sentinel.prompt.md.jinja"));
      // Render the heartbeat sentinel prompt (copyMissingRecursive skips the .jinja).
      const promptSource = join(templateRoleDir, ".scripts", "sentinel.prompt.md.jinja");
      const promptTarget = join(role.roleDir, ".scripts", "sentinel.prompt.md");
      if (existsSync(promptSource) && !existsSync(promptTarget)) {
        const prompt = readText(promptSource)
          .replace(/\{\{ agent_id \}\}/g, role.agentId)
          .replace(/\{\{ role \}\}/g, role.role)
          .replace(/\{\{ target_repo \}\}/g, role.repo)
          .replace(/\{\{ display_name \}\}/g, role.displayName || role.agentId);
        writeIfDifferent(promptTarget, prompt, ctx.dryRun, changedFiles);
      }
      upsertSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
      const profileMetaUpdated = upsertInheritedProfileMeta(join(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
      if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
      const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
      if (registryUpdated) details.push(`updated ${registryUpdated}`);
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "PM scaffold normalized" : "No changes required",
        changedFiles,
        details,
      };
    },
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
          fixable: false,
        };
      }
      const details: string[] = [];
      for (const role of roles) {
        const roleRelDir = relative(ctx.repoRoot, role.roleDir);
        const runtimeRelPath = join(roleRelDir, "runtime");

        // 1. Check if tracked in git
        const lsResult = spawnSync("git", ["ls-files", "--stage", runtimeRelPath], {
          cwd: ctx.repoRoot,
          encoding: "utf8",
        });
        if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
          details.push(`submodule runtime is tracked in Git index at ${runtimeRelPath}`);
        }

        // 2. Check if .gitignore ignores runtime/
        const gitignorePath = join(role.roleDir, ".gitignore");
        if (existsSync(gitignorePath)) {
          const content = safeReadText(gitignorePath) ?? "";
          const lines = content.split(/\r?\n/).map((line) => line.trim());
          if (!lines.includes("runtime/") && !lines.includes("runtime")) {
            details.push(`.gitignore missing runtime/ ignore entry in ${relative(ctx.repoRoot, gitignorePath)}`);
          }
        } else {
          details.push(`.gitignore is missing in ${relative(ctx.repoRoot, gitignorePath)}`);
        }
      }

      return {
        id: "hermes.untracked-runtimes",
        title: "Hermes agent runtimes untracked + gitignored",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "All Hermes agent runtimes are untracked and gitignored" : `${details.length} issue(s) with untracked/ignored runtimes detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];

      for (const role of roles) {
        const roleRelDir = relative(ctx.repoRoot, role.roleDir);
        const runtimeRelPath = join(roleRelDir, "runtime");

        // 1. Untrack if tracked
        const lsResult = spawnSync("git", ["ls-files", "--stage", runtimeRelPath], {
          cwd: ctx.repoRoot,
          encoding: "utf8",
        });
        if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
          details.push(`untrack ${runtimeRelPath}`);
          changedFiles.push(runtimeRelPath);
          if (!ctx.dryRun) {
            spawnSync("git", ["rm", "--cached", "-r", runtimeRelPath], {
              cwd: ctx.repoRoot,
              encoding: "utf8",
            });
          }
        }

        // 2. Update .gitignore
        const gitignorePath = join(role.roleDir, ".gitignore");
        let content = "";
        let isIgnored = false;
        if (existsSync(gitignorePath)) {
          content = safeReadText(gitignorePath) ?? "";
          const lines = content.split(/\r?\n/).map((line) => line.trim());
          isIgnored = lines.includes("runtime/") || lines.includes("runtime");
        }

        if (!isIgnored) {
          details.push(`ignore runtime/ in ${relative(ctx.repoRoot, gitignorePath)}`);
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
        details,
      };
    },
  },
  {
    id: "systemd.sentinel",
    title: "Hermes systemd/sentinel units enabled + active",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "warn", summary: "systemd --user unavailable; unit state not auditable here", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const role of roles) {
        for (const unit of [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-heartbeat.timer`]) {
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
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (!roles.length) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No Hermes roles present", changedFiles, details };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
      }
      for (const role of roles) {
        const sysDir = join(ctx.homeDir, ".config", "systemd", "user");
        const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-heartbeat.timer`];
        const allUnitsPresent = units.every((unit) => existsSync(join(sysDir, unit)));
        if (allUnitsPresent) {
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
        for (const script of [join(role.roleDir, ".scripts", "70-systemd.sh")]) {
          if (!script || !existsSync(script)) continue;
          if (ctx.dryRun) {
            details.push(`would run: bash ${script}`);
          } else {
            const result = spawnSync("bash", [script], { cwd: role.roleDir, encoding: "utf8" });
            if (result.status !== 0) details.push(`script failed: ${script}: ${result.stderr.trim() || result.stdout.trim()}`);
          }
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: details.length ? (ctx.dryRun ? "Planned systemd remediation commands" : "Attempted systemd remediation") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
];

function writeIfDifferent(path: string, content: string, dryRun: boolean, changedFiles: string[], mode?: number): void {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
}

export function getParityRuleIds(): string[] {
  return RULES.map((rule) => rule.id);
}

export function runAudit(repoArg?: string): AuditReport {
  const pjanglerRoot = resolvePjanglerRoot();
  const ctx: Context = {
    repoRoot: resolve(repoArg ?? process.cwd()),
    dryRun: true,
    pjanglerRoot,
    homeDir: homedir(),
  };
  const rules = RULES.map((rule) => rule.audit(ctx));
  return {
    repo: ctx.repoRoot,
    ok: rules.every((rule) => rule.status === "pass" || rule.status === "skip"),
    auditedAt: new Date().toISOString(),
    rules,
  };
}

export function runMigrationForRules(ruleIds: string[], repoArg: string | undefined, dryRun: boolean): MigrationReport {
  const pjanglerRoot = resolvePjanglerRoot();
  const ctx: Context = {
    repoRoot: resolve(repoArg ?? process.cwd()),
    dryRun,
    pjanglerRoot,
    homeDir: homedir(),
  };
  const selected = RULES.filter((rule) => ruleIds.includes(rule.id));
  if (!selected.length) {
    throw new Error(`Unknown parity rules: ${ruleIds.join(", ")}`);
  }
  // One throwing rule must not kill the whole migration (PJAN-3: an ENOENT in
  // templateVersioningScript aborted every other step) — degrade to "blocked".
  const results = selected.map((rule) => {
    try {
      return rule.migrate(ctx, rule.audit(ctx));
    } catch (err) {
      return {
        id: rule.id,
        title: rule.title,
        status: "blocked" as const,
        summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
        changedFiles: [],
        details: [],
      };
    }
  });
  const changedFiles = Array.from(new Set(results.flatMap((result) => result.changedFiles))).sort();
  return {
    repo: ctx.repoRoot,
    dryRun,
    ok: results.every((result) => result.status !== "blocked"),
    selectedRules: selected.map((rule) => rule.id),
    results,
    changedFiles,
  };
}

export function runMigration(selector: string | undefined, repoArg: string | undefined, dryRun: boolean, all: boolean): MigrationReport {
  const ruleIds = all ? RULES.map((rule) => rule.id) : selector ? [selector] : [];
  return runMigrationForRules(ruleIds, repoArg, dryRun);
}

function prettyTimestamp(iso: string): string {
  // 2026-07-07T09:59:00.989Z -> 2026-07-07 09:59:00 UTC
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

export function formatAuditReport(report: AuditReport): string {
  const counts: Record<string, number> = {};
  for (const rule of report.rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const idWidth = report.rules.reduce((width, rule) => Math.max(width, rule.id.length), 0);

  const tally: string[] = [];
  if (counts.pass) tally.push(green(`${counts.pass} passed`));
  if (counts.fail) tally.push(red(`${counts.fail} failed`));
  if (counts.warn) tally.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.skip) tally.push(gray(`${counts.skip} skipped`));

  const overall = report.ok
    ? `${green(glyph.pass)} ${bold("Parity audit passed")}`
    : `${red(glyph.fail)} ${bold("Parity audit failed")}`;

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

export function formatMigrationReport(report: MigrationReport): string {
  const idWidth = report.results.reduce((width, result) => Math.max(width, result.id.length), 0);

  const overall = report.ok
    ? `${green(glyph.pass)} ${bold(report.dryRun ? "Migration preview complete" : "Migration complete")}`
    : `${red(glyph.fail)} ${bold("Migration finished with blockers")}`;

  const lines = [""];
  lines.push(`  ${overall}${report.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim(report.repo)}`);
  if (report.selectedRules.length) lines.push(`  ${dim(`rules: ${report.selectedRules.join(", ")}`)}`);
  lines.push("");
  for (const result of report.results) {
    const style = statusStyle(result.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(result.id.padEnd(idWidth))}  ${result.summary}  ${dim(`[${style.label}]`)}`);
    for (const detail of result.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
    for (const file of result.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  if (report.changedFiles.length) {
    lines.push("");
    lines.push(`  ${bold(`Changed files (${report.changedFiles.length})`)}`);
    for (const file of report.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  lines.push("");
  return lines.join("\n");
}
