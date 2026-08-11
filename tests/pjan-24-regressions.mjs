// PJAN-24/PJAN-57 — `.env` materialization is owned by MiseOpInjectRecipe.
// Shell complexity lives in a managed script so mise never interpolates temp
// variables. The script must publish atomically and preserve `.env` on failure.
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const templateScript = join(root, "templates", "commonproject", "template", ".mise", "scripts", "materialize-env.sh");
const MANAGED_HOOK = "'{{config_root}}/.mise/scripts/materialize-env.sh'";
const LEGACY_HOOK = "op inject -i .env.op > .env";
const TRUNCATING_GUARDED_HOOK =
  "[ -f '{{config_root}}/.env.op' ] && command -v op >/dev/null 2>&1 && op inject -i '{{config_root}}/.env.op' > '{{config_root}}/.env' || true";
const POPULATED_ENV = "HINDSIGHT_API_KEY=keep-me\nDATABASE_URL=postgres://localhost/app\n";
const temporary = mkdtempSync(join(tmpdir(), "pjan-24-managed-materializer-"));

function cliJson(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PJ_AGENT_HOOKS_LAYER: "0" },
  });
  assert.ok(result.stdout.trim(), `${args.join(" ")} produced no JSON\n${result.stderr}`);
  return { result, payload: JSON.parse(result.stdout) };
}

function makeRepo(name, mise = '[env]\n_.path = [".mise/scripts"]\n') {
  const repo = join(temporary, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "mise.toml"), mise);
  writeFileSync(join(repo, ".gitignore"), "# fixture\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function secretFinding(repo) {
  const { payload } = cliJson(["audit", repo, "--json"]);
  const finding = payload.rules.find((rule) => rule.id === "secrets.env-op");
  assert.ok(finding, "missing secrets.env-op audit finding");
  return finding;
}

function installMaterializer(repo) {
  const target = join(repo, ".mise", "scripts", "materialize-env.sh");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(templateScript, target);
  chmodSync(target, 0o755);
  return target;
}

function fakeOp(repo, body) {
  const bin = join(repo, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const op = join(bin, "op");
  writeFileSync(op, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(op, 0o755);
  return bin;
}

try {
  {
    const script = readFileSync(templateScript, "utf8");
    const templateMise = readFileSync(join(root, "templates", "commonproject", "template", "mise.toml.jinja"), "utf8")
      .replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1");
    const ownMise = readFileSync(join(root, "mise.toml"), "utf8");

    for (const [name, text] of [["template", templateMise], ["pjangler", ownMise]]) {
      assert.ok(text.includes(MANAGED_HOOK), `${name} mise.toml must call the managed materializer`);
      assert.doesNotMatch(text, /script\s*=.*op inject/, `${name} mise.toml must not embed op inject shell logic`);
      assert.doesNotMatch(text, /\.env\.secrets/, `${name} must materialize the canonical .env target`);
    }
    assert.match(script, /mktemp "\$project_dir\/\.env\.inject\.XXXXXX"/, "temp files must use collision-resistant mktemp");
    assert.match(script, /trap cleanup EXIT HUP INT TERM/, "temp cleanup must cover failure and interruption");
    assert.match(script, /op inject -i "\$source_file" -o "\$temp_file" --force/, "op must write only to the quoted temp path");
    assert.match(script, /mv -f -- "\$temp_file" "\$target_file"/, "publication must be one atomic same-directory move");
    assert.doesNotMatch(script, />\s*"?\$target_file/, "the script must never redirect onto .env");
  }

  for (const [name, envOp] of [
    ["missing-source", undefined],
    ["comment-opt-out", "# This project intentionally has no secrets.\n"],
  ]) {
    const repo = makeRepo(name);
    const materializer = installMaterializer(repo);
    writeFileSync(join(repo, ".env"), POPULATED_ENV);
    if (envOp !== undefined) writeFileSync(join(repo, ".env.op"), envOp);
    const result = spawnSync(materializer, [], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), POPULATED_ENV, `${name} must be a no-op`);
    assert.deepEqual(readdirSync(repo).filter((entry) => entry.startsWith(".env.inject.")), [], `${name} must not stage a temp file`);
  }

  {
    const repo = makeRepo("failure path with spaces");
    const materializer = installMaterializer(repo);
    const bin = fakeOp(repo, `
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
printf 'PARTIAL=must-not-land\\n' > "$out"
exit 42`);
    writeFileSync(join(repo, ".env.op"), "API_KEY=op://vault/item/field\n");
    writeFileSync(join(repo, ".env"), POPULATED_ENV);
    writeFileSync(join(repo, ".env.inject.XXXXXX"), "collision sentinel\n");

    const result = spawnSync(materializer, [], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 42, "an op failure must remain visible to mise");
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), POPULATED_ENV, "a failed injection must preserve .env byte-for-byte");
    assert.equal(readFileSync(join(repo, ".env.inject.XXXXXX"), "utf8"), "collision sentinel\n");
    assert.deepEqual(
      readdirSync(repo).filter((entry) => entry.startsWith(".env.inject.")).sort(),
      [".env.inject.XXXXXX"],
      "failure cleanup must remove only the unique staging file",
    );
  }

  {
    const repo = makeRepo("success path with spaces");
    const materializer = installMaterializer(repo);
    const bin = fakeOp(repo, `
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
printf 'API_KEY=resolved\\n' > "$out"`);
    writeFileSync(join(repo, ".env.op"), "API_KEY=op://vault/item/field\n");
    writeFileSync(join(repo, ".env"), POPULATED_ENV);

    const result = spawnSync(materializer, [], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "API_KEY=resolved\n");
    assert.equal(statSync(join(repo, ".env")).mode & 0o777, 0o600, "materialized secrets must be owner-only");
    assert.deepEqual(readdirSync(repo).filter((entry) => entry.startsWith(".env.inject.")), [], "success must leave no temp file");
  }

  {
    const foreignEnter = `[[hooks.enter]]
# foreign comment
condition = "env.PROFILE == 'dev'"
script = "op inject -i .env.local -o .env.local"
shell = "bash"
custom_key = "keep-enter"`;
    const foreignLeave = `[[hooks.leave]]
# leave comment
condition = "true"
script = "echo leave"
shell = "zsh"`;
    const repo = makeRepo("migrate-legacy", `[env]
_.path = [".mise/scripts"]
script = "${LEGACY_HOOK}"

[[hooks.enter]]
condition = "true"
script = "${TRUNCATING_GUARDED_HOOK}"
shell = "bash"

${foreignEnter}

${foreignLeave}
`);
    writeFileSync(join(repo, ".env.op"), "FEATURE_FLAG=enabled\n");

    const migrated = cliJson(["migrate", "secrets.env-op", repo, "--json"]);
    assert.equal(migrated.result.status, 0, JSON.stringify(migrated.payload));
    assert.equal(migrated.payload.results[0].status, "applied");
    const first = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.equal((first.match(/materialize-env\.sh/g) ?? []).length, 1, "migration must install exactly one managed hook");
    assert.doesNotMatch(first, /^script = ".*op inject.*\.env"$/m, "owned truncating hooks must be removed");
    assert.ok(first.includes(foreignEnter), "foreign enter records and metadata must be preserved verbatim");
    assert.ok(first.includes(foreignLeave), "leave records and metadata must be preserved verbatim");
    assert.equal(lstatSync(join(repo, ".mise", "scripts", "materialize-env.sh")).mode & 0o111, 0o111);
    assert.equal(secretFinding(repo).status, "pass", JSON.stringify(secretFinding(repo)));

    const second = cliJson(["migrate", "secrets.env-op", repo, "--json"]);
    assert.equal(second.payload.results[0].status, "noop", JSON.stringify(second.payload));
    assert.equal(readFileSync(join(repo, "mise.toml"), "utf8"), first, "migration must be byte-idempotent");
  }

  {
    const repo = makeRepo("dedupe-owned", `[[hooks.enter]]
script = "${MANAGED_HOOK}"
[[hooks.enter]]
script = "${LEGACY_HOOK}"
`);
    writeFileSync(join(repo, ".env.op"), "# intentional opt-out\n");
    const migrated = cliJson(["migrate", "secrets.env-op", repo, "--json"]);
    assert.equal(migrated.result.status, 0, JSON.stringify(migrated.payload));
    const text = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.equal((text.match(/materialize-env\.sh/g) ?? []).length, 1);
    assert.doesNotMatch(text, /op inject -i \.env\.op > \.env/);
    assert.equal(secretFinding(repo).status, "pass", JSON.stringify(secretFinding(repo)));
  }

  console.log("PJAN-24 managed env materialization regressions: PASS");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
