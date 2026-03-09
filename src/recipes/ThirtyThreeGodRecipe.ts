import { Recipe } from "./Recipe";
import { AddThirtyThreeGodSkeleton } from "../commands/AddThirtyThreeGodSkeleton";
import type { CommandContext } from "../commands/Command";

export class ThirtyThreeGodRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this.addIngredient(AddThirtyThreeGodSkeleton);
  }

  protected printNextSteps(): void {
    console.log("🎉 33GOD ecosystem project skeleton initialized!");
    console.log("   Next steps:");
    console.log("   1. Review the generated CLAUDE.md and AGENTS.md files");
    console.log("   2. Run `pjangler init misebase` if you haven't already to set up task running");
    console.log("   3. Check your new Plane project at https://plane.delo.sh/33god");
  }
}
