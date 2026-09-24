import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recipeRegistry } from "../recipes/catalog";
import { gatesProject, type LifecycleContext } from "../recipes/types";
import type { AuditReport, MigrationReport } from "./rules";

export {
  formatAuditReport,
  formatMigrationReport,
  formatMomoReadinessReport,
  formatRulePicker,
  runMomoReadinessAudit,
} from "./rules";
export type {
  AuditFinding,
  AuditReport,
  Context,
  MigrationReport,
  MigrationRuleResult,
  MomoReadinessFinding,
  MomoReadinessReport,
  RulePicker,
  RulePickerChoice,
  RuleStatus,
} from "./rules";
export { recipeRegistry };

function resolvePjanglerRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd());
}

export function lifecycleContext(
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
  overrides: Partial<LifecycleContext> = {},
): LifecycleContext {
  const repoRoot = resolve(repoArg ?? process.cwd());
  return {
    ...overrides,
    targetDir: repoRoot,
    repoRoot,
    dryRun: overrides.dryRun ?? dryRun,
    force: overrides.force ?? false,
    pjanglerRoot: overrides.pjanglerRoot ?? resolvePjanglerRoot(),
    homeDir: overrides.homeDir ?? homedir(),
    acceptRegistryMatches: overrides.acceptRegistryMatches ?? acceptRegistryMatches,
  };
}

export function getParityRuleIds(): string[] {
  return [...recipeRegistry.listRuleIds()];
}

function publicAudit(report: Awaited<ReturnType<typeof recipeRegistry.auditRecipes>>): AuditReport {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding),
  } as AuditReport;
}

function publicMigration(report: Awaited<ReturnType<typeof recipeRegistry.migrateRules>>): MigrationReport {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result),
  } as MigrationReport;
}

export async function runAudit(repoArg?: string, registryPath?: string, ruleIds?: readonly string[]): Promise<AuditReport> {
  // PJAN-84: the registry the caller asked for reaches the rules. Without this,
  // `pj audit` had no --registry at all and every registry-reading rule fell
  // back to projectRegistryPath() independently, so auditing a project outside
  // the default registry produced findings about a project the registry had
  // never heard of.
  const report = publicAudit(await recipeRegistry.auditRecipes(lifecycleContext(repoArg, true, false, registryPath ? { registryPath } : {})));
  if (!ruleIds || ruleIds.length === 0) return report;

  // A filtered audit answers about exactly the rules asked for. An id this
  // registry does not own is an ERROR, not an empty pass: a caller probing a
  // contract it depends on must not read "no findings" when the real answer is
  // "I never checked". Flume's hire postcondition is the first such caller.
  const known = new Set(recipeRegistry.listRuleIds());
  const unknown = ruleIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown parity rule id(s): ${unknown.join(", ")}`);
  const wanted = new Set(ruleIds);
  const rules = report.rules.filter((finding) => wanted.has(finding.id));
  // PJAN-84's meaning of ok, for the rules asked about: a warn (e.g. PJAN-141's
  // receipt-only refresh) or a host-scoped finding does not gate the project.
  return { ...report, rules, ok: rules.every((finding) => !gatesProject(finding)) };
}

export async function runMigrationForRules(
  ruleIds: string[],
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
  registryPath?: string,
): Promise<MigrationReport> {
  return publicMigration(await recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches, registryPath ? { registryPath } : {}),
    ruleIds,
  ));
}

export async function runMigration(
  selector: string | undefined,
  repoArg: string | undefined,
  dryRun: boolean,
  all: boolean,
  acceptRegistryMatches = false,
  registryPath?: string,
): Promise<MigrationReport> {
  const ctx = lifecycleContext(repoArg, dryRun, acceptRegistryMatches, registryPath ? { registryPath } : {});
  return publicMigration(await (all
    ? recipeRegistry.migrateAll(ctx)
    : recipeRegistry.migrateRules(ctx, selector ? [selector] : [])));
}
