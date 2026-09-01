// Load, validate, and re-serialize the tracked fleet contract.
//
// Strictly read-only: the only file this module opens is the contract itself.
// No registry, profile, repository, service, process, Bloodbank, or network
// access happens here, and none may be added -- every later Epic 1 story reads
// its authority answers from this module, so a write introduced here would
// become a write nobody asked any of them to make.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  FLEET_ACTIVATION_STATES,
  FLEET_AUTHORITY_KEYS,
  FLEET_CLASSIFICATION_IDS,
  FLEET_CLASSIFICATION_KEYS,
  FLEET_CLASSIFICATION_REQUIRED_FIELDS,
  FLEET_COMPATIBILITY_KEYS,
  FLEET_CONTRACT_ROOT_KEYS,
  FLEET_EXTENSION_PREFIX,
  FLEET_HEALTHY_SECTIONS,
  FLEET_PROJECTION_KEYS,
  FLEET_RETIRED_IDS,
  FLEET_RETIRED_KEYS,
  FLEET_SUPPORTED_SCHEMA_VERSIONS,
  FleetError,
  type FleetContract,
  type FleetDiagnostic,
  type FleetExtension,
} from "./types";

/** Name of the tracked contract, relative to the package root. */
export const FLEET_CONTRACT_RELATIVE_PATH = join("contracts", "fleet-contract.yaml");

/** A contract larger than this is not a declaration; it is an accident. */
const FLEET_CONTRACT_MAX_BYTES = 1_048_576;

/** Path used for findings about the document as a whole. */
const DOCUMENT_PATH = "contract";

const SEMVER = /^\d+\.\d+\.\d+$/u;
const OWNER_NAME = /^[a-z][a-z0-9-]*$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;
const DIRECTION = /^[a-z0-9_]+_to_[a-z0-9_]+$/u;
const FIELD_PATH = /^[A-Za-z0-9_{}-]+(?:\.[A-Za-z0-9_{}-]+)*$/u;
const HOST_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//u;
const SECRET_KEY = /(api_key|apikey|password|passwd|secret|token|credential)/iu;

type FleetContractDocument = ReturnType<typeof YAML.parseDocument>;

export interface LoadedFleetContract {
  /** Resolved absolute path. Redact before this reaches an operator. */
  path: string;
  text: string;
  document: FleetContractDocument;
}

export interface FleetContractValidation {
  diagnostics: FleetDiagnostic[];
  /** Populated only when `diagnostics` is empty. */
  contract: FleetContract | null;
  extensions: FleetExtension[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/**
 * Walk up from this module for the package root that also ships the contract.
 *
 * `resolvePjanglerRoot` in `src/parity/index.ts` is not exported, so this is one
 * more site duplicating the walk. Both markers are required: `package.json`
 * alone matches a nested dependency directory, and the bundled `dist/index.js`
 * has to land on the same root as the unbundled source.
 */
export function resolveFleetContractPath(override?: string): string {
  if (override !== undefined && override.trim() !== "") return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, FLEET_CONTRACT_RELATIVE_PATH))) {
      return join(dir, FLEET_CONTRACT_RELATIVE_PATH);
    }
    dir = dirname(dir);
  }
  return resolve(process.cwd(), FLEET_CONTRACT_RELATIVE_PATH);
}

export function loadFleetContract(path: string): LoadedFleetContract {
  if (!existsSync(path)) throw new FleetError("NOT_FOUND", "Fleet contract not found", false, {});
  const stat = statSync(path);
  if (!stat.isFile()) throw new FleetError("INVALID_INPUT", "Fleet contract is not a regular file", false, {});
  if (stat.size > FLEET_CONTRACT_MAX_BYTES) {
    throw new FleetError("INVALID_INPUT", `Fleet contract exceeds ${FLEET_CONTRACT_MAX_BYTES} bytes`, false, {});
  }
  const text = readFileSync(path, "utf8");
  return { path, text, document: YAML.parseDocument(text) };
}

/** The serializer the byte-stable round trip is defined against. */
export function serializeFleetContract(document: FleetContractDocument): string {
  return String(document);
}

/**
 * Split a plain contract tree into the policy view and its extensions.
 *
 * An `x-` key at any depth is metadata for whoever wrote it. It is lifted out
 * before any rule looks at the tree, so a namespaced key can never become
 * implicit policy, and it is reported separately so it stays visible.
 */
export function collectFleetExtensions(value: unknown): { policy: unknown; extensions: FleetExtension[] } {
  const extensions: FleetExtension[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (!isRecord(node)) return node;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      const child = path ? `${path}.${key}` : key;
      if (key.startsWith(FLEET_EXTENSION_PREFIX)) extensions.push({ path: child, value: item });
      else result[key] = walk(item, child);
    }
    return result;
  };
  const policy = walk(value, "");
  extensions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { policy, extensions };
}

/** Every scalar leaf in a subtree, addressed by dotted path. Keys included. */
function scalars(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => scalars(item, `${path}[${index}]`, out));
    return;
  }
  if (isRecord(node)) {
    for (const [key, item] of Object.entries(node)) {
      const child = path ? `${path}.${key}` : key;
      out.push({ path: child, text: key });
      scalars(item, child, out);
    }
    return;
  }
  if (node !== null && node !== undefined) out.push({ path, text: String(node) });
}

function sortDiagnostics(items: FleetDiagnostic[]): FleetDiagnostic[] {
  return [...items].sort((a, b) => (
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  ));
}

/**
 * Validate a parsed contract document.
 *
 * Stages run in a fixed order and the first stage to produce findings stops the
 * run: a contract whose schema version this build cannot read must not also be
 * lectured about its authorities, and a structurally broken file has no field
 * paths worth checking for conflicts. That ordering is what lets each exit code
 * answer exactly one question.
 */
export function validateFleetContract(document: FleetContractDocument): FleetContractValidation {
  const parseErrors = document.errors.slice(0, 20).map<FleetDiagnostic>((error) => {
    const at = error.linePos?.[0];
    const where = at ? ` at line ${at.line} column ${at.col}` : "";
    // The parser's own message quotes source fragments; only its stable code
    // and position cross the boundary.
    return { code: "INVALID_INPUT", path: DOCUMENT_PATH, message: `YAML parse failed (${error.code})${where}` };
  });
  if (parseErrors.length) return { diagnostics: parseErrors, contract: null, extensions: [] };

  const { policy, extensions } = collectFleetExtensions(document.toJS() as unknown);
  if (!isRecord(policy)) {
    return { diagnostics: [{ code: "INVALID_INPUT", path: DOCUMENT_PATH, message: "contract must be a mapping" }], contract: null, extensions };
  }

  const stages: Array<() => FleetDiagnostic[]> = [
    () => validateVersion(policy),
    () => sortDiagnostics(validateStructure(policy)),
    () => validateAuthorityConflicts(policy as unknown as FleetContract),
    () => sortDiagnostics(validateClassifications(policy as unknown as FleetContract)),
    () => sortDiagnostics(validateRetiredModes(policy as unknown as FleetContract)),
  ];
  for (const stage of stages) {
    const findings = stage();
    if (findings.length) return { diagnostics: findings, contract: null, extensions };
  }
  return { diagnostics: [], contract: policy as unknown as FleetContract, extensions };
}

function validateVersion(policy: Record<string, unknown>): FleetDiagnostic[] {
  const declared = policy.schema_version;
  if (!Number.isSafeInteger(declared)) {
    return [{ code: "INVALID_INPUT", path: "schema_version", message: "schema_version must be an integer" }];
  }
  const version = Number(declared);
  const { min, max } = FLEET_SUPPORTED_SCHEMA_VERSIONS;
  if (version < min || version > max) {
    return [{
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "schema_version",
      message: `contract schema_version ${version} is outside the supported range ${min}..${max}`,
    }];
  }
  const compatibility = policy.compatibility;
  if (!isRecord(compatibility)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility must be a mapping" }];
  }
  const lower = compatibility.min_schema_version;
  const upper = compatibility.max_schema_version;
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility bounds must be integers" }];
  }
  if (Number(lower) > Number(upper)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility min_schema_version exceeds max_schema_version" }];
  }
  if (version < Number(lower) || version > Number(upper)) {
    return [{
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "compatibility",
      message: `schema_version ${version} is outside the contract's own declared range ${String(lower)}..${String(upper)}`,
    }];
  }
  return [];
}

function validateStructure(policy: Record<string, unknown>): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };

  for (const key of Object.keys(policy)) {
    if (!(FLEET_CONTRACT_ROOT_KEYS as readonly string[]).includes(key)) fail(key, "unknown top-level key");
  }
  for (const key of FLEET_CONTRACT_ROOT_KEYS) {
    if (policy[key] === undefined) fail(key, "required top-level key is missing");
  }
  const compatibility = policy.compatibility;
  if (isRecord(compatibility)) {
    for (const key of Object.keys(compatibility)) {
      if (!(FLEET_COMPATIBILITY_KEYS as readonly string[]).includes(key)) fail(`compatibility.${key}`, "unknown compatibility key");
    }
  }
  if (typeof policy.contract_version !== "string" || !SEMVER.test(policy.contract_version)) {
    fail("contract_version", "contract_version must be a semantic version");
  }
  if (findings.length) return findings;

  // No host state, no credentials. `retired[].detect` is a detection vocabulary
  // rather than a declaration, so the whole retired block is exempt.
  const leaves: Array<{ path: string; text: string }> = [];
  for (const [key, value] of Object.entries(policy)) {
    if (key === "retired") continue;
    scalars(value, key, leaves);
  }
  for (const leaf of leaves) {
    if (HOST_PATH.test(leaf.text)) fail(leaf.path, "contract must not contain an absolute host path");
    if (SECRET_KEY.test(leaf.path)) fail(leaf.path, "contract must not carry credential-shaped keys");
  }

  const owners = new Set<string>();
  const authorities = policy.authorities;
  if (!isRecord(authorities) || Object.keys(authorities).length === 0) {
    fail("authorities", "authorities must be a non-empty mapping");
  } else {
    for (const [id, entry] of Object.entries(authorities)) {
      const at = `authorities.${id}`;
      if (!isRecord(entry)) { fail(at, "authority must be a mapping"); continue; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_AUTHORITY_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown authority key");
      }
      const owner = entry.owner;
      if (typeof owner !== "string" || !OWNER_NAME.test(owner)) fail(`${at}.owner`, "owner must be a lower-kebab identifier");
      else owners.add(owner);
      if (typeof entry.store !== "string" || entry.store.length === 0) fail(`${at}.store`, "store must be a non-empty name");
      const storeEnv = entry.store_env;
      if (!stringList(storeEnv) || storeEnv.length === 0) fail(`${at}.store_env`, "store_env must be a non-empty list of environment keys");
      else storeEnv.forEach((key, index) => { if (!ENV_KEY.test(key)) fail(`${at}.store_env[${index}]`, `not an environment key: ${key}`); });
      const readOnly = entry.read_only;
      if (readOnly !== undefined && typeof readOnly !== "boolean") fail(`${at}.read_only`, "read_only must be a boolean");
      if (entry.notes !== undefined && !stringList(entry.notes)) fail(`${at}.notes`, "notes must be a list of strings");
      const fields = entry.writable_fields;
      if (!Array.isArray(fields)) { fail(`${at}.writable_fields`, "writable_fields must be a list"); continue; }
      const seen = new Set<string>();
      fields.forEach((field: unknown, index: number) => {
        const where = `${at}.writable_fields[${index}]`;
        if (typeof field !== "string" || !FIELD_PATH.test(field)) { fail(where, "not a dotted field path"); return; }
        if (seen.has(field)) fail(where, `duplicate field path: ${field}`);
        seen.add(field);
      });
      if (readOnly === true && fields.length > 0) {
        fail(`${at}.writable_fields`, "a read-only authority may not declare writable fields");
      }
    }
  }

  const projections = policy.projections;
  if (!Array.isArray(projections)) fail("projections", "projections must be a list");
  else {
    projections.forEach((entry: unknown, index: number) => {
      const at = `projections[${index}]`;
      if (!isRecord(entry)) { fail(at, "projection must be a mapping"); return; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_PROJECTION_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown projection key");
      }
      for (const key of ["field", "source", "target"] as const) {
        const value = entry[key];
        if (typeof value !== "string" || value.length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
        else if (key !== "field" && !FIELD_PATH.test(value)) fail(`${at}.${key}`, "not a dotted field path");
      }
      const direction = entry.direction;
      if (typeof direction !== "string" || !DIRECTION.test(direction)) {
        fail(`${at}.direction`, "direction must name exactly one source and one target, as <source>_to_<target>");
      }
      const writableBy = entry.writable_by;
      if (typeof writableBy !== "string" || !owners.has(writableBy)) {
        fail(`${at}.writable_by`, "writable_by must name exactly one declared authority owner");
      }
    });
  }

  const classifications = policy.classifications;
  if (!isRecord(classifications)) fail("classifications", "classifications must be a mapping");
  else {
    for (const key of Object.keys(classifications)) {
      if (!(FLEET_CLASSIFICATION_IDS as readonly string[]).includes(key)) fail(`classifications.${key}`, "unknown lifecycle class");
    }
    for (const id of FLEET_CLASSIFICATION_IDS) {
      const at = `classifications.${id}`;
      const entry = classifications[id];
      if (!isRecord(entry)) { fail(at, "lifecycle class is missing or is not a mapping"); continue; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_CLASSIFICATION_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown lifecycle class key");
      }
      const required = entry.required_fields;
      if (!stringList(required) || required.length === 0) fail(`${at}.required_fields`, "required_fields must be a non-empty list of names");
      const entries = entry.entries;
      if (!Array.isArray(entries)) fail(`${at}.entries`, "entries must be a list");
      else entries.forEach((item: unknown, index: number) => { if (!isRecord(item)) fail(`${at}.entries[${index}]`, "entry must be a mapping"); });
      if (entry.notes !== undefined && !stringList(entry.notes)) fail(`${at}.notes`, "notes must be a list of strings");
    }
  }

  const service = policy.service_model;
  if (!isRecord(service)) fail("service_model", "service_model must be a mapping");
  else {
    for (const key of ["per_agent", "fleet_shared", "profile_layout"] as const) {
      if (!isRecord(service[key])) fail(`service_model.${key}`, `${key} must be a mapping`);
    }
    const perAgent = isRecord(service.per_agent) ? service.per_agent : {};
    for (const key of ["gateway_unit", "heartbeat_service", "heartbeat_timer"] as const) {
      const value = perAgent[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.per_agent.${key}`, `${key} must be a unit name pattern`);
      else if (!value.includes("{agent_id}")) fail(`service_model.per_agent.${key}`, "a per-agent unit pattern must carry the {agent_id} placeholder");
    }
    const shared = isRecord(service.fleet_shared) ? service.fleet_shared : {};
    for (const key of ["bloodbank_gateway_unit", "bloodbank_gateway_profile", "command_subject", "target_field"] as const) {
      const value = shared[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.fleet_shared.${key}`, `${key} must be a non-empty string`);
    }
    const layout = isRecord(service.profile_layout) ? service.profile_layout : {};
    if (typeof layout.root !== "string" || layout.root.length === 0) fail("service_model.profile_layout.root", "root must be a non-empty path pattern");
    // A symlinked profile root loses profile identity and shared auth, so the
    // contract may not leave that as a permitted shape.
    if (layout.symlink_allowed !== false) fail("service_model.profile_layout.symlink_allowed", "symlink_allowed must be declared false");
    for (const key of ["identity_file", "override_file", "generated_file"] as const) {
      const value = layout[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.profile_layout.${key}`, `${key} must be a non-empty file name`);
    }
  }

  const activation = policy.activation;
  if (!isRecord(activation)) fail("activation", "activation must be a mapping");
  else {
    const states = activation.states;
    if (!stringList(states) || states.length !== FLEET_ACTIVATION_STATES.length || states.some((state, index) => state !== FLEET_ACTIVATION_STATES[index])) {
      fail("activation.states", `states must be exactly [${FLEET_ACTIVATION_STATES.join(", ")}]`);
    }
    const authority = activation.execution_authority;
    if (!isRecord(authority)) fail("activation.execution_authority", "execution_authority must be a mapping");
    else {
      const field = authority.field;
      if (typeof field !== "string" || !FIELD_PATH.test(field)) fail("activation.execution_authority.field", "field must be a dotted field path");
      if (typeof authority.strict !== "boolean") fail("activation.execution_authority.strict", "strict must be a boolean");
      if (typeof authority.default !== "string" || authority.default.length === 0) fail("activation.execution_authority.default", "default must be a non-empty decision");
      const owner = authority.owner;
      if (typeof owner !== "string" || !owners.has(owner)) fail("activation.execution_authority.owner", "owner must name a declared authority owner");
      else if (typeof field === "string" && isRecord(authorities)) {
        // Discovery is not dispatch: the one field that grants execution has to
        // be a field its declared owner actually owns, or the gate is decorative.
        const owned = Object.values(authorities).some((entry) => (
          isRecord(entry) && entry.owner === owner && Array.isArray(entry.writable_fields) && entry.writable_fields.includes(field)
        ));
        if (!owned) fail("activation.execution_authority.field", `${field} is not declared writable by ${owner}`);
      }
    }
  }

  const retired = policy.retired;
  if (!Array.isArray(retired)) fail("retired", "retired must be a list");
  else {
    const ids = new Set<string>();
    retired.forEach((entry: unknown, index: number) => {
      const at = `retired[${index}]`;
      if (!isRecord(entry)) { fail(at, "retired mode must be a mapping"); return; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_RETIRED_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown retired-mode key");
      }
      for (const key of ["id", "reason", "superseded_by"] as const) {
        const value = entry[key];
        if (typeof value !== "string" || value.length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
      }
      if (typeof entry.id === "string") ids.add(entry.id);
      const detect = entry.detect;
      if (!stringList(detect) || detect.length === 0) { fail(`${at}.detect`, "detect must be a non-empty list of patterns"); return; }
      detect.forEach((pattern, patternIndex) => {
        try { new RegExp(pattern, "iu"); }
        catch { fail(`${at}.detect[${patternIndex}]`, "detect pattern is not a valid regular expression"); }
      });
    });
    for (const id of FLEET_RETIRED_IDS) {
      if (!ids.has(id)) fail("retired", `retired must declare the superseded mode ${id}`);
    }
  }

  return findings;
}

function validateAuthorityConflicts(contract: FleetContract): FleetDiagnostic[] {
  // One map, two sources of claims: what each authority says it writes, and
  // what each projection says may write its target. A field with more than one
  // distinct claimant is reported with BOTH claimants and neither is chosen --
  // picking a winner here is exactly the invention this contract exists to stop.
  const claims = new Map<string, Set<string>>();
  const claim = (field: string, owner: string): void => {
    const existing = claims.get(field);
    if (existing) existing.add(owner);
    else claims.set(field, new Set([owner]));
  };
  for (const authority of Object.values(contract.authorities)) {
    for (const field of authority.writable_fields) claim(field, authority.owner);
  }
  for (const projection of contract.projections) claim(projection.target, projection.writable_by);

  const findings: FleetDiagnostic[] = [];
  for (const field of [...claims.keys()].sort()) {
    const owners = [...(claims.get(field) ?? [])].sort();
    if (owners.length > 1) {
      findings.push({
        code: "AUTHORITY_CONFLICT",
        path: `authorities.writable_fields.${field}`,
        message: `${field} claimed writable by: ${owners.join(", ")}`,
      });
    }
  }
  return findings;
}

function validateClassifications(contract: FleetContract): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];
  for (const id of FLEET_CLASSIFICATION_IDS) {
    const classification = contract.classifications[id];
    if (!classification) continue;
    const declared = new Set(classification.required_fields);
    // `managed_agent` is exempt: a registered agent row is not an exception
    // someone chose to keep, so it owes no rationale for existing.
    if (id !== "managed_agent") {
      for (const field of FLEET_CLASSIFICATION_REQUIRED_FIELDS) {
        if (!declared.has(field)) {
          findings.push({
            code: "INVALID_CLASSIFICATION",
            path: `classifications.${id}.required_fields`,
            message: `${id} must require ${field}`,
          });
        }
      }
    }
    classification.entries.forEach((entry, index) => {
      const name = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `#${index}`;
      for (const field of classification.required_fields) {
        const value = entry[field];
        const missing = value === undefined || value === null
          || (typeof value === "string" && value.trim() === "")
          || (Array.isArray(value) && value.length === 0);
        if (missing) {
          findings.push({
            code: "INVALID_CLASSIFICATION",
            path: `classifications.${id}.entries[${index}].${field}`,
            message: `${id} entry ${name} is missing required field ${field}`,
          });
        }
      }
    });
  }
  return findings;
}

function validateRetiredModes(contract: FleetContract): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];

  // Default-deny is the whole point of the activation gate. A contract that
  // relaxes either half has re-declared activation-by-discovery as healthy.
  const authority = contract.activation.execution_authority;
  if (authority.default !== "deny") {
    findings.push({
      code: "RETIRED_MODE",
      path: "activation.execution_authority.default",
      message: `activation-by-discovery: execution authority defaults to "${authority.default}" instead of deny`,
    });
  }
  if (authority.strict !== true) {
    findings.push({
      code: "RETIRED_MODE",
      path: "activation.execution_authority.strict",
      message: "activation-by-discovery: execution authority must be strict, so an absent or coercible flag never grants dispatch",
    });
  }

  const leaves: Array<{ path: string; text: string }> = [];
  for (const section of FLEET_HEALTHY_SECTIONS) {
    scalars((contract as unknown as Record<string, unknown>)[section], section, leaves);
  }
  const seen = new Set<string>();
  for (const mode of contract.retired) {
    for (const pattern of mode.detect) {
      let expression: RegExp;
      try { expression = new RegExp(pattern, "iu"); } catch { continue; }
      for (const leaf of leaves) {
        if (!expression.test(leaf.text)) continue;
        const key = `${leaf.path} ${mode.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          code: "RETIRED_MODE",
          path: leaf.path,
          message: `declares the retired mode ${mode.id} as healthy; superseded by ${mode.superseded_by}`,
        });
      }
    }
  }
  return findings;
}
