// PJAN-30 — ticket-board provisioning belongs to the project plan executor.
// These tests inject only the provider adapter and exercise a `scaffold:false`
// plan directly. They intentionally do not claim ProjectRecipe lifecycle
// success; the packed lifecycle suite proves the production audit/Git boundary.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cleanup = [];
const SECRET = "plane-api-key-do-not-echo-8f3c1d";
const BOARD_ID = "82e56896-e7fd-466b-826c-1019441c64ca";

function makeDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-30-${name}-`));
  cleanup.push(dir);
  return dir;
}

// Bundle the source module into an isolated test runner. This is dependency
// injection at the module boundary, not a production environment bypass.
const apiBundleDir = makeDir("api-bundle");
const apiBundle = join(apiBundleDir, "project-api.cjs");
buildSync({
  entryPoints: [join(root, "src", "project", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: apiBundle,
  logLevel: "silent",
});
const {
  executeProjectInitPlan,
  formatProjectInitPlan,
  planProjectInit,
} = createRequire(import.meta.url)(apiBundle);

function makeStubAdapter({ fail = false } = {}) {
  const dir = makeDir("adapters");
  const script = `#!/bin/sh
set -eu
OP="\${1:-}"; shift 2>/dev/null || true
ROLE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WS="$(ROLE_DIR="$ROLE_DIR" python3 -c '
import os, json, pathlib
start = pathlib.Path(os.environ["ROLE_DIR"]).resolve()
for parent in [start, *start.parents]:
    f = parent / ".project.json"
    if f.is_file():
        try: print((json.loads(f.read_text()).get("ticket_provider") or {}).get("workspace", ""))
        except Exception: print("")
        break
else:
    print("")
')"
KEYSTATE=unset
[ -n "\${PLANE_API_KEY:-}" ] && KEYSTATE=set
if [ -n "\${PJAN30_RECORD:-}" ]; then
  OP="$OP" A1="\${1:-}" A2="\${2:-}" A3="\${3:-}" WS="$WS" KEYSTATE="$KEYSTATE" \
    python3 -c '
import os, json
print(json.dumps({"op": os.environ["OP"], "args": [os.environ["A1"], os.environ["A2"], os.environ["A3"]],
                  "workspace": os.environ["WS"], "key": os.environ["KEYSTATE"]}))' >> "$PJAN30_RECORD"
fi
${fail ? 'echo "plane: create_board failed: 403 forbidden" >&2\nexit 1\n' : ""}[ "$OP" = create_board ] || { echo "unexpected op: $OP" >&2; exit 2; }
printf '{"board_id":"${BOARD_ID}","identifier":"BRD","board_url":"https://plane.delo.sh/33god/projects/${BOARD_ID}/issues/"}\\n'
`;
  const path = join(dir, "plane.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

function readRecord(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function manifestProvider(repo) {
  return JSON.parse(readFileSync(join(repo, ".project.json"), "utf8")).ticket_provider;
}

function ticketAction(plan) {
  const action = plan.actions.find((entry) => entry.kind === "ticket-provider.create-or-link");
  assert.ok(action, "plan must carry a ticket-provider.create-or-link action");
  return action;
}

async function withEnvironment(home, adapters, extra, callback) {
  const updates = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    // The fleet dotenv is a real credential source now, so it has to be
    // redirected into the temp home or the host's own would leak into a test
    // that is asserting there is no credential at all.
    HERMES_FLEET_ENV: join(home, ".hermes", "fleet.env"),
    PJ_TICKET_PROVIDER_ADAPTERS: adapters,
    PLANE_API_KEY: "",
    // Workspace-scoped names are accepted too, so every one this suite can
    // derive must be blanked for the same reason.
    PLANE_DEFAULT_API_KEY: "",
    PLANE_33GOD_API_KEY: "",
    PLANE_PJAN30WS_API_KEY: "",
    TRELLO_KEY: "",
    TRELLO_TOKEN: "",
    ...extra,
  };
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makePlan({ name, description, repo, registry, identifier, workspace = "33god", apply = true, live = true, skipPlane = false }) {
  return planProjectInit({
    name,
    description,
    targetDir: repo,
    registryPath: registry,
    projectIdentifier: identifier,
    planeWorkspace: workspace,
    apply,
    live,
    skipPlane,
    scaffold: false,
    provisionAgent: false,
    pjanglerRoot: root,
  });
}

try {
  {
    const home = makeDir("live-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "BoardProj");
    const registry = join(home, "projects.yaml");

    await withEnvironment(home, adapters, { PLANE_API_KEY: SECRET, PJAN30_RECORD: record }, async () => {
      const plan = makePlan({
        name: "Board Proj",
        description: "PJAN-30 live coverage",
        repo,
        registry,
        identifier: "BRD",
        workspace: "pjan30ws",
      });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));

      const invocations = readRecord(record);
      assert.equal(invocations.length, 1, "the adapter must be invoked exactly once");
      assert.equal(invocations[0].op, "create_board");
      assert.deepEqual(invocations[0].args, ["Board Proj", "BRD", "PJAN-30 live coverage"]);
      assert.equal(invocations[0].key, "set");
      assert.equal(invocations[0].workspace, "pjan30ws", "the staged adapter must resolve the planned workspace");

      const provider = manifestProvider(repo);
      assert.deepEqual(
        { board_id: provider.board_id, state: provider.state, identifier: provider.identifier, workspace: provider.workspace },
        { board_id: BOARD_ID, state: "linked", identifier: "BRD", workspace: "pjan30ws" },
      );
      const registryRecord = YAML.parse(readFileSync(registry, "utf8")).projects["board-proj"];
      assert.equal(registryRecord.ticket_provider.board_id, BOARD_ID);
      assert.equal(registryRecord.ticket_provider.state, "linked");
      assert.equal(ticketAction(plan).boardId, BOARD_ID);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET), "credentials must never enter reports");

      const manifestBefore = readFileSync(join(repo, ".project.json"), "utf8");
      const registryBefore = readFileSync(registry, "utf8");
      const secondPlan = makePlan({
        name: "Board Proj",
        description: "PJAN-30 live coverage",
        repo,
        registry,
        identifier: "BRD",
        workspace: "pjan30ws",
      });
      const second = await executeProjectInitPlan(secondPlan);
      assert.equal(second.ok, true, JSON.stringify(second.errors));
      assert.equal(readRecord(record).length, 1, "a linked board must not be created twice");
      assert.equal(readFileSync(join(repo, ".project.json"), "utf8"), manifestBefore);
      assert.equal(readFileSync(registry, "utf8"), registryBefore);
      assert.deepEqual(second.changedFiles, [], "re-executing an equivalent plan must be idempotent");
      assert.equal(ticketAction(secondPlan).boardId, BOARD_ID);
    });
  }

  {
    const home = makeDir("nocreds-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "NoCredsProj");
    const registry = join(home, "projects.yaml");
    mkdirSync(join(home, ".config", "zshyzsh"), { recursive: true });
    writeFileSync(join(home, ".config", "zshyzsh", "secrets.zsh"), "export SOMETHING_ELSE=nope\n");

    await withEnvironment(home, adapters, { PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "No Creds Proj", description: "no credential", repo, registry, identifier: "NOCR" });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(readRecord(record).length, 0);
      assert.ok(
        result.logs.some((line) => /PLANE_API_KEY or PLANE_33GOD_API_KEY not set.*skipping plane board creation.*--board-id/.test(line)),
        JSON.stringify(result.logs),
      );
      assert.equal(manifestProvider(repo).board_id, "");
      assert.equal(manifestProvider(repo).state, "planned");
    });
  }

  {
    const home = makeDir("dotenv-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "DotenvProj");
    const registry = join(home, "projects.yaml");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".env"), `# comment\nPLANE_API_KEY="${SECRET}"\n`);

    await withEnvironment(home, adapters, { PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "Dotenv Proj", description: "dotenv credential", repo, registry, identifier: "DOTE" });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(readRecord(record).length, 1);
      assert.equal(readRecord(record)[0].key, "set");
      assert.equal(manifestProvider(repo).board_id, BOARD_ID);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    });
  }

  {
    const home = makeDir("dry-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "DryProj");
    const registry = join(home, "projects.yaml");

    await withEnvironment(home, adapters, { PLANE_API_KEY: SECRET, PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "Dry Proj", description: "dry run", repo, registry, identifier: "DRY", apply: false });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true);
      assert.deepEqual(result.changedFiles, []);
      assert.equal(readRecord(record).length, 0);
      assert.equal(existsSync(repo), false);
      assert.equal(existsSync(registry), false);
      const action = ticketAction(plan);
      assert.equal(action.live, true);
      assert.equal(action.boardId, "");
      assert.match(action.reason, /create or link the plane board/);
      const human = formatProjectInitPlan(plan);
      assert.match(human, /ticket-provider\.create-or-link/);
      assert.match(human, /board: plane\/33god\/DRY/);
    });
  }

  {
    // The board is NOT gated on --live any more. `pj init` is the designated
    // ingress and a record with board_id "" fails the registry's own contract,
    // so `live: false` must still reach the adapter. This assertion used to say
    // the opposite, and that is exactly how 11 of 24 records were born.
    const home = makeDir("nolive-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "NoLiveProj");
    const registry = join(home, "projects.yaml");

    await withEnvironment(home, adapters, { PLANE_API_KEY: SECRET, PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "No Live Proj", description: "no live", repo, registry, identifier: "NOLI", live: false });
      const action = ticketAction(plan);
      assert.equal(action.enabled, true, "board provisioning must not require --live");
      assert.match(action.reason, /create or link the plane board/);
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(readRecord(record).length, 1, "the adapter must run without --live");
      assert.equal(manifestProvider(repo).state, "linked");
      assert.equal(manifestProvider(repo).board_id, BOARD_ID);
    });
  }

  {
    // The single subtractive gate. Nothing else may suppress the board.
    const home = makeDir("skipboard-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "SkipBoardProj");
    const registry = join(home, "projects.yaml");

    await withEnvironment(home, adapters, { PLANE_API_KEY: SECRET, PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "Skip Board Proj", description: "skip", repo, registry, identifier: "SKIP", skipPlane: true });
      const action = ticketAction(plan);
      assert.equal(action.enabled, false, "--skip-board must dominate");
      assert.match(action.reason, /skip-board|skipPlane/i);
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(readRecord(record).length, 0, "a suppressed board must never reach the adapter");
      assert.equal(manifestProvider(repo).state, "planned");
      assert.equal(manifestProvider(repo).board_id, "");
    });
  }

  {
    // The adapter accepts PLANE_<WORKSPACE>_API_KEY and reads ~/.hermes/fleet.env.
    // pjangler's precondition check asked only for PLANE_API_KEY, so on a host
    // whose only credential is workspace-scoped it declared "no credentials"
    // and skipped a board creation that would have succeeded.
    const home = makeDir("wsscoped-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "WsScopedProj");
    const registry = join(home, "projects.yaml");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "fleet.env"), `# fleet\nexport PLANE_PJAN30WS_API_KEY="${SECRET}"\n`);

    await withEnvironment(home, adapters, { PJAN30_RECORD: record, HERMES_FLEET_ENV: join(home, ".hermes", "fleet.env") }, async () => {
      const plan = makePlan({ name: "Ws Scoped Proj", description: "workspace-scoped credential", repo, registry, identifier: "WSSC", workspace: "pjan30ws" });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(readRecord(record).length, 1, "a workspace-scoped fleet.env credential must reach the adapter");
      assert.equal(manifestProvider(repo).board_id, BOARD_ID);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    });
  }

  {
    const home = makeDir("fail-home");
    const adapters = makeStubAdapter({ fail: true });
    const record = join(home, "invocations.jsonl");
    const repo = join(home, "work", "FailProj");
    const registry = join(home, "projects.yaml");

    await withEnvironment(home, adapters, { PLANE_API_KEY: SECRET, PJAN30_RECORD: record }, async () => {
      const plan = makePlan({ name: "Fail Proj", description: "adapter failure", repo, registry, identifier: "FAIL" });
      const result = await executeProjectInitPlan(plan);
      assert.equal(result.ok, false);
      assert.equal(readRecord(record).length, 1);
      assert.ok(result.errors.some((line) => /create_board failed.*exit 1.*403 forbidden/.test(line)), JSON.stringify(result.errors));
      assert.equal(manifestProvider(repo).board_id, "");
      assert.equal(manifestProvider(repo).state, "planned");
      assert.equal(existsSync(registry), false, "failed provisioning must not persist the pending registry action");
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    });
  }

  console.log("PJAN-30 ticket-provider plan executor regressions: PASS");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
