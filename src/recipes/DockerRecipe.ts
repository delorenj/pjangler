import { Recipe } from "./Recipe";
import { AddDockerfile } from "../commands/AddDockerfile";
import { AddDockerCompose } from "../commands/AddDockerCompose";
import { AddDockerignore } from "../commands/AddDockerignore";
import type { CommandContext } from "../commands/Command";

export class DockerRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(AddDockerfile)
      .addIngredient(AddDockerCompose)
      .addIngredient(AddDockerignore);
  }

  protected printNextSteps(): void {
    console.log("🎉 Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
}