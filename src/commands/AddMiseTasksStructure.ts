import { Command, InvokeResult, CommandContext } from "./Command";

export class AddMiseTasksStructure extends Command {
  async invoke(): Promise<InvokeResult> {
    this.createDirectory(".mise/tasks/scripts");
    
    return {
      success: true,
      message: "✅ Created .mise directory structure",
      filePath: ".mise/tasks/scripts"
    };
  }
}