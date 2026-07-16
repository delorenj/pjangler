import { Recipe } from "./Recipe";
import { WireMiseOpInject } from "../commands/WireMiseOpInject";
import type { CommandContext } from "../commands/Command";

export class MiseOpInjectRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this.addIngredient(WireMiseOpInject);
  }

  protected printNextSteps(): void {
    console.log("🎉 Wired up .env.op 1Password resolution via mise!");
    console.log("   Next steps:");
    console.log("   1. Create .env.op with your op:// secret references");
    console.log("   2. Run \`mise run secrets-inject\` or simply cd out and back in to trigger the hook");
  }
}
