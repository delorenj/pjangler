import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournalNotebookService } from "../src/notebook/journal-service";
import { journalNoteOperationId, validateJournalPeriodKey } from "../src/notebook/journal-key";
import { NotebookModule } from "../src/notebook/module";
import { parseNoteEnvelope } from "../src/notebook/notes";
import { DEFAULT_NOTEBOOK_LIMITS, type OpenNotebookNoteV1 } from "../src/notebook/types";
import { saveProjectRegistry, type ProjectRecord, type ProjectRegistry } from "../src/project/index";

assert.equal(journalNoteOperationId("daily", "2026-09-24"), journalNoteOperationId("daily", "2026-09-24"));
assert.notEqual(journalNoteOperationId("daily", "2026-09-24"), journalNoteOperationId("weekly", "2026-09-21"));
assert.throws(() => validateJournalPeriodKey("daily", "2026-02-30"), /calendar date/u);
assert.throws(() => validateJournalPeriodKey("weekly", "2026-09-22"), /Monday/u);
assert.throws(() => validateJournalPeriodKey("monthly", "2026-13"), /YYYY-MM/u);

const workspace = mkdtempSync(join(tmpdir(), "pjan-144-journal-"));
let service: Awaited<ReturnType<typeof createJournalNotebookService>> | undefined;
try {
  const repo = join(workspace, "infra");
  mkdirSync(repo, { recursive: true });
  const record: ProjectRecord = {
    name: "Infra", slug: "infra", repo_path: repo, description: "Infrastructure", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "INFR", identifier_source: "provider", identifier_fetched_at: "2026-09-24T00:00:00Z", board_id: "board-infra", board_confirmed_at: "2026-09-24T00:00:00Z", state: "linked" },
    agents: {}, notebook: { state: "linked", notebook_id: "notebook-infra", notebook_name: "Infra", overview_note_id: "overview-infra" },
    created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
  };
  const registry: ProjectRegistry = {
    schema_version: 1,
    notebook: { base_url: "http://127.0.0.1:8502", auth: { mode: "none" }, defaults: { enabled: true, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 512, documentation_globs: ["**/*.md"] }, limits: DEFAULT_NOTEBOOK_LIMITS },
    projects: { infra: record },
  };
  const registryPath = join(workspace, "registry.yaml");
  saveProjectRegistry(registry, registryPath);
  const notes: OpenNotebookNoteV1[] = [];
  let createCount = 0;
  let updateCount = 0;
  const fakeClient = {
    async listNotes(notebookId: string) { assert.equal(notebookId, "notebook-infra"); return notes.map((note) => ({ ...note })); },
    async createNote(notebookId: string, input: { title: string; content: string; note_type?: string }, beforeDispatch?: () => void) {
      assert.equal(notebookId, "notebook-infra"); beforeDispatch?.(); createCount += 1;
      const note: OpenNotebookNoteV1 = { id: `note-${createCount}`, title: input.title, content: input.content, note_type: input.note_type ?? "human", created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z" };
      notes.push(note); return { ...note };
    },
    async updateOwnedNote(notebookId: string, noteId: string, input: { title?: string; content?: string }) {
      assert.equal(notebookId, "notebook-infra"); updateCount += 1;
      const index = notes.findIndex((note) => note.id === noteId); assert.notEqual(index, -1);
      notes[index] = { ...notes[index]!, ...input, updated_at: "2026-09-24T01:00:00Z" };
      return { ...notes[index]! };
    },
  };
  const module = new NotebookModule({ registryPath, stateRoot: join(workspace, "state"), env: { HOME: workspace }, clientFactory: () => fakeClient as never });
  const first = await module.upsertInfraJournalNote("daily", "2026-09-24", "Daily 2026-09-24", "body one");
  assert.deepEqual({ created: first.created, updated: first.updated }, { created: true, updated: false });
  const same = await module.upsertInfraJournalNote("daily", "2026-09-24", "Daily 2026-09-24", "body one");
  assert.equal(same.note_id, first.note_id);
  assert.deepEqual({ created: same.created, updated: same.updated }, { created: false, updated: false });
  assert.equal(updateCount, 0);
  const changed = await module.upsertInfraJournalNote("daily", "2026-09-24", "Daily 2026-09-24 updated", "body two");
  assert.equal(changed.note_id, first.note_id);
  assert.deepEqual({ created: changed.created, updated: changed.updated }, { created: false, updated: true });
  assert.notEqual(changed.content_sha256, first.content_sha256);
  assert.equal(updateCount, 1);
  const owned = parseNoteEnvelope(notes[0]!.content);
  assert.equal(owned?.envelope.project_slug, "infra");
  assert.equal(owned?.envelope.kind, "user-note");
  assert.equal(owned?.body, "body two");
  const concurrent = await Promise.all([
    module.upsertInfraJournalNote("weekly", "2026-09-21", "Week", "week body"),
    module.upsertInfraJournalNote("weekly", "2026-09-21", "Week", "week body"),
  ]);
  assert.equal(concurrent[0]!.note_id, concurrent[1]!.note_id);
  assert.equal(createCount, 2);
  const month = await module.upsertInfraJournalNote("monthly", "2026-09", "September", "month body");
  assert.equal(month.created, true);
  assert.equal(createCount, 3);

  service = await createJournalNotebookService({ module, port: 0, token: "fixture-token" });
  const url = `${service.url}/v1/projects/infra/notes/daily/2026-09-24`;
  const health = await fetch(`${service.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { service: string }).service, "pjangler-journal-notebook");
  const unauthorized = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Daily", content: "body" }) });
  assert.equal(unauthorized.status, 401);
  const headers = { "content-type": "application/json", authorization: "Bearer fixture-token" };
  const invalidKey = await fetch(`${service.url}/v1/projects/infra/notes/weekly/2026-09-22`, { method: "PUT", headers, body: JSON.stringify({ title: "Week", content: "body" }) });
  assert.equal(invalidKey.status, 400);
  const invalidBody = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ title: "Daily", content: "body", extra: 1 }) });
  assert.equal(invalidBody.status, 400);
  const otherProject = await fetch(`${service.url}/v1/projects/other/notes/daily/2026-09-24`, { method: "PUT", headers, body: JSON.stringify({ title: "Daily", content: "body" }) });
  assert.equal(otherProject.status, 404);
  const valid = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ title: "Daily 2026-09-24 updated", content: "body two" }) });
  assert.equal(valid.status, 200);
  const reply = await valid.json() as { note_id: string; content_sha256: string; created: boolean; updated: boolean };
  assert.equal(reply.note_id, first.note_id);
  assert.equal(reply.created, false);
  assert.equal(reply.updated, false);
  console.log("journal notebook stable upsert, period validation, and HTTP contract passed");
} finally {
  if (service) await service.close();
  rmSync(workspace, { recursive: true, force: true });
}
