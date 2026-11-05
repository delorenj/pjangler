// PJAN-202 — `pj crank panes`: an exact, READ-ONLY inventory of the live agent panes in a zellij
// session (first slice of 33GOD initiative I-8, the pane-bound crank).
//
// Everything here is observation. It reads /proc, ~/.claude/sessions and two zellij listings
// (list-panes; nothing else). It writes no Redis key, sends no keys to a pane, focuses nothing and
// starts no timer, so a later slice can bind a crank to a pane plus an agent session without this
// one having changed what the crank does.
//
// ## Why /proc and not a tab name
//
// zellij puts ZELLIJ_PANE_ID and ZELLIJ_SESSION_NAME into the environment of each pane's root
// process, and every descendant inherits them. /proc/<pid>/environ therefore answers "which pane
// is this process in?" exactly, with no name matching. zellij's own `list-panes --json --all` then
// maps pane id -> tab id / tab name / title (its `pane_cwd` and `terminal_command` are unreliable
// for agent panes and are NOT used for attribution here).
//
// The classification rules are a port of Deckard's `crates/deckard-mux/src/proc.rs`, which solved
// this first and is the reference contract (AGENT_CLIS, `agent_cli`, zombie exclusion, the
// negative-result cache). Where this file differs from it, the comment says why.
//
// ## Fail open
//
// Like Deckard, nothing here throws for a process that vanishes mid-walk, an entry /proc will not
// let us read, a malformed stat or a half-written session file: that is one process (or one
// session id) skipped.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ZCRANK_SESSION, defaultShell, parseListPanes, projectIdentity, runListPanes, type IdentityBudget, type IdentityCache, type Shell } from "./index";

// ---------------------------------------------------------------------------
// Agent classification (port of deckard-mux/src/proc.rs `AGENT_CLIS` / `agent_cli`)
// ---------------------------------------------------------------------------

/**
 * argv basenames that mean "an interactive agent CLI is running here". Same list as Deckard's
 * AGENT_CLIS (every CLI with a bloodbank hook adapter). `gemini` and `openclaw` are node/python
 * scripts whose argv[0] is the interpreter, so they are found by the argv pass instead.
 */
export const AGENT_CLIS: readonly string[] = [
  "claude", "codex", "copilot", "opencode", "aider", "hermes", "agy", "kimi-code", "kimi-co", "gemini", "openclaw",
  // Not in Deckard's list: the Kimi binary on the operator box is `~/.kimi-code/bin/kimi` (argv[0]
  // basename `kimi`), which neither `kimi-code` nor `kimi-co` prefixes. Listed after them so the
  // reported name stays `kimi-code` where Deckard would say it.
  "kimi",
];

/**
 * Which agent CLI, if any, this process is. Two passes, because agents do not all keep their
 * identity in argv[0]: `claude` re-execs as `~/.local/share/claude/versions/2.1.235 --agent-...`,
 * so the basename is a version number and only the PATH still says `claude`.
 *
 * An MCP server is a tool the agent launched, not an agent session (a lingering `codex mcp-server`
 * would otherwise keep a pane an agent pane forever; Deckard measured exactly that), so it is
 * never classified.
 */
export function agentCli(exe: string, argv: string): string | null {
  if (argv.includes("mcp-server") || argv.includes(" mcp ")) return null;
  const byName = AGENT_CLIS.find((pat) => exe === pat || exe.startsWith(pat));
  if (byName) return byName;
  // The path pass. Deckard matches a bare `/<cli>` anywhere in argv; measured on this box that
  // also matches things that merely MENTION an agent: Claude Code's Bash-tool shells
  // (`zsh -c source ~/.claude/shell-snapshots/... tail -f ~/.claude/tmp/claude-1000/...`) and the
  // `tail -f` they run. Counted as agents they would pad every busy pane with bogus nested
  // "agents" and make an agent-less pane look like an agent pane. Two narrowings:
  //  - a shell running `-c <command>` is a command runner, never the agent itself;
  //  - `/<cli>` must END a path component: end, space, `/` or `.`, or one of the component
  //    suffixes agents really install under (PATH_SUFFIXES). `/claude-1000` (a tmp dir) is not
  //    `/claude`, while `.../claude/versions/2.1.235`, `.../gemini.js`, `.../claude-code/cli.js`,
  //    `.../gemini-cli/dist/index.js` and `.../hermes-agent/.venv/bin/python` are.
  if (SHELLS.has(exe) && argv.split(" ")[1] === "-c") return null;
  return PATH_PASS.find(([, re]) => re.test(argv))?.[0] ?? null;
}

/** Install-directory suffixes an agent's path component may carry: claude-code, gemini-cli, hermes-agent. */
const PATH_SUFFIXES = ["code", "cli", "agent"] as const;
const PATH_PASS: ReadonlyArray<readonly [string, RegExp]> = AGENT_CLIS.map((pat) => {
  const name = pat.replace(/[-]/g, "\\-");
  const end = "(?=$|[ /.])";
  return [pat, new RegExp(`/${name}(?:${end}|-(?:${PATH_SUFFIXES.join("|")})${end})`)] as const;
});

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);

// ---------------------------------------------------------------------------
// The /proc walker (port of Deckard's `Scanner`)
// ---------------------------------------------------------------------------

/** The fields of /proc/<pid>/stat this module needs. */
export interface ProcStat {
  /** The kernel's name for the executable (stat field 2). It changes on `exec`, which is what makes it a cache key. */
  comm: string;
  /** R, S, D, Z, T ... Z is the one that matters: a zombie is not a working agent. */
  state: string;
  ppid: number;
  /** Process group of the process. */
  pgrp: number;
  /** Foreground process group of the controlling terminal; -1 when there is none. */
  tpgid: number;
  /** Field 22: clock ticks since boot at which the process started. A string, as Claude writes `procStart`. */
  startTime: string;
}

/**
 * Parse /proc/<pid>/stat text. Everything is read AFTER THE LAST `)`: `comm` may contain spaces
 * and parentheses, and splitting from the left is the classic way to get this wrong (a process
 * named `foo )bar` is enough). After the paren, field 3 (state) is index 0, so field n is n-3.
 */
export function parseProcStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (close < 0 || open < 0 || open > close) return null;
  const comm = text.slice(open + 1, close);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  const startTime = fields[19];
  if (!state || !startTime || ![ppid, pgrp, tpgid].every(Number.isInteger)) return null;
  return { comm, state, ppid, pgrp, tpgid, startTime };
}

/** Stat of a live pid, or null when it vanished or cannot be read. */
export function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "latin1"));
  } catch {
    return null;
  }
}

/** One process that carries a zellij pane tag. */
export interface TaggedProc {
  pid: number;
  /** ZELLIJ_PANE_ID: the join key. */
  paneId: number;
  /** ZELLIJ_SESSION_NAME; null when the process has none. */
  session: string | null;
  /** argv, space-joined. Immutable for the process's life. */
  argv: string;
  /** argv[0]'s basename, which is what identifies an agent CLI. */
  exe: string;
  /** Re-read every pass: a pane can `cd`. */
  cwd: string | null;
  stat: ProcStat;
}

/** The pane tag a process carries. */
interface PaneTag {
  paneId: number;
  session: string | null;
}

/** Read the zellij tag from /proc/<pid>/environ. null = this process is not in a zellij pane. */
function readTag(pid: number): PaneTag | null {
  let raw: Buffer;
  try {
    // environ is NUL-separated and NOT valid UTF-8 in general: read bytes, so one odd variable
    // elsewhere in the block cannot lose the pane id.
    raw = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return null;
  }
  let paneId: number | null = null;
  let session: string | null = null;
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0, start);
    if (end < 0) end = raw.length;
    const eq = raw.indexOf(0x3d, start);
    if (eq >= 0 && eq < end) {
      const key = raw.toString("latin1", start, eq);
      if (key === "ZELLIJ_PANE_ID") {
        const value = raw.toString("utf8", eq + 1, end);
        paneId = /^\d+$/.test(value) ? Number(value) : null;
      } else if (key === "ZELLIJ_SESSION_NAME") {
        session = raw.toString("utf8", eq + 1, end);
      }
    }
    start = end + 1;
  }
  // The tag is the whole point. No pane id, nothing to attribute.
  return paneId === null ? null : { paneId, session };
}

/** argv (space-joined) and argv[0]'s basename from /proc/<pid>/cmdline; empty when unreadable. */
function readArgv(pid: number): { argv: string; exe: string } {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { argv: parts.join(" "), exe: parts[0] ? basename(parts[0]) : "" };
  } catch {
    return { argv: "", exe: "" };
  }
}

/**
 * A /proc walker with a per-pid cache, INCLUDING the negative result: on a typical box ~96% of
 * pids are not in a zellij pane, so remembering that is the optimisation (Deckard measured 21.7 ms
 * cold vs 5.7 ms warm over 2400 pids; without negative caching it is ~70 ms/s of pure syscall
 * churn). `cwd` is re-read every pass, because a pane can `cd`.
 *
 * What is cached is the pane TAG (from `environ`), nothing else, and it is keyed on the process's
 * identity, not just its pid. Two divergences from Deckard, which keys on pid alone and calls
 * argv "immutable for the process's life":
 *  - argv is NOT immutable. `exec` replaces it (`sh -c 'sleep 1; exec claude'` is a shell, then an
 *    agent, with the same pid), so a tagged process's cmdline is re-read every pass (it is ~100
 *    processes, not ~2400). The one exception is a zombie, whose cmdline is gone: its last known
 *    argv is kept, which is why the explicit zombie check in the inventory matters.
 *  - the cache key is (pid, starttime, comm). starttime changes when a pid is REUSED by a new
 *    process, so a dead agent's pane tag can never be attributed to its successor; comm changes on
 *    `exec`, which also replaces the environment, so the tag is re-read then. All three come from
 *    the `stat` this walker reads for every pid anyway (it needs state, pgrp and tpgid).
 *
 * Reuse one scanner across passes. A fresh one every tick pays the cold cost every tick.
 */
export class ProcScanner {
  private readonly known = new Map<number, { startTime: string; comm: string; tag: PaneTag | null; argv: string; exe: string }>();

  /** How many pids the cache holds (negatives included). For the cost report and tests. */
  cached(): number {
    return this.known.size;
  }

  /** Is `pid` in the cache, as a tagged process or a remembered negative? */
  has(pid: number): boolean {
    return this.known.has(pid);
  }

  /**
   * Every process in `session` that carries a pane tag. A process whose ZELLIJ_SESSION_NAME names
   * a DIFFERENT session is dropped; one with no session name at all is kept (`session: null`),
   * because zellij has not always set it and dropping it would lose real agents (Deckard's rule).
   * That also keeps processes some other tool started under `env -u ZELLIJ_SESSION_NAME` (e.g.
   * a `zellij action list-panes` run from a pane): they carry a pane id and no session, and are
   * not agents, so classification discards them.
   */
  scan(session: string): TaggedProc[] {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      // No /proc (not Linux, or a sandbox): zero evidence is a valid answer.
      return [];
    }
    const alive = new Set<number>();
    const out: TaggedProc[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      alive.add(pid);
      const stat = readProcStat(pid);
      if (!stat) continue;
      let slot = this.known.get(pid);
      if (!slot || slot.startTime !== stat.startTime || slot.comm !== stat.comm) {
        const tag = readTag(pid);
        slot = { startTime: stat.startTime, comm: stat.comm, tag, ...(tag ? readArgv(pid) : { argv: "", exe: "" }) };
        this.known.set(pid, slot);
      } else if (slot.tag && stat.state !== "Z") {
        Object.assign(slot, readArgv(pid));
      }
      const tag = slot.tag;
      if (!tag) continue;
      if (tag.session !== null && tag.session !== session) continue;
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // unreadable: unknown, not empty
      }
      out.push({ pid, paneId: tag.paneId, session: tag.session, argv: slot.argv, exe: slot.exe, cwd, stat });
    }
    // Forget the dead, so the cache tracks the box rather than growing for the life of the scanner.
    for (const pid of this.known.keys()) if (!alive.has(pid)) this.known.delete(pid);
    return out.sort((a, b) => a.pid - b.pid);
  }
}

// ---------------------------------------------------------------------------
// Claude Code session files (~/.claude/sessions/<pid>.json)
// ---------------------------------------------------------------------------

export type PaneStatus = "busy" | "idle" | "shell" | "unknown";
const PANE_STATUSES: readonly string[] = ["busy", "idle", "shell"];

/** Why a pane has no session id. `unresolved` is the honest answer for agents we cannot link. */
export type SessionReason =
  | "unresolved" // agent CLI with no verified pid -> session link (OpenCode, Codex, Kimi, ...): never guessed
  | "no-session-file" // claude, but ~/.claude/sessions/<pid>.json does not exist
  | "stale-session-file" // procStart does not match the live process: pid reuse, file ignored
  | "unreadable-session-file" // present but not JSON or not an object
  | "no-session-id"; // a valid file with no sessionId in it

export interface ClaudeSessionInfo {
  sessionId: string | null;
  reason: SessionReason | null;
  status: PaneStatus;
  statusUpdatedAt: number | null;
}

/** The Claude session directory; PJ_CLAUDE_SESSIONS_DIR overrides it (tests, a relocated ~/.claude). */
export function claudeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PJ_CLAUDE_SESSIONS_DIR?.trim();
  return override || join(homedir(), ".claude", "sessions");
}

/**
 * What Claude Code says about the process `pid`. The file is trusted only when its `procStart`
 * equals the live process's starttime (stat field 22): a mismatch means the pid was reused by a
 * different process since Claude wrote it, and a stale session id must never be attributed.
 */
export function readClaudeSession(pid: number, stat: ProcStat | null, dir: string = claudeSessionsDir()): ClaudeSessionInfo {
  const none = (reason: SessionReason): ClaudeSessionInfo => ({ sessionId: null, reason, status: "unknown", statusUpdatedAt: null });
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${pid}.json`), "utf8");
  } catch {
    return none("no-session-file");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return none("unreadable-session-file");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return none("unreadable-session-file");
  const file = data as Record<string, unknown>;
  const procStart = file.procStart === undefined || file.procStart === null ? "" : String(file.procStart);
  if (!stat || !procStart || procStart !== stat.startTime) return none("stale-session-file");
  const sessionId = typeof file.sessionId === "string" && file.sessionId ? file.sessionId : null;
  const status = typeof file.status === "string" && PANE_STATUSES.includes(file.status) ? (file.status as PaneStatus) : "unknown";
  const at = Number(file.statusUpdatedAt);
  return {
    sessionId,
    reason: sessionId ? null : "no-session-id",
    status,
    statusUpdatedAt: file.statusUpdatedAt !== undefined && file.statusUpdatedAt !== null && Number.isFinite(at) ? at : null,
  };
}

// ---------------------------------------------------------------------------
// zellij pane table (read-only: list-panes is the only zellij action used)
// ---------------------------------------------------------------------------

export interface PaneTableEntry {
  tabId: number | null;
  tabPosition: number | null;
  tabName: string | null;
  title: string | null;
}

/**
 * Terminal pane id -> tab id / tab name / title from `zellij action list-panes --json --all` for
 * `session`, through the same command line and the same parser as `livePanes` in ./index. Plugin
 * panes are skipped: their ids live in a different namespace from ZELLIJ_PANE_ID, so a plugin 5
 * must never be taken for terminal 5.
 *
 * `ok` is false, with `error` saying why, when zellij could not be read: a missing binary, a
 * failing command (a session that does not exist), output that is not a pane list, OR an empty
 * list. A live session always has at least one pane (its tab bar), so `[]` means not-a-session or
 * an unreadable answer, never "a session with nothing in it".
 */
export function readPaneTable(session: string, shell: Shell = defaultShell): { ok: boolean; error: string | null; panes: Map<number, PaneTableEntry> } {
  const panes = new Map<number, PaneTableEntry>();
  const result = runListPanes(session, shell);
  if (result.status !== 0) return { ok: false, error: `zellij list-panes failed for session "${session}" (exit ${result.status}): no such session, or zellij is not installed`, panes };
  const listed = parseListPanes(result.stdout);
  if (!listed) return { ok: false, error: `zellij list-panes for session "${session}" printed no pane list`, panes };
  if (!listed.length) return { ok: false, error: `zellij list-panes for session "${session}" listed no panes at all: not a live session`, panes };
  for (const pane of listed) {
    if (pane.isPlugin || !Number.isInteger(pane.id)) continue;
    panes.set(pane.id, { tabId: pane.tabId ?? null, tabPosition: pane.tabPosition ?? null, tabName: pane.tabName, title: pane.title });
  }
  return { ok: true, error: null, panes };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface NestedAgent {
  pid: number;
  agent: string;
}

export interface AgentPane {
  /** The zellij session the pane lives in. */
  session: string;
  tabId: number | null;
  tabName: string | null;
  paneId: number;
  paneTitle: string | null;
  /** The chosen agent process; null only for a pane with no agent (`--all`). */
  pid: number | null;
  /** claude, codex, ...; null for a pane with no agent (`--all`). */
  agent: string | null;
  /** /proc/<pid>/cwd of the chosen agent. */
  cwd: string | null;
  /** projectIdentity(cwd): the main worktree of the repo holding cwd. */
  project: string | null;
  sessionId: string | null;
  /** Set exactly when sessionId is null and there is an agent. */
  sessionReason: SessionReason | null;
  status: PaneStatus;
  statusUpdatedAt: number | null;
  /** Other live agent processes in the same pane that were not chosen. */
  nested: NestedAgent[];
}

/** Where the session name came from: the caller, $ZELLIJ_SESSION_NAME (we are inside zellij), or the crank's default. */
export type SessionSource = "option" | "ZELLIJ_SESSION_NAME" | "default";

/**
 * The inventory, as an envelope so a consumer can tell "unknown" from "none":
 * `zellijReadable: false` means pj could not learn which panes exist (`panes` is then EMPTY and
 * means nothing), while `zellijReadable: true` with `panes: []` is a real "no agent panes".
 */
export interface PaneInventory {
  session: string;
  sessionSource: SessionSource;
  /** False when zellij's pane table could not be read; see `error`. `panes` is then empty. */
  zellijReadable: boolean;
  /** Why zellij was unreadable; null when it was readable. */
  error: string | null;
  /**
   * Pane ids that carry a live agent process tagged with this session but that zellij does not
   * list: closed panes, or panes opened/closed between the /proc scan and the zellij read.
   * Measured on the operator box: Claude's background daemon and the sessions it hosts keep the
   * ZELLIJ_* environment of whichever pane first started the daemon, long after that pane closed.
   * Never in `panes`; reported so the discrepancy is visible.
   */
  unmappedPaneIds: number[];
  panes: AgentPane[];
}

export interface DiscoverOptions {
  /** Default: $ZELLIJ_SESSION_NAME, else the crank's session ("Workspace"). */
  session?: string;
  /** Also list terminal panes with no agent (agent: null). */
  all?: boolean;
  shell?: Shell;
  /** Reuse across calls to keep the negative-result cache warm. */
  scanner?: ProcScanner;
  /** Default: claudeSessionsDir(). */
  sessionsDir?: string;
  identityCache?: IdentityCache;
}

/** Total git time one scan may spend resolving project identities (same figure as ./index). */
const IDENTITY_BUDGET_MS = 20_000;

interface Candidate {
  proc: TaggedProc;
  agent: string;
  foreground: boolean;
  claude: ClaudeSessionInfo | null;
}

/**
 * The one candidate that speaks for its pane.
 *
 * 1. The agent in the terminal's FOREGROUND process group (stat pgrp == tpgid) wins: it is the one
 *    the operator is looking at and typing to.
 * 2. When several share that group (a wrapper and the real agent it exec'd, or an agent and a
 *    helper it spawned under the same path), the one with a TRUSTED Claude session file wins,
 *    because that is the only candidate we can name a session for; then the newest.
 * 3. When NONE is foreground (a backgrounded agent, or the shell is waiting on something else) the
 *    NEWEST by starttime wins. A pane's agents are started one after another from its shell, so
 *    the latest start is the one most recently put there by the operator; an older survivor is
 *    typically a leftover. That is a heuristic, which is why it only applies when the kernel gives
 *    no better answer, and the losers are reported as nested, never dropped.
 */
function chooseCandidate(candidates: Candidate[]): Candidate {
  const start = (c: Candidate): number => Number(c.proc.stat.startTime);
  const trusted = (c: Candidate): number => (c.claude?.sessionId ? 1 : 0);
  return [...candidates].sort(
    (a, b) =>
      Number(b.foreground) - Number(a.foreground) ||
      (a.foreground && b.foreground ? trusted(b) - trusted(a) : 0) ||
      start(b) - start(a) ||
      b.proc.pid - a.proc.pid,
  )[0] as Candidate; // callers pass a non-empty list
}

/** The inventory: one record per live agent pane of `session`, plus agent-less panes with `all`. */
export function inventoryPanes(options: DiscoverOptions = {}): PaneInventory {
  const fromOption = options.session?.trim();
  const fromEnv = process.env.ZELLIJ_SESSION_NAME?.trim();
  const session = fromOption || fromEnv || ZCRANK_SESSION;
  const sessionSource: SessionSource = fromOption ? "option" : fromEnv ? "ZELLIJ_SESSION_NAME" : "default";
  const shell = options.shell ?? defaultShell;
  const sessionsDir = options.sessionsDir ?? claudeSessionsDir();
  const scanner = options.scanner ?? new ProcScanner();
  const identityCache: IdentityCache = options.identityCache ?? new Map();
  const budget: IdentityBudget = { totalMs: IDENTITY_BUDGET_MS };

  // /proc FIRST, then zellij's pane table (which takes ~4 s). The other order leaves a window in
  // which a pane opened after the table was read shows up in /proc and is mislabelled unmapped;
  // this way a pane that is in the scan but not the table was closed in the window, or is a ghost.
  const procs = scanner.scan(session);
  const table = readPaneTable(session, shell);
  if (!table.ok) {
    // pj cannot say which panes exist, so it says nothing about them: an empty list here means
    // "unknown", and `zellijReadable: false` is what tells a consumer so.
    return { session, sessionSource, zellijReadable: false, error: table.error, unmappedPaneIds: [], panes: [] };
  }

  // Live (non-zombie) agent processes, grouped by pane. A zombie is not a working agent.
  const byPane = new Map<number, Candidate[]>();
  for (const proc of procs) {
    if (proc.stat.state === "Z") continue;
    const agent = agentCli(proc.exe, proc.argv);
    if (!agent) continue;
    const claude = agent === "claude" ? readClaudeSession(proc.pid, proc.stat, sessionsDir) : null;
    const candidate: Candidate = { proc, agent, foreground: proc.stat.tpgid > 0 && proc.stat.pgrp === proc.stat.tpgid, claude };
    const list = byPane.get(proc.paneId);
    if (list) list.push(candidate);
    else byPane.set(proc.paneId, [candidate]);
  }

  const rows: { row: AgentPane; position: number }[] = [];
  const unmappedPaneIds: number[] = [];
  for (const [paneId, candidates] of byPane) {
    // A pane zellij does not list is not a live pane, whatever its processes' environ still says.
    if (!table.panes.has(paneId)) {
      unmappedPaneIds.push(paneId);
      continue;
    }
    const chosen = chooseCandidate(candidates);
    const entry = table.panes.get(paneId);
    const cwd = chosen.proc.cwd;
    // Only Claude Code has a verified pid -> session link. OpenCode, Codex and Kimi get
    // `unresolved`: guessing (newest file in some dir, a matching cwd) would attribute the wrong
    // session to a pane, which is worse than saying nothing.
    const info: ClaudeSessionInfo =
      chosen.claude ?? { sessionId: null, reason: "unresolved", status: "unknown", statusUpdatedAt: null };
    rows.push({
      position: entry?.tabPosition ?? Number.MAX_SAFE_INTEGER,
      row: {
        session,
        tabId: entry?.tabId ?? null,
        tabName: entry?.tabName ?? null,
        paneId,
        paneTitle: entry?.title ?? null,
        pid: chosen.proc.pid,
        agent: chosen.agent,
        cwd,
        project: (cwd ? projectIdentity(cwd, { shell, cache: identityCache, budget }) : undefined) ?? null,
        sessionId: info.sessionId,
        sessionReason: info.sessionId ? null : info.reason,
        status: info.status,
        statusUpdatedAt: info.statusUpdatedAt,
        nested: candidates
          .filter((c) => c !== chosen)
          .map((c) => ({ pid: c.proc.pid, agent: c.agent }))
          .sort((a, b) => a.pid - b.pid),
      },
    });
  }

  if (options.all) {
    for (const [paneId, entry] of table.panes) {
      if (byPane.has(paneId)) continue;
      rows.push({
        position: entry.tabPosition ?? Number.MAX_SAFE_INTEGER,
        row: {
          session, tabId: entry.tabId, tabName: entry.tabName, paneId, paneTitle: entry.title,
          pid: null, agent: null, cwd: null, project: null,
          sessionId: null, sessionReason: null, status: "unknown", statusUpdatedAt: null, nested: [],
        },
      });
    }
  }

  rows.sort((a, b) => a.position - b.position || a.row.paneId - b.row.paneId);
  return { session, sessionSource, zellijReadable: true, error: null, unmappedPaneIds: unmappedPaneIds.sort((a, b) => a - b), panes: rows.map((r) => r.row) };
}

/** One record per live agent pane in the session (see {@link inventoryPanes}). */
export function discoverAgentPanes(options: DiscoverOptions = {}): AgentPane[] {
  return inventoryPanes(options).panes;
}

// ---------------------------------------------------------------------------
// Rendering (plain text; the CLI colours nothing here so the columns stay aligned in a pipe)
// ---------------------------------------------------------------------------

/** `~`-shortened path for display. */
function tilde(path: string | null): string {
  if (!path) return "-";
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Terminal display width of `text` in columns: wide (CJK) and emoji code points take 2, combining
 * marks, variation selectors, ZWJ and zero-width characters take 0. Counting code points instead
 * misaligns every tab named `ipm 🟢`. A small local function rather than the `string-width`
 * package: that one sits in node_modules only transitively (Ink brings its own, a different
 * major), and pjangler does not declare it.
 */
export function displayWidth(text: string): number {
  let width = 0;
  let joined = false; // the previous code point was a ZWJ: this one fuses into the same emoji
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (joined && /^\p{Extended_Pictographic}$/u.test(ch)) {
      joined = false;
      continue;
    }
    joined = cp === 0x200d;
    if (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(ch) || cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // zero width
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // control
    const wide =
      /^\p{Emoji_Presentation}$/u.test(ch) || // 🟢 🔴 and friends
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK, kana, Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * A fixed-column table: TAB, PANE, PID, AGENT, PROJECT, STATUS, SESSION, NESTED. PID is the
 * process that speaks for the pane; NESTED lists the other agent processes as `agent:pid`.
 */
export function formatPaneTable(inventory: PaneInventory): string {
  const header = ["TAB", "PANE", "PID", "AGENT", "PROJECT", "STATUS", "SESSION", "NESTED"];
  const rows = inventory.panes.map((p) => [
    p.tabName ?? "-",
    String(p.paneId),
    p.pid === null ? "-" : String(p.pid),
    p.agent ?? "(no agent)",
    tilde(p.project ?? p.cwd),
    p.agent ? p.status : "-",
    p.sessionId ?? (p.agent ? `- (${p.sessionReason})` : "-"),
    p.nested.length ? p.nested.map((n) => `${n.agent}:${n.pid}`).join(",") : "-",
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))));
  const line = (cells: string[]) => cells.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(c)))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
