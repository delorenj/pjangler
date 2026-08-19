import type { NotebookModule } from "./module";
import { NOTEBOOK_RULE_IDS } from "./checks";

export interface NotebookMigrationPlanV1 {
  dry_run: boolean;
  selected_rules: string[];
  results: Array<{ id: string; status: "planned" | "applied" | "noop" | "blocked"; summary: string }>;
  changed_files: string[];
}

export async function migrateNotebook(module: NotebookModule, repo: string, input: { apply: boolean; live: boolean }): Promise<NotebookMigrationPlanV1> {
  const observed = await module.audit(repo, !input.live);
  const selectedSet = new Set(observed.data.rules
    .filter((rule) => rule.fixable && (rule.status === "fail" || rule.status === "warn"))
    .map((rule) => rule.id)
    .filter((id) => (NOTEBOOK_RULE_IDS as readonly string[]).includes(id)));
  const config = observed.config;
  const remoteRequired = config.policy.enabled && Boolean(config.base_url) && config.binding.state !== "disabled" && config.binding.state !== "linked";
  if (!input.live && remoteRequired) {
    selectedSet.add("notebook.remote-notebook");
    selectedSet.add("notebook.overview-note");
  }
  const selected = NOTEBOOK_RULE_IDS.filter((id) => selectedSet.has(id));
  if (!input.apply) return {
    dry_run: true,
    selected_rules: selected,
    results: selected.map((id) => ({
      id,
      status: "planned",
      summary: id === "notebook.capture-receipts"
        ? "Plan preservation-safe local cleanup"
        : id === "notebook.configuration"
          ? "Declare a planned authoritative Registry binding and canary-safe Manifest policy without remote work"
        : (id === "notebook.remote-notebook" || id === "notebook.overview-note") && !input.live
          ? "Remote repair requires pj notebook migrate --apply --live"
          : "Plan selected owned repair",
    })),
    changed_files: [],
  };
  const results: NotebookMigrationPlanV1["results"] = [];
  const changed: string[] = [];
  let installed = false;
  let provisioned = false;
  for (const id of selected) {
    if ((id === "notebook.remote-notebook" || id === "notebook.overview-note") && !input.live) {
      results.push({ id, status: "blocked", summary: "Remote repair requires pj notebook migrate --apply --live" });
      continue;
    }
    if (id === "notebook.configuration") {
      const files = await module.declareNotebook(repo);
      changed.push(...files);
      results.push({
        id,
        status: files.length ? "applied" : "noop",
        summary: files.length
          ? "Declared a planned Registry binding and Manifest policy with SessionStart and SessionEnd capture disabled"
          : "Authoritative Project Notebook declaration already matches",
      });
      continue;
    }
    if (id === "notebook.binding") {
      const files = module.repairBindingProjection(repo);
      changed.push(...files);
      results.push({ id, status: files.length ? "applied" : "noop", summary: files.length ? "Projected the authoritative Registry binding into .project.json" : "Registry and Manifest binding projection already match" });
      continue;
    }
    if (id === "notebook.skill-installed" || id === "notebook.hooks-projected") {
      if (!installed) {
        const files = module.installIntegration().changedFiles;
        changed.push(...files);
        installed = true;
        results.push({ id, status: files.length ? "applied" : "noop", summary: files.length ? "Installed the verified Project Notebook skill and projected canonical hooks" : "Verified Project Notebook skill and hook projection already match" });
      } else {
        results.push({ id, status: "noop", summary: "Verified Project Notebook skill and hook projection already repaired by the selected companion rule" });
      }
      continue;
    }
    if (id === "notebook.remote-notebook" || id === "notebook.overview-note") {
      if (!provisioned) {
        const created = await module.create(repo, true);
        changed.push(...created.changedFiles);
        provisioned = true;
        results.push({ id, status: created.changedFiles.length || created.data.created ? "applied" : "noop", summary: "Reconciled stable Notebook and Overview identities" });
      } else {
        results.push({ id, status: "noop", summary: "Stable Notebook and Overview were reconciled by the selected companion rule" });
      }
      continue;
    }
    if (id === "notebook.capture-receipts") {
      const recovered = module.recoverCaptureJournals(repo);
      const removed = module.pruneCaptureState(repo);
      changed.push(...removed, ...recovered);
      results.push({
        id,
        status: removed.length || recovered.length ? "applied" : "noop",
        summary: recovered.length
          ? `Finalized ${recovered.length} reconciled journal(s) only after proving succeeded-receipt logical and remote IDs; then expired only eligible state`
          : "Expired only eligible succeeded or unreferenced receiptless state",
      });
      continue;
    }
    results.push({ id, status: "blocked", summary: "Selected repair requires the canonical Project Notebook projector or explicit global configuration" });
  }

  const post = await module.audit(repo, !input.live);
  for (const result of results) {
    if (result.status !== "applied" && result.status !== "noop") continue;
    const rule = post.data.rules.find((item) => item.id === result.id);
    if (rule && (rule.status === "fail" || rule.status === "warn")) {
      result.status = "blocked";
      result.summary = `Postcondition failed: ${rule.summary}`;
    }
  }
  return { dry_run: false, selected_rules: selected, results, changed_files: [...new Set(changed)].sort() };
}
