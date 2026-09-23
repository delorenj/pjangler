import { lstatSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  initScope,
  inspectStatus,
  readActivationReceipt,
  readSelectionManifest,
  resolveSelection,
  sync,
  type Diagnostic,
  type ResolvedBinding,
  type SyncOptions,
} from "@delorenj/skillex";
import type { AuditFinding, Context } from "./rules";
import { planSkillRoots, repoOwnsPath, skillRootsSummary, SUPPORTED_SKILLS_ALIASES, treesIdentical, type SkillRootIncoming } from "./skill-roots";
import { shellQuotePath } from "../skills/cli";

/** The bundled Skillex CLI, as an operator types it (src/skills/cli.ts). */
export const PJ_SKILLS = "pj skills";

/** Every caller supplies its subject; nested cwd never changes project selection. */
export function skillCoreOptions(ctx: Context): SyncOptions & { scope: "project"; project: string } {
  return {
    cwd: resolve(ctx.repoRoot),
    project: resolve(ctx.repoRoot),
    scope: "project",
    home: ctx.homeDir,
    env: process.env,
    // Preserve the documented PJangler override while using one core resolver.
    ...(process.env.PJ_SKILLS_REGISTRY_ROOT?.trim()
      ? { registryRoot: resolve(process.env.PJ_SKILLS_REGISTRY_ROOT.trim()) }
      : {}),
  };
}

/**
 * PJAN-135: the core's fix text says "Run skillex <command>". On an operator
 * shell bare `skillex` may be the retired Python CLI (no `migrate`, and a
 * `sync` that runs the old reconciler) or nothing at all, so every skillex
 * command pjangler relays is renamed to the bundled passthrough, which is the
 * same version that produced the finding.
 */
export function relaySkillexCommands(text: string): string {
  return text.replace(SKILLEX_COMMAND, PJ_SKILLS);
}

/** `skillex <subcommand>` as a command, never a path (`state/skillex/`) or package (`@delorenj/skillex`). */
const SKILLEX_COMMAND = /(?<![\w/@.:-])skillex(?=\s+(?:skill|set|pack|init|enable|disable|inherit|sync|status|explain|doctor|vendor|profile|migrate)\b)/g;

export function skillDiagnostics(findings: readonly Diagnostic[]): string[] {
  return findings.map((finding) =>
    `${finding.code}: ${finding.message}${finding.path ? ` (${finding.path})` : ""}${finding.fix ? ` — ${relaySkillexCommands(finding.fix)}` : ""}`,
  );
}

/**
 * The operator remedy for a refused skills plan. It names only commands that
 * exist wherever pj runs (tests/pjan-135-guidance-commands-regressions.mjs runs
 * each one against the real CLI).
 */
export function migrationGuidance(ctx: Context): string {
  const project = `--project ${shellQuotePath(resolve(ctx.repoRoot))}`;
  return "Legacy selections or skill-root content need explicit review. "
    + `Preview: ${PJ_SKILLS} migrate ${project}. `
    + `Apply the reviewed plan: ${PJ_SKILLS} migrate ${project} --apply (add --mapping <file> only for content the preview reports as ambiguous). `
    + "PJangler relocates CLI-root skill entries losslessly into .agents/skills so each root can become the alias, "
    + "but never claims ownership of foreign or installer-owned skills and never deletes content that is not a proven duplicate.";
}

/** Both spellings of a project path skillex may report: as given and physical. */
function projectPaths(ctx: Context, rel: string): Set<string> {
  const paths = new Set([join(resolve(ctx.repoRoot), rel)]);
  try { paths.add(join(realpathSync(ctx.repoRoot), rel)); } catch { /* keep the lexical form */ }
  return paths;
}

type ActivationConflict = { kind: "alias" | "root"; path: string; name: string };

/**
 * skillex refuses at the FIRST activation conflict and reports only that one.
 * Two shapes are recoverable here: a CLI alias (converted by the skill-roots
 * planner) and a direct child of `.agents/skills` that collides with a selected
 * catalog skill (resolved one at a time by the sync loop below).
 */
function activationConflict(ctx: Context, findings: readonly Diagnostic[]): ActivationConflict | undefined {
  const finding = findings.find((item) => item.code === "E_ACTIVATION_CONFLICT" && item.path);
  if (!finding?.path) return undefined;
  const aliases = new Set(SUPPORTED_SKILLS_ALIASES.flatMap((alias) => [...projectPaths(ctx, alias)]));
  if (aliases.has(finding.path)) return { kind: "alias", path: finding.path, name: basename(dirname(finding.path)) };
  if (projectPaths(ctx, join(".agents", "skills")).has(dirname(finding.path)) && /collides with foreign activation content/.test(finding.message)) {
    return { kind: "root", path: finding.path, name: basename(finding.path) };
  }
  return undefined;
}

/** The project scope's resolved bindings (selected catalog skills), in skillex's order. */
async function projectBindings(ctx: Context): Promise<readonly ResolvedBinding[]> {
  const resolution = await resolveSelection(skillCoreOptions(ctx));
  const scopes = resolution.data?.scopes ?? [];
  const scope = scopes.find((item) => item.scope === "project") ?? scopes[scopes.length - 1];
  return scope?.bindings ?? [];
}

async function canonicalSkillPath(ctx: Context, name: string): Promise<string | undefined> {
  return (await projectBindings(ctx)).find((binding) => binding.name === name)?.path;
}

export interface RootCollisionDecision {
  action: "unlink" | "block";
  detail: string;
}

/**
 * PJAN-135 (B): may this `.agents/skills/<name>` entry make way for the selected
 * catalog skill of the same name?
 *
 * Only a symlink is ever removed, and unlinking a link never removes what it
 * points at. A dangling link, or one into another repository (a 33GOD component
 * checkout, an old registry path), is a legacy projection: replace it. A link to
 * this repository's OWN content is a deliberate local override unless that
 * content is byte-identical to the catalog skill. A real directory is never
 * touched.
 */
export async function classifyRootCollision(ctx: Context, path: string): Promise<RootCollisionDecision> {
  const label = relative(resolve(ctx.repoRoot), path) || path;
  let stat;
  try { stat = lstatSync(path); } catch { return { action: "block", detail: `${label} disappeared while resolving a root collision` }; }
  if (!stat.isSymbolicLink()) return realEntryCollision(label, basename(path), stat.isDirectory());
  let real: string | undefined;
  try { real = realpathSync(path); } catch { real = undefined; }
  return classifyCollidingLink(ctx, basename(path), label, readlinkSync(path), real);
}

function realEntryCollision(label: string, name: string, directory: boolean): RootCollisionDecision {
  return { action: "block", detail: `${label} is a real ${directory ? "directory" : "entry"} that collides with the selected catalog skill ${name}; move or rename it, pjangler never removes real content` };
}

/** A colliding link, by what it resolves to (`real`, a path that exists now; undefined when it dangles). */
async function classifyCollidingLink(ctx: Context, name: string, label: string, text: string, real: string | undefined): Promise<RootCollisionDecision> {
  if (real === undefined) return { action: "unlink", detail: `replaced legacy link ${label} -> ${text} (dangling)` };
  if (!repoOwnsPath(ctx.repoRoot, real)) return { action: "unlink", detail: `replaced legacy link ${label} -> ${text}` };
  const canonical = await canonicalSkillPath(ctx, name);
  if (canonical && treesIdentical(real, canonical)) {
    return { action: "unlink", detail: `replaced link ${label} -> ${text}: its repo-owned content is identical to the catalog skill` };
  }
  return { action: "block", detail: `repo-owned skill ${name} shadows a selected catalog skill (${label} -> ${text}); rename it or make it identical to the catalog copy` };
}

/** Activation paths the project's skillex receipt owns (skillex replaces those itself). */
async function receiptOwnedLinks(ctx: Context): Promise<Set<string>> {
  try {
    const snapshot = await readActivationReceipt<{ links?: Record<string, unknown> }>(realpathSync(ctx.repoRoot), { home: ctx.homeDir, env: process.env });
    return new Set(Object.keys(snapshot.document?.data?.links ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * The project's current skillex activations: the paths its activation receipt
 * owns and the physical paths of the selected catalog skills. Other rules use
 * it to tell a live activation from retired state (never evict the former).
 */
export async function currentSkillActivations(ctx: Context): Promise<{ owned: string[]; targets: string[] }> {
  const owned = [...await receiptOwnedLinks(ctx)];
  let targets: string[] = [];
  try {
    targets = (await projectBindings(ctx)).flatMap((binding) => [binding.path, realpathOf(binding.path)].filter((path): path is string => Boolean(path)));
  } catch { /* no resolvable selection: nothing is selected */ }
  return { owned, targets };
}

function realpathOf(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

/**
 * PJAN-135 (dry run): every `.agents/skills/<name>` the sync would refuse once
 * the CLI skills-root plan has run, classified exactly as apply's collision loop
 * classifies them. skillex's own preview stops at its first refusal (and before
 * the root conversion it stops at the unconverted alias), so a preview that
 * trusts it reports `applied` for a run that ends partial.
 *
 * Mirrors skillex's rule: a selected name is fine when its entry is absent, is
 * a link resolving to the catalog skill, or is owned by the activation receipt
 * (skillex replaces it); anything else collides. An entry the plan moves in is
 * new, so no receipt owns it.
 */
async function predictRootCollisions(ctx: Context, incoming: readonly SkillRootIncoming[]): Promise<{ path: string; decision: RootCollisionDecision }[]> {
  const root = join(resolve(ctx.repoRoot), ".agents", "skills");
  const physicalRoot = join(realpathOf(ctx.repoRoot) ?? resolve(ctx.repoRoot), ".agents", "skills");
  const planned = new Map(incoming.map((entry) => [entry.name, entry]));
  const owned = await receiptOwnedLinks(ctx);
  const predictions: { path: string; decision: RootCollisionDecision }[] = [];
  for (const binding of await projectBindings(ctx)) {
    const path = join(root, binding.name);
    const label = relative(resolve(ctx.repoRoot), path);
    const catalog = new Set([binding.path, realpathOf(binding.path)].filter(Boolean));
    const entry = planned.get(binding.name);
    if (entry) {
      if (entry.kind !== "link") { predictions.push({ path, decision: realEntryCollision(label, binding.name, entry.kind === "directory") }); continue; }
      const real = entry.resolves === undefined ? undefined : realpathOf(entry.resolves);
      if (real !== undefined && catalog.has(real)) continue;
      predictions.push({ path, decision: await classifyCollidingLink(ctx, binding.name, label, entry.text ?? "", real) });
      continue;
    }
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink() && catalog.has(realpathOf(path))) continue;
    if (owned.has(join(physicalRoot, binding.name)) || owned.has(path)) continue;
    predictions.push({ path, decision: await classifyRootCollision(ctx, path) });
  }
  return predictions;
}

export async function auditProjectSkills(ctx: Context): Promise<AuditFinding> {
  const result = await inspectStatus(skillCoreOptions(ctx));
  const details = skillDiagnostics(result.findings);
  details.push(...(result.data?.changes ?? []).map((change) => `${change.action}: ${change.path}`));
  // status stops at the first conflict, so the CLI skills roots are planned
  // independently: every alias, every block, whatever skillex happened to hit.
  const plan = planSkillRoots(ctx.repoRoot);
  details.push(...skillRootsSummary(plan));
  const conflict = activationConflict(ctx, result.findings);
  let conflictResolvable = false;
  if (conflict?.kind === "alias") conflictResolvable = plan.clean;
  if (conflict?.kind === "root") {
    // Every collision, not just the one skillex stopped at: migrate replaces
    // links only when none of them blocks.
    const predictions = await predictRootCollisions(ctx, []);
    conflictResolvable = predictions.length > 0 && predictions.every(({ decision }) => decision.action !== "block");
    for (const { decision } of predictions) {
      details.push(decision.action === "block" ? `blocked: ${decision.detail}`
        : `resolvable root collision: ${decision.detail.replace(/^replaced/, "replace")}`);
    }
  }
  if (result.exit === 2 || result.exit === 3) details.push(migrationGuidance(ctx));
  return {
    id: "skills.project-manifest",
    title: "Skillex project skills",
    status: result.exit === 0 ? "pass" : result.exit === 4 ? "warn" : "fail",
    summary: result.exit === 0 ? "Skillex declaration and activation are in parity" : `Skillex inspection returned exit ${result.exit}`,
    details,
    fixable: result.exit === 0 || result.exit === 6 || conflictResolvable
      || result.findings.some((finding) => finding.code === "E_NO_PROJECT_MANIFEST"),
  };
}

export interface SkillSynchronization {
  ok: boolean;
  changedFiles: string[];
  details: string[];
}

/** Hard cap on root-collision rounds; each round is one full core sync plan. */
const MAX_ROOT_COLLISION_ROUNDS = 256;

export interface SkillSynchronizationOptions {
  /**
   * Dry run only: relative CLI aliases (".claude/skills") the caller's plan
   * converts before the sync, so a preview refusal at one of them is the
   * pre-conversion state, not a blocker.
   */
  pendingAliases?: readonly string[];
  /** Dry run only: the entries that plan moves into `.agents/skills` (SkillRootsPlan.incoming). */
  incoming?: readonly SkillRootIncoming[];
}

/**
 * The public core owns manifests, receipts, alias publication and pruning.
 * PJangler only clears legacy links that collide with a selected skill
 * (classifyRootCollision), one refusal at a time, and never adopts anything.
 */
export async function synchronizeProjectSkills(ctx: Context, extra: SkillSynchronizationOptions = {}): Promise<SkillSynchronization> {
  const options = skillCoreOptions(ctx);
  const changedFiles: string[] = [];
  if (ctx.acceptRegistryMatches) return { ok: false, changedFiles,
    details: ["--accept-registry-matches is retired. " + migrationGuidance(ctx)] };
  const details: string[] = [];
  try {
    const declaration = await readSelectionManifest(options.project);
    if (!declaration.exists) {
      const initialized = await initScope({ ...options, dryRun: Boolean(ctx.dryRun) });
      details.push(...skillDiagnostics(initialized.findings));
      changedFiles.push(...(ctx.dryRun ? initialized.data?.changes ?? [] : initialized.data?.applied ?? []).map((change) => change.path));
      if (!initialized.ok) return { ok: false, changedFiles, details };
      // init is deliberately manifest-only. A preview cannot fabricate a saved
      // manifest for sync; show this boundary explicitly and never write it.
      if (ctx.dryRun) {
        details.push("Create the initial project manifest, then reconcile its global inheritance with the public core.");
        return { ok: true, changedFiles: [...new Set(changedFiles)], details };
      }
    }
    const unlinked = new Set<string>();
    for (let round = 0; ; round++) {
      const result = await sync({ ...options, dryRun: Boolean(ctx.dryRun) });
      const conflict = result.ok ? undefined : activationConflict(ctx, result.findings);
      const deferred = conflict?.kind === "alias"
        && (extra.pendingAliases ?? []).some((alias) => projectPaths(ctx, alias).has(conflict.path));
      if (conflict?.kind === "root" || (ctx.dryRun && deferred)) {
        // Every collision is classified before ANY link is replaced: skillex
        // refuses the whole plan at its first refusal, so replacing the
        // resolvable ones while another blocks only hides those names until the
        // blocker is resolved. A preview sees the same set, including the
        // entries the planned root conversion moves in.
        if (deferred) details.push(`Sync preview deferred: ${conflict!.path} is converted to the .agents/skills alias first; the root collisions that conversion introduces are classified here.`);
        const predictions = await predictRootCollisions(ctx, ctx.dryRun ? extra.incoming ?? [] : []);
        const blocking = predictions.filter(({ decision }) => decision.action === "block");
        const replaceable = predictions.filter(({ decision }) => decision.action === "unlink");
        if (blocking.length) {
          details.push(...blocking.map(({ decision }) => `blocked: ${decision.detail}`));
          if (replaceable.length) details.push(`left in place until the blocked collision(s) above are resolved: ${replaceable.map(({ path }) => relative(resolve(ctx.repoRoot), path)).join(", ")}`);
          details.push(migrationGuidance(ctx));
          return { ok: false, changedFiles: [...new Set(changedFiles)], details };
        }
        if (ctx.dryRun) {
          for (const { path, decision } of replaceable) {
            changedFiles.push(path);
            details.push(`would ${decision.detail.replace(/^replaced/, "replace")}`);
          }
          return { ok: true, changedFiles: [...new Set(changedFiles)], details };
        }
        const fresh = replaceable.filter(({ path }) => !unlinked.has(path));
        if (fresh.length && round < MAX_ROOT_COLLISION_ROUNDS) {
          for (const { path, decision } of fresh) {
            unlinkSync(path);
            unlinked.add(path);
            changedFiles.push(path);
            details.push(decision.detail);
          }
          continue;
        }
        details.push(round >= MAX_ROOT_COLLISION_ROUNDS ? `stopped after ${MAX_ROOT_COLLISION_ROUNDS} root collision rounds`
          : `no progress: ${conflict?.path ?? "a root collision"} collided again after every classified link was replaced`);
      }
      const changes = ctx.dryRun ? result.data?.changes : result.data?.applied;
      changedFiles.push(...(changes ?? []).map((change) => change.path));
      details.push(...skillDiagnostics(result.findings));
      if (!result.ok) details.push(migrationGuidance(ctx));
      return { ok: result.ok, changedFiles: [...new Set(changedFiles)], details };
    }
  } catch (error) {
    const findings = error && typeof error === "object" && "findings" in error
      ? (error as { findings: readonly Diagnostic[] }).findings
      : [];
    details.push(...skillDiagnostics(findings));
    if (!findings.length) details.push(error instanceof Error ? error.message : String(error));
    details.push(migrationGuidance(ctx));
    return { ok: false, changedFiles, details };
  }
}
