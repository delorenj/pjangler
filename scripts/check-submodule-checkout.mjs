#!/usr/bin/env node
// Gate: the templates/commonproject submodule is checked out.
//
// pjan-75-regressions and project-registry-regressions scaffold from the
// CommonProject template. In a clone made without --recurse-submodules the
// directory exists but is empty, and those suites fail deep inside with
// "missing the neutral .env.op template" -- which reads like a product bug.
// This gate names the real cause and the one command that fixes it, before
// any suite runs. Pure filesystem probe: no child process, no network.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PROBES = ["templates/commonproject/copier.yml"];
const missing = PROBES.filter((path) => !existsSync(resolve(root, path)));
if (missing.length) {
  process.stderr.write(
    `submodule-checkout: templates/commonproject is not checked out (missing ${missing.join(", ")}).\n` +
      "  The CommonProject-backed suites (pjan-75-regressions, project-registry-regressions) cannot pass without it.\n" +
      "  Run: git submodule update --init --recursive templates/commonproject\n",
  );
  process.exit(1);
}
process.stdout.write("submodule-checkout: templates/commonproject present\n");
