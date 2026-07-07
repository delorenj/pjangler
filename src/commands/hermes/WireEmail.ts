import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../Command";
import type { HermesAgentContext } from "./types";

/**
 * Cloudflare Email Routing rule provisioning.
 *
 * Token resolution order (delegated to the .scripts/50-email.sh):
 *   1. $CF_EMAIL_ROUTING_TOKEN
 *   2. op://DeLoSecrets/Cloudflare-EmailRouting/token
 *   3. fail with instructions
 *
 * We add a TUI layer that:
 *   - checks env first (no prompt needed)
 *   - checks 1Password (no prompt)
 *   - if both miss, OFFERS to paste a token now (one-time setup)
 */
export class WireEmail extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.skipEmail) {
      // Email is opt-in only (`--email`). Stay silent when off so the default
      // flow never mentions email at all.
      return { success: true, message: "" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }

    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join(roleDir, ".scripts", "50-email.sh");
    if (!existsSync(script)) {
      return { success: false, message: `✗ ${script} not found` };
    }

    // Token discovery
    let token = process.env.CF_EMAIL_ROUTING_TOKEN;
    if (!token) {
      const tryOp = spawnSync(
        "op",
        ["read", "op://DeLoSecrets/Cloudflare-EmailRouting/token"],
        { encoding: "utf8" }
      );
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
      }
    }

    if (!token) {
      p.log.warn("CF Email Routing token not found.  Required scopes:");
      p.log.info(
        [
          "  Zone (delo.sh)  →  Email Routing Rules     : Edit",
          "  Zone (delo.sh)  →  Email Routing Settings  : Read",
          "  Account         →  Email Routing Addresses : Read",
          "Create at: https://dash.cloudflare.com/profile/api-tokens",
        ].join("\n")
      );

      const provideNow = await p.confirm({
        message: "Paste a token now?  (skipping leaves email unwired until you re-run.)",
        initialValue: false,
      });
      if (p.isCancel(provideNow) || !provideNow) {
        return { success: true, message: "→ Email skipped (no token).  Re-run later." };
      }

      const tokenAnswer = await p.password({
        message: "CF token (will be passed via env, not stored)",
        mask: "•",
        validate: (v) => (String(v ?? "").trim() ? undefined : "required"),
      });
      if (p.isCancel(tokenAnswer)) {
        return { success: true, message: "→ Email skipped (cancelled)" };
      }
      token = String(tokenAnswer).trim();

      const persist = await p.confirm({
        message: "Save to op://DeLoSecrets/Cloudflare-EmailRouting/token for next time?",
        initialValue: true,
      });
      if (!p.isCancel(persist) && persist) {
        const create = spawnSync(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            "--title=Cloudflare-EmailRouting",
            `token=${token}`,
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p.log.warn("Could not store in 1Password — token is still set for this run.");
        }
      }
    }

    // Drop the .done marker for idempotent re-run
    const marker = join(roleDir, ".scripts", ".done-50-email");
    if (existsSync(marker)) unlinkSync(marker);

    const spinner = p.spinner();
    spinner.start("Creating Cloudflare Email Routing rule");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: { ...process.env, SKIP_EMAIL: "0", CF_EMAIL_ROUTING_TOKEN: token },
      cwd: roleDir,
    });
    spinner.stop(result.status === 0 ? "✓ Email rule created" : "✗ Email step failed");

    if (result.status !== 0) {
      return { success: false, message: "Email rule creation failed.  See output above." };
    }
    return {
      success: true,
      message: `✓ Email: ${targetRepo}-${role}@delo.sh  →  jaradd@gmail.com`,
    };
  }
}
