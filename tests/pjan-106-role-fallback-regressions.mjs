import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const scratch = hermeticScratch("pjan-106-role-fallback-");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function fixture(label, { legacy, vestigial, noAutomation } = {}) {
  const repo = join(scratch, label, "repo");
  const home = join(scratch, label, "home");
  const rolePath = join(repo, "agents", "hermes", "pm", "role.yaml");
  const manifestPath = join(repo, ".project.json");
  mkdirSync(join(repo, "agents", "hermes", "pm", ".scripts", "lib"), { recursive: true });
  mkdirSync(join(repo, "agents", "hermes", "pm", ".scripts", "providers"), { recursive: true });
  writeFileSync(join(repo, "agents", "hermes", "pm", ".scripts", "lib", "ticket-provider.sh"), "# fixture dispatcher\n");
  writeFileSync(join(repo, "agents", "hermes", "pm", ".scripts", "providers", "plane.sh"), "# fixture provider\n");
  mkdirSync(home, { recursive: true });
  const roleText = [
    "role: pm",
    "agent_id: fixture-pm",
    "ticket_provider:",
    "  name: plane",
    "  workspace: test-space",
    "  board_id: fixture-board",
    "plane:",
    "  identifier: FIX",
    "scrum_master:",
    "  grace_hours: 37 # non-default; must not seed a dead manifest switch",
    "  auto_review: false",
    ...(legacy ? ["reconcile:", "  enabled: true", "  grace_hours: 41", "  auto_review: false"] : []),
    "",
  ].join("\n");
  writeFileSync(rolePath, roleText);
  const manifest = {
    project_name: "Fixture",
    project_description: "",
    project_id: "fixture",
    repo_path: repo,
    // Intentionally no ticket_provider: this exercises real role.yaml fallback.
    agents: {},
    ...(noAutomation ? {} : { automation: { ...(vestigial ? { reconcile: { enabled: true, grace_hours: 99, auto_review: true } } : {}), lifecycle: { phase: "retained" }, custom: false } }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { repo, home, rolePath, roleText, manifestPath };
}

function run(args, home) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: hermeticEnv({ HOME: home, GIT_CEILING_DIRECTORIES: scratch, NO_COLOR: "1" }),
  });
  assert.ok(result.stdout.trim().startsWith("{"), `CLI returned no JSON (${result.status})\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const finding = (report) => report.rules.find((entry) => entry.id === "sot.project-json");
const outcome = (report) => report.results.find((entry) => entry.id === "sot.project-json");

for (const [label, options] of [
  ["legacy-without-reconcile", { legacy: true }],
  ["legacy-without-automation", { legacy: true, noAutomation: true }],
  ["legacy-with-vestigial-reconcile", { legacy: true, vestigial: true }],
  ["scrum-only-without-legacy-block", {}],
]) {
  const { repo, home, rolePath, roleText, manifestPath } = fixture(label, options);
  const before = run(["audit", repo, "--rules", "sot.project-json"], home);
  assert.equal(finding(before)?.status, "fail", `${label}: missing provider must be reported as drift`);
  assert.equal(finding(before)?.fixable, true);
  if (options.vestigial) {
    assert.ok(finding(before).details.some((detail) => detail.includes("automation.reconcile")), `${label}: audit must flag vestigial key`);
  }

  const migration = run(["migrate", "sot.project-json", repo], home);
  assert.equal(outcome(migration)?.status, "applied", `${label}: ${JSON.stringify(outcome(migration))}`);
  assert.ok(outcome(migration).changedFiles.includes(manifestPath), `${label}: expected a real manifest write`);
  const migratedText = readFileSync(manifestPath, "utf8");
  const migrated = JSON.parse(migratedText);
  assert.deepEqual(migrated.ticket_provider, {
    type: "plane", workspace: "test-space", identifier: "FIX", board_id: "fixture-board", state: "linked",
  }, `${label}: real role.yaml fallback must recover the provider binding`);
  assert.deepEqual(migrated.agents["fixture-pm"], { role: "pm", role_dir: "agents/hermes/pm" });
  assert.deepEqual(migrated.automation, options.noAutomation ? undefined : { lifecycle: { phase: "retained" }, custom: false }, `${label}: preserve unrelated automation, retire reconcile`);
  assert.equal(readFileSync(rolePath, "utf8"), roleText, `${label}: role.yaml is immutable during migration`);
  assert.equal(finding(run(["audit", repo, "--rules", "sot.project-json"], home))?.status, "pass", `${label}: migrated rule must pass its own audit`);

  const again = run(["migrate", "sot.project-json", repo], home);
  assert.equal(readFileSync(manifestPath, "utf8"), migratedText, `${label}: second migration must be byte-stable`);
  assert.deepEqual(outcome(again)?.changedFiles, [], `${label}: second migration must not write`);
  assert.equal(readFileSync(rolePath, "utf8"), roleText);
  console.log(`  ok   ${label}: audit, migrate, audit, idempotence`);
}
console.log("PJAN-106 role fallback regressions passed");
