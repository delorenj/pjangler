import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleAuditFinding, LifecycleContext, LifecycleMigrationResult, RecipeCheck } from "../recipes/types";
import { loadEffectiveNotebookConfig } from "./config";
import { canonicalJson } from "./notes";
import { normalizeNotebookError } from "./output";
import { captureAdmissionSummary, currentRetentionPressure, listCaptureReceipts, notebookStateRoot, pruneNotebookState } from "./state";
import type { NotebookObservationV1 } from "./observation";

export const NOTEBOOK_RULE_IDS = [
  "notebook.configuration",
  "notebook.binding",
  "notebook.remote-notebook",
  "notebook.overview-note",
  "notebook.skill-installed",
  "notebook.hooks-projected",
  "notebook.capture-receipts",
] as const;

function finding(id: string, title: string, status: LifecycleAuditFinding["status"], summary: string, details: string[] = [], fixable = false): LifecycleAuditFinding {
  return { id, title, status, summary, details, fixable };
}

function result(check: LifecycleAuditFinding, status: LifecycleMigrationResult["status"], summary: string, changedFiles: string[] = [], details: string[] = []): LifecycleMigrationResult {
  return { id: check.id, title: check.title, status, summary, changedFiles, details };
}

function manifestNotebook(repo: string): Record<string, unknown> | null {
  const path = join(repo, ".project.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const notebook = (parsed as Record<string, unknown>).notebook;
    return notebook && typeof notebook === "object" && !Array.isArray(notebook) ? notebook as Record<string, unknown> : null;
  } catch { return null; }
}

function enabled(ctx: LifecycleContext): boolean {
  if (ctx.notebookRegistryDeclared === false) return false;
  if (ctx.notebookPlan || manifestNotebook(ctx.repoRoot)) return true;
  try { return loadEffectiveNotebookConfig(ctx.repoRoot).binding.state !== "disabled"; }
  catch { return false; }
}

function registryDeclared(ctx: LifecycleContext): boolean {
  if (ctx.notebookRegistryDeclared !== undefined) return ctx.notebookRegistryDeclared;
  return enabled(ctx);
}

function resolvedConfig(ctx: LifecycleContext) {
  // PJAN-84: honour the run's registry. Falling back to projectRegistryPath()
  // here is what made `describe --registry` report notebook findings about the
  // DEFAULT registry while its identity block described the override.
  return ctx.notebookPlan?.config
    ?? (ctx.registryPath
      ? loadEffectiveNotebookConfig(ctx.repoRoot, ctx.registryPath)
      : loadEffectiveNotebookConfig(ctx.repoRoot));
}

function bindingProjection(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"] as const) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  return result;
}

function manifestBinding(repo: string): Record<string, unknown> | null {
  const notebook = manifestNotebook(repo);
  return notebook ? bindingProjection(notebook.binding) : null;
}

function observation(ctx: LifecycleContext): Readonly<NotebookObservationV1> | undefined {
  return ctx.notebookObservation;
}

class NotebookCheck implements RecipeCheck {
  constructor(
    readonly id: string,
    readonly title: string,
    private readonly auditFn: (ctx: LifecycleContext) => LifecycleAuditFinding,
    private readonly migrateFn?: (ctx: LifecycleContext, finding: LifecycleAuditFinding) => LifecycleMigrationResult,
  ) {}
  audit(ctx: LifecycleContext): LifecycleAuditFinding { return this.auditFn(ctx); }
  migrate(ctx: LifecycleContext, current: LifecycleAuditFinding): LifecycleMigrationResult {
    return this.migrateFn?.(ctx, current) ?? result(current, "blocked", `${this.id} requires an explicit owned migration path`);
  }
}

function configurationAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!registryDeclared(ctx)) {
    if (!ctx.notebookFocusedAudit) return finding(
      "notebook.configuration",
      "Notebook configuration",
      "skip",
      "Project Notebook is not declared; use the focused pj notebook audit surface to opt in",
    );
    return finding(
      "notebook.configuration",
      "Notebook configuration",
      "warn",
      "This registered repository has no authoritative Project Notebook declaration",
      [
        `Run pj notebook migrate ${ctx.repoRoot} --apply to create a planned Registry binding and Manifest policy`,
        "The declaration keeps SessionStart and SessionEnd capture disabled until explicitly enabled per project",
      ],
      true,
    );
  }
  if (!enabled(ctx)) return finding("notebook.configuration", "Notebook configuration", "skip", "Project Notebook is not declared for this repository");
  try {
    const config = resolvedConfig(ctx);
    if (!config.policy.enabled) return finding("notebook.configuration", "Notebook configuration", "skip", "Project Notebook is explicitly disabled");
    if (!config.base_url) return finding("notebook.configuration", "Notebook configuration", "pass", "Project Notebook policy is valid; remote work remains planned until an endpoint is configured", ["Set Registry notebook.base_url to HTTPS or loopback HTTP before remote work"], false);
    return finding("notebook.configuration", "Notebook configuration", "pass", "Notebook endpoint, auth name, policy, and finite limits are valid");
  } catch (error) {
    return finding("notebook.configuration", "Notebook configuration", "fail", normalizeNotebookError(error).message);
  }
}

function bindingAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.binding", "Notebook binding", "skip", "Project Notebook is not declared for this repository");
  const config = (() => { try { return resolvedConfig(ctx); } catch { return undefined; } })();
  if (!config) return finding("notebook.binding", "Notebook binding", "fail", "Notebook binding could not be resolved");
  if (config.binding.state === "disabled") return finding("notebook.binding", "Notebook binding", "skip", "Project Notebook binding is disabled");
  if (config.binding.state === "linked" && (!config.binding.notebook_id || !config.binding.overview_note_id)) {
    return finding("notebook.binding", "Notebook binding", "fail", "Linked binding is missing its notebook or Overview stable ID", [], true);
  }
  const projected = ctx.notebookManifestBinding !== undefined
    ? bindingProjection(ctx.notebookManifestBinding)
    : manifestBinding(ctx.repoRoot);
  const authoritative = bindingProjection(config.binding);
  if (!projected || canonicalJson(projected) !== canonicalJson(authoritative)) {
    return finding(
      "notebook.binding",
      "Notebook binding",
      "fail",
      "Manifest Notebook binding projection has drifted from the authoritative Project Registry binding",
      ["Run pj notebook migrate --apply to project Registry binding into .project.json"],
      true,
    );
  }
  return finding("notebook.binding", "Notebook binding", "pass", config.binding.state === "linked" ? "Registry binding has stable notebook and Overview IDs" : "Planned binding is valid recovery state");
}

function remoteAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.remote-notebook", "Remote notebook", "skip", "Project Notebook is not declared for this repository");
  const journals = (() => {
    try { return admission(ctx).unresolvedJournals.filter((item) => item.kind === "notebook.create"); }
    catch { return []; }
  })();
  if (journals.length) {
    return finding("notebook.remote-notebook", "Remote notebook", "warn", "Unresolved notebook-create journal requires marker reconciliation and durable Registry ownership", journalDetails(journals), true);
  }
  const observed = observation(ctx);
  if (!observed || observed.notebook_check.status === "skip") return finding("notebook.remote-notebook", "Remote notebook", "skip", "Remote notebook was not observed; no hidden network request was made");
  if (observed.notebook_check.status === "pass" && observed.notebook) return finding("notebook.remote-notebook", "Remote notebook", "pass", "Stable notebook ID, marker, name, and archive state were observed exactly");
  return finding(
    "notebook.remote-notebook",
    "Remote notebook",
    "fail",
    observed.error?.message ?? "Remote notebook is missing, ambiguous, unavailable, or metadata-drifted",
    observed.notebook_check.drift.map((item) => `${item.path}: ${item.reason}`),
    true,
  );
}

function overviewAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.overview-note", "Overview note", "skip", "Project Notebook is not declared for this repository");
  const config = (() => { try { return resolvedConfig(ctx); } catch { return undefined; } })();
  const logicalId = config ? `overview:v1:${config.project_slug}` : null;
  const journals = (() => {
    try { return admission(ctx).unresolvedJournals.filter((item) => item.kind === "note.create" && item.logical_marker === logicalId); }
    catch { return []; }
  })();
  if (journals.length) {
    return finding("notebook.overview-note", "Overview note", "warn", "Unresolved Overview-create journal requires stable-ID reconciliation and durable binding ownership", journalDetails(journals), true);
  }
  const observed = observation(ctx);
  if (!observed || observed.remote_check === "skip") return finding("notebook.overview-note", "Overview note", "skip", "Overview was not observed; no hidden network request was made");
  if (observed.overview?.present && observed.overview.member && observed.overview.envelope_owned && observed.overview.drift.length === 0) return finding("notebook.overview-note", "Overview note", "pass", "Bound Overview membership, project ownership, logical ID, and descriptor freshness were proved");
  return finding("notebook.overview-note", "Overview note", "fail", "Overview is missing, foreign, or drifted", observed.overview?.drift.map((item) => `${item.path}: ${item.reason}`) ?? [], true);
}

/**
 * PJAN-82: a host-owned skill projection is not a repository defect.
 *
 * `~/.agents/skills` belongs to the machine, not to the repo being audited. When
 * it is owned elsewhere (a Skillex fanout that has drifted, or a deliberately
 * customized path) no amount of work in this repository can change it, so
 * reporting `fail` made every project on the machine fail at once — and, because
 * `auditRecipes` treats anything that is not pass/skip as not-ok and
 * `ProjectRecipe` turns a not-ok postcondition audit into a transaction error,
 * that host state was enough to fail (and roll back) a brand-new project.
 * These are reported as `skip` carrying the exact drift and the repair command.
 */
function hostBlockFinding(id: string, title: string, block: NonNullable<NotebookObservationV1["skill_host_block"]>): LifecycleAuditFinding {
  return finding(id, title, "skip", `Host skill projection is owned outside PJángler: ${block.summary}`, [...block.details, `Repair: ${block.repair}`], false);
}

function skillAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.skill-installed", "Project Notebook skill", "skip", "Project Notebook is not declared for this repository");
  const observed = observation(ctx);
  if (observed?.skill_installed === true) return finding("notebook.skill-installed", "Project Notebook skill", "pass", "Digest-verified Project Notebook skill is installed");
  if (observed?.skill_host_block) return hostBlockFinding("notebook.skill-installed", "Project Notebook skill", observed.skill_host_block);
  if (observed?.skill_installed === false) return finding("notebook.skill-installed", "Project Notebook skill", "fail", "Digest-verified Project Notebook skill is not installed", ["Run pj notebook migrate --apply"], true);
  return finding("notebook.skill-installed", "Project Notebook skill", "skip", "Skill installation was not observed; no global path was read", [], true);
}

function hooksAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.hooks-projected", "Project Notebook hooks", "skip", "Project Notebook is not declared for this repository");
  const observed = observation(ctx);
  if (observed?.hooks_projected === true) return finding("notebook.hooks-projected", "Project Notebook hooks", "pass", "True SessionStart and SessionEnd hook entries are projected once");
  if (observed?.skill_host_block) return hostBlockFinding("notebook.hooks-projected", "Project Notebook hooks", observed.skill_host_block);
  if (observed?.hooks_projected === false) return finding("notebook.hooks-projected", "Project Notebook hooks", "fail", "Canonical true-boundary hooks are missing, duplicated, or drifted", ["Run pj notebook migrate --apply"], true);
  return finding("notebook.hooks-projected", "Project Notebook hooks", "skip", "Hook projection was not observed; no global settings file was read", [], true);
}

function stateRoot(ctx: LifecycleContext): string {
  return ctx.notebookStateRoot ?? notebookStateRoot({ HOME: ctx.homeDir });
}

function admission(ctx: LifecycleContext) {
  const config = resolvedConfig(ctx);
  return captureAdmissionSummary(stateRoot(ctx), config.project_slug, config.limits);
}

function journalDetails(journals: ReturnType<typeof admission>["unresolvedJournals"]): string[] {
  return journals.map((item) => `${item.operation_id}: ${item.result_category}; ${item.next_action}; run pj notebook audit --json, then retry the originating action once`);
}

function captureAudit(ctx: LifecycleContext): LifecycleAuditFinding {
  if (!enabled(ctx)) return finding("notebook.capture-receipts", "Capture receipts", "skip", "Project Notebook is not declared for this repository");
  try {
    const config = resolvedConfig(ctx);
    const summary = captureAdmissionSummary(stateRoot(ctx), config.project_slug, config.limits);
    if (summary.unmeasurable_entry_count) return finding("notebook.capture-receipts", "Capture receipts", "fail", "Capture state-integrity prevents exact admission proof", summary.integrity_entries.map((item) => `${item.entry_id}: ${item.reason}`), true);
    const overviewLogicalId = `overview:v1:${config.project_slug}`;
    const actionJournals = summary.unresolvedJournals.filter((item) => item.kind === "note.create" && item.logical_marker !== overviewLogicalId);
    if (actionJournals.length) {
      const succeeded = new Map(listCaptureReceipts(stateRoot(ctx), config.project_slug, config.limits, "succeeded").map((receipt) => [receipt.session_key, receipt]));
      const recoverable = actionJournals.filter((journal) => {
        const receipt = journal.session_key ? succeeded.get(journal.session_key) : undefined;
        if (!receipt || journal.state !== "reconciled" || journal.binding_id !== config.binding.notebook_id || journal.candidate_ids.length !== 1) return false;
        const index = receipt.note_logical_ids.indexOf(journal.logical_marker);
        return index >= 0 && receipt.remote_note_ids[index] === journal.candidate_ids[0];
      });
      return finding(
        "notebook.capture-receipts",
        "Capture receipts",
        "warn",
        recoverable.length
          ? "Receipt-proven reconciled capture journals can be finalized locally; other session, document, or user-note journals still require explicit originating-action recovery"
          : "Unresolved session, document, or user-note mutations require explicit originating-action recovery; retention cleanup cannot resolve them",
        [
          ...journalDetails(actionJournals),
          ...(recoverable.length ? [`Run pj notebook migrate ${config.repo_path} --apply to finalize ${recoverable.length} receipt-proven journal(s) without remote work`] : []),
        ],
        recoverable.length > 0,
      );
    }
    const pressure = currentRetentionPressure(summary);
    if (pressure.length) return finding("notebook.capture-receipts", "Capture receipts", "warn", "Current unresolved capture usage is under retention pressure", pressure.map((item) => item.session_key ? `${item.reason}: ${item.session_key}` : item.reason), false);
    return finding("notebook.capture-receipts", "Capture receipts", "pass", "Capture receipts are measurable; unresolved work is preserved and within admission caps", summary.active_refusals.map((item) => `capture-refused-history: ${item.session_key}`));
  } catch (error) {
    return finding("notebook.capture-receipts", "Capture receipts", "fail", normalizeNotebookError(error).message);
  }
}

export function createNotebookChecks(): readonly RecipeCheck[] {
  return [
    new NotebookCheck("notebook.configuration", "Notebook configuration", configurationAudit),
    new NotebookCheck("notebook.binding", "Notebook binding", bindingAudit),
    new NotebookCheck("notebook.remote-notebook", "Remote notebook", remoteAudit),
    new NotebookCheck("notebook.overview-note", "Overview note", overviewAudit),
    new NotebookCheck("notebook.skill-installed", "Project Notebook skill", skillAudit),
    new NotebookCheck("notebook.hooks-projected", "Project Notebook hooks", hooksAudit),
    new NotebookCheck("notebook.capture-receipts", "Capture receipts", captureAudit, (ctx, current) => {
      if (ctx.dryRun) return result(current, "applied", "Would expire only elapsed succeeded receipts and elapsed unreferenced receiptless state");
      try {
        const config = resolvedConfig(ctx);
        const removed = pruneNotebookState(stateRoot(ctx), config.project_slug, config.limits);
        return result(current, removed.length ? "applied" : "noop", removed.length ? "Expired only eligible owned capture state" : "No eligible capture state required cleanup", removed);
      } catch (error) {
        return result(current, "blocked", normalizeNotebookError(error).message);
      }
    }),
  ];
}
