/**
 * Recipe and Command registry for pjangler CLI
 * Provides centralized access to available recipes and commands
 */

import type { CommandContext } from "../commands/Command";
import type { LifecycleRecipe } from "../recipes/types";
import { recipeRegistry } from "../recipes/catalog";
import { Command as Cmd } from "../commands/Command";

// Import all commands
import { CopyAgentHooksTree, WireMiseAgentHooks } from "../commands/AgentHooksCommands";
import { AddDockerfile } from "../commands/AddDockerfile";
import { AddDockerCompose } from "../commands/AddDockerCompose";
import { AddDockerignore } from "../commands/AddDockerignore";
import { AddMiseToml } from "../commands/AddMiseToml";
import { AddMiseBaseToml } from "../commands/AddMiseBaseToml";
import { AddMiseTasksStructure } from "../commands/AddMiseTasksStructure";
import { AddMiseBaseScript } from "../commands/AddMiseBaseScript";
import { AddMiseCodegraphScript } from "../commands/AddMiseCodegraphScript";
import { AddDotenv } from "../commands/AddDotenv";
import { WireMiseOpInject } from "../commands/WireMiseOpInject";

export interface RecipeInfo {
  name: string;
  description: string;
  instance: LifecycleRecipe;
  commands: string[];
}

export interface CommandInfo {
  name: string;
  description: string;
  group: string;
  class: new (context: CommandContext) => Cmd;
}

/**
 * Registry of all available recipes
 */
const LEGACY_PUBLIC_RECIPE_IDS = ["mise", "docker", "node", "hermes-agent", "agent-hooks", "mise-op-inject"] as const;

/** Read-only compatibility facade over the exact production recipe instances. */
export const RECIPE_REGISTRY: Readonly<Record<string, RecipeInfo>> = Object.freeze(Object.fromEntries(
  LEGACY_PUBLIC_RECIPE_IDS.map((id) => {
    const instance = recipeRegistry.get(id);
    if (!instance) throw new Error(`Production recipe registry is missing ${id}`);
    return [id, Object.freeze({
      name: instance.metadata.name,
      description: instance.metadata.description,
      instance,
      commands: [...instance.metadata.commands],
    })];
  }),
));

/**
 * Registry of all available commands
 */
export const COMMAND_REGISTRY: Record<string, CommandInfo> = {
  CopyAgentHooksTree: {
    name: "CopyAgentHooksTree",
    description: "Copy the generic agent-hooks tree (hooks SSOT + sync engine + scripts) from the CommonProject template",
    group: "agent-hooks",
    class: CopyAgentHooksTree
  },
  WireMiseAgentHooks: {
    name: "WireMiseAgentHooks",
    description: "Merge agent-hooks enter/leave + tasks into an existing mise.toml (idempotent)",
    group: "agent-hooks",
    class: WireMiseAgentHooks
  },
  AddDockerfile: {
    name: "AddDockerfile",
    description: "Create Dockerfile for containerization",
    group: "docker",
    class: AddDockerfile
  },
  AddDockerCompose: {
    name: "AddDockerCompose",
    description: "Create docker-compose.yml for multi-service setup",
    group: "docker",
    class: AddDockerCompose
  },
  AddDockerignore: {
    name: "AddDockerignore",
    description: "Create .dockerignore file",
    group: "docker",
    class: AddDockerignore
  },
  AddMiseToml: {
    name: "AddMiseToml",
    description: "Create mise.toml for version management",
    group: "mise",
    class: AddMiseToml
  },
  AddMiseBaseToml: {
    name: "AddMiseBaseToml",
    description: "Create base mise configuration",
    group: "mise",
    class: AddMiseBaseToml
  },
  AddMiseTasksStructure: {
    name: "AddMiseTasksStructure",
    description: "Create .mise/tasks directory structure",
    group: "mise",
    class: AddMiseTasksStructure
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddMiseCodegraphScript: {
    name: "AddMiseCodegraphScript",
    description: "Create .mise/scripts/codegraph.sh enter hook",
    group: "mise",
    class: AddMiseCodegraphScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  },
  WireMiseOpInject: {
    name: "WireMiseOpInject",
    description: "Wire up op-inject script to mise.toml for 1Password secret resolution",
    group: "mise",
    class: WireMiseOpInject
  }
};

/**
 * Get all available recipe names
 */
export function getRecipeNames(): string[] {
  return Object.keys(RECIPE_REGISTRY);
}

/**
 * Get recipe info by name
 */
export function getRecipeInfo(name: string): RecipeInfo | null {
  return RECIPE_REGISTRY[name] || null;
}

/**
 * Get all available command names
 */
export function getCommandNames(): string[] {
  return Object.keys(COMMAND_REGISTRY);
}

/**
 * Get command info by name
 */
export function getCommandInfo(name: string): CommandInfo | null {
  return COMMAND_REGISTRY[name] || null;
}

/**
 * Get commands grouped by category
 */
export function getCommandsByGroup(): Record<string, CommandInfo[]> {
  const grouped: Record<string, CommandInfo[]> = {};

  for (const cmdInfo of Object.values(COMMAND_REGISTRY)) {
    if (!grouped[cmdInfo.group]) {
      grouped[cmdInfo.group] = [];
    }
    grouped[cmdInfo.group]!.push(cmdInfo);
  }

  return grouped;
}

/**
 * Create recipe instance by name
 */
export function createRecipe(name: string, context: CommandContext): LifecycleRecipe | null {
  void context;
  const info = getRecipeInfo(name);
  if (!info) return null;
  return info.instance;
}
