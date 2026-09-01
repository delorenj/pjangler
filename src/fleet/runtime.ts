// Bounded, cancellable execution context for fleet observation commands.
//
// Nothing in `src/fleet/` or `src/mcp-server.ts` could express any of this
// before: `grep -n 'AbortController|signal|timeout|deadline|cancel'` over both
// returned zero matches. The inventory needed none of it -- it reads two files.
// A provenance run spawns child processes against arbitrary checkouts, so it
// needs all four of:
//
//   * a per-probe budget, so one hung repository cannot stall the fleet;
//   * a whole-run deadline, so a caller can bound the command itself;
//   * cancellation, so SIGINT (CLI) and an aborted request (MCP) both stop the
//     work AND kill the children it started;
//   * byte bounds, so a probe that decides to print a gigabyte does not become
//     this process's memory problem.
//
// `git`/`gitLine` in `src/describe/activity.ts` are the repo's only exported,
// both-bounded git pair and are deliberately NOT reused here: they hardcode
// `["-C", repo, ...args]` with no slot for the `--no-optional-locks` flag that
// must precede `-C`, they collapse timeout and failure into one bare
// `undefined`, and they are synchronous. `gitAsync` (`activity.ts:93`) is the
// model for the SIGKILL-on-timeout and manual byte counting below.

import { spawn } from "node:child_process";
import { FleetError } from "./types";
import type { FleetProbeOutcome } from "./types";

/** Per-probe wall-clock budget when a caller names none. */
export const FLEET_DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Bytes of stdout one probe may produce before it is killed. */
const PROBE_MAX_BYTES = 4 * 1024 * 1024;

/** Floor on a per-probe budget: below this, nothing can succeed and everything times out. */
const MIN_PROBE_TIMEOUT_MS = 1;

/**
 * One run's time and cancellation budget.
 *
 * Deliberately a value, not a class: both adapters construct one, hand it to the
 * core, and never mutate it. `signal` is the ONLY mutable thing in it, and it is
 * owned by whoever created the controller.
 */
export interface FleetRunContext {
  signal: AbortSignal;
  /** Epoch millis after which the whole run fails with TIMEOUT, or null for unbounded. */
  deadlineAt: number | null;
  probeTimeoutMs: number;
}

export interface FleetRunContextOptions {
  signal?: AbortSignal;
  /** Whole-run budget in millis. A positive integer, or undefined for unbounded. */
  deadlineMs?: number;
  probeTimeoutMs?: number;
  /** Injected clock, so a suite can pin a deadline without sleeping. */
  now?: () => number;
}

/**
 * A never-aborting signal, for callers that pass none.
 *
 * `AbortSignal.abort()` is the opposite (already aborted). A fresh controller's
 * signal is the "no cancellation was requested" value: nothing holds the
 * controller, so nothing can ever abort it, which is exactly the property this
 * constant exists to have. (An earlier version of this comment claimed the
 * controller was retained in a closure. There is no closure -- the controller is
 * discarded on the same line -- and a reader should not be told otherwise.)
 */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

export function createRunContext(options: FleetRunContextOptions = {}): FleetRunContext {
  const now = options.now ?? Date.now;
  const deadline = options.deadlineMs;
  if (deadline !== undefined) {
    if (!Number.isInteger(deadline) || deadline <= 0) {
      throw new FleetError("INVALID_INPUT", "deadlineMs must be a positive whole number of milliseconds");
    }
  }
  const probeTimeout = options.probeTimeoutMs ?? FLEET_DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(probeTimeout) || probeTimeout < MIN_PROBE_TIMEOUT_MS) {
    throw new FleetError("INVALID_INPUT", "probeTimeoutMs must be a positive whole number of milliseconds");
  }
  return {
    signal: options.signal ?? NEVER_ABORTED,
    deadlineAt: deadline === undefined ? null : now() + deadline,
    probeTimeoutMs: probeTimeout,
  };
}

/**
 * Fail the run if the caller has cancelled it.
 *
 * Called between units of work, never inside one: a half-built fact is worse
 * than a fact that was never started, and `CANCELLED` is a COMMAND failure whose
 * envelope carries no `data` at all.
 */
export function throwIfCancelled(ctx: FleetRunContext): void {
  if (ctx.signal.aborted) throw new FleetError("CANCELLED", "Fleet command was cancelled before it completed");
}

/**
 * Millis left on the whole-run deadline, or `Infinity` when there is none.
 *
 * Throws `TIMEOUT` rather than returning zero. A truncated provenance report is
 * exactly the kind of partial that must never be mistaken for a complete one, so
 * a blown deadline is a command failure -- unlike a per-PROBE timeout, which
 * downgrades one fact to `unobserved` and lets the run succeed.
 */
export function remainingMs(ctx: FleetRunContext, now: () => number = Date.now): number {
  throwIfCancelled(ctx);
  if (ctx.deadlineAt === null) return Number.POSITIVE_INFINITY;
  const left = ctx.deadlineAt - now();
  if (left <= 0) throw new FleetError("TIMEOUT", "Fleet command exceeded its deadline before it completed");
  return left;
}

export interface FleetProbeResult {
  outcome: FleetProbeOutcome;
  /** Trimmed stdout on `ok`, null on every other outcome. Never stderr. */
  value: string | null;
}

/**
 * A bounded child's full result, including the half `probe` deliberately drops.
 *
 * `code` is the process exit status (null when the child was killed or never
 * ran). `value` is trimmed stdout, and unlike `FleetProbeResult` it SURVIVES a
 * nonzero exit when the caller asked it to -- see `captureSelf`.
 */
export interface FleetCaptureResult extends FleetProbeResult {
  code: number | null;
}

interface BoundedChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Keep stdout when the child exits nonzero.
   *
   * `probe` says no: a `git remote get-url origin` that exits 1 produced no
   * value worth keeping. `captureSelf` says yes, because `pjangler audit`
   * deliberately exits 1 on a drifted repository (`src/index.ts`) while printing
   * the complete report -- and discarding it would throw away exactly the
   * findings the caller spawned the child for.
   */
  keepStdoutOnFailure?: boolean;
}

/**
 * Git's repository-redirection variables. Every one of them can make
 * `git -C <path> ...` answer about a DIFFERENT repository than `<path>`.
 *
 * They are deleted rather than merely overridden because there is no correct
 * value to override them with: `-C <path>` is the only repository selector this
 * module wants, and any of these present in the ambient environment silently
 * wins over it. `GIT_DIR` alone defeats the top-level-equality guard in
 * `probeCheckout` -- the guard reads `rev-parse --show-toplevel`, which would
 * answer with the redirected repository's toplevel and compare equal to nothing
 * this command probed. `GIT_INDEX_FILE` is worse: it can point `status` at an
 * index OUTSIDE the probed tree, which is a write to a path the read-only
 * guarantee never covered.
 *
 * This is not hypothetical ambient state. A git hook, a `git` wrapper, and
 * `direnv` all export `GIT_DIR`, and both this repo's own suites unset these
 * keys in their isolation blocks -- the production path did not.
 */
const GIT_REDIRECTION_KEYS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
] as const;

/**
 * The environment one probe child gets.
 *
 * `GIT_TERMINAL_PROMPT=0` is the one that keeps a run bounded: without it a
 * checkout with an unauthenticated remote can block on a credential prompt
 * forever behind the timeout. The pager overrides stop git from paging into a
 * pipe nobody drains.
 *
 * `GIT_OPTIONAL_LOCKS=0` is deliberately NOT set. It would do the same job as
 * the `--no-optional-locks` flag every caller passes -- and that is the problem:
 * with both in place, deleting the flag changed nothing and the suite's
 * index-mtime assertion stayed green. Measured. One mechanism, provably
 * load-bearing, beats two that hide each other.
 */
export function probeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
  for (const key of GIT_REDIRECTION_KEYS) delete env[key];
  return env;
}

/**
 * Run one bounded child and parse its stdout into a single value.
 *
 * Four deliberate choices:
 *
 *   * SPAWNED BY NAME, never by absolute path and never through a shell. `PATH`
 *     applies, which is what lets a fake `git` shim make the probe-failure and
 *     probe-timeout cases real rather than mocked.
 *   * ARGV ONLY. No shell means no quoting, no globbing, and no way for a
 *     registry value to become a second command.
 *   * STDERR IS NEVER READ. `stdio` sends it to `ignore`, so there is no moment
 *     at which a subprocess's message -- which routinely carries absolute paths
 *     and payload fragments -- exists to be leaked into an envelope.
 *   * TIMEOUT AND FAILURE ARE DISTINCT. `git`/`gitAsync` return a bare
 *     `undefined` for both; a fact that says `unobserved` has to be able to say
 *     WHY, and "the probe was killed" and "the probe said no" are different
 *     answers to an operator.
 */
export function probe(ctx: FleetRunContext, argv: readonly string[], cwd?: string): Promise<FleetProbeResult> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve({ outcome: "failed", value: null });
  return runBoundedChild(ctx, command, args, { cwd });
}

/**
 * Run one bounded child of THIS BUILD and keep its stdout whatever it exits with.
 *
 * `process.execPath` is the one deliberate absolute-path spawn in this module.
 * Everything else spawns by name so `PATH` applies -- which is what makes the
 * fake-`git` shim cases real. Here the opposite is required: a `node` picked off
 * `PATH` could be a different runtime than the one running this process, and a
 * status core that parses its own CLI's JSON must be parsing the SAME build's
 * JSON. `entry` is the module path to run; the caller resolves it (and the
 * documented `PJ_FLEET_CLI_ENTRY` seam is what lets a suite point it at a shim).
 *
 * The other half of the contract is `keepStdoutOnFailure`. `pjangler audit`
 * exits 1 on a drifted repository BY DESIGN, with the full report on stdout;
 * `probe` discards stdout on a nonzero exit, so routing this through `probe`
 * would report every drifted repository as `outcome: "failed"` with its findings
 * thrown away -- the exact opposite of what a status run is for.
 */
export function captureSelf(
  ctx: FleetRunContext,
  entry: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<FleetCaptureResult> {
  return runBoundedChild(ctx, process.execPath, [entry, ...args], { cwd, env, keepStdoutOnFailure: true });
}

function runBoundedChild(
  ctx: FleetRunContext,
  command: string,
  args: readonly string[],
  options: BoundedChildOptions = {},
): Promise<FleetCaptureResult> {
  const { cwd, env, keepStdoutOnFailure = false } = options;
  // Checked BEFORE the spawn, so a cancelled or expired run never starts one
  // more child. `remainingMs` throws TIMEOUT and CANCELLED; both are command
  // failures and must escape rather than become a probe outcome.
  const budget = Math.min(ctx.probeTimeoutMs, remainingMs(ctx));

  return new Promise<FleetCaptureResult>((settle) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        // Its own process GROUP, so `kill` below can reach the whole tree.
        // Measured: a shim that is `#!/bin/sh ... sleep 60` puts the sleep under
        // the sh. SIGKILLing the sh alone leaves the sleep holding the write end
        // of our stdout pipe, and the CLI then hung after writing its CANCELLED
        // envelope -- exit code set, process never leaving, because an active
        // handle kept the loop alive.
        detached: true,
        // An observation probe has no business inheriting a pager, an editor, a
        // credential helper, a terminal, or -- above all -- a redirected
        // repository. See `probeEnv` for what is stripped and why. A caller that
        // needs a NARROWER environment (the audit child, which must carry no
        // credential at all) passes its own.
        env: env ?? probeEnv(),
      });
    } catch {
      settle({ outcome: "failed", value: null, code: null });
      return;
    }

    let out = "";
    let size = 0;
    let settled = false;
    const finish = (result: FleetCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      // Release the pipe, always. Node keeps the event loop alive for an open
      // stdio handle, so without this a probe we walked away from -- killed on
      // timeout or on abort -- kept the whole command from ever exiting, even
      // with `process.exitCode` already set and the envelope already written.
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      child.unref();
      settle(result);
    };
    // The GROUP, not just the leader: a shell shim's own children are what keep
    // the pipe open after the shell dies. Falls back to the single process when
    // the group is already gone or the platform refuses the negative pid.
    const kill = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };

    const timer = setTimeout(() => { kill(); finish({ outcome: "timeout", value: null, code: null }); }, budget);
    timer.unref?.();

    const onAbort = (): void => { kill(); finish({ outcome: "cancelled", value: null, code: null }); };
    // If the caller cancelled between the budget check and the spawn, the
    // listener fires immediately and the child is killed on its first tick.
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += chunk.length;
      if (size > PROBE_MAX_BYTES) { kill(); finish({ outcome: "failed", value: null, code: null }); return; }
      out += chunk;
    });
    child.on("error", () => finish({ outcome: "failed", value: null, code: null }));
    child.on("close", (code) => {
      if (code !== 0) {
        // `keepStdoutOnFailure` is the whole reason this body was extracted from
        // `probe`. The outcome still says `failed`; what changes is that the
        // caller can read WHAT the child said before it said no.
        finish({ outcome: "failed", value: keepStdoutOnFailure ? out.trim() : null, code });
        return;
      }
      finish({ outcome: "ok", value: out.trim(), code });
    });
  });
}

/**
 * Run `tasks` with at most `limit` in flight, preserving input order in the result.
 *
 * Bounded concurrency is a requirement, not an optimization: 28 agents can name
 * 28 distinct checkouts, and 28 simultaneous `git status` runs on a cold cache
 * is a self-inflicted load spike on the operator's own machine. Results are
 * indexed by position rather than push order, because ordering by COMPLETION
 * would make `data` depend on which probe happened to finish first -- and
 * `data` has to be byte-identical across two runs over identical state.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
