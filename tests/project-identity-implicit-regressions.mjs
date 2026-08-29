// `pj project identity` with no argument means "this project".
//
// It used to throw `pass a project slug, an agent id, or --all` from inside a
// project directory, while `pj board` and `pj describe` had resolved the
// current project from cwd all along — boardQuery.ts even has a section titled
// "Implicit project resolution". The verb simply never called it.
//
// The resolution rule that matters: the slug comes from `.project.json`'s
// `project_slug`, NOT the directory name. bloodbank lives in a directory called
// `bloodbank` and is registered as `bb`; a dirname-based shortcut would look
// correct there and target nothing.
//
// Hermetic: every credential is blanked, so the reconciler cannot reach a
// provider. These assertions are about which target got selected, not about
// what a provider said.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");
const cleanup = [];
let failures = 0;

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `pj-implicit-${prefix}-`));
  cleanup.push(dir);
  return dir;
}

/** No credential may resolve, so nothing here can reach Plane or Trello. */
const NO_CREDENTIALS = {
  PLANE_API_KEY: "",
  PLANE_33GOD_API_KEY: "",
  TRELLO_KEY: "",
  TRELLO_TOKEN: "",
  OP_SERVICE_ACCOUNT_TOKEN: "",
};

function cli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...NO_CREDENTIALS, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Which project records did the run actually target? */
function targeted(run) {
  const start = run.stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const report = JSON.parse(run.stdout.slice(start));
    return (report.projects ?? []).map((p) => p.slug);
  } catch {
    return null;
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// A project whose slug deliberately differs from its directory name.
const workspace = makeDir("ws");
const projectRoot = join(workspace, "some-long-directory-name");
const nested = join(projectRoot, "packages", "deep");
mkdirSync(nested, { recursive: true });
writeFileSync(
  join(projectRoot, ".project.json"),
  `${JSON.stringify(
    {
      project_name: "Implicit Probe",
      project_slug: "implicit-probe",
      repo_path: projectRoot,
      ticket_provider: { type: "plane", workspace: "33god", identifier: "IMPL", board_id: "", state: "planned" },
      agents: {},
    },
    null,
    2,
  )}\n`,
);

const registry = join(makeDir("registry"), "projects.yaml");
writeFileSync(
  registry,
  [
    "schema_version: 1",
    "projects:",
    "  implicit-probe:",
    "    name: Implicit Probe",
    "    slug: implicit-probe",
    `    repo_path: ${projectRoot}`,
    "    description: ''",
    "    status: planned",
    "    source_artifacts: []",
    "    template:",
    "      commonproject:",
    "        enabled: true",
    "        primary_language: python",
    "    ticket_provider:",
    "      type: plane",
    "      workspace: 33god",
    "      identifier: IMPL",
    "      identifier_source: proposed",
    "      board_id: ''",
    "      state: planned",
    "    agents: {}",
    "    created_at: '2026-08-29T00:00:00Z'",
    "    updated_at: '2026-08-29T00:00:00Z'",
    "",
  ].join("\n"),
);

const base = ["project", "identity", "--json", "--registry", registry];

test("no argument, at the project root, resolves this project", () => {
  const run = cli(base, projectRoot);
  assert.deepEqual(targeted(run), ["implicit-probe"], `${run.stdout}${run.stderr}`);
});

test("the slug comes from the manifest, not the directory name", () => {
  const run = cli(base, projectRoot);
  const hit = targeted(run);
  assert.deepEqual(hit, ["implicit-probe"]);
  assert.ok(
    !hit.includes("some-long-directory-name"),
    "a dirname-based shortcut would target a slug that is not in the registry",
  );
});

test("no argument, from a nested subdirectory, walks up to the project root", () => {
  const run = cli(base, nested);
  assert.deepEqual(targeted(run), ["implicit-probe"], `${run.stdout}${run.stderr}`);
});

test("an explicit slug still wins over cwd", () => {
  const run = cli([...base, "implicit-probe"], workspace);
  assert.deepEqual(targeted(run), ["implicit-probe"], `${run.stdout}${run.stderr}`);
});

test("outside any project it fails, and names both ways out", () => {
  const run = cli(base, workspace);
  assert.notEqual(run.status, 0, "must not silently succeed with no target");
  const out = run.stdout + run.stderr;
  assert.match(out, /not inside a pjangler project/);
  assert.match(out, /--all/, "the message must offer --all as the escape hatch");
});

test("--all still works from outside a project", () => {
  const run = cli([...base, "--all"], workspace);
  assert.doesNotMatch(
    run.stdout + run.stderr,
    /not inside a pjangler project/,
    "--all must never require a cwd project",
  );
});

console.log("");
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`project identity implicit regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("project identity implicit regressions passed");
