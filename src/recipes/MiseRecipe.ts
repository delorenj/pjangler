import { Recipe } from "./Recipe";
import { AddMiseToml } from "../commands/AddMiseToml";
import { AddDotenv } from "../commands/AddDotenv";
import { AddMiseTasksStructure } from "../commands/AddMiseTasksStructure";
import { AddMiseBaseToml } from "../commands/AddMiseBaseToml";
import { AddMiseBaseScript } from "../commands/AddMiseBaseScript";
import { AddMiseCodegraphScript } from "../commands/AddMiseCodegraphScript";
import { AddMiseCodegraphWireScript } from "../commands/AddMiseCodegraphWireScript";
import { WireMiseOpInject } from "../commands/WireMiseOpInject";
import type { CommandContext } from "../commands/Command";

export class MiseRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(AddMiseToml)
      .addIngredient(AddDotenv)
      .addIngredient(AddMiseTasksStructure)
      .addIngredient(AddMiseBaseToml)
      .addIngredient(AddMiseBaseScript)
      .addIngredient(AddMiseCodegraphScript)
      .addIngredient(AddMiseCodegraphWireScript)
      .addIngredient(WireMiseOpInject);
  }

  protected printNextSteps(): void {
    console.log("🎉 Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}