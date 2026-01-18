import { Command, InvokeResult, CommandContext } from "./Command";

export class AddDockerCompose extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "docker-compose.yml";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  docker-compose.yml already exists",
        filePath
      };
    }

    const content = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created docker-compose.yml",
      filePath
    };
  }
}