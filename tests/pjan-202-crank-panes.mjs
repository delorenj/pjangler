import "./helpers/hermetic-suite.mjs";
// PJAN-202 — `pj crank panes`: the exact, read-only inventory of live agent panes.
//
// No fixtures for the process side. Every agent here is a REAL long-lived process whose argv[0]
// basename is an agent name (a tmp symlink named `claude`, `opencode`, ... pointing at `sleep`
// or node), carrying a test-unique ZELLIJ_SESSION_NAME and a ZELLIJ_PANE_ID, with a Claude
// session file written for its real pid and its real procStart (stat field 22) into a test-owned
// directory chosen by PJ_CLAUDE_SESSIONS_DIR / the `sessionsDir` option. The zellij side is the
// real list-panes capture committed under tests/data (tests/pjan-201-*), served through the same
// `Shell` seam the crank code already uses; the CLI half goes through a `zellij` on PATH that
// prints that same capture.
//
// The foreground-process-group rule needs a real controlling terminal, so those processes are
// started under a python pty.fork() helper (a session leader whose group is the tty's foreground
// group, plus a child in its own group that is not). Every process this suite spawns is killed in
// the finally block. Nothing here touches Redis or any zellij action.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = hermeticScratch("pjan-202");
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");

writeFileSync(join(scratch, "entry.ts"), `export * from ${JSON.stringify(join(root, "src/crank/panes.ts"))};\nexport { defaultShell } from ${JSON.stringify(join(root, "src/crank/index.ts"))};\n`);
const kit = join(scratch, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(scratch, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kit}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the panes kit:\n${built.stderr}`);
  process.exit(1);
}
const { AGENT_CLIS, ProcScanner, agentCli, claudeSessionsDir, defaultShell, discoverAgentPanes, formatPaneTable, inventoryPanes, parseProcStat, readClaudeSession, readProcStat } = await import(kit);

const which = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();
const SLEEP = which("sleep");
const GIT = which("git");
assert.ok(SLEEP && GIT, "sleep and git must exist");

const SESSION = `pjan-202-test-${process.pid}-${Date.now()}`;
const sessionsDir = join(scratch, "claude-sessions");
mkdirSync(sessionsDir);
const livePanesJson = readFileSync(join(root, "tests", "data", "pjan-201-live-list-panes.json"), "utf8");
const capture = JSON.parse(livePanesJson);
const capturePane = (id) => capture.find((p) => p.id === id && !p.is_plugin);

// A repo for the project-identity half: identity is the MAIN worktree of the repo holding the cwd.
const repo = join(scratch, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
assert.equal(spawnSync(GIT, ["init", "-q", repo], { env: hermeticEnv(), encoding: "utf8" }).status, 0);
const repoIdentity = realpathSync(repo);

// agent-named executables: symlinks whose basename is the agent
const bin = join(scratch, "bin");
mkdirSync(join(bin, "claude-home", "claude", "versions"), { recursive: true });
// Agent stand-ins are node: this box's coreutils (uutils) is multi-call by argv[0], so a `sleep`
// named `claude` exits at once, while node runs whatever its argv[0] says.
const IDLE = ["-e", "setInterval(() => {}, 1e6)"];
const link = (name, target = process.execPath) => {
  const path = join(bin, name);
  symlinkSync(target, path);
  return path;
};
const claude = link("claude");
const opencode = link("opencode");
const codexNode = link("codex");
const versioned = join(bin, "claude-home", "claude", "versions", "2.1.235");
symlinkSync(process.execPath, versioned);
const oddComm = link("a ) b 1 2 3");

const zellijShell = (command, args) => (args.includes("list-panes") ? { stdout: livePanesJson, status: 0 } : defaultShell(command, args));

const pids = new Set();
const children = [];
/** A real process in pane `pane` of `session`, argv[0] = `exe`. */
function agentIn(pane, exe, args = IDLE, { session = SESSION, cwd = repo, tag = true } = {}) {
  const env = hermeticEnv(tag ? { ZELLIJ_SESSION_NAME: session, ZELLIJ_PANE_ID: String(pane) } : {});
  const child = spawn(exe, args, { cwd, env, stdio: "ignore" });
  children.push(child);
  pids.add(child.pid);
  return child;
}
const startTime = (pid) => readFileSync(`/proc/${pid}/stat`, "latin1").split(")").pop().trim().split(/\s+/)[19];
const sessionFile = (pid, fields) => writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, kind: "interactive", ...fields }));
const stop = (child) => {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
};
const sleepMs = (ms) => new Promise((done) => setTimeout(done, ms));
const rowFor = (rows, pane) => rows.find((r) => r.paneId === pane);
const discover = (extra = {}) => discoverAgentPanes({ session: SESSION, shell: zellijShell, sessionsDir, ...extra });

let failed;
let pty;
let toolShellPid = 0;
try {
  console.log("agentCli: Deckard's classification contract, ported (proc.rs tests)");
  {
    assert.equal(agentCli("zsh", "zsh"), null);
    assert.equal(agentCli("cargo", "cargo watch -x test"), null);
    assert.equal(agentCli("claude", "claude"), "claude");
    assert.equal(agentCli("claude", "claude --dangerously-skip-permissions"), "claude");
    assert.equal(agentCli("codex", "codex exec"), "codex");
    // argv[0] is a version directory on a re-exec; only the path still says claude
    assert.equal(agentCli("2.1.235", "/home/me/.local/share/claude/versions/2.1.235 --agent-mode"), "claude");
    // node-launched agents
    assert.equal(agentCli("node", "node /home/me/.local/share/mise/installs/node/24.15.0/bin/gemini --yolo"), "gemini");
    assert.equal(
      agentCli("node", "/home/me/.local/share/mise/installs/node/24.15.0/bin/node --max-old-space-size=8192 /home/me/.local/share/mise/installs/node/24.15.0/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
      "gemini",
    );
    assert.equal(agentCli("gemini", "gemini -p hi"), "gemini");
    assert.equal(agentCli("node", "node /home/me/.local/share/pnpm/../../../code/openclaw/openclaw.mjs tui"), "openclaw");
    assert.equal(agentCli("python3", "python3 /home/me/.local/bin/openclaw"), "openclaw");
    // MCP servers are tools, not sessions
    assert.equal(agentCli("node", "node /home/me/code/gemini-mcp/dist/index.js mcp-server"), null);
    assert.equal(agentCli("node", "node /home/delorenj/.local/bin/codex mcp-server"), null);
    assert.equal(agentCli("codex", "codex mcp serve"), null);
    assert.ok(AGENT_CLIS.includes("kimi-code") && AGENT_CLIS.includes("opencode"));
  }

  console.log("agentCli: narrowings over Deckard (measured on the operator box) do not leak agents");
  {
    // Claude Code's Bash-tool shell and the tail it runs merely MENTION `claude-1000` / ~/.claude
    assert.equal(agentCli("zsh", "/usr/bin/zsh -c source /h/.claude/shell-snapshots/s.sh eval 'cd /h/code/claude/x'"), null, "a `-c` shell is a command runner");
    assert.equal(agentCli("tail", "tail -n +1 -f /h/.claude/tmp/claude-1000/-h-code-x/a6dbbf71.output"), null, "/claude-1000 is not /claude");
    // ...while a shebang script that IS the agent (argv[1] is the script, not -c) still counts
    assert.equal(agentCli("bash", "/bin/bash /h/.local/bin/claude --resume"), "claude");
  }

  console.log("parseProcStat: fields come from after the LAST `)` of a real process with a nasty comm");
  {
    const odd = agentIn(94, oddComm);
    const stat = readProcStat(odd.pid);
    assert.ok(stat, "stat of a live process parses");
    assert.ok(["R", "S"].includes(stat.state), `a live, unreaped process is running or sleeping, not ${stat.state}`);
    assert.equal(stat.ppid, process.pid, "a left-to-right split would shift every field after comm");
    assert.equal(stat.startTime, startTime(odd.pid));
    assert.equal(stat.tpgid, -1, "no controlling terminal");
    assert.equal(parseProcStat("1 (a (b) c) S 7 8 9 10 11"), null, "too short is null, not a throw");
    assert.equal(readProcStat(2 ** 22 + 12345), null, "a pid that does not exist is null");
  }

  console.log("a real claude pane: row from /proc + ZELLIJ_PANE_ID, session file with a matching procStart");
  const real = agentIn(94, claude, IDLE, { cwd: join(repo, "sub") });
  const stale = agentIn(146, claude);
  const noFile = agentIn(122, claude);
  const toolShell = spawn("sh", ["-c", `sleep 600; echo /home/x/claude-1000/y`], { cwd: repo, stdio: "ignore", env: hermeticEnv({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: "122" }) });
  children.push(toolShell);
  toolShellPid = toolShell.pid;
  pids.add(toolShell.pid);
  const reexec = agentIn(150, versioned);
  const mcp = agentIn(150, codexNode, [...IDLE, "mcp-server"]);
  const ocFile = agentIn(8, opencode);
  const first = agentIn(16, claude);
  await sleepMs(60); // starttime ticks are 10 ms: the second process must start in a LATER tick
  const second = agentIn(16, opencode);
  const plainSleep = agentIn(121, SLEEP, ["600"]);
  const mcpOnly = agentIn(121, codexNode, [...IDLE, "mcp-server"]);
  const otherSession = agentIn(140, claude, IDLE, { session: `${SESSION}-other` });
  const untagged = agentIn(0, claude, IDLE, { tag: false });
  const unmapped = agentIn(999, claude);
  sessionFile(real.pid, { sessionId: "11111111-1111-4111-8111-111111111111", cwd: repo, procStart: startTime(real.pid), status: "busy", statusUpdatedAt: 1793893404492 });
  sessionFile(stale.pid, { sessionId: "22222222-2222-4222-8222-222222222222", procStart: String(Number(startTime(stale.pid)) + 1), status: "busy", statusUpdatedAt: 1 });
  sessionFile(reexec.pid, { sessionId: "33333333-3333-4333-8333-333333333333", procStart: startTime(reexec.pid), status: "idle", statusUpdatedAt: 42 });
  sessionFile(ocFile.pid, { sessionId: "44444444-4444-4444-8444-444444444444", procStart: startTime(ocFile.pid), status: "busy", statusUpdatedAt: 5 });
  {
    const rows = discover();
    const r = rowFor(rows, 94);
    assert.ok(r, "pane 94 is a live agent pane");
    assert.equal(r.session, SESSION);
    assert.equal(r.pid, real.pid);
    assert.equal(r.agent, "claude");
    assert.equal(r.tabId, capturePane(94).tab_id, "tab id comes from list-panes");
    assert.equal(r.tabName, capturePane(94).tab_name);
    assert.equal(r.paneTitle, capturePane(94).title);
    assert.equal(r.cwd, join(repo, "sub"), "cwd is /proc/<pid>/cwd, not pane_cwd");
    assert.equal(r.project, repoIdentity, "project identity is the existing projectIdentity: the repo's main worktree");
    assert.equal(r.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(r.sessionReason, null);
    assert.equal(r.status, "busy");
    assert.equal(r.statusUpdatedAt, 1793893404492);
    assert.deepEqual(r.nested, []);

    console.log("a procStart that does not match the live process is ignored, never trusted");
    const s = rowFor(rows, 146);
    assert.equal(s.pid, stale.pid);
    assert.equal(s.sessionId, null);
    assert.equal(s.sessionReason, "stale-session-file");
    assert.equal(s.status, "unknown");
    assert.equal(s.statusUpdatedAt, null);

    console.log("no session file: null with a reason, and a non-agent shell/tool in the pane is not nested");
    const n = rowFor(rows, 122);
    assert.equal(n.pid, noFile.pid);
    assert.equal(n.sessionId, null);
    assert.equal(n.sessionReason, "no-session-file");
    assert.deepEqual(n.nested, [], "`sh -c ...; echo /claude-1000` and its sleep are not agents");

    console.log("a version-directory re-exec is still claude; an MCP server in the pane is a tool, not nested");
    const v = rowFor(rows, 150);
    assert.equal(v.pid, reexec.pid);
    assert.equal(v.agent, "claude");
    assert.equal(v.sessionId, "33333333-3333-4333-8333-333333333333");
    assert.equal(v.status, "idle");
    assert.deepEqual(v.nested, []);

    console.log("OpenCode (and Codex, Kimi): sessionId null, reason unresolved, even with a file for its pid");
    const o = rowFor(rows, 8);
    assert.equal(o.agent, "opencode");
    assert.equal(o.sessionId, null);
    assert.equal(o.sessionReason, "unresolved");
    assert.equal(o.status, "unknown");

    console.log("several agents, none in the foreground: the NEWEST by starttime speaks, the other is nested");
    const m = rowFor(rows, 16);
    assert.ok(Number(startTime(second.pid)) > Number(startTime(first.pid)), "premise: the second process started in a later tick");
    assert.equal(m.pid, second.pid);
    assert.equal(m.agent, "opencode");
    assert.deepEqual(m.nested, [{ pid: first.pid, agent: "claude" }]);
    assert.equal(rows.filter((x) => x.paneId === 16).length, 1, "nested agents are not extra panes");

    console.log("not agent panes: MCP-only, plain process, other session, no pane tag, pane zellij does not list");
    assert.equal(rowFor(rows, 121), undefined, "a pane holding only a plain process and an MCP server has no agent");
    assert.equal(rowFor(rows, 140), undefined, "a process tagged with another session is not this session's");
    for (const dead of [plainSleep, mcpOnly, otherSession, untagged, unmapped]) assert.ok(!rows.some((x) => x.pid === dead.pid || x.nested.some((q) => q.pid === dead.pid)));
    assert.deepEqual(rows.map((x) => x.paneId).sort((a, b) => a - b), [8, 16, 94, 122, 146, 150], "exactly the six agent panes");

    const inv = inventoryPanes({ session: SESSION, shell: zellijShell, sessionsDir });
    assert.equal(inv.zellijReadable, true);
    assert.deepEqual(inv.unmappedPaneIds, [999], "a pane id zellij does not list is reported, not listed");
    assert.deepEqual(
      inv.panes.map((x) => x.tabId),
      [...inv.panes.map((x) => x.tabId)].sort((a, b) => {
        const pos = (id) => capture.find((p) => p.tab_id === id).tab_position;
        return pos(a) - pos(b);
      }),
      "rows come in tab order",
    );
  }

  console.log("--all: agent-less terminal panes are listed and marked; plugin panes are never panes");
  {
    const rows = discover({ all: true });
    const terminals = capture.filter((p) => !p.is_plugin).length;
    assert.equal(rows.length, terminals, "every terminal pane once; the stale/unmapped ones are not extra");
    const none = rowFor(rows, 121);
    assert.equal(none.agent, null);
    assert.equal(none.pid, null);
    assert.equal(none.sessionId, null);
    assert.equal(none.sessionReason, null);
    assert.equal(none.tabName, capturePane(121).tab_name);
    assert.equal(rows.filter((x) => x.agent).length, 6);
    assert.equal(rows.some((x) => x.paneId === 5), false, "plugin pane 5 (tab-bar) shares no namespace with terminal 5");
  }

  console.log("zellij unreadable: /proc stands alone, rows carry no tab, and the inventory says so");
  {
    const dead = () => ({ stdout: "", status: 1 });
    const inv = inventoryPanes({ session: SESSION, shell: (c, a) => (a.includes("list-panes") ? dead() : defaultShell(c, a)), sessionsDir });
    assert.equal(inv.zellijReadable, false);
    const r = inv.panes.find((x) => x.paneId === 999);
    assert.ok(r, "without a pane table nothing can be called unmapped");
    assert.equal(r.tabId, null);
    assert.equal(r.tabName, null);
    assert.deepEqual(inv.unmappedPaneIds, []);
  }

  console.log("a zombie is not a working agent; an exited one is gone");
  {
    const victim = agentIn(21, claude);
    const gone = agentIn(21, opencode);
    assert.ok(rowFor(discover(), 21), "premise: alive, it is an agent pane");
    victim.kill("SIGKILL");
    gone.kill("SIGKILL");
    // Node reaps through SIGCHLD on the event loop; with no await between the kill and the scan,
    // the victim is still a zombie to the kernel. Wait for the state to flip WITHOUT yielding.
    const deadline = Date.now() + 3000;
    let state;
    do {
      state = readProcStat(victim.pid)?.state;
    } while (state !== "Z" && Date.now() < deadline);
    assert.equal(state, "Z", "premise: the killed child is an unreaped zombie");
    assert.equal(rowFor(discover(), 21), undefined, "a zombie does not make a pane an agent pane");
    await sleepMs(200); // let node reap it: now it is gone entirely
    assert.equal(readProcStat(victim.pid), null);
    assert.equal(rowFor(discover(), 21), undefined);
  }

  console.log("the foreground process group wins over newer processes, and a trusted session breaks a tie inside it");
  {
    const py = [
      "import os, pty, sys, json, subprocess",
      "exec_link, same_link, bg_link = os.environ['EXEC_LINK'], os.environ['SAME_LINK'], os.environ['BG_LINK']\nidle = json.loads(os.environ['IDLE_ARGS'])",
      "r, w = os.pipe()",
      "pid, fd = pty.fork()",
      "if pid == 0:",
      "    os.close(r)",
      "    same = subprocess.Popen([same_link] + idle)",
      "    bg = subprocess.Popen([bg_link] + idle, preexec_fn=lambda: os.setpgid(0, 0))",
      "    os.write(w, json.dumps({'same': same.pid, 'bg': bg.pid}).encode())",
      "    os.close(w)",
      "    os.execv(exec_link, [exec_link] + idle)",
      "os.close(w)",
      "got = json.loads(os.read(r, 4096))",
      "got['fg'] = pid",
      "print(json.dumps(got), flush=True)",
      "sys.stdin.read()",
    ].join("\n");
    pty = spawn(which("python3"), ["-c", py], {
      // the links travel in the environment: an interpreter whose ARGV names an agent path would
      // itself be classified as an agent (that is the path pass working as designed)
      env: hermeticEnv({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: "118", EXEC_LINK: claude, SAME_LINK: claude, BG_LINK: opencode, IDLE_ARGS: JSON.stringify(IDLE) }),
      stdio: ["pipe", "pipe", "inherit"],
      cwd: repo,
    });
    const line = await new Promise((done, fail) => {
      let buf = "";
      pty.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) done(buf);
      });
      pty.on("error", fail);
      pty.on("exit", () => fail(new Error(`pty helper exited early: ${buf}`)));
    });
    const got = JSON.parse(line);
    for (const pid of Object.values(got)) pids.add(pid);
    await sleepMs(100);
    const st = (pid) => readProcStat(pid);
    assert.ok(st(got.fg).tpgid > 0 && st(got.fg).pgrp === st(got.fg).tpgid, "premise: the exec'd agent is in the terminal's foreground group");
    assert.ok(st(got.same).pgrp === st(got.same).tpgid, "premise: the same-group helper is foreground too");
    assert.ok(st(got.bg).tpgid > 0 && st(got.bg).pgrp !== st(got.bg).tpgid, "premise: the opencode child is in a background group");
    assert.ok(Number(st(got.bg).startTime) >= Number(st(got.fg).startTime), "premise: the background process is not older");
    sessionFile(got.fg, { sessionId: "55555555-5555-4555-8555-555555555555", procStart: st(got.fg).startTime, status: "idle", statusUpdatedAt: 7 });
    const r = rowFor(discover(), 118);
    assert.ok(r, "pane 118 is an agent pane");
    assert.equal(r.pid, got.fg, "the trusted foreground claude, not the newer helper or the newest background opencode");
    assert.equal(r.sessionId, "55555555-5555-4555-8555-555555555555");
    assert.deepEqual(r.nested.map((x) => x.pid), [got.same, got.bg].sort((a, b) => a - b));
    // and without any trusted file the foreground group still outranks the background one
    rmSync(join(sessionsDir, `${got.fg}.json`));
    const r2 = rowFor(discover(), 118);
    assert.ok([got.fg, got.same].includes(r2.pid), "a foreground-group agent still speaks for the pane");
    assert.notEqual(r2.pid, got.bg);
  }

  console.log("readClaudeSession: malformed and partial files degrade to a reason, never a throw");
  {
    const probe = agentIn(94, claude);
    const stat = readProcStat(probe.pid);
    writeFileSync(join(sessionsDir, `${probe.pid}.json`), "{ not json");
    assert.equal(readClaudeSession(probe.pid, stat, sessionsDir).reason, "unreadable-session-file");
    writeFileSync(join(sessionsDir, `${probe.pid}.json`), "[1]");
    assert.equal(readClaudeSession(probe.pid, stat, sessionsDir).reason, "unreadable-session-file");
    sessionFile(probe.pid, { procStart: stat.startTime, status: "weird" });
    const partial = readClaudeSession(probe.pid, stat, sessionsDir);
    assert.deepEqual([partial.sessionId, partial.reason, partial.status, partial.statusUpdatedAt], [null, "no-session-id", "unknown", null]);
    sessionFile(probe.pid, { sessionId: "x", procStart: Number(stat.startTime), status: "shell", statusUpdatedAt: "12" });
    const numeric = readClaudeSession(probe.pid, stat, sessionsDir);
    assert.deepEqual([numeric.sessionId, numeric.status, numeric.statusUpdatedAt], ["x", "shell", 12], "procStart may be a number; status shell is a status");
    assert.equal(readClaudeSession(probe.pid, null, sessionsDir).reason, "stale-session-file");
    stop(probe);
    assert.equal(claudeSessionsDir({ PJ_CLAUDE_SESSIONS_DIR: "/somewhere" }), "/somewhere", "the env override wins");
    assert.match(claudeSessionsDir({}), /\.claude\/sessions$/);
  }

  console.log("ProcScanner: the negative-result cache is populated, and a new process joins on the next pass");
  {
    const scanner = new ProcScanner();
    assert.equal(scanner.cached(), 0);
    assert.ok(scanner.scan(SESSION).length > 0, "the scan sees this suite's own tagged children");
    const afterFirst = scanner.cached();
    assert.ok(afterFirst > 10, `the cache holds every pid it inspected, negatives included (${afterFirst})`);
    const late = agentIn(8, claude);
    const rows = scanner.scan(SESSION);
    assert.ok(rows.some((p) => p.pid === late.pid), "a process started after the first pass is seen");
    assert.ok(scanner.cached() >= afterFirst - 50, "the cache did not empty itself between passes");
    stop(late);
    assert.deepEqual(new ProcScanner().scan("a-session-name-that-cannot-exist-8f3a2b"), [], "an unused session is empty, not an error");
  }

  console.log("formatPaneTable: one aligned row per pane, nested counted, missing session explained");
  {
    const text = formatPaneTable(inventoryPanes({ session: SESSION, shell: zellijShell, sessionsDir, all: true }));
    const lines = text.split("\n");
    assert.match(lines[0], /^TAB\s+PANE\s+AGENT\s+PROJECT\s+STATUS\s+SESSION$/);
    assert.match(text, /opencode \(\+1 nested\)/);
    assert.match(text, /- \(unresolved\)/);
    assert.match(text, /- \(stale-session-file\)/);
    assert.match(text, /\(no agent\)/);
    assert.match(text, /11111111-1111-4111-8111-111111111111/);
  }

  console.log("pj crank panes (the built CLI): default session from ZELLIJ_SESSION_NAME, sessions dir from PJ_CLAUDE_SESSIONS_DIR");
  {
    const pj = join(root, "dist", "index.js");
    assert.ok(existsSync(pj), "dist/index.js missing: run `mise run build` first");
    const cliBin = join(scratch, "cli-bin");
    mkdirSync(cliBin);
    for (const tool of ["env", "timeout", "git"]) symlinkSync(which(tool), join(cliBin, tool));
    writeFileSync(join(scratch, "panes.json"), livePanesJson);
    writeFileSync(join(cliBin, "zellij"), '#!/bin/sh\ncase "$*" in *"action list-panes --json --all"*) cat "$FAKE_ZELLIJ_PANES" ;; *) exit 2 ;; esac\n');
    chmodSync(join(cliBin, "zellij"), 0o755);
    symlinkSync(which("cat"), join(cliBin, "cat"));
    const run = (args, extraEnv = {}) =>
      spawnSync(process.execPath, [pj, "crank", "panes", ...args], {
        encoding: "utf8",
        cwd: repo,
        env: hermeticEnv({
          PATH: cliBin,
          ZELLIJ_SESSION_NAME: SESSION,
          PJ_CLAUDE_SESSIONS_DIR: sessionsDir,
          FAKE_ZELLIJ_PANES: join(scratch, "panes.json"),
          ...extraEnv,
        }),
      });
    const json = run(["--json"]);
    assert.equal(json.status, 0, json.stderr);
    const rows = JSON.parse(json.stdout);
    assert.ok(Array.isArray(rows));
    const r = rows.find((x) => x.paneId === 94);
    assert.equal(r.pid, real.pid);
    assert.equal(r.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(r.tabName, capturePane(94).tab_name);
    assert.deepEqual(rows.map((x) => x.paneId), [94, 146, 122, 150, 8, 16, 118].sort((a, b) => rows.findIndex((x) => x.paneId === a) - rows.findIndex((x) => x.paneId === b)));
    assert.deepEqual([...rows.map((x) => x.paneId)].sort((a, b) => a - b), [8, 16, 94, 118, 122, 146, 150]);
    assert.ok(!rows.some((x) => x.agent === null), "no --all: no agent-less rows");
    assert.match(json.stderr, /999/, "the unmapped pane id is called out on stderr");
    const all = JSON.parse(run(["--json", "--all"]).stdout);
    assert.ok(all.some((x) => x.agent === null && x.paneId === 121));
    const text = run([]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^TAB\s+PANE\s+AGENT/);
    assert.match(text.stdout, /11111111-1111-4111-8111-111111111111/);
    // no zellij on PATH at all: still exit 0, rows without tabs, and a warning that says why
    const none = join(scratch, "no-zellij");
    mkdirSync(none);
    for (const tool of ["env", "timeout", "git"]) symlinkSync(which(tool), join(none, tool));
    const degraded = run(["--json"], { PATH: none });
    assert.equal(degraded.status, 0, degraded.stderr);
    assert.match(degraded.stderr, /unreadable/);
    assert.ok(JSON.parse(degraded.stdout).every((x) => x.tabId === null));
    // a session nobody runs in: a clean empty answer
    const empty = run([], { ZELLIJ_SESSION_NAME: `${SESSION}-nobody` });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /no live agent panes/);
  }
} catch (error) {
  failed = error;
} finally {
  spawnSync(which("pkill"), ["-KILL", "-P", String(toolShellPid)], { env: hermeticEnv() });
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    pty?.stdin.end();
    pty?.kill("SIGKILL");
  } catch {
    // already gone
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) {
  console.error(failed);
  process.exit(1);
}
console.log("pjan-202 crank panes: ok");
