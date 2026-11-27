import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeProjectId, readManifest, RegistryError } from "./manifestIndex";

const PROJECT_HOME = "https://holocene.delo.sh/projects/";

// Unlike the board/prompt's permissive walk, navigation must stop at an
// unreadable or dangling nearer manifest rather than silently open its parent.
function nearestManifest(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const path = join(dir, ".project.json");
    try {
      lstatSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** JSON.parse collapses repeated keys. Inspect decoded top-level identity keys in the valid raw document. */
function rejectDuplicateIdentityKeys(raw: string): void {
  const seen = new Set<string>();
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      const start = i++;
      while (i < raw.length) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i] === '"') break;
        i++;
      }
      if (depth === 1 && /^\s*:/.test(raw.slice(i + 1))) {
        const key = JSON.parse(raw.slice(start, i + 1)) as string;
        if (key === "project_id" || key === "project_slug") {
          if (seen.has(key)) throw new RegistryError(`Duplicate ${key} in .project.json`, 409, "identity_conflict");
          seen.add(key);
        }
      }
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
}

/** Resolve only the nearest manifest; never infer an identity from the directory or board. */
export async function resolveDashboardUrl(cwd: string): Promise<string> {
  const path = nearestManifest(cwd);
  if (!path) throw new Error("No project here: .project.json not found in this directory or its parents");

  const { manifest, raw } = await readManifest(path);
  rejectDuplicateIdentityKeys(raw);
  if (!Object.hasOwn(manifest, "project_id")) throw new Error("project_id is required in .project.json");
  const id = normalizeProjectId(manifest.project_id);
  if (Object.hasOwn(manifest, "project_slug") && normalizeProjectId(manifest.project_slug) !== id) {
    throw new RegistryError("Conflicting project_id and project_slug in .project.json", 409, "identity_conflict");
  }
  return `${PROJECT_HOME}${encodeURIComponent(id)}`;
}
