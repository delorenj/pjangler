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

[tasks."component:list"]
run = "./.mise/tasks/console.py list"
description = "List components from components.toml"

[tasks."component:run"]
run = "./.mise/tasks/console.py run"
description = "Run component task: mise run component:run -- <component> <task> [-- args]"
raw = true

# Example delegated wrappers (copy/expand for your components)
[tasks."core:build"]
run = "./.mise/tasks/console.py delegate"
description = "Delegated build wrapper for component 'core'"
raw = true

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "✅ Created .mise/tasks/base.toml"),
      filePath
    };
  }
}