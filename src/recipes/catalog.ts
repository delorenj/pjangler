import { AgentHooksRecipe } from "./AgentHooksRecipe";
import { BmadRecipe } from "./BmadRecipe";
import { DockerRecipe } from "./DockerRecipe";
import { HermesAgentRecipe } from "./HermesAgentRecipe";
import { MiseOpInjectRecipe } from "./MiseOpInjectRecipe";
import { MiseRecipe } from "./MiseRecipe";
import { NodeRecipe } from "./NodeRecipe";
import { ProjectRecipe } from "./ProjectRecipe";
import { NotebookRecipe } from "./NotebookRecipe";
import { RecipeRegistry } from "./registry";

/** The single production lifecycle registry instance. */
export const recipeRegistry = new RecipeRegistry([
  new MiseOpInjectRecipe(),
  new MiseRecipe(),
  new AgentHooksRecipe(),
  new BmadRecipe(),
  new DockerRecipe(),
  new NodeRecipe(),
  new HermesAgentRecipe(),
  new NotebookRecipe(),
  new ProjectRecipe(),
]);
