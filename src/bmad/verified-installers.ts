import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * PJAN-180: bmad-method installers whose write surface has been VERIFIED by the
 * real-installer oracle (tests/pjan-180-surface-oracle.mjs, `mise run
 * bmad:verify-surface <version>`). Keyed by installerFingerprint, valued by the
 * package version it was taken from.
 *
 * Only a listed fingerprint lets a failed BMAD update roll back just the
 * declared installer surface. Anything else (a new release, a patched cache, a
 * fake test installer) keeps the whole-tree rollback. A fingerprint is added
 * here only after the oracle passes for that version.
 */
export const VERIFIED_BMAD_INSTALLERS: Readonly<Record<string, string>> = Object.freeze({
  // Each line was printed by `mise run bmad:verify-surface <version>` after the oracle passed (PJAN-180).
  "12039093806c59bec1f3302f455ed057f3d814116ae2bd0d6e2e8342b2ae3e3d": "6.12.1",
  "a382073a6b1b6d66b07c38c72e17b9683f59cdcc7a07153a1bc8402c4ec25f0e": "6.12.2",
  "35adaf7db9740c3af5590ebe4a4ebee0cd32dfdbbf5e23082071716e8c609ef1": "6.12.4",
});

/**
 * sha256 over the sorted lines `relpath\0sha256(bytes)\n` for every regular
 * file under `<pkgRoot>/tools/installer/`. Deliberately strict: ANY byte change
 * in the installer code or its data files is a different installer, because a
 * new call site of a write wrapper (copyFile, copyDirectory, a skill copier)
 * can widen the surface without any recognizable pattern.
 */
export function installerFingerprint(pkgRoot: string): string {
  const base = join(pkgRoot, "tools", "installer");
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      const rel = relative(base, full).split(/[\\/]/).join("/");
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) lines.push(`${rel}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
      // A symlink could swap code in without changing a byte here; it is part of the identity.
      else if (stat.isSymbolicLink()) lines.push(`${rel}\0link:${readlinkSync(full)}\n`);
    }
  };
  walk(base);
  lines.sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}
