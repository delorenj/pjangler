// Regression guard for the Hermes profile base+delta contract.
//
// Two audits used to disagree with reality in ways that failed SILENTLY, and
// both are cheap to re-break:
//
//   1. hermes.runtime-singleton once REQUIRED profiles/<p>/config.yaml to be a
//      symlink to the fleet base. That symlink detaches on the first in-agent
//      write (Hermes' atomic_yaml_write uses os.replace, which swaps a symlink
//      for a regular file), freezing the profile on a stale base forever — and
//      it left the profile unable to override anything. config.yaml is now a
//      GENERATED artifact and the symlink is a FAILURE, not the contract.
//
//   2. Fleet-base defects hit every agent at once and never surface as errors:
//      tts.provider "voxxy" (the service name; the registry key is "vox") falls
//      back to a built-in voice; a missing hooks: block silences Bloodbank
//      lifecycle events fleet-wide; "memory" in agent.disabled_toolsets muzzles
//      memory tools while auto recall/retain keeps running and masks it.
//
// These assert the audit REPORTS those states — a rule that only ever passes
// is indistinguishable from a rule that does nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const tmpRoots = [];

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// Minimal repo carrying one Hermes PM role — enough for discoverRoles().
function makeRepo() {
  const repo = tmp("pjangler-inherit-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  const roleDir = join(repo, "agents", "hermes", "pm");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  writeFileSync(join(repo, "AGENTS.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return { repo, roleDir };
}

const BASE_CONFIG = {
  tts: { provider: "vox", vox: { voice: "carlin" } },
  hooks: {
    on_session_start: [{ command: "python3 /home/x/.agents/hooks/bloodbank/publish.py --client hermes --hook on_session_start", timeout: 5 }],
    on_session_end: [{ command: "python3 /home/x/.agents/hooks/bloodbank/publish.py --client hermes --hook on_session_end", timeout: 5 }],
    pre_tool_call: [{ command: "python3 /home/x/.agents/hooks/bloodbank/publish.py --client hermes --hook pre_tool_call", timeout: 5 }],
    post_tool_call: [{ command: "python3 /home/x/.agents/hooks/bloodbank/publish.py --client hermes --hook post_tool_call", timeout: 5 }],
  },
  memory: { provider: "hindsight" },
  agent: { disabled_toolsets: [] },
  skills: { external_dirs: ["/home/x/.agents/skills"] },
};

function yamlDump(obj) {
  // Deliberately tiny: only what these fixtures need, so the test has no
  // dependency on the YAML lib's formatting.
  return JSON.stringify(obj, null, 2);
}

// Build a fleet home. `overrides` mutates the base config; `profileMode`
// selects the profile-side topology under test.
function makeFleet({ overrides = {}, profileMode = "rendered", profile = "demo-pm" } = {}) {
  const fleet = tmp("pjangler-inherit-fleet-");
  const cfg = { ...BASE_CONFIG, ...overrides };
  writeFileSync(join(fleet, "config.yaml"), yamlDump(cfg));
  writeFileSync(join(fleet, ".env"), "");
  mkdirSync(join(fleet, "skills"), { recursive: true });
  const pdir = join(fleet, "profiles", profile);
  mkdirSync(pdir, { recursive: true });
  symlinkSync(join(fleet, ".env"), join(pdir, ".env"));
  symlinkSync(join(fleet, "skills"), join(pdir, "skills"));

  if (profileMode === "symlinked") {
    // The retired topology.
    symlinkSync(join(fleet, "config.yaml"), join(pdir, "config.yaml"));
  } else if (profileMode === "forked") {
    // A hand-forked copy: real file, but no generated header.
    writeFileSync(join(pdir, "config.yaml"), yamlDump(cfg));
    writeFileSync(join(pdir, "config.delta.yaml"), "{}\n");
  } else {
    writeFileSync(
      join(pdir, "config.yaml"),
      `# GENERATED FILE -- DO NOT EDIT.\n# source of truth : config.delta.yaml\n${yamlDump(cfg)}`,
    );
    writeFileSync(join(pdir, "config.delta.yaml"), "{}\n");
    mkdirSync(join(pdir, "hindsight"), { recursive: true });
    writeFileSync(join(pdir, "hindsight", "config.json"), JSON.stringify({ bank_id: `agent-${profile}` }, null, 2));
  }
  return fleet;
}

function audit(repo, fleet) {
  const r = spawnSync("node", [cli, "audit"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HERMES_FLEET_HOME: fleet },
  });
  // Audit exits non-zero when findings exist; stdout is the payload either way.
  return (r.stdout || "") + (r.stderr || "");
}

const { repo } = makeRepo();

// 1. A symlinked config.yaml is a FAILURE, not the contract.
{
  const out = audit(repo, makeFleet({ profileMode: "symlinked" }));
  assert.match(out, /config\.yaml is a symlink/, "symlinked profile config must be reported");
  assert.match(out, /config\.delta\.yaml missing/, "missing delta must be reported");
  assert.match(out, /identity-memory bank not pinned/, "unpinned identity bank must be reported");
}

// 2. A hand-forked real config (no generated header) must not pass as rendered.
{
  const out = audit(repo, makeFleet({ profileMode: "forked" }));
  assert.match(out, /not a rendered artifact/, "hand-forked config must be distinguished from a rendered one");
}

// 3. A correctly rendered profile satisfies the per-profile contract.
{
  const out = audit(repo, makeFleet({ profileMode: "rendered" }));
  assert.doesNotMatch(out, /config\.yaml is a symlink/, "rendered profile must not be flagged as symlinked");
  assert.doesNotMatch(out, /config\.delta\.yaml missing/, "rendered profile has a delta");
  assert.doesNotMatch(out, /identity-memory bank not pinned/, "rendered profile pins its bank");
}

// 4. Fleet-base defects are each reported, with the reason they stay silent.
{
  const out = audit(repo, makeFleet({ overrides: { tts: { provider: "voxxy" } } }));
  assert.match(out, /tts\.provider is "voxxy"/, "voxxy must be rejected in favor of the vox registry key");
}
{
  // null, not a delete: makeFleet spreads BASE_CONFIG first, so an absent key in
  // `overrides` cannot remove one. A null hooks: block is also the shape a
  // half-written config actually takes on disk.
  const out = audit(repo, makeFleet({ overrides: { hooks: null } }));
  assert.match(out, /no hooks: block in the fleet base/, "a missing hooks block must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { agent: { disabled_toolsets: ["memory"] } } }));
  assert.match(out, /disabled_toolsets contains "memory"/, "a muzzled memory toolset must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { skills: { external_dirs: [] } } }));
  assert.match(out, /skills\.external_dirs is empty/, "an empty skills path must be reported");
}

// 5. A healthy fleet base reports none of the above — guards against a rule
//    that "passes" by matching everything.
{
  const out = audit(repo, makeFleet({}));
  for (const pattern of [/tts\.provider is/, /no hooks: block/, /disabled_toolsets contains/, /external_dirs is empty/]) {
    assert.doesNotMatch(out, pattern, `healthy fleet base must not trip ${pattern}`);
  }
}

for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
console.log("hermes profile inheritance regressions passed");
