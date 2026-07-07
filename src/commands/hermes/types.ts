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
  ticketProvider?: TicketProvider;  // "plane" by default — board lives here

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
  profileName?: string;       // named Hermes profile, conventionally <targetRepo>-<role>
  roleDir?: string;           // <projectRoot>/agents/hermes/<role>
  runtimeRepo?: string;       // delorenj/agent-hm-<repo>-<role>
}

export const HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";

export const SOUL_TONES = ["direct", "playful", "formal", "terse"] as const;

// NOTE: the fleet is PM-only (one `<repo>-pm` agent per repo), so the recipe no
// longer offers a role selection. `role` defaults to "pm" and is overridable
// only via the `--role` flag / MCP input for programmatic/edge use. The copier
// template still accepts a `role` value, so other roles remain reachable
// out-of-band — they're just not part of the interactive flow.

export type TicketProvider = "plane" | "linear" | "trello";

export const TICKET_PROVIDERS = [
  { value: "plane", label: "Plane", hint: "self-hosted at plane.delo.sh (default)" },
  { value: "linear", label: "Linear", hint: "team board (created in Linear UI)" },
  { value: "trello", label: "Trello", hint: "board = project" },
] as const;

export function deriveAgentId(repo: string, role: string): string {
  return `${repo}-${role}`.toLowerCase();
}

export function deriveProfileName(repo: string, role: string): string {
  return deriveAgentId(repo, role);
}
