import "./helpers/hermetic-suite.mjs";
// PJAN-198 (finding 3, acceptance 3): the declared TLS trust anchors must be
// PROVEN to reach the real installer's child process — with planted,
// non-secret sentinel values, read back from inside that child — through the
// complete chain:
//
//   this suite -> the real launcher (tests/pjan-180-surface-oracle.mjs, whose
//     preamble keeps exactly the NETWORK_CONTRACTS grants)
//   -> the bundled oracle child (forwarded via the launcher's SUITE_GRANTS)
//   -> the installer child env (the child's installerEnv(), exercised by its
//     --probe-env mode instead of the 30-minute network run)
//
// The sentinels must arrive; an ungranted name and any proxy variable must
// not (the PJAN-196 TLS/proxy decision admits no proxy anywhere).
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");

// Deliberately implausible paths: non-secret, and any real TLS use of them
// would fail loudly rather than silently trusting something.
const SSL_SENTINEL = "/pjan-198/sentinel-ssl-cert-file-not-a-secret.pem";
const EXTRA_SENTINEL = "/pjan-198/sentinel-node-extra-ca-not-a-secret.pem";

const run = spawnSync(process.execPath, [join(root, "tests", "pjan-180-surface-oracle.mjs"), "--probe-env"], {
  cwd: root,
  encoding: "utf8",
  timeout: 300_000,
  env: hermeticEnv({
    SSL_CERT_FILE: SSL_SENTINEL,
    NODE_EXTRA_CA_CERTS: EXTRA_SENTINEL,
    HTTP_PROXY: "http://pjan-198-sentinel-proxy.invalid:3128",
    PJAN198_UNGRANTED: "pjan-198-ungranted-sentinel",
  }),
});
assert.equal(run.status, 0, `the probe-mode oracle must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
const line = run.stdout.split("\n").find((entry) => entry.startsWith("PROBE_ENV "));
assert.ok(line, `the probe must report what the installer child receives\nstdout:\n${run.stdout}`);
const received = JSON.parse(line.slice("PROBE_ENV ".length));

assert.equal(received.SSL_CERT_FILE, SSL_SENTINEL, "the SSL_CERT_FILE sentinel must reach the installer child");
assert.equal(received.NODE_EXTRA_CA_CERTS, EXTRA_SENTINEL, "the NODE_EXTRA_CA_CERTS sentinel must reach the installer child");
assert.equal(received.HTTP_PROXY, null, "no proxy variable may reach the installer child");
assert.equal(received.PJAN198_UNGRANTED, null, "an ungranted name must not reach the installer child");

console.log("PASS TLS sentinels reach the installer child through the full launcher/bundle/installerEnv chain");
console.log("PASS ungranted names and proxy variables never reach the installer child");
console.log("PJAN-198 installer env sentinel: 2 groups passed.");
