// PJAN-65 — `pjangler describe` must actually describe a repo.
//
// Everything here runs the real built CLI and the real MCP server against real
// temporary git repos and a real registry file. Nothing is stubbed: the point
// of `describe` is that it reads what is on disk, so a fixture would only
// confirm the fixture.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const serverPath = join(root, "dist", "mcp-server.js");
const workspace = mkdtempSync(join(tmpdir(), "pjan-65-"));
const registryPath = join(workspace, "projects.yaml");

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
}

function describeJson(repo) {
  const result = runCli(["describe", repo, "--registry", registryPath, "--json"]);
  assert.equal(result.status, 0, `describe ${repo} exited ${result.status}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function subsystem(payload, id) {
  const found = payload.subsystems.find((entry) => entry.id === id);
  assert.ok(found, `describe should report the ${id} subsystem`);
  return found;
}

function makeRepo(name) {
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  const init = spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed for ${name}: ${init.stderr}`);
  return repo;
}

try {
  // --- 1. The placeholder is gone --------------------------------------------
  const stubCheck = runCli(["describe", "--registry", registryPath]);
  assert.equal(stubCheck.status, 0, `describe exited ${stubCheck.status}\n${stubCheck.stderr}`);
  for (const banned of ["Coming soon", "placeholder", "Will analyze"]) {
    assert.ok(
      !stubCheck.stdout.includes(banned),
      `describe still ships the stub: found ${JSON.stringify(banned)} in its output`,
    );
  }

  // --- 2. A plain non-33GOD repo must be described, not crashed on -----------
  const plain = makeRepo("plain");
  writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "plain", version: "1.0.0" }), "utf8");
  const plainPayload = describeJson(plain);

  assert.equal(plainPayload.type.primaryLanguage, "javascript", "package.json alone means javascript");
  assert.equal(plainPayload.identity.manifest, false, "a plain repo has no .project.json");
  assert.equal(plainPayload.identity.registered, false, "a plain repo is not in the registry");
  assert.equal(plainPayload.git.isRepo, true, "the temp repo is a git work tree");
  assert.equal(subsystem(plainPayload, "node").status, "installed", "package.json installs the node subsystem");
  assert.equal(subsystem(plainPayload, "project").status, "absent", "no .project.json means project is absent");

  const adoptStep = plainPayload.nextSteps.find((step) => step.command === "pjangler init --apply");
  assert.ok(adoptStep, "an unregistered repo should be told to register itself");
  assert.equal(adoptStep.source, "lifecycle");

  // --- 3. Presence is file-derived, NOT rule-derived -------------------------
  // Every mise rule already fails in the plain repo, yet mise is reported absent
  // rather than drifted. Collapsing presence into parity would have said
  // "broken" about a subsystem that was simply never installed.
  const plainMise = subsystem(plainPayload, "mise");
  assert.equal(plainMise.status, "absent", "mise is not installed in a plain repo");
  assert.deepEqual(plainMise.evidence, [], "an absent subsystem has no marker evidence");
  assert.ok(
    plainMise.rules.some((rule) => rule.status === "fail"),
    "the mise rules do fail here — proving status is not just a rule rollup",
  );

  writeFileSync(join(plain, "mise.toml"), "[tools]\nnode = \"latest\"\n", "utf8");
  const withMise = subsystem(describeJson(plain), "mise");
  assert.notEqual(withMise.status, "absent", "adding mise.toml must make mise present");
  assert.ok(withMise.evidence.includes("mise.toml"), "mise.toml is the marker evidence");

  // --- 4. Role and language detection read real manifests --------------------
  writeFileSync(join(plain, "tsconfig.json"), "{}", "utf8");
  writeFileSync(
    join(plain, "package.json"),
    JSON.stringify({
      name: "plain",
      version: "1.0.0",
      bin: { plain: "dist/index.js" },
      dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
    }),
    "utf8",
  );
  const typed = describeJson(plain);
  assert.equal(typed.type.primaryLanguage, "typescript", "tsconfig.json promotes the repo to typescript");
  assert.ok(typed.type.roles.includes("cli"), "package.json#bin means cli");
  assert.ok(typed.type.roles.includes("mcp-server"), "an MCP sdk dependency means mcp-server");
  assert.ok(
    typed.type.evidence.some((line) => line.includes("tsconfig.json")),
    "every detected signal must name the file that proved it",
  );

  // --- 5. A manifest without a registry entry is registry drift -------------
  const adopted = makeRepo("adopted");
  writeFileSync(
    join(adopted, ".project.json"),
    JSON.stringify({
      project_name: "Adopted",
      project_description: "manifest present, registry empty",
      project_slug: "adopted",
      repo_path: adopted,
      ticket_provider: { type: "plane", workspace: "33god", identifier: "ADPT", board_id: "board-1", state: "linked" },
      agents: { "adopted-pm": { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "planned" } },
    }),
    "utf8",
  );
  const adoptedPayload = describeJson(adopted);
  assert.equal(adoptedPayload.identity.manifest, true);
  assert.equal(adoptedPayload.identity.registered, false);
  assert.equal(adoptedPayload.identity.slug, "adopted", "identity falls back to the manifest when unregistered");
  assert.ok(adoptedPayload.type.roles.includes("33god-project"), ".project.json makes it a 33god-project");
  assert.ok(
    adoptedPayload.identity.drift.some((entry) => entry.note.includes("not in the pjangler registry")),
    "a manifest with no registry entry is drift",
  );
  assert.ok(
    adoptedPayload.nextSteps.some((step) => step.source === "registry"),
    "unregistered-but-adopted repos need a registry step",
  );
  const agentStep = adoptedPayload.nextSteps.find((step) => step.source === "agents");
  assert.ok(agentStep, "a planned agent should produce a provisioning step");
  assert.match(agentStep.command, /hermes-agent/, "agent provisioning goes through hermes-agent");

  // --- 6. Registry vs manifest board drift is reported, manifest wins --------
  // `.project.json` is the documented single source of truth for the board
  // binding, so describe must show the manifest's board and flag the registry.
  writeFileSync(
    registryPath,
    [
      "schema_version: 1",
      "projects:",
      "  adopted:",
      "    name: Adopted",
      "    slug: adopted",
      `    repo_path: ${adopted}`,
      "    description: manifest present, registry stale",
      "    status: active",
      "    source_artifacts: []",
      "    template:",
      "      commonproject:",
      "        enabled: true",
      "        primary_language: python",
      "    ticket_provider:",
      "      type: plane",
      "      workspace: 33god",
      "      identifier: ADPT",
      '      board_id: ""',
      "      state: planned",
      "    agents: {}",
      "    created_at: 2026-01-01T00:00:00.000Z",
      "    updated_at: 2026-01-01T00:00:00.000Z",
      "",
    ].join("\n"),
    "utf8",
  );
  const drifted = describeJson(adopted);
  assert.equal(drifted.identity.registered, true, "the repo is now in the registry");
  assert.equal(drifted.identity.ticketProvider.boardId, "board-1", "the manifest board binding wins");
  assert.ok(
    drifted.identity.drift.some((entry) => entry.note.includes("ticket_provider.board_id differs")),
    `registry/manifest board drift must be reported, got: ${JSON.stringify(drifted.identity.drift)}`,
  );
  // `project doctor` only inspects paths and manifest presence, so it must NOT
  // be offered as the fix for a field-value disagreement it cannot even see.
  const boardDrift = drifted.identity.drift.find((entry) => entry.note.includes("ticket_provider.board_id differs"));
  assert.equal(boardDrift.command, undefined, "field-value drift has no auto-fix command");
  const boardStep = drifted.nextSteps.find((step) => step.reason.includes("ticket_provider.board_id differs"));
  assert.ok(boardStep, "board drift must surface as a next step");
  assert.equal(boardStep.command, undefined, "the board drift step must not claim a command that cannot fix it");

  // --- 7. Fixable parity drift collapses into one migrate --all step ---------
  const parityStep = drifted.nextSteps.find((step) => step.command === "pjangler migrate --all");
  assert.ok(parityStep, "multiple fixable rules collapse into a single migrate --all step");
  assert.ok(parityStep.rules.length > 1, "the collapsed step names every rule it covers");
  // Regression: rule summaries contain their own "; ", so details must stay a
  // structured list. Rebuilding them by splitting a joined string tore
  // `bmad.cli-roots` in half.
  assert.equal(
    parityStep.details.length,
    parityStep.rules.length,
    "one detail line per covered rule — details must not be a re-split string",
  );
  for (const [index, ruleId] of parityStep.rules.entries()) {
    assert.ok(parityStep.details[index].startsWith(`${ruleId}:`), `detail ${index} must belong to ${ruleId}`);
  }
  assert.ok(
    drifted.nextSteps.every((step) => step.command !== "pjangler migrate --all" || step === parityStep),
    "only one collapsed parity step may be emitted",
  );

  // --- 8. Parity counts match the rules actually reported --------------------
  const counted = drifted.subsystems.flatMap((entry) => entry.rules);
  const tally = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const rule of counted) tally[rule.status] += 1;
  assert.deepEqual(tally, drifted.parity.counts, "headline parity counts must match the per-subsystem rules");

  // --- 9. Bad input fails loudly --------------------------------------------
  const missing = runCli(["describe", join(workspace, "does-not-exist")]);
  assert.notEqual(missing.status, 0, "describing a missing path must exit non-zero");
  assert.match(missing.stderr, /describe failed/, "the failure must name the command");

  // --- 10. Describing pjangler itself ---------------------------------------
  const self = describeJson(root);
  // Assert PRESENCE, not parity. "installed" additionally requires every
  // project rule to pass, which is a different claim and one that legitimately
  // fails in e.g. a git worktree, where the registry's repo_path points at the
  // main checkout. Presence is what "pjangler is a 33GOD project" means.
  const selfProject = subsystem(self, "project");
  assert.notEqual(selfProject.status, "absent", "pjangler is a 33GOD project");
  assert.ok(selfProject.evidence.includes(".project.json"), "presence must be proved by the manifest on disk");
  assert.ok(self.type.roles.includes("33god-project"));
  assert.ok(self.type.roles.includes("cli"));
  assert.ok(
    self.configFiles.some((file) => file.path === ".project.json"),
    "config files must include the manifest that is really there",
  );

  // --- 11. The same context is reachable over MCP ---------------------------
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    cwd: root,
    env: { ...process.env, PJ_PROJECT_REGISTRY: registryPath },
  });
  const client = new Client({ name: "pjan-65-regression", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.ok(
      listed.tools.some((tool) => tool.name === "pjangler_describe_project"),
      "pjangler_describe_project must be exposed over MCP",
    );

    const called = await client.callTool({
      name: "pjangler_describe_project",
      arguments: { targetDir: plain, registryPath },
    });
    const payload = JSON.parse(called.content[0].text);
    assert.equal(payload.repo, plain, "MCP describe must target the requested repo");
    assert.deepEqual(
      payload.subsystems.map((entry) => entry.id),
      describeJson(plain).subsystems.map((entry) => entry.id),
      "MCP and CLI must describe the same subsystem set",
    );

    const rendered = await client.callTool({
      name: "pjangler_describe_project",
      arguments: { targetDir: plain, registryPath, json: false },
    });
    assert.match(rendered.content[0].text, /Subsystems/, "json:false returns the human report");

    const bad = await client.callTool({
      name: "pjangler_describe_project",
      arguments: { targetDir: join(workspace, "nope") },
    });
    assert.equal(bad.isError, true, "a missing directory must surface as an MCP error");
  } finally {
    await client.close();
  }

  console.log("pjan-65 describe regressions passed");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
