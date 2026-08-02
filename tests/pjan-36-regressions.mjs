// PJAN-36 — the interactive `migrate` rule picker must be human-readable: the
// rule TITLE leads, the rule id stays visible but subordinate, failing rules
// are visually distinct, and detail is available without turning the list into
// a wall of text.
//
// Two halves:
//   1. Pure presentation. `formatRulePicker` is bundled out of src/ with
//      esbuild (same trick as tests/bmad-transaction-regressions.mjs — the
//      build dir lives inside the repo so `--packages=external` still
//      resolves) and probed in a child process under FORCE_COLOR / NO_COLOR,
//      because src/utils/style resolves colorEnabled once at module load.
//   2. The non-interactive contract. `--json` is what machine consumers parse;
//      it must stay canonical JSON, free of ANSI, and byte-identical whether
//      or not color is forced on. That last assertion is the load-bearing one:
//      a styling change cannot leak into the machine path and still pass it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const cleanup = [];

const ESC = "\u001b";
const SGR = { bold: `${ESC}[1m`, dim: `${ESC}[2m`, red: `${ESC}[31m`, green: `${ESC}[32m`, yellow: `${ESC}[33m`, gray: `${ESC}[90m` };

/** Must track RULE_TITLE_COLUMN / RULE_HINT_WIDTH in src/parity/index.ts. */
const TITLE_COLUMN_CAP = 44;
const HINT_CAP = 72;

/** Temp dir inside the repo, so bundles can resolve the repo's node_modules. */
function makeBuildDir() {
  const dir = mkdtempSync(join(root, ".pjan-36-build-"));
  cleanup.push(dir);
  return dir;
}

function makeTmpDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-36-${name}-`));
  cleanup.push(dir);
  return dir;
}

const LONG_DETAIL = "ticket_provider.board_id missing even though the legacy role.yaml still contains a board binding";

/** One finding per status, so every branch of the status styling is covered. */
const RULES = [
  {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: "fail",
    summary: "9 parity issue(s) detected",
    details: [LONG_DETAIL, "agents.pm.role_dir missing", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
    fixable: true,
  },
  { id: "mise.versioning", title: "managed mise versioning block", status: "pass", summary: "mise versioning parity verified", details: [], fixable: true },
  { id: "skills.project-manifest", title: "Skillex project skills manifest", status: "warn", summary: "1 advisory raised", details: ["pack is pinned to a prerelease"], fixable: true },
  { id: "secrets.env-op", title: ".env.op + gitignore secrets contract", status: "skip", summary: "1Password CLI unavailable", details: [], fixable: true },
];

const TITLE_WIDTH = Math.min(TITLE_COLUMN_CAP, RULES.reduce((width, rule) => Math.max(width, rule.title.length), 0));

function buildProbe() {
  const dir = makeBuildDir();
  const bundle = join(dir, "parity.mjs");
  const build = spawnSync(
    "npm",
    ["exec", "--", "esbuild", join(root, "src", "parity", "index.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${bundle}`],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(build.status, 0, `esbuild must bundle the parity module\n${build.stdout ?? ""}${build.stderr ?? ""}`);

  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import { formatRulePicker } from "./parity.mjs";\n` +
      `process.stdout.write(JSON.stringify(formatRulePicker(JSON.parse(process.argv[2]))));\n`,
  );
  return probe;
}

function probePicker(probe, rules, env) {
  const result = spawnSync(process.execPath, [probe, JSON.stringify(rules)], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "", NO_COLOR: "", ...env },
  });
  assert.equal(result.status, 0, `probe must succeed\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "", NO_COLOR: "", ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** `auditedAt` is a wall-clock stamp; everything else must be reproducible. */
function normalizeJson(text) {
  return text.replace(/"auditedAt": "[^"]*"/g, '"auditedAt": "<STAMP>"');
}

const byId = (picker) => Object.fromEntries(picker.options.map((option) => [option.value, option]));

/**
 * Every rendered string the picker would put on screen, concatenated raw.
 * NOT JSON.stringify — that escapes  into six literal characters and
 * would make an "contains no ANSI" assertion vacuously true.
 */
const renderedText = (picker) => [picker.message, ...picker.options.flatMap((option) => [option.label, option.hint ?? ""])].join("\n");

try {
  const probe = buildProbe();
  const plain = probePicker(probe, RULES, { NO_COLOR: "1" });
  const colored = probePicker(probe, RULES, { FORCE_COLOR: "1" });
  const plainById = byId(plain);
  const coloredById = byId(colored);

  // ── 1. presentation only: one row per rule, same order, same values ───────
  {
    assert.deepEqual(
      plain.options.map((option) => option.value),
      RULES.map((rule) => rule.id),
      "the picker must emit exactly one row per rule, in the order it was handed them — it must not filter or re-sort (that stays in promptForRuleIds)",
    );
  }

  // ── 2. the human title leads; the rule id is still there, but subordinate ─
  {
    for (const rule of RULES) {
      const label = plainById[rule.id].label;
      assert.ok(label.includes(rule.title), `label must carry the human title for ${rule.id}: ${label}`);
      assert.ok(label.includes(rule.id), `label must still expose the rule id, so \`migrate ${rule.id}\` stays discoverable: ${label}`);
      assert.ok(
        label.indexOf(rule.title) < label.indexOf(rule.id),
        `the human title must come BEFORE the id — PJAN-36's whole point — for ${rule.id}: ${label}`,
      );
      assert.ok(!label.startsWith(rule.id), `the old id-first label must be gone for ${rule.id}: ${label}`);
      assert.ok(
        !label.includes(`[${rule.status}]`),
        `the old bracketed [${rule.status}] token must be gone — status is carried by icon + color now: ${label}`,
      );
      assert.ok(!label.includes("\n"), `labels must stay single-line or @clack's frame breaks: ${label}`);
    }

    // Exact plain composition: "<icon> <title padded to the id column>  <id>".
    assert.equal(
      plainById["sot.project-json"].label,
      `✖ ${"Canonical .project.json".padEnd(TITLE_WIDTH)}  sot.project-json`,
      "plain label composition must be icon + padded title + id column",
    );

    // Subordinate means dimmed, once color is available.
    assert.ok(
      coloredById["sot.project-json"].label.includes(`${SGR.dim}sot.project-json${ESC}[22m`),
      "the rule id must be dimmed so it reads as secondary to the title",
    );

    // A title longer than the column cap is never truncated — that row just
    // goes ragged rather than losing human-readable text.
    const longTitle = "Fleet registry matches .project.json (no duplicate or stale agents)";
    const capped = byId(probePicker(probe, [{ ...RULES[0], title: longTitle }, RULES[1]], { NO_COLOR: "1" }));
    assert.ok(capped["sot.project-json"].label.includes(longTitle), "a long title must survive intact, never elided");
    assert.equal(
      capped["mise.versioning"].label,
      `✔ ${"managed mise versioning block".padEnd(TITLE_COLUMN_CAP)}  mise.versioning`,
      `the title column must cap at ${TITLE_COLUMN_CAP}, so one long title cannot push every other row off-screen`,
    );
  }

  // ── 3. failing rules are visually distinct from passing/warning/skipped ───
  {
    const fail = coloredById["sot.project-json"].label;
    const pass = coloredById["mise.versioning"].label;
    const warn = coloredById["skills.project-manifest"].label;
    const skip = coloredById["secrets.env-op"].label;

    assert.ok(fail.includes(SGR.red), "a failing rule must be red");
    assert.ok(fail.includes(SGR.bold), "a failing rule must be bold so it pops out of the list");
    assert.ok(!pass.includes(SGR.red), "a passing rule must not be red");
    assert.ok(pass.includes(SGR.green), "a passing rule must be green");
    assert.ok(warn.includes(SGR.yellow), "a warning rule must be yellow");
    assert.ok(skip.includes(SGR.gray), "a skipped rule must be gray");
    assert.notEqual(fail, pass, "failing and passing rows must not render identically");

    // Color is an enhancement, never the only signal: with NO_COLOR the icon
    // alone still separates fail from pass.
    assert.ok(plainById["sot.project-json"].label.startsWith("✖ "), "a failing rule must carry the ✖ icon even with no color");
    assert.ok(plainById["mise.versioning"].label.startsWith("✔ "), "a passing rule must carry the ✔ icon even with no color");
    assert.ok(plainById["skills.project-manifest"].label.startsWith("⚠ "), "a warning rule must carry the ⚠ icon even with no color");
    assert.ok(plainById["secrets.env-op"].label.startsWith("○ "), "a skipped rule must carry the ○ icon even with no color");
    assert.equal(
      new Set(Object.values(plainById).map((option) => option.label.slice(0, 1))).size,
      4,
      "each status must get its own icon, so all four are distinguishable without color",
    );

    // The header tallies status, so the list can be sized up before scanning.
    assert.match(plain.message, /1 failing/, "the picker header must tally failing rules");
    assert.match(plain.message, /1 warning/, "the picker header must tally warning rules");
    assert.match(plain.message, /1 passing/, "the picker header must tally passing rules");
    assert.match(plain.message, /1 skipped/, "the picker header must tally skipped rules");
    assert.ok(colored.message.includes(`${SGR.red}1 failing`), "the failing tally must be red");
    assert.ok(!plain.message.includes("\n"), "the header must stay single-line or @clack's frame breaks");
  }

  // ── 4. detail is available, but bounded — no wall of text ────────────────
  {
    // Many details collapse to a count: every failing rule is pre-selected and
    // @clack renders hints for selected rows, so inlining nine detail lines
    // would put a paragraph on nearly every row.
    const many = plainById["sot.project-json"].hint;
    assert.ok(many, "a rule with detail must expose a hint");
    assert.ok(many.includes("9 parity issue(s) detected"), `the hint must carry the summary: ${many}`);
    assert.ok(many.includes("9 details"), `the hint must account for the details it is not showing: ${many}`);
    assert.ok(!many.includes(LONG_DETAIL), "a multi-detail rule must not paste detail text into the list");
    for (const detail of ["agents.pm.role_dir missing", "d3", "d9"]) {
      assert.ok(!many.includes(detail), `detail "${detail}" must not be inlined — that is the wall of text PJAN-36 removes`);
    }

    // A lone detail IS the whole story, so it is shown — elided to fit.
    const one = plainById["skills.project-manifest"].hint;
    assert.ok(one.startsWith("1 advisory raised"), `a single-detail hint must lead with the summary: ${one}`);
    assert.ok(one.includes("↳ pack is pinned"), `a single detail must be shown inline: ${one}`);
    assert.ok(one.endsWith("…"), `an over-budget hint must be elided with an ellipsis: ${one}`);

    // A detail-free rule's hint is just its summary — no phantom detail.
    assert.equal(plainById["mise.versioning"].hint, "mise versioning parity verified", "a detail-free rule's hint is exactly its summary");

    for (const option of plain.options) {
      assert.ok(!option.hint.includes("\n"), `hints must stay on one line: ${option.hint}`);
      assert.ok(option.hint.length <= HINT_CAP, `hints must be bounded at ${HINT_CAP}, got ${option.hint.length}: ${option.hint}`);
      // Label + hint together are what the operator actually sees on a row.
      assert.ok(
        option.label.length + option.hint.length <= 140,
        `row ${option.value} must stay near a usable terminal width, got ${option.label.length + option.hint.length}`,
      );
    }

    // The hint is a peek; the header says where the full detail lives.
    assert.match(plain.message, /pjangler audit/, "the header must point at `pjangler audit` for full detail");
  }

  // ── 5. NO_COLOR / non-TTY: not one escape byte anywhere ───────────────────
  {
    assert.ok(!renderedText(plain).includes(ESC), `NO_COLOR must produce zero ANSI escapes: ${renderedText(plain)}`);

    // No env at all: spawnSync gives a non-TTY stdout, which is the piped / CI
    // case. src/utils/style already honors NO_COLOR and TTY detection, so this
    // asserts the existing contract rather than inventing a new env contract.
    const nonTty = renderedText(probePicker(probe, RULES, {}));
    assert.ok(!nonTty.includes(ESC), `a non-TTY stdout must produce zero ANSI escapes: ${nonTty}`);

    // Sanity: the probe really can emit color, so the two assertions above are
    // testing something rather than passing vacuously.
    assert.ok(renderedText(colored).includes(ESC), "FORCE_COLOR must actually produce color, else this suite proves nothing");
  }

  // ── 6. --json is untouched: canonical, ANSI-free, color-invariant ─────────
  {
    const fixture = makeTmpDir("repo");
    const cases = [
      { name: "audit", args: ["audit", fixture, "--json"] },
      { name: "migrate --all --dry-run", args: ["migrate", "--all", "--dry-run", "--json", fixture] },
    ];

    for (const testCase of cases) {
      const off = runCli(testCase.args, { NO_COLOR: "1" });
      const on = runCli(testCase.args, { FORCE_COLOR: "1" });

      assert.ok(off.stdout.trim(), `${testCase.name} --json must print a report\nstderr:\n${off.stderr}`);
      assert.ok(!off.stdout.includes(ESC), `${testCase.name} --json must never emit ANSI escapes`);
      assert.ok(!on.stdout.includes(ESC), `${testCase.name} --json must stay ANSI-free even under FORCE_COLOR`);

      // Canonical two-space JSON and nothing else on stdout — exactly what
      // JSON.stringify(report, null, 2) produces, no banner, no stray styling.
      const parsed = JSON.parse(off.stdout);
      assert.equal(
        off.stdout,
        `${JSON.stringify(parsed, null, 2)}\n`,
        `${testCase.name} --json stdout must be the canonical JSON encoding, byte for byte`,
      );

      // The load-bearing one: presentation cannot have leaked into the machine
      // path if forcing color on changes nothing.
      assert.equal(
        normalizeJson(on.stdout),
        normalizeJson(off.stdout),
        `${testCase.name} --json must be byte-identical regardless of color settings`,
      );
    }

    // The AuditFinding wire shape is frozen: PJAN-36 added presentation, not fields.
    const report = JSON.parse(runCli(["audit", fixture, "--json"], { NO_COLOR: "1" }).stdout);
    assert.ok(report.rules.length > 0, "the fixture audit must produce rules to inspect");
    for (const rule of report.rules) {
      assert.deepEqual(
        Object.keys(rule).sort(),
        ["details", "fixable", "id", "status", "summary", "title"],
        `audit --json rule ${rule.id} must expose exactly the canonical AuditFinding keys`,
      );
    }
  }

  // ── 7. the non-interactive guards still refuse rather than render a TUI ───
  {
    const jsonNoRule = runCli(["migrate", "--json"], { NO_COLOR: "1" });
    assert.equal(jsonNoRule.status, 1, "migrate --json without a rule-id must still fail fast");
    assert.match(jsonNoRule.stderr, /JSON output requires a rule-id or --all/, "the JSON guard message must be unchanged");
    assert.equal(jsonNoRule.stdout, "", "the JSON guard must not print a picker");
  }

  console.log("PJAN-36 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
