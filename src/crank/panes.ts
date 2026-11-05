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
import { ZCRANK_SESSION, defaultShell, projectIdentity, type IdentityBudget, type IdentityCache, type Shell } from "./index";

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
  // "agents" and make an agent-less pane look like an agent pane. Two narrowings, both of which
  // keep every Deckard test case classified the same:
  //  - a shell running `-c <command>` is a command runner, never the agent itself;
  //  - `/<cli>` must END a path component (end, space, `/` or `.`), so `/claude-1000` is not
  //    `/claude`, while `.../claude/versions/2.1.235` and `.../gemini.js` still are.
  if (SHELLS.has(exe) && argv.split(" ")[1] === "-c") return null;
  return AGENT_CLIS.find((pat) => new RegExp(`/${pat.replace(/[-]/g, "\\-")}(?=$|[ /.])`).test(argv)) ?? null;
}

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);

// ---------------------------------------------------------------------------
// The /proc walker (port of Deckard's `Scanner`)
// ---------------------------------------------------------------------------

/** The fields of /proc/<pid>/stat this module needs. */
export interface ProcStat {
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
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  const startTime = fields[19];
  if (!state || !startTime || ![ppid, pgrp, tpgid].every(Number.isInteger)) return null;
  return { state, ppid, pgrp, tpgid, startTime };
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

interface Immutable {
  paneId: number;
  session: string | null;
  argv: string;
  exe: string;
}

/** Read the immutable pair once. null = this process is not in a zellij pane. */
function inspect(pid: number): Immutable | null {
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
  if (paneId === null) return null;
  let parts: string[] = [];
  try {
    parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    // vanished between environ and cmdline: classified as not-an-agent below (empty argv)
  }
  return { paneId, session, argv: parts.join(" "), exe: parts[0] ? basename(parts[0]) : "" };
}

/**
 * A /proc walker with a per-pid cache of the immutable facts (`environ`, `cmdline`), INCLUDING the
 * negative result: on a typical box ~96% of pids are not in a zellij pane, so remembering that is
 * the whole optimisation (Deckard measured 21.7 ms cold vs 5.7 ms warm over 2400 pids; without
 * negative caching it is ~70 ms/s of pure syscall churn). `cwd` is the one thing re-read each
 * pass, because a pane can `cd`.
 *
 * Divergence from Deckard: its cache is keyed by pid alone. A pid that is reused between passes
 * would then keep the OLD process's pane tag. This walker reads `stat` for every pid anyway (it
 * needs state, pgrp and tpgid), so it keys the cache on (pid, starttime) at no extra syscall, and
 * pid reuse refreshes the entry. A one-shot `pj crank panes` never reuses the cache; a later
 * long-lived consumer (the zcrank engine slice) does, which is why the class exists.
 *
 * Reuse one scanner across passes. A fresh one every tick pays the cold cost every tick.
 */
export class ProcScanner {
  private readonly known = new Map<number, { startTime: string; imm: Immutable | null }>();

  /** How many pids the cache holds (negatives included). For the cost report and tests. */
  cached(): number {
    return this.known.size;
  }

  /**
   * Every process in `session` that carries a pane tag. A process whose ZELLIJ_SESSION_NAME names
   * a DIFFERENT session is dropped; one with no session name at all is kept, because zellij has
   * not always set it and dropping it would lose real agents (Deckard's rule).
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
      if (!slot || slot.startTime !== stat.startTime) {
        slot = { startTime: stat.startTime, imm: inspect(pid) };
        this.known.set(pid, slot);
      }
      const imm = slot.imm;
      if (!imm) continue;
      if (imm.session !== null && imm.session !== session) continue;
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // unreadable: unknown, not empty
      }
      out.push({ pid, paneId: imm.paneId, session: imm.session, argv: imm.argv, exe: imm.exe, cwd, stat });
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
 * `session`. Plugin panes are skipped: their ids live in a different namespace from
 * ZELLIJ_PANE_ID, so a plugin 5 must never be taken for terminal 5. `ok` is false when zellij
 * could not be read, so the CLI can say so instead of printing tab-less rows silently.
 *
 * `env -u ZELLIJ -u ZELLIJ_SESSION_NAME` is required (zellij refuses to act on itself from inside
 * a pane) and `timeout 8s` bounds a wedged daemon (list-panes takes ~4s); both as in ./index.
 */
export function readPaneTable(session: string, shell: Shell = defaultShell): { ok: boolean; panes: Map<number, PaneTableEntry> } {
  const panes = new Map<number, PaneTableEntry>();
  const result = shell("env", ["-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME", "timeout", "8s", "zellij", "-s", session, "action", "list-panes", "--json", "--all"]);
  if (result.status !== 0 || !result.stdout.trim()) return { ok: false, panes };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, panes };
  }
  if (!Array.isArray(parsed)) return { ok: false, panes };
  const int = (value: unknown): number | null => (value !== undefined && value !== null && Number.isInteger(Number(value)) ? Number(value) : null);
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.is_plugin === true) continue;
    const id = int(e.id);
    if (id === null) continue;
    panes.set(id, {
      tabId: int(e.tab_id),
      tabPosition: int(e.tab_position),
      tabName: typeof e.tab_name === "string" ? e.tab_name : null,
      title: typeof e.title === "string" ? e.title : null,
    });
  }
  return { ok: true, panes };
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

export interface PaneInventory {
  session: string;
  /** False when zellij's pane table could not be read (rows then carry no tab). */
  zellijReadable: boolean;
  panes: AgentPane[];
  /**
   * Pane ids that carry a live agent process tagged with this session but that zellij does not
   * list: not live panes. Measured on the operator box: Claude's background daemon and the
   * sessions it hosts keep the ZELLIJ_* environment of whichever pane first started the daemon,
   * long after that pane closed. Never in `panes`; reported so the discrepancy is visible.
   */
  unmappedPaneIds: number[];
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
  const session = options.session?.trim() || process.env.ZELLIJ_SESSION_NAME?.trim() || ZCRANK_SESSION;
  const shell = options.shell ?? defaultShell;
  const sessionsDir = options.sessionsDir ?? claudeSessionsDir();
  const table = readPaneTable(session, shell);
  const scanner = options.scanner ?? new ProcScanner();
  const identityCache: IdentityCache = options.identityCache ?? new Map();
  const budget: IdentityBudget = { totalMs: IDENTITY_BUDGET_MS };

  // Live (non-zombie) agent processes, grouped by pane. A zombie is not a working agent.
  const byPane = new Map<number, Candidate[]>();
  for (const proc of scanner.scan(session)) {
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
    // Only enforceable when zellij could be read; otherwise the /proc evidence stands alone.
    if (table.ok && !table.panes.has(paneId)) {
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
  return { session, zellijReadable: table.ok, panes: rows.map((r) => r.row), unmappedPaneIds: unmappedPaneIds.sort((a, b) => a - b) };
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

/** A fixed-column table: TAB, PANE, AGENT, PROJECT, STATUS, SESSION (+ nested agents). */
export function formatPaneTable(inventory: PaneInventory): string {
  const header = ["TAB", "PANE", "AGENT", "PROJECT", "STATUS", "SESSION"];
  const rows = inventory.panes.map((p) => [
    p.tabName ?? "-",
    String(p.paneId),
    p.agent ? (p.nested.length ? `${p.agent} (+${p.nested.length} nested)` : p.agent) : "(no agent)",
    tilde(p.project ?? p.cwd),
    p.agent ? p.status : "-",
    p.sessionId ?? (p.agent ? `- (${p.sessionReason})` : "-"),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => [...(r[i] ?? "")].length)));
  const line = (cells: string[]) => cells.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - [...c].length))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
