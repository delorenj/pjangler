import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";

export interface LifecycleEligibilityResult {
  ok: boolean;
  error?: string;
}

export interface TrustedCopierResult extends LifecycleEligibilityResult {
  executable?: string;
  realExecutable?: string;
  layout?: string;
}

export interface TrustedCopierOptions {
  targetDir: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  temporaryDir?: string;
  systemRoots?: readonly string[];
}

export interface RenderedHermesEligibilityOptions {
  pjanglerRoot: string;
  targetDir: string;
  roleDir: string;
  targetRepo: string;
  role: string;
  agentId: string;
}

const DEFAULT_SYSTEM_ROOTS = [
  "/usr/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/Cellar",
  "/opt/pipx/venvs/copier",
  "/opt/uv/tools/copier",
] as const;

function containedBy(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function firstExecutableOnPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const rawEntry of (env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry || process.cwd();
    const candidate = resolve(entry, process.platform === "win32" ? "copier.exe" : "copier");
    try {
      accessSync(candidate, constants.X_OK);
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // Continue to the next PATH entry. Resolution itself must never execute a
      // candidate, because a shadowed program is exactly what this gate rejects.
    }
  }
  return undefined;
}

function userLayout(path: string, home: string): string | undefined {
  const normalized = resolve(path);
  const exactRoots = [
    join(home, ".local", "bin"),
  ];
  if (exactRoots.some((root) => dirname(normalized) === resolve(root))) return "pip-user";

  const nestedLayouts: Array<[string, string]> = [
    [join(home, ".local", "share", "uv", "tools", "copier"), "uv-tool"],
    [join(home, ".local", "pipx", "venvs", "copier"), "pipx"],
    [join(home, ".local", "share", "pipx", "venvs", "copier"), "pipx"],
    [join(home, "Library", "Application Support", "uv", "tools", "copier"), "uv-tool"],
    [join(home, "Library", "Application Support", "pipx", "venvs", "copier"), "pipx"],
  ];
  for (const [root, layout] of nestedLayouts) {
    if (containedBy(root, normalized)) return layout;
  }

  const pyenvRoot = join(home, ".pyenv", "versions");
  if (containedBy(pyenvRoot, normalized) && dirname(normalized).endsWith("/bin")) return "pyenv-version";
  return undefined;
}

function systemLayout(path: string, roots: readonly string[]): string | undefined {
  const normalized = resolve(path);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (dirname(normalized) === resolvedRoot || containedBy(resolvedRoot, normalized)) return "system";
  }
  return undefined;
}

function consoleScriptContract(path: string): LifecycleEligibilityResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8").slice(0, 32 * 1024);
  } catch (error) {
    return { ok: false, error: `cannot read Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return { ok: false, error: "Copier launcher has no executable shebang" };
  const shebang = firstLine.slice(2).trim().split(/\s+/);
  const interpreter = basename(shebang[0] ?? "");
  const pythonInterpreter = /^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)
    || (interpreter === "env" && /^python(?:\d+(?:\.\d+)*)?$/.test(shebang.at(-1) ?? ""));
  if (!pythonInterpreter) return { ok: false, error: "Copier launcher is not a Python console script" };
  if (!/from\s+copier\.__main__\s+import\s+CopierApp/.test(text) || !/CopierApp\.run\s*\(/.test(text)) {
    return { ok: false, error: "Copier launcher does not match the Copier 9 console-script contract" };
  }
  return { ok: true };
}

/**
 * Resolve and attest Copier without executing it.
 *
 * MCP apply paths accept the first PATH match only when both the entry point
 * and its real target live in a supported package-manager/system layout and
 * the target is a Copier 9 Python console script. A target-local, temporary, or
 * earlier shadow executable fails closed; we never skip it and silently run a
 * later binary. Supported layouts are pip --user, uv tool, pipx, a concrete
 * pyenv version, and conventional Unix/Homebrew/MacPorts system prefixes.
 */
export function preflightTrustedCopier(options: TrustedCopierOptions): TrustedCopierResult {
  const env = options.env ?? process.env;
  const home = resolve(options.homeDir ?? homedir());
  const temporary = resolve(options.temporaryDir ?? tmpdir());
  const target = resolve(options.targetDir);
  const systemRoots = options.systemRoots ?? DEFAULT_SYSTEM_ROOTS;
  const candidate = firstExecutableOnPath(env);
  if (!candidate) return { ok: false, error: "copier not found on PATH" };

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: `cannot resolve Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }

  for (const [label, root] of [["target", target], ["temporary", temporary]] as const) {
    if (containedBy(root, candidate) || containedBy(root, realCandidate)) {
      return { ok: false, error: `refusing ${label}-local Copier executable: ${candidate}` };
    }
  }

  const candidateLayout = userLayout(candidate, home) ?? systemLayout(candidate, systemRoots);
  const realLayout = userLayout(realCandidate, home) ?? systemLayout(realCandidate, systemRoots);
  if (!candidateLayout || !realLayout) {
    return {
      ok: false,
      error: `refusing untrusted PATH-shadowed Copier executable: ${candidate}`,
    };
  }

  const launcher = consoleScriptContract(realCandidate);
  if (!launcher.ok) return { ...launcher, executable: candidate, realExecutable: realCandidate };
  return {
    ok: true,
    executable: candidate,
    realExecutable: realCandidate,
    layout: realLayout === "system" ? candidateLayout : realLayout,
  };
}

function regularContainedFile(root: string, path: string, label: string): LifecycleEligibilityResult {
  try {
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(path);
    if (!containedBy(rootReal, fileReal)) return { ok: false, error: `${label} escapes its vendored template root` };
    if (!lstatSync(path).isFile()) return { ok: false, error: `${label} is not a regular file` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseCopierConfig(templateRoot: string, label: string): { result: LifecycleEligibilityResult; config?: Record<string, unknown> } {
  const configPath = join(templateRoot, "copier.yml");
  const file = regularContainedFile(templateRoot, configPath, `${label} copier.yml`);
  if (!file.ok) return { result: file };
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: { ok: false, error: `${label} copier.yml must contain a mapping` } };
    }
    const config = parsed as Record<string, unknown>;
    if (config._subdirectory !== "template") {
      return { result: { ok: false, error: `${label} copier.yml must render the template subdirectory` } };
    }
    if (!/^9(?:\.|$)/.test(String(config._min_copier_version ?? ""))) {
      return { result: { ok: false, error: `${label} requires an unsupported Copier contract` } };
    }
    return { result: { ok: true }, config };
  } catch (error) {
    return { result: { ok: false, error: `${label} copier.yml is invalid: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

function requireFiles(templateRoot: string, files: readonly string[], label: string): LifecycleEligibilityResult {
  for (const rel of files) {
    const result = regularContainedFile(templateRoot, join(templateRoot, rel), `${label} ${rel}`);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function preflightCommonProjectTemplate(pjanglerRoot: string): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "commonproject");
  const parsed = parseCopierConfig(templateRoot, "CommonProject template");
  if (!parsed.result.ok) return parsed.result;
  const files = requireFiles(templateRoot, [
    "template/.project.json.jinja",
    "template/.copier-answers.yml.jinja",
    "template/.env.op",
    "template/AGENTS.md.jinja",
    "template/mise.toml.jinja",
  ], "CommonProject template");
  if (!files.ok) return files;
  const projectJson = readFileSync(join(templateRoot, "template", ".project.json.jinja"), "utf8");
  for (const key of ["project_name", "project_slug", "repo_path", "ticket_provider", "agents"]) {
    if (!projectJson.includes(`\"${key}\"`)) return { ok: false, error: `CommonProject projection is missing ${key}` };
  }
  return { ok: true };
}

export function preflightHermesTemplate(pjanglerRoot: string, env: NodeJS.ProcessEnv = process.env): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "hermes-agent");
  const explicit = env.PJANGLER_HERMES_TEMPLATE?.trim();
  if (explicit) {
    try {
      if (realpathSync(resolve(explicit)) !== realpathSync(templateRoot)) {
        return { ok: false, error: "MCP Hermes apply requires the version-locked vendored template" };
      }
    } catch (error) {
      return { ok: false, error: `Hermes template override is unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const parsed = parseCopierConfig(templateRoot, "Hermes template");
  if (!parsed.result.ok) return parsed.result;
  const required = requireFiles(templateRoot, [
    "template/role.yaml.jinja",
    "template/SOUL.md.jinja",
    "template/hermes.jinja",
    "template/.scripts/_lib.sh",
    "template/.scripts/01-config.sh",
    "template/.scripts/05-fleet-env.sh",
    "template/.scripts/10-hermes-profile.sh",
    "template/.scripts/20-runtime-repo.sh",
    "template/.scripts/42-ticket-provider.sh",
    "template/.scripts/70-systemd.sh",
    "template/.scripts/80-registry.sh",
  ], "Hermes template");
  if (!required.ok) return required;

  const role = readFileSync(join(templateRoot, "template", "role.yaml.jinja"), "utf8");
  if (!/^bloodbank:\s*$[\s\S]*?^\s+enabled:\s+(?:true|false)\s*$/m.test(role)) {
    return { ok: false, error: "Hermes role projection must declare bloodbank.enabled as a strict boolean" };
  }
  const library = readFileSync(join(templateRoot, "template", ".scripts", "_lib.sh"), "utf8");
  if (!library.includes("PJANGLER_PROJECT_ROOT") || !library.includes('"$explicit"/agents/hermes/*')) {
    return { ok: false, error: "Hermes project-root resolver must honor the explicitly contained MCP target" };
  }
  const skipPlane = readFileSync(join(templateRoot, "template", ".scripts", "42-ticket-provider.sh"), "utf8");
  const guard = skipPlane.indexOf('if [[ "${SKIP_PLANE:-0}" == "1" ]]');
  const firstSource = skipPlane.search(/^source\s/m);
  if (guard < 0 || firstSource < 0 || guard > firstSource) {
    return { ok: false, error: "Hermes ticket-provider skip guard must precede all sourced provider/config logic" };
  }
  for (const script of ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "80-registry.sh"]) {
    const text = readFileSync(join(templateRoot, "template", ".scripts", script), "utf8");
    const hostGuard = text.indexOf('if [[ "${SKIP_HOST_STATE:-0}" == "1" ]]');
    const source = text.search(/^source\s/m);
    if (hostGuard < 0 || source < 0 || hostGuard > source) {
      return { ok: false, error: `Hermes ${script} host-state guard must precede all sourced config/fleet logic` };
    }
  }
  const tasks = Array.isArray(parsed.config?._tasks) ? parsed.config._tasks.map(String) : [];
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    if (!tasks.some((task) => task.includes(script))) return { ok: false, error: `Hermes copier task list is missing ${script}` };
  }
  return { ok: true };
}

/**
 * Validate the trusted Copier projection before any host-global script runs.
 *
 * The executable and version-locked template were attested before Copier was
 * launched. This second, read-only gate proves that the rendered identity,
 * strict lifecycle metadata, local project registration, and every script we
 * may execute in the host/external tails are exactly the expected projection.
 */
export function preflightRenderedHermes(options: RenderedHermesEligibilityOptions): LifecycleEligibilityResult {
  const target = resolve(options.targetDir);
  const roleDir = resolve(options.roleDir);
  if (!containedBy(target, roleDir)) return { ok: false, error: "rendered Hermes role escapes its project target" };
  try {
    const stat = lstatSync(roleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "rendered Hermes role must be a real directory" };
    }
  } catch (error) {
    return { ok: false, error: `rendered Hermes role is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const templateScripts = join(resolve(options.pjanglerRoot), "templates", "hermes-agent", "template", ".scripts");
  const renderedScripts = join(roleDir, ".scripts");
  const requiredFiles = [
    "role.yaml",
    "SOUL.md",
    "hermes",
    ".gitignore",
    ".runtime-scaffold/README.md",
    ...["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]
      .map((script) => `.scripts/${script}`),
  ];
  const required = requireFiles(roleDir, requiredFiles, "rendered Hermes role");
  if (!required.ok) return required;

  for (const script of ["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    try {
      if (readFileSync(join(renderedScripts, script), "utf8") !== readFileSync(join(templateScripts, script), "utf8")) {
        return { ok: false, error: `rendered Hermes script differs from the attested template: ${script}` };
      }
    } catch (error) {
      return { ok: false, error: `cannot attest rendered Hermes script ${script}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  let role: Record<string, unknown>;
  try {
    const parsed = YAML.parse(readFileSync(join(roleDir, "role.yaml"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "rendered Hermes role.yaml must contain a mapping" };
    }
    role = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: `rendered Hermes role.yaml is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.repo !== options.targetRepo || role.role !== options.role || role.agent_id !== options.agentId) {
    return { ok: false, error: "rendered Hermes role identity does not match the requested repo/role/agent" };
  }
  const bloodbank = role.bloodbank as Record<string, unknown> | undefined;
  if (!bloodbank || typeof bloodbank.enabled !== "boolean") {
    return { ok: false, error: "rendered Hermes bloodbank.enabled must be a strict boolean" };
  }
  const deployment = role.deployment as Record<string, unknown> | undefined;
  if (!deployment || deployment.local_only !== true || deployment.systemd !== "deferred") {
    return { ok: false, error: "rendered Hermes deployment must remain local-only/deferred until external grants run" };
  }

  const manifestPath = join(target, ".project.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const agents = manifest.agents as Record<string, Record<string, unknown>> | undefined;
      const declared = agents?.[options.agentId];
      if (!declared
        || declared.role !== options.role
        || declared.role_dir !== relative(target, roleDir)
        || declared.provisioning_state !== "provisioned") {
        return { ok: false, error: "rendered Hermes role is not canonically registered in .project.json" };
      }
    } catch (error) {
      return { ok: false, error: `cannot validate rendered Hermes project registration: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}

export function preflightMcpLifecycle(options: {
  pjanglerRoot: string;
  targetDir: string;
  commonProject: boolean;
  hermes: boolean;
  env?: NodeJS.ProcessEnv;
}): TrustedCopierResult {
  const copier = preflightTrustedCopier({ targetDir: options.targetDir, env: options.env });
  if (!copier.ok) return copier;
  if (options.commonProject) {
    const common = preflightCommonProjectTemplate(options.pjanglerRoot);
    if (!common.ok) return { ...common, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  if (options.hermes) {
    const hermes = preflightHermesTemplate(options.pjanglerRoot, options.env);
    if (!hermes.ok) return { ...hermes, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  return copier;
}
