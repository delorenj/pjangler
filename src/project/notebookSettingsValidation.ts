import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { DEFAULT_NOTEBOOK_LIMITS, notebookCredentialMaterialPath, type NotebookLimitsV1 } from "../notebook/types";
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function validateGlobalNotebookConfig(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Project registry notebook must be a mapping");
  const credentialPath = notebookCredentialMaterialPath(value);
  if (credentialPath) throw new Error(`Project registry Notebook configuration contains forbidden credential material at ${credentialPath}`);
  if (value.base_url !== undefined) {
    if (typeof value.base_url !== "string" || !value.base_url.trim()) throw new Error("Project registry notebook.base_url must be a nonempty URL");
    let url: URL;
    try { url = new URL(value.base_url); } catch { throw new Error("Project registry notebook.base_url must be an absolute URL"); }
    if (url.username || url.password || url.search || url.hash) throw new Error("Project registry notebook.base_url may not contain credentials, query, or fragment");
    const hostname = url.hostname.toLowerCase();
    const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const loopback = hostname === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (isIP(host) !== 0 && !loopback) throw new Error("Project registry notebook.base_url may not use a numeric non-loopback host");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Project registry notebook.base_url must use HTTPS or loopback HTTP");
  }
  if (value.auth !== undefined) {
    if (!isRecord(value.auth) || (value.auth.mode !== "none" && value.auth.mode !== "environment")) throw new Error("Project registry notebook.auth is invalid");
    if (value.auth.mode === "environment" && value.auth.env_var !== "OPEN_NOTEBOOK_PASSWORD") throw new Error("Project registry notebook.auth.env_var must be OPEN_NOTEBOOK_PASSWORD");
    if (value.auth.mode === "none" && value.auth.env_var !== undefined) throw new Error("Project registry notebook.auth none mode may not name a credential variable");
  }
  const boundedList = (candidate: unknown, name: string): void => {
    if (!Array.isArray(candidate) || candidate.length > 100 || candidate.some((entry) => typeof entry !== "string" || !entry || Buffer.byteLength(entry, "utf8") > 512)) throw new Error(`Project registry notebook.defaults.${name} must be a bounded string list`);
  };
  if (value.defaults !== undefined) {
    if (!isRecord(value.defaults)) throw new Error("Project registry notebook.defaults must be a mapping");
    for (const key of ["enabled", "session_start_enabled", "session_capture_enabled"] as const) {
      if (value.defaults[key] !== undefined && typeof value.defaults[key] !== "boolean") throw new Error(`Project registry notebook.defaults.${key} must be boolean`);
    }
    if (value.defaults.overview_max_chars !== undefined && (!Number.isSafeInteger(value.defaults.overview_max_chars) || Number(value.defaults.overview_max_chars) <= 0)) throw new Error("Project registry notebook.defaults.overview_max_chars must be a positive integer");
    for (const key of ["documentation_globs", "overview_references", "excluded_globs"] as const) if (value.defaults[key] !== undefined) boundedList(value.defaults[key], key);
  }
  const limits = { ...DEFAULT_NOTEBOOK_LIMITS } as NotebookLimitsV1;
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw new Error("Project registry notebook.limits must be a mapping");
    for (const key of Object.keys(DEFAULT_NOTEBOOK_LIMITS) as Array<keyof NotebookLimitsV1>) {
      const configured = value.limits[key];
      if (configured === undefined) continue;
      if (!Number.isSafeInteger(configured) || Number(configured) <= 0) throw new Error(`Project registry notebook.limits.${key} must be a positive integer`);
      limits[key] = Number(configured) as never;
    }
  }
  if (limits.schema_version !== 1) throw new Error("Project registry notebook.limits.schema_version must be 1");
  if (limits.receipt_max_bytes > limits.unresolved_receipt_max_bytes) throw new Error("Project registry notebook receipt_max_bytes may not exceed unresolved_receipt_max_bytes");
  if (limits.hook_payload_max_bytes > DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes) throw new Error("Project registry notebook hook_payload_max_bytes exceeds the packaged ceiling");
  if (limits.note_detail_fetch_concurrency > DEFAULT_NOTEBOOK_LIMITS.note_detail_fetch_concurrency) throw new Error("Project registry notebook note_detail_fetch_concurrency exceeds the packaged ceiling");
  if (limits.lease_seconds * 1_000 <= limits.overall_timeout_ms) throw new Error("Project registry notebook lease_seconds must exceed one request timeout");
  if (isRecord(value.defaults) && value.defaults.overview_max_chars !== undefined && Number(value.defaults.overview_max_chars) > limits.note_max_bytes) throw new Error("Project registry notebook overview_max_chars exceeds note_max_bytes");
  if (value.summarizer !== undefined) {
    if (!isRecord(value.summarizer) || typeof value.summarizer.executable !== "string" || !isAbsolute(value.summarizer.executable)
      || value.summarizer.executable.includes("\0") || Buffer.byteLength(value.summarizer.executable, "utf8") > 1_024) throw new Error("Project registry notebook.summarizer executable must be a bounded absolute path");
    if (value.summarizer.args !== undefined && (!Array.isArray(value.summarizer.args) || value.summarizer.args.length > 32
      || value.summarizer.args.some((entry) => typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 1_024))) throw new Error("Project registry notebook.summarizer args must be bounded strings");
  }
}

