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
  resolveContainedPath,
  validateSafePathSegment,
} from "./project/index";
import type { ProjectRecipeInput, ProjectRecipeResult } from "./recipes/ProjectRecipe";
import type { LifecycleContext } from "./recipes/types";

const server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION,
});

const TICKET_PROVIDER_SCHEMA = z.enum(["plane", "trello"]);
const BOARD_URL_COMPAT_SCHEMA = z.string()
  .optional()
  .describe("Deprecated compatibility input. Ignored; board URLs are derived at runtime and are never persisted.")
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
          skipRuntimeRepo: action.context.skipRuntimeRepo,
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
    ...(provisionsAgent ? { bloodbankMode: "fleet-shared" as const } : {}),
  };
}

async function executeRegisteredProjectPlan(
  plan: ReturnType<typeof planProjectInit>,
  agentContext?: Partial<HermesAgentContext>,
  lifecycleOverrides: Partial<LifecycleContext> = {},
) {
  const projectInput: ProjectRecipeInput = {
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    selectedRuleIds: [],
    selectedOperations: plan.actions.map((action) => action.kind),
    agentContext,
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
    const ctx = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, context);
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
      recipes: Object.values(RECIPE_REGISTRY).map((r) => ({
        name: r.name,
        description: r.description,
        commands: r.commands,
      })),
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
      return asText({
        ok: report.ok,
        repo: report.repo,
        dryRun: report.dryRun,
        selectedRules: report.selectedRules,
        changedFiles: report.changedFiles,
        results: report.results,
        summary: migrationSummary(report),
      });
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.registerTool(
  "pjangler_bootstrap_33god_project",
  {
    title: "Bootstrap a new @33god project",
    description: "Create a new CommonProject-based 33god repo with optional local Hermes agent provisioning. Dry-run is safe and does not require copier.",
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
      if (!skipPlane && ticketProvider === "plane" && !boardId) {
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
        registryPath: input.registryPath,
        projectIdentifier: input.projectIdentifier ?? projectSlug.slice(0, 4).toUpperCase(),
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

      const result = await executeRegisteredProjectPlan(plan, input.provisionAgent ? {
        targetRepo: projectSlug,
        role: input.agentRole ?? "pm",
        agentPurpose: input.agentPurpose ?? `Project manager for ${input.projectName}`,
        local,
        force: overwrite,
        skipTelegram: true,
        skipEmail: true,
        skipRuntimeRepo: local,
        skipPlane: skipPlane || local,
        skipBloodbank: true,
        skipSystemd: local || process.platform === "darwin",
      } : undefined, {
        force: overwrite,
        live: input.live ?? false,
        quiet: true,
      });
      if (!result.ok) {
        return asText(publicCompositeProjectResponse(
          { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
          plan,
        ));
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
    description: "Plan or apply a registry-backed CommonProject project init. Dry-run is the default; writes require apply=true and live actions require live=true.",
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
      const result = await executeRegisteredProjectPlan(plan, undefined, {
        force: input.force ?? false,
        live: input.live ?? false,
        quiet: true,
      });
      return asText(publicCompositeProjectResponse(
        { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}) },
        plan,
      ));
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
    description: "Executes any pjangler recipe against a target directory.",
    inputSchema: z.strictObject({
      recipe: z.enum(getRecipeNames() as [string, ...string[]]),
      targetDir: z.string().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    }),
  },
  async ({ recipe, targetDir, force, dryRun }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const context: CommandContext = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: dryRun ?? false,
      };

      const result = await runRecipeWithCapture(recipe, context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe,
          targetDir: resolvedTarget,
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
      "Provision a Hermes agent role for @33god-projects. Bloodbank routing is always fleet-shared; local=true safely defaults runtime repo, ticket-board creation, and systemd off.",
    inputSchema: z.strictObject({
      targetDir: z.string(),
      targetRepo: z.string().optional(),
      role: AGENT_ROLE_SCHEMA,
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      modelBaseUrl: z.string().optional(),
      modelApiMode: z.enum(["", "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse", "codex_app_server"]).optional(),
      modelKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      local: z.boolean().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      skipTelegram: z.boolean().optional(),
      skipEmail: z.boolean().optional(),
      skipRuntimeRepo: z.boolean().optional(),
      skipPlane: z.boolean().optional(),
      skipSystemd: z.boolean().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
    }),
  },
  async (input) => {
    try {
      const resolvedTarget = resolveTargetDir(input.targetDir);
      const local = input.local ?? true;

      const context: HermesAgentContext = {
        targetDir: resolvedTarget,
        yes: true,
        local,
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
        dryRun: input.dryRun ?? false,
        skipTelegram: input.skipTelegram ?? true,
        skipEmail: input.skipEmail ?? true,
        skipRuntimeRepo: input.skipRuntimeRepo ?? local,
        skipPlane: input.skipPlane ?? local,
        skipBloodbank: true,
        skipSystemd: input.skipSystemd ?? (local || process.platform === "darwin"),
      };

      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe: "hermes-agent",
          targetDir: resolvedTarget,
          bloodbankMode: "fleet-shared",
          guidance: parityGuidance(),
          context: {
            targetRepo: context.targetRepo,
            role: context.role,
            local: context.local,
            dryRun: context.dryRun,
            force: context.force,
            skipTelegram: context.skipTelegram,
            skipEmail: context.skipEmail,
            skipRuntimeRepo: context.skipRuntimeRepo,
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
