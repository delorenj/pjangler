import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { bold, cyan, dim, yellow, glyph, projectStatusColor } from "../utils/style";

export const PROJECT_REGISTRY_ENV = "PJ_PROJECT_REGISTRY";
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;

export interface SourceArtifact {
  kind: "skill" | "template" | "package" | string;
  path: string;
  package_name?: string;
}

export interface ProjectTicketProvider {
  type: "plane" | "linear" | "trello" | string;
  workspace?: string;
  identifier?: string;
  board_id?: string;
  board_url?: string;
  state?: "planned" | "linked" | "skipped" | string;
}

export interface ProjectAgentRecord {
  role: string;
  provisioning_state: "planned" | "provisioned" | "skipped" | string;
  role_dir?: string;
}

export interface ProjectRecord {
  name: string;
  slug: string;
  repo_path: string;
  description: string;
  status: "planned" | "active" | "archived" | string;
  source_artifacts: SourceArtifact[];
  template: {
    commonproject: {
      enabled: boolean;
      primary_language: string;
    };
  };
  ticket_provider: ProjectTicketProvider;
  agents: Record<string, ProjectAgentRecord>;
  created_at: string;
  updated_at: string;
}

export interface ProjectRegistry {
  schema_version: number;
  projects: Record<string, ProjectRecord>;
}

export interface ProjectManifest {
  project_name: string;
  project_description: string;
  project_slug: string;
  repo_path: string;
  ticket_provider: {
    type: string;
    workspace: string;
    identifier: string;
    board_id: string;
    board_url: string;
    state?: string;
  };
  agents: Record<string, { role: string; role_dir?: string; provisioning_state?: string }>;
}

export interface ProjectInitInput {
  name: string;
  description?: string;
  targetDir?: string;
  sourceSkill?: string;
  primaryLanguage?: string;
  provisionAgent?: boolean;
  agentRole?: string;
  apply?: boolean;
  live?: boolean;
  registryPath?: string;
  projectSlug?: string;
  projectIdentifier?: string;
  packageName?: string;
  ticketProvider?: "plane" | "linear" | "trello" | string;
  planeWorkspace?: string;
  planeProjectId?: string;
  pjanglerRoot?: string;
  cwd?: string;
  scaffold?: boolean;
  force?: boolean;
  overwrite?: boolean;
  now?: Date;
}

export type ProjectInitAction =
  | {
      kind: "registry.upsert";
      registryPath: string;
      slug: string;
      project: ProjectRecord;
    }
  | {
      kind: "copier.copy.commonproject";
      cwd: string;
      command: string[];
      targetDir: string;
      data: Record<string, string>;
      overwrite: boolean;
    }
  | {
      kind: "project.write-manifest";
      path: string;
      manifest: ProjectManifest;
    }
  | {
      kind: "plane.create-or-link";
      enabled: boolean;
      live: boolean;
      workspace: string;
      identifier: string;
      state: string;
      reason?: string;
    }
  | {
      kind: "hermes.provision-agent";
      enabled: boolean;
      local: boolean;
      targetDir: string;
      targetRepo: string;
      role: string;
      context: {
        skipRuntimeRepo: boolean;
        skipPlane: boolean;
        skipBloodbank: boolean;
        skipSystemd: boolean;
      };
    };

export interface ProjectInitPlan {
  ok: true;
  apply: boolean;
  dryRun: boolean;
  live: boolean;
  registryPath: string;
  project: ProjectRecord;
  manifest: ProjectManifest;
  actions: ProjectInitAction[];
}

export interface ProjectInitExecutionResult {
  ok: boolean;
  plan: ProjectInitPlan;
  logs: string[];
  errors: string[];
  changedFiles: string[];
}

export interface ProjectDoctorResult {
  ok: boolean;
  registryPath: string;
  checkedProjects: string[];
  issues: Array<{ level: "error" | "warn"; slug?: string; message: string }>;
}

const KNOWN_SKILL_ROOTS = [
  "/home/delorenj/code/skillex/all-skills",
  "/home/delorenj/code/CoachingAgentFramework/.agents/skills",
  "/home/delorenj/code/pjangler/.agents/skills",
  join(homedir(), ".codex", "skills"),
];

export function projectRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env[PROJECT_REGISTRY_ENV] || join(homedir(), ".config", "pjangler", "projects.yaml"));
}

export function emptyProjectRegistry(): ProjectRegistry {
  return { schema_version: PROJECT_REGISTRY_SCHEMA_VERSION, projects: {} };
}

export function loadProjectRegistry(path = projectRegistryPath()): ProjectRegistry {
  if (!existsSync(path)) return emptyProjectRegistry();
  const raw = YAML.parse(readFileSync(path, "utf8")) as unknown;
  if (raw == null) return emptyProjectRegistry();
  if (!isRecord(raw)) throw new Error(`Project registry must be a mapping: ${path}`);
  const registry = raw as Partial<ProjectRegistry>;
  const normalized: ProjectRegistry = {
    schema_version: Number(registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION),
    projects: isRecord(registry.projects) ? (registry.projects as Record<string, ProjectRecord>) : {},
  };
  validateProjectRegistry(normalized);
  return normalized;
}

export function saveProjectRegistry(registry: ProjectRegistry, path = projectRegistryPath()): void {
  validateProjectRegistry(registry);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, YAML.stringify(registry, { lineWidth: 0 }), "utf8");
  renameSync(temp, path);
}

export function validateProjectRegistry(registry: ProjectRegistry): void {
  if (registry.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project registry schema_version: ${registry.schema_version}`);
  }
  if (!isRecord(registry.projects)) throw new Error("Project registry projects must be a mapping");
  const slugs = new Set<string>();
  const repoPaths = new Map<string, string>();
  const identifiers = new Map<string, string>();
  for (const [slug, project] of Object.entries(registry.projects)) {
    validateProjectRecord(project, slug);
    if (slugs.has(project.slug)) throw new Error(`Duplicate project slug: ${project.slug}`);
    slugs.add(project.slug);
    const repoKey = resolve(project.repo_path);
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

export function slugifyProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function deriveProjectIdentifier(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const identifier = compact.slice(0, 4) || "PROJ";
  return identifier.length >= 2 ? identifier : `${identifier}XX`.slice(0, 4);
}

export function normalizeAgentRole(value?: string): string {
  return value?.trim() || "pm";
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value);
}

function projectRecordEquivalent(a: ProjectRecord | undefined, b: ProjectRecord): boolean {
  if (!a) return false;
  const { created_at: _aCreated, updated_at: _aUpdated, ...aComparable } = a;
  const { created_at: _bCreated, updated_at: _bUpdated, ...bComparable } = b;
  return jsonStable(aComparable) === jsonStable(bComparable);
}

export function defaultProjectTargetDir(name: string, cwd = process.cwd()): string {
  const compactName = name.replace(/[^A-Za-z0-9._-]/g, "") || slugifyProjectName(name);
  return resolve(dirname(resolve(cwd)), compactName);
}

export function resolveSourceSkillPath(sourceSkill?: string): string | undefined {
  if (!sourceSkill) return undefined;
  const expanded = expandHome(sourceSkill);
  const direct = resolve(expanded);
  if (existsSync(direct)) return direct;

  const name = basename(sourceSkill);
  for (const root of KNOWN_SKILL_ROOTS) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }

  const civilWarLetterifier = "/home/delorenj/code/skillex/all-skills/civilwar-letterifier";
  const hint = existsSync(civilWarLetterifier) ? ` Did you mean ${civilWarLetterifier}?` : "";
  throw new Error(`Source skill not found: ${sourceSkill}.${hint}`);
}

export function planProjectInit(input: ProjectInitInput): ProjectInitPlan {
  if (!input.name.trim()) throw new Error("Project name is required");
  const registryPath = resolve(projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }));
  const registry = loadProjectRegistry(registryPath);
  const now = (input.now ?? new Date()).toISOString();
  const slug = input.projectSlug ?? slugifyProjectName(input.name);
  const targetDir = resolve(input.targetDir ?? defaultProjectTargetDir(input.name, input.cwd));
  const identifier = (input.projectIdentifier ?? deriveProjectIdentifier(input.name)).toUpperCase();
  const existing = registry.projects[slug];
  const sourceSkillPath = resolveSourceSkillPath(input.sourceSkill);
  const overwrite = input.overwrite ?? input.force ?? false;
  const agentRole = normalizeAgentRole(input.agentRole);
  const agents: Record<string, ProjectAgentRecord> = input.provisionAgent
    ? {
        ...(existing?.agents ?? {}),
        [agentRole]: {
          role: agentRole,
          provisioning_state: "planned",
        },
      }
    : existing?.agents ?? {};
  const scaffold = input.scaffold ?? true;

  const candidateProject: ProjectRecord = {
    name: input.name,
    slug,
    repo_path: targetDir,
    description: input.description ?? "",
    status: "planned",
    source_artifacts: sourceSkillPath
      ? [{ kind: "skill", path: sourceSkillPath, package_name: input.packageName ?? slug }]
      : [],
    template: {
      commonproject: {
        enabled: true,
        primary_language: input.primaryLanguage ?? "python",
      },
    },
    ticket_provider: {
      type: input.ticketProvider ?? "plane",
      workspace: input.planeWorkspace ?? "33god",
      identifier,
      board_id: input.planeProjectId ?? "",
      board_url: input.planeProjectId ? `https://plane.delo.sh/${input.planeWorkspace ?? "33god"}/projects/${input.planeProjectId}/issues/` : "",
      state: input.live ? "planned" : "planned",
    },
    agents,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const project: ProjectRecord = {
    ...candidateProject,
    updated_at: projectRecordEquivalent(existing, candidateProject) ? existing!.updated_at : now,
  };

  validateNoDuplicateProject(registry, project, overwrite);

  const pjanglerRoot = resolve(input.pjanglerRoot ?? resolvePjanglerRoot());
  const manifest = projectManifestFromRegistryProject(project);
  const apply = input.apply ?? false;
  const live = input.live ?? false;
  const actions: ProjectInitAction[] = [
    { kind: "registry.upsert", registryPath, slug, project },
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
      projectIdentifier: identifier,
      primaryLanguage: project.template.commonproject.primary_language,
      overwrite,
    }));
  }
  actions.push(
    { kind: "project.write-manifest", path: join(targetDir, ".project.json"), manifest },
    {
      kind: "plane.create-or-link",
      enabled: live,
      live,
      workspace: project.ticket_provider.workspace ?? "33god",
      identifier,
      state: live ? "planned" : "planned",
      reason: live ? undefined : "network/cloud actions require --live",
    },
    {
      kind: "hermes.provision-agent",
      enabled: input.provisionAgent ?? false,
      local: !live,
      targetDir,
      targetRepo: slug,
      role: agentRole,
      context: {
        skipRuntimeRepo: !live,
        skipPlane: !live,
        skipBloodbank: !live,
        skipSystemd: !live || process.platform === "darwin",
      },
    }
  );

  return { ok: true, apply, dryRun: !apply, live, registryPath, project, manifest, actions };
}

export function executeProjectInitPlan(plan: ProjectInitPlan): ProjectInitExecutionResult {
  const logs: string[] = [];
  const errors: string[] = [];
  const changedFiles: string[] = [];
  if (!plan.apply) return { ok: true, plan, logs, errors, changedFiles };

  const registry = loadProjectRegistry(plan.registryPath);
  let pendingRegistryAction: Extract<ProjectInitAction, { kind: "registry.upsert" }> | undefined;
  for (const action of plan.actions) {
    if (action.kind === "copier.copy.commonproject") {
      mkdirSync(dirname(action.targetDir), { recursive: true });
      const result = spawnSync(action.command[0]!, action.command.slice(1), { encoding: "utf8", cwd: action.cwd });
      if (result.stdout?.trim()) logs.push(result.stdout.trim());
      if (result.stderr?.trim()) logs.push(result.stderr.trim());
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        errors.push(
          code === "ENOENT"
            ? "copier not found on PATH. Install with: uv tool install copier or pip install copier"
            : `copier failed: ${result.error.message}`
        );
        break;
      }
      if (result.status !== 0) {
        errors.push(`copier exited with status ${result.status ?? "unknown"}`);
        if (existsSync(action.targetDir)) changedFiles.push(action.targetDir);
        break;
      }
      changedFiles.push(action.targetDir);
    } else if (action.kind === "project.write-manifest") {
      mkdirSync(dirname(action.path), { recursive: true });
      const next = `${JSON.stringify(action.manifest, null, 2)}\n`;
      const current = existsSync(action.path) ? readFileSync(action.path, "utf8") : undefined;
      if (current !== next) {
        writeFileSync(action.path, next, "utf8");
        changedFiles.push(action.path);
      }
    } else if (action.kind === "registry.upsert") {
      pendingRegistryAction = action;
    } else if (action.kind === "plane.create-or-link") {
      logs.push(action.enabled ? "plane.create-or-link requires a live provider integration" : "plane.create-or-link skipped (requires --live)");
    } else if (action.kind === "hermes.provision-agent") {
      logs.push(action.enabled ? "hermes.provision-agent planned for the caller to execute" : "hermes.provision-agent skipped");
    }
  }

  if (pendingRegistryAction && errors.length === 0) {
    if (!projectRecordEquivalent(registry.projects[pendingRegistryAction.slug], pendingRegistryAction.project)) {
      registry.projects[pendingRegistryAction.slug] = pendingRegistryAction.project;
      saveProjectRegistry(registry, pendingRegistryAction.registryPath);
      changedFiles.push(pendingRegistryAction.registryPath);
    }
  }

  return { ok: errors.length === 0, plan, logs, errors, changedFiles };
}

export function projectManifestFromRegistryProject(project: ProjectRecord): ProjectManifest {
  const agents = Object.fromEntries(
    Object.entries(project.agents).map(([name, agent]) => [
      `${project.slug}-${name}`,
      {
        role: agent.role,
        role_dir: agent.role_dir,
        provisioning_state: agent.provisioning_state,
      },
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
      board_url: project.ticket_provider.board_url ?? "",
      state: project.ticket_provider.state,
    },
    agents,
  };
}

export function formatProjectInitPlan(plan: ProjectInitPlan): string {
  const lines = [""];
  const title = `${bold(plan.project.name)} ${dim(`(${plan.project.slug})`)}`;
  lines.push(`  ${cyan(bold(glyph.chevron))} ${title}${plan.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim("registry".padEnd(8))} ${dim(plan.registryPath)}`);
  lines.push(`  ${dim("target".padEnd(8))} ${dim(plan.project.repo_path)}`);
  lines.push("");
  lines.push(`  ${bold("Actions")} ${dim(`(${plan.actions.length})`)}`);
  if (!plan.actions.length) lines.push(`     ${dim("(nothing to do)")}`);
  for (const action of plan.actions) {
    lines.push(`     ${cyan(glyph.bullet)} ${action.kind}`);
    if (action.kind === "copier.copy.commonproject") lines.push(`        ${dim(`target: ${action.targetDir}`)}`);
    if (action.kind === "project.write-manifest") lines.push(`        ${dim(`path: ${action.path}`)}`);
    if (action.kind === "plane.create-or-link" && action.reason) lines.push(`        ${dim(`note: ${action.reason}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatProjectList(registry: ProjectRegistry): string {
  const projects = Object.values(registry.projects).sort((a, b) => a.slug.localeCompare(b.slug));
  if (!projects.length) return `\n  ${dim("No projects registered.")}\n`;
  const slugWidth = projects.reduce((width, project) => Math.max(width, project.slug.length), 0);
  const idWidth = projects.reduce((width, project) => Math.max(width, String(project.ticket_provider.identifier ?? "").length), 0);
  const statusWidth = projects.reduce((width, project) => Math.max(width, project.status.length), 0);

  const lines = ["", `  ${bold("Projects")} ${dim(`(${projects.length})`)}`, ""];
  for (const project of projects) {
    const slug = bold(project.slug.padEnd(slugWidth));
    const identifier = cyan(String(project.ticket_provider.identifier ?? "").padEnd(idWidth));
    const status = projectStatusColor(project.status)(project.status.padEnd(statusWidth));
    lines.push(`  ${slug}  ${identifier}  ${status}  ${dim(project.repo_path)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function getProject(registry: ProjectRegistry, slug: string): ProjectRecord {
  const project = registry.projects[slug];
  if (!project) throw new Error(`Project not found in registry: ${slug}`);
  return project;
}

export function doctorProjectRegistry(registryPath = projectRegistryPath(), slug?: string): ProjectDoctorResult {
  const issues: ProjectDoctorResult["issues"] = [];
  const registry = loadProjectRegistry(registryPath);
  const projects = slug ? [[slug, getProject(registry, slug)] as const] : Object.entries(registry.projects);
  for (const [projectSlug, project] of projects) {
    if (!existsSync(project.repo_path)) {
      issues.push({ level: "warn", slug: projectSlug, message: `repo_path does not exist: ${project.repo_path}` });
    } else if (!statSync(project.repo_path).isDirectory()) {
      issues.push({ level: "error", slug: projectSlug, message: `repo_path is not a directory: ${project.repo_path}` });
    } else {
      const manifestPath = join(project.repo_path, ".project.json");
      if (!existsSync(manifestPath)) issues.push({ level: "warn", slug: projectSlug, message: ".project.json is missing" });
    }
    for (const artifact of project.source_artifacts) {
      if (artifact.path && !existsSync(artifact.path)) {
        issues.push({ level: "warn", slug: projectSlug, message: `source artifact missing: ${artifact.path}` });
      }
    }
  }
  return {
    ok: !issues.some((issue) => issue.level === "error"),
    registryPath,
    checkedProjects: projects.map(([projectSlug]) => projectSlug),
    issues,
  };
}

export function buildCommonProjectCopierAction(input: {
  pjanglerRoot: string;
  targetDir: string;
  projectName: string;
  projectDescription?: string;
  projectSlug: string;
  ticketProvider: string;
  planeWorkspace: string;
  planeProjectId?: string;
  projectIdentifier: string;
  primaryLanguage: string;
  overwrite: boolean;
}): Extract<ProjectInitAction, { kind: "copier.copy.commonproject" }> {
  const templateDir = join(input.pjanglerRoot, "templates", "commonproject");
  const data: Record<string, string> = {
    project_name: input.projectName,
    project_description: input.projectDescription ?? "",
    project_slug: input.projectSlug,
    ticket_provider: input.ticketProvider,
    plane_workspace: input.planeWorkspace,
    plane_project_id: input.planeProjectId ?? "",
    project_identifier: input.projectIdentifier,
    primary_language: input.primaryLanguage,
  };
  const command = ["copier", "copy", "--trust", templateDir, input.targetDir, "--defaults"];
  for (const [key, value] of Object.entries(data)) command.push("--data", `${key}=${value}`);
  if (input.overwrite) command.push("--overwrite");
  return {
    kind: "copier.copy.commonproject",
    cwd: input.pjanglerRoot,
    command,
    targetDir: input.targetDir,
    data,
    overwrite: input.overwrite,
  };
}

export function resolvePjanglerRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd());
}

function validateNoDuplicateProject(registry: ProjectRegistry, project: ProjectRecord, overwrite: boolean): void {
  const existingSameSlug = registry.projects[project.slug];
  if (existingSameSlug && !overwrite && resolve(existingSameSlug.repo_path) !== resolve(project.repo_path)) {
    throw new Error(`Project slug already exists in registry: ${project.slug}`);
  }
  for (const [slug, existing] of Object.entries(registry.projects)) {
    if (slug === project.slug) continue;
    if (resolve(existing.repo_path) === resolve(project.repo_path)) {
      throw new Error(`Project repo_path already registered by ${slug}: ${project.repo_path}`);
    }
    if (existing.ticket_provider.identifier && existing.ticket_provider.identifier.toUpperCase() === project.ticket_provider.identifier?.toUpperCase()) {
      throw new Error(`Project identifier already registered by ${slug}: ${project.ticket_provider.identifier}`);
    }
  }
}

function validateProjectRecord(project: ProjectRecord, key: string): void {
  if (!isRecord(project)) throw new Error(`Project ${key} must be a mapping`);
  if (!project.name) throw new Error(`Project ${key} missing name`);
  if (!project.slug) throw new Error(`Project ${key} missing slug`);
  if (project.slug !== key) throw new Error(`Project key ${key} does not match slug ${project.slug}`);
  if (!project.repo_path) throw new Error(`Project ${key} missing repo_path`);
  if (!Array.isArray(project.source_artifacts)) throw new Error(`Project ${key} source_artifacts must be a list`);
  if (!isRecord(project.ticket_provider)) throw new Error(`Project ${key} ticket_provider must be a mapping`);
  if (!isRecord(project.agents)) throw new Error(`Project ${key} agents must be a mapping`);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
