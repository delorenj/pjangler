/* eslint-disable */
// pjangler PG-registry Phase 0 — additive columns + new tables (public schema).
// ADDITIVE ONLY on `up` (no DROP/DELETE/UPDATE of existing data); fully reversible
// on `down`. Uses `exports.up`/`exports.down` (the form node-pg-migrate's .cjs
// loader statically detects) rather than `module.exports = {…}`.
//
// Apply:   node-pg-migrate --schema public --migrations-dir migrations up
// Rollback: node-pg-migrate --schema public --migrations-dir migrations down

exports.up = async (pgm) => {
  // --- ALTER TABLE projects: add nullable columns (additive) ---
  pgm.addColumns("projects", {
    slug: { type: "varchar" },
    status: { type: "varchar" },
    github_org: { type: "varchar" },
    visibility: { type: "varchar" },
    source_artifacts: { type: "jsonb" },
    template: { type: "jsonb" },
    automation: { type: "jsonb" },
  });

  // --- Partial unique index on projects(slug) (pjangler owns slug-NOT-NULL rows) ---
  pgm.createIndex("projects", "slug", {
    name: "ux_projects_slug",
    unique: true,
    where: "slug IS NOT NULL",
  });

  // --- repos.local_path uniqueness. If dup local_paths exist, fall back to a
  //     partial unique index (a plain constraint would fail on existing dups). ---
  const dupResult = await pgm.db.query(
    `SELECT count(*) AS n FROM (SELECT local_path FROM repos GROUP BY local_path HAVING count(*) > 1) dups`,
  );
  const hasDups = parseInt(dupResult.rows[0]?.n ?? "0", 10) > 0;
  if (hasDups) {
    pgm.createIndex("repos", "local_path", {
      name: "ux_repos_local_path",
      unique: true,
      where: "local_path IS NOT NULL",
    });
  } else {
    pgm.addConstraint("repos", "uq_repos_local_path", { unique: ["local_path"] });
  }

  // --- project_ticket_boards ---
  pgm.createTable("project_ticket_boards", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("uuid_generate_v4()") },
    repo_id: { type: "uuid", notNull: true, references: "repos", onDelete: "CASCADE" },
    project_id: { type: "uuid", notNull: true, references: "projects", onDelete: "CASCADE" },
    provider_type: { type: "varchar", notNull: true },
    workspace: { type: "varchar" },
    identifier: { type: "varchar" },
    board_id: { type: "varchar" },
    state: { type: "varchar" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // Expression unique index (raw SQL — node-pg-migrate can't express upper()).
  pgm.sql(`CREATE UNIQUE INDEX ux_project_ticket_boards_identifier
           ON project_ticket_boards (upper(identifier))
           WHERE identifier IS NOT NULL`);

  // --- project_agents ---
  pgm.createTable("project_agents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("uuid_generate_v4()") },
    repo_id: { type: "uuid", notNull: true, references: "repos", onDelete: "CASCADE" },
    project_id: { type: "uuid", notNull: true, references: "projects", onDelete: "CASCADE" },
    agent_key: { type: "varchar", notNull: true },
    role: { type: "varchar", notNull: true },
    role_dir: { type: "varchar" },
    provisioning_state: { type: "varchar", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("project_agents", ["project_id", "agent_key"], {
    name: "ux_project_agents_project_key",
    unique: true,
  });

  // --- Reuse the existing shared update_updated_at() trigger fn for new tables ---
  pgm.sql(`CREATE TRIGGER tr_project_ticket_boards_updated_at
           BEFORE UPDATE ON project_ticket_boards
           FOR EACH ROW EXECUTE FUNCTION update_updated_at()`);
  pgm.sql(`CREATE TRIGGER tr_project_agents_updated_at
           BEFORE UPDATE ON project_agents
           FOR EACH ROW EXECUTE FUNCTION update_updated_at()`);
};

exports.down = async (pgm) => {
  // Bulletproof, idempotent teardown of everything `up` created. Raw SQL avoids
  // node-pg-migrate helper name/column inference ambiguities.
  pgm.sql(`
    DROP TRIGGER IF EXISTS tr_project_agents_updated_at ON project_agents;
    DROP TRIGGER IF EXISTS tr_project_ticket_boards_updated_at ON project_ticket_boards;
    DROP TABLE IF EXISTS project_agents;
    DROP TABLE IF EXISTS project_ticket_boards;
    ALTER TABLE repos DROP CONSTRAINT IF EXISTS uq_repos_local_path;
    DROP INDEX IF EXISTS ux_repos_local_path;
    DROP INDEX IF EXISTS ux_projects_slug;
    ALTER TABLE projects
      DROP COLUMN IF EXISTS slug,
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS github_org,
      DROP COLUMN IF EXISTS visibility,
      DROP COLUMN IF EXISTS source_artifacts,
      DROP COLUMN IF EXISTS template,
      DROP COLUMN IF EXISTS automation;
  `);
};
