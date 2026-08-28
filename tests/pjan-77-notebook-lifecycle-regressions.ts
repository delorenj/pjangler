import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProjectRegistry, loadProjectRegistry, resolvePjanglerRoot, saveProjectRegistry, type ProjectInitPlan } from "../src/project/index";
import { NotebookModule } from "../src/notebook/module";
import { migrateNotebook } from "../src/notebook/migration";
import { notebookDisplayName, resolveNotebookProject } from "../src/notebook/config";
import { DEFAULT_NOTEBOOK_LIMITS, NotebookError, type EffectiveNotebookConfigV1 } from "../src/notebook/types";
import { NotebookRecipe, projectNotebookDryRunProjection } from "../src/recipes/NotebookRecipe";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { RecipeRegistry } from "../src/recipes/registry";
import type { LifecycleRecipe, RecipeInitResult, RecipeMetadata } from "../src/recipes/types";
import { recipeRegistry } from "../src/recipes/catalog";

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-lifecycle-"));
try {
  assert.equal(resolvePjanglerRoot(), process.cwd(), "source and bundled audit resolve the package root without URL-encoded pathname leakage");
  const productionIds = recipeRegistry.list().map((item) => item.id);
  assert.equal(productionIds.filter((id) => id === "notebook").length, 1);
  assert.equal(productionIds.indexOf("notebook"), productionIds.indexOf("project") - 1, "NotebookRecipe is registered immediately before ProjectRecipe");
  assert.deepEqual(recipeRegistry.get("project")?.metadata.dependencies, ["mise", "agent-hooks", "bmad", "notebook"]);

  const yamlPath = join(workspace, "registry.yaml");
  writeFileSync(yamlPath, `# registry heading
schema_version: 1
x_template: &tpl
  commonproject:
    enabled: true
    primary_language: typescript
notebook:
  base_url: https://old.example.test # keep endpoint comment
  x_global: preserve-global
  auth:
    mode: environment
    env_var: OPEN_NOTEBOOK_PASSWORD # remove when mode becomes none
    x_auth: preserve-auth
  defaults:
    enabled: true
    session_capture_enabled: false # remove owned default
    documentation_globs: ["**/*.md"]
    x_defaults: preserve-defaults
  limits:
    schema_version: 1
    note_max_bytes: 1048576 # remove owned limit
    x_limits: preserve-limits
  summarizer:
    executable: /usr/bin/printf
    args: ["%s"] # remove owned argv
    x_summarizer: preserve-summarizer
projects:
  alpha: # keep alpha comment
    name: Alpha
    slug: alpha
    repo_path: ${join(workspace, "alpha")}
    description: old
    status: active
    source_artifacts: []
    template: *tpl
    ticket_provider: { type: plane, workspace: 33god, identifier: ALPHA, board_id: "", state: planned }
    agents: {}
    notebook:
      state: planned
      notebook_name: alpha
      x_binding: preserve-binding
    x_project:
      nested: preserve-project
    created_at: 2026-08-19T00:00:00.000Z
    updated_at: 2026-08-19T00:00:00.000Z
  beta:
    name: Beta
    slug: beta
    repo_path: ${join(workspace, "beta")}
    description: remove
    status: active
    source_artifacts: []
    template: *tpl
    ticket_provider: { type: plane, workspace: 33god, identifier: BETA, board_id: "", state: planned }
    agents: {}
    created_at: 2026-08-19T00:00:00.000Z
    updated_at: 2026-08-19T00:00:00.000Z
`, { mode: 0o640 });
  chmodSync(yamlPath, 0o640);
  const yamlRegistry = loadProjectRegistry(yamlPath);
  delete yamlRegistry.projects.beta;
  yamlRegistry.notebook = {
    ...(yamlRegistry.notebook ?? {}),
    base_url: "https://new.example.test",
    auth: { mode: "none", x_auth: "preserve-auth" } as never,
    defaults: { enabled: true, x_defaults: "preserve-defaults" } as never,
    limits: { schema_version: 1, x_limits: "preserve-limits" } as never,
    summarizer: { executable: "/usr/bin/printf", x_summarizer: "preserve-summarizer" } as never,
  };
  yamlRegistry.projects.alpha = { ...yamlRegistry.projects.alpha!, description: "updated", notebook: { ...yamlRegistry.projects.alpha!.notebook!, state: "linked", notebook_id: "nb-alpha", overview_note_id: "ov-alpha" } };
  saveProjectRegistry(yamlRegistry, yamlPath);
  const yamlText = readFileSync(yamlPath, "utf8");
  assert.match(yamlText, /# registry heading/u);
  assert.match(yamlText, /# keep endpoint comment/u);
  assert.match(yamlText, /# keep alpha comment/u);
  assert.match(yamlText, /&tpl/u);
  assert.match(yamlText, /\*tpl/u);
  assert.match(yamlText, /x_global: preserve-global/u);
  assert.match(yamlText, /x_auth: preserve-auth/u);
  assert.match(yamlText, /x_defaults: preserve-defaults/u);
  assert.match(yamlText, /x_limits: preserve-limits/u);
  assert.match(yamlText, /x_summarizer: preserve-summarizer/u);
  assert.doesNotMatch(yamlText, /env_var:/u, "auth mode changes remove stale owned credential variable names");
  assert.doesNotMatch(yamlText, /session_capture_enabled:/u, "removed global defaults do not survive the CST merge");
  assert.doesNotMatch(yamlText, /note_max_bytes:/u, "removed global limit overrides do not survive the CST merge");
  assert.doesNotMatch(yamlText, /^    args:/mu, "removed summarizer argv does not survive the CST merge");
  assert.match(yamlText, /x_binding: preserve-binding/u);
  assert.match(yamlText, /nested: preserve-project/u);
  assert.doesNotMatch(yamlText, /^  beta:/mu, "projects absent from authoritative memory are removed");
  assert.equal(statSync(yamlPath).mode & 0o777, 0o640, "Registry atomic replacement preserves the existing mode");
  assert.equal(loadProjectRegistry(yamlPath).notebook?.auth?.mode, "none", "nested owned-key removals round-trip through validation");
  const withoutGlobal = loadProjectRegistry(yamlPath);
  delete withoutGlobal.notebook;
  saveProjectRegistry(withoutGlobal, yamlPath);
  assert.doesNotMatch(readFileSync(yamlPath, "utf8"), /^notebook:/mu, "undefined owned global Notebook configuration is removed");
  const invalidGlobal = { ...withoutGlobal, notebook: { base_url: "https://192.0.2.10", auth: { mode: "environment", env_var: "ARBITRARY_SECRET" } } } as never;
  assert.throws(() => saveProjectRegistry(invalidGlobal, join(workspace, "invalid-global.yaml")), /numeric non-loopback|OPEN_NOTEBOOK_PASSWORD/u, "global Notebook owned fields are validated at Registry persistence");
  const credentialGlobal = { ...withoutGlobal, notebook: { base_url: "https://notebook.example.test", api_key: "fixture-value" } } as never;
  assert.throws(() => saveProjectRegistry(credentialGlobal, join(workspace, "credential-global.yaml")), /forbidden credential material/u, "credential-shaped global extension fields are rejected instead of preserved");
  const alpha = yamlRegistry.projects.alpha!;
  const duplicateOverview = emptyProjectRegistry();
  duplicateOverview.projects.alpha = alpha;
  duplicateOverview.projects.gamma = {
    ...alpha,
    name: "Gamma", slug: "gamma", repo_path: join(workspace, "gamma"),
    ticket_provider: { ...alpha.ticket_provider, identifier: "GAMMA" },
    notebook: { state: "linked", notebook_id: "nb-gamma", notebook_name: "Gamma", overview_note_id: alpha.notebook!.overview_note_id },
  };
  assert.throws(() => saveProjectRegistry(duplicateOverview, join(workspace, "duplicate-overview.yaml")), /Duplicate project overview_note_id/u);

  const legacyRepo = join(workspace, "legacy-repo");
  const legacyRegistryPath = join(workspace, "legacy-registry.yaml");
  mkdirSync(legacyRepo, { recursive: true });
  const legacyRegistry = emptyProjectRegistry();
  legacyRegistry.projects.legacy = {
    name: "Legacy Display", slug: "legacy", repo_path: legacyRepo, description: "legacy", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "LEGACY", board_id: "", state: "planned" },
    agents: {}, x_project: { preserve: true }, created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z",
  } as never;
  saveProjectRegistry(legacyRegistry, legacyRegistryPath);
  writeFileSync(join(legacyRepo, ".project.json"), `${JSON.stringify({
    project_name: "Legacy Display", project_description: "legacy", project_slug: "legacy", repo_path: legacyRepo,
    ticket_provider: legacyRegistry.projects.legacy.ticket_provider, agents: {}, x_manifest: { preserve: true },
    notebook: { display_name: "Operator Notebook", x_notebook: "preserve" },
  }, null, 2)}\n`);
  const pgMirrors: typeof legacyRegistry[] = [];
  const declarationModule = new NotebookModule({
    registryPath: legacyRegistryPath,
    stateRoot: join(workspace, "legacy-state"),
    env: { HOME: join(workspace, "legacy-home") },
    registryStore: { async save(registry) { pgMirrors.push(structuredClone(registry)); } },
  });
  const beforeDeclaration = await declarationModule.audit(legacyRepo, true);
  const configurationBefore = beforeDeclaration.data.rules.find((rule) => rule.id === "notebook.configuration");
  assert.equal(configurationBefore?.status, "warn");
  assert.equal(configurationBefore?.fixable, true, "a registered legacy repository gets an actionable declaration migration");
  assert.equal(beforeDeclaration.data.rules.filter((rule) => rule.id !== "notebook.configuration").every((rule) => rule.status === "skip"), true, "undeclared repositories do not fabricate downstream Notebook drift");
  const declarationDryRun = await migrateNotebook(declarationModule, legacyRepo, { apply: false, live: false });
  assert.deepEqual(declarationDryRun.selected_rules, ["notebook.configuration"]);
  assert.equal(declarationDryRun.results[0]?.status, "planned");
  const appliedDeclaration = await migrateNotebook(declarationModule, legacyRepo, { apply: true, live: false });
  assert.equal(appliedDeclaration.results[0]?.status, "applied");
  assert.equal(pgMirrors.length, 1, "the full authoritative Registry is mirrored after local YAML durability");
  assert.equal(pgMirrors[0]?.projects.legacy?.notebook?.state, "planned");
  const declaredManifest = JSON.parse(readFileSync(join(legacyRepo, ".project.json"), "utf8")) as Record<string, any>;
  assert.equal(declaredManifest.x_manifest.preserve, true);
  assert.equal(declaredManifest.notebook.x_notebook, "preserve");
  assert.equal(declaredManifest.notebook.display_name, "Operator Notebook", "Manifest display-name override round-trips through binding projection");
  assert.deepEqual(declaredManifest.notebook.policy, { enabled: true, session_start_enabled: false, session_capture_enabled: false }, "declaration is canary-safe and never enables session hooks");
  const declaredResolved = resolveNotebookProject(legacyRepo, legacyRegistryPath);
  assert.equal(notebookDisplayName(declaredResolved), "Operator Notebook", "Manifest display name overrides the Registry project name");
  const manifestBytes = readFileSync(join(legacyRepo, ".project.json"));
  const registryBytes = readFileSync(legacyRegistryPath);
  const secondDeclaration = await migrateNotebook(declarationModule, legacyRepo, { apply: false, live: false });
  assert.equal(secondDeclaration.selected_rules.includes("notebook.configuration"), false);
  assert.deepEqual(readFileSync(join(legacyRepo, ".project.json")), manifestBytes, "second migration is byte-idempotent for the Manifest");
  assert.deepEqual(readFileSync(legacyRegistryPath), registryBytes, "second migration is byte-idempotent for the Registry");
  assert.equal(pgMirrors.length, 1, "idempotent second migration plan performs no redundant PG declaration write");

  const failedPgRepo = join(workspace, "failed-pg-repo");
  const failedPgRegistryPath = join(workspace, "failed-pg-registry.yaml");
  mkdirSync(failedPgRepo, { recursive: true });
  const failedPgRegistry = emptyProjectRegistry();
  failedPgRegistry.projects.failed = { ...legacyRegistry.projects.legacy, slug: "failed", name: "Failed PG", repo_path: failedPgRepo, notebook: undefined } as never;
  saveProjectRegistry(failedPgRegistry, failedPgRegistryPath);
  writeFileSync(join(failedPgRepo, ".project.json"), `${JSON.stringify({ project_name: "Failed PG", project_description: "", project_slug: "failed", repo_path: failedPgRepo, ticket_provider: failedPgRegistry.projects.failed.ticket_provider, agents: {} }, null, 2)}\n`);
  const failedPgModule = new NotebookModule({ registryPath: failedPgRegistryPath, stateRoot: join(workspace, "failed-pg-state"), env: { HOME: join(workspace, "failed-pg-home") }, registryStore: { async save() { throw new Error("injected PG outage"); } } });
  await assert.rejects(() => migrateNotebook(failedPgModule, failedPgRepo, { apply: true, live: false }), (error: unknown) => error instanceof NotebookError && error.code === "SERVICE_UNAVAILABLE");
  assert.equal(loadProjectRegistry(failedPgRegistryPath).projects.failed?.notebook?.state, "planned", "YAML authority remains durably declared when the PG mirror fails");
  assert.equal((JSON.parse(readFileSync(join(failedPgRepo, ".project.json"), "utf8")) as any).notebook.policy.session_capture_enabled, false);

  const unsafeManifestRepo = join(workspace, "unsafe-manifest-repo");
  const unsafeManifestRegistryPath = join(workspace, "unsafe-manifest-registry.yaml");
  mkdirSync(unsafeManifestRepo, { recursive: true });
  const unsafeManifestRegistry = emptyProjectRegistry();
  unsafeManifestRegistry.projects.unsafe = { ...legacyRegistry.projects.legacy, slug: "unsafe", name: "Unsafe", repo_path: unsafeManifestRepo, notebook: { state: "planned", notebook_name: "Unsafe" } } as never;
  saveProjectRegistry(unsafeManifestRegistry, unsafeManifestRegistryPath);
  const unsafeManifestBase = { project_name: "Unsafe", project_description: "", project_slug: "unsafe", repo_path: unsafeManifestRepo, ticket_provider: unsafeManifestRegistry.projects.unsafe.ticket_provider, agents: {} };
  writeFileSync(join(unsafeManifestRepo, ".project.json"), `${JSON.stringify({ ...unsafeManifestBase, notebook: { binding: unsafeManifestRegistry.projects.unsafe.notebook, base_url: "https://forbidden.example.test" } }, null, 2)}\n`);
  assert.throws(() => resolveNotebookProject(unsafeManifestRepo, unsafeManifestRegistryPath), /not an allowed policy or binding projection field/u, "Manifest cannot override the service endpoint");
  const credentialValue = ["fixture", "credential", "value"].join("-");
  writeFileSync(join(unsafeManifestRepo, ".project.json"), `${JSON.stringify({ ...unsafeManifestBase, notebook: { binding: unsafeManifestRegistry.projects.unsafe.notebook, policy: { enabled: true }, password: credentialValue } }, null, 2)}\n`);
  assert.throws(() => resolveNotebookProject(unsafeManifestRepo, unsafeManifestRegistryPath), (error: unknown) => error instanceof NotebookError && /forbidden credential material/u.test(error.message) && !error.message.includes(credentialValue));

  class EmptyRecipe implements LifecycleRecipe {
    readonly checks = [];
    readonly metadata: RecipeMetadata;
    constructor(id: string, dependencies: string[] = []) { this.metadata = { id, name: id, description: id, dependencies, commands: [], publicRuleIds: [] }; }
    async init(): Promise<RecipeInitResult> { return { recipeId: this.metadata.id, ok: true, dryRun: false, changedFiles: [], logs: [], errors: [], phases: [] }; }
    audit() { return []; }
    migrate() { return []; }
  }

  function effective(repo: string, state: "planned" | "linked" = "planned"): EffectiveNotebookConfigV1 {
    return {
      schema_version: 1, project_slug: "alpha", repo_path: repo, base_url: "http://127.0.0.1:8502", auth: { mode: "none" },
      policy: { enabled: true, session_start_enabled: true, session_capture_enabled: true, overview_max_chars: 4_000, documentation_globs: ["**/*.md"] },
      limits: { ...DEFAULT_NOTEBOOK_LIMITS },
      binding: state === "linked" ? { state, notebook_id: "nb-alpha", overview_note_id: "ov-alpha", notebook_name: "Alpha" } : { state, notebook_name: "Alpha" },
      configuration_provenance: {},
    };
  }

  function plan(repo: string): ProjectInitPlan {
    const project = {
      name: "Alpha", slug: "alpha", repo_path: repo, description: "transaction", status: "active", source_artifacts: [],
      template: { commonproject: { enabled: true, primary_language: "typescript" } },
      ticket_provider: { type: "plane", workspace: "33god", identifier: "ALPHA", identifier_source: "provider", identifier_fetched_at: "2026-08-28T00:00:00.000Z", board_id: "board", board_confirmed_at: "2026-08-28T00:00:00.000Z", state: "linked" }, agents: {},
      notebook: { state: "planned", notebook_name: "Alpha" }, created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z",
    } as const;
    const manifest = {
      project_name: "Alpha", project_description: "transaction", project_slug: "alpha", repo_path: repo,
      ticket_provider: project.ticket_provider, agents: {}, notebook: { binding: project.notebook },
    };
    return {
      ok: true, apply: true, dryRun: false, live: true, registryPath: join(repo, "registry.yaml"), project: project as never, manifest: manifest as never,
      actions: [
        { kind: "project.write-manifest", path: join(repo, ".project.json"), manifest: manifest as never },
        { kind: "ticket-provider.create-or-link", enabled: true, live: true, provider: "plane", workspace: "33god", identifier: "ALPHA", repoPath: repo, boardName: "Alpha", description: "transaction", boardId: "board", state: "linked" },
        { kind: "registry.upsert", registryPath: join(repo, "registry.yaml"), slug: "alpha", project: project as never },
      ],
    };
  }

  async function transaction(failNotebook: boolean, failRegistry = false, failAfterNotebook = false) {
    const repo = join(workspace, `${failNotebook ? "failed-notebook" : failRegistry ? "failed-registry" : failAfterNotebook ? "failed-tail" : "successful"}-repo`);
    mkdirSync(repo, { recursive: true });
    const events: string[] = [];
    let manifestWrites = 0;
    const runtime: ProjectRecipeRuntime = {
      async executePlan(p) {
        const action = p.actions[0];
        if (p.actions.every((item) => item.kind === "registry.upsert")) {
          events.push("registry-finalizer");
          if (failRegistry) return { ok: false, plan: p, logs: [], errors: ["injected registry finalizer failure"], changedFiles: [] };
        }
        else if (p.actions.every((item) => item.kind === "ticket-provider.create-or-link")) events.push("ticket-provider");
        else if (p.actions.every((item) => item.kind === "project.write-manifest")) {
          events.push(manifestWrites++ === 0 ? "manifest-initial" : "manifest-linked-projection");
          writeFileSync((action as Extract<typeof action, { kind: "project.write-manifest" }>).path, `${JSON.stringify((action as Extract<typeof action, { kind: "project.write-manifest" }>).manifest, null, 2)}\n`);
        }
        return { ok: true, plan: p, logs: [], errors: [], changedFiles: [] };
      },
      preflightBmad() { return { ok: true }; },
      runGit() { return { status: 0, stdout: "", stderr: "" }; },
    };
    const notebook = new NotebookRecipe(new NotebookModule({ registryPath: join(repo, "registry.yaml"), stateRoot: join(repo, ".state"), env: { HOME: join(repo, ".home") } }));
    Object.defineProperty(notebook, "checks", { value: [] });
    Object.defineProperty(notebook, "metadata", { value: { ...notebook.metadata, publicRuleIds: [] } });
    (notebook as unknown as { init: NotebookRecipe["init"] }).init = async (_ctx, input) => ({
      recipeId: "notebook", ok: true, dryRun: false, changedFiles: [], logs: [], errors: [], phases: [],
      notebookPlan: { schema_version: 1, project_slug: "alpha", repo_path: repo, mode: input.mode, config: effective(repo), remote_effect: "reconcile", reason: "fixture" },
    });
    notebook.applyLocal = async () => { events.push("notebook-local"); return { recipeId: "notebook", ok: true, dryRun: false, changedFiles: [], logs: [], errors: [], phases: [] }; };
    notebook.applyExternal = async (p) => {
      events.push("notebook-external");
      if (failNotebook) throw new Error("injected notebook candidate failure");
      const binding = effective(repo, "linked").binding;
      p.project.notebook = binding;
      p.manifest.notebook = { ...(p.manifest.notebook ?? {}), binding };
      for (const action of p.actions) {
        if (action.kind === "project.write-manifest") action.manifest = p.manifest;
        if (action.kind === "registry.upsert") action.project = p.project;
      }
      return { changedFiles: [], data: { created: true, adopted: false, notebook_id: "nb-alpha", overview_note_id: "ov-alpha", journals: [{ operation_id: "journal-fixture" }] as never } };
    };
    notebook.commitExternal = () => { events.push("journal-commit"); };
    notebook.refreshPlan = (_p, prior) => Object.freeze({ ...prior, config: effective(repo, "linked") });
    notebook.observeExternal = async () => {
      events.push("notebook-observe-healthy");
      if (failAfterNotebook) throw new Error("injected post-notebook tail failure");
      return { schema_version: 1, fetched_at: new Date().toISOString(), project_slug: "alpha", binding_used: effective(repo, "linked").binding, remote_check: "pass", health: "healthy", auth_mode: "none", base_url_configured: true, notebook_check: { status: "pass", drift: [] }, notebook: { id: "nb-alpha", name: "Alpha", description: "pjangler.project.v1:alpha" }, scoped_notes: [], overview: { present: true, member: true, envelope_owned: true, drift: [] }, error: null, skill_installed: true, hooks_projected: true };
    };
    const project = new ProjectRecipe(runtime);
    Object.defineProperty(project, "checks", { value: [] });
    Object.defineProperty(project, "metadata", { value: { ...project.metadata, publicRuleIds: [] } });
    const registry = new RecipeRegistry([new EmptyRecipe("mise"), new EmptyRecipe("agent-hooks", ["mise"]), new EmptyRecipe("bmad", ["agent-hooks"]), notebook, project]);
    const p = plan(repo);
    const result = await registry.initRecipe("project", { targetDir: repo, repoRoot: repo, pjanglerRoot: workspace, homeDir: join(repo, ".home"), dryRun: false, force: false, live: true }, { plan: p, mode: "sync" });
    return { events, result, plan: p };
  }

  const success = await transaction(false);
  assert.equal(success.result.ok, true, JSON.stringify(success.result.errors));
  assert.equal(success.plan.project.notebook?.state, "linked");
  assert.deepEqual(success.events, ["manifest-initial", "notebook-local", "ticket-provider", "notebook-external", "manifest-linked-projection", "notebook-observe-healthy", "registry-finalizer", "journal-commit"]);
  assert.ok(success.events.indexOf("registry-finalizer") < success.events.indexOf("journal-commit"), "remote journals commit only after Registry ownership durability");

  const failed = await transaction(true);
  assert.equal(failed.result.ok, false);
  assert.equal(failed.plan.project.notebook?.state, "planned", "failed candidate persists truthful planned recovery");
  assert.equal(failed.events.at(-1), "registry-finalizer", "Registry finalizer still runs after an external Notebook failure");
  assert.equal(failed.events.includes("notebook-observe-healthy"), false);
  assert.equal(failed.events.includes("journal-commit"), false);

  const failedRegistry = await transaction(false, true);
  assert.equal(failedRegistry.result.ok, false);
  assert.equal(failedRegistry.events.includes("journal-commit"), false, "Registry finalizer failure leaves reconciled journals recoverable and uncommitted");
  const failedTail = await transaction(false, false, true);
  assert.equal(failedTail.result.ok, false);
  assert.equal(failedTail.events.at(-1), "registry-finalizer", "a post-notebook tail/candidate failure still persists truthful Registry recovery");
  assert.equal(failedTail.events.includes("journal-commit"), false, "a later external-tail failure never commits Notebook journals before the failed transaction is durable");

  console.log("pjan-77 notebook lifecycle regressions: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
