import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

/**
 * Final outro: prints the agent's connection points + start commands.
 */
export class PrintHermesSummary extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    const { targetRepo, role, agentId, runtimeRepo, skipTelegram, skipEmail } = ctx;

    const botHandle = `${targetRepo?.toLowerCase().replace(/-/g, "_")}_${role?.toLowerCase()}_bot`;
    const email = `${targetRepo}-${role}@delo.sh`;
    const gw = `hermes-${agentId}-gateway.service`;
    const csm = `hermes-${agentId}-consumer.service`;
    const hb = `hermes-${agentId}-heartbeat.timer`;

    const lines: string[] = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    // Email is opt-in only; only surface it when it was actually provisioned.
    if (!skipEmail) lines.push(`email        ${email}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${csm}`);
    lines.push(`  systemctl --user start ${hb}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram) {
      lines.push("");
      lines.push("Wire Telegram later:");
      lines.push("  pjangler hermes-agent          # re-run and answer yes when asked");
    }

    p.note(lines.join("\n"), `Provisioned ${agentId}`);
    p.outro("Done.");
    return { success: true, message: "" };
  }
}
