// PG-backed RegistryStore regression. Bootstraps an ISOLATED scratch database
// (base schema + the pjangler migration), runs the bun round-trip harness, and
// tears the scratch db down. SKIPS cleanly when Postgres or bun is unavailable
// so the default suite stays green in environments without a DB.
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DB = `pjangler_registry_scratch_${process.pid}`;
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST || "localhost",
  PGUSER: process.env.PGUSER || "delorenj",
  PGPASSWORD: process.env.PGPASSWORD || "",
  PGDATABASE: DB,
};

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", env, ...opts });
const psql = (db, q) => run("psql", ["-h", env.PGHOST, "-U", env.PGUSER, "-d", db, "-tAc", q]);
const have = (bin) => run(bin, ["--version"]).status === 0;

// Availability probe — skip (exit 0) if we can't reach PG or bun is missing.
if (!have("bun") || psql("postgres", "select 1").status !== 0) {
  console.log("SKIP pg-registry-regressions (no reachable Postgres or bun)");
  process.exit(0);
}

let failed = false;
try {
  psql("postgres", `DROP DATABASE IF EXISTS ${DB}`);
  if (psql("postgres", `CREATE DATABASE ${DB}`).status !== 0) throw new Error("could not create scratch db");
  run("psql", ["-h", env.PGHOST, "-U", env.PGUSER, "-d", DB, "-q", "-f", join(root, "tests", "test-base-schema.sql")]);
  const mig = run("npx", ["node-pg-migrate", "--schema", "public", "--migrations-dir", "migrations", "up"], {
    cwd: root,
    env: { ...env, DATABASE_URL: `postgres://${env.PGUSER}:${env.PGPASSWORD}@${env.PGHOST}:5432/${DB}` },
  });
  if (mig.status !== 0) throw new Error(`migration failed:\n${mig.stdout}${mig.stderr}`);

  const res = run("bun", [join(root, "tests", "_pg_store_check.ts")], { cwd: root });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  if (res.status !== 0 || !(res.stdout || "").includes("PG_STORE_CHECK_OK")) throw new Error("harness assertions failed");
} catch (e) {
  console.error(`pg-registry-regressions FAILED: ${e.message}`);
  failed = true;
} finally {
  psql("postgres", `DROP DATABASE IF EXISTS ${DB}`);
}

if (failed) process.exit(1);
console.log("pg-registry-regressions OK");
