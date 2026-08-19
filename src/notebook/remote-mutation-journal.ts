import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./notes";
import {
  parseRemoteMutationJournal,
  remoteMutationNextAction,
  remoteMutationResultCategory,
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
  sessionKey?: string;
  bindingId?: string;
  operationId?: string;
  now?: Date;
}): RemoteMutationJournalV1 {
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation input digest");
  if (input.sessionKey && !/^[a-f0-9]{64}$/u.test(input.sessionKey)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation session key");
  assertBoundedJournalText(input.logicalMarker, "logical marker");
  if (input.bindingId !== undefined) assertBoundedJournalText(input.bindingId, "binding ID");
  return withNotebookStateLock(input.root, input.projectSlug, 1_000, (paths) => {
    const active = listRemoteMutationJournals(input.root, input.projectSlug)
      .find((item) => item.kind === input.kind && item.state !== "committed"
        && (item.input_digest === input.inputDigest || item.logical_marker === input.logicalMarker));
    if (active) {
      if (active.input_digest === input.inputDigest || active.state !== "prepared") return active;
      const requested = (input.now ?? new Date()).getTime();
      const previous = Date.parse(active.updated_at);
      const updated: RemoteMutationJournalV1 = {
        ...active,
        input_digest: input.inputDigest,
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
    const next: RemoteMutationJournalV1 = {
      ...current,
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
