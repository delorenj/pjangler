import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-17-canonical-binding-"));
const bundle = join(root, ".pjan-17-canonical-binding.mjs");
process.env.GIT_CEILING_DIRECTORIES = scratch;
process.on("exit", () => { rmSync(scratch, { recursive: true, force: true }); rmSync(bundle, { force: true }); });
buildSync({ entryPoints: [join(root, "src/index.ts")], bundle: true, packages: "external", platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });

function run(args, home) {
  const result = spawnSync(process.execPath, [bundle, ...args, "--json"], {
    cwd: root, encoding: "utf8", env: hermeticEnv({ HOME: home, GIT_CEILING_DIRECTORIES: scratch, NO_COLOR: "1" }),
  });
  assert.ok(result.stdout.trim().startsWith("{"), result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

for (const [label, canonical, expected] of [
  ["trello", { type: "trello", state: "planned" }, { type: "trello", board_id: "", workspace: "", identifier: "", state: "planned" }],
  ["plane", { type: "plane", board_id: "", workspace: "", identifier: "", state: "planned" }, { type: "plane", board_id: "", workspace: "", identifier: "", state: "planned" }],
  ["legacy-role-only", undefined, { type: "plane", board_id: "stale-plane-board", workspace: "stale-space", identifier: "STALE", state: "linked" }],
]) {
  const home = join(scratch, label, "home");
  const repo = join(scratch, label, "repo");
  const role = join(repo, "agents/hermes/pm");
  mkdirSync(role, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(role, "role.yaml"), "role: pm\nagent_id: fixture-pm\nticket_provider:\n  name: plane\n  workspace: stale-space\n  board_id: stale-plane-board\nplane:\n  identifier: STALE\n");
  const manifest = join(repo, ".project.json");
  const initial = { project_name: "Fixture", project_description: "", project_id: "fixture", repo_path: repo,
    ...(canonical ? { ticket_provider: canonical } : {}), agents: {} };
  writeFileSync(manifest, `${JSON.stringify(initial, null, 2)}\n`);
  run(["migrate", "sot.project-json", repo], home);
  const actual = JSON.parse(readFileSync(manifest, "utf8")).ticket_provider;
  assert.deepEqual(actual, expected, `${label}: stale role identity must not cross an explicit canonical provider`);
  if (label !== "legacy-role-only") {
    const audit = run(["audit", repo, "--rules", "sot.project-json"], home);
    const finding = audit.rules.find((item) => item.id === "sot.project-json");
    assert.ok(!finding.details.some((detail) => detail.includes("legacy role.yaml contains a board binding")), JSON.stringify(finding));
    assert.equal(actual.state, "planned", `${label}: no false linked claim`);
    const once = readFileSync(manifest, "utf8");
    run(["migrate", "sot.project-json", repo], home);
    assert.equal(readFileSync(manifest, "utf8"), once, `${label}: repeat migration is byte-stable`);
  }
  console.log(`  ok   ${label} canonical identity`);
}
console.log("PJAN-17 canonical binding migration regressions passed");
