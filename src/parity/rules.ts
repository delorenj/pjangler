import { normalizeProjectId } from "../project/registryClient";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, copyFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { bold, dim, green, red, yellow, gray, glyph, statusStyle, joinDot } from "../utils/style";
import { SUPPORTED_BMAD_TOOLS, SUPPORTED_CLI_ROOTS } from "../recipes/supported-clis";
import { auditProjectSkills, currentSkillActivations, synchronizeProjectSkills } from "./skills";
import { attestBmadInstallerFiles, bmadCliProjectionInventory, installedBmadTools, inventoryFilesUnder } from "./bmad-attestation";
import { applySkillRoots, CANONICAL_CLI_SKILLS_ALIAS, planSkillRoots, type SkillRootsPlan } from "./skill-roots";


/**
 * BMAD is NOT a Skillex pack.
 *
 * pjangler used to pin a frozen `packs/bmad/<version>` in the Skillex registry
 * and project it into `.agents/skills/bmad-*` as symlinks. That was a mirror of
 * something `bmad-method` already does natively: `bmad-method install` writes
 * its skills into `.agents/skills/bmad-*` and into each `--tools` root itself,
 * per repo, versioned by `_bmad/_config/manifest.yaml`.
 *
 * Two sources of truth for the same files is a bug waiting for one of them to
 * move, and on 2026-08-18 one did: the registry dropped `packs/bmad`, and every
 * machine without a warm cache lost `pjangler project create`.
 *
 * BMAD is now owned end to end by the external `bmad-method` npm package, and
 * pjangler's BMAD rules are a wrapper around it: install it, keep it current,
 * keep its CLI projections configured. `packs[]` still exists for real Skillex
 * packs; `bmad` is no longer special to it in any way.
 */

export type RuleStatus = "pass" | "fail" | "warn" | "skip";


export interface AuditFinding {
  id: string;
  title: string;
  status: RuleStatus;
  summary: string;
  details: string[];
  fixable: boolean;
  /**
   * PJAN-84: "project" (the repo can fix it, and a failure gates the repo) or
   * "host" (this machine's shared state — reported, never gating). Absent means
   * "project".
   */
  scope?: "project" | "host";
}


export interface AuditReport {
  repo: string;
  /** Is the audited PROJECT in parity? Host findings never affect this. */
  ok: boolean;
  /** Is this machine's shared state healthy? Reported separately, never gating. */
  hostOk?: boolean;
  auditedAt: string;
  rules: AuditFinding[];
}


export interface MigrationRuleResult {
  id: string;
  title: string;
  status: "applied" | "noop" | "blocked" | "skipped" | "partial";
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
  bloodbankEnabled: string;
  deploymentSystemd: string;
  serviceStateGateway: string;
  serviceStateHeartbeat: string;
  legacyReconcileEnabled: string;
  legacyReconcileGraceHours: string;
  legacyReconcileAutoReview: string;
  legacyScrumGraceHours: string;
  legacyScrumAutoReview: string;
}


export interface Context {
  repoRoot: string;
  dryRun: boolean;
  pjanglerRoot: string;
  homeDir: string;
  /** Exact BMAD package version used by an in-flight fresh-project transaction. */
  bmadVersionPin?: string;
  // PJAN-28: opt-in gate for mapping legacy committed skills into
  // .agents/skills.json. Absent/false => migrate only REPORTS the proposal.
  acceptRegistryMatches?: boolean;
}


export interface RecipeOwnedCheck {
  id: string;
  title: string;
  /**
   * PJAN-84: "host" for a rule about this MACHINE's shared state, which the
   * audited repository cannot change. Absent means "project". See
   * LifecycleScope in src/recipes/types.ts.
   */
  scope?: "project" | "host";
  audit: (ctx: Context) => AuditFinding | Promise<AuditFinding>;
  migrate: (ctx: Context, finding: AuditFinding) => MigrationRuleResult | Promise<MigrationRuleResult>;
}


// mise runs each hook/task `run` value through `sh -c`, expanding the
// `{{config_root}}` tera template first. If the resolved path contains a space
// (e.g. ".../James Brennan/...") an UNQUOTED reference word-splits and fails, so
// every config_root path is wrapped in single quotes. Multiple commands are
// emitted as an array of `[[hooks.enter]]` tables purely for readability and
// stable diffs — mise 2026.7.5 executes the `enter = [ ... ]` array-of-strings
// form correctly too, so migrating a repo off it is cosmetic, not a fix.
// PJAN-82: every managed script is handed config_root EXPLICITLY as its
// SUBJECT, not just as the path it is loaded from.
//
// A mise enter hook runs with cwd set to the directory the operator cd'd into,
// and that is true for a PARENT config's hook too — measured on mise 2026.8.10.
// `mise run <task>` does run at config_root, which is why reading the subject
// from cwd looked correct for years: only the enter-hook path was wrong. The
// consequence on this machine was that entering 33GOD/pjangler ran 33GOD's copy
// of provision-packs.py and sync-skills.py against pjangler — force-rewriting
// pjangler/.agents/skills.json and planting dangling links in seven sibling
// repos. config_root locates the file; the argument locates the subject.
const LINK_AGENTFILES_SCRIPT = "'{{config_root}}/.mise/scripts/link-agentfiles.sh' '{{config_root}}'";

// PJAN-24/PJAN-57: mise owns only a simple, quoted script invocation. The
// managed script owns mktemp reservation, path quoting, cleanup traps, and the
// successful-inject-before-atomic-mv contract without mise interpolating shell
// locals such as `$temp_file`.
const MATERIALIZE_ENV_SCRIPT_REL = ".mise/scripts/materialize-env.sh";

const OP_INJECT_SCRIPT = `'{{config_root}}/${MATERIALIZE_ENV_SCRIPT_REL}'`;

// PACKS-CONTRACT section 7: `provision-bmad-skills.py` is retired in favour of
// the generic `provision-packs.py`, and the mise task that ran it is renamed
// from `skills-provision-bmad` to `skills-provision-packs`. Both legacy names
// are still recognized so `audit` can report them and `migrate` can remove them.
const PROVISION_PACKS_SCRIPT_REL = ".mise/scripts/provision-packs.py";

const LEGACY_PROVISION_SCRIPT_REL = ".mise/scripts/provision-bmad-skills.py";

const SYNC_SKILLS_SCRIPT_REL = ".mise/scripts/sync-skills.py";

// PJAN-61: managed mise task names are unified on the COLON namespace form.
// The dash-era names below are retired. This is not cosmetic — the 33GOD root
// had already moved to colons, and the mismatch left `depends` pointing at a
// task name that no longer existed, so `mise run skills:sync` died with
// "task not found". Only the TASK names change; the `.mise/scripts/*.sh`
// FILENAMES stay dashed, so never match a task name by bare substring.
const LINK_AGENTFILES_TASK = "link:agentfiles";

const SKILLS_SYNC_TASK = "skills:sync";

const PROVISION_PACKS_TASK = "skills:provision:packs";

/**
 * Retired dash-era task name -> current colon name. `migrate` renames every
 * occurrence (section header, `task =` dispatch, `depends` entry); `audit`
 * reports them. `skills-provision-bmad` is absent on purpose: its task is
 * deleted outright, not renamed, because its script is retired too.
 */
const RETIRED_TASK_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["link-agentfiles", LINK_AGENTFILES_TASK],
  ["skills-sync", SKILLS_SYNC_TASK],
  ["skills-provision-packs", PROVISION_PACKS_TASK],
  ["hooks-sync", "hooks:sync"],
  ["hooks-check", "hooks:check"],
  ["hooks-uninstall", "hooks:uninstall"],
  ["hindsight-setup", "hindsight:setup"],
];


/**
 * TOML section header for a managed task. A bare TOML key may not contain `:`,
 * so every colon-namespaced task MUST be quoted — `[tasks."skills:sync"]`.
 * Emitting the bare form produces a file mise refuses to parse at all.
 */
function taskHeader(name: string): string {
  return `[tasks."${name}"]`;
}


/** Matches a task's section header in either the bare or the quoted TOML form. */
function taskHeaderPattern(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]$`);
}

const PROVISION_PACKS_SCRIPT =
  `python3 '{{config_root}}/${PROVISION_PACKS_SCRIPT_REL}' --root '{{config_root}}'`;

const LEGACY_PROVISION_BMAD_SKILLS_SCRIPT =
  `python3 '{{config_root}}/${LEGACY_PROVISION_SCRIPT_REL}'`;

const SYNC_SKILLS_SCRIPT =
  `python3 '{{config_root}}/${SYNC_SKILLS_SCRIPT_REL}' --scope project --root '{{config_root}}'`;

const CODEGRAPH_SCRIPT =
  "[ -f '{{config_root}}/.mise/scripts/codegraph.sh' ] && '{{config_root}}/.mise/scripts/codegraph.sh' || true";

const BMAD_SKILL_NAME_PREFIX = "bmad-";



const HOOKS_COMMENT_HEADER = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.`;


/**
 * PJAN-135: the skills:sync tool pin. mise 2026.9 refuses any npm package
 * first published inside its 30-day `minimumPackageAge`, and 0.1.1 is younger
 * than that, so the plain `"npm:@delorenj/skillex" = "0.1.1"` pin never
 * installed and the task could not run. `allow_low_downloads = true` approves
 * this exact version (measured with an isolated MISE_DATA_DIR on 2026.9.12:
 * the string is refused, this table installs and `skillex --version` prints
 * 0.1.1; mise 2026.5.0 parses it too). Keep every copy identical:
 * src/commands/AgentHooksCommands.ts and both CommonProject templates.
 */
export const SKILLEX_TOOL_VERSION = "0.1.1";

export const SKILLS_SYNC_TOOLS =
  `{ "npm:@delorenj/skillex" = { version = "${SKILLEX_TOOL_VERSION}", allow_low_downloads = true }, node = "24" }`;


// Canonical managed enter-hook commands, always installed (space-safe).
const LINK_AGENTFILES_HOOK_ENTRIES = [
  LINK_AGENTFILES_SCRIPT,
];


const LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
patterns = ["AGENTS.md"]
task = "${LINK_AGENTFILES_TASK}"

${taskHeader(LINK_AGENTFILES_TASK)}
description = "Symlink all agent files to AGENTS.md"
run = ${JSON.stringify(LINK_AGENTFILES_SCRIPT)}

${taskHeader(SKILLS_SYNC_TASK)}
description = "Reconcile this project's selected skills"
tools = ${SKILLS_SYNC_TOOLS}
run = "skillex sync --scope project --project '{{config_root}}'"`;


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
        bloodbankEnabled: yamlGet(text, "bloodbank.enabled"),
        deploymentSystemd: yamlGet(text, "deployment.systemd"),
        serviceStateGateway: yamlGet(text, "service_state.gateway"),
        serviceStateHeartbeat: yamlGet(text, "service_state.heartbeat"),
        legacyReconcileEnabled: yamlGet(text, "reconcile.enabled"),
        legacyReconcileGraceHours: yamlGet(text, "reconcile.grace_hours"),
        legacyReconcileAutoReview: yamlGet(text, "reconcile.auto_review"),
        legacyScrumGraceHours: yamlGet(text, "scrum_master.grace_hours"),
        legacyScrumAutoReview: yamlGet(text, "scrum_master.auto_review"),
      } satisfies RoleMeta;
    })
    .filter((value): value is RoleMeta => Boolean(value));
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
  // PJAN-82: read the CommonProject template, exactly like
  // templateMaterializeEnvScript does. This used to read pjangler's OWN
  // .mise/scripts/link-agentfiles.sh (shipped through the package.json files
  // allowlist), which made two different sources of truth for two scripts
  // sitting in the same directory. Hardening the template copy therefore
  // propagated to nobody: `pj migrate mise.config-root` compared every repo
  // against pjangler's stale copy and reported "No changes required" while the
  // cwd-relative version that destroys a hand-written CLAUDE.md stayed
  // installed everywhere, including in pjangler itself.
  const source = join(ctx.pjanglerRoot, "templates", "commonproject", "template", ".mise", "scripts", "link-agentfiles.sh");
  return existsSync(source) ? readText(source) : templateScript(ctx, "link-agentfiles.sh");
}


function templateMaterializeEnvScript(ctx: Context): string | undefined {
  const source = join(ctx.pjanglerRoot, "templates", "commonproject", "template", MATERIALIZE_ENV_SCRIPT_REL);
  return existsSync(source) ? readText(source) : undefined;
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


/**
 * Materialize `mise.toml` from the generated-project template when the repo has
 * none. Returns the resulting content, or `null` when there is nothing to
 * initialize from.
 *
 * PJAN-75: the content is RETURNED rather than left for the caller to read back
 * off disk. A dry run plans the write without performing it, so a caller that
 * re-read the path crashed with ENOENT -- which is what
 * `migrate skills.project-manifest --dry-run` did on every repo without a
 * mise.toml, surfacing as the useless "migrate threw: ENOENT".
 */
function ensureMiseTomlFromTemplate(ctx: Context, changedFiles: string[]): string | null {
  const targetPath = join(ctx.repoRoot, "mise.toml");
  if (existsSync(targetPath)) return null;
  const sourcePath = join(ctx.pjanglerRoot, "templates", "commonproject", "template", "mise.toml.jinja");
  if (!existsSync(sourcePath)) return null;
  const rendered = renderGeneratedProjectMiseToml(ctx, readText(sourcePath));
  changedFiles.push(targetPath);
  if (!ctx.dryRun) writeText(targetPath, rendered);
  return rendered;
}


function templateCommonProjectText(ctx: Context, rel: string): string | undefined {
  const path = join(ctx.pjanglerRoot, "templates", "commonproject", "template", rel);
  return existsSync(path) ? readText(path) : undefined;
}


function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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


function requiredMisePathEntries(_ctx: Context): string[] {
  // mise PATH entries are directories. agents/hermes/pm already makes the
  // executable wrapper at agents/hermes/pm/hermes discoverable; adding the
  // wrapper file itself creates a false audit disagreement and an invalid PATH
  // component on every rendered PM role.
  return [...BASE_MISE_PATH_ENTRIES];
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


function insertHookBlock(text: string, block: string): string {
  const structural = /^(?:\[\[watch_files\]\]|\[tasks(?:\.|\]))/m.exec(text);
  const versioningIndex = text.indexOf("# >>> mise-versioning >>>");
  const candidates = [structural?.index, versioningIndex >= 0 ? versioningIndex : undefined]
    .filter((value): value is number => value !== undefined);
  if (candidates.length) {
    const index = Math.min(...candidates);
    return `${text.slice(0, index).replace(/\s*$/, "\n\n")}${block}\n\n${text.slice(index)}`;
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


/** Strip quoting and the `{{config_root}}/` prefix so hook paths compare. */
function normalizeOpInjectPath(raw: string): string {
  let path = raw.trim();
  if ((path.startsWith("'") && path.endsWith("'")) || (path.startsWith('"') && path.endsWith('"'))) {
    path = path.slice(1, -1);
  }
  return path.replace(/^\{\{config_root\}\}\//, "").replace(/^\.\//, "");
}


const QUOTED_OR_BARE = String.raw`("[^"]*"|'[^']*'|\S+)`;


/**
 * The file an `op inject` hook ultimately writes, normalized relative to the
 * project root — or null if the value is not an `op inject` command at all.
 *
 * Publication order matters: a hook that stages to a temp and then `mv`s is
 * defined by the `mv` destination, not by `-o`. Only the segment AFTER
 * `op inject` is considered, so the `>/dev/null` in the `command -v op` guard
 * is never mistaken for the output target.
 */
function opInjectOutputTarget(value: string): string | null {
  const trimmed = value.trim();
  const start = trimmed.search(/\bop\s+inject\b/);
  if (start < 0) return null;
  const tail = trimmed.slice(start);
  const mv = new RegExp(String.raw`\bmv\s+(?:-\S+\s+)*${QUOTED_OR_BARE}\s+${QUOTED_OR_BARE}`).exec(tail);
  if (mv?.[2]) return normalizeOpInjectPath(mv[2]);
  const redirect = new RegExp(String.raw`>\s*${QUOTED_OR_BARE}`).exec(tail);
  if (redirect?.[1]) return normalizeOpInjectPath(redirect[1]);
  const flag = new RegExp(String.raw`\s(?:-o|--out(?:put)?)[=\s]\s*${QUOTED_OR_BARE}`).exec(tail);
  if (flag?.[1]) return normalizeOpInjectPath(flag[1]);
  return null;
}


/**
 * True only for a pjangler-owned dotenv materialization hook: one that writes
 * `.env` itself. That covers the canonical atomic form and both truncating
 * ancestors (v0 unguarded, v1 guarded-but-still-redirecting), all of which a
 * migrate replaces with the canonical command.
 *
 * It deliberately does NOT claim every hook that merely mentions `op inject`
 * and `.env.op`. A hook writing somewhere else — `.env.secrets` (the
 * WireMiseOpInject pattern, which is SAFER than what we install), `.env.local`,
 * `.env.staging` — belongs to the user. Claiming it is destructive, not
 * cosmetic: normalizeHookScript rewrites it to the canonical string and
 * dedupePreserve then collapses it into the managed entry, so the user's hook
 * disappears entirely. When in doubt, do not claim it.
 */
function isOpInjectHookEntry(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === OP_INJECT_SCRIPT) return true;
  return opInjectOutputTarget(trimmed) === ".env";
}


/**
 * Enter-hook values that materialize `.env` but are NOT the canonical atomic
 * command — i.e. every form that can still clobber a populated `.env`.
 *
 * The audit must test these extracted VALUES, never the raw mise.toml text: the
 * explanatory comments above the hook quote the truncating forms verbatim, so a
 * text scan would flag the very files that are already correct.
 */
function truncatingOpInjectEntries(enterHooks: string[]): string[] {
  return enterHooks.filter((value) => value.trim() !== OP_INJECT_SCRIPT && isOpInjectHookEntry(value));
}


/**
 * Normalize a preserved hook command so pjangler-managed scripts it references
 * are single-quoted (space-safe). Unknown user commands are kept verbatim.
 *
 * `kind` is load-bearing (PJAN-24): the dotenv rewrite applies to ENTER hooks
 * only. A LEAVE hook is a teardown step, so rewriting one to the materialization
 * command turns "clean up on exit" into "resolve secrets on exit" — the exact
 * inverse of its intent.
 */
function normalizeHookScript(script: string, kind: "enter" | "leave"): string {
  const trimmed = script.trim();
  if (/codegraph\.sh/.test(trimmed)) return CODEGRAPH_SCRIPT;
  if (kind === "enter" && isOpInjectHookEntry(trimmed)) return OP_INJECT_SCRIPT;
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
interface HookTableRecord {
  kind: "enter" | "leave";
  script?: string;
  raw: string;
}


function stripHookBlocks(text: string): { text: string; enter: string[]; leave: string[]; records: HookTableRecord[] } {
  const lines = text.split("\n");
  const enter: string[] = [];
  const leave: string[] = [];
  const records: HookTableRecord[] = [];
  const drop = new Array<boolean>(lines.length).fill(false);
  const isHeader = (line: string) => /^\[/.test(line.trim());

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const tableMatch = /^\[\[\s*hooks\.(enter|leave)\s*\]\]$/.exec(trimmed);
    if (tableMatch) {
      const kind = tableMatch[1] as "enter" | "leave";
      const bucket = kind === "enter" ? enter : leave;
      let recordScript: string | undefined;
      let j = i + 1;
      // TOML array-of-table bodies extend to the next table header. Blank lines
      // and comments are part of the current table and must never terminate the
      // range (PJAN-57: the old heuristic orphaned script under [env]).
      for (; j < lines.length && !isHeader(lines[j]!); j++) {
        // A managed-section marker starts a new logical region even though it
        // is a TOML comment rather than a table header.
        if (lines[j]!.trim().startsWith("# >>> mise-versioning >>>")) break;
        // `run` is the spawned-command key; `script` is its pre-2026.7.8
        // spelling (PJAN-135: mise deprecates it and removes it in 2027.3.0),
        // still read here so a legacy table is recognized by its owner.
        const scriptMatch = /^\s*(?:run|script)\s*=\s*(.+)$/.exec(lines[j]!);
        if (scriptMatch) {
          const value = extractTomlStrings(scriptMatch[1]!)[0];
          if (value !== undefined) {
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
    if (trimmed === "[hooks]") {
      let j = i + 1;
      let lastDrop = i; // last line index that is part of the [hooks] table proper
      while (j < lines.length && !isHeader(lines[j]!)) {
        const keyMatch = /^\s*(enter|leave)\s*=/.exec(lines[j]!);
        if (keyMatch) {
          const bucket = keyMatch[1] === "enter" ? enter : leave;
          const end = tomlValueSpanEnd(lines, j, lines.length);
          // Full-line comments are dropped before extraction: the explanatory
          // comment above the op-inject hook quotes the truncating forms
          // verbatim, and must not be read back as a hook value (PJAN-24).
          const chunk = lines.slice(j, end).filter((line) => !/^\s*#/.test(line)).join("\n");
          for (const value of extractTomlStrings(chunk)) {
            bucket.push(value);
            records.push({ kind: keyMatch[1] as "enter" | "leave", script: value, raw: renderHookTables([value], keyMatch[1] as "enter" | "leave")[0]! });
          }
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
  return { text: kept, enter, leave, records };
}


/**
 * A hook command line outside `[[hooks.enter]]`. `script =` is never a key of
 * anything but a hook, so anywhere else it is an orphan (PJAN-57). `run =` is
 * also every TASK's command, so it only counts inside another hook table.
 */
function strayHookCommand(line: string, table: string): string | undefined {
  const match = /^\s*(script|run)\s*=\s*(.+)$/.exec(line);
  if (!match || table === "hooks.enter") return undefined;
  if (match[1] === "run" && !table.startsWith("hooks.")) return undefined;
  return extractTomlStrings(match[2]!)[0];
}


function ownedOpInjectScriptsOutsideEnter(text: string): Array<{ line: number; value: string }> {
  const findings: Array<{ line: number; value: string }> = [];
  let table = "";
  for (const [index, line] of text.split("\n").entries()) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/[\[\]\s]/g, "");
      continue;
    }
    const value = strayHookCommand(line, table);
    if (value !== undefined && isOpInjectHookEntry(value)) findings.push({ line: index + 1, value });
  }
  return findings;
}


function removeOwnedOpInjectScriptsOutsideEnter(text: string): string {
  let table = "";
  return text.split("\n").filter((line) => {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/[\[\]\s]/g, "");
      return true;
    }
    const value = strayHookCommand(line, table);
    return value === undefined || !isOpInjectHookEntry(value);
  }).join("\n");
}


/**
 * PJAN-135: a spawned hook command is `run`. mise 2026.7.8 deprecated the
 * `script`/`scripts` spelling ("hook tables using `script` or `scripts` for
 * spawned commands are deprecated. Use `run` instead") and 2027.3.0 removes it.
 * Measured on mise 2026.9.12: `run` fires on directory entry and leave with the
 * same cwd, the same {{config_root}} expansion and the same `sh -o errexit -c`
 * command line, and prints no warning. mise older than 2026.5.6 cannot parse a
 * `run` hook table at all.
 */
function renderHookTables(scripts: readonly string[], kind: "enter" | "leave"): string[] {
  return scripts.map((script) => `[[hooks.${kind}]]\nrun = ${JSON.stringify(script)}`);
}


interface LegacyHookScriptKey {
  /** 0-based line of the `script`/`scripts` key. */
  line: number;
  /** Exclusive end line of its value. */
  end: number;
  table: string;
}


/**
 * Every hook table (any `[[hooks.<kind>]]` / `[hooks.<kind>]`, managed or not)
 * that spells its spawned command `script` or `scripts`. A table with a
 * `shell` key is excluded: that `script` is sourced into the operator's shell,
 * is NOT deprecated, and `run` there would execute the text as a file path.
 */
function legacyHookScriptKeys(text: string): LegacyHookScriptKey[] {
  const lines = text.split("\n");
  const found: LegacyHookScriptKey[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*(\[\[?\s*hooks\.[A-Za-z_]+\s*\]\]?)\s*(?:#.*)?$/.exec(lines[i]!);
    if (!header) continue;
    const table = header[1]!.replace(/[\[\]\s]/g, "");
    const keys: LegacyHookScriptKey[] = [];
    let shell = false;
    let j = i + 1;
    for (; j < lines.length && !/^\s*\[/.test(lines[j]!); j++) {
      if (/^\s*shell\s*=/.test(lines[j]!)) shell = true;
      if (/^\s*scripts?\s*=/.test(lines[j]!)) {
        const end = tomlValueSpanEnd(lines, j, lines.length);
        keys.push({ line: j, end, table });
        j = end - 1;
      }
    }
    if (!shell) found.push(...keys);
    i = j - 1;
  }
  return found;
}


function legacyHookScriptIssues(text: string): string[] {
  const keys = legacyHookScriptKeys(text);
  if (!keys.length) return [];
  return [`${keys.length} hook table(s) spell the spawned command \`script\`/\`scripts\` (line(s) ${keys.map((key) => key.line + 1).join(", ")}); ` +
    "mise deprecated it and removes it in 2027.3.0, rename it to `run`"];
}


/**
 * Rename every legacy hook command key to `run`, semantics preserved: a
 * single string is a pure key rename (quoting and trailing comment kept); an
 * array is joined with newlines, which is exactly what mise ran for it (one
 * `sh -o errexit -c "a\nb"`, measured). A rewrite that would not parse (a table
 * already holding `run`, say) is left alone for the operator.
 */
function renameLegacyHookScripts(text: string): string {
  const keys = legacyHookScriptKeys(text);
  if (!keys.length) return text;
  const parses = (candidate: string) => { try { parseToml(candidate); return true; } catch { return false; } };
  const guarded = parses(text);
  let lines = text.split("\n");
  // Bottom-up, so an array collapsing to one line never shifts a key above it.
  for (const key of [...keys].reverse()) {
    const first = lines[key.line]!;
    const value = first.replace(/^\s*scripts?\s*=\s*/, "");
    const next = [...lines];
    if (!value.startsWith("[")) {
      next[key.line] = first.replace(/^(\s*)scripts?(\s*=)/, "$1run$2");
    } else {
      const body = lines.slice(key.line, key.end).filter((line) => !/^\s*#/.test(line)).join("\n")
        .replace(/^\s*scripts?\s*=\s*/, "");
      const indent = /^\s*/.exec(first)![0];
      next.splice(key.line, key.end - key.line, `${indent}run = ${JSON.stringify(extractTomlStrings(body).join("\n"))}`);
    }
    if (guarded && !parses(next.join("\n"))) continue;
    lines = next;
  }
  return lines.join("\n");
}


function dedupePreserve(scripts: string[]): string[] {
  const out: string[] = [];
  for (const script of scripts) {
    if (script && !out.includes(script)) out.push(script);
  }
  return out;
}


function isMiseCoreHookEntry(value: string): boolean {
  const trimmed = value.trim();
  if (isOpInjectHookEntry(trimmed)) return false;
  return trimmed === SYNC_SKILLS_SCRIPT
    || trimmed === PROVISION_PACKS_SCRIPT
    || trimmed === LEGACY_PROVISION_BMAD_SKILLS_SCRIPT
    || /sync-skills(?:\.py)?["']?\s+--scope project/.test(trimmed)
    || /provision-(?:packs|bmad-skills)\.py/.test(trimmed)
    // PJAN-82: tolerate a trailing argument list.
    //
    // These patterns decide which existing hook records this owner REPLACES.
    // They were anchored to end-of-string right after the script filename, so
    // the moment the canonical form gained an explicit `'{{config_root}}'`
    // subject argument the owner stopped recognizing its OWN output: every
    // `pj migrate mise.config-root` found nothing it owned, prepended the
    // canonical block again, and left the previous copy in place as a foreign
    // record. Three runs produced three link-agentfiles enter hooks while
    // `pj audit` reported "mise AGENTS-linking parity verified".
    || /link-(?:project-skills-to-clis|agentfiles)\.sh'?(?:\s+\S.*)?$/.test(trimmed)
    || /unlink-project-skills-from-clis\.sh'?(?:\s+\S.*)?$/.test(trimmed);
}


function reconcileHookOwner(
  text: string,
  owns: (record: HookTableRecord) => boolean,
  canonicalScripts: readonly string[],
  header = "",
): string {
  const { text: stripped, records } = stripHookBlocks(text);
  const canonicalRecords = renderHookTables(canonicalScripts, "enter");
  const output: string[] = [];
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
  const withoutManagedHeader = effectiveHeader
    ? stripped.replace(HOOKS_COMMENT_HEADER, "").replace(/\n{3,}/g, "\n\n")
    : stripped;
  const block = [effectiveHeader, ...output].filter(Boolean).join("\n");
  return insertHookBlock(withoutManagedHeader, block);
}


function upsertLinkAgentfilesHooks(text: string): string {
  return reconcileHookOwner(
    text,
    (record) => Boolean(record.script && (isMiseCoreHookEntry(record.script)
      || /(?:skillex\s+sync|mise\s+(?:run\s+)?skills[:\-]sync)/.test(record.script))),
    LINK_AGENTFILES_HOOK_ENTRIES,
    HOOKS_COMMENT_HEADER,
  );
}


function upsertOpInjectHook(text: string): string {
  const withoutStrays = removeOwnedOpInjectScriptsOutsideEnter(text);
  return reconcileHookOwner(
    withoutStrays,
    (record) => record.kind === "enter" && Boolean(record.script && isOpInjectHookEntry(record.script)),
    [OP_INJECT_SCRIPT],
  );
}


/**
 * PJAN-61: rewrite retired dash-era mise task names to their colon form in
 * place — section headers, `task = "..."` watch dispatches, `depends` entries,
 * and `mise run <name>` invocations. Deliberately anchored to those syntactic
 * positions: a bare substring pass would also rewrite
 * `.mise/scripts/link-agentfiles.sh`, whose FILENAME is still dashed and must
 * stay that way.
 */
/**
 * Report every retired dash-era task name still present in a mise.toml, in the
 * same three syntactic positions `renameRetiredMiseTasks` rewrites. Anything
 * this reports is fixable by that function, so audit and migrate never disagree.
 */
/**
 * PJAN-84: a hook must name its SUBJECT, not just the script to run.
 *
 * `{{config_root}}` in a hook string locates the FILE. Nothing located the
 * file's subject, and a mise enter hook runs with cwd set to the directory the
 * operator cd'd into — including for a PARENT config's hook — so a script that
 * read its subject from cwd reshaped whichever nested repo you entered. That is
 * how 33GOD's copies of provision-packs.py and sync-skills.py came to rewrite
 * `pjangler/.agents/skills.json` and plant dangling links in seven siblings.
 *
 * The check that was here verified only that the hook string CONTAINED
 * `'{{config_root}}/.mise/scripts/link-agentfiles.sh'`, which the subject-bearing
 * form also contains — so it passed on both, and never looked at the two python
 * hooks at all. Every cwd hazard PJAN-82 fixed sat under a green audit the whole
 * time.
 */
const MANAGED_HOOK_SUBJECTS: ReadonlyArray<{ name: string; marker: string; subject: RegExp }> = [
  { name: "link-agentfiles.sh", marker: "link-agentfiles.sh", subject: /link-agentfiles\.sh'?\s+'?\{\{config_root\}\}'?/u },
];


function managedHookSubjectIssues(text: string): string[] {
  const issues: string[] = [];
  for (const record of stripHookBlocks(text).records) {
    if (record.kind !== "enter") continue;
    const script = record.script?.trim();
    if (!script) continue;
    for (const managed of MANAGED_HOOK_SUBJECTS) {
      if (!script.includes(managed.marker)) continue;
      if (managed.subject.test(script)) continue;
      issues.push(
        `hooks.enter runs ${managed.name} without handing it {{config_root}} as its subject; ` +
        "an enter hook's cwd is the directory you cd'd into, so it would act on that repo instead"
      );
    }
  }
  return issues;
}


function retiredTaskNameIssues(text: string): string[] {
  const issues: string[] = [];
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const present = new RegExp(
      `^\\[tasks\\.(?:"${esc}"|${esc})\\]|^\\s*task\\s*=\\s*"${esc}"|^\\s*depends\\s*=\\s*\\[[^\\]]*"${esc}"`,
      "m",
    ).test(text);
    if (present) issues.push(`mise.toml still uses the retired task name "${oldName}" (renamed to "${newName}")`);
  }
  return issues;
}


export function renameRetiredMiseTasks(text: string): string {
  let out = text;
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]`, "gm"), taskHeader(newName));
    out = out.replace(new RegExp(`^(\\s*task\\s*=\\s*)"${esc}"`, "gm"), `$1"${newName}"`);
    out = out.replace(new RegExp(`\\bmise run ${esc}\\b`, "g"), `mise run ${newName}`);
  }
  // `depends = [...]` holds bare task names; rewrite inside the array only.
  return out.replace(/^(\s*depends\s*=\s*)(\[[^\]]*\])/gm, (_whole, head: string, arr: string) => {
    let next = arr;
    for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
      next = next.split(`"${oldName}"`).join(`"${newName}"`);
    }
    return head + next;
  });
}


function upsertLinkAgentfilesBlock(text: string, ctx: Context): string {
  const withPath = upsertMisePath(renameRetiredMiseTasks(renameLegacyHookScripts(text)), requiredMisePathEntries(ctx));
  // Remove stale AGENTS-linking pieces before appending the canonical block.
  // Both the colon and the retired dash header forms are matched so a
  // half-migrated file can never end up holding two copies of the same task.
  let cleaned = removeTomlSection(withPath, taskHeaderPattern(LINK_AGENTFILES_TASK), /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-agentfiles\]$/, /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(SKILLS_SYNC_TASK), undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-sync\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(PROVISION_PACKS_TASK), undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-packs\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-bmad\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-project-skills-to-clis\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.unlink-project-skills-from-clis\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-relink\]$/, undefined, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /AGENTS\.md/, { includePrecedingComments: false });
  for (;;) {
    const next = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /\.agents\/skills\.json|skills[:\-]sync/, { includePrecedingComments: false });
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = upsertLinkAgentfilesHooks(cleaned);
  return insertTomlBlockBeforeVersioning(cleaned, LINK_AGENTFILES_WATCH_TASK_BLOCK);
}


function readProjectJson(ctx: Context): Record<string, unknown> | null {
  return tryParseJson(safeReadText(join(ctx.repoRoot, ".project.json")));
}


interface DeclaredAgentEntry {
  agentId: string;
  role?: string;
  roleDir?: string;
  extras: Record<string, unknown>;
}


function readDeclaredAgents(ctx: Context): DeclaredAgentEntry[] {
  const project = readProjectJson(ctx);
  const agents = project?.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return [];
  return Object.entries(agents).map(([agentId, value]) => {
    const entry = (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}) as Record<string, unknown>;
    return {
      agentId,
      role: typeof entry.role === "string" ? entry.role : undefined,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : undefined,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir")),
    };
  });
}


function readRoleYamlAt(roleDir: string): { role: string; agentId: string; providerName: string; text: string } | null {
  const roleYamlPath = join(roleDir, "role.yaml");
  if (!existsSync(roleYamlPath)) return null;
  const text = readText(roleYamlPath);
  return {
    role: yamlGet(text, "role"),
    agentId: yamlGet(text, "agent_id"),
    providerName: yamlGet(text, "ticket_provider.name"),
    text,
  };
}


/**
 * True when a declared/registered agent has no `role.yaml` behind it -- i.e.
 * the role is unprovisioned or half-provisioned rather than merely drifted.
 *
 * PJAN-75: this predicate is deliberately SHARED between `sot.project-json`
 * and `hermes.registry-parity`. Those two rules used to test the same
 * condition independently and reach opposite conclusions: registry-parity
 * called it a non-fixable blocker ("provision or restore the role, do not
 * delete its registry/declaration") while project-json quietly deleted the
 * declaration as invalid. A single `migrate --all` therefore destroyed the
 * only repo-local record of an agent's identity AND still left the audit
 * failing, because the fleet registry entry it could not see survived.
 *
 * An empty/missing role_dir counts as unprovisioned for the same reason: there
 * is nothing on disk to recover the identity from, so the declaration is all
 * that is left of it.
 */
function declaredRoleIsUnprovisioned(repoRoot: string, roleDir: string | undefined): boolean {
  if (!roleDir) return true;
  return !existsSync(join(resolve(repoRoot, roleDir), "role.yaml"));
}


function validateDeclaredAgent(ctx: Context, declared: DeclaredAgentEntry): { valid: boolean; role?: string; agentId?: string; roleDir?: string; details: string[] } {
  const details: string[] = [];
  if (!declared.roleDir) {
    details.push(`agents.${declared.agentId}.role_dir missing`);
    return { valid: false, details };
  }
  const roleDir = resolve(ctx.repoRoot, declared.roleDir);
  if (!existsSync(roleDir)) {
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
    const dispatcher = join(roleDir, ".scripts", "lib", "ticket-provider.sh");
    if (!existsSync(dispatcher)) {
      details.push(`agents.${declared.agentId} provider dispatcher ${relative(ctx.repoRoot, dispatcher)} missing`);
    }
    const provider = join(roleDir, ".scripts", "providers", `${roleYaml.providerName}.sh`);
    if (!existsSync(provider)) {
      details.push(`agents.${declared.agentId} provider script ${relative(ctx.repoRoot, provider)} missing`);
    }
  }
  return { valid: details.length === 0, role: roleYaml.role, agentId: roleYaml.agentId, roleDir, details };
}


function canonicalProjectJson(ctx: Context): Record<string, unknown> & { dropped: string[]; unprovisioned: string[] } {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = normalizeProjectId(existing.project_id ?? existing.project_slug ?? slugifyRepoName(basename(ctx.repoRoot)));
  const firstRole = roles[0];
  const ticketProvider = {
    ...(existing.ticket_provider as Record<string, unknown> | undefined),
    type: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    state: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.state ?? (firstRole?.ticketProviderBoardId ? "linked" : "planned")) || "planned"),
  };
  delete (ticketProvider as Record<string, unknown>).board_url;
  if (ticketProvider.board_id && ticketProvider.state === "planned") ticketProvider.state = "linked";
  const existingAgents = (existing.agents as Record<string, { role?: string; role_dir?: string; [key: string]: unknown }> | undefined) ?? {};
  const discoveredAgents: Record<string, { role: string; role_dir: string }> = Object.fromEntries(
    roles.map((role) => [
      role.agentId || `${slug}-${role.role}`,
      {
        role: role.role,
        role_dir: relative(ctx.repoRoot, role.roleDir),
      },
    ])
  );
  const agents: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(discoveredAgents).map(([agentId, discovered]) => {
      const existingAgent = existingAgents[agentId] ?? {};
      const extras = Object.fromEntries(Object.entries(existingAgent).filter(([key]) => key !== "role" && key !== "role_dir"));
      return [agentId, { role: discovered.role, role_dir: discovered.role_dir, ...extras }];
    })
  );
  const dropped: string[] = [];
  const unprovisioned: string[] = [];
  for (const [declaredAgentId, entry] of Object.entries(existingAgents)) {
    const declared: DeclaredAgentEntry = {
      agentId: declaredAgentId,
      role: typeof entry.role === "string" ? entry.role : undefined,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : undefined,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir")),
    };
    // PJAN-75: a declaration with no role.yaml behind it is an UNPROVISIONED
    // role, not junk. role.yaml is the identity SSOT, so when it is absent the
    // declaration is the last place the agent's role, role_dir and any
    // provisioning extras still exist -- and `hermes.registry-parity` refuses
    // to prune exactly this state for exactly that reason. Preserve the entry
    // byte-for-byte and let the rule keep failing until the role is
    // provisioned or restored. Dropping it neither fixed the audit (the fleet
    // registry entry outlives .project.json) nor left anything to repair from.
    if (declaredRoleIsUnprovisioned(ctx.repoRoot, declared.roleDir)) {
      agents[declaredAgentId] = { ...entry };
      unprovisioned.push(declaredAgentId);
      continue;
    }
    const validated = validateDeclaredAgent(ctx, declared);
    if (!validated.valid || !validated.role || !validated.agentId || !validated.roleDir) {
      // role.yaml exists, so `discoverRoles` has already contributed the
      // canonical identity above and this stale key carries nothing unique.
      dropped.push(declaredAgentId);
      continue;
    }
    agents[validated.agentId] = {
      role: validated.role,
      role_dir: relative(ctx.repoRoot, validated.roleDir),
      ...declared.extras,
    };
  }
  // `automation.reconcile` is dropped, not carried forward. It described an
  // opt-in that was never wired: `reconcile_enabled()` in .scripts/heartbeat.sh
  // reads the `reconcile:` block in role.yaml and never opens .project.json.
  // Canonicalizing it put a dead switch in ~60 repos and taught the PM's SOUL
  // an opt-in that does not exist. Anything else under `automation` passes
  // through; an `automation` with nothing left in it is omitted rather than
  // written back as an empty object.
  const { reconcile: _vestigialReconcile, ...automation } =
    (existing.automation as Record<string, unknown> | undefined) ?? {};
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_id: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents,
    ...(Object.keys(automation).length ? { automation } : {}),
    dropped,
    unprovisioned,
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
  for (const key of ["project_name", "project_description", "project_id", "repo_path", "ticket_provider", "agents"]) {
    if (!(key in data)) details.push(`missing key: ${key}`);
  }
  if ("project_slug" in data) details.push("legacy project_slug should be migrated to project_id");
  if (typeof data.project_id === "string" && data.project_id !== data.project_id.toLowerCase()) details.push("project_id must be lowercase");
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
  // PJAN-75: split the declaration findings by whether migrate can actually
  // resolve them. An unprovisioned role is a human action (provision or
  // restore role.yaml); reporting it as fixable put the rule back in the
  // picker on every run, where the only "fix" available was the destructive
  // prune this rule no longer performs.
  const declaredAgents = readDeclaredAgents(ctx);
  let unprovisionedDeclarations = 0;
  for (const declared of declaredAgents) {
    const declaredDetails = validateDeclaredAgent(ctx, declared).details;
    if (declaredRoleIsUnprovisioned(ctx.repoRoot, declared.roleDir)) {
      unprovisionedDeclarations += declaredDetails.length;
      details.push(
        ...declaredDetails.map((detail) => `${detail}; provision or restore the role, do not delete its declaration`)
      );
      continue;
    }
    details.push(...declaredDetails);
  }
  const ticketProvider = (data.ticket_provider as Record<string, unknown> | undefined) ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id", "state"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if ("board_url" in ticketProvider) details.push("ticket_provider.board_url should be removed; derive it from provider/workspace/board_id");
  if (!ticketProvider.board_id && roles.some((role) => role.ticketProviderBoardId)) {
    details.push("ticket_provider.board_id missing even though legacy role.yaml contains a board binding");
  }
  // `automation.reconcile` is vestigial and is being removed fleet-wide. It
  // described an opt-in the heartbeat never implemented: `reconcile_enabled()`
  // in .scripts/heartbeat.sh reads the `reconcile:` block in role.yaml and
  // never opens .project.json, so this key has never had an effect. Requiring
  // it made every repo carry a switch wired to nothing, and its presence in
  // the PM's SOUL taught agents an opt-in that does not exist.
  const automation = (data.automation as Record<string, unknown> | undefined) ?? {};
  if ("reconcile" in automation) {
    details.push("automation.reconcile is vestigial and should be removed; the heartbeat reads role.yaml, never this key");
  }
  if (existsSync(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
  return {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: details.length === 0 ? "pass" : "fail",
    summary: details.length === 0 ? ".project.json matches canonical parity contract" : `${details.length} parity issue(s) detected`,
    details,
    fixable: details.length > unprovisionedDeclarations,
  };
}


// ---------------------------------------------------------------------------
// BMAD version helpers (shared by bmad.scaffold + bmad.version)
// ---------------------------------------------------------------------------

const BMAD_NPM_PACKAGE = "bmad-method";

// Installer and Skillex pack are independently pinned artifacts. Do not derive
// either lifecycle from the other: the installer is advanced only after its
// real multi-module configuration contract is verified.
export const BMAD_INSTALLER_VERSION = "6.11.1-next.1";

// Legacy BMAD currency checks continue to report the moving next channel; fresh
// bootstrap uses the exact installer pin above so mutation is reproducible.
const BMAD_TARGET_CHANNEL = "next";

const BMAD_DIST_TAGS_TTL_MS = 60 * 60 * 1000; // 1h — mirrors the starship BMAD indicator cache

const DEFAULT_BMAD_MODULES = ["bmm", "bmb", "cis"];


// Derived from the one public six-CLI support matrix.
const BMAD_INSTALL_TOOLS = SUPPORTED_BMAD_TOOLS;


type ManifestBmadModuleSelection =
  | { status: "absent" }
  | { status: "valid"; modules: string[] }
  | { status: "invalid"; error: string };


function manifestBmadModules(repoRoot: string): ManifestBmadModuleSelection {
  const manifestPath = join(repoRoot, "_bmad", "_config", "manifest.yaml");
  const raw = safeReadText(manifestPath);
  if (raw === null) return { status: "absent" };
  try {
    const parsed = YAML.parse(raw) as { modules?: unknown } | undefined;
    if (!Array.isArray(parsed?.modules)) {
      return { status: "invalid", error: `${manifestPath} must define a modules array` };
    }
    const declared: string[] = [];
    for (const entry of parsed.modules) {
      const name = typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).name
          : undefined;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        return { status: "invalid", error: `${manifestPath} contains an invalid module entry` };
      }
      if (name !== "core" && name !== "custom") declared.push(name);
    }
    return { status: "valid", modules: Array.from(new Set(declared)) };
  } catch (error) {
    return {
      status: "invalid",
      error: `Could not parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


function configuredBmadModules(repoRoot: string): string[] | undefined {
  const raw = safeReadText(join(repoRoot, "_bmad", "config.toml"));
  if (raw === null) return undefined;
  const modules = [...raw.matchAll(/^\[modules\.([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*$/gm)].map((match) => match[1]!);
  return Array.from(new Set(modules));
}


function selectedBmadModules(repoRoot: string): string[] {
  const manifest = manifestBmadModules(repoRoot);
  if (manifest.status === "valid") return manifest.modules;
  if (manifest.status === "invalid") throw new Error(manifest.error);
  return configuredBmadModules(repoRoot) ?? [...DEFAULT_BMAD_MODULES];
}


function requiredBmadSentinels(repoRoot: string, modules = selectedBmadModules(repoRoot)): string[] {
  return [
    join("core", "config.yaml"),
    join("config.toml"),
    join("_config", "manifest.yaml"),
    ...modules.map((module) => join(module, "config.yaml")),
  ];
}


function canonicalBmadProjectName(repoRoot: string): string {
  const project = readProjectJson({ repoRoot } as Context);
  const declared = typeof project?.project_name === "string" ? project.project_name.trim() : "";
  return declared || basename(repoRoot);
}


function bmadProjectNameIssues(repoRoot: string): { paths: string[]; details: string[] } {
  const expected = canonicalBmadProjectName(repoRoot);
  const paths: string[] = [];
  const details: string[] = [];
  const configToml = join(repoRoot, "_bmad", "config.toml");
  const tomlText = safeReadText(configToml);
  const tomlMatch = tomlText?.match(/^project_name\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m);
  let tomlName: string | undefined;
  if (tomlMatch) {
    try {
      tomlName = JSON.parse(`"${tomlMatch[1]}"`) as string;
    } catch {
      tomlName = undefined;
    }
  }
  if (tomlName !== expected) {
    paths.push(configToml);
    details.push(`_bmad/config.toml project_name must be ${JSON.stringify(expected)}`);
  }
  const bmadRoot = join(repoRoot, "_bmad");
  if (existsSync(bmadRoot)) {
    // PJAN-82: only the modules BMAD's own manifest declares.
    //
    // This used to walk every directory under _bmad/, which pulled in stale
    // module directories a long-retired installer left behind — pjangler still
    // carried _bmad/_memory and _bmad/custom from 6.0.0-alpha.23, neither of
    // which has ever had a project_name key. `bmad-method install` does not
    // touch them, so bmad.scaffold reported two unfixable issues on every
    // re-audit and its migration could only ever come back "partial". Scoping
    // the check to declared modules makes the rule converge, and an
    // undeclared-but-present directory is bmad.cli-roots' and the installer's
    // business, not this rule's.
    let declared: string[];
    try { declared = selectedBmadModules(repoRoot); }
    catch { declared = readdirSync(bmadRoot); }
    for (const name of new Set(declared)) {
      const configPath = join(bmadRoot, name, "config.yaml");
      const raw = safeReadText(configPath);
      if (raw === null) continue;
      let actual: unknown;
      try {
        actual = (YAML.parse(raw) as Record<string, unknown> | undefined)?.project_name;
      } catch {
        actual = undefined;
      }
      if (actual !== expected) {
        paths.push(configPath);
        details.push(`_bmad/${name}/config.yaml project_name must be ${JSON.stringify(expected)}`);
      }
    }
  }
  return { paths: [...new Set(paths)].sort(), details };
}


/** The project's current skillex activations: receipt-owned paths and selected catalog skill targets. */
interface SkillActivations { owned: Set<string>; targets: Set<string> }

function isCurrentActivation(path: string, activations: SkillActivations): boolean {
  if (activations.owned.has(path)) return true;
  try {
    if (activations.owned.has(join(realpathSync(dirname(path)), basename(path)))) return true;
    return activations.targets.has(realpathSync(path));
  } catch {
    return false;
  }
}

async function skillActivations(ctx: Context): Promise<SkillActivations> {
  const found = await currentSkillActivations(ctx);
  return { owned: new Set(found.owned), targets: new Set(found.targets) };
}


/**
 * Remove `bmad-*` skill entries left behind as SYMLINKS by the retired Skillex
 * `bmad` pin, so `bmad-method install` can write its own real directories.
 *
 * Only symlinks are removed, and only under the `bmad-` namespace. A real
 * directory there is either the installer's own output (which it overwrites in
 * place) or something a human put there, and neither is this function's to
 * delete. The pack symlinks point into a per-machine registry cache that no
 * longer even holds the pack, so leaving them shadows the installer with dead
 * links.
 *
 * PJAN-135: a `bmad-*` link that is a CURRENT skillex activation (owned by the
 * project's activation receipt, or resolving to a selected catalog skill such
 * as bmad-html-workspace) is not retired pack state and is never evicted.
 */
function evictLegacyBmadPackState(ctx: Context, changedFiles: string[], activations: SkillActivations): string[] {
  const details: string[] = [];
  const skillDirs = [
    join(ctx.repoRoot, ".agents", "skills"),
    ...SUPPORTED_CLI_ROOTS.map((root) => join(ctx.repoRoot, root, "skills")),
  ];
  for (const dir of skillDirs) {
    const dirStat = lstatIfPresent(dir);
    // A CLI root whose `skills` is itself the .agents/skills alias is covered
    // by the canonical directory above; following it would double-count.
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(BMAD_SKILL_NAME_PREFIX)) continue;
      const path = join(dir, name);
      if (!lstatIfPresent(path)?.isSymbolicLink()) continue;
      if (isCurrentActivation(path, activations)) continue;
      changedFiles.push(path);
      details.push(`removed retired BMAD pack symlink ${relative(ctx.repoRoot, path)}`);
      if (!ctx.dryRun) unlinkSync(path);
    }
  }
  return details;
}


interface BmadInstallerInvocation {
  command: string;
  prefixArgs: string[];
}


function bmadInstallerInvocation(version = BMAD_INSTALLER_VERSION): BmadInstallerInvocation {
  const explicit = process.env.PJ_BMAD_INSTALLER?.trim();
  if (explicit) return { command: resolve(explicit), prefixArgs: [] };
  return {
    command: "npx",
    prefixArgs: ["-y", `${BMAD_NPM_PACKAGE}@${version}`],
  };
}


function bmadInstallerArgs(repoRoot: string, modules = selectedBmadModules(repoRoot)): string[] {
  // bmad-method treats a missing/falsy --modules under --yes as "installed +
  // defaults", which can silently add bmm. The installer-supported explicit
  // no-optional-modules representation is `--modules core`; core is mandatory
  // and the installer does not add defaults when the option is truthy.
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
    `core.project_name=${canonicalBmadProjectName(repoRoot)}`,
  ];
}


function bmadInstallDisplay(
  repoRoot: string,
  modules = selectedBmadModules(repoRoot),
  version = BMAD_INSTALLER_VERSION,
): string {
  const invocation = bmadInstallerInvocation(version);
  return [invocation.command, ...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)]
    .join(" ")
    .replace(BMAD_INSTALL_TOOLS.join(","), "...");
}


export interface BmadLifecyclePreflightResult {
  ok: boolean;
  error?: string;
}


/**
 * Prove the exact fresh-project BMAD input before Copier can create a target.
 *
 * That input is now exactly one thing: the pinned `bmad-method` installer,
 * resolved from npm (or an explicit local executable) up front so a create
 * cannot fail half-way through with a scaffolded but BMAD-less directory. The
 * pack preflight that used to sit here proved a Skillex `bmad` pin that no
 * longer exists — and, once the registry dropped that pack, failed every
 * create on any machine without a warm cache.
 */
export function preflightBmadLifecycle(_ctx: Context): BmadLifecyclePreflightResult {
  const invocation = bmadInstallerInvocation();
  const probe = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || probe.error?.message || "installer probe failed").trim();
    return {
      ok: false,
      error: `Pinned BMAD installer ${BMAD_NPM_PACKAGE}@${BMAD_INSTALLER_VERSION} is unavailable: ${detail}`,
    };
  }
  const versionOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const reportedVersions: string[] = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [];
  if (!reportedVersions.includes(BMAD_INSTALLER_VERSION)) {
    return {
      ok: false,
      error: `BMAD installer version mismatch: expected ${BMAD_INSTALLER_VERSION}, received ${versionOutput.trim() || "no version output"}`,
    };
  }
  return { ok: true };
}


/** Run the non-interactive BMAD installer/upgrader against `repoRoot`. */
function runBmadInstall(
  repoRoot: string,
  modules = selectedBmadModules(repoRoot),
  version = BMAD_INSTALLER_VERSION,
): { ok: boolean; error?: string } {
  const invocation = bmadInstallerInvocation(version);
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)], { encoding: "utf8" });
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


// ============================================================================
// Momo lifecycle-plane readiness profile
// ============================================================================

export interface MomoReadinessFinding {
  section: string;
  status: RuleStatus;
  summary: string;
  details: string[];
}


export interface MomoReadinessReport {
  ready: boolean;
  profile: "momo-lifecycle-plane";
  repo: string;
  live: boolean;
  auditedAt: string;
  findings: MomoReadinessFinding[];
}


interface MomoProviderCandidate {
  path: string;
  kind: "shell" | "python" | "unknown";
}


function discoverMomoProviderCandidates(repoRoot: string): MomoProviderCandidate[] {
  const candidates: MomoProviderCandidate[] = [];
  const roleDirs: string[] = [];
  const hermesDir = join(repoRoot, "agents", "hermes");
  if (existsSync(hermesDir)) {
    for (const entry of readdirSync(hermesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roleDirs.push(join(hermesDir, entry.name));
    }
  }
  for (const roleDir of roleDirs) {
    for (const name of ["momo", "provider", "momo-provider"]) {
      const path = join(roleDir, name);
      if (existsSync(path)) {
        const kind = path.endsWith(".py") ? "python" : "shell";
        candidates.push({ path, kind });
      }
    }
    // Also accept any executable file named momo* in the role dir.
    if (existsSync(roleDir)) {
      for (const entry of readdirSync(roleDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith("momo")) continue;
        const path = join(roleDir, entry.name);
        try {
          if (lstatSync(path).mode & 0o111) {
            const kind = entry.name.endsWith(".py") ? "python" : "shell";
            if (!candidates.some((c) => c.path === path)) candidates.push({ path, kind });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const rel of [".mise/scripts/momo-provider.sh", ".scripts/momo-provider.sh", "momo"]) {
    const path = join(repoRoot, rel);
    if (existsSync(path)) {
      const kind = path.endsWith(".py") ? "python" : "shell";
      if (!candidates.some((c) => c.path === path)) candidates.push({ path, kind });
    }
  }
  return candidates;
}


function firstMomoProvider(repoRoot: string): MomoProviderCandidate | undefined {
  return discoverMomoProviderCandidates(repoRoot)[0];
}


function checkProviderSyntax(candidate: MomoProviderCandidate): { ok: boolean; detail?: string } {
  if (candidate.kind === "python") {
    const result = spawnSync("python3", ["-m", "py_compile", candidate.path], { encoding: "utf8" });
    if (result.status !== 0) {
      return { ok: false, detail: `python3 -m py_compile failed: ${result.stderr.trim() || result.stdout.trim() || "syntax error"}` };
    }
    return { ok: true };
  }
  if (candidate.kind === "shell") {
    const result = spawnSync("bash", ["-n", candidate.path], { encoding: "utf8" });
    if (result.status !== 0) {
      return { ok: false, detail: `bash -n failed: ${result.stderr.trim() || result.stdout.trim() || "syntax error"}` };
    }
    return { ok: true };
  }
  return { ok: true };
}


function runProviderLocalSmoke(repoRoot: string, candidate: MomoProviderCandidate): { ok: boolean; detail?: string } {
  const result = spawnSync(candidate.path, ["--help"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, detail: `${relative(repoRoot, candidate.path)} --help exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}


function attemptPlaneStateMapping(repoRoot: string): { ok: boolean; detail?: string } {
  const project = tryParseJson(safeReadText(join(repoRoot, ".project.json")));
  const tp = (project?.ticket_provider as Record<string, unknown>) ?? {};
  if (!tp.board_id) return { ok: false, detail: "ticket_provider.board_id missing; cannot map Plane states" };
  // The live mapping is credential-bearing; a real run would query Plane here.
  // In this deterministic interface we only verify the binding is present and
  // report that the attempt was made. Returning ok:false with a stable detail
  // keeps the output deterministic when credentials are absent.
  return { ok: false, detail: `Plane state mapping attempted for board ${tp.board_id} (credentials required for full mapping)` };
}


function attemptNestedAdapterSmoke(repoRoot: string, candidate: MomoProviderCandidate): { ok: boolean; detail?: string } {
  const result = spawnSync(candidate.path, ["--smoke", "nested"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, detail: `${relative(repoRoot, candidate.path)} --smoke nested exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}


function momoLifecycleFinding(
  section: string,
  status: RuleStatus,
  summary: string,
  details: string[] = []
): MomoReadinessFinding {
  return { section, status, summary, details };
}


function auditManifestRoleConsistency(repoRoot: string): MomoReadinessFinding {
  const details: string[] = [];
  const projectPath = join(repoRoot, ".project.json");
  if (!existsSync(projectPath)) {
    return momoLifecycleFinding("manifest-role-consistency", "fail", ".project.json missing", [".project.json missing"]);
  }
  const project = tryParseJson(safeReadText(projectPath));
  if (!project) {
    return momoLifecycleFinding("manifest-role-consistency", "fail", ".project.json is invalid JSON", [".project.json is invalid JSON"]);
  }
  const agents = (project.agents as Record<string, { role?: string; role_dir?: string }> | undefined) ?? {};
  const discovered = discoverRoles(repoRoot);
  const discoveredByAgentId = new Map(discovered.map((role) => [role.agentId, role]));
  const discoveredByDir = new Map(discovered.map((role) => [role.roleDir, role]));

  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.role_dir) {
      details.push(`agents.${agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve(repoRoot, agent.role_dir);
    if (!existsSync(roleDir)) {
      details.push(`agents.${agentId}.role_dir does not exist: ${agent.role_dir}`);
      continue;
    }
    const roleYaml = join(roleDir, "role.yaml");
    if (!existsSync(roleYaml)) {
      details.push(`agents.${agentId} role.yaml missing at ${agent.role_dir}/role.yaml`);
      continue;
    }
    const discoveredRole = discoveredByDir.get(roleDir);
    if (!discoveredRole) {
      details.push(`agents.${agentId} role.yaml at ${agent.role_dir} could not be parsed`);
      continue;
    }
    if (discoveredRole.agentId !== agentId) {
      details.push(`agents.${agentId} role.yaml agent_id mismatch: ${discoveredRole.agentId}`);
    }
    if (discoveredRole.role !== agent.role) {
      details.push(`agents.${agentId} role.yaml role mismatch: expected ${agent.role}, got ${discoveredRole.role}`);
    }
  }

  for (const role of discovered) {
    if (!role.agentId) {
      details.push(`role.yaml at ${relative(repoRoot, role.roleYamlPath)} missing agent_id`);
      continue;
    }
    if (!(role.agentId in agents)) {
      details.push(`role.yaml declares unregistered agent_id: ${role.agentId}`);
    }
  }

  if (Object.keys(agents).length === 0) {
    details.push("no agents declared in .project.json");
  }

  return details.length === 0
    ? momoLifecycleFinding("manifest-role-consistency", "pass", "manifest and role declarations are consistent")
    : momoLifecycleFinding("manifest-role-consistency", "fail", `${details.length} manifest/role consistency issue(s)`, details);
}


function hasAnyLifecycleScript(repoRoot: string): boolean {
  const patterns = [
    ".mise/scripts/lifecycle",
    ".scripts/lifecycle",
    "agents/hermes/*/lifecycle",
    "agents/hermes/*/.scripts/lifecycle",
    "agents/hermes/*/.scripts/migrate",
    ".mise/tasks/lifecycle",
  ];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*") as [string, string];
      const base = join(repoRoot, prefix);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(base, entry.name, suffix);
        if (existsSync(candidate)) return true;
        // Prefix-match the leaf, matching both the advertised pattern
        // ("<role>/.scripts/lifecycle*") and the non-wildcard branch below.
        // Requiring an extensionless `lifecycle` made the obvious filename
        // (lifecycle.sh) fail against a message saying it should work.
        const parent = dirname(candidate);
        const stem = basename(candidate);
        if (!existsSync(parent)) continue;
        for (const sibling of readdirSync(parent, { withFileTypes: true })) {
          if (sibling.isFile() && sibling.name.startsWith(stem)) return true;
        }
      }
    } else {
      const base = join(repoRoot, pattern);
      if (existsSync(base)) return true;
      // Also accept any file starting with the base path.
      const parent = dirname(base);
      const prefix = basename(base);
      if (existsSync(parent)) {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.name.startsWith(prefix)) return true;
        }
      }
    }
  }
  return false;
}


function auditLifecycleScripts(repoRoot: string): MomoReadinessFinding {
  if (hasAnyLifecycleScript(repoRoot)) {
    return momoLifecycleFinding("lifecycle-scripts", "pass", "lifecycle scripts present");
  }
  return momoLifecycleFinding(
    "lifecycle-scripts",
    "fail",
    "lifecycle scripts missing",
    ["expected one of: .mise/scripts/lifecycle*, .scripts/lifecycle*, agents/hermes/<role>/lifecycle*, agents/hermes/<role>/.scripts/lifecycle*"]
  );
}


function hasAnySentinelScript(repoRoot: string): boolean {
  const patterns = [
    "agents/hermes/*/.scripts/checkpoint.sh",
    "agents/hermes/*/.scripts/heartbeat.sh",
    "agents/hermes/*/.scripts/sentinel",
    "agents/hermes/*/sentinel.prompt.md",
    ".scripts/sentinel",
  ];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*") as [string, string];
      const base = join(repoRoot, prefix);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(base, entry.name, suffix);
        if (existsSync(candidate)) return true;
        // Prefix-match the leaf, matching both the advertised pattern
        // ("<role>/.scripts/lifecycle*") and the non-wildcard branch below.
        // Requiring an extensionless `lifecycle` made the obvious filename
        // (lifecycle.sh) fail against a message saying it should work.
        const parent = dirname(candidate);
        const stem = basename(candidate);
        if (!existsSync(parent)) continue;
        for (const sibling of readdirSync(parent, { withFileTypes: true })) {
          if (sibling.isFile() && sibling.name.startsWith(stem)) return true;
        }
      }
    } else {
      const base = join(repoRoot, pattern);
      if (existsSync(base)) return true;
      const parent = dirname(base);
      const prefix = basename(base);
      if (existsSync(parent)) {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.name.startsWith(prefix)) return true;
        }
      }
    }
  }
  return false;
}


function auditSentinelScripts(repoRoot: string): MomoReadinessFinding {
  if (hasAnySentinelScript(repoRoot)) {
    return momoLifecycleFinding("sentinel-scripts", "pass", "sentinel scripts present");
  }
  return momoLifecycleFinding(
    "sentinel-scripts",
    "fail",
    "sentinel scripts missing",
    ["expected one of: agents/hermes/<role>/.scripts/{checkpoint.sh,heartbeat.sh,sentinel*}, agents/hermes/<role>/sentinel.prompt.md, .scripts/sentinel*"]
  );
}


function auditExecutableProvider(repoRoot: string): MomoReadinessFinding {
  const candidates = discoverMomoProviderCandidates(repoRoot);
  if (candidates.length === 0) {
    return momoLifecycleFinding(
      "executable-provider",
      "fail",
      "executable provider dispatcher missing",
      ["expected an executable agents/hermes/<role>/momo, agents/hermes/<role>/provider, or project-level momo-provider script"]
    );
  }
  const details = candidates.map((c) => relative(repoRoot, c.path));
  return momoLifecycleFinding("executable-provider", "pass", `${candidates.length} provider dispatcher candidate(s)`, details);
}


function auditProviderSyntax(repoRoot: string): MomoReadinessFinding {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("provider-syntax", "skip", "no provider dispatcher to validate");
  }
  const syntax = checkProviderSyntax(candidate);
  if (!syntax.ok) {
    return momoLifecycleFinding("provider-syntax", "fail", `${relative(repoRoot, candidate.path)} has syntax errors`, [syntax.detail ?? "syntax check failed"]);
  }
  return momoLifecycleFinding("provider-syntax", "pass", `${relative(repoRoot, candidate.path)} syntax OK`);
}


function auditPlaneBinding(repoRoot: string): MomoReadinessFinding {
  const details: string[] = [];
  const project = tryParseJson(safeReadText(join(repoRoot, ".project.json")));
  const tp = (project?.ticket_provider as Record<string, unknown>) ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id"]) {
    if (!tp[key]) details.push(`ticket_provider.${key} missing`);
  }
  const discovered = discoverRoles(repoRoot);
  for (const role of discovered) {
    if (!role.ticketProviderBoardId && !role.ticketProviderIdentifier) {
      details.push(`${relative(repoRoot, role.roleYamlPath)} missing ticket_provider/plane binding`);
    }
  }
  if (details.length === 0) {
    return momoLifecycleFinding("plane-binding", "pass", "Plane ticket provider binding present");
  }
  return momoLifecycleFinding("plane-binding", "fail", `${details.length} Plane binding issue(s)`, details);
}


function auditPlaneStateMapping(repoRoot: string, live: boolean): MomoReadinessFinding {
  if (!live) {
    return momoLifecycleFinding("plane-state-mapping", "skip", "live check skipped (pass --live)", ["requires --live"]);
  }
  const result = attemptPlaneStateMapping(repoRoot);
  if (!result.ok) {
    return momoLifecycleFinding("plane-state-mapping", "warn", "Plane state mapping attempted but incomplete", [result.detail ?? "incomplete"]);
  }
  return momoLifecycleFinding("plane-state-mapping", "pass", "Plane state mapping verified");
}


function auditRootAdapterSmoke(repoRoot: string): MomoReadinessFinding {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("root-adapter-smoke", "skip", "no provider dispatcher to smoke-test");
  }
  const smoke = runProviderLocalSmoke(repoRoot, candidate);
  if (!smoke.ok) {
    return momoLifecycleFinding("root-adapter-smoke", "fail", "root adapter smoke test failed", [smoke.detail ?? "unknown error"]);
  }
  return momoLifecycleFinding("root-adapter-smoke", "pass", "root adapter smoke test passed");
}


function auditNestedAdapterSmoke(repoRoot: string, live: boolean): MomoReadinessFinding {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("nested-adapter-smoke", "skip", "no provider dispatcher to smoke-test");
  }
  if (!live) {
    return momoLifecycleFinding("nested-adapter-smoke", "skip", "live check skipped (pass --live)", ["requires --live"]);
  }
  const smoke = attemptNestedAdapterSmoke(repoRoot, candidate);
  if (!smoke.ok) {
    return momoLifecycleFinding("nested-adapter-smoke", "warn", "nested adapter smoke attempted but incomplete", [smoke.detail ?? "unknown error"]);
  }
  return momoLifecycleFinding("nested-adapter-smoke", "pass", "nested adapter smoke test passed");
}


function runMomoLifecyclePlaneAudit(repoRoot: string, live = false): MomoReadinessReport {
  const findings: MomoReadinessFinding[] = [
    auditManifestRoleConsistency(repoRoot),
    auditLifecycleScripts(repoRoot),
    auditSentinelScripts(repoRoot),
    auditExecutableProvider(repoRoot),
    auditProviderSyntax(repoRoot),
    auditPlaneBinding(repoRoot),
    auditPlaneStateMapping(repoRoot, live),
    auditRootAdapterSmoke(repoRoot),
    auditNestedAdapterSmoke(repoRoot, live),
  ];
  const ready = findings.every((f) => f.status === "pass" || f.status === "skip");
  return {
    ready,
    profile: "momo-lifecycle-plane",
    repo: resolve(repoRoot),
    live,
    auditedAt: new Date().toISOString(),
    findings,
  };
}


export function runMomoReadinessAudit(repoRoot?: string, live = false): MomoReadinessReport {
  return runMomoLifecyclePlaneAudit(resolve(repoRoot ?? process.cwd()), live);
}


export function formatMomoReadinessReport(report: MomoReadinessReport): string {
  const sectionWidth = report.findings.reduce((max, f) => Math.max(max, f.section.length), 0);
  const overall = report.ready
    ? `${green(glyph.pass)} ${bold("Momo readiness: ready")}`
    : `${red(glyph.fail)} ${bold("Momo readiness: not ready")}`;
  const lines = ["", `  ${overall}  ${dim(glyph.dot)}  ${dim(report.profile)}`, `  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(report.auditedAt)}`, ""];
  for (const finding of report.findings) {
    const style = statusStyle(finding.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(finding.section.padEnd(sectionWidth))}  ${finding.summary}`);
    for (const detail of finding.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}


interface OpReferenceOccurrence {
  line: number;
  value: string;
  commentOnly: boolean;
}


function isValidOpReference(value: string): boolean {
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


/**
 * PJAN-84: a 1Password item name may contain a space, and `op` accepts it.
 *
 * Verified against the real CLI: `op inject` resolves
 * `T=op://DeLoSecrets/DeLoHQ Bot/token` bare, double-quoted, and single-quoted.
 * Percent-encoding is NOT accepted — `%20` is decoded and then split, so the
 * encoded form fails where the literal space works.
 *
 * The scanner below was whitespace-delimited, so it read that value as
 * `op://DeLoSecrets/DeLoHQ`, counted two segments, and reported "Malformed
 * active op:// reference(s)". holocene's env migration was blocked on a
 * reference that resolves correctly, and the message told the operator to
 * repair a file that was already right.
 *
 * An assignment's value is therefore taken whole: everything after the first
 * `=`, trimmed, with matching surrounding quotes removed. A trailing
 * space-hash comment is stripped only from an UNQUOTED value, which is the
 * dotenv convention; a `#` still inside the reference after that remains
 * invalid, as before. References appearing in prose or mid-line keep the old
 * whitespace-delimited scan, because there is no value boundary to use.
 */
function assignmentOpReference(line: string): string | null {
  const separator = line.indexOf("=");
  if (separator < 0) return null;
  const key = line.slice(0, separator).trim().replace(/^export\s+/u, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;
  let value = line.slice(separator + 1).trim();
  const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1);
  if (quoted) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/u, "").trim();
  return value.startsWith("op://") ? value : null;
}


function malformedOpReferences(text: string): OpReferenceOccurrence[] {
  const occurrences: OpReferenceOccurrence[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const commentOnly = line.trimStart().startsWith("#");
    const assigned = commentOnly ? null : assignmentOpReference(line);
    if (assigned !== null) {
      if (!isValidOpReference(assigned)) occurrences.push({ line: index + 1, value: assigned, commentOnly: false });
      continue;
    }
    for (const match of line.matchAll(/op:\/\/[^\s"'`]+/g)) {
      const value = match[0];
      if (!isValidOpReference(value)) {
        occurrences.push({ line: index + 1, value, commentOnly });
      }
    }
  }
  return occurrences;
}


function removeMalformedCommentOpReferences(text: string): { text: string; changed: boolean } {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trimStart().startsWith("#")) return line;
    return line.replace(/op:\/\/[^\s"'`]+/g, (value) => {
      if (isValidOpReference(value)) return value;
      changed = true;
      return "<invalid 1Password reference removed by pjangler>";
    });
  });
  return { text: lines.join("\n"), changed };
}


const UNSUPPORTED_BMAD_ROOTS = {
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
  ".zencoder": "zencoder",
} as const;


function unsupportedRootAttestation(repoRoot: string, rootName: keyof typeof UNSUPPORTED_BMAD_ROOTS): { safe: boolean; reason: string } {
  const root = join(repoRoot, rootName);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { safe: false, reason: `${rootName} is not a regular generated directory` };
  const installerTool = UNSUPPORTED_BMAD_ROOTS[rootName];
  if (!installedBmadTools(repoRoot).has(installerTool)) {
    return { safe: false, reason: `BMAD installer metadata does not declare tool ${installerTool}` };
  }
  const inventory = bmadCliProjectionInventory(repoRoot);
  if (inventory.error) return { safe: false, reason: inventory.error };
  const walked = inventoryFilesUnder(root);
  if (walked.unsafe.length) return { safe: false, reason: `${rootName}/${walked.unsafe[0]} is a symlink or non-regular entry` };
  return attestBmadInstallerFiles(inventory, root, walked.files, rootName);
}


/**
 * PJAN-84: template scripts that are OPTIONAL but must not drift.
 *
 * Four of the six CommonProject scripts have a byte-parity owner
 * (link-agentfiles.sh here, materialize-env.sh in secrets.env-op,
 * provision-packs.py and sync-skills.py in skills.project-manifest). These two
 * had none, so a repo could carry a months-old copy and nothing noticed.
 *
 * They are optional by design and stay so: the template guards the codegraph
 * hook with `[ -f ... ] && ... || true`, and hindsight-setup.sh backs a task
 * nobody has to run. pjangler itself carries neither. Demanding their presence
 * would contradict that guard — so the rule is "if it is here, it matches", and
 * absence is silence.
 */
const OPTIONAL_TEMPLATE_SCRIPTS = [
  ".mise/scripts/codegraph.sh",
  ".mise/scripts/hindsight-setup.sh",
] as const;


function optionalTemplateScriptIssues(ctx: Context): string[] {
  const issues: string[] = [];
  for (const rel of OPTIONAL_TEMPLATE_SCRIPTS) {
    const path = join(ctx.repoRoot, rel);
    if (!existsSync(path)) continue;
    const expected = templateCommonProjectText(ctx, rel);
    if (expected === undefined) continue;
    if (safeReadText(path) !== expected) issues.push(`${rel} is present but has drifted from the shipped template`);
  }
  return issues;
}


function refreshOptionalTemplateScripts(ctx: Context): string[] {
  const changed: string[] = [];
  for (const rel of OPTIONAL_TEMPLATE_SCRIPTS) {
    const path = join(ctx.repoRoot, rel);
    if (!existsSync(path)) continue;
    const expected = templateCommonProjectText(ctx, rel);
    if (expected === undefined || safeReadText(path) === expected) continue;
    changed.push(path);
    if (!ctx.dryRun) {
      writeText(path, expected);
      chmodSync(path, 0o755);
    }
  }
  return changed;
}


export function createMiseChecks(): RecipeOwnedCheck[] {
return [
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
      details.push(...managedHookSubjectIssues(text));
      details.push(...legacyHookScriptIssues(text));
      details.push(...optionalTemplateScriptIssues(ctx));
      if (!text.includes("patterns = [\"AGENTS.md\"]")) details.push("watch_files must monitor AGENTS.md");
      if (!text.includes(`task = "${LINK_AGENTFILES_TASK}"`)) details.push(`watch_files must dispatch the ${LINK_AGENTFILES_TASK} task`);
      details.push(...retiredTaskNameIssues(text));
      // PJAN-128: this owner already repairs skill hooks/tasks without touching
      // skill content. Select it even when Skillex refuses a foreign CLI root
      // or manifest: entering a repo must not depend on adopting those skills.
      details.push(...skillsWiringIssues(text));
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
        if (ensureMiseTomlFromTemplate(ctx, changedFiles) === null) {
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
      changedFiles.push(...refreshOptionalTemplateScripts(ctx));
      if (safeReadText(linkAgentfilesPath) !== expectedScript) {
        changedFiles.push(linkAgentfilesPath);
        if (!ctx.dryRun) {
          writeText(linkAgentfilesPath, expectedScript);
          chmodSync(linkAgentfilesPath, 0o755);
        }
      }
      // A legacy hook table the rename could not rewrite (it would not parse,
      // e.g. a table that already holds `run`) is left for the operator and
      // said so, never reported as done.
      const leftover = legacyHookScriptIssues(text);
      return {
        id: finding.id,
        title: finding.title,
        status: leftover.length ? "partial" : changedFiles.length ? "applied" : "noop",
        summary: leftover.length ? "Legacy hook tables need a manual `run` rename"
          : changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
        changedFiles,
        details: [
          ...(changedFiles.length ? [`Normalized hooks/watch_files/tasks."${LINK_AGENTFILES_TASK}" block and script`] : []),
          ...leftover.map((issue) => `left untouched (renaming would not parse): ${issue}`),
        ],
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
        if (ensureMiseTomlFromTemplate(ctx, changedFiles) === null) {
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
];
}


const RETIRED_SKILL_SCRIPTS = [SYNC_SKILLS_SCRIPT_REL, PROVISION_PACKS_SCRIPT_REL, LEGACY_PROVISION_SCRIPT_REL,
  ".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"];


function retiredSkillsScripts(ctx: Context): string[] {
  return RETIRED_SKILL_SCRIPTS.map((path) => join(ctx.repoRoot, path)).filter((path) => Boolean(lstatIfPresent(path)));
}


function skillsWiringIssues(text: string | null): string[] {
  if (text === null) return ["mise.toml is missing; add the explicit skills:sync task"];
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(text); }
  catch { return ["mise.toml is invalid TOML; repair it before running skills:sync"]; }
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tasks = record(parsed.tasks), task = record(tasks[SKILLS_SYNC_TASK]);
  const run = Array.isArray(task.run) && task.run.length === 1 ? task.run[0] : task.run;
  const issues: string[] = [];
  if (typeof run !== "string" || !/^skillex\s+sync\s+--scope\s+project\s+--project\s+(['"])\{\{config_root\}\}\1\s*$/.test(run)) {
    issues.push("skills:sync must explicitly target {{config_root}} with the Node CLI");
  }
  // The legacy plain-string pin and the table form both pin 0.1.1; accepting
  // both means no forced churn of existing tasks (PJAN-135).
  const pin = record(task.tools)["npm:@delorenj/skillex"];
  const pinned = typeof pin === "string" ? pin : record(pin).version;
  if (pinned !== SKILLEX_TOOL_VERSION) issues.push(`skills:sync must pin @delorenj/skillex ${SKILLEX_TOOL_VERSION} in its own tools table`);
  const retired = /sync-skills\.py|provision-(?:packs|bmad-skills)\.py|skills[:\-]provision/;
  if (Object.entries(tasks).some(([name, task]) => retired.test(name) || retired.test(JSON.stringify(record(task).run ?? "")))) issues.push("Retire Python skill sync/provision tasks from mise.toml");
  const hooks = JSON.stringify(parsed.hooks ?? {});
  if (retired.test(hooks) || /(?:skillex\s+sync|skills[:\-]sync)/.test(hooks)) issues.push("Skill sync must not run from enter/leave hooks");
  if (Array.isArray(parsed.watch_files) && parsed.watch_files.some((watch) => /skills\.json|skills[:\-]sync|sync-skills/.test(JSON.stringify(watch)))) issues.push("Remove the skills watch hook; run skills:sync explicitly");
  return issues;
}


export function createAgentHooksChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "skills.project-manifest",
    title: "Skillex project skills",
    audit: async (ctx) => {
      const finding = await auditProjectSkills(ctx);
      const mise = safeReadText(join(ctx.repoRoot, "mise.toml"));
      const wiring = skillsWiringIssues(mise);
      const retired = retiredSkillsScripts(ctx);
      const unsafe = retired.filter((path) => lstatIfPresent(path)?.isDirectory());
      const details = [...finding.details, ...wiring, ...retired.map((path) => unsafe.includes(path)
        ? `Inspect and preserve retired script directory: ${path}` : `${path} is a retired skill writer`)];
      // PJAN-135: fixable means "migrate makes progress", not "migrate reaches
      // parity". Retiring writer files and normalizing the task no longer wait on
      // the sync outcome, so either one alone is progress; auditProjectSkills
      // already folded in the CLI skills-root plan and root-collision verdict.
      // A retired path that is a directory is never touched, so it still gates.
      return { ...finding, status: wiring.length || retired.length ? "fail" as const : finding.status,
        fixable: unsafe.length ? false : finding.fixable || wiring.length > 0 || retired.length > 0,
        summary: details.length ? `${details.length} Skillex finding(s)` : finding.summary, details };
    },
    migrate: async (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const result = (status: MigrationRuleResult["status"], summary: string): MigrationRuleResult =>
        ({ id: finding.id, title: finding.title, status, summary, changedFiles: [...new Set(changedFiles)], details });
      let currentMise = safeReadText(join(ctx.repoRoot, "mise.toml"));
      if (currentMise === null) {
        const template = templateCommonProjectText(ctx, "mise.toml.jinja");
        if (template === undefined) return result("blocked", "Generated-project mise template is unavailable");
        currentMise = renderGeneratedProjectMiseToml(ctx, template);
      }
      // (1) A retired path that is a directory is someone's content, not a writer.
      const unsafeScript = retiredSkillsScripts(ctx).find((path) => lstatIfPresent(path)?.isDirectory());
      if (unsafeScript) {
        details.push(`Inspect and preserve ${unsafeScript} before retiring that path`);
        return result("blocked", "A retired script path contains a directory");
      }
      // (2) Retire the writer FILES first, independently of the sync outcome.
      // PJAN-128 removed every hook, task and watch that ran them, so keeping
      // them on disk until skillex agrees protects nothing; it only left infra
      // failing on "retired skill writer" while a skills root was blocked.
      for (const path of retiredSkillsScripts(ctx)) {
        const stat = lstatIfPresent(path);
        if (!stat || stat.isDirectory()) continue;
        changedFiles.push(path);
        if (!ctx.dryRun) unlinkSync(path);
      }
      // (3) The explicit skills:sync task, likewise independent of the sync.
      const misePath = join(ctx.repoRoot, "mise.toml");
      const nextMise = upsertLinkAgentfilesBlock(currentMise, ctx);
      if (safeReadText(misePath) !== nextMise) {
        changedFiles.push(misePath);
        if (!ctx.dryRun) writeText(misePath, nextMise);
      }
      // (4) Lossless CLI skills-root conversion. A blocked root stays untouched
      // and makes the sync below refuse at that alias, which is reported.
      const roots = applySkillRoots(ctx.repoRoot, { dryRun: ctx.dryRun });
      changedFiles.push(...roots.changedFiles);
      details.push(...roots.details);
      details.push(...roots.blocks.map((reason) => `blocked: ${reason}`).filter((line) => !details.includes(line)));
      // (5) + (6) init the manifest if missing, then sync; the core owns both.
      const reconciled = await synchronizeProjectSkills(ctx, {
        pendingAliases: roots.plan.aliases.filter((entry) => entry.operations.length).map((entry) => entry.alias),
        incoming: roots.plan.incoming,
      });
      changedFiles.push(...reconciled.changedFiles);
      details.push(...reconciled.details);
      if (!reconciled.ok || !roots.ok) {
        return result(changedFiles.length ? "partial" : "blocked", "Skillex requires attention before project migration");
      }
      return changedFiles.length
        ? result("applied", "Project skills use the Node core and explicit sync task")
        : result("noop", "No changes required");
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
];
}


function createProjectJsonChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "sot.project-json",
    title: "Canonical .project.json",
    audit: projectJsonFinding,
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const blockedDetails: string[] = [];
      const droppedDetails: string[] = [];
      const path = join(ctx.repoRoot, ".project.json");
      const existing = readProjectJson(ctx) ?? {};
      const canonical = canonicalProjectJson(ctx);
      const preservedDetails: string[] = [];
      for (const agentId of canonical.unprovisioned) {
        const roleDir = ((existing.agents as Record<string, Record<string, unknown>> | undefined)?.[agentId]?.role_dir);
        preservedDetails.push(
          `preserved unprovisioned declared agent: ${agentId}${typeof roleDir === "string" && roleDir ? ` (${roleDir} has no role.yaml)` : " (no role_dir)"}; provision or restore the role, do not delete its declaration`
        );
      }
      for (const agentId of canonical.dropped) {
        const entry = (existing.agents as Record<string, unknown> | undefined)?.[agentId];
        const entryRecord = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
        const declared: DeclaredAgentEntry = {
          agentId,
          role: typeof entryRecord?.role === "string" ? entryRecord.role : undefined,
          roleDir: typeof entryRecord?.role_dir === "string" ? entryRecord.role_dir : undefined,
          extras: {},
        };
        const validation = validateDeclaredAgent(ctx, declared);
        const reason = validation.details.join("; ") || "invalid";
        droppedDetails.push(`dropped invalid declared agent: ${agentId} (${reason})`);
      }
      // Merge: canonical keys win, but preserve any extra keys the user added
      const { dropped: _dropped, unprovisioned: _unprovisioned, ...canonicalJson } = canonical;
      const merged = { ...existing, ...canonicalJson };
      delete merged.project_slug;
      const expected = `${JSON.stringify(merged, null, 2)}\n`;
      if (safeReadText(path) !== expected) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, expected);
      }
      const planeJson = join(ctx.repoRoot, ".plane.json");
      if (existsSync(planeJson)) {
        const backup = `${planeJson}.migrated-backup`;
        if (existsSync(backup)) {
          blockedDetails.push(`cannot back up .plane.json because ${relative(ctx.repoRoot, backup)} already exists`);
        } else {
          changedFiles.push(backup);
          if (!ctx.dryRun) renameSync(planeJson, backup);
        }
      }
      const details = [...droppedDetails, ...preservedDetails, ...blockedDetails];
      return {
        id: finding.id,
        title: finding.title,
        status: blockedDetails.length ? "blocked" : (changedFiles.length || droppedDetails.length) ? "applied" : "noop",
        summary: blockedDetails.length
          ? "Project SOT partially blocked"
          : (changedFiles.length || droppedDetails.length)
            ? `Canonical .project.json written; dropped ${droppedDetails.length} invalid declared agent(s)`
            : "No changes required",
        changedFiles,
        details,
      };
    },
  },
];
}


export function createMiseOpInjectChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "secrets.env-op",
    title: ".env.op + gitignore secrets contract",
    audit: (ctx) => {
      const details: string[] = [];
      let envOpNeedsHands = false;
      const envOpPath = join(ctx.repoRoot, ".env.op");
      const envOpExists = existsSync(envOpPath);
      const envOp = envOpExists ? readText(envOpPath) : undefined;
      const gitignore = safeReadText(join(ctx.repoRoot, ".gitignore"));
      if (!envOpExists) {
        details.push(".env.op missing");
      } else if (!envOp?.trim()) {
        details.push(".env.op is empty or whitespace-only");
      } else {
        const malformed = malformedOpReferences(envOp);
        if (malformed.length) {
          details.push(`.env.op has malformed op:// reference(s) on line(s): ${Array.from(new Set(malformed.map((entry) => entry.line))).join(", ")}`);
        }
        const invalidLines = envOp
          .split("\n")
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          .filter(({ line }) => line && !line.startsWith("#") && line.includes("="))
          .filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
        if (invalidLines.length) details.push(`.env.op has non-reference values that do not look like safe literals on line(s): ${invalidLines.map((entry) => entry.number).join(", ")}`);
      }
      if (!gitignore?.includes(".env\n") && !gitignore?.includes(".env\r\n")) details.push(".gitignore should ignore .env");
      if (!gitignore?.includes(".env.*")) details.push(".gitignore should ignore .env.*");
      if (!gitignore?.includes("!.env.op")) details.push(".gitignore should unignore .env.op");
      const misePath = join(ctx.repoRoot, "mise.toml");
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
      const materializePath = join(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
      const expectedMaterializer = templateMaterializeEnvScript(ctx);
      if (!expectedMaterializer) {
        details.push("pjangler package is missing the managed materialize-env.sh source");
      } else if (safeReadText(materializePath) !== expectedMaterializer) {
        details.push(`${MATERIALIZE_ENV_SCRIPT_REL} missing or drifted`);
      } else if ((lstatSync(materializePath).mode & 0o111) === 0) {
        details.push(`${MATERIALIZE_ENV_SCRIPT_REL} is not executable`);
      }
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
      let envOpNeedsHands = false;
      const envOpPath = join(ctx.repoRoot, ".env.op");
      const canonicalEnvOpPath = join(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op");
      if (!existsSync(canonicalEnvOpPath)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler package is missing the neutral .env.op template", changedFiles: [], details: [] };
      }
      const canonicalEnvOp = readText(canonicalEnvOpPath);
      if (!existsSync(envOpPath) || !readText(envOpPath).trim()) {
        changedFiles.push(envOpPath);
        if (!ctx.dryRun) writeText(envOpPath, canonicalEnvOp);
      } else {
        const current = readText(envOpPath);
        const activeMalformed = malformedOpReferences(current).filter((entry) => !entry.commentOnly);
        const invalidActive = current
          .split("\n")
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          .filter(({ line }) => line && !line.startsWith("#") && line.includes("="))
          .filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
        if (activeMalformed.length || invalidActive.length) {
          // PJAN-84: report the .env.op content, but do not let it veto the
          // repairs that have nothing to do with it.
          //
          // This used to `return blocked` here, which skipped the .gitignore
          // block, the mise.toml op-inject hook, and the materialize-env.sh
          // install — three fixes that never touch .env.op's contents. A repo
          // whose .env.op holds a deliberately inline local-only value (one
          // KeepyMoney file says so in a comment: "Local-only creds (threat
          // model: none)") could therefore never get its enter hook repaired,
          // and the cwd-relative `op inject -i .env.op > .env` hook that drops a
          // stray .env into any subdirectory you jump into stayed forever.
          //
          // Same shape as the retired `bmad` pack declaration that blocked the
          // migration which would have removed it: an unresolvable thing must
          // never get a veto over everything around it.
          envOpNeedsHands = true;
          details.push(...(activeMalformed.length ? [`Malformed active op:// reference(s) remain on line(s) ${Array.from(new Set(activeMalformed.map((entry) => entry.line))).join(", ")}; repair them manually without replacing valid user references`] : []));
          details.push(...(invalidActive.length ? [`Unsafe active value(s) remain on line(s) ${invalidActive.map((entry) => entry.number).join(", ")}; repair them manually`] : []));
        } else {
          const repaired = removeMalformedCommentOpReferences(current);
          // A comment-only file is an intentional opt-out. Preserve it exactly
          // unless malformed examples in comments need conservative cleanup.
          const next = repaired.text;
          if (next !== current) {
            changedFiles.push(envOpPath);
            if (!ctx.dryRun) writeText(envOpPath, next);
          }
        }
      }
      const gitignorePath = join(ctx.repoRoot, ".gitignore");
      const gitignore = safeReadText(gitignorePath) ?? "";
      // `.env.*` also covers the `.env.inject.XXXXXX` staging file the atomic
      // op-inject enter hook creates in the project dir (PJAN-24).
      const requiredBlock = `# Secrets — .env is materialized from .env.op by \`op inject\` on mise enter,\n# staged through a mktemp file and moved into place only on success.\n# NEVER commit it. .env.op holds only 1Password references or safe literals and IS committed.\n.env\n.env.*\n!.env.op\n`;
      if (!gitignore.includes("!.env.op") || !gitignore.includes(".env.*")) {
        changedFiles.push(gitignorePath);
        if (!ctx.dryRun) writeText(gitignorePath, `${gitignore.replace(/\s*$/, "")}${gitignore.trim() ? "\n\n" : ""}${requiredBlock}`);
      }
      const misePath = join(ctx.repoRoot, "mise.toml");
      let currentMise = safeReadText(misePath);
      if (currentMise === null) {
        const initialized = ensureMiseTomlFromTemplate(ctx, changedFiles);
        if (initialized === null) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and the packaged template is unavailable", changedFiles: [], details: [] };
        }
        // Previously guarded by `if (existsSync(misePath))`, which a dry run
        // never satisfies -- so the op-inject hook silently vanished from the
        // preview of a repo that had no mise.toml yet.
        currentMise = initialized;
      }
      const nextOpInjectMise = upsertOpInjectHook(currentMise);
      if (nextOpInjectMise !== currentMise) {
        if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
        if (!ctx.dryRun) writeText(misePath, nextOpInjectMise);
      }
      const materializePath = join(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
      const expectedMaterializer = templateMaterializeEnvScript(ctx);
      if (!expectedMaterializer) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler package is missing materialize-env.sh", changedFiles: [], details: [] };
      }
      if (safeReadText(materializePath) !== expectedMaterializer || (existsSync(materializePath) && (lstatSync(materializePath).mode & 0o111) === 0)) {
        changedFiles.push(materializePath);
        if (!ctx.dryRun) {
          writeText(materializePath, expectedMaterializer);
          chmodSync(materializePath, 0o755);
        }
      }
      const uniqueChangedFiles = [...new Set(changedFiles)].sort();
      if (envOpNeedsHands) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: uniqueChangedFiles.length
            ? "Repaired the mise contract; .env.op content still needs hands"
            : "Manual .env.op cleanup still required",
          changedFiles: uniqueChangedFiles,
          details,
        };
      }
      return {
        id: finding.id,
        title: finding.title,
        status: uniqueChangedFiles.length ? "applied" : "noop",
        summary: uniqueChangedFiles.length ? "Reconciled the canonical .env materialization contract" : "No changes required",
        changedFiles: uniqueChangedFiles,
        details,
      };
    },
  },
];
}


function createProjectProvenanceChecks(): RecipeOwnedCheck[] {
return [
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
];
}


function supportedCliProjectionIssues(repoRoot: string, plan: SkillRootsPlan): string[] {
  const issues: string[] = [];
  const managedSkills = join(repoRoot, ".agents", "skills");
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join(repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (!rootStat) {
      issues.push(`${rootName} missing`);
      continue;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      issues.push(`${rootName} must be a real configuration directory`);
      continue;
    }
    const skills = join(root, "skills");
    const skillsStat = lstatIfPresent(skills);
    if (!skillsStat) {
      issues.push(`${rootName}/skills missing`);
      continue;
    }
    let projectedSkills = skills;
    if (skillsStat.isSymbolicLink()) {
      try {
        readlinkSync(skills);
      } catch {
        issues.push(`${rootName}/skills is an unreadable symlink`);
        continue;
      }
      // PJAN-135: any spelling that reaches .agents/skills is the alias skillex
      // accepts (skillex migrate writes an absolute one and records its inode);
      // rewriting it would break that ownership, so it is not an issue.
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
    } else if (skillsStat.isDirectory()) {
      // PJAN-135: skillex refuses a real-directory alias outright, so this is an
      // issue, not a valid projection. The shared plan says what converting it
      // would do (or exactly why it cannot, losslessly).
      const planned = plan.aliases.find((entry) => entry.path === skills);
      issues.push(`${rootName}/skills is a real directory, not the ${CANONICAL_CLI_SKILLS_ALIAS} alias${planned ? ` (${planned.summary})` : ""}`);
      continue;
    } else {
      issues.push(`${rootName}/skills is not a directory`);
      continue;
    }
    const hasGeneratedSkill = existsSync(projectedSkills) && readdirSync(projectedSkills).some((name) => {
      const skillFile = join(projectedSkills, name, "SKILL.md");
      return existsSync(skillFile) && lstatSync(skillFile).isFile();
    });
    if (!hasGeneratedSkill) issues.push(`${rootName}/skills contains no BMAD skill configuration`);
  }
  return issues;
}


/**
 * `.agents/` is the only canonical agent-config tree committed by a project.
 * The six client roots are local generated projections and belong in the
 * operator's global ignore, not in a copied or duplicated repository policy.
 *
 * PJAN-126 retires the older block that unignored every client root. Migration
 * removes only the exact lines/comments that pjangler itself generated. It does
 * not inspect or mutate Git's index: already-tracked ignored paths require the
 * reviewed `gitignore-maintenance` parity workflow so local copies are proved
 * preserved before any `git rm --cached` operation.
 *
 * The one exception is the CLI skills-root conversion (PJAN-135,
 * skill-roots.ts): it untracks only content it has itself relocated or proven
 * duplicate, and only when every tracked file hashes to BMAD's own installer
 * manifest. The local copy is preserved by construction (rename(2) into
 * `.agents/skills`, or byte-identical there already).
 */
const CANONICAL_AGENT_GITIGNORE_COMMENT = "# Canonical agent config lives in .agents; generated skill projections stay local.";

const CANONICAL_AGENT_GITIGNORE_PATTERN = "/.agents/skills";

const CANONICAL_AGENT_GITIGNORE_BLOCK = `${CANONICAL_AGENT_GITIGNORE_COMMENT}\n${CANONICAL_AGENT_GITIGNORE_PATTERN}`;


const LEGACY_CLI_GITIGNORE_LINES = new Set([
  ...SUPPORTED_CLI_ROOTS.flatMap((root) => [
    `!${root}/`,
    `!${root}/**`,
    `${root}/skills`,
    `${root}/skills/`,
  ]),
  "# Generated CLI configurations are durable project state...",
  "# ...but their skill projections are regenerated by `bmad-method install` and",
  "# `mise run skills:sync`, so they stay out of the tree.",
  "# `mise run skills:sync`, so they stay out of the tree. No trailing slash:",
  "# ...but their skill projections are regenerated, so they stay out of the tree.",
  "# No trailing slash: some CLIs get a real directory here and some a symlink.",
  "# some CLIs get a real directory here and some get a symlink.",
]);


function supportedCliGitignoreIssues(repoRoot: string): string[] {
  const lines = (safeReadText(join(repoRoot, ".gitignore")) ?? "").split(/\r?\n/);
  const legacy = lines.filter((line) => LEGACY_CLI_GITIGNORE_LINES.has(line.trim()));
  return [
    ...(legacy.length
      ? [`.gitignore contains ${legacy.length} legacy client-root override line(s); only .agents is canonical`]
      : []),
    ...(!lines.includes(CANONICAL_AGENT_GITIGNORE_PATTERN)
      ? [`.gitignore must ignore the generated ${CANONICAL_AGENT_GITIGNORE_PATTERN}`]
      : []),
  ];
}


function ensureSupportedCliGitignore(ctx: Context): string[] {
  const path = join(ctx.repoRoot, ".gitignore");
  const current = safeReadText(path) ?? "";
  const kept = current
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !LEGACY_CLI_GITIGNORE_LINES.has(trimmed)
        && trimmed !== CANONICAL_AGENT_GITIGNORE_COMMENT
        && trimmed !== CANONICAL_AGENT_GITIGNORE_PATTERN
        && trimmed !== `${CANONICAL_AGENT_GITIGNORE_PATTERN}/`;
    });
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const base = kept.join("\n");
  const next = `${base}${base.trim() ? "\n\n" : ""}${CANONICAL_AGENT_GITIGNORE_BLOCK}\n`;
  if (current === next) return [];
  if (!ctx.dryRun) writeText(path, next);
  return [path];
}


/**
 * The six CLI skills roots, through the one shared planner (PJAN-135): create an
 * absent alias, relink a non-canonical or dangling one, and losslessly convert a
 * real directory (the BMAD installer recreates one for claude-code whenever the
 * alias is missing, and this rule runs after it). Blocked roots stay untouched.
 */
function ensureSupportedCliProjections(ctx: Context): { changedFiles: string[]; blockers: string[]; details: string[] } {
  // The shared planner checks every component: `.agents` and `.agents/skills`
  // must both be real directories (lstat of the leaf alone follows a symlinked
  // `.agents`).
  if (planSkillRoots(ctx.repoRoot, { aliases: [] }).rootState !== "directory") {
    return { changedFiles: [], details: [], blockers: [".agents/skills must be a real BMAD-generated directory (with a real .agents parent) before CLI projections can be created"] };
  }
  const applied = applySkillRoots(ctx.repoRoot, { dryRun: ctx.dryRun });
  return { changedFiles: applied.changedFiles, blockers: applied.blocks, details: applied.details };
}


export function createBmadChecks(): RecipeOwnedCheck[] {
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
          fixable: false,
        };
      }
      const targetRoot = join(ctx.repoRoot, "_bmad");
      const selectedModules = manifestSelection.status === "valid"
        ? manifestSelection.modules
        : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
      const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
      const missing = sentinels.filter((file) => !existsSync(join(targetRoot, file)));
      const projectNameIssues = bmadProjectNameIssues(ctx.repoRoot);
      const details = [
        ...missing.map((file) => `_bmad/${file}`),
        ...projectNameIssues.details,
      ];
      return {
        id: "bmad.scaffold",
        title: "BMAD modules/docs scaffold",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "BMAD scaffold and project identity parity verified" : `${details.length} BMAD scaffold issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: async (ctx, finding) => {
      const changedFiles: string[] = [];
      const manifestSelection = manifestBmadModules(ctx.repoRoot);
      if (manifestSelection.status === "invalid") {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "BMAD module manifest is invalid; refusing fallback module selection",
          changedFiles,
          details: [manifestSelection.error],
        };
      }
      const selectedModules = manifestSelection.status === "valid"
        ? manifestSelection.modules
        : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
      if (ctx.dryRun) {
        const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
        changedFiles.push(...sentinels
          .map((file) => join(ctx.repoRoot, "_bmad", file))
          .filter((path) => !existsSync(path)));
        changedFiles.push(...bmadProjectNameIssues(ctx.repoRoot).paths);
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Would run non-interactive bmad-method install" : "No changes required",
          changedFiles,
          details: [
            `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules)}`,
          ],
        };
      }

      const expectedChangedPaths = [
        ...requiredBmadSentinels(ctx.repoRoot, selectedModules)
          .map((file) => join(ctx.repoRoot, "_bmad", file))
          .filter((path) => !existsSync(path)),
        ...bmadProjectNameIssues(ctx.repoRoot).paths,
      ];
      // Clear retired pack symlinks first: they point into a registry cache
      // that no longer holds the pack, and the installer must be able to write
      // real directories at those names.
      const evicted = evictLegacyBmadPackState(ctx, changedFiles, await skillActivations(ctx));
      const install = runBmadInstall(ctx.repoRoot, selectedModules);
      if (!install.ok) {
        // What was already evicted is reported, not hidden behind "blocked".
        return {
          id: finding.id,
          title: finding.title,
          status: changedFiles.length ? "partial" : "blocked",
          summary: `Failed to run bmad-method install`,
          changedFiles: [...changedFiles],
          details: [...evicted, install.error ?? "Unknown error"],
        };
      }

      changedFiles.push(...expectedChangedPaths.filter(existsSync));

      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Installed BMAD scaffold via bmad-method" : "No changes required",
        changedFiles,
        details: evicted,
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

      const pinned = ctx.bmadVersionPin?.trim();
      const resolved = pinned ? undefined : resolveBmadDistTags(ctx.homeDir);
      const available = pinned ?? resolved?.distTags?.[BMAD_TARGET_CHANNEL];
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
          fixable: false,
        };
      }

      const pinnedMismatch = Boolean(pinned && comparison !== 0);
      const stable = resolved?.distTags.latest;
      // PJAN-82: being behind a MOVING prerelease channel is news, not a defect.
      //
      // The target channel is `next`, which advances every few days
      // (6.11.1-next.1 -> next.27 inside a week). Reporting that as `warn` made
      // every repository on the machine permanently non-parity, because
      // auditRecipes counts anything but pass/skip as not-ok and ProjectRecipe
      // turns a not-ok postcondition audit into a transaction error — so a
      // brand-new project was "broken" the moment upstream cut a prerelease, and
      // `migrate --all` would reinstall BMAD everywhere to chase it. A real
      // currency defect is measured against a floor that does not move: the
      // published stable release, or an explicit transaction pin.
      if (!pinned && !stable) {
        // No published stable tag resolved, so there is no non-moving floor to
        // measure currency against. Say so instead of guessing in either
        // direction.
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "skip",
          summary: `BMAD ${installed} installed; stable currency floor unknown (${BMAD_NPM_PACKAGE} latest unresolved)`,
          details: [`installed: ${installed}`, `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`],
          fixable: false,
        };
      }
      const behindStable = !pinned && stable ? compareBmadVersions(installed, stable) < 0 : false;
      if (!pinned && !behindStable) {
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: "pass",
          summary: `BMAD ${installed} is at or ahead of stable ${stable ?? "unknown"}; ${targetLabel} available${staleNote}`,
          details: [
            `installed: ${installed}`,
            `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
            stable ? `stable latest: ${stable}` : "",
            "run `pj migrate bmad.version` to take the prerelease",
          ].filter(Boolean),
          fixable: false,
        };
      }
      return {
        id: "bmad.version",
        title: "BMAD version currency",
        status: pinnedMismatch ? "fail" : "warn",
        summary: pinnedMismatch
          ? `BMAD ${installed} does not match ${targetLabel}`
          : `BMAD ${installed} is behind stable ${stable} — upgrade available`,
        details: [
          `installed: ${installed}`,
          pinned ? `required transaction pin: ${available}` : `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
          !pinned && stable ? `stable latest: ${stable}` : "",
          "run `pj migrate bmad.version` to upgrade",
        ].filter(Boolean),
        fixable: true,
      };
    },
    migrate: async (ctx, finding) => {
      // PJAN-82: recompute rather than trusting the finding's status.
      //
      // The audit now passes when the only drift is against the moving `next`
      // prerelease channel, so gating on `status === "warn"` would make an
      // explicit `pj migrate bmad.version` a silent no-op. `migrate --all`
      // still skips this rule, because it only selects fail/warn findings.
      if (finding.status === "skip") {
        return { id: finding.id, title: finding.title, status: "noop", summary: finding.summary, changedFiles: [], details: [] };
      }
      {
        const current = readInstalledBmadVersion(ctx.repoRoot);
        const target = ctx.bmadVersionPin?.trim() ?? resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
        if (!current || !target || compareBmadVersions(current, target) === 0) {
          return { id: finding.id, title: finding.title, status: "noop", summary: "BMAD already current", changedFiles: [], details: [] };
        }
      }

      const installed = readInstalledBmadVersion(ctx.repoRoot);
      const available = ctx.bmadVersionPin?.trim() ?? resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
      const manifestPath = join(ctx.repoRoot, "_bmad", "_config", "manifest.yaml");
      const manifestSelection = manifestBmadModules(ctx.repoRoot);
      if (manifestSelection.status === "invalid") {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "BMAD module manifest is invalid; refusing fallback module selection",
          changedFiles: [],
          details: [manifestSelection.error],
        };
      }
      const selectedModules = manifestSelection.status === "valid"
        ? manifestSelection.modules
        : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];

      if (ctx.dryRun) {
        return {
          id: finding.id,
          title: finding.title,
          status: "applied",
          summary: `Would upgrade BMAD ${installed ?? "?"} -> ${available ?? BMAD_TARGET_CHANNEL}`,
          changedFiles: [manifestPath],
          details: [
            `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL)}`,
          ],
        };
      }

      const install = runBmadInstall(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL);
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
      const evictedChanges: string[] = [];
      const evicted = evictLegacyBmadPackState(ctx, evictedChanges, await skillActivations(ctx));

      const nowInstalled = readInstalledBmadVersion(ctx.repoRoot);
      const upgraded = Boolean(nowInstalled && installed && compareBmadVersions(nowInstalled, installed) > 0);
      const changed = Array.from(new Set([
        ...(upgraded ? [manifestPath] : []),
        ...evictedChanges,
      ]));
      return {
        id: finding.id,
        title: finding.title,
        status: changed.length ? "applied" : "noop",
        summary: upgraded ? `Upgraded BMAD ${installed} -> ${nowInstalled}` : `BMAD reinstalled (${nowInstalled ?? "?"})`,
        changedFiles: changed,
        details: evicted,
      };
    },
  },
  {
    id: "bmad.cli-roots",
    title: "Supported BMAD CLI projection roots",
    audit: (ctx) => {
      const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS) as (keyof typeof UNSUPPORTED_BMAD_ROOTS)[];
      const present = unsupportedNames.filter((name) => existsSync(join(ctx.repoRoot, name)));
      const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
      const plan = planSkillRoots(ctx.repoRoot);
      const supportedIssues = supportedCliProjectionIssues(ctx.repoRoot, plan);
      const gitignoreIssues = supportedCliGitignoreIssues(ctx.repoRoot);
      const details = [
        ...supportedIssues,
        ...plan.blocks.map((reason) => `blocked: ${reason}`),
        ...gitignoreIssues,
        ...attestations.map((entry) => `${entry.name}: ${entry.safe ? "generated and safely removable" : `ambiguous/user-owned — ${entry.reason}`}`),
      ];
      return {
        id: "bmad.cli-roots",
        title: "Supported BMAD CLI projection roots",
        status: details.length ? "fail" : "pass",
        summary: details.length
          ? `${supportedIssues.length} supported projection issue(s); ${gitignoreIssues.length} repository-ignore issue(s); ${present.length} unsupported root(s)`
          : "All six local CLI projections are configured, .agents is canonical, and no unsupported roots are present",
        details,
        fixable: attestations.every((entry) => entry.safe) && (!supportedIssues.length || plan.clean),
      };
    },
    migrate: (ctx, finding) => {
      const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS) as (keyof typeof UNSUPPORTED_BMAD_ROOTS)[];
      const present = unsupportedNames.filter((name) => existsSync(join(ctx.repoRoot, name)));
      const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
      const blocked = attestations.filter((entry) => !entry.safe);
      if (blocked.length) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Refusing to remove ambiguous or user-owned CLI projection roots",
          changedFiles: [],
          details: blocked.map((entry) => `${entry.name}: ${entry.reason}`),
        };
      }
      const projectionResult = ensureSupportedCliProjections(ctx);
      if (projectionResult.blockers.length) {
        // Clean roots were still converted; say so instead of claiming nothing changed.
        return {
          id: finding.id,
          title: finding.title,
          status: projectionResult.changedFiles.length ? "partial" : "blocked",
          summary: "Supported CLI projections contain unsafe or user-owned conflicts",
          changedFiles: projectionResult.changedFiles,
          details: [...projectionResult.details, ...projectionResult.blockers.map((reason) => `blocked: ${reason}`)],
        };
      }
      const gitignoreChanges = ensureSupportedCliGitignore(ctx);
      const removedRoots = attestations.map((entry) => join(ctx.repoRoot, entry.name));
      if (!ctx.dryRun) for (const path of removedRoots) rmSync(path, { recursive: true, force: true });
      const changedFiles = [...new Set([...projectionResult.changedFiles, ...gitignoreChanges, ...removedRoots])].sort();
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length
          ? `Reconciled six local projections, the .agents ignore contract, and ${removedRoots.length} attested unsupported root(s)`
          : "No changes required",
        changedFiles,
        details: [...projectionResult.details, ...attestations.map((entry) => `${entry.name}: ${entry.reason}`)],
      };
    },
  },
];
}


function createProjectMomoChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "momo-lifecycle-plane",
    title: "Momo lifecycle-plane readiness profile",
    audit: () => ({
      id: "momo-lifecycle-plane",
      title: "Momo lifecycle-plane readiness profile",
      status: "skip" as const,
      summary: "Momo readiness is an audit-only profile; use audit --profile momo-lifecycle-plane",
      details: [],
      fixable: false,
    }),
    migrate: (ctx, finding) => ({
      id: finding.id,
      title: finding.title,
      status: "skipped" as const,
      summary: "report-only profile; migration is intentionally skipped",
      changedFiles: [],
      details: ["Momo lifecycle-plane readiness checks are credential-bearing and are performed only by `audit --profile momo-lifecycle-plane`"],
    }),
  },
];
}



// ---------------------------------------------------------------------------
// board.schema — the project's Plane board matches the standard board schema
//
// pjangler owns board IDENTITY: `create_board` POSTs {name, identifier,
// description} and stops, so a board it creates carries Plane's bare defaults —
// five seeded states, no labels, no modules, module_view/cycle_view off. Making
// that board usable is ~10 minutes of clicking, per project, across 70+ boards.
//
// Pilot (`px`) owns board SCHEMA. This rule is the seam: audit asks px what it
// WOULD change (`--dry-run --json`, a pure read), and migrate lets it change it.
// No Plane write logic lives here — pjangler's own HTTP client is GET-only by
// design and this rule does not alter that.
//
// Two safety properties this rule must preserve, because migrateAll auto-selects
// every fixable finding (see recipes/registry.ts) and init runs it as a
// postcondition:
//
//   1. It must never GATE on a remote service. `registry.ts` treats anything but
//      pass/skip as a failed postcondition, and ProjectRecipe turns that into a
//      transaction error — so a warn here could ROLL BACK a brand-new project
//      because Plane blipped or `px` was not installed. Every "cannot tell"
//      path below therefore returns `skip`, never `warn`.
//   2. It must never destroy or re-home. migrate never passes `--prune` (which
//      deletes) or `--adopt-default` (which moves the default state and silently
//      re-homes new tickets on a board that already holds work). px suppresses
//      the latter on a non-empty board on its own; not passing the override is
//      the second lock.

const BOARD_SCHEMA_RULE_ID = "board.schema";

const BOARD_SCHEMA_TITLE = "Board schema";


interface PxPlan {
  ok?: boolean;
  board_has_work?: boolean;
  schema_file?: string;
  project?: { changed?: string[] };
  states?: PxCollectionPlan;
  labels?: PxCollectionPlan;
  modules?: PxCollectionPlan;
  failed?: { name?: string; action?: string; error?: string }[];
  error?: string;
}


interface PxCollectionPlan {
  created?: string[];
  updated?: { name?: string }[];
  unchanged?: string[];
  extra?: string[];
  suppressed?: { name?: string; field?: string; from?: unknown; to?: unknown }[];
}


function boardSchemaSkip(summary: string, details: string[] = []): AuditFinding {
  return { id: BOARD_SCHEMA_RULE_ID, title: BOARD_SCHEMA_TITLE, status: "skip", summary, details, fixable: false };
}


/** The `.project.json` ticket_provider, when it is a *linked Plane* board. */
function linkedPlaneBoard(ctx: Context): { boardId: string; workspace: string } | { skip: string } {
  const manifest = readProjectJson(ctx);
  if (!manifest) return { skip: "no .project.json — nothing binds a board here" };
  const provider = manifest.ticket_provider;
  if (!provider || typeof provider !== "object") return { skip: "no ticket_provider binding" };
  const facts = provider as Record<string, unknown>;

  const type = typeof facts.type === "string" ? facts.type.toLowerCase() : "plane";
  if (type !== "plane") return { skip: `ticket provider is ${type}; board schema is Plane-only` };

  const boardId = typeof facts.board_id === "string" ? facts.board_id.trim() : "";
  if (!boardId) return { skip: "board is not created yet (no board_id)" };
  if (facts.state !== "linked") return { skip: `board binding is "${String(facts.state ?? "unset")}", not linked` };

  const workspace = typeof facts.workspace === "string" && facts.workspace.trim() ? facts.workspace.trim() : "33god";
  return { boardId, workspace };
}


/** Run `px schema import` and parse its JSON. Never throws. */
function runPx(args: string[], ctx: Context): { plan?: PxPlan; error?: string } {
  const probe = spawnSync("which", ["px"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return { error: "px not found on PATH — install Pilot to manage board schemas" };
  }
  const result = spawnSync("px", args, {
    cwd: ctx.repoRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) return { error: `px failed to run: ${result.error.message}` };
  const raw = (result.stdout || "").trim();
  if (!raw) return { error: `px produced no output (exit ${result.status ?? "?"})` };
  const parsed = tryParseJson(raw) as PxPlan | null;
  if (!parsed) return { error: `px returned unparseable output (exit ${result.status ?? "?"})` };
  return { plan: parsed };
}


function planChanges(plan: PxPlan): { changes: string[]; suppressed: string[] } {
  const changes: string[] = [];
  const suppressed: string[] = [];
  for (const kind of ["states", "labels", "modules"] as const) {
    const collection = plan[kind];
    if (!collection) continue;
    const created = collection.created ?? [];
    const updated = (collection.updated ?? []).map((entry) => entry?.name).filter((name): name is string => Boolean(name));
    if (created.length) changes.push(`${kind}: create ${created.join(", ")}`);
    if (updated.length) changes.push(`${kind}: update ${updated.join(", ")}`);
    for (const held of collection.suppressed ?? []) {
      suppressed.push(`${held.name}.${held.field}: ${String(held.from)} -> ${String(held.to)}`);
    }
  }
  const features = plan.project?.changed ?? [];
  if (features.length) changes.push(`project features: ${features.join(", ")}`);
  return { changes, suppressed };
}


export function createBoardSchemaChecks(): RecipeOwnedCheck[] {
  return [
    {
      id: BOARD_SCHEMA_RULE_ID,
      title: BOARD_SCHEMA_TITLE,
      audit: (ctx: Context): AuditFinding => {
        const board = linkedPlaneBoard(ctx);
        if ("skip" in board) return boardSchemaSkip(board.skip);

        const { plan, error } = runPx(
          ["schema", "import", "--dry-run", "--json", "--board", board.boardId, "--workspace", board.workspace],
          ctx,
        );
        // Every failure to READ the board is a skip, not a warn: this rule runs
        // as an init postcondition and a warn would roll the project back.
        if (error) return boardSchemaSkip(`could not read board schema: ${error}`);
        if (!plan || plan.ok === false) {
          return boardSchemaSkip(`px could not plan a schema apply: ${plan?.error ?? "unknown error"}`);
        }

        const { changes, suppressed } = planChanges(plan);
        const details = [...changes];
        if (suppressed.length) {
          details.push(
            `held back (board has work; would re-home new tickets): ${suppressed.join("; ")}`,
          );
        }
        if (plan.schema_file) details.push(`schema: ${plan.schema_file}`);

        if (!changes.length) {
          return {
            id: BOARD_SCHEMA_RULE_ID,
            title: BOARD_SCHEMA_TITLE,
            status: "pass",
            summary: "board matches the standard schema",
            details,
            fixable: false,
          };
        }
        return {
          id: BOARD_SCHEMA_RULE_ID,
          title: BOARD_SCHEMA_TITLE,
          status: "warn",
          summary: `${changes.length} board schema difference(s)`,
          details,
          fixable: true,
        };
      },
      migrate: (ctx: Context, finding: AuditFinding): MigrationRuleResult => {
        const base = { id: BOARD_SCHEMA_RULE_ID, title: BOARD_SCHEMA_TITLE, changedFiles: [] as string[] };
        const board = linkedPlaneBoard(ctx);
        if ("skip" in board) return { ...base, status: "skipped", summary: board.skip, details: [] };

        if (ctx.dryRun) {
          return {
            ...base,
            status: "applied",
            summary: "would apply the standard board schema",
            details: finding.details,
          };
        }

        // Deliberately no --prune and no --adopt-default: an automated repair
        // may add and align, never delete a state or move where new tickets land.
        const { plan, error } = runPx(
          ["schema", "import", "--json", "--board", board.boardId, "--workspace", board.workspace],
          ctx,
        );
        if (error) return { ...base, status: "blocked", summary: error, details: [] };
        if (!plan || plan.ok === false) {
          const failures = (plan?.failed ?? []).map((f) => `${f.action} ${f.name}: ${f.error}`);
          return {
            ...base,
            status: failures.length ? "partial" : "blocked",
            summary: plan?.error ?? "px could not apply the schema",
            details: failures,
          };
        }

        const { changes, suppressed } = planChanges(plan);
        const details = [...changes];
        if (suppressed.length) {
          details.push(`left alone (board has work): ${suppressed.join("; ")}`);
        }
        return {
          ...base,
          // changedFiles stays empty ON PURPOSE: this migration writes to a
          // remote board, not to the repository. Reporting a file here would be
          // a lie, and every other rule's changedFiles is a real path.
          status: changes.length ? "applied" : "noop",
          summary: changes.length
            ? `applied ${changes.length} board schema change(s)`
            : "board already matched the standard schema",
          details,
        };
      },
    },
  ];
}


export function createProjectChecks(): RecipeOwnedCheck[] {
  return [
    ...createProjectJsonChecks(),
    ...createProjectProvenanceChecks(),
    ...createProjectMomoChecks(),
    ...createBoardSchemaChecks(),
  ];
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
  // PJAN-84: a host finding no longer fails the repo, so it has to be visible on
  // its own line — otherwise "Parity audit passed" would be the only thing an
  // operator reads while their machine's shared state is broken.
  const hostTrouble = report.rules.filter((rule) => rule.scope === "host" && (rule.status === "fail" || rule.status === "warn"));
  if (hostTrouble.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("This machine needs attention")}  ${dim(glyph.dot)}  ${dim("not this project — these cannot be fixed from here")}`);
    for (const rule of hostTrouble) lines.push(`     ${dim(glyph.arrow)} ${rule.id}: ${rule.summary}`);
  }
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
  const blocked = report.results.filter((result) => result.status === "blocked").length;
  const partial = report.results.filter((result) => result.status === "partial").length;

  // PJAN-75: "Migration complete" is now a claim the run has verified, so the
  // not-ok case has to say WHICH kind of unfinished it is. A blocker means the
  // rule refused to act; a partial means it acted and still did not reach
  // parity, which is the state that used to be reported as success.
  const overall = report.ok
    ? `${green(glyph.pass)} ${bold(report.dryRun ? "Migration preview complete" : "Migration complete")}`
    : blocked
      ? `${red(glyph.fail)} ${bold("Migration finished with blockers")}`
      : `${yellow(glyph.warn)} ${bold(`Migration incomplete  ${glyph.dot}  ${partial} rule${partial === 1 ? "" : "s"} still failing`)}`;

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
  const unresolved = partial + blocked;
  if (unresolved) {
    lines.push("");
    lines.push(`  ${dim(`Run \`pjangler audit\` for the full detail on the ${unresolved} rule${unresolved === 1 ? "" : "s"} still failing.`)}`);
  }
  lines.push("");
  return lines.join("\n");
}


// ─────────────────────────────────────────────────────────────────────────────
// Interactive rule picker presentation
//
// Presentation only: this never decides *which* rules are offered or in what
// order — the caller owns that. It just turns an already-selected list of
// findings into the label/hint pairs @clack's multiselect renders.
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the interactive rule picker, in @clack `Option` shape. */
export interface RulePickerChoice {
  value: string;
  label: string;
  hint?: string;
}


export interface RulePicker {
  message: string;
  options: RulePickerChoice[];
}


/**
 * Widest hint the picker will emit before eliding, and the widest title column
 * it will pad to. Both are caps, not targets: rule titles run from ~20 to ~70
 * characters, and padding every row out to the longest one turns a short list
 * into a field of whitespace and pushes rows past any sane terminal width.
 * Titles longer than the cap are never truncated — that row just goes ragged.
 */
const RULE_HINT_WIDTH = 72;

const RULE_TITLE_COLUMN = 44;


/**
 * Row-width budget. @clack never wraps, so an over-long row is the terminal's
 * problem — we keep rows near a comfortable width instead. Fixed rather than
 * read from `process.stdout.columns`: the picker only ever runs on a TTY, but a
 * deterministic layout is worth more than a responsive one here (it keeps the
 * rendering reproducible in tests and identical across operators' terminals).
 */
const RULE_ROW_TARGET = 116;

const RULE_HINT_MIN = 28;

/** @clack's own gutter + checkbox prefix ("│  ◼ "), plus our " (...)" wrapper. */
const RULE_ROW_CHROME = 7;


function elide(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1)).trimEnd()}…`;
}


/**
 * Fold a finding's summary + details into ONE bounded line. @clack renders a
 * hint only for the focused row and for already-selected rows, so this is the
 * progressive-disclosure layer: enough context to decide, never enough to bury
 * the list. `pjangler audit` stays the full-detail surface, which is why the
 * header points at it.
 *
 * Detail policy: a lone detail IS the whole story, so it is shown inline; two
 * or more collapse to a count. Every failing rule is pre-selected, so inlining
 * detail text unconditionally would put a paragraph on nearly every row — the
 * exact wall of text this ticket removes.
 *
 * Deliberately un-colored: @clack wraps hints in its own dim(), and nesting our
 * SGR codes inside that renders inconsistently across terminals.
 */
function ruleHint(rule: AuditFinding, budget: number): string | undefined {
  const summary = rule.summary.replace(/\s+/g, " ").trim();
  const fragments: string[] = [];
  if (summary) fragments.push(summary);
  if (rule.details.length === 1) {
    fragments.push(`${glyph.arrow} ${rule.details[0]}`);
  } else if (rule.details.length > 1) {
    fragments.push(`${glyph.arrow} ${rule.details.length} details`);
  }
  const hint = elide(fragments.join(` ${glyph.dot} `), budget);
  return hint || undefined;
}


/**
 * Compose the interactive rule picker.
 *
 * Row anatomy — the human sentence leads so the list is scannable, the rule id
 * stays visible (dim, in a column) because the operator still needs it for
 * `pjangler migrate <rule-id>`, and status drives both icon and color so a
 * failing rule is obvious. The icon carries the distinction on its own, so a
 * NO_COLOR / non-TTY terminal (where `src/utils/style` degrades every color
 * helper to identity) loses no information:
 *
 *   ✖ Canonical .project.json         sot.project-json   (1 parity issue …)
 *   ✔ managed mise versioning block   mise.versioning
 */
export function formatRulePicker(rules: AuditFinding[]): RulePicker {
  const titleColumn = Math.min(
    RULE_TITLE_COLUMN,
    rules.reduce((width, rule) => Math.max(width, rule.title.length), 0),
  );

  const options = rules.map((rule) => {
    const style = statusStyle(rule.status);
    // Pad OUTSIDE the color run, so a row never carries styled trailing space.
    const pad = " ".repeat(Math.max(0, titleColumn - rule.title.length));
    const headline =
      rule.status === "fail"
        ? bold(style.color(rule.title))
        : rule.status === "warn"
          ? style.color(rule.title)
          : rule.status === "skip"
            ? dim(rule.title)
            : rule.title;

    // Give the hint whatever row budget the label did not spend, so a long
    // title costs detail rather than overflowing the terminal.
    const labelWidth = 2 + rule.title.length + pad.length + 2 + rule.id.length;
    const budget = Math.min(RULE_HINT_WIDTH, Math.max(RULE_HINT_MIN, RULE_ROW_TARGET - RULE_ROW_CHROME - labelWidth));

    return {
      value: rule.id,
      label: `${style.color(style.glyph)} ${headline}${pad}  ${dim(rule.id)}`,
      hint: ruleHint(rule, budget),
    };
  });

  return { message: formatRulePickerMessage(rules), options };
}


/**
 * Header line: a status tally so the operator knows what they're looking at
 * before scanning, plus a pointer to the full-detail surface. @clack already
 * prints its own "press space to select, enter to submit" instructions, so we
 * do not repeat them. Single line by construction — a newline here would break
 * @clack's frame.
 */
function formatRulePickerMessage(rules: AuditFinding[]): string {
  const counts: Record<string, number> = {};
  for (const rule of rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;

  const fragments: string[] = [];
  if (counts.fail) fragments.push(red(`${counts.fail} failing`));
  if (counts.warn) fragments.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.pass) fragments.push(green(`${counts.pass} passing`));
  if (counts.skip) fragments.push(gray(`${counts.skip} skipped`));
  fragments.push(dim("`pjangler audit` for full detail"));

  return `Select parity rules to apply  ${joinDot(fragments)}`;
}
