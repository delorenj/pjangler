import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changedTreePaths, excludedFromTreeSnapshot, snapshotTree } from "../utils/tree-diff";
import { enableSelection, readSelectionManifest, showSkill } from "@delorenj/skillex";
import { PJ_SKILLS, skillCoreOptions, skillDiagnostics } from "../parity/skills";
import type { Context, MigrationRuleResult, RecipeOwnedCheck } from "../parity/rules";

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

/** The one eligibility rule: a registered project with a linked 33god Plane board. */
function linkedG33Project(manifest: Record<string, unknown>): boolean {
  const binding = record(manifest.ticket_provider);
  const registered = typeof manifest.project_id === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(manifest.project_id) && manifest.project_id.length <= 128;
  return registered && binding.type === "plane" && binding.state === "linked"
    && typeof binding.workspace === "string" && binding.workspace.trim().toLowerCase() === "33god"
    && typeof binding.board_id === "string" && binding.board_id.trim() !== "";
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
  const eligible = linkedG33Project(manifest);
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
export async function runG33Companion(
  projectRoot: string,
  dryRun: boolean,
  reason: CompanionRequest["reason"] = "recipe",
  options: { allowPostUpdateConflictPlan?: boolean } = {},
): Promise<CompanionResult> {
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
      const written = operation === "apply" ? [] : changedTreePaths(projectRoot, before!, snapshotTree(projectRoot));
      if (written.length) {
        throw new Error(`g33 adapter violated the no-write ${operation} contract: ${written.slice(0, 10).join(", ")}${written.length > 10 ? ` (+${written.length - 10} more)` : ""}`);
      }
      return value;
    };
    const observed = await invoke("observe");
    const allowPostUpdateConflictPlan = Boolean(options.allowPostUpdateConflictPlan && !dryRun && observed.status === "conflict");
    if (["unavailable", "conflict", "error"].includes(observed.status) && !allowPostUpdateConflictPlan) return { ...result, ...observed };
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

/** The owner adapter shipped by the skillex catalog skill; new linked projects get exactly this block. */
export const G33_SKILL = "g33-33god-integration";
export const G33_BRIDGE_ADAPTER = Object.freeze({ module: `./.agents/skills/${G33_SKILL}/scripts/g33_pjangler_bridge.mjs`, exportName: "g33Companion" });

export interface G33EnrollmentResult {
  status: "enrolled" | "already-configured" | "skipped" | "planned" | "error";
  summary: string;
  details: string[];
  changedFiles: string[];
}

export type G33Enrollability =
  | { enrollable: true; reason: string }
  | { enrollable: false; status: "already-configured" | "skipped"; summary: string; details: string[] };

/**
 * The ONE rule for "would enrollment act on this project": read-only, shared by
 * the audit (which must not write) and enrollG33Companion (which does). Eligible,
 * not opted out, no adapter half configured (manifest or PJ_G33_ADAPTER_* env),
 * and skills.json not selecting a set. Throws on a malformed manifest; callers
 * decide whether that is an advisory (enroll) or a fall-through (audit).
 */
export async function g33Enrollability(ctx: Context): Promise<G33Enrollability> {
  const projectRoot = resolve(ctx.repoRoot);
  const skipped = (summary: string, details: string[] = []): G33Enrollability => ({ enrollable: false, status: "skipped", summary, details });
  const path = join(projectRoot, ".project.json");
  if (!existsSync(path)) return skipped("skipped: no .project.json");
  const manifest = record(JSON.parse(readFileSync(path, "utf8")));
  const bmad = optionalObject(manifest, "bmad", "bmad");
  const config = optionalObject(bmad, "companion", "bmad.companion");
  const adapter = optionalObject(config, "adapter", "bmad.companion.adapter");
  optionalObject(adapter, "options", "bmad.companion.adapter.options");
  if (config.enabled === false) return skipped("skipped: g33 explicitly disabled in .project.json");
  if (config.enabled !== undefined && config.enabled !== true) throw new Error("bmad.companion.enabled must be boolean");
  if (!linkedG33Project(manifest)) return skipped("skipped: not a registered linked 33god project");
  // Same merge as select(): each half comes from the manifest or its env var.
  const hasModule = adapter.module !== undefined || Boolean(process.env.PJ_G33_ADAPTER_MODULE?.trim());
  const hasExport = adapter.exportName !== undefined || Boolean(process.env.PJ_G33_ADAPTER_EXPORT?.trim());
  if (hasModule && hasExport) return { enrollable: false, status: "already-configured", summary: "g33 adapter already configured; enrollment not needed", details: [] };
  if (hasModule || hasExport) return skipped(`skipped: g33 adapter is half-configured (${hasModule ? "exportName" : "module"} is missing)`,
    [`Set bmad.companion.adapter.${hasModule ? "exportName" : "module"} (or PJ_G33_ADAPTER_${hasModule ? "EXPORT" : "MODULE"}); enrollment never completes or overwrites an adapter someone started.`]);
  // A set replaces the project skills root and enabling beside it derives a new
  // set directory inside the shared catalog: not ours to write (see handOffInstallerSkills).
  const declaration = await readSelectionManifest(skillCoreOptions(ctx).project);
  if (Array.isArray(declaration.raw?.sets) && declaration.raw.sets.length) {
    return skipped("skipped: a set replaces the project skills root", [`Enrolling would derive a new set inside the skills catalog. ${enrollRetry()}`]);
  }
  return { enrollable: true, reason: "eligible 33god project has no companion adapter" };
}

/**
 * Host state, read-only: does THIS machine's catalog resolve the g33 skill with the
 * bridge the adapter points at. The audit uses it so it advertises only a fix that
 * can run here; a miss is an advisory about the host, never a project failure.
 */
export async function g33CatalogProblem(ctx: Context): Promise<string | undefined> {
  try {
    const { cwd, home, env, registryRoot } = skillCoreOptions(ctx);
    const shown = await showSkill(G33_SKILL, { cwd, home, env, ...(registryRoot ? { registryRoot } : {}) });
    if (!shown.ok || !shown.data) return `the skill catalog on this host does not resolve ${G33_SKILL}`;
    const bridge = join(shown.data.skill.path, "scripts", "g33_pjangler_bridge.mjs");
    if (!existsSync(bridge)) return `${G33_SKILL} in the catalog has no scripts/g33_pjangler_bridge.mjs`;
    return undefined;
  } catch (error) {
    return `the skill catalog on this host could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
}

const enrollRetry = (): string => `Run: ${PJ_SKILLS} enable skill ${G33_SKILL}, then add bmad.companion.adapter ${JSON.stringify(G33_BRIDGE_ADAPTER)} to .project.json`;

/**
 * Optional, like the companion itself: never throws, and every failure is an
 * advisory the caller records. Activates the owner skill, then writes the
 * adapter block, for a project g33Enrollability accepts. An existing adapter, an
 * explicit `enabled: false` and `adapter.options` are never touched. The
 * manifest is written only after the bridge the block points at resolves.
 */
export async function enrollG33Companion(ctx: Context): Promise<G33EnrollmentResult> {
  const projectRoot = resolve(ctx.repoRoot);
  const result: G33EnrollmentResult = { status: "skipped", summary: "skipped", details: [], changedFiles: [] };
  const retry = enrollRetry();
  let before: ReturnType<typeof snapshotTree> | undefined;
  try {
    const path = join(projectRoot, ".project.json");
    const verdict = await g33Enrollability(ctx);
    if (!verdict.enrollable) return { ...result, status: verdict.status, summary: verdict.summary, details: verdict.details };
    if (ctx.dryRun) return {
      ...result, status: "planned", summary: `would activate ${G33_SKILL} and write bmad.companion.adapter`,
      details: [`Would run ${PJ_SKILLS} enable skill ${G33_SKILL} and set bmad.companion.adapter to ${JSON.stringify(G33_BRIDGE_ADAPTER)}; nothing written.`],
    };
    before = snapshotTree(projectRoot);
    // enableSelection reconciles the whole scope; a refusal is an envelope, not a throw.
    const enabled = await enableSelection("skill", G33_SKILL, { ...skillCoreOptions(ctx), dryRun: false });
    if (!enabled.ok) {
      const found = skillDiagnostics(enabled.findings);
      return { ...result, status: "error", summary: `could not activate ${G33_SKILL}`, details: [...found, retry],
        changedFiles: changedTreePaths(projectRoot, before, snapshotTree(projectRoot)) };
    }
    if (!existsSync(resolve(projectRoot, G33_BRIDGE_ADAPTER.module))) {
      return { ...result, status: "error", summary: `activated ${G33_SKILL} but its bridge is not in the project`,
        details: [`Missing ${G33_BRIDGE_ADAPTER.module}; the adapter was not written.`, retry],
        changedFiles: changedTreePaths(projectRoot, before, snapshotTree(projectRoot)) };
    }
    // Re-read: activation reconciles under a lock and the manifest may have moved.
    const current = record(JSON.parse(readFileSync(path, "utf8")));
    const currentBmad = optionalObject(current, "bmad", "bmad");
    const currentConfig = optionalObject(currentBmad, "companion", "bmad.companion");
    if (!Object.hasOwn(currentBmad, "companion")) currentBmad.companion = currentConfig;
    if (!Object.hasOwn(current, "bmad")) current.bmad = currentBmad;
    currentConfig.adapter = { ...optionalObject(currentConfig, "adapter", "bmad.companion.adapter"), ...G33_BRIDGE_ADAPTER };
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return { ...result, status: "enrolled", summary: `activated ${G33_SKILL} and wrote bmad.companion.adapter`,
      changedFiles: changedTreePaths(projectRoot, before, snapshotTree(projectRoot)) };
  } catch (error) {
    let changedFiles: string[] = [];
    try { if (before) changedFiles = changedTreePaths(projectRoot, before, snapshotTree(projectRoot)); } catch { /* the inventory is best effort */ }
    return { ...result, status: "error", summary: "could not be completed", details: [error instanceof Error ? error.message : String(error), retry], changedFiles };
  }
}

export function enrollmentDetails(result: G33EnrollmentResult): string[] {
  return [`g33 enrollment${result.status === "enrolled" ? "" : ` (${result.status})`}: ${result.summary}`, ...result.details];
}

function safeFileText(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "";
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function hasRetainedG33State(projectRoot: string, retainedG33Declaration = false): boolean {
  if (
    retainedG33Declaration
    || localEntryPresent(join(projectRoot, "_bmad", "g33"))
    || localEntryPresent(join(projectRoot, "_bmad", "_config", "g33-mapping.json"))
  ) {
    return true;
  }
  const tomlPattern = /^\[modules\.g33\]\s*(?:#.*)?$/m;
  if (
    tomlPattern.test(safeFileText(join(projectRoot, "_bmad", "config.toml")))
    || tomlPattern.test(safeFileText(join(projectRoot, "_bmad", "custom", "config.toml")))
  ) {
    return true;
  }
  return /^(?:g33|"g33"|'g33')\s*:/m.test(safeFileText(join(projectRoot, "_bmad", "config.yaml")));
}

export function isInstalledBmadProject(projectRoot: string, retainedG33Declaration = false): boolean {
  const retainedG33 = hasRetainedG33State(projectRoot, retainedG33Declaration);
  return retainedG33
    || localEntryPresent(join(projectRoot, "_bmad", "_config", "manifest.yaml"))
    || localEntryPresent(join(projectRoot, "_bmad", "core"))
    || localEntryPresent(join(projectRoot, "_bmad", "config.toml"));
}

function localEntryPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Fail closed BEFORE any upstream updater or retired-state eviction when an
 * installed project has retained g33 state/declarations after opt-out or is
 * enabled for g33 without a configured adapter. Enabled projects with a
 * configured adapter proceed to the pre-update preflight + capture/restore/reconcile
 * handoff. Fresh required BMAD installs remain independent.
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
    const retainedG33 = hasRetainedG33State(projectRoot, retainedG33Declaration);
    const installedBmad = retainedG33
      || localEntryPresent(join(projectRoot, "_bmad", "_config", "manifest.yaml"))
      || localEntryPresent(join(projectRoot, "_bmad", "core"))
      || localEntryPresent(join(projectRoot, "_bmad", "config.toml"));
    if (!installedBmad) return undefined;
    const selection = select(projectRoot);
    if (!selection.enabled && !retainedG33) return undefined;
    if (!selection.enabled && retainedG33) {
      result.details.unshift("Retained g33 tree or module declaration requires preservation, including after opt-out.");
      return result;
    }
    if (!selection.module || !selection.exportName) {
      result.summary = "BMAD update withheld: optional g33 companion adapter is not configured";
      result.details.unshift(selection.reason);
      return result;
    }
    return undefined;
  } catch (error) {
    return { ...result, status: "error", summary: "BMAD update withheld: companion configuration or preservation inspection failed",
      details: [...result.details, error instanceof Error ? error.message : String(error)] };
  }
}

type TreeBackupEntry =
  | { kind: "dir"; mode: number }
  | { kind: "link"; target: string }
  | { kind: "file"; mode: number; bytes: Buffer };

export type TreeBackup = Map<string, TreeBackupEntry>;

export function captureTreeBackup(root: string, current = root, backup: TreeBackup = new Map()): TreeBackup {
  let stat;
  try { stat = lstatSync(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return backup;
    throw error;
  }
  const rel = relative(root, current) || ".";
  if (excludedFromTreeSnapshot(rel, current)) return backup;
  if (stat.isSymbolicLink()) {
    backup.set(rel, { kind: "link", target: readlinkSync(current) });
  } else if (stat.isFile()) {
    backup.set(rel, { kind: "file", mode: stat.mode & 0o7777, bytes: Buffer.from(readFileSync(current)) });
  } else if (stat.isDirectory()) {
    backup.set(rel, { kind: "dir", mode: stat.mode & 0o7777 });
    for (const name of readdirSync(current).sort()) captureTreeBackup(root, join(current, name), backup);
  }
  return backup;
}

function restoreSingleEntry(root: string, rel: string, entry: TreeBackupEntry): void {
  const full = rel === "." ? root : join(root, rel);
  let currentStat;
  try { currentStat = lstatSync(full); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entry.kind === "dir") {
    if (currentStat && (!currentStat.isDirectory() || currentStat.isSymbolicLink())) {
      rmSync(full, { recursive: true, force: true });
      currentStat = undefined;
    }
    if (!currentStat) mkdirSync(full, { recursive: true });
    chmodSync(full, entry.mode);
    return;
  }
  if (rel !== ".") mkdirSync(dirname(full), { recursive: true });
  if (entry.kind === "link") {
    if (currentStat) {
      if (currentStat.isSymbolicLink() && readlinkSync(full) === entry.target) return;
      rmSync(full, { recursive: true, force: true });
    }
    symlinkSync(entry.target, full);
    return;
  }
  if (currentStat?.isFile() && !currentStat.isSymbolicLink()) {
    // Untouched entries (the bulk of a whole-tree backup) are left alone; a
    // read-only file (git pack objects are 0444) is replaced via unlink, which
    // needs write permission on the directory, not the file.
    if ((currentStat.mode & 0o7777) === entry.mode && readFileSync(full).equals(entry.bytes)) return;
    unlinkSync(full);
  } else if (currentStat) {
    rmSync(full, { recursive: true, force: true });
  }
  writeFileSync(full, entry.bytes);
  chmodSync(full, entry.mode);
}

export function restoreTreeBackup(root: string, backup: TreeBackup): void {
  const current = captureTreeBackup(root);
  // Removing an entry needs write permission on its parent, so every present
  // directory is owner-writable before anything is unlinked.
  for (const [rel, entry] of current.entries()) {
    if (entry.kind === "dir" && (entry.mode & 0o700) !== 0o700) chmodSync(rel === "." ? root : join(root, rel), entry.mode | 0o700);
  }
  const removed = [...current.keys()]
    .filter((rel) => rel !== "." && !backup.has(rel))
    .sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length || b.localeCompare(a));
  for (const rel of removed) {
    const full = join(root, rel);
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(full, { recursive: true, force: true });
      else unlinkSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const dirs = [...backup.entries()]
    .filter((pair): pair is [string, Extract<TreeBackupEntry, { kind: "dir" }>] => pair[1].kind === "dir")
    .sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b)));
  // Owner-writable while children are restored; exact modes are re-applied last.
  for (const [rel, entry] of dirs) restoreSingleEntry(root, rel, { ...entry, mode: entry.mode | 0o700 });
  for (const [rel, entry] of backup.entries()) {
    if (entry.kind !== "dir") restoreSingleEntry(root, rel, entry);
  }
  for (const [rel, entry] of [...dirs].reverse()) {
    chmodSync(rel === "." ? root : join(root, rel), entry.mode);
  }
}

const G33_MANAGED_CUSTOM_REL = new Set([
  "_bmad/custom/config.toml",
  "_bmad/custom/bmad-build.toml",
  "_bmad/custom/bmad-code-review.toml",
  "_bmad/custom/bmad-prd.toml",
  "_bmad/custom/bmad-spec.toml",
  "_bmad/custom/bmad-architecture.toml",
]);

function parseSimpleCsvRows(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return [];
  const splitLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') quoted = false;
        else current += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(current); current = ""; }
      else current += ch;
    }
    cells.push(current);
    return cells;
  };
  const headers = splitLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    return Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? ""]));
  });
}

function skillManifestSourceMap(backup: TreeBackup): Map<string, string> {
  const map = new Map<string, string>();
  const entry = backup.get("_bmad/_config/skill-manifest.csv") ?? backup.get(join("_bmad", "_config", "skill-manifest.csv"));
  if (!entry || entry.kind !== "file") return map;
  for (const row of parseSimpleCsvRows(entry.bytes.toString("utf8"))) {
    const id = (row.canonicalId ?? "").trim();
    const skillPath = (row.path ?? "").trim().replace(/\\/g, "/");
    if (id && skillPath.endsWith("/SKILL.md")) {
      map.set(id, skillPath.slice(0, -"/SKILL.md".length));
    }
  }
  return map;
}

export interface ProtectedBmadState {
  backup: TreeBackup;
  hadManifestG33: boolean;
  hadTomlG33: boolean;
  customEntries: Map<string, TreeBackupEntry>;
  operatorCustomEntries: Map<string, TreeBackupEntry>;
  scriptEntries: Map<string, TreeBackupEntry>;
  companionEntries: Map<string, TreeBackupEntry>;
  operatorNativeSkills: Map<string, TreeBackupEntry>;
}

export function captureProtectedBmadState(
  projectRoot: string,
  options: { hadManifestG33: boolean; hadTomlG33: boolean },
): ProtectedBmadState {
  const root = resolve(projectRoot);
  const backup = captureTreeBackup(root);
  const customEntries = new Map<string, TreeBackupEntry>();
  const operatorCustomEntries = new Map<string, TreeBackupEntry>();
  const scriptEntries = new Map<string, TreeBackupEntry>();
  const companionEntries = new Map<string, TreeBackupEntry>();
  const operatorNativeSkills = new Map<string, TreeBackupEntry>();
  const sourceMap = skillManifestSourceMap(backup);
  const claudeSkillsEntry = backup.get(join(".claude", "skills"));
  const claudeSkillsIsRealDir = claudeSkillsEntry?.kind === "dir";

  for (const [rel, entry] of backup.entries()) {
    const norm = rel.replace(/\\/g, "/");
    if (norm === "_bmad/custom" || norm.startsWith("_bmad/custom/")) {
      customEntries.set(rel, entry);
      if (norm !== "_bmad/custom" && !G33_MANAGED_CUSTOM_REL.has(norm)) {
        operatorCustomEntries.set(rel, entry);
      }
    }
    if (norm === "_bmad/scripts" || norm.startsWith("_bmad/scripts/")) {
      scriptEntries.set(rel, entry);
    }
    if (
      norm === "_bmad/g33"
      || norm.startsWith("_bmad/g33/")
      || norm === "_bmad/config.yaml"
    ) {
      companionEntries.set(rel, entry);
    }
    if (norm.startsWith(".agents/skills/bmad-") && (entry.kind === "file" || entry.kind === "link")) {
      const parts = norm.split("/");
      const skill = parts[2] ?? "";
      const relInSkill = parts.slice(3).join("/");
      if (!skill || !relInSkill) continue;
      let customized = false;
      const moduleDir = sourceMap.get(skill);
      if (entry.kind === "link") {
        customized = true;
      } else {
        if (moduleDir) {
          const sourceEntry = backup.get(join(...moduleDir.split("/"), ...relInSkill.split("/")));
          if (sourceEntry?.kind !== "file" || !sourceEntry.bytes.equals(entry.bytes) || sourceEntry.mode !== entry.mode) {
            customized = true;
          }
        }
        if (!customized && claudeSkillsIsRealDir) {
          const claudeEntry = backup.get(join(".claude", "skills", skill, ...relInSkill.split("/")));
          if (claudeEntry?.kind !== "file" || !claudeEntry.bytes.equals(entry.bytes) || claudeEntry.mode !== entry.mode) {
            customized = true;
          }
        }
        if (!customized && !moduleDir && !claudeSkillsIsRealDir) {
          const text = entry.bytes.toString("utf8").replace(/\r\n/g, "\n");
          if (
            relInSkill !== "SKILL.md"
            || !text.startsWith(`---\nname: ${skill}\n`)
            || (entry.mode !== 0o644 && entry.mode !== 0o664)
          ) {
            customized = true;
          }
        }
      }
      if (customized) {
        operatorNativeSkills.set(rel, entry);
      }
    }
  }

  return {
    backup,
    hadManifestG33: options.hadManifestG33,
    hadTomlG33: options.hadTomlG33,
    customEntries,
    operatorCustomEntries,
    scriptEntries,
    companionEntries,
    operatorNativeSkills,
  };
}

export function restoreProtectedBmadStateBeforeCompanion(projectRoot: string, state: ProtectedBmadState): void {
  const root = resolve(projectRoot);
  const applyGroup = (entries: Map<string, TreeBackupEntry>, onlyIfMissing = false) => {
    const sorted = [...entries.entries()].sort(([a, entryA], [b, entryB]) => {
      if (entryA.kind === "dir" && entryB.kind !== "dir") return -1;
      if (entryA.kind !== "dir" && entryB.kind === "dir") return 1;
      return a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b);
    });
    for (const [rel, entry] of sorted) {
      if (onlyIfMissing && localEntryPresent(join(root, rel))) continue;
      restoreSingleEntry(root, rel, entry);
    }
  };
  applyGroup(state.customEntries);
  applyGroup(state.scriptEntries, true);
  applyGroup(state.companionEntries);
  applyGroup(state.operatorNativeSkills);

  if (state.hadManifestG33) {
    const manifestPath = join(root, "_bmad", "_config", "manifest.yaml");
    if (existsSync(manifestPath)) {
      const text = readFileSync(manifestPath, "utf8");
      if (!/^\s*-\s*name:\s*g33\s*$/m.test(text)) {
        writeFileSync(manifestPath, `${text.endsWith("\n") ? text : `${text}\n`}  - name: g33\n`);
      }
    }
  }
  if (state.hadTomlG33) {
    const tomlPath = join(root, "_bmad", "config.toml");
    if (existsSync(tomlPath)) {
      const text = readFileSync(tomlPath, "utf8");
      if (!/^\[modules\.g33\]\s*$/m.test(text)) {
        writeFileSync(tomlPath, `${text.endsWith("\n") ? text : `${text}\n`}\n[modules.g33]\n`);
      }
    }
  }
}

export function verifyProtectedBmadStateAfterCompanion(projectRoot: string, state: ProtectedBmadState): string[] {
  const root = resolve(projectRoot);
  const violations: string[] = [];
  const checkEntry = (rel: string, expected: TreeBackupEntry, label: string) => {
    const full = join(root, rel);
    let stat;
    try { stat = lstatSync(full); }
    catch {
      violations.push(`${label} missing after update: ${rel}`);
      return;
    }
    if (expected.kind === "link") {
      if (!stat.isSymbolicLink() || readlinkSync(full) !== expected.target) {
        violations.push(`${label} symlink target changed: ${rel}`);
      }
      return;
    }
    if (expected.kind === "dir") {
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== expected.mode) {
        violations.push(`${label} directory mode changed: ${rel}`);
      }
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      violations.push(`${label} is no longer a regular file: ${rel}`);
      return;
    }
    if ((stat.mode & 0o7777) !== expected.mode || !readFileSync(full).equals(expected.bytes)) {
      violations.push(`${label} bytes or mode changed: ${rel}`);
    }
  };
  for (const [rel, entry] of state.operatorCustomEntries.entries()) {
    checkEntry(rel, entry, "Protected operator custom entry");
  }
  for (const [rel, entry] of state.operatorNativeSkills.entries()) {
    checkEntry(rel, entry, "Protected operator native BMAD skill");
  }
  return violations;
}

/**
 * Roll back without letting a restore failure mask the error that caused it.
 * An incomplete rollback reports what it left behind instead of claiming none.
 */
function rollbackTree(root: string, backup: TreeBackup, before: ReturnType<typeof snapshotTree>): { details: string[]; changedFiles: string[] } {
  try {
    restoreTreeBackup(root, backup);
    return { details: [], changedFiles: [] };
  } catch (error) {
    const details = [`rollback incomplete; recover with git: ${error instanceof Error ? error.message : String(error)}`];
    try { return { details, changedFiles: changedTreePaths(root, before, snapshotTree(root)) }; }
    catch (snapshotError) { return { details: [...details, `Could not inventory unrestored paths: ${String(snapshotError)}`], changedFiles: [] }; }
  }
}

export interface BmadUpdateWithPreservationResult {
  ok: boolean;
  error?: string;
  details: string[];
  changedFiles: string[];
  companion: CompanionResult;
}

export async function runBmadUpdateWithCompanionPreservation(
  projectRoot: string,
  options: {
    hadManifestG33: boolean;
    hadTomlG33: boolean;
    beforeInstall?: () => Promise<{ changedFiles?: string[]; details?: string[] }> | { changedFiles?: string[]; details?: string[] };
    runInstaller: () => { ok: boolean; error?: string };
  },
): Promise<BmadUpdateWithPreservationResult> {
  const root = resolve(projectRoot);
  const preflight = await runG33Companion(root, true, "bmad-install");
  if (!["planned", "unchanged"].includes(preflight.status)) {
    return {
      ok: false,
      error: preflight.summary,
      details: companionDetails(preflight),
      changedFiles: [],
      companion: preflight,
    };
  }
  const beforeSnapshot = snapshotTree(root);
  const state = captureProtectedBmadState(root, {
    hadManifestG33: options.hadManifestG33,
    hadTomlG33: options.hadTomlG33,
  });
  let preDetails: string[] = [];
  try {
    if (options.beforeInstall) {
      const pre = await options.beforeInstall();
      preDetails = pre.details ?? [];
    }
    const install = options.runInstaller();
    if (!install.ok) {
      const rollback = rollbackTree(root, state.backup, beforeSnapshot);
      return {
        ok: false,
        error: install.error ?? "Failed to run bmad-method install",
        details: [install.error ?? "Unknown error", ...rollback.details],
        changedFiles: rollback.changedFiles,
        companion: preflight,
      };
    }
    restoreProtectedBmadStateBeforeCompanion(root, state);
    const companion = await runG33Companion(root, false, "bmad-install", { allowPostUpdateConflictPlan: true });
    const violations = verifyProtectedBmadStateAfterCompanion(root, state);
    if (!["changed", "unchanged"].includes(companion.status) || !companion.evidence.length || violations.length) {
      const rollback = rollbackTree(root, state.backup, beforeSnapshot);
      const failedCompanion: CompanionResult = violations.length && ["changed", "unchanged"].includes(companion.status)
        ? {
            ...companion,
            status: "error",
            summary: "Post-update preservation verification failed",
            details: [...companion.details, ...violations],
            changedFiles: [],
          }
        : { ...companion, changedFiles: [] };
      return {
        ok: false,
        error: failedCompanion.summary,
        details: [...companionDetails(failedCompanion), ...rollback.details],
        changedFiles: rollback.changedFiles,
        companion: failedCompanion,
      };
    }
    const totalChanged = changedTreePaths(root, beforeSnapshot, snapshotTree(root));
    return {
      ok: true,
      details: [...preDetails, ...companionDetails(companion)],
      changedFiles: totalChanged,
      companion,
    };
  } catch (error) {
    const rollback = rollbackTree(root, state.backup, beforeSnapshot);
    const failedCompanion: CompanionResult = {
      schemaVersion: 1,
      moduleId: "g33",
      optional: true,
      status: "error",
      summary: "BMAD update with g33 preservation failed",
      details: [error instanceof Error ? error.message : String(error), ...rollback.details],
      evidence: [],
      changedFiles: [],
      ...(preflight.adapter ? { adapter: preflight.adapter } : {}),
    };
    return {
      ok: false,
      error: failedCompanion.summary,
      details: companionDetails(failedCompanion),
      changedFiles: rollback.changedFiles,
      companion: failedCompanion,
    };
  }
}

export function companionDetails(result: CompanionResult): string[] {
  return [`g33 (${result.status}): ${result.summary}`, ...result.details, ...result.evidence];
}

export function createG33CompanionCheck(): RecipeOwnedCheck {
  const id = "bmad.g33-companion", title = "Optional g33 companion";
  return {
    id, title,
    audit: async (ctx) => {
      // One rule with enrollment, evaluated read-only: an eligible project with no
      // adapter is a fixable warn. An unreadable manifest falls through to the
      // companion audit, which reports it in its own words.
      let verdict: G33Enrollability | undefined;
      try { verdict = await g33Enrollability(ctx); } catch { /* reported by the companion audit below */ }
      if (verdict?.enrollable) {
        const problem = await g33CatalogProblem(ctx);
        if (problem) return {
          id, title, status: "warn", summary: `g33 enrollable but not enrollable on this host: ${verdict.reason}`, fixable: false,
          details: [problem, `Fix the catalog on this machine, then run pj migrate ${id}. ${enrollRetry()}`],
        };
        return {
          id, title, status: "warn", summary: `g33 enrollable: ${verdict.reason}`, fixable: true,
          details: [`Run pj migrate ${id} to activate ${G33_SKILL} and write bmad.companion.adapter, then install the companion.`],
        };
      }
      // Read-only observation and planning remain independent of application.
      const result = await runG33Companion(ctx.repoRoot, true, "audit");
      return {
        id, title,
        status: result.status === "disabled" ? "skip" : result.status === "unchanged" && result.evidence.length ? "pass" : "warn",
        summary: result.summary, details: companionDetails(result), fixable: result.status === "planned",
      };
    },
    migrate: async (ctx, finding) => {
      const enrollment = await enrollG33Companion(ctx);
      const enrolled = enrollmentDetails(enrollment);
      const base = { id: finding.id, title: finding.title };
      if (enrollment.status === "error") return {
        ...base, status: enrollment.changedFiles.length ? "partial" : "blocked",
        summary: `g33 enrollment failed: ${enrollment.summary}`, details: enrolled, changedFiles: enrollment.changedFiles,
      };
      // The adapter is written only on a real run, so a preview has no companion to plan yet.
      if (enrollment.status === "planned") return {
        ...base, status: "applied", summary: enrollment.summary, changedFiles: [],
        details: [...enrolled, "The companion plan follows enrollment; no adapter is configured until then."],
      };
      const result = await runG33Companion(ctx.repoRoot, ctx.dryRun, "repair");
      const changedFiles = [...new Set([...enrollment.changedFiles, ...result.changedFiles])].sort();
      const details = [...enrolled, ...companionDetails(result)];
      const wrote = enrollment.status === "enrolled";
      // Postcondition: a real run claims success only on owner-proven installation.
      const proven = (result.status === "changed" || result.status === "unchanged") && result.evidence.some((item) => item.trim());
      const status: MigrationRuleResult["status"] = result.status === "disabled" ? "skipped"
        : ctx.dryRun ? (result.status === "planned" ? "applied" : result.status === "unchanged" ? "noop" : "partial")
        : !proven ? "partial"
        : result.status === "changed" || wrote ? "applied" : "noop";
      return { ...base, status, summary: result.summary, details, changedFiles };
    },
  };
}
