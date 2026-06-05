import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package version, read from package.json at runtime so the CLI and MCP
 * server always report what `mise run version:bump` actually shipped — never
 * a hardcoded literal (PJAN-2: `pj --version` lied with "1.0.0" forever).
 * Walks up from this module's directory so it works from src/ (dev) and from
 * the bundled dist/ (published install) alike.
 */
export const PJANGLER_VERSION: string = (() => {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync(join(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0";
})();
