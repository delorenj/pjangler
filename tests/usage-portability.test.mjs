import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const exporter = new URL('../scripts/export-usage.mjs', import.meta.url).pathname;
test('parser snapshot is identical from repo and unrelated cwd, with live version and portable defaults', () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pj-usage-cwd-'));
  try {
    const render = (cwd) => execFileSync(process.execPath, [exporter, '--stdout'], { cwd, encoding: 'utf8' });
    const kdl = render(root);
    assert.equal(render(scratch), kdl);
    assert.equal(readFileSync(new URL('../pj.usage.kdl', import.meta.url), 'utf8'), kdl);
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
    assert.ok(kdl.includes(`version "${version}"`));
    assert.equal((kdl.match(/default=\.(?:\n|$)/g) || []).length, 16);
    assert.doesNotMatch(kdl, /default="\/.*(?:worktrees|home)/);
    assert.match(kdl, /default="50"/);
    execFileSync('mise', ['exec', '--', 'usage', 'lint', '-q', '-'], { input: kdl });
    const spec = JSON.parse(execFileSync('mise', ['exec', '--', 'usage', 'generate', 'json', '-f', '-'], { input: kdl, encoding: 'utf8' }));
    assert.equal(spec.bin, 'pj');
    assert.equal(spec.cmd.subcommands.notebook.subcommands.status.args[0].default[0], '.');
    execFileSync(process.execPath, [exporter, '--check'], { cwd: scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
