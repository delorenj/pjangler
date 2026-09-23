import { lstatSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  initScope,
  inspectStatus,
  readSelectionManifest,
  resolveSelection,
  sync,
  type Diagnostic,
  type SyncOptions,
} from "@delorenj/skillex";
import type { AuditFinding, Context } from "./rules";
import { planSkillRoots, repoOwnsPath, skillRootsSummary, SUPPORTED_SKILLS_ALIASES, treesIdentical } from "./skill-roots";
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

async function canonicalSkillPath(ctx: Context, name: string): Promise<string | undefined> {
  const resolution = await resolveSelection(skillCoreOptions(ctx));
  const scopes = resolution.data?.scopes ?? [];
  const scope = scopes.find((item) => item.scope === "project") ?? scopes[scopes.length - 1];
  return scope?.bindings.find((binding) => binding.name === name)?.path;
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
  const name = basename(path);
  const label = relative(resolve(ctx.repoRoot), path) || path;
  let stat;
  try { stat = lstatSync(path); } catch { return { action: "block", detail: `${label} disappeared while resolving a root collision` }; }
  if (!stat.isSymbolicLink()) {
    return { action: "block", detail: `${label} is a real ${stat.isDirectory() ? "directory" : "entry"} that collides with the selected catalog skill ${name}; move or rename it, pjangler never removes real content` };
  }
  const text = readlinkSync(path);
  let real: string | undefined;
  try { real = realpathSync(path); } catch { real = undefined; }
  if (real === undefined) return { action: "unlink", detail: `replaced legacy link ${label} -> ${text} (dangling)` };
  if (!repoOwnsPath(ctx.repoRoot, real)) return { action: "unlink", detail: `replaced legacy link ${label} -> ${text}` };
  const canonical = await canonicalSkillPath(ctx, name);
  if (canonical && treesIdentical(real, canonical)) {
    return { action: "unlink", detail: `replaced link ${label} -> ${text}: its repo-owned content is identical to the catalog skill` };
  }
  return { action: "block", detail: `repo-owned skill ${name} shadows a selected catalog skill (${label} -> ${text}); rename it or make it identical to the catalog copy` };
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
    const decision = await classifyRootCollision(ctx, conflict.path);
    conflictResolvable = decision.action !== "block";
    details.push(decision.action === "block" ? `blocked: ${decision.detail}`
      : `resolvable root collision: ${decision.detail.replace(/^replaced/, "replace")}; further collisions may follow`);
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
      if (conflict?.kind === "root") {
        const decision = await classifyRootCollision(ctx, conflict.path);
        if (decision.action === "unlink" && ctx.dryRun) {
          changedFiles.push(conflict.path);
          details.push(`would ${decision.detail.replace(/^replaced/, "replace")}`,
            "More root collisions may follow; the sync preview stops at the first one.");
          return { ok: true, changedFiles: [...new Set(changedFiles)], details };
        }
        if (decision.action === "unlink" && !unlinked.has(conflict.path) && round < MAX_ROOT_COLLISION_ROUNDS) {
          unlinkSync(conflict.path);
          unlinked.add(conflict.path);
          changedFiles.push(conflict.path);
          details.push(decision.detail);
          continue;
        }
        details.push(decision.action === "block" ? `blocked: ${decision.detail}`
          : unlinked.has(conflict.path) ? `no progress: ${conflict.path} collided again after it was replaced`
            : `stopped after ${MAX_ROOT_COLLISION_ROUNDS} root collision rounds`);
      }
      if (!result.ok && conflict?.kind === "alias" && ctx.dryRun
        && (extra.pendingAliases ?? []).some((alias) => projectPaths(ctx, alias).has(conflict.path))) {
        details.push(`Sync preview deferred: ${conflict.path} is converted to the .agents/skills alias first; root collisions the conversion introduces are resolved during apply.`);
        return { ok: true, changedFiles: [...new Set(changedFiles)], details };
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
