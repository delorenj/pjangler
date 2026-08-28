/* eslint-disable */
// PID-4 — board identity provenance, and uniqueness scoped to a workspace.
//
// Two problems, one migration:
//
// 1. `identifier` had no provenance, so a value minted from `slug.slice(0, 4)`
//    was indistinguishable from one Plane actually assigned. `identifier_source`
//    records which it is; a "linked" board is only legal behind "provider".
//
// 2. `ux_project_ticket_boards_identifier` was GLOBAL over upper(identifier).
//    Identifiers are unique within a workspace and nowhere else, so the global
//    index made a board in a second workspace impossible to register — the same
//    defect the TypeScript validator carried. Rescope both it and board_id to
//    (provider_type, workspace).

exports.up = async (pgm) => {
  pgm.addColumns("project_ticket_boards", {
    identifier_source: { type: "varchar" },
    identifier_fetched_at: { type: "timestamptz" },
  });
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_identifier_source_check", {
    check: "identifier_source IS NULL OR identifier_source IN ('provider', 'proposed')",
  });
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_state_check", {
    check: "state IS NULL OR state IN ('planned', 'linked', 'skipped')",
  });
  // A linked board is one the provider named.
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_linked_is_confirmed", {
    check: `state <> 'linked' OR (
      COALESCE(board_id, '') <> ''
      AND COALESCE(identifier, '') <> ''
      AND identifier_source = 'provider'
    )`,
  });

  pgm.sql(`DROP INDEX IF EXISTS ux_project_ticket_boards_identifier`);
  pgm.sql(`CREATE UNIQUE INDEX ux_project_ticket_boards_identifier
           ON project_ticket_boards (provider_type, lower(COALESCE(workspace, '')), upper(identifier))
           WHERE COALESCE(identifier, '') <> ''`);
  // An empty board_id is the absence of a board, not a board many projects
  // share, so it is exempt.
  pgm.sql(`CREATE UNIQUE INDEX ux_project_ticket_boards_board_id
           ON project_ticket_boards (provider_type, lower(COALESCE(workspace, '')), board_id)
           WHERE COALESCE(board_id, '') <> ''`);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS ux_project_ticket_boards_board_id;
    DROP INDEX IF EXISTS ux_project_ticket_boards_identifier;
    ALTER TABLE public.project_ticket_boards
      DROP CONSTRAINT IF EXISTS project_ticket_boards_linked_is_confirmed,
      DROP CONSTRAINT IF EXISTS project_ticket_boards_state_check,
      DROP CONSTRAINT IF EXISTS project_ticket_boards_identifier_source_check,
      DROP COLUMN IF EXISTS identifier_fetched_at,
      DROP COLUMN IF EXISTS identifier_source;
  `);
  pgm.sql(`CREATE UNIQUE INDEX ux_project_ticket_boards_identifier
           ON project_ticket_boards (upper(identifier))
           WHERE identifier IS NOT NULL`);
};
