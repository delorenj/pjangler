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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { recipeRegistry, lifecycleContext } from "../parity/index";
import type { LifecycleAuditFinding, LifecycleStatus } from "../recipes/types";
import {
  loadProjectRegistry,
  projectRegistryPath,
  type ProjectRecord,
} from "../project/index";
import { bold, cyan, dim, gray, glyph, green, heading, red, yellow } from "../utils/style";

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
  status?: string;
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

/** Run a git subcommand in `repo`, returning trimmed stdout or undefined. */
function git(repo: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

function describeGit(repo: string): DescribeGit {
  if (git(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { isRepo: false };
  const porcelain = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000 });
  const dirtyFiles = porcelain.status === 0
    ? porcelain.stdout.split("\n").filter((line) => line.trim() !== "").length
    : undefined;
  return {
    isRepo: true,
    branch: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(repo, ["rev-parse", "--short", "HEAD"]),
    remote: git(repo, ["remote", "get-url", "origin"]),
    dirtyFiles,
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
    status: record?.status,
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

  const partial = {
    repo,
    describedAt: report.auditedAt,
    git: describeGit(repo),
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
// ---------------------------------------------------------------------------

const SUBSYSTEM_STYLE: Record<SubsystemStatus, { glyph: string; color: (value: string | number) => string }> = {
  installed: { glyph: glyph.pass, color: green },
  drifted: { glyph: glyph.warn, color: yellow },
  absent: { glyph: glyph.skip, color: gray },
};

/** Render a description as the human-facing `pjangler describe` report. */
export function formatProjectDescription(description: ProjectDescription): string {
  const lines = [""];
  const { identity, type, git } = description;

  const title = identity.name ?? description.repo.split("/").pop() ?? description.repo;
  lines.push(`  ${heading(title)}${identity.slug ? ` ${dim(`(${identity.slug})`)}` : ""}`);
  lines.push(`  ${dim(description.repo)}`);
  if (identity.description) lines.push(`  ${identity.description}`);
  lines.push("");

  // --- Type -----------------------------------------------------------------
  const typeFacts: string[] = [];
  if (type.primaryLanguage) typeFacts.push(cyan(type.primaryLanguage));
  for (const role of type.roles) typeFacts.push(cyan(role));
  lines.push(`  ${bold("Type")}`);
  lines.push(`     ${typeFacts.length ? typeFacts.join(dim(" · ")) : dim("undetermined — no language or role markers found")}`);
  if (type.languages.length > 1) lines.push(`     ${dim(`languages: ${type.languages.join(", ")}`)}`);
  lines.push("");

  // --- Identity -------------------------------------------------------------
  lines.push(`  ${bold("Identity")}`);
  lines.push(`     ${dim("manifest".padEnd(10))} ${identity.manifest ? green(".project.json") : dim("(none)")}`);
  lines.push(`     ${dim("registry".padEnd(10))} ${identity.registered ? green("registered") : yellow("not registered")}  ${dim(identity.registryPath)}`);
  if (identity.status) lines.push(`     ${dim("status".padEnd(10))} ${cyan(identity.status)}`);
  if (identity.ticketProvider) {
    const provider = identity.ticketProvider;
    const board = [provider.type, provider.workspace, provider.identifier].filter(Boolean).join("/");
    lines.push(`     ${dim("board".padEnd(10))} ${cyan(board)}${provider.state ? `  ${dim(provider.state)}` : ""}`);
  }
  for (const agent of identity.agents) {
    const state = agent.provisioningState === "provisioned" ? green(agent.provisioningState) : yellow(agent.provisioningState);
    lines.push(`     ${dim("agent".padEnd(10))} ${cyan(agent.name)} ${dim(agent.role)}  ${state}`);
  }
  if (git.isRepo) {
    const clean = git.dirtyFiles === 0 ? green("clean") : yellow(`${git.dirtyFiles} uncommitted`);
    lines.push(`     ${dim("git".padEnd(10))} ${cyan(git.branch ?? "?")}${git.head ? dim(` @ ${git.head}`) : ""}  ${clean}`);
    if (git.remote) lines.push(`     ${dim("remote".padEnd(10))} ${dim(git.remote)}`);
  } else {
    lines.push(`     ${dim("git".padEnd(10))} ${yellow("not a git repository")}`);
  }
  for (const entry of identity.drift) lines.push(`     ${yellow(glyph.warn)} ${entry.note}`);
  lines.push("");

  // --- Subsystems -----------------------------------------------------------
  const installed = description.subsystems.filter((subsystem) => subsystem.status !== "absent");
  lines.push(`  ${bold("Subsystems")} ${dim(`(${installed.length}/${description.subsystems.length} installed)`)}`);
  const nameWidth = description.subsystems.reduce((width, subsystem) => Math.max(width, subsystem.name.length), 0);
  for (const subsystem of description.subsystems) {
    const style = SUBSYSTEM_STYLE[subsystem.status];
    const failing = subsystem.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const detail = subsystem.status === "absent"
      ? dim(subsystem.description)
      : failing.length
        ? yellow(`${failing.length} rule(s) need attention: ${failing.map((rule) => rule.id).join(", ")}`)
        : dim(subsystem.evidence.join(", ") || subsystem.description);
    lines.push(`     ${style.color(style.glyph)} ${style.color(subsystem.name.padEnd(nameWidth))}  ${detail}`);
  }
  lines.push("");

  // --- Config files ---------------------------------------------------------
  lines.push(`  ${bold("Config files")} ${dim(`(${description.configFiles.length})`)}`);
  if (!description.configFiles.length) lines.push(`     ${dim("(none found)")}`);
  const pathWidth = description.configFiles.reduce((width, file) => Math.max(width, file.path.length), 0);
  for (const file of description.configFiles) {
    lines.push(`     ${cyan(file.path.padEnd(pathWidth))}  ${dim(file.purpose)}`);
  }
  lines.push("");

  // --- Parity ---------------------------------------------------------------
  const { counts } = description.parity;
  const parityLine = [
    green(`${counts.pass} pass`),
    counts.fail ? red(`${counts.fail} fail`) : dim("0 fail"),
    counts.warn ? yellow(`${counts.warn} warn`) : dim("0 warn"),
    dim(`${counts.skip} skip`),
  ].join(dim(" · "));
  lines.push(`  ${bold("Parity")}  ${parityLine}`);
  lines.push("");

  // --- Next steps -----------------------------------------------------------
  lines.push(`  ${bold("Next steps")} ${dim(`(${description.nextSteps.length})`)}`);
  if (!description.nextSteps.length) {
    lines.push(`     ${green(glyph.pass)} ${dim("Nothing pending — parity is clean and the project is fully registered.")}`);
  }
  for (const step of description.nextSteps) {
    lines.push(`     ${cyan(glyph.bullet)} ${step.title}`);
    if (step.details?.length) {
      for (const detail of step.details) lines.push(`        ${dim(glyph.dot)} ${dim(detail)}`);
    } else {
      lines.push(`        ${dim(step.reason)}`);
    }
    if (step.command) lines.push(`        ${dim(glyph.pointer)} ${cyan(step.command)}`);
  }
  lines.push("");

  return lines.join("\n");
}
