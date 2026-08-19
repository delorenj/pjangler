import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectRegistry, type ProjectInitPlan, type ProjectManifest, type ProjectRecord } from "../project/index";
import { createNotebookChecks, NOTEBOOK_RULE_IDS } from "../notebook/checks";
import { resolveEffectiveNotebookConfig, type ResolvedNotebookProjectV1 } from "../notebook/config";
import { NotebookModule } from "../notebook/module";
import { notebookStateRoot } from "../notebook/state";
import { commitReconciledRemoteMutation, type RemoteMutationJournalV1 } from "../notebook/remote-mutation-journal";
import type { NotebookPlanV1 } from "../notebook/observation";
import { prepareNotebookObservationResolved, type NotebookObservationV1 } from "../notebook/observation";
import type { ProjectNotebookBindingV1, ProjectNotebookConfigV1 } from "../notebook/types";
import { Recipe } from "./Recipe";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata } from "./types";

export interface NotebookRecipeInput {
  plan: ProjectInitPlan;
  mode: "create" | "sync";
}

export interface NotebookRecipeResult extends RecipeInitResult {
  notebookPlan: NotebookPlanV1;
}

export interface NotebookDryRunProjectionV1 {
  plan: NotebookPlanV1;
  phases: Array<{
    id: "configuration" | "binding-projection" | "skill" | "managed-hooks" | "overview-note" | "live-action";
    scope: "local" | "live";
    status: "proposed" | "requires-live" | "blocked-not-configured" | "skip";
    summary: string;
  }>;
}

function integrationEnvironment(module: NotebookModule, ctx: LifecycleContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...module.environment, HOME: ctx.homeDir };
  if (module.environment.HOME !== ctx.homeDir) {
    env.XDG_DATA_HOME = join(ctx.homeDir, ".local", "share");
    env.XDG_STATE_HOME = join(ctx.homeDir, ".local", "state");
    env.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS = join(ctx.homeDir, ".claude", "settings.json");
  }
  return env;
}

function resolvedForPlan(plan: ProjectInitPlan): ResolvedNotebookProjectV1 {
  const manifestPath = join(plan.project.repo_path, ".project.json");
  let manifest = plan.manifest;
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${manifestPath} must contain a JSON object`);
    manifest = parsed as ProjectManifest;
  }
  return {
    registry: loadProjectRegistry(plan.registryPath),
    project: plan.project,
    manifest,
    registry_path: plan.registryPath,
  };
}

export function planNotebookForProjectInit(plan: ProjectInitPlan, mode: "create" | "sync"): NotebookPlanV1 {
  const resolved = resolvedForPlan(plan);
  const config = resolveEffectiveNotebookConfig(resolved);
  return Object.freeze({
    schema_version: 1,
    project_slug: config.project_slug,
    repo_path: config.repo_path,
    mode,
    config,
    remote_effect: config.policy.enabled && Boolean(config.base_url) ? "reconcile" : "none",
    reason: !config.policy.enabled ? "disabled by project policy" : config.base_url ? "configured stable identity requires reconciliation" : "no safe global endpoint configured",
  });
}

export function projectNotebookDryRunProjection(plan: ProjectInitPlan, mode: "create" | "sync"): NotebookDryRunProjectionV1 {
  const notebookPlan = planNotebookForProjectInit(plan, mode);
  const enabled = notebookPlan.config.policy.enabled && notebookPlan.config.binding.state !== "disabled";
  const liveStatus = !enabled ? "skip" as const
    : !notebookPlan.config.base_url ? "blocked-not-configured" as const
      : plan.live ? "proposed" as const : "requires-live" as const;
  return {
    plan: notebookPlan,
    phases: [
      { id: "configuration", scope: "local", status: enabled ? "proposed" : "skip", summary: `Effective Project Notebook policy; SessionStart=${notebookPlan.config.policy.session_start_enabled} SessionEnd capture=${notebookPlan.config.policy.session_capture_enabled}` },
      { id: "binding-projection", scope: "local", status: enabled ? "proposed" : "skip", summary: `Registry/Manifest binding ${notebookPlan.config.binding.state} for ${notebookPlan.config.binding.notebook_name ?? notebookPlan.config.project_slug}` },
      { id: "skill", scope: "local", status: enabled ? "proposed" : "skip", summary: "Verify the digest-pinned global Project Notebook skill" },
      { id: "managed-hooks", scope: "local", status: enabled ? "proposed" : "skip", summary: "Project true SessionStart and SessionEnd Managed Hooks without enabling repository capture policy" },
      { id: "overview-note", scope: "live", status: liveStatus, summary: "Reconcile the stable Overview Note ID and exact OverviewDescriptor" },
      { id: "live-action", scope: "live", status: liveStatus, summary: "Create, adopt, or rename the marker-owned Companion Notebook; remote mutation requires --live" },
    ],
  };
}

function setBinding(plan: ProjectInitPlan, binding: ProjectNotebookBindingV1): void {
  const currentProject = plan.project.notebook;
  plan.project.notebook = { ...(currentProject ?? { state: "planned" }), ...binding };
  const currentManifest = (plan.manifest as ProjectManifest & { notebook?: ProjectNotebookConfigV1 }).notebook;
  (plan.manifest as ProjectManifest & { notebook: ProjectNotebookConfigV1 }).notebook = {
    ...(currentManifest ?? {}),
    binding: { ...(currentManifest?.binding ?? {}), ...binding },
  };
  for (const action of plan.actions) {
    if (action.kind === "project.write-manifest") action.manifest = plan.manifest;
    if (action.kind === "registry.upsert") action.project = plan.project;
  }
}

export class NotebookRecipe extends Recipe<NotebookRecipeInput> {
  readonly checks = createNotebookChecks();
  readonly metadata: RecipeMetadata = {
    id: "notebook",
    name: "notebook",
    description: "Project Notebook lifecycle, binding, hooks, and capture state",
    dependencies: [],
    commands: [],
    publicRuleIds: NOTEBOOK_RULE_IDS,
  };

  constructor(readonly module = new NotebookModule()) { super(); }

  override async init(ctx: LifecycleContext, input: NotebookRecipeInput): Promise<NotebookRecipeResult> {
    const resolved = resolvedForPlan(input.plan);
    const notebookPlan = planNotebookForProjectInit(input.plan, input.mode);
    ctx.notebookPlan = notebookPlan;
    ctx.notebookRegistryDeclared = Boolean(resolved.project.notebook && typeof resolved.project.notebook === "object");
    const manifestNotebook = (resolved.manifest as ProjectManifest & { notebook?: ProjectNotebookConfigV1 }).notebook;
    ctx.notebookManifestBinding = manifestNotebook?.binding
      ? Object.freeze({ ...manifestNotebook.binding })
      : null;
    ctx.notebookStateRoot = this.module.stateRoot;
    return {
      recipeId: this.metadata.id,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [`notebook: ${notebookPlan.reason}`],
      errors: [],
      phases: [{ id: "notebook.plan", status: notebookPlan.remote_effect === "reconcile" ? "planned" : "skipped", changedFiles: [], message: notebookPlan.reason }],
      notebookPlan,
    };
  }

  async applyLocal(ctx: LifecycleContext, plan: ProjectInitPlan, notebookPlan: NotebookPlanV1): Promise<RecipeInitResult> {
    if (!plan.apply || ctx.dryRun || !notebookPlan.config.policy.enabled || notebookPlan.config.binding.state === "disabled") {
      return { recipeId: this.metadata.id, ok: true, dryRun: Boolean(ctx.dryRun), changedFiles: [], logs: ["notebook: local skill/hooks skipped"], errors: [], phases: [{ id: "notebook.local", status: "skipped", changedFiles: [], message: "Notebook is disabled or this is a plan-only invocation" }] };
    }
    try {
      const env = integrationEnvironment(this.module, ctx);
      ctx.notebookStateRoot = notebookStateRoot(env);
      const applied = this.module.installIntegration(env);
      ctx.notebookObservation = Object.freeze(await prepareNotebookObservationResolved(this.module, resolvedForPlan(plan), notebookPlan.config, true, env));
      return {
        recipeId: this.metadata.id,
        ok: true,
        dryRun: false,
        changedFiles: applied.changedFiles,
        logs: ["notebook: canonical skill and true SessionStart/SessionEnd hooks projected"],
        errors: [],
        phases: [{ id: "notebook.local", status: applied.changedFiles.length ? "changed" : "unchanged", changedFiles: applied.changedFiles, message: "Canonical Project Notebook skill and hooks verified" }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { recipeId: this.metadata.id, ok: false, dryRun: false, changedFiles: [], logs: [], errors: [message], phases: [{ id: "notebook.local", status: "failed", changedFiles: [], message }] };
    }
  }

  async applyExternal(plan: ProjectInitPlan, notebookPlan: NotebookPlanV1): Promise<{ changedFiles: string[]; data: { created: boolean; adopted: boolean; notebook_id: string; overview_note_id: string; journals: RemoteMutationJournalV1[] } }> {
    if (notebookPlan.remote_effect !== "reconcile") return { changedFiles: [], data: { created: false, adopted: false, notebook_id: notebookPlan.config.binding.notebook_id ?? "", overview_note_id: notebookPlan.config.binding.overview_note_id ?? "", journals: [] } };
    const provisioned = await this.module.provisionResolved(resolvedForPlan(plan), notebookPlan.config);
    setBinding(plan, provisioned.binding);
    return { changedFiles: [], data: { ...provisioned.data, journals: provisioned.journals ?? [] } };
  }

  commitExternal(journals: RemoteMutationJournalV1[]): void {
    for (const journal of journals) commitReconciledRemoteMutation(this.module.stateRoot, journal);
  }

  refreshPlan(plan: ProjectInitPlan, notebookPlan: NotebookPlanV1): NotebookPlanV1 {
    const resolved = resolvedForPlan(plan);
    return Object.freeze({ ...notebookPlan, config: resolveEffectiveNotebookConfig(resolved) });
  }

  async observeExternal(plan: ProjectInitPlan, notebookPlan: NotebookPlanV1): Promise<NotebookObservationV1> {
    const resolved = resolvedForPlan(plan);
    // applyExternal mutates the in-memory plan and then projects the linked
    // binding into the Manifest. The immutable planning snapshot is now stale;
    // candidate proof must resolve the linked IDs from that updated state.
    return prepareNotebookObservationResolved(this.module, resolved, resolveEffectiveNotebookConfig(resolved), false);
  }

  protected printNextSteps(): void { /* Project and notebook CLI render structured next actions. */ }
}
