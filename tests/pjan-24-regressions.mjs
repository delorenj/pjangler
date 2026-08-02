// PJAN-24 — the mise `hooks.enter` dotenv materialization hook must never
// clobber a populated `.env`.
//
// The legacy hook was `op inject -i .env.op > .env`. The shell performs the `>`
// redirection BEFORE running `op`, so in any repo without a `.env.op` — or on a
// machine without the `op` CLI — entering the directory truncated `.env` to zero
// bytes. The fix guards on both the input file and the binary and terminates
// with `|| true` so a failed materialization can never break shell entry.
//
// The unguarded form used to be ENFORCED by the parity audit, so the template
// change and the audit assertion have to stay in lockstep — these tests pin both
// ends plus the actual shell behaviour.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const cleanup = [];

// The canonical guarded hook, verbatim. Mirrors OP_INJECT_SCRIPT in
// src/parity/index.ts — if one moves without the other, these tests fail.
const GUARDED_HOOK =
  "[ -f '{{config_root}}/.env.op' ] && command -v op >/dev/null 2>&1 && op inject -i '{{config_root}}/.env.op' > '{{config_root}}/.env' || true";
const LEGACY_HOOK = "op inject -i .env.op > .env";
const POPULATED_ENV = "HINDSIGHT_API_KEY=super-secret\nDATABASE_URL=postgres://localhost/app\n";

function run(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (!result.stdout.trim()) {
    throw new Error(`command produced no stdout: node ${cli} ${args.join(" ")}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjan-24-${name}-`));
  cleanup.push(repo);
  writeFileSync(join(repo, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function makeSandbox(name) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-24-${name}-`));
  cleanup.push(dir);
  return dir;
}

function miseFinding(repo, env) {
  const report = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, env));
  const value = report.rules.find((rule) => rule.id === "mise.config-root");
  assert.ok(value, "missing audit finding mise.config-root");
  return value;
}

// Execute a hook `script` value exactly the way mise does: `sh -c` with
// {{config_root}} already expanded. `-e` proves the hook is safe under set -e.
function runHook(script, cwd, env) {
  return spawnSync("/bin/sh", ["-e", "-c", script.replaceAll("{{config_root}}", cwd)], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

const hooksOff = { PJ_AGENT_HOOKS_LAYER: "0" };

try {
  {
    // The guarded shape itself: both guards present, terminates with `|| true`,
    // and every {{config_root}} path single-quoted (space-safe house style).
    assert.match(GUARDED_HOOK, /^\[ -f '\{\{config_root\}\}\/\.env\.op' \]/, "hook must guard on .env.op existence");
    assert.match(GUARDED_HOOK, /command -v op >\/dev\/null 2>&1/, "hook must guard on op CLI availability");
    assert.match(GUARDED_HOOK, /\|\| true$/, "hook must terminate with || true so it cannot break shell entry");
    assert.equal(
      (GUARDED_HOOK.match(/'\{\{config_root\}\}\//g) ?? []).length,
      3,
      "every {{config_root}} path must be single-quoted (survives spaces in the project path)"
    );
  }

  {
    // The shipped CommonProject template renders the guarded form, not the bare one.
    const jinja = readFileSync(join(root, "templates", "commonproject", "template", "mise.toml.jinja"), "utf8");
    const rendered = jinja.replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1");
    assert.ok(rendered.includes(GUARDED_HOOK), "mise.toml.jinja must render the guarded op inject hook");
    assert.doesNotMatch(
      rendered,
      /script = "op inject -i \.env\.op > \.env"/,
      "mise.toml.jinja must not ship the unguarded op inject hook"
    );
  }

  {
    // pjangler's own mise.toml must obey the contract it enforces on others.
    const own = readFileSync(join(root, "mise.toml"), "utf8");
    assert.ok(own.includes(GUARDED_HOOK), "pjangler's own mise.toml must use the guarded op inject hook");
    assert.doesNotMatch(own, /"op inject -i \.env\.op > \.env"/, "pjangler's own mise.toml must not carry the unguarded hook");
  }

  {
    // THE BUG, proved. No .env.op present: the guarded hook must be a no-op and
    // leave a populated .env byte-for-byte intact.
    const sandbox = makeSandbox("no-env-op");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    assert.equal(existsSync(join(sandbox, ".env.op")), false, "fixture must have no .env.op");

    const result = runHook(GUARDED_HOOK, sandbox);
    assert.equal(result.status, 0, `guarded hook must exit 0 under set -e\nstderr:\n${result.stderr}`);
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      POPULATED_ENV,
      "guarded hook must leave an existing populated .env UNTRUNCATED when .env.op is absent"
    );
  }

  {
    // Control: the legacy hook destroys the same .env. This is the data-loss
    // behaviour the fix removes — it truncates regardless of whether `op` exists,
    // because the shell opens the redirection before running the command.
    const sandbox = makeSandbox("legacy-truncates");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    spawnSync("/bin/sh", ["-c", LEGACY_HOOK], { cwd: sandbox, encoding: "utf8" });
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      "",
      "control: the legacy unguarded hook truncates .env (this is the bug PJAN-24 fixes)"
    );
  }

  {
    // .env.op present but the `op` CLI missing (empty PATH): still a no-op.
    const sandbox = makeSandbox("no-op-cli");
    const emptyBin = makeSandbox("empty-bin");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    writeFileSync(join(sandbox, ".env.op"), "HINDSIGHT_API_KEY=op://Vault/Item/field\n");

    const result = runHook(GUARDED_HOOK, sandbox, { PATH: emptyBin });
    assert.equal(result.status, 0, `guarded hook must exit 0 with no op CLI\nstderr:\n${result.stderr}`);
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      POPULATED_ENV,
      "guarded hook must leave .env untouched when the op CLI is unavailable"
    );
  }

  {
    // A freshly migrated repo gets the guarded hook and PASSES the audit.
    const repo = makeRepo("audit-passes-guarded");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(mise.includes(GUARDED_HOOK), "migrate must install the guarded op inject hook");
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS on the guarded hook");
  }

  {
    // A repo still carrying the legacy unguarded hook FAILS the audit with a
    // message that names the data-loss, and is reported fixable.
    const repo = makeRepo("audit-fails-legacy");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(join(repo, "mise.toml"), migrated.replace(GUARDED_HOOK, LEGACY_HOOK));

    const finding = miseFinding(repo, hooksOff);
    assert.equal(finding.status, "fail", `audit must FAIL on the legacy unguarded hook\n${JSON.stringify(finding)}`);
    assert.equal(finding.fixable, true, "the legacy hook must be reported as auto-fixable");
    assert.ok(
      finding.details.some((detail) => /unguarded/.test(detail) && /truncates \.env/.test(detail)),
      `audit detail must explain the truncation\n${JSON.stringify(finding.details)}`
    );
  }

  {
    // Auto-fix path: `migrate mise.config-root` MIGRATES an existing unguarded
    // hook to the guarded form rather than preserving it as a foreign user hook.
    const repo = makeRepo("migrate-legacy-to-guarded");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(join(repo, "mise.toml"), migrated.replace(GUARDED_HOOK, LEGACY_HOOK));

    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const fixed = readFileSync(join(repo, "mise.toml"), "utf8");

    assert.ok(fixed.includes(GUARDED_HOOK), "migrate must rewrite the legacy hook to the guarded form");
    assert.doesNotMatch(fixed, /script = "op inject -i \.env\.op > \.env"/, "the legacy hook entry must be gone");
    assert.equal(
      (fixed.match(/op inject -i /g) ?? []).length,
      1,
      "migrate must leave exactly one op inject hook (legacy must not survive alongside the guarded form)"
    );
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS after the auto-fix");

    // And the migration is idempotent — a second pass changes nothing.
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    assert.equal(readFileSync(join(repo, "mise.toml"), "utf8"), fixed, "re-migrating the fixed repo must be a no-op");
  }

  {
    // The legacy hook expressed in the old `[hooks] enter = [ ... ]` array form
    // (what already-provisioned repos actually look like) must also migrate.
    const repo = makeRepo("legacy-array-form");
    writeFileSync(
      join(repo, "mise.toml"),
      `[env]
_.path = [".mise/scripts"]

[hooks]
enter = [
  "{{config_root}}/.mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env",
]

[tasks.other]
run = "echo still here"
`
    );
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);

    const fixed = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(fixed.includes(GUARDED_HOOK), "legacy array-form hook must migrate to the guarded form");
    assert.equal((fixed.match(/op inject -i /g) ?? []).length, 1, "exactly one op inject hook after migration");
    assert.match(fixed, /\[tasks\.other\]\nrun = "echo still here"/, "migrate must preserve unrelated tasks");
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS after migrating the array form");
  }

  console.log("PJAN-24 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
