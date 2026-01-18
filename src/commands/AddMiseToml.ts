import { Command, InvokeResult, CommandContext } from "./Command";

export class AddMiseToml extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "mise.toml";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  mise.toml already exists",
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
      message: "✅ Created mise.toml",
      filePath
    };
  }
}