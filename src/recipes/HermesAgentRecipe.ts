import { Recipe } from "./Recipe";
import type { CommandContext } from "../commands/Command";
import { PromptForAgentConfig } from "../commands/hermes/PromptForAgentConfig";
import { RunCopierTemplate } from "../commands/hermes/RunCopierTemplate";
import { WireTelegram } from "../commands/hermes/WireTelegram";
import { WireEmail } from "../commands/hermes/WireEmail";
import { PrintHermesSummary } from "../commands/hermes/PrintHermesSummary";

/**
 * Recipe that provisions a Hermes agent role into the current project repo.
 *
 * Chain (each command mutates the shared context):
 *   1. PromptForAgentConfig  — TUI (or accepts defaults via --yes)
 *   2. RunCopierTemplate     — copier copy gh:delorenj/hermes-agent-template
 *   3. WireTelegram          — BotFather token capture (skippable)
 *   4. WireEmail             — CF Email Routing rule (skippable)
 *   5. PrintHermesSummary    — connection points + next commands
 *
 * We deliberately swallow the base Recipe's "✓/⚠️ created file" line — our
 * commands print their own rich status via @clack/prompts, and we don't want
 * doubled output.
 */
export class HermesAgentRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(PromptForAgentConfig)
      .addIngredient(RunCopierTemplate)
      .addIngredient(WireTelegram)
      .addIngredient(WireEmail)
      .addIngredient(PrintHermesSummary);
  }

  // Override execute() to suppress the base class's per-command logging since
  // our commands already render their own UI via @clack/prompts.
  async execute(): Promise<void> {
    for (const command of this.ingredients) {
      const result = await command.invoke();
      // Short-circuit on hard failure (e.g. user cancelled prompt). The Recipe
      // base class would keep going; we stop so the user isn't left half-provisioned.
      if (!result.success && result.message.startsWith("✗")) {
        console.error(result.message);
        return;
      }
      if (result.message && !result.message.startsWith("✓ Collected")) {
        // PromptForAgentConfig's success line is internal noise; skip it.
        // Other commands' messages are useful, but most already render via clack;
        // only print the residual ones (e.g. "→ Telegram skipped").
        if (result.message.startsWith("→") || result.message.startsWith("✓ Provisioned")) {
          console.log(result.message);
        }
      }
    }
  }

  protected printNextSteps(): void {
    // PrintHermesSummary handles this via the recipe chain; the base
    // class's printNextSteps is bypassed because we override execute().
  }
}
