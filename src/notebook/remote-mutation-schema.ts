export type RemoteMutationJournalState = "prepared" | "possibly-dispatched" | "reconciled" | "committed";
export type DefinitiveRemoteMutationHttpStatus = 400 | 422;

export interface RemoteMutationJournalV1 {
  schema_version: 1;
  operation_id: string;
  project_slug: string;
  kind: "notebook.create" | "note.create";
  logical_marker: string;
  input_digest: string;
  dispatch_digest?: string;
  binding_id?: string;
  session_key?: string;
  state: RemoteMutationJournalState;
  prepared_at: string;
  updated_at: string;
  candidate_ids: string[];
  diagnostic: string | null;
  definitive_http_status?: DefinitiveRemoteMutationHttpStatus;
  result_category: "prepared" | "possibly-dispatched" | "definitive-http-rejection" | "reconciled-zero" | "reconciled-one" | "reconciled-many" | "committed";
  next_action: string;
}

const REQUIRED_KEYS = [
  "schema_version", "operation_id", "project_slug", "kind", "logical_marker", "input_digest", "state",
  "prepared_at", "updated_at", "candidate_ids", "diagnostic", "result_category", "next_action",
] as const;
const OPTIONAL_KEYS = ["binding_id", "session_key", "dispatch_digest", "definitive_http_status"] as const;
const OPERATION_ID_RE = /^[a-f0-9-]{16,64}$/iu;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function timestamp(value: unknown): value is string {
  return bounded(value, 64) && Number.isFinite(Date.parse(value));
}

export function remoteMutationResultCategory(state: RemoteMutationJournalState, candidateCount: number, definitiveHttpStatus?: DefinitiveRemoteMutationHttpStatus): RemoteMutationJournalV1["result_category"] {
  if (state === "prepared") return "prepared";
  if (state === "possibly-dispatched") return definitiveHttpStatus === undefined ? "possibly-dispatched" : "definitive-http-rejection";
  if (state === "committed") return "committed";
  return candidateCount === 0 ? "reconciled-zero" : candidateCount === 1 ? "reconciled-one" : "reconciled-many";
}

export function remoteMutationNextAction(state: RemoteMutationJournalState, candidateCount: number, definitiveHttpStatus?: DefinitiveRemoteMutationHttpStatus): string {
  if (state === "prepared") return "dispatch once only after the durable possibly-dispatched latch";
  if (state === "possibly-dispatched") return definitiveHttpStatus === undefined
    ? "reconcile by stable marker only; do not POST again"
    : "reconcile by stable marker; a different corrected input may dispatch once only after zero candidates";
  if (state === "committed") return "none";
  return candidateCount === 1
    ? "persist durable binding or note ownership before commit"
    : "resolve the zero-or-many candidate conflict without another blind POST";
}

export function parseRemoteMutationJournal(value: unknown): RemoteMutationJournalV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const allowed = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  if (!REQUIRED_KEYS.every((key) => Object.hasOwn(item, key)) || keys.some((key) => !allowed.has(key))) return null;
  if (item.schema_version !== 1 || typeof item.operation_id !== "string" || !OPERATION_ID_RE.test(item.operation_id)) return null;
  if (typeof item.project_slug !== "string" || !PROJECT_SLUG_RE.test(item.project_slug)) return null;
  if (item.kind !== "notebook.create" && item.kind !== "note.create") return null;
  if (item.state !== "prepared" && item.state !== "possibly-dispatched" && item.state !== "reconciled" && item.state !== "committed") return null;
  if (!bounded(item.logical_marker, 512) || typeof item.input_digest !== "string" || !DIGEST_RE.test(item.input_digest)) return null;
  if (item.dispatch_digest !== undefined && (typeof item.dispatch_digest !== "string" || !DIGEST_RE.test(item.dispatch_digest))) return null;
  if (item.session_key !== undefined && (typeof item.session_key !== "string" || !DIGEST_RE.test(item.session_key))) return null;
  if (item.binding_id !== undefined && !bounded(item.binding_id, 512)) return null;
  if (item.definitive_http_status !== undefined && item.definitive_http_status !== 400 && item.definitive_http_status !== 422) return null;
  if (!timestamp(item.prepared_at) || !timestamp(item.updated_at) || Date.parse(item.updated_at) < Date.parse(item.prepared_at)) return null;
  if (!Array.isArray(item.candidate_ids) || item.candidate_ids.length > 20
    || item.candidate_ids.some((entry) => !bounded(entry, 512))
    || new Set(item.candidate_ids).size !== item.candidate_ids.length) return null;
  if (item.diagnostic !== null && (typeof item.diagnostic !== "string" || Buffer.byteLength(item.diagnostic, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(item.diagnostic))) return null;
  const candidateCount = item.candidate_ids.length;
  if (item.state === "prepared" && candidateCount !== 0) return null;
  if (item.state === "possibly-dispatched" && candidateCount !== 0) return null;
  if (item.definitive_http_status !== undefined && (item.state !== "possibly-dispatched" || candidateCount !== 0 || item.diagnostic === null)) return null;
  if (item.state === "committed" && (candidateCount !== 1 || item.diagnostic !== null)) return null;
  if (item.result_category !== remoteMutationResultCategory(item.state, candidateCount, item.definitive_http_status as DefinitiveRemoteMutationHttpStatus | undefined)) return null;
  if (item.next_action !== remoteMutationNextAction(item.state, candidateCount, item.definitive_http_status as DefinitiveRemoteMutationHttpStatus | undefined)) return null;
  return item as unknown as RemoteMutationJournalV1;
}
