import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProjectRoot } from "./boardUrl";
import {
  doctorProjectRegistry,
  getProject,
  loadProjectRegistry,
  projectRegistryPath,
  normalizeProjectId,
  type ProjectDoctorResult,
} from "./index";

type Manifest = Record<string, unknown>;
export interface ProjectInfo {
  ok: true;
  project_id: string;
  repo_path: string;
  manifest_path: string;
  manifest: Manifest;
  registry: {
    location: string;
    status: "indexed" | "not-indexed" | "unavailable" | "stale";
    message?: string;
  };
}

function readManifest(root: string): { manifest: Manifest; projectId: string } {
  const path = join(root, ".project.json");
  let manifest: Manifest;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    manifest = value as Manifest;
  } catch (error) {
    throw new Error(`Cannot read project manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = manifest.project_id ?? manifest.project_slug;
  const projectId = normalizeProjectId(raw);
  if (manifest.project_id && manifest.project_slug && normalizeProjectId(manifest.project_slug) !== projectId) throw new Error(`Conflicting project identities in ${path}`);
  const { project_slug: _legacy, ...fields } = manifest;
  return { manifest: { ...fields, project_id: projectId }, projectId };
}

/** Local reads never depend on the registry being available or up to date. */
export function readProjectInfo(input: { projectId?: string; cwd?: string; registryPath?: string } = {}): ProjectInfo {
  const location = input.registryPath ?? projectRegistryPath();
  let root: string;
  let registry: ReturnType<typeof loadProjectRegistry> | undefined;
  let registryError: string | undefined;
  const requested = input.projectId === undefined ? undefined : normalizeProjectId(input.projectId);
  if (requested) {
    registry = loadProjectRegistry(location);
    root = getProject(registry, requested).repo_path;
  } else {
    const local = findProjectRoot(input.cwd ?? process.cwd());
    if (!local) throw new Error("Not inside a project: no .project.json found. Pass a project ID or run pj init.");
    root = local;
  }
  const { manifest, projectId } = readManifest(root);
  if (requested && requested !== projectId) {
    throw new Error(`Registry entry ${requested} points to a manifest defining ${projectId}; reindex that repository.`);
  }
  if (!registry) {
    try { registry = loadProjectRegistry(location); }
    catch (error) { registryError = error instanceof Error ? error.message : String(error); }
  }
  const info: ProjectInfo = {
    ok: true,
    project_id: projectId,
    repo_path: resolve(root),
    manifest_path: join(resolve(root), ".project.json"),
    manifest,
    registry: { location, status: "indexed" },
  };
  if (!registry) {
    info.registry = { location, status: "unavailable", message: `Local manifest loaded; registry unavailable: ${registryError}. Start the registry service and retry pj doctor.` };
    return info;
  }
  const statuses = registry.__registry_status as Record<string, { status: string; error?: string }> | undefined;
  const indexStatus = statuses?.[projectId];
  if (indexStatus && indexStatus.status !== "ok") {
    info.registry = { location, status: "stale", message: `Registry manifest status is ${indexStatus.status}: ${indexStatus.error ?? "the last indexed snapshot is stale"}. Reindex this repository.` };
    return info;
  }
  let indexed;
  try { indexed = getProject(registry, projectId); }
  catch {
    info.registry = { location, status: "not-indexed", message: "This project is not indexed. Run pj init --apply from its repository." };
    return info;
  }
  if (resolve(indexed.repo_path) !== resolve(root)) {
    info.registry = { location, status: "stale", message: `The registry points to ${indexed.repo_path}; this manifest is at ${root}. Reindex the repository.` };
  }
  return info;
}

/** Without --all doctor must check the current manifest, even before registration. */
export function doctorCurrentProject(input: { projectId?: string; cwd?: string; registryPath?: string } = {}): ProjectDoctorResult {
  const info = readProjectInfo(input);
  if (info.registry.status !== "indexed") {
    return {
      ok: false,
      registryPath: info.registry.location,
      checkedProjects: [info.project_id],
      issues: [{ level: "error", slug: info.project_id, message: `${info.registry.status}: ${info.registry.message}` }],
    };
  }
  return doctorProjectRegistry(info.registry.location, info.project_id);
}
