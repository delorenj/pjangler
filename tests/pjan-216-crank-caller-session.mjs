import "./helpers/hermetic-suite.mjs";
// PJAN-216: a session belongs to the project its agent runs in, never to wherever pj was invoked
// from. `cd ../other && pj crank enable` from an agent's shell tool used to bind THAT agent's
// session to `other` (callerSession took pj's own cwd), superseding its real crank.
//
// Pinned here against real processes: callerSession reads the agent's cwd from /proc/<pid>/cwd, and
// falls back to pj's cwd only when that pid cannot be read.

import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = hermeticScratch("pjan-216");
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(join(workspace, "entry.ts"), `export { agentCwd, callerSession } from ${JSON.stringify(join(root, "src/crank/sessions.ts"))};\n`);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the PJAN-216 kit:\n${built.stderr}`);
  process.exit(1);
}
const { agentCwd, callerSession } = await import(kitOut);

let failures = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok - ${name}`);
  } catch (error) {
    failures++;
    results.push(`not ok - ${name}\n  ${error instanceof Error ? error.stack : error}`);
  }
}

// A real "agent": a long-lived process started in its own project directory.
const agentHome = join(workspace, "agent-project");
mkdirSync(agentHome, { recursive: true });
const agent = spawn("sleep", ["60"], { cwd: agentHome, env: hermeticEnv(), stdio: "ignore" });
await new Promise((ok) => setTimeout(ok, 50));

try {
  await test("callerSession: a Claude caller's cwd is its agent's, not pj's", () => {
    assert.notEqual(realpathSync(process.cwd()), realpathSync(agentHome), "precondition: pj runs elsewhere");
    const caller = callerSession({ CLAUDE_CODE_SESSION_ID: "sid-216", CLAUDE_PID: String(agent.pid) });
    assert.equal(caller.cli, "claude");
    assert.equal(caller.pid, agent.pid);
    assert.equal(caller.cwd, realpathSync(agentHome));
  });

  await test("agentCwd falls back to pj's cwd for a pid it cannot read (gone, or not a pid)", () => {
    assert.equal(agentCwd(undefined, "/fallback"), "/fallback");
    assert.equal(agentCwd(0, "/fallback"), "/fallback");
    assert.equal(agentCwd(2 ** 22 + 7, "/fallback"), "/fallback", "no such process");
    assert.equal(agentCwd(agent.pid, "/fallback"), realpathSync(agentHome));
  });

  await test("no agent env: no caller", () => {
    assert.equal(callerSession({}), undefined);
  });
} finally {
  agent.kill("SIGKILL");
}

console.log(results.join("\n"));
if (failures) {
  console.error(`${failures} PJAN-216 test(s) failed`);
  process.exit(1);
}
console.log(`PJAN-216 caller session: ${results.length} passed`);
