#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type { CommandContext } from "./commands/Command";
import {
  RECIPE_REGISTRY,
  COMMAND_REGISTRY,
  getRecipeNames,
  getRecipeInfo,
  getCommandNames,
  getRunnableCommandNames,
  getRunnableCommandInfo,
  getCommandInfo,
  getCommandsByGroup,
  createRecipe,
  createRunnableCommand
} from "./utils/registry";

const program = new Command();

interface InstallOptions {
  force: boolean;
  dryRun: boolean;
}

interface FileInstallResult {
  path: string;
  status: "created" | "updated" | "skipped";
}

function writeManagedFile(filePath: string, content: string, options: InstallOptions): FileInstallResult {
  const alreadyExists = existsSync(filePath);
  if (alreadyExists && !options.force) {
    return { path: filePath, status: "skipped" };
  }

  if (!options.dryRun) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

  return { path: filePath, status: alreadyExists ? "updated" : "created" };
}

function installAgentBootstrap(options: InstallOptions): {
  skillResult: FileInstallResult;
  commandResult: FileInstallResult;
  commandTargetType: "agents" | "claude";
} {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is not set; cannot install agent integration files");
  }

  const skillPath = join(home, ".agents", "skills", "pjangler", "SKILL.md");
  const agentsCommandRoot = join(home, ".agents", "commands");
  const useAgentsCommands = existsSync(agentsCommandRoot);
  const commandRoot = useAgentsCommands
    ? agentsCommandRoot
    : join(home, ".claude", "commands");
  const commandPath = join(commandRoot, "pjangler", "bootstrap.md");

  const skillContent = `---
name: pjangler
summary: Bootstrap repos with pjangler task scaffolding (misebase + doctor checks).
---

# Pjangler Skill

When asked to bootstrap this repo with pjangler:

1. Run \`pjangler init misebase --force\`
2. Run \`pjangler run doctor\`
3. Run \`mise tasks\`
4. Report:
   - files changed
   - doctor result
   - any follow-up TODOs
`;

  const commandContent = `# pjangler:bootstrap

Bootstrap the current repository using pjangler.

## Steps
1. \`pjangler init misebase --force\`
2. \`pjangler run doctor\`
3. \`mise tasks\`

## Output format
- Changes made
- Validation output
- Follow-up TODOs (if any)
`;

  const skillResult = writeManagedFile(skillPath, skillContent, options);
  const commandResult = writeManagedFile(commandPath, commandContent, options);

  return {
    skillResult,
    commandResult,
    commandTargetType: useAgentsCommands ? "agents" : "claude",
  };
}

function prettyStatus(result: FileInstallResult): string {
  if (result.status === "created") return "✅ created";
  if (result.status === "updated") return "♻️  updated";
  return "⏭️  kept";
}

program
  .name("pjangler")
  .description("Project subsystem bootstrapper CLI")
  .version("1.0.0");

// ============================================================================
// INIT COMMAND
// ============================================================================

program
  .command("init")
  .argument("[subsystem]", "Subsystem to initialize")
  .description("Initialize agent bootstrap (default) or a specific project subsystem")
  .option("--dry-run", "Preview changes without writing files")
  .option("-f, --force", "Overwrite existing files")
  .action(async (subsystem: string | undefined, options) => {
    if (!subsystem) {
      try {
        const installResult = installAgentBootstrap({
          force: options.force || false,
          dryRun: options.dryRun || false,
        });

        const dryRunPrefix = options.dryRun ? "[DRY RUN] " : "";
        console.log(`${dryRunPrefix}🧰 pjangler agent bootstrap initialized`);
        console.log("");
        console.log(`${prettyStatus(installResult.skillResult)}  skill:   ${installResult.skillResult.path}`);
        console.log(`${prettyStatus(installResult.commandResult)}  command: ${installResult.commandResult.path}`);
        console.log("");
        if (installResult.commandTargetType === "claude") {
          console.log("ℹ️  ~/.agents/commands was not found; installed command to ~/.claude/commands fallback.");
          console.log("");
        }
        console.log("Next step:");
        console.log("  Run `pjangler:bootstrap` in your coding agent to finish repo installation.");
        return;
      } catch (error) {
        console.error("❌ Error initializing pjangler agent bootstrap:", error);
        process.exit(1);
      }
    }

    const context: CommandContext = {
      targetDir: process.cwd(),
      force: options.force || false,
      dryRun: options.dryRun || false
    };

    try {
      const recipe = createRecipe(subsystem, context);
      if (!recipe) {
        console.error(`❌ Unknown subsystem: ${subsystem}`);
        console.log(`Available subsystems: ${getRecipeNames().join(", ")}`);
        process.exit(1);
      }

      await recipe.execute();
    } catch (error) {
      console.error(`❌ Error initializing ${subsystem}:`, error);
      process.exit(1);
    }
  });

// ============================================================================
// LIST COMMAND
// ============================================================================

program
  .command("list")
  .description("List available subsystems")
  .action(() => {
    console.log("Available subsystems:");
    console.log("");

    for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
      console.log(`  ${name.padEnd(10)} - ${info.description}`);
    }

    console.log("");
    console.log("Usage examples:");
    console.log("  pjangler init                     # install agent skill + bootstrap command");
    console.log("  pjangler init mise");
    console.log("  pjangler init misebase");
    console.log("  pjangler init docker");
    console.log("  pjangler init node");
    console.log("  pjangler run doctor");
    console.log("  pjangler run onboarding-prompt --force");
    console.log("  pjangler run sync-docs --since \"24 hours ago\"");
  });

// ============================================================================
// RUN COMMAND
// ============================================================================

program
  .command("run")
  .argument("<name>", "Runnable command name")
  .description("Execute a standalone runnable command")
  .option("-s, --since <time>", "Optional window for commands that support time filters (e.g. sync-docs)")
  .option("--flat", "Optional flag for commands that support flat copy mode (e.g. sync-docs)")
  .option("-c, --component <name>", "Component/repo label for prompt-style commands")
  .option("-o, --output <path>", "Output path for file-generating runnable commands")
  .option("-f, --force", "Overwrite existing generated files when supported")
  .option("--dry-run", "Preview changes without writing files")
  .action(async (name: string, options) => {
    const runnableInfo = getRunnableCommandInfo(name);
    const args: Record<string, unknown> = {};
    if (runnableInfo?.name === "sync-docs") {
      args.since = options.since ?? "24 hours ago";
      args.flat = options.flat || false;
    }

    if (runnableInfo?.name === "onboarding-prompt") {
      args.component = options.component;
      args.output = options.output;
    }

    const context: CommandContext = {
      targetDir: process.cwd(),
      force: options.force || false,
      dryRun: options.dryRun || false,
      args
    };

    try {
      const command = createRunnableCommand(name, context);
      if (!command) {
        console.error(`❌ Runnable command not found: ${name}`);
        console.log(`Available runnable commands: ${getRunnableCommandNames().join(", ")}`);
        process.exit(1);
      }

      const result = await command.invoke();
      if (!result.success) {
        console.error(result.message);
        process.exit(1);
      }

      console.log(result.message);
    } catch (error) {
      console.error(`❌ Error running command ${name}:`, error);
      process.exit(1);
    }
  });

// ============================================================================
// RECIPE COMMANDS
// ============================================================================

const recipeCmd = program
  .command("recipe")
  .description("Manage pjangler recipes");

recipeCmd
  .command("list")
  .description("List all available recipes")
  .action(() => {
    console.log("📦 Available Recipes:");
    console.log("");

    for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
      console.log(`  ${name}`);
      console.log(`    ${info.description}`);
      console.log(`    Commands: ${info.commands.join(", ")}`);
      console.log("");
    }

    console.log("Usage:");
    console.log("  pjangler recipe run <name>");
    console.log("  pjangler recipe describe <name>");
  });

recipeCmd
  .command("describe")
  .argument("<name>", "Recipe name")
  .description("Show detailed information about a recipe")
  .action((name: string) => {
    const info = getRecipeInfo(name);

    if (!info) {
      console.error(`❌ Recipe not found: ${name}`);
      console.log(`Available recipes: ${getRecipeNames().join(", ")}`);
      process.exit(1);
    }

    console.log(`📦 Recipe: ${info.name}`);
    console.log("");
    console.log(`Description: ${info.description}`);
    console.log("");
    console.log("Commands:");
    for (const cmd of info.commands) {
      console.log(`  - ${cmd}`);
    }
    console.log("");
    console.log("Usage:");
    console.log(`  pjangler recipe run ${name}`);
    console.log(`  pjangler init ${name}`);
  });

recipeCmd
  .command("run")
  .argument("<name>", "Recipe name")
  .description("Execute a specific recipe")
  .option("--dry-run", "Preview changes without writing files")
  .option("-f, --force", "Overwrite existing files")
  .action(async (name: string, options) => {
    const context: CommandContext = {
      targetDir: process.cwd(),
      force: options.force || false,
      dryRun: options.dryRun || false
    };

    try {
      const recipe = createRecipe(name, context);
      if (!recipe) {
        console.error(`❌ Recipe not found: ${name}`);
        console.log(`Available recipes: ${getRecipeNames().join(", ")}`);
        process.exit(1);
      }

      const dryRunPrefix = context.dryRun ? "[DRY RUN] " : "";
      console.log(`${dryRunPrefix}🚀 Running recipe: ${name}`);
      console.log("");
      await recipe.execute();
    } catch (error) {
      console.error(`❌ Error running recipe ${name}:`, error);
      process.exit(1);
    }
  });

// ============================================================================
// COMMAND COMMANDS
// ============================================================================

const commandCmd = program
  .command("command")
  .alias("cmd")
  .description("Manage pjangler commands");

commandCmd
  .command("list")
  .description("List all available commands")
  .option("-g, --group", "Group commands by category")
  .action((options) => {
    if (options.group) {
      console.log("⚙️  Available Commands (Grouped):");
      console.log("");

      const grouped = getCommandsByGroup();
      for (const [group, commands] of Object.entries(grouped)) {
        console.log(`  ${group.toUpperCase()}:`);
        for (const cmd of commands) {
          const runnableTag = cmd.runnable ? " [runnable]" : "";
          console.log(`    ${cmd.name.padEnd(30)} - ${cmd.description}${runnableTag}`);
        }
        console.log("");
      }
    } else {
      console.log("⚙️  Available Commands:");
      console.log("");

      for (const [name, info] of Object.entries(COMMAND_REGISTRY)) {
        const runnableTag = info.runnable ? " [runnable]" : "";
        console.log(`  ${name.padEnd(30)} - ${info.description}${runnableTag}`);
      }
      console.log("");
    }

    console.log("Usage:");
    console.log("  pj command list --group    # Group by category");
    console.log("  pj command describe <name> # Show command details");
  });

commandCmd
  .command("describe")
  .argument("<name>", "Command name")
  .description("Show detailed information about a command")
  .action((name: string) => {
    const info = getCommandInfo(name);

    if (!info) {
      console.error(`❌ Command not found: ${name}`);
      console.log(`Available commands: ${getCommandNames().join(", ")}`);
      process.exit(1);
    }

    console.log(`⚙️  Command: ${info.name}`);
    console.log("");
    console.log(`Description: ${info.description}`);
    console.log(`Group: ${info.group}`);
    console.log("");
    if (info.runnable) {
      console.log("This command can be run directly:");
      console.log(`  - pjangler run ${info.name}`);
      if (info.aliases?.length) {
        console.log(`Aliases: ${info.aliases.join(", ")}`);
      }
    } else {
      console.log("This command is used in recipes:");
      for (const [recipeName, recipeInfo] of Object.entries(RECIPE_REGISTRY)) {
        if (recipeInfo.commands.includes(name)) {
          console.log(`  - ${recipeName}`);
        }
      }
    }
    console.log("");
    console.log("Usage:");
    if (info.runnable) {
      console.log(`  pjangler run ${info.name}`);
    } else {
      console.log("  Part of recipe execution (not run directly)");
    }
  });

commandCmd
  .command("create")
  .argument("<name>", "Command name")
  .argument("<prompt>", "Description of what the command should do")
  .description("Create a new command from template (placeholder for STORY-005)")
  .option("-t, --template <type>", "Template type (toml, json, yaml, dockerfile)")
  .option("-m, --model <model>", "LLM model to use (OpenRouter)")
  .action((name: string, prompt: string, options) => {
    console.log("🚧 Command generation coming in STORY-005!");
    console.log("");
    console.log("Planned features:");
    console.log(`  - Generate ${name} from prompt: "${prompt}"`);
    if (options.template) {
      console.log(`  - Template type: ${options.template}`);
    }
    if (options.model) {
      console.log(`  - LLM model: ${options.model}`);
    }
    console.log("");
    console.log("This feature will be implemented in the Template Generation System story.");
    console.log("For now, manually create commands in src/commands/");
  });

// ============================================================================
// DESCRIBE COMMAND (Project description)
// ============================================================================

program
  .command("describe")
  .description("Describe the current project (for AI context)")
  .action(() => {
    console.log("🔍 Project Description (placeholder for future enhancement)");
    console.log("");
    console.log("This command will analyze the project and provide:");
    console.log("  - Detected project type");
    console.log("  - Installed subsystems");
    console.log("  - Configuration files present");
    console.log("  - Suggested next steps");
    console.log("");
    console.log("Coming soon!");
  });

program.parse();
