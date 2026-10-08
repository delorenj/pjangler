import type { CommandContext } from "../commands/Command";
import { createBmadChecks } from "../parity/rules";
import { companionDetails, createG33CompanionCheck, runG33Companion, type CompanionResult } from "../bmad/companion";
import { Recipe } from "./Recipe";
import { SUPPORTED_CLIS } from "./supported-clis";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata } from "./types";

/** Owns BMAD installation, version currency, and supported CLI projections. */
export class BmadRecipe extends Recipe {
  private readonly requiredChecks = createBmadChecks();
  readonly checks = [...this.requiredChecks, createG33CompanionCheck()];
  readonly metadata: RecipeMetadata = {
    id: "bmad",
    name: "bmad",
    description: "BMAD methodology, supported CLI projections, and the optional owner-provided g33 companion",
    dependencies: ["agent-hooks"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  constructor(context?: CommandContext) {
    super(context);
  }

  override async init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    // Retain the install hook's outcome (including partial writes) without
    // retrying a failed optional installer within the same recipe invocation.
    const companions: CompanionResult[] = [];
    const checks = this.requiredChecks.map((check) => ({
      ...check,
      migrate: async (...args: Parameters<typeof check.migrate>) => {
        const result = await check.migrate(...args);
        if (result.bmadCompanion) companions.push(result.bmadCompanion);
        return result;
      },
    }));
    const required = await this.initializeOwnedChecks(ctx, checks);
    if (!required.ok) return { ...required, ...(companions.length ? { bmadCompanion: companions.at(-1) } : {}) };
    const companion = companions.at(-1) ?? await runG33Companion(ctx.repoRoot, ctx.dryRun);
    return {
      ...required,
      bmadCompanion: companion,
      changedFiles: [...new Set([...required.changedFiles, ...companion.changedFiles])].sort(),
      logs: [...required.logs, ...companionDetails(companion)],
      phases: [...required.phases, {
        id: "bmad.g33-companion",
        status: companion.status === "planned" ? "planned" : companion.status === "changed" ? "changed"
          : companion.status === "unchanged" ? "unchanged" : "skipped",
        message: `Optional g33 (${companion.status}): ${companion.summary}`,
        changedFiles: companion.changedFiles,
      }],
    };
  }

  protected printNextSteps(): void {
    console.log(`BMAD lifecycle initialized for the ${SUPPORTED_CLIS.length} supported CLIs.`);
  }
}
