import { Recipe, mergeInitResults } from "./Recipe";
import { EnsureTemplateConfig } from "../commands/hermes/EnsureTemplateConfig";
import { PromptForAgentConfig } from "../commands/hermes/PromptForAgentConfig";
import { RunCopierTemplate } from "../commands/hermes/RunCopierTemplate";
import { UntrackHermesRuntimes } from "../commands/hermes/UntrackHermesRuntimes";
import { WireTelegram } from "../commands/hermes/WireTelegram";
import { WireEmail } from "../commands/hermes/WireEmail";
import { PrintHermesSummary } from "../commands/hermes/PrintHermesSummary";
import { ApplyDeferredExternalEffects } from "../commands/hermes/ApplyDeferredExternalEffects";
import { ApplyDeferredHostEffects } from "../commands/hermes/ApplyDeferredHostEffects";
import type { HermesAgentContext } from "../commands/hermes/types";
import { createHermesChecks } from "../parity/rules";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata, RecipePhaseOutcome, RecipePhaseStatus } from "./types";
import { resolve } from "node:path";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";
import { preflightRenderedHermes } from "../lifecycle/preflight";

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

      // Copier's trusted, version-locked inputs were attested before launch.
      // Validate its repo-local projection before any deferred config/profile/
      // fleet effect runs, so a structural lifecycle failure cannot first be
      // discovered after host state has changed.
      if (!ctx.dryRun && CommandClass === RunCopierTemplate && (ctx as HermesAgentContext).deferredExternalEffects) {
        const hermesContext = ctx as HermesAgentContext;
        const eligibility = hermesContext.roleDir
          && hermesContext.targetRepo
          && hermesContext.role
          && hermesContext.agentId
          ? preflightRenderedHermes({
              pjanglerRoot: ctx.pjanglerRoot,
              targetDir: ctx.targetDir,
              roleDir: hermesContext.roleDir,
              targetRepo: hermesContext.targetRepo,
              role: hermesContext.role,
              agentId: hermesContext.agentId,
            })
          : { ok: false, error: "Hermes render did not establish role identity" };
        phases.push({
          id: "hermes.rendered-eligibility",
          status: eligibility.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: eligibility.ok ? "Rendered Hermes lifecycle eligibility passed" : eligibility.error,
        });
        if (!eligibility.ok) {
          errors.push(`hermes.rendered-eligibility: ${eligibility.error ?? "unknown eligibility failure"}`);
          break;
        }

        const beforeHost = snapshotTree(ctx.targetDir);
        const host = await new ApplyDeferredHostEffects(ctx).invoke();
        const hostChanges = changedTreePaths(ctx.targetDir, beforeHost, snapshotTree(ctx.targetDir));
        phases.push({
          id: "hermes.host-effects",
          status: host.success ? (hostChanges.length ? "changed" : "unchanged") : "failed",
          changedFiles: host.success ? hostChanges : [],
          message: host.message || undefined,
        });
        changedFiles.push(...hostChanges);
        if (host.message) logs.push(host.message);
        if (!host.success) {
          errors.push(host.message || "Deferred Hermes host effects failed");
          break;
        }
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
    const localResult = mergeInitResults(this.metadata.id, Boolean(ctx.dryRun), [commandResult, lifecycle]);
    if (!localResult.ok || ctx.dryRun) return localResult;

    const hermesContext = ctx as HermesAgentContext;
    if (hermesContext.deferredExternalEffects?.owner !== "hermes") return localResult;
    const selected = hermesContext.deferredExternalEffects;
    if (!selected.runtimeRepo && !selected.ticketBoard && !selected.systemd) return localResult;

    const beforeExternal = snapshotTree(ctx.targetDir);
    const external = await new ApplyDeferredExternalEffects(ctx).invoke();
    const externalChanges = changedTreePaths(ctx.targetDir, beforeExternal, snapshotTree(ctx.targetDir));
    const externalResult: RecipeInitResult = {
      recipeId: this.metadata.id,
      ok: external.success,
      dryRun: false,
      changedFiles: externalChanges,
      logs: external.message ? [external.message] : [],
      errors: external.success ? [] : [external.message || "Deferred Hermes external effects failed"],
      phases: [{
        id: "hermes.external-effects",
        status: external.success ? "changed" : "failed",
        changedFiles: external.success ? externalChanges : [],
        message: external.message || undefined,
      }],
    };
    if (!externalResult.ok) return mergeInitResults(this.metadata.id, false, [localResult, externalResult]);

    const findings = this.audit(ctx).filter((finding) => finding.status !== "pass" && finding.status !== "skip");
    const verification: RecipeInitResult = {
      recipeId: this.metadata.id,
      ok: findings.length === 0,
      dryRun: false,
      changedFiles: [],
      logs: [],
      errors: findings.map((finding) => `${finding.id}: ${finding.summary}`),
      phases: [{
        id: "hermes.postcondition-audit",
        status: findings.length ? "failed" : "unchanged",
        changedFiles: [],
        message: findings.length ? "Hermes postcondition audit failed" : "Hermes postcondition audit passed",
      }],
    };
    return mergeInitResults(this.metadata.id, false, [localResult, externalResult, verification]);
  }

  protected printNextSteps(): void {
    // PrintHermesSummary handles this via the recipe chain.
  }
}
