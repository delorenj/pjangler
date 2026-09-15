import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pjan-80-registry-'));
const database = `pjan80_${process.pid}_${Date.now()}`;
const env = { ...process.env, PGHOST: process.env.PGHOST ?? '/var/run/postgresql', PGDATABASE: database, PJ_REGISTRY_PORT: '0' };
const admin = new pg.Client({ host: env.PGHOST, database: process.env.PJ_TEST_ADMIN_DATABASE ?? 'postgres' });
let child;
let db;
let output = '';
let url;
const manifest = (name, data) => {
  const dir = join(temp, name); mkdirSync(dir, { recursive: true });
  const path = join(dir, '.project.json'); writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`); return path;
};
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
async function request(path = '/v1/registry', method = 'GET', data) {
  const response = await fetch(`${url}${path}`, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'content-type': 'application/json' } }) });
  return { status: response.status, data: await response.json() };
}
async function launch(entry) {
  output = ''; url = undefined;
  child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    if (child.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  assert.ok(url, output); assert.equal((await ok('/health')).ok, true);
}
async function ok(path, method, data) {
  const result = await request(path, method, data); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  db = new pg.Client({ host: env.PGHOST, database }); await db.connect();
  await db.query("CREATE TABLE public.projects (id text PRIMARY KEY, payload text); INSERT INTO public.projects VALUES ('legacy','preserve')");
  const entry = join(temp, 'service.mjs');
  buildSync({ entryPoints: [join(root, 'src/project-registry-service.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  const legacyIndexPath = manifest('legacy-index', { project_id: 'legacy-index' });
  await db.query(`CREATE SCHEMA pjangler_index;
    CREATE TABLE pjangler_index.projects (
      project_id text PRIMARY KEY CHECK (project_id ~ '^[a-z0-9][a-z0-9-]*$'),
      manifest_path text UNIQUE NOT NULL, snapshot jsonb NOT NULL, content_hash text NOT NULL,
      indexed_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'ok', error text)`);
  await db.query('INSERT INTO pjangler_index.projects(project_id,manifest_path,snapshot,content_hash) VALUES($1,$2,$3,$4)', ['legacy-index', legacyIndexPath, { project_id: 'legacy-index' }, 'legacy-hash']);
  await launch(entry);
  assert.equal((await db.query("SELECT atttypid::regtype::text AS type FROM pg_attribute WHERE attrelid='pjangler_index.projects'::regclass AND attname='project_id'")).rows[0].type, 'citext');
  assert.equal((await db.query("SELECT content_hash FROM pjangler_index.projects WHERE project_id='LEGACY-INDEX'")).rows[0].content_hash, 'legacy-hash');
  await ok('/v1/remove', 'POST', { project_id: 'legacy-index' });
  const alpha = manifest('alpha', { project_slug: 'AlPhA', project_name: 'Alpha', custom: { keep: 7 }, ticket_provider: { type: 'plane', board_id: 'uuid-provider' }, notebook: { policy: { capture: true }, binding: { notebook_id: 'notebook:alpha' } } });
  let registry = await ok('/v1/index', 'POST', { manifest_path: alpha });
  assert.equal(read(alpha).project_id, 'alpha'); assert.equal(read(alpha).project_slug, undefined);
  assert.equal(registry.projects.alpha.slug, 'alpha'); assert.equal(registry.projects.alpha.project_id, 'alpha');
  assert.equal((await db.query("SELECT project_id FROM pjangler_index.projects WHERE project_id='ALPHA'")).rows[0].project_id, 'alpha');
  for (const id of ['ALPHA', 'bad-', 'x'.repeat(129)]) {
    await assert.rejects(db.query('INSERT INTO pjangler_index.projects(project_id,manifest_path,snapshot,content_hash) VALUES($1,$2,$3,$4)', [id, `/tmp/direct-${id}/.project.json`, {}, 'invalid']), error => ['23505', '23514'].includes(error.code));
  }
  assert.equal(registry.projects.alpha.custom.keep, 7); assert.equal(registry.projects.alpha.ticket_provider.board_id, 'uuid-provider');
  const duplicate = manifest('duplicate', { project_slug: 'ALPHA', project_name: 'Other' });
  const duplicateBefore = readFileSync(duplicate, 'utf8');
  assert.equal((await request('/v1/index', 'POST', { manifest_path: duplicate })).status, 409);
  assert.equal(readFileSync(duplicate, 'utf8'), duplicateBefore);
  const raceA = manifest('race-a', { project_slug: 'RACE' });
  const raceB = manifest('race-b', { project_slug: 'race' });
  const race = await Promise.all([raceA, raceB].map(manifest_path => request('/v1/index', 'POST', { manifest_path })));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal([read(raceA), read(raceB)].filter(value => value.project_id === 'race').length, 1);
  await ok('/v1/remove', 'POST', { project_id: 'race' });
  const invalid = manifest('invalid', { project_id: 'bad_id' });
  assert.equal((await request('/v1/index', 'POST', { manifest_path: invalid })).status, 422);
  const oldHash = registry.__registry_hashes.alpha;
  write(alpha, { ...read(alpha), project_description: 'direct edit' });
  registry = await ok(); assert.equal(registry.projects.alpha.description, 'direct edit'); assert.notEqual(registry.__registry_hashes.alpha, oldHash);
  const stale = structuredClone(registry);
  write(alpha, { ...read(alpha), project_description: 'newer direct edit', custom: { keep: 7, direct: true } });
  stale.projects.alpha.name = 'Changed name';
  registry = await ok('/v1/registry', 'PUT', stale);
  assert.equal(read(alpha).project_name, 'Changed name'); assert.equal(read(alpha).project_description, 'newer direct edit'); assert.equal(read(alpha).custom.direct, true);
  stale.projects.alpha.description = 'stale conflicting text';
  assert.equal((await request('/v1/registry', 'PUT', stale)).status, 409);
  assert.equal(read(alpha).project_description, 'newer direct edit');
  const concurrentA = await ok(); const concurrentB = structuredClone(concurrentA);
  concurrentA.projects.alpha.description = 'concurrent A'; concurrentB.projects.alpha.description = 'concurrent B';
  const concurrent = await Promise.all([concurrentA, concurrentB].map(snapshot => request('/v1/registry', 'PUT', snapshot)));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  registry = await ok(); registry.projects.alpha.description = 'writer already saved';
  write(alpha, { ...read(alpha), project_description: 'writer already saved' });
  await ok('/v1/registry', 'PUT', registry);
  registry = await ok(); registry.projects.alpha.notebook = { notebook_id: 'notebook:replacement' };
  await ok('/v1/registry', 'PUT', registry);
  assert.deepEqual(read(alpha).notebook.policy, { capture: true }); assert.equal(read(alpha).notebook.binding.notebook_id, 'notebook:replacement');
  registry = await ok(); registry.projects.alpha.notebook_policy = { capture: false, user_policy: 'kept' };
  await ok('/v1/registry', 'PUT', registry);
  assert.deepEqual(read(alpha).notebook.policy, { capture: false, user_policy: 'kept' });
  assert.equal(read(alpha).notebook_policy, undefined);
  const valid = readFileSync(alpha, 'utf8');
  write(alpha, { ...read(alpha), source_artifacts: 123 });
  registry = await ok(); assert.equal(registry.__registry_status.alpha.status, 'invalid'); assert.ok(Array.isArray(registry.projects.alpha.source_artifacts));
  writeFileSync(alpha, valid);
  const large = await ok(); large.projects.alpha.description = 'x'.repeat(2 * 1024 * 1024);
  const tooLarge = await request('/v1/registry', 'PUT', large); assert.equal(tooLarge.status, 413); assert.equal(readFileSync(alpha, 'utf8'), valid);
  writeFileSync(alpha, '{bad');
  registry = await ok(); assert.equal(registry.__registry_status.alpha.status, 'invalid'); assert.match(registry.__registry_status.alpha.error, /Malformed/);
  registry.projects.alpha.description = 'cannot overwrite invalid manifest';
  assert.equal((await request('/v1/registry', 'PUT', registry)).status, 422); assert.equal(readFileSync(alpha, 'utf8'), '{bad');
  rmSync(alpha); registry = await ok(); assert.equal(registry.__registry_status.alpha.status, 'missing');
  writeFileSync(alpha, valid); registry = await ok('/v1/reindex', 'POST', {}); assert.equal(registry.__registry_status.alpha.status, 'ok');
  const beta = manifest('beta', { project_id: 'beta', project_name: 'Beta' });
  registry = await ok('/v1/index', 'POST', { manifest_path: beta });
  rmSync(beta); registry = await ok(); registry.projects.alpha.name = 'Unaffected by missing beta';
  await ok('/v1/registry', 'PUT', registry); assert.equal(read(alpha).project_name, 'Unaffected by missing beta');
  write(beta, { project_id: 'beta', project_name: 'Beta' });
  registry = await ok(); delete registry.projects.beta;
  await ok('/v1/registry', 'PUT', registry); assert.ok((await ok()).projects.beta, 'absent snapshot rows must not be deleted');
  await ok('/v1/settings', 'POST', { notebook: { provider: 'open-notebook', base_url: 'http://localhost:5055' } });
  assert.equal((await ok()).notebook.provider, 'open-notebook');
  const oldSettings = await ok();
  await ok('/v1/settings', 'POST', { notebook: { provider: 'open-notebook', base_url: 'http://localhost:5056' } });
  oldSettings.projects.alpha.description = 'project change retains newer global settings';
  await ok('/v1/registry', 'PUT', oldSettings);
  assert.equal((await ok()).notebook.base_url, 'http://localhost:5056');
  const beforeRemove = await ok();
  await ok('/v1/remove', 'POST', { project_id: 'BETA' }); assert.equal((await ok()).projects.beta, undefined); assert.equal(read(beta).project_id, 'beta');
  beforeRemove.projects.alpha.name = 'Save after another client removed beta';
  await ok('/v1/registry', 'PUT', beforeRemove); assert.equal((await ok()).projects.beta, undefined);
  beforeRemove.projects.beta.description = 'cannot resurrect';
  assert.equal((await request('/v1/registry', 'PUT', beforeRemove)).status, 409); assert.equal((await ok()).projects.beta, undefined);
  const settingsBefore = await ok();
  assert.equal((await request('/v1/settings', 'POST', { notebook: { base_url: 'https://user:password@example.com' } })).status, 422);
  assert.deepEqual((await ok()).notebook, settingsBefore.notebook);
  const deleteSettings = await ok(); delete deleteSettings.notebook;
  await ok('/v1/registry', 'PUT', deleteSettings); assert.equal((await ok()).notebook, undefined);
  await ok('/v1/settings', 'POST', { notebook: { base_url: 'http://localhost:5055' } });
  const staleDelete = await ok(); delete staleDelete.notebook;
  await ok('/v1/settings', 'POST', { notebook: { base_url: 'http://localhost:5056' } });
  assert.equal((await request('/v1/registry', 'PUT', staleDelete)).status, 409);
  assert.equal((await ok()).notebook.base_url, 'http://localhost:5056');
  const moveOld = manifest('move-old', { project_id: 'move' });
  await ok('/v1/index', 'POST', { manifest_path: moveOld });
  const moveNew = manifest('move-new', { project_id: 'move' });
  assert.equal((await request('/v1/index', 'POST', { manifest_path: moveNew })).status, 409);
  rmSync(moveOld);
  registry = await ok('/v1/index', 'POST', { manifest_path: moveNew }); assert.equal(registry.__registry_status.move.manifest_path, moveNew);
  const broken = manifest('broken-path', { project_id: 'broken-path' });
  await ok('/v1/index', 'POST', { manifest_path: broken });
  const brokenDir = join(temp, 'broken-path'); const movedDir = join(temp, 'broken-parent');
  renameSync(brokenDir, movedDir); writeFileSync(brokenDir, 'not a directory');
  registry = await ok(); assert.equal(registry.__registry_status['broken-path'].status, 'missing'); assert.equal(registry.__registry_status.alpha.status, 'ok');
  rmSync(brokenDir); symlinkSync(brokenDir, brokenDir);
  registry = await ok(); assert.equal(registry.__registry_status['broken-path'].status, 'invalid');
  rmSync(brokenDir); renameSync(movedDir, brokenDir);
  chmodSync(brokenDir, 0);
  try { if (process.getuid?.() !== 0) assert.equal((await ok()).__registry_status['broken-path'].status, 'invalid'); }
  finally { chmodSync(brokenDir, 0o755); }
  assert.equal((await ok()).__registry_status['broken-path'].status, 'ok');
  const gamma = manifest('gamma', { project_id: 'gamma', project_name: 'Manifest wins', unknown: 'retain' });
  registry = await ok(); registry.projects.gamma = { project_id: 'gamma', slug: 'gamma', repo_path: join(temp, 'gamma'), name: 'Legacy name', description: 'Legacy description', agents: {}, status: 'archived', template: { custom: true }, source_artifacts: [{ kind: 'skill', path: '/artifact' }], created_at: '2026-01-01', updated_at: '2026-01-02', extra_legacy: 'keep' };
  await ok('/v1/registry', 'PUT', registry);
  assert.equal(read(gamma).project_name, 'Manifest wins'); assert.equal(read(gamma).project_description, 'Legacy description'); assert.equal(read(gamma).extra_legacy, 'keep'); assert.equal(read(gamma).status, 'archived'); assert.equal(read(gamma).unknown, 'retain');
  const symlinkPath = join(temp, 'symlink'); mkdirSync(symlinkPath); symlinkSync(alpha, join(symlinkPath, '.project.json'));
  assert.equal((await request('/v1/index', 'POST', { manifest_path: join(symlinkPath, '.project.json') })).status, 422);
  // Force the index transaction to fail after the manifest rename, then prove retry convergence.
  await db.query(`CREATE FUNCTION pjangler_index.reject_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected index failure'; END $$;
    CREATE TRIGGER reject_update BEFORE UPDATE ON pjangler_index.projects FOR EACH ROW EXECUTE FUNCTION pjangler_index.reject_update()`);
  registry = await ok(); registry.projects.alpha.description = 'saved despite index failure';
  const failed = await request('/v1/registry', 'PUT', registry); assert.equal(failed.status, 503); assert.equal(failed.data.code, 'index_stale');
  assert.equal(read(alpha).project_description, 'saved despite index failure');
  await db.query('DROP TRIGGER reject_update ON pjangler_index.projects');
  await ok('/v1/registry', 'PUT', registry); assert.equal((await ok()).projects.alpha.description, 'saved despite index failure');
  const registeredPaths = Object.values((await ok()).__registry_status).map(status => status.manifest_path);
  const receipt = join(temp, 'discovery-receipt.json'); write(receipt, { projects: registeredPaths.map(manifest_path => ({ manifest_path })) });
  await db.query('DELETE FROM pjangler_index.projects'); assert.deepEqual((await ok()).projects, {});
  registry = await ok('/v1/rebuild', 'POST', { receipt_path: receipt }); assert.ok(registry.projects.alpha); assert.ok(registry.projects.gamma);
  await db.query('DELETE FROM pjangler_index.projects');
  registry = await ok('/v1/rebuild', 'POST', { manifest_paths: registeredPaths }); assert.equal(Object.keys(registry.projects).length, registeredPaths.length);
  assert.deepEqual((await db.query('SELECT * FROM public.projects')).rows, [{ id: 'legacy', payload: 'preserve' }]);
  const beforeRestart = (await db.query('SELECT project_id,manifest_path,content_hash FROM pjangler_index.projects ORDER BY project_id')).rows;
  child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  await launch(entry);
  assert.deepEqual((await db.query('SELECT project_id,manifest_path,content_hash FROM pjangler_index.projects ORDER BY project_id')).rows, beforeRestart);
  assert.equal((await db.query("SELECT project_id FROM pjangler_index.projects WHERE project_id='ALPHA'")).rows[0].project_id, 'alpha');
  console.log('PASS PJAN-80 real PostgreSQL registry: citext upgrade/restart, direct SQL casing/constraints, registration, aliases, collisions, direct edits, conflicts, notebook policy, malformed/missing, non-deletion, settings validation/deletion, relocation, stale removal, size limits, path failures, rebuild recovery, symlinks and failure recovery');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (db) await db.end();
  if (admin._connected) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  rmSync(temp, { recursive: true, force: true });
}
