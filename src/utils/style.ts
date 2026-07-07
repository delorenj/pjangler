// Zero-dependency ANSI styling + iconography for pjangler CLI output.
//
// Color is emitted only to a capable TTY. We honor NO_COLOR
// (https://no-color.org/), FORCE_COLOR, TERM=dumb, and stdout TTY detection so
// that piped / redirected / `--json` / MCP (non-TTY) output stays clean and
// machine-parseable. Unicode glyphs are width-1 and rendered unconditionally so
// column alignment holds whether or not color is active.

const env = process.env;

function detectColor(): boolean {
  // NO_COLOR: present and non-empty disables color regardless of value.
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== undefined && force !== "") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

/** Whether ANSI color codes should be emitted for this process. */
export const colorEnabled: boolean = detectColor();

type Colorize = (value: string | number) => string;

function sgr(open: number, close: number): Colorize {
  const prefix = `\x1b[${open}m`;
  const suffix = `\x1b[${close}m`;
  return (value) => (colorEnabled ? `${prefix}${value}${suffix}` : String(value));
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);
export const gray = sgr(90, 39);

/** Small, alignment-safe (width-1) glyph vocabulary shared across commands. */
export const glyph = {
  pass: "✔",
  fail: "✖",
  warn: "⚠",
  skip: "○",
  info: "ℹ",
  arrow: "↳",
  bullet: "•",
  dot: "·",
  add: "+",
  chevron: "▸",
  pointer: "❯",
} as const;

export interface StatusStyle {
  glyph: string;
  color: Colorize;
  label: string;
}

// Covers both audit statuses (pass/fail/warn/skip) and migration result
// statuses (applied/noop/blocked/skipped).
const STATUS_STYLES: Record<string, StatusStyle> = {
  pass: { glyph: glyph.pass, color: green, label: "pass" },
  fail: { glyph: glyph.fail, color: red, label: "fail" },
  warn: { glyph: glyph.warn, color: yellow, label: "warn" },
  skip: { glyph: glyph.skip, color: gray, label: "skip" },
  applied: { glyph: glyph.pass, color: green, label: "applied" },
  noop: { glyph: glyph.skip, color: gray, label: "noop" },
  blocked: { glyph: glyph.fail, color: red, label: "blocked" },
  skipped: { glyph: glyph.skip, color: gray, label: "skipped" },
};

/** Resolve icon + color + label for a rule/migration status string. */
export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? { glyph: glyph.dot, color: dim, label: status };
}

/** Color a short project lifecycle status (planned/active/archived/…). */
export function projectStatusColor(status: string): Colorize {
  switch (status) {
    case "active":
      return green;
    case "planned":
      return yellow;
    case "archived":
      return gray;
    default:
      return cyan;
  }
}

/** A section heading: colored marker + bold title. */
export function heading(title: string, marker: string = glyph.chevron): string {
  return `${cyan(bold(marker))} ${bold(title)}`;
}

/** Join fragments with a dim middot separator ( · ). */
export function joinDot(fragments: string[]): string {
  return fragments.join(dim(` ${glyph.dot} `));
}
