import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

/**
 * "Bootstrap the config if it's not there."
 *
 * The copier template (hermes-agent-template) reads every environment-specific
 * default from ~/.config/hermes-agent-template/config.toml. The shipped
 * config.example.toml hardcodes one machine's paths/owner, so seeding from it
 * verbatim breaks on any other host. This command instead writes a config whose
 * [fleet] paths are DERIVED from the current machine ($HOME, platform, where the
 * hermes binary actually lives), leaving the identity values ([github] owner,
 * [plane], [bloodbank]) as clearly-marked blanks to confirm before a cloud
 * provision.
 *
 * Idempotent: writes only when the file is missing (override with forceConfig or
 * `pjangler config bootstrap --force`). Honors dryRun.
 */

export function resolveTemplateConfigPath(): string {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

function detectHermesBin(home: string): string {
  // Different machines lay the venv out differently (venv vs .venv vs a
  // ~/.local/bin symlink). Probe the common spots; fall back to the first
  // candidate so the generated file is still a sensible, reviewable guess.
  const candidates = [
    join(home, "code", "hermes-agent", "venv", "bin", "hermes"),
    join(home, "code", "hermes-agent", ".venv", "bin", "hermes"),
    join(home, ".local", "bin", "hermes"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function renderHostConfig(): string {
  const home = homedir();
  const hermesBin = detectHermesBin(home);
  const hermesRepo = join(home, "code", "hermes-agent");
  const scaffoldDir = join(home, "code", "hermes-agent-template", "runtime-scaffold");
  const skillsDir = join(home, ".agents", "skills");

  return `# hermes-agent-template — host configuration
# Bootstrapped by \`pjangler config bootstrap\` for $HOME=${home} (platform=${platform()}).
#
# [fleet] paths below were derived from THIS machine. The identity values in
# [github]/[plane]/[bloodbank] are intentionally left to be confirmed before a
# CLOUD provision (\`pjangler hermes\` without --local); they are unused by the
# default local-only provision.
#
# Resolution precedence per value: env var > ~/.hermes/fleet.env > this file > fallback.

[fleet]
hermes_bin = "${hermesBin}"
hermes_repo = "${hermesRepo}"
runtime_scaffold_dir = "${scaffoldDir}"
fleet_env = "~/.hermes/fleet.env"
registry_file = "~/.hermes/agents-registry.yaml"
canonical_skills_dir = "${skillsDir}"
symlinked_runtime_skills = []

[github]
# Owner of the per-agent runtime repos (creates <owner>/agent-hm-<repo>-<role>).
# REQUIRED before a cloud provision. Leave empty for local-only runs.
runtime_repo_owner = ""

[plane]
# Plane instance + workspace (one project per agent). Confirm before cloud provision.
base = "https://plane.delo.sh"
workspace = "33god"

[bloodbank]
# NATS endpoint the consumer connects to. For a remote fleet node, point this at
# the bloodbank host over Tailscale rather than localhost.
nats_host = "127.0.0.1"
nats_port = 4222
compose_dir = "~/code/33GOD/bloodbank"
`;
}

export class EnsureTemplateConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync(path);

    if (exists && !force) {
      console.log(`✓ Config present: ${path}`);
      return { success: true, message: "" };
    }

    if (ctx.dryRun) {
      console.log(`[DRY RUN] Would ${exists ? "overwrite" : "create"} config: ${path}`);
      return { success: true, message: "" };
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderHostConfig());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `✗ Failed to write ${path}: ${msg}` };
    }

    console.log(`✓ Bootstrapped config: ${path}`);
    console.log("  Review [github].runtime_repo_owner + [plane] + [bloodbank] before a cloud provision.");
    return { success: true, message: "" };
  }
}
