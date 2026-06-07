import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, lstatSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");

function run(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (!result.stdout.trim()) {
    throw new Error(`command produced no stdout: node ${cli} ${args.join(" ")}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-${name}-`));
  writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\"]\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function assertAgentSymlinks(repo) {
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const full = join(repo, file);
    assert.equal(lstatSync(full).isSymbolicLink(), true, `${file} should be a symlink`);
    assert.equal(readlinkSync(full), "AGENTS.md");
  }
}

const repos = [];
try {
  {
    const repo = makeRepo("link-script");
    repos.push(repo);
    run(["migrate", "mise.config-root", repo, "--json"]);
    run(["migrate", "sot.agent-symlinks", repo, "--json"]);

    const script = join(repo, ".mise", "scripts", "link-agentfiles.sh");
    assert.equal(existsSync(script), true, "migrate must copy .mise/scripts/link-agentfiles.sh");
    assert.match(readFileSync(script, "utf8"), /AI agent symlinks verified/);
    assertAgentSymlinks(repo);
  }

  {
    const repo = makeRepo("path-parity");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\", \"bin\"]\n");
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /_\.path = \["\.mise\/scripts", "bin", "agents\/hermes\/pm"\]/, "mise.toml _.path should include agents/hermes/pm and preserve existing entries");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"]));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  {
    const repo = makeRepo("hermes-executable-path");
    repos.push(repo);
    mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
    writeFileSync(join(repo, "agents", "hermes", "pm", "hermes"), "#!/usr/bin/env bash\necho hermes\n");
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /agents\/hermes\/pm\/hermes/, "mise.toml _.path should include agents/hermes/pm/hermes when that executable exists");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"]));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  console.log("parity migrate regressions passed");
} finally {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
}
