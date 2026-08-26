import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recipeRegistry } from "../recipes/catalog";
import type { LifecycleContext } from "../recipes/types";
import type { AuditReport, MigrationReport } from "./rules";

export {
  formatAuditReport,
  formatMigrationReport,
  formatMomoReadinessReport,
  formatRulePicker,
  provisionDeclaredPacks,
  registryCacheDirName,
  runMomoReadinessAudit,
} from "./rules";
export type {
  AuditFinding,
  AuditReport,
  PackProvisionHooks,
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

function publicAudit(report: ReturnType<typeof recipeRegistry.auditRecipes>): AuditReport {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding),
  } as AuditReport;
}

function publicMigration(report: ReturnType<typeof recipeRegistry.migrateRules>): MigrationReport {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result),
  } as MigrationReport;
}

export function runAudit(repoArg?: string, registryPath?: string): AuditReport {
  // PJAN-84: the registry the caller asked for reaches the rules. Without this,
  // `pj audit` had no --registry at all and every registry-reading rule fell
  // back to projectRegistryPath() independently, so auditing a project outside
  // the default registry produced findings about a project the registry had
  // never heard of.
  return publicAudit(recipeRegistry.auditRecipes(lifecycleContext(repoArg, true, false, registryPath ? { registryPath } : {})));
}

export function runMigrationForRules(
  ruleIds: string[],
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
  registryPath?: string,
): MigrationReport {
  return publicMigration(recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches, registryPath ? { registryPath } : {}),
    ruleIds,
  ));
}

export function runMigration(
  selector: string | undefined,
  repoArg: string | undefined,
  dryRun: boolean,
  all: boolean,
  acceptRegistryMatches = false,
  registryPath?: string,
): MigrationReport {
  const ctx = lifecycleContext(repoArg, dryRun, acceptRegistryMatches, registryPath ? { registryPath } : {});
  return publicMigration(all
    ? recipeRegistry.migrateAll(ctx)
    : recipeRegistry.migrateRules(ctx, selector ? [selector] : []));
}
