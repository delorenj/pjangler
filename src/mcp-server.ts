#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecipeInfo, getRecipeNames, COMMAND_REGISTRY, RECIPE_REGISTRY } from "./utils/registry";
import type { CommandContext } from "./commands/Command";
import { PJANGLER_VERSION } from "./utils/version";
import { lifecycleContext, recipeRegistry, formatAuditReport, getParityRuleIds, runAudit, runMigration } from "./parity/index";
import { readProjectInfo } from "./project/info";
import { describeProject, formatProjectDescription } from "./describe/index";
import {
  getProject,
  loadProjectRegistry,
  normalizeAgentRole,
  planProjectInit,
  PROJECT_TYPES,
  projectRegistryPath,
  proposeProjectIdentifier,
  resolveContainedPath,
  type ProjectManifest,
  validateSafePathSegment,
} from "./project/index";
import type { ProjectRecipeInput, ProjectRecipeResult } from "./recipes/ProjectRecipe";
import type { LifecycleContext } from "./recipes/types";
import { preflightMcpLifecycle, type TrustedCopierIdentity } from "./lifecycle/preflight";
import { createOperation, withOperation, assertOperationActive, OperationStopped, currentOperation } from "./lifecycle/operation";
import { BoundedCapture, boundedPayload, MCP_CAPTURE_BYTES, MCP_OUTPUT_BYTES, MCP_PAGE_SIZE, MCP_MAX_PAGE_SIZE, paginate } from "./mcp-bounds";

const server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION,
});

const TICKET_PROVIDER_SCHEMA = z.enum(["plane", "trello"]);
const PROJECT_TYPE_SCHEMA = z.enum(PROJECT_TYPES)
  .describe("What CommonProject renders: base (default) or obsidian-plugin. Fixed at creation; omit it to keep the recorded type.");
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
const TARGET_REPO_SCHEMA = safePathSegmentSchema("Target repository")
  .describe("A safe repository/profile identity segment; defaults to the target directory basename.");
const EXPLICIT_TARGET_DIR_SCHEMA = z.string().refine((value) => value.trim().length > 0, {
  message: "targetDir must be a non-empty explicit path",
});

// Every registered recipe is dispatchable. The exclusion set existed for exactly
// one entry -- `hermes-agent`, which prompted and therefore could not be driven
// generically. Hiring moved to Flume; nothing left here is interactive.
const GENERIC_RECIPE_NAMES = getRecipeNames();
if (GENERIC_RECIPE_NAMES.length === 0) throw new Error("No non-interactive recipes are registered for generic MCP execution");

interface ExternalEffectConsentInput {
  live?: boolean;
  local?: boolean;
  /** Deprecated no-op compatibility fields; neither grants nor subtracts authority. */
  skipRuntimeRepo?: boolean;
  provisionTicketBoard?: boolean;
  skipPlane?: boolean;
  skipSystemd?: boolean;
}

interface ExternalEffectSelection {
  ticketBoard: boolean;
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
  // The board is the only external effect pjangler still has. systemd units
  // are installed by Flume, so `enableSystemd` is gone rather than accepted and
  // ignored -- an input that silently does nothing is worse than no input.
  const selected: ExternalEffectSelection = {
    ticketBoard: input.provisionTicketBoard === true,
  };
  if (selected.ticketBoard && input.live !== true) {
    throw new Error("Creating a ticket board requires live=true in addition to the explicit positive opt-in");
  }
  if (selected.ticketBoard && options.requireNonLocal && input.local !== false) {
    throw new Error("Creating a ticket board requires local=false in addition to live=true and the explicit positive opt-in");
  }
  if (selected.ticketBoard && input.skipPlane === true) {
    throw new Error("provisionTicketBoard=true contradicts skipPlane=true");
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

// Stable keys are contracted at each nested boundary. Preserve additional
// fields on evolving registry/plan/report objects without accepting empty
// placeholders for the objects a client must actually interpret.
const RULES = z.array(z.string());
const GUIDANCE = z.object({ skill: z.string(), guidance: z.string(), workflows: RULES }).passthrough();
const RECIPE_META = z.object({ name: z.string(), description: z.string(), commands: RULES }).passthrough();
const COMMAND_META = z.object({ name: z.string(), description: z.string(), group: z.string() }).passthrough();
const TICKET = z.object({ type: z.string() }).passthrough();
const AGENT = z.object({ role: z.string(), provisioning_state: z.string().optional(), role_dir: z.string().optional() }).passthrough();
const MANIFEST = z.object({
  project_name: z.string(), project_description: z.string(), project_id: z.string(),
  repo_path: z.string(), ticket_provider: TICKET.extend({ workspace: z.string(), identifier: z.string(), board_id: z.string() }),
  agents: z.record(z.string(), AGENT),
}).passthrough();
const PROJECT = z.object({
  name: z.string(), slug: z.string(), repo_path: z.string(), description: z.string(),
  status: z.string(), source_artifacts: z.array(z.object({ kind: z.string(), path: z.string() }).passthrough()),
  template: z.object({ commonproject: z.object({ enabled: z.boolean(), primary_language: z.string() }).passthrough() }).passthrough(),
  ticket_provider: TICKET, agents: z.record(z.string(), AGENT.extend({ provisioning_state: z.string() })),
  created_at: z.string(), updated_at: z.string(),
}).passthrough();
const PROJECT_ACTION = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registry.upsert"), registryPath: z.string(), slug: z.string(), project: PROJECT }).passthrough(),
  z.object({ kind: z.literal("copier.copy.commonproject"), cwd: z.string(), command: RULES, targetDir: z.string(), data: z.record(z.string(), z.string()), overwrite: z.boolean() }).passthrough(),
  z.object({ kind: z.literal("project.write-manifest"), path: z.string(), manifest: MANIFEST }).passthrough(),
  z.object({ kind: z.literal("ticket-provider.create-or-link"), enabled: z.boolean(), live: z.boolean(), provider: z.string(), workspace: z.string(), identifier: z.string(), repoPath: z.string(), boardName: z.string(), description: z.string(), boardId: z.string(), state: z.string() }).passthrough(),
]);
const PLAN = z.object({
  ok: z.literal(true), apply: z.boolean(), dryRun: z.boolean(), live: z.boolean(),
  registryPath: z.string(), project: PROJECT, manifest: MANIFEST, actions: z.array(PROJECT_ACTION),
  warnings: RULES.optional(),
}).passthrough();
const FINDING = z.object({
  id: z.string(), title: z.string(), status: z.enum(["pass", "fail", "warn", "skip"]),
  summary: z.string(), details: RULES, fixable: z.boolean(),
}).passthrough();
const AUDIT_REPORT = z.object({
  repo: z.string(), ok: z.boolean(), auditedAt: z.string(), rules: z.array(FINDING),
}).passthrough();
const MIGRATION_RESULT = z.object({
  id: z.string(), title: z.string(), status: z.enum(["applied", "noop", "blocked", "skipped", "partial"]),
  summary: z.string(), changedFiles: RULES, details: RULES,
}).passthrough();
const MIGRATION_REPORT = z.object({
  repo: z.string(), ok: z.boolean(), dryRun: z.boolean(), selectedRules: RULES,
  changedFiles: RULES, results: z.array(MIGRATION_RESULT),
}).passthrough();
const PHASE = z.object({
  id: z.string(), status: z.enum(["changed", "unchanged", "planned", "skipped", "failed", "cancelled"]),
  changedFiles: RULES, message: z.string().optional(),
}).passthrough();
const CAPABILITIES_OUTPUT = z.object({
  recipes: z.array(RECIPE_META), commands: z.array(COMMAND_META), parityRules: RULES,
  recommendedWorkflows: z.object({ unfamiliarRepo: RULES, existingProject: RULES, new33godProject: RULES }).passthrough(),
  skillSynergy: GUIDANCE,
}).passthrough();
const PARITY_RULES_OUTPUT = z.object({ parityRules: RULES, guidance: GUIDANCE }).passthrough();
const PAGE_META = z.object({ limit: z.number().int(), truncated: z.boolean(), omittedCount: z.number().int(), nextCursor: z.string().optional() });
const PAGE_INPUT = {
  limit: z.number().int().positive().max(MCP_MAX_PAGE_SIZE).optional().describe(`Page size (default ${MCP_PAGE_SIZE}, maximum ${MCP_MAX_PAGE_SIZE}).`),
  cursor: z.string().min(1).optional().describe("Opaque continuation from nextCursor; invalid or stale cursors are errors."),
};
const AUDIT_OUTPUT = AUDIT_REPORT.extend({
  summary: z.object({ counts: z.record(z.string(), z.number()), nextActions: RULES }), guidance: GUIDANCE,
  page: PAGE_META,
}).passthrough();
const MIGRATION_OUTPUT = MIGRATION_REPORT.extend({
  summary: z.object({ counts: z.record(z.string(), z.number()), changedFileCount: z.number() }),
}).passthrough();
// MCP requires an object at the schema root. Its JSON Schema oneOf still
// discriminates the two outcome shapes (the SDK drops a root Zod union).
const PROJECT_PREVIEW = PLAN.extend({ dryRun: z.literal(true), guidance: GUIDANCE.optional() }).passthrough();
const PROJECT_EXECUTION = z.object({
  ok: z.boolean(), dryRun: z.literal(false), recipeId: z.string(),
  mode: z.enum(["create", "sync"]), plan: PLAN,
  changedFiles: RULES, logs: RULES, errors: RULES, phases: z.array(PHASE),
  warnings: RULES, selectedOperations: RULES, selectedParityRules: RULES,
  audit: AUDIT_REPORT.optional(), migrationReport: MIGRATION_REPORT.optional(),
  guidance: GUIDANCE.optional(),
}).passthrough();
const PROJECT_LIFECYCLE_OUTPUT = z.object({ ok: z.boolean(), dryRun: z.boolean() })
  .passthrough()
  .meta({ oneOf: [z.toJSONSchema(PROJECT_PREVIEW), z.toJSONSchema(PROJECT_EXECUTION)] });
const INFO_OUTPUT = z.object({
  ok: z.literal(true), project_id: z.string(), repo_path: z.string(),
  manifest_path: z.string(),
  // Info reads an arbitrary existing manifest (not necessarily a normalized
  // registry record); only its resolved identity is guaranteed.
  manifest: z.object({ project_id: z.string() }).passthrough(),
  registry: z.object({ location: z.string(), status: z.enum(["indexed", "not-indexed", "unavailable", "stale"]), message: z.string().optional() }).passthrough(),
}).passthrough();
const PROJECT_LIST_OUTPUT = z.object({ schema_version: z.number(), slugs: RULES, projects: z.record(z.string(), PROJECT), page: PAGE_META }).passthrough();
const PROJECT_SHOW_OUTPUT = PROJECT;
const CAPTURE_ADMISSION = z.object({
  unresolved_count: z.number().nullable(), unresolved_count_lower_bound: z.number(),
  unresolved_bytes: z.number().nullable(), unresolved_bytes_lower_bound: z.number(),
  unmeasurable_entry_count: z.number(),
  integrity_entries: z.array(z.object({ entry_id: z.string(), reason: z.string() }).passthrough()),
  receipt_caps: z.object({ max_count: z.number(), max_bytes: z.number() }).passthrough(),
  receiptless_session_count: z.number(), stale_receiptless_session_count: z.number(),
  active_refusals: z.array(z.object({
    session_key: z.string(), refused_at: z.string(), reason: z.enum(["count-cap", "byte-cap", "both"]),
    current_count: z.number(), current_bytes: z.number(), candidate_bytes: z.number(),
    max_count: z.number(), max_bytes: z.number(), next_actions: RULES,
    outcome: z.literal("capture-refused-history"),
  }).passthrough()),
}).passthrough();
const DESCRIBE_OUTPUT = z.object({
  repo: z.string(), describedAt: z.string(),
  git: z.object({
    isRepo: z.boolean(), branch: z.string().optional(), head: z.string().optional(),
    remote: z.string().optional(), dirtyFiles: z.number().optional(),
  }).passthrough(),
  activity: z.object({
    updated: z.string().nullable(), updatedUnix: z.number().nullable(),
    relative: z.string(), compact: z.string(), active: z.boolean(),
    source: z.object({ kind: z.enum(["ref", "worktree", "uncommitted"]), label: z.string(), unix: z.number() }).passthrough().nullable(),
    scanned: z.object({ refs: z.number(), worktrees: z.number(), dirtyFiles: z.number() }).passthrough(),
  }).passthrough(),
  type: z.object({ primaryLanguage: z.string().optional(), languages: RULES, roles: RULES, evidence: RULES }).passthrough(),
  identity: z.object({
    manifest: z.boolean(), registered: z.boolean(), registryPath: z.string(),
    slug: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
    ticketProvider: TICKET.extend({
      workspace: z.string().optional(), identifier: z.string().optional(), boardId: z.string().optional(), state: z.string().optional(),
    }).optional(),
    agents: z.array(z.object({ name: z.string(), role: z.string(), provisioningState: z.string(), roleDir: z.string().optional() }).passthrough()),
    drift: z.array(z.object({ note: z.string(), command: z.string().optional() }).passthrough()),
  }).passthrough(),
  notebook: z.object({
    declared: z.boolean(), bindingState: z.enum(["disabled", "planned", "linked"]).nullable(),
    notebookId: z.string().nullable(), overviewNoteId: z.string().nullable(),
    health: z.null(), remoteCheck: z.literal("skip"), captureAdmission: CAPTURE_ADMISSION.nullable(),
  }).passthrough(),
  subsystems: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
    status: z.enum(["installed", "drifted", "absent"]), parity: z.enum(["ok", "drift", "unchecked"]),
    evidence: RULES,
    rules: z.array(z.object({
      id: z.string(), title: z.string(), status: z.enum(["pass", "fail", "warn", "skip"]),
      summary: z.string(), fixable: z.boolean(),
    }).passthrough()),
  }).passthrough()),
  configFiles: z.array(z.object({ path: z.string(), purpose: z.string(), subsystem: z.string() }).passthrough()),
  nextSteps: z.array(z.object({
    title: z.string(), reason: z.string(), source: z.enum(["lifecycle", "registry", "parity", "agents"]),
    command: z.string().optional(), rules: RULES.optional(), details: RULES.optional(),
  }).passthrough()),
  parity: z.object({
    ok: z.boolean(), counts: z.object({ pass: z.number(), fail: z.number(), warn: z.number(), skip: z.number() }).passthrough(),
  }).passthrough(),
}).passthrough();
const RECIPE_INFO_OUTPUT = RECIPE_META;
const RECIPE_RUN_OUTPUT = z.object({
  success: z.boolean(), recipe: z.string(), targetDir: z.string(),
  apply: z.boolean(), dryRun: z.boolean(), logs: RULES, errors: RULES,
  capture: z.object({ logs: z.object({ retainedBytes: z.number(), omittedCount: z.number() }), errors: z.object({ retainedBytes: z.number(), omittedCount: z.number() }) }),
}).passthrough();

const LOCAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EXTERNAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const EXTERNAL_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const OPERATION_INPUT = {
  timeoutMs: z.number().int().min(1).max(600_000).optional()
    .describe("Whole-request deadline in milliseconds (default 120000, maximum 600000); nested work shares the original deadline."),
};

/** Keep stop mapping outside the handler's normal result envelope. */
function mutationHandler<T extends Record<string, unknown>>(
  handler: (input: T) => Promise<any>,
) {
  return async (input: T, extra: { signal: AbortSignal }): Promise<any> => {
    const operation = createOperation(extra.signal, typeof input.timeoutMs === "number" ? input.timeoutMs : undefined);
    try {
      return await withOperation(operation, async () => {
        assertOperationActive();
        const result = await handler(input);
        assertOperationActive();
        return result;
      });
    } catch (error) {
      return boundedError(error);
    } finally {
      operation.close();
    }
  };
}

function boundedError(err: unknown) {
  const stopped = currentOperation()?.stopReason();
  if (stopped || err instanceof OperationStopped) {
    const reason = stopped ?? (err as OperationStopped).reason;
    return { isError: true, content: [{ type: "text" as const, text: `MCP operation ${reason}${err instanceof Error && !(err instanceof OperationStopped) ? `: ${err.message}` : ""}` }] };
  }
  const message = err instanceof Error ? err.message : String(err);
  const marker = "… [truncated to MCP 256 KiB]";
  const capture = new BoundedCapture(MCP_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8"));
  capture.append(message);
  return { isError: true, content: [{ type: "text" as const, text: capture.omittedCount ? `${capture.entries.join("")}${marker}` : message }] };
}

function recipePayload(recipe: string, targetDir: string, apply: boolean, success: boolean, logs: BoundedCapture, errors: BoundedCapture) {
  return {
    success, recipe, targetDir, apply, dryRun: !apply,
    logs: logs.entries, errors: errors.entries,
    capture: {
      logs: { retainedBytes: logs.bytes, omittedCount: logs.omittedCount },
      errors: { retainedBytes: errors.bytes, omittedCount: errors.omittedCount },
    },
  };
}

function recipeCaptureBudget(recipe: string, targetDir: string, apply: boolean) {
  const empty = new BoundedCapture();
  const envelope = recipePayload(recipe, targetDir, apply, true, empty, empty);
  envelope.capture.logs.retainedBytes = MCP_CAPTURE_BYTES;
  envelope.capture.errors.retainedBytes = MCP_CAPTURE_BYTES;
  envelope.capture.logs.omittedCount = Number.MAX_SAFE_INTEGER;
  envelope.capture.errors.omittedCount = Number.MAX_SAFE_INTEGER;
  const baseline = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (baseline > MCP_OUTPUT_BYTES) throw new Error("MCP recipe metadata exceeds the 256 KiB structured output budget");
  // Each collector charges the serialized string and its array comma; the
  // baseline already includes the two empty arrays. Leave room for counters.
  return { serializedBytes: 0, maxSerializedBytes: MCP_OUTPUT_BYTES - baseline - 16 };
}

function asResult<T extends object>(payload: T, text?: string) {
  boundedPayload(payload);
  // Formatted text comes only from the admitted payload; JSON text uses its
  // bounded serialization, never the original dataset or uncaptured messages.
  let readable = text ?? JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(readable, "utf8") > MCP_OUTPUT_BYTES && text === undefined) readable = JSON.stringify(payload);
  if (Buffer.byteLength(readable, "utf8") > MCP_OUTPUT_BYTES) {
    throw new Error("MCP readable output exceeds the 256 KiB budget");
  }
  return {
    structuredContent: { ...payload } as Record<string, unknown>,
    content: [{ type: "text" as const, text: readable }],
  };
}

function publicProjectPlan(plan: ReturnType<typeof planProjectInit>) {
  return plan;
}

function publicCompositeProjectResponse<T extends object>(payload: T, plan: ReturnType<typeof planProjectInit>) {
  const hasNestedPlan = "plan" in payload;
  return {
    ...payload,
    ...(hasNestedPlan ? { plan: publicProjectPlan(plan) } : {}),
  };
}

async function executeRegisteredProjectPlan(
  plan: ReturnType<typeof planProjectInit>,
  lifecycleOverrides: Partial<LifecycleContext> = {},
  trustedCopier?: TrustedCopierIdentity,
) {
  const projectInput: ProjectRecipeInput = {
    plan,
    mode: plan.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync",
    selectedRuleIds: [],
    selectedOperations: plan.actions.map((action) => action.kind),
    trustedCopier,
    requireTrustedCopier: plan.actions.some((action) => action.kind === "copier.copy.commonproject"),
    quiet: true,
  };
  const operation = currentOperation();
  return await recipeRegistry.initRecipe(
    "project",
    lifecycleContext(plan.project.repo_path, false, false, {
      ...lifecycleOverrides,
      signal: operation?.signal,
      deadlineMs: operation?.deadlineMs,
      assertActive: assertOperationActive,
      force: lifecycleOverrides.force ?? plan.actions.some((action) => action.kind === "copier.copy.commonproject" && action.overwrite),
      live: lifecycleOverrides.live ?? plan.live,
      quiet: lifecycleOverrides.quiet ?? true,
    }),
    projectInput,
  ) as ProjectRecipeResult;
}

function projectPreflightFailure(
  plan: ReturnType<typeof planProjectInit>,
  errors: readonly string[],
  audit?: Awaited<ReturnType<typeof runAudit>>,
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
    warnings: [],
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

async function preflightProjectApply(
  plan: ReturnType<typeof planProjectInit>,
  pjanglerRoot: string,
): Promise<ProjectApplyPreflight> {
  const createsScaffold = plan.actions.some((action) => action.kind === "copier.copy.commonproject");

  if (!createsScaffold) {
    const audit = await runAudit(plan.project.repo_path);
    const blocking = audit.rules.filter((finding) => {
      if (finding.status === "pass" || finding.status === "skip") return false;
      if (finding.id === "sot.project-json") return false;
      if (finding.id === "notebook.binding" && plannedNotebookBindingRepairsDrift(plan)) return false;
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

  if (createsScaffold) {
    const eligibility = preflightMcpLifecycle({
      pjanglerRoot,
      targetDir: plan.project.repo_path,
      commonProject: createsScaffold,
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

function auditSummary(report: Awaited<ReturnType<typeof runAudit>>) {
  const counts = report.rules.reduce<Record<string, number>>((acc, rule) => {
    acc[rule.status] = (acc[rule.status] ?? 0) + 1;
    return acc;
  }, {});
  const nextActions = report.rules
    .filter((rule) => (rule.status === "fail" || rule.status === "warn") && rule.fixable)
    .map((rule) => `pjangler_migrate_project ${rule.id}`);
  return { counts, nextActions };
}

function migrationSummary(report: Awaited<ReturnType<typeof runMigration>>) {
  const counts = report.results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  return { counts, changedFileCount: report.changedFiles.length };
}

function parityGuidance() {
  return {
    skill: "@33god-projects",
    guidance: "Use these tools before editing a project so the repo SOT, agent files and mise hooks are current.",
    workflows: [
      "audit -> pjangler_audit_project",
      "migrate -> pjangler_migrate_project",
      "bootstrap -> pjangler_bootstrap_33god_project",
    ],
  };
}

async function runRecipeWithCapture(recipeName: string, context: CommandContext, shared: { serializedBytes: number; maxSerializedBytes: number }) {
  const logs = new BoundedCapture(MCP_CAPTURE_BYTES, shared);
  const errors = new BoundedCapture(MCP_CAPTURE_BYTES, shared);
  if (!recipeRegistry.get(recipeName)) {
    errors.append(`Unknown recipe: ${recipeName}. Available: ${getRecipeNames().join(", ")}`);
    return { success: false, logs, errors };
  }
  try {
    const operation = currentOperation();
    const ctx = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, { ...context, signal: operation?.signal, deadlineMs: operation?.deadlineMs, assertActive: assertOperationActive, quiet: true, mcpCapture: { logs, errors } });
    const result = await recipeRegistry.initRecipe(recipeName, ctx, {});
    return { success: result.ok, logs, errors };
  } catch (err) {
    errors.append(err instanceof Error ? err.message : String(err));
    return { success: false, logs, errors };
  }
}

server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes, commands, parity rules, workflows, and @33god-projects tool guidance.",
    inputSchema: z.strictObject({}),
    outputSchema: CAPABILITIES_OUTPUT,
    annotations: LOCAL_READ,
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
      },
      skillSynergy: parityGuidance(),
    };

    return asResult(payload);
  }
);

server.registerTool(
  "pjangler_list_parity_rules",
  {
    title: "List pjangler parity rules",
    description: "Returns parity rule ids plus brief @33god-projects guidance.",
    inputSchema: z.strictObject({}),
    outputSchema: PARITY_RULES_OUTPUT,
    annotations: LOCAL_READ,
  },
  async () => asResult({ parityRules: getParityRuleIds(), guidance: parityGuidance() })
);

server.registerTool(
  "pjangler_audit_project",
  {
    title: "Audit project parity",
    description: "Runs parity audit; findings ordered by id (code-point order), with original index as stable tie-breaker. Default 100, maximum 500; page.omittedCount counts findings not yet returned, nextCursor resumes the first unreturned finding. Unchanged datasets traverse exactly once.",
    inputSchema: z.strictObject({
      targetDir: z.string().optional(),
      json: z.boolean().optional(),
      ...PAGE_INPUT,
    }),
    outputSchema: AUDIT_OUTPUT,
    annotations: EXTERNAL_READ,
  },
  async ({ targetDir, json, limit, cursor }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = await runAudit(resolvedTarget);
      const sorted = report.rules.map((rule, index) => ({ rule, index }))
        .sort((a, b) => a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : a.index - b.index);
      const result = paginate(sorted, ({ rule }) => JSON.stringify(rule), limit, cursor, (items, page) => {
        const partial = { ...report, rules: items.map(({ rule }) => rule) };
        return { ...partial, summary: auditSummary(partial), guidance: parityGuidance(), page };
      }, json === false ? (payload) => formatAuditReport(payload as Awaited<ReturnType<typeof runAudit>>) : (payload) => JSON.stringify(payload, null, 2));
      const payload = result.payload as Awaited<ReturnType<typeof runAudit>> & { page: typeof result.meta; summary: ReturnType<typeof auditSummary>; guidance: ReturnType<typeof parityGuidance> };
      return asResult(payload, json === false ? formatAuditReport({ ...report, rules: payload.rules }) : JSON.stringify(payload, null, 2));
    } catch (err) {
      return boundedError(err);
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
      ...OPERATION_INPUT,
    }),
    outputSchema: MIGRATION_OUTPUT,
    annotations: EXTERNAL_WRITE,
  },
  mutationHandler(async ({ targetDir, ruleId, all, dryRun, acceptRegistryMatches }) => {
    try {
      const runAll = all ?? false;
      if (!runAll && !ruleId) throw new Error("Either ruleId or all=true is required");
      if (runAll && ruleId) throw new Error("Pass either ruleId or all=true, not both");
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = await runMigration(ruleId, resolvedTarget, dryRun ?? true, runAll, acceptRegistryMatches ?? false);
      return {
        isError: !report.ok,
        ...asResult({
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
      return boundedError(err);
    }
  })
);

server.registerTool(
  "pjangler_bootstrap_33god_project",
  {
    title: "Bootstrap a new @33god project",
    description: "Create a new CommonProject-based 33god repo. Preview is the default; the ticket board requires live=true plus an explicit positive opt-in. Hiring an agent for it is `flume hire`.",
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
      projectType: PROJECT_TYPE_SCHEMA.optional(),
      skipPlane: z.boolean().optional(),
      agentPurpose: z.string().optional(),
      local: z.boolean().optional(),
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true, local=false, and skipPlane!=true."),
      force: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      registryPath: z.string().optional(),
      sourceSkill: z.string().optional(),
      live: z.boolean().optional(),
      ...OPERATION_INPUT,
    }),
    outputSchema: PROJECT_LIFECYCLE_OUTPUT,
    annotations: EXTERNAL_WRITE,
  },
  mutationHandler(async (input) => {
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
        primaryLanguage: input.primaryLanguage,
        projectType: input.projectType,
        apply: !dryRun,
        live: input.live ?? false,
        provisionTicketBoard: externalEffects.ticketBoard,
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
        return asResult(publicCompositeProjectResponse({ ...publicProjectPlan(plan), guidance: parityGuidance() }, plan));
      }

      const preflight = await preflightProjectApply(plan, pjanglerRoot);
      if (preflight.failure) {
        return {
          isError: true,
          ...asResult(publicCompositeProjectResponse(
            { ...preflight.failure, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
            plan,
          )),
        };
      }

      const result = await executeRegisteredProjectPlan(plan, {
        force: overwrite,
        live: input.live ?? false,
        quiet: true,
      }, preflight.trustedCopier);
      if (!result.ok) {
        return {
          isError: true,
          ...asResult(publicCompositeProjectResponse(
            { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
            plan,
          )),
        };
      }

      return asResult(publicCompositeProjectResponse(
        { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}), guidance: parityGuidance() },
        plan,
      ));
    } catch (err) {
      return boundedError(err);
    }
  })
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
      projectType: PROJECT_TYPE_SCHEMA.optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      provisionTicketBoard: z.boolean().optional().describe("Explicitly opt in to ticket-board provisioning; also requires live=true and skipPlane!=true."),
      skipPlane: z.boolean().optional().describe("Disable project-board planning and provider invocation even when live=true."),
      slug: PROJECT_SLUG_SCHEMA.optional(),
      identifier: z.string().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      boardId: z.string().optional(),
      boardUrl: BOARD_URL_COMPAT_SCHEMA,
      workspace: z.string().optional(),
      registryPath: z.string().optional(),
      force: z.boolean().optional(),
      ...OPERATION_INPUT,
    }),
    outputSchema: PROJECT_LIFECYCLE_OUTPUT,
    annotations: EXTERNAL_WRITE,
  },
  mutationHandler(async (input) => {
    try {
      const externalEffects = validateExternalEffectConsent(input, { requireNonLocal: false });
      const plan = planProjectInit({
        name: input.name,
        description: input.description,
        targetDir: input.targetDir,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage,
        projectType: input.projectType,
        apply: input.apply ?? false,
        live: input.live ?? false,
        provisionTicketBoard: externalEffects.ticketBoard,
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
      if (!input.apply) return asResult(publicCompositeProjectResponse(publicProjectPlan(plan), plan));
      const preflight = await preflightProjectApply(plan, resolvePjanglerRoot());
      if (preflight.failure) {
        return {
          isError: true,
          ...asResult(publicCompositeProjectResponse(
            { ...preflight.failure, ...(plan.warnings ? { warnings: plan.warnings } : {}) },
            plan,
          )),
        };
      }
      const result = await executeRegisteredProjectPlan(plan, {
        force: input.force ?? false,
        live: input.live ?? false,
        quiet: true,
      }, preflight.trustedCopier);
      return {
        isError: !result.ok,
        ...asResult(publicCompositeProjectResponse(
          { ...result, ...(plan.warnings ? { warnings: plan.warnings } : {}) },
          plan,
        )),
      };
    } catch (err) {
      return boundedError(err);
    }
  })
);

server.registerTool(
  "pjangler_info",
  {
    title: "Project information",
    description: "Read the current repository manifest or look up a case-insensitive project_id in the PostgreSQL index.",
    inputSchema: z.strictObject({ project_id: z.string().optional(), targetDir: z.string().optional(), registryPath: z.string().optional() }),
    outputSchema: INFO_OUTPUT,
    annotations: EXTERNAL_READ,
  },
  async ({ project_id, targetDir, registryPath }) => {
    try { return asResult(readProjectInfo({ projectId: project_id, cwd: targetDir ?? process.cwd(), registryPath })); }
    catch (err) { return boundedError(err); }
  }
);

server.registerTool(
  "pjangler_project_list",
  {
    title: "List pjangler registry projects",
    description: "Return registry projects ordered by slug (code-point order), with original index as stable tie-breaker. Default 100, maximum 500; page.omittedCount counts records not yet returned, nextCursor resumes the first unreturned record. Unchanged datasets traverse exactly once.",
    inputSchema: z.strictObject({
      registryPath: z.string().optional(),
      ...PAGE_INPUT,
    }),
    outputSchema: PROJECT_LIST_OUTPUT,
    annotations: EXTERNAL_READ,
  },
  async ({ registryPath, limit, cursor }) => {
    try {
      const registry = loadProjectRegistry(registryPath ?? projectRegistryPath());
      const entries = Object.entries(registry.projects).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const result = paginate(entries, ([slug, record]) => JSON.stringify([slug, record]), limit, cursor,
        (items, page) => ({ schema_version: registry.schema_version, slugs: items.map(([slug]) => slug), projects: Object.fromEntries(items), page }),
        (payload) => JSON.stringify(payload, null, 2));
      return asResult(result.payload, JSON.stringify(result.payload, null, 2));
    } catch (err) {
      return boundedError(err);
    }
  }
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
    outputSchema: PROJECT_SHOW_OUTPUT,
    annotations: EXTERNAL_READ,
  },
  async ({ slug, registryPath }) => {
    try {
      return asResult(getProject(loadProjectRegistry(registryPath ?? projectRegistryPath()), slug));
    } catch (err) {
      return boundedError(err);
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
    outputSchema: DESCRIBE_OUTPUT,
    annotations: EXTERNAL_READ,
  },
  async ({ targetDir, registryPath, json }) => {
    try {
      const description = await describeProject({
        repoArg: resolveTargetDir(targetDir),
        registryPath: registryPath ?? projectRegistryPath(),
      });
      return asResult(description, json === false ? formatProjectDescription(description) : undefined);
    } catch (err) {
      return boundedError(err);
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
    outputSchema: RECIPE_INFO_OUTPUT,
    annotations: LOCAL_READ,
  },
  async ({ recipe }) => {
    const info = getRecipeInfo(recipe);
    if (!info) {
      return boundedError(new Error(`Recipe not found: ${recipe}`));
    }

    return asResult({
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
    description: `Preview or apply a non-interactive recipe. Logs and errors each retain at most ${MCP_CAPTURE_BYTES} UTF-8 bytes during collection; capture.omittedCount counts discarded message fragments. Complete structured output is capped at ${MCP_OUTPUT_BYTES} bytes. Preview is the default; writes require apply=true.`,
    inputSchema: z.strictObject({
      recipe: z.enum(GENERIC_RECIPE_NAMES as [string, ...string[]]),
      targetDir: EXPLICIT_TARGET_DIR_SCHEMA,
      force: z.boolean().optional(),
      apply: z.boolean().optional(),
      ...OPERATION_INPUT,
    }),
    outputSchema: RECIPE_RUN_OUTPUT,
    annotations: EXTERNAL_WRITE,
  },
  mutationHandler(async ({ recipe, targetDir, force, apply }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const shouldApply = apply === true;
      const context: CommandContext = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: !shouldApply,
        quiet: true,
      };

      const budget = recipeCaptureBudget(recipe, resolvedTarget, shouldApply);
      const result = await runRecipeWithCapture(recipe, context, budget);
      return {
        isError: !result.success,
        ...asResult(recipePayload(recipe, resolvedTarget, shouldApply, result.success, result.logs, result.errors)),
      };
    } catch (err) {
      return boundedError(err);
    }
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
