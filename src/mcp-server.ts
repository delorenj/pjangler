#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecipeInfo, getRecipeNames, COMMAND_REGISTRY, RECIPE_REGISTRY } from "./utils/registry";
import type { CommandContext } from "./commands/Command";
import type { HermesAgentContext, TicketProvider } from "./commands/hermes/types";
import { PJANGLER_VERSION } from "./utils/version";
import { lifecycleContext, recipeRegistry, formatAuditReport, getParityRuleIds, runAudit, runMigration } from "./parity/index";
import { describeProject, formatProjectDescription } from "./describe/index";
import {
  getProject,
  loadProjectRegistry,
  normalizeAgentRole,
  planProjectInit,
  projectRegistryPath,
  proposeProjectIdentifier,
  resolveContainedPath,
  type ProjectManifest,
  validateSafePathSegment,
} from "./project/index";
import type { ProjectRecipeInput, ProjectRecipeResult } from "./recipes/ProjectRecipe";
import type { LifecycleContext } from "./recipes/types";
import { preflightMcpLifecycle, type TrustedCopierIdentity } from "./lifecycle/preflight";

const server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION,
});

const TICKET_PROVIDER_SCHEMA = z.enum(["plane", "trello"]);
const BOARD_URL_COMPAT_SCHEMA = z.string()
  .optional()
  .describe("Deprecated compatibility input. Ignored; board URLs are derived at runtime and are never persisted.")
  .meta({ deprecated: true });
const RUNTIME_REPO_COMPAT_SCHEMA = z.boolean()
  .optional()
  .describe("Deprecated no-op. Hermes always converges ignored role-local runtime state and never provisions a per-agent GitHub repository.")
  .meta({ deprecated: true });

function safePathSegmentSchema(label: string) {
  return z.string().superRefine((value, context) => {
    try {
      validateSafePathSegment(value, label);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

const PROJECT_SLUG_SCHEMA = safePathSegmentSchema("Project slug")
  .describe("A safe single path segment used as the project registry slug.");
const AGENT_ROLE_SCHEMA = safePathSegmentSchema("Agent role")
  .describe("An arbitrary safe single path segment used beneath agents/hermes; not a fixed role enum.");
const TARGET_REPO_SCHEMA = safePathSegmentSchema("Hermes target repository")
  .describe("A safe repository/profile identity segment; defaults to the target directory basename.");
const EXPLICIT_TARGET_DIR_SCHEMA = z.string().refine((value) => value.trim().length > 0, {
  message: "targetDir must be a non-empty explicit path",
});

const INTERACTIVE_RECIPE_IDS = new Set(["hermes-agent"]);
const GENERIC_RECIPE_NAMES = getRecipeNames().filter((name) => !INTERACTIVE_RECIPE_IDS.has(name));
if (GENERIC_RECIPE_NAMES.length === 0) throw new Error("No non-interactive recipes are registered for generic MCP execution");

interface ExternalEffectConsentInput {
  live?: boolean;
  local?: boolean;
  /** Deprecated no-op compatibility fields; neither grants nor subtracts authority. */
  provisionRuntimeRepo?: boolean;
  skipRuntimeRepo?: boolean;
  provisionTicketBoard?: boolean;
  enableSystemd?: boolean;
  skipPlane?: boolean;
  skipSystemd?: boolean;
}

interface ExternalEffectSelection {
  ticketBoard: boolean;
  systemd: boolean;
}

/**
 * Resolve explicit positive grants before any handler performs filesystem or
 * subprocess work. Negative/local flags may only subtract authority; they can
 * never enable an effect by themselves.
 */
function validateExternalEffectConsent(
  input: ExternalEffectConsentInput,
  options: { requireNonLocal: boolean },
): ExternalEffectSelection {
  const selected: ExternalEffectSelection = {
    ticketBoard: input.provisionTicketBoard === true,
    systemd: input.enableSystemd === true,
  };
  const anySelected = selected.ticketBoard || selected.systemd;
  if (anySelected && input.live !== true) {
    throw new Error("External Hermes effects require live=true in addition to explicit positive opt-ins");
  }
  if (anySelected && options.requireNonLocal && input.local !== false) {
    throw new Error("External Hermes effects require local=false in addition to live=true and explicit positive opt-ins");
  }
  if (selected.ticketBoard && input.skipPlane === true) {
    throw new Error("provisionTicketBoard=true contradicts skipPlane=true");
  }
  if (selected.systemd && input.skipSystemd === true) {
    throw new Error("enableSystemd=true contradicts skipSystemd=true");
  }
  if (selected.systemd && process.platform === "darwin") {
    throw new Error("enableSystemd=true is unavailable on macOS");
  }
  return selected;
}

function resolveTargetDir(targetDir?: string): string {
  const dir = resolve(targetDir ?? process.cwd());
  if (!existsSync(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}

function resolvePjanglerRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Unable to resolve pjangler root");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function publicProjectPlan(plan: ReturnType<typeof planProjectInit>) {
  return {
    ...plan,
    actions: plan.actions.map((action) => {
      if (action.kind !== "hermes.provision-agent") return action;
      return {
        ...action,
        context: {
          skipPlane: action.context.skipPlane,
          skipSystemd: action.context.skipSystemd,
        },
      };
    }),
  };
}

function publicCompositeProjectResponse<T extends object>(payload: T, plan: ReturnType<typeof planProjectInit>) {
  const projectedPlan = publicProjectPlan(plan);
  const hasNestedPlan = "plan" in payload;
  const provisionsAgent = plan.actions.some((action) => action.kind === "hermes.provision-agent" && action.enabled);
  return {
    ...payload,
    ...(hasNestedPlan ? { plan: projectedPlan } : {}),
    ...(provisionsAgent ? {
      bloodbankMode: "fleet-shared" as const,
      runtimeMode: "role-local-ignored" as const,
    } : {}),
  };
}

async function executeRegisteredProjectPlan(
  plan: ReturnType<typeof planProjectInit>,
  agentContext?: Partial<HermesAgentContext>,
  lifecycleOverrides: Partial<LifecycleContext> = {},
  trustedCopier?: TrustedCopierIdentity,
) {
  const plannedAgent = plan.actions.find((action) => action.kind === "hermes.provision-agent" && action.enabled);
  const projectInput: ProjectRecipeInput = {
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    selectedRuleIds: [],
    selectedOperations: plan.actions.map((action) => action.kind),
    trustedCopier,
    requireTrustedCopier: Boolean(
      plan.actions.some((action) => action.kind === "copier.copy.commonproject")
      || plannedAgent?.kind === "hermes.provision-agent",
    ),
    agentContext: plannedAgent?.kind === "hermes.provision-agent"
      ? {
          ...agentContext,
          trustedCopier,
          deferredExternalEffects: {
            ticketBoard: !plannedAgent.context.skipPlane,
            systemd: !plannedAgent.context.skipSystemd,
            owner: "project",
          },
        }
      : agentContext,
    quiet: true,
  };
  return await recipeRegistry.initRecipe(
    "project",
    lifecycleContext(plan.project.repo_path, false, false, {
      ...agentContext,
      ...lifecycleOverrides,
      force: lifecycleOverrides.force ?? agentContext?.force ?? plan.actions.some((action) => action.kind === "copier.copy.commonproject" && action.overwrite),
      live: lifecycleOverrides.live ?? plan.live,
      quiet: lifecycleOverrides.quiet ?? true,
    }),
    projectInput,
  ) as ProjectRecipeResult;
}

function projectPreflightFailure(
  plan: ReturnType<typeof planProjectInit>,
  errors: readonly string[],
  audit?: ReturnType<typeof runAudit>,
): ProjectRecipeResult {
  return {
    recipeId: "project",
    ok: false,
    dryRun: false,
    changedFiles: [],
    logs: [],
    errors: [...errors],
    phases: [{
      id: "project.preflight:lifecycle",
      status: "failed",
      changedFiles: [],
      message: errors.join("; "),
    }],
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    audit,
    selectedOperations: plan.actions.map((action) => action.kind),
    selectedParityRules: [],
  };
}

/**
 * Reject non-repairable, already-present Hermes identity/scaffold failures
 * before trusted Copier or any host script runs. The pm-scaffold audit is
 * filesystem-only, so this check cannot itself invoke git, systemd, a provider,
 * or another subprocess.
 */
function preflightExistingHermesScaffold(targetDir: string): string | undefined {
  if (!existsSync(join(targetDir, "agents", "hermes"))) return undefined;
  const owner = recipeRegistry.ownerOf("hermes.pm-scaffold");
  if (!owner) return "Hermes lifecycle owner is unavailable";
  const finding = owner.check.audit(lifecycleContext(targetDir, true));
  if ((finding.status === "fail" || finding.status === "warn") && !finding.fixable) {
    const detail = finding.details.length ? ` (${finding.details.join("; ")})` : "";
    return `${finding.id}: ${finding.summary}${detail}`;
  }
  return undefined;
}

/**
 * Establish every lifecycle failure knowable without mutation before the
 * project transaction. Existing syncs may project a new canonical manifest,
 * so sot.project-json is the one current finding covered by that planned local
 * action. All other current drift would survive the operation and must block.
 */
interface ProjectApplyPreflight {
  failure?: ProjectRecipeResult;
  trustedCopier?: TrustedCopierIdentity;
}

function plannedNotebookBindingRepairsDrift(plan: ReturnType<typeof planProjectInit>): boolean {
  if (!plan.actions.some((action) => action.kind === "project.write-manifest")) return false;
  const authoritative = plan.project.notebook;
  const notebook = (plan.manifest as ProjectManifest & { notebook?: unknown }).notebook;
  const projected = notebook && typeof notebook === "object" && !Array.isArray(notebook)
    ? (notebook as Record<string, unknown>).binding
    : undefined;
  if (!authoritative || typeof authoritative !== "object" || !projected || typeof projected !== "object" || Array.isArray(projected)) return false;
  const projectedRecord = projected as Record<string, unknown>;
  return ["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"].every(
    (key) => (authoritative as unknown as Record<string, unknown>)[key] === projectedRecord[key],
  );
}

function preflightProjectApply(
  plan: ReturnType<typeof planProjectInit>,
  pjanglerRoot: string,
): ProjectApplyPreflight {
  const createsScaffold = plan.actions.some((action) => action.kind === "copier.copy.commonproject");
  const provisionsAgent = plan.actions.some((action) => action.kind === "hermes.provision-agent" && action.enabled);

  if (!createsScaffold && provisionsAgent) {
    const hermesBlocker = preflightExistingHermesScaffold(plan.project.repo_path);
    if (hermesBlocker) return { failure: projectPreflightFailure(plan, [hermesBlocker]) };
  }

  if (!createsScaffold) {
    const audit = runAudit(plan.project.repo_path);
    const blocking = audit.rules.filter((finding) => {
      if (finding.status === "pass" || finding.status === "skip") return false;
      if (finding.id === "sot.project-json") return false;
      if (finding.id === "notebook.binding" && plannedNotebookBindingRepairsDrift(plan)) return false;
      if (provisionsAgent && finding.id.startsWith("hermes.")) return false;
      return true;
    });
    if (blocking.length) {
      return {
        failure: projectPreflightFailure(
          plan,
          blocking.map((finding) => `${finding.id}: ${finding.summary}`),
          audit,
        ),
      };
    }
  }

  if (createsScaffold || provisionsAgent) {
    const eligibility = preflightMcpLifecycle({
      pjanglerRoot,
      targetDir: plan.project.repo_path,
      commonProject: createsScaffold,
      hermes: provisionsAgent,
    });
    if (!eligibility.ok) {
      return {
        failure: projectPreflightFailure(plan, [`Lifecycle preflight failed: ${eligibility.error ?? "unknown eligibility failure"}`]),
      };
    }
    if (!eligibility.identity) {
      return {
        failure: projectPreflightFailure(plan, ["Lifecycle preflight failed: Copier attestation returned no executable identity"]),
      };
    }
    return { trustedCopier: eligibility.identity };
  }
  return {};
}

function auditSummary(report: ReturnType<typeof runAudit>) {
  const counts = report.rules.reduce<Record<string, number>>((acc, rule) => {
    acc[rule.status] = (acc[rule.status] ?? 0) + 1;
    return acc;
  }, {});
  const nextActions = report.rules
    .filter((rule) => (rule.status === "fail" || rule.status === "warn") && rule.fixable)
    .map((rule) => `pjangler_migrate_project ${rule.id}`);
  return { counts, nextActions };
}

function migrationSummary(report: ReturnType<typeof runMigration>) {
  const counts = report.results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  return { counts, changedFileCount: report.changedFiles.length };
}

function parityGuidance() {
  return {
    skill: "@33god-projects",
    guidance: "Use these tools before editing a project so the repo SOT, agent files, mise hooks, and Hermes role scaffold are current.",
    workflows: [
      "audit -> pjangler_audit_project",
      "migrate -> pjangler_migrate_project",
      "bootstrap -> pjangler_bootstrap_33god_project",
      "agent provisioning -> pjangler_deploy_hermes_agent",
    ],
  };
}

async function runRecipeWithCapture(recipeName: string, context: CommandContext): Promise<{ success: boolean; logs: string[]; errors: string[] }> {
  if (!recipeRegistry.get(recipeName)) {
    return {
      success: false,
      logs: [],
      errors: [`Unknown recipe: ${recipeName}. Available: ${getRecipeNames().join(", ")}`],
    };
  }
  try {
    // MCP owns stdout. Force every registry dispatch into capture/silent mode;
    // callers cannot weaken this by supplying a context value.
    const ctx = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, { ...context, quiet: true });
    const result = await recipeRegistry.initRecipe(recipeName, ctx, {});
    return { success: result.ok, logs: result.logs, errors: result.errors };
  } catch (err) {
    return { success: false, logs: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}

server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes, commands, parity rules, workflows, and @33god-projects tool guidance.",
    inputSchema: z.strictObject({}),
  },
  async () => {
    const payload = {
      recipes: Object.values(RECIPE_REGISTRY).filter((r) => !INTERACTIVE_RECIPE_IDS.has(r.name)).map((r) => ({
        name: r.name,
        description: r.description,
        commands: r.commands,
      })),
      dedicatedRecipes: [
        {
          name: "hermes-agent",
          description: "Non-interactive Hermes provisioning with explicit local and external-effect consent gates.",
          tool: "pjangler_deploy_hermes_agent",
        },
      ],
      commands: Object.values(COMMAND_REGISTRY).map((c) => ({
        name: c.name,
        description: c.description,
        group: c.group,
      })),
      parityRules: getParityRuleIds(),
      recommendedWorkflows: {
        unfamiliarRepo: ["pjangler_describe_project", "pjangler_audit_project"],
        existingProject: ["pjangler_describe_project", "pjangler_audit_project", "pjangler_migrate_project"],
        new33godProject: ["pjangler_project_init", "pjangler_bootstrap_33god_project", "pjangler_audit_project"],
        hermesAgentProvisioning: ["pjangler_deploy_hermes_agent", "pjangler_audit_project"],
      },
      skillSynergy: parityGuidance(),
    };

    return asText(payload);
  }
);

server.registerTool(
  "pjangler_list_parity_rules",
  {
    title: "List pjangler parity rules",
    description: "Returns parity rule ids plus brief @33god-projects guidance.",
    inputSchema: z.strictObject({}),
  },
  async () => asText({ parityRules: getParityRuleIds(), guidance: parityGuidance() })
);

server.registerTool(
  "pjangler_audit_project",
  {
    title: "Audit project parity",
    description: "Runs pjangler parity audit for a project and returns structured findings with summary counts and next actions.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      json: z.boolean().optional(),
    }),
  },
  async ({ targetDir, json }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runAudit(resolvedTarget);
      const payload = { ...report, summary: auditSummary(report), guidance: parityGuidance() };
      return asText(json === false ? formatAuditReport(report) : payload);
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_migrate_project",
  {
    title: "Migrate project parity",
    description: "Runs one pjangler parity migration rule, or all rules, against a project.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      ruleId: z.string().optional(),
      all: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      acceptRegistryMatches: z.boolean().optional(),
    }),
  },
  async ({ targetDir, ruleId, all, dryRun, acceptRegistryMatches }) => {
    try {
      const runAll = all ?? false;
      if (!runAll && !ruleId) throw new Error("Either ruleId or all=true is required");
      if (runAll && ruleId) throw new Error("Pass either ruleId or all=true, not both");
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runMigration(ruleId, resolvedTarget, dryRun ?? true, runAll, acceptRegistryMatches ?? false);
      return {
        isError: !report.ok,
        ...asText({
          ok: report.ok,
          repo: report.repo,
          dryRun: report.dryRun,
          selectedRules: report.selectedRules,
          changedFiles: report.changedFiles,
          results: report.results,
          summary: migrationSummary(report),
        }),
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_bootstrap_33god_project",
  {
    title: "Bootstrap a new @33god project",
    description: "Create a new CommonProject-based 33god repo with optional non-interactive Hermes provisioning. Preview is the default; each external effect requires live=true plus an explicit positive opt-in.",
    inputSchema: z.strictObject({
      parentDir: z.string().optional(),
      targetDir: z.string().optional(),
      projectName: z.string(),
      projectDescription: z.string().optional(),
      projectSlug: PROJECT_SLUG_SCHEMA.optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      boardId: z.string().optional(),
      boardUrl: BOARD_URL_COMPAT_SCHEMA,
      workspace: z.string().optional(),
      planeWorkspace: z.string().optional(),
      planeProjectId: z.string().optional(),
      projectIdentifier: z.string().optional(),
      primaryLanguage: z.string().optional(),
      skipPlane: z.boolean().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: AGENT_ROLE_SCHEMA.optional(),
      agentPurpose: z.string().optional(),
      local: z.boolean().optional(),
      provisionRuntimeRepo: RUNTIME_REPO_COMPAT_SCHEMA,
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true, local=false, and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to systemd installation/enablement; also requires live=true and local=false."),
      force: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      registryPath: z.string().optional(),
      sourceSkill: z.string().optional(),
      live: z.boolean().optional(),
    }),
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(
        { ...input, skipPlane: input.skipPlane ?? true },
        { requireNonLocal: true },
      );
      const pjanglerRoot = resolvePjanglerRoot();
      const projectSlug = validateSafePathSegment(input.projectSlug ?? slugify(input.projectName), "Project slug");
      const explicitTargetDir = input.targetDir ? resolve(input.targetDir) : undefined;
      const parentDir = resolve(input.parentDir ?? (explicitTargetDir ? dirname(explicitTargetDir) : process.cwd()));
      if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) throw new Error(`Parent directory does not exist: ${parentDir}`);
      const targetDir = resolveContainedPath(
        parentDir,
        explicitTargetDir ?? join(parentDir, projectSlug),
        "Bootstrap target",
      );
      const overwrite = input.overwrite ?? input.force ?? false;
      const dryRun = input.dryRun ?? true;
      const local = input.local ?? true;
      const skipPlane = input.skipPlane ?? true;
      const ticketProvider = input.ticketProvider ?? "plane";
      const boardId = input.boardId ?? input.planeProjectId ?? "";
      if (externalEffects.ticketBoard && ticketProvider === "plane" && !boardId) {
        throw new Error("boardId or planeProjectId is required when skipPlane=false for Plane; keep skipPlane=true for safe local bootstrap");
      }
      if (!dryRun && existsSync(targetDir) && !overwrite) throw new Error(`Target already exists: ${targetDir} (set force/overwrite=true to re-render)`);

      const plan = planProjectInit({
        name: input.projectName,
        description: input.projectDescription,
        targetDir,
        projectSlug,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage ?? "python",
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole ?? "pm",
        apply: !dryRun,
        live: input.live ?? false,
        provisionTicketBoard: externalEffects.ticketBoard,
        enableSystemd: externalEffects.systemd,
        skipPlane,
        registryPath: input.registryPath,
        // A PROPOSAL only. The provider assigns the real identifier and
        // `pj project identity` reads it back; MCP never mints a board key.
        projectIdentifier: input.projectIdentifier ?? proposeProjectIdentifier(projectSlug),
        ticketProvider,
        boardId,
        boardUrl: input.boardUrl,
        boardWorkspace: input.workspace ?? input.planeWorkspace,
        planeWorkspace: input.planeWorkspace ?? "33god",
        planeProjectId: input.planeProjectId,
        pjanglerRoot,
        overwrite,
      });

      if (dryRun) {
        return asText(publicCompositeProjectResponse({ ...publicProjectPlan(plan), guidance: parityGuidance() }, plan));
      }

      const preflight = preflightProjectApply(plan, pjanglerRoot);
      if (preflight.failure) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...preflight.failure, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
            plan,
          )),
        };
      }

      const plannedAgent = plan.actions.find((action) => action.kind === "hermes.provision-agent");
      const result = await executeRegisteredProjectPlan(plan, input.provisionAgent ? {
        targetRepo: projectSlug,
        role: input.agentRole ?? "pm",
        agentPurpose: input.agentPurpose ?? `Project manager for ${input.projectName}`,
        local: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.local : local,
        force: overwrite,
        skipTelegram: true,
        skipEmail: true,
        skipPlane: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.context.skipPlane : true,
        skipBloodbank: true,
        skipSystemd: plannedAgent?.kind === "hermes.provision-agent" ? plannedAgent.context.skipSystemd : true,
      } : undefined, {
        force: overwrite,
        live: input.live ?? false,
        quiet: true,
      }, preflight.trustedCopier);
      if (!result.ok) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
            plan,
          )),
        };
      }

      const agentResult = input.provisionAgent
        ? {
            success: Boolean(result.agentResult?.ok),
            logs: result.agentResult?.logs ?? [],
            errors: result.agentResult?.errors ?? (result.ok ? [] : result.errors),
          }
        : undefined;
      return asText(publicCompositeProjectResponse(
        { ...result, agentResult, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
        plan,
      ));
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_project_init",
  {
    title: "Initialize a pjangler project",
    description: "Plan or apply a registry-backed CommonProject project init. Preview is the default; writes require apply=true and each external effect requires live=true plus an explicit positive opt-in.",
    inputSchema: z.strictObject({
      name: z.string(),
      description: z.string().optional(),
      targetDir: z.string().optional(),
      sourceSkill: z.string().optional(),
      primaryLanguage: z.string().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: AGENT_ROLE_SCHEMA.optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      provisionRuntimeRepo: RUNTIME_REPO_COMPAT_SCHEMA,
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to Hermes systemd installation/enablement; also requires live=true."),
      skipPlane: z.boolean().optional().describe("Disable project-board planning and provider invocation even when live=true."),
      slug: PROJECT_SLUG_SCHEMA.optional(),
      identifier: z.string().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      boardId: z.string().optional(),
      boardUrl: BOARD_URL_COMPAT_SCHEMA,
      workspace: z.string().optional(),
      registryPath: z.string().optional(),
      force: z.boolean().optional(),
    }),
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(input, { requireNonLocal: false });
      const plan = planProjectInit({
        name: input.name,
        description: input.description,
        targetDir: input.targetDir,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage,
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole,
        apply: input.apply ?? false,
        live: input.live ?? false,
        provisionTicketBoard: externalEffects.ticketBoard,
        enableSystemd: externalEffects.systemd,
        skipPlane: input.skipPlane ?? false,
        projectSlug: input.slug,
        projectIdentifier: input.identifier,
        ticketProvider: input.ticketProvider,
        boardId: input.boardId,
        boardUrl: input.boardUrl,
        boardWorkspace: input.workspace,
        registryPath: input.registryPath,
        force: input.force ?? false,
        overwrite: input.force ?? false,
        scaffold: !(input.targetDir && existsSync(join(resolve(input.targetDir), ".git"))),
      });
      if (!input.apply) return asText(publicCompositeProjectResponse(publicProjectPlan(plan), plan));
      const preflight = preflightProjectApply(plan, resolvePjanglerRoot());
      if (preflight.failure) {
        return {
          isError: true,
          ...asText(publicCompositeProjectResponse(
            { ...preflight.failure, ...(plan.warnings ? { warnings: plan.warnings } : {}) },
            plan,
          )),
        };
      }
      const result = await executeRegisteredProjectPlan(plan, undefined, {
        force: input.force ?? false,
        live: input.live ?? false,
        quiet: true,
      }, preflight.trustedCopier);
      return {
        isError: !result.ok,
        ...asText(publicCompositeProjectResponse(
          { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}) },
          plan,
        )),
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_project_list",
  {
    title: "List pjangler registry projects",
    description: "Return projects from the pjangler central registry.",
    inputSchema: z.strictObject({
      registryPath: z.string().optional(),
    }),
  },
  async ({ registryPath }) => asText(loadProjectRegistry(registryPath ?? projectRegistryPath()))
);

server.registerTool(
  "pjangler_project_show",
  {
    title: "Show a pjangler registry project",
    description: "Return one project by slug from the pjangler central registry.",
    inputSchema: z.strictObject({
      slug: PROJECT_SLUG_SCHEMA,
      registryPath: z.string().optional(),
    }),
  },
  async ({ slug, registryPath }) => {
    try {
      return asText(getProject(loadProjectRegistry(registryPath ?? projectRegistryPath()), slug));
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_describe_project",
  {
    title: "Describe a project",
    description:
      "Reads a repo and returns its detected type, installed pjangler subsystems, config files present, parity counts, and suggested next steps. The orientation call for an agent landing in an unfamiliar repo.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      registryPath: z.string().optional(),
      json: z.boolean().optional(),
    }),
  },
  async ({ targetDir, registryPath, json }) => {
    try {
      const description = describeProject({
        repoArg: resolveTargetDir(targetDir),
        registryPath: registryPath ?? projectRegistryPath(),
      });
      return asText(json === false ? formatProjectDescription(description) : description);
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_describe_recipe",
  {
    title: "Describe recipe",
    description: "Returns metadata for a specific pjangler recipe.",
    inputSchema: z.strictObject({
      recipe: z.string(),
    }),
  },
  async ({ recipe }) => {
    const info = getRecipeInfo(recipe);
    if (!info) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Recipe not found: ${recipe}` }],
      };
    }

    return asText({
      name: info.name,
      description: info.description,
      commands: info.commands,
    });
  }
);

server.registerTool(
  "pjangler_run_recipe",
  {
    title: "Run recipe",
    description: "Preview or apply a non-interactive pjangler recipe against an explicit target directory. Preview is the default; writes require apply=true.",
    inputSchema: z.strictObject({
      recipe: z.enum(GENERIC_RECIPE_NAMES as [string, ...string[]]),
      targetDir: EXPLICIT_TARGET_DIR_SCHEMA,
      force: z.boolean().optional(),
      apply: z.boolean().optional(),
    }),
  },
  async ({ recipe, targetDir, force, apply }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const shouldApply = apply === true;
      const context: CommandContext = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: !shouldApply,
        quiet: true,
      };

      const result = await runRecipeWithCapture(recipe, context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe,
          targetDir: resolvedTarget,
          apply: shouldApply,
          dryRun: !shouldApply,
          logs: result.logs,
          errors: result.errors,
        }),
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

server.registerTool(
  "pjangler_deploy_hermes_agent",
  {
    title: "Deploy Hermes agent",
    description:
      "Preview or apply a non-interactive Hermes agent deployment. Local writes require apply=true. External effects additionally require live=true, local=false, and an explicit positive opt-in for each effect. Bloodbank routing is always fleet-shared.",
    inputSchema: z.strictObject({
      targetDir: EXPLICIT_TARGET_DIR_SCHEMA,
      targetRepo: TARGET_REPO_SCHEMA.optional(),
      role: AGENT_ROLE_SCHEMA,
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      modelBaseUrl: z.string().optional(),
      modelApiMode: z.enum(["", "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse", "codex_app_server"]).optional(),
      modelKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      local: z.boolean().optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      provisionRuntimeRepo: RUNTIME_REPO_COMPAT_SCHEMA,
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; requires live=true, local=false, and skipPlane!=true."),
      enableSystemd: z.boolean().optional().describe("Explicitly opt in to systemd installation/enablement; requires live=true, local=false, and skipSystemd!=true."),
      force: z.boolean().optional(),
      skipRuntimeRepo: RUNTIME_REPO_COMPAT_SCHEMA,
      skipPlane: z.boolean().optional(),
      skipSystemd: z.boolean().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
    }),
  },
  async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(input, { requireNonLocal: true });
      const resolvedTarget = resolveTargetDir(input.targetDir);
      const local = input.local ?? true;
      const apply = input.apply === true;
      const live = input.live === true;
      let trustedCopier: TrustedCopierIdentity | undefined;

      if (apply) {
        const hermesBlocker = preflightExistingHermesScaffold(resolvedTarget);
        if (hermesBlocker) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: [`Lifecycle preflight failed: ${hermesBlocker}`],
            }),
          };
        }
        const eligibility = preflightMcpLifecycle({
          pjanglerRoot: resolvePjanglerRoot(),
          targetDir: resolvedTarget,
          commonProject: false,
          hermes: true,
        });
        if (!eligibility.ok) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: [`Lifecycle preflight failed: ${eligibility.error ?? "unknown eligibility failure"}`],
            }),
          };
        }
        if (!eligibility.identity) {
          return {
            isError: true,
            ...asText({
              success: false,
              recipe: "hermes-agent",
              targetDir: resolvedTarget,
              apply,
              live,
              logs: [],
              errors: ["Lifecycle preflight failed: Copier attestation returned no executable identity"],
            }),
          };
        }
        trustedCopier = eligibility.identity;
      }

      const context: HermesAgentContext = {
        targetDir: resolvedTarget,
        yes: true,
        quiet: true,
        local,
        live,
        targetRepo: input.targetRepo ?? basename(resolvedTarget),
        role: normalizeAgentRole(input.role),
        agentPurpose: input.agentPurpose,
        soulTone: input.soulTone,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        modelBaseUrl: input.modelBaseUrl,
        modelApiMode: input.modelApiMode,
        modelKeyEnv: input.modelKeyEnv,
        ticketProvider: input.ticketProvider as TicketProvider | undefined,
        force: input.force ?? false,
        dryRun: !apply,
        // MCP has no prompt-capable Telegram/email inputs. These steps remain
        // unreachable and therefore cannot consume JSON-RPC stdin.
        skipTelegram: true,
        skipEmail: true,
        skipPlane: !externalEffects.ticketBoard,
        skipBloodbank: true,
        skipSystemd: !externalEffects.systemd || process.platform === "darwin",
        trustedCopier,
        deferredExternalEffects: {
          ticketBoard: externalEffects.ticketBoard,
          systemd: externalEffects.systemd,
          owner: "hermes",
        },
      };

      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe: "hermes-agent",
          targetDir: resolvedTarget,
          apply,
          live,
          bloodbankMode: "fleet-shared",
          runtimeMode: "role-local-ignored",
          guidance: parityGuidance(),
          context: {
            targetRepo: context.targetRepo,
            role: context.role,
            local: context.local,
            dryRun: context.dryRun,
            quiet: context.quiet,
            force: context.force,
            skipPlane: context.skipPlane,
            skipSystemd: context.skipSystemd,
          },
          logs: result.logs,
          errors: result.errors,
        }),
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
