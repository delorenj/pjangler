import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "src");
const boundary = "src/utils/child-process.ts";

function sourceFiles(directory) {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
}

const directChildProcessImports = sourceFiles(sourceRoot)
  .map((path) => ({
    path,
    relativePath: relative(root, path),
    source: readFileSync(path, "utf8"),
  }))
  .filter(({ relativePath, source }) =>
    relativePath !== boundary && /(?:node:)?child_process/.test(source))
  .map(({ relativePath }) => relativePath)
  .sort();

assert.deepEqual(
  directChildProcessImports,
  [],
  [
    "MCP-reachable subprocesses must cross src/utils/child-process.ts so inherited environments are hardened.",
    ...directChildProcessImports,
  ].join("\n"),
);

const boundarySource = readFileSync(join(root, boundary), "utf8");
assert.match(boundarySource, /hardenSubprocessEnvironment/);
assert.match(boundarySource, /export const spawnSync/);
assert.match(boundarySource, /export const spawn/);

console.log("PJAN-67 centralized child-process source gate: PASS");
