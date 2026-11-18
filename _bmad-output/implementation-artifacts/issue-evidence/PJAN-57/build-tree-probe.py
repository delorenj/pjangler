#!/usr/bin/env python3
"""Reproduce the PJAN-57 scratch-only filesystem probe from the shipped suite.

Run at the repository root: python3 _bmad-output/implementation-artifacts/issue-evidence/PJAN-57/build-tree-probe.py
Then: node "${TMPDIR:?}/pjan57-tree-probe.mjs"
This instruments a copy in scratch; it does not edit the test suite.
"""
import os
from pathlib import Path

root = Path.cwd().resolve()
source = root / "tests/generated-project-lifecycle-regressions.mjs"
assert source.is_file(), "run from the repository root"
text = source.read_text()
tests = (root / "tests").as_posix()

def replace_once(old, new):
    global text
    assert text.count(old) == 1, f"suite shape changed: {old!r}"
    text = text.replace(old, new)

for name in ("hermetic-suite", "pack-fixture", "hermetic-env"):
    replace_once(f'"./helpers/{name}.mjs"', f'"{tests}/helpers/{name}.mjs"')
replace_once('const root = resolve(import.meta.dirname, "..");', f'const root = "{tests}/..";')
replace_once('  readdirSync,', '  readdirSync,\n  readlinkSync,')
replace_once('import { basename, join, resolve }', 'import { createHash } from "node:crypto";\nimport { basename, join, resolve }')
replace_once('const supportedRoots = [', '''const tree = (base) => {
  const out = {};
  const walk = (dir, rel = "") => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (item.name === ".git") continue;
      const key = rel ? `${rel}/${item.name}` : item.name;
      const path = join(dir, item.name);
      if (item.isDirectory()) { out[key + "/"] = "directory"; walk(path, key); }
      else if (item.isSymbolicLink()) out[key] = "symlink:" + readlinkSync(path);
      else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(base);
  return out;
};
const delta = (a,b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
const supportedRoots = [''')
replace_once('  const reinit = runPackedJson([', '  const beforeReinit = tree(target);\n  const reinit = runPackedJson([')
replace_once('  for (let pass = 0; pass < 2; pass++) {', '''  const afterReinit = tree(target);
  const reinitDelta = delta(beforeReinit, afterReinit);
  assert.deepEqual(reinitDelta, [], `repeat init filesystem delta: ${JSON.stringify(reinitDelta)}`);
  const migrationDeltas = [];
  for (let pass = 0; pass < 2; pass++) {
    const beforeMigration = tree(target);''')
replace_once('    assert.deepEqual(migrated.changedFiles, []);', '''    assert.deepEqual(migrated.changedFiles, []);
    const changed = delta(beforeMigration, tree(target));
    migrationDeltas.push(changed);
    assert.deepEqual(changed, [], `migration ${pass + 1} filesystem delta`);''')
replace_once('  console.log(`PJAN-57 packed generated-project lifecycle:', '''  console.log(JSON.stringify({treeEntriesIncludingHidden: Object.keys(beforeReinit).length, hiddenTopLevel: Object.keys(beforeReinit).filter(k => /^\\.[^/]+\\/?$/.test(k)), repeatInitDelta: reinitDelta, migrationDeltas, supportedRoots, unsupportedPresent: unsupportedRoots.filter(r => existsSync(join(target, r))), auditOk: audit.ok, installerFixture: BMAD_INSTALLER_FIXTURE_VERSION}));
  console.log(`PJAN-57 packed generated-project lifecycle:''')
output = Path(os.environ["TMPDIR"]) / "pjan57-tree-probe.mjs"
output.write_text(text)
print(output)
