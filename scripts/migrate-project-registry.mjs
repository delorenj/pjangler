#!/usr/bin/env node
// One-way migration: manifests own values; YAML supplies only missing legacy
// metadata and discovery locations. No live ticket-provider writes.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, lstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { normalizeProjectId } from "../src/project/registryClient.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const apply = args.includes("--apply");
const legacyPath = resolve(option("--legacy", join(homedir(), ".config/pjangler/projects.yaml")));
const endpoint = option("--url", process.env.PJ_REGISTRY_URL || "http://localhost:8764").replace(/\/$/, "");
const extraRepos = args.flatMap((arg, i) => arg === "--repo" ? [resolve(args[i + 1])] : []);
const hash = text => createHash("sha256").update(text).digest("hex");
const legacyText = existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : undefined;
const legacy = legacyText ? YAML.parse(legacyText) : { projects: {} };
const projects = new Map();
for (const [id, record] of Object.entries(legacy.projects || {})) {
  if (!record || typeof record !== "object" || typeof record.repo_path !== "string" || !record.repo_path.trim()) throw new Error(`Legacy project ${id} has no repo_path`);
  const repo = resolve(record.repo_path);
  if (projects.has(repo)) throw new Error(`Duplicate legacy repo_path ${repo}: ${projects.get(repo).id} and ${id}`);
  projects.set(repo, { id, record });
}
// Keep authoritative values recursively; only absent fields are inherited.
const mergeMissing = (current, fallback) => {
  if (current === undefined) return fallback;
  if (!current || typeof current !== "object" || Array.isArray(current) || !fallback || typeof fallback !== "object" || Array.isArray(fallback)) return current;
  const result = { ...current };
  for (const [key, value] of Object.entries(fallback)) result[key] = mergeMissing(result[key], value);
  return result;
};
for (const path of extraRepos) if (!projects.has(path)) projects.set(path, { record: {} });
const planned = [];
const ids = new Map();

// Preflight every location before the first write.
for (const [repo, { id: legacyId, record }] of projects) {
  const path = join(repo, ".project.json");
  if (!existsSync(path)) throw new Error(`Missing authoritative manifest: ${path}`);
  const fileStat = lstatSync(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Expected regular manifest: ${path}`);
  const original = readFileSync(path, "utf8");
  const manifest = JSON.parse(original);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Expected a manifest object: ${path}`);
  const id = normalizeProjectId(manifest.project_id ?? manifest.project_slug ?? legacyId);
  if (manifest.project_id && manifest.project_slug && normalizeProjectId(manifest.project_slug) !== id) throw new Error(`Conflicting identities in ${path}`);
  if (ids.has(id) && ids.get(id) !== path) throw new Error(`Duplicate project_id ${id}: ${path} and ${ids.get(id)}`);
  ids.set(id, path);
  const { name, description, slug: _slug, project_id: _id, repo_path: _repo, notebook, ...extensions } = record;
  const fallback = { ...extensions, project_name: name, project_description: description,
    ...(notebook ? { notebook: { binding: notebook } } : {}) };
  // Empty legacy URL placeholders carry no metadata and canonical writers omit them.
  if (fallback.ticket_provider?.board_url === "") {
    fallback.ticket_provider = { ...fallback.ticket_provider };
    delete fallback.ticket_provider.board_url;
  }
  const desired = mergeMissing(manifest, fallback);
  // An explicit agents map is a complete declaration; do not revive removed roles.
  if (manifest.agents !== undefined) desired.agents = manifest.agents;
  desired.project_id = id;
  delete desired.project_slug;
  desired.repo_path = repo;
  const text = `${JSON.stringify(desired, null, 2)}\n`;
  planned.push({ project_id: id, manifest_path: path, changed: text !== original, originalHash: hash(original), mode: fileStat.mode & 0o777, text });
}
const request = async (path, body) => {
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Registry HTTP ${response.status}`);
  return result;
};
if (apply) {
  const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error("Registry health check failed before migration");
  const existingResponse = await fetch(`${endpoint}/v1/registry`, { signal: AbortSignal.timeout(15_000) });
  if (!existingResponse.ok) throw new Error("Cannot inspect registry before migration");
  const existing = await existingResponse.json();
  for (const item of planned) {
    const indexed = existing.__registry_status?.[item.project_id]?.manifest_path
      ?? (existing.projects?.[item.project_id]?.repo_path ? join(existing.projects[item.project_id].repo_path, ".project.json") : undefined);
    if (indexed && resolve(indexed) !== item.manifest_path) throw new Error(`Project ID collision ${item.project_id}: index=${indexed}, manifest=${item.manifest_path}`);
  }
  for (const item of planned) {
    if (hash(readFileSync(item.manifest_path, "utf8")) !== item.originalHash) throw new Error(`Manifest changed during migration: ${item.manifest_path}`);
    if (item.changed) {
      const temporary = `${item.manifest_path}.${process.pid}.tmp`;
      const fd = openSync(temporary, "wx", item.mode);
      try { writeFileSync(fd, item.text); fsyncSync(fd); } finally { closeSync(fd); }
      if (hash(readFileSync(item.manifest_path, "utf8")) !== item.originalHash) throw new Error(`Manifest changed before commit: ${item.manifest_path}`);
      renameSync(temporary, item.manifest_path);
      const directory = openSync(dirname(item.manifest_path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    await request("/v1/index", { manifest_path: item.manifest_path });
  }
  if (legacy.notebook) {
    // The running service may have been edited after the original migration.
    // Re-read immediately before the settings write; a rerun only fills gaps.
    const latestResponse = await fetch(`${endpoint}/v1/registry`, { signal: AbortSignal.timeout(15_000) });
    if (!latestResponse.ok) throw new Error("Cannot inspect current settings before migration");
    const latest = await latestResponse.json();
    const notebook = mergeMissing(latest.notebook, legacy.notebook);
    if (JSON.stringify(notebook) !== JSON.stringify(latest.notebook)) await request("/v1/settings", { notebook });
  }
  // An audit receipt contains locations/hashes only. YAML is no longer a
  // production input; retain the migration source until the caller archives it.
  const receiptPath = resolve(option("--receipt", join(homedir(), ".local/state/pjangler/registry-migration.json")));
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({ migrated_at: new Date().toISOString(), legacy_path: legacyPath,
    legacy_hash: legacyText ? hash(legacyText) : null, endpoint,
    projects: planned.map(({ text, originalHash, mode, ...item }) => ({ ...item, content_hash: hash(text) })) }, null, 2) + "\n");
}
console.log(JSON.stringify({ apply, endpoint, projects: planned.map(({ text, originalHash, mode, ...item }) => item) }, null, 2));
