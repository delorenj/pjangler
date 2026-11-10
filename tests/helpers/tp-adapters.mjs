// PJAN-198: the one copy of the tp-adapter directory resolution used by the
// adapter contract suites (pjan-23, pjan-50). Krebs owns the adapter files;
// pjangler only reads and runs them. Two copies of this resolver drifted once
// already, so it lives here and both suites import it.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the canonical Krebs tp-adapter directory the way
 * `resolveTicketProviderAdapter` resolves it: the PJ_TICKET_PROVIDER_ADAPTERS
 * env override first, then a walk up from `startDir` looking for
 * krebs/adapters/tp.
 *
 * src also falls back to `homedir()/code/33GOD/krebs/adapters/tp`. Suites do
 * not (PJAN-198): under the hermetic-suite preamble homedir() is the suite's
 * scratch home, so that candidate could never exist here, and no suite relied
 * on it. A workstation checkout inside the 33GOD tree finds the adapters by
 * the walk; anywhere else (CI, a checkout outside ~/code/33GOD) sets
 * PJ_TICKET_PROVIDER_ADAPTERS, which SUITE_PASSTHROUGH grants the adapter
 * suites (publish.yml exports it). The src fallback is product behaviour for
 * a real HOME and stays as it is.
 *
 * Returns { found, candidates } — `found` is the first candidate holding a
 * plane.sh, or null. Never throws: callers assert so a test can exercise the
 * failure branch, and build the diagnostic with tpAdaptersFailure().
 */
export function findTpAdapters({ env = process.env, startDir } = {}) {
  const candidates = [];
  if (env.PJ_TICKET_PROVIDER_ADAPTERS) candidates.push(env.PJ_TICKET_PROVIDER_ADAPTERS);
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(dir, "krebs", "adapters", "tp"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found = candidates.find((candidate) => existsSync(join(candidate, "plane.sh"))) ?? null;
  return { found, candidates };
}

/**
 * The failure diagnostic for a null `found`. It must say what was searched —
 * "not inside a 33GOD tree" does not follow from a missed lookup (Krebs could
 * be absent, or plane.sh missing, inside one) — and name the way out.
 */
export function tpAdaptersFailure(candidates) {
  return (
    "no tp adapters found; searched:\n" +
    candidates.map((candidate) => `  - ${candidate}`).join("\n") +
    "\npoint PJ_TICKET_PROVIDER_ADAPTERS (granted to the adapter suites) at a directory holding <provider>.sh"
  );
}
