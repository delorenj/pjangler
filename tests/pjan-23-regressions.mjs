// PJAN-23 — the `tp` ticket-provider contract must expose a `create_issue` op so
// an orchestrator can FILE a ticket, not only read and update the board.
//
// Two copies of every adapter ship: the repo-local one under
// agents/hermes/pm/.scripts and the distributable one inside the
// templates/hermes-agent submodule. They drift silently, so this file guards
// both the op dispatch lists AND the observable behaviour of `create_issue`.
//
// Fully hermetic: `curl` is replaced by a recording stub on PATH, so no test
// here touches Plane, Trello, or Linear.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cleanup = [];

const PROVIDERS = ["plane", "linear", "trello"];
const COPIES = {
  "repo-local": join(root, "agents", "hermes", "pm", ".scripts"),
  distributable: join(root, "templates", "hermes-agent", "template", ".scripts"),
};

/** The normalized op contract every adapter must dispatch. */
const CONTRACT_OPS = [
  "active_milestone",
  "comment",
  "create_board",
  "create_issue",
  "describe_board",
  "get_issue",
  "list_issues",
  "resolve",
  "transition",
];

const BOARD = "board-uuid-1";
const WORKSPACE = "testws";
const KEY = "plane-api-key-do-not-echo-4b2a9c";

function makeDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-23-${label}-`));
  cleanup.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Static analysis of the adapter sources
// ---------------------------------------------------------------------------

function adapterPath(copy, provider) {
  return join(COPIES[copy], "providers", `${provider}.sh`);
}

/**
 * Op labels dispatched by an adapter's `case "$OP" in` block. Only top-level
 * two-space-indented `<op>)` labels count, so nested one-line `case` statements
 * (such as the `--if-absent` flag parse) are not mistaken for ops.
 */
function dispatchedOps(file) {
  const source = readFileSync(file, "utf8");
  const body = source.slice(source.indexOf('case "$OP" in'));
  assert.ok(body.startsWith('case "$OP" in'), `${file} must dispatch on $OP`);
  return [...body.matchAll(/^ {2}([a-z_]+)\)$/gm)].map((match) => match[1]).sort();
}

/** The `create_issue` branch verbatim, from its label through its closing `;;`. */
function createIssueBranch(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.indexOf("  create_issue)");
  assert.notEqual(start, -1, `${file} must dispatch create_issue`);
  const end = lines.indexOf("    ;;", start);
  assert.notEqual(end, -1, `${file} create_issue branch must terminate with ;;`);
  return lines.slice(start, end + 1).join("\n");
}

// ---------------------------------------------------------------------------
// Hermetic adapter harness: staged role tree + recording `curl` stub
// ---------------------------------------------------------------------------

/**
 * Adapters resolve their board binding from the nearest .project.json ABOVE
 * <role_dir> (i.e. $0/../..), never from cwd. Staging a copy into a throwaway
 * role-shaped tree is the only way to run one against a fixture board without
 * it silently inheriting pjangler's own binding.
 */
function stageAdapter(copy, provider, ticketProvider) {
  const dir = makeDir(`${provider}-stage`);
  const target = join(dir, "agents", "hermes", "pm", ".scripts", "providers", `${provider}.sh`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(adapterPath(copy, provider), "utf8"));
  chmodSync(target, 0o755);
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ ticket_provider: ticketProvider }, null, 2));
  return { dir, adapter: target };
}

/**
 * A `curl` stand-in. Records every request as one JSON line into $PJAN23_LOG
 * and answers from a fixture table; an unmatched request fails the way
 * `curl -f` does, so a test can never silently reach the network.
 */
function makeCurlStub() {
  const dir = makeDir("bin");
  const stub = join(dir, "curl");
  writeFileSync(
    stub,
    `#!/usr/bin/env python3
import json, os, sys

argv = sys.argv[1:]
method, url, body, headers = "GET", "", "", []
i = 0
while i < len(argv):
    a = argv[i]
    if a == "-X":
        method = argv[i + 1]; i += 2
    elif a == "-H":
        headers.append(argv[i + 1]); i += 2
    elif a == "-d":
        body = argv[i + 1]; i += 2
    elif a.startswith("-"):
        i += 1
    else:
        url = a; i += 1

with open(os.environ["PJAN23_LOG"], "a") as fh:
    fh.write(json.dumps({"method": method, "url": url, "body": body, "headers": sorted(headers)}) + "\\n")

table = json.load(open(os.environ["PJAN23_RESPONSES"]))
for entry in table:
    if entry["method"] == method and entry["match"] in url:
        sys.stdout.write(entry["body"])
        sys.exit(0)
sys.stderr.write("curl stub: no fixture for %s %s\\n" % (method, url))
sys.exit(22)
`,
  );
  chmodSync(stub, 0o755);
  return dir;
}

const curlBin = makeCurlStub();

/** Run one staged adapter op with a fully controlled environment. */
function runOp({ adapter, args, responses = [], env = {} }) {
  const log = join(makeDir("log"), "requests.jsonl");
  const fixture = join(makeDir("fixture"), "responses.json");
  writeFileSync(fixture, JSON.stringify(responses));
  const home = makeDir("home");
  const result = spawnSync("sh", [adapter, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${curlBin}:/usr/bin:/bin`,
      HOME: home,
      // The repo-local Plane adapter sources the fleet env file; point it at
      // nothing so the developer's real credentials can never leak in.
      HERMES_FLEET_ENV: join(home, "does-not-exist.env"),
      PJAN23_LOG: log,
      PJAN23_RESPONSES: fixture,
      ...env,
    },
  });
  const requests = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...result, requests };
}

const PLANE_BINDING = { type: "plane", workspace: WORKSPACE, board_id: BOARD };
const PLANE_ENV = { PLANE_API_KEY: KEY };
const ISSUES_PATH = `/api/v1/workspaces/${WORKSPACE}/projects/${BOARD}/issues/`;

const CREATED_RESPONSE = {
  method: "POST",
  match: ISSUES_PATH,
  body: JSON.stringify({ id: "issue-uuid-1", sequence_id: 42, name: "Record the gap" }),
};
const LIST_WITH_MATCH = {
  method: "GET",
  match: ISSUES_PATH,
  body: JSON.stringify({
    results: [
      { id: "other-uuid", name: "Unrelated", sequence_id: 6 },
      { id: "existing-uuid", name: "  record the GAP ", sequence_id: 7 },
    ],
  }),
};
const LIST_EMPTY = { method: "GET", match: ISSUES_PATH, body: JSON.stringify({ results: [] }) };

/**
 * Run the same Plane scenario against both shipped copies and require parity.
 *
 * Requests are compared on method/url/body — the surface `create_issue` owns.
 * The `api` helper's header set is deliberately excluded: the repo-local copy
 * already sends a `User-Agent` the distributable one does not, a pre-existing
 * divergence in the shared helper that predates this op.
 */
function planeBothCopies(args, responses, env = PLANE_ENV) {
  const outcomes = Object.keys(COPIES).map((copy) => {
    const { adapter } = stageAdapter(copy, "plane", PLANE_BINDING);
    return [copy, runOp({ adapter, args, responses, env })];
  });
  const wire = (run) => run.requests.map(({ method, url, body }) => ({ method, url, body }));
  const [[, first], [secondName, second]] = outcomes;
  assert.equal(second.stdout, first.stdout, `${secondName} plane.sh stdout must match the repo-local copy`);
  assert.equal(second.status, first.status, `${secondName} plane.sh exit status must match the repo-local copy`);
  assert.deepEqual(
    wire(second),
    wire(first),
    `${secondName} plane.sh must issue the same requests as the repo-local copy`,
  );
  for (const [copy, run] of outcomes) {
    for (const request of run.requests) {
      assert.ok(
        request.headers.includes(`X-API-Key: ${env.PLANE_API_KEY}`),
        `${copy} plane.sh must authenticate through the shared api helper`,
      );
    }
  }
  return first;
}

try {
  // ------------------------------------------------------------------------
  // 1. create_issue is part of the dispatch contract, in every copy.
  // ------------------------------------------------------------------------
  for (const copy of Object.keys(COPIES)) {
    for (const provider of PROVIDERS) {
      const ops = dispatchedOps(adapterPath(copy, provider));
      assert.ok(ops.includes("create_issue"), `${copy} ${provider}.sh must dispatch create_issue`);
      assert.deepEqual(ops, CONTRACT_OPS, `${copy} ${provider}.sh must dispatch exactly the contract ops`);
    }
  }

  // ------------------------------------------------------------------------
  // 2. Drift guard: the two shipped copies of each adapter must expose the
  //    same op list, and the create_issue branch must be byte-identical.
  //    PJAN-48 showed how quickly these two trees diverge.
  // ------------------------------------------------------------------------
  for (const provider of PROVIDERS) {
    const [a, b] = Object.keys(COPIES);
    assert.deepEqual(
      dispatchedOps(adapterPath(b, provider)),
      dispatchedOps(adapterPath(a, provider)),
      `${provider}.sh op lists have drifted between the repo-local and distributable copies`,
    );
    assert.equal(
      createIssueBranch(adapterPath(b, provider)),
      createIssueBranch(adapterPath(a, provider)),
      `${provider}.sh create_issue implementations have drifted between copies`,
    );
  }

  // ------------------------------------------------------------------------
  // 3. Every provider implements the same op set — no provider may quietly
  //    omit an op from the contract.
  // ------------------------------------------------------------------------
  for (const copy of Object.keys(COPIES)) {
    const [reference, ...rest] = PROVIDERS;
    for (const provider of rest) {
      assert.deepEqual(
        dispatchedOps(adapterPath(copy, provider)),
        dispatchedOps(adapterPath(copy, reference)),
        `${copy} ${provider}.sh must implement the same ops as ${reference}.sh`,
      );
    }
  }

  // ------------------------------------------------------------------------
  // 4. The contract documentation declares create_issue wherever the op list
  //    is written down.
  // ------------------------------------------------------------------------
  for (const copy of Object.keys(COPIES)) {
    const lib = readFileSync(join(COPIES[copy], "lib", "ticket-provider.sh"), "utf8");
    const contract = lib.slice(lib.indexOf("# Contract (operations"), lib.indexOf("# Each provider reads"));
    for (const op of CONTRACT_OPS) {
      assert.ok(contract.includes(`#   ${op}`), `${copy} lib/ticket-provider.sh contract must document ${op}`);
    }
    assert.match(contract, /--if-absent/, `${copy} lib/ticket-provider.sh must document the create_issue dedupe flag`);
  }
  const providerDocs = readFileSync(
    join(root, "templates", "hermes-agent", "docs", "sentinel", "providers.md"),
    "utf8",
  );
  for (const op of CONTRACT_OPS) {
    assert.ok(providerDocs.includes(`| \`${op}\``), `providers.md contract table must document ${op}`);
  }

  // ------------------------------------------------------------------------
  // 5. create_issue files a ticket against the RESOLVED board — the board is
  //    never an argument — and prints the create_board-shaped JSON envelope.
  // ------------------------------------------------------------------------
  {
    const run = planeBothCopies(["create_issue", "Record the gap", "Found during PJAN-21"], [CREATED_RESPONSE]);
    assert.equal(run.status, 0, `create_issue must succeed\nstderr:\n${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), {
      issue_id: "issue-uuid-1",
      key: "42",
      issue_url: `https://plane.delo.sh/${WORKSPACE}/projects/${BOARD}/issues/issue-uuid-1`,
      created: true,
    });
    assert.equal(run.requests.length, 1, "the default path must not read the board before writing");
    const [request] = run.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, `https://plane.delo.sh${ISSUES_PATH}`);
    assert.deepEqual(JSON.parse(request.body), {
      name: "Record the gap",
      description_html: "<p>Found during PJAN-21</p>",
    });
    assert.ok(
      request.headers.includes(`X-API-Key: ${KEY}`),
      "create_issue must authenticate through the shared api helper",
    );
  }

  // A title-only call is valid; the adapter must not invent a description.
  {
    const run = planeBothCopies(["create_issue", "Title only"], [CREATED_RESPONSE]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.requests[0].body), { name: "Title only" });
  }

  // Description text is HTML-escaped, never injected raw into description_html.
  {
    const run = planeBothCopies(["create_issue", "Escapes", "a & b <script>"], [CREATED_RESPONSE]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      JSON.parse(run.requests[0].body).description_html,
      "<p>a &amp; b &lt;script&gt;</p>",
    );
  }

  // ------------------------------------------------------------------------
  // 6. Idempotency is opt-in. Plain calls always create (two tickets may
  //    legitimately share a title); --if-absent reuses an exact title match.
  // ------------------------------------------------------------------------
  {
    const duplicate = planeBothCopies(["create_issue", "Record the gap"], [LIST_WITH_MATCH, CREATED_RESPONSE]);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, true, "the default path must always file a new ticket");
    assert.deepEqual(
      duplicate.requests.map((entry) => entry.method),
      ["POST"],
      "the default path must not dedupe by title",
    );

    const reused = planeBothCopies(
      ["create_issue", "--if-absent", "Record the gap", "ignored"],
      [LIST_WITH_MATCH, CREATED_RESPONSE],
    );
    assert.equal(reused.status, 0, reused.stderr);
    assert.deepEqual(JSON.parse(reused.stdout), {
      issue_id: "existing-uuid",
      key: "7",
      issue_url: `https://plane.delo.sh/${WORKSPACE}/projects/${BOARD}/issues/existing-uuid`,
      created: false,
    });
    assert.deepEqual(
      reused.requests.map((entry) => entry.method),
      ["GET"],
      "--if-absent must reuse the matching issue instead of filing a duplicate",
    );

    const miss = planeBothCopies(["create_issue", "--if-absent", "Brand new"], [LIST_EMPTY, CREATED_RESPONSE]);
    assert.equal(miss.status, 0, miss.stderr);
    assert.equal(JSON.parse(miss.stdout).created, true);
    assert.deepEqual(
      miss.requests.map((entry) => entry.method),
      ["GET", "POST"],
      "--if-absent must still create when nothing matches",
    );
  }

  // ------------------------------------------------------------------------
  // 7. Trello files the same envelope: a card in the backlog list, the same
  //    {issue_id, key, issue_url, created} shape, and the same opt-in dedupe.
  // ------------------------------------------------------------------------
  {
    const binding = { type: "trello", board_id: "board-abc" };
    const env = { TRELLO_KEY: "k", TRELLO_TOKEN: "t" };
    const lists = {
      method: "GET",
      match: "/boards/board-abc/lists",
      body: JSON.stringify([{ id: "list-backlog", name: "Backlog" }, { id: "list-todo", name: "To Do" }]),
    };
    const cards = {
      method: "GET",
      match: "/boards/board-abc/cards",
      body: JSON.stringify([{ id: "card-existing", name: "record the GAP" }]),
    };
    const created = { method: "POST", match: "/1/cards?", body: JSON.stringify({ id: "card-1" }) };
    const card = (id) => ({
      method: "GET",
      match: `/cards/${id}`,
      body: JSON.stringify({ url: `https://trello.com/c/short-${id}`, shortLink: `short-${id}` }),
    });

    for (const copy of Object.keys(COPIES)) {
      const { adapter } = stageAdapter(copy, "trello", binding);
      const fresh = runOp({
        adapter,
        args: ["create_issue", "Record the gap", "Found during PJAN-21"],
        responses: [lists, created, card("card-1")],
        env,
      });
      assert.equal(fresh.status, 0, `${copy} trello.sh create_issue must succeed\nstderr:\n${fresh.stderr}`);
      assert.deepEqual(JSON.parse(fresh.stdout), {
        issue_id: "card-1",
        key: "short-card-1",
        issue_url: "https://trello.com/c/short-card-1",
        created: true,
      });
      const post = fresh.requests.find((entry) => entry.method === "POST");
      assert.ok(post, `${copy} trello.sh must POST a card`);
      assert.match(post.url, /idList=list-backlog/, "new cards must land in the backlog list");
      assert.match(post.url, /name=Record%20the%20gap/, "the title must be url-encoded onto the card");
      assert.match(post.url, /desc=Found%20during%20PJAN-21/, "the description must be url-encoded onto the card");

      const reused = runOp({
        adapter,
        args: ["create_issue", "--if-absent", "Record the gap"],
        responses: [cards, lists, created, card("card-existing")],
        env,
      });
      assert.equal(reused.status, 0, `${copy} trello.sh --if-absent must succeed\nstderr:\n${reused.stderr}`);
      assert.equal(JSON.parse(reused.stdout).issue_id, "card-existing");
      assert.equal(JSON.parse(reused.stdout).created, false);
      assert.equal(
        reused.requests.filter((entry) => entry.method === "POST").length,
        0,
        `${copy} trello.sh --if-absent must not file a duplicate card`,
      );
    }
  }

  // ------------------------------------------------------------------------
  // 8. A missing board binding fails loudly instead of writing somewhere else.
  // ------------------------------------------------------------------------
  for (const copy of Object.keys(COPIES)) {
    const { adapter } = stageAdapter(copy, "plane", { type: "plane", workspace: WORKSPACE });
    const run = runOp({ adapter, args: ["create_issue", "Nowhere to file"], env: PLANE_ENV });
    assert.notEqual(run.status, 0, `${copy} plane.sh must refuse create_issue with no board bound`);
    assert.match(run.stderr, /project not set/, `${copy} plane.sh must name the missing binding`);
    assert.equal(run.requests.length, 0, `${copy} plane.sh must not call the API with no board bound`);
  }

  // ------------------------------------------------------------------------
  // 9. The no-credentials path fails loudly, before any request, for every
  //    provider and every copy — create_issue included.
  // ------------------------------------------------------------------------
  const CREDENTIAL_ERRORS = {
    plane: { binding: PLANE_BINDING, pattern: /PLANE_API_KEY is not set/ },
    trello: { binding: { type: "trello", board_id: "board-abc" }, pattern: /TRELLO_KEY and TRELLO_TOKEN must be set/ },
    linear: { binding: { type: "linear", team: "DEL" }, pattern: /LINEAR_API_KEY is not set/ },
  };
  for (const copy of Object.keys(COPIES)) {
    for (const provider of PROVIDERS) {
      const { binding, pattern } = CREDENTIAL_ERRORS[provider];
      const { adapter } = stageAdapter(copy, provider, binding);
      const run = runOp({ adapter, args: ["create_issue", "No credentials"] });
      assert.notEqual(run.status, 0, `${copy} ${provider}.sh create_issue must fail without credentials`);
      assert.match(run.stderr, pattern, `${copy} ${provider}.sh must name the missing credential`);
      assert.equal(run.requests.length, 0, `${copy} ${provider}.sh must not call out without credentials`);
    }
  }

  // ------------------------------------------------------------------------
  // 10. Unknown ops still error — adding create_issue must not widen dispatch.
  // ------------------------------------------------------------------------
  const CREDENTIALS = {
    plane: PLANE_ENV,
    trello: { TRELLO_KEY: "k", TRELLO_TOKEN: "t" },
    linear: { LINEAR_API_KEY: "l" },
  };
  for (const copy of Object.keys(COPIES)) {
    for (const provider of PROVIDERS) {
      const { binding } = CREDENTIAL_ERRORS[provider];
      const { adapter } = stageAdapter(copy, provider, binding);
      for (const op of ["create-issue", "create_ticket", "createissue", ""]) {
        const run = runOp({ adapter, args: [op], env: CREDENTIALS[provider] });
        assert.notEqual(run.status, 0, `${copy} ${provider}.sh must reject op '${op}'`);
        assert.match(run.stderr, /unknown op:/, `${copy} ${provider}.sh must report an unknown op`);
        assert.equal(run.requests.length, 0, `${copy} ${provider}.sh must not call out for an unknown op`);
      }
      // A bare invocation must never be read as an op either. (The `tp`
      // dispatcher rejects it up front with "tp: missing operation"; the
      // adapter's own `shift` guard makes it a silent non-zero exit.)
      const bare = runOp({ adapter, args: [], env: CREDENTIALS[provider] });
      assert.notEqual(bare.status, 0, `${copy} ${provider}.sh must reject a bare invocation`);
      assert.equal(bare.stdout, "", `${copy} ${provider}.sh must print nothing for a bare invocation`);
    }
  }

  console.log("PJAN-23 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
