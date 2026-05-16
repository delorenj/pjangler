#!/usr/bin/env bun
import { Command } from "commander";
import type { CommandContext } from "./commands/Command";
import type { HermesAgentContext } from "./commands/hermes/types";
import { SOUL_TONES } from "./commands/hermes/types";
import {
  RECIPE_REGISTRY,
  COMMAND_REGISTRY,
  getRecipeNames,
  getRecipeInfo,
  getCommandNames,
  getCommandInfo,
  getCommandsByGroup,
  createRecipe
} from "./utils/registry";

const program = new Command();

program
  .name("pjangler")
  .description("Project subsystem bootstrapper CLI")
  .version("1.0.0");

// ============================================================================
// INIT COMMAND
// ============================================================================

program
  .command("init")
  .argument("<subsystem>", "Subsystem to initialize")
  .description("Initialize a project subsystem")
  .option("--dry-run", "Preview changes without writing files")
  .option("-f, --force", "Overwrite existing files")
  .action(async (subsystem: string, options) => {
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
    console.log("  pjangler init mise");
    console.log("  pjangler init docker");
    console.log("  pjangler init node");
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
          console.log(`    ${cmd.name.padEnd(30)} - ${cmd.description}`);
        }
        console.log("");
      }
    } else {
      console.log("⚙️  Available Commands:");
      console.log("");

      for (const [name, info] of Object.entries(COMMAND_REGISTRY)) {
        console.log(`  ${name.padEnd(30)} - ${info.description}`);
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
    console.log("This command is used in recipes:");
    for (const [recipeName, recipeInfo] of Object.entries(RECIPE_REGISTRY)) {
      if (recipeInfo.commands.includes(name)) {
        console.log(`  - ${recipeName}`);
      }
    }
    console.log("");
    console.log("Usage:");
    console.log(`  Part of recipe execution (not run directly)`);
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
// HERMES-AGENT COMMAND (provision a Hermes agent role into this repo)
// ============================================================================

program
  .command("hermes-agent")
  .alias("hermes")
  .description("Provision a Hermes agent role into the current repo (TUI; --yes for non-interactive)")
  .option("-y, --yes", "Non-interactive: accept all defaults (skips Telegram + email)")
  .option("--target-repo <name>", "Target repo name (default: basename of cwd)")
  .option("--role <role>", "Agent role (pm | dev | review | ops | qa | ci | ...)")
  .option("--purpose <text>", "One-line agent purpose")
  .option(`--tone <tone>`, `Personality tone (${SOUL_TONES.join(" | ")})`)
  .option("--model-provider <name>", 'Inference provider override ("" = inherit global)')
  .option("--model-name <name>", 'Model name override ("" = inherit global)')
  .option("--skip-telegram", "Skip BotFather token capture step")
  .option("--skip-email", "Skip Cloudflare Email Routing step")
  .option("--skip-runtime-repo", "Skip creating the per-agent runtime GH repo")
  .option("--skip-plane", "Skip creating the Plane project")
  .option("--skip-bloodbank", "Skip installing the Bloodbank NATS consumer")
  .option("--skip-systemd", "Skip installing systemd --user units")
  .option("--dry-run", "Preview what would run; don't execute copier")
  .option("-f, --force", "Re-render even if agents/hermes/<role>/role.yaml already exists")
  .action(async (options) => {
    const context: HermesAgentContext = {
      targetDir: process.cwd(),
      force: options.force ?? false,
      dryRun: options.dryRun ?? false,
      yes: options.yes ?? false,
      targetRepo: options.targetRepo,
      role: options.role,
      agentPurpose: options.purpose,
      soulTone: options.tone,
      modelProvider: options.modelProvider,
      modelName: options.modelName,
      skipTelegram: options.skipTelegram,
      skipEmail: options.skipEmail,
      skipRuntimeRepo: options.skipRuntimeRepo,
      skipPlane: options.skipPlane,
      skipBloodbank: options.skipBloodbank,
      skipSystemd: options.skipSystemd,
    };
    try {
      const recipe = createRecipe("hermes-agent", context);
      if (!recipe) {
        console.error("❌ hermes-agent recipe not registered");
        process.exit(1);
      }
      await recipe.execute();
    } catch (err) {
      console.error("❌ hermes-agent failed:", err);
      process.exit(1);
    }
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
