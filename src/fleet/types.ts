// Fleet authority and managed-state contract: types, error taxonomy, and the
// `as const` owned-key allowlists that decide which keys are policy.
//
// The contract is DECLARATION ONLY. Nothing here models a runtime observation,
// a credential, or a health result -- those belong to the later observation
// stories and would make this file a moving target for every one of them.

/**
 * The contract schema version this build WRITES.
 *
 * Bumped to 2 by story 1.5: `health_policy` is a new ROOT key, and a new root
 * key is a grammar change rather than a content one. Bumped to 3 by story 1.6
 * for the same reason: `scaffold_manifest` is a new root key. The build still
 * READS schema 1 and 2 -- see `FLEET_SUPPORTED_SCHEMA_VERSIONS` -- because a
 * contract without the newer blocks is simply one that authorizes no gap and
 * declares no manifest.
 */
export const FLEET_CONTRACT_SCHEMA_VERSION = 3 as const;

/** Inclusive range of contract schema versions this build accepts. */
export const FLEET_SUPPORTED_SCHEMA_VERSIONS = { min: 1, max: 3 } as const;

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
  "health_policy", "scaffold_manifest",
] as const;

/**
 * Root keys a contract may omit and still validate.
 *
 * `health_policy` is real policy, not an `x-` extension, so it belongs in the
 * allowlist above -- but a schema-1 contract predates it and must still load.
 * A contract without it authorizes nothing, which is why an absent block makes
 * every non-pass unjustified rather than making the run fail. `scaffold_manifest`
 * (schema 3) is optional on the same terms: without it the scaffold observer
 * reports every agent's `template_scaffold` as `unsupported` with capability
 * `scaffold.manifest`, unjustified unless the policy says otherwise.
 */
export const FLEET_CONTRACT_OPTIONAL_ROOT_KEYS = ["health_policy", "scaffold_manifest"] as const;

/** Closed key set for `health_policy` and each of its five entry lists. */
export const FLEET_HEALTH_POLICY_KEYS = [
  "required_domains", "deferred_capabilities", "allowed_warnings", "allowed_skips", "freshness", "agent_exceptions",
] as const;
export const FLEET_HEALTH_POLICY_DEFERRED_KEYS = ["domain", "capability", "reason", "owner_story"] as const;
export const FLEET_HEALTH_POLICY_WARNING_KEYS = ["rule_id", "reason", "owner"] as const;
export const FLEET_HEALTH_POLICY_SKIP_KEYS = ["domain", "rule_id", "reason"] as const;
export const FLEET_HEALTH_POLICY_FRESHNESS_KEYS = ["field", "max_age_days", "applies_to"] as const;
/** Closed key set for one `health_policy.agent_exceptions[]` entry. `(domain, agent_id)` is unique. */
export const FLEET_HEALTH_POLICY_AGENT_EXCEPTION_KEYS = ["domain", "agent_id", "reason", "owner"] as const;

/**
 * Closed key set for the `scaffold_manifest` root block (schema 3).
 *
 * The manifest is POLICY about the tracked template, not a copy of it: which
 * submodule and subdirectory the assets live in, how a rendered file is named,
 * which registry fields feed each render input, which contract leaf owns each
 * role-relative path, which assets are compared for presence only and why, and
 * what may never appear in a template tree. The bytes themselves come from git
 * at the committed gitlink and are never declared here.
 */
export const FLEET_SCAFFOLD_MANIFEST_KEYS = [
  "template_submodule", "template_subdirectory", "render_suffix", "render_inputs",
  "groups", "presence_only", "excluded_patterns", "runtime_dir",
] as const;
export const FLEET_SCAFFOLD_PRESENCE_ONLY_KEYS = ["path", "reason"] as const;

export const FLEET_COMPATIBILITY_KEYS = ["min_schema_version", "max_schema_version"] as const;

export const FLEET_AUTHORITY_KEYS = ["owner", "store", "store_env", "writable_fields", "read_only", "notes"] as const;

export const FLEET_PROJECTION_KEYS = ["field", "source", "target", "direction", "writable_by"] as const;

export const FLEET_CLASSIFICATION_KEYS = ["required_fields", "entries", "notes"] as const;

export const FLEET_RETIRED_KEYS = ["id", "reason", "superseded_by", "detect"] as const;

/** Lifecycle classes every observation must land in. */
export const FLEET_CLASSIFICATION_IDS = [
  "managed_agent", "managed_shared_service", "intentionally_unmanaged", "retired", "unclassified",
] as const;
export type FleetClassificationId = (typeof FLEET_CLASSIFICATION_IDS)[number];

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
export type FleetActivationState = (typeof FLEET_ACTIVATION_STATES)[number];

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

/**
 * One capability no observer in this release can answer, and who owns it.
 *
 * `capability` is optional because a whole DOMAIN can be deferred (nothing in
 * this build reads the process table) while elsewhere only one named half is
 * (the Bloodbank routing RECORD is observed; its liveness is not). `reason` and
 * `owner_story` are both required: a deferral with no owner is an excuse.
 */
export interface FleetHealthPolicyDeferredCapability {
  domain: string;
  capability?: string;
  reason: string;
  owner_story: string;
}

/** One rule whose `warn` is somebody else's cadence rather than fleet drift. */
export interface FleetHealthPolicyAllowedWarning {
  rule_id: string;
  reason: string;
  owner: string;
}

/** One rule or domain whose `skip` is a declared property, not an omission. */
export interface FleetHealthPolicyAllowedSkip {
  domain?: string;
  rule_id?: string;
  reason: string;
}

/**
 * How long one recorded timestamp counts as current evidence.
 *
 * `field` must be a path some authority declares, so a policy entry cannot
 * silently be about a field nobody owns. `applies_to` is the status domain the
 * bucket lands on.
 */
export interface FleetHealthPolicyFreshness {
  field: string;
  max_age_days: number;
  applies_to: string;
}

/**
 * One agent whose drift in one domain an operator has ruled on.
 *
 * `(domain, agent_id)` is the key and is unique. The ruling rides the existing
 * justification axis as `kind: "exception"` with THIS entry's own contract path
 * as its `policy`: the drifted observation is still reported, still `fail`, and
 * still keeps `health.healthy` false -- what changes is that the agent lands in
 * the `exception` member bucket rather than `unhealthy`, exactly as a permitted
 * identity conflict does. `owner` is who made the ruling.
 */
export interface FleetHealthPolicyAgentException {
  domain: string;
  agent_id: string;
  reason: string;
  owner: string;
}

/**
 * The only thing that can JUSTIFY a gap.
 *
 * Nothing here grants a capability, relaxes the activation gate, or turns an
 * observation into a pass. An authorized gap is still reported with its own
 * state; what changes is whether the aggregate may claim it was PROVEN.
 */
export interface FleetHealthPolicy {
  required_domains: string[];
  deferred_capabilities: FleetHealthPolicyDeferredCapability[];
  allowed_warnings: FleetHealthPolicyAllowedWarning[];
  allowed_skips: FleetHealthPolicyAllowedSkip[];
  freshness: FleetHealthPolicyFreshness[];
  /** Optional. Absent on a schema-2 contract, which then rules on no agent at all. */
  agent_exceptions?: FleetHealthPolicyAgentException[];
}

/** One asset compared for type and mode only, and the reason it is not compared for content. */
export interface FleetScaffoldPresenceOnly {
  path: string;
  reason: string;
}

/**
 * Policy about the tracked template, so the scaffold observer knows what a
 * role directory SHOULD contain without reading a worktree.
 *
 * `render_inputs` maps a template placeholder name to the contract field path
 * that feeds it -- `agents.{agent_id}` for the row's own id, a declared
 * `agents.{agent_id}.*` field, or a declared `projects.{slug}.*` field on the
 * correlated project record. `groups` maps each declared `scaffold.*` writable
 * leaf to the role-relative path it owns; a value ending in `/` owns a
 * directory. Every path the template renders must resolve to exactly one
 * group, or the source is `manifest-uncovered` and nothing is compared.
 */
export interface FleetScaffoldManifest {
  template_submodule: string;
  template_subdirectory: string;
  render_suffix: string;
  render_inputs: Record<string, string>;
  groups: Record<string, string>;
  presence_only: FleetScaffoldPresenceOnly[];
  excluded_patterns: string[];
  runtime_dir: string;
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
  /** Optional. Absent on a schema-1 contract, which then authorizes no gap at all. */
  health_policy?: FleetHealthPolicy;
  /** Optional. Absent on a schema-1/2 contract, which then declares no scaffold to compare against. */
  scaffold_manifest?: FleetScaffoldManifest;
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
  /**
   * The lifecycle class the CONTRACT declares for this row.
   *
   * Typed against `FLEET_CLASSIFICATION_IDS` rather than `string` (DW-30): the
   * bare literals it used to carry were checked by nothing, so a typo compiled
   * and shipped and the `intentionally_unmanaged` value was unreachable even
   * though the contract declares the class and story 1.5 counts agents into it.
   */
  classification: FleetFieldValue<FleetClassificationId>;
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

// ---------------------------------------------------------------------------
// Fleet status (story 1.4)
//
// The inventory says what the stores CONTAIN; provenance says which BUILD each
// agent runs. Neither answers "is the fleet correct?" in one invocation. That is
// this block's vocabulary: nine observation domains, seven states under one
// precedence, and two verdicts.
//
// Same file, same reason as the two blocks above: a reported status field cannot
// exist without a declared owner beside it. The `FleetStatus*` prefix keeps every
// name clear of the ones inventory and provenance already took.
// ---------------------------------------------------------------------------

/**
 * The nine observation domains. Every one appears in every result.
 *
 * A domain may never disappear silently -- it is either observed or carries an
 * explicit `unobserved`/`unsupported` observation with a reason. That is the one
 * outcome this vocabulary exists to prevent.
 *
 * DELIBERATELY NOT the contract's `policy_domains`. That is a different,
 * three-value axis (`systemd`, `bloodbank`, `profile`) declared per managed
 * exception at `contracts/fleet-contract.yaml:274-285`; conflating the two would
 * quietly widen a contract field that means something else. Widening the
 * contract is story 1.1's authority.
 */
export const FLEET_STATUS_DOMAINS = [
  "registry",
  "project_binding",
  "template_scaffold",
  "profile",
  "runtime",
  "systemd",
  "live_process",
  "bloodbank",
  "release_provenance",
] as const;
export type FleetStatusDomain = (typeof FLEET_STATUS_DOMAINS)[number];

/**
 * What one observation concluded.
 *
 * `pass`        observed, and in the state it should be in.
 * `warn`        observed, imperfect, and NOT a gate -- matching `gatesProject`
 *               in `src/recipes/types.ts`, where a warn has never gated a repo.
 * `skip`        DECLARED NOT APPLICABLE. Does not reduce completeness.
 * `fail`        observed, and wrong.
 * `unsupported` no adapter exists in this release. Counted and visible, but it
 *               cannot reduce `complete` -- a flag that is permanently false
 *               says nothing.
 * `unobserved`  applicable, and not read. Reduces `complete`.
 * `error`       collection itself failed. Never silently a `pass`, never a
 *               dropped agent.
 */
export const FLEET_STATUS_STATES = ["pass", "warn", "skip", "fail", "unsupported", "unobserved", "error"] as const;
export type FleetStatusState = (typeof FLEET_STATUS_STATES)[number];

/**
 * Precedence, strongest first, applied WITHIN one domain and then ACROSS domains.
 *
 * `error` outranks everything: a domain whose collection failed may not report
 * the state of the half that did work. `unobserved` outranks the observed states
 * for the same reason provenance's does -- if it was not read, nothing may be
 * claimed.
 *
 * ONE EXCEPTION, AND IT IS PART OF THE RULE, NOT A DEVIATION FROM IT:
 * `unsupported` sits above `fail` here and YIELDS whenever the domain produced
 * any other state. `unsupported` says "no adapter exists in this release" -- a
 * statement about this BUILD, not about the fleet -- so for a domain with
 * nothing else (`live_process`) it is correctly the strongest answer, and for a
 * MIXED domain it is the weakest thing to report: `template_scaffold` carries a
 * permanent "a deployed role scaffold records no template ref" beside its real
 * findings, and the raw order rolled that domain up to `unsupported` while 135
 * assets were failing. `rollUp` therefore drops `unsupported` from the candidate
 * set when anything else is present, and then walks THIS array. Read the two
 * together or the constant will mislead you; DW-67 records the history.
 *
 * Iterated by `rollUp`, not merely declared: a precedence constant nothing reads
 * is decoration (the exact defect story 1.3's review found in
 * `FLEET_PROVENANCE_STATUS_PRECEDENCE`).
 */
export const FLEET_STATUS_STATE_PRECEDENCE = [
  "error", "unobserved", "unsupported", "fail", "warn", "skip", "pass",
] as const satisfies readonly FleetStatusState[];

/**
 * Hard cap on agent records carried in one status envelope.
 *
 * DELIBERATELY BELOW `FLEET_INVENTORY_MAX_ROWS` (1000). A status record is an
 * order of magnitude larger than an inventory row -- nine domains, each with one
 * or more observations carrying bounded details -- so the fleet-shaped number is
 * smaller here. It also has to be the cap that actually fires: at 1000 the
 * inventory would clip first and this one could never be reached, which is a cap
 * no test can prove and therefore a cap nobody should trust.
 */
export const FLEET_STATUS_MAX_AGENTS = 500;

/** Cap on observations carried on ONE agent record. Every clip is recorded and retrievable. */
export const FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT = 200;

/** Cap on findings carried in one envelope, so a broken fleet stays one document. */
export const FLEET_STATUS_MAX_FINDINGS = 2000;

/** Cap on detail lines carried on one observation. Matches the envelope's own detail bound. */
export const FLEET_STATUS_MAX_DETAILS = 20;

/**
 * How many recipe-audit children run at once.
 *
 * Measured: 18 real repositories audit in ~1.3 s in-process (35-410 ms each), so
 * ~28 repositories as children is ~28 node startups. Four in flight keeps that
 * near the in-process cost without turning an observation command into a load
 * spike on the operator's own machine.
 */
export const FLEET_STATUS_AUDIT_CONCURRENCY = 4;

/**
 * How many role directories the scaffold observer reads at once.
 *
 * Each agent costs a handful of local `git` reads plus one `lstat`/read per
 * owned asset (51 on the current template). Four in flight is the audit's
 * number and for the same reason: it keeps an observation command from
 * becoming a load spike on the operator's own machine.
 */
export const FLEET_STATUS_SCAFFOLD_CONCURRENCY = 4;

/**
 * Cap on typed `items` carried on ONE observation.
 *
 * Its own cap, recorded per observation in `truncated`, never `boundedValue`
 * (which slices at 100 with no clip record). The counts on the observation and
 * on `agents[].scaffold` are computed over EVERY item before this cap applies,
 * so a bound on what the envelope carries never moves what it concludes.
 */
export const FLEET_STATUS_MAX_ITEMS = 100;

/** Cap on `agents[].scaffold.wip_overlap` paths carried. The count beside it is uncapped. */
export const FLEET_STATUS_MAX_WIP_OVERLAP = 20;


// ---------------------------------------------------------------------------
// Fleet health (story 1.5)
//
// Story 1.4 reports WHAT every domain observed. It cannot say whether the
// answer is TRUSTWORTHY or ACTIONABLE: `health.healthy` is `fail === 0 &&
// error === 0`, so a default run over a fleet where three domains have no
// observer at all and every audit-fed domain is `unobserved` still reads
// `healthy: true`.
//
// The vocabulary below is what makes that impossible. Four SEPARATE axes --
// applicability, evidence, freshness and state -- because one word cannot carry
// four questions; a severity, a repair class and one exact next action derived
// from real fields rather than from prose; and a three-way verdict beside
// `healthy` rather than instead of it, so 1.4's meaning is preserved and the
// aggregate still cannot claim health over an unread fleet.
// ---------------------------------------------------------------------------

/**
 * Whether an observation was REQUIRED, and if not, on whose authority.
 *
 * `required`       the contract's `health_policy.required_domains` names its
 *                  domain (and with no policy at all, everything is required --
 *                  the conservative reading, never the flattering one).
 * `optional`       a domain the policy does not require.
 * `not_applicable` the observation itself says so: a `skip`.
 * `deferred`       a capability `health_policy.deferred_capabilities` declares
 *                  no observer exists for in this release, with the story that
 *                  owns it.
 * `exception`      a managed exception the contract records under
 *                  `classifications.intentionally_unmanaged`.
 *
 * DW-67 left open "whether a domain with no adapter deserves an axis separate
 * from a domain with an unread half". This is that axis: `deferred` beside
 * `evidence: "absent"` says exactly that, which is why `unsupported` needs no
 * different rank in `FLEET_STATUS_STATE_PRECEDENCE`.
 */
export const FLEET_STATUS_APPLICABILITIES = [
  "required", "optional", "not_applicable", "deferred", "exception",
] as const;
export type FleetStatusApplicability = (typeof FLEET_STATUS_APPLICABILITIES)[number];

/**
 * How strongly the observation is supported.
 *
 * `direct`   this run read the thing itself.
 * `declared` a registry field asserts it and nothing verified it. "A timer is
 *            active, a gateway process exists, a deploy exited zero, a board
 *            says complete" all reduce to this. A `declared` observation may be
 *            `pass` on its own record, but it may never set
 *            `capability_readiness: "ready"` and never contribute to `proven`.
 * `derived`  computed from other observations rather than read (an identity
 *            conflict is a fact about the whole registry, not about one row).
 * `absent`   nothing was read at all: `unobserved`, `unsupported`, `error`.
 */
export const FLEET_STATUS_EVIDENCE = ["direct", "declared", "derived", "absent"] as const;
export type FleetStatusEvidence = (typeof FLEET_STATUS_EVIDENCE)[number];

/**
 * Whether the evidence is still current, as a BUCKET and never as an age.
 *
 * `data` must be byte-identical across two consecutive runs. An age in seconds
 * is not, so the reference instant is captured once per run, each policy entry
 * declares `max_age_days`, and only the bucket is emitted.
 *
 * `not_applicable` is the honest default: most observations have no timestamp
 * behind them and no policy entry claiming one. `unknown` means a policy entry
 * DOES apply and the timestamp is absent or unparseable -- which is a different
 * problem from "no policy applies" and must not collapse into it.
 */
export const FLEET_STATUS_FRESHNESS = ["current", "stale", "unknown", "not_applicable"] as const;
export type FleetStatusFreshness = (typeof FLEET_STATUS_FRESHNESS)[number];

/**
 * Freshness precedence, worst first, when several policy entries apply to one
 * observation.
 *
 * `unknown` sits above `current` because a policy entry that DOES apply to a
 * field nothing populates is a question this run could not answer, and the
 * better of two readings must not be the one that survives -- the same
 * worst-wins rule the host block already has to follow.
 *
 * Declared here rather than in `health.ts` because every new vocabulary belongs
 * in one file: an ordering that lives beside its only consumer is one the
 * suite's "every declared vocabulary is spelled the same" check cannot see.
 */
export const FLEET_STATUS_FRESHNESS_PRECEDENCE = [
  "stale", "unknown", "current", "not_applicable",
] as const satisfies readonly FleetStatusFreshness[];

/** What one finding is ABOUT: the whole fleet, this machine, or one row. */
export const FLEET_STATUS_SCOPES = ["fleet", "host", "agent"] as const;
export type FleetStatusScopeKind = (typeof FLEET_STATUS_SCOPES)[number];

/**
 * Scope precedence for the finding sort, broadest blast radius first.
 *
 * A fleet-scoped finding is true of everything, a host one of this machine, an
 * agent one of a single row -- so an operator reading a capped list sees the
 * widest statement before the narrowest.
 */
export const FLEET_STATUS_SCOPE_PRECEDENCE = [
  "fleet", "host", "agent",
] as const satisfies readonly FleetStatusScopeKind[];

/**
 * How badly this needs a decision. Derived from `state` x `applicability`.
 *
 * Deliberately NOT `FLEET_FINDING_SEVERITIES` (`error`/`warn`/`info`). That
 * three-value axis is the inventory's finding severity and means something
 * else; overloading it would make "an error-severity finding" and "a critical
 * observation" the same word for two different questions.
 */
export const FLEET_STATUS_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FleetStatusSeverity = (typeof FLEET_STATUS_SEVERITIES)[number];

/**
 * Severity precedence, strongest first.
 *
 * Iterated by `compareStatusFindings`, not merely declared: a precedence
 * constant nothing reads is decoration, which is the exact defect story 1.3's
 * review found in `FLEET_PROVENANCE_STATUS_PRECEDENCE`.
 */
export const FLEET_STATUS_SEVERITY_PRECEDENCE = [
  "critical", "high", "medium", "low", "info",
] as const satisfies readonly FleetStatusSeverity[];

/**
 * WHO can repair this, and therefore what the next action can possibly be.
 *
 * `automatic`       an audit rule that reports `fixable` on a project scope --
 *                   `pjangler migrate` has a recipe for it.
 * `approval-gated`  it touches `activation.execution_authority`, which the
 *                   contract declares `strict: true, default: deny`. No
 *                   repository change grants it.
 * `blocked`         a contract-declared deferred capability. Nothing to run in
 *                   this release; the action names the owning story.
 * `other-owner`     a host-scoped rule. No amount of work in any repository
 *                   changes a condition about this machine.
 * `manual`          everything else that needs a decision.
 * `none`            nothing to repair: the observation passes, or its skip is
 *                   declared not applicable.
 */
export const FLEET_STATUS_REPAIRS = [
  "automatic", "approval-gated", "blocked", "other-owner", "manual", "none",
] as const;
export type FleetStatusRepair = (typeof FLEET_STATUS_REPAIRS)[number];

/**
 * Whether the recommended command is safe to run unread.
 *
 * A recommended command is read-only unless it is LABELLED, and a
 * `requires-authorization` action must name the authorization in the string
 * itself -- otherwise the label is the only thing standing between an operator
 * and a command that changes the fleet.
 */
export const FLEET_STATUS_NEXT_ACTION_CLASSES = ["read-only", "requires-authorization"] as const;
export type FleetStatusNextActionClass = (typeof FLEET_STATUS_NEXT_ACTION_CLASSES)[number];

/** On whose authority a non-pass observation is allowed to stand. */
export const FLEET_STATUS_JUSTIFICATION_KINDS = [
  "deferred_capability", "allowed_warning", "allowed_skip", "exception",
] as const;
export type FleetStatusJustificationKind = (typeof FLEET_STATUS_JUSTIFICATION_KINDS)[number];

/**
 * The contract entry that authorizes one gap.
 *
 * `policy` is the dotted path to the entry, so an operator can open the
 * contract at it. A justification is never inferred: with no `health_policy`
 * block, every non-pass carries `null` here and the fleet cannot claim proof.
 */
export interface FleetStatusJustification {
  kind: FleetStatusJustificationKind;
  policy: string;
  reason: string;
  owner: string | null;
}

/**
 * The three-way aggregate. What the report headline and `exit_category` lead with.
 *
 * `healthy`   nothing failed AND everything that had to be observed was, with
 *             every non-pass justified.
 * `unhealthy` drift is PROVEN.
 * `unproven`  nothing is proven either way -- an unread half, a stale reading,
 *             or an unjustified gap.
 *
 * Held BESIDE `health.healthy` rather than replacing it. `healthy` keeps story
 * 1.4's drift-only meaning, `complete` keeps its coverage meaning, and this is
 * the aggregate a machine client reads.
 */
export const FLEET_STATUS_VERDICTS = ["healthy", "unhealthy", "unproven"] as const;
export type FleetStatusVerdict = (typeof FLEET_STATUS_VERDICTS)[number];

/**
 * The machine discriminant, carried in `data` on BOTH adapters.
 *
 * `unhealthy` and `incomplete` are `ok: true` states -- the command succeeded,
 * the fleet did not -- so they cannot be `FleetErrorCode` members without
 * nulling `data` on exactly the runs that matter.
 */
export const FLEET_STATUS_EXIT_CATEGORIES = ["ok", "unhealthy", "incomplete"] as const;
export type FleetStatusExitCategory = (typeof FLEET_STATUS_EXIT_CATEGORIES)[number];

/**
 * The process exits `--exit-code` projects each category onto.
 *
 * Above the `FleetErrorCode` bands (2-8) on purpose: a caller must be able to
 * tell "the fleet is unhealthy" from "the command failed" by exit status alone.
 * Applied ONLY under `--exit-code`; the default stays 0 because `fleet status`
 * is an observation command, gating CI is story 1.21's job, and a
 * `mise run fleet:status` that is permanently red teaches an operator to ignore
 * it.
 */
export const FLEET_STATUS_EXIT_CODES = {
  ok: 0,
  unhealthy: 10,
  incomplete: 11,
} as const satisfies Record<FleetStatusExitCategory, number>;

/** Which bucket one agent lands in. Exactly one, over every SELECTED agent. */
export const FLEET_STATUS_MEMBER_CLASSES = [
  "healthy", "unhealthy", "incomplete", "deferred", "exception", "unclassified",
] as const;
export type FleetStatusMemberClass = (typeof FLEET_STATUS_MEMBER_CLASSES)[number];

/**
 * Which class wins when an agent qualifies for more than one.
 *
 * ONE RULE, applied consistently: what the CONTRACT or the FLEET determines
 * about the ROW outranks what happened to be true of THIS RUN. A row's
 * classification and its proven failures are the same on every invocation; its
 * completeness depends on which flags the caller passed, and on a default run
 * nearly every row is incomplete -- so letting `incomplete` win would collapse
 * five of the six buckets into one on the command's most common invocation.
 *
 * Within the durable half: `unclassified` first, because a row this command
 * could not classify supports no other claim; then `unhealthy`, so an operator
 * ruling can never absorb an unrelated proven failure; then `exception`, an
 * operator's standing decision about the row; then `deferred`, an authorized
 * gap in the build rather than in the fleet.
 *
 * The previous order put `incomplete` above `deferred` on the reasoning that an
 * unread half is a bigger statement than an authorized one. That reasoning was
 * right about the two of them and inconsistent with `exception` sitting above
 * `incomplete` for the opposite reason; the rule above is what makes all four
 * agree.
 *
 * Iterated by `classifyMember`, never re-spelled there.
 */
export const FLEET_STATUS_MEMBER_PRECEDENCE = [
  "unclassified", "unhealthy", "exception", "deferred", "incomplete", "healthy",
] as const satisfies readonly FleetStatusMemberClass[];

/** How one finding moved between the baseline run and this one. */
export const FLEET_STATUS_TRANSITION_KINDS = [
  "appeared", "resolved", "state_changed", "severity_changed", "evidence_changed",
] as const;
export type FleetStatusTransitionKind = (typeof FLEET_STATUS_TRANSITION_KINDS)[number];

/**
 * Cap on transitions carried in one envelope.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound, for
 * the same reason `FLEET_INVENTORY_MAX_ROWS` is not: 28 agents x 9 domains
 * crosses 100 trivially, and `boundedValue` would slice the array with no
 * per-item identity and no record of the clip.
 */
export const FLEET_STATUS_MAX_TRANSITIONS = 2000;

/**
 * What `observed_state` may report, and why it needs a value the contract's own
 * activation ladder does not have.
 *
 * A `--domain registry` run never reads the profile tree, so it cannot say
 * whether the agent is `installed` -- and reporting `discovered` there would let
 * a COLLECTION FILTER move a conclusion about the agent, which is the one thing
 * a scope is not allowed to do. `out_of_scope` says "this run did not select
 * the domain that answers this", which is a statement about the run rather than
 * about the fleet.
 */
export const FLEET_STATUS_LIFECYCLE_STATES = [
  "discovered", "installed", "healthy", "routing_ready", "activated", "out_of_scope",
] as const;
export type FleetStatusLifecycleState = (typeof FLEET_STATUS_LIFECYCLE_STATES)[number];

/**
 * Whether routing readiness was proven, could not be, or was not looked at.
 *
 * `ready` is unreachable in this release by construction -- it would require a
 * direct observation of the shared gateway and none exists. `blocked` is
 * unreachable until that observer arrives too. Both are declared so the axis
 * has somewhere to grow that is not a boolean.
 */
export const FLEET_STATUS_READINESS = [
  "ready", "unproven", "blocked", "not_applicable", "out_of_scope",
] as const;
export type FleetStatusReadiness = (typeof FLEET_STATUS_READINESS)[number];

/**
 * The four activation states, kept apart, for one agent.
 *
 * FOUR FIELDS, NEVER ONE BOOLEAN. Discovery, installation, health, routing
 * readiness and execution activation are distinct states, and collapsing any
 * two of them is how "we can resolve a target" becomes "we may dispatch to it".
 *
 * `desired_state` is what the REGISTRY declares as the target for this row -- a
 * statement of intent, never a claim about the agent. `observed_state` is the
 * furthest state this run actually PROVED, and it can never read
 * `routing_ready` or `activated` in this release because no observer for either
 * exists.
 */
export interface FleetStatusLifecycle {
  desired_state: FleetActivationState;
  observed_state: FleetStatusLifecycleState;
  /**
   * Whether Bloodbank routing readiness was PROVEN for this agent.
   *
   * Never `ready` in this release: `ready` would require a direct observation of
   * the shared gateway, and a `declared` registry field is not one.
   */
  capability_readiness: FleetStatusReadiness;
  /** The strict execution-authority flag, read verbatim. The contract's default is deny. */
  activation: "granted" | "denied" | "undeclared";
}

/** One agent per bucket, counted over every SELECTED agent -- never over the emitted ones. */
export interface FleetStatusMembers {
  healthy: number;
  unhealthy: number;
  incomplete: number;
  deferred: number;
  exception: number;
  unclassified: number;
}

/**
 * One finding that moved between two runs, joined on a stable `finding_id`.
 *
 * `from` and `to` are null on `resolved` and `appeared` respectively. Nothing
 * here is persisted: the baseline is a document the operator supplies, and this
 * command never writes state to disk to compute a transition.
 */
export interface FleetStatusTransition {
  finding_id: string;
  kind: FleetStatusTransitionKind;
  scope: "fleet" | "agent" | "host";
  agent_id: string | null;
  domain: FleetStatusDomain;
  from: { state: FleetStatusState; severity: FleetStatusSeverity; evidence: FleetStatusEvidence } | null;
  to: { state: FleetStatusState; severity: FleetStatusSeverity; evidence: FleetStatusEvidence } | null;
  detail: string;
}

/**
 * One observation: one thing this run learned about one domain.
 *
 * `agent_id` is null for a FLEET-SCOPED observation -- something true of the
 * fleet rather than of an agent (the tracked template's gitlink, the host pin).
 * Those live on the domain rollup, never copied onto every agent record.
 *
 * `rule_scope` is `LifecycleScope` (`"project" | "host"`) when the observation
 * came from a recipe rule, null otherwise. A `host` observation never reaches a
 * per-agent record: that promotion is the exact category error PJAN-84 fixed.
 *
 * `finding_id` is a sha256 prefix over `(scope, agent_id, domain, rule_id, field,
 * source)` -- the `conflictGroupId` idiom -- so an id is stable across runs and
 * identical on the CLI and MCP paths. That is what turns the parity check into a
 * deep equality rather than a resemblance. `source` is in the tuple because two
 * sources routinely answer for the same `(agent, domain, field)` with no rule id
 * between them, and without it they collided into one id.
 *
 * `retrieval` is the command that returns this observation on its own, so a
 * clipped envelope always names the way to get the part it dropped.
 */
export interface FleetStatusObservation {
  domain: FleetStatusDomain;
  agent_id: string | null;
  state: FleetStatusState;
  /**
   * What this observation is ABOUT: a recipe rule id, or a provenance fact id.
   * Null only when it came from a plain store read.
   *
   * It carries the fact id as well as the rule id because `field` alone does not
   * identify an observation: `hermes.git_sha` and `hermes.checkout_head` both
   * compare `agents.{agent_id}.hermes.git_sha`, so without this the two would
   * hash to one `finding_id` and any consumer joining on that id would silently
   * merge them. MEASURED -- the suite's uniqueness case caught exactly that.
   */
  rule_id: string | null;
  /** The recipe that owns `rule_id`, or the contract-declared authority for `field`. */
  owner: string | null;
  rule_scope: "project" | "host" | null;
  /** The dotted field path or provenance fact id this observation is about. */
  field: string;
  summary: string;
  details: string[];
  finding_id: string;
  /** Where the observation came from: a store read, a provenance fact, a recipe audit, or a declared gap. */
  source: string;
  retrieval: string;
  /** Whether it was REQUIRED, and if not, on whose authority. Story 1.5. */
  applicability: FleetStatusApplicability;
  /** How strongly it is supported. `declared` never proves a capability ready. */
  evidence: FleetStatusEvidence;
  /** A bucket, never an age -- `data` has to be byte-identical across two runs. */
  freshness: FleetStatusFreshness;
  /** `state` x `applicability`, so a fail on a required domain outranks one on an optional. */
  severity: FleetStatusSeverity;
  /** Who can repair it, and therefore what `next_action` can possibly be. */
  repair: FleetStatusRepair;
  /**
   * The live side and the recorded side, in the shape `FleetProvenanceFact`
   * already uses.
   *
   * ALWAYS POPULATED, and the two halves are not always a value comparison.
   * Where one is -- a provenance fact, a profile path, a routing record -- both
   * carry real values from opposite sides. Where it is not, `observed` is what
   * this run CONCLUDED and `desired` is what the domain declares it should
   * conclude: an audit rule reports `observed: "18 scaffold issue(s)
   * detected"` against `desired: "the recipe rule hermes.pm-scaffold reporting
   * pass"`. That second shape is close to a restatement of the summary, and it
   * is kept anyway because AC7 requires every non-pass to carry the pair and a
   * consumer that has to branch on which shape it got has no pair at all.
   *
   * Typed nullable because the ENVELOPE has carried nulls here since 1.5's
   * first cut and a consumer must keep handling them; nothing produces one
   * today.
   */
  observed: string | null;
  desired: string | null;
  /** One exact thing to do next. Read-only unless `next_action_class` says otherwise. */
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
  /** The contract entry authorizing this gap, or null. Null on a non-pass blocks `proven`. */
  justification: FleetStatusJustification | null;
  /**
   * Typed per-asset items, where the observation is a scaffold group. Story 1.6.
   *
   * ABSENT (not empty) on a group with nothing to report, and capped at
   * `FLEET_STATUS_MAX_ITEMS` with the clip recorded in `truncated`. Each item's
   * `path` is role-relative and its `desired`/`observed` are 12-hex blob-id
   * prefixes or type/mode words -- never a body, never an absolute path.
   */
  items?: FleetStatusObservationItem[];
}

// ---------------------------------------------------------------------------
// Fleet scaffold parity (story 1.6)
//
// `template_scaffold` used to read `unsupported`/`unobserved` for every agent on
// a default run. The vocabulary below is what a read-only observer reports when
// it compares each managed role directory, asset by asset, against the template
// at the COMMITTED gitlink -- git objects, never a worktree.
// ---------------------------------------------------------------------------

/**
 * What one asset item says. Mirrors `SCAFFOLD_ASSET_FINDING_KINDS` in
 * `src/scaffold/compare.ts`, which is the pure core both the observer and the
 * recipe rule share; declared here too so the envelope vocabulary lives beside
 * every other `FLEET_STATUS_*` tuple.
 */
export const FLEET_SCAFFOLD_ITEM_KINDS = [
  "missing", "stale-content", "locally-modified", "wrong-mode",
  "wrong-type", "unsafe-symlink", "unexpected-owned", "incomplete",
] as const;
export type FleetScaffoldItemKind = (typeof FLEET_SCAFFOLD_ITEM_KINDS)[number];

/**
 * Why the template SOURCE could not be trusted, when it could not.
 *
 * `ok`                    the committed gitlink is stable, its object exists, the
 *                         worktree is at it and carries no tracked change, and
 *                         every rendered path resolves to one declared group.
 * `gitlink-missing`       the parent's HEAD records no gitlink for the submodule.
 * `gitlink-unstable`      the index gitlink differs from HEAD's -- a staged, uncommitted pin.
 * `source-uninitialized`  the submodule directory is not a repository root.
 * `source-missing-object` the gitlink names a commit the object database does not hold.
 * `source-mismatched`     the worktree HEAD is not the committed gitlink.
 * `source-dirty`          a TRACKED template file is modified (untracked files are not dirt here).
 * `source-contaminated`   the tree at the gitlink carries an excluded pattern (`__pycache__`, `*.pyc`).
 * `source-empty`          the tree at the gitlink renders nothing.
 * `source-unobserved`     a probe failed or timed out before the source could be read.
 * `manifest-uncovered`    a rendered path matches no declared group; the code is suffixed `:<path>`.
 *
 * Any code but `ok` is a HOST finding (`scaffold.source`) and marks every
 * selected agent's eight groups `error`. Desired bytes are never taken from the
 * worktree as a fallback.
 */
export const FLEET_SCAFFOLD_SOURCE_CODES = [
  "ok", "gitlink-missing", "gitlink-unstable", "source-uninitialized", "source-missing-object",
  "source-mismatched", "source-dirty", "source-contaminated", "source-empty", "source-unobserved",
  "manifest-uncovered",
] as const;
export type FleetScaffoldSourceCode = (typeof FLEET_SCAFFOLD_SOURCE_CODES)[number];

/** One asset item on a scaffold group observation. */
export interface FleetStatusObservationItem {
  /** Role-relative, forward slashes. Never absolute. */
  path: string;
  kind: FleetScaffoldItemKind;
  /** A 12-hex blob-id prefix or a type/mode word. Never a body. */
  desired: string | null;
  observed: string | null;
  /** A stable category (`input-missing: display_name`), never a subprocess message. */
  detail: string | null;
  /** The working tree carries an uncommitted change to this path. Orthogonal to the kind. */
  wip: boolean;
}

/** The per-agent scaffold summary. `null` when `template_scaffold` was not selected or no manifest is declared. */
export interface FleetStatusAgentScaffold {
  /** The committed gitlink the comparison ran against, 40-hex. Null when the source was unreadable. */
  source_gitlink: string | null;
  /** The role directory compared, bounded and home-redacted. Null when none could be resolved. */
  role_dir: string | null;
  /** Whether `role_dir` came from the registry row or from the `<project_path>/agents/hermes/<role>` default. */
  role_dir_source: "registry" | "default";
  assets: {
    /** Assets the template renders at the gitlink. */
    owned: number;
    /** Owned assets a comparison completed for. `owned - incomplete`. */
    compared: number;
    matching: number;
    /** Distinct owned paths with at least one drift item. */
    drifted: number;
    /** Owned paths this build could not decide. */
    incomplete: number;
    /** Tracked files inside an owned group the template did not render. */
    unexpected_owned: number;
  };
  /** Owned, drifted paths that ALSO carry an uncommitted change. Capped at `FLEET_STATUS_MAX_WIP_OVERLAP`. */
  wip_overlap: string[];
  /** Modified or untracked entries under the role directory, counted and never named. */
  wip_preserved: number;
  /** Tracked files outside every owned group. Counted, never named. */
  foreign_tracked: number;
  /** Git-ignored entries under the role directory, the runtime directory included. Counted, never named. */
  ignored_entries: number;
}

/** The fleet-level scaffold summary under `data.scaffold`. `null` when `template_scaffold` was not selected. */
export interface FleetScaffoldSummary {
  source: {
    gitlink: string | null;
    integrity: string;
    detail: string;
  };
  /** Counted over EVERY selected agent, before any envelope cap. */
  agents: {
    total_registered: number;
    selected: number;
    /** Selected agents the observer produced a result for. */
    applicable: number;
    passing: number;
    drifted: number;
    incomplete: number;
    /** Drifted agents whose every drifted group a `health_policy.agent_exceptions` entry covers. */
    exception_authorized: number;
    /** `total_registered - selected`, plus selected agents the observer never reached. */
    unobserved: number;
  };
  /** Under `--live`, how the observer and the `hermes.pm-scaffold` rule agreed over the rule-covered subset. */
  rule_agreement: {
    compared: number;
    agree: number;
    disagree: number;
    not_compared: number;
  };
}

/** One agent, every domain, with the per-domain rollup beside the raw observations. */
export interface FleetStatusAgent {
  agent_id: string;
  observations: FleetStatusObservation[];
  /** Every selected domain, rolled up under `FLEET_STATUS_STATE_PRECEDENCE`. */
  domains: Partial<Record<FleetStatusDomain, FleetStatusState>>;
  /** The worst domain state on this record. */
  state: FleetStatusState;
  healthy: boolean;
  complete: boolean;
  /** True when this record's observations were clipped; `retrieval` then names how to get them all. */
  truncated: boolean;
  retrieval: string;
  /** The four activation states, kept apart. Story 1.5. */
  lifecycle: FleetStatusLifecycle;
  /** Exactly one bucket, resolved under `FLEET_STATUS_MEMBER_PRECEDENCE`. */
  member_class: FleetStatusMemberClass;
  /** The scaffold parity summary. Story 1.6. Always present; `null` when the domain was not selected. */
  scaffold: FleetStatusAgentScaffold | null;
}

/**
 * One domain across the whole selection.
 *
 * `observations` carries the FLEET-SCOPED ones (`agent_id: null`) -- emitted
 * exactly once, never copied onto 28 agent records.
 */
export interface FleetStatusDomainRollup {
  domain: FleetStatusDomain;
  state: FleetStatusState;
  counts: Record<FleetStatusState, number>;
  /** Agents carrying at least one observation in this domain. */
  agents: number;
  observations: FleetStatusObservation[];
}

/**
 * One host-scoped rule result, reported ONCE for the machine.
 *
 * Deduped by rule id. It never reaches a per-agent record, never makes an agent
 * or the fleet `healthy: false`, and is never promoted into a registry-wide
 * claim: no amount of work in a repository can change a condition about $HOME,
 * systemd, or the fleet registry.
 */
export interface FleetStatusHostFinding {
  rule_id: string;
  /** Never null on a non-pass: a finding nobody owns is a finding nobody acts on. */
  owner: string | null;
  domain: FleetStatusDomain;
  state: FleetStatusState;
  summary: string;
  details: string[];
  finding_id: string;
  retrieval: string;
  /** The same four axes and derivations an observation carries. Story 1.5. */
  applicability: FleetStatusApplicability;
  evidence: FleetStatusEvidence;
  freshness: FleetStatusFreshness;
  severity: FleetStatusSeverity;
  /** Always `other-owner` for a host rule that needs repair: no repository change reaches it. */
  repair: FleetStatusRepair;
  observed: string | null;
  desired: string | null;
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
  justification: FleetStatusJustification | null;
}

/**
 * A status finding, carrying what the AC7 sort needs and the inventory's does not.
 *
 * `FleetInventoryFinding`'s three-value `severity` stays exactly where it is --
 * it is the inventory's axis and other commands read it. The four fields added
 * here are what let `compareStatusFindings` rank a gating finding above 200
 * low-severity ones BEFORE any cap, which is the failure AC7 names.
 */
export interface FleetStatusFinding extends FleetInventoryFinding {
  domain: FleetStatusDomain;
  scope: "fleet" | "agent" | "host";
  /** Stable across runs and across both adapters, like an observation's. */
  finding_id: string;
  status_severity: FleetStatusSeverity;
  /** Whether this finding is one of the reasons the fleet cannot claim proof. */
  gating: boolean;
}

export interface FleetStatusScope {
  kind: "fleet" | "agent";
  agent_id: string | null;
  /** The single selected domain, or null for all nine. */
  domain: FleetStatusDomain | null;
  live: boolean;
  label: string;
  /** Registered agents in the whole fleet, scope-independent. */
  total_registered_agents: number;
  selected_agents: number;
  selected_domains: FleetStatusDomain[];
  /**
   * Whether this run was correlated against a `--baseline` document.
   *
   * Carried so an empty `transitions[]` can be told apart from no baseline
   * having been read at all -- on the human path those are the same absence and
   * mean opposite things ("nothing moved" versus "nothing was compared").
   */
  baseline: boolean;
}

export interface FleetStatusTotals {
  /** Registered agents in the whole fleet. Equals the inventory's `registered_agents`. */
  agents: number;
  /** Agent records actually carried in `agents`, after the cap. */
  emitted_agents: number;
  /** Observations built, before the per-agent cap. */
  observations: number;
  /** Observations actually carried. */
  emitted_observations: number;
  host_findings: number;
  findings: number;
  /** Recipe-audit children this run intended to start. */
  audits_attempted: number;
  /** Recipe-audit children that returned a parseable report. */
  audits_observed: number;
  by_state: Record<FleetStatusState, number>;
}

export interface FleetStatusHealth {
  /**
   * No `fail` and no `error`, over every observation.
   *
   * Provenance's split, not the inventory's: clipping is deliberately NOT part
   * of this. A truncated but drift-free run is `healthy: true, complete: false`,
   * which is the whole reason there are two verdicts.
   */
  healthy: boolean;
  /** No `unobserved`, no collection error, no truncation. `unsupported` does not reduce it. */
  complete: boolean;
  /** `complete`, AND unfiltered: every registered row and every applicable domain was observed. */
  fleet_complete: boolean;
  failed: number;
  warned: number;
  skipped: number;
  unsupported: number;
  unobserved: number;
  errors: number;
  /** Sources this run could not read at all -- a missing audit CLI, an unparseable child report. */
  collection_errors: number;
  truncated: boolean;
  /**
   * The three-way aggregate, and the one a machine client should read.
   *
   * BESIDE `healthy`, never instead of it:
   *   !healthy                                  -> "unhealthy"  (drift PROVEN)
   *   !complete || stale > 0 || unjustified > 0 -> "unproven"   (nothing proven)
   *   otherwise                                 -> "healthy"
   */
  verdict: FleetStatusVerdict;
  /** `verdict === "healthy"` AND `fleet_complete`. The only thing that means "we read it all and it was right". */
  proven: boolean;
  /** The machine discriminant both adapters carry. `--exit-code` projects it onto a process exit. */
  exit_category: FleetStatusExitCategory;
  /** Observations whose evidence is past its declared `max_age_days`. Blocks `proven`. */
  stale: number;
  /**
   * Observations a freshness policy applies to whose timestamp could not be read.
   *
   * Held apart from `stale` and blocking `proven` just as hard. A policy entry
   * naming a field no row populates buckets every reading `unknown`, and if
   * that did not gate anything the entry would validate, change nothing, and
   * read as though the fleet had been checked -- "we did not look" wearing the
   * freshness axis, which is the exact failure this story exists to prevent.
   */
  freshness_unknown: number;
  /** Non-pass observations no `health_policy` entry authorizes. Blocks `proven`. */
  unjustified: number;
  /** Two sources answering for the same field and disagreeing. Blocks `complete`. */
  contradictions: number;
  /** Every SELECTED agent, in exactly one bucket. Sums to `scope.selected_agents`. */
  members: FleetStatusMembers;
}

export interface FleetStatus {
  contract_path: string;
  contract_version: string | null;
  scope: FleetStatusScope;
  totals: FleetStatusTotals;
  health: FleetStatusHealth;
  agents: FleetStatusAgent[];
  domains: FleetStatusDomainRollup[];
  host: FleetStatusHostFinding[];
  findings: FleetStatusFinding[];
  probes: FleetProbeRecord[];
  /**
   * How every finding moved since the `--baseline` document, or `[]`.
   *
   * Empty when no baseline was supplied AND when the baseline is byte-identical
   * to this run: an unchanged finding emits nothing.
   */
  transitions: FleetStatusTransition[];
  /** The fleet-level scaffold parity summary. Story 1.6. Always present; `null` when the domain was not selected. */
  scaffold: FleetScaffoldSummary | null;
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}
