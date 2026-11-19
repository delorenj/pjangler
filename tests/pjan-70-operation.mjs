import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pjan-70-child-"));
try {
  const entry = join(scratch, "operation.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/lifecycle/operation.ts")], outfile: entry, bundle: true, platform: "node", format: "esm" });
  const { createOperation, runChild, withOperation, OperationStopped } = await import(entry);
  const fixture = join(scratch, "slow.mjs");
  writeFileSync(fixture, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [ready, late, pidFile, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ['-e', \
  'process.on("SIGTERM",()=>{}); setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"late"),1700)', late],
  { stdio: mode === 'stdio' ? ['ignore', process.stdout, 'ignore'] : 'ignore' });
writeFileSync(pidFile, String(child.pid));
writeFileSync(ready, 'ready');
if (mode === 'graceful') { process.on('SIGTERM', () => process.exit(0)); }
else { process.on('SIGTERM', () => {}); }
setTimeout(() => writeFileSync(late, 'parent-late'), 1700);
`);
  const waitFor = async (path) => {
    for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((done) => setTimeout(done, 10));
    assert.ok(existsSync(path), `fixture never reached ${path}`);
  };
  const checkNoLateWrites = async (late, pidFile) => {
    await new Promise((done) => setTimeout(done, 1900));
    assert.equal(existsSync(late), false, "no descendant/parent late write after original completion time");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Zombie adoption by the container init is not a running process.
    try { assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /^\d+ \(.+\) Z /); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  };
  const preAbort = new AbortController();
  preAbort.abort();
  const pre = createOperation(preAbort.signal, 5_000);
  const preMarker = join(scratch, "prestarted");
  await assert.rejects(withOperation(pre, () => runChild(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(preMarker)}, 'bad')`])),
    (err) => err instanceof OperationStopped && err.reason === "cancelled");
  pre.close();
  assert.equal(existsSync(preMarker), false);

  for (const [mode, reason] of [["graceful", "cancelled"], ["force", "cancelled"], ["force", "deadline-exceeded"], ["stdio", "cancelled"]]) {
    const ready = join(scratch, `${mode}-${reason}.ready`);
    const late = join(scratch, `${mode}-${reason}.late`);
    const pidFile = join(scratch, `${mode}-${reason}.pid`);
    const request = new AbortController();
    const operation = createOperation(request.signal, reason === "cancelled" ? 5_000 : 90);
    const start = performance.now();
    const running = withOperation(operation, () => runChild(process.execPath, [fixture, ready, late, pidFile, mode]));
    await waitFor(ready);
    if (reason === "cancelled") request.abort();
    await assert.rejects(running, (err) => err instanceof OperationStopped && err.reason === reason);
    assert.ok(performance.now() - start < 1_650, "bounded cleanup must beat slow child's original completion time");
    operation.close();
    await checkNoLateWrites(late, pidFile);
  }
  const overflow = await runChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBuffer: 64 });
  assert.match(overflow.error?.message ?? "", /output exceeded 64 bytes/);
  const normal = createOperation(new AbortController().signal, 5_000);
  const completed = await withOperation(normal, () => runChild(process.execPath, ["-e", "process.stdout.write('normal')"]));
  normal.close();
  assert.equal(completed.stdout, "normal");
  assert.equal(completed.status, 0);
  const subsequent = await runChild(process.execPath, ["-e", "process.stdout.write('stdio-ok')"]);
  assert.equal(subsequent.stdout, "stdio-ok");
  assert.equal(subsequent.status, 0);
  console.log("PJAN-70 process-group abort/deadline/pre-abort/force/grace/late-write/race recovery passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
