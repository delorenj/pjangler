import { Recipe } from "./Recipe";
import { AddPackageJson, AddReadme, AddSrcDirectory } from "../commands/NodeCommands";
import type { CommandContext } from "../commands/Command";

export class NodeRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(AddPackageJson)
      .addIngredient(AddReadme)
      .addIngredient(AddSrcDirectory);
  }

  protected printNextSteps(): void {
    console.log("🎉 Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}