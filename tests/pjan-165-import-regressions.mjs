import "./helpers/hermetic-suite.mjs";
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActivationReceipt, writeActivationReceipt, withLock } from '@delorenj/skillex';
import { bytes, startHarness, tree } from './helpers/import-harness.mjs';

// PJAN-165 `pj import` acceptance suite. The real built CLI (dist/index.js) runs against
// disposable repositories, local bare remotes, an isolated HOME and a disposable registry
// database, all under the hermetic scratch base (tests/helpers/import-harness.mjs). Nothing
// reaches ~/code, ~/code/33GOD, the live registry or the network: GitHub shorthand is
// parse-checked with --dry-run only. Receipt-loss convergence (R1) lives in
// tests/pjan-165-import-receipt-recovery.mjs.
const h = await startHarness('pjan-165-import');
const { root, temp, home, env, run, git, repo, bare, cli, request, db } = h;
const url = h.url;
function passed(name) { console.log(`PASS ${name}`); }
try {
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
  const employeeBefore = tree(temp); const employee = cli(collisionParent, employeeSource); assert.equal(employee.status, 1); assert.match(employee.data.error, /FLUME-41/); assert.deepEqual(tree(temp), employeeBefore);
  passed('AC3 missing Flume relocation contract fails closed (full AC3 UNPROVEN)', { result: employee.data });
  const blockedRemote = bare(employeeSource, 'employee-remote'); const blockedParent = repo('blocked-remote-parent');
  const blocked = cli(blockedParent, blockedRemote, '--name', 'blocked'); assert.equal(blocked.status, 1); assert.equal(blocked.data.status, 'recovery_required'); assert.match(blocked.data.error, /FLUME-41/);
  assert.equal(existsSync(join(blockedParent, 'blocked')), false); assert.equal(git(blockedParent, 'ls-files', '--stage', '--', 'blocked'), '');
  assert.equal(git(blocked.data.recovery.checkout, 'rev-parse', 'HEAD'), git(employeeSource, 'rev-parse', 'HEAD'));
  assert.deepEqual(JSON.parse(readFileSync(join(blocked.data.recovery.checkout, '.project.json'))).agents, JSON.parse(readFileSync(join(employeeSource, '.project.json'))).agents);
  const unfinishedBefore = tree(temp); const unfinished = cli(blockedParent, blockedRemote, '--name', 'blocked'); assert.equal(unfinished.status, 1); assert.match(unfinished.data.error, /Unfinished import receipt/); assert.deepEqual(tree(temp), unfinishedBefore);
  passed('AC4 unsupported remote binding retains a recovery checkout and interrupted receipt blocks reruns', { result: blocked.data });
  const skillSource = repo('skill-source'); git(skillSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(skillSource, '.agents/skills/copied'), { recursive: true }); writeFileSync(join(skillSource, '.agents/skills/copied/SKILL.md'), 'recoverable baseline copy');
  const receiptOptions = { home, env, stateHome: join(home, '.local/state') };
  await withLock('pjan-165-activation-test', async () => { const previous = await readActivationReceipt(skillSource, receiptOptions); await writeActivationReceipt(previous, { owned: [] }, receiptOptions); }, receiptOptions);
  const skillBefore = tree(temp); const skill = cli(collisionParent, skillSource); assert.equal(skill.status, 1); assert.match(skill.data.error, /Skillex relocation contract missing.*scopeRoot/); assert.deepEqual(tree(temp), skillBefore);
  passed('AC3 actual Skillex scopeRoot receipt blocks relocation and preserves copied skills', { result: skill.data });
  const serviceSource = repo('service-source'); git(serviceSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true }); writeFileSync(join(home, '.config/systemd/user/pjan-165.service'), `[Service]\nWorkingDirectory=${serviceSource}\n`);
  const serviceBefore = tree(temp); const serviceBlocked = cli(collisionParent, serviceSource); assert.equal(serviceBlocked.status, 1); assert.match(serviceBlocked.data.error, /service binding.*FLUME-41/); assert.deepEqual(tree(temp), serviceBefore);
  passed('AC3 unsupported service relocation fails before mutation', { result: serviceBlocked.data });
  const wrapperSource = repo('wrapper-source'); git(wrapperSource, 'remote', 'add', 'origin', upstream);
  writeFileSync(join(home, '.local/bin/wrapper'), `#!/bin/sh\nexec ${wrapperSource}/bin/run\n`); chmodSync(join(home, '.local/bin/wrapper'), 0o755);
  const wrapperBefore = tree(temp); const wrapper = cli(collisionParent, wrapperSource); assert.equal(wrapper.status, 1); assert.match(wrapper.data.error, /executable binding.*Pilot\/config path-binding contract/); assert.deepEqual(tree(temp), wrapperBefore);
  passed('AC3 opaque executable binding fails before mutation', { result: wrapper.data });
  const pilotSource = repo('pilot-config-source'); git(pilotSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(home, '.config/pilot'), { recursive: true }); writeFileSync(join(home, '.config/pilot/config.json'), JSON.stringify({ defaultSchema: join(pilotSource, 'schemas/default.json'), preserved_field: 'keep' }));
  const pilotBefore = tree(temp); const pilotConfig = cli(collisionParent, pilotSource); assert.equal(pilotConfig.status, 1); assert.match(pilotConfig.data.error, /Pilot defaultSchema.*relocation adapter.*Pilot\/config path-binding contract/); assert.deepEqual(tree(temp), pilotBefore);
  passed('AC3 Pilot defaultSchema binding refuses unsupported relocation', { result: pilotConfig.data });
  const hermesSource = repo('hermes-dir-source'); git(hermesSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(hermesSource, 'agents/hermes/pm'), { recursive: true }); writeFileSync(join(hermesSource, 'agents/hermes/pm/.keep'), '');
  const hermesBefore = tree(temp); const hermesBlocked = cli(collisionParent, hermesSource); assert.equal(hermesBlocked.status, 1); assert.match(hermesBlocked.data.error, /FLUME-41/); assert.deepEqual(tree(temp), hermesBefore);
  passed('AC3 a checkout carrying agents/hermes fails before mutation naming FLUME-41', { result: hermesBlocked.data });
  const linkedSkillSource = repo('linked-skill-source'); git(linkedSkillSource, 'remote', 'add', 'origin', upstream);
  mkdirSync(join(linkedSkillSource, '.agents/skills'), { recursive: true }); symlinkSync('../../elsewhere', join(linkedSkillSource, '.agents/skills/linked'));
  const linkedSkillBefore = tree(temp); const linkedSkill = cli(collisionParent, linkedSkillSource); assert.equal(linkedSkill.status, 1); assert.match(linkedSkill.data.error, /Skillex relocation contract missing.*activation links/); assert.deepEqual(tree(temp), linkedSkillBefore);
  passed('AC3 project-scope Skillex activation links fail before mutation naming the Skillex contract', { result: linkedSkill.data });
  const pilotLinkSource = repo('pilot-link-source'); git(pilotLinkSource, 'remote', 'add', 'origin', upstream);
  symlinkSync(join(pilotLinkSource, 'schemas/default.json'), join(home, '.config/pilot/default.schema.json'));
  const pilotLinkBefore = tree(temp); const pilotLink = cli(collisionParent, pilotLinkSource); assert.equal(pilotLink.status, 1); assert.match(pilotLink.data.error, /Pilot config binding.*Pilot\/config path-binding contract/); assert.deepEqual(tree(temp), pilotLinkBefore);
  passed('AC3 Pilot config symlink into the checkout fails before mutation naming the Pilot/config contract', { result: pilotLink.data });
  const flumeProbe = run('sh', ['-c', 'command -v flume'], temp);
  if (flumeProbe.status !== 0) console.log('SKIP AC3 Flume roster project bindings: no flume CLI on PATH (the gate fails closed without it)');
  else {
    // The REAL `flume roster` against a disposable agent registry under the isolated HOME; PJ_REGISTRY_URL points it at the disposable service.
    const rosterSource = repo('roster-source'); git(rosterSource, 'remote', 'add', 'origin', upstream);
    mkdirSync(join(home, '.hermes'), { recursive: true });
    const rosterRegistry = join(home, '.hermes/agents-registry.yaml');
    writeFileSync(rosterRegistry, `schema_version: 1\nagents:\n  roster-agent:\n    repo: roster-source\n    role: pm\n    type: hermes\n    project_path: ${rosterSource}\n    profile_name: roster-agent\n    role_dir: ${join(home, '.hermes/profiles/roster-agent')}\n`);
    try {
      const rosterBefore = tree(temp); const roster = cli(collisionParent, rosterSource); assert.equal(roster.status, 1, JSON.stringify(roster.data)); assert.match(roster.data.error, /FLUME-41.*roster/, roster.data.error); assert.deepEqual(tree(temp), rosterBefore);
      passed('AC3 a Flume roster row bound to the checkout fails before mutation naming FLUME-41', { result: roster.data });
    } finally { rmSync(rosterRegistry, { force: true }); rmSync(join(home, '.hermes'), { recursive: true, force: true }); }
  }
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
  await h.stop();
}
