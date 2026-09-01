// Fleet authority and managed-state contract: types, error taxonomy, and the
// `as const` owned-key allowlists that decide which keys are policy.
//
// The contract is DECLARATION ONLY. Nothing here models a runtime observation,
// a credential, or a health result -- those belong to the later observation
// stories and would make this file a moving target for every one of them.

/** The only contract schema this build can interpret. */
export const FLEET_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Inclusive range of contract schema versions this build accepts. */
export const FLEET_SUPPORTED_SCHEMA_VERSIONS = { min: 1, max: 1 } as const;

/** Envelope version for `pjangler fleet ...` machine output. */
export const FLEET_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Owned-key allowlists
//
// `authorities`, `projections`, `classifications` and `retired` are CLOSED: an
// unknown key there is a typo that would silently drop policy, so it fails.
//
// `service_model` and `activation` are OPEN: an unknown key there is a declared
// healthy mode, and the retired-mode scan is what must judge it. Rejecting it
// as "unknown" would hide exactly the drift this contract exists to name -- a
// contract re-introducing `consumer_unit` has to fail as RETIRED_MODE, not as a
// spelling complaint.
// ---------------------------------------------------------------------------

export const FLEET_CONTRACT_ROOT_KEYS = [
  "schema_version", "contract_version", "compatibility", "authorities",
  "projections", "classifications", "service_model", "activation", "retired",
] as const;

export const FLEET_COMPATIBILITY_KEYS = ["min_schema_version", "max_schema_version"] as const;

export const FLEET_AUTHORITY_KEYS = ["owner", "store", "store_env", "writable_fields", "read_only", "notes"] as const;

export const FLEET_PROJECTION_KEYS = ["field", "source", "target", "direction", "writable_by"] as const;

export const FLEET_CLASSIFICATION_KEYS = ["required_fields", "entries", "notes"] as const;

export const FLEET_RETIRED_KEYS = ["id", "reason", "superseded_by", "detect"] as const;

/** Lifecycle classes every observation must land in. */
export const FLEET_CLASSIFICATION_IDS = [
  "managed_agent", "managed_shared_service", "intentionally_unmanaged", "retired", "unclassified",
] as const;

/**
 * Fields every entry of a managed class other than `managed_agent` must carry.
 *
 * A registered agent is a registry row and needs no rationale to exist. Every
 * other managed thing is an exception someone decided to keep, so it has to say
 * who owns it, where it came from, why it stays, and which policy domains apply
 * -- otherwise "managed" degrades into "we saw it once".
 */
export const FLEET_CLASSIFICATION_REQUIRED_FIELDS = [
  "id", "kind", "owner", "source", "lifecycle_state", "rationale", "policy_domains",
] as const;

/** The five states discovery must not be allowed to collapse. */
export const FLEET_ACTIVATION_STATES = [
  "discovered", "installed", "healthy", "routing_ready", "activated",
] as const;

/** Retired modes the contract must name so they can be detected, never provisioned. */
export const FLEET_RETIRED_IDS = [
  "per-agent-bloodbank-consumer",
  "per-agent-checkpoint-timer",
  "n8n-owned-truth",
  "activation-by-discovery",
  "hard-coded-hermes-checkout-path",
] as const;

/**
 * Contract subtrees the retired-mode scan reads as "declared healthy".
 *
 * All of them, minus two deliberate exclusions. `retired` is the detection
 * vocabulary itself. And `classifications` is scanned selectively (see
 * FLEET_HEALTHY_CLASSIFICATIONS) because the `retired` and
 * `intentionally_unmanaged` classes exist precisely to RECORD a sighting of a
 * retired unit -- scanning them would make the two classes unusable for the one
 * job they have.
 */
export const FLEET_HEALTHY_SECTIONS = ["authorities", "projections", "service_model", "activation"] as const;

/** Lifecycle classes whose entries assert something is healthy and managed. */
export const FLEET_HEALTHY_CLASSIFICATIONS = ["managed_agent", "managed_shared_service"] as const;

/** Key names that must never appear in a contract at any depth. */
export const FLEET_FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** Prefix marking a namespaced extension: preserved verbatim, never policy. */
export const FLEET_EXTENSION_PREFIX = "x-";

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

export interface FleetAuthority {
  owner: string;
  store: string;
  store_env: string[];
  writable_fields: string[];
  read_only?: boolean;
  notes?: string[];
}

export interface FleetProjection {
  field: string;
  source: string;
  target: string;
  direction: string;
  writable_by: string;
}

export interface FleetClassification {
  required_fields: string[];
  entries: Array<Record<string, unknown>>;
  notes?: string[];
}

export interface FleetServiceModel {
  per_agent: Record<string, unknown>;
  fleet_shared: Record<string, unknown>;
  profile_layout: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FleetActivation {
  states: string[];
  execution_authority: {
    field: string;
    owner: string;
    strict: boolean;
    default: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FleetRetiredMode {
  id: string;
  reason: string;
  superseded_by: string;
  detect: string[];
}

export interface FleetContract {
  schema_version: number;
  contract_version: string;
  compatibility: { min_schema_version: number; max_schema_version: number };
  authorities: Record<string, FleetAuthority>;
  projections: FleetProjection[];
  classifications: Record<string, FleetClassification>;
  service_model: FleetServiceModel;
  activation: FleetActivation;
  retired: FleetRetiredMode[];
}

/** One namespaced extension, kept out of policy and reported separately. */
export interface FleetExtension {
  path: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Diagnostics and errors
// ---------------------------------------------------------------------------

export type FleetErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AUTHORITY_CONFLICT"
  | "INVALID_CLASSIFICATION"
  | "RETIRED_MODE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INTERNAL_ERROR";

export const FLEET_ERROR_CODES = [
  "INVALID_INPUT", "NOT_FOUND", "AUTHORITY_CONFLICT", "INVALID_CLASSIFICATION",
  "RETIRED_MODE", "UNSUPPORTED_SCHEMA_VERSION", "INTERNAL_ERROR",
] as const;

/**
 * One finding, always addressed by a dotted field path.
 *
 * `path` is where in the contract the problem is, never where on the host --
 * an operator has to be able to open the file at that key without the
 * diagnostic having leaked anything about the machine that produced it.
 */
export interface FleetDiagnostic {
  code: FleetErrorCode;
  path: string;
  message: string;
}

export class FleetError extends Error {
  override readonly name = "FleetError";

  constructor(
    readonly code: FleetErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Deterministic, categorized exit codes.
 *
 * Banded the way `notebookExitCode` bands its taxonomy: 2 is malformed input,
 * 3 is "the thing is not there", 4 is a contract the file states but must not,
 * 5 is a version this build cannot speak, 6 is us.
 */
export function fleetExitCode(code: FleetErrorCode): number {
  switch (code) {
    case "INVALID_INPUT": return 2;
    case "NOT_FOUND": return 3;
    case "AUTHORITY_CONFLICT":
    case "INVALID_CLASSIFICATION":
    case "RETIRED_MODE": return 4;
    case "UNSUPPORTED_SCHEMA_VERSION": return 5;
    case "INTERNAL_ERROR": return 6;
  }
}
