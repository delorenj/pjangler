import { Pool } from "pg";
import type { PoolClient } from "pg";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import type {
  ProjectRecord,
  ProjectRegistry,
  ProjectAgentRecord,
  ProjectTicketProvider,
  SourceArtifact,
  ProjectAutomation,
} from "./index";
import {
  PROJECT_REGISTRY_SCHEMA_VERSION,
  emptyProjectRegistry,
  validateProjectRegistry,
} from "./index";

// ---------------------------------------------------------------------------
// RegistryStore interface
// ---------------------------------------------------------------------------

export interface RegistryStore {
  load(): Promise<ProjectRegistry>;
  save(registry: ProjectRegistry): Promise<void>;
  upsert(slug: string, record: ProjectRecord): Promise<void>;
  getBySlug(slug: string): Promise<ProjectRecord | undefined>;
  getByRepoPath(repoPath: string): Promise<ProjectRecord | undefined>;
}

// ---------------------------------------------------------------------------
// YamlRegistryStore — wraps the existing YAML behavior identically
// ---------------------------------------------------------------------------

export class YamlRegistryStore implements RegistryStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ProjectRegistry> {
    if (!existsSync(this.path)) return emptyProjectRegistry();
    const raw = YAML.parse(readFileSync(this.path, "utf8")) as unknown;
    if (raw == null) return emptyProjectRegistry();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error(`Project registry must be a mapping: ${this.path}`);
    const registry = raw as Partial<ProjectRegistry>;
    const normalized: ProjectRegistry = {
      schema_version: Number(
        registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION
      ),
      projects:
        registry.projects && typeof registry.projects === "object" && !Array.isArray(registry.projects)
          ? (registry.projects as Record<string, ProjectRecord>)
          : {},
    };
    validateProjectRegistry(normalized);
    return normalized;
  }

  async save(registry: ProjectRegistry): Promise<void> {
    validateProjectRegistry(registry);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, YAML.stringify(registry, { lineWidth: 0 }), "utf8");
    renameSync(temp, this.path);
  }

  async upsert(slug: string, record: ProjectRecord): Promise<void> {
    const registry = await this.load();
    registry.projects[slug] = record;
    await this.save(registry);
  }

  async getBySlug(slug: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    return registry.projects[slug];
  }

  async getByRepoPath(repoPath: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    return Object.values(registry.projects).find(
      (p) => p.repo_path === repoPath
    );
  }
}

// ---------------------------------------------------------------------------
// PgRegistryStore — maps ProjectRecord ↔ projects/repos/boards/agents
// Writes ONLY rows it owns (slug IS NOT NULL). Never mutates slug IS NULL rows.
// ---------------------------------------------------------------------------

export interface PgRegistryConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function pgRegistryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PgRegistryConfig {
  return {
    host: env.PGHOST || "localhost",
    port: parseInt(env.PGPORT || "5432", 10),
    user: env.PGUSER || "delorenj",
    password: env.PGPASSWORD || "",
    database: env.PGDATABASE || "33god",
  };
}

export class PgRegistryStore implements RegistryStore {
  private pool: Pool;

  constructor(config: PgRegistryConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    });
  }

  async load(): Promise<ProjectRegistry> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{
        id: string;
        name: string | null;
        description: string | null;
        slug: string | null;
        status: string | null;
        source_artifacts: SourceArtifact[] | null;
        template: ProjectRecord["template"] | null;
        automation: ProjectAutomation | null;
        created_at: Date;
        updated_at: Date;
        repo_id: string | null;
        local_path: string | null;
      }>(
        `SELECT p.id, p.name, p.description, p.slug, p.status,
                p.source_artifacts, p.template, p.automation,
                p.created_at, p.updated_at,
                r.id AS repo_id, r.local_path
         FROM public.projects p
         LEFT JOIN public.repos r ON r.project_id = p.id
         WHERE p.slug IS NOT NULL`
      );

      const projects: Record<string, ProjectRecord> = {};
      for (const row of rows) {
        const slug = row.slug!;
        const ticketProvider = await this.loadTicketProvider(client, row.id);
        const agents = await this.loadAgents(client, row.id, slug);
        projects[slug] = {
          name: row.name ?? "",
          slug,
          repo_path: row.local_path ?? "",
          description: row.description ?? "",
          status: row.status ?? "planned",
          source_artifacts: row.source_artifacts ?? [],
          template: row.template ?? {
            commonproject: { enabled: false, primary_language: "python" },
          },
          ticket_provider: ticketProvider,
          agents,
          automation: row.automation ?? undefined,
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at.toISOString(),
        };
      }

      const registry: ProjectRegistry = {
        schema_version: PROJECT_REGISTRY_SCHEMA_VERSION,
        projects,
      };
      validateProjectRegistry(registry);
      return registry;
    } finally {
      client.release();
    }
  }

  async save(registry: ProjectRegistry): Promise<void> {
    validateProjectRegistry(registry);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [slug, record] of Object.entries(registry.projects)) {
        await this.upsertInTx(client, slug, record);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsert(slug: string, record: ProjectRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.upsertInTx(client, slug, record);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getBySlug(slug: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    return registry.projects[slug];
  }

  async getByRepoPath(repoPath: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    return Object.values(registry.projects).find(
      (p) => p.repo_path === repoPath
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // --- private helpers ---

  private async upsertInTx(
    client: PoolClient,
    slug: string,
    record: ProjectRecord
  ): Promise<void> {
    // SAFETY: never touch rows where slug IS NULL (legacy rows owned by another component)
    if (!slug) throw new Error("PgRegistryStore.upsert: slug is required");

    // 1. Upsert project row
    const projectResult = await client.query<{ id: string }>(
      `INSERT INTO public.projects (name, description, slug, status, source_artifacts, template, automation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) WHERE slug IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         source_artifacts = EXCLUDED.source_artifacts,
         template = EXCLUDED.template,
         automation = EXCLUDED.automation
       RETURNING id`,
      [
        record.name,
        record.description,
        slug,
        record.status,
        JSON.stringify(record.source_artifacts),
        JSON.stringify(record.template),
        record.automation ? JSON.stringify(record.automation) : null,
      ]
    );
    const projectId = projectResult.rows[0]?.id;
    if (!projectId) throw new Error(`Failed to upsert project: ${slug}`);

    // 2. Upsert repo row
    await client.query(
      `INSERT INTO public.repos (project_id, local_path)
       VALUES ($1, $2)
       ON CONFLICT (local_path)
       DO UPDATE SET project_id = EXCLUDED.project_id
       RETURNING id`,
      [projectId, record.repo_path]
    );

    const repoResult = await client.query<{ id: string }>(
      `SELECT id FROM public.repos WHERE project_id = $1 AND local_path = $2`,
      [projectId, record.repo_path]
    );
    const repoId = repoResult.rows[0]?.id;
    if (!repoId) throw new Error(`Failed to find repo for project ${slug} at path ${record.repo_path}`);

    // 3. Upsert ticket provider
    await this.upsertTicketProvider(client, projectId, repoId, record.ticket_provider);

    // 4. Sync agents (delete + insert)
    await client.query(
      `DELETE FROM public.project_agents WHERE project_id = $1`,
      [projectId]
    );
    for (const [agentKey, agent] of Object.entries(record.agents)) {
      await client.query(
        `INSERT INTO public.project_agents (repo_id, project_id, agent_key, role, role_dir, provisioning_state)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [repoId, projectId, agentKey, agent.role, agent.role_dir ?? null, agent.provisioning_state]
      );
    }
  }

  private async loadTicketProvider(
    client: PoolClient,
    projectId: string
  ): Promise<ProjectTicketProvider> {
    const { rows } = await client.query<{
      provider_type: string;
      workspace: string | null;
      identifier: string | null;
      board_id: string | null;
      state: string | null;
    }>(
      `SELECT provider_type, workspace, identifier, board_id, state
       FROM public.project_ticket_boards
       WHERE project_id = $1
       LIMIT 1`,
      [projectId]
    );
    if (!rows.length) {
      return { type: "plane", workspace: "33god", identifier: "", board_id: "", state: "planned" };
    }
    const row = rows[0]!;
    return {
      type: row.provider_type,
      workspace: row.workspace ?? undefined,
      identifier: row.identifier ?? undefined,
      board_id: row.board_id ?? undefined,
      state: (row.state as ProjectTicketProvider["state"]) ?? undefined,
    };
  }

  private async loadAgents(
    client: PoolClient,
    projectId: string,
    slug: string
  ): Promise<Record<string, ProjectAgentRecord>> {
    const { rows } = await client.query<{
      agent_key: string;
      role: string;
      role_dir: string | null;
      provisioning_state: string;
    }>(
      `SELECT agent_key, role, role_dir, provisioning_state
       FROM public.project_agents
       WHERE project_id = $1`,
      [projectId]
    );
    const agents: Record<string, ProjectAgentRecord> = {};
    for (const row of rows) {
      agents[row.agent_key] = {
        role: row.role,
        provisioning_state: row.provisioning_state as ProjectAgentRecord["provisioning_state"],
        role_dir: row.role_dir ?? undefined,
      };
    }
    return agents;
  }

  private async upsertTicketProvider(
    client: PoolClient,
    projectId: string,
    repoId: string,
    tp: ProjectTicketProvider
  ): Promise<void> {
    // Delete existing and re-insert (simplest for sync)
    await client.query(
      `DELETE FROM public.project_ticket_boards WHERE project_id = $1`,
      [projectId]
    );
    await client.query(
      `INSERT INTO public.project_ticket_boards
         (repo_id, project_id, provider_type, workspace, identifier, board_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        repoId,
        projectId,
        tp.type,
        tp.workspace ?? null,
        tp.identifier ?? null,
        tp.board_id ?? null,
        tp.state ?? null,
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// DualWriteRegistryStore — writes BOTH yaml (authoritative) AND PG;
// reads from yaml.
// ---------------------------------------------------------------------------

export class DualWriteRegistryStore implements RegistryStore {
  constructor(
    private readonly yaml: YamlRegistryStore,
    private readonly pg: PgRegistryStore
  ) {}

  async load(): Promise<ProjectRegistry> {
    return this.yaml.load();
  }

  async save(registry: ProjectRegistry): Promise<void> {
    await this.yaml.save(registry);
    try {
      await this.pg.save(registry);
    } catch (err) {
      console.error(`[DualWriteRegistryStore] PG write failed (yaml is authoritative): ${err instanceof Error ? err.message : err}`);
    }
  }

  async upsert(slug: string, record: ProjectRecord): Promise<void> {
    await this.yaml.upsert(slug, record);
    try {
      await this.pg.upsert(slug, record);
    } catch (err) {
      console.error(`[DualWriteRegistryStore] PG upsert failed (yaml is authoritative): ${err instanceof Error ? err.message : err}`);
    }
  }

  async getBySlug(slug: string): Promise<ProjectRecord | undefined> {
    return this.yaml.getBySlug(slug);
  }

  async getByRepoPath(repoPath: string): Promise<ProjectRecord | undefined> {
    return this.yaml.getByRepoPath(repoPath);
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

// ---------------------------------------------------------------------------
// Factory — returns the right store based on PJ_REGISTRY_PG env flag
// ---------------------------------------------------------------------------

export const PJ_REGISTRY_PG_ENV = "PJ_REGISTRY_PG";

export function isPgRegistryEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[PJ_REGISTRY_PG_ENV] === "1" || env[PJ_REGISTRY_PG_ENV] === "true";
}

let _store: RegistryStore | undefined;
let _storePath: string | undefined;

export function getRegistryStore(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): RegistryStore {
  if (_store && _storePath === path) return _store;

  const yamlStore = new YamlRegistryStore(path);

  if (isPgRegistryEnabled(env)) {
    const pgStore = new PgRegistryStore(pgRegistryConfigFromEnv(env));
    _store = new DualWriteRegistryStore(yamlStore, pgStore);
  } else {
    _store = yamlStore;
  }
  _storePath = path;
  return _store;
}

export function resetRegistryStore(): void {
  _store = undefined;
  _storePath = undefined;
}
