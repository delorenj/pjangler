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
  FLEET_FORBIDDEN_KEYS,
  FLEET_HEALTHY_CLASSIFICATIONS,
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
// `(?:\/|$)` matters: without it a bare `/home/someone` -- no trailing slash --
// walked straight through, and `/root` was never covered at all.
const HOST_PATH = /\/(?:home|Users|root)\/[A-Za-z0-9._-]+(?:\/|$)/u;
const SECRET_KEY = /(api_key|apikey|password|passwd|secret|token|credential)/iu;
/** Longest `retired[].detect` pattern accepted. Long patterns are the ones that hurt. */
const FLEET_DETECT_MAX_PATTERN_BYTES = 200;
// A quantified group that itself contains a quantifier -- `(a+)+`, `(a*)*`,
// `(?:ab+)*` -- is the classic exponential-backtracking shape.
const NESTED_QUANTIFIER = /\((?:\?[:=!])?[^)]*[+*}][^)]*\)\s*[+*{]/u;
// Credential-SHAPED values, not the word "secret" in prose. A key-name scan
// alone let `store: "sk-live-..."` through, and a prose scan would flag every
// note that explains why credentials are banned.
const SECRET_VALUE = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
  /(?:api[_-]?key|password|passwd|secret|token|credential)\s*[:=]\s*\S{8,}/iu,
];

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

/** Normalize a store name into the token a `direction` is built from. */
function storeToken(store: string): string {
  return store.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
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

/**
 * Walk a dotted path into the policy tree, or `undefined` if it does not exist.
 *
 * Used to prove `retired[].superseded_by` names a real block of this contract
 * rather than a section someone has since renamed.
 */
function resolveContractPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
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
    // Null prototype, deliberately. `yaml` hands back `__proto__` as a real own
    // key, but assigning it onto a normal object literal sets the prototype
    // instead of creating a property -- so the key silently VANISHED from the
    // policy tree and no rule could ever see it. With no prototype in the
    // chain there is no setter to hijack, the key survives as data, and the
    // forbidden-key rule below can reject it.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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

  // `toJS()` still throws after a clean parse -- an alias bomb trips the
  // library's own `maxAliasCount` only when the tree is materialised. Left
  // unhandled it escaped the diagnostics pipeline entirely and surfaced as
  // INTERNAL_ERROR/exit 6, which this taxonomy reserves for defects in US. A
  // hostile input file is the caller's problem, and says so: INVALID_INPUT.
  let tree: unknown;
  try { tree = document.toJS() as unknown; }
  catch { return { diagnostics: [{ code: "INVALID_INPUT", path: DOCUMENT_PATH, message: "contract could not be materialised (alias expansion or depth limit)" }], contract: null, extensions: [] }; }
  const { policy, extensions } = collectFleetExtensions(tree);
  if (!isRecord(policy)) {
    return { diagnostics: [{ code: "INVALID_INPUT", path: DOCUMENT_PATH, message: "contract must be a mapping" }], contract: null, extensions };
  }

  const stages: Array<() => FleetDiagnostic[]> = [
    () => validateVersion(policy),
    () => sortDiagnostics(validateStructure(policy, extensions)),
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

function validateStructure(policy: Record<string, unknown>, extensions: readonly FleetExtension[]): FleetDiagnostic[] {
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

  // No host state, no credentials. Only `retired[].detect` is exempt from the
  // host-path rule: it is a detection vocabulary rather than a declaration, so
  // it has to be able to spell the very shapes the rule bans. Exempting the
  // WHOLE retired block was too wide -- `id`, `reason` and `superseded_by` are
  // ordinary prose, and a live-shaped key or another user's home directory
  // parked in a `reason:` validated clean. Extensions are NOT exempt either: an
  // `x-` key is not policy, but a credential in one is still a credential in a
  // tracked file.
  const leaves: Array<{ path: string; text: string }> = [];
  for (const [key, value] of Object.entries(policy)) {
    if (key !== "retired") { scalars(value, key, leaves); continue; }
    if (!Array.isArray(value)) { scalars(value, key, leaves); continue; }
    value.forEach((entry: unknown, index: number) => {
      if (!isRecord(entry)) { scalars(entry, `${key}[${index}]`, leaves); return; }
      for (const [entryKey, entryValue] of Object.entries(entry)) {
        if (entryKey === "detect") continue;
        scalars(entryValue, `${key}[${index}].${entryKey}`, leaves);
      }
    });
  }
  for (const extension of extensions) {
    leaves.push({ path: extension.path, text: extension.path });
    scalars(extension.value, extension.path, leaves);
  }
  for (const leaf of leaves) {
    if (HOST_PATH.test(leaf.text)) fail(leaf.path, "contract must not contain an absolute host path");
    if (SECRET_KEY.test(leaf.path)) fail(leaf.path, "contract must not carry credential-shaped keys");
    if (SECRET_VALUE.some((pattern) => pattern.test(leaf.text))) fail(leaf.path, "contract must not carry a credential-shaped value");
    if ((FLEET_FORBIDDEN_KEYS as readonly string[]).includes(leaf.text)) fail(leaf.path, `forbidden key name: ${leaf.text}`);
  }
  // A poisoned key that reached here as data is a hard stop: continuing would
  // run every later rule over a tree an attacker chose the shape of.
  if (findings.length) return findings;

  const owners = new Set<string>();
  // field path -> the single authority block that declares it writable. Built
  // here so projections can be checked against real declarations rather than
  // against a regex that would happily accept `project.{slug}.repo_path`.
  const fieldIndex = new Map<string, { id: string; owner: string; store: string }>();
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
      const readOnly = entry.read_only;
      if (readOnly !== undefined && typeof readOnly !== "boolean") fail(`${at}.read_only`, "read_only must be a boolean");
      const storeEnv = entry.store_env;
      // A read-only observation surface has no store to resolve, so demanding
      // an env key there only produced a plausible-looking lie -- process
      // inventory does not come from HERMES_FLEET_HOME.
      if (!stringList(storeEnv)) fail(`${at}.store_env`, "store_env must be a list of environment keys");
      else if (storeEnv.length === 0 && readOnly !== true) fail(`${at}.store_env`, "store_env may only be empty on a read-only authority");
      else storeEnv.forEach((key, index) => { if (!ENV_KEY.test(key)) fail(`${at}.store_env[${index}]`, `not an environment key: ${key}`); });
      if (entry.notes !== undefined && !stringList(entry.notes)) fail(`${at}.notes`, "notes must be a list of strings");
      const fields = entry.writable_fields;
      if (!Array.isArray(fields)) { fail(`${at}.writable_fields`, "writable_fields must be a list"); continue; }
      const seen = new Set<string>();
      fields.forEach((field: unknown, index: number) => {
        const where = `${at}.writable_fields[${index}]`;
        if (typeof field !== "string" || !FIELD_PATH.test(field)) { fail(where, "not a dotted field path"); return; }
        if (seen.has(field)) fail(where, `duplicate field path: ${field}`);
        seen.add(field);
        if (typeof owner === "string" && typeof entry.store === "string" && !fieldIndex.has(field)) {
          fieldIndex.set(field, { id, owner, store: entry.store });
        }
      });
      if (readOnly === true && fields.length > 0) {
        fail(`${at}.writable_fields`, "a read-only authority may not declare writable fields");
      }
    }
  }

  const projections = policy.projections;
  if (!Array.isArray(projections)) fail("projections", "projections must be a list");
  else {
    const seenPairs = new Map<string, number>();
    const seenTargets = new Map<string, number>();
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
      const source = entry.source;
      const target = entry.target;
      const writableBy = entry.writable_by;
      if (typeof writableBy !== "string" || !owners.has(writableBy)) {
        fail(`${at}.writable_by`, "writable_by must name exactly one declared authority owner");
      }
      if (typeof source !== "string" || typeof target !== "string") return;

      if (source === target) fail(`${at}.target`, "a projection must cross two field paths, not point at itself");
      const pair = `${source} -> ${target}`;
      const previous = seenPairs.get(pair);
      if (previous !== undefined) fail(`${at}`, `duplicate projection: ${pair} is already declared at projections[${previous}]`);
      else seenPairs.set(pair, index);

      // One direction, one upstream. These two are the whole point of the
      // block: the reverse pair makes a field bidirectional, and a second
      // source feeding one target gives that field two upstream truths -- which
      // is exactly the overlap this contract was written to end.
      const reverse = seenPairs.get(`${target} -> ${source}`);
      if (reverse !== undefined && reverse !== index) {
        fail(`${at}.direction`, `a field pair may flow in one direction only; the reverse is declared at projections[${reverse}]`);
      }
      const fedBy = seenTargets.get(target);
      if (fedBy !== undefined) fail(`${at}.target`, `${target} is already fed by projections[${fedBy}]`);
      else seenTargets.set(target, index);

      // Referential integrity. Both ends must be fields some authority really
      // declares, and the target must be writable by the owner this projection
      // names -- otherwise `writable_by` is a label nobody has to honour, and a
      // typo in a path is indistinguishable from a real declaration.
      const from = fieldIndex.get(source);
      const to = fieldIndex.get(target);
      if (!from) fail(`${at}.source`, `${source} is not declared writable by any authority`);
      if (!to) fail(`${at}.target`, `${target} is not declared writable by any authority`);
      if (!from || !to) return;
      if (typeof writableBy === "string" && owners.has(writableBy) && to.owner !== writableBy) {
        fail(`${at}.writable_by`, `${writableBy} does not declare ${target} writable; ${to.owner} does`);
      }

      // Direction is DERIVED from the two stores, never trusted as prose. The
      // pattern check it replaces accepted a direction that was backwards, and
      // accepted a three-hop chain, because `[a-z0-9_]+` swallows `_to_`.
      if (from.store === to.store) {
        fail(`${at}.direction`, `a projection must cross two stores; both ends live in ${from.store}`);
        return;
      }
      const expected = `${storeToken(from.store)}_to_${storeToken(to.store)}`;
      const direction = entry.direction;
      if (typeof direction !== "string" || !DIRECTION.test(direction)) {
        fail(`${at}.direction`, `direction must be ${expected}`);
      } else if (direction !== expected) {
        fail(`${at}.direction`, `direction is ${direction} but ${source} -> ${target} flows ${expected}`);
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
    // Three names for three roles. Collapsed to one string they all validate,
    // and a provisioner then writes one unit where the contract declares two.
    const unitNames = ["gateway_unit", "heartbeat_service", "heartbeat_timer"]
      .map((key) => perAgent[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (unitNames.length === 3 && new Set(unitNames).size !== 3) {
      fail("service_model.per_agent", "gateway_unit, heartbeat_service and heartbeat_timer must be three distinct patterns");
    }
    const shared = isRecord(service.fleet_shared) ? service.fleet_shared : {};
    for (const key of ["bloodbank_gateway_unit", "bloodbank_gateway_profile", "command_subject", "target_field"] as const) {
      const value = shared[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.fleet_shared.${key}`, `${key} must be a non-empty string`);
    }
    const layout = isRecord(service.profile_layout) ? service.profile_layout : {};
    if (typeof layout.root !== "string" || layout.root.length === 0) fail("service_model.profile_layout.root", "root must be a non-empty path pattern");
    // Without the placeholder every profile resolves to one directory, which
    // collapses profile identity exactly as a symlinked root would.
    else if (!layout.root.includes("{profile_name}")) fail("service_model.profile_layout.root", "a profile root must carry the {profile_name} placeholder");
    // A symlinked profile root loses profile identity and shared auth, so the
    // contract may not leave that as a permitted shape.
    if (layout.symlink_allowed !== false) fail("service_model.profile_layout.symlink_allowed", "symlink_allowed must be declared false");
    for (const key of ["identity_file", "override_file", "generated_file"] as const) {
      const value = layout[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.profile_layout.${key}`, `${key} must be a non-empty file name`);
    }
    // The override file is the operator-owned SSOT and the generated file is
    // rewritten by the renderer. Declaring the same name for both tells the
    // renderer to overwrite the only file a human is supposed to edit.
    const layoutFiles = ["identity_file", "override_file", "generated_file"]
      .map((key) => layout[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (layoutFiles.length === 3 && new Set(layoutFiles).size !== 3) {
      fail("service_model.profile_layout", "identity_file, override_file and generated_file must be three distinct names");
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
        // Discovery is not dispatch. Checking only that SOME block with this
        // owner writes the field was not enough: `hermes-agent-registry` owns
        // both the operational records and the activation flag, so pointing the
        // gate at `bloodbank.gateway_scope` -- a pure discovery field -- passed.
        // The gate must be the sole field of its own authority block, which is
        // what makes the block a gate rather than a label.
        const declaring = Object.entries(authorities).filter(([, value]) => (
          isRecord(value) && Array.isArray(value.writable_fields) && value.writable_fields.includes(field)
        ));
        const holder = declaring[0];
        // More than one declarer is a dual-ownership problem, and the conflict
        // stage says it far better -- it names both blocks and both owners.
        // Complaining here first would swap a precise AUTHORITY_CONFLICT for a
        // vague INVALID_INPUT about the same fact.
        if (declaring.length > 1) { /* validateAuthorityConflicts owns this */ }
        else if (!holder) {
          fail("activation.execution_authority.field", `${field} is not declared writable by any authority`);
        } else if (!isRecord(holder[1]) || holder[1].owner !== owner) {
          fail("activation.execution_authority.field", `${field} is not declared writable by ${owner}`);
        } else if (!Array.isArray(holder[1].writable_fields) || holder[1].writable_fields.length !== 1) {
          fail(
            "activation.execution_authority.field",
            `authorities.${holder[0]} must declare ${field} and nothing else; an authority that also writes discovery metadata cannot be the execution gate`,
          );
        }
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
      // A duplicate id satisfies the completeness loop below with a stub, so a
      // real mode can be deleted and the contract still validates -- taking its
      // `detect` patterns, and therefore its detection, with it.
      if (typeof entry.id === "string") {
        if (ids.has(entry.id)) fail(`${at}.id`, `duplicate retired mode id: ${entry.id}`);
        ids.add(entry.id);
      }
      // `superseded_by` is the only thing a RETIRED_MODE diagnostic tells an
      // operator to do next. Unresolved, it rots silently on the first rename.
      if (typeof entry.superseded_by === "string" && entry.superseded_by.length > 0
          && resolveContractPath(policy, entry.superseded_by) === undefined) {
        fail(`${at}.superseded_by`, `${entry.superseded_by} does not resolve to a declared contract path`);
      }
      const detect = entry.detect;
      if (!stringList(detect) || detect.length === 0) { fail(`${at}.detect`, "detect must be a non-empty list of patterns"); return; }
      detect.forEach((pattern, patternIndex) => {
        // Every pattern here runs against every scalar leaf in the contract.
        // `--contract` is advertised for validating candidate files, so the
        // pattern list is operator input: `^(a+)+$` against a 40-character note
        // pinned a core and never returned. Refuse the shape rather than run it
        // -- a validator that hangs gives a worse answer than one that says no.
        if (pattern.length > FLEET_DETECT_MAX_PATTERN_BYTES) {
          fail(`${at}.detect[${patternIndex}]`, `detect pattern exceeds ${FLEET_DETECT_MAX_PATTERN_BYTES} characters`);
          return;
        }
        if (NESTED_QUANTIFIER.test(pattern)) {
          fail(`${at}.detect[${patternIndex}]`, "detect pattern nests a quantifier inside a quantified group and may backtrack catastrophically");
          return;
        }
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
  // Claims are keyed on the AUTHORITY BLOCK, not the owner name. Keying on the
  // owner meant `bloodbank_activation` and `agent_operational_records` -- both
  // owned by `hermes-agent-registry` -- could each claim the activation flag
  // and agree, which silently collapses the discovery/execution split those two
  // blocks exist to keep apart. A field belongs to exactly one block.
  //
  // Projection targets are NOT claimed here any more; referential integrity in
  // the structure stage ties a projection to the block that declares its
  // target, so re-claiming it would report every healthy projection as a
  // conflict with itself.
  const claims = new Map<string, Array<{ id: string; owner: string }>>();
  for (const [id, authority] of Object.entries(contract.authorities)) {
    for (const field of authority.writable_fields) {
      const existing = claims.get(field);
      if (existing) existing.push({ id, owner: authority.owner });
      else claims.set(field, [{ id, owner: authority.owner }]);
    }
  }

  const findings: FleetDiagnostic[] = [];
  for (const field of [...claims.keys()].sort()) {
    const claimants = (claims.get(field) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (claimants.length > 1) {
      findings.push({
        code: "AUTHORITY_CONFLICT",
        path: `authorities.writable_fields.${field}`,
        message: `${field} claimed writable by: ${claimants.map((claim) => `${claim.id} (${claim.owner})`).join(", ")}`,
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

  // Everything a contract asserts is HEALTHY gets scanned. The first cut read
  // only service_model/activation/classifications, so a retired unit smuggled
  // into an authority's writable_fields, a projection targeting a checkpoint
  // timer, or `store: n8n-workflow-store` all validated clean.
  const leaves: Array<{ path: string; text: string }> = [];
  const tree = contract as unknown as Record<string, unknown>;
  for (const section of FLEET_HEALTHY_SECTIONS) scalars(tree[section], section, leaves);
  // Classifications selectively: `retired` and `intentionally_unmanaged` exist
  // to RECORD a sighting of exactly these patterns. Scanning them would make
  // the two classes unusable for their only job.
  for (const id of FLEET_HEALTHY_CLASSIFICATIONS) {
    const classification = contract.classifications?.[id];
    if (classification) scalars(classification.entries, `classifications.${id}.entries`, leaves);
  }
  const seen = new Set<string>();
  for (const mode of contract.retired) {
    for (const pattern of mode.detect) {
      let expression: RegExp;
      try { expression = new RegExp(pattern, "iu"); } catch { continue; }
      for (const leaf of leaves) {
        if (!expression.test(leaf.text)) continue;
        // `\u0000` as an ESCAPE, never a literal NUL byte. A raw NUL makes `file`
        // call this source `data` and makes GNU grep treat it as binary -- which
        // silently no-ops the machine-wide pre-commit secret scan, since that
        // scan greps the unified diff, for every commit touching this file.
        const key = `${leaf.path}\u0000${mode.id}`;
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
