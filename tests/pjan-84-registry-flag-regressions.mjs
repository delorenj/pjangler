// PJAN-84: audit, migrate and describe agree about which registry they read —
// and migrate's postcondition is read once, after the whole run.
//
// Two independent defects, both making the tools untrustworthy rather than wrong:
//
// 1. `audit` and `migrate` took no --registry at all, and `describe --registry`
//    passed the override to its identity and notebook blocks and then built the
//    PARITY context without it. One report therefore answered about two
//    different registries: identity said "registered", the notebook rules said
//    the project was unknown.
//
// 2. `verifyMigration` ran inside the per-rule loop, so rule N's postcondition
//    was read before rules N+1..M had run. A rule a LATER rule repaired was
//    still reported `partial`, and `partial` counts against `ok` — so
//    `migrate --all` exited 1 describing a repo that was in parity by the time
//    the run ended.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const temporary = [];
let failures = 0;

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
  }
}

function cli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: temporary[0] ?? tmpdir(), ...env },
  });
}

function json(result) {
  return JSON.parse(result.stdout);
}

/** A registered project plus its registry, both under a scratch root. */
function project(name) {
  const root = mkdtempSync(join(tmpdir(), "pjan-84-registry-"));
  temporary.push(root);
  const registry = join(root, "registry.yaml");
  const target = join(root, name);
  // --skip-board: this fixture is about registry flags, not board provisioning,
  // which is on by default and would otherwise fail the ingress gate here.
  const created = cli(["init", name, "--target-dir", target, "--registry", registry, "--skip-board", "--apply", "-y", "--no-tui"]);
  assert.equal(created.status, 0, `init must succeed: ${created.stdout}${created.stderr}`);
  assert.equal(existsSync(registry), true, "init must write the scratch registry");
  return { root, registry, target };
}

console.log("pjan-84 registry flag + migrate postcondition ordering");
try {
  const it = project("registry-agreement");

  check("audit accepts --registry", () => {
    assert.match(cli(["audit", "--help"]).stdout, /--registry <path>/);
  });

  check("migrate accepts --registry", () => {
    assert.match(cli(["migrate", "--help"]).stdout, /--registry <path>/);
  });

  check("describe --registry reaches the PARITY run, not just the identity block", () => {
    // The tell: with the override the project is registered AND its notebook
    // rules resolve against that registry, so notebook.configuration/binding
    // pass. Without it the same repo is unknown to the default registry.
    const withFlag = json(cli(["describe", it.target, "--registry", it.registry, "--json"]));
    assert.equal(withFlag.identity.registered, true, "the override registry knows this project");
    const notebookRules = withFlag.subsystems.flatMap((s) => s.rules).filter((r) => r.id.startsWith("notebook."));
    assert.ok(notebookRules.length >= 2, "notebook rules must be present in the report");
    const failed = notebookRules.filter((r) => r.status === "fail");
    assert.deepEqual(
      failed.map((r) => r.id),
      [],
      `notebook rules must resolve against the SAME registry as identity: ${JSON.stringify(failed)}`,
    );

    const withoutFlag = json(cli(["describe", it.target, "--json"]));
    assert.equal(
      withoutFlag.identity.registered,
      false,
      "without the flag the default registry has never heard of this project — which is exactly why the parity run had to receive it",
    );
  });

  check("audit --registry is honoured, and the env var is equivalent", () => {
    const flagged = json(cli(["audit", it.target, "--registry", it.registry, "--json"]));
    assert.equal(flagged.ok, true, `a freshly created project audits clean: ${JSON.stringify(flagged.rules.filter((r) => r.status === "fail"))}`);
    const enved = json(cli(["audit", it.target, "--json"], { env: { PJ_PROJECT_REGISTRY: it.registry } }));
    assert.deepEqual(
      enved.rules.map((r) => `${r.id}:${r.status}`),
      flagged.rules.map((r) => `${r.id}:${r.status}`),
      "PJ_PROJECT_REGISTRY and --registry must produce identical findings",
    );
  });

  check("migrate --registry is honoured", () => {
    const migrated = json(cli(["migrate", "--all", it.target, "--registry", it.registry, "--json"]));
    assert.equal(migrated.repo, it.target);
    const partial = migrated.results.filter((r) => r.status === "partial" || r.status === "blocked");
    assert.deepEqual(
      partial.map((r) => `${r.id}: ${r.summary}`),
      [],
      "a freshly created project has nothing left to migrate",
    );
  });

  check("a rule a LATER rule repaired is not reported partial", () => {
    // Two rules over one file, run in registry order. The first cannot finish
    // its own job; the second completes it. Before the fix, rule one's
    // postcondition was read before rule two ran, so it came back `partial` and
    // `migrate --all` exited 1 on a repo that ended in parity.
    //
    // Exercised against the real registry rather than a mock: bmad.cli-roots
    // reported "supported projection issue(s)" that bmad.scaffold's reinstall
    // had already resolved, which is the case observed on pjangler itself.
    const audited = json(cli(["audit", it.target, "--registry", it.registry, "--json"]));
    assert.equal(audited.ok, true, "precondition: the project is in parity");
    const again = json(cli(["migrate", "--all", it.target, "--registry", it.registry, "--json"]));
    assert.equal(
      again.ok,
      true,
      `migrate --all must exit ok on a repo that is in parity: ${JSON.stringify(again.results.filter((r) => r.status !== "noop"))}`,
    );
  });

  check("an unknown registry path is reported, not silently ignored", () => {
    const missing = join(it.root, "no-such-registry.yaml");
    const result = cli(["describe", it.target, "--registry", missing, "--json"]);
    assert.equal(result.status, 0, "an absent registry is a legitimate state, not a crash");
    assert.equal(
      json(result).identity.registered,
      false,
      "an absent registry must report the project as unregistered rather than falling back to the default",
    );
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-84 registry flag: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-84 registry flag regressions passed");
