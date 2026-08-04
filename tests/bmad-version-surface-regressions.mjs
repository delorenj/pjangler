import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const retiredVersion = ["6", "10", "2"].join(".");
const repositories = [{ root, prefix: "" }];

// Historical acceptance evidence is immutable and intentionally records the
// pack that was current when PJAN-29 ran. Active code/config under agents/ is
// deliberately not excluded.
const historicalEvidence = /^_bmad-output\/implementation-artifacts\/issue-evidence\//;

function trackedFiles(repository) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "buffer",
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

const stale = [];
for (const repository of repositories) {
  for (const relative of trackedFiles(repository.root)) {
    if (!repository.prefix && historicalEvidence.test(relative)) continue;
    const path = join(repository.root, relative);
    // A tracked path can be absent from the worktree (a deletion that has not
    // been staged yet). There is no content to scan, so it cannot be stale.
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (!text.includes(retiredVersion)) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(retiredVersion)) {
        stale.push(`${repository.prefix}${relative}:${index + 1}`);
      }
    }
  }
}

assert.deepEqual(
  stale,
  [],
  `retired BMAD ${retiredVersion} remains in active/default candidate surfaces:\n${stale.join("\n")}`
);
console.log("BMAD active/default version surface regressions passed");
