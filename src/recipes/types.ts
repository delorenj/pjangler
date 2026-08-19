import type { CommandContext } from "../commands/Command";
import type { NotebookObservationV1, NotebookPlanV1 } from "../notebook/observation";

export type RecipeId = string;
export type RuleId = string;
export type LifecycleStatus = "pass" | "fail" | "warn" | "skip";
/**
 * `partial` is the honest outcome for a rule that DID apply changes (or found
 * nothing it was allowed to change) yet still does not pass its own audit --
 * e.g. a step that needs an explicit opt-in flag, or a blocker the rule
 * refuses to resolve destructively. It is the migrate-side counterpart of the
 * postcondition check `Recipe.initializeOwnedChecks` has always run, and it
 * exists so "Migration complete" can never be followed by a failing audit.
 */
export type MigrationStatus = "applied" | "noop" | "blocked" | "skipped" | "partial";
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
  notebookPlan?: Readonly<NotebookPlanV1>;
  /** True only when the authoritative Registry project has a notebook binding block. */
  notebookRegistryDeclared?: boolean;
  /** Focused `pj notebook audit|migrate` opts undeclared repositories into the actionable declaration rule. */
  notebookFocusedAudit?: boolean;
  /** Exact binding projection from the Manifest snapshot used to build notebookPlan; null means absent. */
  notebookManifestBinding?: Readonly<Record<string, unknown>> | null;
  notebookObservation?: Readonly<NotebookObservationV1>;
  notebookStateRoot?: string;
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
