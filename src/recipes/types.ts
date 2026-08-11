import type { CommandContext } from "../commands/Command";

export type RecipeId = string;
export type RuleId = string;
export type LifecycleStatus = "pass" | "fail" | "warn" | "skip";
export type MigrationStatus = "applied" | "noop" | "blocked" | "skipped";
export type RecipePhaseStatus = "changed" | "unchanged" | "planned" | "skipped" | "failed" | "cancelled";

export interface LifecycleContext extends CommandContext {
  targetDir: string;
  dryRun: boolean;
  force: boolean;
  repoRoot: string;
  pjanglerRoot: string;
  homeDir: string;
  live?: boolean;
  bmadVersionPin?: string;
  acceptRegistryMatches?: boolean;
}

export interface RecipeMetadata {
  id: RecipeId;
  name: string;
  description: string;
  dependencies: readonly RecipeId[];
  commands: readonly string[];
  publicRuleIds: readonly RuleId[];
}

export interface RecipeInitResult {
  recipeId: RecipeId;
  ok: boolean;
  dryRun: boolean;
  changedFiles: string[];
  logs: string[];
  errors: string[];
  phases: RecipePhaseOutcome[];
  [key: string]: unknown;
}

export interface RecipePhaseOutcome {
  id: string;
  status: RecipePhaseStatus;
  changedFiles: string[];
  message?: string;
}

export interface LifecycleAuditFinding {
  id: RuleId;
  title: string;
  status: LifecycleStatus;
  summary: string;
  details: string[];
  fixable: boolean;
  recipeId?: RecipeId;
}

export interface LifecycleMigrationResult {
  id: RuleId;
  title: string;
  status: MigrationStatus;
  summary: string;
  changedFiles: string[];
  details: string[];
  recipeId?: RecipeId;
}

export interface LifecycleAuditReport {
  repo: string;
  ok: boolean;
  auditedAt: string;
  rules: LifecycleAuditFinding[];
}

export interface LifecycleMigrationReport {
  repo: string;
  dryRun: boolean;
  ok: boolean;
  selectedRules: string[];
  results: LifecycleMigrationResult[];
  changedFiles: string[];
}

export interface RecipeCheck {
  readonly id: RuleId;
  readonly title: string;
  audit(ctx: LifecycleContext): LifecycleAuditFinding;
  migrate(ctx: LifecycleContext, finding: LifecycleAuditFinding): LifecycleMigrationResult;
}

export interface LifecycleRecipe<TInput = unknown> {
  readonly metadata: RecipeMetadata;
  readonly checks: readonly RecipeCheck[];
  init(ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult>;
  audit(ctx: LifecycleContext): LifecycleAuditFinding[];
  migrate(ctx: LifecycleContext, ruleIds: readonly RuleId[]): LifecycleMigrationResult[];
  /** Project-like orchestrators run their declared dependencies inside init. */
  readonly orchestratesDependencies?: boolean;
}
