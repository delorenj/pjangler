// `pjangler describe` — read a repo and report what it actually is.
//
// This is the AI-context surface: an agent (or a human) lands in an unfamiliar
// repo, runs one command, and learns the project type, which pjangler
// subsystems are installed, which config files exist, and what is worth doing
// next. Everything here is derived from the repo on disk plus the live
// production recipe registry — nothing is hardcoded per-project and nothing is
// inferred from prose.
//
// Two independent signals are deliberately kept apart:
//
//   presence — does the subsystem's marker file/dir exist? (is it installed?)
//   parity   — do the recipe's own audit rules pass? (is it correct?)
//
// They are not the same question. A parity rule fails both when a subsystem is
// missing and when it is present but drifted, so collapsing the two would make
// `describe` claim "broken" where the truth is "never installed".

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { recipeRegistry, lifecycleContext } from "../parity/index";
import type { LifecycleAuditFinding, LifecycleStatus } from "../recipes/types";
import {
  loadProjectRegistry,
  projectRegistryPath,
  type ProjectRecord,
} from "../project/index";
import { computeRepoActivity, gitLine, isGitRepo, type RepoActivity } from "./activity";
import {
  bold,
  cyan,
  dim,
  gray,
  glyph,
  green,
  red,
  terminalWidth,
  truncateVisible,
  visibleWidth,
  wrapVisible,
  yellow,
} from "../utils/style";

/** Headline answer to "is this subsystem in this repo?". */
export type SubsystemStatus = "installed" | "drifted" | "absent";

/** Answer to "do this subsystem's own parity rules pass?". */
export type ParityHealth = "ok" | "drift" | "unchecked";

export interface DescribeRule {
  id: string;
  title: string;
  status: LifecycleStatus;
  summary: string;
  fixable: boolean;
}

export interface DescribeSubsystem {
  id: string;
  name: string;
  description: string;
  status: SubsystemStatus;
  parity: ParityHealth;
  /** Repo-relative marker paths that prove presence. */
  evidence: string[];
  rules: DescribeRule[];
}

export interface DescribeConfigFile {
  path: string;
  purpose: string;
  /** Owning subsystem id, or "-" when the file belongs to no pjangler recipe. */
  subsystem: string;
}

export interface DescribeNextStep {
  title: string;
  reason: string;
  source: "lifecycle" | "registry" | "parity" | "agents";
  command?: string;
  /** Parity rule ids this step covers, when it stands in for more than one. */
  rules?: string[];
  /** One line per covered finding. Kept structured — rule summaries contain
   *  their own punctuation, so a joined string cannot be split back apart. */
  details?: string[];
}

export interface DescribeGit {
  isRepo: boolean;
  branch?: string;
  head?: string;
  remote?: string;
  /** Count of porcelain entries; 0 means clean. */
  dirtyFiles?: number;
}

export interface DescribeDriftNote {
  note: string;
  /** Only set when a command actually resolves this drift. Field-value
   *  disagreements have no auto-fix, and claiming one would send the reader
   *  to a command that cannot see the problem. */
  command?: string;
}

export interface DescribeAgent {
  name: string;
  role: string;
  provisioningState: string;
  roleDir?: string;
}

export interface DescribeIdentity {
  /** A `.project.json` manifest exists at the repo root. */
  manifest: boolean;
  /** The repo is present in the pjangler central registry. */
  registered: boolean;
  registryPath: string;
  slug?: string;
  name?: string;
  description?: string;
  // No `status` here on purpose. The registry carries one, but it reads
  // "planned" for every project ever registered — a repo in the registry is by
  // definition past planning — so it was a field that never varied and never
  // informed. `ProjectDescription.activity` answers the question it pretended
  // to, and answers it from git rather than from a value nobody updates.
  ticketProvider?: {
    type: string;
    workspace?: string;
    identifier?: string;
    boardId?: string;
    state?: string;
  };
  agents: DescribeAgent[];
  /** Disagreements between the manifest and the central registry. */
  drift: DescribeDriftNote[];
}

export interface DescribeType {
  primaryLanguage?: string;
  languages: string[];
  /** What the repo *is* — cli, mcp-server, copier-template, 33god-project… */
  roles: string[];
  /** `<signal> (<file that proved it>)` lines backing the fields above. */
  evidence: string[];
}

export interface ProjectDescription {
  repo: string;
  describedAt: string;
  git: DescribeGit;
  /** When work last happened here, across every branch, worktree, and edit. */
  activity: RepoActivity;
  type: DescribeType;
  identity: DescribeIdentity;
  subsystems: DescribeSubsystem[];
  configFiles: DescribeConfigFile[];
  nextSteps: DescribeNextStep[];
  parity: {
    ok: boolean;
    counts: Record<LifecycleStatus, number>;
  };
}

export interface DescribeInput {
  repoArg?: string;
  registryPath?: string;
  /** Injected clock, so relative ages are deterministic under test. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Detection tables
// ---------------------------------------------------------------------------

/**
 * Marker paths that prove a subsystem is installed, keyed by production recipe
 * id. Recipes carry no presence probe of their own — their checks answer
 * conformance, not existence — so presence lives here, next to the recipe ids
 * it mirrors. A recipe with no entry reports `absent` until one is added.
 */
const SUBSYSTEM_MARKERS: Record<string, readonly string[]> = {
  "mise-op-inject": [".env.op"],
  mise: ["mise.toml", ".mise.toml", ".mise/config.toml"],
  "agent-hooks": [".agents/skills.json", ".agents/hooks"],
  bmad: ["_bmad"],
  docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  node: ["package.json"],
  "hermes-agent": ["agents/hermes"],
  project: [".project.json"],
};

interface LanguageMarker {
  file: string;
  language: string;
}

const LANGUAGE_MARKERS: readonly LanguageMarker[] = [
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
  { file: "composer.json", language: "php" },
];

interface ConfigFileSpec {
  path: string;
  purpose: string;
  subsystem: string;
}

/**
 * Config files worth reporting, with the subsystem that owns each. Only paths
 * that exist are emitted, so this stays a lookup table rather than a claim.
 */
const CONFIG_FILES: readonly ConfigFileSpec[] = [
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
  { path: ".github/workflows", purpose: "GitHub Actions CI", subsystem: "-" },
];

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function describeGit(repo: string, activity: RepoActivity): DescribeGit {
  if (!isGitRepo(repo)) return { isRepo: false };
  // The activity scan already counted dirty files; re-running `git status`
  // here would be a second scan of the same working tree for the same number.
  return {
    isRepo: true,
    branch: gitLine(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: gitLine(repo, ["rev-parse", "--short", "HEAD"]),
    remote: gitLine(repo, ["remote", "get-url", "origin"]),
    dirtyFiles: activity.scanned.dirtyFiles,
  };
}

function describeType(repo: string): DescribeType {
  const languages: string[] = [];
  const roles: string[] = [];
  const evidence: string[] = [];

  const note = (signal: string, file: string) => evidence.push(`${signal} (${file})`);

  for (const marker of LANGUAGE_MARKERS) {
    if (!existsSync(join(repo, marker.file))) continue;
    if (!languages.includes(marker.language)) {
      languages.push(marker.language);
      note(marker.language, marker.file);
    }
  }

  // Shallow scan only: .NET projects put the manifest at the repo root, and a
  // deep walk would make `describe` pay for the whole tree.
  try {
    const dotnet = readdirSync(repo).find((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"));
    if (dotnet && !languages.includes("dotnet")) {
      languages.push("dotnet");
      note("dotnet", dotnet);
    }
  } catch {
    // Unreadable repo root: languages stay as detected so far.
  }

  const pkg = readJson(join(repo, "package.json"));
  if (pkg) {
    if (existsSync(join(repo, "tsconfig.json"))) {
      const index = languages.indexOf("javascript");
      if (index >= 0) languages.splice(index, 1);
      if (!languages.includes("typescript")) {
        languages.unshift("typescript");
        note("typescript", "tsconfig.json");
      }
    }
    if (pkg.bin) {
      roles.push("cli");
      note("cli", "package.json#bin");
    }
    if (pkg.workspaces) {
      roles.push("monorepo");
      note("monorepo", "package.json#workspaces");
    }
    const dependencies = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    if (Object.keys(dependencies).some((name) => name.startsWith("@modelcontextprotocol/"))) {
      roles.push("mcp-server");
      note("mcp-server", "package.json#@modelcontextprotocol");
    }
  }

  const roleMarkers: readonly (readonly [string, string])[] = [
    ["copier-template", "copier.yml"],
    ["container-image", "Dockerfile"],
    ["compose-stack", "docker-compose.yml"],
    ["33god-project", ".project.json"],
    ["bmad-project", "_bmad"],
    ["hermes-fleet-host", "agents/hermes"],
  ];
  for (const [role, marker] of roleMarkers) {
    if (!existsSync(join(repo, marker))) continue;
    roles.push(role);
    note(role, marker);
  }

  return { primaryLanguage: languages[0], languages, roles, evidence };
}

function describeIdentity(repo: string, registryPath: string): DescribeIdentity {
  const manifestPath = join(repo, ".project.json");
  const manifest = readJson(manifestPath);
  const drift: DescribeDriftNote[] = [];

  let record: ProjectRecord | undefined;
  let registryReadable = true;
  try {
    const registry = loadProjectRegistry(registryPath);
    const slug = typeof manifest?.project_slug === "string" ? manifest.project_slug : undefined;
    const resolved = resolve(repo);
    record = (slug ? registry.projects[slug] : undefined)
      ?? Object.values(registry.projects).find((project) => resolve(project.repo_path) === resolved);
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
  if (record && resolve(record.repo_path) !== resolve(repo)) {
    drift.push({ note: `registry repo_path points elsewhere: ${record.repo_path}`, command: "pjangler project doctor" });
  }

  // `.project.json` is the single source of truth for the board binding, so the
  // manifest wins and any registry disagreement is reported as drift rather
  // than silently overriding what the repo declares about its own board.
  const manifestProvider = manifest?.ticket_provider as Record<string, unknown> | undefined;
  const provider = manifestProvider
    ? {
        type: String(manifestProvider.type ?? ""),
        workspace: manifestProvider.workspace as string | undefined,
        identifier: manifestProvider.identifier as string | undefined,
        board_id: manifestProvider.board_id as string | undefined,
        state: manifestProvider.state as string | undefined,
      }
    : record?.ticket_provider;

  if (manifestProvider && record) {
    const fields = [
      ["type", provider?.type, record.ticket_provider.type],
      ["workspace", provider?.workspace, record.ticket_provider.workspace],
      ["identifier", provider?.identifier, record.ticket_provider.identifier],
      ["board_id", provider?.board_id, record.ticket_provider.board_id],
    ] as const;
    for (const [field, fromManifest, fromRegistry] of fields) {
      if ((fromManifest ?? "") === (fromRegistry ?? "")) continue;
      // No command here on purpose: `project doctor` checks paths and manifest
      // presence, not field values, so it would report this as healthy.
      drift.push({
        note: `ticket_provider.${field} differs: .project.json has "${fromManifest ?? ""}", registry has "${fromRegistry ?? ""}" — the manifest is the source of truth, so the registry record needs re-syncing`,
      });
    }
  }

  const manifestAgents = (manifest?.agents ?? {}) as Record<string, Record<string, unknown>>;
  const agents: DescribeAgent[] = record
    ? Object.entries(record.agents).map(([name, agent]) => ({
        name,
        role: agent.role,
        provisioningState: agent.provisioning_state,
        roleDir: agent.role_dir,
      }))
    : Object.entries(manifestAgents).map(([name, agent]) => ({
        name,
        role: String(agent?.role ?? "unknown"),
        provisioningState: String(agent?.provisioning_state ?? "unknown"),
        roleDir: agent?.role_dir as string | undefined,
      }));

  return {
    manifest: Boolean(manifest),
    registered: Boolean(record),
    registryPath,
    slug: record?.slug ?? (manifest?.project_slug as string | undefined),
    name: record?.name ?? (manifest?.project_name as string | undefined),
    description: record?.description ?? (manifest?.project_description as string | undefined),
    ticketProvider: provider
      ? {
          type: provider.type,
          workspace: provider.workspace,
          identifier: provider.identifier,
          boardId: provider.board_id,
          state: provider.state,
        }
      : undefined,
    agents,
    drift,
  };
}

function describeSubsystems(repo: string, findings: readonly LifecycleAuditFinding[]): DescribeSubsystem[] {
  const byRecipe = new Map<string, LifecycleAuditFinding[]>();
  for (const finding of findings) {
    if (!finding.recipeId) continue;
    const bucket = byRecipe.get(finding.recipeId) ?? [];
    bucket.push(finding);
    byRecipe.set(finding.recipeId, bucket);
  }

  return recipeRegistry.list().map((metadata) => {
    const markers = SUBSYSTEM_MARKERS[metadata.id] ?? [];
    const evidence = markers.filter((marker) => existsSync(join(repo, marker)));
    const rules = (byRecipe.get(metadata.id) ?? []).map((finding) => ({
      id: finding.id,
      title: finding.title,
      status: finding.status,
      summary: finding.summary,
      fixable: finding.fixable,
    }));

    // "skip" means the rule did not apply here, so it votes neither way.
    const graded = rules.filter((rule) => rule.status !== "skip");
    const parity: ParityHealth = graded.length === 0
      ? "unchecked"
      : graded.every((rule) => rule.status === "pass")
        ? "ok"
        : "drift";

    const present = evidence.length > 0;
    const status: SubsystemStatus = !present ? "absent" : parity === "drift" ? "drifted" : "installed";

    return { id: metadata.id, name: metadata.name, description: metadata.description, status, parity, evidence, rules };
  });
}

function describeConfigFiles(repo: string): DescribeConfigFile[] {
  return CONFIG_FILES
    .filter((spec) => existsSync(join(repo, spec.path)))
    .map((spec) => ({ path: spec.path, purpose: spec.purpose, subsystem: spec.subsystem }));
}

function describeNextSteps(
  description: Omit<ProjectDescription, "nextSteps">,
  findings: readonly LifecycleAuditFinding[],
): DescribeNextStep[] {
  const steps: DescribeNextStep[] = [];

  if (!description.git.isRepo) {
    steps.push({
      title: "Initialize a git repository",
      reason: "pjangler lifecycle operations and parity rules assume a git work tree",
      source: "lifecycle",
      command: "git init",
    });
  }

  if (!description.identity.manifest) {
    steps.push({
      title: "Register this repo as a 33GOD project",
      reason: "no .project.json — the board binding and agent roster have nowhere to live",
      source: "lifecycle",
      command: "pjangler init --apply",
    });
  } else if (!description.identity.registered) {
    steps.push({
      title: "Add this project to the pjangler registry",
      reason: ".project.json exists but the central registry has no entry for this repo",
      source: "registry",
      command: `pjangler project init ${description.identity.name ?? ""} --target-dir . --apply`.replace(/\s+/g, " "),
    });
  }

  for (const entry of description.identity.drift) {
    if (entry.note.startsWith(".project.json exists but")) continue; // already emitted above
    steps.push({
      title: "Reconcile project registry drift",
      reason: entry.note,
      source: "registry",
      ...(entry.command ? { command: entry.command } : {}),
    });
  }

  // Fixable drift collapses into one step because `migrate --all` selects
  // exactly this set (every fixable fail/warn rule) in one pass. Listing them
  // one-per-line would bury the handful of findings that actually need hands.
  const failing = findings.filter((finding) => finding.status === "fail" || finding.status === "warn");
  const fixable = failing.filter((finding) => finding.fixable);
  if (fixable.length === 1) {
    const only = fixable[0]!;
    steps.push({
      title: `Fix ${only.id}`,
      reason: only.summary,
      source: "parity",
      command: `pjangler migrate ${only.id}`,
      rules: [only.id],
    });
  } else if (fixable.length > 1) {
    steps.push({
      title: `Apply ${fixable.length} parity migrations`,
      reason: `${fixable.length} fixable parity rules are failing; migrate --all selects exactly this set`,
      source: "parity",
      command: "pjangler migrate --all",
      rules: fixable.map((finding) => finding.id),
      details: fixable.map((finding) => `${finding.id}: ${finding.summary}`),
    });
  }

  for (const finding of failing) {
    if (finding.fixable) continue;
    steps.push({
      title: `Resolve ${finding.id} manually`,
      reason: `${finding.summary} — no migration recipe, this one needs hands`,
      source: "parity",
      rules: [finding.id],
    });
  }

  for (const agent of description.identity.agents) {
    if (agent.provisioningState === "provisioned") continue;
    steps.push({
      title: `Provision the ${agent.role} agent`,
      reason: `${agent.name} is ${agent.provisioningState}, not provisioned`,
      source: "agents",
      command: `pjangler hermes-agent --role ${agent.role}`,
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Read a repo and produce its full machine-readable description. */
export function describeProject(input: DescribeInput = {}): ProjectDescription {
  const repo = resolve(input.repoArg ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`Path does not exist: ${repo}`);
  if (!statSync(repo).isDirectory()) throw new Error(`Not a directory: ${repo}`);

  const registryPath = input.registryPath ?? projectRegistryPath();
  const report = recipeRegistry.auditRecipes(lifecycleContext(repo, true));
  const findings = report.rules;

  const counts: Record<LifecycleStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const finding of findings) counts[finding.status] += 1;

  const activity = computeRepoActivity(repo, { now: input.now });
  const partial = {
    repo,
    describedAt: report.auditedAt,
    git: describeGit(repo, activity),
    activity,
    type: describeType(repo),
    identity: describeIdentity(repo, registryPath),
    subsystems: describeSubsystems(repo, findings),
    configFiles: describeConfigFiles(repo),
    parity: { ok: report.ok, counts },
  };

  return { ...partial, nextSteps: describeNextSteps(partial, findings) };
}

// ---------------------------------------------------------------------------
// Presentation
//
// Laid out like a `gh` subcommand: a header that answers "what am I looking
// at" in three lines, then labelled sections with an aligned key column. No box
// drawing — alignment, weight and color carry the structure, which survives
// NO_COLOR and a narrow terminal in a way ASCII frames do not.
//
// `renderDescribe` takes width as a PARAMETER and never reads process.stdout,
// so the same renderer serves the terminal, the MCP transport, and tests
// without any of them disagreeing about how wide the world is.
// ---------------------------------------------------------------------------

const MIN_WIDTH = 60;
const MAX_WIDTH = 120;

/** Label column for the header key/value block. */
const LABEL = 11;

const SUBSYSTEM_STYLE: Record<SubsystemStatus, { glyph: string; color: (value: string | number) => string }> = {
  installed: { glyph: glyph.pass, color: green },
  drifted: { glyph: glyph.warn, color: yellow },
  absent: { glyph: glyph.skip, color: gray },
};

export interface RenderOptions {
  /** Visible columns to lay out within. Clamped to a readable range. */
  width?: number;
  /** Home directory to abbreviate as `~` in paths. */
  home?: string;
}

/** `~/code/x` instead of `/home/someone/code/x` — shorter and less noisy. */
function shortenPath(path: string, home?: string): string {
  const base = home ?? process.env.HOME;
  return base && path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

function section(title: string, count?: string): string {
  return `${bold(title)}${count ? `  ${dim(count)}` : ""}`;
}

function field(label: string, value: string): string {
  return `  ${dim(padEndRaw(label, LABEL))}${value}`;
}

/** Pad the RAW label before it is colored — see the note in utils/style. */
function padEndRaw(value: string, width: number): string {
  return value.padEnd(width);
}

/**
 * Render the report as lines.
 *
 * Returns an array rather than a string so the interactive layer can splice in
 * its own footer without re-parsing text it just produced.
 */
export function renderDescribe(description: ProjectDescription, options: RenderOptions = {}): string[] {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, options.width ?? 100));
  const { identity, type, git, activity } = description;
  const lines: string[] = [""];

  // --- Header ---------------------------------------------------------------
  const title = identity.name ?? description.repo.split("/").pop() ?? description.repo;
  const badge = identity.ticketProvider?.identifier ? `  ${cyan(identity.ticketProvider.identifier)}` : "";
  const pulse = activity.updatedUnix
    ? `${activity.active ? green("●") : yellow("○")} ${activity.active ? green(activity.relative) : yellow(activity.relative)}`
    : dim(`${glyph.skip} never`);
  const left = `  ${bold(title)}${badge}`;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(pulse) - 2);
  lines.push(`${left}${" ".repeat(gap)}${pulse}`);
  if (identity.description) lines.push(`  ${dim(truncateVisible(identity.description, width - 4))}`);
  lines.push(`  ${dim(truncateVisible(shortenPath(description.repo, options.home), width - 4))}`);
  lines.push("");

  // --- Facts ----------------------------------------------------------------
  const typeFacts = [type.primaryLanguage, ...type.roles].filter(Boolean) as string[];
  lines.push(field("type", typeFacts.length
    ? typeFacts.map((fact) => cyan(fact)).join(dim(" · "))
    : dim("undetermined — no language or role markers found")));

  if (activity.source) {
    lines.push(field("updated", `${activity.relative} ${dim(`${glyph.dot} ${activity.source.label}`)}`));
  }

  if (identity.ticketProvider) {
    const provider = identity.ticketProvider;
    const board = [provider.type, provider.workspace, provider.identifier].filter(Boolean).join("/");
    lines.push(field("board", `${cyan(board)}${provider.state ? `  ${dim(provider.state)}` : ""}`));
  }

  if (git.isRepo) {
    const facts = [cyan(git.branch ?? "?")];
    if (git.head) facts.push(dim(git.head));
    facts.push(git.dirtyFiles ? yellow(`${git.dirtyFiles} uncommitted`) : green("clean"));
    lines.push(field("git", facts.join(dim(" · "))));
    if (git.remote) lines.push(field("remote", dim(truncateVisible(git.remote, width - LABEL - 4))));
  } else {
    lines.push(field("git", yellow("not a git repository")));
  }

  const registryNote = identity.registered ? green("registered") : yellow("not registered");
  lines.push(field("registry", `${registryNote}  ${dim(shortenPath(identity.registryPath, options.home))}`));

  for (const agent of identity.agents) {
    const state = agent.provisioningState === "provisioned"
      ? green(agent.provisioningState)
      : yellow(agent.provisioningState);
    lines.push(field("agent", `${cyan(agent.name)} ${dim(agent.role)}  ${state}`));
  }

  for (const entry of identity.drift) {
    lines.push("");
    for (const [index, wrapped] of wrapVisible(entry.note, width - 6).entries()) {
      lines.push(index === 0 ? `  ${yellow(glyph.warn)} ${wrapped}` : `    ${dim(wrapped)}`);
    }
  }
  lines.push("");

  // --- Subsystems -----------------------------------------------------------
  const present = description.subsystems.filter((subsystem) => subsystem.status !== "absent");
  lines.push(section("Subsystems", `${present.length}/${description.subsystems.length} installed`));
  const nameWidth = description.subsystems.reduce((max, subsystem) => Math.max(max, subsystem.name.length), 0);
  for (const subsystem of description.subsystems) {
    const style = SUBSYSTEM_STYLE[subsystem.status];
    const failing = subsystem.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const detail = subsystem.status === "absent"
      ? dim(subsystem.description)
      : failing.length
        ? yellow(failing.map((rule) => rule.id).join(", "))
        : dim(subsystem.evidence.join(", ") || subsystem.description);
    const head = `  ${style.color(style.glyph)} ${style.color(padEndRaw(subsystem.name, nameWidth))}`;
    lines.push(`${head}  ${truncateVisible(detail, Math.max(10, width - nameWidth - 8))}`);
  }
  lines.push("");

  // --- Config ---------------------------------------------------------------
  lines.push(section("Config", `${description.configFiles.length} file${description.configFiles.length === 1 ? "" : "s"}`));
  if (!description.configFiles.length) lines.push(`  ${dim("(none found)")}`);
  const pathWidth = description.configFiles.reduce((max, file) => Math.max(max, file.path.length), 0);
  for (const file of description.configFiles) {
    const purpose = truncateVisible(file.purpose, Math.max(10, width - pathWidth - 6));
    lines.push(`  ${cyan(padEndRaw(file.path, pathWidth))}  ${dim(purpose)}`);
  }
  lines.push("");

  // --- Parity ---------------------------------------------------------------
  const { counts } = description.parity;
  lines.push(`${section("Parity")}  ${[
    counts.pass ? green(`${counts.pass} passed`) : dim("0 passed"),
    counts.fail ? red(`${counts.fail} failed`) : dim("0 failed"),
    counts.warn ? yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`) : dim("0 warnings"),
    dim(`${counts.skip} skipped`),
  ].join(dim(" · "))}`);
  lines.push("");

  // --- Next steps -----------------------------------------------------------
  lines.push(section("Next steps", String(description.nextSteps.length)));
  if (!description.nextSteps.length) {
    lines.push(`  ${green(glyph.pass)} ${dim("Nothing pending — parity is clean and the project is fully registered.")}`);
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

/** Render the report as the human-facing `pjangler describe` output. */
export function formatProjectDescription(description: ProjectDescription, options: RenderOptions = {}): string {
  return renderDescribe(description, { width: options.width ?? terminalWidth(), home: options.home }).join("\n");
}
