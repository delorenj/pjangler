---
name: pjangler-dev
description: |
  Create pjangler Commands and Recipes for project bootstrapping. Use when:
  (1) Creating a new Command class to add/generate files or directories
  (2) Creating a new Recipe that composes multiple Commands
  (3) Registering new recipes in the CLI
  (4) Adding new subsystem bootstrapping functionality
  Triggers: "pjangler command", "pjangler recipe", "add subsystem", "bootstrap", "project scaffolding"
---

# Pjangler Development

This skill is about **developing pjangler** (authoring Commands/Recipes). For _using_ pjangler
to create a project — bootstrapping CommonProject, provisioning a Hermes PM or Ticket
Sentinel (scrum master), the `.project.json` file, and bmad initialization.

Pjangler uses a Command Pattern architecture where Commands are atomic operations and Recipes compose Commands into subsystem bootstrappers.

> **Vendored templates:** the copier templates pjangler deploys are git submodules under
> `templates/commonproject` and `templates/hermes-agent`. `RunCopierTemplate` resolves the
> hermes template as: `PJANGLER_HERMES_TEMPLATE` env → vendored `templates/hermes-agent` →
> `~/code/hermes-agent-template` → `gh:delorenj/hermes-agent-template`. The `hermes-agent`
> recipe passes `ticket_provider` + `with_scrum_master` and the template binds agents to the
> repo's one board recorded in `.project.json` (it does not mint role-suffixed boards).

## Architecture Overview

```
src/
├── commands/           # Atomic file/directory operations
│   ├── Command.ts      # Base class with helpers
│   └── Add*.ts         # Individual commands
├── recipes/            # Composed command sequences
│   ├── Recipe.ts       # Base class with execution logic
│   └── *Recipe.ts      # Subsystem recipes
└── index.ts            # CLI entry point
```

## Creating a Command

Commands are atomic operations that create files or directories.

### Step 1: Create the Command File

Create `src/commands/Add<Name>.ts`:

```typescript
import { Command, InvokeResult } from "./Command";

export class Add<Name> extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "<target-file>";

    // Check existing (skip if exists unless force)
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  <file> already exists",
        filePath,
      };
    }

    const content = `<file-content>`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created <file>",
      filePath,
    };
  }
}
```

### Available Helpers

The Command base class provides:

- `this.context.targetDir` - Target directory path
- `this.context.force` - Whether to overwrite existing files
- `this.fileExists(path)` - Check if file exists relative to targetDir
- `this.writeFile(path, content)` - Write file, creating dirs as needed
- `this.createDirectory(path)` - Create directory structure

### Command Patterns

**File creation** (most common):

```typescript
async invoke(): Promise<InvokeResult> {
  const filePath = "config.json";
  if (this.fileExists(filePath) && !this.context.force) {
    return { success: false, message: "⚠️  config.json already exists", filePath };
  }
  this.writeFile(filePath, `{"key": "value"}`);
  return { success: true, message: "✅ Created config.json", filePath };
}
```

**Directory creation**:

```typescript
async invoke(): Promise<InvokeResult> {
  this.createDirectory("src/components");
  return { success: true, message: "✅ Created src/components/", filePath: "src/components" };
}
```

**Multiple files** (export multiple classes from one file):

```typescript
export class AddPackageJson extends Command { ... }
export class AddReadme extends Command { ... }
export class AddSrcDirectory extends Command { ... }
```

## Creating a Recipe

Recipes compose Commands into subsystem bootstrappers.

### Step 1: Create the Recipe File

Create `src/recipes/<Name>Recipe.ts`:

```typescript
import { Recipe } from "./Recipe";
import { AddSomeFile } from "../commands/AddSomeFile";
import { AddAnotherFile } from "../commands/AddAnotherFile";
import type { CommandContext } from "../commands/Command";

export class <Name>Recipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(AddSomeFile)
      .addIngredient(AddAnotherFile);
  }

  protected printNextSteps(): void {
    console.log("🎉 <Name> subsystem initialized!");
    console.log("   Next steps:");
    console.log("   1. <first step>");
    console.log("   2. <second step>");
  }
}
```

### Step 2: Register in CLI

Add to `src/index.ts`:

```typescript
import { <Name>Recipe } from "./recipes/<Name>Recipe";

// In the switch statement:
case "<name>":
  const recipe = new <Name>Recipe(context);
  await recipe.execute();
  break;
```

Update the list command output to include the new subsystem.

## File Naming Conventions

| Type               | Pattern                | Example            |
| ------------------ | ---------------------- | ------------------ |
| Command            | `Add<Target>.ts`       | `AddDockerfile.ts` |
| Recipe             | `<Subsystem>Recipe.ts` | `DockerRecipe.ts`  |
| Multi-command file | `<Domain>Commands.ts`  | `NodeCommands.ts`  |

## Testing Commands

Run manually to verify:

```bash
cd /tmp/test-project
bun /home/delorenj/code/pjangler/src/index.ts init <subsystem>
```

Check generated files match expectations.

## Worked target: a project-scoped agent-hooks recipe

The per-dev, committed **agent hooks + skill fan-out** layer (Claude/Codex/Hermes/Kimi hooks +
skills installed via `mise enter/leave`) is currently hand-adopted in **CoachingAgentFramework**
(`~/code/CoachingAgentFramework/.agents/hooks/` + `.mise/scripts/`) and is a prime recipe
candidate. Source of truth for *what it does* + the adopt-checklist: the **`33god-projects`**
skill → `references/project-scoped-hooks.md`; for the generic master→dialect mechanics (incl. the
worked Kimi dialect): the **`ssot-fanout`** skill.

Author Commands that drop the CAF files (parameterize the project name / pinned Hindsight bank),
then a Recipe composing them that also patches `mise.toml`:

```typescript
// commands/AgentHooksCommands.ts — one file, several Commands
export class AddHooksMaster extends Command {}        // .agents/hooks/hooks.master.json (SSOT)
export class AddHookSyncEngine extends Command {}     // .agents/hooks/sync.py + lib/{local-config,hook-guard}.sh
export class AddHindsightHooks extends Command {}     // .agents/hooks/hindsight/* + hermes/hindsight-hook.sh (adapter)
export class AddSkillLinker extends Command {}        // .mise/scripts/link-project-skills-to-clis.sh (+ unlink)
export class AddHindsightSetup extends Command {}     // .mise/scripts/hindsight-setup.sh
export class AddLocalConfigExample extends Command {} // .agents/local.example.json + .gitignore entries
export class WireMiseAgentHooks extends Command {}    // patch mise.toml enter/leave/watch_files/tasks (MERGE, not overwrite)

// recipes/AgentHooksRecipe.ts
export class AgentHooksRecipe extends Recipe {
  constructor(ctx: CommandContext) {
    super(ctx);
    this.addIngredient(AddHooksMaster)
        .addIngredient(AddHookSyncEngine)
        .addIngredient(AddHindsightHooks)
        .addIngredient(AddSkillLinker)
        .addIngredient(AddHindsightSetup)
        .addIngredient(AddLocalConfigExample)
        .addIngredient(WireMiseAgentHooks);
  }
  protected printNextSteps(): void {
    console.log("🪝 Agent-hooks layer wired. Next: `mise run hooks-sync`, commit .claude/settings.json,");
    console.log("   `mise run hindsight-setup`, and (if you run a global agent system) set");
    console.log("   .agents/local.json { skills: { defer_to_global: true } }.");
  }
}
```

`WireMiseAgentHooks` is the only non-drop-a-file Command — it must **merge** into an existing
`mise.toml` idempotently (append to `[hooks].enter/leave`, add the `watch_files` + tasks) rather
than overwrite. Keep every dropped file's bank/project-name references parameterized off
`context` so the recipe is project-agnostic. The supported per-CLI dialects (committed Claude
settings, injected Codex `hooks.json`, injected Kimi `config.toml` `[[hooks]]`, Hermes adapter)
are all driven by the one `hooks.master.json` + `sync.py`, so the recipe just drops them verbatim.

## Reference

For detailed interfaces and examples, see:

- [references/command-interface.md](references/command-interface.md) - Full Command interface
- [references/recipe-interface.md](references/recipe-interface.md) - Full Recipe interface
