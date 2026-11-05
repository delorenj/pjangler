// PJAN-202: real pid reuse, for the starttime half of ProcScanner's cache key.
//
// Run as root INSIDE a fresh pid namespace with its own /proc:
//
//   sudo -n unshare --kill-child -pf --mount-proc <node> pid-reuse-child.mjs <kit.mjs> <agent-link> <home> <marker>
//
// Inside it, the scanner's DEFAULT enumeration (all of /proc) sees only this namespace, so the
// whole scenario is deterministic and cannot touch, or be disturbed by, any process on the box:
//
//   1. process A (an agent in pane 11) is started; a warm scanner learns it;
//   2. A is killed and reaped; ns_last_pid is rewound so the next fork is handed A's pid;
//   3. process B (the SAME executable, so the same comm, in pane 22) is started and gets A's pid;
//   4. the same warm scanner scans again.
//
// B has A's pid and A's comm; only its starttime differs. A cache keyed on (pid, comm) would serve
// A's pane tag (pane 11) for B. The scanner must report pane 22. Prints PID-REUSE-OK on success and
// exits non-zero (with the reason on stderr) otherwise.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hermeticEnv } from "./hermetic-env.mjs";

const [kitPath, agentLink, home] = process.argv.slice(2);
if (!kitPath || !agentLink || !home) {
  console.error("usage: pid-reuse-child.mjs <kit.mjs> <agent-link> <home>");
  process.exit(2);
}
const { ProcScanner, readProcStat } = await import(kitPath);

const SESSION = "pjan-202-pid-reuse";
const IDLE = ["-e", "setInterval(() => {}, 1e6)"];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const fail = (message) => {
  console.error(`PID-REUSE-FAIL: ${message}`);
  process.exit(1);
};
const cmdline0 = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  } catch {
    return "";
  }
};
const launch = (pane) =>
  spawn(agentLink, IDLE, { stdio: "ignore", env: hermeticEnv({ HOME: home, ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: String(pane) }) });
/** Wait until `pid` is the agent (exec done) and node has renamed its main thread: comm is then stable.
 *  The renamed comm depends on the node build: "node-MainThread" on the operator box, plain
 *  "MainThread" on GitHub's ubuntu-latest node (CI run 42077680158). Match the suffix, not one build. */
const settled = async (pid) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (cmdline0(pid) === agentLink && /MainThread$/.test(readProcStat(pid)?.comm ?? "")) return;
    await sleep(10);
  }
  fail(`process ${pid} never settled (cmdline ${cmdline0(pid)}, comm ${readProcStat(pid)?.comm})`);
};

const a = launch(11);
await settled(a.pid);
const scanner = new ProcScanner();
const first = scanner.scan(SESSION).find((p) => p.pid === a.pid);
if (first?.paneId !== 11) fail(`premise: the first scan should attribute pid ${a.pid} to pane 11, got ${JSON.stringify(first)}`);
const aStat = readProcStat(a.pid);

const gone = new Promise((done) => a.once("exit", done));
a.kill("SIGKILL");
await gone; // reaped: the pid is free

let b;
for (let attempt = 0; attempt < 200 && !b; attempt++) {
  writeFileSync("/proc/sys/kernel/ns_last_pid", String(a.pid - 1));
  const candidate = launch(22);
  if (candidate.pid === a.pid) {
    b = candidate;
  } else {
    const exited = new Promise((done) => candidate.once("exit", done));
    candidate.kill("SIGKILL");
    await exited;
  }
}
if (!b) fail(`could not get pid ${a.pid} handed out again`);
await settled(b.pid);
const bStat = readProcStat(b.pid);
if (bStat.comm !== aStat.comm) fail(`premise: same comm expected (${aStat.comm} vs ${bStat.comm})`);
if (bStat.startTime === aStat.startTime) fail(`premise: a reused pid must have a different starttime (${bStat.startTime})`);

const second = scanner.scan(SESSION);
const row = second.find((p) => p.pid === b.pid);
if (!row) fail(`pid ${b.pid} is missing from the second scan`);
if (row.paneId !== 22) fail(`pid ${b.pid} was reused by a process in pane 22 but the warm scanner still says pane ${row.paneId}: the cache key ignores starttime`);
if (second.some((p) => p.paneId === 11)) fail("the dead agent's pane (11) is still being reported");
console.log(`PID-REUSE-OK pid=${b.pid} comm=${bStat.comm} startA=${aStat.startTime} startB=${bStat.startTime}`);
b.kill("SIGKILL");
process.exit(0);
