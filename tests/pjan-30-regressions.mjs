// PJAN-30 — `pjangler init --apply --live` must actually provision the repo's
// ticket board through the `tp` provider adapter, and must degrade gracefully
// when credentials are absent.
//
// Fully hermetic: the Plane adapter is replaced by a stub on
// PJ_TICKET_PROVIDER_ADAPTERS and copier is replaced by a stub on PATH, so no
// test in this file touches the network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const cleanup = [];

const SECRET = "plane-api-key-do-not-echo-8f3c1d";
const BOARD_ID = "82e56896-e7fd-466b-826c-1019441c64ca";

function makeDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-30-${name}-`));
  cleanup.push(dir);
  return dir;
}

/** copier stand-in: the scaffold is irrelevant here, only that init proceeds. */
function makeFakeCopier() {
  const bin = makeDir("bin");
  const copier = join(bin, "copier");
  writeFileSync(copier, "#!/bin/sh\nexit 0\n");
  chmodSync(copier, 0o755);
  return bin;
}

/**
 * Stub `tp` Plane adapter. Records one JSON line per invocation into
 * $PJAN30_RECORD capturing the op, its args, whether the credential arrived,
 * and the workspace the adapter resolves the same way the real plane.sh does
 * (nearest .project.json above $0/../..). Never prints the credential.
 */
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
  OP="$OP" A1="\${1:-}" A2="\${2:-}" A3="\${3:-}" WS="$WS" KEYSTATE="$KEYSTATE" \\
    python3 -c '
import os, json
print(json.dumps({"op": os.environ["OP"], "args": [os.environ["A1"], os.environ["A2"], os.environ["A3"]],
                  "workspace": os.environ["WS"], "key": os.environ["KEYSTATE"]}))' >> "$PJAN30_RECORD"
fi
${fail ? 'echo "plane: create_board failed: 403 forbidden" >&2\nexit 1\n' : ""}[ "$OP" = create_board ] || { echo "unexpected op: $OP" >&2; exit 2; }
printf '{"board_id":"${BOARD_ID}","board_url":"https://plane.delo.sh/33god/projects/${BOARD_ID}/issues/"}\\n'
`;
  writeFileSync(join(dir, "plane.sh"), script);
  chmodSync(join(dir, "plane.sh"), 0o755);
  return dir;
}

function readRecord(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runInit(args, { env = {}, home, adapters, copierBin }) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${copierBin}:${process.env.PATH}`,
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
      // Never let the developer's real credentials leak into the fixture.
      PLANE_API_KEY: "",
      TRELLO_KEY: "",
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result;
}

function jsonInit(args, options) {
  const result = runInit(args, options);
  assert.ok(result.stdout.trim(), `expected JSON output\nstderr:\n${result.stderr}`);
  return { result, json: JSON.parse(result.stdout) };
}

function ticketAction(payload) {
  const actions = payload.actions ?? payload.plan?.actions ?? [];
  const action = actions.find((entry) => entry.kind === "ticket-provider.create-or-link");
  assert.ok(action, "plan must always carry a ticket-provider.create-or-link action");
  return action;
}

function manifestProvider(repo) {
  return JSON.parse(readFileSync(join(repo, ".project.json"), "utf8")).ticket_provider;
}

try {
  const copierBin = makeFakeCopier();

  // ── 1. creds + --live: the adapter is really invoked and board_id lands in
  //       .project.json with state flipped to "linked" ──────────────────────
  {
    const home = makeDir("live-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const workspace = join(home, "work");
    mkdirSync(workspace, { recursive: true });
    const repo = join(workspace, "BoardProj");
    const registry = join(home, "projects.yaml");

    const { result, json } = jsonInit([
      "init", "Board Proj",
      "--description", "PJAN-30 live coverage",
      "--target-dir", repo,
      "--identifier", "BRD",
      "--workspace", "pjan30ws",
      "--registry", registry,
      "--apply", "--yes", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });

    assert.equal(result.status, 0, `init must succeed\nstderr:\n${result.stderr}`);
    assert.equal(json.ok, true, "live init must report ok");

    const invocations = readRecord(record);
    assert.equal(invocations.length, 1, "the adapter must be invoked exactly once");
    assert.equal(invocations[0].op, "create_board", "the executor must call the create_board op");
    assert.deepEqual(
      invocations[0].args,
      ["Board Proj", "BRD", "PJAN-30 live coverage"],
      "create_board must receive <name> <identifier> <description>",
    );
    assert.equal(invocations[0].key, "set", "the adapter must receive the resolved credential");
    assert.equal(
      invocations[0].workspace,
      "pjan30ws",
      "the adapter must resolve the plan's workspace, not pjangler's own .project.json (33god)",
    );

    const provider = manifestProvider(repo);
    assert.equal(provider.board_id, BOARD_ID, "board_id must be written back into .project.json");
    assert.equal(provider.state, "linked", "state must flip planned -> linked once a board exists");
    assert.equal(provider.identifier, "BRD");
    assert.equal(provider.workspace, "pjan30ws");

    const record0 = YAML.parse(readFileSync(registry, "utf8")).projects["board-proj"];
    assert.equal(record0.ticket_provider.board_id, BOARD_ID, "the registry must record the provisioned board");
    assert.equal(record0.ticket_provider.state, "linked");

    assert.equal(ticketAction(json).boardId, BOARD_ID, "the reported plan must reflect the linked board");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET), "the credential must never be echoed");

    // ── 2. idempotency: re-running creates no second board and rewrites nothing
    const before = readFileSync(join(repo, ".project.json"), "utf8");
    const registryBefore = readFileSync(registry, "utf8");
    const second = jsonInit([
      "init", "Board Proj",
      "--description", "PJAN-30 live coverage",
      "--target-dir", repo,
      "--identifier", "BRD",
      "--workspace", "pjan30ws",
      "--registry", registry,
      "--apply", "--yes", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });

    assert.equal(second.result.status, 0, `re-running init must succeed\nstderr:\n${second.result.stderr}`);
    assert.equal(second.json.ok, true);
    assert.equal(
      readRecord(record).length,
      1,
      "re-running init must NOT call create_board again — no duplicate board",
    );
    assert.equal(readFileSync(join(repo, ".project.json"), "utf8"), before, ".project.json must not be rewritten");
    assert.equal(readFileSync(registry, "utf8"), registryBefore, "the registry must not be rewritten");
    assert.equal(ticketAction(second.json).boardId, BOARD_ID, "the second plan must inherit the linked board");
    assert.equal(
      second.json.changedFiles.some((path) => path.endsWith(".project.json") || path.endsWith("projects.yaml")),
      false,
      `an already-linked project must rewrite no SOT file, got ${JSON.stringify(second.json.changedFiles)}`,
    );
  }

  // ── 3. no credentials: init still SUCCEEDS, board creation is skipped with a
  //       clear message, state stays "planned", key never echoed ────────────
  {
    const home = makeDir("nocreds-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(makeDir("nocreds-work"), "NoCredsProj");
    const registry = join(home, "projects.yaml");
    // A decoy secrets file that does NOT define PLANE_API_KEY: proves the
    // lookup chain is walked without inventing a credential.
    mkdirSync(join(home, ".config", "zshyzsh"), { recursive: true });
    writeFileSync(join(home, ".config", "zshyzsh", "secrets.zsh"), "export SOMETHING_ELSE=nope\n");

    const { result, json } = jsonInit([
      "init", "No Creds Proj",
      "--description", "PJAN-30 no-credential coverage",
      "--target-dir", repo,
      "--identifier", "NOCR",
      "--workspace", "33god",
      "--registry", registry,
      "--apply", "--yes", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PJAN30_RECORD: record } });

    assert.equal(result.status, 0, `init must still succeed without credentials\nstderr:\n${result.stderr}`);
    assert.equal(json.ok, true, "a missing credential must never fail the whole init");
    assert.deepEqual(json.errors, [], "a missing credential is a skip, not an error");
    assert.equal(readRecord(record).length, 0, "the adapter must not be invoked without credentials");

    const skipLog = json.logs.find((line) => line.includes("PLANE_API_KEY not set"));
    assert.ok(skipLog, `expected an actionable skip message, got: ${JSON.stringify(json.logs)}`);
    assert.match(skipLog, /skipping plane board creation/, "the skip message must say what was skipped");
    assert.match(skipLog, /--live/, "the skip message must say how to retry");

    const provider = manifestProvider(repo);
    assert.equal(provider.board_id, "", "board_id must stay empty when creation is skipped");
    assert.equal(provider.state, "planned", "state must stay planned when creation is skipped");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET), "no credential may be echoed");
  }

  // ── 3b. credentials resolved from the repo .env (process env -> .env chain) ─
  {
    const home = makeDir("dotenv-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(makeDir("dotenv-work"), "DotenvProj");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".env"), `# comment\nPLANE_API_KEY="${SECRET}"\n`);

    const { result, json } = jsonInit([
      "init", "Dotenv Proj",
      "--description", "PJAN-30 dotenv credential coverage",
      "--target-dir", repo,
      "--identifier", "DOTE",
      "--workspace", "33god",
      "--registry", join(home, "projects.yaml"),
      "--apply", "--yes", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PJAN30_RECORD: record } });

    assert.equal(result.status, 0, `init must succeed\nstderr:\n${result.stderr}`);
    assert.equal(json.ok, true);
    const invocations = readRecord(record);
    assert.equal(invocations.length, 1, "the repo .env credential must reach the adapter");
    assert.equal(invocations[0].key, "set");
    assert.equal(manifestProvider(repo).board_id, BOARD_ID);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET), "the credential must never be echoed");
  }

  // ── 4. --dry-run mutates nothing and calls no adapter, but still reports the
  //       action it would perform ───────────────────────────────────────────
  {
    const home = makeDir("dry-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(makeDir("dry-work"), "DryProj");
    const registry = join(home, "projects.yaml");

    const { result, json } = jsonInit([
      "init", "Dry Proj",
      "--description", "PJAN-30 dry-run coverage",
      "--target-dir", repo,
      "--identifier", "DRY",
      "--workspace", "33god",
      "--registry", registry,
      "--dry-run", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });

    assert.equal(result.status, 0, `dry-run must succeed\nstderr:\n${result.stderr}`);
    assert.equal(readRecord(record).length, 0, "dry-run must never invoke the provider adapter");
    assert.equal(existsSync(repo), false, "dry-run must not create the target repo");
    assert.equal(existsSync(registry), false, "dry-run must not write the registry");

    const action = ticketAction(json);
    assert.equal(action.live, true);
    assert.equal(action.boardId, "", "dry-run must not claim a board");
    assert.equal(action.state, "planned");
    assert.equal(action.boardName, "Dry Proj", "dry-run must describe the board it would create");
    assert.equal(action.identifier, "DRY");
    assert.equal(action.workspace, "33god");
    assert.match(action.reason, /create or link the plane board/, "dry-run must describe the board creation");
    assert.ok(
      json.proposedOperations.includes("ticket-provider.create-or-link"),
      "dry-run must report the board provisioning as a proposed operation",
    );

    // Human-readable dry-run output must describe it too (PJAN-25 parity).
    const human = runInit([
      "init", "Dry Proj",
      "--description", "PJAN-30 dry-run coverage",
      "--target-dir", repo,
      "--identifier", "DRY",
      "--workspace", "33god",
      "--registry", registry,
      "--dry-run", "--live", "--no-tui",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /ticket-provider\.create-or-link/);
    assert.match(human.stdout, /board: plane\/33god\/DRY/);
    assert.equal(readRecord(record).length, 0, "human dry-run must not invoke the adapter either");
  }

  // ── 4b. --apply WITHOUT --live stays a skip (gating preserved) ────────────
  {
    const home = makeDir("nolive-home");
    const adapters = makeStubAdapter();
    const record = join(home, "invocations.jsonl");
    const repo = join(makeDir("nolive-work"), "NoLiveProj");

    const planned = jsonInit([
      "init", "No Live Proj",
      "--description", "PJAN-30 apply-without-live coverage",
      "--target-dir", repo,
      "--identifier", "NOLI",
      "--workspace", "33god",
      "--registry", join(home, "projects.yaml"),
      "--dry-run", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } }).json;
    const plannedAction = ticketAction(planned);
    assert.equal(plannedAction.enabled, false, "the action must stay disabled without --live");
    assert.equal(plannedAction.live, false);
    assert.match(plannedAction.reason, /require --live/);

    const { result, json } = jsonInit([
      "init", "No Live Proj",
      "--description", "PJAN-30 apply-without-live coverage",
      "--target-dir", repo,
      "--identifier", "NOLI",
      "--workspace", "33god",
      "--registry", join(home, "projects.yaml"),
      "--apply", "--yes", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });

    assert.equal(result.status, 0, `init must succeed\nstderr:\n${result.stderr}`);
    assert.equal(json.ok, true);
    assert.equal(readRecord(record).length, 0, "--apply without --live must not touch the provider");
    assert.equal(manifestProvider(repo).state, "planned", "--apply without --live must leave state planned");
    assert.equal(
      (json.plan.actions ?? []).some((entry) => entry.kind === "ticket-provider.create-or-link"),
      false,
      "--apply without --live must not select the board action for execution",
    );
  }

  // ── 5. adapter failure surfaces a clear error and leaves .project.json intact
  {
    const home = makeDir("fail-home");
    const adapters = makeStubAdapter({ fail: true });
    const record = join(home, "invocations.jsonl");
    const repo = join(makeDir("fail-work"), "FailProj");
    const registry = join(home, "projects.yaml");

    const { result, json } = jsonInit([
      "init", "Fail Proj",
      "--description", "PJAN-30 adapter failure coverage",
      "--target-dir", repo,
      "--identifier", "FAIL",
      "--workspace", "33god",
      "--registry", registry,
      "--apply", "--yes", "--live", "--no-tui", "--json",
    ], { home, adapters, copierBin, env: { PLANE_API_KEY: SECRET, PJAN30_RECORD: record } });

    assert.equal(result.status, 1, "an adapter failure must be a non-zero exit");
    assert.equal(json.ok, false, "an adapter failure must not be reported as ok");
    assert.equal(readRecord(record).length, 1, "the adapter must have been attempted exactly once");
    const failure = json.errors.find((line) => line.includes("create_board failed"));
    assert.ok(failure, `expected a clear adapter failure, got: ${JSON.stringify(json.errors)}`);
    assert.match(failure, /exit 1/, "the error must carry the adapter's exit status");
    assert.match(failure, /403 forbidden/, "the error must carry the adapter's own diagnostics");

    const provider = manifestProvider(repo);
    assert.equal(provider.board_id, "", ".project.json must not be corrupted by a failed board creation");
    assert.equal(provider.state, "planned", "a failed creation must leave state planned");
    assert.equal(provider.identifier, "FAIL", ".project.json must otherwise stay intact");
    assert.equal(existsSync(registry), false, "a failed init must not upsert the registry");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET), "the credential must never be echoed");
  }

  console.log("PJAN-30 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
