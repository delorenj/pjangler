import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan70-protocol-"));
try {
  const entry = join(scratch, "entry.ts");
  const server = join(root, "dist", "pjan70-protocol-test.mjs");
  const ready = join(scratch, "ready");
  const late = join(scratch, "late");
  const afterChild = join(scratch, "after-child");
  writeFileSync(entry, `import { Command } from ${JSON.stringify(join(root, "src/commands/Command.ts"))};
import { runChild } from ${JSON.stringify(join(root, "src/lifecycle/operation.ts"))};
import { recipeRegistry } from ${JSON.stringify(join(root, "src/recipes/catalog.ts"))};
class Slow extends Command {
 async invoke() {
   await runChild(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>require('node:fs').writeFileSync(process.argv[2], 'late'), 1800)", process.env.PJAN70_READY, process.env.PJAN70_LATE]);
   require('node:fs').writeFileSync(process.env.PJAN70_AFTER_CHILD, 'bad');
   return {success:true, message:'completed'};
 }
}
recipeRegistry.get('node').addIngredient(Slow);
await import(${JSON.stringify(join(root, "src/mcp-server.ts"))});
`);
  await build({ entryPoints: [entry], outfile: server, bundle: true, packages: "external", platform: "node", format: "esm" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root,
    env: hermeticEnv({ PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJAN70_READY: ready, PJAN70_LATE: late, PJAN70_AFTER_CHILD: afterChild }) });
  const client = new Client({ name: "pjan70-protocol", version: "1" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "pjangler_run_recipe"));
    const args = { recipe: "node", targetDir: scratch, timeoutMs: 150 };
    const deadline = await client.callTool({ name: "pjangler_run_recipe", arguments: args });
    assert.equal(deadline.isError, true, JSON.stringify(deadline));
    assert.match(deadline.content[0].text, /deadline-exceeded/);
    assert.equal(existsSync(late), false);
    assert.equal(existsSync(afterChild), false, "expired request cannot write after its child stops");
    const next = await client.callTool({ name: "pjangler_describe_recipe", arguments: { recipe: "node" } });
    assert.notEqual(next.isError, true);
    assert.ok(next.structuredContent);
    await new Promise((done) => setTimeout(done, 2000));
    assert.equal(existsSync(late), false);
    assert.equal(existsSync(afterChild), false, "expired request cannot write at original completion time");
    rmSync(ready, { force: true });
    const cancelled = new AbortController();
    const pending = client.callTool({ name: "pjangler_run_recipe", arguments: { recipe: "node", targetDir: scratch, timeoutMs: 5000 } }, undefined, { signal: cancelled.signal });
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((done) => setTimeout(done, 10));
    assert.ok(existsSync(ready), "cancellation fixture started");
    cancelled.abort();
    await assert.rejects(pending, /abort|cancel/i);
    const afterCancel = await client.callTool({ name: "pjangler_describe_recipe", arguments: { recipe: "node" } });
    assert.notEqual(afterCancel.isError, true);
    await new Promise((done) => setTimeout(done, 2000));
    assert.equal(existsSync(late), false, "cancelled MCP request must not write at original completion time");
    assert.equal(existsSync(afterChild), false, "cancelled handler cannot write after its child stops");
    console.log("PJAN-70 MCP stdio cancellation/deadline, late-write prevention and subsequent requests passed");
  } finally { await client.close(); }
} finally { rmSync(scratch, { recursive: true, force: true }); rmSync(join(root, "dist", "pjan70-protocol-test.mjs"), { force: true }); }
