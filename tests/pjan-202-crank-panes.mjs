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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = hermeticScratch("pjan-202");
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");

writeFileSync(join(scratch, "entry.ts"), `export * from ${JSON.stringify(join(root, "src/crank/panes.ts"))};\nexport { defaultShell, livePanes, parseListPanes } from ${JSON.stringify(join(root, "src/crank/index.ts"))};\n`);
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
const {
  AGENT_CLIS, ProcScanner, agentCli, claudeSessionsDir, defaultShell, discoverAgentPanes, displayWidth, formatPaneTable, inventoryPanes, livePanes,
  parseListPanes, parseProcStat, readClaudeSession, readPaneTable, readProcStat,
} = await import(kit);

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
const kimi = link("kimi");
const versioned = join(bin, "claude-home", "claude", "versions", "2.1.235");
symlinkSync(process.execPath, versioned);
const oddComm = link("a ) b 1 2 3");
// a stand-in for the zellij server: only its argv[0] basename and `--server` matter to the scanner
const zellijLink = link("zellij", which("python3"));

// the capture plus one terminal pane (a copy of 151) under an id the real capture does not use
const SESSIONLESS_PANE = 4242;
const sessionlessJson = JSON.stringify([...capture, { ...capturePane(151), id: SESSIONLESS_PANE }]);
const sessionlessShell = (command, args) => (args.includes("list-panes") ? { stdout: sessionlessJson, status: 0 } : defaultShell(command, args));
const zellijShell = (command, args) => (args.includes("list-panes") ? { stdout: livePanesJson, status: 0 } : defaultShell(command, args));

const pids = new Set();
const children = [];

/**
 * The pids this suite may look at: itself and every process below it. Passed to the scanner as its
 * enumeration, so that processes other suites, other copies of this suite, or the operator's own
 * agents have on the box (a tagged process with no session name is visible to every scan BY
 * DESIGN) cannot change a result. The production default (all of /proc) is exercised by one
 * test below that asserts only on its own pids.
 */
const parentOf = () => {
  const edges = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(Number(name));
    if (stat) edges.set(Number(name), stat.ppid);
  }
  return edges;
};
const ownPids = () => {
  const edges = parentOf();
  const out = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of edges) {
      if (!out.has(pid) && out.has(ppid)) {
        out.add(pid);
        grew = true;
      }
    }
  }
  return out;
};
const ownScanner = () => new ProcScanner({ pids: ownPids });
/** A real process in pane `pane` of `session`, argv[0] = `exe`. */
function agentIn(pane, exe, args = IDLE, { session = SESSION, cwd = repo, tag = true } = {}) {
  // session: null = a pane tag with NO session name (what `env -u ZELLIJ_SESSION_NAME ...` leaves behind)
  const env = hermeticEnv(tag ? { ZELLIJ_PANE_ID: String(pane), ...(session === null ? {} : { ZELLIJ_SESSION_NAME: session }) } : {});
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
/** A shell that waits for the file $GO, then exec's "$0" "$@": the test decides when the exec happens. */
const WAIT_THEN_EXEC = 'while [ ! -e "$GO" ]; do sleep 0.05; done; exec "$0" "$@"';
/** Wait (bounded) until `pid` has exec'd out of its `sh` wrapper. */
const untilExec = async (pid) => {
  const deadline = Date.now() + 8000;
  while (readProcStat(pid)?.comm === "sh" && Date.now() < deadline) await sleepMs(20);
};
/**
 * Run `argv` (absolute paths) as init of a fresh pid namespace with its own /proc, as root, with a
 * hard deadline. Every process of the run carries a unique marker argument; at the deadline each
 * process holding it (sudo, unshare, the namespace's init) is SIGKILLed from outside through sudo,
 * which is the only signal a namespace's init cannot ignore. A timer on `sudo`'s own SIGTERM would
 * not do: sudo relays it, init has no handler, and the run stays alive.
 */
const pidsWithMarker = (marker) => {
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "latin1").includes(marker)) found.push(Number(name));
    } catch {
      // gone, or unreadable
    }
  }
  return found;
};
const inNamespace = (argv, ms) =>
  new Promise((done, fail) => {
    const marker = `pjan202-ns-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const child = spawn("sudo", ["-n", "unshare", "--kill-child", "-pf", "--mount-proc", ...argv, marker], {
      env: hermeticEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const reap = () => {
      const left = pidsWithMarker(marker);
      if (left.length) spawnSync("sudo", ["-n", "kill", "-KILL", ...left.map(String)], { env: hermeticEnv(), timeout: 10_000 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      reap();
    }, ms);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      reap(); // whatever outlived a normal exit
      done({ status, out, err, timedOut, marker });
    });
  });
const rowFor = (rows, pane) => rows.find((r) => r.paneId === pane);
const discover = (extra = {}) => discoverAgentPanes({ session: SESSION, shell: zellijShell, sessionsDir, scanner: ownScanner(), ...extra });

/**
 * A python helper that does what zellij does for a pane: pty.fork() a pane root onto a fresh pty,
 * tagged with the pane's ZELLIJ_* variables, which exec's the agent (after starting any `helpers`
 * below it, same process group or its own). Run through a link named `zellij` with `--server` in
 * its argv it IS the pane root's parent for the scanner's purposes; run as a plain python it is
 * "some other process" that happens to own a pty (Claude's background daemon).
 * The links travel in the environment: an interpreter whose ARGV names an agent path would itself
 * be classified as an agent.
 */
const PTY_HELPER = [
  "import os, pty, sys, json, subprocess",
  "idle = json.loads(os.environ['IDLE_ARGS']); tag = json.loads(os.environ['TAG_ENV'])",
  "fg_link = os.environ['EXEC_LINK']; helpers = json.loads(os.environ['HELPERS'])",
  "r, w = os.pipe()",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.close(r)",
  "    os.environ.update(tag)",
  "    got = {}",
  "    for h in helpers:",
  "        kw = {'preexec_fn': lambda: os.setpgid(0, 0)} if h['ownGroup'] else {}",
  "        got[h['name']] = subprocess.Popen([h['link']] + idle, **kw).pid",
  "    os.write(w, json.dumps(got).encode())",
  "    os.close(w)",
  "    os.execv(fg_link, [fg_link] + idle)",
  "os.close(w)",
  "got = json.loads(os.read(r, 4096))",
  "got['fg'] = pid",
  "print(json.dumps(got), flush=True)",
  "sys.stdin.read()",
].join("\n");
const helpersStarted = [];
async function ptyPane({ pane, execLink, helpers = [], server = true }) {
  const env = hermeticEnv({
    TAG_ENV: JSON.stringify({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: String(pane) }),
    EXEC_LINK: execLink,
    IDLE_ARGS: JSON.stringify(IDLE),
    HELPERS: JSON.stringify(helpers),
  });
  const helper = spawn(server ? zellijLink : which("python3"), server ? ["-c", PTY_HELPER, "--server"] : ["-c", PTY_HELPER], {
    env, stdio: ["pipe", "pipe", "inherit"], cwd: repo,
  });
  helpersStarted.push(helper);
  children.push(helper);
  pids.add(helper.pid);
  const line = await new Promise((done, fail) => {
    let buf = "";
    helper.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) done(buf);
    });
    helper.on("error", fail);
    helper.on("exit", () => fail(new Error(`pty helper exited early: ${buf}`)));
  });
  const got = JSON.parse(line);
  for (const pid of Object.values(got)) pids.add(pid);
  // the pane root exec's after it reports: wait until it IS the agent link
  const deadline = Date.now() + 5000;
  while (!readCmdline(got.fg).startsWith(execLink) && Date.now() < deadline) await sleepMs(10);
  assert.ok(readCmdline(got.fg).startsWith(execLink), "premise: the pane root exec'd into the agent");
  for (const h of helpers) while (!readCmdline(got[h.name]).startsWith(h.link) && Date.now() < deadline) await sleepMs(10);
  return { ...got, server: helper };
}
const readCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  } catch {
    return "";
  }
};

let failed;
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
    assert.equal(agentCli("node", "node /home/x/.local/bin/codex mcp-server"), null);
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

  console.log("agentCli: path pass keeps the real install layouts Deckard classifies (npm claude-code, hermes-agent venv, gemini-cli)");
  {
    // positives: each of these is an agent in Deckard (`argv.contains("/<cli>")`) and must stay one
    assert.equal(agentCli("node", "node /h/.local/share/mise/installs/node/24/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume"), "claude", "npm-installed Claude Code");
    assert.equal(agentCli("node", "node /h/.nvm/versions/node/v22/bin/claude"), "claude", "bin shim, end of argv");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python -m hermes_cli.main chat"), "hermes", "hermes-agent venv");
    assert.equal(agentCli("node", "node /h/.local/share/mise/installs/node/24/lib/node_modules/@google/gemini-cli/dist/index.js"), "gemini", "gemini-cli dist/index.js");
    // negatives: a path component that merely STARTS with an agent name
    assert.equal(agentCli("tail", "tail -f /h/.claude/tmp/claude-1000/-h-code-x/out"), null, "/claude-1000 is a tmp dir");
    assert.equal(agentCli("tail", "tail -f /h/code/claude-notes/todo.txt"), null, "/claude-notes");
    assert.equal(agentCli("node", "node /h/code/geminiscope/index.js"), null, "/geminiscope");
    assert.equal(agentCli("zsh", "/usr/bin/zsh -c source /h/.claude/shell-snapshots/s.sh && cd /h/.hermes/hermes-agent && ls"), null, "a -c shell stays a command runner");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python -m x mcp-server"), null, "an MCP server stays a tool");
  }

  console.log("agentCli: a path that merely CONTAINS an agent's install dir does not make the process that agent (PJAN-202 round 2)");
  {
    // A non-interpreter is classified by its executable, not by any argv token; an interpreter by the program it runs.
    assert.equal(agentCli("tail", "tail -f /h/.hermes/hermes-agent/logs/agent.log"), null, "a tail of hermes-agent's log");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python /h/.hermes/profiles/pm/runtime/beat.py --once"), null, "the hermes venv python running an unrelated script");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python -m server.tonnybox_server"), null, "...or an unrelated module");
    assert.equal(agentCli("python3", "/h/.hermes/hermes-agent/.venv/bin/python3 -c import time; time.sleep(9)"), null, "...or inline code");
    assert.equal(agentCli("rg", "/h/.local/share/claude-code/vendor/ripgrep/x64-linux/rg --files -g *.ts"), null, "Claude Code's vendored ripgrep");
    assert.equal(agentCli("rg", "/h/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg"), null, "the npm install's vendored ripgrep");
    assert.equal(agentCli("cat", "cat /h/code/gemini-cli/README.md"), null, "a cat of a file in a gemini-cli checkout");
    assert.equal(agentCli("node", "node /h/code/some-app/build.js --out /h/.claude-code/x"), null, "a node script elsewhere that is handed a claude-code path");
    assert.equal(agentCli("git", "git -C /h/code/hermes-agent log"), null, "git in a hermes-agent checkout");
    // the positives, kept
    assert.equal(agentCli("node", "node /h/.local/share/mise/installs/node/24/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "claude");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python -m hermes_cli.main chat"), "hermes");
    assert.equal(agentCli("python3", "python3 -m hermes_cli.main gateway run"), "hermes");
    assert.equal(agentCli("node", "node /h/.local/share/mise/installs/node/24/lib/node_modules/@google/gemini-cli/dist/index.js"), "gemini");
    assert.equal(agentCli("kimi", "/h/.kimi-code/bin/kimi"), "kimi");
    assert.equal(agentCli("2.1.317", "/h/.local/share/claude/versions/2.1.317 --session-id 8c1a"), "claude", "the versioned install path");
    assert.equal(agentCli("2.1.317", "/h/.local/share/claude/versions/2.1.317"), "claude");
    assert.equal(agentCli("python", "/h/.hermes/hermes-agent/.venv/bin/python /h/.hermes/hermes-agent/hermes chat"), "hermes", "the hermes entry script under the venv python");
    assert.equal(agentCli("2.1.317", "/h/.local/share/claude/versions/2.1.317 mcp serve"), null, "a versioned claude's MCP server is a tool");
    assert.equal(agentCli("x", "/h/.local/share/notclaude/versions/2.1.317"), null, "the directory must BE the CLI");
  }

  console.log("agentCli: an interpreter's option VALUES are not the program; module names match exactly; shell flag clusters carry -c");
  {
    const cc = "/h/.local/share/mise/installs/node/24/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    // node: the value of a separate-argument option is skipped, `--opt=value` is one token
    assert.equal(agentCli("node", `node -r ./preload.js ${cc} --resume`), "claude", "-r <file>");
    assert.equal(agentCli("node", `node --require x.js ${cc}`), "claude", "--require <file>");
    assert.equal(agentCli("node", `node --require=x.js ${cc}`), "claude", "--require=<file>");
    assert.equal(agentCli("node", `node --import ./hook.mjs ${cc}`), "claude", "--import <file>");
    assert.equal(agentCli("node", `node --loader ts-node/esm ${cc}`), "claude", "--loader <x>");
    assert.equal(agentCli("node", `node -C development ${cc}`), "claude", "-C <condition>");
    assert.equal(agentCli("node", `node --conditions dev ${cc}`), "claude", "--conditions <x>");
    assert.equal(agentCli("node", `node --inspect-port 9230 ${cc}`), "claude", "--inspect-port <n>");
    assert.equal(agentCli("node", `node --max-old-space-size=8192 -r a.js --import b.mjs ${cc}`), "claude", "several at once");
    assert.equal(agentCli("node", "node -r /h/code/claude/preload.js /h/code/some-app/server.js"), null, "a claude-named preload is an option value, not the program");
    assert.equal(agentCli("node", "node --require /h/.claude-code/x.js /h/code/app/main.js"), null);
    assert.equal(agentCli("node", "node -pe process.version /h/.claude-code/x"), null, "-pe is inline code");
    // python: -W/-X/-Q take a value; -Wvalue is one token
    assert.equal(agentCli("python3", "python3 -W ignore /h/.hermes/hermes-agent/hermes chat"), "hermes", "-W ignore");
    assert.equal(agentCli("python3", "python3 -X utf8 /h/.hermes/hermes-agent/hermes chat"), "hermes", "-X utf8");
    assert.equal(agentCli("python3", "python3 -Wignore -u /h/.hermes/hermes-agent/hermes"), "hermes", "-Wignore");
    assert.equal(agentCli("python3", "python3 -W ignore -X utf8 -m hermes_cli.main chat"), "hermes", "values before -m");
    assert.equal(agentCli("python3", "python3 -W /h/code/claude/x.py /h/code/app/run.py"), null, "-W's value is not the script");
    assert.equal(agentCli("python3", "python3 -X utf8 /h/code/app/run.py"), null);
    assert.equal(agentCli("python3", "python3 -Im hermes_cli.main chat"), "hermes", "-Im is -I -m");
    assert.equal(agentCli("python3", "python3 -Ic import_claude"), null, "-Ic is inline code");
    // -m modules: exact, or the CLI plus an install suffix; a package that merely STARTS with a name is not it
    assert.equal(agentCli("python", "python -m claude_monitor"), null, "claude_monitor is not claude");
    assert.equal(agentCli("python", "python -m geminiscope.main"), null);
    assert.equal(agentCli("python", "python -m codex_exporter run"), null);
    assert.equal(agentCli("python", "python -m hermes_cli.main chat"), "hermes", "hermes_cli = hermes + _cli");
    assert.equal(agentCli("python", "python -m hermes chat"), "hermes", "exact");
    assert.equal(agentCli("python", "python -m kimi_cli"), "kimi", "kimi_cli");
    assert.equal(agentCli("python", "python -m claude_code"), "claude", "claude_code");
    // shells: any short-flag cluster containing c is -c, so the command text is never a program
    assert.equal(agentCli("bash", 'bash -lc /x/claude/run.sh; echo done'), null, "bash -lc");
    assert.equal(agentCli("zsh", "zsh -ic /h/.local/bin/claude"), null, "zsh -ic");
    assert.equal(agentCli("sh", "sh -ec /h/code/claude/x.sh"), null, "sh -ec");
    assert.equal(agentCli("dash", "dash -c /h/.local/bin/claude --resume"), null, "N8: a path right after -c is the command text");
    assert.equal(agentCli("bash", "/bin/bash -c /h/.local/bin/claude --resume"), null);
    assert.equal(agentCli("fish", "fish -c /h/.local/bin/claude"), null, "fish -c");
    assert.equal(agentCli("bash", "bash -l /h/.local/bin/claude --resume"), "claude", "no c in the flags: the script is the program");
    assert.equal(agentCli("bash", "bash -o pipefail /h/.local/bin/claude"), "claude", "-o takes a value");
    assert.equal(agentCli("bash", "bash --rcfile /h/rc /h/.local/bin/claude"), "claude");
  }

  console.log("agentCli: by-name matching is Deckard's prefix rule (argv[0] STARTS with a CLI name)");
  {
    // the npm codex package ships `codex-<triple>`; Deckard's `exe.starts_with(pat)` is what finds it
    assert.equal(agentCli("codex-x86_64-unknown-linux-musl", "/h/lib/node_modules/@openai/codex/vendor/codex-x86_64-unknown-linux-musl/codex/codex-x86_64-unknown-linux-musl exec"), "codex");
    assert.equal(agentCli("codex-linux-sandbox", "/h/x/codex-linux-sandbox --cwd /h/y"), "codex", "the sandbox helper is a codex binary by name (nested, never the pane's own)");
    assert.equal(agentCli("claude-code", "claude-code --resume"), "claude");
    assert.equal(agentCli("nvidia-claude-thing", "nvidia-claude-thing"), null, "a name that merely CONTAINS a CLI name is not prefix-matched");
  }

  console.log("agentCli: Kimi is an agent (the box's binary is ~/.kimi-code/bin/kimi)");
  {
    assert.equal(agentCli("kimi", "/h/.kimi-code/bin/kimi --yolo"), "kimi");
    assert.equal(agentCli("kimi-code", "kimi-code"), "kimi-code", "Deckard's own names keep their name");
    assert.equal(agentCli("python", "python /h/.local/share/uv/tools/kimi-cli/bin/kimi-cli"), "kimi", "uv-tool kimi-cli");
    assert.equal(agentCli("node", "node /h/x/kimi-server/dist/index.js mcp-server"), null);
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

    const inv = inventoryPanes({ session: SESSION, shell: zellijShell, sessionsDir, scanner: ownScanner() });
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

  console.log("zellij unreadable: the inventory says UNKNOWN (empty panes, zellijReadable false, an error), never a /proc-only guess");
  {
    const through = (reply) => (c, a) => (a.includes("list-panes") ? reply : defaultShell(c, a));
    const failing = inventoryPanes({ session: SESSION, shell: through({ stdout: "", status: 1 }), sessionsDir, scanner: ownScanner() });
    assert.equal(failing.zellijReadable, false);
    assert.match(failing.error, /list-panes for session .* failed \(exit 1\)/);
    assert.deepEqual(failing.panes, [], "the live agents are NOT listed as if zellij had confirmed them");
    assert.deepEqual(failing.unmappedPaneIds, []);
    assert.equal(failing.session, SESSION);
    // an empty pane list is not "a session with no panes": a live session always has its tab bar
    const empty = inventoryPanes({ session: SESSION, shell: through({ stdout: "[]", status: 0 }), sessionsDir, scanner: ownScanner() });
    assert.equal(empty.zellijReadable, false, "[] means not-a-session");
    assert.match(empty.error, /no panes at all/);
    // each way zellij can fail says WHICH way: not installed, wedged, or no such session
    const reason = (reply) => inventoryPanes({ session: SESSION, shell: through(reply), sessionsDir, scanner: ownScanner() }).error;
    const missing = reason({ stdout: "", status: 127 });
    const wedged = reason({ stdout: "", status: 124 });
    const noSession = reason({ stdout: "", status: 1, stderr: "Session 'x' not found. The following sessions are active:\nWorkspace\n" });
    const other = reason({ stdout: "", status: 3, stderr: "boom" });
    assert.match(missing, /not installed or not on PATH \(exit 127\)/);
    assert.match(wedged, /timed out \(exit 124\).*wedged/);
    assert.match(noSession, /has no session .* \(exit 1\).*not found/);
    assert.match(other, /failed \(exit 3\): boom/);
    assert.equal(new Set([missing, wedged, noSession, other]).size, 4, "four causes, four different messages");
    assert.doesNotMatch(wedged + noSession, /not installed/);
    assert.doesNotMatch(missing + wedged, /no such session/i);
    for (const status of [127, 124, 1]) {
      assert.equal(inventoryPanes({ session: SESSION, shell: through({ stdout: "", status }), sessionsDir, scanner: ownScanner() }).zellijReadable, false, `exit ${status} is unreadable`);
    }
    // the real defaultShell: a binary that does not exist is 127
    assert.equal(defaultShell(join(scratch, "no-such-binary"), []).status, 127);
    const garbage = inventoryPanes({ session: SESSION, shell: through({ stdout: "not json", status: 0 }), sessionsDir, scanner: ownScanner() });
    assert.equal(garbage.zellijReadable, false);
    assert.match(garbage.error, /no pane list/);
    // and a readable session with no agent panes in it is a real "none"
    const none = inventoryPanes({ session: `${SESSION}-nobody`, shell: zellijShell, sessionsDir, scanner: ownScanner() });
    assert.equal(none.zellijReadable, true);
    assert.equal(none.error, null);
    assert.deepEqual(none.panes, []);
  }

  console.log("session provenance: the inventory says which session was used and where the name came from");
  {
    assert.equal(inventoryPanes({ session: SESSION, shell: zellijShell, sessionsDir, scanner: ownScanner() }).sessionSource, "option");
    // the suite's own env has no ZELLIJ_SESSION_NAME (hermetic), so without an option this is the default
    const inv = inventoryPanes({ shell: zellijShell, sessionsDir, scanner: ownScanner() });
    assert.deepEqual([inv.session, inv.sessionSource], ["Workspace", "default"]);
    process.env.ZELLIJ_SESSION_NAME = `${SESSION}-env`;
    try {
      const fromEnv = inventoryPanes({ shell: zellijShell, sessionsDir, scanner: ownScanner() });
      assert.deepEqual([fromEnv.session, fromEnv.sessionSource], [`${SESSION}-env`, "ZELLIJ_SESSION_NAME"]);
    } finally {
      delete process.env.ZELLIJ_SESSION_NAME;
    }
  }

  console.log("one parser: readPaneTable and livePanes read the same command and the same output the same way");
  {
    const seen = [];
    const spy = (c, a) => {
      seen.push([c, ...a]);
      return { stdout: livePanesJson, status: 0 };
    };
    const live = livePanes({ shell: spy, session: "S1" });
    const table = readPaneTable("S1", spy);
    assert.deepEqual(seen[0], seen[1], "the same command line, byte for byte");
    assert.ok(seen[0].join(" ").endsWith("zellij -s S1 action list-panes --json --all"), "read-only: list-panes, for the asked session");
    const terminals = live.filter((pane) => !pane.isPlugin);
    assert.deepEqual([...table.panes.keys()].sort((a, b) => a - b), terminals.map((pane) => pane.id).sort((a, b) => a - b));
    for (const pane of terminals) assert.deepEqual([table.panes.get(pane.id).tabId, table.panes.get(pane.id).tabName], [pane.tabId ?? null, pane.tabName]);
    assert.equal(parseListPanes("[]").length, 0, "an empty list parses; judging it is the caller's job");
    assert.equal(parseListPanes(""), null);
    assert.ok(parseListPanes(livePanesJson).every((pane) => pane.title !== undefined), "the shared parser carries the title the table needs");
    assert.ok(live.every((pane) => !("title" in pane)), "livePanes keeps its existing shape");
  }

  console.log("a pane opened while zellij is being read is not mislabelled unmapped: /proc is scanned first");
  {
    let raced;
    const racing = (c, a) => {
      if (a.includes("list-panes") && !raced) raced = agentIn(78, claude); // appears DURING the ~4 s zellij read
      return zellijShell(c, a);
    };
    const inv = inventoryPanes({ session: SESSION, shell: racing, sessionsDir, scanner: ownScanner() });
    assert.ok(raced, "premise: the process was started inside the zellij read");
    assert.equal(inv.panes.some((x) => x.pid === raced.pid), false, "the scan had already finished, so it is simply not in this pass");
    assert.deepEqual(inv.unmappedPaneIds, [999], "and it is not reported as an unmapped pane either");
    assert.ok(rowFor(discover(), 78), "the next pass sees it");
    stop(raced);
  }

  console.log("a process with a pane tag but NO session name is kept (Deckard's rule): its pane is an agent pane");
  {
    // A pane id no other test (and no other copy of this suite) uses, listed by a capture of its own,
    // so that this process is attributed to a pane only this test can see.
    const bare = agentIn(SESSIONLESS_PANE, claude, IDLE, { session: null });
    const row = rowFor(discover({ shell: sessionlessShell }), SESSIONLESS_PANE);
    assert.ok(row, "a sessionless tagged agent is attributed to its pane");
    assert.equal(row.pid, bare.pid);
    assert.equal(row.tabName, capturePane(151).tab_name);
    assert.deepEqual(ownScanner().scan(SESSION).filter((p) => p.pid === bare.pid).map((p) => p.session), [null]);
    stop(bare);
  }

  console.log("a zombie is not a working agent; an exited one is gone");
  {
    const victim = agentIn(21, claude);
    const gone = agentIn(21, opencode);
    // A WARM scanner: it caches the pane tag while the process is alive. A zombie's stat still reads
    // (same pid, starttime, comm), its tag stays cached, and its cmdline is gone, so only the
    // explicit zombie check keeps it from being counted. A cold scanner cannot tell that rule apart,
    // because it cannot read a zombie's environ at all.
    const warm = ownScanner();
    assert.ok(rowFor(discover({ scanner: warm }), 21), "premise: alive, it is an agent pane");
    assert.ok(warm.has(victim.pid));
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
    assert.equal(rowFor(discover({ scanner: warm }), 21), undefined, "a cached zombie does not make a pane an agent pane");
    assert.equal(rowFor(discover(), 21), undefined, "a zombie does not make a pane an agent pane");
    await sleepMs(200); // let node reap it: now it is gone entirely
    assert.equal(readProcStat(victim.pid), null);
    assert.equal(rowFor(discover(), 21), undefined);
  }

  console.log("the foreground process group wins over newer processes, and a trusted session breaks a tie inside it");
  {
    // the pane: a zellij-server stand-in forks the pane root (the exec'd claude) onto a pty
    const got = await ptyPane({
      pane: 118,
      execLink: claude,
      helpers: [{ name: "same", link: claude, ownGroup: false }, { name: "bg", link: opencode, ownGroup: true }],
    });
    const st = (pid) => readProcStat(pid);
    assert.ok(st(got.fg).ttyNr > 0, "premise: the pane root has a controlling terminal");
    assert.equal(st(got.fg).ppid, got.server.pid, "premise: the pane root's parent is the zellij server stand-in");
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

  console.log("foreground is judged on the PANE's terminal: an agent on another pty that carries the pane's tag does not speak for it");
  {
    // The pane's agent (older) sits on the pty zellij gave the pane. A NEWER claude on a pty of its
    // own inherited the same ZELLIJ_PANE_ID (Claude's background daemon keeps the tag of the pane
    // that started it), is the foreground group of THAT pty, and is not a child of the zellij server.
    const mine = await ptyPane({ pane: 126, execLink: claude });
    await sleepMs(60); // starttime ticks are 10 ms
    const daemon = await ptyPane({ pane: 126, execLink: claude, server: false });
    const a = readProcStat(mine.fg);
    const b = readProcStat(daemon.fg);
    assert.ok(a.ttyNr > 0 && b.ttyNr > 0 && a.ttyNr !== b.ttyNr, "premise: two different ptys");
    assert.ok(a.pgrp === a.tpgid && b.pgrp === b.tpgid, "premise: each is the foreground group of its OWN terminal");
    assert.ok(Number(b.startTime) > Number(a.startTime), "premise: the other-pty process is the newer one");
    assert.equal(a.ppid, mine.server.pid, "premise: the pane's agent is a child of the zellij server stand-in");
    assert.notEqual(b.ppid, mine.server.pid);
    // both interactive, both trusted: only the pane's tty tells them apart (newest would pick the daemon)
    sessionFile(mine.fg, { sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", procStart: a.startTime, status: "busy", statusUpdatedAt: 1 });
    sessionFile(daemon.fg, { sessionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", procStart: b.startTime, status: "idle", statusUpdatedAt: 2 });
    const r = rowFor(discover(), 126);
    assert.equal(r.pid, mine.fg, "the agent on the pane's own terminal");
    assert.equal(r.sessionId, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    assert.deepEqual(r.nested, [{ pid: daemon.fg, agent: "claude" }], "the other one is nested, not dropped");
    // and the reviewer's exact reproduction: the newer one is a kind:"bg" daemon session
    sessionFile(daemon.fg, { kind: "bg", sessionId: "bbbbbbbb-daemon-bg", procStart: b.startTime, status: "idle", statusUpdatedAt: 2 });
    assert.equal(rowFor(discover(), 126).sessionId, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    for (const pane of [mine, daemon]) for (const pid of [pane.fg, pane.server.pid]) process.kill(pid, "SIGKILL");
  }

  console.log("a kind:\"bg\" Claude session ranks below an interactive one even when it is newer and nothing is foreground");
  {
    // no terminals at all, so the tty rule cannot help: only the kind rule separates them
    const interactive = agentIn(144, claude);
    await sleepMs(60);
    const daemon = agentIn(144, claude);
    assert.ok(Number(startTime(daemon.pid)) > Number(startTime(interactive.pid)), "premise: the daemon session is newer");
    sessionFile(interactive.pid, { sessionId: "cccccccc-1111-4111-8111-cccccccccccc", procStart: startTime(interactive.pid), status: "idle", statusUpdatedAt: 1 });
    sessionFile(daemon.pid, { kind: "bg", sessionId: "dddddddd-daemon-bg", procStart: startTime(daemon.pid), status: "busy", statusUpdatedAt: 2 });
    const r = rowFor(discover(), 144);
    assert.equal(r.pid, interactive.pid, "the interactive session speaks for the pane");
    assert.equal(r.sessionId, "cccccccc-1111-4111-8111-cccccccccccc");
    assert.deepEqual(r.nested, [{ pid: daemon.pid, agent: "claude" }]);
    // a bg session that is ALONE in its pane is still the pane's agent (demoted, not dropped)
    interactive.kill("SIGKILL");
    const deadline = Date.now() + 3000;
    while (readProcStat(interactive.pid) && Date.now() < deadline) await sleepMs(20);
    const alone = rowFor(discover(), 144);
    assert.equal(alone?.pid, daemon.pid);
    assert.equal(alone.sessionId, "dddddddd-daemon-bg");
    stop(daemon);
  }

  console.log("an AMBIGUOUS pane terminal (two roots under the server, two ttys) proves nothing foreground: it does not pick the first");
  {
    const first = await ptyPane({ pane: 147, execLink: claude });
    await sleepMs(60);
    const second = await ptyPane({ pane: 147, execLink: claude });
    const a = readProcStat(first.fg);
    const b = readProcStat(second.fg);
    assert.ok(a.ttyNr > 0 && b.ttyNr > 0 && a.ttyNr !== b.ttyNr, "premise: two ptys");
    assert.ok(a.pgrp === a.tpgid && b.pgrp === b.tpgid, "premise: each is its own terminal's foreground group");
    assert.equal(a.ppid, first.server.pid);
    assert.equal(b.ppid, second.server.pid, "premise: both pane roots hang off a zellij server");
    assert.ok(Number(b.startTime) > Number(a.startTime), "premise: the second is newer");
    assert.ok(first.fg < second.fg, "premise: the first one also comes first in pid order, which is where a 'pick the first tty' bug would land");
    const r = rowFor(discover(), 147);
    assert.equal(r.pid, second.fg, "nothing is provably foreground, so the NEWEST speaks; the first root's tty is not taken as the pane's");
    assert.deepEqual(r.nested, [{ pid: first.fg, agent: "claude" }]);
    for (const pane of [first, second]) for (const pid of [pane.fg, pane.server.pid]) process.kill(pid, "SIGKILL");
  }

  console.log("a ZOMBIE pane root (a warm scanner still knows its tag) does not unsettle the pane's terminal");
  {
    const gone = await ptyPane({ pane: 148, execLink: claude });
    const live = await ptyPane({ pane: 148, execLink: claude, helpers: [{ name: "bg", link: opencode, ownGroup: true }] });
    const warm = ownScanner();
    assert.ok(rowFor(discover({ scanner: warm }), 148), "premise: the warm scanner has seen every process of the pane alive (two live roots: ambiguous, so the newest speaks)");
    process.kill(gone.fg, "SIGKILL"); // its parent (the stand-in) never reaps: an unreaped zombie
    const deadline = Date.now() + 3000;
    while (readProcStat(gone.fg)?.state !== "Z" && Date.now() < deadline) await sleepMs(10);
    const z = readProcStat(gone.fg);
    assert.equal(z?.state, "Z", "premise: an unreaped zombie");
    // Whether a zombie still reports its controlling tty is the kernel's business: it usually does not
    // (measured), and in a short window after the exit it does. Either way the pane's terminal must
    // be the live root's, so nothing is asserted about it here; only the outcome below.
    assert.ok(warm.has(gone.fg), "premise: the warm scanner remembers the zombie's pane tag");
    const l = readProcStat(live.fg);
    const bg = readProcStat(live.bg);
    assert.ok(Number(bg.startTime) >= Number(l.startTime) && bg.pgrp !== bg.tpgid, "premise: a newer, background-group helper sits beside the live root");
    const r = rowFor(discover({ scanner: warm }), 148);
    assert.equal(r.pid, live.fg, "the live root is on THE terminal of the pane and is foreground; the zombie is ignored");
    assert.deepEqual(r.nested, [{ pid: live.bg, agent: "opencode" }]);
    for (const pid of [live.fg, live.bg, live.server.pid, gone.server.pid]) process.kill(pid, "SIGKILL");
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

  console.log("ProcScanner: negatives are cached, a new process joins on the next pass, a dead pid is forgotten");
  {
    const scanner = ownScanner();
    assert.equal(scanner.cached(), 0);
    assert.ok(scanner.scan(SESSION).length > 0, "the scan sees this suite's own tagged children");
    assert.ok(scanner.has(process.pid), "an UNTAGGED process (this one) is remembered as a negative");
    assert.ok(scanner.has(untagged.pid), "an untagged claude is remembered too: the negative is what makes the warm pass cheap");
    assert.equal(scanner.has(plainSleep.pid), true);
    assert.ok(scanner.cached() >= 5, `the cache holds every pid it inspected, negatives included (${scanner.cached()})`);
    const late = agentIn(8, claude);
    assert.equal(scanner.has(late.pid), false, "premise: not seen yet");
    assert.ok(scanner.scan(SESSION).some((p) => p.pid === late.pid), "a process started after the first pass is seen");
    assert.ok(scanner.has(late.pid) && scanner.has(process.pid) && scanner.has(real.pid), "tagged and negative entries both survive the second pass");
    stop(late);
    await sleepMs(300);
    scanner.scan(SESSION);
    assert.equal(scanner.has(late.pid), false, "an exited pid is dropped, so the cache tracks the box");
  }

  console.log("ProcScanner: the DEFAULT enumeration reads all of /proc (production), asserted only on this suite's own pids");
  {
    const everything = new ProcScanner();
    const seen = everything.scan(SESSION);
    const mine = seen.filter((p) => pids.has(p.pid));
    assert.ok(mine.length >= 5, `the default scan finds this suite's tagged processes (${mine.length})`);
    assert.equal(mine.find((p) => p.pid === real.pid)?.paneId, 94);
    assert.equal(mine.find((p) => p.pid === ocFile.pid)?.paneId, 8);
    assert.equal(seen.some((p) => p.pid === untagged.pid), false, "an untagged process is never a row");
    assert.ok(everything.has(process.pid), "it walked the box, this process included");
    assert.ok(everything.cached() > ownPids().size, "and it holds more than this suite's children");
    // the whole pipeline on the default enumeration: this suite's own pane 94 row is among the rows
    const rows = discoverAgentPanes({ session: SESSION, shell: zellijShell, sessionsDir }).filter((row) => pids.has(row.pid));
    assert.equal(rows.find((row) => row.paneId === 94)?.pid, real.pid);
    // The contract for a session nobody uses: no row NAMES it. Rows with session null are allowed:
    // other tools start under `env -u ZELLIJ_SESSION_NAME` (e.g. `zellij action list-panes` from a
    // pane), carry a pane id and no session, and Deckard keeps those on purpose.
    const nobody = "a-session-name-that-cannot-exist-8f3a2b";
    assert.ok(new ProcScanner().scan(nobody).every((p) => p.session === null), `no row names ${nobody}; only session-less tagged processes may appear`);
  }

  console.log("ProcScanner: a cached process that EXECs into an agent is re-read (comm changes), same pid, same scanner");
  {
    const warm = ownScanner();
    // The exec happens when the TEST says so (it creates $GO), never after a fixed delay.
    const go = join(scratch, "go-exec-1");
    const morph = spawn("sh", ["-c", WAIT_THEN_EXEC, claude, ...IDLE], {
      cwd: repo, stdio: "ignore", env: hermeticEnv({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: "151", GO: go }),
    });
    children.push(morph);
    pids.add(morph.pid);
    const before = discover({ scanner: warm });
    assert.equal(rowFor(before, 151), undefined, "premise: a shell waiting on sleep is not an agent");
    assert.equal(readProcStat(morph.pid).comm, "sh");
    assert.ok(warm.has(morph.pid), "premise: the scanner cached it while it was a shell");
    writeFileSync(go, "");
    await untilExec(morph.pid);
    assert.notEqual(readProcStat(morph.pid).comm, "sh", "premise: it exec'd into the claude link (node renames its main thread, so comm is not \"claude\")");
    const after = rowFor(discover({ scanner: warm }), 151);
    assert.ok(after, "the same pid is now an agent pane: nothing about it was frozen at its shell days");
    assert.equal(after.pid, morph.pid);
    assert.equal(after.agent, "claude");
    stop(morph);
  }

  console.log("ProcScanner: a remembered NEGATIVE is dropped when the process exec's into a tagged environment (comm changes)");
  {
    const warm = ownScanner();
    const go = join(scratch, "go-exec-2");
    const late = spawn("sh", ["-c", 'while [ ! -e "$GO" ]; do sleep 0.05; done; exec env ZELLIJ_SESSION_NAME="$MORPH_SESSION" ZELLIJ_PANE_ID=151 "$0" "$@"', claude, ...IDLE], {
      cwd: repo, stdio: "ignore", env: hermeticEnv({ MORPH_SESSION: SESSION, GO: go }), // starts with NO pane tag
    });
    children.push(late);
    pids.add(late.pid);
    assert.equal(rowFor(discover({ scanner: warm }), 151), undefined, "premise: untagged, so not in any pane");
    assert.ok(warm.has(late.pid), "premise: remembered as a negative");
    writeFileSync(go, "");
    await untilExec(late.pid);
    assert.notEqual(readProcStat(late.pid).comm, "sh", "premise: it exec'd");
    const after = rowFor(discover({ scanner: warm }), 151);
    assert.equal(after?.pid, late.pid, "the exec replaced its environment: the stale negative was not trusted");
    stop(late);
  }

  console.log("ProcScanner: argv is re-read every pass even when comm does not change (exec into another argv of the same name)");
  {
    // python started through a link named `claude` (comm "claude": an agent), which later exec's
    // ANOTHER python-as-`claude` as an MCP server (comm still "claude", argv different). The target is
    // passed in the environment so the first argv does not already say mcp-server.
    const pyDir = join(scratch, "bin-py");
    mkdirSync(pyDir);
    const pyClaude = join(pyDir, "claude");
    symlinkSync(which("python3"), pyClaude);
    const warm = ownScanner();
    const go = join(scratch, "go-exec-3");
    const morph = spawn(pyClaude, ["-c", "import os, json, time\nwhile not os.path.exists(os.environ['GO']): time.sleep(0.05)\na = json.loads(os.environ['MORPH_ARGV']); os.execv(a[0], a)"], {
      cwd: repo,
      stdio: "ignore",
      env: hermeticEnv({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: "151", GO: go, MORPH_ARGV: JSON.stringify([pyClaude, "-c", "import time; time.sleep(600)", "mcp-server"]) }),
    });
    children.push(morph);
    pids.add(morph.pid);
    assert.equal(rowFor(discover({ scanner: warm }), 151)?.pid, morph.pid, "premise: first it is a claude agent");
    writeFileSync(go, "");
    const deadline = Date.now() + 8000;
    while (!readFileSync(`/proc/${morph.pid}/cmdline`, "utf8").includes("mcp-server") && Date.now() < deadline) await sleepMs(20);
    const st = readProcStat(morph.pid);
    assert.equal(st.comm, "claude", "premise: comm did not change, so only a cmdline re-read can notice");
    assert.equal(rowFor(discover({ scanner: warm }), 151), undefined, "now it is an MCP server, a tool: its old argv was not served from the cache");
    stop(morph);
  }

  console.log("ProcScanner: a REUSED pid is a new process (the starttime half of the cache key), with real pid reuse in a pid namespace");
  {
    // Real reuse: `unshare -pf --mount-proc` gives a pid namespace with its own /proc, and writing
    // ns_last_pid rewinds its pid counter, so a second process is handed a dead one's pid. That
    // needs root: passwordless sudo here and on GitHub's ubuntu-latest. Without it the test says
    // so out loud; it never passes silently.
    const probe = spawnSync("sudo", ["-n", "true"], { encoding: "utf8", env: hermeticEnv(), timeout: 10_000 });
    if (probe.status !== 0 || probe.error) {
      console.log("  SKIP (needs passwordless sudo): the pid-reuse half of the scanner's cache key was NOT exercised");
    } else if (!which("unshare")) {
      console.log("  SKIP (needs unshare from util-linux): the pid-reuse half of the scanner's cache key was NOT exercised");
    } else {
      const reuseHome = join(scratch, "pid-reuse-home");
      mkdirSync(reuseHome);
      const helperPath = join(root, "tests", "helpers", "pid-reuse-child.mjs");
      const reuse = await inNamespace([process.execPath, helperPath, kit, claude, reuseHome], 90_000);
      assert.equal(reuse.timedOut, false, `pid reuse helper hung:\n${reuse.out}\n${reuse.err}`);
      assert.equal(reuse.status, 0, `pid reuse helper failed:\n${reuse.out}\n${reuse.err}`);
      assert.match(reuse.out, /PID-REUSE-OK pid=\d+ comm=\S+ startA=\d+ startB=\d+/);
      console.log(`  ${reuse.out.trim()}`);

      // The bound itself: a namespace whose init never exits must be reaped by the deadline, not
      // left running. (Pid 1 of a namespace ignores a SIGTERM it has no handler for, so neither
      // spawn's timeout nor `timeout` can stop it; only a SIGKILL sent from OUTSIDE can.)
      const started = Date.now();
      const hung = await inNamespace([process.execPath, "-e", "setInterval(() => {}, 1e6)"], 2_000);
      assert.equal(hung.timedOut, true, "premise: the forced hang hit the deadline");
      assert.ok(Date.now() - started < 15_000, `the hang was bounded (${Date.now() - started} ms for a 2000 ms budget)`);
      assert.deepEqual(pidsWithMarker(hung.marker), [], "no process of the hung namespace (sudo, unshare, its init) is left running");
    }
  }

  console.log("a real Kimi process is an agent pane with an unresolved session");
  {
    const k = agentIn(21, kimi);
    const row = rowFor(discover(), 21);
    assert.equal(row?.pid, k.pid);
    assert.equal(row.agent, "kimi");
    assert.equal(row.sessionId, null);
    assert.equal(row.sessionReason, "unresolved");
    stop(k);
  }

  console.log("formatPaneTable: PID and nested pids shown, columns aligned under emoji tab names, missing session explained");
  {
    const hermes = agentIn(21, claude); // pane 21 lives in the tab "herm 🔴es"; 122 and 150 in "ipm 🟢"
    const inv = inventoryPanes({ session: SESSION, shell: zellijShell, sessionsDir, scanner: ownScanner(), all: true });
    const text = formatPaneTable(inv);
    const lines = text.split("\n");
    assert.match(lines[0], /^TAB\s+PANE\s+PID\s+AGENT\s+PROJECT\s+STATUS\s+SESSION\s+NESTED$/);
    const m = rowFor(inv.panes, 16);
    const line16 = lines.find((l) => l.split(/\s+/)[l.startsWith("Wingman") ? 1 : -1] === "16" && l.includes(String(m.pid)));
    assert.ok(line16, "pane 16's row carries its chosen pid");
    assert.ok(new RegExp(`\\s${m.pid}\\s+opencode\\s`).test(line16), "the PID column holds the pid that speaks for the pane");
    assert.ok(line16.includes(`claude:${m.nested[0].pid}`), "the nested agent is listed with ITS pid, not just counted");
    assert.match(text, /- \(unresolved\)/);
    assert.match(text, /- \(stale-session-file\)/);
    assert.match(text, /\(no agent\)/);
    assert.match(text, /11111111-1111-4111-8111-111111111111/);
    for (const row of inv.panes.filter((x) => x.pid !== null)) assert.ok(text.includes(String(row.pid)), `pid ${row.pid} is in the table`);
    // alignment by DISPLAY width: every line's second column starts at the same terminal column
    assert.ok(text.includes("ipm 🟢") && text.includes("herm 🔴es"), "premise: the emoji tab names are in the table");
    const startsAt = lines.map((l) => displayWidth(l.match(/^(.*?\S)\s{2,}(?=\S)/)[0]));
    assert.equal(new Set(startsAt).size, 1, `the PANE column starts at one display column on every line: ${startsAt}`);
    stop(hermes);
    assert.equal(displayWidth("ipm 🟢"), 6);
    assert.equal(displayWidth("日本語"), 6);
    assert.equal(displayWidth("e\u0301x"), 2, "a combining mark is zero wide");
    assert.equal(displayWidth("👨\u200d👩\u200d👧"), 2, "a ZWJ family is one emoji");
    // VS16 turns a text-presentation base into a two-wide emoji; flags are a PAIR of regional indicators
    for (const [text, width] of [["⚠️", 2], ["❤️", 2], ["▶️", 2], ["1️⃣", 2], ["🏳️\u200d🌈", 2], ["🇺🇸", 2], ["🇺🇸🇯🇵", 4], ["a🇺🇸b", 4], ["⚠", 1], ["❤", 1], ["▶", 1], ["1", 1], ["x⚠️y", 4], ["🇺", 1]]) {
      assert.equal(displayWidth(text), width, `${JSON.stringify(text)} is ${width} wide`);
    }
    const flagged = formatPaneTable({
      ...inv, panes: inv.panes.slice(0, 3).map((row, i) => ({ ...row, tabName: ["⚠️ warn", "🇺🇸 flag", "plain"][i] })),
    }).split("\n");
    assert.equal(new Set(flagged.map((l) => displayWidth(l.match(/^(.*?\S)\s{2,}(?=\S)/)[0]))).size, 1, "VS16 and flag tab names keep the columns aligned");
  }

  console.log("pj crank panes (the built CLI): an envelope, honest exit codes, session provenance, pids");
  {
    const pj = join(root, "dist", "index.js");
    assert.ok(existsSync(pj), "dist/index.js missing: run `mise run build` first");
    const cliBin = join(scratch, "cli-bin");
    mkdirSync(cliBin);
    for (const tool of ["env", "timeout", "git", "cat"]) symlinkSync(which(tool), join(cliBin, tool));
    writeFileSync(join(scratch, "panes.json"), livePanesJson);
    writeFileSync(join(scratch, "no-panes.json"), "[]");
    writeFileSync(join(cliBin, "zellij"), '#!/bin/sh\ncase "$*" in *"action list-panes --json --all"*) cat "$FAKE_ZELLIJ_PANES" ;; *) exit 2 ;; esac\n');
    chmodSync(join(cliBin, "zellij"), 0o755);
    const run = (args, extraEnv = {}, drop = []) => {
      const env = hermeticEnv({
        PATH: cliBin,
        ZELLIJ_SESSION_NAME: SESSION,
        PJ_CLAUDE_SESSIONS_DIR: sessionsDir,
        FAKE_ZELLIJ_PANES: join(scratch, "panes.json"),
        ...extraEnv,
      });
      for (const name of drop) delete env[name];
      return spawnSync(process.execPath, [pj, "crank", "panes", ...args], { encoding: "utf8", cwd: repo, env });
    };

    const json = run(["--json"]);
    assert.equal(json.status, 0, json.stderr);
    const inv = JSON.parse(json.stdout);
    assert.ok(!Array.isArray(inv), "an envelope, not a bare array");
    assert.deepEqual(
      [inv.session, inv.sessionSource, inv.zellijReadable, inv.error],
      [SESSION, "ZELLIJ_SESSION_NAME", true, null],
      "which session, where the name came from, and that zellij was readable",
    );
    // The CLI scans all of /proc (production). Everything that follows asserts on THIS suite's own
    // processes only: another copy of the suite, or the operator's own session-less agents, may add rows.
    const own = (row) => pids.has(row.pid);
    assert.ok(inv.unmappedPaneIds.includes(999), "a pane id zellij does not list is reported");
    const rows = inv.panes.filter(own);
    const r = rows.find((x) => x.paneId === 94);
    assert.equal(r.pid, real.pid, "JSON carries the pid");
    assert.equal(r.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(r.tabName, capturePane(94).tab_name);
    // rows come in tab order (capture positions: tab 2 -> 0, tab 30 -> 1, tab 7 -> 2, tab 9 -> 3), then pane id
    assert.deepEqual(rows.map((x) => x.paneId), [94, 146, 122, 150, 8, 16, 118]);
    const m = rows.find((x) => x.paneId === 16);
    assert.deepEqual(m.nested, [{ pid: first.pid, agent: "claude" }], "nested pids are in the JSON too");
    assert.ok(!inv.panes.some((x) => x.agent === null), "no --all: no agent-less rows");
    assert.match(json.stderr, /999/, "the unmapped pane id is called out on stderr");
    const all = JSON.parse(run(["--json", "--all"]).stdout);
    assert.ok(all.panes.some((x) => x.agent === null && x.paneId === 121));
    assert.ok(all.panes.some((x) => x.paneId === 94 && x.pid === real.pid), "--all keeps the agent rows too");

    const text = run([]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^TAB\s+PANE\s+PID\s+AGENT/);
    assert.ok(text.stdout.includes(String(real.pid)), "the text table shows the selected pid");
    assert.ok(text.stdout.includes(`claude:${first.pid}`), "and the nested agent's pid");
    assert.match(text.stdout, /11111111-1111-4111-8111-111111111111/);

    // a readable session with no agent in it: a real "none", exit 0, readable
    // (a session of one pane id nothing on the box uses, so a session-less agent somebody else has
    // running cannot land in it)
    writeFileSync(join(scratch, "quiet.json"), JSON.stringify([{ ...capturePane(151), id: 4243 }]));
    const quietEnv = { ZELLIJ_SESSION_NAME: `${SESSION}-nobody`, FAKE_ZELLIJ_PANES: join(scratch, "quiet.json") };
    const quiet = run(["--json"], quietEnv);
    assert.equal(quiet.status, 0);
    const none = JSON.parse(quiet.stdout);
    assert.deepEqual([none.zellijReadable, none.panes], [true, []], "none is `readable` and empty");
    assert.match(run([], quietEnv).stdout, /no live agent panes/);

    // no zellij on PATH at all: UNKNOWN, not none: exit 1, empty panes, zellijReadable false, an error
    const noZellij = join(scratch, "no-zellij");
    mkdirSync(noZellij);
    for (const tool of ["env", "timeout", "git"]) symlinkSync(which(tool), join(noZellij, tool));
    const degraded = run(["--json"], { PATH: noZellij });
    assert.equal(degraded.status, 1, "unreadable zellij is a failure, in --json too");
    const unknown = JSON.parse(degraded.stdout);
    assert.deepEqual([unknown.zellijReadable, unknown.panes, unknown.unmappedPaneIds], [false, [], []], "no phantom rows from /proc alone");
    assert.match(unknown.error, /not installed or not on PATH \(exit 127\)/, "a missing zellij says so, not \"no such session\"");
    const degradedText = run([], { PATH: noZellij });
    assert.equal(degradedText.status, 1);
    assert.match(degradedText.stderr, /not installed or not on PATH.*session ".*" \(from \$ZELLIJ_SESSION_NAME\)/, "text mode says so plainly, and which session");
    assert.equal(degradedText.stdout.trim(), "", "and prints no table");

    // a session that does not exist (zellij exits non-zero): the same honest failure
    const gone = run(["--json"], { FAKE_ZELLIJ_PANES: join(scratch, "does-not-exist.json") });
    assert.equal(gone.status, 1);
    assert.equal(JSON.parse(gone.stdout).zellijReadable, false);
    assert.match(JSON.parse(gone.stdout).error, /failed \(exit 1\)/);
    // zellij answering with an empty list is not a session either
    const emptyList = run(["--json"], { FAKE_ZELLIJ_PANES: join(scratch, "no-panes.json") });
    assert.equal(emptyList.status, 1);
    assert.match(JSON.parse(emptyList.stdout).error, /no panes at all/);

    // outside zellij ($ZELLIJ_SESSION_NAME unset): the default is used, and the output says so
    const outside = run(["--json"], {}, ["ZELLIJ_SESSION_NAME"]);
    const out = JSON.parse(outside.stdout);
    assert.deepEqual([out.session, out.sessionSource], ["Workspace", "default"]);
    assert.match(run([], {}, ["ZELLIJ_SESSION_NAME"]).stderr, /not inside zellij .* default session "Workspace"/);
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
  for (const helper of helpersStarted) {
    try {
      helper.stdin.end();
      helper.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) {
  console.error(failed);
  process.exit(1);
}
console.log("pjan-202 crank panes: ok");
