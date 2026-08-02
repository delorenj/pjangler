import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");

function run(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-${name}-`));
  return repo;
}

function makeExecutable(path) {
  chmodSync(path, 0o755);
}

function writeProject(repo, overrides = {}) {
  const project = {
    name: "heyma-regression",
    agents: {
      "heyma-pm": {
        role: "pm",
        role_dir: "agents/hermes/pm",
      },
    },
    ticket_provider: {
      type: "plane",
      workspace: "heyma",
      identifier: "HEY",
      board_id: "123e4567-e89b-12d3-a456-426614174000",
    },
    ...overrides,
  };
  writeFileSync(join(repo, ".project.json"), JSON.stringify(project, null, 2));
}

function writeRoleYaml(repo, { agentId = "heyma-pm", role = "pm", planeBinding = true, dirRole = role } = {}) {
  const dir = join(repo, "agents", "hermes", dirRole);
  mkdirSync(dir, { recursive: true });
  const tpBlock = planeBinding
    ? `ticket_provider:\n  name: plane\n  workspace: heyma\n  board_id: 123e4567-e89b-12d3-a456-426614174000\n`
    : "";
  writeFileSync(
    join(dir, "role.yaml"),
    `agent_id: ${agentId}\nrole: ${role}\ndisplay_name: HeyMa PM\nrepo: heyma\npurpose: regression\nprofile: ${agentId}\ntelegram:\n  bot_username: "@heymapm"\n${tpBlock}`
  );
}

function writeProvider(repo, role = "pm") {
  const dir = join(repo, "agents", "hermes", role);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "momo");
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "\${1:-}" == "--help" ]]; then\n  echo "Momo provider dispatcher"\n  exit 0\nfi\nif [[ "\${1:-}" == "--smoke" && "\${2:-}" == "nested" ]]; then\n  echo "nested smoke OK"\n  exit 0\nfi\necho "unknown command: \$1" >&2\nexit 1\n`
  );
  makeExecutable(path);
}

function writeLifecycleScripts(repo) {
  const dir = join(repo, ".scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lifecycle-plan.sh"), "#!/usr/bin/env bash\necho plan\n");
  makeExecutable(join(dir, "lifecycle-plan.sh"));
}

function writeSentinelScripts(repo, role = "pm") {
  const dir = join(repo, "agents", "hermes", role, ".scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat.sh"), "#!/usr/bin/env bash\necho heartbeat\n");
  makeExecutable(join(dir, "heartbeat.sh"));
}

function parseAudit(args, repo) {
  const { status, stdout, stderr } = runAllowFailure([...args, repo, "--json"]);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`failed to parse JSON output for: node ${cli} ${args.join(" ")} ${repo}\nstatus: ${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { status, report, stdout, stderr };
}

function findFinding(report, section) {
  return report.findings.find((f) => f.section === section);
}

const repos = [];
try {
  // --------------------------------------------------------------------------
  // HeyMa failure reproduction: missing role_dir, missing role.yaml,
  // mismatched agent_id/role, and missing provider dispatcher.
  // --------------------------------------------------------------------------
  {
    const repo = makeRepo("momo-heyma-failure");
    repos.push(repo);

    writeProject(repo, {
      agents: {
        "heyma-pm": { role: "pm", role_dir: "agents/hermes/pm" },
        "heyma-dev": { role: "dev", role_dir: "agents/hermes/dev-missing" },
        "heyma-qa": { role: "qa" },
      },
    });

    // pm role exists but its role.yaml has mismatched agent_id and role
    writeRoleYaml(repo, { agentId: "wrong-pm", role: "pm" });
    // dev role_dir points to a directory that does not exist (missing role_dir)
    // qa role_dir is missing entirely
    // No executable provider dispatcher is created.
    // No lifecycle or sentinel scripts.

    const { status, report } = parseAudit(["audit", "--profile", "momo-lifecycle-plane"], repo);

    assert.equal(report.profile, "momo-lifecycle-plane", "profile must be reported");
    assert.equal(report.ready, false, "HeyMa regression repo must not be ready");
    assert.equal(status, 1, "CLI must exit non-zero when not ready");

    const manifest = findFinding(report, "manifest-role-consistency");
    assert.ok(manifest, "manifest-role-consistency finding must exist");
    assert.equal(manifest.status, "fail");
    const manifestDetails = manifest.details.join("\n");
    assert.match(manifestDetails, /agents\.heyma-dev\.role_dir does not exist/, "missing role_dir must be reported");
    assert.match(manifestDetails, /agents\.heyma-qa\.role_dir missing/, "absent role_dir must be reported");
    assert.match(manifestDetails, /heyma-pm.*agent_id mismatch/, "agent_id mismatch must be reported");
    assert.doesNotMatch(manifestDetails, /role.yaml missing/, "existing role.yaml must not be reported as missing");

    // Role yaml missing case (separate fixture below) verifies that detail.

    const executableProvider = findFinding(report, "executable-provider");
    assert.equal(executableProvider.status, "fail", "missing provider dispatcher must fail");
    assert.match(executableProvider.summary, /missing/);

    // Live sections must be skipped without --live.
    assert.equal(findFinding(report, "plane-state-mapping").status, "skip", "plane-state-mapping must be skipped without --live");
    assert.equal(findFinding(report, "nested-adapter-smoke").status, "skip", "nested-adapter-smoke must be skipped without --live");

    // Migration recipe must be report-only and not perform credential-bearing changes.
    const migrate = JSON.parse(run(["migrate", "momo-lifecycle-plane", repo, "--json"]));
    assert.equal(migrate.results[0].status, "skipped", "migration must be skipped/report-only");
    assert.equal(migrate.results[0].changedFiles.length, 0, "migration must not change files");
    assert.match(migrate.results[0].summary, /report-only/);
  }

  // --------------------------------------------------------------------------
  // Missing role.yaml specifically
  // --------------------------------------------------------------------------
  {
    const repo = makeRepo("momo-missing-role-yaml");
    repos.push(repo);
    writeProject(repo, { agents: { "heyma-pm": { role: "pm", role_dir: "agents/hermes/pm" } } });
    mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
    // No role.yaml created
    const { report } = parseAudit(["audit", "--profile", "momo-lifecycle-plane"], repo);
    const manifest = findFinding(report, "manifest-role-consistency");
    assert.match(manifest.details.join("\n"), /role.yaml missing/);
  }

  // --------------------------------------------------------------------------
  // Role mismatch specifically
  // --------------------------------------------------------------------------
  {
    const repo = makeRepo("momo-role-mismatch");
    repos.push(repo);
    writeProject(repo, { agents: { "heyma-pm": { role: "pm", role_dir: "agents/hermes/pm" } } });
    writeRoleYaml(repo, { agentId: "heyma-pm", role: "architect", dirRole: "pm" });
    const { report } = parseAudit(["audit", "--profile", "momo-lifecycle-plane"], repo);
    const manifest = findFinding(report, "manifest-role-consistency");
    assert.match(manifest.details.join("\n"), /role mismatch/);
  }

  // --------------------------------------------------------------------------
  // Live sections are attempted when --live is passed
  // --------------------------------------------------------------------------
  {
    const repo = makeRepo("momo-live-attempted");
    repos.push(repo);
    writeProject(repo);
    writeRoleYaml(repo);
    writeProvider(repo);
    writeLifecycleScripts(repo);
    writeSentinelScripts(repo);

    // Without --live the live sections are skipped; the static pieces are
    // enough for the non-live readiness calculation.
    const dry = parseAudit(["audit", "--profile", "momo-lifecycle-plane"], repo);
    assert.equal(findFinding(dry.report, "plane-state-mapping").status, "skip");
    assert.equal(findFinding(dry.report, "nested-adapter-smoke").status, "skip");
    assert.equal(dry.report.ready, true, "non-live checks pass when live sections are skipped");

    // With --live they are attempted (warn because no real credentials/Plane board).
    const live = parseAudit(["audit", "--profile", "momo-lifecycle-plane", "--live"], repo);
    assert.notEqual(findFinding(live.report, "plane-state-mapping").status, "skip", "plane-state-mapping must be attempted with --live");
    assert.notEqual(findFinding(live.report, "nested-adapter-smoke").status, "skip", "nested-adapter-smoke must be attempted with --live");
    assert.equal(live.report.live, true, "report.live must be true");
  }

  // --------------------------------------------------------------------------
  // Fully passing fixture (sanity check)
  // --------------------------------------------------------------------------
  {
    const repo = makeRepo("momo-ready");
    repos.push(repo);
    writeProject(repo);
    writeRoleYaml(repo);
    writeProvider(repo);
    writeLifecycleScripts(repo);
    writeSentinelScripts(repo);

    const { status, report } = parseAudit(["audit", "--profile", "momo-lifecycle-plane"], repo);
    assert.equal(report.ready, true, "fully configured repo must be ready");
    assert.equal(status, 0, "CLI must exit zero when ready");
    for (const finding of report.findings) {
      assert.ok(finding.status === "pass" || finding.status === "skip", `${finding.section} must pass or skip`);
    }
    assert.equal(report.profile, "momo-lifecycle-plane");
    assert.equal(typeof report.auditedAt, "string");
  }

  console.log("  Momo lifecycle-plane regression tests passed");
} finally {
  for (const repo of repos) {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
