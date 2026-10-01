// Coverage path audit: the ratchet is only as honest as the file list behind
// the total it gates.
//
// Twice now the measurement, not the code, moved the number. PJAN-100 found
// c8 counting an in-repo `.pjan-*` fixture copy of the package as a second,
// nearly uncovered src tree. The fix for that passed `--exclude`, which
// REPLACES c8's default exclude list instead of extending it, so tests/ — near
// 100% covered by definition — was counted as source from then on and lifted
// the gated total about 8.7 points. Both regressions were invisible in the
// total; both are obvious in the per-file keys. So the keys are checked before
// any floor is compared or written.
//
// A key fails when it is:
//   - outside the repo root   (a temp-dir or runner-scratch copy of the code)
//   - under tests/            (test files measured as if they were source)
//   - under a .pjan-* dir     (a test fixture's copy of the package)
//   - under a dist/ dir       (a bundle that was not remapped to src)
//   - a repeated src path     (the same src/<file> measured from two places)
//
// The c8 side of the contract lives in .c8rc.json.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const segmentsOf = (rel) => rel.split(/[\\/]+/).filter(Boolean);

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The key's path relative to whichever spelling of the root contains it, or
 * null when it escapes every one. A root reached through a symlink must not
 * read as "outside" just because V8 reported the resolved path.
 */
function relativeToRoot(key, roots) {
  const absolute = resolve(roots[0], key);
  for (const candidate of [absolute, realpathOr(absolute)]) {
    for (const root of roots) {
      const rel = relative(root, candidate);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
  }
  return null;
}

/**
 * Audit a c8 json-summary report against the repo root.
 *
 * @param {Record<string, unknown>} summary parsed coverage-summary.json
 * @param {string} root the repository root the report must describe
 * @returns {{ files: number, byTop: Record<string, number>, problems: { key: string, reason: string }[] }}
 */
export function auditCoverageSummary(summary, root) {
  const roots = [...new Set([resolve(root), realpathOr(resolve(root))])];
  const keys = Object.keys(summary).filter((key) => key !== "total");
  const problems = [];
  const byTop = {};
  const bySrcPath = new Map();

  for (const key of keys) {
    const rel = relativeToRoot(key, roots);
    // Outside-root keys are still checked for a repeated src path below, so a
    // scratch copy of src/ names both of its symptoms.
    const segments = rel === null ? segmentsOf(key) : segmentsOf(rel);

    if (rel === null) {
      problems.push({ key, reason: "outside the repository root" });
    } else {
      byTop[segments[0]] = (byTop[segments[0]] ?? 0) + 1;
      if (segments[0] === "tests") problems.push({ key, reason: "test file counted as source (tests/)" });
    }
    if (segments.some((s) => s.startsWith(".pjan-"))) {
      problems.push({ key, reason: "test fixture copy of the package (.pjan-*)" });
    }
    if (segments.includes("dist")) {
      problems.push({ key, reason: "bundle measured without its source map (dist/)" });
    }

    const src = segments.indexOf("src");
    if (src !== -1) {
      const srcPath = segments.slice(src).join("/");
      bySrcPath.set(srcPath, [...(bySrcPath.get(srcPath) ?? []), key]);
    }
  }

  for (const [srcPath, dupes] of bySrcPath) {
    if (dupes.length < 2) continue;
    for (const key of dupes) {
      problems.push({ key, reason: `${srcPath} measured ${dupes.length} times` });
    }
  }

  return { files: keys.length, byTop, problems };
}
