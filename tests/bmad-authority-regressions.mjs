import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bmadRoot = resolve(root, "_bmad");
const forbiddenPaths = [];

function collectForbiddenPaths(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const repositoryPath = relative(root, path).replaceAll("\\", "/");

    if (repositoryPath.toLowerCase().includes("ticket-lifecycle")) {
      forbiddenPaths.push(repositoryPath);
    }

    if (entry.isDirectory()) {
      collectForbiddenPaths(path);
    }
  }
}

collectForbiddenPaths(bmadRoot);
assert.deepEqual(
  forbiddenPaths,
  [],
  `PJAN-27: the PJangler-owned _bmad tree must not contain a ticket-lifecycle workflow: ${forbiddenPaths.join(", ")}`,
);

for (const manifest of [
  "_bmad/_config/workflow-manifest.csv",
  "_bmad/_config/files-manifest.csv",
]) {
  assert.equal(existsSync(resolve(root, manifest)), true, `${manifest} must exist`);
  const registrations = readFileSync(resolve(root, manifest), "utf8")
    .split(/\r?\n/)
    .filter((row) => row.toLowerCase().includes("ticket-lifecycle"));

  assert.deepEqual(
    registrations,
    [],
    `${manifest} must not register PJangler as a ticket lifecycle engine`,
  );
}

console.log("BMAD authority regressions passed (0 workflow paths, 0 manifest registrations)");
