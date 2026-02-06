import fs from "node:fs";
import path from "node:path";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

interface DoctorCheck {
  label: string;
  relativePath: string;
  required?: boolean;
}

export class Doctor extends Command {
  async invoke(): Promise<InvokeResult> {
    const root = this.context.targetDir;

    const checks: DoctorCheck[] = [
      { label: "Manifest", relativePath: "components.toml", required: true },
      { label: "Root task config", relativePath: "mise.toml", required: true },
      { label: "Dispatcher", relativePath: ".mise/tasks/console.py", required: true },
      { label: "Base tasks", relativePath: ".mise/tasks/base.toml", required: false },
      { label: "Base script", relativePath: ".mise/tasks/scripts/base.py", required: false },
    ];

    const results = checks.map((check) => {
      const fullPath = path.join(root, check.relativePath);
      const exists = fs.existsSync(fullPath);
      return { ...check, exists };
    });

    const missingRequired = results.filter((r) => r.required && !r.exists);
    const missingOptional = results.filter((r) => !r.required && !r.exists);

    const report = [
      "🩺 pjangler doctor",
      `Path: ${root}`,
      "",
      ...results.map((r) => `${r.exists ? "✅" : "❌"} ${r.label.padEnd(16)} ${r.relativePath}`),
      "",
    ];

    if (missingRequired.length === 0) {
      report.push("Status: healthy ✅");
      if (missingOptional.length > 0) {
        report.push("Optional scaffolding missing:");
        for (const item of missingOptional) {
          report.push(`- ${item.relativePath}`);
        }
        report.push("Tip: run `pjangler init mise --force` to scaffold missing files.");
      }
      return {
        success: true,
        message: this.formatMessage(report.join("\n")),
      };
    }

    report.push("Status: needs bootstrap ❌");
    report.push("Missing required files:");
    for (const item of missingRequired) {
      report.push(`- ${item.relativePath}`);
    }
    report.push("Suggested next step: `pjangler init mise --force`");

    return {
      success: false,
      message: this.formatMessage(report.join("\n")),
    };
  }
}
