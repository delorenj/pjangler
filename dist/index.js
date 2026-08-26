#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils/style.ts
function detectColor() {
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== void 0 && force !== "") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}
function sgr(open, close) {
  const prefix = `\x1B[${open}m`;
  const suffix = `\x1B[${close}m`;
  return (value) => colorEnabled ? `${prefix}${value}${suffix}` : String(value);
}
function statusStyle(status) {
  return STATUS_STYLES[status] ?? { glyph: glyph.dot, color: dim, label: status };
}
function heading(title, marker = glyph.chevron) {
  return `${cyan(bold(marker))} ${bold(title)}`;
}
function joinDot(fragments) {
  return fragments.join(dim(` ${glyph.dot} `));
}
function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}
function visibleWidth(value) {
  return stripAnsi(value).length;
}
function padVisible(value, width) {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
function truncateVisible(value, width) {
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  if (plain.length !== value.length) return width <= 1 ? "\u2026" : `${plain.slice(0, width - 1)}\u2026`;
  return width <= 1 ? "\u2026" : `${value.slice(0, width - 1)}\u2026`;
}
function terminalWidth(stream = process.stdout, fallback2 = 100) {
  const columns = stream.columns;
  return typeof columns === "number" && columns > 0 ? columns : fallback2;
}
function wrapVisible(text3, width) {
  if (width <= 0) return [text3];
  const lines = [];
  let current = "";
  for (const word of text3.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
    } else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (visibleWidth(current) > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  lines.push(current);
  return lines;
}
var env, colorEnabled, bold, dim, italic, underline, red, green, yellow, blue, magenta, cyan, gray, glyph, STATUS_STYLES, ANSI_PATTERN;
var init_style = __esm({
  "src/utils/style.ts"() {
    "use strict";
    env = process.env;
    colorEnabled = detectColor();
    bold = sgr(1, 22);
    dim = sgr(2, 22);
    italic = sgr(3, 23);
    underline = sgr(4, 24);
    red = sgr(31, 39);
    green = sgr(32, 39);
    yellow = sgr(33, 39);
    blue = sgr(34, 39);
    magenta = sgr(35, 39);
    cyan = sgr(36, 39);
    gray = sgr(90, 39);
    glyph = {
      pass: "\u2714",
      fail: "\u2716",
      warn: "\u26A0",
      skip: "\u25CB",
      info: "\u2139",
      arrow: "\u21B3",
      bullet: "\u2022",
      dot: "\xB7",
      add: "+",
      chevron: "\u25B8",
      pointer: "\u276F"
    };
    STATUS_STYLES = {
      pass: { glyph: glyph.pass, color: green, label: "pass" },
      fail: { glyph: glyph.fail, color: red, label: "fail" },
      warn: { glyph: glyph.warn, color: yellow, label: "warn" },
      skip: { glyph: glyph.skip, color: gray, label: "skip" },
      applied: { glyph: glyph.pass, color: green, label: "applied" },
      noop: { glyph: glyph.skip, color: gray, label: "noop" },
      blocked: { glyph: glyph.fail, color: red, label: "blocked" },
      skipped: { glyph: glyph.skip, color: gray, label: "skipped" },
      partial: { glyph: glyph.warn, color: yellow, label: "partial" }
    };
    ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
  }
});

// src/notebook/types.ts
function notebookCredentialMaterialPath(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  let visited = 0;
  const walk = (candidate, path, depth) => {
    if (++visited > 2e3 || depth > 20) return `${path}.[structure-limit]`;
    if (typeof candidate === "string") return SECRET_SHAPED_VALUE.test(candidate) ? path : null;
    if (!candidate || typeof candidate !== "object") return null;
    if (seen.has(candidate)) return `${path}.[cycle]`;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index++) {
        const found = walk(candidate[index], `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = path ? `${path}.${key}` : key;
      if (CREDENTIAL_KEY.test(key)) return childPath;
      const found = walk(child, childPath, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(value, "notebook", 0);
}
function notebookExitCode(code) {
  switch (code) {
    case "INVALID_INPUT":
      return 2;
    case "NOT_CONFIGURED":
    case "AUTHENTICATION_FAILED":
      return 3;
    case "NOT_FOUND":
    case "CONFLICT":
    case "CROSS_PROJECT":
    case "DRIFT_DETECTED":
      return 4;
    case "THROTTLED":
    case "TIMEOUT":
    case "SERVICE_UNAVAILABLE":
      return 5;
    case "REMOTE_PROTOCOL_ERROR":
    case "INTERNAL_ERROR":
      return 6;
  }
}
var NOTEBOOK_SCHEMA_VERSION, NOTEBOOK_POLICY_VERSION, CREDENTIAL_KEY, SECRET_SHAPED_VALUE, NotebookError, DEFAULT_NOTEBOOK_LIMITS, UNRESOLVED_RECEIPT_STATES;
var init_types = __esm({
  "src/notebook/types.ts"() {
    "use strict";
    NOTEBOOK_SCHEMA_VERSION = 1;
    NOTEBOOK_POLICY_VERSION = "project-notebook.v1";
    CREDENTIAL_KEY = /(?:^|[_-])(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|authorization)(?:$|[_-])/iu;
    SECRET_SHAPED_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s]{8,})/iu;
    NotebookError = class extends Error {
      constructor(code, message, retryable = false, details = {}, options) {
        super(message, options);
        this.code = code;
        this.retryable = retryable;
        this.details = details;
      }
      name = "NotebookError";
    };
    DEFAULT_NOTEBOOK_LIMITS = Object.freeze({
      schema_version: 1,
      overview_max_chars: 4e3,
      request_max_bytes: 1048576,
      response_max_bytes: 4194304,
      note_max_bytes: 1048576,
      source_file_max_bytes: 524288,
      list_max_items: 1e3,
      note_detail_fetch_concurrency: 8,
      excerpt_max_chars: 320,
      diagnostic_max_chars: 512,
      overall_timeout_ms: 5e3,
      hook_session_start_timeout_ms: 2e3,
      hook_session_end_timeout_ms: 250,
      hook_payload_max_bytes: 1048576,
      receipt_succeeded_retention_days: 30,
      receiptless_session_retention_seconds: 86400,
      unresolved_receipt_max_count: 100,
      unresolved_receipt_max_bytes: 8388608,
      receipt_max_bytes: 131072,
      automatic_attempt_limit: 2,
      lease_seconds: 300,
      integrity_max_entries: 20,
      refusal_max_entries: 100
    });
    UNRESOLVED_RECEIPT_STATES = /* @__PURE__ */ new Set([
      "queued",
      "processing",
      "failed",
      "retry-exhausted",
      "blocked-missing-baseline"
    ]);
  }
});

// src/utils/tree-diff.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync4, lstatSync as lstatSync3, readFileSync as readFileSync4, readdirSync as readdirSync3, readlinkSync as readlinkSync2 } from "node:fs";
import { join as join6, relative as relative3 } from "node:path";
function snapshotTree(root, current = root, snapshot = /* @__PURE__ */ new Map()) {
  if (!existsSync4(current)) return snapshot;
  const rel = relative3(root, current) || ".";
  if (rel === ".git" || rel.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) return snapshot;
  const stat = lstatSync3(current);
  if (stat.isSymbolicLink()) {
    snapshot.set(rel, `link:${readlinkSync2(current)}`);
  } else if (stat.isFile()) {
    snapshot.set(rel, `file:${createHash3("sha256").update(readFileSync4(current)).digest("hex")}:${stat.mode & 511}`);
  } else if (stat.isDirectory()) {
    snapshot.set(rel, `dir:${stat.mode & 511}`);
    for (const name of readdirSync3(current)) snapshotTree(root, join6(current, name), snapshot);
  } else {
    snapshot.set(rel, `other:${stat.mode}`);
  }
  return snapshot;
}
function changedTreePaths(root, before, after) {
  return [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].filter((path) => path !== "." && before.get(path) !== after.get(path)).map((path) => join6(root, path)).sort();
}
var init_tree_diff = __esm({
  "src/utils/tree-diff.ts"() {
    "use strict";
  }
});

// src/lifecycle/preflight.ts
import { createHash as createHash4 } from "node:crypto";
import {
  accessSync,
  constants as constants2,
  existsSync as existsSync5,
  lstatSync as lstatSync4,
  readFileSync as readFileSync5,
  readdirSync as readdirSync4,
  realpathSync as realpathSync2,
  statSync
} from "node:fs";
import { basename as basename4, delimiter, isAbsolute, join as join7, relative as relative4, resolve as resolve4 } from "node:path";
import YAML2 from "yaml";
function containedBy(parent, candidate) {
  const rel = relative4(resolve4(parent), resolve4(candidate));
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function sha2562(path) {
  return createHash4("sha256").update(readFileSync5(path)).digest("base64url");
}
function fingerprint(path) {
  const absolute = resolve4(path);
  const realPath = realpathSync2(absolute);
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  return {
    path: absolute,
    realPath,
    sha256: sha2562(realPath),
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid
  };
}
function sameFingerprint(expected) {
  try {
    const actual = fingerprint(expected.path);
    for (const key of ["realPath", "sha256", "size", "device", "inode", "mode", "uid", "gid"]) {
      if (actual[key] !== expected[key]) {
        return { ok: false, error: `trusted Copier identity changed at ${expected.path} (${key})` };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `trusted Copier identity is unavailable at ${expected.path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function verifyTrustedCopierIdentity(identity2) {
  if (!isAbsolute(identity2.executable) || resolve4(identity2.executable) !== resolve4(identity2.files.find((file) => file.path === identity2.executable)?.path ?? "")) {
    return { ok: false, error: "trusted Copier identity has no canonical absolute launcher" };
  }
  const interpreter = sameFingerprint(identity2.interpreter);
  if (!interpreter.ok) return interpreter;
  for (const file of identity2.files) {
    const verified = sameFingerprint(file);
    if (!verified.ok) return verified;
  }
  return { ok: true };
}
function regularContainedFile(root, path, label) {
  try {
    const rootReal = realpathSync2(root);
    const fileReal = realpathSync2(path);
    if (!containedBy(rootReal, fileReal)) return { ok: false, error: `${label} escapes its vendored template root` };
    if (!lstatSync4(path).isFile()) return { ok: false, error: `${label} is not a regular file` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function requireFiles(templateRoot, files, label) {
  for (const rel of files) {
    const result2 = regularContainedFile(templateRoot, join7(templateRoot, rel), `${label} ${rel}`);
    if (!result2.ok) return result2;
  }
  return { ok: true };
}
function preflightRenderedHermes(options) {
  const target = resolve4(options.targetDir);
  const roleDir = resolve4(options.roleDir);
  if (!containedBy(target, roleDir)) return { ok: false, error: "rendered Hermes role escapes its project target" };
  try {
    const stat = lstatSync4(roleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "rendered Hermes role must be a real directory" };
    }
  } catch (error) {
    return { ok: false, error: `rendered Hermes role is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const templateScripts = join7(resolve4(options.pjanglerRoot), "templates", "hermes-agent", "template", ".scripts");
  const renderedScripts = join7(roleDir, ".scripts");
  const requiredFiles = [
    "role.yaml",
    "SOUL.md",
    "hermes",
    ".gitignore",
    ".runtime-scaffold/README.md",
    ...["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"].map((script) => `.scripts/${script}`)
  ];
  const required = requireFiles(roleDir, requiredFiles, "rendered Hermes role");
  if (!required.ok) return required;
  for (const script of ["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    try {
      if (readFileSync5(join7(renderedScripts, script), "utf8") !== readFileSync5(join7(templateScripts, script), "utf8")) {
        return { ok: false, error: `rendered Hermes script differs from the attested template: ${script}` };
      }
    } catch (error) {
      return { ok: false, error: `cannot attest rendered Hermes script ${script}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  let role;
  try {
    const parsed = YAML2.parse(readFileSync5(join7(roleDir, "role.yaml"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "rendered Hermes role.yaml must contain a mapping" };
    }
    role = parsed;
  } catch (error) {
    return { ok: false, error: `rendered Hermes role.yaml is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.repo !== options.targetRepo || role.role !== options.role || role.agent_id !== options.agentId) {
    return { ok: false, error: "rendered Hermes role identity does not match the requested repo/role/agent" };
  }
  const bloodbank = role.bloodbank;
  if (!bloodbank || typeof bloodbank.enabled !== "boolean") {
    return { ok: false, error: "rendered Hermes bloodbank.enabled must be a strict boolean" };
  }
  const deployment = role.deployment;
  if (!deployment || deployment.local_only !== true || deployment.systemd !== "deferred") {
    return { ok: false, error: "rendered Hermes deployment must remain local-only/deferred until external grants run" };
  }
  const manifestPath = join7(target, ".project.json");
  if (existsSync5(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync5(manifestPath, "utf8"));
      const agents = manifest.agents;
      const declared = agents?.[options.agentId];
      if (!declared || declared.role !== options.role || declared.role_dir !== relative4(target, roleDir) || declared.provisioning_state !== "provisioned") {
        return { ok: false, error: "rendered Hermes role is not canonically registered in .project.json" };
      }
    } catch (error) {
      return { ok: false, error: `cannot validate rendered Hermes project registration: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}
var init_preflight = __esm({
  "src/lifecycle/preflight.ts"() {
    "use strict";
  }
});

// src/project/RegistryStore.ts
import { Pool } from "pg";
function projectExtensions(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !PROJECT_OWNED_KEYS.has(key)));
}
function registryExtensions(registry) {
  return Object.fromEntries(Object.entries(registry).filter(([key]) => !REGISTRY_OWNED_KEYS.has(key)));
}
function pgRegistryConfigFromEnv(env2 = process.env) {
  return {
    host: env2.PGHOST || "localhost",
    port: parseInt(env2.PGPORT || "5432", 10),
    user: env2.PGUSER || "delorenj",
    password: env2.PGPASSWORD || "",
    database: env2.PGDATABASE || "33god"
  };
}
function isPgRegistryEnabled(env2 = process.env) {
  return env2[PJ_REGISTRY_PG_ENV] === "1" || env2[PJ_REGISTRY_PG_ENV] === "true";
}
var PROJECT_OWNED_KEYS, REGISTRY_OWNED_KEYS, PgRegistryStore, PJ_REGISTRY_PG_ENV;
var init_RegistryStore = __esm({
  "src/project/RegistryStore.ts"() {
    "use strict";
    init_project();
    PROJECT_OWNED_KEYS = /* @__PURE__ */ new Set([
      "name",
      "slug",
      "repo_path",
      "description",
      "status",
      "source_artifacts",
      "template",
      "ticket_provider",
      "agents",
      "automation",
      "notebook",
      "created_at",
      "updated_at"
    ]);
    REGISTRY_OWNED_KEYS = /* @__PURE__ */ new Set(["schema_version", "notebook", "projects"]);
    PgRegistryStore = class {
      pool;
      constructor(config) {
        this.pool = new Pool({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database
        });
      }
      async load() {
        const client = await this.pool.connect();
        try {
          const { rows } = await client.query(
            `SELECT p.id, p.name, p.description, p.slug, p.status,
                p.source_artifacts, p.template, p.automation, p.notebook, p.pjangler_extensions,
                p.created_at, p.updated_at,
                r.id AS repo_id, r.local_path
         FROM public.projects p
         LEFT JOIN public.repos r ON r.project_id = p.id
         WHERE p.slug IS NOT NULL`
          );
          const projects = createSafeRecord();
          for (const row of rows) {
            const slug = row.slug;
            const ticketProvider = await this.loadTicketProvider(client, row.id);
            const agents = await this.loadAgents(client, row.id, slug);
            projects[slug] = {
              ...row.pjangler_extensions ?? {},
              name: row.name ?? "",
              slug,
              repo_path: row.local_path ?? "",
              description: row.description ?? "",
              // Read-time fallback for legacy rows whose status column is NULL.
              // Deliberately NOT the new-project default (PJAN-26 = "active"):
              // load() feeds save()/upsert(), so flipping this would retroactively
              // rewrite every pre-existing NULL-status row to "active" on the next
              // write. New records get their status from planProjectInit().
              status: row.status ?? "planned",
              source_artifacts: row.source_artifacts ?? [],
              template: row.template ?? {
                commonproject: { enabled: false, primary_language: "python" }
              },
              ticket_provider: ticketProvider,
              agents,
              automation: row.automation ?? void 0,
              notebook: row.notebook && Object.keys(row.notebook).length ? row.notebook : void 0,
              created_at: row.created_at.toISOString(),
              updated_at: row.updated_at.toISOString()
            };
          }
          let settings;
          try {
            const settingsResult = await client.query(
              `SELECT schema_version, notebook, extensions FROM public.pjangler_registry_settings WHERE scope = 'global'`
            );
            settings = settingsResult.rows[0];
          } catch (error) {
            if (error.code !== "42P01" && error.code !== "42703") throw error;
          }
          const registry = {
            ...settings?.extensions ?? {},
            schema_version: PROJECT_REGISTRY_SCHEMA_VERSION,
            ...settings?.notebook && Object.keys(settings.notebook).length ? { notebook: settings.notebook } : {},
            projects
          };
          validateProjectRegistry(registry);
          return registry;
        } finally {
          client.release();
        }
      }
      async save(registry) {
        validateProjectRegistry(registry);
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await this.upsertSettingsInTx(client, registry);
          await client.query(
            `DELETE FROM public.projects
         WHERE slug IS NOT NULL AND NOT (slug = ANY($1::text[]))`,
            [Object.keys(registry.projects)]
          );
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
      async upsert(slug, record) {
        validateProjectRegistry({
          schema_version: PROJECT_REGISTRY_SCHEMA_VERSION,
          projects: createSafeRecord([[slug, record]])
        });
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
      async getBySlug(slug) {
        const registry = await this.load();
        return getOwnRecordValue(registry.projects, slug);
      }
      async getByRepoPath(repoPath) {
        const registry = await this.load();
        return Object.values(registry.projects).find(
          (p6) => p6.repo_path === repoPath
        );
      }
      async close() {
        await this.pool.end();
      }
      // --- private helpers ---
      async upsertInTx(client, slug, record) {
        if (!slug) throw new Error("PgRegistryStore.upsert: slug is required");
        const projectResult = await client.query(
          `INSERT INTO public.projects (name, description, slug, status, source_artifacts, template, automation, notebook, pjangler_extensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) WHERE slug IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         source_artifacts = EXCLUDED.source_artifacts,
         template = EXCLUDED.template,
         automation = EXCLUDED.automation,
         notebook = EXCLUDED.notebook,
         pjangler_extensions = EXCLUDED.pjangler_extensions
       RETURNING id`,
          [
            record.name,
            record.description,
            slug,
            record.status,
            JSON.stringify(record.source_artifacts),
            JSON.stringify(record.template),
            record.automation ? JSON.stringify(record.automation) : null,
            JSON.stringify(record.notebook ?? {}),
            JSON.stringify(projectExtensions(record))
          ]
        );
        const projectId = projectResult.rows[0]?.id;
        if (!projectId) throw new Error(`Failed to upsert project: ${slug}`);
        await client.query(
          `INSERT INTO public.repos (project_id, local_path)
       VALUES ($1, $2)
       ON CONFLICT (local_path)
       DO UPDATE SET project_id = EXCLUDED.project_id
       RETURNING id`,
          [projectId, record.repo_path]
        );
        const repoResult = await client.query(
          `SELECT id FROM public.repos WHERE project_id = $1 AND local_path = $2`,
          [projectId, record.repo_path]
        );
        const repoId = repoResult.rows[0]?.id;
        if (!repoId) throw new Error(`Failed to find repo for project ${slug} at path ${record.repo_path}`);
        await this.upsertTicketProvider(client, projectId, repoId, record.ticket_provider);
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
      async upsertSettingsInTx(client, registry) {
        await client.query(
          `INSERT INTO public.pjangler_registry_settings (scope, schema_version, notebook, extensions)
       VALUES ('global', $1, $2, $3)
       ON CONFLICT (scope) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         notebook = EXCLUDED.notebook,
         extensions = EXCLUDED.extensions`,
          [registry.schema_version, JSON.stringify(registry.notebook ?? {}), JSON.stringify(registryExtensions(registry))]
        );
      }
      async loadTicketProvider(client, projectId) {
        const { rows } = await client.query(
          `SELECT provider_type, workspace, identifier, board_id, state
       FROM public.project_ticket_boards
       WHERE project_id = $1
       LIMIT 1`,
          [projectId]
        );
        if (!rows.length) {
          return { type: "plane", workspace: "33god", identifier: "", board_id: "", state: "planned" };
        }
        const row = rows[0];
        return {
          type: row.provider_type,
          workspace: row.workspace ?? void 0,
          identifier: row.identifier ?? void 0,
          board_id: row.board_id ?? void 0,
          state: row.state ?? void 0
        };
      }
      async loadAgents(client, projectId, slug) {
        const { rows } = await client.query(
          `SELECT agent_key, role, role_dir, provisioning_state
       FROM public.project_agents
       WHERE project_id = $1`,
          [projectId]
        );
        const agents = createSafeRecord();
        for (const row of rows) {
          agents[row.agent_key] = {
            role: row.role,
            provisioning_state: row.provisioning_state,
            role_dir: row.role_dir ?? void 0
          };
        }
        return agents;
      }
      async upsertTicketProvider(client, projectId, repoId, tp) {
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
            tp.state ?? null
          ]
        );
      }
    };
    PJ_REGISTRY_PG_ENV = "PJ_REGISTRY_PG";
  }
});

// src/project/index.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { isIP } from "node:net";
import { chmodSync as chmodSync2, closeSync as closeSync2, copyFileSync as copyFileSync2, existsSync as existsSync6, fchmodSync, fsyncSync, lstatSync as lstatSync5, mkdirSync as mkdirSync4, mkdtempSync as mkdtempSync2, openSync as openSync2, readFileSync as readFileSync6, realpathSync as realpathSync3, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir4, tmpdir } from "node:os";
import { basename as basename5, delimiter as delimiter2, dirname as dirname5, isAbsolute as isAbsolute2, join as join8, relative as relative5, resolve as resolve5, sep as sep2, win32 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import YAML3 from "yaml";
function synchronizeCopierIdentity(manifestPath, manifest) {
  const answersPath = join8(dirname5(manifestPath), ".copier-answers.yml");
  if (!existsSync6(answersPath)) return [];
  const current = readFileSync6(answersPath, "utf8");
  const document = YAML3.parseDocument(current);
  if (document.errors.length) return [];
  const name = String(document.get("project_name") ?? "");
  const description = String(document.get("project_description") ?? "");
  if (name === manifest.project_name && description === manifest.project_description) return [];
  document.set("project_name", manifest.project_name);
  document.set("project_description", manifest.project_description);
  const next = String(document);
  if (next === current) return [];
  writeFileSync4(answersPath, next, "utf8");
  return [answersPath];
}
function projectRegistryPath(env2 = process.env) {
  return expandHome(env2[PROJECT_REGISTRY_ENV] || join8(homedir4(), ".config", "pjangler", "projects.yaml"));
}
function createSafeRecord(entries = []) {
  const record = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of entries) record[key] = value;
  return record;
}
function getOwnRecordValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : void 0;
}
function emptyProjectRegistry() {
  return { schema_version: PROJECT_REGISTRY_SCHEMA_VERSION, projects: createSafeRecord() };
}
function loadProjectRegistry(path = projectRegistryPath()) {
  if (!existsSync6(path)) return emptyProjectRegistry();
  const raw = YAML3.parse(readFileSync6(path, "utf8"));
  if (raw == null) return emptyProjectRegistry();
  if (!isRecord(raw)) throw new Error(`Project registry must be a mapping: ${path}`);
  const registry = raw;
  const projects = createSafeRecord();
  if (isRecord(registry.projects)) {
    for (const [slug, rawProject] of Object.entries(registry.projects)) {
      if (!isRecord(rawProject)) {
        projects[slug] = rawProject;
        continue;
      }
      projects[slug] = {
        ...rawProject,
        agents: isRecord(rawProject.agents) ? createSafeRecord(Object.entries(rawProject.agents)) : rawProject.agents
      };
    }
  }
  const normalized = {
    ...registry,
    schema_version: Number(registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION),
    projects
  };
  validateProjectRegistry(normalized);
  return normalized;
}
function yamlPlain(document, path) {
  let value = document.toJS();
  for (const key of path) {
    if (typeof key === "number" && Array.isArray(value)) value = value[key];
    else if (typeof key === "string" && isRecord(value)) value = value[key];
    else return void 0;
  }
  return value;
}
function sameYamlValue(document, path, desired) {
  try {
    return JSON.stringify(yamlPlain(document, path)) === JSON.stringify(desired);
  } catch {
    return false;
  }
}
function setYamlLeaf(document, path, desired) {
  if (sameYamlValue(document, path, desired)) return;
  const current = document.getIn(path, true);
  if (YAML3.isScalar(current) && (desired === null || typeof desired !== "object")) {
    current.value = desired;
    return;
  }
  document.setIn(path, desired);
}
function mergeYamlMapping(document, path, desired, ownedKeys = []) {
  if (sameYamlValue(document, path, desired)) return;
  const current = document.getIn(path, true);
  if (!YAML3.isMap(current)) {
    document.setIn(path, desired);
    return;
  }
  for (const key of ownedKeys) if (!Object.hasOwn(desired, key)) document.deleteIn([...path, key]);
  for (const [key, value] of Object.entries(desired)) {
    const child = [...path, key];
    if (isRecord(value)) {
      const childOwned = key === "notebook" ? PROJECT_NOTEBOOK_OWNED_KEYS : key === "ticket_provider" ? TICKET_PROVIDER_OWNED_KEYS : path.length === 1 && path[0] === "notebook" && key === "auth" ? GLOBAL_NOTEBOOK_AUTH_OWNED_KEYS : path.length === 1 && path[0] === "notebook" && key === "defaults" ? GLOBAL_NOTEBOOK_DEFAULTS_OWNED_KEYS : path.length === 1 && path[0] === "notebook" && key === "limits" ? GLOBAL_NOTEBOOK_LIMITS_OWNED_KEYS : path.length === 1 && path[0] === "notebook" && key === "summarizer" ? GLOBAL_NOTEBOOK_SUMMARIZER_OWNED_KEYS : [];
      mergeYamlMapping(document, child, value, childOwned);
    } else setYamlLeaf(document, child, value);
  }
}
function fsyncDirectory(path) {
  try {
    const fd = openSync2(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync2(fd);
    }
  } catch {
  }
}
function saveProjectRegistry(registry, path = projectRegistryPath()) {
  validateProjectRegistry(registry);
  mkdirSync4(dirname5(path), { recursive: true });
  let text3;
  let mode = 420;
  if (existsSync6(path)) {
    const stat = lstatSync5(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Project registry must be a regular file: ${path}`);
    mode = stat.mode & 511;
    const current = readFileSync6(path, "utf8");
    const document = YAML3.parseDocument(current);
    if (document.errors.length) throw new Error(`Project registry YAML is invalid: ${path}`);
    setYamlLeaf(document, ["schema_version"], registry.schema_version);
    if (registry.notebook !== void 0) mergeYamlMapping(document, ["notebook"], registry.notebook, GLOBAL_NOTEBOOK_OWNED_KEYS);
    else document.delete("notebook");
    if (!document.has("projects")) document.set("projects", {});
    const parsed = document.toJS();
    const existingProjects = isRecord(parsed) && isRecord(parsed.projects) ? parsed.projects : {};
    for (const slug of Object.keys(existingProjects)) if (!Object.hasOwn(registry.projects, slug)) document.deleteIn(["projects", slug]);
    for (const [slug, project] of Object.entries(registry.projects)) {
      mergeYamlMapping(document, ["projects", slug], project, PROJECT_REGISTRY_OWNED_KEYS);
    }
    text3 = String(document);
    if (text3 === current) return;
  } else {
    text3 = YAML3.stringify(registry, { lineWidth: 0 });
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = openSync2(temp, "wx", mode);
    writeFileSync4(fd, text3, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync2(fd);
    fd = void 0;
    renameSync2(temp, path);
    chmodSync2(path, mode);
    fsyncDirectory(dirname5(path));
  } catch (error) {
    if (fd !== void 0) try {
      closeSync2(fd);
    } catch {
    }
    try {
      unlinkSync2(temp);
    } catch {
    }
    throw error;
  }
}
function validateProjectRegistry(registry) {
  if (registry.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project registry schema_version: ${registry.schema_version}`);
  }
  validateGlobalNotebookConfig(registry.notebook);
  if (!isRecord(registry.projects)) throw new Error("Project registry projects must be a mapping");
  const slugs = /* @__PURE__ */ new Set();
  const repoPaths = /* @__PURE__ */ new Map();
  const identifiers = /* @__PURE__ */ new Map();
  const notebookIds = /* @__PURE__ */ new Map();
  const overviewNoteIds = /* @__PURE__ */ new Map();
  for (const [slug, project] of Object.entries(registry.projects)) {
    validateProjectRecord(project, slug);
    if (slugs.has(project.slug)) throw new Error(`Duplicate project slug: ${project.slug}`);
    slugs.add(project.slug);
    const repoKey = resolve5(project.repo_path);
    const existingRepoSlug = repoPaths.get(repoKey);
    if (existingRepoSlug && existingRepoSlug !== slug) {
      throw new Error(`Duplicate project repo_path: ${project.repo_path} used by ${existingRepoSlug} and ${slug}`);
    }
    repoPaths.set(repoKey, slug);
    const identifier = project.ticket_provider.identifier?.toUpperCase();
    if (identifier) {
      const existingIdentifierSlug = identifiers.get(identifier);
      if (existingIdentifierSlug && existingIdentifierSlug !== slug) {
        throw new Error(`Duplicate project identifier: ${identifier} used by ${existingIdentifierSlug} and ${slug}`);
      }
      identifiers.set(identifier, slug);
    }
    const notebookId = project.notebook?.notebook_id;
    if (notebookId) {
      const existingNotebookSlug = notebookIds.get(notebookId);
      if (existingNotebookSlug && existingNotebookSlug !== slug) throw new Error(`Duplicate project notebook_id: ${notebookId} used by ${existingNotebookSlug} and ${slug}`);
      notebookIds.set(notebookId, slug);
    }
    const overviewNoteId = project.notebook?.overview_note_id;
    if (overviewNoteId) {
      const existingOverviewSlug = overviewNoteIds.get(overviewNoteId);
      if (existingOverviewSlug && existingOverviewSlug !== slug) throw new Error(`Duplicate project overview_note_id: ${overviewNoteId} used by ${existingOverviewSlug} and ${slug}`);
      overviewNoteIds.set(overviewNoteId, slug);
    }
  }
}
function validateGlobalNotebookConfig(value) {
  if (value === void 0) return;
  if (!isRecord(value)) throw new Error("Project registry notebook must be a mapping");
  const credentialPath = notebookCredentialMaterialPath(value);
  if (credentialPath) throw new Error(`Project registry Notebook configuration contains forbidden credential material at ${credentialPath}`);
  if (value.base_url !== void 0) {
    if (typeof value.base_url !== "string" || !value.base_url.trim()) throw new Error("Project registry notebook.base_url must be a nonempty URL");
    let url;
    try {
      url = new URL(value.base_url);
    } catch {
      throw new Error("Project registry notebook.base_url must be an absolute URL");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Project registry notebook.base_url may not contain credentials, query, or fragment");
    const hostname = url.hostname.toLowerCase();
    const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const loopback = hostname === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (isIP(host) !== 0 && !loopback) throw new Error("Project registry notebook.base_url may not use a numeric non-loopback host");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Project registry notebook.base_url must use HTTPS or loopback HTTP");
  }
  if (value.auth !== void 0) {
    if (!isRecord(value.auth) || value.auth.mode !== "none" && value.auth.mode !== "environment") throw new Error("Project registry notebook.auth is invalid");
    if (value.auth.mode === "environment" && value.auth.env_var !== "OPEN_NOTEBOOK_PASSWORD") throw new Error("Project registry notebook.auth.env_var must be OPEN_NOTEBOOK_PASSWORD");
    if (value.auth.mode === "none" && value.auth.env_var !== void 0) throw new Error("Project registry notebook.auth none mode may not name a credential variable");
  }
  const boundedList = (candidate, name) => {
    if (!Array.isArray(candidate) || candidate.length > 100 || candidate.some((entry) => typeof entry !== "string" || !entry || Buffer.byteLength(entry, "utf8") > 512)) throw new Error(`Project registry notebook.defaults.${name} must be a bounded string list`);
  };
  if (value.defaults !== void 0) {
    if (!isRecord(value.defaults)) throw new Error("Project registry notebook.defaults must be a mapping");
    for (const key of ["enabled", "session_start_enabled", "session_capture_enabled"]) {
      if (value.defaults[key] !== void 0 && typeof value.defaults[key] !== "boolean") throw new Error(`Project registry notebook.defaults.${key} must be boolean`);
    }
    if (value.defaults.overview_max_chars !== void 0 && (!Number.isSafeInteger(value.defaults.overview_max_chars) || Number(value.defaults.overview_max_chars) <= 0)) throw new Error("Project registry notebook.defaults.overview_max_chars must be a positive integer");
    for (const key of ["documentation_globs", "overview_references", "excluded_globs"]) if (value.defaults[key] !== void 0) boundedList(value.defaults[key], key);
  }
  const limits = { ...DEFAULT_NOTEBOOK_LIMITS };
  if (value.limits !== void 0) {
    if (!isRecord(value.limits)) throw new Error("Project registry notebook.limits must be a mapping");
    for (const key of Object.keys(DEFAULT_NOTEBOOK_LIMITS)) {
      const configured = value.limits[key];
      if (configured === void 0) continue;
      if (!Number.isSafeInteger(configured) || Number(configured) <= 0) throw new Error(`Project registry notebook.limits.${key} must be a positive integer`);
      limits[key] = Number(configured);
    }
  }
  if (limits.schema_version !== 1) throw new Error("Project registry notebook.limits.schema_version must be 1");
  if (limits.receipt_max_bytes > limits.unresolved_receipt_max_bytes) throw new Error("Project registry notebook receipt_max_bytes may not exceed unresolved_receipt_max_bytes");
  if (limits.hook_payload_max_bytes > DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes) throw new Error("Project registry notebook hook_payload_max_bytes exceeds the packaged ceiling");
  if (limits.note_detail_fetch_concurrency > DEFAULT_NOTEBOOK_LIMITS.note_detail_fetch_concurrency) throw new Error("Project registry notebook note_detail_fetch_concurrency exceeds the packaged ceiling");
  if (limits.lease_seconds * 1e3 <= limits.overall_timeout_ms) throw new Error("Project registry notebook lease_seconds must exceed one request timeout");
  if (isRecord(value.defaults) && value.defaults.overview_max_chars !== void 0 && Number(value.defaults.overview_max_chars) > limits.note_max_bytes) throw new Error("Project registry notebook overview_max_chars exceeds note_max_bytes");
  if (value.summarizer !== void 0) {
    if (!isRecord(value.summarizer) || typeof value.summarizer.executable !== "string" || !isAbsolute2(value.summarizer.executable) || value.summarizer.executable.includes("\0") || Buffer.byteLength(value.summarizer.executable, "utf8") > 1024) throw new Error("Project registry notebook.summarizer executable must be a bounded absolute path");
    if (value.summarizer.args !== void 0 && (!Array.isArray(value.summarizer.args) || value.summarizer.args.length > 32 || value.summarizer.args.some((entry) => typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 1024))) throw new Error("Project registry notebook.summarizer args must be bounded strings");
  }
}
function normalizeTicketProvider(value) {
  const type = (value || "plane").trim().toLowerCase();
  if (type === "plane" || type === "trello") return type;
  throw new Error(`Unsupported ticket provider: ${value}. Supported providers: plane, trello`);
}
function buildTicketProviderBlock(input) {
  const type = normalizeTicketProvider(input.type);
  const boardId = input.boardId ?? "";
  if (type === "trello") {
    return {
      type,
      workspace: input.workspace ?? "",
      identifier: input.identifier,
      board_id: boardId,
      state: boardId ? "linked" : "planned"
    };
  }
  const workspace = input.workspace ?? "33god";
  return {
    type,
    workspace,
    identifier: input.identifier,
    board_id: boardId,
    state: boardId ? "linked" : "planned"
  };
}
function ticketProviderKeyVar(provider) {
  return provider === "trello" ? "TRELLO_KEY" : "PLANE_API_KEY";
}
function ticketProviderKeyVars(provider) {
  return provider === "trello" ? ["TRELLO_KEY", "TRELLO_TOKEN"] : ["PLANE_API_KEY"];
}
function ticketProviderSecretsPath(env2 = process.env) {
  const base = env2.XDG_CONFIG_HOME || join8(env2.HOME || homedir4(), ".config");
  return join8(base, "zshyzsh", "secrets.zsh");
}
function readShellAssignments(path, keys) {
  const found = {};
  if (!existsSync6(path)) return found;
  let text3;
  try {
    text3 = readFileSync6(path, "utf8");
  } catch {
    return found;
  }
  const wanted = new Set(keys);
  for (const rawLine of text3.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!wanted.has(key) || found[key] !== void 0) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    if (value) found[key] = value;
  }
  return found;
}
function resolveTicketProviderCredentials(input) {
  const env2 = input.env ?? process.env;
  const values = {};
  const sources = {};
  const missing = () => input.keys.filter((key) => !values[key]);
  for (const key of input.keys) {
    const fromEnv = env2[key];
    if (fromEnv) {
      values[key] = fromEnv;
      sources[key] = "environment";
    }
  }
  const candidates = [];
  if (input.repoPath) candidates.push({ path: join8(input.repoPath, ".env"), label: join8(input.repoPath, ".env") });
  const secrets = ticketProviderSecretsPath(env2);
  candidates.push({ path: secrets, label: secrets });
  for (const candidate of candidates) {
    const outstanding = missing();
    if (!outstanding.length) break;
    const assignments = readShellAssignments(candidate.path, outstanding);
    for (const [key, value] of Object.entries(assignments)) {
      values[key] = value;
      sources[key] = candidate.label;
    }
  }
  return { values, sources };
}
function resolveTicketProviderAdapter(provider, env2 = process.env) {
  const file = `${provider}.sh`;
  const candidates = [];
  const override = env2[TICKET_PROVIDER_ADAPTERS_ENV];
  if (override) candidates.push(join8(override, file));
  const relativeRoots = [
    join8("templates", "hermes-agent", "template", ".scripts", "providers"),
    join8("agents", "hermes", "pm", ".scripts", "providers")
  ];
  try {
    let dir = dirname5(fileURLToPath2(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      for (const relativeRoot of relativeRoots) candidates.push(join8(dir, relativeRoot, file));
      const parent = dirname5(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  for (const relativeRoot of relativeRoots) {
    candidates.push(join8(homedir4(), "code", "pjangler", relativeRoot, file));
  }
  return candidates.find((candidate) => existsSync6(candidate));
}
function provisionTicketProviderBoard(action, env2 = process.env) {
  const provider = action.provider;
  const keyVar = ticketProviderKeyVar(provider);
  const { values } = resolveTicketProviderCredentials({
    keys: ticketProviderKeyVars(provider),
    repoPath: action.repoPath,
    env: env2
  });
  if (!values[keyVar]) {
    return {
      ok: true,
      skipped: true,
      logs: [
        `ticket-provider: ${keyVar} not set; skipping ${provider} board creation (state stays "planned"). Set it in the environment, ${join8(action.repoPath, ".env")}, or ${ticketProviderSecretsPath(env2)}, then re-run with --live \u2014 or pass --board-id to link an existing board.`
      ]
    };
  }
  const adapter = resolveTicketProviderAdapter(provider, env2);
  if (!adapter) {
    return {
      ok: false,
      skipped: false,
      logs: [],
      error: `ticket-provider: no ${provider} adapter found. Set ${TICKET_PROVIDER_ADAPTERS_ENV} to a directory containing ${provider}.sh.`
    };
  }
  const redact = (text3) => Object.values(values).reduce((acc, secret) => secret ? acc.split(secret).join("***") : acc, text3);
  const staging = mkdtempSync2(join8(tmpdir(), "pjangler-tp-"));
  try {
    const providersDir = join8(staging, "agents", "hermes", "pm", ".scripts", "providers");
    mkdirSync4(providersDir, { recursive: true });
    writeFileSync4(
      join8(staging, ".project.json"),
      `${JSON.stringify(
        {
          project_name: action.boardName,
          repo_path: action.repoPath,
          ticket_provider: {
            type: provider,
            workspace: action.workspace,
            identifier: action.identifier,
            board_id: "",
            state: "planned"
          }
        },
        null,
        2
      )}
`,
      "utf8"
    );
    const staged = join8(providersDir, `${provider}.sh`);
    copyFileSync2(adapter, staged);
    const childEnv = { ...env2, ...values, TICKET_PROVIDER: provider };
    if (provider === "plane" && action.workspace) childEnv.PLANE_WORKSPACE = action.workspace;
    const result2 = spawnSync2("sh", [staged, "create_board", action.boardName, action.identifier, action.description], {
      cwd: existsSync6(action.repoPath) ? action.repoPath : staging,
      encoding: "utf8",
      env: childEnv
    });
    if (result2.error) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: could not run the ${provider} adapter: ${redact(result2.error.message)}`
      };
    }
    const stderr = redact((result2.stderr ?? "").trim());
    if (result2.status !== 0) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board failed (exit ${result2.status ?? "unknown"})${stderr ? `: ${stderr}` : ""}`
      };
    }
    const stdout = (result2.stdout ?? "").trim();
    const lastLine = stdout.split(/\r?\n/).filter((line) => line.trim()).pop() ?? "";
    let parsed;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned unparseable output: ${redact(lastLine) || "(empty)"}`
      };
    }
    const boardId = isRecord(parsed) && typeof parsed.board_id === "string" ? parsed.board_id.trim() : "";
    if (!boardId) {
      return {
        ok: false,
        skipped: false,
        logs: [],
        error: `ticket-provider: ${provider} create_board returned no board_id`
      };
    }
    const boardUrl2 = isRecord(parsed) && typeof parsed.board_url === "string" ? parsed.board_url : void 0;
    return {
      ok: true,
      skipped: false,
      boardId,
      boardUrl: boardUrl2,
      logs: [`ticket-provider: ${provider} board linked (${action.identifier} \u2192 ${boardId})`]
    };
  } finally {
    rmSync2(staging, { recursive: true, force: true });
  }
}
function defaultProjectAutomation() {
  return {
    reconcile: {
      enabled: false,
      grace_hours: 0,
      auto_review: true
    }
  };
}
function slugifyProjectName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function validateSafePathSegment(value, label) {
  const normalized = value.trim();
  const unsafe = !normalized || normalized !== value || normalized === "." || normalized === ".." || isAbsolute2(normalized) || win32.isAbsolute(normalized) || normalized.includes("/") || normalized.includes("\\") || !SAFE_PATH_SEGMENT.test(normalized);
  if (unsafe) {
    throw new Error(
      `${label} must be a non-empty safe single path segment using letters, numbers, dots, underscores, or hyphens (no dot segments, absolute paths, separators, or traversal)`
    );
  }
  return normalized;
}
function prospectiveRealPath(path) {
  let cursor = resolve5(path);
  const suffix = [];
  while (!existsSync6(cursor)) {
    const parent = dirname5(cursor);
    if (parent === cursor) return resolve5(path);
    suffix.unshift(basename5(cursor));
    cursor = parent;
  }
  return resolve5(realpathSync3(cursor), ...suffix);
}
function resolveContainedPath(parentDir, candidate, label) {
  const physicalParent = prospectiveRealPath(parentDir);
  const physicalCandidate = prospectiveRealPath(candidate);
  const fromParent = relative5(physicalParent, physicalCandidate);
  if (!fromParent || fromParent === ".." || fromParent.startsWith(`..${sep2}`) || isAbsolute2(fromParent)) {
    throw new Error(`${label} must remain contained beneath parent directory ${resolve5(parentDir)}`);
  }
  return resolve5(candidate);
}
function deriveProjectIdentifier(value) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const identifier = compact.slice(0, 4) || "PROJ";
  return identifier.length >= 2 ? identifier : `${identifier}XX`.slice(0, 4);
}
function normalizeAgentRole(value) {
  return value === void 0 ? "pm" : validateSafePathSegment(value, "Agent role");
}
function resolveAgentHooksLayer2(input, env2 = process.env) {
  if (typeof input === "boolean") return input;
  const override = env2.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return !existsSync6(join8(homedir4(), ".agents", "hooks"));
}
function jsonStable(value) {
  return JSON.stringify(value);
}
function projectRecordEquivalent(a, b) {
  if (!a) return false;
  const { created_at: _aCreated, updated_at: _aUpdated, ...aComparable } = a;
  const { created_at: _bCreated, updated_at: _bUpdated, ...bComparable } = b;
  return jsonStable(aComparable) === jsonStable(bComparable);
}
function defaultProjectTargetDir(name, cwd = process.cwd()) {
  const compactName = name.replace(/[^A-Za-z0-9._-]/g, "");
  const safeName = SAFE_PATH_SEGMENT.test(compactName) ? compactName : slugifyProjectName(name);
  return resolve5(dirname5(resolve5(cwd)), validateSafePathSegment(safeName, "Generated project directory"));
}
function sourceSkillRoots(env2 = process.env) {
  const configuredRoots = (env2[PROJECT_SOURCE_SKILL_ROOTS_ENV] || "").split(delimiter2).map((root) => root.trim()).filter(Boolean);
  const seen = /* @__PURE__ */ new Set();
  const roots = [];
  for (const root of [...DEFAULT_SOURCE_SKILL_ROOTS, ...configuredRoots]) {
    const normalized = resolve5(expandHome(root));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}
function resolveSourceSkillPath(sourceSkill, env2 = process.env) {
  if (!sourceSkill) return void 0;
  const expanded = expandHome(sourceSkill);
  const direct = resolve5(expanded);
  if (existsSync6(direct)) return direct;
  const name = basename5(sourceSkill);
  const roots = sourceSkillRoots(env2);
  for (const root of roots) {
    const candidate = join8(root, name);
    if (existsSync6(candidate)) return candidate;
  }
  const searched = roots.length ? ` Searched roots: ${roots.join(", ")}.` : "";
  const hint = `${searched} Add project-specific roots with ${PROJECT_SOURCE_SKILL_ROOTS_ENV}.`;
  throw new Error(`Source skill not found: ${sourceSkill}.${hint}`);
}
function planProjectInit(input) {
  if (!input.name.trim()) throw new Error("Project name is required");
  const slug = input.projectSlug === void 0 ? validateSafePathSegment(slugifyProjectName(input.name), "Project slug") : validateSafePathSegment(input.projectSlug, "Project slug");
  const agentRole = normalizeAgentRole(input.agentRole);
  const registryPath2 = resolve5(projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }));
  const registry = loadProjectRegistry(registryPath2);
  const now = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
  const targetDir = resolve5(input.targetDir ?? defaultProjectTargetDir(input.name, input.cwd));
  const identifier = (input.projectIdentifier ?? deriveProjectIdentifier(input.name)).toUpperCase();
  const existing = getOwnRecordValue(registry.projects, slug);
  const sourceSkillPath = resolveSourceSkillPath(input.sourceSkill);
  const overwrite = input.overwrite ?? input.force ?? false;
  const agents = createSafeRecord(Object.entries(existing?.agents ?? {}));
  if (input.provisionAgent) {
    agents[agentRole] = {
      role: agentRole,
      provisioning_state: "planned"
    };
  }
  const scaffold = input.scaffold ?? true;
  const candidateProject = {
    ...existing ?? {},
    name: input.name,
    slug,
    repo_path: targetDir,
    description: input.description ?? "",
    // A project the CLI is bootstrapping is being worked on right now, so a
    // NEW record starts "active" (PJAN-26). This is a default for new records,
    // NOT a migration: an already-registered project keeps whatever lifecycle
    // status it has ("planned"/"active"/"archived"), so re-running init (or the
    // sync path) never rewrites it.
    // NOTE: unrelated to `ticket_provider.state` and `agents.*.provisioning_state`,
    // which are different lifecycles and still default to "planned".
    status: existing?.status ?? DEFAULT_NEW_PROJECT_STATUS,
    source_artifacts: sourceSkillPath ? [{ kind: "skill", path: sourceSkillPath, package_name: input.packageName ?? slug }] : [],
    template: {
      commonproject: {
        enabled: true,
        primary_language: input.primaryLanguage ?? "python"
      }
    },
    ticket_provider: buildTicketProviderBlock({
      type: input.ticketProvider ?? "plane",
      identifier,
      // A board provisioned by an earlier run lives in the registry, not in the
      // CLI flags — inherit it so re-running init re-links instead of minting a
      // second board.
      boardId: input.boardId ?? input.planeProjectId ?? (existing?.ticket_provider?.board_id || void 0),
      workspace: input.boardWorkspace ?? input.planeWorkspace
    }),
    agents,
    automation: existing?.automation ?? defaultProjectAutomation(),
    notebook: existing?.notebook ? { ...existing.notebook, notebook_name: input.name.trim() } : { state: "planned", notebook_name: input.name.trim() },
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  const project = {
    ...candidateProject,
    updated_at: projectRecordEquivalent(existing, candidateProject) ? existing.updated_at : now
  };
  validateNoDuplicateProject(registry, project, overwrite);
  const pjanglerRoot = resolve5(input.pjanglerRoot ?? resolvePjanglerRoot());
  const manifest = projectManifestFromRegistryProject(project);
  const apply = input.apply ?? false;
  const live = input.live ?? false;
  const provisionRuntimeRepo = input.provisionRuntimeRepo ?? live;
  const provisionTicketBoard = input.provisionTicketBoard ?? live;
  const enableSystemd = input.enableSystemd ?? live;
  const skipPlane = input.skipPlane ?? false;
  const boardEnabled = live && provisionTicketBoard && !skipPlane;
  const runtimeRepoEnabled = live && provisionRuntimeRepo;
  const systemdEnabled = live && enableSystemd && process.platform !== "darwin";
  const anyExternalAgentEffect = runtimeRepoEnabled || boardEnabled || systemdEnabled;
  const actions = [
    { kind: "registry.upsert", registryPath: registryPath2, slug, project }
  ];
  if (scaffold) {
    actions.push(buildCommonProjectCopierAction({
      pjanglerRoot,
      targetDir,
      projectName: project.name,
      projectDescription: project.description,
      projectSlug: project.slug,
      ticketProvider: project.ticket_provider.type,
      planeWorkspace: project.ticket_provider.workspace ?? "33god",
      planeProjectId: project.ticket_provider.board_id ?? "",
      ticketWorkspace: project.ticket_provider.workspace ?? "",
      boardId: project.ticket_provider.board_id ?? "",
      projectIdentifier: identifier,
      primaryLanguage: project.template.commonproject.primary_language,
      agentHooksLayer: resolveAgentHooksLayer2(input.agentHooksLayer),
      overwrite
    }));
  }
  actions.push(
    { kind: "project.write-manifest", path: join8(targetDir, ".project.json"), manifest },
    {
      kind: "ticket-provider.create-or-link",
      enabled: boardEnabled,
      live,
      provider: project.ticket_provider.type,
      workspace: project.ticket_provider.workspace ?? "33god",
      identifier,
      repoPath: targetDir,
      boardName: project.name,
      description: project.description || `Ticket board for ${project.slug}`,
      boardId: project.ticket_provider.board_id ?? "",
      state: project.ticket_provider.board_id ? "linked" : "planned",
      reason: skipPlane ? "ticket-provider action disabled by skipPlane=true" : project.ticket_provider.board_id ? "board already linked; no provider call" : !live ? "network/cloud actions require --live" : !provisionTicketBoard ? "ticket-provider action requires explicit provisionTicketBoard=true" : `create or link the ${project.ticket_provider.type} board "${project.name}" (${identifier}) via the ticket-provider adapter`
    },
    {
      kind: "hermes.provision-agent",
      enabled: input.provisionAgent ?? false,
      local: !anyExternalAgentEffect,
      targetDir,
      targetRepo: slug,
      role: agentRole,
      context: {
        skipRuntimeRepo: !runtimeRepoEnabled,
        skipPlane: !boardEnabled,
        // Per-agent Bloodbank consumers are retired. Agent ingress always
        // stays on the fleet-shared gateway, regardless of live/local mode.
        skipBloodbank: true,
        skipSystemd: !systemdEnabled
      }
    }
  );
  return {
    ok: true,
    apply,
    dryRun: !apply,
    live,
    registryPath: registryPath2,
    project,
    manifest,
    actions,
    ...input.boardUrl !== void 0 ? { warnings: [BOARD_URL_DEPRECATION_WARNING] } : {}
  };
}
function linkTicketProviderBoard(plan, action, boardId) {
  const block = buildTicketProviderBlock({
    type: action.provider,
    identifier: action.identifier,
    boardId,
    workspace: action.workspace
  });
  plan.project.ticket_provider = block;
  const manifestProvider = {
    type: block.type,
    workspace: block.workspace ?? "",
    identifier: block.identifier ?? "",
    board_id: block.board_id ?? "",
    state: block.state ?? "linked"
  };
  plan.manifest.ticket_provider = manifestProvider;
  action.boardId = boardId;
  action.state = manifestProvider.state;
  const manifestPath = join8(action.repoPath, ".project.json");
  let next;
  if (existsSync6(manifestPath)) {
    let existing = {};
    try {
      const parsed = JSON.parse(readFileSync6(manifestPath, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      existing = {};
    }
    const existingProvider = isRecord(existing.ticket_provider) ? existing.ticket_provider : {};
    next = { ...existing, ticket_provider: { ...existingProvider, ...manifestProvider } };
  } else {
    mkdirSync4(dirname5(manifestPath), { recursive: true });
    next = plan.manifest;
  }
  const text3 = `${JSON.stringify(next, null, 2)}
`;
  if (!existsSync6(manifestPath) || readFileSync6(manifestPath, "utf8") !== text3) {
    writeFileSync4(manifestPath, text3, "utf8");
    return [manifestPath];
  }
  return [];
}
async function executeProjectInitPlan(plan, options = {}) {
  const logs = [];
  const errors = [];
  const changedFiles = [];
  if (!plan.apply) return { ok: true, plan, logs, errors, changedFiles };
  const registry = loadProjectRegistry(plan.registryPath);
  let pendingRegistryAction;
  for (const action of plan.actions) {
    if (action.kind === "copier.copy.commonproject") {
      if (options.requireTrustedCopier && !options.trustedCopier) {
        errors.push("MCP project apply requires a preflight-attested Copier identity");
        break;
      }
      if (options.trustedCopier) {
        const verified = verifyTrustedCopierIdentity(options.trustedCopier);
        if (!verified.ok) {
          errors.push(`Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`);
          break;
        }
      }
      logs.push(
        action.data.agent_hooks_layer === "false" ? "commonproject: agent-hooks layer skipped (global ~/.agents/hooks detected \u2014 no per-user CLI injection)" : "commonproject: agent-hooks layer included"
      );
      mkdirSync4(dirname5(action.targetDir), { recursive: true });
      const before = snapshotTree(action.targetDir);
      const copierExecutable = options.trustedCopier?.executable ?? action.command[0];
      const copierEnv = options.trustedCopier ? { ...process.env } : void 0;
      if (copierEnv) {
        delete copierEnv.PYTHONHOME;
        delete copierEnv.PYTHONPATH;
        copierEnv.PYTHONNOUSERSITE = "1";
        copierEnv.PYTHONSAFEPATH = "1";
      }
      const result2 = spawnSync2(copierExecutable, action.command.slice(1), {
        encoding: "utf8",
        cwd: action.cwd,
        ...copierEnv ? { env: copierEnv } : {}
      });
      const copierChanges = changedTreePaths(action.targetDir, before, snapshotTree(action.targetDir));
      changedFiles.push(...copierChanges);
      if (result2.stdout?.trim()) logs.push(result2.stdout.trim());
      if (result2.stderr?.trim()) logs.push(result2.stderr.trim());
      if (result2.error) {
        const code = result2.error.code;
        errors.push(
          code === "ENOENT" ? "copier not found on PATH. Install with: uv tool install copier or pip install copier" : `copier failed: ${result2.error.message}`
        );
        break;
      }
      if (result2.status !== 0) {
        errors.push(`copier exited with status ${result2.status ?? "unknown"}`);
        break;
      }
    } else if (action.kind === "project.write-manifest") {
      mkdirSync4(dirname5(action.path), { recursive: true });
      let value = action.manifest;
      if (existsSync6(action.path)) {
        try {
          const currentValue = JSON.parse(readFileSync6(action.path, "utf8"));
          if (isRecord(currentValue)) {
            const currentNotebook = isRecord(currentValue.notebook) ? currentValue.notebook : {};
            const desiredNotebook = isRecord(value.notebook) ? value.notebook : {};
            value = {
              ...currentValue,
              ...value,
              ticket_provider: { ...isRecord(currentValue.ticket_provider) ? currentValue.ticket_provider : {}, ...isRecord(value.ticket_provider) ? value.ticket_provider : {} },
              agents: { ...isRecord(currentValue.agents) ? currentValue.agents : {}, ...isRecord(value.agents) ? value.agents : {} },
              ...value.notebook ? {
                notebook: {
                  ...currentNotebook,
                  ...desiredNotebook,
                  ...isRecord(desiredNotebook.binding) ? { binding: { ...isRecord(currentNotebook.binding) ? currentNotebook.binding : {}, ...desiredNotebook.binding } } : {},
                  ...isRecord(desiredNotebook.policy) ? { policy: { ...isRecord(currentNotebook.policy) ? currentNotebook.policy : {}, ...desiredNotebook.policy } } : {}
                }
              } : {}
            };
          }
        } catch {
        }
      }
      const next = `${JSON.stringify(value, null, 2)}
`;
      const current = existsSync6(action.path) ? readFileSync6(action.path, "utf8") : void 0;
      if (current !== next) {
        writeFileSync4(action.path, next, "utf8");
        changedFiles.push(action.path);
      }
      changedFiles.push(...synchronizeCopierIdentity(action.path, action.manifest));
    } else if (action.kind === "registry.upsert") {
      pendingRegistryAction = action;
    } else if (action.kind === "ticket-provider.create-or-link") {
      if (!action.enabled) {
        logs.push(`ticket-provider.create-or-link skipped (${action.reason ?? "disabled by plan"})`);
      } else if (action.boardId) {
        logs.push(`ticket-provider: ${action.provider} board already linked (${action.identifier} \u2192 ${action.boardId}); nothing to create`);
      } else {
        const outcome = provisionTicketProviderBoard(action);
        logs.push(...outcome.logs);
        if (!outcome.ok) {
          errors.push(outcome.error ?? `ticket-provider: ${action.provider} board provisioning failed`);
        } else if (outcome.boardId) {
          changedFiles.push(...linkTicketProviderBoard(plan, action, outcome.boardId));
          pendingRegistryAction ??= {
            kind: "registry.upsert",
            registryPath: plan.registryPath,
            slug: plan.project.slug,
            project: plan.project
          };
        }
      }
    } else if (action.kind === "hermes.provision-agent") {
      logs.push(action.enabled ? "hermes.provision-agent planned for the caller to execute" : "hermes.provision-agent skipped");
    }
  }
  if (pendingRegistryAction && errors.length === 0) {
    if (!projectRecordEquivalent(getOwnRecordValue(registry.projects, pendingRegistryAction.slug), pendingRegistryAction.project)) {
      registry.projects[pendingRegistryAction.slug] = pendingRegistryAction.project;
      saveProjectRegistry(registry, pendingRegistryAction.registryPath);
      changedFiles.push(pendingRegistryAction.registryPath);
      if (isPgRegistryEnabled()) {
        try {
          const pgStore = new PgRegistryStore(pgRegistryConfigFromEnv());
          await pgStore.save(registry);
          await pgStore.close();
          logs.push("registry: PG dual-write complete");
        } catch (pgErr) {
          logs.push(`registry: PG dual-write failed (yaml is authoritative): ${pgErr instanceof Error ? pgErr.message : pgErr}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, plan, logs, errors, changedFiles: [...new Set(changedFiles)].sort() };
}
function projectManifestFromRegistryProject(project) {
  const agents = Object.fromEntries(
    Object.entries(project.agents).map(([name, agent]) => [
      `${project.slug}-${name}`,
      {
        role: agent.role,
        role_dir: agent.role_dir,
        provisioning_state: agent.provisioning_state
      }
    ])
  );
  return {
    project_name: project.name,
    project_description: project.description,
    project_slug: project.slug,
    repo_path: project.repo_path,
    ticket_provider: {
      type: project.ticket_provider.type,
      workspace: project.ticket_provider.workspace ?? "",
      identifier: project.ticket_provider.identifier ?? "",
      board_id: project.ticket_provider.board_id ?? "",
      state: project.ticket_provider.state
    },
    agents,
    automation: project.automation ?? defaultProjectAutomation(),
    ...project.notebook ? { notebook: { binding: { ...project.notebook } } } : {}
  };
}
function formatProjectInitPlan(plan) {
  const lines = [""];
  const title = `${bold(plan.project.name)} ${dim(`(${plan.project.slug})`)}`;
  lines.push(`  ${cyan(bold(glyph.chevron))} ${title}${plan.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim("registry".padEnd(8))} ${dim(plan.registryPath)}`);
  lines.push(`  ${dim("target".padEnd(8))} ${dim(plan.project.repo_path)}`);
  for (const warning of plan.warnings ?? []) lines.push(`  ${yellow(glyph.warn)} ${warning}`);
  lines.push("");
  lines.push(`  ${bold("Actions")} ${dim(`(${plan.actions.length})`)}`);
  if (!plan.actions.length) lines.push(`     ${dim("(nothing to do)")}`);
  for (const action of plan.actions) {
    lines.push(`     ${cyan(glyph.bullet)} ${action.kind}`);
    if (action.kind === "copier.copy.commonproject") lines.push(`        ${dim(`target: ${action.targetDir}`)}`);
    if (action.kind === "project.write-manifest") lines.push(`        ${dim(`path: ${action.path}`)}`);
    if (action.kind === "ticket-provider.create-or-link") {
      const target = [action.provider, action.workspace, action.identifier].filter(Boolean).join("/");
      lines.push(`        ${dim(`board: ${target}  ${glyph.dot}  ${action.boardName}`)}`);
      lines.push(`        ${dim(`state: ${action.state}${action.boardId ? ` (${action.boardId})` : ""}`)}`);
      if (action.reason) lines.push(`        ${dim(`note: ${action.reason}`)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function formatProjectList(registry, activityByPath = /* @__PURE__ */ new Map()) {
  const ageOf = (project) => activityByPath.get(project.repo_path);
  const projects = Object.values(registry.projects).sort((a, b) => {
    const left = ageOf(a)?.updatedUnix ?? -1;
    const right = ageOf(b)?.updatedUnix ?? -1;
    if (left !== right) return right - left;
    return a.slug.localeCompare(b.slug);
  });
  if (!projects.length) return `
  ${dim("No projects registered.")}
`;
  const relativeOf = (project) => ageOf(project)?.relative ?? "never";
  const slugWidth = projects.reduce((width, project) => Math.max(width, project.slug.length), 0);
  const idWidth = projects.reduce((width, project) => Math.max(width, String(project.ticket_provider.identifier ?? "").length), 0);
  const ageWidth = projects.reduce((width, project) => Math.max(width, relativeOf(project).length), 0);
  const lines = ["", `  ${bold("Projects")} ${dim(`(${projects.length})`)}  ${dim("newest work first")}`, ""];
  for (const project of projects) {
    const activity = ageOf(project);
    const slug = bold(project.slug.padEnd(slugWidth));
    const identifier = cyan(String(project.ticket_provider.identifier ?? "").padEnd(idWidth));
    const padded = relativeOf(project).padEnd(ageWidth);
    const age = activity?.active ? green(padded) : activity?.updatedUnix ? yellow(padded) : dim(padded);
    lines.push(`  ${slug}  ${identifier}  ${age}  ${dim(project.repo_path)}`);
  }
  lines.push("");
  return lines.join("\n");
}
function getProject(registry, slug) {
  const project = getOwnRecordValue(registry.projects, slug);
  if (!project) throw new Error(`Project not found in registry: ${slug}`);
  return project;
}
function doctorProjectRegistry(registryPath2 = projectRegistryPath(), slug) {
  const issues = [];
  const registry = loadProjectRegistry(registryPath2);
  const projects = slug ? [[slug, getProject(registry, slug)]] : Object.entries(registry.projects);
  for (const [projectSlug, project] of projects) {
    if (!existsSync6(project.repo_path)) {
      issues.push({ level: "warn", slug: projectSlug, message: `repo_path does not exist: ${project.repo_path}` });
    } else if (!statSync2(project.repo_path).isDirectory()) {
      issues.push({ level: "error", slug: projectSlug, message: `repo_path is not a directory: ${project.repo_path}` });
    } else {
      const manifestPath = join8(project.repo_path, ".project.json");
      if (!existsSync6(manifestPath)) issues.push({ level: "warn", slug: projectSlug, message: ".project.json is missing" });
    }
    for (const artifact of project.source_artifacts) {
      if (artifact.path && !existsSync6(artifact.path)) {
        issues.push({ level: "warn", slug: projectSlug, message: `source artifact missing: ${artifact.path}` });
      }
    }
  }
  return {
    ok: !issues.some((issue) => issue.level === "error"),
    registryPath: registryPath2,
    checkedProjects: projects.map(([projectSlug]) => projectSlug),
    issues
  };
}
function buildCommonProjectCopierAction(input) {
  const templateDir = join8(input.pjanglerRoot, "templates", "commonproject");
  const data = {
    project_name: input.projectName,
    project_description: input.projectDescription ?? "",
    project_slug: input.projectSlug,
    ticket_provider: input.ticketProvider,
    plane_workspace: input.planeWorkspace,
    plane_project_id: input.planeProjectId ?? "",
    ticket_workspace: input.ticketWorkspace ?? input.planeWorkspace,
    board_id: input.boardId ?? input.planeProjectId ?? "",
    project_identifier: input.projectIdentifier,
    primary_language: input.primaryLanguage,
    agent_hooks_layer: input.agentHooksLayer ?? true ? "true" : "false"
  };
  const command = ["copier", "copy", "--trust", "--vcs-ref=HEAD", templateDir, input.targetDir, "--defaults"];
  for (const [key, value] of Object.entries(data)) command.push("--data", `${key}=${value}`);
  if (input.overwrite) command.push("--overwrite");
  return {
    kind: "copier.copy.commonproject",
    cwd: input.pjanglerRoot,
    command,
    targetDir: input.targetDir,
    data,
    overwrite: input.overwrite
  };
}
function resolvePjanglerRoot() {
  let dir = dirname5(fileURLToPath2(import.meta.url));
  while (dir !== dirname5(dir)) {
    if (existsSync6(join8(dir, "package.json")) && existsSync6(join8(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname5(dir);
  }
  return resolve5(process.cwd());
}
function validateNoDuplicateProject(registry, project, overwrite) {
  const existingSameSlug = getOwnRecordValue(registry.projects, project.slug);
  if (existingSameSlug && !overwrite && resolve5(existingSameSlug.repo_path) !== resolve5(project.repo_path)) {
    throw new Error(`Project slug already exists in registry: ${project.slug}`);
  }
  for (const [slug, existing] of Object.entries(registry.projects)) {
    if (slug === project.slug) continue;
    if (resolve5(existing.repo_path) === resolve5(project.repo_path)) {
      throw new Error(`Project repo_path already registered by ${slug}: ${project.repo_path}`);
    }
    if (existing.ticket_provider.identifier && existing.ticket_provider.identifier.toUpperCase() === project.ticket_provider.identifier?.toUpperCase()) {
      throw new Error(`Project identifier already registered by ${slug}: ${project.ticket_provider.identifier}`);
    }
  }
}
function validateProjectRecord(project, key) {
  validateSafePathSegment(key, `Project registry key ${key}`);
  if (!isRecord(project)) throw new Error(`Project ${key} must be a mapping`);
  if (!project.name) throw new Error(`Project ${key} missing name`);
  if (!project.slug) throw new Error(`Project ${key} missing slug`);
  validateSafePathSegment(project.slug, `Project ${key} slug`);
  if (project.slug !== key) throw new Error(`Project key ${key} does not match slug ${project.slug}`);
  if (!project.repo_path) throw new Error(`Project ${key} missing repo_path`);
  if (!Array.isArray(project.source_artifacts)) throw new Error(`Project ${key} source_artifacts must be a list`);
  if (!isRecord(project.ticket_provider)) throw new Error(`Project ${key} ticket_provider must be a mapping`);
  if (!isRecord(project.agents)) throw new Error(`Project ${key} agents must be a mapping`);
  if (project.notebook !== void 0) {
    if (!isRecord(project.notebook)) throw new Error(`Project ${key} notebook must be a mapping`);
    const credentialPath = notebookCredentialMaterialPath(project.notebook);
    if (credentialPath) throw new Error(`Project ${key} Notebook binding contains forbidden credential material at ${credentialPath}`);
    if (project.notebook.state !== "disabled" && project.notebook.state !== "planned" && project.notebook.state !== "linked") throw new Error(`Project ${key} notebook state is invalid`);
    if (project.notebook.state === "linked" && (!project.notebook.notebook_id || !project.notebook.overview_note_id)) throw new Error(`Project ${key} linked notebook is missing stable IDs`);
    for (const field2 of ["notebook_id", "notebook_name", "overview_note_id", "blocked_reason"]) {
      const value = project.notebook[field2];
      if (value !== void 0 && (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error(`Project ${key} notebook.${field2} is invalid`);
    }
  }
  for (const [agentKey, agent] of Object.entries(project.agents)) {
    validateSafePathSegment(agentKey, `Project ${key} agent key ${agentKey}`);
    if (!isRecord(agent)) throw new Error(`Project ${key} agent ${agentKey} must be a mapping`);
    if (typeof agent.role !== "string" || !agent.role) throw new Error(`Project ${key} agent ${agentKey} missing role`);
    validateSafePathSegment(agent.role, `Project ${key} agent ${agentKey} role`);
  }
}
function expandHome(path) {
  if (path === "~") return homedir4();
  if (path.startsWith("~/")) return join8(homedir4(), path.slice(2));
  return path;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var PROJECT_REGISTRY_ENV, PROJECT_SOURCE_SKILL_ROOTS_ENV, TICKET_PROVIDER_ADAPTERS_ENV, PROJECT_REGISTRY_SCHEMA_VERSION, DEFAULT_NEW_PROJECT_STATUS, BOARD_URL_DEPRECATION_WARNING, DEFAULT_SOURCE_SKILL_ROOTS, PROJECT_REGISTRY_OWNED_KEYS, PROJECT_NOTEBOOK_OWNED_KEYS, TICKET_PROVIDER_OWNED_KEYS, GLOBAL_NOTEBOOK_OWNED_KEYS, GLOBAL_NOTEBOOK_AUTH_OWNED_KEYS, GLOBAL_NOTEBOOK_DEFAULTS_OWNED_KEYS, GLOBAL_NOTEBOOK_LIMITS_OWNED_KEYS, GLOBAL_NOTEBOOK_SUMMARIZER_OWNED_KEYS, SAFE_PATH_SEGMENT;
var init_project = __esm({
  "src/project/index.ts"() {
    "use strict";
    init_types();
    init_style();
    init_tree_diff();
    init_preflight();
    init_RegistryStore();
    PROJECT_REGISTRY_ENV = "PJ_PROJECT_REGISTRY";
    PROJECT_SOURCE_SKILL_ROOTS_ENV = "PJ_SOURCE_SKILL_ROOTS";
    TICKET_PROVIDER_ADAPTERS_ENV = "PJ_TICKET_PROVIDER_ADAPTERS";
    PROJECT_REGISTRY_SCHEMA_VERSION = 1;
    DEFAULT_NEW_PROJECT_STATUS = "active";
    BOARD_URL_DEPRECATION_WARNING = "boardUrl is deprecated and ignored; board URLs are derived at runtime and are never persisted.";
    DEFAULT_SOURCE_SKILL_ROOTS = [
      "/home/delorenj/code/skillex/all-skills",
      join8(homedir4(), ".agents", "skills"),
      join8(homedir4(), ".codex", "skills")
    ];
    PROJECT_REGISTRY_OWNED_KEYS = [
      "name",
      "slug",
      "repo_path",
      "description",
      "status",
      "source_artifacts",
      "template",
      "ticket_provider",
      "agents",
      "automation",
      "notebook",
      "created_at",
      "updated_at"
    ];
    PROJECT_NOTEBOOK_OWNED_KEYS = ["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"];
    TICKET_PROVIDER_OWNED_KEYS = ["type", "workspace", "identifier", "board_id", "board_url", "state"];
    GLOBAL_NOTEBOOK_OWNED_KEYS = ["base_url", "auth", "defaults", "limits", "summarizer"];
    GLOBAL_NOTEBOOK_AUTH_OWNED_KEYS = ["mode", "env_var"];
    GLOBAL_NOTEBOOK_DEFAULTS_OWNED_KEYS = ["enabled", "session_start_enabled", "session_capture_enabled", "overview_max_chars", "documentation_globs", "overview_references", "excluded_globs"];
    GLOBAL_NOTEBOOK_LIMITS_OWNED_KEYS = Object.keys(DEFAULT_NOTEBOOK_LIMITS);
    GLOBAL_NOTEBOOK_SUMMARIZER_OWNED_KEYS = ["executable", "args"];
    SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  }
});

// src/notebook/config.ts
import { randomUUID } from "node:crypto";
import { isIP as isIP2 } from "node:net";
import { closeSync as closeSync3, existsSync as existsSync13, fchmodSync as fchmodSync2, fsyncSync as fsyncSync2, lstatSync as lstatSync6, openSync as openSync3, readFileSync as readFileSync10, realpathSync as realpathSync4, renameSync as renameSync3, writeFileSync as writeFileSync8 } from "node:fs";
import { dirname as dirname7, resolve as resolve7 } from "node:path";
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function realOrResolved(path) {
  const absolute = resolve7(path);
  return existsSync13(absolute) ? realpathSync4(absolute) : absolute;
}
function readManifest(repoPath) {
  const path = resolve7(repoPath, ".project.json");
  if (!existsSync13(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync10(path, "utf8"));
  } catch {
    throw new NotebookError("INVALID_INPUT", `${path} is not valid JSON`);
  }
  if (!isRecord2(parsed)) return null;
  validateManifestNotebookSurface(parsed.notebook);
  return parsed;
}
function validateManifestNotebookSurface(value) {
  if (value === void 0) return;
  if (!isRecord2(value)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook must be a mapping");
  const credentialPath = notebookCredentialMaterialPath(value);
  if (credentialPath) throw new NotebookError("NOT_CONFIGURED", `Manifest Notebook configuration contains forbidden credential material at ${credentialPath}`);
  for (const key of Object.keys(value)) {
    if (!MANIFEST_NOTEBOOK_KEYS.has(key) && !key.startsWith("x_")) {
      throw new NotebookError("NOT_CONFIGURED", `Manifest notebook.${key} is not an allowed policy or binding projection field`);
    }
  }
  if (value.binding !== void 0 && !isRecord2(value.binding)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.binding must be a mapping");
  if (value.policy !== void 0) {
    if (!isRecord2(value.policy)) throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.policy must be a mapping");
    for (const key of Object.keys(value.policy)) {
      if (!MANIFEST_POLICY_KEYS.has(key) && !key.startsWith("x_")) throw new NotebookError("NOT_CONFIGURED", `Manifest notebook.policy.${key} is not an allowed policy field`);
    }
  }
}
function resolveNotebookProject(repoArg = process.cwd(), registryFile = projectRegistryPath()) {
  const registry = loadProjectRegistry(registryFile);
  const requested = realOrResolved(repoArg);
  const matches = Object.values(registry.projects).filter((project2) => realOrResolved(project2.repo_path) === requested);
  if (matches.length === 0) throw new NotebookError("NOT_FOUND", `Repository is not registered: ${requested}`);
  if (matches.length > 1) throw new NotebookError("CONFLICT", `More than one Registry project maps to repository: ${requested}`);
  const project = matches[0];
  return { registry, project, manifest: readManifest(project.repo_path), registry_path: registryFile };
}
function resolveNotebookProjectBySlug(projectSlug, registryFile = projectRegistryPath()) {
  const registry = loadProjectRegistry(registryFile);
  const project = getOwnRecordValue(registry.projects, projectSlug);
  if (!project) throw new NotebookError("NOT_FOUND", `Project is not registered: ${projectSlug}`);
  return { registry, project, manifest: readManifest(project.repo_path), registry_path: registryFile };
}
function validateNotebookBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url may not contain credentials, query parameters, or a fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const loopback = hostname === "localhost" || unbracketed === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(unbracketed);
  if (isIP2(unbracketed) !== 0 && !loopback) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url may not use a numeric non-loopback host");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook base_url must use HTTPS or loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}
function validateNotebookAuth(value) {
  if (value == null) return { mode: "none" };
  if (!isRecord2(value) || value.mode !== "none" && value.mode !== "environment") {
    throw new NotebookError("NOT_CONFIGURED", "Notebook auth.mode must be none or environment");
  }
  if (value.mode === "none") return { mode: "none" };
  if (typeof value.env_var !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value.env_var)) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook auth.env_var must be a safe environment variable name");
  }
  if (value.env_var !== "OPEN_NOTEBOOK_PASSWORD") {
    throw new NotebookError("NOT_CONFIGURED", "Notebook hooks support only auth.env_var OPEN_NOTEBOOK_PASSWORD");
  }
  return { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" };
}
function positiveInteger(value, fallback2, name) {
  if (value === void 0) return fallback2;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new NotebookError("NOT_CONFIGURED", `Notebook limit ${name} must be a finite positive integer`);
  return Number(value);
}
function resolveNotebookLimits(overrides = {}) {
  const result2 = { ...DEFAULT_NOTEBOOK_LIMITS };
  for (const key of Object.keys(DEFAULT_NOTEBOOK_LIMITS)) {
    if (key === "schema_version") continue;
    result2[key] = positiveInteger(overrides[key], DEFAULT_NOTEBOOK_LIMITS[key], key);
  }
  result2.schema_version = NOTEBOOK_SCHEMA_VERSION;
  if (result2.receipt_max_bytes > result2.unresolved_receipt_max_bytes) {
    throw new NotebookError("NOT_CONFIGURED", "receipt_max_bytes may not exceed unresolved_receipt_max_bytes");
  }
  if (result2.hook_payload_max_bytes > DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes) {
    throw new NotebookError("NOT_CONFIGURED", "hook_payload_max_bytes may tighten but not exceed the packaged absolute ceiling");
  }
  if (result2.note_detail_fetch_concurrency > DEFAULT_NOTEBOOK_LIMITS.note_detail_fetch_concurrency) {
    throw new NotebookError("NOT_CONFIGURED", "note_detail_fetch_concurrency may tighten but not exceed the packaged fanout ceiling");
  }
  if (result2.lease_seconds * 1e3 <= result2.overall_timeout_ms) {
    throw new NotebookError("NOT_CONFIGURED", "lease_seconds must exceed one bounded remote request timeout so workers can renew without overlap");
  }
  return result2;
}
function stringList(value, fallback2, name) {
  if (value === void 0) return [...fallback2];
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 512)) {
    throw new NotebookError("NOT_CONFIGURED", `Notebook policy ${name} must be a bounded string list`);
  }
  return [...value];
}
function resolvePolicy(globalDefaults, manifestPolicy, limits) {
  const global = isRecord2(globalDefaults) ? globalDefaults : {};
  const local = isRecord2(manifestPolicy) ? manifestPolicy : {};
  const pick = (key) => Object.hasOwn(local, key) ? local[key] : global[key];
  const boolean = (key, fallback2) => {
    const value = pick(key);
    if (value === void 0) return fallback2;
    if (typeof value !== "boolean") throw new NotebookError("NOT_CONFIGURED", `Notebook policy ${key} must be boolean`);
    return value;
  };
  const overview = positiveInteger(pick("overview_max_chars"), limits.overview_max_chars, "overview_max_chars");
  if (overview > limits.note_max_bytes) throw new NotebookError("NOT_CONFIGURED", "overview_max_chars exceeds the note ceiling");
  return {
    enabled: boolean("enabled", DEFAULT_POLICY.enabled),
    session_start_enabled: boolean("session_start_enabled", DEFAULT_POLICY.session_start_enabled),
    session_capture_enabled: boolean("session_capture_enabled", DEFAULT_POLICY.session_capture_enabled),
    overview_max_chars: overview,
    documentation_globs: stringList(pick("documentation_globs"), [...DEFAULT_POLICY.documentation_globs], "documentation_globs"),
    ...pick("overview_references") !== void 0 ? { overview_references: stringList(pick("overview_references"), [], "overview_references") } : {},
    ...pick("excluded_globs") !== void 0 ? { excluded_globs: stringList(pick("excluded_globs"), [], "excluded_globs") } : {}
  };
}
function projectNotebook(project) {
  const raw = project.notebook;
  if (!isRecord2(raw)) return { binding: { state: "disabled" }, policy: { enabled: false } };
  const bindingRaw = isRecord2(raw.binding) ? raw.binding : raw;
  const state = bindingRaw.state;
  if (state !== "disabled" && state !== "planned" && state !== "linked") {
    throw new NotebookError("NOT_CONFIGURED", `Project ${project.slug} notebook binding state is invalid`);
  }
  const binding = { ...bindingRaw, state };
  for (const key of ["notebook_id", "notebook_name", "overview_note_id", "blocked_reason"]) {
    if (binding[key] !== void 0 && (typeof binding[key] !== "string" || binding[key].length > 512)) {
      throw new NotebookError("NOT_CONFIGURED", `Project ${project.slug} notebook.${key} is invalid`);
    }
  }
  return { ...raw, binding, policy: isRecord2(raw.policy) ? raw.policy : void 0 };
}
function manifestNotebookPolicy(manifest) {
  if (!manifest) return void 0;
  const notebook = manifest.notebook;
  return isRecord2(notebook) ? notebook.policy : void 0;
}
function notebookDisplayName(resolved) {
  const raw = resolved.manifest && resolved.manifest.notebook;
  const override = isRecord2(raw) ? raw.display_name : void 0;
  if (override !== void 0) {
    if (typeof override !== "string" || !override.trim() || override.length > 512 || /[\u0000-\u001f\u007f]/u.test(override)) {
      throw new NotebookError("NOT_CONFIGURED", "Manifest notebook.display_name must be a bounded display name without control characters");
    }
    return override.trim();
  }
  if (!resolved.project.name.trim() || resolved.project.name.length > 512 || /[\u0000-\u001f\u007f]/u.test(resolved.project.name)) {
    throw new NotebookError("NOT_CONFIGURED", "Project name cannot supply a safe Companion Notebook display name");
  }
  return resolved.project.name.trim();
}
function resolveEffectiveNotebookConfig(resolved) {
  const globalRaw = resolved.registry.notebook;
  const global = isRecord2(globalRaw) ? globalRaw : {};
  const project = projectNotebook(resolved.project);
  const limits = resolveNotebookLimits(isRecord2(global.limits) ? global.limits : {});
  const declared = isRecord2(resolved.project.notebook);
  const localPolicy = manifestNotebookPolicy(resolved.manifest);
  const resolvedPolicy = resolvePolicy(global.defaults, localPolicy, limits);
  const policy = declared ? resolvedPolicy : { ...resolvedPolicy, enabled: false };
  const baseUrl = typeof global.base_url === "string" && global.base_url.trim() ? validateNotebookBaseUrl(global.base_url) : null;
  const auth = validateNotebookAuth(global.auth);
  let summarizer;
  if (global.summarizer !== void 0) {
    if (!isRecord2(global.summarizer) || typeof global.summarizer.executable !== "string" || !global.summarizer.executable.startsWith("/") || global.summarizer.executable.includes("\0") || Buffer.byteLength(global.summarizer.executable, "utf8") > 1024) {
      throw new NotebookError("NOT_CONFIGURED", "Notebook summarizer executable must be a bounded absolute path");
    }
    const rawArgs = global.summarizer.args ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > 32 || rawArgs.some((item) => typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item, "utf8") > 1024)) {
      throw new NotebookError("NOT_CONFIGURED", "Notebook summarizer argv must be a bounded string list");
    }
    summarizer = { executable: global.summarizer.executable, args: [...rawArgs] };
  }
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: resolved.project.slug,
    repo_path: realOrResolved(resolved.project.repo_path),
    base_url: baseUrl,
    auth,
    policy,
    limits,
    binding: project.binding,
    configuration_provenance: {
      base_url: baseUrl ? "registry-global" : "default",
      auth: global.auth ? "registry-global" : "default",
      policy: localPolicy ? "manifest-policy" : global.defaults ? "registry-global" : "default",
      binding: "project-registry",
      limits: global.limits ? "registry-global" : "default"
    },
    ...summarizer ? { summarizer } : {}
  };
}
function loadEffectiveNotebookConfig(repoArg = process.cwd(), registryFile = projectRegistryPath()) {
  return resolveEffectiveNotebookConfig(resolveNotebookProject(repoArg, registryFile));
}
function runtimeNotebookCredential(config, env2 = process.env) {
  if (config.auth.mode !== "environment") return void 0;
  const value = env2[config.auth.env_var];
  if (!value) throw new NotebookError("NOT_CONFIGURED", `Notebook auth environment variable ${config.auth.env_var} is not set`);
  return value;
}
function requireRemoteNotebookConfig(config) {
  if (!config.policy.enabled) throw new NotebookError("NOT_CONFIGURED", "Project Notebook is disabled for this repository");
  if (!config.base_url) throw new NotebookError("NOT_CONFIGURED", "Notebook base_url is not configured");
  return config.base_url;
}
function persistProjectNotebookBinding(resolved, binding, policy) {
  const changed = [];
  const manifestPath = resolve7(resolved.project.repo_path, ".project.json");
  const manifestRaw = existsSync13(manifestPath) ? JSON.parse(readFileSync10(manifestPath, "utf8")) : {};
  if (!isRecord2(manifestRaw)) throw new NotebookError("INVALID_INPUT", `${manifestPath} must contain a JSON object`);
  validateManifestNotebookSurface(manifestRaw.notebook);
  const manifestNotebook2 = isRecord2(manifestRaw.notebook) ? manifestRaw.notebook : {};
  const previousBinding = isRecord2(manifestNotebook2.binding) ? manifestNotebook2.binding : {};
  const foreignBinding = Object.fromEntries(Object.entries(previousBinding).filter(([key]) => !["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"].includes(key)));
  const previousPolicy = isRecord2(manifestNotebook2.policy) ? manifestNotebook2.policy : {};
  const manifestNext = {
    ...manifestRaw,
    notebook: {
      ...manifestNotebook2,
      binding: { ...foreignBinding, ...binding },
      ...policy ? { policy: { ...previousPolicy, ...policy } } : {}
    }
  };
  const manifestText = `${JSON.stringify(manifestNext, null, 2)}
`;
  if (!existsSync13(manifestPath) || readFileSync10(manifestPath, "utf8") !== manifestText) {
    let mode = 420;
    if (existsSync13(manifestPath)) {
      const current2 = lstatSync6(manifestPath);
      if (!current2.isFile() || current2.isSymbolicLink()) throw new NotebookError("CONFLICT", `${manifestPath} must be a regular non-symlink file`);
      mode = current2.mode & 511;
    }
    const temp = resolve7(dirname7(manifestPath), `.${process.pid}.${randomUUID()}.project.json.tmp`);
    const fd = openSync3(temp, "wx", mode);
    try {
      writeFileSync8(fd, manifestText, "utf8");
      fchmodSync2(fd, mode);
      fsyncSync2(fd);
    } finally {
      closeSync3(fd);
    }
    renameSync3(temp, manifestPath);
    try {
      const directory = openSync3(dirname7(manifestPath), "r");
      try {
        fsyncSync2(directory);
      } finally {
        closeSync3(directory);
      }
    } catch {
    }
    changed.push(manifestPath);
  }
  const current = resolved.project.notebook;
  resolved.project.notebook = { ...isRecord2(current) ? current : { state: "planned" }, ...binding };
  const registryBefore = existsSync13(resolved.registry_path) ? readFileSync10(resolved.registry_path, "utf8") : null;
  saveProjectRegistry(resolved.registry, resolved.registry_path);
  const registryAfter = existsSync13(resolved.registry_path) ? readFileSync10(resolved.registry_path, "utf8") : null;
  if (registryBefore !== registryAfter) changed.push(resolved.registry_path);
  return changed;
}
function persistProjectNotebookDeclaration(resolved) {
  const current = resolved.project.notebook;
  const binding = isRecord2(current) ? projectNotebook(resolved.project).binding : { state: "planned", notebook_name: resolved.project.name };
  return persistProjectNotebookBinding(resolved, binding, {
    enabled: true,
    session_start_enabled: false,
    session_capture_enabled: false
  });
}
var DEFAULT_POLICY, MANIFEST_NOTEBOOK_KEYS, MANIFEST_POLICY_KEYS;
var init_config = __esm({
  "src/notebook/config.ts"() {
    "use strict";
    init_project();
    init_types();
    DEFAULT_POLICY = Object.freeze({
      enabled: true,
      session_start_enabled: false,
      session_capture_enabled: false,
      overview_max_chars: 4e3,
      documentation_globs: ["**/*.md", "**/*.mdx"]
    });
    MANIFEST_NOTEBOOK_KEYS = /* @__PURE__ */ new Set(["binding", "policy", "display_name"]);
    MANIFEST_POLICY_KEYS = /* @__PURE__ */ new Set(["enabled", "session_start_enabled", "session_capture_enabled", "overview_max_chars", "documentation_globs", "overview_references", "excluded_globs"]);
  }
});

// src/notebook/notes.ts
import { createHash as createHash5, randomUUID as randomUUID2 } from "node:crypto";
function canonicalJson(value) {
  if (value === void 0 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new NotebookError("INVALID_INPUT", "Canonical JSON value is not JSON-compatible");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === void 0) throw new NotebookError("INVALID_INPUT", "Canonical JSON value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === void 0 ? "null" : canonicalJson(item)).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function sha256Hex(value) {
  return createHash5("sha256").update(value).digest("hex");
}
function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}
function encodeNoteEnvelope(envelope) {
  validateNoteEnvelope(envelope);
  return `${NOTE_ENVELOPE_PREFIX}${base64UrlEncode(canonicalJson(envelope))} -->`;
}
function withNoteEnvelope(envelope, body) {
  return `${encodeNoteEnvelope(envelope)}
${body}`;
}
function parseNoteEnvelope(content, maxBytes = 16384) {
  const firstNewline = content.indexOf("\n");
  const prefixBytes = Buffer.byteLength(firstNewline >= 0 ? content.slice(0, firstNewline + 1) : content, "utf8");
  if (prefixBytes > maxBytes) return null;
  const match = NOTE_ENVELOPE_RE.exec(content);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > maxBytes) return null;
    const parsed = JSON.parse(decoded);
    validateNoteEnvelope(parsed);
    return { envelope: parsed, body: content.slice(match[0].length) };
  } catch {
    return null;
  }
}
function validateNoteEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note envelope");
  const envelope = value;
  if (envelope.schema_version !== NOTEBOOK_SCHEMA_VERSION) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Unsupported PJangler note envelope version");
  if (!isBoundedString(envelope.project_slug, 128) || !isBoundedString(envelope.logical_id, 256)) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note identity");
  }
  if (!["overview", "user-note", "document", "session-capture"].includes(envelope.kind)) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler note kind");
  }
  const allowed = /* @__PURE__ */ new Set(["schema_version", "project_slug", "kind", "logical_id", "source_path", "source_revision", "content_sha256", "session_key", "captured_at", "policy_version", "overview_descriptor"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "PJangler note envelope contains an unknown field");
  if (envelope.source_path !== void 0 && (!isBoundedString(envelope.source_path, 1024) || envelope.source_path.startsWith("/") || envelope.source_path.includes("\0") || envelope.source_path.split(/[\\/]/u).includes(".."))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler source path");
  if (envelope.source_revision !== void 0 && !isBoundedString(envelope.source_revision, 256)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler source revision");
  for (const [name, digest] of [["content_sha256", envelope.content_sha256], ["session_key", envelope.session_key]]) {
    if (digest !== void 0 && !/^[a-f0-9]{64}$/u.test(digest)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", `Invalid PJangler ${name}`);
  }
  if (envelope.captured_at !== void 0 && (typeof envelope.captured_at !== "string" || !Number.isFinite(Date.parse(envelope.captured_at)))) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler capture timestamp");
  if (envelope.policy_version !== void 0 && !isBoundedString(envelope.policy_version, 128)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid PJangler policy version");
  if (envelope.kind === "overview") {
    if (envelope.logical_id !== overviewLogicalId(envelope.project_slug)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview logical ID does not match project slug");
    validateOverviewDescriptor(envelope.overview_descriptor, envelope.project_slug);
  } else if (envelope.overview_descriptor !== void 0) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Only Overview notes may carry an Overview descriptor");
  if (envelope.kind === "user-note" && !/^user-note:v1:[a-f0-9-]{16,64}$/iu.test(envelope.logical_id)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid user-note logical ID");
  if ((envelope.kind === "document" || envelope.kind === "session-capture") && !/^[a-f0-9]{64}$/u.test(envelope.logical_id)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Invalid managed note logical ID");
  if (envelope.kind === "document" && (!envelope.source_path || !envelope.source_revision || !envelope.content_sha256 || !envelope.session_key || !envelope.captured_at || !envelope.policy_version)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Document envelope is missing required provenance");
  if (envelope.kind === "session-capture" && (!envelope.content_sha256 || !envelope.session_key || !envelope.captured_at || !envelope.policy_version)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Session capture envelope is missing required provenance");
}
function isBoundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function validateOverviewDescriptor(value, projectSlug) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview descriptor is missing or invalid");
  const descriptor = value;
  const allowed = /* @__PURE__ */ new Set(["schema_version", "project_slug", "project_name", "purpose", "references", "compiler_policy_version"]);
  if (Object.keys(descriptor).some((key) => !allowed.has(key)) || descriptor.schema_version !== 1 || descriptor.project_slug !== projectSlug || !isBoundedString(descriptor.project_name, 256) || !isBoundedString(descriptor.purpose, 4e3) || !isBoundedString(descriptor.compiler_policy_version, 128) || !Array.isArray(descriptor.references) || descriptor.references.length > 100) {
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview descriptor shape is invalid");
  }
  const paths = /* @__PURE__ */ new Set();
  for (const referenceValue of descriptor.references) {
    if (!referenceValue || typeof referenceValue !== "object" || Array.isArray(referenceValue)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview reference is invalid");
    const reference = referenceValue;
    const referenceAllowed = /* @__PURE__ */ new Set(["path", "status", "git_revision", "content_sha256", "reason"]);
    if (Object.keys(reference).some((key) => !referenceAllowed.has(key)) || !isBoundedString(reference.path, 1024) || String(reference.path).startsWith("/") || String(reference.path).split(/[\\/]/u).includes("..") || paths.has(String(reference.path)) || reference.status !== "present" && reference.status !== "missing") throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Overview reference shape is invalid");
    paths.add(String(reference.path));
    if (reference.status === "present") {
      if (!isBoundedString(reference.git_revision, 256) || !/^[a-f0-9]{64}$/u.test(String(reference.content_sha256 ?? "")) || reference.reason !== void 0) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Present Overview reference provenance is invalid");
    } else if (!isBoundedString(reference.reason, 128) || reference.git_revision !== void 0 || reference.content_sha256 !== void 0) {
      throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Missing Overview reference provenance is invalid");
    }
  }
}
function userNoteLogicalId(operationId = randomUUID2()) {
  return `user-note:v1:${operationId}`;
}
function overviewLogicalId(projectSlug) {
  return `overview:v1:${projectSlug}`;
}
function sessionCaptureLogicalId(sessionKey) {
  return sha256Hex(`pjangler-capture-v1\0${sessionKey}`);
}
function truncateUtf8(value, maxBytes) {
  let used = 0;
  const result2 = [];
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > maxBytes) break;
    result2.push(point);
    used += bytes;
  }
  return result2.join("");
}
function noteDetail(note2, maxBytes) {
  const parsed = parseNoteEnvelope(note2.content);
  return {
    id: note2.id,
    title: note2.title,
    note_type: note2.note_type,
    created_at: note2.created_at,
    updated_at: note2.updated_at,
    content: truncateUtf8(parsed?.body ?? note2.content, maxBytes)
  };
}
function noteSummary(note2, excerptMaxChars) {
  const body = parseNoteEnvelope(note2.content)?.body ?? note2.content;
  const excerpt = Array.from(body.replace(/\s+/gu, " ").trim()).slice(0, excerptMaxChars).join("");
  return {
    id: note2.id,
    title: note2.title,
    note_type: note2.note_type,
    created_at: note2.created_at,
    updated_at: note2.updated_at,
    excerpt
  };
}
function tokenizeSearch(value) {
  const tokens = value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)];
}
function countTokens(haystack, needle) {
  let count = 0;
  for (const token of haystack) if (token === needle) count += 1;
  return count;
}
function searchNotesLocally(notes, query, limit, excerptMaxChars) {
  const queryTokens = tokenizeSearch(query);
  if (!queryTokens.length) throw new NotebookError("INVALID_INPUT", "Search query must contain at least one letter or number");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new NotebookError("INVALID_INPUT", "Search limit must be a positive integer");
  const scored = notes.flatMap((note2) => {
    const body = parseNoteEnvelope(note2.content)?.body ?? note2.content;
    const titleTokens = tokenizeSearch(note2.title);
    const bodyTokens = tokenizeSearch(body);
    if (!queryTokens.every((token) => titleTokens.includes(token) || bodyTokens.includes(token))) return [];
    const score = queryTokens.reduce((sum, token) => sum + 10 * countTokens(titleTokens, token) + countTokens(bodyTokens, token), 0);
    return [{ note: note2, body, score }];
  });
  const timestamp2 = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  scored.sort((left, right) => right.score - left.score || timestamp2(right.note.updated_at) - timestamp2(left.note.updated_at) || left.note.id.localeCompare(right.note.id, "en"));
  return {
    items: scored.slice(0, limit).map(({ note: note2, body }) => {
      const normalizedBody = body.replace(/\s+/gu, " ").trim().normalize("NFKC");
      const lower = normalizedBody.toLocaleLowerCase("und");
      const starts = queryTokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
      const start = starts.length ? Math.min(...starts) : 0;
      return { ...noteSummary(note2, excerptMaxChars), excerpt: Array.from(normalizedBody.slice(start)).slice(0, excerptMaxChars).join("") };
    }),
    next_cursor: null,
    query_tokens: queryTokens
  };
}
var NOTE_ENVELOPE_PREFIX, NOTE_ENVELOPE_RE;
var init_notes = __esm({
  "src/notebook/notes.ts"() {
    "use strict";
    init_types();
    NOTE_ENVELOPE_PREFIX = "<!-- pjangler-note-v1:";
    NOTE_ENVELOPE_RE = /^<!-- pjangler-note-v1:([A-Za-z0-9_-]+) -->\r?\n/;
  }
});

// src/notebook/output.ts
function bounded(value, max = 512) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}
function successEnvelope(command, config, data, health = null, nextActions = []) {
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    ok: true,
    command,
    project: { slug: config.project_slug, repo_path: config.repo_path },
    notebook: {
      binding_state: config.binding.state,
      health,
      id: config.binding.notebook_id ?? null,
      name: config.binding.notebook_name ?? null
    },
    data,
    error: null,
    next_actions: nextActions.map((item) => bounded(item))
  };
}
function failureEnvelope(command, config, error, health = null, nextActions = []) {
  const normalized = normalizeNotebookError(error);
  return {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    ok: false,
    command,
    project: { slug: config.project_slug, repo_path: config.repo_path },
    notebook: {
      binding_state: config.binding.state,
      health,
      id: config.binding.notebook_id ?? null,
      name: config.binding.notebook_name ?? null
    },
    data: null,
    error: {
      code: normalized.code,
      message: bounded(normalized.message),
      retryable: normalized.retryable,
      details: sanitizeDetails(normalized.details)
    },
    next_actions: nextActions.map((item) => bounded(item))
  };
}
function normalizeNotebookError(error) {
  if (error instanceof NotebookError) return error;
  return new NotebookError("INTERNAL_ERROR", "Project Notebook encountered an unexpected internal error", false, {}, { cause: error });
}
function renderNotebookJson(envelope) {
  validateNotebookEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}
`;
}
function notebookEnvelopeExitCode(envelope) {
  return envelope.ok || !envelope.error ? 0 : notebookExitCode(envelope.error.code);
}
function sanitizeDetails(details) {
  const result2 = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (typeof value === "string") result2[key] = bounded(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result2[key] = value;
  }
  return result2;
}
function validateNotebookEnvelope(value) {
  const invalid = (reason) => {
    throw new NotebookError("INTERNAL_ERROR", `Notebook command produced an invalid JSON v1 envelope: ${reason}`);
  };
  const record = (candidate, reason) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid(reason);
    return candidate;
  };
  const exact = (candidate, keys, reason) => {
    const actual = Object.keys(candidate).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(reason);
  };
  const string = (candidate, reason, max = 4096, allowEmpty = false) => {
    if (typeof candidate !== "string" || !allowEmpty && candidate.length === 0 || Buffer.byteLength(candidate, "utf8") > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate)) invalid(reason);
    return true;
  };
  const nullableString = (candidate, reason, max = 4096) => {
    if (candidate !== null) string(candidate, reason, max);
  };
  const integer = (candidate, reason) => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) invalid(reason);
  };
  const stringList2 = (candidate, reason, maxItems = 1e3) => {
    if (!Array.isArray(candidate) || candidate.length > maxItems) invalid(reason);
    for (const item of candidate) string(item, reason, 4096);
  };
  const errorCodes = /* @__PURE__ */ new Set(["INVALID_INPUT", "NOT_CONFIGURED", "AUTHENTICATION_FAILED", "NOT_FOUND", "CONFLICT", "CROSS_PROJECT", "DRIFT_DETECTED", "THROTTLED", "TIMEOUT", "SERVICE_UNAVAILABLE", "REMOTE_PROTOCOL_ERROR", "INTERNAL_ERROR"]);
  const commands = /* @__PURE__ */ new Set([
    "notebook.status",
    "notebook.create",
    "notebook.notes.list",
    "notebook.notes.add",
    "notebook.notes.get",
    "notebook.notes.update",
    "notebook.notes.delete",
    "notebook.notes.search",
    "notebook.overview.get",
    "notebook.overview.set",
    "notebook.capture.list",
    "notebook.capture.retry",
    "notebook.audit",
    "notebook.migrate",
    "notebook.skill"
  ]);
  const root = record(value, "root must be an object");
  exact(root, ["schema_version", "ok", "command", "project", "notebook", "data", "error", "next_actions"], "root fields differ from v1");
  if (root.schema_version !== 1 || typeof root.ok !== "boolean" || typeof root.command !== "string" || !commands.has(root.command)) invalid("schema version, ok, or command is invalid");
  const project = record(root.project, "project must be an object");
  exact(project, ["slug", "repo_path"], "project fields differ from v1");
  string(project.slug, "project slug is invalid", 128);
  string(project.repo_path, "project repo_path is invalid", 4096);
  const notebook = record(root.notebook, "notebook must be an object");
  exact(notebook, ["binding_state", "health", "id", "name"], "notebook fields differ from v1");
  if (!(/* @__PURE__ */ new Set(["disabled", "planned", "linked"])).has(String(notebook.binding_state))) invalid("binding state is invalid");
  if (!(/* @__PURE__ */ new Set([null, "unconfigured", "healthy", "drifted", "unavailable", "blocked"])).has(notebook.health)) invalid("health is invalid");
  nullableString(notebook.id, "notebook id is invalid", 512);
  nullableString(notebook.name, "notebook name is invalid", 512);
  stringList2(root.next_actions, "next_actions is invalid", 20);
  if (root.ok === (root.error !== null) || (root.ok ? root.data === null : root.data !== null)) invalid("success/error invariant failed");
  if (!root.ok) {
    const error = record(root.error, "error must be an object");
    exact(error, ["code", "message", "retryable", "details"], "error fields differ from v1");
    if (typeof error.code !== "string" || !errorCodes.has(error.code)) invalid("error code is invalid");
    string(error.message, "error message is invalid", 512);
    if (typeof error.retryable !== "boolean") invalid("error retryable is invalid");
    const details = record(error.details, "error details must be an object");
    if (Object.keys(details).length > 20 || Object.entries(details).some(([key, item]) => !key || !(["string", "number", "boolean"].includes(typeof item) || item === null))) invalid("error details are invalid");
    return;
  }
  const noteSummary2 = (candidate, detail) => {
    const note2 = record(candidate, "note must be an object");
    exact(note2, ["id", "title", "note_type", "created_at", "updated_at", detail ? "content" : "excerpt"], "note fields differ from v1");
    for (const key of ["id", "title", "note_type"]) string(note2[key], `note ${key} is invalid`, 4096);
    nullableString(note2.created_at, "note created_at is invalid", 128);
    nullableString(note2.updated_at, "note updated_at is invalid", 128);
    string(note2[detail ? "content" : "excerpt"], `note ${detail ? "content" : "excerpt"} is invalid`, detail ? 1048576 : 16384, true);
  };
  const receipt = (candidate) => {
    const item = record(candidate, "capture receipt must be an object");
    exact(item, ["receipt_id", "logical_id", "session_key", "state", "created_at", "updated_at", "automatic_attempts_used", "automatic_attempt_limit", "manual_retry_count", "attempt_origin", "error_category", "retryable", "diagnostic", "summary_mode", "exclusion_counts", "note_logical_ids", "remote_note_ids", "serialized_bytes"], "receipt fields differ from v1");
    for (const key of ["receipt_id", "logical_id", "session_key", "created_at", "updated_at"]) string(item[key], `receipt ${key} is invalid`, 512);
    if (!(/* @__PURE__ */ new Set(["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"])).has(String(item.state))) invalid("receipt state is invalid");
    for (const key of ["automatic_attempts_used", "automatic_attempt_limit", "manual_retry_count", "serialized_bytes"]) integer(item[key], `receipt ${key} is invalid`);
    if (item.attempt_origin !== "automatic" && item.attempt_origin !== "operator") invalid("receipt attempt origin is invalid");
    if (item.error_category !== null && (typeof item.error_category !== "string" || !errorCodes.has(item.error_category))) invalid("receipt error category is invalid");
    if (typeof item.retryable !== "boolean") invalid("receipt retryable is invalid");
    nullableString(item.diagnostic, "receipt diagnostic is invalid", 512);
    if (item.summary_mode !== null && item.summary_mode !== "configured" && item.summary_mode !== "deterministic-fallback") invalid("receipt summary mode is invalid");
    const exclusions = record(item.exclusion_counts, "receipt exclusions must be an object");
    if (Object.entries(exclusions).some(([key, count]) => !key || !Number.isSafeInteger(count) || Number(count) < 0)) invalid("receipt exclusions are invalid");
    stringList2(item.note_logical_ids, "receipt logical IDs are invalid");
    stringList2(item.remote_note_ids, "receipt remote IDs are invalid");
  };
  const finding2 = (candidate) => {
    const item = record(candidate, "finding must be an object");
    exact(item, ["id", "title", "status", "summary", "details", "fixable"], "finding fields differ from v1");
    for (const key of ["id", "title", "summary"]) string(item[key], `finding ${key} is invalid`, 4096);
    if (!(/* @__PURE__ */ new Set(["pass", "fail", "warn", "skip"])).has(String(item.status)) || typeof item.fixable !== "boolean") invalid("finding status/fixable is invalid");
    stringList2(item.details, "finding details are invalid", 100);
  };
  const admission2 = (candidate) => {
    const item = record(candidate, "capture admission must be an object");
    exact(item, ["unresolved_count", "unresolved_count_lower_bound", "unresolved_bytes", "unresolved_bytes_lower_bound", "unmeasurable_entry_count", "integrity_entries", "receipt_caps", "receiptless_session_count", "stale_receiptless_session_count", "active_refusals"], "capture admission fields differ from v1");
    for (const key of ["unresolved_count_lower_bound", "unresolved_bytes_lower_bound", "unmeasurable_entry_count", "receiptless_session_count", "stale_receiptless_session_count"]) integer(item[key], `capture admission ${key} is invalid`);
    for (const key of ["unresolved_count", "unresolved_bytes"]) if (item[key] !== null) integer(item[key], `capture admission ${key} is invalid`);
    const caps = record(item.receipt_caps, "receipt caps must be an object");
    exact(caps, ["max_count", "max_bytes"], "receipt cap fields differ from v1");
    integer(caps.max_count, "receipt max_count is invalid");
    integer(caps.max_bytes, "receipt max_bytes is invalid");
    if (!Array.isArray(item.integrity_entries) || !Array.isArray(item.active_refusals)) invalid("capture admission lists are invalid");
    for (const entryValue of item.integrity_entries) {
      const entry = record(entryValue, "integrity entry is invalid");
      exact(entry, ["entry_id", "reason"], "integrity entry fields differ from v1");
      string(entry.entry_id, "integrity entry id is invalid");
      string(entry.reason, "integrity reason is invalid");
    }
    for (const refusalValue of item.active_refusals) {
      const refusal = record(refusalValue, "retention refusal is invalid");
      exact(refusal, ["outcome", "session_key", "refused_at", "reason", "current_count", "current_bytes", "candidate_bytes", "max_count", "max_bytes", "next_actions"], "retention refusal fields differ from v1");
      if (refusal.outcome !== "capture-refused-history") invalid("retention refusal outcome is invalid");
      for (const key of ["session_key", "refused_at", "reason"]) string(refusal[key], `retention refusal ${key} is invalid`);
      for (const key of ["current_count", "current_bytes", "candidate_bytes", "max_count", "max_bytes"]) integer(refusal[key], `retention refusal ${key} is invalid`);
      stringList2(refusal.next_actions, "retention refusal actions are invalid", 10);
    }
  };
  const data = record(root.data, "data must be an object");
  switch (root.command) {
    case "notebook.create":
      exact(data, ["created", "adopted", "notebook_id", "overview_note_id"], "create fields differ from v1");
      if (typeof data.created !== "boolean" || typeof data.adopted !== "boolean") invalid("create flags are invalid");
      string(data.notebook_id, "created notebook id is invalid");
      string(data.overview_note_id, "created Overview id is invalid");
      break;
    case "notebook.notes.list":
      exact(data, ["items", "next_cursor"], "note list fields differ from v1");
      if (!Array.isArray(data.items)) invalid("note list items are invalid");
      data.items.forEach((item) => noteSummary2(item, false));
      nullableString(data.next_cursor, "note cursor is invalid", 16384);
      break;
    case "notebook.notes.search":
      exact(data, ["items", "next_cursor", "query_tokens"], "search fields differ from v1");
      if (!Array.isArray(data.items) || data.next_cursor !== null) invalid("search list/cursor is invalid");
      data.items.forEach((item) => noteSummary2(item, false));
      stringList2(data.query_tokens, "query tokens are invalid", 100);
      break;
    case "notebook.notes.add":
    case "notebook.notes.get":
    case "notebook.notes.update":
      exact(data, ["note"], "note detail fields differ from v1");
      noteSummary2(data.note, true);
      break;
    case "notebook.notes.delete":
      exact(data, ["deleted_id"], "delete fields differ from v1");
      string(data.deleted_id, "deleted id is invalid");
      break;
    case "notebook.overview.get":
    case "notebook.overview.set":
      exact(data, ["note", "updated", "drift"], "Overview fields differ from v1");
      noteSummary2(data.note, true);
      if (typeof data.updated !== "boolean" || !Array.isArray(data.drift)) invalid("Overview update/drift is invalid");
      for (const driftValue of data.drift) {
        const drift = record(driftValue, "Overview drift is invalid");
        exact(drift, ["path", "reason"], "Overview drift fields differ from v1");
        string(drift.path, "Overview drift path is invalid");
        string(drift.reason, "Overview drift reason is invalid");
      }
      break;
    case "notebook.capture.list":
      exact(data, ["items", "next_cursor"], "capture list fields differ from v1");
      if (!Array.isArray(data.items)) invalid("capture items are invalid");
      data.items.forEach(receipt);
      if (data.next_cursor !== null) string(data.next_cursor, "capture cursor is invalid");
      break;
    case "notebook.capture.retry":
      exact(data, ["receipt"], "capture retry fields differ from v1");
      receipt(data.receipt);
      break;
    case "notebook.audit":
      exact(data, ["rules", "audited_at", "remote_check", "capture_admission"], "audit fields differ from v1");
      if (!Array.isArray(data.rules)) invalid("audit rules are invalid");
      data.rules.forEach(finding2);
      string(data.audited_at, "audit time is invalid", 128);
      if (!(/* @__PURE__ */ new Set(["pass", "fail", "skip"])).has(String(data.remote_check))) invalid("audit remote_check is invalid");
      admission2(data.capture_admission);
      break;
    case "notebook.status":
      exact(data, ["policy", "configuration_provenance", "remote_check", "unresolved_receipt_count", "unresolved_receipt_bytes", "receipt_caps", "capture_admission", "findings"], "status fields differ from v1");
      record(data.policy, "status policy is invalid");
      record(data.configuration_provenance, "status provenance is invalid");
      if (!(/* @__PURE__ */ new Set(["pass", "fail", "skip"])).has(String(data.remote_check))) invalid("status remote_check is invalid");
      if (data.unresolved_receipt_count !== null) integer(data.unresolved_receipt_count, "status unresolved count is invalid");
      if (data.unresolved_receipt_bytes !== null) integer(data.unresolved_receipt_bytes, "status unresolved bytes is invalid");
      {
        const caps = record(data.receipt_caps, "status receipt caps are invalid");
        exact(caps, ["max_count", "max_bytes"], "status cap fields differ from v1");
        integer(caps.max_count, "status max_count is invalid");
        integer(caps.max_bytes, "status max_bytes is invalid");
      }
      admission2(data.capture_admission);
      if (!Array.isArray(data.findings)) invalid("status findings are invalid");
      data.findings.forEach(finding2);
      break;
    case "notebook.skill":
      exact(data, ["status", "summary", "source", "drift", "changed_files"], "skill projection fields differ from v1");
      if (!(/* @__PURE__ */ new Set(["clean", "planned", "repaired", "blocked"])).has(String(data.status))) invalid("skill projection status is invalid");
      string(data.summary, "skill projection summary is invalid", 4096);
      nullableString(data.source, "skill projection source is invalid", 4096);
      stringList2(data.drift, "skill projection drift is invalid", 20);
      stringList2(data.changed_files, "skill projection changed files are invalid", 1e3);
      break;
    case "notebook.migrate":
      exact(data, ["dry_run", "selected_rules", "results", "changed_files"], "migration fields differ from v1");
      if (typeof data.dry_run !== "boolean" || !Array.isArray(data.results)) invalid("migration plan is invalid");
      stringList2(data.selected_rules, "migration selected rules are invalid", 20);
      stringList2(data.changed_files, "migration changed files are invalid", 1e3);
      for (const resultValue of data.results) {
        const result2 = record(resultValue, "migration result is invalid");
        exact(result2, ["id", "status", "summary"], "migration result fields differ from v1");
        string(result2.id, "migration result id is invalid");
        string(result2.summary, "migration result summary is invalid");
        if (!(/* @__PURE__ */ new Set(["planned", "applied", "noop", "blocked"])).has(String(result2.status))) invalid("migration result status is invalid");
      }
      break;
  }
}
var init_output = __esm({
  "src/notebook/output.ts"() {
    "use strict";
    init_types();
  }
});

// src/notebook/remote-mutation-schema.ts
function bounded2(value, max) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function timestamp(value) {
  return bounded2(value, 64) && Number.isFinite(Date.parse(value));
}
function remoteMutationResultCategory(state, candidateCount, definitiveHttpStatus) {
  if (state === "prepared") return "prepared";
  if (state === "possibly-dispatched") return definitiveHttpStatus === void 0 ? "possibly-dispatched" : "definitive-http-rejection";
  if (state === "committed") return "committed";
  return candidateCount === 0 ? "reconciled-zero" : candidateCount === 1 ? "reconciled-one" : "reconciled-many";
}
function remoteMutationNextAction(state, candidateCount, definitiveHttpStatus) {
  if (state === "prepared") return "dispatch once only after the durable possibly-dispatched latch";
  if (state === "possibly-dispatched") return definitiveHttpStatus === void 0 ? "reconcile by stable marker only; do not POST again" : "reconcile by stable marker; a different corrected input may dispatch once only after zero candidates";
  if (state === "committed") return "none";
  return candidateCount === 1 ? "persist durable binding or note ownership before commit" : "resolve the zero-or-many candidate conflict without another blind POST";
}
function parseRemoteMutationJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value;
  const keys = Object.keys(item);
  const allowed = /* @__PURE__ */ new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  if (!REQUIRED_KEYS.every((key) => Object.hasOwn(item, key)) || keys.some((key) => !allowed.has(key))) return null;
  if (item.schema_version !== 1 || typeof item.operation_id !== "string" || !OPERATION_ID_RE.test(item.operation_id)) return null;
  if (typeof item.project_slug !== "string" || !PROJECT_SLUG_RE.test(item.project_slug)) return null;
  if (item.kind !== "notebook.create" && item.kind !== "note.create") return null;
  if (item.state !== "prepared" && item.state !== "possibly-dispatched" && item.state !== "reconciled" && item.state !== "committed") return null;
  if (!bounded2(item.logical_marker, 512) || typeof item.input_digest !== "string" || !DIGEST_RE.test(item.input_digest)) return null;
  if (item.dispatch_digest !== void 0 && (typeof item.dispatch_digest !== "string" || !DIGEST_RE.test(item.dispatch_digest))) return null;
  if (item.session_key !== void 0 && (typeof item.session_key !== "string" || !DIGEST_RE.test(item.session_key))) return null;
  if (item.binding_id !== void 0 && !bounded2(item.binding_id, 512)) return null;
  if (item.definitive_http_status !== void 0 && item.definitive_http_status !== 400 && item.definitive_http_status !== 422) return null;
  if (!timestamp(item.prepared_at) || !timestamp(item.updated_at) || Date.parse(item.updated_at) < Date.parse(item.prepared_at)) return null;
  if (!Array.isArray(item.candidate_ids) || item.candidate_ids.length > 20 || item.candidate_ids.some((entry) => !bounded2(entry, 512)) || new Set(item.candidate_ids).size !== item.candidate_ids.length) return null;
  if (item.diagnostic !== null && (typeof item.diagnostic !== "string" || Buffer.byteLength(item.diagnostic, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(item.diagnostic))) return null;
  const candidateCount = item.candidate_ids.length;
  if (item.state === "prepared" && candidateCount !== 0) return null;
  if (item.state === "possibly-dispatched" && candidateCount !== 0) return null;
  if (item.definitive_http_status !== void 0 && (item.state !== "possibly-dispatched" || candidateCount !== 0 || item.diagnostic === null)) return null;
  if (item.state === "committed" && (candidateCount !== 1 || item.diagnostic !== null)) return null;
  if (item.result_category !== remoteMutationResultCategory(item.state, candidateCount, item.definitive_http_status)) return null;
  if (item.next_action !== remoteMutationNextAction(item.state, candidateCount, item.definitive_http_status)) return null;
  return item;
}
var REQUIRED_KEYS, OPTIONAL_KEYS, OPERATION_ID_RE, DIGEST_RE, PROJECT_SLUG_RE;
var init_remote_mutation_schema = __esm({
  "src/notebook/remote-mutation-schema.ts"() {
    "use strict";
    REQUIRED_KEYS = [
      "schema_version",
      "operation_id",
      "project_slug",
      "kind",
      "logical_marker",
      "input_digest",
      "state",
      "prepared_at",
      "updated_at",
      "candidate_ids",
      "diagnostic",
      "result_category",
      "next_action"
    ];
    OPTIONAL_KEYS = ["binding_id", "session_key", "dispatch_digest", "definitive_http_status"];
    OPERATION_ID_RE = /^[a-f0-9-]{16,64}$/iu;
    DIGEST_RE = /^[a-f0-9]{64}$/u;
    PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
  }
});

// src/notebook/state.ts
import { createHash as createHash6, randomUUID as randomUUID3 } from "node:crypto";
import {
  closeSync as closeSync4,
  constants as constants3,
  existsSync as existsSync14,
  fchmodSync as fchmodSync3,
  fstatSync as fstatSync2,
  fsyncSync as fsyncSync3,
  lstatSync as lstatSync7,
  mkdirSync as mkdirSync6,
  openSync as openSync4,
  readSync,
  readdirSync as readdirSync6,
  renameSync as renameSync4,
  unlinkSync as unlinkSync5,
  writeFileSync as writeFileSync9
} from "node:fs";
import { homedir as homedir6 } from "node:os";
import { basename as basename6, dirname as dirname8, join as join15, parse, relative as relative7, resolve as resolve8, sep as sep3 } from "node:path";
function notebookStateRoot(env2 = process.env) {
  const base = env2.XDG_STATE_HOME || join15(env2.HOME || homedir6(), ".local", "state");
  return resolve8(base, "pjangler", "notebook", NOTEBOOK_STATE_VERSION);
}
function deriveSessionKey(projectSlug, client, clientSessionId) {
  if (!projectSlug || !client || !clientSessionId) throw new NotebookError("INVALID_INPUT", "project slug, client, and client session id are required");
  return createHash6("sha256").update(`pjangler-session-v1\0${projectSlug}\0${client}\0${clientSessionId}`, "utf8").digest("hex");
}
function deriveReceiptId(sessionKey) {
  assertDigest(sessionKey, "session key");
  return sha256Hex(`pjangler-receipt-v1\0${sessionKey}`);
}
function repoPathDigest(repoPath) {
  return sha256Hex(`pjangler-repo-path-v1\0${resolve8(repoPath)}`);
}
function assertDigest(value, label) {
  if (!SESSION_KEY_RE.test(value)) throw new NotebookError("INVALID_INPUT", `Invalid ${label}`);
}
function projectStateDir(root, projectSlug) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(projectSlug)) throw new NotebookError("INVALID_INPUT", "Invalid project slug for Notebook state");
  return join15(resolve8(root), "projects", sha256Hex(`pjangler-project-state-v1\0${projectSlug}`));
}
function assertContained(root, candidate) {
  const rel = relative7(resolve8(root), resolve8(candidate));
  if (!rel || !rel.startsWith(`..${sep3}`) && rel !== ".." && !rel.startsWith(sep3)) return;
  throw new NotebookError("INTERNAL_ERROR", "Notebook state path escaped its root");
}
function openPinnedDirectory(path, root, create) {
  const absolute = resolve8(path);
  const absoluteRoot = resolve8(root);
  assertContained(absoluteRoot, absolute);
  if (!existsSync14("/proc/self/fd")) throw new NotebookError("INTERNAL_ERROR", "Descriptor-pinned Notebook state requires procfs");
  const parsed = parse(absolute);
  let fd = openSync4(parsed.root, DIRECTORY_OPEN_FLAGS);
  let cursor = parsed.root;
  try {
    for (const part of absolute.slice(parsed.root.length).split(sep3).filter(Boolean)) {
      const child = `/proc/self/fd/${fd}/${part}`;
      cursor = join15(cursor, part);
      let childFd;
      try {
        childFd = openSync4(child, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        if (!create || error.code !== "ENOENT") throw error;
        try {
          mkdirSync6(child, { mode: 448 });
        } catch (mkdirError) {
          if (mkdirError.code !== "EEXIST") throw mkdirError;
        }
        childFd = openSync4(child, DIRECTORY_OPEN_FLAGS);
      }
      closeSync4(fd);
      fd = childFd;
      const stat = fstatSync2(fd);
      if (!stat.isDirectory()) throw new NotebookError("INTERNAL_ERROR", "Notebook state path component is not a directory");
      if (cursor === absoluteRoot || relative7(absoluteRoot, cursor).startsWith("..") === false) assertOwned(stat);
    }
    return fd;
  } catch (error) {
    closeSync4(fd);
    if (error.code === "ELOOP" || error.code === "ENOTDIR") {
      throw new NotebookError("INTERNAL_ERROR", "Notebook state path contains a symlink component");
    }
    throw error;
  }
}
function pinnedLeaf(parentFd, path) {
  return `/proc/self/fd/${parentFd}/${basename6(path)}`;
}
function assertOwned(stat) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new NotebookError("INTERNAL_ERROR", "Notebook state path is not owned by the current user");
  }
}
function ensureDirectory(path, root) {
  const absoluteRoot = resolve8(root);
  const absolute = resolve8(path);
  assertContained(absoluteRoot, absolute);
  const fd = openPinnedDirectory(absolute, absoluteRoot, true);
  try {
    const stat = fstatSync2(fd);
    if (!stat.isDirectory()) throw new NotebookError("INTERNAL_ERROR", "Notebook state directory is not a real directory");
    assertOwned(stat);
    fchmodSync3(fd, 448);
    fsyncSync3(fd);
  } finally {
    closeSync4(fd);
  }
}
function notebookStatePaths(root, projectSlug) {
  const absoluteRoot = resolve8(root);
  const project = projectStateDir(absoluteRoot, projectSlug);
  return {
    root: absoluteRoot,
    project,
    baselines: join15(project, "baselines"),
    claims: join15(project, "claims"),
    receipts: join15(project, "receipts"),
    refusals: join15(project, "refusals"),
    journals: join15(project, "journals"),
    locks: join15(project, "locks")
  };
}
function ensureNotebookState(root, projectSlug) {
  const paths = notebookStatePaths(root, projectSlug);
  const { root: absoluteRoot, project } = paths;
  for (const path of [absoluteRoot, join15(absoluteRoot, "projects"), project, paths.baselines, paths.claims, paths.receipts, paths.refusals, paths.journals, paths.locks]) {
    ensureDirectory(path, absoluteRoot);
  }
  return paths;
}
function jsonLine(value) {
  return `${canonicalJson(value)}
`;
}
function fsyncDirectory2(path) {
  let fd;
  try {
    fd = openPinnedDirectory(path, path, false);
    fsyncSync3(fd);
  } catch {
  } finally {
    if (fd !== void 0) closeSync4(fd);
  }
}
function readStateDirectory(path, root) {
  const fd = openPinnedDirectory(path, root, false);
  try {
    return readdirSync6(`/proc/self/fd/${fd}`, { withFileTypes: true });
  } finally {
    closeSync4(fd);
  }
}
function readNotebookStateDirectory(path, root) {
  assertContained(root, path);
  return readStateDirectory(path, root);
}
function unlinkStateFile(path, root, allowMissing = false) {
  assertContained(root, path);
  const parentFd = openPinnedDirectory(dirname8(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  let fileFd;
  try {
    try {
      fileFd = openSync4(target, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return false;
      throw error;
    }
    const stat = fstatSync2(fileFd);
    if (!stat.isFile() || (stat.mode & 511) !== 384) {
      throw new NotebookError("CONFLICT", "Refusing to remove a suspect Notebook state entry; run pj notebook audit --json");
    }
    assertOwned(stat);
    unlinkSync5(target);
    fsyncSync3(parentFd);
    return true;
  } finally {
    if (fileFd !== void 0) closeSync4(fileFd);
    closeSync4(parentFd);
  }
}
function renameStateFile(source, target, root) {
  if (dirname8(source) !== dirname8(target)) throw new NotebookError("INTERNAL_ERROR", "Notebook state rename crossed directories");
  const parentFd = openPinnedDirectory(dirname8(source), root, false);
  const sourcePath = pinnedLeaf(parentFd, source);
  const targetPath = pinnedLeaf(parentFd, target);
  let sourceFd;
  try {
    sourceFd = openSync4(sourcePath, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    const stat = fstatSync2(sourceFd);
    if (!stat.isFile() || (stat.mode & 511) !== 384) throw new NotebookError("CONFLICT", "Notebook state rename source has an integrity finding");
    assertOwned(stat);
    try {
      lstatSync7(targetPath);
      throw new NotebookError("CONFLICT", "Notebook state rename target already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    renameSync4(sourcePath, targetPath);
    fsyncSync3(parentFd);
  } finally {
    if (sourceFd !== void 0) closeSync4(sourceFd);
    closeSync4(parentFd);
  }
}
function atomicWriteJson(path, value, root, afterParentPinned) {
  assertContained(root, path);
  ensureDirectory(dirname8(path), root);
  const text3 = jsonLine(value);
  const parentFd = openPinnedDirectory(dirname8(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  const tempName = `.${basename6(path)}.${process.pid}.${randomUUID3()}.tmp`;
  const temp = `/proc/self/fd/${parentFd}/${tempName}`;
  let existingIdentity = null;
  try {
    afterParentPinned?.();
    try {
      const existingFd = openSync4(target, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
      try {
        const existing = fstatSync2(existingFd);
        if (!existing.isFile()) throw new NotebookError("INTERNAL_ERROR", "Refusing to replace a non-regular Notebook state file");
        assertOwned(existing);
        if ((existing.mode & 511) !== 384) throw new NotebookError("CONFLICT", "Refusing to replace a Notebook state file with unsafe permissions");
        existingIdentity = { dev: existing.dev, ino: existing.ino };
      } finally {
        closeSync4(existingFd);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const fd = openSync4(temp, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | (constants3.O_NOFOLLOW ?? 0), 384);
    try {
      writeFileSync9(fd, text3, "utf8");
      fsyncSync3(fd);
    } finally {
      closeSync4(fd);
    }
    try {
      const current = lstatSync7(target);
      if (!existingIdentity || !current.isFile() || current.isSymbolicLink() || current.dev !== existingIdentity.dev || current.ino !== existingIdentity.ino) {
        throw new NotebookError("CONFLICT", "Notebook state target changed during atomic update; preserving both entries for audit");
      }
    } catch (error) {
      if (error.code !== "ENOENT" || existingIdentity) throw error;
    }
    renameSync4(temp, target);
    fsyncSync3(parentFd);
  } catch (error) {
    try {
      unlinkSync5(temp);
    } catch {
    }
    throw error;
  } finally {
    closeSync4(parentFd);
  }
  return Buffer.byteLength(text3, "utf8");
}
function exclusiveWrite(path, text3, root) {
  assertContained(root, path);
  const parentFd = openPinnedDirectory(dirname8(path), root, false);
  const target = pinnedLeaf(parentFd, path);
  let fd;
  try {
    fd = openSync4(target, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | (constants3.O_NOFOLLOW ?? 0), 384);
  } catch (error) {
    closeSync4(parentFd);
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync9(fd, text3, "utf8");
    fsyncSync3(fd);
  } finally {
    closeSync4(fd);
  }
  try {
    fsyncSync3(parentFd);
  } finally {
    closeSync4(parentFd);
  }
  return true;
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}
function boundedString(value, max, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function isoTimestamp(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function safeNonnegativeInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function boundedStringArray(value, maxItems, maxChars, allowControls = false) {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= maxChars && (allowControls || !/[\u0000-\u001f\u007f]/u.test(entry)));
}
function parseBaseline(value) {
  if (!isObject(value) || !hasExactKeys(value, [
    "schema_version",
    "session_key",
    "project_slug",
    "client",
    "created_at",
    "repo_path_digest",
    "git_head",
    "git_status_digest",
    "policy_version",
    "tracked_path_digests",
    "pre_dirty_paths",
    "complete",
    "incomplete_reasons"
  ])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (!boundedString(value.project_slug, 128) || !boundedString(value.client, 64) || !isoTimestamp(value.created_at)) return null;
  if (typeof value.repo_path_digest !== "string" || !RECEIPT_ID_RE.test(value.repo_path_digest)) return null;
  if (value.git_head !== null && (typeof value.git_head !== "string" || !GIT_OBJECT_RE.test(value.git_head))) return null;
  if (value.git_status_digest !== null && (typeof value.git_status_digest !== "string" || !RECEIPT_ID_RE.test(value.git_status_digest))) return null;
  if (!boundedString(value.policy_version, 128) || typeof value.complete !== "boolean") return null;
  if (!isObject(value.tracked_path_digests) || Object.keys(value.tracked_path_digests).length > 1e3 || !Object.entries(value.tracked_path_digests).every(([path, digest]) => path.length > 0 && path.length <= 4096 && !path.includes("\0") && typeof digest === "string" && RECEIPT_ID_RE.test(digest))) return null;
  if (!boundedStringArray(value.pre_dirty_paths, 2e3, 4096, true) || value.pre_dirty_paths.some((path) => path.includes("\0"))) return null;
  if (!Array.isArray(value.incomplete_reasons) || value.incomplete_reasons.length > 20 || !value.incomplete_reasons.every((reason) => boundedString(reason, 128))) return null;
  return value;
}
function parseClaim(value) {
  if (!isObject(value) || !hasExactKeys(value, ["schema_version", "session_key", "project_slug", "created_at", "overview_note_id", "content_sha256"])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (!boundedString(value.project_slug, 128) || !isoTimestamp(value.created_at) || !boundedString(value.overview_note_id, 512)) return null;
  if (typeof value.content_sha256 !== "string" || !RECEIPT_ID_RE.test(value.content_sha256)) return null;
  return value;
}
function parseReceipt(value) {
  const required = [
    "schema_version",
    "receipt_id",
    "logical_id",
    "session_key",
    "project_slug",
    "repo_path_digest",
    "baseline_ref",
    "end_revision",
    "end_status_digest",
    "state",
    "automatic_attempts_used",
    "automatic_attempt_limit",
    "manual_retry_count",
    "attempt_origin",
    "lease_owner",
    "lease_deadline",
    "created_at",
    "updated_at",
    "exclusion_counts",
    "summary_mode",
    "note_logical_ids",
    "remote_note_ids",
    "error_category",
    "retryable",
    "diagnostic",
    "serialized_bytes"
  ];
  if (!isObject(value) || !hasExactKeys(value, required, ["manual_baseline_ref"])) return null;
  if (value.schema_version !== 1 || typeof value.receipt_id !== "string" || !RECEIPT_ID_RE.test(value.receipt_id) || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key)) return null;
  if (value.logical_id !== sessionCaptureLogicalId(value.session_key) || !boundedString(value.project_slug, 128) || typeof value.repo_path_digest !== "string" || !RECEIPT_ID_RE.test(value.repo_path_digest)) return null;
  for (const ref of [value.baseline_ref, value.end_revision]) if (ref !== null && !boundedString(ref, 512)) return null;
  if (value.end_status_digest !== null && (typeof value.end_status_digest !== "string" || !RECEIPT_ID_RE.test(value.end_status_digest))) return null;
  if (value.manual_baseline_ref !== void 0 && (!boundedString(value.manual_baseline_ref, 512) || value.baseline_ref !== value.manual_baseline_ref)) return null;
  const states = ["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"];
  if (typeof value.state !== "string" || !states.includes(value.state)) return null;
  if (!safeNonnegativeInteger(value.automatic_attempts_used, 1e6) || !safeNonnegativeInteger(value.automatic_attempt_limit, 1e6) || value.automatic_attempt_limit < 1 || value.automatic_attempts_used > value.automatic_attempt_limit || !safeNonnegativeInteger(value.manual_retry_count, 1e6)) return null;
  if (value.attempt_origin !== "automatic" && value.attempt_origin !== "operator") return null;
  const processing = value.state === "processing";
  if (processing ? !boundedString(value.lease_owner, 128) || !isoTimestamp(value.lease_deadline) : value.lease_owner !== null || value.lease_deadline !== null) return null;
  if (!isoTimestamp(value.created_at) || !isoTimestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) return null;
  if (!isObject(value.exclusion_counts) || Object.keys(value.exclusion_counts).length > 100 || !Object.entries(value.exclusion_counts).every(([key, count]) => boundedString(key, 128) && safeNonnegativeInteger(count, 1e6))) return null;
  if (value.summary_mode !== null && value.summary_mode !== "configured" && value.summary_mode !== "deterministic-fallback") return null;
  if (!boundedStringArray(value.note_logical_ids, 2e3, 512) || !boundedStringArray(value.remote_note_ids, 2e3, 512)) return null;
  if (value.error_category !== null && (typeof value.error_category !== "string" || !NOTEBOOK_ERROR_CODES.has(value.error_category))) return null;
  if (typeof value.retryable !== "boolean" || value.diagnostic !== null && !boundedString(value.diagnostic, 4096)) return null;
  if (!safeNonnegativeInteger(value.serialized_bytes) || value.serialized_bytes < 1) return null;
  if (value.state === "succeeded" && (value.summary_mode === null || value.error_category !== null || value.retryable || value.diagnostic !== null)) return null;
  if (value.state === "failed" && (value.error_category === null || value.diagnostic === null)) return null;
  if (value.state === "blocked-missing-baseline" && (value.error_category !== "CONFLICT" || value.retryable || value.diagnostic === null)) return null;
  return value;
}
function parseRefusal(value) {
  if (!isObject(value) || !hasExactKeys(value, [
    "schema_version",
    "session_key",
    "baseline_created_at",
    "refused_at",
    "reason",
    "current_count",
    "current_bytes",
    "candidate_bytes",
    "max_count",
    "max_bytes",
    "next_actions"
  ])) return null;
  if (value.schema_version !== 1 || typeof value.session_key !== "string" || !SESSION_KEY_RE.test(value.session_key) || !isoTimestamp(value.baseline_created_at) || !isoTimestamp(value.refused_at) || Date.parse(value.refused_at) < Date.parse(value.baseline_created_at)) return null;
  if (!(value.reason === "count-cap" || value.reason === "byte-cap" || value.reason === "both")) return null;
  if (![value.current_count, value.current_bytes, value.candidate_bytes, value.max_count, value.max_bytes].every((entry) => safeNonnegativeInteger(entry)) || value.candidate_bytes === 0 || value.max_count === 0 || value.max_bytes === 0) return null;
  const countBlocked = value.current_count + 1 > value.max_count;
  const byteBlocked = value.current_bytes + value.candidate_bytes > value.max_bytes;
  if (!countBlocked && !byteBlocked) return null;
  if (value.reason !== capReason(countBlocked, byteBlocked)) return null;
  if (!boundedStringArray(value.next_actions, 2, 2048) || value.next_actions.length !== 2 || !value.next_actions[0].startsWith("pj notebook capture list ") || !value.next_actions[1].startsWith("pj notebook capture retry ")) return null;
  return value;
}
function safeReadJson(path, maxBytes) {
  let parentFd;
  try {
    parentFd = openPinnedDirectory(dirname8(path), dirname8(path), false);
  } catch {
    return { reason: "non-regular", bytes: 0 };
  }
  let fd;
  try {
    fd = openSync4(pinnedLeaf(parentFd, path), constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
  } catch (error) {
    closeSync4(parentFd);
    return { reason: error.code === "ELOOP" ? "non-regular" : "unreadable", bytes: 0 };
  }
  try {
    const stat = fstatSync2(fd);
    if (!stat.isFile()) return { reason: "non-regular", bytes: 0 };
    if ((stat.mode & 511) !== 384) return { reason: "unsafe-permissions", bytes: stat.size };
    try {
      assertOwned(stat);
    } catch {
      return { reason: "unsafe-permissions", bytes: stat.size };
    }
    if ((stat.mode & 292) === 0) return { reason: "unreadable", bytes: 0 };
    if (stat.size > maxBytes) return { reason: "oversize", bytes: stat.size };
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) return { reason: "oversize", bytes: total };
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync2(fd);
    if (after.size !== stat.size || total !== stat.size) return { reason: "unreadable", bytes: total };
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))), bytes: total };
  } catch (error) {
    return { reason: error instanceof SyntaxError || error instanceof TypeError ? "invalid-json" : "unreadable", bytes: 0 };
  } finally {
    closeSync4(fd);
    closeSync4(parentFd);
  }
}
function safeEntryId(kind, name) {
  return `${kind}/${/^[a-zA-Z0-9._-]{1,160}$/u.test(name) ? name : sha256Hex(name).slice(0, 24)}`;
}
function readBaseline(path, maxBytes) {
  if (!existsSync14(path)) return null;
  const read = safeReadJson(path, maxBytes);
  return read.value === void 0 ? null : parseBaseline(read.value);
}
function baselineReceiptByteCeiling(limits) {
  return limits.receipt_max_bytes;
}
function createSessionBaseline(root, input) {
  assertDigest(input.session_key, "session key");
  const paths = ensureNotebookState(root, input.project_slug);
  const path = join15(paths.baselines, `${input.session_key}.json`);
  const maxBytes = baselineReceiptByteCeiling(input.limits);
  const existing = readBaseline(path, maxBytes);
  if (existing) return { baseline: existing, created: false };
  const baseline = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    session_key: input.session_key,
    project_slug: input.project_slug,
    client: input.client.slice(0, 64),
    created_at: input.created_at,
    repo_path_digest: repoPathDigest(input.repo_path),
    git_head: input.git_head,
    git_status_digest: input.git_status_digest,
    policy_version: input.policy_version,
    tracked_path_digests: Object.fromEntries(Object.entries(input.tracked_path_digests).sort(([a], [b]) => a.localeCompare(b, "en")).slice(0, 1e3)),
    pre_dirty_paths: [...new Set(input.pre_dirty_paths)].sort().slice(0, 2e3),
    complete: input.complete,
    incomplete_reasons: input.incomplete_reasons.slice(0, 20).map((item) => item.slice(0, 128))
  };
  let text3 = jsonLine(baseline);
  if (Buffer.byteLength(text3, "utf8") > maxBytes) {
    baseline.complete = false;
    baseline.tracked_path_digests = {};
    baseline.pre_dirty_paths = [];
    baseline.incomplete_reasons = [.../* @__PURE__ */ new Set(["baseline-byte-ceiling", ...baseline.incomplete_reasons])].slice(0, 20);
    text3 = jsonLine(baseline);
  }
  if (Buffer.byteLength(text3, "utf8") > maxBytes) {
    throw new NotebookError("NOT_CONFIGURED", "Notebook receipt_max_bytes is too small for a minimal SessionStart baseline");
  }
  if (!parseBaseline(baseline)) throw new NotebookError("INTERNAL_ERROR", "SessionStart baseline failed its own v1 schema validation");
  if (!exclusiveWrite(path, text3, paths.root)) {
    const won = readBaseline(path, maxBytes);
    if (!won) throw new NotebookError("INTERNAL_ERROR", "Concurrent baseline creation produced unreadable state");
    return { baseline: won, created: false };
  }
  return { baseline, created: true };
}
function createOverviewClaim(root, input) {
  assertDigest(input.session_key, "session key");
  const paths = ensureNotebookState(root, input.project_slug);
  const path = join15(paths.claims, `${input.session_key}.overview`);
  if (existsSync14(path)) {
    const read = safeReadJson(path, 65536);
    const existing = read.value === void 0 ? null : parseClaim(read.value);
    if (!existing) throw new NotebookError("CONFLICT", "Overview claim has an integrity finding");
    return { claim: existing, created: false };
  }
  const claim = { schema_version: NOTEBOOK_SCHEMA_VERSION, ...input };
  if (!exclusiveWrite(path, jsonLine(claim), paths.root)) {
    const read = safeReadJson(path, 65536);
    const existing = read.value === void 0 ? null : parseClaim(read.value);
    if (!existing) throw new NotebookError("CONFLICT", "Concurrent Overview claim creation produced invalid state");
    return { claim: existing, created: false };
  }
  return { claim, created: true };
}
function readOverviewClaim(root, projectSlug, sessionKey) {
  assertDigest(sessionKey, "session key");
  const paths = notebookStatePaths(root, projectSlug);
  const path = join15(paths.claims, `${sessionKey}.overview`);
  if (!existsSync14(path)) return null;
  const read = safeReadJson(path, 65536);
  return read.value === void 0 ? null : parseClaim(read.value);
}
function readSessionBaseline(root, projectSlug, sessionKey, limits) {
  assertDigest(sessionKey, "session key");
  const paths = ensureNotebookState(root, projectSlug);
  return readBaseline(join15(paths.baselines, `${sessionKey}.json`), baselineReceiptByteCeiling(limits));
}
function acquireLock(paths, maxWaitMs) {
  const lock = join15(paths.locks, "admission.lock");
  const deadline = Date.now() + Math.max(1, maxWaitMs);
  const token = randomUUID3();
  const record = () => ({
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    acquired_at: (/* @__PURE__ */ new Date()).toISOString(),
    expires_at: new Date(Date.now() + Math.max(5e3, maxWaitMs * 20)).toISOString()
  });
  while (true) {
    if (exclusiveWrite(lock, jsonLine(record()), paths.root)) {
      return () => {
        const current = safeReadJson(lock, 8192);
        if (current.value && typeof current.value === "object" && !Array.isArray(current.value) && current.value.token === token) {
          try {
            unlinkStateFile(lock, paths.root);
          } catch {
          }
        }
      };
    }
    const read = safeReadJson(lock, 8192);
    const held = read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : null;
    const heldToken = typeof held?.token === "string" && /^[a-f0-9-]{16,64}$/iu.test(held.token) ? held.token : null;
    const expiresAt = typeof held?.expires_at === "string" ? Date.parse(held.expires_at) : Number.NaN;
    if (read.reason || !heldToken || !Number.isFinite(expiresAt)) {
      throw new NotebookError("CONFLICT", "Notebook state lock has an integrity finding; preserve it and run pj notebook audit --json");
    }
    if (Date.now() >= expiresAt) {
      const recovery = join15(paths.locks, `recovery-${heldToken}.lock`);
      const recoveryRecord = jsonLine({ schema_version: NOTEBOOK_SCHEMA_VERSION, stale_token: heldToken, recovery_token: token, expires_at: new Date(Date.now() + 5e3).toISOString() });
      if (exclusiveWrite(recovery, recoveryRecord, paths.root)) {
        try {
          const verify = safeReadJson(lock, 8192);
          const currentToken = verify.value && typeof verify.value === "object" && !Array.isArray(verify.value) ? verify.value.token : null;
          const currentExpiry = verify.value && typeof verify.value === "object" && !Array.isArray(verify.value) ? Date.parse(String(verify.value.expires_at ?? "")) : Number.NaN;
          if (currentToken === heldToken && Number.isFinite(currentExpiry) && Date.now() >= currentExpiry) {
            const recovered = join15(paths.locks, `.recovered-${heldToken}-${randomUUID3()}.json`);
            renameStateFile(lock, recovered, paths.root);
            unlinkStateFile(recovered, paths.root);
          }
        } finally {
          try {
            unlinkStateFile(recovery, paths.root);
          } catch {
          }
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new NotebookError("TIMEOUT", "Notebook capture admission lock is busy", true);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
function withNotebookStateLock(root, projectSlug, maxWaitMs, operation) {
  const paths = ensureNotebookState(root, projectSlug);
  const release = acquireLock(paths, maxWaitMs);
  try {
    return operation(paths);
  } finally {
    release();
  }
}
function readNotebookStateJson(path, root, maxBytes) {
  assertContained(root, path);
  return safeReadJson(path, maxBytes);
}
function createNotebookStateJsonExclusive(path, value, root) {
  return exclusiveWrite(path, jsonLine(value), root);
}
function addBoundedIntegrity(target, limits, entry, knownBytes = 0) {
  target.integrityCount += 1;
  target.knownBytes += Math.max(0, knownBytes);
  if (target.integrity.length < limits.integrity_max_entries) target.integrity.push(entry);
}
function journalReference(value) {
  const item = parseRemoteMutationJournal(value);
  if (!item) return null;
  const unresolved = item.state !== "committed";
  return {
    ...item.session_key ? { sessionKey: item.session_key } : {},
    unresolved,
    ...unresolved ? { summary: {
      operation_id: item.operation_id,
      kind: item.kind,
      logical_marker: item.logical_marker,
      session_key: item.session_key ?? null,
      state: item.state,
      binding_id: item.binding_id ?? null,
      candidate_ids: [...item.candidate_ids],
      result_category: item.result_category,
      next_action: item.next_action
    } } : {}
  };
}
function scanAuxiliaryState(paths, limits) {
  const scan = { integrity: [], integrityCount: 0, knownBytes: 0, referencedSessions: /* @__PURE__ */ new Set(), unresolvedJournals: [] };
  const specifications = [
    { kind: "baselines", dir: paths.baselines, suffix: ".json", maxBytes: baselineReceiptByteCeiling(limits), parse: parseBaseline, key: (value) => value.session_key },
    { kind: "claims", dir: paths.claims, suffix: ".overview", maxBytes: limits.receipt_max_bytes, parse: parseClaim, key: (value) => value.session_key },
    { kind: "refusals", dir: paths.refusals, suffix: ".json", maxBytes: limits.receipt_max_bytes, parse: parseRefusal, key: (value) => value.session_key }
  ];
  for (const specification of specifications) {
    if (!existsSync14(specification.dir)) continue;
    let entries;
    try {
      entries = readStateDirectory(specification.dir, paths.root);
    } catch {
      addBoundedIntegrity(scan, limits, { entry_id: specification.kind, reason: "unreadable" });
      continue;
    }
    for (const entry of entries) {
      const entryId = safeEntryId(specification.kind, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(specification.suffix)) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join15(specification.dir, entry.name), specification.maxBytes);
      if (read.reason || read.value === void 0) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const parsed = specification.parse(read.value);
      const expectedKey = parsed ? specification.key(parsed) : null;
      const expectedName = expectedKey ? `${expectedKey}${specification.suffix}` : null;
      if (!parsed || expectedName !== entry.name) addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
    }
  }
  if (existsSync14(paths.journals)) {
    let entries;
    try {
      entries = readStateDirectory(paths.journals, paths.root);
    } catch {
      addBoundedIntegrity(scan, limits, { entry_id: "journals", reason: "unreadable" });
      entries = [];
    }
    for (const entry of entries) {
      const entryId = safeEntryId("journals", entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join15(paths.journals, entry.name), limits.receipt_max_bytes);
      if (read.reason || read.value === void 0) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const reference = journalReference(read.value);
      const operationId = reference && typeof read.value.operation_id === "string" ? read.value.operation_id : null;
      if (!reference || `${operationId}.json` !== entry.name) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
        continue;
      }
      if (reference.unresolved && reference.sessionKey) scan.referencedSessions.add(reference.sessionKey);
      if (reference.summary) scan.unresolvedJournals.push(reference.summary);
    }
  }
  if (existsSync14(paths.locks)) {
    let entries;
    try {
      entries = readStateDirectory(paths.locks, paths.root);
    } catch {
      addBoundedIntegrity(scan, limits, { entry_id: "locks", reason: "unreadable" });
      entries = [];
    }
    for (const entry of entries) {
      const entryId = safeEntryId("locks", entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "non-regular" });
        continue;
      }
      const read = safeReadJson(join15(paths.locks, entry.name), 8192);
      if (read.reason || read.value === void 0) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
        continue;
      }
      const item = read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : null;
      const token = entry.name === "admission.lock" ? item?.token : item?.recovery_token;
      const expiry = Date.parse(String(item?.expires_at ?? ""));
      const expectedRecovery = entry.name.startsWith("recovery-") && entry.name.endsWith(".lock") && item?.stale_token === entry.name.slice(9, -5);
      if (!item || item.schema_version !== 1 || typeof token !== "string" || !Number.isFinite(expiry) || entry.name !== "admission.lock" && !expectedRecovery || Date.now() >= expiry) {
        addBoundedIntegrity(scan, limits, { entry_id: entryId, reason: "invalid-schema" }, read.bytes);
      }
    }
  }
  return scan;
}
function scanReceipts(paths, limits) {
  const receipts = [];
  const integrity = [];
  const referencedSessions = /* @__PURE__ */ new Set();
  let unresolvedCount = 0;
  let unresolvedBytes = 0;
  let integrityCount = 0;
  const addIntegrity = (entry, knownBytes = 0) => {
    integrityCount += 1;
    unresolvedCount += 1;
    unresolvedBytes += Math.max(0, knownBytes);
    if (integrity.length < limits.integrity_max_entries) integrity.push(entry);
  };
  if (!existsSync14(paths.receipts)) return { receipts, unresolvedCount, unresolvedBytes, referencedSessions, integrity, integrityCount };
  let entries;
  try {
    entries = readStateDirectory(paths.receipts, paths.root);
  } catch {
    addIntegrity({ entry_id: "receipts", reason: "unreadable" });
    return { receipts, unresolvedCount, unresolvedBytes, referencedSessions, integrity, integrityCount };
  }
  for (const entry of entries) {
    const entryId = safeEntryId("receipts", entry.name);
    const path = join15(paths.receipts, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      addIntegrity({ entry_id: entryId, reason: "non-regular" });
      continue;
    }
    const read = safeReadJson(path, limits.receipt_max_bytes);
    if (read.reason || read.value === void 0) {
      addIntegrity({ entry_id: entryId, reason: read.reason ?? "invalid-json" }, read.bytes);
      continue;
    }
    const receipt = parseReceipt(read.value);
    if (!receipt || `${receipt.receipt_id}.json` !== entry.name || receipt.serialized_bytes !== read.bytes) {
      addIntegrity({ entry_id: entryId, reason: "invalid-schema" }, read.bytes);
      continue;
    }
    receipts.push(receipt);
    referencedSessions.add(receipt.session_key);
    if (UNRESOLVED_RECEIPT_STATES.has(receipt.state)) {
      unresolvedCount += 1;
      unresolvedBytes += read.bytes;
    }
  }
  return { receipts, unresolvedCount, unresolvedBytes, integrity, integrityCount, referencedSessions };
}
function scanBaselines(paths, nowMs, limits, referenced) {
  let current = 0;
  let stale = 0;
  if (!existsSync14(paths.baselines)) return { current, stale };
  for (const entry of readStateDirectory(paths.baselines, paths.root)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const baseline = readBaseline(join15(paths.baselines, entry.name), baselineReceiptByteCeiling(limits));
    if (!baseline || referenced.has(baseline.session_key)) continue;
    const expires = Date.parse(baseline.created_at) + limits.receiptless_session_retention_seconds * 1e3;
    if (nowMs >= expires) stale += 1;
    else current += 1;
  }
  return { current, stale };
}
function scanRefusals(paths, nowMs, limits, scan) {
  const result2 = [];
  if (!existsSync14(paths.refusals)) return result2;
  const entries = readStateDirectory(paths.refusals, paths.root).sort((a, b) => a.name.localeCompare(b.name, "en")).slice(0, limits.refusal_max_entries);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const read = safeReadJson(join15(paths.refusals, entry.name), limits.receipt_max_bytes);
    const marker = read.value === void 0 ? null : parseRefusal(read.value);
    if (!marker || `${marker.session_key}.json` !== entry.name) continue;
    if (nowMs >= Date.parse(marker.baseline_created_at) + limits.receiptless_session_retention_seconds * 1e3) continue;
    result2.push({
      outcome: "capture-refused-history",
      session_key: marker.session_key,
      refused_at: marker.refused_at,
      reason: marker.reason,
      current_count: scan.unresolvedCount,
      current_bytes: scan.unresolvedBytes,
      candidate_bytes: marker.candidate_bytes,
      max_count: limits.unresolved_receipt_max_count,
      max_bytes: limits.unresolved_receipt_max_bytes,
      next_actions: [...marker.next_actions]
    });
  }
  return result2.sort((a, b) => a.refused_at.localeCompare(b.refused_at) || a.session_key.localeCompare(b.session_key));
}
function captureAdmissionSummary(root, projectSlug, limits, now = /* @__PURE__ */ new Date()) {
  const paths = notebookStatePaths(root, projectSlug);
  const scan = scanReceipts(paths, limits);
  const auxiliary = scanAuxiliaryState(paths, limits);
  const referenced = /* @__PURE__ */ new Set([...scan.referencedSessions, ...auxiliary.referencedSessions]);
  const baselines = scanBaselines(paths, now.getTime(), limits, referenced);
  const exact = scan.integrityCount === 0 && auxiliary.integrityCount === 0;
  const integrity = [...scan.integrity, ...auxiliary.integrity].slice(0, limits.integrity_max_entries);
  const integrityCount = scan.integrityCount + auxiliary.integrityCount;
  return {
    unresolved_count: exact ? scan.unresolvedCount : null,
    unresolved_count_lower_bound: scan.unresolvedCount,
    unresolved_bytes: exact ? scan.unresolvedBytes : null,
    unresolved_bytes_lower_bound: scan.unresolvedBytes + auxiliary.knownBytes,
    unmeasurable_entry_count: integrityCount,
    integrity_entries: integrity,
    receipt_caps: { max_count: limits.unresolved_receipt_max_count, max_bytes: limits.unresolved_receipt_max_bytes },
    receiptless_session_count: baselines.current,
    stale_receiptless_session_count: baselines.stale,
    active_refusals: scanRefusals(paths, now.getTime(), limits, scan),
    unresolvedJournals: auxiliary.unresolvedJournals.sort((a, b) => a.operation_id.localeCompare(b.operation_id, "en")).slice(0, limits.integrity_max_entries)
  };
}
function publicCaptureAdmissionSummary(summary) {
  const { unresolvedJournals: _internalJournals, ...publicSummary } = summary;
  return publicSummary;
}
function createCandidate(input) {
  const receiptId = deriveReceiptId(input.sessionKey);
  const timestamp2 = input.now.toISOString();
  const receipt = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    receipt_id: receiptId,
    logical_id: sessionCaptureLogicalId(input.sessionKey),
    session_key: input.sessionKey,
    project_slug: input.projectSlug,
    repo_path_digest: repoPathDigest(input.repoPath),
    baseline_ref: input.baseline?.git_head ?? null,
    end_revision: input.endRevision,
    end_status_digest: input.endStatusDigest,
    state: "queued",
    automatic_attempts_used: 0,
    automatic_attempt_limit: input.limits.automatic_attempt_limit,
    manual_retry_count: 0,
    attempt_origin: "automatic",
    lease_owner: null,
    lease_deadline: null,
    created_at: timestamp2,
    updated_at: timestamp2,
    exclusion_counts: {},
    summary_mode: null,
    note_logical_ids: [],
    remote_note_ids: [],
    error_category: null,
    retryable: false,
    diagnostic: null,
    serialized_bytes: 1
  };
  let text3 = jsonLine(receipt);
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = Buffer.byteLength(text3, "utf8");
    if (receipt.serialized_bytes === bytes) return { receipt, text: text3, bytes };
    receipt.serialized_bytes = bytes;
    text3 = jsonLine(receipt);
  }
  throw new NotebookError("INTERNAL_ERROR", "Capture receipt serialized size did not converge");
}
function capReason(countBlocked, byteBlocked) {
  return countBlocked && byteBlocked ? "both" : countBlocked ? "count-cap" : "byte-cap";
}
function recoveryActions(receiptId, repoPath) {
  return [
    `pj notebook capture list ${repoPath}`,
    `pj notebook capture retry ${receiptId} ${repoPath} (add --baseline GIT_REF for blocked-missing-baseline)`
  ];
}
function removeValidRefusal(paths, sessionKey, limits) {
  const path = join15(paths.refusals, `${sessionKey}.json`);
  if (!existsSync14(path)) return;
  const read = safeReadJson(path, limits.receipt_max_bytes);
  const marker = read.value === void 0 ? null : parseRefusal(read.value);
  if (!marker || marker.session_key !== sessionKey) return;
  unlinkStateFile(path, paths.root);
}
function admitCaptureReceipt(input) {
  assertDigest(input.sessionKey, "session key");
  const now = input.now ?? /* @__PURE__ */ new Date();
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, Math.min(100, input.limits.hook_session_end_timeout_ms));
  try {
    const receiptId = deriveReceiptId(input.sessionKey);
    const receiptPath = join15(paths.receipts, `${receiptId}.json`);
    if (existsSync14(receiptPath)) {
      const read = safeReadJson(receiptPath, input.limits.receipt_max_bytes);
      const receipt = read.value === void 0 ? null : parseReceipt(read.value);
      if (receipt && receipt.receipt_id === receiptId && receipt.session_key === input.sessionKey && receipt.serialized_bytes === read.bytes) {
        removeValidRefusal(paths, input.sessionKey, input.limits);
        return { outcome: "deduplicated", receipt };
      }
    }
    const scanBefore = scanReceipts(paths, input.limits);
    const auxiliaryBefore = scanAuxiliaryState(paths, input.limits);
    const referencedBefore = /* @__PURE__ */ new Set([...scanBefore.referencedSessions, ...auxiliaryBefore.referencedSessions]);
    const baselinePath = join15(paths.baselines, `${input.sessionKey}.json`);
    let baseline = readBaseline(baselinePath, baselineReceiptByteCeiling(input.limits));
    if (baseline) {
      const expired = now.getTime() >= Date.parse(baseline.created_at) + input.limits.receiptless_session_retention_seconds * 1e3;
      if (expired && !referencedBefore.has(input.sessionKey) && scanBefore.integrityCount === 0 && auxiliaryBefore.integrityCount === 0) {
        unlinkStateFile(baselinePath, paths.root);
        const claimPath = join15(paths.claims, `${input.sessionKey}.overview`);
        unlinkStateFile(claimPath, paths.root, true);
        const refusalPath = join15(paths.refusals, `${input.sessionKey}.json`);
        unlinkStateFile(refusalPath, paths.root, true);
        baseline = null;
      }
    }
    const candidate = createCandidate({
      sessionKey: input.sessionKey,
      projectSlug: input.projectSlug,
      repoPath: input.repoPath,
      baseline,
      endRevision: input.endRevision,
      endStatusDigest: input.endStatusDigest,
      now,
      limits: input.limits
    });
    if (candidate.bytes > input.limits.receipt_max_bytes) throw new NotebookError("INTERNAL_ERROR", "Capture receipt candidate exceeds its per-receipt ceiling");
    const summary = captureAdmissionSummary(input.root, input.projectSlug, input.limits, now);
    if (summary.unmeasurable_entry_count > 0 || summary.unresolved_count === null || summary.unresolved_bytes === null) {
      const ids = summary.integrity_entries.map((entry) => entry.entry_id).join(",");
      return {
        outcome: "state-integrity",
        summary,
        diagnostic: `state-integrity: this session was not captured; unresolved bytes>=${summary.unresolved_bytes_lower_bound} exact=unknown unmeasurable=${summary.unmeasurable_entry_count} entries=${ids}; run pj notebook audit ${input.repoPath} --local-only --json, repair the reported entry in place without deleting it, then rerun pj notebook audit ${input.repoPath} --local-only --json`
      };
    }
    const countBlocked = summary.unresolved_count + 1 > input.limits.unresolved_receipt_max_count;
    const byteBlocked = summary.unresolved_bytes + candidate.bytes > input.limits.unresolved_receipt_max_bytes;
    if (countBlocked || byteBlocked) {
      const actions = recoveryActions(receiptId, input.repoPath);
      const refusalPath = join15(paths.refusals, `${input.sessionKey}.json`);
      const oldRead = existsSync14(refusalPath) ? safeReadJson(refusalPath, input.limits.receipt_max_bytes) : void 0;
      const old = oldRead?.value === void 0 ? null : parseRefusal(oldRead.value);
      const marker = {
        schema_version: NOTEBOOK_SCHEMA_VERSION,
        session_key: input.sessionKey,
        baseline_created_at: old?.baseline_created_at ?? baseline?.created_at ?? now.toISOString(),
        refused_at: now.toISOString(),
        reason: capReason(countBlocked, byteBlocked),
        current_count: summary.unresolved_count,
        current_bytes: summary.unresolved_bytes,
        candidate_bytes: candidate.bytes,
        max_count: input.limits.unresolved_receipt_max_count,
        max_bytes: input.limits.unresolved_receipt_max_bytes,
        next_actions: actions
      };
      atomicWriteJson(refusalPath, marker, paths.root);
      return {
        outcome: "retention-pressure",
        marker,
        diagnostic: `retention-pressure: this session was not captured; unresolved count=${marker.current_count}/${marker.max_count} bytes=${marker.current_bytes}/${marker.max_bytes} candidate_bytes=${marker.candidate_bytes} reason=${marker.reason}; run ${actions[0]}, then ${actions[1]}`
      };
    }
    if (!exclusiveWrite(receiptPath, candidate.text, paths.root)) {
      const read = safeReadJson(receiptPath, input.limits.receipt_max_bytes);
      const receipt = read.value === void 0 ? null : parseReceipt(read.value);
      if (!receipt) throw new NotebookError("INTERNAL_ERROR", "Concurrent receipt creation produced invalid state");
      return { outcome: "deduplicated", receipt };
    }
    removeValidRefusal(paths, input.sessionKey, input.limits);
    return { outcome: "admitted", receipt: candidate.receipt, candidate_bytes: candidate.bytes };
  } finally {
    release();
  }
}
function receiptSummary(receipt) {
  return {
    receipt_id: receipt.receipt_id,
    logical_id: receipt.logical_id,
    session_key: receipt.session_key,
    state: receipt.state,
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
    automatic_attempts_used: receipt.automatic_attempts_used,
    automatic_attempt_limit: receipt.automatic_attempt_limit,
    manual_retry_count: receipt.manual_retry_count,
    attempt_origin: receipt.attempt_origin,
    error_category: receipt.error_category,
    retryable: receipt.retryable,
    diagnostic: receipt.diagnostic,
    summary_mode: receipt.summary_mode,
    exclusion_counts: { ...receipt.exclusion_counts },
    note_logical_ids: [...receipt.note_logical_ids],
    remote_note_ids: [...receipt.remote_note_ids],
    serialized_bytes: receipt.serialized_bytes
  };
}
function listCaptureReceipts(root, projectSlug, limits, state) {
  const paths = notebookStatePaths(root, projectSlug);
  const scan = scanReceipts(paths, limits);
  if (scan.integrityCount) throw new NotebookError("CONFLICT", "Notebook capture state has integrity findings", false, { entries: scan.integrityCount });
  if (state && !["queued", "processing", "succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"].includes(state)) {
    throw new NotebookError("INVALID_INPUT", `Unknown capture receipt state: ${state}`);
  }
  return scan.receipts.filter((receipt) => !state || receipt.state === state).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.receipt_id.localeCompare(b.receipt_id)).map(receiptSummary);
}
function readCaptureReceipt(root, projectSlug, receiptId, limits) {
  if (!RECEIPT_ID_RE.test(receiptId)) throw new NotebookError("INVALID_INPUT", "Invalid receipt ID");
  const paths = notebookStatePaths(root, projectSlug);
  const path = join15(paths.receipts, `${receiptId}.json`);
  if (!existsSync14(path)) throw new NotebookError("NOT_FOUND", `Capture receipt not found: ${receiptId}`);
  const read = safeReadJson(path, limits.receipt_max_bytes);
  const receipt = read.value === void 0 ? null : parseReceipt(read.value);
  if (!receipt || receipt.serialized_bytes !== read.bytes) throw new NotebookError("CONFLICT", `Capture receipt has an integrity finding: ${receiptId}`);
  return receipt;
}
function writeReceipt(paths, receipt, limit) {
  let text3 = jsonLine(receipt);
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.byteLength(text3, "utf8");
    if (bytes > limit) throw new NotebookError("CONFLICT", "Receipt transition exceeds its per-receipt ceiling");
    if (receipt.serialized_bytes === bytes) {
      atomicWriteJson(join15(paths.receipts, `${receipt.receipt_id}.json`), receipt, paths.root);
      return receipt;
    }
    receipt.serialized_bytes = bytes;
    text3 = jsonLine(receipt);
  }
  throw new NotebookError("INTERNAL_ERROR", "Receipt transition size did not converge");
}
function captureReceiptVersion(receipt) {
  return { state: receipt.state, updated_at: receipt.updated_at, lease_owner: receipt.lease_owner };
}
function nextReceiptTimestamp(receipt, now) {
  const requested = now.getTime();
  const previous = Date.parse(receipt.updated_at);
  return new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString();
}
function authorizeCaptureRetry(input) {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1e3);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state === "blocked-missing-baseline") {
      if (!input.baseline) throw new NotebookError("INVALID_INPUT", "blocked-missing-baseline requires --baseline GIT_REF");
      if (!input.validateBaseline?.(input.baseline)) throw new NotebookError("INVALID_INPUT", "--baseline must name a contained committed Git reference");
      receipt.manual_baseline_ref = input.baseline;
      receipt.baseline_ref = input.baseline;
    } else if (receipt.state !== "failed" && receipt.state !== "retry-exhausted") {
      throw new NotebookError("CONFLICT", `Receipt in state ${receipt.state} cannot be retried`);
    }
    receipt.state = "queued";
    receipt.manual_retry_count += 1;
    receipt.attempt_origin = "operator";
    receipt.lease_owner = null;
    receipt.lease_deadline = null;
    receipt.updated_at = nextReceiptTimestamp(receipt, input.now ?? /* @__PURE__ */ new Date());
    receipt.error_category = null;
    receipt.retryable = false;
    receipt.diagnostic = null;
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally {
    release();
  }
}
function claimCaptureReceipt(input) {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1e3);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    const now = input.now ?? /* @__PURE__ */ new Date();
    const resumingExpiredLease = receipt.state === "processing" && Boolean(receipt.lease_deadline) && Date.parse(receipt.lease_deadline) <= now.getTime();
    const resumingAutomaticFailure = receipt.state === "failed" && receipt.attempt_origin === "automatic" && receipt.retryable && receipt.automatic_attempts_used < receipt.automatic_attempt_limit;
    if (receipt.state !== "queued" && !resumingExpiredLease && !resumingAutomaticFailure) throw new NotebookError("CONFLICT", `Receipt in state ${receipt.state} cannot be claimed`);
    if (receipt.attempt_origin === "automatic") {
      if (receipt.automatic_attempts_used >= receipt.automatic_attempt_limit) {
        if (resumingExpiredLease) {
          receipt.state = "retry-exhausted";
          receipt.lease_owner = null;
          receipt.lease_deadline = null;
          receipt.updated_at = nextReceiptTimestamp(receipt, now);
          receipt.retryable = false;
          receipt.diagnostic = "Expired worker lease exhausted the finite automatic attempt budget";
          writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
        }
        throw new NotebookError("CONFLICT", "Automatic capture attempt budget is exhausted");
      }
      receipt.automatic_attempts_used += 1;
    }
    receipt.state = "processing";
    receipt.lease_owner = (input.workerId ?? `${process.pid}-${randomUUID3()}`).slice(0, 128);
    receipt.lease_deadline = new Date(now.getTime() + input.limits.lease_seconds * 1e3).toISOString();
    receipt.updated_at = nextReceiptTimestamp(receipt, now);
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally {
    release();
  }
}
function renewCaptureReceiptLease(input) {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1e3);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state !== "processing" || !receipt.lease_owner || receipt.state !== input.expected.state || receipt.updated_at !== input.expected.updated_at || receipt.lease_owner !== input.expected.lease_owner) {
      throw new NotebookError("CONFLICT", "Capture receipt lease changed; stale worker renewal rejected");
    }
    const now = input.now ?? /* @__PURE__ */ new Date();
    receipt.lease_deadline = new Date(now.getTime() + input.limits.lease_seconds * 1e3).toISOString();
    receipt.updated_at = nextReceiptTimestamp(receipt, now);
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally {
    release();
  }
}
function transitionCaptureReceipt(input) {
  const paths = ensureNotebookState(input.root, input.projectSlug);
  const release = acquireLock(paths, 1e3);
  try {
    const receipt = readCaptureReceipt(input.root, input.projectSlug, input.receiptId, input.limits);
    if (receipt.state !== input.expected.state || receipt.updated_at !== input.expected.updated_at || receipt.lease_owner !== input.expected.lease_owner) {
      throw new NotebookError("CONFLICT", "Capture receipt changed after it was claimed; stale worker transition rejected");
    }
    if (receipt.state === "processing" && !receipt.lease_owner) throw new NotebookError("CONFLICT", "Processing receipt has no valid lease owner");
    const allowed = {
      queued: /* @__PURE__ */ new Set(["processing"]),
      processing: /* @__PURE__ */ new Set(["succeeded", "failed", "retry-exhausted", "blocked-missing-baseline"]),
      failed: /* @__PURE__ */ new Set(["queued"]),
      "retry-exhausted": /* @__PURE__ */ new Set(),
      "blocked-missing-baseline": /* @__PURE__ */ new Set(),
      succeeded: /* @__PURE__ */ new Set()
    };
    if (!allowed[receipt.state].has(input.state)) throw new NotebookError("CONFLICT", `Capture receipt cannot transition from ${receipt.state} to ${input.state}`);
    receipt.state = input.state;
    receipt.updated_at = nextReceiptTimestamp(receipt, input.now ?? /* @__PURE__ */ new Date());
    receipt.lease_owner = null;
    receipt.lease_deadline = null;
    receipt.error_category = input.errorCategory ?? null;
    receipt.retryable = input.retryable ?? false;
    receipt.diagnostic = input.diagnostic?.slice(0, input.limits.diagnostic_max_chars) ?? null;
    if (input.exclusionCounts) receipt.exclusion_counts = { ...input.exclusionCounts };
    if (input.summaryMode !== void 0) receipt.summary_mode = input.summaryMode;
    if (input.noteLogicalIds) receipt.note_logical_ids = [...new Set(input.noteLogicalIds)].slice(0, 2e3);
    if (input.remoteNoteIds) receipt.remote_note_ids = [...new Set(input.remoteNoteIds)].slice(0, 2e3);
    if (input.endRevision !== void 0) receipt.end_revision = input.endRevision;
    if (input.endStatusDigest !== void 0) receipt.end_status_digest = input.endStatusDigest;
    return writeReceipt(paths, receipt, input.limits.receipt_max_bytes);
  } finally {
    release();
  }
}
function pruneNotebookState(root, projectSlug, limits, now = /* @__PURE__ */ new Date()) {
  const paths = ensureNotebookState(root, projectSlug);
  const release = acquireLock(paths, 1e3);
  const removed = [];
  try {
    const scan = scanReceipts(paths, limits);
    const auxiliary = scanAuxiliaryState(paths, limits);
    if (scan.integrityCount || auxiliary.integrityCount) return removed;
    const successCutoff = now.getTime() - limits.receipt_succeeded_retention_days * 864e5;
    for (const receipt of scan.receipts) {
      if (receipt.state !== "succeeded" || Date.parse(receipt.updated_at) > successCutoff) continue;
      const path = join15(paths.receipts, `${receipt.receipt_id}.json`);
      unlinkStateFile(path, paths.root);
      removed.push(safeEntryId("receipts", basename6(path)));
    }
    const remaining = scanReceipts(paths, limits);
    const remainingAuxiliary = scanAuxiliaryState(paths, limits);
    const referenced = /* @__PURE__ */ new Set([...remaining.referencedSessions, ...remainingAuxiliary.referencedSessions]);
    for (const entry of readStateDirectory(paths.baselines, paths.root)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join15(paths.baselines, entry.name);
      const baseline = readBaseline(path, baselineReceiptByteCeiling(limits));
      if (!baseline || referenced.has(baseline.session_key)) continue;
      if (now.getTime() < Date.parse(baseline.created_at) + limits.receiptless_session_retention_seconds * 1e3) continue;
      unlinkStateFile(path, paths.root);
      removed.push(safeEntryId("baselines", entry.name));
      const claim = join15(paths.claims, `${baseline.session_key}.overview`);
      if (unlinkStateFile(claim, paths.root, true)) removed.push(safeEntryId("claims", basename6(claim)));
      const refusal = join15(paths.refusals, `${baseline.session_key}.json`);
      if (unlinkStateFile(refusal, paths.root, true)) removed.push(safeEntryId("refusals", basename6(refusal)));
    }
    fsyncDirectory2(paths.project);
    return removed;
  } finally {
    release();
  }
}
function currentRetentionPressure(summary) {
  if (summary.unresolved_count === null || summary.unresolved_bytes === null) return [];
  const findings = [];
  if (summary.unresolved_count >= summary.receipt_caps.max_count || summary.unresolved_bytes >= summary.receipt_caps.max_bytes) {
    findings.push({ code: "retention-pressure", reason: "current-usage" });
  }
  for (const marker of summary.active_refusals) {
    const countBlocked = summary.unresolved_count + 1 > summary.receipt_caps.max_count;
    const byteBlocked = summary.unresolved_bytes + marker.candidate_bytes > summary.receipt_caps.max_bytes;
    if (countBlocked || byteBlocked) findings.push({ code: "retention-pressure", session_key: marker.session_key, reason: capReason(countBlocked, byteBlocked) });
  }
  return findings;
}
function statePathForReceipt(root, projectSlug, receiptId) {
  if (!RECEIPT_ID_RE.test(receiptId)) throw new NotebookError("INVALID_INPUT", "Invalid receipt ID");
  return join15(projectStateDir(root, projectSlug), "receipts", `${receiptId}.json`);
}
var NOTEBOOK_STATE_VERSION, SESSION_KEY_RE, RECEIPT_ID_RE, GIT_OBJECT_RE, NOTEBOOK_ERROR_CODES, DIRECTORY_OPEN_FLAGS;
var init_state = __esm({
  "src/notebook/state.ts"() {
    "use strict";
    init_notes();
    init_remote_mutation_schema();
    init_types();
    NOTEBOOK_STATE_VERSION = "v1";
    SESSION_KEY_RE = /^[a-f0-9]{64}$/u;
    RECEIPT_ID_RE = /^[a-f0-9]{64}$/u;
    GIT_OBJECT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
    NOTEBOOK_ERROR_CODES = /* @__PURE__ */ new Set([
      "INVALID_INPUT",
      "NOT_CONFIGURED",
      "AUTHENTICATION_FAILED",
      "NOT_FOUND",
      "CONFLICT",
      "CROSS_PROJECT",
      "DRIFT_DETECTED",
      "THROTTLED",
      "TIMEOUT",
      "SERVICE_UNAVAILABLE",
      "REMOTE_PROTOCOL_ERROR",
      "INTERNAL_ERROR"
    ]);
    DIRECTORY_OPEN_FLAGS = constants3.O_RDONLY | (constants3.O_DIRECTORY ?? 0) | (constants3.O_NOFOLLOW ?? 0);
  }
});

// src/notebook/open-notebook-client.ts
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function boundedString2(value, name, max = 1048576) {
  if (typeof value !== "string" || value.length > max) throw new NotebookError("REMOTE_PROTOCOL_ERROR", `Open Notebook returned invalid ${name}`);
  return value;
}
function optionalString(value, name, max = 8192) {
  if (value == null) return value;
  return boundedString2(value, name, max);
}
function responseTimestamp(value, current, legacy, subject) {
  return optionalString(value[current] !== void 0 ? value[current] : value[legacy], `${subject} ${current}`, 128);
}
function normalizeOpenNotebookNoteType(value) {
  const normalized = value ?? "human";
  if (normalized !== "human" && normalized !== "ai") throw new NotebookError("INVALID_INPUT", "Open Notebook note_type must be human or ai");
  return normalized;
}
function parseNotebook(value) {
  if (!isRecord3(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an invalid notebook");
  return {
    id: boundedString2(value.id, "notebook id", 512),
    name: boundedString2(value.name, "notebook name", 4096),
    description: optionalString(value.description, "notebook description", 16384),
    archived: typeof value.archived === "boolean" ? value.archived : void 0,
    created_at: responseTimestamp(value, "created", "created_at", "notebook"),
    updated_at: responseTimestamp(value, "updated", "updated_at", "notebook")
  };
}
function parseNoteRecord(value, noteMaxBytes, allowNullContent) {
  if (!isRecord3(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an invalid note");
  const content = value.content === null && allowNullContent ? null : boundedString2(value.content, "note content", noteMaxBytes);
  if (content !== null && Buffer.byteLength(content, "utf8") > noteMaxBytes) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook note content exceeds the configured ceiling");
  const noteType = boundedString2(value.note_type, "note type", 128);
  if (noteType !== "human" && noteType !== "ai") throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned an unsupported note type");
  return {
    id: boundedString2(value.id, "note id", 512),
    title: boundedString2(value.title, "note title", 4096),
    content,
    note_type: noteType,
    created_at: responseTimestamp(value, "created", "created_at", "note") ?? null,
    updated_at: responseTimestamp(value, "updated", "updated_at", "note") ?? null
  };
}
function parseScopedNoteListItem(value, noteMaxBytes) {
  return parseNoteRecord(value, noteMaxBytes, true);
}
function parseNote(value, noteMaxBytes) {
  const note2 = parseNoteRecord(value, noteMaxBytes, false);
  if (note2.content === null) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned invalid note content");
  return note2;
}
function errorForStatus(status, message) {
  if (status === 400 || status === 422) return new NotebookError("INVALID_INPUT", message, false, { http_status: status, definitive_rejection: true });
  if (status === 401 || status === 403) return new NotebookError("AUTHENTICATION_FAILED", message);
  if (status === 404) return new NotebookError("NOT_FOUND", message);
  if (status === 409) return new NotebookError("CONFLICT", message);
  if (status === 429) return new NotebookError("THROTTLED", message, true);
  if (status >= 500) return new NotebookError("SERVICE_UNAVAILABLE", message, true);
  return new NotebookError("REMOTE_PROTOCOL_ERROR", message);
}
async function readResponseBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
    }
    throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook response exceeds the configured ceiling");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
        }
        throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook response exceeds the configured ceiling");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
var OpenNotebookClient;
var init_open_notebook_client = __esm({
  "src/notebook/open-notebook-client.ts"() {
    "use strict";
    init_config();
    init_types();
    OpenNotebookClient = class {
      constructor(config, options = {}) {
        this.config = config;
        if (!config.base_url) throw new NotebookError("NOT_CONFIGURED", "Notebook base_url is not configured");
        this.baseUrl = validateNotebookBaseUrl(config.base_url);
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.env = options.env ?? process.env;
        this.deadlineMonotonicMs = options.deadlineMonotonicMs;
      }
      fetchImpl;
      baseUrl;
      env;
      deadlineMonotonicMs;
      authEnabled;
      async health() {
        const value = await this.request("/api/config", { skipAuthProbe: true, suppressAuthorization: true });
        if (!isRecord3(value)) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook /api/config returned a non-object");
        const version = typeof value.version === "string" ? value.version.slice(0, 128) : typeof value.app_version === "string" ? value.app_version.slice(0, 128) : null;
        const authEnabled = await this.authStatus();
        return { version, auth_enabled: authEnabled };
      }
      async authStatus() {
        const value = await this.request("/api/auth/status", { skipAuthProbe: true, suppressAuthorization: true });
        if (!isRecord3(value) || typeof value.auth_enabled !== "boolean") throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook auth status returned an invalid response");
        this.authEnabled = value.auth_enabled;
        return value.auth_enabled;
      }
      async listNotebooks() {
        const value = await this.request("/api/notebooks");
        if (!Array.isArray(value) || value.length > this.config.limits.list_max_items) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook notebook list is invalid or incomplete under configured limits");
        return value.map(parseNotebook);
      }
      async createNotebook(input, possiblyDispatched) {
        return parseNotebook(await this.request("/api/notebooks", { method: "POST", body: input, possiblyDispatched }));
      }
      async updateNotebook(id, input) {
        return parseNotebook(await this.request(`/api/notebooks/${encodeURIComponent(id)}`, { method: "PUT", body: input }));
      }
      async listNotes(notebookId) {
        const operationDeadline = Math.min(
          this.deadlineMonotonicMs ?? Number.POSITIVE_INFINITY,
          performance.now() + this.config.limits.overall_timeout_ms
        );
        const value = await this.request(`/api/notes?notebook_id=${encodeURIComponent(notebookId)}`, { deadlineMonotonicMs: operationDeadline });
        if (!Array.isArray(value) || value.length > this.config.limits.list_max_items) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook scoped note list is invalid or incomplete under configured limits");
        const members = value.map((item) => parseScopedNoteListItem(item, this.config.limits.note_max_bytes));
        if (new Set(members.map((item) => item.id)).size !== members.length) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook scoped note list contains duplicate IDs");
        const notes = new Array(members.length);
        let nextIndex = 0;
        const hydrate = async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const member = members[index];
            if (!member) return;
            const detail = parseNote(await this.request(`/api/notes/${encodeURIComponent(member.id)}`, { deadlineMonotonicMs: operationDeadline }), this.config.limits.note_max_bytes);
            if (detail.id !== member.id) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook note detail ID does not match the proven notebook member");
            notes[index] = detail;
          }
        };
        const workerCount = Math.min(members.length, this.config.limits.note_detail_fetch_concurrency);
        await Promise.all(Array.from({ length: workerCount }, () => hydrate()));
        return notes;
      }
      async createNote(notebookId, input, possiblyDispatched, definitivelyRejected) {
        if (Buffer.byteLength(input.content, "utf8") > this.config.limits.note_max_bytes) throw new NotebookError("INVALID_INPUT", "Note content exceeds the configured ceiling");
        const noteType = normalizeOpenNotebookNoteType(input.note_type);
        return parseNote(await this.request("/api/notes", {
          method: "POST",
          body: { notebook_id: notebookId, title: input.title, content: input.content, note_type: noteType },
          possiblyDispatched,
          definitivelyRejected
        }), this.config.limits.note_max_bytes);
      }
      async getOwnedNote(notebookId, noteId) {
        const notes = await this.listNotes(notebookId);
        const note2 = notes.find((item) => item.id === noteId);
        if (!note2) throw new NotebookError("NOT_FOUND", `Note is not a proven member of the bound notebook: ${noteId}`);
        return note2;
      }
      async updateOwnedNote(notebookId, noteId, input) {
        if (input.content !== void 0 && Buffer.byteLength(input.content, "utf8") > this.config.limits.note_max_bytes) throw new NotebookError("INVALID_INPUT", "Note content exceeds the configured ceiling");
        await this.getOwnedNote(notebookId, noteId);
        return parseNote(await this.request(`/api/notes/${encodeURIComponent(noteId)}`, { method: "PUT", body: input }), this.config.limits.note_max_bytes);
      }
      async deleteOwnedNote(notebookId, noteId) {
        await this.getOwnedNote(notebookId, noteId);
        await this.request(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE", allowEmpty: true });
      }
      async ensureAuthProbe() {
        if (this.authEnabled !== void 0) return;
        if (this.config.auth.mode === "none") {
          this.authEnabled = null;
          return;
        }
        try {
          await this.authStatus();
        } catch (error) {
          if (error instanceof NotebookError && error.code === "AUTHENTICATION_FAILED") throw error;
          this.authEnabled = null;
        }
      }
      async request(path, options = {}) {
        if (!options.skipAuthProbe) await this.ensureAuthProbe();
        const method = options.method ?? "GET";
        const url = new URL(path, `${this.baseUrl}/`);
        if (url.origin !== new URL(this.baseUrl).origin) throw new NotebookError("INVALID_INPUT", "Open Notebook request escaped the configured origin");
        const body = options.body === void 0 ? void 0 : JSON.stringify(options.body);
        if (body !== void 0 && Buffer.byteLength(body, "utf8") > this.config.limits.request_max_bytes) throw new NotebookError("INVALID_INPUT", "Open Notebook request exceeds the configured ceiling");
        const headers = { Accept: "application/json" };
        if (body !== void 0) headers["Content-Type"] = "application/json";
        if (!options.suppressAuthorization && this.config.auth.mode === "environment" && this.authEnabled !== false) {
          headers.Authorization = `Bearer ${runtimeNotebookCredential(this.config, this.env)}`;
        }
        const deadline = Math.min(
          this.deadlineMonotonicMs ?? Number.POSITIVE_INFINITY,
          options.deadlineMonotonicMs ?? Number.POSITIVE_INFINITY
        );
        const remaining = deadline === Number.POSITIVE_INFINITY ? this.config.limits.overall_timeout_ms : Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new NotebookError("TIMEOUT", "Open Notebook request timed out", true);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.config.limits.overall_timeout_ms, remaining)));
        try {
          options.possiblyDispatched?.();
          const response = await this.fetchImpl(url, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: controller.signal
          });
          if (response.status >= 300 && response.status < 400) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook redirect was rejected");
          if (!response.ok) {
            if (response.status === 400 || response.status === 422) options.definitivelyRejected?.(response.status);
            try {
              await readResponseBody(response, Math.min(this.config.limits.response_max_bytes, 4096));
            } catch {
            }
            throw errorForStatus(response.status, `Open Notebook returned HTTP ${response.status}`);
          }
          if (options.allowEmpty && (response.status === 204 || response.headers.get("content-length") === "0")) return null;
          const buffer = await readResponseBody(response, this.config.limits.response_max_bytes);
          if (!buffer.byteLength && options.allowEmpty) return null;
          try {
            return JSON.parse(buffer.toString("utf8"));
          } catch {
            throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Open Notebook returned malformed JSON");
          }
        } catch (error) {
          if (error instanceof NotebookError) throw error;
          if (controller.signal.aborted || error.name === "AbortError") throw new NotebookError("TIMEOUT", "Open Notebook request timed out", true);
          throw new NotebookError("SERVICE_UNAVAILABLE", "Open Notebook request failed", true, {}, { cause: error });
        } finally {
          clearTimeout(timeout);
        }
      }
    };
  }
});

// src/notebook/git-evidence.ts
import { spawnSync as spawnSync9 } from "node:child_process";
import { closeSync as closeSync5, constants as constants4, fstatSync as fstatSync3, lstatSync as lstatSync8, openSync as openSync5, readSync as readSync2, realpathSync as realpathSync5 } from "node:fs";
import { extname, join as join17, relative as relative8, resolve as resolve9, sep as sep4 } from "node:path";
function git(repo, args, maxBuffer = 4 * 1024 * 1024, timeout = 5e3) {
  const result2 = spawnSync9("git", args, { cwd: repo, encoding: "utf8", maxBuffer, timeout, shell: false });
  return { ok: result2.status === 0, stdout: result2.stdout ?? "" };
}
function statusPaths(value) {
  const entries = value.split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (/[RC]/u.test(status)) {
      const prior = entries[++index];
      if (prior) paths.push(prior);
    }
  }
  return paths;
}
function captureGitSnapshot(repoPath, config, deadlineMonotonicMs) {
  const configuredTimeout = config?.limits.overall_timeout_ms ?? 5e3;
  const remaining = () => deadlineMonotonicMs === void 0 ? configuredTimeout : Math.max(0, Math.min(configuredTimeout, Math.floor(deadlineMonotonicMs - performance.now())));
  const boundedGit = (args) => {
    const timeout = remaining();
    return timeout > 0 ? git(repoPath, args, 4 * 1024 * 1024, timeout) : { ok: false, stdout: "" };
  };
  const headResult = boundedGit(["rev-parse", "--verify", "HEAD"]);
  const statusResult = boundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const reasons = [];
  if (deadlineMonotonicMs !== void 0 && remaining() === 0) reasons.push("hook-deadline-exhausted");
  if (!headResult.ok) reasons.push("missing-committed-head");
  if (!statusResult.ok) reasons.push("git-status-failed");
  const trackedPathDigests = {};
  if (config) {
    const trackedResult = boundedGit(["ls-files", "-z"]);
    if (!trackedResult.ok) reasons.push("git-tracked-files-failed");
    else {
      const candidates = trackedResult.stdout.split("\0").filter(Boolean).filter((path) => config.policy.documentation_globs.some((glob) => matchesSimpleGlob(path, glob))).filter((path) => !config.policy.excluded_globs?.some((glob) => matchesSimpleGlob(path, glob))).sort((a, b) => a.localeCompare(b, "en"));
      if (candidates.length > config.limits.list_max_items) reasons.push("tracked-document-limit");
      for (const path of candidates.slice(0, config.limits.list_max_items)) {
        if (deadlineMonotonicMs !== void 0 && remaining() === 0) {
          reasons.push("hook-deadline-exhausted");
          break;
        }
        if (looksGenerated(path)) continue;
        const file = readSafeEvidenceText(repoPath, path, config.limits.source_file_max_bytes);
        if (file.status !== "present") continue;
        trackedPathDigests[path] = file.content_sha256;
      }
    }
  }
  return {
    head: headResult.ok ? headResult.stdout.trim() : null,
    status_digest: statusResult.ok ? sha256Hex(statusResult.stdout) : null,
    dirty_paths: statusResult.ok ? [...new Set(statusPaths(statusResult.stdout))].sort() : [],
    tracked_path_digests: trackedPathDigests,
    complete: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}
function validateCommittedGitRef(repoPath, gitRef) {
  if (!gitRef || gitRef.length > 256 || gitRef.startsWith("-")) return false;
  return git(repoPath, ["rev-parse", "--verify", `${gitRef}^{commit}`], 64 * 1024).ok;
}
function safeRelative(repoPath, relativePath) {
  if (!relativePath || relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.split(/[\\/]/u).includes("..")) return null;
  const root = realpathSync5(repoPath);
  const candidate = resolve9(root, relativePath);
  const rel = relative8(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep4}`) || rel.startsWith(sep4)) return null;
  return { root, candidate };
}
function hasSymlinkComponent(root, candidate) {
  const rel = relative8(root, candidate);
  let cursor = root;
  for (const part of rel.split(sep4).filter(Boolean)) {
    cursor = join17(cursor, part);
    try {
      if (lstatSync8(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function readSafeEvidenceText(repoPath, relativePath, maxBytes) {
  const safe = safeRelative(repoPath, relativePath);
  if (!safe || hasSymlinkComponent(safe.root, safe.candidate)) return { status: "excluded", reason: "unsafe-path" };
  let fd;
  try {
    fd = openSync5(safe.candidate, constants4.O_RDONLY | (constants4.O_NOFOLLOW ?? 0));
  } catch {
    return { status: "excluded", reason: "not-regular" };
  }
  try {
    const before = fstatSync3(fd);
    if (!before.isFile()) return { status: "excluded", reason: "not-regular" };
    if (before.size > maxBytes) return { status: "excluded", reason: "oversize" };
    let physical;
    try {
      physical = realpathSync5(`/proc/self/fd/${fd}`);
    } catch {
      return { status: "excluded", reason: "unsafe-path" };
    }
    const physicalRel = relative8(safe.root, physical);
    if (physicalRel === ".." || physicalRel.startsWith(`..${sep4}`) || physicalRel.startsWith(sep4)) return { status: "excluded", reason: "unsafe-path" };
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
      const count = readSync2(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) return { status: "excluded", reason: "oversize" };
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync3(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || total !== before.size) return { status: "excluded", reason: "changed-during-read" };
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) return { status: "excluded", reason: "binary" };
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { status: "excluded", reason: "binary" };
    }
    if (looksSecret(relativePath, content)) return { status: "excluded", reason: "secret-like" };
    return { status: "present", content, content_sha256: sha256Hex(bytes), bytes: total };
  } finally {
    closeSync5(fd);
  }
}
function looksGenerated(path) {
  return /(^|\/)(dist|build|coverage|node_modules|vendor|\.next|_site)(\/|$)/u.test(path) || /(?:\.min\.|\.generated\.|-lock\.)/u.test(path);
}
function looksSecret(path, content) {
  if (/(^|\/)(\.env(?:\.|$)|id_(?:rsa|ed25519)$)|(?:secret|credential|private[-_]?key)/iu.test(path)) return true;
  return /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|password|token)\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{16,})/iu.test(content);
}
function matchesSimpleGlob(path, glob) {
  if (glob === "**/*.md") return path.toLowerCase().endsWith(".md");
  if (glob === "**/*.mdx") return path.toLowerCase().endsWith(".mdx");
  if (glob.startsWith("**/*.")) return extname(path).toLowerCase() === `.${glob.slice(5).toLowerCase()}`;
  return path === glob;
}
function addExclusion(record, reason) {
  record[reason] = (record[reason] ?? 0) + 1;
}
function selectEligibleDocuments(config, baseline, manualBaselineRef) {
  const repo = config.repo_path;
  const startRef = manualBaselineRef ?? baseline.git_head;
  if (!startRef || !validateCommittedGitRef(repo, startRef)) throw new NotebookError("INVALID_INPUT", "Capture baseline is not a committed Git reference");
  const end = captureGitSnapshot(repo);
  if (!end.head) throw new NotebookError("CONFLICT", "Repository has no committed end revision");
  const committed = git(repo, ["diff", "--name-only", "-z", `${startRef}..${end.head}`], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  const working = git(repo, ["diff", "--name-only", "-z", "HEAD"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  const staged = git(repo, ["diff", "--cached", "--name-only", "-z"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  if (!committed.ok || !working.ok || !staged.ok) throw new NotebookError("INTERNAL_ERROR", "Git evidence selection failed");
  const uncommitted = new Set([...working.stdout.split("\0"), ...staged.stdout.split("\0")].filter(Boolean));
  const allChanged = [...new Set([...committed.stdout.split("\0"), ...uncommitted].filter(Boolean))].sort();
  const changed = allChanged.slice(0, config.limits.list_max_items);
  const trackedResult = git(repo, ["ls-files", "-z"], 4 * 1024 * 1024, config.limits.overall_timeout_ms);
  if (!trackedResult.ok) throw new NotebookError("INTERNAL_ERROR", "Git tracked-file enumeration failed");
  const tracked = new Set(trackedResult.stdout.split("\0").filter(Boolean));
  const preDirty = new Set(baseline.pre_dirty_paths);
  const exclusions = {};
  const documents = [];
  if (allChanged.length > changed.length) addExclusion(exclusions, "changed-path-limit");
  for (const path of changed) {
    if (manualBaselineRef && uncommitted.has(path)) {
      addExclusion(exclusions, "manual-baseline-uncommitted");
      continue;
    }
    if (!tracked.has(path)) {
      addExclusion(exclusions, "untracked");
      continue;
    }
    if (!config.policy.documentation_globs.some((glob) => matchesSimpleGlob(path, glob))) {
      addExclusion(exclusions, "policy");
      continue;
    }
    if (config.policy.excluded_globs?.some((glob) => matchesSimpleGlob(path, glob))) {
      addExclusion(exclusions, "excluded");
      continue;
    }
    if (looksGenerated(path)) {
      addExclusion(exclusions, "generated");
      continue;
    }
    const file = readSafeEvidenceText(repo, path, config.limits.source_file_max_bytes);
    if (file.status !== "present") {
      addExclusion(exclusions, file.reason);
      continue;
    }
    const startDigest = baseline.tracked_path_digests[path];
    if (preDirty.has(path) && (!startDigest || startDigest === file.content_sha256)) {
      addExclusion(exclusions, startDigest ? "pre-existing-dirty-unchanged" : "pre-existing-dirty-unknown");
      continue;
    }
    documents.push({ path, source_revision: end.head, content_sha256: file.content_sha256, ...startDigest ? { start_content_sha256: startDigest } : {}, content: file.content });
  }
  return {
    documents,
    changed_paths: changed,
    exclusions,
    end_revision: end.head,
    end_status_digest: end.status_digest
  };
}
var init_git_evidence = __esm({
  "src/notebook/git-evidence.ts"() {
    "use strict";
    init_notes();
    init_types();
  }
});

// src/notebook/remote-mutation-journal.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { join as join18 } from "node:path";
function journalPath(root, projectSlug, operationId) {
  if (!/^[a-f0-9-]{16,64}$/iu.test(operationId)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation operation ID");
  return join18(ensureNotebookState(root, projectSlug).journals, `${operationId}.json`);
}
function remoteMutationJournalPath(root, projectSlug, operationId) {
  return journalPath(root, projectSlug, operationId);
}
function mutationInputDigest(value) {
  return sha256Hex(`pjangler-remote-mutation-v1\0${canonicalJson(value)}`);
}
function assertBoundedJournalText(value, label) {
  if (!value || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NotebookError("INVALID_INPUT", `Invalid remote mutation ${label}`);
  }
}
function listRemoteMutationJournals(root, projectSlug) {
  const paths = ensureNotebookState(root, projectSlug);
  const journals = [];
  for (const entry of readNotebookStateDirectory(paths.journals, paths.root)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9-]{16,64}\.json$/iu.test(entry.name)) {
      throw new NotebookError("CONFLICT", `Remote mutation journal state-integrity finding: journals/${entry.name}`);
    }
    const read = readNotebookStateJson(join18(paths.journals, entry.name), paths.root, 65536);
    const journal = read.value === void 0 ? null : parseRemoteMutationJournal(read.value);
    if (!journal || `${journal.operation_id}.json` !== entry.name) {
      throw new NotebookError("CONFLICT", `Remote mutation journal state-integrity finding: journals/${entry.name}`);
    }
    journals.push(journal);
  }
  return journals.sort((a, b) => a.prepared_at.localeCompare(b.prepared_at) || a.operation_id.localeCompare(b.operation_id));
}
function findActiveRemoteMutation(root, projectSlug, kind, inputDigest) {
  return listRemoteMutationJournals(root, projectSlug).find((item) => item.kind === kind && item.input_digest === inputDigest && item.state !== "committed");
}
function prepareRemoteMutation(input) {
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation input digest");
  if (input.dispatchDigest !== void 0 && !/^[a-f0-9]{64}$/u.test(input.dispatchDigest)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation dispatch digest");
  if (input.sessionKey && !/^[a-f0-9]{64}$/u.test(input.sessionKey)) throw new NotebookError("INVALID_INPUT", "Invalid remote mutation session key");
  assertBoundedJournalText(input.logicalMarker, "logical marker");
  if (input.bindingId !== void 0) assertBoundedJournalText(input.bindingId, "binding ID");
  return withNotebookStateLock(input.root, input.projectSlug, 1e3, (paths) => {
    const active = listRemoteMutationJournals(input.root, input.projectSlug).find((item) => item.kind === input.kind && item.state !== "committed" && (item.input_digest === input.inputDigest || item.logical_marker === input.logicalMarker));
    if (active) {
      if (active.state !== "prepared") return active;
      if (active.input_digest === input.inputDigest && active.dispatch_digest === input.dispatchDigest) return active;
      const requested = (input.now ?? /* @__PURE__ */ new Date()).getTime();
      const previous = Date.parse(active.updated_at);
      const { dispatch_digest: _dispatchDigest, ...activeWithoutDispatchDigest } = active;
      const updated = {
        ...activeWithoutDispatchDigest,
        input_digest: input.inputDigest,
        ...input.dispatchDigest ? { dispatch_digest: input.dispatchDigest } : {},
        ...input.bindingId ? { binding_id: input.bindingId } : {},
        ...input.sessionKey ? { session_key: input.sessionKey } : {},
        updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
        diagnostic: "prepared input superseded before dispatch"
      };
      atomicWriteJson(journalPath(input.root, input.projectSlug, active.operation_id), updated, paths.root);
      return updated;
    }
    const now = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
    const journal = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      operation_id: input.operationId ?? randomUUID4(),
      project_slug: input.projectSlug,
      kind: input.kind,
      logical_marker: input.logicalMarker,
      input_digest: input.inputDigest,
      ...input.dispatchDigest ? { dispatch_digest: input.dispatchDigest } : {},
      ...input.bindingId ? { binding_id: input.bindingId } : {},
      ...input.sessionKey ? { session_key: input.sessionKey } : {},
      state: "prepared",
      prepared_at: now,
      updated_at: now,
      candidate_ids: [],
      diagnostic: null,
      result_category: "prepared",
      next_action: remoteMutationNextAction("prepared", 0)
    };
    if (!createNotebookStateJsonExclusive(journalPath(input.root, input.projectSlug, journal.operation_id), journal, paths.root)) {
      throw new NotebookError("CONFLICT", "Concurrent remote mutation journal reservation collided");
    }
    return journal;
  });
}
function transitionRemoteMutation(input) {
  return withNotebookStateLock(input.root, input.journal.project_slug, 1e3, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65536);
    const current = read.value === void 0 ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale transition rejected");
    }
    const allowed = {
      prepared: /* @__PURE__ */ new Set(["possibly-dispatched", "reconciled"]),
      "possibly-dispatched": /* @__PURE__ */ new Set(["reconciled"]),
      reconciled: /* @__PURE__ */ new Set(["committed"]),
      committed: /* @__PURE__ */ new Set()
    };
    if (!allowed[current.state].has(input.state)) throw new NotebookError("CONFLICT", "Remote mutation journal transition is not allowed by the v1 state machine");
    const candidates = [...new Set(input.candidateIds ?? current.candidate_ids)];
    if (candidates.length > 20 || candidates.some((item) => typeof item !== "string" || !item || Buffer.byteLength(item, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(item))) {
      throw new NotebookError("INVALID_INPUT", "Remote mutation candidates exceed the bounded v1 schema");
    }
    if (input.state === "possibly-dispatched" && candidates.length !== 0) throw new NotebookError("CONFLICT", "Possibly-dispatched journal cannot claim candidates before reconciliation");
    if (input.state === "committed" && candidates.length !== 1) throw new NotebookError("CONFLICT", "Committed journal requires exactly one reconciled candidate");
    if (input.diagnostic !== void 0 && input.diagnostic !== null && (Buffer.byteLength(input.diagnostic, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(input.diagnostic))) {
      throw new NotebookError("INVALID_INPUT", "Remote mutation diagnostic exceeds the bounded v1 schema");
    }
    const requested = (input.now ?? /* @__PURE__ */ new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const { definitive_http_status: _definitiveHttpStatus, ...currentWithoutRejection } = current;
    const next = {
      ...currentWithoutRejection,
      state: input.state,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      candidate_ids: candidates,
      diagnostic: input.state === "committed" ? null : input.diagnostic === void 0 ? current.diagnostic : input.diagnostic,
      result_category: remoteMutationResultCategory(input.state, candidates.length),
      next_action: remoteMutationNextAction(input.state, candidates.length)
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}
function markRemoteMutationDefinitivelyRejected(input) {
  return withNotebookStateLock(input.root, input.journal.project_slug, 1e3, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65536);
    const current = read.value === void 0 ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at || current.input_digest !== input.journal.input_digest || current.dispatch_digest !== input.journal.dispatch_digest || current.diagnostic !== input.journal.diagnostic || current.definitive_http_status !== input.journal.definitive_http_status || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale definitive rejection rejected");
    }
    if (current.state !== "possibly-dispatched" || current.candidate_ids.length !== 0) {
      throw new NotebookError("CONFLICT", "Only an unresolved dispatched mutation can record a definitive HTTP rejection");
    }
    const requested = (input.now ?? /* @__PURE__ */ new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const next = {
      ...current,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      diagnostic: `Open Notebook definitively rejected HTTP ${input.status}`,
      definitive_http_status: input.status,
      result_category: remoteMutationResultCategory(current.state, 0, input.status),
      next_action: remoteMutationNextAction(current.state, 0, input.status)
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}
function rearmRemoteMutationAfterDefinitiveRejection(input) {
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid corrected remote mutation input digest");
  if (!/^[a-f0-9]{64}$/u.test(input.dispatchDigest)) throw new NotebookError("INVALID_INPUT", "Invalid corrected remote mutation dispatch digest");
  if (input.legacyV114InputDigest !== void 0 && !/^[a-f0-9]{64}$/u.test(input.legacyV114InputDigest)) throw new NotebookError("INVALID_INPUT", "Invalid legacy v1.14 remote mutation input digest");
  if (input.observedCandidateIds.length !== 0) throw new NotebookError("CONFLICT", "A remote mutation with candidates cannot be rearmed");
  return withNotebookStateLock(input.root, input.journal.project_slug, 1e3, (paths) => {
    const path = journalPath(input.root, input.journal.project_slug, input.journal.operation_id);
    const read = readNotebookStateJson(path, paths.root, 65536);
    const current = read.value === void 0 ? null : parseRemoteMutationJournal(read.value);
    if (!current) throw new NotebookError("CONFLICT", "Remote mutation journal has an integrity finding");
    if (current.state !== input.journal.state || current.updated_at !== input.journal.updated_at || current.input_digest !== input.journal.input_digest || current.dispatch_digest !== input.journal.dispatch_digest || current.diagnostic !== input.journal.diagnostic || current.definitive_http_status !== input.journal.definitive_http_status || canonicalJson(current.candidate_ids) !== canonicalJson(input.journal.candidate_ids)) {
      throw new NotebookError("CONFLICT", "Remote mutation journal changed; stale corrected-input rearm rejected");
    }
    if (current.kind !== "note.create" || current.state !== "possibly-dispatched" || current.candidate_ids.length !== 0) {
      throw new NotebookError("CONFLICT", "Only a zero-candidate rejected note mutation can be rearmed");
    }
    if (current.dispatch_digest === input.dispatchDigest) {
      throw new NotebookError("CONFLICT", "Definitively rejected note transport input must change before one retry is allowed");
    }
    const explicitRejection = current.definitive_http_status === 400 || current.definitive_http_status === 422;
    const legacyV114Rejection = current.definitive_http_status === void 0 && current.diagnostic === "possibly-dispatched" && current.dispatch_digest === void 0 && input.legacyV114InputDigest !== void 0 && current.input_digest === input.legacyV114InputDigest;
    if (!explicitRejection && !legacyV114Rejection) {
      throw new NotebookError("CONFLICT", "Remote note dispatch is ambiguous; corrected input cannot be posted without a definitive rejection");
    }
    const requested = (input.now ?? /* @__PURE__ */ new Date()).getTime();
    const previous = Date.parse(current.updated_at);
    const { definitive_http_status: _definitiveHttpStatus, ...currentWithoutRejection } = current;
    const next = {
      ...currentWithoutRejection,
      state: "prepared",
      input_digest: input.inputDigest,
      dispatch_digest: input.dispatchDigest,
      updated_at: new Date(Number.isFinite(previous) && requested <= previous ? previous + 1 : requested).toISOString(),
      candidate_ids: [],
      diagnostic: legacyV114Rejection ? "corrected v1.14 note_type input rearmed after definitive legacy rejection" : "corrected input rearmed after definitive HTTP rejection",
      result_category: remoteMutationResultCategory("prepared", 0),
      next_action: remoteMutationNextAction("prepared", 0)
    };
    atomicWriteJson(path, next, paths.root);
    return next;
  });
}
function commitReconciledRemoteMutation(root, journal, now) {
  if (journal.state === "committed") return journal;
  if (journal.state !== "reconciled" || journal.candidate_ids.length !== 1) {
    throw new NotebookError("CONFLICT", "Remote mutation cannot commit before exactly one candidate and durable ownership");
  }
  return transitionRemoteMutation({ root, journal, state: "committed", now, diagnostic: null });
}
var init_remote_mutation_journal = __esm({
  "src/notebook/remote-mutation-journal.ts"() {
    "use strict";
    init_notes();
    init_remote_mutation_schema();
    init_state();
    init_types();
  }
});

// src/notebook/reconcile.ts
function sameCandidateSet(left, right) {
  const normalize = (items) => [...items].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
function recordReconciliation(input) {
  if (input.journal.state === "reconciled") {
    if (!sameCandidateSet(input.journal.candidate_ids, input.candidateIds)) {
      throw new NotebookError("CONFLICT", "Reconciled remote mutation candidate set changed; durable ownership must be repaired explicitly");
    }
    return input.journal;
  }
  if (input.candidateIds.length === 0) return input.journal;
  return transitionRemoteMutation({
    root: input.stateRoot,
    journal: input.journal,
    state: "reconciled",
    candidateIds: input.candidateIds,
    diagnostic: input.candidateIds.length > 1 ? input.duplicateDiagnostic : null
  });
}
function projectNotebookMarker(projectSlug) {
  return `pjangler.project.v1:${projectSlug}`;
}
function ambiguous(kind, ids) {
  throw new NotebookError("CONFLICT", `More than one ${kind} matches the stable PJangler marker`, false, { candidate_count: ids.length });
}
async function reconcileProjectNotebook(input) {
  const marker = projectNotebookMarker(input.projectSlug);
  const description = input.description?.trim() ? `${marker}
${input.description.trim()}` : marker;
  const digest = mutationInputDigest({ kind: "notebook.create", marker, name: input.name, description });
  let journal = prepareRemoteMutation({
    root: input.stateRoot,
    projectSlug: input.projectSlug,
    kind: "notebook.create",
    logicalMarker: marker,
    inputDigest: digest
  });
  const reconcile = async () => {
    input.beforeRemote?.();
    const candidates2 = (await input.client.listNotebooks()).filter((notebook) => notebook.description?.split(/\r?\n/u)[0] === marker);
    journal = recordReconciliation({
      stateRoot: input.stateRoot,
      journal,
      candidateIds: candidates2.map((item) => item.id),
      duplicateDiagnostic: "duplicate stable marker"
    });
    return candidates2;
  };
  let candidates = await reconcile();
  if (candidates.length > 1) ambiguous("notebook", candidates.map((item) => item.id));
  if (candidates.length === 1) {
    let candidate2 = candidates[0];
    if (candidate2.name !== input.name || candidate2.description !== description || candidate2.archived === true) {
      input.beforeRemote?.();
      candidate2 = await input.client.updateNotebook(candidate2.id, { name: input.name, description, archived: false });
      if (candidate2.name !== input.name || candidate2.description !== description || candidate2.archived === true) {
        throw new NotebookError("DRIFT_DETECTED", "Stable-marker notebook metadata could not be repaired exactly");
      }
    }
    return { notebook: candidate2, created: false, adopted: true, journal };
  }
  if (journal.state !== "prepared") {
    throw new NotebookError("CONFLICT", "Notebook create may have been dispatched; reconcile before another POST", false, { operation_id: journal.operation_id });
  }
  input.beforeRemote?.();
  await input.client.createNotebook({ name: input.name, description }, () => {
    journal = transitionRemoteMutation({ root: input.stateRoot, journal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  });
  candidates = await reconcile();
  if (candidates.length > 1) ambiguous("notebook", candidates.map((item) => item.id));
  if (candidates.length !== 1) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Created notebook could not be reconciled by its stable marker");
  const candidate = candidates[0];
  if (candidate.name !== input.name || candidate.description !== description || candidate.archived === true) {
    throw new NotebookError("DRIFT_DETECTED", "Created notebook did not satisfy the exact marker/name/archive contract");
  }
  return { notebook: candidate, created: true, adopted: false, journal };
}
async function reconcileManagedNote(input) {
  const desiredEnvelope = parseNoteEnvelope(input.content)?.envelope;
  if (!desiredEnvelope || desiredEnvelope.project_slug !== input.projectSlug || desiredEnvelope.logical_id !== input.logicalId) {
    throw new NotebookError("INVALID_INPUT", "Managed note create requires an exact owned PJangler envelope");
  }
  const noteType = normalizeOpenNotebookNoteType(input.noteType);
  const digest = input.inputDigest ?? mutationInputDigest({ kind: "note.create", notebook_id: input.notebookId, logical_id: input.logicalId, title: input.title, content: input.content });
  const dispatchDigest = mutationInputDigest({ kind: "note.create", notebook_id: input.notebookId, logical_id: input.logicalId, title: input.title, content: input.content, note_type: noteType });
  let journal = prepareRemoteMutation({
    root: input.stateRoot,
    projectSlug: input.projectSlug,
    kind: "note.create",
    logicalMarker: input.logicalId,
    inputDigest: digest,
    dispatchDigest,
    sessionKey: input.sessionKey,
    bindingId: input.notebookId,
    operationId: input.operationId
  });
  const reconcile = async () => {
    input.beforeRemote?.();
    const notes = await input.client.listNotes(input.notebookId);
    const candidates2 = notes.filter((note2) => parseNoteEnvelope(note2.content)?.envelope.logical_id === input.logicalId);
    journal = recordReconciliation({
      stateRoot: input.stateRoot,
      journal,
      candidateIds: candidates2.map((item) => item.id),
      duplicateDiagnostic: "duplicate logical id"
    });
    return candidates2;
  };
  let candidates = await reconcile();
  if (candidates.length > 1) ambiguous("note", candidates.map((item) => item.id));
  if (candidates.length === 1) {
    let candidate2 = candidates[0];
    const owned2 = parseNoteEnvelope(candidate2.content)?.envelope;
    if (!owned2 || owned2.project_slug !== input.projectSlug || owned2.kind !== desiredEnvelope.kind || owned2.logical_id !== input.logicalId) {
      throw new NotebookError("CONFLICT", "Managed logical ID is occupied by a foreign or forged note envelope");
    }
    if (candidate2.title !== input.title || candidate2.content !== input.content) {
      input.beforeRemote?.();
      candidate2 = await input.client.updateOwnedNote(input.notebookId, candidate2.id, { title: input.title, content: input.content });
      if (candidate2.title !== input.title || candidate2.content !== input.content) {
        throw new NotebookError("DRIFT_DETECTED", "Managed note metadata/content could not be repaired exactly");
      }
    }
    return { note: candidate2, created: false, adopted: true, journal };
  }
  if (journal.state !== "prepared") {
    journal = rearmRemoteMutationAfterDefinitiveRejection({
      root: input.stateRoot,
      journal,
      inputDigest: digest,
      dispatchDigest,
      observedCandidateIds: candidates.map((item) => item.id),
      ...input.noteType === void 0 && input.inputDigest === void 0 ? { legacyV114InputDigest: digest } : {}
    });
  }
  input.beforeRemote?.();
  await input.client.createNote(input.notebookId, { title: input.title, content: input.content, note_type: noteType }, () => {
    journal = transitionRemoteMutation({ root: input.stateRoot, journal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  }, (status) => {
    journal = markRemoteMutationDefinitivelyRejected({ root: input.stateRoot, journal, status });
  });
  candidates = await reconcile();
  if (candidates.length > 1) ambiguous("note", candidates.map((item) => item.id));
  if (candidates.length !== 1) throw new NotebookError("REMOTE_PROTOCOL_ERROR", "Created note could not be reconciled by its logical ID");
  const candidate = candidates[0];
  const owned = parseNoteEnvelope(candidate.content)?.envelope;
  if (!owned || owned.project_slug !== input.projectSlug || owned.kind !== desiredEnvelope.kind || owned.logical_id !== input.logicalId || candidate.title !== input.title || candidate.content !== input.content) {
    throw new NotebookError("DRIFT_DETECTED", "Created managed note failed exact ownership/content reconciliation");
  }
  return { note: candidate, created: true, adopted: false, journal };
}
var init_reconcile = __esm({
  "src/notebook/reconcile.ts"() {
    "use strict";
    init_types();
    init_notes();
    init_open_notebook_client();
    init_remote_mutation_journal();
  }
});

// src/notebook/summarizer.ts
import { spawnSync as spawnSync12 } from "node:child_process";
import { isAbsolute as isAbsolute4 } from "node:path";
function evidenceItems(evidence) {
  const items = [];
  const eligible = new Set(evidence.documents.map((item) => item.path));
  for (const [index, document] of evidence.documents.slice(0, 100).entries()) items.push({
    evidence_id: `doc-${String(index + 1).padStart(3, "0")}`,
    kind: "eligible-document",
    path: document.path,
    content: document.content,
    content_sha256: document.content_sha256,
    value: `start=${document.start_content_sha256 ?? "unknown"}; end=${document.content_sha256}; revision=${document.source_revision}`
  });
  for (const [index, path] of evidence.changedPaths.filter((item) => !eligible.has(item)).slice(0, 100).entries()) {
    items.push({ evidence_id: `path-${String(index + 1).padStart(3, "0")}`, kind: "changed-path", path });
  }
  if (evidence.baselineRef) items.push({ evidence_id: "verify-baseline", kind: "verification", value: `committed baseline ${evidence.baselineRef}` });
  if (evidence.endRevision) items.push({ evidence_id: "verify-end-revision", kind: "verification", value: `committed end revision ${evidence.endRevision}` });
  if (evidence.endStatusDigest) items.push({ evidence_id: "verify-end-status", kind: "verification", value: `bounded Git status digest ${evidence.endStatusDigest}` });
  for (const [reason, count] of Object.entries(evidence.exclusions).sort(([a], [b]) => a.localeCompare(b, "en")).slice(0, 100)) {
    items.push({ evidence_id: `unresolved-${items.filter((item) => item.kind === "unresolved").length + 1}`, kind: "unresolved", value: `${reason}: ${count}` });
  }
  return items;
}
function safeMarkdownValue(value) {
  return JSON.stringify(Array.from(value).slice(0, 512).join(""));
}
function truncateUtf82(value, maxBytes) {
  const suffix = "\n\n[Capture summary truncated by project-notebook.v1 policy]";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let used = 0;
  const result2 = [];
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > Math.max(0, maxBytes - suffixBytes)) break;
    result2.push(point);
    used += bytes;
  }
  return `${result2.join("")}${suffix}`;
}
function fallback(evidence, maxBytes) {
  const documents = evidence.documents.length ? evidence.documents.slice(0, 100).map((item) => `- ${safeMarkdownValue(item.path)} (${item.content_sha256})`).join("\n") : "- None proved.";
  const eligible = new Set(evidence.documents.map((item) => item.path));
  const other = evidence.changedPaths.filter((item) => !eligible.has(item));
  const paths = other.length ? other.slice(0, 100).map((item) => `- ${safeMarkdownValue(item)}`).join("\n") : "- None recorded.";
  const verification = [
    evidence.baselineRef ? `- Baseline commit: ${evidence.baselineRef}` : "- Baseline commit: unavailable",
    evidence.endRevision ? `- End commit: ${evidence.endRevision}` : "- End commit: unavailable",
    evidence.endStatusDigest ? `- End status digest: ${evidence.endStatusDigest}` : "- End status digest: unavailable"
  ].join("\n");
  const unresolved = Object.keys(evidence.exclusions).length ? Object.entries(evidence.exclusions).sort(([a], [b]) => a.localeCompare(b, "en")).map(([reason, count]) => `- ${reason}: ${count}`).join("\n") : "- None recorded.";
  return truncateUtf82([
    "## Changed eligible documents",
    documents,
    "",
    "## Other changed path names",
    paths,
    "",
    "## Verification evidence",
    verification,
    "",
    "## Unresolved or uncommitted work",
    unresolved,
    "",
    "## Insufficient evidence",
    "No deployment, runtime-health, or external-success conclusion is supported by this repository-only capture."
  ].join("\n"), maxBytes);
}
function words(value) {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}
function validateClaims(value, items, noteMaxBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  if (record.schema_version !== 1 || !Array.isArray(record.claims) || record.claims.length < 1 || record.claims.length > 50 || Object.keys(record).some((key) => key !== "schema_version" && key !== "claims")) return null;
  const byId = new Map(items.map((item) => [item.evidence_id, item]));
  const rendered = ["## Session outcome"];
  for (const claimValue of record.claims) {
    if (!claimValue || typeof claimValue !== "object" || Array.isArray(claimValue)) return null;
    const claim = claimValue;
    if (Object.keys(claim).some((key) => key !== "text" && key !== "evidence_ids") || typeof claim.text !== "string" || !claim.text.trim() || Buffer.byteLength(claim.text, "utf8") > 1024 || !Array.isArray(claim.evidence_ids) || claim.evidence_ids.length < 1 || claim.evidence_ids.length > 10 || claim.evidence_ids.some((id) => typeof id !== "string" || !byId.has(id))) return null;
    if (/(?:deploy(?:ed|ment)?|production|runtime healthy|shipped|released)/iu.test(claim.text)) return null;
    const claimWords = words(claim.text);
    const cited = claim.evidence_ids.map((id) => byId.get(String(id)));
    const citedWords = words(cited.map((item) => `${item.path ?? ""} ${item.value ?? ""} ${item.content ?? ""}`).join(" "));
    if (![...claimWords].some((word) => citedWords.has(word))) return null;
    rendered.push(`- ${claim.text.trim()} [${claim.evidence_ids.join(", ")}]`);
  }
  const result2 = rendered.join("\n");
  return Buffer.byteLength(result2, "utf8") <= noteMaxBytes ? result2 : null;
}
function summarizeCapture(config, evidence) {
  const fallbackSummary = fallback(evidence, config.limits.note_max_bytes);
  if (!config.summarizer) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  assertSummarizerConfig(config);
  const items = evidenceItems(evidence);
  const payload = JSON.stringify({ schema_version: 1, evidence: items });
  if (Buffer.byteLength(payload, "utf8") > config.limits.request_max_bytes) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  const result2 = spawnSync12(config.summarizer.executable, config.summarizer.args, {
    cwd: config.repo_path,
    input: Buffer.from(payload, "utf8"),
    timeout: config.limits.overall_timeout_ms,
    maxBuffer: config.limits.response_max_bytes,
    shell: false,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
  });
  if (result2.status !== 0 || result2.error || !result2.stdout || result2.stdout.length > config.limits.response_max_bytes) return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(result2.stdout);
    const summary = validateClaims(JSON.parse(decoded), items, config.limits.note_max_bytes);
    return summary ? { schema_version: 1, mode: "configured", summary } : { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  } catch {
    return { schema_version: 1, mode: "deterministic-fallback", summary: fallbackSummary };
  }
}
function assertSummarizerConfig(config) {
  if (config.summarizer && (!isAbsolute4(config.summarizer.executable) || config.summarizer.executable.includes("\0") || config.summarizer.args.length > 32 || config.summarizer.args.some((arg) => arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 1024))) {
    throw new NotebookError("NOT_CONFIGURED", "Configured Notebook summarizer command is invalid");
  }
}
var init_summarizer = __esm({
  "src/notebook/summarizer.ts"() {
    "use strict";
    init_types();
  }
});

// src/notebook/capture.ts
var capture_exports = {};
__export(capture_exports, {
  finalizeSucceededReceiptJournals: () => finalizeSucceededReceiptJournals,
  runCaptureWorker: () => runCaptureWorker,
  safeDocumentTitle: () => safeDocumentTitle
});
function safeDocumentTitle(sourcePath, maxBytes = 4096) {
  const escaped = JSON.stringify(sourcePath.normalize("NFC")).slice(1, -1);
  let used = 0;
  const points = [];
  for (const point of escaped) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > maxBytes) break;
    points.push(point);
    used += bytes;
  }
  const title = points.join("");
  if (!title || /[\u0000-\u001f\u007f]/u.test(title)) throw new NotebookError("INVALID_INPUT", "Git evidence path could not be rendered as a safe note title");
  return title;
}
function finalizeSucceededReceiptJournals(module, receipt) {
  if (receipt.state !== "succeeded") return [];
  const local = module.contextBySlug(receipt.project_slug, false);
  const bindingId2 = local.config.binding.state === "linked" ? local.config.binding.notebook_id : void 0;
  if (!bindingId2) return [];
  const ownership = new Map(receipt.note_logical_ids.map((logicalId, index) => [logicalId, receipt.remote_note_ids[index]]));
  const committed = [];
  for (const journal of listRemoteMutationJournals(module.stateRoot, receipt.project_slug)) {
    if (journal.state !== "reconciled" || journal.kind !== "note.create" || journal.session_key !== receipt.session_key || journal.binding_id !== bindingId2 || journal.candidate_ids.length !== 1 || ownership.get(journal.logical_marker) !== journal.candidate_ids[0]) continue;
    commitReconciledRemoteMutation(module.stateRoot, journal);
    committed.push(journal.operation_id);
  }
  return committed.sort();
}
function managedContent(envelope, body, maxBytes, truncate) {
  const marker = `${encodeNoteEnvelope(envelope)}
`;
  const available = maxBytes - Buffer.byteLength(marker, "utf8");
  if (available < 0) throw new NotebookError("INVALID_INPUT", "Managed note ownership envelope exceeds the configured note ceiling");
  if (Buffer.byteLength(body, "utf8") <= available) return { content: `${marker}${body}`, body };
  if (!truncate) throw new NotebookError("INVALID_INPUT", "Eligible document plus ownership envelope exceeds the configured note ceiling");
  const suffix = "\n\n[Session capture truncated by project-notebook.v1 policy]";
  const budget = Math.max(0, available - Buffer.byteLength(suffix, "utf8"));
  let used = 0;
  const points = [];
  for (const point of body) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > budget) break;
    points.push(point);
    used += bytes;
  }
  const fitted = `${points.join("")}${suffix}`;
  return { content: `${marker}${fitted}`, body: fitted };
}
function bindingId(receipt, module) {
  const ctx = module.contextBySlug(receipt.project_slug, true);
  if (!ctx.config.binding.notebook_id || ctx.config.binding.state !== "linked") throw new NotebookError("NOT_CONFIGURED", "Capture project notebook is not linked");
  return { notebookId: ctx.config.binding.notebook_id, client: ctx.client, config: ctx.config };
}
async function upsertManaged(input) {
  const created = await reconcileManagedNote({
    stateRoot: input.module.stateRoot,
    projectSlug: input.receipt.project_slug,
    notebookId: input.notebookId,
    logicalId: input.logicalId,
    title: input.title,
    content: input.content,
    client: input.client,
    sessionKey: input.receipt.session_key,
    beforeRemote: input.beforeRemote
  });
  return { note: created.note, journal: created.journal };
}
async function processClaimed(module, receipt, leaseUpdated) {
  let active = receipt;
  const linked = bindingId(active, module);
  let baseline = readSessionBaseline(module.stateRoot, active.project_slug, active.session_key, linked.config.limits);
  if ((!baseline || !baseline.complete) && active.manual_baseline_ref) {
    baseline = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      session_key: active.session_key,
      project_slug: active.project_slug,
      client: "operator-manual-baseline",
      created_at: active.created_at,
      repo_path_digest: active.repo_path_digest,
      git_head: active.manual_baseline_ref,
      git_status_digest: null,
      policy_version: NOTEBOOK_POLICY_VERSION,
      tracked_path_digests: {},
      pre_dirty_paths: [],
      complete: true,
      incomplete_reasons: ["manual-baseline-pre-dirty-unknown"]
    };
  }
  if (!baseline || !baseline.complete) {
    return transitionCaptureReceipt({
      root: module.stateRoot,
      projectSlug: receipt.project_slug,
      receiptId: active.receipt_id,
      limits: linked.config.limits,
      expected: captureReceiptVersion(active),
      state: "blocked-missing-baseline",
      errorCategory: "CONFLICT",
      retryable: false,
      diagnostic: "A complete SessionStart baseline is required; retry with an explicit committed --baseline GIT_REF"
    });
  }
  const renew = () => {
    active = renewCaptureReceiptLease({
      root: module.stateRoot,
      projectSlug: active.project_slug,
      receiptId: active.receipt_id,
      limits: linked.config.limits,
      expected: captureReceiptVersion(active)
    });
    leaseUpdated(active);
  };
  const evidence = selectEligibleDocuments(linked.config, baseline, active.manual_baseline_ref);
  const logicalIds = [];
  const remoteIds = [];
  const journals = [];
  for (const document of evidence.documents) {
    renew();
    const logicalId = sha256Hex(`pjangler-document-v1\0${active.project_slug}\0${document.path.normalize("NFC")}`);
    const envelope = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: active.project_slug,
      kind: "document",
      logical_id: logicalId,
      source_path: document.path,
      source_revision: document.source_revision,
      content_sha256: document.content_sha256,
      session_key: active.session_key,
      captured_at: active.created_at,
      policy_version: NOTEBOOK_POLICY_VERSION
    };
    let documentContent;
    try {
      documentContent = managedContent(envelope, document.content, linked.config.limits.note_max_bytes, false).content;
    } catch (error) {
      if (!(error instanceof NotebookError) || error.code !== "INVALID_INPUT") throw error;
      evidence.exclusions["note-envelope-oversize"] = (evidence.exclusions["note-envelope-oversize"] ?? 0) + 1;
      continue;
    }
    const upserted = await upsertManaged({
      module,
      receipt: active,
      notebookId: linked.notebookId,
      client: linked.client,
      logicalId,
      title: safeDocumentTitle(document.path),
      content: documentContent,
      beforeRemote: renew
    });
    const note2 = upserted.note;
    if (upserted.journal) journals.push(upserted.journal);
    logicalIds.push(logicalId);
    remoteIds.push(note2.id);
  }
  const summary = summarizeCapture(linked.config, {
    documents: evidence.documents,
    changedPaths: evidence.changed_paths,
    exclusions: evidence.exclusions,
    endRevision: evidence.end_revision,
    endStatusDigest: evidence.end_status_digest,
    baselineRef: baseline.git_head
  });
  let captureEnvelope = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: active.project_slug,
    kind: "session-capture",
    logical_id: active.logical_id,
    ...evidence.end_revision ? { source_revision: evidence.end_revision } : {},
    content_sha256: sha256Hex(summary.summary),
    session_key: active.session_key,
    captured_at: active.created_at,
    policy_version: NOTEBOOK_POLICY_VERSION
  };
  let fittedSummary = managedContent(captureEnvelope, summary.summary, linked.config.limits.note_max_bytes, true);
  if (fittedSummary.body !== summary.summary) {
    captureEnvelope = { ...captureEnvelope, content_sha256: sha256Hex(fittedSummary.body) };
    fittedSummary = managedContent(captureEnvelope, fittedSummary.body, linked.config.limits.note_max_bytes, true);
  }
  renew();
  const captureUpsert = await upsertManaged({
    module,
    receipt: active,
    notebookId: linked.notebookId,
    client: linked.client,
    logicalId: active.logical_id,
    title: `Session Capture ${active.created_at}`,
    content: fittedSummary.content,
    beforeRemote: renew
  });
  const captureNote = captureUpsert.note;
  if (captureUpsert.journal) journals.push(captureUpsert.journal);
  logicalIds.push(active.logical_id);
  remoteIds.push(captureNote.id);
  const completed = transitionCaptureReceipt({
    root: module.stateRoot,
    projectSlug: active.project_slug,
    receiptId: active.receipt_id,
    limits: linked.config.limits,
    expected: captureReceiptVersion(active),
    state: "succeeded",
    exclusionCounts: evidence.exclusions,
    summaryMode: summary.mode,
    noteLogicalIds: logicalIds,
    remoteNoteIds: remoteIds,
    endRevision: evidence.end_revision,
    endStatusDigest: evidence.end_status_digest
  });
  for (const journal of journals) commitReconciledRemoteMutation(module.stateRoot, journal);
  return completed;
}
async function runCaptureWorker(module, projectSlug, receiptId) {
  const local = module.contextBySlug(projectSlug, false);
  let receipt = readCaptureReceipt(module.stateRoot, projectSlug, receiptId, local.config.limits);
  if (receipt.state === "succeeded") return { receipt, processed: finalizeSucceededReceiptJournals(module, receipt).length > 0 };
  while (true) {
    receipt = claimCaptureReceipt({ root: module.stateRoot, projectSlug, receiptId, limits: local.config.limits });
    try {
      const completed = await processClaimed(module, receipt, (updated) => {
        receipt = updated;
      });
      return { receipt: completed, processed: true };
    } catch (error) {
      const normalized = normalizeNotebookError(error);
      if (receipt.attempt_origin === "operator") {
        receipt = transitionCaptureReceipt({
          root: module.stateRoot,
          projectSlug,
          receiptId,
          limits: local.config.limits,
          expected: captureReceiptVersion(receipt),
          state: "retry-exhausted",
          errorCategory: normalized.code,
          retryable: normalized.retryable,
          diagnostic: normalized.message
        });
        return { receipt, processed: true };
      }
      const budgetRemains = normalized.retryable && receipt.automatic_attempts_used < receipt.automatic_attempt_limit;
      receipt = transitionCaptureReceipt({
        root: module.stateRoot,
        projectSlug,
        receiptId,
        limits: local.config.limits,
        expected: captureReceiptVersion(receipt),
        state: budgetRemains ? "failed" : receipt.automatic_attempts_used >= receipt.automatic_attempt_limit ? "retry-exhausted" : "failed",
        errorCategory: normalized.code,
        retryable: normalized.retryable,
        diagnostic: normalized.message
      });
      if (!budgetRemains) return { receipt, processed: true };
      receipt = transitionCaptureReceipt({
        root: module.stateRoot,
        projectSlug,
        receiptId,
        limits: local.config.limits,
        expected: captureReceiptVersion(receipt),
        state: "queued",
        errorCategory: normalized.code,
        retryable: true,
        diagnostic: normalized.message
      });
    }
  }
}
var init_capture = __esm({
  "src/notebook/capture.ts"() {
    "use strict";
    init_notes();
    init_git_evidence();
    init_reconcile();
    init_remote_mutation_journal();
    init_state();
    init_summarizer();
    init_types();
    init_output();
  }
});

// src/index.ts
import { spawnSync as spawnSync15 } from "node:child_process";
import { existsSync as existsSync24, readFileSync as readFileSync20, statSync as statSync6 } from "node:fs";
import { basename as basename8, join as join29, resolve as resolve17 } from "node:path";
import { Command as Command3, CommanderError } from "commander";

// src/commands/hermes/types.ts
var HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";
var SOUL_TONES = ["direct", "playful", "formal", "terse"];
function deriveAgentId(repo, role) {
  return `${repo}-${role}`.toLowerCase();
}
function deriveProfileName(repo, role) {
  return deriveAgentId(repo, role);
}

// src/commands/hermes/EnsureTemplateConfig.ts
import { homedir, platform } from "node:os";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2, dirname as dirname2 } from "node:path";

// src/commands/Command.ts
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
var Command = class {
  context;
  constructor(context) {
    this.context = context;
  }
  /**
   * Format message with [DRY RUN] prefix if in dry-run mode
   */
  formatMessage(message) {
    return this.context.dryRun ? `[DRY RUN] ${message}` : message;
  }
  fileExists(filePath) {
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
};

// src/commands/hermes/EnsureTemplateConfig.ts
function resolveTemplateConfigPath() {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join2(homedir(), ".config");
  return join2(base, "hermes-agent-template", "config.toml");
}
function detectHermesBin(home) {
  const candidates = [
    join2(home, "code", "hermes-agent", "venv", "bin", "hermes"),
    join2(home, "code", "hermes-agent", ".venv", "bin", "hermes"),
    join2(home, ".local", "bin", "hermes")
  ];
  for (const c of candidates) {
    if (existsSync2(c)) return c;
  }
  return candidates[0];
}
function renderHostConfig() {
  const home = homedir();
  const hermesBin = detectHermesBin(home);
  const hermesRepo = join2(home, "code", "hermes-agent");
  const scaffoldDir = join2(home, "code", "hermes-agent-template", "runtime-scaffold");
  const skillsDir = join2(home, ".agents", "skills");
  const pmExternalSkillGlobalDir = join2(home, "code", "skillex", "skill-sets", "global", ".system");
  return `# hermes-agent-template \u2014 host configuration
# Bootstrapped by \`pjangler config bootstrap\` for $HOME=${home} (platform=${platform()}).
#
# [fleet] paths below were derived from THIS machine. The identity values in
# [github]/[plane]/[bloodbank] are intentionally left to be confirmed before a
# CLOUD provision (\`pjangler hermes\` without --local); they are unused by the
# default local-only provision.
#
# Resolution precedence per value: env var > ~/.hermes/fleet.env > this file > fallback.

[fleet]
home = "~/.hermes"
hermes_bin = "${hermesBin}"
hermes_repo = "${hermesRepo}"
runtime_scaffold_dir = "${scaffoldDir}"
# Shared fleet source-of-truth env file + fleet registry. ~ is expanded.
fleet_env = "~/.hermes/fleet.env"
registry_file = "~/.hermes/agents-registry.yaml"
canonical_skills_dir = "${skillsDir}"
# BMAD is NOT listed here. "bmad-method install" writes bmad-* skills into each
# project's own .agents/skills, so an agent sees the version its repo pins
# rather than one frozen fleet-wide copy. This list is for genuinely shared,
# out-of-project skill sources only.
pm_external_skill_dirs = [
  "${pmExternalSkillGlobalDir}",
]
symlinked_runtime_skills = []

[github]
# Owner of the per-agent runtime repos (creates <owner>/agent-hm-<repo>-<role>).
# REQUIRED before a cloud provision. Leave empty for local-only runs.
runtime_repo_owner = ""

[plane]
# Plane instance + workspace (one project per agent). Confirm before cloud provision.
base = "https://plane.delo.sh"
workspace = "33god"

[bloodbank]
# NATS endpoint the consumer connects to. For a remote fleet node, point this at
# the bloodbank host over Tailscale rather than localhost.
nats_host = "127.0.0.1"
nats_port = 4222
compose_dir = "~/code/33GOD/bloodbank"
`;
}
var EnsureTemplateConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.deferredExternalEffects && !ctx.applyingDeferredHostEffects) {
      return {
        success: true,
        outcome: "unchanged",
        message: "Hermes host config deferred until rendered lifecycle eligibility passes"
      };
    }
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync2(path);
    if (exists && !force) {
      if (!ctx.quiet) console.log(`\u2713 Config present: ${path}`);
      return { success: true, outcome: "unchanged", message: "" };
    }
    if (ctx.dryRun) {
      if (!ctx.quiet) console.log(`[DRY RUN] Would ${exists ? "overwrite" : "create"} config: ${path}`);
      return { success: true, outcome: "planned", filePath: path, message: "" };
    }
    try {
      mkdirSync2(dirname2(path), { recursive: true });
      writeFileSync2(path, renderHostConfig());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, outcome: "failed", message: `Failed to write ${path}: ${msg}` };
    }
    if (!ctx.quiet) {
      console.log(`\u2713 Bootstrapped config: ${path}`);
      console.log("  Review [github].runtime_repo_owner + [plane] + [bloodbank] before a cloud provision.");
    }
    return { success: true, outcome: "changed", filePath: path, message: "" };
  }
};

// src/recipes/Recipe.ts
import { homedir as homedir2 } from "node:os";
import { resolve } from "node:path";
init_style();
function commandStatus(result2, dryRun) {
  if (result2.outcome) return result2.outcome;
  if (!result2.success) return "failed";
  if (dryRun && result2.filePath) return "planned";
  return result2.filePath ? "changed" : "unchanged";
}
function mergeInitResults(recipeId, dryRun, results) {
  return {
    recipeId,
    ok: results.every((result2) => result2.ok),
    dryRun,
    changedFiles: [...new Set(results.flatMap((result2) => result2.changedFiles))].sort(),
    logs: results.flatMap((result2) => result2.logs),
    errors: results.flatMap((result2) => result2.errors),
    phases: results.flatMap((result2) => result2.phases)
  };
}
var Recipe = class {
  ingredientTypes = [];
  compatibilityContext;
  constructor(context) {
    this.compatibilityContext = context;
  }
  addIngredient(CommandClass) {
    this.ingredientTypes.push(CommandClass);
    return this;
  }
  async invokeIngredients(ctx) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    for (const CommandClass of this.ingredientTypes) {
      const command = new CommandClass(ctx);
      const result2 = await command.invoke();
      const status = commandStatus(result2, Boolean(ctx.dryRun));
      const phaseChangedFiles = status === "changed" && result2.filePath ? [resolve(ctx.targetDir, result2.filePath)] : [];
      phases.push({ id: CommandClass.name, status, changedFiles: phaseChangedFiles, message: result2.message || void 0 });
      if (result2.message) logs.push(result2.message);
      changedFiles.push(...phaseChangedFiles);
      if (status === "failed" || status === "cancelled") errors.push(result2.message || `${CommandClass.name} ${status}`);
      if (status === "failed" || status === "cancelled") break;
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
  }
  /** Initialize missing/drifted state using only this recipe's owned checks. */
  async initializeOwnedChecks(ctx) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    for (const check of this.checks) {
      const finding2 = check.audit(ctx);
      if (finding2.status === "pass" || finding2.status === "skip") {
        phases.push({ id: check.id, status: finding2.status === "skip" ? "skipped" : "unchanged", changedFiles: [], message: finding2.summary });
        continue;
      }
      if (!finding2.fixable) {
        phases.push({ id: check.id, status: "failed", changedFiles: [], message: finding2.summary });
        errors.push(`${check.id}: ${finding2.summary}`);
        break;
      }
      const migrated = await check.migrate(ctx, finding2);
      const status = migrated.status === "applied" ? ctx.dryRun ? "planned" : "changed" : migrated.status === "noop" ? "unchanged" : migrated.status === "skipped" ? "skipped" : "failed";
      const actualChanges = status === "changed" ? migrated.changedFiles : [];
      phases.push({ id: check.id, status, changedFiles: actualChanges, message: migrated.summary });
      logs.push(`${check.id}: ${migrated.summary}`);
      changedFiles.push(...actualChanges);
      if (status === "failed") {
        errors.push(`${check.id}: ${migrated.summary}`);
        break;
      }
      if (!ctx.dryRun) {
        const postcondition = check.audit(ctx);
        if (postcondition.status !== "pass" && postcondition.status !== "skip") {
          const detail = postcondition.details.length ? ` (${postcondition.details.join("; ")})` : "";
          errors.push(`${check.id}: init postcondition failed: ${postcondition.summary}${detail}`);
          phases.push({ id: `${check.id}:postcondition`, status: "failed", changedFiles: [], message: postcondition.summary });
          break;
        }
      }
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
  }
  audit(ctx) {
    return this.checks.map((check) => ({ ...check.audit(ctx), recipeId: this.metadata.id }));
  }
  migrate(ctx, ruleIds) {
    const selected = this.checks.filter((check) => ruleIds.includes(check.id));
    return selected.map((check) => ({ ...check.migrate(ctx, check.audit(ctx)), recipeId: this.metadata.id }));
  }
  /** @deprecated Compatibility alias; registry dispatch is authoritative. */
  async execute(input) {
    if (!this.compatibilityContext) throw new Error(`${this.metadata.id}.execute requires a compatibility context`);
    const targetDir = resolve(this.compatibilityContext.targetDir);
    const ctx = {
      ...this.compatibilityContext,
      targetDir,
      repoRoot: targetDir,
      pjanglerRoot: resolve(new URL("../..", import.meta.url).pathname),
      homeDir: homedir2(),
      dryRun: Boolean(this.compatibilityContext.dryRun),
      force: Boolean(this.compatibilityContext.force)
    };
    console.log("");
    console.log(`  ${cyan(bold(glyph.chevron))} ${bold(`Initializing ${this.metadata.id} subsystem`)}${ctx.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
    console.log("");
    const result2 = await this.init(ctx, input);
    for (const line of result2.logs) console.log(line.split("\n").map((part) => part ? `  ${part}` : part).join("\n"));
    for (const error of result2.errors) console.error(error);
    if (!ctx.dryRun && result2.ok) this.printNextSteps();
    if (ctx.dryRun) {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${dim("Dry-run complete \u2014 no files were modified.")}`);
      console.log(`  ${dim("Remove --dry-run to apply changes.")}`);
    }
  }
};

// src/parity/rules.ts
init_style();
import { existsSync as existsSync3, lstatSync as lstatSync2, mkdirSync as mkdirSync3, mkdtempSync, readFileSync as readFileSync2, readlinkSync, readdirSync as readdirSync2, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync as writeFileSync3, chmodSync, copyFileSync, rmSync } from "node:fs";
import { basename as basename2, dirname as dirname3, join as join4, relative as relative2, resolve as resolve3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir as homedir3 } from "node:os";
import { createHash as createHash2 } from "node:crypto";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

// src/recipes/supported-clis.ts
var SUPPORTED_CLIS = Object.freeze([
  { id: "claude", name: "Claude", bmadTool: "claude-code", projectRoot: ".claude", skillsRoot: ".claude/skills" },
  { id: "codex", name: "Codex", bmadTool: "codex", projectRoot: ".codex", skillsRoot: ".codex/skills" },
  { id: "gemini", name: "Gemini", bmadTool: "gemini", projectRoot: ".gemini", skillsRoot: ".gemini/skills" },
  { id: "copilot", name: "Copilot", bmadTool: "github-copilot", projectRoot: ".copilot", skillsRoot: ".copilot/skills" },
  { id: "opencode", name: "OpenCode", bmadTool: "opencode", projectRoot: ".opencode", skillsRoot: ".opencode/skills" },
  { id: "kimi", name: "Kimi", bmadTool: "kimi-code", projectRoot: ".kimi-code", skillsRoot: ".kimi-code/skills" }
]);
var SUPPORTED_BMAD_TOOLS = SUPPORTED_CLIS.map((cli) => cli.bmadTool);
var SUPPORTED_CLI_ROOTS = SUPPORTED_CLIS.map((cli) => cli.projectRoot);

// src/parity/pack.ts
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join as join3, relative, resolve as resolve2, sep } from "node:path";
var PackUnavailableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PackUnavailableError";
  }
};
var CANONICAL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
function readRegularFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Pack entry is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function hashRegularFile(path) {
  return sha256(readRegularFile(path));
}
function isRegularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function assertRealDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PackUnavailableError(`${label} is not present: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return path;
}
function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const part of relativePath.split("/")) {
    if (!part) continue;
    current = join3(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new PackUnavailableError(`Pack path is not present: ${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked pack path component: ${current}`);
  }
  return current;
}
function validatePathComponent(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || basename(value) !== value) {
    throw new Error(`${label} must be one path component: ${JSON.stringify(value)}`);
  }
  return value;
}
function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\\") || value.startsWith("/")) throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}
function optionalStringArray(value, label) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of skill names`);
  return value.map((item) => validatePathComponent(item, `${label} entry`));
}
function optionalBoolean(value, label) {
  if (value === void 0 || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function normalizePackEntry(raw) {
  let source;
  if (typeof raw === "string") {
    const trimmed2 = raw.trim();
    const at = trimmed2.indexOf("@");
    source = at >= 0 ? { name: trimmed2.slice(0, at), version: trimmed2.slice(at + 1) } : { name: trimmed2 };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    source = raw;
  } else {
    throw new Error(`Pack entry must be a string or object: ${JSON.stringify(raw)}`);
  }
  const name = validatePathComponent(source.name, "Pack name");
  const entry = {
    name,
    optional: optionalBoolean(source.optional, `Pack ${name} optional`),
    sealed: optionalBoolean(source.sealed, `Pack ${name} sealed`),
    flatten: optionalBoolean(source.flatten, `Pack ${name} flatten`)
  };
  if (source.version !== void 0 && source.version !== null) {
    entry.version = validatePathComponent(source.version, `Pack ${name} version`);
  }
  if (source.source !== void 0 && source.source !== null) {
    if (typeof source.source !== "string") throw new Error(`Pack ${name} source must be a string`);
    entry.source = source.source;
  }
  if (source.registry !== void 0 && source.registry !== null) {
    if (typeof source.registry !== "string") throw new Error(`Pack ${name} registry must be a string`);
    entry.registry = source.registry;
  }
  if (source.registry_path !== void 0 && source.registry_path !== null) {
    entry.registryPath = safeRelativePath(source.registry_path, `pack ${name} registry_path`);
  }
  if (entry.source && entry.registryPath) {
    throw new Error(`Pack ${name} may not set both \`source\` and \`registry_path\``);
  }
  entry.include = optionalStringArray(source.include, `Pack ${name} include`);
  entry.exclude = optionalStringArray(source.exclude, `Pack ${name} exclude`);
  return entry;
}
function versionSegments(text3) {
  return text3.split(/[._]/).filter(Boolean).map((chunk) => /^\d+$/.test(chunk) ? [0, Number.parseInt(chunk, 10), ""] : [1, 0, chunk]);
}
function compareSegments(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left) return -1;
    if (!right) return 1;
    if (left[0] !== right[0]) return left[0] - right[0];
    if (left[1] !== right[1]) return left[1] - right[1];
    if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1;
  }
  return 0;
}
function compareVersions(a, b) {
  const splitAt = (value) => {
    const index = value.indexOf("-");
    return index < 0 ? [value, "", false] : [value.slice(0, index), value.slice(index + 1), true];
  };
  const [aRelease, aPre, aHasPre] = splitAt(a);
  const [bRelease, bPre, bHasPre] = splitAt(b);
  const release = compareSegments(versionSegments(aRelease), versionSegments(bRelease));
  if (release !== 0) return release;
  const aRank = aHasPre ? 0 : 1;
  const bRank = bHasPre ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  return compareSegments(versionSegments(aPre), versionSegments(bPre));
}
function selectPackVersion(packDir) {
  const versions = [];
  for (const name of readdirSync(packDir).sort()) {
    if (name.startsWith(".")) continue;
    const stat = lstatSync(join3(packDir, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (isRegularFile(join3(packDir, name, "SKILL.md"))) return null;
    versions.push(name);
  }
  if (!versions.length) return null;
  return versions.reduce((best, candidate) => compareVersions(candidate, best) > 0 ? candidate : best);
}
function stripTomlComment(line) {
  let out = "";
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        out += ch + (line[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}
function bracketDepth(text3) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text3.length; index += 1) {
    const ch = text3[index];
    if (quote) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  return depth;
}
function unescapeBasicString(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape) => {
    if (escape.startsWith("u")) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n":
        return "\n";
      case "t":
        return "	";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return escape;
    }
  });
}
function parseTomlStringArray(body, label) {
  const items = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let remainder = "";
  let cursor = 0;
  let match;
  while (match = pattern.exec(body)) {
    remainder += body.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    items.push(match[1] !== void 0 ? unescapeBasicString(match[1]) : match[2]);
  }
  remainder += body.slice(cursor);
  if (/[^\s[\],]/.test(remainder)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return items;
}
function parseTomlScalar(raw) {
  const value = raw.trim();
  if (!value) return void 0;
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/);
    return match ? unescapeBasicString(match[1]) : void 0;
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match ? match[1] : void 0;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?[0-9][0-9_]*$/.test(value)) return Number.parseInt(value.replace(/_/g, ""), 10);
  return void 0;
}
function parseTomlTables(content) {
  const tables = /* @__PURE__ */ new Map();
  const tableFor = (name) => {
    let table = tables.get(name);
    if (!table) {
      table = /* @__PURE__ */ new Map();
      tables.set(name, table);
    }
    return table;
  };
  let current = tableFor("");
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^[\]]+?)\s*\]\]?$/);
    if (header) {
      current = tableFor(header[1]);
      continue;
    }
    const assignment = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    let key = assignment[1];
    if (key.startsWith('"')) key = unescapeBasicString(key.slice(1, -1));
    else if (key.startsWith("'")) key = key.slice(1, -1);
    const raw = assignment[2];
    const multiline = raw.match(/^("""|''')/);
    if (multiline) {
      const delimiter3 = multiline[1];
      if (raw.slice(3).includes(delimiter3)) continue;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index].includes(delimiter3)) break;
      }
      continue;
    }
    if (raw.startsWith("[")) {
      let body = raw;
      let depth = bracketDepth(raw);
      let cursor = index;
      while (depth > 0 && cursor + 1 < lines.length) {
        cursor += 1;
        const chunk = stripTomlComment(lines[cursor]);
        body += `
${chunk}`;
        depth += bracketDepth(chunk);
      }
      if (depth > 0) throw new Error(`Unterminated TOML array for key ${JSON.stringify(key)}`);
      index = cursor;
      current.set(key, parseTomlStringArray(body, `${JSON.stringify(key)}`));
      continue;
    }
    const scalar = parseTomlScalar(raw);
    current.set(key, scalar ?? null);
  }
  return tables;
}
function readPackMetadata(root) {
  const path = join3(root, "pack.toml");
  const stat = (() => {
    try {
      return lstatSync(path);
    } catch {
      return void 0;
    }
  })();
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Pack metadata is not a regular file: ${path}`);
  let tables;
  try {
    tables = parseTomlTables(readRegularFile(path).toString("utf8"));
  } catch (error) {
    throw new Error(`Pack metadata at ${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pack = tables.get("pack");
  const freeform = tables.get("freeform");
  const policy = tables.get("policy");
  const sourceTable = tables.get("source");
  const declared = freeform?.get("skills");
  if (declared !== void 0 && !Array.isArray(declared)) {
    throw new Error(`Pack metadata at ${path} [freeform].skills must be an array of strings`);
  }
  const payloadFiles = sourceTable?.get("payload_files");
  const name = pack?.get("name");
  const version = pack?.get("version");
  return {
    name: typeof name === "string" ? name : void 0,
    version: typeof version === "string" ? version : void 0,
    skills: Array.isArray(declared) ? [...declared] : [],
    // `immutable = true` alone deliberately does NOT imply sealed.
    sealed: policy?.get("sealed") === true,
    flatten: policy?.get("flatten") === true,
    payloadFiles: typeof payloadFiles === "number" ? payloadFiles : void 0
  };
}
function packFlattenEnabled(metadata, entry) {
  return entry.flatten === true || metadata?.flatten === true;
}
function packContainerLeaves(containerDir) {
  const leaves = [];
  const symlinked = [];
  const visit = (directory, prefix) => {
    let children;
    try {
      children = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const child of children) {
      if (child.startsWith(".") || child.startsWith("_")) continue;
      const childPath = join3(directory, child);
      const relativePath = prefix ? `${prefix}/${child}` : child;
      let stat;
      try {
        stat = lstatSync(childPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        symlinked.push(relativePath);
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (isRegularFile(join3(childPath, "SKILL.md"))) {
        leaves.push(relativePath);
        continue;
      }
      visit(childPath, relativePath);
    }
  };
  visit(containerDir, "");
  return { leaves, symlinked };
}
function hasFlattenableChildren(directory) {
  return packContainerLeaves(directory).leaves.length > 0;
}
function expandPackInventory(root, declared, entry, flatten) {
  if (!flatten) {
    return {
      inventory: declared.map((name) => ({ name, path: name, declaredEntry: name })),
      warnings: []
    };
  }
  const inventory = [];
  const warnings = [];
  const origin = /* @__PURE__ */ new Map();
  const claim = (member, declaredAsIs = false) => {
    if (!declaredAsIs && !CANONICAL_NAME_PATTERN.test(member.name)) {
      warnings.push(
        `Pack ${entry.name} leaf ${JSON.stringify(member.name)} at ${member.path} is not a canonical skill name (${CANONICAL_NAME_PATTERN.source}); skipping`
      );
      return false;
    }
    validatePathComponent(member.name, `Pack ${entry.name} skill name`);
    const previous = origin.get(member.name);
    if (previous !== void 0) {
      throw new Error(
        `Pack ${entry.name} flattens to a duplicate skill name ${JSON.stringify(member.name)}: ${join3(root, previous)} and ${join3(root, member.path)}`
      );
    }
    origin.set(member.name, member.path);
    inventory.push(member);
    return true;
  };
  for (const declaredEntry of declared) {
    const declaredDir = join3(root, declaredEntry);
    assertRealDirectory(declaredDir, `Pack skill ${declaredEntry}`);
    if (isRegularFile(join3(declaredDir, "SKILL.md"))) {
      claim({ name: declaredEntry, path: declaredEntry, declaredEntry }, true);
      continue;
    }
    const { leaves, symlinked } = packContainerLeaves(declaredDir);
    for (const child of symlinked) {
      warnings.push(`Pack ${entry.name} member ${declaredEntry}/${child} is a symlink; skipping`);
    }
    let contributed = 0;
    for (const leafPath of leaves) {
      if (claim({ name: basename(leafPath), path: `${declaredEntry}/${leafPath}`, declaredEntry })) {
        contributed += 1;
      }
    }
    if (contributed === 0) {
      warnings.push(
        `Pack ${entry.name} declared entry ${JSON.stringify(declaredEntry)} is a container that contributes no skills`
      );
    }
  }
  return { inventory, warnings };
}
function packDeclaredSkills(root, metadata, entry, flatten = false) {
  if (metadata) {
    if (metadata.name !== entry.name) {
      throw new Error(`Pack ${entry.name} pack.toml declares name ${JSON.stringify(metadata.name ?? null)}`);
    }
    if (entry.version && metadata.version !== entry.version) {
      throw new Error(
        `Pack ${entry.name} pack.toml declares version ${JSON.stringify(metadata.version ?? null)}, manifest pins ${JSON.stringify(entry.version)}`
      );
    }
    const declared2 = metadata.skills.map((name) => validatePathComponent(name, `Pack ${entry.name} skill name`));
    if (new Set(declared2).size !== declared2.length) {
      throw new Error(`Pack ${entry.name} pack.toml declares duplicate skills`);
    }
    return declared2;
  }
  const declared = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const stat = lstatSync(join3(root, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!isRegularFile(join3(root, name, "SKILL.md"))) {
      if (!flatten || !hasFlattenableChildren(join3(root, name))) continue;
    }
    declared.push(validatePathComponent(name, `Pack ${entry.name} skill name`));
  }
  return declared;
}
function walkPackSubtree(root, relativeRoot, files, directories) {
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join3(directory, name);
      const key = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Pack payload may not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        directories.add(key);
        visit(path);
      } else if (stat.isFile()) {
        files.set(key, hashRegularFile(path));
      } else {
        throw new Error(`Pack payload may contain only regular files and directories: ${path}`);
      }
    }
  };
  directories.add(relativeRoot);
  visit(join3(root, relativeRoot));
}
function packPayload(root, metadata, declared, flatten = false) {
  const files = /* @__PURE__ */ new Map();
  const directories = /* @__PURE__ */ new Set();
  if (metadata) files.set("pack.toml", hashRegularFile(join3(root, "pack.toml")));
  for (const name of declared) {
    const skillDir = join3(root, name);
    assertRealDirectory(skillDir, `Pack skill ${name}`);
    if (!flatten && !isRegularFile(join3(skillDir, "SKILL.md"))) {
      throw new PackUnavailableError(`Pack skill ${name} is missing a regular SKILL.md: ${skillDir}`);
    }
    walkPackSubtree(root, name, files, directories);
  }
  return { files, directories };
}
function parsePackChecksums(root) {
  const raw = readRegularFile(join3(root, "SHA256SUMS")).toString("utf8");
  const expected = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS entry in ${root}: ${line}`);
    const path = safeRelativePath(match[2], "checksum path");
    if (expected.has(path)) throw new Error(`Duplicate SHA256SUMS entry in ${root}: ${path}`);
    expected.set(path, match[1]);
  }
  return expected;
}
function verifySealedPack(root, files, directories) {
  const expected = parsePackChecksums(root);
  const missing = [...files.keys()].filter((path) => !expected.has(path)).sort();
  if (missing.length) {
    throw new Error(`Pack payload at ${root} is not covered by SHA256SUMS: ${JSON.stringify(missing.slice(0, 5))}`);
  }
  for (const [path, digest] of files) {
    if (expected.get(path) !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }
  for (const path of [...expected.keys()].sort()) {
    if (files.has(path)) continue;
    const digest = expected.get(path);
    let actual;
    try {
      assertNoSymlinkComponents(root, path);
      actual = hashRegularFile(join3(root, path));
    } catch (error) {
      if (error instanceof PackUnavailableError) {
        throw new Error(`SHA256SUMS at ${root} references a missing path: ${path}`);
      }
      throw error;
    }
    if (actual !== digest) throw new Error(`Pack digest mismatch at ${root}: ${path}`);
  }
  const covered = /* @__PURE__ */ new Set();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) covered.add(parts.slice(0, index).join("/"));
  }
  const unauthenticated = [...directories].filter((directory) => !covered.has(directory)).sort();
  if (unauthenticated.length) {
    throw new Error(
      `Pack at ${root} contains unauthenticated empty directories: ${JSON.stringify(unauthenticated.slice(0, 5))}`
    );
  }
}
function validatePack(packRoot, entry) {
  const root = resolve2(packRoot);
  assertRealDirectory(root, `Pack ${entry.name} root`);
  const metadata = readPackMetadata(root);
  const flatten = packFlattenEnabled(metadata, entry);
  const declared = packDeclaredSkills(root, metadata, entry, flatten);
  const sealed = entry.sealed === true || metadata?.sealed === true;
  const { files, directories } = packPayload(root, metadata, declared, flatten);
  if (metadata?.payloadFiles !== void 0) {
    const actual = [...files.keys()].filter((path) => path !== "pack.toml").length;
    if (actual !== metadata.payloadFiles) {
      throw new Error(`Pack at ${root} declares ${metadata.payloadFiles} payload files but has ${actual}`);
    }
  }
  if (sealed) {
    if (!isRegularFile(join3(root, "SHA256SUMS"))) throw new Error(`Sealed pack at ${root} has no regular SHA256SUMS`);
    verifySealedPack(root, files, directories);
  }
  const { inventory, warnings } = expandPackInventory(root, declared, entry, flatten);
  let members = inventory;
  if (entry.include) {
    const wanted = new Set(entry.include);
    members = members.filter((member) => wanted.has(member.name));
  }
  if (entry.exclude?.length) {
    const unwanted = new Set(entry.exclude);
    members = members.filter((member) => !unwanted.has(member.name));
  }
  const memberPaths = /* @__PURE__ */ new Map();
  for (const member of members) {
    memberPaths.set(member.name, join3(root, ...member.path.split("/")));
  }
  return {
    name: entry.name,
    version: entry.version,
    root,
    declared,
    inventory,
    inventoryNames: inventory.map((member) => member.name),
    members: members.map((member) => member.name),
    memberPaths,
    flatten,
    warnings,
    sealed,
    payloadFiles: [...files.keys()].filter((path) => path !== "pack.toml").length
  };
}

// src/parity/rules.ts
var LINK_AGENTFILES_SCRIPT = "'{{config_root}}/.mise/scripts/link-agentfiles.sh' '{{config_root}}'";
var MATERIALIZE_ENV_SCRIPT_REL = ".mise/scripts/materialize-env.sh";
var OP_INJECT_SCRIPT = `'{{config_root}}/${MATERIALIZE_ENV_SCRIPT_REL}'`;
var PROVISION_PACKS_SCRIPT_REL = ".mise/scripts/provision-packs.py";
var LEGACY_PROVISION_SCRIPT_REL = ".mise/scripts/provision-bmad-skills.py";
var SYNC_SKILLS_SCRIPT_REL = ".mise/scripts/sync-skills.py";
var LINK_AGENTFILES_TASK = "link:agentfiles";
var SKILLS_SYNC_TASK = "skills:sync";
var PROVISION_PACKS_TASK = "skills:provision:packs";
var LEGACY_PROVISION_TASK = "skills-provision-bmad";
var RETIRED_TASK_RENAMES = [
  ["link-agentfiles", LINK_AGENTFILES_TASK],
  ["skills-sync", SKILLS_SYNC_TASK],
  ["skills-provision-packs", PROVISION_PACKS_TASK],
  ["hooks-sync", "hooks:sync"],
  ["hooks-check", "hooks:check"],
  ["hooks-uninstall", "hooks:uninstall"],
  ["hindsight-setup", "hindsight:setup"]
];
function taskHeader(name) {
  return `[tasks."${name}"]`;
}
function taskHeaderPattern(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]$`);
}
var PROVISION_PACKS_SCRIPT = `python3 '{{config_root}}/${PROVISION_PACKS_SCRIPT_REL}' --root '{{config_root}}'`;
var LEGACY_PROVISION_BMAD_SKILLS_SCRIPT = `python3 '{{config_root}}/${LEGACY_PROVISION_SCRIPT_REL}'`;
var SYNC_SKILLS_SCRIPT = `python3 '{{config_root}}/${SYNC_SKILLS_SCRIPT_REL}' --scope project --root '{{config_root}}'`;
var SKILLS_SCHEMA_URL = "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json";
var RETIRED_SKILLS_SCHEMA_URLS = [
  "https://raw.githubusercontent.com/skillex/schemas/main/skills.schema.json"
];
var SKILLS_REGISTRY_URL = "https://github.com/delorenj/skillex.git";
var SKILLS_BACKUP_DIRNAME = "skills.bak";
var SKILLS_REGISTRY_SKILL_DIRS = ["all-skills", "skills"];
var BMAD_SKILL_NAME_PREFIX = "bmad-";
var RETIRED_PACK_NAMES = /* @__PURE__ */ new Set(["bmad"]);
function retiredPackDeclarations(manifest) {
  const packs = manifest?.packs;
  if (!Array.isArray(packs)) return [];
  const names = [];
  for (const entry of packs) {
    const name = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof entry.name === "string" ? entry.name : void 0;
    if (name && RETIRED_PACK_NAMES.has(name)) names.push(name);
  }
  return names;
}
function dropRetiredPackDeclarations(manifestPath, dryRun) {
  const raw = safeReadText(manifestPath);
  if (raw === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const manifest = parsed;
  const dropped = retiredPackDeclarations(manifest);
  if (!dropped.length) return [];
  manifest.packs = manifest.packs.filter((entry) => {
    const name = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof entry.name === "string" ? entry.name : void 0;
    return !(name && RETIRED_PACK_NAMES.has(name));
  });
  if (!dryRun) writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
  return dropped;
}
var PROJECT_CLI_SKILL_DIRS = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".opencode/skills",
  ".kimi-code/skills"
];
var CANONICAL_CLI_SKILLS_ALIAS = "../.agents/skills";
var HOOKS_COMMENT_HEADER = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.`;
var LINK_AGENTFILES_HOOK_ENTRIES = [
  LINK_AGENTFILES_SCRIPT,
  PROVISION_PACKS_SCRIPT,
  SYNC_SKILLS_SCRIPT
];
var LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
patterns = ["AGENTS.md"]
task = "${LINK_AGENTFILES_TASK}"

[[watch_files]]
patterns = [".agents/skills.json"]
task = "${SKILLS_SYNC_TASK}"

${taskHeader(LINK_AGENTFILES_TASK)}
description = "Symlink all agent files to AGENTS.md"
run = ${JSON.stringify(LINK_AGENTFILES_SCRIPT)}

${taskHeader(SKILLS_SYNC_TASK)}
description = "Sync skills from manifest to local CLI dirs"
depends = ["${PROVISION_PACKS_TASK}"]
run = ${JSON.stringify(SYNC_SKILLS_SCRIPT)}

${taskHeader(PROVISION_PACKS_TASK)}
description = "Provision every Skillex pack declared in .agents/skills.json"
run = ${JSON.stringify(PROVISION_PACKS_SCRIPT)}`;
var VERSIONING_BLOCK = `# >>> mise-versioning >>>  (managed block \u2014 do not edit by hand; re-run init to update)
[tasks."version"]
description = "Print the current version (vX.Y.Z)"
run = "'{{config_root}}/.mise/scripts/versioning.sh' current"

[tasks."version:bump"]
description = "Bump patch version: vX.Y.Z -> vX.Y.(Z+1)"
alias = "version:bump-patch"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump patch"

[tasks."version:bump-minor"]
description = "Bump minor version: vX.Y.Z -> vX.(Y+1).0"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump minor"

[tasks."version:bump-major"]
description = "Bump major version: vX.Y.Z -> v(X+1).0.0"
run = "'{{config_root}}/.mise/scripts/versioning.sh' bump major"

[tasks."version:check"]
description = "Verify every versioned file is in parity"
run = "'{{config_root}}/.mise/scripts/versioning.sh' check"

[tasks."version:sync"]
description = "Force every versioned file up to the highest version"
run = "'{{config_root}}/.mise/scripts/versioning.sh' sync"
# <<< mise-versioning <<<`;
function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n");
}
function readText(path) {
  return normalizeNewlines(readFileSync2(path, "utf8"));
}
function safeReadText(path) {
  return existsSync3(path) ? readText(path) : null;
}
function ensureParent(path) {
  mkdirSync3(dirname3(path), { recursive: true });
}
function writeText(path, content) {
  ensureParent(path);
  writeFileSync3(path, content);
}
function tryParseJson(text3) {
  if (!text3) return null;
  try {
    return JSON.parse(text3);
  } catch {
    return null;
  }
}
function slugifyRepoName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function titleCaseSlug(slug) {
  return slug.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function readSymlinkTarget(path) {
  if (!existsSync3(path)) return null;
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
function ensureSymlink(path, target, dryRun) {
  if (existsSync3(path)) {
    const stat = lstatSync2(path);
    if (stat.isSymbolicLink()) {
      const current = readSymlinkTarget(path);
      if (current === target) return { changed: false };
      if (!dryRun) {
        unlinkSync(path);
        symlinkSync(target, path);
      }
      return { changed: true };
    }
    return { changed: false, blocked: `${relative2(process.cwd(), path) || path} exists and is not a symlink` };
  }
  if (!dryRun) symlinkSync(target, path);
  return { changed: true };
}
function bootstrapAgentsFile(repoRoot, dryRun) {
  const agentsPath = join4(repoRoot, "AGENTS.md");
  if (existsSync3(agentsPath)) return { changedFiles: [], details: [] };
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const source = join4(repoRoot, file);
    if (!existsSync3(source)) continue;
    const stat = lstatSync2(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!dryRun) renameSync(source, agentsPath);
      return { changedFiles: [agentsPath], details: [`Moved ${file} to AGENTS.md before wiring agent-file symlinks`] };
    }
    return { changedFiles: [], details: [], blocked: `${file} exists but is not a regular file; cannot promote to AGENTS.md` };
  }
  const readmePath = join4(repoRoot, "README.md");
  if (existsSync3(readmePath)) {
    const stat = lstatSync2(readmePath);
    if (!stat.isFile()) return { changedFiles: [], details: [], blocked: "README.md exists but is not a regular file; cannot copy to AGENTS.md" };
    if (!dryRun) copyFileSync(readmePath, agentsPath);
    return { changedFiles: [agentsPath], details: ["Copied README.md to AGENTS.md before wiring agent-file symlinks"] };
  }
  return { changedFiles: [], details: [], blocked: "AGENTS.md missing and no CLAUDE.md, GEMINI.md, or README.md source exists" };
}
function yamlGet(text3, keyPath) {
  const parts = keyPath.split(".");
  const lines = text3.split("\n");
  let start = 0;
  let indent = 0;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const key = parts[idx];
    let found = false;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const currentIndent = match[1].length;
      const currentKey = match[2].trim();
      const rest = match[3].trim();
      if (idx > 0 && currentIndent < indent) break;
      if (currentIndent !== indent || currentKey !== key) continue;
      found = true;
      if (idx === parts.length - 1) {
        return rest.replace(/^['"]|['"]$/g, "").trim();
      }
      start = i + 1;
      indent = currentIndent + 2;
      break;
    }
    if (!found) return "";
  }
  return "";
}
function discoverRoles(repoRoot) {
  const rolesDir = join4(repoRoot, "agents", "hermes");
  if (!existsSync3(rolesDir)) return [];
  return readdirSync2(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const roleDir = join4(rolesDir, entry.name);
    const roleYamlPath = join4(roleDir, "role.yaml");
    if (!existsSync3(roleYamlPath)) return null;
    const text3 = readText(roleYamlPath);
    const runtimeRepoRaw = yamlGet(text3, "runtime.github_repo");
    return {
      role: yamlGet(text3, "role") || entry.name,
      roleDir,
      roleYamlPath,
      repo: yamlGet(text3, "repo"),
      agentId: yamlGet(text3, "agent_id"),
      profileName: yamlGet(text3, "profile") || yamlGet(text3, "agent_id"),
      displayName: yamlGet(text3, "display_name"),
      purpose: yamlGet(text3, "purpose"),
      botHandle: yamlGet(text3, "telegram.bot_username"),
      runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
      runtimeOwner: yamlGet(text3, "runtime.github_owner"),
      planeWorkspace: yamlGet(text3, "ticket_provider.workspace") || yamlGet(text3, "plane.workspace"),
      ticketProviderName: yamlGet(text3, "ticket_provider.name"),
      ticketProviderBoardId: yamlGet(text3, "ticket_provider.board_id"),
      ticketProviderIdentifier: yamlGet(text3, "plane.identifier"),
      bloodbankEnabled: yamlGet(text3, "bloodbank.enabled"),
      deploymentSystemd: yamlGet(text3, "deployment.systemd"),
      legacyReconcileEnabled: yamlGet(text3, "reconcile.enabled"),
      legacyReconcileGraceHours: yamlGet(text3, "reconcile.grace_hours"),
      legacyReconcileAutoReview: yamlGet(text3, "reconcile.auto_review"),
      legacyScrumGraceHours: yamlGet(text3, "scrum_master.grace_hours"),
      legacyScrumAutoReview: yamlGet(text3, "scrum_master.auto_review")
    };
  }).filter((value) => Boolean(value));
}
function registryPath(homeDir) {
  return join4(homeDir, ".hermes", "agents-registry.yaml");
}
var LEGACY_SYSTEMD_KEYS = ["consumer_unit", "checkpoint_timer"];
function legacyConsumerUnitPath(homeDir, agentId) {
  return join4(homeDir, ".config", "systemd", "user", `hermes-${agentId}-consumer.service`);
}
function systemctlUser(args) {
  const result2 = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result2.status === 0,
    stdout: result2.stdout.trim(),
    stderr: result2.stderr.trim()
  };
}
function templateScript(ctx, name) {
  const source = join4(ctx.pjanglerRoot, ".mise", "scripts", name);
  return existsSync3(source) ? readText(source) : void 0;
}
function templateVersioningScript(ctx) {
  return templateScript(ctx, "versioning.sh");
}
function templateLinkAgentfilesScript(ctx) {
  const source = join4(ctx.pjanglerRoot, "templates", "commonproject", "template", ".mise", "scripts", "link-agentfiles.sh");
  return existsSync3(source) ? readText(source) : templateScript(ctx, "link-agentfiles.sh");
}
function templateMaterializeEnvScript(ctx) {
  const source = join4(ctx.pjanglerRoot, "templates", "commonproject", "template", MATERIALIZE_ENV_SCRIPT_REL);
  return existsSync3(source) ? readText(source) : void 0;
}
function resolveAgentHooksLayer(ctx) {
  const override = process.env.PJ_AGENT_HOOKS_LAYER;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  if (existsSync3(join4(ctx.repoRoot, ".agents", "hooks", "sync.py"))) return true;
  return !existsSync3(join4(ctx.homeDir, ".agents", "hooks"));
}
function evaluateMiseConditionals(template, agentHooksLayer) {
  const out = [];
  let depth = 0;
  let skipDepth = 0;
  for (const line of template.split("\n")) {
    const stmt = line.trim();
    const ifMatch = /^\{%-?\s*if\s+(\w+)\s*-?%\}$/.exec(stmt);
    if (ifMatch) {
      depth += 1;
      const truthy = ifMatch[1] === "agent_hooks_layer" ? agentHooksLayer : false;
      if (skipDepth === 0 && !truthy) skipDepth = depth;
      continue;
    }
    if (/^\{%-?\s*endif\s*-?%\}$/.test(stmt)) {
      if (skipDepth === depth) skipDepth = 0;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (skipDepth === 0) out.push(line);
  }
  return out.join("\n");
}
function renderGeneratedProjectMiseToml(ctx, template) {
  const project = readProjectJson(ctx);
  const projectName = String(project?.project_name ?? basename2(ctx.repoRoot) ?? "project");
  return evaluateMiseConditionals(template, resolveAgentHooksLayer(ctx)).replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1").replace(/\{\{\s*project_name\s*\}\}/g, projectName);
}
function ensureMiseTomlFromTemplate(ctx, changedFiles) {
  const targetPath = join4(ctx.repoRoot, "mise.toml");
  if (existsSync3(targetPath)) return null;
  const sourcePath = join4(ctx.pjanglerRoot, "templates", "commonproject", "template", "mise.toml.jinja");
  if (!existsSync3(sourcePath)) return null;
  const rendered = renderGeneratedProjectMiseToml(ctx, readText(sourcePath));
  changedFiles.push(targetPath);
  if (!ctx.dryRun) writeText(targetPath, rendered);
  return rendered;
}
function templateCommonProjectText(ctx, rel) {
  const path = join4(ctx.pjanglerRoot, "templates", "commonproject", "template", rel);
  return existsSync3(path) ? readText(path) : void 0;
}
function validateSkillName(name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename2(name) !== name) {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
  return name;
}
function lstatIfPresent(path) {
  try {
    return lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function isContainedBy(root, target) {
  const rel = relative2(root, target);
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
function prepareSafeProjectSkillsDirs(ctx) {
  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsDir = join4(projectRoot, ".agents");
  const skillsDir = join4(agentsDir, "skills");
  for (const path of [agentsDir, skillsDir]) {
    if (!isContainedBy(projectRoot, path)) throw new Error(`Project skills path escapes repository: ${path}`);
    const stat = lstatIfPresent(path);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlinked project skills directory: ${path}`);
    if (stat && !stat.isDirectory()) throw new Error(`Project skills path is not a directory: ${path}`);
  }
  if (!ctx.dryRun) {
    if (!existsSync3(agentsDir)) mkdirSync3(agentsDir, { recursive: false });
    if (!existsSync3(skillsDir)) mkdirSync3(skillsDir, { recursive: false });
    for (const path of [agentsDir, skillsDir]) {
      if (lstatSync2(path).isSymbolicLink() || !lstatSync2(path).isDirectory()) {
        throw new Error(`Unsafe project skills directory after creation: ${path}`);
      }
      if (!isContainedBy(projectRoot, realpathSync(path))) {
        throw new Error(`Resolved project skills directory escapes repository: ${path}`);
      }
    }
  }
  return { agentsDir, skillsDir };
}
function projectSkillTopologyIssues(repoRoot) {
  const issues = [];
  let projectRoot;
  try {
    projectRoot = realpathSync(repoRoot);
  } catch (error) {
    return [`Project root is not a readable real directory: ${error instanceof Error ? error.message : String(error)}`];
  }
  const managedSkills = join4(projectRoot, ".agents", "skills");
  for (const rel of PROJECT_CLI_SKILL_DIRS) {
    const cliDir = join4(projectRoot, rel);
    const parent = dirname3(cliDir);
    const parentStat = lstatIfPresent(parent);
    if (!parentStat) continue;
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      issues.push(`${rel} has an unsafe symlinked/non-directory parent`);
      continue;
    }
    if (!isContainedBy(projectRoot, realOrSelf(parent))) {
      issues.push(`${rel} parent resolves outside the project`);
      continue;
    }
    const stat = lstatIfPresent(cliDir);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      let rawTarget = "";
      try {
        rawTarget = readlinkSync(cliDir);
      } catch {
        issues.push(`${rel} is an unreadable skills directory symlink`);
        continue;
      }
      if (rawTarget !== CANONICAL_CLI_SKILLS_ALIAS) {
        issues.push(`${rel} is an unsupported skills directory symlink`);
        continue;
      }
      const managedStat = lstatIfPresent(managedSkills);
      if (!managedStat || managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
        issues.push(`${rel} canonical alias target .agents/skills is missing or unsafe`);
        continue;
      }
      try {
        if (realpathSync(cliDir) !== realpathSync(managedSkills)) {
          issues.push(`${rel} canonical alias resolves outside .agents/skills`);
        }
      } catch {
        issues.push(`${rel} canonical alias is broken`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      issues.push(`${rel} is not a directory`);
      continue;
    }
    if (!isContainedBy(projectRoot, realOrSelf(cliDir))) {
      issues.push(`${rel} resolves outside the project`);
    }
  }
  return issues;
}
function packRootOverride(name) {
  const generic = process.env[`PJ_PACK_ROOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]?.trim();
  return generic ? resolve3(generic) : void 0;
}
function packMemberPath(pack, name) {
  const target = pack.memberPaths.get(validateSkillName(name));
  if (!target) throw new Error(`Pack ${pack.name} has no resolved path for member ${JSON.stringify(name)}`);
  return target;
}
function packProjectionSignature(pack) {
  return JSON.stringify(pack.members.map((name) => [name, pack.memberPaths.get(name) ?? null]));
}
function registryCacheDirName(registryUrl) {
  const cacheName = registryUrl.replace(/[^a-zA-Z0-9]/g, "_");
  if (!cacheName) {
    throw new Error(`Registry URL has no usable cache directory name: ${JSON.stringify(registryUrl)}`);
  }
  return cacheName;
}
function packRegistryRoots(ctx, registryUrl) {
  const explicit = process.env.PJ_SKILLS_REGISTRY_ROOT?.trim();
  if (explicit) return [resolve3(explicit)];
  const cacheName = registryCacheDirName(registryUrl);
  return [
    join4(ctx.homeDir, ".agents", ".cache", "registries", cacheName),
    join4(ctx.homeDir, "code", "skillex")
  ];
}
function resolvePackRoot(ctx, entry) {
  const override = packRootOverride(entry.name);
  if (override) {
    assertRealDirectory(override, `Pack ${entry.name} root`);
    return { root: override, description: "env override" };
  }
  if (entry.source) {
    if (entry.source.startsWith("file:")) {
      let local;
      try {
        local = resolve3(fileURLToPath(entry.source));
      } catch (error) {
        throw new Error(`Pack ${entry.name} source is not a usable file URI: ${entry.source}`);
      }
      assertRealDirectory(local, `Pack ${entry.name} root`);
      return { root: local, description: entry.source };
    }
    const cached = join4(ctx.homeDir, ".agents", ".cache", "skills", validatePathComponent(entry.name, "Pack name"));
    assertRealDirectory(cached, `Pack ${entry.name} clone cache`);
    return { root: cached, description: entry.source };
  }
  const registryUrl = entry.registry ?? SKILLS_REGISTRY_URL;
  const matches = [];
  let firstUnavailable;
  for (const candidate of packRegistryRoots(ctx, registryUrl)) {
    const stat = lstatIfPresent(candidate);
    if (!stat || !(stat.isDirectory() || stat.isSymbolicLink() && existsSync3(candidate))) continue;
    try {
      matches.push(resolvePackRootInRegistry(realpathSync(candidate), entry));
    } catch (error) {
      if (!(error instanceof PackUnavailableError)) throw error;
      firstUnavailable ??= error;
    }
  }
  if (!matches.length) {
    throw firstUnavailable ?? new PackUnavailableError(`No registry checkout available for ${registryUrl}`);
  }
  const chosen = matches.find((match) => match.attested) ?? matches[0];
  return { root: chosen.root, description: `${registryUrl}:${chosen.relativePath}` };
}
function packRootAttests(root, entry) {
  const metadata = readPackMetadata(root);
  if (!metadata) return false;
  if (metadata.name !== entry.name) {
    throw new Error(
      `Pack ${entry.name} pack.toml declares name ${JSON.stringify(metadata.name)}`
    );
  }
  if (entry.version && metadata.version !== entry.version) {
    throw new Error(
      `Pack ${entry.name} pack.toml declares version ${JSON.stringify(metadata.version)}, manifest pins ${JSON.stringify(entry.version)}`
    );
  }
  return true;
}
function resolvePackRootInRegistry(registryRoot, entry) {
  let relativePath;
  if (entry.registryPath) {
    relativePath = safeRelativePath(entry.registryPath, `pack ${entry.name} registry_path`);
  } else {
    relativePath = `packs/${entry.name}`;
    const packDir = join4(registryRoot, relativePath);
    assertNoSymlinkComponents(registryRoot, relativePath);
    assertRealDirectory(packDir, `Pack ${entry.name} directory`);
    if (entry.version) {
      relativePath = `${relativePath}/${entry.version}`;
    } else if (!isRegularFile(join4(packDir, "pack.toml"))) {
      const selected = selectPackVersion(packDir);
      if (selected !== null) relativePath = `${relativePath}/${selected}`;
    }
  }
  assertNoSymlinkComponents(registryRoot, relativePath);
  const root = join4(registryRoot, relativePath);
  assertRealDirectory(root, `Pack ${entry.name} root`);
  return { root, relativePath, attested: packRootAttests(root, entry) };
}
function manifestPackEntries(manifest) {
  const raw = manifest?.packs;
  if (raw === void 0 || raw === null) return { entries: [], errors: [] };
  if (!Array.isArray(raw)) return { entries: [], errors: [".agents/skills.json packs must be an array"] };
  const entries = [];
  const errors = [];
  for (const item of raw) {
    try {
      entries.push(normalizePackEntry(item));
    } catch (error) {
      errors.push(`.agents/skills.json packs[] entry is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}
function buildPackPlan(ctx, manifest) {
  const plan = {
    manifestSkills: [],
    projections: /* @__PURE__ */ new Map(),
    ownershipRoots: [],
    resolved: [],
    declared: [],
    errors: [],
    warnings: [],
    packWarnings: []
  };
  const { entries, errors } = manifestPackEntries(manifest);
  plan.errors.push(...errors);
  for (const entry of entries) {
    try {
      const { root } = resolvePackRoot(ctx, entry);
      const pack = validatePack(root, entry);
      const familyRoot = basename2(dirname3(root)) === entry.name ? dirname3(root) : void 0;
      const resolved = { entry, root, pack, familyRoot };
      plan.resolved.push(resolved);
      plan.declared.push(resolved);
      plan.ownershipRoots.push(root);
      if (familyRoot) plan.ownershipRoots.push(familyRoot);
      plan.packWarnings.push(...pack.warnings);
      for (const name of pack.members) {
        plan.projections.set(name, packMemberPath(pack, name));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (entry.optional && error instanceof PackUnavailableError) {
        plan.warnings.push(`Optional pack ${entry.name} is unavailable and was skipped: ${message}`);
      } else {
        plan.errors.push(`Skillex pack ${entry.name} could not be resolved: ${message}`);
      }
    }
  }
  if (plan.declared.length) {
    const managedNames = new Set(plan.manifestSkills.map((entry) => entry.name));
    for (const entry of Array.isArray(manifest?.skills) ? manifest.skills : []) {
      const name = skillManifestEntryName(entry);
      if (!name || !plan.projections.has(name)) continue;
      if (managedNames.has(name) || isRedundantDeclaredPackEntry(entry, plan)) continue;
      plan.projections.delete(name);
    }
  }
  return plan;
}
function assertPackPlanUnchanged(plan) {
  for (const item of plan.resolved) {
    const again = validatePack(item.root, item.entry);
    if (packProjectionSignature(again) !== packProjectionSignature(item.pack)) {
      throw new Error(`Pack ${item.entry.name} inventory changed after preflight`);
    }
  }
}
function skillManifestEntryName(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return void 0;
  const name = entry.name;
  return typeof name === "string" ? name : void 0;
}
function manifestEntrySourcePath(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const source = entry.source;
  if (typeof source !== "string" || !source.startsWith("file:")) return void 0;
  try {
    return resolve3(fileURLToPath(source));
  } catch {
    return void 0;
  }
}
function isRetiredBmadPackEntry(entry) {
  const name = skillManifestEntryName(entry);
  if (!name || !name.startsWith(BMAD_SKILL_NAME_PREFIX)) return false;
  const source = manifestEntrySourcePath(entry);
  return Boolean(source && /(^|\/)packs\/bmad\//.test(source));
}
function isPackManagedManifestEntry(entry, expectedNames, packRoots) {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  if (expectedNames.has(name)) return true;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  return basename2(sourcePath) === name && packRoots.some((root) => isContainedBy(root, sourcePath));
}
function isRedundantDeclaredPackEntry(entry, plan) {
  const name = skillManifestEntryName(entry);
  if (!name) return false;
  const sourcePath = manifestEntrySourcePath(entry);
  if (!sourcePath) return false;
  for (const declared of plan.declared) {
    if (isContainedBy(declared.pack.root, sourcePath)) return true;
    if (declared.familyRoot && declared.pack.inventoryNames.includes(name) && isContainedBy(declared.familyRoot, sourcePath)) {
      return true;
    }
  }
  return false;
}
function canonicalSkillsManifest(ctx, current, plan = buildPackPlan(ctx, current)) {
  const existing = Array.isArray(current?.skills) ? current.skills : [];
  return `${JSON.stringify(
    {
      ...current ?? {},
      $schema: SKILLS_SCHEMA_URL,
      inherit_global: true,
      registry: SKILLS_REGISTRY_URL,
      skills: [
        // Two evictions, deliberately narrow. `isRetiredBmadPackEntry` clears the
        // leftovers from when pjangler pinned a Skillex `bmad` pack;
        // `isRedundantDeclaredPackEntry` clears hand-expanded members of a pack
        // the repo now declares. Nothing else is removed — an entry pointing at
        // a CONTAINER inside a declared pack's family, or anywhere outside it,
        // is the user's.
        ...existing.filter(
          (entry) => !isRetiredBmadPackEntry(entry) && !isRedundantDeclaredPackEntry(entry, plan)
        ),
        ...plan.manifestSkills
      ]
    },
    null,
    2
  )}
`;
}
function skillsBackupDir(repoRoot) {
  return join4(repoRoot, ".agents", SKILLS_BACKUP_DIRNAME);
}
function skillsRegistryRoots(ctx) {
  return packRegistryRoots(ctx, SKILLS_REGISTRY_URL);
}
function availableSkillsRegistryRoots(ctx) {
  return skillsRegistryRoots(ctx).filter(
    (root) => SKILLS_REGISTRY_SKILL_DIRS.some((dir) => existsSync3(join4(root, dir)))
  );
}
function digestSkillEntry(root) {
  const hash = createHash2("sha256");
  try {
    const stat = lstatSync2(root);
    if (stat.isSymbolicLink()) return null;
    if (stat.isFile()) {
      const content = readFileSync2(root);
      hash.update(`file\0\0${content.length}\0`);
      hash.update(content);
      return hash.digest("hex");
    }
    if (!stat.isDirectory()) return null;
    const walk = (dir, rel) => {
      for (const name of readdirSync2(dir).sort()) {
        const full = join4(dir, name);
        const entryRel = rel ? `${rel}/${name}` : name;
        const entryStat = lstatSync2(full);
        if (entryStat.isSymbolicLink()) return false;
        if (entryStat.isDirectory()) {
          hash.update(`dir\0${entryRel}\0`);
          if (!walk(full, entryRel)) return false;
        } else if (entryStat.isFile()) {
          const content = readFileSync2(full);
          hash.update(`file\0${entryRel}\0${content.length}\0`);
          hash.update(content);
        } else {
          return false;
        }
      }
      return true;
    };
    hash.update("dir\0");
    return walk(root, "") ? hash.digest("hex") : null;
  } catch {
    return null;
  }
}
function legacyCommittedSkillNames(skillsDir, backupDir, expectedNames, packRoots, manifestNames) {
  const stat = lstatIfPresent(skillsDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
  const names = [];
  let entries;
  try {
    entries = readdirSync2(skillsDir).sort();
  } catch {
    return [];
  }
  for (const name of entries) {
    if (expectedNames.has(name) || manifestNames.has(name)) continue;
    if (name.startsWith(BMAD_SKILL_NAME_PREFIX)) continue;
    const path = join4(skillsDir, name);
    let linkTarget = null;
    try {
      linkTarget = lstatSync2(path).isSymbolicLink() ? resolve3(dirname3(path), readlinkSync(path)) : null;
    } catch {
      linkTarget = null;
    }
    if (linkTarget && (packRoots.some((root) => isContainedBy(root, linkTarget)) || isContainedBy(backupDir, linkTarget))) {
      continue;
    }
    names.push(name);
  }
  return names;
}
function planLegacyCommittedSkill(skillsDir, backupDir, registryRoots, name) {
  const backupTarget = join4(backupDir, name);
  const localDescription = (reason) => `${name} -> file://${backupTarget} (${reason}; kept local)`;
  const digest = digestSkillEntry(join4(skillsDir, name));
  if (!digest) {
    return { name, description: localDescription("entry is a symlink or is not byte-comparable") };
  }
  if (!registryRoots.length) {
    return { name, description: localDescription("no local registry checkout to compare against") };
  }
  for (const root of registryRoots) {
    for (const dir of SKILLS_REGISTRY_SKILL_DIRS) {
      const candidate = join4(root, dir, name);
      if (!existsSync3(candidate)) continue;
      if (digestSkillEntry(candidate) !== digest) continue;
      return {
        name,
        registryPath: `${dir}/${name}`,
        description: `${name} -> registry_path ${dir}/${name} (exact content match)`
      };
    }
  }
  return { name, description: localDescription("no exact registry content match") };
}
function migrateLegacyCommittedSkills(ctx, changedFiles) {
  const details = [];
  const agentsDir = join4(ctx.repoRoot, ".agents");
  const skillsDir = join4(agentsDir, "skills");
  const backupDir = skillsBackupDir(ctx.repoRoot);
  const manifestPath = join4(agentsDir, "skills.json");
  const rawManifest = safeReadText(manifestPath);
  const manifest = tryParseJson(rawManifest);
  if (rawManifest !== null && manifest === null) {
    return details;
  }
  const packPlan = buildPackPlan(ctx, manifest);
  const expectedNames = new Set(packPlan.projections.keys());
  const manifestSkills = Array.isArray(manifest?.skills) ? [...manifest.skills] : [];
  const manifestNames = new Set(
    manifestSkills.map(skillManifestEntryName).filter((name) => Boolean(name))
  );
  const names = legacyCommittedSkillNames(skillsDir, backupDir, expectedNames, packPlan.ownershipRoots, manifestNames);
  if (!names.length) return details;
  const registryRoots = availableSkillsRegistryRoots(ctx);
  if (!registryRoots.length) {
    details.push(
      `No local ${SKILLS_REGISTRY_URL} checkout is available; registry matching is skipped (set PJ_SKILLS_REGISTRY_ROOT or let skills-sync clone the registry)`
    );
  }
  const plans = names.map((name) => planLegacyCommittedSkill(skillsDir, backupDir, registryRoots, name));
  if (!ctx.acceptRegistryMatches) {
    for (const plan of plans) details.push(`proposed mapping: ${plan.description}`);
    details.push(
      `${plans.length} legacy committed skill(s) left untouched; re-run with --accept-registry-matches to apply`
    );
    return details;
  }
  const applied = [];
  for (const plan of plans) {
    const from = join4(skillsDir, plan.name);
    const to = join4(backupDir, plan.name);
    if (lstatIfPresent(to)) {
      details.push(`skipped ${plan.name}: ${to} already exists and would be overwritten`);
      continue;
    }
    if (!changedFiles.includes(to)) changedFiles.push(to);
    if (!ctx.dryRun) {
      mkdirSync3(backupDir, { recursive: true });
      renameSync(from, to);
    }
    manifestSkills.push(
      plan.registryPath ? { name: plan.name, registry_path: plan.registryPath } : { name: plan.name, source: pathToFileURL(to).href }
    );
    applied.push(plan);
    details.push(`mapped ${plan.description}`);
  }
  if (!applied.length) return details;
  const merged = { ...manifest ?? {}, skills: manifestSkills };
  let nextManifest;
  try {
    nextManifest = canonicalSkillsManifest(ctx, merged);
  } catch {
    nextManifest = `${JSON.stringify(merged, null, 2)}
`;
  }
  if (nextManifest !== rawManifest) {
    if (!changedFiles.includes(manifestPath)) changedFiles.push(manifestPath);
    if (!ctx.dryRun) writeText(manifestPath, nextManifest);
  }
  return details;
}
function removeProjectEntry(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function normalizeExecutableTemplate(ctx, target, expected, changedFiles) {
  const stat = lstatIfPresent(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Refusing non-regular managed executable target: ${target}`);
  }
  const contentChanged = !stat || safeReadText(target) !== expected;
  const modeChanged = !stat || (Number(stat.mode) & 73) === 0;
  if (!contentChanged && !modeChanged) return;
  if (!changedFiles.includes(target)) changedFiles.push(target);
  if (ctx.dryRun) return;
  if (contentChanged) {
    writeText(target, expected);
  }
  const beforeChmod = lstatIfPresent(target);
  if (!beforeChmod?.isFile() || beforeChmod.isSymbolicLink()) {
    throw new Error(`Refusing changed managed executable target: ${target}`);
  }
  chmodSync(target, 493);
}
function atomicWriteBuffer(path, content, mode, temporary) {
  writeFileSync3(temporary, content, { flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}
function provisionDeclaredPacks(ctx, preservedManifest, hooks = {}) {
  let initialDirs;
  try {
    initialDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const initialManifestPath = join4(initialDirs.agentsDir, "skills.json");
  const initialManifestStat = lstatIfPresent(initialManifestPath);
  if (initialManifestStat?.isSymbolicLink() || initialManifestStat && !initialManifestStat.isFile()) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${initialManifestPath}` };
  }
  const declaringManifest = preservedManifest ?? tryParseJson(initialManifestStat ? readRegularFile(initialManifestPath).toString("utf8") : null);
  const plan = buildPackPlan(ctx, declaringManifest);
  if (plan.errors.length) {
    return { ok: false, changedFiles: [], error: plan.errors.join("; ") };
  }
  const packSkills = plan.manifestSkills;
  hooks.afterPreflight?.();
  const projectRoot = realpathSync(ctx.repoRoot);
  const agentsPath = join4(projectRoot, ".agents");
  const skillsPath = join4(agentsPath, "skills");
  const agentsExisted = Boolean(lstatIfPresent(agentsPath));
  const skillsExisted = Boolean(lstatIfPresent(skillsPath));
  let preflightDirs;
  try {
    preflightDirs = prepareSafeProjectSkillsDirs({ ...ctx, dryRun: true });
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const manifestPath = join4(preflightDirs.agentsDir, "skills.json");
  const manifestStat = lstatIfPresent(manifestPath);
  if (manifestStat?.isSymbolicLink() || manifestStat && !manifestStat.isFile()) {
    return { ok: false, changedFiles: [], error: `Refusing unsafe skills manifest: ${manifestPath}` };
  }
  const manifestBytes = manifestStat ? readRegularFile(manifestPath) : null;
  const manifestMode = manifestStat ? Number(manifestStat.mode) & 511 : 420;
  let currentManifest = {};
  if (manifestBytes !== null) {
    try {
      const parsed = JSON.parse(manifestBytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain a JSON object");
      currentManifest = parsed;
      if (currentManifest.skills !== void 0 && !Array.isArray(currentManifest.skills)) throw new Error("skills must be an array");
    } catch (error) {
      return { ok: false, changedFiles: [], error: `Invalid existing skills manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  let safeDirs;
  try {
    safeDirs = prepareSafeProjectSkillsDirs(ctx);
  } catch (error) {
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  const nextManifest = canonicalSkillsManifest(ctx, preservedManifest ?? currentManifest, plan);
  const skillsDir = safeDirs.skillsDir;
  const resolvedSkillsDir = ctx.dryRun && !existsSync3(skillsDir) ? skillsDir : realpathSync(skillsDir);
  const expected = new Map(plan.projections);
  const expectedNames = new Set(expected.keys());
  const ownershipManifest = preservedManifest ?? currentManifest;
  const managedManifestNames = new Set(
    (Array.isArray(ownershipManifest.skills) ? ownershipManifest.skills : []).filter((entry) => isPackManagedManifestEntry(entry, expectedNames, plan.ownershipRoots)).map(skillManifestEntryName).filter((name) => Boolean(name))
  );
  const affected = /* @__PURE__ */ new Set();
  const staleManagedNames = /* @__PURE__ */ new Set();
  const originalCorrectLinks = /* @__PURE__ */ new Map();
  if (existsSync3(skillsDir)) {
    for (const name of readdirSync2(skillsDir)) {
      validateSkillName(name);
      if (dirname3(join4(resolvedSkillsDir, name)) !== resolvedSkillsDir) {
        return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
      }
      const entryPath = join4(skillsDir, name);
      let linkTargetsPack = false;
      try {
        const linkTarget = lstatSync2(entryPath).isSymbolicLink() ? resolve3(dirname3(entryPath), readlinkSync(entryPath)) : null;
        linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget));
      } catch {
        linkTargetsPack = false;
      }
      if (!expected.has(name) && !managedManifestNames.has(name) && !linkTargetsPack) continue;
      const target = expected.get(name);
      let correct = false;
      try {
        correct = Boolean(target) && lstatSync2(entryPath).isSymbolicLink() && resolve3(dirname3(entryPath), readlinkSync(entryPath)) === target;
      } catch {
        correct = false;
      }
      if (correct) originalCorrectLinks.set(name, readlinkSync(join4(skillsDir, name)));
      else {
        affected.add(name);
        if (!target) staleManagedNames.add(name);
      }
    }
  }
  for (const [name, target] of expected) {
    const link = join4(resolvedSkillsDir, validateSkillName(name));
    if (dirname3(link) !== resolvedSkillsDir) {
      return { ok: false, changedFiles: [], error: `BMAD skill path escapes project skills directory: ${name}` };
    }
    let correct = false;
    try {
      correct = lstatSync2(link).isSymbolicLink() && resolve3(dirname3(link), readlinkSync(link)) === target;
    } catch {
      correct = false;
    }
    if (!correct) affected.add(name);
  }
  const manifestChanged = manifestBytes?.toString("utf8") !== nextManifest;
  const changedFiles = [
    ...manifestChanged ? [manifestPath] : [],
    ...affected.size ? [skillsDir] : []
  ];
  if (ctx.dryRun || changedFiles.length === 0) {
    try {
      assertPackPlanUnchanged(plan);
      return { ok: true, changedFiles, packWarnings: plan.packWarnings };
    } catch (error) {
      return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  const transaction = mkdtempSync(join4(safeDirs.agentsDir, ".bmad-transaction-"));
  const backup = join4(transaction, "entries");
  mkdirSync3(backup);
  const moved = [];
  const rollback = () => {
    const errors = [];
    try {
      for (const name of affected) {
        removeProjectEntry(join4(skillsDir, validateSkillName(name)));
      }
      for (const name of originalCorrectLinks.keys()) {
        removeProjectEntry(join4(skillsDir, validateSkillName(name)));
      }
    } catch (error) {
      errors.push(`remove applied projection: ${String(error)}`);
    }
    for (const name of [...moved].reverse()) {
      try {
        renameSync(join4(backup, name), join4(skillsDir, name));
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    for (const [name, rawTarget] of originalCorrectLinks) {
      try {
        symlinkSync(rawTarget, join4(skillsDir, name), "dir");
      } catch (error) {
        errors.push(`restore ${name}: ${String(error)}`);
      }
    }
    try {
      if (manifestBytes === null) removeProjectEntry(manifestPath);
      else atomicWriteBuffer(manifestPath, manifestBytes, manifestMode, join4(transaction, "manifest.restore"));
    } catch (error) {
      errors.push(`restore manifest: ${String(error)}`);
    }
    rmSync(transaction, { recursive: true, force: true });
    try {
      if (!skillsExisted && existsSync3(skillsDir) && readdirSync2(skillsDir).length === 0) rmdirSync(skillsDir);
      if (!agentsExisted && existsSync3(safeDirs.agentsDir) && readdirSync2(safeDirs.agentsDir).length === 0) rmdirSync(safeDirs.agentsDir);
    } catch (error) {
      errors.push(`remove created directories: ${String(error)}`);
    }
    if (errors.length) throw new Error(`BMAD rollback was incomplete: ${errors.join("; ")}`);
  };
  try {
    for (const name of affected) {
      const entry = join4(skillsDir, name);
      if (lstatIfPresent(entry)) {
        renameSync(entry, join4(backup, name));
        moved.push(name);
      }
    }
    let index = 0;
    for (const [name, target] of expected) {
      index += 1;
      const link = join4(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync2(link).isSymbolicLink() && resolve3(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (correct) continue;
      if (hooks.createLink) hooks.createLink(target, link, index);
      else symlinkSync(target, link, "dir");
    }
    if (manifestChanged) {
      atomicWriteBuffer(manifestPath, Buffer.from(nextManifest), manifestMode, join4(transaction, "manifest.next"));
    }
    assertPackPlanUnchanged(plan);
    hooks.afterApply?.(manifestPath, skillsDir);
    for (const name of staleManagedNames) {
      if (lstatIfPresent(join4(skillsDir, name))) {
        throw new Error(`Applied BMAD projection retained stale managed entry: ${name}`);
      }
    }
    for (const [name, target] of expected) {
      const link = join4(skillsDir, name);
      let correct = false;
      try {
        correct = lstatSync2(link).isSymbolicLink() && resolve3(skillsDir, readlinkSync(link)) === target;
      } catch {
        correct = false;
      }
      if (!correct) throw new Error(`Applied BMAD projection link differs from plan: ${name}`);
    }
    const finalManifestStat = lstatIfPresent(manifestPath);
    if (!finalManifestStat || finalManifestStat.isSymbolicLink() || !finalManifestStat.isFile() || (Number(finalManifestStat.mode) & 511) !== manifestMode || readFileSync2(manifestPath).toString("utf8") !== nextManifest) {
      throw new Error("Applied BMAD skills manifest differs from planned bytes or mode");
    }
    const finalManifest = JSON.parse(readFileSync2(manifestPath, "utf8"));
    if (finalManifest.$schema !== SKILLS_SCHEMA_URL || finalManifest.inherit_global !== true || finalManifest.registry !== SKILLS_REGISTRY_URL || !Array.isArray(finalManifest.skills)) {
      throw new Error("Applied BMAD skills manifest schema differs from plan");
    }
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      return { ok: false, changedFiles: [], error: `BMAD provisioning failed (${String(error)}); ${String(rollbackError)}` };
    }
    return { ok: false, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  rmSync(transaction, { recursive: true });
  return { ok: true, changedFiles, packWarnings: plan.packWarnings };
}
function templateVersionFilesConf(ctx, repoRoot) {
  const packageJson = join4(repoRoot, "package.json");
  return existsSync3(packageJson) ? "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\njson package.json\ngittag .\n" : "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\ngittag .\n";
}
function replaceOrAppendManagedBlock(text3, startMarker, block, beforePattern) {
  if (startMarker.test(text3)) {
    return text3.replace(/# >>> mise-versioning >>>[\s\S]*?# <<< mise-versioning <<</, block);
  }
  if (beforePattern) {
    const match = text3.match(beforePattern);
    if (match && typeof match.index === "number") {
      return `${text3.slice(0, match.index).replace(/\s*$/, "\n\n")}${block}

${text3.slice(match.index)}`;
    }
  }
  return `${text3.replace(/\s*$/, "")}

${block}
`;
}
var BASE_MISE_PATH_ENTRIES = [".mise/scripts", "agents/hermes/pm"];
var CONDITIONAL_HERMES_PATHS = ["agents/hermes/pm/hermes", "agent/hermes/pm/hermes"];
function requiredMisePathEntries(ctx) {
  const required = [...BASE_MISE_PATH_ENTRIES];
  for (const candidate of CONDITIONAL_HERMES_PATHS) {
    if (existsSync3(join4(ctx.repoRoot, candidate)) && !required.includes(candidate)) required.push(candidate);
  }
  return required;
}
function upsertMisePath(text3, required = BASE_MISE_PATH_ENTRIES) {
  const render = (values) => `_.path = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const envMatch = text3.match(/(^|\n)(\[env\][\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!envMatch || typeof envMatch.index !== "number") {
    return `[env]
${render(required)}

${text3.replace(/^\s+/, "")}`;
  }
  const prefix = text3.slice(0, envMatch.index + envMatch[1].length);
  const section2 = envMatch[2];
  const suffix = text3.slice(envMatch.index + envMatch[1].length + section2.length);
  const pathLine = section2.match(/^_\.path\s*=\s*\[([^\]]*)\]\s*$/m);
  if (!pathLine) {
    return `${prefix}${section2.replace(/\n?$/, "\n")}${render(required)}${suffix}`;
  }
  const current = [...pathLine[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const merged = [...current];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  const nextLine = render(merged);
  if (pathLine[0] === nextLine) return text3;
  return `${prefix}${section2.replace(pathLine[0], nextLine)}${suffix}`;
}
function removeTomlSection(text3, headerPattern, marker, options) {
  const lines = text3.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!headerPattern.test(lines[i])) continue;
    if (marker) {
      let hasMarker = false;
      for (let j = i + 1; j < lines.length && !/^\[[^\]]+\]/.test(lines[j]); j++) {
        if (marker.test(lines[j])) {
          hasMarker = true;
          break;
        }
      }
      if (!hasMarker) continue;
    }
    start = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\[[^\]]+\]/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end === -1) end = lines.length;
    break;
  }
  if (start === -1) return text3;
  while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) {
    end--;
  }
  if (options?.includePrecedingComments) {
    while (start > 0 && lines[start - 1].trim().startsWith("#")) {
      start--;
    }
  }
  const result2 = lines.slice(0, start).concat(lines.slice(end)).join("\n");
  return result2.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
function insertTomlBlockBeforeVersioning(text3, block) {
  const versioningIndex = text3.indexOf("# >>> mise-versioning >>>");
  if (versioningIndex >= 0) {
    return `${text3.slice(0, versioningIndex).replace(/\s*$/, "\n\n")}${block}

${text3.slice(versioningIndex)}`;
  }
  return `${text3.replace(/\s*$/, "")}

${block}
`;
}
function insertHookBlock(text3, block) {
  const structural = /^(?:\[\[watch_files\]\]|\[tasks(?:\.|\]))/m.exec(text3);
  const versioningIndex = text3.indexOf("# >>> mise-versioning >>>");
  const candidates = [structural?.index, versioningIndex >= 0 ? versioningIndex : void 0].filter((value) => value !== void 0);
  if (candidates.length) {
    const index = Math.min(...candidates);
    return `${text3.slice(0, index).replace(/\s*$/, "\n\n")}${block}

${text3.slice(index)}`;
  }
  return `${text3.replace(/\s*$/, "")}

${block}
`;
}
function extractTomlStrings(text3) {
  const values = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of text3.matchAll(stringPattern)) {
    if (match[1] !== void 0) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch {
        values.push(match[1]);
      }
    } else if (match[2] !== void 0) {
      values.push(match[2]);
    }
  }
  return values;
}
function stripTomlStringsAndComments(line) {
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''").replace(/#.*$/, "");
}
function normalizeOpInjectPath(raw) {
  let path = raw.trim();
  if (path.startsWith("'") && path.endsWith("'") || path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path.replace(/^\{\{config_root\}\}\//, "").replace(/^\.\//, "");
}
var QUOTED_OR_BARE = String.raw`("[^"]*"|'[^']*'|\S+)`;
function opInjectOutputTarget(value) {
  const trimmed2 = value.trim();
  const start = trimmed2.search(/\bop\s+inject\b/);
  if (start < 0) return null;
  const tail = trimmed2.slice(start);
  const mv = new RegExp(String.raw`\bmv\s+(?:-\S+\s+)*${QUOTED_OR_BARE}\s+${QUOTED_OR_BARE}`).exec(tail);
  if (mv?.[2]) return normalizeOpInjectPath(mv[2]);
  const redirect = new RegExp(String.raw`>\s*${QUOTED_OR_BARE}`).exec(tail);
  if (redirect?.[1]) return normalizeOpInjectPath(redirect[1]);
  const flag = new RegExp(String.raw`\s(?:-o|--out(?:put)?)[=\s]\s*${QUOTED_OR_BARE}`).exec(tail);
  if (flag?.[1]) return normalizeOpInjectPath(flag[1]);
  return null;
}
function isOpInjectHookEntry(value) {
  const trimmed2 = value.trim();
  if (trimmed2 === OP_INJECT_SCRIPT) return true;
  return opInjectOutputTarget(trimmed2) === ".env";
}
function truncatingOpInjectEntries(enterHooks) {
  return enterHooks.filter((value) => value.trim() !== OP_INJECT_SCRIPT && isOpInjectHookEntry(value));
}
function tomlValueSpanEnd(lines, start, limit) {
  let depth = 0;
  let j = start;
  for (; j < limit; j++) {
    for (const ch of stripTomlStringsAndComments(lines[j])) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    if (depth <= 0) break;
  }
  return Math.min(j, limit - 1) + 1;
}
function stripHookBlocks(text3) {
  const lines = text3.split("\n");
  const enter = [];
  const leave = [];
  const records = [];
  const drop = new Array(lines.length).fill(false);
  const isHeader = (line) => /^\[/.test(line.trim());
  for (let i = 0; i < lines.length; i++) {
    const trimmed2 = lines[i].trim();
    const tableMatch = /^\[\[\s*hooks\.(enter|leave)\s*\]\]$/.exec(trimmed2);
    if (tableMatch) {
      const kind = tableMatch[1];
      const bucket = kind === "enter" ? enter : leave;
      let recordScript;
      let j = i + 1;
      for (; j < lines.length && !isHeader(lines[j]); j++) {
        if (lines[j].trim().startsWith("# >>> mise-versioning >>>")) break;
        const scriptMatch = /^\s*script\s*=\s*(.+)$/.exec(lines[j]);
        if (scriptMatch) {
          const value = extractTomlStrings(scriptMatch[1])[0];
          if (value !== void 0) {
            recordScript = value;
            bucket.push(value);
          }
        }
      }
      for (let k = i; k < j; k++) drop[k] = true;
      records.push({ kind, script: recordScript, raw: lines.slice(i, j).join("\n").replace(/\n+$/, "") });
      i = j - 1;
      continue;
    }
    if (trimmed2 === "[hooks]") {
      let j = i + 1;
      let lastDrop = i;
      while (j < lines.length && !isHeader(lines[j])) {
        const keyMatch = /^\s*(enter|leave)\s*=/.exec(lines[j]);
        if (keyMatch) {
          const bucket = keyMatch[1] === "enter" ? enter : leave;
          const end = tomlValueSpanEnd(lines, j, lines.length);
          const chunk = lines.slice(j, end).filter((line) => !/^\s*#/.test(line)).join("\n");
          for (const value of extractTomlStrings(chunk)) {
            bucket.push(value);
            records.push({ kind: keyMatch[1], script: value, raw: `[[hooks.${keyMatch[1]}]]
script = ${JSON.stringify(value)}` });
          }
          lastDrop = end - 1;
          j = end;
        } else if (/^\s*\]\s*$/.test(lines[j])) {
          lastDrop = j;
          j++;
        } else {
          j++;
        }
      }
      for (let k = i; k <= lastDrop; k++) drop[k] = true;
      i = j - 1;
      continue;
    }
  }
  const kept = lines.filter((_, idx) => !drop[idx]).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  return { text: kept, enter, leave, records };
}
function ownedOpInjectScriptsOutsideEnter(text3) {
  const findings = [];
  let table = "";
  for (const [index, line] of text3.split("\n").entries()) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].replace(/[\[\]\s]/g, "");
      continue;
    }
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") continue;
    const value = extractTomlStrings(script[1])[0];
    if (value !== void 0 && isOpInjectHookEntry(value)) findings.push({ line: index + 1, value });
  }
  return findings;
}
function removeOwnedOpInjectScriptsOutsideEnter(text3) {
  let table = "";
  return text3.split("\n").filter((line) => {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].replace(/[\[\]\s]/g, "");
      return true;
    }
    const script = /^\s*script\s*=\s*(.+)$/.exec(line);
    if (!script || table === "hooks.enter") return true;
    const value = extractTomlStrings(script[1])[0];
    return value === void 0 || !isOpInjectHookEntry(value);
  }).join("\n");
}
function renderHookTables(scripts, kind) {
  return scripts.map((script) => `[[hooks.${kind}]]
script = ${JSON.stringify(script)}`);
}
function isMiseCoreHookEntry(value) {
  const trimmed2 = value.trim();
  if (isOpInjectHookEntry(trimmed2)) return false;
  return trimmed2 === SYNC_SKILLS_SCRIPT || trimmed2 === PROVISION_PACKS_SCRIPT || trimmed2 === LEGACY_PROVISION_BMAD_SKILLS_SCRIPT || /sync-skills(?:\.py)?["']?\s+--scope project/.test(trimmed2) || /provision-(?:packs|bmad-skills)\.py/.test(trimmed2) || /link-(?:project-skills-to-clis|agentfiles)\.sh'?(?:\s+\S.*)?$/.test(trimmed2) || /unlink-project-skills-from-clis\.sh'?(?:\s+\S.*)?$/.test(trimmed2);
}
function reconcileHookOwner(text3, owns, canonicalScripts, header = "") {
  const { text: stripped, records } = stripHookBlocks(text3);
  const canonicalRecords = renderHookTables(canonicalScripts, "enter");
  const output = [];
  let inserted = false;
  for (const record of records) {
    if (owns(record)) {
      if (!inserted) {
        output.push(...canonicalRecords);
        inserted = true;
      }
      continue;
    }
    output.push(record.raw);
  }
  if (!inserted) output.unshift(...canonicalRecords);
  const effectiveHeader = header || (stripped.includes(HOOKS_COMMENT_HEADER) ? HOOKS_COMMENT_HEADER : "");
  const withoutManagedHeader = effectiveHeader ? stripped.replace(HOOKS_COMMENT_HEADER, "").replace(/\n{3,}/g, "\n\n") : stripped;
  const block = [effectiveHeader, ...output].filter(Boolean).join("\n");
  return insertHookBlock(withoutManagedHeader, block);
}
function upsertLinkAgentfilesHooks(text3) {
  return reconcileHookOwner(
    text3,
    (record) => record.kind === "enter" && Boolean(record.script && isMiseCoreHookEntry(record.script)),
    LINK_AGENTFILES_HOOK_ENTRIES,
    HOOKS_COMMENT_HEADER
  );
}
function upsertOpInjectHook(text3) {
  const withoutStrays = removeOwnedOpInjectScriptsOutsideEnter(text3);
  return reconcileHookOwner(
    withoutStrays,
    (record) => record.kind === "enter" && Boolean(record.script && isOpInjectHookEntry(record.script)),
    [OP_INJECT_SCRIPT]
  );
}
function retiredTaskNameIssues(text3) {
  const issues = [];
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const present = new RegExp(
      `^\\[tasks\\.(?:"${esc}"|${esc})\\]|^\\s*task\\s*=\\s*"${esc}"|^\\s*depends\\s*=\\s*\\[[^\\]]*"${esc}"`,
      "m"
    ).test(text3);
    if (present) issues.push(`mise.toml still uses the retired task name "${oldName}" (renamed to "${newName}")`);
  }
  return issues;
}
function renameRetiredMiseTasks(text3) {
  let out = text3;
  for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`^\\[tasks\\.(?:"${esc}"|${esc})\\]`, "gm"), taskHeader(newName));
    out = out.replace(new RegExp(`^(\\s*task\\s*=\\s*)"${esc}"`, "gm"), `$1"${newName}"`);
    out = out.replace(new RegExp(`\\bmise run ${esc}\\b`, "g"), `mise run ${newName}`);
  }
  return out.replace(/^(\s*depends\s*=\s*)(\[[^\]]*\])/gm, (_whole, head, arr) => {
    let next = arr;
    for (const [oldName, newName] of RETIRED_TASK_RENAMES) {
      next = next.split(`"${oldName}"`).join(`"${newName}"`);
    }
    return head + next;
  });
}
function upsertLinkAgentfilesBlock(text3, ctx) {
  const withPath = upsertMisePath(renameRetiredMiseTasks(text3), requiredMisePathEntries(ctx));
  let cleaned = removeTomlSection(withPath, taskHeaderPattern(LINK_AGENTFILES_TASK), /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-agentfiles\]$/, /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(SKILLS_SYNC_TASK), void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-sync\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, taskHeaderPattern(PROVISION_PACKS_TASK), void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-packs\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-provision-bmad\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.link-project-skills-to-clis\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.unlink-project-skills-from-clis\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[tasks\.skills-relink\]$/, void 0, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /AGENTS\.md/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /\.agents\/skills\.json/, { includePrecedingComments: false });
  cleaned = upsertLinkAgentfilesHooks(cleaned);
  return insertTomlBlockBeforeVersioning(cleaned, LINK_AGENTFILES_WATCH_TASK_BLOCK);
}
function readProjectJson(ctx) {
  return tryParseJson(safeReadText(join4(ctx.repoRoot, ".project.json")));
}
function readDeclaredAgents(ctx) {
  const project = readProjectJson(ctx);
  const agents = project?.agents;
  if (!agents || typeof agents !== "object") return [];
  return Object.entries(agents).map(([agentId, value]) => {
    const entry = typeof value === "object" && value !== null ? value : {};
    return {
      agentId,
      role: typeof entry.role === "string" ? entry.role : void 0,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : void 0,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir"))
    };
  });
}
function readRoleYamlAt(roleDir) {
  const roleYamlPath = join4(roleDir, "role.yaml");
  if (!existsSync3(roleYamlPath)) return null;
  const text3 = readText(roleYamlPath);
  return {
    role: yamlGet(text3, "role"),
    agentId: yamlGet(text3, "agent_id"),
    providerName: yamlGet(text3, "ticket_provider.name"),
    text: text3
  };
}
function declaredRoleIsUnprovisioned(repoRoot, roleDir) {
  if (!roleDir) return true;
  return !existsSync3(join4(resolve3(repoRoot, roleDir), "role.yaml"));
}
function validateDeclaredAgent(ctx, declared) {
  const details = [];
  if (!declared.roleDir) {
    details.push(`agents.${declared.agentId}.role_dir missing`);
    return { valid: false, details };
  }
  const roleDir = resolve3(ctx.repoRoot, declared.roleDir);
  if (!existsSync3(roleDir)) {
    details.push(`agents.${declared.agentId}.role_dir ${declared.roleDir} does not exist`);
    return { valid: false, roleDir, details };
  }
  const roleYaml = readRoleYamlAt(roleDir);
  if (!roleYaml) {
    details.push(`agents.${declared.agentId}.role_dir ${declared.roleDir} missing role.yaml`);
    return { valid: false, roleDir, details };
  }
  if (declared.role !== roleYaml.role) {
    details.push(`agents.${declared.agentId}.role should be ${roleYaml.role} (declared ${declared.role})`);
  }
  if (declared.agentId !== roleYaml.agentId) {
    details.push(`agents.${declared.agentId} should map to agent_id ${roleYaml.agentId}`);
  }
  if (roleYaml.providerName) {
    const dispatcher = join4(roleDir, ".scripts", "lib", "ticket-provider.sh");
    if (!existsSync3(dispatcher)) {
      details.push(`agents.${declared.agentId} provider dispatcher ${relative2(ctx.repoRoot, dispatcher)} missing`);
    }
    const provider = join4(roleDir, ".scripts", "providers", `${roleYaml.providerName}.sh`);
    if (!existsSync3(provider)) {
      details.push(`agents.${declared.agentId} provider script ${relative2(ctx.repoRoot, provider)} missing`);
    }
  }
  return { valid: details.length === 0, role: roleYaml.role, agentId: roleYaml.agentId, roleDir, details };
}
function boolSetting(value, fallback2) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback2;
}
function numberSetting(value, fallback2) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback2;
}
function canonicalProjectJson(ctx) {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = typeof existing.project_slug === "string" && existing.project_slug ? existing.project_slug : slugifyRepoName(basename2(ctx.repoRoot));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String((existing.ticket_provider?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String((existing.ticket_provider?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String((existing.ticket_provider?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String((existing.ticket_provider?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    state: String((existing.ticket_provider?.state ?? (firstRole?.ticketProviderBoardId ? "linked" : "planned")) || "planned")
  };
  if (ticketProvider.board_id && ticketProvider.state === "planned") ticketProvider.state = "linked";
  const existingAgents = existing.agents ?? {};
  const discoveredAgents = Object.fromEntries(
    roles.map((role) => [
      role.agentId || `${slug}-${role.role}`,
      {
        role: role.role,
        role_dir: relative2(ctx.repoRoot, role.roleDir)
      }
    ])
  );
  const agents = Object.fromEntries(
    Object.entries(discoveredAgents).map(([agentId, discovered]) => {
      const existingAgent = existingAgents[agentId] ?? {};
      const extras = Object.fromEntries(Object.entries(existingAgent).filter(([key]) => key !== "role" && key !== "role_dir"));
      return [agentId, { role: discovered.role, role_dir: discovered.role_dir, ...extras }];
    })
  );
  const dropped = [];
  const unprovisioned = [];
  for (const [declaredAgentId, entry] of Object.entries(existingAgents)) {
    const declared = {
      agentId: declaredAgentId,
      role: typeof entry.role === "string" ? entry.role : void 0,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : void 0,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir"))
    };
    if (declaredRoleIsUnprovisioned(ctx.repoRoot, declared.roleDir)) {
      agents[declaredAgentId] = { ...entry };
      unprovisioned.push(declaredAgentId);
      continue;
    }
    const validated = validateDeclaredAgent(ctx, declared);
    if (!validated.valid || !validated.role || !validated.agentId || !validated.roleDir) {
      dropped.push(declaredAgentId);
      continue;
    }
    agents[validated.agentId] = {
      role: validated.role,
      role_dir: relative2(ctx.repoRoot, validated.roleDir),
      ...declared.extras
    };
  }
  const existingAutomation = existing.automation ?? {};
  const existingReconcile = existingAutomation.reconcile ?? {};
  const legacyEnabled = roles.find((role) => role.legacyReconcileEnabled)?.legacyReconcileEnabled;
  const legacyGrace = roles.find((role) => role.legacyReconcileGraceHours || role.legacyScrumGraceHours);
  const legacyAutoReview = roles.find((role) => role.legacyReconcileAutoReview || role.legacyScrumAutoReview);
  const automation = {
    ...existingAutomation,
    reconcile: {
      enabled: boolSetting(existingReconcile.enabled, boolSetting(legacyEnabled, false)),
      grace_hours: numberSetting(existingReconcile.grace_hours, numberSetting(legacyGrace?.legacyReconcileGraceHours || legacyGrace?.legacyScrumGraceHours, 0)),
      auto_review: boolSetting(existingReconcile.auto_review, boolSetting(legacyAutoReview?.legacyReconcileAutoReview || legacyAutoReview?.legacyScrumAutoReview, true))
    }
  };
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_slug: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents,
    automation,
    dropped,
    unprovisioned
  };
}
function projectJsonFinding(ctx) {
  const projectPath = join4(ctx.repoRoot, ".project.json");
  const planeJsonPath = join4(ctx.repoRoot, ".plane.json");
  const details = [];
  const data = readProjectJson(ctx);
  const roles = discoverRoles(ctx.repoRoot);
  if (!existsSync3(projectPath)) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json missing", details: [], fixable: true };
  }
  if (!data) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json is not valid JSON", details: [], fixable: true };
  }
  for (const key of ["project_name", "project_description", "project_slug", "repo_path", "ticket_provider", "agents", "automation"]) {
    if (!(key in data)) details.push(`missing key: ${key}`);
  }
  if (data.repo_path !== ctx.repoRoot) details.push(`repo_path should be ${ctx.repoRoot}`);
  const agents = data.agents ?? {};
  for (const role of roles) {
    const agent = agents[role.agentId];
    if (!agent) {
      details.push(`agents.${role.agentId} missing`);
      continue;
    }
    if (agent.role !== role.role) details.push(`agents.${role.agentId}.role should be ${role.role}`);
    if (agent.role_dir !== relative2(ctx.repoRoot, role.roleDir)) {
      details.push(`agents.${role.agentId}.role_dir should be ${relative2(ctx.repoRoot, role.roleDir)}`);
    }
  }
  const declaredAgents = readDeclaredAgents(ctx);
  let unprovisionedDeclarations = 0;
  for (const declared of declaredAgents) {
    const declaredDetails = validateDeclaredAgent(ctx, declared).details;
    if (declaredRoleIsUnprovisioned(ctx.repoRoot, declared.roleDir)) {
      unprovisionedDeclarations += declaredDetails.length;
      details.push(
        ...declaredDetails.map((detail) => `${detail}; provision or restore the role, do not delete its declaration`)
      );
      continue;
    }
    details.push(...declaredDetails);
  }
  const ticketProvider = data.ticket_provider ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id", "state"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if ("board_url" in ticketProvider) details.push("ticket_provider.board_url should be removed; derive it from provider/workspace/board_id");
  if (!ticketProvider.board_id && roles.some((role) => role.ticketProviderBoardId)) {
    details.push("ticket_provider.board_id missing even though legacy role.yaml contains a board binding");
  }
  const automation = data.automation ?? {};
  const reconcile = automation.reconcile ?? {};
  for (const key of ["enabled", "grace_hours", "auto_review"]) {
    if (!(key in reconcile)) details.push(`automation.reconcile.${key} missing`);
  }
  if (existsSync3(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
  return {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: details.length === 0 ? "pass" : "fail",
    summary: details.length === 0 ? ".project.json matches canonical parity contract" : `${details.length} parity issue(s) detected`,
    details,
    fixable: details.length > unprovisionedDeclarations
  };
}
function renderSoul(role) {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm" ? `Direct and brief. Decision-forward. No throat-clearing, no apologies, no "I'll help you with that" preambles.` : "Direct and brief.";
  const roleSpecific = role.role === "pm" ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checks runtime health; when this repo opts into reconciliation (\`automation.reconcile.enabled\` in repo-root \`.project.json\`), the same heartbeat also runs your continuous board-reconciliation pass out-of-band (\`.scripts/sentinel.prompt.md\`, \`--source cron\`), kept separate from your interactive session memory.` : `You operate as the ${role.role} agent for this repo.`;
  return `# ${role.displayName || role.agentId}

You are **${role.displayName || role.agentId}** \u2014 a Hermes agent provisioned to work inside the
\`${role.repo}\` repository.

## Identity

| | |
| --- | --- |
| Agent ID | \`${role.agentId}\` |
| Profile | \`${role.profileName || role.agentId}\` |
| Repo | \`${role.repo}\` |
| Role | \`${role.role}\` |
| Telegram | \`${telegram}\` |
| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |

## Scope

You operate only within the working directory of \`${role.repo}\`. HERMES_HOME is the real named profile at \`~/.hermes/profiles/${role.profileName || role.agentId}\`; shared config/auth/skills remain linked to fleet truth while owned state lives in ignored \`./runtime/\`. The launcher supplies the project root through process-local \`TERMINAL_CWD\` and never persists it into shared config.

## Tone

${tone}

## Role-specific behavior

${roleSpecific}

## Memory hygiene

Your memory is stored locally at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.
`;
}
function renderHermesWrapper(role, templateRoleDir) {
  return readText(join4(templateRoleDir, "hermes.jinja")).replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId);
}
function templateFiles(sourceDir, current = sourceDir) {
  if (!existsSync3(current)) return [];
  const files = [];
  for (const entry of readdirSync2(current, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    const sourcePath = join4(current, entry.name);
    if (entry.isDirectory()) files.push(...templateFiles(sourceDir, sourcePath));
    else if (entry.isFile()) files.push(relative2(sourceDir, sourcePath));
  }
  return files.sort();
}
function managedHermesScaffoldRoles(ctx) {
  const discovered = discoverRoles(ctx.repoRoot);
  const declared = readDeclaredAgents(ctx).filter((entry) => entry.role === "pm" || entry.role === "director");
  if (declared.length === 0) {
    const orchestrators = discovered.filter((role) => role.role === "pm" || role.role === "director");
    const blockers2 = orchestrators.filter((role) => roleBloodbankEnabled(role) === null).map((role) => `${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
    return {
      roles: orchestrators.filter((role) => roleBloodbankEnabled(role) !== null),
      blockers: blockers2
    };
  }
  const roles = [];
  const blockers = [];
  for (const entry of declared) {
    if (!entry.roleDir) {
      blockers.push(`agents.${entry.agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve3(ctx.repoRoot, entry.roleDir);
    if (!isContainedBy(ctx.repoRoot, roleDir)) {
      blockers.push(`agents.${entry.agentId}.role_dir resolves outside the project`);
      continue;
    }
    const role = discovered.find((candidate) => resolve3(candidate.roleDir) === roleDir);
    if (!role) {
      blockers.push(`agents.${entry.agentId}.role_dir ${entry.roleDir} missing role.yaml`);
      continue;
    }
    if (role.agentId !== entry.agentId || role.role !== entry.role) {
      blockers.push(`agents.${entry.agentId} identity does not match ${entry.roleDir}/role.yaml`);
      continue;
    }
    if (roleBloodbankEnabled(role) === null) {
      blockers.push(`${entry.roleDir}/role.yaml bloodbank.enabled must be the strict YAML boolean true or false`);
      continue;
    }
    roles.push(role);
  }
  return { roles, blockers };
}
function renderSentinelPrompt(role, templateRoleDir) {
  return readText(join4(templateRoleDir, ".scripts", "sentinel.prompt.md.jinja")).replace(/\{\{\s*agent_id\s*\}\}/g, role.agentId).replace(/\{\{\s*role\s*\}\}/g, role.role).replace(/\{\{\s*target_repo\s*\}\}/g, role.repo).replace(/\{\{\s*display_name\s*\}\}/g, role.displayName || role.agentId).replace(/\{\{\s*ticket_provider\s*\}\}/g, role.ticketProviderName || "plane");
}
function copyMissingRecursive(sourceDir, targetDir, changedFiles, dryRun, skip) {
  if (!existsSync3(sourceDir)) return;
  mkdirSync3(targetDir, { recursive: true });
  for (const entry of readdirSync2(sourceDir, { withFileTypes: true })) {
    const sourcePath = join4(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join4(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync3(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}
function runtimeSubmodulePath(repoRoot, role) {
  const rolePath = relative2(repoRoot, role.roleDir).replace(/\\/g, "/");
  if (!/^agents\/hermes\/[^/]+$/.test(rolePath)) return null;
  return `${rolePath}/runtime`;
}
function submoduleSectionHasPath(section2, targetPath) {
  return section2.split(/\r?\n/).some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}
function hasRuntimeSubmoduleMapping(repoRoot, role) {
  const gitmodulesPath = join4(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  const sections = current.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  return Boolean(targetPath && sections.some((section2) => submoduleSectionHasPath(section2, targetPath)));
}
function removeRuntimeSubmoduleMapping(repoRoot, role, changedFiles, dryRun) {
  const gitmodulesPath = join4(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  if (!hasRuntimeSubmoduleMapping(repoRoot, role)) return [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  if (!targetPath) return [];
  const next = current.replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section2) => submoduleSectionHasPath(section2, targetPath) ? "" : section2).replace(/\n{3,}/g, "\n\n").trim();
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, next ? `${next}
` : "");
  return [gitmodulesPath];
}
function retireRuntimeSubmodule(repoRoot, role, changedFiles, dryRun) {
  const runtimePath = runtimeSubmodulePath(repoRoot, role);
  if (!runtimePath) {
    return { ok: false, details: [], error: `refusing unsafe runtime path for ${role.roleDir}` };
  }
  const probe = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (probe.status !== 0) {
    return { ok: false, details: [], error: `failed to inspect runtime index at ${runtimePath}: ${probe.stderr.trim() || `exit ${probe.status}`}` };
  }
  const details = [];
  if (probe.stdout.trim()) {
    details.push(`untrack ${runtimePath}`);
    if (dryRun) {
      changedFiles.push(runtimePath);
    } else {
      const removal = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      if (removal.status !== 0) {
        return { ok: false, details, error: `failed to untrack ${runtimePath}: ${removal.stderr.trim() || `exit ${removal.status}`}` };
      }
      const verification = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      if (verification.status !== 0 || verification.stdout.trim()) {
        return {
          ok: false,
          details,
          error: verification.status !== 0 ? `failed to verify untracked runtime ${runtimePath}: ${verification.stderr.trim() || `exit ${verification.status}`}` : `runtime remains tracked after index-only removal: ${runtimePath}`
        };
      }
      changedFiles.push(runtimePath);
    }
  }
  if (hasRuntimeSubmoduleMapping(repoRoot, role)) {
    details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
    removeRuntimeSubmoduleMapping(repoRoot, role, changedFiles, dryRun);
  }
  return { ok: true, details };
}
function upsertRegistryEntry(role, homeDir, changedFiles, dryRun) {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const enabled2 = roleBloodbankEnabled(role);
  if (enabled2 === null) return null;
  const block = `  ${role.agentId}:
    repo: ${role.repo}
    role: ${role.role}
    display_name: ${JSON.stringify(role.displayName || role.agentId)}
    project_path: ${ctxEscape(role.roleDir ? dirname3(dirname3(dirname3(role.roleDir))) : "")}
    role_dir: ${ctxEscape(role.roleDir)}
    profile_name: ${role.profileName || role.agentId}
    telegram:
      bot_username: ${ctxEscape(role.botHandle)}
    plane:
      workspace: ${ctxEscape(role.planeWorkspace)}
      project_id: ${ctxEscape(role.ticketProviderBoardId)}
      identifier: ${ctxEscape(role.ticketProviderIdentifier)}
    runtime_repo: ${ctxEscape(role.runtimeRepo)}
    bloodbank:
      enabled: ${enabled2 ? "true" : "false"}
      gateway_scope: fleet
      target_agent_id: ${role.agentId}
    systemd:
      gateway_unit: hermes-${role.agentId}-gateway.service
      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer
`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:
${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function roleBloodbankEnabled(role) {
  if (role.bloodbankEnabled === "" || role.bloodbankEnabled === "false") return false;
  if (role.bloodbankEnabled === "true") return true;
  return null;
}
function profileMetaInheritsDefault(path) {
  const text3 = safeReadText(path);
  return Boolean(
    text3 && /^config:\s*$/m.test(text3) && /^\s+inherit_from:\s*default\s*$/m.test(text3) && /^\s+save_mode:\s*delta\s*$/m.test(text3)
  );
}
function upsertInheritedProfileMeta(path, changedFiles, dryRun) {
  const current = safeReadText(path) ?? "";
  const lines = current.split("\n");
  let next;
  const start = lines.findIndex((line) => /^config:\s*$/.test(line));
  if (!current.trim()) {
    next = "config:\n  inherit_from: default\n  save_mode: delta\n";
  } else if (start === -1) {
    next = `${current.replace(/\s*$/, "\n")}config:
  inherit_from: default
  save_mode: delta
`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^[^#\s][^:]*:\s*/.test(lines[end] ?? "")) end++;
    let hasInherit = false;
    let hasSave = false;
    for (let idx = start + 1; idx < end; idx++) {
      if (/^\s+inherit_from:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  inherit_from: default";
        hasInherit = true;
      } else if (/^\s+save_mode:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  save_mode: delta";
        hasSave = true;
      }
    }
    const inserts = [];
    if (!hasInherit) inserts.push("  inherit_from: default");
    if (!hasSave) inserts.push("  save_mode: delta");
    if (inserts.length) lines.splice(end, 0, ...inserts);
    next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }
  if (next === current) return null;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function ctxEscape(value) {
  return JSON.stringify(value || "");
}
function checkUnit(unit) {
  const enabled2 = systemctlUser(["is-enabled", unit]).ok;
  const active = systemctlUser(["is-active", unit]).ok;
  return { enabled: enabled2, active };
}
var BMAD_NPM_PACKAGE = "bmad-method";
var BMAD_INSTALLER_VERSION = "6.11.1-next.1";
var BMAD_TARGET_CHANNEL = "next";
var BMAD_DIST_TAGS_TTL_MS = 60 * 60 * 1e3;
var DEFAULT_BMAD_MODULES = ["bmm", "bmb", "cis"];
var BMAD_INSTALL_TOOLS = SUPPORTED_BMAD_TOOLS;
function manifestBmadModules(repoRoot) {
  const manifestPath = join4(repoRoot, "_bmad", "_config", "manifest.yaml");
  const raw = safeReadText(manifestPath);
  if (raw === null) return { status: "absent" };
  try {
    const parsed = YAML.parse(raw);
    if (!Array.isArray(parsed?.modules)) {
      return { status: "invalid", error: `${manifestPath} must define a modules array` };
    }
    const declared = [];
    for (const entry of parsed.modules) {
      const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.name : void 0;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        return { status: "invalid", error: `${manifestPath} contains an invalid module entry` };
      }
      if (name !== "core" && name !== "custom") declared.push(name);
    }
    return { status: "valid", modules: Array.from(new Set(declared)) };
  } catch (error) {
    return {
      status: "invalid",
      error: `Could not parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function configuredBmadModules(repoRoot) {
  const raw = safeReadText(join4(repoRoot, "_bmad", "config.toml"));
  if (raw === null) return void 0;
  const modules = [...raw.matchAll(/^\[modules\.([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*$/gm)].map((match) => match[1]);
  return Array.from(new Set(modules));
}
function selectedBmadModules(repoRoot) {
  const manifest = manifestBmadModules(repoRoot);
  if (manifest.status === "valid") return manifest.modules;
  if (manifest.status === "invalid") throw new Error(manifest.error);
  return configuredBmadModules(repoRoot) ?? [...DEFAULT_BMAD_MODULES];
}
function requiredBmadSentinels(repoRoot, modules = selectedBmadModules(repoRoot)) {
  return [
    join4("core", "config.yaml"),
    join4("config.toml"),
    join4("_config", "manifest.yaml"),
    ...modules.map((module) => join4(module, "config.yaml"))
  ];
}
function canonicalBmadProjectName(repoRoot) {
  const project = readProjectJson({ repoRoot });
  const declared = typeof project?.project_name === "string" ? project.project_name.trim() : "";
  return declared || basename2(repoRoot);
}
function bmadProjectNameIssues(repoRoot) {
  const expected = canonicalBmadProjectName(repoRoot);
  const paths = [];
  const details = [];
  const configToml = join4(repoRoot, "_bmad", "config.toml");
  const tomlText = safeReadText(configToml);
  const tomlMatch = tomlText?.match(/^project_name\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m);
  let tomlName;
  if (tomlMatch) {
    try {
      tomlName = JSON.parse(`"${tomlMatch[1]}"`);
    } catch {
      tomlName = void 0;
    }
  }
  if (tomlName !== expected) {
    paths.push(configToml);
    details.push(`_bmad/config.toml project_name must be ${JSON.stringify(expected)}`);
  }
  const bmadRoot = join4(repoRoot, "_bmad");
  if (existsSync3(bmadRoot)) {
    let declared;
    try {
      declared = selectedBmadModules(repoRoot);
    } catch {
      declared = readdirSync2(bmadRoot);
    }
    for (const name of new Set(declared)) {
      const configPath = join4(bmadRoot, name, "config.yaml");
      const raw = safeReadText(configPath);
      if (raw === null) continue;
      let actual;
      try {
        actual = YAML.parse(raw)?.project_name;
      } catch {
        actual = void 0;
      }
      if (actual !== expected) {
        paths.push(configPath);
        details.push(`_bmad/${name}/config.yaml project_name must be ${JSON.stringify(expected)}`);
      }
    }
  }
  return { paths: [...new Set(paths)].sort(), details };
}
function evictLegacyBmadPackState(ctx, changedFiles) {
  const details = [];
  const skillDirs = [
    join4(ctx.repoRoot, ".agents", "skills"),
    ...SUPPORTED_CLI_ROOTS.map((root) => join4(ctx.repoRoot, root, "skills"))
  ];
  for (const dir of skillDirs) {
    const dirStat = lstatIfPresent(dir);
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    let names;
    try {
      names = readdirSync2(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(BMAD_SKILL_NAME_PREFIX)) continue;
      const path = join4(dir, name);
      if (!lstatIfPresent(path)?.isSymbolicLink()) continue;
      changedFiles.push(path);
      details.push(`removed retired BMAD pack symlink ${relative2(ctx.repoRoot, path)}`);
      if (!ctx.dryRun) unlinkSync(path);
    }
  }
  return details;
}
function bmadInstallerInvocation(version = BMAD_INSTALLER_VERSION) {
  const explicit = process.env.PJ_BMAD_INSTALLER?.trim();
  if (explicit) return { command: resolve3(explicit), prefixArgs: [] };
  return {
    command: "npx",
    prefixArgs: ["-y", `${BMAD_NPM_PACKAGE}@${version}`]
  };
}
function bmadInstallerArgs(repoRoot, modules = selectedBmadModules(repoRoot)) {
  const installerModules = modules.length ? modules.join(",") : "core";
  return [
    "install",
    "--yes",
    "--directory",
    repoRoot,
    "--modules",
    installerModules,
    "--tools",
    BMAD_INSTALL_TOOLS.join(","),
    "--set",
    `core.project_name=${canonicalBmadProjectName(repoRoot)}`
  ];
}
function bmadInstallDisplay(repoRoot, modules = selectedBmadModules(repoRoot), version = BMAD_INSTALLER_VERSION) {
  const invocation = bmadInstallerInvocation(version);
  return [invocation.command, ...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)].join(" ").replace(BMAD_INSTALL_TOOLS.join(","), "...");
}
function preflightBmadLifecycle(_ctx) {
  const invocation = bmadInstallerInvocation();
  const probe = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: 3e4
  });
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || probe.error?.message || "installer probe failed").trim();
    return {
      ok: false,
      error: `Pinned BMAD installer ${BMAD_NPM_PACKAGE}@${BMAD_INSTALLER_VERSION} is unavailable: ${detail}`
    };
  }
  const versionOutput = `${probe.stdout ?? ""}
${probe.stderr ?? ""}`;
  const reportedVersions = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [];
  if (!reportedVersions.includes(BMAD_INSTALLER_VERSION)) {
    return {
      ok: false,
      error: `BMAD installer version mismatch: expected ${BMAD_INSTALLER_VERSION}, received ${versionOutput.trim() || "no version output"}`
    };
  }
  return { ok: true };
}
function runBmadInstall(repoRoot, modules = selectedBmadModules(repoRoot), version = BMAD_INSTALLER_VERSION) {
  const invocation = bmadInstallerInvocation(version);
  const result2 = spawnSync(invocation.command, [...invocation.prefixArgs, ...bmadInstallerArgs(repoRoot, modules)], { encoding: "utf8" });
  if (result2.status !== 0) {
    return { ok: false, error: result2.stderr || result2.error?.message || "Unknown error" };
  }
  return { ok: true };
}
function readInstalledBmadVersion(repoRoot) {
  const raw = safeReadText(join4(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return void 0;
  try {
    const parsed = YAML.parse(raw);
    const version = parsed?.installation?.version;
    return typeof version === "string" && version.trim() ? version.trim() : void 0;
  } catch {
    return void 0;
  }
}
function bmadCachePath(homeDir) {
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join4(homeDir, ".cache");
  return join4(cacheRoot, "pjangler", "bmad-dist-tags.json");
}
function readBmadDistTagsCache(homeDir) {
  const raw = safeReadText(bmadCachePath(homeDir));
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.fetchedAt === "number" && parsed.distTags && typeof parsed.distTags === "object") {
      return parsed;
    }
  } catch {
  }
  return void 0;
}
function fetchBmadDistTags() {
  const result2 = spawnSync("npm", ["view", BMAD_NPM_PACKAGE, "dist-tags", "--json"], {
    encoding: "utf8",
    timeout: 8e3
  });
  if (result2.status !== 0 || !result2.stdout.trim()) return void 0;
  try {
    const parsed = JSON.parse(result2.stdout);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") return void 0;
    const tags = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") tags[key] = value;
    }
    return Object.keys(tags).length ? tags : void 0;
  } catch {
    return void 0;
  }
}
function resolveBmadDistTags(homeDir) {
  const cached = readBmadDistTagsCache(homeDir);
  if (cached && Date.now() - cached.fetchedAt < BMAD_DIST_TAGS_TTL_MS) {
    return { distTags: cached.distTags, stale: false };
  }
  const fetched = fetchBmadDistTags();
  if (fetched) {
    try {
      const path = bmadCachePath(homeDir);
      mkdirSync3(dirname3(path), { recursive: true });
      writeFileSync3(path, JSON.stringify({ fetchedAt: Date.now(), distTags: fetched }, null, 2));
    } catch {
    }
    return { distTags: fetched, stale: false };
  }
  if (cached) return { distTags: cached.distTags, stale: true };
  return void 0;
}
function compareBmadVersions(a, b) {
  const parse4 = (v) => {
    const [core = "0", pre = ""] = v.replace(/^v/, "").split("-", 2);
    const parts = core.split(".");
    const n = (i) => parseInt(parts[i] ?? "0", 10) || 0;
    return { nums: [n(0), n(1), n(2)], pre };
  };
  const pa = parse4(a);
  const pb = parse4(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const ida = pa.pre.split(".");
  const idb = pb.pre.split(".");
  for (let i = 0; i < Math.max(ida.length, idb.length); i++) {
    const xa = ida[i];
    const xb = idb[i];
    if (xa === void 0) return -1;
    if (xb === void 0) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}
var SHARED_PROFILE_ENTRIES = [".env", "skills"];
var PROFILE_RENDER_MARKER = "GENERATED FILE -- DO NOT EDIT";
var OWNED_PROFILE_ENTRIES = [
  "memories",
  "sessions",
  "workspace",
  "logs",
  "cron",
  "plans",
  "hooks",
  "pairing",
  "audio_cache",
  "image_cache"
];
var OWNED_PROFILE_FILES = ["SOUL.md", "state.db", "kanban.db"];
function fleetHome(ctx) {
  return process.env.HERMES_FLEET_HOME || join4(ctx.homeDir, ".hermes");
}
function fleetBinPath(ctx) {
  const candidates = [
    process.env.HERMES_FLEET_BIN,
    join4(fleetHome(ctx), "hermes-agent", ".venv", "bin", "hermes"),
    join4(fleetHome(ctx), "hermes-agent", "venv", "bin", "hermes"),
    join4(ctx.homeDir, ".local", "bin", "hermes")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync3(candidate)) ?? "";
}
function singletonPlan(ctx, role) {
  const fleetRoot = fleetHome(ctx);
  const profileName = role.profileName || role.agentId;
  const profileDir = join4(fleetRoot, "profiles", profileName);
  const runtimeDir = join4(role.roleDir, "runtime");
  const links = [];
  for (const entry of SHARED_PROFILE_ENTRIES) {
    links.push({ path: join4(profileDir, entry), target: join4(fleetRoot, entry), ensureTargetDir: entry === "skills" });
  }
  for (const entry of OWNED_PROFILE_ENTRIES) {
    links.push({ path: join4(profileDir, entry), target: join4(runtimeDir, entry), ensureTargetDir: true });
  }
  for (const entry of OWNED_PROFILE_FILES) {
    links.push({ path: join4(profileDir, entry), target: join4(runtimeDir, entry), ensureTargetDir: false });
  }
  const sharedSeeds = ["config.yaml", "auth.json", ".env"].map((entry) => ({
    rootPath: join4(fleetRoot, entry),
    runtimePath: join4(runtimeDir, entry)
  }));
  return { fleetRoot, profileDir, runtimeDir, links, sharedSeeds };
}
function profileNameOf(role) {
  return role.profileName || role.agentId;
}
function profileRendererPath(ctx) {
  const candidates = [
    join4(ctx.repoRoot, "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join4(ctx.repoRoot, "..", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join4(homedir3(), "code", "33GOD", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join4(ctx.pjanglerRoot, "templates", "hermes-agent", "scripts", "hermes-profile-config.py")
  ];
  for (const c of candidates) {
    if (existsSync3(c)) return resolve3(c);
  }
  return null;
}
function profileConfigFindings(profileDir, profileName) {
  const out = [];
  const cfg = join4(profileDir, "config.yaml");
  const delta = join4(profileDir, "config.delta.yaml");
  if (!existsSync3(cfg)) {
    out.push(`profile config missing (run hermes-profile-config.py render): ${cfg}`);
  } else if (lstatSync2(cfg).isSymbolicLink()) {
    out.push(`config.yaml is a symlink \u2014 it detaches on the first Hermes write; render it instead: ${cfg}`);
  } else {
    let head = "";
    try {
      head = readFileSync2(cfg, "utf8").slice(0, 800);
    } catch {
    }
    if (!head.includes(PROFILE_RENDER_MARKER)) {
      out.push(`config.yaml is not a rendered artifact (missing generated header) \u2014 likely a hand-forked copy that will drift: ${cfg}`);
    }
  }
  if (!existsSync3(delta)) {
    out.push(`config.delta.yaml missing \u2014 profile is not under base+delta inheritance: ${delta}`);
  } else if (lstatSync2(delta).isSymbolicLink()) {
    out.push(`config.delta.yaml must be a real file, not a symlink: ${delta}`);
  }
  const memCfg = join4(profileDir, "hindsight", "config.json");
  const wantBank = `agent-${profileName}`;
  if (!existsSync3(memCfg)) {
    out.push(`identity-memory bank not pinned (expected bank_id "${wantBank}"): ${memCfg}`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync2(memCfg, "utf8"));
      const got = typeof parsed.bank_id === "string" ? parsed.bank_id : "";
      if (got !== wantBank) {
        out.push(`identity-memory bank_id is ${got ? `"${got}"` : "unset"}, expected "${wantBank}": ${memCfg}`);
      }
    } catch {
      out.push(`identity-memory pin is unparseable JSON: ${memCfg}`);
    }
  }
  return out;
}
function isDanglingLink(path) {
  try {
    return lstatSync2(path).isSymbolicLink() && !existsSync3(path);
  } catch {
    return false;
  }
}
function linkState(path, target) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "not-a-symlink";
  try {
    return readlinkSync(path) === target ? "ok" : "wrong-target";
  } catch {
    return "wrong-target";
  }
}
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function profileUnits(role) {
  return [
    `hermes-${role.agentId}-gateway.service`,
    `hermes-${role.agentId}-heartbeat.service`,
    `hermes-${role.agentId}-heartbeat.timer`,
    `hermes-${role.agentId}-checkpoint.service`
  ];
}
function readRegistry(registryPath2) {
  const raw = safeReadText(registryPath2);
  if (raw === null) return null;
  try {
    const doc = YAML.parse(raw);
    return doc?.agents ?? {};
  } catch {
    return null;
  }
}
function declaredAgentIds(repoRoot) {
  return declaredAgentEntries(repoRoot).map(([agentId]) => agentId);
}
function declaredAgentEntries(repoRoot) {
  const raw = safeReadText(join4(repoRoot, ".project.json"));
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw);
    return Object.entries(doc.agents ?? {}).map(([agentId, entry]) => [agentId, entry ?? {}]);
  } catch {
    return [];
  }
}
function ownedRegistryEntries(registry, repoRoot) {
  const want = realOrSelf(repoRoot);
  const owned = [];
  for (const [agentId, raw] of Object.entries(registry)) {
    const entry = raw ?? {};
    const roleDir = String(entry.role_dir ?? "");
    if (!roleDir) continue;
    if (realOrSelf(dirname3(dirname3(dirname3(roleDir)))) !== want) continue;
    owned.push([agentId, entry]);
  }
  return owned;
}
function unprovisionedRoleAgents(registry, repoRoot, canonical) {
  const blockers = /* @__PURE__ */ new Map();
  const record = (agentId, roleDir, source) => {
    const current = blockers.get(agentId) ?? { roleDir, sources: /* @__PURE__ */ new Set() };
    if (!current.roleDir && roleDir) current.roleDir = roleDir;
    current.sources.add(source);
    blockers.set(agentId, current);
  };
  for (const [agentId, entry] of ownedRegistryEntries(registry, repoRoot)) {
    if (canonical.has(agentId)) continue;
    const roleDir = String(entry.role_dir ?? "");
    if (declaredRoleIsUnprovisioned(repoRoot, roleDir)) record(agentId, roleDir, "registry");
  }
  for (const [agentId, entry] of declaredAgentEntries(repoRoot)) {
    if (canonical.has(agentId)) continue;
    const configured = String(entry.role_dir ?? "");
    const roleDir = configured ? resolve3(repoRoot, configured) : "";
    if (declaredRoleIsUnprovisioned(repoRoot, configured)) record(agentId, roleDir, ".project.json");
  }
  return [...blockers.entries()].map(([agentId, value]) => ({
    agentId,
    roleDir: value.roleDir,
    sources: [...value.sources]
  }));
}
function dropDeclaredAgent(ctx, agentId, changedFiles, details) {
  const path = join4(ctx.repoRoot, ".project.json");
  const raw = safeReadText(path);
  if (raw === null) return;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!doc.agents || !(agentId in doc.agents)) return;
  delete doc.agents[agentId];
  details.push(`drop agent "${agentId}" from .project.json`);
  changedFiles.push(path);
  if (!ctx.dryRun) writeText(path, `${JSON.stringify(doc, null, 2)}
`);
}
function isProfileHomeExpr(assigned) {
  const bare = assigned.replace(/^["']|["']$/g, "");
  return bare === "$FLEET_HOME/profiles/$PROFILE_NAME" || /^\$\{?HERMES_FLEET_HOME.*\}?\/profiles\//.test(bare) || /\/\.hermes\/profiles\/[^/]+$/.test(bare);
}
function rewriteLauncher(text3, profileName) {
  let next = text3;
  const assigned = /^HERMES_HOME=(.*)$/m.exec(next)?.[1]?.trim();
  if (assigned !== void 0 && !isProfileHomeExpr(assigned)) {
    const name = profileName ? `\${HERMES_PROFILE_NAME:-${profileName}}` : '${HERMES_PROFILE_NAME:-$(basename "$ROLE_DIR")}';
    next = next.replace(
      /^HERMES_HOME=(.*)$/m,
      [
        `RUNTIME_HOME=$1`,
        `FLEET_HOME="\${HERMES_FLEET_HOME:-$HOME/.hermes}"`,
        `PROFILE_NAME="${name}"`,
        `# Singleton-runtime contract: HERMES_HOME MUST be the named profile dir.`,
        `HERMES_HOME="$FLEET_HOME/profiles/$PROFILE_NAME"`
      ].join("\n")
    );
    next = next.replace(
      /if \[\[ ! -d "\$HERMES_HOME" \]\]; then\n(\s*)echo "hermes: local runtime not provisioned at \$HERMES_HOME"/,
      'if [[ ! -d "$RUNTIME_HOME" ]]; then\n$1echo "hermes: local runtime not provisioned at $RUNTIME_HOME"'
    );
  }
  next = next.replace(/^HERMES_OAUTH_FILE=.*\n/m, "");
  next = next.replace(/\s*HERMES_OAUTH_FILE="\$HERMES_OAUTH_FILE"/g, "");
  next = next.replace(
    /^.*\/home\/delorenj\/code\/hermes-agent\/\.venv\/bin\/hermes.*$/m,
    (line) => line.replace("/home/delorenj/code/hermes-agent/.venv/bin/hermes", "$HOME/.hermes/hermes-agent/.venv/bin/hermes")
  );
  return next;
}
function discoverMomoProviderCandidates(repoRoot) {
  const candidates = [];
  const roleDirs = [];
  const hermesDir = join4(repoRoot, "agents", "hermes");
  if (existsSync3(hermesDir)) {
    for (const entry of readdirSync2(hermesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roleDirs.push(join4(hermesDir, entry.name));
    }
  }
  for (const roleDir of roleDirs) {
    for (const name of ["momo", "provider", "momo-provider"]) {
      const path = join4(roleDir, name);
      if (existsSync3(path)) {
        const kind = path.endsWith(".py") ? "python" : "shell";
        candidates.push({ path, kind });
      }
    }
    if (existsSync3(roleDir)) {
      for (const entry of readdirSync2(roleDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith("momo")) continue;
        const path = join4(roleDir, entry.name);
        try {
          if (lstatSync2(path).mode & 73) {
            const kind = entry.name.endsWith(".py") ? "python" : "shell";
            if (!candidates.some((c) => c.path === path)) candidates.push({ path, kind });
          }
        } catch {
        }
      }
    }
  }
  for (const rel of [".mise/scripts/momo-provider.sh", ".scripts/momo-provider.sh", "momo"]) {
    const path = join4(repoRoot, rel);
    if (existsSync3(path)) {
      const kind = path.endsWith(".py") ? "python" : "shell";
      if (!candidates.some((c) => c.path === path)) candidates.push({ path, kind });
    }
  }
  return candidates;
}
function firstMomoProvider(repoRoot) {
  return discoverMomoProviderCandidates(repoRoot)[0];
}
function checkProviderSyntax(candidate) {
  if (candidate.kind === "python") {
    const result2 = spawnSync("python3", ["-m", "py_compile", candidate.path], { encoding: "utf8" });
    if (result2.status !== 0) {
      return { ok: false, detail: `python3 -m py_compile failed: ${result2.stderr.trim() || result2.stdout.trim() || "syntax error"}` };
    }
    return { ok: true };
  }
  if (candidate.kind === "shell") {
    const result2 = spawnSync("bash", ["-n", candidate.path], { encoding: "utf8" });
    if (result2.status !== 0) {
      return { ok: false, detail: `bash -n failed: ${result2.stderr.trim() || result2.stdout.trim() || "syntax error"}` };
    }
    return { ok: true };
  }
  return { ok: true };
}
function runProviderLocalSmoke(repoRoot, candidate) {
  const result2 = spawnSync(candidate.path, ["--help"], { cwd: repoRoot, encoding: "utf8" });
  if (result2.status !== 0) {
    return { ok: false, detail: `${relative2(repoRoot, candidate.path)} --help exited ${result2.status}: ${result2.stderr.trim() || result2.stdout.trim()}` };
  }
  return { ok: true };
}
function attemptPlaneStateMapping(repoRoot) {
  const project = tryParseJson(safeReadText(join4(repoRoot, ".project.json")));
  const tp = project?.ticket_provider ?? {};
  if (!tp.board_id) return { ok: false, detail: "ticket_provider.board_id missing; cannot map Plane states" };
  return { ok: false, detail: `Plane state mapping attempted for board ${tp.board_id} (credentials required for full mapping)` };
}
function attemptNestedAdapterSmoke(repoRoot, candidate) {
  const result2 = spawnSync(candidate.path, ["--smoke", "nested"], { cwd: repoRoot, encoding: "utf8" });
  if (result2.status !== 0) {
    return { ok: false, detail: `${relative2(repoRoot, candidate.path)} --smoke nested exited ${result2.status}: ${result2.stderr.trim() || result2.stdout.trim()}` };
  }
  return { ok: true };
}
function momoLifecycleFinding(section2, status, summary, details = []) {
  return { section: section2, status, summary, details };
}
function auditManifestRoleConsistency(repoRoot) {
  const details = [];
  const projectPath = join4(repoRoot, ".project.json");
  if (!existsSync3(projectPath)) {
    return momoLifecycleFinding("manifest-role-consistency", "fail", ".project.json missing", [".project.json missing"]);
  }
  const project = tryParseJson(safeReadText(projectPath));
  if (!project) {
    return momoLifecycleFinding("manifest-role-consistency", "fail", ".project.json is invalid JSON", [".project.json is invalid JSON"]);
  }
  const agents = project.agents ?? {};
  const discovered = discoverRoles(repoRoot);
  const discoveredByAgentId = new Map(discovered.map((role) => [role.agentId, role]));
  const discoveredByDir = new Map(discovered.map((role) => [role.roleDir, role]));
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.role_dir) {
      details.push(`agents.${agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve3(repoRoot, agent.role_dir);
    if (!existsSync3(roleDir)) {
      details.push(`agents.${agentId}.role_dir does not exist: ${agent.role_dir}`);
      continue;
    }
    const roleYaml = join4(roleDir, "role.yaml");
    if (!existsSync3(roleYaml)) {
      details.push(`agents.${agentId} role.yaml missing at ${agent.role_dir}/role.yaml`);
      continue;
    }
    const discoveredRole = discoveredByDir.get(roleDir);
    if (!discoveredRole) {
      details.push(`agents.${agentId} role.yaml at ${agent.role_dir} could not be parsed`);
      continue;
    }
    if (discoveredRole.agentId !== agentId) {
      details.push(`agents.${agentId} role.yaml agent_id mismatch: ${discoveredRole.agentId}`);
    }
    if (discoveredRole.role !== agent.role) {
      details.push(`agents.${agentId} role.yaml role mismatch: expected ${agent.role}, got ${discoveredRole.role}`);
    }
  }
  for (const role of discovered) {
    if (!role.agentId) {
      details.push(`role.yaml at ${relative2(repoRoot, role.roleYamlPath)} missing agent_id`);
      continue;
    }
    if (!(role.agentId in agents)) {
      details.push(`role.yaml declares unregistered agent_id: ${role.agentId}`);
    }
  }
  if (Object.keys(agents).length === 0) {
    details.push("no agents declared in .project.json");
  }
  return details.length === 0 ? momoLifecycleFinding("manifest-role-consistency", "pass", "manifest and role declarations are consistent") : momoLifecycleFinding("manifest-role-consistency", "fail", `${details.length} manifest/role consistency issue(s)`, details);
}
function hasAnyLifecycleScript(repoRoot) {
  const patterns = [
    ".mise/scripts/lifecycle",
    ".scripts/lifecycle",
    "agents/hermes/*/lifecycle",
    "agents/hermes/*/.scripts/lifecycle",
    "agents/hermes/*/.scripts/migrate",
    ".mise/tasks/lifecycle"
  ];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*");
      const base = join4(repoRoot, prefix);
      if (!existsSync3(base)) continue;
      for (const entry of readdirSync2(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join4(base, entry.name, suffix);
        if (existsSync3(candidate)) return true;
        const parent = dirname3(candidate);
        const stem = basename2(candidate);
        if (!existsSync3(parent)) continue;
        for (const sibling of readdirSync2(parent, { withFileTypes: true })) {
          if (sibling.isFile() && sibling.name.startsWith(stem)) return true;
        }
      }
    } else {
      const base = join4(repoRoot, pattern);
      if (existsSync3(base)) return true;
      const parent = dirname3(base);
      const prefix = basename2(base);
      if (existsSync3(parent)) {
        for (const entry of readdirSync2(parent, { withFileTypes: true })) {
          if (entry.name.startsWith(prefix)) return true;
        }
      }
    }
  }
  return false;
}
function auditLifecycleScripts(repoRoot) {
  if (hasAnyLifecycleScript(repoRoot)) {
    return momoLifecycleFinding("lifecycle-scripts", "pass", "lifecycle scripts present");
  }
  return momoLifecycleFinding(
    "lifecycle-scripts",
    "fail",
    "lifecycle scripts missing",
    ["expected one of: .mise/scripts/lifecycle*, .scripts/lifecycle*, agents/hermes/<role>/lifecycle*, agents/hermes/<role>/.scripts/lifecycle*"]
  );
}
function hasAnySentinelScript(repoRoot) {
  const patterns = [
    "agents/hermes/*/.scripts/checkpoint.sh",
    "agents/hermes/*/.scripts/heartbeat.sh",
    "agents/hermes/*/.scripts/sentinel",
    "agents/hermes/*/sentinel.prompt.md",
    ".scripts/sentinel"
  ];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*");
      const base = join4(repoRoot, prefix);
      if (!existsSync3(base)) continue;
      for (const entry of readdirSync2(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join4(base, entry.name, suffix);
        if (existsSync3(candidate)) return true;
        const parent = dirname3(candidate);
        const stem = basename2(candidate);
        if (!existsSync3(parent)) continue;
        for (const sibling of readdirSync2(parent, { withFileTypes: true })) {
          if (sibling.isFile() && sibling.name.startsWith(stem)) return true;
        }
      }
    } else {
      const base = join4(repoRoot, pattern);
      if (existsSync3(base)) return true;
      const parent = dirname3(base);
      const prefix = basename2(base);
      if (existsSync3(parent)) {
        for (const entry of readdirSync2(parent, { withFileTypes: true })) {
          if (entry.name.startsWith(prefix)) return true;
        }
      }
    }
  }
  return false;
}
function auditSentinelScripts(repoRoot) {
  if (hasAnySentinelScript(repoRoot)) {
    return momoLifecycleFinding("sentinel-scripts", "pass", "sentinel scripts present");
  }
  return momoLifecycleFinding(
    "sentinel-scripts",
    "fail",
    "sentinel scripts missing",
    ["expected one of: agents/hermes/<role>/.scripts/{checkpoint.sh,heartbeat.sh,sentinel*}, agents/hermes/<role>/sentinel.prompt.md, .scripts/sentinel*"]
  );
}
function auditExecutableProvider(repoRoot) {
  const candidates = discoverMomoProviderCandidates(repoRoot);
  if (candidates.length === 0) {
    return momoLifecycleFinding(
      "executable-provider",
      "fail",
      "executable provider dispatcher missing",
      ["expected an executable agents/hermes/<role>/momo, agents/hermes/<role>/provider, or project-level momo-provider script"]
    );
  }
  const details = candidates.map((c) => relative2(repoRoot, c.path));
  return momoLifecycleFinding("executable-provider", "pass", `${candidates.length} provider dispatcher candidate(s)`, details);
}
function auditProviderSyntax(repoRoot) {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("provider-syntax", "skip", "no provider dispatcher to validate");
  }
  const syntax = checkProviderSyntax(candidate);
  if (!syntax.ok) {
    return momoLifecycleFinding("provider-syntax", "fail", `${relative2(repoRoot, candidate.path)} has syntax errors`, [syntax.detail ?? "syntax check failed"]);
  }
  return momoLifecycleFinding("provider-syntax", "pass", `${relative2(repoRoot, candidate.path)} syntax OK`);
}
function auditPlaneBinding(repoRoot) {
  const details = [];
  const project = tryParseJson(safeReadText(join4(repoRoot, ".project.json")));
  const tp = project?.ticket_provider ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id"]) {
    if (!tp[key]) details.push(`ticket_provider.${key} missing`);
  }
  const discovered = discoverRoles(repoRoot);
  for (const role of discovered) {
    if (!role.ticketProviderBoardId && !role.ticketProviderIdentifier) {
      details.push(`${relative2(repoRoot, role.roleYamlPath)} missing ticket_provider/plane binding`);
    }
  }
  if (details.length === 0) {
    return momoLifecycleFinding("plane-binding", "pass", "Plane ticket provider binding present");
  }
  return momoLifecycleFinding("plane-binding", "fail", `${details.length} Plane binding issue(s)`, details);
}
function auditPlaneStateMapping(repoRoot, live) {
  if (!live) {
    return momoLifecycleFinding("plane-state-mapping", "skip", "live check skipped (pass --live)", ["requires --live"]);
  }
  const result2 = attemptPlaneStateMapping(repoRoot);
  if (!result2.ok) {
    return momoLifecycleFinding("plane-state-mapping", "warn", "Plane state mapping attempted but incomplete", [result2.detail ?? "incomplete"]);
  }
  return momoLifecycleFinding("plane-state-mapping", "pass", "Plane state mapping verified");
}
function auditRootAdapterSmoke(repoRoot) {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("root-adapter-smoke", "skip", "no provider dispatcher to smoke-test");
  }
  const smoke = runProviderLocalSmoke(repoRoot, candidate);
  if (!smoke.ok) {
    return momoLifecycleFinding("root-adapter-smoke", "fail", "root adapter smoke test failed", [smoke.detail ?? "unknown error"]);
  }
  return momoLifecycleFinding("root-adapter-smoke", "pass", "root adapter smoke test passed");
}
function auditNestedAdapterSmoke(repoRoot, live) {
  const candidate = firstMomoProvider(repoRoot);
  if (!candidate) {
    return momoLifecycleFinding("nested-adapter-smoke", "skip", "no provider dispatcher to smoke-test");
  }
  if (!live) {
    return momoLifecycleFinding("nested-adapter-smoke", "skip", "live check skipped (pass --live)", ["requires --live"]);
  }
  const smoke = attemptNestedAdapterSmoke(repoRoot, candidate);
  if (!smoke.ok) {
    return momoLifecycleFinding("nested-adapter-smoke", "warn", "nested adapter smoke attempted but incomplete", [smoke.detail ?? "unknown error"]);
  }
  return momoLifecycleFinding("nested-adapter-smoke", "pass", "nested adapter smoke test passed");
}
function runMomoLifecyclePlaneAudit(repoRoot, live = false) {
  const findings = [
    auditManifestRoleConsistency(repoRoot),
    auditLifecycleScripts(repoRoot),
    auditSentinelScripts(repoRoot),
    auditExecutableProvider(repoRoot),
    auditProviderSyntax(repoRoot),
    auditPlaneBinding(repoRoot),
    auditPlaneStateMapping(repoRoot, live),
    auditRootAdapterSmoke(repoRoot),
    auditNestedAdapterSmoke(repoRoot, live)
  ];
  const ready = findings.every((f) => f.status === "pass" || f.status === "skip");
  return {
    ready,
    profile: "momo-lifecycle-plane",
    repo: resolve3(repoRoot),
    live,
    auditedAt: (/* @__PURE__ */ new Date()).toISOString(),
    findings
  };
}
function runMomoReadinessAudit(repoRoot, live = false) {
  return runMomoLifecyclePlaneAudit(resolve3(repoRoot ?? process.cwd()), live);
}
function formatMomoReadinessReport(report) {
  const sectionWidth = report.findings.reduce((max, f) => Math.max(max, f.section.length), 0);
  const overall = report.ready ? `${green(glyph.pass)} ${bold("Momo readiness: ready")}` : `${red(glyph.fail)} ${bold("Momo readiness: not ready")}`;
  const lines = ["", `  ${overall}  ${dim(glyph.dot)}  ${dim(report.profile)}`, `  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(report.auditedAt)}`, ""];
  for (const finding2 of report.findings) {
    const style = statusStyle(finding2.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(finding2.section.padEnd(sectionWidth))}  ${finding2.summary}`);
    for (const detail of finding2.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}
function isValidOpReference(value) {
  if (!value.startsWith("op://") || /[\[\]{}<>]/.test(value)) return false;
  const withoutScheme = value.slice("op://".length);
  const fragmentIndex = withoutScheme.indexOf("#");
  if (fragmentIndex >= 0) return false;
  const queryIndex = withoutScheme.indexOf("?");
  const pathPart = queryIndex >= 0 ? withoutScheme.slice(0, queryIndex) : withoutScheme;
  const queryPart = queryIndex >= 0 ? withoutScheme.slice(queryIndex + 1) : "";
  const parts = pathPart.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part)) return false;
  try {
    for (const part of parts) decodeURIComponent(part);
  } catch {
    return false;
  }
  if (queryIndex >= 0 && !/^attribute=[A-Za-z0-9._~-]+$/.test(queryPart)) return false;
  return true;
}
function assignmentOpReference(line) {
  const separator = line.indexOf("=");
  if (separator < 0) return null;
  const key = line.slice(0, separator).trim().replace(/^export\s+/u, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;
  let value = line.slice(separator + 1).trim();
  const quoted = value.startsWith('"') && value.endsWith('"') && value.length > 1 || value.startsWith("'") && value.endsWith("'") && value.length > 1;
  if (quoted) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/u, "").trim();
  return value.startsWith("op://") ? value : null;
}
function malformedOpReferences(text3) {
  const occurrences = [];
  const lines = text3.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const commentOnly = line.trimStart().startsWith("#");
    const assigned = commentOnly ? null : assignmentOpReference(line);
    if (assigned !== null) {
      if (!isValidOpReference(assigned)) occurrences.push({ line: index + 1, value: assigned, commentOnly: false });
      continue;
    }
    for (const match of line.matchAll(/op:\/\/[^\s"'`]+/g)) {
      const value = match[0];
      if (!isValidOpReference(value)) {
        occurrences.push({ line: index + 1, value, commentOnly });
      }
    }
  }
  return occurrences;
}
function removeMalformedCommentOpReferences(text3) {
  let changed = false;
  const lines = text3.split("\n").map((line) => {
    if (!line.trimStart().startsWith("#")) return line;
    return line.replace(/op:\/\/[^\s"'`]+/g, (value) => {
      if (isValidOpReference(value)) return value;
      changed = true;
      return "<invalid 1Password reference removed by pjangler>";
    });
  });
  return { text: lines.join("\n"), changed };
}
var UNSUPPORTED_BMAD_ROOTS = {
  ".agent": "antigravity",
  ".adal": "adal",
  ".bob": "bob",
  ".cline": "cline",
  ".codebuddy": "codebuddy",
  ".codewhale": "codewhale",
  ".cortex": "cortex",
  ".cursor": "cursor",
  ".factory": "droid",
  ".firebender": "firebender",
  ".iflow": "iflow",
  ".junie": "junie",
  ".kiro": "kiro",
  ".kode": "kode",
  ".neovate": "neovate",
  ".ona": "ona",
  ".qoder": "qoder",
  ".qwen": "qwen",
  ".trae": "trae",
  ".zcode": "zcode",
  ".zencoder": "zencoder"
};
function parseCsvRows(text3) {
  const rows = [];
  let row = [];
  let field2 = "";
  let quoted = false;
  for (let index = 0; index < text3.length; index++) {
    const char = text3[index];
    if (quoted) {
      if (char === '"' && text3[index + 1] === '"') {
        field2 += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field2 += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field2);
      field2 = "";
    } else if (char === "\n") {
      row.push(field2.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field2 = "";
    } else {
      field2 += char;
    }
  }
  if (field2 || row.length) {
    row.push(field2.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
function csvObjects(text3) {
  const [headers, ...rows] = parseCsvRows(text3);
  if (!headers?.length) return [];
  return rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}
function installedBmadTools(repoRoot) {
  const raw = safeReadText(join4(repoRoot, "_bmad", "_config", "manifest.yaml"));
  if (!raw) return /* @__PURE__ */ new Set();
  try {
    const parsed = YAML.parse(raw);
    return new Set(Array.isArray(parsed?.ides) ? parsed.ides.filter((entry) => typeof entry === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function bmadCliProjectionInventory(repoRoot) {
  const filesText = safeReadText(join4(repoRoot, "_bmad", "_config", "files-manifest.csv"));
  const skillsText = safeReadText(join4(repoRoot, "_bmad", "_config", "skill-manifest.csv"));
  if (!filesText || !skillsText) return { files: /* @__PURE__ */ new Map(), error: "BMAD files/skill manifests are missing" };
  const fileHashes = /* @__PURE__ */ new Map();
  for (const row of csvObjects(filesText)) {
    const hash = row.hash ?? "";
    if (row.path && /^[a-f0-9]{64}$/i.test(hash)) fileHashes.set(row.path.replace(/^_bmad\//, ""), hash.toLowerCase());
  }
  const projected = /* @__PURE__ */ new Map();
  for (const row of csvObjects(skillsText)) {
    const canonicalId = row.canonicalId ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(canonicalId)) continue;
    const skillPath = (row.path ?? "").replace(/^_bmad\//, "");
    if (!skillPath.endsWith("/SKILL.md")) continue;
    const sourceRoot = dirname3(skillPath);
    for (const [sourcePath, hash] of fileHashes) {
      if (sourcePath !== `${sourceRoot}/SKILL.md` && !sourcePath.startsWith(`${sourceRoot}/`)) continue;
      const suffix = relative2(sourceRoot, sourcePath);
      if (!suffix || suffix.startsWith("..")) continue;
      projected.set(join4("skills", canonicalId, suffix), hash);
    }
  }
  return projected.size ? { files: projected } : { files: projected, error: "BMAD manifests contain no projected skill inventory" };
}
function inventoryFilesUnder(root, current = root) {
  if (!existsSync3(current)) return { files: [], unsafe: [] };
  const stat = lstatSync2(current);
  const rel = relative2(root, current) || ".";
  if (stat.isSymbolicLink()) return { files: [], unsafe: [rel] };
  if (stat.isFile()) return { files: [relative2(root, current)], unsafe: [] };
  if (!stat.isDirectory()) return { files: [], unsafe: [rel] };
  const result2 = { files: [], unsafe: [] };
  for (const name of readdirSync2(current)) {
    const child = inventoryFilesUnder(root, join4(current, name));
    result2.files.push(...child.files);
    result2.unsafe.push(...child.unsafe);
  }
  return result2;
}
function unsupportedRootAttestation(repoRoot, rootName) {
  const root = join4(repoRoot, rootName);
  const stat = lstatSync2(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { safe: false, reason: `${rootName} is not a regular generated directory` };
  const installerTool = UNSUPPORTED_BMAD_ROOTS[rootName];
  if (!installedBmadTools(repoRoot).has(installerTool)) {
    return { safe: false, reason: `BMAD installer metadata does not declare tool ${installerTool}` };
  }
  const inventory = bmadCliProjectionInventory(repoRoot);
  if (inventory.error) return { safe: false, reason: inventory.error };
  const walked = inventoryFilesUnder(root);
  if (walked.unsafe.length) return { safe: false, reason: `${rootName}/${walked.unsafe[0]} is a symlink or non-regular entry` };
  if (!walked.files.length) return { safe: false, reason: `${rootName} has no installer-owned files` };
  for (const rel of walked.files) {
    const expectedHash = inventory.files.get(rel);
    if (!expectedHash) return { safe: false, reason: `${rootName}/${rel} is outside the BMAD generated inventory` };
    const actualHash = createHash2("sha256").update(readFileSync2(join4(root, rel))).digest("hex");
    if (actualHash !== expectedHash) return { safe: false, reason: `${rootName}/${rel} was locally modified after generation` };
  }
  return { safe: true, reason: `${walked.files.length} file(s) match BMAD installer inventory and hashes` };
}
function createMiseChecks() {
  return [
    {
      id: "mise.config-root",
      title: "mise config_root + AGENTS link hooks",
      audit: (ctx) => {
        const misePath = join4(ctx.repoRoot, "mise.toml");
        if (!existsSync3(misePath)) {
          return { id: "mise.config-root", title: "mise config_root + AGENTS link hooks", status: "fail", summary: "mise.toml missing", details: [], fixable: true };
        }
        const text3 = readText(misePath);
        const details = [];
        const linkAgentfilesPath = join4(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
        if (!existsSync3(linkAgentfilesPath)) details.push(".mise/scripts/link-agentfiles.sh missing");
        const pathValues = [...(text3.match(/^_\.path\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        const missingPathValues = requiredMisePathEntries(ctx).filter((value) => !pathValues.includes(value));
        if (missingPathValues.length) details.push(`[env]._.path should include ${missingPathValues.join(", ")}`);
        if (!text3.includes("'{{config_root}}/.mise/scripts/link-agentfiles.sh'")) details.push("link-agentfiles hook must use single-quoted {{config_root}} guard");
        if (!text3.includes('patterns = ["AGENTS.md"]')) details.push("watch_files must monitor AGENTS.md");
        if (!text3.includes(`task = "${LINK_AGENTFILES_TASK}"`)) details.push(`watch_files must dispatch the ${LINK_AGENTFILES_TASK} task`);
        details.push(...retiredTaskNameIssues(text3));
        return {
          id: "mise.config-root",
          title: "mise config_root + AGENTS link hooks",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "mise AGENTS-linking parity verified" : `${details.length} issue(s) detected in mise AGENTS-linking contract`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const path = join4(ctx.repoRoot, "mise.toml");
        const changedFiles = [];
        const details = [];
        if (!existsSync3(path)) {
          if (ensureMiseTomlFromTemplate(ctx, changedFiles) === null) {
            return { id: finding2.id, title: finding2.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
          }
          details.push("Initialized mise.toml from generated-project template");
          if (ctx.dryRun) {
            return { id: finding2.id, title: finding2.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
          }
        }
        let text3 = readText(path);
        const next = upsertLinkAgentfilesBlock(text3, ctx);
        if (next !== text3) {
          if (!changedFiles.includes(path)) changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, next);
          text3 = next;
        }
        const linkAgentfilesPath = join4(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
        const expectedScript = templateLinkAgentfilesScript(ctx);
        if (expectedScript === void 0) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/link-agentfiles.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
        }
        if (safeReadText(linkAgentfilesPath) !== expectedScript) {
          changedFiles.push(linkAgentfilesPath);
          if (!ctx.dryRun) {
            writeText(linkAgentfilesPath, expectedScript);
            chmodSync(linkAgentfilesPath, 493);
          }
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
          changedFiles,
          details: changedFiles.length ? [`Normalized hooks/watch_files/tasks."${LINK_AGENTFILES_TASK}" block and script`] : []
        };
      }
    },
    {
      id: "mise.versioning",
      title: "managed mise versioning block",
      audit: (ctx) => {
        const details = [];
        const misePath = join4(ctx.repoRoot, "mise.toml");
        const versioningPath = join4(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
        const manifestPath = join4(ctx.repoRoot, ".mise", "version-files.conf");
        const text3 = safeReadText(misePath);
        if (!text3?.includes("# >>> mise-versioning >>>")) details.push("mise versioning managed block missing");
        if (!existsSync3(versioningPath)) details.push(".mise/scripts/versioning.sh missing");
        if (!existsSync3(manifestPath)) details.push(".mise/version-files.conf missing");
        return {
          id: "mise.versioning",
          title: "managed mise versioning block",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "mise versioning parity verified" : `${details.length} versioning issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const details = [];
        const misePath = join4(ctx.repoRoot, "mise.toml");
        if (!existsSync3(misePath)) {
          if (ensureMiseTomlFromTemplate(ctx, changedFiles) === null) {
            return { id: finding2.id, title: finding2.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
          }
          details.push("Initialized mise.toml from generated-project template");
          if (ctx.dryRun) {
            return { id: finding2.id, title: finding2.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
          }
        }
        const currentMise = readText(misePath);
        let cleanedMise = currentMise;
        if (!currentMise.includes("# >>> mise-versioning >>>")) {
          const taskNames = ["version", "version:bump", "version:bump-patch", "version:bump-minor", "version:bump-major", "version:check", "version:sync"];
          for (const taskName of taskNames) {
            const escaped = taskName.replace(/:/g, "\\:");
            const headerPattern = new RegExp(`^\\[tasks\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]$`);
            cleanedMise = removeTomlSection(cleanedMise, headerPattern);
          }
        }
        const nextMise = replaceOrAppendManagedBlock(cleanedMise, /# >>> mise-versioning >>>/, VERSIONING_BLOCK, /^\[tasks\.build\]/m);
        if (nextMise !== currentMise) {
          if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
          if (!ctx.dryRun) writeText(misePath, nextMise);
        }
        const versioningPath = join4(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
        const expectedScript = templateVersioningScript(ctx);
        if (expectedScript === void 0) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/versioning.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
        }
        if (safeReadText(versioningPath) !== expectedScript) {
          changedFiles.push(versioningPath);
          if (!ctx.dryRun) {
            writeText(versioningPath, expectedScript);
            chmodSync(versioningPath, 493);
          }
        }
        const manifestPath = join4(ctx.repoRoot, ".mise", "version-files.conf");
        const expectedManifest = templateVersionFilesConf(ctx, ctx.repoRoot);
        if (safeReadText(manifestPath) !== expectedManifest) {
          changedFiles.push(manifestPath);
          if (!ctx.dryRun) writeText(manifestPath, expectedManifest);
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Versioning block/script/manifest normalized" : "No changes required",
          changedFiles,
          details: []
        };
      }
    }
  ];
}
function createAgentHooksChecks() {
  return [
    {
      id: "skills.project-manifest",
      title: "Skillex project skills manifest",
      audit: (ctx) => {
        const details = [];
        const manifestPath = join4(ctx.repoRoot, ".agents", "skills.json");
        const legacyDir = join4(ctx.repoRoot, ".agents", "skills");
        const localExamplePath = join4(ctx.repoRoot, ".agents", "local.example.json");
        const misePath = join4(ctx.repoRoot, "mise.toml");
        let fixable = true;
        const manifest = tryParseJson(safeReadText(manifestPath));
        const plan = buildPackPlan(ctx, manifest);
        if (plan.errors.length) {
          details.push(...plan.errors);
          fixable = false;
        }
        const packAdvisories = [
          ...plan.warnings.length ? [`${plan.warnings.length} optional pack(s) skipped`] : [],
          ...plan.packWarnings
        ];
        const expectedByName = new Map(plan.projections);
        const expectedNames = new Set(expectedByName.keys());
        if (!manifest) {
          details.push(".agents/skills.json missing or invalid JSON");
        } else {
          if (manifest.inherit_global !== true) details.push(".agents/skills.json should set inherit_global: true");
          if (manifest.registry !== SKILLS_REGISTRY_URL) details.push(`.agents/skills.json should set registry to ${SKILLS_REGISTRY_URL}`);
          if (typeof manifest.$schema === "string" && RETIRED_SKILLS_SCHEMA_URLS.includes(manifest.$schema)) {
            details.push(`.agents/skills.json $schema still points at the retired ${manifest.$schema}; it should be ${SKILLS_SCHEMA_URL}`);
          } else if (manifest.$schema !== SKILLS_SCHEMA_URL) {
            details.push(`.agents/skills.json should set $schema to ${SKILLS_SCHEMA_URL}`);
          }
          if (!Array.isArray(manifest.skills)) {
            details.push(".agents/skills.json should define a skills array");
          } else {
            const bmadEntries = manifest.skills.filter((entry) => isRetiredBmadPackEntry(entry)).map(skillManifestEntryName).filter((name) => Boolean(name));
            const retiredPacks = retiredPackDeclarations(manifest);
            if (retiredPacks.length) {
              details.push(
                `.agents/skills.json declares retired pack(s) that bmad-method owns and Skillex no longer carries: ${retiredPacks.join(", ")}`
              );
            }
            if (bmadEntries.length) {
              details.push(
                `.agents/skills.json declares ${bmadEntries.length} bmad-* skill(s) that bmad-method owns and should drop them: ${bmadEntries.join(", ")}`
              );
            }
            const redundant = manifest.skills.filter((entry) => isRedundantDeclaredPackEntry(entry, plan)).map(skillManifestEntryName).filter((name) => Boolean(name));
            if (redundant.length) {
              details.push(
                `.agents/skills.json skills[] duplicates ${redundant.length} declared pack member(s) and should drop them: ${redundant.join(", ")}`
              );
            }
          }
        }
        const invalidBmadLinkNames = /* @__PURE__ */ new Set();
        if (existsSync3(legacyDir)) {
          for (const name of readdirSync2(legacyDir)) {
            const expected = expectedByName.get(name);
            const path = join4(legacyDir, name);
            let linkTargetsPack = false;
            try {
              const linkTarget = lstatSync2(path).isSymbolicLink() ? resolve3(dirname3(path), readlinkSync(path)) : null;
              linkTargetsPack = Boolean(linkTarget) && plan.ownershipRoots.some((root) => isContainedBy(root, linkTarget));
            } catch {
              linkTargetsPack = false;
            }
            if (!expected && !linkTargetsPack) continue;
            try {
              if (!expected || !lstatSync2(path).isSymbolicLink() || resolve3(dirname3(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
            } catch {
              invalidBmadLinkNames.add(name);
            }
          }
          for (const [name, expected] of expectedByName) {
            const path = join4(legacyDir, name);
            try {
              if (!lstatSync2(path).isSymbolicLink() || resolve3(dirname3(path), readlinkSync(path)) !== expected) invalidBmadLinkNames.add(name);
            } catch {
              invalidBmadLinkNames.add(name);
            }
          }
        } else {
          for (const name of expectedByName.keys()) invalidBmadLinkNames.add(name);
        }
        if (invalidBmadLinkNames.size > 0) {
          details.push(`${invalidBmadLinkNames.size} managed pack skill path(s) should be symlinks into their declared Skillex pack`);
        }
        const manifestNames = new Set(
          (Array.isArray(manifest?.skills) ? manifest.skills : []).map(skillManifestEntryName).filter((name) => Boolean(name))
        );
        const unmanagedSkillNames = legacyCommittedSkillNames(
          legacyDir,
          skillsBackupDir(ctx.repoRoot),
          expectedNames,
          plan.ownershipRoots,
          manifestNames
        );
        for (const name of unmanagedSkillNames) {
          details.push(`.agents/skills/${name} is committed but absent from .agents/skills.json`);
        }
        if (unmanagedSkillNames.length) {
          details.push(
            `Run \`pj migrate skills.project-manifest --accept-registry-matches\` to map ${unmanagedSkillNames.length} undeclared skill entr(ies) into the manifest`
          );
        }
        for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
          if (existsSync3(join4(ctx.repoRoot, rel))) details.push(`${rel} is a legacy symlink-era script and should be removed`);
        }
        const localExample = tryParseJson(safeReadText(localExamplePath));
        if (localExample && Object.prototype.hasOwnProperty.call(localExample, "skills")) {
          details.push(".agents/local.example.json still documents legacy skills overrides; drop the skills section");
        }
        if (existsSync3(join4(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL))) {
          details.push(`${LEGACY_PROVISION_SCRIPT_REL} is the retired BMAD-only provisioner and should be replaced by ${PROVISION_PACKS_SCRIPT_REL}`);
        }
        const mise = safeReadText(misePath);
        if (!mise?.includes(SYNC_SKILLS_SCRIPT)) details.push("mise.toml should run the shipped project-local sync-skills.py engine via config_root");
        if (!mise?.includes(PROVISION_PACKS_SCRIPT)) details.push("mise.toml should provision declared Skillex packs before syncing skills");
        if (mise?.includes(SYNC_SKILLS_SCRIPT) && mise.includes(PROVISION_PACKS_SCRIPT) && mise.indexOf(PROVISION_PACKS_SCRIPT) > mise.indexOf(SYNC_SKILLS_SCRIPT)) {
          details.push("mise.toml should run the pack provisioner before project skill sync");
        }
        if (mise?.includes(LEGACY_PROVISION_TASK) || mise?.includes("provision-bmad-skills.py")) {
          details.push(`mise.toml still references the retired ${LEGACY_PROVISION_TASK} task/provision-bmad-skills.py script`);
        }
        if (mise?.includes('script = "sync-skills.py --scope project"') || mise?.includes('run = "sync-skills.py --scope project"')) {
          details.push("mise.toml still invokes the missing bare sync-skills.py executable");
        }
        if (!mise?.includes('patterns = [".agents/skills.json"]')) details.push("mise.toml should watch .agents/skills.json");
        if (!mise?.includes(taskHeader(SKILLS_SYNC_TASK))) details.push(`mise.toml should define a ${SKILLS_SYNC_TASK} task`);
        if (!mise?.includes(`depends = ["${PROVISION_PACKS_TASK}"]`)) details.push(`${SKILLS_SYNC_TASK} task should depend on ${PROVISION_PACKS_TASK}`);
        if (mise) details.push(...retiredTaskNameIssues(mise));
        for (const [rel, label] of [
          [PROVISION_PACKS_SCRIPT_REL, "Skillex pack provisioning script"],
          [SYNC_SKILLS_SCRIPT_REL, "Project-local skills sync engine"]
        ]) {
          const target = join4(ctx.repoRoot, rel);
          const expected = templateCommonProjectText(ctx, rel);
          const stat = lstatIfPresent(target);
          if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
            details.push(`${label} is missing or unsafe`);
            if (stat) fixable = false;
          } else {
            if (expected === void 0 || safeReadText(target) !== expected) details.push(`${label} differs from the shipped template`);
            if ((Number(stat.mode) & 73) === 0) details.push(`${label} is not executable`);
          }
        }
        const topologyIssues = projectSkillTopologyIssues(ctx.repoRoot);
        if (topologyIssues.length) {
          details.push(...topologyIssues.map((issue) => `CLI skill topology: ${issue}`));
          fixable = false;
        }
        if (mise?.includes("link-project-skills-to-clis.sh") || mise?.includes("unlink-project-skills-from-clis.sh") || mise?.includes("[tasks.skills-relink]")) {
          details.push("mise.toml still contains legacy skill-link wiring");
        }
        return {
          id: "skills.project-manifest",
          title: "Skillex project skills manifest",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? `Skillex skills manifest parity verified${packAdvisories.length ? ` (${packAdvisories.join("; ")})` : ""}` : `${details.length} Skillex migration issue(s) detected${unmanagedSkillNames.length ? ` (${unmanagedSkillNames.length} undeclared skill entr(ies): ${unmanagedSkillNames.join(", ")})` : ""}`,
          details,
          fixable
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const details = [];
        const manifestPath = join4(ctx.repoRoot, ".agents", "skills.json");
        const localExamplePath = join4(ctx.repoRoot, ".agents", "local.example.json");
        const misePath = join4(ctx.repoRoot, "mise.toml");
        const provisionScriptPath = join4(ctx.repoRoot, PROVISION_PACKS_SCRIPT_REL);
        const legacyProvisionScriptPath = join4(ctx.repoRoot, LEGACY_PROVISION_SCRIPT_REL);
        const syncScriptPath = join4(ctx.repoRoot, SYNC_SKILLS_SCRIPT_REL);
        const expectedProvisionScript = templateCommonProjectText(ctx, PROVISION_PACKS_SCRIPT_REL);
        const expectedSyncScript = templateCommonProjectText(ctx, SYNC_SKILLS_SCRIPT_REL);
        const topologyIssues = projectSkillTopologyIssues(ctx.repoRoot);
        if (topologyIssues.length) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Unsafe project CLI skill topology must be repaired manually",
            changedFiles,
            details: topologyIssues
          };
        }
        if (!expectedProvisionScript || !expectedSyncScript) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "pjangler install is missing a shipped skills executable",
            changedFiles,
            details: [
              ...!expectedProvisionScript ? [`Missing Skillex pack provisioning script template (${PROVISION_PACKS_SCRIPT_REL})`] : [],
              ...!expectedSyncScript ? ["Missing project-local skills sync engine template"] : []
            ]
          };
        }
        const unsafeScriptTargets = [provisionScriptPath, syncScriptPath].filter((path) => {
          const stat = lstatIfPresent(path);
          return Boolean(stat && (!stat.isFile() || stat.isSymbolicLink()));
        });
        if (unsafeScriptTargets.length) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Refusing non-regular managed skills executable target",
            changedFiles,
            details: unsafeScriptTargets.map((path) => `${path} must be removed or repaired manually`)
          };
        }
        const droppedPacks = dropRetiredPackDeclarations(manifestPath, Boolean(ctx.dryRun));
        if (droppedPacks.length) {
          if (!ctx.dryRun) changedFiles.push(manifestPath);
          details.push(`dropped retired pack declaration(s) bmad-method owns: ${droppedPacks.join(", ")}`);
        }
        const provisioned = provisionDeclaredPacks(ctx);
        if (!provisioned.ok) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "A declared Skillex pack is unavailable or untrusted",
            changedFiles,
            details: [provisioned.error ?? "Unknown Skillex pack error"]
          };
        }
        changedFiles.push(...provisioned.changedFiles);
        if (provisioned.changedFiles.includes(manifestPath)) details.push("Normalized .agents/skills.json against the declared Skillex packs");
        details.push(...provisioned.packWarnings ?? []);
        details.push(...migrateLegacyCommittedSkills(ctx, changedFiles));
        for (const rel of [".mise/scripts/link-project-skills-to-clis.sh", ".mise/scripts/unlink-project-skills-from-clis.sh"]) {
          const path = join4(ctx.repoRoot, rel);
          if (existsSync3(path)) {
            changedFiles.push(path);
            if (!ctx.dryRun) unlinkSync(path);
          }
        }
        const templateLocalExample = templateCommonProjectText(ctx, ".agents/local.example.json");
        const currentLocalExample = safeReadText(localExamplePath);
        if (templateLocalExample && currentLocalExample && currentLocalExample !== templateLocalExample) {
          changedFiles.push(localExamplePath);
          if (!ctx.dryRun) writeText(localExamplePath, templateLocalExample);
        }
        normalizeExecutableTemplate(ctx, provisionScriptPath, expectedProvisionScript, changedFiles);
        normalizeExecutableTemplate(ctx, syncScriptPath, expectedSyncScript, changedFiles);
        const legacyProvisionStat = lstatIfPresent(legacyProvisionScriptPath);
        if (legacyProvisionStat) {
          if (legacyProvisionStat.isDirectory() && !legacyProvisionStat.isSymbolicLink()) {
            details.push(`${LEGACY_PROVISION_SCRIPT_REL} is a directory and must be removed manually`);
          } else {
            changedFiles.push(legacyProvisionScriptPath);
            details.push(`Removed the retired ${LEGACY_PROVISION_SCRIPT_REL}`);
            if (!ctx.dryRun) unlinkSync(legacyProvisionScriptPath);
          }
        }
        let currentMise = safeReadText(misePath);
        if (currentMise === null) {
          const initialized = ensureMiseTomlFromTemplate(ctx, changedFiles);
          if (initialized === null) {
            return { id: finding2.id, title: finding2.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details };
          }
          details.push("Initialized mise.toml from generated-project template");
          currentMise = initialized;
        }
        const nextMise = upsertLinkAgentfilesBlock(currentMise, ctx);
        if (nextMise !== currentMise) {
          if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
          if (!ctx.dryRun) writeText(misePath, nextMise);
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Skillex skills manifest contract normalized" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "sot.agent-symlinks",
      title: "AGENTS/CLAUDE/GEMINI symlink contract",
      audit: (ctx) => {
        const agentsPath = join4(ctx.repoRoot, "AGENTS.md");
        if (!existsSync3(agentsPath)) {
          const fallbackSources = ["CLAUDE.md", "GEMINI.md", "README.md"].filter((file) => existsSync3(join4(ctx.repoRoot, file)));
          if (fallbackSources.length === 0) {
            return { id: "sot.agent-symlinks", title: "AGENTS/CLAUDE/GEMINI symlink contract", status: "skip", summary: "AGENTS.md missing; symlink contract not applicable", details: [], fixable: false };
          }
          return {
            id: "sot.agent-symlinks",
            title: "AGENTS/CLAUDE/GEMINI symlink contract",
            status: "fail",
            summary: "AGENTS.md missing but can be derived from existing project documentation",
            details: [`AGENTS.md can be created from ${fallbackSources[0]}`],
            fixable: true
          };
        }
        const details = [];
        for (const file of ["CLAUDE.md", "GEMINI.md"]) {
          const full = join4(ctx.repoRoot, file);
          const target = readSymlinkTarget(full);
          if (target !== "AGENTS.md") details.push(`${file} should be a symlink to AGENTS.md`);
        }
        return {
          id: "sot.agent-symlinks",
          title: "AGENTS/CLAUDE/GEMINI symlink contract",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Agent documentation symlinks are in parity" : `${details.length} symlink issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const details = [];
        const blockedDetails = [];
        const bootstrap = bootstrapAgentsFile(ctx.repoRoot, ctx.dryRun);
        changedFiles.push(...bootstrap.changedFiles);
        details.push(...bootstrap.details);
        if (bootstrap.blocked) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "AGENTS.md missing; cannot derive canonical agent file", changedFiles, details: [bootstrap.blocked] };
        }
        for (const file of ["CLAUDE.md", "GEMINI.md"]) {
          const full = join4(ctx.repoRoot, file);
          const result2 = ensureSymlink(full, "AGENTS.md", ctx.dryRun);
          if (result2.blocked) blockedDetails.push(result2.blocked);
          if (result2.changed) changedFiles.push(full);
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: blockedDetails.length ? "blocked" : changedFiles.length ? "applied" : "noop",
          summary: blockedDetails.length ? "One or more files could not be replaced safely" : changedFiles.length ? "Symlink contract repaired" : "No changes required",
          changedFiles,
          details: [...details, ...blockedDetails]
        };
      }
    }
  ];
}
function createProjectJsonChecks() {
  return [
    {
      id: "sot.project-json",
      title: "Canonical .project.json",
      audit: projectJsonFinding,
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const blockedDetails = [];
        const droppedDetails = [];
        const path = join4(ctx.repoRoot, ".project.json");
        const existing = readProjectJson(ctx) ?? {};
        const canonical = canonicalProjectJson(ctx);
        const preservedDetails = [];
        for (const agentId of canonical.unprovisioned) {
          const roleDir = existing.agents?.[agentId]?.role_dir;
          preservedDetails.push(
            `preserved unprovisioned declared agent: ${agentId}${typeof roleDir === "string" && roleDir ? ` (${roleDir} has no role.yaml)` : " (no role_dir)"}; provision or restore the role, do not delete its declaration`
          );
        }
        for (const agentId of canonical.dropped) {
          const entry = existing.agents?.[agentId];
          const entryRecord = typeof entry === "object" && entry !== null ? entry : void 0;
          const declared = {
            agentId,
            role: typeof entryRecord?.role === "string" ? entryRecord.role : void 0,
            roleDir: typeof entryRecord?.role_dir === "string" ? entryRecord.role_dir : void 0,
            extras: {}
          };
          const validation = validateDeclaredAgent(ctx, declared);
          const reason = validation.details.join("; ") || "invalid";
          droppedDetails.push(`dropped invalid declared agent: ${agentId} (${reason})`);
        }
        const { dropped: _dropped, unprovisioned: _unprovisioned, ...canonicalJson2 } = canonical;
        const merged = { ...existing, ...canonicalJson2 };
        const expected = `${JSON.stringify(merged, null, 2)}
`;
        if (safeReadText(path) !== expected) {
          changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, expected);
        }
        const planeJson = join4(ctx.repoRoot, ".plane.json");
        if (existsSync3(planeJson)) {
          const backup = `${planeJson}.migrated-backup`;
          if (existsSync3(backup)) {
            blockedDetails.push(`cannot back up .plane.json because ${relative2(ctx.repoRoot, backup)} already exists`);
          } else {
            changedFiles.push(backup);
            if (!ctx.dryRun) renameSync(planeJson, backup);
          }
        }
        const details = [...droppedDetails, ...preservedDetails, ...blockedDetails];
        return {
          id: finding2.id,
          title: finding2.title,
          status: blockedDetails.length ? "blocked" : changedFiles.length || droppedDetails.length ? "applied" : "noop",
          summary: blockedDetails.length ? "Project SOT partially blocked" : changedFiles.length || droppedDetails.length ? `Canonical .project.json written; dropped ${droppedDetails.length} invalid declared agent(s)` : "No changes required",
          changedFiles,
          details
        };
      }
    }
  ];
}
function createMiseOpInjectChecks() {
  return [
    {
      id: "secrets.env-op",
      title: ".env.op + gitignore secrets contract",
      audit: (ctx) => {
        const details = [];
        let envOpNeedsHands = false;
        const envOpPath = join4(ctx.repoRoot, ".env.op");
        const envOpExists = existsSync3(envOpPath);
        const envOp = envOpExists ? readText(envOpPath) : void 0;
        const gitignore = safeReadText(join4(ctx.repoRoot, ".gitignore"));
        if (!envOpExists) {
          details.push(".env.op missing");
        } else if (!envOp?.trim()) {
          details.push(".env.op is empty or whitespace-only");
        } else {
          const malformed = malformedOpReferences(envOp);
          if (malformed.length) {
            details.push(`.env.op has malformed op:// reference(s) on line(s): ${Array.from(new Set(malformed.map((entry) => entry.line))).join(", ")}`);
          }
          const invalidLines = envOp.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(({ line }) => line && !line.startsWith("#") && line.includes("=")).filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
          if (invalidLines.length) details.push(`.env.op has non-reference values that do not look like safe literals on line(s): ${invalidLines.map((entry) => entry.number).join(", ")}`);
        }
        if (!gitignore?.includes(".env\n") && !gitignore?.includes(".env\r\n")) details.push(".gitignore should ignore .env");
        if (!gitignore?.includes(".env.*")) details.push(".gitignore should ignore .env.*");
        if (!gitignore?.includes("!.env.op")) details.push(".gitignore should unignore .env.op");
        const misePath = join4(ctx.repoRoot, "mise.toml");
        const miseText = safeReadText(misePath);
        if (!miseText) {
          details.push("mise.toml missing for .env materialization hook");
        } else {
          const enterHookValues = stripHookBlocks(miseText).enter;
          const truncating = truncatingOpInjectEntries(enterHookValues);
          if (truncating.length) details.push(`hooks.enter has ${truncating.length} unsafe legacy .env op-inject hook(s)`);
          const canonicalCount = enterHookValues.filter((value) => value.trim() === OP_INJECT_SCRIPT).length;
          if (canonicalCount !== 1) details.push(`hooks.enter must contain exactly one managed materialize-env hook (found ${canonicalCount})`);
          const strayOwned = ownedOpInjectScriptsOutsideEnter(miseText);
          if (strayOwned.length) details.push(`owned .env materialization appears outside [[hooks.enter]] on line(s): ${strayOwned.map((entry) => entry.line).join(", ")}`);
        }
        const materializePath = join4(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
        const expectedMaterializer = templateMaterializeEnvScript(ctx);
        if (!expectedMaterializer) {
          details.push("pjangler package is missing the managed materialize-env.sh source");
        } else if (safeReadText(materializePath) !== expectedMaterializer) {
          details.push(`${MATERIALIZE_ENV_SCRIPT_REL} missing or drifted`);
        } else if ((lstatSync2(materializePath).mode & 73) === 0) {
          details.push(`${MATERIALIZE_ENV_SCRIPT_REL} is not executable`);
        }
        return {
          id: "secrets.env-op",
          title: ".env.op + gitignore secrets contract",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Secret reference file and ignore rules are in parity" : `${details.length} env parity issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const details = [];
        let envOpNeedsHands = false;
        const envOpPath = join4(ctx.repoRoot, ".env.op");
        const canonicalEnvOpPath = join4(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op");
        if (!existsSync3(canonicalEnvOpPath)) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "pjangler package is missing the neutral .env.op template", changedFiles: [], details: [] };
        }
        const canonicalEnvOp = readText(canonicalEnvOpPath);
        if (!existsSync3(envOpPath) || !readText(envOpPath).trim()) {
          changedFiles.push(envOpPath);
          if (!ctx.dryRun) writeText(envOpPath, canonicalEnvOp);
        } else {
          const current = readText(envOpPath);
          const activeMalformed = malformedOpReferences(current).filter((entry) => !entry.commentOnly);
          const invalidActive = current.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(({ line }) => line && !line.startsWith("#") && line.includes("=")).filter(({ line }) => {
            const value = line.slice(line.indexOf("=") + 1).trim();
            const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
            return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
          });
          if (activeMalformed.length || invalidActive.length) {
            envOpNeedsHands = true;
            details.push(...activeMalformed.length ? [`Malformed active op:// reference(s) remain on line(s) ${Array.from(new Set(activeMalformed.map((entry) => entry.line))).join(", ")}; repair them manually without replacing valid user references`] : []);
            details.push(...invalidActive.length ? [`Unsafe active value(s) remain on line(s) ${invalidActive.map((entry) => entry.number).join(", ")}; repair them manually`] : []);
          } else {
            const repaired = removeMalformedCommentOpReferences(current);
            const next = repaired.text;
            if (next !== current) {
              changedFiles.push(envOpPath);
              if (!ctx.dryRun) writeText(envOpPath, next);
            }
          }
        }
        const gitignorePath = join4(ctx.repoRoot, ".gitignore");
        const gitignore = safeReadText(gitignorePath) ?? "";
        const requiredBlock = `# Secrets \u2014 .env is materialized from .env.op by \`op inject\` on mise enter,
# staged through a mktemp file and moved into place only on success.
# NEVER commit it. .env.op holds only 1Password references or safe literals and IS committed.
.env
.env.*
!.env.op
`;
        if (!gitignore.includes("!.env.op") || !gitignore.includes(".env.*")) {
          changedFiles.push(gitignorePath);
          if (!ctx.dryRun) writeText(gitignorePath, `${gitignore.replace(/\s*$/, "")}${gitignore.trim() ? "\n\n" : ""}${requiredBlock}`);
        }
        const misePath = join4(ctx.repoRoot, "mise.toml");
        let currentMise = safeReadText(misePath);
        if (currentMise === null) {
          const initialized = ensureMiseTomlFromTemplate(ctx, changedFiles);
          if (initialized === null) {
            return { id: finding2.id, title: finding2.title, status: "blocked", summary: "mise.toml missing and the packaged template is unavailable", changedFiles: [], details: [] };
          }
          currentMise = initialized;
        }
        const nextOpInjectMise = upsertOpInjectHook(currentMise);
        if (nextOpInjectMise !== currentMise) {
          if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
          if (!ctx.dryRun) writeText(misePath, nextOpInjectMise);
        }
        const materializePath = join4(ctx.repoRoot, MATERIALIZE_ENV_SCRIPT_REL);
        const expectedMaterializer = templateMaterializeEnvScript(ctx);
        if (!expectedMaterializer) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "pjangler package is missing materialize-env.sh", changedFiles: [], details: [] };
        }
        if (safeReadText(materializePath) !== expectedMaterializer || existsSync3(materializePath) && (lstatSync2(materializePath).mode & 73) === 0) {
          changedFiles.push(materializePath);
          if (!ctx.dryRun) {
            writeText(materializePath, expectedMaterializer);
            chmodSync(materializePath, 493);
          }
        }
        const uniqueChangedFiles = [...new Set(changedFiles)].sort();
        if (envOpNeedsHands) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: uniqueChangedFiles.length ? "Repaired the mise contract; .env.op content still needs hands" : "Manual .env.op cleanup still required",
            changedFiles: uniqueChangedFiles,
            details
          };
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: uniqueChangedFiles.length ? "applied" : "noop",
          summary: uniqueChangedFiles.length ? "Reconciled the canonical .env materialization contract" : "No changes required",
          changedFiles: uniqueChangedFiles,
          details
        };
      }
    }
  ];
}
function createProjectProvenanceChecks() {
  return [
    {
      id: "provenance.copier",
      title: ".copier-answers.yml provenance + drift report",
      audit: (ctx) => {
        const details = [];
        const path = join4(ctx.repoRoot, ".copier-answers.yml");
        const text3 = safeReadText(path);
        const project = readProjectJson(ctx);
        if (!text3) {
          details.push(".copier-answers.yml missing");
        } else {
          if (!text3.startsWith("# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY")) details.push("missing Copier overwrite warning header");
          if (!text3.includes("_src_path:")) details.push("_src_path missing");
          if (project?.project_name) {
            const nameMatch = text3.match(/project_name:\s*(.+)/);
            if (!nameMatch || nameMatch[1]?.trim() !== String(project.project_name)) details.push("project_name drift between .copier-answers.yml and .project.json");
          }
          if (project?.project_description) {
            const descMatch = text3.match(/project_description:\s*([\s\S]*?)(?=\n\w|$)/);
            const yamlDesc = descMatch?.[1]?.replace(/\n\s+/g, " ").trim() ?? "";
            if (yamlDesc !== String(project.project_description)) details.push("project_description drift between .copier-answers.yml and .project.json");
          }
        }
        return {
          id: "provenance.copier",
          title: ".copier-answers.yml provenance + drift report",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Copier provenance is in parity" : `${details.length} provenance issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const project = canonicalProjectJson(ctx);
        const text3 = `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY
_src_path: ${join4(ctx.pjanglerRoot, "templates", "commonproject")}
project_description: ${String(project.project_description)}
project_name: ${String(project.project_name)}
ticket_provider: ${String(project.ticket_provider?.type ?? "plane")}
`;
        const path = join4(ctx.repoRoot, ".copier-answers.yml");
        if (safeReadText(path) !== text3) {
          changedFiles.push(path);
          if (!ctx.dryRun) writeText(path, text3);
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Copier provenance file refreshed" : "No changes required",
          changedFiles,
          details: []
        };
      }
    }
  ];
}
function supportedCliProjectionIssues(repoRoot) {
  const issues = [];
  const managedSkills = join4(repoRoot, ".agents", "skills");
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join4(repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (!rootStat) {
      issues.push(`${rootName} missing`);
      continue;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      issues.push(`${rootName} must be a real configuration directory`);
      continue;
    }
    const skills = join4(root, "skills");
    const skillsStat = lstatIfPresent(skills);
    if (!skillsStat) {
      issues.push(`${rootName}/skills missing`);
      continue;
    }
    let projectedSkills = skills;
    if (skillsStat.isSymbolicLink()) {
      let rawTarget = "";
      try {
        rawTarget = readlinkSync(skills);
      } catch {
        issues.push(`${rootName}/skills is an unreadable symlink`);
        continue;
      }
      if (rawTarget !== CANONICAL_CLI_SKILLS_ALIAS) {
        issues.push(`${rootName}/skills must target ${CANONICAL_CLI_SKILLS_ALIAS}`);
        continue;
      }
      const targetStat = lstatIfPresent(managedSkills);
      if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        issues.push(`${rootName}/skills alias target .agents/skills is missing or unsafe`);
        continue;
      }
      try {
        if (realpathSync(skills) !== realpathSync(managedSkills)) {
          issues.push(`${rootName}/skills resolves outside .agents/skills`);
          continue;
        }
      } catch {
        issues.push(`${rootName}/skills alias is broken`);
        continue;
      }
      projectedSkills = managedSkills;
    } else if (!skillsStat.isDirectory()) {
      issues.push(`${rootName}/skills is not a directory`);
      continue;
    }
    const hasGeneratedSkill = existsSync3(projectedSkills) && readdirSync2(projectedSkills).some((name) => {
      const skillFile = join4(projectedSkills, name, "SKILL.md");
      return existsSync3(skillFile) && lstatSync2(skillFile).isFile();
    });
    if (!hasGeneratedSkill) issues.push(`${rootName}/skills contains no BMAD skill configuration`);
  }
  return issues;
}
var SUPPORTED_CLI_GITIGNORE_BLOCK = `# Generated CLI configurations are durable project state...
${SUPPORTED_CLI_ROOTS.flatMap((root) => [`!${root}/`, `!${root}/**`]).join("\n")}
# ...but their skill projections are regenerated by \`bmad-method install\` and
# \`mise run skills:sync\`, so they stay out of the tree. No trailing slash:
# some CLIs get a real directory here and some get a symlink.
/.agents/skills
${SUPPORTED_CLI_ROOTS.map((root) => `${root}/skills`).join("\n")}`;
function supportedCliGitignoreIssues(repoRoot) {
  const lines = (safeReadText(join4(repoRoot, ".gitignore")) ?? "").split(/\r?\n/);
  return [
    ...SUPPORTED_CLI_ROOTS.flatMap((root) => [
      ...!lines.includes(`!${root}/`) ? [`.gitignore must unignore ${root}/`] : [],
      ...!lines.includes(`!${root}/**`) ? [`.gitignore must unignore ${root}/**`] : [],
      // Accept either form so an existing repo is not churned, but only the
      // slashless pattern actually covers a symlinked projection.
      ...!lines.includes(`${root}/skills`) ? [`.gitignore must re-ignore the generated ${root}/skills (no trailing slash \u2014 the projection may be a symlink)`] : []
    ]),
    ...!lines.includes("/.agents/skills") ? [".gitignore must ignore the generated /.agents/skills"] : []
  ];
}
function ensureSupportedCliGitignore(ctx) {
  if (!supportedCliGitignoreIssues(ctx.repoRoot).length) return [];
  const path = join4(ctx.repoRoot, ".gitignore");
  const current = safeReadText(path) ?? "";
  const next = `${current.replace(/\s*$/, "")}${current.trim() ? "\n\n" : ""}${SUPPORTED_CLI_GITIGNORE_BLOCK}
`;
  if (!ctx.dryRun) writeText(path, next);
  return [path];
}
function ensureSupportedCliProjections(ctx) {
  const changedFiles = [];
  const blockers = [];
  const managedSkills = join4(ctx.repoRoot, ".agents", "skills");
  const managedStat = lstatIfPresent(managedSkills);
  if (!managedStat || managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
    return { changedFiles, blockers: [".agents/skills must be a real BMAD-generated directory before CLI projections can be created"] };
  }
  for (const rootName of SUPPORTED_CLI_ROOTS) {
    const root = join4(ctx.repoRoot, rootName);
    const rootStat = lstatIfPresent(root);
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
      blockers.push(`${rootName} is not a real configuration directory`);
      continue;
    }
    if (!rootStat) {
      changedFiles.push(root);
      if (!ctx.dryRun) mkdirSync3(root, { recursive: false });
    }
    const skills = join4(root, "skills");
    const skillsStat = lstatIfPresent(skills);
    if (!skillsStat) {
      changedFiles.push(skills);
      if (!ctx.dryRun) symlinkSync(CANONICAL_CLI_SKILLS_ALIAS, skills, "dir");
      continue;
    }
    if (skillsStat.isSymbolicLink()) {
      try {
        if (readlinkSync(skills) !== CANONICAL_CLI_SKILLS_ALIAS || realpathSync(skills) !== realpathSync(managedSkills)) {
          blockers.push(`${rootName}/skills is not the managed .agents/skills alias`);
        }
      } catch {
        blockers.push(`${rootName}/skills is an unreadable or broken symlink`);
      }
    } else if (!skillsStat.isDirectory()) {
      blockers.push(`${rootName}/skills is not a directory`);
    }
  }
  return { changedFiles: [...new Set(changedFiles)].sort(), blockers };
}
function createBmadChecks() {
  return [
    {
      id: "bmad.scaffold",
      title: "BMAD modules/docs scaffold",
      audit: (ctx) => {
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: "bmad.scaffold",
            title: "BMAD modules/docs scaffold",
            status: "fail",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            details: [manifestSelection.error],
            fixable: false
          };
        }
        const targetRoot = join4(ctx.repoRoot, "_bmad");
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
        const missing = sentinels.filter((file) => !existsSync3(join4(targetRoot, file)));
        const projectNameIssues = bmadProjectNameIssues(ctx.repoRoot);
        const details = [
          ...missing.map((file) => `_bmad/${file}`),
          ...projectNameIssues.details
        ];
        return {
          id: "bmad.scaffold",
          title: "BMAD modules/docs scaffold",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "BMAD scaffold and project identity parity verified" : `${details.length} BMAD scaffold issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            changedFiles,
            details: [manifestSelection.error]
          };
        }
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        if (ctx.dryRun) {
          const sentinels = requiredBmadSentinels(ctx.repoRoot, selectedModules);
          changedFiles.push(...sentinels.map((file) => join4(ctx.repoRoot, "_bmad", file)).filter((path) => !existsSync3(path)));
          changedFiles.push(...bmadProjectNameIssues(ctx.repoRoot).paths);
          return {
            id: finding2.id,
            title: finding2.title,
            status: changedFiles.length ? "applied" : "noop",
            summary: changedFiles.length ? "Would run non-interactive bmad-method install" : "No changes required",
            changedFiles,
            details: [
              `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules)}`
            ]
          };
        }
        const expectedChangedPaths = [
          ...requiredBmadSentinels(ctx.repoRoot, selectedModules).map((file) => join4(ctx.repoRoot, "_bmad", file)).filter((path) => !existsSync3(path)),
          ...bmadProjectNameIssues(ctx.repoRoot).paths
        ];
        const evicted = evictLegacyBmadPackState(ctx, changedFiles);
        const install = runBmadInstall(ctx.repoRoot, selectedModules);
        if (!install.ok) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: `Failed to run bmad-method install`,
            changedFiles: [],
            details: [...evicted, install.error ?? "Unknown error"]
          };
        }
        changedFiles.push(...expectedChangedPaths.filter(existsSync3));
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Installed BMAD scaffold via bmad-method" : "No changes required",
          changedFiles,
          details: evicted
        };
      }
    },
    {
      id: "bmad.version",
      title: "BMAD version currency",
      audit: (ctx) => {
        const installed = readInstalledBmadVersion(ctx.repoRoot);
        if (!installed) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "skip",
            summary: existsSync3(join4(ctx.repoRoot, "_bmad")) ? "BMAD installed but version manifest unreadable" : "No BMAD install present",
            details: [],
            fixable: false
          };
        }
        const pinned = ctx.bmadVersionPin?.trim();
        const resolved = pinned ? void 0 : resolveBmadDistTags(ctx.homeDir);
        const available = pinned ?? resolved?.distTags?.[BMAD_TARGET_CHANNEL];
        if (!available) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "skip",
            summary: `BMAD ${installed} installed; latest ${BMAD_TARGET_CHANNEL} version unknown (npm unreachable)`,
            details: [`Could not resolve ${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL} from npm`],
            fixable: false
          };
        }
        const targetLabel = pinned ? `pinned ${available}` : `${BMAD_TARGET_CHANNEL} ${available}`;
        const staleNote = resolved?.stale ? `  ${glyph.dot} cached` : "";
        const comparison = compareBmadVersions(installed, available);
        if (pinned ? comparison === 0 : comparison >= 0) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "pass",
            summary: `BMAD ${installed} is current (${targetLabel})${staleNote}`,
            details: [],
            fixable: false
          };
        }
        const pinnedMismatch = Boolean(pinned && comparison !== 0);
        const stable = resolved?.distTags.latest;
        if (!pinned && !stable) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "skip",
            summary: `BMAD ${installed} installed; stable currency floor unknown (${BMAD_NPM_PACKAGE} latest unresolved)`,
            details: [`installed: ${installed}`, `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`],
            fixable: false
          };
        }
        const behindStable = !pinned && stable ? compareBmadVersions(installed, stable) < 0 : false;
        if (!pinned && !behindStable) {
          return {
            id: "bmad.version",
            title: "BMAD version currency",
            status: "pass",
            summary: `BMAD ${installed} is at or ahead of stable ${stable ?? "unknown"}; ${targetLabel} available${staleNote}`,
            details: [
              `installed: ${installed}`,
              `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
              stable ? `stable latest: ${stable}` : "",
              "run `pj migrate bmad.version` to take the prerelease"
            ].filter(Boolean),
            fixable: false
          };
        }
        return {
          id: "bmad.version",
          title: "BMAD version currency",
          status: pinnedMismatch ? "fail" : "warn",
          summary: pinnedMismatch ? `BMAD ${installed} does not match ${targetLabel}` : `BMAD ${installed} is behind stable ${stable} \u2014 upgrade available`,
          details: [
            `installed: ${installed}`,
            pinned ? `required transaction pin: ${available}` : `available: ${available}  (${BMAD_NPM_PACKAGE}@${BMAD_TARGET_CHANNEL})`,
            !pinned && stable ? `stable latest: ${stable}` : "",
            "run `pj migrate bmad.version` to upgrade"
          ].filter(Boolean),
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        if (finding2.status === "skip") {
          return { id: finding2.id, title: finding2.title, status: "noop", summary: finding2.summary, changedFiles: [], details: [] };
        }
        {
          const current = readInstalledBmadVersion(ctx.repoRoot);
          const target = ctx.bmadVersionPin?.trim() ?? resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
          if (!current || !target || compareBmadVersions(current, target) === 0) {
            return { id: finding2.id, title: finding2.title, status: "noop", summary: "BMAD already current", changedFiles: [], details: [] };
          }
        }
        const installed = readInstalledBmadVersion(ctx.repoRoot);
        const available = ctx.bmadVersionPin?.trim() ?? resolveBmadDistTags(ctx.homeDir)?.distTags?.[BMAD_TARGET_CHANNEL];
        const manifestPath = join4(ctx.repoRoot, "_bmad", "_config", "manifest.yaml");
        const manifestSelection = manifestBmadModules(ctx.repoRoot);
        if (manifestSelection.status === "invalid") {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "BMAD module manifest is invalid; refusing fallback module selection",
            changedFiles: [],
            details: [manifestSelection.error]
          };
        }
        const selectedModules = manifestSelection.status === "valid" ? manifestSelection.modules : configuredBmadModules(ctx.repoRoot) ?? [...DEFAULT_BMAD_MODULES];
        if (ctx.dryRun) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "applied",
            summary: `Would upgrade BMAD ${installed ?? "?"} -> ${available ?? BMAD_TARGET_CHANNEL}`,
            changedFiles: [manifestPath],
            details: [
              `Would run: ${bmadInstallDisplay(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL)}`
            ]
          };
        }
        const install = runBmadInstall(ctx.repoRoot, selectedModules, available ?? BMAD_TARGET_CHANNEL);
        if (!install.ok) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Failed to upgrade BMAD via installer",
            changedFiles: [],
            details: [install.error ?? "Unknown error"]
          };
        }
        const evictedChanges = [];
        const evicted = evictLegacyBmadPackState(ctx, evictedChanges);
        const nowInstalled = readInstalledBmadVersion(ctx.repoRoot);
        const upgraded = Boolean(nowInstalled && installed && compareBmadVersions(nowInstalled, installed) > 0);
        const changed = Array.from(/* @__PURE__ */ new Set([
          ...upgraded ? [manifestPath] : [],
          ...evictedChanges
        ]));
        return {
          id: finding2.id,
          title: finding2.title,
          status: changed.length ? "applied" : "noop",
          summary: upgraded ? `Upgraded BMAD ${installed} -> ${nowInstalled}` : `BMAD reinstalled (${nowInstalled ?? "?"})`,
          changedFiles: changed,
          details: evicted
        };
      }
    },
    {
      id: "bmad.cli-roots",
      title: "Supported BMAD CLI projection roots",
      audit: (ctx) => {
        const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS);
        const present = unsupportedNames.filter((name) => existsSync3(join4(ctx.repoRoot, name)));
        const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
        const supportedIssues = supportedCliProjectionIssues(ctx.repoRoot);
        const details = [
          ...supportedIssues,
          ...supportedCliGitignoreIssues(ctx.repoRoot),
          ...attestations.map((entry) => `${entry.name}: ${entry.safe ? "generated and safely removable" : `ambiguous/user-owned \u2014 ${entry.reason}`}`)
        ];
        return {
          id: "bmad.cli-roots",
          title: "Supported BMAD CLI projection roots",
          status: details.length ? "fail" : "pass",
          summary: details.length ? `${supportedIssues.length} supported projection issue(s); ${present.length} unsupported root(s)` : "All six supported CLI projections are configured and no unsupported roots are present",
          details,
          fixable: attestations.every((entry) => entry.safe)
        };
      },
      migrate: (ctx, finding2) => {
        const unsupportedNames = Object.keys(UNSUPPORTED_BMAD_ROOTS);
        const present = unsupportedNames.filter((name) => existsSync3(join4(ctx.repoRoot, name)));
        const attestations = present.map((name) => ({ name, ...unsupportedRootAttestation(ctx.repoRoot, name) }));
        const blocked = attestations.filter((entry) => !entry.safe);
        if (blocked.length) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Refusing to remove ambiguous or user-owned CLI projection roots",
            changedFiles: [],
            details: blocked.map((entry) => `${entry.name}: ${entry.reason}`)
          };
        }
        const projectionResult = ensureSupportedCliProjections(ctx);
        if (projectionResult.blockers.length) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Supported CLI projections contain unsafe or user-owned conflicts",
            changedFiles: [],
            details: projectionResult.blockers
          };
        }
        const gitignoreChanges = ensureSupportedCliGitignore(ctx);
        const removedRoots = attestations.map((entry) => join4(ctx.repoRoot, entry.name));
        if (!ctx.dryRun) for (const path of removedRoots) rmSync(path, { recursive: true, force: true });
        const changedFiles = [.../* @__PURE__ */ new Set([...projectionResult.changedFiles, ...gitignoreChanges, ...removedRoots])].sort();
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? `Reconciled six supported projections and removed ${removedRoots.length} attested unsupported root(s)` : "No changes required",
          changedFiles,
          details: attestations.map((entry) => `${entry.name}: ${entry.reason}`)
        };
      }
    }
  ];
}
function createHermesChecks() {
  return [
    {
      id: "hermes.pm-scaffold",
      title: "Hermes orchestrator scaffold parity",
      audit: (ctx) => {
        const selection = managedHermesScaffoldRoles(ctx);
        if (selection.roles.length === 0 && selection.blockers.length === 0) {
          return { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "skip", summary: "No provisioned pm or director role present", details: [], fixable: false };
        }
        const details = [...selection.blockers];
        const templateRoleDir = join4(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
        const managedScripts = templateFiles(join4(templateRoleDir, ".scripts")).filter((rel) => rel !== "sentinel.prompt.md.jinja");
        for (const role of selection.roles) {
          const prefix = role.agentId || role.role;
          for (const rel of ["role.yaml", "SOUL.md", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md"]) {
            if (!existsSync3(join4(role.roleDir, rel))) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, join4(role.roleDir, rel))}`);
          }
          const wrapper = join4(role.roleDir, "hermes");
          const expectedWrapper = renderHermesWrapper(role, templateRoleDir);
          if (!existsSync3(wrapper)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, wrapper)}`);
          else if (safeReadText(wrapper) !== expectedWrapper) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, wrapper)}`);
          const expectedIgnore = readText(join4(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role);
          const ignorePath = join4(role.roleDir, ".gitignore");
          if (!existsSync3(ignorePath)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, ignorePath)}`);
          else if (safeReadText(ignorePath) !== expectedIgnore) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, ignorePath)}`);
          for (const rel of managedScripts) {
            const source = join4(templateRoleDir, ".scripts", rel);
            const target = join4(role.roleDir, ".scripts", rel);
            if (!existsSync3(target)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, target)}`);
            else if (safeReadText(target) !== readText(source)) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, target)}`);
          }
          const promptPath = join4(role.roleDir, ".scripts", "sentinel.prompt.md");
          if (!existsSync3(promptPath)) details.push(`${prefix}: missing ${relative2(ctx.repoRoot, promptPath)}`);
          else if (safeReadText(promptPath) !== renderSentinelPrompt(role, templateRoleDir)) details.push(`${prefix}: stale ${relative2(ctx.repoRoot, promptPath)}`);
          if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) details.push(`${prefix}: .gitmodules contains retired ${role.role} runtime submodule mapping`);
          if (!profileMetaInheritsDefault(join4(role.roleDir, "runtime", "profile.yaml"))) details.push(`${prefix}: runtime/profile.yaml missing inherited default config metadata`);
          const registry = safeReadText(registryPath(ctx.homeDir));
          if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
        }
        return {
          id: "hermes.pm-scaffold",
          title: "Hermes orchestrator scaffold parity",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? `${selection.roles.length} orchestrator scaffold(s) verified` : `${details.length} orchestrator scaffold issue(s) detected`,
          details,
          fixable: selection.blockers.length === 0
        };
      },
      migrate: (ctx, finding2) => {
        const selection = managedHermesScaffoldRoles(ctx);
        const changedFiles = [];
        const details = [];
        if (selection.blockers.length > 0) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "Provisioned orchestrator manifest is invalid", changedFiles, details: selection.blockers };
        }
        if (selection.roles.length === 0) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "No provisioned pm or director role present", changedFiles, details: [] };
        }
        const templateRoleDir = join4(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
        const managedScripts = templateFiles(join4(templateRoleDir, ".scripts")).filter((rel) => rel !== "sentinel.prompt.md.jinja");
        for (const role of selection.roles) {
          const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
          details.push(...retirement.details);
          if (!retirement.ok) {
            return { id: finding2.id, title: finding2.title, status: "blocked", summary: `Failed to retire ${role.role} runtime submodule metadata safely`, changedFiles, details: [retirement.error ?? "unknown runtime retirement failure"] };
          }
          if (!existsSync3(join4(role.roleDir, "SOUL.md"))) writeIfDifferent(join4(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
          writeIfDifferent(join4(role.roleDir, "hermes"), renderHermesWrapper(role, templateRoleDir), ctx.dryRun, changedFiles, 493);
          writeIfDifferent(join4(role.roleDir, ".gitignore"), readText(join4(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role), ctx.dryRun, changedFiles);
          copyMissingRecursive(join4(templateRoleDir, ".runtime-scaffold"), join4(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
          copyMissingRecursive(join4(templateRoleDir, ".runtime-scaffold"), join4(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
          for (const rel of managedScripts) {
            const source = join4(templateRoleDir, ".scripts", rel);
            const executable = (lstatSync2(source).mode & 73) !== 0;
            writeIfDifferent(join4(role.roleDir, ".scripts", rel), readText(source), ctx.dryRun, changedFiles, executable ? 493 : void 0);
          }
          writeIfDifferent(join4(role.roleDir, ".scripts", "sentinel.prompt.md"), renderSentinelPrompt(role, templateRoleDir), ctx.dryRun, changedFiles);
          const profileMetaUpdated = upsertInheritedProfileMeta(join4(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
          if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
          const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
          if (registryUpdated) details.push(`updated ${registryUpdated}`);
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? `${selection.roles.length} orchestrator scaffold(s) normalized` : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.untracked-runtimes",
      title: "Hermes agent runtimes untracked + gitignored",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (roles.length === 0) {
          return {
            id: "hermes.untracked-runtimes",
            title: "Hermes agent runtimes untracked + gitignored",
            status: "skip",
            summary: "No Hermes roles present",
            details: [],
            fixable: false
          };
        }
        const details = [];
        for (const role of roles) {
          const roleRelDir = relative2(ctx.repoRoot, role.roleDir);
          const runtimeRelPath = join4(roleRelDir, "runtime");
          const lsResult = spawnSync("git", ["ls-files", "--stage", runtimeRelPath], {
            cwd: ctx.repoRoot,
            encoding: "utf8"
          });
          if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
            details.push(`submodule runtime is tracked in Git index at ${runtimeRelPath}`);
          }
          if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) {
            details.push(`stale .gitmodules mapping exists for ${runtimeRelPath}`);
          }
          const gitignorePath = join4(role.roleDir, ".gitignore");
          if (existsSync3(gitignorePath)) {
            const content = safeReadText(gitignorePath) ?? "";
            const lines = content.split(/\r?\n/).map((line) => line.trim());
            if (!lines.includes("runtime/") && !lines.includes("runtime")) {
              details.push(`.gitignore missing runtime/ ignore entry in ${relative2(ctx.repoRoot, gitignorePath)}`);
            }
          } else {
            details.push(`.gitignore is missing in ${relative2(ctx.repoRoot, gitignorePath)}`);
          }
        }
        return {
          id: "hermes.untracked-runtimes",
          title: "Hermes agent runtimes untracked + gitignored",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "All Hermes agent runtimes are untracked and gitignored" : `${details.length} issue(s) with untracked/ignored runtimes detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        for (const role of roles) {
          const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
          details.push(...retirement.details);
          if (!retirement.ok) {
            return {
              id: finding2.id,
              title: finding2.title,
              status: "blocked",
              summary: "Failed to retire Hermes runtime submodule metadata safely",
              changedFiles,
              details: [retirement.error ?? "unknown runtime retirement failure"]
            };
          }
          const gitignorePath = join4(role.roleDir, ".gitignore");
          let content = "";
          let isIgnored = false;
          if (existsSync3(gitignorePath)) {
            content = safeReadText(gitignorePath) ?? "";
            const lines = content.split(/\r?\n/).map((line) => line.trim());
            isIgnored = lines.includes("runtime/") || lines.includes("runtime");
          }
          if (!isIgnored) {
            details.push(`ignore runtime/ in ${relative2(ctx.repoRoot, gitignorePath)}`);
            changedFiles.push(gitignorePath);
            if (!ctx.dryRun) {
              if (content && !content.endsWith("\n")) {
                content += "\n";
              }
              content += "runtime/\n";
              writeText(gitignorePath, content);
            }
          }
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? "applied" : "noop",
          summary: changedFiles.length ? "Hermes agent runtimes made untracked and ignored" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "systemd.sentinel",
      title: "Hermes systemd/sentinel units enabled + active",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const requiredRoles = roles.filter((role) => role.deploymentSystemd !== "deferred");
        if (!requiredRoles.length) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "pass", summary: "systemd is intentionally deferred for every local-only Hermes role", details: [], fixable: false };
        }
        const probe = systemctlUser(["is-system-running"]);
        if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
          return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "warn", summary: "systemd --user unavailable; unit state not auditable here", details: [], fixable: false };
        }
        const details = [];
        for (const role of requiredRoles) {
          for (const unit of [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`]) {
            const state = checkUnit(unit);
            if (!state.enabled || !state.active) details.push(`${unit} should be enabled+active`);
          }
        }
        return {
          id: "systemd.sentinel",
          title: "Hermes systemd/sentinel units enabled + active",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Hermes user units are enabled and active" : `${details.length} systemd parity issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const roles = discoverRoles(ctx.repoRoot).filter((role) => role.deploymentSystemd !== "deferred");
        const changedFiles = [];
        const details = [];
        if (!roles.length) {
          return { id: finding2.id, title: finding2.title, status: "skipped", summary: "systemd is intentionally deferred for local-only Hermes roles", changedFiles, details };
        }
        const probe = systemctlUser(["is-system-running"]);
        if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
        }
        for (const role of roles) {
          const sysDir = join4(ctx.homeDir, ".config", "systemd", "user");
          const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`];
          const allUnitsPresent = units.every((unit) => existsSync3(join4(sysDir, unit)));
          const unitsStale = units.some((unit) => {
            const text3 = safeReadText(join4(sysDir, unit));
            if (text3 === null) return true;
            return text3.includes("/agents/hermes/") && !text3.includes(role.roleDir);
          });
          if (allUnitsPresent && !unitsStale) {
            if (ctx.dryRun) {
              details.push(`would run: systemctl --user enable --now ${units.join(" ")}`);
            } else {
              systemctlUser(["daemon-reload"]);
              for (const unit of units) {
                systemctlUser(["enable", "--now", unit]);
              }
            }
            continue;
          }
          for (const script of [join4(role.roleDir, ".scripts", "70-systemd.sh")]) {
            if (!existsSync3(script)) {
              details.push(`script failed: missing ${script}`);
              continue;
            }
            if (ctx.dryRun) {
              details.push(`would run: FORCE_SYSTEMD=1 bash ${script}`);
            } else {
              const result2 = spawnSync("bash", [script], {
                cwd: role.roleDir,
                encoding: "utf8",
                env: { ...process.env, FORCE_SYSTEMD: "1" }
              });
              if (result2.status !== 0) {
                details.push(`script failed: ${script}: ${result2.stderr.trim() || result2.stdout.trim()}`);
              } else {
                details.push(`regenerated systemd units for ${role.agentId} from ${role.roleDir}`);
              }
            }
          }
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: details.length ? ctx.dryRun ? "Planned systemd remediation commands" : "Attempted systemd remediation" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.runtime-singleton",
      title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "hermes.runtime-singleton", title: "Hermes singleton runtime (shared config/auth, per-agent memory)", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          if (!existsSync3(plan.fleetRoot)) {
            details.push(`fleet root missing at ${plan.fleetRoot}`);
            continue;
          }
          if (!existsSync3(plan.profileDir)) {
            details.push(`profile dir missing: ${plan.profileDir}`);
          } else if (lstatSync2(plan.profileDir).isSymbolicLink()) {
            details.push(`profile dir is a symlink (must be a real dir): ${plan.profileDir}`);
          }
          for (const link of plan.links) {
            const state = linkState(link.path, link.target);
            if (state !== "ok") details.push(`${state}: ${link.path} -> ${link.target}`);
          }
          details.push(...profileConfigFindings(plan.profileDir, profileNameOf(role)));
        }
        return {
          id: "hermes.runtime-singleton",
          title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Singleton runtime contract satisfied" : `${details.length} singleton-runtime issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          if (!existsSync3(plan.fleetRoot)) {
            details.push(`blocked: fleet root missing at ${plan.fleetRoot}`);
            continue;
          }
          for (const shared of plan.sharedSeeds) {
            if (existsSync3(shared.rootPath)) continue;
            const donor = existsSync3(shared.runtimePath) ? shared.runtimePath : null;
            if (!donor) continue;
            details.push(`seed fleet ${basename2(shared.rootPath)} from ${donor}`);
            changedFiles.push(shared.rootPath);
            if (!ctx.dryRun) copyFileSync(donor, shared.rootPath);
          }
          if (existsSync3(plan.profileDir) && lstatSync2(plan.profileDir).isSymbolicLink()) {
            details.push(`convert profile symlink to real dir: ${plan.profileDir}`);
            changedFiles.push(plan.profileDir);
            if (!ctx.dryRun) unlinkSync(plan.profileDir);
          }
          if (!existsSync3(plan.profileDir)) {
            details.push(`create profile dir: ${plan.profileDir}`);
            changedFiles.push(plan.profileDir);
            if (!ctx.dryRun) mkdirSync3(plan.profileDir, { recursive: true });
          }
          for (const link of plan.links) {
            const state = linkState(link.path, link.target);
            if (state === "ok") continue;
            if (link.ensureTargetDir && !existsSync3(link.target) && !ctx.dryRun) {
              mkdirSync3(link.target, { recursive: true });
            }
            details.push(`link ${link.path} -> ${link.target}`);
            changedFiles.push(link.path);
            if (ctx.dryRun) continue;
            if (existsSync3(link.path) || isDanglingLink(link.path)) {
              const lst = lstatSync2(link.path);
              if (lst.isSymbolicLink()) {
                unlinkSync(link.path);
              } else {
                const parked = `${link.path}.pre-singleton`;
                renameSync(link.path, parked);
                details.push(`parked pre-existing ${link.path} at ${parked}`);
              }
            }
            ensureParent(link.path);
            symlinkSync(link.target, link.path);
          }
          const profileName = profileNameOf(role);
          if (profileConfigFindings(plan.profileDir, profileName).length) {
            const renderer = profileRendererPath(ctx);
            if (!renderer) {
              details.push(`blocked: profile renderer not found (expected hermes-agent-template/scripts/hermes-profile-config.py); cannot render ${plan.profileDir}/config.yaml`);
            } else {
              details.push(`render config.yaml + pin memory bank for ${profileName}`);
              changedFiles.push(join4(plan.profileDir, "config.yaml"), join4(plan.profileDir, "config.delta.yaml"));
              if (!ctx.dryRun) {
                for (const args of [["init", "--profile", profileName], ["memory-pin", "--profile", profileName]]) {
                  const res = spawnSync("python3", [renderer, ...args], { encoding: "utf8" });
                  if (res.status !== 0) {
                    details.push(`blocked: ${basename2(renderer)} ${args[0]} failed for ${profileName}: ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
                  }
                }
              }
            }
          }
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: details.some((d) => d.startsWith("blocked:")) ? "blocked" : changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          // PJAN-75: the summary has to follow the status. The blocked branch was
          // missing here, so a run that stopped on a missing profile renderer
          // still reported "Singleton runtime wired" -- and that string is what
          // surfaced as the recipe's ERROR message, telling the operator the
          // exact opposite of what happened.
          summary: details.some((d) => d.startsWith("blocked:")) ? "Singleton-runtime wiring blocked" : changedFiles.length ? ctx.dryRun ? "Planned singleton-runtime wiring" : "Singleton runtime wired" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      // Fleet-base invariants. Every profile inherits ~/.hermes/config.yaml by
      // generation, so a defect here is a defect in EVERY agent at once — and each
      // of these has already shipped silently: no error, no log, just an agent
      // quietly missing a capability.
      id: "hermes.fleet-config",
      title: "Fleet base config carries the capabilities every agent inherits",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "hermes.fleet-config", title: "Fleet base config carries the capabilities every agent inherits", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const base = join4(fleetHome(ctx), "config.yaml");
        const details = [];
        let cfg = null;
        if (!existsSync3(base)) {
          details.push(`fleet base config missing: ${base}`);
        } else {
          try {
            cfg = YAML.parse(readFileSync2(base, "utf8")) ?? {};
          } catch (err) {
            details.push(`fleet base config is unparseable YAML: ${base} (${err.message})`);
          }
        }
        if (cfg) {
          const ttsProvider = cfg?.tts?.provider;
          if (ttsProvider && ttsProvider !== "vox") {
            details.push(`tts.provider is "${ttsProvider}" \u2014 must be "vox" (registry key). "voxxy" is the service name and matches no registered provider, so TTS silently falls back to a built-in.`);
          }
          const hooks = cfg?.hooks;
          const REQUIRED_HOOKS = ["on_session_start", "on_session_end", "pre_tool_call", "post_tool_call"];
          if (!hooks || typeof hooks !== "object") {
            details.push(`no hooks: block in the fleet base \u2014 every agent publishes zero Bloodbank lifecycle events: ${base}`);
          } else {
            const missing = REQUIRED_HOOKS.filter((h) => !hooks[h]);
            if (missing.length) details.push(`fleet base hooks missing event(s): ${missing.join(", ")}`);
            const serialized = JSON.stringify(hooks);
            if (!serialized.includes("hooks/bloodbank/publish.py")) {
              details.push(`fleet base hooks do not call the canonical publisher (~/.agents/hooks/bloodbank/publish.py --client hermes)`);
            }
          }
          const provider = cfg?.memory?.provider;
          if (!provider) {
            details.push(`memory.provider is unset in the fleet base \u2014 agents get no external memory`);
          }
          const disabled = cfg?.agent?.disabled_toolsets;
          if (Array.isArray(disabled) && disabled.includes("memory")) {
            details.push(`agent.disabled_toolsets contains "memory" \u2014 memory tools are suppressed fleet-wide even though memory.provider is set (auto recall/retain still runs, which masks it)`);
          }
          const dirs = cfg?.skills?.external_dirs;
          if (!Array.isArray(dirs) || dirs.length === 0) {
            details.push(`skills.external_dirs is empty in the fleet base \u2014 no agent can see any shared skill`);
          }
        }
        return {
          id: "hermes.fleet-config",
          title: "Fleet base config carries the capabilities every agent inherits",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Fleet base config invariants satisfied" : `${details.length} fleet-base config issue(s) detected`,
          details,
          // Deliberately not auto-fixable: these are fleet-wide values whose
          // correct setting is an operator decision, and a wrong guess would
          // change behavior for every agent simultaneously.
          fixable: false
        };
      },
      // The audit above is `fixable: false`, so `migrate --all` never selects
      // this rule -- but naming it explicitly must still produce an answer. It
      // shipped with no migrate at all, which the registry surfaced as
      // "migrate threw: check.migrate is not a function": true, but useless.
      migrate: (ctx, finding2) => ({
        id: finding2.id,
        title: finding2.title,
        status: "blocked",
        summary: "Fleet base config is operator-owned; pjangler will not guess fleet-wide values",
        changedFiles: [],
        details: finding2.details.length ? [...finding2.details, `Edit ${join4(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`] : [`Edit ${join4(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`]
      })
    },
    {
      id: "hermes.profile-wiring",
      title: "Launcher + systemd HERMES_HOME points at the named profile",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        if (!roles.length) {
          return { id: "hermes.profile-wiring", title: "Launcher + systemd HERMES_HOME points at the named profile", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
        }
        const details = [];
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          const launcher2 = join4(role.roleDir, "hermes");
          const text3 = safeReadText(launcher2);
          if (text3 === null) {
            details.push(`launcher missing: ${relative2(ctx.repoRoot, launcher2)}`);
          } else {
            const assigned = /^HERMES_HOME=(.*)$/m.exec(text3)?.[1]?.trim();
            if (assigned !== void 0 && !isProfileHomeExpr(assigned)) {
              details.push(`launcher sets HERMES_HOME=${assigned} instead of the named profile dir (disables shared auth + profile identity): ${relative2(ctx.repoRoot, launcher2)}`);
            }
            if (/HERMES_OAUTH_FILE/.test(text3)) {
              details.push(`launcher exports HERMES_OAUTH_FILE, which Hermes does not implement (dead config): ${relative2(ctx.repoRoot, launcher2)}`);
            }
          }
          for (const unit of profileUnits(role)) {
            const unitPath = join4(ctx.homeDir, ".config", "systemd", "user", unit);
            const unitText = safeReadText(unitPath);
            if (unitText === null) continue;
            const current = /^Environment=HERMES_HOME=(.*)$/m.exec(unitText)?.[1]?.trim();
            if (current && current !== plan.profileDir) {
              details.push(`${unit} HERMES_HOME=${current} (expected ${plan.profileDir})`);
            }
            if (/^Environment=HERMES_OAUTH_FILE=/m.test(unitText)) {
              details.push(`${unit} sets HERMES_OAUTH_FILE (dead config)`);
            }
          }
        }
        return {
          id: "hermes.profile-wiring",
          title: "Launcher + systemd HERMES_HOME points at the named profile",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "HERMES_HOME wiring is in parity" : `${details.length} HERMES_HOME wiring issue(s) detected`,
          details,
          fixable: true
        };
      },
      migrate: (ctx, finding2) => {
        const roles = discoverRoles(ctx.repoRoot);
        const changedFiles = [];
        const details = [];
        let unitsTouched = false;
        for (const role of roles) {
          const plan = singletonPlan(ctx, role);
          const launcher2 = join4(role.roleDir, "hermes");
          const text3 = safeReadText(launcher2);
          if (text3 !== null) {
            const before = /^HERMES_HOME=(.*)$/m.exec(text3)?.[1]?.trim();
            const rewritten = rewriteLauncher(text3, role.profileName || role.agentId);
            if (rewritten !== text3) {
              const rel = relative2(ctx.repoRoot, launcher2);
              if (before !== void 0 && !isProfileHomeExpr(before)) {
                details.push(`rewrite launcher HERMES_HOME ${before} -> ${plan.profileDir}: ${rel}`);
              }
              if (/HERMES_OAUTH_FILE/.test(text3)) {
                details.push(`strip dead HERMES_OAUTH_FILE export: ${rel}`);
              }
              writeIfDifferent(launcher2, rewritten, ctx.dryRun, changedFiles, 493);
            }
          }
          for (const unit of profileUnits(role)) {
            const unitPath = join4(ctx.homeDir, ".config", "systemd", "user", unit);
            const unitText = safeReadText(unitPath);
            if (unitText === null) continue;
            let next = unitText.replace(/^Environment=HERMES_HOME=.*$/m, `Environment=HERMES_HOME=${plan.profileDir}`);
            next = next.replace(/^Environment=HERMES_OAUTH_FILE=.*\n/m, "");
            if (next !== unitText) {
              details.push(`repoint ${unit} HERMES_HOME -> ${plan.profileDir}`);
              writeIfDifferent(unitPath, next, ctx.dryRun, changedFiles);
              unitsTouched = true;
            }
          }
        }
        if (unitsTouched && !ctx.dryRun) {
          systemctlUser(["daemon-reload"]);
          details.push("systemctl --user daemon-reload (restart units to pick up the new HERMES_HOME)");
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: changedFiles.length ? ctx.dryRun ? "Planned HERMES_HOME rewiring" : "HERMES_HOME rewired to named profiles" : "No changes required",
          changedFiles,
          details
        };
      }
    },
    {
      id: "hermes.registry-parity",
      title: "Fleet registry matches .project.json (no duplicate or stale agents)",
      audit: (ctx) => {
        const roles = discoverRoles(ctx.repoRoot);
        const details = [];
        let malformedRoleGate = false;
        const registryPath2 = join4(ctx.homeDir, ".hermes", "agents-registry.yaml");
        const registry = readRegistry(registryPath2);
        if (!registry) {
          if (!roles.length && declaredAgentIds(ctx.repoRoot).length === 0) {
            return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles or declared agents present", details: [], fixable: false };
          }
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "warn", summary: `registry unreadable at ${registryPath2}`, details: [], fixable: false };
        }
        const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
        const owned = ownedRegistryEntries(registry, ctx.repoRoot);
        const unprovisioned = unprovisionedRoleAgents(registry, ctx.repoRoot, canonical);
        if (unprovisioned.length) {
          return {
            id: "hermes.registry-parity",
            title: "Fleet registry matches .project.json (no duplicate or stale agents)",
            status: "fail",
            summary: `${unprovisioned.length} unprovisioned Hermes role blocker(s) detected`,
            details: unprovisioned.map(
              ({ agentId, roleDir, sources }) => `agent "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role, do not delete its registry/declaration`
            ),
            fixable: false
          };
        }
        if (canonical.size === 0) {
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles, declarations, or registry entries present", details: [], fixable: false };
        }
        for (const [agentId, entry] of owned) {
          const roleDir = String(entry?.role_dir ?? "");
          if (!canonical.has(agentId)) {
            details.push(`stale/duplicate registry agent "${agentId}" for ${roleDir} (role.yaml declares ${[...canonical].join(", ")})`);
          }
        }
        for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
          details.push(`.project.json declares agent "${extra}" that no role.yaml claims`);
        }
        for (const role of roles) {
          const expectedBloodbankEnabled = roleBloodbankEnabled(role);
          if (expectedBloodbankEnabled === null) {
            details.push(`${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
            malformedRoleGate = true;
          }
          const entry = registry[role.agentId];
          if (!entry) {
            details.push(`registry is missing an entry for ${role.agentId}`);
            continue;
          }
          const entryRoleDir = String(entry.role_dir ?? "");
          if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
            details.push(`registry role_dir for ${role.agentId} is ${entryRoleDir} (expected ${role.roleDir})`);
          }
          const bin = String(entry.hermes?.bin ?? "");
          if (bin && !existsSync3(bin)) {
            details.push(`registry hermes.bin for ${role.agentId} does not exist: ${bin}`);
          }
          const bloodbank = entry.bloodbank ?? {};
          if (typeof bloodbank.enabled !== "boolean") {
            details.push(`registry entry for ${role.agentId} bloodbank.enabled must be a strict boolean`);
          } else if (expectedBloodbankEnabled !== null && bloodbank.enabled !== expectedBloodbankEnabled) {
            details.push(`registry entry for ${role.agentId} bloodbank.enabled must match explicit role value ${expectedBloodbankEnabled}`);
          }
          if (bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
            details.push(`registry entry for ${role.agentId} must advertise bloodbank { gateway_scope: fleet, target_agent_id: ${role.agentId} }`);
          }
          const systemd = entry.systemd ?? {};
          for (const key of LEGACY_SYSTEMD_KEYS) {
            if (systemd[key] !== void 0) {
              details.push(`registry entry for ${role.agentId} carries retired systemd.${key}; the fleet-shared Bloodbank gateway owns command ingress`);
            }
          }
          const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
          if (existsSync3(legacyUnit)) {
            details.push(`retired per-agent consumer unit still on disk: ${legacyUnit}`);
          }
        }
        return {
          id: "hermes.registry-parity",
          title: "Fleet registry matches .project.json (no duplicate or stale agents)",
          status: details.length === 0 ? "pass" : "fail",
          summary: details.length === 0 ? "Fleet registry is in parity" : `${details.length} registry parity issue(s) detected`,
          details,
          fixable: !malformedRoleGate
        };
      },
      migrate: (ctx, finding2) => {
        const changedFiles = [];
        const details = [];
        const registryPath2 = join4(ctx.homeDir, ".hermes", "agents-registry.yaml");
        let raw = safeReadText(registryPath2);
        if (raw === null) {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: `registry unreadable at ${registryPath2}`, changedFiles, details };
        }
        const roles = discoverRoles(ctx.repoRoot);
        const malformedRoleGates = roles.filter((role) => roleBloodbankEnabled(role) === null);
        if (malformedRoleGates.length > 0) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Registry parity is blocked by malformed role Bloodbank gates",
            changedFiles,
            details: malformedRoleGates.map(
              (role) => `${relative2(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`
            )
          };
        }
        const missingRoles = roles.filter((role) => !raw.includes(`${role.agentId}:`));
        for (const role of missingRoles) {
          const updated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
          if (updated) details.push(`add missing fleet registry entry for ${role.agentId}`);
          if (!ctx.dryRun) raw = safeReadText(registryPath2) ?? raw;
        }
        if (ctx.dryRun && missingRoles.length) {
          return { id: finding2.id, title: finding2.title, status: "skipped", summary: "Planned missing fleet registry entries", changedFiles: [...new Set(changedFiles)], details };
        }
        let doc;
        try {
          doc = YAML.parse(raw);
        } catch {
          return { id: finding2.id, title: finding2.title, status: "blocked", summary: "registry is not valid YAML", changedFiles, details };
        }
        const agents = doc?.agents ?? {};
        const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
        const unprovisioned = unprovisionedRoleAgents(agents, ctx.repoRoot, canonical);
        if (unprovisioned.length) {
          return {
            id: finding2.id,
            title: finding2.title,
            status: "blocked",
            summary: "Registry parity is blocked by an unprovisioned Hermes role",
            changedFiles,
            details: unprovisioned.map(
              ({ agentId, roleDir, sources }) => `blocked: "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role without pruning registry/declaration state`
            )
          };
        }
        const fleetBin = fleetBinPath(ctx);
        let dirty = false;
        if (canonical.size === 0) {
          for (const [agentId] of ownedRegistryEntries(agents, ctx.repoRoot)) {
            details.push(`blocked: "${agentId}" has no role.yaml; provision the role instead of pruning the registry`);
          }
          for (const agentId of declaredAgentIds(ctx.repoRoot)) {
            if (!details.some((detail) => detail.includes(`"${agentId}"`))) {
              details.push(`blocked: "${agentId}" is declared but has no role.yaml; provision or restore the role`);
            }
          }
          if (details.length) {
            return {
              id: finding2.id,
              title: finding2.title,
              status: "blocked",
              summary: "Registry parity is blocked by an unprovisioned Hermes role",
              changedFiles,
              details
            };
          }
        }
        for (const role of roles) {
          const entry = agents[role.agentId];
          if (!entry) continue;
          const entryRoleDir = String(entry.role_dir ?? "");
          if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
            details.push(`repoint ${role.agentId} role_dir -> ${role.roleDir}`);
            entry.role_dir = role.roleDir;
            entry.project_path = ctx.repoRoot;
            dirty = true;
          }
          const bloodbank = entry.bloodbank ?? {};
          const expectedBloodbankEnabled = roleBloodbankEnabled(role) ?? false;
          if (bloodbank.enabled !== expectedBloodbankEnabled || bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
            details.push(`normalize fleet bloodbank routing for ${role.agentId} with enabled=${expectedBloodbankEnabled}`);
            entry.bloodbank = { ...bloodbank, enabled: expectedBloodbankEnabled, gateway_scope: "fleet", target_agent_id: role.agentId };
            dirty = true;
          }
          const systemd = entry.systemd;
          if (systemd) {
            for (const key of LEGACY_SYSTEMD_KEYS) {
              if (systemd[key] !== void 0) {
                details.push(`drop retired systemd.${key} from ${role.agentId}`);
                delete systemd[key];
                dirty = true;
              }
            }
          }
          const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
          if (existsSync3(legacyUnit)) {
            if (ctx.dryRun) {
              details.push(`would remove retired consumer unit ${legacyUnit}`);
            } else {
              systemctlUser(["disable", "--now", basename2(legacyUnit)]);
              rmSync(legacyUnit, { force: true });
              systemctlUser(["daemon-reload"]);
              systemctlUser(["reset-failed"]);
              details.push(`removed retired consumer unit ${legacyUnit}`);
            }
            changedFiles.push(legacyUnit);
          }
        }
        for (const [agentId, entry] of ownedRegistryEntries(agents, ctx.repoRoot)) {
          if (canonical.size > 0 && !canonical.has(agentId)) {
            details.push(`drop stale/duplicate registry agent "${agentId}"`);
            delete agents[agentId];
            dropDeclaredAgent(ctx, agentId, changedFiles, details);
            dirty = true;
            continue;
          }
          const hermes = entry.hermes ?? {};
          if (fleetBin && String(hermes.bin ?? "") !== fleetBin && !existsSync3(String(hermes.bin ?? ""))) {
            details.push(`repoint ${agentId} hermes.bin -> ${fleetBin}`);
            hermes.bin = fleetBin;
            entry.hermes = hermes;
            dirty = true;
          }
          if (hermes.oauth_file) {
            details.push(`drop dead hermes.oauth_file from ${agentId}`);
            delete hermes.oauth_file;
            dirty = true;
          }
        }
        if (canonical.size > 0) {
          for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
            dropDeclaredAgent(ctx, extra, changedFiles, details);
          }
        }
        if (dirty) {
          changedFiles.push(registryPath2);
          if (!ctx.dryRun) {
            doc.agents = agents;
            writeText(registryPath2, YAML.stringify(doc));
          }
        }
        return {
          id: finding2.id,
          title: finding2.title,
          status: changedFiles.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
          summary: changedFiles.length ? ctx.dryRun ? "Planned registry repair" : "Fleet registry repaired" : "No changes required",
          changedFiles,
          details
        };
      }
    }
  ];
}
function createProjectMomoChecks() {
  return [
    {
      id: "momo-lifecycle-plane",
      title: "Momo lifecycle-plane readiness profile",
      audit: () => ({
        id: "momo-lifecycle-plane",
        title: "Momo lifecycle-plane readiness profile",
        status: "skip",
        summary: "Momo readiness is an audit-only profile; use audit --profile momo-lifecycle-plane",
        details: [],
        fixable: false
      }),
      migrate: (ctx, finding2) => ({
        id: finding2.id,
        title: finding2.title,
        status: "skipped",
        summary: "report-only profile; migration is intentionally skipped",
        changedFiles: [],
        details: ["Momo lifecycle-plane readiness checks are credential-bearing and are performed only by `audit --profile momo-lifecycle-plane`"]
      })
    }
  ];
}
function createProjectChecks() {
  return [
    ...createProjectJsonChecks(),
    ...createProjectProvenanceChecks(),
    ...createProjectMomoChecks()
  ];
}
function writeIfDifferent(path, content, dryRun, changedFiles, mode) {
  const normalized = content.endsWith("\n") ? content : `${content}
`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
}
function prettyTimestamp(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}
function formatAuditReport(report) {
  const counts = {};
  for (const rule of report.rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const idWidth = report.rules.reduce((width, rule) => Math.max(width, rule.id.length), 0);
  const tally = [];
  if (counts.pass) tally.push(green(`${counts.pass} passed`));
  if (counts.fail) tally.push(red(`${counts.fail} failed`));
  if (counts.warn) tally.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.skip) tally.push(gray(`${counts.skip} skipped`));
  const overall = report.ok ? `${green(glyph.pass)} ${bold("Parity audit passed")}` : `${red(glyph.fail)} ${bold("Parity audit failed")}`;
  const lines = [""];
  lines.push(`  ${overall}${tally.length ? `  ${dim(glyph.dot)}  ${joinDot(tally)}` : ""}`);
  lines.push(`  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(prettyTimestamp(report.auditedAt))}`);
  lines.push("");
  for (const rule of report.rules) {
    const style = statusStyle(rule.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(rule.id.padEnd(idWidth))}  ${rule.summary}`);
    for (const detail of rule.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}
function formatMigrationReport(report) {
  const idWidth = report.results.reduce((width, result2) => Math.max(width, result2.id.length), 0);
  const blocked = report.results.filter((result2) => result2.status === "blocked").length;
  const partial = report.results.filter((result2) => result2.status === "partial").length;
  const overall = report.ok ? `${green(glyph.pass)} ${bold(report.dryRun ? "Migration preview complete" : "Migration complete")}` : blocked ? `${red(glyph.fail)} ${bold("Migration finished with blockers")}` : `${yellow(glyph.warn)} ${bold(`Migration incomplete  ${glyph.dot}  ${partial} rule${partial === 1 ? "" : "s"} still failing`)}`;
  const lines = [""];
  lines.push(`  ${overall}${report.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim(report.repo)}`);
  if (report.selectedRules.length) lines.push(`  ${dim(`rules: ${report.selectedRules.join(", ")}`)}`);
  lines.push("");
  for (const result2 of report.results) {
    const style = statusStyle(result2.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(result2.id.padEnd(idWidth))}  ${result2.summary}  ${dim(`[${style.label}]`)}`);
    for (const detail of result2.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
    for (const file of result2.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  if (report.changedFiles.length) {
    lines.push("");
    lines.push(`  ${bold(`Changed files (${report.changedFiles.length})`)}`);
    for (const file of report.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  const unresolved = partial + blocked;
  if (unresolved) {
    lines.push("");
    lines.push(`  ${dim(`Run \`pjangler audit\` for the full detail on the ${unresolved} rule${unresolved === 1 ? "" : "s"} still failing.`)}`);
  }
  lines.push("");
  return lines.join("\n");
}
var RULE_HINT_WIDTH = 72;
var RULE_TITLE_COLUMN = 44;
var RULE_ROW_TARGET = 116;
var RULE_HINT_MIN = 28;
var RULE_ROW_CHROME = 7;
function elide(value, width) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1)).trimEnd()}\u2026`;
}
function ruleHint(rule, budget) {
  const summary = rule.summary.replace(/\s+/g, " ").trim();
  const fragments = [];
  if (summary) fragments.push(summary);
  if (rule.details.length === 1) {
    fragments.push(`${glyph.arrow} ${rule.details[0]}`);
  } else if (rule.details.length > 1) {
    fragments.push(`${glyph.arrow} ${rule.details.length} details`);
  }
  const hint = elide(fragments.join(` ${glyph.dot} `), budget);
  return hint || void 0;
}
function formatRulePicker(rules) {
  const titleColumn = Math.min(
    RULE_TITLE_COLUMN,
    rules.reduce((width, rule) => Math.max(width, rule.title.length), 0)
  );
  const options = rules.map((rule) => {
    const style = statusStyle(rule.status);
    const pad = " ".repeat(Math.max(0, titleColumn - rule.title.length));
    const headline = rule.status === "fail" ? bold(style.color(rule.title)) : rule.status === "warn" ? style.color(rule.title) : rule.status === "skip" ? dim(rule.title) : rule.title;
    const labelWidth = 2 + rule.title.length + pad.length + 2 + rule.id.length;
    const budget = Math.min(RULE_HINT_WIDTH, Math.max(RULE_HINT_MIN, RULE_ROW_TARGET - RULE_ROW_CHROME - labelWidth));
    return {
      value: rule.id,
      label: `${style.color(style.glyph)} ${headline}${pad}  ${dim(rule.id)}`,
      hint: ruleHint(rule, budget)
    };
  });
  return { message: formatRulePickerMessage(rules), options };
}
function formatRulePickerMessage(rules) {
  const counts = {};
  for (const rule of rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const fragments = [];
  if (counts.fail) fragments.push(red(`${counts.fail} failing`));
  if (counts.warn) fragments.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.pass) fragments.push(green(`${counts.pass} passing`));
  if (counts.skip) fragments.push(gray(`${counts.skip} skipped`));
  fragments.push(dim("`pjangler audit` for full detail"));
  return `Select parity rules to apply  ${joinDot(fragments)}`;
}

// src/recipes/AgentHooksRecipe.ts
var AgentHooksRecipe = class extends Recipe {
  checks = createAgentHooksChecks();
  metadata = {
    id: "agent-hooks",
    name: "agent-hooks",
    description: "Project-scoped agent hooks and six-CLI skill topology",
    dependencies: ["mise"],
    commands: ["CopyAgentHooksTree", "WireMiseAgentHooks"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1FA9D} Agent-hooks layer installed!");
    console.log("   Next steps:");
    console.log("   1. mise run skills:sync  # sync .agents/skills.json into local CLI dirs");
    console.log("   2. mise run hooks:sync   # generate .claude/settings.json + inject codex/kimi/hermes");
    console.log("   3. git add .claude/settings.json .agents/hooks .agents/skills.json && commit (codex/kimi/hermes are per-dev)");
    console.log("   4. mise run hindsight:setup   # set HINDSIGHT_OP_KEY_REF to your 1Password item first");
    console.log("   5. Optional per-dev hook opt-out: copy .agents/local.example.json -> .agents/local.json");
  }
};

// src/recipes/BmadRecipe.ts
var BmadRecipe = class extends Recipe {
  checks = createBmadChecks();
  metadata = {
    id: "bmad",
    name: "bmad",
    description: "BMAD methodology and six supported CLI projections",
    dependencies: ["agent-hooks"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("BMAD lifecycle initialized for the six supported CLIs.");
  }
};

// src/commands/AddDockerfile.ts
var AddDockerfile = class extends Command {
  async invoke() {
    const filePath = "Dockerfile";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  Dockerfile already exists"),
        filePath
      };
    }
    const content = `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create Dockerfile" : "\u2705 Created Dockerfile"),
      filePath
    };
  }
};

// src/commands/AddDockerCompose.ts
var AddDockerCompose = class extends Command {
  async invoke() {
    const filePath = "docker-compose.yml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  docker-compose.yml already exists"),
        filePath
      };
    }
    const content = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create docker-compose.yml" : "\u2705 Created docker-compose.yml"),
      filePath
    };
  }
};

// src/commands/AddDockerignore.ts
var AddDockerignore = class extends Command {
  async invoke() {
    const filePath = ".dockerignore";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .dockerignore already exists"),
        filePath
      };
    }
    const content = `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .dockerignore" : "\u2705 Created .dockerignore"),
      filePath
    };
  }
};

// src/recipes/DockerRecipe.ts
var DockerRecipe = class extends Recipe {
  checks = [];
  metadata = {
    id: "docker",
    name: "docker",
    description: "Docker containerization setup",
    dependencies: [],
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"],
    publicRuleIds: []
  };
  constructor(context) {
    super(context);
    this.addIngredient(AddDockerfile).addIngredient(AddDockerCompose).addIngredient(AddDockerignore);
  }
  init(ctx, _input) {
    return this.invokeIngredients(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
};

// src/commands/hermes/PromptForAgentConfig.ts
import { basename as basename3, join as join5 } from "node:path";
import { readFileSync as readFileSync3 } from "node:fs";
import * as p from "@clack/prompts";
function detectTicketProvider(targetDir) {
  try {
    const t = JSON.parse(readFileSync3(join5(targetDir, ".project.json"), "utf8"))?.ticket_provider?.type;
    return t === "plane" || t === "trello" ? t : void 0;
  } catch {
    return void 0;
  }
}
var PromptForAgentConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    const defaultRepo = basename3(ctx.targetDir).toLowerCase();
    ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
    ctx.role ??= "pm";
    ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
    ctx.soulTone ??= "direct";
    ctx.modelProvider ??= "";
    ctx.modelName ??= "";
    ctx.modelBaseUrl ??= "";
    ctx.modelApiMode ??= "";
    ctx.modelKeyEnv ??= "";
    ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
    ctx.skipEmail ??= true;
    ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
    ctx.profileName = deriveProfileName(ctx.targetRepo, ctx.role);
    if (ctx.quiet && !ctx.yes) {
      return {
        success: false,
        outcome: "failed",
        message: "Quiet Hermes execution must also set yes=true; interactive prompts are unavailable to structured callers"
      };
    }
    if (ctx.yes) {
      ctx.skipTelegram ??= true;
      return {
        success: true,
        message: this.formatMessage(
          `\u2713 Non-interactive mode \u2014 using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        )
      };
    }
    p.intro("\u2695  hermes-agent  \xB7  provision the PM agent for this repo");
    p.log.info(
      `agent ${ctx.agentId}   \xB7   board ${ctx.ticketProvider}   \xB7   tone ${ctx.soulTone}`
    );
    if (ctx.skipTelegram === void 0) {
      const botHandle = `${ctx.targetRepo.replace(/-/g, "_")}_${ctx.role}_bot`;
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${botHandle}) now?`,
        initialValue: true
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }
    return {
      success: true,
      message: this.formatMessage(
        `\u2713 Collected agent config  (agent_id=${ctx.agentId}, profile=${ctx.profileName})`
      )
    };
  }
  cancelled() {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
};

// src/commands/hermes/RunCopierTemplate.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { homedir as homedir5 } from "node:os";
import { join as join9, dirname as dirname6, relative as relative6 } from "node:path";
import { existsSync as existsSync7, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import * as p2 from "@clack/prompts";
import YAML4 from "yaml";
init_project();
init_preflight();
var TICKET_PROVIDER_CREDENTIAL_KEYS = /* @__PURE__ */ new Set([
  "PLANE_API_KEY",
  "TRELLO_KEY",
  "TRELLO_TOKEN",
  "LINEAR_API_KEY"
]);
var INTERACTIVE_CHANNEL_CREDENTIAL_KEYS = /* @__PURE__ */ new Set([
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CF_EMAIL_ROUTING_TOKEN"
]);
function scrubTicketProviderCredentials(env2) {
  for (const key of Object.keys(env2)) {
    if (TICKET_PROVIDER_CREDENTIAL_KEYS.has(key) || /^PLANE_[A-Z0-9_]+_API_KEY$/.test(key)) {
      delete env2[key];
    }
  }
}
function scrubInteractiveChannelCredentials(env2) {
  for (const key of INTERACTIVE_CHANNEL_CREDENTIAL_KEYS) delete env2[key];
  delete env2.ENABLE_SLACK;
  delete env2.WIRE_SLACK;
}
function registerRenderedAgent(ctx, roleDir, role) {
  const manifestPath = join9(ctx.targetDir, ".project.json");
  if (!existsSync7(manifestPath) || !ctx.targetRepo) return;
  const current = readFileSync7(manifestPath, "utf8");
  const parsed = JSON.parse(current);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  const manifest = parsed;
  const rawAgents = manifest.agents;
  if (rawAgents !== void 0 && (!rawAgents || typeof rawAgents !== "object" || Array.isArray(rawAgents))) {
    throw new Error(`${manifestPath} agents must contain a JSON object`);
  }
  const agents = rawAgents ?? {};
  const agentId = ctx.agentId ?? deriveAgentId(ctx.targetRepo, role);
  Object.defineProperty(agents, agentId, {
    value: {
      role,
      role_dir: relative6(ctx.targetDir, roleDir),
      provisioning_state: "provisioned"
    },
    configurable: true,
    enumerable: true,
    writable: true
  });
  manifest.agents = agents;
  const next = `${JSON.stringify(manifest, null, 2)}
`;
  if (next !== current) writeFileSync5(manifestPath, next, "utf8");
}
function resolveVendoredTemplate(name) {
  let dir;
  try {
    dir = dirname6(fileURLToPath3(import.meta.url));
  } catch {
    return void 0;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join9(dir, "templates", name);
    if (existsSync7(join9(candidate, "copier.yml"))) return candidate;
    const parent = dirname6(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
var RunCopierTemplate = class extends Command {
  async invoke() {
    const ctx = this.context;
    const {
      targetRepo,
      role,
      agentPurpose,
      soulTone,
      modelProvider,
      modelName,
      modelBaseUrl,
      modelApiMode,
      modelKeyEnv
    } = ctx;
    const ticketProvider = ctx.ticketProvider ?? "plane";
    const profileName = ctx.profileName ?? (targetRepo && role ? deriveProfileName(targetRepo, role) : void 0);
    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)"
      };
    }
    const safeRole = normalizeAgentRole(role);
    ctx.role = safeRole;
    const roleDir = resolveContainedPath(
      ctx.targetDir,
      join9(ctx.targetDir, "agents", "hermes", safeRole),
      "Hermes role directory"
    );
    ctx.roleDir = roleDir;
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${safeRole}`;
    const trustedCopierRequired = Boolean(ctx.deferredExternalEffects && !ctx.dryRun);
    if (trustedCopierRequired && !ctx.trustedCopier) {
      return {
        success: false,
        outcome: "failed",
        message: "MCP Hermes apply requires a preflight-attested Copier identity"
      };
    }
    if (!ctx.trustedCopier) {
      const which = spawnSync3("which", ["copier"], { encoding: "utf8" });
      if (which.status !== 0) {
        return {
          success: false,
          outcome: "failed",
          message: "\u2717 copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`"
        };
      }
    }
    if (existsSync7(join9(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await p2.confirm({
          message: `${safeRole}/role.yaml already exists \u2014 re-render with --overwrite?`,
          initialValue: false
        });
        if (p2.isCancel(proceed) || !proceed) {
          return {
            success: false,
            outcome: "cancelled",
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`
          };
        }
        ctx.force = true;
      }
    }
    const env2 = {
      ...process.env,
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: ctx.deferredExternalEffects ? "1" : "0",
      // Fresh project targets do not have their own .git directory until the
      // project transaction's final phase. Pin scripts to the caller-resolved
      // root so they can never climb into an enclosing checkout.
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      // Config, fleet env/profile, and registry are host-global state. MCP
      // renders repo-local files first and executes those scripts only after a
      // structural lifecycle gate has accepted the render.
      SKIP_HOST_STATE: ctx.deferredExternalEffects ? "1" : "0",
      // Bloodbank is a fleet-shared Hermes gateway. Never provision the legacy
      // per-profile file consumer, even when an older template still exposes it.
      SKIP_RUNTIME_REPO: ctx.deferredExternalEffects ? "1" : ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.deferredExternalEffects ? "1" : ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: "1",
      SKIP_SYSTEMD: ctx.deferredExternalEffects ? "1" : ctx.skipSystemd ? "1" : "0"
    };
    if (ctx.deferredExternalEffects) scrubInteractiveChannelCredentials(env2);
    if (ctx.deferredExternalEffects || ctx.skipPlane) scrubTicketProviderCredentials(env2);
    if (ctx.trustedCopier) {
      delete env2.PYTHONHOME;
      delete env2.PYTHONPATH;
      env2.PYTHONNOUSERSITE = "1";
      env2.PYTHONSAFEPATH = "1";
    }
    const LOCAL_TEMPLATE = join9(homedir5(), "code", "hermes-agent-template");
    const vendored = resolveVendoredTemplate("hermes-agent");
    const templateSrc = process.env.PJANGLER_HERMES_TEMPLATE || vendored || (existsSync7(join9(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);
    const args = [
      "copy",
      templateSrc,
      roleDir,
      "--data",
      `target_repo=${targetRepo}`,
      "--data",
      `role=${safeRole}`,
      "--data",
      `agent_purpose=${agentPurpose ?? ""}`,
      "--data",
      `model_provider=${modelProvider ?? ""}`,
      "--data",
      `model_name=${modelName ?? ""}`,
      "--data",
      `model_base_url=${modelBaseUrl ?? ""}`,
      "--data",
      `model_api_mode=${modelApiMode ?? ""}`,
      "--data",
      `model_key_env=${modelKeyEnv ?? ""}`,
      "--data",
      `profile_name=${profileName ?? ""}`,
      "--data",
      `soul_tone=${soulTone ?? "direct"}`,
      "--data",
      `ticket_provider=${ticketProvider}`,
      "--trust",
      "--vcs-ref=HEAD"
    ];
    if (ctx.force) args.push("--overwrite");
    if (ctx.dryRun) {
      return {
        success: true,
        outcome: "planned",
        filePath: roleDir,
        message: this.formatMessage(`Would run: ${ctx.trustedCopier?.executable ?? "copier"} ${args.join(" ")}`)
      };
    }
    if (ctx.trustedCopier) {
      const verified = verifyTrustedCopierIdentity(ctx.trustedCopier);
      if (!verified.ok) {
        return {
          success: false,
          outcome: "failed",
          message: `Copier provenance revalidation failed: ${verified.error ?? "unknown identity failure"}`
        };
      }
    }
    mkdirSync5(join9(ctx.targetDir, "agents", "hermes"), { recursive: true });
    const spinner4 = ctx.quiet ? void 0 : p2.spinner();
    spinner4?.start(`Running copier copy  (target: agents/hermes/${safeRole})`);
    const copierExecutable = ctx.trustedCopier?.executable ?? "copier";
    const result2 = spawnSync3(copierExecutable, args, ctx.quiet ? { encoding: "utf8", env: env2, cwd: ctx.targetDir } : { stdio: "inherit", env: env2, cwd: ctx.targetDir });
    spinner4?.stop(result2.status === 0 ? "\u2713 copier run complete" : "\u2717 copier failed");
    if (result2.status !== 0) {
      return {
        success: false,
        outcome: "failed",
        message: `copier exited with status ${result2.status}.${ctx.quiet && String(result2.stderr ?? "").trim() ? ` ${String(result2.stderr).trim()}` : " Check the output above; re-run with the same flags after fixing."}`
      };
    }
    const roleManifest = join9(roleDir, "role.yaml");
    try {
      const current = readFileSync7(roleManifest, "utf8");
      const document = YAML4.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], ctx.deferredExternalEffects ? true : Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], ctx.deferredExternalEffects ? "deferred" : ctx.skipSystemd ? "deferred" : "required");
      const next = String(document);
      if (next !== current) writeFileSync5(roleManifest, next, "utf8");
      registerRenderedAgent(ctx, roleDir, safeRole);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record Hermes deployment mode in ${roleManifest}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      success: true,
      message: `\u2713 Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`
    };
  }
};

// src/commands/hermes/UntrackHermesRuntimes.ts
import { existsSync as existsSync8, readFileSync as readFileSync8, writeFileSync as writeFileSync6, readdirSync as readdirSync5 } from "fs";
import { join as join10 } from "path";
import { spawnSync as spawnSync4 } from "node:child_process";
function sectionHasPath(section2, targetPath) {
  return section2.split(/\r?\n/).some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}
function removeSubmodulePath(content, targetPath) {
  return content.replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section2) => sectionHasPath(section2, targetPath) ? "" : section2).replace(/\n{3,}/g, "\n\n").trim();
}
var UntrackHermesRuntimes = class extends Command {
  async invoke() {
    const targetDir = this.context.targetDir;
    const rolesDir = join10(targetDir, "agents", "hermes");
    if (!existsSync8(rolesDir)) {
      return {
        success: true,
        message: "No Hermes agents found (no agents/hermes directory)."
      };
    }
    const roles = readdirSync5(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (roles.length === 0) {
      return {
        success: true,
        message: "No Hermes agents found."
      };
    }
    let modifiedAny = false;
    const details = [];
    for (const role of roles) {
      const roleDir = join10("agents", "hermes", role);
      const runtimePath = join10(roleDir, "runtime");
      const gitignorePath = join10(roleDir, ".gitignore");
      const gitmodulesPath = join10(targetDir, ".gitmodules");
      let isTracked = false;
      const lsResult = spawnSync4("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: targetDir,
        encoding: "utf8"
      });
      if (lsResult.status !== 0) {
        return {
          success: false,
          message: `\u2717 Failed to inspect runtime index at ${runtimePath}: ${lsResult.stderr.trim() || `exit ${lsResult.status}`}`
        };
      }
      if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
        isTracked = true;
      }
      let hasStaleMapping = false;
      let gitmodulesContent = "";
      if (existsSync8(gitmodulesPath)) {
        gitmodulesContent = readFileSync8(gitmodulesPath, "utf8");
        const sections = gitmodulesContent.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
        hasStaleMapping = sections.some((section2) => sectionHasPath(section2, runtimePath));
      }
      let isIgnored = false;
      const fullGitignorePath = join10(targetDir, gitignorePath);
      if (existsSync8(fullGitignorePath)) {
        const content = readFileSync8(fullGitignorePath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim());
        isIgnored = lines.includes("runtime/") || lines.includes("runtime");
      }
      if (isTracked || hasStaleMapping || !isIgnored) {
        modifiedAny = true;
        if (isTracked) {
          details.push(`untrack agents/hermes/${role}/runtime`);
          if (!this.context.dryRun) {
            const rmResult = spawnSync4("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8"
            });
            if (rmResult.status !== 0) {
              return {
                success: false,
                message: `\u2717 Failed to untrack ${runtimePath}: ${rmResult.stderr.trim() || `exit ${rmResult.status}`}`
              };
            }
            const verifyResult = spawnSync4("git", ["ls-files", "--stage", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8"
            });
            if (verifyResult.status !== 0 || verifyResult.stdout.trim()) {
              return {
                success: false,
                message: verifyResult.status !== 0 ? `\u2717 Failed to verify untracked runtime ${runtimePath}: ${verifyResult.stderr.trim() || `exit ${verifyResult.status}`}` : `\u2717 Runtime remains tracked after index-only removal: ${runtimePath}`
              };
            }
          }
        }
        if (hasStaleMapping) {
          details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
          if (!this.context.dryRun) {
            const next = removeSubmodulePath(gitmodulesContent, runtimePath);
            writeFileSync6(gitmodulesPath, next ? `${next}
` : "", "utf8");
          }
        }
        if (!isIgnored) {
          details.push(`ignore runtime/ in agents/hermes/${role}/.gitignore`);
          if (!this.context.dryRun) {
            let content = "";
            if (existsSync8(fullGitignorePath)) {
              content = readFileSync8(fullGitignorePath, "utf8");
            }
            if (content && !content.endsWith("\n")) {
              content += "\n";
            }
            content += "runtime/\n";
            writeFileSync6(fullGitignorePath, content, "utf8");
          }
        }
      }
    }
    if (!modifiedAny) {
      return {
        success: true,
        message: "\u2705 All Hermes agent runtimes are already untracked and gitignored."
      };
    }
    const actionText = this.context.dryRun ? "Would make" : "Made";
    return {
      success: true,
      message: `${actionText} Hermes agent runtimes untracked and gitignored:
${details.map((d) => `  - ${d}`).join("\n")}`
    };
  }
};

// src/commands/hermes/WireTelegram.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { join as join11 } from "node:path";
import { existsSync as existsSync9, unlinkSync as unlinkSync3 } from "node:fs";
import * as p3 from "@clack/prompts";
var WireTelegram = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipTelegram) {
      return { success: true, message: "\u2192 Telegram wire-up skipped" };
    }
    if (ctx.quiet) {
      return {
        success: false,
        outcome: "failed",
        message: "Telegram wiring is interactive and unavailable during quiet/non-interactive Hermes execution"
      };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }
    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;
    const vaultTitle = `Telegram-Hermes-${targetRepo.toLowerCase()}-${role.toLowerCase()}`;
    const vaultRef = `op://DeLoSecrets/${vaultTitle}/token`;
    let token = process.env.TELEGRAM_BOT_TOKEN;
    let source = token ? "env" : null;
    if (!token) {
      const tryOp = spawnSync5("op", ["read", vaultRef], { encoding: "utf8" });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
        source = "op";
        p3.log.info(`\u2713 Telegram token loaded from ${vaultRef}`);
      }
    }
    if (!token) {
      p3.log.step("BotFather steps");
      p3.log.info(
        [
          "  1. Open Telegram, message @BotFather",
          "  2. /newbot",
          `  3. Display name:   ${displayName}`,
          `  4. Username:       ${botHandle}   (must end in _bot)`,
          "  5. Copy the HTTP API token from the reply.",
          "  6. /setjoingroups Disable",
          "  7. /setprivacy    Disable"
        ].join("\n")
      );
      const tokenAnswer = await p3.password({
        message: `Paste the bot token for @${botHandle}`,
        mask: "\u2022",
        validate: (v) => {
          const s = String(v ?? "").trim();
          if (!s) return "required";
          if (!/^[0-9]+:.+/.test(s)) return "expected '<digits>:<secret>' shape";
        }
      });
      if (p3.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Telegram skipped (no token).  Re-run later." };
      }
      token = String(tokenAnswer).trim();
      source = "prompt";
      const persist = await p3.confirm({
        message: `Save to ${vaultRef} for next time?`,
        initialValue: true
      });
      if (!p3.isCancel(persist) && persist) {
        const create = spawnSync5(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            `--title=${vaultTitle}`,
            `token=${token}`,
            `bot_handle=${botHandle}`
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p3.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const allowedAnswer = await p3.text({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v) => /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v).trim()) ? void 0 : "comma-separated numeric ids"
    });
    if (p3.isCancel(allowedAnswer)) {
      return { success: false, message: "\u2717 Aborted; Telegram step deferred." };
    }
    const script = join11(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync9(script)) {
      return {
        success: false,
        message: `\u2717 ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`
      };
    }
    const marker = join11(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync9(marker)) unlinkSync3(marker);
    const spinner4 = p3.spinner();
    spinner4.start("Verifying token + wiring profile");
    const result2 = spawnSync5("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim()
      },
      cwd: roleDir
    });
    spinner4.stop(result2.status === 0 ? "\u2713 Telegram wired" : "\u2717 Telegram step failed");
    if (result2.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }
    const sourceLabel = source === "env" ? " (token: env)" : source === "op" ? " (token: op)" : "";
    return { success: true, message: `\u2713 Telegram: @${botHandle} ready${sourceLabel}` };
  }
};
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// src/commands/hermes/WireEmail.ts
import { spawnSync as spawnSync6 } from "node:child_process";
import { join as join12 } from "node:path";
import { existsSync as existsSync10, unlinkSync as unlinkSync4 } from "node:fs";
import * as p4 from "@clack/prompts";
var WireEmail = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipEmail) {
      return { success: true, message: "" };
    }
    if (ctx.quiet) {
      return {
        success: false,
        outcome: "failed",
        message: "Email wiring is interactive and unavailable during quiet/non-interactive Hermes execution"
      };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join12(roleDir, ".scripts", "50-email.sh");
    if (!existsSync10(script)) {
      return { success: false, message: `\u2717 ${script} not found` };
    }
    let token = process.env.CF_EMAIL_ROUTING_TOKEN;
    if (!token) {
      const tryOp = spawnSync6(
        "op",
        ["read", "op://DeLoSecrets/Cloudflare-EmailRouting/token"],
        { encoding: "utf8" }
      );
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
      }
    }
    if (!token) {
      p4.log.warn("CF Email Routing token not found.  Required scopes:");
      p4.log.info(
        [
          "  Zone (delo.sh)  \u2192  Email Routing Rules     : Edit",
          "  Zone (delo.sh)  \u2192  Email Routing Settings  : Read",
          "  Account         \u2192  Email Routing Addresses : Read",
          "Create at: https://dash.cloudflare.com/profile/api-tokens"
        ].join("\n")
      );
      const provideNow = await p4.confirm({
        message: "Paste a token now?  (skipping leaves email unwired until you re-run.)",
        initialValue: false
      });
      if (p4.isCancel(provideNow) || !provideNow) {
        return { success: true, message: "\u2192 Email skipped (no token).  Re-run later." };
      }
      const tokenAnswer = await p4.password({
        message: "CF token (will be passed via env, not stored)",
        mask: "\u2022",
        validate: (v) => String(v ?? "").trim() ? void 0 : "required"
      });
      if (p4.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Email skipped (cancelled)" };
      }
      token = String(tokenAnswer).trim();
      const persist = await p4.confirm({
        message: "Save to op://DeLoSecrets/Cloudflare-EmailRouting/token for next time?",
        initialValue: true
      });
      if (!p4.isCancel(persist) && persist) {
        const create = spawnSync6(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            "--title=Cloudflare-EmailRouting",
            `token=${token}`
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p4.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const marker = join12(roleDir, ".scripts", ".done-50-email");
    if (existsSync10(marker)) unlinkSync4(marker);
    const spinner4 = p4.spinner();
    spinner4.start("Creating Cloudflare Email Routing rule");
    const result2 = spawnSync6("bash", [script], {
      stdio: "inherit",
      env: { ...process.env, SKIP_EMAIL: "0", CF_EMAIL_ROUTING_TOKEN: token },
      cwd: roleDir
    });
    spinner4.stop(result2.status === 0 ? "\u2713 Email rule created" : "\u2717 Email step failed");
    if (result2.status !== 0) {
      return { success: false, message: "Email rule creation failed.  See output above." };
    }
    return {
      success: true,
      message: `\u2713 Email: ${targetRepo}-${role}@delo.sh  \u2192  jaradd@gmail.com`
    };
  }
};

// src/commands/hermes/PrintHermesSummary.ts
import * as p5 from "@clack/prompts";
var PrintHermesSummary = class extends Command {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentId, runtimeRepo, skipTelegram, skipEmail } = ctx;
    const botHandle = `${targetRepo?.toLowerCase().replace(/-/g, "_")}_${role?.toLowerCase()}_bot`;
    const email = `${targetRepo}-${role}@delo.sh`;
    const gw = `hermes-${agentId}-gateway.service`;
    const hb = `hermes-${agentId}-heartbeat.timer`;
    const lines = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    if (!skipEmail) lines.push(`email        ${email}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${hb}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("  # Bloodbank commands arrive through the fleet-shared Hermes gateway");
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram) {
      lines.push("");
      lines.push("Wire Telegram later:");
      lines.push("  pjangler hermes-agent          # re-run and answer yes when asked");
    }
    if (!ctx.quiet) {
      p5.note(lines.join("\n"), `Provisioned ${agentId}`);
      p5.outro("Done.");
    }
    return { success: true, outcome: "unchanged", message: "" };
  }
};

// src/commands/hermes/ApplyDeferredExternalEffects.ts
import { spawnSync as spawnSync7 } from "node:child_process";
import { existsSync as existsSync11, readFileSync as readFileSync9, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join13 } from "node:path";
import YAML5 from "yaml";
var ApplyDeferredExternalEffects = class extends Command {
  async invoke() {
    const ctx = this.context;
    const selected = ctx.deferredExternalEffects;
    if (!selected || !selected.runtimeRepo && !selected.ticketBoard && !selected.systemd) {
      return { success: true, outcome: "unchanged", message: "Hermes external effects not selected" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred external effects" };
    }
    const env2 = {
      ...process.env,
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      SKIP_RUNTIME_REPO: selected.runtimeRepo ? "0" : "1",
      SKIP_PLANE: selected.ticketBoard ? "0" : "1",
      SKIP_SYSTEMD: selected.systemd ? "0" : "1"
    };
    scrubInteractiveChannelCredentials(env2);
    if (!selected.ticketBoard) scrubTicketProviderCredentials(env2);
    const roleManifest = join13(ctx.roleDir, "role.yaml");
    const scripts = [
      ...selected.runtimeRepo ? ["20-runtime-repo.sh"] : [],
      ...selected.ticketBoard ? ["42-ticket-provider.sh"] : [],
      ...selected.systemd ? ["70-systemd.sh"] : [],
      // Refresh fleet metadata after a board binding or runtime/systemd state
      // changes. 80-registry.sh is idempotent and performs no provider call.
      "80-registry.sh"
    ];
    const logs = [];
    for (const script of scripts) {
      const path = join13(ctx.roleDir, ".scripts", script);
      if (!existsSync11(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes script is missing: ${path}` };
      }
      const result2 = spawnSync7(path, [], { cwd: ctx.roleDir, env: env2, encoding: "utf8" });
      if (String(result2.stdout ?? "").trim()) logs.push(String(result2.stdout).trim());
      if (String(result2.stderr ?? "").trim()) logs.push(String(result2.stderr).trim());
      if (result2.error || result2.status !== 0) {
        const detail = result2.error?.message ?? logs.at(-1) ?? `status ${result2.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }
    try {
      const current = readFileSync9(roleManifest, "utf8");
      const document = YAML5.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], selected.systemd ? "required" : "deferred");
      const next = String(document);
      if (next !== current) writeFileSync7(roleManifest, next, "utf8");
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record applied Hermes deployment metadata: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes external effects: ${scripts.join(", ")}${logs.length ? `
${logs.join("\n")}` : ""}`
    };
  }
};

// src/commands/hermes/ApplyDeferredHostEffects.ts
import { spawnSync as spawnSync8 } from "node:child_process";
import { existsSync as existsSync12 } from "node:fs";
import { join as join14 } from "node:path";
var ApplyDeferredHostEffects = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (!ctx.deferredExternalEffects) {
      return { success: true, outcome: "unchanged", message: "Hermes host effects use template sequencing" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred host effects" };
    }
    let config;
    ctx.applyingDeferredHostEffects = true;
    try {
      config = await new EnsureTemplateConfig(ctx).invoke();
    } finally {
      ctx.applyingDeferredHostEffects = false;
    }
    if (!config.success) return config;
    const env2 = {
      ...process.env,
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      SKIP_RUNTIME_REPO: "1",
      SKIP_PLANE: "1",
      SKIP_SYSTEMD: "1"
    };
    scrubTicketProviderCredentials(env2);
    scrubInteractiveChannelCredentials(env2);
    const scripts = ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh"];
    const logs = [];
    for (const script of scripts) {
      const path = join14(ctx.roleDir, ".scripts", script);
      if (!existsSync12(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes host script is missing: ${path}` };
      }
      const result2 = spawnSync8(path, [], { cwd: ctx.roleDir, env: env2, encoding: "utf8" });
      if (String(result2.stdout ?? "").trim()) logs.push(String(result2.stdout).trim());
      if (String(result2.stderr ?? "").trim()) logs.push(String(result2.stderr).trim());
      if (result2.error || result2.status !== 0) {
        const detail = result2.error?.message ?? logs.at(-1) ?? `status ${result2.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes host effects: ${scripts.join(", ")}${logs.length ? `
${logs.join("\n")}` : ""}`
    };
  }
};

// src/recipes/HermesAgentRecipe.ts
init_tree_diff();
init_preflight();
import { resolve as resolve6 } from "node:path";
var HermesAgentRecipe = class extends Recipe {
  checks = createHermesChecks();
  metadata = {
    id: "hermes-agent",
    name: "hermes-agent",
    description: "Add and reconcile a Hermes agent role",
    dependencies: [],
    commands: [
      "EnsureTemplateConfig",
      "PromptForAgentConfig",
      "RunCopierTemplate",
      "UntrackHermesRuntimes",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary"
    ],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  /** Hermes sequencing is fatal/cancel short-circuiting under registry init. */
  async init(ctx, _input) {
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    const ingredients = [
      EnsureTemplateConfig,
      PromptForAgentConfig,
      RunCopierTemplate,
      UntrackHermesRuntimes,
      WireTelegram,
      WireEmail,
      PrintHermesSummary
    ];
    for (const [ingredientIndex, CommandClass] of ingredients.entries()) {
      if (typeof CommandClass !== "function") {
        throw new TypeError(`Hermes ingredient ${ingredientIndex} is not constructable`);
      }
      const before = ctx.dryRun ? void 0 : snapshotTree(ctx.targetDir);
      const result2 = await new CommandClass(ctx).invoke();
      const observedChanges = before ? changedTreePaths(ctx.targetDir, before, snapshotTree(ctx.targetDir)) : [];
      let status = result2.outcome ?? (result2.success ? ctx.dryRun && result2.filePath ? "planned" : result2.filePath ? "changed" : "unchanged" : "failed");
      if (result2.success && !ctx.dryRun && observedChanges.length) status = "changed";
      const declaredChanges = status === "changed" && result2.filePath ? [resolve6(ctx.targetDir, result2.filePath)] : [];
      const actualChanges = [.../* @__PURE__ */ new Set([...observedChanges, ...declaredChanges])].sort();
      phases.push({ id: CommandClass.name, status, changedFiles: actualChanges, message: result2.message || void 0 });
      changedFiles.push(...actualChanges);
      if (result2.message) logs.push(result2.message);
      if (status === "failed" || status === "cancelled") {
        errors.push(result2.message || `${CommandClass.name} ${status}`);
        break;
      }
      if (!ctx.dryRun && CommandClass === RunCopierTemplate && ctx.deferredExternalEffects) {
        const hermesContext2 = ctx;
        const eligibility = hermesContext2.roleDir && hermesContext2.targetRepo && hermesContext2.role && hermesContext2.agentId ? preflightRenderedHermes({
          pjanglerRoot: ctx.pjanglerRoot,
          targetDir: ctx.targetDir,
          roleDir: hermesContext2.roleDir,
          targetRepo: hermesContext2.targetRepo,
          role: hermesContext2.role,
          agentId: hermesContext2.agentId
        }) : { ok: false, error: "Hermes render did not establish role identity" };
        phases.push({
          id: "hermes.rendered-eligibility",
          status: eligibility.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: eligibility.ok ? "Rendered Hermes lifecycle eligibility passed" : eligibility.error
        });
        if (!eligibility.ok) {
          errors.push(`hermes.rendered-eligibility: ${eligibility.error ?? "unknown eligibility failure"}`);
          break;
        }
        const beforeHost = snapshotTree(ctx.targetDir);
        const host = await new ApplyDeferredHostEffects(ctx).invoke();
        const hostChanges = changedTreePaths(ctx.targetDir, beforeHost, snapshotTree(ctx.targetDir));
        phases.push({
          id: "hermes.host-effects",
          status: host.success ? hostChanges.length ? "changed" : "unchanged" : "failed",
          changedFiles: host.success ? hostChanges : [],
          message: host.message || void 0
        });
        changedFiles.push(...hostChanges);
        if (host.message) logs.push(host.message);
        if (!host.success) {
          errors.push(host.message || "Deferred Hermes host effects failed");
          break;
        }
      }
    }
    const commandResult = {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases
    };
    if (!commandResult.ok) return commandResult;
    const lifecycle = await this.initializeOwnedChecks(ctx);
    const localResult = mergeInitResults(this.metadata.id, Boolean(ctx.dryRun), [commandResult, lifecycle]);
    if (!localResult.ok || ctx.dryRun) return localResult;
    const hermesContext = ctx;
    if (hermesContext.deferredExternalEffects?.owner !== "hermes") return localResult;
    const selected = hermesContext.deferredExternalEffects;
    if (!selected.runtimeRepo && !selected.ticketBoard && !selected.systemd) return localResult;
    const beforeExternal = snapshotTree(ctx.targetDir);
    const external = await new ApplyDeferredExternalEffects(ctx).invoke();
    const externalChanges = changedTreePaths(ctx.targetDir, beforeExternal, snapshotTree(ctx.targetDir));
    const externalResult = {
      recipeId: this.metadata.id,
      ok: external.success,
      dryRun: false,
      changedFiles: externalChanges,
      logs: external.message ? [external.message] : [],
      errors: external.success ? [] : [external.message || "Deferred Hermes external effects failed"],
      phases: [{
        id: "hermes.external-effects",
        status: external.success ? "changed" : "failed",
        changedFiles: external.success ? externalChanges : [],
        message: external.message || void 0
      }]
    };
    if (!externalResult.ok) return mergeInitResults(this.metadata.id, false, [localResult, externalResult]);
    const findings = this.audit(ctx).filter((finding2) => finding2.status !== "pass" && finding2.status !== "skip");
    const verification = {
      recipeId: this.metadata.id,
      ok: findings.length === 0,
      dryRun: false,
      changedFiles: [],
      logs: [],
      errors: findings.map((finding2) => `${finding2.id}: ${finding2.summary}`),
      phases: [{
        id: "hermes.postcondition-audit",
        status: findings.length ? "failed" : "unchanged",
        changedFiles: [],
        message: findings.length ? "Hermes postcondition audit failed" : "Hermes postcondition audit passed"
      }]
    };
    return mergeInitResults(this.metadata.id, false, [localResult, externalResult, verification]);
  }
  printNextSteps() {
  }
};

// src/recipes/MiseOpInjectRecipe.ts
var MiseOpInjectRecipe = class extends Recipe {
  checks = createMiseOpInjectChecks();
  metadata = {
    id: "mise-op-inject",
    name: "mise-op-inject",
    description: "Canonical .env.op to .env materialization lifecycle",
    dependencies: [],
    commands: ["WireMiseOpInject"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Wired up .env.op 1Password resolution via mise!");
    console.log("   Next steps:");
    console.log("   1. Create .env.op with your op:// secret references");
    console.log("   2. Re-enter the project to run the managed materialization hook");
  }
};

// src/recipes/MiseRecipe.ts
var MiseRecipe = class extends Recipe {
  checks = createMiseChecks();
  metadata = {
    id: "mise",
    name: "mise",
    description: "Mise task runner and environment setup",
    dependencies: ["mise-op-inject"],
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript", "AddMiseCodegraphScript", "AddMiseCodegraphWireScript"],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  constructor(context) {
    super(context);
  }
  init(ctx, _input) {
    return this.initializeOwnedChecks(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/commands/NodeCommands.ts
var AddPackageJson = class extends Command {
  async invoke() {
    const filePath = "package.json";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  package.json already exists",
        filePath
      };
    }
    const content = `{
  "name": "my-project",
  "version": "1.0.0",
  "description": "A new project",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created package.json",
      filePath
    };
  }
};
var AddReadme = class extends Command {
  async invoke() {
    const filePath = "README.md";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  README.md already exists",
        filePath
      };
    }
    const content = `# My Project

A new project initialized with pjangler.

## Getting Started

1. Install dependencies: \`mise install\`
2. Start development: \`mise run dev\`

## Project Structure

- \`mise.toml\` - Environment configuration
- \`.mise/tasks/\` - Task definitions
- \`src/\` - Source code
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created README.md",
      filePath
    };
  }
};
var AddSrcDirectory = class extends Command {
  async invoke() {
    this.createDirectory("src");
    const indexJsPath = "src/index.js";
    const content = `console.log("Hello, World!");
`;
    this.writeFile(indexJsPath, content);
    return {
      success: true,
      message: "\u2705 Created src/ directory with index.js",
      filePath: "src/index.js"
    };
  }
};

// src/recipes/NodeRecipe.ts
var NodeRecipe = class extends Recipe {
  checks = [];
  metadata = {
    id: "node",
    name: "node",
    description: "Node.js project template",
    dependencies: [],
    commands: ["NodeCommands"],
    publicRuleIds: []
  };
  constructor(context) {
    super(context);
    this.addIngredient(AddPackageJson).addIngredient(AddReadme).addIngredient(AddSrcDirectory);
  }
  init(ctx, _input) {
    return this.invokeIngredients(ctx);
  }
  printNextSteps() {
    console.log("\u{1F389} Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/recipes/ProjectRecipe.ts
init_project();
import { spawnSync as spawnSync13 } from "node:child_process";
import { existsSync as existsSync18, readFileSync as readFileSync16, rmSync as rmSync4 } from "node:fs";
import { join as join22 } from "node:path";
init_tree_diff();

// src/recipes/NotebookRecipe.ts
init_project();
import { existsSync as existsSync17, readFileSync as readFileSync15 } from "node:fs";
import { join as join21 } from "node:path";

// src/notebook/checks.ts
init_config();
init_notes();
init_output();
init_state();
import { existsSync as existsSync15, readFileSync as readFileSync12 } from "node:fs";
import { join as join16 } from "node:path";
var NOTEBOOK_RULE_IDS = [
  "notebook.configuration",
  "notebook.binding",
  "notebook.remote-notebook",
  "notebook.overview-note",
  "notebook.skill-installed",
  "notebook.hooks-projected",
  "notebook.capture-receipts"
];
function finding(id, title, status, summary, details = [], fixable = false) {
  return { id, title, status, summary, details, fixable };
}
function result(check, status, summary, changedFiles = [], details = []) {
  return { id: check.id, title: check.title, status, summary, changedFiles, details };
}
function manifestNotebook(repo) {
  const path = join16(repo, ".project.json");
  if (!existsSync15(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync12(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const notebook = parsed.notebook;
    return notebook && typeof notebook === "object" && !Array.isArray(notebook) ? notebook : null;
  } catch {
    return null;
  }
}
function enabled(ctx) {
  if (ctx.notebookRegistryDeclared === false) return false;
  if (ctx.notebookPlan || manifestNotebook(ctx.repoRoot)) return true;
  try {
    return loadEffectiveNotebookConfig(ctx.repoRoot).binding.state !== "disabled";
  } catch {
    return false;
  }
}
function registryDeclared(ctx) {
  if (ctx.notebookRegistryDeclared !== void 0) return ctx.notebookRegistryDeclared;
  return enabled(ctx);
}
function resolvedConfig(ctx) {
  return ctx.notebookPlan?.config ?? loadEffectiveNotebookConfig(ctx.repoRoot);
}
function bindingProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value;
  const result2 = {};
  for (const key of ["state", "notebook_id", "notebook_name", "overview_note_id", "blocked_reason"]) {
    if (raw[key] !== void 0) result2[key] = raw[key];
  }
  return result2;
}
function manifestBinding(repo) {
  const notebook = manifestNotebook(repo);
  return notebook ? bindingProjection(notebook.binding) : null;
}
function observation(ctx) {
  return ctx.notebookObservation;
}
var NotebookCheck = class {
  constructor(id, title, auditFn, migrateFn) {
    this.id = id;
    this.title = title;
    this.auditFn = auditFn;
    this.migrateFn = migrateFn;
  }
  audit(ctx) {
    return this.auditFn(ctx);
  }
  migrate(ctx, current) {
    return this.migrateFn?.(ctx, current) ?? result(current, "blocked", `${this.id} requires an explicit owned migration path`);
  }
};
function configurationAudit(ctx) {
  if (!registryDeclared(ctx)) {
    if (!ctx.notebookFocusedAudit) return finding(
      "notebook.configuration",
      "Notebook configuration",
      "skip",
      "Project Notebook is not declared; use the focused pj notebook audit surface to opt in"
    );
    return finding(
      "notebook.configuration",
      "Notebook configuration",
      "warn",
      "This registered repository has no authoritative Project Notebook declaration",
      [
        `Run pj notebook migrate ${ctx.repoRoot} --apply to create a planned Registry binding and Manifest policy`,
        "The declaration keeps SessionStart and SessionEnd capture disabled until explicitly enabled per project"
      ],
      true
    );
  }
  if (!enabled(ctx)) return finding("notebook.configuration", "Notebook configuration", "skip", "Project Notebook is not declared for this repository");
  try {
    const config = resolvedConfig(ctx);
    if (!config.policy.enabled) return finding("notebook.configuration", "Notebook configuration", "skip", "Project Notebook is explicitly disabled");
    if (!config.base_url) return finding("notebook.configuration", "Notebook configuration", "pass", "Project Notebook policy is valid; remote work remains planned until an endpoint is configured", ["Set Registry notebook.base_url to HTTPS or loopback HTTP before remote work"], false);
    return finding("notebook.configuration", "Notebook configuration", "pass", "Notebook endpoint, auth name, policy, and finite limits are valid");
  } catch (error) {
    return finding("notebook.configuration", "Notebook configuration", "fail", normalizeNotebookError(error).message);
  }
}
function bindingAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.binding", "Notebook binding", "skip", "Project Notebook is not declared for this repository");
  const config = (() => {
    try {
      return resolvedConfig(ctx);
    } catch {
      return void 0;
    }
  })();
  if (!config) return finding("notebook.binding", "Notebook binding", "fail", "Notebook binding could not be resolved");
  if (config.binding.state === "disabled") return finding("notebook.binding", "Notebook binding", "skip", "Project Notebook binding is disabled");
  if (config.binding.state === "linked" && (!config.binding.notebook_id || !config.binding.overview_note_id)) {
    return finding("notebook.binding", "Notebook binding", "fail", "Linked binding is missing its notebook or Overview stable ID", [], true);
  }
  const projected = ctx.notebookManifestBinding !== void 0 ? bindingProjection(ctx.notebookManifestBinding) : manifestBinding(ctx.repoRoot);
  const authoritative = bindingProjection(config.binding);
  if (!projected || canonicalJson(projected) !== canonicalJson(authoritative)) {
    return finding(
      "notebook.binding",
      "Notebook binding",
      "fail",
      "Manifest Notebook binding projection has drifted from the authoritative Project Registry binding",
      ["Run pj notebook migrate --apply to project Registry binding into .project.json"],
      true
    );
  }
  return finding("notebook.binding", "Notebook binding", "pass", config.binding.state === "linked" ? "Registry binding has stable notebook and Overview IDs" : "Planned binding is valid recovery state");
}
function remoteAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.remote-notebook", "Remote notebook", "skip", "Project Notebook is not declared for this repository");
  const journals = (() => {
    try {
      return admission(ctx).unresolvedJournals.filter((item) => item.kind === "notebook.create");
    } catch {
      return [];
    }
  })();
  if (journals.length) {
    return finding("notebook.remote-notebook", "Remote notebook", "warn", "Unresolved notebook-create journal requires marker reconciliation and durable Registry ownership", journalDetails(journals), true);
  }
  const observed = observation(ctx);
  if (!observed || observed.notebook_check.status === "skip") return finding("notebook.remote-notebook", "Remote notebook", "skip", "Remote notebook was not observed; no hidden network request was made");
  if (observed.notebook_check.status === "pass" && observed.notebook) return finding("notebook.remote-notebook", "Remote notebook", "pass", "Stable notebook ID, marker, name, and archive state were observed exactly");
  return finding(
    "notebook.remote-notebook",
    "Remote notebook",
    "fail",
    observed.error?.message ?? "Remote notebook is missing, ambiguous, unavailable, or metadata-drifted",
    observed.notebook_check.drift.map((item) => `${item.path}: ${item.reason}`),
    true
  );
}
function overviewAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.overview-note", "Overview note", "skip", "Project Notebook is not declared for this repository");
  const config = (() => {
    try {
      return resolvedConfig(ctx);
    } catch {
      return void 0;
    }
  })();
  const logicalId = config ? `overview:v1:${config.project_slug}` : null;
  const journals = (() => {
    try {
      return admission(ctx).unresolvedJournals.filter((item) => item.kind === "note.create" && item.logical_marker === logicalId);
    } catch {
      return [];
    }
  })();
  if (journals.length) {
    return finding("notebook.overview-note", "Overview note", "warn", "Unresolved Overview-create journal requires stable-ID reconciliation and durable binding ownership", journalDetails(journals), true);
  }
  const observed = observation(ctx);
  if (!observed || observed.remote_check === "skip") return finding("notebook.overview-note", "Overview note", "skip", "Overview was not observed; no hidden network request was made");
  if (observed.overview?.present && observed.overview.member && observed.overview.envelope_owned && observed.overview.drift.length === 0) return finding("notebook.overview-note", "Overview note", "pass", "Bound Overview membership, project ownership, logical ID, and descriptor freshness were proved");
  return finding("notebook.overview-note", "Overview note", "fail", "Overview is missing, foreign, or drifted", observed.overview?.drift.map((item) => `${item.path}: ${item.reason}`) ?? [], true);
}
function hostBlockFinding(id, title, block) {
  return finding(id, title, "skip", `Host skill projection is owned outside PJ\xE1ngler: ${block.summary}`, [...block.details, `Repair: ${block.repair}`], false);
}
function skillAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.skill-installed", "Project Notebook skill", "skip", "Project Notebook is not declared for this repository");
  const observed = observation(ctx);
  if (observed?.skill_installed === true) return finding("notebook.skill-installed", "Project Notebook skill", "pass", "Digest-verified Project Notebook skill is installed");
  if (observed?.skill_host_block) return hostBlockFinding("notebook.skill-installed", "Project Notebook skill", observed.skill_host_block);
  if (observed?.skill_installed === false) return finding("notebook.skill-installed", "Project Notebook skill", "fail", "Digest-verified Project Notebook skill is not installed", ["Run pj notebook migrate --apply"], true);
  return finding("notebook.skill-installed", "Project Notebook skill", "skip", "Skill installation was not observed; no global path was read", [], true);
}
function hooksAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.hooks-projected", "Project Notebook hooks", "skip", "Project Notebook is not declared for this repository");
  const observed = observation(ctx);
  if (observed?.hooks_projected === true) return finding("notebook.hooks-projected", "Project Notebook hooks", "pass", "True SessionStart and SessionEnd hook entries are projected once");
  if (observed?.skill_host_block) return hostBlockFinding("notebook.hooks-projected", "Project Notebook hooks", observed.skill_host_block);
  if (observed?.hooks_projected === false) return finding("notebook.hooks-projected", "Project Notebook hooks", "fail", "Canonical true-boundary hooks are missing, duplicated, or drifted", ["Run pj notebook migrate --apply"], true);
  return finding("notebook.hooks-projected", "Project Notebook hooks", "skip", "Hook projection was not observed; no global settings file was read", [], true);
}
function stateRoot(ctx) {
  return ctx.notebookStateRoot ?? notebookStateRoot({ HOME: ctx.homeDir });
}
function admission(ctx) {
  const config = resolvedConfig(ctx);
  return captureAdmissionSummary(stateRoot(ctx), config.project_slug, config.limits);
}
function journalDetails(journals) {
  return journals.map((item) => `${item.operation_id}: ${item.result_category}; ${item.next_action}; run pj notebook audit --json, then retry the originating action once`);
}
function captureAudit(ctx) {
  if (!enabled(ctx)) return finding("notebook.capture-receipts", "Capture receipts", "skip", "Project Notebook is not declared for this repository");
  try {
    const config = resolvedConfig(ctx);
    const summary = captureAdmissionSummary(stateRoot(ctx), config.project_slug, config.limits);
    if (summary.unmeasurable_entry_count) return finding("notebook.capture-receipts", "Capture receipts", "fail", "Capture state-integrity prevents exact admission proof", summary.integrity_entries.map((item) => `${item.entry_id}: ${item.reason}`), true);
    const overviewLogicalId2 = `overview:v1:${config.project_slug}`;
    const actionJournals = summary.unresolvedJournals.filter((item) => item.kind === "note.create" && item.logical_marker !== overviewLogicalId2);
    if (actionJournals.length) {
      const succeeded = new Map(listCaptureReceipts(stateRoot(ctx), config.project_slug, config.limits, "succeeded").map((receipt) => [receipt.session_key, receipt]));
      const recoverable = actionJournals.filter((journal) => {
        const receipt = journal.session_key ? succeeded.get(journal.session_key) : void 0;
        if (!receipt || journal.state !== "reconciled" || journal.binding_id !== config.binding.notebook_id || journal.candidate_ids.length !== 1) return false;
        const index = receipt.note_logical_ids.indexOf(journal.logical_marker);
        return index >= 0 && receipt.remote_note_ids[index] === journal.candidate_ids[0];
      });
      return finding(
        "notebook.capture-receipts",
        "Capture receipts",
        "warn",
        recoverable.length ? "Receipt-proven reconciled capture journals can be finalized locally; other session, document, or user-note journals still require explicit originating-action recovery" : "Unresolved session, document, or user-note mutations require explicit originating-action recovery; retention cleanup cannot resolve them",
        [
          ...journalDetails(actionJournals),
          ...recoverable.length ? [`Run pj notebook migrate ${config.repo_path} --apply to finalize ${recoverable.length} receipt-proven journal(s) without remote work`] : []
        ],
        recoverable.length > 0
      );
    }
    const pressure = currentRetentionPressure(summary);
    if (pressure.length) return finding("notebook.capture-receipts", "Capture receipts", "warn", "Current unresolved capture usage is under retention pressure", pressure.map((item) => item.session_key ? `${item.reason}: ${item.session_key}` : item.reason), false);
    return finding("notebook.capture-receipts", "Capture receipts", "pass", "Capture receipts are measurable; unresolved work is preserved and within admission caps", summary.active_refusals.map((item) => `capture-refused-history: ${item.session_key}`));
  } catch (error) {
    return finding("notebook.capture-receipts", "Capture receipts", "fail", normalizeNotebookError(error).message);
  }
}
function createNotebookChecks() {
  return [
    new NotebookCheck("notebook.configuration", "Notebook configuration", configurationAudit),
    new NotebookCheck("notebook.binding", "Notebook binding", bindingAudit),
    new NotebookCheck("notebook.remote-notebook", "Remote notebook", remoteAudit),
    new NotebookCheck("notebook.overview-note", "Overview note", overviewAudit),
    new NotebookCheck("notebook.skill-installed", "Project Notebook skill", skillAudit),
    new NotebookCheck("notebook.hooks-projected", "Project Notebook hooks", hooksAudit),
    new NotebookCheck("notebook.capture-receipts", "Capture receipts", captureAudit, (ctx, current) => {
      if (ctx.dryRun) return result(current, "applied", "Would expire only elapsed succeeded receipts and elapsed unreferenced receiptless state");
      try {
        const config = resolvedConfig(ctx);
        const removed = pruneNotebookState(stateRoot(ctx), config.project_slug, config.limits);
        return result(current, removed.length ? "applied" : "noop", removed.length ? "Expired only eligible owned capture state" : "No eligible capture state required cleanup", removed);
      } catch (error) {
        return result(current, "blocked", normalizeNotebookError(error).message);
      }
    })
  ];
}

// src/recipes/NotebookRecipe.ts
init_config();

// src/notebook/module.ts
import { randomUUID as randomUUID6 } from "node:crypto";
init_project();
init_config();
init_open_notebook_client();
init_notes();
import { resolve as resolve12 } from "node:path";

// src/notebook/overview.ts
init_notes();
init_git_evidence();
init_types();
import { spawnSync as spawnSync10 } from "node:child_process";
import { realpathSync as realpathSync6 } from "node:fs";
import { relative as relative9, resolve as resolve10, sep as sep5 } from "node:path";
var DEFAULT_OVERVIEW_REFERENCES = [".project.json", "README.md", "AGENTS.md", "CLAUDE.md", "docs/architecture.md"];
function git2(repo, args, timeout) {
  const result2 = spawnSync10("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024, timeout, shell: false });
  return { ok: result2.status === 0, stdout: result2.stdout?.trim() ?? "" };
}
function normalizedReference(repo, value) {
  if (!value || value.includes("\0") || value.startsWith("/") || value.split(/[\\/]/u).includes("..")) throw new NotebookError("INVALID_INPUT", `Overview reference is not a contained relative path: ${value}`);
  const root = realpathSync6(repo);
  const candidate = resolve10(root, value);
  const rel = relative9(root, candidate).split(sep5).join("/");
  if (!rel || rel === ".." || rel.startsWith("../")) throw new NotebookError("INVALID_INPUT", `Overview reference escapes the repository: ${value}`);
  return rel.normalize("NFC");
}
function compileReference(config, path) {
  const tracked = git2(config.repo_path, ["ls-files", "--error-unmatch", "--", path], config.limits.overall_timeout_ms);
  if (!tracked.ok) return { reference: { path, status: "missing", reason: "not-tracked" } };
  const evidence = readSafeEvidenceText(config.repo_path, path, config.limits.source_file_max_bytes);
  if (evidence.status !== "present") return { reference: { path, status: "missing", reason: evidence.reason } };
  const revision = git2(config.repo_path, ["rev-parse", `HEAD:${path}`], config.limits.overall_timeout_ms);
  return {
    reference: {
      path,
      status: "present",
      git_revision: revision.ok ? revision.stdout : "working-tree-only",
      content_sha256: evidence.content_sha256
    },
    content: evidence.content
  };
}
function compileOverviewArtifact(input) {
  const configured = input.config.policy.overview_references;
  const candidates = configured ?? DEFAULT_OVERVIEW_REFERENCES;
  const normalized = [...new Set(candidates.map((path) => normalizedReference(input.config.repo_path, path)))];
  const compiled = normalized.map((path) => compileReference(input.config, path));
  const selected = configured ? compiled : compiled.filter((item) => item.reference.status === "present");
  return {
    descriptor: {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: input.config.project_slug,
      project_name: input.projectName,
      purpose: input.purpose?.trim() || "Purpose not yet documented",
      references: selected.map((item) => item.reference),
      compiler_policy_version: NOTEBOOK_POLICY_VERSION
    },
    reference_contents: Object.fromEntries(selected.flatMap((item) => item.content === void 0 ? [] : [[item.reference.path, item.content]]))
  };
}
function compileOverviewDescriptor(input) {
  return compileOverviewArtifact(input).descriptor;
}
function overviewDescriptorDrift(stored, current) {
  if (!stored) return [{ path: "overview", reason: "missing-descriptor" }];
  const drift = [];
  if (stored.project_slug !== current.project_slug || stored.project_name !== current.project_name || stored.purpose !== current.purpose || stored.compiler_policy_version !== current.compiler_policy_version) {
    drift.push({ path: "overview", reason: "descriptor-metadata-changed" });
  }
  const oldByPath = new Map(stored.references.map((item) => [item.path, item]));
  const currentPaths = new Set(current.references.map((item) => item.path));
  for (const reference of current.references) {
    const old = oldByPath.get(reference.path);
    if (!old) drift.push({ path: reference.path, reason: "reference-added" });
    else if (old.status !== reference.status || old.git_revision !== reference.git_revision || old.content_sha256 !== reference.content_sha256 || old.reason !== reference.reason) {
      drift.push({ path: reference.path, reason: "reference-changed" });
    }
  }
  for (const old of stored.references) if (!currentPaths.has(old.path)) drift.push({ path: old.path, reason: "reference-removed" });
  return drift.slice(0, 100);
}
function renderOverviewContent(input) {
  const sections = [
    `# ${input.descriptor.project_name}`,
    "",
    input.descriptor.purpose
  ];
  for (const reference of input.descriptor.references) {
    sections.push("", `## ${reference.path}`);
    if (reference.status === "missing") {
      sections.push(`[${reference.reason ?? "missing"}]`);
      continue;
    }
    const content = input.referenceContents[reference.path];
    if (content === void 0 || sha256Hex(content) !== reference.content_sha256) {
      sections.push("[reference content unavailable or changed during compilation]");
      continue;
    }
    sections.push(content);
  }
  let body = sections.join("\n");
  if (Array.from(body).length > input.config.policy.overview_max_chars) {
    const suffix = "\n\n[Overview truncated by project-notebook.v1 policy]";
    const keep = Math.max(0, input.config.policy.overview_max_chars - Array.from(suffix).length);
    body = `${Array.from(body).slice(0, keep).join("")}${suffix}`;
  }
  const envelope = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: input.config.project_slug,
    kind: "overview",
    logical_id: overviewLogicalId(input.config.project_slug),
    policy_version: NOTEBOOK_POLICY_VERSION,
    overview_descriptor: input.descriptor
  };
  const marker = `${encodeNoteEnvelope(envelope)}
`;
  const available = input.config.limits.note_max_bytes - Buffer.byteLength(marker, "utf8");
  if (available <= 0) throw new NotebookError("INVALID_INPUT", "Overview ownership descriptor alone exceeds the configured note ceiling");
  if (Buffer.byteLength(body, "utf8") > available) {
    const suffix = "\n\n[Overview truncated by project-notebook.v1 byte policy]";
    const budget = Math.max(0, available - Buffer.byteLength(suffix, "utf8"));
    let used = 0;
    const points = [];
    for (const point of body) {
      const bytes = Buffer.byteLength(point, "utf8");
      if (used + bytes > budget) break;
      points.push(point);
      used += bytes;
    }
    body = `${points.join("")}${suffix}`;
  }
  return `${marker}${body}`;
}

// src/notebook/module.ts
init_reconcile();
init_remote_mutation_journal();
init_state();
init_state();
init_git_evidence();

// src/notebook/observation.ts
init_notes();
init_output();
init_reconcile();
init_config();

// src/notebook/hooks.ts
import { spawn, spawnSync as spawnSync11 } from "node:child_process";
import { createHash as createHash7, randomUUID as randomUUID5 } from "node:crypto";
import { chmodSync as chmodSync4, closeSync as closeSync6, constants as constants5, copyFileSync as copyFileSync3, existsSync as existsSync16, fstatSync as fstatSync4, fsyncSync as fsyncSync4, lstatSync as lstatSync9, mkdirSync as mkdirSync7, openSync as openSync6, readFileSync as readFileSync14, readSync as readSync3, readdirSync as readdirSync7, realpathSync as realpathSync7, renameSync as renameSync5, rmSync as rmSync3, symlinkSync as symlinkSync2, unlinkSync as unlinkSync6, writeFileSync as writeFileSync10 } from "node:fs";
import { basename as basename7, dirname as dirname10, isAbsolute as isAbsolute3, join as join20, parse as parse3, relative as relative10, resolve as resolve11, sep as sep6 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";

// src/utils/version.ts
import { readFileSync as readFileSync13 } from "node:fs";
import { dirname as dirname9, join as join19 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
var PJANGLER_VERSION = (() => {
  try {
    let dir = dirname9(fileURLToPath4(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync13(join19(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname9(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return "0.0.0";
})();

// src/notebook/hooks.ts
init_git_evidence();
init_notes();
init_state();
init_types();
function captureWorkerEnvironment(source, projectSlug) {
  const result2 = {
    PATH: "/usr/bin:/bin",
    PJ_NOTEBOOK_WORKER_PROJECT_SLUG: projectSlug
  };
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "OPEN_NOTEBOOK_PASSWORD"
  ]) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) result2[name] = value;
  }
  const registryPath2 = source.PJ_PROJECT_REGISTRY;
  if (typeof registryPath2 === "string" && isAbsolute3(registryPath2) && !registryPath2.includes("\0") && Buffer.byteLength(registryPath2, "utf8") <= 4096) {
    result2.PJ_PROJECT_REGISTRY = resolve11(registryPath2);
  }
  return result2;
}
var DEFAULT_RUNTIME = {
  now: () => /* @__PURE__ */ new Date(),
  spawnWorker(receiptId, projectSlug) {
    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [entry, "notebook", "worker", "capture", "--receipt-id", receiptId], {
      detached: true,
      stdio: "ignore",
      env: captureWorkerEnvironment(process.env, projectSlug)
    });
    child.unref();
  }
};
function bundledSkillCandidates() {
  const candidates = [];
  let cursor = dirname10(fileURLToPath5(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(join20(cursor, "dist", "assets", "project-notebook-skill"), join20(cursor, "assets", "project-notebook-skill"));
    const parent = dirname10(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [...new Set(candidates.map((candidate) => resolve11(candidate)))];
}
function safeSkillRelativePath(value) {
  if (!value || value.startsWith("/") || value.includes("\0")) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules" || part === "__pycache__")) return false;
  const leaf = parts.at(-1).toLowerCase();
  return !(/\.(?:bak(?:-.+)?|orig|pid|sock|log|db-wal|db-shm)$/u.test(leaf) || leaf.endsWith("~") || leaf === ".env" || leaf.startsWith(".env."));
}
function assertOwnedSkillTree(source) {
  assertNoSymlinkComponents2(source);
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  const walk = (directory) => {
    const directoryStat = lstatSync9(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a non-directory component");
    if (uid !== void 0 && directoryStat.uid !== uid) throw new NotebookError("CONFLICT", "Project Notebook skill source is not owned by the current user");
    if (directoryStat.mode & 3586) throw new NotebookError("CONFLICT", "Project Notebook skill source has unsafe directory mode bits");
    for (const entry of readdirSync7(directory, { withFileTypes: true })) {
      const path = join20(directory, entry.name);
      const stat = lstatSync9(path);
      if (stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a symlink");
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) throw new NotebookError("CONFLICT", "Project Notebook skill source contains a non-regular entry");
      else {
        if (uid !== void 0 && stat.uid !== uid) throw new NotebookError("CONFLICT", "Project Notebook skill file is not owned by the current user");
        if (stat.mode & 3586) throw new NotebookError("CONFLICT", "Project Notebook skill file has unsafe mode bits");
      }
    }
  };
  walk(source);
}
function enumerateSkillPayload(source) {
  const result2 = [];
  const walk = (directory) => {
    for (const entry of readdirSync7(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join20(directory, entry.name);
      const rel = relative10(source, path).split(sep6).join("/");
      if (!rel.includes("/") && (rel === "export-manifest.json" || rel === "SHA256SUMS" || rel === ".source.yaml")) continue;
      if (!safeSkillRelativePath(rel)) throw new NotebookError("CONFLICT", `Project Notebook skill export path is unsafe: ${rel}`);
      const stat = lstatSync9(path);
      if (stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill export contains a symlink");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const expectedMode = rel.endsWith(".sh") || rel.startsWith("scripts/") ? "0755" : "0644";
        result2.push({ path: rel, sha256: createHash7("sha256").update(readFileSync14(path)).digest("hex"), mode: expectedMode });
      } else throw new NotebookError("CONFLICT", "Project Notebook skill export contains a non-regular entry");
    }
  };
  walk(source);
  return result2.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function parsePackedManifest(source) {
  const manifestPath = join20(source, "export-manifest.json");
  if (!existsSync16(manifestPath)) return null;
  const value = JSON.parse(readFileSync14(manifestPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotebookError("CONFLICT", "Project Notebook skill export manifest is invalid");
  const manifest = value;
  if (manifest.schema_version !== 1 || manifest.skill !== "project-notebook" || !Array.isArray(manifest.files)) throw new NotebookError("CONFLICT", "Project Notebook skill export manifest is incompatible");
  const paths = /* @__PURE__ */ new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !/^(?:0644|0755)$/u.test(entry.mode)) throw new NotebookError("CONFLICT", "Project Notebook skill export entry is invalid");
    if (!safeSkillRelativePath(entry.path) || paths.has(entry.path)) throw new NotebookError("CONFLICT", "Project Notebook skill export path is unsafe or duplicated");
    paths.add(entry.path);
    const path = join20(source, ...entry.path.split("/"));
    const stat = lstatSync9(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Project Notebook skill export contains a non-regular entry");
    const actual = createHash7("sha256").update(readFileSync14(path)).digest("hex");
    if (actual !== entry.sha256) throw new NotebookError("CONFLICT", `Project Notebook skill digest mismatch: ${entry.path}`);
    const actualMode = stat.mode & 511;
    const executable = entry.mode === "0755";
    if (executable && (actualMode & 64) === 0 || !executable && (actualMode & 73) !== 0 || (actualMode & ~((executable ? 493 : 420) | 16)) !== 0) {
      throw new NotebookError("CONFLICT", `Project Notebook skill mode mismatch: ${entry.path}`);
    }
  }
  const actualPaths = enumerateSkillPayload(source).map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.files.map((entry) => entry.path))) throw new NotebookError("CONFLICT", "Project Notebook skill manifest does not exactly enumerate its payload");
  const sums = `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}
`;
  if (!existsSync16(join20(source, "SHA256SUMS")) || readFileSync14(join20(source, "SHA256SUMS"), "utf8") !== sums) throw new NotebookError("CONFLICT", "Project Notebook skill SHA256SUMS is missing or stale");
  return manifest;
}
function expectedPackedSkill() {
  for (const candidate of bundledSkillCandidates()) {
    if (!existsSync16(join20(candidate, "export-manifest.json"))) continue;
    assertOwnedSkillTree(candidate);
    const manifest = parsePackedManifest(candidate);
    if (!manifest) continue;
    const digest = createHash7("sha256").update(JSON.stringify(manifest)).digest("hex");
    return { source: candidate, manifest, digest };
  }
  throw new NotebookError("NOT_CONFIGURED", "PJ\xE1ngler package has no verified Project Notebook skill export");
}
function isCanonicalSkillexProjectionPath(path) {
  return resolve11(path).split(sep6).join("/").endsWith("/all-skills/project-notebook");
}
function isVerifiedCanonicalSkillexProjection(path) {
  if (!isCanonicalSkillexProjectionPath(path)) return false;
  try {
    verifyProjectNotebookSkillExport(path);
    return true;
  } catch {
    return false;
  }
}
function describeProjectNotebookSkillDrift(source) {
  let expected;
  try {
    expected = expectedPackedSkill();
  } catch {
    return ["the PJ\xE1ngler package carries no verified Project Notebook export to compare against"];
  }
  let actual;
  try {
    const absolute = resolve11(source);
    const packed = parsePackedManifest(absolute);
    actual = packed?.files ?? enumerateSkillPayload(absolute);
  } catch (error) {
    return [boundedDiagnostic(error)];
  }
  const pinned = new Map(expected.manifest.files.map((entry) => [entry.path, entry]));
  const present = new Map(actual.map((entry) => [entry.path, entry]));
  const drift = [];
  for (const entry of actual) {
    const match = pinned.get(entry.path);
    if (!match) {
      drift.push(`${entry.path}: not part of the pinned export`);
      continue;
    }
    if (match.sha256 !== entry.sha256) drift.push(`${entry.path}: content differs from the pinned export`);
    else if (match.mode !== entry.mode) drift.push(`${entry.path}: mode ${entry.mode} differs from pinned ${match.mode}`);
  }
  for (const entry of expected.manifest.files) {
    if (!present.has(entry.path)) drift.push(`${entry.path}: missing from the projection`);
  }
  return drift.length ? drift.slice(0, 20) : ["no per-file drift detected; the export enumeration itself differs"];
}
function verifyProjectNotebookSkillExport(source) {
  const absolute = resolve11(source);
  assertOwnedSkillTree(absolute);
  const packed = parsePackedManifest(absolute);
  const actual = packed ?? { schema_version: 1, skill: "project-notebook", files: enumerateSkillPayload(absolute) };
  const expected = expectedPackedSkill();
  if (absolute !== expected.source && JSON.stringify(actual.files) !== JSON.stringify(expected.manifest.files)) {
    throw new NotebookError("CONFLICT", "Configured Project Notebook skill does not match the package-pinned export digest");
  }
  return actual;
}
function resolveProjectNotebookSkillSource(env2 = process.env) {
  if (env2.PJ_PROJECT_NOTEBOOK_SKILL_ROOT) {
    const explicit = resolve11(env2.PJ_PROJECT_NOTEBOOK_SKILL_ROOT);
    if (!existsSync16(join20(explicit, "SKILL.md"))) throw new NotebookError("NOT_CONFIGURED", "Configured Project Notebook skill source is unavailable");
    verifyProjectNotebookSkillExport(explicit);
    return explicit;
  }
  if (env2.PJ_SKILLS_REGISTRY_ROOT) {
    const canonical = resolve11(env2.PJ_SKILLS_REGISTRY_ROOT, "all-skills", "project-notebook");
    if (existsSync16(join20(canonical, "SKILL.md"))) {
      verifyProjectNotebookSkillExport(canonical);
      return canonical;
    }
  }
  try {
    return expectedPackedSkill().source;
  } catch {
    return null;
  }
}
var REPAIR_COMMAND = "pj notebook skill --apply";
function probeCanonicalSkillexRootProjection(skillsRoot, link) {
  let rootLink;
  try {
    rootLink = lstatSync9(skillsRoot);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
  if (!rootLink.isSymbolicLink()) return { state: "plain" };
  const decline = (code, summary, details = []) => ({ state: "declined", block: { code, summary, details, repair: REPAIR_COMMAND } });
  try {
    assertNoSymlinkComponents2(dirname10(skillsRoot));
    const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
    if (uid !== void 0 && rootLink.uid !== uid) throw new Error("owner");
    const globalRoot = realpathSync7(skillsRoot);
    assertNoSymlinkComponents2(globalRoot);
    const globalStat = lstatSync9(globalRoot);
    if (!globalStat.isDirectory() || globalStat.isSymbolicLink()) throw new Error("root-type");
    if (uid !== void 0 && globalStat.uid !== uid) throw new Error("root-owner");
    if (globalStat.mode & 3586) throw new Error("root-mode");
    const skillSetsRoot = dirname10(globalRoot);
    if (basename7(globalRoot) !== "global" || basename7(skillSetsRoot) !== "skill-sets") throw new Error("layout");
    const checkoutRoot = dirname10(skillSetsRoot);
    const expectedSource = join20(checkoutRoot, "all-skills", "project-notebook");
    const linkStat = lstatSync9(link);
    if (!linkStat.isSymbolicLink()) throw new Error("projection-type");
    if (uid !== void 0 && linkStat.uid !== uid) throw new Error("projection-owner");
    const projectedSource = realpathSync7(link);
    if (projectedSource !== realpathSync7(expectedSource)) throw new Error("projection-target");
    if (!isVerifiedCanonicalSkillexProjection(projectedSource)) {
      return {
        state: "declined",
        block: {
          code: "projection-drift",
          summary: `Canonical Skillex projection of project-notebook has drifted from the version-pinned export at ${projectedSource}`,
          details: describeProjectNotebookSkillDrift(projectedSource),
          repair: REPAIR_COMMAND,
          repairable_source: projectedSource
        }
      };
    }
    return { state: "adopted", source: projectedSource };
  } catch (error) {
    if (error instanceof NotebookError) {
      return decline("projection-drift", error.message, describeProjectNotebookSkillDrift(link));
    }
    return decline(
      "skills-root-unsupported",
      `${skillsRoot} is a symlink but not the supported Skillex fanout topology (<checkout>/skill-sets/global with project-notebook projected from <checkout>/all-skills)`,
      [`probe rejected at: ${error instanceof Error ? error.message : String(error)}`]
    );
  }
}
function installPackagedProjectNotebookSkill(input = {}) {
  const env2 = input.env ?? process.env;
  const source = input.source ?? resolveProjectNotebookSkillSource(env2);
  if (!source) throw new NotebookError("NOT_CONFIGURED", "Project Notebook skill source is unavailable");
  const manifest = verifyProjectNotebookSkillExport(source);
  const digest = createHash7("sha256").update(JSON.stringify(manifest)).digest("hex");
  const home = env2.HOME;
  if (!home || !resolve11(home).startsWith("/")) throw new NotebookError("NOT_CONFIGURED", "A trusted HOME is required to install the Project Notebook skill");
  const skillsRoot = join20(home, ".agents", "skills");
  const link = join20(skillsRoot, "project-notebook");
  const probe = probeCanonicalSkillexRootProjection(skillsRoot, link);
  if (probe.state === "adopted") return { installed: false, path: link, digest };
  if (probe.state === "declined") return { installed: false, path: link, digest, blocked: probe.block };
  const dataRoot = resolve11(env2.XDG_DATA_HOME || join20(home, ".local", "share"), "pjangler", "skills", "project-notebook");
  const payload = join20(dataRoot, `${PJANGLER_VERSION}-${digest}`);
  assertNoSymlinkComponents2(dirname10(dataRoot), true);
  mkdirSync7(dataRoot, { recursive: true, mode: 448 });
  assertNoSymlinkComponents2(dataRoot);
  const dataStat = lstatSync9(dataRoot);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink() || typeof process.getuid === "function" && dataStat.uid !== process.getuid()) throw new NotebookError("CONFLICT", "Project Notebook skill data root is not a current-user directory");
  chmodSync4(dataRoot, 448);
  if (!existsSync16(payload)) {
    const staging = join20(dataRoot, `.staging-${randomUUID5()}`);
    mkdirSync7(staging, { recursive: false, mode: 448 });
    try {
      for (const entry of manifest.files) {
        const destination = join20(staging, ...entry.path.split("/"));
        mkdirSync7(dirname10(destination), { recursive: true, mode: 493 });
        copyFileSync3(join20(source, ...entry.path.split("/")), destination);
        const mode = entry.mode === "0755" ? 493 : 420;
        chmodSync4(destination, mode);
        const fd = openSync6(destination, constants5.O_RDONLY | (constants5.O_NOFOLLOW ?? 0));
        try {
          const current = fstatSync4(fd);
          if (!current.isFile()) throw new NotebookError("CONFLICT", `Installed skill entry is not regular: ${entry.path}`);
          fsyncSync4(fd);
        } finally {
          closeSync6(fd);
        }
      }
      writeFileSync10(join20(staging, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}
`, { mode: 420, flag: "wx" });
      writeFileSync10(join20(staging, "SHA256SUMS"), `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}
`, { mode: 420, flag: "wx" });
      verifyProjectNotebookSkillExport(staging);
      renameSync5(staging, payload);
    } finally {
      if (existsSync16(staging)) rmSync3(staging, { recursive: true, force: true });
    }
  } else {
    const stat = lstatSync9(payload);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NotebookError("CONFLICT", "Installed Project Notebook payload is not a real directory");
    verifyProjectNotebookSkillExport(payload);
  }
  assertNoSymlinkComponents2(skillsRoot, true);
  mkdirSync7(skillsRoot, { recursive: true, mode: 448 });
  assertNoSymlinkComponents2(skillsRoot);
  let linkExists = existsSync16(link);
  if (!linkExists) {
    try {
      lstatSync9(link);
      linkExists = true;
    } catch {
    }
  }
  if (linkExists) {
    const foreign = (details) => ({
      installed: false,
      path: link,
      digest,
      blocked: {
        code: "projection-foreign",
        summary: `${link} is customized or foreign; PJ\xE1ngler will not replace it`,
        details,
        repair: REPAIR_COMMAND
      }
    });
    const stat = lstatSync9(link);
    if (!stat.isSymbolicLink()) return foreign(["the path is a real file or directory, not a PJ\xE1ngler-owned link"]);
    const target = realpathSync7(link);
    if (target !== realpathSync7(payload) && !isVerifiedCanonicalSkillexProjection(target)) {
      return foreign(isCanonicalSkillexProjectionPath(target) ? describeProjectNotebookSkillDrift(target) : [`the link targets ${target}, which is neither the pinned payload nor a canonical Skillex projection`]);
    }
    try {
      verifyProjectNotebookSkillExport(target);
    } catch {
      return foreign(describeProjectNotebookSkillDrift(target));
    }
    return { installed: false, path: link, digest };
  }
  symlinkSync2(payload, link, "dir");
  collectSupersededPayloads(dataRoot, [payload, link]);
  return { installed: true, path: link, digest };
}
function collectSupersededPayloads(dataRoot, keep) {
  const kept = /* @__PURE__ */ new Set();
  for (const path of keep) {
    try {
      kept.add(realpathSync7(path));
    } catch {
    }
  }
  const removed = [];
  let entries;
  try {
    entries = readdirSync7(dataRoot);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{64}$/u.test(name)) continue;
    const candidate = join20(dataRoot, name);
    try {
      const stat = lstatSync9(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (kept.has(realpathSync7(candidate))) continue;
      rmSync3(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch {
    }
  }
  return removed;
}
function repairProjectNotebookSkillProjection(input = {}) {
  const env2 = input.env ?? process.env;
  const home = env2.HOME;
  if (!home || !resolve11(home).startsWith("/")) throw new NotebookError("NOT_CONFIGURED", "A trusted HOME is required to repair the Project Notebook skill projection");
  const skillsRoot = join20(home, ".agents", "skills");
  const link = join20(skillsRoot, "project-notebook");
  const probe = probeCanonicalSkillexRootProjection(skillsRoot, link);
  if (probe.state === "adopted") return { status: "clean", summary: "Canonical Skillex projection already matches the version-pinned export", source: probe.source, drift: [], changed_files: [] };
  if (probe.state !== "declined") {
    return { status: "clean", summary: "No canonical Skillex projection is in use; the version-pinned payload is installed directly", source: null, drift: [], changed_files: [] };
  }
  const source = probe.block.repairable_source;
  if (!source) return { status: "blocked", summary: probe.block.summary, source: null, drift: probe.block.details, changed_files: [] };
  const expected = expectedPackedSkill();
  const wanted = new Set(expected.manifest.files.map((entry) => entry.path));
  assertOwnedSkillTree(source);
  const present = [];
  const walk = (directory) => {
    for (const entry of readdirSync7(directory, { withFileTypes: true })) {
      const path = join20(directory, entry.name);
      const rel = relative10(source, path).split(sep6).join("/");
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) throw new NotebookError("CONFLICT", `Refusing to repair a projection containing a non-regular entry: ${rel}`);
      if (!rel.includes("/") && (rel === "export-manifest.json" || rel === "SHA256SUMS" || rel === ".source.yaml")) continue;
      present.push(rel);
    }
  };
  walk(source);
  const stale = present.filter((rel) => !wanted.has(rel)).sort();
  const changed = expected.manifest.files.filter((entry) => {
    const path = join20(source, ...entry.path.split("/"));
    if (!existsSync16(path)) return true;
    const stat = lstatSync9(path);
    if (!stat.isFile()) return true;
    if (createHash7("sha256").update(readFileSync14(path)).digest("hex") !== entry.sha256) return true;
    const mode = stat.mode & 511;
    const executable = entry.mode === "0755";
    return executable && (mode & 64) === 0 || !executable && (mode & 73) !== 0;
  }).map((entry) => entry.path);
  const affected = [.../* @__PURE__ */ new Set([...changed, ...stale])].sort();
  if (!affected.length) {
    return { status: "blocked", summary: `${source} does not verify against the pinned export, but no per-file difference was found`, source, drift: probe.block.details, changed_files: [] };
  }
  if (!input.apply) {
    return {
      status: "planned",
      summary: `Would restore ${affected.length} file(s) in ${source} from the version-pinned export`,
      source,
      drift: probe.block.details,
      changed_files: affected.map((rel) => join20(source, ...rel.split("/")))
    };
  }
  for (const rel of stale) rmSync3(join20(source, ...rel.split("/")), { force: true });
  for (const rel of changed) {
    const destination = join20(source, ...rel.split("/"));
    const entry = expected.manifest.files.find((item) => item.path === rel);
    mkdirSync7(dirname10(destination), { recursive: true, mode: 493 });
    copyFileSync3(join20(expected.source, ...rel.split("/")), destination);
    chmodSync4(destination, entry.mode === "0755" ? 493 : 420);
  }
  verifyProjectNotebookSkillExport(source);
  return {
    status: "repaired",
    summary: `Restored ${affected.length} file(s) in ${source} from the version-pinned export; commit the change in the Skillex checkout`,
    source,
    drift: probe.block.details,
    changed_files: affected.map((rel) => join20(source, ...rel.split("/")))
  };
}
function inspectProjectNotebookIntegration(env2 = process.env) {
  const home = env2.HOME;
  if (!home) return { skill_installed: false, hooks_projected: false, details: ["HOME is unavailable"] };
  const skillsRoot = join20(home, ".agents", "skills");
  const link = join20(skillsRoot, "project-notebook");
  try {
    const expected = expectedPackedSkill();
    const dataRoot = resolve11(env2.XDG_DATA_HOME || join20(home, ".local", "share"), "pjangler", "skills", "project-notebook");
    const expectedPayload = join20(dataRoot, `${PJANGLER_VERSION}-${expected.digest}`);
    const probe = probeCanonicalSkillexRootProjection(skillsRoot, link);
    if (probe.state === "declined") return { skill_installed: false, hooks_projected: false, details: probe.block.details, blocked: probe.block };
    const stat = lstatSync9(link);
    if (!stat.isSymbolicLink()) {
      return {
        skill_installed: false,
        hooks_projected: false,
        details: ["Project Notebook skill path is not an owned link"],
        blocked: { code: "projection-foreign", summary: `${link} is not a PJ\xE1ngler-owned link`, details: ["the path is a real file or directory"], repair: REPAIR_COMMAND }
      };
    }
    const source = realpathSync7(link);
    const packedPayloadMatches = existsSync16(expectedPayload) && source === realpathSync7(expectedPayload);
    if (!packedPayloadMatches && !isVerifiedCanonicalSkillexProjection(source)) {
      const details = isCanonicalSkillexProjectionPath(source) ? describeProjectNotebookSkillDrift(source) : [`the link targets ${source}, which is neither the version-pinned payload nor a canonical Skillex projection`];
      return {
        skill_installed: false,
        hooks_projected: false,
        details,
        blocked: {
          code: isCanonicalSkillexProjectionPath(source) ? "projection-drift" : "projection-foreign",
          summary: `Project Notebook skill link targets a foreign or stale payload: ${source}`,
          details,
          repair: REPAIR_COMMAND
        }
      };
    }
    verifyProjectNotebookSkillExport(source);
    const hooks = checkProjectNotebookHooks({ source, env: env2 });
    return {
      skill_installed: true,
      hooks_projected: hooks.ok,
      details: hooks.findings.map((finding2) => `${finding2.kind}:${finding2.event}:${finding2.message}`).slice(0, 20)
    };
  } catch (error) {
    return { skill_installed: false, hooks_projected: false, details: [boundedDiagnostic(error)] };
  }
}
function projectorArguments(source, command, input) {
  const script = join20(source, "scripts", "project-hooks.py");
  const args = [script, command, "--master", join20(source, "hooks", "hooks.master.json"), "--fragment", join20(source, "hooks", "claude.settings.json"), "--target", input.target];
  if (command === "check") args.push("--json");
  else if (input.stateHome) args.push("--state-home", input.stateHome);
  return args;
}
function projectorEnvironment(env2) {
  const result2 = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  if (env2.HOME) result2.HOME = env2.HOME;
  if (env2.XDG_STATE_HOME) result2.XDG_STATE_HOME = env2.XDG_STATE_HOME;
  return result2;
}
function checkProjectNotebookHooks(input = {}) {
  const env2 = input.env ?? process.env;
  const source = input.source ?? resolveProjectNotebookSkillSource(env2);
  if (!source) throw new NotebookError("NOT_CONFIGURED", "Project Notebook skill source is unavailable; reinstall or rebuild PJangler");
  verifyProjectNotebookSkillExport(source);
  const home = env2.HOME;
  if (!home) throw new NotebookError("NOT_CONFIGURED", "HOME is required to check Project Notebook hooks");
  const target = resolve11(input.target ?? env2.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? join20(home, ".claude", "settings.json"));
  const result2 = spawnSync11("/usr/bin/python3", ["-I", ...projectorArguments(source, "check", { target })], { encoding: "utf8", env: projectorEnvironment(env2), timeout: 5e3, maxBuffer: 1048576 });
  if (result2.status !== 0 && result2.status !== 1) throw new NotebookError("CONFLICT", (result2.stderr || "Project Notebook projector check failed").trim().slice(0, 512));
  try {
    const parsed = JSON.parse(result2.stdout);
    if (typeof parsed.ok !== "boolean" || !Array.isArray(parsed.findings)) throw new Error("shape");
    return parsed;
  } catch {
    throw new NotebookError("INTERNAL_ERROR", "Project Notebook projector returned invalid check JSON");
  }
}
function installProjectNotebookIntegration(input = {}) {
  const env2 = input.env ?? process.env;
  const skill = installPackagedProjectNotebookSkill({ source: input.source, env: env2 });
  if (skill.blocked) return { skill, hooksChanged: false, blocked: skill.blocked };
  const source = realpathSync7(skill.path);
  const home = env2.HOME;
  if (!home) throw new NotebookError("NOT_CONFIGURED", "HOME is required to install Project Notebook hooks");
  const target = resolve11(input.target ?? env2.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? join20(home, ".claude", "settings.json"));
  const stateHome = resolve11(env2.XDG_STATE_HOME || join20(home, ".local", "state"));
  const result2 = spawnSync11("/usr/bin/python3", ["-I", ...projectorArguments(source, "install", { target, stateHome })], { encoding: "utf8", env: projectorEnvironment(env2), timeout: 5e3, maxBuffer: 1048576 });
  if (result2.status !== 0) {
    if (skill.installed) {
      try {
        const stat = lstatSync9(skill.path);
        if (stat.isSymbolicLink() && realpathSync7(skill.path) === source) unlinkSync6(skill.path);
      } catch {
      }
    }
    throw new NotebookError("CONFLICT", (result2.stderr || "Project Notebook hook installation failed").trim().slice(0, 512));
  }
  return { skill, hooksChanged: /\bchanged\b/u.test(result2.stdout) };
}
function boundedDiagnostic(value, max = 512) {
  const message = value instanceof NotebookError ? value.message : "Project Notebook encountered an unexpected internal error";
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").slice(0, max);
}
function parsePayload(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Hook payload exceeds its configured ceiling");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new NotebookError("INVALID_INPUT", "Hook payload must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new NotebookError("INVALID_INPUT", "Hook payload must be a JSON object");
  return parsed;
}
function readBoundedHookStdin(maxBytes, fd = 0) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
    const count = readSync3(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new NotebookError("INVALID_INPUT", "Hook stdin exceeds its configured ceiling");
    chunks.push(chunk.subarray(0, count));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new NotebookError("INVALID_INPUT", "Hook stdin must be valid UTF-8");
  }
}
function assertNoSymlinkComponents2(path, allowMissing = false) {
  const absolute = resolve11(path);
  const root = parse3(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(sep6).filter(Boolean)) {
    cursor = join20(cursor, component);
    let stat;
    try {
      stat = lstatSync9(cursor);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new NotebookError("INVALID_INPUT", "Hook payload path contains a symlink component");
  }
}
function readHookPayload(input) {
  if (!input.payloadFile) {
    const value = input.stdin ?? readBoundedHookStdin(input.maxBytes);
    return { payload: parsePayload(value, input.maxBytes), bytes: Buffer.byteLength(value, "utf8") };
  }
  const root = resolve11(input.stateRoot);
  const path = resolve11(input.payloadFile);
  const rel = relative10(root, path);
  if (rel === ".." || rel.startsWith(`..${sep6}`) || rel.startsWith(sep6)) throw new NotebookError("INVALID_INPUT", "Hook payload file is outside Notebook XDG state");
  assertNoSymlinkComponents2(root);
  assertNoSymlinkComponents2(path);
  const before = lstatSync9(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 511) !== 384 || before.nlink !== 1) throw new NotebookError("INVALID_INPUT", "Hook payload file must be a contained mode-0600 regular file");
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new NotebookError("INVALID_INPUT", "Hook payload file must be owned by the current user");
  if (before.size > input.maxBytes) throw new NotebookError("INVALID_INPUT", "Hook payload file exceeds its configured ceiling");
  const fd = openSync6(path, constants5.O_RDONLY | (constants5.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync4(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new NotebookError("INVALID_INPUT", "Hook payload file changed while opening");
    const value = readBoundedHookStdin(input.maxBytes, fd);
    return { payload: parsePayload(value, input.maxBytes), bytes: Buffer.byteLength(value, "utf8") };
  } finally {
    closeSync6(fd);
  }
}
function identity(payload) {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const repo = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  const client = typeof payload.client_name === "string" ? payload.client_name.trim().toLowerCase() : "claude-code";
  if (!sessionId || !repo) return null;
  if (client !== "claude" && client !== "claude-code") return null;
  return { sessionId, repo, client: "claude-code" };
}
function eventAllowed(payload, expected) {
  if (payload.hook_event_name === void 0) return true;
  return payload.hook_event_name === expected;
}
function truncateCodePoints(value, max) {
  const points = Array.from(value);
  if (points.length <= max) return { text: value, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}
async function runSessionStartHook(module, payload, runtime = DEFAULT_RUNTIME) {
  const hookStarted = performance.now();
  try {
    if (!eventAllowed(payload, "SessionStart")) return { exitCode: 0, stdout: "", stderr: "project-notebook: unsupported non-SessionStart event skipped", outcome: "skipped" };
    const id = identity(payload);
    if (!id) return { exitCode: 0, stdout: "", stderr: "project-notebook: missing or unsupported session identity; skipped", outcome: "skipped" };
    const ctx = module.context(id.repo, false);
    if (ctx.config.binding.state !== "linked" || !ctx.config.policy.session_start_enabled && !ctx.config.policy.session_capture_enabled) return { exitCode: 0, stdout: "", stderr: "", outcome: "skipped" };
    const budget = ctx.config.limits.hook_session_start_timeout_ms;
    const safetyMargin = Math.min(50, Math.max(1, Math.floor(budget * 0.05)));
    const deadline = hookStarted + Math.max(1, budget - safetyMargin);
    const sessionKey = deriveSessionKey(ctx.config.project_slug, id.client, id.sessionId);
    let baseline = readSessionBaseline(module.stateRoot, ctx.config.project_slug, sessionKey, ctx.config.limits);
    if (!baseline) {
      const snapshot = captureGitSnapshot(ctx.config.repo_path, ctx.config, deadline);
      baseline = createSessionBaseline(module.stateRoot, {
        limits: ctx.config.limits,
        session_key: sessionKey,
        project_slug: ctx.config.project_slug,
        client: id.client,
        created_at: runtime.now().toISOString(),
        repo_path: ctx.config.repo_path,
        git_head: snapshot.head,
        git_status_digest: snapshot.status_digest,
        policy_version: NOTEBOOK_POLICY_VERSION,
        tracked_path_digests: snapshot.tracked_path_digests,
        pre_dirty_paths: snapshot.dirty_paths,
        complete: snapshot.complete,
        incomplete_reasons: snapshot.reasons
      }).baseline;
    } else if (runtime.now().getTime() >= Date.parse(baseline.created_at) + ctx.config.limits.receiptless_session_retention_seconds * 1e3) {
      return { exitCode: 0, stdout: "", stderr: "project-notebook: SessionStart resume is older than the receiptless baseline grace; skipped without inventing a new boundary", outcome: "failed-open" };
    }
    if (performance.now() >= deadline) return { exitCode: 0, stdout: "", stderr: "project-notebook: SessionStart budget exhausted after recording an incomplete baseline; failed open", outcome: "failed-open" };
    if (!ctx.config.policy.session_start_enabled || ctx.config.binding.state !== "linked") return { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    if (readOverviewClaim(module.stateRoot, ctx.config.project_slug, sessionKey)) return { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    try {
      const overview = await module.overview(id.repo, void 0, deadline);
      const stale = overview.data.drift.length > 0;
      const warning = stale ? `PROJECT NOTEBOOK OVERVIEW DRIFT
${overview.data.drift.map((item) => `${item.path}: ${item.reason}`).join("\n")}

[Stored Overview is stale]
` : "";
      const bounded3 = truncateCodePoints(overview.data.note.content, ctx.config.policy.overview_max_chars);
      const content = `PROJECT NOTEBOOK
${warning}${bounded3.text}${bounded3.truncated ? "\n[Project Notebook Overview truncated]" : ""}
`;
      const claim = createOverviewClaim(module.stateRoot, {
        session_key: sessionKey,
        project_slug: ctx.config.project_slug,
        created_at: runtime.now().toISOString(),
        overview_note_id: overview.data.note.id,
        content_sha256: sha256Hex(content)
      });
      return claim.created ? { exitCode: 0, stdout: content, stderr: "", outcome: "primed" } : { exitCode: 0, stdout: "", stderr: "", outcome: "primed" };
    } catch (error) {
      return { exitCode: 0, stdout: "", stderr: `project-notebook: Overview unavailable: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
    }
  } catch (error) {
    return { exitCode: 0, stdout: "", stderr: `project-notebook: SessionStart failed open: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
  }
}
function runSessionCloseHook(module, payload, runtime = DEFAULT_RUNTIME) {
  const started = Date.now();
  try {
    if (!eventAllowed(payload, "SessionEnd")) return { exitCode: 0, stdout: "", stderr: "project-notebook: unsupported non-SessionEnd event skipped", outcome: "skipped" };
    const id = identity(payload);
    if (!id) return { exitCode: 0, stdout: "", stderr: "project-notebook: missing or unsupported session identity; skipped", outcome: "skipped" };
    const ctx = module.context(id.repo, false);
    if (ctx.config.binding.state !== "linked" || !ctx.config.policy.session_capture_enabled) return { exitCode: 0, stdout: "", stderr: "", outcome: "skipped" };
    const sessionKey = deriveSessionKey(ctx.config.project_slug, id.client, id.sessionId);
    const admission2 = admitCaptureReceipt({
      root: module.stateRoot,
      projectSlug: ctx.config.project_slug,
      repoPath: ctx.config.repo_path,
      sessionKey,
      endRevision: null,
      endStatusDigest: null,
      limits: ctx.config.limits,
      now: runtime.now()
    });
    if (admission2.outcome === "state-integrity") return { exitCode: 0, stdout: "", stderr: admission2.diagnostic.slice(0, 2048), outcome: "state-integrity" };
    if (admission2.outcome === "retention-pressure") return { exitCode: 0, stdout: "", stderr: admission2.diagnostic.slice(0, 2048), outcome: "retention-pressure" };
    if (admission2.outcome === "deduplicated") return { exitCode: 0, stdout: "", stderr: "", outcome: "deduplicated", receiptId: admission2.receipt.receipt_id };
    runtime.spawnWorker(admission2.receipt.receipt_id, ctx.config.project_slug);
    const elapsed = Date.now() - started;
    return {
      exitCode: 0,
      stdout: "",
      stderr: elapsed > ctx.config.limits.hook_session_end_timeout_ms ? "project-notebook: capture was durably queued but foreground budget was exceeded" : "",
      outcome: "captured",
      receiptId: admission2.receipt.receipt_id
    };
  } catch (error) {
    return { exitCode: 0, stdout: "", stderr: `project-notebook: SessionEnd failed open: ${boundedDiagnostic(error)}`, outcome: "failed-open" };
  }
}

// src/notebook/observation.ts
async function prepareNotebookObservation(module, repo, localOnly = false) {
  const local = module.context(repo, false);
  return prepareNotebookObservationResolved(module, local.resolved, local.config, localOnly);
}
async function prepareNotebookObservationResolved(module, resolved, config, localOnly = false, integrationEnv = module.environment) {
  const local = { resolved, config };
  const integration = inspectProjectNotebookIntegration(integrationEnv);
  const base = {
    schema_version: 1,
    fetched_at: (/* @__PURE__ */ new Date()).toISOString(),
    project_slug: local.config.project_slug,
    binding_used: { ...local.config.binding },
    auth_mode: local.config.auth.mode,
    base_url_configured: Boolean(local.config.base_url),
    skill_installed: integration.skill_installed,
    hooks_projected: integration.hooks_projected,
    skill_host_block: integration.blocked ?? null
  };
  if (localOnly || !local.config.base_url) {
    return {
      ...base,
      remote_check: "skip",
      health: localOnly ? null : "unconfigured",
      notebook_check: { status: "skip", drift: [] },
      notebook: null,
      scoped_notes: [],
      overview: null,
      error: null
    };
  }
  let notebookCheck = null;
  let observedNotebook = null;
  try {
    const client = module.clientForConfig(local.config);
    const notebooks = await client.listNotebooks();
    const id = local.config.binding.notebook_id;
    const notebook = id ? notebooks.find((item) => item.id === id) ?? null : null;
    const marker = projectNotebookMarker(local.config.project_slug);
    const markerCandidates = notebooks.filter((item) => item.description?.split(/\r?\n/u)[0] === marker);
    const notebookDrift = [];
    if (!id) notebookDrift.push({ path: "binding.notebook_id", reason: "missing" });
    if (!notebook) notebookDrift.push({ path: "notebook", reason: "bound-id-not-found" });
    if (markerCandidates.length === 0) notebookDrift.push({ path: "notebook.marker", reason: "missing" });
    else if (markerCandidates.length > 1) notebookDrift.push({ path: "notebook.marker", reason: `ambiguous:${markerCandidates.length}` });
    if (notebook && notebook.description?.split(/\r?\n/u)[0] !== marker) notebookDrift.push({ path: "notebook.marker", reason: "bound-notebook-mismatch" });
    if (notebook && notebook.name !== notebookDisplayName(local.resolved)) notebookDrift.push({ path: "notebook.name", reason: "mismatch" });
    if (notebook?.archived === true) notebookDrift.push({ path: "notebook.archived", reason: "archived" });
    notebookCheck = {
      status: notebookDrift.length === 0 ? "pass" : "fail",
      drift: notebookDrift
    };
    observedNotebook = notebook;
    if (!notebook) {
      return { ...base, remote_check: "fail", health: local.config.binding.state === "planned" ? "blocked" : "drifted", notebook_check: notebookCheck, notebook: null, scoped_notes: [], overview: null, error: null };
    }
    const notes = await client.listNotes(notebook.id);
    const overviewId = local.config.binding.overview_note_id;
    const overviewNote = overviewId ? notes.find((item) => item.id === overviewId) : void 0;
    let overview = null;
    if (overviewId) {
      const parsed = overviewNote ? parseNoteEnvelope(overviewNote.content) : null;
      const current = compileOverviewDescriptor({ config: local.config, projectName: local.resolved.project.name, purpose: local.resolved.project.description });
      overview = {
        present: Boolean(overviewNote),
        member: Boolean(overviewNote),
        envelope_owned: Boolean(parsed && parsed.envelope.kind === "overview" && parsed.envelope.project_slug === local.config.project_slug && parsed.envelope.logical_id === `overview:v1:${local.config.project_slug}`),
        drift: parsed?.envelope.kind === "overview" ? overviewDescriptorDrift(parsed.envelope.overview_descriptor, current) : [{ path: "overview", reason: "invalid-envelope" }]
      };
    }
    const healthy = notebookCheck.status === "pass" && Boolean(overview?.present) && Boolean(overview?.envelope_owned) && overview.drift.length === 0;
    return {
      ...base,
      remote_check: healthy ? "pass" : "fail",
      health: healthy ? "healthy" : "drifted",
      notebook_check: notebookCheck,
      notebook,
      scoped_notes: notes.map((note2) => ({
        id: note2.id,
        title: note2.title,
        note_type: note2.note_type,
        created_at: note2.created_at,
        updated_at: note2.updated_at,
        envelope_logical_id: parseNoteEnvelope(note2.content)?.envelope.logical_id ?? null
      })),
      overview,
      error: null
    };
  } catch (error) {
    const normalized = normalizeNotebookError(error);
    return {
      ...base,
      remote_check: "fail",
      health: "unavailable",
      notebook_check: notebookCheck ?? { status: "fail", drift: [{ path: "remote", reason: `unavailable:${normalized.code}` }] },
      notebook: observedNotebook,
      scoped_notes: [],
      overview: null,
      error: { code: normalized.code, retryable: normalized.retryable, message: normalized.message.slice(0, 512) }
    };
  }
}

// src/notebook/module.ts
import { homedir as homedir7 } from "node:os";
init_types();
function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    const item = value;
    if (item.schema_version !== 1 || !item.notebook_id || typeof item.updated_at !== "string" || typeof item.id !== "string") throw new Error("shape");
    return item;
  } catch {
    throw new NotebookError("INVALID_INPUT", "Malformed or incompatible notebook cursor");
  }
}
function encodeCursor(value) {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}
function sortedNotes(notes) {
  const timestamp2 = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...notes].sort((a, b) => timestamp2(b.updated_at) - timestamp2(a.updated_at) || a.id.localeCompare(b.id, "en"));
}
function bindingNotebook(config) {
  if (config.binding.state !== "linked" || !config.binding.notebook_id) throw new NotebookError("NOT_CONFIGURED", "Project Notebook binding is not linked");
  return { notebookId: config.binding.notebook_id, overviewId: config.binding.overview_note_id };
}
function ensureText(value, label, maxBytes) {
  if (!value.trim()) throw new NotebookError("INVALID_INPUT", `${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", `${label} exceeds the configured ceiling`);
  return value;
}
function ensureTitle(value, label = "Note title") {
  ensureText(value, label, 4096);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new NotebookError("INVALID_INPUT", `${label} must not contain control characters`);
  return value;
}
function ensureFinalNoteContent(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Final managed note content including its ownership envelope exceeds the configured ceiling");
  return value;
}
function getScoped(notes, noteId) {
  const note2 = notes.find((item) => item.id === noteId);
  if (!note2) throw new NotebookError("NOT_FOUND", `Note is not a proven member of this project notebook: ${noteId}`);
  return note2;
}
var NotebookModule = class {
  registryPath;
  stateRoot;
  environment;
  fetch;
  clientFactory;
  registryStore;
  constructor(options = {}) {
    this.registryPath = options.registryPath ?? projectRegistryPath(options.env);
    this.stateRoot = options.stateRoot ?? notebookStateRoot(options.env);
    this.environment = options.env ?? process.env;
    this.fetch = options.fetch;
    this.clientFactory = options.clientFactory;
    this.registryStore = options.registryStore;
  }
  installIntegration(env2 = this.environment) {
    const installed = installProjectNotebookIntegration({ env: env2 });
    const home = env2.HOME;
    return {
      changedFiles: [
        ...installed.skill.installed ? [installed.skill.path] : [],
        ...installed.hooksChanged ? [resolve12(env2.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS ?? `${home}/.claude/settings.json`)] : []
      ],
      ...installed.blocked ? { blocked: installed.blocked } : {}
    };
  }
  /** PJAN-82: reconcile a drifted canonical Skillex projection from the pinned export. */
  repairSkillProjection(apply, env2 = this.environment) {
    return repairProjectNotebookSkillProjection({ env: env2, apply });
  }
  repairBindingProjection(repo = process.cwd()) {
    const ctx = this.context(repo, false);
    return persistProjectNotebookBinding(ctx.resolved, ctx.config.binding);
  }
  async declareNotebook(repo = process.cwd()) {
    const resolved = resolveNotebookProject(repo, this.registryPath);
    const changed = persistProjectNotebookDeclaration(resolved);
    await this.persistPostgresMirror(resolved.registry);
    return changed;
  }
  clientForConfig(config, deadlineMonotonicMs) {
    requireRemoteNotebookConfig(config);
    return this.clientFactory?.(config) ?? new OpenNotebookClient(config, { fetch: this.fetch, env: this.environment, deadlineMonotonicMs });
  }
  context(repo = process.cwd(), remote = false) {
    const resolved = resolveNotebookProject(repo, this.registryPath);
    const config = resolveEffectiveNotebookConfig(resolved);
    if (!remote) return { resolved, config };
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    return { resolved, config, client };
  }
  contextBySlug(projectSlug, remote = false) {
    const registry = resolveNotebookProjectBySlug(projectSlug, this.registryPath);
    const config = resolveEffectiveNotebookConfig(registry);
    if (!remote) return { resolved: registry, config };
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    return { resolved: registry, config, client };
  }
  async status(repo = process.cwd(), localOnly = false) {
    const audited = await this.audit(repo, localOnly);
    const admission2 = audited.data.capture_admission;
    const findings = audited.data.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    return {
      config: audited.config,
      health: audited.health,
      data: {
        policy: audited.config.policy,
        configuration_provenance: audited.config.configuration_provenance,
        remote_check: audited.data.remote_check,
        unresolved_receipt_count: admission2.unresolved_count,
        unresolved_receipt_bytes: admission2.unresolved_bytes,
        receipt_caps: admission2.receipt_caps,
        capture_admission: admission2,
        findings
      }
    };
  }
  async create(repo = process.cwd(), live = false) {
    if (!live) throw new NotebookError("INVALID_INPUT", "notebook create requires --live");
    const ctx = this.context(repo, true);
    const provisioned = await this.provisionResolved(ctx.resolved, ctx.config);
    const changedFiles = persistProjectNotebookBinding(ctx.resolved, provisioned.binding);
    await this.persistPostgresMirror(ctx.resolved.registry);
    for (const journal of provisioned.journals) commitReconciledRemoteMutation(this.stateRoot, journal);
    const config = loadEffectiveNotebookConfig(repo, this.registryPath);
    return { config, health: "healthy", data: provisioned.data, changedFiles };
  }
  async persistPostgresMirror(registry) {
    if (!this.registryStore && !isPgRegistryEnabled(this.environment)) return;
    let owned;
    const store = this.registryStore ?? (owned = new PgRegistryStore(pgRegistryConfigFromEnv(this.environment)));
    try {
      await store.save(registry);
    } catch (error) {
      throw new NotebookError("SERVICE_UNAVAILABLE", "PostgreSQL Registry dual-write failed after YAML authority was durably preserved", true, {}, { cause: error });
    } finally {
      await owned?.close();
    }
  }
  async provisionResolved(resolved, config = resolveEffectiveNotebookConfig(resolved)) {
    requireRemoteNotebookConfig(config);
    const client = this.clientForConfig(config);
    const reconciled = await reconcileProjectNotebook({
      stateRoot: this.stateRoot,
      projectSlug: config.project_slug,
      name: notebookDisplayName(resolved),
      description: resolved.project.description,
      client
    });
    const compiledOverview = compileOverviewArtifact({ config, projectName: resolved.project.name, purpose: resolved.project.description });
    const overviewContent = renderOverviewContent({ config, descriptor: compiledOverview.descriptor, referenceContents: compiledOverview.reference_contents });
    const overview = await reconcileManagedNote({
      stateRoot: this.stateRoot,
      projectSlug: config.project_slug,
      notebookId: reconciled.notebook.id,
      logicalId: `overview:v1:${config.project_slug}`,
      title: "Project Overview",
      content: overviewContent,
      client
    });
    const binding = {
      ...config.binding,
      state: "linked",
      notebook_id: reconciled.notebook.id,
      notebook_name: reconciled.notebook.name,
      overview_note_id: overview.note.id,
      blocked_reason: void 0
    };
    return {
      binding,
      data: {
        created: reconciled.created || overview.created,
        adopted: reconciled.adopted || overview.adopted,
        notebook_id: reconciled.notebook.id,
        overview_note_id: overview.note.id
      },
      journals: [reconciled.journal, overview.journal]
    };
  }
  async scoped(repo, deadlineMonotonicMs) {
    const local = this.context(repo, false);
    requireRemoteNotebookConfig(local.config);
    const ctx = { ...local, client: this.clientForConfig(local.config, deadlineMonotonicMs) };
    const { notebookId } = bindingNotebook(ctx.config);
    const notes = await ctx.client.listNotes(notebookId);
    return { ctx, notes, notebookId };
  }
  async listNotes(repo = process.cwd(), limit = 50, cursor) {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ctx.config.limits.list_max_items) throw new NotebookError("INVALID_INPUT", "Note list limit is outside configured bounds");
    const ordered = sortedNotes(notes);
    let start = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded.notebook_id !== notebookId) throw new NotebookError("INVALID_INPUT", "Notebook cursor belongs to a different binding");
      const index = ordered.findIndex((item) => item.id === decoded.id && (item.updated_at ?? "") === decoded.updated_at);
      if (index < 0) throw new NotebookError("INVALID_INPUT", "Notebook cursor is stale or invalid");
      start = index + 1;
    }
    const page = ordered.slice(start, start + limit);
    const last = page.at(-1);
    const nextCursor = start + page.length < ordered.length && last ? encodeCursor({ schema_version: 1, notebook_id: notebookId, updated_at: last.updated_at ?? "", id: last.id }) : null;
    return { config: ctx.config, data: { items: page.map((item) => noteSummary(item, ctx.config.limits.excerpt_max_chars)), next_cursor: nextCursor } };
  }
  async addNote(repo, title, text3) {
    const ctx = this.context(repo, true);
    const { notebookId } = bindingNotebook(ctx.config);
    ensureTitle(title);
    ensureText(text3, "Note text", ctx.config.limits.note_max_bytes);
    const operationDigest = mutationInputDigest({ kind: "user-note", notebook_id: notebookId, title, text: text3 });
    const active = findActiveRemoteMutation(this.stateRoot, ctx.config.project_slug, "note.create", operationDigest);
    if (active && active.logical_marker !== userNoteLogicalId(active.operation_id)) {
      throw new NotebookError("CONFLICT", "Active user-note mutation journal has an invalid operation-bound logical identity");
    }
    const operationId = active?.operation_id ?? randomUUID6();
    const logicalId = userNoteLogicalId(operationId);
    const envelope = {
      schema_version: NOTEBOOK_SCHEMA_VERSION,
      project_slug: ctx.config.project_slug,
      kind: "user-note",
      logical_id: logicalId,
      policy_version: NOTEBOOK_POLICY_VERSION
    };
    const content = ensureFinalNoteContent(withNoteEnvelope(envelope, text3), ctx.config.limits.note_max_bytes);
    const result2 = await reconcileManagedNote({ stateRoot: this.stateRoot, projectSlug: ctx.config.project_slug, notebookId, logicalId, title, content, client: ctx.client, inputDigest: operationDigest, operationId });
    commitReconciledRemoteMutation(this.stateRoot, result2.journal);
    return { config: ctx.config, data: { note: noteDetail(result2.note, ctx.config.limits.note_max_bytes) } };
  }
  async getNote(repo, noteId) {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    return { config: ctx.config, data: { note: noteDetail(getScoped(notes, noteId), ctx.config.limits.note_max_bytes) } };
  }
  async updateNote(repo, noteId, input) {
    const { ctx, notes, notebookId } = await this.scoped(repo);
    const current = getScoped(notes, noteId);
    const parsed = parseNoteEnvelope(current.content);
    if (parsed?.envelope.project_slug !== void 0 && parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Managed note envelope belongs to a different project");
    if (parsed?.envelope.kind === "overview") throw new NotebookError("CONFLICT", "Use pj notebook overview --set-file to update the stable Overview note");
    if (parsed && parsed.envelope.kind !== "user-note") throw new NotebookError("CONFLICT", "Derived document and session-capture notes must be regenerated from their evidence boundary");
    ensureText(input.text, "Note text", ctx.config.limits.note_max_bytes);
    if (input.title !== void 0) ensureTitle(input.title);
    const content = ensureFinalNoteContent(parsed ? withNoteEnvelope(parsed.envelope, input.text) : input.text, ctx.config.limits.note_max_bytes);
    const updated = await ctx.client.updateOwnedNote(notebookId, noteId, { ...input.title ? { title: input.title } : {}, content });
    return { config: ctx.config, data: { note: noteDetail(updated, ctx.config.limits.note_max_bytes) } };
  }
  async deleteNote(repo, noteId, confirmed) {
    if (!confirmed) throw new NotebookError("INVALID_INPUT", "Note deletion requires confirmation or --yes");
    const { ctx, notes, notebookId } = await this.scoped(repo);
    const note2 = getScoped(notes, noteId);
    const parsed = parseNoteEnvelope(note2.content);
    if (parsed && parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Managed note envelope belongs to a different project");
    if (noteId === ctx.config.binding.overview_note_id || parsed?.envelope.kind === "overview") throw new NotebookError("CONFLICT", "The stable Project Overview note cannot be deleted");
    await ctx.client.deleteOwnedNote(notebookId, noteId);
    return { config: ctx.config, data: { deleted_id: noteId } };
  }
  async searchNotes(repo, query, limit = 20) {
    const { ctx, notes } = await this.scoped(repo);
    if (limit > ctx.config.limits.list_max_items) throw new NotebookError("INVALID_INPUT", "Search limit exceeds the configured ceiling");
    return { config: ctx.config, data: searchNotesLocally(notes, query, limit, ctx.config.limits.excerpt_max_chars) };
  }
  async overview(repo, setText, deadlineMonotonicMs) {
    const { ctx, notes, notebookId } = await this.scoped(repo, deadlineMonotonicMs);
    const overviewId = ctx.config.binding.overview_note_id;
    if (!overviewId) throw new NotebookError("NOT_CONFIGURED", "Overview note ID is not bound");
    const current = getScoped(notes, overviewId);
    const parsed = parseNoteEnvelope(current.content);
    if (!parsed || parsed.envelope.kind !== "overview") throw new NotebookError("DRIFT_DETECTED", "Bound Overview note has no valid Overview envelope");
    if (parsed.envelope.project_slug !== ctx.config.project_slug) throw new NotebookError("CROSS_PROJECT", "Bound Overview envelope belongs to a different project");
    if (parsed.envelope.logical_id !== `overview:v1:${ctx.config.project_slug}`) throw new NotebookError("DRIFT_DETECTED", "Bound Overview logical identity does not match this project");
    const descriptor = compileOverviewDescriptor({ config: ctx.config, projectName: ctx.resolved.project.name, purpose: ctx.resolved.project.description });
    const drift = overviewDescriptorDrift(parsed.envelope.overview_descriptor, descriptor);
    if (setText === void 0) return { config: ctx.config, data: { note: noteDetail(current, ctx.config.limits.note_max_bytes), updated: false, drift } };
    ensureText(setText, "Overview text", ctx.config.limits.note_max_bytes);
    const envelope = { ...parsed.envelope, overview_descriptor: descriptor, policy_version: NOTEBOOK_POLICY_VERSION };
    const content = ensureFinalNoteContent(withNoteEnvelope(envelope, setText), ctx.config.limits.note_max_bytes);
    const updated = await ctx.client.updateOwnedNote(notebookId, overviewId, { content });
    return { config: ctx.config, data: { note: noteDetail(updated, ctx.config.limits.note_max_bytes), updated: true, drift: [] } };
  }
  async audit(repo = process.cwd(), localOnly = false) {
    const local = this.context(repo, false);
    const observed = await prepareNotebookObservation(this, repo, localOnly);
    const checks = createNotebookChecks();
    const lifecycle = {
      targetDir: local.config.repo_path,
      repoRoot: local.config.repo_path,
      pjanglerRoot: resolvePjanglerRoot(),
      homeDir: this.environment.HOME || homedir7(),
      notebookStateRoot: this.stateRoot,
      notebookRegistryDeclared: Boolean(local.resolved.project.notebook && typeof local.resolved.project.notebook === "object"),
      notebookFocusedAudit: true,
      dryRun: true,
      force: false,
      notebookObservation: Object.freeze(observed),
      notebookPlan: Object.freeze({
        schema_version: 1,
        project_slug: local.config.project_slug,
        repo_path: local.config.repo_path,
        mode: "sync",
        config: local.config,
        remote_effect: "none",
        reason: "focused notebook audit"
      })
    };
    const rules = checks.map((check) => check.audit(lifecycle));
    const admission2 = publicCaptureAdmissionSummary(captureAdmissionSummary(this.stateRoot, local.config.project_slug, local.config.limits));
    return {
      config: local.config,
      health: observed.health,
      data: { rules, audited_at: (/* @__PURE__ */ new Date()).toISOString(), remote_check: observed.remote_check, capture_admission: admission2 }
    };
  }
  pruneCaptureState(repo = process.cwd()) {
    const ctx = this.context(repo, false);
    return pruneNotebookState(this.stateRoot, ctx.config.project_slug, ctx.config.limits);
  }
  recoverCaptureJournals(repo = process.cwd()) {
    const ctx = this.context(repo, false);
    const receipts = listCaptureReceipts(this.stateRoot, ctx.config.project_slug, ctx.config.limits, "succeeded");
    const recovered = [];
    for (const receipt of receipts) {
      const ownership = new Map(receipt.note_logical_ids.map((logicalId, index) => [logicalId, receipt.remote_note_ids[index]]));
      const bindingId2 = ctx.config.binding.state === "linked" ? ctx.config.binding.notebook_id : void 0;
      if (!bindingId2) continue;
      const journals = listRemoteMutationJournals(this.stateRoot, ctx.config.project_slug);
      for (const journal of journals) {
        if (journal.kind !== "note.create" || journal.session_key !== receipt.session_key || journal.state !== "reconciled" || journal.binding_id !== bindingId2 || journal.candidate_ids.length !== 1 || ownership.get(journal.logical_marker) !== journal.candidate_ids[0]) continue;
        commitReconciledRemoteMutation(this.stateRoot, journal);
        recovered.push(remoteMutationJournalPath(this.stateRoot, ctx.config.project_slug, journal.operation_id));
      }
    }
    return [...new Set(recovered)].sort();
  }
  captureList(repo = process.cwd(), state) {
    const ctx = this.context(repo, false);
    return { config: ctx.config, data: { items: listCaptureReceipts(this.stateRoot, ctx.config.project_slug, ctx.config.limits, state), next_cursor: null } };
  }
  async captureRetry(repo, receiptId, baseline) {
    const ctx = this.context(repo, false);
    const queued = authorizeCaptureRetry({
      root: this.stateRoot,
      projectSlug: ctx.config.project_slug,
      receiptId,
      limits: ctx.config.limits,
      baseline,
      validateBaseline: (gitRef) => validateCommittedGitRef(ctx.config.repo_path, gitRef)
    });
    const { runCaptureWorker: runCaptureWorker2 } = await Promise.resolve().then(() => (init_capture(), capture_exports));
    const completed = await runCaptureWorker2(this, ctx.config.project_slug, queued.receipt_id);
    return { config: ctx.config, data: { receipt: receiptSummary(completed.receipt) } };
  }
};

// src/recipes/NotebookRecipe.ts
init_state();
init_remote_mutation_journal();
function integrationEnvironment(module, ctx) {
  const env2 = { ...module.environment, HOME: ctx.homeDir };
  if (module.environment.HOME !== ctx.homeDir) {
    env2.XDG_DATA_HOME = join21(ctx.homeDir, ".local", "share");
    env2.XDG_STATE_HOME = join21(ctx.homeDir, ".local", "state");
    env2.PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS = join21(ctx.homeDir, ".claude", "settings.json");
  }
  return env2;
}
function resolvedForPlan(plan) {
  const manifestPath = join21(plan.project.repo_path, ".project.json");
  let manifest = plan.manifest;
  if (existsSync17(manifestPath)) {
    const parsed = JSON.parse(readFileSync15(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${manifestPath} must contain a JSON object`);
    manifest = parsed;
  }
  return {
    registry: loadProjectRegistry(plan.registryPath),
    project: plan.project,
    manifest,
    registry_path: plan.registryPath
  };
}
function planNotebookForProjectInit(plan, mode) {
  const resolved = resolvedForPlan(plan);
  const config = resolveEffectiveNotebookConfig(resolved);
  return Object.freeze({
    schema_version: 1,
    project_slug: config.project_slug,
    repo_path: config.repo_path,
    mode,
    config,
    remote_effect: config.policy.enabled && Boolean(config.base_url) ? "reconcile" : "none",
    reason: !config.policy.enabled ? "disabled by project policy" : config.base_url ? "configured stable identity requires reconciliation" : "no safe global endpoint configured"
  });
}
function projectNotebookDryRunProjection(plan, mode) {
  const notebookPlan = planNotebookForProjectInit(plan, mode);
  const enabled2 = notebookPlan.config.policy.enabled && notebookPlan.config.binding.state !== "disabled";
  const liveStatus = !enabled2 ? "skip" : !notebookPlan.config.base_url ? "blocked-not-configured" : plan.live ? "proposed" : "requires-live";
  return {
    plan: notebookPlan,
    phases: [
      { id: "configuration", scope: "local", status: enabled2 ? "proposed" : "skip", summary: `Effective Project Notebook policy; SessionStart=${notebookPlan.config.policy.session_start_enabled} SessionEnd capture=${notebookPlan.config.policy.session_capture_enabled}` },
      { id: "binding-projection", scope: "local", status: enabled2 ? "proposed" : "skip", summary: `Registry/Manifest binding ${notebookPlan.config.binding.state} for ${notebookPlan.config.binding.notebook_name ?? notebookPlan.config.project_slug}` },
      { id: "skill", scope: "local", status: enabled2 ? "proposed" : "skip", summary: "Verify the digest-pinned global Project Notebook skill" },
      { id: "managed-hooks", scope: "local", status: enabled2 ? "proposed" : "skip", summary: "Project true SessionStart and SessionEnd Managed Hooks without enabling repository capture policy" },
      { id: "overview-note", scope: "live", status: liveStatus, summary: "Reconcile the stable Overview Note ID and exact OverviewDescriptor" },
      { id: "live-action", scope: "live", status: liveStatus, summary: "Create, adopt, or rename the marker-owned Companion Notebook; remote mutation requires --live" }
    ]
  };
}
function setBinding(plan, binding) {
  const currentProject = plan.project.notebook;
  plan.project.notebook = { ...currentProject ?? { state: "planned" }, ...binding };
  const currentManifest = plan.manifest.notebook;
  plan.manifest.notebook = {
    ...currentManifest ?? {},
    binding: { ...currentManifest?.binding ?? {}, ...binding }
  };
  for (const action of plan.actions) {
    if (action.kind === "project.write-manifest") action.manifest = plan.manifest;
    if (action.kind === "registry.upsert") action.project = plan.project;
  }
}
var NotebookRecipe = class extends Recipe {
  constructor(module = new NotebookModule()) {
    super();
    this.module = module;
  }
  checks = createNotebookChecks();
  metadata = {
    id: "notebook",
    name: "notebook",
    description: "Project Notebook lifecycle, binding, hooks, and capture state",
    dependencies: [],
    commands: [],
    publicRuleIds: NOTEBOOK_RULE_IDS
  };
  async init(ctx, input) {
    const resolved = resolvedForPlan(input.plan);
    const notebookPlan = planNotebookForProjectInit(input.plan, input.mode);
    ctx.notebookPlan = notebookPlan;
    ctx.notebookRegistryDeclared = Boolean(resolved.project.notebook && typeof resolved.project.notebook === "object");
    const manifestNotebook2 = resolved.manifest.notebook;
    ctx.notebookManifestBinding = manifestNotebook2?.binding ? Object.freeze({ ...manifestNotebook2.binding }) : null;
    ctx.notebookStateRoot = this.module.stateRoot;
    return {
      recipeId: this.metadata.id,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [`notebook: ${notebookPlan.reason}`],
      errors: [],
      phases: [{ id: "notebook.plan", status: notebookPlan.remote_effect === "reconcile" ? "planned" : "skipped", changedFiles: [], message: notebookPlan.reason }],
      notebookPlan
    };
  }
  async applyLocal(ctx, plan, notebookPlan) {
    if (!plan.apply || ctx.dryRun || !notebookPlan.config.policy.enabled || notebookPlan.config.binding.state === "disabled") {
      return { recipeId: this.metadata.id, ok: true, dryRun: Boolean(ctx.dryRun), changedFiles: [], logs: ["notebook: local skill/hooks skipped"], errors: [], phases: [{ id: "notebook.local", status: "skipped", changedFiles: [], message: "Notebook is disabled or this is a plan-only invocation" }] };
    }
    if (notebookPlan.remote_effect === "none") {
      const message = `Notebook has no configured endpoint (${notebookPlan.reason}); global skill and hook projection deferred to \`pj notebook migrate --apply\``;
      return { recipeId: this.metadata.id, ok: true, dryRun: false, changedFiles: [], logs: [`notebook: ${message}`], errors: [], phases: [{ id: "notebook.local", status: "skipped", changedFiles: [], message }] };
    }
    try {
      const env2 = integrationEnvironment(this.module, ctx);
      ctx.notebookStateRoot = notebookStateRoot(env2);
      const applied = this.module.installIntegration(env2);
      ctx.notebookObservation = Object.freeze(await prepareNotebookObservationResolved(this.module, resolvedForPlan(plan), notebookPlan.config, true, env2));
      if (applied.blocked) {
        const advisory = `notebook: global skill projection left untouched \u2014 ${applied.blocked.summary}`;
        return {
          recipeId: this.metadata.id,
          ok: true,
          dryRun: false,
          changedFiles: applied.changedFiles,
          logs: [advisory, ...applied.blocked.details.map((detail) => `notebook:   ${detail}`), `notebook: repair with ${applied.blocked.repair}`],
          errors: [],
          phases: [{ id: "notebook.local", status: "skipped", changedFiles: applied.changedFiles, message: advisory }]
        };
      }
      return {
        recipeId: this.metadata.id,
        ok: true,
        dryRun: false,
        changedFiles: applied.changedFiles,
        logs: ["notebook: canonical skill and true SessionStart/SessionEnd hooks projected"],
        errors: [],
        phases: [{ id: "notebook.local", status: applied.changedFiles.length ? "changed" : "unchanged", changedFiles: applied.changedFiles, message: "Canonical Project Notebook skill and hooks verified" }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { recipeId: this.metadata.id, ok: false, dryRun: false, changedFiles: [], logs: [], errors: [message], phases: [{ id: "notebook.local", status: "failed", changedFiles: [], message }] };
    }
  }
  async applyExternal(plan, notebookPlan) {
    if (notebookPlan.remote_effect !== "reconcile") return { changedFiles: [], data: { created: false, adopted: false, notebook_id: notebookPlan.config.binding.notebook_id ?? "", overview_note_id: notebookPlan.config.binding.overview_note_id ?? "", journals: [] } };
    const provisioned = await this.module.provisionResolved(resolvedForPlan(plan), notebookPlan.config);
    setBinding(plan, provisioned.binding);
    return { changedFiles: [], data: { ...provisioned.data, journals: provisioned.journals ?? [] } };
  }
  commitExternal(journals) {
    for (const journal of journals) commitReconciledRemoteMutation(this.module.stateRoot, journal);
  }
  refreshPlan(plan, notebookPlan) {
    const resolved = resolvedForPlan(plan);
    return Object.freeze({ ...notebookPlan, config: resolveEffectiveNotebookConfig(resolved) });
  }
  async observeExternal(plan, notebookPlan) {
    const resolved = resolvedForPlan(plan);
    return prepareNotebookObservationResolved(this.module, resolved, resolveEffectiveNotebookConfig(resolved), false);
  }
  printNextSteps() {
  }
};

// src/recipes/ProjectRecipe.ts
var BOOTSTRAP_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Pjangler Lifecycle",
  GIT_AUTHOR_EMAIL: "pjangler@localhost.invalid",
  GIT_COMMITTER_NAME: "Pjangler Lifecycle",
  GIT_COMMITTER_EMAIL: "pjangler@localhost.invalid"
};
var PRODUCTION_RUNTIME = {
  executePlan: executeProjectInitPlan,
  preflightBmad: preflightBmadLifecycle,
  runGit(cwd, args, options) {
    const result2 = spawnSync13("git", [...args], {
      cwd,
      encoding: "utf8",
      env: options?.env ? { ...process.env, ...options.env } : process.env
    });
    return {
      status: result2.status,
      stdout: result2.stdout ?? "",
      stderr: result2.stderr ?? "",
      error: result2.error
    };
  }
};
function publicAudit(report) {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding2 }) => finding2)
  };
}
function publicMigration(report) {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result2 }) => result2)
  };
}
function hasGitRepository(runtime, targetDir) {
  if (!existsSync18(join22(targetDir, ".git"))) return false;
  return runtime.runGit(targetDir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
}
function refreshPlanFromCanonicalManifest(plan) {
  const manifestPath = join22(plan.project.repo_path, ".project.json");
  const manifest = JSON.parse(readFileSync16(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  const agents = createSafeRecord();
  for (const [agentId, entry] of Object.entries(manifest.agents ?? {})) {
    const rawRole = typeof entry?.role === "string" ? entry.role : "";
    if (!rawRole.trim()) throw new Error(`${manifestPath} agents.${agentId}.role is missing`);
    const role = normalizeAgentRole(rawRole);
    if (Object.hasOwn(agents, role)) throw new Error(`${manifestPath} declares more than one ${role} agent`);
    agents[role] = {
      role,
      role_dir: entry.role_dir,
      provisioning_state: entry.provisioning_state ?? "provisioned"
    };
  }
  const manifestTicket = manifest.ticket_provider;
  if (!manifestTicket || typeof manifestTicket !== "object") {
    throw new Error(`${manifestPath} ticket_provider is missing`);
  }
  const ticketProvider = {
    type: String(manifestTicket.type ?? ""),
    workspace: String(manifestTicket.workspace ?? ""),
    identifier: String(manifestTicket.identifier ?? ""),
    board_id: String(manifestTicket.board_id ?? ""),
    state: manifestTicket.state
  };
  plan.manifest = manifest;
  plan.project.agents = agents;
  plan.project.ticket_provider = ticketProvider;
  for (const action of plan.actions) {
    if (action.kind === "project.write-manifest") action.manifest = manifest;
    if (action.kind === "registry.upsert") action.project = plan.project;
  }
}
var ProjectRecipe = class extends Recipe {
  constructor(runtime = PRODUCTION_RUNTIME) {
    super();
    this.runtime = runtime;
  }
  orchestratesDependencies = true;
  checks = createProjectChecks();
  metadata = {
    id: "project",
    name: "project",
    description: "CommonProject plan, lifecycle composition, audit, and Git boundary",
    dependencies: ["mise", "agent-hooks", "bmad", "notebook"],
    commands: [],
    publicRuleIds: this.checks.map((check) => check.id)
  };
  registry;
  attachRegistry(registry) {
    this.registry = registry;
  }
  async runNotebookLifecycle(plan, mode, ctx) {
    if (!this.registry) throw new Error("ProjectRecipe is not attached to a RecipeRegistry");
    const result2 = await this.registry.initRecipe("notebook", ctx, { plan, mode });
    if (!result2.ok || !result2.notebookPlan) throw new Error(result2.errors.join("; ") || "Notebook lifecycle planning failed");
    return result2.notebookPlan;
  }
  async init(ctx, input) {
    if (!this.registry) throw new Error("ProjectRecipe is not attached to a RecipeRegistry");
    const normalized = "plan" in input ? input : {
      plan: input,
      mode: input.actions.some((action) => action.kind === "copier.copy.commonproject") ? "create" : "sync"
    };
    const { plan, mode } = normalized;
    const targetDir = plan.project.repo_path;
    const phases = [];
    const logs = [];
    const errors = [];
    const changedFiles = [];
    const targetExistedAtStart = existsSync18(targetDir);
    const transactionContext = {
      ...ctx,
      targetDir,
      repoRoot: targetDir,
      bmadVersionPin: mode === "create" ? BMAD_INSTALLER_VERSION : ctx.bmadVersionPin
    };
    let agentResult;
    let provisionedAgentContext;
    let migrationReport;
    let audit;
    let notebookPlan;
    let notebookRecipeForCommit;
    let notebookJournals = [];
    let externalDispatchStarted = false;
    let rollbackEligible = true;
    let registryFinalizerEligible = false;
    try {
      if (mode === "create") {
        const preflight = this.runtime.preflightBmad(transactionContext);
        phases.push({
          id: "project.preflight:bmad",
          status: preflight.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: preflight.ok ? "Pinned BMAD installer and sealed pack are available" : preflight.error
        });
        if (!preflight.ok) errors.push(`BMAD preflight failed: ${preflight.error ?? "unknown error"}`);
      }
      const registryActions = plan.actions.filter((action) => action.kind === "registry.upsert");
      const externalPlanActions = plan.actions.filter((action) => action.kind === "ticket-provider.create-or-link");
      const filesystemPlan = {
        ...plan,
        actions: plan.actions.filter((action) => action.kind !== "registry.upsert" && action.kind !== "hermes.provision-agent" && action.kind !== "ticket-provider.create-or-link")
      };
      const planBlocked = errors.length > 0;
      const executed = !planBlocked && filesystemPlan.actions.length ? await this.runtime.executePlan(filesystemPlan, {
        trustedCopier: normalized.trustedCopier,
        requireTrustedCopier: normalized.requireTrustedCopier
      }) : { ok: !planBlocked, plan: filesystemPlan, logs: [], errors: [], changedFiles: [] };
      logs.push(...executed.logs);
      errors.push(...executed.errors);
      changedFiles.push(...executed.changedFiles);
      phases.push({
        id: "project.plan",
        status: planBlocked ? "skipped" : executed.ok ? executed.changedFiles.length ? "changed" : "unchanged" : "failed",
        changedFiles: executed.ok ? executed.changedFiles : [],
        message: planBlocked ? "Project plan skipped after failed preflight" : executed.ok ? "Project plan executed" : executed.errors.join("; ")
      });
      if (errors.length === 0 && executed.ok && mode === "create") {
        const dependencyResult = await this.registry.initDependencies(this.metadata.id, transactionContext, normalized, ["notebook"]);
        logs.push(...dependencyResult.logs);
        errors.push(...dependencyResult.errors);
        changedFiles.push(...dependencyResult.changedFiles);
        phases.push(...dependencyResult.phases);
      }
      if (errors.length === 0 && executed.ok) {
        try {
          notebookPlan = await this.runNotebookLifecycle(plan, mode, transactionContext);
          phases.push({
            id: "notebook.plan",
            status: notebookPlan.remote_effect === "reconcile" ? "planned" : "skipped",
            changedFiles: [],
            message: notebookPlan.reason
          });
        } catch (error) {
          errors.push(`notebook lifecycle planning failed: ${error instanceof Error ? error.message : String(error)}`);
          phases.push({ id: "notebook.plan", status: "failed", changedFiles: [], message: errors.at(-1) });
        }
      }
      if (errors.length === 0 && notebookPlan) {
        const notebookRecipe = this.registry.get("notebook");
        if (!(notebookRecipe instanceof NotebookRecipe)) throw new Error("Registered notebook recipe is not the singleton NotebookRecipe");
        const localNotebook = await notebookRecipe.applyLocal(transactionContext, plan, notebookPlan);
        logs.push(...localNotebook.logs);
        errors.push(...localNotebook.errors);
        changedFiles.push(...localNotebook.changedFiles);
        phases.push(...localNotebook.phases);
      }
      const agentAction = plan.actions.find((action) => action.kind === "hermes.provision-agent" && action.enabled);
      if (errors.length === 0 && agentAction?.kind === "hermes.provision-agent") {
        const agentContext = {
          targetRepo: agentAction.targetRepo,
          role: agentAction.role,
          agentPurpose: `${agentAction.role} agent for ${agentAction.targetRepo}`,
          ticketProvider: plan.project.ticket_provider.type,
          local: agentAction.local,
          force: Boolean(ctx.force),
          skipTelegram: true,
          skipEmail: true,
          skipRuntimeRepo: agentAction.context.skipRuntimeRepo,
          skipPlane: agentAction.context.skipPlane,
          skipBloodbank: agentAction.context.skipBloodbank,
          skipSystemd: agentAction.context.skipSystemd,
          ...normalized.agentContext ?? {},
          targetDir,
          yes: true,
          // Structured callers own stdout and prompt input. Do not allow a
          // nested context object to weaken the transaction's quiet contract.
          quiet: normalized.quiet ?? ctx.quiet ?? false,
          dryRun: false
        };
        provisionedAgentContext = { ...transactionContext, ...agentContext, targetDir, repoRoot: targetDir };
        agentResult = await this.registry.initRecipe(
          "hermes-agent",
          provisionedAgentContext,
          agentContext
        );
        logs.push(...agentResult.logs);
        errors.push(...agentResult.errors);
        changedFiles.push(...agentResult.changedFiles);
        phases.push(...agentResult.phases);
      }
      if (errors.length === 0 && (mode === "create" || agentResult)) {
        const projectLifecycle = await this.initializeOwnedChecks(transactionContext);
        logs.push(...projectLifecycle.logs);
        errors.push(...projectLifecycle.errors);
        changedFiles.push(...projectLifecycle.changedFiles);
        phases.push(...projectLifecycle.phases);
        if (projectLifecycle.ok) {
          try {
            refreshPlanFromCanonicalManifest(plan);
          } catch (error) {
            errors.push(`project manifest refresh failed: ${error instanceof Error ? error.message : String(error)}`);
            phases.push({
              id: "project.manifest-refresh",
              status: "failed",
              changedFiles: [],
              message: errors.at(-1)
            });
          }
        }
      }
      if (errors.length === 0 && normalized.selectedRuleIds?.length) {
        migrationReport = publicMigration(await this.registry.migrateRules(
          { ...transactionContext, dryRun: false },
          normalized.selectedRuleIds
        ));
        changedFiles.push(...migrationReport.changedFiles);
        phases.push(...migrationReport.results.map((result2) => ({
          id: result2.id,
          status: result2.status === "applied" ? "changed" : result2.status === "noop" ? "unchanged" : result2.status === "skipped" ? "skipped" : "failed",
          // A `partial` failed, but its writes really happened, so they stay
          // accounted for rather than vanishing from the transaction record.
          changedFiles: result2.status === "applied" || result2.status === "partial" ? result2.changedFiles : [],
          message: result2.summary
        })));
        errors.push(...migrationReport.results.filter((result2) => result2.status === "blocked" || result2.status === "partial").map((result2) => `${result2.id}: ${result2.summary}`));
      }
      const eligibilityAudit = errors.length === 0 ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true })) : void 0;
      audit = eligibilityAudit;
      if (eligibilityAudit && !eligibilityAudit.ok) {
        errors.push(...eligibilityAudit.rules.filter((finding2) => finding2.status === "fail" || finding2.status === "warn").map((finding2) => `${finding2.id}: ${finding2.summary}`));
      }
      phases.push({
        id: "project.audit:eligibility",
        status: eligibilityAudit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: eligibilityAudit?.ok ? "Lifecycle eligibility audit passed before external effects" : "Lifecycle eligibility audit failed or was skipped; external effects remain disabled"
      });
      if (errors.length === 0 && mode === "create") {
        if (hasGitRepository(this.runtime, targetDir)) {
          phases.push({ id: "project.git", status: "unchanged", changedFiles: [], message: "Git repository already initialized" });
        } else {
          const gitPath = join22(targetDir, ".git");
          for (const { args, label, options } of [
            { args: ["init", "--initial-branch=main"], label: "git init" },
            { args: ["add", "-A"], label: "git add" },
            {
              args: ["commit", "--no-gpg-sign", "-m", "chore: initialize project"],
              label: "git commit",
              options: { env: BOOTSTRAP_GIT_IDENTITY }
            }
          ]) {
            const result2 = this.runtime.runGit(targetDir, args, options);
            if (result2.status !== 0) {
              errors.push(`${label} failed: ${(result2.stderr || result2.stdout || result2.error?.message || "unknown error").trim()}`);
              phases.push({ id: `project.git:${label}`, status: "failed", changedFiles: changedFiles.includes(gitPath) ? [gitPath] : [], message: errors.at(-1) });
              break;
            }
            if (label === "git init" && existsSync18(gitPath)) changedFiles.push(gitPath);
            logs.push(`${label}: ok`);
          }
          if (errors.length === 0) {
            const repositoryReady = hasGitRepository(this.runtime, targetDir);
            const headReady = repositoryReady && this.runtime.runGit(targetDir, ["rev-parse", "--verify", "HEAD"]).status === 0;
            if (!headReady) {
              errors.push("git postcondition failed: repository or initial commit is missing");
              phases.push({ id: "project.git:postcondition", status: "failed", changedFiles: existsSync18(gitPath) ? [gitPath] : [], message: errors.at(-1) });
            } else {
              if (!changedFiles.includes(gitPath)) changedFiles.push(gitPath);
              phases.push({ id: "project.git", status: "changed", changedFiles: [gitPath], message: "Git repository initialized and committed" });
            }
          }
        }
      }
      registryFinalizerEligible = errors.length === 0;
      if (errors.length === 0 && externalPlanActions.length) {
        const dispatching = externalPlanActions.some((action) => action.kind === "ticket-provider.create-or-link" && action.enabled);
        if (dispatching) {
          externalDispatchStarted = true;
          rollbackEligible = false;
        }
        const externalPlan = {
          ...plan,
          actions: externalPlanActions
        };
        const external = await this.runtime.executePlan(externalPlan);
        logs.push(...external.logs);
        errors.push(...external.errors);
        changedFiles.push(...external.changedFiles);
        phases.push({
          id: "project.external:ticket-provider",
          status: external.ok ? external.changedFiles.length ? "changed" : "unchanged" : "failed",
          changedFiles: external.ok ? external.changedFiles : [],
          message: external.ok ? "Deferred ticket-provider phase completed" : external.errors.join("; ")
        });
      }
      if (errors.length === 0 && notebookPlan?.remote_effect === "reconcile") {
        if (!ctx.live) {
          phases.push({ id: "project.external:notebook", status: "skipped", changedFiles: [], message: "Notebook remote reconciliation requires --live" });
        } else {
          externalDispatchStarted = true;
          rollbackEligible = false;
          const notebookRecipe = this.registry.get("notebook");
          if (!(notebookRecipe instanceof NotebookRecipe)) throw new Error("Registered notebook recipe is not the singleton NotebookRecipe");
          try {
            const applied = await notebookRecipe.applyExternal(plan, notebookPlan);
            notebookRecipeForCommit = notebookRecipe;
            notebookJournals = applied.data.journals ?? [];
            logs.push(`notebook: reconciled ${applied.data.notebook_id} with Overview ${applied.data.overview_note_id}`);
            const manifestActions = plan.actions.filter((action) => action.kind === "project.write-manifest");
            const projected = manifestActions.length ? await this.runtime.executePlan({ ...plan, actions: manifestActions }) : { ok: true, logs: [], errors: [], changedFiles: [] };
            logs.push(...projected.logs);
            errors.push(...projected.errors);
            changedFiles.push(...projected.changedFiles);
            if (projected.ok) {
              notebookPlan = notebookRecipe.refreshPlan(plan, notebookPlan);
              transactionContext.notebookPlan = notebookPlan;
              const projectedNotebook = plan.manifest.notebook;
              transactionContext.notebookManifestBinding = projectedNotebook?.binding ? Object.freeze({ ...projectedNotebook.binding }) : null;
              transactionContext.notebookObservation = Object.freeze(await notebookRecipe.observeExternal(plan, notebookPlan));
              const candidateAudit = publicAudit(this.registry.auditRecipes(transactionContext, ["notebook"]));
              if (!candidateAudit.ok) errors.push(...candidateAudit.rules.filter((item) => item.status === "fail" || item.status === "warn").map((item) => `${item.id}: ${item.summary}`));
            }
            phases.push({
              id: "project.external:notebook",
              status: errors.length === 0 ? projected.changedFiles.length ? "changed" : "unchanged" : "failed",
              changedFiles: errors.length === 0 ? projected.changedFiles : [],
              message: errors.length === 0 ? "Notebook and stable Overview reconciled and observation-audited" : errors.at(-1)
            });
          } catch (error) {
            errors.push(`notebook external effect failed: ${error instanceof Error ? error.message : String(error)}`);
            phases.push({ id: "project.external:notebook", status: "failed", changedFiles: [], message: errors.at(-1) });
          }
        }
      }
      const deferred = provisionedAgentContext?.deferredExternalEffects;
      if (errors.length === 0 && deferred?.owner === "project" && (deferred.runtimeRepo || deferred.ticketBoard || deferred.systemd)) {
        externalDispatchStarted = true;
        rollbackEligible = false;
        const beforeExternal = snapshotTree(targetDir);
        const external = await new ApplyDeferredExternalEffects(provisionedAgentContext).invoke();
        const externalChanges = changedTreePaths(targetDir, beforeExternal, snapshotTree(targetDir));
        logs.push(...external.message ? [external.message] : []);
        if (!external.success) errors.push(external.message || "Deferred Hermes external effects failed");
        changedFiles.push(...externalChanges);
        phases.push({
          id: "project.external:hermes",
          status: external.success ? "changed" : "failed",
          changedFiles: external.success ? externalChanges : [],
          message: external.message || void 0
        });
      }
      if (registryFinalizerEligible && (externalPlanActions.length || notebookPlan || deferred)) {
        try {
          refreshPlanFromCanonicalManifest(plan);
        } catch (error) {
          errors.push(`project manifest refresh after external effects failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (registryFinalizerEligible && registryActions.length) {
        rollbackEligible = false;
        const registryPlan = { ...plan, actions: registryActions };
        const persisted = await this.runtime.executePlan(registryPlan);
        logs.push(...persisted.logs);
        errors.push(...persisted.errors);
        changedFiles.push(...persisted.changedFiles);
        phases.push({
          id: "project.registry:finalizer",
          status: persisted.ok ? persisted.changedFiles.length ? "changed" : "unchanged" : "failed",
          changedFiles: persisted.ok ? persisted.changedFiles : [],
          message: persisted.ok ? "Project Registry persisted as the final mutation" : persisted.errors.join("; ")
        });
        if (errors.length === 0 && persisted.ok && notebookRecipeForCommit && notebookJournals.length) {
          try {
            notebookRecipeForCommit.commitExternal(notebookJournals);
          } catch (error) {
            errors.push(`notebook ownership journal finalization failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      audit = errors.length === 0 ? publicAudit(this.registry.auditRecipes({ ...transactionContext, dryRun: true })) : audit;
      if (errors.length === 0 && audit && !audit.ok) {
        errors.push(...audit.rules.filter((finding2) => finding2.status === "fail" || finding2.status === "warn").map((finding2) => `${finding2.id}: ${finding2.summary}`));
      }
      phases.push({
        id: "project.audit",
        status: errors.length === 0 && audit?.ok ? "unchanged" : "failed",
        changedFiles: [],
        message: errors.length === 0 && audit?.ok ? "Lifecycle postcondition audit passed" : "Lifecycle postcondition audit failed or was skipped"
      });
    } catch (error) {
      errors.push(`project transaction failed: ${error instanceof Error ? error.message : String(error)}`);
      phases.push({
        id: "project.transaction",
        status: "failed",
        changedFiles: [],
        message: errors.at(-1)
      });
    }
    if (errors.length > 0 && mode === "create" && !targetExistedAtStart && rollbackEligible && !externalDispatchStarted && existsSync18(targetDir)) {
      try {
        rmSync4(targetDir, { recursive: true, force: true });
        changedFiles.length = 0;
        logs.push(`Rolled back newly-created target: ${targetDir}`);
        phases.push({
          id: "project.rollback",
          status: "changed",
          changedFiles: [],
          message: "Removed the newly-created target after transaction failure"
        });
      } catch (error) {
        errors.push(`fresh-target rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        phases.push({
          id: "project.rollback",
          status: "failed",
          changedFiles: [],
          message: errors.at(-1)
        });
      }
    }
    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0 && Boolean(audit?.ok),
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
      plan,
      mode,
      audit,
      selectedOperations: normalized.selectedOperations ?? [],
      selectedParityRules: normalized.selectedRuleIds ?? [],
      migrationReport,
      agentResult
    };
  }
  printNextSteps() {
  }
};

// src/recipes/registry.ts
var RecipeRegistry = class {
  recipes = /* @__PURE__ */ new Map();
  ruleOwners = /* @__PURE__ */ new Map();
  validated = false;
  constructor(recipes = []) {
    for (const recipe of recipes) this.register(recipe);
    if (recipes.length) this.validate();
  }
  register(recipe) {
    if (this.recipes.has(recipe.metadata.id)) throw new Error(`Duplicate recipe id: ${recipe.metadata.id}`);
    const seenLocal = /* @__PURE__ */ new Set();
    for (let index = 0; index < recipe.checks.length; index++) {
      const check = recipe.checks[index];
      if (seenLocal.has(check.id) || this.ruleOwners.has(check.id)) throw new Error(`Duplicate parity rule id: ${check.id}`);
      seenLocal.add(check.id);
      this.ruleOwners.set(check.id, { recipe, checkIndex: index });
    }
    const declared = [...recipe.metadata.publicRuleIds];
    const actual = recipe.checks.map((check) => check.id);
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      throw new Error(`Recipe ${recipe.metadata.id} publicRuleIds do not match its checks`);
    }
    this.recipes.set(recipe.metadata.id, recipe);
    const registryAware = recipe;
    registryAware.attachRegistry?.(this);
    this.validated = false;
    return this;
  }
  validate() {
    for (const recipe of this.recipes.values()) {
      for (const dependency of recipe.metadata.dependencies) {
        if (!this.recipes.has(dependency)) throw new Error(`Unknown dependency ${dependency} for recipe ${recipe.metadata.id}`);
      }
    }
    const visiting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const visit = (id, path) => {
      if (visiting.has(id)) throw new Error(`Recipe dependency cycle: ${[...path, id].join(" -> ")}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const recipe = this.recipes.get(id);
      for (const dependency of recipe.metadata.dependencies) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.recipes.keys()) visit(id, []);
    this.validated = true;
  }
  ensureValid() {
    if (!this.validated) this.validate();
  }
  list() {
    this.ensureValid();
    return [...this.recipes.values()].map((recipe) => recipe.metadata);
  }
  get(recipeId) {
    return this.recipes.get(recipeId);
  }
  ownerOf(ruleId) {
    const owner = this.ruleOwners.get(ruleId);
    if (!owner) return void 0;
    return { recipe: owner.recipe, check: owner.recipe.checks[owner.checkIndex] };
  }
  resolveOrder(recipeId) {
    this.ensureValid();
    if (!this.recipes.has(recipeId)) throw new Error(`Unknown recipe: ${recipeId}`);
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      const recipe = this.recipes.get(id);
      for (const dependency of recipe.metadata.dependencies) visit(dependency);
      seen.add(id);
      ordered.push(recipe);
    };
    visit(recipeId);
    return ordered;
  }
  resolveDependencies(recipeId) {
    return this.resolveOrder(recipeId).filter((recipe) => recipe.metadata.id !== recipeId);
  }
  aggregateInit(recipeId, ctx, results) {
    const selected = results.at(-1) ?? {
      recipeId,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [],
      errors: [],
      phases: []
    };
    return {
      ...selected,
      recipeId,
      ok: results.every((result2) => result2.ok),
      changedFiles: [...new Set(results.flatMap((result2) => result2.changedFiles))].sort(),
      logs: results.flatMap((result2) => result2.logs),
      errors: results.flatMap((result2) => result2.errors),
      phases: results.flatMap((result2) => result2.phases),
      dependencyResults: results.slice(0, -1)
    };
  }
  async initDependencies(recipeId, ctx, input, excludeRecipeIds = []) {
    const results = [];
    for (const dependency of this.resolveDependencies(recipeId)) {
      if (excludeRecipeIds.includes(dependency.metadata.id)) continue;
      const result2 = await dependency.init(ctx, input);
      results.push(result2);
      if (!result2.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }
  async initRecipe(recipeId, ctx, input) {
    this.ensureValid();
    const selected = this.recipes.get(recipeId);
    if (!selected) throw new Error(`Unknown recipe: ${recipeId}`);
    if (selected.orchestratesDependencies) return selected.init(ctx, input);
    const results = [];
    for (const recipe of this.resolveOrder(recipeId)) {
      const result2 = await recipe.init(ctx, input);
      results.push(result2);
      if (!result2.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }
  auditRecipes(ctx, recipeIds) {
    this.ensureValid();
    const selected = recipeIds ? recipeIds.map((id) => {
      const recipe = this.recipes.get(id);
      if (!recipe) throw new Error(`Unknown recipe: ${id}`);
      return recipe;
    }) : [...this.recipes.values()];
    const rules = selected.flatMap((recipe) => recipe.audit(ctx).map((finding2) => ({ ...finding2, recipeId: finding2.recipeId ?? recipe.metadata.id })));
    return {
      repo: ctx.repoRoot,
      ok: rules.every((rule) => rule.status === "pass" || rule.status === "skip"),
      auditedAt: (/* @__PURE__ */ new Date()).toISOString(),
      rules
    };
  }
  /**
   * PJAN-75: re-audit a rule that has just been migrated and demote a claimed
   * success that did not actually reach parity.
   *
   * Without this, `migrate` reports whatever each rule chooses to report about
   * itself, and a rule that applies SOME of its changes still shows a green
   * `[applied]`. That is how `migrate` came to print "Migration complete"
   * immediately followed by a failing `audit` on the very same rules -- the
   * two commands were answering different questions and only `audit` was
   * answering the one the operator asked.
   *
   * Only `applied` and `noop` are re-checked. `blocked` and `skipped` already
   * say the work did not happen, and a dry run has nothing to verify because
   * nothing was written.
   */
  verifyMigration(ctx, result2) {
    if (ctx.dryRun) return result2;
    if (result2.status !== "applied" && result2.status !== "noop") return result2;
    const owner = this.ruleOwners.get(result2.id);
    if (!owner) return result2;
    let postcondition;
    try {
      postcondition = owner.recipe.checks[owner.checkIndex].audit(ctx);
    } catch (err) {
      return {
        ...result2,
        status: "partial",
        summary: `${result2.summary} (postcondition audit threw)`,
        details: [...result2.details, `postcondition audit threw: ${err instanceof Error ? err.message : String(err)}`]
      };
    }
    if (postcondition.status === "pass" || postcondition.status === "skip") return result2;
    return {
      ...result2,
      status: "partial",
      // The audit's own summary is the authoritative account of what is still
      // wrong, so it replaces the migrate summary rather than appending to it.
      summary: postcondition.summary,
      details: [
        ...result2.details,
        `still failing after migrate: ${postcondition.summary}`,
        ...postcondition.details
      ]
    };
  }
  migrateRules(ctx, ruleIds) {
    this.ensureValid();
    const unknown = ruleIds.filter((id) => !this.ruleOwners.has(id));
    if (unknown.length) throw new Error(`Unknown parity rules: ${unknown.join(", ")}`);
    const results = [];
    for (const id of ruleIds) {
      const owner = this.ruleOwners.get(id);
      try {
        const migrated = owner.recipe.migrate(ctx, [id]);
        results.push(...migrated.map((result2) => this.verifyMigration(ctx, {
          ...result2,
          recipeId: result2.recipeId ?? owner.recipe.metadata.id
        })));
      } catch (err) {
        const check = owner.recipe.checks[owner.checkIndex];
        results.push({
          id,
          recipeId: owner.recipe.metadata.id,
          title: check.title,
          status: "blocked",
          summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
          changedFiles: [],
          details: []
        });
      }
    }
    return {
      repo: ctx.repoRoot,
      dryRun: Boolean(ctx.dryRun),
      // `partial` counts against ok for the same reason `blocked` does: the
      // repo is not in parity, so the command must not exit 0.
      ok: results.every((result2) => result2.status !== "blocked" && result2.status !== "partial"),
      selectedRules: [...ruleIds],
      results,
      changedFiles: [...new Set(results.flatMap((result2) => result2.changedFiles))].sort()
    };
  }
  /**
   * PJAN-75: `migrate --all` accounts for every failing rule, including the
   * ones it is not allowed to touch.
   *
   * Non-fixable failures were silently excluded from the report entirely, so a
   * repo whose only problem was an operator-owned rule -- an unprovisioned
   * Hermes role, a fleet-wide config value -- got "Migration complete", an
   * empty result list and exit 0, immediately followed by a failing `audit`.
   * They are re-checked AFTER the migrations run, because a rule this pass was
   * not allowed to fix may still have been fixed as a side effect of one it
   * was.
   */
  migrateAll(ctx) {
    const audit = this.auditRecipes(ctx);
    const failing = audit.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const report = this.migrateRules(ctx, failing.filter((rule) => rule.fixable).map((rule) => rule.id));
    const manual = [];
    for (const rule of failing.filter((candidate) => !candidate.fixable)) {
      const owner = this.ruleOwners.get(rule.id);
      let current = rule;
      if (owner) {
        try {
          current = { ...owner.recipe.checks[owner.checkIndex].audit(ctx), recipeId: rule.recipeId };
        } catch {
        }
      }
      if (current.status === "pass" || current.status === "skip") continue;
      manual.push({
        id: current.id,
        recipeId: current.recipeId,
        title: current.title,
        status: "blocked",
        summary: current.summary,
        changedFiles: [],
        details: [...current.details, "not auto-fixable: this rule needs an operator decision or action"]
      });
    }
    if (!manual.length) return report;
    return { ...report, ok: false, results: [...report.results, ...manual] };
  }
  listRuleIds() {
    this.ensureValid();
    return [...this.recipes.values()].flatMap((recipe) => recipe.checks.map((check) => check.id));
  }
};

// src/recipes/catalog.ts
var recipeRegistry = new RecipeRegistry([
  new MiseOpInjectRecipe(),
  new MiseRecipe(),
  new AgentHooksRecipe(),
  new BmadRecipe(),
  new DockerRecipe(),
  new NodeRecipe(),
  new HermesAgentRecipe(),
  new NotebookRecipe(),
  new ProjectRecipe()
]);

// src/commands/AgentHooksCommands.ts
import { homedir as homedir8 } from "node:os";
import { join as join23, dirname as dirname11 } from "node:path";
import { existsSync as existsSync19, cpSync as cpSync2, mkdirSync as mkdirSync8, readFileSync as readFileSync17, writeFileSync as writeFileSync11 } from "node:fs";
import { fileURLToPath as fileURLToPath6 } from "node:url";
init_project();
var AGENT_HOOKS_SKIP_MESSAGE = "\u21B7 agent-hooks layer skipped: global ~/.agents/hooks detected (these hooks already run globally).\n   Set PJ_AGENT_HOOKS_LAYER=1 to install the project-scoped layer anyway.";
function resolveTemplateRoot() {
  const candidates = [];
  if (process.env.PJANGLER_COMMONPROJECT_TEMPLATE) {
    candidates.push(process.env.PJANGLER_COMMONPROJECT_TEMPLATE);
  }
  try {
    let dir = dirname11(fileURLToPath6(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join23(dir, "templates", "commonproject", "template"));
      const parent = dirname11(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  candidates.push(join23(homedir8(), "code", "pjangler", "templates", "commonproject", "template"));
  for (const c of candidates) {
    if (existsSync19(join23(c, ".agents", "hooks", "hooks.master.json"))) return c;
  }
  throw new Error(
    "Could not locate the CommonProject template. Set PJANGLER_COMMONPROJECT_TEMPLATE to <repo>/templates/commonproject/template."
  );
}
var CopyAgentHooksTree = class extends Command {
  async invoke() {
    if (!resolveAgentHooksLayer2()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    let templateRoot;
    try {
      templateRoot = resolveTemplateRoot();
    } catch (e) {
      return { success: false, message: `\u26A0\uFE0F  ${e.message}` };
    }
    const items = [
      { rel: ".agents/hooks", dir: true },
      { rel: ".agents/skills.json", dir: false },
      { rel: ".agents/local.example.json", dir: false },
      { rel: ".mise/scripts/hindsight-setup.sh", dir: false }
    ];
    const created = [];
    const skipped = [];
    for (const { rel, dir } of items) {
      const src = join23(templateRoot, rel);
      const dest = join23(this.context.targetDir, rel);
      if (!existsSync19(src)) continue;
      if (existsSync19(dest) && !this.context.force) {
        skipped.push(rel);
        continue;
      }
      if (!this.context.dryRun) {
        mkdirSync8(dirname11(dest), { recursive: true });
        cpSync2(src, dest, { recursive: dir, force: true });
      }
      created.push(rel);
    }
    const verb = this.context.dryRun ? "Would copy" : "Copied";
    const tail = skipped.length ? ` (${skipped.length} already present \u2014 use --force to overwrite)` : "";
    return {
      success: created.length > 0,
      message: this.formatMessage(`\u2705 ${verb} ${created.length} agent-hooks path(s)${tail}`)
    };
  }
};
var WireMiseAgentHooks = class _WireMiseAgentHooks extends Command {
  static MARKER = "# pjangler:agent-hooks";
  static CR = "{{config_root}}";
  // mise's own runtime var — emitted literally
  async invoke() {
    if (!resolveAgentHooksLayer2()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    const misePath = join23(this.context.targetDir, "mise.toml");
    if (!existsSync19(misePath)) {
      return {
        success: false,
        message: "\u26A0\uFE0F  No mise.toml found \u2014 run `pjangler init mise` first, then re-run."
      };
    }
    let content = readFileSync17(misePath, "utf8");
    if (content.includes(_WireMiseAgentHooks.MARKER)) {
      return { success: true, message: this.formatMessage("\u2713 mise.toml already wired for agent-hooks") };
    }
    const cr = _WireMiseAgentHooks.CR;
    const enterAdds = [`  "sync-skills.py --scope project",`, `  "${cr}/.agents/hooks/sync.py --install --quiet",`].join("\n");
    const leaveBlock = [
      "leave = [",
      `  "${cr}/.agents/hooks/sync.py --uninstall --quiet",`,
      "]"
    ].join("\n");
    let wiredHooks = false;
    const enterRe = /(enter\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
    if (enterRe.test(content)) {
      content = content.replace(enterRe, (_m, head, close) => {
        const sep7 = /[,[]\s*$/.test(head) ? "" : ",";
        return `${head}${sep7}
${enterAdds}${close}`;
      });
      const leaveRe = /(leave\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
      if (leaveRe.test(content)) {
        content = content.replace(leaveRe, (_m, head, close) => {
          const sep7 = /[,[]\s*$/.test(head) ? "" : ",";
          return `${head}${sep7}
  "${cr}/.agents/hooks/sync.py --uninstall --quiet",${close}`;
        });
      } else {
        content = content.replace(enterRe, (m) => `${m}
${leaveBlock}`);
      }
      wiredHooks = true;
    }
    const appended = [
      "",
      _WireMiseAgentHooks.MARKER + " (generated \u2014 see .agents/hooks/README.md)",
      // PJAN-61: task names use the colon namespace form. A colon is not legal
      // in a BARE toml key, so every header here MUST stay quoted.
      "[[watch_files]]",
      'patterns = [".agents/skills.json"]',
      'task = "skills:sync"',
      "",
      '[tasks."skills:sync"]',
      'description = "Sync skills from manifest to local CLI dirs"',
      'run = "sync-skills.py --scope project"',
      "",
      "[[watch_files]]",
      'patterns = [".agents/hooks/hooks.master.json"]',
      'task = "hooks:sync"',
      "",
      '[tasks."hooks:sync"]',
      'description = "Fan out hooks.master.json to each agent CLI (claude/codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --install"`,
      "",
      '[tasks."hooks:check"]',
      'description = "Drift gate: verify generated hook configs match hooks.master.json"',
      `run = "${cr}/.agents/hooks/sync.py --check"`,
      "",
      '[tasks."hooks:uninstall"]',
      'description = "Remove per-user agent-hook injections (codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --uninstall"`,
      "",
      '[tasks."hindsight:setup"]',
      `description = "Provision this dev's shared project Hindsight key from 1Password into .env"`,
      `run = "${cr}/.mise/scripts/hindsight-setup.sh"`,
      "",
      _WireMiseAgentHooks.MARKER + ":end",
      ""
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;
    if (!this.context.dryRun) writeFileSync11(misePath, content);
    if (wiredHooks) {
      return { success: true, message: this.formatMessage("\u2705 Wired mise.toml ([hooks] enter/leave + tasks)") };
    }
    return {
      success: true,
      message: this.formatMessage(
        `\u2705 Added agent-hooks tasks to mise.toml.
   \u26A0\uFE0F  Could not find a [hooks].enter array to extend \u2014 add these to your [hooks] block manually:
     enter += "sync-skills.py --scope project", "${cr}/.agents/hooks/sync.py --install --quiet"
     leave += "${cr}/.agents/hooks/sync.py --uninstall --quiet"`
      )
    };
  }
};

// src/commands/AddMiseToml.ts
var AddMiseToml = class extends Command {
  async invoke() {
    const filePath = "mise.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  mise.toml already exists"),
        filePath
      };
    }
    const content = `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create mise.toml" : "\u2705 Created mise.toml"),
      filePath
    };
  }
};

// src/commands/AddMiseBaseToml.ts
var AddMiseBaseToml = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/base.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/base.toml already exists"),
        filePath
      };
    }
    const content = `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "\u2705 Created .mise/tasks/base.toml"),
      filePath
    };
  }
};

// src/commands/AddMiseTasksStructure.ts
var AddMiseTasksStructure = class extends Command {
  async invoke() {
    this.createDirectory(".mise/tasks/scripts");
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise directory structure" : "\u2705 Created .mise directory structure"),
      filePath: ".mise/tasks/scripts"
    };
  }
};

// src/commands/AddMiseBaseScript.ts
var AddMiseBaseScript = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/scripts/base.py";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/scripts/base.py already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env python3
"""Base setup script"""
import os
import sys
from pathlib import Path

def main():
    print("\u{1F527} Setting up base environment...")

    dirs_to_create = ["logs", "temp", "data"]
    for dir_name in dirs_to_create:
        Path(dir_name).mkdir(exist_ok=True)
        print(f"  Created {dir_name}/ directory")

    print("  Base environment setup complete!")
    print("  Run 'mise run dev' to start development")

if __name__ == "__main__":
    main()
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/scripts/base.py" : "\u2705 Created .mise/tasks/scripts/base.py"),
      filePath
    };
  }
};

// src/commands/AddMiseCodegraphScript.ts
import { chmodSync as chmodSync5 } from "fs";
import { join as join24 } from "path";
var AddMiseCodegraphScript = class extends Command {
  async invoke() {
    const filePath = ".mise/scripts/codegraph.sh";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/scripts/codegraph.sh already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env bash
# Auto-generated by pjangler

REPO_ROOT="$(pwd)"
PROJECT_NAME="$(basename "$REPO_ROOT")"
CONTAINER_NAME="codegraph-mcp-$PROJECT_NAME"
CACHE_DIR="$REPO_ROOT/.codegraph"

# Deterministically generate a port based on the repository path
PORT=$(echo -n "$REPO_ROOT" | md5sum | awk '{print $1}' | tr -d 'a-f' | cut -c1-4)
# Ensure port is > 1024
PORT=$(( (PORT % 60000) + 1025 ))

if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
  echo "\u{1F680} Starting CodeGraph MCP Server on port $PORT..."

  # Ensure the container isn't lingering in a stopped state
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  # Run the true Colby McHenry CodeGraph Docker image
  # which we built locally as colbymchenry-codegraph-mcp:latest
  docker run -d \\
    --name "$CONTAINER_NAME" \\
    --restart unless-stopped \\
    -p "$PORT:8045" \\
    -v "$REPO_ROOT:/repo" \\
    colbymchenry-codegraph-mcp:latest >/dev/null

  echo "\u2705 CodeGraph MCP running in background. SSE URL: http://localhost:$PORT/sse"
fi

# Run init inside the container to ensure the index is bootstrapped.
# We run this using the standard codegraph CLI inside the container
docker exec "$CONTAINER_NAME" codegraph init -i /repo >/dev/null 2>&1 || true

# Wire up the MCP server to local agents
WIRE_SCRIPT="$(dirname "$0")/codegraph-wire.sh"
if [ -x "$WIRE_SCRIPT" ]; then
  "$WIRE_SCRIPT"
fi
`;
    this.writeFile(filePath, content);
    if (!this.context.dryRun) {
      chmodSync5(join24(this.context.targetDir, filePath), 493);
    }
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/scripts/codegraph.sh" : "\u2705 Created .mise/scripts/codegraph.sh"),
      filePath
    };
  }
};

// src/commands/AddDotenv.ts
var AddDotenv = class extends Command {
  async invoke() {
    const filePath = ".env";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .env already exists"),
        filePath
      };
    }
    const content = `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .env" : "\u2705 Created .env"),
      filePath
    };
  }
};

// src/parity/index.ts
import { existsSync as existsSync20 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { dirname as dirname12, join as join25, resolve as resolve13 } from "node:path";
import { fileURLToPath as fileURLToPath7 } from "node:url";
function resolvePjanglerRoot2() {
  let dir = dirname12(fileURLToPath7(import.meta.url));
  while (dir !== dirname12(dir)) {
    if (existsSync20(join25(dir, "package.json")) && existsSync20(join25(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname12(dir);
  }
  return resolve13(process.cwd());
}
function lifecycleContext(repoArg, dryRun, acceptRegistryMatches = false, overrides = {}) {
  const repoRoot = resolve13(repoArg ?? process.cwd());
  return {
    ...overrides,
    targetDir: repoRoot,
    repoRoot,
    dryRun: overrides.dryRun ?? dryRun,
    force: overrides.force ?? false,
    pjanglerRoot: overrides.pjanglerRoot ?? resolvePjanglerRoot2(),
    homeDir: overrides.homeDir ?? homedir9(),
    acceptRegistryMatches: overrides.acceptRegistryMatches ?? acceptRegistryMatches
  };
}
function getParityRuleIds() {
  return [...recipeRegistry.listRuleIds()];
}
function publicAudit2(report) {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding2 }) => finding2)
  };
}
function publicMigration2(report) {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result2 }) => result2)
  };
}
function runAudit(repoArg) {
  return publicAudit2(recipeRegistry.auditRecipes(lifecycleContext(repoArg, true)));
}
function runMigrationForRules(ruleIds, repoArg, dryRun, acceptRegistryMatches = false) {
  return publicMigration2(recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches),
    ruleIds
  ));
}
function runMigration(selector, repoArg, dryRun, all, acceptRegistryMatches = false) {
  const ctx = lifecycleContext(repoArg, dryRun, acceptRegistryMatches);
  return publicMigration2(all ? recipeRegistry.migrateAll(ctx) : recipeRegistry.migrateRules(ctx, selector ? [selector] : []));
}

// src/commands/WireMiseOpInject.ts
var WireMiseOpInject = class extends Command {
  async invoke() {
    const report = runMigrationForRules(
      ["mise.config-root", "secrets.env-op"],
      this.context.targetDir,
      Boolean(this.context.dryRun)
    );
    const blocked = report.results.filter((result2) => result2.status === "blocked");
    return {
      success: blocked.length === 0,
      outcome: blocked.length ? "failed" : report.changedFiles.length ? this.context.dryRun ? "planned" : "changed" : "unchanged",
      message: blocked.length ? `\u2717 op-inject lifecycle blocked: ${blocked.map((result2) => `${result2.id}: ${result2.summary}`).join("; ")}` : this.formatMessage(
        `${this.context.dryRun ? "Would wire" : "\u2713 Wired"} atomic .env materialization from .env.op`
      ),
      filePath: report.changedFiles[0]
    };
  }
};

// src/utils/registry.ts
var LEGACY_PUBLIC_RECIPE_IDS = ["mise", "docker", "node", "hermes-agent", "agent-hooks", "mise-op-inject"];
var RECIPE_REGISTRY = Object.freeze(Object.fromEntries(
  LEGACY_PUBLIC_RECIPE_IDS.map((id) => {
    const instance = recipeRegistry.get(id);
    if (!instance) throw new Error(`Production recipe registry is missing ${id}`);
    return [id, Object.freeze({
      name: instance.metadata.name,
      description: instance.metadata.description,
      instance,
      commands: [...instance.metadata.commands]
    })];
  })
));
var COMMAND_REGISTRY = {
  CopyAgentHooksTree: {
    name: "CopyAgentHooksTree",
    description: "Copy the generic agent-hooks tree (hooks SSOT + sync engine + scripts) from the CommonProject template",
    group: "agent-hooks",
    class: CopyAgentHooksTree
  },
  WireMiseAgentHooks: {
    name: "WireMiseAgentHooks",
    description: "Merge agent-hooks enter/leave + tasks into an existing mise.toml (idempotent)",
    group: "agent-hooks",
    class: WireMiseAgentHooks
  },
  AddDockerfile: {
    name: "AddDockerfile",
    description: "Create Dockerfile for containerization",
    group: "docker",
    class: AddDockerfile
  },
  AddDockerCompose: {
    name: "AddDockerCompose",
    description: "Create docker-compose.yml for multi-service setup",
    group: "docker",
    class: AddDockerCompose
  },
  AddDockerignore: {
    name: "AddDockerignore",
    description: "Create .dockerignore file",
    group: "docker",
    class: AddDockerignore
  },
  AddMiseToml: {
    name: "AddMiseToml",
    description: "Create mise.toml for version management",
    group: "mise",
    class: AddMiseToml
  },
  AddMiseBaseToml: {
    name: "AddMiseBaseToml",
    description: "Create base mise configuration",
    group: "mise",
    class: AddMiseBaseToml
  },
  AddMiseTasksStructure: {
    name: "AddMiseTasksStructure",
    description: "Create .mise/tasks directory structure",
    group: "mise",
    class: AddMiseTasksStructure
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddMiseCodegraphScript: {
    name: "AddMiseCodegraphScript",
    description: "Create .mise/scripts/codegraph.sh enter hook",
    group: "mise",
    class: AddMiseCodegraphScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  },
  WireMiseOpInject: {
    name: "WireMiseOpInject",
    description: "Wire up op-inject script to mise.toml for 1Password secret resolution",
    group: "mise",
    class: WireMiseOpInject
  }
};
function getRecipeNames() {
  return Object.keys(RECIPE_REGISTRY);
}
function getRecipeInfo(name) {
  return RECIPE_REGISTRY[name] || null;
}
function getCommandNames() {
  return Object.keys(COMMAND_REGISTRY);
}
function getCommandInfo(name) {
  return COMMAND_REGISTRY[name] || null;
}
function getCommandsByGroup() {
  const grouped = {};
  for (const cmdInfo of Object.values(COMMAND_REGISTRY)) {
    if (!grouped[cmdInfo.group]) {
      grouped[cmdInfo.group] = [];
    }
    grouped[cmdInfo.group].push(cmdInfo);
  }
  return grouped;
}

// src/index.ts
import { cancel as cancel2, multiselect, text as text2, isCancel as isCancel5 } from "@clack/prompts";
init_project();

// src/project/boardUrl.ts
import { existsSync as existsSync21, readFileSync as readFileSync18, statSync as statSync3 } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { dirname as dirname13, isAbsolute as isAbsolute5, join as join26, resolve as resolve14 } from "node:path";
var DEFAULT_PLANE_BASE = "https://plane.delo.sh";
var DEFAULT_PLANE_WORKSPACE = "33god";
function resolveTemplateConfigPath2(env2 = process.env, home = homedir10()) {
  const fromEnv = env2.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = env2.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join26(home, ".config");
  return join26(base, "hermes-agent-template", "config.toml");
}
function readTomlScalar(text3, section2, key) {
  let inSection = false;
  for (const raw of text3.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = line === `[${section2}]`;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted) return quoted[1] ?? quoted[2];
    const bare = (value.split("#")[0] ?? "").trim();
    return bare || void 0;
  }
  return void 0;
}
function readTemplateConfig(env2, home) {
  try {
    const path = resolveTemplateConfigPath2(env2, home);
    return existsSync21(path) ? readFileSync18(path, "utf8") : void 0;
  } catch {
    return void 0;
  }
}
function planeBase(env2 = process.env, home = homedir10()) {
  const fromEnv = env2.PLANE_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const config = readTemplateConfig(env2, home);
  const fromConfig = config ? readTomlScalar(config, "plane", "base")?.trim() : void 0;
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  return DEFAULT_PLANE_BASE;
}
function planeWorkspace(provider, env2, home) {
  const fromManifest = provider.workspace?.trim();
  if (fromManifest) return fromManifest;
  const config = readTemplateConfig(env2, home);
  const fromConfig = config ? readTomlScalar(config, "plane", "workspace")?.trim() : void 0;
  return fromConfig || DEFAULT_PLANE_WORKSPACE;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractTicketRef(branch, identifier) {
  if (!branch || !identifier) return void 0;
  const ident = identifier.trim();
  if (!ident) return void 0;
  const match = new RegExp(`\\b${escapeRegExp(ident)}-(\\d+)\\b`, "i").exec(branch);
  return match ? `${ident.toUpperCase()}-${match[1]}` : void 0;
}
function normalizeTicketRef(input, identifier) {
  const value = input?.trim();
  if (!value) return void 0;
  if (/^\d+$/.test(value)) {
    const ident = identifier?.trim();
    return ident ? `${ident.toUpperCase()}-${value}` : void 0;
  }
  const qualified = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(value);
  if (!qualified) return void 0;
  return `${qualified[1].toUpperCase()}-${qualified[2]}`;
}
function resolveTicketRef(provider, options) {
  return normalizeTicketRef(options.ref, provider.identifier) ?? extractTicketRef(options.branch, provider.identifier);
}
function boardUrl(provider, options = {}) {
  if (!provider) return void 0;
  const env2 = options.env ?? process.env;
  const home = options.home ?? homedir10();
  const type = (provider.type || "plane").trim().toLowerCase();
  const boardId = provider.board_id?.trim();
  if (!boardId) return void 0;
  if (type === "trello") {
    return `https://trello.com/b/${boardId}`;
  }
  if (type !== "plane") return void 0;
  const workspace = planeWorkspace(provider, env2, home);
  if (!workspace) return void 0;
  const base = planeBase(env2, home);
  const ref = resolveTicketRef(provider, options);
  return ref ? `${base}/${workspace}/browse/${ref}` : `${base}/${workspace}/projects/${boardId}/issues`;
}
function findProjectRoot(from) {
  let dir = resolve14(from);
  for (; ; ) {
    if (existsSync21(join26(dir, ".project.json"))) return dir;
    const parent = dirname13(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function readTicketProvider(root) {
  try {
    const manifest = JSON.parse(readFileSync18(join26(root, ".project.json"), "utf8"));
    const provider = manifest.ticket_provider;
    if (!provider || typeof provider !== "object") return void 0;
    return provider;
  } catch {
    return void 0;
  }
}
function currentBranch(from) {
  try {
    let dir = resolve14(from);
    for (; ; ) {
      const dotgit = join26(dir, ".git");
      if (existsSync21(dotgit)) {
        let gitDir = dotgit;
        if (statSync3(dotgit).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync18(dotgit, "utf8"));
          if (!pointer) return void 0;
          const target = pointer[1].trim();
          gitDir = isAbsolute5(target) ? target : resolve14(dir, target);
        }
        const head = readFileSync18(join26(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1].trim() : void 0;
      }
      const parent = dirname13(dir);
      if (parent === dir) return void 0;
      dir = parent;
    }
  } catch {
    return void 0;
  }
}
function resolveBoardUrl(cwd, ref, env2 = process.env) {
  const root = findProjectRoot(cwd);
  if (!root) return void 0;
  const provider = readTicketProvider(root);
  if (!provider) return void 0;
  return boardUrl(provider, { ref, branch: currentBranch(root), env: env2 });
}

// src/project/openUrl.ts
import { spawn as spawn2 } from "node:child_process";
function osc8(url, label = url) {
  return `\x1B]8;;${url}\x07${label}\x1B]8;;\x07`;
}
function isHeadless(env2 = process.env, platform2 = process.platform) {
  if (env2.SSH_CONNECTION || env2.SSH_TTY) return true;
  if (platform2 === "darwin") return false;
  return !(env2.WAYLAND_DISPLAY || env2.DISPLAY);
}
function launcher(platform2 = process.platform) {
  return platform2 === "darwin" ? "open" : "xdg-open";
}
function openUrl(url, env2 = process.env, platform2 = process.platform) {
  if (isHeadless(env2, platform2)) {
    return {
      opened: false,
      display: osc8(url),
      reason: "no display; printed a link instead"
    };
  }
  try {
    spawn2(launcher(platform2), [url], { detached: true, stdio: "ignore" }).unref();
    return { opened: true, display: osc8(url) };
  } catch (err) {
    return {
      opened: false,
      display: osc8(url),
      reason: `could not launch ${launcher(platform2)}: ${err.message}`
    };
  }
}

// src/describe/index.ts
import { existsSync as existsSync22, readFileSync as readFileSync19, readdirSync as readdirSync8, statSync as statSync5 } from "node:fs";
import { join as join28, resolve as resolve15 } from "node:path";
init_project();

// src/describe/activity.ts
import { spawn as spawn3, spawnSync as spawnSync14 } from "node:child_process";
import { statSync as statSync4 } from "node:fs";
import { join as join27 } from "node:path";
var ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;
var MAX_DIRTY_STATS = 500;
var GIT_TIMEOUT_MS = 5e3;
var GIT_MAX_BUFFER = 16 * 1024 * 1024;
function git3(repo, args) {
  const result2 = spawnSync14("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  });
  if (result2.status !== 0 || typeof result2.stdout !== "string") return void 0;
  return result2.stdout;
}
function gitAsync(repo, args) {
  return new Promise((resolve18) => {
    const child = spawn3("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve18(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(void 0);
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > GIT_MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(void 0);
        return;
      }
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(void 0);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : void 0);
    });
  });
}
function trimmed(raw) {
  if (raw === void 0) return void 0;
  const value = raw.trim();
  return value === "" ? void 0 : value;
}
function gitLine(repo, args) {
  return trimmed(git3(repo, args));
}
function isGitRepo(repo) {
  return gitLine(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
var MINUTE = 60;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var WEEK = 7 * DAY;
var MONTH = 30 * DAY;
var YEAR = 365 * DAY;
function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
function formatRelativeAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < WEEK) return plural(Math.floor(delta / DAY), "day");
  if (delta < MONTH) return plural(Math.floor(delta / WEEK), "week");
  if (delta < YEAR) return plural(Math.floor(delta / MONTH), "month");
  return plural(Math.floor(delta / YEAR), "year");
}
function formatCompactAge(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}
var REF_ARGS = [
  "for-each-ref",
  "--sort=-committerdate",
  "--format=%(committerdate:unix)%09%(refname:short)",
  "refs/heads",
  "refs/remotes",
  "refs/tags"
];
var WORKTREE_ARGS = ["worktree", "list", "--porcelain"];
var STATUS_ARGS = ["status", "--porcelain", "-z", "--ignore-submodules=dirty"];
function parseRefs(raw) {
  if (raw === void 0) return { count: 0 };
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return { count: 0 };
  const [stamp, name] = lines[0].split("	");
  const unix = Number(stamp);
  if (!Number.isFinite(unix) || unix <= 0) return { count: lines.length };
  return { source: { kind: "ref", label: name ?? "(unnamed ref)", unix }, count: lines.length };
}
function parseWorktrees(raw) {
  if (raw === void 0) return [];
  const entries = [];
  let current = { detached: false };
  const flush = () => {
    if (current.path && current.sha) entries.push({ path: current.path, sha: current.sha, detached: current.detached });
    current = { detached: false };
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.sha = line.slice("HEAD ".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}
function parseWorktreeStamps(raw, entries) {
  if (raw === void 0) return void 0;
  let best;
  for (const line of raw.split("\n")) {
    const [stamp, sha] = line.trim().split(" ");
    const unix = Number(stamp);
    if (!Number.isFinite(unix) || unix <= 0 || !sha) continue;
    if (best && unix <= best.unix) continue;
    const owner = entries.find((entry) => entry.sha === sha);
    const name = owner ? basenameOf(owner.path) : sha.slice(0, 7);
    best = { kind: "worktree", label: owner?.detached ? `${name} (detached)` : name, unix };
  }
  return best;
}
function parseStatusPaths(raw) {
  if (raw === void 0) return [];
  const parts = raw.split("\0").filter((part) => part !== "");
  const paths = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4 || entry[2] !== " ") continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}
function basenameOf(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function uncommittedSource(repo, paths) {
  if (!paths.length) return void 0;
  let newest = 0;
  for (const path of paths.slice(0, MAX_DIRTY_STATS)) {
    try {
      const mtime = Math.floor(statSync4(join27(repo, path)).mtimeMs / 1e3);
      if (mtime > newest) newest = mtime;
    } catch {
    }
  }
  if (newest <= 0) return void 0;
  const label = paths.length === 1 ? "1 uncommitted file" : `${paths.length} uncommitted files`;
  return { kind: "uncommitted", label, unix: newest };
}
var NO_ACTIVITY = {
  updated: null,
  updatedUnix: null,
  relative: "never",
  compact: "\u2014",
  active: false,
  source: null,
  scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 }
};
function emptyActivity() {
  return { ...NO_ACTIVITY, scanned: { refs: 0, worktrees: 0, dirtyFiles: 0 } };
}
function assembleActivity(candidates, scanned, now) {
  let winner = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!winner || candidate.unix >= winner.unix) winner = candidate;
  }
  if (!winner) return { ...NO_ACTIVITY, scanned };
  const nowUnix = Math.floor((now?.getTime() ?? Date.now()) / 1e3);
  const delta = nowUnix - winner.unix;
  return {
    updated: new Date(winner.unix * 1e3).toISOString(),
    updatedUnix: winner.unix,
    relative: formatRelativeAge(delta),
    compact: formatCompactAge(delta),
    active: delta < ACTIVE_WINDOW_SECONDS,
    source: winner,
    scanned
  };
}
function computeRepoActivity(repo, options = {}) {
  if (!isGitRepo(repo)) return emptyActivity();
  const refs = parseRefs(git3(repo, REF_ARGS));
  const worktrees = parseWorktrees(git3(repo, WORKTREE_ARGS));
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length ? parseWorktreeStamps(git3(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees) : void 0;
  const paths = parseStatusPaths(git3(repo, STATUS_ARGS));
  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now
  );
}
async function computeRepoActivityAsync(repo, options = {}) {
  if (trimmed(await gitAsync(repo, ["rev-parse", "--is-inside-work-tree"])) !== "true") return emptyActivity();
  const [refRaw, worktreeRaw, statusRaw] = await Promise.all([
    gitAsync(repo, REF_ARGS),
    gitAsync(repo, WORKTREE_ARGS),
    gitAsync(repo, STATUS_ARGS)
  ]);
  const refs = parseRefs(refRaw);
  const worktrees = parseWorktrees(worktreeRaw);
  const shas = [...new Set(worktrees.map((entry) => entry.sha))];
  const worktreeSource = shas.length ? parseWorktreeStamps(await gitAsync(repo, ["show", "-s", "--format=%ct %H", ...shas]), worktrees) : void 0;
  const paths = parseStatusPaths(statusRaw);
  return assembleActivity(
    [refs.source, worktreeSource, uncommittedSource(repo, paths)],
    { refs: refs.count, worktrees: worktrees.length, dirtyFiles: paths.length },
    options.now
  );
}
async function computeRepoActivityBatch(repos, options = {}) {
  const results = /* @__PURE__ */ new Map();
  const unique = [...new Set(repos)];
  const limit = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const repo = unique[cursor++];
      try {
        results.set(repo, await computeRepoActivityAsync(repo, options));
      } catch {
        results.set(repo, emptyActivity());
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, unique.length) }, worker));
  return results;
}

// src/describe/index.ts
init_config();
init_state();
init_style();
var SUBSYSTEM_MARKERS = {
  "mise-op-inject": [".env.op"],
  mise: ["mise.toml", ".mise.toml", ".mise/config.toml"],
  "agent-hooks": [".agents/skills.json", ".agents/hooks"],
  bmad: ["_bmad"],
  docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  node: ["package.json"],
  "hermes-agent": ["agents/hermes"],
  project: [".project.json"]
};
var LANGUAGE_MARKERS = [
  { file: "package.json", language: "javascript" },
  { file: "pyproject.toml", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "Cargo.toml", language: "rust" },
  { file: "go.mod", language: "go" },
  { file: "pom.xml", language: "jvm" },
  { file: "build.gradle", language: "jvm" },
  { file: "build.gradle.kts", language: "jvm" },
  { file: "Gemfile", language: "ruby" },
  { file: "composer.json", language: "php" }
];
var CONFIG_FILES = [
  { path: ".project.json", purpose: "33GOD project manifest (board binding, agents)", subsystem: "project" },
  { path: ".copier-answers.yml", purpose: "CommonProject render provenance", subsystem: "project" },
  { path: "copier.yml", purpose: "Copier template definition", subsystem: "-" },
  { path: "mise.toml", purpose: "Task runner, env, and enter/leave hooks", subsystem: "mise" },
  { path: ".mise/tasks", purpose: "File-based mise tasks", subsystem: "mise" },
  { path: ".mise/scripts", purpose: "Repo tooling on PATH", subsystem: "mise" },
  { path: ".env.op", purpose: "1Password secret references (materialized to .env)", subsystem: "mise-op-inject" },
  { path: ".env.example", purpose: "Documented environment contract", subsystem: "mise-op-inject" },
  { path: ".agents/skills.json", purpose: "Skillex skill/pack manifest", subsystem: "agent-hooks" },
  { path: ".agents/hooks", purpose: "Project-scoped agent hooks SSOT", subsystem: "agent-hooks" },
  { path: ".claude/settings.json", purpose: "Generated Claude Code hook config", subsystem: "agent-hooks" },
  { path: "_bmad", purpose: "BMAD methodology install", subsystem: "bmad" },
  { path: "_bmad-output", purpose: "BMAD work products", subsystem: "bmad" },
  { path: "AGENTS.md", purpose: "Agent instruction SSOT", subsystem: "-" },
  { path: "agents/hermes", purpose: "Hermes agent roles for this repo", subsystem: "hermes-agent" },
  { path: "Dockerfile", purpose: "Container image definition", subsystem: "docker" },
  { path: "docker-compose.yml", purpose: "Local service composition", subsystem: "docker" },
  { path: "package.json", purpose: "Node package manifest", subsystem: "node" },
  { path: "tsconfig.json", purpose: "TypeScript compiler config", subsystem: "node" },
  { path: "pyproject.toml", purpose: "Python package manifest", subsystem: "-" },
  { path: "Cargo.toml", purpose: "Rust package manifest", subsystem: "-" },
  { path: "go.mod", purpose: "Go module definition", subsystem: "-" },
  { path: ".gitignore", purpose: "Ignore rules", subsystem: "-" },
  { path: ".github/workflows", purpose: "GitHub Actions CI", subsystem: "-" }
];
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync19(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function describeGit(repo, activity) {
  if (!isGitRepo(repo)) return { isRepo: false };
  return {
    isRepo: true,
    branch: gitLine(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: gitLine(repo, ["rev-parse", "--short", "HEAD"]),
    remote: gitLine(repo, ["remote", "get-url", "origin"]),
    dirtyFiles: activity.scanned.dirtyFiles
  };
}
function describeType(repo) {
  const languages = [];
  const roles = [];
  const evidence = [];
  const note2 = (signal, file) => evidence.push(`${signal} (${file})`);
  for (const marker of LANGUAGE_MARKERS) {
    if (!existsSync22(join28(repo, marker.file))) continue;
    if (!languages.includes(marker.language)) {
      languages.push(marker.language);
      note2(marker.language, marker.file);
    }
  }
  try {
    const dotnet = readdirSync8(repo).find((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"));
    if (dotnet && !languages.includes("dotnet")) {
      languages.push("dotnet");
      note2("dotnet", dotnet);
    }
  } catch {
  }
  const pkg = readJson(join28(repo, "package.json"));
  if (pkg) {
    if (existsSync22(join28(repo, "tsconfig.json"))) {
      const index = languages.indexOf("javascript");
      if (index >= 0) languages.splice(index, 1);
      if (!languages.includes("typescript")) {
        languages.unshift("typescript");
        note2("typescript", "tsconfig.json");
      }
    }
    if (pkg.bin) {
      roles.push("cli");
      note2("cli", "package.json#bin");
    }
    if (pkg.workspaces) {
      roles.push("monorepo");
      note2("monorepo", "package.json#workspaces");
    }
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies
    };
    if (Object.keys(dependencies).some((name) => name.startsWith("@modelcontextprotocol/"))) {
      roles.push("mcp-server");
      note2("mcp-server", "package.json#@modelcontextprotocol");
    }
  }
  const roleMarkers = [
    ["copier-template", "copier.yml"],
    ["container-image", "Dockerfile"],
    ["compose-stack", "docker-compose.yml"],
    ["33god-project", ".project.json"],
    ["bmad-project", "_bmad"],
    ["hermes-fleet-host", "agents/hermes"]
  ];
  for (const [role, marker] of roleMarkers) {
    if (!existsSync22(join28(repo, marker))) continue;
    roles.push(role);
    note2(role, marker);
  }
  return { primaryLanguage: languages[0], languages, roles, evidence };
}
function describeIdentity(repo, registryPath2) {
  const manifestPath = join28(repo, ".project.json");
  const manifest = readJson(manifestPath);
  const drift = [];
  let record;
  let registryReadable = true;
  try {
    const registry = loadProjectRegistry(registryPath2);
    const slug = typeof manifest?.project_slug === "string" ? manifest.project_slug : void 0;
    const resolved = resolve15(repo);
    record = (slug ? registry.projects[slug] : void 0) ?? Object.values(registry.projects).find((project) => resolve15(project.repo_path) === resolved);
  } catch (err) {
    registryReadable = false;
    drift.push({ note: `registry unreadable: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (manifest && !record && registryReadable) {
    drift.push({ note: ".project.json exists but this repo is not in the pjangler registry" });
  }
  if (record && !manifest) {
    drift.push({ note: `registered as ${record.slug} but .project.json is missing`, command: "pjangler project doctor" });
  }
  if (record && resolve15(record.repo_path) !== resolve15(repo)) {
    drift.push({ note: `registry repo_path points elsewhere: ${record.repo_path}`, command: "pjangler project doctor" });
  }
  const manifestProvider = manifest?.ticket_provider;
  const provider = manifestProvider ? {
    type: String(manifestProvider.type ?? ""),
    workspace: manifestProvider.workspace,
    identifier: manifestProvider.identifier,
    board_id: manifestProvider.board_id,
    state: manifestProvider.state
  } : record?.ticket_provider;
  if (manifestProvider && record) {
    const fields = [
      ["type", provider?.type, record.ticket_provider.type],
      ["workspace", provider?.workspace, record.ticket_provider.workspace],
      ["identifier", provider?.identifier, record.ticket_provider.identifier],
      ["board_id", provider?.board_id, record.ticket_provider.board_id]
    ];
    for (const [field2, fromManifest, fromRegistry] of fields) {
      if ((fromManifest ?? "") === (fromRegistry ?? "")) continue;
      drift.push({
        note: `ticket_provider.${field2} differs: .project.json has "${fromManifest ?? ""}", registry has "${fromRegistry ?? ""}" \u2014 the manifest is the source of truth, so the registry record needs re-syncing`
      });
    }
  }
  const manifestAgents = manifest?.agents ?? {};
  const agents = record ? Object.entries(record.agents).map(([name, agent]) => ({
    name,
    role: agent.role,
    provisioningState: agent.provisioning_state,
    roleDir: agent.role_dir
  })) : Object.entries(manifestAgents).map(([name, agent]) => ({
    name,
    role: String(agent?.role ?? "unknown"),
    provisioningState: String(agent?.provisioning_state ?? "unknown"),
    roleDir: agent?.role_dir
  }));
  return {
    manifest: Boolean(manifest),
    registered: Boolean(record),
    registryPath: registryPath2,
    slug: record?.slug ?? manifest?.project_slug,
    name: record?.name ?? manifest?.project_name,
    description: record?.description ?? manifest?.project_description,
    ticketProvider: provider ? {
      type: provider.type,
      workspace: provider.workspace,
      identifier: provider.identifier,
      boardId: provider.board_id,
      state: provider.state
    } : void 0,
    agents,
    drift
  };
}
function describeSubsystems(repo, findings) {
  const byRecipe = /* @__PURE__ */ new Map();
  for (const finding2 of findings) {
    if (!finding2.recipeId) continue;
    const bucket = byRecipe.get(finding2.recipeId) ?? [];
    bucket.push(finding2);
    byRecipe.set(finding2.recipeId, bucket);
  }
  return recipeRegistry.list().map((metadata) => {
    const markers = SUBSYSTEM_MARKERS[metadata.id] ?? [];
    const evidence = metadata.id === "notebook" ? (() => {
      try {
        const manifest = JSON.parse(readFileSync19(join28(repo, ".project.json"), "utf8"));
        return manifest.notebook && typeof manifest.notebook === "object" ? [".project.json#notebook"] : [];
      } catch {
        return [];
      }
    })() : markers.filter((marker) => existsSync22(join28(repo, marker)));
    const rules = (byRecipe.get(metadata.id) ?? []).map((finding2) => ({
      id: finding2.id,
      title: finding2.title,
      status: finding2.status,
      summary: finding2.summary,
      fixable: finding2.fixable
    }));
    const graded = rules.filter((rule) => rule.status !== "skip");
    const parity = graded.length === 0 ? "unchecked" : graded.every((rule) => rule.status === "pass") ? "ok" : "drift";
    const present = evidence.length > 0;
    const status = !present ? "absent" : parity === "drift" ? "drifted" : "installed";
    return { id: metadata.id, name: metadata.name, description: metadata.description, status, parity, evidence, rules };
  });
}
function describeNotebook(repo, registryPath2) {
  try {
    const registry = loadProjectRegistry(registryPath2);
    const project = Object.values(registry.projects).find((entry) => resolve15(entry.repo_path) === resolve15(repo));
    const manifest = existsSync22(join28(repo, ".project.json")) ? JSON.parse(readFileSync19(join28(repo, ".project.json"), "utf8")) : void 0;
    const declared = Boolean(project?.notebook || manifest?.notebook && typeof manifest.notebook === "object");
    if (!declared) return { declared: false, bindingState: null, notebookId: null, overviewNoteId: null, health: null, remoteCheck: "skip", captureAdmission: null };
    const config = loadEffectiveNotebookConfig(repo, registryPath2);
    return {
      declared: true,
      bindingState: config.binding.state,
      notebookId: config.binding.notebook_id ?? null,
      overviewNoteId: config.binding.overview_note_id ?? null,
      health: null,
      remoteCheck: "skip",
      captureAdmission: captureAdmissionSummary(notebookStateRoot(), config.project_slug, config.limits)
    };
  } catch {
    return { declared: true, bindingState: null, notebookId: null, overviewNoteId: null, health: null, remoteCheck: "skip", captureAdmission: null };
  }
}
function describeConfigFiles(repo) {
  return CONFIG_FILES.filter((spec) => existsSync22(join28(repo, spec.path))).map((spec) => ({ path: spec.path, purpose: spec.purpose, subsystem: spec.subsystem }));
}
function describeNextSteps(description, findings) {
  const steps = [];
  if (!description.git.isRepo) {
    steps.push({
      title: "Initialize a git repository",
      reason: "pjangler lifecycle operations and parity rules assume a git work tree",
      source: "lifecycle",
      command: "git init"
    });
  }
  if (!description.identity.manifest) {
    steps.push({
      title: "Register this repo as a 33GOD project",
      reason: "no .project.json \u2014 the board binding and agent roster have nowhere to live",
      source: "lifecycle",
      command: "pjangler init --apply"
    });
  } else if (!description.identity.registered) {
    steps.push({
      title: "Add this project to the pjangler registry",
      reason: ".project.json exists but the central registry has no entry for this repo",
      source: "registry",
      command: `pjangler project init ${description.identity.name ?? ""} --target-dir . --apply`.replace(/\s+/g, " ")
    });
  }
  for (const entry of description.identity.drift) {
    if (entry.note.startsWith(".project.json exists but")) continue;
    steps.push({
      title: "Reconcile project registry drift",
      reason: entry.note,
      source: "registry",
      ...entry.command ? { command: entry.command } : {}
    });
  }
  const failing = findings.filter((finding2) => finding2.status === "fail" || finding2.status === "warn");
  const fixable = failing.filter((finding2) => finding2.fixable);
  if (fixable.length === 1) {
    const only = fixable[0];
    steps.push({
      title: `Fix ${only.id}`,
      reason: only.summary,
      source: "parity",
      command: `pjangler migrate ${only.id}`,
      rules: [only.id]
    });
  } else if (fixable.length > 1) {
    steps.push({
      title: `Apply ${fixable.length} parity migrations`,
      reason: `${fixable.length} fixable parity rules are failing; migrate --all selects exactly this set`,
      source: "parity",
      command: "pjangler migrate --all",
      rules: fixable.map((finding2) => finding2.id),
      details: fixable.map((finding2) => `${finding2.id}: ${finding2.summary}`)
    });
  }
  for (const finding2 of failing) {
    if (finding2.fixable) continue;
    steps.push({
      title: `Resolve ${finding2.id} manually`,
      reason: `${finding2.summary} \u2014 no migration recipe, this one needs hands`,
      source: "parity",
      rules: [finding2.id]
    });
  }
  for (const agent of description.identity.agents) {
    if (agent.provisioningState === "provisioned") continue;
    steps.push({
      title: `Provision the ${agent.role} agent`,
      reason: `${agent.name} is ${agent.provisioningState}, not provisioned`,
      source: "agents",
      command: `pjangler hermes-agent --role ${agent.role}`
    });
  }
  return steps;
}
function describeProject(input = {}) {
  const repo = resolve15(input.repoArg ?? process.cwd());
  if (!existsSync22(repo)) throw new Error(`Path does not exist: ${repo}`);
  if (!statSync5(repo).isDirectory()) throw new Error(`Not a directory: ${repo}`);
  const registryPath2 = input.registryPath ?? projectRegistryPath();
  const report = recipeRegistry.auditRecipes(lifecycleContext(repo, true));
  const findings = report.rules;
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const finding2 of findings) counts[finding2.status] += 1;
  const activity = computeRepoActivity(repo, { now: input.now });
  const partial = {
    repo,
    describedAt: report.auditedAt,
    git: describeGit(repo, activity),
    activity,
    type: describeType(repo),
    identity: describeIdentity(repo, registryPath2),
    notebook: describeNotebook(repo, registryPath2),
    subsystems: describeSubsystems(repo, findings),
    configFiles: describeConfigFiles(repo),
    parity: { ok: report.ok, counts }
  };
  return { ...partial, nextSteps: describeNextSteps(partial, findings) };
}
var MIN_WIDTH = 60;
var MAX_WIDTH = 120;
var LABEL = 11;
var SUBSYSTEM_STYLE = {
  installed: { glyph: glyph.pass, color: green },
  drifted: { glyph: glyph.warn, color: yellow },
  absent: { glyph: glyph.skip, color: gray }
};
function shortenPath(path, home) {
  const base = home ?? process.env.HOME;
  return base && path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
function section(title, count) {
  return `${bold(title)}${count ? `  ${dim(count)}` : ""}`;
}
function field(label, value) {
  return `  ${dim(padEndRaw(label, LABEL))}${value}`;
}
function padEndRaw(value, width) {
  return value.padEnd(width);
}
function renderDescribe(description, options = {}) {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, options.width ?? 100));
  const { identity: identity2, type, git: git4, activity } = description;
  const lines = [""];
  const title = identity2.name ?? description.repo.split("/").pop() ?? description.repo;
  const badge = identity2.ticketProvider?.identifier ? `  ${cyan(identity2.ticketProvider.identifier)}` : "";
  const pulse = activity.updatedUnix ? `${activity.active ? green("\u25CF") : yellow("\u25CB")} ${activity.active ? green(activity.relative) : yellow(activity.relative)}` : dim(`${glyph.skip} never`);
  const left = `  ${bold(title)}${badge}`;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(pulse) - 2);
  lines.push(`${left}${" ".repeat(gap)}${pulse}`);
  if (identity2.description) lines.push(`  ${dim(truncateVisible(identity2.description, width - 4))}`);
  lines.push(`  ${dim(truncateVisible(shortenPath(description.repo, options.home), width - 4))}`);
  lines.push("");
  const typeFacts = [type.primaryLanguage, ...type.roles].filter(Boolean);
  lines.push(field("type", typeFacts.length ? typeFacts.map((fact) => cyan(fact)).join(dim(" \xB7 ")) : dim("undetermined \u2014 no language or role markers found")));
  if (activity.source) {
    lines.push(field("updated", `${activity.relative} ${dim(`${glyph.dot} ${activity.source.label}`)}`));
  }
  if (identity2.ticketProvider) {
    const provider = identity2.ticketProvider;
    const board = [provider.type, provider.workspace, provider.identifier].filter(Boolean).join("/");
    lines.push(field("board", `${cyan(board)}${provider.state ? `  ${dim(provider.state)}` : ""}`));
  }
  if (git4.isRepo) {
    const facts = [cyan(git4.branch ?? "?")];
    if (git4.head) facts.push(dim(git4.head));
    facts.push(git4.dirtyFiles ? yellow(`${git4.dirtyFiles} uncommitted`) : green("clean"));
    lines.push(field("git", facts.join(dim(" \xB7 "))));
    if (git4.remote) lines.push(field("remote", dim(truncateVisible(git4.remote, width - LABEL - 4))));
  } else {
    lines.push(field("git", yellow("not a git repository")));
  }
  const registryNote = identity2.registered ? green("registered") : yellow("not registered");
  const registryPath2 = shortenPath(identity2.registryPath, options.home);
  const registryRoom = Math.max(10, width - LABEL - visibleWidth(registryNote) - 6);
  lines.push(field("registry", `${registryNote}  ${dim(truncateVisible(registryPath2, registryRoom))}`));
  if (description.notebook.declared) {
    const state = description.notebook.bindingState ?? "invalid";
    const capture = description.notebook.captureAdmission;
    const usage = capture ? ` \xB7 unresolved ${capture.unresolved_count ?? "unknown"}/${capture.receipt_caps.max_count}` : "";
    lines.push(field("notebook", `${cyan(state)}${dim(`${usage} \xB7 remote not observed`)}`));
  }
  for (const agent of identity2.agents) {
    const state = agent.provisioningState === "provisioned" ? green(agent.provisioningState) : yellow(agent.provisioningState);
    lines.push(field("agent", `${cyan(agent.name)} ${dim(agent.role)}  ${state}`));
  }
  for (const entry of identity2.drift) {
    lines.push("");
    for (const [index, wrapped] of wrapVisible(entry.note, width - 6).entries()) {
      lines.push(index === 0 ? `  ${yellow(glyph.warn)} ${wrapped}` : `    ${dim(wrapped)}`);
    }
  }
  lines.push("");
  const present = description.subsystems.filter((subsystem) => subsystem.status !== "absent");
  lines.push(section("Subsystems", `${present.length}/${description.subsystems.length} installed`));
  const nameWidth = description.subsystems.reduce((max, subsystem) => Math.max(max, subsystem.name.length), 0);
  for (const subsystem of description.subsystems) {
    const style = SUBSYSTEM_STYLE[subsystem.status];
    const failing = subsystem.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const detail = subsystem.status === "absent" ? dim(subsystem.description) : failing.length ? yellow(failing.map((rule) => rule.id).join(", ")) : dim(subsystem.evidence.join(", ") || subsystem.description);
    const head = `  ${style.color(style.glyph)} ${style.color(padEndRaw(subsystem.name, nameWidth))}`;
    lines.push(`${head}  ${truncateVisible(detail, Math.max(10, width - nameWidth - 8))}`);
  }
  lines.push("");
  lines.push(section("Config", `${description.configFiles.length} file${description.configFiles.length === 1 ? "" : "s"}`));
  if (!description.configFiles.length) lines.push(`  ${dim("(none found)")}`);
  const pathWidth = description.configFiles.reduce((max, file) => Math.max(max, file.path.length), 0);
  for (const file of description.configFiles) {
    const purpose = truncateVisible(file.purpose, Math.max(10, width - pathWidth - 6));
    lines.push(`  ${cyan(padEndRaw(file.path, pathWidth))}  ${dim(purpose)}`);
  }
  lines.push("");
  const { counts } = description.parity;
  lines.push(`${section("Parity")}  ${[
    counts.pass ? green(`${counts.pass} passed`) : dim("0 passed"),
    counts.fail ? red(`${counts.fail} failed`) : dim("0 failed"),
    counts.warn ? yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`) : dim("0 warnings"),
    dim(`${counts.skip} skipped`)
  ].join(dim(" \xB7 "))}`);
  lines.push("");
  lines.push(section("Next steps", String(description.nextSteps.length)));
  if (!description.nextSteps.length) {
    lines.push(`  ${green(glyph.pass)} ${dim("Nothing pending \u2014 parity is clean and the project is fully registered.")}`);
  }
  for (const [index, step] of description.nextSteps.entries()) {
    lines.push(`  ${cyan(String(index + 1).padStart(2))}  ${bold(step.title)}`);
    const body = step.details?.length ? step.details : [step.reason];
    for (const entry of body) {
      for (const [wrapIndex, wrapped] of wrapVisible(entry, width - 8).entries()) {
        lines.push(`      ${wrapIndex === 0 && step.details?.length ? dim(`${glyph.dot} `) : "  "}${dim(wrapped)}`);
      }
    }
    if (step.command) lines.push(`      ${dim(glyph.pointer)} ${cyan(step.command)}`);
  }
  lines.push("");
  return lines;
}
function formatProjectDescription(description, options = {}) {
  return renderDescribe(description, { width: options.width ?? terminalWidth(), home: options.home }).join("\n");
}

// src/describe/checklist.ts
init_style();
import { emitKeypressEvents } from "node:readline";
function createChecklist(items) {
  return {
    items,
    selected: new Set(items.map((item) => item.id)),
    cursor: 0,
    outcome: "pending"
  };
}
function selectedIds(state) {
  return state.items.filter((item) => state.selected.has(item.id)).map((item) => item.id);
}
function reduceChecklist(state, key) {
  if (state.outcome !== "pending") return state;
  const last = Math.max(0, state.items.length - 1);
  if (key.ctrl && key.name === "c") return { ...state, outcome: "cancel" };
  switch (key.name) {
    case "up":
    case "k":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "down":
    case "j":
      return { ...state, cursor: Math.min(last, state.cursor + 1) };
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: last };
    case "space": {
      const item = state.items[state.cursor];
      if (!item) return state;
      const selected = new Set(state.selected);
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
      return { ...state, selected };
    }
    // `a` covers `A` too: readline lowercases the name and flags shift.
    case "a":
    case "return":
    case "enter":
      return { ...state, outcome: "apply" };
    case "q":
    case "escape":
      return { ...state, outcome: "cancel" };
    default:
      return state;
  }
}
function renderChecklist(state, options = {}) {
  const width = Math.max(40, Math.min(120, options.width ?? 100));
  const lines = [""];
  lines.push(`  ${bold(options.title ?? "Select findings to apply")}`);
  lines.push("");
  const idWidth = state.items.reduce((max, item) => Math.max(max, item.title.length), 0);
  for (const [index, item] of state.items.entries()) {
    const onCursor = index === state.cursor;
    const ticked = state.selected.has(item.id);
    const pointer = onCursor ? cyan(glyph.chevron) : " ";
    const box = ticked ? green(glyph.pass) : dim(glyph.skip);
    const title = padVisible(ticked ? bold(item.title) : dim(item.title), idWidth);
    const detail = truncateVisible(item.detail, Math.max(10, width - idWidth - 10));
    lines.push(`  ${pointer} ${box} ${title}  ${dim(detail)}`);
  }
  lines.push("");
  const count = selectedIds(state).length;
  const legend = [
    `${cyan("\u2191\u2193")} move`,
    `${cyan("space")} toggle`,
    `${cyan("A")} apply`,
    `${cyan("q")} quit`
  ].join(dim(" \xB7 "));
  const tally = count ? green(`${count} selected`) : yellow("none selected");
  lines.push(`  ${legend}   ${tally}`);
  return lines.join("\n");
}
var HIDE_CURSOR = "\x1B[?25l";
var SHOW_CURSOR = "\x1B[?25h";
function runChecklist(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return new Promise((resolve18) => {
    let state = createChecklist(options.items);
    let previousLines = 0;
    const draw = () => {
      const frame = renderChecklist(state, { width: options.width, title: options.title });
      if (previousLines > 0) output.write(`\x1B[${previousLines}A\x1B[0J`);
      output.write(`${frame}
`);
      previousLines = frame.split("\n").length;
    };
    const onKey = (_chunk, key) => {
      if (!key) return;
      const next = reduceChecklist(state, key);
      if (next === state) return;
      state = next;
      if (state.outcome === "pending") {
        draw();
        return;
      }
      cleanup();
      resolve18({ outcome: state.outcome, selected: state.outcome === "apply" ? selectedIds(state) : [] });
    };
    const cleanup = () => {
      input.removeListener("keypress", onKey);
      if (input.isTTY) input.setRawMode?.(false);
      input.pause?.();
      output.write(SHOW_CURSOR);
    };
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode?.(true);
    input.resume?.();
    output.write(HIDE_CURSOR);
    draw();
    input.on("keypress", onKey);
    input.once("end", () => {
      if (state.outcome !== "pending") return;
      cleanup();
      resolve18({ outcome: "cancel", selected: [] });
    });
  });
}

// src/index.ts
init_style();

// src/notebook/cli.ts
init_project();
init_capture();
import { closeSync as closeSync7, constants as constants6, existsSync as existsSync23, fstatSync as fstatSync5, lstatSync as lstatSync10, openSync as openSync7, readSync as readSync4 } from "node:fs";
import { resolve as resolve16 } from "node:path";
import { createInterface } from "node:readline/promises";

// src/notebook/migration.ts
async function migrateNotebook(module, repo, input) {
  const observed = await module.audit(repo, !input.live);
  const selectedSet = new Set(observed.data.rules.filter((rule) => rule.fixable && (rule.status === "fail" || rule.status === "warn")).map((rule) => rule.id).filter((id) => NOTEBOOK_RULE_IDS.includes(id)));
  const config = observed.config;
  const remoteRequired = config.policy.enabled && Boolean(config.base_url) && config.binding.state !== "disabled" && config.binding.state !== "linked";
  if (!input.live && remoteRequired) {
    selectedSet.add("notebook.remote-notebook");
    selectedSet.add("notebook.overview-note");
  }
  const selected = NOTEBOOK_RULE_IDS.filter((id) => selectedSet.has(id));
  if (!input.apply) return {
    dry_run: true,
    selected_rules: selected,
    results: selected.map((id) => ({
      id,
      status: "planned",
      summary: id === "notebook.capture-receipts" ? "Plan preservation-safe local cleanup" : id === "notebook.configuration" ? "Declare a planned authoritative Registry binding and canary-safe Manifest policy without remote work" : (id === "notebook.remote-notebook" || id === "notebook.overview-note") && !input.live ? "Remote repair requires pj notebook migrate --apply --live" : "Plan selected owned repair"
    })),
    changed_files: []
  };
  const results = [];
  const changed = [];
  let installed = false;
  let provisioned = false;
  for (const id of selected) {
    if ((id === "notebook.remote-notebook" || id === "notebook.overview-note") && !input.live) {
      results.push({ id, status: "blocked", summary: "Remote repair requires pj notebook migrate --apply --live" });
      continue;
    }
    if (id === "notebook.configuration") {
      const files = await module.declareNotebook(repo);
      changed.push(...files);
      results.push({
        id,
        status: files.length ? "applied" : "noop",
        summary: files.length ? "Declared a planned Registry binding and Manifest policy with SessionStart and SessionEnd capture disabled" : "Authoritative Project Notebook declaration already matches"
      });
      continue;
    }
    if (id === "notebook.binding") {
      const files = module.repairBindingProjection(repo);
      changed.push(...files);
      results.push({ id, status: files.length ? "applied" : "noop", summary: files.length ? "Projected the authoritative Registry binding into .project.json" : "Registry and Manifest binding projection already match" });
      continue;
    }
    if (id === "notebook.skill-installed" || id === "notebook.hooks-projected") {
      if (!installed) {
        const files = module.installIntegration().changedFiles;
        changed.push(...files);
        installed = true;
        results.push({ id, status: files.length ? "applied" : "noop", summary: files.length ? "Installed the verified Project Notebook skill and projected canonical hooks" : "Verified Project Notebook skill and hook projection already match" });
      } else {
        results.push({ id, status: "noop", summary: "Verified Project Notebook skill and hook projection already repaired by the selected companion rule" });
      }
      continue;
    }
    if (id === "notebook.remote-notebook" || id === "notebook.overview-note") {
      if (!provisioned) {
        const created = await module.create(repo, true);
        changed.push(...created.changedFiles);
        provisioned = true;
        results.push({ id, status: created.changedFiles.length || created.data.created ? "applied" : "noop", summary: "Reconciled stable Notebook and Overview identities" });
      } else {
        results.push({ id, status: "noop", summary: "Stable Notebook and Overview were reconciled by the selected companion rule" });
      }
      continue;
    }
    if (id === "notebook.capture-receipts") {
      const recovered = module.recoverCaptureJournals(repo);
      const removed = module.pruneCaptureState(repo);
      changed.push(...removed, ...recovered);
      results.push({
        id,
        status: removed.length || recovered.length ? "applied" : "noop",
        summary: recovered.length ? `Finalized ${recovered.length} reconciled journal(s) only after proving succeeded-receipt logical and remote IDs; then expired only eligible state` : "Expired only eligible succeeded or unreferenced receiptless state"
      });
      continue;
    }
    results.push({ id, status: "blocked", summary: "Selected repair requires the canonical Project Notebook projector or explicit global configuration" });
  }
  const post = await module.audit(repo, !input.live);
  for (const result2 of results) {
    if (result2.status !== "applied" && result2.status !== "noop") continue;
    const rule = post.data.rules.find((item) => item.id === result2.id);
    if (rule && (rule.status === "fail" || rule.status === "warn")) {
      result2.status = "blocked";
      result2.summary = `Postcondition failed: ${rule.summary}`;
    }
  }
  return { dry_run: false, selected_rules: selected, results, changed_files: [...new Set(changed)].sort() };
}

// src/notebook/cli.ts
init_output();
init_state();
init_types();
function fallbackConfig(repo) {
  return {
    schema_version: 1,
    project_slug: "unknown",
    repo_path: resolve16(repo),
    base_url: null,
    auth: { mode: "none" },
    policy: { enabled: false, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 4e3, documentation_globs: ["**/*.md", "**/*.mdx"] },
    limits: { ...DEFAULT_NOTEBOOK_LIMITS },
    binding: { state: "planned" },
    configuration_provenance: {}
  };
}
function humanValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function emit(envelope, json) {
  validateNotebookEnvelope(envelope);
  if (json) process.stdout.write(renderNotebookJson(envelope));
  else if (envelope.ok) process.stdout.write(`${humanValue(envelope.data)}
`);
  else process.stderr.write(`notebook: ${envelope.error.code}: ${envelope.error.message}
`);
  process.exitCode = notebookEnvelopeExitCode(envelope);
}
async function execute(input) {
  try {
    const result2 = await input.run();
    emit(successEnvelope(input.command, result2.config, result2.data, result2.health ?? null), input.json);
  } catch (error) {
    let config;
    try {
      config = input.module.context(input.repo, false).config;
    } catch {
      config = fallbackConfig(input.repo);
    }
    emit(failureEnvelope(input.command, config, error), input.json);
  }
}
function readBoundedRegularFile(path, maxBytes) {
  const absolute = resolve16(path);
  if (!existsSync23(absolute)) throw new NotebookError("INVALID_INPUT", `File not found: ${absolute}`);
  const before = lstatSync10(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new NotebookError("INVALID_INPUT", `File must be a regular non-symlink: ${absolute}`);
  if (before.size > maxBytes) throw new NotebookError("INVALID_INPUT", `File exceeds the configured ceiling: ${absolute}`);
  const fd = openSync7(absolute, constants6.O_RDONLY | (constants6.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync5(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new NotebookError("INVALID_INPUT", `File changed while opening: ${absolute}`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
      const count = readSync4(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new NotebookError("INVALID_INPUT", `File exceeds the configured ceiling: ${absolute}`);
      chunks.push(chunk.subarray(0, count));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new NotebookError("INVALID_INPUT", `File must be valid UTF-8: ${absolute}`);
    }
  } finally {
    closeSync7(fd);
  }
}
function textInput(options, maxBytes) {
  if (options.text !== void 0 === (options.file !== void 0)) throw new NotebookError("INVALID_INPUT", "Exactly one of --text or --file is required");
  if (options.text !== void 0) {
    if (Buffer.byteLength(options.text, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Text exceeds the configured ceiling");
    return options.text;
  }
  return readBoundedRegularFile(options.file, maxBytes);
}
async function confirmDelete(noteId, options) {
  if (options.yes) return true;
  if (options.json || !process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompt.question(`Delete note ${noteId}? Type yes to continue: `)).trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}
function registerNotebookCli(program2, module = new NotebookModule()) {
  const notebook = program2.command("notebook").description("Manage the repository companion notebook");
  notebook.command("status").argument("[repo]", "Registered repository", process.cwd()).option("--local-only", "Do not construct or contact the remote adapter").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.status",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => {
      const result2 = await module.status(repo, Boolean(options.localOnly));
      return { config: result2.config, data: result2.data, health: result2.health };
    }
  }));
  notebook.command("create").argument("[repo]", "Registered repository", process.cwd()).option("--live", "Authorize the composite remote reconciliation").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.create",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => {
      const result2 = await module.create(repo, Boolean(options.live));
      return { config: result2.config, data: result2.data, health: result2.health };
    }
  }));
  const list = notebook.command("list").description("List notebook resources");
  list.command("notes").argument("[repo]", "Registered repository", process.cwd()).option("--limit <n>", "Page size", (value) => Number(value), 50).option("--cursor <value>", "Opaque page cursor").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.notes.list",
    repo,
    json: Boolean(options.json),
    module,
    run: () => module.listNotes(repo, options.limit, options.cursor)
  }));
  const add = notebook.command("add").description("Add notebook resources");
  add.command("note").argument("[repo]", "Registered repository", process.cwd()).option("--title <text>", "Note title").option("--text <text>", "Note body").option("--file <path>", "Read note body from a regular file").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.notes.add",
    repo,
    json: Boolean(options.json),
    module,
    run: () => {
      if (options.title === void 0) throw new NotebookError("INVALID_INPUT", "--title is required");
      return module.addNote(repo, options.title, textInput(options, module.context(repo, false).config.limits.note_max_bytes));
    }
  }));
  const get = notebook.command("get").description("Get notebook resources");
  get.command("note").argument("<note-id>", "Stable note ID").argument("[repo]", "Registered repository", process.cwd()).option("--json", "Emit JSON v1").action(async (noteId, repo, options) => execute({ command: "notebook.notes.get", repo, json: Boolean(options.json), module, run: () => module.getNote(repo, noteId) }));
  const update = notebook.command("update").description("Update notebook resources");
  update.command("note").argument("<note-id>", "Stable note ID").argument("[repo]", "Registered repository", process.cwd()).option("--title <text>", "Replacement title").option("--text <text>", "Replacement body").option("--file <path>", "Read replacement body from a regular file").option("--json", "Emit JSON v1").action(async (noteId, repo, options) => execute({
    command: "notebook.notes.update",
    repo,
    json: Boolean(options.json),
    module,
    run: () => module.updateNote(repo, noteId, { title: options.title, text: textInput(options, module.context(repo, false).config.limits.note_max_bytes) })
  }));
  const remove = notebook.command("delete").description("Delete notebook resources");
  remove.command("note").argument("<note-id>", "Stable note ID").argument("[repo]", "Registered repository", process.cwd()).option("--yes", "Confirm deletion").option("--json", "Emit JSON v1").action(async (noteId, repo, options) => execute({
    command: "notebook.notes.delete",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => module.deleteNote(repo, noteId, await confirmDelete(noteId, options))
  }));
  const search = notebook.command("search").description("Search scoped notebook resources locally");
  search.command("notes").argument("<query>", "Required all-token text query").argument("[repo]", "Registered repository", process.cwd()).option("--limit <n>", "Result limit", (value) => Number(value), 20).option("--json", "Emit JSON v1").action(async (query, repo, options) => execute({ command: "notebook.notes.search", repo, json: Boolean(options.json), module, run: () => module.searchNotes(repo, query, options.limit) }));
  notebook.command("overview").argument("[repo]", "Registered repository", process.cwd()).option("--set-file <path>", "Replace Overview body from a regular file").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: options.setFile ? "notebook.overview.set" : "notebook.overview.get",
    repo,
    json: Boolean(options.json),
    module,
    run: () => module.overview(repo, options.setFile ? readBoundedRegularFile(options.setFile, module.context(repo, false).config.limits.note_max_bytes) : void 0)
  }));
  const capture = notebook.command("capture").description("Inspect and retry durable capture receipts");
  capture.command("list").argument("[repo]", "Registered repository", process.cwd()).option("--state <value>", "Filter by exact receipt state").option("--json", "Emit JSON v1").action(async (repo, options) => execute({ command: "notebook.capture.list", repo, json: Boolean(options.json), module, run: () => module.captureList(repo, options.state) }));
  capture.command("retry").argument("<receipt-id>", "Durable receipt ID").argument("[repo]", "Registered repository", process.cwd()).option("--baseline <git-ref>", "Explicit committed baseline for blocked-missing-baseline").option("--json", "Emit JSON v1").action(async (receiptId, repo, options) => execute({ command: "notebook.capture.retry", repo, json: Boolean(options.json), module, run: () => module.captureRetry(repo, receiptId, options.baseline) }));
  notebook.command("audit").argument("[repo]", "Registered repository", process.cwd()).option("--local-only", "Do not construct or contact the remote adapter").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.audit",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => {
      const result2 = await module.audit(repo, Boolean(options.localOnly));
      return { config: result2.config, data: result2.data, health: result2.health };
    }
  }));
  notebook.command("migrate").argument("[repo]", "Registered repository", process.cwd()).option("--apply", "Apply selected owned repairs").option("--live", "Authorize selected remote repairs").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.migrate",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => ({ config: module.context(repo, false).config, data: await migrateNotebook(module, repo, { apply: Boolean(options.apply), live: Boolean(options.live) }) })
  }));
  notebook.command("skill").description("Inspect and reconcile the host Project Notebook skill projection").argument("[repo]", "Registered repository", process.cwd()).option("--apply", "Restore the drifted canonical projection from the version-pinned export").option("--json", "Emit JSON v1").action(async (repo, options) => execute({
    command: "notebook.skill",
    repo,
    json: Boolean(options.json),
    module,
    run: async () => ({ config: module.context(repo, false).config, data: module.repairSkillProjection(Boolean(options.apply)) })
  }));
  const hook = notebook.command("hook", { hidden: true }).description("Internal managed hook entry points");
  for (const [name, expected] of [["session-start", "SessionStart"], ["session-close", "SessionEnd"]]) {
    hook.command(name, { hidden: true }).option("--payload-file <path>", "Contained compatibility payload file").action(async (options) => {
      try {
        const read = readHookPayload({ payloadFile: options.payloadFile, stateRoot: module.stateRoot, maxBytes: DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes });
        const payload = read.payload;
        const repo = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
        if (repo) {
          const configuredLimit = module.context(repo, false).config.limits.hook_payload_max_bytes;
          if (read.bytes > configuredLimit) throw new NotebookError("INVALID_INPUT", "Hook payload exceeds this project's configured ceiling");
        }
        if (payload.hook_event_name === void 0) payload.hook_event_name = expected;
        const result2 = name === "session-start" ? await runSessionStartHook(module, payload) : runSessionCloseHook(module, payload);
        if (result2.stdout) process.stdout.write(result2.stdout);
        if (result2.stderr) process.stderr.write(`${result2.stderr}
`);
      } catch (error) {
        process.stderr.write(`project-notebook: hook payload rejected; failed open: ${normalizeNotebookError(error).message.slice(0, 512)}
`);
      }
      process.exitCode = 0;
    });
  }
  const worker = notebook.command("worker", { hidden: true }).description("Internal detached workers");
  worker.command("capture", { hidden: true }).requiredOption("--receipt-id <id>", "Durable receipt ID").action(async (options) => {
    try {
      const registryFile = projectRegistryPath();
      const registry = loadProjectRegistry(registryFile);
      const root = notebookStateRoot();
      const explicit = process.env.PJ_NOTEBOOK_WORKER_PROJECT_SLUG;
      const slug = explicit && registry.projects[explicit] ? explicit : Object.keys(registry.projects).find((candidate) => existsSync23(statePathForReceipt(root, candidate, options.receiptId)));
      if (!slug) throw new NotebookError("NOT_FOUND", "Receipt does not belong to a registered project");
      await runCaptureWorker(new NotebookModule({ registryPath: registryFile, stateRoot: root }), slug, options.receiptId);
    } catch (error) {
      process.stderr.write(`project-notebook worker: ${normalizeNotebookError(error).message.slice(0, 512)}
`);
      process.exitCode = 6;
    }
  });
}
function isNotebookJsonInvocation(args) {
  return args[0] === "notebook" && args.includes("--json");
}
function parserCommand(args) {
  const primary = args[1];
  const secondary = args[2];
  if (primary === "status" || primary === "create" || primary === "audit" || primary === "migrate" || primary === "skill") return `notebook.${primary}`;
  if (primary === "overview") return args.includes("--set-file") ? "notebook.overview.set" : "notebook.overview.get";
  if (primary === "list" && secondary === "notes") return "notebook.notes.list";
  if (primary === "add" && secondary === "note") return "notebook.notes.add";
  if (primary === "get" && secondary === "note") return "notebook.notes.get";
  if (primary === "update" && secondary === "note") return "notebook.notes.update";
  if (primary === "delete" && secondary === "note") return "notebook.notes.delete";
  if (primary === "search" && secondary === "notes") return "notebook.notes.search";
  if (primary === "capture" && secondary === "list") return "notebook.capture.list";
  if (primary === "capture" && secondary === "retry") return "notebook.capture.retry";
  return "notebook.status";
}
function parserRepo(args) {
  const primary = args[1];
  const secondary = args[2];
  const index = primary === "status" || primary === "create" || primary === "audit" || primary === "migrate" || primary === "overview" ? 2 : primary === "list" || primary === "add" || primary === "capture" && secondary === "list" ? 3 : 4;
  const candidate = args[index];
  return candidate && !candidate.startsWith("-") ? candidate : process.cwd();
}
function notebookParserFailureEnvelope(args, module = new NotebookModule()) {
  const repo = parserRepo(args);
  let config;
  try {
    config = module.context(repo, false).config;
  } catch {
    config = fallbackConfig(repo);
  }
  return failureEnvelope(parserCommand(args), config, new NotebookError("INVALID_INPUT", "Invalid notebook command arguments"));
}

// src/index.ts
init_output();
var xmark = `${red(glyph.fail)}`;
function printMigrationReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMigrationReport(report));
  }
}
async function promptForRuleIds(rules) {
  const fixable = rules.filter((rule) => rule.fixable);
  const { message, options } = formatRulePicker(fixable);
  if (!options.length) {
    return [];
  }
  const initialValues = fixable.filter((rule) => rule.status !== "pass" && rule.status !== "skip").map((rule) => rule.id);
  const selected = await multiselect({
    message,
    options,
    initialValues
  });
  if (isCancel5(selected)) {
    return [];
  }
  return selected;
}
function readJson2(path) {
  if (!existsSync24(path)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync20(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function findGitRoot(cwd) {
  const result2 = spawnSync15("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result2.status !== 0) return void 0;
  return resolve17(result2.stdout.trim());
}
function packageNameToProjectName(value) {
  if (!value) return void 0;
  const name = value.split("/").pop() ?? value;
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}
function deriveProjectDefaults(targetDir) {
  const manifest = readJson2(join29(targetDir, ".project.json"));
  const pkg = readJson2(join29(targetDir, "package.json"));
  const name = String(manifest?.project_name ?? "").trim() || packageNameToProjectName(typeof pkg?.name === "string" ? pkg.name : void 0) || packageNameToProjectName(basename8(targetDir)) || "Project";
  const ticketProvider = manifest?.ticket_provider && typeof manifest.ticket_provider === "object" ? manifest.ticket_provider : {};
  return {
    name,
    description: String(manifest?.project_description ?? pkg?.description ?? ""),
    slug: typeof manifest?.project_slug === "string" ? manifest.project_slug : void 0,
    identifier: typeof ticketProvider.identifier === "string" ? ticketProvider.identifier : void 0
  };
}
function isInteractiveProjectInit(options) {
  return !options.json && !options.yes && options.tui !== false && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
async function promptTextValue(message, initialValue) {
  const value = await text2({
    message,
    initialValue,
    validate: (input) => input?.trim() ? void 0 : "Required"
  });
  if (isCancel5(value)) {
    cancel2("project init cancelled");
    process.exit(1);
  }
  return value.trim();
}
function projectInitActionLabel(kind) {
  switch (kind) {
    case "registry.upsert":
      return "Register/update project registry entry";
    case "copier.copy.commonproject":
      return "Render CommonProject scaffold";
    case "project.write-manifest":
      return "Write repo-local .project.json projection";
    case "ticket-provider.create-or-link":
      return "Create/link ticket provider project";
    case "hermes.provision-agent":
      return "Provision Hermes agent";
    default:
      return kind;
  }
}
function registryNeedsUpsert(plan) {
  const registry = loadProjectRegistry(plan.registryPath);
  const existing = registry.projects[plan.project.slug];
  if (!existing) return true;
  const { created_at: _existingCreated, updated_at: _existingUpdated, ...existingComparable } = existing;
  const { created_at: _projectCreated, updated_at: _projectUpdated, ...projectComparable } = plan.project;
  return JSON.stringify(existingComparable) !== JSON.stringify(projectComparable);
}
function actionNeedsRun(plan, kind, syncMode) {
  if (kind === "registry.upsert") return registryNeedsUpsert(plan);
  if (kind === "project.write-manifest") {
    const action = plan.actions.find((item) => item.kind === "project.write-manifest");
    if (!action || action.kind !== "project.write-manifest") return false;
    const next = `${JSON.stringify(action.manifest, null, 2)}
`;
    return !existsSync24(action.path) || readFileSync20(action.path, "utf8") !== next;
  }
  if (kind === "copier.copy.commonproject") return true;
  if (kind === "ticket-provider.create-or-link") return plan.actions.some((action) => action.kind === kind && action.enabled);
  if (kind === "hermes.provision-agent") return plan.actions.some((action) => action.kind === kind && action.enabled);
  return true;
}
async function selectProjectInitOperations(input) {
  const planOperations = input.plan.actions.filter((action) => actionNeedsRun(input.plan, action.kind, input.syncMode)).map((action) => ({
    value: action.kind,
    label: projectInitActionLabel(action.kind),
    hint: action.kind === "registry.upsert" ? input.plan.registryPath : action.kind
  }));
  const parityOperations = input.auditRules.filter((rule) => rule.fixable && rule.status !== "pass" && rule.status !== "skip").map((rule) => ({
    value: `parity:${rule.id}`,
    label: `${rule.title}`,
    hint: `${rule.id}: ${rule.summary}`
  }));
  const operations = [...planOperations, ...parityOperations];
  const all = operations.map((operation) => operation.value);
  if (input.options.yes || input.options.apply && !isInteractiveProjectInit(input.options)) {
    return {
      selectedOperations: all,
      selectedParityRules: parityOperations.map((operation) => operation.value.replace(/^parity:/, ""))
    };
  }
  if (input.options.dryRun || !isInteractiveProjectInit(input.options)) {
    return { selectedOperations: [], selectedParityRules: [] };
  }
  if (!operations.length) return { selectedOperations: [], selectedParityRules: [] };
  const selected = await multiselect({
    message: "Select project init operations to run:",
    options: operations,
    initialValues: all
  });
  if (isCancel5(selected)) {
    cancel2("project init cancelled");
    process.exit(1);
  }
  return {
    selectedOperations: selected,
    selectedParityRules: selected.filter((value) => value.startsWith("parity:")).map((value) => value.replace(/^parity:/, ""))
  };
}
async function resolveProjectInitTarget(name, options) {
  const interactive = isInteractiveProjectInit(options);
  const cwd = process.cwd();
  const cwdGitRoot = findGitRoot(cwd);
  let targetDir = options.targetDir ? resolve17(options.targetDir) : void 0;
  if (!targetDir && cwdGitRoot) {
    targetDir = cwdGitRoot;
  }
  if (!targetDir && interactive) {
    const defaultName = name ?? basename8(cwd);
    const promptedName = name ?? await promptTextValue("Project name", packageNameToProjectName(defaultName));
    const defaultDir = join29(cwd, promptedName.replace(/[^A-Za-z0-9._-]/g, "") || promptedName.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    targetDir = await promptTextValue("Project directory", defaultDir);
    name = promptedName;
  }
  if (!targetDir) {
    if (!name) throw new Error("Project name or --target-dir is required when project init is not run inside a git repo");
    targetDir = resolve17(process.cwd(), name.replace(/[^A-Za-z0-9._-]/g, "") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  }
  const targetExists = existsSync24(targetDir);
  if (targetExists && !statSync6(targetDir).isDirectory()) throw new Error(`Target path is not a directory: ${targetDir}`);
  const targetGitRoot = targetExists ? findGitRoot(targetDir) : void 0;
  const syncMode = Boolean(targetGitRoot && resolve17(targetGitRoot) === resolve17(targetDir));
  const defaults = targetExists ? deriveProjectDefaults(targetDir) : { name: packageNameToProjectName(basename8(targetDir)) ?? "Project", description: "" };
  if (!name && interactive && !syncMode) {
    name = await promptTextValue("Project name", defaults.name);
  }
  return {
    name: name ?? defaults.name,
    targetDir,
    description: options.description ?? defaults.description,
    syncMode,
    slug: options.slug ?? defaults.slug,
    identifier: options.identifier ?? defaults.identifier
  };
}
async function runRecipeSubsystem(name, options) {
  const context = {
    targetDir: process.cwd(),
    force: options.force || false,
    dryRun: options.dryRun || false
  };
  try {
    if (!recipeRegistry.get(name)) {
      console.error(`${xmark} Unknown subsystem: ${bold(name)}`);
      console.error(`  ${dim("Available:")} ${getRecipeNames().map((available) => cyan(available)).join(dim(", "))}`);
      process.exit(1);
    }
    const result2 = await recipeRegistry.initRecipe(
      name,
      lifecycleContext(context.targetDir, Boolean(context.dryRun), false, context),
      {}
    );
    for (const line of result2.logs) console.log(line.split("\n").map((part) => part ? `  ${part}` : part).join("\n"));
    for (const error of result2.errors) console.error(`${xmark} ${error}`);
    if (!result2.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`${xmark} Error scaffolding ${bold(name)}:`, error);
    process.exit(1);
  }
}
var program = new Command3();
var commandArgs = process.argv.slice(2);
program.exitOverride();
program.configureOutput({
  writeErr: (text3) => {
    if (!isNotebookJsonInvocation(commandArgs)) process.stderr.write(text3);
  }
});
registerNotebookCli(program);
program.name("pjangler").description("Project subsystem bootstrapper CLI").version(PJANGLER_VERSION);
program.command("init").argument("[name]", "Project name to bootstrap (omit inside an existing git repo)").description("Bootstrap a project: registry entry + CommonProject scaffold + .project.json").option("--description <text>", "Project description").option("--target-dir <path>", "Target repo path").option("--source-skill <path>", "Source skill/template provenance path").option("--primary-language <language>", "Primary language for CommonProject rendering", "python").option("--provision-agent", "Plan local Hermes PM agent provisioning").option("--agent-role <role>", "Hermes agent role to plan when --provision-agent is set", "pm").option("--apply", "Write the registry and render the repo scaffold").option("--dry-run", "Preview changes without writing files (default)").option("--live", "Allow live/network/cloud provisioning actions").option("--slug <slug>", "Project registry slug override").option("--identifier <identifier>", "Ticket identifier override").option("--ticket-provider <type>", "Ticket provider: plane | trello", "plane").option("--board-id <id>", "Board id (Plane project UUID or Trello board id)").option("--board-url <url>", "Deprecated no-op; board URLs are derived from provider + workspace + board-id").option("--workspace <name>", "Ticket workspace/org (Plane workspace; blank for Trello)").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("-f, --force", "Allow replacing an existing registry entry and re-rendering files").option("-y, --yes", "Apply every proposed operation without prompting").option("--no-tui", "Disable interactive prompts").option("--json", "Output machine-parseable JSON").action(async (name, options) => {
  if (name && getRecipeNames().includes(name)) {
    if (!options.json) {
      console.error(`${yellow(glyph.warn)} ${dim(`"pjangler init ${name}" is deprecated \u2014 use "pjangler add ${name}". Forwarding\u2026`)}`);
    }
    await runRecipeSubsystem(name, { force: options.force, dryRun: options.dryRun });
    return;
  }
  await runProjectInit(name, options);
});
program.command("add").argument("<subsystem>", "Subsystem to scaffold (mise, docker, node, agent-hooks, \u2026)").description("Scaffold a subsystem/component into the current repo").option("--dry-run", "Preview changes without writing files").option("-f, --force", "Overwrite existing files").action(async (subsystem, options) => {
  await runRecipeSubsystem(subsystem, options);
});
program.command("list").description("List available subsystems").action(() => {
  const width = Object.keys(RECIPE_REGISTRY).reduce((max, name) => Math.max(max, name.length), 0);
  console.log("");
  console.log(`  ${heading("Available subsystems")}`);
  console.log("");
  for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
    console.log(`  ${cyan(name.padEnd(width))}  ${dim(info.description)}`);
  }
  console.log("");
  console.log(`  ${dim("Examples")}`);
  for (const example of ["pj add mise", "pj add docker", "pj add node"]) {
    console.log(`     ${dim(glyph.pointer)} ${dim(example)}`);
  }
  console.log("");
});
program.command("board").argument("[ref]", "Work item to open (71, PJAN-71); defaults to the current branch's ticket, then the board").description("Open this project's ticket board \u2014 or one work item \u2014 in a browser").option("--print", "Print the resolved URL instead of opening it").action((ref, options) => {
  const url = resolveBoardUrl(process.cwd(), ref);
  if (!url) {
    console.error(`${xmark} No ticket board here: need a .project.json with ticket_provider.board_id`);
    process.exit(1);
  }
  if (options.print) {
    console.log(url);
    return;
  }
  const outcome = openUrl(url);
  console.log(`  ${cyan(glyph.pointer)} ${outcome.display}`);
  if (outcome.reason) console.log(`  ${dim(outcome.reason)}`);
});
var projectCmd = program.command("project").description("Manage the pjangler project registry");
projectCmd.command("init").argument("[name]", "Project display name").description("Plan or apply a registry-backed CommonProject initialization or legacy repo sync").option("--description <text>", "Project description").option("--target-dir <path>", "Target repo path").option("--source-skill <path>", "Source skill/template provenance path").option("--primary-language <language>", "Primary language for CommonProject rendering", "python").option("--provision-agent", "Plan local Hermes PM agent provisioning").option("--agent-role <role>", "Hermes agent role to plan when --provision-agent is set", "pm").option("--apply", "Write the registry and render the repo scaffold").option("--dry-run", "Preview changes without writing files (default)").option("--live", "Allow live/network/cloud provisioning actions").option("--slug <slug>", "Project registry slug override").option("--identifier <identifier>", "Ticket identifier override").option("--ticket-provider <type>", "Ticket provider: plane | trello", "plane").option("--board-id <id>", "Board id (Plane project UUID or Trello board id)").option("--board-url <url>", "Deprecated no-op; board URLs are derived from provider + workspace + board-id").option("--workspace <name>", "Ticket workspace/org (Plane workspace; blank for Trello)").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("-f, --force", "Allow replacing an existing registry entry and re-rendering files").option("-y, --yes", "Apply every proposed operation without prompting").option("--no-tui", "Disable interactive prompts").option("--json", "Output machine-parseable JSON").action((name, options) => {
  if (!options.json) console.error(`${yellow(glyph.warn)} ${dim('"pjangler project init" is deprecated \u2014 use "pjangler init".')}`);
  return runProjectInit(name, options);
});
async function runProjectInit(name, options) {
  try {
    const target = await resolveProjectInitTarget(name, options);
    const interactive = isInteractiveProjectInit(options);
    const apply = Boolean(!options.dryRun && (options.yes || options.apply || interactive));
    const plan = planProjectInit({
      name: target.name,
      description: target.description,
      targetDir: target.targetDir,
      sourceSkill: options.sourceSkill,
      primaryLanguage: options.primaryLanguage,
      provisionAgent: options.provisionAgent ?? false,
      agentRole: options.agentRole,
      apply,
      live: options.live ?? false,
      projectSlug: target.slug,
      projectIdentifier: target.identifier,
      ticketProvider: options.ticketProvider,
      boardId: options.boardId,
      boardUrl: options.boardUrl,
      boardWorkspace: options.workspace,
      registryPath: options.registry,
      force: options.force ?? false,
      overwrite: options.force ?? false,
      cwd: process.cwd(),
      scaffold: !target.syncMode
    });
    const preAudit = target.syncMode ? runAudit(target.targetDir) : void 0;
    const selection = await selectProjectInitOperations({
      plan,
      auditRules: preAudit?.rules ?? [],
      syncMode: target.syncMode,
      options
    });
    const selectedPlanActionKinds = new Set(selection.selectedOperations.filter((value) => !value.startsWith("parity:")));
    const selectedPlan = {
      ...plan,
      apply,
      dryRun: !apply,
      actions: apply ? plan.actions.filter((action) => selectedPlanActionKinds.has(action.kind)) : plan.actions
    };
    if (!apply) {
      const notebookPlan = projectNotebookDryRunProjection(plan, target.syncMode ? "sync" : "create");
      const payload = {
        ...plan,
        mode: target.syncMode ? "sync" : "create",
        audit: preAudit,
        notebookPlan,
        proposedOperations: [
          ...plan.actions.filter((action) => actionNeedsRun(plan, action.kind, target.syncMode)).map((action) => action.kind),
          ...(preAudit?.rules ?? []).filter((rule) => rule.fixable && rule.status !== "pass" && rule.status !== "skip").map((rule) => `parity:${rule.id}`)
        ]
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(formatProjectInitPlan(plan));
        console.log(`  ${bold("Project Notebook")} ${dim(`(${notebookPlan.phases.length} phases)`)}`);
        for (const phase of notebookPlan.phases) {
          console.log(`     ${cyan(glyph.bullet)} ${phase.id} ${dim(`[${phase.scope}/${phase.status}] ${phase.summary}`)}`);
        }
        if (payload.proposedOperations.length) {
          console.log(`  ${bold("Proposed operations")} ${dim(`(${payload.proposedOperations.length})`)}`);
          for (const operation of payload.proposedOperations) console.log(`     ${cyan(glyph.bullet)} ${operation}`);
        } else {
          console.log(`  ${green(glyph.pass)} ${dim("Project is already in parity.")}`);
        }
        console.log("");
      }
      return;
    }
    const projectInput = {
      plan: selectedPlan,
      mode: target.syncMode ? "sync" : "create",
      selectedRuleIds: selection.selectedParityRules,
      selectedOperations: selection.selectedOperations,
      quiet: Boolean(options.json)
    };
    const result2 = await recipeRegistry.initRecipe(
      "project",
      lifecycleContext(target.targetDir, false, false, {
        force: options.force ?? false,
        live: options.live ?? false,
        quiet: Boolean(options.json)
      }),
      projectInput
    );
    if (options.json) {
      console.log(JSON.stringify(result2, null, 2));
    } else {
      console.log(formatProjectInitPlan(selectedPlan));
      for (const line of result2.logs) console.log(line);
      for (const line of result2.errors) console.error(`  ${xmark} ${line}`);
      if (result2.migrationReport) console.log(formatMigrationReport(result2.migrationReport));
      if (result2.ok && result2.changedFiles.length) console.log(`  ${green(glyph.pass)} ${bold("Project synchronized")}  ${dim(glyph.dot)}  ${cyan(plan.project.slug)}
`);
      if (result2.ok && result2.changedFiles.length === 0) console.log(`  ${green(glyph.pass)} ${dim("Already in parity")}  ${dim(glyph.dot)}  ${cyan(plan.project.slug)}
`);
    }
    process.exitCode = result2.ok ? 0 : 1;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
    } else {
      console.error(`${xmark} project init failed:`, err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}
projectCmd.command("list").description("List projects in the pjangler registry").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("--json", "Output machine-parseable JSON").action(async (options) => {
  try {
    const registry = loadProjectRegistry(options.registry ?? projectRegistryPath());
    if (options.json) {
      console.log(JSON.stringify(registry, null, 2));
      return;
    }
    const activity = await computeRepoActivityBatch(
      Object.values(registry.projects).map((project) => project.repo_path)
    );
    console.log(formatProjectList(registry, activity));
  } catch (err) {
    console.error(`${xmark} project list failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
});
projectCmd.command("show").argument("<slug>", "Project slug").description("Show one project from the pjangler registry").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("--json", "Output machine-parseable JSON").action((slug, options) => {
  try {
    const project = getProject(loadProjectRegistry(options.registry ?? projectRegistryPath()), slug);
    if (options.json) {
      console.log(JSON.stringify(project, null, 2));
    } else {
      console.log("");
      console.log(`  ${heading(project.name)} ${dim(`(${project.slug})`)}`);
      console.log(`  ${dim(project.repo_path)}`);
      if (project.description) console.log(`  ${project.description}`);
      console.log("");
    }
  } catch (err) {
    console.error(`${xmark} project show failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
});
projectCmd.command("doctor").argument("[slug]", "Optional project slug").description("Validate the project registry and local projections").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("--json", "Output machine-parseable JSON").action((slug, options) => {
  try {
    const report = doctorProjectRegistry(options.registry ?? projectRegistryPath(), slug);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (!report.issues.length) {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${bold("Project registry OK")}  ${dim(glyph.dot)}  ${dim(report.registryPath)}`);
      console.log("");
    } else {
      console.log("");
      console.log(`  ${red(glyph.fail)} ${bold("Project registry issues")}  ${dim(glyph.dot)}  ${dim(report.registryPath)}`);
      console.log("");
      for (const issue of report.issues) {
        const mark = issue.level === "error" ? red(glyph.fail) : yellow(glyph.warn);
        console.log(`  ${mark}  ${bold(issue.slug ?? "registry")}  ${issue.message}`);
      }
      console.log("");
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`${xmark} project doctor failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
});
var recipeCmd = program.command("recipe").description("Manage pjangler recipes");
recipeCmd.command("list").description("List all available recipes").action(() => {
  console.log("");
  console.log(`  ${heading("Recipes")}`);
  console.log("");
  for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
    console.log(`  ${cyan(bold(name))}`);
    console.log(`     ${dim(info.description)}`);
    console.log(`     ${dim("commands")}  ${info.commands.map((command) => cyan(command)).join(dim(", "))}`);
    console.log("");
  }
  console.log(`  ${dim("Usage")}`);
  console.log(`     ${dim(glyph.pointer)} ${dim("pj recipe run <name>")}`);
  console.log(`     ${dim(glyph.pointer)} ${dim("pj recipe describe <name>")}`);
  console.log("");
});
recipeCmd.command("describe").argument("<name>", "Recipe name").description("Show detailed information about a recipe").action((name) => {
  const info = getRecipeInfo(name);
  if (!info) {
    console.error(`${xmark} Recipe not found: ${bold(name)}`);
    console.error(`  ${dim("Available:")} ${getRecipeNames().map((available) => cyan(available)).join(dim(", "))}`);
    process.exit(1);
  }
  console.log("");
  console.log(`  ${heading(info.name)}`);
  console.log(`  ${dim(info.description)}`);
  console.log("");
  console.log(`  ${bold("Commands")}`);
  for (const command of info.commands) console.log(`     ${cyan(glyph.bullet)} ${command}`);
  console.log("");
  console.log(`  ${dim("Usage")}`);
  console.log(`     ${dim(glyph.pointer)} ${dim(`pj recipe run ${name}`)}`);
  console.log(`     ${dim(glyph.pointer)} ${dim(`pj add ${name}`)}`);
  console.log("");
});
recipeCmd.command("run").argument("<name>", "Recipe name").description("Execute a specific recipe").option("--dry-run", "Preview changes without writing files").option("-f, --force", "Overwrite existing files").action(async (name, options) => {
  await runRecipeSubsystem(name, options);
});
var commandCmd = program.command("command").alias("cmd").description("Manage pjangler commands");
commandCmd.command("list").description("List all available commands").option("-g, --group", "Group commands by category").action((options) => {
  console.log("");
  if (options.group) {
    console.log(`  ${heading("Commands by category")}`);
    for (const [group, commands] of Object.entries(getCommandsByGroup())) {
      const width = commands.reduce((max, command) => Math.max(max, command.name.length), 0);
      console.log("");
      console.log(`  ${bold(group.toUpperCase())}`);
      for (const command of commands) {
        console.log(`     ${cyan(command.name.padEnd(width))}  ${dim(command.description)}`);
      }
    }
    console.log("");
  } else {
    const width = Object.keys(COMMAND_REGISTRY).reduce((max, name) => Math.max(max, name.length), 0);
    console.log(`  ${heading("Commands")}`);
    console.log("");
    for (const [name, info] of Object.entries(COMMAND_REGISTRY)) {
      console.log(`  ${cyan(name.padEnd(width))}  ${dim(info.description)}`);
    }
    console.log("");
  }
  console.log(`  ${dim("Usage")}`);
  console.log(`     ${dim(glyph.pointer)} ${dim("pj command list --group")}     ${dim("# group by category")}`);
  console.log(`     ${dim(glyph.pointer)} ${dim("pj command describe <name>")}  ${dim("# command details")}`);
  console.log("");
});
commandCmd.command("describe").argument("<name>", "Command name").description("Show detailed information about a command").action((name) => {
  const info = getCommandInfo(name);
  if (!info) {
    console.error(`${xmark} Command not found: ${bold(name)}`);
    console.error(`  ${dim("Available:")} ${getCommandNames().map((available) => cyan(available)).join(dim(", "))}`);
    process.exit(1);
  }
  const usedIn = Object.entries(RECIPE_REGISTRY).filter(([, recipeInfo]) => recipeInfo.commands.includes(name)).map(([recipeName]) => recipeName);
  console.log("");
  console.log(`  ${heading(info.name)}`);
  console.log(`  ${dim(info.description)}`);
  console.log("");
  console.log(`  ${dim("group".padEnd(7))} ${cyan(info.group)}`);
  console.log(`  ${dim("recipes".padEnd(7))} ${usedIn.length ? usedIn.map((recipeName) => cyan(recipeName)).join(dim(", ")) : dim("(none)")}`);
  console.log("");
  console.log(`  ${dim("Part of recipe execution (not run directly).")}`);
  console.log("");
});
commandCmd.command("create").argument("<name>", "Command name").argument("<prompt>", "Description of what the command should do").description("Create a new command from template (placeholder for STORY-005)").option("-t, --template <type>", "Template type (toml, json, yaml, dockerfile)").option("-m, --model <model>", "LLM model to use (OpenRouter)").action((name, prompt, options) => {
  console.log("");
  console.log(`  ${yellow(glyph.warn)} ${bold("Command generation coming in STORY-005")}`);
  console.log("");
  console.log(`  ${dim("Planned")}`);
  console.log(`     ${cyan(glyph.bullet)} Generate ${bold(name)} from prompt: ${dim(`"${prompt}"`)}`);
  if (options.template) console.log(`     ${cyan(glyph.bullet)} Template type: ${cyan(options.template)}`);
  if (options.model) console.log(`     ${cyan(glyph.bullet)} LLM model: ${cyan(options.model)}`);
  console.log("");
  console.log(`  ${dim("For now, manually create commands in src/commands/")}`);
  console.log("");
});
program.command("audit").argument("[repo]", "Path to repo to audit (default: cwd)").description("Deterministic parity audit against 33god project standard").option("--profile <profile>", "Audit profile, e.g. momo-lifecycle-plane (opt-in; does not affect default audit)").option("--live", "Run credentialed live checks for supported profiles (only affects supported profiles such as momo-lifecycle-plane)").option("--json", "Output machine-parseable JSON").action((repo, options) => {
  try {
    const profile = options.profile;
    const live = options.live ?? false;
    if (profile === "momo-lifecycle-plane") {
      const report2 = runMomoReadinessAudit(repo, live);
      if (options.json) {
        console.log(JSON.stringify(report2, null, 2));
      } else {
        console.log(formatMomoReadinessReport(report2));
      }
      process.exit(report2.ready ? 0 : 1);
    }
    if (profile) {
      console.error(`${xmark} Unknown audit profile: ${bold(profile)}`);
      process.exit(1);
    }
    const report = runAudit(repo);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatAuditReport(report));
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`${xmark} audit failed:`, err);
    process.exit(1);
  }
});
program.command("migrate").argument("[rule-id]", "Rule ID to migrate (omit to open interactive rule selector)").argument("[repo]", "Path to repo (default: cwd)").description("Idempotent migration recipe for a parity rule (or open the rule selector)").option("--all", "Apply every migration recipe in order").option("--dry-run", "Preview changes without writing files").option(
  "--accept-registry-matches",
  "Apply the proposed mapping of legacy committed .agents/skills entries into .agents/skills.json (reported only by default)"
).option("--json", "Output machine-parseable JSON").action(async (ruleId, repo, options) => {
  try {
    const all = options.all ?? false;
    const dryRun = options.dryRun ?? false;
    const acceptRegistryMatches = options.acceptRegistryMatches ?? false;
    if (all) {
      let actualRepo = repo;
      if (ruleId && !actualRepo) {
        actualRepo = ruleId;
      }
      const report2 = runMigration(void 0, actualRepo, dryRun, true, acceptRegistryMatches);
      printMigrationReport(report2, options.json);
      process.exit(report2.ok ? 0 : 1);
    }
    if (ruleId && repo) {
      if (!getParityRuleIds().includes(ruleId)) {
        console.error(`${xmark} Unknown parity rule: ${bold(ruleId)}`);
        process.exit(1);
      }
      const report2 = runMigration(ruleId, repo, dryRun, false, acceptRegistryMatches);
      printMigrationReport(report2, options.json);
      process.exit(report2.ok ? 0 : 1);
    }
    if (ruleId && getParityRuleIds().includes(ruleId)) {
      const report2 = runMigration(ruleId, void 0, dryRun, false, acceptRegistryMatches);
      printMigrationReport(report2, options.json);
      process.exit(report2.ok ? 0 : 1);
    }
    if (options.json) {
      console.error(`${xmark} JSON output requires a rule-id or --all`);
      process.exit(1);
    }
    if (!process.stdin.isTTY) {
      console.error(`${xmark} Provide a rule-id, use --all, or run in an interactive terminal`);
      process.exit(1);
    }
    const targetRepo = ruleId ?? repo;
    const audit = runAudit(targetRepo);
    const ruleIds = await promptForRuleIds(audit.rules);
    if (!ruleIds.length) {
      console.log(`  ${cyan(glyph.info)} ${dim("No rules selected; nothing to migrate.")}`);
      process.exit(0);
    }
    const report = runMigrationForRules(ruleIds, targetRepo, dryRun, acceptRegistryMatches);
    printMigrationReport(report, false);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`${xmark} migrate failed:`, err);
    process.exit(1);
  }
});
program.command("hermes-agent").alias("hermes").description("Provision the PM agent for the current repo (defaults everything; only asks about Telegram)").option("-y, --yes", "Non-interactive: accept all defaults (also skips the Telegram prompt)").option("--target-repo <name>", "Target repo name (default: basename of cwd)").option("--role <role>", "Agent role override (default: pm \u2014 the only role in the fleet)").option("--purpose <text>", 'One-line agent purpose (default: "pm agent for <repo>")').option(`--tone <tone>`, `Personality tone (default: direct; ${SOUL_TONES.join(" | ")})`).option("--model-provider <name>", 'Inference provider override ("" = inherit shared default profile)').option("--model-name <name>", 'Model name override ("" = inherit shared default profile)').option("--model-base-url <url>", 'Inference API base URL override ("" = inherit shared default profile)').option("--model-api-mode <mode>", 'Inference API mode override ("" = inherit shared default profile)').option("--model-key-env <name>", "Environment variable name holding the scoped model credential").option("--skip-telegram", "Skip the Telegram wire-up (no BotFather prompt)").option("--email", "Also provision the delo.sh email address (off by default; never prompted)").option("--skip-runtime-repo", "Skip creating the per-agent runtime GH repo").option("--skip-plane", "Skip creating or linking the ticket board").option("--skip-bloodbank", "Deprecated compatibility flag; Bloodbank now uses one fleet-shared Hermes gateway").option("--skip-systemd", "Skip installing systemd --user units").option("--local", "Local-only: skip runtime repo, ticket-board creation, Bloodbank, and systemd (safe for laptops/macOS/non-technical operators)").option("--force-config", "Regenerate ~/.config/hermes-agent-template/config.toml even if it exists").option("--dry-run", "Preview what would run; don't execute copier").option("-f, --force", "Re-render even if agents/hermes/<role>/role.yaml already exists").action(async (options) => {
  const isDarwin = process.platform === "darwin";
  const local = options.local ?? false;
  const context = {
    targetDir: process.cwd(),
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    yes: options.yes ?? false,
    local,
    forceConfig: options.forceConfig ?? false,
    targetRepo: options.targetRepo,
    role: options.role,
    agentPurpose: options.purpose,
    soulTone: options.tone,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
    modelBaseUrl: options.modelBaseUrl,
    modelApiMode: options.modelApiMode,
    modelKeyEnv: options.modelKeyEnv,
    skipTelegram: options.skipTelegram,
    // Email is opt-in only: `--email` wires it, otherwise it's never done.
    skipEmail: options.email ? false : void 0,
    // --local (and macOS, for systemd) flip the heavy/irreversible steps off
    // by default so a non-technical operator can't accidentally create cloud
    // resources under the wrong account or hit systemd on a Mac. An explicit
    // --skip-* still forces the skip; passing neither + not --local keeps the
    // full provisioning behavior for the authoring machine.
    skipRuntimeRepo: options.skipRuntimeRepo ?? local,
    skipPlane: options.skipPlane ?? local,
    skipBloodbank: options.skipBloodbank ?? local,
    skipSystemd: options.skipSystemd ?? (local || isDarwin)
  };
  try {
    const lifecycle = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, context);
    const result2 = await recipeRegistry.initRecipe("hermes-agent", lifecycle, {});
    for (const line of result2.logs) console.log(line);
    for (const error of result2.errors) console.error(`${xmark} ${error}`);
    if (!result2.ok) process.exit(1);
  } catch (err) {
    console.error(`${xmark} hermes-agent failed:`, err);
    process.exit(1);
  }
});
var configCmd = program.command("config").description("Manage host/provisioner configuration");
configCmd.command("bootstrap").description("Create ~/.config/hermes-agent-template/config.toml with host-correct defaults if missing").option("--force", "Overwrite an existing config file").option("--dry-run", "Show what would be written without writing").action(async (options) => {
  const ctx = {
    targetDir: process.cwd(),
    dryRun: options.dryRun ?? false,
    forceConfig: options.force ?? false
  };
  const result2 = await new EnsureTemplateConfig(ctx).invoke();
  if (!result2.success) {
    if (result2.message) console.error(result2.message);
    process.exit(1);
  }
});
program.command("describe").argument("[repo]", "Path to the repo to describe (default: cwd)").description("Describe the current project (for AI context)").option("--registry <path>", `Registry path override (default: ${projectRegistryPath()})`).option("--json", "Output machine-parseable JSON").option("-i, --interactive", "Tick off fixable findings and apply them").action(async (repo, options) => {
  try {
    const description = describeProject({ repoArg: repo, registryPath: options.registry });
    if (options.json) {
      if (options.interactive) {
        console.error(`${xmark} --interactive cannot be combined with --json`);
        process.exit(1);
      }
      console.log(JSON.stringify(description, null, 2));
      return;
    }
    console.log(formatProjectDescription(description));
    if (!options.interactive) return;
    if (!process.stdin.isTTY) {
      console.error(`${xmark} --interactive needs a TTY; use \`pjangler migrate --all\` non-interactively`);
      process.exit(1);
    }
    const fixable = description.subsystems.flatMap((subsystem) => subsystem.rules).filter((rule) => (rule.status === "fail" || rule.status === "warn") && rule.fixable);
    if (!fixable.length) {
      console.log(`  ${green(glyph.pass)} ${dim("Nothing fixable to apply.")}`);
      return;
    }
    const result2 = await runChecklist({
      items: fixable.map((rule) => ({ id: rule.id, title: rule.id, detail: rule.summary })),
      title: "Select parity migrations to apply"
    });
    if (result2.outcome === "cancel" || !result2.selected.length) {
      console.log(`  ${dim("Nothing applied.")}`);
      return;
    }
    const report = runMigrationForRules(result2.selected, description.repo, false);
    printMigrationReport(report, false);
    if (!report.ok) process.exit(1);
  } catch (err) {
    console.error(`${xmark} describe failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
});
try {
  await program.parseAsync();
} catch (error) {
  if (isNotebookJsonInvocation(commandArgs)) {
    const envelope = notebookParserFailureEnvelope(commandArgs);
    process.stdout.write(renderNotebookJson(envelope));
    process.exitCode = notebookEnvelopeExitCode(envelope);
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
