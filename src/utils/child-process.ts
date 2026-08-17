import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
} from "node:child_process";
import { hardenSubprocessEnvironment } from "./child-environment";

/**
 * The sole production boundary for creating child processes.
 *
 * MCP handlers enter an already-running Node process, so ambient interpreter,
 * shell, Node, and dynamic-loader hooks must be removed again for every child.
 * Call-specific environments remain authoritative: functional overrides and
 * explicitly granted provider/channel credentials survive the hardening pass.
 * Ordinary executable PATH is intentionally preserved.
 *
 * Only APIs used by production are exposed. The PJAN-67 source gate rejects
 * direct child_process imports elsewhere; a future exec/execFile use must add
 * an equivalent wrapper here rather than silently inheriting process.env.
 */
function hardenedOptions<T extends { env?: NodeJS.ProcessEnv }>(options: T | undefined): T & { env: NodeJS.ProcessEnv } {
  const supplied = options ?? ({} as T);
  return {
    ...supplied,
    env: hardenSubprocessEnvironment(supplied.env ?? process.env),
  };
}

export const spawnSync: typeof nodeSpawnSync = ((
  command: string,
  argsOrOptions?: readonly string[] | SpawnSyncOptions,
  maybeOptions?: SpawnSyncOptions,
) => {
  if (Array.isArray(argsOrOptions)) {
    return nodeSpawnSync(command, argsOrOptions, hardenedOptions(maybeOptions));
  }
  return nodeSpawnSync(command, hardenedOptions(argsOrOptions as SpawnSyncOptions | undefined));
}) as typeof nodeSpawnSync;

export const spawn: typeof nodeSpawn = ((
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  maybeOptions?: SpawnOptions,
) => {
  if (Array.isArray(argsOrOptions)) {
    return nodeSpawn(command, argsOrOptions, hardenedOptions(maybeOptions));
  }
  return nodeSpawn(command, hardenedOptions(argsOrOptions as SpawnOptions | undefined));
}) as typeof nodeSpawn;
