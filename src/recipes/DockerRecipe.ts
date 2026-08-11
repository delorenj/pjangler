import { Recipe } from "./Recipe";
import { AddDockerfile } from "../commands/AddDockerfile";
import { AddDockerCompose } from "../commands/AddDockerCompose";
import { AddDockerignore } from "../commands/AddDockerignore";
import type { CommandContext } from "../commands/Command";
import type { LifecycleContext, RecipeCheck, RecipeInitResult, RecipeMetadata } from "./types";

export class DockerRecipe extends Recipe {
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
