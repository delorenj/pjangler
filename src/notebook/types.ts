export const NOTEBOOK_SCHEMA_VERSION = 1 as const;
export const NOTEBOOK_POLICY_VERSION = "project-notebook.v1" as const;

const CREDENTIAL_KEY = /(?:^|[_-])(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|authorization)(?:$|[_-])/iu;
const SECRET_SHAPED_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s]{8,})/iu;

/** Return the first credential-bearing field/value path in a Notebook-owned
 * configuration surface. Environment variable *names* and op:// references
 * are not credential values; raw credential-shaped material is rejected. */
export function notebookCredentialMaterialPath(value: unknown): string | null {
  const seen = new WeakSet<object>();
  let visited = 0;
  const walk = (candidate: unknown, path: string, depth: number): string | null => {
    if (++visited > 2_000 || depth > 20) return `${path}.[structure-limit]`;
    if (typeof candidate === "string") return SECRET_SHAPED_VALUE.test(candidate) ? path : null;
    if (!candidate || typeof candidate !== "object") return null;
    if (seen.has(candidate)) return `${path}.[cycle]`;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index++) {
        const found = walk(candidate[index], `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (CREDENTIAL_KEY.test(key)) return childPath;
      const found = walk(child, childPath, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(value, "notebook", 0);
}

export type NotebookBindingState = "disabled" | "planned" | "linked";
export type NotebookHealth = "unconfigured" | "healthy" | "drifted" | "unavailable" | "blocked" | null;
export type NotebookRemoteCheck = "pass" | "fail" | "skip";
export type NotebookReceiptState =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "retry-exhausted"
  | "blocked-missing-baseline";
export type NotebookAttemptOrigin = "automatic" | "operator";
export type NotebookNoteKind = "overview" | "user-note" | "document" | "session-capture";

export type NotebookErrorCode =
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "AUTHENTICATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CROSS_PROJECT"
  | "DRIFT_DETECTED"
  | "THROTTLED"
  | "TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "REMOTE_PROTOCOL_ERROR"
  | "INTERNAL_ERROR";

export class NotebookError extends Error {
  override readonly name = "NotebookError";

  constructor(
    readonly code: NotebookErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function notebookExitCode(code: NotebookErrorCode): number {
  switch (code) {
    case "INVALID_INPUT": return 2;
    case "NOT_CONFIGURED":
    case "AUTHENTICATION_FAILED": return 3;
    case "NOT_FOUND":
    case "CONFLICT":
    case "CROSS_PROJECT":
    case "DRIFT_DETECTED": return 4;
    case "THROTTLED":
    case "TIMEOUT":
    case "SERVICE_UNAVAILABLE": return 5;
    case "REMOTE_PROTOCOL_ERROR":
    case "INTERNAL_ERROR": return 6;
  }
}

export interface NotebookLimitsV1 {
  schema_version: 1;
  overview_max_chars: number;
  request_max_bytes: number;
  response_max_bytes: number;
  note_max_bytes: number;
  source_file_max_bytes: number;
  list_max_items: number;
  note_detail_fetch_concurrency: number;
  excerpt_max_chars: number;
  diagnostic_max_chars: number;
  overall_timeout_ms: number;
  hook_session_start_timeout_ms: number;
  hook_session_end_timeout_ms: number;
  hook_payload_max_bytes: number;
  receipt_succeeded_retention_days: number;
  receiptless_session_retention_seconds: number;
  unresolved_receipt_max_count: number;
  unresolved_receipt_max_bytes: number;
  /** Shared serialized ceiling for SessionBaselineV1 and CaptureReceiptV1 state records. */
  receipt_max_bytes: number;
  automatic_attempt_limit: number;
  lease_seconds: number;
  integrity_max_entries: number;
  refusal_max_entries: number;
}

/**
 * One versioned source for every finite v1 boundary. Operators may tighten
 * these values in global registry configuration; adapters and hooks must not
 * invent private defaults.
 */
export const DEFAULT_NOTEBOOK_LIMITS: Readonly<NotebookLimitsV1> = Object.freeze({
  schema_version: 1,
  overview_max_chars: 4_000,
  request_max_bytes: 1_048_576,
  response_max_bytes: 4_194_304,
  note_max_bytes: 1_048_576,
  source_file_max_bytes: 524_288,
  list_max_items: 1_000,
  note_detail_fetch_concurrency: 8,
  excerpt_max_chars: 320,
  diagnostic_max_chars: 512,
  overall_timeout_ms: 5_000,
  hook_session_start_timeout_ms: 2_000,
  hook_session_end_timeout_ms: 250,
  hook_payload_max_bytes: 1_048_576,
  receipt_succeeded_retention_days: 30,
  receiptless_session_retention_seconds: 86_400,
  unresolved_receipt_max_count: 100,
  unresolved_receipt_max_bytes: 8_388_608,
  receipt_max_bytes: 131_072,
  automatic_attempt_limit: 2,
  lease_seconds: 300,
  integrity_max_entries: 20,
  refusal_max_entries: 100,
});

export interface NotebookAuthConfigV1 {
  mode: "none" | "environment";
  env_var?: string;
}

export interface NotebookPolicyV1 {
  enabled: boolean;
  session_start_enabled: boolean;
  session_capture_enabled: boolean;
  overview_max_chars: number;
  documentation_globs: string[];
  overview_references?: string[];
  excluded_globs?: string[];
}

export interface NotebookGlobalConfigV1 {
  base_url?: string;
  auth?: NotebookAuthConfigV1;
  defaults?: Partial<NotebookPolicyV1>;
  limits?: Partial<NotebookLimitsV1>;
  summarizer?: { executable: string; args?: string[] };
  [key: string]: unknown;
}

export interface ProjectNotebookBindingV1 {
  state: NotebookBindingState;
  notebook_id?: string;
  notebook_name?: string;
  overview_note_id?: string;
  blocked_reason?: string;
  [key: string]: unknown;
}

export interface ProjectNotebookConfigV1 {
  binding: ProjectNotebookBindingV1;
  policy?: Partial<NotebookPolicyV1>;
  /** Optional operator-owned display name; stable identity remains the project slug and remote ID. */
  display_name?: string;
  [key: string]: unknown;
}

export interface EffectiveNotebookConfigV1 {
  schema_version: 1;
  project_slug: string;
  repo_path: string;
  base_url: string | null;
  auth: NotebookAuthConfigV1;
  policy: NotebookPolicyV1;
  limits: NotebookLimitsV1;
  binding: ProjectNotebookBindingV1;
  configuration_provenance: Record<string, "default" | "registry-global" | "project-registry" | "manifest-policy">;
  summarizer?: { executable: string; args: string[] };
}

export interface OpenNotebookNotebookV1 {
  id: string;
  name: string;
  description?: string | null;
  archived?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface OpenNotebookNoteV1 {
  id: string;
  title: string;
  content: string;
  note_type: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface NoteSummaryV1 {
  id: string;
  title: string;
  note_type: string;
  created_at: string | null;
  updated_at: string | null;
  excerpt: string;
}

export interface NoteDetailV1 extends Omit<NoteSummaryV1, "excerpt"> {
  content: string;
}

export interface OverviewReferenceV1 {
  path: string;
  status: "present" | "missing";
  git_revision?: string;
  content_sha256?: string;
  reason?: string;
}

export interface OverviewDescriptorV1 {
  schema_version: 1;
  project_slug: string;
  project_name: string;
  purpose: string;
  references: OverviewReferenceV1[];
  compiler_policy_version: string;
}

export interface PjanglerNoteEnvelopeV1 {
  schema_version: 1;
  project_slug: string;
  kind: NotebookNoteKind;
  logical_id: string;
  source_path?: string;
  source_revision?: string;
  content_sha256?: string;
  session_key?: string;
  captured_at?: string;
  policy_version?: string;
  overview_descriptor?: OverviewDescriptorV1;
}

export interface NotebookProjectSummaryV1 {
  slug: string;
  repo_path: string;
}

export interface NotebookEnvelopeV1<T = unknown> {
  schema_version: 1;
  ok: boolean;
  command: string;
  project: NotebookProjectSummaryV1;
  notebook: {
    binding_state: NotebookBindingState;
    health: NotebookHealth;
    id: string | null;
    name: string | null;
  };
  data: T | null;
  error: null | {
    code: NotebookErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
  next_actions: string[];
}

export interface SessionBaselineV1 {
  schema_version: 1;
  session_key: string;
  project_slug: string;
  client: string;
  created_at: string;
  repo_path_digest: string;
  git_head: string | null;
  git_status_digest: string | null;
  policy_version: string;
  tracked_path_digests: Record<string, string>;
  pre_dirty_paths: string[];
  complete: boolean;
  incomplete_reasons: string[];
}

export interface OverviewClaimV1 {
  schema_version: 1;
  session_key: string;
  project_slug: string;
  created_at: string;
  overview_note_id: string;
  content_sha256: string;
}

export interface CaptureReceiptV1 {
  schema_version: 1;
  receipt_id: string;
  logical_id: string;
  session_key: string;
  project_slug: string;
  repo_path_digest: string;
  baseline_ref: string | null;
  manual_baseline_ref?: string;
  end_revision: string | null;
  end_status_digest: string | null;
  state: NotebookReceiptState;
  automatic_attempts_used: number;
  automatic_attempt_limit: number;
  manual_retry_count: number;
  attempt_origin: NotebookAttemptOrigin;
  lease_owner: string | null;
  lease_deadline: string | null;
  created_at: string;
  updated_at: string;
  exclusion_counts: Record<string, number>;
  summary_mode: "configured" | "deterministic-fallback" | null;
  note_logical_ids: string[];
  remote_note_ids: string[];
  error_category: NotebookErrorCode | null;
  retryable: boolean;
  diagnostic: string | null;
  serialized_bytes: number;
}

export interface CaptureReceiptSummaryV1 {
  receipt_id: string;
  logical_id: string;
  session_key: string;
  state: NotebookReceiptState;
  created_at: string;
  updated_at: string;
  automatic_attempts_used: number;
  automatic_attempt_limit: number;
  manual_retry_count: number;
  attempt_origin: NotebookAttemptOrigin;
  error_category: NotebookErrorCode | null;
  retryable: boolean;
  diagnostic: string | null;
  summary_mode: "configured" | "deterministic-fallback" | null;
  exclusion_counts: Record<string, number>;
  note_logical_ids: string[];
  remote_note_ids: string[];
  serialized_bytes: number;
}

export type RetentionRefusalReason = "count-cap" | "byte-cap" | "both";

export interface RetentionRefusalV1 {
  schema_version: 1;
  session_key: string;
  baseline_created_at: string;
  refused_at: string;
  reason: RetentionRefusalReason;
  current_count: number;
  current_bytes: number;
  candidate_bytes: number;
  max_count: number;
  max_bytes: number;
  next_actions: string[];
}

export interface RetentionRefusalSummaryV1 extends Omit<RetentionRefusalV1, "schema_version" | "baseline_created_at"> {
  outcome: "capture-refused-history";
}

export interface CaptureIntegrityEntryV1 {
  entry_id: string;
  reason: "invalid-json" | "unreadable" | "non-regular" | "invalid-schema" | "oversize" | "unsafe-permissions";
}

export interface CaptureAdmissionSummaryV1 {
  unresolved_count: number | null;
  unresolved_count_lower_bound: number;
  unresolved_bytes: number | null;
  unresolved_bytes_lower_bound: number;
  unmeasurable_entry_count: number;
  integrity_entries: CaptureIntegrityEntryV1[];
  receipt_caps: { max_count: number; max_bytes: number };
  receiptless_session_count: number;
  stale_receiptless_session_count: number;
  active_refusals: RetentionRefusalSummaryV1[];
}

export interface RemoteMutationJournalSummaryV1 {
  operation_id: string;
  kind: "notebook.create" | "note.create";
  logical_marker: string;
  session_key: string | null;
  state: "prepared" | "possibly-dispatched" | "reconciled";
  binding_id: string | null;
  candidate_ids: string[];
  result_category: string;
  next_action: string;
}

export interface NotebookFindingV1 {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  summary: string;
  details: string[];
  fixable: boolean;
}

export const UNRESOLVED_RECEIPT_STATES: ReadonlySet<NotebookReceiptState> = new Set([
  "queued",
  "processing",
  "failed",
  "retry-exhausted",
  "blocked-missing-baseline",
]);
