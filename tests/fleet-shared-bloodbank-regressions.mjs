import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

const copier = read("src/commands/hermes/RunCopierTemplate.ts");
const summary = read("src/commands/hermes/PrintHermesSummary.ts");
const parity = read("src/parity/index.ts");

assert.match(copier, /SKIP_BLOODBANK:\s*"1"/);
assert.doesNotMatch(summary, /consumer\.service/);
assert.doesNotMatch(parity, /consumer_unit/);
assert.doesNotMatch(parity, /bloodbank-consumer\.py/);
assert.match(parity, /gateway_scope:\s*fleet/);
assert.match(parity, /target_agent_id:/);

console.log("fleet-shared Bloodbank provisioning regressions: ok");
