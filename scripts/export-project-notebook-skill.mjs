#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repoRoot, "dist", "assets", "project-notebook-skill");
// PJAN-84: `.source.yaml` is Skillex's OWN provenance metadata about its
// extracted copy — "extracted_at", "modified_locally" — written by skill_ssot.py
// and rewritten whenever Skillex re-syncs. It described the projection, never the
// skill, and pinning it did two things: it shipped a `modified_locally: false`
// claim to every npm user about a copy PJangler cannot know anything about, and
// it made a Skillex bookkeeping write indistinguishable from a real content
// change, which is the drift class that took `pj init` down. Excluded from both
// sides of the comparison, exactly like the manifest and the checksums.
const generatedNames = new Set(["export-manifest.json", "SHA256SUMS", ".source.yaml"]);
const rawJwt = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/u;
const credentialAssignment = /(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["']([^"'\r\n]{12,})["']/giu;

function canonicalSource() {
  const explicit = process.env.PJ_PROJECT_NOTEBOOK_SKILL_SOURCE || process.env.PJ_PROJECT_NOTEBOOK_SKILL_ROOT;
  const registry = process.env.PJ_SKILLS_REGISTRY_ROOT
    ? join(process.env.PJ_SKILLS_REGISTRY_ROOT, "all-skills", "project-notebook")
    : undefined;
  const selected = explicit || registry;
  if (!selected) return null;
  const source = resolve(selected);
  if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Configured canonical project-notebook skill is unavailable: ${source}`);
  return source;
}

function isSafeCredentialExample(value) {
  return /^(?:test|example|dummy|your|redacted)[-_]/iu.test(value)
    || /^(?:\$[A-Z][A-Z0-9_]*|\$\{[A-Z][A-Z0-9_]*\})$/u.test(value)
    || /^op:\/\//u.test(value)
    || /^\*{3,}$/u.test(value);
}

function validatePath(rel) {
  const normalized = rel.split(sep).join("/");
  const parts = normalized.split("/");
  const leaf = basename(normalized).toLowerCase();
  if (!normalized || normalized.startsWith("/") || parts.includes("..") || normalized.includes("\0")) throw new Error(`Unsafe skill export path: ${rel}`);
  if (parts.some((part) => part === ".git" || part === "node_modules" || part === "__pycache__" || part === ".cache")) throw new Error(`Generated/runtime skill entry is forbidden: ${rel}`);
  if (leaf === ".env" || leaf.startsWith(".env.") || /(?:credential|private[-_]?key|secret)s?\.(?:json|ya?ml|txt)$/u.test(leaf)) throw new Error(`Secret-bearing skill path is forbidden: ${rel}`);
  if (/\.(?:bak(?:-.+)?|orig|pid|sock|log|db-wal|db-shm)$/u.test(leaf) || leaf.endsWith("~")) throw new Error(`Backup/runtime skill entry is forbidden: ${rel}`);
  return normalized;
}

function validateContent(rel, bytes) {
  if (bytes.includes(0)) throw new Error(`Binary skill entry is forbidden: ${rel}`);
  const content = bytes.toString("utf8");
  if (rawJwt.test(content) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) throw new Error(`Secret-shaped content is forbidden in skill export: ${rel}`);
  credentialAssignment.lastIndex = 0;
  for (const match of content.matchAll(credentialAssignment)) {
    if (!isSafeCredentialExample(match[1])) throw new Error(`Literal credential assignment is forbidden in skill export: ${rel}`);
  }
}

function enumerate(directory, { packed = false } = {}) {
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(current, entry.name);
      const rel = relative(directory, path).split(sep).join("/");
      if (!rel.includes("/") && generatedNames.has(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are forbidden in the Project Notebook skill export: ${rel}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const safe = validatePath(rel);
        const bytes = readFileSync(path);
        validateContent(safe, bytes);
        files.push({ path, rel: safe, bytes, mode: (stat.mode & 0o111) ? "0755" : "0644" });
      } else throw new Error(`Non-regular skill entry is forbidden: ${rel}`);
    }
  }
  walk(directory);
  return files.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
}

function verifyPackedExport(directory) {
  const manifestPath = join(directory, "export-manifest.json");
  const sumsPath = join(directory, "SHA256SUMS");
  if (!existsSync(join(directory, "SKILL.md")) || !existsSync(manifestPath) || !existsSync(sumsPath)) throw new Error("Tracked Project Notebook packed export is incomplete");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schema_version !== 1 || manifest?.skill !== "project-notebook" || !Array.isArray(manifest.files)) throw new Error("Tracked Project Notebook export manifest is incompatible");
  const actualFiles = enumerate(directory, { packed: true });
  const expectedPaths = actualFiles.map((file) => file.rel);
  const listedPaths = manifest.files.map((entry) => entry?.path);
  if (new Set(listedPaths).size !== listedPaths.length || JSON.stringify(listedPaths) !== JSON.stringify(expectedPaths)) throw new Error("Tracked Project Notebook export manifest does not exactly enumerate payload files");
  for (let index = 0; index < actualFiles.length; index++) {
    const actual = actualFiles[index];
    const listed = manifest.files[index];
    const digest = createHash("sha256").update(actual.bytes).digest("hex");
    if (!listed || listed.sha256 !== digest || listed.mode !== actual.mode) throw new Error(`Tracked Project Notebook export mismatch: ${actual.rel}`);
  }
  const expectedSums = `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
  if (readFileSync(sumsPath, "utf8") !== expectedSums) throw new Error("Tracked Project Notebook SHA256SUMS is stale");
  return manifest;
}

const source = canonicalSource();
if (!source) {
  verifyPackedExport(target);
  process.stdout.write("project-notebook skill: verified tracked packed export\n");
  process.exit(0);
}
if (resolve(source) === target) throw new Error("Canonical source and packed target must be distinct");
if (relative(resolve(repoRoot, "dist"), target).startsWith(`..${sep}`)) throw new Error("Skill export target escaped dist");

const sourceFiles = enumerate(source);
const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true, mode: 0o755 });
const manifestFiles = [];
try {
  for (const file of sourceFiles) {
    const destination = join(staging, ...file.rel.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(file.path, destination);
    const executable = file.rel.endsWith(".sh") || file.rel.startsWith("scripts/");
    chmodSync(destination, executable ? 0o755 : 0o644);
    manifestFiles.push({ path: file.rel, sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"), mode: executable ? "0755" : "0644" });
  }
  const manifest = { schema_version: 1, skill: "project-notebook", files: manifestFiles };
  writeFileSync(join(staging, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(join(staging, "SHA256SUMS"), `${manifestFiles.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`, { mode: 0o644 });
  verifyPackedExport(staging);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  process.stdout.write(`project-notebook skill: exported ${manifestFiles.length} validated files\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
