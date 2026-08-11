import { Recipe } from "./Recipe";
import { AddPackageJson, AddReadme, AddSrcDirectory } from "../commands/NodeCommands";
import type { CommandContext } from "../commands/Command";
import type { LifecycleContext, RecipeCheck, RecipeInitResult, RecipeMetadata } from "./types";

export class NodeRecipe extends Recipe {
  readonly checks: readonly RecipeCheck[] = [];
  readonly metadata: RecipeMetadata = {
    id: "node",
    name: "node",
    description: "Node.js project template",
    dependencies: [],
    commands: ["NodeCommands"],
    publicRuleIds: [],
  };

  constructor(context?: CommandContext) {
    super(context);
    this
      .addIngredient(AddPackageJson)
      .addIngredient(AddReadme)
      .addIngredient(AddSrcDirectory);
  }

  override init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    return this.invokeIngredients(ctx);
  }

  protected printNextSteps(): void {
    console.log("🎉 Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}
