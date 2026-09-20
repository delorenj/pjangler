import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProjectRegistry, loadProjectRegistry, saveProjectRegistry, type ProjectRecord } from "../src/project/index";
import { persistProjectNotebookBinding, resolveEffectiveNotebookConfig, resolveNotebookProjectBySlug } from "../src/notebook/config";
import { captureWorkerEnvironment } from "../src/notebook/hooks";

const repo = mkdtempSync(join(tmpdir(), "pjan-80-consumers-"));
const project: ProjectRecord = {
  project_id: "px", slug: "px", name: "Pilot", repo_path: repo, description: "", status: "active",
  source_artifacts: [], template: { commonproject: { enabled: true, primary_language: "typescript" } },
  ticket_provider: { type: "plane", workspace: "33god", identifier: "PX", board_id: "", state: "planned" },
  agents: {}, created_at: "2026-09-15T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z",
  notebook: { state: "planned", notebook_name: "Stale indexed name" },
};
const registry = emptyProjectRegistry();
registry.projects.px = project;
const manifest = {
  project_id: "px", project_name: "Pilot",
  notebook: { binding: { state: "linked", notebook_id: "manifest-owned", overview_note_id: "overview", notebook_name: "Pilot" }, policy: { enabled: true } },
};
writeFileSync(join(repo, ".project.json"), JSON.stringify(manifest));
// The child can answer the production synchronous client while this process waits.
const server = spawn(process.execPath, ["--input-type=module", "-e", `
  import { createServer } from 'node:http';
  import { readFileSync,writeFileSync } from 'node:fs';
  let body=''; for await (const chunk of process.stdin) body+=chunk;
  let registry=JSON.parse(body);
  const server=createServer(async(req,res)=>{
    if(req.method==='PUT') { let text=''; for await(const chunk of req) text+=chunk; registry=JSON.parse(text);
      for(const record of Object.values(registry.projects)) { const path=record.repo_path+'/.project.json'; const manifest=JSON.parse(readFileSync(path,'utf8')); manifest.notebook={...manifest.notebook,binding:record.notebook};writeFileSync(path,JSON.stringify(manifest)); }
    }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(registry));
  });
  server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
`], { stdio: ["pipe", "pipe", "inherit"] });
server.stdin.end(JSON.stringify(registry));
try {
  const [output] = await once(server.stdout, "data");
  const url = `http://127.0.0.1:${String(output).trim()}`;
  const resolved = resolveNotebookProjectBySlug("PX", url);
  assert.equal(resolved.project.slug, "px", "notebook lookup accepts case-insensitive project ids");
  const config = resolveEffectiveNotebookConfig(resolved);
  assert.equal(config.binding.notebook_id, "manifest-owned", "manifest binding beats an older indexed binding");
  assert.equal(config.configuration_provenance.binding, "manifest-binding");
  const changed = persistProjectNotebookBinding(resolved, { state: "linked", notebook_id: "next-binding", overview_note_id: "overview", notebook_name: "Pilot" });
  assert.deepEqual(changed, [join(repo, ".project.json")], "URLs must never be returned as changed files");
  assert.equal(JSON.parse(readFileSync(join(repo, ".project.json"), "utf8")).notebook.binding.notebook_id, "next-binding");
  assert.equal(loadProjectRegistry(url).projects.px!.notebook!.notebook_id, "next-binding", "manifest changes reach the service index");
  const worker = captureWorkerEnvironment({ HOME: repo, PATH: process.env.PATH, PJ_REGISTRY_URL: url }, "px");
  assert.equal(worker.PJ_REGISTRY_URL, url, "detached workers retain the singleton endpoint");
  const unavailable = loadProjectRegistry(url) as typeof registry & { __registry_status: Record<string, unknown> };
  unavailable.__registry_status = { px: { status: "missing", error: "manifest file missing" } };
  saveProjectRegistry(unavailable, url);
  assert.throws(() => resolveNotebookProjectBySlug("Px", url), /manifest is missing/);
  console.log("pjan-80 registry consumer regressions: ok");
} finally {
  server.kill();
  await once(server, "exit");
  rmSync(repo, { recursive: true, force: true });
}
