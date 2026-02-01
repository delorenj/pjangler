import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseTasksStructure extends Command {
  async invoke(): Promise<InvokeResult> {
    this.createDirectory(".mise/tasks/scripts");

    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise directory structure" : "✅ Created .mise directory structure"),
      filePath: ".mise/tasks/scripts"
    };
  }
}