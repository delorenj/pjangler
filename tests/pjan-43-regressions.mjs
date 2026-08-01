import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const selectedBmadPack = resolve(
  process.env.PJ_BMAD_PACK_ROOT?.trim() ||
    "/home/delorenj/code/skillex/packs/bmad/6.10.1-next.31",
);
const cleanup = [];

function makeHome(name) {
  const home = mkdtempSync(join(tmpdir(), `pjan-43-${name}-home-`));
  cleanup.push(home);
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const cache = join(home, ".cache", "pjangler");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(cache, "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { next: "6.10.1-next.31" } }),
  );
  return home;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjan-43-${name}-repo-`));
  cleanup.push(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture agent rules\n");
  writeFileSync(join(repo, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  return repo;
}

function command(args, { cwd = root, home = makeHome("default"), extraEnv = {} } = {}) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      PJ_BMAD_PACK_ROOT: selectedBmadPack,
      ...extraEnv,
    },
  });
}

function jsonCommand(args, options) {
  const result = command(args, options);
  assert.ok(result.stdout.trim(), `expected JSON output\nstderr:\n${result.stderr}`);
  return { result, json: JSON.parse(result.stdout) };
}

function finding(report, id) {
  const value = report.rules.find((entry) => entry.id === id);
  assert.ok(value, `missing audit finding ${id}`);
  return value;
}

function migrationResult(report, id) {
  const value = report.results.find((entry) => entry.id === id);
  assert.ok(value, `missing migration result ${id}`);
  return value;
}

function writeCanonicalGitignore(repo) {
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\n!.env.op\n");
}

try {
  for (const script of ["provision-bmad-skills.py", "sync-skills.py"]) {
    const packagedTemplate = join(root, "templates", "commonproject", "template", ".mise", "scripts", script);
    assert.notEqual(
      lstatSync(packagedTemplate).mode & 0o111,
      0,
      `packaged CommonProject executable mode must survive a fresh projection: ${script}`,
    );
  }

  {
    const repo = makeRepo("skills-safe-alias");
    const home = makeHome("skills-safe-alias");
    const custom = join(repo, ".agents", "skills", "custom-real");
    const privateCustom = join(repo, ".agents", "skills", "bmad-private-custom");
    mkdirSync(custom, { recursive: true });
    mkdirSync(privateCustom, { recursive: true });
    mkdirSync(join(repo, ".agents", "skills", "bmad-agent-pm"), { recursive: true });
    writeFileSync(join(custom, "SKILL.md"), "custom must survive\n");
    writeFileSync(join(privateCustom, "SKILL.md"), "private custom must survive\n");
    writeFileSync(join(repo, ".agents", "skills", "bmad-agent-pm", "COPIED"), "replace canonical collision\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      `${JSON.stringify({
        unrelated_top_level: { keep: true },
        skills: [
          { name: "custom-real", source: `file://${custom}` },
          { name: "bmad-private-custom", source: `file://${privateCustom}` },
        ],
      }, null, 2)}\n`,
    );
    mkdirSync(join(repo, ".claude"));
    symlinkSync("../.agents/skills", join(repo, ".claude", "skills"), "dir");

    const first = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(first, "skills.project-manifest").status, "applied");
    assert.equal(readFileSync(join(custom, "SKILL.md"), "utf8"), "custom must survive\n");
    assert.equal(readFileSync(join(privateCustom, "SKILL.md"), "utf8"), "private custom must survive\n");
    assert.equal(readlinkSync(join(repo, ".claude", "skills")), "../.agents/skills");
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.deepEqual(manifest.unrelated_top_level, { keep: true });
    assert.deepEqual(manifest.skills[0], { name: "custom-real", source: `file://${custom}` });
    assert.deepEqual(manifest.skills[1], { name: "bmad-private-custom", source: `file://${privateCustom}` });
    assert.ok(manifest.skills.slice(2).every((entry) => entry.name.startsWith("bmad-")));
    assert.equal(lstatSync(join(repo, ".agents", "skills", "bmad-agent-pm")).isSymbolicLink(), true);

    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(audit, "skills.project-manifest").status, "pass", JSON.stringify(finding(audit, "skills.project-manifest")));
    const second = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(second, "skills.project-manifest").status, "noop");

    const provisionScript = join(repo, ".mise", "scripts", "provision-bmad-skills.py");
    const syncScript = join(repo, ".mise", "scripts", "sync-skills.py");
    const canonicalProvisionBytes = readFileSync(provisionScript);
    const canonicalSyncBytes = readFileSync(syncScript);
    chmodSync(provisionScript, 0o644);
    chmodSync(syncScript, 0o644);
    const modeAudit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const modeDrift = finding(modeAudit, "skills.project-manifest");
    assert.equal(modeDrift.status, "fail");
    assert.equal(modeDrift.details.filter((detail) => detail.includes("is not executable")).length, 2);
    assert.doesNotMatch(modeDrift.details.join("\n"), /differs from the shipped template/);

    const modeRepair = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(modeRepair, "skills.project-manifest").status, "applied");
    assert.deepEqual(readFileSync(provisionScript), canonicalProvisionBytes);
    assert.deepEqual(readFileSync(syncScript), canonicalSyncBytes);
    assert.notEqual(lstatSync(provisionScript).mode & 0o111, 0);
    assert.notEqual(lstatSync(syncScript).mode & 0o111, 0);
    const modePostAudit = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(modePostAudit, "skills.project-manifest").status, "pass", JSON.stringify(finding(modePostAudit, "skills.project-manifest")));
    const modeNoop = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(modeNoop, "skills.project-manifest").status, "noop");

    writeFileSync(syncScript, `${readFileSync(syncScript, "utf8")}\n# drift\n`);
    chmodSync(syncScript, 0o644);
    const driftAudit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const drift = finding(driftAudit, "skills.project-manifest");
    assert.equal(drift.status, "fail");
    assert.match(drift.details.join("\n"), /differs from the shipped template/);
    assert.match(drift.details.join("\n"), /not executable/);
    const driftRepair = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(driftRepair, "skills.project-manifest").status, "applied");
    assert.deepEqual(readFileSync(syncScript), canonicalSyncBytes);
    assert.notEqual(lstatSync(syncScript).mode & 0o111, 0);
    const driftNoop = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(driftNoop, "skills.project-manifest").status, "noop");
  }

  {
    const repo = makeRepo("skills-script-directory-blocker");
    const home = makeHome("skills-script-directory-blocker");
    const initial = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    assert.equal(migrationResult(initial, "skills.project-manifest").status, "applied");
    const target = join(repo, ".mise", "scripts", "provision-bmad-skills.py");
    rmSync(target);
    mkdirSync(target);
    const sentinel = join(target, "user-sentinel.txt");
    writeFileSync(sentinel, "must remain byte-identical\n");
    const beforeEntries = readdirSync(target);
    const beforeSentinel = readFileSync(sentinel);

    const unsafeAudit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const unsafeFinding = finding(unsafeAudit, "skills.project-manifest");
    assert.equal(unsafeFinding.status, "fail");
    assert.equal(unsafeFinding.fixable, false);
    assert.match(unsafeFinding.details.join("\n"), /missing or unsafe/);

    const blocked = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    const blockedResult = migrationResult(blocked, "skills.project-manifest");
    assert.equal(blockedResult.status, "blocked", JSON.stringify(blockedResult));
    assert.deepEqual(blockedResult.changedFiles, []);
    assert.deepEqual(readdirSync(target), beforeEntries);
    assert.deepEqual(readFileSync(sentinel), beforeSentinel);
    const postAudit = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(postAudit, "skills.project-manifest").status, "fail");
    assert.equal(finding(postAudit, "skills.project-manifest").fixable, false);
  }

  {
    const repo = makeRepo("skills-unsafe-external");
    const home = makeHome("skills-unsafe-external");
    const managed = join(repo, ".agents", "skills");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "custom-sentinel"), "do-not-touch\n");
    mkdirSync(join(repo, ".claude"));
    const outside = mkdtempSync(join(tmpdir(), "pjan-43-outside-skills-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "outside-sentinel"), "do-not-touch\n");
    symlinkSync(outside, join(repo, ".claude", "skills"), "dir");

    const beforeManaged = readdirSync(managed);
    const beforeOutside = readdirSync(outside);
    const report = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], { home }).json;
    const result = migrationResult(report, "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /unsupported skills directory symlink/);
    assert.deepEqual(readdirSync(managed), beforeManaged);
    assert.deepEqual(readdirSync(outside), beforeOutside);
    assert.equal(existsSync(join(repo, ".mise", "scripts")), false, "unsafe topology must fail before project mutation");
  }

  {
    const repo = makeRepo("env-op-comment");
    const home = makeHome("env-op-comment");
    writeCanonicalGitignore(repo);
    const validLine = "VALID_USER_REFERENCE=op://RealVault/RealItem/RealField";
    writeFileSync(join(repo, ".env.op"), `# generated example: op://Vault/Item\n${validLine}\n`);
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const stale = finding(audit, "secrets.env-op");
    assert.equal(stale.status, "fail");
    assert.match(stale.details.join("\n"), /line\(s\): 1/);

    const migrated = jsonCommand(["migrate", "secrets.env-op", repo, "--json"], { home }).json;
    assert.equal(migrationResult(migrated, "secrets.env-op").status, "applied");
    const content = readFileSync(join(repo, ".env.op"), "utf8");
    assert.doesNotMatch(content, /op:\/\/Vault\/Item/);
    assert.match(content, /invalid 1Password reference removed by pjangler/);
    assert.match(content, new RegExp(validLine.replaceAll("/", "\\/")));
    const current = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(current, "secrets.env-op").status, "pass", JSON.stringify(finding(current, "secrets.env-op")));
  }

  {
    const repo = makeRepo("bmad-selected-module");
    const home = makeHome("bmad-selected-module");
    mkdirSync(join(repo, "_bmad", "_config"), { recursive: true });
    mkdirSync(join(repo, "_bmad", "core"), { recursive: true });
    writeFileSync(join(repo, "_bmad", "core", "config.yaml"), "core: true\n");
    writeFileSync(join(repo, "_bmad", "config.toml"), '[core]\nproject_name = "fixture"\n\n[modules.tea]\ntest_artifacts = "out"\n');
    writeFileSync(
      join(repo, "_bmad", "_config", "manifest.yaml"),
      "installation:\n  version: 6.10.1-next.31\nmodules:\n  - name: core\n  - name: tea\n",
    );
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const stale = finding(audit, "bmad.scaffold");
    assert.equal(stale.status, "fail");
    assert.deepEqual(stale.details, ["_bmad/tea/config.yaml"]);

    const fakeBin = mkdtempSync(join(tmpdir(), "pjan-43-fake-npx-"));
    cleanup.push(fakeBin);
    const invocation = join(fakeBin, "invocation.txt");
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(
      fakeNpx,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "${invocation}"
repo=''
modules=''
while (( $# )); do
  case "$1" in
    --directory) repo="$2"; shift 2 ;;
    --modules) modules="$2"; shift 2 ;;
    *) shift ;;
  esac
done
IFS=',' read -ra selected <<< "$modules"
for module in "${'${selected[@]}'}"; do
  [[ -z "$module" ]] && continue
  mkdir -p "$repo/_bmad/$module"
  printf 'module: %s\\n' "$module" > "$repo/_bmad/$module/config.yaml"
done
`,
    );
    chmodSync(fakeNpx, 0o755);
    const migrated = jsonCommand(["migrate", "bmad.scaffold", repo, "--json"], {
      home,
      extraEnv: { PATH: `${fakeBin}:${process.env.PATH}` },
    }).json;
    assert.equal(migrationResult(migrated, "bmad.scaffold").status, "applied", JSON.stringify(migrationResult(migrated, "bmad.scaffold")));
    const args = readFileSync(invocation, "utf8");
    assert.match(args, /--modules tea(?:\s|$)/);
    assert.doesNotMatch(args, /--modules [^\n]*bmm/);
    const current = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(current, "bmad.scaffold").status, "pass", JSON.stringify(finding(current, "bmad.scaffold")));
  }

  {
    const repo = makeRepo("all-skip-filter");
    const home = makeHome("all-skip-filter");
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const skipped = audit.rules.filter((entry) => entry.status === "skip").map((entry) => entry.id);
    assert.ok(skipped.some((id) => id.startsWith("hermes.")), "fixture should contain skipped no-PM Hermes rules");
    const all = jsonCommand(["migrate", "--all", repo, "--dry-run", "--json"], { home }).json;
    assert.deepEqual(all.selectedRules.filter((id) => skipped.includes(id)), [], "--all must not select audit-skipped rules");
    assert.equal(all.results.some((entry) => skipped.includes(entry.id) && entry.status === "blocked"), false);
  }

  {
    const repo = makeRepo("bmad-malformed-module-manifest");
    const home = makeHome("bmad-malformed-module-manifest");
    const manifestPath = join(repo, "_bmad", "_config", "manifest.yaml");
    mkdirSync(join(repo, "_bmad", "_config"), { recursive: true });
    const malformed = "installation:\n  version: 6.10.1-next.31\nmodules:\n  - name: tea\n  - [unterminated\n";
    writeFileSync(manifestPath, malformed);
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const blocker = finding(audit, "bmad.scaffold");
    assert.equal(blocker.status, "fail", JSON.stringify(blocker));
    assert.equal(blocker.fixable, false);
    assert.match(blocker.summary, /invalid.*refusing fallback/i);

    const fakeBin = mkdtempSync(join(tmpdir(), "pjan-43-malformed-manifest-npx-"));
    cleanup.push(fakeBin);
    const invocation = join(fakeBin, "invoked");
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(fakeNpx, `#!/usr/bin/env bash\nprintf invoked > "${invocation}"\nexit 97\n`);
    chmodSync(fakeNpx, 0o755);
    const migrated = jsonCommand(["migrate", "bmad.scaffold", repo, "--json"], {
      home,
      extraEnv: { PATH: `${fakeBin}:${process.env.PATH}` },
    }).json;
    const blocked = migrationResult(migrated, "bmad.scaffold");
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.deepEqual(blocked.changedFiles, []);
    assert.equal(existsSync(invocation), false, "invalid manifest must block before invoking default modules");
    assert.equal(readFileSync(manifestPath, "utf8"), malformed);
    for (const module of ["bmm", "bmb", "cis", "tea"]) {
      assert.equal(existsSync(join(repo, "_bmad", module)), false, `invalid manifest must not mutate ${module}`);
    }
    const all = jsonCommand(["migrate", "--all", repo, "--dry-run", "--json"], { home }).json;
    assert.equal(all.selectedRules.includes("bmad.scaffold"), false);
  }

  for (const selection of [
    { name: "core-only", modules: "  - name: core\n" },
    { name: "custom-only", modules: "  - core\n  - custom\n" },
  ]) {
    const repo = makeRepo(`bmad-${selection.name}`);
    const home = makeHome(`bmad-${selection.name}`);
    mkdirSync(join(repo, "_bmad", "_config"), { recursive: true });
    writeFileSync(join(repo, "_bmad", "config.toml"), '[core]\nproject_name = "fixture"\n\n[custom]\n');
    const manifestPath = join(repo, "_bmad", "_config", "manifest.yaml");
    writeFileSync(
      manifestPath,
      `installation:\n  version: 6.10.1-next.31\nmodules:\n${selection.modules}`,
    );
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.deepEqual(finding(audit, "bmad.scaffold").details, ["_bmad/core/config.yaml"]);

    const fakeBin = mkdtempSync(join(tmpdir(), `pjan-43-${selection.name}-npx-`));
    cleanup.push(fakeBin);
    const invocation = join(fakeBin, "invocation.txt");
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(
      fakeNpx,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "${invocation}"
repo=''
modules=''
while (( $# )); do
  case "$1" in
    --directory) repo="$2"; shift 2 ;;
    --modules) modules="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ "$modules" == "core" ]] || { printf 'expected explicit core-only selection, got %s\\n' "$modules" >&2; exit 91; }
mkdir -p "$repo/_bmad/core"
printf 'core: true\\n' > "$repo/_bmad/core/config.yaml"
`,
    );
    chmodSync(fakeNpx, 0o755);
    const migrated = jsonCommand(["migrate", "bmad.scaffold", repo, "--json"], {
      home,
      extraEnv: { PATH: `${fakeBin}:${process.env.PATH}` },
    }).json;
    assert.equal(migrationResult(migrated, "bmad.scaffold").status, "applied", JSON.stringify(migrationResult(migrated, "bmad.scaffold")));
    assert.match(readFileSync(invocation, "utf8"), /--modules core(?:\s|$)/);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, `${selection.name} manifest selection must be preserved`);
    const current = jsonCommand(["audit", repo, "--json"], { home }).json;
    assert.equal(finding(current, "bmad.scaffold").status, "pass", JSON.stringify(finding(current, "bmad.scaffold")));
  }

  {
    const repo = makeRepo("registry-unprovisioned");
    const home = makeHome("registry-unprovisioned");
    const roleDir = join(repo, "agents", "hermes", "pm");
    writeFileSync(
      join(repo, ".project.json"),
      `${JSON.stringify({ project_name: "fixture", agents: { "fixture-pm": { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "provisioned" } } }, null, 2)}\n`,
    );
    const registryPath = join(home, ".hermes", "agents-registry.yaml");
    writeFileSync(
      registryPath,
      `agents:\n  fixture-pm:\n    role_dir: ${roleDir}\n    hermes:\n      bin: /missing/hermes\n`,
    );
    const registryBefore = readFileSync(registryPath, "utf8");
    const projectBefore = readFileSync(join(repo, ".project.json"), "utf8");
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const blocker = finding(audit, "hermes.registry-parity");
    assert.equal(blocker.status, "fail", JSON.stringify(blocker));
    assert.equal(blocker.fixable, false);
    assert.match(blocker.details.join("\n"), /provision or restore the role, do not delete/);

    const explicit = jsonCommand(["migrate", "hermes.registry-parity", repo, "--json"], { home }).json;
    assert.equal(migrationResult(explicit, "hermes.registry-parity").status, "blocked");
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
    assert.equal(readFileSync(join(repo, ".project.json"), "utf8"), projectBefore);
    const all = jsonCommand(["migrate", "--all", repo, "--dry-run", "--json"], { home }).json;
    assert.equal(all.selectedRules.includes("hermes.registry-parity"), false, "non-fixable blocker must not be auto-selected by --all");
  }

  {
    const repo = makeRepo("registry-mixed-provisioning");
    const home = makeHome("registry-mixed-provisioning");
    const validRoleDir = join(repo, "agents", "hermes", "pm");
    const missingRoleDir = join(repo, "agents", "hermes", "secondary-pm");
    mkdirSync(validRoleDir, { recursive: true });
    mkdirSync(missingRoleDir, { recursive: true });
    writeFileSync(join(validRoleDir, "role.yaml"), "repo: fixture\nrole: pm\nagent_id: valid-pm\nprofile: valid-pm\n");
    writeFileSync(
      join(repo, ".project.json"),
      `${JSON.stringify({
        project_name: "fixture",
        agents: {
          "valid-pm": { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "provisioned" },
          "unprovisioned-pm": { role: "pm", role_dir: "agents/hermes/secondary-pm", provisioning_state: "provisioned" },
        },
      }, null, 2)}\n`,
    );
    const registryPath = join(home, ".hermes", "agents-registry.yaml");
    writeFileSync(
      registryPath,
      `agents:\n  valid-pm:\n    role_dir: ${validRoleDir}\n    hermes: {}\n  unprovisioned-pm:\n    role_dir: ${missingRoleDir}\n    hermes: {}\n`,
    );
    const registryBefore = readFileSync(registryPath, "utf8");
    const projectBefore = readFileSync(join(repo, ".project.json"), "utf8");

    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const blocker = finding(audit, "hermes.registry-parity");
    assert.equal(blocker.status, "fail", JSON.stringify(blocker));
    assert.equal(blocker.fixable, false);
    assert.match(blocker.details.join("\n"), /unprovisioned-pm/);
    assert.match(blocker.details.join("\n"), /provision or restore the role, do not delete/);

    const explicit = jsonCommand(["migrate", "hermes.registry-parity", repo, "--json"], { home }).json;
    assert.equal(migrationResult(explicit, "hermes.registry-parity").status, "blocked", JSON.stringify(migrationResult(explicit, "hermes.registry-parity")));
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore, "mixed topology must preserve unprovisioned registry entry");
    assert.equal(readFileSync(join(repo, ".project.json"), "utf8"), projectBefore, "mixed topology must preserve unprovisioned declaration");
    const all = jsonCommand(["migrate", "--all", repo, "--dry-run", "--json"], { home }).json;
    assert.equal(all.selectedRules.includes("hermes.registry-parity"), false);
  }

  {
    // Disposable downstream proof shaped like a generated HeyMa checkout.  It
    // deliberately uses only temp paths and a fake HOME; the live HeyMa repo,
    // real Hermes registry, and user systemd state are never opened or mutated.
    const repo = makeRepo("heyma-shaped-downstream");
    const home = makeHome("heyma-shaped-downstream");
    writeFileSync(
      join(repo, ".project.json"),
      `${JSON.stringify({ project_name: "HeyMa Fixture", project_slug: "heyma-fixture", repo_path: repo, agents: {} }, null, 2)}\n`,
    );
    writeCanonicalGitignore(repo);
    writeFileSync(
      join(repo, ".env.op"),
      "# generated placeholder op://Vault/Item\nVALID_FIXTURE_REF=op://FixtureVault/FixtureItem/FixtureField\n",
    );
    const custom = join(repo, ".agents", "skills", "heyma-custom");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "SKILL.md"), "fixture custom skill\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      `${JSON.stringify({ fixture_metadata: "preserve", skills: [{ name: "heyma-custom", source: `file://${custom}` }] }, null, 2)}\n`,
    );
    mkdirSync(join(repo, ".claude"));
    symlinkSync("../.agents/skills", join(repo, ".claude", "skills"), "dir");
    mkdirSync(join(repo, "_bmad", "_config"), { recursive: true });
    mkdirSync(join(repo, "_bmad", "core"), { recursive: true });
    writeFileSync(join(repo, "_bmad", "core", "config.yaml"), "core: true\n");
    writeFileSync(join(repo, "_bmad", "config.toml"), '[core]\nproject_name = "HeyMa Fixture"\n');
    writeFileSync(
      join(repo, "_bmad", "_config", "manifest.yaml"),
      "installation:\n  version: 6.10.1-next.31\nmodules:\n  - name: core\n",
    );

    const migrated = jsonCommand(["migrate", "--all", repo, "--json"], { home }).json;
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.equal(migrated.results.some((entry) => entry.status === "blocked"), false);
    assert.equal(readFileSync(join(custom, "SKILL.md"), "utf8"), "fixture custom skill\n");
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.equal(manifest.fixture_metadata, "preserve");
    assert.deepEqual(manifest.skills[0], { name: "heyma-custom", source: `file://${custom}` });
    assert.equal(readlinkSync(join(repo, ".claude", "skills")), "../.agents/skills");
    assert.match(readFileSync(join(repo, ".env.op"), "utf8"), /VALID_FIXTURE_REF=op:\/\/FixtureVault\/FixtureItem\/FixtureField/);
    const audit = jsonCommand(["audit", repo, "--json"], { home }).json;
    const actionable = audit.rules.filter((entry) => entry.fixable && (entry.status === "fail" || entry.status === "warn"));
    assert.deepEqual(actionable, [], `post-migrate fixture should have no actionable drift: ${JSON.stringify(actionable)}`);
  }

  console.log("PJAN-43 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
