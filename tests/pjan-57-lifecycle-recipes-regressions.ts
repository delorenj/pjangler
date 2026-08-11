import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command, type InvokeResult } from "../src/commands/Command";
import { Recipe } from "../src/recipes/Recipe";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { recipeRegistry } from "../src/recipes/catalog";
import { RecipeRegistry } from "../src/recipes/registry";
import type {
  LifecycleAuditFinding,
  LifecycleContext,
  LifecycleMigrationResult,
  LifecycleRecipe,
  RecipeCheck,
  RecipeInitResult,
  RecipeMetadata,
} from "../src/recipes/types";
import type { ProjectInitPlan } from "../src/project/index";
import { RECIPE_REGISTRY } from "../src/utils/registry";

const root = resolve(process.cwd());
const ctx = (repoRoot: string): LifecycleContext => ({
  targetDir: repoRoot,
  repoRoot,
  pjanglerRoot: root,
  homeDir: tmpdir(),
  dryRun: false,
  force: false,
});

const initResult = (id: string, ok = true): RecipeInitResult => ({
  recipeId: id,
  ok,
  dryRun: false,
  changedFiles: [],
  logs: [],
  errors: ok ? [] : [`${id} failed`],
  phases: [],
});

function check(id: string, status: LifecycleAuditFinding["status"] = "pass", fixable = true): RecipeCheck {
  return {
    id,
    title: id,
    audit: () => ({ id, title: id, status, summary: status, details: [], fixable }),
    migrate: () => ({ id, title: id, status: status === "pass" ? "noop" : "applied", summary: id, changedFiles: [], details: [] }),
  };
}

class FakeRecipe implements LifecycleRecipe {
  readonly metadata: RecipeMetadata;
  constructor(
    readonly id: string,
    readonly checks: readonly RecipeCheck[] = [],
    dependencies: readonly string[] = [],
    private readonly events: string[] = [],
    private readonly initOk = true,
  ) {
    this.metadata = { id, name: id, description: id, dependencies, commands: [], publicRuleIds: checks.map((item) => item.id) };
  }
  async init(): Promise<RecipeInitResult> {
    this.events.push(`init:${this.id}`);
    return initResult(this.id, this.initOk);
  }
  audit(context: LifecycleContext): LifecycleAuditFinding[] {
    this.events.push(`audit:${this.id}`);
    return this.checks.map((item) => ({ ...item.audit(context), recipeId: this.id }));
  }
  migrate(context: LifecycleContext, ruleIds: readonly string[]): LifecycleMigrationResult[] {
    this.events.push(`migrate:${this.id}:${ruleIds.join(",")}`);
    return this.checks
      .filter((item) => ruleIds.includes(item.id))
      .map((item) => ({ ...item.migrate(context, item.audit(context)), recipeId: this.id }));
  }
}

assert.throws(() => new RecipeRegistry([new FakeRecipe("same"), new FakeRecipe("same")]), /Duplicate recipe id/);
assert.throws(() => new RecipeRegistry([new FakeRecipe("one", [check("same")]), new FakeRecipe("two", [check("same")])]), /Duplicate parity rule id/);
assert.throws(() => new RecipeRegistry([new FakeRecipe("one", [], ["missing"])]), /Unknown dependency missing/);
assert.throws(() => new RecipeRegistry([new FakeRecipe("one", [], ["two"]), new FakeRecipe("two", [], ["one"])]), /dependency cycle/);

{
  const events: string[] = [];
  const registry = new RecipeRegistry([
    new FakeRecipe("base", [check("base.rule", "fail")], [], events),
    new FakeRecipe("middle", [check("middle.rule", "warn")], ["base"], events),
    new FakeRecipe("top", [check("top.rule")], ["middle", "base"], events),
  ]);
  assert.deepEqual(registry.resolveOrder("top").map((recipe) => recipe.metadata.id), ["base", "middle", "top"]);
  const initialized = await registry.initRecipe("top", ctx(tmpdir()), {});
  assert.equal(initialized.ok, true);
  assert.deepEqual(events.filter((event) => event.startsWith("init:")), ["init:base", "init:middle", "init:top"]);
  events.length = 0;
  assert.deepEqual(registry.auditRecipes(ctx(tmpdir())).rules.map((rule) => rule.id), ["base.rule", "middle.rule", "top.rule"]);
  const selected = registry.migrateRules(ctx(tmpdir()), ["middle.rule", "base.rule"]);
  assert.deepEqual(selected.selectedRules, ["middle.rule", "base.rule"]);
  assert.deepEqual(events.filter((event) => event.startsWith("migrate:")), ["migrate:middle:middle.rule", "migrate:base:base.rule"]);
  events.length = 0;
  const all = registry.migrateAll(ctx(tmpdir()));
  assert.deepEqual(all.selectedRules, ["base.rule", "middle.rule"]);
}

{
  const events: string[] = [];
  const registry = new RecipeRegistry([
    new FakeRecipe("bad", [], [], events, false),
    new FakeRecipe("later", [], ["bad"], events),
  ]);
  const result = await registry.initRecipe("later", ctx(tmpdir()), {});
  assert.equal(result.ok, false);
  assert.deepEqual(events, ["init:bad"], "a fatal dependency must stop later lifecycle init");
}

class UnchangedCommand extends Command {
  async invoke(): Promise<InvokeResult> {
    return { success: true, outcome: "unchanged", message: "already present", filePath: "untouched.txt" };
  }
}
class FailedCommand extends Command {
  async invoke(): Promise<InvokeResult> {
    return { success: false, outcome: "failed", message: "fatal" };
  }
}
class MustNotRunCommand extends Command {
  async invoke(): Promise<InvokeResult> {
    throw new Error("later ingredient ran after failure");
  }
}
class StructuredRecipe extends Recipe {
  readonly checks: readonly RecipeCheck[] = [];
  readonly metadata: RecipeMetadata = { id: "structured", name: "structured", description: "structured", dependencies: [], commands: [], publicRuleIds: [] };
  constructor() {
    super();
    this.addIngredient(UnchangedCommand).addIngredient(FailedCommand).addIngredient(MustNotRunCommand);
  }
  init(context: LifecycleContext): Promise<RecipeInitResult> { return this.invokeIngredients(context); }
  protected printNextSteps(): void {}
}
{
  const result = await new StructuredRecipe().init(ctx(tmpdir()), {});
  assert.equal(result.ok, false);
  assert.deepEqual(result.changedFiles, [], "unchanged file paths must never be reported as writes");
  assert.deepEqual(result.phases.map((phase) => phase.status), ["unchanged", "failed"]);
}

for (const [id, dependencies] of [
  ["mise-op-inject", []],
  ["mise", ["mise-op-inject"]],
  ["agent-hooks", ["mise"]],
  ["bmad", ["agent-hooks"]],
  ["project", ["mise", "agent-hooks", "bmad"]],
] as const) {
  assert.deepEqual(recipeRegistry.get(id)?.metadata.dependencies, dependencies, `${id} production dependencies`);
}
for (const [id, info] of Object.entries(RECIPE_REGISTRY)) {
  assert.equal(info.instance, recipeRegistry.get(id), `legacy facade ${id} must expose the registered singleton`);
}

function projectFixture(): { dir: string; plan: ProjectInitPlan } {
  const dir = mkdtempSync(join(tmpdir(), "pjan-57-project-recipe-"));
  const project = {
    name: "Boundary Test",
    slug: "boundary-test",
    repo_path: dir,
    description: "ProjectRecipe boundary",
    status: "active",
    source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "BOUN", board_id: "", state: "planned" },
    agents: {},
    automation: { reconcile: { enabled: false, grace_hours: 0, auto_review: true } },
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
  } as const;
  const manifest = {
    project_name: project.name,
    project_description: project.description,
    project_slug: project.slug,
    repo_path: dir,
    ticket_provider: project.ticket_provider,
    agents: {},
    automation: project.automation,
  };
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, ".copier-answers.yml"), `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY\n_src_path: ${join(root, "templates", "commonproject")}\nproject_description: ${project.description}\nproject_name: ${project.name}\nticket_provider: plane\n`);
  return {
    dir,
    plan: { ok: true, apply: true, dryRun: false, live: false, registryPath: join(dir, "registry.yaml"), project: project as never, manifest: manifest as never, actions: [] },
  };
}

{
  const fixture = projectFixture();
  const gitCalls: string[][] = [];
  const runtime: ProjectRecipeRuntime = {
    async executePlan(plan) { return { ok: true, plan, logs: [], errors: [], changedFiles: [] }; },
    runGit(_cwd, args) {
      gitCalls.push([...args]);
      return { status: args[0] === "commit" ? 1 : 0, stdout: "", stderr: args[0] === "commit" ? "injected commit failure" : "" };
    },
  };
  const registry = new RecipeRegistry([
    new FakeRecipe("mise"), new FakeRecipe("agent-hooks", [], ["mise"]), new FakeRecipe("bmad", [], ["agent-hooks"]), new ProjectRecipe(runtime),
  ]);
  const result = await registry.initRecipe("project", ctx(fixture.dir), { plan: fixture.plan, mode: "create" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /injected commit failure/);
  assert.equal(gitCalls.filter((call) => call[0] === "init").length, 1, "ProjectRecipe owns Git initialization exactly once");
  rmSync(fixture.dir, { recursive: true, force: true });
}

{
  const fixture = projectFixture();
  let gitCalls = 0;
  const failingAudit = check("dependency.audit", "fail", false);
  const runtime: ProjectRecipeRuntime = {
    async executePlan(plan) { return { ok: true, plan, logs: [], errors: [], changedFiles: [] }; },
    runGit() { gitCalls++; return { status: 0, stdout: "", stderr: "" }; },
  };
  const registry = new RecipeRegistry([
    new FakeRecipe("mise", [failingAudit]), new FakeRecipe("agent-hooks", [], ["mise"]), new FakeRecipe("bmad", [], ["agent-hooks"]), new ProjectRecipe(runtime),
  ]);
  const result = await registry.initRecipe("project", ctx(fixture.dir), { plan: fixture.plan, mode: "create" });
  assert.equal(result.ok, false);
  assert.equal(gitCalls, 0, "Git must not run before a clean final audit");
  rmSync(fixture.dir, { recursive: true, force: true });
}

{
  const fixture = projectFixture();
  const runtime: ProjectRecipeRuntime = {
    async executePlan(plan) { return { ok: true, plan, logs: [], errors: [], changedFiles: [] }; },
    // A successful process status is insufficient: this fake deliberately
    // creates neither .git nor HEAD so the production postcondition must fail.
    runGit() { return { status: 0, stdout: "", stderr: "" }; },
  };
  const registry = new RecipeRegistry([
    new FakeRecipe("mise"), new FakeRecipe("agent-hooks", [], ["mise"]), new FakeRecipe("bmad", [], ["agent-hooks"]), new ProjectRecipe(runtime),
  ]);
  const result = await registry.initRecipe("project", ctx(fixture.dir), { plan: fixture.plan, mode: "create" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /git postcondition failed/, "Git success requires a real repository and HEAD");
  rmSync(fixture.dir, { recursive: true, force: true });
}

const cliSource = readFileSync(join(root, "src", "index.ts"), "utf8");
const mcpSource = readFileSync(join(root, "src", "mcp-server.ts"), "utf8");
const paritySource = readFileSync(join(root, "src", "parity", "index.ts"), "utf8");
const rulesSource = readFileSync(join(root, "src", "parity", "rules.ts"), "utf8");
for (const source of [cliSource, mcpSource]) {
  assert.match(source, /recipeRegistry\.initRecipe\(\s*["']project["']/, "CLI and MCP must dispatch through ProjectRecipe");
  assert.doesNotMatch(source, /executeProjectInitPlan\(/, "CLI and MCP must not duplicate project execution");
}
assert.doesNotMatch(`${cliSource}\n${mcpSource}\n${paritySource}\n${rulesSource}`, /PJANGLER_TEST_FAKE_COPIER/);
assert.match(paritySource, /recipeRegistry\.migrateRules/);
assert.match(paritySource, /recipeRegistry\.migrateAll/);
for (const retired of ["PARITY_CHECKS", "RECIPE_RULE_OWNERS", "OwnedLifecycleRecipe", "lifecycleInitializers"]) {
  assert.doesNotMatch(`${paritySource}\n${rulesSource}`, new RegExp(retired));
}
assert.match(readFileSync(join(root, "src", "recipes", "HermesAgentRecipe.ts"), "utf8"), /status === "failed" \|\| status === "cancelled"[\s\S]*break/);

console.log("PJAN-57 lifecycle registry/dispatch regressions: PASS");
