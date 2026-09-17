import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(root, ".pjan-80-cli-"));
try {
  const build = spawnSync("npm", ["exec", "--", "esbuild", "src/index.ts", "src/prompt.ts", "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outdir=${temporary}/bin`], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const repo = join(temporary, "different-directory-name");
  const nested = join(repo, "src");
  mkdirSync(nested, { recursive: true });
  const manifestPath = join(repo, ".project.json");
  const manifest = { project_id: "Px", project_slug: "PX", project_name: "Pilot", project_description: "Canonical manifest", ticket_provider: { type: "plane", identifier: "FOREIGN", board_id: "uuid-for-plane-only", workspace: "33god" } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const registryPath = join(temporary, "fixture.yaml");
  const missingPath = join(temporary, "empty.yaml");
  const registry = { schema_version: 1, projects: { px: { project_id: "px", slug: "px", name: "Old indexed name", description: "Old indexed description", repo_path: repo, status: "active", source_artifacts: [], template: { commonproject: { enabled: true, primary_language: "typescript" } }, ticket_provider: manifest.ticket_provider, agents: {}, created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z" } } };
  writeFileSync(registryPath, YAML.stringify(registry));
  function run(args, location = registryPath, cwd = nested) {
    return spawnSync(process.execPath, [join(temporary, "bin/index.js"), ...args], { cwd, encoding: "utf8", env: { ...process.env, PJ_PROJECT_REGISTRY: location, NO_COLOR: "1" }, timeout: 15000 });
  }
  function json(args, location = registryPath) {
    const result = run([...args, "--json"], location);
    return { result, body: JSON.parse(result.stdout) };
  }

  for (const key of [undefined, "px", "PX", "pX"]) {
    const { result, body } = json(["info", ...(key ? [key] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(body.project_id, "px");
    assert.equal(body.manifest.project_name, "Pilot", "info reads the manifest rather than stale indexed fields");
    assert.equal(body.manifest.project_slug, undefined, "legacy ID is not exposed as a second identity");
    assert.equal(body.manifest.ticket_provider.board_id, "uuid-for-plane-only");
  }
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, project_slug: "different-project" }));
  assert.equal(json(["info"]).result.status, 1, "conflicting manifest identities must be rejected");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const key of ["FOREIGN", "uuid-for-plane-only", "obsolete-alias"]) {
    assert.equal(json(["info", key]).result.status, 1, "provider metadata and old conflicting aliases cannot select a project");
  }
  registry.__registry_status = { px: { status: "invalid", error: "manifest parse failed" } };
  writeFileSync(registryPath, YAML.stringify(registry));
  assert.equal(json(["info"]).body.registry.status, "stale");
  assert.equal(json(["doctor"]).result.status, 1);
  delete registry.__registry_status;
  writeFileSync(registryPath, YAML.stringify(registry));
  const init = json(["init", "--target-dir", repo, "--dry-run", "--no-tui"], missingPath);
  assert.equal(init.result.status, 0, init.result.stdout + init.result.stderr);
  assert.equal(init.body.project.slug, "px");
  assert.equal(init.body.project.ticket_provider.board_id, "uuid-for-plane-only", "an unindexed manifest preserves its existing board");
  assert.equal(init.body.project.ticket_provider.identifier, "FOREIGN", "provider prefix stays board metadata");
  assert.equal(init.body.manifest.project_id, "px");
  assert.equal(init.body.manifest.project_slug, undefined);
  const unindexed = json(["info"], missingPath);
  assert.equal(unindexed.result.status, 0);
  assert.equal(unindexed.body.registry.status, "not-indexed");
  const doctor = json(["doctor"], missingPath);
  assert.equal(doctor.result.status, 1);
  assert.deepEqual(doctor.body.checkedProjects, ["px"]);
  assert.match(doctor.body.issues[0].message, /not-indexed/);
  assert.equal(json(["doctor", "--all"], missingPath).result.status, 0, "all is explicitly scoped to indexed projects");
  assert.equal(json(["doctor", "PX", "--all"]).result.status, 1);
  const offline = json(["info"], "http://127.0.0.1:1");
  assert.equal(offline.result.status, 0, offline.result.stderr);
  assert.equal(offline.body.registry.status, "unavailable");
  assert.equal(offline.body.project_id, "px");
  assert.equal(json(["doctor"], "http://127.0.0.1:1").result.status, 1);
  assert.equal(json(["project", "show", "PX"]).body.project_id, "px", "hidden legacy command still works");
  assert.ok(json(["list"]).body.projects.px, "list now queries projects");
  const help = run(["--help"]);
  assert.match(help.stdout, /info/);
  assert.match(help.stdout, /subsystems/);
  assert.doesNotMatch(help.stdout, /^\s+project\s/m);
  const initHelp = run(["init", "--help"]);
  assert.match(initHelp.stdout, /--id <project-id>/);
  assert.doesNotMatch(initHelp.stdout, /--slug/);
  assert.equal(json(["remove", "PX"]).body.slug, "px");
  assert.equal(run(["board", "slug"]).stdout.trim(), "px");
  const prompt = spawnSync(process.execPath, [join(temporary, "bin/prompt.js")], { cwd: nested, encoding: "utf8" });
  // The manifest spells the id `Px` and the legacy field `PX`, so an exact head
  // still proves what PJAN-80 came for: the prompt reports the canonical
  // lowercase id and never the legacy spelling. The badge beside it is the
  // board prefix, deliberately `FOREIGN` here — pinned rather than tolerated,
  // because "metadata, not a lookup key" is a claim about resolution, and this
  // line is the one that proves the prompt keeps showing it without ever
  // letting it stand in for identity.
  assert.equal(prompt.stdout.split(" · ")[0], "px (FOREIGN)");
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, project_id: undefined, project_slug: "PX" }));
  assert.equal(json(["info"]).body.project_id, "px", "legacy manifests remain readable");
  writeFileSync(manifestPath, "{");
  assert.equal(json(["info"]).result.status, 1, "malformed manifests cannot report success");
  console.log("PJAN-80 CLI: canonical IDs, manifest authority, current scope, offline info, flat commands passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
