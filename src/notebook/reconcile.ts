import { NotebookError, type OpenNotebookNotebookV1, type OpenNotebookNoteV1 } from "./types";
import { parseNoteEnvelope } from "./notes";
import { normalizeOpenNotebookNoteType, OpenNotebookClient } from "./open-notebook-client";
import {
  markRemoteMutationDefinitivelyRejected,
  mutationInputDigest,
  prepareRemoteMutation,
  rearmRemoteMutationAfterDefinitiveRejection,
  transitionRemoteMutation,
  type RemoteMutationJournalV1,
} from "./remote-mutation-journal";

function sameCandidateSet(left: string[], right: string[]): boolean {
  const normalize = (items: string[]) => [...items].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function recordReconciliation(input: {
  stateRoot: string;
  journal: RemoteMutationJournalV1;
  candidateIds: string[];
  duplicateDiagnostic: string;
}): RemoteMutationJournalV1 {
  if (input.journal.state === "reconciled") {
    if (!sameCandidateSet(input.journal.candidate_ids, input.candidateIds)) {
      throw new NotebookError("CONFLICT", "Reconciled remote mutation candidate set changed; durable ownership must be repaired explicitly");
    }
    return input.journal;
  }
  if (input.candidateIds.length === 0) return input.journal;
  return transitionRemoteMutation({
    root: input.stateRoot,
    journal: input.journal,
    state: "reconciled",
    candidateIds: input.candidateIds,
    diagnostic: input.candidateIds.length > 1 ? input.duplicateDiagnostic : null,
  });
}

export function projectNotebookMarker(projectSlug: string): string {
  return `pjangler.project.v1:${projectSlug}`;
}

function ambiguous(kind: string, ids: string[]): never {
  throw new NotebookError("CONFLICT", `More than one ${kind} matches the stable PJangler marker`, false, { candidate_count: ids.length });
}

export async function reconcileProjectNotebook(input: {
  stateRoot: string;
  projectSlug: string;
  name: string;
  description?: string;
  client: OpenNotebookClient;
  beforeRemote?: () => void;
}): Promise<{ notebook: OpenNotebookNotebookV1; created: boolean; adopted: boolean; journal: RemoteMutationJournalV1 }> {
  const marker = projectNotebookMarker(input.projectSlug);
  const description = input.description?.trim() ? `${marker}\n${input.description.trim()}` : marker;
  const digest = mutationInputDigest({ kind: "notebook.create", marker, name: input.name, description });
  let journal = prepareRemoteMutation({
    root: input.stateRoot,
    projectSlug: input.projectSlug,
    kind: "notebook.create",
    logicalMarker: marker,
    inputDigest: digest,
  });

  const reconcile = async (): Promise<OpenNotebookNotebookV1[]> => {
    input.beforeRemote?.();
    const candidates = (await input.client.listNotebooks()).filter((notebook) => notebook.description?.split(/\r?\n/u)[0] === marker);
    journal = recordReconciliation({
      stateRoot: input.stateRoot,
      journal,
      candidateIds: candidates.map((item) => item.id),
      duplicateDiagnostic: "duplicate stable marker",
    });
    return candidates;
  };

  let candidates = await reconcile();
  if (candidates.length > 1) ambiguous("notebook", candidates.map((item) => item.id));
  if (candidates.length === 1) {
    let candidate = candidates[0]!;
    if (candidate.name !== input.name || candidate.description !== description || candidate.archived === true) {
      input.beforeRemote?.();
      candidate = await input.client.updateNotebook(candidate.id, { name: input.name, description, archived: false });
      if (candidate.name !== input.name || candidate.description !== description || candidate.archived === true) {
        throw new NotebookError("DRIFT_DETECTED", "Stable-marker notebook metadata could not be repaired exactly");
      }
    }
    return { notebook: candidate, created: false, adopted: true, journal };
  }
  if (journal.state !== "prepared") {
    throw new NotebookError("CONFLICT", "Notebook create may have been dispatched; reconcile before another POST", false, { operation_id: journal.operation_id });
  }
  // The latch below is persisted immediately before fetch receives the request.
  input.beforeRemote?.();
  await input.client.createNotebook({ name: input.name, description }, () => {
    journal = transitionRemoteMutation({ root: input.stateRoot, journal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  });
  candidates = await reconcile();
  if (candidates.length > 1) ambiguous("notebook", candidates.map((item) => item.id));
  if (candidates.length !== 1) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Created notebook could not be reconciled by its stable marker");
  const candidate = candidates[0]!;
  if (candidate.name !== input.name || candidate.description !== description || candidate.archived === true) {
    throw new NotebookError("DRIFT_DETECTED", "Created notebook did not satisfy the exact marker/name/archive contract");
  }
  return { notebook: candidate, created: true, adopted: false, journal };
}

export async function reconcileManagedNote(input: {
  stateRoot: string;
  projectSlug: string;
  notebookId: string;
  logicalId: string;
  title: string;
  content: string;
  noteType?: string;
  client: OpenNotebookClient;
  sessionKey?: string;
  inputDigest?: string;
  operationId?: string;
  beforeRemote?: () => void;
}): Promise<{ note: OpenNotebookNoteV1; created: boolean; adopted: boolean; journal: RemoteMutationJournalV1 }> {
  const desiredEnvelope = parseNoteEnvelope(input.content)?.envelope;
  if (!desiredEnvelope || desiredEnvelope.project_slug !== input.projectSlug || desiredEnvelope.logical_id !== input.logicalId) {
    throw new NotebookError("INVALID_INPUT", "Managed note create requires an exact owned PJangler envelope");
  }
  const noteType = normalizeOpenNotebookNoteType(input.noteType);
  const digest = input.inputDigest ?? mutationInputDigest({ kind: "note.create", notebook_id: input.notebookId, logical_id: input.logicalId, title: input.title, content: input.content });
  const dispatchDigest = mutationInputDigest({ kind: "note.create", notebook_id: input.notebookId, logical_id: input.logicalId, title: input.title, content: input.content, note_type: noteType });
  let journal = prepareRemoteMutation({
    root: input.stateRoot,
    projectSlug: input.projectSlug,
    kind: "note.create",
    logicalMarker: input.logicalId,
    inputDigest: digest,
    dispatchDigest,
    sessionKey: input.sessionKey,
    bindingId: input.notebookId,
    operationId: input.operationId,
  });
  const reconcile = async (): Promise<OpenNotebookNoteV1[]> => {
    input.beforeRemote?.();
    const notes = await input.client.listNotes(input.notebookId);
    const candidates = notes.filter((note) => parseNoteEnvelope(note.content)?.envelope.logical_id === input.logicalId);
    journal = recordReconciliation({
      stateRoot: input.stateRoot,
      journal,
      candidateIds: candidates.map((item) => item.id),
      duplicateDiagnostic: "duplicate logical id",
    });
    return candidates;
  };
  let candidates = await reconcile();
  if (candidates.length > 1) ambiguous("note", candidates.map((item) => item.id));
  if (candidates.length === 1) {
    let candidate = candidates[0]!;
    const owned = parseNoteEnvelope(candidate.content)?.envelope;
    if (!owned || owned.project_slug !== input.projectSlug || owned.kind !== desiredEnvelope.kind || owned.logical_id !== input.logicalId) {
      throw new NotebookError("CONFLICT", "Managed logical ID is occupied by a foreign or forged note envelope");
    }
    if (candidate.title !== input.title || candidate.content !== input.content) {
      input.beforeRemote?.();
      candidate = await input.client.updateOwnedNote(input.notebookId, candidate.id, { title: input.title, content: input.content });
      if (candidate.title !== input.title || candidate.content !== input.content) {
        throw new NotebookError("DRIFT_DETECTED", "Managed note metadata/content could not be repaired exactly");
      }
    }
    return { note: candidate, created: false, adopted: true, journal };
  }
  if (journal.state !== "prepared") {
    journal = rearmRemoteMutationAfterDefinitiveRejection({
      root: input.stateRoot,
      journal,
      inputDigest: digest,
      dispatchDigest,
      observedCandidateIds: candidates.map((item) => item.id),
      ...(input.noteType === undefined && input.inputDigest === undefined ? { legacyV114InputDigest: digest } : {}),
    });
  }
  input.beforeRemote?.();
  await input.client.createNote(input.notebookId, { title: input.title, content: input.content, note_type: noteType }, () => {
    journal = transitionRemoteMutation({ root: input.stateRoot, journal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  }, (status) => {
    journal = markRemoteMutationDefinitivelyRejected({ root: input.stateRoot, journal, status });
  });
  candidates = await reconcile();
  if (candidates.length > 1) ambiguous("note", candidates.map((item) => item.id));
  if (candidates.length !== 1) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Created note could not be reconciled by its logical ID");
  const candidate = candidates[0]!;
  const owned = parseNoteEnvelope(candidate.content)?.envelope;
  if (!owned || owned.project_slug !== input.projectSlug || owned.kind !== desiredEnvelope.kind || owned.logical_id !== input.logicalId
    || candidate.title !== input.title || candidate.content !== input.content) {
    throw new NotebookError("DRIFT_DETECTED", "Created managed note failed exact ownership/content reconciliation");
  }
  return { note: candidate, created: true, adopted: false, journal };
}
