import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";
import type { RecipeOwnedCheck } from "../parity/rules";

/** PJangler's callable boundary; an owner adapter translates its public API. */
export interface CompanionRequest {
  schemaVersion: 1;
  moduleId: "g33";
  operation: "observe" | "plan" | "apply";
  projectRoot: string;
  reason: "recipe" | "bmad-install" | "audit" | "repair";
  options: Record<string, unknown>;
}

export interface CompanionReply {
  schemaVersion: 1;
  status: "installed" | "missing" | "planned" | "changed" | "unchanged" | "unavailable" | "conflict" | "error";
  summary: string;
  details: string[];
  /** Observation evidence from the owner, including mapping/content checks. */
  evidence: string[];
}

export interface CompanionResult {
  schemaVersion: 1;
  moduleId: "g33";
  optional: true;
  status: CompanionReply["status"] | "disabled";
  summary: string;
  details: string[];
  evidence: string[];
  changedFiles: string[];
  adapter?: { module: string; exportName: string };
}

type Callable = (request: CompanionRequest) => CompanionReply | Promise<CompanionReply>;
type Selection = { enabled: boolean; reason: string; module?: string; exportName?: string; options: Record<string, unknown> };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function optionalObject(parent: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  if (!Object.hasOwn(parent, key)) return {};
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object when present`);
  return value as Record<string, unknown>;
}

function select(projectRoot: string): Selection {
  const path = join(projectRoot, ".project.json");
  const manifest = existsSync(path) ? record(JSON.parse(readFileSync(path, "utf8"))) : {};
  const bmad = optionalObject(manifest, "bmad", "bmad");
  const config = optionalObject(bmad, "companion", "bmad.companion");
  // Validate present containers even on disabled/ineligible projects, before imports.
  const adapter = optionalObject(config, "adapter", "bmad.companion.adapter");
  const options = optionalObject(adapter, "options", "bmad.companion.adapter.options");
  // A project opt-out always wins, including over host adapter configuration.
  if (config.enabled === false) return { enabled: false, reason: "g33 explicitly disabled in .project.json", options: {} };
  if (config.enabled !== undefined && config.enabled !== true) throw new Error("bmad.companion.enabled must be boolean");
  const binding = record(manifest.ticket_provider);
  const registered = typeof manifest.project_id === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(manifest.project_id) && manifest.project_id.length <= 128;
  const eligible = registered && binding.type === "plane" && binding.state === "linked"
    && typeof binding.workspace === "string" && binding.workspace.trim().toLowerCase() === "33god"
    && typeof binding.board_id === "string" && binding.board_id.trim() !== "";
  if (!eligible && config.enabled !== true) return { enabled: false, reason: "g33 defaults off without a registered linked 33god project or explicit opt-in", options: {} };
  const module = adapter.module ?? (process.env.PJ_G33_ADAPTER_MODULE?.trim() || undefined);
  const exportName = adapter.exportName ?? (process.env.PJ_G33_ADAPTER_EXPORT?.trim() || undefined);
  if (module !== undefined && (typeof module !== "string" || !module.trim())) throw new Error("g33 adapter.module must be a non-empty package specifier or source path");
  if (exportName !== undefined && (typeof exportName !== "string" || !exportName.trim())) throw new Error("g33 adapter.exportName must name the supported callable export");
  return {
    enabled: true, reason: eligible ? "Registered linked 33god project" : "Explicit g33 opt-in",
    module: module as string | undefined, exportName: exportName as string | undefined, options,
  };
}

/** Read local policy only; ProjectRecipe uses this to defer automatic enrollment. */
export function g33CompanionEnabled(projectRoot: string): boolean {
  return select(projectRoot).enabled;
}

/** Resolve only; no package installation, export guesses, or owner code execution. */
function resolveAdapter(projectRoot: string, module: string): string {
  if (module.startsWith(".") || isAbsolute(module)) {
    const path = resolve(projectRoot, module);
    if (!existsSync(path)) throw new Error(`Configured g33 source is unavailable: ${module}`);
    return pathToFileURL(path).href;
  }
  if (module.includes(":") || module.startsWith("/")) throw new Error("Use a local source path or installed package specifier for g33");
  // Node's second import.meta.resolve argument is flag-gated. A resolver-only
  // subprocess supplies that flag and project parent without writing a helper
  // into the target or importing owner code. Both attempts use ESM conditions.
  const resolved = spawnSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "--eval",
    "process.stdout.write(import.meta.resolve(process.argv[1], process.argv[2]))",
    "--", module, pathToFileURL(join(projectRoot, ".project.json")).href,
  ], { encoding: "utf8", timeout: 10_000 });
  if (resolved.status === 0 && resolved.stdout.trim()) return resolved.stdout.trim();
  const projectError = resolved.stderr.trim() || resolved.error?.message || `resolver exit ${resolved.status}`;
  try { return import.meta.resolve(module); }
  catch (error) {
    throw new Error(`Project ESM resolution failed: ${projectError}\nPJangler ESM resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reply(value: unknown, operation: CompanionRequest["operation"]): CompanionReply {
  const data = record(value);
  const statuses = operation === "observe" ? ["installed", "missing", "unavailable", "conflict", "error"]
    : operation === "plan" ? ["planned", "unchanged", "unavailable", "conflict", "error"]
    : ["changed", "unchanged", "unavailable", "conflict", "error"];
  if (data.schemaVersion !== 1 || !statuses.includes(String(data.status)) || typeof data.summary !== "string"
    || ![data.details, data.evidence].every((field) => Array.isArray(field) && field.every((item) => typeof item === "string"))) {
    throw new Error(`Configured g33 adapter returned an invalid v1 ${operation} result`);
  }
  if (data.status === "installed" && !(data.evidence as string[]).some((item) => item.trim())) {
    throw new Error("g33 installed observation requires owner content/mapping evidence; metadata alone is insufficient");
  }
  // Only the declared reply crosses the boundary. In particular, owner-supplied
  // changedFiles cannot overwrite PJangler's actual target inventory.
  return {
    schemaVersion: 1, status: data.status as CompanionReply["status"], summary: data.summary,
    details: [...data.details as string[]], evidence: [...data.evidence as string[]],
  };
}

/** Optional outcomes never throw into required BMAD initialization/rollback. */
export async function runG33Companion(projectRoot: string, dryRun: boolean, reason: CompanionRequest["reason"] = "recipe"): Promise<CompanionResult> {
  projectRoot = resolve(projectRoot);
  const result: CompanionResult = { schemaVersion: 1, moduleId: "g33", optional: true, status: "unavailable", summary: "g33 companion unavailable", details: [], evidence: [], changedFiles: [] };
  let before: ReturnType<typeof snapshotTree> | undefined;
  try {
    const selection = select(projectRoot);
    if (!selection.enabled) return { ...result, status: "disabled", summary: selection.reason };
    result.details.push(selection.reason);
    if (!selection.module || !selection.exportName) return {
      ...result, summary: "Optional g33 installer is not configured",
      details: [...result.details, "Configure bmad.companion.adapter.module and exportName (or PJ_G33_ADAPTER_MODULE/PJ_G33_ADAPTER_EXPORT) to the owner's supported callable adapter. No g33 installation was attempted."],
    };
    result.adapter = { module: selection.module, exportName: selection.exportName };
    let specifier: string;
    try { specifier = resolveAdapter(projectRoot, selection.module); }
    catch (error) {
      return { ...result, status: "unavailable", summary: "Configured g33 adapter is unavailable", details: [...result.details, error instanceof Error ? error.message : String(error)] };
    }
    before = snapshotTree(projectRoot);
    const exported = await import(specifier) as Record<string, unknown>;
    if (changedTreePaths(projectRoot, before, snapshotTree(projectRoot)).length) {
      throw new Error("g33 adapter violated the no-write import contract");
    }
    const callable = exported[selection.exportName];
    if (typeof callable !== "function") throw new Error(`Configured g33 export ${selection.exportName} is not callable`);
    const invoke = async (operation: CompanionRequest["operation"]): Promise<CompanionReply> => {
      const value = reply(await (callable as Callable)({ schemaVersion: 1, moduleId: "g33", operation, projectRoot, reason, options: selection.options }), operation);
      if (operation !== "apply" && changedTreePaths(projectRoot, before!, snapshotTree(projectRoot)).length) {
        throw new Error(`g33 adapter violated the no-write ${operation} contract`);
      }
      return value;
    };
    const observed = await invoke("observe");
    if (["unavailable", "conflict", "error"].includes(observed.status)) return { ...result, ...observed };
    const plan = await invoke("plan");
    if (["unavailable", "conflict", "error"].includes(plan.status)) return { ...result, ...plan };
    if (plan.status === "unchanged" && observed.status !== "installed") throw new Error("g33 plan claims convergence but owner observation does not prove installation");
    if (dryRun) return { ...result, ...plan, evidence: observed.evidence };
    if (plan.status === "unchanged" && observed.status === "installed") return { ...result, ...observed, status: "unchanged" };
    const applied = await invoke("apply");
    result.changedFiles = changedTreePaths(projectRoot, before, snapshotTree(projectRoot));
    if (["unavailable", "conflict", "error"].includes(applied.status)) return { ...result, ...applied };
    // Mutation results are never installation proof. Re-observe owner content.
    before = snapshotTree(projectRoot);
    const verified = await invoke("observe");
    if (verified.status !== "installed") return {
      ...result, status: "error", summary: "g33 apply did not establish an installed owner observation",
      details: [verified.summary, ...verified.details], evidence: verified.evidence,
    };
    return { ...result, ...verified, status: result.changedFiles.length ? "changed" : "unchanged" };
  } catch (error) {
    if (before) {
      try { result.changedFiles = [...new Set([...result.changedFiles, ...changedTreePaths(projectRoot, before, snapshotTree(projectRoot))])].sort(); }
      catch (snapshotError) { result.details.push(`Could not inventory partial g33 writes: ${String(snapshotError)}`); }
    }
    return { ...result, status: "error", summary: "Optional g33 companion could not be reconciled", details: [...result.details, error instanceof Error ? error.message : String(error)] };
  }
}


function localEntryPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Fail closed BEFORE any upstream updater or retired-state eviction. Existing
 * enabled g33 projects need the owner's pre-update preservation handoff; the
 * v1 observe/plan/apply seam cannot safely protect native overrides or mappings
 * from an upstream rewrite. Fresh required BMAD installs remain independent.
 * A retained g33 tree is also protected after opt-out (not installation proof).
 */
export function g33BmadUpdateBoundary(projectRoot: string, retainedG33Declaration = false): CompanionResult | undefined {
  const result: CompanionResult = {
    schemaVersion: 1, moduleId: "g33", optional: true, status: "conflict",
    summary: "BMAD update withheld pending the g33 owner pre-update preservation contract",
    details: ["No installer, retired-state eviction, or companion import/apply was attempted. Existing native BMAD bytes, customizations, and module mappings are retained.",
      "The owner must provide a supported pre-update capture/protection and post-update restore/verification handoff, including failure recovery. The configured v1 callable alone does not authorize a destructive BMAD update."],
    evidence: [], changedFiles: [],
  };
  try {
    const retainedG33 = retainedG33Declaration || localEntryPresent(join(projectRoot, "_bmad", "g33"));
    const installedBmad = retainedG33 || localEntryPresent(join(projectRoot, "_bmad", "_config", "manifest.yaml"))
      || localEntryPresent(join(projectRoot, "_bmad", "core"));
    if (!installedBmad) return undefined;
    const selection = select(projectRoot);
    if (!selection.enabled && !retainedG33) return undefined;
    if (selection.module && selection.exportName) result.adapter = { module: selection.module, exportName: selection.exportName };
    result.details.unshift(retainedG33 ? "Retained g33 tree or module declaration requires preservation, including after opt-out." : selection.reason);
    return result;
  } catch (error) {
    return { ...result, status: "error", summary: "BMAD update withheld: companion configuration or preservation inspection failed",
      details: [...result.details, error instanceof Error ? error.message : String(error)] };
  }
}

export function companionDetails(result: CompanionResult): string[] {
  return [`g33 (${result.status}): ${result.summary}`, ...result.details, ...result.evidence];
}

export function createG33CompanionCheck(): RecipeOwnedCheck {
  return {
    id: "bmad.g33-companion", title: "Optional g33 companion",
    audit: async (ctx) => {
      // Read-only observation and planning remain independent of application.
      const result = await runG33Companion(ctx.repoRoot, true, "audit");
      return {
        id: "bmad.g33-companion", title: "Optional g33 companion",
        status: result.status === "disabled" ? "skip" : result.status === "unchanged" && result.evidence.length ? "pass" : "warn",
        summary: result.summary, details: companionDetails(result), fixable: result.status === "planned",
      };
    },
    migrate: async (ctx, finding) => {
      const result = await runG33Companion(ctx.repoRoot, ctx.dryRun, "repair");
      return {
        id: finding.id, title: finding.title,
        status: result.status === "changed" || result.status === "planned" ? "applied" : result.status === "unchanged" ? "noop"
          : result.status === "disabled" ? "skipped" : "partial",
        summary: result.summary, details: companionDetails(result), changedFiles: result.changedFiles,
      };
    },
  };
}
