import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "pjan-17-parity-"));
try {
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "dir");
  const bundle = join(work, "rules.mjs");
  buildSync({ entryPoints: [join(root, "src/parity/rules.ts")], outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const { createProjectChecks } = await import(pathToFileURL(bundle).href);
  const checks = createProjectChecks();
  function fixture(name, binding, roleProvider) {
    const repoRoot = join(work, name);
    mkdirSync(repoRoot);
    const manifest = { project_name: name, project_description: "", project_id: name, repo_path: repoRoot, agents: {} };
    if (binding !== undefined) manifest.ticket_provider = binding;
    writeFileSync(join(repoRoot, ".project.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(repoRoot, ".copier-answers.yml"), "# operator provenance\nproject_name: original\n");
    writeFileSync(join(repoRoot, ".plane.json"), "{\"historical\":true}\n");
    if (roleProvider) {
      const roleDir = join(repoRoot, "agents/hermes/pm");
      mkdirSync(roleDir, { recursive: true });
      writeFileSync(join(roleDir, "role.yaml"), `role: pm\nagent_id: ${name}-pm\nticket_provider:\n  name: ${roleProvider}\n  board_id: legacy-board\n`);
    }
    return { repoRoot, homeDir: work, pjanglerRoot: root, dryRun: false, live: false };
  }
  const original = { type: "linear", workspace: "old-team", board_id: "old-board", state: "planned", board_url: "https://linear.app/old", custom: { keep: true } };
  for (const [name, binding, legacy] of [["linear", original], ["unknown", { ...original, type: "other" }], ["legacy-linear", undefined, "linear"]]) {
    const ctx = fixture(name, binding, legacy);
    const files = [".project.json", ".copier-answers.yml", ".plane.json"];
    const before = files.map(file => readFileSync(join(ctx.repoRoot, file), "utf8"));
    for (const id of ["sot.project-json", "provenance.copier"]) {
      const check = checks.find(check => check.id === id);
      const finding = await check.audit(ctx);
      assert.equal(finding.status, "fail", `${name}/${id}: unsupported must fail`);
      assert.equal(finding.fixable, false, `${name}/${id}: no automatic provider migration`);
      assert.match(JSON.stringify(finding), /Unsupported ticket provider/);
      for (const dryRun of [true, false]) {
        const result = await check.migrate({ ...ctx, dryRun }, finding);
        assert.equal(result.status, "blocked", `${name}/${id}: migrate must refuse`);
        assert.deepEqual(result.changedFiles, []);
        assert.deepEqual(files.map(file => readFileSync(join(ctx.repoRoot, file), "utf8")), before, `${name}/${id}: original records survive byte-for-byte`);
      }
    }
    console.log(`PASS unsupported ${name}: audit, dry-run and apply preserve original records`);
  }
  for (const [name, binding] of [["missing", undefined], ["no-provider", { type: "none", state: "skipped", custom: "retained" }], ["missing-type", { board_id: "untyped-board", state: "linked" }], ["empty-type", { type: "", state: "skipped" }]]) {
    const ctx = fixture(name, binding);
    const check = checks.find(check => check.id === "sot.project-json");
    const result = await check.migrate(ctx, await check.audit(ctx));
    assert.notEqual(result.status, "blocked");
    const provider = JSON.parse(readFileSync(join(ctx.repoRoot, ".project.json"))).ticket_provider;
    assert.notEqual(provider.type, "plane", `${name}: absence never selects Plane`);
    if (binding !== undefined) assert.deepEqual(provider, binding, `${name}: unbound/skipped data retained`);
    if (name === "missing" || name === "no-provider") assert.equal((await check.audit(ctx)).status, "pass", `${name}: skipped binding satisfies the canonical contract`);
    const provenance = checks.find(check => check.id === "provenance.copier");
    await provenance.migrate(ctx, await provenance.audit(ctx));
    assert.doesNotMatch(readFileSync(join(ctx.repoRoot, ".copier-answers.yml"), "utf8"), /ticket_provider: plane/);
    console.log(`PASS ${name}: no Plane binding or provenance manufactured`);
  }
  for (const type of ["plane", "trello"]) {
    const ctx = fixture(`supported-${type}`, { type, workspace: "fixture", board_id: "board", identifier: "FIX", state: "planned" });
    const check = checks.find(check => check.id === "sot.project-json");
    const result = await check.migrate(ctx, await check.audit(ctx));
    assert.notEqual(result.status, "blocked");
    assert.equal(JSON.parse(readFileSync(join(ctx.repoRoot, ".project.json"))).ticket_provider.type, type);
    console.log(`PASS supported ${type}: canonical migration remains available`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
