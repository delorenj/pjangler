import { encodeNoteEnvelope, sha256Hex } from "./notes";
import { selectEligibleDocuments } from "./git-evidence";
import type { NotebookModule } from "./module";
import { reconcileManagedNote } from "./reconcile";
import { commitReconciledRemoteMutation, listRemoteMutationJournals, type RemoteMutationJournalV1 } from "./remote-mutation-journal";
import {
  claimCaptureReceipt,
  captureReceiptVersion,
  readCaptureReceipt,
  readSessionBaseline,
  renewCaptureReceiptLease,
  transitionCaptureReceipt,
} from "./state";
import { summarizeCapture } from "./summarizer";
import {
  NOTEBOOK_POLICY_VERSION,
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  type CaptureReceiptV1,
  type OpenNotebookNoteV1,
  type PjanglerNoteEnvelopeV1,
} from "./types";
import { normalizeNotebookError } from "./output";

export interface CaptureWorkerResultV1 {
  receipt: CaptureReceiptV1;
  processed: boolean;
}

export function safeDocumentTitle(sourcePath: string, maxBytes = 4_096): string {
  const escaped = JSON.stringify(sourcePath.normalize("NFC")).slice(1, -1);
  let used = 0;
  const points: string[] = [];
  for (const point of escaped) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > maxBytes) break;
    points.push(point);
    used += bytes;
  }
  const title = points.join("");
  if (!title || /[\u0000-\u001f\u007f]/u.test(title)) throw new NotebookError("INVALID_INPUT", "Git evidence path could not be rendered as a safe note title");
  return title;
}

export function finalizeSucceededReceiptJournals(module: NotebookModule, receipt: CaptureReceiptV1): string[] {
  if (receipt.state !== "succeeded") return [];
  const local = module.contextBySlug(receipt.project_slug, false);
  const bindingId = local.config.binding.state === "linked" ? local.config.binding.notebook_id : undefined;
  if (!bindingId) return [];
  const ownership = new Map(receipt.note_logical_ids.map((logicalId, index) => [logicalId, receipt.remote_note_ids[index]]));
  const committed: string[] = [];
  for (const journal of listRemoteMutationJournals(module.stateRoot, receipt.project_slug)) {
    if (journal.state !== "reconciled" || journal.kind !== "note.create" || journal.session_key !== receipt.session_key
      || journal.binding_id !== bindingId || journal.candidate_ids.length !== 1
      || ownership.get(journal.logical_marker) !== journal.candidate_ids[0]) continue;
    commitReconciledRemoteMutation(module.stateRoot, journal);
    committed.push(journal.operation_id);
  }
  return committed.sort();
}

function managedContent(envelope: PjanglerNoteEnvelopeV1, body: string, maxBytes: number, truncate: boolean): { content: string; body: string } {
  const marker = `${encodeNoteEnvelope(envelope)}\n`;
  const available = maxBytes - Buffer.byteLength(marker, "utf8");
  if (available < 0) throw new NotebookError("INVALID_INPUT", "Managed note ownership envelope exceeds the configured note ceiling");
  if (Buffer.byteLength(body, "utf8") <= available) return { content: `${marker}${body}`, body };
  if (!truncate) throw new NotebookError("INVALID_INPUT", "Eligible document plus ownership envelope exceeds the configured note ceiling");
  const suffix = "\n\n[Session capture truncated by project-notebook.v1 policy]";
  const budget = Math.max(0, available - Buffer.byteLength(suffix, "utf8"));
  let used = 0;
  const points: string[] = [];
  for (const point of body) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > budget) break;
    points.push(point);
    used += bytes;
  }
  const fitted = `${points.join("")}${suffix}`;
  return { content: `${marker}${fitted}`, body: fitted };
}

function bindingId(receipt: CaptureReceiptV1, module: NotebookModule): { notebookId: string; client: ReturnType<NotebookModule["context"]>["client"]; config: ReturnType<NotebookModule["context"]>["config"] } {
  const ctx = module.contextBySlug(receipt.project_slug, true);
  if (!ctx.config.binding.notebook_id || ctx.config.binding.state !== "linked") throw new NotebookError("NOT_CONFIGURED", "Capture project notebook is not linked");
  return { notebookId: ctx.config.binding.notebook_id, client: ctx.client!, config: ctx.config };
}

async function upsertManaged(input: {
  module: NotebookModule;
  receipt: CaptureReceiptV1;
  notebookId: string;
  client: NonNullable<ReturnType<NotebookModule["context"]>["client"]>;
  logicalId: string;
  title: string;
  content: string;
  beforeRemote?: () => void;
}): Promise<{ note: OpenNotebookNoteV1; journal?: RemoteMutationJournalV1 }> {
  const created = await reconcileManagedNote({
    stateRoot: input.module.stateRoot,
    projectSlug: input.receipt.project_slug,
    notebookId: input.notebookId,
    logicalId: input.logicalId,
    title: input.title,
    content: input.content,
    client: input.client,
    sessionKey: input.receipt.session_key,
    beforeRemote: input.beforeRemote,
  });
  return { note: created.note, journal: created.journal };
}

async function processClaimed(module: NotebookModule, receipt: CaptureReceiptV1, leaseUpdated: (receipt: CaptureReceiptV1) => void): Promise<CaptureReceiptV1> {
  let active = receipt;
  const linked = bindingId(active, module);
  let baseline = readSessionBaseline(module.stateRoot, active.project_slug, active.session_key, linked.config.limits);
  if ((!baseline || !baseline.complete) && active.manual_baseline_ref) {
    // Operator recovery supplies only a committed boundary. It deliberately
    // carries no invented SessionStart dirty-path provenance; the evidence
    // selector excludes all current uncommitted paths under manual mode.
    baseline = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      session_key: active.session_key,
      project_slug: active.project_slug,
      client: "operator-manual-baseline",
      created_at: active.created_at,
      repo_path_digest: active.repo_path_digest,
      git_head: active.manual_baseline_ref,
      git_status_digest: null,
      policy_version: NOTEBOOK_POLICY_VERSION,
      tracked_path_digests: {},
      pre_dirty_paths: [],
      complete: true,
      incomplete_reasons: ["manual-baseline-pre-dirty-unknown"],
    };
  }
  if (!baseline || !baseline.complete) {
    return transitionCaptureReceipt({
      root: module.stateRoot,
      projectSlug: receipt.project_slug,
      receiptId: active.receipt_id,
      limits: linked.config.limits,
      expected: captureReceiptVersion(active),
      state: "blocked-missing-baseline",
      errorCategory: "CONFLICT",
      retryable: false,
      diagnostic: "A complete SessionStart baseline is required; retry with an explicit committed --baseline GIT_REF",
    });
  }
  const renew = (): void => {
    active = renewCaptureReceiptLease({
      root: module.stateRoot,
      projectSlug: active.project_slug,
      receiptId: active.receipt_id,
      limits: linked.config.limits,
      expected: captureReceiptVersion(active),
    });
    leaseUpdated(active);
  };
  const evidence = selectEligibleDocuments(linked.config, baseline, active.manual_baseline_ref);
  const logicalIds: string[] = [];
  const remoteIds: string[] = [];
  const journals: RemoteMutationJournalV1[] = [];

  for (const document of evidence.documents) {
    renew();
    const logicalId = sha256Hex(`pjangler-document-v1\0${active.project_slug}\0${document.path.normalize("NFC")}`);
    const envelope: PjanglerNoteEnvelopeV1 = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: active.project_slug,
      kind: "document",
      logical_id: logicalId,
      source_path: document.path,
      source_revision: document.source_revision,
      content_sha256: document.content_sha256,
      session_key: active.session_key,
      captured_at: active.created_at,
      policy_version: NOTEBOOK_POLICY_VERSION,
    };
    let documentContent: string;
    try { documentContent = managedContent(envelope, document.content, linked.config.limits.note_max_bytes, false).content; }
    catch (error) {
      if (!(error instanceof NotebookError) || error.code !== "INVALID_INPUT") throw error;
      evidence.exclusions["note-envelope-oversize"] = (evidence.exclusions["note-envelope-oversize"] ?? 0) + 1;
      continue;
    }
    const upserted = await upsertManaged({
      module,
      receipt: active,
      notebookId: linked.notebookId,
      client: linked.client!,
      logicalId,
      title: safeDocumentTitle(document.path),
      content: documentContent,
      beforeRemote: renew,
    });
    const note = upserted.note;
    if (upserted.journal) journals.push(upserted.journal);
    logicalIds.push(logicalId);
    remoteIds.push(note.id);
  }

  const summary = summarizeCapture(linked.config, {
    documents: evidence.documents,
    changedPaths: evidence.changed_paths,
    exclusions: evidence.exclusions,
    endRevision: evidence.end_revision,
    endStatusDigest: evidence.end_status_digest,
    baselineRef: baseline.git_head,
  });
  let captureEnvelope: PjanglerNoteEnvelopeV1 = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: active.project_slug,
    kind: "session-capture",
    logical_id: active.logical_id,
    ...(evidence.end_revision ? { source_revision: evidence.end_revision } : {}),
    content_sha256: sha256Hex(summary.summary),
    session_key: active.session_key,
    captured_at: active.created_at,
    policy_version: NOTEBOOK_POLICY_VERSION,
  };
  let fittedSummary = managedContent(captureEnvelope, summary.summary, linked.config.limits.note_max_bytes, true);
  if (fittedSummary.body !== summary.summary) {
    captureEnvelope = { ...captureEnvelope, content_sha256: sha256Hex(fittedSummary.body) };
    fittedSummary = managedContent(captureEnvelope, fittedSummary.body, linked.config.limits.note_max_bytes, true);
  }
  renew();
  const captureUpsert = await upsertManaged({
    module,
    receipt: active,
    notebookId: linked.notebookId,
    client: linked.client!,
    logicalId: active.logical_id,
    title: `Session Capture ${active.created_at}`,
    content: fittedSummary.content,
    beforeRemote: renew,
  });
  const captureNote = captureUpsert.note;
  if (captureUpsert.journal) journals.push(captureUpsert.journal);
  logicalIds.push(active.logical_id);
  remoteIds.push(captureNote.id);
  const completed = transitionCaptureReceipt({
    root: module.stateRoot,
    projectSlug: active.project_slug,
    receiptId: active.receipt_id,
    limits: linked.config.limits,
    expected: captureReceiptVersion(active),
    state: "succeeded",
    exclusionCounts: evidence.exclusions,
    summaryMode: summary.mode,
    noteLogicalIds: logicalIds,
    remoteNoteIds: remoteIds,
    endRevision: evidence.end_revision,
    endStatusDigest: evidence.end_status_digest,
  });
  for (const journal of journals) commitReconciledRemoteMutation(module.stateRoot, journal);
  return completed;
}

export async function runCaptureWorker(module: NotebookModule, projectSlug: string, receiptId: string): Promise<CaptureWorkerResultV1> {
  const local = module.contextBySlug(projectSlug, false);
  let receipt = readCaptureReceipt(module.stateRoot, projectSlug, receiptId, local.config.limits);
  if (receipt.state === "succeeded") return { receipt, processed: finalizeSucceededReceiptJournals(module, receipt).length > 0 };
  while (true) {
    receipt = claimCaptureReceipt({ root: module.stateRoot, projectSlug, receiptId, limits: local.config.limits });
    try {
      const completed = await processClaimed(module, receipt, (updated) => { receipt = updated; });
      return { receipt: completed, processed: true };
    } catch (error) {
      const normalized = normalizeNotebookError(error);
      if (receipt.attempt_origin === "operator") {
        receipt = transitionCaptureReceipt({
          root: module.stateRoot,
          projectSlug,
          receiptId,
          limits: local.config.limits,
          expected: captureReceiptVersion(receipt),
          state: "retry-exhausted",
          errorCategory: normalized.code,
          retryable: normalized.retryable,
          diagnostic: normalized.message,
        });
        return { receipt, processed: true };
      }
      const budgetRemains = normalized.retryable && receipt.automatic_attempts_used < receipt.automatic_attempt_limit;
      receipt = transitionCaptureReceipt({
        root: module.stateRoot,
        projectSlug,
        receiptId,
        limits: local.config.limits,
        expected: captureReceiptVersion(receipt),
        state: budgetRemains ? "failed" : receipt.automatic_attempts_used >= receipt.automatic_attempt_limit ? "retry-exhausted" : "failed",
        errorCategory: normalized.code,
        retryable: normalized.retryable,
        diagnostic: normalized.message,
      });
      if (!budgetRemains) return { receipt, processed: true };
      receipt = transitionCaptureReceipt({
        root: module.stateRoot,
        projectSlug,
        receiptId,
        limits: local.config.limits,
        expected: captureReceiptVersion(receipt),
        state: "queued",
        errorCategory: normalized.code,
        retryable: true,
        diagnostic: normalized.message,
      });
    }
  }
}
