import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createSafeRecord,
  executeProjectInitPlan,
  normalizeAgentRole,
  type ProjectAgentRecord,
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
import type {
  LifecycleContext,
  RecipeInitResult,
  RecipeMetadata,
  RecipePhaseOutcome,
} from "./types";
import type { HermesAgentContext } from "../commands/hermes/types";
import { ApplyDeferredExternalEffects } from "../commands/hermes/ApplyDeferredExternalEffects";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";

export interface ProjectRecipeInput {
  plan: ProjectInitPlan;
  mode: "create" | "sync";
  selectedRuleIds?: readonly string[];
  selectedOperations?: readonly string[];
  agentContext?: Partial<HermesAgentContext>;
  quiet?: boolean;
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
  executePlan(plan: ProjectInitPlan): Promise<ProjectInitExecutionResult>;
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
  const ticketProvider: ProjectTicketProvider = {
    type: String(manifestTicket.type ?? ""),
    workspace: String(manifestTicket.workspace ?? ""),
    identifier: String(manifestTicket.identifier ?? ""),
    board_id: String(manifestTicket.board_id ?? ""),
    state: manifestTicket.state,
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
    dependencies: ["mise", "agent-hooks", "bmad"],
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
        ? await this.runtime.executePlan(filesystemPlan)
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
        const dependencyResult = await this.registry.initDependencies(this.metadata.id, transactionContext, normalized);
        logs.push(...dependencyResult.logs);
        errors.push(...dependencyResult.errors);
        changedFiles.push(...dependencyResult.changedFiles);
        phases.push(...dependencyResult.phases);
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
          skipRuntimeRepo: agentAction.context.skipRuntimeRepo,
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
          changedFiles: result.status === "applied" ? result.changedFiles : [],
          message: result.summary,
        } as RecipePhaseOutcome)));
        errors.push(...migrationReport.results
          .filter((result) => result.status === "blocked")
          .map((result) => `${result.id}: ${result.summary}`));
      }

      const eligibilityAudit = errors.length === 0
        ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true }))
        : undefined;
      audit = eligibilityAudit;
      if (eligibilityAudit && !eligibilityAudit.ok) {
        errors.push(...eligibilityAudit.rules
          .filter((finding) => finding.status === "fail" || finding.status === "warn")
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

      const boardEffectArmed = externalPlanActions.some((action) => action.kind === "ticket-provider.create-or-link" && action.enabled);
      if (errors.length === 0 && registryActions.length && !boardEffectArmed) {
        const registryPlan: ProjectInitPlan = { ...plan, actions: registryActions };
        const persisted = await this.runtime.executePlan(registryPlan);
        logs.push(...persisted.logs);
        errors.push(...persisted.errors);
        changedFiles.push(...persisted.changedFiles);
        phases.push({
          id: "project.registry",
          status: persisted.ok ? (persisted.changedFiles.length ? "changed" : "unchanged") : "failed",
          changedFiles: persisted.ok ? persisted.changedFiles : [],
          message: persisted.ok ? "Project registry persisted" : persisted.errors.join("; "),
        });
      }

      if (errors.length === 0 && externalPlanActions.length) {
        // When a board effect is armed, persist the returned binding inside the
        // same tail immediately after the provider action. This keeps the
        // central registry truthful without reopening ordinary local lifecycle
        // work after the external boundary.
        const externalPlan: ProjectInitPlan = {
          ...plan,
          actions: boardEffectArmed ? [...externalPlanActions, ...registryActions] : externalPlanActions,
        };
        const external = await this.runtime.executePlan(externalPlan);
        logs.push(...external.logs);
        errors.push(...external.errors);
        changedFiles.push(...external.changedFiles);
        phases.push({
          id: "project.external:ticket-provider",
          status: external.ok ? (external.changedFiles.length ? "changed" : "unchanged") : "failed",
          changedFiles: external.ok ? external.changedFiles : [],
          message: external.ok ? "Deferred ticket-provider/binding persistence phase completed" : external.errors.join("; "),
        });
      }

      const deferred = provisionedAgentContext?.deferredExternalEffects;
      if (errors.length === 0 && deferred?.owner === "project" && (deferred.runtimeRepo || deferred.ticketBoard || deferred.systemd)) {
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

      if (errors.length === 0 && (externalPlanActions.length || deferred)) {
        try {
          refreshPlanFromCanonicalManifest(plan);
        } catch (error) {
          errors.push(`project manifest refresh after external effects failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      audit = errors.length === 0
        ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true }))
        : audit;
      if (errors.length === 0 && audit && !audit.ok) {
        errors.push(...audit.rules
          .filter((finding) => finding.status === "fail" || finding.status === "warn")
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

    if (errors.length > 0 && mode === "create" && !targetExistedAtStart && existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
        changedFiles.length = 0;
        logs.push(`Rolled back newly-created target: ${targetDir}`);
        phases.push({
          id: "project.rollback",
          status: "changed",
          changedFiles: [],
          message: "Removed the newly-created target after transaction failure",
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
