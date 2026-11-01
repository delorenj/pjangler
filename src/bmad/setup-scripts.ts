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


/** Rehydrate only ignored installer runtime scripts, never run a full update against an installed project. */
export function planBmadSetupScripts(repoRoot: string, pkg: BmadInstallerPackage, version: string): { files: string[]; source?: string; error?: string } {
  const dest = join(repoRoot, "_bmad", "scripts");
  if (!pkg.root || !pkg.entry || pkg.version !== version) return { files: [], error: `Pinned bmad-method@${version} package could not be resolved: ${pkg.reason ?? "version mismatch"}` };
  let fingerprint: string;
  try { fingerprint = installerFingerprint(pkg.root); }
  catch (error) { return { files: [], error: `Could not fingerprint pinned BMAD installer: ${String(error)}` }; }
  if (VERIFIED_BMAD_INSTALLERS[fingerprint] !== version) return { files: [], error: `Unverified BMAD installer fingerprint ${fingerprint}; refusing script recovery` };
  const source = join(pkg.root, "src", "scripts");
  try {
    const bmad = lstatSync(join(repoRoot, "_bmad"));
    if (!bmad.isDirectory() || bmad.isSymbolicLink()) throw new Error("_bmad is not a real directory");
    const destStat = entryStat(dest);
    if (destStat && (!destStat.isDirectory() || destStat.isSymbolicLink())) throw new Error("_bmad/scripts is not a real directory");
    const names = readdirSync(source).filter((name) => !name.startsWith(".") && !name.endsWith(".pyc") && name !== "tests" && name !== "__pycache__" && name !== ".pytest_cache").sort();
    if (names.join("\0") !== [...RUNTIME_SCRIPTS].sort().join("\0")) throw new Error("Pinned installer script inventory changed; refusing recovery");
    const files: string[] = [];
    const manifestPath = join(repoRoot, "_bmad", "_config", "files-manifest.csv");
    const manifestDir = entryStat(join(repoRoot, "_bmad", "_config"));
    const manifestFile = entryStat(manifestPath);
    if (!manifestDir?.isDirectory() || manifestDir.isSymbolicLink() || !manifestFile?.isFile() || manifestFile.isSymbolicLink()) {
      throw new Error("Installed BMAD file manifest is missing or not a real file; cannot attest recovered scripts");
    }
    const rows = manifestRows(readFileSync(manifestPath, "utf8"));
    for (const name of names) {
      const src = join(source, name);
      if (!lstatSync(src).isFile() || lstatSync(src).isSymbolicLink()) throw new Error(`Installer script is not a regular file: ${name}`);
      const path = join(dest, name);
      const matching = rows.filter((row) => row[3] === `scripts/${name}`);
      const expectedHash = createHash("sha256").update(readFileSync(src)).digest("hex");
      if (matching.length !== 1 || matching[0]!.join("\0") !== ["py", name.slice(0, -3), "scripts", `scripts/${name}`, expectedHash].join("\0")) {
        throw new Error(`Installed file manifest does not attest pinned script ${name}`);
      }
      const existing = entryStat(path);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync(path).equals(readFileSync(src)) || (existing.mode & 0o7777) !== (lstatSync(src).mode & 0o7777)) {
          throw new Error(`Existing _bmad/scripts/${name} is not the pinned installer output; refusing overwrite`);
        }
      } else files.push(path);
    }
    return { files, source };
  } catch (error) {
    return { files: [], error: `BMAD script recovery refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Stage all missing scripts first; on any failure remove only files this call created. */
export function applyBmadSetupScripts(repoRoot: string, pkg: BmadInstallerPackage, version: string, afterPublish?: (count: number) => void): { files: string[]; error?: string } {
  const plan = planBmadSetupScripts(repoRoot, pkg, version);
  if (plan.error || !plan.files.length) return { files: [], ...(plan.error ? { error: plan.error } : {}) };
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
  return result;
}

export const REQUIRED_BMAD_SETUP_SCRIPTS = RUNTIME_SCRIPTS;
