import type {
  LifecycleAuditFinding,
  LifecycleAuditReport,
  LifecycleContext,
  LifecycleMigrationReport,
  LifecycleMigrationResult,
  LifecycleRecipe,
  RecipeId,
  RecipeInitResult,
  RecipeMetadata,
  RuleId,
} from "./types";

/**
 * The sole lifecycle dispatch and ownership boundary.
 *
 * Registration is deliberately strict: recipe ids and public rule ids are
 * globally unique, dependencies must exist, and the dependency graph must be
 * acyclic. Ordering is stable: registration order for audit, dependencies-first
 * for init, requested order for selected migrations.
 */
export class RecipeRegistry {
  private readonly recipes = new Map<RecipeId, LifecycleRecipe>();
  private readonly ruleOwners = new Map<RuleId, { recipe: LifecycleRecipe; checkIndex: number }>();
  private validated = false;

  constructor(recipes: readonly LifecycleRecipe[] = []) {
    for (const recipe of recipes) this.register(recipe);
    if (recipes.length) this.validate();
  }

  register(recipe: LifecycleRecipe): this {
    if (this.recipes.has(recipe.metadata.id)) throw new Error(`Duplicate recipe id: ${recipe.metadata.id}`);
    const seenLocal = new Set<string>();
    for (let index = 0; index < recipe.checks.length; index++) {
      const check = recipe.checks[index]!;
      if (seenLocal.has(check.id) || this.ruleOwners.has(check.id)) throw new Error(`Duplicate parity rule id: ${check.id}`);
      seenLocal.add(check.id);
      this.ruleOwners.set(check.id, { recipe, checkIndex: index });
    }
    const declared = [...recipe.metadata.publicRuleIds];
    const actual = recipe.checks.map((check) => check.id);
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      throw new Error(`Recipe ${recipe.metadata.id} publicRuleIds do not match its checks`);
    }
    this.recipes.set(recipe.metadata.id, recipe);
    const registryAware = recipe as LifecycleRecipe & { attachRegistry?: (registry: RecipeRegistry) => void };
    registryAware.attachRegistry?.(this);
    this.validated = false;
    return this;
  }

  validate(): void {
    for (const recipe of this.recipes.values()) {
      for (const dependency of recipe.metadata.dependencies) {
        if (!this.recipes.has(dependency)) throw new Error(`Unknown dependency ${dependency} for recipe ${recipe.metadata.id}`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (visiting.has(id)) throw new Error(`Recipe dependency cycle: ${[...path, id].join(" -> ")}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const recipe = this.recipes.get(id)!;
      for (const dependency of recipe.metadata.dependencies) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.recipes.keys()) visit(id, []);
    this.validated = true;
  }

  private ensureValid(): void {
    if (!this.validated) this.validate();
  }

  list(): readonly RecipeMetadata[] {
    this.ensureValid();
    return [...this.recipes.values()].map((recipe) => recipe.metadata);
  }

  get(recipeId: RecipeId): LifecycleRecipe | undefined {
    return this.recipes.get(recipeId);
  }

  ownerOf(ruleId: RuleId): { recipe: LifecycleRecipe; check: LifecycleRecipe["checks"][number] } | undefined {
    const owner = this.ruleOwners.get(ruleId);
    if (!owner) return undefined;
    return { recipe: owner.recipe, check: owner.recipe.checks[owner.checkIndex]! };
  }

  resolveOrder(recipeId: RecipeId): LifecycleRecipe[] {
    this.ensureValid();
    if (!this.recipes.has(recipeId)) throw new Error(`Unknown recipe: ${recipeId}`);
    const ordered: LifecycleRecipe[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const recipe = this.recipes.get(id)!;
      for (const dependency of recipe.metadata.dependencies) visit(dependency);
      seen.add(id);
      ordered.push(recipe);
    };
    visit(recipeId);
    return ordered;
  }

  resolveDependencies(recipeId: RecipeId): LifecycleRecipe[] {
    return this.resolveOrder(recipeId).filter((recipe) => recipe.metadata.id !== recipeId);
  }

  private aggregateInit(recipeId: RecipeId, ctx: LifecycleContext, results: readonly RecipeInitResult[]): RecipeInitResult {
    const selected = results.at(-1) ?? {
      recipeId,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [],
      errors: [],
      phases: [],
    };
    return {
      ...selected,
      recipeId,
      ok: results.every((result) => result.ok),
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
      logs: results.flatMap((result) => result.logs),
      errors: results.flatMap((result) => result.errors),
      phases: results.flatMap((result) => result.phases),
      dependencyResults: results.slice(0, -1),
    };
  }

  async initDependencies<TInput>(recipeId: RecipeId, ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult> {
    const results: RecipeInitResult[] = [];
    for (const dependency of this.resolveDependencies(recipeId)) {
      const result = await dependency.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }

  async initRecipe<TInput>(recipeId: RecipeId, ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult> {
    this.ensureValid();
    const selected = this.recipes.get(recipeId);
    if (!selected) throw new Error(`Unknown recipe: ${recipeId}`);
    if (selected.orchestratesDependencies) return selected.init(ctx, input);

    const results: RecipeInitResult[] = [];
    for (const recipe of this.resolveOrder(recipeId)) {
      const result = await recipe.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }

  auditRecipes(ctx: LifecycleContext, recipeIds?: readonly RecipeId[]): LifecycleAuditReport {
    this.ensureValid();
    const selected = recipeIds ? recipeIds.map((id) => {
      const recipe = this.recipes.get(id);
      if (!recipe) throw new Error(`Unknown recipe: ${id}`);
      return recipe;
    }) : [...this.recipes.values()];
    const rules = selected.flatMap((recipe) => recipe.audit(ctx).map((finding) => ({ ...finding, recipeId: finding.recipeId ?? recipe.metadata.id })));
    return {
      repo: ctx.repoRoot,
      ok: rules.every((rule) => rule.status === "pass" || rule.status === "skip"),
      auditedAt: new Date().toISOString(),
      rules,
    };
  }

  migrateRules(ctx: LifecycleContext, ruleIds: readonly RuleId[]): LifecycleMigrationReport {
    this.ensureValid();
    const unknown = ruleIds.filter((id) => !this.ruleOwners.has(id));
    if (unknown.length) throw new Error(`Unknown parity rules: ${unknown.join(", ")}`);
    const results: LifecycleMigrationResult[] = [];
    for (const id of ruleIds) {
      const owner = this.ruleOwners.get(id)!;
      try {
        const migrated = owner.recipe.migrate(ctx, [id]);
        results.push(...migrated.map((result) => ({ ...result, recipeId: result.recipeId ?? owner.recipe.metadata.id })));
      } catch (err) {
        const check = owner.recipe.checks[owner.checkIndex]!;
        results.push({
          id,
          recipeId: owner.recipe.metadata.id,
          title: check.title,
          status: "blocked",
          summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
          changedFiles: [],
          details: [],
        });
      }
    }
    return {
      repo: ctx.repoRoot,
      dryRun: Boolean(ctx.dryRun),
      ok: results.every((result) => result.status !== "blocked"),
      selectedRules: [...ruleIds],
      results,
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
    };
  }

  migrateAll(ctx: LifecycleContext): LifecycleMigrationReport {
    const audit = this.auditRecipes(ctx);
    const ids = audit.rules.filter((rule) => rule.fixable && (rule.status === "fail" || rule.status === "warn")).map((rule) => rule.id);
    return this.migrateRules(ctx, ids);
  }

  listRuleIds(): readonly RuleId[] {
    this.ensureValid();
    return [...this.recipes.values()].flatMap((recipe) => recipe.checks.map((check) => check.id));
  }
}

export function metadata(input: Omit<RecipeMetadata, "publicRuleIds">, checks: readonly { id: string }[]): RecipeMetadata {
  return { ...input, publicRuleIds: checks.map((check) => check.id) };
}
