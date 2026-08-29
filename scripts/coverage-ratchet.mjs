#!/usr/bin/env node
// Coverage ratchet: coverage may go up, and may not come back down.
//
// The floor lives in .coverage-floor.json, tracked in git, so every raise is a
// reviewable diff and a revert is `git revert`. There is no coverage target to
// argue about — the target is "more than last time".
//
//   --check    compare against the floor and exit non-zero if it slipped.
//   --apply    the same, and RAISE the floor when coverage improved.
//
// Two constants make this survive real life rather than an ideal CI:
//
// TOLERANCE — coverage of a suite that spawns 37 subprocesses is not perfectly
// deterministic; a hair of jitter must not turn main red. Anything within this
// band of the floor passes untouched.
//
// BUFFER — when the floor rises it stops slightly below the measured value, so
// the very next run does not fail on that same jitter. A ratchet that
// immediately traps you is a ratchet you disable.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Both paths are overridable so the ratchet can be exercised against a scratch
// tree. A gate nobody can test is a gate nobody trusts.
const ROOT = resolve(process.env.COVERAGE_ROOT ?? resolve(import.meta.dirname, ".."));
const FLOOR_PATH = resolve(process.env.COVERAGE_FLOOR ?? resolve(ROOT, ".coverage-floor.json"));
const SUMMARY_PATH = resolve(
  process.env.COVERAGE_SUMMARY ?? resolve(ROOT, "coverage", "coverage-summary.json"),
);

const TOLERANCE = 0.2; // percentage points of accepted jitter
const BUFFER = 0.1; // how far below the new high-water mark the floor lands
const METRICS = ["lines", "statements", "functions", "branches"];

const apply = process.argv.includes("--apply");

if (!existsSync(SUMMARY_PATH)) {
  console.error(`coverage-ratchet: no coverage summary at ${SUMMARY_PATH}`);
  console.error("  run: npm run test:coverage");
  process.exit(1);
}

const total = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")).total;
const measured = Object.fromEntries(METRICS.map((m) => [m, total[m].pct]));

// A missing floor file is a first run, not a failure: seed it from what we measured.
const floor = existsSync(FLOOR_PATH)
  ? JSON.parse(readFileSync(FLOOR_PATH, "utf8"))
  : { ...Object.fromEntries(METRICS.map((m) => [m, 0])), seeded: true };

const slipped = [];
const raised = [];

for (const metric of METRICS) {
  const now = measured[metric];
  const min = typeof floor[metric] === "number" ? floor[metric] : 0;
  if (now < min - TOLERANCE) {
    slipped.push({ metric, now, min, delta: (now - min).toFixed(2) });
  } else if (now - BUFFER > min) {
    raised.push({ metric, from: min, to: Number((now - BUFFER).toFixed(2)) });
  }
}

const pad = (s) => String(s).padEnd(11);
console.log("");
console.log("  coverage ratchet");
for (const metric of METRICS) {
  const now = measured[metric];
  const min = typeof floor[metric] === "number" ? floor[metric] : 0;
  const mark = now < min - TOLERANCE ? "SLIPPED" : now - BUFFER > min ? "raised " : "held   ";
  console.log(`    ${pad(metric)} ${String(now.toFixed(2)).padStart(6)}%   floor ${String(min.toFixed(2)).padStart(6)}%   ${mark}`);
}
console.log("");

if (slipped.length) {
  for (const s of slipped) {
    console.error(`  ${s.metric} fell ${s.delta} points below the floor (${s.now.toFixed(2)}% < ${s.min.toFixed(2)}%)`);
  }
  console.error("");
  console.error("  Coverage went backwards. Either add tests for what you changed, or —");
  console.error("  if the drop is deliberate, e.g. you deleted well-covered code — lower the");
  console.error("  floor in .coverage-floor.json in the same commit, so it is reviewable.");
  console.error("");
  process.exit(1);
}

if (!raised.length) {
  console.log("  floor held. nothing to write.");
  process.exit(0);
}

if (!apply) {
  for (const r of raised) {
    console.log(`  would raise ${r.metric}: ${r.from.toFixed(2)}% -> ${r.to.toFixed(2)}%`);
  }
  console.log("");
  console.log("  (--check mode; re-run with --apply to write the floor)");
  process.exit(0);
}

const next = { ...floor };
delete next.seeded;
for (const r of raised) next[r.metric] = r.to;
next.updated = new Date().toISOString().slice(0, 10);
next.note = "Managed by scripts/coverage-ratchet.mjs. Raised automatically; lower it by hand, in the commit that justifies it.";

writeFileSync(FLOOR_PATH, `${JSON.stringify(next, null, 2)}\n`);
for (const r of raised) {
  console.log(`  raised ${r.metric}: ${r.from.toFixed(2)}% -> ${r.to.toFixed(2)}%`);
}
console.log(`\n  wrote ${FLOOR_PATH.startsWith(ROOT) ? FLOOR_PATH.slice(ROOT.length + 1) : FLOOR_PATH}`);
