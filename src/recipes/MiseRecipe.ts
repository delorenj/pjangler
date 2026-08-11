import { Recipe } from "./Recipe";
import type { CommandContext } from "../commands/Command";
import { createMiseChecks } from "../parity/rules";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata } from "./types";

export class MiseRecipe extends Recipe {
  readonly checks = createMiseChecks();
  readonly metadata: RecipeMetadata = {
    id: "mise",
    name: "mise",
    description: "Mise task runner and environment setup",
    dependencies: ["mise-op-inject"],
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript", "AddMiseCodegraphScript", "AddMiseCodegraphWireScript"],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  constructor(context?: CommandContext) {
    super(context);
  }

  override init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    return this.initializeOwnedChecks(ctx);
  }

  protected printNextSteps(): void {
    console.log("🎉 Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}
