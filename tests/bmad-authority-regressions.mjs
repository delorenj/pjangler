import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const commonProjectRoot = resolve(root, "templates", "commonproject");
const bmadRoots = [
  resolve(root, "_bmad"),
  resolve(commonProjectRoot, "_bmad"),
];
const forbiddenWorkflowRoots = [
  "_bmad/custom/workflows/ticket-lifecycle",
  "_bmad/_config/custom/custom/workflows/ticket-lifecycle",
  "templates/commonproject/_bmad/custom/workflows/ticket-lifecycle",
  "templates/commonproject/_bmad/_config/custom/custom/workflows/ticket-lifecycle",
];
const forbiddenCliSurfaces = [
  "templates/commonproject/.augment/commands/bmad/workflows/custom-ticket-lifecycle.md",
  "templates/commonproject/.claude/commands/bmad/custom/workflows/ticket-lifecycle.md",
  "templates/commonproject/.gemini/commands/bmad-workflow-custom-ticket-lifecycle.toml",
  "templates/commonproject/.opencode/command/bmad-custom-ticket-lifecycle.md",
];
const forbiddenPaths = [];
const lifecyclePattern = /ticket[-_ ]?lifecycle/i;

function collectForbiddenPaths(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const repositoryPath = relative(root, path).replaceAll("\\", "/");

    if (lifecyclePattern.test(repositoryPath)) {
      forbiddenPaths.push(repositoryPath);
    }

    if (entry.isDirectory()) {
      collectForbiddenPaths(path);
    }
  }
}

for (const workflowRoot of forbiddenWorkflowRoots) {
  assert.equal(
    existsSync(resolve(root, workflowRoot)),
    false,
    `PJAN-27: forbidden lifecycle workflow root returned: ${workflowRoot}`,
  );
}

for (const bmadRoot of bmadRoots) {
  assert.equal(existsSync(bmadRoot), true, `BMAD tree must exist: ${relative(root, bmadRoot)}`);
  collectForbiddenPaths(bmadRoot);
}

assert.deepEqual(
  forbiddenPaths,
  [],
  `PJAN-27: PJangler and pinned CommonProject BMAD trees must not contain lifecycle residue: ${forbiddenPaths.join(", ")}`,
);

for (const cliSurface of forbiddenCliSurfaces) {
  assert.equal(
    existsSync(resolve(root, cliSurface)),
    false,
    `PJAN-27: forbidden CommonProject CLI lifecycle surface returned: ${cliSurface}`,
  );
}

for (const manifest of [
  "_bmad/_config/workflow-manifest.csv",
  "_bmad/_config/files-manifest.csv",
  "templates/commonproject/_bmad/_config/workflow-manifest.csv",
  "templates/commonproject/_bmad/_config/files-manifest.csv",
]) {
  assert.equal(existsSync(resolve(root, manifest)), true, `${manifest} must exist`);
  const registrations = readFileSync(resolve(root, manifest), "utf8")
    .split(/\r?\n/)
    .filter((row) => lifecyclePattern.test(row));

  assert.deepEqual(
    registrations,
    [],
    `${manifest} must not register PJangler as a ticket lifecycle engine`,
  );
}

const commonProjectGuard = resolve(commonProjectRoot, ".scripts", "check-authority-parity.sh");
assert.equal(existsSync(commonProjectGuard), true, "pinned CommonProject authority guard must exist");
const guardResult = spawnSync("bash", [commonProjectGuard, commonProjectRoot], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(
  guardResult.status,
  0,
  `pinned CommonProject authority guard failed\nstdout:\n${guardResult.stdout}\nstderr:\n${guardResult.stderr}`,
);

console.log(
  "BMAD authority regressions passed (0 workflow paths, 0/4 CLI surfaces, 0 manifest registrations, nested guard 5/5)",
);
