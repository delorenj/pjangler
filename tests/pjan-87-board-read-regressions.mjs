// PJAN-87 — `pj board` read subcommands.
//
// Five subcommands that resolve their project implicitly from the working
// directory: provider, slug, status, recent, modules.
//
// The Plane client was developed against the live 33god board, and three
// properties found there are what this file exists to hold:
//
//   1. Plane v1 ACCEPTS `state` / `state_group` query filters and then IGNORES
//      them — the live board returned all 83 work items either way. So
//      `board status` must select started work client-side, over the complete
//      paginated set. A single page would silently under-report.
//   2. `issue.state` comes back as a bare UUID, so the states map is a
//      required join, and the selector is the state's GROUP, not its name.
//      This board spells `started` as "In Progress"; renaming that column, or
//      adding "In Review", must not change the answer.
//   3. The module deep link is `:workspaceSlug/projects/:projectId/modules/
//      :moduleId`, read off the live React Router manifest — the SPA answers
//      200 for any path, so status codes prove nothing about a route.
//
// The HTTP server below replays those observed response shapes (cursor
// envelope, field names, id-only state references) so the properties stay
// pinned without the suite needing network or a credential.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-87-"));

// TMPDIR can itself sit inside a git work tree on this machine. Every fixture
// carries its own `.git` and the ceiling is pinned, so nothing here can walk up
// into an enclosing repository and report ITS branch.
process.env.GIT_CEILING_DIRECTORIES = workspace;

const esbuild = join(root, "node_modules", ".bin", "esbuild");

function bundle(entrySources, outName) {
  const entry = join(workspace, `${outName}-entry.ts`);
  writeFileSync(entry, entrySources.map((s) => `export * from ${JSON.stringify(s)};`).join("\n"), "utf8");
  const out = join(workspace, `${outName}.mjs`);
  const built = spawnSync(
    esbuild,
    [entry, "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${out}`],
    { encoding: "utf8" },
  );
  if (built.status !== 0) {
    console.error(`failed to bundle ${outName}:\n${built.stderr}`);
    process.exit(1);
  }
  return out;
}

// The CLI inlines commander, whose CJS body calls `require` at load time; ESM
// output has no such binding. The shipped build never hits this because it
// leaves packages external, and the scratch bundle cannot.
function bundleCli() {
  const out = join(workspace, "pj.mjs");
  const built = spawnSync(
    esbuild,
    [
      join(root, "src", "index.ts"),
      "--bundle",
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      "--platform=node",
      "--format=esm",
      `--outfile=${out}`,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) {
    console.error(`failed to bundle the CLI:\n${built.stderr}`);
    process.exit(1);
  }
  return out;
}

const kitPath = bundle(
  [join(root, "src", "project", "boardQuery.ts"), join(root, "src", "project", "boardRender.ts")],
  "board-kit",
);

const {
  BOARD_PROVIDERS,
  BoardError,
  dotenvValue,
  fetchModules,
  fetchRecentTickets,
  fetchStartedTickets,
  formatModuleList,
  formatTicketTable,
  readProjectSlug,
  resolveBoardContext,
  resolvePlaneApiKey,
  resolveProject,
  resolveProvider,
  workspaceEnvKey,
} = await import(kitPath);

const cli = bundleCli();

/** Run `fn` and hand back what it threw. `assert.throws` does not return it. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw, got a return");
}

/** Same, for a rejected promise. */
async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection, got a resolution");
}

// ---------------------------------------------------------------------------
// Fixtures on disk
// ---------------------------------------------------------------------------

const WS = "33god";
const BOARD = "18a79832-00fb-4146-b054-d88528f9fef3";

function makeRepo(name, manifest) {
  const dir = join(workspace, name);
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/PJAN-87-board-reads\n", "utf8");
  if (manifest !== null) {
    writeFileSync(join(dir, ".project.json"), JSON.stringify(manifest, null, 2), "utf8");
  }
  return dir;
}

const planeRepo = makeRepo("plane-repo", {
  project_name: "pjangler",
  project_slug: "pjangler",
  ticket_provider: { type: "plane", workspace: WS, identifier: "PJAN", board_id: BOARD, state: "linked" },
});

const trelloRepo = makeRepo("trello-repo", {
  project_slug: "cards",
  ticket_provider: { type: "trello", board_id: "abc123" },
});

const unboundRepo = makeRepo("unbound-repo", { project_slug: "unbound", ticket_provider: {} });
const unknownRepo = makeRepo("unknown-repo", { project_slug: "weird", ticket_provider: { type: "jira" } });
const namelessRepo = makeRepo("nameless-repo", { project_name: "no slug here" });

const brokenRepo = join(workspace, "broken-repo");
mkdirSync(brokenRepo, { recursive: true });
writeFileSync(join(brokenRepo, ".project.json"), "{ not json", "utf8");

const outside = join(workspace, "outside");
mkdirSync(outside, { recursive: true });

// ---------------------------------------------------------------------------
// Implicit project resolution
// ---------------------------------------------------------------------------

console.log("resolution: project is found by walking up from the working directory");
{
  const fromRoot = resolveProject(planeRepo);
  const fromDeep = resolveProject(join(planeRepo, "nested", "deep"));
  assert.equal(fromRoot.root, fromDeep.root, "a nested directory must resolve to the same project root");
  assert.equal(fromDeep.slug, "pjangler");
  assert.equal(resolveProvider(fromDeep), "plane");
}

console.log("resolution: slug falls back to the directory name, never to nothing");
{
  assert.equal(readProjectSlug(namelessRepo), "nameless-repo", "a manifest with no slug still names a project");
  assert.equal(readProjectSlug(brokenRepo), "broken-repo", "an unparseable manifest still sits in a named directory");
}

console.log("resolution: outside a project fails with the directory it searched from");
{
  const error = caught(() => resolveProject(outside));
  assert.ok(error instanceof BoardError);
  assert.match(error.message, /not inside a pjangler project/);
  assert.ok(error.message.includes(outside), "the message must name where the search started");
}

console.log("resolution: every provider is accepted; anything else is named and refused");
{
  assert.deepEqual([...BOARD_PROVIDERS], ["plane", "trello", "linear"]);
  assert.equal(resolveProvider(resolveProject(trelloRepo)), "trello");

  const missing = caught(() => resolveProvider(resolveProject(unboundRepo)));
  assert.match(missing.message, /no ticket_provider\.type/);

  const unknown = caught(() => resolveProvider(resolveProject(unknownRepo)));
  assert.match(unknown.message, /unsupported ticket_provider\.type "jira"/);
  assert.match(unknown.message, /plane, trello, linear/, "the message must list what IS supported");
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

console.log("credentials: workspace key derivation matches the shell adapter");
{
  assert.equal(workspaceEnvKey("33god"), "PLANE_33GOD_API_KEY");
  assert.equal(workspaceEnvKey("my workspace"), "PLANE_MY_WORKSPACE_API_KEY");
  assert.equal(workspaceEnvKey("a.b-c"), "PLANE_A_B_C_API_KEY");
  assert.equal(workspaceEnvKey(""), "PLANE_DEFAULT_API_KEY", "an empty workspace must not produce PLANE__API_KEY");
  assert.equal(workspaceEnvKey(undefined), "PLANE_DEFAULT_API_KEY");
}

console.log("credentials: the fleet dotenv is read as inert data, never sourced");
{
  const fleet = join(workspace, "fleet.env");
  writeFileSync(
    fleet,
    [
      "# a comment",
      "UNRELATED=$(rm -rf /)",
      "export PLANE_33GOD_API_KEY='scoped-from-file'",
      'PLANE_API_KEY="generic-from-file"',
      "PLANE_33GOD_API_KEY_EXTRA=not-this-one",
    ].join("\n"),
    "utf8",
  );

  assert.equal(dotenvValue(fleet, "PLANE_33GOD_API_KEY"), "scoped-from-file", "export prefix and quotes must be stripped");
  assert.equal(dotenvValue(fleet, "PLANE_API_KEY"), "generic-from-file");
  assert.equal(dotenvValue(fleet, "UNRELATED"), "$(rm -rf /)", "a command substitution must come back as literal text");
  assert.equal(dotenvValue(fleet, "MISSING"), undefined);
  assert.equal(dotenvValue(join(workspace, "no-such-file"), "PLANE_API_KEY"), undefined);

  const env = { HERMES_FLEET_ENV: fleet };
  assert.equal(resolvePlaneApiKey(WS, env), "scoped-from-file", "the scoped file key beats the generic one");
  assert.equal(
    resolvePlaneApiKey(WS, { ...env, PLANE_33GOD_API_KEY: "scoped-from-env" }),
    "scoped-from-env",
    "the environment beats the file",
  );
  assert.equal(
    resolvePlaneApiKey(WS, { ...env, PLANE_33GOD_API_KEY: "scoped-from-env", PLANE_API_KEY: "generic-from-env" }),
    "generic-from-env",
    "an explicit PLANE_API_KEY wins outright, as it does in plane.sh",
  );
  assert.equal(resolvePlaneApiKey(WS, { HERMES_FLEET_ENV: join(workspace, "absent.env") }), undefined);
}

// ---------------------------------------------------------------------------
// A Plane that answers the way the live one does
// ---------------------------------------------------------------------------

const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog" },
  { id: "s-todo", name: "Todo", group: "unstarted" },
  { id: "s-progress", name: "In Progress", group: "started" },
  // A second started column. `status` must return both without config.
  { id: "s-review", name: "In Review", group: "started" },
  { id: "s-done", name: "Done", group: "completed" },
  { id: "s-cancelled", name: "Cancelled", group: "cancelled" },
];

// Deliberately NOT pre-sorted: the client is responsible for the ordering it
// promises, and `order_by` is only ever a hint.
const ISSUES = [
  issue(10, "s-progress", "2026-08-01T00:00:00Z", "2026-08-20T00:00:00Z"),
  issue(11, "s-done", "2026-08-02T00:00:00Z", "2026-08-26T00:00:00Z"),
  issue(12, "s-review", "2026-08-03T00:00:00Z", "2026-08-25T00:00:00Z"),
  issue(13, "s-backlog", "2026-08-04T00:00:00Z", "2026-08-04T00:00:00Z"),
  issue(14, "s-progress", "2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z"),
  issue(15, "s-todo", "2026-08-05T00:00:00Z", "2026-08-24T00:00:00Z"),
  issue(16, "s-cancelled", "2026-08-06T00:00:00Z", "2026-08-06T00:00:00Z"),
  // Newer created_at than updated_at. Plane does not normally produce this,
  // but "most recently added OR updated" is one ordering over both stamps and
  // this row is the only thing that proves the client uses both.
  issue(17, "s-progress", "2026-08-23T00:00:00Z", "2026-08-10T00:00:00Z"),
  issue(18, "s-progress", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"),
];

function issue(sequence, state, createdAt, updatedAt) {
  return {
    id: `issue-${sequence}`,
    sequence_id: sequence,
    // Long enough that a narrow terminal has to truncate rather than wrap.
    name: `Work item ${sequence} — a deliberately long title that will not fit a narrow window`,
    state,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

const MODULES = [
  {
    id: "m-1",
    name: "Migrate",
    description: "Backfill parity for legacy repos",
    status: "backlog",
    total_issues: 8,
    completed_issues: 1,
    started_issues: 0,
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
  },
  {
    id: "m-2",
    name: "Hermes PM Agents",
    description: "Fleet-wide PM provisioning",
    status: "in-progress",
    total_issues: 5,
    completed_issues: 1,
    started_issues: 2,
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  },
];

/** Pages a list the way Plane does: a cursor envelope, `<size>:<page>:0`. */
function cursorPage(rows, query) {
  const size = Number(query.get("per_page")) || 100;
  const page = Number((query.get("cursor") ?? "").split(":")[1]) || 0;
  const slice = rows.slice(page * size, (page + 1) * size);
  const more = (page + 1) * size < rows.length;
  return {
    count: slice.length,
    total_count: rows.length,
    next_cursor: `${size}:${page + 1}:0`,
    next_page_results: more,
    results: slice,
  };
}

// The stub runs in its OWN process. The CLI end-to-end checks below use
// spawnSync, which blocks this process's event loop — an in-process server
// could never accept their connections, and every CLI read would time out.
const stubSource = `
import { createServer } from "node:http";

const WS = ${JSON.stringify(WS)};
const BOARD = ${JSON.stringify(BOARD)};
const STATES = ${JSON.stringify(STATES)};
const ISSUES = ${JSON.stringify(ISSUES)};
const MODULES = ${JSON.stringify(MODULES)};

const requests = [];
let authMode = "ok";

/** Pages a list the way Plane does: a cursor envelope, \`<size>:<page>:0\`. */
function cursorPage(rows, query) {
  const size = Number(query.get("per_page")) || 100;
  const page = Number((query.get("cursor") ?? "").split(":")[1]) || 0;
  const slice = rows.slice(page * size, (page + 1) * size);
  return {
    count: slice.length,
    total_count: rows.length,
    next_cursor: size + ":" + (page + 1) + ":0",
    next_page_results: (page + 1) * size < rows.length,
    results: slice,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Control plane for the test driver, never part of the Plane surface.
  if (url.pathname === "/__mode") { authMode = url.searchParams.get("value") ?? "ok"; return send(200, { authMode }); }
  if (url.pathname === "/__requests") return send(200, requests);

  requests.push({ path: url.pathname, query: url.search, key: req.headers["x-api-key"] });
  if (authMode === "unauthorized") return send(401, { error: "nope" });
  if (authMode === "missing") return send(404, { error: "not found" });

  const prefix = "/api/v1/workspaces/" + WS + "/projects/" + BOARD + "/";
  if (!url.pathname.startsWith(prefix)) return send(404, { error: "unexpected path" });

  switch (url.pathname.slice(prefix.length)) {
    case "states/": return send(200, cursorPage(STATES, url.searchParams));
    case "issues/": return send(200, cursorPage(ISSUES, url.searchParams));
    case "modules/": return send(200, cursorPage(MODULES, url.searchParams));
    default: return send(404, { error: "unexpected route" });
  }
});

server.listen(0, "127.0.0.1", () => process.stdout.write("port=" + server.address().port + "\\n"));
`;

const stubPath = join(workspace, "plane-stub.mjs");
writeFileSync(stubPath, stubSource, "utf8");

const stub = spawn(process.execPath, [stubPath], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("the Plane stub never reported a port")), 10_000);
  stub.stdout.on("data", (chunk) => {
    const match = /port=(\d+)/.exec(String(chunk));
    if (match) {
      clearTimeout(timer);
      done(Number(match[1]));
    }
  });
});
const base = `http://127.0.0.1:${port}`;

// A failed assertion aborts this process; without this the stub outlives it.
process.on("exit", () => stub.kill());

const setAuthMode = (value) => fetch(`${base}/__mode?value=${value}`).then((r) => r.json());
const recordedRequests = () => fetch(`${base}/__requests`).then((r) => r.json());

function context(overrides = {}) {
  return resolveBoardContext(
    planeRepo,
    {
      PLANE_BASE: base,
      PLANE_API_KEY: "test-key",
      HERMES_FLEET_ENV: join(workspace, "absent.env"),
      HERMES_TEMPLATE_CONFIG: join(workspace, "absent.toml"),
      ...overrides,
    },
    workspace,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

console.log("status: selects by state GROUP, ordered by newest add-or-update");
{
  const tickets = await fetchStartedTickets(context());
  assert.deepEqual(
    tickets.map((t) => t.key),
    ["PJAN-14", "PJAN-12", "PJAN-17", "PJAN-10", "PJAN-18"],
    "both started columns, newest touch first — PJAN-17 places by created_at, not updated_at",
  );
  assert.deepEqual(
    [...new Set(tickets.map((t) => t.state))].sort(),
    ["In Progress", "In Review"],
    "a second started column must be included without any configuration",
  );
  assert.ok(
    tickets.every((t) => t.stateGroup === "started"),
    "nothing outside the started group may appear",
  );
  assert.equal(
    tickets[0].url,
    `${base}/${WS}/browse/PJAN-14`,
    "a work-item link must point at the instance that was queried, not a hardcoded host",
  );
}

console.log("status: --limit trims the head of the same ordering");
{
  const tickets = await fetchStartedTickets(context(), 2);
  assert.deepEqual(tickets.map((t) => t.key), ["PJAN-14", "PJAN-12"]);
}

console.log("status: pagination is followed to exhaustion, not trusted to one page");
{
  // Nine issues, three at a time: a client that stops at the first page loses
  // two thirds of the board's started work and reports success.
  const tickets = await fetchStartedTickets(context({ PJANGLER_BOARD_PAGE_SIZE: "3" }));
  assert.deepEqual(
    tickets.map((t) => t.key),
    ["PJAN-14", "PJAN-12", "PJAN-17", "PJAN-10", "PJAN-18"],
    "a paged read must agree exactly with a single-page read",
  );
  const issuePages = (await recordedRequests()).filter(
    (r) => r.path.endsWith("/issues/") && r.query.includes("per_page=3"),
  );
  assert.equal(issuePages.length, 3, "nine issues at three per page is three requests");
  assert.ok(issuePages[1].query.includes("cursor="), "pages after the first must carry the server's cursor");
}

console.log("recent: N newest in any state, default independent of board order");
{
  const tickets = await fetchRecentTickets(context(), 5);
  assert.deepEqual(
    tickets.map((t) => t.key),
    ["PJAN-14", "PJAN-11", "PJAN-12", "PJAN-15", "PJAN-17"],
    "every state group is eligible here, unlike status",
  );
  assert.equal((await fetchRecentTickets(context(), 1)).length, 1);
  assert.equal(
    (await fetchRecentTickets(context(), 99)).length,
    ISSUES.length,
    "asking for more than exists returns everything, not an error",
  );
}

console.log("modules: normalized, newest first, deep-linked to the manifest route");
{
  const modules = await fetchModules(context());
  assert.deepEqual(modules.map((m) => m.name), ["Hermes PM Agents", "Migrate"]);
  assert.deepEqual(
    { total: modules[0].totalIssues, done: modules[0].completedIssues, started: modules[0].startedIssues },
    { total: 5, done: 1, started: 2 },
  );
  assert.equal(
    modules[0].url,
    `${base}/${WS}/projects/${BOARD}/modules/m-2`,
    "route read off the live React Router manifest: :workspaceSlug/projects/:projectId/modules/:moduleId",
  );
}

console.log("errors: a rejected key and a missing board each say what to fix");
{
  await setAuthMode("unauthorized");
  const denied = await rejected(fetchStartedTickets(context()));
  assert.ok(denied instanceof BoardError);
  assert.match(denied.message, /401/);
  assert.match(denied.message, /PLANE_API_KEY/, "the message must name the variables that carry the key");

  await setAuthMode("missing");
  const absent = await rejected(fetchModules(context()));
  assert.match(absent.message, /ticket_provider\.board_id/);
  await setAuthMode("ok");
}

console.log("errors: a missing key never becomes a silent empty board");
{
  const error = await rejected(
    fetchStartedTickets(context({ PLANE_API_KEY: undefined, PLANE_33GOD_API_KEY: undefined })),
  );
  assert.ok(error instanceof BoardError);
  assert.match(error.message, /no Plane API key/);
  assert.match(error.message, /PLANE_33GOD_API_KEY/, "the workspace-scoped name must be offered too");
}

console.log("errors: providers without a wired reader say so instead of guessing");
{
  const trelloContext = resolveBoardContext(trelloRepo, { PLANE_BASE: base }, workspace);
  for (const [verb, call] of [
    ["status", () => fetchStartedTickets(trelloContext)],
    ["recent", () => fetchRecentTickets(trelloContext, 5)],
    ["modules", () => fetchModules(trelloContext)],
  ]) {
    const error = await rejected(call());
    assert.ok(error instanceof BoardError, `board ${verb} must refuse a trello board explicitly`);
    assert.match(error.message, /not wired for trello/);
    assert.match(error.message, /board provider/, "the message must point at what does work everywhere");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

console.log("render: columns align on visible width and titles absorb the slack");
{
  const tickets = await fetchStartedTickets(context());
  const now = new Date("2026-08-27T12:00:00Z");
  const lines = formatTicketTable(tickets, { now, width: 100 });

  assert.equal(lines.length, tickets.length);
  const titleStarts = new Set(lines.map((line) => line.indexOf("Work item")));
  assert.equal(titleStarts.size, 1, "every title must begin in the same column");
  assert.ok([...titleStarts][0] > 0, "the title column must actually be found");
  assert.ok(lines.every((line) => line.length <= 100), "no line may exceed the terminal width");
  assert.ok(lines[0].includes("PJAN-14") && lines[0].includes("In Progress"));

  const narrow = formatTicketTable(tickets, { now, width: 46 });
  assert.ok(narrow.every((line) => line.length <= 46), "a narrow terminal truncates rather than wrapping");
  assert.ok(narrow.some((line) => line.includes("…")), "truncation must be marked, not silent");

  assert.deepEqual(formatTicketTable([]), [], "an empty board renders no rows");
}

console.log("render: a long state name is capped instead of eating the titles");
{
  const long = [
    {
      key: "PJAN-1",
      id: "x",
      title: "A title that must survive a verbose state column",
      state: "Complete but Unacknowledged",
      stateGroup: "completed",
      createdAt: "2026-08-27T00:00:00Z",
      updatedAt: "2026-08-27T00:00:00Z",
      touchedAt: "2026-08-27T00:00:00Z",
      url: undefined,
    },
  ];
  const [line] = formatTicketTable(long, { now: new Date("2026-08-27T02:00:00Z"), width: 100 });
  assert.ok(line.includes("Complete but Unac…"), "the state is truncated at the cap");
  assert.ok(line.includes("A title that must survive"), "the title still fits");
}

console.log("render: the module name column fits its content, not the window");
{
  const modules = await fetchModules(context());
  const lines = formatModuleList(modules, { now: new Date("2026-08-27T00:00:00Z"), width: 200 });
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every((line) => line.length < 60),
    `a two-module board must not pad out to the terminal width: ${JSON.stringify(lines)}`,
  );
  assert.ok(lines[0].includes("Hermes PM Agents") && lines[0].includes("1/5"));
  assert.deepEqual(formatModuleList([]), []);
}

// ---------------------------------------------------------------------------
// The CLI itself
// ---------------------------------------------------------------------------

function run(args, cwd = planeRepo, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: workspace,
      GIT_CEILING_DIRECTORIES: workspace,
      PLANE_BASE: base,
      PLANE_API_KEY: "test-key",
      HERMES_FLEET_ENV: join(workspace, "absent.env"),
      HERMES_TEMPLATE_CONFIG: join(workspace, "absent.toml"),
      ...extraEnv,
    },
  });
}

console.log("cli: provider and slug print one bare, script-consumable line");
{
  for (const cwd of [planeRepo, join(planeRepo, "nested", "deep")]) {
    assert.equal(run(["board", "provider"], cwd).stdout, "plane\n", "no decoration a script would have to strip");
    assert.equal(run(["board", "slug"], cwd).stdout, "pjangler\n");
  }
  assert.equal(run(["board", "provider"], trelloRepo).stdout, "trello\n");
  assert.equal(run(["board", "slug"], trelloRepo).stdout, "cards\n");
}

console.log("cli: reads outside a project exit non-zero and explain");
{
  for (const verb of ["provider", "slug", "status", "recent", "modules"]) {
    const result = run(["board", verb], outside);
    assert.equal(result.status, 1, `board ${verb} must fail outside a project`);
    assert.match(result.stderr, /not inside a pjangler project/);
    assert.equal(result.stdout, "", "nothing may reach stdout when the command failed");
  }
}

console.log("cli: recent defaults to five and rejects a nonsense count");
{
  const parse = (result) => {
    if (result.status !== 0 || !result.stdout) {
      assert.fail(`board recent failed (${result.status}): ${result.stderr || "no output"}`);
    }
    return JSON.parse(result.stdout).map((t) => t.key);
  };
  assert.deepEqual(parse(run(["board", "recent", "--json"])), ["PJAN-14", "PJAN-11", "PJAN-12", "PJAN-15", "PJAN-17"]);
  assert.deepEqual(parse(run(["board", "recent", "2", "--json"])), ["PJAN-14", "PJAN-11"]);

  for (const bad of ["0", "-1", "abc", "2.5"]) {
    const result = run(["board", "recent", bad]);
    assert.equal(result.status, 1, `count "${bad}" must be refused`);
    assert.match(result.stderr, /count must be a positive integer/);
  }
}

console.log("cli: status and modules render rows, and --json round-trips");
{
  const status = run(["board", "status"]);
  assert.equal(status.status, 0);
  assert.equal(status.stdout.trimEnd().split("\n").length, 5, "five started work items, one line each");
  assert.match(status.stdout, /PJAN-14/);
  assert.doesNotMatch(status.stdout, /PJAN-13/, "a backlog item must not appear in status");

  const statusJson = JSON.parse(run(["board", "status", "--json"]).stdout);
  assert.deepEqual(statusJson.map((t) => t.key), ["PJAN-14", "PJAN-12", "PJAN-17", "PJAN-10", "PJAN-18"]);

  const modules = run(["board", "modules"]);
  assert.equal(modules.status, 0);
  assert.match(modules.stdout, /Hermes PM Agents/);
  assert.equal(JSON.parse(run(["board", "modules", "--json"]).stdout).length, 2);
}

console.log("cli: subcommands did not swallow the original board command");
{
  // Commander dispatches a matching subcommand name before the parent action
  // handler. Everything that is NOT one of the five names must still reach the
  // opener exactly as it did before.
  assert.equal(run(["board", "--print"]).stdout.trim(), `${base}/${WS}/browse/PJAN-87`);
  assert.equal(run(["board", "71", "--print"]).stdout.trim(), `${base}/${WS}/browse/PJAN-71`);
  assert.equal(run(["board", "PJAN-9", "--print"]).stdout.trim(), `${base}/${WS}/browse/PJAN-9`);
  assert.equal(run(["board", "DECK-21", "--print"]).stdout.trim(), `${base}/${WS}/browse/DECK-21`);
}

console.log("cli: an empty board says so rather than printing a bare prompt");
{
  const empty = makeRepo("empty-board", {
    project_slug: "empty",
    ticket_provider: { type: "plane", workspace: WS, identifier: "EMPTY", board_id: "no-such-board" },
  });
  const result = run(["board", "status"], empty);
  assert.equal(result.status, 1, "an unknown board is a failure, not an empty list");
  assert.match(result.stderr, /404|board_id/);
}

stub.kill();
rmSync(workspace, { recursive: true, force: true });
console.log("PJAN-87 board read regressions: ok");
