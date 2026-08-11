import type { CommandContext } from "../commands/Command";
import { createBmadChecks } from "../parity/rules";
import { Recipe } from "./Recipe";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata } from "./types";

/** Owns BMAD installation, version currency, and supported CLI projections. */
export class BmadRecipe extends Recipe {
  readonly checks = createBmadChecks();
  readonly metadata: RecipeMetadata = {
    id: "bmad",
    name: "bmad",
    description: "BMAD methodology and six supported CLI projections",
    dependencies: ["agent-hooks"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  constructor(context?: CommandContext) {
    super(context);
  }

  override init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    return this.initializeOwnedChecks(ctx);
  }

  protected printNextSteps(): void {
    console.log("BMAD lifecycle initialized for the six supported CLIs.");
  }
}
