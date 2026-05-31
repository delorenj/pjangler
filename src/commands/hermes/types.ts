import type { CommandContext } from "../Command";

/**
 * Context for the hermes-agent recipe. Extends the base CommandContext with
 * the answers collected by PromptForAgentConfig (or supplied via CLI flags).
 *
 * Convention: PromptForAgentConfig mutates `context` in place with these
 * fields populated before downstream commands run.
 */
export interface HermesAgentContext extends CommandContext {
  // --- collected/provided ---
  targetRepo?: string;        // basename($PWD) by default
  role?: string;              // "pm" by default
  agentPurpose?: string;
  soulTone?: "direct" | "playful" | "formal" | "terse";
  modelProvider?: string;
  modelName?: string;

  // --- behavior toggles ---
  yes?: boolean;              // non-interactive; accept all defaults
  local?: boolean;            // local-only: skip runtime repo / Plane / Bloodbank / systemd
  forceConfig?: boolean;      // regenerate ~/.config/hermes-agent-template/config.toml
  skipTelegram?: boolean;
  skipEmail?: boolean;
  skipRuntimeRepo?: boolean;
  skipSystemd?: boolean;
  skipBloodbank?: boolean;
  skipPlane?: boolean;

  // --- derived after copier runs ---
  agentId?: string;           // <targetRepo>-<role>
  roleDir?: string;           // <projectRoot>/agents/hermes/<role>
  runtimeRepo?: string;       // delorenj/agent-hm-<repo>-<role>
}

export const HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";

export const SOUL_TONES = ["direct", "playful", "formal", "terse"] as const;

export function deriveAgentId(repo: string, role: string): string {
  return `${repo}-${role}`.toLowerCase();
}
