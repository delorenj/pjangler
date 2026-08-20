import { runtimeNotebookCredential, validateNotebookBaseUrl } from "./config";
import {
  NotebookError,
  type EffectiveNotebookConfigV1,
  type OpenNotebookNotebookV1,
  type OpenNotebookNoteV1,
} from "./types";

export interface OpenNotebookHealthV1 {
  version: string | null;
  auth_enabled: boolean | null;
}

export interface OpenNotebookClientOptions {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  /** Absolute performance.now() deadline shared by a composite hook action. */
  deadlineMonotonicMs?: number;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
  allowEmpty?: boolean;
  possiblyDispatched?: () => void;
  definitivelyRejected?: (status: 400 | 422) => void;
  skipAuthProbe?: boolean;
  suppressAuthorization?: boolean;
};

export type OpenNotebookTransportNoteType = "human" | "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, max = 1_048_576): string {
  if (typeof value !== "string" || value.length > max) throw new NotebookError("REMOTE_PROTOCOL_ERROR", `Open Notebook returned invalid ${name}`);
  return value;
}

function optionalString(value: unknown, name: string, max = 8_192): string | null | undefined {
  if (value == null) return value as null | undefined;
  return boundedString(value, name, max);
}

function responseTimestamp(value: Record<string, unknown>, current: "created" | "updated", legacy: "created_at" | "updated_at", subject: "notebook" | "note"): string | null | undefined {
  return optionalString(value[current] !== undefined ? value[current] : value[legacy], `${subject} ${current}`, 128);
}

export function normalizeOpenNotebookNoteType(value: string | undefined): OpenNotebookTransportNoteType {
  const normalized = value ?? "human";
  if (normalized !== "human" && normalized !== "ai") throw new NotebookError("INVALID_INPUT", "Open Notebook note_type must be human or ai");
  return normalized;
}

function parseNotebook(value: unknown): OpenNotebookNotebookV1 {
  if (!isRecord(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an invalid notebook");
  return {
    id: boundedString(value.id, "notebook id", 512),
    name: boundedString(value.name, "notebook name", 4_096),
    description: optionalString(value.description, "notebook description", 16_384),
    archived: typeof value.archived === "boolean" ? value.archived : undefined,
    created_at: responseTimestamp(value, "created", "created_at", "notebook"),
    updated_at: responseTimestamp(value, "updated", "updated_at", "notebook"),
  };
}

function parseNote(value: unknown, noteMaxBytes: number): OpenNotebookNoteV1 {
  if (!isRecord(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an invalid note");
  const content = boundedString(value.content, "note content", noteMaxBytes);
  if (Buffer.byteLength(content, "utf8") > noteMaxBytes) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook note content exceeds the configured ceiling");
  const noteType = boundedString(value.note_type, "note type", 128);
  if (noteType !== "human" && noteType !== "ai") throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an unsupported note type");
  return {
    id: boundedString(value.id, "note id", 512),
    title: boundedString(value.title, "note title", 4_096),
    content,
    note_type: noteType,
    created_at: responseTimestamp(value, "created", "created_at", "note") ?? null,
    updated_at: responseTimestamp(value, "updated", "updated_at", "note") ?? null,
  };
}

function errorForStatus(status: number, message: string): NotebookError {
  if (status === 400 || status === 422) return new NotebookError("INVALID_INPUT", message, false, { http_status: status, definitive_rejection: true });
  if (status === 401 || status === 403) return new NotebookError("AUTHENTICATION_FAILED", message);
  if (status === 404) return new NotebookError("NOT_FOUND", message);
  if (status === 409) return new NotebookError("CONFLICT", message);
  if (status === 429) return new NotebookError("THROTTLED", message, true);
  if (status >= 500) return new NotebookError("SERVICE_UNAVAILABLE", message, true);
  return new NotebookError("REMOTE_PROTOCOL_ERROR", message);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* best-effort transport release */ }
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook response exceeds the configured ceiling");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the bounded protocol error */ }
        throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook response exceeds the configured ceiling");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

/** Sole HTTP adapter for Open Notebook. Domain callers never construct URLs. */
export class OpenNotebookClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly deadlineMonotonicMs?: number;
  private authEnabled: boolean | null | undefined;

  constructor(readonly config: EffectiveNotebookConfigV1, options: OpenNotebookClientOptions = {}) {
    if (!config.base_url) throw new NotebookError("NOT_CONFIGURED", "Notebook base_url is not configured");
    this.baseUrl = validateNotebookBaseUrl(config.base_url);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.env = options.env ?? process.env;
    this.deadlineMonotonicMs = options.deadlineMonotonicMs;
  }

  async health(): Promise<OpenNotebookHealthV1> {
    const value = await this.request("/api/config", { skipAuthProbe: true, suppressAuthorization: true });
    if (!isRecord(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook /api/config returned a non-object");
    const version = typeof value.version === "string"
      ? value.version.slice(0, 128)
      : typeof value.app_version === "string" ? value.app_version.slice(0, 128) : null;
    const authEnabled = await this.authStatus();
    return { version, auth_enabled: authEnabled };
  }

  async authStatus(): Promise<boolean> {
    const value = await this.request("/api/auth/status", { skipAuthProbe: true, suppressAuthorization: true });
    if (!isRecord(value) || typeof value.auth_enabled !== "boolean") throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook auth status returned an invalid response");
    this.authEnabled = value.auth_enabled;
    return value.auth_enabled;
  }

  async listNotebooks(): Promise<OpenNotebookNotebookV1[]> {
    const value = await this.request("/api/notebooks");
    if (!Array.isArray(value) || value.length > this.config.limits.list_max_items) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook notebook list is invalid or incomplete under configured limits");
    return value.map(parseNotebook);
  }

  async createNotebook(input: { name: string; description?: string }, possiblyDispatched?: () => void): Promise<OpenNotebookNotebookV1> {
    return parseNotebook(await this.request("/api/notebooks", { method: "POST", body: input, possiblyDispatched }));
  }

  async updateNotebook(id: string, input: { name?: string; description?: string; archived?: boolean }): Promise<OpenNotebookNotebookV1> {
    return parseNotebook(await this.request(`/api/notebooks/${encodeURIComponent(id)}`, { method: "PUT", body: input }));
  }

  async listNotes(notebookId: string): Promise<OpenNotebookNoteV1[]> {
    const value = await this.request(`/api/notes?notebook_id=${encodeURIComponent(notebookId)}`);
    if (!Array.isArray(value) || value.length > this.config.limits.list_max_items) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook scoped note list is invalid or incomplete under configured limits");
    return value.map((item) => parseNote(item, this.config.limits.note_max_bytes));
  }

  async createNote(notebookId: string, input: { title: string; content: string; note_type?: string }, possiblyDispatched?: () => void, definitivelyRejected?: (status: 400 | 422) => void): Promise<OpenNotebookNoteV1> {
    if (Buffer.byteLength(input.content, "utf8") > this.config.limits.note_max_bytes) throw new NotebookError("INVALID_INPUT", "Note content exceeds the configured ceiling");
    const noteType = normalizeOpenNotebookNoteType(input.note_type);
    return parseNote(await this.request("/api/notes", {
      method: "POST",
      body: { notebook_id: notebookId, title: input.title, content: input.content, note_type: noteType },
      possiblyDispatched,
      definitivelyRejected,
    }), this.config.limits.note_max_bytes);
  }

  async getOwnedNote(notebookId: string, noteId: string): Promise<OpenNotebookNoteV1> {
    const notes = await this.listNotes(notebookId);
    const note = notes.find((item) => item.id === noteId);
    if (!note) throw new NotebookError("NOT_FOUND", `Note is not a proven member of the bound notebook: ${noteId}`);
    return note;
  }

  async updateOwnedNote(notebookId: string, noteId: string, input: { title?: string; content?: string }): Promise<OpenNotebookNoteV1> {
    if (input.content !== undefined && Buffer.byteLength(input.content, "utf8") > this.config.limits.note_max_bytes) throw new NotebookError("INVALID_INPUT", "Note content exceeds the configured ceiling");
    await this.getOwnedNote(notebookId, noteId);
    return parseNote(await this.request(`/api/notes/${encodeURIComponent(noteId)}`, { method: "PUT", body: input }), this.config.limits.note_max_bytes);
  }

  async deleteOwnedNote(notebookId: string, noteId: string): Promise<void> {
    await this.getOwnedNote(notebookId, noteId);
    await this.request(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE", allowEmpty: true });
  }

  private async ensureAuthProbe(): Promise<void> {
    if (this.authEnabled !== undefined) return;
    if (this.config.auth.mode === "none") { this.authEnabled = null; return; }
    try {
      await this.authStatus();
    } catch (error) {
      // A real 401/403 remains authoritative. Other config-probe failures do
      // not downgrade the requested operation or cause credentials to leak.
      if (error instanceof NotebookError && error.code === "AUTHENTICATION_FAILED") throw error;
      this.authEnabled = null;
    }
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!options.skipAuthProbe) await this.ensureAuthProbe();
    const method = options.method ?? "GET";
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new NotebookError("INVALID_INPUT", "Open Notebook request escaped the configured origin");
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && Buffer.byteLength(body, "utf8") > this.config.limits.request_max_bytes) throw new NotebookError("INVALID_INPUT", "Open Notebook request exceeds the configured ceiling");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (!options.suppressAuthorization && this.config.auth.mode === "environment" && this.authEnabled !== false) {
      headers.Authorization = `Bearer ${runtimeNotebookCredential(this.config, this.env)}`;
    }
    const remaining = this.deadlineMonotonicMs === undefined
      ? this.config.limits.overall_timeout_ms
      : Math.floor(this.deadlineMonotonicMs - performance.now());
    if (remaining <= 0) throw new NotebookError("TIMEOUT", "Open Notebook request timed out", true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.config.limits.overall_timeout_ms, remaining)));
    try {
      options.possiblyDispatched?.();
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook redirect was rejected");
      if (!response.ok) {
        if (response.status === 400 || response.status === 422) options.definitivelyRejected?.(response.status);
        try { await readResponseBody(response, Math.min(this.config.limits.response_max_bytes, 4_096)); }
        catch { /* preserve the categorized HTTP status without response data */ }
        throw errorForStatus(response.status, `Open Notebook returned HTTP ${response.status}`);
      }
      if (options.allowEmpty && (response.status === 204 || response.headers.get("content-length") === "0")) return null;
      const buffer = await readResponseBody(response, this.config.limits.response_max_bytes);
      if (!buffer.byteLength && options.allowEmpty) return null;
      try { return JSON.parse(buffer.toString("utf8")) as unknown; }
      catch { throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned malformed JSON"); }
    } catch (error) {
      if (error instanceof NotebookError) throw error;
      if (controller.signal.aborted || (error as Error).name === "AbortError") throw new NotebookError("TIMEOUT", "Open Notebook request timed out", true);
      throw new NotebookError("SERVICE_UNAVAILABLE", "Open Notebook request failed", true, {}, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
