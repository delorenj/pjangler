import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * Directory names under `_bmad/` that BMAD itself owns. A manifest module
 * entry carrying one of these ids is not a module: the installer resolves a
 * module id to `_bmad/<id>`, so a "deselected" entry named `custom` makes
 * bmad-method's `_removeDeselectedModules` delete `_bmad/custom` (every team
 * override and custom workflow), after which `_installSharedScripts` crashes
 * writing `_bmad/custom/.gitignore` (PJAN-181).
 */
export const BMAD_RESERVED_DIR_NAMES: readonly string[] = ["custom", "scripts", "_config", "_memory", "memory", "render"];

export interface ReservedModuleEviction {
  /** Reserved-name entries dropped (or that would be dropped on a dry run). */
  evicted: string[];
  /** The manifest, when it was (or would be) changed. */
  changedFiles: string[];
  details: string[];
  /** The manifest text before the edit, for callers with no whole-tree backup. */
  original?: string;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlankOrComment = (line: string): boolean => /^\s*(#.*)?$/.test(line);

/** True for a null / absent / empty / "unknown" scalar: no evidence the entry is a real install. */
const isAbsent = (value: unknown, sentinels: string[] = []): boolean =>
  value === undefined || value === null || (typeof value === "string" && (!value.trim() || sentinels.includes(value.trim().toLowerCase())));

/**
 * A manifest module record whose name is a BMAD-owned directory and which has no
 * version or source: a legacy record, never a module anyone selected. `entry` is the parsed
 * YAML item.
 */
export function isLegacyReservedModuleEntry(entry: unknown): boolean {
  // Only the installer's own record shape (a mapping). A bare `- custom` is an operator's hand-written
  // selection (pjan-43 preserves it byte-for-byte), not a legacy install record.
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return typeof record.name === "string" && BMAD_RESERVED_DIR_NAMES.includes(record.name)
    && isAbsent(record.version) && isAbsent(record.source, ["unknown"]);
}

/** Read-only: the manifest text with legacy reserved-name entries removed, or undefined when there are none. */
export function stripReservedModuleEntries(raw: string): { text: string; evicted: string[] } | undefined {
  const lines = raw.split(/(?<=\n)/);
  const key = lines.findIndex((line) => /^modules:\s*(#.*)?\r?\n?$/.test(line));
  if (key < 0) return undefined;
  let first = key + 1;
  while (first < lines.length && isBlankOrComment(lines[first]!)) first++;
  if (first >= lines.length || !/^\s*-(\s|$)/.test(lines[first]!)) return undefined;
  const itemIndent = indentOf(lines[first]!);

  // The block ends at the first content line left of the items (or a sibling key at the item indent).
  let end = first;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent < itemIndent || (indent === itemIndent && !/^\s*-(\s|$)/.test(line))) break;
  }
  // Trailing blanks/comments belong to whatever follows the list, not to its last item.
  while (end > first && isBlankOrComment(lines[end - 1]!)) end--;

  const items: Array<{ start: number; stop: number }> = [];
  for (let index = first; index < end; index++) {
    if (indentOf(lines[index]!) === itemIndent && /^\s*-(\s|$)/.test(lines[index]!) && !isBlankOrComment(lines[index]!)) {
      if (items.length) items[items.length - 1]!.stop = index;
      items.push({ start: index, stop: end });
    }
  }

  const drop = new Set<number>();
  const evicted: string[] = [];
  for (const item of items) {
    let entry: unknown;
    try { entry = (YAML.parse(lines.slice(item.start, item.stop).join("")) as unknown[] | undefined)?.[0]; }
    catch { continue; }
    if (!isLegacyReservedModuleEntry(entry)) continue;
    const name = (entry as Record<string, unknown>).name as string;
    evicted.push(name);
    for (let index = item.start; index < item.stop; index++) drop.add(index);
  }
  if (!evicted.length) return undefined;
  return { text: lines.filter((_, index) => !drop.has(index)).join(""), evicted };
}

/**
 * Drop legacy reserved-name pseudo-module entries from `_bmad/_config/manifest.yaml`
 * before a BMAD update (PJAN-181). A line-level edit: every other byte of the manifest is kept.
 * On a dry run nothing is written. A real run must happen inside the caller's backup window.
 */
export function evictReservedModuleEntries(repoRoot: string, dryRun: boolean): ReservedModuleEviction {
  const manifestPath = join(repoRoot, "_bmad", "_config", "manifest.yaml");
  const none: ReservedModuleEviction = { evicted: [], changedFiles: [], details: [] };
  if (!existsSync(manifestPath)) return none;
  let original: string;
  try { original = readFileSync(manifestPath, "utf8"); } catch { return none; }
  const stripped = stripReservedModuleEntries(original);
  if (!stripped) return none;
  const names = stripped.evicted.map((name) => `"${name}"`).join(", ");
  if (!dryRun) writeFileSync(manifestPath, stripped.text, "utf8");
  return {
    evicted: stripped.evicted,
    changedFiles: [manifestPath],
    original,
    details: [
      `${dryRun ? "would remove" : "removed"} legacy manifest module ${names} (no version or source) from _bmad/_config/manifest.yaml; ` +
        `the installer would otherwise delete ${[...new Set(stripped.evicted)].map((name) => `_bmad/${name}`).join(", ")}`,
    ],
  };
}
