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

import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { computeRepoActivity } from "./describe/activity";
import { findProjectRoot, resolveBoardUrl } from "./project/boardUrl";
import {
  formatCandybars,
  formatCrank,
  freshSegments,
  maybeRefresh,
  pipelineCachePath,
  readPaneCrank,
  readPipelineCache,
  zellijPane,
  type CandybarCounts,
  type CrankState,
} from "./prompt-pipeline";

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
  /** The template commit Flume pins (cached); a PM rendered from another one is behind. */
  templatePin?: string | null;
}

export interface ProjectPm {
  agentId: string;
  /** Telegram bot username, without the `@`. */
  botUsername?: string;
  /** Telegram bot ID. */
  botId?: string;
  /** The hermes-agent-template commit the PM's role manifest was rendered or refreshed from. */
  templateRev?: string;
}

/** One top-level scalar of a role manifest (`key: "value"`), or the field of a top-level block. */
function manifestScalar(text: string, key: string, block?: string): string | undefined {
  let scope = text;
  if (block) {
    const start = new RegExp(`^${block}:[ \\t]*(?:#.*)?$`, "m").exec(text);
    if (!start) return undefined;
    const rest = text.slice(start.index + start[0].length + 1);
    const end = /^\S/m.exec(rest);
    scope = end ? rest.slice(0, end.index) : rest;
  }
  const indent = block ? "[ \\t]+" : "";
  const match = new RegExp(`^${indent}${key}:[ \\t]*"?([^"\\s#]*)"?`, "m").exec(scope);
  return match?.[1] || undefined;
}

/**
 * The project's PM: the `agents` entry with role `pm` (`<slug>-pm` first when a
 * project has more than one), read from its tracked role manifest. A plain text
 * read, not a YAML parse: this bundle stays import-free for the prompt's budget.
 */
export function readProjectPm(root: string, slug: string, agents: unknown): ProjectPm | undefined {
  if (!agents || typeof agents !== "object") return undefined;
  const pms = Object.entries(agents as Record<string, unknown>)
    .filter(([, entry]) => (entry as { role?: unknown })?.role === "pm");
  if (!pms.length) return undefined;
  const [agentId, entry] = pms.find(([id]) => id === `${slug}-pm`) ?? pms[0]!;
  const pm: ProjectPm = { agentId };
  const roleDir = (entry as { role_dir?: unknown }).role_dir;
  try {
    const text = readFileSync(join(root, typeof roleDir === "string" && roleDir ? roleDir : join("agents", "hermes", "pm"), "role.yaml"), "utf8");
    pm.botUsername = manifestScalar(text, "bot_username", "telegram");
    pm.botId = manifestScalar(text, "bot_id", "telegram");
    const rev = manifestScalar(text, "template_rev");
    if (rev && /^[0-9a-f]{7,40}$/.test(rev)) pm.templateRev = rev;
  } catch {
    // A PM declared in the manifest but not on disk still has a name.
  }
  return pm;
}

/**
 * `@tolt_pm_bot(PM) 8467282336 [c738f69]`: the PM's bot, its ID, and the template
 * revision its manifest was rendered from. `[c738f69 ↑b5aa431]` when Flume pins a
 * newer template; `[?]` when the manifest predates the stamp.
 */
export function formatPm(pm: ProjectPm, templatePin?: string | null): string {
  const parts = [`${pm.botUsername ? `@${pm.botUsername}` : pm.agentId}(PM)`];
  if (pm.botId) parts.push(pm.botId);
  const rev = pm.templateRev?.slice(0, 7);
  const behind = rev && templatePin && !templatePin.startsWith(pm.templateRev!) ? ` ↑${templatePin.slice(0, 7)}` : "";
  parts.push(`[${rev ?? "?"}${behind}]`);
  return parts.join(" ");
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
  let agents: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".project.json"), "utf8")) as Record<string, unknown>;
    const projectId = manifest.project_id ?? manifest.project_slug;
    if (typeof projectId === "string" && projectId.trim()) slug = projectId.trim().toLowerCase();
    const provider = manifest.ticket_provider as Record<string, unknown> | undefined;
    if (provider && typeof provider.identifier === "string" && provider.identifier) identifier = provider.identifier;
    agents = manifest.agents;
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
    pm: readProjectPm(root, slug, agents),
  };
}

/** `pjangler (PJAN) · 3m · @pjangler_pm_bot(PM) 8538501729 [c738f69] · <candy> 3/124 · ⚡ crank ↑3d4h ↻5m ⏳2m` — deliberately terse; a prompt is not a report. */
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
  if (facts.pm) segments.push(formatPm(facts.pm, facts.templatePin));
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
