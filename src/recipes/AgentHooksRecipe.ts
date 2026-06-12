import { Recipe } from "./Recipe";
import { CopyAgentHooksTree, WireMiseAgentHooks } from "../commands/AgentHooksCommands";
import type { CommandContext } from "../commands/Command";

/**
 * Retrofit an existing repo with the project-scoped agent-hooks + skill fan-out
 * layer (Claude/Codex/Kimi/Hermes hooks + skills installed via mise enter/leave).
 * New projects get this from the CommonProject template directly; this recipe is
 * for repos created before the template carried it.
 */
export class AgentHooksRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);
    this
      .addIngredient(CopyAgentHooksTree)
      .addIngredient(WireMiseAgentHooks);
  }

  protected printNextSteps(): void {
    console.log("🪝 Agent-hooks layer installed!");
    console.log("   Next steps:");
    console.log("   1. mise run hooks-sync   # generate .claude/settings.json + inject codex/kimi/hermes");
    console.log("   2. git add .claude/settings.json .agents/hooks && commit (codex/kimi/hermes are per-dev)");
    console.log("   3. mise run hindsight-setup   # set HINDSIGHT_OP_KEY_REF to your 1Password item first");
    console.log("   4. If you run a global agent system: echo '{\"skills\":{\"defer_to_global\":true}}' > .agents/local.json");
  }
}
