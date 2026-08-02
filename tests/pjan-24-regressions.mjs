// PJAN-24 — the mise `hooks.enter` dotenv materialization hook must never
// clobber a populated `.env`.
//
// v0 (legacy):  op inject -i .env.op > .env
// v1 (guarded): [ -f .env.op ] && command -v op && op inject ... > .env || true
//
// The shell performs the `>` redirection — destroying the target — BEFORE `op`
// runs. v0 therefore truncated `.env` to zero bytes in any repo without a
// `.env.op`, or on any machine without the `op` CLI. v1 closed those two cases
// but left the most common real-world failure wide open: an EXPIRED op session
// passes both guards, the redirect truncates `.env`, `op inject` exits non-zero,
// and `|| true` swallows it. v1 looked correct while still losing data.
//
// v2 (canonical) never redirects onto `.env` — it materializes into a mktemp
// file in the project dir and `mv`s it into place only on a genuine success.
//
// The truncating form used to be ENFORCED by the parity audit, so the template
// change and the audit assertion have to stay in lockstep — these tests pin both
// ends plus the actual shell behaviour, including the expired-session case.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const cleanup = [];

// The canonical atomic hook, verbatim. Mirrors OP_INJECT_SCRIPT in
// src/parity/index.ts — if one moves without the other, these tests fail.
const GUARDED_HOOK =
  "[ -f '{{config_root}}/.env.op' ] && command -v op >/dev/null 2>&1 && { CDPATH= cd '{{config_root}}' && umask 077 && t=$(mktemp .env.inject.XXXXXX) && op inject -i .env.op -o $t --force && mv $t .env || rm -f $t; } || true";
const LEGACY_HOOK = "op inject -i .env.op > .env";
// The insufficient v1 guard: both guards present, but still redirecting onto
// .env. Kept so the suite proves it is detected and migrated, not accepted.
const TRUNCATING_GUARDED_HOOK =
  "[ -f '{{config_root}}/.env.op' ] && command -v op >/dev/null 2>&1 && op inject -i '{{config_root}}/.env.op' > '{{config_root}}/.env' || true";
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

// Install a stand-in `op` on PATH. `body` is the shell body of the fake binary.
function fakeOpBin(name, body) {
  const bin = makeSandbox(name);
  writeFileSync(join(bin, "op"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

try {
  {
    // The atomic shape itself: both guards present, terminates with `|| true`,
    // every {{config_root}} reference single-quoted (space-safe house style),
    // and — the whole point of the repair — NO redirection onto .env.
    assert.match(GUARDED_HOOK, /^\[ -f '\{\{config_root\}\}\/\.env\.op' \]/, "hook must guard on .env.op existence");
    assert.match(GUARDED_HOOK, /command -v op >\/dev\/null 2>&1/, "hook must guard on op CLI availability");
    assert.match(GUARDED_HOOK, /\|\| true$/, "hook must terminate with || true so it cannot break shell entry");
    assert.equal(
      (GUARDED_HOOK.match(/'\{\{config_root\}\}/g) ?? []).length,
      (GUARDED_HOOK.match(/\{\{config_root\}\}/g) ?? []).length,
      "every {{config_root}} reference must be single-quoted (survives spaces in the project path)"
    );

    // No `>` may follow `op inject` — a redirect truncates the target before op
    // runs, which is precisely the bug in both earlier forms.
    assert.doesNotMatch(
      GUARDED_HOOK,
      /op\s+inject\b[^\n]*>/,
      "hook must not redirect op inject output — it must write via -o to a temp file"
    );
    assert.match(GUARDED_HOOK, /mktemp/, "hook must stage through mktemp, not a predictable fixed path");
    assert.match(GUARDED_HOOK, /umask 077/, "hook must restrict permissions before secrets touch the temp file");
    assert.match(GUARDED_HOOK, /mv \$t \.env/, "hook must publish via an atomic same-directory mv onto .env");
    assert.match(GUARDED_HOOK, /rm -f \$t/, "hook must remove the temp file on failure");
    assert.doesNotMatch(GUARDED_HOOK, /"/, "hook must contain no double quotes (it is embedded in a TOML basic string)");

    // .env stays the destination — switching to .env.secrets would silently
    // break the `_.file` contract of every already-provisioned repo.
    assert.doesNotMatch(GUARDED_HOOK, /\.env\.secrets/, "hook must materialize .env, not .env.secrets");
  }

  {
    // The shipped CommonProject template RENDERS the atomic form. Checking the
    // rendered output (not the raw source) is what proves the {% raw %} blocks
    // and the TOML quoting survive the trip.
    const jinja = readFileSync(join(root, "templates", "commonproject", "template", "mise.toml.jinja"), "utf8");
    const rendered = jinja.replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1");
    assert.ok(rendered.includes(GUARDED_HOOK), "mise.toml.jinja must render the atomic op inject hook");
    assert.ok(!rendered.includes(TRUNCATING_GUARDED_HOOK), "mise.toml.jinja must not ship the truncating guarded hook");
    assert.doesNotMatch(
      rendered,
      /script = "op inject -i \.env\.op > \.env"/,
      "mise.toml.jinja must not ship the unguarded op inject hook"
    );
    // The rendered script value must be a well-formed TOML basic string: the
    // hook carries no `"` of its own, so the value has exactly two.
    const scriptLine = rendered.split("\n").find((line) => line.startsWith("script = ") && line.includes("op inject"));
    assert.equal((scriptLine.match(/"/g) ?? []).length, 2, `rendered hook line must be a clean TOML basic string: ${scriptLine}`);
  }

  {
    // pjangler's own mise.toml carries the atomic hook.
    //
    // SCOPE: this asserts the op-inject contract ONLY. It is deliberately NOT a
    // self-compliance check — pjangler's own mise.toml still FAILS the full
    // `mise.config-root` rule for unrelated pre-existing reasons (the
    // link-agentfiles hook on line 17 is unquoted). Do not upgrade this into
    // `audit(root).status === "pass"` without fixing that first; a green that
    // implies more than it checks is what let PJAN-24 ship twice.
    const own = readFileSync(join(root, "mise.toml"), "utf8");
    assert.ok(own.includes(GUARDED_HOOK), "pjangler's own mise.toml must use the atomic op inject hook");
    assert.ok(!own.includes(TRUNCATING_GUARDED_HOOK), "pjangler's own mise.toml must not carry the truncating guarded hook");
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
    // THE REPAIR, proved. `.env.op` present, `op` present — BOTH guards pass —
    // but the op session is expired so `op inject` exits non-zero. This is the
    // single most common real-world failure and the one the v1 guard missed:
    // it truncated .env to zero bytes and still exited 0. The atomic form must
    // exit 0, leave .env byte-for-byte intact, and leave no temp file behind.
    const sandbox = makeSandbox("expired-op-session");
    const bin = fakeOpBin("expired-op-bin", "echo '[ERROR] session expired, run `op signin`' >&2\nexit 1");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    writeFileSync(join(sandbox, ".env.op"), "HINDSIGHT_API_KEY=op://Vault/Item/field\n");
    const before = readFileSync(join(sandbox, ".env"));

    const result = runHook(GUARDED_HOOK, sandbox, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, `hook must exit 0 when op inject fails\nstderr:\n${result.stderr}`);
    assert.ok(
      before.equals(readFileSync(join(sandbox, ".env"))),
      "a failing op inject must leave .env BYTE-FOR-BYTE unchanged (v1 truncated it to zero bytes here)"
    );
    assert.deepEqual(
      readdirSync(sandbox).sort(),
      [".env", ".env.op"],
      "a failing op inject must leave no temp/leftover file in the project dir"
    );
  }

  {
    // Control: the v1 guarded hook — both guards satisfied — DESTROYS the same
    // .env under the same expired session, and still exits 0. This is the defect
    // this repair removes; if this control ever stops truncating, the test above
    // has stopped proving anything.
    const sandbox = makeSandbox("v1-truncates-on-expired");
    const bin = fakeOpBin("expired-op-bin-control", "echo '[ERROR] session expired' >&2\nexit 1");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    writeFileSync(join(sandbox, ".env.op"), "HINDSIGHT_API_KEY=op://Vault/Item/field\n");

    const result = runHook(TRUNCATING_GUARDED_HOOK, sandbox, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, "control: the v1 hook silently exits 0");
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      "",
      "control: the v1 guarded hook truncates .env on an expired op session (the defect this repair fixes)"
    );
  }

  {
    // The happy path still works: a successful `op inject` fully replaces .env,
    // and the published file is owner-only (secrets must not land world-readable).
    const sandbox = makeSandbox("op-success");
    const bin = fakeOpBin(
      "working-op-bin",
      'src=""; out=""\nwhile [ $# -gt 0 ]; do case "$1" in -i) src="$2"; shift 2;; -o) out="$2"; shift 2;; *) shift;; esac; done\nsed "s|op://.*|resolved-secret|" "$src" > "$out"'
    );
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    writeFileSync(join(sandbox, ".env.op"), "HINDSIGHT_API_KEY=op://Vault/Item/field\n");

    const result = runHook(GUARDED_HOOK, sandbox, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, `hook must exit 0 on success\nstderr:\n${result.stderr}`);
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      "HINDSIGHT_API_KEY=resolved-secret\n",
      "a successful op inject must publish the resolved values to .env"
    );
    assert.equal(statSync(join(sandbox, ".env")).mode & 0o777, 0o600, "materialized .env must be owner-only (umask 077)");
    assert.deepEqual(readdirSync(sandbox).sort(), [".env", ".env.op"], "success must leave no temp file behind");
  }

  {
    // Space in the project path — the house-style reason every {{config_root}}
    // is single-quoted. The staging temp name is relative and X-only, so the
    // unquoted $t is provably word-split-safe even here.
    const outer = makeSandbox("spaced parent");
    const sandbox = join(outer, "my repo");
    mkdirSync(sandbox);
    const bin = fakeOpBin("spaced-op-bin", "echo boom >&2\nexit 1");
    writeFileSync(join(sandbox, ".env"), POPULATED_ENV);
    writeFileSync(join(sandbox, ".env.op"), "HINDSIGHT_API_KEY=op://Vault/Item/field\n");

    const result = runHook(GUARDED_HOOK, sandbox, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, `hook must exit 0 in a path containing spaces\nstderr:\n${result.stderr}`);
    assert.equal(
      readFileSync(join(sandbox, ".env"), "utf8"),
      POPULATED_ENV,
      "hook must leave .env intact in a project path containing spaces"
    );
    assert.deepEqual(readdirSync(sandbox).sort(), [".env", ".env.op"], "no temp file may leak in a spaced path");
  }

  {
    // A freshly migrated repo gets the atomic hook and PASSES the audit.
    const repo = makeRepo("audit-passes-guarded");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(mise.includes(GUARDED_HOOK), "migrate must install the guarded op inject hook");
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS on the guarded hook");
  }

  {
    // A repo still carrying the legacy unguarded hook FAILS the audit with a
    // message that names the data-loss. (`fixable` is not asserted — the rule
    // hardcodes it true, so the assertion would prove nothing; the migrate
    // cases below are what actually prove it is fixable.)
    const repo = makeRepo("audit-fails-legacy");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(join(repo, "mise.toml"), migrated.replace(GUARDED_HOOK, LEGACY_HOOK));

    const finding = miseFinding(repo, hooksOff);
    assert.equal(finding.status, "fail", `audit must FAIL on the legacy unguarded hook\n${JSON.stringify(finding)}`);
    assert.ok(
      finding.details.some((detail) => /write \.env non-atomically/.test(detail) && /truncate it before op runs/.test(detail)),
      `audit detail must explain the truncation\n${JSON.stringify(finding.details)}`
    );
  }

  {
    // The v1 guarded-but-truncating hook must ALSO fail the audit. It is the
    // form every repo provisioned by the first PJAN-24 fix is carrying, and it
    // still loses .env on an expired op session.
    const repo = makeRepo("audit-fails-truncating-guard");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(join(repo, "mise.toml"), migrated.replace(GUARDED_HOOK, TRUNCATING_GUARDED_HOOK));

    const finding = miseFinding(repo, hooksOff);
    assert.equal(finding.status, "fail", `audit must FAIL on the v1 truncating guard\n${JSON.stringify(finding)}`);
    assert.ok(
      finding.details.some((detail) => /expired op session/.test(detail)),
      `audit detail must name the expired-session failure\n${JSON.stringify(finding.details)}`
    );

    // ...and migrate must rewrite it to the atomic form, leaving exactly one hook.
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const fixed = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(fixed.includes(GUARDED_HOOK), "migrate must rewrite the v1 truncating guard to the atomic form");
    assert.ok(!fixed.includes(TRUNCATING_GUARDED_HOOK), "the v1 truncating guard must be gone after migrate");
    assert.equal((fixed.match(/op inject /g) ?? []).length, 1, "exactly one op inject hook after migrating v1");
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS after migrating the v1 guard");
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

  {
    // R2 — a repo carrying BOTH the atomic hook and a legacy one must FAIL.
    // Presence of the guard is not absence of the truncation: the audit used to
    // test `text.includes(CANONICAL)` and passed this repo with empty details
    // while the legacy entry destroyed .env on every enter.
    const repo = makeRepo("both-hooks-present");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(
      join(repo, "mise.toml"),
      migrated.replace(
        `[[hooks.enter]]\nscript = ${JSON.stringify(GUARDED_HOOK)}`,
        `[[hooks.enter]]\nscript = ${JSON.stringify(GUARDED_HOOK)}\n[[hooks.enter]]\nscript = ${JSON.stringify(LEGACY_HOOK)}`
      )
    );
    const withBoth = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(withBoth.includes(GUARDED_HOOK) && withBoth.includes(`script = "${LEGACY_HOOK}"`), "fixture must carry BOTH hooks");

    const finding = miseFinding(repo, hooksOff);
    assert.equal(finding.status, "fail", `audit must FAIL when a truncating hook coexists with the atomic one\n${JSON.stringify(finding)}`);
    assert.ok(
      finding.details.some((detail) => /truncate/.test(detail)),
      `audit must name the truncation, not stay silent\n${JSON.stringify(finding.details)}`
    );

    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    assert.equal((readFileSync(join(repo, "mise.toml"), "utf8").match(/op inject /g) ?? []).length, 1, "migrate must collapse to one op inject hook");
    assert.equal(miseFinding(repo, hooksOff).status, "pass", "audit must PASS once the duplicate is removed");
  }

  {
    // R2b — the audit must read hook VALUES, not raw text. The explanatory
    // comment beside the hook quotes the legacy form verbatim, so a naive
    // `text.includes(LEGACY)` absence check would fail a correct repo.
    const repo = makeRepo("legacy-literal-in-comment");
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);
    const migrated = readFileSync(join(repo, "mise.toml"), "utf8");
    writeFileSync(join(repo, "mise.toml"), `# historical note: this repo used to run op inject -i .env.op > .env\n${migrated}`);

    assert.equal(
      miseFinding(repo, hooksOff).status,
      "pass",
      "a comment quoting the legacy command must not be mistaken for a live hook"
    );
  }

  {
    // R3 — hooks that materialize a DIFFERENT destination belong to the user.
    // The loose `op inject && .env.op` matcher claimed them, normalizeHookScript
    // rewrote them to the canonical string, and dedupePreserve then collapsed
    // them into the managed entry — so the user's hook vanished outright. Assert
    // each one is still PRESENT and unmodified, not merely retargeted.
    const foreign = [
      // The WireMiseOpInject pattern — strictly SAFER than what we install.
      "[ -f '{{config_root}}/.env.op' ] && op inject -i '{{config_root}}/.env.op' -o '{{config_root}}/.env.secrets' --force || true",
      "op inject -i .env.op > .env.local",
      "op inject -i .env.op.staging > .env.staging",
    ];
    const repo = makeRepo("foreign-op-inject-targets");
    writeFileSync(
      join(repo, "mise.toml"),
      `[env]\n_.path = [".mise/scripts"]\n\n[hooks]\nenter = [\n${foreign
        .map((hook) => `  ${JSON.stringify(hook)},`)
        .join("\n")}\n  "echo unrelated-hook",\n]\n`
    );
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);

    const fixed = readFileSync(join(repo, "mise.toml"), "utf8");
    for (const hook of foreign) {
      assert.ok(fixed.includes(hook), `migrate must PRESERVE a user hook targeting another file, verbatim: ${hook}`);
    }
    assert.ok(fixed.includes("echo unrelated-hook"), "migrate must preserve unrelated hooks");
    assert.ok(fixed.includes(GUARDED_HOOK), "migrate must still install the canonical .env hook alongside them");
  }

  {
    // R5 — the dotenv rewrite is for ENTER hooks only. A LEAVE hook is teardown;
    // rewriting one turns "clean up on exit" into "materialize secrets on exit".
    const leaveHook = "rm -f .env && echo restored-from .env.op via op inject";
    const repo = makeRepo("leave-hook-untouched");
    writeFileSync(
      join(repo, "mise.toml"),
      `[env]\n_.path = [".mise/scripts"]\n\n[hooks]\nenter = ["op inject -i .env.op > .env"]\nleave = [${JSON.stringify(leaveHook)}]\n`
    );
    run(["migrate", "mise.config-root", repo, "--json"], root, hooksOff);

    const fixed = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.ok(fixed.includes(leaveHook), "migrate must leave a leave-hook verbatim, never rewrite it to the materialization command");
    assert.match(fixed, /\[\[hooks\.leave\]\]/, "the leave hook must survive as a leave hook");
    assert.ok(fixed.includes(GUARDED_HOOK), "the ENTER hook must still be migrated");
    // The materialization command must appear exactly once, and under enter.
    const leaveIndex = fixed.indexOf("[[hooks.leave]]");
    assert.ok(fixed.indexOf(GUARDED_HOOK) < leaveIndex, "the materialization hook must sit in the enter block, not the leave block");
  }

  console.log("PJAN-24 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
