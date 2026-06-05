import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext, TicketProvider } from "./types";
import {
  SOUL_TONES,
  ROLE_CHOICES,
  TICKET_PROVIDERS,
  deriveAgentId,
  deriveProfileName,
} from "./types";

/**
 * Synergy with CommonProject: if this repo was bootstrapped by the base
 * template, its board provider already lives in .project.json. Read it so the
 * recipe defaults to the SAME provider the repo's board was created in, rather
 * than blindly defaulting to plane.
 */
function detectTicketProvider(targetDir: string): TicketProvider | undefined {
  try {
    const t = JSON.parse(readFileSync(join(targetDir, ".project.json"), "utf8"))
      ?.ticket_provider?.type;
    return t === "plane" || t === "linear" || t === "trello" ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First step of the hermes-agent recipe. Either:
 *  - non-interactive (context.yes === true): apply sensible defaults relative
 *    to the current repo and short-circuit;
 *  - interactive: walk the user through a TUI (Clack) to collect missing fields.
 *
 * In both cases, mutates `this.context` (cast to HermesAgentContext) so that
 * downstream commands have what they need.
 */
export class PromptForAgentConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;

    // Compute the default target_repo from the current working dir.
    // Lowercase here so the value is a valid hermes profile name, telegram
    // handle prefix, email local-part, and systemd unit slug — all of which
    // reject uppercase. GitHub repo names are case-insensitive, so this is safe.
    const defaultRepo = basename(ctx.targetDir).toLowerCase();
    const defaultRole = "pm";

    // --- Non-interactive shortcut ---
    if (ctx.yes) {
      ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
      ctx.role ??= defaultRole;
      ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
      ctx.soulTone ??= "direct";
      ctx.modelProvider ??= "";
      ctx.modelName ??= "";
      // Board provider: honor an explicit flag, else inherit the repo's
      // existing .project.json provider, else plane.
      ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
      // A bare `pm` provision does not auto-add the sentinel unless asked.
      ctx.withScrumMaster ??= false;
      // In --yes mode we always skip the human-input pieces (BotFather, CF).
      ctx.skipTelegram ??= true;
      ctx.skipEmail ??= true;
      ctx.agentId = deriveAgentId(ctx.targetRepo!, ctx.role!);
      ctx.profileName = deriveProfileName(ctx.targetRepo!, ctx.role!);
      return {
        success: true,
        message: this.formatMessage(
          `✓ Non-interactive mode — using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        ),
      };
    }

    // --- Interactive TUI ---
    p.intro("⚕  hermes-agent  ·  add a new agent role to this repo");

    // Pre-fill any values supplied via CLI flags; only prompt for what's missing.
    if (!ctx.targetRepo) {
      const answer = await p.text({
        message: "Target repo name",
        placeholder: defaultRepo,
        initialValue: defaultRepo,
        validate: (v) => (v && v.trim() ? undefined : "required"),
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.targetRepo = String(answer).trim().toLowerCase();
    }

    if (!ctx.role) {
      const answer = await p.select({
        message: "Role",
        options: ROLE_CHOICES.map((r) => ({ value: r.value, label: r.label, hint: r.hint })),
        initialValue: defaultRole,
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.role = String(answer).trim();
    }

    if (ctx.ticketProvider === undefined) {
      const detected = detectTicketProvider(ctx.targetDir);
      const answer = await p.select({
        message: "Ticket board provider",
        options: TICKET_PROVIDERS.map((t) => ({
          value: t.value,
          label: t.label,
          hint: t.value === detected ? `${t.hint} — current .project.json` : t.hint,
        })),
        initialValue: detected ?? "plane",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.ticketProvider = answer as TicketProvider;
    }

    // A PM owns the repo board; the Scrum Master is its continuous ticket
    // sentinel on the SAME board. Offer to provision both in one shot so the
    // pair is created together (identical end state to two separate runs).
    if (ctx.role === "pm" && ctx.withScrumMaster === undefined) {
      const answer = await p.confirm({
        message: "Also provision the paired Scrum Master (Ticket Sentinel) for this repo?",
        initialValue: true,
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.withScrumMaster = answer === true;
    }

    if (!ctx.agentPurpose) {
      const answer = await p.text({
        message: "One-line purpose",
        placeholder: `${ctx.role} agent for ${ctx.targetRepo}`,
        initialValue: `${ctx.role} agent for ${ctx.targetRepo}`,
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.agentPurpose = String(answer).trim();
    }

    if (!ctx.soulTone) {
      const answer = await p.select({
        message: "Personality tone",
        options: SOUL_TONES.map((t) => ({
          value: t,
          label: t,
          hint:
            t === "direct"
              ? "decision-forward, no preamble (default)"
              : t === "terse"
              ? "minimum words, conclusion-first"
              : t === "playful"
              ? "warm, mildly funny"
              : "precise, structured",
        })),
        initialValue: "direct",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.soulTone = answer as HermesAgentContext["soulTone"];
    }

    if (ctx.modelProvider === undefined) {
      const answer = await p.text({
        message: "Provider override (empty = inherit shared default profile)",
        placeholder: "",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.modelProvider = String(answer).trim();
    }

    if (ctx.modelName === undefined) {
      const answer = await p.text({
        message: "Model name override (empty = inherit shared default profile)",
        placeholder: "",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.modelName = String(answer).trim();
    }

    if (ctx.skipTelegram === undefined) {
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${ctx.targetRepo}_${ctx.role}_bot) now?`,
        initialValue: true,
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }

    if (ctx.skipEmail === undefined) {
      const wire = await p.confirm({
        message: `Provision the delo.sh email address (${ctx.targetRepo}-${ctx.role}@delo.sh) now?`,
        initialValue: true,
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipEmail = !wire;
    }

    ctx.agentId = deriveAgentId(ctx.targetRepo!, ctx.role!);
    ctx.profileName = deriveProfileName(ctx.targetRepo!, ctx.role!);
    return {
      success: true,
      message: this.formatMessage(
        `✓ Collected agent config  (agent_id=${ctx.agentId}, profile=${ctx.profileName})`
      ),
    };
  }

  private cancelled(): InvokeResult {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
}
