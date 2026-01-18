export interface InvokeResult {
  success: boolean;
  message: string;
  filePath?: string;
}

export interface CommandContext {
  targetDir: string;
  force?: boolean;
}

export abstract class Command {
  protected context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  abstract invoke(): Promise<InvokeResult>;

  protected fileExists(filePath: string): boolean {
    const { existsSync } = require("fs");
    const { join } = require("path");
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }

  protected writeFile(filePath: string, content: string): void {
    const { writeFileSync, mkdirSync } = require("fs");
    const { join, dirname } = require("path");
    
    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);
    
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  protected createDirectory(dirPath: string): void {
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    
    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
}