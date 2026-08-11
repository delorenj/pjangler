import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionBmadSkills, type BmadProvisionHooks, type Context } from "../src/parity/index";
import { BMAD_FIXTURE_SKILLS, createBmadPackFixture } from "./helpers/bmad-fixture.mjs";

const pjanglerRoot = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "pjangler-bmad-transaction-"));
const sourcePack = createBmadPackFixture(join(temporary, "registry"));
const previousPack = process.env.PJ_BMAD_PACK_ROOT;
const previousGenericPack = process.env.PJ_PACK_ROOT_BMAD;

function selectPack(pack: string): void {
  process.env.PJ_BMAD_PACK_ROOT = pack;
  process.env.PJ_PACK_ROOT_BMAD = pack;
}

function snapshot(path: string): unknown {
  if (!existsSync(path) && !lstatMaybe(path)) return ["missing"];
  const stat = lstatSync(path);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return ["symlink", mode, readlinkSync(path)];
  if (stat.isFile()) return ["file", mode, readFileSync(path).toString("hex")];
  if (stat.isDirectory()) return [
    "directory",
    mode,
    readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]),
  ];
  return ["special", mode];
}

function lstatMaybe(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function fixture(label: string): { context: Context; pack: string; project: string } {
  const root = join(temporary, label);
  const pack = join(root, "pack");
  cpSync(sourcePack, pack, { recursive: true });
  const project = join(root, "project");
  const skills = join(project, ".agents", "skills");
  mkdirSync(skills, { recursive: true });
  const manifest = join(project, ".agents", "skills.json");
  writeFileSync(manifest, '{"skills":[{"name":"custom","source":"file:///custom"}]}\n');
  chmodSync(manifest, 0o600);
  mkdirSync(join(skills, "bmad-agent-pm"));
  writeFileSync(join(skills, "bmad-agent-pm", "legacy.txt"), "preserve exactly\n");
  symlinkSync(join(pack, "bmad-agent-analyst"), join(skills, "bmad-agent-analyst"), "dir");
  symlinkSync(join(pack, "bmad-stale"), join(skills, "bmad-stale"), "dir");
  mkdirSync(join(skills, "custom"));
  writeFileSync(join(skills, "custom", "SKILL.md"), "custom\n");
  return {
    context: { repoRoot: project, dryRun: false, pjanglerRoot, homeDir: join(root, "home") },
    pack,
    project,
  };
}

try {
  {
    const { context, pack, project } = fixture("link-failure");
    selectPack(pack);
    const before = snapshot(project);
    const hooks: BmadProvisionHooks = {
      createLink(target, link, index) {
        if (index === 5) throw new Error("injected fifth-link failure");
        symlinkSync(target, link, "dir");
      },
    };
    const result = provisionBmadSkills(context, null, hooks);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error ?? "", /fifth-link/);
    assert.deepEqual(snapshot(project), before, "Nth-link failure must restore exact project state");
  }

  {
    const { context, pack, project } = fixture("pack-mutation");
    selectPack(pack);
    const before = snapshot(project);
    const result = provisionBmadSkills(context, null, {
      afterPreflight() {
        writeFileSync(join(pack, "bmad-agent-pm", "SKILL.md"), "mutated after preflight\n");
      },
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error ?? "", /digest mismatch/);
    assert.deepEqual(snapshot(project), before, "post-preflight pack mutation must restore exact project state");
  }

  {
    const root = join(temporary, "malformed-manifest");
    const pack = join(root, "pack");
    cpSync(sourcePack, pack, { recursive: true });
    const project = join(root, "project");
    const agents = join(project, ".agents");
    mkdirSync(agents, { recursive: true });
    const manifest = join(agents, "skills.json");
    writeFileSync(manifest, "{malformed\n");
    chmodSync(manifest, 0o600);
    selectPack(pack);
    const before = snapshot(project);
    const result = provisionBmadSkills({ repoRoot: project, dryRun: false, pjanglerRoot, homeDir: join(root, "home") });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error ?? "", /Invalid existing skills manifest/);
    assert.deepEqual(snapshot(project), before, "malformed manifest failure must not mutate project state");
    assert.equal(existsSync(join(agents, "skills")), false);
    assert.equal(readdirSync(agents).some((name) => name.startsWith(".bmad-transaction-")), false);
  }

  {
    const root = join(temporary, "symlinked-manifest");
    const pack = join(root, "pack");
    cpSync(sourcePack, pack, { recursive: true });
    const project = join(root, "project");
    const agents = join(project, ".agents");
    mkdirSync(agents, { recursive: true });
    const outside = join(root, "outside-skills.json");
    writeFileSync(outside, '{"packs":[{"name":"outside","source":"file:///does/not/exist"}]}\n');
    symlinkSync(outside, join(agents, "skills.json"));
    selectPack(pack);
    const before = snapshot(project);
    const result = provisionBmadSkills({ repoRoot: project, dryRun: false, pjanglerRoot, homeDir: join(root, "home") });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error ?? "", /Refusing unsafe skills manifest/);
    assert.doesNotMatch(result.error ?? "", /outside.*could not be resolved/);
    assert.deepEqual(snapshot(project), before, "symlinked manifest must be rejected before pack resolution or mutation");
    assert.equal(existsSync(join(agents, "skills")), false);
  }

  {
    const { context, pack, project } = fixture("projection-mismatch");
    selectPack(pack);
    const before = snapshot(project);
    const result = provisionBmadSkills(context, null, {
      afterApply(_manifest, skills) {
        const link = join(skills, "bmad-agent-analyst");
        unlinkSync(link);
        symlinkSync("/tmp/wrong-after-apply", link, "dir");
      },
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error ?? "", /link differs from plan/);
    assert.deepEqual(snapshot(project), before, "applied projection mismatch must restore exact project state");
  }

  {
    const { context, pack, project } = fixture("success");
    selectPack(pack);
    const first = provisionBmadSkills(context);
    assert.equal(first.ok, true, JSON.stringify(first));
    const after = snapshot(project);
    const second = provisionBmadSkills(context);
    // `packWarnings` carries PACKS-CONTRACT section 3b advisories. BMAD is not a
    // flattened pack, so an EMPTY array here is itself the assertion: nothing in
    // a flat pack may ever produce one.
    assert.deepEqual(second, { ok: true, changedFiles: [], packWarnings: [] });
    assert.deepEqual(snapshot(project), after, "successful rerun must be idempotent");
    const skills = join(project, ".agents", "skills");
    assert.equal(
      readdirSync(skills).filter((name) => name.startsWith("bmad-")).length,
      BMAD_FIXTURE_SKILLS.length,
    );
  }

  console.log("BMAD transactional projection regressions passed");
} finally {
  if (previousPack === undefined) delete process.env.PJ_BMAD_PACK_ROOT;
  else process.env.PJ_BMAD_PACK_ROOT = previousPack;
  if (previousGenericPack === undefined) delete process.env.PJ_PACK_ROOT_BMAD;
  else process.env.PJ_PACK_ROOT_BMAD = previousGenericPack;
  rmSync(temporary, { recursive: true, force: true });
}
