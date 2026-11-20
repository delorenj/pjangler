// The project's PM, read from disk: shared by the prompt (dist/prompt.js) and its detached refresher
// (dist/prompt-refresh.js). A leaf module on purpose: prompt.ts runs its own main() when it is the entry
// point, so the refresher must never import it, and this keeps both bundles import-light.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectPm {
  /** The `agents` key: the employee id Flume knows the PM by. */
  agentId: string;
  /** Telegram bot username, without the `@`. */
  botUsername?: string;
}

export interface ProjectManifestFacts {
  slug: string;
  identifier?: string;
  agents?: unknown;
}

/**
 * `.project.json`'s identity facts. A malformed manifest still identifies a project: the directory name is a
 * truthful fallback and keeps the prompt line from vanishing confusingly.
 */
export function readProjectManifest(root: string): ProjectManifestFacts {
  const facts: ProjectManifestFacts = { slug: basename(root) };
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".project.json"), "utf8")) as Record<string, unknown>;
    const projectId = manifest.project_id ?? manifest.project_slug;
    if (typeof projectId === "string" && projectId.trim()) facts.slug = projectId.trim().toLowerCase();
    const provider = manifest.ticket_provider as Record<string, unknown> | undefined;
    if (provider && typeof provider.identifier === "string" && provider.identifier) facts.identifier = provider.identifier;
    facts.agents = manifest.agents;
  } catch {
    // directory name stands
  }
  return facts;
}

/** One top-level scalar of a role manifest (`key: "value"`), or the field of a top-level block. */
function manifestScalar(text: string, key: string, block?: string): string | undefined {
  let scope = text;
  if (block) {
    const start = new RegExp(`^${block}:[ \\t]*(?:#.*)?$`, "m").exec(text);
    if (!start) return undefined;
    const rest = text.slice(start.index + start[0].length + 1);
    const end = /^\S/m.exec(rest);
    scope = end ? rest.slice(0, end.index) : rest;
  }
  const indent = block ? "[ \\t]+" : "";
  const match = new RegExp(`^${indent}${key}:[ \\t]*"?([^"\\s#]*)"?`, "m").exec(scope);
  return match?.[1] || undefined;
}

/**
 * The project's PM: the `agents` entry with role `pm` (`<slug>-pm` first when a project has more than one),
 * with its bot read from its tracked role manifest. A plain text read, not a YAML parse: the prompt bundle
 * stays import-free for its budget.
 */
export function readProjectPm(root: string, slug: string, agents: unknown): ProjectPm | undefined {
  if (!agents || typeof agents !== "object") return undefined;
  const pms = Object.entries(agents as Record<string, unknown>)
    .filter(([, entry]) => (entry as { role?: unknown })?.role === "pm");
  if (!pms.length) return undefined;
  const [agentId, entry] = pms.find(([id]) => id === `${slug}-pm`) ?? pms[0]!;
  const pm: ProjectPm = { agentId };
  const roleDir = (entry as { role_dir?: unknown }).role_dir;
  try {
    const text = readFileSync(join(root, typeof roleDir === "string" && roleDir ? roleDir : join("agents", "hermes", "pm"), "role.yaml"), "utf8");
    pm.botUsername = manifestScalar(text, "bot_username", "telegram");
  } catch {
    // A PM declared in the manifest but not on disk still has a name.
  }
  return pm;
}
