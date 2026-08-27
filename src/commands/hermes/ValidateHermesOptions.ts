import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, type InvokeResult } from "../Command";
import { normalizeAgentRole, resolveContainedPath } from "../../project/index";
import type { HermesAgentContext } from "./types";

export const EMAIL_UNSUPPORTED_MESSAGE =
  "Email provisioning is unavailable: the pinned Hermes template has no supported email provisioner. Omit --email; no files or external state were changed.";

/**
 * Effect-free CLI/recipe option validation.
 *
 * This command deliberately runs before host config bootstrap or Copier. Flags
 * that cannot be honored must fail without leaving a half-started deployment.
 */
export class ValidateHermesOptions extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;

    if (ctx.skipEmail === false) {
      return { success: false, outcome: "failed", message: EMAIL_UNSUPPORTED_MESSAGE };
    }

    const role = normalizeAgentRole(ctx.role ?? "pm");
    const roleDir = resolveContainedPath(
      ctx.targetDir,
      join(ctx.targetDir, "agents", "hermes", role),
      "Hermes role directory",
    );
    if (ctx.yes && !ctx.force && existsSync(join(roleDir, "role.yaml"))) {
      return {
        success: false,
        outcome: "failed",
        message: `Hermes role already exists at ${roleDir}; non-interactive mode will not overwrite it. Re-run with --force to re-render explicitly.`,
      };
    }

    return { success: true, outcome: "unchanged", message: "" };
  }
}
