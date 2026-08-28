// Board identity reconciliation — ask the provider what a board is actually
// called, and repair every store that guessed.
//
// For months four code paths INVENTED a board identifier from a string slice
// (`slug.slice(0, 4).toUpperCase()`) and none of them read back what Plane
// actually assigned. `HOLPM` was never a board; Plane calls that board `HOLOC`.
// The minters are gone (see `proposeProjectIdentifier`); this module is the
// repair crew for what they already wrote.
//
// Two stores drifted and both are fixed here:
//
//   ~/.hermes/agents-registry.yaml   the fleet projection n8n reads UNCACHED on
//                                    every webhook execution — a wrong
//                                    identifier here misroutes live traffic.
//   ~/.config/pjangler/projects.yaml the registration SSOT.
//
// The repo-local `.project.json` is authoritative-on-read for a board binding
// and is deliberately NEVER touched: a bulk rewrite of 25 manifests is exactly
// the class of blast radius that created this mess.

import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { planeBase, DEFAULT_PLANE_WORKSPACE } from "./boardUrl";
import { BoardError, resolvePlaneApiKey } from "./boardQuery";
import {
  loadProjectRegistry,
  projectRegistryPath,
  saveProjectRegistry,
  type ProjectRegistry,
} from "./index";
import { PJANGLER_VERSION } from "../utils/version";

/**
 * Agents whose Plane board 404s in EVERY workspace. These are abandoned, not
 * broken: there is nothing to triage and nothing to re-resolve, so `--apply`
 * deletes their registry entries outright rather than modelling a permanently
 * unresolvable state.
 */
export const DEAD_AGENT_IDS = ["coachingagentframework-pm", "tonnybox-pm"] as const;

export interface PlaneBoardFacts {
  id: string;
  /** The identifier PLANE assigned. The only authority on this value. */
  identifier: string;
  name: string;
  workspace: string;
}

/** One agent's board binding as the fleet registry currently records it. */
export interface HermesAgentBoard {
  agentId: string;
  repo: string;
  projectPath: string;
  workspace: string;
  boardId: string;
  /** What the registry claims today — possibly an invention. */
  identifier: string;
}

export type IdentityStatus =
  | "ok"
  | "drift"
  | "dead"
  | "no-board"
  | "board-missing"
  | "error";

export interface IdentityResolution {
  agentId: string;
  workspace: string;
  boardId: string;
  currentIdentifier: string;
  liveIdentifier?: string;
  boardName?: string;
  status: IdentityStatus;
  detail?: string;
  /** pjangler registry slug this agent's repo maps to, when one exists. */
  slug?: string;
}

export interface IdentityChange {
  agentId?: string;
  slug?: string;
  field: string;
  from: string;
  to: string;
}

export interface IdentityReport {
  ok: boolean;
  apply: boolean;
  hermesRegistryPath: string;
  registryPath: string;
  checked: number;
  resolutions: IdentityResolution[];
  changes: {
    hermes: IdentityChange[];
    hermesDeleted: string[];
    projects: IdentityChange[];
  };
  errors: string[];
}

export interface IdentityOptions {
  hermesRegistryPath?: string;
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  apply?: boolean;
  /** Single project slug / agent id / repo name. Ignored when `all` is set. */
  target?: string;
  all?: boolean;
  now?: Date;
  /** Test seam: resolve a workspace's boards without touching the network. */
  fetchBoards?: (workspace: string) => Promise<Map<string, PlaneBoardFacts>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hermesAgentsRegistryPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.HERMES_AGENTS_REGISTRY?.trim();
  return override || join(home, ".hermes", "agents-registry.yaml");
}

// ---------------------------------------------------------------------------
// Plane reads
// ---------------------------------------------------------------------------

/**
 * The API key for a workspace.
 *
 * `resolvePlaneApiKey` derives a per-workspace variable name, but this Plane
 * instance is one deployment with one personal token: `automaticai` has no
 * `PLANE_AUTOMATICAI_API_KEY` and never will. Fall back to the default
 * workspace's key rather than reporting every automaticai board unresolvable.
 */
function planeApiKeyFor(workspace: string, env: NodeJS.ProcessEnv, home: string): string | undefined {
  return resolvePlaneApiKey(workspace, env, home) ?? resolvePlaneApiKey(DEFAULT_PLANE_WORKSPACE, env, home);
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** Every board in a workspace, keyed by board id. */
export async function fetchPlaneBoards(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<Map<string, PlaneBoardFacts>> {
  const apiKey = planeApiKeyFor(workspace, env, home);
  if (!apiKey) {
    throw new BoardError(
      `no Plane API key for workspace "${workspace}": set PLANE_API_KEY, or add one to ` +
        `${env.HERMES_FLEET_ENV?.trim() || join(home, ".hermes", "fleet.env")}`,
    );
  }
  const base = planeBase(env, home);
  const boards = new Map<string, PlaneBoardFacts>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${base}/api/v1/workspaces/${encodeURIComponent(workspace)}/projects/`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "X-API-Key": apiKey, "User-Agent": `pjangler/${PJANGLER_VERSION}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new BoardError(
        `could not reach Plane at ${base} for workspace "${workspace}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!response.ok) {
      throw new BoardError(`Plane returned ${response.status} listing workspace "${workspace}" projects`);
    }
    const body: unknown = await response.json();
    const results = isRecord(body) && Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : [];
    for (const entry of results) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === "string" ? entry.id : "";
      const identifier = typeof entry.identifier === "string" ? entry.identifier.trim() : "";
      if (!id || !identifier) continue;
      boards.set(id, { id, identifier, name: typeof entry.name === "string" ? entry.name : "", workspace });
    }
    const more = isRecord(body) && body.next_page_results === true;
    cursor = isRecord(body) && typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    if (!more || !cursor) return boards;
  }
  return boards;
}

// ---------------------------------------------------------------------------
// Fleet registry reads
// ---------------------------------------------------------------------------

/** Every agent in the fleet registry, whether or not it carries a board. */
export function readHermesAgentBoards(path: string): HermesAgentBoard[] {
  const document = YAML.parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length) throw new Error(`Hermes agents registry YAML is invalid: ${path}`);
  const parsed = document.toJS() as unknown;
  const agents = isRecord(parsed) && isRecord(parsed.agents) ? parsed.agents : {};
  const boards: HermesAgentBoard[] = [];
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!isRecord(agent)) continue;
    const plane = isRecord(agent.plane) ? agent.plane : {};
    boards.push({
      agentId,
      repo: typeof agent.repo === "string" ? agent.repo : "",
      projectPath: typeof agent.project_path === "string" ? agent.project_path : "",
      workspace: typeof plane.workspace === "string" ? plane.workspace : "",
      boardId: typeof plane.project_id === "string" ? plane.project_id : "",
      identifier: typeof plane.identifier === "string" ? plane.identifier : "",
    });
  }
  return boards;
}

/** The pjangler slug this agent's repository is registered under, if any. */
function matchRegistrySlug(agent: HermesAgentBoard, registry: ProjectRegistry): string | undefined {
  if (agent.projectPath) {
    const wanted = resolve(agent.projectPath);
    for (const [slug, project] of Object.entries(registry.projects)) {
      if (project?.repo_path && resolve(project.repo_path) === wanted) return slug;
    }
  }
  if (agent.repo && Object.hasOwn(registry.projects, agent.repo)) return agent.repo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Surgical fleet-registry write
// ---------------------------------------------------------------------------

/** Identifiers safe to emit unquoted, so a repaired value reads like its peers. */
const PLAIN_SCALAR = /^[A-Za-z][A-Za-z0-9_-]*$|^[0-9]+[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Re-serialization defaults are not neutral. The `yaml` package indents block
 * sequences by default; this file does not, and a whole-document round-trip
 * would silently reindent an untouched list. Match what the file already does
 * and never fold a long path onto a second line.
 */
function yamlStyleOf(original: string): { indentSeq: boolean; lineWidth: number } {
  return { indentSeq: !/\n([ \t]*)[^\s#][^\n]*:[ \t]*\n\1- /.test(original), lineWidth: 0 };
}

function atomicWrite(path: string, text: string): void {
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  mkdirSync(dirname(path), { recursive: true });
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
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* keep the original error */ }
    try { unlinkSync(temp); } catch { /* keep the original error */ }
    throw error;
  }
}

/**
 * Rewrite ONLY `agents.<id>.plane.identifier`, and delete the named dead
 * agents. Every other key, every comment, and the file's formatting survive:
 * this file is hand-maintained and a `safe_dump` round-trip would sort its keys
 * and destroy it.
 */
export function applyHermesIdentifiers(
  path: string,
  identifiers: Map<string, string>,
  deletions: readonly string[],
): { changed: boolean; agentCount: number } {
  const original = readFileSync(path, "utf8");
  const document = YAML.parseDocument(original);
  if (document.errors.length) throw new Error(`Hermes agents registry YAML is invalid: ${path}`);
  const before = document.toJS() as Record<string, unknown>;
  const beforeAgents = isRecord(before.agents) ? before.agents : {};
  const expectedCount = Object.keys(beforeAgents).length - deletions.filter((id) => Object.hasOwn(beforeAgents, id)).length;

  for (const [agentId, identifier] of identifiers) {
    const nodePath = ["agents", agentId, "plane", "identifier"];
    const node = document.getIn(nodePath, true) as unknown;
    if (YAML.isScalar(node)) {
      node.value = identifier;
      // An identifier that was `''` keeps a single-quote style it no longer
      // needs; let the stringifier pick the plain form its neighbours use.
      if (PLAIN_SCALAR.test(identifier)) node.type = undefined;
    } else {
      document.setIn(nodePath, identifier);
    }
  }
  for (const agentId of deletions) document.deleteIn(["agents", agentId]);

  const text = document.toString(yamlStyleOf(original));
  // Prove the surgery before it reaches disk: the resulting document must equal
  // the original with exactly these identifier substitutions and deletions.
  const expected = structuredClone(before) as Record<string, unknown>;
  const expectedAgents = isRecord(expected.agents) ? expected.agents : {};
  for (const [agentId, identifier] of identifiers) {
    const agent = expectedAgents[agentId];
    if (isRecord(agent) && isRecord(agent.plane)) agent.plane.identifier = identifier;
  }
  for (const agentId of deletions) delete expectedAgents[agentId];
  const after = YAML.parse(text) as Record<string, unknown>;
  const afterAgents = isRecord(after.agents) ? after.agents : {};
  if (Object.keys(afterAgents).length !== expectedCount) {
    throw new Error(
      `refusing to write ${path}: agent count changed from ${expectedCount} to ${Object.keys(afterAgents).length}`,
    );
  }
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error(`refusing to write ${path}: the edit changed more than the targeted identifiers`);
  }
  if (text === original) return { changed: false, agentCount: expectedCount };
  atomicWrite(path, text);
  return { changed: true, agentCount: expectedCount };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function inScope(agent: HermesAgentBoard, slug: string | undefined, options: IdentityOptions): boolean {
  if (options.all || !options.target) return true;
  const target = options.target;
  return agent.agentId === target || agent.repo === target || slug === target;
}

export async function reconcileProjectIdentity(options: IdentityOptions = {}): Promise<IdentityReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const hermesRegistryPath = options.hermesRegistryPath ?? hermesAgentsRegistryPath(env, home);
  const registryPath = resolve(options.registryPath ?? projectRegistryPath(env));
  const apply = options.apply ?? false;
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const errors: string[] = [];

  const agents = readHermesAgentBoards(hermesRegistryPath);
  const registry = loadProjectRegistry(registryPath);

  const scoped = agents
    .map((agent) => ({ agent, slug: matchRegistrySlug(agent, registry) }))
    .filter(({ agent, slug }) => inScope(agent, slug, options));

  // One list call per workspace beats 30 board lookups, and it is the only way
  // to tell "this board is gone" from "this board is in another workspace".
  const workspaces = [...new Set(scoped.map(({ agent }) => agent.workspace).filter(Boolean))];
  const boardsByWorkspace = new Map<string, Map<string, PlaneBoardFacts>>();
  for (const workspace of workspaces) {
    try {
      const fetcher = options.fetchBoards ?? ((ws: string) => fetchPlaneBoards(ws, env, home));
      boardsByWorkspace.set(workspace, await fetcher(workspace));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const resolutions: IdentityResolution[] = [];
  const hermesIdentifiers = new Map<string, string>();
  const hermesChanges: IdentityChange[] = [];
  const projectChanges: IdentityChange[] = [];
  const deletions: string[] = [];

  for (const { agent, slug } of scoped) {
    const base = {
      agentId: agent.agentId,
      workspace: agent.workspace,
      boardId: agent.boardId,
      currentIdentifier: agent.identifier,
      ...(slug ? { slug } : {}),
    };
    if ((DEAD_AGENT_IDS as readonly string[]).includes(agent.agentId)) {
      deletions.push(agent.agentId);
      resolutions.push({ ...base, status: "dead", detail: "abandoned agent; entry removed from the fleet registry" });
      continue;
    }
    if (!agent.boardId) {
      resolutions.push({ ...base, status: "no-board", detail: "no plane.project_id recorded" });
      continue;
    }
    const boards = boardsByWorkspace.get(agent.workspace);
    if (!boards) {
      // A failed workspace fetch PRESERVES what is recorded. Blanking an
      // identifier because the network blinked is how a projection loses data.
      resolutions.push({ ...base, status: "error", detail: `workspace "${agent.workspace}" could not be listed; value preserved` });
      continue;
    }
    const board = boards.get(agent.boardId);
    if (!board) {
      resolutions.push({ ...base, status: "board-missing", detail: `board ${agent.boardId} not in workspace "${agent.workspace}"; value preserved` });
      continue;
    }
    const live = board.identifier;
    const drift = live !== agent.identifier;
    resolutions.push({ ...base, liveIdentifier: live, boardName: board.name, status: drift ? "drift" : "ok" });
    if (drift) {
      hermesIdentifiers.set(agent.agentId, live);
      hermesChanges.push({ agentId: agent.agentId, field: "plane.identifier", from: agent.identifier, to: live });
    }

    if (!slug) continue;
    const project = registry.projects[slug];
    const provider = project?.ticket_provider;
    if (!provider || provider.type !== "plane") continue;
    const recordWorkspace = (provider.workspace ?? "").trim();
    if (recordWorkspace && recordWorkspace.toLowerCase() !== agent.workspace.toLowerCase()) {
      // Stamping a provider identifier onto a record that claims a DIFFERENT
      // workspace would just relocate the lie. Report it and leave it alone.
      errors.push(
        `${slug}: registry workspace "${recordWorkspace}" disagrees with the fleet's "${agent.workspace}" for ${agent.agentId}; ` +
          `identifier ${live} not written`,
      );
      continue;
    }
    if (provider.identifier !== live) {
      projectChanges.push({ slug, field: "ticket_provider.identifier", from: provider.identifier ?? "", to: live });
    }
    if (provider.identifier_source !== "provider") {
      projectChanges.push({ slug, field: "ticket_provider.identifier_source", from: provider.identifier_source ?? "", to: "provider" });
    }
    const nextState = provider.board_id ? "linked" : provider.state ?? "planned";
    if (provider.state !== nextState) {
      projectChanges.push({ slug, field: "ticket_provider.state", from: provider.state ?? "", to: nextState });
    }
    if (apply) {
      provider.identifier = live;
      provider.identifier_source = "provider";
      provider.identifier_fetched_at = fetchedAt;
      provider.state = nextState;
    }
  }

  if (apply) {
    if (hermesIdentifiers.size || deletions.length) {
      applyHermesIdentifiers(hermesRegistryPath, hermesIdentifiers, deletions);
    }
    if (projectChanges.length) saveProjectRegistry(registry, registryPath);
  }

  return {
    ok: errors.length === 0,
    apply,
    hermesRegistryPath,
    registryPath,
    checked: scoped.length,
    resolutions,
    changes: { hermes: hermesChanges, hermesDeleted: deletions, projects: projectChanges },
    errors,
  };
}

const STATUS_LABEL: Record<IdentityStatus, string> = {
  ok: "ok",
  drift: "DRIFT",
  dead: "DEAD",
  "no-board": "no board",
  "board-missing": "404",
  error: "error",
};

export function formatIdentityReport(report: IdentityReport): string {
  const lines: string[] = [""];
  const width = Math.max(...report.resolutions.map((r) => r.agentId.length), 10);
  for (const item of report.resolutions) {
    const arrow = item.liveIdentifier && item.liveIdentifier !== item.currentIdentifier
      ? `${item.currentIdentifier || "''"} -> ${item.liveIdentifier}`
      : (item.liveIdentifier ?? item.currentIdentifier) || "''";
    lines.push(
      `  ${STATUS_LABEL[item.status].padEnd(9)} ${item.agentId.padEnd(width)}  ${arrow}` +
        (item.slug ? `  [${item.slug}]` : "") +
        (item.detail ? `  ${item.detail}` : ""),
    );
  }
  lines.push("");
  const verb = report.apply ? "applied" : "pending";
  lines.push(`  fleet registry: ${report.changes.hermes.length} identifier fix(es) ${verb}, ${report.changes.hermesDeleted.length} dead agent(s) removed`);
  lines.push(`  project registry: ${report.changes.projects.length} field change(s) ${verb}`);
  if (!report.apply) lines.push(`  dry run — re-run with --apply to write`);
  for (const error of report.errors) lines.push(`  ! ${error}`);
  lines.push("");
  return lines.join("\n");
}
