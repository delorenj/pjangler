import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readActivationReceipt, writeActivationReceipt, withLock } from '@delorenj/skillex';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pjan-165-'));
const database = `pjan165_${process.pid}_${Date.now()}`;
const home = join(temp, 'home');
mkdirSync(join(home, '.local/bin'), { recursive: true });
const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, '.local/state'), GIT_OPTIONAL_LOCKS: '0', PGHOST: process.env.PGHOST ?? '/var/run/postgresql', PGDATABASE: database, PJ_REGISTRY_PORT: '0' };
const admin = new pg.Client({ host: env.PGHOST, database: process.env.PJ_TEST_ADMIN_DATABASE ?? 'postgres' });
let db, service, url;
const evidence = { temporary_root: temp, database, assertions: [] };
function run(command, args, cwd, options = {}) {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30000, ...options });
  assert.ifError(r.error);
  return r;
}
function git(dir, ...args) {
  const r = run('git', args, dir);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function repo(name, manifest = { project_id: name, agents: {} }) {
  const dir = join(temp, name); mkdirSync(dir);
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'PJAN-165 Test'); git(dir, 'config', 'user.email', 'pjan-165@localhost.invalid');
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
  writeFileSync(join(dir, 'tracked'), 'base\n');
  if (manifest) writeFileSync(join(dir, '.project.json'), `${JSON.stringify({ ...manifest, repo_path: dir }, null, 2)}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'PJAN-165 initialize disposable repository');
  return dir;
}
function bare(source, name) { const target = join(temp, `${name}.git`); git(temp, 'clone', '--bare', source, target); return target; }
function cli(parent, source, ...args) {
  const r = run(process.execPath, [join(root, 'dist/index.js'), 'import', source, '--registry', url, '--bindings-home', home, '--json', ...args], parent);
  let data; try { data = JSON.parse(r.stdout); } catch { throw new Error(`Invalid CLI JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return { ...r, data };
}
async function request(path, data) {
  const r = await fetch(`${url}${path}`, { method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'content-type': 'application/json' } }) });
  const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result;
}
const bytes = path => readFileSync(path).toString('base64');
function tree(dir) {
  const rows = [];
  function walk(at, rel = '') {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name), key = join(rel, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) rows.push([key, 'link', readlinkSync(path)]);
      else if (stat.isDirectory()) { rows.push([key, 'dir', stat.mode]); walk(path, key); }
      else rows.push([key, stat.mode, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  }
  walk(dir); return rows;
}
function passed(name, details = {}) { evidence.assertions.push({ name, ...details }); console.log(`PASS ${name}`); }
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  db = new pg.Client({ host: env.PGHOST, database }); await db.connect();
  let output = '';
  service = spawn(process.execPath, [join(root, 'dist/project-registry-service.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', c => { output += c; }); service.stderr.on('data', c => { output += c; });
  for (let i = 0; i < 100; i++) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    if (service.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  assert.ok(url, output);
  const parent = repo('parent');
  const source = repo('checkout', { project_id: 'stable-id', project_name: 'Original name', agents: {}, ticket_provider: { type: 'plane', board_id: 'board-kept', identifier: 'PX', workspace: '33god' }, memory: { bank: 'pilot' }, extensions: { profile_name: 'pilot-original' } });
  const upstream = bare(source, 'upstream'); git(source, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(source, 'bin')); writeFileSync(join(source, 'bin/pilot.js'), '#!/usr/bin/env node\nconsole.log("PJAN-165 executable usable");\n'); chmodSync(join(source, 'bin/pilot.js'), 0o755);
  git(source, 'add', 'bin'); git(source, 'commit', '-qm', 'PJAN-165 add executable');
  writeFileSync(join(source, 'tracked'), 'staged\n'); git(source, 'add', 'tracked'); writeFileSync(join(source, 'tracked'), 'unstaged\n');
  writeFileSync(join(source, 'untracked'), Buffer.from([0, 255, 12, 13])); mkdirSync(join(source, 'ignored')); writeFileSync(join(source, 'ignored/payload'), 'ignored payload\n');
  const stagedManifest = JSON.parse(readFileSync(join(source, '.project.json'))); stagedManifest.extensions.staged_value = 'keep staged';
  writeFileSync(join(source, '.project.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`); git(source, 'add', '.project.json');
  writeFileSync(join(source, '.project.json'), `${JSON.stringify({ ...stagedManifest, user_change: 'keep unstaged' }, null, 2)}\n`);
  mkdirSync(join(source, '.agents/skills/copied'), { recursive: true }); writeFileSync(join(source, '.agents/skills/copied/SKILL.md'), 'baseline copied skill must survive');
  const outside = join(temp, 'shared'); mkdirSync(outside); writeFileSync(join(outside, 'payload'), 'relative link payload');
  symlinkSync('../shared/payload', join(source, 'relative-external'));
  for (const name of ['px', 'pilot', 'px-supervised']) symlinkSync(join(source, 'bin/pilot.js'), join(home, '.local/bin', name));
  writeFileSync(join(parent, 'tracked'), 'parent staged\n'); git(parent, 'add', 'tracked');
  const parentStaged = git(parent, 'diff', '--cached', '--', 'tracked');
  const before = { head: git(source, 'rev-parse', 'HEAD'), index: bytes(join(source, '.git/index')), stagedManifest: git(source, 'show', ':.project.json'), status: git(source, 'status', '--porcelain=v1', '--untracked-files=all'), origin: git(source, 'remote', 'get-url', 'origin'), untracked: bytes(join(source, 'untracked')), ignored: bytes(join(source, 'ignored/payload')), manifest: JSON.parse(readFileSync(join(source, '.project.json'))) };
  await request('/v1/index', { manifest_path: join(source, '.project.json') });
  const snapshot = tree(temp), rows = (await db.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows;
  const preview = cli(parent, source, '--dry-run'); assert.equal(preview.status, 0, JSON.stringify(preview.data)); assert.equal(preview.data.status, 'planned');
  assert.deepEqual(tree(temp), snapshot); assert.deepEqual((await db.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows, rows);
  passed('AC4 dry-run filesystem and DB byte invariance', { plan: preview.data.plan });
  const adopted = cli(parent, source); assert.equal(adopted.status, 0, JSON.stringify(adopted.data));
  const target = join(parent, 'checkout'); assert.equal(existsSync(source), false);
  assert.equal(git(target, 'rev-parse', 'HEAD'), before.head); assert.equal(bytes(join(target, '.git/index')), before.index);
  const withoutManifest = status => status.split('\n').filter(line => !line.endsWith(' .project.json')).join('\n');
  assert.equal(withoutManifest(git(target, 'status', '--porcelain=v1', '--untracked-files=all')), withoutManifest(before.status));
  assert.equal(git(target, 'show', ':.project.json'), before.stagedManifest, 'canonical path repair leaves the child staging untouched');
  assert.equal(git(target, 'remote', 'get-url', 'origin'), before.origin); assert.equal(bytes(join(target, 'untracked')), before.untracked); assert.equal(bytes(join(target, 'ignored/payload')), before.ignored);
  assert.equal(git(parent, 'diff', '--cached', '--', 'tracked'), parentStaged);
  assert.equal(git(parent, 'ls-files', '--stage', '--', 'checkout'), `160000 ${before.head} 0\tcheckout`);
  assert.equal(git(parent, 'config', '--file', '.gitmodules', '--get', 'submodule.checkout.url'), upstream);
  assert.match(git(parent, 'submodule', 'status', '--', 'checkout'), new RegExp(before.head));
  passed('AC1 dirty/staged/untracked/ignored preservation and parent enrollment', { before, after: { head: git(target, 'rev-parse', 'HEAD'), status: git(target, 'status', '--porcelain=v1', '--untracked-files=all'), origin: git(target, 'remote', 'get-url', 'origin'), gitlink: git(parent, 'ls-files', '--stage', '--', 'checkout') } });
  const manifest = JSON.parse(readFileSync(join(target, '.project.json'))); assert.deepEqual({ ...manifest, repo_path: source }, before.manifest);
  assert.equal(readFileSync(join(target, 'relative-external'), 'utf8'), 'relative link payload');
  assert.equal(readFileSync(join(target, '.agents/skills/copied/SKILL.md'), 'utf8'), 'baseline copied skill must survive');
  for (const name of ['px', 'pilot', 'px-supervised']) {
    assert.equal(readlinkSync(join(home, '.local/bin', name)), join(target, 'bin/pilot.js'));
    const runExe = run(join(home, '.local/bin', name), [], parent); assert.equal(runExe.status, 0); assert.match(runExe.stdout, /executable usable/);
  }
  const info = run(process.execPath, [join(root, 'dist/index.js'), 'info', 'stable-id', '--registry', url, '--json'], parent); assert.equal(info.status, 0, info.stderr); assert.ok(info.stdout.includes(target));
  passed('AC3 supported identity, registry and executable bindings (employee/service/skill relocation excluded)', { manifest, info: JSON.parse(info.stdout) });
  const rerunState = tree(temp), rerunRows = (await db.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows;
  const rerun = cli(parent, source); assert.equal(rerun.status, 0, JSON.stringify(rerun.data)); assert.equal(rerun.data.status, 'unchanged');
  assert.deepEqual(tree(temp), rerunState); assert.deepEqual((await db.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows, rerunRows);
  passed('AC4 local rerun convergence');
  const remoteSeed = repo('remote-seed', { project_id: 'remote-id', agents: {} }); const remoteUpstream = bare(remoteSeed, 'remote-upstream');
  const remoteParent = repo('remote-parent'); const remote = cli(remoteParent, remoteUpstream, '--name', 'remote'); assert.equal(remote.status, 0, JSON.stringify(remote.data));
  const remoteTarget = join(remoteParent, 'remote'); assert.equal(git(remoteTarget, 'remote', 'get-url', 'origin'), remoteUpstream);
  assert.equal(git(remoteParent, 'ls-files', '--stage', '--', 'remote').split(' ')[0], '160000');
  assert.equal(cli(remoteParent, remoteUpstream, '--name', 'remote').data.status, 'unchanged');
  passed('AC2 remote import and convergence using actual local bare remote', { origin: remoteUpstream });
  const shorthand = cli(repo('shorthand-parent'), 'github.com/owner/repo', '--dry-run'); assert.equal(shorthand.status, 0); assert.equal(shorthand.data.plan.url, 'https://github.com/owner/repo.git');
  passed('AC2 GitHub shorthand parsing only; no GitHub network execution claimed');
  const failParent = repo('failure-parent'); const failSource = repo('failure-source'); git(failSource, 'remote', 'add', 'origin', upstream);
  writeFileSync(join(failSource, 'run'), '#!/bin/sh\nprintf "rollback executable\\n"\n'); chmodSync(join(failSource, 'run'), 0o755);
  symlinkSync(join(failSource, 'run'), join(home, '.local/bin/rollback-exe'));
  symlinkSync('../shared/payload', join(failSource, 'external-link'));
  const failBefore = tree(failParent), failSourceBefore = tree(failSource);
  await db.query(`CREATE FUNCTION pjangler_index.reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'induced import enrollment failure'; END $$; CREATE TRIGGER reject_import BEFORE INSERT ON pjangler_index.projects FOR EACH ROW EXECUTE FUNCTION pjangler_index.reject_import()`);
  const failure = cli(failParent, failSource); assert.equal(failure.status, 1); assert.equal(failure.data.status, 'rolled_back', JSON.stringify(failure.data));
  await db.query('DROP TRIGGER reject_import ON pjangler_index.projects');
  const transactionMetadata = rows => rows.filter(r => !r[0].startsWith('.git/pjangler-imports') && !r[0].startsWith('.git/objects'));
  assert.deepEqual(tree(failSource), failSourceBefore); assert.deepEqual(transactionMetadata(tree(failParent)), transactionMetadata(failBefore));
  assert.equal(readlinkSync(join(home, '.local/bin/rollback-exe')), join(failSource, 'run'));
  assert.equal(run(join(home, '.local/bin/rollback-exe'), [], failParent).status, 0);
  assert.ok(existsSync(failure.data.recovery.receipt));
  passed('AC4 induced mid-operation registry failure rolls back source and parent', { result: failure.data });
  assert.equal(cli(failParent, failSource).status, 0);
  passed('AC4 retry after completed rollback');
  const indexedParent = repo('indexed-failure-parent'); const indexedSource = repo('indexed-failure-source'); git(indexedSource, 'remote', 'add', 'origin', upstream);
  await request('/v1/index', { manifest_path: join(indexedSource, '.project.json') });
  const indexedBefore = tree(indexedSource), recordedBefore = (await db.query("SELECT * FROM pjangler_index.projects WHERE project_id='indexed-failure-source'")).rows;
  await db.query(`CREATE TRIGGER reject_import_update BEFORE UPDATE ON pjangler_index.projects FOR EACH ROW EXECUTE FUNCTION pjangler_index.reject_import()`);
  const indexedFailure = cli(indexedParent, indexedSource); assert.equal(indexedFailure.status, 1); assert.equal(indexedFailure.data.status, 'rolled_back', JSON.stringify(indexedFailure.data));
  await db.query('DROP TRIGGER reject_import_update ON pjangler_index.projects');
  assert.deepEqual(tree(indexedSource), indexedBefore); assert.deepEqual((await db.query("SELECT * FROM pjangler_index.projects WHERE project_id='indexed-failure-source'")).rows, recordedBefore);
  passed('AC4 indexed relocation failure retains original registry row without another failing write', { result: indexedFailure.data });
  const collisionParent = repo('collision-parent'); const collisionSource = repo('collision-source'); git(collisionSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(collisionParent, 'collision-source')); writeFileSync(join(collisionParent, 'collision-source/keep'), 'collision content');
  const collisionBefore = tree(temp); const collision = cli(collisionParent, collisionSource); assert.equal(collision.status, 1); assert.match(collision.data.error, /collision/i); assert.deepEqual(tree(temp), collisionBefore);
  const worktree = join(temp, 'linked'); git(collisionSource, 'worktree', 'add', '-q', '-b', 'linked-test', worktree);
  const wtBefore = tree(temp); const wt = cli(collisionParent, worktree); assert.equal(wt.status, 1); assert.match(wt.data.error, /worktree/i); assert.deepEqual(tree(temp), wtBefore);
  const invalidBefore = tree(temp); const invalid = cli(collisionParent, 'not-a-checkout'); assert.equal(invalid.status, 1); assert.deepEqual(tree(temp), invalidBefore);
  passed('AC4 collisions, unsupported worktrees and invalid sources fail before mutation');
  const employeeSource = repo('employee-source', { project_id: 'employee-source', agents: { 'stable-employee': { role: 'pm', role_dir: 'agents/hermes/pm', provisioning_state: 'provisioned' } }, memory: { bank: 'unchanged-bank' } }); git(employeeSource, 'remote', 'add', 'origin', upstream);
  const employeeBefore = tree(temp); const employee = cli(collisionParent, employeeSource); assert.equal(employee.status, 1); assert.match(employee.data.error, /Flume.*relocation/i); assert.deepEqual(tree(temp), employeeBefore);
  passed('AC3 missing Flume relocation contract fails closed (full AC3 UNPROVEN)', { result: employee.data });
  const blockedRemote = bare(employeeSource, 'employee-remote'); const blockedParent = repo('blocked-remote-parent');
  const blocked = cli(blockedParent, blockedRemote, '--name', 'blocked'); assert.equal(blocked.status, 1); assert.equal(blocked.data.status, 'recovery_required');
  assert.equal(existsSync(join(blockedParent, 'blocked')), false); assert.equal(git(blockedParent, 'ls-files', '--stage', '--', 'blocked'), '');
  assert.equal(git(blocked.data.recovery.checkout, 'rev-parse', 'HEAD'), git(employeeSource, 'rev-parse', 'HEAD'));
  assert.deepEqual(JSON.parse(readFileSync(join(blocked.data.recovery.checkout, '.project.json'))).agents, JSON.parse(readFileSync(join(employeeSource, '.project.json'))).agents);
  const unfinishedBefore = tree(temp); const unfinished = cli(blockedParent, blockedRemote, '--name', 'blocked'); assert.equal(unfinished.status, 1); assert.match(unfinished.data.error, /Unfinished import receipt/); assert.deepEqual(tree(temp), unfinishedBefore);
  passed('AC4 unsupported remote binding retains a recovery checkout and interrupted receipt blocks reruns', { result: blocked.data });
  const skillSource = repo('skill-source'); git(skillSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(skillSource, '.agents/skills/copied'), { recursive: true }); writeFileSync(join(skillSource, '.agents/skills/copied/SKILL.md'), 'recoverable baseline copy');
  const receiptOptions = { home, env, stateHome: join(home, '.local/state') };
  await withLock('pjan-165-activation-test', async () => { const previous = await readActivationReceipt(skillSource, receiptOptions); await writeActivationReceipt(previous, { owned: [] }, receiptOptions); }, receiptOptions);
  const skillBefore = tree(temp); const skill = cli(collisionParent, skillSource); assert.equal(skill.status, 1); assert.match(skill.data.error, /Skillex.*relocation/i); assert.deepEqual(tree(temp), skillBefore);
  passed('AC3 actual Skillex scopeRoot receipt blocks relocation and preserves copied skills', { result: skill.data });
  const serviceSource = repo('service-source'); git(serviceSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true }); writeFileSync(join(home, '.config/systemd/user/pjan-165.service'), `[Service]\nWorkingDirectory=${serviceSource}\n`);
  const serviceBefore = tree(temp); const serviceBlocked = cli(collisionParent, serviceSource); assert.equal(serviceBlocked.status, 1); assert.match(serviceBlocked.data.error, /service binding/i); assert.deepEqual(tree(temp), serviceBefore);
  passed('AC3 unsupported service relocation fails before mutation', { result: serviceBlocked.data });
  const wrapperSource = repo('wrapper-source'); git(wrapperSource, 'remote', 'add', 'origin', upstream);
  writeFileSync(join(home, '.local/bin/wrapper'), `#!/bin/sh\nexec ${wrapperSource}/bin/run\n`); chmodSync(join(home, '.local/bin/wrapper'), 0o755);
  const wrapperBefore = tree(temp); const wrapper = cli(collisionParent, wrapperSource); assert.equal(wrapper.status, 1); assert.match(wrapper.data.error, /executable binding/i); assert.deepEqual(tree(temp), wrapperBefore);
  passed('AC3 opaque executable binding fails before mutation', { result: wrapper.data });
  const pilotSource = repo('pilot-config-source'); git(pilotSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(home, '.config/pilot'), { recursive: true }); writeFileSync(join(home, '.config/pilot/config.json'), JSON.stringify({ defaultSchema: join(pilotSource, 'schemas/default.json'), preserved_field: 'keep' }));
  const pilotBefore = tree(temp); const pilotConfig = cli(collisionParent, pilotSource); assert.equal(pilotConfig.status, 1); assert.match(pilotConfig.data.error, /Pilot defaultSchema.*relocation adapter/); assert.deepEqual(tree(temp), pilotBefore);
  passed('AC3 Pilot defaultSchema binding refuses unsupported relocation', { result: pilotConfig.data });
  const duplicate = repo('duplicate-source', { project_id: 'stable-id', agents: {} }); git(duplicate, 'remote', 'add', 'origin', upstream);
  const duplicateBefore = tree(temp); const duplicateResult = cli(collisionParent, duplicate); assert.equal(duplicateResult.status, 1); assert.match(duplicateResult.data.error, /identity collision/i); assert.deepEqual(tree(temp), duplicateBefore);
  const noOrigin = repo('no-origin'); const noOriginBefore = tree(temp); assert.equal(cli(collisionParent, noOrigin).status, 1); assert.deepEqual(tree(temp), noOriginBefore);
  passed('AC4 live registry identity collision and missing origin fail before mutation');
  writeFileSync(join(collisionParent, '.gitmodules'), '# unrelated untracked work\n');
  const modulesBefore = tree(temp); const modules = cli(collisionParent, noOrigin); assert.equal(modules.status, 1); assert.match(modules.data.error, /Untracked .gitmodules/); assert.deepEqual(tree(temp), modulesBefore);
  passed('AC4 unrelated .gitmodules work is preserved');
  const freshSeed = repo('fresh-seed', null); const freshRemote = bare(freshSeed, 'fresh'); const freshParent = repo('fresh-parent');
  const fresh = cli(freshParent, `file://${freshRemote}`, '--name', 'fresh-import'); assert.equal(fresh.status, 0, JSON.stringify(fresh.data)); assert.equal(fresh.data.plan.projectId, 'fresh-import');
  assert.equal(git(join(freshParent, 'fresh-import'), 'remote', 'get-url', 'origin'), `file://${freshRemote}`);
  passed('AC2 normal file Git URL and manifest initialization through shared enrollment');
} finally {
  if (process.env.PJAN_165_EVIDENCE_DIR) { mkdirSync(process.env.PJAN_165_EVIDENCE_DIR, { recursive: true }); writeFileSync(join(process.env.PJAN_165_EVIDENCE_DIR, 'import-cli-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`); }
  if (service && service.exitCode === null) { service.kill('SIGTERM'); await new Promise(r => service.once('exit', r)); }
  if (db) await db.end();
  if (admin._connected) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  rmSync(temp, { recursive: true, force: true });
}
