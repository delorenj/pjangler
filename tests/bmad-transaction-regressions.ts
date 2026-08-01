import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionBmadSkills, type BmadProvisionHooks, type Context } from "../src/parity/index";

const pjanglerRoot = resolve(import.meta.dirname, "..");
const sourcePack = resolve(
  process.env.PJ_BMAD_PACK_ROOT?.trim() || "/home/delorenj/code/skillex/packs/bmad/6.10.1-next.31"
);
assert.equal(existsSync(sourcePack), true, `candidate pack missing: ${sourcePack}`);
const temporary = mkdtempSync(join(tmpdir(), "pjangler-bmad-transaction-"));
const previousPack = process.env.PJ_BMAD_PACK_ROOT;

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
  symlinkSync("/tmp/stale-target", join(skills, "bmad-stale"), "dir");
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
    process.env.PJ_BMAD_PACK_ROOT = pack;
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
    process.env.PJ_BMAD_PACK_ROOT = pack;
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
    const { context, pack, project } = fixture("success");
    process.env.PJ_BMAD_PACK_ROOT = pack;
    const first = provisionBmadSkills(context);
    assert.equal(first.ok, true, JSON.stringify(first));
    const after = snapshot(project);
    const second = provisionBmadSkills(context);
    assert.deepEqual(second, { ok: true, changedFiles: [] });
    assert.deepEqual(snapshot(project), after, "successful rerun must be idempotent");
    const skills = join(project, ".agents", "skills");
    assert.equal(readdirSync(skills).filter((name) => name.startsWith("bmad-")).length, 76);
  }

  console.log("BMAD transactional projection regressions passed");
} finally {
  if (previousPack === undefined) delete process.env.PJ_BMAD_PACK_ROOT;
  else process.env.PJ_BMAD_PACK_ROOT = previousPack;
  rmSync(temporary, { recursive: true, force: true });
}
