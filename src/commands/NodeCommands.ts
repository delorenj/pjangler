import { Command, type InvokeResult, type CommandContext } from "../commands/Command";

export class AddPackageJson extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "package.json";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  package.json already exists",
        filePath
      };
    }

    const content = `{
  "name": "my-project",
  "version": "1.0.0",
  "description": "A new project",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created package.json",
      filePath
    };
  }
}

export class AddReadme extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = "README.md";
    
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  README.md already exists",
        filePath
      };
    }

    const content = `# My Project

A new project initialized with pjangler.

## Getting Started

1. Install dependencies: \`mise install\`
2. Start development: \`mise run dev\`

## Project Structure

- \`mise.toml\` - Environment configuration
- \`.mise/tasks/\` - Task definitions
- \`src/\` - Source code
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created README.md",
      filePath
    };
  }
}

export class AddSrcDirectory extends Command {
  async invoke(): Promise<InvokeResult> {
    this.createDirectory("src");
    
    const indexJsPath = "src/index.js";
    const content = `console.log("Hello, World!");
`;

    this.writeFile(indexJsPath, content);
    
    return {
      success: true,
      message: "✅ Created src/ directory with index.js",
      filePath: "src/index.js"
    };
  }
}