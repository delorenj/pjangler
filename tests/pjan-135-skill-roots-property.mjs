// PJAN-135: property test for the CLI skills-root conversion.
//
// Generates random small layouts on the real filesystem (real dirs, relative /
// absolute / dangling / looping / cross-root / sibling links, nested links that
// stay inside or climb out of an entry, executable bits, tracked content) across
// .agents/skills and two or three CLI aliases, then runs the real planner and
// executor and checks, with an oracle independent of the implementation:
//
//   - dry run writes nothing, and apply does exactly what dry run planned;
//   - after apply, every name visible through .agents/skills or any CLI alias
//     before is visible with identical content (bytes, executable bits, nested
//     link text AND what each nested link resolves to);
//   - nothing outside the alias/root areas changed, the git index is unchanged
//     (nothing here is attested BMAD output), and no quarantine is left behind;
//   - repeated applies reach a fixed point with zero operations.
//
// PJ_PROPERTY_ITERATIONS (default 400) and PJ_PROPERTY_SEED reproduce a run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { loadSources, put, rawRepo, repoState } from "./helpers/skill-roots-harness.mjs";

const { applySkillRoots, SUPPORTED_SKILLS_ALIASES } = await loadSources();
const ITERATIONS = Number(process.env.PJ_PROPERTY_ITERATIONS ?? 400);
const SEED = Number(process.env.PJ_PROPERTY_SEED ?? 135);

function prng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, chance: (p) => next() < p, pick: (list) => list[Math.floor(next() * list.length)] };
}

const NAMES = ["a", "b", "c", "d"];
const ALIAS_POOL = [".claude/skills", ".codex/skills", ".gemini/skills"];

/** Build one random layout; returns a human description for failure messages. */
function generate(f, rng) {
  const log = [];
  const ext = join(f.base, "external");
  put(join(ext, "e1", "SKILL.md"), "one\n");
  put(join(ext, "e2", "SKILL.md"), "two\n");
  put(join(f.project, ".claude", "commands", "deploy.md"), "claude cmd\n");
  put(join(f.project, ".agents", "commands", "deploy.md"), "agents cmd\n");
  const aliases = ALIAS_POOL.filter(() => rng.chance(0.75));
  if (aliases.length < 2) aliases.splice(0, aliases.length, ...ALIAS_POOL.slice(0, 2));
  const locations = [];
  const rootMode = rng.next();
  if (rootMode < 0.04) {
    // .agents itself a symlink (to a directory outside the repository).
    rmSync(join(f.project, ".agents"), { recursive: true, force: true });
    put(join(f.base, "shared", "skills", "a", "SKILL.md"), "one\n");
    symlinkSync(join(f.base, "shared"), join(f.project, ".agents"));
    log.push(".agents -> shared");
  } else if (rootMode < 0.2) {
    log.push(".agents/skills absent");
  } else {
    mkdirSync(f.R, { recursive: true });
    locations.push(".agents/skills");
  }
  for (const alias of aliases) {
    const path = join(f.project, alias);
    const mode = rng.next();
    mkdirSync(join(path, ".."), { recursive: true });
    if (mode < 0.72) { mkdirSync(path, { recursive: true }); locations.push(alias); log.push(`${alias}: dir`); }
    else if (mode < 0.82) { symlinkSync("../.agents/skills", path); log.push(`${alias} -> ../.agents/skills`); }
    else if (mode < 0.88) { symlinkSync(f.R, path); log.push(`${alias} -> <abs R>`); }
    else if (mode < 0.94) { symlinkSync("../.agents/gone", path); log.push(`${alias} -> dangling`); }
    else log.push(`${alias}: absent`);
  }
  const tracked = [];
  const made = [];
  for (const location of locations) {
    const dir = join(f.project, location);
    for (const name of NAMES) {
      if (!rng.chance(0.55)) continue;
      const entry = join(dir, name);
      // Often mirror an entry made earlier under the same name: an exact copy,
      // a subset, a superset, or the same link, so duplicates and stubs occur.
      const earlier = made.filter((item) => item.name === name);
      if (earlier.length && rng.chance(0.45)) {
        const source = rng.pick(earlier);
        const variant = rng.pick(["exact", "exact", "subset", "superset", "mode"]);
        spawnSync("cp", ["-a", source.path, entry]);
        if (lstatSync(entry).isDirectory()) {
          const files = readdirSync(entry).filter((file) => lstatSync(join(entry, file)).isFile());
          if (variant === "subset" && files.length > 1) rmSync(join(entry, rng.pick(files)));
          if (variant === "superset") put(join(entry, "extra.md"), "extra\n");
          if (variant === "mode" && files.length) spawnSync("chmod", ["a+x", join(entry, rng.pick(files))]);
        }
        made.push({ name, path: entry });
        log.push(`${location}/${name}: ${variant} copy of ${relative(f.project, source.path)}`);
        if (location !== ".agents/skills" && rng.chance(0.12)) tracked.push(relative(f.project, entry));
        continue;
      }
      made.push({ name, path: entry });
      const kind = rng.next();
      if (kind < 0.45) {
        put(join(entry, "SKILL.md"), rng.pick(["one\n", "two\n"]));
        if (rng.chance(0.5)) put(join(entry, "scripts", "run.sh"), "#!/bin/sh\necho x\n", rng.pick([0o644, 0o755]));
        if (rng.chance(0.25)) put(join(entry, "notes.md"), "n\n");
        const nested = rng.next();
        if (nested < 0.08) symlinkSync("SKILL.md", join(entry, "SKILL.link"));
        else if (nested < 0.12) symlinkSync("../../commands", join(entry, "cmd"));
        else if (nested < 0.16) symlinkSync(`../${rng.pick(NAMES)}`, join(entry, "peer"));
        else if (nested < 0.22) symlinkSync(join(ext, "e1"), join(entry, "ext"));
        log.push(`${location}/${name}: dir`);
      } else if (kind < 0.5) {
        put(entry, rng.pick(["one\n", "two\n"]), rng.pick([0o644, 0o755]));
        log.push(`${location}/${name}: file`);
      } else if (kind < 0.62) {
        const other = rng.pick(NAMES);
        symlinkSync(other, entry);
        log.push(`${location}/${name} -> ${other}`);
      } else if (kind < 0.76) {
        const target = `../../${rng.pick([...aliases, ".agents/skills"])}/${rng.pick(NAMES)}`;
        symlinkSync(target, entry);
        log.push(`${location}/${name} -> ${target}`);
      } else if (kind < 0.9) {
        const target = rng.chance(0.5) ? join(ext, rng.pick(["e1", "e2"])) : `../../../external/${rng.pick(["e1", "e2"])}`;
        symlinkSync(target, entry);
        log.push(`${location}/${name} -> ${target}`);
      } else {
        symlinkSync(`../../missing/${name}`, entry);
        log.push(`${location}/${name} -> dangling`);
      }
      if (location !== ".agents/skills" && rng.chance(0.12)) tracked.push(relative(f.project, entry));
    }
  }
  put(join(f.project, "README.md"), "fixture\n");
  f.git("add", "-f", "README.md", ...tracked);
  f.git("commit", "-qm", "fixture");
  if (tracked.length) log.push(`tracked: ${tracked.join(", ")}`);
  return log;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What following `path` shows: independent of the implementation under test. */
function deepView(path) {
  let real;
  try { real = realpathSync(path); } catch { return null; }
  const describeTarget = (link) => {
    let target;
    try { target = realpathSync(link); } catch { return "dangling"; }
    const stat = statSync(target);
    if (stat.isFile()) return { file: sha(readFileSync(target)), x: stat.mode & 0o111 };
    if (stat.isDirectory()) return { dir: Object.fromEntries(readdirSync(target).sort().map((name) => {
      const child = join(target, name); let s; try { s = statSync(child); } catch { return [name, "dangling"]; }
      return [name, s.isFile() ? sha(readFileSync(child)) : s.isDirectory() ? "dir" : "special"];
    })) };
    return "special";
  };
  const walk = (file) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return { link: readlinkSync(file), target: describeTarget(file) };
    if (stat.isFile()) return { file: sha(readFileSync(file)), x: stat.mode & 0o111 };
    if (stat.isDirectory()) return { dir: Object.fromEntries(readdirSync(file).sort().map((name) => [name, walk(join(file, name))])) };
    return { special: true };
  };
  return walk(real);
}

/** Every visible name through .agents/skills and all six aliases. */
function visible(project) {
  const views = {};
  for (const location of [".agents/skills", ...SUPPORTED_SKILLS_ALIASES]) {
    const path = join(project, location);
    let names;
    try { names = readdirSync(path); } catch { continue; }
    for (const name of names) views[`${location}/${name}`] = deepView(join(path, name));
  }
  return views;
}

/** Is everything `before` shows still shown, identically, by `after`? */
function containedIn(before, after, at) {
  // Nothing was visible (a dangling path shows nothing), so nothing can be lost.
  if (before === null || before === "dangling") return undefined;
  if (after === null || after === undefined) return `${at} is no longer visible`;
  if (typeof before !== "object") return JSON.stringify(before) === JSON.stringify(after) ? undefined : `${at} differs`;
  if ("dir" in before) {
    if (!after.dir) return `${at} is no longer a directory`;
    for (const [name, child] of Object.entries(before.dir)) {
      const gap = containedIn(child, after.dir[name], `${at}/${name}`);
      if (gap) return gap;
    }
    return undefined;
  }
  if ("link" in before) {
    if (before.link !== after.link) return `${at} link text changed ${before.link} -> ${after.link}`;
    return containedIn(before.target, after.target, `${at} (target)`);
  }
  return JSON.stringify(before) === JSON.stringify(after) ? undefined : `${at} content or mode changed`;
}

/** Files outside every alias/root area: path -> inode + bytes. They must never change. */
function outside(project) {
  const areas = [".agents/skills", ".agents/.pjangler-quarantine", ...SUPPORTED_SKILLS_ALIASES].map((alias) => join(project, alias));
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === join(project, ".git") || areas.includes(path)) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else files[relative(project, path)] = [stat.ino, stat.isSymbolicLink() ? readlinkSync(path) : sha(readFileSync(path))];
    }
  };
  walk(project);
  return files;
}

const plannedOps = (result) => result.details.filter((line) => !line.startsWith("blocked:")).map((line) => line.replace(/^would /, ""));

test(`random layouts: apply either blocks without touching anything or preserves every visible name (${ITERATIONS} layouts, seed ${SEED})`, () => {
  const outcomes = { converted: 0, blocked: 0, mixed: 0 };
  const kinds = new Map();
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const seed = SEED * 100003 + iteration;
    const rng = prng(seed);
    const f = rawRepo("prop");
    try {
      const layout = generate(f, rng);
      const context = () => `seed ${seed}:\n  ${layout.join("\n  ")}`;
      let state = repoState(f.project);
      const external = repoState(join(f.base, "external"));
      for (let run = 0; run < 5; run++) {
        const views = visible(f.project);
        const untouched = outside(f.project);
        const dry = applySkillRoots(f.project, { dryRun: true });
        assert.deepEqual(repoState(f.project), state, `dry run wrote something\n${context()}`);
        const applied = applySkillRoots(f.project, { dryRun: false });
        assert.ok(!applied.blocks.some((reason) => /rolled back|stopped at/.test(reason)),
          `apply disagreed with its own plan: ${applied.blocks.join("\n")}\n${context()}`);
        assert.equal(applied.ok, dry.ok, `dry ${dry.ok} vs apply ${applied.ok}\n${context()}`);
        assert.deepEqual(applied.details, plannedOps(dry), `apply ran other steps than dry run planned\n${context()}`);
        assert.deepEqual([...applied.blocks].sort(), [...dry.blocks].sort(), context());
        const after = repoState(f.project);
        assert.equal(after.index, state.index, `the git index changed\n${context()}`);
        assert.equal(existsSync(join(f.project, ".agents", ".pjangler-quarantine")), false, `quarantine left behind\n${context()}`);
        assert.deepEqual(repoState(join(f.base, "external")), external, `content outside the repo changed\n${context()}`);
        if (run === 0) {
          const real = applied.plan.aliases.filter((entry) => entry.state === "real-directory");
          const blocked = real.filter((entry) => entry.blocks.length).length;
          if (real.length) outcomes[blocked === 0 ? "converted" : blocked === real.length ? "blocked" : "mixed"]++;
          for (const operation of applied.plan.operations) kinds.set(operation.kind, (kinds.get(operation.kind) ?? 0) + 1);
        }
        if (!applied.details.length) {
          assert.deepEqual(after, state, `no operation ran but the repo changed\n${context()}`);
          break;
        }
        const now = visible(f.project);
        for (const [name, view] of Object.entries(views)) {
          const gap = containedIn(view, now[name], name);
          assert.equal(gap, undefined, `${gap}\nrun ${run}: ${applied.details.join("\n")}\n${context()}`);
        }
        const kept = outside(f.project);
        for (const [path, identity] of Object.entries(untouched)) {
          assert.deepEqual(kept[path], identity, `${path} outside the skills areas changed\n${context()}`);
        }
        state = after;
        assert.notEqual(run, 4, `no fixed point after 5 applies\n${context()}`);
      }
    } finally { f.close(); }
  }
  // The generator must exercise every outcome and every operation, or the property proves little.
  const summary = `outcomes ${JSON.stringify(outcomes)}; operations ${JSON.stringify(Object.fromEntries(kinds))}`;
  console.log(`property: ${summary}`);
  for (const [outcome, count] of Object.entries(outcomes)) assert.ok(count >= ITERATIONS / 25, `too few ${outcome} layouts: ${summary}`);
  for (const kind of ["move-entry", "move-link", "recreate-link", "drop-duplicate-entry", "drop-duplicate-link", "drop-dangling-link", "replace-subset-counterpart", "convert-alias", "create-root"]) {
    assert.ok((kinds.get(kind) ?? 0) >= Math.max(1, ITERATIONS / 200), `operation ${kind} was barely exercised: ${summary}`);
  }
});
