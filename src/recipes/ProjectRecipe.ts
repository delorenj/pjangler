import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import {
  createSafeRecord,
  executeProjectInitPlan,
  normalizeAgentRole,
  providerAssignsIdentifiers,
  type ProjectAgentRecord,
  type ProjectInitExecutionOptions,
  type ProjectInitExecutionResult,
  type ProjectInitPlan,
  type ProjectManifest,
  type ProjectTicketProvider,
} from "../project/index";
import {
  BMAD_INSTALLER_VERSION,
  createProjectChecks,
  preflightBmadLifecycle,
  type AuditReport,
  type BmadLifecyclePreflightResult,
  type MigrationReport,
} from "../parity/rules";
import { Recipe } from "./Recipe";
import type { RecipeRegistry } from "./registry";
import { gatesProject } from "./types";
import type {
  LifecycleContext,
  RecipeInitResult,
  RecipeMetadata,
  RecipePhaseOutcome,
} from "./types";
import type { HermesAgentContext } from "../commands/hermes/types";
import { ApplyDeferredExternalEffects } from "../commands/hermes/ApplyDeferredExternalEffects";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";
import type { TrustedCopierIdentity } from "../lifecycle/preflight";
import type { NotebookPlanV1 } from "../notebook/observation";
import { NotebookRecipe } from "./NotebookRecipe";

export interface ProjectRecipeInput {
  plan: ProjectInitPlan;
  mode: "create" | "sync";
  selectedRuleIds?: readonly string[];
  selectedOperations?: readonly string[];
  agentContext?: Partial<HermesAgentContext>;
  quiet?: boolean;
  trustedCopier?: TrustedCopierIdentity;
  requireTrustedCopier?: boolean;
}

export interface ProjectRecipeResult extends RecipeInitResult {
  plan: ProjectInitPlan;
  mode: "create" | "sync";
  audit?: AuditReport;
  migrationReport?: MigrationReport;
  selectedOperations: readonly string[];
  selectedParityRules: readonly string[];
  agentResult?: RecipeInitResult;
}

export interface ProjectRecipeRuntime {
  executePlan(plan: ProjectInitPlan, options?: ProjectInitExecutionOptions): Promise<ProjectInitExecutionResult>;
  preflightBmad(ctx: LifecycleContext): BmadLifecyclePreflightResult;
  runGit(
    cwd: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}

const BOOTSTRAP_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Pjangler Lifecycle",
  GIT_AUTHOR_EMAIL: "pjangler@localhost.invalid",
  GIT_COMMITTER_NAME: "Pjangler Lifecycle",
  GIT_COMMITTER_EMAIL: "pjangler@localhost.invalid",
};

const PRODUCTION_RUNTIME: ProjectRecipeRuntime = {
  executePlan: executeProjectInitPlan,
  preflightBmad: preflightBmadLifecycle,
  runGit(cwd, args, options) {
    const result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  },
};

/**
 * PJAN-84: prove the path being deleted is the path that was created.
 *
 * The rollback was `rmSync(targetDir, {recursive: true, force: true})` on the
 * sole evidence that `existsSync(targetDir)` had been false at the start. Node's
 * recursive remove does not FOLLOW a symlink at the leaf, but it does traverse
 * symlinked PARENT components — so if any ancestor of the target became a
 * symlink during the transaction, the delete lands somewhere nobody named. Every
 * other place in this codebase that touches an unproved path checks this first
 * (src/notebook/hooks.ts, src/parity/pack.ts); the one operation that deletes a
 * whole directory tree did not.
 *
 * Returns null when the path is safe to remove, or the reason it is not.
 */
export function unsafeToRemove(targetDir: string): string | null {
  const absolute = resolve(targetDir);
  let cursor = absolute;
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return cursor === absolute
          ? `${absolute} is a symlink; removing it would leave the tree it points at orphaned`
          : `${cursor} is a symlink on the path to ${absolute}; a recursive remove would traverse it`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return `${cursor} could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function publicAudit(report: ReturnType<RecipeRegistry["auditRecipes"]>): AuditReport {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding),
  } as AuditReport;
}

function publicMigration(report: Awaited<ReturnType<RecipeRegistry["migrateRules"]>>): MigrationReport {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result),
  } as MigrationReport;
}

function hasGitRepository(runtime: ProjectRecipeRuntime, targetDir: string): boolean {
  if (!existsSync(join(targetDir, ".git"))) return false;
  return runtime.runGit(targetDir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
}

/**
 * The repo-local manifest is authoritative for state discovered while running
 * the project transaction (most notably Hermes role directories). Project the
 * canonical result back into the pending central-registry write so persisting
 * the registry last cannot reintroduce pre-provisioning state on the next run.
 */
function refreshPlanFromCanonicalManifest(plan: ProjectInitPlan): void {
  const manifestPath = join(plan.project.repo_path, ".project.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProjectManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }

  const agents = createSafeRecord<ProjectAgentRecord>();
  for (const [agentId, entry] of Object.entries(manifest.agents ?? {})) {
    const rawRole = typeof entry?.role === "string" ? entry.role : "";
    if (!rawRole.trim()) throw new Error(`${manifestPath} agents.${agentId}.role is missing`);
    const role = normalizeAgentRole(rawRole);
    if (Object.hasOwn(agents, role)) throw new Error(`${manifestPath} declares more than one ${role} agent`);
    agents[role] = {
      role,
      role_dir: entry.role_dir,
      provisioning_state: entry.provisioning_state ?? "provisioned",
    };
  }
  const manifestTicket = manifest.ticket_provider;
  if (!manifestTicket || typeof manifestTicket !== "object") {
    throw new Error(`${manifestPath} ticket_provider is missing`);
  }
  const manifestIdentifier = String(manifestTicket.identifier ?? "");
  const manifestBoardId = String(manifestTicket.board_id ?? "");
  const manifestType = String(manifestTicket.type ?? "");
  // `.project.json` is authoritative for the BINDING, and the adapter that
  // wrote it stamps `board_confirmed_at` at the instant the provider handed the
  // board back — so board-binding provenance travels with the binding.
  // IDENTIFIER provenance does not: the manifest cannot say where a key came
  // from beyond what it was told, so keep what the registry already knows when
  // the manifest agrees, and otherwise degrade to "proposed" until
  // `pj project identity` re-reads the truth.
  const recorded = plan.project.ticket_provider;
  const carriesProvenance =
    (recorded?.identifier ?? "") === manifestIdentifier && (recorded?.board_id ?? "") === manifestBoardId;
  const identifierSource = (carriesProvenance ? recorded?.identifier_source : undefined) ?? "proposed";
  const manifestConfirmedAt =
    typeof manifestTicket.board_confirmed_at === "string" ? manifestTicket.board_confirmed_at.trim() : "";
  const boardConfirmedAt =
    manifestConfirmedAt || ((recorded?.board_id ?? "") === manifestBoardId ? recorded?.board_confirmed_at ?? "" : "");
  // Plane names its own boards; Trello does not. A link needs a confirmed
  // board from either, and a provider-sourced key only from the former.
  const keyIsProven = !providerAssignsIdentifiers(manifestType) || identifierSource === "provider";
  const manifestState = typeof manifestTicket.state === "string" ? manifestTicket.state : undefined;
  const ticketProvider: ProjectTicketProvider = {
    type: manifestType,
    workspace: String(manifestTicket.workspace ?? ""),
    identifier: manifestIdentifier,
    identifier_source: identifierSource,
    ...(carriesProvenance && identifierSource === "provider" && recorded?.identifier_fetched_at
      ? { identifier_fetched_at: recorded.identifier_fetched_at }
      : {}),
    board_id: manifestBoardId,
    ...(boardConfirmedAt ? { board_confirmed_at: boardConfirmedAt } : {}),
    state:
      manifestState === "skipped"
        ? "skipped"
        : manifestBoardId && boardConfirmedAt && keyIsProven
          ? "linked"
          : "planned",
  };

  plan.manifest = manifest;
  plan.project.agents = agents;
  plan.project.ticket_provider = ticketProvider;
  for (const action of plan.actions) {
    if (action.kind === "project.write-manifest") action.manifest = manifest;
    if (action.kind === "registry.upsert") action.project = plan.project;
  }
}

/**
 * Project-level transaction boundary shared by CLI and MCP.
 *
 * It executes the selected plan, initializes declared lifecycle dependencies
 * only for a fresh scaffold, applies only explicitly selected sync migrations,
 * proves eligibility, initializes Git and local registry state, then runs the
 * provider/systemd tail followed only by read-only postcondition verification.
 * No implicit migrate-all repair phase exists.
 */
export class ProjectRecipe extends Recipe<ProjectRecipeInput | ProjectInitPlan> {
  readonly orchestratesDependencies = true;
  readonly checks = createProjectChecks();
  readonly metadata: RecipeMetadata = {
    id: "project",
    name: "project",
    description: "CommonProject plan, lifecycle composition, audit, and Git boundary",
    dependencies: ["mise", "agent-hooks", "bmad", "notebook"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  private registry?: RecipeRegistry;

  constructor(private readonly runtime: ProjectRecipeRuntime = PRODUCTION_RUNTIME) {
    super();
  }

  attachRegistry(registry: RecipeRegistry): void {
    this.registry = registry;
  }

  private async runNotebookLifecycle(plan: ProjectInitPlan, mode: "create" | "sync", ctx: LifecycleContext): Promise<NotebookPlanV1> {
    if (!this.registry) throw new Error("ProjectRecipe is not attached to a RecipeRegistry");
    const result = await this.registry.initRecipe("notebook", ctx, { plan, mode });
    if (!result.ok || !result.notebookPlan) throw new Error(result.errors.join("; ") || "Notebook lifecycle planning failed");
    return result.notebookPlan as NotebookPlanV1;
  }

  override async init(ctx: LifecycleContext, input: ProjectRecipeInput | ProjectInitPlan): Promise<ProjectRecipeResult> {
    if (!this.registry) throw new Error("ProjectRecipe is not attached to a RecipeRegistry");
    const normalized: ProjectRecipeInput = "plan" in input
      ? input
      : {
          plan: input,
          mode: input.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
        };
    const { plan, mode } = normalized;
    const targetDir = plan.project.repo_path;
    const phases: RecipePhaseOutcome[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const changedFiles: string[] = [];
    const targetExistedAtStart = existsSync(targetDir);
    const transactionContext: LifecycleContext = {
      ...ctx,
      targetDir,
      repoRoot: targetDir,
      bmadVersionPin: mode === "create" ? BMAD_INSTALLER_VERSION : ctx.bmadVersionPin,
    };
    let agentResult: RecipeInitResult | undefined;
    let provisionedAgentContext: (LifecycleContext & HermesAgentContext) | undefined;
    let migrationReport: MigrationReport | undefined;
    let audit: AuditReport | undefined;
    let notebookPlan: NotebookPlanV1 | undefined;
    let notebookRecipeForCommit: NotebookRecipe | undefined;
    let notebookJournals: Parameters<NotebookRecipe["commitExternal"]>[0] = [];
    let externalDispatchStarted = false;
    let rollbackEligible = true;
    let registryFinalizerEligible = false;

    try {
      if (mode === "create") {
        const preflight = this.runtime.preflightBmad(transactionContext);
        phases.push({
          id: "project.preflight:bmad",
          status: preflight.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: preflight.ok ? "Pinned BMAD installer and sealed pack are available" : preflight.error,
        });
        if (!preflight.ok) errors.push(`BMAD preflight failed: ${preflight.error ?? "unknown error"}`);
      }

      const registryActions = plan.actions.filter((action) => action.kind === "registry.upsert");
      const externalPlanActions = plan.actions.filter((action) => action.kind === "ticket-provider.create-or-link");
      const filesystemPlan: ProjectInitPlan = {
        ...plan,
        actions: plan.actions.filter((action) =>
          action.kind !== "registry.upsert"
          && action.kind !== "hermes.provision-agent"
          && action.kind !== "ticket-provider.create-or-link"),
      };
      const planBlocked = errors.length > 0;
      const executed = !planBlocked && filesystemPlan.actions.length
        ? await this.runtime.executePlan(filesystemPlan, {
            trustedCopier: normalized.trustedCopier,
            requireTrustedCopier: normalized.requireTrustedCopier,
          })
        : { ok: !planBlocked, plan: filesystemPlan, logs: [], errors: [], changedFiles: [] };
      logs.push(...executed.logs);
      errors.push(...executed.errors);
      changedFiles.push(...executed.changedFiles);
      phases.push({
        id: "project.plan",
        status: planBlocked ? "skipped" : executed.ok ? (executed.changedFiles.length ? "changed" : "unchanged") : "failed",
        changedFiles: executed.ok ? executed.changedFiles : [],
        message: planBlocked ? "Project plan skipped after failed preflight" : executed.ok ? "Project plan executed" : executed.errors.join("; "),
      });

      if (errors.length === 0 && executed.ok && mode === "create") {
        const dependencyResult = await this.registry.initDependencies(this.metadata.id, transactionContext, normalized, ["notebook"]);
        logs.push(...dependencyResult.logs);
        errors.push(...dependencyResult.errors);
        changedFiles.push(...dependencyResult.changedFiles);
        phases.push(...dependencyResult.phases);
      }

      if (errors.length === 0 && executed.ok) {
        try {
          notebookPlan = await this.runNotebookLifecycle(plan, mode, transactionContext);
          phases.push({
            id: "notebook.plan",
            status: notebookPlan.remote_effect === "reconcile" ? "planned" : "skipped",
            changedFiles: [],
            message: notebookPlan.reason,
          });
        } catch (error) {
          errors.push(`notebook lifecycle planning failed: ${error instanceof Error ? error.message : String(error)}`);
          phases.push({ id: "notebook.plan", status: "failed", changedFiles: [], message: errors.at(-1) });
        }
      }

      if (errors.length === 0 && notebookPlan) {
        const notebookRecipe = this.registry.get("notebook");
        if (!(notebookRecipe instanceof NotebookRecipe)) throw new Error("Registered notebook recipe is not the singleton NotebookRecipe");
        const localNotebook = await notebookRecipe.applyLocal(transactionContext, plan, notebookPlan);
        logs.push(...localNotebook.logs);
        errors.push(...localNotebook.errors);
        changedFiles.push(...localNotebook.changedFiles);
        phases.push(...localNotebook.phases);
      }

      const agentAction = plan.actions.find((action) => action.kind === "hermes.provision-agent" && action.enabled);
      if (errors.length === 0 && agentAction?.kind === "hermes.provision-agent") {
        const agentContext: HermesAgentContext = {
          targetRepo: agentAction.targetRepo,
          role: agentAction.role,
          agentPurpose: `${agentAction.role} agent for ${agentAction.targetRepo}`,
          ticketProvider: plan.project.ticket_provider.type as "plane" | "trello",
          local: agentAction.local,
          force: Boolean(ctx.force),
          skipTelegram: true,
          skipEmail: true,
          skipPlane: agentAction.context.skipPlane,
          skipBloodbank: agentAction.context.skipBloodbank,
          skipSystemd: agentAction.context.skipSystemd,
          ...(normalized.agentContext ?? {}),
          targetDir,
          yes: true,
          // Structured callers own stdout and prompt input. Do not allow a
          // nested context object to weaken the transaction's quiet contract.
          quiet: normalized.quiet ?? ctx.quiet ?? false,
          dryRun: false,
        };
        provisionedAgentContext = { ...transactionContext, ...agentContext, targetDir, repoRoot: targetDir };
        agentResult = await this.registry.initRecipe(
          "hermes-agent",
          provisionedAgentContext,
          agentContext,
        );
        logs.push(...agentResult.logs);
        errors.push(...agentResult.errors);
        changedFiles.push(...agentResult.changedFiles);
        phases.push(...agentResult.phases);
      }

      // A fresh scaffold and an agent-provisioning action both create state
      // governed by this recipe. Close only ProjectRecipe's own checks here;
      // existing syncs without such an action still require explicitly selected
      // migrations and never receive an implicit migrate-all repair pass.
      if (errors.length === 0 && (mode === "create" || agentResult)) {
        const projectLifecycle = await this.initializeOwnedChecks(transactionContext);
        logs.push(...projectLifecycle.logs);
        errors.push(...projectLifecycle.errors);
        changedFiles.push(...projectLifecycle.changedFiles);
        phases.push(...projectLifecycle.phases);
        if (projectLifecycle.ok) {
          try {
            refreshPlanFromCanonicalManifest(plan);
          } catch (error) {
            errors.push(`project manifest refresh failed: ${error instanceof Error ? error.message : String(error)}`);
            phases.push({
              id: "project.manifest-refresh",
              status: "failed",
              changedFiles: [],
              message: errors.at(-1),
            });
          }
        }
      }

      if (errors.length === 0 && normalized.selectedRuleIds?.length) {
        migrationReport = publicMigration(await this.registry.migrateRules(
          { ...transactionContext, dryRun: false },
          normalized.selectedRuleIds,
        ));
        changedFiles.push(...migrationReport.changedFiles);
        phases.push(...migrationReport.results.map((result) => ({
          id: result.id,
          status: result.status === "applied" ? "changed" : result.status === "noop" ? "unchanged" : result.status === "skipped" ? "skipped" : "failed",
          // A `partial` failed, but its writes really happened, so they stay
          // accounted for rather than vanishing from the transaction record.
          changedFiles: result.status === "applied" || result.status === "partial" ? result.changedFiles : [],
          message: result.summary,
        } as RecipePhaseOutcome)));
        errors.push(...migrationReport.results
          .filter((result) => result.status === "blocked" || result.status === "partial")
          .map((result) => `${result.id}: ${result.summary}`));
      }

      const eligibilityAudit = errors.length === 0
        ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true }))
        : undefined;
      audit = eligibilityAudit;
      if (eligibilityAudit && !eligibilityAudit.ok) {
        errors.push(...eligibilityAudit.rules
          // PJAN-84: only a PROJECT-scoped failure is this transaction's problem.
          // A host finding — a drifted ~/.agents symlink, a systemd unit, the
          // fleet registry — cannot be fixed by the repo being created, and
          // failing here used to delete it (see the rollback guard below).
          .filter((finding) => gatesProject(finding))
          .map((finding) => `${finding.id}: ${finding.summary}`));
      }
      phases.push({
        id: "project.audit:eligibility",
        status: eligibilityAudit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: eligibilityAudit?.ok
          ? "Lifecycle eligibility audit passed before external effects"
          : "Lifecycle eligibility audit failed or was skipped; external effects remain disabled",
      });

      // Complete every ordinary local operation that can fail before entering
      // the explicitly granted external tail. External scripts may persist
      // their own returned identifiers, but no new lifecycle mutation follows
      // them; only the postcondition audit below remains.
      if (errors.length === 0 && mode === "create") {
        if (hasGitRepository(this.runtime, targetDir)) {
          phases.push({ id: "project.git", status: "unchanged", changedFiles: [], message: "Git repository already initialized" });
        } else {
          const gitPath = join(targetDir, ".git");
          for (const { args, label, options } of [
            { args: ["init", "--initial-branch=main"], label: "git init" },
            { args: ["add", "-A"], label: "git add" },
            {
              args: ["commit", "--no-gpg-sign", "-m", "chore: initialize project"],
              label: "git commit",
              options: { env: BOOTSTRAP_GIT_IDENTITY },
            },
          ] as const) {
            const result = this.runtime.runGit(targetDir, args, options);
            if (result.status !== 0) {
              errors.push(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
              phases.push({ id: `project.git:${label}`, status: "failed", changedFiles: changedFiles.includes(gitPath) ? [gitPath] : [], message: errors.at(-1) });
              break;
            }
            if (label === "git init" && existsSync(gitPath)) changedFiles.push(gitPath);
            logs.push(`${label}: ok`);
          }
          if (errors.length === 0) {
            const repositoryReady = hasGitRepository(this.runtime, targetDir);
            const headReady = repositoryReady && this.runtime.runGit(targetDir, ["rev-parse", "--verify", "HEAD"]).status === 0;
            if (!headReady) {
              errors.push("git postcondition failed: repository or initial commit is missing");
              phases.push({ id: "project.git:postcondition", status: "failed", changedFiles: existsSync(gitPath) ? [gitPath] : [], message: errors.at(-1) });
            } else {
              if (!changedFiles.includes(gitPath)) changedFiles.push(gitPath);
              phases.push({ id: "project.git", status: "changed", changedFiles: [gitPath], message: "Git repository initialized and committed" });
            }
          }
        }
      }
      registryFinalizerEligible = errors.length === 0;

      if (errors.length === 0 && externalPlanActions.length) {
        // Any enabled provider action crosses an adapter boundary, including a
        // link/reconcile of an already-known board. Latch before handing the
        // action to the adapter so fresh-target rollback can never delete local
        // recovery evidence after external dispatch might have started.
        const dispatching = externalPlanActions.some((action) => action.kind === "ticket-provider.create-or-link" && action.enabled);
        if (dispatching) {
          externalDispatchStarted = true;
          rollbackEligible = false;
        }
        const externalPlan: ProjectInitPlan = {
          ...plan,
          actions: externalPlanActions,
        };
        const external = await this.runtime.executePlan(externalPlan);
        logs.push(...external.logs);
        errors.push(...external.errors);
        changedFiles.push(...external.changedFiles);
        phases.push({
          id: "project.external:ticket-provider",
          status: external.ok ? (external.changedFiles.length ? "changed" : "unchanged") : "failed",
          changedFiles: external.ok ? external.changedFiles : [],
          message: external.ok ? "Deferred ticket-provider phase completed" : external.errors.join("; "),
        });
      }


      if (errors.length === 0 && notebookPlan?.remote_effect === "reconcile") {
        if (!ctx.live) {
          phases.push({ id: "project.external:notebook", status: "skipped", changedFiles: [], message: "Notebook remote reconciliation requires --live" });
        } else {
          externalDispatchStarted = true;
          rollbackEligible = false;
          const notebookRecipe = this.registry.get("notebook");
          if (!(notebookRecipe instanceof NotebookRecipe)) throw new Error("Registered notebook recipe is not the singleton NotebookRecipe");
          try {
            const applied = await notebookRecipe.applyExternal(plan, notebookPlan);
            notebookRecipeForCommit = notebookRecipe;
            notebookJournals = applied.data.journals ?? [];
            logs.push(`notebook: reconciled ${applied.data.notebook_id} with Overview ${applied.data.overview_note_id}`);
            const manifestActions = plan.actions.filter((action) => action.kind === "project.write-manifest");
            const projected = manifestActions.length
              ? await this.runtime.executePlan({ ...plan, actions: manifestActions })
              : { ok: true, logs: [], errors: [], changedFiles: [] };
            logs.push(...projected.logs);
            errors.push(...projected.errors);
            changedFiles.push(...projected.changedFiles);
            if (projected.ok) {
              notebookPlan = notebookRecipe.refreshPlan(plan, notebookPlan);
              transactionContext.notebookPlan = notebookPlan;
              const projectedNotebook = (plan.manifest as ProjectManifest & { notebook?: { binding?: Record<string, unknown> } }).notebook;
              transactionContext.notebookManifestBinding = projectedNotebook?.binding
                ? Object.freeze({ ...projectedNotebook.binding })
                : null;
              transactionContext.notebookObservation = Object.freeze(await notebookRecipe.observeExternal(plan, notebookPlan));
              const candidateAudit = publicAudit(this.registry.auditRecipes(transactionContext, ["notebook"]));
              if (!candidateAudit.ok) errors.push(...candidateAudit.rules.filter((item) => item.status === "fail" || item.status === "warn").map((item) => `${item.id}: ${item.summary}`));
            }
            phases.push({
              id: "project.external:notebook",
              status: errors.length === 0 ? (projected.changedFiles.length ? "changed" : "unchanged") : "failed",
              changedFiles: errors.length === 0 ? projected.changedFiles : [],
              message: errors.length === 0 ? "Notebook and stable Overview reconciled and observation-audited" : errors.at(-1),
            });
          } catch (error) {
            errors.push(`notebook external effect failed: ${error instanceof Error ? error.message : String(error)}`);
            phases.push({ id: "project.external:notebook", status: "failed", changedFiles: [], message: errors.at(-1) });
          }
        }
      }

      const deferred = provisionedAgentContext?.deferredExternalEffects;
      if (errors.length === 0 && deferred?.owner === "project" && (deferred.ticketBoard || deferred.systemd)) {
        externalDispatchStarted = true;
        rollbackEligible = false;
        const beforeExternal = snapshotTree(targetDir);
        const external = await new ApplyDeferredExternalEffects(provisionedAgentContext!).invoke();
        const externalChanges = changedTreePaths(targetDir, beforeExternal, snapshotTree(targetDir));
        logs.push(...(external.message ? [external.message] : []));
        if (!external.success) errors.push(external.message || "Deferred Hermes external effects failed");
        changedFiles.push(...externalChanges);
        phases.push({
          id: "project.external:hermes",
          status: external.success ? "changed" : "failed",
          changedFiles: external.success ? externalChanges : [],
          message: external.message || undefined,
        });
      }

      if (registryFinalizerEligible && (externalPlanActions.length || notebookPlan || deferred)) {
        try {
          refreshPlanFromCanonicalManifest(plan);
        } catch (error) {
          errors.push(`project manifest refresh after external effects failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // One Registry-only finalizer is the last mutation. It persists linked
      // successes and planned/blocked recovery even when an external effect
      // failed, then no lifecycle writer runs again in this transaction.
      if (registryFinalizerEligible && registryActions.length) {
        rollbackEligible = false;
        const registryPlan: ProjectInitPlan = { ...plan, actions: registryActions };
        const persisted = await this.runtime.executePlan(registryPlan);
        logs.push(...persisted.logs);
        errors.push(...persisted.errors);
        changedFiles.push(...persisted.changedFiles);
        phases.push({
          id: "project.registry:finalizer",
          status: persisted.ok ? (persisted.changedFiles.length ? "changed" : "unchanged") : "failed",
          changedFiles: persisted.ok ? persisted.changedFiles : [],
          message: persisted.ok ? "Project Registry persisted as the final mutation" : persisted.errors.join("; "),
        });
        if (errors.length === 0 && persisted.ok && notebookRecipeForCommit && notebookJournals.length) {
          try { notebookRecipeForCommit.commitExternal(notebookJournals); }
          catch (error) { errors.push(`notebook ownership journal finalization failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }

      audit = errors.length === 0
        ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true }))
        : audit;
      if (errors.length === 0 && audit && !audit.ok) {
        errors.push(...audit.rules
          // PJAN-84: only a PROJECT-scoped failure is this transaction's problem.
          // A host finding — a drifted ~/.agents symlink, a systemd unit, the
          // fleet registry — cannot be fixed by the repo being created, and
          // failing here used to delete it (see the rollback guard below).
          .filter((finding) => gatesProject(finding))
          .map((finding) => `${finding.id}: ${finding.summary}`));
      }
      phases.push({
        id: "project.audit",
        status: errors.length === 0 && audit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: errors.length === 0 && audit?.ok
          ? "Lifecycle postcondition audit passed"
          : "Lifecycle postcondition audit failed or was skipped",
      });

    } catch (error) {
      errors.push(`project transaction failed: ${error instanceof Error ? error.message : String(error)}`);
      phases.push({
        id: "project.transaction",
        status: "failed",
        changedFiles: [],
        message: errors.at(-1),
      });
    }

    // `externalDispatchStarted` and `rollbackEligible` were assigned together
    // everywhere except the registry finalizer, so this conjunction always
    // reduced to `rollbackEligible` — two names for one fact. Because the latch
    // had no single meaning, nothing forced the notebook and Hermes HOST writes
    // earlier in this method to answer "does this need to latch?", and a failure
    // after them deleted the project while leaving that host state behind.
    if (errors.length > 0 && mode === "create" && !targetExistedAtStart && rollbackEligible && existsSync(targetDir)) {
      const unsafe = unsafeToRemove(targetDir);
      if (unsafe) {
        // Refusing leaves the target in place and says why. That is strictly
        // better than deleting through a symlink: the operator can inspect it,
        // and `pj init` over an existing directory is a supported path.
        errors.push(`fresh-target rollback refused: ${unsafe}`);
        phases.push({
          id: "project.rollback",
          status: "failed",
          changedFiles: [],
          message: errors.at(-1),
        });
      } else try {
        rmSync(targetDir, { recursive: true, force: true });
        // Report what survived rather than erasing the record.
        //
        // This used to be `changedFiles.length = 0`, which claimed the
        // transaction had changed nothing — while every write it made OUTSIDE
        // the target was still on disk. A run that installed a global skill
        // link and rewrote ~/.claude/settings.json reported `changedFiles: []`
        // and deleted the only thing that referenced them.
        const insideTarget = (path: string) => {
          const relative = relativePath(resolve(targetDir), resolve(path));
          return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
        };
        const orphaned = [...new Set(changedFiles.filter((path) => !insideTarget(path)))].sort();
        changedFiles.length = 0;
        changedFiles.push(...orphaned);
        logs.push(`Rolled back newly-created target: ${targetDir}`);
        for (const path of orphaned) logs.push(`  not undone (outside the target): ${path}`);
        phases.push({
          id: "project.rollback",
          status: "changed",
          changedFiles: orphaned,
          message: orphaned.length
            ? `Removed the newly-created target; ${orphaned.length} change(s) outside it were NOT undone`
            : "Removed the newly-created target after transaction failure",
        });
      } catch (error) {
        errors.push(`fresh-target rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        phases.push({
          id: "project.rollback",
          status: "failed",
          changedFiles: [],
          message: errors.at(-1),
        });
      }
    }

    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0 && Boolean(audit?.ok),
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
      plan,
      mode,
      audit,
      selectedOperations: normalized.selectedOperations ?? [],
      selectedParityRules: normalized.selectedRuleIds ?? [],
      migrationReport,
      agentResult,
    };
  }

  protected printNextSteps(): void {
    // Project init surfaces format the structured result themselves.
  }
}
