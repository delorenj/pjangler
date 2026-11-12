import "./helpers/hermetic-suite.mjs";
// PJAN-209: a brand-new project has to bootstrap on a machine whose Skillex
// selection uses LINK sources, and when it cannot it has to say why.
//
// What happened (2026-11-12): `pj init shortwave ... --apply -y` failed and
// rolled the target back with
//
//     x skills.project-manifest: 9 Skillex finding(s)
//     x No ticket board - the plane board was not confirmed ... once the
//       provider credential resolves
//
// Neither line told the truth.
//
//   1. The findings were never printed. A rule's summary is a COUNT; the
//      findings live in `details`, and the transaction error built from a
//      finding carried the summary only. Rollback then deleted the target, so
//      the operator had nothing left to run `pj audit` on either.
//   2. The findings were E_SKILL_MISSING for `heyma`: the operator's global
//      selection names a skillex LINK-source skill (ADR-0002, skillex >= 0.4.0:
//      the skill is authored in another repo and linked, nothing is copied),
//      and the skillex core pjangler bundles was 0.3.0, which does not know
//      `mode = "link"` and so looked for a copied definition that never exists.
//      Every `pj init` on this machine failed for that, with or without a board.
//   3. The board line blamed the provider credential. The transaction had died
//      before the ticket-provider phase; no adapter was ever called.
//
// This pins all three: the link-source create works, a failing skills check
// prints its findings, and an unreached board step says so instead of blaming
// the credential.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const LINK_REPO = "git@github.com:pjtest/linked-skills.git";
const LINK_SKILL = "pjtest-linked-hub";

let failures = 0;
function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
    console.log(error.message.split("\n").slice(1).map((line) => `       ${line}`).join("\n"));
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: hermeticEnv({ GIT_CEILING_DIRECTORIES: cwd }) });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * One machine: a skill catalog declaring a LINK source, an operator whose global
 * selection includes the linked skill, and (optionally) the checkout that
 * source resolves to. `withCheckout: false` is a machine that selected a link
 * skill it does not have, which skillex reports as E_SKILL_MISSING.
 */
function machine(scratch, name, { withCheckout }) {
  const base = join(scratch, name);
  const home = join(base, "home");
  const catalog = join(base, "catalog");
  mkdirSync(home, { recursive: true });
  createSkillPackFixture(catalog);
  writeFileSync(join(catalog, "all-skills", "sources.toml"), [
    "version = 1",
    "",
    "[[source]]",
    'name = "pjtest-linked"',
    `repo = "${LINK_REPO}"`,
    'checkout = "linked-skills"',
    'mode = "link"',
    "optional = true",
    `skills = ["${LINK_SKILL}"]`,
    "",
  ].join("\n"), "utf8");
  if (withCheckout) {
    const checkout = join(home, "code", "linked-skills");
    mkdirSync(join(checkout, "skills", LINK_SKILL), { recursive: true });
    writeFileSync(join(checkout, "skills", LINK_SKILL, "SKILL.md"), `---\nname: ${LINK_SKILL}\ndescription: Authored in another repository and linked here.\n---\n# ${LINK_SKILL}\n`, "utf8");
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["remote", "add", "origin", LINK_REPO]);
  }
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills.json"), `${JSON.stringify({ scope: "global", skills: [LINK_SKILL] }, null, 2)}\n`, "utf8");
  const fixture = {
    HOME: home,
    PATH: `${createSkillexMiseFixture(base)}:${process.env.PATH}`,
    PJ_SKILLS_REGISTRY_ROOT: catalog,
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(catalog),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    GIT_CEILING_DIRECTORIES: base,
    NO_COLOR: "1",
  };
  return { base, fixture, registry: join(base, "registry.yaml") };
}

function init(m, name, extra, envExtra = {}) {
  const target = join(m.base, name);
  const result = spawnSync(
    process.execPath,
    [CLI, "init", name, "--target-dir", target, "--registry", m.registry, "--apply", "-y", "--no-tui", ...extra],
    { cwd: m.base, encoding: "utf8", env: hermeticEnv({ ...m.fixture, ...envExtra }), timeout: 600_000 },
  );
  return { target, result, text: `${result.stdout}${result.stderr}` };
}

console.log("pjan-209 init bootstrap");
const scratch = hermeticScratch("pjan-209-");
try {
  // Case 1: the machine that failed on 2026-11-12, minus the secrets.
  const good = machine(scratch, "linked", { withCheckout: true });

  check("a new project is created on a machine whose global selection uses a link-source skill", () => {
    const created = init(good, "linkedproj", ["--skip-board", "--json"]);
    assert.equal(created.result.status, 0, `init must succeed:\n${created.text}`);
    const report = JSON.parse(created.result.stdout);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.audit?.ok, true, JSON.stringify(report.audit?.rules?.filter((rule) => rule.status === "fail")));
    assert.ok(existsSync(join(created.target, ".project.json")), "the project manifest must exist");
    assert.ok(existsSync(join(created.target, ".agents", "skills")), "the canonical skills root must exist");
  });

  check("the project skills audit is clean on that machine afterwards", () => {
    const target = join(good.base, "linkedproj");
    const audited = spawnSync(process.execPath, [CLI, "audit", target, "--registry", good.registry, "--rules", "skills.project-manifest", "--json"], { cwd: good.base, encoding: "utf8", env: hermeticEnv(good.fixture) });
    const report = JSON.parse(audited.stdout);
    const rule = report.rules.find((entry) => entry.id === "skills.project-manifest");
    assert.ok(rule, "skills.project-manifest must be reported");
    assert.notEqual(rule.status, "fail", `${rule.summary}: ${(rule.details ?? []).join("; ")}`);
  });

  // Case 1b: the board step. A stub adapter records the name it is asked to
  // create, because Plane itself rejects "pjtest-board" with HTTP 400 ("Project
  // name cannot contain special characters") after the repo and registry
  // record already exist.
  const adapters = join(good.base, "adapters");
  const asked = join(good.base, "asked-board-names.txt");
  mkdirSync(adapters, { recursive: true });
  writeFileSync(join(adapters, "plane.sh"), `#!/bin/sh
set -eu
[ "\${1:-}" = create_board ] || { echo "unexpected op: \${1:-}" >&2; exit 2; }
printf '%s\\n' "\$2" >> ${JSON.stringify(asked)}
case "\$2" in *[!A-Za-z0-9_[:space:]]*) echo "plane: POST projects/ failed (HTTP 400): Project name cannot contain special characters." >&2; exit 1;; esac
printf '{"board_id":"11111111-2222-3333-4444-555555555555","identifier":"STUB","board_url":"https://plane.invalid/b"}\\n'
`, { mode: 0o755 });
  const boardEnv = { PJ_TICKET_PROVIDER_ADAPTERS: adapters, PLANE_API_KEY: "stub-plane-key-never-logged" };

  check("a hyphenated project name reaches Plane as a name Plane accepts, and the board links", () => {
    const created = init(good, "pjtest-hyphen-board", ["--json"], boardEnv);
    assert.equal(created.result.status, 0, `init must succeed:\n${created.text}`);
    const report = JSON.parse(created.result.stdout);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.board.confirmed, true);
    assert.equal(report.board.reached, true);
    assert.deepEqual(readFileSync(asked, "utf8").trim().split("\n"), ["pjtest hyphen board"]);
    // Only the provider's copy of the name is cleaned.
    const manifest = JSON.parse(readFileSync(join(created.target, ".project.json"), "utf8"));
    assert.equal(manifest.project_name, "pjtest-hyphen-board");
  });

  // Case 2: the same machine without the checkout. skillex is right to refuse;
  // the failure is the thing under test.
  const missing = machine(scratch, "unlinked", { withCheckout: false });

  check("a failing skills check prints its findings, not just their count", () => {
    const failed = init(missing, "unlinkedproj", ["--skip-board"]);
    assert.notEqual(failed.result.status, 0, `init must fail when a selected link skill has no checkout:\n${failed.text}`);
    assert.match(failed.text, /skills\.project-manifest/, "the failing check must be named");
    assert.match(failed.text, new RegExp(LINK_SKILL), "the finding must name the skill that cannot be resolved");
    assert.match(failed.text, /E_SKILL_MISSING/, "the finding must carry skillex's own reason code");
    // The count line must be followed by the findings it counts, not stand alone.
    assert.match(failed.text, /skills\.project-manifest: \d+ Skillex finding\(s\)\n\s+- /, "a bare count is not an error message");
  });

  check("the JSON error list carries the same findings", () => {
    const failed = init(missing, "unlinkedjson", ["--skip-board", "--json"]);
    assert.notEqual(failed.result.status, 0);
    const report = JSON.parse(failed.result.stdout);
    assert.equal(report.ok, false);
    const skills = report.errors.find((error) => error.startsWith("skills.project-manifest"));
    assert.ok(skills, `errors must name the failing check: ${JSON.stringify(report.errors)}`);
    assert.match(skills, new RegExp(LINK_SKILL));
  });

  check("a fresh target that fails the transaction is rolled back", () => {
    assert.ok(!existsSync(join(missing.base, "unlinkedproj")), "the failed create must leave no target behind");
  });

  check("a transaction that died before the board step does not blame the provider credential", () => {
    // No --skip-board: the board WOULD be attempted if the transaction got that far.
    const failed = init(missing, "unlinkedboard", []);
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.text, /Board step not reached/, "must say the board step was never reached");
    assert.doesNotMatch(failed.text, /provider credential resolves/, "the credential is not the cause");
    assert.doesNotMatch(failed.text, /the plane board was not confirmed/, "no adapter was called, so nothing was 'not confirmed'");
    assert.match(failed.text, new RegExp(LINK_SKILL), "and the real failure is still printed above it");
  });

  check("the JSON board block says the step was not reached", () => {
    const failed = init(missing, "unlinkedboardjson", ["--json"]);
    assert.notEqual(failed.result.status, 0);
    const report = JSON.parse(failed.result.stdout);
    assert.equal(report.board.reached, false);
    assert.equal(report.board.confirmed, false);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log(`pjan-209: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-209: init bootstrap regressions passed");
