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
  | "INTERNAL_ERROR"
  | "TIMEOUT"
  | "CANCELLED";

export const FLEET_ERROR_CODES = [
  "INVALID_INPUT", "NOT_FOUND", "AUTHORITY_CONFLICT", "INVALID_CLASSIFICATION",
  "RETIRED_MODE", "UNSUPPORTED_SCHEMA_VERSION", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED",
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
 * 5 is a version this build cannot speak, 6 is us, 7 is "we ran out of the time
 * you gave us", 8 is "you asked us to stop".
 *
 * The switch is exhaustive with no `default` on purpose: a new code that forgets
 * an exit band is a compile error rather than an `undefined` exit status.
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
    case "TIMEOUT": return 7;
    case "CANCELLED": return 8;
  }
}

// ---------------------------------------------------------------------------
// Fleet inventory (story 1.2)
//
// The contract above says who OWNS a field. Everything below says what the
// stores actually CONTAIN and where they disagree. The two vocabularies live in
// one file on purpose: an inventory row exists to carry a value together with
// the contract-declared authority that owns it, and splitting them would make
// it possible to add a reported field with no declared owner.
// ---------------------------------------------------------------------------

/**
 * Hard cap on rows carried in one inventory envelope.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound:
 * running the rows array through `boundedValue` would silently drop agent 101
 * of a growing fleet, which is the exact failure an inventory exists to
 * prevent. Rows are capped here, at a fleet-shaped number, and every clip is
 * recorded in `truncated` and flips `health.truncated`.
 */
export const FLEET_INVENTORY_MAX_ROWS = 1000;

/**
 * What is known about one reported value.
 *
 * `resolved`   the owning store gave a usable value and everything this command
 *              can check about it checks out.
 * `unresolved` absent, blank, unusable, or a referent this command could not
 *              correlate or classify as ok. Never a guess.
 * `conflicted` the value is claimed by more than one agent.
 * `unobserved` this command deliberately does not look. Expected unit names are
 *              expectations, not observations -- probing systemd is story 1.8.
 */
export const FLEET_FIELD_STATES = ["resolved", "unresolved", "conflicted", "unobserved"] as const;
export type FleetFieldState = (typeof FLEET_FIELD_STATES)[number];

/** One reported value, its contract-declared authority owner, and what is known about it. */
export interface FleetFieldValue<T = string> {
  value: T | null;
  /** The `owner` the contract declares for this field path, or null if it declares none. */
  source: string | null;
  state: FleetFieldState;
}

/**
 * What a declared path IS, established by `lstat` and never by following it.
 *
 * A symlink is reported as a symlink with its target recorded beside it; the
 * target is evidence, never a substitute for the declared value.
 */
export const FLEET_PATH_CLASSIFICATIONS = [
  "ok", "absent", "relative", "symlink", "outside-root", "not-a-directory", "unreadable", "undeclared",
] as const;
export type FleetPathClassification = (typeof FLEET_PATH_CLASSIFICATIONS)[number];

export interface FleetPathView {
  /** The value as declared, bounded and home-redacted. Never a realpath. */
  declared: string | null;
  classification: FleetPathClassification;
  /** Bounded link target when `classification` is `symlink`, else null. */
  link_target: string | null;
}

/** The board binding an agent row stores. Projected from the project registry. */
export interface FleetBoardBinding {
  workspace: string | null;
  project_id: string | null;
  identifier: string | null;
}

/**
 * A repository `.project.json`, read as a third opinion and nothing more.
 *
 * It is never the `source` of a field and never a tiebreaker between the two
 * registries: a manifest that disagrees produces a finding, not a value.
 */
export interface FleetManifestEvidence {
  path: FleetPathView;
  present: boolean;
  /** null when there is no manifest to agree or disagree with. */
  agrees: boolean | null;
  notes: string[];
}

/** One row per raw `agents:` entry, whatever shape that entry turned out to be. */
export interface FleetInventoryRow {
  agent_id: FleetFieldValue<string>;
  classification: FleetFieldValue<string>;
  correlation: FleetFieldValue<string>;
  project_id: FleetFieldValue<string>;
  repo: FleetFieldValue<string>;
  repo_path: FleetFieldValue<string>;
  role: FleetFieldValue<string>;
  role_dir: FleetFieldValue<string>;
  profile_name: FleetFieldValue<string>;
  profile_path: FleetFieldValue<string>;
  runtime_path: FleetFieldValue<string>;
  expected_units: FleetFieldValue<string[]>;
  /** The unit name the registry STORES, as opposed to the ones the contract derives. */
  gateway_unit: FleetFieldValue<string>;
  board: FleetFieldValue<FleetBoardBinding>;
  bloodbank_scope: FleetFieldValue<string>;
  bloodbank_target: FleetFieldValue<string>;
  activation: FleetFieldValue<boolean>;
  /** The contract's declared execution-authority field path, reported not evaluated. */
  activation_field: FleetFieldValue<string>;
  manifest: FleetManifestEvidence;
  paths: Record<string, FleetPathView>;
  /** Ids of every conflict group this row participates in. */
  conflicts: string[];
  /** Codes of every finding raised against this row. */
  findings: string[];
  malformed: boolean;
}

/**
 * Two or more claimants on one value of one field path.
 *
 * `participants` are the claimants (agent ids, or project-registry record keys
 * for a registry-internal duplicate). `owners` are the authority owners the
 * contract declares for the field path. AC5 wants the group to name both.
 */
export interface FleetConflictGroup {
  id: string;
  field: string;
  dimension: string;
  value: string;
  participants: string[];
  participant_kind: "agent" | "project";
  owners: string[];
  permitted: boolean;
  exception_id: string | null;
}

export const FLEET_FINDING_SEVERITIES = ["error", "warn", "info"] as const;
export type FleetFindingSeverity = (typeof FLEET_FINDING_SEVERITIES)[number];

export interface FleetInventoryFinding {
  code: string;
  field: string;
  agent_id: string | null;
  source: string | null;
  severity: FleetFindingSeverity;
  detail: string;
}

/**
 * Counted independently of row building.
 *
 * `source_rows` is counted from the raw `agents:` mapping keys in its own pass
 * BEFORE any row is built, so a row-builder bug surfaces as
 * `source_rows != emitted_rows` instead of as an inventory that quietly lost an
 * agent.
 */
export interface FleetInventoryTotals {
  source_rows: number;
  emitted_rows: number;
  /** Rows matching the current scope, before the row cap. */
  selected: number;
  /** Rows actually carried in `rows`, after the row cap. */
  observed: number;
  malformed_rows: number;
  registered_agents: number;
  project_records: number;
  correlated: number;
  uncorrelated: number;
  conflict_groups: number;
  permitted_conflict_groups: number;
  findings: number;
}

export interface FleetInventoryHealth {
  healthy: boolean;
  conflicts: number;
  permitted_conflicts: number;
  contract_violations: number;
  malformed_rows: number;
  unresolved_rows: number;
  collection_errors: number;
  truncated: boolean;
}

export interface FleetStoreView {
  id: string;
  owner: string | null;
  store: string | null;
  env_keys: string[];
  /** The canonical path, whatever `--*-registry` said. Bounded and home-redacted. */
  configured_path: string;
  /** The path actually opened. Equals `configured_path` unless overridden. */
  inspected_path: string;
  overridden: boolean;
  exists: boolean;
  source_rows: number;
  parse: "ok" | "salvaged" | "unreadable";
}

export interface FleetInventoryScope {
  kind: "fleet" | "agent";
  agent_id: string | null;
  label: string;
}

export interface FleetInventory {
  contract_path: string;
  contract_version: string | null;
  scope: FleetInventoryScope;
  stores: FleetStoreView[];
  totals: FleetInventoryTotals;
  health: FleetInventoryHealth;
  rows: FleetInventoryRow[];
  conflicts: FleetConflictGroup[];
  findings: FleetInventoryFinding[];
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}

// ---------------------------------------------------------------------------
// Fleet provenance (story 1.3)
//
// The inventory above says what the stores CONTAIN. Everything below says which
// build each thing actually is, by pairing every recorded/pinned value with its
// live counterpart. Same file, same reason: a reported provenance field cannot
// exist without a declared owner beside it.
//
// ONE GLOBAL RULE: `desired` is the recorded/pinned/declared side; `observed` is
// the live side. That is what makes the template gitlink structural rather than
// defensive -- the recorded gitlink is read from the PARENT's index and lands in
// `desired`, so no worktree movement can ever make it report the worktree's SHA.
// ---------------------------------------------------------------------------

/**
 * What one fact concluded. Absence is never a match.
 *
 * `match`       both sides are present and equal.
 * `mismatch`    both sides are present and differ.
 * `dirty`       a cleanliness fact whose observed side is not clean. Its own
 *               status, never a modifier on a value comparison, so it can never
 *               shadow a `mismatch` on the value beside it.
 * `missing`     a side that should carry a value carries none.
 * `unsupported` no comparable value can be obtained without inventing one --
 *               nothing on this host RECORDS the desired value (a deployed role
 *               scaffold carries no template ref), or the recorded value is a
 *               form this command must not resolve (an unexpanded `$VAR`).
 *               Observed evidence is still reported; nothing is guessed.
 * `unobserved`  the probe did not run, or ran and failed. Nothing may be claimed.
 */
export const FLEET_PROVENANCE_STATUSES = [
  "match", "mismatch", "dirty", "missing", "unsupported", "unobserved",
] as const;
export type FleetProvenanceStatus = (typeof FLEET_PROVENANCE_STATUSES)[number];

/**
 * Status precedence WITHIN one fact, strongest first.
 *
 * `unobserved` outranks everything: if the probe did not run, nothing may be
 * claimed. This is the concrete form of "the aggregate does not turn absence
 * into a match".
 */
export const FLEET_PROVENANCE_STATUS_PRECEDENCE = [
  "unobserved", "unsupported", "missing", "dirty", "mismatch", "match",
] as const satisfies readonly FleetProvenanceStatus[];

/** What is known about ONE side of a fact. */
export const FLEET_PROVENANCE_SIDE_STATES = ["present", "missing", "unsupported", "unobserved"] as const;
export type FleetProvenanceSideState = (typeof FLEET_PROVENANCE_SIDE_STATES)[number];

/** How a probe ended. `skipped` is a decision not to run, never a silent absence. */
export const FLEET_PROBE_OUTCOMES = ["ok", "failed", "timeout", "cancelled", "skipped"] as const;
export type FleetProbeOutcome = (typeof FLEET_PROBE_OUTCOMES)[number];

/**
 * Hard caps on what one provenance envelope carries.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound, for
 * the same reason `FLEET_INVENTORY_MAX_ROWS` is not: running the facts array
 * through `boundedValue` would silently drop agent 101's facts, which is the
 * exact failure a provenance report exists to prevent. Both caps record every
 * clip in `truncated`.
 */
export const FLEET_PROVENANCE_MAX_FACTS = 5000;
export const FLEET_PROVENANCE_MAX_PROBES = 500;

/**
 * One side of one fact.
 *
 * `source` names WHERE the value came from -- a store id, a config file, a live
 * probe -- not who is allowed to write it; the fact's `owner` carries that.
 * `family` is set only where a value belongs to a named executable/checkout
 * family (the contract's `retired[].detect` classes, or the configured release
 * root); everywhere else it is null.
 *
 * `classification` is set only where the value is a path this run `lstat`ed. It
 * is what the path IS, established without following it -- never a realpath
 * substituted for the declared value.
 */
export interface FleetProvenanceSide {
  value: string | null;
  source: string | null;
  state: FleetProvenanceSideState;
  family: string | null;
  classification: FleetPathClassification | null;
}

/**
 * One recorded-versus-live comparison.
 *
 * `id` is the fact KIND, not a unique key: `hermes.git_sha` appears once per
 * agent. The array key is `(scope, agent_id, id)` and that tuple is also the
 * sort order.
 */
export interface FleetProvenanceFact {
  id: string;
  scope: "fleet" | "agent";
  agent_id: string | null;
  /** The contract field path this fact is about, or a `{placeholder}` path for a host artifact. */
  field: string;
  /** The authority owner the CONTRACT declares for `field`, or null if it declares none. */
  owner: string | null;
  desired: FleetProvenanceSide;
  observed: FleetProvenanceSide;
  status: FleetProvenanceStatus;
  detail: string;
}

/**
 * One bounded child probe, recorded whether or not it produced a value.
 *
 * Never carries stderr, a raw command line, or a duration: `probe()` parses
 * stdout into a single value and discards the rest, and a duration would make
 * two runs over identical state produce different `data`.
 */
export interface FleetProbeRecord {
  /** Stable id: `{kind}:{redacted target}`. */
  id: string;
  kind: string;
  /** The directory or artifact probed, bounded and home-redacted. */
  target: string;
  outcome: FleetProbeOutcome;
  /** A stable category (`not-a-repository-root`, `absent`, ...), never a subprocess message. */
  reason: string | null;
}

/** One source this run read, with the same configured/inspected split the stores use. */
export interface FleetProvenanceSourceView {
  id: string;
  kind: string;
  configured_path: string;
  inspected_path: string;
  exists: boolean;
  parse: "ok" | "salvaged" | "unreadable" | "unread";
}

export interface FleetProvenanceTotals {
  /** Registered agents in the whole fleet, scope-independent. Equals the inventory's `registered_agents`. */
  agents: number;
  /** Facts built, before the scope filter and the fact cap. `classified_facts + dropped_facts`. */
  facts: number;
  /**
   * Facts that reached a status bucket -- what `by_status` sums to, always.
   *
   * Held apart from `facts` because a fact dropped at the cap has no status:
   * summing `by_status` against `facts` was an invariant that held only while
   * the cap did not engage.
   */
  classified_facts: number;
  /** Facts refused at `FLEET_PROVENANCE_MAX_FACTS`. Counted in `facts`, absent from `by_status`. */
  dropped_facts: number;
  /** Facts actually carried in `facts`. */
  emitted_facts: number;
  probes: number;
  by_status: Record<FleetProvenanceStatus, number>;
  findings: number;
}

export interface FleetProvenanceHealth {
  /**
   * Drift-free: no mismatch, no dirty, no missing.
   *
   * Clipping is deliberately NOT part of this. A truncated but drift-free run is
   * `healthy: true, complete: false` -- which is the whole reason there are two
   * verdicts rather than one.
   */
  healthy: boolean;
  /** Everything that could be observed was: no `unobserved` fact and no failed probe. */
  complete: boolean;
  mismatched: number;
  dirty: number;
  missing: number;
  unsupported: number;
  unobserved: number;
  probe_failures: number;
  truncated: boolean;
}

export interface FleetProvenance {
  contract_path: string;
  contract_version: string | null;
  scope: FleetInventoryScope;
  sources: FleetProvenanceSourceView[];
  totals: FleetProvenanceTotals;
  health: FleetProvenanceHealth;
  facts: FleetProvenanceFact[];
  probes: FleetProbeRecord[];
  findings: FleetInventoryFinding[];
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}
