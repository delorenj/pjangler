import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import { HERMES_AGENT_TEMPLATE, type HermesAgentContext } from "./types";

/**
 * Resolve a vendored copier template that ships with pjangler as a git
 * submodule under templates/<name>/. Walks up from this module's directory so
 * it works both when run from source (src/commands/hermes/) and from a repo
 * checkout. Returns undefined when not found (e.g. a bundled single-file
 * install), letting callers fall back to ~/code or the published gh: template.
 */
function resolveVendoredTemplate(name: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "templates", name);
    if (existsSync(join(candidate, "copier.yml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Invokes `copier copy gh:delorenj/hermes-agent-template ./agents/hermes/<role>`
 * with the collected --data flags.  Telegram and email steps are *always*
 * skipped here — the recipe's later commands (WireTelegram, WireEmail) handle
 * them in a TUI-friendly way after the bulk provisioning is done.
 *
 * Honors dryRun: prints what would run, doesn't execute copier.
 */
export class RunCopierTemplate extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    const { targetRepo, role, agentPurpose, soulTone, modelProvider, modelName } = ctx;
    const ticketProvider = ctx.ticketProvider ?? "plane";
    // with_scrum_master is a pm-only copier question; passing it for other
    // roles is harmless (copier ignores it via its `when:` guard).
    const withScrumMaster = role === "pm" && ctx.withScrumMaster === true;

    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)",
      };
    }

    const roleDir = join(ctx.targetDir, "agents", "hermes", role);
    ctx.roleDir = roleDir;
    // Derive runtime repo name upfront so PrintHermesSummary can show it
    // even in dry-run mode (where copier never executes).
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${role}`;

    // Sanity: copier on PATH?
    const which = spawnSync("which", ["copier"], { encoding: "utf8" });
    if (which.status !== 0) {
      return {
        success: false,
        message:
          "✗ copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`",
      };
    }

    // Idempotency: if role.yaml already exists, copier will refuse to
    // overwrite without --force.  In --yes mode we automatically re-render
    // (idempotent refresh); otherwise we ask.
    if (existsSync(join(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await p.confirm({
          message: `${role}/role.yaml already exists — re-render with --overwrite?`,
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) {
          return {
            success: false,
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`,
          };
        }
        ctx.force = true;
      }
    }

    // Always set these via env so the post-gen scripts in the copier template
    // skip the bits we'll handle in our own commands.
    const env = {
      ...process.env,
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      // We DO want copier to run runtime-repo + plane + bloodbank + systemd.
      SKIP_RUNTIME_REPO: ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: ctx.skipBloodbank ? "1" : "0",
      SKIP_SYSTEMD: ctx.skipSystemd ? "1" : "0",
    };

    // Prefer a local template checkout (if present) so fixes propagate
    // immediately without waiting for a GitHub push. Resolve against $HOME so
    // this works on any operator's machine (e.g. a friend's Mac), not just the
    // box this was authored on. PJANGLER_HERMES_TEMPLATE overrides; otherwise
    // fall back to the published gh: template.
    // Resolution order: explicit env override → vendored submodule (the
    // version-locked default) → a ~/code dev checkout → the published gh:
    // template. PJANGLER_HERMES_TEMPLATE stays the escape hatch for pointing at
    // a live ~/code checkout during template development.
    const LOCAL_TEMPLATE = join(homedir(), "code", "hermes-agent-template");
    const vendored = resolveVendoredTemplate("hermes-agent");
    const templateSrc =
      process.env.PJANGLER_HERMES_TEMPLATE ||
      vendored ||
      (existsSync(join(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);

    const args = [
      "copy",
      templateSrc,
      roleDir,
      "--data", `target_repo=${targetRepo}`,
      "--data", `role=${role}`,
      "--data", `agent_purpose=${agentPurpose ?? ""}`,
      "--data", `model_provider=${modelProvider ?? ""}`,
      "--data", `model_name=${modelName ?? ""}`,
      "--data", `soul_tone=${soulTone ?? "direct"}`,
      "--data", `ticket_provider=${ticketProvider}`,
      "--data", `with_scrum_master=${withScrumMaster}`,
      "--trust",
      "--vcs-ref=HEAD",
    ];
    if (ctx.force) args.push("--overwrite");

    if (ctx.dryRun) {
      return {
        success: true,
        message: this.formatMessage(`Would run: copier ${args.join(" ")}`),
      };
    }

    // Ensure agents/hermes/ parent exists so copier doesn't have to create it
    // (copier handles this fine, but creating it ourselves lets us catch
    // permission issues earlier).
    mkdirSync(join(ctx.targetDir, "agents", "hermes"), { recursive: true });

    const spinner = p.spinner();
    spinner.start(`Running copier copy  (target: agents/hermes/${role})`);
    const result = spawnSync("copier", args, {
      stdio: "inherit",   // pass the interactive output through; copier prints its own progress
      env,
      cwd: ctx.targetDir,
    });
    spinner.stop(result.status === 0 ? "✓ copier run complete" : "✗ copier failed");

    if (result.status !== 0) {
      return {
        success: false,
        message: `✗ copier exited with status ${result.status}.  Check the output above; re-run with the same flags after fixing.`,
      };
    }

    return {
      success: true,
      message: `✓ Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`,
    };
  }
}
