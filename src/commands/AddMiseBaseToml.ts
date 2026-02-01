import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseBaseToml extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".mise/tasks/base.toml";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/tasks/base.toml already exists"),
        filePath
      };
    }

    const content = `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "✅ Created .mise/tasks/base.toml"),
      filePath
    };
  }
}