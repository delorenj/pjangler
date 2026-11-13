import "./helpers/hermetic-suite.mjs";
// PJAN-165 R1: convergence and recovery after a LOST import receipt.
//
// `pj import <local checkout>` leaves a private receipt at
// <parent>/.git/pjangler-imports/<name>.json. Before R1 a repeat of a
// successful local import converged ("unchanged") only while that receipt
// survived; with it gone (a scrubbed .git, a parent copied without untracked
// state) the same command died with "Destination collision" although gitlink,
// origin, manifest and registry were all healthy.
//
// Every case here runs the real built CLI (dist/index.js) against disposable
// repositories, bare remotes, a disposable registry database and an isolated
// HOME under the hermetic scratch base (tests/helpers/import-harness.mjs).
// Nothing touches ~/code, ~/code/33GOD or the live registry. Each case builds
// its own enrollment, so a failing case never poisons the next; the run exits
// non-zero if any case failed and prints which ones.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bytes, startHarness, tree } from "./helpers/import-harness.mjs";

const h = await startHarness("pjan-165-import-receipt");
const results = [];

/** Every byte the import could have rewritten: the parent (git, index, receipts, .gitmodules, manifest), HOME bindings, the bare remote and the registry. */
async function state(s, ...extra) {
  return {
    parent: tree(s.parent),
    home: tree(h.home),
    upstream: tree(s.upstream),
    extra: extra.map((dir) => (existsSync(dir) ? tree(dir) : null)),
    rows: await h.rows(),
    index: await h.request("/v1/index"),
  };
}

/** A real local import of a dirty checkout, with executable and in-tree bindings, enrolled in the disposable registry. */
async function enrolled(name) {
  const id = `r1-${name}`;
  const parent = h.repo(`${name}-parent`);
  const source = h.repo(name, { project_id: id, project_name: name, agents: {}, memory: { bank: `bank-${name}` }, ticket_provider: { type: "plane", board_id: `board-${name}`, identifier: "R1", workspace: "33god" }, extensions: { profile_name: `profile-${name}` } });
  const upstream = h.bare(source, `${name}-upstream`);
  h.git(source, "remote", "add", "origin", upstream);
  mkdirSync(join(source, "bin"));
  writeFileSync(join(source, "bin/tool"), `#!/bin/sh\nprintf "${name} tool usable\\n"\n`); chmodSync(join(source, "bin/tool"), 0o755);
  h.git(source, "add", "bin"); h.git(source, "commit", "-qm", "PJAN-165 add executable");
  writeFileSync(join(source, "tracked"), "staged\n"); h.git(source, "add", "tracked"); writeFileSync(join(source, "tracked"), "unstaged\n");
  writeFileSync(join(source, "untracked"), Buffer.from([0, 255, 12, 13]));
  mkdirSync(join(source, "ignored")); writeFileSync(join(source, "ignored/payload"), "ignored payload\n");
  symlinkSync(join(source, "bin/tool"), join(source, "abs-link"));
  const binding = join(h.home, ".local/bin", `tool-${name}`);
  symlinkSync(join(source, "bin/tool"), binding);
  await h.request("/v1/index", { manifest_path: join(source, ".project.json") });
  const first = h.cli(parent, source);
  assert.equal(first.status, 0, JSON.stringify(first.data));
  assert.equal(first.data.status, "imported");
  const target = join(parent, name);
  return { name, id, parent, source, upstream, target, binding, receipt: join(parent, ".git/pjangler-imports", `${name}.json`), recordKey: `pjangler-import.${name}.source` };
}

/** "Lose only the receipt": the file, or the whole journal directory. */
function loseReceipt(s, how = "dir") {
  if (how === "file") unlinkSync(s.receipt);
  else rmSync(dirname(s.receipt), { recursive: true });
  assert.equal(existsSync(s.receipt), false);
}
/** Make provenance unprovable: no receipt and no durable record (an enrollment made before R1, or by hand). */
function loseProvenance(s) {
  loseReceipt(s);
  h.gitTry(s.parent, "config", "--local", "--unset-all", s.recordKey);
  assert.notEqual(h.gitTry(s.parent, "config", "--local", "--get-all", s.recordKey).status, 0, "record must be gone");
}
const record = (s) => h.gitTry(s.parent, "config", "--local", "--get-all", s.recordKey);

/** A repeat that must be refused: exit 1, status "refused", the error text, and nothing at all rewritten. */
async function assertBlocked(s, input, pattern, ...extra) {
  const before = await state(s, ...extra);
  const run = h.cli(s.parent, input);
  assert.equal(run.status, 1, JSON.stringify(run.data));
  assert.equal(run.data.ok, false);
  assert.equal(run.data.status, "refused", JSON.stringify(run.data));
  assert.match(run.data.error, pattern, run.data.error);
  assert.deepEqual(await state(s, ...extra), before, "a refused repeat must not rewrite git, index, manifest, registry, bindings or receipts");
  return run.data;
}
async function assertConverges(s, ...args) {
  const before = await state(s);
  const run = h.cli(s.parent, s.source, ...args);
  assert.equal(run.status, 0, JSON.stringify(run.data));
  assert.equal(run.data.status, "unchanged", JSON.stringify(run.data));
  assert.deepEqual(run.data.plan.changes, []);
  assert.deepEqual(await state(s), before, "a converged repeat must not rewrite git, index, manifest, registry, bindings or receipts");
  return run.data;
}
function assertHealthy(s) {
  assert.equal(h.git(s.parent, "ls-files", "--stage", "--", s.name), `160000 ${h.git(s.target, "rev-parse", "HEAD")} 0\t${s.name}`);
  assert.equal(readlinkSync(s.binding), join(s.target, "bin/tool"));
  assert.equal(h.run(s.binding, [], s.parent).stdout.trim(), `${s.name} tool usable`);
  assert.equal(readlinkSync(join(s.target, "abs-link")), join(s.target, "bin/tool"));
  assert.equal(JSON.parse(readFileSync(join(s.target, ".project.json"))).repo_path, s.target);
}

async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name}\n${error?.stack ?? error}`); }
}

try {
  await test("R1 receipt loss: the same local import from the former source converges to unchanged", async () => {
    for (const how of ["dir", "file"]) {
      const s = await enrolled(`loss-${how}`);
      const manifestBefore = bytes(join(s.target, ".project.json"));
      loseReceipt(s, how);
      const data = await assertConverges(s);
      assert.equal(data.plan.projectId, s.id);
      assert.equal(existsSync(s.receipt), false, "a converged repeat writes no receipt");
      assert.equal(bytes(join(s.target, ".project.json")), manifestBefore);
      assertHealthy(s);
      const manifest = JSON.parse(readFileSync(join(s.target, ".project.json")));
      assert.equal(manifest.project_id, s.id); assert.equal(manifest.memory.bank, `bank-${s.name}`); assert.equal(manifest.ticket_provider.board_id, `board-${s.name}`);
    }
  });

  await test("R1 receipt loss: --dry-run also reports unchanged and writes nothing", async () => {
    const s = await enrolled("loss-dry");
    loseReceipt(s);
    await assertConverges(s, "--dry-run");
  });

  await test("R1 receipt present: the repeat still converges (no regression to the original rerun path)", async () => {
    const s = await enrolled("receipt-kept");
    await assertConverges(s);
  });

  await test("R1 provenance is recorded durably by the transaction and rolled back with it", async () => {
    const s = await enrolled("record");
    const recorded = record(s);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.stdout.trim(), s.source);
    // An induced registry failure rolls the whole import back; the record must go with it.
    const parent = h.repo("record-fail-parent");
    const source = h.repo("record-fail", { project_id: "r1-record-fail", agents: {} });
    h.git(source, "remote", "add", "origin", h.bare(source, "record-fail-upstream"));
    const configBefore = bytes(join(parent, ".git/config"));
    await h.db.query(`CREATE OR REPLACE FUNCTION pjangler_index.reject_import_r1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'induced import enrollment failure'; END $$;
      CREATE TRIGGER reject_import_r1 BEFORE INSERT ON pjangler_index.projects FOR EACH ROW EXECUTE FUNCTION pjangler_index.reject_import_r1()`);
    let failure;
    try { failure = h.cli(parent, source); }
    finally { await h.db.query("DROP TRIGGER reject_import_r1 ON pjangler_index.projects"); }
    assert.equal(failure.status, 1); assert.equal(failure.data.status, "rolled_back", JSON.stringify(failure.data));
    assert.equal(h.gitTry(parent, "config", "--local", "--get-all", "pjangler-import.record-fail.source").status, 1, "rolled-back import leaves no provenance record");
    assert.equal(bytes(join(parent, ".git/config")), configBefore, "rollback restores .git/config byte for byte");
    // After the rollback the source is back, so a retry imports for real and records again.
    const retry = h.cli(parent, source);
    assert.equal(retry.status, 0, JSON.stringify(retry.data)); assert.equal(retry.data.status, "imported");
    assert.equal(h.git(parent, "config", "--local", "--get-all", "pjangler-import.record-fail.source"), source);
  });

  await test("R1 unrelated same-basename source that EXISTS is a collision, with or without the receipt", async () => {
    for (const keepReceipt of [true, false]) {
      const s = await enrolled(`twin-${keepReceipt ? "kept" : "lost"}`);
      if (!keepReceipt) loseReceipt(s);
      const elsewhere = join(h.temp, `${s.name}-elsewhere`);
      const other = h.repo(s.name, { project_id: `r1-${s.name}-other`, agents: {} }, elsewhere);
      h.git(other, "remote", "add", "origin", h.bare(other, `${s.name}-other-upstream`));
      const data = await assertBlocked(s, other, /Destination collision/, elsewhere);
      assert.ok(data.recovery.instructions.some((line) => line.includes("--name")), JSON.stringify(data.recovery));
      assert.equal(existsSync(other), true, "the unrelated checkout is left where it was");
      assertHealthy(s);
    }
  });

  await test("R1 a DIFFERENT checkout recreated at the very same former path is a collision, never unchanged", async () => {
    for (const keepReceipt of [true, false]) {
      const s = await enrolled(`recreated-${keepReceipt ? "kept" : "lost"}`);
      if (!keepReceipt) loseReceipt(s);
      const impostor = h.repo(s.name, { project_id: `r1-${s.name}-impostor`, agents: {} }, dirname(s.source));
      assert.equal(impostor, s.source);
      h.git(impostor, "remote", "add", "origin", h.bare(impostor, `${s.name}-impostor-upstream`));
      const data = await assertBlocked(s, s.source, /Destination collision/, s.source);
      assert.ok(data.recovery.instructions.some((line) => line.includes("--name")), JSON.stringify(data.recovery));
      assertHealthy(s);
    }
  });

  await test("R1 unrelated same-basename source that is ABSENT is refused, never reported unchanged", async () => {
    for (const keepReceipt of [true, false]) {
      const s = await enrolled(`ghost-${keepReceipt ? "kept" : "lost"}`);
      if (!keepReceipt) loseReceipt(s);
      const ghost = join(h.temp, "nowhere", s.name);
      const data = await assertBlocked(s, ghost, /Destination collision/);
      assert.match(data.error, new RegExp(`imported from ${s.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, not ${ghost}`), data.error);
      assertHealthy(s);
    }
  });

  await test("R1 no provenance at all: fail closed, print the safe recovery action, and the recovered enrollment converges", async () => {
    const s = await enrolled("noprov");
    loseProvenance(s);
    const data = await assertBlocked(s, s.source, /Destination collision.*nothing proves/s);
    const action = `git -C ${s.parent} config --local ${s.recordKey} ${s.source}`;
    assert.ok(data.recovery.instructions.includes(action), JSON.stringify(data.recovery.instructions));
    assert.equal(data.recovery.checkout, s.target);
    assert.ok(data.recovery.instructions.some((line) => /healthy|verified/i.test(line)), "the instructions say the enrollment itself verified");
    assert.equal(data.recovery.receipt, undefined, "there is no receipt to point at");
    // Run the printed action exactly as printed; identity checks still run on the repeat.
    const applied = h.run("sh", ["-c", action], s.parent);
    assert.equal(applied.status, 0, applied.stderr);
    await assertConverges(s);
    assertHealthy(s);
  });

  await test("R1 no provenance and an unhealthy enrollment: no recovery shortcut is offered", async () => {
    const s = await enrolled("noprov-drift");
    loseProvenance(s);
    h.git(s.target, "remote", "set-url", "origin", "file:///nowhere/drifted.git");
    const data = await assertBlocked(s, s.source, /Destination collision/);
    assert.ok(!data.recovery.instructions.some((line) => line.includes(s.recordKey)), "no record command for an enrollment that does not verify");
    assert.ok(data.recovery.instructions.some((line) => /drift/i.test(line)), JSON.stringify(data.recovery.instructions));
  });

  await test("R1 ambiguous provenance (two recorded sources) is not proof", async () => {
    const s = await enrolled("ambiguous");
    loseReceipt(s);
    h.git(s.parent, "config", "--local", "--add", s.recordKey, join(h.temp, "another", s.name));
    await assertBlocked(s, s.source, /Destination collision/);
  });

  await test("R1 a rolled_back receipt proves nothing about a destination that exists", async () => {
    const s = await enrolled("rolled");
    const receipt = JSON.parse(readFileSync(s.receipt, "utf8"));
    writeFileSync(s.receipt, `${JSON.stringify({ ...receipt, status: "rolled_back" }, null, 2)}\n`);
    h.gitTry(s.parent, "config", "--local", "--unset-all", s.recordKey);
    await assertBlocked(s, s.source, /Destination collision/);
  });

  await test("R1 mismatched origin fails with drift, receipt lost or kept", async () => {
    for (const keepReceipt of [false, true]) {
      const s = await enrolled(`origin-${keepReceipt ? "kept" : "lost"}`);
      if (!keepReceipt) loseReceipt(s);
      h.git(s.target, "remote", "set-url", "origin", "file:///nowhere/other.git");
      await assertBlocked(s, s.source, /Existing enrollment drift/);
    }
  });

  await test("R1 mismatched gitlink fails with drift, receipt lost or kept", async () => {
    for (const keepReceipt of [false, true]) {
      const s = await enrolled(`gitlink-${keepReceipt ? "kept" : "lost"}`);
      if (!keepReceipt) loseReceipt(s);
      h.git(s.target, "commit", "-q", "--allow-empty", "-m", "advance past the staged gitlink");
      await assertBlocked(s, s.source, /Existing enrollment drift/);
    }
  });

  await test("R1 mismatched registry identity (row removed, or re-pointed at another checkout) fails closed", async () => {
    const removed = await enrolled("registry-removed");
    loseReceipt(removed);
    await h.request("/v1/remove", { project_id: removed.id });
    await assertBlocked(removed, removed.source, /stale registry binding/);

    const squatted = await enrolled("registry-squatted");
    loseReceipt(squatted);
    const squatter = h.repo("squatter", { project_id: squatted.id, agents: {} }, join(h.temp, `${squatted.name}-squat`));
    await h.db.query("UPDATE pjangler_index.projects SET manifest_path = $1 WHERE project_id = $2", [join(squatter, ".project.json"), squatted.id]);
    await assertBlocked(squatted, squatted.source, /stale registry binding/, squatter);

    const edited = await enrolled("registry-edited");
    loseReceipt(edited);
    const path = join(edited.target, ".project.json");
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path)), extensions: { edited_after_indexing: true } }, null, 2)}\n`);
    await assertBlocked(edited, edited.source, /stale registry binding/);
  });

  await test("R1 a manifest whose repo_path is not the canonical target fails closed even when reindexed", async () => {
    const s = await enrolled("repo-path");
    loseReceipt(s);
    const path = join(s.target, ".project.json");
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path)), repo_path: join(h.temp, "elsewhere") }, null, 2)}\n`);
    await h.request("/v1/index", { manifest_path: path });
    await assertBlocked(s, s.source, /repo_path/);
  });

  await test("R1 surviving unfinished receipts stay blocked even though the record and every check would pass", async () => {
    const s = await enrolled("unfinished");
    const original = readFileSync(s.receipt);
    for (const status of ["preparing", "moving", "enrolling", "recovery_required"]) {
      writeFileSync(s.receipt, `${JSON.stringify({ ...JSON.parse(original), status }, null, 2)}\n`);
      await assertBlocked(s, s.source, /Unfinished import receipt/);
      assert.equal(record(s).stdout.trim(), s.source, "the durable record is present, and still does not override the receipt");
    }
    writeFileSync(s.receipt, original);
    await assertConverges(s);
  });

  await test("R1 a binding still pointing into the former source is drift, not health", async () => {
    const link = await enrolled("stale-link");
    loseReceipt(link);
    symlinkSync(join(link.source, "bin/tool"), join(h.home, ".local/bin", "late-stale-link"));
    await assertBlocked(link, link.source, /still points? (?:at|into) the former source/);

    const inTree = await enrolled("stale-tree");
    loseReceipt(inTree);
    unlinkSync(join(inTree.target, "abs-link"));
    symlinkSync(join(inTree.source, "bin/tool"), join(inTree.target, "abs-link"));
    await assertBlocked(inTree, inTree.source, /still points? (?:at|into) the former source/);
  });

  await test("R1 remote import converges without any receipt (URL identity)", async () => {
    const seed = h.repo("remote-seed", { project_id: "r1-remote", agents: {} });
    const upstream = h.bare(seed, "remote-upstream");
    const parent = h.repo("remote-parent");
    const first = h.cli(parent, upstream, "--name", "remote");
    assert.equal(first.status, 0, JSON.stringify(first.data));
    rmSync(join(parent, ".git/pjangler-imports"), { recursive: true });
    const s = { parent, upstream, name: "remote" };
    const before = await state(s);
    const again = h.cli(parent, upstream, "--name", "remote");
    assert.equal(again.status, 0, JSON.stringify(again.data)); assert.equal(again.data.status, "unchanged");
    assert.deepEqual(await state(s), before);
  });
} finally {
  await h.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} receipt-recovery cases passed`);
if (failed.length) { console.error(`FAILED: ${failed.map((r) => r.name).join("; ")}`); process.exitCode = 1; }
