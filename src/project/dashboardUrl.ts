import { join } from "node:path";
import { findProjectRoot } from "./boardUrl";
import { normalizeProjectId, readManifest, RegistryError } from "./manifestIndex";

const PROJECT_HOME = "https://holocene.delo.sh/projects/";

/** Resolve only the nearest manifest; never infer an identity from the directory or board. */
export async function resolveDashboardUrl(cwd: string): Promise<string> {
  const root = findProjectRoot(cwd);
  if (!root) throw new Error("No project here: .project.json not found in this directory or its parents");

  const { manifest } = await readManifest(join(root, ".project.json"));
  if (!Object.hasOwn(manifest, "project_id")) throw new Error("project_id is required in .project.json");
  const id = normalizeProjectId(manifest.project_id);
  if (Object.hasOwn(manifest, "project_slug") && normalizeProjectId(manifest.project_slug) !== id) {
    throw new RegistryError("Conflicting project_id and project_slug in .project.json", 409, "identity_conflict");
  }
  return `${PROJECT_HOME}${encodeURIComponent(id)}`;
}
