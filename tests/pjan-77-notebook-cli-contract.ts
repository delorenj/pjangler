import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { safeDocumentTitle } from "../src/notebook/capture";
import { notebookParserFailureEnvelope, registerNotebookCli } from "../src/notebook/cli";
import { NotebookModule } from "../src/notebook/module";
import { searchNotesLocally, withNoteEnvelope } from "../src/notebook/notes";
import { failureEnvelope, notebookEnvelopeExitCode, renderNotebookJson, successEnvelope, validateNotebookEnvelope } from "../src/notebook/output";
import { listRemoteMutationJournals } from "../src/notebook/remote-mutation-journal";
import { DEFAULT_NOTEBOOK_LIMITS, NOTEBOOK_POLICY_VERSION, NotebookError, type EffectiveNotebookConfigV1, type NotebookErrorCode, type OpenNotebookNoteV1, type ProjectNotebookBindingV1 } from "../src/notebook/types";
import { saveProjectRegistry, type ProjectRecord, type ProjectRegistry } from "../src/project/index";

function record(repo: string, binding: ProjectNotebookBindingV1): ProjectRecord {
  return {
    name: "Alpha", slug: "alpha", repo_path: repo, description: "CLI fixture", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "ALPHA", identifier_source: "provider", identifier_fetched_at: "2026-08-28T00:00:00.000Z", board_id: "board", board_confirmed_at: "2026-08-28T00:00:00.000Z", state: "linked" },
    agents: {}, notebook: binding, created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z",
  };
}

function note(id: string, title: string, content: string, updatedAt: string | null): OpenNotebookNoteV1 {
  return { id, title, content, note_type: "human", created_at: "2026-08-19T00:00:00.000Z", updated_at: updatedAt };
}

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-cli-"));
try {
  const repo = join(workspace, "repo");
  const registryPath = join(workspace, "registry.yaml");
  const stateRoot = join(workspace, "state");
  mkdirSync(repo, { recursive: true });
  const binding: ProjectNotebookBindingV1 = { state: "linked", notebook_id: "nb-alpha", notebook_name: "Alpha", overview_note_id: "overview-alpha" };
  const registry: ProjectRegistry = {
    schema_version: 1,
    notebook: {
      base_url: "http://127.0.0.1:8502",
      auth: { mode: "none" },
      defaults: { enabled: true, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 512, documentation_globs: ["**/*.md"] },
      limits: { ...DEFAULT_NOTEBOOK_LIMITS, note_max_bytes: 2_048, source_file_max_bytes: 1_024 },
    },
    projects: { alpha: record(repo, binding) },
  };
  saveProjectRegistry(registry, registryPath);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({
    project_name: "Alpha", project_description: "CLI fixture", project_slug: "alpha", repo_path: repo,
    ticket_provider: { type: "plane", workspace: "33god", identifier: "ALPHA", identifier_source: "provider", identifier_fetched_at: "2026-08-28T00:00:00.000Z", board_id: "board", board_confirmed_at: "2026-08-28T00:00:00.000Z", state: "linked" }, agents: {},
    notebook: { binding, policy: { enabled: true, session_start_enabled: false, session_capture_enabled: false, overview_references: [".project.json"] } },
  }, null, 2)}\n`);

  const overviewEnvelope = {
    schema_version: 1 as const, project_slug: "alpha", kind: "overview" as const, logical_id: "overview:v1:alpha", policy_version: NOTEBOOK_POLICY_VERSION,
    overview_descriptor: { schema_version: 1 as const, project_slug: "alpha", project_name: "Alpha", purpose: "CLI fixture", references: [{ path: ".project.json", status: "missing" as const, reason: "not-tracked" }], compiler_policy_version: NOTEBOOK_POLICY_VERSION },
  };
  const userEnvelope = { schema_version: 1 as const, project_slug: "alpha", kind: "user-note" as const, logical_id: "user-note:v1:11111111-1111-4111-8111-111111111111", policy_version: NOTEBOOK_POLICY_VERSION };
  const foreignEnvelope = { ...userEnvelope, project_slug: "beta", logical_id: "user-note:v1:22222222-2222-4222-8222-222222222222" };
  const documentEnvelope = { schema_version: 1 as const, project_slug: "alpha", kind: "document" as const, logical_id: "a".repeat(64), source_path: "README.md", source_revision: "b".repeat(40), content_sha256: "c".repeat(64), session_key: "d".repeat(64), captured_at: "2026-08-19T00:00:00.000Z", policy_version: NOTEBOOK_POLICY_VERSION };
  const notes: OpenNotebookNoteV1[] = [
    note("overview-alpha", "Project Overview", withNoteEnvelope(overviewEnvelope, "Overview"), "2026-08-19T04:00:00.000Z"),
    note("user-alpha", "User", withNoteEnvelope(userEnvelope, "User body"), "2026-08-19T03:00:00.000Z"),
    note("foreign", "Foreign", withNoteEnvelope(foreignEnvelope, "Foreign body"), "2026-08-19T02:00:00.000Z"),
    note("document", "README.md", withNoteEnvelope(documentEnvelope, "Derived body"), null),
    note("invalid-time-b", "Manual B", "manual", "not-a-time"),
    note("invalid-time-a", "Manual A", "manual", null),
  ];
  let updateCalls = 0;
  let deleteCalls = 0;
  let notebookListFailure = false;
  let noteListFailure = false;
  let notebooks = [{ id: "nb-alpha", name: "Alpha", description: "pjangler.project.v1:alpha", archived: false }];
  const fakeClient = {
    async listNotebooks() {
      if (notebookListFailure) throw new NotebookError("SERVICE_UNAVAILABLE", "bounded fixture failure", true);
      return notebooks.map((item) => ({ ...item }));
    },
    async listNotes(notebookId: string) {
      assert.equal(notebookId, "nb-alpha");
      if (noteListFailure) throw new NotebookError("SERVICE_UNAVAILABLE", "bounded Overview fixture failure", true);
      return notes.map((item) => ({ ...item }));
    },
    async createNote(_notebookId: string, input: { title: string; content: string; note_type?: string }, beforeDispatch?: () => void) {
      beforeDispatch?.();
      const created = note(`created-${notes.length}`, input.title, input.content, "2026-08-19T05:00:00.000Z");
      notes.push(created);
      return { ...created };
    },
    async updateOwnedNote(_notebookId: string, id: string, input: { title?: string; content?: string }) {
      updateCalls += 1;
      const index = notes.findIndex((item) => item.id === id);
      if (index < 0) throw new NotebookError("NOT_FOUND", "missing");
      notes[index] = { ...notes[index]!, ...input, updated_at: "2026-08-19T06:00:00.000Z" };
      return { ...notes[index]! };
    },
    async deleteOwnedNote(_notebookId: string, id: string) { deleteCalls += 1; const index = notes.findIndex((item) => item.id === id); if (index >= 0) notes.splice(index, 1); },
  };
  let clientConstructions = 0;
  const module = new NotebookModule({ registryPath, stateRoot, env: { HOME: join(workspace, "home") }, clientFactory: () => { clientConstructions += 1; return fakeClient as never; } });

  const localStatus = await module.status(repo, true);
  assert.equal(localStatus.health, null);
  assert.equal(localStatus.data.remote_check, "skip");
  assert.equal(clientConstructions, 0, "--local-only status never constructs the remote adapter");
  const statusJson = renderNotebookJson(successEnvelope("notebook.status", localStatus.config, localStatus.data, localStatus.health));
  assert.equal(JSON.parse(statusJson).schema_version, 1);

  const exactOverviewContent = notes[0]!.content;
  notes[0]!.content = withNoteEnvelope({
    ...overviewEnvelope,
    overview_descriptor: {
      ...overviewEnvelope.overview_descriptor,
      references: [{ path: ".project.json", status: "missing", reason: "captured-before-reference-change" }],
    },
  }, "Overview");
  const driftedOverviewAudit = await module.audit(repo, false);
  assert.equal(driftedOverviewAudit.health, "drifted", "aggregate health remains drifted while the Overview descriptor is stale");
  assert.equal(driftedOverviewAudit.data.remote_check, "fail", "aggregate remote_check remains failed until Overview drift is repaired");
  const remoteNotebookRule = driftedOverviewAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook");
  const overviewRule = driftedOverviewAudit.data.rules.find((rule) => rule.id === "notebook.overview-note");
  assert.equal(remoteNotebookRule?.status, "pass", "an exact bound notebook passes independently of Overview drift");
  assert.equal(overviewRule?.status, "fail", "the stale Overview fails only its owning audit rule");
  assert.deepEqual(overviewRule?.details, [".project.json: reference-changed"]);
  notes[0]!.content = exactOverviewContent;

  notebooks = [...notebooks, { id: "nb-duplicate", name: "Alpha duplicate", description: "pjangler.project.v1:alpha", archived: false }];
  const ambiguousNotebookAudit = await module.audit(repo, false);
  assert.equal(ambiguousNotebookAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.status, "fail", "duplicate stable markers remain a remote-notebook failure");
  assert.deepEqual(ambiguousNotebookAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.details, ["notebook.marker: ambiguous:2"]);
  assert.equal(ambiguousNotebookAudit.data.rules.find((rule) => rule.id === "notebook.overview-note")?.status, "pass", "an exact bound Overview is independently reported even while notebook ownership is ambiguous");

  notebooks = [{ id: "nb-alpha", name: "Renamed elsewhere", description: "pjangler.project.v1:alpha", archived: true }];
  const metadataDriftAudit = await module.audit(repo, false);
  assert.deepEqual(metadataDriftAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.details, ["notebook.name: mismatch", "notebook.archived: archived"], "name/archive drift remains a remote-notebook failure");

  notebooks = [];
  const missingNotebookAudit = await module.audit(repo, false);
  assert.equal(missingNotebookAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.status, "fail", "a missing bound notebook remains failed");
  assert.deepEqual(missingNotebookAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.details, ["notebook: bound-id-not-found", "notebook.marker: missing"]);

  notebookListFailure = true;
  const unavailableNotebookAudit = await module.audit(repo, false);
  assert.equal(unavailableNotebookAudit.health, "unavailable");
  assert.deepEqual(unavailableNotebookAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.details, ["remote: unavailable:SERVICE_UNAVAILABLE"]);
  notebookListFailure = false;
  notebooks = [{ id: "nb-alpha", name: "Alpha", description: "pjangler.project.v1:alpha", archived: false }];

  noteListFailure = true;
  const unavailableOverviewAudit = await module.audit(repo, false);
  assert.equal(unavailableOverviewAudit.health, "unavailable");
  assert.equal(unavailableOverviewAudit.data.rules.find((rule) => rule.id === "notebook.remote-notebook")?.status, "pass", "a scoped-note outage cannot erase already-proved notebook metadata");
  assert.equal(unavailableOverviewAudit.data.rules.find((rule) => rule.id === "notebook.overview-note")?.status, "fail");
  noteListFailure = false;

  const listed = await module.listNotes(repo, 20);
  assert.deepEqual(listed.data.items.map((item) => item.id), ["overview-alpha", "user-alpha", "foreign", "document", "invalid-time-a", "invalid-time-b"], "list order is updated_at descending then id ascending, with invalid/null timestamps stable at the end");
  const searchOrdering = searchNotesLocally([
    note("invalid-first-by-id", "match", "match", null),
    note("valid-later-id", "match", "match", "2026-08-19T01:00:00.000Z"),
  ], "match", 10, 100);
  assert.deepEqual(searchOrdering.items.map((item) => item.id), ["valid-later-id", "invalid-first-by-id"], "search uses the same valid-first updated_at convention");
  const compatibilityExcerpt = searchNotesLocally([note("nfkc", "Other", "prefix ﬁnd target", null)], "find", 1, 100);
  assert.equal(compatibilityExcerpt.items[0]?.excerpt, "find target", "search slices the same NFKC-normalized body used to locate the query");

  await assert.rejects(() => module.addNote(repo, "bad\nremote title", "body"), (error: unknown) => error instanceof NotebookError && error.code === "INVALID_INPUT");
  assert.equal(listRemoteMutationJournals(stateRoot, "alpha").length, 0, "hostile title rejection occurs before mutation reservation");
  assert.doesNotMatch(safeDocumentTitle("odd\n\0path.md"), /[\u0000-\u001f\u007f]/u, "Git path controls are escaped before becoming a remote title");

  const added = await module.addNote(repo, "Safe title", "Safe body");
  assert.equal(added.data.note.title, "Safe title");
  const userJournal = listRemoteMutationJournals(stateRoot, "alpha").find((item) => item.logical_marker.startsWith("user-note:v1:"));
  assert.ok(userJournal);
  assert.equal(userJournal.logical_marker, `user-note:v1:${userJournal.operation_id}`, "user-note logical identity is exactly its reserved journal operation ID");
  assert.equal(userJournal.state, "committed");

  await assert.rejects(() => module.updateNote(repo, "foreign", { text: "attack" }), (error: unknown) => error instanceof NotebookError && error.code === "CROSS_PROJECT");
  await assert.rejects(() => module.deleteNote(repo, "foreign", true), (error: unknown) => error instanceof NotebookError && error.code === "CROSS_PROJECT");
  await assert.rejects(() => module.updateNote(repo, "document", { text: "stale provenance" }), (error: unknown) => error instanceof NotebookError && error.code === "CONFLICT");
  assert.equal(updateCalls, 0, "foreign and derived-note refusals occur before adapter mutation");
  assert.equal(deleteCalls, 0);

  const originalOverview = notes[0]!.content;
  notes[0]!.content = withNoteEnvelope({ ...overviewEnvelope, project_slug: "beta", logical_id: "overview:v1:beta", overview_descriptor: { ...overviewEnvelope.overview_descriptor, project_slug: "beta" } }, "Foreign overview");
  await assert.rejects(() => module.overview(repo, "replacement"), (error: unknown) => error instanceof NotebookError && error.code === "CROSS_PROJECT");
  notes[0]!.content = originalOverview;

  const overviewRead = await module.overview(repo);
  const searched = await module.searchNotes(repo, "User", 10);
  const audited = await module.audit(repo, true);
  const currentConfig = module.context(repo, false).config;
  const receiptFixture = {
    receipt_id: "1".repeat(64), logical_id: "2".repeat(64), session_key: "3".repeat(64), state: "succeeded" as const,
    created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:01.000Z", automatic_attempts_used: 1, automatic_attempt_limit: 2,
    manual_retry_count: 0, attempt_origin: "automatic" as const, error_category: null, retryable: false, diagnostic: null, summary_mode: "deterministic-fallback" as const,
    exclusion_counts: {}, note_logical_ids: ["4".repeat(64)], remote_note_ids: ["remote-1"], serialized_bytes: 512,
  };
  const commandSchemas: Array<[string, unknown, unknown]> = [
    ["notebook.status", localStatus.data, localStatus.health],
    ["notebook.create", { created: true, adopted: false, notebook_id: "nb-alpha", overview_note_id: "overview-alpha" }, "healthy"],
    ["notebook.notes.list", listed.data, null],
    ["notebook.notes.search", searched.data, null],
    ["notebook.notes.add", added.data, null],
    ["notebook.notes.get", added.data, null],
    ["notebook.notes.update", added.data, null],
    ["notebook.notes.delete", { deleted_id: "manual-1" }, null],
    ["notebook.overview.get", overviewRead.data, null],
    ["notebook.overview.set", { ...overviewRead.data, updated: true }, null],
    ["notebook.capture.list", { items: [receiptFixture], next_cursor: null }, null],
    ["notebook.capture.retry", { receipt: receiptFixture }, null],
    ["notebook.audit", audited.data, audited.health],
    ["notebook.migrate", { dry_run: true, selected_rules: [], results: [], changed_files: [] }, null],
  ];
  for (const [command, data, health] of commandSchemas) validateNotebookEnvelope(successEnvelope(command, currentConfig, data, health as never));

  const journalCount = listRemoteMutationJournals(stateRoot, "alpha").length;
  registry.notebook = { ...registry.notebook, defaults: { ...(registry.notebook?.defaults ?? {}), overview_max_chars: 128 }, limits: { ...DEFAULT_NOTEBOOK_LIMITS, note_max_bytes: 256, source_file_max_bytes: 240 } };
  saveProjectRegistry(registry, registryPath);
  await assert.rejects(() => module.addNote(repo, "Boundary", "é".repeat(100)), (error: unknown) => error instanceof NotebookError && error.code === "INVALID_INPUT" && /ownership envelope/u.test(error.message));
  assert.equal(listRemoteMutationJournals(stateRoot, "alpha").length, journalCount, "final UTF-8 envelope ceiling rejects before journal reservation");

  const validListEnvelope = successEnvelope("notebook.notes.list", module.context(repo, false).config, { items: [], next_cursor: null });
  validateNotebookEnvelope(validListEnvelope);
  assert.throws(() => validateNotebookEnvelope({ ...validListEnvelope, data: { items: [], next_cursor: null, extra: true } } as never), /invalid JSON v1 envelope/u);
  const exits: Array<[NotebookErrorCode, number]> = [["INVALID_INPUT", 2], ["NOT_CONFIGURED", 3], ["AUTHENTICATION_FAILED", 3], ["NOT_FOUND", 4], ["CONFLICT", 4], ["CROSS_PROJECT", 4], ["DRIFT_DETECTED", 4], ["THROTTLED", 5], ["TIMEOUT", 5], ["SERVICE_UNAVAILABLE", 5], ["REMOTE_PROTOCOL_ERROR", 6], ["INTERNAL_ERROR", 6]];
  for (const [code, expected] of exits) {
    const envelope = failureEnvelope("notebook.notes.get", module.context(repo, false).config, new NotebookError(code, "bounded failure"));
    validateNotebookEnvelope(envelope);
    assert.equal(notebookEnvelopeExitCode(envelope), expected, code);
  }
  for (const args of [
    ["notebook", "get", "note", "--json"],
    ["notebook", "search", "notes", "--json"],
    ["notebook", "status", repo, "--unknown-option", "--json"],
  ]) {
    const envelope = notebookParserFailureEnvelope(args, module);
    validateNotebookEnvelope(envelope);
    assert.equal(envelope.error?.code, "INVALID_INPUT");
    assert.equal(notebookEnvelopeExitCode(envelope), 2);
  }

  const program = new Command();
  program.exitOverride();
  registerNotebookCli(program, module);
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const previousExit = process.exitCode;
  try {
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => { stdout += String(chunk); return true; };
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => { stderr += String(chunk); return true; };
    await program.parseAsync(["node", "pj", "notebook", "status", repo, "--local-only", "--json"]);
    const emitted = JSON.parse(stdout) as { schema_version: number; command: string; data: { remote_check: string }; notebook: { health: unknown } };
    assert.equal(emitted.schema_version, 1);
    assert.equal(emitted.command, "notebook.status");
    assert.equal(emitted.data.remote_check, "skip");
    assert.equal(emitted.notebook.health, null);
    stdout = "";
    stderr = "";
    process.exitCode = 0;
    await program.parseAsync(["node", "pj", "notebook", "get", "note", "user-alpha", repo, "--json"]);
    assert.equal((JSON.parse(stdout) as { ok: boolean; command: string }).ok, true, "nested CRUD succeeds through Commander");
    assert.equal((JSON.parse(stdout) as { command: string }).command, "notebook.notes.get");
    stdout = "";
    stderr = "";
    process.exitCode = 0;
    await program.parseAsync(["node", "pj", "notebook", "get", "note", "does-not-exist", repo, "--json"]);
    assert.equal((JSON.parse(stdout) as { ok: boolean; error: { code: string } }).error.code, "NOT_FOUND", "nested CRUD failure is one categorized JSON envelope");
    assert.equal(process.exitCode, 4);
    stdout = "";
    stderr = "";
    process.exitCode = 0;
    await program.parseAsync(["node", "pj", "notebook", "list", "notes", repo, "--limit", "not-a-number", "--json"]);
    assert.equal((JSON.parse(stdout) as { error: { code: string } }).error.code, "INVALID_INPUT", "invalid numeric option is handled inside the JSON action boundary");
    assert.equal(process.exitCode, 2);
    stdout = "";
    stderr = "";
    await program.parseAsync(["node", "pj", "notebook", "hook", "session-start", "--payload-file", join(workspace, "missing-payload.json")]);
    assert.equal(stderr.trim().split("\n").length, 1, "hook payload failure emits exactly one bounded fail-open line");
    assert.match(stderr, /^project-notebook: hook payload rejected; failed open:/u);
    assert.equal(process.exitCode, 0);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exitCode = previousExit;
  }

  console.log("pjan-77 notebook CLI contract: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
