/**
 * Interpreter and dynamic-loader controls inherited from the MCP host can
 * execute caller-selected code before a trusted child reaches its own entry
 * point. Child authority (provider/channel credentials) is deliberately left
 * intact; callers apply their separate consent policy before or after this
 * environment-only hardening boundary.
 */
const SUBPROCESS_INJECTION_KEYS = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
] as const;

export function hardenSubprocessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ...overrides };
  for (const key of SUBPROCESS_INJECTION_KEYS) delete env[key];
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONSAFEPATH = "1";
  return env;
}
