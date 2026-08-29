// PJAN-27 — pjangler must not ship an "autonomous ticket lifecycle" workflow.
//
// That authority belongs to Krebs, Momo, and the Hermes PM. A BMAD workflow
// claiming it lived in two places at once: pjangler's own `_bmad`, and the
// `templates/commonproject` submodule. The pjangler copy was removed in
// 74978fd; the submodule copy survived that cleanup and was removed later.
//
// Losing it twice is the reason this file exists. It guards BOTH trees, and
// it guards the manifests too — a workflow row that outlives its directory is
// still an instruction an agent can read and follow.
//
// The residue also carried a concrete contract violation worth naming: its
// data/event-schemas.md told agents to emit
//   {"event_type": "ticket.state_changed", "version": "v1"}
// which is neither CloudEvents nor the Bloodbank grammar, and carries the
// version token the platform retired. So this file additionally forbids that
// shape and the legacy holyfields schema home from any BMAD content.
//
// Fully hermetic: filesystem reads only, no network, no subprocess.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Both BMAD trees pjangler is responsible for. */
const TREES = {
  "pjangler/_bmad": join(root, "_bmad"),
  "templates/commonproject/_bmad": join(root, "templates", "commonproject", "_bmad"),
};

/** Generated per-CLI command surfaces, which mirror `_bmad` and drift silently. */
const COMMAND_SURFACES = [
  [".augment", join(root, ".augment")],
  [".claude", join(root, ".claude")],
  [".gemini", join(root, ".gemini")],
  [".opencode", join(root, ".opencode")],
  ["commonproject/.augment", join(root, "templates", "commonproject", ".augment")],
  ["commonproject/.claude", join(root, "templates", "commonproject", ".claude")],
  ["commonproject/.gemini", join(root, "templates", "commonproject", ".gemini")],
  ["commonproject/.opencode", join(root, "templates", "commonproject", ".opencode")],
];

/** Authority pjangler does not hold. Matched case-insensitively against paths. */
const FORBIDDEN_PATH_TOKEN = "ticket-lifecycle";

/** Event shapes no BMAD content may instruct an agent to emit. */
const FORBIDDEN_CONTENT = [
  { pattern: /"event_type"\s*:/, why: 'raw "event_type" — Bloodbank envelopes are CloudEvents with a "type"' },
  { pattern: /"version"\s*:\s*"v\d+"/, why: 'a "version": "vN" token — the platform retired the version token' },
  { pattern: /holyfields\/schemas/, why: "holyfields is not the canonical schema home; bloodbank/schemas is" },
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a dangling symlink is not our concern here
    }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let checked = 0;

// 1. No path in either tree, or in any generated command surface, may name the
//    decommissioned workflow.
for (const [label, dir] of [...Object.entries(TREES), ...COMMAND_SURFACES]) {
  if (!existsSync(dir)) continue;
  const hits = walk(dir).filter((p) => p.toLowerCase().includes(FORBIDDEN_PATH_TOKEN));
  assert.deepEqual(
    hits.map((p) => p.slice(root.length + 1)),
    [],
    `${label} still carries ${FORBIDDEN_PATH_TOKEN} residue — pjangler does not own ticket lifecycle authority`,
  );
  checked += 1;
}

// 2. No manifest row may reference it either. A row that outlives its files
//    still advertises the workflow to an agent reading the manifest.
for (const [label, dir] of Object.entries(TREES)) {
  const configDir = join(dir, "_config");
  if (!existsSync(configDir)) continue;
  for (const csv of readdirSync(configDir).filter((f) => f.endsWith(".csv"))) {
    const file = join(configDir, csv);
    const offending = readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.toLowerCase().includes(FORBIDDEN_PATH_TOKEN));
    assert.deepEqual(
      offending,
      [],
      `${label}/_config/${csv} still lists ${FORBIDDEN_PATH_TOKEN}`,
    );
    checked += 1;
  }
}

// 3. No LOCALLY AUTHORED BMAD content may teach an agent a non-Bloodbank event
//    shape. Scoped to `custom/` on purpose: the vendored upstream modules
//    (bmm, bmb, cis, core, tea) legitimately discuss other systems' payloads —
//    bmm/testarch/knowledge/contract-testing.md documents a GitHub
//    repository_dispatch body with an "event_type" field, which is correct
//    there and none of our business.
for (const [label, dir] of Object.entries(TREES)) {
  for (const sub of ["custom", join("_config", "custom")]) {
    const authored = join(dir, sub);
    if (!existsSync(authored)) continue;
    for (const file of walk(authored).filter((p) => p.endsWith(".md"))) {
      const text = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN_CONTENT) {
        assert.ok(
          !pattern.test(text),
          `${label}/${sub}: ${file.slice(root.length + 1)} contains ${why}`,
        );
      }
      checked += 1;
    }
  }
}

// The assertions above pass trivially if the trees are missing, so prove we
// actually looked at something.
assert.ok(checked > 10, `expected to inspect real BMAD content, only checked ${checked} targets`);

console.log(`BMAD authority regressions: passed (${checked} targets inspected)`);
