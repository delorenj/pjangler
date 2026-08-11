import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

// PJAN-49: `project init` built its copier command with no `--vcs-ref`. Whenever
// templates/commonproject resolves to a git repo *root* — a standalone clone, so
// `.git` is a directory rather than a submodule gitlink file — copier treats it as
// a VCS template and, absent a ref, checks out the latest PEP440 tag instead of the
// commit the superproject pins. Every template change since that tag then vanishes
// from generated projects, silently and with a zero exit code.
//
// These guards run the REAL copier against the REAL template repo and read the REAL
// files off disk. The control render (same command, ref stripped) is what keeps this
// honest: it proves the flag is load-bearing rather than decorative.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const templateDir = join(root, "templates", "commonproject");

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

function copier(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`copier failed (${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function answersCommit(target) {
  return YAML.parse(readFileSync(join(target, ".copier-answers.yml"), "utf8"))._commit;
}

const tmp = mkdtempSync(join(tmpdir(), "pjan-49-"));
try {
  // --- the flag is on the command pjangler actually executes ---
  const planned = JSON.parse(run([
    "project",
    "init",
    "RefPinned",
    "--target-dir",
    join(tmp, "RefPinned"),
    "--registry",
    join(tmp, "projects.yaml"),
    "--dry-run",
    "--json",
    "--no-tui",
  ]));
  const action = planned.actions.find((item) => item.kind === "copier.copy.commonproject");
  assert.ok(action, "project init must plan a copier.copy.commonproject action");
  assert.ok(
    action.command.includes("--vcs-ref=HEAD"),
    "the CommonProject copier command must pin --vcs-ref=HEAD or it renders the latest tag",
  );
  // Ordering contract: the ref is a copier option, so it must precede the positional
  // template/target pair rather than land among the trailing --data pairs.
  assert.ok(
    action.command.indexOf("--vcs-ref=HEAD") < action.command.indexOf(templateDir),
    "--vcs-ref=HEAD must come before the positional template path",
  );

  // --- materialize the template the way a fresh clone does: a standalone repo root,
  //     detached at the commit the superproject pins ---
  const pinned = git(templateDir, ["rev-parse", "HEAD"]);
  const templateGitDir = git(templateDir, ["rev-parse", "--absolute-git-dir"]);
  const templateTags = git(templateDir, ["tag", "--list"])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    templateTags.length > 0,
    "PJAN-49 infrastructure precondition failed: templates/commonproject has no real tag refs; " +
      "the checkout must fetch the published CommonProject tag history before this behavior regression runs",
  );
  let nearestPublishedTag;
  try {
    nearestPublishedTag = git(templateDir, ["describe", "--tags", "--abbrev=0", "HEAD"]);
  } catch (error) {
    throw new Error(
      "PJAN-49 infrastructure precondition failed: CommonProject tag refs exist but none are reachable " +
        "from the pinned template commit; fetch complete submodule history before diagnosing pjangler behavior",
      { cause: error },
    );
  }
  assert.ok(
    templateTags.includes(nearestPublishedTag),
    `PJAN-49 infrastructure precondition failed: nearest reachable tag ${nearestPublishedTag} is not a fetched tag ref`,
  );
  const repoRootTemplate = join(tmp, "commonproject");
  git(tmp, ["clone", "--quiet", templateGitDir, repoRootTemplate]);
  git(repoRootTemplate, ["checkout", "--quiet", "--detach", pinned]);
  assert.ok(
    existsSync(join(repoRootTemplate, ".git", "HEAD")),
    "the clone must expose .git as a directory — that is the shape that trips copier's VCS path",
  );
  let describePinned;
  try {
    describePinned = git(repoRootTemplate, ["describe", "--tags"]);
  } catch (error) {
    throw new Error(
      "PJAN-49 infrastructure precondition failed: the standalone CommonProject clone cannot describe the " +
        "pinned commit from real tag history; this is checkout/tag infrastructure, not a --vcs-ref behavior defect",
      { cause: error },
    );
  }

  // Reuse the planned command verbatim, only swapping in the repo-root template.
  const withRefTarget = join(tmp, "with-ref");
  const withRef = action.command.map((arg) => (arg === templateDir ? repoRootTemplate : arg));
  const withRefFinal = withRef.map((arg) => (arg === action.targetDir ? withRefTarget : arg));
  copier(withRefFinal, root);

  assert.equal(
    answersCommit(withRefTarget),
    describePinned,
    "the render must record the pinned commit, not whatever tag happens to be newest",
  );

  // --- the workflow, end to end, off disk ---
  const renderedPath = join(withRefTarget, ".github", "workflows", "code-review.yml");
  assert.ok(existsSync(renderedPath), "a repo-root template must still render .github/workflows/code-review.yml");
  const rendered = readFileSync(renderedPath, "utf8");
  assert.ok(rendered.includes("uses: anthropics/claude-code-action@v1"), "rendered workflow must pin the v1 action");
  assert.ok(
    rendered.includes("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"),
    "rendered workflow must carry the literal CLAUDE_CODE_OAUTH_TOKEN expression",
  );
  assert.doesNotMatch(rendered, /\{%/, "rendered workflow must contain no Jinja block tags");
  assert.doesNotMatch(rendered, /(?<!\$)\{\{/, "rendered workflow must contain no unrendered Jinja variables");
  assert.equal(
    YAML.parse(rendered).jobs["claude-review"].steps[1].uses,
    "anthropics/claude-code-action@v1",
    "rendered workflow must parse as YAML with the review step intact",
  );

  // --- the defect was never workflow-specific: post-tag template content at large ---
  const postTagFiles = [
    join(".mise", "scripts", "codegraph.sh"),
    join(".mise", "scripts", "hindsight-setup.sh"),
    join(".agents", "skills.json"),
  ];
  for (const relative of postTagFiles) {
    assert.ok(existsSync(join(withRefTarget, relative)), `pinned render must ship ${relative}`);
  }

  // --- control: strip the ref and the same command regresses ---
  // Skipped only if the pinned commit *is* the newest tag, where there is nothing to diverge.
  const taggedExactly = spawnSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: repoRootTemplate,
    encoding: "utf8",
  }).status === 0;
  if (taggedExactly) {
    console.log("pjan-49 regressions: control skipped (template HEAD is itself the newest tag)");
  } else {
    const controlTarget = join(tmp, "no-ref");
    const control = withRefFinal
      .filter((arg) => arg !== "--vcs-ref=HEAD")
      .map((arg) => (arg === withRefTarget ? controlTarget : arg));
    copier(control, root);
    assert.notEqual(
      answersCommit(controlTarget),
      describePinned,
      "without --vcs-ref the render must drift off the pinned commit — otherwise this guard proves nothing",
    );
    const drifted = postTagFiles
      .concat([join(".github", "workflows", "code-review.yml")])
      .filter((relative) => !existsSync(join(controlTarget, relative)));
    assert.ok(
      drifted.length > 0,
      "the ref-less render must drop post-tag template content — the regression this flag prevents",
    );
  }

  console.log("pjan-49 regressions: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
