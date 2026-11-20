import "./helpers/hermetic-suite.mjs";
// A crank binding that ended while its agent lives on (2026-11-19: a slow zellij list-panes read as
// pane_closed) re-attaches as the next generation (`<name>-r2`, …) instead of being refused until
// the agent restarts: Candybar names are never reusable (CAND-54). A live generation is "mine"
// (re-attach is idempotent) and is never superseded by its own lineage.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = hermeticScratch("pjan-crank-reattach");
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(join(workspace, "entry.ts"),
  `export { attachBinding, sameLineage, freshGeneration, bindingName, BINDING_TAG } from ${JSON.stringify(join(root, "src/crank/binding.ts"))};\n`);
const out = join(workspace, "kit.mjs");
const built = spawnSync(join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${out}`],
  { encoding: "utf8", env: hermeticEnv() });
assert.equal(built.status, 0, built.stderr);
const { attachBinding, sameLineage, freshGeneration, bindingName, BINDING_TAG } = await import(out);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (error) { failures += 1; console.log(`not ok - ${name}\n${error.stack}`); }
}

const repo = join(workspace, "repo");
mkdirSync(repo, { recursive: true });
const identity = { cli: "claude", sessionId: "f805a94c-be04", pid: 3758911, pidStart: "123", zellijSession: "Workspace", paneId: "12", cwd: repo };
const policy = { enabled: true, interval: "15m" };
const base = bindingName(identity);

function fakeClient(rows) {
  const runners = new Map();
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    runner: async (id) => runners.get(id),
    create: async (body) => {
      if (rows.some((r) => r.name === body.name)) return { status: 409 };
      const row = { id: `id-${rows.length}`, name: body.name, tags: body.tags, schedule: body.schedule, timezone: "UTC", enabled: true, archived: false };
      rows.push(row);
      runners.set(row.id, body.runner);
      return { status: 201, row };
    },
    setEnabled: async () => {},
    archive: async (id) => { rows.find((r) => r.id === id).archived = true; },
    invocations: async () => [],
    patch: async () => {},
  };
}
const deps = (client) => ({ client, emit: () => {}, project: () => {} });

await check("lineage and generations", () => {
  assert.ok(sameLineage(base, base));
  assert.ok(sameLineage(`${base}-r2`, base));
  assert.ok(!sameLineage(`${base}9`, base));
  assert.equal(freshGeneration(base, []), base);
  assert.equal(freshGeneration(base, [base]), `${base}-r2`);
  assert.equal(freshGeneration(base, [base, `${base}-r2`]), `${base}-r3`);
});

await check("an archived name re-attaches as the next generation, then is idempotent", async () => {
  const client = fakeClient([{ id: "old", name: base, tags: [BINDING_TAG], schedule: "* * * * *", timezone: "UTC", enabled: false, archived: true }]);
  const first = await attachBinding(identity, policy, { root: repo, slug: "repo" }, deps(client));
  assert.equal(first.status, "attached");
  assert.equal(first.name, `${base}-r2`);
  const again = await attachBinding(identity, policy, { root: repo, slug: "repo" }, deps(client));
  assert.equal(again.status, "already");
  assert.equal(again.name, `${base}-r2`);
  assert.deepEqual(again.superseded, []);
  assert.equal(client.rows.filter((r) => !r.archived).length, 1);
});

await check("a fresh identity keeps its plain name", async () => {
  const client = fakeClient([]);
  const result = await attachBinding(identity, policy, { root: repo, slug: "repo" }, deps(client));
  assert.equal(result.name, base);
});

if (failures) process.exit(1);
