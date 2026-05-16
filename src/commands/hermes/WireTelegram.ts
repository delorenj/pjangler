import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

/**
 * Walks the user through BotFather + captures the token + wires it into the
 * runtime profile.  Most of the heavy lifting lives in the copier template's
 * `.scripts/30-telegram.sh` — we just invoke it with TELEGRAM_BOT_TOKEN
 * pre-populated from a clack secret prompt (so the token doesn't echo).
 *
 * Skipped when:
 *   - ctx.skipTelegram === true (CLI flag or interactive "no")
 *   - dryRun
 */
export class WireTelegram extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.skipTelegram) {
      return { success: true, message: "→ Telegram wire-up skipped" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }

    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }

    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;

    p.log.step("BotFather steps");
    p.log.info(
      [
        "  1. Open Telegram, message @BotFather",
        "  2. /newbot",
        `  3. Display name:   ${displayName}`,
        `  4. Username:       ${botHandle}   (must end in _bot)`,
        "  5. Copy the HTTP API token from the reply.",
        "  6. /setjoingroups Disable",
        "  7. /setprivacy    Disable",
      ].join("\n")
    );

    const tokenAnswer = await p.password({
      message: `Paste the bot token for @${botHandle}`,
      mask: "•",
      validate: (v) => {
        const s = String(v ?? "").trim();
        if (!s) return "required";
        if (!/^[0-9]+:.+/.test(s)) return "expected '<digits>:<secret>' shape";
      },
    });
    if (p.isCancel(tokenAnswer)) {
      return { success: false, message: "✗ Aborted; Telegram step deferred." };
    }
    const token = String(tokenAnswer).trim();

    const allowedAnswer = await p.text({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v) =>
        /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v).trim()) ? undefined : "comma-separated numeric ids",
    });
    if (p.isCancel(allowedAnswer)) {
      return { success: false, message: "✗ Aborted; Telegram step deferred." };
    }

    const script = join(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync(script)) {
      return {
        success: false,
        message: `✗ ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`,
      };
    }

    // Drop the .done marker so the script re-runs cleanly
    const marker = join(roleDir, ".scripts", ".done-30-telegram");
    try {
      const { unlinkSync } = require("node:fs");
      if (existsSync(marker)) unlinkSync(marker);
    } catch { /* ignore */ }

    const spinner = p.spinner();
    spinner.start("Verifying token + wiring profile");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim(),
      },
      cwd: roleDir,
    });
    spinner.stop(result.status === 0 ? "✓ Telegram wired" : "✗ Telegram step failed");

    if (result.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }

    return { success: true, message: `✓ Telegram: @${botHandle} ready` };
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
