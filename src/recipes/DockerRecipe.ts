import { Recipe } from "./Recipe";
import { AddDockerfile } from "../commands/AddDockerfile";
import { AddDockerCompose } from "../commands/AddDockerCompose";
import { AddDockerignore } from "../commands/AddDockerignore";
import type { CommandContext } from "../commands/Command";
import type { LifecycleContext, RecipeCheck, RecipeInitResult, RecipeMetadata } from "./types";

export class DockerRecipe extends Recipe {
  // PJAN-84: deliberately no checks, and this is the reason.
  //
  // An audit rule here would have to answer "did pjangler install this?", and
  // the recipe records no provenance — nothing distinguishes the Dockerfile
  // `pj add docker` wrote from one the operator wrote by hand. Requiring all
  // three artifacts whenever any of them is present would flag every repo with
  // a hand-written Dockerfile and no compose file, which is most of them.
  //
  // So the honest state is what `describe` already reports: the subsystem's
  // presence comes from marker files and its parity reads "unchecked". A rule
  // that produced false positives would be worse than no rule. Give this checks
  // when the recipe starts recording what it wrote — not before.
  readonly checks: readonly RecipeCheck[] = [];
  readonly metadata: RecipeMetadata = {
    id: "docker",
    name: "docker",
    description: "Docker containerization setup",
    dependencies: [],
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"],
    publicRuleIds: [],
  };

  constructor(context?: CommandContext) {
    super(context);
    this
      .addIngredient(AddDockerfile)
      .addIngredient(AddDockerCompose)
      .addIngredient(AddDockerignore);
  }

  override init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    return this.invokeIngredients(ctx);
  }

  protected printNextSteps(): void {
    console.log("🎉 Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
}
