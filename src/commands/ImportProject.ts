import { Command } from "./Command";
import type { CommandContext, InvokeResult } from "./Command";
import { importProject } from "../project/import";
import type { ImportOptions, ImportResult } from "../project/import";

export class ImportProject extends Command {
  constructor(context: CommandContext, private readonly options: Omit<ImportOptions, "parent" | "dryRun">) { super(context); }

  async invoke(): Promise<InvokeResult & { result: ImportResult }> {
    const result = await importProject({ ...this.options, parent: this.context.targetDir, dryRun: this.context.dryRun });
    return { success: result.ok, outcome: result.ok ? result.status === "planned" ? "planned" : result.status === "unchanged" ? "unchanged" : "changed" : "failed", message: result.error ?? `Import ${result.status}: ${result.plan?.target}`, result };
  }
}
