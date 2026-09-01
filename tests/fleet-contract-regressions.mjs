// PJAN Epic 1 / Story 1.1: the fleet authority and managed-state contract.
//
// The defect class this suite exists for is not "validate has a bug". It is
// that every later fleet observation would otherwise invent its own answer to
// "who owns this field", and that a machine-readable fleet answer that looks
// right on a terminal can still be truncated the moment CI captures it.
//
// So the bar here is deliberately awkward:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess over
//     real OS pipes. `pjangler audit --json` already proved that a command can
//     print a complete document to a TTY and a truncated one to a pipe, because
//     the process exited before stdout drained. A suite that called the
//     validator in-process would have re-certified that defect.
//   * Every invalid case is produced by MUTATING A COPY OF THE REAL TRACKED
//     CONTRACT at runtime, never by hand-authoring a parallel fixture. A
//     hand-written "invalid contract" drifts away from the real one the first
//     time the real one changes, and then it tests a file nobody ships.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content, so an empty capture fails loudly instead of passing
//     every `assert.match` vacuously.
//   * Every invocation, including the failing ones, is bracketed by a
//     content+mtime snapshot of an isolated scratch HOME. "Read-only" is a
//     claim about the filesystem, so it is checked against the filesystem.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "fleet-contract.yaml");
const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

const temp = mkdtempSync(join(tmpdir(), "fleet-contract-"));
const scratchHome = join(temp, "home");
let failures = 0;

/**
 * How the CLI is required to render a path it read.
 *
 * TMPDIR is not portable: on this developer box it sits under the real home,
 * on a clean runner it is `/tmp`. The command redacts a home prefix to `~`
 * regardless of an overridden `$HOME`, so the expected string has to be
 * computed the same way instead of assumed to be the raw path.
 */
const PASSWD_HOME = (() => { try { return userInfo().homedir; } catch { return ""; } })();
const shown = (path) => (PASSWD_HOME && path.startsWith(`${PASSWD_HOME}/`) ? `~${path.slice(PASSWD_HOME.length)}` : path);

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

/**
 * A scratch HOME the command has no business touching.
 *
 * Every store the fleet contract NAMES is pointed inside it, so a validator
 * that quietly resolved a registry -- or wrote a cache, a lock, or a repaired
 * copy -- would leave a trace the snapshot catches. Git discovery is ceilinged
 * and host git config dropped for the same reason it is in the hermes deploy
 * suite: without that, whatever checkout happens to contain TMPDIR answers for
 * the fixture.
 */
function seedHome() {
  mkdirSync(join(scratchHome, ".hermes", "profiles", "example"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(scratchHome, ".hermes", "agents-registry.yaml"), "schema_version: 1\nagents: {}\n");
  writeFileSync(join(scratchHome, ".config", "pjangler", "projects.yaml"), "schema_version: 1\nprojects: {}\n");
  writeFileSync(join(scratchHome, ".hermes", "profiles", "example", "config.yaml"), "memory: {}\n");
}

const isolation = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, ".config"),
  XDG_DATA_HOME: join(scratchHome, ".local", "share"),
  XDG_STATE_HOME: join(scratchHome, ".local", "state"),
  XDG_CACHE_HOME: join(scratchHome, ".cache"),
  HERMES_FLEET_HOME: join(scratchHome, ".hermes"),
  HERMES_AGENTS_REGISTRY: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(scratchHome, ".hermes", "agents-registry.yaml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  NO_COLOR: "1",
};

/** Content hash + mtime for every file under a tree, keyed by relative path. */
function snapshot(root) {
  const entries = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const stat = statSync(path);
      entries[relative(root, path)] = `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return entries;
}

/**
 * Run the built CLI and prove the run wrote nothing to the scratch HOME.
 *
 * `maxBuffer` is set explicitly: the default would itself truncate a large
 * capture, and a truncation introduced by the harness looks exactly like the
 * truncation defect the harness is here to detect.
 */
function cli(args) {
  const before = snapshot(scratchHome);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: temp,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...isolation },
  });
  const after = snapshot(scratchHome);
  assert.deepEqual(after, before, `pj ${args.join(" ")} wrote to the isolated HOME`);
  return result;
}

/** Machine output, asserted to exist before it is asserted to say anything. */
function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
  assert.ok(result.stdout.trim().length > 0, "stdout was blank");
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout is not one complete JSON document (${result.stdout.length} bytes): ${error.message}`); }
  assert.equal(parsed.schema_version, 1, "envelope schema_version");
  assert.equal(typeof parsed.command, "string");
  return parsed;
}

/** Derive an invalid contract by mutating a copy of the real tracked one. */
function mutated(name, mutate) {
  const document = YAML.parseDocument(TRACKED_TEXT);
  mutate(document);
  const path = join(temp, `${name}.yaml`);
  writeFileSync(path, String(document), "utf8");
  return path;
}

function rawCopy(name, text) {
  const path = join(temp, `${name}.yaml`);
  writeFileSync(path, text, "utf8");
  return path;
}

console.log("fleet contract authority + managed-state contract");
try {
  seedHome();

  // -- the tracked contract, through the real built CLI ---------------------

  check("canonical validate exits 0 and names every declared surface", () => {
    const result = cli(["fleet", "contract", "validate"]);
    assert.notEqual(result.stdout, "", "human report must not be empty");
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const out = result.stdout;
    assert.match(out, /Fleet contract valid/);
    assert.match(out, /schema 1/, "report must name the effective schema version");
    assert.match(out, /contract 1\.\d+\.\d+/, "report must name the contract version");
    for (const owner of ["project-registry", "hermes-agent-registry", "hermes-profile-renderer", "hermes-agent-template", "hermes-fleet-provisioner", "fleet-observer"]) {
      assert.ok(out.includes(owner), `report must name authority owner ${owner}`);
    }
    for (const klass of ["managed_agent", "managed_shared_service", "intentionally_unmanaged", "retired", "unclassified"]) {
      assert.ok(out.includes(klass), `report must name lifecycle class ${klass}`);
    }
    assert.ok(out.includes("hermes-{agent_id}-gateway.service"), "report must name the per-agent gateway unit");
    assert.ok(out.includes("hermes-{agent_id}-heartbeat.timer"), "report must name the per-agent heartbeat timer");
    assert.ok(out.includes("hermes-fleet-bloodbank-gateway.service"), "report must name the fleet-shared gateway");
    for (const mode of ["per-agent-bloodbank-consumer", "per-agent-checkpoint-timer", "n8n-owned-truth", "activation-by-discovery", "hard-coded-hermes-checkout-path"]) {
      assert.ok(out.includes(mode), `report must name superseded mode ${mode}`);
    }
  });

  check("human report never prints an absolute path under $HOME", () => {
    const result = cli(["fleet", "contract", "validate"]);
    for (const home of new Set([homedir(), PASSWD_HOME].filter(Boolean))) {
      assert.ok(!result.stdout.includes(home), `report leaked the home directory ${home}`);
    }
    assert.ok(result.stdout.includes("contracts/fleet-contract.yaml"), "report must still name the contract it validated");
  });

  check("--json is one complete envelope through a real pipe", () => {
    const result = cli(["fleet", "contract", "validate", "--json"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.error, null);
    assert.notEqual(parsed.data, null, "data must be populated on success");
    assert.ok(parsed.data.authorities.length >= 7, "envelope must carry every authority");
    assert.ok(parsed.data.projections.length >= 6, "envelope must carry every projection");
    assert.equal(parsed.data.classifications.length, 5, "envelope must carry five lifecycle classes");
    assert.ok(parsed.data.retired.length >= 5, "envelope must carry every retired mode");
    assert.equal(parsed.data.byte_stable, true, "tracked contract must round-trip byte-stably");
    // The pipe-truncation defect this epic exists to stop only shows above the
    // OS pipe buffer, so the payload has to actually be that large.
    assert.ok(result.stdout.length > 8192, `envelope is only ${result.stdout.length} bytes; too small to exercise pipe capture`);
  });

  check("the tracked contract re-serializes byte-identically", () => {
    assert.equal(String(YAML.parseDocument(TRACKED_TEXT)), TRACKED_TEXT, "tracked contract is not its own canonical serialization");
  });

  check("--contract validates the named file and reports the resolved path", () => {
    const copy = rawCopy("verbatim-copy", TRACKED_TEXT);
    const result = cli(["fleet", "contract", "validate", "--contract", copy]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.includes(shown(copy)), "report must name the overridden contract path");
  });

  // -- authority split, declared not inferred --------------------------------

  check("Project Registry owns identity; Hermes Agent Registry owns operations", () => {
    const parsed = envelope(cli(["fleet", "contract", "validate", "--json"]));
    const byOwner = new Map();
    for (const authority of parsed.data.authorities) {
      for (const field of authority.writable_fields) byOwner.set(field, authority.owner);
    }
    assert.equal(byOwner.get("projects.{slug}.repo_path"), "project-registry");
    assert.equal(byOwner.get("projects.{slug}.ticket_provider.identifier"), "project-registry");
    assert.equal(byOwner.get("projects.{slug}.ticket_provider.board_id"), "project-registry");
    assert.equal(byOwner.get("agents.{agent_id}.role_dir"), "hermes-agent-registry");
    assert.equal(byOwner.get("agents.{agent_id}.profile_name"), "hermes-agent-registry");
    assert.equal(byOwner.get("gateways.bloodbank.systemd_unit"), "hermes-agent-registry");
  });

  check("every overlap projection declares one direction and one writer", () => {
    const parsed = envelope(cli(["fleet", "contract", "validate", "--json"]));
    const overlaps = [
      ["projects.{slug}.repo_path", "agents.{agent_id}.project_path"],
      ["projects.{slug}.slug", "agents.{agent_id}.repo"],
      ["projects.{slug}.ticket_provider.identifier", "agents.{agent_id}.plane.identifier"],
      ["projects.{slug}.ticket_provider.board_id", "agents.{agent_id}.plane.project_id"],
      ["projects.{slug}.ticket_provider.workspace", "agents.{agent_id}.plane.workspace"],
      ["agents.{agent_id}.role_dir", "projects.{slug}.agents.{role}.role_dir"],
    ];
    for (const [source, target] of overlaps) {
      const matches = parsed.data.projections.filter((item) => item.source === source && item.target === target);
      assert.equal(matches.length, 1, `${source} -> ${target} must be declared exactly once`);
      assert.match(matches[0].direction, /_to_/, "direction must name a source and a target");
      assert.equal(typeof matches[0].writable_by, "string");
      assert.ok(matches[0].writable_by.length > 0, "writable_by must name one owner");
    }
    // The one write that actually happens today: Plane -> project registry ->
    // hermes registry. Recording the wrong writer here would authorize the
    // hermes side to start writing board identity back.
    const identifier = parsed.data.projections.find((item) => item.target === "agents.{agent_id}.plane.identifier");
    assert.equal(identifier.writable_by, "project-registry");
  });

  check("a field claimed by two owners fails and names both, choosing neither", () => {
    const path = mutated("dual-owner", (document) => {
      const fields = document.getIn(["authorities", "agent_operational_records", "writable_fields"]);
      fields.add("projects.{slug}.ticket_provider.identifier");
    });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTHORITY_CONFLICT");
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}`);
    const rendered = JSON.stringify(parsed.error);
    assert.ok(rendered.includes("projects.{slug}.ticket_provider.identifier"), "must name the conflicting field path");
    assert.ok(rendered.includes("hermes-agent-registry"), "must name the first claimant");
    assert.ok(rendered.includes("project-registry"), "must name the second claimant");
    const human = cli(["fleet", "contract", "validate", "--contract", path]);
    assert.equal(human.status, 4);
    assert.match(human.stdout, /AUTHORITY_CONFLICT/);
  });

  // -- classification completeness ------------------------------------------

  check("every non-managed_agent class demands identity, provenance, and policy", () => {
    const parsed = envelope(cli(["fleet", "contract", "validate", "--json"]));
    const required = ["id", "kind", "owner", "source", "lifecycle_state", "rationale", "policy_domains"];
    for (const classification of parsed.data.classifications) {
      if (classification.id === "managed_agent") continue;
      for (const field of required) {
        assert.ok(classification.required_fields.includes(field), `${classification.id} must require ${field}`);
      }
    }
  });

  check("a managed_shared_service entry missing a required key is rejected", () => {
    for (const key of ["owner", "source", "rationale"]) {
      const path = mutated(`classification-missing-${key}`, (document) => {
        document.deleteIn(["classifications", "managed_shared_service", "entries", 0, key]);
      });
      const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(parsed.ok, false, `missing ${key} must fail`);
      assert.equal(parsed.error.code, "INVALID_CLASSIFICATION");
      assert.equal(result.status, 4, `expected exit 4 for missing ${key}, got ${result.status}`);
      const rendered = JSON.stringify(parsed.error);
      assert.ok(rendered.includes(key), `diagnostic must name the missing key ${key}`);
      assert.ok(rendered.includes("fleet-bloodbank-gateway"), "diagnostic must name the entry");
      assert.ok(rendered.includes("classifications.managed_shared_service.entries[0]"), "diagnostic must carry the dotted field path");
    }
  });

  // -- retired modes are never an alternate healthy mode ---------------------

  check("declaring a per-agent Bloodbank consumer healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-consumer", (document) => {
      document.setIn(["service_model", "per_agent", "consumer_unit"], "hermes-{agent_id}-consumer.service");
    });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "RETIRED_MODE");
    assert.equal(result.status, 4);
    assert.ok(JSON.stringify(parsed.error).includes("per-agent-bloodbank-consumer"));
  });

  check("declaring a per-agent checkpoint timer healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-checkpoint", (document) => {
      document.setIn(["service_model", "per_agent", "checkpoint_timer"], "hermes-{agent_id}-checkpoint.timer");
    });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    assert.equal(envelope(result).error.code, "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("declaring n8n-owned truth healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-n8n", (document) => {
      document.setIn(["service_model", "fleet_shared", "orchestrator"], "n8n");
    });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    assert.equal(envelope(result).error.code, "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("a hard-coded Hermes checkout path fails as RETIRED_MODE", () => {
    const path = mutated("retired-checkout", (document) => {
      document.setIn(["service_model", "profile_layout", "root"], "$HOME/code/hermes-agent/profiles/{profile_name}");
    });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    assert.equal(envelope(result).error.code, "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("activation-by-discovery fails: default-allow and non-strict both", () => {
    for (const [key, value] of [["default", "allow"], ["strict", false]]) {
      const path = mutated(`retired-activation-${key}`, (document) => {
        document.setIn(["activation", "execution_authority", key], value);
      });
      const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(parsed.error.code, "RETIRED_MODE", `execution_authority.${key} = ${value} must be rejected`);
      assert.equal(result.status, 4);
      assert.ok(JSON.stringify(parsed.error).includes("activation-by-discovery"));
    }
  });

  // -- activation is its own authority ---------------------------------------

  check("five distinct states, one strict default-deny execution field", () => {
    const parsed = envelope(cli(["fleet", "contract", "validate", "--json"]));
    assert.deepEqual(parsed.data.activation.states, ["discovered", "installed", "healthy", "routing_ready", "activated"]);
    const authority = parsed.data.activation.execution_authority;
    assert.equal(authority.field, "agents.{agent_id}.bloodbank.enabled");
    assert.equal(authority.owner, "hermes-agent-registry");
    assert.equal(authority.strict, true);
    assert.equal(authority.default, "deny");
    // The gate is only real if its owner is the declared writer of the field.
    const owning = parsed.data.authorities.filter((item) => item.writable_fields.includes(authority.field));
    assert.equal(owning.length, 1, "exactly one authority may write the activation flag");
    assert.equal(owning[0].owner, "hermes-agent-registry");
  });

  check("routing metadata is discovery, held apart from execution authority", () => {
    const parsed = envelope(cli(["fleet", "contract", "validate", "--json"]));
    const discovery = parsed.data.authorities.find((item) => item.writable_fields.includes("agents.{agent_id}.bloodbank.gateway_scope"));
    const execution = parsed.data.authorities.find((item) => item.writable_fields.includes("agents.{agent_id}.bloodbank.enabled"));
    assert.ok(discovery && execution, "both surfaces must be declared");
    assert.notEqual(discovery.id, execution.id, "discovery and execution must be separate authorities");
    assert.ok(!discovery.writable_fields.includes("agents.{agent_id}.bloodbank.enabled"), "the discovery authority must not be able to grant dispatch");
  });

  // -- malformed, missing, and forward-incompatible inputs -------------------

  check("a truncated contract fails as INVALID_INPUT with a line and column", () => {
    const cut = TRACKED_TEXT.indexOf("\nprojections:");
    assert.ok(cut > 0, "fixture assumption: the tracked contract declares projections");
    const path = rawCopy("truncated", `${TRACKED_TEXT.slice(0, cut)}\nprojections: [\n`);
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "INVALID_INPUT");
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
    assert.match(parsed.error.message, /line \d+ column \d+/, "diagnostic must carry a line and column");
    assert.ok(!/\n\s+at /.test(JSON.stringify(parsed)), "no stack frames may reach the envelope");
  });

  check("a missing required block fails as INVALID_INPUT naming the block", () => {
    const path = mutated("no-authorities", (document) => { document.delete("authorities"); });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.ok(parsed.error.message.startsWith("authorities:"), `diagnostic must be pathed at authorities: ${parsed.error.message}`);
  });

  check("a missing contract file fails as NOT_FOUND naming the path, no stack", () => {
    const missing = join(temp, "nope.yaml");
    const result = cli(["fleet", "contract", "validate", "--contract", missing, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "NOT_FOUND");
    assert.equal(result.status, 3, `expected exit 3, got ${result.status}`);
    assert.equal(parsed.error.details.contract_path, shown(missing));
    assert.ok(!JSON.stringify(parsed).includes("ENOENT"), "raw runtime error text must not reach the envelope");
    const human = cli(["fleet", "contract", "validate", "--contract", missing]);
    assert.equal(human.status, 3);
    assert.ok(human.stdout.includes(shown(missing)), "human report must name the path");
    assert.ok(!/\n\s+at /.test(human.stdout + human.stderr), "no stack trace may be printed");
  });

  check("a forward schema version fails as UNSUPPORTED_SCHEMA_VERSION stating the range", () => {
    const path = mutated("future-schema", (document) => { document.set("schema_version", 99); });
    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "UNSUPPORTED_SCHEMA_VERSION");
    assert.equal(result.status, 5, `expected exit 5, got ${result.status}`);
    assert.match(parsed.error.message, /supported range 1\.\.1/, "diagnostic must state the supported range");
    assert.equal(parsed.error.details.diagnostic_count, 1, "a version this build cannot read must not be partially applied");
  });

  // -- namespaced extensions --------------------------------------------------

  check("x- extensions round-trip verbatim and stay out of policy", () => {
    const withExtensions = YAML.parseDocument(TRACKED_TEXT);
    withExtensions.setIn(["x-delonet/root-note"], "root level extension");
    withExtensions.setIn(["authorities", "project_identity", "x-delonet/nested-note"], "nested extension");
    const text = String(withExtensions);
    const path = rawCopy("extensions", text);

    // The serializer is the round trip: what the CLI reports must survive it.
    assert.equal(String(YAML.parseDocument(text)), text, "extension-bearing contract must be byte-stable");

    const result = cli(["fleet", "contract", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `extensions must not invalidate a contract: ${JSON.stringify(parsed.error)}`);
    assert.equal(result.status, 0);
    const paths = parsed.data.extensions.map((item) => item.path);
    assert.ok(paths.includes("x-delonet/root-note"), "root extension must be reported");
    assert.ok(paths.includes("authorities.project_identity.x-delonet/nested-note"), "nested extension must be reported");
    const project = parsed.data.authorities.find((item) => item.id === "project_identity");
    assert.ok(!Object.keys(project).some((key) => key.startsWith("x-")), "an extension must never appear as policy");
    assert.equal(readFileSync(path, "utf8"), text, "validation must not rewrite the contract it read");
  });

  // -- read-only, on the failing paths too ------------------------------------

  check("a directory given as a contract fails as INVALID_INPUT, not a crash", () => {
    const result = cli(["fleet", "contract", "validate", "--contract", temp, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.error.code, "INVALID_INPUT");
    assert.equal(result.status, 2);
  });

  check("the scratch HOME is byte-identical after every invocation above", () => {
    // `cli()` asserts this per call; this check states the postcondition once
    // more against the seed, so a mutation that both wrote and reverted a file
    // between two calls still shows up as a changed mtime.
    const seeded = snapshot(scratchHome);
    assert.ok(Object.keys(seeded).length >= 3, "fixture assumption: the scratch HOME has content to protect");
    cli(["fleet", "contract", "validate"]);
    cli(["fleet", "contract", "validate", "--contract", join(temp, "nope.yaml"), "--json"]);
    assert.deepEqual(snapshot(scratchHome), seeded);
  });

  check("the suite is registered in the test runner", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.ok(runner.includes("tests/fleet-contract-regressions.mjs"), "a suite absent from SUITES never runs");
  });

  check("the contract ships in the published tarball", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(manifest.files.includes("contracts"), "without this, validate breaks for installed users");
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet contract check(s) failed`);
  process.exit(1);
}
console.log("fleet contract regressions passed");
