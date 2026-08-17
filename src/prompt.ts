#!/usr/bin/env node
// `pjangler-prompt` — the shell-prompt surface.
//
// This is a SEPARATE entry point from the main CLI on purpose. `dist/index.js`
// pulls in the whole parity rule set (a ~280KB module) and takes ~52ms just to
// boot, which is far too much to pay on every shell prompt. This bundle
// imports only the activity probe and node builtins, so it lands near node's
// own startup floor.
//
// Contract with starship: print ONE line and exit 0 when the cwd is inside a
// pjangler project, print NOTHING otherwise. Starship renders a custom
// module's format wrapper even when the command fails, so "no output" — not a
// non-zero exit — is what makes the extra prompt line disappear cleanly.
//
// `--url [ref]` is the second contract: print the board (or work-item) URL for
// this project and nothing else, exiting non-zero when there is nothing to
// point at so a shell widget can tell "no project here" from "here it is".
// It lives on THIS entry point rather than the main CLI for one reason — the
// prompt and the shortcut must never disagree about which board you are on,
// and the cheapest way to guarantee that is to make them the same program
// reading the same facts.
//
// Never throws. A broken manifest degrades to the directory name rather than
// spilling a stack trace into someone's prompt.

import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { computeRepoActivity } from "./describe/activity";
import { findProjectRoot, resolveBoardUrl } from "./project/boardUrl";

export interface PromptFacts {
  root: string;
  slug: string;
  identifier?: string;
  age?: string;
  active: boolean;
}

/**
 * Nearest ancestor holding a `.project.json`, starting at `from`.
 *
 * Walking up matters: most of the time you are in `src/` or `docs/`, not the
 * repo root. Node resolves symlinks in `process.cwd()`, so unlike the shell's
 * `$PWD` this needs no physical-path fallback.
 *
 * Re-exported rather than reimplemented: `--url` resolution needs the same
 * walk, and two copies of "where is the project root" is exactly the kind of
 * drift that makes the prompt and the shortcut disagree.
 */
export { findProjectRoot };

export function readPromptFacts(root: string, now?: Date): PromptFacts {
  let slug = basename(root);
  let identifier: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".project.json"), "utf8")) as Record<string, unknown>;
    if (typeof manifest.project_slug === "string" && manifest.project_slug) slug = manifest.project_slug;
    const provider = manifest.ticket_provider as Record<string, unknown> | undefined;
    if (provider && typeof provider.identifier === "string" && provider.identifier) identifier = provider.identifier;
  } catch {
    // A malformed manifest still identifies a project; the directory name is a
    // truthful fallback and keeps the prompt line from vanishing confusingly.
  }

  const activity = computeRepoActivity(root, { now });
  return {
    root,
    slug,
    identifier,
    age: activity.updatedUnix ? activity.compact : undefined,
    active: activity.active,
  };
}

/** `pjangler (PJAN) · 3m` — deliberately terse; a prompt is not a report. */
export function formatPromptLine(facts: PromptFacts): string {
  const parts = [facts.slug];
  if (facts.identifier) parts.push(`(${facts.identifier})`);
  const head = parts.join(" ");
  return facts.age ? `${head} · ${facts.age}` : head;
}

/** Returns the line to print, or undefined when there is nothing to say. */
export function promptLine(cwd: string, now?: Date): string | undefined {
  const root = findProjectRoot(cwd);
  if (!root) return undefined;
  return formatPromptLine(readPromptFacts(root, now));
}

function main(): void {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--url") {
      // Trailing newline here, unlike the prompt line: this output is consumed
      // by `$(...)` and read by humans, not spliced into a prompt string.
      const url = resolveBoardUrl(process.cwd(), args[1]);
      if (url) process.stdout.write(`${url}\n`);
      else process.exitCode = 1;
      return;
    }
    const line = promptLine(process.cwd());
    if (line) process.stdout.write(line);
  } catch {
    // A prompt must never be the thing that breaks a shell.
  }
}

/**
 * Run only when executed directly, so the pieces above stay importable.
 * `realpathSync` matters: npm installs bins as symlinks, so argv[1] is
 * `.bin/pjangler-prompt` while import.meta.url is the real `dist/prompt.js`.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
