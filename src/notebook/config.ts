import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getOwnRecordValue,
  loadProjectRegistry,
  projectRegistryPath,
  saveProjectRegistry,
  type ProjectManifest,
  type ProjectRecord,
  type ProjectRegistry,
} from "../project/index";
import {
  DEFAULT_NOTEBOOK_LIMITS,
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  notebookCredentialMaterialPath,
  type EffectiveNotebookConfigV1,
  type NotebookAuthConfigV1,
  type NotebookGlobalConfigV1,
  type NotebookLimitsV1,
  type NotebookPolicyV1,
  type ProjectNotebookBindingV1,
  type ProjectNotebookConfigV1,
} from "./types";

const DEFAULT_POLICY: Readonly<NotebookPolicyV1> = Object.freeze({
  enabled: true,
  session_start_enabled: false,
  session_capture_enabled: false,
  overview_max_chars: 4_000,
  documentation_globs: ["**/*.md", "**/*.mdx"],
});

export interface ResolvedNotebookProjectV1 {
  registry: ProjectRegistry;
  project: ProjectRecord;
  manifest: ProjectManifest | null;
  registry_path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function realOrResolved(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function readManifest(repoPath: string): ProjectManifest | null {
  const path = resolve(repoPath, ".project.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new NotebookError("INVALID_INPUT", `${path} is not valid JSON`);
  }
  if (!isRecord(parsed)) return null;
  validateManifestNotebookSurface(parsed.notebook);
  return parsed as unknown as ProjectManifest;
}

const MANIFEST_NOTEBOOK_KEYS = new Set(["binding", "policy", "display_name"]);
const MANIFEST_POLICY_KEYS = new Set(["enabled", "session_start_enabled", "session_capture_enabled", "overview_max_chars", "documentation_globs", "overview_references", "excluded_globs"]);

function validateManifestNotebookSurface(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook must be a mapping");
  const credentialPath = notebookCredentialMaterialPath(value);
  if (credentialPath) throw new NotebookError("NOT_CONFIGURED", `Manifest Notebook configuration contains forbidden credential material at ${credentialPath}`);
  for (const key of Object.keys(value)) {
    if (!MANIFEST_NOTEBOOK_KEYS.has(key) && !key.startsWith("x_")) {
      throw new NotebookError("NOT_CONFIGURED", `Manifest notebook.${key} is not an allowed policy or binding projection field`);
    }
  }
  if (value.binding !== undefined && !isRecord(value.binding)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.binding must be a mapping");
  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.policy must be a mapping");
    for (const key of Object.keys(value.policy)) {
      if (!MANIFEST_POLICY_KEYS.has(key) && !key.startsWith("x_")) throw new NotebookError("NOT_CONFIGURED", `Manifest notebook.policy.${key} is not an allowed policy field`);
    }
  }
}

export function resolveNotebookProject(repoArg = process.cwd(), registryFile = projectRegistryPath()): ResolvedNotebookProjectV1 {
  const registry = loadProjectRegistry(registryFile);
  const requested = realOrResolved(repoArg);
  const matches = Object.values(registry.projects).filter((project) => realOrResolved(project.repo_path) === requested);
  if (matches.length === 0) throw new NotebookError("NOT_FOUND", `Repository is not registered: ${requested}`);
  if (matches.length > 1) throw new NotebookError("CONFLICT", `More than one Registry project maps to repository: ${requested}`);
  const project = matches[0]!;
  return { registry, project, manifest: readManifest(project.repo_path), registry_path: registryFile };
}

export function resolveNotebookProjectBySlug(projectSlug: string, registryFile = projectRegistryPath()): ResolvedNotebookProjectV1 {
  const registry = loadProjectRegistry(registryFile);
  const project = getOwnRecordValue(registry.projects, projectSlug);
  if (!project) throw new NotebookError("NOT_FOUND", `Project is not registered: ${projectSlug}`);
  return { registry, project, manifest: readManifest(project.repo_path), registry_path: registryFile };
}

export function validateNotebookBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url may not contain credentials, query parameters, or a fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const loopback = hostname === "localhost" || unbracketed === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(unbracketed);
  if (isIP(unbracketed) !== 0 && !loopback) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url may not use a numeric non-loopback host");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url must use HTTPS or loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function validateNotebookAuth(value: unknown): NotebookAuthConfigV1 {
  if (value == null) return { mode: "none" };
  if (!isRecord(value) || (value.mode !== "none" && value.mode !== "environment")) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook auth.mode must be none or environment");
  }
  if (value.mode === "none") return { mode: "none" };
  if (typeof value.env_var !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value.env_var)) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook auth.env_var must be a safe environment variable name");
  }
  // The canonical global hook wrappers deliberately forward only this one
  // allowlisted credential. Accepting another name here would make the CLI
  // appear configured while SessionStart/SessionEnd silently lacked auth.
  if (value.env_var !== "OPEN_NOTEBOOK_PASSWORD") {
    throw new NotebookError("NOT_CONFIGURED", "Notebook hooks support only auth.env_var OPEN_NOTEBOOK_PASSWORD");
  }
  return { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" };
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new NotebookError("NOT_CONFIGURED", `Notebook limit ${name} must be a finite positive integer`);
  return Number(value);
}

export function resolveNotebookLimits(overrides: Partial<NotebookLimitsV1> = {}): NotebookLimitsV1 {
  const result = { ...DEFAULT_NOTEBOOK_LIMITS } as NotebookLimitsV1;
  for (const key of Object.keys(DEFAULT_NOTEBOOK_LIMITS) as Array<keyof NotebookLimitsV1>) {
    if (key === "schema_version") continue;
    result[key] = positiveInteger(overrides[key], DEFAULT_NOTEBOOK_LIMITS[key], key) as never;
  }
  result.schema_version = NOTEBOOK_SCHEMA_VERSION;
  if (result.receipt_max_bytes > result.unresolved_receipt_max_bytes) {
    throw new NotebookError("NOT_CONFIGURED", "receipt_max_bytes may not exceed unresolved_receipt_max_bytes");
  }
  if (result.hook_payload_max_bytes > DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes) {
    throw new NotebookError("NOT_CONFIGURED", "hook_payload_max_bytes may tighten but not exceed the packaged absolute ceiling");
  }
  if (result.lease_seconds * 1_000 <= result.overall_timeout_ms) {
    throw new NotebookError("NOT_CONFIGURED", "lease_seconds must exceed one bounded remote request timeout so workers can renew without overlap");
  }
  return result;
}

function stringList(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 512)) {
    throw new NotebookError("NOT_CONFIGURED", `Notebook policy ${name} must be a bounded string list`);
  }
  return [...value];
}

function resolvePolicy(globalDefaults: unknown, manifestPolicy: unknown, limits: NotebookLimitsV1): NotebookPolicyV1 {
  const global = isRecord(globalDefaults) ? globalDefaults : {};
  const local = isRecord(manifestPolicy) ? manifestPolicy : {};
  const pick = (key: string): unknown => Object.hasOwn(local, key) ? local[key] : global[key];
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = pick(key);
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new NotebookError("NOT_CONFIGURED", `Notebook policy ${key} must be boolean`);
    return value;
  };
  const overview = positiveInteger(pick("overview_max_chars"), limits.overview_max_chars, "overview_max_chars");
  if (overview > limits.note_max_bytes) throw new NotebookError("NOT_CONFIGURED", "overview_max_chars exceeds the note ceiling");
  return {
    enabled: boolean("enabled", DEFAULT_POLICY.enabled),
    session_start_enabled: boolean("session_start_enabled", DEFAULT_POLICY.session_start_enabled),
    session_capture_enabled: boolean("session_capture_enabled", DEFAULT_POLICY.session_capture_enabled),
    overview_max_chars: overview,
    documentation_globs: stringList(pick("documentation_globs"), [...DEFAULT_POLICY.documentation_globs], "documentation_globs"),
    ...(pick("overview_references") !== undefined
      ? { overview_references: stringList(pick("overview_references"), [], "overview_references") }
      : {}),
    ...(pick("excluded_globs") !== undefined
      ? { excluded_globs: stringList(pick("excluded_globs"), [], "excluded_globs") }
      : {}),
  };
}

function projectNotebook(project: ProjectRecord): ProjectNotebookConfigV1 {
  const raw = (project as ProjectRecord & { notebook?: unknown }).notebook;
  if (!isRecord(raw)) return { binding: { state: "disabled" }, policy: { enabled: false } };
  const bindingRaw = isRecord(raw.binding) ? raw.binding : raw;
  const state = bindingRaw.state;
  if (state !== "disabled" && state !== "planned" && state !== "linked") {
    throw new NotebookError("NOT_CONFIGURED", `Project ${project.slug} notebook binding state is invalid`);
  }
  const binding: ProjectNotebookBindingV1 = { ...bindingRaw, state } as ProjectNotebookBindingV1;
  for (const key of ["notebook_id", "notebook_name", "overview_note_id", "blocked_reason"] as const) {
    if (binding[key] !== undefined && (typeof binding[key] !== "string" || binding[key]!.length > 512)) {
      throw new NotebookError("NOT_CONFIGURED", `Project ${project.slug} notebook.${key} is invalid`);
    }
  }
  return { ...raw, binding, policy: isRecord(raw.policy) ? raw.policy as Partial<NotebookPolicyV1> : undefined };
}

function manifestNotebookPolicy(manifest: ProjectManifest | null): unknown {
  if (!manifest) return undefined;
  const notebook = (manifest as ProjectManifest & { notebook?: unknown }).notebook;
  return isRecord(notebook) ? notebook.policy : undefined;
}

export function notebookDisplayName(resolved: ResolvedNotebookProjectV1): string {
  const raw = resolved.manifest && (resolved.manifest as ProjectManifest & { notebook?: unknown }).notebook;
  const override = isRecord(raw) ? raw.display_name : undefined;
  if (override !== undefined) {
    if (typeof override !== "string" || !override.trim() || override.length > 512 || /[\u0000-\u001f\u007f]/u.test(override)) {
      throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.display_name must be a bounded display name without control characters");
    }
    return override.trim();
  }
  if (!resolved.project.name.trim() || resolved.project.name.length > 512 || /[\u0000-\u001f\u007f]/u.test(resolved.project.name)) {
    throw new NotebookError("NOT_CONFIGURED", "Project name cannot supply a safe Companion Notebook display name");
  }
  return resolved.project.name.trim();
}

export function resolveEffectiveNotebookConfig(resolved: ResolvedNotebookProjectV1): EffectiveNotebookConfigV1 {
  const globalRaw = (resolved.registry as ProjectRegistry & { notebook?: unknown }).notebook;
  const global = isRecord(globalRaw) ? globalRaw as NotebookGlobalConfigV1 : {};
  const project = projectNotebook(resolved.project);
  const limits = resolveNotebookLimits(isRecord(global.limits) ? global.limits as Partial<NotebookLimitsV1> : {});
  const declared = isRecord((resolved.project as ProjectRecord & { notebook?: unknown }).notebook);
  const localPolicy = manifestNotebookPolicy(resolved.manifest);
  const resolvedPolicy = resolvePolicy(global.defaults, localPolicy, limits);
  const policy = declared ? resolvedPolicy : { ...resolvedPolicy, enabled: false };
  const baseUrl = typeof global.base_url === "string" && global.base_url.trim() ? validateNotebookBaseUrl(global.base_url) : null;
  const auth = validateNotebookAuth(global.auth);
  let summarizer: { executable: string; args: string[] } | undefined;
  if (global.summarizer !== undefined) {
    if (!isRecord(global.summarizer) || typeof global.summarizer.executable !== "string"
      || !global.summarizer.executable.startsWith("/") || global.summarizer.executable.includes("\0")
      || Buffer.byteLength(global.summarizer.executable, "utf8") > 1_024) {
      throw new NotebookError("NOT_CONFIGURED", "Notebook summarizer executable must be a bounded absolute path");
    }
    const rawArgs = global.summarizer.args ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > 32
      || rawArgs.some((item) => typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item, "utf8") > 1_024)) {
      throw new NotebookError("NOT_CONFIGURED", "Notebook summarizer argv must be a bounded string list");
    }
    summarizer = { executable: global.summarizer.executable, args: [...rawArgs] as string[] };
  }
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: resolved.project.slug,
    repo_path: realOrResolved(resolved.project.repo_path),
    base_url: baseUrl,
    auth,
    policy,
    limits,
    binding: project.binding,
    configuration_provenance: {
      base_url: baseUrl ? "registry-global" : "default",
      auth: global.auth ? "registry-global" : "default",
      policy: localPolicy ? "manifest-policy" : global.defaults ? "registry-global" : "default",
      binding: "project-registry",
      limits: global.limits ? "registry-global" : "default",
    },
    ...(summarizer ? { summarizer } : {}),
  };
}

export function loadEffectiveNotebookConfig(repoArg = process.cwd(), registryFile = projectRegistryPath()): EffectiveNotebookConfigV1 {
  return resolveEffectiveNotebookConfig(resolveNotebookProject(repoArg, registryFile));
}

export function runtimeNotebookCredential(config: EffectiveNotebookConfigV1, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (config.auth.mode !== "environment") return undefined;
  const value = env[config.auth.env_var!];
  if (!value) throw new NotebookError("NOT_CONFIGURED", `Notebook auth environment variable ${config.auth.env_var} is not set`);
  return value;
}

export function requireRemoteNotebookConfig(config: EffectiveNotebookConfigV1): string {
  if (!config.policy.enabled) throw new NotebookError("NOT_CONFIGURED", "Project Notebook is disabled for this repository");
  if (!config.base_url) throw new NotebookError("NOT_CONFIGURED", "Notebook base_url is not configured");
  return config.base_url;
}

export function registryProjectBySlug(registry: ProjectRegistry, slug: string): ProjectRecord {
  const project = getOwnRecordValue(registry.projects, slug);
  if (!project) throw new NotebookError("NOT_FOUND", `Project is not registered: ${slug}`);
  return project;
}

export function persistProjectNotebookBinding(
  resolved: ResolvedNotebookProjectV1,
  binding: ProjectNotebookBindingV1,
  policy?: Partial<NotebookPolicyV1>,
): string[] {
  const changed: string[] = [];
  const manifestPath = resolve(resolved.project.repo_path, ".project.json");
  const manifestRaw = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    : {};
  if (!isRecord(manifestRaw)) throw new NotebookError("INVALID_INPUT", `${manifestPath} must contain a JSON object`);
  validateManifestNotebookSurface(manifestRaw.notebook);
  const manifestNotebook = isRecord(manifestRaw.notebook) ? manifestRaw.notebook : {};
  const previousBinding = isRecord(manifestNotebook.binding) ? manifestNotebook.binding : {};
  const foreignBinding = Object.fromEntries(Object.entries(previousBinding).filter(([key]) => !["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"].includes(key)));
  const previousPolicy = isRecord(manifestNotebook.policy) ? manifestNotebook.policy : {};
  const manifestNext = {
    ...manifestRaw,
    notebook: {
      ...manifestNotebook,
      binding: { ...foreignBinding, ...binding },
      ...(policy ? { policy: { ...previousPolicy, ...policy } } : {}),
    },
  };
  const manifestText = `${JSON.stringify(manifestNext, null, 2)}\n`;
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestText) {
    let mode = 0o644;
    if (existsSync(manifestPath)) {
      const current = lstatSync(manifestPath);
      if (!current.isFile() || current.isSymbolicLink()) throw new NotebookError("CONFLICT", `${manifestPath} must be a regular non-symlink file`);
      mode = current.mode & 0o777;
    }
    const temp = resolve(dirname(manifestPath), `.${process.pid}.${randomUUID()}.project.json.tmp`);
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, manifestText, "utf8");
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, manifestPath);
    try {
      const directory = openSync(dirname(manifestPath), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* directory fsync is not portable; file fsync remains enforced */ }
    changed.push(manifestPath);
  }

  const current = (resolved.project as ProjectRecord & { notebook?: unknown }).notebook;
  resolved.project.notebook = { ...(isRecord(current) ? current : { state: "planned" }), ...binding } as ProjectNotebookBindingV1;
  const registryBefore = existsSync(resolved.registry_path) ? readFileSync(resolved.registry_path, "utf8") : null;
  saveProjectRegistry(resolved.registry, resolved.registry_path);
  const registryAfter = existsSync(resolved.registry_path) ? readFileSync(resolved.registry_path, "utf8") : null;
  if (registryBefore !== registryAfter) changed.push(resolved.registry_path);
  return changed;
}

export function persistProjectNotebookDeclaration(resolved: ResolvedNotebookProjectV1): string[] {
  const current = (resolved.project as ProjectRecord & { notebook?: unknown }).notebook;
  const binding: ProjectNotebookBindingV1 = isRecord(current)
    ? projectNotebook(resolved.project).binding
    : { state: "planned", notebook_name: resolved.project.name };
  return persistProjectNotebookBinding(resolved, binding, {
    enabled: true,
    session_start_enabled: false,
    session_capture_enabled: false,
  });
}
