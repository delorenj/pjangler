import { spawnSync } from "../../utils/child-process";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import YAML from "yaml";
import { Command, type InvokeResult } from "../Command";
import { HERMES_AGENT_TEMPLATE, deriveAgentId, deriveProfileName, type HermesAgentContext } from "./types";
import { normalizeAgentRole, resolveContainedPath } from "../../project/index";
import {
  materializeTrustedHermesTemplate,
  verifyTrustedCopierIdentity,
  verifyTrustedHermesTemplateIdentity,
} from "../../lifecycle/preflight";
import { hardenSubprocessEnvironment } from "../../utils/child-environment";

const TICKET_PROVIDER_CREDENTIAL_KEYS = new Set([
  "PLANE_API_KEY",
  "TRELLO_KEY",
  "TRELLO_TOKEN",
  "LINEAR_API_KEY",
]);

const INTERACTIVE_CHANNEL_CREDENTIAL_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CF_EMAIL_ROUTING_TOKEN",
]);

export function scrubTicketProviderCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (TICKET_PROVIDER_CREDENTIAL_KEYS.has(key) || /^PLANE_[A-Z0-9_]+_API_KEY$/.test(key)) {
      delete env[key];
    }
  }
}

export function scrubInteractiveChannelCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of INTERACTIVE_CHANNEL_CREDENTIAL_KEYS) delete env[key];
  // MCP has no positive Slack grant. Remove ambient opt-in switches as well as
  // credentials so the non-interactive child cannot be armed indirectly.
  delete env.ENABLE_SLACK;
  delete env.WIRE_SLACK;
}

function registerRenderedAgent(ctx: HermesAgentContext, roleDir: string, role: string): void {
  const manifestPath = join(ctx.targetDir, ".project.json");
  if (!existsSync(manifestPath) || !ctx.targetRepo) return;

  const current = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(current) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  const manifest = parsed as Record<string, unknown>;
  const rawAgents = manifest.agents;
  if (rawAgents !== undefined && (!rawAgents || typeof rawAgents !== "object" || Array.isArray(rawAgents))) {
    throw new Error(`${manifestPath} agents must contain a JSON object`);
  }
  const agents = (rawAgents ?? {}) as Record<string, unknown>;
  const agentId = ctx.agentId ?? deriveAgentId(ctx.targetRepo, role);
  Object.defineProperty(agents, agentId, {
    value: {
      role,
      role_dir: relative(ctx.targetDir, roleDir),
      provisioning_state: "provisioned",
    },
    configurable: true,
    enumerable: true,
    writable: true,
  });
  manifest.agents = agents;
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== current) writeFileSync(manifestPath, next, "utf8");
}

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
    const {
      targetRepo,
      role,
      agentPurpose,
      soulTone,
      modelProvider,
      modelName,
      modelBaseUrl,
      modelApiMode,
      modelKeyEnv,
    } = ctx;
    const ticketProvider = ctx.ticketProvider ?? "plane";
    const profileName =
      ctx.profileName ?? (targetRepo && role ? deriveProfileName(targetRepo, role) : undefined);

    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)",
      };
    }

    const safeRole = normalizeAgentRole(role);
    ctx.role = safeRole;
    const roleDir = resolveContainedPath(
      ctx.targetDir,
      join(ctx.targetDir, "agents", "hermes", safeRole),
      "Hermes role directory",
    );
    ctx.roleDir = roleDir;
    // Derive runtime repo name upfront so PrintHermesSummary can show it
    // even in dry-run mode (where copier never executes).
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${safeRole}`;

    const trustedCopierRequired = Boolean(ctx.deferredExternalEffects && !ctx.dryRun);
    if (trustedCopierRequired && !ctx.trustedCopier) {
      return {
        success: false,
        outcome: "failed",
        message: "MCP Hermes apply requires a preflight-attested Copier identity",
      };
    }
    if (trustedCopierRequired && !ctx.trustedHermesTemplate) {
      return {
        success: false,
        outcome: "failed",
        message: "MCP Hermes apply requires a preflight-attested immutable template identity",
      };
    }
    // Interactive CLI callers retain their historical PATH behavior. MCP
    // apply has an identity and therefore must not execute `which` or resolve
    // PATH again after the handler's read-only preflight.
    if (!ctx.trustedCopier) {
      const which = spawnSync("which", ["copier"], {
        encoding: "utf8",
        env: hardenSubprocessEnvironment(),
      });
      if (which.status !== 0) {
        return {
          success: false,
          outcome: "failed",
          message:
            "✗ copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`",
        };
      }
    }

    // Idempotency: if role.yaml already exists, copier will refuse to
    // overwrite without --force.  In --yes mode we automatically re-render
    // (idempotent refresh); otherwise we ask.
    if (existsSync(join(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await p.confirm({
          message: `${safeRole}/role.yaml already exists — re-render with --overwrite?`,
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) {
          return {
            success: false,
            outcome: "cancelled",
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`,
          };
        }
        ctx.force = true;
      }
    }

    // Always set these via env so the post-gen scripts in the copier template
    // skip the bits we'll handle in our own commands.
    const env = hardenSubprocessEnvironment(process.env, {
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: ctx.deferredExternalEffects ? "1" : "0",
      // Fresh project targets do not have their own .git directory until the
      // project transaction's final phase. Pin scripts to the caller-resolved
      // root so they can never climb into an enclosing checkout.
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      // Config, fleet env/profile, and registry are host-global state. MCP
      // renders repo-local files first and executes those scripts only after a
      // structural lifecycle gate has accepted the render.
      SKIP_HOST_STATE: ctx.deferredExternalEffects ? "1" : "0",
      // Bloodbank is a fleet-shared Hermes gateway. Never provision the legacy
      // per-profile file consumer, even when an older template still exposes it.
      SKIP_RUNTIME_REPO: ctx.deferredExternalEffects ? "1" : ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.deferredExternalEffects ? "1" : ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: "1",
      SKIP_SYSTEMD: ctx.deferredExternalEffects ? "1" : ctx.skipSystemd ? "1" : "0",
    });
    if (ctx.deferredExternalEffects) scrubInteractiveChannelCredentials(env);
    if (ctx.deferredExternalEffects || ctx.skipPlane) scrubTicketProviderCredentials(env);

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
      "--data", `role=${safeRole}`,
      "--data", `agent_purpose=${agentPurpose ?? ""}`,
      "--data", `model_provider=${modelProvider ?? ""}`,
      "--data", `model_name=${modelName ?? ""}`,
      "--data", `model_base_url=${modelBaseUrl ?? ""}`,
      "--data", `model_api_mode=${modelApiMode ?? ""}`,
      "--data", `model_key_env=${modelKeyEnv ?? ""}`,
      "--data", `profile_name=${profileName ?? ""}`,
      "--data", `soul_tone=${soulTone ?? "direct"}`,
      "--data", `ticket_provider=${ticketProvider}`,
      "--trust",
      "--vcs-ref=HEAD",
    ];
    if (ctx.force) args.push("--overwrite");

    if (ctx.dryRun) {
      return {
        success: true,
        outcome: "planned",
        filePath: roleDir,
        message: this.formatMessage(`Would run: ${ctx.trustedCopier?.executable ?? "copier"} ${args.join(" ")}`),
      };
    }

    // Revalidate at the last effect-free boundary. A launcher, interpreter,
    // receipt, RECORD, metadata, or package replacement after MCP preflight is
    // rejected before mkdir, config, provider, systemd, or any subprocess.
    if (ctx.trustedCopier) {
      const verified = verifyTrustedCopierIdentity(ctx.trustedCopier);
      if (!verified.ok) {
        return {
          success: false,
          outcome: "failed",
          message: `Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`,
        };
      }
      const templateVerified = ctx.trustedHermesTemplate
        ? verifyTrustedHermesTemplateIdentity(ctx.trustedHermesTemplate)
        : { ok: false, error: "immutable template identity is missing" };
      if (!templateVerified.ok) {
        return {
          success: false,
          outcome: "failed",
          message: `Hermes template revalidation failed: ${templateVerified.error ?? "unknown identity failure"}`,
        };
      }
    }

    let immutableTemplate: ReturnType<typeof materializeTrustedHermesTemplate> | undefined;
    let result: ReturnType<typeof spawnSync>;
    const spinner = ctx.quiet ? undefined : p.spinner();
    try {
      if (ctx.trustedHermesTemplate) {
        immutableTemplate = materializeTrustedHermesTemplate(ctx.trustedHermesTemplate);
        args[1] = immutableTemplate.path;
        const vcsRef = args.indexOf("--vcs-ref=HEAD");
        if (vcsRef >= 0) args.splice(vcsRef, 1);
      }

      // The private snapshot is complete and reattested before the first
      // target write. Copier receives only its absolute path; it never reads
      // the mutable vendored worktree after this boundary.
      mkdirSync(join(ctx.targetDir, "agents", "hermes"), { recursive: true });
      spinner?.start(`Running copier copy  (target: agents/hermes/${safeRole})`);
      const copierExecutable = ctx.trustedCopier?.executable ?? "copier";
      result = spawnSync(copierExecutable, args, ctx.quiet
        ? { encoding: "utf8", env, cwd: ctx.targetDir }
        : { stdio: "inherit", env, cwd: ctx.targetDir });
      spinner?.stop(result.status === 0 ? "✓ copier run complete" : "✗ copier failed");
    } catch (error) {
      spinner?.stop("✗ copier failed");
      return {
        success: false,
        outcome: "failed",
        message: `Hermes template snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      immutableTemplate?.cleanup();
    }

    if (result.status !== 0) {
      return {
        success: false,
        outcome: "failed",
        message: `copier exited with status ${result.status}.${ctx.quiet && String(result.stderr ?? "").trim() ? ` ${String(result.stderr).trim()}` : " Check the output above; re-run with the same flags after fixing."}`,
      };
    }

    const roleManifest = join(roleDir, "role.yaml");
    try {
      const current = readFileSync(roleManifest, "utf8");
      const document = YAML.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], ctx.deferredExternalEffects ? true : Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], ctx.deferredExternalEffects ? "deferred" : ctx.skipSystemd ? "deferred" : "required");
      const next = String(document);
      if (next !== current) writeFileSync(roleManifest, next, "utf8");
      registerRenderedAgent(ctx, roleDir, safeRole);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record Hermes deployment mode in ${roleManifest}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      success: true,
      message: `✓ Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`,
    };
  }
}
