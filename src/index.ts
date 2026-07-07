#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
import { cancel, multiselect, text, isCancel } from "@clack/prompts";
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
import { bold, cyan, dim, green, red, yellow, glyph, heading } from "./utils/style";
import type { MigrationReport } from "./parity/index";

/** Red ✖ prefix for user-facing error lines. */
const xmark = `${red(glyph.fail)}`;

type JsonObject = Record<string, unknown>;

interface ProjectInitCliOptions {
  description?: string;
  targetDir?: string;
  sourceSkill?: string;
  primaryLanguage?: string;
  provisionAgent?: boolean;
  agentRole?: string;
  apply?: boolean;
  dryRun?: boolean;
  live?: boolean;
  slug?: string;
  identifier?: string;
  registry?: string;
  force?: boolean;
  yes?: boolean;
  tui?: boolean;
  json?: boolean;
}

interface ProjectInitSelection {
  selectedOperations: string[];
  selectedParityRules: string[];
}

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

function readJson(path: string): JsonObject | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function findGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return resolve(result.stdout.trim());
}

function packageNameToProjectName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = value.split("/").pop() ?? value;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function deriveProjectDefaults(targetDir: string): { name: string; description: string; slug?: string; identifier?: string } {
  const manifest = readJson(join(targetDir, ".project.json"));
  const pkg = readJson(join(targetDir, "package.json"));
  const name =
    String(manifest?.project_name ?? "").trim() ||
    packageNameToProjectName(typeof pkg?.name === "string" ? pkg.name : undefined) ||
    packageNameToProjectName(basename(targetDir)) ||
    "Project";
  const ticketProvider = manifest?.ticket_provider && typeof manifest.ticket_provider === "object" ? (manifest.ticket_provider as JsonObject) : {};
  return {
    name,
    description: String(manifest?.project_description ?? pkg?.description ?? ""),
    slug: typeof manifest?.project_slug === "string" ? manifest.project_slug : undefined,
    identifier: typeof ticketProvider.identifier === "string" ? ticketProvider.identifier : undefined,
  };
}

function isInteractiveProjectInit(options: ProjectInitCliOptions): boolean {
  return !options.json && !options.yes && options.tui !== false && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptTextValue(message: string, initialValue?: string): Promise<string> {
  const value = await text({
    message,
    initialValue,
    validate: (input) => input?.trim() ? undefined : "Required",
  });
  if (isCancel(value)) {
    cancel("project init cancelled");
    process.exit(1);
  }
  return value.trim();
}

function projectInitActionLabel(kind: string): string {
  switch (kind) {
    case "registry.upsert":
      return "Register/update project registry entry";
    case "copier.copy.commonproject":
      return "Render CommonProject scaffold";
    case "project.write-manifest":
      return "Write repo-local .project.json projection";
    case "plane.create-or-link":
      return "Create/link ticket provider project";
    case "hermes.provision-agent":
      return "Provision Hermes agent";
    default:
      return kind;
  }
}

function registryNeedsUpsert(plan: ReturnType<typeof planProjectInit>): boolean {
  const registry = loadProjectRegistry(plan.registryPath);
  const existing = registry.projects[plan.project.slug];
  if (!existing) return true;
  const { created_at: _existingCreated, updated_at: _existingUpdated, ...existingComparable } = existing;
  const { created_at: _projectCreated, updated_at: _projectUpdated, ...projectComparable } = plan.project;
  return JSON.stringify(existingComparable) !== JSON.stringify(projectComparable);
}

function actionNeedsRun(plan: ReturnType<typeof planProjectInit>, kind: string, syncMode: boolean): boolean {
  if (kind === "registry.upsert") return registryNeedsUpsert(plan);
  if (kind === "project.write-manifest") {
    const action = plan.actions.find((item) => item.kind === "project.write-manifest");
    if (!action || action.kind !== "project.write-manifest") return false;
    const next = `${JSON.stringify(action.manifest, null, 2)}\n`;
    return !existsSync(action.path) || readFileSync(action.path, "utf8") !== next;
  }
  if (kind === "copier.copy.commonproject") return true;
  if (kind === "plane.create-or-link") return plan.actions.some((action) => action.kind === kind && action.enabled);
  if (kind === "hermes.provision-agent") return plan.actions.some((action) => action.kind === kind && action.enabled);
  return true;
}

async function selectProjectInitOperations(input: {
  plan: ReturnType<typeof planProjectInit>;
  auditRules: AuditFinding[];
  syncMode: boolean;
  options: ProjectInitCliOptions;
}): Promise<ProjectInitSelection> {
  const planOperations = input.plan.actions
    .filter((action) => actionNeedsRun(input.plan, action.kind, input.syncMode))
    .map((action) => ({
      value: action.kind,
      label: projectInitActionLabel(action.kind),
      hint: action.kind === "registry.upsert" ? input.plan.registryPath : action.kind,
    }));
  const parityOperations = input.auditRules
    .filter((rule) => rule.fixable && rule.status !== "pass" && rule.status !== "skip")
    .map((rule) => ({
      value: `parity:${rule.id}`,
      label: `${rule.title}`,
      hint: `${rule.id}: ${rule.summary}`,
    }));
  const operations = [...planOperations, ...parityOperations];
  const all = operations.map((operation) => operation.value);
  if (input.options.yes || (input.options.apply && !isInteractiveProjectInit(input.options))) {
    return {
      selectedOperations: all,
      selectedParityRules: parityOperations.map((operation) => operation.value.replace(/^parity:/, "")),
    };
  }
  if (input.options.dryRun || !isInteractiveProjectInit(input.options)) {
    return { selectedOperations: [], selectedParityRules: [] };
  }
  if (!operations.length) return { selectedOperations: [], selectedParityRules: [] };
  const selected = await multiselect<string>({
    message: "Select project init operations to run:",
    options: operations,
    initialValues: all,
  });
  if (isCancel(selected)) {
    cancel("project init cancelled");
    process.exit(1);
  }
  return {
    selectedOperations: selected,
    selectedParityRules: selected.filter((value) => value.startsWith("parity:")).map((value) => value.replace(/^parity:/, "")),
  };
}

async function resolveProjectInitTarget(name: string | undefined, options: ProjectInitCliOptions): Promise<{ name: string; targetDir: string; description: string; syncMode: boolean; slug?: string; identifier?: string }> {
  const interactive = isInteractiveProjectInit(options);
  const cwd = process.cwd();
  const cwdGitRoot = findGitRoot(cwd);
  let targetDir = options.targetDir ? resolve(options.targetDir) : undefined;

  if (!targetDir && cwdGitRoot) {
    targetDir = cwdGitRoot;
  }

  if (!targetDir && interactive) {
    const defaultName = name ?? basename(cwd);
    const promptedName = name ?? await promptTextValue("Project name", packageNameToProjectName(defaultName));
    const defaultDir = join(cwd, promptedName.replace(/[^A-Za-z0-9._-]/g, "") || promptedName.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    targetDir = await promptTextValue("Project directory", defaultDir);
    name = promptedName;
  }

  if (!targetDir) {
    if (!name) throw new Error("Project name or --target-dir is required when project init is not run inside a git repo");
    targetDir = resolve(process.cwd(), name.replace(/[^A-Za-z0-9._-]/g, "") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  }

  const targetExists = existsSync(targetDir);
  if (targetExists && !statSync(targetDir).isDirectory()) throw new Error(`Target path is not a directory: ${targetDir}`);
  const targetGitRoot = targetExists ? findGitRoot(targetDir) : undefined;
  const syncMode = Boolean(targetGitRoot && resolve(targetGitRoot) === resolve(targetDir));

  const defaults = targetExists ? deriveProjectDefaults(targetDir) : { name: packageNameToProjectName(basename(targetDir)) ?? "Project", description: "" };
  if (!name && interactive && !syncMode) {
    name = await promptTextValue("Project name", defaults.name);
  }

  return {
    name: name ?? defaults.name,
    targetDir,
    description: options.description ?? defaults.description,
    syncMode,
    slug: options.slug ?? defaults.slug,
    identifier: options.identifier ?? defaults.identifier,
  };
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
        console.error(`${xmark} Unknown subsystem: ${bold(subsystem)}`);
        console.error(`  ${dim("Available:")} ${getRecipeNames().map((available) => cyan(available)).join(dim(", "))}`);
        process.exit(1);
      }

      await recipe.execute();
    } catch (error) {
      console.error(`${xmark} Error initializing ${bold(subsystem)}:`, error);
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
    const width = Object.keys(RECIPE_REGISTRY).reduce((max, name) => Math.max(max, name.length), 0);
    console.log("");
    console.log(`  ${heading("Available subsystems")}`);
    console.log("");
    for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
      console.log(`  ${cyan(name.padEnd(width))}  ${dim(info.description)}`);
    }
    console.log("");
    console.log(`  ${dim("Examples")}`);
    for (const example of ["pj init mise", "pj init docker", "pj init node"]) {
      console.log(`     ${dim(glyph.pointer)} ${dim(example)}`);
    }
    console.log("");
  });

// ============================================================================
// PROJECT REGISTRY COMMANDS
// ============================================================================

const projectCmd = program
  .command("project")
  .description("Manage the pjangler project registry");

projectCmd
  .command("init")
  .argument("[name]", "Project display name")
  .description("Plan or apply a registry-backed CommonProject initialization or legacy repo sync")
  .option("--description <text>", "Project description")
  .option("--target-dir <path>", "Target repo path")
  .option("--source-skill <path>", "Source skill/template provenance path")
  .option("--primary-language <language>", "Primary language for CommonProject rendering", "python")
  .option("--provision-agent", "Plan local Hermes PM agent provisioning")
  .option("--agent-role <role>", "Hermes agent role to plan when --provision-agent is set", "pm")
  .option("--apply", "Write the registry and render the repo scaffold")
  .option("--dry-run", "Preview changes without writing files (default)")
  .option("--live", "Allow live/network/cloud provisioning actions")
  .option("--slug <slug>", "Project registry slug override")
  .option("--identifier <identifier>", "Ticket identifier override")
  .option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`)
  .option("-f, --force", "Allow replacing an existing registry entry and re-rendering files")
  .option("-y, --yes", "Apply every proposed operation without prompting")
  .option("--no-tui", "Disable interactive prompts")
  .option("--json", "Output machine-parseable JSON")
  .action(async (name: string | undefined, options: ProjectInitCliOptions) => {
    try {
      const target = await resolveProjectInitTarget(name, options);
      const interactive = isInteractiveProjectInit(options);
      const apply = Boolean(!options.dryRun && (options.yes || options.apply || interactive));
      const plan = planProjectInit({
        name: target.name,
        description: target.description,
        targetDir: target.targetDir,
        sourceSkill: options.sourceSkill,
        primaryLanguage: options.primaryLanguage,
        provisionAgent: options.provisionAgent ?? false,
        agentRole: options.agentRole,
        apply,
        live: options.live ?? false,
        projectSlug: target.slug,
        projectIdentifier: target.identifier,
        registryPath: options.registry,
        force: options.force ?? false,
        overwrite: options.force ?? false,
        cwd: process.cwd(),
        scaffold: !target.syncMode,
      });
      const audit = target.syncMode ? runAudit(target.targetDir) : undefined;
      const selection = await selectProjectInitOperations({
        plan,
        auditRules: audit?.rules ?? [],
        syncMode: target.syncMode,
        options,
      });
      const selectedPlanActionKinds = new Set(selection.selectedOperations.filter((value) => !value.startsWith("parity:")));
      const selectedPlan = {
        ...plan,
        apply,
        dryRun: !apply,
        actions: apply ? plan.actions.filter((action) => selectedPlanActionKinds.has(action.kind)) : plan.actions,
      };

      if (!apply) {
        const payload = {
          ...plan,
          mode: target.syncMode ? "sync" : "create",
          audit,
          proposedOperations: [
            ...plan.actions
              .filter((action) => actionNeedsRun(plan, action.kind, target.syncMode))
              .map((action) => action.kind),
            ...(audit?.rules ?? [])
              .filter((rule) => rule.fixable && rule.status !== "pass" && rule.status !== "skip")
              .map((rule) => `parity:${rule.id}`),
          ],
        };
        if (options.json) console.log(JSON.stringify(payload, null, 2));
        else {
          console.log(formatProjectInitPlan(plan));
          if (payload.proposedOperations.length) {
            console.log(`  ${bold("Proposed operations")} ${dim(`(${payload.proposedOperations.length})`)}`);
            for (const operation of payload.proposedOperations) console.log(`     ${cyan(glyph.bullet)} ${operation}`);
          } else {
            console.log(`  ${green(glyph.pass)} ${dim("Project is already in parity.")}`);
          }
          console.log("");
        }
        return;
      }

      const initResult = selectedPlan.actions.length
        ? executeProjectInitPlan(selectedPlan)
        : { ok: true, plan: selectedPlan, logs: [], errors: [], changedFiles: [] };
      const migrationReport = selection.selectedParityRules.length
        ? runMigrationForRules(selection.selectedParityRules, target.targetDir, false)
        : undefined;
      const migrationErrors = migrationReport?.results
        .filter((result) => result.status === "blocked")
        .map((result) => `${result.id}: ${result.summary}`) ?? [];
      const changedFiles = Array.from(new Set([
        ...initResult.changedFiles,
        ...(migrationReport?.changedFiles ?? []),
      ])).sort();
      const result = {
        ok: initResult.ok && (migrationReport?.ok ?? true),
        mode: target.syncMode ? "sync" : "create",
        plan: selectedPlan,
        audit,
        selectedOperations: selection.selectedOperations,
        selectedParityRules: selection.selectedParityRules,
        logs: initResult.logs,
        errors: [...initResult.errors, ...migrationErrors],
        changedFiles,
        migrationReport,
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatProjectInitPlan(selectedPlan));
        for (const line of result.logs) console.log(line);
        for (const line of result.errors) console.error(`  ${xmark} ${line}`);
        if (migrationReport) console.log(formatMigrationReport(migrationReport));
        if (result.ok && changedFiles.length) console.log(`  ${green(glyph.pass)} ${bold("Project synchronized")}  ${dim(glyph.dot)}  ${cyan(plan.project.slug)}\n`);
        if (result.ok && changedFiles.length === 0) console.log(`  ${green(glyph.pass)} ${dim("Already in parity")}  ${dim(glyph.dot)}  ${cyan(plan.project.slug)}\n`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
      } else {
        console.error(`${xmark} project init failed:`, err instanceof Error ? err.message : err);
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
      console.error(`${xmark} project list failed:`, err instanceof Error ? err.message : err);
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
      if (options.json) {
        console.log(JSON.stringify(project, null, 2));
      } else {
        console.log("");
        console.log(`  ${heading(project.name)} ${dim(`(${project.slug})`)}`);
        console.log(`  ${dim(project.repo_path)}`);
        if (project.description) console.log(`  ${project.description}`);
        console.log("");
      }
    } catch (err) {
      console.error(`${xmark} project show failed:`, err instanceof Error ? err.message : err);
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
        console.log("");
        console.log(`  ${green(glyph.pass)} ${bold("Project registry OK")}  ${dim(glyph.dot)}  ${dim(report.registryPath)}`);
        console.log("");
      } else {
        console.log("");
        console.log(`  ${red(glyph.fail)} ${bold("Project registry issues")}  ${dim(glyph.dot)}  ${dim(report.registryPath)}`);
        console.log("");
        for (const issue of report.issues) {
          const mark = issue.level === "error" ? red(glyph.fail) : yellow(glyph.warn);
          console.log(`  ${mark}  ${bold(issue.slug ?? "registry")}  ${issue.message}`);
        }
        console.log("");
      }
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error(`${xmark} project doctor failed:`, err instanceof Error ? err.message : err);
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
    console.log("");
    console.log(`  ${heading("Recipes")}`);
    console.log("");
    for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
      console.log(`  ${cyan(bold(name))}`);
      console.log(`     ${dim(info.description)}`);
      console.log(`     ${dim("commands")}  ${info.commands.map((command) => cyan(command)).join(dim(", "))}`);
      console.log("");
    }
    console.log(`  ${dim("Usage")}`);
    console.log(`     ${dim(glyph.pointer)} ${dim("pj recipe run <name>")}`);
    console.log(`     ${dim(glyph.pointer)} ${dim("pj recipe describe <name>")}`);
    console.log("");
  });

recipeCmd
  .command("describe")
  .argument("<name>", "Recipe name")
  .description("Show detailed information about a recipe")
  .action((name: string) => {
    const info = getRecipeInfo(name);

    if (!info) {
      console.error(`${xmark} Recipe not found: ${bold(name)}`);
      console.error(`  ${dim("Available:")} ${getRecipeNames().map((available) => cyan(available)).join(dim(", "))}`);
      process.exit(1);
    }

    console.log("");
    console.log(`  ${heading(info.name)}`);
    console.log(`  ${dim(info.description)}`);
    console.log("");
    console.log(`  ${bold("Commands")}`);
    for (const command of info.commands) console.log(`     ${cyan(glyph.bullet)} ${command}`);
    console.log("");
    console.log(`  ${dim("Usage")}`);
    console.log(`     ${dim(glyph.pointer)} ${dim(`pj recipe run ${name}`)}`);
    console.log(`     ${dim(glyph.pointer)} ${dim(`pj init ${name}`)}`);
    console.log("");
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
        console.error(`${xmark} Recipe not found: ${bold(name)}`);
        console.error(`  ${dim("Available:")} ${getRecipeNames().map((available) => cyan(available)).join(dim(", "))}`);
        process.exit(1);
      }

      await recipe.execute();
    } catch (error) {
      console.error(`${xmark} Error running recipe ${bold(name)}:`, error);
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
    console.log("");
    if (options.group) {
      console.log(`  ${heading("Commands by category")}`);
      for (const [group, commands] of Object.entries(getCommandsByGroup())) {
        const width = commands.reduce((max, command) => Math.max(max, command.name.length), 0);
        console.log("");
        console.log(`  ${bold(group.toUpperCase())}`);
        for (const command of commands) {
          console.log(`     ${cyan(command.name.padEnd(width))}  ${dim(command.description)}`);
        }
      }
      console.log("");
    } else {
      const width = Object.keys(COMMAND_REGISTRY).reduce((max, name) => Math.max(max, name.length), 0);
      console.log(`  ${heading("Commands")}`);
      console.log("");
      for (const [name, info] of Object.entries(COMMAND_REGISTRY)) {
        console.log(`  ${cyan(name.padEnd(width))}  ${dim(info.description)}`);
      }
      console.log("");
    }

    console.log(`  ${dim("Usage")}`);
    console.log(`     ${dim(glyph.pointer)} ${dim("pj command list --group")}     ${dim("# group by category")}`);
    console.log(`     ${dim(glyph.pointer)} ${dim("pj command describe <name>")}  ${dim("# command details")}`);
    console.log("");
  });

commandCmd
  .command("describe")
  .argument("<name>", "Command name")
  .description("Show detailed information about a command")
  .action((name: string) => {
    const info = getCommandInfo(name);

    if (!info) {
      console.error(`${xmark} Command not found: ${bold(name)}`);
      console.error(`  ${dim("Available:")} ${getCommandNames().map((available) => cyan(available)).join(dim(", "))}`);
      process.exit(1);
    }

    const usedIn = Object.entries(RECIPE_REGISTRY)
      .filter(([, recipeInfo]) => recipeInfo.commands.includes(name))
      .map(([recipeName]) => recipeName);

    console.log("");
    console.log(`  ${heading(info.name)}`);
    console.log(`  ${dim(info.description)}`);
    console.log("");
    console.log(`  ${dim("group".padEnd(7))} ${cyan(info.group)}`);
    console.log(`  ${dim("recipes".padEnd(7))} ${usedIn.length ? usedIn.map((recipeName) => cyan(recipeName)).join(dim(", ")) : dim("(none)")}`);
    console.log("");
    console.log(`  ${dim("Part of recipe execution (not run directly).")}`);
    console.log("");
  });

commandCmd
  .command("create")
  .argument("<name>", "Command name")
  .argument("<prompt>", "Description of what the command should do")
  .description("Create a new command from template (placeholder for STORY-005)")
  .option("-t, --template <type>", "Template type (toml, json, yaml, dockerfile)")
  .option("-m, --model <model>", "LLM model to use (OpenRouter)")
  .action((name: string, prompt: string, options) => {
    console.log("");
    console.log(`  ${yellow(glyph.warn)} ${bold("Command generation coming in STORY-005")}`);
    console.log("");
    console.log(`  ${dim("Planned")}`);
    console.log(`     ${cyan(glyph.bullet)} Generate ${bold(name)} from prompt: ${dim(`"${prompt}"`)}`);
    if (options.template) console.log(`     ${cyan(glyph.bullet)} Template type: ${cyan(options.template)}`);
    if (options.model) console.log(`     ${cyan(glyph.bullet)} LLM model: ${cyan(options.model)}`);
    console.log("");
    console.log(`  ${dim("For now, manually create commands in src/commands/")}`);
    console.log("");
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
      console.error(`${xmark} audit failed:`, err);
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
          console.error(`${xmark} Unknown parity rule: ${bold(ruleId)}`);
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
        console.error(`${xmark} JSON output requires a rule-id or --all`);
        process.exit(1);
      }

      // Non-TTY environments cannot show the TUI.
      if (!process.stdin.isTTY) {
        console.error(`${xmark} Provide a rule-id, use --all, or run in an interactive terminal`);
        process.exit(1);
      }

      // No rule-id (or a lone positional that isn't a valid rule-id) opens the TUI.
      const targetRepo = ruleId ?? repo;
      const audit = runAudit(targetRepo);
      const ruleIds = await promptForRuleIds(audit.rules);
      if (!ruleIds.length) {
        console.log(`  ${cyan(glyph.info)} ${dim("No rules selected; nothing to migrate.")}`);
        process.exit(0);
      }
      const report = runMigrationForRules(ruleIds, targetRepo, dryRun);
      printMigrationReport(report, false);
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error(`${xmark} migrate failed:`, err);
      process.exit(1);
    }
  });

// ============================================================================
// HERMES-AGENT COMMAND (provision a Hermes agent role into this repo)
// ============================================================================

program
  .command("hermes-agent")
  .alias("hermes")
  .description("Provision the PM agent for the current repo (defaults everything; only asks about Telegram)")
  .option("-y, --yes", "Non-interactive: accept all defaults (also skips the Telegram prompt)")
  .option("--target-repo <name>", "Target repo name (default: basename of cwd)")
  .option("--role <role>", "Agent role override (default: pm — the only role in the fleet)")
  .option("--purpose <text>", "One-line agent purpose (default: \"pm agent for <repo>\")")
  .option(`--tone <tone>`, `Personality tone (default: direct; ${SOUL_TONES.join(" | ")})`)
  .option("--model-provider <name>", 'Inference provider override ("" = inherit shared default profile)')
  .option("--model-name <name>", 'Model name override ("" = inherit shared default profile)')
  .option("--skip-telegram", "Skip the Telegram wire-up (no BotFather prompt)")
  .option("--email", "Also provision the delo.sh email address (off by default; never prompted)")
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
      // Email is opt-in only: `--email` wires it, otherwise it's never done.
      skipEmail: options.email ? false : undefined,
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
        console.error(`${xmark} hermes-agent recipe not registered`);
        process.exit(1);
      }
      await recipe.execute();
    } catch (err) {
      console.error(`${xmark} hermes-agent failed:`, err);
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
    console.log("");
    console.log(`  ${heading("Project description")} ${dim("(placeholder)")}`);
    console.log("");
    console.log(`  ${dim("Will analyze the project and report:")}`);
    for (const item of ["Detected project type", "Installed subsystems", "Configuration files present", "Suggested next steps"]) {
      console.log(`     ${cyan(glyph.bullet)} ${item}`);
    }
    console.log("");
    console.log(`  ${dim("Coming soon.")}`);
    console.log("");
  });

program.parse();
