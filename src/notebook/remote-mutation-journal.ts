import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./notes";
import {
  parseRemoteMutationJournal,
  remoteMutationNextAction,
  remoteMutationResultCategory,
  type DefinitiveRemoteMutationHttpStatus,
  type RemoteMutationJournalState,
  type RemoteMutationJournalV1,
} from "./remote-mutation-schema";
import {
  atomicWriteJson,
  createNotebookStateJsonExclusive,
  ensureNotebookState,
  readNotebookStateDirectory,
  readNotebookStateJson,
  withNotebookStateLock,
} from "./state";
import { NOTEBOOK_SCHEMA_VERSION, NotebookError } from "./types";

export type { RemoteMutationJournalState, RemoteMutationJournalV1 } from "./remote-mutation-schema";

function journalPath(root: string, projectSlug: string, operationId: string): string {
  if (!/^[a-f0-9-]{16,64}$/iu.test(operationId)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation operation ID");
  return join(ensureNotebookState(root, projectSlug).journals, `${operationId}.json`);
}

export function remoteMutationJournalPath(root: string, projectSlug: string, operationId: string): string {
  return journalPath(root, projectSlug, operationId);
}

export function mutationInputDigest(value: unknown): string {
  return sha256Hex(`pjangler-remote-mutation-v1\0${canonicalJson(value)}`);
}

function assertBoundedJournalText(value: string, label: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NotebookError("INVALID_INPUT", `Invalid remote mutation ${label}`);
  }
}

export function listRemoteMutationJournals(root: string, projectSlug: string): RemoteMutationJournalV1[] {
  const paths = ensureNotebookState(root, projectSlug);
  const journals: RemoteMutationJournalV1[] = [];
  for (const entry of readNotebookStateDirectory(paths.journals, paths.root)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9-]{16,64}\.json$/iu.test(entry.name)) {
      throw new NotebookError("CONFLICT", `Remote mutation journal state-integrity finding: journals/${entry.name}`);
    }
    const read = readNotebookStateJson(join(paths.journals, entry.name), paths.root, 65_536);
    const journal = read.value === undefined ? null : parseRemoteMutationJournal(read.value);
    if (!journal || `${journal.operation_id}.json` !== entry.name) {
      throw new NotebookError("CONFLICT", `Remote mutation journal state-integrity finding: journals/${entry.name}`);
    }
    journals.push(journal);
  }
  return journals.sort((a, b) => a.prepared_at.localeCompare(b.prepared_at) || a.operation_id.localeCompare(b.operation_id));
}

export function findActiveRemoteMutation(root: string, projectSlug: string, kind: RemoteMutationJournalV1["kind"], inputDigest: string): RemoteMutationJournalV1 | undefined {
  return listRemoteMutationJournals(root, projectSlug).find((item) => item.kind === kind && item.input_digest === inputDigest && item.state !== "committed");
}

export function prepareRemoteMutation(input: {
  root: string;
  projectSlug: string;
  kind: RemoteMutationJournalV1["kind"];
  logicalMarker: string;
  inputDigest: string;
  dispatchDigest?: string;
  sessionKey?: string;
  bindingId?: string;
  operationId?: string;
  now?: Date;
}): RemoteMutationJournalV1 {
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation input digest");
  if (input.dispatchDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.dispatchDigest)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation dispatch digest");
  if (input.sessionKey && !/^[a-f0-9]{64}$/u.test(input.sessionKey)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation session key");
  assertBoundedJournalText(input.logicalMarker, "logical marker");
  if (input.bindingId !== undefined) assertBoundedJournalText(input.bindingId, "binding ID");
  return withNotebookStateLock(input.root, input.projectSlug, 1_000, (paths) => {
    const active = listRemoteMutationJournals(input.root, input.projectSlug)
      .find((item) => item.kind === input.kind && item.state !== "committed"
        && (item.input_digest === input.inputDigest || item.logical_marker === input.logicalMarker));
    if (active) {
      if (active.state !== "prepared") return active;
      if (active.input_digest === input.inputDigest && active.dispatch_digest === input.dispatchDigest) return active;
      const requested = (input.now ?? new Date()).getTime();
      const previous = Date.parse(active.updated_at);
      const { dispatch_digest: _dispatchDigest, ...activeWithoutDispatchDigest } = active;
      const updated: RemoteMutationJournalV1 = {
        ...activeWithoutDispatchDigest,
        input_digest: input.inputDigest,
        ...(input.dispatchDigest ? { dispatch_digest: input.dispatchDigest } : {}),
        ...(input.bindingId ? { binding_id: input.bindingId } : {}),
        ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
        updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
        diagnostic: "prepared input superseded before dispatch",
      };
      atomicWriteJson(journalPath(input.root, input.projectSlug, active.operation_id), updated, paths.root);
      return updated;
    }
    const now = (input.now ?? new Date()).toISOString();
    const journal: RemoteMutationJournalV1 = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      operation_id: input.operationId ?? randomUUID(),
      project_slug: input.projectSlug,
      kind: input.kind,
      logical_marker: input.logicalMarker,
      input_digest: input.inputDigest,
      ...(input.dispatchDigest ? { dispatch_digest: input.dispatchDigest } : {}),
      ...(input.bindingId ? { binding_id: input.bindingId } : {}),
      ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
      state: "prepared",
      prepared_at: now,
      updated_at: now,
      candidate_ids: [],
      diagnostic: null,
      result_category: "prepared",
      next_action: remoteMutationNextAction("prepared", 0),
    };
    if (!createNotebookStateJsonExclusive(journalPath(input.root, input.projectSlug, journal.operation_id), journal, paths.root)) {
      throw new NotebookError("CONFLICT", "Concurrent remote mutation journal reservation collided");
    }
    return journal;
  });
}

export function transitionRemoteMutation(input: {
  root: string;
  journal: RemoteMutationJournalV1;
  state: RemoteMutationJournalState;
  candidateIds?: string[];
  diagnostic?: string | null;
  now?: Date;
}): RemoteMutationJournalV1 {
  return withNotebookStateLock(input.root, input.journal.project_slug, 1_000, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65_536);
    const current = read.value === undefined ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at
      || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale transition rejected");
    }
    const allowed: Record<RemoteMutationJournalState, ReadonlySet<RemoteMutationJournalState>> = {
      prepared: new Set(["possibly-dispatched", "reconciled"]),
      "possibly-dispatched": new Set(["reconciled"]),
      reconciled: new Set(["committed"]),
      committed: new Set(),
    };
    if (!allowed[current.state].has(input.state)) throw new NotebookError("CONFLICT", "Remote mutation journal transition is not allowed by the v1 state machine");
    const candidates = [...new Set(input.candidateIds ?? current.candidate_ids)];
    if (candidates.length > 20 || candidates.some((item) => typeof item !== "string" || !item || Buffer.byteLength(item, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(item))) {
      throw new NotebookError("INVALID_INPUT", "Remote mutation candidates exceed the bounded v1 schema");
    }
    if (input.state === "possibly-dispatched" && candidates.length !== 0) throw new NotebookError("CONFLICT", "Possibly-dispatched journal cannot claim candidates before reconciliation");
    if (input.state === "committed" && candidates.length !== 1) throw new NotebookError("CONFLICT", "Committed journal requires exactly one reconciled candidate");
    if (input.diagnostic !== undefined && input.diagnostic !== null && (Buffer.byteLength(input.diagnostic, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(input.diagnostic))) {
      throw new NotebookError("INVALID_INPUT", "Remote mutation diagnostic exceeds the bounded v1 schema");
    }
    const requested = (input.now ?? new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const { definitive_http_status: _definitiveHttpStatus, ...currentWithoutRejection } = current;
    const next: RemoteMutationJournalV1 = {
      ...currentWithoutRejection,
      state: input.state,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      candidate_ids: candidates,
      diagnostic: input.state === "committed" ? null : input.diagnostic === undefined ? current.diagnostic : input.diagnostic,
      result_category: remoteMutationResultCategory(input.state, candidates.length),
      next_action: remoteMutationNextAction(input.state, candidates.length),
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}

export function markRemoteMutationDefinitivelyRejected(input: {
  root: string;
  journal: RemoteMutationJournalV1;
  status: DefinitiveRemoteMutationHttpStatus;
  now?: Date;
}): RemoteMutationJournalV1 {
  return withNotebookStateLock(input.root, input.journal.project_slug, 1_000, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65_536);
    const current = read.value === undefined ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at
      || current.input_digest !== input.journal.input_digest || current.dispatch_digest !== input.journal.dispatch_digest
      || current.diagnostic !== input.journal.diagnostic || current.definitive_http_status !== input.journal.definitive_http_status
      || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale definitive rejection rejected");
    }
    if (current.state !== "possibly-dispatched" || current.candidate_ids.length !== 0) {
      throw new NotebookError("CONFLICT", "Only an unresolved dispatched mutation can record a definitive HTTP rejection");
    }
    const requested = (input.now ?? new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const next: RemoteMutationJournalV1 = {
      ...current,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      diagnostic: `Open Notebook definitively rejected HTTP ${input.status}`,
      definitive_http_status: input.status,
      result_category: remoteMutationResultCategory(current.state, 0, input.status),
      next_action: remoteMutationNextAction(current.state, 0, input.status),
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}

export function rearmRemoteMutationAfterDefinitiveRejection(input: {
  root: string;
  journal: RemoteMutationJournalV1;
  inputDigest: string;
  dispatchDigest: string;
  observedCandidateIds: string[];
  legacyV114InputDigest?: string;
  now?: Date;
}): RemoteMutationJournalV1 {
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid corrected remote mutation input digest");
  if (!/^[a-f0-9]{64}$/u.test(input.dispatchDigest)) throw new NotebookError("INVALID_INPUT", "Invalid corrected remote mutation dispatch digest");
  if (input.legacyV114InputDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.legacyV114InputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid legacy v1.14 remote mutation input digest");
  if (input.observedCandidateIds.length !== 0) throw new NotebookError("CONFLICT", "A remote mutation with candidates cannot be rearmed");
  return withNotebookStateLock(input.root, input.journal.project_slug, 1_000, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65_536);
    const current = read.value === undefined ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at
      || current.input_digest !== input.journal.input_digest || current.dispatch_digest !== input.journal.dispatch_digest
      || current.diagnostic !== input.journal.diagnostic || current.definitive_http_status !== input.journal.definitive_http_status
      || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale corrected-input rearm rejected");
    }
    if (current.kind !== "note.create" || current.state !== "possibly-dispatched" || current.candidate_ids.length !== 0) {
      throw new NotebookError("CONFLICT", "Only a zero-candidate rejected note mutation can be rearmed");
    }
    if (current.dispatch_digest === input.dispatchDigest) {
      throw new NotebookError("CONFLICT", "Definitively rejected note transport input must change before one retry is allowed");
    }
    const explicitRejection = current.definitive_http_status === 400 || current.definitive_http_status === 422;
    const legacyV114Rejection = current.definitive_http_status === undefined
      && current.diagnostic === "possibly-dispatched"
      && current.dispatch_digest === undefined
      && input.legacyV114InputDigest !== undefined
      && current.input_digest === input.legacyV114InputDigest;
    if (!explicitRejection && !legacyV114Rejection) {
      throw new NotebookError("CONFLICT", "Remote note dispatch is ambiguous; corrected input cannot be posted without a definitive rejection");
    }
    const requested = (input.now ?? new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const { definitive_http_status: _definitiveHttpStatus, ...currentWithoutRejection } = current;
    const next: RemoteMutationJournalV1 = {
      ...currentWithoutRejection,
      state: "prepared",
      input_digest: input.inputDigest,
      dispatch_digest: input.dispatchDigest,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      candidate_ids: [],
      diagnostic: legacyV114Rejection
        ? "corrected v1.14 note_type input rearmed after definitive legacy rejection"
        : "corrected input rearmed after definitive HTTP rejection",
      result_category: remoteMutationResultCategory("prepared", 0),
      next_action: remoteMutationNextAction("prepared", 0),
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}

export function remoteMutationExists(root: string, projectSlug: string, operationId: string): boolean {
  return listRemoteMutationJournals(root, projectSlug).some((journal) => journal.operation_id === operationId);
}

export function commitReconciledRemoteMutation(root: string, journal: RemoteMutationJournalV1, now?: Date): RemoteMutationJournalV1 {
  if (journal.state === "committed") return journal;
  if (journal.state !== "reconciled" || journal.candidate_ids.length !== 1) {
    throw new NotebookError("CONFLICT", "Remote mutation cannot commit before exactly one candidate and durable ownership");
  }
  return transitionRemoteMutation({ root, journal, state: "committed", now, diagnostic: null });
}
