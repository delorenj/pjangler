/* eslint-disable */
// PJAN-77 — additive Project Notebook Registry representation.

exports.up = async (pgm) => {
  pgm.addColumns("projects", {
    notebook: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    pjangler_extensions: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
  });

  pgm.createTable("pjangler_registry_settings", {
    scope: { type: "text", primaryKey: true },
    schema_version: { type: "integer", notNull: true },
    notebook: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    extensions: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
  });
  pgm.addConstraint("pjangler_registry_settings", "pjangler_registry_settings_global_scope", {
    check: "scope = 'global'",
  });
  pgm.sql(`INSERT INTO public.pjangler_registry_settings (scope, schema_version)
           VALUES ('global', 1)
           ON CONFLICT (scope) DO NOTHING`);
  pgm.sql(`CREATE UNIQUE INDEX projects_notebook_id_unique
           ON public.projects ((notebook->>'notebook_id'))
           WHERE slug IS NOT NULL AND COALESCE(notebook->>'notebook_id', '') <> ''`);
  pgm.sql(`CREATE UNIQUE INDEX projects_overview_note_id_unique
           ON public.projects ((notebook->>'overview_note_id'))
           WHERE slug IS NOT NULL AND COALESCE(notebook->>'overview_note_id', '') <> ''`);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS projects_overview_note_id_unique;
    DROP INDEX IF EXISTS projects_notebook_id_unique;
    DROP TABLE IF EXISTS public.pjangler_registry_settings;
    ALTER TABLE public.projects
      DROP COLUMN IF EXISTS notebook,
      DROP COLUMN IF EXISTS pjangler_extensions;
  `);
};
