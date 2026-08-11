import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const neutralTemplate = readFileSync(join(root, "templates", "commonproject", "template", ".env.op"), "utf8");
const supportedRoots = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"];
const temporary = mkdtempSync(join(tmpdir(), "pjan-57-dogfood-"));

function runCli(args, env = {}, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  return result;
}

function jsonCli(args, env = {}) {
  const result = runCli(args, env);
  assert.ok(result.stdout.trim(), `${args.join(" ")} produced no JSON\n${result.stderr}`);
  return { result, payload: JSON.parse(result.stdout) };
}

function makeEnvRepo(name, envOp) {
  const repo = join(temporary, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\"]\n");
  writeFileSync(join(repo, ".gitignore"), "# fixture\n");
  if (envOp !== undefined) writeFileSync(join(repo, ".env.op"), envOp);
  return repo;
}

try {
  {
    const repo = join(temporary, "cli-force-propagation");
    mkdirSync(repo, { recursive: true });
    const sentinel = '{"name":"keep-me"}\n';
    writeFileSync(join(repo, "package.json"), sentinel);

    const preserved = runCli(["add", "node"], {}, repo);
    assert.notEqual(preserved.status, 0, "add node without --force must refuse an existing package.json");
    assert.equal(readFileSync(join(repo, "package.json"), "utf8"), sentinel, "no-force must preserve existing output byte-for-byte");

    const replaced = runCli(["add", "node", "--force"], {}, repo);
    assert.equal(replaced.status, 0, `${replaced.stdout}${replaced.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).name, "my-project", "--force must reach the Node recipe and replace existing output");
  }

  for (const [label, initial, expected] of [
    ["missing", undefined, neutralTemplate],
    ["zero", "", neutralTemplate],
    ["whitespace", " \t\n", neutralTemplate],
    ["comments", "# This project intentionally has no secrets.\n\n", "# This project intentionally has no secrets.\n\n"],
    ["literal", "FEATURE_FLAG=enabled\n", "FEATURE_FLAG=enabled\n"],
    ["reference", "API_KEY=op://example-vault/example-item/credential\n", "API_KEY=op://example-vault/example-item/credential\n"],
  ]) {
    const repo = makeEnvRepo(`env-${label}`, initial);
    const { payload } = jsonCli(["migrate", "secrets.env-op", repo, "--json"]);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(readFileSync(join(repo, ".env.op"), "utf8"), expected, `${label} .env.op semantics`);
    const audit = jsonCli(["audit", repo, "--json"]).payload;
    const finding = audit.rules.find((rule) => rule.id === "secrets.env-op");
    assert.equal(finding.status, "pass", `${label}: ${JSON.stringify(finding)}`);
  }

  {
    const repo = makeEnvRepo("env-malformed", "API_KEY=op://broken\n");
    const before = readFileSync(join(repo, ".env.op"));
    const { result, payload } = jsonCli(["migrate", "secrets.env-op", repo, "--json"]);
    assert.notEqual(result.status, 0);
    assert.equal(payload.results[0].status, "blocked");
    assert.deepEqual(readFileSync(join(repo, ".env.op")), before, "unsafe active content must never be overwritten");
  }

  {
    const repo = makeEnvRepo("toml-record-preservation", "# no secrets\n");
    const foreignEnter = `[[hooks.enter]]
# foreign record comment must stay attached
condition = "env.PROFILE == 'dev'"
script = "op inject -i .env.local -o .env.local"
shell = "bash"
custom_key = "keep-enter"
`;
    const foreignLeave = `[[hooks.leave]]

# leave record comment
condition = "true"
script = "echo leave-foreign"
shell = "zsh"
custom_key = "keep-leave"
`;
    writeFileSync(join(repo, "mise.toml"), `[env]
_.path = [".mise/scripts"]
script = "op inject -i .env.op > .env"

[[hooks.enter]]
# positively owned legacy record: all of this record may be replaced
condition = "true"
script = "op inject -i .env.op > .env"
shell = "bash"

${foreignEnter}
${foreignLeave}

[tasks.foreign]
run = "echo untouched"
`);
    for (const rule of ["mise.config-root", "secrets.env-op"]) {
      const migrated = jsonCli(["migrate", rule, repo, "--json"]);
      assert.equal(migrated.payload.ok, true, JSON.stringify(migrated.payload));
    }
    const first = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.doesNotMatch(first, /^script = "op inject -i \.env\.op > \.env"$/m, "orphan [env].script must be removed");
    assert.ok(first.includes(foreignEnter.trim()), "foreign enter record attributes/comments must survive byte-for-byte");
    assert.ok(first.includes(foreignLeave.trim()), "all leave-hook attributes/comments must survive byte-for-byte");
    assert.match(first, /\[tasks\.foreign\]\nrun = "echo untouched"/);
    assert.equal((first.match(/materialize-env\.sh/g) ?? []).length, 1, "canonical materializer hook must be unique");
    for (const rule of ["mise.config-root", "secrets.env-op"]) {
      const second = jsonCli(["migrate", rule, repo, "--json"]).payload;
      assert.equal(second.results[0].status, "noop", `${rule} second migration`);
    }
    assert.equal(readFileSync(join(repo, "mise.toml"), "utf8"), first, "TOML migration must be byte-idempotent");
    const parseState = join(temporary, "mise-parse-state");
    const parseEnv = {
      ...process.env,
      MISE_DATA_DIR: join(parseState, "data"),
      MISE_CONFIG_DIR: join(parseState, "config"),
      MISE_CACHE_DIR: join(parseState, "cache"),
      MISE_STATE_DIR: join(parseState, "state"),
    };
    const trusted = spawnSync("mise", ["trust", join(repo, "mise.toml")], { env: parseEnv, encoding: "utf8" });
    assert.equal(trusted.status, 0, trusted.stderr);
    const parsed = spawnSync("mise", ["config", "ls"], { cwd: repo, env: parseEnv, encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stderr, "", `mise must not emit interpolation/TOML warnings: ${parsed.stderr}`);
  }

  {
    const repo = join(temporary, "materializer path with spaces");
    const scriptDir = join(repo, ".mise", "scripts");
    const fakeBin = join(repo, "fake-bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(fakeBin);
    cpSync(join(root, "templates", "commonproject", "template", ".mise", "scripts", "materialize-env.sh"), join(scriptDir, "materialize-env.sh"));
    chmodSync(join(scriptDir, "materialize-env.sh"), 0o755);
    writeFileSync(join(repo, ".env.op"), "API_KEY=op://vault/item/field\n");
    writeFileSync(join(repo, ".env"), "ORIGINAL=1\n");
    writeFileSync(join(repo, ".env.inject.XXXXXX"), "collision sentinel\n");
    const fakeOp = join(fakeBin, "op");
    writeFileSync(fakeOp, `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
[ -n "$out" ]
printf 'API_KEY=resolved\\n' > "$out"
`);
    chmodSync(fakeOp, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const success = spawnSync(join(scriptDir, "materialize-env.sh"), [], { cwd: repo, env, encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "API_KEY=resolved\n");
    assert.equal(readFileSync(join(repo, ".env.inject.XXXXXX"), "utf8"), "collision sentinel\n");
    assert.deepEqual(readdirSync(repo).filter((name) => /^\.env\.inject\./.test(name)).sort(), [".env.inject.XXXXXX"]);
    assert.equal(lstatSync(join(repo, ".env")).mode & 0o777, 0o600);

    writeFileSync(join(repo, ".env"), "KEEP=original\n");
    writeFileSync(fakeOp, `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
printf 'PARTIAL=must-not-land\\n' > "$out"
exit 42
`);
    const failed = spawnSync(join(scriptDir, "materialize-env.sh"), [], { cwd: repo, env, encoding: "utf8" });
    assert.equal(failed.status, 42);
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "KEEP=original\n");
    assert.deepEqual(readdirSync(repo).filter((name) => /^\.env\.inject\./.test(name)).sort(), [".env.inject.XXXXXX"], "failed injection temp must be cleaned");

    writeFileSync(join(repo, "mise.toml"), `[[hooks.enter]]\nscript = "'{{config_root}}/.mise/scripts/materialize-env.sh'"\n`);
    writeFileSync(fakeOp, `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
printf 'FROM_MISE=1\\n' > "$out"
`);
    const miseState = join(temporary, "mise-state");
    const miseEnv = {
      ...env,
      MISE_DATA_DIR: join(miseState, "data"),
      MISE_CONFIG_DIR: join(miseState, "config"),
      MISE_CACHE_DIR: join(miseState, "cache"),
      MISE_STATE_DIR: join(miseState, "state"),
    };
    const trust = spawnSync("mise", ["trust", join(repo, "mise.toml")], { env: miseEnv, encoding: "utf8" });
    assert.equal(trust.status, 0, trust.stderr);
    const hook = spawnSync("bash", [
      "-c",
      'eval "$(mise activate --no-hook-env bash)"; cd "$1"; eval "$(mise hook-env --force --shell bash)"',
      "pjan-57-mise-hook",
      repo,
    ], { cwd: repo, env: miseEnv, encoding: "utf8" });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stderr, "", `actual mise hook must be warning-free: ${hook.stderr}`);
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "FROM_MISE=1\n");
  }

  function provenanceRepo(name, count = 1) {
    const repo = join(temporary, name);
    const generated = join(repo, ".adal", "skills", "bmad-demo");
    const managed = join(repo, ".agents", "skills", "bmad-demo");
    const config = join(repo, "_bmad", "_config");
    mkdirSync(generated, { recursive: true });
    mkdirSync(managed, { recursive: true });
    mkdirSync(config, { recursive: true });
    const files = [];
    for (let index = 0; index < count; index++) {
      const rel = index === 0 ? "SKILL.md" : `assets/generated-${String(index).padStart(3, "0")}.txt`;
      const content = index === 0 ? "---\nname: bmad-demo\n---\n# Demo\n" : `generated ${index}\n`;
      const path = join(generated, rel);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, content);
      files.push({ rel, hash: createHash("sha256").update(content).digest("hex") });
    }
    writeFileSync(join(managed, "SKILL.md"), "---\nname: bmad-demo\n---\n# Managed\n");
    writeFileSync(join(config, "manifest.yaml"), "installation:\n  version: 6.11.1-next.1\nides:\n  - adal\n");
    writeFileSync(join(config, "skill-manifest.csv"), 'canonicalId,name,description,module,path\n"bmad-demo","bmad-demo","demo","core","_bmad/core/bmad-demo/SKILL.md"\n');
    writeFileSync(join(config, "files-manifest.csv"), `type,name,module,path,hash\n${files.map(({ rel, hash }) => `"file","${rel}","core","core/bmad-demo/${rel}","${hash}"`).join("\n")}\n`);
    writeFileSync(join(repo, ".gitignore"), "# fixture\n");
    return repo;
  }

  {
    const repo = provenanceRepo("docsidian-shaped-generated-root", 399);
    const migrated = jsonCli(["migrate", "bmad.cli-roots", repo, "--json"]);
    assert.equal(migrated.payload.ok, true, JSON.stringify(migrated.payload));
    assert.equal(existsSync(join(repo, ".adal")), false, "399-file manifest-attested generated root should be removable");
    for (const cliRoot of supportedRoots) {
      assert.equal(existsSync(join(repo, cliRoot, "skills", "bmad-demo", "SKILL.md")), true, `${cliRoot} required projection`);
    }
    const finding = jsonCli(["audit", repo, "--json"]).payload.rules.find((rule) => rule.id === "bmad.cli-roots");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  for (const variant of ["modified", "outside-inventory"]) {
    const repo = provenanceRepo(`generated-root-${variant}`, 2);
    if (variant === "modified") writeFileSync(join(repo, ".adal", "skills", "bmad-demo", "SKILL.md"), "locally changed\n");
    else writeFileSync(join(repo, ".adal", "notes.txt"), "user file\n");
    const migrated = jsonCli(["migrate", "bmad.cli-roots", repo, "--json"]);
    assert.notEqual(migrated.result.status, 0);
    assert.equal(migrated.payload.results[0].status, "blocked");
    assert.equal(existsSync(join(repo, ".adal")), true, `${variant} root must be preserved`);
  }

  console.log("PJAN-57 env/TOML/provenance dogfood regressions: PASS");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
