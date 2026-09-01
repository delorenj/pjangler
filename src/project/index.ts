import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DEFAULT_NOTEBOOK_LIMITS, notebookCredentialMaterialPath, type NotebookGlobalConfigV1, type NotebookLimitsV1, type ProjectNotebookBindingV1, type ProjectNotebookConfigV1 } from "../notebook/types";
import { bold, cyan, dim, green, yellow, glyph } from "../utils/style";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";
import {
  verifyTrustedCopierIdentity,
  type TrustedCopierIdentity,
} from "../lifecycle/preflight";
import {
  isPgRegistryEnabled,
  PgRegistryStore,
  pgRegistryConfigFromEnv,
  type RegistryStore,
  type DualWriteRegistryStore,
} from "./RegistryStore";
import { dotenvValue, workspaceEnvKey } from "./boardQuery";

export { isPgRegistryEnabled, pgRegistryConfigFromEnv, PgRegistryStore, type RegistryStore, type DualWriteRegistryStore };

export const PROJECT_REGISTRY_ENV = "PJ_PROJECT_REGISTRY";
export const PROJECT_SOURCE_SKILL_ROOTS_ENV = "PJ_SOURCE_SKILL_ROOTS";
/** Override the directory holding the `tp` provider adapters (`<provider>.sh`). */
export const TICKET_PROVIDER_ADAPTERS_ENV = "PJ_TICKET_PROVIDER_ADAPTERS";
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
/**
 * Lifecycle status stamped on a NEWLY created project record (PJAN-26).
 * The project lifecycle is planned -> active -> archived; bootstrapping a
 * project means work has started, so new records begin "active".
 * Applies to new records only — existing records keep their recorded status.
 */
export const DEFAULT_NEW_PROJECT_STATUS = "active";
export const BOARD_URL_DEPRECATION_WARNING = "boardUrl is deprecated and ignored; board URLs are derived at runtime and are never persisted.";

export interface SourceArtifact {
  kind: "skill" | "template" | "package" | string;
  path: string;
  package_name?: string;
}

export type SupportedTicketProvider = "plane" | "trello";

/**
 * Where a board identifier came from.
 *
 * "provider" — read back from the ticket provider's own API. The only source
 *   a linked board may be backed by.
 * "proposed" — pjangler minted a placeholder from the project name. Nothing has
 *   confirmed it exists, so it may not be treated as a board key.
 */
export const PROJECT_IDENTIFIER_SOURCES = ["provider", "proposed"] as const;
export type ProjectIdentifierSource = (typeof PROJECT_IDENTIFIER_SOURCES)[number];

/**
 * Providers that ASSIGN the board identifier themselves.
 *
 * Plane mints a key for every board and hands it back, so a Plane record whose
 * key is a local guess is a routing lie. Trello has no such concept at all: the
 * short prefix on a Trello record is something we chose and Trello merely
 * echoes, which is why a Trello identifier can never be `provider`-sourced —
 * and why "is this board real?" has to be a separate question from "did the
 * provider name it?".
 */
export const IDENTIFIER_ASSIGNING_PROVIDERS = ["plane", "linear"] as const;

export function providerAssignsIdentifiers(type: string | undefined): boolean {
  return (IDENTIFIER_ASSIGNING_PROVIDERS as readonly string[]).includes((type ?? "").trim());
}

/** Lifecycle states a board binding may occupy. */
export const TICKET_PROVIDER_STATES = ["planned", "linked", "skipped"] as const;

/** The command that reads identifiers back from the provider and repairs drift. */
export const IDENTIFIER_REPAIR_COMMAND = "pj project identity --all --apply";

export interface ProjectTicketProvider {
  type: SupportedTicketProvider | string;
  workspace?: string;
  identifier?: string;
  /** Provenance of `identifier`. Absent on legacy records; treated as "proposed". */
  identifier_source?: ProjectIdentifierSource | string;
  /**
   * ISO-8601 instant this identity was ESTABLISHED by a provider read.
   *
   * Not a poll timestamp: re-confirming the same value leaves it alone, so a
   * reconciliation run that changes nothing writes nothing.
   */
  identifier_fetched_at?: string;
  board_id?: string;
  /**
   * ISO-8601 instant the provider confirmed `board_id` names a real board.
   *
   * This is BOARD-binding provenance, and it is a different question from
   * `identifier_source`. Plane answers both at once — listing a board yields
   * its key — but Trello can only ever answer the first, so conflating them is
   * what let a Trello record claim Trello had assigned a key it never saw.
   */
  board_confirmed_at?: string;
  /** Legacy input only. New manifests derive board URLs from provider/workspace/board_id. */
  board_url?: string;
  state?: "planned" | "linked" | "skipped" | string;
}

export interface ProjectAgentRecord {
  role: string;
  provisioning_state: "planned" | "provisioned" | "skipped" | string;
  role_dir?: string;
}

export interface ProjectAutomation {
  reconcile?: {
    enabled: boolean;
    grace_hours: number;
    auto_review: boolean;
  };
}

export interface ProjectRecord {
  [key: string]: unknown;
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
  automation?: ProjectAutomation;
  /** Authoritative Registry binding; policy overrides live in .project.json. */
  notebook?: ProjectNotebookBindingV1;
  created_at: string;
  updated_at: string;
}

export interface ProjectRegistry {
  [key: string]: unknown;
  schema_version: number;
  notebook?: NotebookGlobalConfigV1;
  projects: Record<string, ProjectRecord>;
}

export interface ProjectManifest {
  [key: string]: unknown;
  project_name: string;
  project_description: string;
  project_slug: string;
  repo_path: string;
  ticket_provider: {
    type: string;
    workspace: string;
    identifier: string;
    identifier_source?: string;
    identifier_fetched_at?: string;
    board_id: string;
    /** Stamped by the provider adapter the moment the provider handed the board back. */
    board_confirmed_at?: string;
    state?: string;
  };
  agents: Record<string, { role: string; role_dir?: string; provisioning_state?: string }>;
  automation?: ProjectAutomation;
  /** Read-only binding projection plus repository policy overrides. */
  notebook?: ProjectNotebookConfigV1;
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
  /** Deprecated no-op retained for API compatibility; runtime is always role-local and ignored. */
  provisionRuntimeRepo?: boolean;
  /** Explicit external-effect grants. MCP callers pass these as false unless positively opted in. */
  provisionTicketBoard?: boolean;
  enableSystemd?: boolean;
  /** Subtractive ticket-provider gate; always dominates live/positive consent. */
  skipPlane?: boolean;
  registryPath?: string;
  projectSlug?: string;
  projectIdentifier?: string;
  packageName?: string;
  ticketProvider?: SupportedTicketProvider | string;
  planeWorkspace?: string;
  planeProjectId?: string;
  /** Provider-agnostic board binding (preferred over the plane* aliases). */
  boardId?: string;
  /** Deprecated. Board URLs are derived from provider/workspace/board_id and are not persisted. */
  boardUrl?: string;
  boardWorkspace?: string;
  pjanglerRoot?: string;
  cwd?: string;
  scaffold?: boolean;
  agentHooksLayer?: boolean;
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
      kind: "ticket-provider.create-or-link";
      enabled: boolean;
      live: boolean;
      provider: string;
      workspace: string;
      identifier: string;
      /** Repo the board is bound to; also where a repo-local `.env` credential is looked up. */
      repoPath: string;
      /** Board display name handed to the adapter's `create_board`. */
      boardName: string;
      /** Board description handed to the adapter's `create_board`. */
      description: string;
      /** Empty until the board is created or an explicit `--board-id` was supplied. */
      boardId: string;
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
  warnings?: string[];
}

export interface ProjectInitExecutionResult {
  ok: boolean;
  plan: ProjectInitPlan;
  logs: string[];
  errors: string[];
  changedFiles: string[];
}

export interface ProjectInitExecutionOptions {
  /** Required by MCP create paths; interactive CLI callers may omit it. */
  trustedCopier?: TrustedCopierIdentity;
  requireTrustedCopier?: boolean;
}

export interface ProjectDoctorResult {
  ok: boolean;
  registryPath: string;
  checkedProjects: string[];
  issues: Array<{ level: "error" | "warn"; slug?: string; message: string }>;
}

function synchronizeCopierIdentity(manifestPath: string, manifest: ProjectManifest): string[] {
  const answersPath = join(dirname(manifestPath), ".copier-answers.yml");
  if (!existsSync(answersPath)) return [];
  const current = readFileSync(answersPath, "utf8");
  const document = YAML.parseDocument(current);
  if (document.errors.length) return [];
  const name = String(document.get("project_name") ?? "");
  const description = String(document.get("project_description") ?? "");
  if (name === manifest.project_name && description === manifest.project_description) return [];
  document.set("project_name", manifest.project_name);
  document.set("project_description", manifest.project_description);
  const next = String(document);
  if (next === current) return [];
  writeFileSync(answersPath, next, "utf8");
  return [answersPath];
}

const DEFAULT_SOURCE_SKILL_ROOTS = [
  "/home/delorenj/code/skillex/all-skills",
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".codex", "skills"),
];

export function projectRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env[PROJECT_REGISTRY_ENV] || join(homedir(), ".config", "pjangler", "projects.yaml"));
}

/**
 * Create a string-keyed dictionary with no inherited keys or magic
 * `__proto__` setter. Registry slugs and agent identifiers are caller- or
 * file-controlled, so plain `{}` objects are not safe lookup/storage maps.
 */
export function createSafeRecord<T>(
  entries: Iterable<readonly [string, T]> = [],
): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

/** Read a dictionary entry only when the key is an own data property. */
export function getOwnRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function emptyProjectRegistry(): ProjectRegistry {
  return { schema_version: PROJECT_REGISTRY_SCHEMA_VERSION, projects: createSafeRecord() };
}

export function loadProjectRegistry(path = projectRegistryPath()): ProjectRegistry {
  if (!existsSync(path)) return emptyProjectRegistry();
  const raw = YAML.parse(readFileSync(path, "utf8")) as unknown;
  if (raw == null) return emptyProjectRegistry();
  if (!isRecord(raw)) throw new Error(`Project registry must be a mapping: ${path}`);
  const registry = raw as Partial<ProjectRegistry>;
  const projects = createSafeRecord<ProjectRecord>();
  if (isRecord(registry.projects)) {
    for (const [slug, rawProject] of Object.entries(registry.projects)) {
      if (!isRecord(rawProject)) {
        projects[slug] = rawProject as ProjectRecord;
        continue;
      }
      projects[slug] = {
        ...rawProject,
        agents: isRecord(rawProject.agents)
          ? createSafeRecord(Object.entries(rawProject.agents) as Array<[string, ProjectAgentRecord]>)
          : rawProject.agents,
      } as ProjectRecord;
    }
  }
  const normalized: ProjectRegistry = {
    ...registry,
    schema_version: Number(registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION),
    projects,
  };
  validateProjectRegistry(normalized);
  return normalized;
}

const PROJECT_REGISTRY_OWNED_KEYS = [
  "name", "slug", "repo_path", "description", "status", "source_artifacts", "template",
  "ticket_provider", "agents", "automation", "notebook", "created_at", "updated_at",
] as const;
const PROJECT_NOTEBOOK_OWNED_KEYS = ["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"] as const;
const TICKET_PROVIDER_OWNED_KEYS = ["type", "workspace", "identifier", "identifier_source", "identifier_fetched_at", "board_id", "board_confirmed_at", "board_url", "state"] as const;
const GLOBAL_NOTEBOOK_OWNED_KEYS = ["base_url", "auth", "defaults", "limits", "summarizer"] as const;
const GLOBAL_NOTEBOOK_AUTH_OWNED_KEYS = ["mode", "env_var"] as const;
const GLOBAL_NOTEBOOK_DEFAULTS_OWNED_KEYS = ["enabled", "session_start_enabled", "session_capture_enabled", "overview_max_chars", "documentation_globs", "overview_references", "excluded_globs"] as const;
const GLOBAL_NOTEBOOK_LIMITS_OWNED_KEYS = Object.keys(DEFAULT_NOTEBOOK_LIMITS);
const GLOBAL_NOTEBOOK_SUMMARIZER_OWNED_KEYS = ["executable", "args"] as const;

type RegistryYamlDocument = ReturnType<typeof YAML.parseDocument>;
type YamlPath = Array<string | number>;

function yamlPlain(document: RegistryYamlDocument, path: YamlPath): unknown {
  let value = document.toJS() as unknown;
  for (const key of path) {
    if (typeof key === "number" && Array.isArray(value)) value = value[key];
    else if (typeof key === "string" && isRecord(value)) value = value[key];
    else return undefined;
  }
  return value;
}

function sameYamlValue(document: RegistryYamlDocument, path: YamlPath, desired: unknown): boolean {
  try { return JSON.stringify(yamlPlain(document, path)) === JSON.stringify(desired); }
  catch { return false; }
}

function setYamlLeaf(document: RegistryYamlDocument, path: YamlPath, desired: unknown): void {
  if (sameYamlValue(document, path, desired)) return;
  const current = document.getIn(path, true) as unknown;
  if (YAML.isScalar(current) && (desired === null || typeof desired !== "object")) {
    current.value = desired as never;
    return;
  }
  document.setIn(path, desired);
}

/** Merge desired values into existing CST nodes so comments/style on unchanged
 * values and unknown extension keys survive. Only explicitly owned keys may be
 * deleted when absent from the authoritative in-memory value. */
function mergeYamlMapping(
  document: RegistryYamlDocument,
  path: YamlPath,
  desired: Record<string, unknown>,
  ownedKeys: readonly string[] = [],
): void {
  if (sameYamlValue(document, path, desired)) return;
  const current = document.getIn(path, true) as unknown;
  if (!YAML.isMap(current)) {
    document.setIn(path, desired);
    return;
  }
  for (const key of ownedKeys) if (!Object.hasOwn(desired, key)) document.deleteIn([...path, key]);
  for (const [key, value] of Object.entries(desired)) {
    const child = [...path, key];
    if (isRecord(value)) {
      const childOwned = key === "notebook" ? PROJECT_NOTEBOOK_OWNED_KEYS
        : key === "ticket_provider" ? TICKET_PROVIDER_OWNED_KEYS
        : path.length === 1 && path[0] === "notebook" && key === "auth" ? GLOBAL_NOTEBOOK_AUTH_OWNED_KEYS
        : path.length === 1 && path[0] === "notebook" && key === "defaults" ? GLOBAL_NOTEBOOK_DEFAULTS_OWNED_KEYS
        : path.length === 1 && path[0] === "notebook" && key === "limits" ? GLOBAL_NOTEBOOK_LIMITS_OWNED_KEYS
        : path.length === 1 && path[0] === "notebook" && key === "summarizer" ? GLOBAL_NOTEBOOK_SUMMARIZER_OWNED_KEYS
        : [];
      mergeYamlMapping(document, child, value, childOwned);
    } else setYamlLeaf(document, child, value);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort on platforms that cannot fsync directories */ }
}

export function saveProjectRegistry(registry: ProjectRegistry, path = projectRegistryPath()): void {
  validateProjectRegistry(registry);
  mkdirSync(dirname(path), { recursive: true });
  let text: string;
  let mode = 0o644;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Project registry must be a regular file: ${path}`);
    mode = stat.mode & 0o777;
    const current = readFileSync(path, "utf8");
    const document = YAML.parseDocument(current);
    if (document.errors.length) throw new Error(`Project registry YAML is invalid: ${path}`);
    setYamlLeaf(document, ["schema_version"], registry.schema_version);
    if (registry.notebook !== undefined) mergeYamlMapping(document, ["notebook"], registry.notebook, GLOBAL_NOTEBOOK_OWNED_KEYS);
    else document.delete("notebook");
    if (!document.has("projects")) document.set("projects", {});
    const parsed = document.toJS() as unknown;
    const existingProjects = isRecord(parsed) && isRecord(parsed.projects) ? parsed.projects : {};
    for (const slug of Object.keys(existingProjects)) if (!Object.hasOwn(registry.projects, slug)) document.deleteIn(["projects", slug]);
    for (const [slug, project] of Object.entries(registry.projects)) {
      mergeYamlMapping(document, ["projects", slug], project, PROJECT_REGISTRY_OWNED_KEYS);
    }
    text = String(document);
    if (text === current) return;
  } else {
    text = YAML.stringify(registry, { lineWidth: 0 });
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, text, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    chmodSync(path, mode);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* retain original error */ }
    try { unlinkSync(temp); } catch { /* retain original error */ }
    throw error;
  }
}

export function validateProjectRegistry(registry: ProjectRegistry): void {
  if (registry.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project registry schema_version: ${registry.schema_version}`);
  }
  validateGlobalNotebookConfig(registry.notebook);
  if (!isRecord(registry.projects)) throw new Error("Project registry projects must be a mapping");
  const slugs = new Set<string>();
  const repoPaths = new Map<string, string>();
  const identifiers = new Map<string, string>();
  const boardIds = new Map<string, string>();
  const notebookIds = new Map<string, string>();
  const overviewNoteIds = new Map<string, string>();
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
    const scope = ticketProviderScope(project.ticket_provider);
    // R4: two projects cannot own the same board. An EMPTY board_id is not a
    // board, it is the absence of one, and 22 records legitimately share it.
    const boardId = project.ticket_provider.board_id?.trim();
    if (boardId) {
      const boardKey = `${scope}\u0000${boardId}`;
      const existingBoardSlug = boardIds.get(boardKey);
      if (existingBoardSlug && existingBoardSlug !== slug) {
        throw new Error(`Duplicate project board_id: ${boardId} in ${scope.replace("\u0000", "/")} used by ${existingBoardSlug} and ${slug}`);
      }
      boardIds.set(boardKey, slug);
    }
    const identifier = project.ticket_provider.identifier?.toUpperCase();
    if (identifier) {
      const identifierKey = `${scope}\u0000${identifier}`;
      const existingIdentifierSlug = identifiers.get(identifierKey);
      if (existingIdentifierSlug && existingIdentifierSlug !== slug) {
        throw new Error(`Duplicate project identifier: ${identifier} in ${scope.replace("\u0000", "/")} used by ${existingIdentifierSlug} and ${slug}`);
      }
      identifiers.set(identifierKey, slug);
    }
    const notebookId = project.notebook?.notebook_id;
    if (notebookId) {
      const existingNotebookSlug = notebookIds.get(notebookId);
      if (existingNotebookSlug && existingNotebookSlug !== slug) throw new Error(`Duplicate project notebook_id: ${notebookId} used by ${existingNotebookSlug} and ${slug}`);
      notebookIds.set(notebookId, slug);
    }
    const overviewNoteId = project.notebook?.overview_note_id;
    if (overviewNoteId) {
      const existingOverviewSlug = overviewNoteIds.get(overviewNoteId);
      if (existingOverviewSlug && existingOverviewSlug !== slug) throw new Error(`Duplicate project overview_note_id: ${overviewNoteId} used by ${existingOverviewSlug} and ${slug}`);
      overviewNoteIds.set(overviewNoteId, slug);
    }
  }
}

/**
 * The uniqueness scope for a board binding: provider type plus workspace.
 * Identifiers are unique WITHIN a workspace and nowhere else — Plane will
 * happily assign `AAI` in automaticai and something else named `AAI` in a
 * different workspace, and both are legitimate.
 */
function ticketProviderScope(provider: ProjectTicketProvider): string {
  return `${provider.type ?? ""}\u0000${(provider.workspace ?? "").toLowerCase()}`;
}

function validateGlobalNotebookConfig(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Project registry notebook must be a mapping");
  const credentialPath = notebookCredentialMaterialPath(value);
  if (credentialPath) throw new Error(`Project registry Notebook configuration contains forbidden credential material at ${credentialPath}`);
  if (value.base_url !== undefined) {
    if (typeof value.base_url !== "string" || !value.base_url.trim()) throw new Error("Project registry notebook.base_url must be a nonempty URL");
    let url: URL;
    try { url = new URL(value.base_url); } catch { throw new Error("Project registry notebook.base_url must be an absolute URL"); }
    if (url.username || url.password || url.search || url.hash) throw new Error("Project registry notebook.base_url may not contain credentials, query, or fragment");
    const hostname = url.hostname.toLowerCase();
    const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const loopback = hostname === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (isIP(host) !== 0 && !loopback) throw new Error("Project registry notebook.base_url may not use a numeric non-loopback host");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Project registry notebook.base_url must use HTTPS or loopback HTTP");
  }
  if (value.auth !== undefined) {
    if (!isRecord(value.auth) || (value.auth.mode !== "none" && value.auth.mode !== "environment")) throw new Error("Project registry notebook.auth is invalid");
    if (value.auth.mode === "environment" && value.auth.env_var !== "OPEN_NOTEBOOK_PASSWORD") throw new Error("Project registry notebook.auth.env_var must be OPEN_NOTEBOOK_PASSWORD");
    if (value.auth.mode === "none" && value.auth.env_var !== undefined) throw new Error("Project registry notebook.auth none mode may not name a credential variable");
  }
  const boundedList = (candidate: unknown, name: string): void => {
    if (!Array.isArray(candidate) || candidate.length > 100 || candidate.some((entry) => typeof entry !== "string" || !entry || Buffer.byteLength(entry, "utf8") > 512)) throw new Error(`Project registry notebook.defaults.${name} must be a bounded string list`);
  };
  if (value.defaults !== undefined) {
    if (!isRecord(value.defaults)) throw new Error("Project registry notebook.defaults must be a mapping");
    for (const key of ["enabled", "session_start_enabled", "session_capture_enabled"] as const) {
      if (value.defaults[key] !== undefined && typeof value.defaults[key] !== "boolean") throw new Error(`Project registry notebook.defaults.${key} must be boolean`);
    }
    if (value.defaults.overview_max_chars !== undefined && (!Number.isSafeInteger(value.defaults.overview_max_chars) || Number(value.defaults.overview_max_chars) <= 0)) throw new Error("Project registry notebook.defaults.overview_max_chars must be a positive integer");
    for (const key of ["documentation_globs", "overview_references", "excluded_globs"] as const) if (value.defaults[key] !== undefined) boundedList(value.defaults[key], key);
  }
  const limits = { ...DEFAULT_NOTEBOOK_LIMITS } as NotebookLimitsV1;
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw new Error("Project registry notebook.limits must be a mapping");
    for (const key of Object.keys(DEFAULT_NOTEBOOK_LIMITS) as Array<keyof NotebookLimitsV1>) {
      const configured = value.limits[key];
      if (configured === undefined) continue;
      if (!Number.isSafeInteger(configured) || Number(configured) <= 0) throw new Error(`Project registry notebook.limits.${key} must be a positive integer`);
      limits[key] = Number(configured) as never;
    }
  }
  if (limits.schema_version !== 1) throw new Error("Project registry notebook.limits.schema_version must be 1");
  if (limits.receipt_max_bytes > limits.unresolved_receipt_max_bytes) throw new Error("Project registry notebook receipt_max_bytes may not exceed unresolved_receipt_max_bytes");
  if (limits.hook_payload_max_bytes > DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes) throw new Error("Project registry notebook hook_payload_max_bytes exceeds the packaged ceiling");
  if (limits.note_detail_fetch_concurrency > DEFAULT_NOTEBOOK_LIMITS.note_detail_fetch_concurrency) throw new Error("Project registry notebook note_detail_fetch_concurrency exceeds the packaged ceiling");
  if (limits.lease_seconds * 1_000 <= limits.overall_timeout_ms) throw new Error("Project registry notebook lease_seconds must exceed one request timeout");
  if (isRecord(value.defaults) && value.defaults.overview_max_chars !== undefined && Number(value.defaults.overview_max_chars) > limits.note_max_bytes) throw new Error("Project registry notebook overview_max_chars exceeds note_max_bytes");
  if (value.summarizer !== undefined) {
    if (!isRecord(value.summarizer) || typeof value.summarizer.executable !== "string" || !isAbsolute(value.summarizer.executable)
      || value.summarizer.executable.includes("\0") || Buffer.byteLength(value.summarizer.executable, "utf8") > 1_024) throw new Error("Project registry notebook.summarizer executable must be a bounded absolute path");
    if (value.summarizer.args !== undefined && (!Array.isArray(value.summarizer.args) || value.summarizer.args.length > 32
      || value.summarizer.args.some((entry) => typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 1_024))) throw new Error("Project registry notebook.summarizer args must be bounded strings");
  }
}

/**
 * Build the `.project.json` ticket_provider block for a supported provider.
 * Board URLs are derived from provider + workspace + board_id at runtime; the
 * manifest stores only stable identity. Lane→state mapping is NOT stored here —
 * that is per-repo config because kanban columns vary board to board.
 */
export function normalizeTicketProvider(value?: string): SupportedTicketProvider {
  const type = (value || "plane").trim().toLowerCase();
  if (type === "plane" || type === "trello") return type;
  throw new Error(`Unsupported ticket provider: ${value}. Supported providers: plane, trello`);
}

export function buildTicketProviderBlock(input: {
  type?: string;
  identifier: string;
  /**
   * Omitted means pjangler proposed the identifier and nothing confirmed it.
   * Only a provider-confirmed identifier may back a "linked" board.
   */
  identifierSource?: ProjectIdentifierSource;
  identifierFetchedAt?: string;
  boardId?: string;
  /**
   * Instant the provider confirmed `boardId` is a real board. Omitted means
   * nothing confirmed it, and an unconfirmed binding can never be "linked".
   */
  boardConfirmedAt?: string;
  workspace?: string;
}): ProjectTicketProvider {
  const type = normalizeTicketProvider(input.type);
  const boardId = input.boardId ?? "";
  const identifierSource: ProjectIdentifierSource = input.identifierSource ?? "proposed";
  const fetchedAt = identifierSource === "provider" ? input.identifierFetchedAt : undefined;
  // Reading a key back out of the provider FOR THIS BOARD confirms the binding
  // as a side effect, so a caller that supplies one need not supply both.
  const confirmedAt = input.boardConfirmedAt ?? (boardId ? fetchedAt : undefined);
  const provenClaim = !providerAssignsIdentifiers(type) || identifierSource === "provider";
  return {
    type,
    workspace: input.workspace ?? (type === "trello" ? "" : "33god"),
    identifier: input.identifier,
    identifier_source: identifierSource,
    ...(fetchedAt ? { identifier_fetched_at: fetchedAt } : {}),
    board_id: boardId,
    ...(confirmedAt ? { board_confirmed_at: confirmedAt } : {}),
    state: boardId && confirmedAt && provenClaim ? "linked" : "planned",
  };
}

/**
 * Credentials a provider adapter needs, as groups of ALTERNATIVES: every group
 * must be satisfied by at least one of its names.
 *
 * This must not be narrower than what the adapter itself accepts. It was:
 * pjangler asked only for `PLANE_API_KEY` while `providers/plane.sh` falls back
 * to `PLANE_<WORKSPACE>_API_KEY` (env or `~/.hermes/fleet.env`, `op://` refs
 * included). On a host whose only Plane credential is `PLANE_33GOD_API_KEY` —
 * which is every host here — pjangler declared "no credentials", skipped the
 * board, and left the record `planned` while the adapter would have succeeded.
 */
function ticketProviderKeyGroups(provider: string, workspace?: string): string[][] {
  if (provider === "trello") return [["TRELLO_KEY"], ["TRELLO_TOKEN"]];
  return [[...new Set(["PLANE_API_KEY", workspaceEnvKey(workspace)])]];
}

/**
 * Env var a provider adapter reads its credential from. Mirrors the KEYVAR
 * switch in agents/hermes/pm/.scripts/42-ticket-provider.sh.
 */
export function ticketProviderKeyVar(provider: string, workspace?: string): string {
  return ticketProviderKeyGroups(provider, workspace)[0]!.join(" or ");
}

/** Every credential name a provider adapter may read, in precedence order. */
function ticketProviderKeyVars(provider: string, workspace?: string): string[] {
  return ticketProviderKeyGroups(provider, workspace).flat();
}

/** Repo convention: exported secrets live in `<config>/zshyzsh/secrets.zsh`. */
export function ticketProviderSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "zshyzsh", "secrets.zsh");
}

/** The fleet dotenv the Hermes adapters read, honouring HERMES_FLEET_ENV. */
export function ticketProviderFleetEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_FLEET_ENV?.trim() || join(env.HOME || homedir(), ".hermes", "fleet.env");
}

/**
 * Pull `KEY=value` / `export KEY=value` assignments for the requested keys only.
 *
 * The allowlist is the credential guarantee, not a filter applied afterwards:
 * `~/.hermes/fleet.env` carries live Plane API keys beside its fleet paths, and
 * an unlisted key never enters memory at all, so there is no moment at which a
 * secret exists to be leaked and no redaction pass that can be forgotten.
 * Exported for `src/fleet/provenance.ts` for exactly that reason -- a second
 * copy of this reader would be a second copy of the risk.
 *
 * It does NOT expand `$VAR`. `HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/...`
 * comes back unexpanded, and a caller must report it that way rather than
 * inventing the expansion this reader deliberately does not perform.
 */
export function readShellAssignments(path: string, keys: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (!existsSync(path)) return found;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return found;
  }
  const wanted = new Set(keys);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (!wanted.has(key) || found[key] !== undefined) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0]!.trim();
    }
    if (value) found[key] = value;
  }
  return found;
}

/**
 * Resolve ticket-provider credentials the way the rest of the repo does:
 * process env -> repo `.env` -> `~/.hermes/fleet.env` -> the exported zshyzsh
 * secrets file. Never prompts, and callers must never log `values` — `source`
 * is the loggable part.
 *
 * Values are returned exactly as found, `op://` references included: the
 * adapters resolve those themselves at the last moment, so a reference never
 * has to be dereferenced here.
 */
export function resolveTicketProviderCredentials(input: {
  keys: string[];
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
}): { values: Record<string, string>; sources: Record<string, string> } {
  const env = input.env ?? process.env;
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const missing = () => input.keys.filter((key) => !values[key]);

  for (const key of input.keys) {
    const fromEnv = env[key];
    if (fromEnv) {
      values[key] = fromEnv;
      sources[key] = "environment";
    }
  }

  const candidates: string[] = [];
  if (input.repoPath) candidates.push(join(input.repoPath, ".env"));
  candidates.push(ticketProviderFleetEnvPath(env));
  candidates.push(ticketProviderSecretsPath(env));

  for (const candidate of candidates) {
    const outstanding = missing();
    if (!outstanding.length) break;
    const assignments = readShellAssignments(candidate, outstanding);
    for (const [key, value] of Object.entries(assignments)) {
      values[key] = value;
      sources[key] = candidate;
    }
  }

  return { values, sources };
}

/**
 * Locate a `tp` provider adapter (`<provider>.sh`). Resolution mirrors
 * resolveTemplateRoot() in src/commands/AgentHooksCommands.ts: an env override
 * first, then a walk up from this module so it works from source, from the
 * bundled `dist/`, and from the published npm package (which ships
 * `templates/`), then the canonical ~/code/pjangler checkout.
 *
 * The distributable `templates/hermes-agent` submodule wins over the repo-local
 * `agents/hermes/pm` tree so pjangler runs the same adapter it ships to users.
 */
export function resolveTicketProviderAdapter(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = `${provider}.sh`;
  const candidates: string[] = [];
  const override = env[TICKET_PROVIDER_ADAPTERS_ENV];
  if (override) candidates.push(join(override, file));
  const relativeRoots = [
    join("templates", "hermes-agent", "template", ".scripts", "providers"),
    join("agents", "hermes", "pm", ".scripts", "providers"),
  ];
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      for (const relativeRoot of relativeRoots) candidates.push(join(dir, relativeRoot, file));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url unavailable — rely on the other candidates */
  }
  for (const relativeRoot of relativeRoots) {
    candidates.push(join(homedir(), "code", "pjangler", relativeRoot, file));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export interface TicketProviderBoardResult {
  ok: boolean;
  /** True when the action was intentionally not performed (e.g. no credentials). */
  skipped: boolean;
  boardId?: string;
  /** The identifier the PROVIDER assigned, read off its own response. */
  identifier?: string;
  boardUrl?: string;
  logs: string[];
  error?: string;
}

/**
 * Create (or link, the adapters are idempotent) the repo's ticket board by
 * invoking the same `create_board` op that
 * agents/hermes/pm/.scripts/42-ticket-provider.sh uses.
 *
 * Missing credentials are a graceful skip, never a failure — an operator
 * without creds must still get a working init, exactly as 42-ticket-provider.sh
 * behaves.
 */
export function provisionTicketProviderBoard(
  action: Extract<ProjectInitAction, { kind: "ticket-provider.create-or-link" }>,
  env: NodeJS.ProcessEnv = process.env
): TicketProviderBoardResult {
  const provider = action.provider;
  const groups = ticketProviderKeyGroups(provider, action.workspace);
  const { values } = resolveTicketProviderCredentials({
    keys: ticketProviderKeyVars(provider, action.workspace),
    repoPath: action.repoPath,
    env,
  });

  const unsatisfied = groups.filter((group) => !group.some((key) => values[key]));
  if (unsatisfied.length) {
    const names = unsatisfied.map((group) => group.join(" or ")).join(" and ");
    return {
      ok: true,
      skipped: true,
      logs: [
        `ticket-provider: ${names} not set; skipping ${provider} board creation (state stays "planned"). ` +
          `Set it in the environment, ${join(action.repoPath, ".env")}, ${ticketProviderFleetEnvPath(env)}, ` +
          `or ${ticketProviderSecretsPath(env)} — or pass --board-id to link an existing board.`,
      ],
    };
  }

  const adapter = resolveTicketProviderAdapter(provider, env);
  if (!adapter) {
    return {
      ok: false,
      skipped: false,
      logs: [],
      error:
        `ticket-provider: no ${provider} adapter found. ` +
        `Set ${TICKET_PROVIDER_ADAPTERS_ENV} to a directory containing ${provider}.sh.`,
    };
  }

  const redact = (text: string): string =>
    Object.values(values).reduce((acc, secret) => (secret ? acc.split(secret).join("***") : acc), text);

  // The adapters resolve their board binding from the nearest .project.json
  // above their own role dir (`$0/../..`), NOT from the cwd or the environment.
  // Running the vendored adapter in place would therefore make it inherit
  // pjangler's own workspace/board. Stage it inside a throwaway repo shaped
  // like a Hermes role tree whose .project.json carries exactly this plan's
  // binding, so the adapter resolves the workspace we intend.
  const staging = mkdtempSync(join(tmpdir(), "pjangler-tp-"));
  try {
    const providersDir = join(staging, "agents", "hermes", "pm", ".scripts", "providers");
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(staging, ".project.json"),
      `${JSON.stringify(
        {
          project_name: action.boardName,
          repo_path: action.repoPath,
          ticket_provider: {
            type: provider,
            workspace: action.workspace,
            identifier: action.identifier,
            board_id: "",
            state: "planned",
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const staged = join(providersDir, `${provider}.sh`);
    copyFileSync(adapter, staged);

    const childEnv: NodeJS.ProcessEnv = { ...env, ...values, TICKET_PROVIDER: provider };
    if (provider === "plane" && action.workspace) childEnv.PLANE_WORKSPACE = action.workspace;

    const result = spawnSync("sh", [staged, "create_board", action.boardName, action.identifier, action.description], {
      cwd: existsSync(action.repoPath) ? action.repoPath : staging,
      encoding: "utf8",
      env: childEnv,
    });

    if (result.error) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: could not run the ${provider} adapter: ${redact(result.error.message)}`,
      };
    }
    const stderr = redact((result.stderr ?? "").trim());
    if (result.status !== 0) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error:
          `ticket-provider: ${provider} create_board failed (exit ${result.status ?? "unknown"})` +
          `${stderr ? `: ${stderr}` : ""}`,
      };
    }

    const stdout = (result.stdout ?? "").trim();
    const lastLine = stdout.split(/\r?\n/).filter((line) => line.trim()).pop() ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned unparseable output: ${redact(lastLine) || "(empty)"}`,
      };
    }
    const boardId = isRecord(parsed) && typeof parsed.board_id === "string" ? parsed.board_id.trim() : "";
    if (!boardId) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned no board_id`,
      };
    }
    const identifier = isRecord(parsed) && typeof parsed.identifier === "string" ? parsed.identifier.trim() : "";
    if (!identifier) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error:
          `ticket-provider: ${provider} create_board returned no identifier. ` +
          `The adapter must echo the identifier the provider assigned; pjangler no longer invents one.`,
      };
    }
    const boardUrl = isRecord(parsed) && typeof parsed.board_url === "string" ? parsed.board_url : undefined;
    return {
      ok: true,
      skipped: false,
      boardId,
      identifier,
      boardUrl,
      logs: [`ticket-provider: ${provider} board linked (${identifier} → ${boardId})`],
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function defaultProjectAutomation(): ProjectAutomation {
  return {
    reconcile: {
      enabled: false,
      grace_hours: 0,
      auto_review: true,
    },
  };
}

export function slugifyProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Validate caller-controlled names that become one filesystem path segment.
 * Keep this capability open-ended (roles are not an enum), while excluding
 * every spelling that can change the directory reached by a later join().
 */
export function validateSafePathSegment(value: string, label: string): string {
  const normalized = value.trim();
  const unsafe =
    !normalized ||
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    !SAFE_PATH_SEGMENT.test(normalized);
  if (unsafe) {
    throw new Error(
      `${label} must be a non-empty safe single path segment using letters, numbers, dots, underscores, or hyphens (no dot segments, absolute paths, separators, or traversal)`,
    );
  }
  return normalized;
}

function prospectiveRealPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

/** Resolve a prospective child and reject lexical or symlink-assisted escape. */
export function resolveContainedPath(parentDir: string, candidate: string, label: string): string {
  const physicalParent = prospectiveRealPath(parentDir);
  const physicalCandidate = prospectiveRealPath(candidate);
  const fromParent = relative(physicalParent, physicalCandidate);
  if (!fromParent || fromParent === ".." || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error(`${label} must remain contained beneath parent directory ${resolve(parentDir)}`);
  }
  return resolve(candidate);
}

/**
 * PROPOSE an identifier from a project name.
 *
 * This is a placeholder, never a board key. The provider assigns the real
 * identifier and `pj project identity` reads it back; anything this function
 * returns lands with `identifier_source: "proposed"` and can never satisfy the
 * linked-board invariant on its own. The registry drifted for months because
 * four code paths treated a string slice as authoritative.
 */
export function proposeProjectIdentifier(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const identifier = compact.slice(0, 4) || "PROJ";
  return identifier.length >= 2 ? identifier : `${identifier}XX`.slice(0, 4);
}

export function normalizeAgentRole(value?: string): string {
  return value === undefined ? "pm" : validateSafePathSegment(value, "Agent role");
}

/**
 * Decide whether the CommonProject scaffold should include the project-scoped
 * agent-hooks + skill fan-out layer. Explicit input wins; then the
 * PJ_AGENT_HOOKS_LAYER env override (0/false | 1/true); otherwise the layer is
 * SKIPPED when the machine already runs a global agent-hooks install
 * (~/.agents/hooks), so a fresh project never re-injects the same hooks into the
 * caller's shared per-user CLI configs (~/.codex, ~/.kimi-code, ...).
 */
export function resolveAgentHooksLayer(input?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof input === "boolean") return input;
  const override = env.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return !existsSync(join(homedir(), ".agents", "hooks"));
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
  const compactName = name.replace(/[^A-Za-z0-9._-]/g, "");
  const safeName = SAFE_PATH_SEGMENT.test(compactName) ? compactName : slugifyProjectName(name);
  return resolve(dirname(resolve(cwd)), validateSafePathSegment(safeName, "Generated project directory"));
}

export function sourceSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredRoots = (env[PROJECT_SOURCE_SKILL_ROOTS_ENV] || "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of [...DEFAULT_SOURCE_SKILL_ROOTS, ...configuredRoots]) {
    const normalized = resolve(expandHome(root));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

export function resolveSourceSkillPath(sourceSkill?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!sourceSkill) return undefined;
  const expanded = expandHome(sourceSkill);
  const direct = resolve(expanded);
  if (existsSync(direct)) return direct;

  const name = basename(sourceSkill);
  const roots = sourceSkillRoots(env);
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }

  const searched = roots.length ? ` Searched roots: ${roots.join(", ")}.` : "";
  const hint = `${searched} Add project-specific roots with ${PROJECT_SOURCE_SKILL_ROOTS_ENV}.`;
  throw new Error(`Source skill not found: ${sourceSkill}.${hint}`);
}

export function planProjectInit(input: ProjectInitInput): ProjectInitPlan {
  if (!input.name.trim()) throw new Error("Project name is required");
  const slug = input.projectSlug === undefined
    ? validateSafePathSegment(slugifyProjectName(input.name), "Project slug")
    : validateSafePathSegment(input.projectSlug, "Project slug");
  const agentRole = normalizeAgentRole(input.agentRole);
  const registryPath = resolve(projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }));
  const registry = loadProjectRegistry(registryPath);
  const now = (input.now ?? new Date()).toISOString();
  const targetDir = resolve(input.targetDir ?? defaultProjectTargetDir(input.name, input.cwd));
  const identifier = (input.projectIdentifier ?? proposeProjectIdentifier(input.name)).toUpperCase();
  const existing = getOwnRecordValue(registry.projects, slug);
  // A board provisioned by an earlier run lives in the registry, not in the CLI
  // flags — inherit it so re-running init re-links instead of minting a second
  // board.
  const resolvedBoardId = input.boardId ?? input.planeProjectId ?? (existing?.ticket_provider?.board_id || undefined);
  const inheritedProvenance =
    existing?.ticket_provider?.identifier_source === "provider"
      && existing.ticket_provider.identifier?.toUpperCase() === identifier
      && (existing.ticket_provider.board_id || undefined) === resolvedBoardId
      ? {
          identifierSource: "provider" as const,
          ...(existing.ticket_provider.identifier_fetched_at
            ? { identifierFetchedAt: existing.ticket_provider.identifier_fetched_at }
            : {}),
        }
      : undefined;
  // Board-binding provenance is inherited on its own terms. A Trello board the
  // provider already confirmed stays confirmed even though its key is — and
  // always will be — a proposal.
  const inheritedBoardConfirmation =
    resolvedBoardId
      && (existing?.ticket_provider?.board_id || undefined) === resolvedBoardId
      && existing?.ticket_provider?.board_confirmed_at
      ? { boardConfirmedAt: existing.ticket_provider.board_confirmed_at }
      : undefined;
  const sourceSkillPath = resolveSourceSkillPath(input.sourceSkill);
  const overwrite = input.overwrite ?? input.force ?? false;
  const agents = createSafeRecord<ProjectAgentRecord>(Object.entries(existing?.agents ?? {}));
  if (input.provisionAgent) {
    agents[agentRole] = {
      role: agentRole,
      provisioning_state: "planned",
    };
  }
  const scaffold = input.scaffold ?? true;

  const candidateProject: ProjectRecord = {
    ...(existing ?? {}),
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
    source_artifacts: sourceSkillPath
      ? [{ kind: "skill", path: sourceSkillPath, package_name: input.packageName ?? slug }]
      : [],
    template: {
      commonproject: {
        enabled: true,
        primary_language: input.primaryLanguage ?? "python",
      },
    },
    ticket_provider: buildTicketProviderBlock({
      type: input.ticketProvider ?? "plane",
      identifier,
      boardId: resolvedBoardId,
      workspace: input.boardWorkspace ?? input.planeWorkspace,
      // Provenance survives a re-plan. Without this, re-running init on an
      // already-confirmed board would demote it back to "planned" because the
      // CLI has no way to re-derive where the identifier came from.
      ...(inheritedProvenance ?? {}),
      ...(inheritedBoardConfirmation ?? {}),
    }),
    agents,
    automation: existing?.automation ?? defaultProjectAutomation(),
    notebook: existing?.notebook
      ? { ...existing.notebook, notebook_name: input.name.trim() }
      : { state: "planned", notebook_name: input.name.trim() },
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
  // Structured callers (notably MCP) pass explicit booleans so `live` alone
  // grants no remote effect. provisionRuntimeRepo is a deprecated no-op: the
  // only supported runtime is ignored role-local state.
  //
  // The board is NOT an optional garnish behind `--live`. It used to be, and
  // that is exactly how 11 of 24 registry records ended up carrying
  // `board_id: ""`: `pj init` is the designated ingress, it registered the
  // project, silently dropped the board action from the plan, printed nothing
  // about it, and exited 0. A record with no board fails the registry's own
  // contract — `board_confirmed_at` and `identifier_source` exist to say a
  // provider confirmed this board, and there is nothing for them to describe.
  //
  // So board provisioning defaults ON, and the only way out is the subtractive
  // `skipPlane` gate (CLI `--skip-board`), which the operator must ask for.
  // `--live` keeps its meaning for effects that change the HOST rather than the
  // project's own identity: systemd units, the notebook endpoint, and the
  // Hermes agent's own external tail.
  const provisionTicketBoard = input.provisionTicketBoard ?? true;
  const enableSystemd = input.enableSystemd ?? live;
  const skipPlane = input.skipPlane ?? false;
  const boardEnabled = provisionTicketBoard && !skipPlane;
  const systemdEnabled = live && enableSystemd && process.platform !== "darwin";
  // The AGENT's external tail is a host effect and stays behind `--live`.
  const agentBoardEffect = live && boardEnabled;
  const anyExternalAgentEffect = agentBoardEffect || systemdEnabled;
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
      ticketWorkspace: project.ticket_provider.workspace ?? "",
      boardId: project.ticket_provider.board_id ?? "",
      projectIdentifier: identifier,
      primaryLanguage: project.template.commonproject.primary_language,
      agentHooksLayer: resolveAgentHooksLayer(input.agentHooksLayer),
      overwrite,
    }));
  }
  actions.push(
    { kind: "project.write-manifest", path: join(targetDir, ".project.json"), manifest },
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
      reason: skipPlane
        ? "ticket-provider action disabled by skipPlane=true (--skip-board)"
        : project.ticket_provider.board_id
          ? "board already linked; no provider call"
          : !provisionTicketBoard
            ? "ticket-provider action requires explicit provisionTicketBoard=true"
            : `create or link the ${project.ticket_provider.type} board "${project.name}" (${identifier}) via the ticket-provider adapter`,
    },
    {
      kind: "hermes.provision-agent",
      enabled: input.provisionAgent ?? false,
      local: !anyExternalAgentEffect,
      targetDir,
      targetRepo: slug,
      role: agentRole,
      context: {
        skipPlane: !agentBoardEffect,
        // Per-agent Bloodbank consumers are retired. Agent ingress always
        // stays on the fleet-shared gateway, regardless of live/local mode.
        skipBloodbank: true,
        skipSystemd: !systemdEnabled,
      },
    }
  );

  return {
    ok: true,
    apply,
    dryRun: !apply,
    live,
    registryPath,
    project,
    manifest,
    actions,
    ...(input.boardUrl !== undefined ? { warnings: [BOARD_URL_DEPRECATION_WARNING] } : {}),
  };
}

/**
 * Fold a freshly provisioned board back into the plan's projections: the
 * registry record (shared object with the `registry.upsert` action), the
 * in-memory manifest, the action itself, and the on-disk `.project.json`.
 *
 * `buildTicketProviderBlock` owns the planned -> linked flip, so board_id and
 * state can never disagree. Returns the files it changed.
 */
function linkTicketProviderBoard(
  plan: ProjectInitPlan,
  action: Extract<ProjectInitAction, { kind: "ticket-provider.create-or-link" }>,
  boardId: string,
  identifier: string,
  now: Date = new Date()
): string[] {
  const block = buildTicketProviderBlock({
    type: action.provider,
    // The PROVIDER's identifier, not the one we proposed on the way in.
    identifier,
    identifierSource: "provider",
    identifierFetchedAt: now.toISOString(),
    boardId,
    workspace: action.workspace,
  });
  action.identifier = identifier;
  plan.project.ticket_provider = block;
  const manifestProvider = {
    type: block.type,
    workspace: block.workspace ?? "",
    identifier: block.identifier ?? "",
    identifier_source: block.identifier_source ?? "proposed",
    ...(block.identifier_fetched_at ? { identifier_fetched_at: block.identifier_fetched_at } : {}),
    board_id: block.board_id ?? "",
    // The provider just handed this board back, and the manifest is where that
    // confirmation lives for every later reader of the repo.
    ...(block.board_confirmed_at ? { board_confirmed_at: block.board_confirmed_at } : {}),
    state: block.state ?? "linked",
  };
  plan.manifest.ticket_provider = manifestProvider;
  action.boardId = boardId;
  action.state = manifestProvider.state;

  const manifestPath = join(action.repoPath, ".project.json");
  let next: Record<string, unknown>;
  if (existsSync(manifestPath)) {
    // Preserve whatever the scaffold (or the operator) already put in the file.
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      existing = {};
    }
    const existingProvider = isRecord(existing.ticket_provider) ? existing.ticket_provider : {};
    next = { ...existing, ticket_provider: { ...existingProvider, ...manifestProvider } };
  } else {
    mkdirSync(dirname(manifestPath), { recursive: true });
    next = plan.manifest as unknown as Record<string, unknown>;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== text) {
    writeFileSync(manifestPath, text, "utf8");
    return [manifestPath];
  }
  return [];
}

export async function executeProjectInitPlan(
  plan: ProjectInitPlan,
  options: ProjectInitExecutionOptions = {},
): Promise<ProjectInitExecutionResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const changedFiles: string[] = [];
  if (!plan.apply) return { ok: true, plan, logs, errors, changedFiles };

  const registry = loadProjectRegistry(plan.registryPath);
  let pendingRegistryAction: Extract<ProjectInitAction, { kind: "registry.upsert" }> | undefined;
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
        action.data.agent_hooks_layer === "false"
          ? "commonproject: agent-hooks layer skipped (global ~/.agents/hooks detected — no per-user CLI injection)"
          : "commonproject: agent-hooks layer included"
      );
      mkdirSync(dirname(action.targetDir), { recursive: true });
      const before = snapshotTree(action.targetDir);
      const copierExecutable = options.trustedCopier?.executable ?? action.command[0]!;
      const copierEnv = options.trustedCopier ? { ...process.env } : undefined;
      if (copierEnv) {
        delete copierEnv.PYTHONHOME;
        delete copierEnv.PYTHONPATH;
        copierEnv.PYTHONNOUSERSITE = "1";
        copierEnv.PYTHONSAFEPATH = "1";
      }
      const result = spawnSync(copierExecutable, action.command.slice(1), {
        encoding: "utf8",
        cwd: action.cwd,
        ...(copierEnv ? { env: copierEnv } : {}),
      });
      const copierChanges = changedTreePaths(action.targetDir, before, snapshotTree(action.targetDir));
      changedFiles.push(...copierChanges);
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
        break;
      }
    } else if (action.kind === "project.write-manifest") {
      mkdirSync(dirname(action.path), { recursive: true });
      let value = action.manifest as unknown as Record<string, unknown>;
      if (existsSync(action.path)) {
        try {
          const currentValue = JSON.parse(readFileSync(action.path, "utf8")) as unknown;
          if (isRecord(currentValue)) {
            const currentNotebook = isRecord(currentValue.notebook) ? currentValue.notebook : {};
            const desiredNotebook = isRecord(value.notebook) ? value.notebook : {};
            value = {
              ...currentValue,
              ...value,
              ticket_provider: { ...(isRecord(currentValue.ticket_provider) ? currentValue.ticket_provider : {}), ...(isRecord(value.ticket_provider) ? value.ticket_provider : {}) },
              agents: { ...(isRecord(currentValue.agents) ? currentValue.agents : {}), ...(isRecord(value.agents) ? value.agents : {}) },
              ...(value.notebook ? {
                notebook: {
                  ...currentNotebook,
                  ...desiredNotebook,
                  ...(isRecord(desiredNotebook.binding) ? { binding: { ...(isRecord(currentNotebook.binding) ? currentNotebook.binding : {}), ...desiredNotebook.binding } } : {}),
                  ...(isRecord(desiredNotebook.policy) ? { policy: { ...(isRecord(currentNotebook.policy) ? currentNotebook.policy : {}), ...desiredNotebook.policy } } : {}),
                },
              } : {}),
            };
          }
        } catch { /* invalid existing manifest is replaced by the validated plan */ }
      }
      const next = `${JSON.stringify(value, null, 2)}\n`;
      const current = existsSync(action.path) ? readFileSync(action.path, "utf8") : undefined;
      if (current !== next) {
        writeFileSync(action.path, next, "utf8");
        changedFiles.push(action.path);
      }
      changedFiles.push(...synchronizeCopierIdentity(action.path, action.manifest));
    } else if (action.kind === "registry.upsert") {
      pendingRegistryAction = action;
    } else if (action.kind === "ticket-provider.create-or-link") {
      if (!action.enabled) {
        logs.push(`ticket-provider.create-or-link skipped (${action.reason ?? "disabled by plan"})`);
      } else if (action.boardId) {
        logs.push(`ticket-provider: ${action.provider} board already linked (${action.identifier} → ${action.boardId}); nothing to create`);
      } else {
        const outcome = provisionTicketProviderBoard(action);
        logs.push(...outcome.logs);
        if (!outcome.ok) {
          errors.push(outcome.error ?? `ticket-provider: ${action.provider} board provisioning failed`);
        } else if (outcome.boardId && outcome.identifier) {
          changedFiles.push(...linkTicketProviderBoard(plan, action, outcome.boardId, outcome.identifier));
          pendingRegistryAction ??= {
            kind: "registry.upsert",
            registryPath: plan.registryPath,
            slug: plan.project.slug,
            project: plan.project,
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
          await pgStore.save(registry);
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
      state: project.ticket_provider.state,
    },
    agents,
    automation: project.automation ?? defaultProjectAutomation(),
    ...(project.notebook ? { notebook: { binding: { ...project.notebook } } } : {}),
  };
}

export function formatProjectInitPlan(plan: ProjectInitPlan): string {
  const lines = [""];
  const title = `${bold(plan.project.name)} ${dim(`(${plan.project.slug})`)}`;
  lines.push(`  ${cyan(bold(glyph.chevron))} ${title}${plan.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim("registry".padEnd(8))} ${dim(plan.registryPath)}`);
  lines.push(`  ${dim("target".padEnd(8))} ${dim(plan.project.repo_path)}`);
  for (const warning of plan.warnings ?? []) lines.push(`  ${yellow(glyph.warn)} ${warning}`);
  lines.push("");
  lines.push(`  ${bold("Actions")} ${dim(`(${plan.actions.length})`)}`);
  if (!plan.actions.length) lines.push(`     ${dim("(nothing to do)")}`);
  for (const action of plan.actions) {
    lines.push(`     ${cyan(glyph.bullet)} ${action.kind}`);
    if (action.kind === "copier.copy.commonproject") lines.push(`        ${dim(`target: ${action.targetDir}`)}`);
    if (action.kind === "project.write-manifest") lines.push(`        ${dim(`path: ${action.path}`)}`);
    if (action.kind === "ticket-provider.create-or-link") {
      const target = [action.provider, action.workspace, action.identifier].filter(Boolean).join("/");
      lines.push(`        ${dim(`board: ${target}  ${glyph.dot}  ${action.boardName}`)}`);
      lines.push(`        ${dim(`state: ${action.state}${action.boardId ? ` (${action.boardId})` : ""}`)}`);
      if (action.reason) lines.push(`        ${dim(`note: ${action.reason}`)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * List projects, newest work first.
 *
 * The old `status` column is gone. It rendered the registry's lifecycle string,
 * which read "planned" for 22 of 27 registered projects — including ones with
 * commits the same day — so it sorted nothing and told the reader nothing. Its
 * slot now holds real recency.
 *
 * Activity is passed in rather than computed here so this stays a pure
 * formatter, and so the caller can scan the registry concurrently. Projects
 * with no activity entry (a repo_path that no longer exists, of which the live
 * registry has two) sort last and render "never".
 */
export function formatProjectList(
  registry: ProjectRegistry,
  activityByPath: ReadonlyMap<string, { relative: string; updatedUnix: number | null; active: boolean }> = new Map(),
): string {
  const ageOf = (project: ProjectRecord) => activityByPath.get(project.repo_path);
  const projects = Object.values(registry.projects).sort((a, b) => {
    const left = ageOf(a)?.updatedUnix ?? -1;
    const right = ageOf(b)?.updatedUnix ?? -1;
    if (left !== right) return right - left;
    return a.slug.localeCompare(b.slug);
  });
  if (!projects.length) return `\n  ${dim("No projects registered.")}\n`;

  const relativeOf = (project: ProjectRecord) => ageOf(project)?.relative ?? "never";
  const slugWidth = projects.reduce((width, project) => Math.max(width, project.slug.length), 0);
  const idWidth = projects.reduce((width, project) => Math.max(width, String(project.ticket_provider.identifier ?? "").length), 0);
  const ageWidth = projects.reduce((width, project) => Math.max(width, relativeOf(project).length), 0);

  const lines = ["", `  ${bold("Projects")} ${dim(`(${projects.length})`)}  ${dim("newest work first")}`, ""];
  for (const project of projects) {
    const activity = ageOf(project);
    const slug = bold(project.slug.padEnd(slugWidth));
    const identifier = cyan(String(project.ticket_provider.identifier ?? "").padEnd(idWidth));
    // Pad BEFORE coloring: ANSI escapes are invisible but still count toward
    // String.padEnd's length, so padding a colored string misaligns the column.
    const padded = relativeOf(project).padEnd(ageWidth);
    const age = activity?.active ? green(padded) : activity?.updatedUnix ? yellow(padded) : dim(padded);
    lines.push(`  ${slug}  ${identifier}  ${age}  ${dim(project.repo_path)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Did a provider actually confirm this board?
 *
 * The registry's three-field contract answers this and nothing else does:
 * `board_id` is a claim, `board_confirmed_at` is the provider's answer, and
 * `state: "linked"` is the two agreeing. A record missing any of them is a
 * project whose board does not exist as far as anything downstream can tell.
 */
export function isBoardConfirmed(provider: ProjectTicketProvider | undefined): boolean {
  return Boolean(provider?.board_id && provider.board_confirmed_at && provider.state === "linked");
}

/** What `pj init` promised about the board, and what it actually delivered. */
export interface BoardDelivery {
  /** The plan meant to reach a board (not suppressed by --skip-board). */
  intended: boolean;
  confirmed: boolean;
  provider: string;
  workspace: string;
  identifier: string;
  boardId: string;
  state: string;
  /** Why the board action did not run, when it did not. */
  reason?: string;
}

export function boardDelivery(plan: ProjectInitPlan): BoardDelivery {
  const action = plan.actions.find((entry) => entry.kind === "ticket-provider.create-or-link");
  const provider = plan.project.ticket_provider;
  return {
    intended: action?.kind === "ticket-provider.create-or-link" ? action.enabled : false,
    confirmed: isBoardConfirmed(provider),
    provider: provider.type,
    workspace: provider.workspace ?? "",
    identifier: provider.identifier ?? "",
    boardId: provider.board_id ?? "",
    state: provider.state ?? "planned",
    ...(action?.kind === "ticket-provider.create-or-link" && action.reason ? { reason: action.reason } : {}),
  };
}

/**
 * Drop one project from the registry. The repo on disk and the provider board
 * are deliberately left alone — this removes a REGISTRY RECORD, nothing else.
 */
export interface ProjectRemovalResult {
  ok: boolean;
  apply: boolean;
  registryPath: string;
  slug: string;
  removed: ProjectRecord;
}

export function removeProjectRecord(input: {
  slug: string;
  apply?: boolean;
  registryPath?: string;
}): ProjectRemovalResult {
  const registryPath = resolve(
    projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }),
  );
  const registry = loadProjectRegistry(registryPath);
  // getProject throws "Project not found in registry: <slug>" for an unknown
  // slug, which is the refusal this command owes the caller.
  const removed = getProject(registry, input.slug);
  const apply = input.apply ?? false;
  if (apply) {
    delete registry.projects[input.slug];
    saveProjectRegistry(registry, registryPath);
  }
  return { ok: true, apply, registryPath, slug: input.slug, removed };
}

export function getProject(registry: ProjectRegistry, slug: string): ProjectRecord {
  const project = getOwnRecordValue(registry.projects, slug);
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
  boardId?: string;
  ticketWorkspace?: string;
  projectIdentifier: string;
  primaryLanguage: string;
  agentHooksLayer?: boolean;
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
    ticket_workspace: input.ticketWorkspace ?? input.planeWorkspace,
    board_id: input.boardId ?? input.planeProjectId ?? "",
    project_identifier: input.projectIdentifier,
    primary_language: input.primaryLanguage,
    agent_hooks_layer: (input.agentHooksLayer ?? true) ? "true" : "false",
  };
  // `--vcs-ref=HEAD` is load-bearing (PJAN-49). Whenever `templates/commonproject`
  // resolves to a git repo *root* — a standalone clone rather than a submodule
  // gitlink — copier treats it as a VCS template and, with no ref, checks out the
  // latest PEP440 tag instead of the checked-out commit. Every template change
  // since that tag then silently vanishes from generated projects. Pinning HEAD
  // renders the commit the superproject actually points at, and is a no-op when
  // the template is a plain directory. Same treatment as the hermes-agent
  // template in src/commands/hermes/RunCopierTemplate.ts.
  const command = ["copier", "copy", "--trust", "--vcs-ref=HEAD", templateDir, input.targetDir, "--defaults"];
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
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd());
}

function validateNoDuplicateProject(registry: ProjectRegistry, project: ProjectRecord, overwrite: boolean): void {
  const existingSameSlug = getOwnRecordValue(registry.projects, project.slug);
  if (existingSameSlug && !overwrite && resolve(existingSameSlug.repo_path) !== resolve(project.repo_path)) {
    throw new Error(`Project slug already exists in registry: ${project.slug}`);
  }
  for (const [slug, existing] of Object.entries(registry.projects)) {
    if (slug === project.slug) continue;
    if (resolve(existing.repo_path) === resolve(project.repo_path)) {
      throw new Error(`Project repo_path already registered by ${slug}: ${project.repo_path}`);
    }
    if (ticketProviderScope(existing.ticket_provider) !== ticketProviderScope(project.ticket_provider)) continue;
    if (existing.ticket_provider.board_id?.trim() && existing.ticket_provider.board_id === project.ticket_provider.board_id) {
      throw new Error(`Project board_id already registered by ${slug}: ${project.ticket_provider.board_id}`);
    }
    if (existing.ticket_provider.identifier && existing.ticket_provider.identifier.toUpperCase() === project.ticket_provider.identifier?.toUpperCase()) {
      throw new Error(`Project identifier already registered by ${slug}: ${project.ticket_provider.identifier}`);
    }
  }
}

function validateProjectRecord(project: ProjectRecord, key: string): void {
  validateSafePathSegment(key, `Project registry key ${key}`);
  if (!isRecord(project)) throw new Error(`Project ${key} must be a mapping`);
  if (!project.name) throw new Error(`Project ${key} missing name`);
  if (!project.slug) throw new Error(`Project ${key} missing slug`);
  validateSafePathSegment(project.slug, `Project ${key} slug`);
  if (project.slug !== key) throw new Error(`Project key ${key} does not match slug ${project.slug}`);
  if (!project.repo_path) throw new Error(`Project ${key} missing repo_path`);
  if (!Array.isArray(project.source_artifacts)) throw new Error(`Project ${key} source_artifacts must be a list`);
  if (!isRecord(project.ticket_provider)) throw new Error(`Project ${key} ticket_provider must be a mapping`);
  const provider = project.ticket_provider as ProjectTicketProvider;
  // R1
  if (provider.state !== undefined && !(TICKET_PROVIDER_STATES as readonly string[]).includes(provider.state)) {
    throw new Error(`Project ${key} ticket_provider.state must be one of ${TICKET_PROVIDER_STATES.join(" | ")}; got ${JSON.stringify(provider.state)}`);
  }
  // R2
  if (provider.identifier_source !== undefined && !(PROJECT_IDENTIFIER_SOURCES as readonly string[]).includes(provider.identifier_source)) {
    throw new Error(`Project ${key} ticket_provider.identifier_source must be one of ${PROJECT_IDENTIFIER_SOURCES.join(" | ")}; got ${JSON.stringify(provider.identifier_source)}`);
  }
  // R3 — BOARD-binding provenance. "linked" means the provider confirmed this
  // board exists, and nothing else. That is a question every provider can
  // answer, including one that assigns no identifiers at all.
  if (provider.state === "linked" && !(provider.board_id && provider.board_confirmed_at)) {
    throw new Error(
      `Project ${key} ticket_provider.state is "linked" but its board binding is not provider-confirmed ` +
      `(board_id=${JSON.stringify(provider.board_id ?? "")}, ` +
      `board_confirmed_at=${JSON.stringify(provider.board_confirmed_at ?? "")}). Run \`${IDENTIFIER_REPAIR_COMMAND}\`.`
    );
  }
  // R3a — IDENTIFIER provenance, which is a separate claim. Saying the provider
  // assigned this key requires a key and the instant it was read back.
  if (provider.identifier_source === "provider" && !(provider.identifier && provider.identifier_fetched_at)) {
    throw new Error(
      `Project ${key} ticket_provider.identifier_source is "provider" but no identifier was read back ` +
      `(identifier=${JSON.stringify(provider.identifier ?? "")}, ` +
      `identifier_fetched_at=${JSON.stringify(provider.identifier_fetched_at ?? "")}). Run \`${IDENTIFIER_REPAIR_COMMAND}\`.`
    );
  }
  // R3b — and where the provider DOES assign identifiers, a link must carry the
  // one it assigned. This is the original invariant, now scoped to the
  // providers it is actually true of: a Plane board key routes live webhook
  // traffic, so a guess wearing "linked" is the whole defect.
  if (provider.state === "linked" && providerAssignsIdentifiers(provider.type) && provider.identifier_source !== "provider") {
    throw new Error(
      `Project ${key} ticket_provider.state is "linked" on ${provider.type}, which assigns its own identifiers, ` +
      `but identifier_source=${JSON.stringify(provider.identifier_source ?? "")} ` +
      `(identifier=${JSON.stringify(provider.identifier ?? "")}). Run \`${IDENTIFIER_REPAIR_COMMAND}\`.`
    );
  }
  if (!isRecord(project.agents)) throw new Error(`Project ${key} agents must be a mapping`);
  if (project.notebook !== undefined) {
    if (!isRecord(project.notebook)) throw new Error(`Project ${key} notebook must be a mapping`);
    const credentialPath = notebookCredentialMaterialPath(project.notebook);
    if (credentialPath) throw new Error(`Project ${key} Notebook binding contains forbidden credential material at ${credentialPath}`);
    if (project.notebook.state !== "disabled" && project.notebook.state !== "planned" && project.notebook.state !== "linked") throw new Error(`Project ${key} notebook state is invalid`);
    if (project.notebook.state === "linked" && (!project.notebook.notebook_id || !project.notebook.overview_note_id)) throw new Error(`Project ${key} linked notebook is missing stable IDs`);
    for (const field of ["notebook_id", "notebook_name", "overview_note_id", "blocked_reason"] as const) {
      const value = project.notebook[field];
      if (value !== undefined && (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error(`Project ${key} notebook.${field} is invalid`);
    }
  }
  for (const [agentKey, agent] of Object.entries(project.agents)) {
    validateSafePathSegment(agentKey, `Project ${key} agent key ${agentKey}`);
    if (!isRecord(agent)) throw new Error(`Project ${key} agent ${agentKey} must be a mapping`);
    if (typeof agent.role !== "string" || !agent.role) throw new Error(`Project ${key} agent ${agentKey} missing role`);
    validateSafePathSegment(agent.role, `Project ${key} agent ${agentKey} role`);
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
