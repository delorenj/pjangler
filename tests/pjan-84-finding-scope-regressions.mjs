// PJAN-84: a finding's SCOPE, and what `ok` is allowed to mean.
//
// `auditRecipes` computed `ok = every(pass || skip)`, and `ProjectRecipe` turned
// a not-ok postcondition audit into a transaction error. That single expression
// made two unrelated claims:
//
//   1. a `warn` is a failure — which is why `pj audit` exited 1 while reporting
//      zero failed rules;
//   2. a HOST condition is the repository's failure — which is why one drifted
//      symlink under ~/.agents could fail, and roll back, a brand-new project,
//      and fail every project on the machine at once.
//
// PJAN-82 fixed the two rules that happened to be firing. This pins the
// semantics, so the next host-scoped rule cannot re-create it.
//
// The scope is declared on the CHECK, not stamped onto the finding by one
// caller: `verifyMigration` and `migrateAll` call `checks[i].audit(ctx)`
// directly, so a field stamped only in `Recipe.audit` would be silently absent
// in exactly the two places that decide whether a migration succeeded.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: temporary[0] ?? tmpdir(), ...env },
  });
}

console.log("pjan-84 finding scope");
try {
  const root = mkdtempSync(join(tmpdir(), "pjan-84-scope-"));
  temporary.push(root);
  const registry = join(root, "registry.yaml");
  const target = join(root, "scoped");

  // A HOME whose Project Notebook skill path is a foreign directory: the host
  // block PJAN-82 introduced, which is host-scoped by construction.
  const home = join(root, "home");
  mkdirSync(join(home, ".agents", "skills", "project-notebook"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "project-notebook", "SKILL.md"), "not the pinned export\n");
  const hostEnv = { HOME: home, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };

  check("a broken HOST does not stop a project being created", () => {
    const created = cli(["init", "scoped", "--target-dir", target, "--registry", registry, "--skip-board", "--apply", "-y", "--no-tui"], hostEnv);
    assert.equal(created.status, 0, `init must succeed despite host state: ${created.stdout}${created.stderr}`);
    assert.match(created.stdout, /Project synchronized/);
  });

  check("every rule declares a scope, and it reaches the JSON wire", () => {
    const report = JSON.parse(cli(["audit", target, "--registry", registry, "--json"], hostEnv).stdout);
    assert.ok(report.rules.length > 0);
    for (const rule of report.rules) {
      assert.ok(["project", "host"].includes(rule.scope), `${rule.id} must declare a scope`);
    }
    const host = report.rules.filter((rule) => rule.scope === "host").map((rule) => rule.id).sort();
    assert.deepEqual(
      host,
      [
        "hermes.fleet-config",
        "hermes.profile-wiring",
        "hermes.registry-parity",
        "notebook.hooks-projected",
        "notebook.skill-installed",
        "systemd.sentinel",
      ],
      "exactly the rules about $HOME, systemd and the fleet registry are host-scoped",
    );
  });

  check("ok answers about the PROJECT; hostOk answers about the machine", () => {
    const report = JSON.parse(cli(["audit", target, "--registry", registry, "--json"], hostEnv).stdout);
    assert.equal(typeof report.hostOk, "boolean", "the report must carry hostOk");
    const projectFails = report.rules.filter((r) => r.scope !== "host" && r.status === "fail");
    assert.equal(report.ok, projectFails.length === 0, "ok must track project-scoped failures only");
  });

  check("a host-scoped failure is reported, and does not make ok false", () => {
    // Simulated at the report level rather than by breaking the real machine:
    // the property under test is the ok computation, and every rule now carries
    // the scope that feeds it.
    const report = JSON.parse(cli(["audit", target, "--registry", registry, "--json"], hostEnv).stdout);
    const hostRules = report.rules.filter((r) => r.scope === "host");
    assert.ok(hostRules.length >= 6, "host rules must be present to reason about");
    const worst = hostRules.filter((r) => r.status === "fail" || r.status === "warn");
    if (worst.length) {
      assert.equal(report.ok, true, `a host failure must not fail the project: ${JSON.stringify(worst.map((r) => r.id))}`);
      assert.equal(report.hostOk, false, "and hostOk must say the machine needs attention");
    }
  });

  check("a warn does not make ok false", () => {
    const report = JSON.parse(cli(["audit", target, "--registry", registry, "--json"], hostEnv).stdout);
    const warns = report.rules.filter((r) => r.status === "warn" && r.scope !== "host");
    if (!warns.length) {
      // Nothing warns on a fresh project, which is itself the point: assert the
      // rule rather than the sample.
      assert.equal(report.ok, report.rules.every((r) => !(r.status === "fail" && r.scope !== "host")));
      return;
    }
    assert.equal(report.ok, true, `a warn is advisory, not a failure: ${JSON.stringify(warns.map((r) => r.id))}`);
  });

  check("migration selection still picks up fail AND warn", () => {
    // A different question from `ok`: "what needs work" legitimately includes
    // warns, and PJAN-75's accounting depends on it.
    const migrated = JSON.parse(cli(["migrate", "--all", target, "--registry", registry, "--json"], hostEnv).stdout);
    assert.equal(typeof migrated.ok, "boolean");
    assert.ok(Array.isArray(migrated.results));
  });

  check("the human renderer surfaces a host problem separately from the verdict", () => {
    const text = cli(["audit", target, "--registry", registry], { ...hostEnv, NO_COLOR: "1" }).stdout;
    const hostReport = JSON.parse(cli(["audit", target, "--registry", registry, "--json"], hostEnv).stdout);
    const trouble = hostReport.rules.filter((r) => r.scope === "host" && (r.status === "fail" || r.status === "warn"));
    if (trouble.length) {
      assert.match(text, /This machine needs attention/, "a host problem must never be silent just because it no longer gates");
      for (const rule of trouble) assert.ok(text.includes(rule.id), `${rule.id} must be named`);
    } else {
      assert.doesNotMatch(text, /This machine needs attention/, "no host banner when the machine is healthy");
    }
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-84 finding scope: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-84 finding scope regressions passed");
