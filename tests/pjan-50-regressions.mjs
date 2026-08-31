// PJAN-50 — cancellation must remain distinct from completion, and Plane issue
// hydration must expose comments and attachments across API response variants.
//
// Fully hermetic: every adapter call uses a staged role tree and a recording
// curl stub. No request can reach a live Plane board.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  materializeCommittedSubmodule,
  readGitCommitFile,
} from "./helpers/committed-submodule.mjs";

const root = resolve(import.meta.dirname, "..");
const cleanup = [];
const BOARD = "board-pjan-50";
const WORKSPACE = "fixture-workspace";
const ISSUE = "issue-pjan-50";
const KEY = "fixture-plane-key";
const BASE = `https://plane.delo.sh/api/v1/workspaces/${WORKSPACE}`;

function tempDir(label) {
  const path = mkdtempSync(join(tmpdir(), `pjan-50-${label}-`));
  cleanup.push(path);
  return path;
}

const committedTemplate = tempDir("committed-template");
const HERMES_GITLINK = materializeCommittedSubmodule(
  root,
  "templates/hermes-agent",
  committedTemplate,
);
const COPIES = {
  "canonical-template": join(committedTemplate, "template", ".scripts"),
  "deployed-pm": join(root, "agents", "hermes", "pm", ".scripts"),
};
const LEGACY_SCRUM_MASTER = join(
  root,
  "agents",
  "hermes",
  "pm",
  ".scripts",
  "scrum-master",
);

function stagePlane(copy) {
  const dir = tempDir(copy);
  const adapter = join(dir, "agents", "hermes", "pm", ".scripts", "providers", "plane.sh");
  mkdirSync(dirname(adapter), { recursive: true });
  writeFileSync(adapter, readFileSync(join(COPIES[copy], "providers", "plane.sh"), "utf8"));
  chmodSync(adapter, 0o755);
  writeFileSync(
    join(dir, ".project.json"),
    `${JSON.stringify({ ticket_provider: { type: "plane", workspace: WORKSPACE, board_id: BOARD } }, null, 2)}\n`,
  );
  return adapter;
}

function makeCurlStub() {
  const bin = tempDir("bin");
  const stub = join(bin, "curl");
  writeFileSync(
    stub,
    `#!/usr/bin/env python3
import json, os, sys

args=sys.argv[1:]
method="GET"; url=""; body=""; headers=[]; outfile=""; headerfile=""; writeout=""
i=0
while i < len(args):
    arg=args[i]
    if arg == "-X": method=args[i+1]; i += 2
    elif arg == "-H": headers.append(args[i+1]); i += 2
    elif arg == "-d": body=args[i+1]; i += 2
    elif arg == "-o": outfile=args[i+1]; i += 2
    elif arg == "-D": headerfile=args[i+1]; i += 2
    elif arg == "-w": writeout=args[i+1]; i += 2
    elif arg.startswith("-"): i += 1
    else: url=arg; i += 1

with open(os.environ["PJAN50_LOG"], "a") as fh:
    fh.write(json.dumps({"method":method,"url":url,"body":body,"headers":headers}) + "\\n")

for row in json.load(open(os.environ["PJAN50_RESPONSES"])):
    if row["method"] == method and row["url"] == url:
        if outfile:
            with open(outfile, "w") as fh: fh.write(row["body"])
        else:
            sys.stdout.write(row["body"])
        if headerfile:
            with open(headerfile, "w") as fh: fh.write("HTTP/1.1 200 OK\\r\\n")
        if writeout:
            sys.stdout.write(writeout.replace("%{http_code}", "200"))
        sys.exit(0)
sys.stderr.write("no fixture for %s %s\\n" % (method,url))
sys.exit(22)
`,
  );
  chmodSync(stub, 0o755);
  return bin;
}

const curlBin = makeCurlStub();

function response(method, path, body) {
  return { method, url: `${BASE}/${path}`, body: JSON.stringify(body) };
}

function runPlane(copy, args, responses) {
  const adapter = stagePlane(copy);
  const log = join(tempDir("log"), "requests.jsonl");
  const fixture = join(tempDir("responses"), "responses.json");
  const home = tempDir("home");
  writeFileSync(fixture, JSON.stringify(responses));
  const result = spawnSync("sh", [adapter, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${curlBin}:/usr/bin:/bin`,
      HOME: home,
      HERMES_FLEET_ENV: join(home, "missing-fleet.env"),
      PLANE_API_KEY: KEY,
      PJAN50_LOG: log,
      PJAN50_RESPONSES: fixture,
    },
  });
  const requests = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...result, requests };
}

function runBoth(args, responses) {
  const runs = Object.keys(COPIES).map((copy) => [copy, runPlane(copy, args, responses)]);
  const [[, canonical], [name, deployed]] = runs;
  assert.equal(deployed.status, canonical.status, `${name} exit status must match the canonical template`);
  assert.equal(deployed.stdout, canonical.stdout, `${name} output must match the canonical template`);
  assert.deepEqual(deployed.requests, canonical.requests, `${name} requests must match the canonical template`);
  return canonical;
}

const states = [
  { id: "state-done", name: "Done", group: "completed" },
  { id: "state-rejected", name: "Rejected", group: "cancelled" },
  { id: "state-cancelled", name: "Cancelled", group: "cancelled" },
];
const issue = {
  id: ISSUE,
  sequence_id: 50,
  name: "Plane hydration",
  description_html: "<p>Inspect <strong>attachments</strong> first.</p>",
  state: "state-cancelled",
};
const comments = [
  { id: "comment-1", comment_html: "<p>List response</p>" },
  { id: "comment-2", comment_html: "<p>Second note</p>" },
];
const attachments = [
  {
    id: "attachment-1",
    attributes: { name: "demo.mov", type: "video/quicktime", size: 12345 },
    asset: "workspace/uuid-demo.mov",
    asset_url: "/api/assets/v2/demo.mov",
    created_at: "2026-08-04T10:00:00Z",
    updated_at: "2026-08-04T10:01:00Z",
    is_uploaded: true,
  },
];

try {
  // The object reader used for the canonical fixture must be immune even to a
  // deliberately dirty source checkout. This guards against quietly reverting
  // to readFileSync(templates/hermes-agent/...) in future test refactors.
  const dirtyTemplate = tempDir("dirty-template-source");
  const cloned = spawnSync(
    "git",
    ["clone", "--quiet", "--no-hardlinks", join(root, "templates", "hermes-agent"), dirtyTemplate],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  const dirtyPlane = join(dirtyTemplate, "template", ".scripts", "providers", "plane.sh");
  writeFileSync(dirtyPlane, "PJAN-50 DIRTY WORKTREE SENTINEL\n");
  assert.match(
    spawnSync("git", ["status", "--short"], { cwd: dirtyTemplate, encoding: "utf8" }).stdout,
    /plane\.sh/,
  );
  const objectPlane = readGitCommitFile(
    dirtyTemplate,
    HERMES_GITLINK,
    "template/.scripts/providers/plane.sh",
  );
  assert.equal(objectPlane, readFileSync(join(COPIES["canonical-template"], "providers", "plane.sh"), "utf8"));
  assert.doesNotMatch(objectPlane, /DIRTY WORKTREE SENTINEL/);

  // The canonical template is the source of truth. The deployed PM contract
  // and provider scripts must be exact refreshes, not hand-merged variants.
  for (const path of [
    "lib/ticket-provider.sh",
    "providers/linear.sh",
    "providers/plane.sh",
    "providers/trello.sh",
    "sentinel/bin/issue-autonomous-review.sh",
    "sentinel/bin/issue-close-gate.sh",
  ]) {
    assert.equal(
      readFileSync(join(COPIES["deployed-pm"], path), "utf8"),
      readFileSync(join(COPIES["canonical-template"], path), "utf8"),
      `${path} must be refreshed byte-for-byte from the canonical template`,
    );
  }

  // The retired scrum-master projection still serves existing installations.
  // Its close gate is generic and therefore byte-identical. Its review script
  // differs only in the four intentional legacy names below; normalizing those
  // names must recover the canonical bytes exactly.
  const canonicalReview = readFileSync(
    join(COPIES["canonical-template"], "sentinel", "bin", "issue-autonomous-review.sh"),
    "utf8",
  );
  const legacyReview = readFileSync(
    join(LEGACY_SCRUM_MASTER, "bin", "issue-autonomous-review.sh"),
    "utf8",
  );
  const normalizedLegacyReview = legacyReview
    .replaceAll(".scripts/scrum-master", ".scripts/sentinel")
    .replaceAll("DRUMJANGLER_AUTO_REVIEW_GRACE_HOURS", "RECONCILE_GRACE_HOURS")
    .replaceAll("SCRUM_MASTER_AUTO_REVIEW", "RECONCILE_AUTO_REVIEW")
    .replaceAll("scrum_master.auto_review", "reconcile.auto_review");
  assert.equal(
    normalizedLegacyReview,
    canonicalReview,
    "legacy autonomous review may differ from canonical only in legacy path/config names",
  );
  assert.equal(
    readFileSync(join(LEGACY_SCRUM_MASTER, "bin", "issue-close-gate.sh"), "utf8"),
    readFileSync(
      join(COPIES["canonical-template"], "sentinel", "bin", "issue-close-gate.sh"),
      "utf8",
    ),
    "legacy close gate must be refreshed byte-for-byte from the canonical template",
  );

  // `cancelled` is a first-class normalized state in the shared contract.
  for (const [copy, scripts] of Object.entries(COPIES)) {
    const lib = readFileSync(join(scripts, "lib", "ticket-provider.sh"), "utf8");
    assert.match(lib, /TP_STATES="[^"]*\bcancelled\b[^"]*"/, `${copy} contract must declare cancelled`);
    const check = spawnSync(
      "bash",
      ["-c", '. "$1"; tp_is_valid_state cancelled', "_", join(scripts, "lib", "ticket-provider.sh")],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(check.status, 0, `${copy} dispatcher must accept cancelled`);
  }
  assert.match(
    readFileSync(join(COPIES["canonical-template"], "providers", "linear.sh"), "utf8"),
    /cancelled\)\s+WANT_TYPE=canceled;/,
    "Linear must map normalized cancelled to its canceled workflow type",
  );
  assert.match(
    readFileSync(join(COPIES["canonical-template"], "providers", "trello.sh"), "utf8"),
    /cancelled\).*Cancelled/,
    "Trello must map normalized cancelled to a concrete list",
  );

  // Plane cancellation selects the concrete state named Cancelled. It must not
  // pick an arbitrary cancelled-group state and must never fall through to Done.
  {
    const responses = [
      response("GET", `projects/${BOARD}/states/`, { results: states }),
      response("PATCH", `projects/${BOARD}/issues/${ISSUE}/`, { sequence_id: 50 }),
      response("GET", `projects/${BOARD}/issues/${ISSUE}/`, issue),
    ];
    const run = runBoth(["transition", ISSUE, "cancelled"], responses);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "ok 50");
    assert.equal(run.requests.length, 3);
    assert.deepEqual(JSON.parse(run.requests[1].body), { state: "state-cancelled" });
    assert.notEqual(JSON.parse(run.requests[1].body).state, "state-done");
  }

  const issueResponses = (commentBody, attachmentBody) => [
    // State collections may also be bare lists; exercise that response shape.
    response("GET", `projects/${BOARD}/states/`, states),
    response("GET", `projects/${BOARD}/issues/${ISSUE}/`, issue),
    response("GET", `projects/${BOARD}/issues/${ISSUE}/comments/`, commentBody),
    response("GET", `projects/${BOARD}/issues/${ISSUE}/issue-attachments/`, attachmentBody),
  ];

  // Plane currently returns bare arrays for some collection endpoints.
  {
    const run = runBoth(["get_issue", ISSUE], issueResponses(comments, attachments));
    assert.equal(run.status, 0, run.stderr);
    const hydrated = JSON.parse(run.stdout);
    assert.equal(hydrated.state, "Cancelled");
    assert.equal(hydrated.state_type, "cancelled");
    assert.deepEqual(hydrated.comments.map(({ id, body }) => ({ id, body })), [
      { id: "comment-1", body: "List response" },
      { id: "comment-2", body: "Second note" },
    ]);
    assert.deepEqual(hydrated.attachments, [
      {
        id: "attachment-1",
        name: "demo.mov",
        type: "video/quicktime",
        size: 12345,
        asset: "workspace/uuid-demo.mov",
        url: "/api/assets/v2/demo.mov",
        created_at: "2026-08-04T10:00:00Z",
        updated_at: "2026-08-04T10:01:00Z",
        is_uploaded: true,
      },
    ]);
    assert.equal(
      run.requests[3].url,
      `${BASE}/projects/${BOARD}/issues/${ISSUE}/issue-attachments/`,
      "get_issue must hydrate Plane attachment metadata",
    );
  }

  // Older/self-hosted Plane versions may paginate both collections.
  {
    const run = runBoth(
      ["get_issue", ISSUE],
      issueResponses({ results: comments, next_page_results: false }, { results: attachments, next_page_results: false }),
    );
    assert.equal(run.status, 0, run.stderr);
    const hydrated = JSON.parse(run.stdout);
    assert.equal(hydrated.comments.length, 2);
    assert.equal(hydrated.attachments.length, 1);
  }

  // Attachment hydration is additive: an unavailable optional endpoint must
  // leave the core issue readable with an explicit empty attachment list.
  {
    const withoutAttachmentFixture = issueResponses({ results: comments }, []).slice(0, 3);
    const run = runBoth(["get_issue", ISSUE], withoutAttachmentFixture);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).attachments, []);
  }

  const roleTemplate = readFileSync(join(committedTemplate, "template", "role.yaml.jinja"), "utf8");
  assert.match(roleTemplate, /^\s+cancelled:\s+""/m, "rendered roles must expose a cancelled state override");
  const providerDocs = readFileSync(join(committedTemplate, "docs", "sentinel", "providers.md"), "utf8");
  assert.match(providerDocs, /`cancelled`/, "provider contract docs must list cancelled");
  assert.match(providerDocs, /attachments/, "provider contract docs must describe attachment hydration");

  console.log("PJAN-50 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
