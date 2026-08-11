import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recipeRegistry } from "../recipes/catalog";
import type { LifecycleContext } from "../recipes/types";
import type { AuditReport, MigrationReport } from "./rules";

export {
  BMAD_PACK_VERSION,
  formatAuditReport,
  formatMigrationReport,
  formatMomoReadinessReport,
  formatRulePicker,
  provisionBmadSkills,
  registryCacheDirName,
  runMomoReadinessAudit,
} from "./rules";
export type {
  AuditFinding,
  AuditReport,
  BmadProvisionHooks,
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

export function lifecycleContext(repoArg: string | undefined, dryRun: boolean, acceptRegistryMatches = false): LifecycleContext {
  const repoRoot = resolve(repoArg ?? process.cwd());
  return {
    targetDir: repoRoot,
    repoRoot,
    dryRun,
    force: false,
    pjanglerRoot: resolvePjanglerRoot(),
    homeDir: homedir(),
    acceptRegistryMatches,
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

export function runAudit(repoArg?: string): AuditReport {
  return publicAudit(recipeRegistry.auditRecipes(lifecycleContext(repoArg, true)));
}

export function runMigrationForRules(
  ruleIds: string[],
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
): MigrationReport {
  return publicMigration(recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches),
    ruleIds,
  ));
}

export function runMigration(
  selector: string | undefined,
  repoArg: string | undefined,
  dryRun: boolean,
  all: boolean,
  acceptRegistryMatches = false,
): MigrationReport {
  const ctx = lifecycleContext(repoArg, dryRun, acceptRegistryMatches);
  return publicMigration(all
    ? recipeRegistry.migrateAll(ctx)
    : recipeRegistry.migrateRules(ctx, selector ? [selector] : []));
}
