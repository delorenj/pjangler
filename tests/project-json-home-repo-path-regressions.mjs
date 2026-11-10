import "./helpers/hermetic-suite.mjs";
// A multi-peer repo commits `.project.json` with a home-relative `repo_path`
// (`~/code/33GOD/bloodbank`): the same manifest is then true on every host whose
// checkout sits at the same place under its own home. `sot.project-json` used to
// compare the field to the absolute repo root byte for byte, so it failed that
// manifest on every host and `migrate` "fixed" it by writing this host's
// absolute path — which made the committed file wrong on all the others.
//
// The rule now accepts `~` / `~/…` when it expands, under this host's home, to
// the repo root, and migrate keeps that spelling. A home-relative path that
// names some OTHER directory is still drift, and still fixable.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pj-home-repo-path-"));
process.env.GIT_CEILING_DIRECTORIES = workspace;
// Bundles land inside the repo so `--packages=external` resolves node_modules
// (see tests/pjan-75-regressions.mjs).
const buildDir = mkdtempSync(join(root, ".home-repo-path-build-"));
process.on("exit", () => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const common = { bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" };
const rulesBundle = join(buildDir, "rules.mjs");
buildSync({ ...common, entryPoints: [join(root, "src", "parity", "rules.ts")], outfile: rulesBundle });
const cli = join(buildDir, "cli.mjs");
buildSync({ ...common, entryPoints: [join(root, "src", "index.ts")], outfile: cli });
const { repoPathNamesRoot } = await import(pathToFileURL(rulesBundle).href);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}

check("repoPathNamesRoot accepts the absolute root and home-relative spellings of it", () => {
  const home = join(workspace, "unit-home");
  const repo = join(home, "code", "proj");
  assert.equal(repoPathNamesRoot(repo, repo, home), true, "absolute root");
  assert.equal(repoPathNamesRoot("~/code/proj", repo, home), true, "~/ spelling");
  assert.equal(repoPathNamesRoot("~/code/proj/", repo, home), true, "trailing slash");
  assert.equal(repoPathNamesRoot("~", home, home), true, "bare ~ names the home itself");
  assert.equal(repoPathNamesRoot("~/code/other", repo, home), false, "a different directory under home");
  assert.equal(repoPathNamesRoot("~other/code/proj", repo, home), false, "~user is not expanded");
  assert.equal(repoPathNamesRoot("code/proj", repo, home), false, "a relative path is not the root");
  assert.equal(repoPathNamesRoot("/elsewhere/code/proj", repo, home), false, "another absolute path");
  assert.equal(repoPathNamesRoot(undefined, repo, home), false, "missing");
  assert.equal(repoPathNamesRoot(42, repo, home), false, "not a string");
  assert.equal(repoPathNamesRoot("~/code/proj", repo, ""), false, "no home: nothing to expand against");
});

function fixture(name, repoPath) {
  const home = join(workspace, name, "home");
  const repoRoot = join(home, "code", "proj");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".project.json"),
    `${JSON.stringify(
      {
        project_name: "Proj",
        project_description: "",
        project_id: "proj",
        repo_path: repoPath,
        ticket_provider: { type: "plane", workspace: "33god", identifier: "proj", board_id: "b", state: "linked" },
        agents: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { home, repoRoot };
}

function json(args, home) {
  const result = spawnSync("node", [cli, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: hermeticEnv({ HOME: home, GIT_CEILING_DIRECTORIES: workspace, NO_COLOR: "1" }),
  });
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`expected JSON from \`${args.join(" ")}\`\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${err}`);
  }
}
const rule = (report) => report.rules.find((entry) => entry.id === "sot.project-json");
const repoPathOf = (repoRoot) => JSON.parse(readFileSync(join(repoRoot, ".project.json"), "utf8")).repo_path;

check("audit passes a home-relative repo_path that names the repo, and migrate keeps it", () => {
  const { home, repoRoot } = fixture("tilde", "~/code/proj");
  const audit = rule(json(["audit", repoRoot], home));
  assert.equal(audit.status, "pass", `expected pass, got ${audit.status}: ${JSON.stringify(audit.details)}`);
  json(["migrate", "sot.project-json", repoRoot], home);
  assert.equal(repoPathOf(repoRoot), "~/code/proj", "migrate must not rewrite a portable spelling to this host's path");
});

check("audit still fails a home-relative repo_path that names another directory, and migrate fixes it", () => {
  const { home, repoRoot } = fixture("tilde-wrong", "~/code/elsewhere");
  const before = rule(json(["audit", repoRoot], home));
  assert.equal(before.status, "fail");
  assert.ok(before.details.includes(`repo_path should be ${repoRoot}`), JSON.stringify(before.details));
  json(["migrate", "sot.project-json", repoRoot], home);
  assert.equal(repoPathOf(repoRoot), repoRoot);
  assert.equal(rule(json(["audit", repoRoot], home)).status, "pass");
});

check("the absolute repo_path keeps passing unchanged", () => {
  const { home, repoRoot } = fixture("absolute", null);
  const manifest = JSON.parse(readFileSync(join(repoRoot, ".project.json"), "utf8"));
  manifest.repo_path = repoRoot;
  writeFileSync(join(repoRoot, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.equal(rule(json(["audit", repoRoot], home)).status, "pass");
  json(["migrate", "sot.project-json", repoRoot], home);
  assert.equal(repoPathOf(repoRoot), repoRoot);
});

if (failures.length) {
  console.error(`home-relative repo_path regressions: ${failures.length} failed`);
  process.exit(1);
}
console.log("home-relative repo_path regressions passed");
