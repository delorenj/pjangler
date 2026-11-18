// Crank v2 operations (PJAN-214): what `pj crank` commands, the TUI and the hook handlers do.
// Policy lives in ./policy, the session-keyed registry in ./binding; this file composes them.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolveProject } from "../project/boardQuery";
import {
  agentAncestor,
  attachBinding,
  candybarClient,
  detachBinding,
  identifyAgent,
  incarnationAlive,
  listBindings,
  procStart,
  reclockBinding,
  type AttachResult,
  type BindingRecord,
  type CandybarClient,
  type CandybarInvocation,
  type DetachResult,
  type EndReason,
  type IdentifyInput,
} from "./binding";
import { loadPolicy, type EffectiveCrankPolicy } from "./policy";

export interface ProjectRef {
  root: string;
  slug: string;
}

export function projectAt(cwd: string): ProjectRef {
  const handle = resolveProject(cwd);
  return { root: handle.root, slug: handle.slug };
}

export function tryProjectAt(cwd: string): ProjectRef | undefined {
  try {
    return projectAt(cwd);
  } catch {
    return undefined;
  }
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRANK_STATE_DIR?.trim() || join(env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state"), "crank");
}

/** One line per hook decision, so "why did my session not get a crank?" has an answer. */
export function hookLog(line: Record<string, unknown>): void {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hooks.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n");
  } catch {
    // never fail a hook on its own log
  }
}

// ---------------------------------------------------------------------------
// Who is calling? (pj run from inside an agent pane, or a hook)
// ---------------------------------------------------------------------------

/** The agent session pj is running inside, if any (a tool call from Claude Code, Codex, …). */
export function callerSession(env: NodeJS.ProcessEnv = process.env): IdentifyInput | undefined {
  const cwd = process.cwd();
  if (env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_PID) {
    return { cli: "claude", sessionId: env.CLAUDE_CODE_SESSION_ID, pid: Number(env.CLAUDE_PID), cwd, env };
  }
  if (env.CODEX_THREAD_ID) {
    const pid = agentAncestor(process.ppid);
    return { cli: "codex", sessionId: env.CODEX_THREAD_ID, pid, cwd, env };
  }
  return undefined;
}

/** The hook payload + env bb-hook/hook-hub hand a handler. */
export function hookSession(env: NodeJS.ProcessEnv = process.env, stdin = readStdin()): IdentifyInput & { source?: string; reason?: string } {
  let payload: Record<string, unknown> = {};
  try {
    payload = stdin.trim() ? (JSON.parse(stdin) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  const sid = [payload.session_id, payload.sessionId, payload.sessionID, env.BB_HOOK_SESSION_ID].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const agentPid = Number(env.BB_HOOK_AGENT_PID ?? 0);
  let pid = Number.isInteger(agentPid) && agentPid > 0 ? agentPid : undefined;
  if (!pid && env.BB_HOOK_PARENT_PID) pid = agentAncestor(Number(env.BB_HOOK_PARENT_PID));
  return {
    cli: env.BB_HOOK_CLI,
    sessionId: sid,
    pid,
    pidStart: env.BB_HOOK_AGENT_START?.trim() || undefined,
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd(),
    env,
    source: typeof payload.source === "string" ? payload.source : undefined,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

export type SessionAttach = AttachResult | { status: "skipped"; reason: string; superseded: string[]; reaped: string[] };

/** Attach one session if its project wants cranking. `force` skips the policy check (explicit attach). */
export async function attachSession(input: IdentifyInput, deps: { force?: boolean; client?: CandybarClient } = {}): Promise<SessionAttach & { project?: ProjectRef; policy?: EffectiveCrankPolicy }> {
  const project = tryProjectAt(input.cwd);
  if (!project) return { status: "skipped", reason: `not inside a pjangler project (${input.cwd})`, superseded: [], reaped: [] };
  const policy = loadPolicy(project.root);
  if (!policy.enabled && !deps.force) return { status: "skipped", reason: `crank is off for ${project.slug} (${policy.enabledSource})`, superseded: [], reaped: [], project, policy };
  const proof = identifyAgent(input, policy.zellijSession);
  if (!proof.ok) return { status: "skipped", reason: proof.reason, superseded: [], reaped: [], project, policy };
  const result = await attachBinding(proof.identity, policy, project, { client: deps.client });
  return { ...result, project, policy };
}

/** End every binding of one native session (SessionEnd), or of one process incarnation. */
export async function detachSession(match: { cli?: string; sessionId?: string; pid?: number }, reason: EndReason, client: CandybarClient = candybarClient()): Promise<DetachResult[]> {
  const out: DetachResult[] = [];
  for (const record of await listBindings(client)) {
    const bySession = match.sessionId && record.sessionId === match.sessionId && (!match.cli || record.cli === match.cli);
    const byPid = match.pid && record.pid === match.pid;
    if (bySession || byPid) out.push(await detachBinding(record, reason, { client }));
  }
  return out;
}

export async function detachProject(root: string, reason: EndReason, client: CandybarClient = candybarClient()): Promise<DetachResult[]> {
  const out: DetachResult[] = [];
  for (const record of await listBindings(client)) {
    if (record.projectRoot === root) out.push(await detachBinding(record, reason, { client }));
  }
  return out;
}

/** Re-clock every live crank of a project to its current policy interval. */
export async function reclockProject(root: string, client: CandybarClient = candybarClient()): Promise<string[]> {
  const interval = loadPolicy(root).interval;
  const moved: string[] = [];
  for (const record of await listBindings(client)) {
    if (record.projectRoot !== root || record.interval === interval) continue;
    await reclockBinding(record, interval, client);
    moved.push(record.name);
  }
  return moved;
}

/**
 * Attach every live interactive agent session of this project (used by `pj crank enable`, so
 * sessions that were already running when crank was turned on are cranked too). Only sessions
 * whose native id is known (Claude today) can be bound; the rest attach on their next start.
 */
export async function attachLiveProjectSessions(project: ProjectRef, client: CandybarClient = candybarClient()): Promise<{ attached: string[]; skipped: string[] }> {
  const { inventoryPanes } = await import("./panes");
  const policy = loadPolicy(project.root);
  const attached: string[] = [];
  const skipped: string[] = [];
  const inventory = inventoryPanes({ session: policy.zellijSession });
  for (const pane of inventory.panes) {
    if (!pane.pid || !pane.agent || !pane.cwd) continue;
    const owner = tryProjectAt(pane.cwd);
    if (!owner || owner.root !== project.root) continue;
    if (!pane.sessionId) {
      skipped.push(`terminal_${pane.paneId} (${pane.agent}: session id unknown until its next start)`);
      continue;
    }
    const result = await attachSession({ cli: pane.agent, sessionId: pane.sessionId, pid: pane.pid, cwd: pane.cwd }, { client });
    if (result.status === "attached" || result.status === "already") attached.push(result.name ?? "");
    else skipped.push(`terminal_${pane.paneId} (${"reason" in result ? result.reason : result.status})`);
  }
  return { attached, skipped };
}

// ---------------------------------------------------------------------------
// Fire (the Candybar exec entry point)
// ---------------------------------------------------------------------------

export interface FireOutcome {
  binding: string;
  outcome: "fired" | "ended";
  reason?: EndReason;
  engineExit?: number;
  detail?: string;
}

export function enginePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRANK_ENGINE?.trim() || join(env.HOME?.trim() || homedir(), ".local", "bin", "crank-pane");
}

export async function fireBinding(name: string, env: NodeJS.ProcessEnv = process.env, client: CandybarClient = candybarClient()): Promise<FireOutcome> {
  let record: BindingRecord | undefined;
  if (env.CRANK_BINDING === name && env.CANDYBAR_ID) {
    record = {
      name,
      candybarId: env.CANDYBAR_ID,
      enabled: true,
      schedule: "",
      interval: env.CRANK_INTERVAL ?? "",
      cli: env.CRANK_CLI ?? "",
      sessionId: env.CRANK_SESSION_ID ?? "",
      pid: Number(env.CRANK_PID ?? 0),
      pidStart: env.CRANK_PID_START ?? "",
      zellijSession: env.CRANK_ZELLIJ_SESSION ?? "",
      paneId: env.CRANK_PANE_ID ?? "",
      cwd: env.CRANK_PROJECT_ROOT ?? "",
      projectRoot: env.CRANK_PROJECT_ROOT ?? "",
      projectSlug: env.CRANK_PROJECT ?? "",
    };
  } else {
    record = (await listBindings(client)).find((candidate) => candidate.name === name);
  }
  if (!record) throw new Error(`no live crank binding named ${name}`);

  if (!incarnationAlive(record.pid, record.pidStart)) {
    const live = procStart(record.pid);
    await detachBinding(record, "orphan_reaped", { client, detail: live ? `pid ${record.pid} now belongs to another process` : `pid ${record.pid} exited with no session end` });
    return { binding: name, outcome: "ended", reason: "orphan_reaped" };
  }
  let policy: EffectiveCrankPolicy;
  try {
    policy = loadPolicy(record.projectRoot);
  } catch (error) {
    throw new Error(`cannot read crank policy for ${record.projectRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!policy.enabled) {
    await detachBinding(record, "disabled", { client, detail: `crank turned off for ${record.projectSlug}` });
    return { binding: name, outcome: "ended", reason: "disabled" };
  }
  const brief = {
    project: record.projectSlug,
    root: record.projectRoot,
    cli: record.cli,
    session_id: record.sessionId,
    interval: policy.interval,
    prompt: policy.prompt ?? "",
    target: policy.target ?? "",
    rules: policy.rules,
    officer_profile: policy.officerProfile,
    officer_max_turns: policy.officerMaxTurns,
  };
  const run = spawnSync(enginePath(env), ["--binding", name, "--pane-id", record.paneId, "--session", record.zellijSession], {
    input: JSON.stringify(brief),
    encoding: "utf8",
    timeout: 540_000,
    env: { ...env, CRANK_ZELLIJ_SESSION: record.zellijSession },
  });
  if (run.error) throw new Error(`crank engine ${enginePath(env)} failed to start: ${run.error.message}`);
  const detail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
  if (run.status === 10) {
    await detachBinding(record, "pane_closed", { client, detail: `pane terminal_${record.paneId} is gone` });
    return { binding: name, outcome: "ended", reason: "pane_closed", engineExit: 10, detail };
  }
  return { binding: name, outcome: "fired", engineExit: run.status ?? undefined, detail };
}

// ---------------------------------------------------------------------------
// Reading (status, sessions, log)
// ---------------------------------------------------------------------------

export interface SessionView extends BindingRecord {
  alive: boolean;
  lastRuns: CandybarInvocation[];
  nextFireMs?: number;
  officerLast?: { ts: string; class: string; exit: number };
  lastClass?: string;
}

export async function sessionViews(filter: { root?: string } = {}, client: CandybarClient = candybarClient(), nowMs = Date.now()): Promise<SessionView[]> {
  const records = (await listBindings(client)).filter((record) => !filter.root || record.projectRoot === filter.root);
  return Promise.all(records.map(async (record) => {
    let lastRuns: CandybarInvocation[] = [];
    try {
      lastRuns = await client.invocations(record.candybarId, 5);
    } catch {
      lastRuns = [];
    }
    let engineState: { last_officer?: { ts: string; class: string; exit: number }; last_class?: string } = {};
    try {
      engineState = JSON.parse(readFileSync(join(stateDir(), `${record.name}.json`), "utf8"));
    } catch {
      engineState = {};
    }
    return {
      ...record,
      alive: incarnationAlive(record.pid, record.pidStart),
      lastRuns,
      nextFireMs: nextFire(record.schedule, nowMs),
      officerLast: engineState.last_officer,
      lastClass: engineState.last_class,
    };
  }));
}

export interface LogRow {
  ts: string;
  binding: string;
  state: string;
  action: string;
  detail?: string;
}

export function engineLog(names: string[], tail: number): LogRow[] {
  const rows: LogRow[] = [];
  for (const name of names) {
    let text = "";
    try {
      text = readFileSync(join(stateDir(), "log", `${name}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of text.trim().split("\n").slice(-tail)) {
      try {
        const row = JSON.parse(line) as Omit<LogRow, "binding">;
        rows.push({ ...row, binding: name });
      } catch {
        // skip a torn line
      }
    }
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-tail);
}

// ---------------------------------------------------------------------------
// Next fire for the cron shapes intervalCron() writes (host-local wall clock)
// ---------------------------------------------------------------------------

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const [range = "*", stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 59;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else {
      lo = Number(range);
      hi = stepRaw ? 59 : lo;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Next minute matching a `m h * * *` cron after `nowMs`, scanning at most two days. */
export function nextFire(cron: string, nowMs: number): number | undefined {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (!minute || !hour || dom !== "*" || month !== "*" || dow !== "*") return undefined;
  const start = new Date(nowMs);
  start.setSeconds(0, 0);
  for (let i = 1; i <= 2 * 24 * 60; i++) {
    const at = new Date(start.getTime() + i * 60_000);
    if (fieldMatches(minute, at.getMinutes()) && fieldMatches(hour, at.getHours())) return at.getTime();
  }
  return undefined;
}
