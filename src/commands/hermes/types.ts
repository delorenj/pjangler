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
  withScrumMaster?: boolean;        // pm only: also provision the paired Ticket Sentinel

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

/**
 * Roles offered in the recipe TUI. Kept in parity with the copier template's
 * `role` choices (copier.yml). `value` is what we pass to `--data role=`;
 * `label`/`hint` drive the Clack select.
 */
export const ROLE_CHOICES = [
  { value: "pm", label: "Project Manager (pm)", hint: "triage, planning, ticket authorship" },
  {
    value: "scrum-master",
    label: "Scrum Master (Ticket Sentinel)",
    hint: "continuous ticket sentinel + autonomous delegated review",
  },
  { value: "dev", label: "Developer (dev)", hint: "implements tickets" },
  { value: "review", label: "Reviewer (review)", hint: "adversarial code review" },
  { value: "ops", label: "Ops (ops)", hint: "deploy / infra" },
  { value: "qa", label: "QA (qa)", hint: "test authorship + verification" },
] as const;

export type TicketProvider = "plane" | "linear" | "trello";

export const TICKET_PROVIDERS = [
  { value: "plane", label: "Plane", hint: "self-hosted at plane.delo.sh (default)" },
  { value: "linear", label: "Linear", hint: "team board (created in Linear UI)" },
  { value: "trello", label: "Trello", hint: "board = project" },
] as const;

export function deriveAgentId(repo: string, role: string): string {
  return `${repo}-${role}`.toLowerCase();
}
