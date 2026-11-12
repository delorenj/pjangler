import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

// PJAN-166: a structural model of what BMB's setup does to an installed `_bmad/` tree.
//
// WHY A MODEL, WHEN THE REAL SCRIPTS EXIST: the real bmad-bmb-setup scripts ship in
// the bmb module, which the installer clones from GitHub, so they exist only inside a
// network-backed install. The hermetic suite (tests/pjan-166-config-authority-
// regressions.mjs) cannot run them. It runs this model instead, and the network
// contract (tests/pjan-166-bmb-setup-contract.mjs) is what keeps the model honest:
// it runs the REAL scripts on a real install and fails if bmadTreeShape() of the
// real result differs from bmadTreeShape() of this model applied to a copy of the
// same pre-setup tree. A model nobody compares with the thing it models is a
// fixture that encodes its author's assumption; this one is compared after EVERY
// real setup run of the contract (the first install and each repeat), because the
// repeat runs start from a tree the repair rebuilt, not from a fresh install.
//
// What it models (all VERIFIED against bmad-method 6.12.1 + bmb v2.2.2, see
// _bmad-output/implementation-artifacts/issue-evidence/PJAN-166-config-authority-trace.md):
//   merge-config.py     writes _bmad/config.yaml (core keys at the root + one
//                       section per module) and _bmad/config.user.yaml, and deletes
//                       the legacy _bmad/core/config.yaml and _bmad/bmb/config.yaml
//   merge-help-csv.py   writes _bmad/module-help.csv, deletes the legacy per-module CSVs
//   cleanup-legacy.py   `--also-remove _config` removes _bmad/bmb, _bmad/core and
//                       the whole of _bmad/_config
export function applyBmbSetupModel(repoRoot, { keepConfigDir = false } = {}) {
  const bmad = join(repoRoot, "_bmad");
  const existing = existsSync(join(bmad, "config.yaml")) ? YAML.parse(readFileSync(join(bmad, "config.yaml"), "utf8")) ?? {} : {};
  writeFileSync(join(bmad, "config.yaml"), YAML.stringify({
    ...existing,
    document_output_language: "English",
    output_folder: "_bmad-output",
    bmb: {
      name: "BMad Builder",
      description: "Standard Skill Compliant Factory for BMad Agents, Workflows and Modules",
      version: "1.0.0",
      default_selected: false,
      bmad_builder_output_folder: "{project-root}/skills",
      bmad_builder_reports: "{project-root}/skills/reports",
    },
  }));
  writeFileSync(join(bmad, "config.user.yaml"), YAML.stringify({ user_name: "BMad", communication_language: "English" }));
  writeFileSync(join(bmad, "module-help.csv"), "module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs\n");
  for (const dir of keepConfigDir ? ["bmb", "core"] : ["bmb", "core", "_config"]) {
    rmSync(join(bmad, dir), { recursive: true, force: true });
  }
}

/** Every `_bmad/` path the Contract A audit, BMB's setup or the config resolver consults. */
export const CONFIG_AUTHORITY_PATHS = Object.freeze([
  "config.toml",
  "config.user.toml",
  "config.yaml",
  "config.user.yaml",
  "module-help.csv",
  "scripts/resolve_config.py",
  "scripts/config_utils.py",
  "_config/manifest.yaml",
  "core/config.yaml",
  "bmb/config.yaml",
  "bmm/config.yaml",
  "cis/config.yaml",
]);

/** The subset the installer fixture (tests/helpers/pack-fixture.mjs) is expected to write like the real installer. */
export const FIXTURE_COMPARABLE_PATHS = Object.freeze([
  "config.toml",
  "scripts/resolve_config.py",
  "scripts/config_utils.py",
  "_config/manifest.yaml",
  "core/config.yaml",
  "bmb/config.yaml",
  "bmm/config.yaml",
  "cis/config.yaml",
]);

/** Which of those paths exist, and the top-level keys of the consolidated config.yaml (null when absent). */
export function bmadTreeShape(repoRoot, paths = CONFIG_AUTHORITY_PATHS) {
  const bmad = join(repoRoot, "_bmad");
  const consolidated = join(bmad, "config.yaml");
  return {
    present: paths.filter((path) => existsSync(join(bmad, path))),
    consolidatedKeys: existsSync(consolidated) ? Object.keys(YAML.parse(readFileSync(consolidated, "utf8")) ?? {}).sort() : null,
  };
}
