// PJAN-28 — legacy committed skills under `.agents/skills/` used to be silently
// ignored: the audit walk only validated BMAD pack symlinks and skipped
// everything else, so a repo could carry committed skills that no manifest knew
// about and nothing ever said so.
//
// The audit now enumerates every unmanaged entry, and
// `migrate skills.project-manifest` proposes a mapping for each one — applied
// only behind the explicit `--accept-registry-matches` opt-in.
//
// Fully hermetic: the "registry" (SKILLS_REGISTRY_URL) is a plain git repo with
// no API, so a content match can only be made against a checkout that already
// exists on disk. Every case here pins PJ_SKILLS_REGISTRY_ROOT at a temp
// fixture (or deliberately omits it), so no test in this file touches the
// network, and HOME is always a throwaway directory.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createBmadPackFixture } from "./helpers/bmad-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const bmadFixtureRoot = mkdtempSync(join(tmpdir(), "pjan-28-bmad-fixture-"));
const selectedBmadPack = createBmadPackFixture(bmadFixtureRoot);
const cleanup = [bmadFixtureRoot];

/** Byte-for-byte content of the upstream skill the fixture registry publishes. */
const UPSTREAM_SKILL = {
  "SKILL.md": "---\nname: pristine-upstream\n---\n# Pristine Upstream\n",
  "references/notes.md": "upstream notes\n",
};

function makeHome(name) {
  const home = mkdtempSync(join(tmpdir(), `pjan-28-${name}-home-`));
  cleanup.push(home);
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const cache = join(home, ".cache", "pjangler");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(cache, "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { next: "6.11.1-next.1" } }),
  );
  return home;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjan-28-${name}-repo-`));
  cleanup.push(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture agent rules\n");
  writeFileSync(join(repo, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  return repo;
}

function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(base, rel);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return base;
}

/** Offline stand-in for a `git clone` of SKILLS_REGISTRY_URL. */
function makeRegistry(name, skills) {
  const registry = mkdtempSync(join(tmpdir(), `pjan-28-${name}-registry-`));
  cleanup.push(registry);
  for (const [skillName, files] of Object.entries(skills)) {
    writeTree(join(registry, "all-skills", skillName), files);
  }
  return registry;
}

function committedSkill(repo, name, files) {
  return writeTree(join(repo, ".agents", "skills", name), files);
}

function command(args, { home, registryRoot } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    PJ_BMAD_PACK_ROOT: selectedBmadPack,
    PJ_PACK_ROOT_BMAD: selectedBmadPack,
  };
  delete env.PJ_SKILLS_REGISTRY_ROOT;
  if (registryRoot) env.PJ_SKILLS_REGISTRY_ROOT = registryRoot;
  return spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    // An absent override must never fall back to a live clone; the two cases
    // below that omit it prove the "no local checkout" path stays offline.
    env,
  });
}

function jsonCommand(args, options) {
  const result = command(args, options);
  assert.ok(result.stdout.trim(), `expected JSON output\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
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

function manifestOf(repo) {
  return JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
}

function manifestEntry(repo, name) {
  return manifestOf(repo).skills.find((entry) => entry?.name === name);
}

function skillsBak(repo) {
  return join(repo, ".agents", "skills.bak");
}

try {
  // 1. Audit surfaces unmanaged committed skills and names every one of them.
  {
    const repo = makeRepo("audit-unmanaged");
    const home = makeHome("audit-unmanaged");
    const registry = makeRegistry("audit-unmanaged", { "pristine-upstream": UPSTREAM_SKILL });
    committedSkill(repo, "pristine-upstream", UPSTREAM_SKILL);
    committedSkill(repo, "hand-rolled", { "SKILL.md": "# Hand rolled\n" });
    committedSkill(repo, "recorded", { "SKILL.md": "# Recorded\n" });
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      `${JSON.stringify(
        { skills: [{ name: "recorded", source: `file://${join(repo, ".agents", "skills", "recorded")}` }] },
        null,
        2,
      )}\n`,
    );

    const audit = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    const value = finding(audit, "skills.project-manifest");
    assert.equal(value.status, "fail");
    assert.equal(value.fixable, true, "unmanaged committed skills must be reported as fixable");
    assert.match(value.summary, /2 unmanaged committed skill\(s\)/, value.summary);
    for (const name of ["hand-rolled", "pristine-upstream"]) {
      assert.ok(
        value.details.some((detail) => detail === `.agents/skills/${name} is committed but absent from .agents/skills.json`),
        `finding must enumerate ${name}: ${JSON.stringify(value.details)}`,
      );
    }
    assert.doesNotMatch(
      value.details.join("\n"),
      /skills\/recorded is committed/,
      "a skill already recorded in the manifest is managed and must not be reported",
    );
  }

  // 2. Without --accept-registry-matches, migrate REPORTS the mapping per entry
  //    and changes nothing: no manifest write, no backup dir, no moved files.
  {
    const repo = makeRepo("dry-mapping");
    const home = makeHome("dry-mapping");
    const registry = makeRegistry("dry-mapping", { "pristine-upstream": UPSTREAM_SKILL });
    committedSkill(repo, "pristine-upstream", UPSTREAM_SKILL);
    committedSkill(repo, "hand-rolled", { "SKILL.md": "# Hand rolled\n" });

    const report = jsonCommand(["migrate", "skills.project-manifest", repo, "--json"], {
      home,
      registryRoot: registry,
    });
    const result = migrationResult(report, "skills.project-manifest");
    assert.notEqual(result.status, "blocked", JSON.stringify(result));
    const detailText = result.details.join("\n");
    assert.match(detailText, /proposed mapping: pristine-upstream -> registry_path all-skills\/pristine-upstream/, detailText);
    assert.match(detailText, /proposed mapping: hand-rolled -> file:\/\/.*skills\.bak\/hand-rolled/, detailText);
    assert.match(detailText, /re-run with --accept-registry-matches to apply/i, detailText);
    assert.equal(existsSync(skillsBak(repo)), false, "reporting must not create the backup directory");
    assert.equal(
      readFileSync(join(repo, ".agents", "skills", "hand-rolled", "SKILL.md"), "utf8"),
      "# Hand rolled\n",
      "reporting must not move originals",
    );
    for (const name of ["pristine-upstream", "hand-rolled"]) {
      assert.equal(manifestEntry(repo, name), undefined, `reporting must not record ${name} in the manifest`);
    }
    assert.equal(
      result.changedFiles.some((file) => file.includes("skills.bak")),
      false,
      "reporting must not claim backup writes",
    );

    // The finding is unchanged by a report-only run, so this stays actionable.
    const audit = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    assert.match(finding(audit, "skills.project-manifest").summary, /2 unmanaged committed skill\(s\)/);
  }

  // 3. With the flag: a confident (byte-identical) registry hit becomes a
  //    registry_path entry, the original is preserved under .agents/skills.bak,
  //    and a second run is a noop that does NOT re-process the backup.
  {
    const repo = makeRepo("apply-mapping");
    const home = makeHome("apply-mapping");
    const registry = makeRegistry("apply-mapping", { "pristine-upstream": UPSTREAM_SKILL });
    committedSkill(repo, "pristine-upstream", UPSTREAM_SKILL);

    const report = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--json"],
      { home, registryRoot: registry },
    );
    const result = migrationResult(report, "skills.project-manifest");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.match(result.details.join("\n"), /mapped pristine-upstream -> registry_path all-skills\/pristine-upstream \(exact content match\)/);
    assert.deepEqual(
      manifestEntry(repo, "pristine-upstream"),
      { name: "pristine-upstream", registry_path: "all-skills/pristine-upstream" },
      "a confident match must be recorded by registry_path, not by source",
    );
    assert.equal(
      readFileSync(join(skillsBak(repo), "pristine-upstream", "SKILL.md"), "utf8"),
      UPSTREAM_SKILL["SKILL.md"],
      "originals must be moved to .agents/skills.bak, never deleted",
    );
    assert.equal(
      readFileSync(join(skillsBak(repo), "pristine-upstream", "references", "notes.md"), "utf8"),
      UPSTREAM_SKILL["references/notes.md"],
      "the whole original tree must survive the move",
    );
    assert.equal(
      existsSync(join(repo, ".agents", "skills", "pristine-upstream")),
      false,
      "a mapped entry must no longer sit unmanaged under .agents/skills",
    );
    // The manifest still carries the canonical Skillex contract afterwards.
    const manifest = manifestOf(repo);
    assert.equal(manifest.inherit_global, true);
    assert.equal(manifest.registry, "https://github.com/delorenj/skillex.git");

    const audit = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    assert.equal(
      finding(audit, "skills.project-manifest").status,
      "pass",
      JSON.stringify(finding(audit, "skills.project-manifest")),
    );

    // Idempotency: the backup directory is a SIBLING of .agents/skills, so the
    // walk can never see its own output. Prove it never nests or re-reports.
    const second = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--json"],
      { home, registryRoot: registry },
    );
    assert.equal(migrationResult(second, "skills.project-manifest").status, "noop", JSON.stringify(second));
    assert.deepEqual(readdirSync(skillsBak(repo)).sort(), ["pristine-upstream"]);
    assert.equal(existsSync(join(skillsBak(repo), "skills.bak")), false, "the backup must never back itself up");
    assert.equal(
      manifestOf(repo).skills.filter((entry) => entry?.name === "pristine-upstream").length,
      1,
      "re-running must not duplicate the mapped entry",
    );

    // A skills-sync projection of a mapped entry (a symlink from .agents/skills
    // back into .agents/skills.bak) must not restart the drift loop either.
    symlinkSync(
      join(skillsBak(repo), "pristine-upstream"),
      join(repo, ".agents", "skills", "pristine-upstream"),
      "dir",
    );
    const projected = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    assert.equal(
      finding(projected, "skills.project-manifest").status,
      "pass",
      JSON.stringify(finding(projected, "skills.project-manifest")),
    );
  }

  // 4. A registry NON-match is kept local via file:// — never silently swapped
  //    for the upstream skill of the same name.
  {
    const repo = makeRepo("registry-non-match");
    const home = makeHome("registry-non-match");
    const registry = makeRegistry("registry-non-match", { "pristine-upstream": UPSTREAM_SKILL });
    const customized = {
      ...UPSTREAM_SKILL,
      "SKILL.md": `${UPSTREAM_SKILL["SKILL.md"]}\nLocal customization that must not be lost.\n`,
    };
    committedSkill(repo, "pristine-upstream", customized);

    const report = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--json"],
      { home, registryRoot: registry },
    );
    assert.equal(migrationResult(report, "skills.project-manifest").status, "applied");
    const entry = manifestEntry(repo, "pristine-upstream");
    assert.equal(
      entry.registry_path,
      undefined,
      "a customized skill must never be mapped onto the same-named upstream skill",
    );
    assert.equal(entry.source, `file://${join(skillsBak(repo), "pristine-upstream")}`);
    assert.equal(
      readFileSync(join(skillsBak(repo), "pristine-upstream", "SKILL.md"), "utf8"),
      customized["SKILL.md"],
      "the customized content must survive verbatim",
    );
    const audit = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    assert.equal(finding(audit, "skills.project-manifest").status, "pass");
  }

  // 5. With no local registry checkout at all, matching degrades to "keep it
  //    local" — it must never reach for the network.
  {
    const repo = makeRepo("registry-absent");
    const home = makeHome("registry-absent");
    committedSkill(repo, "pristine-upstream", UPSTREAM_SKILL);

    const report = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--json"],
      { home },
    );
    const result = migrationResult(report, "skills.project-manifest");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.match(result.details.join("\n"), /No local https:\/\/github\.com\/delorenj\/skillex\.git checkout is available/);
    const entry = manifestEntry(repo, "pristine-upstream");
    assert.equal(entry.registry_path, undefined);
    assert.equal(entry.source, `file://${join(skillsBak(repo), "pristine-upstream")}`);
  }

  // 6. Existing behaviour is untouched. BMAD pack symlink validation still
  //    works, and the BMAD namespace (including off-pack installer output such
  //    as bmad-build) is owned by bmad.scaffold, not by this rule — flagging it
  //    would fight the installer and never converge.
  {
    const repo = makeRepo("bmad-untouched");
    const home = makeHome("bmad-untouched");
    const registry = makeRegistry("bmad-untouched", {});
    committedSkill(repo, "bmad-build", { "SKILL.md": "# Off-pack installer output\n" });
    committedSkill(repo, "bmad-agent-pm", { COPIED: "legacy copied tree\n" });

    const before = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    const stale = finding(before, "skills.project-manifest");
    assert.doesNotMatch(stale.summary, /unmanaged committed skill/, stale.summary);
    assert.match(
      stale.details.join("\n"),
      new RegExp(`managed pack skill path\\(s\\) should be symlinks into their declared Skillex pack`),
      "pack symlink validation must still fire",
    );

    const report = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--json"],
      { home, registryRoot: registry },
    );
    assert.equal(migrationResult(report, "skills.project-manifest").status, "applied");
    assert.equal(
      lstatSync(join(repo, ".agents", "skills", "bmad-agent-pm")).isSymbolicLink(),
      true,
      "a copied pack tree must still be replaced by a pack symlink",
    );
    assert.equal(
      existsSync(join(skillsBak(repo), "bmad-build")),
      false,
      "BMAD-namespace entries must not be swept into the backup directory",
    );
    assert.equal(manifestEntry(repo, "bmad-build"), undefined);
    const after = jsonCommand(["audit", repo, "--json"], { home, registryRoot: registry });
    assert.equal(
      finding(after, "skills.project-manifest").status,
      "pass",
      JSON.stringify(finding(after, "skills.project-manifest")),
    );
  }

  // 7. --dry-run with the flag reports the writes it would make and performs
  //    none of them.
  {
    const repo = makeRepo("dry-run-flag");
    const home = makeHome("dry-run-flag");
    const registry = makeRegistry("dry-run-flag", { "pristine-upstream": UPSTREAM_SKILL });
    committedSkill(repo, "pristine-upstream", UPSTREAM_SKILL);

    const report = jsonCommand(
      ["migrate", "skills.project-manifest", repo, "--accept-registry-matches", "--dry-run", "--json"],
      { home, registryRoot: registry },
    );
    const result = migrationResult(report, "skills.project-manifest");
    assert.ok(
      result.changedFiles.some((file) => file === join(skillsBak(repo), "pristine-upstream")),
      `dry run must plan the backup move: ${JSON.stringify(result.changedFiles)}`,
    );
    assert.equal(existsSync(skillsBak(repo)), false, "dry run must not create the backup directory");
    assert.equal(
      readFileSync(join(repo, ".agents", "skills", "pristine-upstream", "SKILL.md"), "utf8"),
      UPSTREAM_SKILL["SKILL.md"],
      "dry run must leave the original in place",
    );
  }

  console.log("PJAN-28 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
