import "./helpers/hermetic-suite.mjs";
// PJAN-199: in-process coverage of `renameProject` and `patchPlaneBoardIdentifier`.
//
// tests/pjan-199-project-rename.mjs proves the command end to end through the
// CLI against stub processes. This suite calls the same code in process, through
// its test seams, so each step's dry-run/apply/already/skipped/failed branch is
// exercised on purpose rather than by accident. The bundle carries an inline
// source map so c8 attributes the lines to src/.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import YAML from "yaml";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const STAMP = "2026-01-01T00:00:00.000Z";
const workspace = hermeticScratch("pj-rename-unit-");
let failures = 0;
let counter = 0;

async function check(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

const entry = join(workspace, "entry.ts");
writeFileSync(
  entry,
  `export { renameProject, RenameError } from ${JSON.stringify(join(ROOT, "src/project/rename.ts"))};\n` +
    `export { patchPlaneBoardIdentifier } from ${JSON.stringify(join(ROOT, "src/project/identity.ts"))};\n`,
);
const bundle = join(workspace, "bundle.cjs");
buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle, sourcemap: "inline", logLevel: "silent" });
const { renameProject, RenameError, patchPlaneBoardIdentifier } = createRequire(import.meta.url)(bundle);

const read = (path) => readFileSync(path, "utf8");
const write = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const step = (result, name) => result.steps.find((candidate) => candidate.step === name);
const statuses = (result) => Object.fromEntries(result.steps.map((candidate) => [candidate.step, candidate.status]));

/** A fake Plane: one board, a rename that applies (or not), a read that may fail. */
function makePlane(boardId, identifier, { archived = false } = {}) {
  const board = { id: boardId, identifier, name: "Fixture", workspace: "33god", archived };
  const plane = {
    board,
    patches: [],
    fetchCalls: 0,
    fetch: async () => { plane.fetchCalls += 1; return new Map([[boardId, { ...board }]]); },
    patch: async (_workspace, id, next) => { plane.patches.push([id, next]); board.identifier = next; },
  };
  return plane;
}

function scenario(options = {}) {
  counter += 1;
  const root = join(workspace, `s${counter}`);
  const id = options.id ?? "proj";
  const newId = options.newId ?? "projx";
  const dir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const type = options.type ?? "plane";
  const identifier = options.identifier ?? "PROJ";
  const boardId = options.boardId ?? (type === "plane" ? `board-${counter}` : `tr-${counter}`);
  const provider = options.provider ?? {
    type,
    workspace: type === "plane" ? "33god" : "",
    identifier,
    identifier_source: type === "plane" ? "provider" : "proposed",
    ...(type === "plane" ? { identifier_fetched_at: STAMP } : {}),
    board_id: boardId,
    board_confirmed_at: STAMP,
    state: "linked",
  };
  const manifestId = options.manifestId ?? id;
  let manifest = {
    project_id: manifestId,
    project_name: "Fixture",
    repo_path: dir,
    ticket_provider: provider,
    agents: {},
  };
  if (options.manifest) manifest = options.manifest(manifest);
  if (options.manifest !== null && options.rawManifest === undefined) {
    if (manifest) write(join(dir, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (options.rawManifest !== undefined) write(join(dir, ".project.json"), options.rawManifest);
  const regId = options.regId ?? id;
  const registry = join(root, "registry.yaml");
  writeFileSync(
    registry,
    YAML.stringify({
      schema_version: 1,
      projects: {
        [regId]: {
          name: "Fixture",
          slug: regId,
          ...(options.recordProjectId ? { project_id: regId } : {}),
          repo_path: dir,
          description: "",
          status: "active",
          source_artifacts: [],
          template: { commonproject: { enabled: true, primary_language: "python" } },
          ticket_provider: { ...provider },
          agents: {},
          created_at: STAMP,
          updated_at: STAMP,
        },
        ...(options.otherProjects ?? {}),
      },
    }, { lineWidth: 0 }),
  );
  const plane = makePlane(boardId, identifier, { archived: options.archived });
  const env = hermeticEnv({ HOME: home, ...(options.env ?? {}) });
  const scn = {
    id, newId, dir, home, registry, env, plane, boardId, root,
    run: (extra = {}) => renameProject({
      oldId: id,
      newId,
      registryPath: registry,
      env,
      home,
      fetchBoards: plane.fetch,
      patchBoard: plane.patch,
      ...extra,
    }),
  };
  return scn;
}

const role = (identifier, quote = '"') => [
  "# comment",
  'repo: "x"',
  "plane:",
  '  workspace: "33god"',
  `  identifier: ${quote}${identifier}${quote}`,
  "",
].join("\n");

console.log("pj project rename, in process (PJAN-199)");
try {
  await check("defaults: no key, no old id, and no env/home/apply/now still resolve safely", async () => {
    const scn = scenario();
    await assert.rejects(() => renameProject({ oldId: "proj", newId: undefined, registryPath: scn.registry }), (e) => e instanceof RenameError && e.code === "invalid_key");
    await assert.rejects(() => renameProject({ oldId: undefined, newId: "projx", registryPath: scn.registry, fetchBoards: scn.plane.fetch }), (e) => e.code === "unknown_project");
    const dry = await renameProject({ oldId: "proj", newId: "projx", registryPath: scn.registry, fetchBoards: scn.plane.fetch });
    assert.equal(dry.apply, false);
    assert.equal(dry.ok, true);
    assert.equal(step(dry, "plane").status, "planned");
    assert.equal(scn.plane.patches.length, 0);
  });

  await check("a manifest that is not an object is manifest_invalid", async () => {
    const scn = scenario({ rawManifest: "[1, 2]" });
    await assert.rejects(() => scn.run(), (e) => e.code === "manifest_invalid" && /JSON object/.test(e.message));
  });

  await check("resume needs readable provenance; a bare renamed_from resumes", async () => {
    const unreadable = scenario({ id: "gone", regId: "projx", newId: "projx", rawManifest: "{ nope" });
    await assert.rejects(() => unreadable.run(), (e) => e.code === "unknown_project");
    const bare = scenario({
      id: "gone",
      regId: "projx",
      manifestId: "projx",
      identifier: "PROJX",
      manifest: (m) => ({ ...m, renamed_from: { project_id: "gone" } }),
    });
    const result = await bare.run({ apply: true });
    assert.equal(result.resumed, true);
    assert.equal(result.ok, true);
    assert.equal(step(result, "plane").status, "already");
    assert.equal(step(result, "manifest").status, "already", "a resume keeps the provenance it finds");
    assert.equal(step(result, "registry").status, "already");
    assert.equal(bare.plane.patches.length, 0);
  });

  await check("a block with no type, an unbound Plane board and a missing manifest rename locally", async () => {
    const typeless = scenario({ provider: {}, manifest: (m) => ({ ...m, ticket_provider: {} }) });
    const a = await typeless.run({ apply: true });
    assert.equal(a.provider, "none");
    assert.equal(step(a, "plane").status, "skipped");
    assert.match(step(a, "plane").detail, /no Plane board/);
    assert.equal(a.warnings.some((warning) => /ticket refs/.test(warning)), false);

    const unbound = scenario({
      provider: { type: "plane", workspace: "", identifier: "UNB", identifier_source: "proposed", board_id: "", state: "planned" },
      manifest: (m) => ({ ...m, project_slug: "proj", ticket_provider: { type: "plane", workspace: "", identifier: "UNB", identifier_source: "proposed", board_id: "", state: "planned" } }),
    });
    const b = await unbound.run({ apply: true });
    assert.equal(b.workspace, "33god", "an unbound Plane record falls back to the default workspace");
    assert.match(step(b, "plane").detail, /no board bound/);
    assert.equal(unbound.plane.fetchCalls, 0, "nothing to read when nothing is bound");
    const manifest = JSON.parse(read(join(unbound.dir, ".project.json")));
    assert.equal(manifest.ticket_provider.identifier, "PROJX");
    assert.equal("project_slug" in manifest, false);

    const bare = scenario({ manifest: null, identifier: "PROJ" });
    const c = await bare.run({ apply: true });
    assert.equal(step(c, "manifest").status, "skipped");
    assert.match(step(c, "manifest").detail, /no \.project\.json/);
    assert.equal(step(c, "registry").status, "done");
  });

  await check("a manifest without a ticket_provider block keeps none, and its old id is reported", async () => {
    const scn = scenario({ manifest: (m) => { const { ticket_provider: _drop, ...rest } = m; return { ...rest, project_slug: "proj", project_id: undefined }; } });
    const dry = await scn.run();
    assert.match(step(dry, "manifest").detail, /proj -> projx/);
    const neither = scenario({ manifest: (m) => { const { ticket_provider: _drop, project_id: _id, ...rest } = m; return rest; } });
    assert.match(step(await neither.run(), "manifest").detail, /\(none\)/);
    await scn.run({ apply: true });
    assert.equal("ticket_provider" in JSON.parse(read(join(scn.dir, ".project.json"))), false);
  });

  await check("a repeat of the same rename keeps renamed_from.at; a record carrying project_id is re-keyed with it", async () => {
    const scn = scenario({
      recordProjectId: true,
      manifest: (m) => ({ ...m, renamed_from: { project_id: "proj", identifier: "PROJ", at: "2020-01-01T00:00:00.000Z" } }),
    });
    const result = await scn.run({ apply: true });
    assert.equal(JSON.parse(read(join(scn.dir, ".project.json"))).renamed_from.at, "2020-01-01T00:00:00.000Z");
    const doc = YAML.parse(read(scn.registry));
    assert.equal(doc.projects.projx.project_id, "projx");
    assert.equal(result.ok, true);
    // Once finished, the registry step reports the settled state.
    assert.equal(step(await scn.run({ apply: true, oldId: "projx" }), "registry").status, "already");
  });

  await check("Trello verification: a missing or archived board is refused, a throw only warns", async () => {
    const scn = scenario({ type: "trello", identifier: "TRL" });
    await assert.rejects(() => scn.run({ fetchTrello: async () => null }), (e) => e.code === "board_not_found");
    await assert.rejects(() => scn.run({ fetchTrello: async () => ({ id: "x", name: "Old", closed: true }) }), (e) => e.code === "board_archived");
    const warned = await scn.run({ fetchTrello: async () => { throw new Error("no credentials"); } });
    assert.match(warned.warnings.join("\n"), /could not be verified \(no credentials\)/);
    const ok = await scn.run({ fetchTrello: async () => ({ id: "x", name: "Fine", closed: false }) });
    assert.equal(ok.warnings.some((warning) => /could not be verified/.test(warning)), false);
    assert.equal(step(ok, "plane").status, "skipped");
    assert.match(step(ok, "plane").detail, /trello assigns no key/);
  });

  await check("the Plane step: thrown PATCH that applied, thrown PATCH that did not, missing board, failing read-back", async () => {
    const applied = scenario();
    const a = await applied.run({
      apply: true,
      patchBoard: async (_w, _id, next) => { applied.plane.board.identifier = next; throw new Error("timed out"); },
    });
    assert.equal(step(a, "plane").status, "done");
    assert.match(step(a, "plane").detail, /PATCH reported: timed out/);

    const unapplied = scenario();
    const b = await unapplied.run({ apply: true, patchBoard: async () => { throw "plain string failure"; } });
    assert.equal(step(b, "plane").status, "failed");
    assert.match(step(b, "plane").detail, /plain string failure; the board still reads PROJ/);
    assert.equal(b.code, "step_failed");
    assert.match(b.error, /re-run the same command to resume/);

    const vanished = scenario();
    let calls = 0;
    const c = await vanished.run({
      apply: true,
      fetchBoards: async () => { calls += 1; return calls === 1 ? vanished.plane.fetch() : new Map(); },
      patchBoard: async () => { throw new Error("boom"); },
    });
    assert.match(step(c, "plane").detail, /still reads \(missing\)/);

    const silent = scenario();
    let reads = 0;
    const d = await silent.run({
      apply: true,
      fetchBoards: async () => { reads += 1; return reads === 1 ? silent.plane.fetch() : new Map(); },
      patchBoard: async () => {},
    });
    assert.match(step(d, "plane").detail, /accepted the rename but board .* reads \(missing\)/);

    const blind = scenario();
    let seen = 0;
    const e = await blind.run({
      apply: true,
      fetchBoards: async () => { seen += 1; if (seen === 1) return blind.plane.fetch(); throw new Error("read down"); },
      patchBoard: async () => {},
    });
    assert.match(step(e, "plane").detail, /^the read-back failed \(read down\), so the outcome is unknown/);
    const f = await blind.run({
      apply: true,
      fetchBoards: (() => { let n = 0; return async () => { n += 1; if (n === 1) return blind.plane.fetch(); throw new Error("read down"); }; })(),
      patchBoard: async () => { throw new Error("slow"); },
    });
    assert.match(step(f, "plane").detail, /^slow; the read-back failed/);
  });

  await check("the registry step failing blocks the downstream steps, and a dry-run failure is worded as a plan", async () => {
    if (process.getuid?.() === 0) return;
    const scn = scenario();
    chmodSync(scn.root, 0o555);
    try {
      const result = await scn.run({ apply: true });
      assert.equal(step(result, "registry").status, "failed");
      assert.equal(step(result, "role.yaml").status, "blocked");
      assert.equal(result.ok, false);
    } finally {
      chmodSync(scn.root, 0o755);
    }
    write(join(scn.dir, "agents", "hermes", "pm", "role.yaml"), "plane: [unclosed\n");
    const dry = await scn.run();
    assert.equal(step(dry, "role.yaml").status, "failed");
    assert.match(dry.error, /would fail: .*fix this before running with --apply/);
  });

  await check("role.yaml: skipped, already, planned, quoted and plain scalars, invalid, unreadable", async () => {
    const trello = scenario({ type: "trello", identifier: "TRL" });
    write(join(trello.dir, "agents", "hermes", "pm", "role.yaml"), role("TRL"));
    assert.match(step(await trello.run(), "role.yaml").detail, /Plane field/);

    const none = scenario();
    write(join(none.dir, "agents", "hermes", "pm", "role.yaml"), "repo: x\n");
    write(join(none.dir, "agents", "hermes", "README.md"), "not a role dir\n");
    mkdirSync(join(none.dir, "agents", "hermes", "empty"), { recursive: true });
    assert.equal(step(await none.run(), "role.yaml").status, "skipped");
    assert.equal(step(await scenario().run(), "role.yaml").status, "skipped", "no agents/hermes directory at all");

    const settled = scenario();
    write(join(settled.dir, "agents", "hermes", "pm", "role.yaml"), role("PROJX"));
    assert.equal(step(await settled.run({ apply: true }), "role.yaml").status, "already");

    const styles = scenario();
    write(join(styles.dir, "agents", "hermes", "a", "role.yaml"), role("PROJ", "'"));
    write(join(styles.dir, "agents", "hermes", "b", "role.yaml"), role("PROJ", ""));
    write(join(styles.dir, "agents", "hermes", "c", "role.yaml"), role("PROJ"));
    const planned = await styles.run();
    assert.equal(step(planned, "role.yaml").status, "planned");
    assert.equal(read(join(styles.dir, "agents", "hermes", "a", "role.yaml")).includes("'PROJ'"), true, "a dry run writes nothing");
    const done = await styles.run({ apply: true });
    assert.equal(step(done, "role.yaml").status, "done");
    assert.match(read(join(styles.dir, "agents", "hermes", "a", "role.yaml")), /identifier: 'PROJX'/);
    assert.match(read(join(styles.dir, "agents", "hermes", "b", "role.yaml")), /identifier: PROJX\n/);
    assert.match(read(join(styles.dir, "agents", "hermes", "c", "role.yaml")), /identifier: "PROJX"/);

    const numeric = scenario({ newId: "12345" });
    write(join(numeric.dir, "agents", "hermes", "pm", "role.yaml"), role("PROJ", ""));
    await numeric.run({ apply: true });
    assert.match(read(join(numeric.dir, "agents", "hermes", "pm", "role.yaml")), /identifier: "12345"/, "a digit-only key is quoted so YAML keeps it a string");
    const word = scenario({ newId: "no" });
    write(join(word.dir, "agents", "hermes", "pm", "role.yaml"), role("PROJ", ""));
    await word.run({ apply: true });
    assert.match(read(join(word.dir, "agents", "hermes", "pm", "role.yaml")), /identifier: "NO"/, "a YAML boolean-ish word is quoted");

    const invalid = scenario();
    write(join(invalid.dir, "agents", "hermes", "pm", "role.yaml"), "plane: [unclosed\n");
    const bad = await invalid.run({ apply: true });
    assert.equal(step(bad, "role.yaml").status, "failed");

    const unreadable = scenario();
    write(join(unreadable.dir, "agents", "hermes"), "a file where a directory should be\n");
    assert.equal(step(await unreadable.run({ apply: true }), "role.yaml").status, "failed");
  });

  await check("fleet registry: absent, unbound, already, planned, stale after reconcile, reconcile errors, invalid", async () => {
    const absent = scenario();
    assert.match(step(await absent.run(), "fleet-registry").detail, /no fleet registry/);

    const fleet = (scn, agents) => write(join(scn.home, ".hermes", "agents-registry.yaml"), YAML.stringify({ agents }));
    const agent = (scn, over = {}) => ({ repo: "proj", project_path: scn.dir, plane: { workspace: "33god", project_id: scn.boardId, identifier: "PROJ", ...(over.plane ?? {}) } });

    const unbound = scenario();
    fleet(unbound, { other: { repo: "o", project_path: "/nowhere", plane: { workspace: "33god", project_id: "other", identifier: "OTH" } } });
    assert.equal(step(await unbound.run(), "fleet-registry").status, "skipped");

    const already = scenario();
    fleet(already, { pm: agent(already, { plane: { identifier: "PROJX" } }) });
    assert.equal(step(await already.run(), "fleet-registry").status, "already");

    const stale = scenario();
    fleet(stale, { pm: agent(stale) });
    const planned = await stale.run();
    assert.equal(step(planned, "fleet-registry").status, "planned");
    assert.match(read(join(stale.home, ".hermes", "agents-registry.yaml")), /identifier: PROJ\b/);
    const done = await stale.run({ apply: true });
    assert.equal(step(done, "fleet-registry").status, "done");
    assert.match(read(join(stale.home, ".hermes", "agents-registry.yaml")), /identifier: PROJX/);

    const erroring = scenario();
    fleet(erroring, { pm: agent(erroring) });
    let calls = 0;
    const failed = await erroring.run({
      apply: true,
      fetchBoards: async (...args) => { calls += 1; if (calls > 2) throw new Error("workspace listing down"); return erroring.plane.fetch(...args); },
    });
    assert.equal(step(failed, "fleet-registry").status, "failed");
    assert.match(step(failed, "fleet-registry").detail, /workspace listing down/);

    const lagging = scenario();
    fleet(lagging, {
      pm: agent(lagging),
      rogue: { repo: "elsewhere", project_path: "/elsewhere", plane: { workspace: "33god", project_id: lagging.boardId, identifier: "PROJ" } },
    });
    const laggard = await lagging.run({ apply: true });
    assert.equal(step(laggard, "fleet-registry").status, "failed");
    assert.match(step(laggard, "fleet-registry").detail, /rogue \(PROJ\)/);

    const broken = scenario();
    write(join(broken.home, ".hermes", "agents-registry.yaml"), "agents: [unclosed\n");
    assert.equal(step(await broken.run({ apply: true }), "fleet-registry").status, "failed");

    const trello = scenario({ type: "trello", identifier: "TRL" });
    assert.match(step(await trello.run(), "fleet-registry").detail, /no Plane board/);
  });

  await check("AGENTS.md: no Board: line, already current, no old key, several old spellings, dry run", async () => {
    const noBoard = scenario();
    write(join(noBoard.dir, "AGENTS.md"), "# nothing here\n");
    assert.match(step(await noBoard.run(), "AGENTS.md").detail, /no Board: line/);

    const already = scenario();
    write(join(already.dir, "AGENTS.md"), "Board:  Fixture (PROJX)\n");
    assert.equal(step(await already.run(), "AGENTS.md").status, "already");

    const missing = scenario();
    write(join(missing.dir, "AGENTS.md"), "Board:  Fixture (SOMETHING)\n");
    const m = await missing.run();
    assert.equal(step(m, "AGENTS.md").status, "skipped");
    assert.match(step(m, "AGENTS.md").detail, /no \(PROJ\)/);

    const several = scenario({ manifest: (manifest) => ({ ...manifest, ticket_provider: { ...manifest.ticket_provider, identifier: "MANI" } }) });
    write(join(several.dir, "AGENTS.md"), "Board:  A (PROJ) and (MANI)\nNote: (PROJ)\n");
    const planned = await several.run();
    assert.equal(step(planned, "AGENTS.md").status, "planned");
    assert.equal(read(join(several.dir, "AGENTS.md")), "Board:  A (PROJ) and (MANI)\nNote: (PROJ)\n");
    await several.run({ apply: true });
    assert.equal(read(join(several.dir, "AGENTS.md")), "Board:  A (PROJX) and (PROJX)\nNote: (PROJ)\n");

    const dangling = scenario();
    symlinkSync(join(dangling.root, "nowhere.md"), join(dangling.dir, "AGENTS.md"));
    assert.equal(step(await dangling.run(), "AGENTS.md").status, "skipped", "a dangling link is the same as no file");
    assert.equal(step(await scenario().run(), "AGENTS.md").status, "skipped");
  });

  await check("harvest hints: absent, no projects map, no entry, already, collisions with non-record entries, invalid, env dirs", async () => {
    const absent = scenario();
    assert.match(step(await absent.run(), "harvest-hints").detail, /no harvest hints/);

    const hintsFile = (scn, content, dir) => write(join(dir ?? join(scn.home, ".config", "pilot"), "harvest", "project-hints.json"), typeof content === "string" ? content : JSON.stringify(content));

    const noMap = scenario();
    hintsFile(noMap, { projects: 3 });
    assert.match(step(await noMap.run(), "harvest-hints").detail, /no projects map/);

    const noEntry = scenario();
    hintsFile(noEntry, { projects: { other: {} } });
    assert.match(step(await noEntry.run(), "harvest-hints").detail, /no hints entry for proj/);

    const already = scenario();
    hintsFile(already, { projects: { projx: {} } });
    assert.equal(step(await already.run(), "harvest-hints").status, "already");

    const planned = scenario();
    hintsFile(planned, { projects: { proj: { aliases: ["a"] } } });
    const before = read(join(planned.home, ".config", "pilot", "harvest", "project-hints.json"));
    assert.equal(step(await planned.run(), "harvest-hints").status, "planned");
    assert.equal(read(join(planned.home, ".config", "pilot", "harvest", "project-hints.json")), before);

    const stringEntries = scenario();
    hintsFile(stringEntries, { projects: { proj: "just text", projx: "also text" } });
    await stringEntries.run({ apply: true });
    assert.deepEqual(JSON.parse(read(join(stringEntries.home, ".config", "pilot", "harvest", "project-hints.json"))).projects, { projx: { aliases: ["proj"] } });

    const nonRecordMoved = scenario();
    hintsFile(nonRecordMoved, { projects: { proj: 7 } });
    await nonRecordMoved.run({ apply: true });
    assert.deepEqual(JSON.parse(read(join(nonRecordMoved.home, ".config", "pilot", "harvest", "project-hints.json"))).projects, { projx: { aliases: ["proj"] } });

    const invalid = scenario();
    hintsFile(invalid, "{ nope");
    assert.equal(step(await invalid.run({ apply: true }), "harvest-hints").status, "failed");

    const pilotDir = scenario();
    const custom = join(pilotDir.root, "pilot-config");
    pilotDir.env.PILOT_CONFIG_DIR = custom;
    hintsFile(pilotDir, { projects: { proj: {} } }, custom);
    assert.equal(step(await pilotDir.run({ apply: true }), "harvest-hints").status, "done");
    assert.ok(JSON.parse(read(join(custom, "harvest", "project-hints.json"))).projects.projx);

    const xdg = scenario();
    const xdgDir = join(xdg.root, "xdg");
    xdg.env.XDG_CONFIG_HOME = xdgDir;
    hintsFile(xdg, { projects: { proj: {} } }, join(xdgDir, "pilot"));
    assert.equal(step(await xdg.run({ apply: true }), "harvest-hints").status, "done");
  });

  await check("candystore: not a directory, mise failing silently, and the same-key no-op", async () => {
    const file = scenario();
    write(join(file.home, "code", "33GOD", "candystore"), "a file, not a checkout\n");
    assert.match(step(await file.run({ apply: true }), "candystore").detail, /no candystore checkout/);

    const planned = scenario();
    mkdirSync(join(planned.home, "code", "33GOD", "candystore"), { recursive: true });
    assert.match(step(await planned.run(), "candystore").detail, /mise run project:sync in/);

    const silent = scenario();
    mkdirSync(join(silent.home, "code", "33GOD", "candystore"), { recursive: true });
    const bin = join(silent.root, "bin");
    write(join(bin, "mise"), "#!/bin/sh\nexit 2\n");
    chmodSync(join(bin, "mise"), 0o755);
    silent.env.PATH = bin;
    const result = await silent.run({ apply: true });
    assert.equal(step(result, "candystore").status, "failed");
    assert.equal(step(result, "candystore").detail, "mise run project:sync exited 2");

    const noisy = scenario();
    mkdirSync(join(noisy.home, "code", "33GOD", "candystore"), { recursive: true });
    const noisyBin = join(noisy.root, "bin");
    write(join(noisyBin, "mise"), "#!/bin/sh\necho out-only\nexit 3\n");
    chmodSync(join(noisyBin, "mise"), 0o755);
    noisy.env.PATH = noisyBin;
    assert.match(step(await noisy.run({ apply: true }), "candystore").detail, /exited 3: out-only/);

    const same = scenario({ id: "projx", newId: "projx", identifier: "PROJX", regId: "projx" });
    assert.equal(step(await same.run({ apply: true }), "candystore").status, "already");
  });

  await check("patchPlaneBoardIdentifier: success, refusals with and without a body, network failure, missing key", async () => {
    const original = globalThis.fetch;
    const env = hermeticEnv({ HOME: join(workspace, "patch-home"), PLANE_API_KEY: "k", PLANE_BASE: "http://plane.invalid" });
    const home = join(workspace, "patch-home");
    mkdirSync(home, { recursive: true });
    try {
      let seen;
      globalThis.fetch = async (url, init) => { seen = { url: String(url), init }; return new Response("{}", { status: 200 }); };
      await patchPlaneBoardIdentifier("33god", "board/1", "NEWK", env, home);
      assert.equal(seen.url, "http://plane.invalid/api/v1/workspaces/33god/projects/board%2F1/");
      assert.equal(seen.init.method, "PATCH");
      assert.equal(seen.init.headers["X-API-Key"], "k");
      assert.deepEqual(JSON.parse(seen.init.body), { identifier: "NEWK" });

      globalThis.fetch = async () => new Response(JSON.stringify({ identifier: ["taken"] }), { status: 400 });
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", env, home), /refused identifier "NEWK" for board b \(HTTP 400\): .*taken/);
      globalThis.fetch = async () => new Response("", { status: 403 });
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", env, home), (e) => /\(HTTP 403\)$/.test(e.message));
      globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => { throw new Error("body gone"); } });
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", env, home), (e) => /\(HTTP 502\)$/.test(e.message));

      globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", env, home), /could not reach Plane at http:\/\/plane\.invalid to rename board b: connect ECONNREFUSED/);
      globalThis.fetch = async () => { throw "string failure"; };
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", env, home), /string failure/);

      const keyless = hermeticEnv({ HOME: home, PLANE_BASE: "http://plane.invalid" });
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", keyless, home), /no Plane API key for workspace "33god".*fleet\.env/);
      const fleetEnv = hermeticEnv({ HOME: home, PLANE_BASE: "http://plane.invalid", HERMES_FLEET_ENV: join(home, "custom.env") });
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK", fleetEnv, home), /custom\.env/);
      // The hermetic preamble leaves no key and no real home: the defaults refuse too.
      await assert.rejects(() => patchPlaneBoardIdentifier("33god", "b", "NEWK"), /no Plane API key/);
    } finally {
      globalThis.fetch = original;
    }
  });
} finally {
  for (const dir of [workspace]) {
    try { chmodSync(dir, 0o755); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("pj project rename in-process regressions passed");
