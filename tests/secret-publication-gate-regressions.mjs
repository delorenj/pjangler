import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const gate = join(root, "scripts", "check-tracked-secrets.mjs");
const repos = [];

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-secret-gate-${name}-`));
  repos.push(repo);
  const init = run("git", ["init", "--quiet"], repo);
  assert.equal(init.status, 0, init.stderr);
  return repo;
}

function track(repo, path, content) {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  const add = run("git", ["add", "--force", "--", path], repo);
  assert.equal(add.status, 0, add.stderr);
}

function check(repo) {
  return run(process.execPath, [gate], repo);
}

function syntheticJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: "regression-fixture", exp: 4102444800 }),
    "synthetic-signature-segment",
  ].join(".");
}

try {
  {
    const repo = makeRepo("jwt");
    const token = syntheticJwt();
    track(repo, "config.txt", `credential=${token}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "a tracked raw JWT must fail with status 1");
    assert.match(result.stderr, /"config\.txt": high-confidence raw JWT \(1\)/);
    assert.match(result.stderr, /Secret values are intentionally omitted/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  {
    const repo = makeRepo("review-artifact");
    const token = syntheticJwt();
    track(repo, "review.md", `captured token: ${token}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "a credential-bearing tracked review artifact must fail");
    assert.match(result.stderr, /"review\.md": high-confidence raw JWT/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  {
    const repo = makeRepo("jwt-path");
    const token = syntheticJwt();
    track(repo, `fixtures/${token}.txt`, "safe file contents\n");

    const result = check(repo);
    assert.equal(result.status, 1, "a raw JWT in a tracked path must fail");
    assert.match(result.stderr, /high-confidence raw JWT in tracked path/);
    assert.match(result.stderr, /\[REDACTED-JWT\]/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  {
    const repo = makeRepo("session-artifact");
    const literal = `opaque-${"credential".repeat(3)}`;
    track(repo, "sessions/example.jsonl", `Authorization: Bearer ${literal}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "a literal credential in a tracked session artifact must fail");
    assert.match(result.stderr, /literal credential in session\/review artifact/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(literal));
  }

  {
    const repo = makeRepo("safe-references");
    track(repo, ".npmrc", "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n");
    track(repo, ".env.op", "NPM_TOKEN=op://DeLoSecrets/NPM/token\n");
    track(repo, "review.md", "Authorization: Bearer ${REVIEW_TOKEN}\n");

    const result = check(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tracked-secret gate: PASS/);
  }

  {
    const repo = makeRepo("tracked-only");
    track(repo, "safe.txt", "no credentials here\n");
    writeFileSync(join(repo, "untracked.txt"), syntheticJwt());

    const result = check(repo);
    assert.equal(result.status, 0, "untracked runtime material is outside this publication gate");
  }

  {
    const repo = makeRepo("partial-staging");
    const token = syntheticJwt();
    track(repo, "index-secret.txt", token);
    writeFileSync(join(repo, "index-secret.txt"), "safe working tree\n");
    track(repo, "working-tree-secret.txt", "safe index\n");
    writeFileSync(join(repo, "working-tree-secret.txt"), token);

    const result = check(repo);
    assert.equal(result.status, 1, "both index and tracked working-tree content must be scanned");
    assert.match(result.stderr, /"index-secret\.txt": high-confidence raw JWT/);
    assert.match(
      result.stderr,
      /"working-tree-secret\.txt": high-confidence raw JWT in tracked working tree/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
} finally {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
}

console.log("secret publication gate regressions passed");
