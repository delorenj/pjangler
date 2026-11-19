import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Command } from "commander";

/**
 * PJAN-135, Story 7.1 AC5 (one skillex): `pj skills [args...]` is the Skillex
 * CLI pjangler names in its own guidance, and it is the ONE skillex on this
 * machine: the CLI on PATH, never a second copy bundled inside pjangler.
 *
 * Until 2026-11-19 this spawned the `@delorenj/skillex` bin bundled in
 * pjangler's node_modules, because on the operator's shell `skillex` resolved
 * to the retired Python CLI (no `migrate`) and the mise-pinned Node CLI could
 * not install behind mise's release-age gate. Both causes are gone (the Python
 * CLI is retired; the global mise config tracks `latest` and exempts
 * @delorenj/skillex from the age gate), and the bundled copy had become the
 * problem: `pj skills --version` said 0.4.4 while `skillex --version` said
 * 0.4.8. A pjangler release froze whatever skillex CLI it happened to depend on.
 *
 * pjangler still depends on `@delorenj/skillex` as a LIBRARY: the parity
 * audit calls inspectStatus/sync/resolveSelection in-process. That is a code
 * dependency with its own pin (moving it changes audit behaviour: 0.4.10
 * refuses legacy `sets` manifests, which five suites still exercise); it is no
 * longer a CLI anyone runs.
 *
 * Resolution order mirrors skillex's own hermes-skillex-resync.py, so every
 * caller finds the same binary without interactive shell setup:
 *   1. $SKILLEX_BIN, an explicit override that is never second-guessed;
 *   2. `skillex` on PATH;
 *   3. the mise shim ($MISE_DATA_DIR/shims, $XDG_DATA_HOME/mise/shims,
 *      ~/.local/share/mise/shims);
 *   4. `mise which skillex`.
 * Nothing found is a clear error naming every place looked, never a fallback.
 */
export interface ResolvedSkillex {
  /** Absolute path of the skillex executable that `pj skills` runs. */
  bin: string;
  /** Where it was found: "SKILLEX_BIN", "PATH", "mise shim" or "mise which". */
  source: "SKILLEX_BIN" | "PATH" | "mise shim" | "mise which";
}

export class SkillexNotFoundError extends Error {
  constructor(readonly tried: readonly string[]) {
    super(`no skillex CLI found (set SKILLEX_BIN, or install @delorenj/skillex: mise use -g npm:@delorenj/skillex@latest); looked at: ${tried.join("; ")}`);
    this.name = "SkillexNotFoundError";
  }
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `name` on `pathValue`, like `command -v`. */
export function whichOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (executableFile(candidate)) return candidate;
  }
  return undefined;
}

export function resolveSkillex(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): ResolvedSkillex {
  const tried: string[] = [];
  const explicit = env.SKILLEX_BIN?.trim();
  if (explicit) {
    const bin = explicit.includes(sep) ? resolve(explicit) : whichOnPath(explicit, env.PATH);
    if (!bin || !executableFile(bin)) throw new SkillexNotFoundError([`SKILLEX_BIN=${explicit} is not an executable file`]);
    return { bin, source: "SKILLEX_BIN" };
  }
  const onPath = whichOnPath("skillex", env.PATH);
  if (onPath) return { bin: onPath, source: "PATH" };
  tried.push(`PATH (${env.PATH ?? "unset"})`);
  const shimDirs = [
    env.MISE_DATA_DIR ? join(env.MISE_DATA_DIR, "shims") : undefined,
    env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "mise", "shims") : undefined,
    join(home, ".local", "share", "mise", "shims"),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of [...new Set(shimDirs)]) {
    const shim = join(dir, "skillex");
    if (executableFile(shim)) return { bin: shim, source: "mise shim" };
    tried.push(`mise shim ${shim}`);
  }
  const mise = whichOnPath("mise", env.PATH) ?? [join(home, ".local", "bin", "mise")].find(executableFile);
  if (mise) {
    const ran = spawnSync(mise, ["which", "skillex"], { encoding: "utf8", env, timeout: 20_000 });
    const found = ran.status === 0 ? ran.stdout.trim() : "";
    if (found && executableFile(found)) return { bin: found, source: "mise which" };
    tried.push(`mise which skillex (exit ${ran.status ?? ran.signal ?? "?"})`);
  } else {
    tried.push("mise (not on PATH or at ~/.local/bin/mise)");
  }
  throw new SkillexNotFoundError(tried);
}

/**
 * The child's env: unchanged, except that the directory of the Node running
 * pj goes first on PATH. A skillex launcher whose shebang is
 * `#!/usr/bin/env node` then runs on pjangler's own Node (engines >=24)
 * instead of whatever older node a minimal PATH finds first.
 */
export function skillexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);
  const rest = (env.PATH ?? "").split(delimiter).filter((dir) => dir && dir !== nodeDir);
  return { ...env, PATH: [nodeDir, ...rest].join(delimiter) };
}

/** How skillex ended: its exit status, or the signal that killed it. */
export type SkillexOutcome = { code: number } | { signal: NodeJS.Signals };

/**
 * The termination signals `pj skills` relays to skillex. PJAN-135 review: the
 * run used to block in spawnSync with no handlers, so a signal sent to pj's pid
 * alone (a supervisor, execFile's timeout, a Python subprocess timeout — how
 * the Hermes PM runs guidance commands) killed pj at once and orphaned skillex,
 * which kept running and writing while the caller saw 143 and assumed it had
 * stopped. A terminal Ctrl-C reaches both already; relaying it again is
 * harmless. SIGKILL cannot be caught, so it cannot be relayed.
 */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/**
 * Run the skillex CLI with `args` untouched, stdio inherited, relaying
 * termination signals to it and waiting for it to end. Resolves with how it
 * ended, so a Ctrl-C is never reported as success.
 */
export async function runSkillex(args: readonly string[]): Promise<SkillexOutcome> {
  let cli: ResolvedSkillex;
  try {
    cli = resolveSkillex();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { code: 1 };
  }
  return await new Promise<SkillexOutcome>((resolveOutcome) => {
    const child = spawn(cli.bin, [...args], { stdio: "inherit", env: skillexChildEnv() });
    const relay = (signal: NodeJS.Signals) => {
      try { child.kill(signal); } catch { /* already gone */ }
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, relay);
    let settled = false;
    const settle = (outcome: SkillexOutcome) => {
      if (settled) return;
      settled = true;
      for (const signal of FORWARDED_SIGNALS) process.off(signal, relay);
      resolveOutcome(outcome);
    };
    child.once("error", (error) => {
      process.stderr.write(`could not start skillex (${cli.source}: ${cli.bin}): ${error.message}\n`);
      settle({ code: 1 });
    });
    child.once("exit", (code, signal) => settle(signal ? { signal } : { code: code ?? 1 }));
  });
}

/**
 * End pj the way skillex ended: its exit status, or death by the same signal
 * (a shell reports 128 + signo either way; a supervisor sees the real signal).
 */
export async function endLikeSkillex(outcome: SkillexOutcome, exit: (code: number) => Promise<never> | never): Promise<never> {
  if ("code" in outcome) return await exit(outcome.code);
  const signo = (constants.signals as Record<string, number>)[outcome.signal] ?? 1;
  process.removeAllListeners(outcome.signal);
  process.kill(process.pid, outcome.signal);
  // Reached only if the signal did not end this process.
  await new Promise((done) => setTimeout(done, 100));
  return await exit(128 + signo);
}

/** Shell-quote a path for a copy-paste command: double quotes unless unsafe inside them. */
export function shellQuotePath(path: string): string {
  if (!/["$`\\!]/.test(path)) return `"${path}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact argv after `skills`. Commander drops a leading `--` even with
 * passThroughOptions, and "passed through unchanged" has to mean byte for byte.
 * Program options take no values and positional options keep them before the
 * subcommand, so `skills` is the first non-option token of a direct call;
 * anything else (`pj help skills`) falls back to commander's parse.
 */
export function skillsPassthroughArgs(argv: readonly string[], parsed: readonly string[]): string[] {
  const index = argv.findIndex((arg) => !arg.startsWith("-"));
  return index >= 0 && argv[index] === "skills" ? argv.slice(index + 1) : [...parsed];
}

export function registerSkillsCli(program: Command, exit: (code: number) => Promise<never> | never): void {
  program
    .command("skills")
    .description("Run the Skillex CLI on PATH (SKILLEX_BIN, PATH, then the mise shim); every argument passes through (e.g. pj skills migrate --project <repo>)")
    .argument("[args...]", "skillex command and options, passed through unchanged")
    // Everything after `skills` belongs to skillex, including --help and
    // --version: `pj skills --help` is skillex's help, not a pjangler stub.
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .action(async (args: string[] | undefined) => {
      await endLikeSkillex(await runSkillex(skillsPassthroughArgs(process.argv.slice(2), args ?? [])), exit);
    });
}
