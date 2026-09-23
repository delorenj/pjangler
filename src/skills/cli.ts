import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { constants } from "node:os";
import type { Command } from "commander";

/**
 * PJAN-135: `pj skills [args...]` is the Skillex CLI pjangler names in its own
 * guidance, at the exact version it audits with.
 *
 * The guidance used to say "run `skillex migrate`". On the operator's shell
 * `skillex` resolved to the retired Python CLI (no `migrate`), and the Node CLI
 * pinned by the generated mise task could not install at all behind mise's
 * 30-day minimumPackageAge gate. A remedy that depends on PATH, mise and the
 * npm age gate is not a remedy. The bundled `@delorenj/skillex` dependency is
 * the same package `inspectStatus`/`sync` ran in-process, so spawning its own
 * `bin` with this Node is guaranteed to exist and to agree with the audit.
 */
export interface BundledSkillex {
  /** Absolute path of the package's `skillex` bin script. */
  bin: string;
  /** The package version, e.g. "0.1.1". */
  version: string;
}

export function bundledSkillex(): BundledSkillex {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@delorenj/skillex/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; bin?: unknown };
  const bin = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" ? (manifest.bin as Record<string, unknown>).skillex : undefined;
  if (typeof bin !== "string" || !bin) throw new Error(`${manifestPath} declares no skillex bin`);
  return { bin: resolve(dirname(manifestPath), bin), version: String(manifest.version ?? "unknown") };
}

/** How the bundled skillex ended: its exit status, or the signal that killed it. */
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
 * Run the bundled CLI with `args` untouched, stdio inherited, relaying
 * termination signals to it and waiting for it to end. Resolves with how it
 * ended, so a Ctrl-C is never reported as success.
 */
export async function runBundledSkillex(args: readonly string[]): Promise<SkillexOutcome> {
  let cli: BundledSkillex;
  try {
    cli = bundledSkillex();
  } catch (error) {
    process.stderr.write(`pjangler install is missing its @delorenj/skillex dependency (${error instanceof Error ? error.message : String(error)}); reinstall @delorenj/pjangler\n`);
    return { code: 1 };
  }
  return await new Promise<SkillexOutcome>((resolveOutcome) => {
    const child = spawn(process.execPath, [cli.bin, ...args], { stdio: "inherit" });
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
      process.stderr.write(`could not start the bundled skillex ${cli.version}: ${error.message}\n`);
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
  let version = "";
  try { version = ` ${bundledSkillex().version}`; } catch { /* reported when run */ }
  program
    .command("skills")
    .description(`Run the bundled Skillex${version} CLI; every argument passes through (e.g. pj skills migrate --project <repo>)`)
    .argument("[args...]", "skillex command and options, passed through unchanged")
    // Everything after `skills` belongs to skillex, including --help and
    // --version: `pj skills --help` is skillex's help, not a pjangler stub.
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .action(async (args: string[] | undefined) => {
      await endLikeSkillex(await runBundledSkillex(skillsPassthroughArgs(process.argv.slice(2), args ?? [])), exit);
    });
}
