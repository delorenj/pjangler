// runInk: the one door every Ink screen goes through.
//
// It refuses a non-interactive terminal up front (Ink would otherwise die inside
// setRawMode with a stack trace), renders, and resolves with whatever the screen passed to
// `finish`. Ctrl+C, a thrown error and a normal finish all unmount, and unmounting
// restores the terminal (raw mode off, cursor back, alternate screen left).
//
// Loading: this module and everything in src/tui import `ink`/`react`, which cost ~100ms to
// load. They are only ever reached through a screen module (src/<cmd>/tui.tsx) that is built
// as its OWN esbuild entry and imported lazily by `loadScreen`, so a command that never
// shows a screen (pj --version) never pays for them.

import { render, type RenderOptions } from "ink";
import type { ReactElement } from "react";
import { TuiUnavailableError, isInteractive, type TtyLike } from "./load";

export interface RunInkOptions {
  /** Take over the whole terminal (a dashboard) instead of drawing inline (a prompt). */
  alternateScreen?: boolean;
  /** Test seams: any Ink-compatible streams. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Extra Ink render options (debug, maxFps, ...). */
  ink?: Omit<RenderOptions, "stdin" | "stdout" | "stderr" | "alternateScreen">;
}

/**
 * Render a screen and wait for it to end. `build` receives `finish(value)`, which unmounts
 * the app and resolves the promise; Ctrl+C unmounts too and resolves undefined.
 */
export async function runInk<T = void>(
  build: (finish: (value?: T) => void) => ReactElement,
  options: RunInkOptions = {},
): Promise<T | undefined> {
  if (!isInteractive({ stdin: options.stdin as TtyLike | undefined, stdout: options.stdout as TtyLike | undefined })) {
    throw new TuiUnavailableError("this needs an interactive terminal (stdin and stdout must be a TTY)");
  }
  let result: T | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let finished = false;
  const finish = (value?: T) => {
    if (finished) return;
    finished = true;
    result = value;
    instance?.unmount();
  };
  instance = render(build(finish), {
    ...options.ink,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    alternateScreen: options.alternateScreen ?? false,
    exitOnCtrlC: true,
  });
  if (finished) instance.unmount();
  await instance.waitUntilExit();
  return result;
}

