// Ticket-provider URL derivation — the one place a board or work-item URL is
// constructed.
//
// `src/project/index.ts` has long declared the rule ("board URLs are derived
// from provider + workspace + board_id at runtime; the manifest stores only
// stable identity") without anywhere actually performing it, so every caller
// that wanted a URL either hand-assembled one or persisted a stale
// `board_url`. This module is that missing function.
//
// Deliberately dependency-free — node builtins only, no imports from
// `./index`. `src/prompt.ts` is a separate size-critical bundle that runs on
// every shell prompt, and pulling the registry (or the parity rule set behind
// it) into that bundle would cost more than the whole feature is worth.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PLANE_BASE = "https://plane.delo.sh";
export const DEFAULT_PLANE_WORKSPACE = "33god";

/** The `.project.json` `ticket_provider` block, as far as URL building cares. */
export interface TicketProviderFacts {
  type?: string;
  workspace?: string;
  identifier?: string;
  board_id?: string;
}

export interface BoardUrlOptions {
  /** Explicit work item: `71`, `PJAN-71`, or `pjan-71`. Wins over `branch`. */
  ref?: string;
  /** Branch name to mine for a ticket reference when `ref` is absent. */
  branch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Where the Hermes template keeps `[plane] base`.
 *
 * NOTE: twin of `resolveTemplateConfigPath` in
 * `src/commands/hermes/EnsureTemplateConfig.ts`. That module cannot be
 * imported here without dragging the command layer into the prompt bundle.
 * `tests/pjan-72-regressions.mjs` carries a drift tripwire on the pair.
 */
export function resolveTemplateConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(home, ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

/**
 * Read `key` from `[section]` of a small TOML file.
 *
 * Scoped to exactly what this module needs — two string scalars out of a
 * generated config. Not a TOML parser, and deliberately not pretending to be
 * one: anything it cannot confidently read comes back undefined and the caller
 * falls through to a default.
 */
export function readTomlScalar(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = line === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted) return quoted[1] ?? quoted[2];
    const bare = (value.split("#")[0] ?? "").trim();
    return bare || undefined;
  }
  return undefined;
}

function readTemplateConfig(env: NodeJS.ProcessEnv, home: string): string | undefined {
  try {
    const path = resolveTemplateConfigPath(env, home);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plane instance base URL.
 *
 * Precedence mirrors the shell adapter at
 * `agents/hermes/pm/.scripts/providers/plane.sh:22` — env override first, then
 * the generated template config, then the fleet default — so the CLI and the
 * PM agent can never disagree about which Plane they are talking to.
 */
export function planeBase(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.PLANE_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const config = readTemplateConfig(env, home);
  const fromConfig = config ? readTomlScalar(config, "plane", "base")?.trim() : undefined;
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  return DEFAULT_PLANE_BASE;
}

function planeWorkspace(provider: TicketProviderFacts, env: NodeJS.ProcessEnv, home: string): string | undefined {
  const fromManifest = provider.workspace?.trim();
  if (fromManifest) return fromManifest;
  const config = readTemplateConfig(env, home);
  const fromConfig = config ? readTomlScalar(config, "plane", "workspace")?.trim() : undefined;
  return fromConfig || DEFAULT_PLANE_WORKSPACE;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull a ticket reference out of a branch name.
 *
 * `fix/PJAN-67-mcp-fail-closed` → `PJAN-67`. CLAUDE.md already requires branch
 * names to carry a ticket reference, so this is the common path rather than a
 * clever edge case.
 *
 * The `\b` before the identifier is what keeps `XPJAN-3` from reading as
 * `PJAN-3`, and requiring a literal `-` after it keeps `PJANX-3` out too.
 */
export function extractTicketRef(branch: string | undefined, identifier: string | undefined): string | undefined {
  if (!branch || !identifier) return undefined;
  const ident = identifier.trim();
  if (!ident) return undefined;
  const match = new RegExp(`\\b${escapeRegExp(ident)}-(\\d+)\\b`, "i").exec(branch);
  return match ? `${ident.toUpperCase()}-${match[1]}` : undefined;
}

/**
 * Normalize user input into a work-item reference.
 *
 * A bare number is completed with this project's identifier. A fully-qualified
 * reference is accepted as-is even when its prefix belongs to another
 * project — Plane's browse route is workspace-scoped, not project-scoped, so
 * `board DECK-21` resolves correctly from inside the pjangler repo.
 */
export function normalizeTicketRef(input: string | undefined, identifier: string | undefined): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const ident = identifier?.trim();
    return ident ? `${ident.toUpperCase()}-${value}` : undefined;
  }
  const qualified = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(value);
  if (!qualified) return undefined;
  return `${qualified[1]!.toUpperCase()}-${qualified[2]!}`;
}

/** Explicit ref beats branch inference beats nothing. */
export function resolveTicketRef(provider: TicketProviderFacts, options: BoardUrlOptions): string | undefined {
  return (
    normalizeTicketRef(options.ref, provider.identifier) ??
    extractTicketRef(options.branch, provider.identifier)
  );
}

/**
 * Board URL, or the URL of one work item on it.
 *
 * Route shapes were read off the live instance's router manifest rather than
 * its documentation:
 *   `:workspaceSlug/browse/:workItem`
 *   `:workspaceSlug/projects/:projectId/issues`
 *
 * Returns undefined rather than guessing when there is no board to point at.
 */
export function boardUrl(provider: TicketProviderFacts | undefined, options: BoardUrlOptions = {}): string | undefined {
  if (!provider) return undefined;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const type = (provider.type || "plane").trim().toLowerCase();
  const boardId = provider.board_id?.trim();
  if (!boardId) return undefined;

  if (type === "trello") {
    // Trello addresses cards by an opaque short id, not by `<IDENT>-<n>`, so a
    // ticket reference cannot be resolved to a card without an API round trip.
    // Opening the board is the honest answer; silently ignoring the ref would
    // not be.
    return `https://trello.com/b/${boardId}`;
  }
  if (type !== "plane") return undefined;

  const workspace = planeWorkspace(provider, env, home);
  if (!workspace) return undefined;
  const base = planeBase(env, home);
  const ref = resolveTicketRef(provider, options);
  return ref
    ? `${base}/${workspace}/browse/${ref}`
    : `${base}/${workspace}/projects/${boardId}/issues`;
}

/** Nearest ancestor holding a `.project.json`, starting at `from`. */
export function findProjectRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The `ticket_provider` block, or undefined when absent or unreadable. */
export function readTicketProvider(root: string): TicketProviderFacts | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".project.json"), "utf8")) as Record<string, unknown>;
    const provider = manifest.ticket_provider;
    if (!provider || typeof provider !== "object") return undefined;
    return provider as TicketProviderFacts;
  } catch {
    return undefined;
  }
}

/**
 * Current branch, read straight out of `.git/HEAD`.
 *
 * No subprocess: this runs on the shell-prompt path, where spawning git would
 * cost more than everything else here combined. Handles the `.git`-as-a-file
 * form used by worktrees and submodules. A detached HEAD has no branch, so
 * there is no reference to mine and undefined is the truthful answer.
 */
export function currentBranch(from: string): string | undefined {
  try {
    let dir = resolve(from);
    for (;;) {
      const dotgit = join(dir, ".git");
      if (existsSync(dotgit)) {
        let gitDir = dotgit;
        if (statSync(dotgit).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
          if (!pointer) return undefined;
          const target = pointer[1]!.trim();
          gitDir = isAbsolute(target) ? target : resolve(dir, target);
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1]!.trim() : undefined;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * Full resolution from a working directory: the URL this project's prompt
 * segment points at.
 */
export function resolveBoardUrl(cwd: string, ref?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = findProjectRoot(cwd);
  if (!root) return undefined;
  const provider = readTicketProvider(root);
  if (!provider) return undefined;
  return boardUrl(provider, { ref, branch: currentBranch(root), env });
}
