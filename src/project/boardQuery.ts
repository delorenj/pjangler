// Ticket-board reads — the "what is on this board" half of the board surface.
//
// `boardUrl.ts` answers *where* a board is; this module answers *what is on
// it*. They stay separate files on purpose: boardUrl is imported by
// `src/prompt.ts`, which runs on every shell prompt, and none of what lives
// here — HTTP, cursor pagination, credential resolution — belongs in that
// bundle. Everything URL-shaped is delegated back to boardUrl rather than
// rebuilt, so a board link printed by `pj board` and one printed by
// `pj board status` cannot disagree.
//
// Every command in this module resolves its project implicitly, by walking up
// from the working directory to the nearest `.project.json`. There is no
// `--project` flag by design: the board binding is a property of where you
// are standing.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  boardUrl,
  findProjectRoot,
  planeBase,
  planeWorkspace,
  readTicketProvider,
  type TicketProviderFacts,
} from "./boardUrl";
import { PJANGLER_VERSION } from "../utils/version";

/** Providers a `.project.json` may bind a board to. */
export const BOARD_PROVIDERS = ["plane", "trello", "linear"] as const;
export type BoardProvider = (typeof BOARD_PROVIDERS)[number];

/**
 * Plane's five state groups. Every provider normalizes onto this vocabulary,
 * so "started" means the same thing regardless of what the board calls its
 * columns — this board spells `started` as both "In Progress" and, if it ever
 * grows one, "In Review".
 */
export const BOARD_STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type BoardStateGroup = (typeof BOARD_STATE_GROUPS)[number];

export interface BoardTicket {
  /** Display reference: `PJAN-86`. Falls back to the raw sequence number. */
  key: string;
  /** Provider-side id, needed by anything that wants to mutate the ticket. */
  id: string;
  title: string;
  /** The board's own column name, e.g. "In Progress". */
  state: string;
  /** Normalized group the column belongs to. */
  stateGroup: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Newest of created/updated. "Most recently added *or* updated" is one
   * ordering, not two, and this is the key it sorts on.
   */
  touchedAt: string;
  url: string | undefined;
}

export interface BoardModule {
  id: string;
  name: string;
  description: string;
  /** Provider status, e.g. backlog / planned / in-progress / completed. */
  status: string;
  totalIssues: number;
  completedIssues: number;
  startedIssues: number;
  updatedAt: string;
  url: string | undefined;
}

/** A resolved project root plus whatever board binding it carries. */
export interface ProjectHandle {
  root: string;
  slug: string;
  facts: TicketProviderFacts | undefined;
}

/** A project whose board binding is complete enough to query. */
export interface BoardContext {
  root: string;
  slug: string;
  provider: BoardProvider;
  facts: TicketProviderFacts;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * A failure with a message already written for a human at a terminal.
 *
 * The CLI prints `.message` verbatim and exits 1, so every throw site here is
 * responsible for saying what went wrong *and* what would fix it.
 */
export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

// ---------------------------------------------------------------------------
// Implicit project resolution
// ---------------------------------------------------------------------------

/**
 * The project's slug.
 *
 * Same rule as the shell prompt (`src/prompt.ts`): the manifest's
 * `project_slug` when it has one, else the directory name. A manifest too
 * broken to parse still sits in a directory with a name, and that name is a
 * truthful answer.
 */
export function readProjectSlug(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".project.json"), "utf8")) as Record<string, unknown>;
    const slug = manifest.project_slug;
    if (typeof slug === "string" && slug.trim()) return slug.trim();
  } catch {
    // fall through to the directory name
  }
  return basename(root);
}

/** Nearest enclosing project, or a message explaining there isn't one. */
export function resolveProject(cwd: string): ProjectHandle {
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new BoardError(
      `not inside a pjangler project: no .project.json in ${cwd} or any parent directory`,
    );
  }
  return { root, slug: readProjectSlug(root), facts: readTicketProvider(root) };
}

/** The bound provider, or a message explaining what the manifest is missing. */
export function resolveProvider(handle: ProjectHandle): BoardProvider {
  const type = handle.facts?.type?.trim().toLowerCase();
  if (!type) {
    throw new BoardError(
      `no ticket board bound for ${handle.slug}: ${join(handle.root, ".project.json")} has no ticket_provider.type`,
    );
  }
  if (!(BOARD_PROVIDERS as readonly string[]).includes(type)) {
    throw new BoardError(
      `unsupported ticket_provider.type "${type}" in ${join(handle.root, ".project.json")} — expected one of ${BOARD_PROVIDERS.join(", ")}`,
    );
  }
  return type as BoardProvider;
}

/** Full resolution: project root, slug, provider, and the binding facts. */
export function resolveBoardContext(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): BoardContext {
  const handle = resolveProject(cwd);
  const provider = resolveProvider(handle);
  return { root: handle.root, slug: handle.slug, provider, facts: handle.facts ?? {}, env, home };
}

// ---------------------------------------------------------------------------
// Plane credentials
//
// The chain mirrors `agents/hermes/pm/.scripts/providers/plane.sh` exactly. If
// the CLI and the PM agent resolved different keys they would silently read
// different boards, which is worse than either of them simply failing.
// ---------------------------------------------------------------------------

/** `33god` → `PLANE_33GOD_API_KEY`; an empty workspace → `PLANE_DEFAULT_API_KEY`. */
export function workspaceEnvKey(workspace: string | undefined): string {
  const key = (workspace ?? "default").toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `PLANE_${key || "DEFAULT"}_API_KEY`;
}

/**
 * Read one exact assignment out of a dotenv file, as inert data.
 *
 * Never sourced: the shared fleet file may carry command substitutions or
 * credential helpers that a read has no business executing.
 */
export function dotenvValue(path: string, key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    const first = value[0];
    if (value.length >= 2 && first && (first === '"' || first === "'") && value.endsWith(first)) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/**
 * Resolve an `op://` reference to its value, leaving anything else alone.
 *
 * Deferred to the last possible moment and never written anywhere: the
 * resolved secret exists only in this process, for the length of one request.
 */
export function resolveSecretValue(value: string): string {
  if (!value.startsWith("op://")) return value;
  const result = spawnSync("op", ["read", value], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "op read failed").trim();
    throw new BoardError(`could not resolve the credential ${value} from 1Password: ${detail}`);
  }
  const resolved = result.stdout.trim();
  if (!resolved) throw new BoardError(`1Password returned an empty value for ${value}`);
  return resolved;
}

/** Environment variables consulted for a workspace, in precedence order. */
export function planeApiKeyNames(workspace: string | undefined): string[] {
  return ["PLANE_API_KEY", workspaceEnvKey(workspace)];
}

/**
 * The API key for a workspace: environment first, then the shared fleet
 * dotenv, with `op://` references resolved at the end.
 */
export function resolvePlaneApiKey(
  workspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined {
  const fleetEnv = env.HERMES_FLEET_ENV?.trim() || join(home, ".hermes", "fleet.env");
  const scoped = workspaceEnvKey(workspace);
  const candidates = [
    env.PLANE_API_KEY,
    env[scoped],
    dotenvValue(fleetEnv, scoped),
    dotenvValue(fleetEnv, "PLANE_API_KEY"),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return resolveSecretValue(value);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plane HTTP
// ---------------------------------------------------------------------------

interface PlaneClient {
  base: string;
  workspace: string;
  board: string;
  apiKey: string;
  timeoutMs: number;
  pageSize: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Runaway guard, not a result cap: at the default page size this is 20,000
 * work items. Exhausting it means something is wrong with the cursor, so the
 * loop raises rather than returning a silently short list.
 */
const MAX_PAGES = 200;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function planeClient(ctx: BoardContext): PlaneClient {
  const board = ctx.facts.board_id?.trim();
  if (!board) {
    throw new BoardError(
      `no board linked for ${ctx.slug}: ${join(ctx.root, ".project.json")} has an empty ticket_provider.board_id`,
    );
  }
  const workspace = planeWorkspace(ctx.facts, ctx.env, ctx.home);
  if (!workspace) {
    throw new BoardError(`no Plane workspace resolved for ${ctx.slug} (ticket_provider.workspace is empty)`);
  }
  const apiKey = resolvePlaneApiKey(workspace, ctx.env, ctx.home);
  if (!apiKey) {
    throw new BoardError(
      `no Plane API key for workspace "${workspace}": set ${planeApiKeyNames(workspace).join(" or ")}, ` +
        `or add one to ${ctx.env.HERMES_FLEET_ENV?.trim() || join(ctx.home, ".hermes", "fleet.env")}`,
    );
  }
  return {
    base: planeBase(ctx.env, ctx.home),
    workspace,
    board,
    apiKey,
    timeoutMs: positiveInt(ctx.env.PJANGLER_BOARD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    pageSize: positiveInt(ctx.env.PJANGLER_BOARD_PAGE_SIZE, DEFAULT_PAGE_SIZE),
  };
}

async function planeGet(
  client: PlaneClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  const url = new URL(
    `${client.base}/api/v1/workspaces/${encodeURIComponent(client.workspace)}` +
      `/projects/${encodeURIComponent(client.board)}/${path}`,
  );
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-API-Key": client.apiKey, "User-Agent": `pjangler/${PJANGLER_VERSION}` },
      signal: AbortSignal.timeout(client.timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BoardError(`could not reach Plane at ${client.base} (${path}): ${detail}`);
  }
  if (!response.ok) {
    const credentials = response.status === 401 || response.status === 403;
    throw new BoardError(
      `Plane returned ${response.status} for ${path}` +
        (credentials
          ? ` — the API key was rejected; check ${planeApiKeyNames(client.workspace).join(" / ")}`
          : response.status === 404
            ? ` — no such board in workspace "${client.workspace}"; check ticket_provider.board_id`
            : ""),
    );
  }
  try {
    return await response.json();
  } catch {
    throw new BoardError(`Plane returned a non-JSON body for ${path}`);
  }
}

interface PlaneCursorPage {
  results?: unknown;
  next_cursor?: string;
  next_page_results?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every row on a paginated route.
 *
 * Plane v1 answers some routes with a bare array and others with a cursor
 * envelope, so both shapes are accepted. Following the cursor to exhaustion is
 * not optional here: `states`/`state_group` query filters are accepted and
 * then *ignored* by this API, so `board status` has to select client-side over
 * the complete set — a single page would quietly drop started work.
 */
async function planeGetAll(
  client: PlaneClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { per_page: client.pageSize, ...params, ...(cursor ? { cursor } : {}) };
    const body = await planeGet(client, path, query);

    if (Array.isArray(body)) {
      rows.push(...body.filter(isRecord));
      return rows;
    }
    if (!isRecord(body)) return rows;

    const envelope = body as PlaneCursorPage;
    if (Array.isArray(envelope.results)) rows.push(...envelope.results.filter(isRecord));
    if (!envelope.next_page_results || !envelope.next_cursor) return rows;
    cursor = envelope.next_cursor;
  }

  throw new BoardError(
    `Plane pagination did not terminate after ${MAX_PAGES} pages of ${path} — refusing to report a truncated list`,
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Plane returns `issue.state` as a bare UUID, so the states map is required. */
async function planeStates(client: PlaneClient): Promise<Map<string, { name: string; group: string }>> {
  const rows = await planeGetAll(client, "states/");
  const map = new Map<string, { name: string; group: string }>();
  for (const row of rows) {
    const id = str(row.id);
    if (id) map.set(id, { name: str(row.name), group: str(row.group) });
  }
  return map;
}

/** Later of the two stamps — the single key "added or updated" orders on. */
function touched(createdAt: string, updatedAt: string): string {
  if (!createdAt) return updatedAt;
  if (!updatedAt) return createdAt;
  return Date.parse(updatedAt) >= Date.parse(createdAt) ? updatedAt : createdAt;
}

function toTicket(
  row: Record<string, unknown>,
  states: Map<string, { name: string; group: string }>,
  ctx: BoardContext,
): BoardTicket {
  const identifier = ctx.facts.identifier?.trim().toUpperCase();
  const sequence = str(row.sequence_id);
  const key = identifier && sequence ? `${identifier}-${sequence}` : sequence || str(row.id);
  const state = states.get(str(row.state));
  const createdAt = str(row.created_at);
  const updatedAt = str(row.updated_at);
  return {
    key,
    id: str(row.id),
    title: str(row.name),
    state: state?.name ?? "",
    stateGroup: state?.group ?? "",
    createdAt,
    updatedAt,
    touchedAt: touched(createdAt, updatedAt),
    // Reuse the one URL derivation rather than assembling a second one.
    url: boardUrl(ctx.facts, { ref: key, env: ctx.env, home: ctx.home }),
  };
}

function byTouchedDesc(a: BoardTicket, b: BoardTicket): number {
  return Date.parse(b.touchedAt) - Date.parse(a.touchedAt);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function requirePlane(ctx: BoardContext, verb: string): PlaneClient {
  if (ctx.provider !== "plane") {
    throw new BoardError(
      `board ${verb} is not wired for ${ctx.provider} yet — only plane boards can be read. ` +
        `"pj board provider" and "pj board slug" work for every provider.`,
    );
  }
  return planeClient(ctx);
}

/**
 * Work items in a `started` state group, most recently added or updated first.
 *
 * The group, not the column name, is the selector: a board that renames "In
 * Progress" or adds "In Review" keeps working without a config change.
 */
export async function fetchStartedTickets(ctx: BoardContext, limit?: number): Promise<BoardTicket[]> {
  const client = requirePlane(ctx, "status");
  const [states, rows] = await Promise.all([
    planeStates(client),
    planeGetAll(client, "issues/", { order_by: "-updated_at" }),
  ]);
  const started = rows
    .map((row) => toTicket(row, states, ctx))
    .filter((ticket) => ticket.stateGroup === "started")
    .sort(byTouchedDesc);
  return typeof limit === "number" && limit > 0 ? started.slice(0, limit) : started;
}

/**
 * The N most recently added or updated work items in any state.
 *
 * Ordering is asked of the server and then re-applied locally, because the
 * server orders by `updated_at` alone while this command promises "added *or*
 * updated". They agree on every row Plane has ever returned here; the local
 * sort is what makes the promise true rather than merely likely.
 */
export async function fetchRecentTickets(ctx: BoardContext, limit: number): Promise<BoardTicket[]> {
  const client = requirePlane(ctx, "recent");
  const [states, rows] = await Promise.all([
    planeStates(client),
    planeGetAll(client, "issues/", { order_by: "-updated_at" }),
  ]);
  return rows
    .map((row) => toTicket(row, states, ctx))
    .sort(byTouchedDesc)
    .slice(0, Math.max(0, limit));
}

/** The board's modules, most recently updated first. */
export async function fetchModules(ctx: BoardContext): Promise<BoardModule[]> {
  const client = requirePlane(ctx, "modules");
  const rows = await planeGetAll(client, "modules/");
  const base = planeBase(ctx.env, ctx.home);
  return rows
    .map((row) => ({
      id: str(row.id),
      name: str(row.name),
      description: str(row.description),
      status: str(row.status),
      totalIssues: num(row.total_issues),
      completedIssues: num(row.completed_issues),
      startedIssues: num(row.started_issues),
      updatedAt: touched(str(row.created_at), str(row.updated_at)),
      url: str(row.id)
        ? `${base}/${client.workspace}/projects/${client.board}/modules/${str(row.id)}`
        : undefined,
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
