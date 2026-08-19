import {
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  notebookExitCode,
  type EffectiveNotebookConfigV1,
  type NotebookEnvelopeV1,
  type NotebookErrorCode,
  type NotebookHealth,
} from "./types";

function bounded(value: string, max = 512): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}

export function successEnvelope<T>(command: string, config: EffectiveNotebookConfigV1, data: T, health: NotebookHealth = null, nextActions: string[] = []): NotebookEnvelopeV1<T> {
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    ok: true,
    command,
    project: { slug: config.project_slug, repo_path: config.repo_path },
    notebook: {
      binding_state: config.binding.state,
      health,
      id: config.binding.notebook_id ?? null,
      name: config.binding.notebook_name ?? null,
    },
    data,
    error: null,
    next_actions: nextActions.map((item) => bounded(item)),
  };
}

export function failureEnvelope(command: string, config: EffectiveNotebookConfigV1, error: unknown, health: NotebookHealth = null, nextActions: string[] = []): NotebookEnvelopeV1<never> {
  const normalized = normalizeNotebookError(error);
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    ok: false,
    command,
    project: { slug: config.project_slug, repo_path: config.repo_path },
    notebook: {
      binding_state: config.binding.state,
      health,
      id: config.binding.notebook_id ?? null,
      name: config.binding.notebook_name ?? null,
    },
    data: null,
    error: {
      code: normalized.code,
      message: bounded(normalized.message),
      retryable: normalized.retryable,
      details: sanitizeDetails(normalized.details),
    },
    next_actions: nextActions.map((item) => bounded(item)),
  };
}

export function normalizeNotebookError(error: unknown): NotebookError {
  if (error instanceof NotebookError) return error;
  // Unknown exceptions are not an operator-facing protocol. Runtime, parser,
  // filesystem, and tool messages routinely contain absolute paths, payload
  // fragments, or ambient secret values. Preserve the original only as an
  // in-memory cause and expose one stable categorized diagnostic.
  return new NotebookError("INTERNAL_ERROR", "Project Notebook encountered an unexpected internal error", false, {}, { cause: error });
}

export function renderNotebookJson(envelope: NotebookEnvelopeV1): string {
  validateNotebookEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function notebookEnvelopeExitCode(envelope: NotebookEnvelopeV1): number {
  return envelope.ok || !envelope.error ? 0 : notebookExitCode(envelope.error.code);
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (typeof value === "string") result[key] = bounded(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
  }
  return result;
}

export function validateNotebookEnvelope(value: NotebookEnvelopeV1): void {
  const invalid = (reason: string): never => { throw new NotebookError("INTERNAL_ERROR", `Notebook command produced an invalid JSON v1 envelope: ${reason}`); };
  const record = (candidate: unknown, reason: string): Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid(reason);
    return candidate as Record<string, unknown>;
  };
  const exact = (candidate: Record<string, unknown>, keys: readonly string[], reason: string): void => {
    const actual = Object.keys(candidate).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(reason);
  };
  const string = (candidate: unknown, reason: string, max = 4_096, allowEmpty = false): candidate is string => {
    if (typeof candidate !== "string" || (!allowEmpty && candidate.length === 0) || Buffer.byteLength(candidate, "utf8") > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate)) invalid(reason);
    return true;
  };
  const nullableString = (candidate: unknown, reason: string, max = 4_096): void => {
    if (candidate !== null) string(candidate, reason, max);
  };
  const integer = (candidate: unknown, reason: string): void => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) invalid(reason);
  };
  const stringList = (candidate: unknown, reason: string, maxItems = 1_000): void => {
    if (!Array.isArray(candidate) || (candidate as unknown[]).length > maxItems) invalid(reason);
    for (const item of candidate as unknown[]) string(item, reason, 4_096);
  };
  const errorCodes = new Set<NotebookErrorCode>(["INVALID_INPUT", "NOT_CONFIGURED", "AUTHENTICATION_FAILED", "NOT_FOUND", "CONFLICT", "CROSS_PROJECT", "DRIFT_DETECTED", "THROTTLED", "TIMEOUT", "SERVICE_UNAVAILABLE", "REMOTE_PROTOCOL_ERROR", "INTERNAL_ERROR"]);
  const commands = new Set([
    "notebook.status", "notebook.create", "notebook.notes.list", "notebook.notes.add", "notebook.notes.get", "notebook.notes.update", "notebook.notes.delete", "notebook.notes.search",
    "notebook.overview.get", "notebook.overview.set", "notebook.capture.list", "notebook.capture.retry", "notebook.audit", "notebook.migrate",
  ]);
  const root = record(value, "root must be an object");
  exact(root, ["schema_version", "ok", "command", "project", "notebook", "data", "error", "next_actions"], "root fields differ from v1");
  if (root.schema_version !== 1 || typeof root.ok !== "boolean" || typeof root.command !== "string" || !commands.has(root.command)) invalid("schema version, ok, or command is invalid");
  const project = record(root.project, "project must be an object");
  exact(project, ["slug", "repo_path"], "project fields differ from v1");
  string(project.slug, "project slug is invalid", 128);
  string(project.repo_path, "project repo_path is invalid", 4_096);
  const notebook = record(root.notebook, "notebook must be an object");
  exact(notebook, ["binding_state", "health", "id", "name"], "notebook fields differ from v1");
  if (!new Set(["disabled", "planned", "linked"]).has(String(notebook.binding_state))) invalid("binding state is invalid");
  if (!new Set([null, "unconfigured", "healthy", "drifted", "unavailable", "blocked"]).has(notebook.health as null | string)) invalid("health is invalid");
  nullableString(notebook.id, "notebook id is invalid", 512);
  nullableString(notebook.name, "notebook name is invalid", 512);
  stringList(root.next_actions, "next_actions is invalid", 20);
  if (root.ok === (root.error !== null) || (root.ok ? root.data === null : root.data !== null)) invalid("success/error invariant failed");
  if (!root.ok) {
    const error = record(root.error, "error must be an object");
    exact(error, ["code", "message", "retryable", "details"], "error fields differ from v1");
    if (typeof error.code !== "string" || !errorCodes.has(error.code as NotebookErrorCode)) invalid("error code is invalid");
    string(error.message, "error message is invalid", 512);
    if (typeof error.retryable !== "boolean") invalid("error retryable is invalid");
    const details = record(error.details, "error details must be an object");
    if (Object.keys(details).length > 20 || Object.entries(details).some(([key, item]) => !key || !(["string", "number", "boolean"].includes(typeof item) || item === null))) invalid("error details are invalid");
    return;
  }

  const noteSummary = (candidate: unknown, detail: boolean): void => {
    const note = record(candidate, "note must be an object");
    exact(note, ["id", "title", "note_type", "created_at", "updated_at", detail ? "content" : "excerpt"], "note fields differ from v1");
    for (const key of ["id", "title", "note_type"] as const) string(note[key], `note ${key} is invalid`, 4_096);
    nullableString(note.created_at, "note created_at is invalid", 128);
    nullableString(note.updated_at, "note updated_at is invalid", 128);
    string(note[detail ? "content" : "excerpt"], `note ${detail ? "content" : "excerpt"} is invalid`, detail ? 1_048_576 : 16_384, true);
  };
  const receipt = (candidate: unknown): void => {
    const item = record(candidate, "capture receipt must be an object");
    exact(item, ["receipt_id", "logical_id", "session_key", "state", "created_at", "updated_at", "automatic_attempts_used", "automatic_attempt_limit", "manual_retry_count", "attempt_origin", "error_category", "retryable", "diagnostic", "summary_mode", "exclusion_counts", "note_logical_ids", "remote_note_ids", "serialized_bytes"], "receipt fields differ from v1");
    for (const key of ["receipt_id", "logical_id", "session_key", "created_at", "updated_at"] as const) string(item[key], `receipt ${key} is invalid`, 512);
    if (!new Set(["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"]).has(String(item.state))) invalid("receipt state is invalid");
    for (const key of ["automatic_attempts_used", "automatic_attempt_limit", "manual_retry_count", "serialized_bytes"] as const) integer(item[key], `receipt ${key} is invalid`);
    if (item.attempt_origin !== "automatic" && item.attempt_origin !== "operator") invalid("receipt attempt origin is invalid");
    if (item.error_category !== null && (typeof item.error_category !== "string" || !errorCodes.has(item.error_category as NotebookErrorCode))) invalid("receipt error category is invalid");
    if (typeof item.retryable !== "boolean") invalid("receipt retryable is invalid");
    nullableString(item.diagnostic, "receipt diagnostic is invalid", 512);
    if (item.summary_mode !== null && item.summary_mode !== "configured" && item.summary_mode !== "deterministic-fallback") invalid("receipt summary mode is invalid");
    const exclusions = record(item.exclusion_counts, "receipt exclusions must be an object");
    if (Object.entries(exclusions).some(([key, count]) => !key || !Number.isSafeInteger(count) || Number(count) < 0)) invalid("receipt exclusions are invalid");
    stringList(item.note_logical_ids, "receipt logical IDs are invalid");
    stringList(item.remote_note_ids, "receipt remote IDs are invalid");
  };
  const finding = (candidate: unknown): void => {
    const item = record(candidate, "finding must be an object");
    exact(item, ["id", "title", "status", "summary", "details", "fixable"], "finding fields differ from v1");
    for (const key of ["id", "title", "summary"] as const) string(item[key], `finding ${key} is invalid`, 4_096);
    if (!new Set(["pass", "fail", "warn", "skip"]).has(String(item.status)) || typeof item.fixable !== "boolean") invalid("finding status/fixable is invalid");
    stringList(item.details, "finding details are invalid", 100);
  };
  const admission = (candidate: unknown): void => {
    const item = record(candidate, "capture admission must be an object");
    exact(item, ["unresolved_count", "unresolved_count_lower_bound", "unresolved_bytes", "unresolved_bytes_lower_bound", "unmeasurable_entry_count", "integrity_entries", "receipt_caps", "receiptless_session_count", "stale_receiptless_session_count", "active_refusals"], "capture admission fields differ from v1");
    for (const key of ["unresolved_count_lower_bound", "unresolved_bytes_lower_bound", "unmeasurable_entry_count", "receiptless_session_count", "stale_receiptless_session_count"] as const) integer(item[key], `capture admission ${key} is invalid`);
    for (const key of ["unresolved_count", "unresolved_bytes"] as const) if (item[key] !== null) integer(item[key], `capture admission ${key} is invalid`);
    const caps = record(item.receipt_caps, "receipt caps must be an object"); exact(caps, ["max_count", "max_bytes"], "receipt cap fields differ from v1"); integer(caps.max_count, "receipt max_count is invalid"); integer(caps.max_bytes, "receipt max_bytes is invalid");
    if (!Array.isArray(item.integrity_entries) || !Array.isArray(item.active_refusals)) invalid("capture admission lists are invalid");
    for (const entryValue of item.integrity_entries as unknown[]) { const entry = record(entryValue, "integrity entry is invalid"); exact(entry, ["entry_id", "reason"], "integrity entry fields differ from v1"); string(entry.entry_id, "integrity entry id is invalid"); string(entry.reason, "integrity reason is invalid"); }
    for (const refusalValue of item.active_refusals as unknown[]) { const refusal = record(refusalValue, "retention refusal is invalid"); exact(refusal, ["outcome", "session_key", "refused_at", "reason", "current_count", "current_bytes", "candidate_bytes", "max_count", "max_bytes", "next_actions"], "retention refusal fields differ from v1"); if (refusal.outcome !== "capture-refused-history") invalid("retention refusal outcome is invalid"); for (const key of ["session_key", "refused_at", "reason"] as const) string(refusal[key], `retention refusal ${key} is invalid`); for (const key of ["current_count", "current_bytes", "candidate_bytes", "max_count", "max_bytes"] as const) integer(refusal[key], `retention refusal ${key} is invalid`); stringList(refusal.next_actions, "retention refusal actions are invalid", 10); }
  };
  const data = record(root.data, "data must be an object");
  switch (root.command) {
    case "notebook.create": exact(data, ["created", "adopted", "notebook_id", "overview_note_id"], "create fields differ from v1"); if (typeof data.created !== "boolean" || typeof data.adopted !== "boolean") invalid("create flags are invalid"); string(data.notebook_id, "created notebook id is invalid"); string(data.overview_note_id, "created Overview id is invalid"); break;
    case "notebook.notes.list": exact(data, ["items", "next_cursor"], "note list fields differ from v1"); if (!Array.isArray(data.items)) invalid("note list items are invalid"); (data.items as unknown[]).forEach((item) => noteSummary(item, false)); nullableString(data.next_cursor, "note cursor is invalid", 16_384); break;
    case "notebook.notes.search": exact(data, ["items", "next_cursor", "query_tokens"], "search fields differ from v1"); if (!Array.isArray(data.items) || data.next_cursor !== null) invalid("search list/cursor is invalid"); (data.items as unknown[]).forEach((item) => noteSummary(item, false)); stringList(data.query_tokens, "query tokens are invalid", 100); break;
    case "notebook.notes.add": case "notebook.notes.get": case "notebook.notes.update": exact(data, ["note"], "note detail fields differ from v1"); noteSummary(data.note, true); break;
    case "notebook.notes.delete": exact(data, ["deleted_id"], "delete fields differ from v1"); string(data.deleted_id, "deleted id is invalid"); break;
    case "notebook.overview.get": case "notebook.overview.set": exact(data, ["note", "updated", "drift"], "Overview fields differ from v1"); noteSummary(data.note, true); if (typeof data.updated !== "boolean" || !Array.isArray(data.drift)) invalid("Overview update/drift is invalid"); for (const driftValue of data.drift as unknown[]) { const drift = record(driftValue, "Overview drift is invalid"); exact(drift, ["path", "reason"], "Overview drift fields differ from v1"); string(drift.path, "Overview drift path is invalid"); string(drift.reason, "Overview drift reason is invalid"); } break;
    case "notebook.capture.list": exact(data, ["items", "next_cursor"], "capture list fields differ from v1"); if (!Array.isArray(data.items)) invalid("capture items are invalid"); (data.items as unknown[]).forEach(receipt); if (data.next_cursor !== null) string(data.next_cursor, "capture cursor is invalid"); break;
    case "notebook.capture.retry": exact(data, ["receipt"], "capture retry fields differ from v1"); receipt(data.receipt); break;
    case "notebook.audit": exact(data, ["rules", "audited_at", "remote_check", "capture_admission"], "audit fields differ from v1"); if (!Array.isArray(data.rules)) invalid("audit rules are invalid"); (data.rules as unknown[]).forEach(finding); string(data.audited_at, "audit time is invalid", 128); if (!new Set(["pass", "fail", "skip"]).has(String(data.remote_check))) invalid("audit remote_check is invalid"); admission(data.capture_admission); break;
    case "notebook.status": exact(data, ["policy", "configuration_provenance", "remote_check", "unresolved_receipt_count", "unresolved_receipt_bytes", "receipt_caps", "capture_admission", "findings"], "status fields differ from v1"); record(data.policy, "status policy is invalid"); record(data.configuration_provenance, "status provenance is invalid"); if (!new Set(["pass", "fail", "skip"]).has(String(data.remote_check))) invalid("status remote_check is invalid"); if (data.unresolved_receipt_count !== null) integer(data.unresolved_receipt_count, "status unresolved count is invalid"); if (data.unresolved_receipt_bytes !== null) integer(data.unresolved_receipt_bytes, "status unresolved bytes is invalid"); { const caps = record(data.receipt_caps, "status receipt caps are invalid"); exact(caps, ["max_count", "max_bytes"], "status cap fields differ from v1"); integer(caps.max_count, "status max_count is invalid"); integer(caps.max_bytes, "status max_bytes is invalid"); } admission(data.capture_admission); if (!Array.isArray(data.findings)) invalid("status findings are invalid"); (data.findings as unknown[]).forEach(finding); break;
    case "notebook.migrate": exact(data, ["dry_run", "selected_rules", "results", "changed_files"], "migration fields differ from v1"); if (typeof data.dry_run !== "boolean" || !Array.isArray(data.results)) invalid("migration plan is invalid"); stringList(data.selected_rules, "migration selected rules are invalid", 20); stringList(data.changed_files, "migration changed files are invalid", 1_000); for (const resultValue of data.results as unknown[]) { const result = record(resultValue, "migration result is invalid"); exact(result, ["id", "status", "summary"], "migration result fields differ from v1"); string(result.id, "migration result id is invalid"); string(result.summary, "migration result summary is invalid"); if (!new Set(["planned", "applied", "noop", "blocked"]).has(String(result.status))) invalid("migration result status is invalid"); } break;
  }
}

export function errorCode(value: unknown): NotebookErrorCode {
  return normalizeNotebookError(value).code;
}
