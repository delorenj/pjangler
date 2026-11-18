// Crank v2 bindings (PJAN-214): one crank per live interactive agent session.
//
// A binding is keyed by the AGENT SESSION, never by a tab or pane name:
//     cli + native session id + process incarnation (pid + /proc starttime)
// The zellij pane is only where that session currently lives. Pane ids are reused after a
// zellij or host restart, so a binding whose process incarnation is gone is dead, whatever
// now sits in its old pane (I-8 FR-6: a replacement agent inherits nothing).
//
// The clock is Candybar and the registry IS Candybar: each binding is one exec candybar
// tagged `crank-session`, named `crank-<cli>-<sid8>-<pid>`, whose runner env carries the
// identity. Its manifest is written to the project's `.candybars/` (git-ignored machine-wide by
// `.candybars/crank-*.candybar.toml`, so sessions never churn a repo), which keeps it visible in
// that project's `candybar ls`. Removal is archive (Candybar has no delete, CAND-54) plus the
// manifest file, and a `bloodbank.crank.binding.ended` event saying why.
//
// Lifecycle:
//   attach  SessionStart hook (hook-hub `crank-attach`), `pj crank enable`
//   detach  SessionEnd hook (`crank-detach`), `pj crank disable`, a superseding attach
//   reap    every fire checks its own target first; `pj crank reap` and every attach sweep all
//           bindings. A binding whose process is gone ends with reason `orphan_reaped` (the
//           "terminated non-explicitly" announcement).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { redis, type BindingFn } from "./index";
import { intervalCron, nextFire, type EffectiveCrankPolicy } from "./policy";

export const BINDING_TAG = "crank-session";
export const CRANK_TAG = "crank";
const SHELLS = new Set(["sh", "dash", "bash", "zsh", "fish", "env", "timeout", "nice", "python3", "python", "node"]);

export type EndReason = "explicit" | "session_end" | "superseded" | "disabled" | "pane_closed" | "orphan_reaped";

export interface AgentIdentity {
  cli: string;
  sessionId: string;
  pid: number;
  pidStart: string;
  zellijSession: string;
  paneId: string;
  cwd: string;
}

export interface BindingRecord extends AgentIdentity {
  name: string;
  candybarId: string;
  enabled: boolean;
  schedule: string;
  interval: string;
  projectRoot: string;
  projectSlug: string;
  manifestPath?: string;
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

/** Field 22 of /proc/<pid>/stat (start time in clock ticks since boot), or undefined if gone. */
export function procStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

export function procComm(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function procPpid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

export function procEnviron(pid: number): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return {};
  }
}

/** The same process incarnation is still running: pid exists AND its start time matches. */
export function incarnationAlive(pid: number, start: string): boolean {
  return Number.isInteger(pid) && pid > 0 && procStart(pid) === start;
}

/** First ancestor of `pid` (inclusive) that is not a shell/launcher. */
export function agentAncestor(pid: number, maxHops = 6): number | undefined {
  let current: number | undefined = pid;
  for (let hop = 0; current && hop < maxHops; hop++) {
    const comm = procComm(current);
    if (comm === undefined) return undefined;
    if (!SHELLS.has(comm) && comm !== "pj") return current;
    current = procPpid(current);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

interface ClaudeSessionFile {
  pid?: number;
  sessionId?: string;
  kind?: string;
  procStart?: string;
}

function claudeSessionsDir(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude"), "sessions");
}

function readClaudeSession(pid: number, env: NodeJS.ProcessEnv): ClaudeSessionFile | undefined {
  try {
    return JSON.parse(readFileSync(join(claudeSessionsDir(env), `${pid}.json`), "utf8")) as ClaudeSessionFile;
  } catch {
    return undefined;
  }
}

/** The pid whose Claude session file names `sessionId` (exact; the only CLI with such a file). */
function claudePidForSession(sessionId: string, env: NodeJS.ProcessEnv): number | undefined {
  let names: string[];
  try {
    names = readdirSync(claudeSessionsDir(env)).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const pid = Number(name.slice(0, -5));
    const file = readClaudeSession(pid, env);
    if (file?.sessionId === sessionId && file.procStart && procStart(pid) === file.procStart) return pid;
  }
  return undefined;
}

export interface IdentifyInput {
  cli?: string;
  sessionId?: string;
  /** Agent pid captured by bb-hook (BB_HOOK_AGENT_PID) or the caller. */
  pid?: number;
  /** Its start time as bb-hook saw it; must still match. */
  pidStart?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type IdentifyResult = { ok: true; identity: AgentIdentity } | { ok: false; reason: string };

/**
 * Prove an interactive agent session lives in a zellij pane of `zellijSession`.
 * Every refusal is a reason string, never a throw: "no agent, no crank".
 */
export function identifyAgent(input: IdentifyInput, zellijSession: string): IdentifyResult {
  const env = input.env ?? process.env;
  const cli = (input.cli ?? "").trim().toLowerCase();
  const sessionId = (input.sessionId ?? "").trim();
  if (!cli) return { ok: false, reason: "no agent CLI named" };
  if (!sessionId) return { ok: false, reason: "no native session id" };
  let pid = input.pid;
  if (!pid && cli === "claude") pid = claudePidForSession(sessionId, env);
  if (!pid) return { ok: false, reason: "agent process not found" };
  const start = procStart(pid);
  if (!start) return { ok: false, reason: `agent pid ${pid} is not running` };
  if (input.pidStart && input.pidStart !== start) return { ok: false, reason: `pid ${pid} was reused (start time changed)` };
  const procEnv = procEnviron(pid);
  const paneId = procEnv.ZELLIJ_PANE_ID?.trim();
  const zsess = procEnv.ZELLIJ_SESSION_NAME?.trim();
  if (!paneId || !zsess) return { ok: false, reason: "agent is not running in a zellij pane" };
  if (zsess !== zellijSession) return { ok: false, reason: `agent is in zellij session "${zsess}", cranks drive "${zellijSession}" only` };
  if (cli === "claude") {
    // bg/daemon Claude processes inherit the pane env; only the interactive session file counts.
    const file = readClaudeSession(pid, env);
    if (!file) return { ok: false, reason: `no Claude session file for pid ${pid}` };
    if (file.kind !== "interactive") return { ok: false, reason: `Claude session kind is "${file.kind ?? "?"}", not interactive` };
    if (file.procStart && file.procStart !== start) return { ok: false, reason: "Claude session file belongs to an older process" };
    if (file.sessionId && file.sessionId !== sessionId) return { ok: false, reason: `pid ${pid} now runs session ${file.sessionId.slice(0, 8)}` };
  }
  return { ok: true, identity: { cli, sessionId, pid, pidStart: start, zellijSession: zsess, paneId, cwd: input.cwd } };
}

// ---------------------------------------------------------------------------
// Naming + manifests
// ---------------------------------------------------------------------------

export function bindingName(identity: Pick<AgentIdentity, "cli" | "sessionId" | "pid">): string {
  const cli = identity.cli.replace(/[^a-z0-9]/g, "").slice(0, 12) || "agent";
  const sid = identity.sessionId.toLowerCase().replace(/^(ses_|session_)/, "").replace(/[^a-z0-9]/g, "").slice(0, 8) || "nosid";
  return `crank-${cli}-${sid}-${identity.pid}`;
}

/** Candybar's own project tag for a directory: the main worktree's name (see candybar project.py). */
export function candybarProjectName(root: string): string {
  const git = (...args: string[]) => {
    const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return out.status === 0 ? out.stdout.trim() : undefined;
  };
  const top = git("rev-parse", "--show-toplevel");
  if (!top) return basename(root);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return basename(top);
  if (basename(common) === ".git") return basename(dirname(common));
  if (basename(dirname(common)) === "modules") return basename(top);
  return basename(common).replace(/\.git$/, "") || basename(top);
}

/** argv that re-enters THIS pj install: node + the real script path, both absolute. */
export function pjArgv(): string[] {
  const script = process.argv[1] ? realpathSync(process.argv[1]) : "";
  return [process.execPath, script];
}

export interface ManifestSpec {
  name: string;
  schedule: string;
  timezone: string;
  tags: string[];
  description: string;
  argv: string[];
  workdir: string;
  env: Record<string, string>;
}

export function manifestSpec(identity: AgentIdentity, policy: EffectiveCrankPolicy, project: { root: string; slug: string }, now = new Date()): ManifestSpec {
  const name = bindingName(identity);
  return {
    name,
    schedule: intervalCron(policy.interval, name),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    tags: [CRANK_TAG, BINDING_TAG, `cli:${identity.cli}`],
    description: `Crank for ${identity.cli} session ${identity.sessionId.slice(0, 8)} (pid ${identity.pid}, pane ${identity.paneId}) in ${project.slug}, every ${policy.interval}; attached ${now.toISOString()}`,
    argv: [...pjArgv(), "crank", "fire", name],
    workdir: project.root,
    env: {
      CRANK_BINDING: name,
      CRANK_CLI: identity.cli,
      CRANK_SESSION_ID: identity.sessionId,
      CRANK_PID: String(identity.pid),
      CRANK_PID_START: identity.pidStart,
      CRANK_ZELLIJ_SESSION: identity.zellijSession,
      CRANK_PANE_ID: identity.paneId,
      CRANK_PROJECT_ROOT: project.root,
      CRANK_PROJECT: project.slug,
      CRANK_INTERVAL: policy.interval,
    },
  };
}

export function manifestPath(root: string, name: string): string {
  return join(root, ".candybars", `${name}.candybar.toml`);
}

export function renderManifest(spec: ManifestSpec): string {
  const doc = {
    candybar: {
      name: spec.name,
      description: spec.description,
      schedule: spec.schedule,
      timezone: spec.timezone,
      tags: spec.tags,
      enabled: true,
      runner: { kind: "exec", argv: spec.argv, workdir: spec.workdir, timeout_s: 600, env: spec.env },
    },
  };
  return "# Session-scoped crank (pj crank, PJAN-214). Written on attach, removed on detach; never commit.\n" + stringifyToml(doc) + "\n";
}

function writeManifest(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Candybar API (raw HTTP: the CLI's Python startup is 0.4s, too slow for a hook)
// ---------------------------------------------------------------------------

export interface CandybarRow {
  id: string;
  name: string;
  tags: string[];
  schedule: string;
  timezone: string;
  enabled: boolean;
  archived: boolean;
  description?: string;
}

export interface CandybarRunner {
  kind: string;
  argv?: string[];
  env?: Record<string, string>;
  workdir?: string;
}

export interface CandybarInvocation {
  trigger: string;
  result: string;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
}

export interface CandybarClient {
  list(): Promise<CandybarRow[]>;
  runner(id: string): Promise<CandybarRunner | undefined>;
  create(body: Record<string, unknown>): Promise<{ status: number; row?: CandybarRow; detail?: string }>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  archive(id: string): Promise<void>;
  invocations(id: string, limit: number): Promise<CandybarInvocation[]>;
  patch(id: string, body: Record<string, unknown>): Promise<void>;
}

export function candybarBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CANDYBAR_API_URL?.trim() || "http://127.0.0.1:8700").replace(/\/+$/, "");
}

export function candybarClient(base = candybarBaseUrl()): CandybarClient {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  };
  const ok = (res: { status: number; text: string }, what: string) => {
    if (res.status >= 300) throw new Error(`Candybar ${what} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  };
  return {
    async list() {
      const res = await call("GET", "/candybars");
      ok(res, "list");
      return res.json as CandybarRow[];
    },
    async runner(id) {
      const res = await call("GET", `/candybars/${id}/runner`);
      if (res.status === 404) return undefined;
      ok(res, "runner");
      return (res.json as { runner?: CandybarRunner }).runner;
    },
    async create(body) {
      const res = await call("POST", "/candybars", body);
      const detail = (res.json as { detail?: string } | undefined)?.detail ?? res.text.slice(0, 300);
      return { status: res.status, row: res.status < 300 ? (res.json as CandybarRow) : undefined, detail };
    },
    async setEnabled(id, enabled) {
      ok(await call("POST", `/candybars/${id}/enabled`, { enabled }), "enable");
    },
    async archive(id) {
      ok(await call("POST", `/candybars/${id}/archived`, { archived: true }), "archive");
    },
    async patch(id, body) {
      ok(await call("PATCH", `/candybars/${id}`, body), "update");
    },
    async invocations(id, limit) {
      const res = await call("GET", `/candybars/${id}/invocations?limit=${limit}`);
      ok(res, "history");
      return ((res.json as { invocations?: CandybarInvocation[] }).invocations ?? []);
    },
  };
}

// ---------------------------------------------------------------------------
// Bloodbank
// ---------------------------------------------------------------------------

export type Emitter = (type: string, orderingKey: string, data: Record<string, unknown>) => void;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRANK_STATE_DIR?.trim() || join(env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state"), "crank");
}

/**
 * Publish through bb-emit. A dead bus never breaks a crank, but it is never silent either: every
 * attempt lands in `<state>/events.jsonl` with the event id or the reason it was not published.
 */
export const bbEmit: Emitter = (type, orderingKey, data) => {
  const out = spawnSync("bb-emit", [
    "--type", type,
    "--service", "crank",
    "--producer", "pjangler",
    "--source", "urn:33god:service:crank",
    "--ordering-key", orderingKey,
    "--strict",
    "--print-ids",
  ], { input: JSON.stringify({ schema_version: 1, ...data }), encoding: "utf8", timeout: 10_000 });
  let id: string | undefined;
  try {
    id = (JSON.parse(out.stdout?.trim().split("\n").at(-1) ?? "") as { id?: string }).id;
  } catch {
    id = undefined;
  }
  const ok = out.status === 0;
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({
      ts: new Date().toISOString(), type, ordering_key: orderingKey, ok, id,
      ...(ok ? {} : { error: (out.error?.message ?? out.stderr ?? "").trim().split("\n").slice(-2).join(" | ").slice(0, 300) }),
    }) + "\n");
  } catch {
    // the receipt is best effort; the event itself already went or did not
  }
};

/**
 * Writes the binding's live projection into Redis (crank.lua `crank_attach|crank_fire|crank_end`),
 * which the shell prompt reads. Fail-open: Candybar is the registry and the clock, so a Redis that
 * is down never breaks a crank. A failed write lands in `<state>/projection.jsonl`, never silently.
 */
export type Projector = (fn: BindingFn, payload: Record<string, unknown>) => void;

export const redisProjector: Projector = (fn, payload) => {
  try {
    redis().binding(fn, payload);
  } catch (caught) {
    try {
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "projection.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), fn, binding: payload.binding,
        error: (caught instanceof Error ? caught.message : String(caught)).slice(0, 300),
      }) + "\n");
    } catch {
      // the receipt is best effort too
    }
  }
};

/** The facts every projection write carries, so a fire can re-create an expired hash. */
export function projectionFacts(
  record: Pick<BindingRecord, "name" | "cli" | "sessionId" | "pid" | "pidStart" | "projectSlug" | "projectRoot" | "zellijSession" | "paneId" | "interval" | "schedule" | "candybarId">,
  nowMs = Date.now(),
): Record<string, unknown> {
  const schedule = record.schedule || (record.interval ? safeCron(record.interval, record.name) : "");
  const next = schedule ? nextFire(schedule, nowMs) : undefined;
  return {
    binding: record.name,
    cli: record.cli,
    session_id: record.sessionId,
    pid: record.pid,
    pid_start: record.pidStart,
    project: record.projectSlug,
    root: record.projectRoot,
    zellij_session: record.zellijSession,
    pane: record.paneId,
    interval: record.interval,
    schedule,
    candybar_id: record.candybarId,
    ...(next !== undefined ? { next_due: next } : {}),
  };
}

function safeCron(interval: string, seed: string): string {
  try {
    return intervalCron(interval, seed);
  } catch {
    return "";
  }
}

function eventData(record: Pick<BindingRecord, "name" | "cli" | "sessionId" | "pid" | "paneId" | "zellijSession" | "projectSlug" | "interval">): Record<string, unknown> {
  return {
    binding: record.name,
    cli: record.cli,
    session_id: record.sessionId,
    pid: record.pid,
    pane_id: `terminal_${record.paneId}`,
    zellij_session: record.zellijSession,
    project: record.projectSlug,
    interval: record.interval,
  };
}

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

function recordFrom(row: CandybarRow, runner: CandybarRunner | undefined): BindingRecord | undefined {
  const env = runner?.env ?? {};
  if (!env.CRANK_BINDING) return undefined;
  const root = env.CRANK_PROJECT_ROOT ?? "";
  const path = root ? manifestPath(root, row.name) : undefined;
  return {
    name: row.name,
    candybarId: row.id,
    enabled: row.enabled,
    schedule: row.schedule,
    interval: env.CRANK_INTERVAL ?? "",
    cli: env.CRANK_CLI ?? "",
    sessionId: env.CRANK_SESSION_ID ?? "",
    pid: Number(env.CRANK_PID ?? 0),
    pidStart: env.CRANK_PID_START ?? "",
    zellijSession: env.CRANK_ZELLIJ_SESSION ?? "",
    paneId: env.CRANK_PANE_ID ?? "",
    cwd: root,
    projectRoot: root,
    projectSlug: env.CRANK_PROJECT ?? "",
    manifestPath: path && existsSync(path) ? path : undefined,
  };
}

/** Every live (non-archived) crank binding. */
export async function listBindings(client: CandybarClient = candybarClient()): Promise<BindingRecord[]> {
  const rows = (await client.list()).filter((row) => !row.archived && row.tags?.includes(BINDING_TAG));
  const records = await Promise.all(rows.map(async (row) => recordFrom(row, await client.runner(row.id))));
  return records.filter((record): record is BindingRecord => record !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}

export interface DetachResult {
  name: string;
  reason: EndReason;
  archived: boolean;
  error?: string;
}

/** Archive the candybar, remove the manifest, announce `binding.ended`. Idempotent. */
export async function detachBinding(record: BindingRecord, reason: EndReason, deps: { client?: CandybarClient; emit?: Emitter; detail?: string; project?: Projector } = {}): Promise<DetachResult> {
  const client = deps.client ?? candybarClient();
  const emit = deps.emit ?? bbEmit;
  const projector = deps.project ?? redisProjector;
  let error: string | undefined;
  try {
    await client.archive(record.candybarId);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const path = record.projectRoot ? manifestPath(record.projectRoot, record.name) : undefined;
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // a manifest we cannot remove is harmless: register --prune never sees it as an orphan of a live row
    }
  }
  if (!error) {
    emit("bloodbank.crank.binding.ended", `binding:${record.name}`, { ...eventData(record), reason, ...(deps.detail ? { detail: deps.detail.slice(0, 300) } : {}) });
    projector("crank_end", {
      binding: record.name,
      reason,
      zellij_session: record.zellijSession,
      pane: record.paneId,
      ...(deps.detail ? { detail: deps.detail.slice(0, 300) } : {}),
    });
  }
  return { name: record.name, reason, archived: !error, error };
}

export interface AttachResult {
  status: "attached" | "already" | "refused";
  name?: string;
  reason?: string;
  schedule?: string;
  superseded: string[];
  reaped: string[];
}

/**
 * Create (or confirm) the crank for one proven session. Also ends any other live binding on the
 * same process incarnation (a /clear rotated its session id) and reaps every dead binding seen.
 */
export async function attachBinding(
  identity: AgentIdentity,
  policy: EffectiveCrankPolicy,
  project: { root: string; slug: string },
  deps: { client?: CandybarClient; emit?: Emitter; now?: Date; project?: Projector } = {},
): Promise<AttachResult> {
  const client = deps.client ?? candybarClient();
  const emit = deps.emit ?? bbEmit;
  const projector = deps.project ?? redisProjector;
  const nowMs = (deps.now ?? new Date()).getTime();
  const spec = manifestSpec(identity, policy, project, deps.now);
  const existing = await listBindings(client);
  const superseded: string[] = [];
  const reaped: string[] = [];
  for (const record of existing) {
    if (record.name === spec.name) continue;
    if (record.pid === identity.pid && record.pidStart === identity.pidStart) {
      await detachBinding(record, "superseded", { client, emit, project: projector, detail: `session ${identity.sessionId.slice(0, 8)} took over pid ${identity.pid}` });
      superseded.push(record.name);
    } else if (!incarnationAlive(record.pid, record.pidStart)) {
      await detachBinding(record, "orphan_reaped", { client, emit, project: projector, detail: "agent process gone (found while attaching another session)" });
      reaped.push(record.name);
    }
  }
  const mine = existing.find((record) => record.name === spec.name);
  if (mine) {
    if (!mine.enabled) await client.setEnabled(mine.candybarId, true);
    // The fire argv names the pj install that attached it. A pj reinstalled elsewhere (another node
    // prefix, a new node) re-points the live crank instead of leaving it firing a dead path.
    const runner = await client.runner(mine.candybarId);
    const drifted = !runner || JSON.stringify(runner.argv ?? []) !== JSON.stringify(spec.argv);
    if (drifted) await client.patch(mine.candybarId, { runner: { ...(runner ?? { kind: "exec", timeout_s: 600, env: spec.env }), argv: spec.argv } });
    if (drifted || !mine.manifestPath) {
      writeManifest(manifestPath(project.root, spec.name), renderManifest({ ...spec, schedule: mine.schedule, env: { ...spec.env, CRANK_INTERVAL: mine.interval || spec.env.CRANK_INTERVAL || "" } }));
    }
    projector("crank_attach", projectionFacts({ ...mine, ...identity, name: spec.name, projectRoot: project.root, projectSlug: project.slug }, nowMs));
    return { status: "already", name: spec.name, schedule: mine.schedule, superseded, reaped };
  }
  const path = manifestPath(project.root, spec.name);
  writeManifest(path, renderManifest(spec));
  const body = {
    name: spec.name,
    description: spec.description,
    tags: [...spec.tags, `project:${candybarProjectName(project.root)}`],
    schedule: spec.schedule,
    timezone: spec.timezone,
    enabled: true,
    noise: true,
    runner: { kind: "exec", argv: spec.argv, workdir: spec.workdir, timeout_s: 600, env: spec.env },
  };
  const created = await client.create(body);
  let row = created.row;
  if (created.status === 409) {
    // An autosync watcher may have registered the file first (paused), or the name was archived by
    // an earlier detach of this very incarnation: Candybar names are never reusable.
    const found = (await client.list()).find((candidate) => candidate.name === spec.name);
    if (found && !found.archived) {
      if (!found.enabled) await client.setEnabled(found.id, true);
      row = found;
    } else {
      try {
        unlinkSync(path);
      } catch {
        // nothing to clean
      }
      return { status: "refused", name: spec.name, reason: `Candybar name ${spec.name} is archived and can never be reused (CAND-54); restart the agent for a new crank`, superseded, reaped };
    }
  } else if (!row) {
    try {
      unlinkSync(path);
    } catch {
      // nothing to clean
    }
    throw new Error(`Candybar refused ${spec.name}: HTTP ${created.status} ${created.detail ?? ""}`);
  }
  emit("bloodbank.crank.binding.created", `binding:${spec.name}`, {
    ...eventData({ ...identity, name: spec.name, projectSlug: project.slug, interval: policy.interval }),
    schedule: spec.schedule,
    candybar_id: row.id,
  });
  projector("crank_attach", projectionFacts({
    ...identity, name: spec.name, projectRoot: project.root, projectSlug: project.slug,
    interval: policy.interval, schedule: spec.schedule, candybarId: row.id,
  }, nowMs));
  return { status: "attached", name: spec.name, schedule: spec.schedule, superseded, reaped };
}

/** Move one live crank onto a new interval: Candybar schedule + runner env + its manifest file. */
export async function reclockBinding(record: BindingRecord, interval: string, client: CandybarClient = candybarClient(), projector: Projector = redisProjector): Promise<string> {
  const schedule = intervalCron(interval, record.name);
  const runner = await client.runner(record.candybarId);
  const env = { ...(runner?.env ?? {}), CRANK_INTERVAL: interval };
  await client.patch(record.candybarId, { schedule, runner: { ...(runner ?? { kind: "exec" }), env } });
  const path = record.manifestPath;
  if (path && existsSync(path)) {
    const text = readFileSync(path, "utf8")
      .replace(/^schedule = .*$/m, `schedule = ${JSON.stringify(schedule)}`)
      .replace(/^CRANK_INTERVAL = .*$/m, `CRANK_INTERVAL = ${JSON.stringify(interval)}`);
    writeManifest(path, text);
  }
  projector("crank_attach", projectionFacts({ ...record, interval, schedule }));
  return schedule;
}

/** End every binding whose agent process incarnation is gone. */
export async function reapBindings(deps: { client?: CandybarClient; emit?: Emitter; project?: Projector } = {}): Promise<DetachResult[]> {
  const client = deps.client ?? candybarClient();
  const out: DetachResult[] = [];
  for (const record of await listBindings(client)) {
    if (incarnationAlive(record.pid, record.pidStart)) continue;
    out.push(await detachBinding(record, "orphan_reaped", { client, emit: deps.emit, project: deps.project, detail: "agent process gone with no session end" }));
  }
  return out;
}
