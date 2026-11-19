import "./helpers/hermetic-suite.mjs";
// PJAN-103: exercise the canonical Krebs adapter, not the retired role-local copy.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { findTpAdapters, tpAdaptersFailure } from "./helpers/tp-adapters.mjs";

const root = resolve(import.meta.dirname, "..");
const { found, candidates } = findTpAdapters({ startDir: root });
assert.ok(found, tpAdaptersFailure(candidates));
const scratch = mkdtempSync(join(tmpdir(), "pjan-103-"));
const workspace = "fixture-ws";
const board = "fixture-board";
const issueId = "fixture-issue";
const states = [
  { id: "backlog", name: "Backlog", group: "backlog" },
  { id: "ready", name: "Ready for Implementation", group: "unstarted" },
  { id: "todo", name: "Todo", group: "unstarted" },
  { id: "started", name: "In Progress", group: "started" },
  { id: "done", name: "Done", group: "completed" },
  { id: "cancelled", name: "Cancelled", group: "cancelled" },
];
const base = `https://plane.invalid/api/v1/workspaces/${workspace}/projects/${board}`;
const fakeCurl = `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
method="GET"; url=""; body=""; outfile=""; headers=""; writeout=""
i=0
while i<len(args):
    arg=args[i]
    if arg in ("-X", "-d", "-o", "-D", "-w", "-H"):
        value=args[i+1]
        if arg=="-X": method=value
        elif arg=="-d": body=value
        elif arg=="-o": outfile=value
        elif arg=="-D": headers=value
        elif arg=="-w": writeout=value
        i+=2
    elif arg.startswith("-"): i+=1
    else: url=arg; i+=1
with open(os.environ["PJAN103_LOG"],"a") as fh:
    fh.write(json.dumps({"method":method,"url":url,"body":body})+"\\n")
if method=="GET" and url.endswith("/states/"):
    payload=json.dumps(json.load(open(os.environ["PJAN103_STATES"])))
elif method=="GET" and url.endswith("/issues/fixture-issue/"):
    payload=json.dumps({"id":"fixture-issue","sequence_id":103,"state":os.environ["PJAN103_READBACK"],"labels":[]})
elif method=="PATCH" and url.endswith("/issues/fixture-issue/"):
    payload=json.dumps({"id":"fixture-issue"})
else:
    sys.stderr.write("unexpected request: "+method+" "+url+"\\n"); sys.exit(22)
if outfile: open(outfile,"w").write(payload)
else: sys.stdout.write(payload)
if headers: open(headers,"w").write("HTTP/1.1 200 OK\\r\\n")
if writeout: sys.stdout.write(writeout.replace("%{http_code}","200"))
`;
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "curl"), fakeCurl, { mode: 0o755 });
const stateFile = join(scratch, "states.json");
writeFileSync(stateFile, JSON.stringify({ results: states }));
let checks = 0;
function run({ map, role = "", catalog = states, readback = "todo", op = "transition", target = "unstarted" } = {}) {
  const dir = mkdtempSync(join(scratch, "case-"));
  const adapter = join(dir, ".tp", "adapters", "plane.sh");
  mkdirSync(dirname(adapter), { recursive: true });
  writeFileSync(adapter, readFileSync(join(found, "plane.sh")), { mode: 0o755 });
  chmodSync(adapter, 0o755);
  const tp = { type: "plane", workspace, board_id: board };
  if (map !== undefined) tp.state_map = map;
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ ticket_provider: tp }));
  if (role) writeFileSync(join(dir, "role.yaml"), `ticket_provider:\n  unstarted: "${role}"   # rendered role override\n`);
  const log = join(dir, "requests.jsonl");
  const catalogFile = join(dir, "states.json");
  writeFileSync(catalogFile, JSON.stringify({ results: catalog }));
  const result = spawnSync("sh", [adapter, op, ...(op === "transition" ? [issueId, target] : [target])], {
    encoding: "utf8", cwd: dir,
    env: hermeticEnv({ HOME: dir, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir,
      PLANE_BASE: "https://plane.invalid", PLANE_API_KEY: "fixture-key",
      HERMES_FLEET_ENV: join(dir, "nonexistent"), PJAN103_LOG: log,
      PJAN103_STATES: catalogFile, PJAN103_READBACK: readback }),
  });
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, requests };
}
function check(label, fn) { fn(); checks++; console.log(`ok ${checks} - ${label}`); }
try {
  check("stock board chooses Todo from two unstarted states, one PATCH and same-issue read-back", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok 103/);
    assert.deepEqual(r.requests.map(x => x.method), ["GET", "PATCH", "GET"]);
    assert.equal(r.requests[0].url, `${base}/states/`);
    assert.equal(r.requests[1].url, `${base}/issues/${issueId}/`);
    assert.deepEqual(JSON.parse(r.requests[1].body), { state: "todo" });
    assert.equal(r.requests[2].url, `${base}/issues/${issueId}/`);
  });
  check("project override beats conflicting legacy role and Todo default", () => {
    const r = run({ map: { unstarted: "Ready for Implementation" }, role: "Todo", readback: "ready" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.requests.find(x => x.method === "PATCH").body).state, "ready");
  });
  check("legacy role beats default when project override absent; inline comment is not part of name", () => {
    const r = run({ role: "Ready for Implementation", readback: "ready" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.requests.find(x => x.method === "PATCH").body).state, "ready");
  });
  for (const [label, map, catalog] of [
    ["absent", { unstarted: "Missing" }, states],
    ["duplicate", { unstarted: "Todo" }, [...states, { id: "other", name: "todo", group: "unstarted" }]],
    ["wrong-group", { unstarted: "Done" }, states],
  ]) {
    check(`${label} configured target refuses before mutation`, () => {
      const r = run({ map, catalog });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /exact Plane state.*not resolved uniquely.*unstarted/);
      assert.deepEqual(r.requests.map(x => x.method), ["GET"]);
    });
  }
  check("wrong-group names do not fall through when the same name exists elsewhere", () => {
    const r = run({ map: { unstarted: "Done" }, op: "resolve_state" });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.requests.map(x => x.method), ["GET"]);
  });
  check("malformed project map refuses before any request", () => {
    const r = run({ map: { unstarted: 42 } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid .project.json ticket_provider.state_map.*unstarted must be a string/);
    assert.deepEqual(r.requests, []);
  });
  check("a different read-back state cannot certify the single PATCH", () => {
    const r = run({ readback: "ready" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /concurrent divergence suspected/);
    assert.deepEqual(r.requests.map(x => x.method), ["GET", "PATCH", "GET"]);
  });
  check("five standard lanes resolve without role overrides", () => {
    for (const [lane, state] of [["backlog", "Backlog"], ["unstarted", "Todo"], ["started", "In Progress"], ["completed", "Done"], ["cancelled", "Cancelled"]]) {
      const r = run({ op: "resolve_state", target: lane });
      assert.equal(r.status, 0, `${lane}: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).state, state);
      assert.deepEqual(r.requests.map(x => x.method), ["GET"]);
    }
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`PJAN-103: ${checks} hermetic checks passed`);
