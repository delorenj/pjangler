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
import { BoardError, dotenvValue, resolvePlaneApiKey, resolveSecretValue } from "./boardQuery";
import {
  loadProjectRegistry,
  projectRegistryPath,
  saveProjectRegistry,
  type ProjectRegistry,
  type ProjectTicketProvider,
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

/** What reconciliation concluded about one project registry record. */
export type ProjectIdentityStatus =
  /** Bound to a board the provider confirmed exists, under its real key. */
  | "linked"
  /** No board. The identifier, if any, is labelled a proposal. */
  | "planned"
  /** The recorded board is gone from every workspace; the binding was cleared. */
  | "unlinked"
  /** Nothing could be verified (outage, missing credential); nothing was written. */
  | "preserved"
  /** A ticket provider this command does not speak. Left entirely alone. */
  | "skipped";

export interface ProjectResolution {
  slug: string;
  type: string;
  workspace: string;
  boardId: string;
  identifier: string;
  identifierSource: string;
  status: ProjectIdentityStatus;
  detail?: string;
}

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
  /** Fleet agents examined. */
  checked: number;
  /** Project registry records examined. */
  projectsChecked: number;
  resolutions: IdentityResolution[];
  projects: ProjectResolution[];
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
  /** Test seam: confirm a Trello board without touching the network. */
  fetchTrelloBoard?: (boardId: string) => Promise<TrelloBoardFacts | null>;
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
// Trello reads
// ---------------------------------------------------------------------------

export interface TrelloBoardFacts {
  id: string;
  name: string;
  closed: boolean;
}

function trelloCredential(name: string, env: NodeJS.ProcessEnv, home: string): string | undefined {
  const fleetEnv = env.HERMES_FLEET_ENV?.trim() || join(home, ".hermes", "fleet.env");
  const raw = env[name]?.trim() || dotenvValue(fleetEnv, name)?.trim();
  return raw ? resolveSecretValue(raw) : undefined;
}

/**
 * Does this Trello board still exist?
 *
 * Trello has no notion of a board "identifier" — the short key on a Trello
 * record is a local prefix, not something the provider assigns. So the only
 * question the provider can answer is whether the BOARD is real, and that
 * answer is what a Trello link rests on.
 *
 * `null` means gone (or invisible to these credentials, which is the same
 * thing operationally). A thrown error means "could not tell" and must leave
 * the record exactly as it was.
 */
export async function fetchTrelloBoard(
  boardId: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<TrelloBoardFacts | null> {
  const key = trelloCredential("TRELLO_API_KEY", env, home);
  const token = trelloCredential("TRELLO_TOKEN", env, home);
  if (!key || !token) {
    throw new BoardError("no Trello credentials: set TRELLO_API_KEY and TRELLO_TOKEN (env or ~/.hermes/fleet.env)");
  }
  // The token rides in the query string, so no failure path may quote this URL.
  const url = new URL(`https://api.trello.com/1/boards/${encodeURIComponent(boardId)}`);
  url.searchParams.set("fields", "id,name,closed");
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": `pjangler/${PJANGLER_VERSION}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new BoardError(
      `could not reach Trello for board ${boardId}: ` + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new BoardError(`Trello returned ${response.status} for board ${boardId}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new BoardError(`Trello returned an unreadable board payload for ${boardId}`);
  }
  return {
    id: body.id,
    name: typeof body.name === "string" ? body.name : "",
    closed: body.closed === true,
  };
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

/** The board binding a repository's own `.project.json` records. READ ONLY. */
export interface ManifestBoard {
  type: string;
  boardId: string;
  workspace: string;
  /** The key the manifest claims, which may be a proposal nobody confirmed. */
  identifier: string;
  /** Provenance of that key. Absent on a legacy manifest, i.e. a proposal. */
  identifierSource: string;
}

/**
 * A repo's `.project.json` board binding.
 *
 * This file is authoritative-on-read and is NEVER written back: a bulk rewrite
 * of 25 manifests is exactly the blast radius that created the drift this
 * command exists to repair. It is consulted only to recover a `board_id` the
 * registry lost.
 */
export function readManifestBoard(repoPath: string): ManifestBoard | undefined {
  if (!repoPath) return undefined;
  const path = join(repoPath, ".project.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.ticket_provider)) return undefined;
  const provider = parsed.ticket_provider;
  return {
    type: typeof provider.type === "string" ? provider.type : "",
    boardId: typeof provider.board_id === "string" ? provider.board_id.trim() : "",
    workspace: typeof provider.workspace === "string" ? provider.workspace.trim() : "",
    identifier: typeof provider.identifier === "string" ? provider.identifier.trim() : "",
    identifierSource: typeof provider.identifier_source === "string" ? provider.identifier_source.trim() : "",
  };
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
// Project registry reconciliation
// ---------------------------------------------------------------------------

/**
 * Where a record's board id may be recovered from, in priority order:
 *
 *   1. what the record already claims;
 *   2. the repo's own `.project.json` — authoritative-on-read;
 *   3. a fleet agent whose `project_path` is this repo.
 *
 * Matching a project to a board by NAME or by identifier string is deliberately
 * absent. That is guessing, and guessing is what wrote `HOLPM`, `JAME` and
 * `AGEN` into these files in the first place. A record whose board cannot be
 * recovered from one of these three bindings stays honestly unbound.
 */
function candidateBoardIds(
  provider: ProjectTicketProvider,
  repoPath: string,
  fleetBoards: Map<string, string>,
): string[] {
  const type = (provider.type ?? "").trim();
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push(provider.board_id);
  const manifest = repoPath ? readManifestBoard(repoPath) : undefined;
  // A Trello board id in a Plane record is not a recovery, it is a category
  // error — only take a manifest binding whose provider matches the record's.
  if (manifest && (!manifest.type || manifest.type === type)) push(manifest.boardId);
  if (type === "plane" && repoPath) push(fleetBoards.get(resolve(repoPath)));
  return candidates;
}

/** Every live board identifier in a workspace, upper-cased, to the board that owns it. */
function liveKeyIndex(boards: Map<string, PlaneBoardFacts>): Map<string, PlaneBoardFacts> {
  const index = new Map<string, PlaneBoardFacts>();
  for (const board of boards.values()) index.set(board.identifier.toUpperCase(), board);
  return index;
}

/** What a hint pass concluded. `board` and `refusal` are mutually exclusive. */
interface HintMatch {
  board?: PlaneBoardFacts;
  /** Why an otherwise-plausible hint was NOT acted on. */
  refusal?: string;
}

/**
 * Recover a board for a record that carries no binding anywhere.
 *
 * `candidateBoardIds` only ever follows a RECORDED id. That is the right
 * default and it is why 24 of these records are correct today, but it strands
 * a record whose id was never written down even when the live board is
 * unmistakable — `momo`'s board is called "Momo" and nothing else in Plane is.
 *
 * Two hints are honoured, and only two:
 *
 *   1. an identifier in the repo's `.project.json` that the manifest itself
 *      stamps `identifier_source: provider`;
 *   2. a live board NAME equal, case-insensitively and exactly, to the record's
 *      slug or its name.
 *
 * An UNSTAMPED manifest identifier is deliberately not a hint. Those keys are
 * overwhelmingly `slug.slice(0, 4).toUpperCase()` output, and taking them at
 * face value is not a repair, it is the original bug with a new entry point:
 * `docsidian`'s manifest says `DOCS`, and Plane's `DOCS` is DeloDocs.
 *
 * There are 69 boards and 25 records. A hint that matches more than one board
 * is refused out loud rather than resolved by tie-break — under those odds a
 * coin flip is a wrong link roughly half the time, and a wrong link routes
 * someone else's tickets.
 */
function resolveBoardByHint(
  ctx: ProjectPassContext,
  slug: string,
  project: { name?: string; repo_path?: string },
  provider: ProjectTicketProvider,
): HintMatch {
  const matches = (predicate: (board: PlaneBoardFacts) => boolean): PlaneBoardFacts[] => {
    const found: PlaneBoardFacts[] = [];
    for (const boards of ctx.boardsByWorkspace.values()) {
      for (const board of boards.values()) if (predicate(board)) found.push(board);
    }
    return found;
  };
  const describe = (boards: PlaneBoardFacts[]): string =>
    boards.map((board) => `${board.workspace}/${board.identifier} "${board.name}"`).join(", ");

  const manifest = project.repo_path ? readManifestBoard(project.repo_path) : undefined;
  const claimedKey =
    manifest && manifest.identifierSource === "provider" && (!manifest.type || manifest.type === provider.type)
      ? manifest.identifier.toUpperCase()
      : "";
  if (claimedKey) {
    const byKey = matches((board) => board.identifier.toUpperCase() === claimedKey);
    if (byKey.length === 1) return { board: byKey[0] };
    if (byKey.length > 1) {
      return { refusal: `.project.json identifier ${claimedKey} matches ${byKey.length} boards (${describe(byKey)})` };
    }
  }

  const names = new Set(
    [slug, project.name ?? ""].map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (!names.size) return {};
  const byName = matches((board) => names.has(board.name.trim().toLowerCase()));
  const unique = new Map(byName.map((board) => [`${board.workspace} ${board.id}`, board]));
  if (unique.size === 1) return { board: [...unique.values()][0] };
  if (unique.size > 1) {
    return { refusal: `board name matches ${unique.size} boards (${describe([...unique.values()])})` };
  }
  return {};
}

interface ProjectPassContext {
  registry: ProjectRegistry;
  boardsByWorkspace: Map<string, Map<string, PlaneBoardFacts>>;
  /** A workspace failed to list, so no Plane conclusion may be drawn at all. */
  planeDegraded: boolean;
  fleetBoards: Map<string, string>;
  fetchTrello: (boardId: string) => Promise<TrelloBoardFacts | null>;
  fetchedAt: string;
  apply: boolean;
  changes: IdentityChange[];
  errors: string[];
}

function noteChange(ctx: ProjectPassContext, slug: string, field: string, from: unknown, to: unknown): void {
  const before = from === undefined ? "" : String(from);
  const after = to === undefined ? "" : String(to);
  if (before === after) return;
  ctx.changes.push({ slug, field: `ticket_provider.${field}`, from: before, to: after });
}

/**
 * Demote a record to "no confirmed board".
 *
 * An identifier survives only as a labelled PROPOSAL, and not even that when it
 * collides with a live board key: an unconfirmed string that happens to equal a
 * real board's identifier is indistinguishable from a confirmed one at routing
 * time, which is precisely how `docsidian` came to sit on DeLoDocs' `DOCS`.
 */
function demoteToPlanned(
  ctx: ProjectPassContext,
  slug: string,
  provider: ProjectTicketProvider,
  detail: string,
  status: ProjectIdentityStatus,
): ProjectResolution {
  const workspace = (provider.workspace ?? "").trim();
  const identifier = (provider.identifier ?? "").trim();
  const live = ctx.boardsByWorkspace.get(workspace);
  const collision = identifier && live ? liveKeyIndex(live).get(identifier.toUpperCase()) : undefined;

  const nextBoardId = "";
  // An operator's explicit "skipped" is a decision, not drift. Never undo it.
  const nextState = provider.state === "skipped" ? "skipped" : "planned";
  const nextIdentifier = collision ? "" : identifier;
  const nextSource = nextIdentifier ? "proposed" : undefined;

  noteChange(ctx, slug, "board_id", provider.board_id, nextBoardId);
  noteChange(ctx, slug, "state", provider.state, nextState);
  noteChange(ctx, slug, "identifier", provider.identifier, nextIdentifier);
  noteChange(ctx, slug, "identifier_source", provider.identifier_source, nextSource ?? "");
  noteChange(ctx, slug, "identifier_fetched_at", provider.identifier_fetched_at, "");
  noteChange(ctx, slug, "board_confirmed_at", provider.board_confirmed_at, "");

  if (ctx.apply) {
    provider.board_id = nextBoardId;
    provider.state = nextState;
    provider.identifier = nextIdentifier;
    if (nextSource) provider.identifier_source = nextSource;
    else delete provider.identifier_source;
    // Nothing was read back from a provider, so no read instant may be claimed.
    delete provider.identifier_fetched_at;
    // …and there is no board left to have confirmed.
    delete provider.board_confirmed_at;
  }

  return {
    slug,
    type: provider.type ?? "",
    workspace,
    boardId: "",
    identifier: nextIdentifier,
    identifierSource: nextSource ?? "",
    status,
    detail: collision
      ? `${detail}; identifier ${identifier} dropped — ${workspace}/${collision.identifier} belongs to "${collision.name}"`
      : detail,
  };
}

/**
 * When to stamp `identifier_fetched_at`.
 *
 * The field records when this identity was ESTABLISHED by a provider read, not
 * when the provider was last polled. Re-stamping an unchanged value on every
 * run would make reconciliation rewrite the SSOT forever and leave it with no
 * fixed point, which is the opposite of what an idempotent repair is for.
 */
function stampFor(existing: string | undefined, changed: boolean, now: string): string {
  return changed || !existing ? now : existing;
}

/** Leave a record untouched and say why it could not be judged. */
function preserve(slug: string, provider: ProjectTicketProvider, detail: string): ProjectResolution {
  return {
    slug,
    type: provider.type ?? "",
    workspace: (provider.workspace ?? "").trim(),
    boardId: (provider.board_id ?? "").trim(),
    identifier: (provider.identifier ?? "").trim(),
    identifierSource: provider.identifier_source ?? "",
    status: "preserved",
    detail,
  };
}

async function reconcileOneProject(
  ctx: ProjectPassContext,
  slug: string,
  claimed: Map<string, string>,
): Promise<ProjectResolution> {
  const project = ctx.registry.projects[slug];
  const provider = project?.ticket_provider;
  if (!provider || typeof provider !== "object") {
    return { slug, type: "", workspace: "", boardId: "", identifier: "", identifierSource: "", status: "skipped", detail: "no ticket_provider block" };
  }
  const type = (provider.type ?? "").trim();
  if (type !== "plane" && type !== "trello") {
    return preserve(slug, provider, `ticket provider "${type || "(none)"}" is not reconciled by this command`);
  }
  // A half-repaired registry with no record of which half is worse than an
  // unrepaired one, so an incomplete view of Plane parks every Plane record.
  if (type === "plane" && ctx.planeDegraded) {
    return preserve(slug, provider, "a Plane workspace could not be listed; nothing written");
  }

  const unclaimed = (candidate: string): boolean => {
    const owner = claimed.get(`${type}\u0000${candidate}`);
    return !owner || owner === slug;
  };
  const candidates = candidateBoardIds(provider, project.repo_path ?? "", ctx.fleetBoards).filter(unclaimed);
  let boardId = candidates[0];
  let recovered = "";

  // No id was ever written down for this record. Before declaring it unbound,
  // ask whether the provider is holding a board this record unmistakably names
  // — which is what `momo` (a live board called "Momo") and `agentboard`
  // (ABRD, called "AgentBoard") needed, and what neither the record, nor its
  // manifest, nor the fleet could supply.
  if (!boardId && type === "plane" && provider.state !== "skipped") {
    const hint = resolveBoardByHint(ctx, slug, project, provider);
    if (hint.refusal) {
      ctx.errors.push(`${slug}: ${hint.refusal}; refusing to choose — record the board id in .project.json and re-run`);
      return demoteToPlanned(ctx, slug, provider, `${hint.refusal}; refused rather than guessed`, "planned");
    }
    if (hint.board && unclaimed(hint.board.id)) {
      boardId = hint.board.id;
      recovered = ", recovered by an exact match on this record's own name";
    }
  }

  if (!boardId) {
    return demoteToPlanned(ctx, slug, provider, "no board binding in the record, its .project.json, or the fleet", "planned");
  }

  if (type === "trello") {
    let board: TrelloBoardFacts | null;
    try {
      board = await ctx.fetchTrello(boardId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.errors.push(`${slug}: ${detail}`);
      return preserve(slug, provider, `${detail}; nothing written`);
    }
    if (!board || board.closed) {
      return demoteToPlanned(ctx, slug, provider, `Trello board ${boardId} is ${board ? "closed" : "gone"}`, "unlinked");
    }
    claimed.set(`${type}\u0000${boardId}`, slug);
    // Trello assigns no identifier, so the prefix on the record is all there
    // will ever be — and it is OURS, not Trello's. The only thing this read
    // confirms is that the BOARD is real, so that is the only thing stamped:
    // `board_confirmed_at` carries the link, and the key stays a proposal. The
    // previous code wrote `identifier_source: "provider"` here, which is how
    // `intelliforia` came to assert that Trello had assigned it `INT`.
    const identifier = (provider.identifier ?? "").trim();
    if (!identifier) {
      return demoteToPlanned(ctx, slug, provider, `Trello board "${board.name}" has no identifier on the record`, "planned");
    }
    const bindingChanged = provider.board_id !== boardId || provider.state !== "linked";
    const confirmedAt = stampFor(provider.board_confirmed_at, bindingChanged, ctx.fetchedAt);
    noteChange(ctx, slug, "board_id", provider.board_id, boardId);
    noteChange(ctx, slug, "identifier_source", provider.identifier_source, "proposed");
    noteChange(ctx, slug, "identifier_fetched_at", provider.identifier_fetched_at, "");
    noteChange(ctx, slug, "board_confirmed_at", provider.board_confirmed_at, confirmedAt);
    noteChange(ctx, slug, "state", provider.state, "linked");
    if (ctx.apply) {
      provider.board_id = boardId;
      provider.identifier_source = "proposed";
      delete provider.identifier_fetched_at;
      provider.board_confirmed_at = confirmedAt;
      provider.state = "linked";
    }
    return {
      slug,
      type,
      workspace: (provider.workspace ?? "").trim(),
      boardId,
      identifier,
      identifierSource: "proposed",
      status: "linked",
      detail: `Trello board "${board.name}" confirmed; ${identifier} stays a local prefix — Trello assigns none`,
    };
  }

  // Plane. Where the board LIVES is a fact of the provider, not of the record:
  // searching every workspace is what turns james-brennan's "33god/JAME" into
  // "automaticai/JIMB" instead of stamping a provider identifier onto a record
  // that names the wrong workspace.
  for (const [workspace, boards] of ctx.boardsByWorkspace) {
    const board = boards.get(boardId);
    if (!board) continue;
    claimed.set(`${type}\u0000${boardId}`, slug);
    const bindingChanged =
      provider.board_id !== boardId ||
      provider.workspace !== workspace ||
      provider.identifier !== board.identifier ||
      provider.identifier_source !== "provider" ||
      provider.state !== "linked";
    // Plane answers both questions in one read: listing the board proves the
    // binding, and the key it hands back is the one Plane assigned. Two stamps,
    // because they are two claims — and only Plane can make the second.
    const stamp = stampFor(provider.identifier_fetched_at, bindingChanged, ctx.fetchedAt);
    const confirmedAt = stampFor(provider.board_confirmed_at, bindingChanged, ctx.fetchedAt);
    noteChange(ctx, slug, "board_id", provider.board_id, boardId);
    noteChange(ctx, slug, "workspace", provider.workspace, workspace);
    noteChange(ctx, slug, "identifier", provider.identifier, board.identifier);
    noteChange(ctx, slug, "identifier_source", provider.identifier_source, "provider");
    noteChange(ctx, slug, "identifier_fetched_at", provider.identifier_fetched_at, stamp);
    noteChange(ctx, slug, "board_confirmed_at", provider.board_confirmed_at, confirmedAt);
    noteChange(ctx, slug, "state", provider.state, "linked");
    if (ctx.apply) {
      provider.board_id = boardId;
      provider.workspace = workspace;
      provider.identifier = board.identifier;
      provider.identifier_source = "provider";
      provider.identifier_fetched_at = stamp;
      provider.board_confirmed_at = confirmedAt;
      provider.state = "linked";
    }
    return {
      slug,
      type,
      workspace,
      boardId,
      identifier: board.identifier,
      identifierSource: "provider",
      status: "linked",
      detail: `Plane board "${board.name}"${recovered}`,
    };
  }

  // Not in any workspace we searched — which is NOT proof the board is gone.
  // Plane's v1 API has no endpoint that enumerates the workspaces a token can
  // see (`GET /api/v1/workspaces/` is a 404), so the searched set is only ever
  // the workspaces these two registries and the repo manifests happen to name.
  // Clearing a binding on that evidence would destroy the one recorded id
  // pointing at a board sitting in a workspace nobody listed. Report it loudly
  // and leave it be; `report.ok` turns false so the exit code carries it.
  const searched = [...ctx.boardsByWorkspace.keys()].join(", ") || "no workspace";
  const detail = `board ${boardId} is in none of ${searched}`;
  ctx.errors.push(`${slug}: ${detail}; binding preserved — confirm the board and re-run, or unlink it deliberately`);
  return preserve(slug, provider, detail);
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

  const projectSlugs = Object.keys(registry.projects)
    .filter((slug) => options.all || !options.target || slug === options.target)
    .sort();

  // One list call per workspace beats 90 board lookups, and it is the only way
  // to tell "this board is gone" from "this board is in another workspace".
  //
  // The union spans every store that names a workspace — fleet agents, project
  // records, and the repos' own manifests. A record's OWN workspace is the
  // least trustworthy of the three (james-brennan said `33god` for a board that
  // has always lived in `automaticai`), so the manifest and the fleet have to
  // be in the set or a relocated board would never be found.
  const workspaces = [
    ...new Set(
      [
        ...scoped.map(({ agent }) => agent.workspace),
        ...projectSlugs.flatMap((slug) => {
          const project = registry.projects[slug];
          return [
            project?.ticket_provider?.workspace ?? "",
            readManifestBoard(project?.repo_path ?? "")?.workspace ?? "",
          ];
        }),
        DEFAULT_PLANE_WORKSPACE,
      ]
        .map((workspace) => workspace.trim())
        .filter(Boolean),
    ),
  ].sort();
  const boardsByWorkspace = new Map<string, Map<string, PlaneBoardFacts>>();
  let workspacesFailed = 0;
  for (const workspace of workspaces) {
    try {
      const fetcher = options.fetchBoards ?? ((ws: string) => fetchPlaneBoards(ws, env, home));
      boardsByWorkspace.set(workspace, await fetcher(workspace));
    } catch (error) {
      workspacesFailed += 1;
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
  }

  // The project registry is reconciled RECORD BY RECORD, not as a side effect
  // of the fleet walk. Two thirds of these records have no agent at all, so an
  // agent-driven pass could never see them — which is exactly why 15 of them
  // still carried an identifier nobody had ever confirmed.
  const fleetBoards = new Map<string, string>();
  for (const agent of agents) {
    if (agent.projectPath && agent.boardId) fleetBoards.set(resolve(agent.projectPath), agent.boardId);
  }
  const projectContext: ProjectPassContext = {
    registry,
    boardsByWorkspace,
    planeDegraded: workspacesFailed > 0,
    fleetBoards,
    fetchTrello: options.fetchTrelloBoard ?? ((boardId: string) => fetchTrelloBoard(boardId, env, home)),
    fetchedAt,
    apply,
    changes: projectChanges,
    errors,
  };
  const claimed = new Map<string, string>();
  for (const [slug, project] of Object.entries(registry.projects)) {
    const provider = project?.ticket_provider;
    const boardId = provider?.board_id?.trim();
    if (boardId) claimed.set(`${provider.type ?? ""}\u0000${boardId}`, slug);
  }
  const projects: ProjectResolution[] = [];
  for (const slug of projectSlugs) {
    projects.push(await reconcileOneProject(projectContext, slug, claimed));
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
    projectsChecked: projects.length,
    resolutions,
    projects,
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

const PROJECT_STATUS_LABEL: Record<ProjectIdentityStatus, string> = {
  linked: "LINKED",
  planned: "planned",
  unlinked: "UNLINKED",
  preserved: "preserved",
  skipped: "skipped",
};

export function formatIdentityReport(report: IdentityReport): string {
  const lines: string[] = [""];
  if (report.resolutions.length) lines.push("  fleet agents");
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
  if (report.projects.length) {
    lines.push("");
    lines.push("  project records");
    const slugWidth = Math.max(...report.projects.map((p) => p.slug.length), 10);
    for (const item of report.projects) {
      const key = item.identifier
        ? `${item.workspace || "-"}/${item.identifier}${item.identifierSource ? ` (${item.identifierSource})` : ""}`
        : "(no identifier)";
      lines.push(
        `  ${PROJECT_STATUS_LABEL[item.status].padEnd(9)} ${item.slug.padEnd(slugWidth)}  ${key}` +
          (item.detail ? `  — ${item.detail}` : ""),
      );
    }
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
