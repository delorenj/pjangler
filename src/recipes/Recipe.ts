import { Command } from "../commands/Command";
import type { CommandContext } from "../commands/Command";

export interface AddIngredient<T extends Command = Command> {
  new (context: CommandContext): T;
}

export abstract class Recipe {
  protected context: CommandContext;
  protected ingredients: Command[] = [];

  constructor(context: CommandContext) {
    this.context = context;
  }

  addIngredient<T extends Command>(CommandClass: AddIngredient<T>): this {
    this.ingredients.push(new CommandClass(this.context));
    return this;
  }

  async execute(): Promise<void> {
    const dryRunPrefix = this.context.dryRun ? "[DRY RUN] " : "";
    console.log(`${dryRunPrefix}🚀 Initializing ${this.constructor.name.replace('Recipe', '').toLowerCase()} subsystem...`);

    if (this.context.dryRun) {
      console.log("⚠️  Dry-run mode: No files will be modified");
      console.log("");
    }

    for (const command of this.ingredients) {
      const result = await command.invoke();

      if (result.success) {
        console.log(result.message);
      } else {
        console.log(result.message);
      }
    }

    if (!this.context.dryRun) {
      this.printNextSteps();
    } else {
      console.log("");
      console.log("✓ Dry-run complete - no files were modified");
      console.log("  Remove --dry-run flag to apply changes");
    }
  }

  protected abstract printNextSteps(): void;
}