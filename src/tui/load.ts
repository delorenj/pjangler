// The light half of the Ink foundation: NO ink/react imports, so commands can use it on
// every run (the TTY check, the lazy screen loader) without paying ~100ms to load them.
// Everything that imports ink lives in ./run.tsx and the screen modules.

/** Thrown for "this needs a real terminal"; commands print message and exit 1. */
export class TuiUnavailableError extends Error {}

export type TtyLike = { isTTY?: boolean };

/** True when both ends are a terminal: the only place a TUI can run. */
export function isInteractive(streams: { stdin?: TtyLike; stdout?: TtyLike } = {}): boolean {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

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
    if ((error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") {
      throw new TuiUnavailableError(`TUI screen ${relativeToDist} is not built (run: npm run build); looked for ${url.pathname}`);
    }
    throw error;
  }
}

