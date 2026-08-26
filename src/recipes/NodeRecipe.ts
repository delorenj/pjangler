import { Recipe } from "./Recipe";
import { AddPackageJson, AddReadme, AddSrcDirectory } from "../commands/NodeCommands";
import type { CommandContext } from "../commands/Command";
import type { LifecycleContext, RecipeCheck, RecipeInitResult, RecipeMetadata } from "./types";

export class NodeRecipe extends Recipe {
  // PJAN-84: deliberately no checks, and this is the reason.
  //
  // An audit rule here would have to answer "did pjangler install this?", and
  // the recipe records no provenance — nothing distinguishes the package.json
  // `pj add node` wrote from the one npm wrote. Requiring README.md and
  // src/ wherever a package.json exists would flag every library, every
  // monorepo package, and every repo that keeps its sources elsewhere.
  //
  // So the honest state is what `describe` already reports: the subsystem's
  // presence comes from marker files and its parity reads "unchecked". A rule
  // that produced false positives would be worse than no rule. Give this checks
  // when the recipe starts recording what it wrote — not before.
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
