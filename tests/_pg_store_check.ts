// Runtime verification of the RegistryStore family against a scratch DB (bun).
// Covers: YamlRegistryStore round-trip, PgRegistryStore round-trip + the
// slug-NULL legacy-row safety boundary, and DualWriteRegistryStore (yaml + PG).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  PgRegistryStore,
  YamlRegistryStore,
  DualWriteRegistryStore,
  pgRegistryConfigFromEnv,
} from "../src/project/RegistryStore";
import type { ProjectRecord, ProjectRegistry } from "../src/project/index";

const cfg = pgRegistryConfigFromEnv(); // PGDATABASE=pjangler_registry_scratch set by the runner

function rec(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    name: "PG Store Check",
    slug: "pg-store-check",
    repo_path: "/tmp/pg-store-check",
    description: "round-trip test",
    status: "active",
    source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "PGSC", identifier_source: "provider", identifier_fetched_at: "2026-08-28T00:00:00.000Z", board_id: "board-123", state: "linked" },
    agents: { "pg-store-check-pm": { role: "pm", provisioning_state: "provisioned", role_dir: "agents/hermes/pm" } },
    automation: { reconcile: { enabled: false, grace_hours: 0, auto_review: true } },
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "pjreg-"));

// ---- 1) YamlRegistryStore round-trip (no DB) ----
{
  const y = new YamlRegistryStore(join(tmp, "projects.yaml"));
  const r = rec();
  await y.upsert(r.slug, r);
  const back = await y.load();
  assert.equal(back.projects[r.slug]?.repo_path, r.repo_path, "yaml round-trip repo_path");
  assert.equal(await (await y.getByRepoPath(r.repo_path))?.slug, r.slug, "yaml getByRepoPath");
}

// ---- 2) PgRegistryStore round-trip + legacy-row safety ----
const seed = new Pool(cfg);
const legacy = await seed.query(
  `INSERT INTO public.projects (name, description) VALUES ('LegacyOwnedElsewhere', 'do not touch') RETURNING id`,
);
const legacyId: string = legacy.rows[0].id;
await seed.end();

const store = new PgRegistryStore(cfg);
const r = rec({
  notebook: { state: "linked", notebook_id: "nb-pg-store", notebook_name: "PG Store", overview_note_id: "overview-pg-store", x_binding: { preserve: true } },
  x_project_extension: { nested: "preserve" },
});
const registryWithNotebook: ProjectRegistry = {
  schema_version: 1,
  notebook: {
    base_url: "https://notebook.example.test",
    auth: { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" },
    defaults: { enabled: true, session_capture_enabled: false },
    limits: { unresolved_receipt_max_count: 25 },
    x_global_notebook: { preserve: true },
  },
  projects: { [r.slug]: r },
  x_registry_extension: { nested: "preserve" },
};
await store.save(registryWithNotebook);
await store.upsert(r.slug, { ...r, description: "updated" }); // idempotent ON CONFLICT path

const reg = await store.load();
const got = reg.projects[r.slug];
assert.ok(got, "record not found in PG after upsert");
assert.equal(got.repo_path, "/tmp/pg-store-check");
assert.equal(got.description, "updated", "idempotent upsert should reflect latest write");
assert.equal(got.ticket_provider.board_id, "board-123");
// PID-4: provenance is a first-class column. A Postgres round-trip that dropped
// it would demote a provider-confirmed board back to a guess, and the "linked"
// invariant would then reject the record it just wrote.
assert.equal(got.ticket_provider.identifier_source, "provider");
assert.equal(got.ticket_provider.identifier_fetched_at, "2026-08-28T00:00:00.000Z");
assert.equal(got.agents["pg-store-check-pm"]?.role, "pm");
assert.deepEqual(got.notebook?.x_binding, { preserve: true }, "project notebook unknown descendant round-trips semantically");
assert.deepEqual(got.x_project_extension, { nested: "preserve" }, "project sibling extension round-trips semantically");
assert.equal(reg.notebook?.base_url, "https://notebook.example.test");
assert.deepEqual(reg.notebook?.x_global_notebook, { preserve: true }, "global notebook unknown descendant round-trips semantically");
assert.deepEqual(reg.x_registry_extension, { nested: "preserve" }, "Registry top-level extension round-trips semantically");
assert.equal(Object.keys(reg.projects).length, 1, "load() must return ONLY slug-owned rows");

const check = new Pool(cfg);
const legacyStill = await check.query(`SELECT name, description, slug FROM public.projects WHERE id = $1`, [legacyId]);
assert.equal(legacyStill.rows.length, 1, "legacy row vanished!");
assert.equal(legacyStill.rows[0].description, "do not touch", "legacy row was MUTATED");
assert.equal(legacyStill.rows[0].slug, null, "legacy row must remain slug NULL");
assert.equal((await check.query(`SELECT count(*)::int AS n FROM public.projects`)).rows[0].n, 2);
await check.end();

await assert.rejects(
  () => store.upsert("duplicate-notebook", rec({ slug: "duplicate-notebook", repo_path: "/tmp/duplicate-notebook", ticket_provider: { type: "plane", workspace: "33god", identifier: "DUPNB", identifier_source: "provider", board_id: "dup", state: "linked" }, notebook: { state: "linked", notebook_id: "nb-pg-store", notebook_name: "Duplicate", overview_note_id: "overview-duplicate" } })),
  /projects_notebook_id_unique|duplicate key|unique/iu,
  "partial unique notebook identity rejects a second nonempty PJangler binding",
);
assert.equal((await store.load()).projects[r.slug]?.notebook?.notebook_id, "nb-pg-store", "failed duplicate transaction preserves the original binding");
await assert.rejects(
  () => store.upsert("duplicate-overview", rec({ slug: "duplicate-overview", repo_path: "/tmp/duplicate-overview", ticket_provider: { type: "plane", workspace: "33god", identifier: "DUPOV", identifier_source: "provider", board_id: "dup-ov", state: "linked" }, notebook: { state: "linked", notebook_id: "nb-overview-duplicate", notebook_name: "Duplicate Overview", overview_note_id: "overview-pg-store" } })),
  /projects_overview_note_id_unique|duplicate key|unique/iu,
  "partial unique Overview identity rejects a second nonempty PJangler binding",
);

const stale = rec({ slug: "stale-pg", repo_path: "/tmp/stale-pg", ticket_provider: { type: "plane", workspace: "33god", identifier: "STALEPG", identifier_source: "provider", board_id: "stale", state: "linked" } });
await store.upsert(stale.slug, stale);
assert.ok((await store.load()).projects[stale.slug]);
await store.save(registryWithNotebook);
assert.equal((await store.load()).projects[stale.slug], undefined, "authoritative full save removes absent slug-owned PG records");

// ---- 3) DualWriteRegistryStore: writes yaml + PG, reads yaml ----
const dual = new DualWriteRegistryStore(new YamlRegistryStore(join(tmp, "dual.yaml")), new PgRegistryStore(cfg));
await dual.upsert("dual-proj", rec({ slug: "dual-proj", repo_path: "/tmp/dual", ticket_provider: { type: "plane", workspace: "33god", identifier: "DUAL", identifier_source: "provider", board_id: "b2", state: "linked" } }));
const dread = await dual.load(); // reads yaml
assert.ok(dread.projects["dual-proj"], "dual-write yaml read");
const pgAfterDual = await store.load(); // PG should also have it
assert.ok(pgAfterDual.projects["dual-proj"], "dual-write should have written to PG too");
await dual.close();

// ---- 4) Dual-write failure is observable while YAML authority survives ----
const failureYaml = new YamlRegistryStore(join(tmp, "dual-failure.yaml"));
const pgFailure = { async save() { throw new Error("injected PG mirror failure"); }, async upsert() { throw new Error("injected PG mirror failure"); }, async close() {} } as unknown as PgRegistryStore;
const failureDual = new DualWriteRegistryStore(failureYaml, pgFailure);
const errors: string[] = [];
const originalError = console.error;
try {
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  await failureDual.save({ ...registryWithNotebook, projects: { [r.slug]: { ...r, description: "yaml survives" } } });
} finally { console.error = originalError; }
assert.match(errors.join("\n"), /PG write failed.*injected PG mirror failure/u, "PG failure is operator-visible and not reported as synchronized");
assert.equal((await failureYaml.load()).projects[r.slug]?.description, "yaml survives", "PG failure never rolls back or loses YAML authority");

await store.close();
rmSync(tmp, { recursive: true, force: true });
console.log("PG_STORE_CHECK_OK: yaml + pg notebook/global/extensions round-trip correct; unique binding, dual-write failure, and legacy safety verified.");
