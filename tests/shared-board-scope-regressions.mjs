import "./helpers/hermetic-suite.mjs";
// Shared boards: several projects bind one Plane board and tell the Bloodbank
// ingress which tickets are theirs with ticket_provider.scope_label /
// scope_default. pjangler must carry both through its registry untouched, and
// refuse a malformed declaration rather than serve it.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const base = realpathSync(mkdtempSync("/tmp/shared-board-scope-"));
const entry = join(base, "entry.ts");
writeFileSync(
  entry,
  `export { readManifest, recordFromManifest } from ${JSON.stringify(join(root, "src/project/manifestIndex.ts"))};\n` +
    `export { ticketScope } from ${JSON.stringify(join(root, "src/project/ticketScope.ts"))};\n`,
);
const bundle = join(base, "bundle.cjs");
buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle, packages: "external", logLevel: "silent" });
const { readManifest, recordFromManifest, ticketScope } = createRequire(import.meta.url)(bundle);

const provider = (extra = {}) => ({
  type: "plane", workspace: "33god", identifier: "TOLT", board_id: "eb302959-0eac-48da-8fd5-ae1666bd500f", state: "linked", ...extra,
});

async function manifestAt(name, ticket_provider) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ project_id: name, ticket_provider }));
  return readManifest(join(dir, ".project.json"));
}

test("scope_label and scope_default reach the registry record untouched", async () => {
  const read = await manifestAt("tower-of-dumb-things", provider({ scope_label: "repo:game", scope_default: true }));
  const record = recordFromManifest(read.manifest, read.path);
  assert.equal(record.ticket_provider.scope_label, "repo:game");
  assert.equal(record.ticket_provider.scope_default, true);
  assert.equal(record.ticket_provider.board_id, "eb302959-0eac-48da-8fd5-ae1666bd500f");
});

test("a project that declares no scope is unchanged", async () => {
  const read = await manifestAt("solo", provider());
  const record = recordFromManifest(read.manifest, read.path);
  assert.equal("scope_label" in record.ticket_provider, false);
  assert.equal("scope_default" in record.ticket_provider, false);
});

test("a malformed scope declaration is refused, not served", async () => {
  await assert.rejects(manifestAt("bad-label", provider({ scope_label: ["repo:game"] })), /scope_label must be a string/);
  await assert.rejects(manifestAt("bad-default", provider({ scope_default: "yes" })), /scope_default must be a boolean/);
});

test("ticketScope keeps only well-formed declarations (the pj init re-sync path)", () => {
  assert.deepEqual(ticketScope(provider({ scope_label: " repo:forge ", scope_default: true })), { scope_label: "repo:forge", scope_default: true });
  assert.deepEqual(ticketScope(provider({ scope_label: "", scope_default: false })), {});
  assert.deepEqual(ticketScope(provider({ scope_label: 3, scope_default: "true" })), {});
  assert.deepEqual(ticketScope(undefined), {});
});

test.after(() => rmSync(base, { recursive: true, force: true }));
