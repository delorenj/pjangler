// PID-2/3/4 — board identity is READ from the provider, never invented.
//
// Four code paths used to mint a board identifier from `slug.slice(0, 4)` and
// none of them read back what Plane actually assigned, so the registry spent
// months insisting the Holocene board was called `HOLPM` when Plane calls it
// `HOLOC`. These tests hold three lines:
//
//   1. the minters are gone, and what replaced them is labelled a PROPOSAL;
//   2. `pj project identity` reads the truth back and repairs both stores
//      without touching anything it was not asked to touch;
//   3. the drifted shape — "linked" behind an identifier nobody confirmed — is
//      no longer representable in the registry at all.
//
// No network: the Plane client is injected.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cleanup = [];
let failures = 0;

function makeDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pjan-identity-${name}-`));
  cleanup.push(dir);
  return dir;
}

function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

// Bundle the modules under test at their module boundary. This is dependency
// injection, not a production bypass: the Plane client is the only seam.
const bundleDir = makeDir("bundle");
function bundle(entry, name) {
  const out = join(bundleDir, `${name}.cjs`);
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  return createRequire(import.meta.url)(out);
}

const projectApi = bundle("src/project/index.ts", "project-api");
const identityApi = bundle("src/project/identity.ts", "identity-api");

const {
  buildTicketProviderBlock,
  loadProjectRegistry,
  proposeProjectIdentifier,
  saveProjectRegistry,
  validateProjectRegistry,
} = projectApi;
const { DEAD_AGENT_IDS, applyHermesIdentifiers, readHermesAgentBoards, reconcileProjectIdentity } = identityApi;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOARD = {
  holocene: "727a2b17-a1dd-46f6-b583-afa5a2d2cdae",
  ssbnk: "ce150fc4-bfd9-4b6f-9f14-6468c18616e3",
  jimb: "a8a12be1-b3ab-44f4-ab24-abe8829aeb72",
  gone: "d7f7b5f6-78a7-49e7-928b-d5016783efd8",
};

/**
 * A fleet registry shaped like the real one: hand-maintained, mixed quoting,
 * one block sequence that is NOT indented, and an agent whose repo has no
 * pjangler record at all (`holocene` — the reason `--all` cannot iterate the
 * project registry).
 */
function writeHermesRegistry(dir) {
  const path = join(dir, "agents-registry.yaml");
  writeFileSync(
    path,
    [
      "schema_version: 1",
      "gateways:",
      "  bloodbank:",
      "    scope: fleet",
      "agents:",
      "  holocene-pm:",
      "    repo: holocene",
      "    role: pm",
      "    project_path: /nowhere/holocene",
      "    plane:",
      "      workspace: 33god",
      `      project_id: ${BOARD.holocene}`,
      "      identifier: HOLPM",
      "    hindsight:",
      "      recall_banks:",
      "      - holocene",
      "      - exec-office",
      "  ssbnk-pm:",
      "    repo: ssbnk",
      "    role: pm",
      "    project_path: SSBNK_REPO",
      "    plane:",
      "      workspace: 33god",
      `      project_id: ${BOARD.ssbnk}`,
      "      identifier: SSBN",
      "  james-brennan-pm:",
      "    repo: james-brennan",
      "    role: pm",
      "    plane:",
      "      workspace: automaticai",
      `      project_id: ${BOARD.jimb}`,
      "      identifier: ''",
      "  condaleeza:",
      "    repo: automatic-ai",
      "    role: reporter",
      "  coachingagentframework-pm:",
      "    repo: coachingagentframework",
      "    role: pm",
      "    plane:",
      "      workspace: 33god",
      `      project_id: ${BOARD.gone}`,
      "      identifier: COAPM",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function writeProjectRegistry(dir, ssbnkRepo) {
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    [
      "schema_version: 1",
      "projects:",
      "  ssbnk:",
      "    name: ssbnk",
      "    slug: ssbnk",
      `    repo_path: ${ssbnkRepo}`,
      '    description: ""',
      "    status: active",
      "    source_artifacts: []",
      "    template:",
      "      commonproject:",
      "        enabled: true",
      "        primary_language: python",
      "    ticket_provider:",
      "      type: plane",
      "      workspace: 33god",
      "      identifier: SSBN",
      '      board_id: ""',
      "      state: planned",
      "    agents: {}",
      "    created_at: 2026-01-01T00:00:00.000Z",
      "    updated_at: 2026-01-01T00:00:00.000Z",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

/** The Plane truth these fixtures drifted away from. */
function planeBoards(workspace) {
  if (workspace === "33god") {
    return new Map([
      [BOARD.holocene, { id: BOARD.holocene, identifier: "HOLOC", name: "Holocene", workspace }],
      [BOARD.ssbnk, { id: BOARD.ssbnk, identifier: "SSBNK", name: "SSBNK", workspace }],
    ]);
  }
  if (workspace === "automaticai") {
    return new Map([[BOARD.jimb, { id: BOARD.jimb, identifier: "JIMB", name: "James Brennan", workspace }]]);
  }
  return new Map();
}

function baseRecord(overrides = {}) {
  return {
    name: "Fixture",
    slug: "fixture",
    repo_path: "/tmp/fixture",
    description: "",
    status: "active",
    source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "python" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "FIX", board_id: "", state: "planned" },
    agents: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function registryOf(...records) {
  const projects = {};
  for (const record of records) projects[record.slug] = record;
  return { schema_version: 1, projects };
}

function rejects(fn, pattern, label) {
  assert.throws(fn, (error) => {
    assert.match(error.message, pattern, `${label}: got "${error.message}"`);
    return true;
  }, label);
}

// ---------------------------------------------------------------------------

console.log("PID-3: the minters are dead");

check("no code path is named `deriveProjectIdentifier` any more", () => {
  for (const file of ["src/project/index.ts", "src/mcp-server.ts", "src/index.ts"]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /deriveProjectIdentifier/, file);
  }
});

check("mcp-server no longer mints an identifier inline", () => {
  const source = readFileSync(join(root, "src", "mcp-server.ts"), "utf8");
  assert.doesNotMatch(source, /slice\(\s*0\s*,\s*4\s*\)/, "the inline slice minter must be gone");
  assert.match(source, /proposeProjectIdentifier\(/, "MCP must use the shared proposer");
});

check("a proposed identifier is only ever a proposal", () => {
  assert.equal(proposeProjectIdentifier("Holocene"), "HOLO");
  const block = buildTicketProviderBlock({ identifier: proposeProjectIdentifier("Holocene") });
  assert.equal(block.identifier_source, "proposed");
  assert.equal(block.state, "planned");
});

check("a board id alone cannot produce a linked board", () => {
  const block = buildTicketProviderBlock({ identifier: "HOLO", boardId: BOARD.holocene });
  assert.equal(block.board_id, BOARD.holocene);
  assert.equal(block.identifier_source, "proposed");
  assert.equal(block.state, "planned", "an unconfirmed identifier may not back a link");
});

check("a provider-confirmed identifier links, and records when it was read", () => {
  const block = buildTicketProviderBlock({
    identifier: "HOLOC",
    identifierSource: "provider",
    identifierFetchedAt: "2026-08-28T00:00:00.000Z",
    boardId: BOARD.holocene,
  });
  assert.equal(block.state, "linked");
  assert.equal(block.identifier_source, "provider");
  assert.equal(block.identifier_fetched_at, "2026-08-28T00:00:00.000Z");
});

console.log("");
console.log("PID-4: the drifted shape is unrepresentable");

check("R1 rejects a ticket_provider.state outside the lifecycle", () => {
  const record = baseRecord();
  record.ticket_provider.state = "active";
  rejects(() => validateProjectRegistry(registryOf(record)), /state must be one of planned \| linked \| skipped/, "R1");
});

check("R2 rejects an identifier_source outside provider|proposed", () => {
  const record = baseRecord();
  record.ticket_provider.identifier_source = "guessed";
  rejects(() => validateProjectRegistry(registryOf(record)), /identifier_source must be one of provider \| proposed/, "R2");
});

check("R3 rejects linked-without-provider-confirmation, and names the repair", () => {
  const noProvenance = baseRecord();
  Object.assign(noProvenance.ticket_provider, { board_id: BOARD.holocene, state: "linked" });
  rejects(
    () => validateProjectRegistry(registryOf(noProvenance)),
    /is not provider-confirmed[\s\S]*pj project identity --all --apply/,
    "R3 without provenance",
  );

  const proposed = baseRecord();
  Object.assign(proposed.ticket_provider, { board_id: BOARD.holocene, identifier_source: "proposed", state: "linked" });
  rejects(() => validateProjectRegistry(registryOf(proposed)), /is not provider-confirmed/, "R3 with a proposal");

  const noBoard = baseRecord();
  Object.assign(noBoard.ticket_provider, { identifier_source: "provider", state: "linked" });
  rejects(() => validateProjectRegistry(registryOf(noBoard)), /is not provider-confirmed/, "R3 without a board");
});

check("R3 accepts a provider-confirmed link", () => {
  const record = baseRecord();
  Object.assign(record.ticket_provider, {
    board_id: BOARD.holocene,
    identifier: "HOLOC",
    identifier_source: "provider",
    identifier_fetched_at: "2026-08-28T00:00:00.000Z",
    state: "linked",
  });
  validateProjectRegistry(registryOf(record));
});

check("R4 rejects two projects owning one board in one workspace", () => {
  const linked = (slug, identifier) => {
    const record = baseRecord({ slug, name: slug, repo_path: `/tmp/${slug}` });
    Object.assign(record.ticket_provider, {
      identifier,
      board_id: BOARD.holocene,
      identifier_source: "provider",
      state: "linked",
    });
    return record;
  };
  rejects(
    () => validateProjectRegistry(registryOf(linked("one", "ONE"), linked("two", "TWO"))),
    /Duplicate project board_id/,
    "R4",
  );
});

check("R4 exempts the empty board_id 22 records legitimately share", () => {
  const planned = (slug, identifier) =>
    baseRecord({
      slug,
      name: slug,
      repo_path: `/tmp/${slug}`,
      ticket_provider: { type: "plane", workspace: "33god", identifier, board_id: "", state: "planned" },
    });
  validateProjectRegistry(registryOf(planned("one", "ONE"), planned("two", "TWO"), planned("three", "THREE")));
});

check("R4 is scoped: the same board id in another workspace is a different board", () => {
  const linked = (slug, workspace, identifier) => {
    const record = baseRecord({ slug, name: slug, repo_path: `/tmp/${slug}` });
    Object.assign(record.ticket_provider, {
      workspace,
      identifier,
      board_id: BOARD.holocene,
      identifier_source: "provider",
      state: "linked",
    });
    return record;
  };
  validateProjectRegistry(registryOf(linked("one", "33god", "ONE"), linked("two", "automaticai", "TWO")));
});

check("R5 lets one identifier exist in two workspaces — the global key never could", () => {
  const record = (slug, workspace) => {
    const entry = baseRecord({ slug, name: slug, repo_path: `/tmp/${slug}` });
    Object.assign(entry.ticket_provider, { workspace, identifier: "AAI" });
    return entry;
  };
  validateProjectRegistry(registryOf(record("one", "33god"), record("two", "AutomaticAI")));
  // …and case never opens a second door inside one workspace.
  rejects(
    () => validateProjectRegistry(registryOf(record("one", "33god"), record("two", "33GOD"))),
    /Duplicate project identifier: AAI/,
    "R5 same workspace",
  );
});

check("provenance survives a registry write — the owned-key trap", () => {
  // mergeYamlMapping only persists keys listed in TICKET_PROVIDER_OWNED_KEYS.
  // A new field missing from that list is silently dropped on the next write,
  // which would quietly restore the exact drift this change removes.
  const dir = makeDir("owned-keys");
  const record = baseRecord({ slug: "owned", name: "owned", repo_path: join(dir, "repo") });
  Object.assign(record.ticket_provider, {
    identifier: "HOLOC",
    board_id: BOARD.holocene,
    identifier_source: "provider",
    identifier_fetched_at: "2026-08-28T00:00:00.000Z",
    state: "linked",
  });
  const path = join(dir, "projects.yaml");
  saveProjectRegistry(registryOf(record), path);
  // Write twice: the second pass goes through the CST merge, not the initial
  // stringify, and that is the path that drops unowned keys.
  saveProjectRegistry(loadProjectRegistry(path), path);
  const provider = loadProjectRegistry(path).projects.owned.ticket_provider;
  assert.equal(provider.identifier_source, "provider");
  assert.equal(provider.identifier_fetched_at, "2026-08-28T00:00:00.000Z");
  assert.equal(provider.state, "linked");
});

console.log("");
console.log("PID-2: pj project identity");

const scenario = () => {
  const dir = makeDir("identity");
  const ssbnkRepo = join(dir, "ssbnk");
  mkdirSync(ssbnkRepo, { recursive: true });
  const hermesRegistryPath = writeHermesRegistry(dir);
  writeFileSync(
    hermesRegistryPath,
    readFileSync(hermesRegistryPath, "utf8").replace("SSBNK_REPO", ssbnkRepo),
    "utf8",
  );
  return { dir, hermesRegistryPath, registryPath: writeProjectRegistry(dir, ssbnkRepo) };
};

await checkAsync("--all iterates the FLEET registry, not the project registry", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const report = await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    all: true,
    fetchBoards: async (workspace) => planeBoards(workspace),
  });
  // `holocene` has no pjangler record at all; iterating the 1-entry project
  // registry would never have seen it.
  const holocene = report.resolutions.find((entry) => entry.agentId === "holocene-pm");
  assert.equal(holocene.status, "drift");
  assert.equal(holocene.liveIdentifier, "HOLOC");
  assert.equal(holocene.slug, undefined, "holocene is not in the project registry");
  assert.equal(report.checked, 5, "every fleet agent is examined");
});

await checkAsync("a dry run reports the repair and writes nothing", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const before = { hermes: readFileSync(hermesRegistryPath, "utf8"), projects: readFileSync(registryPath, "utf8") };
  const report = await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    all: true,
    fetchBoards: async (workspace) => planeBoards(workspace),
  });
  assert.equal(report.apply, false);
  assert.deepEqual(
    report.changes.hermes.map((change) => [change.agentId, change.from, change.to]),
    [
      ["holocene-pm", "HOLPM", "HOLOC"],
      ["ssbnk-pm", "SSBN", "SSBNK"],
      ["james-brennan-pm", "", "JIMB"],
    ],
  );
  assert.deepEqual(report.changes.hermesDeleted, ["coachingagentframework-pm"]);
  assert.equal(readFileSync(hermesRegistryPath, "utf8"), before.hermes, "a dry run must not write");
  assert.equal(readFileSync(registryPath, "utf8"), before.projects, "a dry run must not write");
});

await checkAsync("--apply repairs both stores and touches nothing else", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const before = readFileSync(hermesRegistryPath, "utf8");
  await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    all: true,
    apply: true,
    now: new Date("2026-08-28T12:00:00.000Z"),
    fetchBoards: async (workspace) => planeBoards(workspace),
  });

  const after = readFileSync(hermesRegistryPath, "utf8");
  const parsed = YAML.parse(after);
  assert.equal(parsed.agents["holocene-pm"].plane.identifier, "HOLOC");
  assert.equal(parsed.agents["ssbnk-pm"].plane.identifier, "SSBNK");
  assert.equal(parsed.agents["james-brennan-pm"].plane.identifier, "JIMB", "a second workspace resolves too");
  assert.equal(Object.hasOwn(parsed.agents, "coachingagentframework-pm"), false, "the abandoned agent is gone");
  assert.equal(Object.keys(parsed.agents).length, 4, "exactly one agent was removed");

  // Surgery, not a rewrite: everything the command was not asked to change
  // survives byte for byte, including a block sequence the YAML serializer
  // would otherwise reindent and an unrelated top-level section.
  assert.match(after, /^schema_version: 1\ngateways:\n {2}bloodbank:\n {4}scope: fleet\n/);
  assert.match(after, /\n {6}recall_banks:\n {6}- holocene\n {6}- exec-office\n/, "sequence style must survive");
  const changedLines = after.split("\n").filter((line) => !before.includes(line));
  assert.deepEqual(changedLines.sort(), [
    "      identifier: HOLOC",
    "      identifier: JIMB",
    "      identifier: SSBNK",
  ]);

  const provider = loadProjectRegistry(registryPath).projects.ssbnk.ticket_provider;
  assert.equal(provider.identifier, "SSBNK");
  assert.equal(provider.identifier_source, "provider");
  assert.equal(provider.identifier_fetched_at, "2026-08-28T12:00:00.000Z");
  assert.equal(provider.state, "planned", "no board_id means no link, however confirmed the identifier is");
});

await checkAsync("a failed fetch PRESERVES the recorded identifier", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const before = readFileSync(hermesRegistryPath, "utf8");
  const report = await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    all: true,
    apply: true,
    fetchBoards: async () => {
      throw new Error("plane.delo.sh unreachable");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.changes.hermes.length, 0, "an outage must never rewrite identifiers");
  assert.ok(report.resolutions.some((entry) => entry.status === "error" && /preserved/.test(entry.detail)));
  assert.match(readFileSync(hermesRegistryPath, "utf8"), /identifier: HOLPM/, "the old value is still there");
  // The abandoned agent is still removed: its removal is a user directive, not
  // a consequence of what Plane says.
  assert.notEqual(readFileSync(hermesRegistryPath, "utf8"), before);
});

await checkAsync("a board Plane no longer has PRESERVES the recorded identifier", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const report = await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    all: true,
    apply: true,
    fetchBoards: async () => new Map(),
  });
  assert.equal(report.changes.hermes.length, 0);
  const holocene = report.resolutions.find((entry) => entry.agentId === "holocene-pm");
  assert.equal(holocene.status, "board-missing");
  assert.match(holocene.detail, /preserved/);
  assert.match(readFileSync(hermesRegistryPath, "utf8"), /identifier: HOLPM/);
});

await checkAsync("a single target leaves every other agent alone", async () => {
  const { hermesRegistryPath, registryPath } = scenario();
  const report = await reconcileProjectIdentity({
    hermesRegistryPath,
    registryPath,
    target: "ssbnk",
    apply: true,
    fetchBoards: async (workspace) => planeBoards(workspace),
  });
  assert.equal(report.checked, 1);
  const parsed = YAML.parse(readFileSync(hermesRegistryPath, "utf8"));
  assert.equal(parsed.agents["ssbnk-pm"].plane.identifier, "SSBNK");
  assert.equal(parsed.agents["holocene-pm"].plane.identifier, "HOLPM", "out of scope, untouched");
  assert.equal(Object.hasOwn(parsed.agents, "coachingagentframework-pm"), true, "out of scope, not deleted");
});

check("the fleet reader survives agents with no board at all", () => {
  const { hermesRegistryPath } = scenario();
  const agents = readHermesAgentBoards(hermesRegistryPath);
  const condaleeza = agents.find((agent) => agent.agentId === "condaleeza");
  assert.equal(condaleeza.boardId, "");
  assert.equal(condaleeza.identifier, "");
});

check("the surgical writer refuses an edit that would change anything else", () => {
  const { hermesRegistryPath } = scenario();
  const before = readFileSync(hermesRegistryPath, "utf8");
  // Targeting an agent that does not exist would ADD one; the guard must catch
  // the divergence rather than write a registry nobody asked for.
  assert.throws(
    () => applyHermesIdentifiers(hermesRegistryPath, new Map([["ghost-pm", "GHOST"]]), []),
    /changed more than the targeted identifiers|agent count changed/,
  );
  assert.equal(readFileSync(hermesRegistryPath, "utf8"), before, "a refused edit must not reach disk");
});

check("the abandoned agents are named, not modelled as triage", () => {
  assert.deepEqual([...DEAD_AGENT_IDS], ["coachingagentframework-pm", "tonnybox-pm"]);
});

console.log("");
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`project identity regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("project identity regressions passed");
