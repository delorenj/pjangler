// The light half of the Ink foundation: NO ink/react imports, so commands can use it on
// every run (the TTY check, the lazy screen loader) without paying ~100ms to load them.
// Everything that imports ink lives in ./run.tsx and the screen modules.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Thrown for "this needs a real terminal"; commands print message and exit 1. */
export class TuiUnavailableError extends Error {}

export type TtyLike = { isTTY?: boolean };

/** True when both ends are a terminal: the only place a TUI can run. */
export function isInteractive(streams: { stdin?: TtyLike; stdout?: TtyLike } = {}): boolean {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** The frames Node's own module resolver raises "Cannot find ..." from (v20 through v26). */
const RESOLVER_FRAME = /node:internal\/modules\/(?:esm\/resolve|package_json_reader)/;

/**
 * "Cannot find package 'ink' imported from /where/tui.js" — Node's wording when an import
 * cannot be resolved. Group 1: "package" (a bare specifier) or "module" (a path); group 2:
 * what is missing; group 3: the file that imported it.
 */
const CANNOT_FIND = /^Cannot find (package|module) '([^']+)' imported from (.+)$/;

/** Remedy half of the "dependencies are not installed" line, fitting both ways pj is installed. */
const INSTALL_DEPS = "run npm ci in this checkout, or reinstall the global package (npm i -g @delorenj/pjangler)";

/**
 * Import a built Ink screen by its path under dist/ (e.g. "crank/tui.js"). The specifier is
 * computed on purpose: esbuild cannot see it, so it stays a runtime import and the screen's
 * `ink`/`react` imports are not hoisted into the entry bundle. `base` is the importing
 * module's import.meta.url (the entry bundle's directory is dist/).
 */
export async function loadScreen<M>(relativeToDist: string, base: string): Promise<M> {
  const url = new URL(relativeToDist, base);
  try {
    return (await import(/* @vite-ignore */ url.href)) as M;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // "Is the screen there" is decided on the filesystem, not from the message: Node raises
    // ERR_MODULE_NOT_FOUND for a missing dependency of an EXISTING screen just as readily.
    if (!existsSync(fileURLToPath(url))) {
      throw new TuiUnavailableError(`TUI screen ${relativeToDist} is not built (run: npm run build); looked for ${url.pathname}`);
    }
    // The screen is built, so one of ITS imports failed to resolve. Only reword errors that
    // come from Node's resolver (its stack names the internals above): anything else — an
    // error a screen raised itself that merely carries the code — is not ours to disguise.
    if (typeof err.stack !== "string" || !RESOLVER_FRAME.test(err.stack)) throw error;
    const missing = CANNOT_FIND.exec(err.message);
    const detail = missing
      ? `cannot find ${missing[1]} '${missing[2]}' imported by ${missing[3]}`
      : "an import of it cannot be resolved";
    throw new TuiUnavailableError(`TUI screen ${relativeToDist} is built but its dependencies are not installed: ${detail}; ${INSTALL_DEPS}`);
  }
}

