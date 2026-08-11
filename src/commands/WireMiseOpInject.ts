import type { InvokeResult } from "./Command";
import { Command } from "./Command";
import { runMigrationForRules } from "../parity/index";

/**
 * Compatibility command for the canonical `.env.op` -> `.env` lifecycle.
 *
 * The lifecycle registry owns the implementation. This command remains public
 * for one compatibility window and delegates to the two owned parity rules
 * instead of maintaining the retired `.env.secrets` contract.
 */
export class WireMiseOpInject extends Command {
  async invoke(): Promise<InvokeResult> {
    const report = runMigrationForRules(
      ["mise.config-root", "secrets.env-op"],
      this.context.targetDir,
      Boolean(this.context.dryRun)
    );
    const blocked = report.results.filter((result) => result.status === "blocked");
    return {
      success: blocked.length === 0,
      outcome: blocked.length
        ? "failed"
        : report.changedFiles.length
          ? (this.context.dryRun ? "planned" : "changed")
          : "unchanged",
      message: blocked.length
        ? `✗ op-inject lifecycle blocked: ${blocked.map((result) => `${result.id}: ${result.summary}`).join("; ")}`
        : this.formatMessage(
            `${this.context.dryRun ? "Would wire" : "✓ Wired"} atomic .env materialization from .env.op`
          ),
      filePath: report.changedFiles[0],
    };
  }
}
