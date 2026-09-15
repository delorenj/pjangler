import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { normalizeProjectId as normalizeIdentity } from './registryClient';
import { validateGlobalNotebookConfig } from './notebookSettingsValidation';

type Json = Record<string, any>;
export class RegistryError extends Error {
  constructor(message: string, public status = 422, public code = 'invalid_manifest') { super(message); }
}
export function normalizeProjectId(value: unknown): string {
  try { return normalizeIdentity(value); }
  catch (error) { throw new RegistryError(error instanceof Error ? error.message : String(error)); }
}
function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stable(value: any): string {
  return JSON.stringify(value, (_key, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
function equal(a: any, b: any): boolean { return stable(a) === stable(b); }
function mergeMissing(current: any, fallback: any): any {
  if (current === undefined) return fallback;
  if (!object(current) || !object(fallback)) return current;
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(fallback)])].map(key => [key, mergeMissing(current[key], fallback[key])]));
}
function hash(data: string): string { return createHash('sha256').update(data).digest('hex'); }

function validateManifestFields(manifest: Json, path: string): void {
  const fail = (field: string, shape: string): never => { throw new RegistryError(`Manifest ${path}: ${field} must be ${shape}`); };
  const strings = (value: Json, names: string[], prefix = '') => {
    for (const name of names) if (value[name] !== undefined && typeof value[name] !== 'string') fail(`${prefix}${name}`, 'a string');
  };
  strings(manifest, ['project_name', 'name', 'project_description', 'description', 'status', 'repo_path', 'created_at', 'updated_at']);
  for (const field of ['ticket_provider', 'agents', 'template', 'notebook', 'automation']) if (manifest[field] !== undefined && !object(manifest[field])) fail(field, 'an object');
  if (manifest.source_artifacts !== undefined && !Array.isArray(manifest.source_artifacts)) fail('source_artifacts', 'an array');
  for (const [index, artifact] of (manifest.source_artifacts ?? []).entries()) {
    if (!object(artifact)) fail(`source_artifacts.${index}`, 'an object');
    strings(artifact, ['kind', 'path', 'package_name'], `source_artifacts.${index}.`);
  }
  if (manifest.ticket_provider) strings(manifest.ticket_provider, ['type', 'workspace', 'identifier', 'identifier_source', 'identifier_fetched_at', 'board_id', 'board_confirmed_at', 'board_url', 'state'], 'ticket_provider.');
  for (const [name, agent] of Object.entries(manifest.agents ?? {})) {
    if (!object(agent)) fail(`agents.${name}`, 'an object');
    strings(agent as Json, ['role', 'role_dir', 'provisioning_state'], `agents.${name}.`);
  }
  if (manifest.template?.commonproject !== undefined) {
    if (!object(manifest.template.commonproject)) fail('template.commonproject', 'an object');
    const template = manifest.template.commonproject;
    if (template.enabled !== undefined && typeof template.enabled !== 'boolean') fail('template.commonproject.enabled', 'boolean');
    strings(template, ['primary_language'], 'template.commonproject.');
  }
  for (const field of ['binding', 'policy']) if (manifest.notebook?.[field] !== undefined && !object(manifest.notebook[field])) fail(`notebook.${field}`, 'an object');
  if (manifest.notebook?.binding) strings(manifest.notebook.binding, ['provider', 'state', 'notebook_name', 'blocked_reason', 'notebook_id', 'overview_note_id', 'created_at', 'updated_at'], 'notebook.binding.');
  if (manifest.notebook?.policy) {
    try { validateGlobalNotebookConfig({ defaults: manifest.notebook.policy }); }
    catch (error) { throw new RegistryError(`Manifest ${path}: invalid notebook policy: ${String(error)}`); }
  }
}
function serializedManifest(manifest: Json): string {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new RegistryError('Serialized manifest exceeds 2 MiB; no manifest was written', 413, 'manifest_too_large');
  return serialized;
}

export async function readManifest(path: string) {
  path = resolve(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || basename(path) !== '.project.json') {
    throw new RegistryError(`Expected a regular .project.json file: ${path}`);
  }
  path = await realpath(path);
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new RegistryError(`Manifest exceeds 2 MiB: ${path}`);
  let manifest: Json;
  try { manifest = JSON.parse(raw); } catch { throw new RegistryError(`Malformed JSON: ${path}`); }
  if (!object(manifest)) throw new RegistryError(`Expected a JSON object: ${path}`);
  validateManifestFields(manifest, path);
  const id = normalizeProjectId(manifest.project_id ?? manifest.project_slug);
  if (manifest.project_id && manifest.project_slug && normalizeProjectId(manifest.project_slug) !== id) {
    throw new RegistryError(`Conflicting project_id and project_slug: ${path}`, 409, 'identity_conflict');
  }
  return { path, raw, manifest, id, hash: hash(raw), mode: stat.mode & 0o777 };
}
type ReadManifest = Awaited<ReturnType<typeof readManifest>>;

export function recordFromManifest(manifest: Json, path: string): Json {
  const id = normalizeProjectId(manifest.project_id ?? manifest.project_slug);
  const { project_slug: _old, project_name: _name, project_description: _description, notebook, ...rest } = manifest;
  return {
    ...rest, project_id: id, slug: id,
    name: manifest.project_name ?? manifest.name ?? id,
    description: manifest.project_description ?? manifest.description ?? '',
    repo_path: dirname(path), status: manifest.status ?? 'active',
    source_artifacts: manifest.source_artifacts ?? [],
    template: manifest.template ?? { commonproject: { enabled: true, primary_language: 'typescript' } },
    ticket_provider: manifest.ticket_provider ?? { type: 'none', state: 'skipped' }, agents: manifest.agents ?? {},
    ...(notebook?.binding ? { notebook: notebook.binding } : {}),
    ...(notebook?.policy ? { notebook_policy: notebook.policy } : {}),
    created_at: manifest.created_at ?? '', updated_at: manifest.updated_at ?? '',
  };
}

async function writeManifest(original: ReadManifest, manifest: Json): Promise<ReadManifest> {
  validateManifestFields(manifest, original.path);
  const serialized = serializedManifest(manifest);
  const temp = join(dirname(original.path), `.project.json.${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, original.mode);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    // No await separates the comparison and rename. Uncoordinated external processes
    // still have no filesystem CAS guarantee; registry writers use the service lock.
    const stat = lstatSync(original.path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(original.path) !== original.path) throw new RegistryError(`Manifest path changed: ${original.path}`, 409, 'stale_manifest');
    const currentHash = hash(readFileSync(original.path, 'utf8'));
    if (currentHash !== original.hash) throw new RegistryError(`Manifest changed while saving ${original.path}; reload and retry`, 409, 'stale_manifest');
    renameSync(temp, original.path);
    committed = true;
    const dir = await open(dirname(original.path), constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
    return await readManifest(original.path);
  } catch (error) {
    if (committed) throw new RegistryError(`Manifest committed at ${original.path}, but indexing is stale. Run pj reindex --all. ${String(error)}`, 503, 'index_stale');
    throw error;
  } finally { await unlink(temp).catch(() => {}); }
}

// Merge only the leaves changed by this client; unrelated direct edits stay authoritative.
function mergeChanges(base: any, desired: any, current: any, path: string): any {
  if (equal(base, desired) || equal(current, desired)) return current;
  if (equal(current, base)) return desired;
  if (object(base) && object(desired) && object(current)) {
    const merged = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
      const value = mergeChanges(base[key], desired[key], current[key], `${path}.${key}`);
      if (value === undefined) delete merged[key]; else Object.defineProperty(merged, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return merged;
  }
  throw new RegistryError(`Concurrent manifest change conflicts at ${path}; reload the registry and retry`, 409, 'stale_manifest');
}

function applyRecord(manifest: Json, current: Json, next: Json): Json {
  const result = structuredClone(manifest);
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (['slug', 'project_id', 'repo_path', 'index_status', 'index_error'].includes(key) || key.startsWith('__registry_') || equal(current[key], next[key])) continue;
    const target = key === 'name' ? 'project_name' : key === 'description' ? 'project_description' : key;
    if (key === 'notebook' || key === 'notebook_policy') {
      const part = key === 'notebook' ? 'binding' : 'policy';
      result.notebook = { ...(object(result.notebook) ? result.notebook : {}) };
      if (next[key] === undefined) delete result.notebook[part]; else result.notebook[part] = next[key];
    } else if (next[key] === undefined) delete result[target]; else Object.defineProperty(result, target, { value: next[key], enumerable: true, writable: true, configurable: true });
  }
  result.project_id = normalizeProjectId(next.project_id ?? next.slug);
  delete result.project_slug;
  return result;
}

export class ManifestIndex {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly committed = new WeakMap<PoolClient, string>();
  constructor(public readonly pool: Pool) {}
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pjangler_index.manifests'))");
      await client.query(`CREATE EXTENSION IF NOT EXISTS citext;
        CREATE SCHEMA IF NOT EXISTS pjangler_index;
        CREATE TABLE IF NOT EXISTS pjangler_index.projects (
          project_id citext PRIMARY KEY,
          manifest_path text UNIQUE NOT NULL, snapshot jsonb NOT NULL,
          content_hash text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now(),
          status text NOT NULL DEFAULT 'ok', error text
        );
        ALTER TABLE pjangler_index.projects DROP CONSTRAINT IF EXISTS projects_project_id_check;
        ALTER TABLE pjangler_index.projects DROP CONSTRAINT IF EXISTS project_id_canonical;
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid='pjangler_index.projects'::regclass AND attname='project_id'
            AND atttypid <> 'citext'::regtype) THEN
            ALTER TABLE pjangler_index.projects ALTER COLUMN project_id TYPE citext USING project_id::citext;
          END IF;
        END $$;
        ALTER TABLE pjangler_index.projects ADD CONSTRAINT project_id_canonical
          CHECK (project_id::text ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length(project_id::text) <= 128);
        CREATE TABLE IF NOT EXISTS pjangler_index.settings (key text PRIMARY KEY, value jsonb NOT NULL);`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  private serialized<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('pjangler_index.manifests'))");
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const path = this.committed.get(client);
        if (path && !(error instanceof RegistryError && error.code === 'index_stale')) throw new RegistryError(`Manifest committed at ${path}; index is stale. Retry the same request or reindex. ${String(error)}`, 503, 'index_stale');
        throw error;
      }
      finally { this.committed.delete(client); client.release(); }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private async registrationRows(client: PoolClient, read: ReadManifest) {
    const result = await client.query('SELECT project_id,manifest_path FROM pjangler_index.projects WHERE project_id=$1 OR manifest_path=$2', [read.id, read.path]);
    for (const row of result.rows) {
      if (row.manifest_path === read.path) continue;
      let missing = false;
      try { await lstat(row.manifest_path); }
      catch (error) { missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
      if (!missing) throw new RegistryError(`project_id ${read.id} is already registered at ${row.manifest_path}; its canonical manifest must be missing before relocation`, 409, 'identity_collision');
    }
    return result.rows;
  }
  private async persist(client: PoolClient, read: ReadManifest, oldId?: string) {
    await this.registrationRows(client, read);
    if (oldId && oldId !== read.id) await client.query('DELETE FROM pjangler_index.projects WHERE project_id=$1 AND manifest_path=$2', [oldId, read.path]);
    await client.query(`INSERT INTO pjangler_index.projects(project_id,manifest_path,snapshot,content_hash) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id) DO UPDATE SET manifest_path=excluded.manifest_path,snapshot=excluded.snapshot,
      content_hash=excluded.content_hash,indexed_at=now(),status='ok',error=NULL`, [read.id, read.path, JSON.stringify(recordFromManifest(read.manifest, read.path)), read.hash]);
  }
  private async register(client: PoolClient, path: string) {
    let read = await readManifest(path);
    const collision = await this.registrationRows(client, read);
    const manifest: Json = { ...read.manifest, project_id: read.id };
    delete manifest.project_slug;
    let committed = false;
    try {
      if (!equal(manifest, read.manifest)) { read = await writeManifest(read, manifest); committed = true; this.committed.set(client, read.path); }
      await this.persist(client, read, collision.find(r => r.manifest_path === read.path)?.project_id);
    } catch (error) {
      if (committed) throw new RegistryError(`Manifest saved at ${read.path}; index is stale. Retry registration or reindex. ${String(error)}`, 503, 'index_stale');
      throw error;
    }
  }
  private async refresh(client: PoolClient) {
    const rows = (await client.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows;
    for (const row of rows) {
      try {
        const read = await readManifest(row.manifest_path);
        if (read.hash !== row.content_hash || row.status !== 'ok' || !equal(row.snapshot, recordFromManifest(read.manifest, read.path))) await this.persist(client, read, row.project_id);
      } catch (error) {
        if (!(error instanceof RegistryError) && !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await client.query('UPDATE pjangler_index.projects SET status=$2,error=$3 WHERE project_id=$1', [row.project_id, ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'invalid', String(error)]);
      }
    }
  }
  private async snapshot(client: PoolClient): Promise<Json> {
    const rows = (await client.query('SELECT * FROM pjangler_index.projects ORDER BY project_id')).rows;
    const settings = (await client.query('SELECT key,value FROM pjangler_index.settings')).rows;
    const projects: Json = Object.create(null), hashes: Json = Object.create(null), statuses: Json = Object.create(null), baseline: Json = Object.create(null);
    for (const row of rows) {
      projects[row.project_id] = row.snapshot;
      hashes[row.project_id] = row.content_hash;
      baseline[row.project_id] = structuredClone(row.snapshot);
      statuses[row.project_id] = { status: row.status, error: row.error, manifest_path: row.manifest_path, content_hash: row.content_hash, indexed_at: row.indexed_at };
    }
    const global = Object.fromEntries(settings.map(row => [row.key, row.value]));
    return { ...global, schema_version: 1, projects, __registry_hashes: hashes, __registry_baseline: baseline, __registry_status: statuses, __registry_settings_baseline: structuredClone(global) };
  }
  load(): Promise<Json> { return this.serialized(async client => { await this.refresh(client); return this.snapshot(client); }); }
  index(path: string): Promise<Json> { return this.serialized(async client => { await this.register(client, path); await this.refresh(client); return this.snapshot(client); }); }
  rebuild(paths: string[]): Promise<Json> {
    return this.serialized(async client => {
      const discovered = new Map<string, string>();
      for (const path of paths) {
        const read = await readManifest(path);
        if (discovered.has(read.id) && discovered.get(read.id) !== read.path) throw new RegistryError(`Duplicate project_id ${read.id} in rebuild paths`, 409, 'identity_collision');
        discovered.set(read.id, read.path);
        await this.registrationRows(client, read);
      }
      for (const path of discovered.values()) await this.register(client, path);
      await this.refresh(client);
      return this.snapshot(client);
    });
  }
  remove(id: string): Promise<Json> { return this.serialized(async client => { await client.query('DELETE FROM pjangler_index.projects WHERE project_id=$1', [normalizeProjectId(id)]); return this.snapshot(client); }); }
  settings(settings: Json): Promise<Json> {
    return this.serialized(async client => { await this.saveSettings(client, settings); return this.snapshot(client); });
  }
  private validateSettings(settings: Json) {
    try { validateGlobalNotebookConfig(settings.notebook); }
    catch (error) { throw new RegistryError(error instanceof Error ? error.message : String(error), 422, 'invalid_settings'); }
  }
  private async saveSettings(client: PoolClient, settings: Json) {
    this.validateSettings(settings);
    for (const [key, value] of Object.entries(settings)) {
      if (['schema_version', 'projects'].includes(key) || key.startsWith('__registry_')) continue;
      if (value === undefined) { await client.query('DELETE FROM pjangler_index.settings WHERE key=$1', [key]); continue; }
      await client.query('INSERT INTO pjangler_index.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
    }
  }
  save(registry: Json): Promise<Json> {
    if (!object(registry.projects)) return Promise.reject(new RegistryError('Expected registry.projects object'));
    return this.serialized(async client => {
      await this.refresh(client);
      const rows = (await client.query('SELECT * FROM pjangler_index.projects')).rows;
      const writes: Array<{ read: ReadManifest; manifest: Json; oldId?: string }> = [];
      const ids = new Set<string>();
      for (const [key, desiredInput] of Object.entries(registry.projects)) {
        if (!object(desiredInput)) throw new RegistryError(`Invalid project record ${key}`);
        const id = normalizeProjectId(desiredInput.project_id ?? desiredInput.slug ?? key);
        if (normalizeProjectId(key) !== id || (desiredInput.slug && normalizeProjectId(desiredInput.slug) !== id)) throw new RegistryError(`Identity aliases disagree for ${key}`, 409, 'identity_conflict');
        if (ids.has(id)) throw new RegistryError(`Duplicate normalized project_id ${id}`, 409, 'identity_collision');
        ids.add(id);
        const desired: Json = { ...desiredInput, project_id: id, slug: id };
        const row = rows.find(r => r.project_id === id);
        if (object(registry.__registry_baseline?.[id])) {
          if (equal(registry.__registry_baseline[id], desired)) continue;
          if (!row) throw new RegistryError(`Project ${id} was removed after this snapshot; reload before explicitly registering it`, 409, 'stale_manifest');
        }
        const path = row?.manifest_path ?? join(String(desired.repo_path ?? ''), '.project.json');
        const read = await readManifest(path);
        if (read.id !== id) throw new RegistryError(`Manifest at ${path} declares ${read.id}, not ${id}`, 409, 'identity_conflict');
        const current = recordFromManifest(read.manifest, read.path);
        const suppliedBase = registry.__registry_baseline?.[id];
        const base = object(suppliedBase) ? suppliedBase : row && registry.__registry_hashes?.[id] === row.content_hash ? row.snapshot : undefined;
        let next: Json;
        if (!row) {
          // Registration reconciles missing legacy metadata, but never replaces an existing manifest value.
          next = { ...desired, ...current };
          for (const [field, value] of Object.entries(desired)) {
            const manifestKey = field === 'name' ? 'project_name' : field === 'description' ? 'project_description' : field;
            if (field === 'notebook' ? read.manifest.notebook?.binding === undefined : field === 'notebook_policy' ? read.manifest.notebook?.policy === undefined : read.manifest[manifestKey] === undefined) next[field] = value;
            else next[field] = mergeMissing(current[field], value);
          }
        } else if (base) next = mergeChanges(base, desired, current, id);
        else if (equal(current, desired)) next = current;
        else throw new RegistryError(`Missing concurrency baseline for ${id}; reload the registry and retry`, 409, 'stale_manifest');
        if (next.repo_path !== current.repo_path) throw new RegistryError(`Cannot move ${id} through a registry snapshot; register its canonical manifest path`, 409, 'identity_conflict');
        const manifest = applyRecord(read.manifest, current, next);
        validateManifestFields(manifest, path);
        serializedManifest(manifest);
        writes.push({ read, manifest, oldId: row?.project_id });
      }
      let settings = Object.fromEntries(Object.entries(registry).filter(([key]) => !['schema_version', 'projects'].includes(key) && !key.startsWith('__registry_')));
      if (object(registry.__registry_settings_baseline)) {
        const currentSettings = Object.fromEntries((await client.query('SELECT key,value FROM pjangler_index.settings')).rows.map(row => [row.key, row.value]));
        settings = Object.fromEntries([...new Set([...Object.keys(registry.__registry_settings_baseline), ...Object.keys(settings)])].map(key => [key, mergeChanges(registry.__registry_settings_baseline[key], settings[key], currentSettings[key], `settings.${key}`)]));
      }
      this.validateSettings(settings);
      let committedPath: string | undefined;
      try {
        for (const write of writes) {
          let read = write.read;
          if (!equal(read.manifest, write.manifest)) { read = await writeManifest(read, write.manifest); committedPath = read.path; this.committed.set(client, read.path); }
          await this.persist(client, read, write.oldId);
        }
        await this.saveSettings(client, settings);
        return await this.snapshot(client);
      } catch (error) {
        if (committedPath) throw new RegistryError(`Manifest saved at ${committedPath}; index is stale. Retry the same save or reindex. ${String(error)}`, 503, 'index_stale');
        throw error;
      }
    });
  }
}
