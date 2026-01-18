import { Recipe } from "./Recipe";
import { AddMiseToml } from "../commands/AddMiseToml";
import { AddDotenv } from "../commands/AddDotenv";
import { AddMiseTasksStructure } from "../commands/AddMiseTasksStructure";
import { AddMiseBaseToml } from "../commands/AddMiseBaseToml";
import { AddMiseBaseScript } from "../commands/AddMiseBaseScript";
import type { CommandContext } from "../commands/Command";

export class MiseRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(AddMiseToml)
      .addIngredient(AddDotenv)
      .addIngredient(AddMiseTasksStructure)
      .addIngredient(AddMiseBaseToml)
      .addIngredient(AddMiseBaseScript);
  }

  protected printNextSteps(): void {
    console.log("🎉 Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}