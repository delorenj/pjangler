#!/usr/bin/env node
import { Command } from "commander";
import type { CommandContext } from "./commands/Command";
import type { HermesAgentContext } from "./commands/hermes/types";
import { SOUL_TONES } from "./commands/hermes/types";
import { EnsureTemplateConfig } from "./commands/hermes/EnsureTemplateConfig";
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
import { multiselect, isCancel } from "@clack/prompts";
import { runAudit, runMigration, runMigrationForRules, formatAuditReport, formatMigrationReport, getParityRuleIds, type AuditFinding } from "./parity/index";
import {
  doctorProjectRegistry,
  executeProjectInitPlan,
  formatProjectInitPlan,
  formatProjectList,
  getProject,
  loadProjectRegistry,
  planProjectInit,
  projectRegistryPath,
} from "./project/index";
import { PJANGLER_VERSION } from "./utils/version";
import type { MigrationReport } from "./parity/index";

function printMigrationReport(report: MigrationReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMigrationReport(report));
  }
}

async function promptForRuleIds(rules: AuditFinding[]): Promise<string[]> {
  const options = rules
    .filter((rule) => rule.fixable)
    .map((rule) => ({
      value: rule.id,
      label: `${rule.id} [${rule.status}] ${rule.title}`,
      hint: rule.summary,
    }));

  if (!options.length) {
    return [];
  }

  const initialValues = rules
    .filter((rule) => rule.fixable && rule.status !== "pass" && rule.status !== "skip")
    .map((rule) => rule.id);

  const selected = await multiselect<string>({
    message: "Select parity rules to apply (space to toggle, enter to confirm):",
    options,
    initialValues,
  });

  if (isCancel(selected)) {
    return [];
  }

  return selected;
}

const program = new Command();

program
  .name("pjangler")
  .description("Project subsystem bootstrapper CLI")
  .version(PJANGLER_VERSION);

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
// PROJECT REGISTRY COMMANDS
// ============================================================================

const projectCmd = program
  .command("project")
  .description("Manage the pjangler project registry");

projectCmd
  .command("init")
  .argument("<name>", "Project display name")
  .description("Plan or apply a registry-backed CommonProject initialization")
  .requiredOption("--description <text>", "Project description")
  .option("--target-dir <path>", "Target repo path")
  .option("--source-skill <path>", "Source skill/template provenance path")
  .option("--primary-language <language>", "Primary language for CommonProject rendering", "python")
  .option("--provision-agent", "Plan local Hermes PM agent provisioning")
  .option("--apply", "Write the registry and render the repo scaffold")
  .option("--dry-run", "Preview changes without writing files (default)")
  .option("--live", "Allow live/network/cloud provisioning actions")
  .option("--slug <slug>", "Project registry slug override")
  .option("--identifier <identifier>", "Ticket identifier override")
  .option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`)
  .option("-f, --force", "Allow replacing an existing registry entry and re-rendering files")
  .option("--json", "Output machine-parseable JSON")
  .action((name: string, options) => {
    try {
      const apply = Boolean(options.apply && !options.dryRun);
      const plan = planProjectInit({
        name,
        description: options.description,
        targetDir: options.targetDir,
        sourceSkill: options.sourceSkill,
        primaryLanguage: options.primaryLanguage,
        provisionAgent: options.provisionAgent ?? false,
        apply,
        live: options.live ?? false,
        projectSlug: options.slug,
        projectIdentifier: options.identifier,
        registryPath: options.registry,
        force: options.force ?? false,
        overwrite: options.force ?? false,
        cwd: process.cwd(),
      });

      if (!apply) {
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else console.log(formatProjectInitPlan(plan));
        return;
      }

      const result = executeProjectInitPlan(plan);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatProjectInitPlan(plan));
        for (const line of result.logs) console.log(line);
        for (const line of result.errors) console.error(line);
        if (result.ok) console.log(`Project registered: ${plan.project.slug}`);
      }
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
      } else {
        console.error("❌ project init failed:", err instanceof Error ? err.message : err);
      }
      process.exit(1);
    }
  });

projectCmd
  .command("list")
  .description("List projects in the pjangler registry")
  .option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`)
  .option("--json", "Output machine-parseable JSON")
  .action((options) => {
    try {
      const registry = loadProjectRegistry(options.registry ?? projectRegistryPath());
      if (options.json) console.log(JSON.stringify(registry, null, 2));
      else console.log(formatProjectList(registry));
    } catch (err) {
      console.error("❌ project list failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

projectCmd
  .command("show")
  .argument("<slug>", "Project slug")
  .description("Show one project from the pjangler registry")
  .option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`)
  .option("--json", "Output machine-parseable JSON")
  .action((slug: string, options) => {
    try {
      const project = getProject(loadProjectRegistry(options.registry ?? projectRegistryPath()), slug);
      if (options.json) console.log(JSON.stringify(project, null, 2));
      else console.log(`${project.name} (${project.slug})\n${project.repo_path}\n${project.description}`);
    } catch (err) {
      console.error("❌ project show failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

projectCmd
  .command("doctor")
  .argument("[slug]", "Optional project slug")
  .description("Validate the project registry and local projections")
  .option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`)
  .option("--json", "Output machine-parseable JSON")
  .action((slug: string | undefined, options) => {
    try {
      const report = doctorProjectRegistry(options.registry ?? projectRegistryPath(), slug);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (!report.issues.length) {
        console.log(`Project registry OK: ${report.registryPath}`);
      } else {
        console.log(`Project registry issues: ${report.registryPath}`);
        for (const issue of report.issues) console.log(`  [${issue.level}] ${issue.slug ?? "registry"}: ${issue.message}`);
      }
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error("❌ project doctor failed:", err instanceof Error ? err.message : err);
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
// AUDIT COMMAND
// ============================================================================

program
  .command("audit")
  .argument("[repo]", "Path to repo to audit (default: cwd)")
  .description("Deterministic parity audit against 33god project standard")
  .option("--json", "Output machine-parseable JSON")
  .action((repo: string | undefined, options) => {
    try {
      const report = runAudit(repo);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatAuditReport(report));
      }
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error("❌ audit failed:", err);
      process.exit(1);
    }
  });

// ============================================================================
// MIGRATE COMMAND
// ============================================================================

program
  .command("migrate")
  .argument("[rule-id]", "Rule ID to migrate (omit to open interactive rule selector)")
  .argument("[repo]", "Path to repo (default: cwd)")
  .description("Idempotent migration recipe for a parity rule (or open the rule selector)")
  .option("--all", "Apply every migration recipe in order")
  .option("--dry-run", "Preview changes without writing files")
  .option("--json", "Output machine-parseable JSON")
  .action(async (ruleId: string | undefined, repo: string | undefined, options) => {
    try {
      const all = options.all ?? false;
      const dryRun = options.dryRun ?? false;

      if (all) {
        // When --all is used, any positional argument is the repo path, not a rule-id.
        let actualRepo = repo;
        if (ruleId && !actualRepo) {
          actualRepo = ruleId;
        }
        const report = runMigration(undefined, actualRepo, dryRun, true);
        printMigrationReport(report, options.json);
        process.exit(report.ok ? 0 : 1);
      }

      // Explicit rule-id + repo.
      if (ruleId && repo) {
        if (!getParityRuleIds().includes(ruleId)) {
          console.error(`❌ Unknown parity rule: ${ruleId}`);
          process.exit(1);
        }
        const report = runMigration(ruleId, repo, dryRun, false);
        printMigrationReport(report, options.json);
        process.exit(report.ok ? 0 : 1);
      }

      // Single valid rule-id applies to cwd.
      if (ruleId && getParityRuleIds().includes(ruleId)) {
        const report = runMigration(ruleId, undefined, dryRun, false);
        printMigrationReport(report, options.json);
        process.exit(report.ok ? 0 : 1);
      }

      // Non-interactive JSON mode cannot show the TUI.
      if (options.json) {
        console.error("❌ JSON output requires a rule-id or --all");
        process.exit(1);
      }

      // Non-TTY environments cannot show the TUI.
      if (!process.stdin.isTTY) {
        console.error("❌ Provide a rule-id, use --all, or run in an interactive terminal");
        process.exit(1);
      }

      // No rule-id (or a lone positional that isn't a valid rule-id) opens the TUI.
      const targetRepo = ruleId ?? repo;
      const audit = runAudit(targetRepo);
      const ruleIds = await promptForRuleIds(audit.rules);
      if (!ruleIds.length) {
        console.log("No rules selected; nothing to migrate.");
        process.exit(0);
      }
      const report = runMigrationForRules(ruleIds, targetRepo, dryRun);
      printMigrationReport(report, false);
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error("❌ migrate failed:", err);
      process.exit(1);
    }
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
  .option("--model-provider <name>", 'Inference provider override ("" = inherit shared default profile)')
  .option("--model-name <name>", 'Model name override ("" = inherit shared default profile)')
  .option("--skip-telegram", "Skip BotFather token capture step")
  .option("--skip-email", "Skip Cloudflare Email Routing step")
  .option("--skip-runtime-repo", "Skip creating the per-agent runtime GH repo")
  .option("--skip-plane", "Skip creating the Plane project")
  .option("--skip-bloodbank", "Skip installing the Bloodbank NATS consumer")
  .option("--skip-systemd", "Skip installing systemd --user units")
  .option("--local", "Local-only: skip runtime repo, Plane, Bloodbank, and systemd (safe for laptops/macOS/non-technical operators)")
  .option("--force-config", "Regenerate ~/.config/hermes-agent-template/config.toml even if it exists")
  .option("--dry-run", "Preview what would run; don't execute copier")
  .option("-f, --force", "Re-render even if agents/hermes/<role>/role.yaml already exists")
  .action(async (options) => {
    const isDarwin = process.platform === "darwin";
    const local: boolean = options.local ?? false;
    const context: HermesAgentContext = {
      targetDir: process.cwd(),
      force: options.force ?? false,
      dryRun: options.dryRun ?? false,
      yes: options.yes ?? false,
      local,
      forceConfig: options.forceConfig ?? false,
      targetRepo: options.targetRepo,
      role: options.role,
      agentPurpose: options.purpose,
      soulTone: options.tone,
      modelProvider: options.modelProvider,
      modelName: options.modelName,
      skipTelegram: options.skipTelegram,
      skipEmail: options.skipEmail,
      // --local (and macOS, for systemd) flip the heavy/irreversible steps off
      // by default so a non-technical operator can't accidentally create cloud
      // resources under the wrong account or hit systemd on a Mac. An explicit
      // --skip-* still forces the skip; passing neither + not --local keeps the
      // full provisioning behavior for the authoring machine.
      skipRuntimeRepo: options.skipRuntimeRepo ?? local,
      skipPlane: options.skipPlane ?? local,
      skipBloodbank: options.skipBloodbank ?? local,
      skipSystemd: options.skipSystemd ?? (local || isDarwin),
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
// CONFIG COMMAND (bootstrap host config for the hermes-agent template)
// ============================================================================

const configCmd = program
  .command("config")
  .description("Manage host/provisioner configuration");

configCmd
  .command("bootstrap")
  .description("Create ~/.config/hermes-agent-template/config.toml with host-correct defaults if missing")
  .option("--force", "Overwrite an existing config file")
  .option("--dry-run", "Show what would be written without writing")
  .action(async (options) => {
    const ctx: HermesAgentContext = {
      targetDir: process.cwd(),
      dryRun: options.dryRun ?? false,
      forceConfig: options.force ?? false,
    };
    const result = await new EnsureTemplateConfig(ctx).invoke();
    if (!result.success) {
      if (result.message) console.error(result.message);
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
