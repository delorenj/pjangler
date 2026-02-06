/**
 * Recipe and Command registry for pjangler CLI
 * Provides centralized access to available recipes and commands
 */

import type { CommandContext } from "../commands/Command";
import type { Recipe } from "../recipes/Recipe";
import { Command as Cmd } from "../commands/Command";

// Import all recipes
import { MiseRecipe } from "../recipes/MiseRecipe";
import { DockerRecipe } from "../recipes/DockerRecipe";
import { NodeRecipe } from "../recipes/NodeRecipe";

// Import all commands
import { AddDockerfile } from "../commands/AddDockerfile";
import { AddDockerCompose } from "../commands/AddDockerCompose";
import { AddDockerignore } from "../commands/AddDockerignore";
import { AddMiseToml } from "../commands/AddMiseToml";
import { AddMiseBaseToml } from "../commands/AddMiseBaseToml";
import { AddMiseTasksStructure } from "../commands/AddMiseTasksStructure";
import { AddMiseBaseScript } from "../commands/AddMiseBaseScript";
import { AddMiseComponentsManifest } from "../commands/AddMiseComponentsManifest";
import { AddMiseConsoleScript } from "../commands/AddMiseConsoleScript";
import { AddDotenv } from "../commands/AddDotenv";
import { SyncDocs } from "../commands/SyncDocs";
import { Doctor } from "../commands/Doctor";

export interface RecipeInfo {
  name: string;
  description: string;
  class: new (context: CommandContext) => Recipe;
  commands: string[];
}

export interface CommandInfo {
  name: string;
  description: string;
  group: string;
  class: new (context: CommandContext) => Cmd;
  aliases?: string[];
  runnable?: boolean;
}

/**
 * Registry of all available recipes
 */
export const RECIPE_REGISTRY: Record<string, RecipeInfo> = {
  mise: {
    name: "mise",
    description: "Mise task runner and environment setup",
    class: MiseRecipe,
    commands: [
      "AddMiseToml",
      "AddDotenv",
      "AddMiseTasksStructure",
      "AddMiseComponentsManifest",
      "AddMiseConsoleScript",
      "AddMiseBaseToml",
      "AddMiseBaseScript"
    ]
  },
  misebase: {
    name: "misebase",
    description: "Alias for mise bootstrap scaffolding (manifest + dispatcher + base tasks)",
    class: MiseRecipe,
    commands: [
      "AddMiseToml",
      "AddDotenv",
      "AddMiseTasksStructure",
      "AddMiseComponentsManifest",
      "AddMiseConsoleScript",
      "AddMiseBaseToml",
      "AddMiseBaseScript"
    ]
  },
  docker: {
    name: "docker",
    description: "Docker containerization setup",
    class: DockerRecipe,
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"]
  },
  node: {
    name: "node",
    description: "Node.js project template",
    class: NodeRecipe,
    commands: ["NodeCommands"]  // Placeholder - actual commands in NodeCommands.ts
  }
};

/**
 * Registry of all available commands
 */
export const COMMAND_REGISTRY: Record<string, CommandInfo> = {
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
  AddMiseComponentsManifest: {
    name: "AddMiseComponentsManifest",
    description: "Create components.toml manifest for component delegation",
    group: "mise",
    class: AddMiseComponentsManifest
  },
  AddMiseConsoleScript: {
    name: "AddMiseConsoleScript",
    description: "Create .mise/tasks/console.py dispatcher",
    group: "mise",
    class: AddMiseConsoleScript
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  },
  "sync-docs": {
    name: "sync-docs",
    description: "Sync recently modified markdown docs to DeLoDocs destination",
    group: "docs",
    class: SyncDocs,
    aliases: ["syncDocs"],
    runnable: true
  },
  doctor: {
    name: "doctor",
    description: "Validate misebase scaffolding health in the current directory",
    group: "mise",
    class: Doctor,
    aliases: ["check", "health"],
    runnable: true
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
 * Get all runnable command names
 */
export function getRunnableCommandNames(): string[] {
  return Object.values(COMMAND_REGISTRY)
    .filter((cmd) => cmd.runnable)
    .map((cmd) => cmd.name);
}

/**
 * Get command info by name
 */
export function getCommandInfo(name: string): CommandInfo | null {
  return COMMAND_REGISTRY[name] || null;
}

/**
 * Get command info by runnable name or alias
 */
export function getRunnableCommandInfo(name: string): CommandInfo | null {
  const normalized = name.trim().toLowerCase();

  for (const info of Object.values(COMMAND_REGISTRY)) {
    if (!info.runnable) {
      continue;
    }

    if (info.name.toLowerCase() === normalized) {
      return info;
    }

    if (info.aliases?.some((alias) => alias.toLowerCase() === normalized)) {
      return info;
    }
  }

  return null;
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
export function createRecipe(name: string, context: CommandContext): Recipe | null {
  const info = getRecipeInfo(name);
  if (!info) return null;
  return new info.class(context);
}

/**
 * Create runnable command instance by name/alias
 */
export function createRunnableCommand(name: string, context: CommandContext): Cmd | null {
  const info = getRunnableCommandInfo(name);
  if (!info) return null;
  return new info.class(context);
}
