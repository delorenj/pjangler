import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * Generic Skillex pack validator (PACKS-CONTRACT sections 3, 3b and 4).
 *
 * This module used to hard-code one trusted BMAD release. It is now pack-agnostic:
 * every layout that exists in the registry has to work —
 *
 *   packs/<name>/pack.toml                     flat, unversioned, may declare ZERO skills
 *   packs/<name>/<skill dirs>                  flat, no pack.toml at all
 *   packs/<name>/<version>/pack.toml           versioned
 *   packs/<name>/<version>/ + stray root files stray non-payload files are IGNORED
 *   packs/<name>/<container>/.../<skill dirs>  NESTED, projected FLAT (3b)
 *
 * The nested layout is opt-in (`[policy] flatten` or a manifest `flatten`) and
 * exists because upstream Hermes models the container level as a real, named
 * grouping with its own DESCRIPTION.md, resolved by the depth-agnostic
 * `agent/skill_utils.py::iter_skill_index_files` (see `agent/prompt_builder.py`
 * lines 1670 and 1718). Upstream nests three deep in places, so the expansion
 * here is a DESCENT, not a fixed one-level step. The pack mirrors upstream
 * verbatim; the mismatch with the five container-less CLIs is resolved here, at
 * PROJECTION time, never by rewriting the pack on disk.
 *
 * Everything the hardened BMAD validator did is preserved, just generalized:
 *   * every read goes through O_NOFOLLOW, so a symlink can never be read as a file
 *   * the pack root and every declared skill directory must be a REAL directory
 *   * a pack payload may contain only regular files and real directories
 *   * `SHA256SUMS` paths must be safe relative paths, no duplicates
 *   * a sealed pack may not contain unauthenticated (empty) payload directories
 *   * skill names are exactly one safe path component
 *
 * The one deliberate relaxation, required by contract section 4 rule 3: a
 * `SHA256SUMS` that covers files which are NOT payload (`README.md` is the live
 * example, in `packs/bmad/6.10.1-next.31`) is LEGAL. Those files are still
 * verified — they simply may not be absent. Files that are neither payload nor
 * listed (`.claude/`, `_bmad/`, `mise.toml`, a stray guard script) are ignored.
 */

/** The pack, or a declared member of it, is simply not installed here. */
export class PackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackUnavailableError";
  }
}

/** A normalized `packs[]` manifest entry (contract section 1). */
export interface PackManifestEntry {
  name: string;
  version?: string;
  source?: string;
  registry?: string;
  registryPath?: string;
  include?: string[];
  exclude?: string[];
  optional: boolean;
  /** Manifest-level seal. May only TIGHTEN what `[policy] sealed` declares. */
  sealed: boolean;
  /**
   * Manifest-level `flatten` (contract section 3b). ORs with `[policy] flatten`;
   * layout is a property of the pack, so `pack.toml` is the natural home and this
   * exists for packs that ship no `pack.toml` at all.
   */
  flatten: boolean;
}

/**
 * One projected skill of a pack (contract section 3b).
 *
 * `path` is what makes flattening work end to end: a member is no longer
 * necessarily `<root>/<name>`, so every consumer that needs a filesystem target
 * must take it from here rather than re-deriving it from the name.
 */
export interface PackMember {
  /** Projected skill name — the LEAF directory's basename. */
  name: string;
  /** `/`-separated path relative to the pack root. Equals `name` when flat. */
  path: string;
  /** The DECLARED inventory entry this member came from (`name` when flat). */
  declaredEntry: string;
}

export interface ValidatedPack {
  name: string;
  version?: string;
  root: string;
  /**
   * Raw DECLARED inventory, BEFORE include/exclude and BEFORE section 3b
   * expansion. This — not the flattened inventory — is the sealed payload basis
   * (contract section 4), because declaring a container already covers its
   * leaves recursively.
   */
  declared: string[];
  /** Section 3b inventory (expanded when flattened), BEFORE include/exclude. */
  inventory: PackMember[];
  /** `inventory` names — what a hand-expanded `skills[]` entry would be called. */
  inventoryNames: string[];
  /** Inventory after include then exclude. */
  members: string[];
  /** Member name -> ABSOLUTE leaf directory. The only source of member paths. */
  memberPaths: Map<string, string>;
  /** Section 3b expansion was enabled for this pack. */
  flatten: boolean;
  /** Non-fatal advisories (a container that projects nothing, a skipped symlink). */
  warnings: string[];
  sealed: boolean;
  /** Payload files excluding `pack.toml` itself. */
  payloadFiles: number;
}

export interface PackMetadata {
  name?: string;
  version?: string;
  /** `[freeform].skills`; absent section means an empty inventory, never "glob". */
  skills: string[];
  /** `[policy] sealed = true`. `immutable = true` alone does NOT imply sealed. */
  sealed: boolean;
  /** `[policy] flatten = true` (contract section 3b). */
  flatten: boolean;
  /** `[source].payload_files`, when declared as an integer. */
  payloadFiles?: number;
}

/**
 * The canonical identifier shape the contract mandates for pack and skill names
 * (section 1): lowercase alphanumerics and dashes, no leading or trailing dash.
 */
export const CANONICAL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Canonical pack identifier shape. Enforced as advisory only so packs that
 * predate the convention stay resolvable; the hard requirement — exactly one
 * safe path component — is enforced by `validatePathComponent`.
 */
export const PACK_NAME_PATTERN = CANONICAL_NAME_PATTERN;

// ---------------------------------------------------------------------------
// Filesystem primitives (all symlink-hostile)
// ---------------------------------------------------------------------------

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Read a regular file, refusing to follow a symlink at the final component. */
export function readRegularFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Pack entry is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function hashRegularFile(path: string): string {
  return sha256(readRegularFile(path));
}

export function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A real directory: present, not a symlink, actually a directory. */
export function assertRealDirectory(path: string, label: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PackUnavailableError(`${label} is not present: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return path;
}

/** No component of `relativePath` under `root` may be a symlink. */
export function assertNoSymlinkComponents(root: string, relativePath: string): string {
  let current = root;
  for (const part of relativePath.split("/")) {
    if (!part) continue;
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      throw new PackUnavailableError(`Pack path is not present: ${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked pack path component: ${current}`);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Name / path validation
// ---------------------------------------------------------------------------

/** Exactly one safe path component. */
export function validatePathComponent(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || basename(value) !== value) {
    throw new Error(`${label} must be one path component: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A safe, `/`-separated, strictly relative path with no `.`/`..`/empty segments. */
export function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\\") || value.startsWith("/")) throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// Manifest entry normalization (contract section 1)
// ---------------------------------------------------------------------------

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of skill names`);
  return value.map((item) => validatePathComponent(item, `${label} entry`));
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

/** String shorthand (`"hermes-base"`, `"hermes-base@0.18.2"`) or object form -> validated object. */
export function normalizePackEntry(raw: unknown): PackManifestEntry {
  let source: Record<string, unknown>;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const at = trimmed.indexOf("@");
    source = at >= 0 ? { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) } : { name: trimmed };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    source = raw as Record<string, unknown>;
  } else {
    throw new Error(`Pack entry must be a string or object: ${JSON.stringify(raw)}`);
  }

  const name = validatePathComponent(source.name, "Pack name");
  const entry: PackManifestEntry = {
    name,
    optional: optionalBoolean(source.optional, `Pack ${name} optional`),
    sealed: optionalBoolean(source.sealed, `Pack ${name} sealed`),
    flatten: optionalBoolean(source.flatten, `Pack ${name} flatten`),
  };
  if (source.version !== undefined && source.version !== null) {
    entry.version = validatePathComponent(source.version, `Pack ${name} version`);
  }
  if (source.source !== undefined && source.source !== null) {
    if (typeof source.source !== "string") throw new Error(`Pack ${name} source must be a string`);
    entry.source = source.source;
  }
  if (source.registry !== undefined && source.registry !== null) {
    if (typeof source.registry !== "string") throw new Error(`Pack ${name} registry must be a string`);
    entry.registry = source.registry;
  }
  if (source.registry_path !== undefined && source.registry_path !== null) {
    entry.registryPath = safeRelativePath(source.registry_path, `pack ${name} registry_path`);
  }
  if (entry.source && entry.registryPath) {
    throw new Error(`Pack ${name} may not set both \`source\` and \`registry_path\``);
  }
  entry.include = optionalStringArray(source.include, `Pack ${name} include`);
  entry.exclude = optionalStringArray(source.exclude, `Pack ${name} exclude`);
  return entry;
}

// ---------------------------------------------------------------------------
// Version ordering (contract section 2 step 2)
// ---------------------------------------------------------------------------

type VersionSegment = [number, number, string];

function versionSegments(text: string): VersionSegment[] {
  return text
    .split(/[._]/)
    .filter(Boolean)
    .map((chunk): VersionSegment => (/^\d+$/.test(chunk) ? [0, Number.parseInt(chunk, 10), ""] : [1, 0, chunk]));
}

function compareSegments(a: VersionSegment[], b: VersionSegment[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left) return -1;
    if (!right) return 1;
    if (left[0] !== right[0]) return left[0] - right[0];
    if (left[1] !== right[1]) return left[1] - right[1];
    if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1;
  }
  return 0;
}

/** PEP440/semver-ish ordering: numeric-segment aware, prereleases sort BELOW the release. */
export function compareVersions(a: string, b: string): number {
  const splitAt = (value: string): [string, string, boolean] => {
    const index = value.indexOf("-");
    return index < 0 ? [value, "", false] : [value.slice(0, index), value.slice(index + 1), true];
  };
  const [aRelease, aPre, aHasPre] = splitAt(a);
  const [bRelease, bPre, bHasPre] = splitAt(b);
  const release = compareSegments(versionSegments(aRelease), versionSegments(bRelease));
  if (release !== 0) return release;
  const aRank = aHasPre ? 0 : 1;
  const bRank = bHasPre ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  return compareSegments(versionSegments(aPre), versionSegments(bPre));
}

/**
 * Highest version subdirectory of `packs/<name>/`, or `null` when this is not a
 * pure "only subdirectories" version layout (i.e. it is a flat pack).
 *
 * "Only subdirectories" is necessary but NOT sufficient. A `pack.toml`-less
 * `packs/<name>/` whose children are REAL directories that each hold a regular
 * `SKILL.md` satisfies that test and is emphatically not a version layout — it is
 * a flat pack, and section 3's glob inventory applies instead. The discriminator
 * is what those children ARE: a child holding a regular `SKILL.md` is a skill, so
 * its parent cannot be a version root. Contrast `packs/bmad/`, also `pack.toml`-less
 * and also all real directories, but whose children (e.g. `6.10.1-next.31/`) hold
 * no top-level `SKILL.md` — that IS a version layout.
 *
 * Do not cite a retired BMAD version in this docblock: `bmad-version-surface`
 * regressions scan source for it and will fail the suite.
 *
 * `packs/Kurzgesagt/` is NOT an example of this: its twelve children are all
 * symlinks, so it is disqualified one check earlier by the `isSymbolicLink()` test
 * below and never reaches the `SKILL.md` test. (Earlier revisions of this comment
 * cited it as "twelve skill directories"; that was wrong.)
 */
export function selectPackVersion(packDir: string): string | null {
  const versions: string[] = [];
  for (const name of readdirSync(packDir).sort()) {
    if (name.startsWith(".")) continue;
    const stat = lstatSync(join(packDir, name));
    // A symlink or a stray file means this is not a version-directory layout.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (isRegularFile(join(packDir, name, "SKILL.md"))) return null;
    versions.push(name);
  }
  if (!versions.length) return null;
  return versions.reduce((best, candidate) => (compareVersions(candidate, best) > 0 ? candidate : best));
}

// ---------------------------------------------------------------------------
// Minimal TOML reader
//
// pack.toml is machine-rendered and only a handful of keys are load-bearing, so
// this reads exactly the subset those files use: table headers, quoted/literal
// strings, integers, booleans, and (possibly multi-line) arrays of strings.
// Anything it cannot interpret is retained as an unsupported sentinel rather
// than guessed at. Load-bearing keys such as `[freeform].skills` can therefore
// fail closed instead of silently becoming an empty inventory.
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | string[] | null;

function stripTomlComment(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        out += ch + (line[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quote) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  return depth;
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape: string) => {
    if (escape.startsWith("u")) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "\\": return "\\";
      case '"': return '"';
      default: return escape;
    }
  });
}

function parseTomlStringArray(body: string, label: string): string[] {
  const items: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let remainder = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    remainder += body.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    items.push(match[1] !== undefined ? unescapeBasicString(match[1]) : match[2]!);
  }
  remainder += body.slice(cursor);
  if (/[^\s[\],]/.test(remainder)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return items;
}

function parseTomlScalar(raw: string): TomlValue | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/);
    return match ? unescapeBasicString(match[1]!) : undefined;
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match ? match[1]! : undefined;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?[0-9][0-9_]*$/.test(value)) return Number.parseInt(value.replace(/_/g, ""), 10);
  return undefined;
}

/** Parse the supported TOML subset into `table name -> key -> value`. */
export function parseTomlTables(content: string): Map<string, Map<string, TomlValue>> {
  const tables = new Map<string, Map<string, TomlValue>>();
  const tableFor = (name: string): Map<string, TomlValue> => {
    let table = tables.get(name);
    if (!table) {
      table = new Map<string, TomlValue>();
      tables.set(name, table);
    }
    return table;
  };
  let current = tableFor("");

  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]!).trim();
    if (!line) continue;

    const header = line.match(/^\[\[?\s*([^[\]]+?)\s*\]\]?$/);
    if (header) {
      current = tableFor(header[1]!);
      continue;
    }

    const assignment = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    let key = assignment[1]!;
    if (key.startsWith('"')) key = unescapeBasicString(key.slice(1, -1));
    else if (key.startsWith("'")) key = key.slice(1, -1);
    const raw = assignment[2]!;

    // Multi-line basic/literal strings: skip to the closing delimiter so the
    // lines inside can never be mistaken for further key assignments.
    const multiline = raw.match(/^("""|''')/);
    if (multiline) {
      const delimiter = multiline[1]!;
      if (raw.slice(3).includes(delimiter)) continue;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index]!.includes(delimiter)) break;
      }
      continue;
    }

    if (raw.startsWith("[")) {
      let body = raw;
      let depth = bracketDepth(raw);
      let cursor = index;
      while (depth > 0 && cursor + 1 < lines.length) {
        cursor += 1;
        const chunk = stripTomlComment(lines[cursor]!);
        body += `\n${chunk}`;
        depth += bracketDepth(chunk);
      }
      if (depth > 0) throw new Error(`Unterminated TOML array for key ${JSON.stringify(key)}`);
      index = cursor;
      current.set(key, parseTomlStringArray(body, `${JSON.stringify(key)}`));
      continue;
    }

    const scalar = parseTomlScalar(raw);
    current.set(key, scalar ?? null);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// pack.toml
// ---------------------------------------------------------------------------

/** `null` when the pack has no `pack.toml` at all (a legal, unsealed layout). */
export function readPackMetadata(root: string): PackMetadata | null {
  const path = join(root, "pack.toml");
  const stat = (() => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  })();
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Pack metadata is not a regular file: ${path}`);

  let tables: Map<string, Map<string, TomlValue>>;
  try {
    tables = parseTomlTables(readRegularFile(path).toString("utf8"));
  } catch (error) {
    throw new Error(`Pack metadata at ${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pack = tables.get("pack");
  const freeform = tables.get("freeform");
  const policy = tables.get("policy");
  const sourceTable = tables.get("source");

  const declared = freeform?.get("skills");
  if (declared !== undefined && !Array.isArray(declared)) {
    throw new Error(`Pack metadata at ${path} [freeform].skills must be an array of strings`);
  }
  const payloadFiles = sourceTable?.get("payload_files");
  const name = pack?.get("name");
  const version = pack?.get("version");

  return {
    name: typeof name === "string" ? name : undefined,
    version: typeof version === "string" ? version : undefined,
    skills: Array.isArray(declared) ? [...declared] : [],
    // `immutable = true` alone deliberately does NOT imply sealed.
    sealed: policy?.get("sealed") === true,
    flatten: policy?.get("flatten") === true,
    payloadFiles: typeof payloadFiles === "number" ? payloadFiles : undefined,
  };
}

// ---------------------------------------------------------------------------
// Inventory (contract sections 3 and 3b)
// ---------------------------------------------------------------------------

/** `flatten` is enabled by the pack's `[policy]` OR by the manifest entry. */
export function packFlattenEnabled(
  metadata: PackMetadata | null,
  entry: Pick<PackManifestEntry, "flatten">
): boolean {
  return entry.flatten === true || metadata?.flatten === true;
}

/**
 * Every skill reachable under a CONTAINER, at ANY depth (contract section 3b).
 *
 * The descent rule is the whole of the expansion: descend while a node is a
 * container; a node holding a regular `SKILL.md` IS a skill and is never
 * descended into. That mirrors upstream `agent/skill_utils.py`'s
 * `iter_skill_index_files`, which is a depth-agnostic `os.walk`, and it is why
 * `hermes-base`'s `mlops/evaluation/lm-evaluation-harness` IS a member:
 * `mlops/evaluation` carries only a `DESCRIPTION.md`, so it is another container
 * and the walk continues through it.
 *
 * Stopping at the first `SKILL.md` on each branch is also what keeps a skill's
 * own `references/`/`scripts/`/`assets/`/`templates/` subtree from contributing a
 * second member — the same reason upstream prunes `SKILL_SUPPORT_DIRS` only under
 * a directory that already has a `SKILL.md`.
 *
 * Skip rules match section 3's glob exactly, at every level: `.`/`_` prefixes are
 * ignored, non-directories are ignored, and a symlink is skipped (never followed)
 * and reported. Since symlinks are never followed the descent cannot cycle.
 *
 * `symlinked` entries are reported as `/`-separated paths relative to the
 * container, so a skipped grandchild is still identifiable.
 */
function packContainerLeaves(containerDir: string): {
  /** `/`-separated leaf paths relative to `containerDir`, sorted by walk order. */
  leaves: string[];
  symlinked: string[];
} {
  const leaves: string[] = [];
  const symlinked: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let children: string[];
    try {
      children = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const child of children) {
      if (child.startsWith(".") || child.startsWith("_")) continue;
      const childPath = join(directory, child);
      const relativePath = prefix ? `${prefix}/${child}` : child;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(childPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        symlinked.push(relativePath);
        continue;
      }
      if (!stat.isDirectory()) continue;
      // A symlinked SKILL.md is not a regular file, so the leaf is skipped too.
      if (isRegularFile(join(childPath, "SKILL.md"))) {
        leaves.push(relativePath);
        continue;
      }
      // Still a container: keep descending.
      visit(childPath, relativePath);
    }
  };
  visit(containerDir, "");
  return { leaves, symlinked };
}

/**
 * True when a skill is reachable anywhere under `directory`.
 *
 * The discriminator between "a CONTAINER of skills" and "an ordinary directory
 * that happens to sit in the pack root" (`docs/`, `assets/`, ...). Used on the
 * section 3 GLOB path, where a container has to be recognized without a
 * `pack.toml` to declare it.
 *
 * Written in terms of `packContainerLeaves` so the glob's notion of "container"
 * can never drift from what the expansion actually reaches — a directory that
 * qualifies here always contributes at least one member, and one that does not
 * qualify could never have contributed any.
 */
function hasFlattenableChildren(directory: string): boolean {
  return packContainerLeaves(directory).leaves.length > 0;
}

/**
 * Expand the declared inventory per contract section 3b.
 *
 * With `flatten` off this is the identity map, which is what keeps every
 * existing pack byte-for-byte unchanged: no released `bmad` pack declares
 * `[policy] flatten`, so each takes the early return below and never sees a
 * single new filesystem read.
 *
 * (Do not name a specific BMAD version here: `bmad-version-surface` regressions
 * scan source for retired version literals and will fail the suite.)
 */
export function expandPackInventory(
  root: string,
  declared: string[],
  entry: Pick<PackManifestEntry, "name">,
  flatten: boolean
): { inventory: PackMember[]; warnings: string[] } {
  if (!flatten) {
    return {
      inventory: declared.map((name) => ({ name, path: name, declaredEntry: name })),
      warnings: [],
    };
  }

  const inventory: PackMember[] = [];
  const warnings: string[] = [];
  const origin = new Map<string, string>();
  /**
   * Project one leaf. Returns true when it was actually claimed.
   *
   * `declaredAsIs` marks the one case where the name was NOT lifted off the
   * filesystem: a declared entry that is already a skill keeps the author's
   * string, exactly as it would without flatten. It defaults to false so the
   * canonical gate is the fail-safe direction for any future call site.
   */
  const claim = (member: PackMember, declaredAsIs = false): boolean => {
    if (!declaredAsIs && !CANONICAL_NAME_PATTERN.test(member.name)) {
      // Contract 3b. Flatten is the ONLY place a projected skill name is lifted
      // straight off the filesystem — without it a pack.toml pack projects
      // exactly the strings its author typed into `[freeform].skills`.
      // `validatePathComponent` only asks for one safe path component, which
      // happily admits `-rf`, `--help`, `*`, and names carrying newlines or
      // tabs; those become argv- and glob-hostile symlink names in all six CLI
      // skill directories. Skipped rather than thrown so one odd upstream
      // directory cannot brick a whole pack. JSON.stringify keeps control
      // characters escaped in the warning itself.
      warnings.push(
        `Pack ${entry.name} leaf ${JSON.stringify(member.name)} at ${member.path} is not a canonical skill name (${CANONICAL_NAME_PATTERN.source}); skipping`
      );
      return false;
    }
    validatePathComponent(member.name, `Pack ${entry.name} skill name`);
    const previous = origin.get(member.name);
    if (previous !== undefined) {
      // Ambiguous pack: two leaves would project onto one CLI destination, and
      // which one won would depend on inventory order. Refuse rather than
      // silently pick. (ACROSS packs this is fine — section 5 precedence
      // decides — but within ONE pack there is no rule to apply.)
      throw new Error(
        `Pack ${entry.name} flattens to a duplicate skill name ${JSON.stringify(member.name)}: ${join(root, previous)} and ${join(root, member.path)}`
      );
    }
    origin.set(member.name, member.path);
    inventory.push(member);
    return true;
  };

  for (const declaredEntry of declared) {
    const declaredDir = join(root, declaredEntry);
    // Defence in depth: `packPayload` has already asserted this, but
    // `expandPackInventory` is exported and must be safe standalone.
    assertRealDirectory(declaredDir, `Pack skill ${declaredEntry}`);
    // Entry HAS a regular SKILL.md -> it IS a skill, taken as-is.
    if (isRegularFile(join(declaredDir, "SKILL.md"))) {
      // The name is the author's declared string, not a filesystem basename.
      claim({ name: declaredEntry, path: declaredEntry, declaredEntry }, true);
      continue;
    }
    // Entry has NO SKILL.md -> it is a CONTAINER. Descend it to ANY depth: the
    // walk stops on each branch at the first directory that carries a SKILL.md,
    // so a container of containers (hermes-base's `mlops/`) resolves the same way
    // upstream's depth-agnostic `iter_skill_index_files` does.
    const { leaves, symlinked } = packContainerLeaves(declaredDir);
    // Section 4 is STRICTER than 3b's "skip a symlink with a warning": a symlink
    // anywhere under a DECLARED entry is a payload violation, and `packPayload`
    // has already thrown on it by the time `validatePack` gets here. This arm
    // therefore only ever runs for a direct caller that did not walk the payload
    // first; dropping it would make such a caller silently lose a member.
    for (const child of symlinked) {
      warnings.push(`Pack ${entry.name} member ${declaredEntry}/${child} is a symlink; skipping`);
    }
    let contributed = 0;
    for (const leafPath of leaves) {
      // The NAME is the leaf's basename; the PATH may be any number of segments
      // deep. Nothing downstream may re-derive one from the other.
      if (claim({ name: basename(leafPath), path: `${declaredEntry}/${leafPath}`, declaredEntry })) {
        contributed += 1;
      }
    }
    if (contributed === 0) {
      // A container whose ENTIRE subtree yields no PROJECTABLE skill — either it
      // holds none at all, or every leaf it holds was rejected by the
      // canonical-name gate. Never silently dropped — contract section 3b.
      warnings.push(
        `Pack ${entry.name} declared entry ${JSON.stringify(declaredEntry)} is a container that contributes no skills`
      );
    }
  }
  return { inventory, warnings };
}

export function packDeclaredSkills(
  root: string,
  metadata: PackMetadata | null,
  entry: Pick<PackManifestEntry, "name" | "version">,
  flatten = false
): string[] {
  if (metadata) {
    if (metadata.name !== entry.name) {
      throw new Error(`Pack ${entry.name} pack.toml declares name ${JSON.stringify(metadata.name ?? null)}`);
    }
    if (entry.version && metadata.version !== entry.version) {
      throw new Error(
        `Pack ${entry.name} pack.toml declares version ${JSON.stringify(metadata.version ?? null)}, manifest pins ${JSON.stringify(entry.version)}`
      );
    }
    const declared = metadata.skills.map((name) => validatePathComponent(name, `Pack ${entry.name} skill name`));
    if (new Set(declared).size !== declared.length) {
      throw new Error(`Pack ${entry.name} pack.toml declares duplicate skills`);
    }
    return declared;
  }

  const declared: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const stat = lstatSync(join(root, name));
    // A symlinked child is never a pack member; it is skipped, not followed.
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!isRegularFile(join(root, name, "SKILL.md"))) {
      // A `pack.toml`-less pack has no declared list to expand, so section 3b's
      // container level has to be admitted by the glob itself or the manifest
      // `flatten` flag — which section 3b says exists precisely for packs with
      // no `pack.toml` — could never do anything. A container qualifies on the
      // same descent test section 3b expands it with, so the glob admits exactly
      // the directories that go on to contribute at least one member.
      if (!flatten || !hasFlattenableChildren(join(root, name))) continue;
    }
    declared.push(validatePathComponent(name, `Pack ${entry.name} skill name`));
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Payload + sealed verification (contract section 4)
// ---------------------------------------------------------------------------

function walkPackSubtree(
  root: string,
  relativeRoot: string,
  files: Map<string, string>,
  directories: Set<string>
): void {
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Pack payload may not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        directories.add(key);
        visit(path);
      } else if (stat.isFile()) {
        files.set(key, hashRegularFile(path));
      } else {
        throw new Error(`Pack payload may contain only regular files and directories: ${path}`);
      }
    }
  };
  directories.add(relativeRoot);
  visit(join(root, relativeRoot));
}

/**
 * payload = `pack.toml` + every file recursively under each DECLARED skill dir.
 *
 * UNCHANGED by section 3b: a container is a declared entry, and walking it
 * recursively already covers every leaf underneath it. That is why a flattened
 * pack seals and verifies with no change to section 4 at all.
 *
 * The one thing `flatten` moves is WHERE the `SKILL.md` requirement is enforced.
 * With flatten off, a declared entry must be a skill, so its missing `SKILL.md`
 * is reported here (and, inside a seal, becomes an integrity failure). With
 * flatten on, a declared entry legitimately may be a container, so the
 * requirement moves to `expandPackInventory`, which finds members BY their
 * `SKILL.md`. Declaring a container must never raise `SKILL_MD_MISSING`.
 */
export function packPayload(
  root: string,
  metadata: PackMetadata | null,
  declared: string[],
  flatten = false
): { files: Map<string, string>; directories: Set<string> } {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  if (metadata) files.set("pack.toml", hashRegularFile(join(root, "pack.toml")));
  for (const name of declared) {
    const skillDir = join(root, name);
    assertRealDirectory(skillDir, `Pack skill ${name}`);
    if (!flatten && !isRegularFile(join(skillDir, "SKILL.md"))) {
      throw new PackUnavailableError(`Pack skill ${name} is missing a regular SKILL.md: ${skillDir}`);
    }
    walkPackSubtree(root, name, files, directories);
  }
  return { files, directories };
}

export function parsePackChecksums(root: string): Map<string, string> {
  const raw = readRegularFile(join(root, "SHA256SUMS")).toString("utf8");
  const expected = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS entry in ${root}: ${line}`);
    const path = safeRelativePath(match[2]!, "checksum path");
    if (expected.has(path)) throw new Error(`Duplicate SHA256SUMS entry in ${root}: ${path}`);
    expected.set(path, match[1]!);
  }
  return expected;
}

function verifySealedPack(root: string, files: Map<string, string>, directories: Set<string>): void {
  const expected = parsePackChecksums(root);

  // Rule 2: every payload file is covered, with a matching digest.
  const missing = [...files.keys()].filter((path) => !expected.has(path)).sort();
  if (missing.length) {
    throw new Error(`Pack payload at ${root} is not covered by SHA256SUMS: ${JSON.stringify(missing.slice(0, 5))}`);
  }
  for (const [path, digest] of files) {
    if (expected.get(path) !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }

  // Rule 3: covered-but-not-payload files (README.md, ...) are still verified.
  // They are legal; they simply may not be absent.
  for (const path of [...expected.keys()].sort()) {
    if (files.has(path)) continue;
    const digest = expected.get(path)!;
    let actual: string;
    try {
      assertNoSymlinkComponents(root, path);
      actual = hashRegularFile(join(root, path));
    } catch (error) {
      if (error instanceof PackUnavailableError) {
        throw new Error(`SHA256SUMS at ${root} references a missing path: ${path}`);
      }
      throw error;
    }
    if (actual !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }

  // A payload directory holding no authenticated file is unauthenticated: it is
  // not covered by any checksum, so it could be planted without detection.
  const covered = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) covered.add(parts.slice(0, index).join("/"));
  }
  const unauthenticated = [...directories].filter((directory) => !covered.has(directory)).sort();
  if (unauthenticated.length) {
    throw new Error(
      `Pack at ${root} contains unauthenticated empty directories: ${JSON.stringify(unauthenticated.slice(0, 5))}`
    );
  }
}

/**
 * Validate a pack root against a (normalized) manifest entry.
 *
 * Sealed packs get full checksum verification; unsealed packs get structural
 * validation only — real pack root, parsable pack.toml, every declared skill
 * present with a regular SKILL.md, no symlinks and nothing but regular files
 * inside the payload.
 */
export function validatePack(packRoot: string, entry: PackManifestEntry): ValidatedPack {
  const root = resolve(packRoot);
  assertRealDirectory(root, `Pack ${entry.name} root`);

  const metadata = readPackMetadata(root);
  const flatten = packFlattenEnabled(metadata, entry);
  const declared = packDeclaredSkills(root, metadata, entry, flatten);
  // The manifest may only TIGHTEN: `sealed: false` cannot disable a sealed pack.
  const sealed = entry.sealed === true || metadata?.sealed === true;

  const { files, directories } = packPayload(root, metadata, declared, flatten);
  if (metadata?.payloadFiles !== undefined) {
    const actual = [...files.keys()].filter((path) => path !== "pack.toml").length;
    if (actual !== metadata.payloadFiles) {
      throw new Error(`Pack at ${root} declares ${metadata.payloadFiles} payload files but has ${actual}`);
    }
  }
  if (sealed) {
    if (!isRegularFile(join(root, "SHA256SUMS"))) throw new Error(`Sealed pack at ${root} has no regular SHA256SUMS`);
    verifySealedPack(root, files, directories);
  }

  // Expansion runs AFTER integrity verification so a tampered pack can never be
  // enumerated, and so a flattening error can never mask a digest mismatch.
  const { inventory, warnings } = expandPackInventory(root, declared, entry, flatten);

  // Contract section 3b: include/exclude apply to the FINAL flattened names.
  let members = inventory;
  if (entry.include) {
    const wanted = new Set(entry.include);
    members = members.filter((member) => wanted.has(member.name));
  }
  if (entry.exclude?.length) {
    const unwanted = new Set(entry.exclude);
    members = members.filter((member) => !unwanted.has(member.name));
  }

  const memberPaths = new Map<string, string>();
  for (const member of members) {
    // Every segment was validated as one safe path component on the way in.
    memberPaths.set(member.name, join(root, ...member.path.split("/")));
  }

  return {
    name: entry.name,
    version: entry.version,
    root,
    declared,
    inventory,
    inventoryNames: inventory.map((member) => member.name),
    members: members.map((member) => member.name),
    memberPaths,
    flatten,
    warnings,
    sealed,
    payloadFiles: [...files.keys()].filter((path) => path !== "pack.toml").length,
  };
}
