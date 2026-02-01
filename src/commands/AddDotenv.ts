import { Command, InvokeResult, CommandContext } from "./Command";

export class AddDotenv extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".env";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .env already exists"),
        filePath
      };
    }

    const content = `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .env" : "✅ Created .env"),
      filePath
    };
  }
}