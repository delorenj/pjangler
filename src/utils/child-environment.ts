/**
 * Interpreter and dynamic-loader controls inherited from the MCP host can
 * execute caller-selected code before a trusted child reaches its own entry
 * point. Child authority (provider/channel credentials) is deliberately left
 * intact; callers apply their separate consent policy before or after this
 * environment-only hardening boundary.
 */
const SUBPROCESS_INJECTION_KEYS = new Set<string>([
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "BASH_ENV",
  "ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "BASH_COMPAT",
  "BASH_LOADABLES_PATH",
  "BASH_XTRACEFD",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "NODE_OPTIONS",
  "NODE_PATH",
  "GLIBC_TUNABLES",
]);

// GNU ld.so owns these names. Keep this list aligned with the loader's
// documented environment surface instead of deleting every LD_* variable:
// application keys such as LD_SDK_KEY are unrelated and remain functional.
// Multilib launchers also commonly consume _32/_64 variants, so normalize that
// ABI suffix before matching the loader-owned stem.
const GNU_DYNAMIC_LOADER_CONTROL_KEYS = new Set([
  "LD_ASSUME_KERNEL",
  "LD_AUDIT",
  "LD_BIND_NOT",
  "LD_BIND_NOW",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_DYNAMIC_WEAK",
  "LD_HWCAP_MASK",
  "LD_LIBRARY_PATH",
  "LD_ORIGIN_PATH",
  "LD_POINTER_GUARD",
  "LD_PREFER_MAP_32BIT_EXEC",
  "LD_PRELOAD",
  "LD_PROFILE",
  "LD_PROFILE_OUTPUT",
  "LD_SHOW_AUXV",
  "LD_TRACE_LOADED_OBJECTS",
  "LD_TRACE_PRELINKING",
  "LD_USE_LOAD_BIAS",
  "LD_VERBOSE",
  "LD_WARN",
]);

function isSubprocessInjectionKey(key: string): boolean {
  if (SUBPROCESS_INJECTION_KEYS.has(key)) return true;

  // Bash serializes every exported function under this namespace. The
  // function name is attacker-controlled, so this must be a family match.
  if (key.startsWith("BASH_FUNC_")) return true;

  // Apple's dynamic loader reserves the DYLD_* namespace for loader control.
  if (key.startsWith("DYLD_")) return true;

  const abiNeutralKey = key.replace(/_(?:32|64)$/, "");
  return GNU_DYNAMIC_LOADER_CONTROL_KEYS.has(abiNeutralKey);
}

export function hardenSubprocessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ...overrides };
  for (const key of Object.keys(env)) {
    if (isSubprocessInjectionKey(key)) delete env[key];
  }
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONSAFEPATH = "1";
  return env;
}
