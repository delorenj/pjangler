import { Recipe } from "./Recipe";
import { CopyAgentHooksTree, WireMiseAgentHooks } from "../commands/AgentHooksCommands";
import type { CommandContext } from "../commands/Command";

/**
 * Retrofit an existing repo with the project-scoped agent-hooks + skill manifest
 * layer (Claude/Codex/Kimi/Hermes hooks + sync-skills manifest via mise enter/leave).
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
    console.log("   1. mise run skills-sync  # sync .agents/skills.json into local CLI dirs");
    console.log("   2. mise run hooks-sync   # generate .claude/settings.json + inject codex/kimi/hermes");
    console.log("   3. git add .claude/settings.json .agents/hooks .agents/skills.json && commit (codex/kimi/hermes are per-dev)");
    console.log("   4. mise run hindsight-setup   # set HINDSIGHT_OP_KEY_REF to your 1Password item first");
    console.log("   5. Optional per-dev hook opt-out: copy .agents/local.example.json -> .agents/local.json");
  }
}
