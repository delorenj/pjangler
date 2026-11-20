// Snapshot the actual Commander tree without dispatching any actions.
// Run: node scripts/export-usage.mjs [--check]
// Exporter is dev-only; pj.usage.kdl is shipped for consumers without it.
import { build } from 'esbuild';
import { convertRoot, renderKDL } from '@usage-spec/commander';
import { Command } from 'commander';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Only defaults equal to the invocation directory are cwd-relative. Preserve
// literal numeric/string defaults and package version so real drift still fails.
function portableDefaults(node) {
  for (const arg of node.args ?? []) {
    if (arg.default?.length === 1 && arg.default[0] === process.cwd()) {
      arg.default = ['.'];
      arg.help = `${arg.help ?? ''} (default: current working directory)`.trim();
    }
  }
  for (const child of node.cmds ?? []) portableDefaults(child);
}

const dir = new URL('../dist/', import.meta.url).pathname;
const dispatch = 'await program.parseAsync();';
try {
  const entry = new URL('../src/index.ts', import.meta.url).pathname;
  const text = readFileSync(entry, 'utf8');
  assert.equal(text.split(dispatch).length, 2, 'CLI dispatch boundary changed');
  // Bundle project modules, but keep node_modules external to avoid side effects from vendored modules.
  const result = await build({ stdin: { contents: text.replace(dispatch, '') + '\nexport { program };', resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const out = join(dir, 'usage-parser.mjs');
  writeFileSync(out, result.outputFiles[0].text);
  const { program } = await import(pathToFileURL(out));
  program.name('pj');
  const spec = convertRoot(program);
  function restore(command, node) {
    for (const option of command.options.filter((opt) => ['help', 'version'].includes(opt.name()))) {
      const dummy = new Command('restore');
      dummy.option(option.flags.replace(/--(?:help|version)/g, '--restored'), option.description);
      const flag = convertRoot(dummy).flags[0];
      flag.long = option.long?.slice(2) ?? '';
      node.flags.push(flag);
    }
    for (const child of command.commands) {
      const target = node.cmds.find((item) => item.name === child.name());
      if (target) restore(child, target);
    }
  }
  restore(program, spec);
  portableDefaults(spec);
  const kdl = '// Static snapshot of src/index.ts Commander registrations; regenerate with node scripts/export-usage.mjs\n' + renderKDL(spec);
  const target = new URL('../pj.usage.kdl', import.meta.url);
  if (process.argv.includes('--check')) {
    assert.equal(readFileSync(target, 'utf8'), kdl, 'usage spec drift; regenerate');
    const mutated = text.replace('.command("init")', '.command("usage-drift-sentinel")');
    assert.notEqual(mutated, text, 'mutation target disappeared');
    const probe = await build({ stdin: { contents: mutated.replace(dispatch, '') + '\nexport { program };', resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    const probePath = join(dir, 'usage-parser-drift.mjs');
    try {
      writeFileSync(probePath, probe.outputFiles[0].text);
      const driftProgram = (await import(pathToFileURL(probePath))).program;
      assert.ok(convertRoot(driftProgram).cmds.some((cmd) => cmd.name === 'usage-drift-sentinel'));
      assert.ok(!kdl.includes('usage-drift-sentinel'), 'drift probe unexpectedly matches snapshot');
    } finally {
      rmSync(probePath, { force: true });
    }
  } else if (process.argv.includes('--stdout')) process.stdout.write(kdl);
  else writeFileSync(target, kdl);
  if (!process.argv.includes('--stdout')) console.log('pj usage snapshot matches parser');
} finally {
  rmSync(join(dir, 'usage-parser.mjs'), { force: true });
}
