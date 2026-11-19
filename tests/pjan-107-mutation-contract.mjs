import "./helpers/hermetic-suite.mjs";
// PJAN-107: run the Krebs-owned Plane adapter, not a reimplementation, against
// an isolated board fixture. The recording curl is the only network boundary.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { findTpAdapters, tpAdaptersFailure } from "./helpers/tp-adapters.mjs";

const root = resolve(import.meta.dirname, "..");
const { found, candidates } = findTpAdapters({ startDir: root });
assert.ok(found, tpAdaptersFailure(candidates));
const scratch = mkdtempSync(join(tmpdir(), "pjan-107-mutation-"));
const adapter = join(scratch, ".tp", "adapters", "plane.sh");
const bin = join(scratch, "bin");
const log = join(scratch, "requests.jsonl");
const state = join(scratch, "state");
const base = "https://fixture.invalid/api/v1/workspaces/fixture";
const statesUrl = `${base}/projects/board/states/`;
const issueUrl = `${base}/projects/board/issues/issue-107/`;

try {
  mkdirSync(dirname(adapter), { recursive: true });
  mkdirSync(bin);
  writeFileSync(adapter, readFileSync(join(found, "plane.sh"), "utf8"));
  chmodSync(adapter, 0o755);
  writeFileSync(join(scratch, ".project.json"), JSON.stringify({
    ticket_provider: { type: "plane", workspace: "fixture", board_id: "board" },
  }));
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
method = args[args.index("-X") + 1]
url = args[args.index("-X") + 2]
body = args[args.index("-d") + 1] if "-d" in args else ""
out = pathlib.Path(args[args.index("-o") + 1])
headers = pathlib.Path(args[args.index("-D") + 1])
mode = os.environ["PJAN107_MODE"]
with open(os.environ["PJAN107_LOG"], "a") as handle:
    handle.write(json.dumps({"method": method, "url": url, "body": body}) + "\\n")
status, exit_code = 200, 0
if url.endswith("/states/") and method == "GET":
    payload = {"results": [{"id": "done", "name": "Done", "group": "completed"}]}
elif url.endswith("/issues/issue-107/") and method == "PATCH":
    if mode == "unapplied":
        status = 503
    elif mode == "lost_response":
        pathlib.Path(os.environ["PJAN107_STATE"]).write_text("done")
        status, exit_code = 0, 28
    elif mode == "divergent":
        pathlib.Path(os.environ["PJAN107_STATE"]).write_text("other")
    else:
        pathlib.Path(os.environ["PJAN107_STATE"]).write_text("done")
    payload = {"id": "issue-107", "sequence_id": 107}
elif url.endswith("/issues/issue-107/") and method == "GET":
    if mode == "unavailable":
        status = 503
    payload = {"id": "issue-107", "sequence_id": 107,
               "state": pathlib.Path(os.environ["PJAN107_STATE"]).read_text()}
    if mode == "wrong_issue": payload["id"] = "some-other-issue"
    if mode == "missing_state": payload.pop("state")
    if mode == "missing_sequence": payload.pop("sequence_id")
    if mode == "malformed": payload = "{not-json"
else:
    sys.stderr.write("curl fixture: unexpected request %s %s\\n" % (method, url))
    sys.exit(22)
out.write_text(payload if isinstance(payload, str) else json.dumps(payload))
headers.write_text("HTTP/1.1 %s\\r\\n\\r\\n" % status)
sys.stdout.write(str(status))
sys.exit(exit_code)
`);
  chmodSync(join(bin, "curl"), 0o755);

  const cases = [
    { mode: "normal", ok: true },
    { mode: "unapplied", ok: false, error: /ambiguous|did not match/i },
    { mode: "lost_response", ok: true },
    { mode: "divergent", ok: false, error: /concurrent divergence|did not match/i },
    { mode: "unavailable", ok: false, error: /read-back failed/i },
    { mode: "wrong_issue", ok: false, error: /read-back.*verif/i },
    { mode: "malformed", ok: false, error: /read-back.*verif/i },
    { mode: "missing_state", ok: false, error: /read-back.*verif/i },
    { mode: "missing_sequence", ok: false, error: /read-back.*verif/i },
  ];
  for (const { mode, ok, error } of cases) {
    rmSync(log, { force: true });
    writeFileSync(state, "old");
    const home = join(scratch, `home-${mode}`);
    mkdirSync(home);
    const run = spawnSync("sh", [adapter, "transition", "issue-107", "completed"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 15_000,
      env: hermeticEnv({
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        HERMES_FLEET_ENV: join(home, "missing.env"),
        PLANE_API_KEY: "fixture-only-key",
        PLANE_BASE: "https://fixture.invalid",
        PLANE_READ_MAX_ATTEMPTS: "1",
        // Legacy adapter versions used these knobs to resend the PATCH.
        PLANE_MUTATION_MAX_ATTEMPTS: "3",
        PLANE_MUTATION_RETRY_DELAY: "0",
        PJAN107_MODE: mode,
        PJAN107_LOG: log,
        PJAN107_STATE: state,
      }),
    });
    assert.equal(run.error, undefined, `${mode}: adapter process error ${run.error}`);
    assert.ok(existsSync(log), `${mode}: adapter made no requests: ${run.stderr}`);
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ["GET", statesUrl], ["PATCH", issueUrl], ["GET", issueUrl],
    ], `${mode}: exactly one PATCH and one same-issue read-back, even with legacy retry settings`);
    assert.deepEqual(JSON.parse(requests[1].body), { state: "done" }, `${mode}: intended mutation`);
    const expectedState = mode === "unapplied" ? "old" : mode === "divergent" ? "other" : "done";
    assert.equal(readFileSync(state, "utf8"), expectedState, `${mode}: fixture outcome`);
    if (ok) {
      assert.equal(run.status, 0, `${mode}: ${run.stderr}`);
      assert.equal(run.stdout.trim(), "ok 107", `${mode}: verified success`);
    } else {
      assert.notEqual(run.status, 0, `${mode}: must fail`);
      assert.doesNotMatch(run.stdout, /\bok\b/, `${mode}: must not report success`);
      assert.match(run.stderr, error, `${mode}: explicit failure reason`);
    }
  }
  console.log(`PJAN-107 mutation contract: ${cases.length} adapter scenarios passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
