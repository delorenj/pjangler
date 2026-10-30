import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
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
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: hermeticEnv() });
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
  // PJAN-194: each hook call is measured against the clock and against the
  // scheduler. Wall clock (performance.now) is what the operator waits for, but
  // it also includes every moment the kernel spent running someone else. The
  // kernel says which part that was: /proc/self/schedstat holds, for this
  // thread, the time spent on a CPU and the time spent RUNNABLE BUT WAITING for
  // one (run_delay). So wall = on-CPU + queued behind other work + blocked
  // (sleeping, fsync, lock or child-process waits). A busy neighbour only adds
  // to the queued part; the hook's own work is the other two. process.cpuUsage
  // (user+system of this process) is the on-CPU part for the whole process. See
  // the budget assertions below for how each is used.
  interface Mark { at: number; cpu: NodeJS.CpuUsage; sched: { onCpuMs: number; queuedMs: number } | null }
  interface Span { wallMs: number; cpuMs: number; blockedMs: number | null }
  const readSched = (): Mark["sched"] => {
    try {
      const [onCpuNs, queuedNs] = readFileSync("/proc/self/schedstat", "utf8").trim().split(/\s+/u).map(Number);
      return Number.isFinite(onCpuNs) && Number.isFinite(queuedNs) ? { onCpuMs: onCpuNs! / 1e6, queuedMs: queuedNs! / 1e6 } : null;
    } catch { return null; } // not Linux, or no CONFIG_SCHED_INFO: the blocked-time checks are skipped, loudly
  };
  const mark = (): Mark => ({ at: performance.now(), cpu: process.cpuUsage(), sched: readSched() });
  const spanBetween = (from: Mark, to: Mark): Span => {
    const wallMs = to.at - from.at;
    const used = process.cpuUsage(from.cpu);
    const blockedMs = from.sched && to.sched ? Math.max(0, wallMs - (to.sched.onCpuMs - from.sched.onCpuMs) - (to.sched.queuedMs - from.sched.queuedMs)) : null;
    return { wallMs, cpuMs: (used.user + used.system) / 1_000, blockedMs };
  };
  const startSpans: Span[] = [];
  const endSpans: Span[] = [];
  for (let index = 0; index < 19; index++) {
    const canaryPayload = { session_id: `canary-${String(index).padStart(2, "0")}`, cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" };
    const startFrom = mark();
    const canaryStart = await runSessionStartHook(module, canaryPayload, { now: () => new Date(`2026-08-19T13:${String(index).padStart(2, "0")}:00.000Z`), spawnWorker() {} });
    startSpans.push(spanBetween(startFrom, mark()));
    assert.equal(canaryStart.outcome, "primed");
    if (index % 3 !== 0) writeFileSync(join(repo, "README.md"), `# Alpha\n\nCanary change ${index}.\n`);
    const endFrom = mark();
    const canaryClose = runSessionCloseHook(module, { ...canaryPayload, hook_event_name: "SessionEnd" }, { now: () => new Date(`2026-08-19T13:${String(index).padStart(2, "0")}:01.000Z`), spawnWorker() {} });
    endSpans.push(spanBetween(endFrom, mark()));
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
  const fastest = (values: number[]): number => Math.min(...values);
  // The budgets are the product's promises, not regression-sensitivity gauges:
  // 2000ms and 250ms (hook_session_end_timeout_ms) are what the hook may take,
  // so a change that stays inside them is not a violation, and none is made here.
  const SLOW_CALL_ALLOWANCE = 3; // of 19: a stalled disk may hit a few calls; a regression hits many
  // PJAN-194: the foreground budgets promise that the hook's WORK is small. A p95
  // of wall-clock readings cannot test that on a machine that is also doing other
  // things: the reading is work plus whatever the scheduler took away, and the
  // tail of 19 samples is exactly where the scheduler shows up (PJAN-132 widened
  // it on CI; a heavy local run then broke it at 538.9ms). Three measures that
  // load cannot inflate replace it, with the budgets themselves unchanged and no
  // CI-dependent slack. Each covers what the others cannot:
  //  - CPU time p95: the work the hook did, tail included. A regression that
  //    burns CPU, in every call or only in some, is over budget however idle or
  //    busy the machine is.
  //  - Wall-clock FASTEST sample: load only ever adds waiting, so the best of 19
  //    is an upper bound on the hook's unloaded latency. It catches work that
  //    every call does but CPU time cannot see or a starved process undercounts
  //    (a spin on the wall clock gets a fraction of a core when contended).
  //  - BLOCKED time (wall minus on-CPU minus queued-for-a-CPU, from the kernel's
  //    scheduler accounting): sleeping, fsync, lock and child-process waits,
  //    which contention does not create. More than SLOW_CALL_ALLOWANCE of 19
  //    calls blocked past the budget is a regression that hits SOME calls, which
  //    neither of the above sees (the fastest sample is clean, CPU is idle).
  for (const [name, spans, budgetMs] of [["SessionStart", startSpans, 2_000], ["SessionEnd", endSpans, 250]] as const) {
    assert.ok(percentile95(spans.map((span) => span.cpuMs)) < budgetMs, `${name} CPU p95 ${percentile95(spans.map((span) => span.cpuMs))}ms exceeded ${budgetMs}ms`);
    assert.ok(fastest(spans.map((span) => span.wallMs)) < budgetMs, `${name} fastest of ${spans.length} calls took ${fastest(spans.map((span) => span.wallMs))}ms, over the ${budgetMs}ms budget: every call is slow, not just a loaded one`);
    if (spans.some((span) => span.blockedMs === null)) { console.log(`pjan-77 notebook hooks/capture: ${name} blocked-time check skipped (no /proc/self/schedstat)`); continue; }
    const blocked = spans.map((span) => span.blockedMs!);
    const overBudget = blocked.filter((value) => value > budgetMs);
    assert.ok(overBudget.length <= SLOW_CALL_ALLOWANCE, `${name}: ${overBudget.length} of ${spans.length} calls spent more than ${budgetMs}ms blocked (sleeping, fsync, lock or child waits: ${overBudget.map((value) => Math.round(value)).join(",")}ms), allowed ${SLOW_CALL_ALLOWANCE}; the CPU was idle and a neighbour cannot cause this`);
  }

  // A shared monotonic SessionStart deadline covers Git snapshotting and the
  // remote Overview request. The fetch observes the abort signal; no dangling
  // Promise.race continues after the hook fails open.
  //
  // PJAN-194: this used to compare the TEST's wall-clock view of the call with
  // the 500ms the hook enforces on itself. The hook aborts at hookStart + 475ms
  // (budget minus a 25ms safety margin), so the assertion left 25ms for
  // everything the kernel might do to the process, and failed at 538.9ms under
  // load although the abort was armed correctly. What the hook promises is WHEN
  // it arms and delivers the abort, and that can be checked without asking the
  // clock how long the machine took:
  //  1. Early bound: the abort is never delivered before the hook's own
  //     deadline minus its largest safety margin, so the hook cannot give up
  //     early. A late scheduler only ever moves an event later, never earlier.
  //  2. Late bound by ORDER, not by duration: a control timer is armed from the
  //     test at (first context() call + budget - 10ms). The real abort timer
  //     must fire before it, and the signal must already be aborted when the
  //     control timer runs. Timers fire in order of their due times however
  //     late the process runs, so a starved process reorders nothing, while an
  //     abort armed late (2x late, a deadline restarted after Git, a request
  //     that falls back to overall_timeout_ms) is due after the control and
  //     loses the race.
  //  3. Every Git child is bounded by the SAME deadline: the timeout handed to
  //     each `git` spawn is observed (real spawnSync, only watched) and must
  //     fit inside the hook budget, which a snapshot taken without the shared
  //     deadline (the 5000ms default) cannot.
  //  4. The abort reaches the fetch as an AbortSignal, the request is torn down
  //     (no Timeout resource left behind by the call) and the hook returns.
  //  5. The hook RETURNS promptly once the abort lands (the old p95 < 500 also
  //     guarded this: a hook that slept or spun 300ms in its failure path
  //     returned at 775ms). From the abort to the return is microtasks, about
  //     0.2ms idle, and is measured from the abort ITSELF, not from the start of
  //     the call, so lateness of the abort cannot count against it. Same three
  //     measures as the canary: CPU, fastest sample, blocked time.
  const SLOW_BUDGET_MS = 500;
  const MAX_SAFETY_MARGIN_MS = 50; // hooks.ts: Math.min(50, ...)
  const CONTROL_LEAD_MS = 10;
  const TIMER_ROUNDING_MS = 3; // libuv timers are whole milliseconds and may fire 1ms early
  const RETURN_AFTER_ABORT_MS = 100; // idle is ~0.2ms; this is a "returns promptly" bound, not a latency target
  const WATCHDOG_MS = 4_000; // only a hung hook (abort never delivered) gets here; not a latency assertion
  registry.notebook = { ...registry.notebook, limits: { ...(registry.notebook?.limits ?? {}), hook_session_start_timeout_ms: SLOW_BUDGET_MS } };
  saveProjectRegistry(registry, registryPath);
  const manifest = JSON.parse(readFileSync(join(repo, ".project.json"), "utf8")) as Record<string, any>;
  manifest.notebook.policy = { ...manifest.notebook.policy, session_start_enabled: true, session_capture_enabled: false };
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  interface SlowCall {
    testStart: number;
    contextAt: number | null;
    fetchAt: number | null;
    signal: AbortSignal | null;
    abortAt: number | null;
    abortMark?: Mark;
    returnMark?: Mark;
    controlAt: number | null;
    abortedWhenControlRan: boolean | null;
    controlTimer?: NodeJS.Timeout;
    controlRan?: Promise<void>;
  }
  let call: SlowCall | null = null;
  const slowModule = new NotebookModule({
    registryPath,
    stateRoot: join(workspace, "slow-state"),
    env: { HOME: join(workspace, "slow-home") },
    fetch: async (_request, init = {}) => {
      const current = call!;
      current.fetchAt = performance.now();
      const signal = init.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("dispatched without an AbortSignal");
      current.signal = signal;
      const controlDue = current.contextAt! + SLOW_BUDGET_MS - CONTROL_LEAD_MS;
      current.controlRan = new Promise<void>((resolve) => {
        current.controlTimer = setTimeout(() => {
          current.controlAt = performance.now();
          current.abortedWhenControlRan = signal.aborted;
          resolve();
        }, Math.max(1, Math.ceil(controlDue - current.fetchAt!)));
      });
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          current.abortMark = mark();
          current.abortAt = current.abortMark.at;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const realContext = slowModule.context.bind(slowModule);
  (slowModule as { context: unknown }).context = (...args: Parameters<typeof realContext>) => {
    if (call && call.contextAt === null) call.contextAt = performance.now();
    return realContext(...args);
  };
  // Watch, never replace, the Git children: the real spawnSync still runs.
  const realSpawnSync = childProcess.spawnSync;
  let gitTimeouts: number[] = [];
  (childProcess as { spawnSync: unknown }).spawnSync = ((command: string, args: readonly string[] = [], options: { timeout?: number } = {}) => {
    if (command === "git" && call) gitTimeouts.push(options.timeout ?? Number.POSITIVE_INFINITY);
    // The same real git with the same arguments and limits; only the env is the
    // suite's hermetic one (PJAN-193) instead of whatever the process holds.
    return realSpawnSync(command, args, { ...options, env: hermeticEnv() });
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  let dispatched = 0;
  const afterAbort: Span[] = [];
  try {
    for (let index = 0; index < 5; index++) {
      const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
      gitTimeouts = [];
      const current: SlowCall = { testStart: 0, contextAt: null, fetchAt: null, signal: null, abortAt: null, controlAt: null, abortedWhenControlRan: null };
      call = current;
      let watchdog: NodeJS.Timeout | undefined;
      current.testStart = performance.now();
      const slowResult = await Promise.race([
        runSessionStartHook(slowModule, { session_id: `slow-${index}`, cwd: repo, client_name: "claude-code", hook_event_name: "SessionStart" }),
        new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`slow-${index}: the SessionStart hook was still running ${WATCHDOG_MS}ms after it started: its ${SLOW_BUDGET_MS}ms deadline never aborted the Overview request (not armed, not delivered to the fetch, or armed for a much later time)`)), WATCHDOG_MS); }),
      ]).finally(() => { clearTimeout(watchdog); });
      current.returnMark = mark();
      const returnedAt = current.returnMark.at;
      // The control timer is the test's, not the hook's: once the hook is back,
      // let it run (if it has not) and clear it before counting what is left.
      await current.controlRan;
      clearTimeout(current.controlTimer);
      call = null;
      assert.ok(current.fetchAt === null || current.signal, `slow-${index}: the Overview request was dispatched without an AbortSignal, so nothing can stop it at the deadline`);
      assert.equal(slowResult.outcome, "failed-open");
      assert.match(slowResult.stderr, /timed out|unavailable|budget/u);
      // Whatever the path (aborted request, or the budget already spent by the
      // time the request was due), the hook must not fail open before its own
      // deadline: nothing failed, it was only slow.
      assert.ok(returnedAt - current.testStart >= SLOW_BUDGET_MS - MAX_SAFETY_MARGIN_MS - TIMER_ROUNDING_MS, `slow-${index}: the hook failed open ${returnedAt - current.testStart}ms after it started, before its ${SLOW_BUDGET_MS}ms budget was spent`);
      assert.ok(gitTimeouts.every((timeout) => timeout <= SLOW_BUDGET_MS - CONTROL_LEAD_MS), `slow-${index}: a Git child was given ${gitTimeouts.join(",")}ms, more than the hook's shared ${SLOW_BUDGET_MS}ms deadline allows`);
      assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, timersBefore, `slow-${index}: the hook left a timer running after it failed open`);
      if (current.fetchAt === null) continue; // the budget was spent before the request was due; nothing left to abort
      dispatched += 1;
      assert.ok(current.signal && current.abortAt !== null, `slow-${index}: the Overview request never received an abort`);
      assert.ok(gitTimeouts.length > 0, `slow-${index}: no Git snapshot ran under the hook deadline`);
      assert.ok(current.abortAt - current.testStart >= SLOW_BUDGET_MS - MAX_SAFETY_MARGIN_MS - TIMER_ROUNDING_MS, `slow-${index}: the abort was delivered ${current.abortAt - current.testStart}ms after the hook started, before its deadline`);
      afterAbort.push(spanBetween(current.abortMark!, current.returnMark));
      assert.equal(current.abortedWhenControlRan, true, `slow-${index}: the abort was not delivered before a timer due at ${SLOW_BUDGET_MS - CONTROL_LEAD_MS}ms: it is armed later than the hook's shared deadline`);
    }
  } finally {
    (childProcess as { spawnSync: unknown }).spawnSync = realSpawnSync;
    syncBuiltinESMExports();
  }
  // A starved machine can spend the whole budget before the request is due, and
  // the hook then (correctly) fails open without dispatching. If that happened
  // five times in a row nothing here was exercised: say so instead of passing.
  assert.ok(dispatched > 0, "inconclusive: the machine was too slow for any slow SessionStart to reach its Overview request inside the budget");
  // The hook fails open promptly after its abort (property 5 above).
  assert.ok(Math.max(...afterAbort.map((span) => span.cpuMs)) < RETURN_AFTER_ABORT_MS, `after the abort the hook burned ${Math.max(...afterAbort.map((span) => span.cpuMs))}ms of CPU before returning (limit ${RETURN_AFTER_ABORT_MS}ms): its failure path does real work`);
  assert.ok(fastest(afterAbort.map((span) => span.wallMs)) < RETURN_AFTER_ABORT_MS, `after the abort even the fastest of ${afterAbort.length} calls took ${fastest(afterAbort.map((span) => span.wallMs))}ms to return (limit ${RETURN_AFTER_ABORT_MS}ms): the hook does not fail open promptly`);
  if (afterAbort.every((span) => span.blockedMs !== null)) {
    const slowToReturn = afterAbort.filter((span) => span.blockedMs! > RETURN_AFTER_ABORT_MS);
    assert.ok(slowToReturn.length <= 1, `after the abort ${slowToReturn.length} of ${afterAbort.length} calls spent more than ${RETURN_AFTER_ABORT_MS}ms blocked before returning (${slowToReturn.map((span) => Math.round(span.blockedMs!)).join(",")}ms), allowed 1`);
  } else console.log("pjan-77 notebook hooks/capture: post-abort blocked-time check skipped (no /proc/self/schedstat)");
  console.log("pjan-77 notebook hooks/capture: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
