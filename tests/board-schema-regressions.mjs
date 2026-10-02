// board.schema: the parity rule that asks Pilot (`px`) what it would change on
// a project's linked Plane board, and lets it change it (src/parity/rules.ts).
//
// Until PJAN-164 nothing tested this rule's px half on purpose. pjan-65 and
// pjan-71 audit pjangler's own checkout, so on the operator's host they ran the
// real px against the live PJAN board, and the rule's coverage came from that.
// A clean CI runner has no px, so the rule skipped and the whole branch went
// dark. This suite drives it the same way on every machine: the real CLI
// (dist/index.js), a fixture repo, and a recording fake px on PATH. No test here
// can reach Plane or the operator's px.
//
// What it holds, beyond the reporting:
//   1. Every "cannot tell" path is a skip, never a warn. init runs this rule as
//      a postcondition, and a warn there rolls a new project back.
//   2. An unlinked binding never runs px at all.
//   3. migrate never passes --prune (deletes) or --adopt-default (re-homes new
//      tickets), and --dry-run never runs px for a write.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
assert.ok(existsSync(cli), "dist/index.js is missing; run `npm run build` first");

const work = mkdtempSync(join(tmpdir(), "board-schema-"));
after(() => rmSync(work, { recursive: true, force: true }));
// Every fixture is its own repo; nothing may walk up into an enclosing one.
process.env.GIT_CEILING_DIRECTORIES = work;

const BOARD = "board-fixture-1";
const WORKSPACE = "fixture-ws";
const DRY_RUN_ARGS = ["schema", "import", "--dry-run", "--json", "--board", BOARD, "--workspace", WORKSPACE];
const APPLY_ARGS = ["schema", "import", "--json", "--board", BOARD, "--workspace", WORKSPACE];

const DIFFERING_PLAN = {
  ok: true,
  board_has_work: true,
  schema_file: "/fixture/33god-standard.json",
  project: { changed: ["module_view"] },
  states: {
    created: ["Ready"],
    updated: [{ name: "Done" }, {}],
    suppressed: [{ name: "Backlog", field: "default", from: false, to: true }],
  },
  labels: { created: ["spike", "blocked"], unchanged: ["bug"] },
};
const DIFFERING_DETAILS = [
  "states: create Ready",
  "states: update Done",
  "labels: create spike, blocked",
  "project features: module_view",
];
const MATCHING_PLAN = { ok: true, states: { unchanged: ["Todo"] }, labels: {}, project: { changed: [] } };

/** A bin dir holding only a px that records each call and answers from a script of replies. */
function fakePx(name) {
  const bin = join(work, name, "bin");
  mkdirSync(bin, { recursive: true });
  const px = join(bin, "px");
  writeFileSync(px, `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PX_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const replies = JSON.parse(fs.readFileSync(process.env.PX_REPLIES, "utf8"));
const applied = fs.existsSync(process.env.PX_LOG + ".applied");
const kind = !argv.includes("--dry-run") ? "apply" : applied ? "planAfterApply" : "plan";
if (kind === "apply") fs.writeFileSync(process.env.PX_LOG + ".applied", "");
const reply = replies[kind] ?? { status: 97, stdout: "" };
process.stdout.write(typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout));
process.exit(reply.status ?? 0);
`);
  chmodSync(px, 0o755);
  return bin;
}

function repoWith(name, ticketProvider) {
  const repo = join(work, name, "repo");
  mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status, 0);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ project_id: name, name, ticket_provider: ticketProvider }, null, 2)}\n`);
  return repo;
}

const linked = { type: "plane", workspace: WORKSPACE, board_id: BOARD, state: "linked" };

/**
 * Run the real CLI against `repo` with exactly `bin` ahead of the system dirs,
 * so the only px it can find is ours (or none). HOME is a fixture too.
 */
function pj(name, bin, args, replies = {}) {
  const dir = join(work, name);
  const log = join(dir, "px.log");
  const repliesFile = join(dir, "px-replies.json");
  writeFileSync(repliesFile, JSON.stringify(replies));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    PATH: [bin, "/usr/bin", "/bin"].join(":"),
    HOME: home,
    PX_LOG: log,
    PX_REPLIES: repliesFile,
  };
  const result = spawnSync(process.execPath, [cli, ...args, "--json", "--registry", join(dir, "registry.yaml")], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    assert.fail(`pj ${args.join(" ")} printed no JSON (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { body, calls, result };
}

function audit(name, bin, replies) {
  const repo = join(work, name, "repo");
  const { body, calls } = pj(name, bin, ["audit", repo, "--rules", "board.schema"], replies);
  assert.equal(body.rules.length, 1, JSON.stringify(body));
  return { finding: body.rules[0], calls, repo };
}

test("audit asks px for a dry-run plan of the bound board and reports every difference as fixable", () => {
  const repo = repoWith("differs", linked);
  const { finding, calls } = audit("differs", fakePx("differs"), { plan: { stdout: DIFFERING_PLAN } });
  assert.deepEqual(calls, [{ argv: DRY_RUN_ARGS, cwd: repo }], "one read-only call, from the repo, for the bound board");
  assert.equal(finding.status, "warn");
  assert.equal(finding.fixable, true);
  assert.equal(finding.summary, "4 board schema difference(s)");
  assert.deepEqual(finding.details, [
    ...DIFFERING_DETAILS,
    "held back (board has work; would re-home new tickets): Backlog.default: false -> true",
    "schema: /fixture/33god-standard.json",
  ]);
});

test("a board that already matches is a pass, and the workspace defaults to 33god", () => {
  const repo = repoWith("matches", { type: "plane", board_id: BOARD, state: "linked" });
  const { finding, calls } = audit("matches", fakePx("matches"), { plan: { stdout: MATCHING_PLAN } });
  assert.deepEqual(calls.map((call) => call.argv), [[...DRY_RUN_ARGS.slice(0, -1), "33god"]]);
  assert.equal(calls[0].cwd, repo);
  assert.equal(finding.status, "pass", JSON.stringify(finding));
  assert.equal(finding.summary, "board matches the standard schema");
  assert.equal(finding.fixable, false);
});

test("whatever px cannot answer is a skip, never a warn", () => {
  const cases = [
    ["missing", null, /could not read board schema: px not found on PATH/],
    ["silent", { plan: { status: 3, stdout: "" } }, /could not read board schema: px produced no output \(exit 3\)/],
    ["garbled", { plan: { status: 0, stdout: "Error: not json" } }, /could not read board schema: px returned unparseable output \(exit 0\)/],
    ["refused", { plan: { status: 1, stdout: { ok: false, error: "board is archived" } } }, /px could not plan a schema apply: board is archived/],
  ];
  for (const [name, replies, summary] of cases) {
    repoWith(name, linked);
    const bin = replies ? fakePx(name) : join(work, name, "empty-bin");
    mkdirSync(bin, { recursive: true });
    if (!replies) {
      const probe = spawnSync("which", ["px"], { env: { PATH: [bin, "/usr/bin", "/bin"].join(":") }, encoding: "utf8" });
      assert.notEqual(probe.status, 0, `a px outside the fixture is on this machine's system PATH: ${probe.stdout}`);
    }
    const { finding } = audit(name, bin, replies ?? {});
    assert.equal(finding.status, "skip", `${name}: ${JSON.stringify(finding)}`);
    assert.equal(finding.fixable, false, name);
    assert.match(finding.summary, summary, name);
  }
});

test("a binding that is not a linked Plane board never runs px", () => {
  const cases = [
    ["planned", { ...linked, state: "planned" }, /board binding is "planned", not linked/],
    ["unbuilt", { type: "plane", workspace: WORKSPACE, state: "linked" }, /board is not created yet \(no board_id\)/],
    ["trello", { type: "trello", board_id: BOARD, state: "linked" }, /ticket provider is trello; board schema is Plane-only/],
  ];
  for (const [name, provider, summary] of cases) {
    repoWith(name, provider);
    const { finding, calls } = audit(name, fakePx(name), { plan: { stdout: DIFFERING_PLAN } });
    assert.equal(finding.status, "skip", name);
    assert.match(finding.summary, summary, name);
    assert.deepEqual(calls, [], `${name}: px must not run`);
  }
});

test("migrate --dry-run runs px only to read; migrate applies without --prune or --adopt-default", () => {
  const repo = repoWith("migrate", linked);
  const bin = fakePx("migrate");
  const replies = {
    plan: { stdout: DIFFERING_PLAN },
    apply: { stdout: DIFFERING_PLAN },
    planAfterApply: { stdout: MATCHING_PLAN },
  };

  const dry = pj("migrate", bin, ["migrate", "board.schema", repo, "--dry-run"], replies);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.results[0].status, "applied", JSON.stringify(dry.body));
  assert.equal(dry.body.results[0].summary, "would apply the standard board schema");
  assert.ok(dry.calls.length > 0 && dry.calls.every((call) => call.argv.includes("--dry-run")), JSON.stringify(dry.calls));

  rmSync(join(work, "migrate", "px.log"));
  const applied = pj("migrate", bin, ["migrate", "board.schema", repo], replies);
  const writes = applied.calls.filter((call) => !call.argv.includes("--dry-run"));
  assert.deepEqual(writes, [{ argv: APPLY_ARGS, cwd: repo }], "exactly one apply, never --prune or --adopt-default");
  const [result] = applied.body.results;
  assert.equal(result.status, "applied", JSON.stringify(applied.body));
  assert.equal(result.summary, "applied 4 board schema change(s)");
  assert.deepEqual(result.details, [...DIFFERING_DETAILS, "left alone (board has work): Backlog.default: false -> true"]);
  assert.deepEqual(result.changedFiles, [], "a board write changes no file in the repo");
  assert.equal(applied.body.ok, true);
});

test("an apply px refuses is partial with each failure, or blocked, never applied", () => {
  const cases = [
    ["partial", { ok: false, error: "2 of 3 operations failed", failed: [{ name: "Ready", action: "create", error: "409" }, { name: "Done", action: "update", error: "500" }] },
      "partial", "2 of 3 operations failed", ["create Ready: 409", "update Done: 500"]],
    ["blocked", { ok: false }, "blocked", "px could not apply the schema", []],
  ];
  for (const [name, applyReply, status, summary, details] of cases) {
    const repo = repoWith(name, linked);
    const { body } = pj(name, fakePx(name), ["migrate", "board.schema", repo], {
      plan: { stdout: DIFFERING_PLAN },
      apply: { status: 1, stdout: applyReply },
      planAfterApply: { stdout: DIFFERING_PLAN },
    });
    const [result] = body.results;
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.summary, summary, name);
    assert.deepEqual(result.details.slice(0, details.length), details, name);
    assert.equal(body.ok, false, `${name}: a refused apply must not report ok`);
  }

  // No px at all: migrate is blocked and names why.
  const repo = repoWith("no-px", linked);
  const bin = join(work, "no-px", "empty-bin");
  mkdirSync(bin, { recursive: true });
  const { body } = pj("no-px", bin, ["migrate", "board.schema", repo]);
  assert.equal(body.results[0].status, "blocked", JSON.stringify(body));
  assert.match(body.results[0].summary, /px not found on PATH/);
});
