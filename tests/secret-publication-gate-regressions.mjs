import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const gate = join(root, "scripts", "check-tracked-secrets.mjs");
const repos = [];

function run(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
  });
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-secret-gate-${name}-`));
  repos.push(repo);
  const init = run("git", ["init", "--quiet"], repo);
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: `fixture-${name}`, version: "1.0.0", files: ["publishable"] }, null, 2)}\n`,
  );
  const add = run("git", ["add", "--force", "--", "package.json"], repo);
  assert.equal(add.status, 0, add.stderr);
  return repo;
}

function track(repo, path, content) {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  const add = run("git", ["add", "--force", "--", path], repo);
  assert.equal(add.status, 0, add.stderr);
}

function check(repo, env = process.env) {
  return run(process.execPath, [gate], repo, { env });
}

function syntheticJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: "regression-fixture", exp: 4102444800 }),
    "synthetic-signature-segment",
  ].join(".");
}

function assertValueOmitted(result, value) {
  assert.doesNotMatch(
    result.stdout + result.stderr,
    new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

function hashBlob(repo, content) {
  const result = run("git", ["hash-object", "-w", "--stdin"], repo, { input: content });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const projectPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.match(
  projectPackage.scripts.test,
  /(?:^|&&\s*)npm run check:tracked-secrets(?:\s*&&|$)/,
  "the standard test surface must run the tracked-secret gate",
);
assert.match(
  projectPackage.scripts.prepublishOnly,
  /(?:^|&&\s*)npm run check:tracked-secrets(?:\s*&&|$)/,
  "prepublishOnly must run the tracked-secret gate",
);

try {
  {
    const repo = makeRepo("jwt");
    const token = syntheticJwt();
    track(repo, "config.txt", `credential=${token}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "a tracked raw JWT must fail with status 1");
    assert.match(result.stderr, /"config\.txt": high-confidence raw JWT \(1\)/);
    assert.match(result.stderr, /Secret values are intentionally omitted/);
    assertValueOmitted(result, token);
  }

  {
    const repo = makeRepo("hostile-boundary");
    const token = syntheticJwt();
    track(repo, `fixtures/_${token}_suffix.txt`, "safe file contents\n");

    const result = check(repo);
    assert.equal(result.status, 1, "an underscore-adjacent JWT in a tracked path must fail");
    assert.match(result.stderr, /high-confidence raw JWT in tracked path/);
    assert.match(result.stderr, /\[REDACTED-JWT\]/);
    assertValueOmitted(result, token);
  }

  {
    const repo = makeRepo("unmerged-index");
    const token = syntheticJwt();
    const base = hashBlob(repo, "safe base\n");
    const ours = hashBlob(repo, token);
    const theirs = hashBlob(repo, "safe alternate\n");
    const indexInfo = [
      `100644 ${base} 1\tconflict.txt`,
      `100644 ${ours} 2\tconflict.txt`,
      `100644 ${theirs} 3\tconflict.txt`,
      "",
    ].join("\n");
    const update = run("git", ["update-index", "--index-info"], repo, { input: indexInfo });
    assert.equal(update.status, 0, update.stderr);

    const result = check(repo);
    assert.equal(result.status, 2, "an unmerged index must fail closed with status 2");
    assert.match(result.stderr, /unmerged Git index entry/);
    assertValueOmitted(result, token);
  }

  {
    const repo = makeRepo("package-gitlink");
    const submodule = mkdtempSync(join(tmpdir(), "pjangler-secret-gate-submodule-"));
    repos.push(submodule);
    assert.equal(run("git", ["init", "--quiet"], submodule).status, 0);
    assert.equal(run("git", ["config", "user.email", "fixture@example.invalid"], submodule).status, 0);
    assert.equal(run("git", ["config", "user.name", "Fixture"], submodule).status, 0);
    const token = syntheticJwt();
    track(submodule, "published.txt", token);
    assert.equal(run("git", ["commit", "--quiet", "-m", "fixture"], submodule).status, 0);
    const add = run(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        submodule,
        "publishable/template",
      ],
      repo,
    );
    assert.equal(add.status, 0, add.stderr);

    const result = check(repo);
    assert.equal(result.status, 1, "a JWT in a publishable populated gitlink must fail");
    assert.match(result.stderr, /npm package payload/);
    assertValueOmitted(result, token);
  }

  {
    const repo = makeRepo("working-read-failure");
    track(repo, "blocked.txt", "safe indexed content\n");
    rmSync(join(repo, "blocked.txt"));
    mkdirSync(join(repo, "blocked.txt"));

    const result = check(repo);
    assert.equal(result.status, 2, "a tracked working-tree read failure must return status 2");
    assert.match(result.stderr, /tracked working-tree content could not be scanned/);
    assert.match(result.stderr, /Secret values are intentionally omitted/);
  }

  {
    const notARepo = mkdtempSync(join(tmpdir(), "pjangler-secret-gate-no-git-"));
    repos.push(notARepo);
    const result = check(notARepo, {
      ...process.env,
      GIT_CEILING_DIRECTORIES: dirname(notARepo),
    });
    assert.equal(result.status, 2, "Git enumeration failure must return status 2");
    assert.match(result.stderr, /unable to enumerate the Git index/);
    assert.doesNotMatch(result.stderr, /fatal:/i, "raw Git diagnostics must remain suppressed");
  }

  {
    const repo = makeRepo("unquoted-assignment");
    const literal = `opaque-${"credential".repeat(3)}`;
    track(repo, "sessions/example.jsonl", `api_key=${literal}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "an unquoted literal credential must fail");
    assert.match(result.stderr, /literal credential in session\/review artifact/);
    assertValueOmitted(result, literal);
  }

  {
    const repo = makeRepo("review-name-variants");
    const upperLiteral = `opaque-${"upper".repeat(4)}`;
    const ticketLiteral = `opaque-${"ticket".repeat(4)}`;
    track(repo, "REVIEW.md", `api_key=${upperLiteral}\n`);
    track(repo, "PJAN-99.review.md", `client_secret=${ticketLiteral}\n`);

    const result = check(repo);
    assert.equal(result.status, 1, "case and ticket-prefixed review artifacts must be sensitive");
    assert.match(result.stderr, /"REVIEW\.md": literal credential in session\/review artifact/);
    assert.match(
      result.stderr,
      /"PJAN-99\.review\.md": literal credential in session\/review artifact/,
    );
    assertValueOmitted(result, upperLiteral);
    assertValueOmitted(result, ticketLiteral);
  }

  {
    const repo = makeRepo("punctuated-unquoted-values");
    const dotted = `opaque.${"credential".repeat(3)}`;
    const colon = `opaque:${"credential".repeat(3)}`;
    const escaped = `opaque\\${"credential".repeat(3)}`;
    track(
      repo,
      "PJAN-99.review.md",
      [
        `api_key=${dotted}`,
        `Authorization: Bearer ${colon}`,
        `client_secret=${escaped}`,
        "",
      ].join("\n"),
    );

    const result = check(repo);
    assert.equal(result.status, 1, "punctuation must not exempt complete unquoted credentials");
    assert.match(result.stderr, /literal credential in session\/review artifact \(3\)/);
    assertValueOmitted(result, dotted);
    assertValueOmitted(result, colon);
    assertValueOmitted(result, escaped);
  }

  {
    const repo = makeRepo("safe-references");
    track(repo, ".npmrc", "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n");
    track(repo, ".env.op", "NPM_TOKEN=op://DeLoSecrets/NPM/token\n");
    track(
      repo,
      "review.md",
      [
        "Authorization: Bearer ${REVIEW_TOKEN}",
        "api_key=$API_KEY",
        "client_secret=op://DeLoSecrets/API/token",
        "access_token=process.env.ACCESS_TOKEN",
        "refresh_token=os.environ.get(\"REFRESH_TOKEN\")",
        "password=<redacted>",
        "id_token=***",
        "api_key=api_key_not_found",
        "",
      ].join("\n"),
    );

    const result = check(repo, { ...process.env, NODE_AUTH_TOKEN: "synthetic-fixture-value" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tracked-secret gate: PASS/);
  }

  {
    const repo = makeRepo("unsafe-reference-lookalikes");
    track(
      repo,
      "review.md",
      [
        "api_key=${SESSION_KEY}suffix",
        "client_secret=${lowercase}",
        "access_token=op://Vault/Item",
        "",
      ].join("\n"),
    );

    const result = check(repo);
    assert.equal(result.status, 1, "prefix-like or malformed references must not be exempted");
    assert.match(result.stderr, /literal credential in session\/review artifact \(3\)/);
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
    assertValueOmitted(result, token);
  }

  {
    const repo = makeRepo("tracked-and-packaged-only");
    track(repo, "safe.txt", "no credentials here\n");
    writeFileSync(join(repo, "untracked-runtime.txt"), syntheticJwt());

    const result = check(repo);
    assert.equal(
      result.status,
      0,
      "untracked material excluded from the npm payload is outside this publication gate",
    );
  }
} finally {
  for (const repo of repos.reverse()) rmSync(repo, { recursive: true, force: true });
}

console.log("secret publication gate adversarial regressions passed");
