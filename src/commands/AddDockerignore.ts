import { Command, InvokeResult, CommandContext } from "./Command";

export class AddDockerignore extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".dockerignore";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  .dockerignore already exists",
        filePath
      };
    }

    const content = `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created .dockerignore",
      filePath
    };
  }
}