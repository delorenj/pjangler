import assert from "node:assert/strict";
import {
  existsSync,
  copyFileSync,
  cpSync,
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
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  PACK_FIXTURE_SKILLS,
  createBmadInstallerFixture,
  createSkillPackFixture,
} from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const sourceCli = join(root, "dist", "index.js");
const tmp = mkdtempSync(join(tmpdir(), "pjangler-skillex-init-"));
const runMiseIntegration = process.env.PJ_RUN_MISE_INTEGRATION === "1";
const homeDir = join(tmp, "home");
// The fixture's registry checkout. Pinned as rung 0 of the ONE pack-resolution
// ladder (PACKS-CONTRACT section 2 step 3) rather than left to the default rungs:
// the implicit BMAD pin resolves exactly like a declared pack now, so with no pin
// this hermetic HOME would resolve the pack out of whichever checkout `sync-skills.py`
// happened to clone into `~/.agents/.cache/registries/`, over the network.
const fixtureRegistryRoot = join(homeDir, "code", "skillex");
const bmadPack = createSkillPackFixture(fixtureRegistryRoot);
const bmadInstaller = createBmadInstallerFixture(tmp);
const bmadFixtureVersion = basename(bmadPack);
const cacheRoot = join(homeDir, ".cache");
mkdirSync(join(cacheRoot, "pjangler"), { recursive: true });
writeFileSync(
  join(cacheRoot, "pjangler", "bmad-dist-tags.json"),
  JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: bmadFixtureVersion, next: bmadFixtureVersion } }),
);

function cleanBaseEnv() {
  const env = { ...process.env };
  delete env.PJ_PACK_ROOT_PJTEST;
  delete env.PJ_PACK_ROOT_PJTEST;
  env.PJ_SKILLS_REGISTRY_ROOT = fixtureRegistryRoot;
  env.PJ_BMAD_INSTALLER = bmadInstaller;
  env.XDG_CACHE_HOME = cacheRoot;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tmp,
    env: { ...cleanBaseEnv(), ...options.env },
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
    env: { ...cleanBaseEnv(), ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.notEqual(result.status, 0, `expected failure: ${command} ${args.join(" ")}`);
  return `${result.stdout}\n${result.stderr}`;
}

function packSkillNames() {
  return readdirSync(bmadPack)
    .filter((name) => name.startsWith("pjtest-") && lstatSync(join(bmadPack, name)).isDirectory())
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
  // PJAN-76: BMAD is not a Skillex pack. `bmad-method install` writes bmad-*
  // into .agents/skills itself, so the manifest must not name any of them —
  // two writers for one path is what broke when the registry dropped the pack.
  const bmadEntries = manifest.skills.filter((entry) => entry?.name?.startsWith("bmad-"));
  assert.deepEqual(
    bmadEntries.map((entry) => entry.name),
    [],
    "skills.json must not record bmad-* entries; bmad-method owns them",
  );

  const skillsDir = join(projectDir, ".agents", "skills");
  const installedBmad = readdirSync(skillsDir).filter((name) => name.startsWith("bmad-"));
  assert.ok(installedBmad.length > 0, "the installer must have written bmad-* skills into .agents/skills");
  for (const name of installedBmad) {
    assert.equal(
      lstatSync(join(skillsDir, name)).isSymbolicLink(),
      false,
      `${name} must be the installer's real directory, not a pack symlink`,
    );
  }

  const customSkill = join(skillsDir, "project-custom");
  mkdirSync(customSkill, { recursive: true });
  writeFileSync(join(customSkill, "SKILL.md"), "# Project custom skill\n");
  manifest.skills.unshift({ name: "project-custom", source: `file://${customSkill}` });
  // PJAN-76: a generated project declares no packs, so the pack machinery below
  // (projection, idempotence, self-healing) needs one declared to be about.
  manifest.packs = [{ name: "pjtest", version: basename(bmadPack) }];
  writeFileSync(join(projectDir, ".agents", "skills.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(join(projectDir, ".codex"), { recursive: true });
  const projectEnv = { HOME: homeDir };
  run("python3", [join(projectDir, ".mise", "scripts", "provision-packs.py"), "--root", projectDir], {
    cwd: projectDir,
    env: projectEnv,
  });
  run("python3", [join(projectDir, ".mise", "scripts", "sync-skills.py"), "--scope", "project", "--root", projectDir], {
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
    MISE_IGNORED_CONFIG_PATHS: join(tmp, "ignored-mise-config.toml"),
    MISE_CEILING_PATHS: tmp,
    MISE_TRUSTED_CONFIG_PATHS: tmp,
  };
  if (runMiseIntegration) {
    run("mise", ["run", "skills:sync"], {
      cwd: projectDir,
      env: miseEnv,
    });
  }

  assert.equal(existsSync(join(customSkill, "SKILL.md")), true, "non-BMAD project skill must survive reprovisioning");
  const reprovisioned = JSON.parse(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"));
  assert.deepEqual(reprovisioned.skills[0], { name: "project-custom", source: `file://${customSkill}` });
  assert.equal(lstatSync(join(projectDir, ".codex", "skills", "pjtest-agent-pm")).isSymbolicLink(), true, "canonical engine must be runnable by mise");

  const brokenLink = join(skillsDir, "pjtest-agent-pm");
  unlinkSync(brokenLink);
  symlinkSync(join(tmp, "missing-pjtest-agent-pm"), brokenLink);
  run("python3", [join(projectDir, ".mise", "scripts", "provision-packs.py"), "--root", projectDir], {
    cwd: projectDir,
    env: projectEnv,
  });
  assert.equal(resolve(dirname(brokenLink), readlinkSync(brokenLink)), join(bmadPack, "pjtest-agent-pm"), "broken pack links must self-heal");
  const beforeIdempotent = readFileSync(join(projectDir, ".agents", "skills.json"), "utf8");
  run("python3", [join(projectDir, ".mise", "scripts", "provision-packs.py"), "--root", projectDir], {
    cwd: projectDir,
    env: projectEnv,
  });
  assert.equal(readFileSync(join(projectDir, ".agents", "skills.json"), "utf8"), beforeIdempotent, "BMAD provisioning must be idempotent");

  return {
    mise,
    bmadEntries: reprovisioned.skills.filter((entry) => entry?.name?.startsWith("bmad-")),
    bmadSkills: readdirSync(skillsDir).filter((name) => name.startsWith("bmad-")).sort(),
    customPreserved: existsSync(join(customSkill, "SKILL.md")),
  };
}

function assertAdversarialBoundaries(projectDir, homeDir) {
  const manifestPath = join(projectDir, ".agents", "skills.json");
  const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const syncScript = join(projectDir, ".mise", "scripts", "sync-skills.py");
  const env = { HOME: homeDir };
  const cliSentinel = join(projectDir, ".codex", "sentinel");
  writeFileSync(cliSentinel, "do-not-delete\n");

  for (const name of ["../sentinel", ".", "..", join(tmp, "absolute-skill")]) {
    const malicious = {
      ...originalManifest,
      skills: [{ name, source: pathToFileURL(join(bmadPack, "pjtest-agent-pm")).href }, ...originalManifest.skills],
    };
    writeFileSync(manifestPath, `${JSON.stringify(malicious, null, 2)}\n`);
    runExpectFailure("python3", [syncScript, "--scope", "project", "--root", projectDir], { cwd: projectDir, env });
    assert.equal(readFileSync(cliSentinel, "utf8"), "do-not-delete\n", `malicious name ${name} must not touch outside sentinel`);
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...originalManifest, skills: [{ name: "remote-file", source: "file://attacker.example/tmp/skill" }] }, null, 2)}\n`
  );
  assert.match(
    runExpectFailure("python3", [syncScript, "--scope", "project", "--root", projectDir], { cwd: projectDir, env }),
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
  run("python3", [syncScript, "--scope", "project", "--root", projectDir], { cwd: projectDir, env });
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
  runExpectFailure("python3", [syncScript, "--scope", "project", "--root", projectDir], { cwd: projectDir, env });
  assert.equal(readFileSync(join(outsideCli, "sentinel"), "utf8"), "outside-cli-safe\n");
  assert.equal(existsSync(join(outsideCli, "skills")), false, "symlinked CLI parent must not receive fanout");

  const outsideSkills = join(tmp, "outside-skills");
  mkdirSync(outsideSkills);
  writeFileSync(join(outsideSkills, "sentinel"), "outside-skills-safe\n");
  rmSync(join(projectDir, ".agents", "skills"), { recursive: true, force: true });
  symlinkSync(outsideSkills, join(projectDir, ".agents", "skills"), "dir");
  runExpectFailure("python3", [join(projectDir, ".mise", "scripts", "provision-packs.py"), "--root", projectDir], {
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
      },
    }
  );
  const result = JSON.parse(output);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return { projectDir, contract: assertProjectContract(projectDir, homeDir) };
}

function assertProvisionerRejectsUntrustedPacks(projectDir, homeDir) {
  const provisioner = join(projectDir, ".mise", "scripts", "provision-packs.py");
  const manifestPath = join(projectDir, ".agents", "skills.json");
  const originalManifest = readFileSync(manifestPath, "utf8");

  const partialPack = join(tmp, "partial-bmad-pack");
  mkdirSync(partialPack);
  copyFileSync(join(bmadPack, "SHA256SUMS"), join(partialPack, "SHA256SUMS"));
  copyFileSync(join(bmadPack, "pack.toml"), join(partialPack, "pack.toml"));
  cpSync(join(bmadPack, "pjtest-agent-pm"), join(partialPack, "pjtest-agent-pm"), { recursive: true });
  const partialFailure = runExpectFailure("python3", [provisioner, "--root", projectDir], {
    cwd: projectDir,
    env: { HOME: homeDir, PJ_PACK_ROOT_PJTEST: partialPack },
  });
  // A partial pack no longer trips a bespoke "coverage" check: under the
  // generic contract every DECLARED skill directory must exist before the
  // payload can even be hashed. For a SEALED pack that is an integrity failure,
  // not "the pack is not installed here" — the seal is a completeness claim, so
  // `optional: true` must not be able to downgrade it to a warning.
  assert.match(partialFailure, /failed integrity verification/);
  assert.match(partialFailure, /is not present/);
  assert.equal(readFileSync(manifestPath, "utf8"), originalManifest, "partial pack rejection must precede manifest mutation");

  const tamperedPack = join(tmp, "tampered-bmad-pack");
  cpSync(bmadPack, tamperedPack, { recursive: true });
  writeFileSync(join(tamperedPack, "pjtest-agent-pm", "SKILL.md"), "tampered\n");
  const tamperedFailure = runExpectFailure("python3", [provisioner, "--root", projectDir], {
    cwd: projectDir,
    env: { HOME: homeDir, PJ_PACK_ROOT_PJTEST: tamperedPack },
  });
  assert.match(tamperedFailure, /digest mismatch/);
  assert.equal(readFileSync(manifestPath, "utf8"), originalManifest, "tampered pack rejection must precede manifest mutation");

  copyFileSync(join(bmadPack, "pjtest-agent-pm", "SKILL.md"), join(tamperedPack, "pjtest-agent-pm", "SKILL.md"));
  mkdirSync(join(tamperedPack, "pjtest-agent-pm", "unauthenticated-empty"));
  const topologyFailure = runExpectFailure("python3", [provisioner, "--root", projectDir], {
    cwd: projectDir,
    env: { HOME: homeDir, PJ_PACK_ROOT_PJTEST: tamperedPack },
  });
  assert.match(topologyFailure, /unauthenticated empty directories/);
  assert.equal(readFileSync(manifestPath, "utf8"), originalManifest, "unauthenticated topology rejection must precede manifest mutation");
}

try {
  assert.deepEqual(
    packSkillNames(),
    [...PACK_FIXTURE_SKILLS].sort(),
    "generated BMAD pack must expose its authenticated fixture inventory",
  );
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
  assert.deepEqual(installed.contract.bmadSkills, source.contract.bmadSkills, "source and packed-installed BMAD skill sets must match");
  assert.equal(source.contract.customPreserved && installed.contract.customPreserved, true);
  assertAdversarialBoundaries(source.projectDir, homeDir);
  assertProvisionerRejectsUntrustedPacks(source.projectDir, homeDir);

  // PJAN-84: a repo's own skills/ reaches the CLIs, and a globally-inherited
  // name is never copied in beside it.
  //
  // pjangler authored pjangler-dev and pjangler-parity-rules — the two skills
  // describing how to develop pjangler — and projected neither anywhere, so they
  // were invisible to every agent developing pjangler. Meanwhile seven links
  // duplicated skills the global scope already provides.
  {
    const repo = join(tmp, "repo-local-discovery");
    const home = join(tmp, "repo-local-home");
    const registry = join(tmp, "repo-local-registry");
    mkdirSync(join(repo, ".mise", "scripts"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    mkdirSync(join(registry, "all-skills"), { recursive: true });
    const engine = join(repo, ".mise", "scripts", "sync-skills.py");
    copyFileSync(join(root, "templates", "commonproject", "template", ".mise", "scripts", "sync-skills.py"), engine);

    for (const name of ["shared-wide", "repo-only-a", "repo-only-b"]) {
      mkdirSync(join(repo, "skills", name), { recursive: true });
      writeFileSync(join(repo, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    // The global scope already provides `shared-wide`, pointing at this repo —
    // exactly how pjangler's machine-wide skills are declared.
    writeFileSync(
      join(home, ".agents", "skills.json"),
      `${JSON.stringify({ scope: "global", skills: [{ name: "shared-wide", source: `file://${join(repo, "skills", "shared-wide")}` }] }, null, 2)}\n`
    );
    writeFileSync(join(repo, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: true, skills: [] }, null, 2)}\n`);
    // A leftover duplicate of the inherited name, of the shape the pre-PJAN-82
    // materializing fan-out left behind.
    symlinkSync(join(repo, "skills", "shared-wide"), join(repo, ".claude", "skills", "shared-wide"), "dir");

    const syncEnv = { HOME: home, PJ_SKILLS_REGISTRY_ROOT: registry };
    run("python3", [engine, "--scope", "project", "--root", repo], { cwd: repo, env: syncEnv });

    const projected = readdirSync(join(repo, ".claude", "skills")).sort();
    assert.deepEqual(projected, ["repo-only-a", "repo-only-b"], `repo-local skills are projected and the inherited one is not copied: ${projected.join(", ")}`);
    assert.equal(
      readlinkSync(join(repo, ".claude", "skills", "repo-only-a")),
      join(repo, "skills", "repo-only-a"),
      "a discovered skill links straight at the repo's own directory"
    );

    // A second run must change nothing: discovery is derived from the directory,
    // so there is no declaration to drift from it.
    const before = readdirSync(join(repo, ".claude", "skills")).sort().join("|");
    run("python3", [engine, "--scope", "project", "--root", repo], { cwd: repo, env: syncEnv });
    assert.equal(readdirSync(join(repo, ".claude", "skills")).sort().join("|"), before, "repo-local discovery must be idempotent");

    // An explicit declaration still wins over discovery.
    const overrideSource = join(registry, "all-skills", "repo-only-a");
    mkdirSync(overrideSource, { recursive: true });
    writeFileSync(join(overrideSource, "SKILL.md"), "---\nname: repo-only-a\n---\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      `${JSON.stringify({ inherit_global: true, skills: [{ name: "repo-only-a", source: `file://${overrideSource}` }] }, null, 2)}\n`
    );
    run("python3", [engine, "--scope", "project", "--root", repo], { cwd: repo, env: syncEnv });
    assert.equal(
      readlinkSync(join(repo, ".claude", "skills", "repo-only-a")),
      overrideSource,
      "an explicit skills[] entry overrides the discovered repo-local directory"
    );
  }

  const miseMode = runMiseIntegration ? "mise integration exercised" : "mise integration skipped";
  console.log(`Skillex init regressions passed (fresh HOME generated BMAD pack; ${miseMode})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
