// PG-backed RegistryStore regression. Bootstraps an ISOLATED scratch database
// (base schema + the pjangler migration), runs the bun round-trip harness, and
// tears the scratch db down. SKIPS cleanly when Postgres or bun is unavailable
// so the default suite stays green in environments without a DB. Set
// PJANGLER_REQUIRE_DISPOSABLE_POSTGRES=1 for a release gate that fails instead
// of skipping when a required disposable Postgres capability is unavailable.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DB = `pjangler_registry_scratch_${process.pid}`;
const CHILD_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const CHILD_MAX_BUFFER = 1024 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_PATH_ENTRIES = 256;
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST || "localhost",
  PGPORT: process.env.PGPORT || "5432",
  PGUSER: process.env.PGUSER || "delorenj",
  PGPASSWORD: process.env.PGPASSWORD || "",
  PGDATABASE: DB,
};
const requireDisposablePostgres =
  process.env.PJANGLER_REQUIRE_DISPOSABLE_POSTGRES === "1";

const executable = (bin, searchPath = env.PATH || "") => {
  if (!bin || bin.includes("\0") || bin.includes("/")) {
    if (!isAbsolute(bin || "")) return null;
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  if (Buffer.byteLength(searchPath) > MAX_PATH_BYTES) return null;
  const entries = searchPath.split(delimiter);
  if (entries.length > MAX_PATH_ENTRIES) return null;
  for (const entry of entries) {
    if (!entry) continue;
    const candidate = join(entry, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning the finite PATH.
    }
  }
  return null;
};

const run = (cmd, args, opts = {}) => {
  const {
    timeoutMs = CHILD_TIMEOUT_MS,
    maxBuffer = CHILD_MAX_BUFFER,
    timeout: _ignoredTimeout,
    ...spawnOptions
  } = opts;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0
  ) {
    throw new Error("invalid bounded child limits");
  }
  return spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    ...spawnOptions,
    timeout: timeoutMs,
    maxBuffer,
  });
};

const outcome = (result) => {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if (result.error?.code === "ENOBUFS") return "output_limit";
  if (result.error) return "spawn_error";
  if (result.signal) return `signal_${result.signal}`;
  return `exit_${result.status}`;
};

const requireSuccess = (label, result) => {
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`${label} failed (${outcome(result)})`);
  }
  return result;
};

const psql = (psqlPath, db, q, timeoutMs = CHILD_TIMEOUT_MS) =>
  run(
    psqlPath,
    [
      "-h",
      env.PGHOST,
      "-p",
      env.PGPORT,
      "-U",
      env.PGUSER,
      "-d",
      db,
      "-tAc",
      q,
    ],
    { timeoutMs },
  );

const skip = (reason) => {
  if (requireDisposablePostgres) {
    console.error(
      `FAIL pg-registry-regressions disposable_postgres_required reason=${reason}`,
    );
    process.exit(1);
  }
  console.log(`SKIP pg-registry-regressions reason=${reason}`);
  process.exit(0);
};

const databaseUrl = (db) => {
  const url = new URL("postgres://localhost");
  url.hostname = env.PGHOST;
  url.port = env.PGPORT;
  url.username = env.PGUSER;
  url.password = env.PGPASSWORD;
  url.pathname = `/${db}`;
  return url.toString();
};

if (process.env.PJAN21_PG_HARNESS_SELF_TEST === "1") {
  const started = Date.now();
  const timed = run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    { timeoutMs: 50, maxBuffer: 1024 },
  );
  if (outcome(timed) !== "timeout" || Date.now() - started > 2_000) {
    throw new Error(`self-test timeout was not bounded (${outcome(timed)})`);
  }
  const overflow = run(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(65536))"],
    { timeoutMs: 2_000, maxBuffer: 1024 },
  );
  if (outcome(overflow) !== "output_limit") {
    throw new Error(`self-test output was not bounded (${outcome(overflow)})`);
  }
  if (
    executable(process.execPath) !== process.execPath ||
    executable("definitely-not-a-pjangler-command", "") !== null
  ) {
    throw new Error("self-test capability probe was not deterministic");
  }
  const originalPort = env.PGPORT;
  env.PGPORT = "6543";
  if (!databaseUrl("port_probe").includes(":6543/port_probe")) {
    throw new Error("self-test DATABASE_URL did not honor PGPORT");
  }
  env.PGPORT = originalPort;
  const strictUnavailable = run(
    process.execPath,
    [import.meta.filename],
    {
      timeoutMs: 2_000,
      maxBuffer: 64 * 1024,
      env: {
        ...env,
        PATH: "",
        PJAN21_PG_HARNESS_SELF_TEST: "0",
        PJANGLER_REQUIRE_DISPOSABLE_POSTGRES: "1",
      },
    },
  );
  if (
    strictUnavailable.status === 0 ||
    !`${strictUnavailable.stdout}${strictUnavailable.stderr}`.includes(
      "disposable_postgres_required",
    )
  ) {
    throw new Error("self-test strict mode silently skipped a required capability");
  }
  console.log(
    "PASS pg-registry-regressions self-test bounded_children=3 capability_probes=2 pgport=1 strict_mode=1",
  );
  process.exit(0);
}

// Availability probe — skip (exit 0) if we can't reach PG or bun is missing.
const bunPath = executable("bun");
if (!bunPath) skip("bun_missing");
const psqlPath = executable("psql");
if (!psqlPath) skip("psql_missing");
const pgProbe = psql(psqlPath, "postgres", "select 1", PROBE_TIMEOUT_MS);
if (
  pgProbe.status !== 0 ||
  pgProbe.error ||
  pgProbe.signal ||
  pgProbe.stdout.trim() !== "1"
) {
  skip(`postgres_unreachable_${outcome(pgProbe)}`);
}

let failed = false;
try {
  requireSuccess(
    "initial scratch cleanup",
    psql(psqlPath, "postgres", `DROP DATABASE IF EXISTS ${DB}`),
  );
  requireSuccess(
    "scratch database create",
    psql(psqlPath, "postgres", `CREATE DATABASE ${DB}`),
  );
  requireSuccess(
    "base schema",
    run(
      psqlPath,
      [
        "-h",
        env.PGHOST,
        "-p",
        env.PGPORT,
        "-U",
        env.PGUSER,
        "-d",
        DB,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-f",
        join(root, "tests", "test-base-schema.sql"),
      ],
      { cwd: root },
    ),
  );
  const npxPath = executable("npx");
  if (!npxPath) throw new Error("migration runner unavailable");
  requireSuccess(
    "migration",
    run(
      npxPath,
      [
        "node-pg-migrate",
        "--schema",
        "public",
        "--migrations-dir",
        "migrations",
        "up",
      ],
      {
        cwd: root,
        env: {
          ...env,
          DATABASE_URL: databaseUrl(DB),
        },
      },
    ),
  );

  const res = run(bunPath, [join(root, "tests", "_pg_store_check.ts")], {
    cwd: root,
  });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  requireSuccess("round-trip harness", res);
  if (!(res.stdout || "").includes("PG_STORE_CHECK_OK")) {
    throw new Error("round-trip harness failed (success marker missing)");
  }
} catch (e) {
  console.error(`pg-registry-regressions FAILED: ${e.message}`);
  failed = true;
} finally {
  const cleanup = psql(psqlPath, "postgres", `DROP DATABASE IF EXISTS ${DB}`);
  if (cleanup.status !== 0 || cleanup.error || cleanup.signal) {
    console.error(
      `pg-registry-regressions FAILED: scratch cleanup failed (${outcome(cleanup)})`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("pg-registry-regressions OK");
