import "./helpers/hermetic-suite.mjs";
// PJAN-199: `pj project rename <old> <new>` makes one key the project's
// identity: project_id = <new> and board identifier = <NEW>.
//
// Plane is a stub PROCESS (every CLI call is spawnSync, which blocks this
// process's event loop, so an in-process server could never answer). The
// service registry is a second stub process. Nothing here touches a real board.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const SECRET = "stub-plane-key-never-logged";
const STAMP = "2026-01-01T00:00:00.000Z";
const temporary = [];
const children = [];
let failures = 0;

async function check(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

const workspace = hermeticScratch("pj-rename-");
temporary.push(workspace);
const home = join(workspace, "home");
mkdirSync(home, { recursive: true });

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const BOARDS = {
  tower: "aaaaaaaa-0000-0000-0000-000000000001",
  other: "aaaaaaaa-0000-0000-0000-000000000002",
  archived: "aaaaaaaa-0000-0000-0000-000000000003",
  partial: "aaaaaaaa-0000-0000-0000-000000000004",
  taken: "aaaaaaaa-0000-0000-0000-000000000005",
  service: "aaaaaaaa-0000-0000-0000-000000000006",
  liar: "aaaaaaaa-0000-0000-0000-000000000007",
};

function stubScript(name, source) {
  const path = join(workspace, name);
  writeFileSync(path, source);
  return path;
}

async function startStub(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"], env: hermeticEnv() });
  children.push(child);
  const port = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${script} never reported a port`)), 10_000);
    child.stdout.once("data", (chunk) => { clearTimeout(timer); done(String(chunk).trim()); });
    child.once("error", fail);
  });
  return `http://127.0.0.1:${port}`;
}

const planeScript = stubScript(
  "plane-stub.mjs",
  `import { createServer } from "node:http";
const boards = [
  { id: ${JSON.stringify(BOARDS.tower)}, identifier: "TOWE", name: "Tower of Lost Things" },
  { id: ${JSON.stringify(BOARDS.other)}, identifier: "OTHR", name: "Somebody Else" },
  { id: ${JSON.stringify(BOARDS.archived)}, identifier: "ARCH", name: "Retired", archived_at: "2025-01-01T00:00:00Z" },
  { id: ${JSON.stringify(BOARDS.partial)}, identifier: "PART", name: "Partial" },
  { id: ${JSON.stringify(BOARDS.taken)}, identifier: "TAKE", name: "Taken" },
  { id: ${JSON.stringify(BOARDS.service)}, identifier: "SVCP", name: "Service" },
  { id: ${JSON.stringify(BOARDS.liar)}, identifier: "LIAR", name: "Liar", noApply: true },
];
const patches = [];
let requests = 0;
const server = createServer((request, response) => {
  const url = request.url ?? "";
  const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (url === "/__state") return send(200, { boards, patches, requests, keys: seenKeys });
  requests += 1;
  const apiKey = request.headers["x-api-key"];
  const list = "/api/v1/workspaces/33god/projects/";
  if (request.method === "GET" && url.startsWith(list)) return send(200, { results: boards, next_page_results: false });
  if (request.method === "PATCH" && url.startsWith(list)) {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const id = url.slice(list.length).replace(/\\/.*$/, "");
      const board = boards.find((candidate) => candidate.id === id);
      const { identifier } = JSON.parse(raw || "{}");
      patches.push({ id, identifier, apiKey });
      if (!board) return send(404, {});
      if (identifier === "TAKEN") return send(400, { identifier: ["Project ID is already taken"] });
      if (board.noApply) return send(200, board);
      board.identifier = identifier;
      send(200, board);
    });
    return;
  }
  send(404, {});
});
const seenKeys = [];
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
);

// A minimal registry service: manifests are the truth, /v1/index re-reads one.
const registryScript = stubScript(
  "registry-stub.mjs",
  `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const rows = new Map(JSON.parse(process.argv[2]));
const log = { puts: 0, indexed: [] };
function record(path) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  const id = m.project_id ?? m.project_slug;
  const { project_slug, project_name, project_description, ...rest } = m;
  return [id, { ...rest, project_id: id, slug: id, name: project_name ?? id, description: project_description ?? "", repo_path: dirname(path),
    status: "active", source_artifacts: [], template: { commonproject: { enabled: true, primary_language: "python" } },
    ticket_provider: m.ticket_provider, agents: {}, created_at: "${STAMP}", updated_at: "${STAMP}" }];
}
const server = createServer((request, response) => {
  const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (request.url === "/__state") return send(200, { puts: log.puts, indexed: log.indexed, rows: [...rows] });
  if (request.method === "GET" && request.url === "/v1/registry") {
    const projects = {};
    for (const path of rows.values()) { const [id, rec] = record(path); projects[id] = rec; }
    return send(200, { schema_version: 1, projects });
  }
  if (request.method === "POST" && request.url === "/v1/index") {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const { manifest_path } = JSON.parse(raw);
      const [id] = record(manifest_path);
      for (const [key, path] of rows) if (path === manifest_path) rows.delete(key);
      rows.set(id, manifest_path);
      log.indexed.push(id);
      send(200, { ok: true });
    });
    return;
  }
  if (request.method === "PUT") { log.puts += 1; return send(500, { error: "PUT /v1/registry must not carry a rename" }); }
  send(404, {});
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function providerBlock({ type = "plane", identifier, boardId, source = "provider" }) {
  return {
    type,
    workspace: type === "plane" ? "33god" : "",
    identifier,
    identifier_source: source,
    ...(source === "provider" ? { identifier_fetched_at: STAMP } : {}),
    board_id: boardId,
    board_confirmed_at: STAMP,
    state: "linked",
  };
}

const registryProjects = {};
const projectDirs = {};

function makeProject({ id, name, identifier, boardId, type = "plane", source = "provider", legacySlug = false, inYaml = true }) {
  const dir = join(workspace, "repos", id);
  mkdirSync(dir, { recursive: true });
  const ticket_provider = providerBlock({ type, identifier, boardId, source });
  const manifest = {
    project_id: id,
    ...(legacySlug ? { project_slug: id } : {}),
    project_name: name,
    project_description: "fixture",
    repo_path: dir,
    x_unknown: { keep: [1, 2, 3] },
    ticket_provider,
    agents: {},
  };
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (inYaml) {
    registryProjects[id] = {
      name,
      slug: id,
      repo_path: dir,
      description: "fixture",
      status: "active",
      source_artifacts: [],
      template: { commonproject: { enabled: true, primary_language: "python" } },
      ticket_provider: { ...ticket_provider },
      agents: {},
      created_at: STAMP,
      updated_at: STAMP,
    };
  }
  projectDirs[id] = dir;
  return dir;
}

const towerDir = makeProject({ id: "tower-of-lost-things", name: "Tower of Lost Things", identifier: "TOWE", boardId: BOARDS.tower, legacySlug: true });
makeProject({ id: "othrproj", name: "Other Project", identifier: "OTHRP", boardId: "bbbbbbbb-0000-0000-0000-000000000001" });
makeProject({ id: "archivedproj", name: "Archived Project", identifier: "ARCH", boardId: BOARDS.archived });
makeProject({ id: "partial", name: "Partial", identifier: "PART", boardId: BOARDS.partial });
makeProject({ id: "taken", name: "Taken Project", identifier: "TAKE", boardId: BOARDS.taken });
makeProject({ id: "trellop", name: "Trello Project", identifier: "TRELP", boardId: "abc123", type: "trello", source: "proposed" });
makeProject({ id: "liar", name: "Liar", identifier: "LIAR", boardId: BOARDS.liar });
makeProject({ id: "ghostboard", name: "Ghost Board", identifier: "GHOST", boardId: "cccccccc-0000-0000-0000-000000000001" });
const badDir = makeProject({ id: "badmanifest", name: "Bad Manifest", identifier: "BADM", boardId: "cccccccc-0000-0000-0000-000000000002" });
writeFileSync(join(badDir, ".project.json"), "{ not json");
for (const id of ["nomise", "misefail", "agfail", "symin", "symout", "hintsold"]) {
  makeProject({ id, name: id, identifier: id.toUpperCase().slice(0, 6), boardId: `tr-${id}`, type: "trello", source: "proposed" });
}
const serviceDir = makeProject({ id: "svcp", name: "Service Project", identifier: "SVCP", boardId: BOARDS.service, inYaml: false });

// Downstream files for the main project.
writeFileSync(
  join(towerDir, "AGENTS.md"),
  [
    "# Tower",
    "",
    "Board:  Tower of Lost Things (TOWE)",
    "Plane:  https://plane.invalid/33god/projects/x/issues/",
    "Note: the (TOWE) here is prose and must not change; TOWE-12 neither.",
    "",
  ].join("\n"),
);
rmSync(join(towerDir, "CLAUDE.md"), { force: true });
symlinkSync("AGENTS.md", join(towerDir, "CLAUDE.md"));
mkdirSync(join(towerDir, "agents", "hermes", "pm"), { recursive: true });
const ROLE_BEFORE = [
  "# keep this comment",
  'repo: "tower-of-lost-things"',
  "plane:",
  '  workspace: "33god"',
  "  # identifier is set after creation",
  '  identifier: "TOWE"',
  "other: [a, b]",
  "",
].join("\n");
writeFileSync(join(towerDir, "agents", "hermes", "pm", "role.yaml"), ROLE_BEFORE);

const hintsPath = join(home, ".config", "pilot", "harvest", "project-hints.json");
mkdirSync(join(home, ".config", "pilot", "harvest"), { recursive: true });
writeFileSync(
  hintsPath,
  `${JSON.stringify({ _comment: "hints", projects: { "tower-of-lost-things": { aliases: ["the tower"], about: "A tower." }, zzz: { aliases: [] } } }, null, 2)}\n`,
);

const fleetPath = join(home, ".hermes", "agents-registry.yaml");
mkdirSync(join(home, ".hermes"), { recursive: true });
writeFileSync(
  fleetPath,
  [
    "agents:",
    "  tower-pm:",
    "    repo: tower-of-lost-things",
    `    project_path: ${towerDir}`,
    "    plane:",
    "      workspace: 33god",
    `      project_id: ${BOARDS.tower}`,
    "      identifier: TOWE",
    "",
  ].join("\n"),
);

const candystore = join(home, "code", "33GOD", "candystore");
mkdirSync(candystore, { recursive: true });
const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const marker = join(workspace, "mise-marker.txt");
writeFileSync(join(binDir, "mise"), `#!/bin/sh\necho "$PWD :: $*" >> "${marker}"\n`);
chmodSync(join(binDir, "mise"), 0o755);

const emptyBin = join(workspace, "empty-bin");
mkdirSync(emptyBin, { recursive: true });
const failBin = join(workspace, "fail-bin");
mkdirSync(failBin, { recursive: true });
writeFileSync(join(failBin, "mise"), "#!/bin/sh\necho 'boom from mise' >&2\nexit 1\n");
chmodSync(join(failBin, "mise"), 0o755);

const registry = join(workspace, "registry.yaml");
writeFileSync(registry, YAML.stringify({ schema_version: 1, projects: registryProjects }, { lineWidth: 0 }));

const planeBase = await startStub(planeScript);
const serviceBase = await startStub(registryScript, [JSON.stringify([["svcp", join(serviceDir, ".project.json")]])]);

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: hermeticEnv({
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(workspace, "state"),
      HERMES_FLEET_ENV: join(home, ".hermes", "fleet.env"),
      PLANE_BASE: planeBase,
      PLANE_API_KEY: SECRET,
      PATH: `${binDir}:${process.env.PATH}`,
      ...env,
    }),
    maxBuffer: 32 * 1024 * 1024,
  });
}

const rename = (args, env) => cli(["project", "rename", ...args, "--registry", registry], env);
const planeState = async () => (await fetch(`${planeBase}/__state`)).json();
const boardIdentifier = async (id) => (await planeState()).boards.find((board) => board.id === id)?.identifier;
const registryDoc = () => YAML.parse(readFileSync(registry, "utf8"));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, ".project.json"), "utf8"));
const read = (path) => readFileSync(path, "utf8");

console.log("pj project rename (PJAN-199)");
try {
  // -------------------------------------------------------------------------
  // Refusals: nothing read, nothing written
  // -------------------------------------------------------------------------
  await check("an invalid key is refused before any read or write", async () => {
    const before = await planeState();
    for (const bad of ["tolt-x", "abcdefghijklmn", "", "to lt", "tolt_x"]) {
      const run = rename(["tower-of-lost-things", bad]);
      assert.equal(run.status, 1, `${JSON.stringify(bad)} must be refused`);
      assert.match(run.stderr, /invalid_key/);
    }
    const json = rename(["tower-of-lost-things", "tolt-x", "--json"]);
    assert.equal(json.status, 1);
    const doc = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(doc).sort(), ["code", "error", "ok"]);
    assert.equal(doc.ok, false);
    assert.equal(doc.code, "invalid_key");
    const after = await planeState();
    assert.equal(after.requests, before.requests, "no provider request for a bad key");
    assert.equal(after.patches.length, 0);
  });

  await check("an unknown old id is refused", async () => {
    const run = rename(["nope", "tolt", "--json"]);
    assert.equal(run.status, 1);
    assert.deepEqual({ ok: false, code: "unknown_project" }, { ok: JSON.parse(run.stdout).ok, code: JSON.parse(run.stdout).code });
  });

  await check("a new id registered to another project is refused", async () => {
    const run = rename(["tower-of-lost-things", "othrproj", "--json"]);
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).code, "identity_collision");
    assert.equal((await planeState()).patches.length, 0);
  });

  await check("an identifier another board in the workspace uses is refused (live read)", async () => {
    const run = rename(["tower-of-lost-things", "othr", "--json"]);
    assert.equal(run.status, 1, run.stdout);
    const doc = JSON.parse(run.stdout);
    assert.equal(doc.code, "identity_collision");
    assert.match(doc.error, /OTHR/);
    assert.equal((await planeState()).patches.length, 0);
    assert.equal(await boardIdentifier(BOARDS.tower), "TOWE");
  });

  await check("an archived Plane board is refused", async () => {
    const run = rename(["archivedproj", "archx", "--json"]);
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).code, "board_archived");
    assert.equal((await planeState()).patches.length, 0);
  });

  await check("board_not_found, provider_unreachable, manifest_invalid and registry_unavailable are refused with zero PATCHes", async () => {
    const codeOf = (run) => JSON.parse(run.stdout).code;
    const regBefore = read(registry);
    const ghost = rename(["ghostboard", "ghostx", "--json"]);
    assert.equal(ghost.status, 1);
    assert.equal(codeOf(ghost), "board_not_found");
    const bad = rename(["badmanifest", "badx", "--json"]);
    assert.equal(bad.status, 1);
    assert.equal(codeOf(bad), "manifest_invalid");
    const down = rename(["tower-of-lost-things", "tolt", "--json"], { PLANE_BASE: "http://127.0.0.1:1" });
    assert.equal(down.status, 1);
    assert.equal(codeOf(down), "provider_unreachable");
    const noRegistry = cli(["project", "rename", "tower-of-lost-things", "tolt", "--registry", "http://127.0.0.1:1", "--json"]);
    assert.equal(noRegistry.status, 1);
    assert.equal(codeOf(noRegistry), "registry_unavailable");
    assert.equal((await planeState()).patches.length, 0);
    assert.equal(read(registry), regBefore);
    assert.equal(manifestOf(towerDir).project_id, "tower-of-lost-things");
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------
  const snapshot = () => ({
    registry: read(registry),
    manifest: read(join(towerDir, ".project.json")),
    agents: read(join(towerDir, "AGENTS.md")),
    role: read(join(towerDir, "agents", "hermes", "pm", "role.yaml")),
    hints: read(hintsPath),
    fleet: read(fleetPath),
  });

  await check("a dry run writes nothing and lists every step", async () => {
    const before = snapshot();
    const run = rename(["tower-of-lost-things", "tolt"]);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Would rename/);
    assert.match(run.stdout, /TOWE/);
    assert.match(run.stdout, /TOLT/);
    for (const step of ["plane", "manifest", "registry", "role.yaml", "fleet-registry", "AGENTS.md", "harvest-hints", "candystore"]) {
      assert.match(run.stdout, new RegExp(step.replace(".", "\\.")), `plan lists ${step}`);
    }
    assert.match(run.stdout, /dry run/);
    assert.deepEqual(snapshot(), before, "no file may change in a dry run");
    const state = await planeState();
    assert.equal(state.patches.length, 0, "a dry run never writes Plane");
    assert.equal(existsSync(marker), false, "a dry run never runs the candystore sync");
    const json = JSON.parse(rename(["tower-of-lost-things", "tolt", "--json"]).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.apply, false);
    assert.equal(json.noop, false);
    assert.ok(json.steps.every((step) => ["planned", "skipped", "already"].includes(step.status)), JSON.stringify(json.steps));
  });

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------
  await check("--apply renames Plane, manifest, registry and downstream references", async () => {
    const run = rename(["tower-of-lost-things", "tolt", "--apply", "--json"]);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(SECRET), "a credential must never reach the output");
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.fromEntries(result.steps.map((step) => [step.step, step.status])), {
      plane: "done",
      manifest: "done",
      registry: "done",
      "role.yaml": "done",
      "fleet-registry": "done",
      "AGENTS.md": "done",
      "harvest-hints": "done",
      candystore: "done",
    });

    // Plane, via the one write path, with the key in a header only.
    const state = await planeState();
    assert.deepEqual(state.patches.map((patch) => [patch.id, patch.identifier, patch.apiKey]), [[BOARDS.tower, "TOLT", SECRET]]);
    assert.equal(await boardIdentifier(BOARDS.tower), "TOLT");

    // Manifest: new identity, unknown fields kept, the legacy slug gone.
    const manifest = manifestOf(towerDir);
    assert.equal(manifest.project_id, "tolt");
    assert.equal("project_slug" in manifest, false);
    assert.deepEqual(manifest.x_unknown, { keep: [1, 2, 3] });
    assert.equal(manifest.project_name, "Tower of Lost Things", "the project name never changes");
    assert.equal(manifest.repo_path, towerDir);
    assert.equal(manifest.ticket_provider.identifier, "TOLT");
    assert.equal(manifest.ticket_provider.identifier_source, "provider");
    assert.notEqual(manifest.ticket_provider.identifier_fetched_at, STAMP, "the identifier was fetched again");
    assert.equal(manifest.ticket_provider.board_id, BOARDS.tower, "the board id never changes");
    assert.equal(manifest.ticket_provider.workspace, "33god");
    assert.equal(manifest.renamed_from.project_id, "tower-of-lost-things", "rename provenance for a later resume");
    assert.equal(manifest.renamed_from.identifier, "TOWE");

    // Registry: re-keyed, repo and name untouched.
    const doc = registryDoc();
    assert.equal(doc.projects["tower-of-lost-things"], undefined);
    assert.equal(doc.projects.tolt.slug, "tolt");
    assert.equal(doc.projects.tolt.name, "Tower of Lost Things");
    assert.equal(doc.projects.tolt.repo_path, towerDir);
    assert.equal(doc.projects.tolt.ticket_provider.identifier, "TOLT");
    assert.equal(doc.projects.tolt.ticket_provider.board_id, BOARDS.tower);
    assert.ok(doc.projects.othrproj, "other projects are left alone");

    // Downstream.
    assert.equal(read(join(towerDir, "agents", "hermes", "pm", "role.yaml")), ROLE_BEFORE.replace('"TOWE"', '"TOLT"'), "only the scalar changes; comments survive");
    const agents = read(join(towerDir, "AGENTS.md"));
    assert.match(agents, /^Board:  Tower of Lost Things \(TOLT\)$/m);
    assert.match(agents, /the \(TOWE\) here is prose/, "only the Board: line is rewritten");
    assert.equal(readlinkSync(join(towerDir, "CLAUDE.md")), "AGENTS.md", "CLAUDE.md stays a symlink");
    const hints = JSON.parse(read(hintsPath));
    assert.equal(hints.projects["tower-of-lost-things"], undefined);
    assert.deepEqual(hints.projects.tolt.aliases, ["the tower", "tower-of-lost-things"]);
    assert.equal(hints.projects.tolt.about, "A tower.");
    assert.deepEqual(Object.keys(hints.projects), ["tolt", "zzz"], "the entry keeps its place");
    assert.match(read(fleetPath), /identifier: TOLT/);
    const ran = read(marker);
    assert.match(ran, /candystore :: run project:sync/);
    assert.match(result.warnings.join("\n"), /notebook state/);
    assert.match(result.warnings.join("\n"), /TOWE-n/);
    assert.match(result.warnings.join("\n"), /committed/);
  });

  await check("re-running a finished rename is a no-op success (same key, and old id after the fact)", async () => {
    const before = snapshot();
    const same = JSON.parse(rename(["tolt", "TOLT", "--apply", "--json"]).stdout);
    assert.equal(same.ok, true);
    assert.equal(same.noop, true);
    assert.equal(same.steps.find((step) => step.step === "candystore").status, "already", "a pure no-op does not poke the projection");
    const resumed = rename(["tower-of-lost-things", "tolt", "--apply", "--json"]);
    assert.equal(resumed.status, 0, resumed.stdout);
    const doc = JSON.parse(resumed.stdout);
    assert.equal(doc.resumed, true);
    assert.deepEqual(
      doc.steps.filter((step) => step.status !== "already" && step.status !== "skipped").map((step) => step.step),
      ["candystore"],
      "only the idempotent projection refresh runs again",
    );
    assert.deepEqual(snapshot(), before);
    assert.equal((await planeState()).patches.length, 1, "no second Plane write");
  });

  await check("a wrong old id after a finished rename is unknown_project and writes nothing", async () => {
    const before = snapshot();
    const run = rename(["not-the-old-id", "tolt", "--apply", "--json"]);
    assert.equal(run.status, 1, run.stdout);
    assert.equal(JSON.parse(run.stdout).code, "unknown_project");
    assert.deepEqual(snapshot(), before);
    assert.equal((await planeState()).patches.length, 1);
  });

  // -------------------------------------------------------------------------
  // Partial failure converges on re-run
  // -------------------------------------------------------------------------
  await check("Plane refusing the identifier fails the chain before anything local moves", async () => {
    const before = read(join(projectDirs.taken, ".project.json"));
    const regBefore = read(registry);
    const run = rename(["taken", "TAKEN", "--apply", "--json"]);
    assert.equal(run.status, 1, run.stdout);
    const doc = JSON.parse(run.stdout);
    assert.equal(doc.ok, false);
    assert.equal(doc.code, "step_failed");
    const byStep = Object.fromEntries(doc.steps.map((step) => [step.step, step.status]));
    assert.equal(byStep.plane, "failed");
    assert.equal(byStep.manifest, "blocked");
    assert.equal(byStep.registry, "blocked");
    assert.equal(read(join(projectDirs.taken, ".project.json")), before);
    assert.equal(read(registry), regBefore);
    assert.equal(await boardIdentifier(BOARDS.taken), "TAKE");
  });

  await check("Plane renamed + manifest write failed reports exactly that, and a re-run completes", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const dir = projectDirs.partial;
    chmodSync(dir, 0o555);
    try {
      const run = rename(["partial", "parted", "--apply", "--json"]);
      assert.equal(run.status, 1, run.stdout);
      const doc = JSON.parse(run.stdout);
      assert.equal(doc.ok, false);
      const byStep = Object.fromEntries(doc.steps.map((step) => [step.step, step.status]));
      assert.equal(byStep.plane, "done");
      assert.equal(byStep.manifest, "failed");
      assert.equal(byStep.registry, "blocked");
      assert.equal(await boardIdentifier(BOARDS.partial), "PARTED");
      assert.equal(manifestOf(dir).project_id, "partial", "the manifest did not move");
      assert.ok(registryDoc().projects.partial, "the registry did not move");
    } finally {
      chmodSync(dir, 0o755);
    }
    const again = rename(["partial", "parted", "--apply", "--json"]);
    assert.equal(again.status, 0, again.stdout);
    const result = JSON.parse(again.stdout);
    const byStep = Object.fromEntries(result.steps.map((step) => [step.step, step.status]));
    assert.equal(byStep.plane, "already", "Plane already showing NEW is success, not an error");
    assert.equal(byStep.manifest, "done");
    assert.equal(byStep.registry, "done");
    assert.equal(manifestOf(dir).project_id, "parted");
    assert.equal(manifestOf(dir).ticket_provider.identifier, "PARTED");
    assert.ok(registryDoc().projects.parted);
    assert.equal(registryDoc().projects.partial, undefined);
    assert.equal((await planeState()).patches.filter((patch) => patch.id === BOARDS.partial).length, 1);
  });

  // -------------------------------------------------------------------------
  // Trello: no provider write
  // -------------------------------------------------------------------------
  await check("a Trello board renames locally and makes no provider write", async () => {
    const before = (await planeState()).patches.length;
    const run = rename(["trellop", "trellq", "--apply", "--json"]);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const result = JSON.parse(run.stdout);
    const byStep = Object.fromEntries(result.steps.map((step) => [step.step, step.status]));
    assert.equal(byStep.plane, "skipped");
    assert.equal(byStep.manifest, "done");
    assert.equal(byStep.registry, "done");
    assert.equal((await planeState()).patches.length, before);
    const manifest = manifestOf(projectDirs.trellop);
    assert.equal(manifest.project_id, "trellq");
    assert.equal(manifest.ticket_provider.identifier, "TRELLQ");
    assert.equal(manifest.ticket_provider.identifier_source, "proposed", "Trello assigns no key; its identifier stays a proposal");
    assert.equal("identifier_fetched_at" in manifest.ticket_provider, false);
    assert.equal(manifest.ticket_provider.board_id, "abc123");
    assert.ok(registryDoc().projects.trellq);
    assert.match(result.warnings.join("\n"), /could not be verified/);
  });

  // -------------------------------------------------------------------------
  // Service registry: manifest first, then POST /v1/index, never PUT
  // -------------------------------------------------------------------------
  await check("the service registry is re-indexed from the manifest and never PUT", async () => {
    const stateOf = async () => (await fetch(`${serviceBase}/__state`)).json();
    const dry = cli(["project", "rename", "svcp", "svcnew", "--registry", serviceBase, "--json"]);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.equal(manifestOf(serviceDir).project_id, "svcp", "a dry run leaves the manifest alone");
    assert.deepEqual((await stateOf()).indexed, []);

    const run = cli(["project", "rename", "svcp", "svcnew", "--registry", serviceBase, "--apply", "--json"]);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true, run.stdout);
    assert.equal(manifestOf(serviceDir).project_id, "svcnew");
    assert.equal(manifestOf(serviceDir).ticket_provider.identifier, "SVCNEW");
    assert.equal(await boardIdentifier(BOARDS.service), "SVCNEW");
    const state = await stateOf();
    assert.equal(state.puts, 0, "the id change never passes through PUT /v1/registry");
    assert.deepEqual(state.indexed, ["svcnew"]);
    assert.deepEqual(state.rows.map(([id]) => id), ["svcnew"]);
  });

  await check("`pj rename` is the same command at the top level", async () => {
    const run = spawnSync(process.execPath, [CLI, "rename", "--help"], { encoding: "utf8", env: hermeticEnv({ HOME: home }) });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /<old-id> <new-id>/);
  });

  // -------------------------------------------------------------------------
  // Follow-up steps: resume, links, candystore, read-back, hints
  // -------------------------------------------------------------------------
  await check("a re-run after an AGENTS.md failure fixes the Board: line via renamed_from", async () => {
    const dir = projectDirs.agfail;
    mkdirSync(join(dir, "AGENTS.md")); // a directory: reading it fails the step
    const first = rename(["agfail", "agfix", "--apply", "--json"]);
    assert.equal(first.status, 1, first.stdout);
    const failed = JSON.parse(first.stdout);
    assert.equal(failed.steps.find((step) => step.step === "AGENTS.md").status, "failed");
    assert.equal(failed.steps.find((step) => step.step === "registry").status, "done");
    assert.equal(manifestOf(dir).renamed_from.project_id, "agfail");
    rmSync(join(dir, "AGENTS.md"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "Board:  agfail (AGFAIL)\n");
    const again = rename(["agfail", "agfix", "--apply", "--json"]);
    assert.equal(again.status, 0, again.stdout);
    const result = JSON.parse(again.stdout);
    assert.equal(result.resumed, true);
    assert.equal(result.steps.find((step) => step.step === "AGENTS.md").status, "done");
    assert.equal(read(join(dir, "AGENTS.md")), "Board:  agfail (AGFIX)\n");
    assert.equal(manifestOf(dir).renamed_from.project_id, "agfail", "a resume keeps the first run's provenance");
    assert.ok(!result.warnings.some((warning) => /ticket refs/.test(warning)), "no board change this run, no ticket-ref warning");
  });

  await check("AGENTS.md as a symlink inside the repo keeps the link and updates its target; outside the repo it is left alone", async () => {
    const inside = projectDirs.symin;
    mkdirSync(join(inside, "docs"), { recursive: true });
    writeFileSync(join(inside, "docs", "AGENTS.real.md"), "Board:  symin (SYMIN)\n");
    symlinkSync(join("docs", "AGENTS.real.md"), join(inside, "AGENTS.md"));
    const run = rename(["symin", "symnew", "--apply", "--json"]);
    assert.equal(run.status, 0, run.stdout);
    assert.equal(readlinkSync(join(inside, "AGENTS.md")), join("docs", "AGENTS.real.md"));
    assert.equal(read(join(inside, "docs", "AGENTS.real.md")), "Board:  symin (SYMNEW)\n");

    const outside = projectDirs.symout;
    const shared = join(workspace, "outside", "AGENTS.md");
    mkdirSync(join(workspace, "outside"), { recursive: true });
    writeFileSync(shared, "Board:  symout (SYMOUT)\n");
    symlinkSync(shared, join(outside, "AGENTS.md"));
    const run2 = rename(["symout", "symoutnew", "--apply", "--json"]);
    assert.equal(run2.status, 0, run2.stdout);
    const step = JSON.parse(run2.stdout).steps.find((candidate) => candidate.step === "AGENTS.md");
    assert.equal(step.status, "skipped");
    assert.match(step.detail, /outside the repo/);
    assert.equal(read(shared), "Board:  symout (SYMOUT)\n", "a file outside the repo is never rewritten");
  });

  await check("mise absent skips the candystore step and exits 0; mise exiting 1 is step_failed", async () => {
    const quiet = rename(["nomise", "nomisex", "--apply", "--json"], { PATH: emptyBin });
    assert.equal(quiet.status, 0, quiet.stdout);
    assert.equal(JSON.parse(quiet.stdout).steps.find((step) => step.step === "candystore").status, "skipped");
    const loud = rename(["misefail", "misefailx", "--apply", "--json"], { PATH: failBin });
    assert.equal(loud.status, 1, loud.stdout);
    const doc = JSON.parse(loud.stdout);
    assert.equal(doc.code, "step_failed");
    assert.equal(doc.steps.find((step) => step.step === "candystore").status, "failed");
    assert.match(doc.steps.find((step) => step.step === "candystore").detail, /boom from mise/);
    assert.equal(doc.steps.find((step) => step.step === "registry").status, "done", "earlier steps stand");
  });

  await check("a Plane read-back mismatch fails the plane step and writes nothing local", async () => {
    const manifestBefore = read(join(projectDirs.liar, ".project.json"));
    const regBefore = read(registry);
    const run = rename(["liar", "liarx", "--apply", "--json"]);
    assert.equal(run.status, 1, run.stdout);
    const doc = JSON.parse(run.stdout);
    const byStep = Object.fromEntries(doc.steps.map((step) => [step.step, step.status]));
    assert.equal(byStep.plane, "failed");
    assert.equal(byStep.manifest, "blocked");
    assert.match(doc.steps[0].detail, /reads LIAR/);
    assert.equal(read(join(projectDirs.liar, ".project.json")), manifestBefore);
    assert.equal(read(registry), regBefore);
  });

  await check("a hints collision merges the old entry's aliases into the existing one", async () => {
    writeFileSync(
      hintsPath,
      `${JSON.stringify({ projects: { hintsold: { aliases: ["old a"], about: "old" }, mid: {}, hintsnew: { aliases: ["new b"], about: "keep me" } } }, null, 2)}\n`,
    );
    const run = rename(["hintsold", "hintsnew", "--apply", "--json"]);
    assert.equal(run.status, 0, run.stdout);
    const hints = JSON.parse(read(hintsPath)).projects;
    assert.equal(hints.hintsold, undefined);
    assert.equal(hints.hintsnew.about, "keep me");
    assert.deepEqual(hints.hintsnew.aliases, ["new b", "old a", "hintsold"]);
    assert.deepEqual(Object.keys(hints), ["mid", "hintsnew"]);
  });
} finally {
  for (const child of children) child.kill();
  for (const dir of temporary.reverse()) {
    try { chmodSync(join(workspace, "repos", "partial"), 0o755); } catch { /* already writable or gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("pj project rename regressions passed");
