import { Recipe } from "./Recipe";
import type { CommandContext } from "../commands/Command";
import { createMiseOpInjectChecks } from "../parity/rules";
import type { RecipeMetadata } from "./types";
import type { LifecycleContext, RecipeInitResult } from "./types";

export class MiseOpInjectRecipe extends Recipe {
  readonly checks = createMiseOpInjectChecks();
  readonly metadata: RecipeMetadata = {
    id: "mise-op-inject",
    name: "mise-op-inject",
    description: "Canonical .env.op to .env materialization lifecycle",
    dependencies: [],
    commands: ["WireMiseOpInject"],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  constructor(context?: CommandContext) {
    super(context);
  }

  override init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    return this.initializeOwnedChecks(ctx);
  }

  protected printNextSteps(): void {
    console.log("🎉 Wired up .env.op 1Password resolution via mise!");
    console.log("   Next steps:");
    console.log("   1. Create .env.op with your op:// secret references");
    console.log("   2. Re-enter the project to run the managed materialization hook");
  }
}
