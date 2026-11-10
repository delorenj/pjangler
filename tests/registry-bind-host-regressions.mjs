import "./helpers/hermetic-suite.mjs";
// The project registry service binds loopback unless PJ_REGISTRY_HOST says
// otherwise. A peer that serves its registry to other hosts on purpose (a Mac
// whose clients reach :8764 over its LAN/tailnet) sets PJ_REGISTRY_HOST=0.0.0.0
// in its service definition instead of patching the shipped bundle; every host
// that sets nothing keeps the loopback-only default it always had.
//
// src/project/registryService.ts is bundled with esbuild into a build dir inside
// the repo (so --packages=external still resolves the repo's node_modules, the
// same trick as tests/pjan-36-regressions.mjs) and driven in-process with a stub
// pool: binding a socket needs no database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const buildDir = mkdtempSync(join(root, ".registry-bind-host-build-"));
process.on("exit", () => rmSync(buildDir, { recursive: true, force: true }));
const bundle = join(buildDir, "registry-service.mjs");
buildSync({
  entryPoints: [join(root, "src", "project", "registryService.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const {
  DEFAULT_REGISTRY_HOST,
  createRegistryService,
  registryBindHost,
  registryListeningMessage,
  registryLocalUrl,
} = await import(pathToFileURL(bundle).href);

// Other suites detect readiness by matching this in the service's stdout
// (tests/pjan-80-registry-regressions.mjs); a wildcard bind must not break it.
const READINESS = /http:\/\/127\.0\.0\.1:\d+/;

/** Everything initialize() and GET /health ask of a pool, and nothing more. */
function stubPool() {
  const client = { async query() { return { rows: [] }; }, release() {} };
  return {
    async connect() { return client; },
    async query() { return { rows: [{ "?column?": 1 }] }; },
    async end() { throw new Error("an injected pool belongs to the caller; the service must not end it"); },
  };
}

async function withService(options, check) {
  const service = await createRegistryService({ pool: stubPool(), port: 0, ...options });
  try {
    await check(service);
  } finally {
    await service.close();
  }
}

async function health(service) {
  const response = await fetch(`${service.url}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

// 1. Resolving the bind address from an environment.
assert.equal(DEFAULT_REGISTRY_HOST, "127.0.0.1", "the default bind stays loopback");
assert.equal(registryBindHost({}), "127.0.0.1", "nothing set keeps the loopback default");
assert.equal(registryBindHost({ PJ_REGISTRY_HOST: "" }), "127.0.0.1", "an empty value is unset, never a wildcard");
assert.equal(registryBindHost({ PJ_REGISTRY_HOST: "  \t" }), "127.0.0.1", "a blank value is unset");
assert.equal(registryBindHost({ PJ_REGISTRY_HOST: " 0.0.0.0 " }), "0.0.0.0", "the operator's value is used, trimmed");
assert.equal(registryBindHost({ PJ_REGISTRY_HOST: "100.64.0.7" }), "100.64.0.7", "one interface address is allowed");
console.log("ok   registryBindHost: loopback by default, PJ_REGISTRY_HOST when set");

// 2. The URL a local client uses. A wildcard bind is reached over loopback; a
//    specific address is reached at that address (127.0.0.1 would not answer).
assert.equal(registryLocalUrl("127.0.0.1", 8764), "http://127.0.0.1:8764");
assert.equal(registryLocalUrl("0.0.0.0", 8764), "http://127.0.0.1:8764");
assert.equal(registryLocalUrl("::", 8764), "http://127.0.0.1:8764");
assert.equal(registryLocalUrl("100.64.0.7", 8764), "http://100.64.0.7:8764");
assert.equal(registryLocalUrl("::1", 8764), "http://[::1]:8764", "an IPv6 literal is bracketed");
console.log("ok   registryLocalUrl: wildcard binds resolve to loopback, specific binds to themselves");

// 3. The startup line: unchanged for the default, names a wildcard bind after the URL.
const loopbackLine = registryListeningMessage({ url: "http://127.0.0.1:8764", host: "127.0.0.1" });
assert.equal(loopbackLine, "PJangler project registry listening at http://127.0.0.1:8764", "the default line is byte-identical to before");
const wildcardLine = registryListeningMessage({ url: "http://127.0.0.1:8764", host: "0.0.0.0" });
assert.equal(wildcardLine, "PJangler project registry listening at http://127.0.0.1:8764 (bind 0.0.0.0)");
assert.match(wildcardLine, READINESS, "readiness probes still find the URL in a wildcard line");
console.log("ok   registryListeningMessage: default unchanged, wildcard bind named");

// 4. The service itself, through the environment a service manager sets.
//    The hermetic preamble deleted every PJ_* name, so this starts unset.
assert.equal(Object.hasOwn(process.env, "PJ_REGISTRY_HOST"), false, "the suite must start with PJ_REGISTRY_HOST unset");
await withService({}, async (service) => {
  assert.equal(service.server.address().address, "127.0.0.1", "unset binds loopback only");
  assert.equal(service.host, "127.0.0.1");
  assert.equal(service.url, `http://127.0.0.1:${service.server.address().port}`);
  assert.equal((await health(service)).ok, true);
});
process.env.PJ_REGISTRY_HOST = "0.0.0.0";
try {
  await withService({}, async (service) => {
    assert.equal(service.server.address().address, "0.0.0.0", "PJ_REGISTRY_HOST=0.0.0.0 binds every IPv4 interface");
    assert.equal(service.host, "0.0.0.0");
    assert.equal(service.url, `http://127.0.0.1:${service.server.address().port}`, "the local URL stays loopback");
    assert.match(registryListeningMessage(service), / \(bind 0\.0\.0\.0\)$/);
    assert.equal((await health(service)).ok, true, "a wildcard-bound service answers on loopback");
  });
  await withService({ host: "127.0.0.1" }, async (service) => {
    assert.equal(service.server.address().address, "127.0.0.1", "an explicit host option wins over the environment");
  });
} finally {
  delete process.env.PJ_REGISTRY_HOST;
}
process.env.PJ_REGISTRY_HOST = "   ";
try {
  await withService({}, async (service) => {
    assert.equal(service.server.address().address, "127.0.0.1", "a blank PJ_REGISTRY_HOST is the loopback default");
  });
} finally {
  delete process.env.PJ_REGISTRY_HOST;
}
console.log("ok   createRegistryService: binds loopback by default and PJ_REGISTRY_HOST when set");

console.log("registry bind-host regressions passed");
