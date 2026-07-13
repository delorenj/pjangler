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
import type { ProjectRecord } from "../src/project/index";

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
    ticket_provider: { type: "plane", workspace: "33god", identifier: "PGSC", board_id: "board-123", state: "linked" },
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
const r = rec();
await store.upsert(r.slug, r);
await store.upsert(r.slug, rec({ description: "updated" })); // idempotent ON CONFLICT path

const reg = await store.load();
const got = reg.projects[r.slug];
assert.ok(got, "record not found in PG after upsert");
assert.equal(got.repo_path, "/tmp/pg-store-check");
assert.equal(got.description, "updated", "idempotent upsert should reflect latest write");
assert.equal(got.ticket_provider.board_id, "board-123");
assert.equal(got.agents["pg-store-check-pm"]?.role, "pm");
assert.equal(Object.keys(reg.projects).length, 1, "load() must return ONLY slug-owned rows");

const check = new Pool(cfg);
const legacyStill = await check.query(`SELECT name, description, slug FROM public.projects WHERE id = $1`, [legacyId]);
assert.equal(legacyStill.rows.length, 1, "legacy row vanished!");
assert.equal(legacyStill.rows[0].description, "do not touch", "legacy row was MUTATED");
assert.equal(legacyStill.rows[0].slug, null, "legacy row must remain slug NULL");
assert.equal((await check.query(`SELECT count(*)::int AS n FROM public.projects`)).rows[0].n, 2);
await check.end();

// ---- 3) DualWriteRegistryStore: writes yaml + PG, reads yaml ----
const dual = new DualWriteRegistryStore(new YamlRegistryStore(join(tmp, "dual.yaml")), new PgRegistryStore(cfg));
await dual.upsert("dual-proj", rec({ slug: "dual-proj", repo_path: "/tmp/dual", ticket_provider: { type: "plane", workspace: "33god", identifier: "DUAL", board_id: "b2", state: "linked" } }));
const dread = await dual.load(); // reads yaml
assert.ok(dread.projects["dual-proj"], "dual-write yaml read");
const pgAfterDual = await store.load(); // PG should also have it
assert.ok(pgAfterDual.projects["dual-proj"], "dual-write should have written to PG too");
await dual.close();

await store.close();
rmSync(tmp, { recursive: true, force: true });
console.log("PG_STORE_CHECK_OK: yaml + pg round-trip correct; dual-write ok; legacy slug-NULL row untouched.");
