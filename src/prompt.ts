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
// pjangler project (or, in a zellij pane outside every project, a crank-only
// line: crank mode belongs to the pane, read straight from the arbiter's hash), print
// NOTHING otherwise. Starship renders a custom module's format wrapper even when the command fails, so "no output" — not a
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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { computeRepoActivity } from "./describe/activity";
import { findProjectRoot, resolveBoardUrl } from "./project/boardUrl";
import {
  formatCandybars,
  formatCrank,
  formatIdentity,
  freshSegments,
  maybeRefresh,
  pipelineCachePath,
  readPaneCrank,
  readPipelineCache,
  zellijPane,
  type CandybarCounts,
  type CrankState,
  type IdentitySummary,
} from "./prompt-pipeline";
import { readProjectManifest, readProjectPm, type ProjectPm } from "./prompt-pm";

export interface PromptFacts {
  root: string;
  slug: string;
  identifier?: string;
  age?: string;
  active: boolean;
  /** 33GOD pipeline (cached, see ./prompt-pipeline): this project's / all registered candybars. */
  candybars?: CandybarCounts | null;
  /** 33GOD pipeline: crank mode for this pane (read directly in zellij, cached outside it). */
  crank?: CrankState | null;
  /** The project's PM employee, from its role manifest (`agents.<id>.role_dir`/role.yaml). */
  pm?: ProjectPm;
  /** The PM's company identity against Flume's identity manifest (cached; `flume identity manifest`). */
  identity?: IdentitySummary | null;
}

export { readProjectPm, type ProjectPm };

/**
 * `@tolt_pm_bot(PM) id v1 5/6`: the PM's bot, then its company identity: the identity-manifest version it is
 * judged against and how many of that manifest's required points it holds. `id none` when the PM was never
 * enrolled; no identity part at all while it is unknown (no cache yet, or Flume did not answer).
 */
export function formatPm(pm: ProjectPm, identity?: IdentitySummary | null): string {
  const name = `${pm.botUsername ? `@${pm.botUsername}` : pm.agentId}(PM)`;
  return identity ? `${name} ${formatIdentity(identity)}` : name;
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
  const { slug, identifier, agents } = readProjectManifest(root);
  const activity = computeRepoActivity(root, { now });
  return {
    root,
    slug,
    identifier,
    age: activity.updatedUnix ? activity.compact : undefined,
    active: activity.active,
    pm: readProjectPm(root, slug, agents),
  };
}

/** `pjangler (PJAN) · 3m · @pjangler_pm_bot(PM) id v1 6/6 · <candy> 3/124 · ⚡ crank ↑3d4h ↻5m ⏳2m` — deliberately terse; a prompt is not a report. */
export function formatPromptLine(facts: PromptFacts, nowMs: number = Date.now()): string {
  const parts = [facts.slug];
  // The board prefix is context, not a competing identity. PJAN-80 collapsed
  // project identity onto the manifest's `project_id` and dropped this badge on
  // the way past, but that answers a different question: the canonical id says
  // WHICH PROJECT, the prefix says which board the ticket refs you are about to
  // type at this prompt belong to. Nothing else moved with it — `pj describe`
  // still badges the same value beside the project name, and README documents
  // this line as `pjangler (PJAN) · 3m` — so the prompt became the one surface
  // that disagreed, while still parsing the identifier it no longer printed.
  if (facts.identifier) parts.push(`(${facts.identifier})`);
  const segments = [parts.join(" ")];
  if (facts.age) segments.push(facts.age);
  // The PM is the project's own employee: identity, so it precedes the pipeline machinery.
  if (facts.pm) segments.push(formatPm(facts.pm, facts.identity));
  // The pipeline segments sit after the age: identity first, then the 33GOD machinery around it.
  // Each is omitted (never guessed) when its source did not answer or the cache has expired.
  if (facts.candybars) segments.push(formatCandybars(facts.candybars));
  // Crank stays the LAST segment: it is the one that moves (the countdown), so it ends the line.
  if (facts.crank) segments.push(formatCrank(facts.crank, nowMs));
  return segments.join(" · ");
}

/** Returns the line to print, or undefined when there is nothing to say. */
export async function promptLine(cwd: string, now?: Date, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const nowMs = (now ?? new Date()).getTime();
  // Start the Redis read first: it waits on the network while the project facts below hit the disk.
  const paneCrank = zellijPane(env) ? readPaneCrank(env, nowMs) : undefined;
  const root = findProjectRoot(cwd);
  if (!root) {
    // A zellij pane outside every project: crank mode is the pane's, so the line is the crank segment alone
    // (`⚡ crank ↑22m ↻5m ⏳4m`), or nothing when the arbiter has no answer for this pane.
    const crank = await paneCrank;
    return crank ? formatCrank(crank, nowMs) : undefined;
  }
  const facts = readPromptFacts(root, now);
  const cachePath = pipelineCachePath(root, env);
  const cache = readPipelineCache(cachePath, root);
  Object.assign(facts, freshSegments(cache, nowMs));
  // In a zellij pane crank is read directly (above), never from the cache.
  if (paneCrank) facts.crank = (await paneCrank) ?? null;
  // Stale-while-revalidate: print what the cache says now, refresh behind the prompt.
  maybeRefresh(root, cachePath, cache, nowMs, env);
  return formatPromptLine(facts, nowMs);
}

async function main(): Promise<void> {
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
    const line = await promptLine(process.cwd());
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

if (isMainModule()) void main();
