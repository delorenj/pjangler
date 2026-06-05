import { Command, type InvokeResult, type CommandContext } from "./Command";

export class AddMiseToml extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "mise.toml";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  mise.toml already exists"),
        filePath
      };
    }

    const content = `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create mise.toml" : "✅ Created mise.toml"),
      filePath
    };
  }
}