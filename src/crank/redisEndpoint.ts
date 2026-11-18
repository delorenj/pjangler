// Where crank's Redis lives, with NO imports.
//
// Split out of ./index so the shell prompt (dist/prompt.js, which must boot near node's floor)
// reads the same host/port the CrankStore does without pulling in the crank CLI. ./index
// re-exports everything here, so callers keep importing from "./crank/index".

export const ZCRANK_REDIS_HOST = "127.0.0.1";
export const ZCRANK_REDIS_PORT = 6379;

/**
 * Where Redis lives: the defaults, unless ZCRANK_REDIS_HOST / ZCRANK_REDIS_PORT say
 * otherwise (zcrank.py honours the same two variables, so tests can aim both sides at a
 * throwaway redis-server instead of the live engine's). Read per call, not at import.
 */
export function redisEndpoint(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const port = Number.parseInt(env.ZCRANK_REDIS_PORT ?? "", 10);
  return {
    host: env.ZCRANK_REDIS_HOST?.trim() || ZCRANK_REDIS_HOST,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : ZCRANK_REDIS_PORT,
  };
}
