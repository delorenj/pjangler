import { Command } from "../commands/Command";
import type { CommandContext } from "../commands/Command";
import { bold, cyan, dim, green, yellow, glyph } from "../utils/style";

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
    const subsystem = this.constructor.name.replace("Recipe", "").toLowerCase();
    const dryRun = this.context.dryRun;
    console.log("");
    console.log(`  ${cyan(bold(glyph.chevron))} ${bold(`Initializing ${subsystem} subsystem`)}${dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
    console.log("");

    for (const command of this.ingredients) {
      const result = await command.invoke();
      // Indent each line so ingredient output aligns under the banner frame.
      console.log(result.message.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n"));
    }

    if (!dryRun) {
      this.printNextSteps();
    } else {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${dim("Dry-run complete — no files were modified.")}`);
      console.log(`  ${dim("Remove --dry-run to apply changes.")}`);
      console.log("");
    }
  }

  protected abstract printNextSteps(): void;
}