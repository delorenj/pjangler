import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  initScope,
  inspectStatus,
  withLock,
  writeSelectionManifest,
  readActivationReceipt,
  readSelectionManifest,
  resolveSelection,
  sync,
  writeActivationReceipt,
  type Diagnostic,
  type ResolvedBinding,
  type SyncOptions,
} from "@delorenj/skillex";
import type { AuditFinding, Context } from "./rules";
import { planSkillRoots, repoOwnsPath, skillContentIdentical, skillRootsSummary, SUPPORTED_SKILLS_ALIASES, type SkillRootIncoming } from "./skill-roots";
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
const SKILLEX_COMMAND = /(?<![\w/@.:-])skillex(?=\s+(?:skill|set|pack|bmad|init|enable|disable|inherit|normalize|sync|status|explain|doctor|vendor|profile|migrate|integrations|clients|root)\b)/g;

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
  /** exclude: mask the inherited binding in the project manifest (PJAN-176). */
  action: "unlink" | "block" | "exclude";
  detail: string;
}

/**
 * PJAN-176: the skills bmad-method installed into this project. The installer
 * writes each one as a real directory under `.agents/skills` and records it in
 * `_bmad/_config/skill-manifest.csv`. The global selection inherits the same
 * names from the Skillex `bmad` pack, so skillex saw foreign content under a
 * selected name and refused every project with BMAD installed (and rolled back
 * every real `pj init`). The installed copy IS the project's copy of that skill:
 * it satisfies the selection, which pjangler records by excluding the inherited
 * binding. Only a real directory with a SKILL.md that the installer manifest
 * lists qualifies; links, files, and unlisted directories keep their verdicts.
 */
export function bmadInstalledSkills(repoRoot: string): Set<string> {
  const installed = new Set<string>();
  let text: string;
  try { text = readFileSync(join(resolve(repoRoot), "_bmad", "_config", "skill-manifest.csv"), "utf8"); }
  catch { return installed; }
  const [header, ...rows] = text.replace(/\r\n/g, "\n").split("\n");
  if (!/^"?canonicalId"?,/.test(header ?? "")) return installed;
  for (const row of rows) {
    const name = /^"?([^",]+)"?,/.exec(row)?.[1];
    if (!name || name.includes("/") || name.startsWith(".")) continue;
    const dir = join(resolve(repoRoot), ".agents", "skills", name);
    try {
      const stat = lstatSync(dir);
      if (stat.isDirectory() && !stat.isSymbolicLink() && existsSync(join(dir, "SKILL.md"))) installed.add(name);
    } catch { /* not installed here */ }
  }
  return installed;
}

function bmadInstallerCopy(label: string, name: string): RootCollisionDecision {
  return { action: "exclude", detail: `${label} is the bmad-method installer's copy of ${name}; the project selection excludes the inherited ${name}` };
}

/** skillex's activation ownership lock, the resource its own selection edits and syncs take. */
const ACTIVATION_LOCK = "skillex:activation:v2";

/** True when `path` is `.agents/skills/<name>` (either spelling) for an installer-owned name. */
function installerSkillPath(ctx: Context, path: string, installed: ReadonlySet<string>): boolean {
  return installed.has(basename(path)) && projectPaths(ctx, join(".agents", "skills")).has(dirname(path));
}

/** A skillex refusal that only the BMAD installer's copy of a selected skill causes. */
function installerOwnedFinding(ctx: Context, finding: Diagnostic, installed: ReadonlySet<string>): boolean {
  return (finding.code === "E_OWNERSHIP_CHANGED" || finding.code === "E_ACTIVATION_CONFLICT")
    && Boolean(finding.path) && installerSkillPath(ctx, finding.path!, installed);
}

export interface InstallerSkillHandoff {
  /** Selected names now excluded from the project selection. */
  excluded: string[];
  /** Earlier handoff exclusions withdrawn because the installer no longer provides the skill. */
  restored: string[];
  /** Receipt claims dropped on links the installer replaced with real content. */
  released: string[];
  /** Why nothing was handed off when something could have been. */
  skipped?: string;
  changedFiles: string[];
}

/**
 * Which exclusions pjangler itself wrote. The manifest schema has no room for
 * provenance, and an exclusion pjangler wrote is indistinguishable from an
 * operator's, so the handoff keeps its own record (host state, beside skillex's
 * receipts) and only ever withdraws names it recorded.
 */
function handoffRecordPath(ctx: Context): string {
  const stateHome = process.env.XDG_STATE_HOME?.trim() || join(ctx.homeDir || homedir(), ".local", "state");
  const key = createHash("sha256").update(realpathOf(ctx.repoRoot) ?? resolve(ctx.repoRoot)).digest("hex");
  return join(stateHome, "pjangler", "skill-handoffs", `${key}.json`);
}

function readHandoffRecord(ctx: Context): string[] {
  try {
    const value = JSON.parse(readFileSync(handoffRecordPath(ctx), "utf8")) as { excluded?: unknown };
    return Array.isArray(value.excluded) ? value.excluded.filter((name): name is string => typeof name === "string") : [];
  } catch { return []; }
}

function writeHandoffRecord(ctx: Context, names: readonly string[]): void {
  const path = handoffRecordPath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ project: realpathOf(ctx.repoRoot) ?? resolve(ctx.repoRoot), excluded: [...new Set(names)].sort() }, null, 2)}\n`);
  renameSync(temporary, path);
}

/** A project-scope selection of `name` that is not inheritance: the operator asked for it here. */
function explicitlySelected(binding: ResolvedBinding | undefined): boolean {
  return Boolean(binding?.origins.some((origin) => origin.scope === "project" && origin.kind !== "inherit"));
}

/**
 * PJAN-176: hand BMAD-installed skills over from Skillex, under skillex's own
 * activation lock so a concurrent sync never interleaves:
 *
 * - the project manifest's `exclude` gains every INHERITED selected name the
 *   installer provides (a name the project selects explicitly is the
 *   operator's call and keeps colliding), and loses a name pjangler excluded
 *   earlier once the installer stops providing it, so the catalog skill comes
 *   back; operator exclusions are never touched;
 * - the activation receipt drops its claim on any link the installer replaced
 *   with a real directory (`pj init` links the inherited bmad pack before
 *   bmad.scaffold runs, then the installer writes over those links, which
 *   skillex reports as E_OWNERSHIP_CHANGED). Dropping a claim never deletes
 *   anything: the content stays and skillex treats it as foreign.
 *
 * Nothing is handed off while a set replaces the root (skillex refuses
 * exclusions beside a set) or while the receipt carries an interrupted
 * operation's journal (skillex must recover that first; rewriting the links
 * under it leaves a receipt skillex can no longer read). A dry run computes
 * everything and writes nothing.
 */
export async function handOffInstallerSkills(ctx: Context): Promise<InstallerSkillHandoff> {
  const none: InstallerSkillHandoff = { excluded: [], restored: [], released: [], changedFiles: [] };
  const installed = bmadInstalledSkills(ctx.repoRoot);
  const recorded = readHandoffRecord(ctx);
  if (!installed.size && !recorded.length) return none;
  const options = skillCoreOptions(ctx);
  const lock = { home: ctx.homeDir, env: process.env };
  const plan = async (): Promise<InstallerSkillHandoff & { apply: () => Promise<void> }> => {
    const skip = (skipped: string) => ({ ...none, skipped, apply: async () => {} });
    // An unreadable declaration is skillex's finding to report (the audit and
    // sync both relay it); the handoff never turns it into a crash.
    let declaration: Awaited<ReturnType<typeof readSelectionManifest>>;
    try { declaration = await readSelectionManifest(options.project); }
    catch (error) { return skip(`the project skills manifest is invalid (${error instanceof Error ? error.message : String(error)})`); }
    if (!declaration.exists || !declaration.raw) return { ...none, apply: async () => {} };
    if (Array.isArray(declaration.raw.sets) && declaration.raw.sets.length) {
      return skip("a set replaces the project skills root, so installer-provided skills cannot be excluded beside it");
    }
    let receipt: Awaited<ReturnType<typeof readActivationReceipt<{ links?: Record<string, { kind?: string }>; pending?: unknown }>>>;
    try { receipt = await readActivationReceipt(realpathSync(ctx.repoRoot), lock); }
    catch (error) { return skip(`the activation receipt is unreadable (${error instanceof Error ? error.message : String(error)})`); }
    let bindings: Map<string, ResolvedBinding>;
    try { bindings = new Map((await projectBindings(ctx)).map((binding) => [binding.name, binding])); }
    catch (error) { return skip(`the project selection does not resolve (${error instanceof Error ? error.message : String(error)})`); }
    if (receipt.document?.data?.pending !== undefined) {
      return skip("the activation receipt records an interrupted skillex operation; run pj skills sync to recover it first");
    }
    const current = Array.isArray(declaration.raw.exclude)
      ? declaration.raw.exclude.filter((name): name is string => typeof name === "string") : [];
    const excluded = [...installed].filter((name) => bindings.has(name) && !explicitlySelected(bindings.get(name)) && !current.includes(name)).sort();
    const restored = recorded.filter((name) => !installed.has(name) && current.includes(name)).sort();
    const links = receipt.document?.data?.links ?? {};
    const released = Object.keys(links).filter((path) => {
      if (!installerSkillPath(ctx, path, installed)) return false;
      try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
    }).sort();
    const record = [...recorded.filter((name) => installed.has(name) && current.includes(name)), ...excluded];
    const recordChanged = record.length !== recorded.length || record.some((name) => !recorded.includes(name));
    const manifestChanged = excluded.length > 0 || restored.length > 0;
    const changedFiles = [...(manifestChanged ? [declaration.path] : []), ...(released.length ? [receipt.path] : [])];
    return {
      excluded, restored, released: released.map((path) => basename(path)), changedFiles,
      apply: async () => {
        if (manifestChanged) {
          const next = [...current.filter((name) => !restored.includes(name)), ...excluded];
          const { exclude: _exclude, ...rest } = declaration.raw!;
          await writeSelectionManifest(declaration, next.length ? { ...rest, exclude: next } : rest);
        }
        if (released.length && receipt.document) {
          const kept = Object.fromEntries(Object.entries(links).filter(([path]) => !released.includes(path)));
          await writeActivationReceipt(receipt, { ...receipt.document.data, links: kept }, lock);
        }
        if (recordChanged) writeHandoffRecord(ctx, record);
      },
    };
  };
  if (ctx.dryRun) { const { apply: _apply, ...preview } = await plan(); return preview; }
  return withLock(ACTIVATION_LOCK, async () => {
    const { apply, ...result } = await plan();
    await apply();
    return result;
  }, lock);
}

/**
 * Every refusal is at an installer-provided name the handoff covers, and the
 * full root classification (not just skillex's first refusal) finds no
 * blocker anywhere else.
 */
async function installerRefusalsResolvable(ctx: Context, errors: readonly Diagnostic[], handoff: InstallerSkillHandoff): Promise<boolean> {
  if (handoff.skipped) return false;
  const installed = bmadInstalledSkills(ctx.repoRoot);
  const covered = new Set([...handoff.excluded, ...handoff.released]);
  if (!errors.every((finding) => installerOwnedFinding(ctx, finding, installed) && covered.has(basename(finding.path!)))) return false;
  return (await predictRootCollisions(ctx, [])).every(({ path, decision }) => decision.action !== "block" || covered.has(basename(path)));
}

function handOffDetails(handoff: InstallerSkillHandoff, dryRun: boolean): string[] {
  const verb = dryRun ? "would " : "";
  return [
    ...(handoff.skipped ? [`installer skill handoff skipped: ${handoff.skipped}`] : []),
    ...handoff.restored.map((name) => `${verb}withdraw the exclusion of ${name}: the bmad-method installer no longer provides it, so the inherited catalog skill returns`),
    ...handoff.excluded.map((name) => `${verb}exclude ${name}: .agents/skills/${name} is the bmad-method installer's copy, which satisfies the inherited selection`),
    ...handoff.released.map((name) => `${verb}release receipt ownership of .agents/skills/${name}: the bmad-method installer replaced the Skillex link with its own copy`),
  ];
}

/**
 * PJAN-135 (B): may this `.agents/skills/<name>` entry make way for the selected
 * catalog skill of the same name?
 *
 * Only a symlink is ever removed, and unlinking a link never removes what it
 * points at. A dangling link, or one into another repository (a 33GOD component
 * checkout, an old registry path), is a legacy projection: replace it. A link to
 * this repository's OWN content is a deliberate local override unless that
 * content is the same skill as the catalog copy (PJAN-142: vendor provenance and
 * bytecode caches aside, byte-identical). A real directory is never touched; one
 * the BMAD installer owns satisfies the selection instead (PJAN-176).
 */
export async function classifyRootCollision(ctx: Context, path: string): Promise<RootCollisionDecision> {
  const label = relative(resolve(ctx.repoRoot), path) || path;
  let stat;
  try { stat = lstatSync(path); } catch { return { action: "block", detail: `${label} disappeared while resolving a root collision` }; }
  if (!stat.isSymbolicLink()) {
    const name = basename(path);
    if (!bmadInstalledSkills(ctx.repoRoot).has(name)) return realEntryCollision(label, name, stat.isDirectory());
    if (explicitlySelected((await projectBindings(ctx)).find((binding) => binding.name === name))) {
      return { action: "block", detail: `${label} is the bmad-method installer's copy of ${name}, which this project also selects explicitly; drop one of them` };
    }
    return bmadInstallerCopy(label, name);
  }
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
  if (canonical && skillContentIdentical(real, canonical)) {
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
  // PJAN-176: refusals only at skills the BMAD installer provides are exactly
  // what migrate's handoff resolves (exclusion + receipt release). skillex
  // reports its FIRST refusal only, so the verdict also needs the full
  // root-collision classification to find no blocker behind it.
  const handoff = await handOffInstallerSkills({ ...ctx, dryRun: true });
  const errors = result.findings.filter((finding) => finding.severity === "error");
  const installerOnly = errors.length > 0 && await installerRefusalsResolvable(ctx, errors, handoff);
  if (installerOnly) details.push("resolvable: every refusal is at a skill the bmad-method installer provides; migrate excludes the inherited selection and releases the replaced links");
  if (handoff.skipped) details.push(`installer skill handoff unavailable: ${handoff.skipped}`);
  if (handoff.restored.length) details.push(...handoff.restored.map((name) => `stale exclusion: ${name} was excluded for the bmad-method installer's copy, which is gone; migrate restores the inherited catalog skill`));
  if (result.exit === 2 || result.exit === 3) details.push(migrationGuidance(ctx));
  // PJAN-141: the receipt records the catalog commit it was written against, so
  // ANY commit to all-skills leaves every project's receipt stale while every
  // link still resolves exactly where it should. One catalog commit turned the
  // whole fleet red overnight. A plan whose only change is rewriting that
  // receipt is host bookkeeping, not project drift: warn (fixable; migrate
  // or `pj skills sync` refreshes it), never fail.
  const changes = result.data?.changes ?? [];
  const receiptOnly = result.exit === 6 && changes.length > 0
    && changes.every((change) => change.action === "write-receipt")
    && !result.findings.some((finding) => finding.severity === "error");
  if (receiptOnly) details.push("advisory: only the activation receipt is stale (the catalog moved); every link already resolves to its selected skill");
  const staleHandoff = handoff.restored.length > 0;
  return {
    id: "skills.project-manifest",
    title: "Skillex project skills",
    status: result.exit === 0 ? (staleHandoff ? "warn" : "pass") : result.exit === 4 || receiptOnly ? "warn" : "fail",
    summary: result.exit === 0 ? "Skillex declaration and activation are in parity"
      : receiptOnly ? "Skillex activation is in parity; its receipt predates the current catalog commit"
      : `Skillex inspection returned exit ${result.exit}`,
    details,
    fixable: result.exit === 0 || result.exit === 6 || conflictResolvable || installerOnly || staleHandoff
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
 * Skills the BMAD installer provides are handed off first (handOffInstallerSkills).
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
    // PJAN-176: BMAD-installed skills satisfy their inherited selection before
    // skillex plans anything, so the sync below never refuses at them.
    let handoff = await handOffInstallerSkills(ctx);
    changedFiles.push(...handoff.changedFiles);
    details.push(...handOffDetails(handoff, Boolean(ctx.dryRun)));
    const handedOff = new Set([...handoff.excluded, ...handoff.released]);
    const unlinked = new Set<string>();
    let rehanded = false;
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
        const excludable = predictions.filter(({ decision }) => decision.action === "exclude");
        if (blocking.length) {
          details.push(...blocking.map(({ decision }) => `blocked: ${decision.detail}`));
          const waiting = [...replaceable, ...excludable];
          if (waiting.length) details.push(`left in place until the blocked collision(s) above are resolved: ${waiting.map(({ path }) => relative(resolve(ctx.repoRoot), path)).join(", ")}`);
          details.push(migrationGuidance(ctx));
          return { ok: false, changedFiles: [...new Set(changedFiles)], details };
        }
        if (ctx.dryRun) {
          for (const { path, decision } of replaceable) {
            changedFiles.push(path);
            details.push(`would ${decision.detail.replace(/^replaced/, "replace")}`);
          }
          // The handoff preview above already reports the installer's names.
          for (const { decision } of excludable.filter(({ path }) => !handedOff.has(basename(path)))) {
            details.push(`would exclude: ${decision.detail}`);
          }
          changedFiles.push(...(result.data?.changes ?? []).map((change) => change.path));
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
        // An installer copy that appeared after the first handoff (only an
        // interleaved install can do that) is handed off once more.
        if (excludable.length && !rehanded) {
          rehanded = true;
          handoff = await handOffInstallerSkills(ctx);
          changedFiles.push(...handoff.changedFiles);
          details.push(...handOffDetails(handoff, false));
          if (handoff.changedFiles.length) continue;
        }
        details.push(round >= MAX_ROOT_COLLISION_ROUNDS ? `stopped after ${MAX_ROOT_COLLISION_ROUNDS} root collision rounds`
          : `no progress: ${conflict?.path ?? "a root collision"} collided again after every classified link was replaced`);
      }
      const changes = ctx.dryRun ? result.data?.changes : result.data?.applied;
      changedFiles.push(...(changes ?? []).map((change) => change.path));
      // A preview cannot apply the handoff, so skillex still refuses at the
      // names it hands off; those refusals are what the handoff resolves.
      const errors = result.findings.filter((finding) => finding.severity === "error");
      const previewResolved = Boolean(ctx.dryRun) && !result.ok && errors.length > 0
        && await installerRefusalsResolvable(ctx, errors, handoff);
      if (previewResolved) return { ok: true, changedFiles: [...new Set(changedFiles)], details };
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

/**
 * PJAN-176: after bmad-method runs, hand its skills over from Skillex and
 * re-sync, so the install never leaves the project refusing at them (pj init
 * links the inherited bmad pack first, then bmad.scaffold writes over it). A
 * project without a skills manifest has nothing to reconcile.
 */
export async function reconcileInstallerSkills(ctx: Context): Promise<SkillSynchronization> {
  if (ctx.dryRun || !(await readSelectionManifest(resolve(ctx.repoRoot))).exists) return { ok: true, changedFiles: [], details: [] };
  return synchronizeProjectSkills(ctx);
}

/**
 * PJAN-144: the legacy `"registry"` field in a project's `.agents/skills.json`.
 * skillex resolves such a project from the `~/.agents/.cache/registries` clone,
 * which it never fetches, while the global scope (no field) resolves from the
 * configured catalog checkout. skillex compares binding paths lexically, so a
 * project that explicitly re-selects an inherited skill refused with
 * E_DIVERGENT_CANONICAL_NAME even when both copies were byte-identical (HeyMa),
 * and every unpulled catalog commit left the project resolving stale content.
 * skillex's own guidance is to drop the field; the CommonProject template and
 * `skillex init` no longer write it. Returns the manifest path and the value,
 * or undefined when absent or when the manifest is unreadable (skillex reports
 * that itself).
 */
export async function legacyRegistryField(ctx: Context): Promise<{ path: string; value: unknown } | undefined> {
  try {
    const snapshot = await readSelectionManifest(resolve(ctx.repoRoot));
    if (!snapshot.exists || !snapshot.raw || !("registry" in snapshot.raw)) return undefined;
    return { path: snapshot.path, value: snapshot.raw.registry };
  } catch {
    return undefined;
  }
}

/**
 * Drop the legacy `"registry"` field under skillex's activation lock, keeping
 * every other key and its order. A dry run reports the change and writes nothing.
 */
export async function dropLegacyRegistryField(ctx: Context): Promise<{ changedFiles: string[]; details: string[] }> {
  const found = await legacyRegistryField(ctx);
  if (!found) return { changedFiles: [], details: [] };
  const detail = `${ctx.dryRun ? "would drop" : "dropped"} the legacy registry field (${JSON.stringify(found.value)}) from ${found.path}: it pinned resolution to the never-fetched ~/.agents/.cache registry clone`;
  if (ctx.dryRun) return { changedFiles: [found.path], details: [detail] };
  return withLock(ACTIVATION_LOCK, async () => {
    const snapshot = await readSelectionManifest(resolve(ctx.repoRoot));
    if (!snapshot.exists || !snapshot.raw || !("registry" in snapshot.raw)) return { changedFiles: [], details: [] };
    const { registry: _registry, ...rest } = snapshot.raw;
    await writeSelectionManifest(snapshot, rest);
    return { changedFiles: [snapshot.path], details: [detail] };
  }, { home: ctx.homeDir, env: process.env });
}
