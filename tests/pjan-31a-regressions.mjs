import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { createBmadInstallerFixture, createSkillPackFixture } from "./helpers/pack-fixture.mjs";

// PJAN-31a: the CommonProject template shipped no .github at all, so no project
// pjangler created ever got PR review. These guards render a REAL project with
// the REAL CLI and assert against the file on disk — the only way to catch the
// Jinja/Actions `${{ }}` delimiter collision, which renders to an empty string
// instead of failing loudly.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const templateWorkflow = join(
  root,
  "templates",
  "commonproject",
  "template",
  ".github",
  "workflows",
  "code-review.yml.jinja",
);
let lifecycleEnv = {};

function run(args, env = {}, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...lifecycleEnv, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), "pjan-31a-"));
try {
  const homeDir = join(tmp, "home");
  const fixtureRoot = join(tmp, "bmad-fixtures");
  lifecycleEnv = {
    HOME: homeDir,
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    PJ_AGENT_HOOKS_LAYER: "0",
    PJ_PACK_ROOT_PJTEST: createSkillPackFixture(fixtureRoot),
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(fixtureRoot),
    npm_config_cache: join(tmp, "empty-npm-cache"),
    npm_config_offline: "true",
  };
  // --- template source: the raw-block wrapping is the whole defect surface ---
  assert.ok(existsSync(templateWorkflow), "CommonProject template must ship .github/workflows/code-review.yml.jinja");
  const source = readFileSync(templateWorkflow, "utf8");
  for (const expression of [
    "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "${{ github.repository }}",
    "${{ github.event.pull_request.number }}",
  ]) {
    assert.ok(source.includes(expression), `template must carry the GitHub expression ${expression}`);
  }
  // Strip every raw block; whatever GitHub expression is left would be eaten by
  // Jinja (`{{ ... }}` -> undefined -> empty string) instead of erroring.
  const outsideRawBlocks = source.split(/\{%\s*raw\s*%\}[\s\S]*?\{%\s*endraw\s*%\}/).join("");
  assert.doesNotMatch(
    outsideRawBlocks,
    /\$\{\{/,
    "every ${{ ... }} in the template must be wrapped in {% raw %}...{% endraw %}",
  );

  // --- real render through the real CLI ---
  const targetDir = join(tmp, "ReviewedProject");
  const applied = JSON.parse(run([
    "project",
    "init",
    "ReviewedProject",
    "--description",
    "PJAN-31a rendered code-review workflow coverage",
    "--target-dir",
    targetDir,
    "--registry",
    join(tmp, "projects.yaml"),
    // Rendered-workflow coverage; no board is wanted or reachable here.
    "--skip-board",
    "--apply",
    "--json",
  ]));
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));

  const renderedPath = join(targetDir, ".github", "workflows", "code-review.yml");
  assert.ok(existsSync(renderedPath), "every rendered project must get .github/workflows/code-review.yml");
  const rendered = readFileSync(renderedPath, "utf8");

  // Literal survival of the GitHub expressions through Jinja rendering.
  assert.ok(rendered.includes("uses: anthropics/claude-code-action@v1"), "rendered workflow must pin the v1 action");
  assert.ok(
    rendered.includes("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"),
    "rendered workflow must authenticate with the literal CLAUDE_CODE_OAUTH_TOKEN secret expression",
  );
  assert.ok(
    rendered.includes("${{ github.repository }}/pull/${{ github.event.pull_request.number }}"),
    "rendered prompt must resolve the PR from the generated repo's own GitHub context",
  );

  // No Jinja may survive into the generated repo.
  assert.doesNotMatch(rendered, /\{%/, "rendered workflow must contain no Jinja block tags");
  assert.doesNotMatch(rendered, /(?<!\$)\{\{/, "rendered workflow must contain no unrendered Jinja variables");

  // Valid YAML with the contracted trigger, permissions, and steps.
  const workflow = YAML.parse(rendered);
  assert.deepEqual(
    workflow.on.pull_request.types,
    ["opened", "synchronize", "ready_for_review", "reopened"],
    "review must fire on the four PR lifecycle events",
  );
  assert.equal(workflow.on.pull_request_target, undefined, "pull_request_target would leak secrets to fork PRs");
  const job = workflow.jobs["claude-review"];
  assert.deepEqual(job.permissions, {
    contents: "read",
    "pull-requests": "read",
    issues: "read",
    "id-token": "write",
  });
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(job.steps[1].uses, "anthropics/claude-code-action@v1");
  assert.equal(job.steps[1].with.claude_code_oauth_token, "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");

  // Unconditional: no copier question gates the workflow.
  const copierYml = readFileSync(join(root, "templates", "commonproject", "copier.yml"), "utf8");
  assert.doesNotMatch(copierYml, /code[_-]?review/i, "the code-review workflow must not be gated behind a copier question");

  // Documented: the secret is a hard prerequisite, so the README must say so.
  const readme = readFileSync(join(root, "templates", "commonproject", "README.md"), "utf8");
  assert.match(readme, /CLAUDE_CODE_OAUTH_TOKEN/, "CommonProject README must document the required repo secret");

  console.log("pjan-31a regressions: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
