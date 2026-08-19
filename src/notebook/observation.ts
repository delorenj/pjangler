import { parseNoteEnvelope } from "./notes";
import { compileOverviewDescriptor, overviewDescriptorDrift } from "./overview";
import type { NotebookModule } from "./module";
import type {
  EffectiveNotebookConfigV1,
  NotebookErrorCode,
  NotebookHealth,
  OpenNotebookNotebookV1,
  OpenNotebookNoteV1,
} from "./types";
import { normalizeNotebookError } from "./output";
import { projectNotebookMarker } from "./reconcile";
import { notebookDisplayName, type ResolvedNotebookProjectV1 } from "./config";
import { inspectProjectNotebookIntegration } from "./hooks";

export interface NotebookObservationV1 {
  schema_version: 1;
  fetched_at: string;
  project_slug: string;
  binding_used: EffectiveNotebookConfigV1["binding"];
  remote_check: "pass" | "fail" | "skip";
  health: NotebookHealth;
  auth_mode: EffectiveNotebookConfigV1["auth"]["mode"];
  base_url_configured: boolean;
  notebook: OpenNotebookNotebookV1 | null;
  scoped_notes: Array<Pick<OpenNotebookNoteV1, "id" | "title" | "note_type" | "created_at" | "updated_at"> & { envelope_logical_id: string | null }>;
  overview: { present: boolean; member: boolean; envelope_owned: boolean; drift: Array<{ path: string; reason: string }> } | null;
  error: { code: NotebookErrorCode; retryable: boolean; message: string } | null;
  skill_installed?: boolean | null;
  hooks_projected?: boolean | null;
}

export interface NotebookPlanV1 {
  schema_version: 1;
  project_slug: string;
  repo_path: string;
  mode: "create" | "sync";
  config: EffectiveNotebookConfigV1;
  remote_effect: "none" | "reconcile";
  reason: string;
}

export async function prepareNotebookObservation(module: NotebookModule, repo: string, localOnly = false): Promise<NotebookObservationV1> {
  const local = module.context(repo, false);
  return prepareNotebookObservationResolved(module, local.resolved, local.config, localOnly);
}

export async function prepareNotebookObservationResolved(module: NotebookModule, resolved: ResolvedNotebookProjectV1, config: EffectiveNotebookConfigV1, localOnly = false, integrationEnv: NodeJS.ProcessEnv = module.environment): Promise<NotebookObservationV1> {
  const local = { resolved, config };
  const integration = inspectProjectNotebookIntegration(integrationEnv);
  const base = {
    schema_version: 1 as const,
    fetched_at: new Date().toISOString(),
    project_slug: local.config.project_slug,
    binding_used: { ...local.config.binding },
    auth_mode: local.config.auth.mode,
    base_url_configured: Boolean(local.config.base_url),
    skill_installed: integration.skill_installed,
    hooks_projected: integration.hooks_projected,
  };
  if (localOnly || !local.config.base_url) {
    return {
      ...base,
      remote_check: "skip",
      health: localOnly ? null : "unconfigured",
      notebook: null,
      scoped_notes: [],
      overview: null,
      error: null,
    };
  }
  try {
    const client = module.clientForConfig(local.config);
    const notebooks = await client.listNotebooks();
    const id = local.config.binding.notebook_id;
    const notebook = id ? notebooks.find((item) => item.id === id) ?? null : null;
    if (!notebook) {
      return { ...base, remote_check: "fail", health: local.config.binding.state === "planned" ? "blocked" : "drifted", notebook: null, scoped_notes: [], overview: null, error: null };
    }
    const markerMatches = notebook.description?.split(/\r?\n/u)[0] === projectNotebookMarker(local.config.project_slug);
    const notes = await client.listNotes(notebook.id);
    const overviewId = local.config.binding.overview_note_id;
    const overviewNote = overviewId ? notes.find((item) => item.id === overviewId) : undefined;
    let overview: NotebookObservationV1["overview"] = null;
    if (overviewId) {
      const parsed = overviewNote ? parseNoteEnvelope(overviewNote.content) : null;
      const current = compileOverviewDescriptor({ config: local.config, projectName: local.resolved.project.name, purpose: local.resolved.project.description });
      overview = {
        present: Boolean(overviewNote),
        member: Boolean(overviewNote),
        envelope_owned: Boolean(parsed && parsed.envelope.kind === "overview" && parsed.envelope.project_slug === local.config.project_slug && parsed.envelope.logical_id === `overview:v1:${local.config.project_slug}`),
        drift: parsed?.envelope.kind === "overview" ? overviewDescriptorDrift(parsed.envelope.overview_descriptor, current) : [{ path: "overview", reason: "invalid-envelope" }],
      };
    }
    const metadataMatches = notebook.archived !== true && notebook.name === notebookDisplayName(local.resolved);
    const healthy = markerMatches && metadataMatches && Boolean(overview?.present) && Boolean(overview?.envelope_owned) && overview!.drift.length === 0;
    return {
      ...base,
      remote_check: healthy ? "pass" : "fail",
      health: healthy ? "healthy" : "drifted",
      notebook,
      scoped_notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        note_type: note.note_type,
        created_at: note.created_at,
        updated_at: note.updated_at,
        envelope_logical_id: parseNoteEnvelope(note.content)?.envelope.logical_id ?? null,
      })),
      overview,
      error: null,
    };
  } catch (error) {
    const normalized = normalizeNotebookError(error);
    return {
      ...base,
      remote_check: "fail",
      health: "unavailable",
      notebook: null,
      scoped_notes: [],
      overview: null,
      error: { code: normalized.code, retryable: normalized.retryable, message: normalized.message.slice(0, 512) },
    };
  }
}
