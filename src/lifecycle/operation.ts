import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

/** One monotonic deadline for the whole MCP request, never reset by nested work. */
export const MCP_OPERATION_TIMEOUT_MS = 120_000;
export const MCP_CLEANUP_GRACE_MS = 500;
export const MCP_FORCE_WAIT_MS = 100;
export const MCP_CHILD_MAX_BYTES = 16 * 1024 * 1024;

export type StopReason = "cancelled" | "deadline-exceeded";
export class OperationStopped extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, options?: ErrorOptions) {
    super(`MCP operation ${reason}${options?.cause instanceof Error ? `: ${options.cause.message}` : ""}`, options);
    this.reason = reason;
    this.name = "OperationStopped";
  }
}
export interface OperationContext {
  readonly signal: AbortSignal;
  /** Monotonic performance.now() epoch in milliseconds. */
  readonly deadlineMs: number;
  readonly stopReason: () => StopReason | undefined;
  readonly stop: (reason: StopReason) => void;
  readonly close: () => void;
}
const activeOperation = new AsyncLocalStorage<OperationContext>();
export const currentOperation = () => activeOperation.getStore();
export const withOperation = <T>(operation: OperationContext, work: () => Promise<T>): Promise<T> => activeOperation.run(operation, work);

export function createOperation(requestSignal: AbortSignal, timeoutMs = MCP_OPERATION_TIMEOUT_MS): OperationContext {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new RangeError("timeoutMs must be an integer from 1 to 600000 milliseconds");
  }
  const deadlineMs = performance.now() + timeoutMs;
  const controller = new AbortController();
  let reason: StopReason | undefined;
  const stop = (why: StopReason) => { if (!reason) { reason = why; controller.abort(new OperationStopped(why)); } };
  const cancelled = () => stop("cancelled");
  requestSignal.addEventListener("abort", cancelled, { once: true });
  if (requestSignal.aborted) cancelled();
  const timer = setTimeout(() => stop("deadline-exceeded"), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal, deadlineMs,
    stopReason: () => { if (!reason && performance.now() >= deadlineMs) stop("deadline-exceeded"); return reason; },
    stop,
    close: () => { clearTimeout(timer); requestSignal.removeEventListener("abort", cancelled); },
  };
}
export function assertOperationActive(operation = currentOperation()): void {
  const reason = operation?.stopReason();
  if (reason) throw new OperationStopped(reason);
}
/** Call at catch boundaries before interpreting an error as optional/fallback work. */
export function rethrowOperationStopped(error: unknown): void {
  if (error instanceof OperationStopped) throw error;
  assertOperationActive();
}
export async function runProcess(command: string, args: readonly string[], options: ChildOptions & { timeout?: number; encoding?: string } = {}): Promise<ChildOutcome> {
  const { timeout, encoding: _encoding, ...rest } = options;
  return runChild(command, args, { ...rest, timeoutMs: rest.timeoutMs ?? timeout });
}

export interface ChildOutcome { status: number | null; stdout: string; stderr: string; error?: Error }
export interface ChildOptions extends Omit<SpawnOptionsWithoutStdio, "timeout" | "signal" | "detached" | "stdio"> {
  input?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  operation?: OperationContext;
}

/** POSIX group cleanup is timed from stop, independent of exit/close/stdio. */
export async function runChild(command: string, args: readonly string[], options: ChildOptions = {}): Promise<ChildOutcome> {
  const operation = options.operation ?? currentOperation();
  assertOperationActive(operation);
  const { input, maxBuffer = MCP_CHILD_MAX_BYTES, timeoutMs, operation: _operation, ...spawnOptions } = options;
  const remaining = operation ? Math.max(1, Math.ceil(operation.deadlineMs - performance.now())) : undefined;
  const budget = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining ?? timeoutMs);
  return await new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(command, [...args], { ...spawnOptions, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "", size = 0;
    let error: Error | undefined;
    let stopped: StopReason | "output-overflow" | undefined;
    let settled = false;
    let status: number | null = null;
    let grace: NodeJS.Timeout | undefined, forceWait: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          error = new Error(`Subprocess group ${signal} failed: ${(err as Error).message}`, { cause: err });
        }
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(grace); clearTimeout(forceWait);
      operation?.signal.removeEventListener("abort", aborted);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      const reason = operation?.stopReason() ?? (stopped === "output-overflow" ? undefined : stopped);
      if (reason) reject(new OperationStopped(reason, error ? { cause: error } : undefined));
      else if (error?.message.startsWith("Subprocess group ")) reject(error);
      else resolve({ status, stdout, stderr, error });
    };
    const stop = (reason: StopReason | "output-overflow") => {
      if (stopped || settled) return;
      stopped = reason;
      if (reason === "deadline-exceeded") operation?.stop("deadline-exceeded");
      signalGroup("SIGTERM");
      grace = setTimeout(() => {
        signalGroup("SIGKILL");
        forceWait = setTimeout(finish, MCP_FORCE_WAIT_MS);
      }, MCP_CLEANUP_GRACE_MS);
    };
    const aborted = () => stop(operation?.stopReason() ?? "cancelled");
    operation?.signal.addEventListener("abort", aborted, { once: true });
    if (operation?.signal.aborted) aborted();
    if (budget !== undefined) timeout = setTimeout(() => stop(operation?.stopReason() ?? "deadline-exceeded"), budget);
    const append = (which: "stdout" | "stderr", chunk: Buffer) => {
      if (stopped) return;
      size += chunk.length;
      if (size > maxBuffer) { error = new Error(`Subprocess output exceeded ${maxBuffer} bytes`); stop("output-overflow"); return; }
      if (which === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (err) => { error = err; if (!child.pid) finish(); });
    child.stdin.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") error = err; });
    child.once("close", (code) => { status = code; if (!stopped) finish(); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
