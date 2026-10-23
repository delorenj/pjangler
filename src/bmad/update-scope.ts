import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { PROJECT_CLI_ALIASES } from "@delorenj/skillex";
import { backupToSnapshot, captureScopedRoots, restoreSingleEntry, type TreeBackup, type TreeBackupEntry } from "../utils/tree-restore";
import { changedTreePaths, snapshotTree, type TreeSnapshot } from "../utils/tree-diff";
import { installerFingerprint, VERIFIED_BMAD_INSTALLERS } from "./verified-installers";

/**
 * PJAN-180: the BMAD-update rollback scope.
 *
 * Every repo path a bmad-method update can touch falls into exactly one class:
 *
 * A. INSTALLER CONTENT ROOTS (`installerRoots`): `_bmad` (minus the per-user
 *    `_bmad/_memory` and `_bmad/memory`), the `_bmad-*-backup-temp` siblings,
 *    every selected IDE's target_dir / commands_target_dir / handler files, the
 *    project CLI aliases and `.agents/skills`. Byte-exact backup, ALWAYS
 *    restored on failure.
 * B. COMPANION-WINDOW ROOTS (`companionRoots`): `.project.json`, `.agents`
 *    (minus A), `_bmad/_memory`, `_bmad/memory`. The installer never writes
 *    them; on failure only the paths the g33 companion's own window inventory
 *    lists are restored (all of B when that inventory failed).
 * C. STRUCTURAL PATHS (`structuralPaths`): module.yaml `directories` and
 *    `{project-root}` config values. Identity only: a moved dir is renamed back
 *    on a dev+ino match and created dirs are removed only while EMPTY. A file
 *    in C is never unlinked.
 *
 * Nothing outside A ∪ B ∪ C is read, written, chmodded, deleted or recreated.
 * The declared scope is used only for a fingerprint-verified installer; every
 * other case is `whole-tree`, today's rollback.
 */
export interface BmadUpdateScope {
  mode: "declared" | "whole-tree";
  reason: string;
  installerVersion?: string;
  fingerprint?: string;
  ides: string[];
  installerRoots: string[];
  companionRoots: string[];
  structuralPaths: string[];
  directoryKeys: string[];
}

/** What rules.ts resolved for the installer that will run. */
export interface BmadInstallerPackage {
  root?: string;
  entry?: string;
  version?: string;
  reason?: string;
}

export type Structural =
  | { kind: "absent"; firstMissing: string }
  | { kind: "dir"; dev: number; ino: number }
  | { kind: "other" }
  | { kind: "unknown"; code: string };

export interface ScopedBackup {
  scope: BmadUpdateScope;
  a: TreeBackup;
  b: TreeBackup;
  /** A/B root -> its highest ancestor that did not exist at capture. */
  absentAncestors: Map<string, string>;
  structural: Map<string, Structural>;
  capturedAt: number;
}

/** Per-user agent state inside `_bmad` the installer never writes (installer.js detectCustomFiles). */
export const BMAD_MEMORY_CARVE_OUTS: readonly string[] = Object.freeze(["_bmad/_memory", "_bmad/memory"]);

/** Repo files an IDE handler's cleanup rewrites outside its target dirs (_config-driven.js). */
export const BMAD_HANDLER_FILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "github-copilot": [".github/copilot-instructions.md", ".github/copilot-instructions.md.bak"],
  kilo: [".kilocodemodes"],
  "rovo-dev": [".rovodev/prompts.yml"],
});

/** The installer's own update temp dirs at the project root (installer.js _backupUserFiles). */
export const BMAD_BACKUP_TEMP_ROOTS: readonly string[] = Object.freeze(["_bmad-custom-backup-temp", "_bmad-modified-backup-temp"]);

export class UnreadableSurfaceError extends Error {
  constructor(readonly rel: string, readonly code: string) {
    super(`unreadable entry inside BMAD-owned surface ${rel} (${code})`);
  }
}

const posix = (path: string): string => path.split(/[\\/]/).filter(Boolean).join("/");
/** True when `rel` is `base` or inside it (both repo-relative, posix). */
export const within = (rel: string, base: string): boolean => rel === base || rel.startsWith(`${base}/`);
const depthOf = (rel: string): number => rel.split("/").length;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

function wholeTree(reason: string, extra: Partial<BmadUpdateScope> = {}): BmadUpdateScope {
  return { mode: "whole-tree", reason, ides: [], installerRoots: [], companionRoots: [], structuralPaths: [], directoryKeys: [], ...extra };
}

/** Drop roots nested inside another root of the same list; keep order stable and deduped. */
function foldRoots(roots: Iterable<string>): string[] {
  const unique = [...new Set([...roots].map(posix).filter(Boolean))].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  const kept: string[] = [];
  for (const root of unique) if (!kept.some((base) => within(root, base))) kept.push(root);
  return kept.sort();
}

/** A repo-relative installer path from platform-codes.yaml, or undefined when it escapes the repo. */
function repoRelative(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) return false;
  if (isAbsolute(value) || value.startsWith("~")) return false;
  const rel = posix(normalize(value));
  if (!rel || rel === "." || rel.startsWith("..")) return false;
  return rel;
}

/**
 * Every in-repo path a symlinked component of `rel` resolves to. A link that
 * resolves outside the repo (or dangles) cannot be scoped: the caller falls
 * back to whole-tree, today's behaviour.
 */
function linkedRoots(repo: string, realRepo: string, rel: string): { roots: string[] } | { outside: string } {
  const out: string[] = [];
  const queue = [rel];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 64) return { outside: `${rel} has a symlink cycle` };
    const parts = current.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      let stat;
      try { stat = lstatSync(join(repo, prefix)); }
      catch { break; } // absent (nothing to follow) or unreadable (the capture fails closed on it)
      if (!stat.isSymbolicLink()) {
        if (stat.isDirectory()) continue;
        break; // a regular file where a dir is expected: recorded by the capture, the installer fails on it
      }
      let target: string;
      try { target = realpathSync(join(repo, prefix)); }
      catch { return { outside: `${current} resolves outside the repo via ${prefix} (dangling link)` }; }
      const relTarget = relative(realRepo, target);
      if (relTarget.startsWith("..") || isAbsolute(relTarget)) return { outside: `${current} resolves outside the repo via ${prefix}` };
      const resolved = posix([relTarget, ...parts.slice(depth)].join("/"));
      if (!resolved) return { outside: `${current} resolves to the repo root via ${prefix}` };
      out.push(resolved);
      queue.push(resolved);
      break;
    }
  }
  return { roots: out };
}

function readYamlFile(path: string): unknown {
  return YAML.parse(readFileSync(path, "utf8"));
}

/** module.yaml files of the resolved package and of the external-module cache (depth <= 4). */
function moduleYamlFiles(pkgRoot: string): string[] {
  const files: string[] = [];
  const src = join(pkgRoot, "src");
  try {
    for (const name of readdirSync(src).sort()) {
      const path = join(src, name, "module.yaml");
      if (existsSync(path)) files.push(path);
    }
  } catch { /* a package without src/ declares nothing */ }
  const cache = process.env.BMAD_EXTERNAL_MODULES_CACHE || join(homedir(), ".bmad", "cache", "external-modules");
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === "module.yaml") files.push(join(dir, entry.name));
    }
  };
  walk(cache, 1);
  return files;
}

interface ModuleDefinition { default?: unknown; result?: unknown }

function moduleDefinitions(files: string[]): { directoryKeys: Set<string>; definitions: Map<string, ModuleDefinition> } {
  const directoryKeys = new Set<string>(["output_folder"]);
  const definitions = new Map<string, ModuleDefinition>();
  for (const file of files) {
    let parsed: unknown;
    try { parsed = readYamlFile(file); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.directories)) {
      for (const ref of record.directories) {
        const match = typeof ref === "string" ? ref.match(/^\{([^}]+)\}$/) : null;
        if (match) directoryKeys.add(match[1]!);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const definition = value as ModuleDefinition;
      if (!("default" in definition) && !("result" in definition)) continue;
      if (!definitions.has(key)) definitions.set(key, definition);
      const texts = [definition.default, definition.result].filter((text): text is string => typeof text === "string");
      if (texts.some((text) => text.includes("{project-root}"))) directoryKeys.add(key);
    }
  }
  return { directoryKeys, definitions };
}

/** The BMAD dirs the installer may read config from: `_bmad` plus every top-level dir holding `_config/manifest.yaml`. */
function bmadConfigDirs(root: string): string[] {
  const dirs = new Set<string>(["_bmad"]);
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(root, entry.name, "_config", "manifest.yaml"))) dirs.add(entry.name);
  }
  return [...dirs].sort();
}

/**
 * Every string config value (key -> values) the installer could treat as an
 * existing answer: `[core]` and `[modules.*]` of config.toml / config.user.toml,
 * and legacy `<dir>/<module>/config.yaml`, across every BMAD dir. Throws on an
 * unparseable config.toml: a missed old value would miss a move.
 */
function collectConfigValues(root: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const add = (key: string, value: unknown) => {
    if (typeof value !== "string") return;
    const list = values.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    values.set(key, list);
  };
  const addSection = (section: unknown) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) return;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) add(key, value);
  };
  for (const dir of bmadConfigDirs(root)) {
    for (const name of ["config.toml", "config.user.toml"]) {
      const path = join(root, dir, name);
      let text: string;
      try { text = readFileSync(path, "utf8"); }
      catch (error) { if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") continue; throw error; }
      let parsed: Record<string, unknown>;
      try { parsed = parseToml(text) as Record<string, unknown>; }
      catch (error) { throw new Error(`${dir}/${name} is not parseable TOML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`); }
      addSection(parsed.core);
      const modules = parsed.modules;
      if (modules && typeof modules === "object" && !Array.isArray(modules)) {
        for (const section of Object.values(modules as Record<string, unknown>)) addSection(section);
      }
    }
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, dir, entry.name, "config.yaml");
      if (!existsSync(path)) continue;
      try { addSection(readYamlFile(path)); } catch { /* the installer ignores an unparseable legacy config too */ }
    }
  }
  return values;
}

/** Predict a key's installer default when no existing answer exists (the --yes semantics). */
function predictDefaults(root: string, keys: Set<string>, existing: Map<string, string[]>, definitions: Map<string, ModuleDefinition>): Map<string, string> {
  const known = new Map<string, string>();
  for (const [key, list] of existing) if (list[0] !== undefined) known.set(key, list[0]);
  known.set("directory_name", basename(root));
  const predicted = new Map<string, string>();
  const pending = new Map<string, string>();
  for (const [key, definition] of definitions) {
    if (existing.has(key)) continue;
    const def = definition.default;
    if (typeof def !== "string" && typeof def !== "number" && typeof def !== "boolean") continue;
    const result = typeof definition.result === "string" ? definition.result : "{value}";
    pending.set(key, result.replaceAll("{value}", String(def)));
  }
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [key, text] of pending) {
      const next = text.replace(/\{([^}]+)\}/g, (whole, name: string) => name === "project-root" ? whole : known.get(name) ?? predicted.get(name) ?? whole);
      if (next !== text) { pending.set(key, next); changed = true; }
      if (!predicted.has(key) && !/\{(?!project-root\})[^}]+\}/.test(next)) { predicted.set(key, next); changed = true; }
    }
    if (!changed) break;
  }
  return new Map([...predicted].filter(([key]) => keys.has(key)));
}

/** official-modules.js createModuleDirectories path rules; undefined when not strictly inside the repo. */
export function normalizeDirectoryValue(root: string, value: string): string | undefined {
  let path = value.replace(/^\{project-root\}\/?/, "");
  path = path.replaceAll("{project-root}", "");
  const full = normalize(join(root, path));
  const rel = relative(normalize(root), full);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return posix(rel);
}

/**
 * Derive the update's rollback scope. Read-only, and run before the preflight.
 * Any input it cannot verify yields `whole-tree` with the reason.
 */
export function deriveBmadUpdateScope(
  projectRoot: string,
  options: {
    tools: readonly string[];
    installer: BmadInstallerPackage;
    companionSurfaces: readonly string[];
    /** Test seam for the verified list; production always uses VERIFIED_BMAD_INSTALLERS. */
    verified?: Readonly<Record<string, string>>;
  },
): BmadUpdateScope {
  const root = projectRoot;
  const pkg = options.installer;
  if (!pkg.root) return wholeTree(pkg.reason ?? "the bmad-method installer package could not be resolved");
  const version = pkg.version ?? "unknown";
  let fingerprint: string;
  try { fingerprint = installerFingerprint(pkg.root); }
  catch (error) { return wholeTree(`bmad-method ${version} installer could not be fingerprinted: ${error instanceof Error ? error.message : String(error)}`, { installerVersion: version }); }
  const verified = options.verified ?? VERIFIED_BMAD_INSTALLERS;
  if (!Object.hasOwn(verified, fingerprint)) {
    return wholeTree(`bmad-method ${version} installer ${fingerprint.slice(0, 12)} is not surface-verified; run mise run bmad:verify-surface ${version}`,
      { installerVersion: version, fingerprint });
  }
  const base = { installerVersion: version, fingerprint };

  let platforms: Record<string, { installer?: Record<string, unknown> }>;
  try {
    const parsed = readYamlFile(join(pkg.root, "tools", "installer", "ide", "platform-codes.yaml")) as { platforms?: unknown };
    if (!parsed?.platforms || typeof parsed.platforms !== "object") throw new Error("no platforms map");
    platforms = parsed.platforms as typeof platforms;
  } catch (error) {
    return wholeTree(`bmad-method ${version} platform-codes.yaml is unreadable: ${error instanceof Error ? error.message : String(error)}`, base);
  }
  let manifestIdes: string[] = [];
  const manifestPath = join(root, "_bmad", "_config", "manifest.yaml");
  if (existsSync(manifestPath)) {
    try {
      const parsed = readYamlFile(manifestPath) as { ides?: unknown } | null;
      if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("not a mapping");
      const ides = parsed?.ides;
      if (ides !== undefined && ides !== null && !Array.isArray(ides)) throw new Error("ides is not a list");
      manifestIdes = (Array.isArray(ides) ? ides : []).filter((id): id is string => typeof id === "string");
    } catch (error) {
      return wholeTree(`_bmad/_config/manifest.yaml is unparseable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, base);
    }
  }
  // Unknown ids are skipped, exactly as the installer skips them.
  const ides = [...new Set([...manifestIdes, ...options.tools])].filter((id) => Object.hasOwn(platforms, id)).sort();

  const installer = new Set<string>(["_bmad", ...BMAD_BACKUP_TEMP_ROOTS, ".agents/skills", ...PROJECT_CLI_ALIASES]);
  for (const id of ides) {
    const config = platforms[id]?.installer ?? {};
    for (const field of ["target_dir", "commands_target_dir"]) {
      const rel = repoRelative(config[field]);
      if (rel === false) return wholeTree(`platform ${id} ${field} is not a repo-relative path: ${String(config[field])}`, base);
      if (rel) installer.add(rel);
    }
    for (const file of BMAD_HANDLER_FILES[id] ?? []) installer.add(file);
  }

  const realRoot = realpathSync(root);
  const aRoots = new Set(foldRoots(installer));
  for (const rel of [...aRoots]) {
    const linked = linkedRoots(root, realRoot, rel);
    if ("outside" in linked) return wholeTree(linked.outside, base);
    for (const extra of linked.roots) aRoots.add(extra);
  }
  const installerRoots = foldRoots(aRoots);
  for (const rel of installerRoots) {
    if (BMAD_MEMORY_CARVE_OUTS.some((carve) => within(rel, carve))) return wholeTree(`installer root ${rel} lies inside per-user BMAD memory`, base);
  }

  // B: every companion surface the installer roots do not cover, plus the A carve-outs.
  const bRoots = new Set<string>(BMAD_MEMORY_CARVE_OUTS);
  for (const surface of options.companionSurfaces.map(posix)) {
    if (!installerRoots.some((a) => within(surface, a))) bRoots.add(surface);
  }
  for (const rel of [...bRoots]) {
    const linked = linkedRoots(root, realRoot, rel);
    if ("outside" in linked) return wholeTree(linked.outside, base);
    for (const extra of linked.roots) {
      if (installerRoots.some((a) => within(extra, a)) && !BMAD_MEMORY_CARVE_OUTS.some((carve) => within(extra, carve))) continue;
      bRoots.add(extra);
    }
  }
  const companionRoots = foldRoots(bRoots);

  // C: module.yaml directory keys, their existing values (old values of a move) and predicted defaults.
  const { directoryKeys, definitions } = moduleDefinitions(moduleYamlFiles(pkg.root));
  let existing: Map<string, string[]>;
  try { existing = collectConfigValues(root); }
  catch (error) { return wholeTree(error instanceof Error ? error.message : String(error), base); }
  for (const [key, list] of existing) if (list.some((value) => value.includes("{project-root}"))) directoryKeys.add(key);
  const candidates: string[] = [];
  for (const key of directoryKeys) candidates.push(...(existing.get(key) ?? []));
  for (const value of predictDefaults(root, directoryKeys, existing, definitions).values()) candidates.push(value);
  const covered = (rel: string) => installerRoots.some((a) => within(rel, a)) || companionRoots.some((b) => within(rel, b));
  const structuralPaths = [...new Set(candidates
    .map((value) => normalizeDirectoryValue(root, value))
    .filter((rel): rel is string => Boolean(rel) && !covered(rel!)))].sort();

  return {
    mode: "declared",
    reason: `bmad-method ${version} installer ${fingerprint.slice(0, 12)} is surface-verified`,
    ...base, ides, installerRoots, companionRoots, structuralPaths, directoryKeys: [...directoryKeys].sort(),
  };
}

interface Excluder { (rel: string): boolean; roots: readonly string[] }

const excluder = (roots: string[]): Excluder => Object.assign((rel: string) => roots.some((root) => within(rel, root)), { roots });

/** Repo-relative exclusion for one class: anything inside a root of the other class nested in it. */
function classExcluders(scope: BmadUpdateScope): { a: Excluder; b: Excluder } {
  const bInA = scope.companionRoots.filter((b) => scope.installerRoots.some((a) => b !== a && within(b, a)));
  const aInB = scope.installerRoots.filter((a) => scope.companionRoots.some((b) => a !== b && within(a, b)));
  return { a: excluder(bInA), b: excluder(aInB) };
}

function firstMissingAncestor(root: string, rel: string): string | undefined {
  const parts = rel.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    try { lstatSync(join(root, prefix)); }
    catch (error) { if (errno(error) === "ENOENT") return prefix; return undefined; }
  }
  return undefined;
}

function structuralState(root: string, rel: string): Structural {
  try {
    const stat = lstatSync(join(root, rel));
    if (stat.isDirectory() && !stat.isSymbolicLink()) return { kind: "dir", dev: stat.dev, ino: stat.ino };
    return { kind: "other" };
  } catch (error) {
    const code = errno(error) ?? "EUNKNOWN";
    if (code === "ENOENT") return { kind: "absent", firstMissing: firstMissingAncestor(root, rel) ?? rel };
    return { kind: "unknown", code };
  }
}

function captureClass(root: string, roots: string[], exclude: (rel: string) => boolean): TreeBackup {
  try { return captureScopedRoots(root, roots, { exclude }); }
  catch (error) {
    const code = errno(error);
    if (code === "EACCES" || code === "EPERM") {
      const path = (error as NodeJS.ErrnoException).path;
      throw new UnreadableSurfaceError(path ? posix(relative(root, path)) || "." : "?", code);
    }
    throw error;
  }
}

/**
 * Byte-exact capture of A and B, identity capture of C. An unreadable entry
 * inside A or B throws UnreadableSurfaceError BEFORE anything is written.
 */
export function captureScopedBackup(projectRoot: string, scope: BmadUpdateScope): ScopedBackup {
  if (scope.mode !== "declared") throw new Error("captureScopedBackup needs a declared scope");
  const root = projectRoot;
  const exclude = classExcluders(scope);
  const capturedAt = Date.now() - 2000; // clock slack for birthtime comparisons
  const a = captureClass(root, scope.installerRoots, exclude.a);
  const b = captureClass(root, scope.companionRoots, exclude.b);
  const absentAncestors = new Map<string, string>();
  for (const rel of [...scope.installerRoots, ...scope.companionRoots]) {
    const missing = firstMissingAncestor(root, rel);
    if (missing) absentAncestors.set(rel, missing);
  }
  const structural = new Map<string, Structural>();
  for (const rel of scope.structuralPaths) structural.set(rel, structuralState(root, rel));
  return { scope, a, b, absentAncestors, structural, capturedAt };
}

/** The live snapshot of one class, shaped exactly like backupToSnapshot of its capture. */
function liveClassSnapshot(root: string, roots: string[], exclude: (rel: string) => boolean): TreeSnapshot {
  const live = snapshotTree(root, { roots, tolerateUnreadable: true });
  for (const [rel, value] of [...live]) {
    if (exclude(rel) || value.startsWith("other:")) live.delete(rel);
  }
  return live;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The installer's `Moved directories:` / `Created directories:` report (installer.js, printed after module dirs). */
export function parseInstallerDirectoryLines(stdout: string): { moved: { name: string; from: string; to: string }[]; created: { name: string; path: string }[] } {
  const moved: { name: string; from: string; to: string }[] = [];
  const created: { name: string; path: string }[] = [];
  let mode: "moved" | "created" | undefined;
  for (const raw of stdout.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s│|┃╎◆◇●○■▲│]*/u, "").trimEnd();
    if (line === "Moved directories:") { mode = "moved"; continue; }
    if (line === "Created directories:") { mode = "created"; continue; }
    if (!mode) continue;
    if (mode === "moved") {
      const match = line.match(/^([^:]+): (.+?) → (.+)$/);
      if (match) { moved.push({ name: match[1]!.trim(), from: match[2]!.trim(), to: match[3]!.trim() }); continue; }
    } else {
      const match = line.match(/^([^:]+): (.+)$/);
      if (match && !match[2]!.includes(" → ")) { created.push({ name: match[1]!.trim(), path: match[2]!.trim() }); continue; }
    }
    mode = undefined;
  }
  return { moved, created };
}

// ---------------------------------------------------------------------------
// Displaced-bytes stash and the per-repo update lock
// ---------------------------------------------------------------------------

function stateBase(root: string): string {
  const preferred = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  let real = root;
  try { real = realpathSync(root); } catch { /* keep the given root */ }
  const inside = (path: string) => { const rel = relative(real, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  // Never inside the repo being rolled back: that would be a write outside the surface.
  return inside(preferred) ? join(homedir(), ".local", "state") : preferred;
}

function repoKey(root: string): string {
  let real = root;
  try { real = realpathSync(root); } catch { /* keep the given root */ }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

export interface DisplacedStash {
  /** The run dir once anything was stashed. */
  readonly dir: string | undefined;
  readonly count: number;
  /** Record the CURRENT bytes at `rel` before the rollback overwrites or removes them. */
  put(rel: string): void;
  /** Write the index and prune old runs; returns the run dir when anything was stashed. */
  close(): string | undefined;
}

const STASH_RUNS_KEPT = 5;
let stashSequence = 0;

/**
 * Where a rollback puts the bytes it displaces:
 * `${XDG_STATE_HOME:-~/.local/state}/pjangler/bmad-rollback/<sha12(realpath root)>/<iso>-<pid>/`,
 * content-addressed `objects/<sha256>` plus `index.json`. Never $TMPDIR (on
 * this host it lies inside another git work tree) and never inside the repo.
 */
export function openDisplacedStash(projectRoot: string): DisplacedStash {
  const root = projectRoot;
  const repoDir = join(stateBase(root), "pjangler", "bmad-rollback", repoKey(root));
  let dir: string | undefined;
  let count = 0;
  const index: { rel: string; kind: "file" | "link" | "dir"; mode?: number; target?: string; object?: string }[] = [];
  const open = (): string => {
    if (dir) return dir;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    dir = join(repoDir, `${stamp}-${process.pid}-${String(++stashSequence).padStart(4, "0")}`);
    mkdirSync(join(dir, "objects"), { recursive: true });
    return dir;
  };
  return {
    get dir() { return dir; },
    get count() { return count; },
    put(rel: string) {
      const full = join(root, rel);
      let stat;
      try { stat = lstatSync(full); } catch { return; }
      if (stat.isSymbolicLink()) {
        open();
        index.push({ rel, kind: "link", target: readlinkSync(full) });
        count++;
      } else if (stat.isFile()) {
        const bytes = readFileSync(full);
        const object = createHash("sha256").update(bytes).digest("hex");
        const target = join(open(), "objects", object);
        if (!existsSync(target)) writeFileSync(target, bytes);
        index.push({ rel, kind: "file", mode: stat.mode & 0o7777, object });
        count++;
      } else if (stat.isDirectory()) {
        open();
        index.push({ rel, kind: "dir", mode: stat.mode & 0o7777 });
      }
    },
    close() {
      if (!dir) return undefined;
      writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
      try {
        const runs = readdirSync(repoDir).sort();
        for (const old of runs.slice(0, Math.max(0, runs.length - STASH_RUNS_KEPT))) rmSync(join(repoDir, old), { recursive: true, force: true });
      } catch { /* pruning is housekeeping */ }
      return dir;
    },
  };
}

export interface BmadUpdateLock { ok: true; path: string; release: () => void }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errno(error) !== "ESRCH"; }
}

/**
 * Serialize pj BMAD updates per repo:
 * `${XDG_STATE_HOME:-~/.local/state}/pjangler/bmad-update/<sha12(realpath root)>.lock`,
 * created O_EXCL with the holder's pid. A lock whose pid is dead is taken over.
 */
export function acquireBmadUpdateLock(projectRoot: string): BmadUpdateLock | { ok: false; error: string } {
  const dir = join(stateBase(projectRoot), "pjangler", "bmad-update");
  const path = join(dir, `${repoKey(projectRoot)}.lock`);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o644);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return {
        ok: true, path,
        release: () => {
          try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
        },
      };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    let holder = NaN;
    try { holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch { continue; }
    if (Number.isInteger(holder) && holder > 0) {
      if (pidAlive(holder)) return { ok: false, error: `another pj BMAD update is running on this repo (pid ${holder})` };
    } else {
      // A holder that has not written its pid yet is live unless the file is stale.
      let age = 0;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; }
      if (age < 60_000) return { ok: false, error: "another pj BMAD update is running on this repo (pid unknown)" };
    }
    try { unlinkSync(path); } catch { /* raced with another taker */ }
  }
  return { ok: false, error: "could not take the pj BMAD update lock for this repo" };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface ScopedRollbackOptions {
  /** The g33 companion's window inventory (absolute or repo-relative), or all/none of B. */
  companionChanged: string[] | "all" | "none";
  installerStdout?: string;
}

const deepestFirst = (a: string, b: string) => depthOf(b) - depthOf(a) || b.localeCompare(a);
const shallowestFirst = (a: string, b: string) => depthOf(a) - depthOf(b) || a.localeCompare(b);

function sameEntry(current: TreeBackupEntry, saved: TreeBackupEntry): boolean {
  if (current.kind !== saved.kind) return false;
  if (current.kind === "link") return current.target === (saved as typeof current).target;
  if (current.kind === "dir") return true; // modes are re-applied separately
  return current.mode === (saved as typeof current).mode && current.bytes.equals((saved as typeof current).bytes);
}

/**
 * restoreTreeBackup's algorithm with the inventory confined to `roots`. Every
 * byte it displaces goes to the stash first.
 */
function restoreClass(root: string, roots: string[], saved: TreeBackup, exclude: Excluder, stash: DisplacedStash): void {
  const current = captureScopedRoots(root, roots, { exclude });
  for (const [rel, entry] of current) {
    if (entry.kind === "dir" && (entry.mode & 0o700) !== 0o700) chmodSync(join(root, rel), entry.mode | 0o700);
  }
  const removed = [...current.keys()].filter((rel) => !saved.has(rel)).sort(deepestFirst);
  for (const rel of removed) {
    stash.put(rel);
    const full = join(root, rel);
    try {
      const stat = lstatSync(full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unlinkSync(full);
      // A dir holding the other class's root (the _bmad memory carve-outs) is only ever rmdir'd.
      else if (exclude.roots.some((other) => other !== rel && within(other, rel))) rmdirSync(full);
      else rmSync(full, { recursive: true, force: true });
    } catch (error) { if (errno(error) !== "ENOENT") throw error; }
  }
  const dirs = [...saved.entries()]
    .filter((pair): pair is [string, Extract<TreeBackupEntry, { kind: "dir" }>] => pair[1].kind === "dir")
    .sort(([a], [b]) => shallowestFirst(a, b));
  for (const [rel, entry] of dirs) {
    const now = current.get(rel);
    if (now && now.kind !== "dir") stash.put(rel);
    restoreSingleEntry(root, rel, { ...entry, mode: entry.mode | 0o700 });
  }
  for (const [rel, entry] of saved) {
    if (entry.kind === "dir") continue;
    const now = current.get(rel);
    if (now && sameEntry(now, entry)) continue;
    if (now) stash.put(rel);
    restoreSingleEntry(root, rel, entry);
  }
  for (const [rel, entry] of [...dirs].reverse()) chmodSync(join(root, rel), entry.mode);
}

/** Class B narrowed to the companion's inventory: no recursive delete, ever. */
function restoreListed(root: string, sb: ScopedBackup, listed: string[], exclude: Excluder, stash: DisplacedStash, problems: string[]): void {
  const inB = (rel: string) => sb.scope.companionRoots.some((b) => within(rel, b)) && !exclude(rel);
  const rels = [...new Set(listed.map((path) => posix(isAbsolute(path) ? relative(root, path) : path)))].filter((rel) => rel && !rel.startsWith("..") && inB(rel));
  for (const rel of rels.filter((rel) => !sb.b.has(rel)).sort(deepestFirst)) {
    const full = join(root, rel);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      try { rmdirSync(full); }
      catch (error) {
        if (errno(error) === "ENOTEMPTY" || errno(error) === "EEXIST") problems.push(`kept non-empty companion dir ${rel}`);
        else throw error;
      }
    } else {
      stash.put(rel);
      unlinkSync(full);
    }
  }
  for (const rel of rels.filter((rel) => sb.b.has(rel)).sort(shallowestFirst)) {
    const entry = sb.b.get(rel)!;
    const full = join(root, rel);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
    if (entry.kind === "dir") {
      if (stat && !(stat.isDirectory() && !stat.isSymbolicLink())) { stash.put(rel); unlinkSync(full); }
      restoreSingleEntry(root, rel, entry);
      continue;
    }
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      try { rmdirSync(full); }
      catch { problems.push(`cannot restore ${rel}: a non-empty directory is in its place`); continue; }
    } else if (stat) {
      const now: TreeBackupEntry = stat.isSymbolicLink()
        ? { kind: "link", target: readlinkSync(full) }
        : { kind: "file", mode: stat.mode & 0o7777, bytes: readFileSync(full) };
      if (sameEntry(now, entry)) continue;
      stash.put(rel);
    }
    restoreSingleEntry(root, rel, entry);
  }
}

function birthtime(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return stat.birthtimeMs;
  } catch { return undefined; }
}

/** rmdir every EMPTY dir under (and including) `rel`, post-order. Never unlinks a file. */
function pruneEmptyDirs(root: string, rel: string): void {
  const full = join(root, rel);
  let stat;
  try { stat = lstatSync(full); } catch { return; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  let names: string[];
  try { names = readdirSync(full); } catch { return; }
  for (const name of names) pruneEmptyDirs(root, `${rel}/${name}`);
  try { rmdirSync(full); } catch { /* ENOTEMPTY: keep */ }
}

/** rmdir `rel`'s ancestors bottom-up while empty, stopping at `stop` (inclusive) or at `accept` refusing. */
function pruneUp(root: string, rel: string, stop: string | undefined, accept: (rel: string) => boolean = () => true): void {
  let current = dirname(rel);
  while (current && current !== "." && (!stop || within(current, stop))) {
    if (!accept(current)) return;
    try { rmdirSync(join(root, current)); }
    catch (error) { if (errno(error) !== "ENOENT") return; }
    if (current === stop) return;
    current = dirname(current);
  }
}

/** The scoped inventory of what differs from the capture: A and B diffs plus leftover structural nodes. */
export function scopedChangedFiles(projectRoot: string, sb: ScopedBackup, extras: string[] = [], installerStdout?: string): string[] {
  const root = projectRoot;
  const exclude = classExcluders(sb.scope);
  const changed = new Set<string>(changedTreePaths(root, backupToSnapshot(sb.a), liveClassSnapshot(root, sb.scope.installerRoots, exclude.a)));
  for (const path of extras) changed.add(isAbsolute(path) ? path : join(root, path));
  // Where the installer says it moved or created a structural dir.
  const reported = parseInstallerDirectoryLines(installerStdout ?? "");
  for (const value of [...reported.moved.map((move) => move.to), ...reported.created.map((created) => created.path)]) {
    const rel = normalizeDirectoryValue(root, value);
    if (rel && existsSync(join(root, rel))) changed.add(join(root, rel));
  }
  for (const [rel, pre] of sb.structural) {
    const now = structuralState(root, rel);
    if (pre.kind === "absent" && now.kind !== "absent") {
      changed.add(join(root, rel));
      let up = dirname(rel);
      while (up !== "." && within(up, pre.firstMissing)) { if (existsSync(join(root, up))) changed.add(join(root, up)); up = dirname(up); }
    }
    if (pre.kind === "dir" && now.kind === "absent") changed.add(join(root, rel));
  }
  for (const [rel, firstMissing] of sb.absentAncestors) {
    let up = dirname(rel);
    while (up !== "." && within(up, firstMissing)) { if (existsSync(join(root, up))) changed.add(join(root, up)); up = dirname(up); }
  }
  return [...changed].sort();
}

/** The un-move / cleanup candidates the installer may have created: stdout report plus post-run config values. */
function discoveredPaths(root: string, sb: ScopedBackup, stdout: string | undefined): { paths: string[]; listedCreated: Set<string>; problems: string[] } {
  const problems: string[] = [];
  const paths = new Set<string>();
  const listedCreated = new Set<string>();
  const parsed = parseInstallerDirectoryLines(stdout ?? "");
  for (const move of parsed.moved) { const rel = normalizeDirectoryValue(root, move.to); if (rel) paths.add(rel); }
  for (const created of parsed.created) {
    const rel = normalizeDirectoryValue(root, created.path);
    if (rel) { paths.add(rel); listedCreated.add(rel); }
  }
  try {
    const values = collectConfigValues(root);
    for (const key of sb.scope.directoryKeys) {
      for (const value of values.get(key) ?? []) { const rel = normalizeDirectoryValue(root, value); if (rel) paths.add(rel); }
    }
  } catch (error) { problems.push(`could not re-read BMAD config after the failure: ${error instanceof Error ? error.message : String(error)}`); }
  const covered = (rel: string) => sb.scope.installerRoots.some((a) => within(rel, a)) || sb.scope.companionRoots.some((b) => within(rel, b));
  return { paths: [...paths].filter((rel) => !covered(rel)).sort(), listedCreated, problems };
}

/**
 * Roll a failed declared-scope update back: un-move C, restore A, restore the
 * companion's part of B, prune empty created dirs, verify A. Never throws; an
 * incomplete rollback says so with a scoped inventory and the stash path.
 */
export function restoreScopedBackup(projectRoot: string, sb: ScopedBackup, options: ScopedRollbackOptions): { details: string[]; changedFiles: string[] } {
  const root = projectRoot;
  const exclude = classExcluders(sb.scope);
  const problems: string[] = [];
  const reports: string[] = [];
  const leftovers = new Set<string>();
  const stash = openDisplacedStash(root);
  const phase = (label: string, run: () => void) => {
    try { run(); }
    catch (error) { problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  let discovered: ReturnType<typeof discoveredPaths> = { paths: [], listedCreated: new Set(), problems: [] };
  phase("discover", () => { discovered = discoveredPaths(root, sb, options.installerStdout); problems.push(...discovered.problems); });

  // 1. Un-move: a pre-existing structural dir that vanished is renamed back from where the installer put it.
  phase("un-move", () => {
    for (const [rel, pre] of sb.structural) {
      if (pre.kind !== "dir" || structuralState(root, rel).kind !== "absent") continue;
      const candidates = [...new Set([
        ...[...sb.structural].filter(([, state]) => state.kind === "absent" || state.kind === "unknown").map(([path]) => path),
        ...discovered.paths,
      ])].filter((path) => path !== rel);
      let located = false;
      for (const candidate of candidates) {
        let stat;
        try { stat = lstatSync(join(root, candidate)); } catch { continue; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pre.dev || stat.ino !== pre.ino) continue;
        if (existsSync(join(root, rel))) break;
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        renameSync(join(root, candidate), join(root, rel));
        // The move's created parents (deep/ for deep/new-out) go when empty and born in the window.
        const born = (path: string) => { const time = birthtime(join(root, path)); return time !== undefined && time > 0 && time >= sb.capturedAt; };
        const structuralPre = sb.structural.get(candidate);
        pruneUp(root, candidate, structuralPre?.kind === "absent" ? structuralPre.firstMissing : undefined, (path) => structuralPre?.kind === "absent" || born(path));
        located = true;
        break;
      }
      if (!located) { reports.push(`moved, not located: ${rel}`); leftovers.add(join(root, rel)); }
    }
  });

  // 2. Class A: byte-exact.
  phase("installer surface", () => restoreClass(root, sb.scope.installerRoots, sb.a, exclude.a, stash));

  // 3. Class B: only the companion's own window, unless its inventory failed.
  phase("companion surface", () => {
    if (options.companionChanged === "none") return;
    if (options.companionChanged === "all") restoreClass(root, sb.scope.companionRoots, sb.b, exclude.b, stash);
    else restoreListed(root, sb, options.companionChanged, exclude.b, stash, problems);
  });

  // 4. Empty created dirs only: rmdir, never a file.
  phase("cleanup", () => {
    for (const [rel, firstMissing] of sb.absentAncestors) {
      pruneEmptyDirs(root, rel);
      pruneUp(root, rel, firstMissing);
    }
    for (const [rel, pre] of sb.structural) {
      if (pre.kind !== "absent") continue;
      pruneEmptyDirs(root, rel);
      pruneUp(root, rel, pre.firstMissing);
    }
    for (const rel of discovered.paths) {
      if (sb.structural.has(rel) && sb.structural.get(rel)!.kind !== "unknown") continue;
      const time = birthtime(join(root, rel));
      if (time === undefined) continue;
      const bornInWindow = time > 0 && time >= sb.capturedAt;
      if (!bornInWindow && !(time === 0 && discovered.listedCreated.has(rel))) continue;
      pruneEmptyDirs(root, rel);
      if (time > 0) pruneUp(root, rel, undefined, (path) => { const at = birthtime(join(root, path)); return at !== undefined && at > 0 && at >= sb.capturedAt; });
    }
  });

  let stashDir: string | undefined;
  try { stashDir = stash.close(); } catch (error) { problems.push(`stash: ${error instanceof Error ? error.message : String(error)}`); }

  // 5. Verify A.
  let aDiff: string[] = [];
  try {
    aDiff = changedTreePaths(root, backupToSnapshot(sb.a), liveClassSnapshot(root, sb.scope.installerRoots, exclude.a));
    if (aDiff.length) problems.push(`installer surface differs from the capture at ${aDiff.slice(0, 10).map((path) => relative(root, path)).join(", ")}${aDiff.length > 10 ? ` (+${aDiff.length - 10} more)` : ""}`);
  } catch (error) { problems.push(`verify: ${error instanceof Error ? error.message : String(error)}`); }

  const details: string[] = [];
  if (stash.count > 0) details.push(`rollback displaced ${stash.count} path(s) changed during the update window; recover from ${stashDir ?? stash.dir}`);
  details.push(...reports);
  if (!problems.length) return { details, changedFiles: [...leftovers].sort() };
  details.unshift(`rollback incomplete; recover with git: ${problems.join("; ")}${stashDir ? ` (displaced bytes in ${stashDir})` : ""}`);
  const inventory = new Set<string>([...aDiff, ...leftovers]);
  try {
    for (const path of changedTreePaths(root, backupToSnapshot(sb.b), liveClassSnapshot(root, sb.scope.companionRoots, exclude.b))) inventory.add(path);
  } catch { /* best effort */ }
  for (const [rel, pre] of sb.structural) {
    const now = structuralState(root, rel);
    if (now.kind !== pre.kind) inventory.add(join(root, rel));
  }
  return { details, changedFiles: [...inventory].sort() };
}
