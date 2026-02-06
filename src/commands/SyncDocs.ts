import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { spawnSync } from "child_process";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

interface SyncDocsArgs {
  since: string;
  flat: boolean;
}

const DOCS_ROOT = "/home/delorenj/code/DeLoDocs/Projects";

export class SyncDocs extends Command {
  async invoke(): Promise<InvokeResult> {
    const parsedArgs = this.parseArgs();
    if (!parsedArgs.success) {
      return parsedArgs;
    }

    const { since, flat } = parsedArgs.value;
    const sourceRoot = this.context.targetDir;
    const repoName = this.findRepoName(sourceRoot);
    const date = this.localDateStamp();
    const destination = join(DOCS_ROOT, repoName, "docs", date);

    const rootCheck = this.ensureDestinationRoot(Boolean(this.context.dryRun));
    if (!rootCheck.success) {
      return rootCheck;
    }

    const filesResult = this.findMarkdownFiles(sourceRoot, since);
    if (!filesResult.success) {
      return filesResult;
    }

    const files = filesResult.value;
    const collisionCount = flat ? this.countFlatCollisions(files) : 0;
    if (!this.context.dryRun) {
      try {
        mkdirSync(destination, { recursive: true });
      } catch (error) {
        return {
          success: false,
          message: `❌ Failed to create destination directory '${destination}': ${this.errorMessage(error)}`,
          filePath: destination
        };
      }
    }

    let copiedCount = 0;
    let failedCount = 0;
    let firstError: string | null = null;

    if (!this.context.dryRun) {
      for (const file of files) {
        const copyResult = this.copyFile(sourceRoot, destination, file, flat);
        if (copyResult.success) {
          copiedCount += 1;
        } else {
          failedCount += 1;
          if (!firstError) {
            firstError = copyResult.message;
          }
        }
      }
    } else {
      copiedCount = files.length;
    }

    const mode = flat ? "flat" : "preserve-structure";
    const collisionSuffix = collisionCount > 0
      ? `; warning: ${collisionCount} potential basename collision(s) in flat mode`
      : "";

    if (failedCount > 0) {
      return {
        success: false,
        message: `❌ Sync incomplete: copied ${copiedCount}/${files.length} file(s), failed ${failedCount}. ${firstError ?? ""}${collisionSuffix}`.trim(),
        filePath: destination
      };
    }

    const message = `✅ Synced ${copiedCount} markdown file(s) to ${destination} (since: "${since}", mode: ${mode})${collisionSuffix}`;
    return {
      success: true,
      message: this.formatMessage(message),
      filePath: destination
    };
  }

  private parseArgs(): { success: true; value: SyncDocsArgs } | InvokeResult {
    const sinceRaw = this.context.args?.since;
    const flatRaw = this.context.args?.flat;

    const since = sinceRaw === undefined ? "24 hours ago" : sinceRaw;
    const flat = flatRaw === undefined ? false : flatRaw;

    if (typeof since !== "string" || since.trim().length === 0) {
      return {
        success: false,
        message: "❌ Invalid --since value. Provide a non-empty time expression (example: \"24 hours ago\")."
      };
    }

    if (typeof flat !== "boolean") {
      return {
        success: false,
        message: "❌ Invalid --flat value. It must be a boolean flag."
      };
    }

    return {
      success: true,
      value: {
        since: since.trim(),
        flat
      }
    };
  }

  private ensureDestinationRoot(dryRun: boolean): InvokeResult {
    if (dryRun) {
      return {
        success: true,
        message: "Dry run skips destination writability checks"
      };
    }

    if (!existsSync(DOCS_ROOT)) {
      return {
        success: false,
        message: `❌ Destination root does not exist: ${DOCS_ROOT}`
      };
    }

    try {
      accessSync(DOCS_ROOT, constants.W_OK);
    } catch (error) {
      return {
        success: false,
        message: `❌ Destination root is not writable: ${DOCS_ROOT} (${this.errorMessage(error)})`
      };
    }

    return {
      success: true,
      message: "Destination root is writable"
    };
  }

  private findMarkdownFiles(sourceRoot: string, since: string): { success: true; value: string[] } | InvokeResult {
    const result = spawnSync(
      "find",
      [".", "-not", "-path", "*/.git/*", "-type", "f", "-name", "*.md", "-newermt", since, "-print0"],
      { cwd: sourceRoot, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }
    );

    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
        return {
          success: false,
          message: "❌ Too many matching files for find output buffer. Narrow --since or run in a smaller directory."
        };
      }
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.findMarkdownFilesFallback(sourceRoot, since);
      }
      return {
        success: false,
        message: `❌ Failed to execute find command: ${this.errorMessage(result.error)}`
      };
    }

    if (result.status !== 0) {
      const stderr = (result.stderr ?? Buffer.alloc(0)).toString().trim();
      return {
        success: false,
        message: `❌ Failed to evaluate --since "${since}": ${stderr || "unknown find error"}`
      };
    }

    const rawOutput = (result.stdout ?? Buffer.alloc(0)).toString();
    const files = rawOutput
      .split("\0")
      .map((file) => file.trim())
      .filter((file) => file.length > 0)
      .map((file) => file.replace(/^\.\//, ""));

    return { success: true, value: files };
  }

  private findMarkdownFilesFallback(sourceRoot: string, since: string): { success: true; value: string[] } | InvokeResult {
    const sinceDate = this.parseRelativeSince(since);
    if (!sinceDate) {
      return {
        success: false,
        message: `❌ "find" is unavailable and --since "${since}" is unsupported by fallback parser. Use values like "24 hours ago" or "7 days ago".`
      };
    }

    const files: string[] = [];
    const walk = (currentDir: string) => {
      let entries;
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name === ".git") {
          continue;
        }

        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }

        try {
          const modified = statSync(fullPath).mtime;
          if (modified > sinceDate) {
            files.push(relative(sourceRoot, fullPath));
          }
        } catch {
          // skip unreadable files in fallback mode
        }
      }
    };

    walk(sourceRoot);
    return { success: true, value: files };
  }

  private copyFile(sourceRoot: string, destination: string, relativePath: string, flat: boolean): InvokeResult {
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = flat ? join(destination, basename(relativePath)) : join(destination, relativePath);
    const targetDir = dirname(targetPath);

    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sourcePath, targetPath);
      return {
        success: true,
        message: `Copied ${relativePath}`,
        filePath: targetPath
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to copy '${relativePath}' to '${targetPath}': ${this.errorMessage(error)}`,
        filePath: targetPath
      };
    }
  }

  private findRepoName(startDir: string): string {
    let current = resolve(startDir);

    while (true) {
      if (existsSync(join(current, ".git"))) {
        return this.safeRepoName(current);
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }

    return this.safeRepoName(resolve(startDir));
  }

  private localDateStamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private safeRepoName(dir: string): string {
    const name = basename(dir).trim();
    return name.length > 0 ? name : "root";
  }

  private countFlatCollisions(paths: string[]): number {
    const counts = new Map<string, number>();
    for (const relPath of paths) {
      const key = basename(relPath);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let collisions = 0;
    for (const count of counts.values()) {
      if (count > 1) {
        collisions += count - 1;
      }
    }
    return collisions;
  }

  private parseRelativeSince(input: string): Date | null {
    const value = input.trim().toLowerCase();
    const match = value.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      minute: 60_000,
      minutes: 60_000,
      hour: 3_600_000,
      hours: 3_600_000,
      day: 86_400_000,
      days: 86_400_000,
      week: 604_800_000,
      weeks: 604_800_000
    };

    return new Date(Date.now() - amount * multipliers[unit]);
  }
}
