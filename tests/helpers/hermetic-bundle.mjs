import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

// The hermetic-wrapper build step, shared (PJAN-184). A wrapper bundles a .ts
// suite against src/ into a scratch dir outside the repo and runs it in a clean
// child environment. Two things decide whether that run counts toward `c8`:
//
//   1. The bundle must carry an inline source map. Without one, V8 reports the
//      scratch bundle itself, which is not a repo file, so every src/ line the
//      suite executed is lost. With one, c8 remaps it onto src/.
//   2. c8 must remap BEFORE it applies its path filter (`exclude-after-remap`
//      in .c8rc.json): the scratch bundle sits outside the repo root, and the
//      pre-remap filter drops it before the map is ever read.
//
// NODE_V8_COVERAGE needs no help: Node re-injects it into every child process
// even when spawnSync is handed an explicit env, so the wrappers' stripped env
// is not the leak. Both halves above are needed; either alone reports 0 files.
//
// The map is inline and the bundle lives in a throwaway scratch dir, so nothing
// ships or lands in the tree.
export async function buildHermeticSuite({ root, entry, output, external = [] }) {
  symlinkSync(join(root, "node_modules"), join(output, "..", "node_modules"));
  await build({
    entryPoints: [entry],
    bundle: true, packages: "external", platform: "node", format: "esm", outfile: output,
    sourcemap: "inline",
    define: { "import.meta.dirname": JSON.stringify(join(root, "tests")) },
    ...(external.length ? { external } : {}),
  });
}
