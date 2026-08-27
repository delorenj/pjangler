import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const temp = mkdtempSync(join(tmpdir(), "pjan-86-hermes-deploy-"));

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

try {
  const fakeBin = join(temp, "bin");
  const copierSentinel = join(temp, "copier-ran");
  mkdirSync(fakeBin, { recursive: true });
  const fakeCopier = join(fakeBin, "copier");
  writeFileSync(fakeCopier, `#!/usr/bin/env sh\n: > "${copierSentinel}"\nexit 91\n`);
  chmodSync(fakeCopier, 0o755);
  const commandEnv = {
    HOME: join(temp, "home"),
    XDG_CONFIG_HOME: join(temp, "xdg"),
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    COLUMNS: "0",
    PJANGLER_HERMES_TEMPLATE: "",
  };

  // Command-level dry-run: a zero-width terminal must still get readable,
  // mode-aware output and absolutely no repo/host mutation.
  const previewRepo = join(temp, "preview-repo");
  mkdirSync(previewRepo, { recursive: true });
  const preview = run(["hermes-agent", "--yes", "--dry-run"], previewRepo, commandEnv);
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewOutput = `${preview.stdout}\n${preview.stderr}`;
  assert.match(previewOutput, /Hermes deployment plan \(no changes applied\)/);
  assert.match(previewOutput, /runtime: local role runtime/);
  assert.match(previewOutput, /dry-run made no repository or host changes/);
  assert.doesNotMatch(previewOutput, /Provisioned|\bDone\.|runtime:\s*gh:/);
  assert.equal(existsSync(join(previewRepo, "agents")), false, "dry-run must not render a role");
  assert.equal(existsSync(join(temp, "xdg", "hermes-agent-template", "config.toml")), false, "dry-run must not create host config");
  assert.equal(existsSync(copierSentinel), false, "dry-run must not execute Copier");

  // --email has no pinned template interface and must fail before even config
  // bootstrap or Copier discovery/execution.
  const emailRepo = join(temp, "email-repo");
  mkdirSync(emailRepo, { recursive: true });
  const emailConfig = join(temp, "email-xdg");
  const email = run(["hermes-agent", "--yes", "--email"], emailRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: emailConfig,
  });
  assert.notEqual(email.status, 0);
  assert.match(`${email.stdout}\n${email.stderr}`, /pinned Hermes template has no supported email provisioner/);
  assert.equal(existsSync(join(emailRepo, "agents")), false, "unsupported email must fail before repo mutation");
  assert.equal(existsSync(emailConfig), false, "unsupported email must fail before host config mutation");
  assert.equal(existsSync(copierSentinel), false, "unsupported email must fail before Copier");

  // --yes means defaults, not implicit destructive overwrite consent.
  const existingRepo = join(temp, "existing-repo");
  const existingRole = join(existingRepo, "agents", "hermes", "pm", "role.yaml");
  mkdirSync(join(existingRepo, "agents", "hermes", "pm"), { recursive: true });
  const preciousRole = "repo: existing-repo\nrole: pm\nagent_id: existing-repo-pm\n# precious\n";
  writeFileSync(existingRole, preciousRole);
  const existingConfig = join(temp, "existing-xdg");
  const overwrite = run(["hermes-agent", "--yes"], existingRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: existingConfig,
  });
  assert.notEqual(overwrite.status, 0);
  assert.match(`${overwrite.stdout}\n${overwrite.stderr}`, /non-interactive mode will not overwrite it.*--force/s);
  assert.equal(readFileSync(existingRole, "utf8"), preciousRole);
  assert.equal(existsSync(existingConfig), false, "overwrite refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "overwrite refusal must precede Copier");

  // Forced config bootstrap is an additive schema upgrade. Operator values,
  // comments, unknown keys, and richer sections survive byte-for-byte.
  const configRepo = join(temp, "config-repo");
  const configHome = join(temp, "config-xdg");
  const configPath = join(configHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(configHome, "hermes-agent-template"), { recursive: true });
  mkdirSync(configRepo, { recursive: true });
  writeFileSync(configPath, `# precious operator comment\n[fleet]\nhermes_bin = "/operator/hermes"\ncustom_key = "keep"\n\n[operator]\nmode = "richer"\n`);
  const config = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: configHome,
  });
  assert.equal(config.status, 0, `${config.stdout}\n${config.stderr}`);
  const upgraded = readFileSync(configPath, "utf8");
  assert.match(upgraded, /# precious operator comment/);
  assert.match(upgraded, /hermes_bin = "\/operator\/hermes"/);
  assert.equal((upgraded.match(/^hermes_bin\s*=/gm) ?? []).length, 1, "existing schema values must not be duplicated");
  assert.match(upgraded, /custom_key = "keep"/);
  assert.match(upgraded, /\[operator\]\nmode = "richer"/);
  for (const key of ["pjangler_bin", "hermes_git_url", "hermes_git_ref", "hermes_git_sha", "oauth_file", "codex_home", "vox_plugin_name", "vox_plugin_dir", "vox_voice", "vox_url", "onepassword_vault", "onepassword_item_prefix"]) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `config upgrade should add ${key}`);
  }
  const templateConfig = readFileSync(join(root, "templates", "hermes-agent", "template", ".scripts", "config.example.toml"), "utf8");
  for (const [, key] of templateConfig.matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `parent bootstrap must cover pinned template key ${key}`);
  }
  assert.doesNotMatch(upgraded, /^pm_external_skill_dirs\s*=|^\[bloodbank\]/m, "retired config schema must not be reintroduced");

  // systemd parity evaluates the heartbeat and gateway leaves independently:
  // an active heartbeat plus explicitly deferred gateway is healthy only while
  // the gateway is actually disabled and inactive.
  const parityRepo = join(temp, "parity-repo");
  const parityHome = join(temp, "parity-home");
  const parityRole = join(parityRepo, "agents", "hermes", "pm");
  const systemdDir = join(parityHome, ".config", "systemd", "user");
  mkdirSync(parityRole, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  writeFileSync(join(parityRole, "role.yaml"), `repo: parity-repo\nrole: pm\nagent_id: parity-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: active\n`);
  for (const unit of ["hermes-parity-repo-pm-gateway.service", "hermes-parity-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(systemdDir, unit), "[Unit]\nDescription=fixture\n");
  }
  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, `#!/usr/bin/env sh
command_name="\${2:-}"
unit="\${3:-}"
case "$command_name" in
  is-system-running) exit 0 ;;
  is-enabled|is-active)
    case "$unit" in
      *gateway*) [ "\${PJAN86_GATEWAY_ACTIVE:-}" = "1" ] && exit 0 || exit 1 ;;
      *heartbeat*) exit 0 ;;
    esac
    ;;
esac
exit 0
`);
  chmodSync(fakeSystemctl, 0o755);
  const deferredAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
  });
  const deferredFinding = JSON.parse(deferredAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(deferredFinding.status, "pass", JSON.stringify(deferredFinding));
  const unsafeAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_GATEWAY_ACTIVE: "1",
  });
  const unsafeFinding = JSON.parse(unsafeAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(unsafeFinding.status, "fail");
  assert.match(unsafeFinding.details.join("\n"), /deferred and should be disabled\+inactive/);

  // Source-level orchestration tripwires complement the process tests: summary
  // is final-only and explicit --force is the sole overwrite path.
  const recipe = readFileSync(join(root, "src", "recipes", "HermesAgentRecipe.ts"), "utf8");
  const copier = readFileSync(join(root, "src", "commands", "hermes", "RunCopierTemplate.ts"), "utf8");
  const summary = readFileSync(join(root, "src", "commands", "hermes", "PrintHermesSummary.ts"), "utf8");
  const ingredients = recipe.match(/const ingredients = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.doesNotMatch(ingredients, /PrintHermesSummary/, "summary must not run before lifecycle postconditions");
  assert.ok(recipe.indexOf("ValidateHermesOptions") < recipe.indexOf("EnsureTemplateConfig", recipe.indexOf("const ingredients")));
  assert.match(copier, /if \(ctx\.force\) args\.push\("--overwrite"\)/);
  assert.match(copier, /if \(ctx\.yes \|\| ctx\.quiet\) args\.push\("--defaults"\)/);
  assert.doesNotMatch(copier, /ctx\.yes\)\s*\{\s*ctx\.force\s*=\s*true/);
  assert.doesNotMatch(summary, /@clack\/prompts|Provisioned|\bDone\.|runtime\s+gh:/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("PJAN-86 Hermes deploy regressions: PASS");
