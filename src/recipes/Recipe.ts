import { Command, InvokeResult, CommandContext } from "../commands/Command";

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
    console.log(`🚀 Initializing ${this.constructor.name.replace('Recipe', '').toLowerCase()} subsystem...`);
    
    for (const command of this.ingredients) {
      const result = await command.invoke();
      
      if (result.success) {
        console.log(result.message);
      } else {
        console.log(result.message);
      }
    }

    this.printNextSteps();
  }

  protected abstract printNextSteps(): void;
}