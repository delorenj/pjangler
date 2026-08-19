import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { NotebookError, type EffectiveNotebookConfigV1 } from "./types";

export interface CaptureSummaryV1 {
  schema_version: 1;
  mode: "configured" | "deterministic-fallback";
  summary: string;
}

export interface CaptureSummaryEvidenceV1 {
  documents: Array<{ path: string; content: string; content_sha256: string; start_content_sha256?: string; source_revision: string }>;
  changedPaths: string[];
  exclusions: Record<string, number>;
  endRevision?: string | null;
  endStatusDigest?: string | null;
  baselineRef?: string | null;
}

interface EvidenceItemV1 {
  evidence_id: string;
  kind: "eligible-document" | "changed-path" | "verification" | "unresolved";
  path?: string;
  content?: string;
  content_sha256?: string;
  value?: string;
}

function evidenceItems(evidence: CaptureSummaryEvidenceV1): EvidenceItemV1[] {
  const items: EvidenceItemV1[] = [];
  const eligible = new Set(evidence.documents.map((item) => item.path));
  for (const [index, document] of evidence.documents.slice(0, 100).entries()) items.push({
    evidence_id: `doc-${String(index + 1).padStart(3, "0")}`,
    kind: "eligible-document",
    path: document.path,
    content: document.content,
    content_sha256: document.content_sha256,
    value: `start=${document.start_content_sha256 ?? "unknown"}; end=${document.content_sha256}; revision=${document.source_revision}`,
  });
  for (const [index, path] of evidence.changedPaths.filter((item) => !eligible.has(item)).slice(0, 100).entries()) {
    items.push({ evidence_id: `path-${String(index + 1).padStart(3, "0")}`, kind: "changed-path", path });
  }
  if (evidence.baselineRef) items.push({ evidence_id: "verify-baseline", kind: "verification", value: `committed baseline ${evidence.baselineRef}` });
  if (evidence.endRevision) items.push({ evidence_id: "verify-end-revision", kind: "verification", value: `committed end revision ${evidence.endRevision}` });
  if (evidence.endStatusDigest) items.push({ evidence_id: "verify-end-status", kind: "verification", value: `bounded Git status digest ${evidence.endStatusDigest}` });
  for (const [reason, count] of Object.entries(evidence.exclusions).sort(([a], [b]) => a.localeCompare(b, "en")).slice(0, 100)) {
    items.push({ evidence_id: `unresolved-${items.filter((item) => item.kind === "unresolved").length + 1}`, kind: "unresolved", value: `${reason}: ${count}` });
  }
  return items;
}

function safeMarkdownValue(value: string): string {
  return JSON.stringify(Array.from(value).slice(0, 512).join(""));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "\n\n[Capture summary truncated by project-notebook.v1 policy]";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let used = 0;
  const result: string[] = [];
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > Math.max(0, maxBytes - suffixBytes)) break;
    result.push(point);
    used += bytes;
  }
  return `${result.join("")}${suffix}`;
}

function fallback(evidence: CaptureSummaryEvidenceV1, maxBytes: number): string {
  const documents = evidence.documents.length ? evidence.documents.slice(0, 100).map((item) => `- ${safeMarkdownValue(item.path)} (${item.content_sha256})`).join("\n") : "- None proved.";
  const eligible = new Set(evidence.documents.map((item) => item.path));
  const other = evidence.changedPaths.filter((item) => !eligible.has(item));
  const paths = other.length ? other.slice(0, 100).map((item) => `- ${safeMarkdownValue(item)}`).join("\n") : "- None recorded.";
  const verification = [
    evidence.baselineRef ? `- Baseline commit: ${evidence.baselineRef}` : "- Baseline commit: unavailable",
    evidence.endRevision ? `- End commit: ${evidence.endRevision}` : "- End commit: unavailable",
    evidence.endStatusDigest ? `- End status digest: ${evidence.endStatusDigest}` : "- End status digest: unavailable",
  ].join("\n");
  const unresolved = Object.keys(evidence.exclusions).length
    ? Object.entries(evidence.exclusions).sort(([a], [b]) => a.localeCompare(b, "en")).map(([reason, count]) => `- ${reason}: ${count}`).join("\n")
    : "- None recorded.";
  return truncateUtf8([
    "## Changed eligible documents", documents,
    "", "## Other changed path names", paths,
    "", "## Verification evidence", verification,
    "", "## Unresolved or uncommitted work", unresolved,
    "", "## Insufficient evidence", "No deployment, runtime-health, or external-success conclusion is supported by this repository-only capture.",
  ].join("\n"), maxBytes);
}

function words(value: string): Set<string> {
  return new Set((value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]{4,}/gu) ?? []));
}

function validateClaims(value: unknown, items: EvidenceItemV1[], noteMaxBytes: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.claims) || record.claims.length < 1 || record.claims.length > 50
    || Object.keys(record).some((key) => key !== "schema_version" && key !== "claims")) return null;
  const byId = new Map(items.map((item) => [item.evidence_id, item]));
  const rendered: string[] = ["## Session outcome"];
  for (const claimValue of record.claims) {
    if (!claimValue || typeof claimValue !== "object" || Array.isArray(claimValue)) return null;
    const claim = claimValue as Record<string, unknown>;
    if (Object.keys(claim).some((key) => key !== "text" && key !== "evidence_ids") || typeof claim.text !== "string"
      || !claim.text.trim() || Buffer.byteLength(claim.text, "utf8") > 1_024 || !Array.isArray(claim.evidence_ids)
      || claim.evidence_ids.length < 1 || claim.evidence_ids.length > 10 || claim.evidence_ids.some((id) => typeof id !== "string" || !byId.has(id))) return null;
    if (/(?:deploy(?:ed|ment)?|production|runtime healthy|shipped|released)/iu.test(claim.text)) return null;
    const claimWords = words(claim.text);
    const cited = claim.evidence_ids.map((id) => byId.get(String(id))!);
    const citedWords = words(cited.map((item) => `${item.path ?? ""} ${item.value ?? ""} ${item.content ?? ""}`).join(" "));
    if (![...claimWords].some((word) => citedWords.has(word))) return null;
    rendered.push(`- ${claim.text.trim()} [${claim.evidence_ids.join(", ")}]`);
  }
  const result = rendered.join("\n");
  return Buffer.byteLength(result, "utf8") <= noteMaxBytes ? result : null;
}

export function summarizeCapture(config: EffectiveNotebookConfigV1, evidence: CaptureSummaryEvidenceV1): CaptureSummaryV1 {
  const fallbackSummary = fallback(evidence, config.limits.note_max_bytes);
  if (!config.summarizer) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  assertSummarizerConfig(config);
  const items = evidenceItems(evidence);
  const payload = JSON.stringify({ schema_version: 1, evidence: items });
  if (Buffer.byteLength(payload, "utf8") > config.limits.request_max_bytes) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  const result = spawnSync(config.summarizer.executable, config.summarizer.args, {
    cwd: config.repo_path,
    input: Buffer.from(payload, "utf8"),
    timeout: config.limits.overall_timeout_ms,
    maxBuffer: config.limits.response_max_bytes,
    shell: false,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  if (result.status !== 0 || result.error || !result.stdout || result.stdout.length > config.limits.response_max_bytes) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    const summary = validateClaims(JSON.parse(decoded) as unknown, items, config.limits.note_max_bytes);
    return summary ? { schema_version: 1, mode: "configured", summary } : { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  } catch {
    return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  }
}

export function assertSummarizerConfig(config: EffectiveNotebookConfigV1): void {
  if (config.summarizer && (!isAbsolute(config.summarizer.executable) || config.summarizer.executable.includes("\0")
    || config.summarizer.args.length > 32 || config.summarizer.args.some((arg) => arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 1_024))) {
    throw new NotebookError("NOT_CONFIGURED", "Configured Notebook summarizer command is invalid");
  }
}
