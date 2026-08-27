import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

const HERMES_GIT_URL = "https://github.com/delorenj/hermes-agent.git";
const HERMES_GIT_REF = "main";
const HERMES_GIT_SHA = "0408fec7a153e6c32c064acd2b8053917f1525f1";

type ConfigSchema = ReadonlyArray<{
  section: string;
  values: ReadonlyArray<readonly [key: string, value: string]>;
}>;

/** Resolve the one host-global config consumed by the pinned Copier template. */
export function resolveTemplateConfigPath(): string {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function detectHermesInstall(home: string): { bin: string; repo: string } {
  const releaseRoot = join(home, ".local", "share", "hermes-agent", "releases", HERMES_GIT_SHA);
  const devRoot = join(home, "code", "hermes-agent");
  const candidates = [
    join(releaseRoot, ".venv", "bin", "hermes"),
    join(home, ".local", "bin", "hermes"),
    join(devRoot, "venv", "bin", "hermes"),
    join(devRoot, ".venv", "bin", "hermes"),
  ];
  const bin = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  try {
    const resolved = realpathSync(bin);
    const environment = dirname(dirname(resolved));
    if (["venv", ".venv"].includes(environment.split("/").at(-1) ?? "")) {
      return { bin, repo: dirname(environment) };
    }
  } catch {
    // A not-yet-installed pinned release is still the canonical bootstrap guess.
  }
  return { bin, repo: bin.startsWith(devRoot) ? devRoot : releaseRoot };
}

function hostSchema(): ConfigSchema {
  const home = homedir();
  const hermes = detectHermesInstall(home);
  return [
    {
      section: "fleet",
      values: [
        ["hermes_bin", quote(hermes.bin)],
        ["hermes_repo", quote(hermes.repo)],
        ["pjangler_bin", quote("pj")],
        ["hermes_git_url", quote(HERMES_GIT_URL)],
        ["hermes_git_ref", quote(HERMES_GIT_REF)],
        ["hermes_git_sha", quote(HERMES_GIT_SHA)],
        ["runtime_scaffold_dir", quote(join(home, "code", "hermes-agent-template", "runtime-scaffold"))],
        ["fleet_env", quote("~/.hermes/fleet.env")],
        ["registry_file", quote("~/.hermes/agents-registry.yaml")],
        ["oauth_file", quote("~/.hermes/auth.json")],
        ["codex_home", quote("~/.codex")],
        ["canonical_skills_dir", quote(join(home, ".agents", "skills"))],
        ["vox_plugin_name", quote("vox")],
        ["vox_plugin_dir", quote(join(home, "code", "voxxy", "plugins", "tts", "vox"))],
        ["vox_voice", quote("carlin")],
        ["vox_url", quote("https://vox.delo.sh")],
        ["onepassword_vault", quote("DeLoSecrets")],
        ["onepassword_item_prefix", quote("hermes-agent")],
        [
          "symlinked_runtime_skills",
          `[${[
            "delonet-conventions",
            "delonet-dotenv",
            "hermes-pm-template-maintenance",
            "hindsight",
            "33god-projects",
            "subagent-driven-development",
          ].map(quote).join(", ")}]`,
        ],
      ],
    },
    { section: "github", values: [["runtime_repo_owner", quote("")]] },
    {
      section: "plane",
      values: [
        ["base", quote("https://plane.delo.sh")],
        ["workspace", quote("33god")],
      ],
    },
  ];
}

/** Render the current, pinned template schema with host-derived path values. */
export function renderHostConfig(): string {
  const sections = hostSchema()
    .map(({ section, values }) => `[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}`)
    .join("\n\n");
  return `# hermes-agent-template — host configuration\n# Bootstrapped by \`pj config bootstrap\` for $HOME=${homedir()} (platform=${platform()}).\n# Existing values and additional keys are preserved by \`--force\`; it only adds\n# fields missing from the schema pinned in this pjangler release.\n# Resolution precedence: env var > ~/.hermes/fleet.env > this file > fallback.\n\n${sections}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add missing pinned-schema fields without replacing operator values, comments,
 * unknown keys, or richer sections. This is intentionally a small TOML-aware
 * merge rather than a parse/stringify round trip, which would erase comments.
 */
export function mergeHostConfig(existing: string): string {
  let merged = existing;
  for (const { section, values } of hostSchema()) {
    const header = new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m");
    const headerMatch = header.exec(merged);
    if (!headerMatch || headerMatch.index === undefined) {
      const prefix = merged.length === 0 ? "" : merged.endsWith("\n") ? "\n" : "\n\n";
      merged += `${prefix}[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
      continue;
    }

    const bodyStart = headerMatch.index + headerMatch[0].length;
    const nextHeaderOffset = merged.slice(bodyStart).search(/^\[[^\]]+\]\s*$/m);
    const bodyEnd = nextHeaderOffset === -1 ? merged.length : bodyStart + nextHeaderOffset;
    const body = merged.slice(bodyStart, bodyEnd);
    const missing = values.filter(([key]) => !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "m").test(body));
    if (!missing.length) continue;
    const addition = `${body.endsWith("\n") ? "" : "\n"}${missing.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
    merged = `${merged.slice(0, bodyEnd)}${addition}${merged.slice(bodyEnd)}`;
  }
  return merged;
}

/** Bootstrap or non-destructively upgrade the pinned Hermes template config. */
export class EnsureTemplateConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.deferredExternalEffects && !ctx.applyingDeferredHostEffects) {
      return {
        success: true,
        outcome: "unchanged",
        message: "Hermes host config deferred until rendered lifecycle eligibility passes",
      };
    }
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync(path);
    if (exists && !force) {
      return { success: true, outcome: "unchanged", message: `Config present: ${path}` };
    }

    let next = renderHostConfig();
    let current = "";
    try {
      if (exists) {
        current = readFileSync(path, "utf8");
        next = mergeHostConfig(current);
      }
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (exists && next === current) {
      return { success: true, outcome: "unchanged", message: `Config schema already current: ${path}` };
    }
    if (ctx.dryRun) {
      return {
        success: true,
        outcome: "planned",
        filePath: path,
        message: `[DRY RUN] Would ${exists ? "merge missing schema fields into" : "create"} config: ${path}`,
      };
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    } catch (error) {
      return { success: false, outcome: "failed", message: `Failed to write ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return {
      success: true,
      outcome: "changed",
      filePath: path,
      message: `${exists ? "Updated" : "Bootstrapped"} config without replacing existing values: ${path}`,
    };
  }
}
