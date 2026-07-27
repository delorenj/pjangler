import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const sourceCli = join(root, "dist", "index.js");
const canonicalEngine = "/home/delorenj/.agents/scripts/sync-skills.py";
const bmadPack = "/home/delorenj/code/skillex/packs/bmad/6.10.2";
const tmp = mkdtempSync(join(tmpdir(), "pjangler-skillex-init-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tmp,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function bmadSkillNames() {
  return readdirSync(bmadPack)
    .filter((name) => name.startsWith("bmad-") && lstatSync(join(bmadPack, name)).isDirectory())
    .sort();
}

function assertProjectContract(projectDir, homeDir) {
  const mise = readFileSync(join(projectDir, "mise.toml"), "utf8");
  assert.match(mise, /\$HOME\/\.agents\/scripts\/sync-skills\.py/, "mise must resolve the canonical engine through HOME");
  assert.doesNotMatch(mise, /(?:script|run) = "sync-skills(?:\.py)? --scope project"/, "mise must not invoke a missing bare sync-skills executable");
  assert.doesNotMatch(mise, /~\/\.agents\/scripts/, "mise must not depend on tilde expansion in _.path");

  const manifest = JSON.parse(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"));
  const bmadEntries = manifest.skills.filter((entry) => entry?.name?.startsWith("bmad-"));
  assert.deepEqual(bmadEntries.map((entry) => entry.name), bmadSkillNames());
  assert.ok(
    bmadEntries.every(
      (entry) =>
        Object.keys(entry).sort().join(",") === "name,source" &&
        entry.source === `file://${join(bmadPack, entry.name)}`
    ),
    "BMAD manifest entries must use the live {name, file:// source} schema and pinned 6.10.2 pack"
  );

  const skillsDir = join(projectDir, ".agents", "skills");
  for (const name of bmadSkillNames()) {
    const link = join(skillsDir, name);
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${name} must be a symlink`);
    assert.equal(resolve(dirname(link), readlinkSync(link)), join(bmadPack, name));
  }

  const customSkill = join(skillsDir, "project-custom");
  mkdirSync(customSkill, { recursive: true });
  writeFileSync(join(customSkill, "SKILL.md"), "# Project custom skill\n");
  manifest.skills.unshift({ name: "project-custom", source: `file://${customSkill}` });
  writeFileSync(join(projectDir, ".agents", "skills.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(join(projectDir, ".codex"), { recursive: true });
  const miseGlobalConfig = join(homeDir, ".config", "mise", "config.toml");
  mkdirSync(dirname(miseGlobalConfig), { recursive: true });
  if (!existsSync(miseGlobalConfig)) writeFileSync(miseGlobalConfig, "");
  const miseEnv = {
    HOME: homeDir,
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    MISE_GLOBAL_CONFIG_FILE: miseGlobalConfig,
    MISE_IGNORED_CONFIG_PATHS: "/home/delorenj/.config/mise/config.toml",
    MISE_CEILING_PATHS: tmp,
    MISE_TRUSTED_CONFIG_PATHS: tmp,
  };
  run("mise", ["run", "skills-sync"], {
    cwd: projectDir,
    env: { ...miseEnv, PJ_BMAD_PACK_ROOT: bmadPack },
  });

  assert.equal(existsSync(join(customSkill, "SKILL.md")), true, "non-BMAD project skill must survive reprovisioning");
  const reprovisioned = JSON.parse(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"));
  assert.deepEqual(reprovisioned.skills[0], { name: "project-custom", source: `file://${customSkill}` });
  assert.equal(lstatSync(join(projectDir, ".codex", "skills", "bmad-agent-pm")).isSymbolicLink(), true, "canonical engine must be runnable by mise");

  return {
    mise,
    bmadEntries: reprovisioned.skills.filter((entry) => entry?.name?.startsWith("bmad-")),
    bmadLinks: bmadSkillNames().map((name) => resolve(skillsDir, readlinkSync(join(skillsDir, name)))),
    customPreserved: existsSync(join(customSkill, "SKILL.md")),
  };
}

function initWith(cli, label, homeDir) {
  const projectDir = join(tmp, `${label}-project`);
  const registry = join(tmp, `${label}-projects.yaml`);
  const output = run(
    process.execPath,
    [
      cli,
      "init",
      "SkillexParity",
      "--target-dir",
      projectDir,
      "--registry",
      registry,
      "--apply",
      "--json",
    ],
    {
      env: {
        HOME: homeDir,
        PJ_AGENT_HOOKS_LAYER: "0",
        PJ_BMAD_PACK_ROOT: bmadPack,
      },
    }
  );
  const result = JSON.parse(output);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return { projectDir, contract: assertProjectContract(projectDir, homeDir) };
}

try {
  assert.equal(existsSync(canonicalEngine), true, "canonical sync-skills.py engine is required");
  assert.ok(bmadSkillNames().length > 0, "BMAD 6.10.2 pack is required");

  const homeDir = join(tmp, "home");
  mkdirSync(join(homeDir, ".agents", "scripts"), { recursive: true });
  copyFileSync(canonicalEngine, join(homeDir, ".agents", "scripts", "sync-skills.py"));

  const packDir = join(tmp, "pack");
  mkdirSync(packDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root }));
  const packInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const tarball = join(packDir, packInfo.filename);
  const installDir = join(tmp, "installed");
  run("npm", ["install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const installedCli = join(installDir, "node_modules", "@delorenj", "pjangler", "dist", "index.js");
  assert.equal(existsSync(installedCli), true, "packed CLI must install its executable");

  const source = initWith(sourceCli, "source", homeDir);
  const installed = initWith(installedCli, "installed", homeDir);
  assert.equal(installed.contract.mise, source.contract.mise, "source and packed-installed mise contracts must match");
  assert.deepEqual(installed.contract.bmadEntries, source.contract.bmadEntries, "source and packed-installed manifests must match");
  assert.deepEqual(installed.contract.bmadLinks, source.contract.bmadLinks, "source and packed-installed BMAD symlink targets must match");
  assert.equal(source.contract.customPreserved && installed.contract.customPreserved, true);

  console.log("Skillex init regressions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
