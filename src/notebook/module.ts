import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPgRegistryEnabled, PgRegistryStore, pgRegistryConfigFromEnv, projectRegistryPath, resolvePjanglerRoot, type ProjectRegistry } from "../project/index";
import type { RegistryStore } from "../project/RegistryStore";
import {
  loadEffectiveNotebookConfig,
  notebookDisplayName,
  persistProjectNotebookDeclaration,
  persistProjectNotebookBinding,
  requireRemoteNotebookConfig,
  resolveEffectiveNotebookConfig,
  resolveNotebookProject,
  resolveNotebookProjectBySlug,
  type ResolvedNotebookProjectV1,
} from "./config";
import { OpenNotebookClient } from "./open-notebook-client";
import {
  canonicalJson,
  noteDetail,
  noteSummary,
  parseNoteEnvelope,
  searchNotesLocally,
  userNoteLogicalId,
  withNoteEnvelope,
} from "./notes";
import { compileOverviewArtifact, compileOverviewDescriptor, overviewDescriptorDrift, renderOverviewContent } from "./overview";
import { reconcileManagedNote, reconcileProjectNotebook } from "./reconcile";
import {
  commitReconciledRemoteMutation,
  findActiveRemoteMutation,
  listRemoteMutationJournals,
  mutationInputDigest,
  remoteMutationJournalPath,
  type RemoteMutationJournalV1,
} from "./remote-mutation-journal";
import { captureAdmissionSummary, notebookStateRoot, publicCaptureAdmissionSummary } from "./state";
import { authorizeCaptureRetry, listCaptureReceipts, pruneNotebookState, receiptSummary } from "./state";
import { validateCommittedGitRef } from "./git-evidence";
import { prepareNotebookObservation } from "./observation";
import { createNotebookChecks } from "./checks";
import { homedir } from "node:os";
import { installProjectNotebookIntegration } from "./hooks";
import {
  NOTEBOOK_POLICY_VERSION,
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  type CaptureAdmissionSummaryV1,
  type EffectiveNotebookConfigV1,
  type NoteDetailV1,
  type NoteSummaryV1,
  type NotebookFindingV1,
  type NotebookHealth,
  type OpenNotebookNotebookV1,
  type OpenNotebookNoteV1,
  type PjanglerNoteEnvelopeV1,
  type ProjectNotebookBindingV1,
} from "./types";

export interface NotebookModuleOptions {
  registryPath?: string;
  stateRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clientFactory?: (config: EffectiveNotebookConfigV1) => OpenNotebookClient;
  registryStore?: Pick<RegistryStore, "save">;
}

interface ModuleContext {
  resolved: ResolvedNotebookProjectV1;
  config: EffectiveNotebookConfigV1;
  client?: OpenNotebookClient;
}

interface PageCursorV1 {
  schema_version: 1;
  notebook_id: string;
  updated_at: string;
  id: string;
}

function decodeCursor(cursor: string): PageCursorV1 {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    const item = value as Partial<PageCursorV1>;
    if (item.schema_version !== 1 || !item.notebook_id || typeof item.updated_at !== "string" || typeof item.id !== "string") throw new Error("shape");
    return item as PageCursorV1;
  } catch {
    throw new NotebookError("INVALID_INPUT", "Malformed or incompatible notebook cursor");
  }
}

function encodeCursor(value: PageCursorV1): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function sortedNotes(notes: readonly OpenNotebookNoteV1[]): OpenNotebookNoteV1[] {
  const timestamp = (value: string | null): number => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...notes].sort((a, b) =>
    timestamp(b.updated_at) - timestamp(a.updated_at)
    || a.id.localeCompare(b.id, "en"));
}

function bindingNotebook(config: EffectiveNotebookConfigV1): { notebookId: string; overviewId?: string } {
  if (config.binding.state !== "linked" || !config.binding.notebook_id) throw new NotebookError("NOT_CONFIGURED", "Project Notebook binding is not linked");
  return { notebookId: config.binding.notebook_id, overviewId: config.binding.overview_note_id };
}

function ensureText(value: string, label: string, maxBytes: number): string {
  if (!value.trim()) throw new NotebookError("INVALID_INPUT", `${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", `${label} exceeds the configured ceiling`);
  return value;
}

function ensureTitle(value: string, label = "Note title"): string {
  ensureText(value, label, 4_096);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new NotebookError("INVALID_INPUT", `${label} must not contain control characters`);
  return value;
}

function ensureFinalNoteContent(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Final managed note content including its ownership envelope exceeds the configured ceiling");
  return value;
}

function getScoped(notes: readonly OpenNotebookNoteV1[], noteId: string): OpenNotebookNoteV1 {
  const note = notes.find((item) => item.id === noteId);
  if (!note) throw new NotebookError("NOT_FOUND", `Note is not a proven member of this project notebook: ${noteId}`);
  return note;
}

export class NotebookModule {
  readonly registryPath: string;
  readonly stateRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  private readonly fetch?: typeof globalThis.fetch;
  private readonly clientFactory?: (config: EffectiveNotebookConfigV1) => OpenNotebookClient;
  private readonly registryStore?: Pick<RegistryStore, "save">;

  constructor(options: NotebookModuleOptions = {}) {
    this.registryPath = options.registryPath ?? projectRegistryPath(options.env);
    this.stateRoot = options.stateRoot ?? notebookStateRoot(options.env);
    this.environment = options.env ?? process.env;
    this.fetch = options.fetch;
    this.clientFactory = options.clientFactory;
    this.registryStore = options.registryStore;
  }

  installIntegration(env: NodeJS.ProcessEnv = this.environment): { changedFiles: string[] } {
    const installed = installProjectNotebookIntegration({ env });
    const home = env.HOME!;
    return {
      changedFiles: [
        ...(installed.skill.installed ? [installed.skill.path] : []),
        ...(installed.hooksChanged ? [resolve(env.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? `${home}/.claude/settings.json`)] : []),
      ],
    };
  }

  repairBindingProjection(repo = process.cwd()): string[] {
    const ctx = this.context(repo, false);
    return persistProjectNotebookBinding(ctx.resolved, ctx.config.binding);
  }

  async declareNotebook(repo = process.cwd()): Promise<string[]> {
    const resolved = resolveNotebookProject(repo, this.registryPath);
    const changed = persistProjectNotebookDeclaration(resolved);
    await this.persistPostgresMirror(resolved.registry);
    return changed;
  }

  clientForConfig(config: EffectiveNotebookConfigV1, deadlineMonotonicMs?: number): OpenNotebookClient {
    requireRemoteNotebookConfig(config);
    return this.clientFactory?.(config) ?? new OpenNotebookClient(config, { fetch: this.fetch, env: this.environment, deadlineMonotonicMs });
  }

  context(repo = process.cwd(), remote = false): ModuleContext {
    const resolved = resolveNotebookProject(repo, this.registryPath);
    const config = resolveEffectiveNotebookConfig(resolved);
    if (!remote) return { resolved, config };
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    return { resolved, config, client };
  }

  contextBySlug(projectSlug: string, remote = false): ModuleContext {
    const registry = resolveNotebookProjectBySlug(projectSlug, this.registryPath);
    const config = resolveEffectiveNotebookConfig(registry);
    if (!remote) return { resolved: registry, config };
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    return { resolved: registry, config, client };
  }

  async status(repo = process.cwd(), localOnly = false): Promise<{
    config: EffectiveNotebookConfigV1;
    health: NotebookHealth;
    data: {
      policy: EffectiveNotebookConfigV1["policy"];
      configuration_provenance: EffectiveNotebookConfigV1["configuration_provenance"];
      remote_check: "pass" | "fail" | "skip";
      unresolved_receipt_count: number | null;
      unresolved_receipt_bytes: number | null;
      receipt_caps: { max_count: number; max_bytes: number };
      capture_admission: CaptureAdmissionSummaryV1;
      findings: NotebookFindingV1[];
    };
  }> {
    const audited = await this.audit(repo, localOnly);
    const admission = audited.data.capture_admission;
    const findings = audited.data.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    return {
      config: audited.config,
      health: audited.health,
      data: {
        policy: audited.config.policy,
        configuration_provenance: audited.config.configuration_provenance,
        remote_check: audited.data.remote_check,
        unresolved_receipt_count: admission.unresolved_count,
        unresolved_receipt_bytes: admission.unresolved_bytes,
        receipt_caps: admission.receipt_caps,
        capture_admission: admission,
        findings,
      },
    };
  }

  async create(repo = process.cwd(), live = false): Promise<{ config: EffectiveNotebookConfigV1; health: NotebookHealth; data: { created: boolean; adopted: boolean; notebook_id: string; overview_note_id: string }; changedFiles: string[] }> {
    if (!live) throw new NotebookError("INVALID_INPUT", "notebook create requires --live");
    const ctx = this.context(repo, true);
    const provisioned = await this.provisionResolved(ctx.resolved, ctx.config);
    const changedFiles = persistProjectNotebookBinding(ctx.resolved, provisioned.binding);
    await this.persistPostgresMirror(ctx.resolved.registry);
    for (const journal of provisioned.journals) commitReconciledRemoteMutation(this.stateRoot, journal);
    const config = loadEffectiveNotebookConfig(repo, this.registryPath);
    return { config, health: "healthy", data: provisioned.data, changedFiles };
  }

  private async persistPostgresMirror(registry: ProjectRegistry): Promise<void> {
    if (!this.registryStore && !isPgRegistryEnabled(this.environment)) return;
    let owned: PgRegistryStore | undefined;
    const store = this.registryStore ?? (owned = new PgRegistryStore(pgRegistryConfigFromEnv(this.environment)));
    try {
      await store.save(registry);
    } catch (error) {
      throw new NotebookError("SERVICE_UNAVAILABLE", "PostgreSQL Registry dual-write failed after YAML authority was durably preserved", true, {}, { cause: error });
    } finally {
      await owned?.close();
    }
  }

  async provisionResolved(resolved: ResolvedNotebookProjectV1, config = resolveEffectiveNotebookConfig(resolved)): Promise<{
    binding: ProjectNotebookBindingV1;
    data: { created: boolean; adopted: boolean; notebook_id: string; overview_note_id: string };
    journals: RemoteMutationJournalV1[];
  }> {
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    const reconciled = await reconcileProjectNotebook({
      stateRoot: this.stateRoot,
      projectSlug: config.project_slug,
      name: notebookDisplayName(resolved),
      description: resolved.project.description,
      client,
    });
    const compiledOverview = compileOverviewArtifact({ config, projectName: resolved.project.name, purpose: resolved.project.description });
    const overviewContent = renderOverviewContent({ config, descriptor: compiledOverview.descriptor, referenceContents: compiledOverview.reference_contents });
    const overview = await reconcileManagedNote({
      stateRoot: this.stateRoot,
      projectSlug: config.project_slug,
      notebookId: reconciled.notebook.id,
      logicalId: `overview:v1:${config.project_slug}`,
      title: "Project Overview",
      content: overviewContent,
      client,
    });
    const binding: ProjectNotebookBindingV1 = {
      ...config.binding,
      state: "linked",
      notebook_id: reconciled.notebook.id,
      notebook_name: reconciled.notebook.name,
      overview_note_id: overview.note.id,
      blocked_reason: undefined,
    };
    return {
      binding,
      data: {
        created: reconciled.created || overview.created,
        adopted: reconciled.adopted || overview.adopted,
        notebook_id: reconciled.notebook.id,
        overview_note_id: overview.note.id,
      },
      journals: [reconciled.journal, overview.journal],
    };
  }

  private async scoped(repo: string, deadlineMonotonicMs?: number): Promise<{ ctx: ModuleContext & { client: OpenNotebookClient }; notes: OpenNotebookNoteV1[]; notebookId: string }> {
    const local = this.context(repo, false);
    requireRemoteNotebookConfig(local.config);
    const ctx = { ...local, client: this.clientForConfig(local.config, deadlineMonotonicMs) } as ModuleContext & { client: OpenNotebookClient };
    const { notebookId } = bindingNotebook(ctx.config);
    const notes = await ctx.client.listNotes(notebookId);
    return { ctx, notes, notebookId };
  }

  async listNotes(repo = process.cwd(), limit = 50, cursor?: string): Promise<{ config: EffectiveNotebookConfigV1; data: { items: NoteSummaryV1[]; next_cursor: string | null } }> {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ctx.config.limits.list_max_items) throw new NotebookError("INVALID_INPUT", "Note list limit is outside configured bounds");
    const ordered = sortedNotes(notes);
    let start = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded.notebook_id !== notebookId) throw new NotebookError("INVALID_INPUT", "Notebook cursor belongs to a different binding");
      const index = ordered.findIndex((item) => item.id === decoded.id && (item.updated_at ?? "") === decoded.updated_at);
      if (index < 0) throw new NotebookError("INVALID_INPUT", "Notebook cursor is stale or invalid");
      start = index + 1;
    }
    const page = ordered.slice(start, start + limit);
    const last = page.at(-1);
    const nextCursor = start + page.length < ordered.length && last
      ? encodeCursor({ schema_version: 1, notebook_id: notebookId, updated_at: last.updated_at ?? "", id: last.id })
      : null;
    return { config: ctx.config, data: { items: page.map((item) => noteSummary(item, ctx.config.limits.excerpt_max_chars)), next_cursor: nextCursor } };
  }

  async addNote(repo: string, title: string, text: string): Promise<{ config: EffectiveNotebookConfigV1; data: { note: NoteDetailV1 } }> {
    const ctx = this.context(repo, true) as ModuleContext & { client: OpenNotebookClient };
    const { notebookId } = bindingNotebook(ctx.config);
    ensureTitle(title);
    ensureText(text, "Note text", ctx.config.limits.note_max_bytes);
    const operationDigest = mutationInputDigest({ kind: "user-note", notebook_id: notebookId, title, text });
    const active = findActiveRemoteMutation(this.stateRoot, ctx.config.project_slug, "note.create", operationDigest);
    if (active && active.logical_marker !== userNoteLogicalId(active.operation_id)) {
      throw new NotebookError("CONFLICT", "Active user-note mutation journal has an invalid operation-bound logical identity");
    }
    const operationId = active?.operation_id ?? randomUUID();
    const logicalId = userNoteLogicalId(operationId);
    const envelope: PjanglerNoteEnvelopeV1 = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: ctx.config.project_slug,
      kind: "user-note",
      logical_id: logicalId,
      policy_version: NOTEBOOK_POLICY_VERSION,
    };
    const content = ensureFinalNoteContent(withNoteEnvelope(envelope, text), ctx.config.limits.note_max_bytes);
    const result = await reconcileManagedNote({ stateRoot: this.stateRoot, projectSlug: ctx.config.project_slug, notebookId, logicalId, title, content, client: ctx.client, inputDigest: operationDigest, operationId });
    commitReconciledRemoteMutation(this.stateRoot, result.journal);
    return { config: ctx.config, data: { note: noteDetail(result.note, ctx.config.limits.note_max_bytes) } };
  }

  async getNote(repo: string, noteId: string): Promise<{ config: EffectiveNotebookConfigV1; data: { note: NoteDetailV1 } }> {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    return { config: ctx.config, data: { note: noteDetail(getScoped(notes, noteId), ctx.config.limits.note_max_bytes) } };
  }

  async updateNote(repo: string, noteId: string, input: { title?: string; text: string }): Promise<{ config: EffectiveNotebookConfigV1; data: { note: NoteDetailV1 } }> {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    const current = getScoped(notes, noteId);
    const parsed = parseNoteEnvelope(current.content);
    if (parsed?.envelope.project_slug !== undefined && parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Managed note envelope belongs to a different project");
    if (parsed?.envelope.kind === "overview") throw new NotebookError("CONFLICT", "Use pj notebook overview --set-file to update the stable Overview note");
    if (parsed && parsed.envelope.kind !== "user-note") throw new NotebookError("CONFLICT", "Derived document and session-capture notes must be regenerated from their evidence boundary");
    ensureText(input.text, "Note text", ctx.config.limits.note_max_bytes);
    if (input.title !== undefined) ensureTitle(input.title);
    const content = ensureFinalNoteContent(parsed ? withNoteEnvelope(parsed.envelope, input.text) : input.text, ctx.config.limits.note_max_bytes);
    const updated = await ctx.client.updateOwnedNote(notebookId, noteId, { ...(input.title ? { title: input.title } : {}), content });
    return { config: ctx.config, data: { note: noteDetail(updated, ctx.config.limits.note_max_bytes) } };
  }

  async deleteNote(repo: string, noteId: string, confirmed: boolean): Promise<{ config: EffectiveNotebookConfigV1; data: { deleted_id: string } }> {
    if (!confirmed) throw new NotebookError("INVALID_INPUT", "Note deletion requires confirmation or --yes");
    const { ctx, notes, notebookId } = await this.scoped(repo);
    const note = getScoped(notes, noteId);
    const parsed = parseNoteEnvelope(note.content);
    if (parsed && parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Managed note envelope belongs to a different project");
    if (noteId === ctx.config.binding.overview_note_id || parsed?.envelope.kind === "overview") throw new NotebookError("CONFLICT", "The stable Project Overview note cannot be deleted");
    await ctx.client.deleteOwnedNote(notebookId, noteId);
    return { config: ctx.config, data: { deleted_id: noteId } };
  }

  async searchNotes(repo: string, query: string, limit = 20): Promise<{ config: EffectiveNotebookConfigV1; data: ReturnType<typeof searchNotesLocally> }> {
    const { ctx, notes } = await this.scoped(repo);
    if (limit > ctx.config.limits.list_max_items) throw new NotebookError("INVALID_INPUT", "Search limit exceeds the configured ceiling");
    return { config: ctx.config, data: searchNotesLocally(notes, query, limit, ctx.config.limits.excerpt_max_chars) };
  }

  async overview(repo: string, setText?: string, deadlineMonotonicMs?: number): Promise<{ config: EffectiveNotebookConfigV1; data: { note: NoteDetailV1; updated: boolean; drift: Array<{ path: string; reason: string }> } }> {
    const { ctx, notes, notebookId } = await this.scoped(repo, deadlineMonotonicMs);
    const overviewId = ctx.config.binding.overview_note_id;
    if (!overviewId) throw new NotebookError("NOT_CONFIGURED", "Overview note ID is not bound");
    const current = getScoped(notes, overviewId);
    const parsed = parseNoteEnvelope(current.content);
    if (!parsed || parsed.envelope.kind !== "overview") throw new NotebookError("DRIFT_DETECTED", "Bound Overview note has no valid Overview envelope");
    if (parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Bound Overview envelope belongs to a different project");
    if (parsed.envelope.logical_id !== `overview:v1:${ctx.config.project_slug}`) throw new NotebookError("DRIFT_DETECTED", "Bound Overview logical identity does not match this project");
    const descriptor = compileOverviewDescriptor({ config: ctx.config, projectName: ctx.resolved.project.name, purpose: ctx.resolved.project.description });
    const drift = overviewDescriptorDrift(parsed.envelope.overview_descriptor, descriptor);
    if (setText === undefined) return { config: ctx.config, data: { note: noteDetail(current, ctx.config.limits.note_max_bytes), updated: false, drift } };
    ensureText(setText, "Overview text", ctx.config.limits.note_max_bytes);
    const envelope: PjanglerNoteEnvelopeV1 = { ...parsed.envelope, overview_descriptor: descriptor, policy_version: NOTEBOOK_POLICY_VERSION };
    const content = ensureFinalNoteContent(withNoteEnvelope(envelope, setText), ctx.config.limits.note_max_bytes);
    const updated = await ctx.client.updateOwnedNote(notebookId, overviewId, { content });
    return { config: ctx.config, data: { note: noteDetail(updated, ctx.config.limits.note_max_bytes), updated: true, drift: [] } };
  }

  async audit(repo = process.cwd(), localOnly = false): Promise<{ config: EffectiveNotebookConfigV1; health: NotebookHealth; data: { rules: NotebookFindingV1[]; audited_at: string; remote_check: "pass" | "fail" | "skip"; capture_admission: CaptureAdmissionSummaryV1 } }> {
    const local = this.context(repo, false);
    const observed = await prepareNotebookObservation(this, repo, localOnly);
    const checks = createNotebookChecks();
    const lifecycle = {
      targetDir: local.config.repo_path,
      repoRoot: local.config.repo_path,
      pjanglerRoot: resolvePjanglerRoot(),
      homeDir: this.environment.HOME || homedir(),
      notebookStateRoot: this.stateRoot,
      notebookRegistryDeclared: Boolean(local.resolved.project.notebook && typeof local.resolved.project.notebook === "object"),
      notebookFocusedAudit: true,
      dryRun: true,
      force: false,
      notebookObservation: Object.freeze(observed),
      notebookPlan: Object.freeze({
        schema_version: 1 as const,
        project_slug: local.config.project_slug,
        repo_path: local.config.repo_path,
        mode: "sync" as const,
        config: local.config,
        remote_effect: "none" as const,
        reason: "focused notebook audit",
      }),
    };
    const rules = checks.map((check) => check.audit(lifecycle));
    const admission = publicCaptureAdmissionSummary(captureAdmissionSummary(this.stateRoot, local.config.project_slug, local.config.limits));
    return {
      config: local.config,
      health: observed.health,
      data: { rules, audited_at: new Date().toISOString(), remote_check: observed.remote_check, capture_admission: admission },
    };
  }

  pruneCaptureState(repo = process.cwd()): string[] {
    const ctx = this.context(repo, false);
    return pruneNotebookState(this.stateRoot, ctx.config.project_slug, ctx.config.limits);
  }

  recoverCaptureJournals(repo = process.cwd()): string[] {
    const ctx = this.context(repo, false);
    const receipts = listCaptureReceipts(this.stateRoot, ctx.config.project_slug, ctx.config.limits, "succeeded");
    const recovered: string[] = [];
    // Loading capture here avoids a module initialization cycle while keeping
    // migration a local, receipt-proofed operation with no remote calls.
    for (const receipt of receipts) {
      const ownership = new Map(receipt.note_logical_ids.map((logicalId, index) => [logicalId, receipt.remote_note_ids[index]]));
      const bindingId = ctx.config.binding.state === "linked" ? ctx.config.binding.notebook_id : undefined;
      if (!bindingId) continue;
      const journals = listRemoteMutationJournals(this.stateRoot, ctx.config.project_slug);
      for (const journal of journals) {
        if (journal.kind !== "note.create" || journal.session_key !== receipt.session_key || journal.state !== "reconciled"
          || journal.binding_id !== bindingId || journal.candidate_ids.length !== 1
          || ownership.get(journal.logical_marker) !== journal.candidate_ids[0]) continue;
        commitReconciledRemoteMutation(this.stateRoot, journal);
        recovered.push(remoteMutationJournalPath(this.stateRoot, ctx.config.project_slug, journal.operation_id));
      }
    }
    return [...new Set(recovered)].sort();
  }

  captureList(repo = process.cwd(), state?: string): { config: EffectiveNotebookConfigV1; data: { items: ReturnType<typeof receiptSummary>[]; next_cursor: null } } {
    const ctx = this.context(repo, false);
    return { config: ctx.config, data: { items: listCaptureReceipts(this.stateRoot, ctx.config.project_slug, ctx.config.limits, state), next_cursor: null } };
  }

  async captureRetry(repo: string, receiptId: string, baseline?: string): Promise<{ config: EffectiveNotebookConfigV1; data: { receipt: ReturnType<typeof receiptSummary> } }> {
    const ctx = this.context(repo, false);
    const queued = authorizeCaptureRetry({
      root: this.stateRoot,
      projectSlug: ctx.config.project_slug,
      receiptId,
      limits: ctx.config.limits,
      baseline,
      validateBaseline: (gitRef) => validateCommittedGitRef(ctx.config.repo_path, gitRef),
    });
    const { runCaptureWorker } = await import("./capture");
    const completed = await runCaptureWorker(this, ctx.config.project_slug, queued.receipt_id);
    return { config: ctx.config, data: { receipt: receiptSummary(completed.receipt) } };
  }
}
