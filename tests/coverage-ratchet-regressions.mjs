// The coverage ratchet is a gate that can fail the build and rewrite a tracked
// file, so it needs to be provably right about both.
//
// The two constants are the interesting part. 37 suites spawn subprocesses, so
// measured coverage jitters slightly run to run; TOLERANCE absorbs that, and
// BUFFER keeps a freshly raised floor from failing the very next run on the
// same jitter. A ratchet that traps you gets disabled, which is worse than no
// ratchet — so both behaviours are asserted here, not just the happy path.
//
// Hermetic: scratch files only, via the COVERAGE_FLOOR / COVERAGE_SUMMARY
// overrides. Nothing here reads or writes the repo's real floor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "coverage-ratchet.mjs");
const dir = mkdtempSync(join(tmpdir(), "pj-ratchet-"));
const SUMMARY = join(dir, "coverage-summary.json");
const FLOOR = join(dir, "floor.json");
let failures = 0;

/** c8's json-summary shape, reduced to what the ratchet reads. */
function summary({ lines, statements = lines, functions = lines, branches = lines }) {
  writeFileSync(
    SUMMARY,
    JSON.stringify({
      total: {
        lines: { pct: lines },
        statements: { pct: statements },
        functions: { pct: functions },
        branches: { pct: branches },
      },
    }),
  );
}

function floor(value) {
  if (value === null) {
    if (existsSync(FLOOR)) rmSync(FLOOR);
    return;
  }
  writeFileSync(FLOOR, JSON.stringify(value));
}

function ratchet(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, COVERAGE_FLOOR: FLOOR, COVERAGE_SUMMARY: SUMMARY },
  });
}

const readFloor = () => JSON.parse(readFileSync(FLOOR, "utf8"));

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const FLAT = (n) => ({ lines: n, statements: n, functions: n, branches: n });

test("a missing floor is seeded, not an error", () => {
  floor(null);
  summary({ lines: 40 });
  const run = ratchet("--apply");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(existsSync(FLOOR), "the first run must write a floor");
  assert.ok(readFloor().lines > 0, "seeded floor must reflect what was measured");
});

test("equal coverage holds the floor and writes nothing", () => {
  floor(FLAT(40));
  summary({ lines: 40 });
  const run = ratchet("--apply");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(readFloor().lines, 40, "an unchanged floor must not be rewritten");
});

test("a real drop fails the build", () => {
  floor(FLAT(40));
  summary({ lines: 35 });
  const run = ratchet("--check");
  assert.equal(run.status, 1, "coverage going backwards must fail");
  assert.match(run.stderr, /fell .* below the floor/);
  assert.match(run.stderr, /\.coverage-floor\.json/, "the failure must say how to deliberately lower it");
});

test("jitter inside the tolerance does not fail", () => {
  floor(FLAT(40));
  summary({ lines: 39.9 }); // within TOLERANCE (0.2)
  const run = ratchet("--check");
  assert.equal(run.status, 0, `subprocess jitter must not turn main red:\n${run.stdout}${run.stderr}`);
});

test("just outside the tolerance does fail", () => {
  floor(FLAT(40));
  summary({ lines: 39.7 }); // beyond TOLERANCE
  assert.equal(ratchet("--check").status, 1, "the tolerance must have an edge, not be a free pass");
});

test("improvement raises the floor, but stops below the measurement", () => {
  floor(FLAT(40));
  summary({ lines: 55 });
  const run = ratchet("--apply");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const raised = readFloor().lines;
  assert.ok(raised > 40, `floor must rise, got ${raised}`);
  assert.ok(raised < 55, `floor must stop below the measurement so the next run has headroom, got ${raised}`);
});

test("a freshly raised floor immediately re-passes at the same coverage", () => {
  floor(FLAT(40));
  summary({ lines: 55 });
  assert.equal(ratchet("--apply").status, 0);
  // Same coverage, second run: the BUFFER is what makes this pass.
  assert.equal(ratchet("--check").status, 0, "raising the floor must not trap the very next run");
});

test("--check never writes the floor", () => {
  floor(FLAT(40));
  summary({ lines: 55 });
  const run = ratchet("--check");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(readFloor().lines, 40, "--check must be read-only");
  assert.match(run.stdout, /would raise/, "--check should still report what it would do");
});

test("every metric is gated, not just lines", () => {
  floor(FLAT(40));
  summary({ lines: 40, statements: 40, functions: 40, branches: 20 });
  assert.equal(ratchet("--check").status, 1, "a branch-coverage drop must fail too");
});

test("a missing coverage summary is a clear error, not a silent pass", () => {
  floor(FLAT(40));
  rmSync(SUMMARY);
  const run = ratchet("--check");
  assert.equal(run.status, 1, "no summary must never pass the gate");
  assert.match(run.stderr, /test:coverage/, "the error must name the command that produces it");
});

console.log("");
rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`coverage ratchet regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("coverage ratchet regressions passed");
