// PJAN-75 — `migrate` must not report success it has not achieved.
//
// The reported failure was a single terminal session: `pjangler migrate`
// printed "✔ Migration complete" with every rule marked `[applied]`, and the
// very next `pjangler audit` in the same directory failed on those same rules.
// Two independent defects produced it, and one missing guarantee let both ship:
//
//   1. `skills.project-manifest` deferred its legacy-skill mapping behind
//      `--accept-registry-matches`, said so in a detail line, and still
//      returned `applied` because OTHER files had changed.
//   2. `sot.project-json` deleted a declared agent whose role_dir had no
//      role.yaml — the exact state `hermes.registry-parity` calls a blocker
//      with the message "provision or restore the role, do not delete its
//      registry/declaration". The prune fixed nothing (the fleet registry
//      entry outlives .project.json) and destroyed the only repo-local record
//      of the agent's identity.
//   3. Nothing ever re-checked a migrated rule, so any rule could claim
//      whatever it liked about itself.
//
// The tests below are written against the invariant rather than the two
// symptoms: after a non-dry-run migrate, a rule reported as a success must
// pass its own audit, and `migrate`'s verdict must agree with `audit`'s.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillPackFixture } from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-75-"));
// Pack resolution has to be hermetic or `skills.project-manifest` reports
// "pack not trusted" and goes `fixable: false`, which would quietly retire the
// very check that reproduces the ticket.
const bmadPack = createSkillPackFixture(join(workspace, "packfix"));

// TMPDIR can itself sit inside a git work tree on this machine, so nothing here
// may be allowed to walk up into an enclosing repository.
process.env.GIT_CEILING_DIRECTORIES = workspace;

// Bundle the CLI from src/ so this suite tests the source, not a stale dist/.
// The bundle lands INSIDE the repo: `--packages=external` mirrors the shipped
// build, which means node resolves commander & co. by walking up from the
// bundle's own location, and `resolvePjanglerRoot()` finds the real templates/
// the same way.
//
// PJAN75_CLI_SRC points the bundle at a different src/index.ts. It exists so
// these assertions can be proven against the PRE-fix tree — a regression test
// that has never been watched to fail is only evidence that it compiles:
//
//   git archive main src | tar -x -C /tmp/pre-fix
//   PJAN75_CLI_SRC=/tmp/pre-fix/src/index.ts node tests/pjan-75-regressions.mjs
//
const cli = join(root, ".pjan-75-cli.mjs");
const entry = process.env.PJAN75_CLI_SRC || join(root, "src", "index.ts");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [entry, "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${cli}`],
  { encoding: "utf8" },
);
if (built.status !== 0) {
  console.error(`failed to bundle the CLI:\n${built.stderr}`);
  process.exit(1);
}

function cleanup() {
  rmSync(cli, { force: true });
  rmSync(workspace, { recursive: true, force: true });
}
process.on("exit", cleanup);

/**
 * A repo in the state HeyMa was in when the bug was reported: `.project.json`
 * declares a PM agent, the fleet registry still carries its entry, the role
 * directory exists with its launcher and scripts — and `role.yaml`, the
 * identity SSOT, is absent. That is a half-provisioned role, not junk.
 */
function unprovisionedRoleRepo(name) {
  const repo = join(workspace, name);
  const home = join(repo, "home");
  mkdirSync(join(repo, "repo", "agents", "hermes", "pm", ".scripts"), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  // Seed the BMAD dist-tag cache so `--all` never reaches for the network.
  mkdirSync(join(home, ".cache", "pjangler"), { recursive: true });
  writeFileSync(
    join(home, ".cache", "pjangler", "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.0.0", next: "6.0.0" } }),
    "utf8",
  );

  const repoRoot = join(repo, "repo");
  writeFileSync(
    join(repoRoot, ".project.json"),
    `${JSON.stringify(
      {
        project_name: "Heyma",
        project_description: "",
        project_slug: "heyma",
        repo_path: repoRoot,
        ticket_provider: { type: "plane", workspace: "33god", identifier: "heyma", board_id: "b", state: "linked" },
        agents: { "heyma-pm": { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "provisioned" } },
        automation: { reconcile: { enabled: false, grace_hours: 0, auto_review: true } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(home, ".hermes", "agents-registry.yaml"),
    [
      "agents:",
      "  heyma-pm:",
      "    role: pm",
      `    role_dir: ${join(repoRoot, "agents", "hermes", "pm")}`,
      `    project_path: ${repoRoot}`,
      "    profile_name: heyma-pm",
      "    bloodbank:",
      "      enabled: false",
      "      gateway_scope: fleet",
      "      target_agent_id: heyma-pm",
      "    systemd:",
      "      gateway_unit: hermes-heyma-pm-gateway.service",
      "",
    ].join("\n"),
    "utf8",
  );
  return { repoRoot, home };
}

/**
 * A repo carrying a real committed skill that no manifest entry claims -- the
 * state `migrate skills.project-manifest` refuses to resolve without an
 * explicit `--accept-registry-matches`, because mapping it moves the directory.
 */
function deferredSkillRepo(name) {
  const repoRoot = join(workspace, name, "repo");
  const home = join(workspace, name, "home");
  mkdirSync(join(repoRoot, ".agents", "skills", "my-committed-skill"), { recursive: true });
  mkdirSync(join(home, ".cache", "pjangler"), { recursive: true });
  writeFileSync(join(repoRoot, ".agents", "skills", "my-committed-skill", "SKILL.md"), "---\nname: my-committed-skill\n---\n", "utf8");
  writeFileSync(
    join(repoRoot, ".agents", "skills.json"),
    `${JSON.stringify({ inherit_global: true, registry: "https://github.com/delorenj/skillex.git", skills: [] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(home, ".cache", "pjangler", "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.0.0", next: "6.0.0" } }),
    "utf8",
  );
  return { repoRoot, home };
}

function runCli(args, { home, expectOk }) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      GIT_CEILING_DIRECTORIES: workspace,
      NO_COLOR: "1",
      PJ_PACK_ROOT_PJTEST: bmadPack,
    },
  });
  if (expectOk !== undefined) {
    assert.equal(
      result.status === 0,
      expectOk,
      `expected exit ${expectOk ? 0 : "non-zero"} from \`${args.join(" ")}\`\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function json(args, options) {
  const result = runCli([...args, "--json"], options);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`expected JSON from \`${args.join(" ")}\`\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${err}`);
  }
}

const findings = (report, id) => report.rules.find((rule) => rule.id === id);
const outcome = (report, id) => report.results.find((result) => result.id === id);

// Every check runs even after one fails. Watching this suite fail against the
// pre-fix tree is the only evidence it discriminates, and a first-failure abort
// hides which of the remaining checks are load-bearing and which merely
// compile.
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The reported failure, reduced: `migrate` said applied, `audit` said fail.
//
// `skills.project-manifest` defers its legacy-skill mapping behind
// `--accept-registry-matches` and says so in a detail line -- then returned
// `applied` anyway, because it HAD changed other files. This is the exact pair
// of commands from the ticket, run back to back on one repo.
// ---------------------------------------------------------------------------
check("migrate cannot claim a rule succeeded while its audit still fails", () => {
  const { repoRoot, home } = deferredSkillRepo("deferral");

  const before = json(["audit", repoRoot], { home });
  const rule = findings(before, "skills.project-manifest");
  assert.equal(rule.status, "fail", "expected the unmanaged committed skill to fail the audit");
  assert.equal(
    rule.fixable,
    true,
    `the scenario is only meaningful while the rule is fixable; got ${JSON.stringify(rule.details)}`,
  );

  const migration = json(["migrate", "skills.project-manifest", repoRoot], { home });
  const after = json(["audit", repoRoot], { home });
  const result = outcome(migration, "skills.project-manifest");

  assert.equal(
    findings(after, "skills.project-manifest").status,
    "fail",
    "precondition: the deferred mapping must still be outstanding",
  );
  assert.notEqual(result.status, "applied", 'migrate reported "applied" for a rule that still fails its audit');
  assert.equal(result.status, "partial");
  assert.equal(migration.ok, false, "`migrate` must not exit 0 while `audit` on the same repo exits 1");
  assert.equal(migration.ok, after.ok, "migrate and audit must not disagree about parity");
  assert.ok(
    result.details.some((detail) => detail.includes("--accept-registry-matches")),
    "the operator must be told how to finish the migration",
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2. migrate must not delete an unprovisioned agent's declaration.
//
// The declaration is the last repo-local record of the agent's identity once
// role.yaml is gone, and deleting it did not even silence the audit — the
// fleet registry entry that also reports the blocker is outside the repo.
// ---------------------------------------------------------------------------
check("an unprovisioned agent's declaration survives migrate", () => {
  const { repoRoot, home } = unprovisionedRoleRepo("preserve");
  const before = JSON.parse(readFileSync(join(repoRoot, ".project.json"), "utf8"));
  runCli(["migrate", "--all", repoRoot], { home, expectOk: false });
  const after = JSON.parse(readFileSync(join(repoRoot, ".project.json"), "utf8"));

  assert.deepEqual(
    after.agents,
    before.agents,
    "migrate deleted the declaration of an agent whose role.yaml is missing",
  );
  assert.equal(after.agents["heyma-pm"].provisioning_state, "provisioned", "declaration extras were dropped");
});

// ---------------------------------------------------------------------------
// 3. sot.project-json and hermes.registry-parity must agree.
//
// They used to reach opposite conclusions about the same declaration: one
// called it a non-fixable blocker to preserve, the other called it invalid and
// pruned it. Both now read the same predicate.
// ---------------------------------------------------------------------------
check("sot.project-json and hermes.registry-parity agree", () => {
  const { repoRoot, home } = unprovisionedRoleRepo("agreement");
  const audit = json(["audit", repoRoot], { home });
  const projectJson = findings(audit, "sot.project-json");
  const registryParity = findings(audit, "hermes.registry-parity");

  assert.equal(projectJson.status, "fail", "sot.project-json must report the unprovisioned role");
  assert.equal(registryParity.status, "fail", "hermes.registry-parity must report the unprovisioned role");
  assert.equal(
    projectJson.fixable,
    false,
    "sot.project-json must not advertise a fix for a role only an operator can provision",
  );
  assert.equal(registryParity.fixable, false);
  assert.ok(
    projectJson.details.some((detail) => detail.includes("do not delete its declaration")),
    `sot.project-json must tell the operator to restore the role, got: ${JSON.stringify(projectJson.details)}`,
  );
});

// ---------------------------------------------------------------------------
// 4. `migrate --all` accounts for the rules it is not allowed to fix.
//
// Excluding non-fixable failures from the report entirely is how a repo whose
// only problem was operator-owned got "Migration complete" and exit 0.
// ---------------------------------------------------------------------------
check("migrate --all accounts for rules it may not fix", () => {
  const { repoRoot, home } = unprovisionedRoleRepo("accounting");
  const migration = json(["migrate", "--all", repoRoot], { home });
  const audit = json(["audit", repoRoot], { home });

  for (const failing of audit.rules.filter((rule) => rule.status === "fail" || rule.status === "warn")) {
    const reported = outcome(migration, failing.id);
    assert.ok(reported, `migrate --all left failing rule ${failing.id} out of its report entirely`);
    assert.ok(
      reported.status === "blocked" || reported.status === "partial",
      `${failing.id} still fails audit but migrate reported "${reported.status}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. A migration that DOES reach parity is still reported as a success.
//
// The postcondition must not turn every run yellow: `.project.json` drift that
// migrate genuinely fixes has to keep reporting `applied` and exit 0.
// ---------------------------------------------------------------------------
check("a migration that reaches parity still reports success", () => {
  const repoRoot = join(workspace, "fixable", "repo");
  const home = join(workspace, "fixable", "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  // No agents at all, and a deliberately wrong repo_path — drift with no
  // operator decision in it, which is exactly what migrate exists to fix.
  writeFileSync(
    join(repoRoot, ".project.json"),
    `${JSON.stringify(
      {
        project_name: "Fixable",
        project_description: "",
        project_slug: "fixable",
        repo_path: "/nowhere/at/all",
        ticket_provider: { type: "plane", workspace: "33god", identifier: "fix", board_id: "b", state: "linked" },
        agents: {},
        automation: { reconcile: { enabled: false, grace_hours: 0, auto_review: true } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const before = json(["audit", repoRoot], { home });
  assert.equal(findings(before, "sot.project-json").status, "fail", "expected repo_path drift to fail the audit");
  assert.equal(findings(before, "sot.project-json").fixable, true, "plain drift must stay fixable");

  const migration = json(["migrate", "sot.project-json", repoRoot], { home, expectOk: true });
  assert.equal(outcome(migration, "sot.project-json").status, "applied");
  assert.equal(migration.ok, true, "a migration that reaches parity must still exit 0");

  const after = json(["audit", repoRoot], { home });
  assert.equal(findings(after, "sot.project-json").status, "pass");
});

// ---------------------------------------------------------------------------
// 6. Every registered rule can answer a migrate request.
//
// `hermes.fleet-config` shipped its audit with no migrate at all, which the
// registry surfaced only as "migrate threw: check.migrate is not a function".
// A rule that will not act must SAY so.
// ---------------------------------------------------------------------------
check("every registered rule can answer a migrate request", () => {
  const { repoRoot, home } = unprovisionedRoleRepo("every-rule");
  const ruleIds = runCli(["audit", repoRoot, "--json"], { home });
  const audit = JSON.parse(ruleIds.stdout);
  for (const rule of audit.rules) {
    const migration = json(["migrate", rule.id, repoRoot, "--dry-run"], { home });
    const reported = outcome(migration, rule.id);
    assert.ok(reported, `migrate ${rule.id} produced no result`);
    assert.ok(
      !reported.summary.includes("migrate threw"),
      `migrate ${rule.id} threw instead of reporting: ${reported.summary}`,
    );
  }
});

if (failures.length) {
  console.error(`\npjan-75: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("pjan-75 regressions passed");
