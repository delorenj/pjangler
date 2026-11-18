import { operatorHome } from "./helpers/hermetic-suite.mjs";
// tests/data/crank-arbiter/ is a COPY of the operator's crank arbiter (crank.lua + statekit's prelude),
// so the crank suites run against a real arbiter where ~/.agents and the bloodbank checkout do not
// exist. A copy can rot: this suite proves it is still byte-identical to the installed source, and
// when it is not, says how to refresh it. Skipped (loudly) on a machine without the sources (CI).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDORED_ARBITER_DIR, composeArbiter } from "./helpers/crank-arbiter.mjs";

const home = operatorHome();
const sources = {
  "crank.lua": join(home, ".agents", "tools", "jev-clairic", "bin", "crank.lua"),
  "statekit_prelude.lua": join(home, "code", "33GOD", "bloodbank", "services", "agent-hooks", "core", "statekit_prelude.lua"),
};

if (!Object.values(sources).every((path) => existsSync(path))) {
  console.log("  (the installed arbiter sources are not on this machine, skipped)");
} else {
  console.log("vendored arbiter: the composed library equals the installed one");
  const installed = composeArbiter(readFileSync(sources["statekit_prelude.lua"]), readFileSync(sources["crank.lua"]));
  const vendored = composeArbiter(readFileSync(join(VENDORED_ARBITER_DIR, "statekit_prelude.lua")), readFileSync(join(VENDORED_ARBITER_DIR, "crank.lua")));
  assert.equal(
    vendored,
    installed,
    `tests/data/crank-arbiter is stale. Refresh it: cp ${sources["crank.lua"]} ${join(VENDORED_ARBITER_DIR, "crank.lua")} && cp ${sources["statekit_prelude.lua"]} ${join(VENDORED_ARBITER_DIR, "statekit_prelude.lua")}`,
  );
}
console.log("\ncrank arbiter drift: ok");
