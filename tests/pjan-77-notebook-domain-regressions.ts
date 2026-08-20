import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProjectRegistry, saveProjectRegistry, type ProjectRecord } from "../src/project/index";
import { resolveEffectiveNotebookConfig, resolveNotebookLimits, validateNotebookAuth, validateNotebookBaseUrl } from "../src/notebook/config";
import { sessionCaptureLogicalId, sha256Hex } from "../src/notebook/notes";
import {
  admitCaptureReceipt,
  atomicWriteJson,
  authorizeCaptureRetry,
  captureAdmissionSummary,
  captureReceiptVersion,
  claimCaptureReceipt,
  createOverviewClaim,
  createSessionBaseline,
  currentRetentionPressure,
  deriveReceiptId,
  deriveSessionKey,
  ensureNotebookState,
  pruneNotebookState,
  readOverviewClaim,
  readSessionBaseline,
  transitionCaptureReceipt,
} from "../src/notebook/state";
import { DEFAULT_NOTEBOOK_LIMITS, NOTEBOOK_POLICY_VERSION, NotebookError } from "../src/notebook/types";

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-domain-"));
try {
  const repo = join(workspace, "repo");
  const stateRoot = join(workspace, "state", "pjangler", "notebook", "v1");
  mkdirSync(repo, { recursive: true });
  const project: ProjectRecord = {
    name: "Legacy",
    slug: "legacy",
    repo_path: repo,
    description: "",
    status: "active",
    source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "LEG", board_id: "", state: "planned" },
    agents: {},
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
  };
  const registry = emptyProjectRegistry();
  registry.projects.legacy = project;
  const registryPath = join(workspace, "registry.yaml");
  saveProjectRegistry(registry, registryPath);
  const disabled = resolveEffectiveNotebookConfig({ registry, project, manifest: null, registry_path: registryPath });
  assert.equal(disabled.binding.state, "disabled", "an undeclared legacy project is disabled, never implicitly planned");
  assert.equal(disabled.policy.enabled, false, "global defaults cannot silently enable an undeclared legacy project");

  assert.equal(validateNotebookBaseUrl("http://127.0.0.1:8502"), "http://127.0.0.1:8502");
  assert.equal(validateNotebookBaseUrl("https://notebook.example.test"), "https://notebook.example.test");
  for (const unsafe of ["http://notebook.example.test", "https://203.0.113.20", "https://[2001:db8::1]"]) {
    assert.throws(() => validateNotebookBaseUrl(unsafe), (error: unknown) => error instanceof NotebookError && error.code === "NOT_CONFIGURED");
  }
  assert.deepEqual(validateNotebookAuth({ mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" }), { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" });
  assert.throws(() => validateNotebookAuth({ mode: "environment", env_var: "OTHER_SAFE_NAME" }), (error: unknown) => error instanceof NotebookError && error.code === "NOT_CONFIGURED");
  assert.equal(resolveNotebookLimits({ note_detail_fetch_concurrency: 2 }).note_detail_fetch_concurrency, 2);
  assert.throws(() => resolveNotebookLimits({ note_detail_fetch_concurrency: DEFAULT_NOTEBOOK_LIMITS.note_detail_fetch_concurrency + 1 }), (error: unknown) => error instanceof NotebookError && error.code === "NOT_CONFIGURED", "detail hydration fanout may tighten but never exceed the packaged ceiling");

  const sessionKey = deriveSessionKey("alpha", "claude-code", "raw-session-id");
  assert.equal(sessionKey, sha256Hex("pjangler-session-v1\0alpha\0claude-code\0raw-session-id"));
  assert.equal(deriveReceiptId(sessionKey), sha256Hex(`pjangler-receipt-v1\0${sessionKey}`));
  assert.doesNotMatch(sessionKey, /raw-session-id/u);

  const limits = {
    ...DEFAULT_NOTEBOOK_LIMITS,
    unresolved_receipt_max_count: 1,
    unresolved_receipt_max_bytes: 1_000_000,
    receiptless_session_retention_seconds: 10,
    receipt_succeeded_retention_days: 1,
  };
  const start = new Date("2026-08-19T12:00:00.000Z");
  const baseline = (key: string, created = start.toISOString()) => createSessionBaseline(stateRoot, {
    session_key: key,
    project_slug: "alpha",
    client: "claude-code",
    created_at: created,
    repo_path: repo,
    git_head: "a".repeat(40),
    git_status_digest: "b".repeat(64),
    policy_version: NOTEBOOK_POLICY_VERSION,
    tracked_path_digests: { "README.md": "c".repeat(64) },
    pre_dirty_paths: ["already-dirty.md"],
    complete: true,
    incomplete_reasons: [],
  });
  baseline(sessionKey);
  const firstClaim = createOverviewClaim(stateRoot, {
    session_key: sessionKey,
    project_slug: "alpha",
    created_at: start.toISOString(),
    overview_note_id: "overview-1",
    content_sha256: "d".repeat(64),
  });
  assert.equal(firstClaim.created, true);
  assert.equal(createOverviewClaim(stateRoot, {
    session_key: sessionKey,
    project_slug: "alpha",
    created_at: start.toISOString(),
    overview_note_id: "overview-1",
    content_sha256: "d".repeat(64),
  }).created, false, "Overview claim is exclusive and once-only");

  const first = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey, endRevision: null, endStatusDigest: null, limits, now: new Date(start.getTime() + 1_000) });
  assert.equal(first.outcome, "admitted");
  const duplicate = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey, endRevision: null, endStatusDigest: null, limits, now: new Date(start.getTime() + 2_000) });
  assert.equal(duplicate.outcome, "deduplicated", "same-session close deduplicates before capacity accounting");

  const secondKey = deriveSessionKey("alpha", "claude-code", "second-session");
  baseline(secondKey);
  const refused = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey: secondKey, endRevision: null, endStatusDigest: null, limits, now: new Date(start.getTime() + 3_000) });
  assert.equal(refused.outcome, "retention-pressure");
  const refusedSummary = captureAdmissionSummary(stateRoot, "alpha", limits, new Date(start.getTime() + 4_000));
  assert.equal(refusedSummary.active_refusals.length, 1);
  assert.equal(currentRetentionPressure(refusedSummary).length, 2, "current cap and real refused candidate both report current pressure");

  if (first.outcome !== "admitted") throw new Error("fixture admission failed");
  const firstClaimed = claimCaptureReceipt({ root: stateRoot, projectSlug: "alpha", receiptId: first.receipt.receipt_id, limits, workerId: "domain-worker", now: new Date(start.getTime() + 4_500) });
  transitionCaptureReceipt({ root: stateRoot, projectSlug: "alpha", receiptId: first.receipt.receipt_id, limits, expected: captureReceiptVersion(firstClaimed), state: "succeeded", summaryMode: "deterministic-fallback", now: new Date(start.getTime() + 5_000) });
  const recovered = captureAdmissionSummary(stateRoot, "alpha", limits, new Date(start.getTime() + 6_000));
  assert.equal(currentRetentionPressure(recovered).length, 0, "historical refusal is not current pressure after usage recovers");
  assert.equal(recovered.active_refusals[0]?.outcome, "capture-refused-history");
  const replay = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey: secondKey, endRevision: null, endStatusDigest: null, limits, now: new Date(start.getTime() + 7_000) });
  assert.equal(replay.outcome, "admitted");
  assert.equal(captureAdmissionSummary(stateRoot, "alpha", limits, new Date(start.getTime() + 8_000)).active_refusals.length, 0, "successful replay removes the refusal marker");

  const equalityKey = deriveSessionKey("alpha", "claude-code", "expiry-equality");
  baseline(equalityKey);
  createOverviewClaim(stateRoot, { session_key: equalityKey, project_slug: "alpha", created_at: start.toISOString(), overview_note_id: "overview-1", content_sha256: "e".repeat(64) });
  const equality = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey: equalityKey, endRevision: null, endStatusDigest: null, limits: { ...limits, unresolved_receipt_max_count: 5 }, now: new Date(start.getTime() + 10_000) });
  assert.equal(equality.outcome, "admitted");
  if (equality.outcome !== "admitted") throw new Error("fixture equality admission failed");
  assert.equal(equality.receipt.baseline_ref, null, "equality is expired and never infers provenance");
  assert.equal(readOverviewClaim(stateRoot, "alpha", equalityKey), null, "expiry prunes the matching unreferenced claim atomically");

  const casKey = deriveSessionKey("cas", "claude-code", "lease-race");
  const casLimits = { ...limits, unresolved_receipt_max_count: 10, automatic_attempt_limit: 3 };
  createSessionBaseline(stateRoot, { session_key: casKey, project_slug: "cas", client: "claude-code", created_at: start.toISOString(), repo_path: repo, git_head: "a".repeat(40), git_status_digest: null, policy_version: NOTEBOOK_POLICY_VERSION, tracked_path_digests: {}, pre_dirty_paths: [], complete: true, incomplete_reasons: [] });
  const casAdmission = admitCaptureReceipt({ root: stateRoot, projectSlug: "cas", repoPath: repo, sessionKey: casKey, endRevision: null, endStatusDigest: null, limits: casLimits, now: start });
  assert.equal(casAdmission.outcome, "admitted");
  if (casAdmission.outcome !== "admitted") throw new Error("CAS fixture admission failed");
  const workerA = claimCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: casAdmission.receipt.receipt_id, limits: casLimits, workerId: "worker-a", now: start });
  const workerB = claimCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: casAdmission.receipt.receipt_id, limits: casLimits, workerId: "worker-b", now: new Date(start.getTime() + casLimits.lease_seconds * 1_000 + 1) });
  assert.throws(() => transitionCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: workerA.receipt_id, limits: casLimits, expected: captureReceiptVersion(workerA), state: "failed" }), /stale worker/u);
  const strandedFailed = transitionCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: workerB.receipt_id, limits: casLimits, expected: captureReceiptVersion(workerB), state: "failed", errorCategory: "TIMEOUT", retryable: true, diagnostic: "retry after timeout", now: new Date(start.getTime() + casLimits.lease_seconds * 1_000 + 2) });
  const restarted = claimCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: strandedFailed.receipt_id, limits: casLimits, workerId: "worker-c", now: new Date(start.getTime() + casLimits.lease_seconds * 1_000 + 3) });
  const exhausted = transitionCaptureReceipt({ root: stateRoot, projectSlug: "cas", receiptId: restarted.receipt_id, limits: casLimits, expected: captureReceiptVersion(restarted), state: "retry-exhausted", errorCategory: "TIMEOUT", retryable: true, diagnostic: "operator retry required" });
  const retried = authorizeCaptureRetry({ root: stateRoot, projectSlug: "cas", receiptId: exhausted.receipt_id, limits: casLimits });
  assert.equal(retried.receipt_id, exhausted.receipt_id, "operator retry reuses the exact receipt");
  assert.throws(() => authorizeCaptureRetry({ root: stateRoot, projectSlug: "cas", receiptId: exhausted.receipt_id, limits: casLimits }), /cannot be retried/u, "one authorization cannot be raced into a loop");

  const lockKey = deriveSessionKey("lock-recovery", "claude-code", "crashed-owner");
  createSessionBaseline(stateRoot, { session_key: lockKey, project_slug: "lock-recovery", client: "claude-code", created_at: start.toISOString(), repo_path: repo, git_head: "a".repeat(40), git_status_digest: null, policy_version: NOTEBOOK_POLICY_VERSION, tracked_path_digests: {}, pre_dirty_paths: [], complete: true, incomplete_reasons: [] });
  const lockPaths = ensureNotebookState(stateRoot, "lock-recovery");
  writeFileSync(join(lockPaths.locks, "admission.lock"), `${JSON.stringify({ schema_version: 1, token: "11111111-1111-4111-8111-111111111111", pid: 999999, acquired_at: start.toISOString(), expires_at: new Date(start.getTime() - 1).toISOString() })}\n`, { mode: 0o600 });
  assert.equal(admitCaptureReceipt({ root: stateRoot, projectSlug: "lock-recovery", repoPath: repo, sessionKey: lockKey, endRevision: null, endStatusDigest: null, limits, now: start }).outcome, "admitted", "a crash-left expired lock is recovered without permanent blockage");

  const journalKey = deriveSessionKey("journal-ref", "claude-code", "kept-baseline");
  createSessionBaseline(stateRoot, { session_key: journalKey, project_slug: "journal-ref", client: "claude-code", created_at: start.toISOString(), repo_path: repo, git_head: "a".repeat(40), git_status_digest: null, policy_version: NOTEBOOK_POLICY_VERSION, tracked_path_digests: {}, pre_dirty_paths: [], complete: true, incomplete_reasons: [] });
  const journalPaths = ensureNotebookState(stateRoot, "journal-ref");
  const operationId = "22222222-2222-4222-8222-222222222222";
  writeFileSync(join(journalPaths.journals, `${operationId}.json`), `${JSON.stringify({ schema_version: 1, operation_id: operationId, project_slug: "journal-ref", kind: "note.create", logical_marker: "capture", input_digest: "f".repeat(64), binding_id: "nb-journal", session_key: journalKey, state: "reconciled", prepared_at: start.toISOString(), updated_at: start.toISOString(), candidate_ids: ["remote-1"], diagnostic: null, result_category: "reconciled-one", next_action: "persist durable binding or note ownership before commit" })}\n`, { mode: 0o600 });
  const journalAdmission = admitCaptureReceipt({ root: stateRoot, projectSlug: "journal-ref", repoPath: repo, sessionKey: journalKey, endRevision: null, endStatusDigest: null, limits, now: new Date(start.getTime() + limits.receiptless_session_retention_seconds * 1_000) });
  assert.equal(journalAdmission.outcome, "admitted");
  assert.equal(readSessionBaseline(stateRoot, "journal-ref", journalKey, limits)?.git_head, "a".repeat(40), "an unresolved mutation journal preserves its baseline at equality expiry");

  const paths = ensureNotebookState(stateRoot, "alpha");
  for (const directory of Object.values(paths)) assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  for (const directory of [paths.baselines, paths.claims, paths.receipts, paths.refusals]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) assert.equal(lstatSync(join(directory, name)).mode & 0o777, 0o600);
  }

  const corrupt = join(paths.receipts, `${"f".repeat(64)}.json`);
  writeFileSync(corrupt, "{not json\n", { mode: 0o600 });
  chmodSync(corrupt, 0o600);
  const integrityKey = deriveSessionKey("alpha", "claude-code", "integrity-session");
  baseline(integrityKey);
  const integrity = admitCaptureReceipt({ root: stateRoot, projectSlug: "alpha", repoPath: repo, sessionKey: integrityKey, endRevision: null, endStatusDigest: null, limits: { ...limits, unresolved_receipt_max_count: 10 }, now: new Date(start.getTime() + 9_000) });
  assert.equal(integrity.outcome, "state-integrity");
  if (integrity.outcome !== "state-integrity") throw new Error("fixture integrity outcome failed");
  assert.equal(integrity.summary.unresolved_count, null);
  assert.ok(integrity.summary.unresolved_count_lower_bound >= 1, "invalid entries count conservatively in the lower bound");
  assert.equal(existsSync(join(paths.refusals, `${integrityKey}.json`)), false, "integrity takes precedence and creates no refusal marker");
  assert.equal(existsSync(join(paths.receipts, `${deriveReceiptId(integrityKey)}.json`)), false, "integrity creates no receipt");

  const unresolvedBefore = readFileSync(join(paths.receipts, `${replay.outcome === "admitted" ? replay.receipt.receipt_id : ""}.json`), "utf8");
  pruneNotebookState(stateRoot, "alpha", limits, new Date(start.getTime() + 3 * 86_400_000));
  assert.equal(readFileSync(join(paths.receipts, `${replay.outcome === "admitted" ? replay.receipt.receipt_id : ""}.json`), "utf8"), unresolvedBefore, "unresolved receipts are never expired or compacted");

  const symlinkRoot = join(workspace, "symlink-state");
  const realRoot = join(workspace, "real-state");
  mkdirSync(realRoot);
  symlinkSync(realRoot, symlinkRoot, "dir");
  assert.throws(() => ensureNotebookState(symlinkRoot, "alpha"), /symlink component/u);

  const racePaths = ensureNotebookState(stateRoot, "descriptor-race");
  const movedRefusals = `${racePaths.refusals}-pinned`;
  const outside = join(workspace, "outside-state-target");
  mkdirSync(outside, { mode: 0o700 });
  const pinnedTarget = join(racePaths.refusals, "probe.json");
  atomicWriteJson(pinnedTarget, { safe: true }, racePaths.root, () => {
    renameSync(racePaths.refusals, movedRefusals);
    symlinkSync(outside, racePaths.refusals, "dir");
  });
  assert.deepEqual(readdirSync(outside), [], "an actual parent rename+symlink swap creates no outside file or temporary");
  unlinkSync(racePaths.refusals);
  renameSync(movedRefusals, racePaths.refusals);
  assert.deepEqual(JSON.parse(readFileSync(pinnedTarget, "utf8")), { safe: true }, "the write lands in the descriptor-pinned original directory");

  const outsideLeaf = join(outside, "outside.json");
  writeFileSync(outsideLeaf, "outside-before\n", { mode: 0o600 });
  const leafTarget = join(racePaths.refusals, "leaf-swap.json");
  assert.throws(() => atomicWriteJson(leafTarget, { unsafe: false }, racePaths.root, () => {
    symlinkSync(outsideLeaf, leafTarget);
  }), /ELOOP|non-regular|symlink/u, "a leaf swap is rejected before any content is written");
  assert.equal(readFileSync(outsideLeaf, "utf8"), "outside-before\n");
  assert.equal(lstatSync(leafTarget).isSymbolicLink(), true, "the suspect leaf is preserved for audit");
  unlinkSync(leafTarget);

  const hostilePaths = ensureNotebookState(stateRoot, "hostile-schema");
  const hostileSession = deriveSessionKey("hostile-schema", "claude-code", "hostile");
  const hostileReceipt = deriveReceiptId(hostileSession);
  const hostileOperation = "33333333-3333-4333-8333-333333333333";
  const hostileEntries = [
    [join(hostilePaths.baselines, `${hostileSession}.json`), { schema_version: 1, session_key: hostileSession, project_slug: "hostile-schema", client: "claude-code", created_at: start.toISOString(), repo_path_digest: "a".repeat(64), git_head: null, git_status_digest: null, policy_version: NOTEBOOK_POLICY_VERSION, tracked_path_digests: {}, pre_dirty_paths: [], complete: "yes", incomplete_reasons: [] }],
    [join(hostilePaths.claims, `${hostileSession}.overview`), { schema_version: 1, session_key: hostileSession, project_slug: "hostile-schema", created_at: start.toISOString(), overview_note_id: ["forged"], content_sha256: "b".repeat(64) }],
    [join(hostilePaths.receipts, `${hostileReceipt}.json`), { schema_version: 1, receipt_id: hostileReceipt, logical_id: sessionCaptureLogicalId(hostileSession), session_key: hostileSession, project_slug: "hostile-schema", serialized_bytes: 1, state: "queued", created_at: start.toISOString(), updated_at: start.toISOString() }],
    [join(hostilePaths.refusals, `${hostileSession}.json`), { schema_version: 1, session_key: hostileSession, baseline_created_at: start.toISOString(), refused_at: start.toISOString(), reason: "count-cap", current_count: -1, current_bytes: 0, candidate_bytes: 1, max_count: 1, max_bytes: 100, next_actions: ["pj notebook capture list .", `pj notebook capture retry ${hostileReceipt} .`] }],
    [join(hostilePaths.journals, `${hostileOperation}.json`), { schema_version: 1, operation_id: hostileOperation, project_slug: "hostile-schema", kind: "note.create", logical_marker: "session-capture:v1:hostile", input_digest: "c".repeat(64), session_key: hostileSession, state: "possibly-dispatched", prepared_at: start.toISOString(), updated_at: start.toISOString(), candidate_ids: ["forged-candidate"], diagnostic: null, result_category: "reconciled-one", next_action: "persist durable binding or note ownership before commit" }],
  ] as const;
  for (const [path, value] of hostileEntries) writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const hostileBefore = hostileEntries.map(([path]) => readFileSync(path, "utf8"));
  const hostileSummary = captureAdmissionSummary(stateRoot, "hostile-schema", limits, start);
  assert.equal(hostileSummary.unresolved_count, null);
  assert.ok(hostileSummary.unmeasurable_entry_count >= hostileEntries.length, "hostile valid JSON is state-integrity, never operational state");
  assert.ok(hostileSummary.integrity_entries.every((entry) => entry.reason === "invalid-schema"));
  pruneNotebookState(stateRoot, "hostile-schema", limits, new Date(start.getTime() + 365 * 86_400_000));
  assert.deepEqual(hostileEntries.map(([path]) => readFileSync(path, "utf8")), hostileBefore, "maintenance preserves every suspect schema entry in place");

  console.log("pjan-77 notebook domain regressions: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
