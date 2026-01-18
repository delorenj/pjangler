#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const program = new Command();

program
  .name("pjangler")
  .description("Project subsystem bootstrapper CLI")
  .version("1.0.0");

program
  .command("init")
  .argument("<subsystem>", "Subsystem to initialize")
  .description("Initialize a project subsystem")
  .action((subsystem: string) => {
    const currentDir = process.cwd();
    
    switch (subsystem) {
      case "mise":
        initializeMise(currentDir);
        break;
      case "docker":
        initializeDocker(currentDir);
        break;
      default:
        console.error(`❌ Unknown subsystem: ${subsystem}`);
        console.log("Available subsystems: mise, docker");
        process.exit(1);
    }
  });

program
  .command("list")
  .description("List available subsystems")
  .action(() => {
    console.log("Available subsystems:");
    console.log("  mise    - Mise task runner and environment setup");
    console.log("  docker  - Docker containerization setup");
  });

function initializeMise(dir: string) {
  console.log("🚀 Initializing mise subsystem...");
  
  const miseTomlPath = join(dir, "mise.toml");
  if (!existsSync(miseTomlPath)) {
    writeFileSync(miseTomlPath, `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`);
    console.log("✅ Created mise.toml");
  } else {
    console.log("⚠️  mise.toml already exists");
  }

  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`);
    console.log("✅ Created .env");
  } else {
    console.log("⚠️  .env already exists");
  }

  const miseTasksDir = join(dir, ".mise", "tasks", "scripts");
  mkdirSync(miseTasksDir, { recursive: true });
  console.log("✅ Created .mise directory structure");
  
  const baseTomlPath = join(dir, ".mise", "tasks", "base.toml");
  if (!existsSync(baseTomlPath)) {
    writeFileSync(baseTomlPath, `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`);
    console.log("✅ Created .mise/tasks/base.toml");
  } else {
    console.log("⚠️  .mise/tasks/base.toml already exists");
  }

  const basePyPath = join(dir, ".mise", "tasks", "scripts", "base.py");
  if (!existsSync(basePyPath)) {
    writeFileSync(basePyPath, `#!/usr/bin/env python3
"""Base setup script"""
import os
import sys
from pathlib import Path

def main():
    print("🔧 Setting up base environment...")
    
    dirs_to_create = ["logs", "temp", "data"]
    for dir_name in dirs_to_create:
        Path(dir_name).mkdir(exist_ok=True)
        print(f"  Created {dir_name}/ directory")
    
    print("  Base environment setup complete!")
    print("  Run 'mise run dev' to start development")
    
if __name__ == "__main__":
    main()
`);
    console.log("✅ Created .mise/tasks/scripts/base.py");
  } else {
    console.log("⚠️  .mise/tasks/scripts/base.py already exists");
  }

  console.log("🎉 Mise subsystem initialized successfully!");
  console.log("   Next steps:");
  console.log("   1. mise install");
  console.log("   2. mise run dev");
}

function initializeDocker(dir: string) {
  console.log("🐳 Initializing docker subsystem...");
  
  const dockerfilePath = join(dir, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    writeFileSync(dockerfilePath, `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`);
    console.log("✅ Created Dockerfile");
  } else {
    console.log("⚠️  Dockerfile already exists");
  }

  const composePath = join(dir, "docker-compose.yml");
  if (!existsSync(composePath)) {
    writeFileSync(composePath, `version: '3.8'

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
`);
    console.log("✅ Created docker-compose.yml");
  } else {
    console.log("⚠️  docker-compose.yml already exists");
  }

  const dockerignorePath = join(dir, ".dockerignore");
  if (!existsSync(dockerignorePath)) {
    writeFileSync(dockerignorePath, `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`);
    console.log("✅ Created .dockerignore");
  } else {
    console.log("⚠️  .dockerignore already exists");
  }

  console.log("🎉 Docker subsystem initialized successfully!");
  console.log("   Next steps:");
  console.log("   1. docker-compose up -d");
  console.log("   2. docker-compose logs -f");
}

program.parse();