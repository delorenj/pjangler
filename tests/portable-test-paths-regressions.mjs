import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testsRoot = join(root, "tests");
const releaseTestName = /-regressions\.(?:mjs|ts)$/;
const machineHomePath = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;

function releaseTestSources(directory) {
  const sources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...releaseTestSources(path));
    } else if (entry.isFile() && releaseTestName.test(entry.name)) {
      sources.push(path);
    }
  }
  return sources;
}

const violations = [];
for (const path of releaseTestSources(testsRoot)) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(machineHomePath)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(root, path)}:${line}: ${match[0]}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `release regressions contain machine-specific home paths:\n${violations.join("\n")}`,
);

console.log("portable release-test path regressions passed");
