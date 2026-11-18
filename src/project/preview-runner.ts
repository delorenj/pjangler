import { readFileSync } from "node:fs";
import { recipeRegistry } from "../recipes/catalog";
import { lifecycleContext } from "../parity/index";
import type { ProjectInitPlan } from "./index";
import type { ProjectRecipeResult } from "../recipes/ProjectRecipe";

async function main(): Promise<void> {
  const { plan, mode, selectedRuleIds } = JSON.parse(readFileSync(0, "utf8")) as {
    plan: ProjectInitPlan; mode: "create" | "sync"; selectedRuleIds: string[];
  };
  // Recipe output is intentionally not allowed to contaminate the JSON protocol.
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const result = await recipeRegistry.initRecipe("project", lifecycleContext(plan.project.repo_path, false, false, {
      live: false, registryPath: plan.registryPath, quiet: true,
    }), { plan, mode, selectedRuleIds, quiet: true }) as ProjectRecipeResult;
    process.stdout.write(JSON.stringify({ ok: result.ok, errors: result.errors }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
