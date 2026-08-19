import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateNotebookBaseUrl } from "../src/notebook/config";
import { readSafeEvidenceText } from "../src/notebook/git-evidence";
import { captureWorkerEnvironment, inspectProjectNotebookIntegration, installPackagedProjectNotebookSkill, verifyProjectNotebookSkillExport } from "../src/notebook/hooks";
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
  const canonical = join(workspace, "fixture-registry", "all-skills", "project-notebook");
  mkdirSync(join(workspace, "fixture-registry", "all-skills"), { recursive: true });
  cpSync(packedFixture, canonical, { recursive: true });
  const canonicalHome = join(workspace, "canonical-home");
  mkdirSync(join(canonicalHome, ".agents", "skills"), { recursive: true });
  symlinkSync(canonical, join(canonicalHome, ".agents", "skills", "project-notebook"), "dir");
  const inspected = inspectProjectNotebookIntegration({ HOME: canonicalHome, XDG_DATA_HOME: join(workspace, "canonical-data"), PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS: join(canonicalHome, ".claude", "settings.json") });
  assert.equal(inspected.skill_installed, true, `canonical verified Skillex projection audits successfully without an XDG packed payload: ${inspected.details.join("; ")}`);

  const packedHome = join(workspace, "packed-home");
  const installed = installPackagedProjectNotebookSkill({ env: { HOME: packedHome, XDG_DATA_HOME: join(workspace, "packed-data") } });
  assert.equal(installed.installed, true);
  const payload = realpathSync(installed.path);
  assert.match(payload, new RegExp(`${installed.digest}$`, "u"));
  const firstPayloadFile = readdirSync(payload, { recursive: true, withFileTypes: true }).find((entry) => entry.isFile() && entry.name === "SKILL.md");
  assert.ok(firstPayloadFile);
  writeFileSync(join(payload, "SKILL.md"), `${readFileSync(join(payload, "SKILL.md"), "utf8")}\ntampered\n`);
  assert.throws(() => installPackagedProjectNotebookSkill({ env: { HOME: packedHome, XDG_DATA_HOME: join(workspace, "packed-data") } }), /digest mismatch/u, "an installed payload is reverified before reuse");

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
  assert.throws(() => installPackagedProjectNotebookSkill({ env: { HOME: foreignHome, XDG_DATA_HOME: join(workspace, "foreign-data") } }), /foreign|customized/u);

  console.log("pjan-77 notebook security/isolation: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
