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
  const splitUtf8 = await runChild(process.execPath, ["-e", `const b=Buffer.from('é');
process.stdout.write(b.subarray(0,1)); process.stderr.write(b.subarray(0,1));
setTimeout(() => { process.stdout.write(b.subarray(1)); process.stderr.write(b.subarray(1)); }, 25);`]);
  assert.equal(splitUtf8.status, 0);
  assert.equal(splitUtf8.stdout, "é");
  assert.equal(splitUtf8.stderr, "é");
  const splitJson = await runChild(process.execPath, ["-e", `const b=Buffer.from(JSON.stringify({name:'é'}));
const i=b.indexOf(Buffer.from('é')[0]); process.stdout.write(b.subarray(0,i+1));
setTimeout(() => process.stdout.write(b.subarray(i+1)), 25);`]);
  assert.deepEqual(JSON.parse(splitJson.stdout), { name: "é" });
  const splitOverflow = await runChild(process.execPath, ["-e", `const b=Buffer.from('é');
process.stdout.write(b.subarray(0,1));
setTimeout(() => process.stderr.write(b.subarray(1)), 25);`], { maxBuffer: 1 });
  assert.match(splitOverflow.error?.message ?? "", /output exceeded 1 bytes/);
  assert.equal(splitOverflow.stdout, "�", "stdout/stderr decoding is separate even at cap");
  const withinRawCap = await runChild(process.execPath, ["-e", "process.stdout.write('é');process.stderr.write('é')"], { maxBuffer: 4 });
  assert.equal(withinRawCap.error, undefined);
  assert.equal(withinRawCap.stdout, "é");
  assert.equal(withinRawCap.stderr, "é");
  const overRawCap = await runChild(process.execPath, ["-e", "process.stdout.write('é');process.stderr.write('é')"], { maxBuffer: 3 });
  assert.match(overRawCap.error?.message ?? "", /output exceeded 3 bytes/);
  const standaloneTimeout = await runChild(process.execPath, ["-e", "setTimeout(()=>{},2000)"], { timeoutMs: 40 });
  assert.equal(standaloneTimeout.error?.code, "ETIMEDOUT");
  const requestWithLocalLimit = createOperation(new AbortController().signal, 5_000);
  try {
    await withOperation(requestWithLocalLimit, async () => {
      const localReady = join(scratch, "local.ready"), localLate = join(scratch, "local.late"), localPid = join(scratch, "local.pid");
      const start = performance.now();
      const timedOut = await runChild(process.execPath, [fixture, localReady, localLate, localPid, "force"], { timeoutMs: 120 });
      assert.equal(timedOut.error?.code, "ETIMEDOUT");
      assert.equal(timedOut.status, null);
      assert.equal(requestWithLocalLimit.stopReason(), undefined);
      assert.ok(requestWithLocalLimit.deadlineMs - performance.now() > 3_000);
      assert.ok(performance.now() - start < 1_650, "local cleanup must be bounded");
      const recovered = await runChild(process.execPath, ["-e", "process.stdout.write('recovered')"]);
      assert.equal(recovered.stdout, "recovered");
      await checkNoLateWrites(localLate, localPid);
    });
  } finally { requestWithLocalLimit.close(); }
  for (const reason of ["deadline-exceeded", "cancelled"]) {
    const request = new AbortController();
    const op = createOperation(request.signal, reason === "deadline-exceeded" ? 90 : 5_000);
    try {
      const running = withOperation(op, () => runChild(process.execPath, ["-e", "setTimeout(()=>{},2000)"], { timeoutMs: 2_000 }));
      if (reason === "cancelled") setTimeout(() => request.abort(), 40);
      await assert.rejects(running, (err) => err instanceof OperationStopped && err.reason === reason);
      assert.equal(op.stopReason(), reason);
      await assert.rejects(withOperation(op, () => runChild(process.execPath, ["-e", "process.stdout.write('bad')"])),
        (err) => err instanceof OperationStopped && err.reason === reason);
    } finally { op.close(); }
  }
  for (const reason of ["deadline-exceeded", "cancelled"]) {
    const request = new AbortController();
    const op = createOperation(request.signal, reason === "deadline-exceeded" ? 180 : 5_000);
    try {
      const running = withOperation(op, () => runChild(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},2000)"], { timeoutMs: 40 }));
      if (reason === "cancelled") setTimeout(() => request.abort(), 120);
      await assert.rejects(running, (err) => err instanceof OperationStopped && err.reason === reason,
        `shared ${reason} must supersede the local ETIMEDOUT while the group is being cleaned up`);
      assert.equal(op.stopReason(), reason);
    } finally { op.close(); }
  }
  const normal = createOperation(new AbortController().signal, 5_000);
  const completed = await withOperation(normal, () => runChild(process.execPath, ["-e", "process.stdout.write('normal')"]));
  normal.close();
  assert.equal(completed.stdout, "normal");
  assert.equal(completed.status, 0);
  const subsequent = await runChild(process.execPath, ["-e", "process.stdout.write('stdio-ok')"]);
  assert.equal(subsequent.stdout, "stdio-ok");
  assert.equal(subsequent.status, 0);
  console.log("PJAN-70 process-group stop, local/global timeout separation, split UTF-8, byte caps and recovery passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
