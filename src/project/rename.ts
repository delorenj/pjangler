// `pj project rename <old> <new>` (PJAN-199): one key is the project's identity.
//
// A project carries a lowercase registry `project_id` and an uppercase board
// identifier that used to be spelled independently (`tower-of-lost-things` vs
// `TOWE`). Rename makes the NEW key both: `project_id = <new>` and the board
// identifier `= <NEW>`. Repo path, project name, board UUID and workspace never
// change; neither do Hermes agent ids, Hindsight banks or historical events.
//
// Write order is the design. Plane is first because it is the step most likely
// to be refused (identifier taken, permission) and the cheapest to leave
// untouched; once it succeeds every later step is local and retryable. Then the
// repo manifest, then the registry index, then downstream references. Every step
// first asks "is this already true?", so a re-run after a partial failure
// converges: Plane already showing `NEW` is success, not an error.

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import YAML from "yaml";
import { DEFAULT_PLANE_WORKSPACE } from "./boardUrl";
import {
  atomicWrite,
  fetchPlaneBoards,
  fetchTrelloBoard,
  hermesAgentsRegistryPath,
  liveKeyIndex,
  patchPlaneBoardIdentifier,
  reconcileProjectIdentity,
  readHermesAgentBoards,
  type PlaneBoardFacts,
  type TrelloBoardFacts,
} from "./identity";
import {
  getOwnRecordValue,
  isRegistryServiceLocation,
  loadProjectRegistry,
  resolveRegistryLocation,
  saveProjectRegistry,
  type ProjectRecord,
  type ProjectRegistry,
} from "./index";
import { registryRequest } from "./registryClient";

/** Plane identifiers are alphanumeric and at most 12 characters. */
const KEY_PATTERN = /^[a-z0-9]{1,12}$/;

export type RenameErrorCode =
  | "invalid_key"
  | "unknown_project"
  | "identity_collision"
  | "board_archived"
  | "board_not_found"
  | "provider_unreachable"
  | "registry_unavailable"
  | "manifest_missing"
  | "manifest_invalid";

/** A refusal: raised before any write, carries the machine code. */
export class RenameError extends Error {
  constructor(public readonly code: RenameErrorCode, message: string) {
    super(message);
    this.name = "RenameError";
  }
}

export type RenameStepStatus = "planned" | "done" | "already" | "skipped" | "blocked" | "failed";

export interface RenameStep {
  step: string;
  status: RenameStepStatus;
  detail: string;
}

export interface RenameResult {
  ok: boolean;
  apply: boolean;
  /** True when nothing needs to change (or changed): old and new already agree everywhere. */
  noop: boolean;
  /** True when the registry no longer knows `old` but already carries `new`, and only follow-up steps remained. */
  resumed: boolean;
  oldId: string;
  newId: string;
  oldIdentifier: string;
  newIdentifier: string;
  provider: string;
  workspace: string;
  boardId: string;
  registryPath: string;
  steps: RenameStep[];
  warnings: string[];
  changedFiles: string[];
  error?: string;
  code?: string;
}

export interface RenameOptions {
  oldId: string;
  newId: string;
  apply?: boolean;
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: Date;
  /** Test seam: list a Plane workspace's boards without the network. */
  fetchBoards?: (workspace: string) => Promise<Map<string, PlaneBoardFacts>>;
  /** Test seam: rename a Plane board's identifier without the network. */
  patchBoard?: (workspace: string, boardId: string, identifier: string) => Promise<void>;
  /** Test seam: confirm a Trello board without the network. */
  fetchTrello?: (boardId: string) => Promise<TrelloBoardFacts | null>;
}

interface Outcome {
  status: RenameStepStatus;
  detail: string;
  files?: string[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJsonObject(path: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RenameError("manifest_invalid", `${path} is not readable JSON; fix it before renaming`);
  }
  if (!isRecord(parsed)) throw new RenameError("manifest_invalid", `${path} must hold a JSON object`);
  return parsed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words a plain YAML scalar must not be, whatever the schema's mood. */
const YAML_WORDS = new Set(["Y", "N", "YES", "NO", "ON", "OFF", "NULL", "TRUE", "FALSE"]);

function yamlScalarFor(identifier: string, originalSlice: string): string {
  const plainSafe = /^[A-Z][A-Z0-9]*$/.test(identifier) && !YAML_WORDS.has(identifier);
  if (originalSlice.startsWith("'") && !originalSlice.startsWith("''")) return `'${identifier}'`;
  if (originalSlice.startsWith('"')) return `"${identifier}"`;
  return plainSafe ? identifier : `"${identifier}"`;
}

/**
 * Rename a project's identity across the board provider, manifest, registry
 * index and the files that quote the old key. Dry run unless `apply`.
 *
 * Refusals (`RenameError`) are raised before anything is written. Once writes
 * start, failures are reported per step in the result instead of thrown, and
 * `ok` is false.
 */
export async function renameProject(options: RenameOptions): Promise<RenameResult> {
  const newId = String(options.newId ?? "").trim().toLowerCase();
  if (!KEY_PATTERN.test(newId)) {
    throw new RenameError(
      "invalid_key",
      `invalid key ${JSON.stringify(String(options.newId ?? ""))}: use 1-12 lowercase letters and digits (Plane identifiers are alphanumeric, max 12)`,
    );
  }
  const NEW = newId.toUpperCase();
  const oldInput = String(options.oldId ?? "").trim().toLowerCase();
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const apply = options.apply ?? false;
  const now = (options.now ?? new Date()).toISOString();
  const registryPath = resolveRegistryLocation(options.registryPath, env);
  const service = isRegistryServiceLocation(registryPath);
  const warnings: string[] = [];

  let registry: ProjectRegistry;
  try {
    registry = loadProjectRegistry(registryPath);
  } catch (error) {
    throw new RenameError("registry_unavailable", message(error));
  }

  // ---- identity: who is being renamed ------------------------------------
  let oldId = oldInput;
  let resumed = false;
  let renamedFromIdentifier = "";
  let project: ProjectRecord | undefined = oldInput ? getOwnRecordValue(registry.projects, oldInput) : undefined;
  if (project) {
    if (oldInput !== newId && getOwnRecordValue(registry.projects, newId)) {
      throw new RenameError("identity_collision", `project_id "${newId}" is already registered to another project`);
    }
  } else {
    // The index may already have followed an earlier, interrupted run (the
    // service re-reads manifests), leaving only follow-up steps. That is a
    // resume only when the new id's manifest proves it was renamed FROM this
    // old id (`renamed_from`, written by the manifest step); anything else is a
    // wrong old id and must not report success.
    const existing = getOwnRecordValue(registry.projects, newId);
    let from: Json | undefined;
    if (existing && oldInput) {
      try {
        const candidate = readJsonObject(join(existing.repo_path, ".project.json")).renamed_from;
        if (isRecord(candidate)) from = candidate;
      } catch { /* no readable manifest, no provenance */ }
    }
    if (!existing || !from || from.project_id !== oldInput) {
      throw new RenameError("unknown_project", `Project not found in registry: ${options.oldId}`);
    }
    project = existing;
    resumed = true;
    renamedFromIdentifier = typeof from.identifier === "string" ? from.identifier : "";
  }
  const record: ProjectRecord = project;
  const provider = record.ticket_provider;
  const type = String(provider.type ?? "").trim().toLowerCase();
  const boardId = String(provider.board_id ?? "").trim();
  const isPlane = type === "plane";
  const workspace = isPlane ? String(provider.workspace ?? "").trim() || DEFAULT_PLANE_WORKSPACE : String(provider.workspace ?? "").trim();
  const repoPath = record.repo_path;
  const manifestPath = join(repoPath, ".project.json");

  // ---- the manifest: read before any write --------------------------------
  const manifestExists = existsSync(manifestPath);
  if (service && !manifestExists) {
    throw new RenameError("manifest_missing", `${manifestPath} is missing; the registry service indexes manifests, so there is nothing to rename`);
  }
  const manifestBefore = manifestExists ? readJsonObject(manifestPath) : undefined;

  // ---- the provider: live reads before any write --------------------------
  const fetchBoards = options.fetchBoards ?? ((ws: string) => fetchPlaneBoards(ws, env, home));
  let live: PlaneBoardFacts | undefined;
  if (isPlane && boardId) {
    let boards: Map<string, PlaneBoardFacts>;
    try {
      boards = await fetchBoards(workspace);
    } catch (error) {
      throw new RenameError("provider_unreachable", message(error));
    }
    live = boards.get(boardId);
    if (!live) throw new RenameError("board_not_found", `Plane workspace "${workspace}" has no board ${boardId}`);
    if (live.archived) {
      throw new RenameError("board_archived", `Plane board ${boardId} ("${live.name}") is archived; an archived board answers but is not usable`);
    }
    const owner = liveKeyIndex(boards).get(NEW);
    if (owner && owner.id !== boardId) {
      throw new RenameError("identity_collision", `board identifier ${NEW} already belongs to Plane board ${owner.id} ("${owner.name}") in workspace "${workspace}"`);
    }
  } else if (type === "trello" && boardId) {
    try {
      const facts = await (options.fetchTrello ?? ((id: string) => fetchTrelloBoard(id, env, home)))(boardId);
      if (!facts) throw new RenameError("board_not_found", `Trello has no visible board ${boardId}`);
      if (facts.closed) throw new RenameError("board_archived", `Trello board ${boardId} ("${facts.name}") is archived`);
    } catch (error) {
      if (error instanceof RenameError) throw error;
      // Trello assigns no key, so nothing here depends on it; a missing
      // credential must not block a purely local rename.
      warnings.push(`Trello board ${boardId} could not be verified (${message(error)}); renamed locally`);
    }
  }

  // Every spelling the old key may carry in a file or record.
  const manifestProvider = manifestBefore?.ticket_provider;
  const manifestIdentifier = isRecord(manifestProvider) ? String(manifestProvider.identifier ?? "") : "";
  const oldIdentifiers = [
    ...new Set(
      [String(provider.identifier ?? ""), manifestIdentifier, live?.identifier ?? "", renamedFromIdentifier]
        .map((value) => value.trim())
        .filter((value) => value && value.toUpperCase() !== NEW),
    ),
  ];
  const oldIdentifier = oldIdentifiers[0] ?? "";
  const providerConfirmed = isPlane && Boolean(boardId);

  /** The ticket_provider block as it must read after the rename. */
  function nextProvider(current: Json): Json {
    // A block that never carried a key (and has no board to read one from) has
    // nothing to rename; do not invent one.
    if (!current.identifier && !providerConfirmed) return current;
    const next: Json = { ...current, identifier: NEW };
    if (providerConfirmed) {
      const unchanged = String(current.identifier ?? "").toUpperCase() === NEW
        && current.identifier_source === "provider"
        && typeof current.identifier_fetched_at === "string"
        && current.identifier_fetched_at !== "";
      next.identifier_source = "provider";
      next.identifier_fetched_at = unchanged ? current.identifier_fetched_at : now;
    }
    return next;
  }

  const planeCall = options.patchBoard ?? ((ws: string, id: string, identifier: string) => patchPlaneBoardIdentifier(ws, id, identifier, env, home));

  // ---- steps ----------------------------------------------------------------
  const planeStep = async (doApply: boolean): Promise<Outcome> => {
    if (!isPlane) return { status: "skipped", detail: type === "trello" ? "trello assigns no key; no provider write" : "no Plane board; no provider write" };
    if (!boardId || !live) return { status: "skipped", detail: "no board bound; nothing to rename at the provider" };
    if (live.identifier.toUpperCase() === NEW) return { status: "already", detail: `board ${boardId} already reads ${live.identifier}` };
    if (!doApply) return { status: "planned", detail: `Plane board ${boardId}: ${live.identifier} -> ${NEW}` };
    let patchError: string | undefined;
    try {
      await planeCall(workspace, boardId, NEW);
    } catch (error) {
      patchError = message(error);
    }
    // A 2xx is a claim and a thrown PATCH (a timeout, say) may still have
    // applied. Read the board back before deciding either way.
    try {
      const after = (await fetchBoards(workspace)).get(boardId);
      if (after && after.identifier.toUpperCase() === NEW) {
        return { status: "done", detail: `Plane board ${boardId}: ${live.identifier} -> ${NEW}${patchError ? ` (the PATCH reported: ${patchError})` : ""}` };
      }
      if (patchError) {
        return { status: "failed", detail: `${patchError}; the board still reads ${after?.identifier ?? "(missing)"}, but the request may yet land: re-running is safe` };
      }
      return { status: "failed", detail: `Plane accepted the rename but board ${boardId} reads ${after?.identifier ?? "(missing)"}` };
    } catch (error) {
      return {
        status: "failed",
        detail: `${patchError ? `${patchError}; ` : ""}the read-back failed (${message(error)}), so the outcome is unknown; re-running is safe`,
      };
    }
  };

  const manifestStep = async (doApply: boolean): Promise<Outcome> => {
    if (!manifestExists) return { status: "skipped", detail: `no .project.json at ${repoPath}` };
    let current: Json;
    try {
      current = readJsonObject(manifestPath);
    } catch (error) {
      return { status: "failed", detail: message(error) };
    }
    const next: Json = { ...current, project_id: newId };
    delete next.project_slug;
    if (isRecord(current.ticket_provider)) next.ticket_provider = nextProvider(current.ticket_provider);
    // Rename provenance: what a later resume needs to know the project used to
    // be. A resumed run keeps what the first run wrote; a repeat of the same
    // rename keeps its original timestamp; a second rename overwrites.
    if (!resumed && (oldId !== newId || oldIdentifier !== "")) {
      const previous = current.renamed_from;
      const same = isRecord(previous) && previous.project_id === oldId && String(previous.identifier ?? "") === oldIdentifier;
      next.renamed_from = same
        ? previous
        : { project_id: oldId, ...(oldIdentifier ? { identifier: oldIdentifier } : {}), at: now };
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { status: "already", detail: `project_id ${newId}, identifier ${NEW}` };
    }
    const detail = `project_id ${String(current.project_id ?? current.project_slug ?? "(none)")} -> ${newId}, identifier -> ${NEW}`;
    if (!doApply) return { status: "planned", detail, files: [manifestPath] };
    try {
      atomicWrite(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      return { status: "failed", detail: `could not write ${manifestPath}: ${message(error)}` };
    }
    return { status: "done", detail, files: [manifestPath] };
  };

  const registryStep = async (doApply: boolean): Promise<Outcome> => {
    const identifierNow = (r: ProjectRecord | undefined) => String(r?.ticket_provider?.identifier ?? "").toUpperCase();
    const keyed = getOwnRecordValue(registry.projects, newId);
    const keyedIdentifier = identifierNow(keyed);
    const settled = Boolean(keyed) && (oldId === newId || !getOwnRecordValue(registry.projects, oldId))
      && (keyedIdentifier === NEW || (keyedIdentifier === "" && !providerConfirmed));
    if (settled) return { status: "already", detail: `registry already keys ${newId}` };
    const detail = `${oldId} -> ${newId}${service ? " (service re-index)" : ""}`;
    if (!doApply) return { status: "planned", detail };
    try {
      if (service) {
        registryRequest(registryPath, "POST", "/v1/index", { manifest_path: manifestPath });
        const after = loadProjectRegistry(registryPath);
        if (!getOwnRecordValue(after.projects, newId)) throw new Error(`the service index does not list ${newId} after re-indexing`);
        if (oldId !== newId && getOwnRecordValue(after.projects, oldId)) throw new Error(`the service index still lists ${oldId} after re-indexing`);
      } else {
        const fresh = loadProjectRegistry(registryPath);
        const current = getOwnRecordValue(fresh.projects, oldId);
        if (!current) throw new Error(`${oldId} vanished from ${registryPath} mid-rename`);
        const renamed: ProjectRecord = {
          ...current,
          slug: newId,
          ...(Object.hasOwn(current, "project_id") ? { project_id: newId } : {}),
          ticket_provider: nextProvider(current.ticket_provider as unknown as Json) as unknown as ProjectRecord["ticket_provider"],
          updated_at: now,
        };
        delete fresh.projects[oldId];
        fresh.projects[newId] = renamed;
        saveProjectRegistry(fresh, registryPath);
      }
    } catch (error) {
      return { status: "failed", detail: message(error) };
    }
    return { status: "done", detail, files: service ? [] : [registryPath] };
  };

  const roleStep = async (doApply: boolean): Promise<Outcome> => {
    const hermesDir = join(repoPath, "agents", "hermes");
    if (!existsSync(hermesDir)) return { status: "skipped", detail: "no agents/hermes directory" };
    if (!isPlane) return { status: "skipped", detail: "role.yaml plane.identifier is a Plane field" };
    const files: string[] = [];
    let touched = 0;
    let settled = 0;
    let entries: Dirent[];
    try {
      entries = readdirSync(hermesDir, { withFileTypes: true });
    } catch (error) {
      return { status: "failed", detail: `${hermesDir}: ${message(error)}` };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(hermesDir, entry.name, "role.yaml");
      if (!existsSync(path)) continue;
      try {
        const original = readFileSync(path, "utf8");
        const document = YAML.parseDocument(original);
        if (document.errors.length) throw new Error("YAML is invalid");
        const node = document.getIn(["plane", "identifier"], true) as unknown;
        if (!YAML.isScalar(node) || !node.range) continue;
        if (String(node.value) === NEW) { settled += 1; continue; }
        touched += 1;
        files.push(path);
        if (!doApply) continue;
        // Splice the one scalar: a document round-trip would reflow comments.
        const [start, end] = node.range;
        const text = `${original.slice(0, start)}${yamlScalarFor(NEW, original.slice(start, end))}${original.slice(end)}`;
        const before = document.toJS() as Json;
        const after = YAML.parse(text) as Json;
        if (isRecord(before.plane)) before.plane.identifier = NEW;
        if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the edit changed more than plane.identifier");
        atomicWrite(path, text);
      } catch (error) {
        return { status: "failed", detail: `${path}: ${message(error)}` };
      }
    }
    if (!touched && !settled) return { status: "skipped", detail: "no role.yaml carries plane.identifier" };
    if (!touched) return { status: "already", detail: `${settled} role.yaml already read ${NEW}` };
    return { status: doApply ? "done" : "planned", detail: `${touched} role.yaml: plane.identifier -> ${NEW}`, files };
  };

  const fleetStep = async (doApply: boolean): Promise<Outcome> => {
    if (!isPlane || !boardId) return { status: "skipped", detail: "no Plane board bound" };
    const hermesPath = hermesAgentsRegistryPath(env, home);
    if (!existsSync(hermesPath)) return { status: "skipped", detail: `no fleet registry at ${hermesPath}` };
    try {
      const bound = readHermesAgentBoards(hermesPath).filter((agent) => agent.boardId === boardId);
      if (!bound.length) return { status: "skipped", detail: "no fleet agent is bound to this board" };
      const stale = bound.filter((agent) => agent.identifier !== NEW);
      if (!stale.length) return { status: "already", detail: `${bound.length} fleet agent(s) already read ${NEW}` };
      if (!doApply) return { status: "planned", detail: `${stale.length} fleet agent(s): plane.identifier -> ${NEW} (${hermesPath})`, files: [hermesPath] };
      const report = await reconcileProjectIdentity({
        target: newId,
        apply: true,
        hermesRegistryPath: hermesPath,
        registryPath,
        env,
        home,
        now: new Date(now),
        ...(options.fetchBoards ? { fetchBoards: options.fetchBoards } : {}),
      });
      if (!report.ok) return { status: "failed", detail: report.errors.join("; ") || "identity reconcile reported errors" };
      // Trust the file, not the reconcile's change count.
      const lagging = readHermesAgentBoards(hermesPath).filter((agent) => agent.boardId === boardId && agent.identifier !== NEW);
      if (lagging.length) {
        return { status: "failed", detail: `fleet agent(s) still read another identifier: ${lagging.map((agent) => `${agent.agentId} (${agent.identifier || "empty"})`).join(", ")}` };
      }
      return { status: "done", detail: `${stale.length} fleet agent(s): plane.identifier -> ${NEW} (${hermesPath})`, files: [hermesPath] };
    } catch (error) {
      return { status: "failed", detail: message(error) };
    }
  };

  const agentsMdStep = async (doApply: boolean): Promise<Outcome> => {
    const link = join(repoPath, "AGENTS.md");
    if (!existsSync(link)) return { status: "skipped", detail: "no AGENTS.md" };
    try {
      const path = realpathSync(link);
      const inside = relative(realpathSync(repoPath), path);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        return { status: "skipped", detail: `AGENTS.md resolves outside the repo (${path}); left untouched` };
      }
      const original = readFileSync(path, "utf8");
      const lines = original.split("\n");
      let boardLines = 0;
      let replaced = 0;
      let current = 0;
      const out = lines.map((line) => {
        if (!/^\s*Board:/.test(line)) return line;
        boardLines += 1;
        if (line.includes(`(${NEW})`)) current += 1;
        let next = line;
        for (const old of oldIdentifiers) {
          const swapped = next.replace(new RegExp(`\\(${escapeRegExp(old)}\\)`, "g"), `(${NEW})`);
          if (swapped !== next) { replaced += 1; next = swapped; }
        }
        return next;
      });
      if (!boardLines) return { status: "skipped", detail: "AGENTS.md has no Board: line" };
      if (!replaced) {
        return current
          ? { status: "already", detail: `Board: line already reads (${NEW})` }
          : { status: "skipped", detail: `no (${oldIdentifier || "OLD"}) on the Board: line` };
      }
      if (doApply) atomicWrite(path, out.join("\n"));
      return { status: doApply ? "done" : "planned", detail: `Board: (${oldIdentifier}) -> (${NEW})`, files: [path] };
    } catch (error) {
      return { status: "failed", detail: message(error) };
    }
  };

  const hintsStep = async (doApply: boolean): Promise<Outcome> => {
    const configDir = env.PILOT_CONFIG_DIR?.trim() || join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "pilot");
    const path = join(configDir, "harvest", "project-hints.json");
    if (!existsSync(path)) return { status: "skipped", detail: `no harvest hints at ${path}` };
    try {
      const hints = readJsonObject(path);
      const projects = hints.projects;
      if (!isRecord(projects)) return { status: "skipped", detail: "hints file has no projects map" };
      if (oldId === newId || !Object.hasOwn(projects, oldId)) {
        return Object.hasOwn(projects, newId)
          ? { status: "already", detail: `hints already keyed ${newId}` }
          : { status: "skipped", detail: `no hints entry for ${oldId}` };
      }
      const collides = Object.hasOwn(projects, newId);
      const detail = collides
        ? `projects.${oldId} merged into the existing projects.${newId}; "${oldId}" kept as an alias`
        : `projects.${oldId} -> projects.${newId}, "${oldId}" kept as an alias`;
      if (!doApply) return { status: "planned", detail, files: [path] };
      const aliasesOf = (value: unknown): string[] => (isRecord(value) && Array.isArray(value.aliases) ? value.aliases.map(String) : []);
      const moved = projects[oldId];
      const base: Json = collides ? (isRecord(projects[newId]) ? { ...(projects[newId] as Json) } : {}) : (isRecord(moved) ? { ...moved } : {});
      base.aliases = [...new Set([...aliasesOf(collides ? projects[newId] : moved), ...(collides ? aliasesOf(moved) : []), oldId])];
      const rekeyed: Json = {};
      for (const [key, value] of Object.entries(projects)) {
        if (key === oldId) { if (!collides) rekeyed[newId] = base; }
        else if (key === newId) rekeyed[newId] = base;
        else rekeyed[key] = value;
      }
      atomicWrite(path, `${JSON.stringify({ ...hints, projects: rekeyed }, null, 2)}\n`);
      return { status: "done", detail, files: [path] };
    } catch (error) {
      return { status: "failed", detail: message(error) };
    }
  };

  const candystoreStep = async (doApply: boolean): Promise<Outcome> => {
    // `rename tolt tolt` on a finished project is a no-op: do not poke the
    // projection. Any other invocation re-syncs, which is also how a run that
    // failed at this very step is completed.
    if (oldInput === newId && steps.every((step) => step.status === "already" || step.status === "skipped")) {
      return { status: "already", detail: "nothing changed; projection not re-synced" };
    }
    const cwd = join(home, "code", "33GOD", "candystore");
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      return { status: "skipped", detail: `no candystore checkout at ${cwd}` };
    }
    if (!doApply) return { status: "planned", detail: `mise run project:sync in ${cwd}` };
    const run = spawnSync("mise", ["run", "project:sync"], { cwd, env, shell: false, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    if (run.error) {
      return (run.error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "skipped", detail: "mise is not installed; run `mise run project:sync` in candystore" }
        : { status: "failed", detail: `mise run project:sync: ${run.error.message}` };
    }
    if (run.status !== 0) {
      const tail = `${run.stderr ?? ""}${run.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
      return { status: "failed", detail: `mise run project:sync exited ${run.status}${tail ? `: ${tail}` : ""}` };
    }
    return { status: "done", detail: "candystore project projection re-synced" };
  };

  // ---- run -----------------------------------------------------------------
  const steps: RenameStep[] = [];
  const changedFiles: string[] = [];
  const note = (step: string, outcome: Outcome) => {
    steps.push({ step, status: outcome.status, detail: outcome.detail });
    if (outcome.status === "done" || outcome.status === "planned") changedFiles.push(...(outcome.files ?? []));
  };

  // The critical chain stops at its first failure: a local step must never get
  // ahead of the provider, and the index must never get ahead of the manifest.
  const critical: Array<[string, (doApply: boolean) => Promise<Outcome>]> = [
    ["plane", planeStep],
    ["manifest", manifestStep],
    ["registry", registryStep],
  ];
  let blockedBy: string | undefined;
  for (const [name, run] of critical) {
    if (blockedBy) {
      note(name, { status: "blocked", detail: `not attempted: ${blockedBy} failed` });
      continue;
    }
    const outcome = await run(apply);
    note(name, outcome);
    if (outcome.status === "failed") blockedBy = name;
  }
  const downstream: Array<[string, (doApply: boolean) => Promise<Outcome>]> = [
    ["role.yaml", roleStep],
    ["fleet-registry", fleetStep],
    ["AGENTS.md", agentsMdStep],
    ["harvest-hints", hintsStep],
    ["candystore", candystoreStep],
  ];
  for (const [name, run] of downstream) {
    if (blockedBy) note(name, { status: "blocked", detail: `not attempted: ${blockedBy} failed` });
    else note(name, await run(apply));
  }

  const changed = (name: string) => steps.some((step) => step.step === name && (step.status === "done" || step.status === "planned"));
  if (oldId !== newId && (changed("manifest") || changed("registry"))) {
    warnings.push("notebook state is keyed by the project hash and restarts fresh under the new id");
  }
  if (isPlane && changed("plane")) {
    warnings.push(`old ticket refs (${oldIdentifier || "OLD"}-n) stop resolving once the board prefix changes`);
  }
  const insideRepo = (file: string) => {
    const rel = relative(repoPath, file);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (changedFiles.some(insideRepo)) {
    warnings.push(`files changed inside ${repoPath} must be committed and pushed`);
  }

  const failed = steps.find((step) => step.status === "failed");
  const noop = steps.every((step) => step.status === "already" || step.status === "skipped");
  const result: RenameResult = {
    ok: !failed,
    apply,
    noop,
    resumed,
    oldId,
    newId,
    oldIdentifier,
    newIdentifier: NEW,
    provider: type || "none",
    workspace,
    boardId,
    registryPath,
    steps,
    warnings,
    changedFiles: [...new Set(changedFiles)],
  };
  if (failed) {
    result.error = apply
      ? `${failed.step} failed: ${failed.detail}; re-run the same command to resume`
      : `${failed.step} would fail: ${failed.detail}; fix this before running with --apply`;
    result.code = "step_failed";
  }
  return result;
}
