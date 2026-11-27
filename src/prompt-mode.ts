// The project MODE segment of `pjangler-prompt`: which mode the repo's PM is
// declared to be in — develop, launch, polish or live — and, for polish, its
// running metrics (improvements proposed / implemented, QA cycles).
//
// The mode is DECLARED by the owner in the repo's committed `.launch.yaml`
// (`mode:` key); agents never edit that file. This reader is a plain text
// read, not a YAML parse, for the same reason prompt-pm.ts is: the prompt
// bundle stays import-free so it boots near node's own floor, and a sync read
// of two tiny files stays far inside the prompt's ~35ms budget. It never
// throws and never guesses: `steady` is the legacy alias of `develop`, and an
// absent, unreadable or unrecognised declaration reads as `develop` — the
// default mode — exactly as the launch-pass driver's monitor reports it.
//
// The polish metrics ledger is `<root>/agents/hermes/pm/runtime/polish-metrics.json`,
// written by the polish pass (`<role dir>/runtime/polish-metrics.json`):
//   { declared, cycles, proposed: [{ref,title,at}...], implemented: [ref...], updated_at }
// Readers that only display it count lengths: proposed = len(proposed),
// implemented = len(implemented), cycles = cycles. A missing or broken ledger
// is NO metrics — the segment still says `polish`, it just shows no numbers.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectMode = "develop" | "launch" | "polish" | "live";

/** Display counts from the polish metrics ledger. */
export interface PolishCounts {
  /** Improvements proposed (each ok polish create). */
  proposed: number;
  /** Proposed refs now completed. */
  implemented: number;
  /** Total QA cycles (one per polish --apply, even with zero writes). */
  cycles: number;
}

export interface ModeFacts {
  mode: ProjectMode;
  /** Polish only, and only when the ledger is readable: the running counts. */
  polish?: PolishCounts;
}

/** The declared mode, normalised: lowercase, `steady` (legacy) reads as `develop`, anything unknown as `develop`. */
export function normalizeMode(value: string | undefined): ProjectMode {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "launch" || mode === "polish" || mode === "live") return mode;
  return "develop";
}

/** The top-level `mode:` scalar of `.launch.yaml`'s text, quotes and trailing comment stripped, or undefined. */
function declaredMode(text: string): string | undefined {
  const match = /^mode:[ \t]*"?([^"\s#]*)"?/m.exec(text);
  return match?.[1] || undefined;
}

/** The polish ledger's counts, or undefined when absent, broken or the wrong shape (never an error). */
export function readPolishMetrics(root: string): PolishCounts | undefined {
  try {
    const ledger = JSON.parse(readFileSync(join(root, "agents", "hermes", "pm", "runtime", "polish-metrics.json"), "utf8")) as Record<string, unknown>;
    if (!ledger || typeof ledger !== "object") return undefined;
    if (!Array.isArray(ledger.proposed) || !Array.isArray(ledger.implemented)) return undefined;
    const cycles = ledger.cycles;
    if (!Number.isInteger(cycles) || (cycles as number) < 0) return undefined;
    return { proposed: ledger.proposed.length, implemented: ledger.implemented.length, cycles: cycles as number };
  } catch {
    return undefined;
  }
}

/**
 * The project's declared mode, from `<root>/.launch.yaml`, plus the polish counts when it is `polish`
 * and the ledger is readable. Always answers: no file, a broken file or an unknown mode is `develop`.
 */
export function readProjectMode(root: string): ModeFacts {
  let mode: ProjectMode = "develop";
  try {
    mode = normalizeMode(declaredMode(readFileSync(join(root, ".launch.yaml"), "utf8")));
  } catch {
    // no declaration (or an unreadable one): the default mode stands
  }
  if (mode !== "polish") return { mode };
  const polish = readPolishMetrics(root);
  return polish ? { mode, polish } : { mode };
}

/**
 * `⚙ develop` · `🚀 launch` · `✨ polish 12↑ 5✓ 31⟳` · `● live` — one word, a glyph from the standard
 * emoji/symbol set (no Nerd Font glyph, unlike the candybar segment), and for polish with a readable
 * ledger the counts: improvements proposed ↑, implemented ✓, QA cycles ⟳.
 */
export function formatMode(facts: ModeFacts): string {
  switch (facts.mode) {
    case "launch":
      return "🚀 launch";
    case "polish":
      return facts.polish
        ? `✨ polish ${facts.polish.proposed}↑ ${facts.polish.implemented}✓ ${facts.polish.cycles}⟳`
        : "✨ polish";
    case "live":
      return "● live";
    default:
      return "⚙ develop";
  }
}
