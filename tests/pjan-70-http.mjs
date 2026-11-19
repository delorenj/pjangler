import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = hermeticScratch("pjan70-http");
const delayMs = 650;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const requests = new Map();
const timers = new Set();
const server = createServer((req, res) => {
  const [scenario, ...route] = req.url.slice(1).split("/");
  const path = `/${route.join("/")}`;
  const events = requests.get(scenario) ?? [];
  requests.set(scenario, events);
  const event = { request: `${req.method} ${path}`, at: performance.now(), closed: null };
  events.push(event);
  res.on("close", () => { event.closed = performance.now(); });
  const responseBody = path === "/api/auth/status" ? { auth_enabled: false }
    : path === "/api/notebooks" && req.method === "GET" ? []
    : path.includes("/projects/") ? { results: [], next_page_results: true, next_cursor: "must-not-dispatch" }
    : path.includes("/boards/") ? { id: "local", name: "local", closed: false }
    : { id: "local", name: "local", description: "" };
  const delayed = scenario.startsWith("auth-") || scenario.startsWith("hook-") ? path === "/api/auth/status"
    : scenario.startsWith("list-") ? path === "/api/notebooks" && req.method === "GET"
    : true;
  const status = scenario.includes("error-body") ? 503 : 200;
  const headers = () => res.writeHead(status, { "Content-Type": "application/json" });
  const finish = () => { if (!res.destroyed) res.end(JSON.stringify(responseBody)); };
  if (!delayed || scenario === "normal") { headers(); finish(); return; }
  if (scenario.endsWith("headers")) {
    const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) { headers(); finish(); } }, delayMs);
    timers.add(timer);
  } else {
    headers();
    res.flushHeaders();
    const timer = setTimeout(() => { timers.delete(timer); finish(); }, delayMs);
    timers.add(timer);
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  const entry = join(scratch, "entry.ts");
  const bundle = join(scratch, "server.mjs");
  writeFileSync(entry, `
import { Command } from ${JSON.stringify(join(root, "src/commands/Command.ts"))};
import { recipeRegistry } from ${JSON.stringify(join(root, "src/recipes/catalog.ts"))};
import { NotebookModule } from ${JSON.stringify(join(root, "src/notebook/module.ts"))};
import { fetchPlaneBoards, patchPlaneBoardIdentifier, fetchTrelloBoard } from ${JSON.stringify(join(root, "src/project/identity.ts"))};
import { fetchRecentTickets } from ${JSON.stringify(join(root, "src/project/boardQuery.ts"))};
import { basename, join } from 'node:path';
import { writeFileSync } from 'node:fs';
class HttpProbe extends Command {
 async invoke() {
  const scenario = basename(this.context.targetDir);
  const base = process.env.PJAN70_HTTP_BASE + '/' + scenario;
  const config = { base_url: base, project_slug:'local', policy:{enabled:true},
    auth:{mode:scenario.startsWith('auth-')?'environment':'none',env_var:'LOCAL_TOKEN'},
    limits:{overall_timeout_ms:5000,request_max_bytes:100000,response_max_bytes:100000,list_max_items:100,note_max_bytes:100000} };
  const module = new NotebookModule({stateRoot:join(this.context.targetDir,'state'),env:{LOCAL_TOKEN:'local-only'},
    fetch:(url, init) => globalThis.fetch(base+new URL(url).pathname+new URL(url).search, init)});
  const c = module.clientForConfig(config);
  try {
   if (scenario.startsWith('plane-')) await fetchPlaneBoards('local',{PLANE_API_KEY:'local-only',PLANE_BASE:base},this.context.targetDir);
   else if (scenario.startsWith('patch-')) await patchPlaneBoardIdentifier('local','local','LOCAL',{PLANE_API_KEY:'local-only',PLANE_BASE:base},this.context.targetDir);
   else if (scenario.startsWith('trello-')) {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (!String(url).startsWith('https://api.trello.com/1/boards/')) throw new Error('unexpected URL');
      return nativeFetch(base+'/boards/local', init);
    };
    try { await fetchTrelloBoard('local',{TRELLO_API_KEY:'local-only',TRELLO_TOKEN:'local-only'},this.context.targetDir); }
    finally { globalThis.fetch = nativeFetch; }
   } else if (scenario.startsWith('provision-')) await module.provisionResolved({project:{slug:'local',name:'local',repo_path:this.context.targetDir},manifest:{}},config);
   else if (scenario.startsWith('board-')) await fetchRecentTickets({provider:'plane',slug:'local',root:this.context.targetDir,home:this.context.targetDir,
     facts:{board_id:'local',workspace:'local'},env:{PLANE_API_KEY:'local-only',PLANE_BASE:base}});
   else {
    if (scenario.startsWith('list-')) await c.listNotebooks();
    await c.createNotebook({name:'local'}, () => writeFileSync(join(this.context.targetDir,'dispatch-latch'),'started'));
    if (scenario === 'post-body') await c.createNotebook({name:'must-not-dispatch'});
   }
   writeFileSync(join(this.context.targetDir,'after-http'),'bad-if-stopped');
   return {success:true,message:'completed'};
  } catch (error) {
   process.stderr.write('PJAN70_HTTP_STOP '+scenario+' '+error.name+' '+error.reason+'\\n');
   throw error;
  }
 }
}
recipeRegistry.get('node').addIngredient(HttpProbe);
await import(${JSON.stringify(join(root, "src/mcp-server.ts"))});
`);
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
  const adapterBundle = join(scratch, "adapter.mjs");
  await build({ entryPoints: [join(root, "src/notebook/open-notebook-client.ts")], outfile: adapterBundle, bundle: true, packages: "external", platform: "node", format: "esm" });
  const { OpenNotebookClient } = await import(adapterBundle);
  for (const phase of ["headers", "body"]) {
    const scenario = `hook-${phase}`;
    const config = { base_url: base, auth: { mode: "environment", env_var: "LOCAL_TOKEN" }, limits: { overall_timeout_ms: 5000, request_max_bytes: 100000, response_max_bytes: 100000 } };
    const adapter = new OpenNotebookClient(config, {
      env: { LOCAL_TOKEN: "local-only" }, deadlineMonotonicMs: performance.now() + 80,
      fetch: (url, init) => fetch(base + "/" + scenario + new URL(url).pathname, init),
    });
    const started = performance.now();
    await assert.rejects(adapter.createNotebook({ name: "local" }), (error) => error.code === "TIMEOUT");
    assert.ok(performance.now() - started < 500, "non-MCP hook budget remains bounded");
    await pause(delayMs + 30);
    assert.deepEqual(requests.get(scenario).map((event) => event.request), ["GET /api/auth/status"]);
    assert.ok(requests.get(scenario)[0].closed - started < 500);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: root, stderr: "pipe",
    env: hermeticEnv({ HOME: join(scratch, "home"), PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJAN70_HTTP_BASE: base }) });
  let stderr = "";
  const client = new Client({ name: "pjan70-http", version: "1" });
  await client.connect(transport);
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  const scenarios = ["auth-headers", "auth-body", "list-headers", "list-body", "post-headers", "post-body", "post-error-body", "auth-error-body",
    "provision-headers", "provision-body", "plane-headers", "plane-body", "patch-headers", "patch-error-body", "trello-headers", "trello-body", "board-headers", "board-body"];
  try {
    const warmup = join(scratch, "warmup", "normal");
    mkdirSync(warmup, { recursive: true });
    const warmed = await client.callTool({ name: "pjangler_run_recipe", arguments: { recipe: "node", targetDir: warmup, timeoutMs: 5000 } });
    assert.notEqual(warmed.isError, true, JSON.stringify(warmed));
    for (const scenario of scenarios) {
      for (const mode of ["deadline", "cancel"]) {
        const dir = join(scratch, mode, scenario);
        mkdirSync(dir, { recursive: true });
        requests.set(scenario, []);
        const controller = new AbortController();
        const started = performance.now();
        const deadlineMs = scenario.startsWith("provision-") ? 300 : 80;
        const pending = client.callTool({ name: "pjangler_run_recipe", arguments: { recipe: "node", targetDir: dir, timeoutMs: mode === "deadline" ? deadlineMs : 5000 } }, undefined, { signal: controller.signal });
        // Observe the request before cancelling, not a sleep that might stop preflight.
        for (let i = 0; i < 200 && requests.get(scenario).length === 0; i++) await pause(5);
        assert.ok(requests.get(scenario).length, `${scenario}: fixture reached HTTP; reply=${requests.get(scenario).length ? '' : JSON.stringify(await pending)} stderr=${stderr}`);
        const stopped = mode === "cancel" ? performance.now() : started + deadlineMs;
        if (mode === "cancel") {
          controller.abort();
          await assert.rejects(pending, /abort|cancel/i);
        } else {
          const reply = await pending;
          assert.equal(reply.isError, true, JSON.stringify(reply));
          assert.equal(reply.content[0].text, "MCP operation deadline-exceeded");
        }
        const reason = mode === "cancel" ? "cancelled" : "deadline-exceeded";
        for (let i = 0; i < 100 && !stderr.includes(`PJAN70_HTTP_STOP ${scenario} OperationStopped ${reason}`); i++) await pause(5);
        assert.ok(stderr.includes(`PJAN70_HTTP_STOP ${scenario} OperationStopped ${reason}`), stderr);
        stderr = "";
        const elapsedMs = Math.round(performance.now() - started);
        assert.ok(performance.now() - stopped < 500, `${scenario}: bounded handler stop (${elapsedMs}ms)`);
        const next = await client.callTool({ name: "pjangler_describe_recipe", arguments: { recipe: "node" } });
        assert.notEqual(next.isError, true);
        // Keep the fake alive beyond its original completion to detect background follow-up work.
        await pause(delayMs + 30);
        const events = requests.get(scenario);
        assert.equal(events.length, scenario.startsWith("board-") ? 2 : 1, `${scenario}: no request after the stopped wait: ${JSON.stringify(events)}`);
        assert.ok(events.every((event) => event.closed !== null && event.closed - stopped < 500), `${scenario}: active HTTP connections aborted`);
        assert.equal(existsSync(join(dir, "after-http")), false, `${scenario}: no post-await finalizer write`);
        assert.equal(existsSync(join(dir, "dispatch-latch")), scenario.startsWith("post-"), `${scenario}: dispatch latch only before a pre-stop POST`);
        if (scenario.startsWith("provision-")) {
          const journals = readdirSync(join(dir, "state"), { recursive: true }).filter((path) => path.endsWith(".json"));
          assert.equal(journals.length, 1, "only the pre-stop preparation journal exists");
          assert.equal(JSON.parse(readFileSync(join(dir, "state", journals[0]), "utf8")).state, "prepared", "no reconciliation/commit after stop");
        }
        console.log(JSON.stringify({ scenario, mode, elapsedMs, requests: events.map((event) => event.request), reason }));
      }
    }
    const normal = join(scratch, "normal");
    mkdirSync(normal);
    const reply = await client.callTool({ name: "pjangler_run_recipe", arguments: { recipe: "node", targetDir: normal, timeoutMs: 5000 } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    assert.equal(readFileSync(join(normal, "after-http"), "utf8"), "bad-if-stopped");
    console.log("PJAN-70 real MCP HTTP headers/body deadlines, cancellation, no later dispatch/finalizer and subsequent requests passed (36 stop cases + normal)");
  } finally { await client.close(); }
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
