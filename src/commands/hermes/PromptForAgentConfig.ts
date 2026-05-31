import { basename } from "node:path";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";
import { SOUL_TONES, deriveAgentId } from "./types";

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
      // In --yes mode we always skip the human-input pieces (BotFather, CF).
      ctx.skipTelegram ??= true;
      ctx.skipEmail ??= true;
      ctx.agentId = deriveAgentId(ctx.targetRepo!, ctx.role!);
      return {
        success: true,
        message: this.formatMessage(
          `✓ Non-interactive mode — using defaults  (repo=${ctx.targetRepo}, role=${ctx.role})`
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
      const answer = await p.text({
        message: "Role",
        placeholder: "pm",
        initialValue: defaultRole,
        validate: (v) =>
          /^[a-z][a-z0-9_-]*$/.test(String(v).trim())
            ? undefined
            : "lowercase alphanumerics, may include - or _",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.role = String(answer).trim();
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
        message: "Provider override (empty = inherit global)",
        placeholder: "",
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.modelProvider = String(answer).trim();
    }

    if (ctx.modelName === undefined) {
      const answer = await p.text({
        message: "Model name override (empty = inherit global)",
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
    return {
      success: true,
      message: this.formatMessage(`✓ Collected agent config  (agent_id=${ctx.agentId})`),
    };
  }

  private cancelled(): InvokeResult {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
}
