import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { encodeNoteEnvelope, overviewLogicalId, sha256Hex } from "./notes";
import { readSafeEvidenceText } from "./git-evidence";
import {
  NOTEBOOK_POLICY_VERSION,
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  type EffectiveNotebookConfigV1,
  type OverviewDescriptorV1,
  type OverviewReferenceV1,
  type PjanglerNoteEnvelopeV1,
} from "./types";

const DEFAULT_OVERVIEW_REFERENCES = [".project.json", "README.md", "AGENTS.md", "CLAUDE.md", "docs/architecture.md"];

function git(repo: string, args: string[], timeout: number): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024, timeout, shell: false });
  return { ok: result.status === 0, stdout: result.stdout?.trim() ?? "" };
}

function normalizedReference(repo: string, value: string): string {
  if (!value || value.includes("\0") || value.startsWith("/") || value.split(/[\\/]/u).includes("..")) throw new NotebookError("INVALID_INPUT", `Overview reference is not a contained relative path: ${value}`);
  const root = realpathSync(repo);
  const candidate = resolve(root, value);
  const rel = relative(root, candidate).split(sep).join("/");
  if (!rel || rel === ".." || rel.startsWith("../")) throw new NotebookError("INVALID_INPUT", `Overview reference escapes the repository: ${value}`);
  return rel.normalize("NFC");
}

function compileReference(config: EffectiveNotebookConfigV1, path: string): { reference: OverviewReferenceV1; content?: string } {
  const tracked = git(config.repo_path, ["ls-files", "--error-unmatch", "--", path], config.limits.overall_timeout_ms);
  if (!tracked.ok) return { reference: { path, status: "missing", reason: "not-tracked" } };
  const evidence = readSafeEvidenceText(config.repo_path, path, config.limits.source_file_max_bytes);
  if (evidence.status !== "present") return { reference: { path, status: "missing", reason: evidence.reason } };
  const revision = git(config.repo_path, ["rev-parse", `HEAD:${path}`], config.limits.overall_timeout_ms);
  return {
    reference: {
      path,
      status: "present",
      git_revision: revision.ok ? revision.stdout : "working-tree-only",
      content_sha256: evidence.content_sha256,
    },
    content: evidence.content,
  };
}

export interface CompiledOverviewArtifactV1 {
  descriptor: OverviewDescriptorV1;
  reference_contents: Readonly<Record<string, string>>;
}

export function compileOverviewArtifact(input: {
  config: EffectiveNotebookConfigV1;
  projectName: string;
  purpose?: string;
}): CompiledOverviewArtifactV1 {
  const configured = input.config.policy.overview_references;
  const candidates = configured ?? DEFAULT_OVERVIEW_REFERENCES;
  const normalized = [...new Set(candidates.map((path) => normalizedReference(input.config.repo_path, path)))];
  const compiled = normalized.map((path) => compileReference(input.config, path));
  const selected = configured ? compiled : compiled.filter((item) => item.reference.status === "present");
  return {
    descriptor: {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: input.config.project_slug,
      project_name: input.projectName,
      purpose: input.purpose?.trim() || "Purpose not yet documented",
      references: selected.map((item) => item.reference),
      compiler_policy_version: NOTEBOOK_POLICY_VERSION,
    },
    reference_contents: Object.fromEntries(selected.flatMap((item) => item.content === undefined ? [] : [[item.reference.path, item.content]])),
  };
}

export function compileOverviewDescriptor(input: {
  config: EffectiveNotebookConfigV1;
  projectName: string;
  purpose?: string;
}): OverviewDescriptorV1 {
  return compileOverviewArtifact(input).descriptor;
}

export function overviewDescriptorDrift(stored: OverviewDescriptorV1 | undefined, current: OverviewDescriptorV1): Array<{ path: string; reason: string }> {
  if (!stored) return [{ path: "overview", reason: "missing-descriptor" }];
  const drift: Array<{ path: string; reason: string }> = [];
  if (stored.project_slug !== current.project_slug || stored.project_name !== current.project_name || stored.purpose !== current.purpose || stored.compiler_policy_version !== current.compiler_policy_version) {
    drift.push({ path: "overview", reason: "descriptor-metadata-changed" });
  }
  const oldByPath = new Map(stored.references.map((item) => [item.path, item]));
  const currentPaths = new Set(current.references.map((item) => item.path));
  for (const reference of current.references) {
    const old = oldByPath.get(reference.path);
    if (!old) drift.push({ path: reference.path, reason: "reference-added" });
    else if (old.status !== reference.status || old.git_revision !== reference.git_revision || old.content_sha256 !== reference.content_sha256 || old.reason !== reference.reason) {
      drift.push({ path: reference.path, reason: "reference-changed" });
    }
  }
  for (const old of stored.references) if (!currentPaths.has(old.path)) drift.push({ path: old.path, reason: "reference-removed" });
  return drift.slice(0, 100);
}

export function renderOverviewContent(input: { config: EffectiveNotebookConfigV1; descriptor: OverviewDescriptorV1; referenceContents: Readonly<Record<string, string>> }): string {
  const sections = [
    `# ${input.descriptor.project_name}`,
    "",
    input.descriptor.purpose,
  ];
  for (const reference of input.descriptor.references) {
    sections.push("", `## ${reference.path}`);
    if (reference.status === "missing") {
      sections.push(`[${reference.reason ?? "missing"}]`);
      continue;
    }
    const content = input.referenceContents[reference.path];
    if (content === undefined || sha256Hex(content) !== reference.content_sha256) {
      sections.push("[reference content unavailable or changed during compilation]");
      continue;
    }
    sections.push(content);
  }
  let body = sections.join("\n");
  if (Array.from(body).length > input.config.policy.overview_max_chars) {
    const suffix = "\n\n[Overview truncated by project-notebook.v1 policy]";
    const keep = Math.max(0, input.config.policy.overview_max_chars - Array.from(suffix).length);
    body = `${Array.from(body).slice(0, keep).join("")}${suffix}`;
  }
  const envelope: PjanglerNoteEnvelopeV1 = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: input.config.project_slug,
    kind: "overview",
    logical_id: overviewLogicalId(input.config.project_slug),
    policy_version: NOTEBOOK_POLICY_VERSION,
    overview_descriptor: input.descriptor,
  };
  const marker = `${encodeNoteEnvelope(envelope)}\n`;
  const available = input.config.limits.note_max_bytes - Buffer.byteLength(marker, "utf8");
  if (available <= 0) throw new NotebookError("INVALID_INPUT", "Overview ownership descriptor alone exceeds the configured note ceiling");
  if (Buffer.byteLength(body, "utf8") > available) {
    const suffix = "\n\n[Overview truncated by project-notebook.v1 byte policy]";
    const budget = Math.max(0, available - Buffer.byteLength(suffix, "utf8"));
    let used = 0;
    const points: string[] = [];
    for (const point of body) {
      const bytes = Buffer.byteLength(point, "utf8");
      if (used + bytes > budget) break;
      points.push(point);
      used += bytes;
    }
    body = `${points.join("")}${suffix}`;
  }
  return `${marker}${body}`;
}
