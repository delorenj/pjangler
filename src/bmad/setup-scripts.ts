import { createHash } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, constants } from "node:fs";
import { basename, join } from "node:path";
import { installerFingerprint, VERIFIED_BMAD_INSTALLERS } from "./verified-installers";
import type { BmadInstallerPackage } from "./update-scope";

function entryStat(path: string): import("node:fs").Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const RUNTIME_SCRIPTS = ["config_utils.py", "memlog.py", "render_skill.py", "resolve_config.py", "resolve_customization.py"] as const;

// The installer manifest is RFC-style CSV, not a substring-searchable list of lines.
function manifestRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false, inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) { inQuotes = true; quoted = true; }
    else if (c === ',') { row.push(field); field = ""; quoted = closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length !== 1 || row[0]) rows.push(row);
      row = []; field = ""; quoted = closed = false;
    } else if (closed || c === '"' || (quoted && c === '\r')) throw new Error("Malformed BMAD file manifest CSV");
    else field += c;
  }
  if (inQuotes) throw new Error("Unterminated BMAD file manifest CSV field");
  if (row.length || field || closed) { row.push(field); rows.push(row); }
  if (rows.some((r) => r.length !== 5) || rows[0]?.join("\0") !== "type\0name\0module\0path\0hash") {
    throw new Error("Invalid BMAD file manifest columns");
  }
  return rows.slice(1);
}

function sameIdentity(a: import("node:fs").Stats | undefined, b: import("node:fs").Stats): boolean {
  return !!a && a.dev === b.dev && a.ino === b.ino && a.isDirectory() && !a.isSymbolicLink();
}


/**
 * An error the rule reports as a decline (skip), not a failure: the cause is the
 * resolved package or the installed manifest's relationship to it, not damage to
 * the project that this rule is meant to surface.
 *
 * - `unresolved`: no package to compare against (npx failed, timed out, or the
 *   PJ_BMAD_INSTALLER override is not a bmad-method package). Retrying may help.
 * - `unverified`: a package was resolved but it is not the release this rule was
 *   verified against (fingerprint, version or script inventory). Deterministic.
 * - `layout`: the resolved package is unreadable (a corrupted npx cache).
 * - `attest`: the install's own manifest cannot attest the pinned bytes.
 */
export type BmadSetupScriptsDecline = "unresolved" | "unverified" | "layout" | "attest";

class DeclinableError extends Error {
  constructor(message: string, readonly kind: BmadSetupScriptsDecline) { super(message); }
}

/** Field separator for comparing manifest rows as one string (a NUL cannot occur in a CSV field). */
const FIELD_SEP = String.fromCharCode(0);

/**
 * sha256 of every script in each pinned bmad-method package, so a restore can be
 * decided from the disk alone (no npx, no network): a missing script is
 * restorable when the install's files-manifest.csv row attests exactly these bytes.
 * tests/pjan-166-bmad-setup-scripts-regressions.mjs holds every entry to the
 * real package. A pin with no entry here is not guessed at: the disk check is
 * then structural only, and the package's own bytes decide (planBmadSetupScripts).
 */
export const PINNED_SETUP_SCRIPT_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "6.12.1": Object.freeze({
    "config_utils.py": "48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651",
    "memlog.py": "3b00f82ca33dc4227f715123b939514ee35c4f9c71150c894c3d8185df1b48df",
    "render_skill.py": "8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942",
    "resolve_config.py": "70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768",
    "resolve_customization.py": "c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284",
  }),
});

/** A missing script this rule will not restore, with the reason (a clause that follows `scripts/<name> `). */
export interface DeclinedScript { name: string; why: string }

export interface BmadSetupScriptsPlan {
  /** The missing scripts the manifest attests and the pinned package can restore. */
  files: string[];
  /** The missing scripts it will not restore. Never blocks `files`. */
  declined: DeclinedScript[];
  source?: string;
  error?: string;
  /** Set with `error` when the refusal is a host/version condition the project cannot fix by itself. */
  declinable?: BmadSetupScriptsDecline;
}

export type BmadSetupScriptsInspection =
  | { state: "present" }
  /** A project-side hazard (symlink, directory, malformed manifest, ...): visible and never overwritten. */
  | { state: "unsafe"; error: string }
  /** Scripts are missing but this rule can attest none of them; never a failure. */
  | { state: "decline"; why: string; missing: string[]; declined: DeclinedScript[] }
  /** At least one missing script is attested: the pinned package is needed to restore `restorable`. */
  | { state: "missing"; missing: string[]; restorable: string[]; declined: DeclinedScript[] };

const MANIFEST_PATH = "_bmad/_config/files-manifest.csv";

const manifestUnusable = (path: string, missing: string[]): string =>
  `Installed BMAD file manifest is missing or not a real file: ${path} cannot attest recovered scripts (missing from _bmad/scripts: ${missing.join(", ")})`;

type ScriptWalk =
  | { kind: "no-bmad" }
  /** A project-side hazard; the message is the refusal. */
  | { kind: "hazard"; error: string }
  | { kind: "walked"; missing: string[] };

/**
 * The one walk of `_bmad/scripts` that inspect and plan share. An existing script
 * that is a regular file (lstat, so a symlink is never one) counts as present,
 * with no byte or mode comparison: real installs land at other versions and other
 * umasks (664/775 against the package's 644/755), and a present file is not this
 * rule's to judge. Only a missing script is ever restored.
 */
function walkScripts(repoRoot: string, names: readonly string[]): ScriptWalk {
  const bmadDir = join(repoRoot, "_bmad");
  const bmad = entryStat(bmadDir);
  if (!bmad) return { kind: "no-bmad" };
  if (!bmad.isDirectory()) return { kind: "hazard", error: "_bmad is not a real directory" };
  const dest = join(bmadDir, "scripts");
  const destStat = entryStat(dest);
  if (destStat && !destStat.isDirectory()) return { kind: "hazard", error: "_bmad/scripts is not a real directory" };
  const missing: string[] = [];
  for (const name of names) {
    const existing = destStat ? entryStat(join(dest, name)) : undefined;
    if (!existing) missing.push(name);
    else if (!existing.isFile()) return { kind: "hazard", error: `Existing _bmad/scripts/${name} is not a regular file; refusing overwrite` };
  }
  return { kind: "walked", missing };
}

type ManifestRead =
  | { kind: "absent" }
  /** The manifest or `_config` is a symlink, directory or other non-file: visible, never read through. */
  | { kind: "unusable"; path: string }
  | { kind: "rows"; rows: string[][] };

/** Throws on a malformed manifest: that is damage to the project, not a decline. */
function readFilesManifest(repoRoot: string): ManifestRead {
  const bmadDir = join(repoRoot, "_bmad");
  // lstat follows intermediate symlinks, so a dangling `_config` link reads as
  // ENOENT on the manifest: look at `_config` itself before calling it absent.
  const configDir = entryStat(join(bmadDir, "_config"));
  if (configDir && !configDir.isDirectory()) return { kind: "unusable", path: "_bmad/_config" };
  const manifestPath = join(bmadDir, "_config", "files-manifest.csv");
  const manifestFile = configDir ? entryStat(manifestPath) : undefined;
  if (!manifestFile) return { kind: "absent" };
  if (!manifestFile.isFile()) return { kind: "unusable", path: MANIFEST_PATH };
  return { kind: "rows", rows: manifestRows(readFileSync(manifestPath, "utf8")) };
}

const abbreviate = (sha: string): string => sha.slice(0, 12);

/**
 * Why the manifest cannot attest `scripts/<name>` as the pinned bytes, or
 * undefined when it does. With `expectedSha` the row must carry exactly those
 * bytes. Without it (a pin this build has no constants for) only the row's shape
 * is checked, and the package's bytes decide later.
 */
function whyUnattested(rows: string[][], name: string, expectedSha: string | undefined, version: string): string | undefined {
  const path = `scripts/${name}`;
  const matching = rows.filter((row) => row[3] === path);
  if (!matching.length) return `has no row in ${MANIFEST_PATH}, so it cannot be attested`;
  if (matching.length !== 1) return `has ${matching.length} rows in ${MANIFEST_PATH}, so it cannot be attested`;
  const row = matching[0]!;
  const shape = ["py", name.slice(0, -3), "scripts", path];
  if (row.slice(0, 4).join(FIELD_SEP) !== shape.join(FIELD_SEP)) return `has a manifest row that is not the installer's py/scripts row for it`;
  if (expectedSha !== undefined && row[4] !== expectedSha) {
    return `is attested by the manifest as other bytes (sha256 ${abbreviate(row[4]!)}) than bmad-method@${version}'s (${abbreviate(expectedSha)})`;
  }
  return undefined;
}

function attest(rows: string[][], missing: readonly string[], expected: (name: string) => string | undefined, version: string): { restorable: string[]; declined: DeclinedScript[] } {
  const restorable: string[] = [], declined: DeclinedScript[] = [];
  for (const name of missing) {
    const why = whyUnattested(rows, name, expected(name), version);
    if (why === undefined) restorable.push(name);
    else declined.push({ name, why });
  }
  return { restorable, declined };
}

/** The declined scripts as one sentence fragment, one clause per script. */
export const describeDeclined = (declined: readonly DeclinedScript[]): string =>
  declined.map((d) => `scripts/${d.name} ${d.why}`).join("; ");

/**
 * What is on disk, decided WITHOUT resolving the pinned package (no network).
 * A missing script is restorable when its files-manifest.csv row attests the
 * sha256 this build pins for the version's script (PINNED_SETUP_SCRIPT_SHA256),
 * whatever version string the install's manifest.yaml carries: the bytes decide,
 * not the label. Each script is judged on its own, so one unattested script
 * never withholds the others.
 */
export function inspectBmadSetupScripts(repoRoot: string, version: string): BmadSetupScriptsInspection {
  try {
    const walk = walkScripts(repoRoot, RUNTIME_SCRIPTS);
    if (walk.kind === "no-bmad") return { state: "decline", why: "_bmad is absent", missing: [...RUNTIME_SCRIPTS], declined: [] };
    if (walk.kind === "hazard") return { state: "unsafe", error: walk.error };
    const { missing } = walk;
    if (!missing.length) return { state: "present" };
    const manifest = readFilesManifest(repoRoot);
    if (manifest.kind === "unusable") return { state: "unsafe", error: manifestUnusable(manifest.path, missing) };
    if (manifest.kind === "absent") return { state: "decline", why: `${MANIFEST_PATH} is absent, so recovered scripts cannot be attested`, missing, declined: [] };
    const pinned = PINNED_SETUP_SCRIPT_SHA256[version];
    const { restorable, declined } = attest(manifest.rows, missing, (name) => pinned?.[name], version);
    if (!restorable.length) return { state: "decline", why: describeDeclined(declined), missing, declined };
    return { state: "missing", missing, restorable, declined };
  } catch (error) {
    return { state: "unsafe", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Rehydrate only ignored installer runtime scripts, never run a full update against an installed project.
 * Restores every missing script whose manifest row attests the package's own bytes
 * and reports the rest in `declined`; only when nothing is restorable and something
 * is declined is `error` set (a decline, never a failure).
 */
export function planBmadSetupScripts(repoRoot: string, pkg: BmadInstallerPackage, version: string): BmadSetupScriptsPlan {
  const dest = join(repoRoot, "_bmad", "scripts");
  const refuse = (message: string, declinable?: BmadSetupScriptsDecline): BmadSetupScriptsPlan =>
    ({ files: [], declined: [], ...(declinable ? { declinable } : {}), error: message });
  if (!pkg.root || !pkg.entry) return refuse(`Pinned bmad-method@${version} package could not be resolved: ${pkg.reason ?? "no package root"}`, "unresolved");
  if (pkg.version !== version) return refuse(`Pinned bmad-method@${version} package could not be resolved: resolved ${pkg.version ?? "an unknown version"}`, "unverified");
  let fingerprint: string;
  try { fingerprint = installerFingerprint(pkg.root); }
  catch (error) { return refuse(`Could not fingerprint pinned BMAD installer: ${String(error)}`, "layout"); }
  if (VERIFIED_BMAD_INSTALLERS[fingerprint] !== version) return refuse(`Unverified BMAD installer fingerprint ${fingerprint}; refusing script recovery`, "unverified");
  const source = join(pkg.root, "src", "scripts");
  try {
    // Every read of the resolved package is a package condition (a corrupted npx
    // cache reads ENOENT here), never damage to the project.
    let names: string[];
    try { names = readdirSync(source).filter((name) => !name.startsWith(".") && !name.endsWith(".pyc") && name !== "tests" && name !== "__pycache__" && name !== ".pytest_cache").sort(); }
    catch (error) { throw new DeclinableError(`Pinned installer scripts are unreadable: ${error instanceof Error ? error.message : String(error)}`, "layout"); }
    if (names.join(FIELD_SEP) !== [...RUNTIME_SCRIPTS].sort().join(FIELD_SEP)) throw new DeclinableError("Pinned installer script inventory changed; refusing recovery", "unverified");
    const walk = walkScripts(repoRoot, names);
    if (walk.kind === "no-bmad") throw new Error("_bmad is not a real directory");
    if (walk.kind === "hazard") throw new Error(walk.error);
    const { missing } = walk;
    if (!missing.length) return { files: [], declined: [], source };
    const manifest = readFilesManifest(repoRoot);
    if (manifest.kind === "unusable") throw new Error(manifestUnusable(manifest.path, missing));
    if (manifest.kind === "absent") {
      const declined = missing.map((name) => ({ name, why: `cannot be attested: ${MANIFEST_PATH} is absent` }));
      return { files: [], declined, source, declinable: "attest", error: `BMAD script recovery refused: ${MANIFEST_PATH} is absent, so recovered scripts cannot be attested` };
    }
    const packageSha = new Map<string, string>();
    for (const name of missing) {
      try {
        const src = join(source, name);
        if (!lstatSync(src).isFile()) throw new Error("not a regular file");
        packageSha.set(name, createHash("sha256").update(readFileSync(src)).digest("hex"));
      } catch (error) { throw new DeclinableError(`Installer script ${name} is unreadable in the pinned package: ${error instanceof Error ? error.message : String(error)}`, "layout"); }
    }
    const { restorable, declined } = attest(manifest.rows, missing, (name) => packageSha.get(name), version);
    if (!restorable.length) {
      return { files: [], declined, source, declinable: "attest", error: `BMAD script recovery refused: the installed file manifest does not attest the pinned bytes of ${describeDeclined(declined)}` };
    }
    return { files: restorable.map((name) => join(dest, name)), declined, source };
  } catch (error) {
    return { files: [], declined: [], ...(error instanceof DeclinableError ? { declinable: error.kind } : {}), error: `BMAD script recovery refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Stage every attested missing script first; on any failure remove only files this
 * call created. `declined` is what the plan would not restore, reported either way.
 */
export function applyBmadSetupScripts(repoRoot: string, pkg: BmadInstallerPackage, version: string, afterPublish?: (count: number) => void): { files: string[]; declined: DeclinedScript[]; error?: string } {
  const plan = planBmadSetupScripts(repoRoot, pkg, version);
  if (plan.error || !plan.files.length) return { files: [], declined: plan.declined, ...(plan.error ? { error: plan.error } : {}) };
  const parent = join(repoRoot, "_bmad");
  const dest = join(parent, "scripts");
  const expectedParent = entryStat(parent);
  const expectedDir = entryStat(dest);
  let stage: string | undefined;
  let stageFd: number | undefined;
  let parentFd: number | undefined;
  const created: string[] = [];
  const stagedIdentities = new Map<string, { dev: number; ino: number; bytes: Buffer; mode: number }>();
  const published = new Map<string, { dev: number; ino: number; bytes: Buffer; mode: number }>();
  let ambiguousPublication: string | undefined;
  const matchesPayload = (path: string, owned: { dev: number; ino: number; bytes: Buffer; mode: number }): boolean => {
    const stat = entryStat(path);
    return !!stat?.isFile() && !stat.isSymbolicLink() && stat.dev === owned.dev && stat.ino === owned.ino
      && (stat.mode & 0o7777) === owned.mode && readFileSync(path).equals(owned.bytes);
  };
  let madeDir = false;
  let dirFd: number | undefined;
  let result: { files: string[]; error?: string } = { files: [] };
  try {
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinnedParent = fstatSync(parentFd);
    if (!sameIdentity(expectedParent, pinnedParent) || !sameIdentity(entryStat(parent), pinnedParent)) throw new Error("BMAD parent directory changed before staging");
    const anchoredParent = `/proc/self/fd/${parentFd}`;
    stage = mkdtempSync(join(anchoredParent, ".scripts-stage-"));
    stageFd = openSync(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinnedStage = fstatSync(stageFd);
    const stageName = basename(stage);
    const anchoredStage = `/proc/self/fd/${stageFd}`;
    if (!sameIdentity(entryStat(join(anchoredParent, stageName)), pinnedStage)) throw new Error("Staging directory changed during creation");
    for (const path of plan.files) {
      const name = basename(path);
      const src = join(plan.source!, name);
      const staged = join(anchoredStage, name);
      const fileFd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fileFd);
        const bytes = readFileSync(src);
        const mode = lstatSync(src).mode & 0o7777;
        stagedIdentities.set(name, { dev: stat.dev, ino: stat.ino, bytes, mode });
        writeFileSync(fileFd, bytes);
        fchmodSync(fileFd, mode);
      } finally { closeSync(fileFd); }
    }
    // A pathname recheck alone cannot establish identity after a parent swap.
    if (!sameIdentity(entryStat(parent), pinnedParent)) throw new Error("BMAD parent directory changed while staging");
    const current = planBmadSetupScripts(repoRoot, pkg, version);
    if (current.error || current.files.join("\0") !== plan.files.join("\0")) throw new Error(current.error ?? "Script destination changed while staging");
    const anchoredDest = join(anchoredParent, "scripts");
    if (!entryStat(anchoredDest)) { mkdirSync(anchoredDest); madeDir = true; }
    // Linux procfs resolves this path relative to the open directory, even if its
    // original pathname is renamed or replaced with a symlink during publication.
    dirFd = openSync(anchoredDest, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinned = fstatSync(dirFd);
    if (expectedDir && !sameIdentity(expectedDir, pinned)) throw new Error("Script directory changed while staging");
    if (!sameIdentity(entryStat(parent), pinnedParent) || !sameIdentity(entryStat(dest), pinned)) throw new Error("Script or parent directory changed during publication");
    const anchored = `/proc/self/fd/${dirFd}`;
    for (const path of plan.files) {
      const name = basename(path);
      const staged = join(anchoredStage, name);
      const output = join(anchored, name);
      const owned = stagedIdentities.get(name)!;
      if (!sameIdentity(entryStat(parent), pinnedParent) || !sameIdentity(entryStat(dest), pinned)) throw new Error("Script or parent directory changed during publication");
      if (!matchesPayload(staged, owned)) throw new Error(`Staged script changed before publication: ${name}`);
      if (entryStat(output)) {
        ambiguousPublication = path;
        throw new Error(`Script destination appeared before publication: ${name}`);
      }
      try { linkSync(staged, output); }
      catch (error) {
        // A thrown syscall does not prove who linked the destination, even if
        // its inode matches the staged file (another actor can hard-link it).
        if (entryStat(output)) ambiguousPublication = path;
        throw error;
      }
      published.set(path, owned);
      created.push(path);
      if (!matchesPayload(output, owned)) throw new Error(`Published script changed during publication: ${name}`);
      afterPublish?.(created.length);
    }
    if (!sameIdentity(entryStat(parent), pinnedParent) || !sameIdentity(entryStat(dest), pinned)) throw new Error("Script or parent directory changed during publication");
    for (const path of created) {
      if (!matchesPayload(join(anchored, basename(path)), stagedIdentities.get(basename(path))!)) throw new Error(`Published script changed before completion: ${basename(path)}`);
    }
    result = { files: created };
  } catch (error) {
    const recoveryErrors: string[] = [];
    // Roll back through the pinned directory, not through the possibly swapped name.
    for (const [path, owned] of [...published].reverse()) {
      try {
        const anchoredPath = join(`/proc/self/fd/${dirFd}`, basename(path));
        const stat = entryStat(anchoredPath);
        if (matchesPayload(anchoredPath, owned)) unlinkSync(anchoredPath);
        else if (stat) recoveryErrors.push(`Concurrent replacement or mutation retained: ${path}`);
        else recoveryErrors.push(`Published file absent from pinned directory; ownership unresolved: ${path}`);
      } catch (recoveryError) { recoveryErrors.push(`Could not restore ${path}: ${String(recoveryError)}`); }
    }
    if (ambiguousPublication) recoveryErrors.push(`Publication not confirmed; destination retained or ownership unresolved: ${ambiguousPublication}`);
    if (madeDir && dirFd !== undefined && parentFd !== undefined) {
      try {
        const pinned = fstatSync(dirFd);
        const anchoredDest = join(`/proc/self/fd/${parentFd}`, "scripts");
        if (sameIdentity(entryStat(anchoredDest), pinned) && readdirSync(anchoredDest).length === 0) rmdirSync(anchoredDest);
        else recoveryErrors.push(`Created script directory moved or retained: ${dest}`);
      } catch (recoveryError) { recoveryErrors.push(`Could not remove empty script directory: ${String(recoveryError)}`); }
    }
    result = { files: [], error: `BMAD script recovery failed: ${error instanceof Error ? error.message : String(error)}${recoveryErrors.length ? `; recovery incomplete: ${recoveryErrors.join("; ")}` : ""}` };
  } finally {
    const cleanupErrors: string[] = [];
    if (stageFd !== undefined) {
      try {
        const pinnedStage = fstatSync(stageFd);
        const anchoredStage = `/proc/self/fd/${stageFd}`;
        for (const [name, owned] of stagedIdentities) {
          const staged = join(anchoredStage, name);
          const stat = entryStat(staged);
          if (stat?.isFile() && !stat.isSymbolicLink() && stat.dev === owned.dev && stat.ino === owned.ino) unlinkSync(staged);
          else cleanupErrors.push(`Staged file replaced, modified or absent: ${name}`);
        }
        const stagePath = join(`/proc/self/fd/${parentFd}`, basename(stage!));
        if (sameIdentity(entryStat(stagePath), pinnedStage) && readdirSync(anchoredStage).length === 0) rmdirSync(stagePath);
        else cleanupErrors.push(`Staging directory moved or contains foreign entries: ${join(parent, basename(stage!))}`);
      } catch (cleanupError) { cleanupErrors.push(`Could not clean owned staging directory: ${String(cleanupError)}`); }
      closeSync(stageFd);
    } else if (stage) cleanupErrors.push(`Staging directory identity unavailable: ${join(parent, basename(stage))}`);
    if (cleanupErrors.length && result.files.length) {
      // A staging cleanup failure invalidates a nominal success; undo every
      // publication while the pinned destination descriptors are still open.
      for (const [path, owned] of [...published].reverse()) {
        try {
          const output = join(`/proc/self/fd/${dirFd}`, basename(path));
          if (matchesPayload(output, owned)) unlinkSync(output);
          else cleanupErrors.push(`Concurrent replacement or mutation retained: ${path}`);
        } catch (error) { cleanupErrors.push(`Could not restore ${path}: ${String(error)}`); }
      }
      if (madeDir && dirFd !== undefined && parentFd !== undefined) {
        try {
          const anchoredDest = join(`/proc/self/fd/${parentFd}`, "scripts");
          if (sameIdentity(entryStat(anchoredDest), fstatSync(dirFd)) && readdirSync(anchoredDest).length === 0) rmdirSync(anchoredDest);
          else cleanupErrors.push(`Created script directory moved or retained: ${dest}`);
        } catch (error) { cleanupErrors.push(`Could not remove empty script directory: ${String(error)}`); }
      }
    }
    if (dirFd !== undefined) closeSync(dirFd);
    if (parentFd !== undefined) closeSync(parentFd);
    if (cleanupErrors.length) result = { files: [], error: `${result.error ? `${result.error}; ` : "BMAD script staging cleanup incomplete: "}recovery incomplete: ${cleanupErrors.join("; ")}` };
  }
  return { ...result, declined: plan.declined };
}

export const REQUIRED_BMAD_SETUP_SCRIPTS = RUNTIME_SCRIPTS;
