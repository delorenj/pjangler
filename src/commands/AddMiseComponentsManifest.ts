import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseComponentsManifest extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "components.toml";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  components.toml already exists"),
        filePath,
      };
    }

    const content = `# Component manifest for meta-repo delegation
# Replace examples with your real component map.

[components]
core = { path = "core", kind = "submodule", enabled = true }
api = { path = "api", kind = "submodule", enabled = true }
app = { path = "app", kind = "submodule", enabled = true }
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(
        this.context.dryRun
          ? "Would create components.toml"
          : "✅ Created components.toml",
      ),
      filePath,
    };
  }
}
