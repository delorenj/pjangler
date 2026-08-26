import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { bold, dim, green, red, yellow, gray, glyph, statusStyle, joinDot } from "../utils/style";
import { SUPPORTED_BMAD_TOOLS, SUPPORTED_CLI_ROOTS } from "../recipes/supported-clis";
import {
  PackUnavailableError,
  assertNoSymlinkComponents,
  assertRealDirectory,
  isRegularFile,
  normalizePackEntry,
  readRegularFile,
  readPackMetadata,
  safeRelativePath,
  selectPackVersion,
  validatePack,
  validatePathComponent,
  type PackManifestEntry,
  type ValidatedPack,
} from "./pack";

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
  audit: (ctx: Context) => AuditFinding;
  migrate: (ctx: Context, finding: AuditFinding) => MigrationRuleResult;
}

// mise runs each hook `script`/task `run` value through `sh -c`, expanding the
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
const LEGACY_PROVISION_TASK = "skills-provision-bmad";
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
// PACKS-CONTRACT section 7: the old schemas host 404s. It is accepted on read
// (so an un-migrated repo still audits) but always rewritten by migrate/init.
const SKILLS_SCHEMA_URL = "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json";
const RETIRED_SKILLS_SCHEMA_URLS = [
  "https://raw.githubusercontent.com/skillex/schemas/main/skills.schema.json",
];
const CODEGRAPH_SCRIPT =
  "[ -f '{{config_root}}/.mise/scripts/codegraph.sh' ] && '{{config_root}}/.mise/scripts/codegraph.sh' || true";
const SKILLS_REGISTRY_URL = "https://github.com/delorenj/skillex.git";
// PJAN-28: legacy committed skills are moved here — never deleted — when
// `migrate skills.project-manifest --accept-registry-matches` maps them into
// `.agents/skills.json`. It is a SIBLING of `.agents/skills`, so the audit walk
// (which only reads `.agents/skills`) can never see its own backups and loop.
// Deliberately NOT added to any managed `.gitignore` block: an entry mapped to
// `file://.../.agents/skills.bak/<name>` is the manifest's source of truth for
// that skill, so ignoring it would break every other clone of the repo.
const SKILLS_BACKUP_DIRNAME = "skills.bak";
// Directories inside a registry checkout that may hold a skill by bare name.
// `all-skills/<name>` is the shorthand sync-skills.py expands a bare string
// manifest entry into, so it is the primary and first-checked location.
const SKILLS_REGISTRY_SKILL_DIRS = ["all-skills", "skills"] as const;
// PJAN-28 targets legacy NON-BMAD committed skills. Everything under the
// `bmad-` namespace already has an owner: pinned pack names are validated as
// symlinks by this same rule, and off-pack `bmad-*` trees (e.g. bmad-build from
// a newer bmad-method installer writing through the .claude/skills alias) are
// re-materialized by `bmad.scaffold` on every run. Mapping those into the
// manifest and backing them up would be undone by the next BMAD install and
// re-reported forever — the same drift loop the backup dir exists to avoid.
const BMAD_SKILL_NAME_PREFIX = "bmad-";
/**
 * PJAN-82: pack names the contract forbids anyone to declare.
 *
 * PJAN-76 settled that BMAD is owned by `bmad-method install` and is never a
 * Skillex pack "on either side"; skillex deleted `packs/bmad` accordingly. But a
 * repo that still declared `packs: [{name: "bmad"}]` could not be repaired at
 * all: provisioning the declared packs runs FIRST, the pack resolves nowhere, and
 * the whole skills.project-manifest migration returned `blocked`. docsidian sat
 * on 528 dangling links behind that single dead declaration with no way through.
 *
 * A declaration the contract forbids is dropped, not obeyed — otherwise the
 * unresolvable thing gets a veto over its own removal.
 */
const RETIRED_PACK_NAMES: ReadonlySet<string> = new Set(["bmad"]);

function retiredPackDeclarations(manifest: Record<string, unknown> | null | undefined): string[] {
  const packs = manifest?.packs;
  if (!Array.isArray(packs)) return [];
  const names: string[] = [];
  for (const entry of packs) {
    const name = typeof entry === "string"
      ? entry
      : (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
        ? (entry as { name: string }).name
        : undefined);
    if (name && RETIRED_PACK_NAMES.has(name)) names.push(name);
  }
  return names;
}

/** Strip forbidden pack declarations, returning the dropped names. */
function dropRetiredPackDeclarations(manifestPath: string, dryRun: boolean): string[] {
  const raw = safeReadText(manifestPath);
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return []; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const manifest = parsed as Record<string, unknown>;
  const dropped = retiredPackDeclarations(manifest);
  if (!dropped.length) return [];
  manifest.packs = (manifest.packs as unknown[]).filter((entry) => {
    const name = typeof entry === "string"
      ? entry
      : (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
        ? (entry as { name: string }).name
        : undefined);
    return !(name && RETIRED_PACK_NAMES.has(name));
  });
  if (!dryRun) writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return dropped;
}
// PACKS-CONTRACT section 6b: exactly six supported agent CLIs, project scope.
// `.augment`, `.hermes`, `.openclaw`, `.kimi`, `.crush` and `.cursor` are
// RETIRED — sync-skills.py never writes them again, so their topology is no
// longer pjangler's to police (and never was pjangler's to delete).
const PROJECT_CLI_SKILL_DIRS = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".opencode/skills",
  ".kimi-code/skills",
] as const;
const CANONICAL_CLI_SKILLS_ALIAS = "../.agents/skills";

const HOOKS_COMMENT_HEADER = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.`;

// Canonical managed enter-hook commands, always installed (space-safe).
const LINK_AGENTFILES_HOOK_ENTRIES = [
  LINK_AGENTFILES_SCRIPT,
  PROVISION_PACKS_SCRIPT,
  SYNC_SKILLS_SCRIPT,
];

const LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
patterns = ["AGENTS.md"]
task = "${LINK_AGENTFILES_TASK}"

[[watch_files]]
patterns = [".agents/skills.json"]
task = "${SKILLS_SYNC_TASK}"

${taskHeader(LINK_AGENTFILES_TASK)}
description = "Symlink all agent files to AGENTS.md"
run = ${JSON.stringify(LINK_AGENTFILES_SCRIPT)}

${taskHeader(SKILLS_SYNC_TASK)}
description = "Sync skills from manifest to local CLI dirs"
depends = ["${PROVISION_PACKS_TASK}"]
run = ${JSON.stringify(SYNC_SKILLS_SCRIPT)}

${taskHeader(PROVISION_PACKS_TASK)}
description = "Provision every Skillex pack declared in .agents/skills.json"
run = ${JSON.stringify(PROVISION_PACKS_SCRIPT)}`;

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
        bloodbankEnabled: yamlGet(text, "bloodbank.enabled"),
        deploymentSystemd: yamlGet(text, "deployment.systemd"),
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

// Retired per-agent command-ingress contract. The fleet-shared Bloodbank
// gateway owns command routing (registry `gateways.bloodbank`, routed by
// data.target_agent_id); per-agent consumer units and checkpoint timers are
// legacy. This constant is the ONLY place the legacy key names may appear —
// tests/fleet-shared-bloodbank-regressions.mjs enforces that scoping so the
// legacy contract can be detected and cleaned but never provisioned again.
const LEGACY_SYSTEMD_KEYS = ["consumer_unit", "checkpoint_timer"] as const;

function legacyConsumerUnitPath(homeDir: string, agentId: string): string {
  return join(homeDir, ".config", "systemd", "user", `hermes-${agentId}-consumer.service`);
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

interface SkillManifestEntry {
  name: string;
  source: string;
}

function validateSkillName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename(name) !== name) {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
  return name;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isContainedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

function prepareSafeProjectSkillsDirs(ctx: Context): { agentsDir: string; skillsDir: string } {
  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsDir = join(projectRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");
  for (const path of [agentsDir, skillsDir]) {
    if (!isContainedBy(projectRoot, path)) throw new Error(`Project skills path escapes repository: ${path}`);
    const stat = lstatIfPresent(path);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlinked project skills directory: ${path}`);
    if (stat && !stat.isDirectory()) throw new Error(`Project skills path is not a directory: ${path}`);
  }
  if (!ctx.dryRun) {
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: false });
    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: false });
    for (const path of [agentsDir, skillsDir]) {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
        throw new Error(`Unsafe project skills directory after creation: ${path}`);
      }
      if (!isContainedBy(projectRoot, realpathSync(path))) {
        throw new Error(`Resolved project skills directory escapes repository: ${path}`);
      }
    }
  }
  return { agentsDir, skillsDir };
}

function projectSkillTopologyIssues(repoRoot: string): string[] {
  const issues: string[] = [];
  let projectRoot: string;
  try {
    projectRoot = realpathSync(repoRoot);
  } catch (error) {
    return [`Project root is not a readable real directory: ${error instanceof Error ? error.message : String(error)}`];
  }
  const managedSkills = join(projectRoot, ".agents", "skills");

  for (const rel of PROJECT_CLI_SKILL_DIRS) {
    const cliDir = join(projectRoot, rel);
    const parent = dirname(cliDir);
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

// ---------------------------------------------------------------------------
// Skillex packs (PACKS-CONTRACT sections 2, 3, 5 and 6)
//
// A repo declares packs in `.agents/skills.json` `packs[]`. Their members are
// projected into `.agents/skills/<name>` as symlinks and are NOT expanded into
// `skills[]`. Nothing is pinned implicitly: a repo that declares no packs gets
// no pack projections.
// ---------------------------------------------------------------------------

/** Per-pack root override, e.g. `PJ_PACK_ROOT_HERMES_BASE=/tmp/pack`. */
function packRootOverride(name: string): string | undefined {
  const generic = process.env[`PJ_PACK_ROOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]?.trim();
  return generic ? resolve(generic) : undefined;
}

/**
 * The projection target for one pack member.
 *
 * Contract section 3b makes `<root>/<name>` WRONG for a flattened pack, so this
 * is the only place a member path may come from. Deriving it from the name
 * again anywhere else is exactly how the two engines would drift.
 */
function packMemberPath(pack: ValidatedPack, name: string): string {
  const target = pack.memberPaths.get(validateSkillName(name));
  if (!target) throw new Error(`Pack ${pack.name} has no resolved path for member ${JSON.stringify(name)}`);
  return target;
}

/** Stable, order-sensitive identity of a pack's projection, for revalidation. */
function packProjectionSignature(pack: ValidatedPack): string {
  return JSON.stringify(pack.members.map((name) => [name, pack.memberPaths.get(name) ?? null]));
}

/**
 * The one normalization that turns a registry URL into its registry-cache
 * directory name.
 *
 * This is a WIRE FORMAT, not an implementation detail: three independent
 * surfaces address the same directory on the same machine and must compute
 * byte-identical names, or one manifest resolves to two different checkouts —
 * and one of them may be a stale, unsealed clone that gets zero integrity
 * checking. The other two surfaces are:
 *
 *   - `sync-skills.py`   -> `registry_cache_dir()`:
 *         `re.sub(r"[^a-zA-Z0-9]", "_", registry_url)`
 *   - skillex `paths.py` -> `sanitize_registry_url()`:
 *         `re.sub(r"[^a-zA-Z0-9]", "_", url)`
 *
 * `sync-skills.py` is the only surface allowed to CLONE, so it owns the name on
 * disk; pjangler and skillex are read-only consumers and follow it. Every
 * non-alphanumeric byte becomes `_`, so the result is always exactly one safe
 * path component — no separator, no `.`, no `..`.
 *
 * Do not "improve" this here alone. `tests/registry-cache-parity-regressions`
 * fails the build if the three surfaces disagree.
 */
export function registryCacheDirName(registryUrl: string): string {
  const cacheName = registryUrl.replace(/[^a-zA-Z0-9]/g, "_");
  if (!cacheName) {
    throw new Error(`Registry URL has no usable cache directory name: ${JSON.stringify(registryUrl)}`);
  }
  return cacheName;
}

/**
 * Registry checkout roots for pack resolution, in contract order.
 *
 * An audit must NEVER clone or fetch, so an absent checkout means "unavailable",
 * not "go get it". `sync-skills.py` is the only thing allowed to clone.
 */
function packRegistryRoots(ctx: Context, registryUrl: string): string[] {
  const explicit = process.env.PJ_SKILLS_REGISTRY_ROOT?.trim();
  if (explicit) return [resolve(explicit)];
  const cacheName = registryCacheDirName(registryUrl);
  return [
    join(ctx.homeDir, ".agents", ".cache", "registries", cacheName),
    join(ctx.homeDir, "code", "skillex"),
  ];
}

/**
 * THE pack root resolver (contract section 2).
 *
 * Every pack — declared in `packs[]` or supplied by pjangler itself, like the
 * implicit BMAD pin — walks this one ladder, so a given pack name resolves to a
 * single root per process. Two ladders would mean `bmad@X` could mean the sync
 * cache when declared and the developer checkout when implicit, which silently
 * breaks every identity comparison built on the root (ownership, redundancy
 * pruning, projection targets).
 */
function resolvePackRoot(ctx: Context, entry: PackManifestEntry): { root: string; description: string } {
  const override = packRootOverride(entry.name);
  if (override) {
    assertRealDirectory(override, `Pack ${entry.name} root`);
    return { root: override, description: "env override" };
  }

  if (entry.source) {
    if (entry.source.startsWith("file:")) {
      let local: string;
      try {
        local = resolve(fileURLToPath(entry.source));
      } catch (error) {
        throw new Error(`Pack ${entry.name} source is not a usable file URI: ${entry.source}`);
      }
      assertRealDirectory(local, `Pack ${entry.name} root`);
      return { root: local, description: entry.source };
    }
    // git/https packs live in the sync engine's clone cache. Parity never clones.
    const cached = join(ctx.homeDir, ".agents", ".cache", "skills", validatePathComponent(entry.name, "Pack name"));
    assertRealDirectory(cached, `Pack ${entry.name} clone cache`);
    return { root: cached, description: entry.source };
  }

  const registryUrl = entry.registry ?? SKILLS_REGISTRY_URL;
  const matches: RegistryPackMatch[] = [];
  let firstUnavailable: PackUnavailableError | undefined;

  for (const candidate of packRegistryRoots(ctx, registryUrl)) {
    const stat = lstatIfPresent(candidate);
    if (!stat || !(stat.isDirectory() || (stat.isSymbolicLink() && existsSync(candidate)))) continue;
    try {
      matches.push(resolvePackRootInRegistry(realpathSync(candidate), entry));
    } catch (error) {
      // "This checkout does not carry the pack" is precisely what an ordered
      // candidate list is FOR — keep walking. Anything else (a symlinked path
      // component, an escape, a `pack.toml` that is not a regular file) is
      // hostile rather than absent, and must never be masked by silently
      // falling through to a different checkout.
      if (!(error instanceof PackUnavailableError)) throw error;
      firstUnavailable ??= error;
    }
  }

  if (!matches.length) {
    throw firstUnavailable ?? new PackUnavailableError(`No registry checkout available for ${registryUrl}`);
  }
  // Contract order already decided `matches`; attestation only promotes within it.
  const chosen = matches.find((match) => match.attested) ?? matches[0]!;
  return { root: chosen.root, description: `${registryUrl}:${chosen.relativePath}` };
}

interface RegistryPackMatch {
  root: string;
  relativePath: string;
  /** The root carries a `pack.toml` that positively identifies this entry. */
  attested: boolean;
}

/**
 * Does this pack root carry a `pack.toml` that positively attests `entry`?
 *
 * Contract section 3 makes `pack.toml` the AUTHORITATIVE identity and inventory
 * of a pack; a bare `packs/<name>/<version>/` directory is an unattested claim
 * resting on nothing but a directory name that anyone can create. Several
 * checkouts routinely carry the same `packs/<name>/<version>/` path while only
 * one of them holds the RENDERED pack — that is the NORMAL state while a pack is
 * being cut, because the sync cache is a clone of what has been *pushed*.
 *
 * Ranking attested above unattested is what stops `[policy] sealed = true` from
 * being silently downgraded to "unsealed, structural checks only" by whichever
 * checkout happens to sort first. It can only ever TIGHTEN: contract order still
 * breaks every tie, so a sealed pack in a higher-priority checkout always wins,
 * and a lower-priority checkout can never demote one (unattested is strictly the
 * lower rank). A manifest `sealed: true` is likewise unaffected — it is enforced
 * against whichever root wins, and an unsealable root simply fails.
 */
function packRootAttests(root: string, entry: PackManifestEntry): boolean {
  // Throws (does NOT return false) when pack.toml exists but is a symlink, is
  // not a regular file, or does not parse — those are hard errors everywhere
  // else and must not be downgraded into "just not attested".
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

/**
 * Resolve `entry` inside ONE registry checkout (contract section 2 step 2).
 *
 * Throws `PackUnavailableError` when this checkout simply does not carry the
 * pack, and a hard error for anything unsafe. Every guard runs against the root
 * that is actually returned.
 */
function resolvePackRootInRegistry(registryRoot: string, entry: PackManifestEntry): RegistryPackMatch {
  let relativePath: string;
  if (entry.registryPath) {
    relativePath = safeRelativePath(entry.registryPath, `pack ${entry.name} registry_path`);
  } else {
    relativePath = `packs/${entry.name}`;
    const packDir = join(registryRoot, relativePath);
    assertNoSymlinkComponents(registryRoot, relativePath);
    assertRealDirectory(packDir, `Pack ${entry.name} directory`);
    if (entry.version) {
      relativePath = `${relativePath}/${entry.version}`;
    } else if (!isRegularFile(join(packDir, "pack.toml"))) {
      // The ONLY implicit choice in the contract: highest version directory.
      const selected = selectPackVersion(packDir);
      if (selected !== null) relativePath = `${relativePath}/${selected}`;
    }
  }

  assertNoSymlinkComponents(registryRoot, relativePath);
  const root = join(registryRoot, relativePath);
  assertRealDirectory(root, `Pack ${entry.name} root`);
  return { root, relativePath, attested: packRootAttests(root, entry) };
}

interface ResolvedPackPlanEntry {
  entry: PackManifestEntry;
  root: string;
  pack: ValidatedPack;
  /** `packs/<name>` when the pack lives under a version directory. */
  familyRoot?: string;
}

interface PackPlan {
  /**
   * Pack skills recorded in `skills[]`. Always empty now that nothing is
   * pinned implicitly — declared packs project into `.agents/skills` and are
   * deliberately NOT expanded into `skills[]` (PACKS-CONTRACT section 3).
   * Kept so the manifest writer keeps one shape for both.
   */
  manifestSkills: SkillManifestEntry[];
  /** Every projection to materialize in `.agents/skills`: name -> target dir. */
  projections: Map<string, string>;
  /** Roots that own a `skills[]` entry or a `.agents/skills` symlink. */
  ownershipRoots: string[];
  resolved: ResolvedPackPlanEntry[];
  /** Declared packs that resolved and validated (used for redundancy checks). */
  declared: ResolvedPackPlanEntry[];
  errors: string[];
  /** Optional packs that were unavailable and skipped (contract section 1). */
  warnings: string[];
  /**
   * Advisories from a pack that resolved fine — today, section 3b's "this
   * container projects nothing" and "this container child is a symlink". Kept
   * apart from `warnings` because those two mean different things to the audit
   * summary, and because a pack advisory must not read as a skipped pack.
   */
  packWarnings: string[];
}

function manifestPackEntries(manifest: Record<string, unknown> | null | undefined): {
  entries: PackManifestEntry[];
  errors: string[];
} {
  const raw = manifest?.packs;
  if (raw === undefined || raw === null) return { entries: [], errors: [] };
  if (!Array.isArray(raw)) return { entries: [], errors: [".agents/skills.json packs must be an array"] };
  const entries: PackManifestEntry[] = [];
  const errors: string[] = [];
  for (const item of raw) {
    try {
      entries.push(normalizePackEntry(item));
    } catch (error) {
      errors.push(`.agents/skills.json packs[] entry is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}

/**
 * Resolve and validate every pack this repo projects.
 *
 * Nothing here mutates anything: a plan is built (and every integrity failure
 * collected) BEFORE the caller is allowed to touch the project, which is what
 * keeps "one unsafe or broken pack produces zero mutation" true.
 */
function buildPackPlan(ctx: Context, manifest: Record<string, unknown> | null | undefined): PackPlan {
  const plan: PackPlan = {
    manifestSkills: [],
    projections: new Map(),
    ownershipRoots: [],
    resolved: [],
    declared: [],
    errors: [],
    warnings: [],
    packWarnings: [],
  };

  const { entries, errors } = manifestPackEntries(manifest);
  plan.errors.push(...errors);
  // Declared packs, in array order — a later pack wins a name collision.
  for (const entry of entries) {
    try {
      const { root } = resolvePackRoot(ctx, entry);
      const pack = validatePack(root, entry);
      const familyRoot = basename(dirname(root)) === entry.name ? dirname(root) : undefined;
      const resolved: ResolvedPackPlanEntry = { entry, root, pack, familyRoot };
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

  // PACKS-CONTRACT section 5: an explicit `skills[]` entry ALWAYS overrides a
  // pack member of the same name. Only entries that survive section 6 pruning
  // count — a redundant entry pointing INTO the pack is not an override, and the
  // implicit BMAD expansion is pjangler's own output, not a user override.
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

/**
 * Re-validate every pack the plan projected.
 *
 * Called at the mutation boundary so a pack tampered with between preflight and
 * apply is caught, and the transaction rolled back.
 */
function assertPackPlanUnchanged(plan: PackPlan): void {
  for (const item of plan.resolved) {
    const again = validatePack(item.root, item.entry);
    // Names AND paths: under section 3b a member can move between containers
    // without its name changing, which would silently repoint a live symlink.
    if (packProjectionSignature(again) !== packProjectionSignature(item.pack)) {
      throw new Error(`Pack ${item.entry.name} inventory changed after preflight`);
    }
  }
}

function skillManifestEntryName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const name = (entry as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

function manifestEntrySourcePath(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const source = (entry as Record<string, unknown>).source;
  if (typeof source !== "string" || !source.startsWith("file:")) return undefined;
  try {
    return resolve(fileURLToPath(source));
  } catch {
    return undefined;
  }
}

/**
 * A `skills[]` entry left behind by the retired Skillex `bmad` pin.
 *
 * Deliberately narrow on BOTH axes. The name must be in the `bmad-*` namespace
 * the installer owns, AND the source must point into a `packs/bmad/` tree —
 * which is the shape pjangler itself used to write and the only shape that is
 * unambiguously stale, since the registry no longer carries that pack at all.
 *
 * Matching on the name alone would evict a skill the user wrote and keeps in
 * their own repo just because they named it `bmad-something`. That entry is
 * theirs, it resolves, and nothing else claims the path.
 */
function isRetiredBmadPackEntry(entry: unknown): boolean {
  const name = skillManifestEntryName(entry);
  if (!name || !name.startsWith(BMAD_SKILL_NAME_PREFIX)) return false;
  const source = manifestEntrySourcePath(entry);
  return Boolean(source && /(^|\/)packs\/bmad\//.test(source));
}

function isPackManagedManifestEntry(entry: unknown, expectedNames: Set<string>, packRoots: string[]): boolean {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  if (expectedNames.has(name)) return true;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  return basename(sourcePath) === name && packRoots.some((root) => isContainedBy(root, sourcePath));
}

/**
 * PACKS-CONTRACT section 6: declaring a pack REPLACES hand-expanded per-skill
 * entries for that pack's members.
 *
 * Deliberately narrow. An entry only counts as redundant when its own resolved
 * source lands inside the pack (or, for a declared member name, inside any
 * version of the same pack). An entry pointing anywhere else — a local tree, a
 * different registry, a customized copy — is the user's and is never removed.
 *
 * The family-root arm matches `inventoryNames` — under section 3b those are the
 * FLATTENED names, because that is what the pack PROVIDES and clause (b) asks
 * what a pack provides. The container names it was declared with are an
 * implementation detail of the pack's on-disk layout, and no `skills[]` entry is
 * ever named after one, so they deliberately do NOT match. Clause (a) is
 * unaffected: a leaf at `<root>/apple/apple-notes` is still contained by
 * `<root>`. With flatten off, `inventoryNames` IS the declared list, so nothing
 * about a pre-existing pack changes.
 */
function isRedundantDeclaredPackEntry(entry: unknown, plan: PackPlan): boolean {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  for (const declared of plan.declared) {
    if (isContainedBy(declared.pack.root, sourcePath)) return true;
    if (
      declared.familyRoot &&
      declared.pack.inventoryNames.includes(name) &&
      isContainedBy(declared.familyRoot, sourcePath)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalSkillsManifest(
  ctx: Context,
  current?: Record<string, unknown> | null,
  plan: PackPlan = buildPackPlan(ctx, current)
): string {
  const existing = Array.isArray(current?.skills) ? current.skills : [];
  return `${JSON.stringify(
    {
      ...(current ?? {}),
      $schema: SKILLS_SCHEMA_URL,
      inherit_global: true,
      registry: SKILLS_REGISTRY_URL,
      skills: [
        // Two evictions, deliberately narrow. `isRetiredBmadPackEntry` clears the
        // leftovers from when pjangler pinned a Skillex `bmad` pack;
        // `isRedundantDeclaredPackEntry` clears hand-expanded members of a pack
        // the repo now declares. Nothing else is removed — an entry pointing at
        // a CONTAINER inside a declared pack's family, or anywhere outside it,
        // is the user's.
        ...existing.filter(
          (entry) => !isRetiredBmadPackEntry(entry) && !isRedundantDeclaredPackEntry(entry, plan)
        ),
        ...plan.manifestSkills,
      ],
    },
    null,
    2
  )}\n`;
}

// ---------------------------------------------------------------------------
// PJAN-28: legacy committed skills
//
// Before this, `.agents/skills/` entries that were neither BMAD pack symlinks
// nor recorded in `.agents/skills.json` were *silently skipped* by both the
// audit walk and the migrate walk. A repo could therefore carry committed
// skills that no manifest knew about and nothing ever said so. These helpers
// surface that drift and, behind an explicit opt-in, map each entry into the
// manifest.
// ---------------------------------------------------------------------------

function skillsBackupDir(repoRoot: string): string {
  return join(repoRoot, ".agents", SKILLS_BACKUP_DIRNAME);
}

/**
 * Local, offline-only registry checkouts to consult for a content match.
 *
 * The "registry" (`SKILLS_REGISTRY_URL`) is a plain git repo — it exposes no
 * API and no index, so the only thing that can be matched against is a
 * checkout that already exists on disk. `sync-skills.py` clones it into
 * `~/.agents/.cache/registries/<sanitized-url>`; `~/code/skillex` is the
 * canonical developer checkout. This is deliberately the SAME ladder pack
 * resolution walks — a second, divergent copy is what let one pack name resolve
 * two ways. We NEVER clone or fetch here: a parity audit/migrate must not depend
 * on the network, so an absent checkout simply means "no confident match".
 */
function skillsRegistryRoots(ctx: Context): string[] {
  return packRegistryRoots(ctx, SKILLS_REGISTRY_URL);
}

function availableSkillsRegistryRoots(ctx: Context): string[] {
  return skillsRegistryRoots(ctx).filter((root) =>
    SKILLS_REGISTRY_SKILL_DIRS.some((dir) => existsSync(join(root, dir)))
  );
}

/**
 * Canonical content digest for a skill entry.
 *
 * Returns `null` for anything that cannot be compared with certainty — a
 * symlink at any depth, a device/fifo, or an unreadable path. `null` always
 * means "not a confident match", never "match".
 */
function digestSkillEntry(root: string): string | null {
  const hash = createHash("sha256");
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink()) return null;
    if (stat.isFile()) {
      const content = readFileSync(root);
      hash.update(`file\0\0${content.length}\0`);
      hash.update(content);
      return hash.digest("hex");
    }
    if (!stat.isDirectory()) return null;
    const walk = (dir: string, rel: string): boolean => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const entryRel = rel ? `${rel}/${name}` : name;
        const entryStat = lstatSync(full);
        if (entryStat.isSymbolicLink()) return false;
        if (entryStat.isDirectory()) {
          hash.update(`dir\0${entryRel}\0`);
          if (!walk(full, entryRel)) return false;
        } else if (entryStat.isFile()) {
          const content = readFileSync(full);
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

/**
 * Names under `.agents/skills` that no contract accounts for.
 *
 * Shared by the audit and the migration so the two can never drift. An entry is
 * "undeclared" when it is NOT in the BMAD namespace (see
 * BMAD_SKILL_NAME_PREFIX), NOT recorded in `.agents/skills.json`, and NOT a
 * projection of a backed-up skill (`skills-sync` re-materializes mapped entries
 * as symlinks into `.agents/skills.bak`, which must never be re-reported).
 *
 * PJAN-82: it used to report these as "unmanaged COMMITTED skill(s)", which is
 * a claim this function cannot make — it never consults git. On the reporting
 * machine 58 of them were gitignored generated symlinks, and the word sent the
 * reader looking for a tracking problem that did not exist. The real condition
 * is "present in the projection, accounted for by nothing", which since the
 * fan-out engine started reconciling is usually sediment the next sync removes
 * rather than content anyone needs to adopt.
 */
function legacyCommittedSkillNames(
  skillsDir: string,
  backupDir: string,
  expectedNames: Set<string>,
  packRoots: string[],
  manifestNames: Set<string>
): string[] {
  const stat = lstatIfPresent(skillsDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
  const names: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    return [];
  }
  // PJAN-84: a repo's OWN authored skill is declared by its directory.
  //
  // `<repo>/skills/<name>/SKILL.md` is projected by sync-skills.py without any
  // manifest entry, because `.agents/skills.json` is generated and gitignored in
  // these repos — a hand-written entry there does not survive a fresh clone, and
  // a declaration that restates a directory's contents is a second copy of the
  // truth that drifts from the first. This is the TypeScript mirror of that rule,
  // so the audit agrees with the engine instead of demanding a duplicate.
  const repoSkillsRoot = resolve(skillsDir, "..", "..", "skills");
  for (const name of entries) {
    if (expectedNames.has(name) || manifestNames.has(name)) continue;
    if (name.startsWith(BMAD_SKILL_NAME_PREFIX)) continue;
    const path = join(skillsDir, name);
    let linkTarget: string | null = null;
    try {
      linkTarget = lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
    } catch {
      linkTarget = null;
    }
    if (
      linkTarget &&
      (packRoots.some((root) => isContainedBy(root, linkTarget)) || isContainedBy(backupDir, linkTarget))
    ) {
      continue;
    }
    // The projection of this repo's own `skills/<name>`, by that exact name.
    if (linkTarget && linkTarget === join(repoSkillsRoot, name) && existsSync(join(linkTarget, "SKILL.md"))) {
      continue;
    }
    names.push(name);
  }
  return names;
}

interface LegacySkillPlan {
  name: string;
  registryPath?: string;
  description: string;
}

/**
 * Decide where a single unmanaged entry should be recorded.
 *
 * "Confident" means byte-identical: the entry's whole tree must digest to
 * exactly the same value as a registry candidate. Anything short of that —
 * a customized copy, an unreadable tree, a symlink, no local checkout — keeps
 * the skill local, because a wrong registry mapping would silently swap the
 * user's customized skill for the upstream one on the next `skills-sync`.
 */
function planLegacyCommittedSkill(
  skillsDir: string,
  backupDir: string,
  registryRoots: string[],
  name: string
): LegacySkillPlan {
  const backupTarget = join(backupDir, name);
  const localDescription = (reason: string) =>
    `${name} -> file://${backupTarget} (${reason}; kept local)`;
  const digest = digestSkillEntry(join(skillsDir, name));
  if (!digest) {
    return { name, description: localDescription("entry is a symlink or is not byte-comparable") };
  }
  if (!registryRoots.length) {
    return { name, description: localDescription("no local registry checkout to compare against") };
  }
  for (const root of registryRoots) {
    for (const dir of SKILLS_REGISTRY_SKILL_DIRS) {
      const candidate = join(root, dir, name);
      if (!existsSync(candidate)) continue;
      if (digestSkillEntry(candidate) !== digest) continue;
      return {
        name,
        registryPath: `${dir}/${name}`,
        description: `${name} -> registry_path ${dir}/${name} (exact content match)`,
      };
    }
  }
  return { name, description: localDescription("no exact registry content match") };
}

/**
 * Report (default) or apply (with `--accept-registry-matches`) the mapping of
 * every unmanaged `.agents/skills` entry into `.agents/skills.json`.
 *
 * Applying moves the original into `.agents/skills.bak/<name>` — never deletes
 * it — and records either `registry_path` (confident match) or an absolute
 * `file://` source pointing at the backup (everything else).
 */
function migrateLegacyCommittedSkills(ctx: Context, changedFiles: string[]): string[] {
  const details: string[] = [];
  const agentsDir = join(ctx.repoRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");
  const backupDir = skillsBackupDir(ctx.repoRoot);
  const manifestPath = join(agentsDir, "skills.json");

  const rawManifest = safeReadText(manifestPath);
  const manifest = tryParseJson(rawManifest);
  if (rawManifest !== null && manifest === null) {
    // Invalid JSON: never clobber it. provisionDeclaredPacks reports the blocker.
    return details;
  }
  // An unresolvable pack blocks later in provisionDeclaredPacks; an empty pack
  // inventory here only makes this step more conservative.
  const packPlan = buildPackPlan(ctx, manifest);
  const expectedNames = new Set(packPlan.projections.keys());
  const manifestSkills = Array.isArray(manifest?.skills) ? [...manifest.skills] : [];
  const manifestNames = new Set(
    manifestSkills
      .map(skillManifestEntryName)
      .filter((name): name is string => Boolean(name))
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

  const applied: LegacySkillPlan[] = [];
  for (const plan of plans) {
    const from = join(skillsDir, plan.name);
    const to = join(backupDir, plan.name);
    if (lstatIfPresent(to)) {
      details.push(`skipped ${plan.name}: ${to} already exists and would be overwritten`);
      continue;
    }
    if (!changedFiles.includes(to)) changedFiles.push(to);
    if (!ctx.dryRun) {
      mkdirSync(backupDir, { recursive: true });
      renameSync(from, to);
    }
    manifestSkills.push(
      plan.registryPath
        ? { name: plan.name, registry_path: plan.registryPath }
        : { name: plan.name, source: pathToFileURL(to).href }
    );
    applied.push(plan);
    details.push(`mapped ${plan.description}`);
  }
  if (!applied.length) return details;

  // Emit the canonical shape rather than a plain append: provisionDeclaredPacks
  // re-orders the manifest into [non-pack..., pack...] on every run, so a naive
  // append would be rewritten on the next migrate and never reach "noop".
  const merged = { ...(manifest ?? {}), skills: manifestSkills };
  let nextManifest: string;
  try {
    nextManifest = canonicalSkillsManifest(ctx, merged);
  } catch {
    nextManifest = `${JSON.stringify(merged, null, 2)}\n`;
  }
  if (nextManifest !== rawManifest) {
    if (!changedFiles.includes(manifestPath)) changedFiles.push(manifestPath);
    if (!ctx.dryRun) writeText(manifestPath, nextManifest);
  }
  return details;
}

export interface PackProvisionHooks {
  afterPreflight?: () => void;
  createLink?: (target: string, link: string, index: number) => void;
  afterApply?: (manifestPath: string, skillsDir: string) => void;
}

function removeProjectEntry(path: string): void {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  // Node 24 rejects rmSync(..., { recursive: false }) for directory symlinks
  // with ERR_FS_EISDIR. unlinkSync removes the link itself without touching its
  // directory target and also preserves the intended regular-file behavior.
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function normalizeExecutableTemplate(
  ctx: Context,
  target: string,
  expected: string,
  changedFiles: string[]
): void {
  const stat = lstatIfPresent(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Refusing non-regular managed executable target: ${target}`);
  }
  const contentChanged = !stat || safeReadText(target) !== expected;
  const modeChanged = !stat || (Number(stat.mode) & 0o111) === 0;
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
  chmodSync(target, 0o755);
}

function atomicWriteBuffer(path: string, content: Buffer, mode: number, temporary: string): void {
  writeFileSync(temporary, content, { flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/**
 * Materialize every pack DECLARED in `.agents/skills.json` `packs[]` into
 * `.agents/skills/<name>` symlinks, and normalize the manifest around them.
 *
 * Formerly `provisionBmadSkills`, back when pjangler pinned a `bmad` pack
 * implicitly and this function's main job was projecting it. BMAD is the
 * installer's now; nothing is pinned implicitly, so this only ever handles
 * what a repo asked for by name.
 */
export function provisionDeclaredPacks(
  ctx: Context,
  preservedManifest?: Record<string, unknown> | null,
  hooks: PackProvisionHooks = {}
): { ok: boolean; changedFiles: string[]; error?: string; packWarnings?: string[] } {
  // Destination topology and the manifest's own file type are security
  // boundaries. Validate them before reading packs[] or resolving any registry
  // path: a symlinked manifest must never be followed even during planning.
  let initialDirs: { agentsDir: string; skillsDir: string };
  try {
    initialDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const initialManifestPath = join(initialDirs.agentsDir, "skills.json");
  const initialManifestStat = lstatIfPresent(initialManifestPath);
  if (initialManifestStat?.isSymbolicLink() || (initialManifestStat && !initialManifestStat.isFile())) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${initialManifestPath}` };
  }

  // The plan depends on `packs[]`, so the manifest is read (leniently) first.
  // A manifest that does not parse yields no packs here and is reported with
  // its proper error below, before anything is created or written.
  //
  const declaringManifest =
    preservedManifest ??
    tryParseJson(initialManifestStat ? readRegularFile(initialManifestPath).toString("utf8") : null);
  const plan = buildPackPlan(ctx, declaringManifest);
  if (plan.errors.length) {
    return { ok: false, changedFiles: [], error: plan.errors.join("; ") };
  }
  const packSkills = plan.manifestSkills;
  hooks.afterPreflight?.();

  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsPath = join(projectRoot, ".agents");
  const skillsPath = join(agentsPath, "skills");
  const agentsExisted = Boolean(lstatIfPresent(agentsPath));
  const skillsExisted = Boolean(lstatIfPresent(skillsPath));
  let preflightDirs: { agentsDir: string; skillsDir: string };
  try {
    preflightDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const manifestPath = join(preflightDirs.agentsDir, "skills.json");
  const manifestStat = lstatIfPresent(manifestPath);
  if (manifestStat?.isSymbolicLink() || (manifestStat && !manifestStat.isFile())) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${manifestPath}` };
  }
  const manifestBytes = manifestStat ? readRegularFile(manifestPath) : null;
  const manifestMode = manifestStat ? Number(manifestStat.mode) & 0o777 : 0o644;
  let currentManifest: Record<string, unknown> = {};
  if (manifestBytes !== null) {
    try {
      const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain a JSON object");
      currentManifest = parsed as Record<string, unknown>;
      if (currentManifest.skills !== undefined && !Array.isArray(currentManifest.skills)) throw new Error("skills must be an array");
    } catch (error) {
      return { ok: false, changedFiles: [], error: `Invalid existing skills manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  let safeDirs: { agentsDir: string; skillsDir: string };
  try {
    safeDirs = prepareSafeProjectSkillsDirs(ctx);
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const nextManifest = canonicalSkillsManifest(ctx, preservedManifest ?? currentManifest, plan);
  const skillsDir = safeDirs.skillsDir;
  const resolvedSkillsDir = ctx.dryRun && !existsSync(skillsDir) ? skillsDir : realpathSync(skillsDir);
  const expected = new Map(plan.projections);
  const expectedNames = new Set(expected.keys());
  const ownershipManifest = preservedManifest ?? currentManifest;
  const managedManifestNames = new Set(
    (Array.isArray(ownershipManifest.skills) ? ownershipManifest.skills : [])
      .filter((entry) => isPackManagedManifestEntry(entry, expectedNames, plan.ownershipRoots))
      .map(skillManifestEntryName)
      .filter((name): name is string => Boolean(name))
  );
  const affected = new Set<string>();
  const staleManagedNames = new Set<string>();
  const originalCorrectLinks = new Map<string, string>();
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      validateSkillName(name);
      if (dirname(join(resolvedSkillsDir, name)) !== resolvedSkillsDir) {
        return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
      }
      const entryPath = join(skillsDir, name);
      let linkTargetsPack = false;
      try {
        const linkTarget =
          lstatSync(entryPath).isSymbolicLink() ? resolve(dirname(entryPath), readlinkSync(entryPath)) : null;
        linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget!));
      } catch {
        linkTargetsPack = false;
      }
      if (!expected.has(name) && !managedManifestNames.has(name) && !linkTargetsPack) continue;
      const target = expected.get(name);
      let correct = false;
      try {
        correct = Boolean(target) && lstatSync(entryPath).isSymbolicLink() && resolve(dirname(entryPath), readlinkSync(entryPath)) === target;
      } catch {
        correct = false;
      }
      if (correct) originalCorrectLinks.set(name, readlinkSync(join(skillsDir, name)));
      else {
        affected.add(name);
        if (!target) staleManagedNames.add(name);
      }
    }
  }
  for (const [name, target] of expected) {
    const link = join(resolvedSkillsDir, validateSkillName(name));
    if (dirname(link) !== resolvedSkillsDir) {
      return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
    }
    let correct = false;
    try {
      correct = lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === target;
    } catch {
      correct = false;
    }
    if (!correct) affected.add(name);
  }

  const manifestChanged = manifestBytes?.toString("utf8") !== nextManifest;
  const changedFiles = [
    ...(manifestChanged ? [manifestPath] : []),
    ...(affected.size ? [skillsDir] : []),
  ];
  if (ctx.dryRun || changedFiles.length === 0) {
    try {
      assertPackPlanUnchanged(plan);
      return { ok: true, changedFiles, packWarnings: plan.packWarnings };
    } catch (error) {
      return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  const transaction = mkdtempSync(join(safeDirs.agentsDir, ".bmad-transaction-"));
  const backup = join(transaction, "entries");
  mkdirSync(backup);
  const moved: string[] = [];

  const rollback = (): void => {
    const errors: string[] = [];
    try {
      for (const name of affected) {
        removeProjectEntry(join(skillsDir, validateSkillName(name)));
      }
      for (const name of originalCorrectLinks.keys()) {
        removeProjectEntry(join(skillsDir, validateSkillName(name)));
      }
    } catch (error) {
      errors.push(`remove applied projection: ${String(error)}`);
    }
    for (const name of [...moved].reverse()) {
      try {
        renameSync(join(backup, name), join(skillsDir, name));
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    for (const [name, rawTarget] of originalCorrectLinks) {
      try {
        symlinkSync(rawTarget, join(skillsDir, name), "dir");
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    try {
      if (manifestBytes === null) removeProjectEntry(manifestPath);
      else atomicWriteBuffer(manifestPath, manifestBytes, manifestMode, join(transaction, "manifest.restore"));
    } catch (error) {
      errors.push(`restore manifest: ${String(error)}`);
    }
    rmSync(transaction, { recursive: true, force: true });
    try {
      if (!skillsExisted && existsSync(skillsDir) && readdirSync(skillsDir).length === 0) rmdirSync(skillsDir);
      if (!agentsExisted && existsSync(safeDirs.agentsDir) && readdirSync(safeDirs.agentsDir).length === 0) rmdirSync(safeDirs.agentsDir);
    } catch (error) {
      errors.push(`remove created directories: ${String(error)}`);
    }
    if (errors.length) throw new Error(`BMAD rollback was incomplete: ${errors.join("; ")}`);
  };

  try {
    for (const name of affected) {
      const entry = join(skillsDir, name);
      if (lstatIfPresent(entry)) {
        renameSync(entry, join(backup, name));
        moved.push(name);
      }
    }
    let index = 0;
    for (const [name, target] of expected) {
      index += 1;
      const link = join(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync(link).isSymbolicLink() && resolve(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (correct) continue;
      if (hooks.createLink) hooks.createLink(target, link, index);
      else symlinkSync(target, link, "dir");
    }
    if (manifestChanged) {
      atomicWriteBuffer(manifestPath, Buffer.from(nextManifest), manifestMode, join(transaction, "manifest.next"));
    }
    assertPackPlanUnchanged(plan);
    hooks.afterApply?.(manifestPath, skillsDir);
    for (const name of staleManagedNames) {
      if (lstatIfPresent(join(skillsDir, name))) {
        throw new Error(`Applied BMAD projection retained stale managed entry: ${name}`);
      }
    }
    for (const [name, target] of expected) {
      const link = join(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync(link).isSymbolicLink() && resolve(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (!correct) throw new Error(`Applied BMAD projection link differs from plan: ${name}`);
    }
    const finalManifestStat = lstatIfPresent(manifestPath);
    if (
      !finalManifestStat || finalManifestStat.isSymbolicLink() || !finalManifestStat.isFile() ||
      (Number(finalManifestStat.mode) & 0o777) !== manifestMode ||
      readFileSync(manifestPath).toString("utf8") !== nextManifest
    ) {
      throw new Error("Applied BMAD skills manifest differs from planned bytes or mode");
    }
    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (
      finalManifest.$schema !== SKILLS_SCHEMA_URL ||
      finalManifest.inherit_global !== true || finalManifest.registry !== SKILLS_REGISTRY_URL ||
      !Array.isArray(finalManifest.skills)
    ) {
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

function isManagedHookEntry(value: string): boolean {
  const trimmed = value.trim();
  if (isOpInjectHookEntry(trimmed)) return true;
  if (trimmed === SYNC_SKILLS_SCRIPT) return true;
  if (trimmed === PROVISION_PACKS_SCRIPT) return true;
  if (trimmed === LEGACY_PROVISION_BMAD_SKILLS_SCRIPT) return true;
  if (/sync-skills(?:\.py)?["']?\s+--scope project/.test(trimmed)) return true;
  if (/provision-packs\.py/.test(trimmed)) return true;
  if (/provision-bmad-skills\.py/.test(trimmed)) return true;
  if (/link-project-skills-to-clis\.sh'?\s*$/.test(trimmed)) return true;
  if (/unlink-project-skills-from-clis\.sh'?\s*$/.test(trimmed)) return true;
  // link-agentfiles.sh, with or without wrapping single quotes / path prefix.
  return /link-agentfiles\.sh'?\s*$/.test(trimmed);
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
        const scriptMatch = /^\s*script\s*=\s*(.+)$/.exec(lines[j]!);
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
            records.push({ kind: keyMatch[1] as "enter" | "leave", script: value, raw: `[[hooks.${keyMatch[1]}]]\nscript = ${JSON.stringify(value)}` });
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

function ownedOpInjectScriptsOutsideEnter(text: string): Array<{ line: number; value: string }> {
  const findings: Array<{ line: number; value: string }> = [];
  let table = "";
  for (const [index, line] of text.split("\n").entries()) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/[\[\]\s]/g, "");
      continue;
    }
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") continue;
    const value = extractTomlStrings(script[1]!)[0];
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
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") return true;
    const value = extractTomlStrings(script[1]!)[0];
    return value === undefined || !isOpInjectHookEntry(value);
  }).join("\n");
}

function renderHookTables(scripts: readonly string[], kind: "enter" | "leave"): string[] {
  return scripts.map((script) => `[[hooks.${kind}]]\nscript = ${JSON.stringify(script)}`);
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
    (record) => record.kind === "enter" && Boolean(record.script && isMiseCoreHookEntry(record.script)),
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
  { name: "sync-skills.py", marker: "sync-skills.py", subject: /--root\s+'?\{\{config_root\}\}'?/u },
  { name: "provision-packs.py", marker: "provision-packs.py", subject: /--root\s+'?\{\{config_root\}\}'?/u },
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
  const withPath = upsertMisePath(renameRetiredMiseTasks(text), requiredMisePathEntries(ctx));
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
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /\.agents\/skills\.json/, { includePrecedingComments: false });
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

function canonicalProjectJson(ctx: Context): Record<string, unknown> & { dropped: string[]; unprovisioned: string[] } {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = typeof existing.project_slug === "string" && existing.project_slug ? existing.project_slug : slugifyRepoName(basename(ctx.repoRoot));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    state: String(((existing.ticket_provider as Record<string, unknown> | undefined)?.state ?? (firstRole?.ticketProviderBoardId ? "linked" : "planned")) || "planned"),
  };
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
    fixable: details.length > unprovisionedDeclarations,
  };
}

function renderSoul(role: RoleMeta): string {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm"
    ? "Direct and brief. Decision-forward. No throat-clearing, no apologies, no \"I'll help you with that\" preambles."
    : "Direct and brief.";
  const roleSpecific = role.role === "pm"
    ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checks runtime health; when this repo opts into reconciliation (\`automation.reconcile.enabled\` in repo-root \`.project.json\`), the same heartbeat also runs your continuous board-reconciliation pass out-of-band (\`.scripts/sentinel.prompt.md\`, \`--source cron\`), kept separate from your interactive session memory.`
    : `You operate as the ${role.role} agent for this repo.`;
  return `# ${role.displayName || role.agentId}\n\nYou are **${role.displayName || role.agentId}** — a Hermes agent provisioned to work inside the\n\`${role.repo}\` repository.\n\n## Identity\n\n| | |\n| --- | --- |\n| Agent ID | \`${role.agentId}\` |\n| Profile | \`${role.profileName || role.agentId}\` |\n| Repo | \`${role.repo}\` |\n| Role | \`${role.role}\` |\n| Telegram | \`${telegram}\` |\n| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |\n\n## Scope\n\nYou operate only within the working directory of \`${role.repo}\`. HERMES_HOME is the real named profile at \`~/.hermes/profiles/${role.profileName || role.agentId}\`; shared config/auth/skills remain linked to fleet truth while owned state lives in ignored \`./runtime/\`. The launcher supplies the project root through process-local \`TERMINAL_CWD\` and never persists it into shared config.\n\n## Tone\n\n${tone}\n\n## Role-specific behavior\n\n${roleSpecific}\n\n## Memory hygiene\n\nYour memory is stored locally at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.\n`;
}

function renderHermesWrapper(role: RoleMeta, templateRoleDir: string): string {
  return readText(join(templateRoleDir, "hermes.jinja"))
    .replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId);
}

function templateFiles(sourceDir: string, current = sourceDir): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    const sourcePath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...templateFiles(sourceDir, sourcePath));
    else if (entry.isFile()) files.push(relative(sourceDir, sourcePath));
  }
  return files.sort();
}

function managedHermesScaffoldRoles(ctx: Context): { roles: RoleMeta[]; blockers: string[] } {
  const discovered = discoverRoles(ctx.repoRoot);
  const declared = readDeclaredAgents(ctx)
    .filter((entry) => entry.role === "pm" || entry.role === "director");
  if (declared.length === 0) {
    const orchestrators = discovered.filter((role) => role.role === "pm" || role.role === "director");
    const blockers = orchestrators
      .filter((role) => roleBloodbankEnabled(role) === null)
      .map((role) => `${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
    return {
      roles: orchestrators.filter((role) => roleBloodbankEnabled(role) !== null),
      blockers,
    };
  }

  const roles: RoleMeta[] = [];
  const blockers: string[] = [];
  for (const entry of declared) {
    if (!entry.roleDir) {
      blockers.push(`agents.${entry.agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve(ctx.repoRoot, entry.roleDir);
    if (!isContainedBy(ctx.repoRoot, roleDir)) {
      blockers.push(`agents.${entry.agentId}.role_dir resolves outside the project`);
      continue;
    }
    const role = discovered.find((candidate) => resolve(candidate.roleDir) === roleDir);
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

function renderSentinelPrompt(role: RoleMeta, templateRoleDir: string): string {
  return readText(join(templateRoleDir, ".scripts", "sentinel.prompt.md.jinja"))
    .replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId)
    .replace(/\{\{\s*role\s*\}\}/g, role.role)
    .replace(/\{\{\s*target_repo\s*\}\}/g, role.repo)
    .replace(/\{\{\s*display_name\s*\}\}/g, role.displayName || role.agentId)
    .replace(/\{\{\s*ticket_provider\s*\}\}/g, role.ticketProviderName || "plane");
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

function runtimeSubmodulePath(repoRoot: string, role: RoleMeta): string | null {
  const rolePath = relative(repoRoot, role.roleDir).replace(/\\/g, "/");
  if (!/^agents\/hermes\/[^/]+$/.test(rolePath)) return null;
  return `${rolePath}/runtime`;
}

function submoduleSectionHasPath(section: string, targetPath: string): boolean {
  return section
    .split(/\r?\n/)
    .some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}

function hasRuntimeSubmoduleMapping(repoRoot: string, role: RoleMeta): boolean {
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  const sections = current.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  return Boolean(targetPath && sections.some((section) => submoduleSectionHasPath(section, targetPath)));
}

function removeRuntimeSubmoduleMapping(repoRoot: string, role: RoleMeta, changedFiles: string[], dryRun: boolean): string[] {
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  if (!hasRuntimeSubmoduleMapping(repoRoot, role)) return [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  if (!targetPath) return [];
  const next = current
    .replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section) =>
      submoduleSectionHasPath(section, targetPath) ? "" : section)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, next ? `${next}\n` : "");
  return [gitmodulesPath];
}

interface RuntimeRetirementResult {
  ok: boolean;
  details: string[];
  error?: string;
}

function retireRuntimeSubmodule(
  repoRoot: string,
  role: RoleMeta,
  changedFiles: string[],
  dryRun: boolean,
): RuntimeRetirementResult {
  const runtimePath = runtimeSubmodulePath(repoRoot, role);
  if (!runtimePath) {
    return { ok: false, details: [], error: `refusing unsafe runtime path for ${role.roleDir}` };
  }
  const probe = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return { ok: false, details: [], error: `failed to inspect runtime index at ${runtimePath}: ${probe.stderr.trim() || `exit ${probe.status}`}` };
  }

  const details: string[] = [];
  if (probe.stdout.trim()) {
    details.push(`untrack ${runtimePath}`);
    if (dryRun) {
      changedFiles.push(runtimePath);
    } else {
      const removal = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (removal.status !== 0) {
        return { ok: false, details, error: `failed to untrack ${runtimePath}: ${removal.stderr.trim() || `exit ${removal.status}`}` };
      }
      const verification = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (verification.status !== 0 || verification.stdout.trim()) {
        return {
          ok: false,
          details,
          error: verification.status !== 0
            ? `failed to verify untracked runtime ${runtimePath}: ${verification.stderr.trim() || `exit ${verification.status}`}`
            : `runtime remains tracked after index-only removal: ${runtimePath}`,
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

function upsertRegistryEntry(role: RoleMeta, homeDir: string, changedFiles: string[], dryRun: boolean): string | null {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const enabled = roleBloodbankEnabled(role);
  if (enabled === null) return null;
  const block = `  ${role.agentId}:\n    repo: ${role.repo}\n    role: ${role.role}\n    display_name: ${JSON.stringify(role.displayName || role.agentId)}\n    project_path: ${ctxEscape(role.roleDir ? dirname(dirname(dirname(role.roleDir))) : "")}\n    role_dir: ${ctxEscape(role.roleDir)}\n    profile_name: ${role.profileName || role.agentId}\n    telegram:\n      bot_username: ${ctxEscape(role.botHandle)}\n    plane:\n      workspace: ${ctxEscape(role.planeWorkspace)}\n      project_id: ${ctxEscape(role.ticketProviderBoardId)}\n      identifier: ${ctxEscape(role.ticketProviderIdentifier)}\n    runtime_repo: ${ctxEscape(role.runtimeRepo)}\n    bloodbank:\n      enabled: ${enabled ? "true" : "false"}\n      gateway_scope: fleet\n      target_agent_id: ${role.agentId}\n    systemd:\n      gateway_unit: hermes-${role.agentId}-gateway.service\n      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer\n`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:\n${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}

function roleBloodbankEnabled(role: RoleMeta): boolean | null {
  if (role.bloodbankEnabled === "" || role.bloodbankEnabled === "false") return false;
  if (role.bloodbankEnabled === "true") return true;
  return null;
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
 */
function evictLegacyBmadPackState(ctx: Context, changedFiles: string[]): string[] {
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

// ── Hermes singleton-runtime contract ────────────────────────────────────────
// One fleet root holds the shared truth (config.yaml, auth.json, .env, skills/).
// Each agent gets ~/.hermes/profiles/<name>/ as a REAL directory: shared entries
// symlink up to the root, person-owned entries symlink back into the repo
// runtime. That split is load-bearing — Hermes resolves the profile NAME from
// the unresolved HERMES_HOME path (so the profile dir must not itself be a
// symlink) and only offers ~/.hermes/auth.json as a shared fallback when
// HERMES_HOME differs from the fleet root.
// Fleet-shared, symlinked up to ~/.hermes/<entry>.
//
// config.yaml is deliberately NOT here. It used to be, and the symlink was
// actively harmful: Hermes' atomic_yaml_write does os.replace, which REPLACES a
// symlink with a regular file, so the first in-agent config write (/model,
// onboarding, a config migration) silently detached the profile and froze it on
// a stale copy of the base forever. Symlinking also gave a profile no way to
// override anything, which is why several profiles were hand-forked into
// 700-line copies instead.
//
// config.yaml is now GENERATED: deep_merge(~/.hermes/config.yaml, <profile>/
// config.delta.yaml), rendered by hermes-agent-template/scripts/
// hermes-profile-config.py. The delta is the hand-edited SSOT and is usually
// empty (identical to base). See PROFILE_RENDER_MARKER below.
const SHARED_PROFILE_ENTRIES = [".env", "skills"] as const;

// Header stamped into every generated profile config.yaml. Its presence is how
// we tell "rendered from base+delta" apart from "hand-forked copy that has
// silently drifted", which look identical on disk otherwise.
const PROFILE_RENDER_MARKER = "GENERATED FILE -- DO NOT EDIT";
// Person-owned. SOUL.md is load-bearing: Hermes reads it from HERMES_HOME and
// seeds the stock "You are Hermes Agent, created by Nous Research" default into
// any fresh profile dir, which would silently shadow each agent's real identity.
const OWNED_PROFILE_ENTRIES = [
  "memories",
  "sessions",
  "workspace",
  "logs",
  "cron",
  "plans",
  "hooks",
  "pairing",
  "audio_cache",
  "image_cache",
] as const;
const OWNED_PROFILE_FILES = ["SOUL.md", "state.db", "kanban.db"] as const;

interface SingletonLink {
  path: string;
  target: string;
  ensureTargetDir: boolean;
}

interface SingletonPlan {
  fleetRoot: string;
  profileDir: string;
  runtimeDir: string;
  links: SingletonLink[];
  sharedSeeds: { rootPath: string; runtimePath: string }[];
}

function fleetHome(ctx: Context): string {
  return process.env.HERMES_FLEET_HOME || join(ctx.homeDir, ".hermes");
}

function fleetBinPath(ctx: Context): string {
  const candidates = [
    process.env.HERMES_FLEET_BIN,
    join(fleetHome(ctx), "hermes-agent", ".venv", "bin", "hermes"),
    join(fleetHome(ctx), "hermes-agent", "venv", "bin", "hermes"),
    join(ctx.homeDir, ".local", "bin", "hermes"),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function singletonPlan(ctx: Context, role: RoleMeta): SingletonPlan {
  const fleetRoot = fleetHome(ctx);
  const profileName = role.profileName || role.agentId;
  const profileDir = join(fleetRoot, "profiles", profileName);
  const runtimeDir = join(role.roleDir, "runtime");
  const links: SingletonLink[] = [];
  for (const entry of SHARED_PROFILE_ENTRIES) {
    links.push({ path: join(profileDir, entry), target: join(fleetRoot, entry), ensureTargetDir: entry === "skills" });
  }
  for (const entry of OWNED_PROFILE_ENTRIES) {
    links.push({ path: join(profileDir, entry), target: join(runtimeDir, entry), ensureTargetDir: true });
  }
  for (const entry of OWNED_PROFILE_FILES) {
    links.push({ path: join(profileDir, entry), target: join(runtimeDir, entry), ensureTargetDir: false });
  }
  const sharedSeeds = ["config.yaml", "auth.json", ".env"].map((entry) => ({
    rootPath: join(fleetRoot, entry),
    runtimePath: join(runtimeDir, entry),
  }));
  return { fleetRoot, profileDir, runtimeDir, links, sharedSeeds };
}

function profileNameOf(role: RoleMeta): string {
  return role.profileName || role.agentId;
}

// The base+delta renderer ships in hermes-agent-template, which is a sibling
// component rather than a pjangler dependency — so locate it rather than
// vendoring a second implementation of Hermes' merge semantics.
function profileRendererPath(ctx: Context): string | null {
  const candidates = [
    join(ctx.repoRoot, "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(ctx.repoRoot, "..", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(homedir(), "code", "33GOD", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(ctx.pjanglerRoot, "templates", "hermes-agent", "scripts", "hermes-profile-config.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

// Per-profile config + memory invariants that replaced the old
// "config.yaml is a symlink to the fleet base" contract.
//
// Returns human-readable findings; empty means in parity.
function profileConfigFindings(profileDir: string, profileName: string): string[] {
  const out: string[] = [];
  const cfg = join(profileDir, "config.yaml");
  const delta = join(profileDir, "config.delta.yaml");

  // 1. config.yaml must be a real, generated file — never a symlink (see
  //    SHARED_PROFILE_ENTRIES) and never a hand-forked copy.
  if (!existsSync(cfg)) {
    out.push(`profile config missing (run hermes-profile-config.py render): ${cfg}`);
  } else if (lstatSync(cfg).isSymbolicLink()) {
    out.push(`config.yaml is a symlink — it detaches on the first Hermes write; render it instead: ${cfg}`);
  } else {
    let head = "";
    try {
      head = readFileSync(cfg, "utf8").slice(0, 800);
    } catch {
      /* unreadable is reported below via the marker check */
    }
    if (!head.includes(PROFILE_RENDER_MARKER)) {
      out.push(`config.yaml is not a rendered artifact (missing generated header) — likely a hand-forked copy that will drift: ${cfg}`);
    }
  }

  // 2. The delta is the hand-edited source of truth. Absent means "no overrides",
  //    which is valid — but the FILE must exist so the profile is demonstrably
  //    under inheritance rather than merely un-migrated.
  if (!existsSync(delta)) {
    out.push(`config.delta.yaml missing — profile is not under base+delta inheritance: ${delta}`);
  } else if (lstatSync(delta).isSymbolicLink()) {
    out.push(`config.delta.yaml must be a real file, not a symlink: ${delta}`);
  }

  // 3. Identity-memory bank must be pinned explicitly. Relying on
  //    bank_id_template: agent-{profile} is unsafe: {profile} resolves through
  //    get_active_profile_name(), which calls Path.resolve() on HERMES_HOME and
  //    requires a lowercase id directly under profiles/. A symlinked profile dir
  //    or an uppercase name silently yields the literal "custom", merging several
  //    agents' PRIVATE memory into one shared bank.
  const memCfg = join(profileDir, "hindsight", "config.json");
  const wantBank = `agent-${profileName}`;
  if (!existsSync(memCfg)) {
    out.push(`identity-memory bank not pinned (expected bank_id "${wantBank}"): ${memCfg}`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(memCfg, "utf8")) as Record<string, unknown>;
      const got = typeof parsed.bank_id === "string" ? parsed.bank_id : "";
      if (got !== wantBank) {
        out.push(`identity-memory bank_id is ${got ? `"${got}"` : "unset"}, expected "${wantBank}": ${memCfg}`);
      }
    } catch {
      out.push(`identity-memory pin is unparseable JSON: ${memCfg}`);
    }
  }
  return out;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

function linkState(path: string, target: string): "ok" | "missing" | "not-a-symlink" | "wrong-target" {
  let stat;
  try {
    stat = lstatSync(path);
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

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// heartbeat.SERVICE (not just the .timer) also carries Environment= lines, so
// omitting it leaves a stale HERMES_HOME and the dead HERMES_OAUTH_FILE behind.
function profileUnits(role: RoleMeta): string[] {
  return [
    `hermes-${role.agentId}-gateway.service`,
    `hermes-${role.agentId}-heartbeat.service`,
    `hermes-${role.agentId}-heartbeat.timer`,
    `hermes-${role.agentId}-checkpoint.service`,
  ];
}

function readRegistry(registryPath: string): Record<string, unknown> | null {
  const raw = safeReadText(registryPath);
  if (raw === null) return null;
  try {
    const doc = YAML.parse(raw) as Record<string, unknown>;
    return (doc?.agents ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function declaredAgentIds(repoRoot: string): string[] {
  return declaredAgentEntries(repoRoot).map(([agentId]) => agentId);
}

function declaredAgentEntries(repoRoot: string): [string, Record<string, unknown>][] {
  const raw = safeReadText(join(repoRoot, ".project.json"));
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw) as { agents?: Record<string, unknown> };
    return Object.entries(doc.agents ?? {}).map(([agentId, entry]) => [agentId, (entry ?? {}) as Record<string, unknown>]);
  } catch {
    return [];
  }
}

// Registry entries this repo actually owns. role_dir is
// <project>/agents/hermes/<role>, so the project root is three levels up. A
// prefix match on repoRoot would wrongly claim nested submodule agents
// (33GOD contains bloodbank, candystore, candybar, holocene...).
function ownedRegistryEntries(
  registry: Record<string, unknown>,
  repoRoot: string,
): [string, Record<string, unknown>][] {
  const want = realOrSelf(repoRoot);
  const owned: [string, Record<string, unknown>][] = [];
  for (const [agentId, raw] of Object.entries(registry)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const roleDir = String(entry.role_dir ?? "");
    if (!roleDir) continue;
    if (realOrSelf(dirname(dirname(dirname(roleDir)))) !== want) continue;
    owned.push([agentId, entry]);
  }
  return owned;
}

interface UnprovisionedRoleAgent {
  agentId: string;
  roleDir: string;
  sources: ("registry" | ".project.json")[];
}

function unprovisionedRoleAgents(
  registry: Record<string, unknown>,
  repoRoot: string,
  canonical: Set<string>,
): UnprovisionedRoleAgent[] {
  const blockers = new Map<string, { roleDir: string; sources: Set<"registry" | ".project.json"> }>();
  const record = (agentId: string, roleDir: string, source: "registry" | ".project.json") => {
    const current = blockers.get(agentId) ?? { roleDir, sources: new Set<"registry" | ".project.json">() };
    if (!current.roleDir && roleDir) current.roleDir = roleDir;
    current.sources.add(source);
    blockers.set(agentId, current);
  };

  for (const [agentId, entry] of ownedRegistryEntries(registry, repoRoot)) {
    if (canonical.has(agentId)) continue;
    // The registry stores role_dir absolute; `resolve` leaves those untouched,
    // so the same repo-relative-aware predicate serves both sources.
    const roleDir = String(entry.role_dir ?? "");
    if (declaredRoleIsUnprovisioned(repoRoot, roleDir)) record(agentId, roleDir, "registry");
  }
  for (const [agentId, entry] of declaredAgentEntries(repoRoot)) {
    if (canonical.has(agentId)) continue;
    const configured = String(entry.role_dir ?? "");
    const roleDir = configured ? resolve(repoRoot, configured) : "";
    if (declaredRoleIsUnprovisioned(repoRoot, configured)) record(agentId, roleDir, ".project.json");
  }

  return [...blockers.entries()].map(([agentId, value]) => ({
    agentId,
    roleDir: value.roleDir,
    sources: [...value.sources],
  }));
}

// Drop a duplicate agent id from .project.json so the next provisioning run
// does not resurrect the registry entry we just removed.
function dropDeclaredAgent(ctx: Context, agentId: string, changedFiles: string[], details: string[]): void {
  const path = join(ctx.repoRoot, ".project.json");
  const raw = safeReadText(path);
  if (raw === null) return;
  let doc: { agents?: Record<string, unknown> };
  try {
    doc = JSON.parse(raw) as { agents?: Record<string, unknown> };
  } catch {
    return;
  }
  if (!doc.agents || !(agentId in doc.agents)) return;
  delete doc.agents[agentId];
  details.push(`drop agent "${agentId}" from .project.json`);
  changedFiles.push(path);
  if (!ctx.dryRun) writeText(path, `${JSON.stringify(doc, null, 2)}\n`);
}

// The one correct right-hand side for HERMES_HOME: the named profile dir,
// either as the canonical expression or already expanded to a literal path.
function isProfileHomeExpr(assigned: string): boolean {
  const bare = assigned.replace(/^["']|["']$/g, "");
  return bare === "$FLEET_HOME/profiles/$PROFILE_NAME"
    || /^\$\{?HERMES_FLEET_HOME.*\}?\/profiles\//.test(bare)
    || /\/\.hermes\/profiles\/[^/]+$/.test(bare);
}

function rewriteLauncher(text: string, profileName?: string): string {
  let next = text;
  const assigned = /^HERMES_HOME=(.*)$/m.exec(next)?.[1]?.trim();
  if (assigned !== undefined && !isProfileHomeExpr(assigned)) {
    // A bare substitution would leave $FLEET_HOME/$PROFILE_NAME undefined, and
    // these launchers run under `set -u`. Emit the definitions with it, and
    // keep the old value as RUNTIME_HOME — the provisioning guard still needs
    // the repo runtime path.
    const name = profileName ? `\${HERMES_PROFILE_NAME:-${profileName}}` : "${HERMES_PROFILE_NAME:-$(basename \"$ROLE_DIR\")}";
    next = next.replace(
      /^HERMES_HOME=(.*)$/m,
      [
        `RUNTIME_HOME=$1`,
        `FLEET_HOME="\${HERMES_FLEET_HOME:-$HOME/.hermes}"`,
        `PROFILE_NAME="${name}"`,
        `# Singleton-runtime contract: HERMES_HOME MUST be the named profile dir.`,
        `HERMES_HOME="$FLEET_HOME/profiles/$PROFILE_NAME"`,
      ].join("\n"),
    );
    // The provisioning guard referenced HERMES_HOME when it meant the runtime.
    next = next.replace(
      /if \[\[ ! -d "\$HERMES_HOME" \]\]; then\n(\s*)echo "hermes: local runtime not provisioned at \$HERMES_HOME"/,
      'if [[ ! -d "$RUNTIME_HOME" ]]; then\n$1echo "hermes: local runtime not provisioned at $RUNTIME_HOME"',
    );
  }
  next = next.replace(/^HERMES_OAUTH_FILE=.*\n/m, "");
  next = next.replace(/\s*HERMES_OAUTH_FILE="\$HERMES_OAUTH_FILE"/g, "");
  next = next.replace(/^.*\/home\/delorenj\/code\/hermes-agent\/\.venv\/bin\/hermes.*$/m, (line) =>
    line.replace("/home/delorenj/code/hermes-agent/.venv/bin/hermes", "$HOME/.hermes/hermes-agent/.venv/bin/hermes"),
  );
  return next;
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

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function csvObjects(text: string): Record<string, string>[] {
  const [headers, ...rows] = parseCsvRows(text);
  if (!headers?.length) return [];
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function installedBmadTools(repoRoot: string): Set<string> {
  const raw = safeReadText(join(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return new Set();
  try {
    const parsed = YAML.parse(raw) as { ides?: unknown } | undefined;
    return new Set(Array.isArray(parsed?.ides) ? parsed.ides.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Reconstruct the installer-owned CLI inventory from BMAD's own durable
 * metadata. skill-manifest.csv maps a projected skill id to its source tree;
 * files-manifest.csv records the SHA-256 of every file in that tree.
 */
function bmadCliProjectionInventory(repoRoot: string): { files: Map<string, string>; error?: string } {
  const filesText = safeReadText(join(repoRoot, "_bmad", "_config", "files-manifest.csv"));
  const skillsText = safeReadText(join(repoRoot, "_bmad", "_config", "skill-manifest.csv"));
  if (!filesText || !skillsText) return { files: new Map(), error: "BMAD files/skill manifests are missing" };
  const fileHashes = new Map<string, string>();
  for (const row of csvObjects(filesText)) {
    const hash = row.hash ?? "";
    if (row.path && /^[a-f0-9]{64}$/i.test(hash)) fileHashes.set(row.path.replace(/^_bmad\//, ""), hash.toLowerCase());
  }
  const projected = new Map<string, string>();
  for (const row of csvObjects(skillsText)) {
    const canonicalId = row.canonicalId ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(canonicalId)) continue;
    const skillPath = (row.path ?? "").replace(/^_bmad\//, "");
    if (!skillPath.endsWith("/SKILL.md")) continue;
    const sourceRoot = dirname(skillPath);
    for (const [sourcePath, hash] of fileHashes) {
      if (sourcePath !== `${sourceRoot}/SKILL.md` && !sourcePath.startsWith(`${sourceRoot}/`)) continue;
      const suffix = relative(sourceRoot, sourcePath);
      if (!suffix || suffix.startsWith("..")) continue;
      projected.set(join("skills", canonicalId, suffix), hash);
    }
  }
  return projected.size ? { files: projected } : { files: projected, error: "BMAD manifests contain no projected skill inventory" };
}

function inventoryFilesUnder(root: string, current = root): { files: string[]; unsafe: string[] } {
  if (!existsSync(current)) return { files: [], unsafe: [] };
  const stat = lstatSync(current);
  const rel = relative(root, current) || ".";
  if (stat.isSymbolicLink()) return { files: [], unsafe: [rel] };
  if (stat.isFile()) return { files: [relative(root, current)], unsafe: [] };
  if (!stat.isDirectory()) return { files: [], unsafe: [rel] };
  const result = { files: [] as string[], unsafe: [] as string[] };
  for (const name of readdirSync(current)) {
    const child = inventoryFilesUnder(root, join(current, name));
    result.files.push(...child.files);
    result.unsafe.push(...child.unsafe);
  }
  return result;
}

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
  if (!walked.files.length) return { safe: false, reason: `${rootName} has no installer-owned files` };
  for (const rel of walked.files) {
    const expectedHash = inventory.files.get(rel);
    if (!expectedHash) return { safe: false, reason: `${rootName}/${rel} is outside the BMAD generated inventory` };
    const actualHash = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    if (actualHash !== expectedHash) return { safe: false, reason: `${rootName}/${rel} was locally modified after generation` };
  }
  return { safe: true, reason: `${walked.files.length} file(s) match BMAD installer inventory and hashes` };
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
      details.push(...optionalTemplateScriptIssues(ctx));
      if (!text.includes("patterns = [\"AGENTS.md\"]")) details.push("watch_files must monitor AGENTS.md");
      if (!text.includes(`task = "${LINK_AGENTFILES_TASK}"`)) details.push(`watch_files must dispatch the ${LINK_AGENTFILES_TASK} task`);
      details.push(...retiredTaskNameIssues(text));
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
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
        changedFiles,
        details: changedFiles.length ? [`Normalized hooks/watch_files/tasks."${LINK_AGENTFILES_TASK}" block and script`] : [],
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

export function createAgentHooksChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "skills.project-manifest",
    title: "Skillex project skills manifest",
    audit: (ctx) => {
      const details: string[] = [];
      const manifestPath = join(ctx.repoRoot, ".agents", "skills.json");
      const legacyDir = join(ctx.repoRoot, ".agents", "skills");
      const localExamplePath = join(ctx.repoRoot, ".agents", "local.example.json");
      const misePath = join(ctx.repoRoot, "mise.toml");
      let fixable = true;

      const manifest = tryParseJson(safeReadText(manifestPath));
      // PACKS-CONTRACT: `packs[]` members are projected as symlinks and are NOT
      // required to appear in `skills[]`. Nothing is expanded into `skills[]`
      // any more — BMAD, the last thing that was, is now the installer's.
      const plan = buildPackPlan(ctx, manifest);
      if (plan.errors.length) {
        details.push(...plan.errors);
        fixable = false;
      }
      // PACKS-CONTRACT section 1: an `optional: true` pack that is missing WARNS,
      // it does not fail. Section 3b adds a second advisory class: a declared
      // container that projects nothing, or a symlinked container child that was
      // skipped. Both belong in the canonical summary, never in `details` —
      // a detail is a FAILURE here, and neither of these is one.
      const packAdvisories = [
        ...(plan.warnings.length ? [`${plan.warnings.length} optional pack(s) skipped`] : []),
        ...plan.packWarnings,
      ];
      const expectedByName = new Map(plan.projections);
      const expectedNames = new Set(expectedByName.keys());

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
          // An entry pointing into a `packs/bmad/` tree is a leftover from the
          // retired Skillex pin: bmad-method writes those same skills into
          // .agents/skills itself, and the registry no longer carries the pack
          // at all, so the entry resolves nowhere and fights the installer.
          const bmadEntries = manifest.skills
            .filter((entry) => isRetiredBmadPackEntry(entry))
            .map(skillManifestEntryName)
            .filter((name): name is string => Boolean(name));
          const retiredPacks = retiredPackDeclarations(manifest);
          if (retiredPacks.length) {
            details.push(
              `.agents/skills.json declares retired pack(s) that bmad-method owns and Skillex no longer carries: ${retiredPacks.join(", ")}`,
            );
          }
          if (bmadEntries.length) {
            details.push(
              `.agents/skills.json declares ${bmadEntries.length} bmad-* skill(s) that bmad-method owns and should drop them: ${bmadEntries.join(", ")}`
            );
          }
          // PACKS-CONTRACT section 6: declaring a pack replaces hand-expanded
          // per-skill entries for that pack's members.
          const redundant = manifest.skills
            .filter((entry) => isRedundantDeclaredPackEntry(entry, plan))
            .map(skillManifestEntryName)
            .filter((name): name is string => Boolean(name));
          if (redundant.length) {
            details.push(
              `.agents/skills.json skills[] duplicates ${redundant.length} declared pack member(s) and should drop them: ${redundant.join(", ")}`
            );
          }
        }
      }

      const invalidBmadLinkNames = new Set<string>();
      if (existsSync(legacyDir)) {
        for (const name of readdirSync(legacyDir)) {
          const expected = expectedByName.get(name);
          const path = join(legacyDir, name);
          let linkTargetsPack = false;
          try {
            const linkTarget = lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
            linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget!));
          } catch {
            linkTargetsPack = false;
          }
          if (!expected && !linkTargetsPack) continue;
          try {
            if (!expected || !lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
          } catch {
            invalidBmadLinkNames.add(name);
          }
        }
        for (const [name, expected] of expectedByName) {
          const path = join(legacyDir, name);
          try {
            if (!lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
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

      // PJAN-28: the walk above deliberately skips everything that is not a
      // pinned pack name or a pack symlink. That used to mean legacy committed
      // skills were silently ignored; enumerate them instead.
      const manifestNames = new Set(
        (Array.isArray(manifest?.skills) ? manifest.skills : [])
          .map(skillManifestEntryName)
          .filter((name): name is string => Boolean(name))
      );
      const unmanagedSkillNames = legacyCommittedSkillNames(
        legacyDir,
        skillsBackupDir(ctx.repoRoot),
        expectedNames,
        plan.ownershipRoots,
        manifestNames
      );
      for (const name of unmanagedSkillNames) {
        details.push(`.agents/skills/${name} is present in the projection but declared by nothing`);
      }
      if (unmanagedSkillNames.length) {
        details.push(
          `Run \`pj migrate skills.project-manifest --accept-registry-matches\` to map ${unmanagedSkillNames.length} undeclared skill entr(ies) into the manifest`
        );
      }

      for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
        if (existsSync(join(ctx.repoRoot, rel))) details.push(`${rel} is a legacy symlink-era script and should be removed`);
      }

      const localExample = tryParseJson(safeReadText(localExamplePath));
      if (localExample && Object.prototype.hasOwnProperty.call(localExample, "skills")) {
        details.push(".agents/local.example.json still documents legacy skills overrides; drop the skills section");
      }

      // PACKS-CONTRACT section 7: the BMAD-only provisioner is retired.
      if (existsSync(join(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL))) {
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
        [SYNC_SKILLS_SCRIPT_REL, "Project-local skills sync engine"],
      ] as const) {
        const target = join(ctx.repoRoot, rel);
        const expected = templateCommonProjectText(ctx, rel);
        const stat = lstatIfPresent(target);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
          details.push(`${label} is missing or unsafe`);
          if (stat) fixable = false;
        } else {
          if (expected === undefined || safeReadText(target) !== expected) details.push(`${label} differs from the shipped template`);
          if ((Number(stat.mode) & 0o111) === 0) details.push(`${label} is not executable`);
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
        summary:
          details.length === 0
            ? `Skillex skills manifest parity verified${
                packAdvisories.length ? ` (${packAdvisories.join("; ")})` : ""
              }`
            : `${details.length} Skillex migration issue(s) detected${
                unmanagedSkillNames.length
                  ? ` (${unmanagedSkillNames.length} undeclared skill entr(ies): ${unmanagedSkillNames.join(", ")})`
                  : ""
              }`,
        details,
        fixable,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const manifestPath = join(ctx.repoRoot, ".agents", "skills.json");
      const localExamplePath = join(ctx.repoRoot, ".agents", "local.example.json");
      const misePath = join(ctx.repoRoot, "mise.toml");
      const provisionScriptPath = join(ctx.repoRoot, PROVISION_PACKS_SCRIPT_REL);
      const legacyProvisionScriptPath = join(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL);
      const syncScriptPath = join(ctx.repoRoot, SYNC_SKILLS_SCRIPT_REL);
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
          details: topologyIssues,
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
            ...(!expectedProvisionScript ? [`Missing Skillex pack provisioning script template (${PROVISION_PACKS_SCRIPT_REL})`] : []),
            ...(!expectedSyncScript ? ["Missing project-local skills sync engine template"] : []),
          ],
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
          details: unsafeScriptTargets.map((path) => `${path} must be removed or repaired manually`),
        };
      }

      // Drop forbidden declarations before provisioning: otherwise an
      // unresolvable pack blocks the very migration that would remove it.
      const droppedPacks = dropRetiredPackDeclarations(manifestPath, Boolean(ctx.dryRun));
      if (droppedPacks.length) {
        if (!ctx.dryRun) changedFiles.push(manifestPath);
        details.push(`dropped retired pack declaration(s) bmad-method owns: ${droppedPacks.join(", ")}`);
      }

      const provisioned = provisionDeclaredPacks(ctx);
      if (!provisioned.ok) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "A declared Skillex pack is unavailable or untrusted",
          changedFiles,
          details: [provisioned.error ?? "Unknown Skillex pack error"],
        };
      }
      changedFiles.push(...provisioned.changedFiles);
      if (provisioned.changedFiles.includes(manifestPath)) details.push("Normalized .agents/skills.json against the declared Skillex packs");
      // Section 3b advisories: a declared container that projected nothing must
      // be reported, not silently dropped. It is not a failure, so it only ever
      // annotates the result.
      details.push(...(provisioned.packWarnings ?? []));

      // PJAN-28: runs after the BMAD projection so nothing is mutated ahead of
      // the pack blocker above. provisionDeclaredPacks never touches unmanaged
      // entries, and it preserves every non-pack-managed manifest entry, so
      // appending here is stable in both directions.
      details.push(...migrateLegacyCommittedSkills(ctx, changedFiles));

      // Retired scripts. `provision-bmad-skills.py` (PACKS-CONTRACT section 7)
      // is removed only after `provision-packs.py` has been written below, so a
      // failure part-way through never leaves a repo with neither provisioner.
      for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
        const path = join(ctx.repoRoot, rel);
        if (existsSync(path)) {
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

      // Only now that provision-packs.py exists is the retired one dropped.
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

      let currentMise = safeReadText(misePath);
      if (currentMise === null) {
        const initialized = ensureMiseTomlFromTemplate(ctx, changedFiles);
        if (initialized === null) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details };
        }
        details.push("Initialized mise.toml from generated-project template");
        currentMise = initialized;
      }
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
        details,
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

function supportedCliProjectionIssues(repoRoot: string): string[] {
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
    const hasGeneratedSkill = existsSync(projectedSkills) && readdirSync(projectedSkills).some((name) => {
      const skillFile = join(projectedSkills, name, "SKILL.md");
      return existsSync(skillFile) && lstatSync(skillFile).isFile();
    });
    if (!hasGeneratedSkill) issues.push(`${rootName}/skills contains no BMAD skill configuration`);
  }
  return issues;
}

/**
 * Each CLI root holds hand-owned configuration (settings, commands) that IS
 * durable project state, and a generated `skills/` projection that is not.
 *
 * The un-ignore lines keep the configuration tracked. The trailing re-ignore
 * lines — last match wins in gitignore — drop the skill projections back out,
 * because `bmad-method install` rewrites all of them on every run and version
 * bump. Committing them means ~76 skills duplicated across seven locations,
 * re-churned on every upgrade, when `_bmad/_config/manifest.yaml` already pins
 * the version that reproduces them exactly.
 *
 * PJAN-82: the re-ignore patterns carry NO trailing slash on purpose. A
 * trailing slash matches a directory only, and the projection is not always a
 * directory: `bmad-method install` writes a real directory into .claude,
 * .codex and .opencode, while `sync-skills.py` projects .gemini, .copilot and
 * .kimi-code as a SYMLINK to ../.agents/skills. `.gemini/skills/` therefore
 * never matched the symlink, `!.gemini/**` won instead, and `git add -A`
 * happily staged three generated skill projections as tracked symlinks.
 */
const SUPPORTED_CLI_GITIGNORE_BLOCK = `# Generated CLI configurations are durable project state...
${SUPPORTED_CLI_ROOTS.flatMap((root) => [`!${root}/`, `!${root}/**`]).join("\n")}
# ...but their skill projections are regenerated by \`bmad-method install\` and
# \`mise run skills:sync\`, so they stay out of the tree. No trailing slash:
# some CLIs get a real directory here and some get a symlink.
/.agents/skills
${SUPPORTED_CLI_ROOTS.map((root) => `${root}/skills`).join("\n")}`;

function supportedCliGitignoreIssues(repoRoot: string): string[] {
  const lines = (safeReadText(join(repoRoot, ".gitignore")) ?? "").split(/\r?\n/);
  return [
    ...SUPPORTED_CLI_ROOTS.flatMap((root) => [
      ...(!lines.includes(`!${root}/`) ? [`.gitignore must unignore ${root}/`] : []),
      ...(!lines.includes(`!${root}/**`) ? [`.gitignore must unignore ${root}/**`] : []),
      // Accept either form so an existing repo is not churned, but only the
      // slashless pattern actually covers a symlinked projection.
      ...(!lines.includes(`${root}/skills`) ? [`.gitignore must re-ignore the generated ${root}/skills (no trailing slash — the projection may be a symlink)`] : []),
    ]),
    ...(!lines.includes("/.agents/skills") ? [".gitignore must ignore the generated /.agents/skills"] : []),
  ];
}

function ensureSupportedCliGitignore(ctx: Context): string[] {
  if (!supportedCliGitignoreIssues(ctx.repoRoot).length) return [];
  const path = join(ctx.repoRoot, ".gitignore");
  const current = safeReadText(path) ?? "";
  const next = `${current.replace(/\s*$/, "")}${current.trim() ? "\n\n" : ""}${SUPPORTED_CLI_GITIGNORE_BLOCK}\n`;
  if (!ctx.dryRun) writeText(path, next);
  return [path];
}

function ensureSupportedCliProjections(ctx: Context): { changedFiles: string[]; blockers: string[] } {
  const changedFiles: string[] = [];
  const blockers: string[] = [];
  const managedSkills = join(ctx.repoRoot, ".agents", "skills");
  const managedStat = lstatIfPresent(managedSkills);
  if (!managedStat || managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
    return { changedFiles, blockers: [".agents/skills must be a real BMAD-generated directory before CLI projections can be created"] };
  }
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join(ctx.repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
      blockers.push(`${rootName} is not a real configuration directory`);
      continue;
    }
    if (!rootStat) {
      changedFiles.push(root);
      if (!ctx.dryRun) mkdirSync(root, { recursive: false });
    }
    const skills = join(root, "skills");
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
    migrate: (ctx, finding) => {
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
      const evicted = evictLegacyBmadPackState(ctx, changedFiles);
      const install = runBmadInstall(ctx.repoRoot, selectedModules);
      if (!install.ok) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: `Failed to run bmad-method install`,
          changedFiles: [],
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
    migrate: (ctx, finding) => {
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
      const evicted = evictLegacyBmadPackState(ctx, evictedChanges);

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
      const supportedIssues = supportedCliProjectionIssues(ctx.repoRoot);
      const details = [
        ...supportedIssues,
        ...supportedCliGitignoreIssues(ctx.repoRoot),
        ...attestations.map((entry) => `${entry.name}: ${entry.safe ? "generated and safely removable" : `ambiguous/user-owned — ${entry.reason}`}`),
      ];
      return {
        id: "bmad.cli-roots",
        title: "Supported BMAD CLI projection roots",
        status: details.length ? "fail" : "pass",
        summary: details.length
          ? `${supportedIssues.length} supported projection issue(s); ${present.length} unsupported root(s)`
          : "All six supported CLI projections are configured and no unsupported roots are present",
        details,
        fixable: attestations.every((entry) => entry.safe),
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
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Supported CLI projections contain unsafe or user-owned conflicts",
          changedFiles: [],
          details: projectionResult.blockers,
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
          ? `Reconciled six supported projections and removed ${removedRoots.length} attested unsupported root(s)`
          : "No changes required",
        changedFiles,
        details: attestations.map((entry) => `${entry.name}: ${entry.reason}`),
      };
    },
  },
];
}

export function createHermesChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "hermes.pm-scaffold",
    title: "Hermes orchestrator scaffold parity",
    audit: (ctx) => {
      const selection = managedHermesScaffoldRoles(ctx);
      if (selection.roles.length === 0 && selection.blockers.length === 0) {
        return { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "skip", summary: "No provisioned pm or director role present", details: [], fixable: false };
      }
      const details: string[] = [...selection.blockers];
      const templateRoleDir = join(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      const managedScripts = templateFiles(join(templateRoleDir, ".scripts"))
        .filter((rel) => rel !== "sentinel.prompt.md.jinja");
      for (const role of selection.roles) {
        const prefix = role.agentId || role.role;
        for (const rel of ["role.yaml", "SOUL.md", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md"]) {
          if (!existsSync(join(role.roleDir, rel))) details.push(`${prefix}: missing ${relative(ctx.repoRoot, join(role.roleDir, rel))}`);
        }
        const wrapper = join(role.roleDir, "hermes");
        const expectedWrapper = renderHermesWrapper(role, templateRoleDir);
        if (!existsSync(wrapper)) details.push(`${prefix}: missing ${relative(ctx.repoRoot, wrapper)}`);
        else if (safeReadText(wrapper) !== expectedWrapper) details.push(`${prefix}: stale ${relative(ctx.repoRoot, wrapper)}`);
        const expectedIgnore = readText(join(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role);
        const ignorePath = join(role.roleDir, ".gitignore");
        if (!existsSync(ignorePath)) details.push(`${prefix}: missing ${relative(ctx.repoRoot, ignorePath)}`);
        else if (safeReadText(ignorePath) !== expectedIgnore) details.push(`${prefix}: stale ${relative(ctx.repoRoot, ignorePath)}`);
        for (const rel of managedScripts) {
          const source = join(templateRoleDir, ".scripts", rel);
          const target = join(role.roleDir, ".scripts", rel);
          if (!existsSync(target)) details.push(`${prefix}: missing ${relative(ctx.repoRoot, target)}`);
          else if (safeReadText(target) !== readText(source)) details.push(`${prefix}: stale ${relative(ctx.repoRoot, target)}`);
        }
        const promptPath = join(role.roleDir, ".scripts", "sentinel.prompt.md");
        if (!existsSync(promptPath)) details.push(`${prefix}: missing ${relative(ctx.repoRoot, promptPath)}`);
        else if (safeReadText(promptPath) !== renderSentinelPrompt(role, templateRoleDir)) details.push(`${prefix}: stale ${relative(ctx.repoRoot, promptPath)}`);
        if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) details.push(`${prefix}: .gitmodules contains retired ${role.role} runtime submodule mapping`);
        if (!profileMetaInheritsDefault(join(role.roleDir, "runtime", "profile.yaml"))) details.push(`${prefix}: runtime/profile.yaml missing inherited default config metadata`);
        const registry = safeReadText(registryPath(ctx.homeDir));
        if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
      }
      return {
        id: "hermes.pm-scaffold",
        title: "Hermes orchestrator scaffold parity",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? `${selection.roles.length} orchestrator scaffold(s) verified` : `${details.length} orchestrator scaffold issue(s) detected`,
        details,
        fixable: selection.blockers.length === 0,
      };
    },
    migrate: (ctx, finding) => {
      const selection = managedHermesScaffoldRoles(ctx);
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (selection.blockers.length > 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "Provisioned orchestrator manifest is invalid", changedFiles, details: selection.blockers };
      }
      if (selection.roles.length === 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No provisioned pm or director role present", changedFiles, details: [] };
      }
      const templateRoleDir = join(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      const managedScripts = templateFiles(join(templateRoleDir, ".scripts"))
        .filter((rel) => rel !== "sentinel.prompt.md.jinja");
      for (const role of selection.roles) {
        const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
        details.push(...retirement.details);
        if (!retirement.ok) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: `Failed to retire ${role.role} runtime submodule metadata safely`, changedFiles, details: [retirement.error ?? "unknown runtime retirement failure"] };
        }
        if (!existsSync(join(role.roleDir, "SOUL.md"))) writeIfDifferent(join(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
        writeIfDifferent(join(role.roleDir, "hermes"), renderHermesWrapper(role, templateRoleDir), ctx.dryRun, changedFiles, 0o755);
        writeIfDifferent(join(role.roleDir, ".gitignore"), readText(join(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role), ctx.dryRun, changedFiles);
        copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
        copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
        for (const rel of managedScripts) {
          const source = join(templateRoleDir, ".scripts", rel);
          const executable = (lstatSync(source).mode & 0o111) !== 0;
          writeIfDifferent(join(role.roleDir, ".scripts", rel), readText(source), ctx.dryRun, changedFiles, executable ? 0o755 : undefined);
        }
        writeIfDifferent(join(role.roleDir, ".scripts", "sentinel.prompt.md"), renderSentinelPrompt(role, templateRoleDir), ctx.dryRun, changedFiles);
        const profileMetaUpdated = upsertInheritedProfileMeta(join(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
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

        if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) {
          details.push(`stale .gitmodules mapping exists for ${runtimeRelPath}`);
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
        const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
        details.push(...retirement.details);
        if (!retirement.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Failed to retire Hermes runtime submodule metadata safely",
            changedFiles,
            details: [retirement.error ?? "unknown runtime retirement failure"],
          };
        }

        // Update .gitignore only after index removal is verified and the stale
        // mapping has been retired.
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
    // PJAN-84: host-scoped — systemd --user units on this machine.
    scope: "host",
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
      const details: string[] = [];
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
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot).filter((role) => role.deploymentSystemd !== "deferred");
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (!roles.length) {
        return { id: finding.id, title: finding.title, status: "skipped", summary: "systemd is intentionally deferred for local-only Hermes roles", changedFiles, details };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
      }
      for (const role of roles) {
        const sysDir = join(ctx.homeDir, ".config", "systemd", "user");
        const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`];
        const allUnitsPresent = units.every((unit) => existsSync(join(sysDir, unit)));
        // Existing units can still point at the checkout's former location.
        // In that case enabling them again preserves the stale ExecStart path,
        // so regenerate them from the role's current provisioning script.
        const unitsStale = units.some((unit) => {
          const text = safeReadText(join(sysDir, unit));
          if (text === null) return true;
          return text.includes("/agents/hermes/") && !text.includes(role.roleDir);
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
        for (const script of [join(role.roleDir, ".scripts", "70-systemd.sh")]) {
          if (!existsSync(script)) {
            details.push(`script failed: missing ${script}`);
            continue;
          }
          if (ctx.dryRun) {
            details.push(`would run: FORCE_SYSTEMD=1 bash ${script}`);
          } else {
            const result = spawnSync("bash", [script], {
              cwd: role.roleDir,
              encoding: "utf8",
              env: { ...process.env, FORCE_SYSTEMD: "1" },
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
        status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: details.length ? (ctx.dryRun ? "Planned systemd remediation commands" : "Attempted systemd remediation") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "hermes.runtime-singleton",
    title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.runtime-singleton", title: "Hermes singleton runtime (shared config/auth, per-agent memory)", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        if (!existsSync(plan.fleetRoot)) {
          details.push(`fleet root missing at ${plan.fleetRoot}`);
          continue;
        }
        // The profile entry must be a REAL directory. If it is a symlink,
        // get_active_profile_name() resolves through it, escapes the profiles
        // root, and reports "custom" instead of the profile name.
        if (!existsSync(plan.profileDir)) {
          details.push(`profile dir missing: ${plan.profileDir}`);
        } else if (lstatSync(plan.profileDir).isSymbolicLink()) {
          details.push(`profile dir is a symlink (must be a real dir): ${plan.profileDir}`);
        }
        for (const link of plan.links) {
          const state = linkState(link.path, link.target);
          if (state !== "ok") details.push(`${state}: ${link.path} -> ${link.target}`);
        }
        details.push(...profileConfigFindings(plan.profileDir, profileNameOf(role)));
      }
      return {
        id: "hermes.runtime-singleton",
        title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Singleton runtime contract satisfied" : `${details.length} singleton-runtime issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        if (!existsSync(plan.fleetRoot)) {
          details.push(`blocked: fleet root missing at ${plan.fleetRoot}`);
          continue;
        }
        // Seed the shared singletons from the richest existing runtime copy so a
        // first migration never lands agents on an empty config.
        for (const shared of plan.sharedSeeds) {
          if (existsSync(shared.rootPath)) continue;
          const donor = existsSync(shared.runtimePath) ? shared.runtimePath : null;
          if (!donor) continue;
          details.push(`seed fleet ${basename(shared.rootPath)} from ${donor}`);
          changedFiles.push(shared.rootPath);
          if (!ctx.dryRun) copyFileSync(donor, shared.rootPath);
        }
        // Replace a symlinked profile entry with a real directory.
        if (existsSync(plan.profileDir) && lstatSync(plan.profileDir).isSymbolicLink()) {
          details.push(`convert profile symlink to real dir: ${plan.profileDir}`);
          changedFiles.push(plan.profileDir);
          if (!ctx.dryRun) unlinkSync(plan.profileDir);
        }
        if (!existsSync(plan.profileDir)) {
          details.push(`create profile dir: ${plan.profileDir}`);
          changedFiles.push(plan.profileDir);
          if (!ctx.dryRun) mkdirSync(plan.profileDir, { recursive: true });
        }
        for (const link of plan.links) {
          const state = linkState(link.path, link.target);
          if (state === "ok") continue;
          // Person-owned targets must exist before linking or the agent starts
          // against a dangling path and silently recreates empty state.
          if (link.ensureTargetDir && !existsSync(link.target) && !ctx.dryRun) {
            mkdirSync(link.target, { recursive: true });
          }
          details.push(`link ${link.path} -> ${link.target}`);
          changedFiles.push(link.path);
          if (ctx.dryRun) continue;
          if (existsSync(link.path) || isDanglingLink(link.path)) {
            const lst = lstatSync(link.path);
            if (lst.isSymbolicLink()) {
              unlinkSync(link.path);
            } else {
              // Never discard real user data: park it beside the profile.
              const parked = `${link.path}.pre-singleton`;
              renameSync(link.path, parked);
              details.push(`parked pre-existing ${link.path} at ${parked}`);
            }
          }
          ensureParent(link.path);
          symlinkSync(link.target, link.path);
        }
        // Render config.yaml from base+delta and pin the identity-memory bank.
        // This deliberately does NOT symlink config.yaml (see
        // SHARED_PROFILE_ENTRIES): the renderer owns that file now.
        const profileName = profileNameOf(role);
        if (profileConfigFindings(plan.profileDir, profileName).length) {
          const renderer = profileRendererPath(ctx);
          if (!renderer) {
            details.push(`blocked: profile renderer not found (expected hermes-agent-template/scripts/hermes-profile-config.py); cannot render ${plan.profileDir}/config.yaml`);
          } else {
            details.push(`render config.yaml + pin memory bank for ${profileName}`);
            changedFiles.push(join(plan.profileDir, "config.yaml"), join(plan.profileDir, "config.delta.yaml"));
            if (!ctx.dryRun) {
              for (const args of [["init", "--profile", profileName], ["memory-pin", "--profile", profileName]]) {
                const res = spawnSync("python3", [renderer, ...args], { encoding: "utf8" });
                if (res.status !== 0) {
                  details.push(`blocked: ${basename(renderer)} ${args[0]} failed for ${profileName}: ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
                }
              }
            }
          }
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.some((d) => d.startsWith("blocked:")) ? "blocked" : changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        // PJAN-75: the summary has to follow the status. The blocked branch was
        // missing here, so a run that stopped on a missing profile renderer
        // still reported "Singleton runtime wired" -- and that string is what
        // surfaced as the recipe's ERROR message, telling the operator the
        // exact opposite of what happened.
        summary: details.some((d) => d.startsWith("blocked:"))
          ? "Singleton-runtime wiring blocked"
          : changedFiles.length ? (ctx.dryRun ? "Planned singleton-runtime wiring" : "Singleton runtime wired") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    // Fleet-base invariants. Every profile inherits ~/.hermes/config.yaml by
    // generation, so a defect here is a defect in EVERY agent at once — and each
    // of these has already shipped silently: no error, no log, just an agent
    // quietly missing a capability.
    id: "hermes.fleet-config",
    title: "Fleet base config carries the capabilities every agent inherits",
    // PJAN-84: host-scoped — $HOME/.hermes/fleet.env, shared by every agent.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.fleet-config", title: "Fleet base config carries the capabilities every agent inherits", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const base = join(fleetHome(ctx), "config.yaml");
      const details: string[] = [];
      let cfg: any = null;
      if (!existsSync(base)) {
        details.push(`fleet base config missing: ${base}`);
      } else {
        try {
          cfg = YAML.parse(readFileSync(base, "utf8")) ?? {};
        } catch (err) {
          details.push(`fleet base config is unparseable YAML: ${base} (${(err as Error).message})`);
        }
      }

      if (cfg) {
        // TTS provider must be the REGISTRY KEY, not the product name. "voxxy"
        // is the service (swappable engines: voxcpm/vibevoice/elevenlabs); the
        // Hermes plugin registers as "vox". An unknown provider does not error —
        // Hermes falls back to a built-in (ElevenLabs when the key is set, else
        // Edge) and you simply hear the wrong voice. Regressed twice.
        const ttsProvider = cfg?.tts?.provider;
        if (ttsProvider && ttsProvider !== "vox") {
          details.push(`tts.provider is "${ttsProvider}" — must be "vox" (registry key). "voxxy" is the service name and matches no registered provider, so TTS silently falls back to a built-in.`);
        }

        // Bloodbank lifecycle hooks. These lived on 3 of 36 profiles once, so 33
        // agents emitted no events at all while appearing healthy.
        const hooks = cfg?.hooks;
        const REQUIRED_HOOKS = ["on_session_start", "on_session_end", "pre_tool_call", "post_tool_call"];
        if (!hooks || typeof hooks !== "object") {
          details.push(`no hooks: block in the fleet base — every agent publishes zero Bloodbank lifecycle events: ${base}`);
        } else {
          const missing = REQUIRED_HOOKS.filter((h) => !hooks[h]);
          if (missing.length) details.push(`fleet base hooks missing event(s): ${missing.join(", ")}`);
          const serialized = JSON.stringify(hooks);
          if (!serialized.includes("hooks/bloodbank/publish.py")) {
            details.push(`fleet base hooks do not call the canonical publisher (~/.agents/hooks/bloodbank/publish.py --client hermes)`);
          }
        }

        // Memory: the provider can be configured and still be muzzled. Tool
        // injection is gated by agent.disabled_toolsets while auto recall/retain
        // keeps running underneath, so "memory works" and "the agent can use
        // memory" are different questions.
        const provider = cfg?.memory?.provider;
        if (!provider) {
          details.push(`memory.provider is unset in the fleet base — agents get no external memory`);
        }
        const disabled: unknown = cfg?.agent?.disabled_toolsets;
        if (Array.isArray(disabled) && disabled.includes("memory")) {
          details.push(`agent.disabled_toolsets contains "memory" — memory tools are suppressed fleet-wide even though memory.provider is set (auto recall/retain still runs, which masks it)`);
        }

        // Skills reach agents only through external_dirs; a profile that
        // inherits an empty list silently has no skills at all.
        const dirs: unknown = cfg?.skills?.external_dirs;
        if (!Array.isArray(dirs) || dirs.length === 0) {
          details.push(`skills.external_dirs is empty in the fleet base — no agent can see any shared skill`);
        }
      }

      return {
        id: "hermes.fleet-config",
        title: "Fleet base config carries the capabilities every agent inherits",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Fleet base config invariants satisfied" : `${details.length} fleet-base config issue(s) detected`,
        details,
        // Deliberately not auto-fixable: these are fleet-wide values whose
        // correct setting is an operator decision, and a wrong guess would
        // change behavior for every agent simultaneously.
        fixable: false,
      };
    },
    // The audit above is `fixable: false`, so `migrate --all` never selects
    // this rule -- but naming it explicitly must still produce an answer. It
    // shipped with no migrate at all, which the registry surfaced as
    // "migrate threw: check.migrate is not a function": true, but useless.
    migrate: (ctx, finding) => ({
      id: finding.id,
      title: finding.title,
      status: "blocked",
      summary: "Fleet base config is operator-owned; pjangler will not guess fleet-wide values",
      changedFiles: [],
      details: finding.details.length
        ? [...finding.details, `Edit ${join(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`]
        : [`Edit ${join(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`],
    }),
  },
  {
    id: "hermes.profile-wiring",
    title: "Launcher + systemd HERMES_HOME points at the named profile",
    // PJAN-84: host-scoped — $HOME/.hermes/profiles and the launcher's HERMES_HOME.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.profile-wiring", title: "Launcher + systemd HERMES_HOME points at the named profile", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        const launcher = join(role.roleDir, "hermes");
        const text = safeReadText(launcher);
        if (text === null) {
          details.push(`launcher missing: ${relative(ctx.repoRoot, launcher)}`);
        } else {
          // Match the ASSIGNMENT, not one known-bad spelling of it. Earlier
          // revisions only tested for `HERMES_HOME="$RUNTIME_HOME"`, so every
          // launcher still carrying the older `HERMES_HOME="$ROLE_DIR/runtime"`
          // form — which is what the fleet template emitted — passed this audit
          // while running split-brain against its own systemd unit.
          const assigned = /^HERMES_HOME=(.*)$/m.exec(text)?.[1]?.trim();
          if (assigned !== undefined && !isProfileHomeExpr(assigned)) {
            details.push(`launcher sets HERMES_HOME=${assigned} instead of the named profile dir (disables shared auth + profile identity): ${relative(ctx.repoRoot, launcher)}`);
          }
          if (/HERMES_OAUTH_FILE/.test(text)) {
            details.push(`launcher exports HERMES_OAUTH_FILE, which Hermes does not implement (dead config): ${relative(ctx.repoRoot, launcher)}`);
          }
        }
        for (const unit of profileUnits(role)) {
          const unitPath = join(ctx.homeDir, ".config", "systemd", "user", unit);
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
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];
      let unitsTouched = false;
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        const launcher = join(role.roleDir, "hermes");
        const text = safeReadText(launcher);
        if (text !== null) {
          const before = /^HERMES_HOME=(.*)$/m.exec(text)?.[1]?.trim();
          const rewritten = rewriteLauncher(text, role.profileName || role.agentId);
          if (rewritten !== text) {
            // Say which change actually happened — the previous single message
            // claimed a HERMES_HOME rewrite even when only the dead
            // HERMES_OAUTH_FILE export was stripped.
            const rel = relative(ctx.repoRoot, launcher);
            if (before !== undefined && !isProfileHomeExpr(before)) {
              details.push(`rewrite launcher HERMES_HOME ${before} -> ${plan.profileDir}: ${rel}`);
            }
            if (/HERMES_OAUTH_FILE/.test(text)) {
              details.push(`strip dead HERMES_OAUTH_FILE export: ${rel}`);
            }
            writeIfDifferent(launcher, rewritten, ctx.dryRun, changedFiles, 0o755);
          }
        }
        for (const unit of profileUnits(role)) {
          const unitPath = join(ctx.homeDir, ".config", "systemd", "user", unit);
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
        status: changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: changedFiles.length ? (ctx.dryRun ? "Planned HERMES_HOME rewiring" : "HERMES_HOME rewired to named profiles") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "hermes.registry-parity",
    title: "Fleet registry matches .project.json (no duplicate or stale agents)",
    // PJAN-84: host-scoped — $HOME/.hermes/agents-registry.yaml.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      const details: string[] = [];
      let malformedRoleGate = false;
      const registryPath = join(ctx.homeDir, ".hermes", "agents-registry.yaml");
      const registry = readRegistry(registryPath);
      if (!registry) {
        if (!roles.length && declaredAgentIds(ctx.repoRoot).length === 0) {
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles or declared agents present", details: [], fixable: false };
        }
        return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "warn", summary: `registry unreadable at ${registryPath}`, details: [], fixable: false };
      }
      // role.yaml is the identity SSOT. discoverRoles() only walks this repo's
      // own agents/hermes/*, so nested submodule agents are correctly excluded --
      // a naive role_dir.startsWith(repoRoot) would swallow them and propose
      // deleting perfectly good sibling agents.
      const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
      const owned = ownedRegistryEntries(registry, ctx.repoRoot);
      const unprovisioned = unprovisionedRoleAgents(registry, ctx.repoRoot, canonical);
      if (unprovisioned.length) {
        return {
          id: "hermes.registry-parity",
          title: "Fleet registry matches .project.json (no duplicate or stale agents)",
          status: "fail",
          summary: `${unprovisioned.length} unprovisioned Hermes role blocker(s) detected`,
          details: unprovisioned.map(({ agentId, roleDir, sources }) =>
            `agent "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role, do not delete its registry/declaration`
          ),
          fixable: false,
        };
      }
      if (canonical.size === 0) {
        return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles, declarations, or registry entries present", details: [], fixable: false };
      }
      // With at least one provisioned role, stale sibling identities can be
      // compared safely against role.yaml. The empty-role case returned above
      // as a truthful non-fixable blocker and never enters destructive repair.
      for (const [agentId, entry] of owned) {
        const roleDir = String((entry as Record<string, unknown>)?.role_dir ?? "");
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
          details.push(`${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
          malformedRoleGate = true;
        }
        const entry = registry[role.agentId] as Record<string, unknown> | undefined;
        if (!entry) {
          details.push(`registry is missing an entry for ${role.agentId}`);
          continue;
        }
        const entryRoleDir = String(entry.role_dir ?? "");
        if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
          details.push(`registry role_dir for ${role.agentId} is ${entryRoleDir} (expected ${role.roleDir})`);
        }
        const bin = String((entry.hermes as Record<string, unknown> | undefined)?.bin ?? "");
        if (bin && !existsSync(bin)) {
          details.push(`registry hermes.bin for ${role.agentId} does not exist: ${bin}`);
        }
        // Fleet-bloodbank standard: one shared gateway owns command ingress.
        // Every agent entry advertises fleet routing; none carries the retired
        // per-agent consumer/checkpoint contract in the registry or on disk.
        const bloodbank = (entry.bloodbank ?? {}) as Record<string, unknown>;
        if (typeof bloodbank.enabled !== "boolean") {
          details.push(`registry entry for ${role.agentId} bloodbank.enabled must be a strict boolean`);
        } else if (expectedBloodbankEnabled !== null && bloodbank.enabled !== expectedBloodbankEnabled) {
          details.push(`registry entry for ${role.agentId} bloodbank.enabled must match explicit role value ${expectedBloodbankEnabled}`);
        }
        if (bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
          details.push(`registry entry for ${role.agentId} must advertise bloodbank { gateway_scope: fleet, target_agent_id: ${role.agentId} }`);
        }
        const systemd = (entry.systemd ?? {}) as Record<string, unknown>;
        for (const key of LEGACY_SYSTEMD_KEYS) {
          if (systemd[key] !== undefined) {
            details.push(`registry entry for ${role.agentId} carries retired systemd.${key}; the fleet-shared Bloodbank gateway owns command ingress`);
          }
        }
        const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
        if (existsSync(legacyUnit)) {
          details.push(`retired per-agent consumer unit still on disk: ${legacyUnit}`);
        }
      }
      return {
        id: "hermes.registry-parity",
        title: "Fleet registry matches .project.json (no duplicate or stale agents)",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Fleet registry is in parity" : `${details.length} registry parity issue(s) detected`,
        details,
        fixable: !malformedRoleGate,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const registryPath = join(ctx.homeDir, ".hermes", "agents-registry.yaml");
      let raw = safeReadText(registryPath);
      if (raw === null) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: `registry unreadable at ${registryPath}`, changedFiles, details };
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
          details: malformedRoleGates.map((role) =>
            `${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`
          ),
        };
      }
      const missingRoles = roles.filter((role) => !raw!.includes(`${role.agentId}:`));
      for (const role of missingRoles) {
        const updated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
        if (updated) details.push(`add missing fleet registry entry for ${role.agentId}`);
        if (!ctx.dryRun) raw = safeReadText(registryPath) ?? raw;
      }
      if (ctx.dryRun && missingRoles.length) {
        return { id: finding.id, title: finding.title, status: "skipped", summary: "Planned missing fleet registry entries", changedFiles: [...new Set(changedFiles)], details };
      }
      let doc: Record<string, unknown>;
      try {
        doc = YAML.parse(raw) as Record<string, unknown>;
      } catch {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "registry is not valid YAML", changedFiles, details };
      }
      const agents = (doc?.agents ?? {}) as Record<string, Record<string, unknown>>;
      const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
      const unprovisioned = unprovisionedRoleAgents(agents, ctx.repoRoot, canonical);
      if (unprovisioned.length) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Registry parity is blocked by an unprovisioned Hermes role",
          changedFiles,
          details: unprovisioned.map(({ agentId, roleDir, sources }) =>
            `blocked: "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role without pruning registry/declaration state`
          ),
        };
      }
      const fleetBin = fleetBinPath(ctx);
      let dirty = false;

      if (canonical.size === 0) {
        // Unprovisioned repo: report, never delete. Losing these entries costs
        // the Plane binding and unit names that provisioning cannot rebuild.
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
            details,
          };
        }
      }
      // A moved checkout is deliberately invisible to ownedRegistryEntries(),
      // because that helper scopes ownership using the registry's role_dir.
      // role.yaml gives us a safer canonical identity: repair the matching
      // agent by id first, then let normal ownership-scoped cleanup proceed.
      for (const role of roles) {
        const entry = agents[role.agentId] as Record<string, unknown> | undefined;
        if (!entry) continue;
        const entryRoleDir = String(entry.role_dir ?? "");
        if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
          details.push(`repoint ${role.agentId} role_dir -> ${role.roleDir}`);
          entry.role_dir = role.roleDir;
          entry.project_path = ctx.repoRoot;
          dirty = true;
        }
        // Converge on the fleet-bloodbank standard: advertise fleet routing,
        // drop the retired per-agent consumer/checkpoint contract, and remove
        // any leftover consumer unit file from disk.
        const bloodbank = (entry.bloodbank ?? {}) as Record<string, unknown>;
        const expectedBloodbankEnabled = roleBloodbankEnabled(role) ?? false;
        if (bloodbank.enabled !== expectedBloodbankEnabled || bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
          details.push(`normalize fleet bloodbank routing for ${role.agentId} with enabled=${expectedBloodbankEnabled}`);
          entry.bloodbank = { ...bloodbank, enabled: expectedBloodbankEnabled, gateway_scope: "fleet", target_agent_id: role.agentId };
          dirty = true;
        }
        const systemd = entry.systemd as Record<string, unknown> | undefined;
        if (systemd) {
          for (const key of LEGACY_SYSTEMD_KEYS) {
            if (systemd[key] !== undefined) {
              details.push(`drop retired systemd.${key} from ${role.agentId}`);
              delete systemd[key];
              dirty = true;
            }
          }
        }
        const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
        if (existsSync(legacyUnit)) {
          if (ctx.dryRun) {
            details.push(`would remove retired consumer unit ${legacyUnit}`);
          } else {
            systemctlUser(["disable", "--now", basename(legacyUnit)]);
            rmSync(legacyUnit, { force: true });
            systemctlUser(["daemon-reload"]);
            systemctlUser(["reset-failed"]);
            details.push(`removed retired consumer unit ${legacyUnit}`);
          }
          changedFiles.push(legacyUnit);
        }
      }
      for (const [agentId, entry] of ownedRegistryEntries(agents, ctx.repoRoot)) {
        // Only ids this repo's own role.yaml files claim survive. Scoping is by
        // derived project root, so nested submodule agents are never touched.
        if (canonical.size > 0 && !canonical.has(agentId)) {
          details.push(`drop stale/duplicate registry agent "${agentId}"`);
          delete agents[agentId];
          dropDeclaredAgent(ctx, agentId, changedFiles, details);
          dirty = true;
          continue;
        }
        const hermes = (entry.hermes ?? {}) as Record<string, unknown>;
        if (fleetBin && String(hermes.bin ?? "") !== fleetBin && !existsSync(String(hermes.bin ?? ""))) {
          details.push(`repoint ${agentId} hermes.bin -> ${fleetBin}`);
          hermes.bin = fleetBin;
          entry.hermes = hermes;
          dirty = true;
        }
        // HERMES_OAUTH_FILE is documented but unimplemented; drop the pointer so
        // the registry stops advertising a sharing mechanism that does nothing.
        if (hermes.oauth_file) {
          details.push(`drop dead hermes.oauth_file from ${agentId}`);
          delete hermes.oauth_file;
          dirty = true;
        }
      }

      // Once role.yaml establishes the canonical identity, stale declarations
      // can be retired alongside duplicate registry entries.
      if (canonical.size > 0) {
        for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
          dropDeclaredAgent(ctx, extra, changedFiles, details);
        }
      }

      if (dirty) {
        changedFiles.push(registryPath);
        if (!ctx.dryRun) {
          doc.agents = agents;
          writeText(registryPath, YAML.stringify(doc));
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: changedFiles.length ? (ctx.dryRun ? "Planned registry repair" : "Fleet registry repaired") : "No changes required",
        changedFiles,
        details,
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

export function createProjectChecks(): RecipeOwnedCheck[] {
  return [
    ...createProjectJsonChecks(),
    ...createProjectProvenanceChecks(),
    ...createProjectMomoChecks(),
  ];
}

function writeIfDifferent(path: string, content: string, dryRun: boolean, changedFiles: string[], mode?: number): void {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
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
