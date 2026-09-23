import { spawnSync } from "node:child_process";
import {
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
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SUPPORTED_CLIS } from "../recipes/supported-clis";
import { attestBmadInstallerFiles, bmadCliProjectionInventory } from "./bmad-attestation";

/**
 * PJAN-135: turn every supported CLI skills root into the alias skillex requires.
 *
 * skillex refuses (E_ACTIVATION_CONFLICT) any `<cli>/skills` that is not a
 * symlink reaching `<repo>/.agents/skills`, and it refuses the whole plan at the
 * first one, so a real `.claude/skills` full of BMAD installer output blocks
 * every project that has one. `skillex migrate` cannot relocate installer
 * directories by design. This module is the relocation, and it is LOSSLESS by
 * construction:
 *
 * - nothing is copied: real entries move with rename(2), so the inode (and every
 *   byte, mode and timestamp) is the one that was there; a cross-device move is
 *   refused instead of degrading to copy+delete;
 * - nothing is deleted unless it is a proven duplicate: a dangling link, a link
 *   resolving to the same place as its `.agents/skills` counterpart, or a real
 *   entry every part of which already exists byte for byte in the counterpart;
 * - a moved link resolves to the same target afterwards (verified);
 * - git-tracked content moves only when every tracked file is attested BMAD
 *   installer output (the same manifest-hash proof `bmad.cli-roots` uses to
 *   delete unsupported roots), and is then untracked: generated output is never
 *   tracked. Tracked content without that proof blocks.
 *
 * A root is planned whole before anything is touched; a root with ANY blocked
 * entry is left exactly as it was. Every apply re-plans from the current
 * filesystem, so a run interrupted halfway resumes safely: whatever already
 * moved is no longer in the alias, and a partially deleted duplicate is still a
 * subset of its counterpart.
 */

/** The one alias text every supported CLI skills root carries (skillex writes the same relative form). */
export const CANONICAL_CLI_SKILLS_ALIAS = "../.agents/skills";

/** The six project aliases skillex checks, in CLI policy order. */
export const SUPPORTED_SKILLS_ALIASES: readonly string[] = SUPPORTED_CLIS.map((cli) => cli.skillsRoot);

export type SkillRootOperationKind =
  | "create-root"
  | "create-cli-root"
  | "create-alias"
  | "relink-alias"
  | "replace-dangling-alias"
  | "untrack"
  | "drop-dangling-link"
  | "drop-duplicate-link"
  | "move-link"
  | "recreate-link"
  | "move-entry"
  | "drop-duplicate-entry"
  | "convert-alias";

export interface SkillRootOperation {
  kind: SkillRootOperationKind;
  /** The path this operation writes or removes. For moves, the destination. */
  path: string;
  /** Move/recreate source (an entry of the alias directory). */
  from?: string;
  /** Link text written by this operation. */
  target?: string;
  /** For drop-duplicate-entry: the counterpart that proves the duplicate. */
  counterpart?: string;
  /** Realpath a moved or recreated link must still resolve to. */
  expected?: string;
  /** For untrack: repository-relative paths removed from the index. */
  tracked?: string[];
  detail: string;
}

export type SkillAliasState = "alias" | "absent" | "relink" | "dangling" | "foreign-link" | "real-directory" | "unsupported";

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

export interface SkillRootsPlan {
  repoRoot: string;
  root: string;
  rootState: "directory" | "absent" | "symlink" | "other";
  aliases: SkillAliasPlan[];
  operations: SkillRootOperation[];
  blocks: string[];
  clean: boolean;
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

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
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

/**
 * The first reason `candidate` is NOT wholly contained in `reference`, or
 * undefined when every entry of candidate exists in reference with identical
 * type, bytes and symlink text. `reference` is followed if it is itself a link
 * (a `.agents/skills/<name>` counterpart may be a link to the real content).
 */
export function treeContainmentGap(candidate: string, reference: string): string | undefined {
  const top = lstatOrUndefined(reference);
  const referenceRoot = top?.isSymbolicLink() ? realpathOrUndefined(reference) : top ? reference : undefined;
  if (!referenceRoot) return "the counterpart is missing or a dangling link";
  const walk = (left: string, right: string, rel: string): string | undefined => {
    const label = rel || ".";
    const a = lstatSync(left);
    const b = lstatOrUndefined(right);
    if (!b) return `${label} is missing from the counterpart`;
    if (a.isSymbolicLink()) {
      if (!b.isSymbolicLink()) return `${label} is a symlink but the counterpart is not`;
      return readlinkSync(left) === readlinkSync(right) ? undefined : `${label} link text differs`;
    }
    if (a.isFile()) {
      if (!b.isFile()) return `${label} is a file but the counterpart is not`;
      if (a.size !== b.size || !readFileSync(left).equals(readFileSync(right))) return `${label} content differs`;
      return undefined;
    }
    if (a.isDirectory()) {
      if (!b.isDirectory()) return `${label} is a directory but the counterpart is not`;
      for (const name of readdirSync(left).sort()) {
        const gap = walk(join(left, name), join(right, name), rel ? `${rel}/${name}` : name);
        if (gap) return gap;
      }
      return undefined;
    }
    return `${label} is a special file`;
  };
  return walk(candidate, referenceRoot, "");
}

/** Same relative paths, same file bytes, same symlink texts, in both directions. */
export function treesIdentical(left: string, right: string): boolean {
  return treeContainmentGap(left, right) === undefined && treeContainmentGap(right, left) === undefined;
}

interface Claim {
  source: string;
  real?: string;
}

interface PlanContext {
  repoRoot: string;
  root: string;
  rootState: SkillRootsPlan["rootState"];
  rootReal?: string;
  rootDevice?: number;
  claims: Map<string, Claim>;
  inventory?: ReturnType<typeof bmadCliProjectionInventory>;
  gitWorkTree?: boolean;
}

function inventoryOf(ctx: PlanContext): ReturnType<typeof bmadCliProjectionInventory> {
  ctx.inventory ??= bmadCliProjectionInventory(ctx.repoRoot);
  return ctx.inventory;
}

/** Tracked paths under `relDir`, grouped by the alias entry that holds them. */
function trackedEntries(ctx: PlanContext, relDir: string): { byEntry: Map<string, string[]>; error?: string } {
  const byEntry = new Map<string, string[]>();
  if (ctx.gitWorkTree === undefined) {
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.repoRoot, encoding: "utf8" });
    ctx.gitWorkTree = probe.status === 0 && probe.stdout.trim() === "true";
  }
  if (!ctx.gitWorkTree) return { byEntry };
  const listed = spawnSync("git", ["ls-files", "-z", "--", relDir], { cwd: ctx.repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) return { byEntry, error: `git ls-files failed for ${relDir}: ${listed.stderr.trim()}` };
  const prefix = `${relDir.split(sep).join("/")}/`;
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (!path.startsWith(prefix)) continue;
    const entry = path.slice(prefix.length).split("/")[0]!;
    byEntry.set(entry, [...(byEntry.get(entry) ?? []), path]);
  }
  return { byEntry };
}

function counterpartOf(ctx: PlanContext, name: string): { path: string; real?: string; claimed: boolean } | undefined {
  const path = join(ctx.root, name);
  if (lstatOrUndefined(path)) return { path, real: realpathOrUndefined(path), claimed: false };
  const claim = ctx.claims.get(name);
  return claim ? { path: claim.source, real: claim.real, claimed: true } : undefined;
}

function describeCounterpart(path: string): string {
  const stat = lstatOrUndefined(path);
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) {
    const real = realpathOrUndefined(path);
    return `a link to ${readlinkSync(path)}${real ? "" : " (dangling)"}`;
  }
  return stat.isDirectory() ? "a real directory" : stat.isFile() ? "a regular file" : "a special file";
}

function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

function planRealDirectoryAlias(ctx: PlanContext, alias: string, aliasPath: string): { operations: SkillRootOperation[]; blocks: string[]; summary: string } {
  const operations: SkillRootOperation[] = [];
  const blocks: string[] = [];
  const names = readdirSync(aliasPath).sort();
  const heading = `${alias}: real directory with ${plural(names.length, "entry")}`;
  if (ctx.rootState === "symlink") {
    return { operations, blocks: [`${alias} is a real directory but .agents/skills is a symlink (pack activation); refusing to relocate its entries`], summary: heading };
  }
  if (ctx.rootState === "other") return { operations, blocks, summary: heading };
  const tracked = trackedEntries(ctx, relative(ctx.repoRoot, aliasPath));
  if (tracked.error) return { operations, blocks: [tracked.error], summary: heading };
  const cliRoot = dirname(aliasPath);
  const cliName = relative(ctx.repoRoot, cliRoot);
  const untrack: string[] = [];
  const claims = new Map<string, Claim>();
  const attest = (label: string, paths: string[]): string | undefined => {
    const missing = paths.filter((path) => !lstatOrUndefined(join(ctx.repoRoot, path)));
    if (missing.length) return `${label} has tracked path(s) missing from the work tree (${missing[0]}); restore or commit the deletion first`;
    const verdict = attestBmadInstallerFiles(inventoryOf(ctx), cliRoot, paths.map((path) => relative(cliRoot, join(ctx.repoRoot, path))), cliName);
    return verdict.safe ? undefined : `${label} is tracked in git and not attested BMAD installer output: ${verdict.reason}`;
  };
  const counts = { dangling: 0, duplicateLinks: 0, movedLinks: 0, moved: 0, duplicates: 0 };
  for (const name of names) {
    const entry = join(aliasPath, name);
    const label = `${alias}/${name}`;
    const destination = join(ctx.root, name);
    const stat = lstatSync(entry);
    const entryTracked = tracked.byEntry.get(name) ?? [];
    if (stat.isSymbolicLink()) {
      const text = readlinkSync(entry);
      const real = realpathOrUndefined(entry);
      if (!real) {
        counts.dangling++;
        operations.push({ kind: "drop-dangling-link", path: entry, detail: `drop dangling link ${label} -> ${text}` });
        untrack.push(...entryTracked);
        continue;
      }
      const counterpart = counterpartOf(ctx, name);
      if (counterpart) {
        if (counterpart.real === real) {
          counts.duplicateLinks++;
          operations.push({ kind: "drop-duplicate-link", path: entry, detail: `drop duplicate link ${label} -> ${text} (same target as .agents/skills/${name})` });
          untrack.push(...entryTracked);
          continue;
        }
        blocks.push(`${label} -> ${text} collides with .agents/skills/${name}, which is ${counterpart.claimed ? `claimed by ${relative(ctx.repoRoot, counterpart.path)}` : describeCounterpart(counterpart.path)} resolving elsewhere`);
        continue;
      }
      counts.movedLinks++;
      const fromRoot = isAbsolute(text) ? real : realpathOrUndefined(resolve(ctx.root, text));
      if (fromRoot === real) {
        operations.push({ kind: "move-link", path: destination, from: entry, expected: real, detail: `move link ${label} -> ${text} into .agents/skills` });
      } else {
        const lexical = resolve(aliasPath, text);
        const target = realpathOrUndefined(lexical) === real ? lexical : real;
        operations.push({ kind: "recreate-link", path: destination, from: entry, target, expected: real, detail: `recreate link ${label} as .agents/skills/${name} -> ${target}` });
      }
      claims.set(name, { source: entry, real });
      untrack.push(...entryTracked);
      continue;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      blocks.push(`${label} is a special file; refusing to relocate it`);
      continue;
    }
    const counterpart = counterpartOf(ctx, name);
    if (counterpart) {
      const gap = treeContainmentGap(entry, counterpart.path);
      if (gap) {
        blocks.push(`${label} differs from .agents/skills/${name}${counterpart.claimed ? ` (claimed by ${relative(ctx.repoRoot, counterpart.path)})` : ""}: ${gap}`);
        continue;
      }
      if (entryTracked.length) {
        const refusal = attest(label, entryTracked);
        if (refusal) { blocks.push(refusal); continue; }
        untrack.push(...entryTracked);
      }
      counts.duplicates++;
      operations.push({ kind: "drop-duplicate-entry", path: entry, counterpart: counterpart.path, detail: `drop ${label} (every entry already exists byte-identical in .agents/skills/${name})` });
      continue;
    }
    if (ctx.rootDevice !== undefined && stat.dev !== ctx.rootDevice) {
      blocks.push(`${label} is on a different filesystem than .agents/skills; refusing a copying move`);
      continue;
    }
    if (entryTracked.length) {
      const refusal = attest(label, entryTracked);
      if (refusal) { blocks.push(refusal); continue; }
      untrack.push(...entryTracked);
    }
    counts.moved++;
    operations.push({ kind: "move-entry", path: destination, from: entry, detail: `move ${label} into .agents/skills (rename, inode preserved)` });
    claims.set(name, { source: entry, real: realpathOrUndefined(entry) });
  }
  const parts = [
    counts.dangling && `${counts.dangling} dangling link(s) to drop`,
    counts.duplicateLinks && `${counts.duplicateLinks} duplicate link(s) to drop`,
    counts.movedLinks && `${counts.movedLinks} link(s) to move`,
    counts.moved && `${counts.moved} entr${counts.moved === 1 ? "y" : "ies"} to move`,
    counts.duplicates && `${counts.duplicates} duplicate entr${counts.duplicates === 1 ? "y" : "ies"} to drop`,
  ].filter(Boolean);
  const summary = `${heading}${parts.length ? ` — ${parts.join(", ")}` : ""}${blocks.length ? ` — BLOCKED by ${plural(blocks.length, "entry")}, left untouched` : ", then aliased to .agents/skills"}`;
  if (blocks.length) return { operations: [], blocks, summary };
  for (const [name, claim] of claims) ctx.claims.set(name, claim);
  if (untrack.length) {
    operations.unshift({ kind: "untrack", path: aliasPath, tracked: [...new Set(untrack)].sort(),
      detail: `untrack ${plural(new Set(untrack).size, "path")} under ${alias} (generated output must not be tracked)` });
  }
  operations.push({ kind: "convert-alias", path: aliasPath, target: CANONICAL_CLI_SKILLS_ALIAS, detail: `replace the emptied ${alias} directory with ${CANONICAL_CLI_SKILLS_ALIAS}` });
  return { operations, blocks, summary };
}

function planAlias(ctx: PlanContext, alias: string): SkillAliasPlan {
  const path = join(ctx.repoRoot, alias);
  const cliRoot = dirname(path);
  const cliName = relative(ctx.repoRoot, cliRoot);
  const done = (state: SkillAliasState, operations: SkillRootOperation[], blocks: string[], summary: string): SkillAliasPlan =>
    ({ alias, path, state, operations: blocks.length ? [] : operations, blocks, summary });
  if (ctx.rootState === "other") {
    const reason = `.agents/skills is not a directory; refusing to plan ${alias}`;
    return done("unsupported", [], [reason], `${alias}: blocked (${reason})`);
  }
  const cliStat = lstatOrUndefined(cliRoot);
  if (cliStat && (cliStat.isSymbolicLink() || !cliStat.isDirectory())) {
    const reason = `${cliName} is not a real configuration directory`;
    return done("unsupported", [], [reason], `${alias}: blocked (${reason})`);
  }
  const stat = cliStat ? lstatOrUndefined(path) : undefined;
  if (!stat) {
    const operations: SkillRootOperation[] = [];
    if (!cliStat) operations.push({ kind: "create-cli-root", path: cliRoot, detail: `create ${cliName}` });
    operations.push({ kind: "create-alias", path, target: CANONICAL_CLI_SKILLS_ALIAS, detail: `create ${alias} -> ${CANONICAL_CLI_SKILLS_ALIAS}` });
    return done("absent", operations, [], `${alias}: absent — create ${CANONICAL_CLI_SKILLS_ALIAS}`);
  }
  if (stat.isSymbolicLink()) {
    const text = readlinkSync(path);
    const real = realpathOrUndefined(path);
    if (ctx.rootState === "absent" && resolve(cliRoot, text) === ctx.root) {
      // Lexically the root: skillex accepts it and creates the root itself.
      return done("alias", [], [], `${alias}: alias (activation root not created yet)`);
    }
    if (!real) {
      return done("dangling", [{ kind: "replace-dangling-alias", path, target: CANONICAL_CLI_SKILLS_ALIAS,
        detail: `replace dangling ${alias} -> ${text} with ${CANONICAL_CLI_SKILLS_ALIAS}` }], [], `${alias}: dangling link to ${text} — replace`);
    }
    if (ctx.rootReal !== undefined && real === ctx.rootReal) {
      if (text === CANONICAL_CLI_SKILLS_ALIAS) return done("alias", [], [], `${alias}: alias`);
      return done("relink", [{ kind: "relink-alias", path, target: CANONICAL_CLI_SKILLS_ALIAS,
        detail: `relink ${alias}: ${text} -> ${CANONICAL_CLI_SKILLS_ALIAS}` }], [], `${alias}: link to ${text} reaches .agents/skills — relink canonically`);
    }
    const reason = `${alias} is a symlink to ${text} (resolves to ${real}), not .agents/skills; refusing to replace it`;
    return done("foreign-link", [], [reason], `${alias}: blocked (${reason})`);
  }
  if (stat.isDirectory()) {
    const planned = planRealDirectoryAlias(ctx, alias, path);
    return done("real-directory", planned.operations, planned.blocks, planned.summary);
  }
  const reason = `${alias} is neither a directory nor a symlink`;
  return done("unsupported", [], [reason], `${alias}: blocked (${reason})`);
}

/** Read-only plan for the selected aliases. Audits call this; it writes nothing. */
export function planSkillRoots(repoRoot: string, options: SkillRootsOptions = {}): SkillRootsPlan {
  const root = join(repoRoot, ".agents", "skills");
  const rootStat = lstatOrUndefined(root);
  const rootState: SkillRootsPlan["rootState"] = !rootStat ? "absent"
    : rootStat.isSymbolicLink() ? "symlink" : rootStat.isDirectory() ? "directory" : "other";
  const deviceOf = (path: string): number | undefined => {
    try { return statSync(path).dev; } catch { return undefined; }
  };
  const ctx: PlanContext = {
    repoRoot,
    root,
    rootState,
    rootReal: rootState === "absent" ? undefined : realpathOrUndefined(root),
    rootDevice: rootState === "directory" ? deviceOf(root) : deviceOf(dirname(root)) ?? deviceOf(repoRoot),
    claims: new Map(),
  };
  const aliases = (options.aliases ?? SUPPORTED_SKILLS_ALIASES).map((alias) => planAlias(ctx, alias));
  const operations = aliases.flatMap((entry) => entry.operations);
  if (rootState === "absent" && aliases.some((entry) => entry.state === "real-directory" && entry.operations.length)) {
    operations.unshift({ kind: "create-root", path: root, detail: "create .agents/skills (the activation root the converted aliases point at)" });
  }
  const blocks = aliases.flatMap((entry) => entry.blocks);
  return { repoRoot, root, rootState, aliases, operations, blocks, clean: blocks.length === 0 };
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

function verifyAlias(path: string, root: string): void {
  const expected = realpathOrUndefined(root);
  if (expected !== undefined && realpathOrUndefined(path) !== expected) throw new Error(`${path} does not resolve to ${root} after publication`);
  if (expected === undefined && resolve(dirname(path), readlinkSync(path)) !== root) throw new Error(`${path} does not lexically reach ${root}`);
}

function execute(repoRoot: string, root: string, operation: SkillRootOperation): void {
  switch (operation.kind) {
    case "create-root":
      mkdirSync(operation.path, { recursive: true });
      return;
    case "create-cli-root":
      mkdirSync(operation.path);
      return;
    case "create-alias":
      symlinkSync(CANONICAL_CLI_SKILLS_ALIAS, operation.path, "dir");
      verifyAlias(operation.path, root);
      return;
    case "relink-alias":
    case "replace-dangling-alias": {
      // Publish the canonical link beside the old one, then rename over it:
      // rename(2) replaces a symlink atomically, so the alias never goes missing.
      const staged = `${operation.path}.pjangler-${process.pid}`;
      symlinkSync(CANONICAL_CLI_SKILLS_ALIAS, staged, "dir");
      try { renameSync(staged, operation.path); } catch (error) { rmSync(staged, { force: true }); throw error; }
      verifyAlias(operation.path, root);
      return;
    }
    case "untrack": {
      const removed = spawnSync("git", ["rm", "-r", "--cached", "--quiet", "--", ...(operation.tracked ?? [])], { cwd: repoRoot, encoding: "utf8" });
      if (removed.status !== 0) throw new Error(`git rm --cached failed: ${removed.stderr.trim()}`);
      return;
    }
    case "drop-dangling-link":
    case "drop-duplicate-link":
      if (!lstatSync(operation.path).isSymbolicLink()) throw new Error(`${operation.path} is no longer a symlink`);
      unlinkSync(operation.path);
      return;
    case "move-link":
    case "move-entry": {
      if (lstatOrUndefined(operation.path)) throw new Error(`${operation.path} appeared before the move`);
      renameSync(operation.from!, operation.path);
      if (operation.expected !== undefined && realpathOrUndefined(operation.path) !== operation.expected) {
        renameSync(operation.path, operation.from!);
        throw new Error(`${operation.path} would not resolve to ${operation.expected}`);
      }
      return;
    }
    case "recreate-link": {
      symlinkSync(operation.target!, operation.path);
      if (realpathOrUndefined(operation.path) !== operation.expected) {
        unlinkSync(operation.path);
        throw new Error(`${operation.path} would not resolve to ${operation.expected}`);
      }
      unlinkSync(operation.from!);
      return;
    }
    case "drop-duplicate-entry": {
      // Re-prove right before the only recursive removal in this module.
      const gap = treeContainmentGap(operation.path, operation.counterpart!);
      if (gap) throw new Error(`${operation.path} is no longer a duplicate: ${gap}`);
      rmSync(operation.path, { recursive: true });
      return;
    }
    case "convert-alias": {
      const left = readdirSync(operation.path);
      if (left.length) throw new Error(`${operation.path} is not empty (${left[0]})`);
      rmdirSync(operation.path);
      symlinkSync(CANONICAL_CLI_SKILLS_ALIAS, operation.path, "dir");
      verifyAlias(operation.path, root);
      return;
    }
  }
}

/**
 * Plan, then execute each alias whose plan is clean. Blocked aliases are left
 * untouched and reported. A dry run writes nothing and reports the plan.
 *
 * Every alias is re-planned from the filesystem immediately before it runs, so
 * an earlier alias's moves are seen (two aliases can never both move a name into
 * `.agents/skills`), and an interrupted run resumes from whatever is on disk.
 */
export function applySkillRoots(repoRoot: string, options: SkillRootsOptions & { dryRun: boolean }): SkillRootsResult {
  const plan = planSkillRoots(repoRoot, options);
  if (options.dryRun) {
    return {
      ok: plan.clean,
      changedFiles: [...new Set(plan.operations.flatMap(changedPaths))].sort(),
      details: [...plan.operations.map((operation) => `would ${operation.detail}`), ...plan.blocks.map((reason) => `blocked: ${reason}`)],
      blocks: plan.blocks,
      plan,
    };
  }
  const changedFiles: string[] = [];
  const details: string[] = [];
  const blocks: string[] = [];
  for (const alias of options.aliases ?? SUPPORTED_SKILLS_ALIASES) {
    const current = planSkillRoots(repoRoot, { aliases: [alias] });
    blocks.push(...current.blocks);
    for (const operation of current.operations) {
      try {
        execute(repoRoot, current.root, operation);
      } catch (error) {
        blocks.push(`${alias}: stopped at ${operation.kind} ${operation.path}: ${error instanceof Error ? error.message : String(error)}; re-run to resume from the current state`);
        break;
      }
      changedFiles.push(...changedPaths(operation));
      details.push(operation.detail);
    }
  }
  return { ok: blocks.length === 0, changedFiles: [...new Set(changedFiles)].sort(), details, blocks: [...new Set(blocks)], plan };
}
