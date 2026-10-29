// PJAN-191 — the PTY helper itself (tests/helpers/pty-run.mjs) is pinned with REAL
// pseudo-terminals and REAL child processes: no fake driver, no stubbed clock.
//
// Three suites drive the built CLI through that helper (pjan-184, pjan-186, pjan-187) and
// all three flaked under CPU load, always with `timedOut` true while the full expected
// output was on screen. Root cause: the old driver treated "the terminal closed" (EIO on the
// pty master) as "the child exited", checked waitpid(WNOHANG) once, and SIGKILLed a child that
// closes its fds in do_exit() a moment BEFORE it becomes a zombie. A loaded machine widens
// that window from microseconds to tens of milliseconds. The tests below make the window as
// wide as they like, deterministically, and pin the other half of the contract too: a child
// that really hangs is still killed promptly, loudly, and with its whole process group.
//
// (Children that must outlive the terminal hang-up ignore SIGHUP, as nohup does; otherwise the
// kernel's own hang-up of a dead session leader's foreground group would mask a leak.)
//
// Each child is a tiny `python3 -I -c` program (python3 is already a hard dependency of the
// helper), so what is under test is the terminal/exit behaviour, not a CLI.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOnPty } from "./helpers/pty-run.mjs";

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };
const py = (code) => ["python3", "-I", "-c", code];
const run = (code, steps, extra = {}) => {
  const started = Date.now();
  const result = runOnPty({ argv: py(code), cwd: "/", env, steps, ...extra });
  return { ...result, elapsedMs: Date.now() - started };
};
/** A process that is a zombie or gone is dead for our purposes. */
const alive = (pid) => {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
};
const pidFrom = (output, tag) => Number(output.match(new RegExp(`${tag}=(\\d+)`))?.[1]);
const stray = new Set();
const track = (pid) => { assert.ok(pid > 1, `expected a pid, got ${pid}`); stray.add(pid); return pid; };
const waitDead = (pid, ms = 3000) => {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return !alive(pid);
};

const failures = [];
/** Every section runs even if an earlier one failed, so one run lists everything that is broken. */
const section = (title, fn) => {
  console.log(title);
  try { fn(); } catch (error) { failures.push(title); console.error(`  FAILED: ${error instanceof Error ? error.message.split("\n")[0] : error}`); }
};

try {
  section("slow exit AFTER the terminal closed: the real exit status, timedOut false (the pjan-184/186/187 flake)", () => {
    // prints, closes stdin/stdout/stderr (the master reads EIO), then takes 700 ms to exit 7
    const r = run(
      "import os,time\nprint('done',flush=True)\nfor f in (0,1,2): os.close(f)\ntime.sleep(0.7)\nos._exit(7)",
      [{ wait: "done" }],
      { settleMs: 5000 },
    );
    assert.equal(r.timedOut, false, `a child that exits is not a timeout: ${r.reason}`);
    assert.equal(r.status, 7, "the child's own exit status, not SIGKILL's -9");
    assert.match(r.output, /done/);
    assert.equal(r.reason, null);
    assert.ok(r.eofToExitMs >= 500, `the test must really exercise the EIO-to-exit window (saw ${r.eofToExitMs} ms)`);
    assert.ok(r.elapsedMs < 4000, `and not wait out the settle time once the child is gone (${r.elapsedMs} ms)`);
  });

  section("slow exit with the terminal still open, and with a non-zero status", () => {
    const r = run("import time\nprint('bye',flush=True)\ntime.sleep(0.5)\nraise SystemExit(3)", [{ wait: "bye" }], { settleMs: 5000 });
    assert.equal(r.timedOut, false, r.reason);
    assert.equal(r.status, 3);
  });

  section("a child that dies of a signal reports it as a negative status, not a timeout", () => {
    const r = run("import os,signal\nprint('dying',flush=True)\nos.kill(os.getpid(), signal.SIGTERM)\nimport time; time.sleep(5)", [{ wait: "dying" }]);
    assert.equal(r.timedOut, false, r.reason);
    assert.equal(r.status, -15);
  });

  section("a REAL hang with the terminal open: killed promptly, timedOut true, status -9, a reason that says why", () => {
    const r = run("import time\nprint('ready',flush=True)\ntime.sleep(300)", [{ wait: "ready" }], { settleMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.status, -9, "SIGKILL");
    assert.match(r.reason, /child still running 1000 ms after the last step \(terminal open\): killed/);
    assert.match(r.output, /ready/, "what the child showed before it hung is still reported");
    assert.ok(r.elapsedMs >= 900 && r.elapsedMs < 4000, `fails at the settle deadline, not at the 20 s ceiling (${r.elapsedMs} ms)`);
  });

  section("a REAL hang AFTER the terminal closed is still a hang (closing the terminal is not exiting)", () => {
    const r = run("import os,time\nprint('closed',flush=True)\nfor f in (0,1,2): os.close(f)\ntime.sleep(300)", [{ wait: "closed" }], { settleMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.status, -9);
    assert.match(r.reason, /still running 1000 ms after the last step \(terminal closed\)/);
    assert.ok(r.elapsedMs < 4000, `${r.elapsedMs} ms`);
  });

  section("a step whose screen never appears: timedOut after timeoutMs, naming the step and the pattern", () => {
    const r = run("import time\nprint('hello',flush=True)\ntime.sleep(300)", [{ wait: "hello" }, { wait: "never-shown" }], { timeoutMs: 1000, settleMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.status, -9);
    assert.match(r.reason, /step 2 did not show \/never-shown\/ within 1000 ms/);
    assert.equal(r.stepsDone, 1);
    assert.ok(r.elapsedMs < 4000, `${r.elapsedMs} ms`);
  });

  section("a hang leaves nothing behind: the child's whole process group is killed", () => {
    const r = run("import os,signal\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nchild = os.fork()\nif child == 0:\n    import time; time.sleep(300)\nelse:\n    print('gc=%d' % child, flush=True)\n    import time; time.sleep(300)", [{ wait: "gc=\\d+" }], { settleMs: 800 });
    const gc = track(pidFrom(r.output, "gc"));
    assert.equal(r.timedOut, true);
    assert.ok(waitDead(gc), "the hung child's own child outlived the run");
  });

  section("an immediate exit: its status, quickly, whether or not the awaited screen ever showed", () => {
    for (let i = 0; i < 25; i++) {
      const r = run("print('bye')\nraise SystemExit(5)", [{ wait: "bye" }], { settleMs: 5000 });
      assert.equal(r.timedOut, false, `run ${i}: ${r.reason}`);
      assert.equal(r.status, 5, `run ${i}`);
      assert.match(r.output, /bye/);
      assert.equal(r.stepsDone, 1);
    }
    const early = run("print('only this')\nraise SystemExit(6)", [{ wait: "a screen that never comes" }], { timeoutMs: 15_000 });
    assert.equal(early.timedOut, false, "the child exited; that is not a timeout");
    assert.equal(early.status, 6);
    assert.equal(early.stepsDone, 0, "the unmatched step is visible to the caller");
    assert.ok(early.elapsedMs < 4000, `a dead child is noticed at once, not after the 15 s step timeout (${early.elapsedMs} ms)`);
  });

  section("an exit that leaves a background process holding the terminal: still the exit status, no stall, no leak", () => {
    const r = run("import os,signal\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nchild = os.fork()\nif child == 0:\n    import time; time.sleep(300)\nelse:\n    print('gc=%d' % child, flush=True)\n    raise SystemExit(4)", [{ wait: "gc=\\d+" }], { timeoutMs: 3000, settleMs: 1000 });
    const gc = track(pidFrom(r.output, "gc"));
    assert.equal(r.timedOut, false, r.reason);
    assert.equal(r.status, 4);
    assert.ok(r.elapsedMs < 4000, `the final drain must not wait for a terminal something else still holds (${r.elapsedMs} ms)`);
    assert.ok(waitDead(gc), "the straggler outlived the run");
  });

  section("late input readiness: a key is written only once the child reads keys, never into a screen that has not started listening", () => {
    // draws its menu, THEN (600 ms later) switches to raw mode and reads one key -- as a loaded
    // Ink screen does between its first frame and its input handler. tty.setraw flushes pending
    // input (TCSAFLUSH), so a key written early is lost for good.
    const r = run(
      "import os,sys,time,tty\nprint('menu',flush=True)\ntime.sleep(0.6)\ntty.setraw(0)\nkey = os.read(0, 1)\nprint('got:' + key.decode(), flush=True)",
      [{ wait: "menu", send: "x" }, { wait: "got:x" }],
      { timeoutMs: 8000, settleMs: 3000 },
    );
    assert.equal(r.timedOut, false, `${r.reason}\n${r.output}`);
    assert.equal(r.status, 0);
    assert.match(r.output, /got:x/);
    assert.equal(r.stepsDone, 2);
    // several keys in a row stay in order
    const many = run(
      "import os,time,tty\nprint('go',flush=True)\ntime.sleep(0.3)\ntty.setraw(0)\ngot = b''\nwhile len(got) < 3:\n    got += os.read(0, 8)\nprint('keys:' + got.decode(), flush=True)",
      [{ wait: "go", send: "a" }, { wait: "go", send: "bc" }, { wait: "keys:abc" }],
      { timeoutMs: 8000, settleMs: 3000 },
    );
    assert.equal(many.timedOut, false, `${many.reason}\n${many.output}`);
    assert.match(many.output, /keys:abc/);
  });

  section("a child that reads COOKED input opts out with ready:false; without it the run says exactly why it never typed", () => {
    const cooked = "name = input('name? ')\nprint('hi ' + name, flush=True)";
    const ok = run(cooked, [{ wait: "name\\?", send: "ada\r", ready: false }, { wait: "hi ada" }], { timeoutMs: 8000, settleMs: 3000 });
    assert.equal(ok.timedOut, false, ok.reason);
    assert.equal(ok.status, 0);
    const stuck = run(cooked, [{ wait: "name\\?", send: "ada\r" }], { timeoutMs: 1000, settleMs: 1000 });
    assert.equal(stuck.timedOut, true);
    assert.match(stuck.reason, /step 1: \/name\\\?\/ is on screen but the child never switched the terminal to raw mode/);
    assert.equal(stuck.output.includes("hi ada"), false, "the key was never written");
  });

  section("a command that cannot start: status 127 and the reason on screen, not a driver crash or a hang", () => {
    const r = runOnPty({ argv: ["/nonexistent/pty-run-test-binary"], cwd: "/", env, steps: [{ wait: "never" }], timeoutMs: 15_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 127);
    assert.match(r.output, /pty-run: cannot start '\/nonexistent\/pty-run-test-binary'/);
  });

  section("the terminal is sized before the child starts reading it", () => {
    for (let i = 0; i < 10; i++) {
      const r = run("import os\nc, l = os.get_terminal_size()[0], os.get_terminal_size()[1]\nprint('size=%dx%d' % (c, l))", [{ wait: "size=" }]);
      assert.match(r.output, /size=110x40/, `run ${i}`);
    }
  });
} finally {
  for (const pid of stray) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}
if (failures.length) {
  console.error(`\nPJAN-191 pty helper regressions: ${failures.length} section(s) FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nPJAN-191 pty helper regressions: all green");
