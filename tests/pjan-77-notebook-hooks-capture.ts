import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProjectRegistry, saveProjectRegistry, type ProjectRecord } from "../src/project/index";
import { reconcileManagedNote } from "../src/notebook/reconcile";
import { runCaptureWorker } from "../src/notebook/capture";
import { readHookPayload, runSessionCloseHook, runSessionStartHook } from "../src/notebook/hooks";
import { NotebookModule } from "../src/notebook/module";
import { migrateNotebook } from "../src/notebook/migration";
import { listRemoteMutationJournals, mutationInputDigest, prepareRemoteMutation, transitionRemoteMutation } from "../src/notebook/remote-mutation-journal";
import { summarizeCapture } from "../src/notebook/summarizer";
import { listCaptureReceipts } from "../src/notebook/state";
import { parseNoteEnvelope, sha256Hex, withNoteEnvelope } from "../src/notebook/notes";
import { DEFAULT_NOTEBOOK_LIMITS, NOTEBOOK_POLICY_VERSION, NotebookError, type EffectiveNotebookConfigV1, type OpenNotebookNoteV1, type PjanglerNoteEnvelopeV1 } from "../src/notebook/types";

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function project(repo: string, notebook?: ProjectRecord["notebook"]): ProjectRecord {
  return {
    name: "Alpha", slug: "alpha", repo_path: repo, description: "fixture", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "ALPHA", board_id: "", state: "planned" },
    agents: {}, created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z", ...(notebook ? { notebook } : {}),
  };
}

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-hooks-"));
try {
  const repo = join(workspace, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "README.md"), "# Alpha\n\nBefore.\n");
  writeFileSync(join(repo, "large.md"), "x".repeat(500));
  git(repo, ["add", "README.md", "large.md"]);
  git(repo, ["commit", "-qm", "initial"]);

  const legacyRegistry = emptyProjectRegistry();
  legacyRegistry.projects.alpha = project(repo);
  const legacyRegistryPath = join(workspace, "legacy-registry.yaml");
  saveProjectRegistry(legacyRegistry, legacyRegistryPath);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ name: "Alpha", slug: "alpha", repo_path: repo })}\n`);
  const legacyState = join(workspace, "legacy-state");
  const legacyModule = new NotebookModule({ registryPath: legacyRegistryPath, stateRoot: legacyState, env: { HOME: join(workspace, "legacy-home") } });
  const payload = { session_id: "legacy-session", cwd: repo, client_name: "claude-code" };
  assert.equal((await runSessionStartHook(legacyModule, { ...payload, hook_event_name: "SessionStart" })).outcome, "skipped");
  assert.equal(runSessionCloseHook(legacyModule, { ...payload, hook_event_name: "SessionEnd" }).outcome, "skipped");
  assert.equal(existsSync(legacyState), false, "undeclared/disabled hooks make zero XDG state writes");

  assert.throws(() => readHookPayload({ stateRoot: legacyState, maxBytes: 16, stdin: JSON.stringify({ cwd: repo, session_id: "too-large" }) }), /ceiling/u);
  const bounded = readHookPayload({ stateRoot: legacyState, maxBytes: 1_024, stdin: JSON.stringify(payload) });
  assert.equal(bounded.payload.session_id, "legacy-session");
  assert.ok(bounded.bytes < 1_024);

  const binding = { state: "linked" as const, notebook_id: "nb-alpha", notebook_name: "Alpha", overview_note_id: "overview-alpha" };
  const registry = emptyProjectRegistry();
  registry.notebook = {
    base_url: "http://127.0.0.1:8502",
    auth: { mode: "none" },
    defaults: { overview_max_chars: 500 },
    limits: { automatic_attempt_limit: 1, note_max_bytes: 700, source_file_max_bytes: 600 },
  };
  registry.projects.alpha = project(repo, binding);
  const registryPath = join(workspace, "registry.yaml");
  saveProjectRegistry(registry, registryPath);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ name: "Alpha", slug: "alpha", repo_path: repo, notebook: { binding, policy: { enabled: true, session_start_enabled: false, session_capture_enabled: true, documentation_globs: ["**/*.md"] } } }, null, 2)}\n`);

  const notes: OpenNotebookNoteV1[] = [];
  let failAfterFirstDispatch = true;
  let forgedUpdates = 0;
  const fakeClient = {
    async listNotes(notebookId: string) { assert.equal(notebookId, "nb-alpha"); return notes.map((item) => ({ ...item })); },
    async createNote(notebookId: string, input: { title: string; content: string; note_type?: string }, latch?: () => void) {
      assert.equal(notebookId, "nb-alpha");
      latch?.();
      const note = { id: `note-${notes.length + 1}`, title: input.title, content: input.content, note_type: input.note_type ?? "human", created_at: "2026-08-19T12:00:00.000Z", updated_at: "2026-08-19T12:00:00.000Z" };
      notes.push(note);
      if (failAfterFirstDispatch) { failAfterFirstDispatch = false; throw new NotebookError("TIMEOUT", "ambiguous create timeout", true); }
      return { ...note };
    },
    async updateOwnedNote(_notebookId: string, noteId: string, input: { title?: string; content?: string }) {
      const note = notes.find((item) => item.id === noteId);
      if (!note) throw new NotebookError("NOT_FOUND", "missing");
      forgedUpdates += 1;
      Object.assign(note, input, { updated_at: "2026-08-19T12:00:01.000Z" });
      return { ...note };
    },
  };
  const stateRoot = join(workspace, "state");
  const module = new NotebookModule({ registryPath, stateRoot, env: { HOME: join(workspace, "home") }, clientFactory: () => fakeClient as never });
  const sessionPayload = { session_id: "capture-session", cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" };
  const started = await runSessionStartHook(module, sessionPayload, { now: () => new Date("2026-08-19T12:00:00.000Z"), spawnWorker() {} });
  assert.equal(started.outcome, "primed");
  writeFileSync(join(repo, "README.md"), "# Alpha\n\nAfter capture.\n");
  writeFileSync(join(repo, "large.md"), "y".repeat(500));
  const spawned: string[] = [];
  const closed = runSessionCloseHook(module, { ...sessionPayload, hook_event_name: "SessionEnd" }, { now: () => new Date("2026-08-19T12:00:01.000Z"), spawnWorker(id) { spawned.push(id); } });
  assert.equal(closed.outcome, "captured");
  assert.deepEqual(spawned, closed.receiptId ? [closed.receiptId] : []);
  if (!closed.receiptId) throw new Error("capture fixture has no receipt");
  const firstRun = await runCaptureWorker(module, "alpha", closed.receiptId);
  assert.equal(firstRun.receipt.state, "retry-exhausted", "ambiguous post-dispatch failure remains durable and bounded");
  const pending = listRemoteMutationJournals(stateRoot, "alpha");
  assert.equal(pending[0]?.state, "possibly-dispatched");
  assert.equal(pending[0]?.binding_id, "nb-alpha");
  const retried = await module.captureRetry(repo, closed.receiptId);
  assert.equal(retried.data.receipt.state, "succeeded");
  assert.equal(retried.data.receipt.summary_mode, "deterministic-fallback");
  assert.ok(retried.data.receipt.remote_note_ids.length >= 2);
  assert.ok((retried.data.receipt.exclusion_counts["note-envelope-oversize"] ?? 0) >= 1, "a source-eligible document that cannot fit final note+envelope is excluded without failing the receipt");
  assert.equal(listRemoteMutationJournals(stateRoot, "alpha").every((item) => item.state === "committed"), true, "receipt durability finalizes every recovered create journal");
  assert.equal(notes.filter((item) => item.title === "README.md").length, 1, "ambiguous create reconciliation does not POST a duplicate");

  const foreignLogicalId = "a".repeat(64);
  const foreignEnvelope: PjanglerNoteEnvelopeV1 = { schema_version: 1, project_slug: "other", kind: "document", logical_id: foreignLogicalId, source_path: "README.md", source_revision: "a".repeat(40), content_sha256: "b".repeat(64), session_key: "c".repeat(64), captured_at: "2026-08-19T12:00:00.000Z", policy_version: NOTEBOOK_POLICY_VERSION };
  notes.push({ id: "forged", title: "README.md", content: withNoteEnvelope(foreignEnvelope, "forged"), note_type: "human", created_at: null, updated_at: null });
  const desiredEnvelope = { ...foreignEnvelope, project_slug: "alpha" };
  await assert.rejects(() => reconcileManagedNote({ stateRoot: join(workspace, "forged-state"), projectSlug: "alpha", notebookId: "nb-alpha", logicalId: foreignLogicalId, title: "README.md", content: withNoteEnvelope(desiredEnvelope, "owned"), client: fakeClient as never }), (error: unknown) => error instanceof NotebookError && error.code === "CONFLICT");
  assert.equal(forgedUpdates, 0, "a forged/foreign envelope is never overwritten through an existing-note fast path");

  const summaryConfig = module.context(repo, false).config;
  const invalidSummarizer: EffectiveNotebookConfigV1 = { ...summaryConfig, summarizer: { executable: "/bin/sh", args: ["-c", "printf '%s' '{\"schema_version\":1,\"claims\":[{\"text\":\"production deployed\",\"evidence_ids\":[\"doc-001\"]}]}'"] }, limits: { ...summaryConfig.limits, note_max_bytes: 700 } };
  const summary = summarizeCapture(invalidSummarizer, { documents: [{ path: "hostile\n```path.md", content: "bounded documentation evidence", content_sha256: "d".repeat(64), source_revision: "e".repeat(40) }], changedPaths: Array.from({ length: 200 }, (_, index) => `path-${index}\n.md`), exclusions: { "pre-existing-dirty": 2 }, endRevision: "e".repeat(40), endStatusDigest: "f".repeat(64), baselineRef: "a".repeat(40) });
  assert.equal(summary.mode, "deterministic-fallback", "unsupported or invalid cited claims use deterministic fallback");
  assert.ok(Buffer.byteLength(summary.summary, "utf8") <= 700, "fallback is bounded by note_max_bytes");
  assert.doesNotMatch(summary.summary, /hostile\n```/u, "hostile path control characters are escaped in Markdown evidence");

  const persisted = listCaptureReceipts(stateRoot, "alpha", module.context(repo, false).config.limits);
  assert.equal(persisted[0]?.summary_mode, "deterministic-fallback");
  const succeeded = persisted.find((item) => item.state === "succeeded");
  assert.ok(succeeded);
  const ownedLogicalId = succeeded.note_logical_ids[0]!;
  const ownedRemoteId = succeeded.remote_note_ids[0]!;
  let crashJournal = prepareRemoteMutation({
    root: stateRoot,
    projectSlug: "alpha",
    kind: "note.create",
    logicalMarker: ownedLogicalId,
    inputDigest: mutationInputDigest({ crash: "after-receipt-success", logical_id: ownedLogicalId }),
    sessionKey: succeeded.session_key,
    bindingId: "nb-alpha",
  });
  crashJournal = transitionRemoteMutation({ root: stateRoot, journal: crashJournal, state: "possibly-dispatched" });
  crashJournal = transitionRemoteMutation({ root: stateRoot, journal: crashJournal, state: "reconciled", candidateIds: [ownedRemoteId] });
  const crashAudit = await module.audit(repo, true);
  assert.equal(Object.hasOwn(crashAudit.data.capture_admission, "unresolved_journals"), false, "public CaptureAdmissionSummaryV1 retains its exact ten-field schema");
  const captureFinding = crashAudit.data.rules.find((item) => item.id === "notebook.capture-receipts");
  assert.equal(captureFinding?.status, "warn");
  assert.equal(captureFinding?.fixable, true, "receipt-proven reconciled journal recovery is selected as an owned local repair");
  const migrated = await migrateNotebook(module, repo, { apply: true, live: false });
  assert.equal(migrated.results.find((item) => item.id === "notebook.capture-receipts")?.status, "applied");
  assert.equal(listRemoteMutationJournals(stateRoot, "alpha").find((item) => item.operation_id === crashJournal.operation_id)?.state, "committed", "local migration finalizes only the journal proved by succeeded receipt logical and remote IDs");

  // Story 5.7 release evidence: a deterministic staged canary of at least 20
  // real receipt lifecycles, including changed docs, no-op fallback, the
  // ambiguous retry/restart above, and a verification/adapter failure below.
  registry.notebook = { ...registry.notebook, limits: { ...(registry.notebook?.limits ?? {}), note_max_bytes: 4_096 } };
  saveProjectRegistry(registry, registryPath);
  const startDurations: number[] = [];
  const endDurations: number[] = [];
  for (let index = 0; index < 19; index++) {
    const canaryPayload = { session_id: `canary-${String(index).padStart(2, "0")}`, cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" };
    const startAt = performance.now();
    const canaryStart = await runSessionStartHook(module, canaryPayload, { now: () => new Date(`2026-08-19T13:${String(index).padStart(2, "0")}:00.000Z`), spawnWorker() {} });
    startDurations.push(performance.now() - startAt);
    assert.equal(canaryStart.outcome, "primed");
    if (index % 3 !== 0) writeFileSync(join(repo, "README.md"), `# Alpha\n\nCanary change ${index}.\n`);
    const endAt = performance.now();
    const canaryClose = runSessionCloseHook(module, { ...canaryPayload, hook_event_name: "SessionEnd" }, { now: () => new Date(`2026-08-19T13:${String(index).padStart(2, "0")}:01.000Z`), spawnWorker() {} });
    endDurations.push(performance.now() - endAt);
    assert.equal(canaryClose.outcome, "captured");
    assert.ok(canaryClose.receiptId);
    const canaryWorker = await runCaptureWorker(module, "alpha", canaryClose.receiptId!);
    assert.equal(canaryWorker.receipt.state, "succeeded");
    assert.equal(canaryWorker.receipt.summary_mode, "deterministic-fallback");
  }

  const failurePayload = { session_id: "canary-failed-verification", cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" };
  assert.equal((await runSessionStartHook(module, failurePayload, { now: () => new Date("2026-08-19T14:00:00.000Z"), spawnWorker() {} })).outcome, "primed");
  const failureClose = runSessionCloseHook(module, { ...failurePayload, hook_event_name: "SessionEnd" }, { now: () => new Date("2026-08-19T14:00:01.000Z"), spawnWorker() {} });
  assert.ok(failureClose.receiptId);
  const hostileUnknown = ["/private/runtime/path", "password", "fixture-value"].join(":");
  const failedVerificationModule = new NotebookModule({ registryPath, stateRoot, env: { HOME: join(workspace, "home") }, clientFactory: () => ({ async listNotes() { throw new Error(hostileUnknown); } }) as never });
  const failedVerification = await runCaptureWorker(failedVerificationModule, "alpha", failureClose.receiptId!);
  assert.equal(failedVerification.receipt.state, "retry-exhausted");
  assert.equal(failedVerification.receipt.error_category, "INTERNAL_ERROR");
  assert.equal(failedVerification.receipt.diagnostic, "Project Notebook encountered an unexpected internal error");
  assert.doesNotMatch(failedVerification.receipt.diagnostic ?? "", /private|password|fixture-value/u, "unknown adapter errors never enter durable receipt diagnostics");

  const canaryReceipts = listCaptureReceipts(stateRoot, "alpha", module.context(repo, false).config.limits);
  assert.ok(canaryReceipts.length >= 21, `expected at least 21 staged receipts, got ${canaryReceipts.length}`);
  const succeededCanaries = canaryReceipts.filter((item) => item.state === "succeeded");
  assert.ok(succeededCanaries.length >= 20, `expected at least 20 successful/retried canary receipts, got ${succeededCanaries.length}`);
  let factualClaims = 0;
  let traceableClaims = 0;
  for (const receipt of succeededCanaries) {
    assert.match(receipt.session_key, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.note_logical_ids.length, receipt.remote_note_ids.length);
    const sessionIndex = receipt.note_logical_ids.indexOf(receipt.logical_id);
    assert.ok(sessionIndex >= 0, "every succeeded receipt owns its stable Session Capture logical ID");
    const sessionNote = notes.find((item) => item.id === receipt.remote_note_ids[sessionIndex]);
    assert.ok(sessionNote, "every succeeded receipt records a resolvable Session Capture note ID");
    const parsed = parseNoteEnvelope(sessionNote!.content);
    assert.equal(parsed?.envelope.kind, "session-capture");
    assert.equal(parsed?.envelope.session_key, receipt.session_key);
    assert.equal(parsed?.envelope.captured_at, receipt.created_at);
    assert.equal(parsed?.envelope.content_sha256, sha256Hex(parsed?.body ?? ""));
    assert.doesNotMatch(parsed?.body ?? "", /(?:deployed successfully|production is healthy|released successfully)/iu, "capture summaries make no unsupported deployment or success claim");
    for (const line of (parsed?.body ?? "").split("\n")) {
      if (!line.startsWith("- ") || /None |unavailable|Insufficient/u.test(line)) continue;
      factualClaims += 1;
      if (/\b[a-f0-9]{40,64}\b/u.test(line) || /: \d+$/u.test(line) || /^- ".*"/u.test(line)) traceableClaims += 1;
    }
  }
  assert.ok(factualClaims > 0);
  assert.ok(traceableClaims / factualClaims >= 0.95, `expected >=95% traceable fallback claims, got ${traceableClaims}/${factualClaims}`);
  const percentile95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity;
  assert.ok(percentile95(startDurations) < 2_000, `SessionStart p95 ${percentile95(startDurations)}ms exceeded 2s`);
  assert.ok(percentile95(endDurations) < 250, `SessionEnd p95 ${percentile95(endDurations)}ms exceeded 250ms`);

  // A shared monotonic SessionStart deadline covers Git snapshotting and the
  // remote Overview request. The fetch observes the abort signal; no dangling
  // Promise.race continues after the hook fails open.
  registry.notebook = { ...registry.notebook, limits: { ...(registry.notebook?.limits ?? {}), hook_session_start_timeout_ms: 500 } };
  saveProjectRegistry(registry, registryPath);
  const manifest = JSON.parse(readFileSync(join(repo, ".project.json"), "utf8")) as Record<string, any>;
  manifest.notebook.policy = { ...manifest.notebook.policy, session_start_enabled: true, session_capture_enabled: false };
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const slowModule = new NotebookModule({
    registryPath,
    stateRoot: join(workspace, "slow-state"),
    env: { HOME: join(workspace, "slow-home") },
    fetch: async (_request, init = {}) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const slowDurations: number[] = [];
  for (let index = 0; index < 5; index++) {
    const slowAt = performance.now();
    const slowResult = await runSessionStartHook(slowModule, { session_id: `slow-${index}`, cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" });
    slowDurations.push(performance.now() - slowAt);
    assert.equal(slowResult.outcome, "failed-open");
    assert.match(slowResult.stderr, /timed out|unavailable|budget/u);
  }
  assert.ok(percentile95(slowDurations) < 500, `aborting slow SessionStart p95 ${percentile95(slowDurations)}ms exceeded its configured 500ms budget`);
  console.log("pjan-77 notebook hooks/capture: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
