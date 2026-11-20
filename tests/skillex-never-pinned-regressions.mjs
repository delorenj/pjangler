import "./helpers/hermetic-suite.mjs";
// Skillex is never pinned (2026-11-19): a per-repo mise version forks the skill
// engine. 28 repos carried npm:@delorenj/skillex 0.1.x pins in a retired
// skills:sync task, and intelliforia pinned it in [tools], which put a two-month-old
// skillex first on PATH there. The mise.config-root audit reports any such pin,
// top-level or inside any task; "latest" (or no entry at all) is the only pass.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `skillex-never-pinned-${process.pid}.mjs`);
buildSync({
  stdin: { contents: 'export { skillexPinIssues } from "./src/parity/rules";', resolveDir: root },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { skillexPinIssues } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const issues = (text) => skillexPinIssues(parseToml(text));

test("a skillex pin in [tools] is reported", () => {
  const found = issues('[tools]\n"npm:@delorenj/skillex" = { version = "0.1.3", allow_low_downloads = true }\n');
  assert.equal(found.length, 1);
  assert.match(found[0], /\[tools\] pins npm:@delorenj\/skillex to "0\.1\.3": Skillex is never pinned/);
});

test("a skillex pin inside any task is reported, string or table form", () => {
  const found = issues([
    '[tasks."skills:sync"]',
    'tools = { "npm:@delorenj/skillex" = { version = "0.1.1" }, node = "24" }',
    'run = "skillex sync"',
    '[tasks.other]',
    'tools = { "npm:@delorenj/skillex" = "0.4.4" }',
    'run = "true"',
  ].join("\n"));
  assert.deepEqual(found.map((line) => line.split(" pins ")[0]), ['tasks."skills:sync".tools', "tasks.\"other\".tools"]);
});

test("latest and absence pass", () => {
  assert.deepEqual(issues('[tools]\n"npm:@delorenj/skillex" = { version = "latest", allow_low_downloads = true }\nnode = "24"\n'), []);
  assert.deepEqual(issues('[tools]\nnode = "24"\n[tasks.x]\nrun = "skillex sync"\n'), []);
});
