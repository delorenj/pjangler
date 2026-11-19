import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

/** One monotonic deadline for the whole MCP request, never reset by nested work. */
export const MCP_OPERATION_TIMEOUT_MS = 120_000;
export const MCP_CLEANUP_GRACE_MS = 500;
export const MCP_FORCE_WAIT_MS = 100;
export const MCP_CHILD_MAX_BYTES = 16 * 1024 * 1024;

export type StopReason = "cancelled" | "deadline-exceeded";
export class OperationStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`MCP operation ${reason}`);
    this.name = "OperationStopped";
  }
}

export interface OperationContext {
  readonly signal: AbortSignal;
  /** Monotonic performance.now() epoch in milliseconds. */
  readonly deadlineMs: number;
  readonly stopReason: () => StopReason | undefined;
  readonly close: () => void;
}
const activeOperation = new AsyncLocalStorage<OperationContext>();
export const currentOperation = () => activeOperation.getStore();
export const withOperation = <T>(operation: OperationContext, work: () => Promise<T>): Promise<T> => activeOperation.run(operation, work);

export function createOperation(requestSignal: AbortSignal, timeoutMs = MCP_OPERATION_TIMEOUT_MS): OperationContext {
  const timeout = timeoutMs ?? MCP_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
    throw new RangeError("timeoutMs must be an integer from 1 to 600000 milliseconds");
  }
  const deadlineMs = performance.now() + timeout;
  const controller = new AbortController();
  let reason: StopReason | undefined;
  const stop = (why: StopReason) => { if (!reason) { reason = why; controller.abort(new OperationStopped(why)); } };
  const cancelled = () => stop("cancelled");
  requestSignal.addEventListener("abort", cancelled, { once: true });
  if (requestSignal.aborted) cancelled();
  const timer = setTimeout(() => stop("deadline-exceeded"), timeout);
  timer.unref();
  return {
    signal: controller.signal, deadlineMs,
    stopReason: () => reason ?? (performance.now() >= deadlineMs ? "deadline-exceeded" : undefined),
    close: () => { clearTimeout(timer); requestSignal.removeEventListener("abort", cancelled); },
  };
}

export function assertOperationActive(operation = currentOperation()): void {
  if (!operation) return;
  const reason = operation.stopReason();
  if (reason) throw new OperationStopped(reason);
}

export interface ChildOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export interface ChildOptions extends Omit<SpawnOptionsWithoutStdio, "timeout" | "signal" | "detached"> {
  input?: string;
  maxBuffer?: number;
  /** Optional bound for CLI paths; an MCP child always inherits the earlier operation deadline. */
  timeoutMs?: number;
  operation?: OperationContext;
}

/**
 * A new POSIX process group lets escalation reach descendants even when the
 * direct child exits first. Do not settle cancellation until group cleanup has
 * completed; a child's `close` alone does not prove grandchildren exited.
 */
export async function runChild(command: string, args: readonly string[], options: ChildOptions = {}): Promise<ChildOutcome> {
  const operation = options.operation ?? currentOperation();
  assertOperationActive(operation);
  const { input, maxBuffer = MCP_CHILD_MAX_BYTES, timeoutMs, operation: _operation, ...spawnOptions } = options;
  const remaining = operation ? Math.max(1, Math.ceil(operation.deadlineMs - performance.now())) : undefined;
  const budget = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining ?? timeoutMs);
  let child;
  try {
    child = spawn(command, [...args], { ...spawnOptions, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], shell: false });
  } catch (error) {
    if (operation?.stopReason()) throw new OperationStopped(operation.stopReason()!);
    return { status: null, stdout: "", stderr: "", error: error as Error };
  }
  const pid = child.pid;
  let stdout = "";
  let stderr = "";
  let size = 0;
  let error: Error | undefined;
  let stopped: StopReason | undefined;
  let settled = false;
  let grace: NodeJS.Timeout | undefined;
  let forceWait: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let groupGone = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!pid) return;
    try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") groupGone = true; }
  };
  const groupAlive = () => {
    if (!pid || process.platform === "win32") return false;
    try { process.kill(-pid, 0); return true; }
    catch { return false; }
  };
  const stop = (reason: StopReason) => {
    if (stopped || settled) return;
    stopped = reason;
    signalGroup("SIGTERM");
    grace = setTimeout(() => signalGroup("SIGKILL"), MCP_CLEANUP_GRACE_MS);
  };
  const aborted = () => stop(operation?.stopReason() ?? "cancelled");
  operation?.signal.addEventListener("abort", aborted, { once: true });
  if (operation?.signal.aborted) aborted();
  if (budget !== undefined) timeout = setTimeout(() => stop(operation?.stopReason() ?? "deadline-exceeded"), budget);
  const append = (which: "stdout" | "stderr", chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBuffer) { error = new Error(`Subprocess output exceeded ${maxBuffer} bytes`); stop("cancelled"); return; }
    if (which === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.on("error", (err) => { error = err; });
  if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  return await new Promise<ChildOutcome>((resolve, reject) => {
    child.once("close", (status) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (grace) clearTimeout(grace);
        if (forceWait) clearTimeout(forceWait);
        operation?.signal.removeEventListener("abort", aborted);
        if (stopped || operation?.stopReason()) reject(new OperationStopped(operation?.stopReason() ?? stopped!));
        else resolve({ status, stdout, stderr, error });
      };
      // The leader may exit on TERM while a descendant ignores it. Keep the
      // escalation timer alive and inspect the process group after the grace.
      if (!stopped || groupGone || !groupAlive()) { finish(); return; }
      const delay = Math.max(0, MCP_CLEANUP_GRACE_MS - 1);
      forceWait = setTimeout(() => {
        signalGroup("SIGKILL");
        forceWait = setTimeout(finish, MCP_FORCE_WAIT_MS);
      }, delay);
    });
  });
}
