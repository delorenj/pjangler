import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { Command, type InvokeResult } from "../Command";

export class UntrackHermesRuntimes extends Command {
  async invoke(): Promise<InvokeResult> {
    const targetDir = this.context.targetDir;
    const rolesDir = join(targetDir, "agents", "hermes");
    if (!existsSync(rolesDir)) {
      return {
        success: true,
        message: "No Hermes agents found (no agents/hermes directory).",
      };
    }

    const roles = readdirSync(rolesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    if (roles.length === 0) {
      return {
        success: true,
        message: "No Hermes agents found.",
      };
    }

    let modifiedAny = false;
    const details: string[] = [];

    for (const role of roles) {
      const roleDir = join("agents", "hermes", role);
      const runtimePath = join(roleDir, "runtime");
      const gitignorePath = join(roleDir, ".gitignore");

      // 1. Check if runtime is tracked in git
      let isTracked = false;
      const lsResult = spawnSync("git", ["ls-files", "--stage", runtimePath], {
        cwd: targetDir,
        encoding: "utf8",
      });
      if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
        isTracked = true;
      }

      // 2. Check if .gitignore ignores runtime/
      let isIgnored = false;
      const fullGitignorePath = join(targetDir, gitignorePath);
      if (existsSync(fullGitignorePath)) {
        const content = readFileSync(fullGitignorePath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim());
        isIgnored = lines.includes("runtime/") || lines.includes("runtime");
      }

      if (isTracked || !isIgnored) {
        modifiedAny = true;

        if (isTracked) {
          details.push(`untrack agents/hermes/${role}/runtime`);
          if (!this.context.dryRun) {
            const rmResult = spawnSync("git", ["rm", "--cached", "-r", runtimePath], {
              cwd: targetDir,
              encoding: "utf8",
            });
            if (rmResult.status !== 0) {
              return {
                success: false,
                message: `Failed to untrack agents/hermes/${role}/runtime: ${rmResult.stderr}`,
              };
            }
          }
        }

        if (!isIgnored) {
          details.push(`ignore runtime/ in agents/hermes/${role}/.gitignore`);
          if (!this.context.dryRun) {
            let content = "";
            if (existsSync(fullGitignorePath)) {
              content = readFileSync(fullGitignorePath, "utf8");
            }
            if (content && !content.endsWith("\n")) {
              content += "\n";
            }
            content += "runtime/\n";
            writeFileSync(fullGitignorePath, content, "utf8");
          }
        }
      }
    }

    if (!modifiedAny) {
      return {
        success: true,
        message: "✅ All Hermes agent runtimes are already untracked and gitignored.",
      };
    }

    const actionText = this.context.dryRun ? "Would make" : "Made";
    return {
      success: true,
      message: `${actionText} Hermes agent runtimes untracked and gitignored:\n${details.map(d => `  - ${d}`).join("\n")}`,
    };
  }
}
