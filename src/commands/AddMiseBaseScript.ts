import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseBaseScript extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".mise/tasks/scripts/base.py";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/tasks/scripts/base.py already exists"),
        filePath
      };
    }

    const content = `#!/usr/bin/env python3
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
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/scripts/base.py" : "✅ Created .mise/tasks/scripts/base.py"),
      filePath
    };
  }
}