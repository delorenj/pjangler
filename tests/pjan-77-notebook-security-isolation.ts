import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateNotebookBaseUrl } from "../src/notebook/config";
import { readSafeEvidenceText } from "../src/notebook/git-evidence";
import { captureWorkerEnvironment, describeProjectNotebookSkillDrift, inspectProjectNotebookIntegration, installPackagedProjectNotebookSkill, installProjectNotebookIntegration, repairProjectNotebookSkillProjection, verifyProjectNotebookSkillExport } from "../src/notebook/hooks";
import { encodeNoteEnvelope, parseNoteEnvelope, withNoteEnvelope } from "../src/notebook/notes";
import { compileOverviewArtifact, renderOverviewContent } from "../src/notebook/overview";
import { OpenNotebookClient } from "../src/notebook/open-notebook-client";
import { DEFAULT_NOTEBOOK_LIMITS, NOTEBOOK_POLICY_VERSION, NotebookError, type EffectiveNotebookConfigV1, type PjanglerNoteEnvelopeV1 } from "../src/notebook/types";

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function config(repo: string, overrides: Partial<EffectiveNotebookConfigV1> = {}): EffectiveNotebookConfigV1 {
  return {
    schema_version: 1, project_slug: "alpha", repo_path: repo, base_url: "http://127.0.0.1:8502", auth: { mode: "none" },
    policy: { enabled: true, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 4_000, documentation_globs: ["**/*.md"] },
    limits: { ...DEFAULT_NOTEBOOK_LIMITS }, binding: { state: "linked", notebook_id: "nb-alpha", notebook_name: "Alpha", overview_note_id: "overview-alpha" }, configuration_provenance: {}, ...overrides,
  };
}

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-security-"));
try {
  const overviewDescriptor = { schema_version: 1 as const, project_slug: "alpha", project_name: "Alpha", purpose: "Fixture", references: [], compiler_policy_version: NOTEBOOK_POLICY_VERSION };
  const envelopes: PjanglerNoteEnvelopeV1[] = [
    { schema_version: 1, project_slug: "alpha", kind: "overview", logical_id: "overview:v1:alpha", policy_version: NOTEBOOK_POLICY_VERSION, overview_descriptor: overviewDescriptor },
    { schema_version: 1, project_slug: "alpha", kind: "user-note", logical_id: "user-note:v1:11111111-1111-4111-8111-111111111111", policy_version: NOTEBOOK_POLICY_VERSION },
    { schema_version: 1, project_slug: "alpha", kind: "document", logical_id: "a".repeat(64), source_path: "README.md", source_revision: "b".repeat(40), content_sha256: "c".repeat(64), session_key: "d".repeat(64), captured_at: "2026-08-19T12:00:00.000Z", policy_version: NOTEBOOK_POLICY_VERSION },
    { schema_version: 1, project_slug: "alpha", kind: "session-capture", logical_id: "e".repeat(64), content_sha256: "f".repeat(64), session_key: "d".repeat(64), captured_at: "2026-08-19T12:00:00.000Z", policy_version: NOTEBOOK_POLICY_VERSION },
  ];
  for (const envelope of envelopes) {
    const roundTrip = parseNoteEnvelope(`${encodeNoteEnvelope({ ...envelope, source_revision: envelope.source_revision ?? undefined })}\nbody`);
    assert.deepEqual(roundTrip?.envelope, envelope, `${envelope.kind} envelope canonical JSON round-trips and omits undefined optionals`);
  }
  const hostileDescriptor = { schema_version: 1, project_slug: "alpha", kind: "overview", logical_id: "overview:v1:alpha", overview_descriptor: {} };
  assert.equal(parseNoteEnvelope(`<!-- pjangler-note-v1:${Buffer.from(JSON.stringify(hostileDescriptor)).toString("base64url")} -->\nbody`), null, "partial untrusted Overview descriptor is rejected without throwing in drift code");

  const repo = join(workspace, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "README.md"), "# Alpha\nSafe overview evidence.\n");
  writeFileSync(join(repo, "secret.md"), "api_key=abcdefghijklmnop123456\n");
  writeFileSync(join(repo, "large.md"), "x".repeat(2_000));
  symlinkSync(join(workspace, "outside.md"), join(repo, "linked.md"));
  writeFileSync(join(workspace, "outside.md"), "outside");
  git(repo, ["add", "README.md", "secret.md", "large.md"]);
  git(repo, ["commit", "-qm", "evidence"]);
  const overviewConfig = config(repo, { policy: { enabled: true, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 120, documentation_globs: ["**/*.md"], overview_references: ["README.md", "secret.md", "large.md", "linked.md"] }, limits: { ...DEFAULT_NOTEBOOK_LIMITS, source_file_max_bytes: 1_000 } });
  const artifact = compileOverviewArtifact({ config: overviewConfig, projectName: "Alpha", purpose: "Fixture" });
  assert.equal(artifact.descriptor.references.find((item) => item.path === "README.md")?.status, "present");
  assert.equal(artifact.descriptor.references.find((item) => item.path === "secret.md")?.reason, "secret-like");
  assert.equal(artifact.descriptor.references.find((item) => item.path === "large.md")?.reason, "oversize");
  assert.equal(artifact.descriptor.references.find((item) => item.path === "linked.md")?.reason, "not-tracked");
  writeFileSync(join(repo, "README.md"), "swapped after compilation\n");
  const rendered = renderOverviewContent({ config: overviewConfig, descriptor: artifact.descriptor, referenceContents: artifact.reference_contents });
  assert.match(rendered, /Safe overview evidence/u, "Overview rendering uses the single descriptor-bound read, not a swapped pathname reread");
  assert.doesNotMatch(rendered, /swapped after compilation/u);
  assert.ok(Array.from(parseNoteEnvelope(rendered)?.body ?? "").length <= overviewConfig.policy.overview_max_chars);
  assert.equal(readSafeEvidenceText(repo, "linked.md", 1_000).status, "excluded", "symlink evidence is rejected by the no-follow reader");

  for (const unsafe of ["https://10.0.0.2", "https://[2001:db8::4]"]) assert.throws(() => validateNotebookBaseUrl(unsafe));
  const secretBody = "OPEN_NOTEBOOK_PASSWORD=do-not-leak-this-value";
  const client = new OpenNotebookClient(config(repo), { fetch: async () => new Response(secretBody, { status: 500 }) });
  await assert.rejects(() => client.listNotebooks(), (error: unknown) => error instanceof NotebookError && error.code === "SERVICE_UNAVAILABLE" && !error.message.includes("do-not-leak"));

  const workerEnvironment = captureWorkerEnvironment({
    HOME: "/fixture/home",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_STATE_HOME: "/fixture/state",
    LANG: "C.UTF-8",
    OPEN_NOTEBOOK_PASSWORD: "runtime-only",
    NODE_OPTIONS: "--require=/tmp/inject.cjs",
    BASH_ENV: "/tmp/inject.sh",
    ARBITRARY_SECRET: "must-not-cross-boundary",
    PJ_PROJECT_REGISTRY: join(workspace, "override-registry.yaml"),
  }, "alpha");
  assert.deepEqual(workerEnvironment, {
    PATH: "/usr/bin:/bin",
    PJ_NOTEBOOK_WORKER_PROJECT_SLUG: "alpha",
    HOME: "/fixture/home",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_STATE_HOME: "/fixture/state",
    LANG: "C.UTF-8",
    OPEN_NOTEBOOK_PASSWORD: "runtime-only",
    PJ_PROJECT_REGISTRY: join(workspace, "override-registry.yaml"),
  }, "the detached worker receives only the bounded runtime allowlist");
  assert.equal(captureWorkerEnvironment({ PJ_PROJECT_REGISTRY: "relative-registry.yaml" }, "alpha").PJ_PROJECT_REGISTRY, undefined, "a non-absolute Registry override is not forwarded to the detached worker");

  const packedFixture = resolve("dist", "assets", "project-notebook-skill");
  assert.ok(existsSync(packedFixture), "package-pinned skill fixture exists");
  const fixtureRegistry = join(workspace, "fixture-registry");
  const canonical = join(fixtureRegistry, "all-skills", "project-notebook");
  const canonicalGlobal = join(fixtureRegistry, "skill-sets", "global");
  mkdirSync(join(fixtureRegistry, "all-skills"), { recursive: true });
  mkdirSync(canonicalGlobal, { recursive: true });
  cpSync(packedFixture, canonical, { recursive: true });
  symlinkSync(canonical, join(canonicalGlobal, "project-notebook"), "dir");
  const canonicalHome = join(workspace, "canonical-home");
  mkdirSync(join(canonicalHome, ".agents"), { recursive: true });
  symlinkSync(canonicalGlobal, join(canonicalHome, ".agents", "skills"), "dir");
  const canonicalData = join(workspace, "canonical-data");
  const canonicalInstall = installPackagedProjectNotebookSkill({ env: { HOME: canonicalHome, XDG_DATA_HOME: canonicalData } });
  assert.equal(canonicalInstall.installed, false, "the verified two-link Skillex projection is preserved instead of replaced");
  assert.equal(realpathSync(canonicalInstall.path), realpathSync(canonical), "the preserved projection resolves to the canonical all-skills source");
  assert.equal(existsSync(canonicalData), false, "a canonical projection does not create an unnecessary packed XDG payload");
  const canonicalIntegration = installProjectNotebookIntegration({ env: { HOME: canonicalHome, XDG_DATA_HOME: canonicalData, XDG_STATE_HOME: join(workspace, "canonical-state") }, target: join(canonicalHome, ".claude", "settings.json") });
  assert.equal(canonicalIntegration.skill.installed, false, "isolated hook installation keeps the canonical Skillex projection");
  assert.equal(canonicalIntegration.hooksChanged, true, "isolated hook installation projects the canonical hooks");
  const inspected = inspectProjectNotebookIntegration({ HOME: canonicalHome, XDG_DATA_HOME: canonicalData, PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS: join(canonicalHome, ".claude", "settings.json") });
  assert.equal(inspected.skill_installed, true, `canonical verified Skillex projection audits successfully without an XDG packed payload: ${inspected.details.join("; ")}`);
  assert.equal(inspected.hooks_projected, true, `canonical verified Skillex hooks audit successfully: ${inspected.details.join("; ")}`);

  const invalidRootHome = join(workspace, "invalid-root-home");
  const invalidRoot = join(workspace, "not-skillex-global");
  mkdirSync(join(invalidRootHome, ".agents"), { recursive: true });
  mkdirSync(invalidRoot, { recursive: true });
  symlinkSync(canonical, join(invalidRoot, "project-notebook"), "dir");
  symlinkSync(invalidRoot, join(invalidRootHome, ".agents", "skills"), "dir");
  const invalidRootData = join(workspace, "invalid-root-data");
  // PJAN-82: the safety property is "do not write", not "throw". An
  // unauthenticated skills root is reported and left alone; raising here made a
  // machine-level condition abort (and roll back) unrelated project creation.
  const invalidRootInstall = installPackagedProjectNotebookSkill({ env: { HOME: invalidRootHome, XDG_DATA_HOME: invalidRootData } });
  assert.equal(invalidRootInstall.installed, false, "a digest-valid child does not authenticate an arbitrary symlinked skills root");
  assert.equal(invalidRootInstall.blocked?.code, "skills-root-unsupported", "an unauthenticated skills root is reported as a host block");
  assert.ok(invalidRootInstall.blocked?.repair.includes("pj notebook skill"), "a host block names the repair command");
  assert.equal(existsSync(invalidRootData), false, "a rejected skills-root projection cannot create an XDG payload");
  const invalidRootIntegration = installProjectNotebookIntegration({ env: { HOME: invalidRootHome, XDG_DATA_HOME: invalidRootData, XDG_STATE_HOME: join(workspace, "invalid-root-state") }, target: join(invalidRootHome, ".claude", "settings.json") });
  assert.equal(invalidRootIntegration.hooksChanged, false, "a blocked skill install never arms a SessionStart command");
  assert.equal(invalidRootIntegration.blocked?.code, "skills-root-unsupported", "the block travels to the integration caller");
  assert.equal(existsSync(join(invalidRootHome, ".claude", "settings.json")), false, "a blocked integration writes no global Claude settings");

  // PJAN-82: content drift in the canonical projection is the exact condition
  // that destroyed a freshly-rendered project. It must degrade, name the file,
  // and be repairable from the version-pinned export.
  const driftHome = join(workspace, "drift-home");
  const driftRegistry = join(workspace, "drift-registry");
  const driftCanonical = join(driftRegistry, "all-skills", "project-notebook");
  const driftGlobal = join(driftRegistry, "skill-sets", "global");
  mkdirSync(join(driftRegistry, "all-skills"), { recursive: true });
  mkdirSync(driftGlobal, { recursive: true });
  cpSync(packedFixture, driftCanonical, { recursive: true });
  rmSync(join(driftCanonical, "export-manifest.json"), { force: true });
  rmSync(join(driftCanonical, "SHA256SUMS"), { force: true });
  symlinkSync(driftCanonical, join(driftGlobal, "project-notebook"), "dir");
  mkdirSync(join(driftHome, ".agents"), { recursive: true });
  symlinkSync(driftGlobal, join(driftHome, ".agents", "skills"), "dir");
  const driftEnv = { HOME: driftHome, XDG_DATA_HOME: join(workspace, "drift-data"), XDG_STATE_HOME: join(workspace, "drift-state") };
  assert.equal(installPackagedProjectNotebookSkill({ env: driftEnv }).blocked, undefined, "an undrifted copied projection authenticates");
  const driftedFile = join(driftCanonical, "hooks", "session-start.sh");
  writeFileSync(driftedFile, `${readFileSync(driftedFile, "utf8")}\n# local edit\n`);
  const driftInstall = installPackagedProjectNotebookSkill({ env: driftEnv });
  assert.equal(driftInstall.installed, false, "a drifted canonical projection is not replaced");
  assert.equal(driftInstall.blocked?.code, "projection-drift", "content drift is reported as projection drift");
  assert.ok(driftInstall.blocked?.details.some((detail) => detail.startsWith("hooks/session-start.sh:")), `drift names the differing file: ${driftInstall.blocked?.details.join("; ")}`);
  assert.deepEqual(describeProjectNotebookSkillDrift(driftCanonical).filter((detail) => detail.startsWith("hooks/session-start.sh")).length, 1, "drift diagnostics enumerate per-file differences");
  const observedDrift = inspectProjectNotebookIntegration(driftEnv);
  assert.equal(observedDrift.skill_installed, false, "a drifted projection does not audit as installed");
  assert.equal(observedDrift.blocked?.code, "projection-drift", "the observation carries the host block for the audit layer");
  const plannedRepair = repairProjectNotebookSkillProjection({ env: driftEnv });
  assert.equal(plannedRepair.status, "planned", `a dry-run repair plans without writing: ${plannedRepair.summary}`);
  assert.deepEqual(plannedRepair.changed_files, [driftedFile], "the repair plan names exactly the drifted file");
  assert.match(readFileSync(driftedFile, "utf8"), /# local edit/u, "a dry-run repair writes nothing");
  const appliedRepair = repairProjectNotebookSkillProjection({ env: driftEnv, apply: true });
  assert.equal(appliedRepair.status, "repaired", appliedRepair.summary);
  assert.doesNotMatch(readFileSync(driftedFile, "utf8"), /# local edit/u, "the repair restores the pinned bytes");
  assert.equal(repairProjectNotebookSkillProjection({ env: driftEnv }).status, "clean", "the repair is idempotent and converges");
  assert.equal(installPackagedProjectNotebookSkill({ env: driftEnv }).blocked, undefined, "a repaired projection authenticates again");

  const packedHome = join(workspace, "packed-home");
  const installed = installPackagedProjectNotebookSkill({ env: { HOME: packedHome, XDG_DATA_HOME: join(workspace, "packed-data") } });
  assert.equal(installed.installed, true);
  const payload = realpathSync(installed.path);
  assert.match(payload, new RegExp(`${installed.digest}$`, "u"));
  const firstPayloadFile = readdirSync(payload, { recursive: true, withFileTypes: true }).find((entry) => entry.isFile() && entry.name === "SKILL.md");
  assert.ok(firstPayloadFile);
  writeFileSync(join(payload, "SKILL.md"), `${readFileSync(join(payload, "SKILL.md"), "utf8")}\ntampered\n`);
  assert.throws(() => installPackagedProjectNotebookSkill({ env: { HOME: packedHome, XDG_DATA_HOME: join(workspace, "packed-data") } }), /digest mismatch/u, "an installed payload is reverified before reuse");

  // PJAN-84: superseded payloads are collected, foreign directories are not.
  //
  // Each re-pin materialized an immutable <version>-<digest> directory and
  // nothing removed the previous one, so the store grew by a full copy of the
  // skill on every release. Exactly one payload can be reachable — the hook
  // command is the fixed $HOME/.agents/skills/project-notebook link.
  {
    const gcHome = join(workspace, "gc-home");
    const gcData = join(workspace, "gc-data");
    const store = join(gcData, "pjangler", "skills", "project-notebook");
    mkdirSync(store, { recursive: true });
    const stale = [
      `1.0.0-${"a".repeat(64)}`,
      `1.2.0-${"b".repeat(64)}`,
      `9.9.9-next.1-${"c".repeat(64)}`,
    ];
    for (const name of stale) mkdirSync(join(store, name), { recursive: true });
    mkdirSync(join(store, "not-a-payload"), { recursive: true });
    const collected = installPackagedProjectNotebookSkill({ env: { HOME: gcHome, XDG_DATA_HOME: gcData } });
    assert.equal(collected.installed, true);
    for (const name of stale) {
      assert.equal(existsSync(join(store, name)), false, `superseded payload ${name} must be collected`);
    }
    assert.equal(existsSync(join(store, "not-a-payload")), true, "a directory that is not a payload is never touched");
    assert.equal(existsSync(realpathSync(collected.path)), true, "the payload the link points at survives");
    assert.equal(dirname(realpathSync(collected.path)), realpathSync(store), "the surviving payload is the one just written");
    // A second install is still a no-op and does not collect the live payload.
    const again = installPackagedProjectNotebookSkill({ env: { HOME: gcHome, XDG_DATA_HOME: gcData } });
    assert.equal(again.installed, false);
    assert.equal(existsSync(realpathSync(collected.path)), true, "collection must never remove the payload in use");
  }

  const hostile = join(workspace, "hostile-source");
  cpSync(canonical, hostile, { recursive: true });
  writeFileSync(join(hostile, "SKILL.md"), `${readFileSync(join(hostile, "SKILL.md"), "utf8")}\nmalicious\n`);
  assert.throws(() => verifyProjectNotebookSkillExport(hostile), /package-pinned|match|digest/u, "a self-authored source tree cannot authenticate itself");

  const foreignHome = join(workspace, "foreign-home");
  mkdirSync(join(foreignHome, ".agents", "skills"), { recursive: true });
  const foreign = join(workspace, "foreign-skill");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "SKILL.md"), "foreign");
  symlinkSync(foreign, join(foreignHome, ".agents", "skills", "project-notebook"), "dir");
  const foreignInstall = installPackagedProjectNotebookSkill({ env: { HOME: foreignHome, XDG_DATA_HOME: join(workspace, "foreign-data") } });
  assert.equal(foreignInstall.installed, false, "a foreign skill path is never replaced");
  assert.equal(foreignInstall.blocked?.code, "projection-foreign", "a foreign skill path is reported as a host block");
  assert.match(realpathSync(join(foreignHome, ".agents", "skills", "project-notebook")), /foreign-skill$/u, "the foreign target is left exactly as the operator left it");

  console.log("pjan-77 notebook security/isolation: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
