import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const sourceCli = join(root, "dist", "index.js");
const tmp = mkdtempSync(join(tmpdir(), "pjangler-skillex-init-"));
const explicitBmadPack = process.env.PJ_BMAD_PACK_ROOT?.trim();
const runMiseIntegration = process.env.PJ_RUN_MISE_INTEGRATION === "1";
const bmadPack = explicitBmadPack
  ? resolve(explicitBmadPack)
  : join(tmp, "fixtures", "packs", "bmad", "6.10.1-next.31");

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

function runExpectFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tmp,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.notEqual(result.status, 0, `expected failure: ${command} ${args.join(" ")}`);
  return `${result.stdout}\n${result.stderr}`;
}

function bmadSkillNames() {
  return readdirSync(bmadPack)
    .filter((name) => name.startsWith("bmad-") && lstatSync(join(bmadPack, name)).isDirectory())
    .sort();
}

function assertProjectContract(projectDir, homeDir) {
  const mise = readFileSync(join(projectDir, "mise.toml"), "utf8");
  assert.match(mise, /\{\{config_root\}\}\/\.mise\/scripts\/sync-skills\.py/, "mise must resolve the shipped project-local engine through config_root");
  assert.doesNotMatch(mise, /\$HOME\/\.agents\/scripts\/sync-skills\.py/, "mise must not depend on a host-global skills engine");
  assert.doesNotMatch(mise, /(?:script|run) = "sync-skills(?:\.py)? --scope project"/, "mise must not invoke a missing bare sync-skills executable");
  assert.doesNotMatch(mise, /~\/\.agents\/scripts/, "mise must not depend on tilde expansion in _.path");
  assert.equal(existsSync(join(projectDir, ".mise", "scripts", "sync-skills.py")), true, "fresh init must ship its configured skills sync engine");

  const manifest = JSON.parse(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"));
  const bmadEntries = manifest.skills.filter((entry) => entry?.name?.startsWith("bmad-"));
  assert.deepEqual(bmadEntries.map((entry) => entry.name), bmadSkillNames());
  assert.ok(
    bmadEntries.every(
      (entry) =>
        Object.keys(entry).sort().join(",") === "name,source" &&
        entry.source === `file://${join(bmadPack, entry.name)}`
    ),
    "BMAD manifest entries must use the live {name, file:// source} schema and pinned 6.10.1-next.31 pack"
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
  const projectEnv = { HOME: homeDir, PJ_BMAD_PACK_ROOT: bmadPack };
  run("python3", [join(projectDir, ".mise", "scripts", "provision-bmad-skills.py")], {
    cwd: projectDir,
    env: projectEnv,
  });
  run("python3", [join(projectDir, ".mise", "scripts", "sync-skills.py"), "--scope", "project"], {
    cwd: projectDir,
    env: projectEnv,
  });

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
  if (runMiseIntegration) {
    run("mise", ["run", "skills-sync"], {
      cwd: projectDir,
      env: { ...miseEnv, PJ_BMAD_PACK_ROOT: bmadPack },
    });
  }

  assert.equal(existsSync(join(customSkill, "SKILL.md")), true, "non-BMAD project skill must survive reprovisioning");
  const reprovisioned = JSON.parse(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"));
  assert.deepEqual(reprovisioned.skills[0], { name: "project-custom", source: `file://${customSkill}` });
  assert.equal(lstatSync(join(projectDir, ".codex", "skills", "bmad-agent-pm")).isSymbolicLink(), true, "canonical engine must be runnable by mise");

  const brokenLink = join(skillsDir, "bmad-agent-pm");
  unlinkSync(brokenLink);
  symlinkSync(join(tmp, "missing-bmad-agent-pm"), brokenLink);
  run("python3", [join(projectDir, ".mise", "scripts", "provision-bmad-skills.py")], {
    cwd: projectDir,
    env: projectEnv,
  });
  assert.equal(resolve(dirname(brokenLink), readlinkSync(brokenLink)), join(bmadPack, "bmad-agent-pm"), "broken BMAD links must self-heal");
  const beforeIdempotent = readFileSync(join(projectDir, ".agents", "skills.json"), "utf8");
  run("python3", [join(projectDir, ".mise", "scripts", "provision-bmad-skills.py")], {
    cwd: projectDir,
    env: projectEnv,
  });
  assert.equal(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"), beforeIdempotent, "BMAD provisioning must be idempotent");

  return {
    mise,
    bmadEntries: reprovisioned.skills.filter((entry) => entry?.name?.startsWith("bmad-")),
    bmadLinks: bmadSkillNames().map((name) => resolve(skillsDir, readlinkSync(join(skillsDir, name)))),
    customPreserved: existsSync(join(customSkill, "SKILL.md")),
  };
}

function assertAdversarialBoundaries(projectDir, homeDir) {
  const manifestPath = join(projectDir, ".agents", "skills.json");
  const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const syncScript = join(projectDir, ".mise", "scripts", "sync-skills.py");
  const env = { HOME: homeDir, PJ_BMAD_PACK_ROOT: bmadPack };
  const cliSentinel = join(projectDir, ".codex", "sentinel");
  writeFileSync(cliSentinel, "do-not-delete\n");

  for (const name of ["../sentinel", ".", "..", join(tmp, "absolute-skill")]) {
    const malicious = {
      ...originalManifest,
      skills: [{ name, source: pathToFileURL(join(bmadPack, "bmad-agent-pm")).href }, ...originalManifest.skills],
    };
    writeFileSync(manifestPath, `${JSON.stringify(malicious, null, 2)}\n`);
    runExpectFailure("python3", [syncScript, "--scope", "project"], { cwd: projectDir, env });
    assert.equal(readFileSync(cliSentinel, "utf8"), "do-not-delete\n", `malicious name ${name} must not touch outside sentinel`);
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...originalManifest, skills: [{ name: "remote-file", source: "file://attacker.example/tmp/skill" }] }, null, 2)}\n`
  );
  assert.match(
    runExpectFailure("python3", [syncScript, "--scope", "project"], { cwd: projectDir, env }),
    /Non-local file URI authority/
  );
  assert.equal(readFileSync(cliSentinel, "utf8"), "do-not-delete\n");

  const encodedSource = join(tmp, "encoded skill # 100%");
  mkdirSync(encodedSource, { recursive: true });
  writeFileSync(join(encodedSource, "SKILL.md"), "# encoded URI\n");
  const encodedManifest = {
    ...originalManifest,
    skills: [{ name: "encoded-custom", source: pathToFileURL(encodedSource).href }, ...originalManifest.skills],
  };
  writeFileSync(manifestPath, `${JSON.stringify(encodedManifest, null, 2)}\n`);
  run("python3", [syncScript, "--scope", "project"], { cwd: projectDir, env });
  assert.equal(
    resolve(dirname(join(projectDir, ".codex", "skills", "encoded-custom")), readlinkSync(join(projectDir, ".codex", "skills", "encoded-custom"))),
    encodedSource,
    "encoded file URI must resolve spaces, #, and %"
  );

  writeFileSync(manifestPath, `${JSON.stringify(originalManifest, null, 2)}\n`);
  const outsideCli = join(tmp, "outside-cli");
  mkdirSync(outsideCli);
  writeFileSync(join(outsideCli, "sentinel"), "outside-cli-safe\n");
  rmSync(join(projectDir, ".codex"), { recursive: true, force: true });
  symlinkSync(outsideCli, join(projectDir, ".codex"), "dir");
  runExpectFailure("python3", [syncScript, "--scope", "project"], { cwd: projectDir, env });
  assert.equal(readFileSync(join(outsideCli, "sentinel"), "utf8"), "outside-cli-safe\n");
  assert.equal(existsSync(join(outsideCli, "skills")), false, "symlinked CLI parent must not receive fanout");

  const outsideSkills = join(tmp, "outside-skills");
  mkdirSync(outsideSkills);
  writeFileSync(join(outsideSkills, "sentinel"), "outside-skills-safe\n");
  rmSync(join(projectDir, ".agents", "skills"), { recursive: true, force: true });
  symlinkSync(outsideSkills, join(projectDir, ".agents", "skills"), "dir");
  runExpectFailure("python3", [join(projectDir, ".mise", "scripts", "provision-bmad-skills.py")], {
    cwd: projectDir,
    env,
  });
  assert.equal(readFileSync(join(outsideSkills, "sentinel"), "utf8"), "outside-skills-safe\n");
  assert.equal(readdirSync(outsideSkills).length, 1, "symlinked .agents/skills must not be mutated");
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
  if (!explicitBmadPack) {
    for (const name of ["bmad-agent-pm", "bmad-create-prd"]) {
      mkdirSync(join(bmadPack, name), { recursive: true });
      writeFileSync(join(bmadPack, name, "SKILL.md"), `# ${name}\n`);
    }
  }
  assert.ok(bmadSkillNames().length > 0, "BMAD 6.10.1-next.31 pack is required");

  const homeDir = join(tmp, "home");
  mkdirSync(homeDir, { recursive: true });
  assert.equal(
    existsSync(join(homeDir, ".agents", "scripts", "sync-skills.py")),
    false,
    "E2E home must not mask a missing generated executable with host-global provisioning"
  );

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
  assertAdversarialBoundaries(source.projectDir, homeDir);

  const packMode = explicitBmadPack ? "explicit integration pack" : "hermetic fixture";
  const miseMode = runMiseIntegration ? "mise integration exercised" : "mise integration skipped";
  console.log(`Skillex init regressions passed (${packMode}; ${miseMode})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
