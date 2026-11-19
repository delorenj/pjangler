import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import YAML from "yaml";
import Ajv from "ajv";
import { buildSync } from "esbuild";
import { BoundedCapture, paginate } from "../src/mcp-bounds.ts";

const root = resolve(import.meta.dirname, "..");
const verboseFixture = mkdtempSync(join(tmpdir(), "pjan69-client-verbose-"));
const verboseServer = join(root, "dist/pjan69-verbose-test.mjs");
try {
  const entry = join(verboseFixture, "entry.ts");
  writeFileSync(entry, `import { Command } from ${JSON.stringify(join(root, "src/commands/Command.ts"))};
import { recipeRegistry } from ${JSON.stringify(join(root, "src/recipes/catalog.ts"))};
class Loud extends Command {
  async invoke() {
    const kind = process.env.PJAN69_LOUD_KIND;
    const message = (kind === "nul" ? "\\0" : kind === "unicode" ? "😀" : "x").repeat(Number(process.env.PJAN69_LOUD_LENGTH));
    return { success: process.env.PJAN69_LOUD_FAIL !== "1", message };
  }
}
recipeRegistry.get("node")!.addIngredient(Loud);
await import(${JSON.stringify(join(root, "src/mcp-server.ts"))});
`);
  buildSync({ entryPoints: [entry], outfile: verboseServer, bundle: true, packages: "external", platform: "node", format: "esm" });
} catch (err) { rmSync(verboseFixture, { recursive: true, force: true }); throw err; }
const fixtureRoot = mkdtempSync(join(tmpdir(), "pjan69-verbose-fixture-"));
try {
  const source = join(fixtureRoot, "verbose-entry.ts");
  writeFileSync(source, `import { NodeRecipe } from ${JSON.stringify(join(root, "src/recipes/NodeRecipe.ts"))};
import { RecipeRegistry } from ${JSON.stringify(join(root, "src/recipes/registry.ts"))};
import { BoundedCapture } from ${JSON.stringify(join(root, "src/mcp-bounds.ts"))};
const message = '😀"\\\\\\n'.repeat(26000);
class Verbose extends NodeRecipe {
  override async init(ctx: any, input: unknown) {
    const result = await super.init(ctx, input);
    for (let i = 0; i < 8; i++) ctx.mcpCapture.logs.append(message);
    if (process.argv[2] === 'fail') {
      for (let i = 0; i < 8; i++) ctx.mcpCapture.errors.append(message);
      return { ...result, ok: false };
    }
    return result;
  }
}
const registry = new RecipeRegistry([new Verbose()]);
const logs = new BoundedCapture(); const errors = new BoundedCapture();
const ctx = { targetDir: process.cwd(), repoRoot: process.cwd(), pjanglerRoot: process.cwd(), homeDir: process.cwd(), dryRun: true, force: false, quiet: true, mcpCapture: { logs, errors } };
const result = await registry.initRecipe('node', ctx, {});
console.log(JSON.stringify({ ok: result.ok, logs: logs.entries, errors: errors.entries,
  logBytes: logs.bytes, errorBytes: errors.bytes, logOmitted: logs.omittedCount,
  errorOmitted: errors.omittedCount, retainedResultLogs: result.logs.length,
  retainedResultErrors: result.errors.length }));
`);
  buildSync({ entryPoints: [source], outfile: join(fixtureRoot, "verbose.mjs"), bundle: true, platform: "node", format: "esm" });
  for (const mode of ["success", "fail"]) {
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync("node", [join(fixtureRoot, "verbose.mjs"), mode], { cwd: fixtureRoot, env: hermeticEnv(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "", "stdout/stderr framing stays clean");
    assert.equal(child.stdout.trim().split("\n").length, 1, "one JSON frame per invocation");
    const payload = JSON.parse(child.stdout.trim());
    assert.equal(payload.ok, mode === "success");
    assert.equal(payload.retainedResultLogs, 0);
    assert.equal(payload.retainedResultErrors, 0);
    assert.equal(payload.logBytes, Buffer.byteLength(payload.logs.join("")));
    assert.ok(payload.logBytes <= 65536 && payload.logOmitted > 0);
    assert.ok(Buffer.byteLength(child.stdout) < 400000, "discarded messages never enter the result");
    if (mode === "fail") {
      assert.equal(payload.errorBytes, Buffer.byteLength(payload.errors.join("")));
      assert.ok(payload.errorBytes <= 65536 && payload.errorOmitted > 0);
    }
  }
} finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
// Producer-boundary probes supplement the real stdio client: a client alone
// cannot observe how much discarded output was retained before serialization.
for (const sample of ["😀".repeat(25000), '"\\\n'.repeat(35000)]) {
  const logs = new BoundedCapture();
  const errors = new BoundedCapture();
  for (let i = 0; i < 8; i++) { logs.append(sample); errors.append(sample); }
  const shared = { serializedBytes: 0, maxSerializedBytes: 80 };
  const boundedLogs = new BoundedCapture(65536, shared);
  const boundedErrors = new BoundedCapture(65536, shared);
  for (let i = 0; i < 10; i++) { boundedLogs.append('"\\\n😀'.repeat(100)); boundedErrors.append('"\\\n😀'.repeat(100)); }
  assert.ok(shared.serializedBytes <= 80);
  assert.ok(Buffer.byteLength(JSON.stringify([...boundedLogs.entries, ...boundedErrors.entries])) <= 84);
  assert.ok(boundedLogs.omittedCount > 0 && boundedErrors.omittedCount > 0);
  for (const collector of [logs, errors]) {
    assert.ok(collector.bytes <= 65536);
    assert.equal(Buffer.byteLength(collector.entries.join("")), collector.bytes);
    assert.ok(collector.omittedCount > 0);
    assert.ok(collector.entries.join("").length < sample.length * 8);
  }
}
const unicode = new BoundedCapture(7);
assert.equal(unicode.append("😀😀"), "😀");
assert.equal(unicode.bytes, 4);
assert.equal(unicode.omittedCount, 1);
assert.equal(unicode.append("éé"), "é");
assert.equal(unicode.bytes, 6);
const synthetic = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, text: '😀"\\\n'.repeat(10000) }));
const makePage = (page, meta) => ({ records: page, page: meta });
const syntheticSeen = [];
let syntheticCursor;
do {
  const p = paginate(synthetic, (item) => item.id, 8, syntheticCursor, makePage);
  assert.ok(Buffer.byteLength(JSON.stringify(p.payload)) <= 256 * 1024);
  syntheticSeen.push(...p.page.map((item) => item.id));
  syntheticCursor = p.meta.nextCursor;
} while (syntheticCursor);
assert.deepEqual(syntheticSeen, synthetic.map((item) => item.id));
const temp = mkdtempSync(join(tmpdir(), "pjan69-"));
const client = new Client({ name: "pjan69", version: "1" });
const transport = new StdioClientTransport({ command: "node", args: [join(root, "dist/mcp-server.js")], cwd: root, env: hermeticEnv({ PJ_PROJECT_REGISTRY: join(temp, "empty.yaml") }) });
await client.connect(transport);
try {
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  const ajv = new Ajv({ strict: false });
  const validate = new Map([...tools].map(([name, tool]) => [name, ajv.compile(tool.outputSchema)]));
  async function call(name, args, error = false) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, error, `${name}: ${result.content[0]?.text?.slice(0, 200)}`);
    if (result.structuredContent) {
      assert.ok(validate.get(name)(result.structuredContent), `${name}: ${ajv.errorsText(validate.get(name).errors)}`);
    }
    if (!error) {
      assert.ok(result.structuredContent, `${name}: successful result requires structured content`);
      assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 256 * 1024);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 256 * 1024);
    }
    return result;
  }
  const record = (slug, description = "") => ({ name: slug, slug, repo_path: join(temp, slug), description, status: "active", source_artifacts: [], template: { commonproject: { enabled: true, primary_language: "typescript" } }, ticket_provider: { type: "plane" }, agents: {}, created_at: "", updated_at: "" });
  const registryPath = join(temp, "projects.yaml");
  const records = Object.fromEntries(Array.from({ length: 510 }, (_, i) => {
    const slug = `p${String(509 - i).padStart(4, "0")}`;
    return [slug, record(slug)];
  }));
  writeFileSync(registryPath, YAML.stringify({ schema_version: 1, projects: records }));
  const name = "pjangler_project_list";
  const emptyRegistry = join(temp, "empty-registry.yaml");
  writeFileSync(emptyRegistry, YAML.stringify({ schema_version: 1, projects: {} }));
  const empty = (await call(name, { registryPath: emptyRegistry })).structuredContent;
  assert.deepEqual(empty.projects, {});
  assert.deepEqual(empty.slugs, []);
  assert.deepEqual(empty.page, { limit: 100, truncated: false, omittedCount: 0 });
  assert.equal(validate.get(name)({ ...empty, page: {} }), false, "metadata is required by the advertised schema");
  assert.equal(validate.get(name)({ ...empty, slugs: undefined }), false, "ordered slugs are required by the advertised schema");
  const mixedSlugs = ["2", "10", "1a", "01", "z", "0", "11"];
  writeFileSync(registryPath, YAML.stringify({ schema_version: 1, projects: Object.fromEntries(mixedSlugs.map((slug) => [slug, record(slug)])) }));
  const orderedSlugs = [...mixedSlugs].sort();
  for (const limit of [1, 2, 500]) {
    const seen = [];
    let next;
    do {
      const page = (await call(name, { registryPath, limit, ...(next ? { cursor: next } : {}) })).structuredContent;
      assert.deepEqual([...page.slugs].sort(), [...page.slugs]);
      assert.deepEqual(new Set(page.slugs), new Set(Object.keys(page.projects)));
      for (const slug of page.slugs) assert.equal(page.projects[slug].slug, slug);
      seen.push(...page.slugs);
      next = page.page.nextCursor;
    } while (next);
    assert.deepEqual(seen, orderedSlugs, `limit=${limit} must preserve code-point traversal`);
  }
  writeFileSync(registryPath, YAML.stringify({ schema_version: 1, projects: records }));
  const first = (await call(name, { registryPath })).structuredContent;
  assert.equal(Object.keys(first.projects).length, 100);
  assert.equal(first.page.omittedCount, 410);
  assert.equal(first.page.truncated, true);
  assert.deepEqual((await call(name, { registryPath })).structuredContent, first);
  assert.equal(Object.keys((await call(name, { registryPath, limit: 500 })).structuredContent.projects).length, 500);
  const observed = [];
  let cursor;
  do {
    const p = (await call(name, { registryPath, limit: 73, ...(cursor ? { cursor } : {}) })).structuredContent;
    observed.push(...Object.keys(p.projects));
    assert.equal(p.page.omittedCount, 510 - observed.length);
    cursor = p.page.nextCursor;
    assert.equal(p.page.truncated, Boolean(cursor));
  } while (cursor);
  assert.deepEqual(observed, Object.keys(records).sort());
  const huge = Object.fromEntries(Array.from({ length: 18 }, (_, i) => {
    const slug = `h${String(i).padStart(3, "0")}`;
    return [slug, record(slug, '😀"\\\n'.repeat(2600))];
  }));
  writeFileSync(registryPath, YAML.stringify({ schema_version: 1, projects: huge }));
  const bytePage = (await call(name, { registryPath, limit: 500 })).structuredContent;
  assert.ok(Object.keys(bytePage.projects).length < 18);
  const byteSeen = [];
  cursor = undefined;
  do {
    const p = (await call(name, { registryPath, limit: 500, ...(cursor ? { cursor } : {}) })).structuredContent;
    byteSeen.push(...Object.keys(p.projects));
    assert.equal(p.page.omittedCount, 18 - byteSeen.length);
    cursor = p.page.nextCursor;
  } while (cursor);
  assert.deepEqual(byteSeen, Object.keys(huge).sort());
  await call(name, { registryPath, cursor: "garbage" }, true);
  await call(name, { registryPath, cursor: first.page.nextCursor }, true);
  writeFileSync(registryPath, YAML.stringify({ schema_version: 1, projects: { oversize: record("oversize", "😀".repeat(100000)) } }));
  const oversize = await call(name, { registryPath }, true);
  assert.match(oversize.content[0].text, /First unreturned item exceeds/);
  for (const n of [0, -1, 1.2, 501, "100", null]) {
    const bad = await call(name, { registryPath, limit: n }, true);
    assert.match(bad.content[0].text, /-32602|invalid arguments/i);
  }
  const auditName = "pjangler_audit_project";
  const audited = (await call(auditName, { targetDir: temp, limit: 1 })).structuredContent;
  assert.equal(audited.rules.length, 1);
  const auditRepeat = (await call(auditName, { targetDir: temp, limit: 1 })).structuredContent;
  assert.deepEqual(auditRepeat.rules, audited.rules, "unchanged audit findings repeat; auditedAt marks each new run");
  assert.deepEqual(auditRepeat.page, audited.page);
  // auditedAt marks each new run; the cursor binds findings rather than time.
  assert.ok(typeof audited.auditedAt === "string");
  assert.equal(validate.get(auditName)({ ...audited, rules: [{}] }), false);
  const allAudit = [];
  cursor = undefined;
  do {
    const p = (await call(auditName, { targetDir: temp, limit: 1, ...(cursor ? { cursor } : {}) })).structuredContent;
    allAudit.push(...p.rules.map((r) => r.id));
    cursor = p.page.nextCursor;
    assert.equal(p.page.truncated, Boolean(cursor));
  } while (cursor);
  assert.deepEqual(allAudit, [...allAudit].sort());
  assert.equal(new Set(allAudit).size, allAudit.length);
  const formatted = await call(auditName, { targetDir: temp, json: false, limit: 1 });
  assert.ok(!formatted.content[0].text.startsWith("{"));
  const fullAudit = (await call(auditName, { targetDir: temp, limit: 500 })).structuredContent;
  assert.equal(fullAudit.page.truncated, false);
  assert.equal(fullAudit.page.omittedCount, 0);
  assert.equal(fullAudit.page.nextCursor, undefined);
  assert.deepEqual(fullAudit.rules.map((r) => r.id), allAudit);
  // Inflate real parity findings through supported waiver reasons; exercise the
  // audit byte boundary through stdio, not only the pagination helper.
  const failing = fullAudit.rules.filter((rule) => rule.status === "fail");
  assert.ok(failing.length >= 2, "fixture needs multiple actionable findings");
  writeFileSync(join(temp, ".project.json"), JSON.stringify({ parity: { waive: Object.fromEntries(failing.map((rule) => [rule.id, '😀"\\\n'.repeat(4000)])) } }));
  const byteAudit = (await call(auditName, { targetDir: temp, limit: 500, json: false })).structuredContent;
  assert.equal(byteAudit.page.truncated, true, "large real findings shorten the requested audit page");
  const byteAuditSeen = [];
  cursor = undefined;
  do {
    const p = (await call(auditName, { targetDir: temp, limit: 500, json: false, ...(cursor ? { cursor } : {}) })).structuredContent;
    byteAuditSeen.push(...p.rules.map((rule) => rule.id));
    cursor = p.page.nextCursor;
    assert.equal(p.page.omittedCount, fullAudit.rules.length - byteAuditSeen.length);
  } while (cursor);
  assert.deepEqual(byteAuditSeen, allAudit);
  rmSync(join(temp, ".project.json"));
  for (const n of [0, -2, 1.1, 501, "2", null]) {
    const bad = await call(auditName, { targetDir: temp, limit: n }, true);
    assert.match(bad.content[0].text, /-32602|invalid arguments/i);
  }
  await call(auditName, { targetDir: temp, cursor: "garbage" }, true);
  const recipeName = "pjangler_run_recipe";
  const target = join(temp, "recipe");
  mkdirSync(target);
  const preview = (await call(recipeName, { recipe: "node", targetDir: target })).structuredContent;
  assert.equal(preview.success, true);
  assert.equal(preview.dryRun, true);
  assert.ok(preview.logs.length);
  writeFileSync(join(target, "package.json"), "{}\n");
  const failure = (await call(recipeName, { recipe: "node", targetDir: target, apply: true }, true)).structuredContent;
  assert.equal(failure.success, false);
  assert.ok(failure.errors.length);
  assert.ok(failure.logs.length);
  for (const payload of [preview, failure]) {
    for (const field of ["logs", "errors"]) {
      assert.equal(payload.capture[field].retainedBytes, Buffer.byteLength(payload[field].join("")));
      assert.ok(payload.capture[field].retainedBytes <= 64 * 1024);
    }
  }
  const longTarget = join(temp, ...Array.from({ length: 16 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(243)}`));
  mkdirSync(longTarget, { recursive: true });
  const escapedTarget = join(temp, ...Array.from({ length: 15 }, (_, i) => `${String(i).padStart(2, "0")}${"\n".repeat(110)}`));
  mkdirSync(escapedTarget, { recursive: true });
  assert.ok(Buffer.byteLength(JSON.stringify(escapedTarget)) > Buffer.byteLength(escapedTarget));
  assert.ok(Buffer.byteLength(longTarget) > 3900);
  const nearCapTarget = join(temp, "near-cap");
  mkdirSync(nearCapTarget);
  for (const [kind, length, destination, apply, fail] of [
    ["ascii", 65451, nearCapTarget, false, false],
    ["ascii", 65452, nearCapTarget, true, false],
    ["ascii", 65536, nearCapTarget, false, true],
    ["unicode", 20000, nearCapTarget, false, true],
    ["nul", 65536, longTarget, false, false],
    ["nul", 65536, longTarget, true, false],
    ["nul", 65536, escapedTarget, false, true],
    ["nul", 65536, escapedTarget, true, true],
  ]) {
    const verboseClient = new Client({ name: "pjan69-verbose-client", version: "1" });
    const verboseTransport = new StdioClientTransport({ command: "node", args: [verboseServer], cwd: root, env: hermeticEnv({
      PJAN69_LOUD_KIND: kind, PJAN69_LOUD_LENGTH: String(length), PJAN69_LOUD_FAIL: fail ? "1" : "0",
    }) });
    await verboseClient.connect(verboseTransport);
    try {
      const response = await verboseClient.callTool({ name: recipeName, arguments: { recipe: "node", targetDir: destination, apply } });
      assert.equal(response.isError === true, fail, `${kind}/${length}/${apply}: ${response.content[0]?.text?.slice(0, 100)}`);
      const payload = response.structuredContent;
      assert.ok(payload && validate.get(recipeName)(payload), `${kind}/${length}/${apply}: ${ajv.errorsText(validate.get(recipeName).errors)}`);
      assert.equal(payload.success, !fail);
      assert.equal(payload.apply, apply);
      assert.equal(payload.targetDir, destination);
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 256 * 1024);
      assert.ok(Buffer.byteLength(response.content[0].text) <= 256 * 1024);
      for (const field of ["logs", "errors"]) {
        assert.equal(payload.capture[field].retainedBytes, Buffer.byteLength(payload[field].join("")));
        assert.ok(payload.capture[field].retainedBytes <= 64 * 1024);
      }
      if (kind === "nul") assert.ok(payload.capture.logs.omittedCount + payload.capture.errors.omittedCount > 0, `${kind}/${length}/${apply}/${fail} retained all output`);
      if (apply && !fail) assert.ok(existsSync(join(destination, "package.json")));
    } finally { await verboseClient.close(); }
  }
  const errorCases = [
    ["pjangler_describe_recipe", { recipe: "😀".repeat(80000) }],
    ["pjangler_audit_project", { targetDir: "/" + "é".repeat(150000) }],
    ["pjangler_migrate_project", { targetDir: "/" + "é".repeat(150000), all: true }],
    ["pjangler_bootstrap_33god_project", { projectName: "x", parentDir: "/" + "é".repeat(150000) }],
    ["pjangler_project_init", { name: "x", targetDir: "/" + "é".repeat(150000) }],
    ["pjangler_info", { targetDir: "/" + "é".repeat(150000) }],
    ["pjangler_project_list", { registryPath: emptyRegistry, cursor: "garbage" }],
    ["pjangler_project_show", { slug: "x".repeat(300000), registryPath: emptyRegistry }],
    ["pjangler_describe_project", { targetDir: "/" + "é".repeat(150000) }],
    ["pjangler_run_recipe", { recipe: "node", targetDir: "/" + "é".repeat(150000) }],
  ];
  for (const [tool, args] of errorCases) {
    const response = await call(tool, args, true);
    const text = response.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, `${tool} emitted ${Buffer.byteLength(text)} error bytes`);
    assert.ok(text.length > 0);
    if (["pjangler_describe_recipe", "pjangler_audit_project", "pjangler_migrate_project", "pjangler_bootstrap_33god_project", "pjangler_project_show", "pjangler_describe_project", "pjangler_run_recipe"].includes(tool)) assert.match(text, /truncated to MCP 256 KiB/, tool);
    assert.ok(!text.includes("\ufffd"), `${tool} split a multibyte character`);
  }
  console.log("PJAN-69 real MCP pagination and capture regressions passed");
} finally {
  await client.close();
  rmSync(temp, { recursive: true, force: true });
  rmSync(verboseFixture, { recursive: true, force: true });
  rmSync(verboseServer, { force: true });
}
