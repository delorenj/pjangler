import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return result;
}

/** Resolve a submodule commit from the parent HEAD tree, never its worktree. */
export function committedSubmoduleGitlink(parentRoot, submodulePath) {
  const tree = runGit(parentRoot, ["ls-tree", "HEAD", "--", submodulePath]).stdout;
  const match = tree.match(/^160000 commit ([0-9a-f]{40})\t(.+)\s*$/);
  if (!match || match[2] !== submodulePath) {
    throw new Error(`HEAD does not contain an exact ${submodulePath} gitlink: ${tree}`);
  }
  return match[1];
}

/** Read one exact blob from a Git object, ignoring every worktree byte. */
export function readGitCommitFile(repositoryRoot, commit, path) {
  return runGit(repositoryRoot, ["show", `${commit}:${path}`]).stdout;
}

export function readCommittedSubmoduleFile(parentRoot, submodulePath, path) {
  const gitlink = committedSubmoduleGitlink(parentRoot, submodulePath);
  return {
    gitlink,
    content: readGitCommitFile(join(parentRoot, submodulePath), gitlink, path),
  };
}

/**
 * Materialize an exact commit through `git archive`. Uncommitted or advanced
 * bytes in repositoryRoot's worktree are therefore structurally unreachable.
 */
export function materializeGitCommit(repositoryRoot, commit, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = runGit(repositoryRoot, ["archive", "--format=tar", commit], { encoding: null }).stdout;
  const extract = spawnSync("tar", ["-xf", "-", "-C", destination], {
    input: archive,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extract.status !== 0) {
    throw new Error(`failed to extract ${commit} into ${destination}: ${extract.stderr || extract.error?.message || `exit ${extract.status}`}`);
  }
}

export function materializeCommittedSubmodule(parentRoot, submodulePath, destination) {
  const gitlink = committedSubmoduleGitlink(parentRoot, submodulePath);
  materializeGitCommit(join(parentRoot, submodulePath), gitlink, destination);
  return gitlink;
}
