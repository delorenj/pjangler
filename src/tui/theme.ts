// Ink colours, mapped from the ANSI palette in src/utils/style.ts so a screen drawn with
// Ink looks like the rest of pj's output: heading/identifier = cyan, ok = green,
// warning = yellow, failure = red, secondary text = dim (style.ts `dim`/`gray`).
//
// Colour policy lives in ONE place — style.ts `colorEnabled` (NO_COLOR, FORCE_COLOR,
// TERM=dumb, TTY). When it says no, every theme colour is undefined, which Ink renders as
// plain text, so an Ink screen and a console.log line agree on whether to colour.

import { colorEnabled } from "../utils/style";

type Role = "accent" | "ok" | "warn" | "fail" | "muted";

/** style.ts helper each role mirrors: cyan, green, yellow, red, gray. */
const INK_COLOR: Record<Role, string> = {
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  fail: "red",
  muted: "gray",
};

/** Ink `color` prop for a role, or undefined when colour is disabled. */
export function themeColor(role: Role): string | undefined {
  return colorEnabled ? INK_COLOR[role] : undefined;
}

/** Same glyph vocabulary as style.ts `glyph`, plus the radio marks Ink screens need. */
export const marks = {
  radioOn: "(•)",
  radioOff: "( )",
  dotOn: "●",
  dotOff: "○",
  pointer: "❯",
  dot: "·",
} as const;
