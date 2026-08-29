// `pj init` is the designated ingress, and an ingress that under-delivers in
// silence is the defect this suite holds shut.
//
// What was reported: "running `pj init` seemed to work without incident, but it
// never created a board and the board_id was never set." Two causes stacked.
//
//   1. Board provisioning was gated on `--live`, and a disabled action was then
//      filtered out of the selected plan entirely — so a plain `pj init` printed
//      not one word about the board it did not create, and exited 0. Eleven of
//      twenty-four registry records were built that way.
//   2. Even WITH `--live`, pjangler's precondition asked only for
//      `PLANE_API_KEY`, while `providers/plane.sh` also accepts
//      `PLANE_<WORKSPACE>_API_KEY` from the environment or ~/.hermes/fleet.env.
//      On a host whose only credential is workspace-scoped, pjangler declared
//      "no credentials" and skipped a call that would have succeeded.
//
// The rule now: board creation is the default, `--skip-board` is the only way
// out, and an init that ends without a provider-confirmed board says so and
// exits non-zero.
//
// No network: the provider is a stub adapter for init, and a local HTTP server
// standing in for Plane's REST API for `pj project link`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const BOARD_ID = "11111111-2222-3333-4444-555555555555";
const SECRET = "stub-plane-key-never-logged";
const temporary = [];
let failures = 0;

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message?.split("\n")[0] ?? error}`);
  }
}

async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message?.split("\n")[0] ?? error}`);
  }
}

function makeDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pj-init-board-${name}-`));
  temporary.push(dir);
  return dir;
}

const workspace = makeDir("workspace");
const home = join(workspace, "home");
mkdirSync(home, { recursive: true });

/**
 * Every credential source pjangler consults, pointed somewhere empty.
 *
 * The legacy `~/.config/zshyzsh/secrets.zsh` fallback is a real source on this
 * host, so XDG_CONFIG_HOME has to move too or these fixtures reach production
 * Plane — which is exactly what happened the first time this change was run.
 */
const NO_CREDENTIALS = {
  PLANE_API_KEY: "",
  PLANE_DEFAULT_API_KEY: "",
  PLANE_33GOD_API_KEY: "",
  TRELLO_KEY: "",
  TRELLO_TOKEN: "",
  HERMES_FLEET_ENV: join(home, ".hermes", "fleet.env"),
  XDG_CONFIG_HOME: join(home, ".config"),
};

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, ...NO_CREDENTIALS, GIT_CEILING_DIRECTORIES: workspace, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** A `create_board` adapter that answers like Plane without being Plane. */
function stubAdapter() {
  const dir = makeDir("adapters");
  const path = join(dir, "plane.sh");
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
[ "\${1:-}" = create_board ] || { echo "unexpected op: \${1:-}" >&2; exit 2; }
[ -n "\${PLANE_API_KEY:-}\${PLANE_33GOD_API_KEY:-}" ] || { echo "no credential reached the adapter" >&2; exit 3; }
printf '{"board_id":"${BOARD_ID}","identifier":"STUB","board_url":"https://plane.invalid/b"}\\n'
`,
  );
  chmodSync(path, 0o755);
  return dir;
}

/** A git-rooted target, so init takes the fast sync path instead of copier. */
function target(name) {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0, "git init");
  return dir;
}

function registryFor(name) {
  const path = join(workspace, `${name}-registry.yaml`);
  writeFileSync(path, "schema_version: 1\nprojects: {}\n");
  return path;
}

function record(registryPath, slug) {
  return YAML.parse(readFileSync(registryPath, "utf8")).projects?.[slug];
}

const adapters = stubAdapter();

console.log("pj init board ingress");
try {
  check("a plain `pj init` creates the board — no --live required", () => {
    const registry = registryFor("created");
    const dir = target("Created Board");
    const run = cli(["init", "Created Board", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"], {
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
      PLANE_API_KEY: SECRET,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Board linked/);
    const provider = record(registry, "created-board").ticket_provider;
    assert.equal(provider.board_id, BOARD_ID);
    // The identifier is the PROVIDER's ("STUB"), not the "CREA" we proposed.
    assert.equal(provider.identifier, "STUB");
    assert.equal(provider.identifier_source, "provider");
    assert.ok(provider.board_confirmed_at, "a linked board must carry the instant the provider confirmed it");
    assert.equal(provider.state, "linked");
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(SECRET), "a credential must never reach the output");
  });

  check("a workspace-scoped credential in ~/.hermes/fleet.env is accepted", () => {
    // The precondition used to demand PLANE_API_KEY exactly, so this host —
    // whose only Plane credential is PLANE_33GOD_API_KEY — always skipped.
    const registry = registryFor("wsscoped");
    const dir = target("Ws Scoped");
    const fleetEnv = join(workspace, "fleet.env");
    writeFileSync(fleetEnv, `# fleet\nexport PLANE_33GOD_API_KEY="${SECRET}"\n`);
    const run = cli(["init", "Ws Scoped", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"], {
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
      HERMES_FLEET_ENV: fleetEnv,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(record(registry, "ws-scoped").ticket_provider.board_id, BOARD_ID);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(SECRET));
  });

  check("no board and no --skip-board is a LOUD failure, not a silent success", () => {
    const registry = registryFor("nocreds");
    const dir = target("No Creds");
    const run = cli(["init", "No Creds", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"], {
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
    });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, `an unconfirmed board must fail the ingress:\n${output}`);
    assert.match(output, /No ticket board/);
    // Actionable, not just angry.
    assert.match(output, /pj project link no-creds <board-id> --apply/);
    assert.match(output, /--skip-board/);
    // The local half of the transaction still lands, so the operator can repair
    // it rather than starting over.
    assert.equal(record(registry, "no-creds").ticket_provider.state, "planned");
    assert.equal(existsSync(join(dir, ".project.json")), true);
  });

  check("--skip-board is the one quiet exit, and it is still loud in the output", () => {
    const registry = registryFor("skipped");
    const dir = target("Skipped Board");
    const run = cli(["init", "Skipped Board", "--target-dir", dir, "--registry", registry, "--skip-board", "--apply", "-y", "--no-tui"], {
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
      PLANE_API_KEY: SECRET,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /No ticket board \(--skip-board\)/);
    assert.match(run.stdout, /skipPlane=true/);
    assert.equal(record(registry, "skipped-board").ticket_provider.board_id, "");
  });

  check("the JSON wire carries the same verdict as the exit code", () => {
    const registry = registryFor("json");
    const dir = target("Json Board");
    const run = cli(["init", "Json Board", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui", "--json"], {
      PJ_TICKET_PROVIDER_ADAPTERS: adapters,
    });
    assert.equal(run.status, 1, run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false, "a machine caller must see the same failure a human does");
    assert.equal(payload.board.confirmed, false);
    assert.equal(payload.board.intended, true);
  });

  // -------------------------------------------------------------------------
  // pj project remove
  // -------------------------------------------------------------------------

  const removeRegistry = registryFor("remove");
  check("project remove refuses an unknown slug", () => {
    const dir = target("Removable");
    const created = cli(["init", "Removable", "--target-dir", dir, "--registry", removeRegistry, "--skip-board", "--apply", "-y", "--no-tui"]);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    const run = cli(["project", "remove", "not-a-project", "--registry", removeRegistry]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Project not found in registry: not-a-project/);
  });

  check("project remove is a dry run by default and says what it would drop", () => {
    const run = cli(["project", "remove", "removable", "--registry", removeRegistry]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would remove/);
    assert.match(run.stdout, /removable/);
    assert.match(run.stdout, /left on disk/);
    assert.ok(record(removeRegistry, "removable"), "a dry run must not write");
  });

  check("project remove --apply drops the record and leaves the repo alone", () => {
    const run = cli(["project", "remove", "removable", "--registry", removeRegistry, "--apply"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Removed/);
    assert.equal(record(removeRegistry, "removable"), undefined);
    assert.equal(existsSync(join(workspace, "Removable", ".project.json")), true, "the repo is not the registry's to delete");
  });

  // -------------------------------------------------------------------------
  // pj project link — identity is READ BACK, never minted
  // -------------------------------------------------------------------------

  const linkRegistry = registryFor("link");
  const linkDir = target("Linkable");

  // Plane stands in as a separate PROCESS on purpose: every CLI call below is
  // spawnSync, which blocks this process's event loop, so an in-process server
  // could never answer.
  const serverScript = join(workspace, "plane-stub.mjs");
  writeFileSync(
    serverScript,
    `import { createServer } from "node:http";
const boards = [{ id: ${JSON.stringify(BOARD_ID)}, identifier: "LIVE", name: "Linkable Board" }];
const server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/api/v1/workspaces/33god/projects/")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: boards, next_page_results: false }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" }).end("{}");
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
  );
  const stub = spawn(process.execPath, [serverScript], { stdio: ["ignore", "pipe", "inherit"] });
  const planePort = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the Plane stub never reported a port")), 10_000);
    stub.stdout.once("data", (chunk) => { clearTimeout(timer); done(String(chunk).trim()); });
    stub.once("error", fail);
  });
  const planeBase = `http://127.0.0.1:${planePort}`;

  try {
    const created = cli(["init", "Linkable", "--target-dir", linkDir, "--registry", linkRegistry, "--skip-board", "--apply", "-y", "--no-tui"]);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);

    check("project link refuses an unknown slug before any provider call", () => {
      const run = cli(["project", "link", "nope", BOARD_ID, "--registry", linkRegistry], { PLANE_BASE: planeBase, PLANE_API_KEY: SECRET });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Project not found in registry: nope/);
    });

    check("project link refuses a board the provider does not have", () => {
      const run = cli(["project", "link", "linkable", "00000000-0000-0000-0000-000000000000", "--registry", linkRegistry], {
        PLANE_BASE: planeBase,
        PLANE_API_KEY: SECRET,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /has no board 00000000/);
      assert.match(run.stderr, /never invents a binding/);
    });

    check("project link is a dry run by default", () => {
      const run = cli(["project", "link", "linkable", BOARD_ID, "--registry", linkRegistry], { PLANE_BASE: planeBase, PLANE_API_KEY: SECRET });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Would link/);
      assert.equal(record(linkRegistry, "linkable").ticket_provider.board_id, "", "a dry run must not write");
    });

    check("project link --apply stamps provider provenance in both stores", () => {
      const run = cli(["project", "link", "linkable", BOARD_ID, "--registry", linkRegistry, "--apply"], {
        PLANE_BASE: planeBase,
        PLANE_API_KEY: SECRET,
      });
      assert.equal(run.status, 0, run.stderr);
      const provider = record(linkRegistry, "linkable").ticket_provider;
      assert.equal(provider.board_id, BOARD_ID);
      // Plane assigns the key, so it is read back and labelled as the
      // provider's — never the "LINK" pjangler proposed.
      assert.equal(provider.identifier, "LIVE");
      assert.equal(provider.identifier_source, "provider");
      assert.ok(provider.identifier_fetched_at);
      assert.ok(provider.board_confirmed_at);
      assert.equal(provider.state, "linked");
      // The adapters read the repo manifest, so it cannot be left behind.
      const manifest = JSON.parse(readFileSync(join(linkDir, ".project.json"), "utf8")).ticket_provider;
      assert.equal(manifest.board_id, BOARD_ID);
      assert.equal(manifest.identifier, "LIVE");
      assert.equal(manifest.identifier_source, "provider");
      assert.ok(manifest.board_confirmed_at);
      assert.equal(manifest.state, "linked");
    });
  } finally {
    stub.kill();
  }

  // Trello has no reachable base-URL seam, so this half runs in-process against
  // the module boundary with fetch injected — the same seam
  // project-identity-regressions uses.
  const bundleOut = join(makeDir("bundle"), "identity.cjs");
  buildSync({
    entryPoints: [join(ROOT, "src", "project", "identity.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundleOut,
    logLevel: "silent",
  });
  const { linkProjectBoard } = createRequire(import.meta.url)(bundleOut);

  await checkAsync("a Trello link rests on board_confirmed_at, and its key stays a proposal", async () => {
    const registry = registryFor("trello");
    const repo = join(workspace, "trello-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      registry,
      YAML.stringify({
        schema_version: 1,
        projects: {
          trelloish: {
            name: "Trelloish",
            slug: "trelloish",
            repo_path: repo,
            description: "",
            status: "active",
            source_artifacts: [],
            template: { commonproject: { enabled: true, primary_language: "python" } },
            ticket_provider: { type: "trello", workspace: "", identifier: "TREL", identifier_source: "proposed", board_id: "", state: "planned" },
            agents: {},
            automation: { reconcile: { enabled: false, grace_hours: 0, auto_review: true } },
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }, { lineWidth: 0 }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ id: "abc123", name: "A Trello Board", closed: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    try {
      const result = await linkProjectBoard({
        slug: "trelloish",
        boardId: "abc123",
        apply: true,
        registryPath: registry,
        env: { ...process.env, TRELLO_API_KEY: "k", TRELLO_TOKEN: "t" },
      });
      assert.equal(result.state, "linked");
      assert.ok(result.boardConfirmedAt, "any provider can confirm a board exists, and a link rests on that");
      // Trello assigns no key. Claiming otherwise is the shape the registry
      // contract forbids, so the proposal stands and that is not a defect.
      assert.equal(result.identifierSource, "proposed");
      assert.equal(result.identifier, "TREL");
      const provider = record(registry, "trelloish").ticket_provider;
      assert.equal(provider.board_id, "abc123");
      assert.equal(provider.identifier_source, "proposed");
      assert.equal("identifier_fetched_at" in provider, false, "a proposal has no fetch instant");
      assert.ok(provider.board_confirmed_at);
      assert.equal(provider.state, "linked");
    } finally {
      globalThis.fetch = original;
    }
  });

  await checkAsync("a Trello link refuses an archived board", async () => {
    const registry = registryFor("trello-archived");
    writeFileSync(registry, readFileSync(join(workspace, "trello-registry.yaml"), "utf8"));
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ id: "abc123", name: "Archived", closed: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    try {
      await assert.rejects(
        () => linkProjectBoard({
          slug: "trelloish",
          boardId: "abc123",
          apply: true,
          registryPath: registry,
          env: { ...process.env, TRELLO_API_KEY: "k", TRELLO_TOKEN: "t" },
        }),
        /archived/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("pj init board ingress regressions passed");
} finally {
  for (const dir of temporary.reverse()) rmSync(dir, { recursive: true, force: true });
}
