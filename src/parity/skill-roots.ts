import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SUPPORTED_CLIS } from "../recipes/supported-clis";
import { attestBmadInstallerFiles, bmadCliProjectionInventory } from "./bmad-attestation";

/**
 * PJAN-135: turn every supported CLI skills root into the alias skillex requires.
 *
 * skillex refuses (E_ACTIVATION_CONFLICT) any `<cli>/skills` that does not reach
 * `<repo>/.agents/skills`, and it refuses the whole plan at the first one, so a
 * real `.claude/skills` full of BMAD installer output blocks every project that
 * has one. `skillex migrate` cannot relocate installer directories by design.
 * This module is the relocation, and it is LOSSLESS by construction:
 *
 * STRUCTURE. The activation root R must be exactly `realpath(repo)/.agents/skills`
 * with no symlink in `.agents` or `.agents/skills`; every CLI root (`.claude`, ...)
 * must be a real directory of this repository's own git work tree. A CLI skills
 * root that is its own repository or a submodule, or an entry holding a `.git`,
 * belongs to someone else and is never touched.
 *
 * ONE PLAN, AGAINST THE FINAL LAYOUT. Every root is planned whole, together, from
 * the filesystem as it is, and the plan is then checked against a model of the
 * layout it would produce: every name visible through `.agents/skills` or any
 * CLI alias before must be visible after, through the same path, with identical
 * content (entry types, bytes, executable bits, nested link texts; a nested
 * relative link may only climb out of its entry if the entry stays where it
 * is). A root whose conversion fails that check, or has ANY blocked entry, gets
 * no operation at all. Audit, dry run and apply all use this one plan, so a dry
 * run reports exactly what apply does.
 *
 * NOTHING IS DELETED WHILE IT MATTERS. Real entries move with rename(2) (inode,
 * bytes, modes, timestamps preserved; a cross-device move blocks). A proven
 * duplicate, a dangling link, an emptied alias directory or a replaced stub is
 * renamed into `.agents/.pjangler-quarantine/<run>/items`, never removed. The run
 * writes `journal.json` (every step) and `restore.sh` (the exact reversal) before
 * its first step and logs each completed step. After the last step every
 * visible name is re-derived FROM DISK and compared with what it showed before;
 * only then is tracked BMAD output untracked and the quarantine purged. Any
 * failure or mismatch reverses the journal and leaves the repository as it was.
 * A quarantine left by an interrupted run blocks every later plan and names its
 * restore command.
 *
 * WHAT COUNTS AS A DUPLICATE. A link resolving to the same place as the
 * `.agents/skills` counterpart; a real entry every part of which (type, bytes,
 * executable bits, link texts) already exists in the counterpart; a real
 * counterpart directory every part of which exists in the entry that replaces
 * it. A counterpart that resolves (at any hop) into a CLI skills root being
 * converted, or into the entry itself, is never a duplicate.
 *
 * TRACKED CONTENT. An entry holding git-tracked paths moves or drops only when
 * every tracked path is a regular file attested as BMAD installer output (the
 * manifest-hash proof `bmad.cli-roots` uses), and is then untracked (generated
 * output is never tracked). A tracked symlink or gitlink cannot be attested and
 * blocks.
 *
 * An alias link that already reaches `.agents/skills`, in any spelling (skillex
 * migrate writes an absolute one and records it in its receipt), is left alone.
 */

/** The alias text pjangler writes for a CLI skills root it creates or converts. */
export const CANONICAL_CLI_SKILLS_ALIAS = "../.agents/skills";

/** The six project aliases skillex checks, in CLI policy order. */
export const SUPPORTED_SKILLS_ALIASES: readonly string[] = SUPPORTED_CLIS.map((cli) => cli.skillsRoot);

/** `.agents/<this>`: where a run parks everything it would otherwise remove. */
export const SKILL_ROOTS_QUARANTINE = ".pjangler-quarantine";

export type SkillRootOperationKind =
  | "create-root"
  | "create-cli-root"
  | "create-alias"
  | "replace-dangling-alias"
  | "untrack"
  | "drop-dangling-link"
  | "drop-duplicate-link"
  | "move-link"
  | "recreate-link"
  | "move-entry"
  | "drop-duplicate-entry"
  | "replace-subset-counterpart"
  | "convert-alias";

export interface SkillRootOperation {
  kind: SkillRootOperationKind;
  /** The CLI alias this operation belongs to (absent for create-root). */
  alias?: string;
  /** The path this operation writes or removes. For moves, the destination. */
  path: string;
  /** Move/recreate source (an entry of the alias directory). */
  from?: string;
  /** Link text written by this operation. */
  target?: string;
  /** drop-duplicate-entry: the copy that contains `path`. replace-subset-counterpart: the stub parked first. */
  counterpart?: string;
  /** For untrack: repository-relative paths removed from the index. */
  tracked?: string[];
  detail: string;
}

export type SkillAliasState = "alias" | "absent" | "dangling" | "foreign-link" | "real-directory" | "unsupported";

export interface SkillAliasPlan {
  alias: string;
  path: string;
  state: SkillAliasState;
  /** Empty whenever `blocks` is not: a blocked root is left untouched. */
  operations: SkillRootOperation[];
  blocks: string[];
  /** One human line describing what the alias holds and what would happen. */
  summary: string;
}

/** A name that gains a new occupant in `.agents/skills` (for sync previews). */
export interface SkillRootIncoming {
  name: string;
  /** `.agents/skills/<name>` */
  path: string;
  /** The alias entry that becomes it. */
  from: string;
  kind: "directory" | "file" | "link";
  /** A link's text once it is in place. */
  text?: string;
  /** Where the new occupant resolves, as a path that exists on disk now; undefined if it would dangle. */
  resolves?: string;
}

export interface SkillRootsPlan {
  repoRoot: string;
  root: string;
  /** "unsafe": `.agents` itself is a symlink or not a directory. */
  rootState: "directory" | "absent" | "symlink" | "other" | "unsafe";
  aliases: SkillAliasPlan[];
  /** Execution order. */
  operations: SkillRootOperation[];
  blocks: string[];
  clean: boolean;
  incoming: SkillRootIncoming[];
}

export interface SkillRootsResult {
  /** Every alias ended clean: nothing blocked and nothing failed. */
  ok: boolean;
  changedFiles: string[];
  details: string[];
  blocks: string[];
  plan: SkillRootsPlan;
}

export interface SkillRootsOptions {
  /** Restrict to these relative aliases (default: all six). */
  aliases?: readonly string[];
}

export interface SkillRootsApplyOptions extends SkillRootsOptions {
  dryRun: boolean;
  /** Test seam: runs after the last step and before the on-disk verification. */
  hooks?: { beforeVerify?: () => void };
}

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") return undefined;
    throw error;
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function within(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

/** Physical git toplevel for a directory, or undefined outside any work tree. */
export function gitToplevel(directory: string): string | undefined {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const top = result.stdout.trim();
  return top ? realpathOrUndefined(top) ?? top : undefined;
}

/**
 * Is `path` repository-owned content of `repoRoot`?
 *
 * Under the repository directory AND in the same git work tree. A path inside a
 * nested repository or submodule (33GOD's component checkouts) belongs to that
 * other repository, not this one.
 */
export function repoOwnsPath(repoRoot: string, path: string): boolean {
  const repoReal = realpathOrUndefined(repoRoot) ?? resolve(repoRoot);
  const real = realpathOrUndefined(path);
  if (!real || !within(real, repoReal)) return false;
  let directory = real;
  try {
    if (!statSync(real).isDirectory()) directory = dirname(real);
  } catch {
    directory = dirname(real);
  }
  return gitToplevel(directory) === gitToplevel(repoReal);
}

// ---------------------------------------------------------------------------
// Layouts: the disk as it is, and the layout a plan would produce
// ---------------------------------------------------------------------------

interface LayoutEntry {
  kind: "dir" | "file" | "link" | "special";
  text?: string;
  stat?: Stats;
  /** Where this entry physically is on disk now. */
  phys?: string;
}

interface Layout {
  /** `path` is absolute and its parent components are already resolved in this layout. */
  lstat(path: string): LayoutEntry | undefined;
  readdir(path: string): string[];
}

function entryOf(path: string, stat: Stats): LayoutEntry {
  if (stat.isSymbolicLink()) return { kind: "link", text: readlinkSync(path), stat, phys: path };
  if (stat.isDirectory()) return { kind: "dir", stat, phys: path };
  if (stat.isFile()) return { kind: "file", stat, phys: path };
  return { kind: "special", stat, phys: path };
}

const diskLayout: Layout = {
  lstat(path) {
    const stat = lstatOrUndefined(path);
    return stat ? entryOf(path, stat) : undefined;
  },
  readdir(path) {
    return readdirSync(path);
  },
};

type Incoming = { kind: "move"; from: string } | { kind: "link"; text: string };

interface FinalSpec {
  root: string;
  /** Paths that become symlinks with this text (aliases). */
  links: Map<string, string>;
  /** Directories that are created. */
  dirs: Set<string>;
  /** New occupants of `root/<name>`. */
  incoming: Map<string, Incoming>;
}

/** The layout after a plan: the disk, overlaid with the plan's links, moves and new directories. */
function finalLayout(spec: FinalSpec): Layout {
  const underIncoming = (path: string): { mapped?: string; link?: string } | undefined => {
    if (!within(path, spec.root) || path === spec.root) return undefined;
    const [name, ...rest] = relative(spec.root, path).split(sep);
    const occupant = spec.incoming.get(name!);
    if (!occupant) return undefined;
    if (occupant.kind === "move") return { mapped: join(occupant.from, ...rest) };
    return rest.length ? undefined : { link: occupant.text };
  };
  return {
    lstat(path) {
      const link = spec.links.get(path);
      if (link !== undefined) return { kind: "link", text: link };
      const mapping = underIncoming(path);
      if (mapping?.link !== undefined) return { kind: "link", text: mapping.link };
      if (mapping?.mapped) return diskLayout.lstat(mapping.mapped);
      if (spec.dirs.has(path) && !lstatOrUndefined(path)) return { kind: "dir" };
      return diskLayout.lstat(path);
    },
    readdir(path) {
      const mapping = underIncoming(path);
      if (mapping?.mapped) return readdirSync(mapping.mapped);
      const names = new Set(lstatOrUndefined(path)?.isDirectory() ? readdirSync(path) : []);
      if (path === spec.root) for (const name of spec.incoming.keys()) names.add(name);
      for (const created of [...spec.links.keys(), ...spec.dirs]) if (dirname(created) === path) names.add(basename(created));
      return [...names].sort();
    },
  };
}

interface Resolution {
  /** The resolved path in the layout. */
  real: string;
  /** Every symlink location traversed, in order. */
  hops: string[];
}

/** realpath(3) against a layout; undefined for a dangling path or a loop. */
function resolveIn(layout: Layout, path: string): Resolution | undefined {
  const hops: string[] = [];
  let pending = path.split("/");
  let current = "/";
  let followed = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    const entry = layout.lstat(next);
    if (!entry) return undefined;
    if (entry.kind === "link") {
      if (++followed > 40) return undefined;
      hops.push(next);
      const text = entry.text ?? "";
      pending = [...text.split("/"), ...pending];
      if (text.startsWith("/")) current = "/";
      continue;
    }
    if (entry.kind !== "dir" && pending.some(Boolean)) return undefined;
    current = next;
  }
  return { real: current, hops };
}

// ---------------------------------------------------------------------------
// Views: what a path shows, and whether one view contains another
// ---------------------------------------------------------------------------

type ViewNode =
  | { t: "file"; dev: number; ino: number; size: number; mtimeMs: number; mode: number; phys: string }
  | { t: "dir"; children: Map<string, ViewNode> }
  | { t: "link"; text: string; escapes: boolean }
  | { t: "special" };

interface View {
  /** Where the path resolves in its layout. */
  real: string;
  hops: string[];
  /** The walked tree; undefined for content outside every area a plan changes (untouched by construction). */
  node?: ViewNode;
}

function walkNode(layout: Layout, path: string, root: string): ViewNode {
  const entry = layout.lstat(path);
  if (!entry) return { t: "special" };
  if (entry.kind === "link") {
    const text = entry.text ?? "";
    return { t: "link", text, escapes: !isAbsolute(text) && !within(resolve(dirname(path), text), root) };
  }
  if (entry.kind === "file") {
    const stat = entry.stat!;
    return { t: "file", dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, phys: entry.phys! };
  }
  if (entry.kind === "dir") {
    const children = new Map<string, ViewNode>();
    for (const name of layout.readdir(path).sort()) children.set(name, walkNode(layout, join(path, name), root));
    return { t: "dir", children };
  }
  return { t: "special" };
}

function viewIn(layout: Layout, path: string, affected: (real: string) => boolean): View | undefined {
  const resolution = resolveIn(layout, path);
  if (!resolution) return undefined;
  return { ...resolution, node: affected(resolution.real) ? walkNode(layout, resolution.real, resolution.real) : undefined };
}

/** File bytes by physical identity; the "before" side may be read from where a completed step moved it. */
class Hasher {
  private readonly cache = new Map<string, string | undefined>();
  constructor(private readonly translate: (path: string) => string = (path) => path) {}
  of(node: Extract<ViewNode, { t: "file" }>, before: boolean): string | undefined {
    const key = `${node.dev}:${node.ino}:${node.size}:${node.mtimeMs}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const path = before ? this.translate(node.phys) : node.phys;
    const stat = lstatOrUndefined(path);
    const digest = stat && stat.ino === node.ino && stat.dev === node.dev
      ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined;
    this.cache.set(key, digest);
    return digest;
  }
}

function modeText(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function nodeGap(before: ViewNode, after: ViewNode, label: string, sameLocation: boolean, hasher: Hasher): string | undefined {
  const at = label || ".";
  if (before.t === "file") {
    if (after.t !== "file") return `${at} is no longer a file`;
    if ((before.mode & 0o7111) !== (after.mode & 0o7111)) return `${at} mode differs (${modeText(before.mode)} before, ${modeText(after.mode)} after)`;
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs) return undefined;
    if (before.size !== after.size) return `${at} content differs`;
    const left = hasher.of(before, true), right = hasher.of(after, false);
    if (left === undefined || right === undefined) return `${at} could not be read back`;
    return left === right ? undefined : `${at} content differs`;
  }
  if (before.t === "link") {
    if (after.t !== "link") return `${at} is a symlink but the counterpart is not`;
    if (before.text !== after.text) return `${at} link text differs`;
    if (before.escapes && !sameLocation) return `${at} -> ${before.text} leaves its entry, so what it resolves to depends on where the entry is`;
    return undefined;
  }
  if (before.t === "dir") {
    if (after.t !== "dir") return `${at} is a directory but the counterpart is not`;
    for (const [name, child] of before.children) {
      const counterpart = after.children.get(name);
      const childLabel = label ? `${label}/${name}` : name;
      if (!counterpart) return `${childLabel} is missing from the counterpart`;
      const gap = nodeGap(child, counterpart, childLabel, sameLocation, hasher);
      if (gap) return gap;
    }
    return undefined;
  }
  return `${at} is a special file`;
}

/**
 * The first reason `after` does not show everything `before` shows, identically.
 * `anyLocation` compares link texts only (a parked copy is never resolved again).
 */
function viewGap(before: View, after: View | undefined, hasher: Hasher, anyLocation = false): string | undefined {
  if (!after) return "no longer resolves";
  if (!before.node && !after.node && before.real === after.real) return undefined;
  const left = before.node ?? walkNode(diskLayout, before.real, before.real);
  const right = after.node ?? walkNode(diskLayout, after.real, after.real);
  return nodeGap(left, right, "", anyLocation || before.real === after.real, hasher);
}

/**
 * The first reason `candidate` is NOT wholly contained in `reference`, or
 * undefined when every entry of candidate exists in reference with identical
 * type, bytes, executable bits and symlink text. Both are followed if they are
 * links. A nested relative link that climbs out of its tree only matches when
 * both paths are the same tree.
 */
export function treeContainmentGap(candidate: string, reference: string): string | undefined {
  const all = () => true;
  const left = viewIn(diskLayout, candidate, all);
  const right = viewIn(diskLayout, reference, all);
  if (!right) return "the counterpart is missing or a dangling link";
  if (!left) return "the candidate is missing or a dangling link";
  return viewGap(left, right, new Hasher());
}

/** Same relative paths, same file bytes and executable bits, same symlink texts, in both directions. */
export function treesIdentical(left: string, right: string): boolean {
  return treeContainmentGap(left, right) === undefined && treeContainmentGap(right, left) === undefined;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface Candidate {
  alias: string;
  name: string;
  /** Physical entry path (the alias directory is real, so this is real too). */
  path: string;
  label: string;
  kind: "link" | "directory" | "file";
  text?: string;
  resolution?: Resolution;
  view?: View;
  tracked: string[];
  staticBlock?: string;
}

interface AliasInfo {
  alias: string;
  /** Lexical path under the caller's repoRoot. */
  path: string;
  /** Physical path. */
  real: string;
  cliRoot: string;
  cliName: string;
  state: SkillAliasState;
  cliRootExists: boolean;
  text?: string;
  blocks: string[];
  candidates: Candidate[];
}

interface NameDecision {
  alias: string;
  name: string;
  operation: SkillRootOperation;
}

interface PlanInternals {
  repoReal: string;
  R: string;
  agentsExisted: boolean;
  /** Everything visible before: view path (physical alias spelling) -> view. */
  before: Map<string, View>;
  /** Paths whose content the before views may depend on. */
  affected: (real: string) => boolean;
  converted: string[];
  created: string[];
}

const internals = new WeakMap<SkillRootsPlan, PlanInternals>();

function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function describeQuarantine(quarantine: string, label: (path: string) => string): string[] {
  let runs: string[];
  try { runs = readdirSync(quarantine).sort(); } catch { return [`${label(quarantine)} exists but cannot be read; inspect it before converting any CLI skills root`]; }
  if (!runs.length) return [`${label(quarantine)} is an empty leftover of an earlier conversion; remove it: rmdir ${shellQuote(quarantine)}`];
  return runs.map((run) => {
    const path = join(quarantine, run);
    let progress = "";
    try { progress = readFileSync(join(path, "progress.log"), "utf8"); } catch { /* no log: never started */ }
    if (/^committed$/m.test(progress)) {
      return `an earlier conversion completed and was verified, but its quarantine of proven duplicates remains at ${label(path)}; remove it: rm -rf ${shellQuote(path)}`;
    }
    return `an interrupted CLI skills-root conversion left ${label(path)}; restore the repository exactly with: sh ${shellQuote(join(path, "restore.sh"))} (it reverses every completed step listed in journal.json, then removes the quarantine)`;
  });
}

interface TrackedRow { mode: string; path: string }

function indexRows(repoReal: string, rel: string): { rows: TrackedRow[]; error?: string; worktree: boolean } {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoReal, encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return { rows: [], worktree: false };
  const listed = spawnSync("git", ["ls-files", "-s", "-z", "--", rel], { cwd: repoReal, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) return { rows: [], worktree: true, error: `git ls-files failed for ${rel}: ${listed.stderr.trim()}` };
  const rows = listed.stdout.split("\0").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t");
    return { mode: meta!.split(" ")[0]!, path: path! };
  });
  return { rows, worktree: true };
}

/** Why a real entry can never be moved or dropped, whatever its counterpart. */
function entryHazard(path: string, label: string): string | undefined {
  const walk = (current: string, rel: string): string | undefined => {
    const stat = lstatSync(current);
    if (rel && basename(current) === ".git") return `${label} contains a nested git repository (${rel}); refusing to move or drop another repository's work tree`;
    if (stat.isSymbolicLink()) {
      const text = readlinkSync(current);
      if (!isAbsolute(text) && !within(resolve(dirname(current), text), path)) {
        return `${label}/${rel} -> ${text} leaves the entry; moving or dropping it would change what that link resolves to`;
      }
      return undefined;
    }
    if (stat.isFile()) return undefined;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        const found = walk(join(current, name), rel ? `${rel}/${name}` : name);
        if (found) return found;
      }
      return undefined;
    }
    return `${label}${rel ? `/${rel}` : ""} is a special file; refusing to relocate it`;
  };
  return walk(path, "");
}

export function planSkillRoots(repoRoot: string, options: SkillRootsOptions = {}): SkillRootsPlan {
  const selected = options.aliases ?? SUPPORTED_SKILLS_ALIASES;
  const lexicalRoot = join(repoRoot, ".agents", "skills");
  const repoReal = realpathOrUndefined(repoRoot);
  const empty = (rootState: SkillRootsPlan["rootState"], reason: string): SkillRootsPlan => {
    const aliases = selected.map((alias): SkillAliasPlan => ({ alias, path: join(repoRoot, alias), state: "unsupported", operations: [], blocks: [reason], summary: `${alias}: blocked (${reason})` }));
    return { repoRoot, root: lexicalRoot, rootState, aliases, operations: [], blocks: [reason], clean: false, incoming: [] };
  };
  if (!repoReal) return empty("unsafe", `${repoRoot} does not resolve; refusing to plan any CLI skills root`);
  const lex = (path: string): string => (within(path, repoReal) ? join(repoRoot, relative(repoReal, path)) : path);
  const rel = (path: string): string => relative(repoReal, path) || ".";
  const agents = join(repoReal, ".agents");
  const R = join(agents, "skills");
  const agentsStat = lstatOrUndefined(agents);
  if (agentsStat && (agentsStat.isSymbolicLink() || !agentsStat.isDirectory())) {
    const what = agentsStat.isSymbolicLink() ? `a symlink (to ${readlinkSync(agents)})` : "not a directory";
    return empty("unsafe", `.agents is ${what}; the activation root must be a real .agents/skills directory inside the repository, so no CLI skills root is planned`);
  }
  const rootStat = agentsStat ? lstatOrUndefined(R) : undefined;
  const rootState: SkillRootsPlan["rootState"] = !rootStat ? "absent"
    : rootStat.isSymbolicLink() ? "symlink" : rootStat.isDirectory() ? "directory" : "other";
  const quarantine = join(agents, SKILL_ROOTS_QUARANTINE);
  if (lstatOrUndefined(quarantine)) {
    const reasons = describeQuarantine(quarantine, (path) => rel(path));
    const plan = empty(rootState, reasons[0]!);
    plan.blocks = reasons;
    for (const alias of plan.aliases) alias.blocks = reasons;
    return plan;
  }
  const rootReal = rootState === "absent" ? undefined : realpathOrUndefined(R);
  const deviceOf = (path: string): number | undefined => { try { return statSync(path).dev; } catch { return undefined; } };
  const rootDevice = deviceOf(agentsStat ? agents : repoReal);
  const repoTop = gitToplevel(repoReal);
  let inventory: ReturnType<typeof bmadCliProjectionInventory> | undefined;
  const inventoryOf = () => (inventory ??= bmadCliProjectionInventory(repoReal));

  // Every supported alias that is a real directory now (selected or not): a
  // counterpart or link resolving into one of them is never an independent copy.
  const realAliasDirs = SUPPORTED_SKILLS_ALIASES.map((alias) => join(repoReal, alias)).filter((path) => {
    const stat = lstatOrUndefined(path);
    return Boolean(stat?.isDirectory() && !stat.isSymbolicLink() && !lstatOrUndefined(dirname(path))?.isSymbolicLink());
  });

  // ----- Per-alias classification (static: independent of every other alias)
  const infos: AliasInfo[] = selected.map((alias) => {
    const real = join(repoReal, alias);
    const cliRoot = dirname(real);
    const cliName = rel(cliRoot);
    const info: AliasInfo = { alias, path: join(repoRoot, alias), real, cliRoot, cliName, state: "unsupported", cliRootExists: false, blocks: [], candidates: [] };
    if (rootState === "other") { info.blocks.push(`.agents/skills is not a directory; refusing to plan ${alias}`); return info; }
    const cliStat = lstatOrUndefined(cliRoot);
    info.cliRootExists = Boolean(cliStat);
    if (cliStat && (cliStat.isSymbolicLink() || !cliStat.isDirectory())) { info.blocks.push(`${cliName} is not a real configuration directory`); return info; }
    if (cliStat) {
      const top = gitToplevel(cliRoot);
      if (top !== repoTop) { info.blocks.push(`${cliName} is inside another git work tree (${top}); refusing to change it`); return info; }
    }
    const stat = cliStat ? lstatOrUndefined(real) : undefined;
    if (!stat) { info.state = "absent"; return info; }
    if (stat.isSymbolicLink()) {
      const text = readlinkSync(real);
      info.text = text;
      const reached = realpathOrUndefined(real);
      if ((rootReal !== undefined && reached === rootReal) || (rootState === "absent" && resolve(cliRoot, text) === R)) { info.state = "alias"; return info; }
      if (!reached) { info.state = "dangling"; return info; }
      info.state = "foreign-link";
      info.blocks.push(`${alias} is a symlink to ${text} (resolves to ${reached}), not .agents/skills; refusing to replace it`);
      return info;
    }
    if (!stat.isDirectory()) { info.blocks.push(`${alias} is neither a directory nor a symlink`); return info; }
    info.state = "real-directory";
    if (rootState === "symlink") { info.blocks.push(`${alias} is a real directory but .agents/skills is a symlink (pack activation); refusing to relocate its entries`); return info; }
    if (rootDevice !== undefined && stat.dev !== rootDevice) { info.blocks.push(`${alias} is on a different filesystem than .agents; refusing a copying move`); return info; }
    const aliasTop = gitToplevel(real);
    if (aliasTop !== repoTop) { info.blocks.push(`${alias} is inside another git work tree (${aliasTop}): its own git repository or a submodule; refusing to relocate it`); return info; }
    const index = indexRows(repoReal, cliName);
    if (index.error) { info.blocks.push(index.error); return info; }
    const aliasRel = rel(real).split(sep).join("/");
    if (index.rows.some((row) => row.mode === "160000" && (row.path === aliasRel || row.path === cliName.split(sep).join("/")))) {
      info.blocks.push(`${alias} is a git submodule (a gitlink in the index); refusing to relocate it`);
      return info;
    }
    const tracked = new Map<string, TrackedRow[]>();
    for (const row of index.rows) {
      if (!row.path.startsWith(`${aliasRel}/`)) continue;
      const name = row.path.slice(aliasRel.length + 1).split("/")[0]!;
      tracked.set(name, [...(tracked.get(name) ?? []), row]);
    }
    for (const name of readdirSync(real).sort()) {
      const path = join(real, name);
      const label = `${alias}/${name}`;
      const entryStat = lstatSync(path);
      const rows = tracked.get(name) ?? [];
      const candidate: Candidate = { alias, name, path, label, kind: entryStat.isSymbolicLink() ? "link" : entryStat.isDirectory() ? "directory" : "file", tracked: rows.map((row) => row.path) };
      if (name === ".git") {
        candidate.staticBlock = `${label} is git metadata; refusing to relocate another repository's work tree`;
      } else if (entryStat.isSymbolicLink()) {
        candidate.text = readlinkSync(path);
        candidate.resolution = resolveIn(diskLayout, path);
        if (rows.length) candidate.staticBlock = `${label} -> ${candidate.text} is tracked in git; a tracked link cannot be attested BMAD installer output, so it is never untracked, moved or dropped`;
      } else if (!entryStat.isDirectory() && !entryStat.isFile()) {
        candidate.staticBlock = `${label} is a special file; refusing to relocate it`;
      } else {
        candidate.staticBlock = entryHazard(path, label);
        if (!candidate.staticBlock && rootDevice !== undefined && entryStat.dev !== rootDevice) candidate.staticBlock = `${label} is on a different filesystem than .agents/skills; refusing a copying move`;
        const linkRow = rows.find((row) => row.mode === "120000");
        const gitlink = rows.find((row) => row.mode === "160000");
        if (!candidate.staticBlock && gitlink) candidate.staticBlock = `${label} holds a tracked submodule (${gitlink.path}); refusing to relocate it`;
        if (!candidate.staticBlock && linkRow) candidate.staticBlock = `${label} holds a tracked symlink (${linkRow.path}); a tracked link cannot be attested BMAD installer output`;
        if (!candidate.staticBlock && rows.length) {
          const paths = rows.map((row) => row.path);
          const missing = paths.filter((path) => !lstatOrUndefined(join(repoReal, path)));
          if (missing.length) candidate.staticBlock = `${label} has tracked path(s) missing from the work tree (${missing[0]}); restore or commit the deletion first`;
          else {
            const verdict = attestBmadInstallerFiles(inventoryOf(), cliRoot, paths.map((path) => relative(cliRoot, join(repoReal, path))), cliName);
            if (!verdict.safe) candidate.staticBlock = `${label} is tracked in git and not attested BMAD installer output: ${verdict.reason}`;
          }
        }
      }
      info.candidates.push(candidate);
    }
    info.blocks.push(...info.candidates.flatMap((candidate) => candidate.staticBlock ? [candidate.staticBlock] : []));
    return info;
  });

  // Everything a conversion could change the view of.
  const affected = (real: string): boolean => within(real, R) || realAliasDirs.some((dir) => within(real, dir));
  const viewCache = new Map<string, View | undefined>();
  const beforeView = (path: string): View | undefined => {
    if (!viewCache.has(path)) viewCache.set(path, viewIn(diskLayout, path, affected));
    return viewCache.get(path);
  };
  const hasher = new Hasher();
  const firstHazard = (resolution: Resolution, dirs: readonly string[], exclude?: string): string | undefined =>
    [...resolution.hops, resolution.real].find((path) => path !== exclude && dirs.some((dir) => within(path, dir)));

  // ----- Whole-plan decisions: a fixed point over the set of convertible aliases
  const blocked = new Map<string, string[]>();
  for (const info of infos) if (info.blocks.length) blocked.set(info.alias, [...info.blocks]);
  let decisions: NameDecision[] = [];
  let spec: FinalSpec | undefined;
  const incomingByName = new Map<string, { alias: string; from: string; kind: SkillRootIncoming["kind"]; incoming: Incoming }>();
  for (let round = 0; round <= infos.length + 1; round++) {
    const active = infos.filter((info) => info.state === "real-directory" && !blocked.has(info.alias));
    const activeDirs = active.map((info) => info.real);
    const fresh = new Map<string, string[]>();
    const block = (alias: string, reason: string) => fresh.set(alias, [...(fresh.get(alias) ?? []), reason]);
    decisions = [];
    incomingByName.clear();
    const byName = new Map<string, Candidate[]>();
    for (const info of active) for (const candidate of info.candidates) byName.set(candidate.name, [...(byName.get(candidate.name) ?? []), candidate]);
    const decide = (candidate: Candidate, kind: SkillRootOperationKind, detail: string, extra: Partial<SkillRootOperation> = {}) =>
      decisions.push({ alias: candidate.alias, name: candidate.name, operation: { kind, alias: candidate.alias, path: lex(candidate.path), detail, ...extra } });
    /** Why `candidate` is not wholly shown by `occupant` (a before-layout view at `occupantPath`). */
    const notContained = (candidate: Candidate, occupantLabel: string, occupantView: View | undefined, occupantPath: string): string | undefined => {
      if (!occupantView) return `${candidate.label} collides with ${occupantLabel}, which does not resolve`;
      if (candidate.kind === "link") {
        const hazard = firstHazard(candidate.resolution!, realAliasDirs, candidate.path);
        if (hazard) return `${candidate.label} -> ${candidate.text} resolves into ${rel(hazard)}, a CLI skills root being converted; it is not an independent copy`;
        if (candidate.resolution!.real !== occupantView.real) return `${candidate.label} -> ${candidate.text} collides with ${occupantLabel}, which resolves elsewhere`;
        return undefined;
      }
      if (within(occupantView.real, candidate.path) || within(candidate.path, occupantView.real)) {
        return `${occupantLabel} resolves into ${candidate.label} itself; it is not an independent copy`;
      }
      const gap = viewGap(beforeView(candidate.path)!, occupantView, hasher);
      return gap ? `${candidate.label} differs from ${occupantLabel}: ${gap}` : undefined;
    };
    const finalText = (candidate: Candidate): string => {
      const text = candidate.text!;
      if (isAbsolute(text)) return text;
      const lexical = resolve(dirname(candidate.path), text);
      const home = activeDirs.find((dir) => within(lexical, dir));
      const mapped = home ? join(R, relative(home, lexical)) : lexical;
      return relative(R, mapped) || ".";
    };
    for (const name of [...byName.keys()].sort()) {
      const candidates = byName.get(name)!;
      const counterpart = join(R, name);
      const counterpartLabel = `.agents/skills/${name}`;
      const live: Candidate[] = [];
      for (const candidate of candidates) {
        if (candidate.kind === "link" && !candidate.resolution) {
          decide(candidate, "drop-dangling-link", `drop dangling link ${candidate.label} -> ${candidate.text}`);
        } else live.push(candidate);
      }
      if (!live.length) continue;
      const rootEntry = rootState === "directory" ? lstatOrUndefined(counterpart) : undefined;
      const dropAgainst = (candidate: Candidate, occupantLabel: string, where: string, extra: Partial<SkillRootOperation>) => {
        if (candidate.kind === "link") decide(candidate, "drop-duplicate-link", `drop duplicate link ${candidate.label} -> ${candidate.text} (same target as ${occupantLabel})`, extra);
        else decide(candidate, "drop-duplicate-entry", `drop ${candidate.label} (every entry already exists byte-identical in ${where})`, extra);
      };
      if (rootEntry) {
        const counterpartText = rootEntry.isSymbolicLink() ? readlinkSync(counterpart) : undefined;
        const rootView = beforeView(counterpart);
        if (rootEntry.isSymbolicLink()) {
          if (!rootView) {
            for (const candidate of live) block(candidate.alias, `${candidate.label} collides with ${counterpartLabel}, a dangling link to ${counterpartText}`);
            continue;
          }
          const hazardDirs = [...realAliasDirs, ...live.map((candidate) => candidate.path)];
          const hazard = firstHazard(rootView, hazardDirs);
          if (hazard) {
            for (const candidate of live) {
              const self = within(hazard, candidate.path);
              block(candidate.alias, `${candidate.label}: ${counterpartLabel} -> ${counterpartText} resolves into ${rel(hazard)}, ${self ? "the entry being converted" : "a CLI skills root being converted"}; it is not an independent copy${self
                ? ` (replace that link with the directory itself: rm ${shellQuote(lex(counterpart))} && mv ${shellQuote(lex(candidate.path))} ${shellQuote(lex(counterpart))})` : ""}`);
            }
            continue;
          }
        }
        if (!rootEntry.isSymbolicLink() && !rootEntry.isDirectory() && !rootEntry.isFile()) {
          for (const candidate of live) block(candidate.alias, `${candidate.label} collides with ${counterpartLabel}, a special file`);
          continue;
        }
        const gaps = live.map((candidate) => notContained(candidate, counterpartLabel, rootView, counterpart));
        if (gaps.every((gap) => gap === undefined)) {
          for (const candidate of live) dropAgainst(candidate, counterpartLabel, counterpartLabel, { counterpart: lex(counterpart) });
          continue;
        }
        // The reverse subset: the .agents/skills copy is a real-directory stub
        // (ssbnk's hold only scripts/tests/*) whose every entry already exists in
        // one complete alias copy, which also holds every other alias copy.
        const replacer = rootEntry.isDirectory() && !rootEntry.isSymbolicLink() && !entryHazard(counterpart, counterpartLabel)
          ? live.find((candidate) => candidate.kind === "directory"
            && viewGap(rootView!, beforeView(candidate.path), hasher) === undefined
            && live.every((other) => other === candidate || notContained(other, candidate.label, beforeView(candidate.path), candidate.path) === undefined))
          : undefined;
        if (replacer) {
          decide(replacer, "replace-subset-counterpart", `replace ${counterpartLabel} (every entry already exists byte-identical in ${replacer.label}) with ${replacer.label} (rename, inode preserved)`,
            { path: lex(counterpart), from: lex(replacer.path), counterpart: lex(counterpart) });
          incomingByName.set(name, { alias: replacer.alias, from: replacer.path, kind: "directory", incoming: { kind: "move", from: replacer.path } });
          for (const candidate of live) if (candidate !== replacer) dropAgainst(candidate, replacer.label, `${replacer.label}, which replaces ${counterpartLabel}`, { counterpart: lex(replacer.path) });
          continue;
        }
        live.forEach((candidate, index) => {
          if (gaps[index]) block(candidate.alias, gaps[index]!);
          else dropAgainst(candidate, counterpartLabel, counterpartLabel, { counterpart: lex(counterpart) });
        });
        continue;
      }
      // No counterpart: one candidate moves in, and must show everything the others show.
      const holdsAll = (occupant: Candidate) => live.every((other) => other === occupant
        || notContained(other, occupant.label, beforeView(occupant.path), occupant.path) === undefined);
      // Real content is preferred: a link into another root's real entry is then
      // blocked for this run and becomes a plain duplicate once that root converts.
      const occupant = live.find((candidate) => candidate.kind !== "link" && holdsAll(candidate))
        ?? live.find((candidate) => candidate.kind === "link" && holdsAll(candidate))
        ?? live.find((candidate) => candidate.kind !== "link")
        ?? live[0]!;
      const destination = lex(counterpart);
      if (occupant.kind === "link") {
        const text = finalText(occupant);
        if (text === occupant.text) {
          decide(occupant, "move-link", `move link ${occupant.label} -> ${text} into .agents/skills`, { path: destination, from: lex(occupant.path), target: text });
          incomingByName.set(name, { alias: occupant.alias, from: occupant.path, kind: "link", incoming: { kind: "move", from: occupant.path } });
        } else {
          decide(occupant, "recreate-link", `recreate link ${occupant.label} -> ${occupant.text} as ${counterpartLabel} -> ${text}`, { path: destination, from: lex(occupant.path), target: text });
          incomingByName.set(name, { alias: occupant.alias, from: occupant.path, kind: "link", incoming: { kind: "link", text } });
        }
      } else {
        decide(occupant, "move-entry", `move ${occupant.label} into .agents/skills (rename, inode preserved)`, { path: destination, from: lex(occupant.path) });
        incomingByName.set(name, { alias: occupant.alias, from: occupant.path, kind: occupant.kind, incoming: { kind: "move", from: occupant.path } });
      }
      for (const candidate of live) {
        if (candidate === occupant) continue;
        const gap = notContained(candidate, occupant.label, beforeView(occupant.path), occupant.path);
        if (gap) block(candidate.alias, gap);
        else dropAgainst(candidate, occupant.label, `${occupant.label}, which moves into ${counterpartLabel}`, { counterpart: lex(occupant.path) });
      }
    }
    if (fresh.size) {
      for (const [alias, reasons] of fresh) blocked.set(alias, reasons);
      continue;
    }
    // ----- Verify the decisions against the layout they would produce.
    spec = { root: R, links: new Map(), dirs: new Set(), incoming: new Map() };
    const converting = active.filter((info) => info.state === "real-directory");
    if (!agentsStat) spec.dirs.add(agents);
    if (rootState === "absent" && converting.length) spec.dirs.add(R);
    for (const info of converting) spec.links.set(info.real, CANONICAL_CLI_SKILLS_ALIAS);
    for (const info of infos) {
      if (blocked.has(info.alias)) continue;
      if (info.state === "absent") {
        if (!info.cliRootExists) spec.dirs.add(info.cliRoot);
        spec.links.set(info.real, CANONICAL_CLI_SKILLS_ALIAS);
      }
      if (info.state === "dangling") spec.links.set(info.real, CANONICAL_CLI_SKILLS_ALIAS);
    }
    for (const [name, entry] of incomingByName) spec.incoming.set(name, entry.incoming);
    if (!converting.length) break;
    const after = finalLayout(spec);
    const mismatches = new Map<string, string[]>();
    for (const [path, view] of visibleViews(repoReal, R, beforeView)) {
      const gap = viewGap(view, viewIn(after, path, affected), hasher);
      if (!gap) continue;
      const responsible = converting.filter((info) => within(path, info.real) || [...view.hops, view.real].some((hop) => within(hop, info.real)));
      for (const hop of [path, ...view.hops, view.real]) {
        if (!within(hop, R) || hop === R) continue;
        const writer = incomingByName.get(relative(R, hop).split(sep)[0]!);
        const info = writer && converting.find((item) => item.alias === writer.alias);
        if (info && !responsible.includes(info)) responsible.push(info);
      }
      for (const info of responsible.length ? responsible : converting) {
        mismatches.set(info.alias, [...(mismatches.get(info.alias) ?? []), `${rel(path)} would not show the same content after converting ${info.alias}: ${gap}`]);
      }
    }
    if (!mismatches.size) break;
    for (const [alias, reasons] of mismatches) blocked.set(alias, reasons);
  }

  // ----- Operations, per alias and in execution order
  const active = infos.filter((info) => !blocked.has(info.alias));
  const perAlias = new Map<string, SkillRootOperation[]>();
  const push = (alias: string, operation: SkillRootOperation) => perAlias.set(alias, [...(perAlias.get(alias) ?? []), operation]);
  const summaries = new Map<string, string>();
  for (const info of infos) {
    if (blocked.has(info.alias) || info.state !== "real-directory") continue;
    const mine = decisions.filter((decision) => decision.alias === info.alias);
    const untrack = [...new Set(info.candidates.flatMap((candidate) => mine.some((decision) => decision.name === candidate.name) ? candidate.tracked : []))].sort();
    if (untrack.length) push(info.alias, { kind: "untrack", alias: info.alias, path: info.path, tracked: untrack,
      detail: `untrack ${plural(untrack.length, "path")} under ${info.alias} (generated output must not be tracked)` });
    for (const decision of mine) push(info.alias, decision.operation);
    push(info.alias, { kind: "convert-alias", alias: info.alias, path: info.path, target: CANONICAL_CLI_SKILLS_ALIAS, detail: `replace the emptied ${info.alias} directory with ${CANONICAL_CLI_SKILLS_ALIAS}` });
  }
  for (const info of active) {
    if (info.state === "absent") {
      if (!info.cliRootExists) push(info.alias, { kind: "create-cli-root", alias: info.alias, path: lex(info.cliRoot), detail: `create ${info.cliName}` });
      push(info.alias, { kind: "create-alias", alias: info.alias, path: info.path, target: CANONICAL_CLI_SKILLS_ALIAS, detail: `create ${info.alias} -> ${CANONICAL_CLI_SKILLS_ALIAS}` });
    }
    if (info.state === "dangling") {
      push(info.alias, { kind: "replace-dangling-alias", alias: info.alias, path: info.path, target: CANONICAL_CLI_SKILLS_ALIAS,
        detail: `replace dangling ${info.alias} -> ${info.text} with ${CANONICAL_CLI_SKILLS_ALIAS}` });
    }
  }
  const count = (alias: string, kinds: SkillRootOperationKind[]) => (perAlias.get(alias) ?? []).filter((operation) => kinds.includes(operation.kind)).length;
  const aliases: SkillAliasPlan[] = infos.map((info) => {
    const blocks = blocked.get(info.alias) ?? [];
    const operations = blocks.length ? [] : perAlias.get(info.alias) ?? [];
    let summary: string;
    if (info.state === "real-directory") {
      const heading = `${info.alias}: real directory with ${plural(info.candidates.length, "entry")}`;
      const parts = [
        count(info.alias, ["drop-dangling-link"]) && `${count(info.alias, ["drop-dangling-link"])} dangling link(s) to drop`,
        count(info.alias, ["drop-duplicate-link"]) && `${count(info.alias, ["drop-duplicate-link"])} duplicate link(s) to drop`,
        count(info.alias, ["move-link", "recreate-link"]) && `${count(info.alias, ["move-link", "recreate-link"])} link(s) to move`,
        count(info.alias, ["move-entry", "replace-subset-counterpart"]) && `${count(info.alias, ["move-entry", "replace-subset-counterpart"])} entr${count(info.alias, ["move-entry", "replace-subset-counterpart"]) === 1 ? "y" : "ies"} to move`,
        count(info.alias, ["drop-duplicate-entry"]) && `${count(info.alias, ["drop-duplicate-entry"])} duplicate entr${count(info.alias, ["drop-duplicate-entry"]) === 1 ? "y" : "ies"} to drop`,
      ].filter(Boolean);
      summary = blocks.length
        ? `${heading} — BLOCKED by ${plural(blocks.length, "entry")}, left untouched`
        : `${heading}${parts.length ? ` — ${parts.join(", ")}` : ""}, then aliased to .agents/skills`;
    } else if (blocks.length) summary = `${info.alias}: blocked (${blocks[0]})`;
    else if (info.state === "absent") summary = `${info.alias}: absent — create ${CANONICAL_CLI_SKILLS_ALIAS}`;
    else if (info.state === "dangling") summary = `${info.alias}: dangling link to ${info.text} — replace`;
    else summary = `${info.alias}: alias${rootState === "absent" ? " (activation root not created yet)" : ""}`;
    summaries.set(info.alias, summary);
    return { alias: info.alias, path: info.path, state: info.state, operations, blocks, summary };
  });

  const converted = aliases.filter((entry) => entry.state === "real-directory" && entry.operations.length);
  const all = aliases.flatMap((entry) => entry.operations);
  const phase: SkillRootOperationKind[][] = [
    ["replace-subset-counterpart", "move-entry"],
    ["drop-duplicate-entry"],
    ["move-link", "recreate-link", "drop-duplicate-link", "drop-dangling-link"],
    ["convert-alias"],
    ["create-cli-root", "create-alias", "replace-dangling-alias"],
    ["untrack"],
  ];
  const operations = phase.flatMap((kinds) => all.filter((operation) => kinds.includes(operation.kind)));
  if (rootState === "absent" && converted.length) {
    operations.unshift({ kind: "create-root", path: lexicalRoot, detail: "create .agents/skills (the activation root the converted aliases point at)" });
  }
  const blocks = [...new Set(aliases.flatMap((entry) => entry.blocks))];
  const incoming: SkillRootIncoming[] = [];
  if (spec) {
    const after = finalLayout(spec);
    for (const [name, entry] of incomingByName) {
      if (blocked.has(entry.alias)) continue;
      const resolution = resolveIn(after, join(R, name));
      const phys = resolution ? (after.lstat(resolution.real)?.phys ?? resolution.real) : undefined;
      const text = entry.kind !== "link" ? undefined : entry.incoming.kind === "link" ? entry.incoming.text : readlinkSync(entry.from);
      incoming.push({ name, path: join(lexicalRoot, name), from: lex(entry.from), kind: entry.kind, ...(text === undefined ? {} : { text }), resolves: phys ? lex(phys) : undefined });
    }
  }
  const plan: SkillRootsPlan = { repoRoot, root: lexicalRoot, rootState, aliases, operations, blocks, clean: blocks.length === 0, incoming };
  const before = new Map<string, View>();
  if (converted.length) for (const [path, view] of visibleViews(repoReal, R, beforeView)) before.set(path, view);
  internals.set(plan, {
    repoReal, R, agentsExisted: Boolean(agentsStat), before, affected,
    converted: converted.map((entry) => join(repoReal, entry.alias)),
    created: aliases.filter((entry) => entry.operations.some((operation) => operation.kind === "create-alias" || operation.kind === "replace-dangling-alias")).map((entry) => join(repoReal, entry.alias)),
  });
  return plan;
}

/** Every name visible through `.agents/skills` and each CLI alias, as physical alias paths, with its before view. */
function visibleViews(repoReal: string, R: string, view: (path: string) => View | undefined): Map<string, View> {
  const views = new Map<string, View>();
  const seen = new Set<string>();
  for (const location of [R, ...SUPPORTED_SKILLS_ALIASES.map((alias) => join(repoReal, alias))]) {
    const resolved = realpathOrUndefined(location);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    let names: string[];
    try { names = readdirSync(location); } catch { continue; }
    for (const name of names.sort()) {
      const path = join(location, name);
      const found = view(path);
      if (found) views.set(path, found);
    }
  }
  return views;
}

/** Audit detail lines: one line per alias that needs work, then every block reason. */
export function skillRootsSummary(plan: SkillRootsPlan): string[] {
  const lines = plan.aliases
    .filter((entry) => entry.operations.length || entry.blocks.length)
    .map((entry) => `CLI skills root ${entry.summary}`);
  return [...lines, ...plan.blocks.map((reason) => `blocked: ${reason}`)];
}

function changedPaths(operation: SkillRootOperation): string[] {
  if (operation.kind === "untrack") return [];
  return operation.from ? [operation.from, operation.path] : [operation.path];
}

// ---------------------------------------------------------------------------
// Execution: journal, quarantine, verification from disk, rollback
// ---------------------------------------------------------------------------

type Step =
  | { step: "mkdir"; path: string }
  /** park: "entry" (compared with its before view before the purge), "link" (text), "dir" (must be empty). */
  | { step: "rename"; from: string; to: string; park?: "entry" | "link" | "dir"; text?: string }
  | { step: "symlink"; path: string; text: string };

function compileSteps(plan: SkillRootsPlan, facts: PlanInternals, items: string): Step[] {
  const physical = (path: string) => join(facts.repoReal, relative(plan.repoRoot, path));
  const steps: Step[] = [];
  const park = (from: string, kind: "entry" | "link" | "dir") => {
    const stat = lstatOrUndefined(from);
    const text = kind === "link" && stat?.isSymbolicLink() ? readlinkSync(from) : undefined;
    steps.push({ step: "rename", from, to: join(items, `${steps.length}-${basename(from)}`), park: kind, ...(text === undefined ? {} : { text }) });
  };
  for (const operation of plan.operations) {
    const path = physical(operation.path);
    const from = operation.from ? physical(operation.from) : undefined;
    switch (operation.kind) {
      case "create-root":
      case "create-cli-root":
        steps.push({ step: "mkdir", path });
        break;
      case "create-alias":
        steps.push({ step: "symlink", path, text: CANONICAL_CLI_SKILLS_ALIAS });
        break;
      case "replace-dangling-alias":
        park(path, "link");
        steps.push({ step: "symlink", path, text: CANONICAL_CLI_SKILLS_ALIAS });
        break;
      case "convert-alias":
        park(path, "dir");
        steps.push({ step: "symlink", path, text: CANONICAL_CLI_SKILLS_ALIAS });
        break;
      case "drop-dangling-link":
      case "drop-duplicate-link":
        park(path, "link");
        break;
      case "drop-duplicate-entry":
        park(path, "entry");
        break;
      case "move-link":
      case "move-entry":
        steps.push({ step: "rename", from: from!, to: path });
        break;
      case "recreate-link":
        park(from!, "link");
        steps.push({ step: "symlink", path, text: operation.target! });
        break;
      case "replace-subset-counterpart":
        park(path, "entry");
        steps.push({ step: "rename", from: from!, to: path });
        break;
      case "untrack":
        break;
    }
  }
  return steps;
}

function restoreScript(run: string, quarantine: string, agents: string | undefined, repo: string, steps: Step[]): string {
  const lines = [
    "#!/bin/sh",
    `# pjangler CLI skills-root conversion ${basename(run)} in ${repo}`,
    "# Exact reversal of every step this run completed (journal.json lists them;",
    "# progress.log records each completed step). Written before the first step.",
    "set -u",
    `RUN=${shellQuote(run)}`,
    'LOG="$RUN/progress.log"',
    "DONE=$(grep -c '^done ' \"$LOG\" 2>/dev/null) || DONE=0",
    'fail() { echo "skills-root restore: $*" >&2; exit 1; }',
    'present() { [ -e "$1" ] || [ -L "$1" ]; }',
    'undone() { grep -qx "undone $1" "$LOG" 2>/dev/null; }',
    "unrename() {",
    '  undone "$1" && return 0',
    '  if [ "$1" -lt "$DONE" ] || { [ "$1" -eq "$DONE" ] && present "$3" && ! present "$2"; }; then',
    '    present "$3" || fail "step $1: $3 is missing"',
    '    present "$2" && fail "step $1: $2 exists again"',
    '    mv -- "$3" "$2" || fail "step $1: could not move $3 back to $2"',
    "  fi",
    "}",
    "unsymlink() {",
    '  undone "$1" && return 0',
    '  if [ "$1" -le "$DONE" ] && [ -L "$2" ] && [ "$(readlink -- "$2")" = "$3" ]; then rm -f -- "$2" || fail "step $1: could not remove $2"',
    '  elif [ "$1" -lt "$DONE" ]; then fail "step $1: $2 is not the link this run created"; fi',
    "}",
    "unmkdir() {",
    '  undone "$1" && return 0',
    '  if [ "$1" -le "$DONE" ] && [ -d "$2" ] && [ ! -L "$2" ]; then rmdir -- "$2" || fail "step $1: $2 is not empty"; fi',
    "}",
  ];
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!;
    if (step.step === "rename") lines.push(`unrename ${index} ${shellQuote(step.from)} ${shellQuote(step.to)}`);
    if (step.step === "symlink") lines.push(`unsymlink ${index} ${shellQuote(step.path)} ${shellQuote(step.text)}`);
    if (step.step === "mkdir") lines.push(`unmkdir ${index} ${shellQuote(step.path)}`);
  }
  lines.push('rm -rf -- "$RUN"', `rmdir -- ${shellQuote(quarantine)} 2>/dev/null || true`);
  if (agents) lines.push(`rmdir -- ${shellQuote(agents)} 2>/dev/null || true`);
  lines.push(`echo "skills-root restore: ${repo.replace(/["$`\\]/g, "")} is back to its state before run ${basename(run)}"`, "");
  return lines.join("\n");
}

function runStep(step: Step): void {
  if (step.step === "mkdir") { mkdirSync(step.path); return; }
  if (step.step === "symlink") { symlinkSync(step.text, step.path); return; }
  if (lstatOrUndefined(step.to)) throw new Error(`${step.to} appeared before the move`);
  if (step.park === "dir" && readdirSync(step.from).length) throw new Error(`${step.from} is not empty (${readdirSync(step.from)[0]})`);
  if (step.park === "link" && (!lstatOrUndefined(step.from)?.isSymbolicLink() || readlinkSync(step.from) !== step.text)) throw new Error(`${step.from} is no longer the link that was planned`);
  renameSync(step.from, step.to);
}

/** Why a parked item holds anything that was not in the plan (so its purge could lose content). */
function parkedGap(step: Extract<Step, { step: "rename" }>, before: View | undefined, affected: (real: string) => boolean, hasher: Hasher): string | undefined {
  const stat = lstatOrUndefined(step.to);
  if (!stat) return `${step.to} is missing from the quarantine`;
  if (step.park === "dir") return readdirSync(step.to).length ? `${step.to} is no longer empty` : undefined;
  if (step.park === "link") return stat.isSymbolicLink() && readlinkSync(step.to) === step.text ? undefined : `${step.to} is no longer the planned link`;
  if (!before?.node) return `${step.from} had no recorded content to compare`;
  const parked = viewIn(diskLayout, step.to, affected);
  if (!parked) return `${step.to} does not resolve`;
  const gap = viewGap({ ...parked, node: walkNode(diskLayout, step.to, step.to) }, before, hasher, true);
  return gap ? `${step.from} changed while it was converted: ${gap}` : undefined;
}

function undoStep(step: Step): void {
  if (step.step === "mkdir") { rmdirSync(step.path); return; }
  if (step.step === "symlink") {
    const stat = lstatOrUndefined(step.path);
    if (!stat?.isSymbolicLink() || readlinkSync(step.path) !== step.text) throw new Error(`${step.path} is not the link this run created`);
    unlinkSync(step.path);
    return;
  }
  if (lstatOrUndefined(step.from)) throw new Error(`${step.from} exists again`);
  renameSync(step.to, step.from);
}

/** Map a pre-run path to where the completed renames put it. */
function translator(steps: Step[], done: number): (path: string) => string {
  return (path) => {
    let current = path;
    for (let index = 0; index < done; index++) {
      const step = steps[index]!;
      if (step.step === "rename" && within(current, step.from)) current = join(step.to, relative(step.from, current));
    }
    return current;
  };
}

/**
 * Plan, then (unless dry run) execute the ONE plan: every alias whose plan is
 * clean is converted, blocked aliases are untouched and reported. A dry run
 * writes nothing and reports the plan, which is exactly what apply does.
 */
export function applySkillRoots(repoRoot: string, options: SkillRootsApplyOptions): SkillRootsResult {
  const plan = planSkillRoots(repoRoot, options);
  const changedFiles = [...new Set(plan.operations.flatMap(changedPaths))].sort();
  if (options.dryRun) {
    return {
      ok: plan.clean,
      changedFiles,
      details: [...plan.operations.map((operation) => `would ${operation.detail}`), ...plan.blocks.map((reason) => `blocked: ${reason}`)],
      blocks: plan.blocks,
      plan,
    };
  }
  if (!plan.operations.length) return { ok: plan.clean, changedFiles: [], details: [], blocks: plan.blocks, plan };
  const facts = internals.get(plan)!;
  const failed = (reason: string): SkillRootsResult => ({ ok: false, changedFiles: [], details: [], blocks: [...plan.blocks, reason], plan });

  // Infrastructure: .agents (if the plan creates it), the quarantine, the journal.
  const agents = join(facts.repoReal, ".agents");
  const quarantine = join(agents, SKILL_ROOTS_QUARANTINE);
  const run = join(quarantine, `${Date.now()}-${process.pid}`);
  const items = join(run, "items");
  const createdAgents = !lstatOrUndefined(agents);
  try {
    if (createdAgents) mkdirSync(agents);
    mkdirSync(quarantine);
    mkdirSync(items, { recursive: true });
  } catch (error) {
    return failed(`could not create the quarantine ${quarantine}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const steps = compileSteps(plan, facts, items);
  const log = join(run, "progress.log");
  try {
    writeFileSync(join(run, ".gitignore"), "*\n");
    writeFileSync(join(run, "journal.json"), `${JSON.stringify({ version: 1, repo: facts.repoReal, createdAgents, steps, operations: plan.operations.map((operation) => operation.detail) }, null, 2)}\n`);
    writeFileSync(join(run, "restore.sh"), restoreScript(run, quarantine, createdAgents ? agents : undefined, facts.repoReal, steps), { mode: 0o755 });
    writeFileSync(log, "");
  } catch (error) {
    rmSync(run, { recursive: true, force: true });
    try { rmdirSync(quarantine); } catch { /* keep */ }
    if (createdAgents) { try { rmdirSync(agents); } catch { /* keep */ } }
    return failed(`could not write the conversion journal: ${error instanceof Error ? error.message : String(error)}`);
  }
  const crashAfter = Number(process.env.PJ_SKILL_ROOTS_CRASH_AFTER ?? Number.NaN);

  let done = 0;
  const cleanup = () => {
    rmSync(run, { recursive: true, force: true });
    try { rmdirSync(quarantine); } catch { /* another run's leftovers stay visible */ }
    if (createdAgents) { try { rmdirSync(agents); } catch { /* the plan created content there */ } }
  };
  const rollback = (reason: string): SkillRootsResult => {
    for (let index = done - 1; index >= 0; index--) {
      try {
        undoStep(steps[index]!);
        appendFileSync(log, `undone ${index}\n`);
      } catch (error) {
        return failed(`${reason}; rollback stopped at step ${index} (${error instanceof Error ? error.message : String(error)}): finish it exactly with: sh ${shellQuote(join(run, "restore.sh"))}`);
      }
    }
    appendFileSync(log, "rolled-back\n");
    if (readdirSync(items).length) return failed(`${reason}; rolled back, but ${items} is not empty — inspect it, then remove ${run}`);
    cleanup();
    return failed(`rolled back: ${reason}`);
  };

  for (; done < steps.length; done++) {
    try {
      runStep(steps[done]!);
    } catch (error) {
      const step = steps[done]!;
      const what = step.step === "rename" ? `rename ${step.from} -> ${step.to}` : `${step.step} ${step.path}`;
      return rollback(`step ${done} (${what}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    appendFileSync(log, `done ${done}\n`);
    if (done + 1 === crashAfter) process.kill(process.pid, "SIGKILL");
  }

  options.hooks?.beforeVerify?.();

  // Re-derive every visible name FROM DISK and compare it with what it showed before.
  const hasher = new Hasher(translator(steps, done));
  const mismatches: string[] = [];
  for (const [path, view] of facts.before) {
    const gap = viewGap(view, viewIn(diskLayout, path, facts.affected), hasher);
    if (gap) mismatches.push(`${relative(facts.repoReal, path)}: ${gap}`);
  }
  const rootReal = realpathOrUndefined(facts.R);
  for (const alias of [...facts.converted, ...facts.created]) {
    const reaches = rootReal ? realpathOrUndefined(alias) === rootReal : resolve(dirname(alias), readlinkSync(alias)) === facts.R;
    if (!reaches) mismatches.push(`${relative(facts.repoReal, alias)} does not resolve to .agents/skills`);
  }
  // Nothing may be purged that the plan did not prove disposable.
  for (const step of steps) {
    if (step.step !== "rename" || !step.park) continue;
    const gap = parkedGap(step, facts.before.get(step.from), facts.affected, hasher);
    if (gap) mismatches.push(gap);
  }
  if (mismatches.length) return rollback(mismatches.slice(0, 5).join("; "));

  // Only now: generated output leaves the index.
  const tracked = plan.operations.flatMap((operation) => operation.kind === "untrack" ? operation.tracked ?? [] : []);
  if (tracked.length) {
    const removed = spawnSync("git", ["rm", "-r", "--cached", "--quiet", "--", ...tracked], { cwd: facts.repoReal, encoding: "utf8" });
    if (removed.status !== 0) return rollback(`git rm --cached failed: ${removed.stderr.trim()}`);
  }
  appendFileSync(log, "committed\n");
  cleanup();
  return { ok: plan.clean, changedFiles, details: plan.operations.map((operation) => operation.detail), blocks: plan.blocks, plan };
}
