import "./helpers/hermetic-suite.mjs";
// PJAN-211: `pj init --apply` validates before it writes, and a rule that only
// warns can no longer stop registration.
//
// Found adopting shortwave on 2026-11-12:
//   1. A hand-written .project.json listed source_artifacts as bare path strings.
//      The registry accepts only {kind, path} objects, and init learned that from
//      the registry's refusal at the very END of the transaction, after the Plane
//      board had been created and every parity rule had written to the repo.
//   2. The second `pj init --apply` on that (now adopted) repo exited 1 and left
//      the project unregistered: `bmad.version` ("update withheld", an audit
//      WARN) came back blocked/partial from migrate, and a blocked/partial result
//      failed the whole transaction, so the registry finalizer never ran.
//   3. `skills.project-manifest` summarised "14 Skillex finding(s)" for one
//      drifted activation: thirteen of the lines were the plan that fixes it.
//
// Every check below fails on the code before the fix (see the PJAN-211 ticket).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");

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

const scratch = hermeticScratch("pjan-211-");
let nextMachine = 0;

/** One hermetic machine, with a stub Plane adapter that records every call it gets. */
function machine() {
  const base = join(scratch, `m${nextMachine += 1}`);
  const home = join(base, "home");
  const catalog = join(base, "catalog");
  const adapters = join(base, "adapters");
  const calls = join(base, "adapter-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(adapters, { recursive: true });
  createSkillPackFixture(catalog);
  writeFileSync(join(adapters, "plane.sh"), `#!/bin/sh
set -eu
printf '%s %s\\n' "\${1:-}" "\${2:-}" >> ${JSON.stringify(calls)}
[ "\${1:-}" = create_board ] || { echo "unexpected op: \${1:-}" >&2; exit 2; }
printf '{"board_id":"11111111-2222-3333-4444-555555555555","identifier":"STUB","board_url":"https://plane.invalid/b"}\\n'
`, { mode: 0o755 });
  const fixture = {
    HOME: home,
    PATH: `${createSkillexMiseFixture(base)}:${process.env.PATH}`,
    PJ_SKILLS_REGISTRY_ROOT: catalog,
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(catalog),
    PJ_TICKET_PROVIDER_ADAPTERS: adapters,
    PLANE_API_KEY: "stub-plane-key-never-logged",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    GIT_CEILING_DIRECTORIES: base,
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    NO_COLOR: "1",
  };
  return { base, fixture, registry: join(base, "registry.yaml"), calls };
}

/** An existing git repo to adopt, optionally carrying a hand-written manifest. */
function repo(m, name, manifest) {
  const target = join(m.base, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "README.md"), `# ${name}\n`);
  if (manifest !== undefined) writeFileSync(join(target, ".project.json"), typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: target, encoding: "utf8", env: hermeticEnv(m.fixture) });
  assert.equal(git.status, 0, git.stderr);
  return target;
}

function pj(m, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: m.base, encoding: "utf8", env: hermeticEnv(m.fixture), timeout: 600_000 });
  return { result, text: `${result.stdout}${result.stderr}` };
}

const init = (m, name, target, extra = []) =>
  pj(m, ["init", name, "--target-dir", target, "--registry", m.registry, ...extra]);
const apply = (m, name, target, extra = []) => init(m, name, target, ["--apply", "-y", "--no-tui", ...extra]);

/** Everything in the working tree (never .git), as path -> content digest, so "untouched" is a byte comparison. */
function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      const key = relative(dir, full);
      if (entry.isSymbolicLink()) out[key] = `link:${readlinkSync(full)}`;
      else if (entry.isDirectory()) { out[key] = "dir"; walk(full); }
      else out[key] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const manifestOf = (target) => JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
const adapterCalls = (m) => (existsSync(m.calls) ? readFileSync(m.calls, "utf8").trim().split("\n").filter(Boolean) : []);
const PATH_ARTIFACT = "/tmp/pjtest-211/transcripts/spec.md";

console.log("pjan-211 init preflight");
try {
  // -------------------------------------------------------------------------
  // 1. Validate before any live write.
  // -------------------------------------------------------------------------
  const wrongShape = (artifacts) => ({
    project_name: "Badshape",
    project_id: "badshape",
    status: "active",
    source_artifacts: artifacts,
  });

  check("a manifest the registry would refuse is refused before the board, the registry or the repo is touched", () => {
    const m = machine();
    const target = repo(m, "badshape", wrongShape([{ kind: 7, path: PATH_ARTIFACT }]));
    const before = tree(target);
    const refused = apply(m, "Badshape", target);
    assert.notEqual(refused.result.status, 0, `init must refuse:\n${refused.text}`);
    assert.match(refused.text, /source_artifacts\.0\.kind must be a string/, "the precise field error must be printed");
    assert.ok(refused.text.includes(join(target, ".project.json")), "the error names the manifest file");
    assert.deepEqual(adapterCalls(m), [], "no ticket board may be created");
    assert.equal(existsSync(m.registry), false, "the registry must not be written");
    assert.deepEqual(tree(target), before, "the repo must be byte-identical");
  });

  check("the dry run refuses the same manifest, so a plan never promises what apply cannot do", () => {
    const m = machine();
    const target = repo(m, "badshape", wrongShape([{ kind: 7, path: PATH_ARTIFACT }]));
    const dry = init(m, "Badshape", target);
    assert.notEqual(dry.result.status, 0, dry.text);
    assert.match(dry.text, /source_artifacts\.0\.kind must be a string/);
  });

  check("a wrong shape that is not an old, unambiguous one is never guessed at", () => {
    const m = machine();
    const target = repo(m, "badshape", wrongShape(["not-a-path"]));
    const before = tree(target);
    const refused = apply(m, "Badshape", target);
    assert.notEqual(refused.result.status, 0, refused.text);
    assert.match(refused.text, /source_artifacts\.0 must be an object/);
    assert.deepEqual(adapterCalls(m), []);
    assert.deepEqual(tree(target), before);
  });

  check("malformed JSON names the file instead of a bare parser error", () => {
    const m = machine();
    const target = repo(m, "badjson", "{ \"project_name\": ");
    const refused = apply(m, "Badjson", target);
    assert.notEqual(refused.result.status, 0, refused.text);
    assert.match(refused.text, /Malformed JSON: .*\.project\.json/);
    assert.doesNotMatch(refused.text, /Unexpected (token|end)/);
    assert.deepEqual(adapterCalls(m), []);
  });

  // -------------------------------------------------------------------------
  // 1b. The one old shape that is unambiguous is normalized, and says so.
  // -------------------------------------------------------------------------
  const legacy = machine();
  const legacyTarget = repo(legacy, "oldshape", wrongShape([PATH_ARTIFACT]));
  legacy.target = legacyTarget;

  check("a bare path in source_artifacts is normalized to {kind, path}, and the plan says so", () => {
    const dry = init(legacy, "Badshape", legacyTarget);
    assert.equal(dry.result.status, 0, `the dry run must plan the adoption:\n${dry.text}`);
    assert.match(dry.text, /source_artifacts\.0: bare path normalized to \{"kind": "reference"/);
    assert.equal(JSON.stringify(manifestOf(legacyTarget).source_artifacts), JSON.stringify([PATH_ARTIFACT]), "a dry run writes nothing");
  });

  check("applying writes the object form, which is what the registry accepts, and links the board once", () => {
    const applied = apply(legacy, "Badshape", legacyTarget, ["--json"]);
    assert.equal(applied.result.status, 0, `adoption must succeed:\n${applied.text}`);
    const artifacts = manifestOf(legacyTarget).source_artifacts;
    assert.deepEqual(artifacts, [{ kind: "reference", path: PATH_ARTIFACT }]);
    assert.equal(adapterCalls(legacy).length, 1, "the board is created exactly once");
  });

  // -------------------------------------------------------------------------
  // 2. A warn-level rule must not stop registration.
  // -------------------------------------------------------------------------
  check("a second apply on an adopted repo converges: exit 0, no changes, nothing re-created", () => {
    const before = tree(legacyTarget);
    const calls = adapterCalls(legacy).length;
    const again = apply(legacy, "Badshape", legacyTarget, ["--json"]);
    assert.equal(again.result.status, 0, `a re-apply must exit 0:\n${again.text}`);
    const report = JSON.parse(again.result.stdout);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(tree(legacyTarget), before, "a re-apply must not change a file");
    assert.equal(adapterCalls(legacy).length, calls, "a re-apply must not call the board adapter again");
  });

  check("the rule that could not finish is reported as a warning, not an error", () => {
    const again = apply(legacy, "Badshape", legacyTarget, ["--json"]);
    const report = JSON.parse(again.result.stdout);
    const unfinished = report.migrationReport.results.filter((entry) => entry.status === "blocked" || entry.status === "partial");
    assert.ok(unfinished.length > 0, `the fixture must leave a rule unfinished to prove anything:\n${JSON.stringify(report.migrationReport.results.map((r) => [r.id, r.status]))}`);
    for (const entry of unfinished) assert.equal(entry.advisory, true, `${entry.id} must be flagged advisory`);
    assert.ok(report.warnings.some((line) => line.startsWith("bmad.version:")), `warnings: ${JSON.stringify(report.warnings)}`);
    assert.equal(report.migrationReport.ok, true);
    assert.deepEqual(report.phases.filter((phase) => phase.status === "failed"), [], "no phase may be failed");
  });

  check("the text report says 'warning', not 'blocked' or 'still failing'", () => {
    const again = apply(legacy, "Badshape", legacyTarget);
    assert.equal(again.result.status, 0, again.text);
    assert.match(again.text, /Migration complete\s+·\s+1 warning/);
    assert.match(again.text, /bmad\.version/);
    assert.doesNotMatch(again.text, /Migration finished with blockers|Migration incomplete|still failing/);
  });

  check("a re-apply registers a project the registry lost, even with a rule that only warns", () => {
    const removed = pj(legacy, ["remove", "badshape", "--apply", "--registry", legacy.registry]);
    assert.equal(removed.result.status, 0, removed.text);
    const gone = pj(legacy, ["list", "--registry", legacy.registry, "--json"]);
    assert.equal(JSON.parse(gone.result.stdout).projects.badshape, undefined, "the fixture must start unregistered");
    const again = apply(legacy, "Badshape", legacyTarget);
    assert.equal(again.result.status, 0, `a re-apply must exit 0:\n${again.text}`);
    const back = pj(legacy, ["list", "--registry", legacy.registry, "--json"]);
    assert.ok(JSON.parse(back.result.stdout).projects.badshape, "the registry finalizer must have run");
  });

  check("a rule that really fails still blocks init (the fix is not 'ignore everything')", () => {
    const m = machine();
    const target = repo(m, "hardfail");
    const first = apply(m, "Hardfail", target, ["--skip-board"]);
    assert.equal(first.result.status, 0, first.text);
    // A retired skill writer that is a DIRECTORY is someone's content: no rule may touch it,
    // and skills.project-manifest fails for it. That is an operator decision, not a warning.
    mkdirSync(join(target, ".mise", "scripts", "link-project-skills-to-clis.sh"), { recursive: true });
    const blocked = apply(m, "Hardfail", target, ["--skip-board"]);
    assert.notEqual(blocked.result.status, 0, `a real failure must exit nonzero:\n${blocked.text}`);
    assert.match(blocked.text, /skills\.project-manifest/);
  });

  // -------------------------------------------------------------------------
  // 3. The skills summary counts problems, not lines.
  // -------------------------------------------------------------------------
  check("skills.project-manifest counts its findings and names the plan separately", () => {
    const m = machine();
    // The operator selects three catalog skills globally; this repo inherits them but has no
    // links yet, so skillex reports ONE drifted activation and a plan of one operation per link.
    mkdirSync(join(m.fixture.HOME, ".agents"), { recursive: true });
    writeFileSync(join(m.fixture.HOME, ".agents", "skills.json"), `${JSON.stringify({ scope: "global", skills: ["pjtest-help", "pjtest-agent-pm", "pjtest-code-review"] })}\n`);
    const target = repo(m, "skillsum");
    mkdirSync(join(target, ".agents"), { recursive: true });
    writeFileSync(join(target, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: true })}\n`);
    const audited = pj(m, ["audit", target, "--registry", m.registry, "--rules", "skills.project-manifest", "--json"]);
    const rule = JSON.parse(audited.result.stdout).rules.find((entry) => entry.id === "skills.project-manifest");
    assert.ok(rule, audited.text);
    const planLines = rule.details.filter((line) => /^(create|remove|write|update)-[a-z-]+: /.test(line)).length;
    assert.ok(planLines >= 2, `the fixture must produce plan lines (${planLines}):\n${rule.details.join("\n")}`);
    assert.notEqual(rule.summary, `${rule.details.length} Skillex finding(s)`, "the summary must not count every detail line");
    assert.match(rule.summary, /pending/, `plan lines are named as such: ${rule.summary}`);
    const counted = Number((rule.summary.match(/^(\d+) Skillex finding/) ?? [])[1] ?? 0);
    assert.ok(counted < rule.details.length - planLines + 1, `findings (${counted}) never include the ${planLines} plan lines`);
    const pending = Number((rule.summary.match(/(\d+) pending/) ?? [])[1]);
    assert.equal(pending, planLines, `the pending count is the plan: ${rule.summary}`);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log(`pjan-211: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-211: init preflight regressions passed");
