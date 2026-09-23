import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import YAML from "yaml";

/**
 * BMAD installer attestation, shared by every rule that may relocate, untrack
 * or delete content a CLI skills root holds.
 *
 * The proof is BMAD's own durable metadata: `_bmad/_config/skill-manifest.csv`
 * maps each projected skill id to its source tree, `files-manifest.csv` records
 * the SHA-256 of every file in that tree. A file under `<cli>/skills/<id>/...`
 * whose bytes hash to the recorded value is installer output, byte for byte;
 * anything else (an extra file, a local edit) is not, and the caller must
 * refuse to treat it as disposable.
 *
 * `bmad.cli-roots` uses it to delete attested unsupported roots (`.agent`,
 * `.qwen`, ...); the CLI skills-root planner uses the same predicate to untrack
 * attested BMAD output it relocates into `.agents/skills`.
 */

function safeReadText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
}


function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}


function csvObjects(text: string): Record<string, string>[] {
  const [headers, ...rows] = parseCsvRows(text);
  if (!headers?.length) return [];
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}


export function installedBmadTools(repoRoot: string): Set<string> {
  const raw = safeReadText(join(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return new Set();
  try {
    const parsed = YAML.parse(raw) as { ides?: unknown } | undefined;
    return new Set(Array.isArray(parsed?.ides) ? parsed.ides.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}


/**
 * Reconstruct the installer-owned CLI inventory from BMAD's own durable
 * metadata. skill-manifest.csv maps a projected skill id to its source tree;
 * files-manifest.csv records the SHA-256 of every file in that tree.
 */
export function bmadCliProjectionInventory(repoRoot: string): { files: Map<string, string>; error?: string } {
  const filesText = safeReadText(join(repoRoot, "_bmad", "_config", "files-manifest.csv"));
  const skillsText = safeReadText(join(repoRoot, "_bmad", "_config", "skill-manifest.csv"));
  if (!filesText || !skillsText) return { files: new Map(), error: "BMAD files/skill manifests are missing" };
  const fileHashes = new Map<string, string>();
  for (const row of csvObjects(filesText)) {
    const hash = row.hash ?? "";
    if (row.path && /^[a-f0-9]{64}$/i.test(hash)) fileHashes.set(row.path.replace(/^_bmad\//, ""), hash.toLowerCase());
  }
  const projected = new Map<string, string>();
  for (const row of csvObjects(skillsText)) {
    const canonicalId = row.canonicalId ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(canonicalId)) continue;
    const skillPath = (row.path ?? "").replace(/^_bmad\//, "");
    if (!skillPath.endsWith("/SKILL.md")) continue;
    const sourceRoot = dirname(skillPath);
    for (const [sourcePath, hash] of fileHashes) {
      if (sourcePath !== `${sourceRoot}/SKILL.md` && !sourcePath.startsWith(`${sourceRoot}/`)) continue;
      const suffix = relative(sourceRoot, sourcePath);
      if (!suffix || suffix.startsWith("..")) continue;
      projected.set(join("skills", canonicalId, suffix), hash);
    }
  }
  return projected.size ? { files: projected } : { files: projected, error: "BMAD manifests contain no projected skill inventory" };
}


export function inventoryFilesUnder(root: string, current = root): { files: string[]; unsafe: string[] } {
  if (!existsSync(current)) return { files: [], unsafe: [] };
  const stat = lstatSync(current);
  const rel = relative(root, current) || ".";
  if (stat.isSymbolicLink()) return { files: [], unsafe: [rel] };
  if (stat.isFile()) return { files: [relative(root, current)], unsafe: [] };
  if (!stat.isDirectory()) return { files: [], unsafe: [rel] };
  const result = { files: [] as string[], unsafe: [] as string[] };
  for (const name of readdirSync(current)) {
    const child = inventoryFilesUnder(root, join(current, name));
    result.files.push(...child.files);
    result.unsafe.push(...child.unsafe);
  }
  return result;
}


export interface BmadAttestation {
  safe: boolean;
  reason: string;
}


/**
 * Are these files, byte for byte, BMAD installer output?
 *
 * `base` is the CLI root that owns the projection (`<repo>/.claude`, `<repo>/.agent`);
 * `files` are paths relative to it (`skills/<id>/SKILL.md`), which is exactly the
 * key space of the reconstructed inventory. `label` prefixes each reason.
 */
export function attestBmadInstallerFiles(
  inventory: { files: Map<string, string>; error?: string },
  base: string,
  files: readonly string[],
  label: string,
): BmadAttestation {
  if (inventory.error) return { safe: false, reason: inventory.error };
  if (!files.length) return { safe: false, reason: `${label} has no installer-owned files` };
  for (const rel of files) {
    const expectedHash = inventory.files.get(rel);
    if (!expectedHash) return { safe: false, reason: `${label}/${rel} is outside the BMAD generated inventory` };
    const actualHash = createHash("sha256").update(readFileSync(join(base, rel))).digest("hex");
    if (actualHash !== expectedHash) return { safe: false, reason: `${label}/${rel} was locally modified after generation` };
  }
  return { safe: true, reason: `${files.length} file(s) match BMAD installer inventory and hashes` };
}
