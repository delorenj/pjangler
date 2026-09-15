import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planProjectInit, executeProjectInitPlan } from "../src/project/index";

const root = mkdtempSync("/tmp/pjan80-bootstrap-");
const path = join(root, ".project.json");
const manifest = {
  project_id: "fixture", project_name: "Fixture", project_description: "original", repo_path: root,
  ticket_provider: { type: "plane", state: "planned", identifier: "FIX", board_id: "", workspace: "33god", custom: "provider-extension" },
  agents: { "fixture-pm": { role: "pm", provisioning_state: "planned", custom: { retained: true } } },
  template: { custom: "template-extension", commonproject: { enabled: true, primary_language: "typescript", extra: true } },
  custom: { preserved: true },
};
try {
  const original = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(path, original);
  const makePlan = () => {
    const plan = planProjectInit({ name: "Fixture", targetDir: root, registryPath: join(root, "fixture.yaml"), scaffold: false, apply: true, skipPlane: true });
    return { ...plan, actions: plan.actions.filter(action => action.kind === "project.write-manifest") };
  };
  let plan = makePlan();
  const edited = JSON.stringify({ ...manifest, project_description: "operator edit" });
  writeFileSync(path, edited);
  let result = await executeProjectInitPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /changed after planning/);
  assert.equal(readFileSync(path, "utf8"), edited);
  writeFileSync(path, original);
  plan = makePlan();
  writeFileSync(path, '{"project_id":');
  result = await executeProjectInitPlan(plan);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(path, "utf8"), '{"project_id":');
  writeFileSync(path, original);
  result = await executeProjectInitPlan(makePlan());
  assert.equal(result.ok, true, result.errors.join(" "));
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.project_id, "fixture");
  assert.equal(saved.project_slug, undefined);
  assert.equal(saved.template.custom, "template-extension");
  assert.equal(saved.template.commonproject.extra, true);
  assert.deepEqual(saved.agents["fixture-pm"].custom, { retained: true });
  assert.equal(saved.ticket_provider.custom, "provider-extension");
  assert.deepEqual(saved.custom, { preserved: true });
  console.log("PASS PJAN-80 bootstrap: stale and malformed manifests preserved; nested extensions survive");
} finally { rmSync(root, { recursive: true, force: true }); }
