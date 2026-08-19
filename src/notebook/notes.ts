import { createHash, randomUUID } from "node:crypto";
import {
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  type NoteDetailV1,
  type NoteSummaryV1,
  type OpenNotebookNoteV1,
  type PjanglerNoteEnvelopeV1,
} from "./types";

export const NOTE_ENVELOPE_PREFIX = "<!-- pjangler-note-v1:";
const NOTE_ENVELOPE_RE = /^<!-- pjangler-note-v1:([A-Za-z0-9_-]+) -->\r?\n/;

export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new NotebookError("INVALID_INPUT", "Canonical JSON value is not JSON-compatible");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new NotebookError("INVALID_INPUT", "Canonical JSON value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function encodeNoteEnvelope(envelope: PjanglerNoteEnvelopeV1): string {
  validateNoteEnvelope(envelope);
  return `${NOTE_ENVELOPE_PREFIX}${base64UrlEncode(canonicalJson(envelope))} -->`;
}

export function withNoteEnvelope(envelope: PjanglerNoteEnvelopeV1, body: string): string {
  return `${encodeNoteEnvelope(envelope)}\n${body}`;
}

export function parseNoteEnvelope(content: string, maxBytes = 16_384): { envelope: PjanglerNoteEnvelopeV1; body: string } | null {
  const firstNewline = content.indexOf("\n");
  const prefixBytes = Buffer.byteLength(firstNewline >= 0 ? content.slice(0, firstNewline + 1) : content, "utf8");
  if (prefixBytes > maxBytes) return null;
  const match = NOTE_ENVELOPE_RE.exec(content);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1]!, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > maxBytes) return null;
    const parsed = JSON.parse(decoded) as unknown;
    validateNoteEnvelope(parsed);
    return { envelope: parsed, body: content.slice(match[0].length) };
  } catch {
    return null;
  }
}

export function validateNoteEnvelope(value: unknown): asserts value is PjanglerNoteEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note envelope");
  const envelope = value as Partial<PjanglerNoteEnvelopeV1>;
  if (envelope.schema_version !== NOTEBOOK_SCHEMA_VERSION) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Unsupported PJangler note envelope version");
  if (!isBoundedString(envelope.project_slug, 128) || !isBoundedString(envelope.logical_id, 256)) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note identity");
  }
  if (!(["overview", "user-note", "document", "session-capture"] as const).includes(envelope.kind as never)) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note kind");
  }
  const allowed = new Set(["schema_version", "project_slug", "kind", "logical_id", "source_path", "source_revision", "content_sha256", "session_key", "captured_at", "policy_version", "overview_descriptor"]);
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowed.has(key))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "PJangler note envelope contains an unknown field");
  if (envelope.source_path !== undefined && (!isBoundedString(envelope.source_path, 1_024) || envelope.source_path.startsWith("/") || envelope.source_path.includes("\0") || envelope.source_path.split(/[\\/]/u).includes(".."))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler source path");
  if (envelope.source_revision !== undefined && !isBoundedString(envelope.source_revision, 256)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler source revision");
  for (const [name, digest] of [["content_sha256", envelope.content_sha256], ["session_key", envelope.session_key]] as const) {
    if (digest !== undefined && !/^[a-f0-9]{64}$/u.test(digest)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", `Invalid PJangler ${name}`);
  }
  if (envelope.captured_at !== undefined && (typeof envelope.captured_at !== "string" || !Number.isFinite(Date.parse(envelope.captured_at)))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler capture timestamp");
  if (envelope.policy_version !== undefined && !isBoundedString(envelope.policy_version, 128)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler policy version");
  if (envelope.kind === "overview") {
    if (envelope.logical_id !== overviewLogicalId(envelope.project_slug)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview logical ID does not match project slug");
    validateOverviewDescriptor(envelope.overview_descriptor, envelope.project_slug);
  } else if (envelope.overview_descriptor !== undefined) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Only Overview notes may carry an Overview descriptor");
  if (envelope.kind === "user-note" && !/^user-note:v1:[a-f0-9-]{16,64}$/iu.test(envelope.logical_id)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid user-note logical ID");
  if ((envelope.kind === "document" || envelope.kind === "session-capture") && !/^[a-f0-9]{64}$/u.test(envelope.logical_id)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid managed note logical ID");
  if (envelope.kind === "document" && (!envelope.source_path || !envelope.source_revision || !envelope.content_sha256 || !envelope.session_key || !envelope.captured_at || !envelope.policy_version)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Document envelope is missing required provenance");
  if (envelope.kind === "session-capture" && (!envelope.content_sha256 || !envelope.session_key || !envelope.captured_at || !envelope.policy_version)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Session capture envelope is missing required provenance");
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateOverviewDescriptor(value: unknown, projectSlug: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview descriptor is missing or invalid");
  const descriptor = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "project_slug", "project_name", "purpose", "references", "compiler_policy_version"]);
  if (Object.keys(descriptor).some((key) => !allowed.has(key)) || descriptor.schema_version !== 1 || descriptor.project_slug !== projectSlug
    || !isBoundedString(descriptor.project_name, 256) || !isBoundedString(descriptor.purpose, 4_000)
    || !isBoundedString(descriptor.compiler_policy_version, 128) || !Array.isArray(descriptor.references) || descriptor.references.length > 100) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview descriptor shape is invalid");
  }
  const paths = new Set<string>();
  for (const referenceValue of descriptor.references) {
    if (!referenceValue || typeof referenceValue !== "object" || Array.isArray(referenceValue)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview reference is invalid");
    const reference = referenceValue as Record<string, unknown>;
    const referenceAllowed = new Set(["path", "status", "git_revision", "content_sha256", "reason"]);
    if (Object.keys(reference).some((key) => !referenceAllowed.has(key)) || !isBoundedString(reference.path, 1_024)
      || String(reference.path).startsWith("/") || String(reference.path).split(/[\\/]/u).includes("..") || paths.has(String(reference.path))
      || (reference.status !== "present" && reference.status !== "missing")) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview reference shape is invalid");
    paths.add(String(reference.path));
    if (reference.status === "present") {
      if (!isBoundedString(reference.git_revision, 256) || !/^[a-f0-9]{64}$/u.test(String(reference.content_sha256 ?? "")) || reference.reason !== undefined) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Present Overview reference provenance is invalid");
    } else if (!isBoundedString(reference.reason, 128) || reference.git_revision !== undefined || reference.content_sha256 !== undefined) {
      throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Missing Overview reference provenance is invalid");
    }
  }
}

export function userNoteLogicalId(operationId: string = randomUUID()): string {
  return `user-note:v1:${operationId}`;
}

export function overviewLogicalId(projectSlug: string): string {
  return `overview:v1:${projectSlug}`;
}

export function documentLogicalId(projectSlug: string, sourcePath: string): string {
  return sha256Hex(`pjangler-document-v1\0${projectSlug}\0${sourcePath.normalize("NFC")}`);
}

export function sessionCaptureLogicalId(sessionKey: string): string {
  return sha256Hex(`pjangler-capture-v1\0${sessionKey}`);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let used = 0;
  const result: string[] = [];
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > maxBytes) break;
    result.push(point);
    used += bytes;
  }
  return result.join("");
}

export function noteDetail(note: OpenNotebookNoteV1, maxBytes: number): NoteDetailV1 {
  const parsed = parseNoteEnvelope(note.content);
  return {
    id: note.id,
    title: note.title,
    note_type: note.note_type,
    created_at: note.created_at,
    updated_at: note.updated_at,
    content: truncateUtf8(parsed?.body ?? note.content, maxBytes),
  };
}

export function noteSummary(note: OpenNotebookNoteV1, excerptMaxChars: number): NoteSummaryV1 {
  const body = parseNoteEnvelope(note.content)?.body ?? note.content;
  const excerpt = Array.from(body.replace(/\s+/gu, " ").trim()).slice(0, excerptMaxChars).join("");
  return {
    id: note.id,
    title: note.title,
    note_type: note.note_type,
    created_at: note.created_at,
    updated_at: note.updated_at,
    excerpt,
  };
}

export interface LocalSearchResultV1 {
  items: NoteSummaryV1[];
  next_cursor: null;
  query_tokens: string[];
}

export function tokenizeSearch(value: string): string[] {
  const tokens = value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)];
}

function countTokens(haystack: string[], needle: string): number {
  let count = 0;
  for (const token of haystack) if (token === needle) count += 1;
  return count;
}

export function searchNotesLocally(notes: readonly OpenNotebookNoteV1[], query: string, limit: number, excerptMaxChars: number): LocalSearchResultV1 {
  const queryTokens = tokenizeSearch(query);
  if (!queryTokens.length) throw new NotebookError("INVALID_INPUT", "Search query must contain at least one letter or number");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new NotebookError("INVALID_INPUT", "Search limit must be a positive integer");

  const scored = notes.flatMap((note) => {
    const body = parseNoteEnvelope(note.content)?.body ?? note.content;
    const titleTokens = tokenizeSearch(note.title);
    const bodyTokens = tokenizeSearch(body);
    if (!queryTokens.every((token) => titleTokens.includes(token) || bodyTokens.includes(token))) return [];
    const score = queryTokens.reduce((sum, token) => sum + (10 * countTokens(titleTokens, token)) + countTokens(bodyTokens, token), 0);
    return [{ note, body, score }];
  });

  const timestamp = (value: string | null): number => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  scored.sort((left, right) =>
    right.score - left.score
    || timestamp(right.note.updated_at) - timestamp(left.note.updated_at)
    || left.note.id.localeCompare(right.note.id, "en"));

  return {
    items: scored.slice(0, limit).map(({ note, body }) => {
      const normalizedBody = body.replace(/\s+/gu, " ").trim().normalize("NFKC");
      const lower = normalizedBody.toLocaleLowerCase("und");
      const starts = queryTokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
      const start = starts.length ? Math.min(...starts) : 0;
      return { ...noteSummary(note, excerptMaxChars), excerpt: Array.from(normalizedBody.slice(start)).slice(0, excerptMaxChars).join("") };
    }),
    next_cursor: null,
    query_tokens: queryTokens,
  };
}
