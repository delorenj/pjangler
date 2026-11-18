// The crank arbiter (crank.lua, a Redis Functions library) for tests that need a real Redis behind
// pjangler's crank store: every crank write is FCALL crank_apply and every on/off + interval verdict
// is FCALL_RO crank_resolve, so a throwaway redis-server without the library cannot serve them.
//
// tests/data/crank-arbiter/ holds a COPY of the two source files, composed here exactly as
// bloodbank's core/statekit.py Library("crank", path).code() does (`#!lua name=crank`, the statekit
// prelude, the body, a `crank_version` function carrying the sha of prelude+body), so the suite
// runs where ~/.agents and the bloodbank checkout do not exist (CI). tests/crank-arbiter-drift.mjs
// proves the copy still equals the operator's installed arbiter and says how to refresh it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "data", "crank-arbiter");

/** The FUNCTION LOAD code for a crank.lua body and statekit prelude (statekit.Library.code()). */
export function composeArbiter(prelude, body, name = "crank") {
  const src = Buffer.concat([Buffer.from(prelude), Buffer.from("\n"), Buffer.from(body)]);
  const sha = createHash("sha1").update(src).digest("hex");
  return `#!lua name=${name}\n${src.toString("utf8")}\nredis.register_function{function_name='${name}_version', callback=function() return '${sha}' end, flags={'no-writes'}}\n`;
}

/** The arbiter this repo's tests run against (the vendored copy). */
export function vendoredArbiterCode() {
  return composeArbiter(readFileSync(join(DIR, "statekit_prelude.lua")), readFileSync(join(DIR, "crank.lua")));
}

export const VENDORED_ARBITER_DIR = DIR;
