import { Command, InvokeResult, CommandContext } from "./Command";

export class AddDockerfile extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "Dockerfile";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  Dockerfile already exists"),
        filePath
      };
    }

    const content = `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create Dockerfile" : "✅ Created Dockerfile"),
      filePath
    };
  }
}