import type { CommandContext } from "../commands/Command";
import { createBmadChecks } from "../parity/rules";
import { Recipe } from "./Recipe";
import { SUPPORTED_CLIS } from "./supported-clis";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata } from "./types";

/** Owns BMAD installation, version currency, and supported CLI projections. */
export class BmadRecipe extends Recipe {
  readonly checks = createBmadChecks();
  readonly metadata: RecipeMetadata = {
    id: "bmad",
    name: "bmad",
    description: "BMAD methodology and the supported CLI projections",
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
    console.log(`BMAD lifecycle initialized for the ${SUPPORTED_CLIS.length} supported CLIs.`);
  }
}
