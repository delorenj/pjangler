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
const EXPECTED_HERMES_GITLINK = "b35150d0be0be6d7b5e6d5d6c2347c8ff5123a50";

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function committedHermesTemplate(path) {
  const tree = spawnSync("git", ["ls-tree", "HEAD", "templates/hermes-agent"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const match = tree.stdout.match(/^160000 commit ([0-9a-f]{40})\ttemplates\/hermes-agent\s*$/);
  assert.ok(match, `HEAD must commit an exact Hermes template gitlink, got: ${tree.stdout}`);
  const gitlink = match[1];
  assert.equal(
    gitlink,
    EXPECTED_HERMES_GITLINK,
    "PJAN-86 must test the final reviewed Hermes template commit, never an advanced mutable worktree",
  );
  const show = spawnSync("git", ["-C", join(root, "templates", "hermes-agent"), "show", `${gitlink}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(show.status, 0, `committed Hermes gitlink ${gitlink} cannot provide ${path}: ${show.stderr}`);
  return { gitlink, content: show.stdout };
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

  // Any meaningful partial render is existing user state. --yes must refuse it
  // before config bootstrap or Copier, even when role.yaml does not exist yet.
  const partialRepo = join(temp, "partial-repo");
  const partialRoleDir = join(partialRepo, "agents", "hermes", "pm");
  const partialSoul = join(partialRoleDir, "SOUL.md");
  mkdirSync(partialRoleDir, { recursive: true });
  writeFileSync(partialSoul, "precious partial soul\n");
  const partialConfig = join(temp, "partial-xdg");
  const partial = run(["hermes-agent", "--yes"], partialRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: partialConfig,
  });
  assert.notEqual(partial.status, 0);
  assert.match(`${partial.stdout}\n${partial.stderr}`, /target directory is not empty.*SOUL\.md.*--force/s);
  assert.equal(readFileSync(partialSoul, "utf8"), "precious partial soul\n");
  assert.equal(existsSync(partialConfig), false, "partial-role refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "partial-role refusal must precede Copier");

  // Empty directory structure and inert placeholder/OS metadata are the only
  // harmless existing entries. Ignored runtime state remains a blocker.
  const placeholderRepo = join(temp, "placeholder-repo");
  const placeholderRole = join(placeholderRepo, "agents", "hermes", "pm");
  mkdirSync(join(placeholderRole, "empty-child"), { recursive: true });
  writeFileSync(join(placeholderRole, ".gitkeep"), "");
  writeFileSync(join(placeholderRole, ".DS_Store"), "metadata");
  const placeholder = run(["hermes-agent", "--yes", "--dry-run"], placeholderRepo, commandEnv);
  assert.equal(placeholder.status, 0, `${placeholder.stdout}\n${placeholder.stderr}`);
  const runtimeRepo = join(temp, "runtime-only-repo");
  const runtimeState = join(runtimeRepo, "agents", "hermes", "pm", "runtime", "checkpoint.json");
  mkdirSync(join(runtimeRepo, "agents", "hermes", "pm", "runtime"), { recursive: true });
  writeFileSync(runtimeState, "{}\n");
  const runtimeOnly = run(["hermes-agent", "--yes", "--dry-run"], runtimeRepo, commandEnv);
  assert.notEqual(runtimeOnly.status, 0);
  assert.match(`${runtimeOnly.stdout}\n${runtimeOnly.stderr}`, /runtime\/checkpoint\.json/);

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
  assert.match(`${overwrite.stdout}\n${overwrite.stderr}`, /non-interactive mode will not render into it.*--force/s);
  assert.equal(readFileSync(existingRole, "utf8"), preciousRole);
  assert.equal(existsSync(existingConfig), false, "overwrite refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "overwrite refusal must precede Copier");

  // Standalone bootstrap reports successful plans and changes to process
  // callers; silence here previously made a real write look like a no-op.
  const bootstrapRepo = join(temp, "bootstrap-repo");
  const bootstrapHome = join(temp, "bootstrap-xdg");
  const bootstrapPath = join(bootstrapHome, "hermes-agent-template", "config.toml");
  mkdirSync(bootstrapRepo, { recursive: true });
  const bootstrapPlan = run(["config", "bootstrap", "--dry-run"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrapPlan.status, 0, bootstrapPlan.stderr);
  assert.match(bootstrapPlan.stdout, /\[DRY RUN\] Would create config:/);
  assert.equal(existsSync(bootstrapPath), false);
  const bootstrap = run(["config", "bootstrap"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /Bootstrapped config without replacing existing values:/);
  assert.equal(existsSync(bootstrapPath), true);

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
  assert.match(config.stdout, /Updated config without replacing existing values:/);
  const upgraded = readFileSync(configPath, "utf8");
  assert.match(upgraded, /# precious operator comment/);
  assert.match(upgraded, /hermes_bin = "\/operator\/hermes"/);
  assert.equal((upgraded.match(/^hermes_bin\s*=/gm) ?? []).length, 1, "existing schema values must not be duplicated");
  assert.match(upgraded, /custom_key = "keep"/);
  assert.match(upgraded, /\[operator\]\nmode = "richer"/);
  for (const key of ["pjangler_bin", "hermes_git_url", "hermes_git_ref", "hermes_git_sha", "oauth_file", "codex_home", "vox_plugin_name", "vox_plugin_dir", "vox_voice", "vox_url", "onepassword_vault", "onepassword_item_prefix"]) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `config upgrade should add ${key}`);
  }
  const committedTemplate = committedHermesTemplate("template/.scripts/config.example.toml");
  assert.match(committedTemplate.gitlink, /^[0-9a-f]{40}$/);
  const templateConfig = committedTemplate.content;
  for (const [, key] of templateConfig.matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `parent bootstrap must cover pinned template key ${key}`);
  }
  assert.doesNotMatch(
    upgraded,
    /^pm_external_skill_dirs\s*=|^voxxy_plugin_dir\s*=|^\[bloodbank\]/m,
    "retired config schema must not be reintroduced",
  );

  // Final template lifecycle contracts are read from the parent commit's
  // gitlink object, never from templates/hermes-agent's mutable checkout.
  const copierContract = committedHermesTemplate("copier.yml").content;
  const roleContract = committedHermesTemplate("template/role.yaml.jinja").content;
  const telegramContract = committedHermesTemplate("template/.scripts/30-telegram.sh").content;
  const slackContract = committedHermesTemplate("template/.scripts/31-slack.sh").content;
  const libraryContract = committedHermesTemplate("template/.scripts/_lib.sh").content;
  assert.match(copierContract, /reconcile_enabled:\n[\s\S]*?default: true/);
  assert.match(copierContract, /_skip_if_exists:[\s\S]*?\n\s+- role\.yaml/);
  assert.match(roleContract, /telegram:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /slack:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /reconcile:[\s\S]*?explicit_opt_out:/);
  assert.match(roleContract, /bloodbank:\n[\s\S]*?\n\s+enabled: false/);
  assert.match(roleContract, /service_state:\n\s+gateway: "pending"\n\s+heartbeat: "pending"/);
  assert.match(
    telegramContract,
    /if \[\[ "\$\{SKIP_TELEGRAM:-0\}" == "1" \]\]; then[\s\S]*?profile_channel_enabled_set "\$PROFILE_HOME" telegram false[\s\S]*?telegram_yaml_update provisioning_status deferred/,
    "deferred Telegram must write platforms.telegram.enabled=false explicitly",
  );
  assert.match(
    slackContract,
    /if \[\[ "\$\{SKIP_SLACK:-0\}" == "1" \]\]; then[\s\S]*?profile_channel_enabled_set "\$PROFILE_HOME" slack false[\s\S]*?slack_yaml_update provisioning_status deferred/,
    "deferred Slack must write platforms.slack.enabled=false explicitly",
  );
  assert.match(libraryContract, /elif mode == "channel-enabled":[\s\S]*?channel\["enabled"\] = value == "true"/);

  // Inline comments are part of a valid TOML table header. The merge must
  // recognize that exact owner instead of appending a duplicate [fleet].
  const inlineHome = join(temp, "inline-xdg");
  const inlinePath = join(inlineHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(inlineHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(inlinePath, `[fleet] # keep this operator comment\nhermes_bin = "/operator/hermes"\n\n[operator]\nmode = "richer"\n`);
  const inline = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: inlineHome,
  });
  assert.equal(inline.status, 0, `${inline.stdout}\n${inline.stderr}`);
  const inlineMerged = readFileSync(inlinePath, "utf8");
  assert.equal((inlineMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);
  assert.match(inlineMerged, /^\[fleet\] # keep this operator comment$/m);
  assert.equal((inlineMerged.match(/^hermes_bin\s*=/gm) ?? []).length, 1);

  // A normal table owns keys only until the next table header, including an
  // array-table header. Missing [fleet] keys must stay out of [[fleet.plugins]].
  const arrayHome = join(temp, "array-xdg");
  const arrayPath = join(arrayHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(arrayHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(arrayPath, `[fleet] # owner\nhermes_bin = "/operator/hermes"\n\n[[fleet.plugins]] # child array\nname = "operator-plugin"\n\n[operator]\nmode = "richer"\n`);
  const array = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: arrayHome,
  });
  assert.equal(array.status, 0, `${array.stdout}\n${array.stderr}`);
  const arrayMerged = readFileSync(arrayPath, "utf8");
  const fleetStart = arrayMerged.indexOf("[fleet] # owner");
  const pluginStart = arrayMerged.indexOf("[[fleet.plugins]] # child array");
  const operatorStart = arrayMerged.indexOf("[operator]");
  assert.ok(fleetStart !== -1 && fleetStart < pluginStart && pluginStart < operatorStart);
  assert.match(arrayMerged.slice(fleetStart, pluginStart), /^pjangler_bin\s*=/m);
  assert.doesNotMatch(arrayMerged.slice(pluginStart, operatorStart), /^pjangler_bin\s*=/m);
  assert.equal((arrayMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);

  // An array table cannot be silently reinterpreted as the scalar [fleet]
  // owner. Fail closed and preserve the source exactly.
  const incompatibleHome = join(temp, "incompatible-xdg");
  const incompatiblePath = join(incompatibleHome, "hermes-agent-template", "config.toml");
  const incompatibleSource = `[[fleet]] # intentionally incompatible\nname = "entry"\n`;
  mkdirSync(join(incompatibleHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(incompatiblePath, incompatibleSource);
  const incompatible = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: incompatibleHome,
  });
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Cannot merge \[fleet\].*array table/);
  assert.equal(readFileSync(incompatiblePath, "utf8"), incompatibleSource);

  // Stateful systemctl fixture: action exit 0 is not enough; parity must probe
  // the resulting enabled/active leaves before recording durable state.
  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, `#!/usr/bin/env sh
state_dir="\${PJAN86_SYSTEMD_STATE:?}"
mkdir -p "$state_dir"
command_name="\${2:-}"
case "$command_name" in
  is-system-running|daemon-reload) exit 0 ;;
  enable)
    unit="\${4:-}"
    if [ "\${PJAN86_HEARTBEAT_VERIFY_FAIL:-}" = "1" ] && printf '%s' "$unit" | grep -q heartbeat; then
      exit 0
    fi
    : > "$state_dir/$unit.enabled"
    : > "$state_dir/$unit.active"
    exit 0
    ;;
  disable)
    unit="\${4:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" != "1" ]; then
      rm -f -- "$state_dir/$unit.enabled" "$state_dir/$unit.active"
    fi
    exit 0
    ;;
  is-enabled)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.enabled" ] && exit 0 || exit 1
    ;;
  is-active)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.active" ] && exit 0 || exit 1
    ;;
esac
exit 1
`);
  chmodSync(fakeSystemctl, 0o755);

  // systemd parity evaluates heartbeat and gateway independently: an active
  // heartbeat plus deferred gateway is healthy only while the gateway is
  // disabled and inactive.
  const parityRepo = join(temp, "parity-repo");
  const parityHome = join(temp, "parity-home");
  const parityRole = join(parityRepo, "agents", "hermes", "pm");
  const systemdDir = join(parityHome, ".config", "systemd", "user");
  const parityState = join(temp, "parity-systemd-state");
  mkdirSync(parityRole, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  mkdirSync(parityState, { recursive: true });
  writeFileSync(join(parityRole, "role.yaml"), `repo: parity-repo\nrole: pm\nagent_id: parity-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: active\n`);
  const parityGateway = "hermes-parity-repo-pm-gateway.service";
  const parityHeartbeat = "hermes-parity-repo-pm-heartbeat.timer";
  for (const unit of [parityGateway, parityHeartbeat]) {
    writeFileSync(join(systemdDir, unit), "[Unit]\nDescription=fixture\n");
  }
  writeFileSync(join(parityState, `${parityHeartbeat}.enabled`), "");
  writeFileSync(join(parityState, `${parityHeartbeat}.active`), "");
  for (const probe of ["is-enabled", "is-active"]) {
    const fixtureProbe = spawnSync(fakeSystemctl, ["--user", probe, parityHeartbeat], {
      encoding: "utf8",
      env: { ...process.env, PJAN86_SYSTEMD_STATE: parityState },
    });
    assert.equal(fixtureProbe.status, 0, `systemctl fixture ${probe} failed: ${fixtureProbe.stderr}`);
  }
  const deferredAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
  });
  const deferredFinding = JSON.parse(deferredAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(deferredFinding.status, "pass", JSON.stringify(deferredFinding));
  const unsafeAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  const unsafeFinding = JSON.parse(unsafeAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(unsafeFinding.status, "fail");
  assert.match(unsafeFinding.details.join("\n"), /deferred and should be disabled\+inactive/);

  // installed -> active becomes durable only after enable + active probes.
  // The deferred gateway remains deferred, and the immediate post-audit passes.
  const migrateRepo = join(temp, "migrate-repo");
  const migrateHome = join(temp, "migrate-home");
  const migrateRole = join(migrateRepo, "agents", "hermes", "pm");
  const migrateSystemd = join(migrateHome, ".config", "systemd", "user");
  const migrateState = join(temp, "migrate-systemd-state");
  const migrateRolePath = join(migrateRole, "role.yaml");
  mkdirSync(migrateRole, { recursive: true });
  mkdirSync(migrateSystemd, { recursive: true });
  mkdirSync(migrateState, { recursive: true });
  const migrateRoleSource = `# preserve role comment\nrepo: migrate-repo\nrole: pm\nagent_id: migrate-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(migrateRolePath, migrateRoleSource);
  for (const unit of ["hermes-migrate-repo-pm-gateway.service", "hermes-migrate-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(migrateSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const migrated = run(["migrate", "systemd.sentinel", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  const migratedReport = JSON.parse(migrated.stdout);
  const migratedResult = migratedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(migratedResult.status, "applied", JSON.stringify(migratedResult));
  assert.ok(migratedResult.changedFiles.includes(migrateRolePath));
  const migratedRole = readFileSync(migrateRolePath, "utf8");
  assert.match(migratedRole, /^# preserve role comment$/m);
  assert.match(migratedRole, /service_state:\n\s+gateway: deferred\n\s+heartbeat: active/);
  const migratedAudit = run(["audit", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  const migratedFinding = JSON.parse(migratedAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(migratedFinding.status, "pass", JSON.stringify(migratedFinding));

  // A successful disable command followed by a still-active deferred gateway
  // is a failed postcondition. role.yaml must remain byte-identical.
  const failureRepo = join(temp, "failure-repo");
  const failureHome = join(temp, "failure-home");
  const failureRole = join(failureRepo, "agents", "hermes", "pm");
  const failureSystemd = join(failureHome, ".config", "systemd", "user");
  const failureState = join(temp, "failure-systemd-state");
  const failureRolePath = join(failureRole, "role.yaml");
  mkdirSync(failureRole, { recursive: true });
  mkdirSync(failureSystemd, { recursive: true });
  mkdirSync(failureState, { recursive: true });
  const failureRoleSource = `repo: failure-repo\nrole: pm\nagent_id: failure-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(failureRolePath, failureRoleSource);
  for (const unit of ["hermes-failure-repo-pm-gateway.service", "hermes-failure-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(failureSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const failedMigration = run(["migrate", "systemd.sentinel", failureRepo, "--json"], failureRepo, {
    ...commandEnv,
    HOME: failureHome,
    PJAN86_SYSTEMD_STATE: failureState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  assert.notEqual(failedMigration.status, 0);
  const failedReport = JSON.parse(failedMigration.stdout);
  const failedResult = failedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(failedResult.status, "blocked", JSON.stringify(failedResult));
  assert.match(failedResult.details.join("\n"), /did not become disabled\+inactive/);
  assert.equal(readFileSync(failureRolePath, "utf8"), failureRoleSource);

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
