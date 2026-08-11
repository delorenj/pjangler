import { Recipe, mergeInitResults } from "./Recipe";
import { EnsureTemplateConfig } from "../commands/hermes/EnsureTemplateConfig";
import { PromptForAgentConfig } from "../commands/hermes/PromptForAgentConfig";
import { RunCopierTemplate } from "../commands/hermes/RunCopierTemplate";
import { UntrackHermesRuntimes } from "../commands/hermes/UntrackHermesRuntimes";
import { WireTelegram } from "../commands/hermes/WireTelegram";
import { WireEmail } from "../commands/hermes/WireEmail";
import { PrintHermesSummary } from "../commands/hermes/PrintHermesSummary";
import { createHermesChecks } from "../parity/rules";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata, RecipePhaseOutcome, RecipePhaseStatus } from "./types";
import { resolve } from "node:path";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";

/**
 * Recipe that provisions a Hermes agent role into the current project repo.
 *
 * Chain (each command mutates the shared context):
 *   1. EnsureTemplateConfig  — bootstrap ~/.config/hermes-agent-template/config.toml if missing
 *   2. PromptForAgentConfig  — TUI (or accepts defaults via --yes)
 *   3. RunCopierTemplate     — copier copy gh:delorenj/hermes-agent-template
 *   4. UntrackHermesRuntimes — untrack the runtime repo submodule & gitignore it
 *   5. WireTelegram          — BotFather token capture (skippable)
 *   6. WireEmail             — CF Email Routing rule (skippable)
 *   7. PrintHermesSummary    — connection points + next commands
 *
 * We deliberately swallow the base Recipe's "✓/⚠️ created file" line — our
 * commands print their own rich status via @clack/prompts, and we don't want
 * doubled output.
 */
export class HermesAgentRecipe extends Recipe {
  readonly checks = createHermesChecks();
  readonly metadata: RecipeMetadata = {
    id: "hermes-agent",
    name: "hermes-agent",
    description: "Add and reconcile a Hermes agent role",
    dependencies: [],
    commands: [
      "EnsureTemplateConfig",
      "PromptForAgentConfig",
      "RunCopierTemplate",
      "UntrackHermesRuntimes",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary",
    ],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  /** Hermes sequencing is fatal/cancel short-circuiting under registry init. */
  override async init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    const phases: RecipePhaseOutcome[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const changedFiles: string[] = [];

    // Resolve constructors lazily at dispatch time. The bundled CLI also
    // imports EnsureTemplateConfig directly for `config bootstrap`; capturing
    // that binding while the singleton catalog is being evaluated would store
    // `undefined` before the command module finishes initializing.
    const ingredients = [
      EnsureTemplateConfig,
      PromptForAgentConfig,
      RunCopierTemplate,
      UntrackHermesRuntimes,
      WireTelegram,
      WireEmail,
      PrintHermesSummary,
    ] as const;
    for (const [ingredientIndex, CommandClass] of ingredients.entries()) {
      if (typeof CommandClass !== "function") {
        throw new TypeError(`Hermes ingredient ${ingredientIndex} is not constructable`);
      }
      const before = ctx.dryRun ? undefined : snapshotTree(ctx.targetDir);
      const result = await new CommandClass(ctx).invoke();
      const observedChanges = before ? changedTreePaths(ctx.targetDir, before, snapshotTree(ctx.targetDir)) : [];
      let status: RecipePhaseStatus = result.outcome ?? (result.success
        ? (ctx.dryRun && result.filePath ? "planned" : result.filePath ? "changed" : "unchanged")
        : "failed");
      if (result.success && !ctx.dryRun && observedChanges.length) status = "changed";
      const declaredChanges = status === "changed" && result.filePath ? [resolve(ctx.targetDir, result.filePath)] : [];
      const actualChanges = [...new Set([...observedChanges, ...declaredChanges])].sort();
      phases.push({ id: CommandClass.name, status, changedFiles: actualChanges, message: result.message || undefined });
      changedFiles.push(...actualChanges);
      if (result.message) logs.push(result.message);
      if (status === "failed" || status === "cancelled") {
        errors.push(result.message || `${CommandClass.name} ${status}`);
        break;
      }
    }

    const commandResult: RecipeInitResult = {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
    };
    if (!commandResult.ok) return commandResult;
    const lifecycle = await this.initializeOwnedChecks(ctx);
    return mergeInitResults(this.metadata.id, Boolean(ctx.dryRun), [commandResult, lifecycle]);
  }

  protected printNextSteps(): void {
    // PrintHermesSummary handles this via the recipe chain.
  }
}
