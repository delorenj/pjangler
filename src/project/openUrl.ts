// Handing a URL to the operator.
//
// Kept apart from `boardUrl.ts` so the derivation stays pure and testable, and
// so the shell-prompt bundle never imports a launcher it has no use for.

import { spawn } from "node:child_process";

export interface OpenOutcome {
  /** True when a launcher was spawned; false when we printed a link instead. */
  opened: boolean;
  /** What to show the operator — the OSC 8 link, or a plain fallback. */
  display: string;
  reason?: string;
}

/**
 * OSC 8 hyperlink. Ghostty, Kitty, and Alacritty all render these clickable;
 * terminals that do not simply show the label, so the URL is never lost.
 */
export function osc8(url: string, label = url): string {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

/**
 * Whether a browser can plausibly be launched from here.
 *
 * A fleet node over ssh has no display, and `xdg-open` there exits 0 while
 * doing nothing — a silent no-op is the worst possible outcome for a key you
 * just pressed, so detect it up front and print a link instead.
 */
export function isHeadless(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (platform === "darwin") return false;
  return !(env.WAYLAND_DISPLAY || env.DISPLAY);
}

function launcher(platform = process.platform): string {
  return platform === "darwin" ? "open" : "xdg-open";
}

/**
 * Open `url`, or explain why it was printed instead.
 *
 * The child is detached and its stdio discarded: a browser that outlives this
 * process must not hold the terminal, and a launcher that writes to stderr
 * must not corrupt structured output.
 */
export function openUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): OpenOutcome {
  if (isHeadless(env, platform)) {
    return {
      opened: false,
      display: osc8(url),
      reason: "no display; printed a link instead",
    };
  }
  try {
    spawn(launcher(platform), [url], { detached: true, stdio: "ignore" }).unref();
    return { opened: true, display: osc8(url) };
  } catch (err) {
    return {
      opened: false,
      display: osc8(url),
      reason: `could not launch ${launcher(platform)}: ${(err as Error).message}`,
    };
  }
}
