// The coverage path audit decides whether the ratchet's total is a measurement
// of src at all, so it has to be right in both directions: a clean report must
// pass untouched, and each way the file list has actually gone wrong must be
// refused before any floor is compared or written.
//
// Both shapes below are real. PJAN-100: c8 measured an in-repo `.pjan-*`
// fixture copy of the package as a second src tree. Its fix passed --exclude,
// which replaced c8's default exclude list, so CI run 36901774009 gated a total
// that counted 72 tests/ files alongside 77 src files and read ~8.7 points high
// (PJAN-156).
//
// Hermetic: a scratch root with COVERAGE_ROOT / COVERAGE_FLOOR /
// COVERAGE_SUMMARY overrides. The last group reads the real .c8rc.json and
// package.json, read-only, to pin the c8 side of the contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditCoverageSummary } from "../scripts/coverage-audit.mjs";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "coverage-ratchet.mjs");
const dir = mkdtempSync(join(tmpdir(), "pj-cov-audit-"));
const ROOT = join(dir, "repo");
mkdirSync(ROOT);
const SUMMARY = join(dir, "coverage-summary.json");
const FLOOR = join(dir, "floor.json");
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const metric = (pct) => ({ total: 100, covered: pct, skipped: 0, pct });
const entry = (pct = 80) => ({ lines: metric(pct), statements: metric(pct), functions: metric(pct), branches: metric(pct) });

/** A c8 json-summary: absolute keys, one per measured file, plus the total. */
function report(paths, pct = 80) {
  const files = Object.fromEntries(paths.map((p) => [p.startsWith("/") ? p : join(ROOT, p), entry(pct)]));
  return { total: entry(pct), ...files };
}

const CLEAN = ["src/index.ts", "src/commands/init.ts", "scripts/coverage-ratchet.mjs", "migrations/1_registry.cjs"];

const reasons = (summary) => auditCoverageSummary(summary, ROOT).problems.map((p) => p.reason);

function ratchet(summary, floor, ...args) {
  writeFileSync(SUMMARY, JSON.stringify(summary));
  writeFileSync(FLOOR, JSON.stringify(floor));
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, COVERAGE_ROOT: ROOT, COVERAGE_FLOOR: FLOOR, COVERAGE_SUMMARY: SUMMARY },
  });
}

const FLAT = (n) => ({ lines: n, statements: n, functions: n, branches: n });

// ---- the audit itself ----

test("a clean src/scripts/migrations report has no findings", () => {
  const audit = auditCoverageSummary(report(CLEAN), ROOT);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.files, 4);
  assert.deepEqual(audit.byTop, { src: 2, scripts: 1, migrations: 1 });
});

test("a tests/ key is refused (the PJAN-156 shape)", () => {
  assert.deepEqual(reasons(report([...CLEAN, "tests/pjan-23-regressions.mjs"])), [
    "test file counted as source (tests/)",
  ]);
});

test("a .pjan-* fixture copy is refused, and named as a repeated src path too (the PJAN-100 shape)", () => {
  const found = reasons(report([...CLEAN, ".pjan-77 npm pack space x1/package/src/index.ts"]));
  assert.ok(found.includes("test fixture copy of the package (.pjan-*)"), found.join("; "));
  assert.ok(found.includes("src/index.ts measured 2 times"), found.join("; "));
});

test("a dist/ key is refused", () => {
  assert.deepEqual(reasons(report([...CLEAN, "dist/index.js"])), ["bundle measured without its source map (dist/)"]);
});

test("a key outside the repository root is refused", () => {
  const found = reasons(report([...CLEAN, join(dir, "elsewhere", "lib", "x.ts")]));
  assert.deepEqual(found, ["outside the repository root"]);
});

test("a sibling directory that merely shares the root's name prefix is outside it", () => {
  const found = reasons(report([...CLEAN, `${ROOT}-copy/lib/x.ts`]));
  assert.deepEqual(found, ["outside the repository root"]);
});

test("the same src path measured from two places is refused", () => {
  const found = reasons(report([...CLEAN, "vendor/copy/src/commands/init.ts"]));
  assert.deepEqual(found, ["src/commands/init.ts measured 2 times", "src/commands/init.ts measured 2 times"]);
});

test("two spellings of one src path are refused", () => {
  const found = reasons(report([...CLEAN, `${ROOT}/src/../src/index.ts`]));
  assert.ok(found.every((r) => r === "src/index.ts measured 2 times") && found.length === 2, found.join("; "));
});

test("a root reached through a symlink is not mistaken for outside", () => {
  const link = join(dir, "link-to-repo");
  symlinkSync(ROOT, link);
  const audit = auditCoverageSummary(report(CLEAN), link);
  assert.deepEqual(audit.problems, []);
});

// ---- the ratchet runs it, before anything else ----

test("the ratchet passes a clean report and says what it audited", () => {
  const run = ratchet(report(CLEAN), FLAT(80), "--check");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /audited 4 file\(s\): migrations 1, scripts 1, src 2/);
});

test("a bad report fails the ratchet even when coverage looks better, and writes no floor", () => {
  const run = ratchet(report([...CLEAN, "tests/pjan-23-regressions.mjs"], 99), FLAT(80), "--apply");
  assert.equal(run.status, 1, "an audited failure must fail the gate");
  assert.match(run.stderr, /test file counted as source \(tests\/\): .*tests\/pjan-23-regressions\.mjs/);
  assert.match(run.stderr, /\.c8rc\.json/, "the failure must say where the measurement is configured");
  assert.doesNotMatch(run.stdout, /raised|would raise/, "a wrong total must never be compared");
  assert.deepEqual(JSON.parse(readFileSync(FLOOR, "utf8")), FLAT(80), "--apply must not write a floor from a wrong total");
});

// ---- the c8 side of the contract ----

test(".c8rc.json restates every c8 default exclude plus the .pjan-* fixtures", () => {
  const rc = JSON.parse(readFileSync(join(REPO, ".c8rc.json"), "utf8"));
  const defaults = createRequire(join(REPO, "package.json"))("@istanbuljs/schema/default-exclude");
  for (const pattern of defaults) {
    assert.ok(rc.exclude.includes(pattern), `.c8rc.json exclude is missing c8's default ${pattern}`);
  }
  assert.ok(rc.exclude.includes("**/.pjan-*/**"), "the PJAN-100 fixture exclusion must stay");
  assert.ok([rc.reporter].flat().includes("json-summary"), "the ratchet reads json-summary");
  assert.equal(rc["report-dir"], "coverage", "the ratchet reads coverage/coverage-summary.json");
});

test("test:coverage passes no c8 flag that would override .c8rc.json", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const command = pkg.scripts["test:coverage"];
  assert.match(command, /\bc8 node scripts\/run-tests\.mjs/);
  assert.doesNotMatch(command, /--(exclude|include|reporter|report-dir|reports-dir|src|config)\b|\s-[nxroc]\s/);
});

console.log("");
rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`coverage path audit regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("coverage path audit regressions passed");
