// Whether a fleet answer is TRUSTWORTHY, and what to do about it.
//
// Story 1.4 reports what every domain observed. It cannot say whether the
// answer can be believed: `health.healthy` is `fail === 0 && error === 0`, so a
// default run over a fleet where three of nine domains have no observer at all
// and every audit-fed domain is `unobserved` still reports `healthy: true`.
// That is precisely what the epic forbids -- an aggregate may never claim
// healthy when a required domain was skipped, truncated, stale, or unobserved.
//
// This module is the evaluator that makes it impossible, and it is a separate
// file on purpose: a truth table wants its own suite, and folding it into a
// 1600-line `status.ts` is how it becomes untestable.
//
// Five disciplines:
//
//   * FOUR AXES, NOT ONE WORD. `state` says what was concluded.
//     `applicability` says whether it was required. `evidence` says how
//     strongly. `freshness` says whether it is still current. Collapsing any
//     two of them is how "we did not look" becomes "it is fine".
//   * ONLY THE CONTRACT CAN JUSTIFY A GAP. A skip, a warning, a deferred
//     capability or a managed exception is authorized only by a
//     `health_policy` entry, and the entry is NAMED on the observation it
//     authorizes. Nothing is inferred, and a contract with no policy block
//     justifies nothing -- which makes `proven` false rather than making the
//     run fail.
//   * SEVERITY, REPAIR AND THE NEXT ACTION COME FROM REAL FIELDS. `fixable`,
//     `rule_scope`, and the contract's own `activation.execution_authority` --
//     never from prose, and never from a keyword scan of a summary.
//   * FRESHNESS IS A BUCKET, NEVER AN AGE. `data` has to be byte-identical
//     across two consecutive runs, and an age in seconds is not. The reference
//     instant is captured once per run by the caller and is never serialized.
//   * A RECOMMENDED COMMAND IS READ-ONLY UNLESS IT IS LABELLED. A
//     `requires-authorization` action must name the authorization in the string
//     itself; this module refuses to emit one that does not.
//
// ONE CONSTRAINT, AND IT IS LOAD-BEARING: this module and `src/fleet/output.ts`
// import each other. `output.ts` needs `compareStatusFindings` and the two sort
// keys so the human report ranks findings exactly as the machine path does, and
// this file needs `bounded`/`redactHome` from there so a next action or a
// justification it builds is bounded on the same terms as every other string in
// the envelope. The cycle is deliberate and it
// is SAFE ONLY BECAUSE NEITHER FILE CALLS THE OTHER AT MODULE SCOPE -- every
// use is inside a function body, so whichever half the bundler initializes
// second still has the first's bindings by the time anything runs.
//
// Do not add a top-level initializer to either file that calls across it. A
// `const X = bounded(...)` here, or a `const Y = compareStatusFindings(...)`
// there, is a `TypeError: ... is not a function` at import time in whichever
// order the bundle happens to emit -- and every suite runs the BUNDLE, so it
// would surface as the whole CLI failing to start rather than as a unit-test
// failure pointing at the line.

import {
  FLEET_STATUS_MAX_TRANSITIONS,
  FLEET_STATUS_MEMBER_PRECEDENCE,
  FLEET_STATUS_SEVERITY_PRECEDENCE,
  FLEET_STATUS_STATES,
  FleetError,
  type FleetClassificationId,
  type FleetContract,
  type FleetHealthPolicy,
  type FleetHealthPolicyAllowedSkip,
  type FleetHealthPolicyAllowedWarning,
  type FleetHealthPolicyDeferredCapability,
  type FleetHealthPolicyFreshness,
  type FleetStatusApplicability,
  type FleetStatusDomain,
  type FleetStatusEvidence,
  type FleetStatusExitCategory,
  type FleetStatusFreshness,
  type FleetStatusHealth,
  type FleetStatusHostFinding,
  type FleetStatusJustification,
  type FleetStatusMemberClass,
  type FleetStatusMembers,
  type FleetStatusNextActionClass,
  type FleetStatusObservation,
  type FleetStatusRepair,
  type FleetStatusScope,
  type FleetStatusSeverity,
  type FleetStatusState,
  type FleetStatusTransition,
  type FleetStatusTransitionKind,
  type FleetStatusVerdict,
} from "./types";
import { bounded, redactHome } from "./output";

/** One day, in milliseconds. The unit `max_age_days` is declared in. */
const DAY_MS = 86_400_000;

/**
 * Scope order for the finding sort, broadest blast radius first.
 *
 * A fleet-scoped finding is true of everything, a host one of this machine, an
 * agent one of a single row -- so an operator reading a capped list sees the
 * widest statement before the narrowest. Read by `compareStatusFindings`.
 */
const SCOPE_ORDER = ["fleet", "host", "agent"] as const;

/**
 * The policy, indexed for lookup, with every entry keeping its contract path.
 *
 * `declared` is held apart from "the lists are empty": a contract that declares
 * an EMPTY policy has made a decision, and a contract with no block at all has
 * not. The second raises a finding naming the missing block; the first does not.
 */
export interface FleetHealthPolicyView {
  declared: boolean;
  requiredDomains: ReadonlySet<string>;
  deferred: ReadonlyArray<{ path: string; entry: FleetHealthPolicyDeferredCapability }>;
  warnings: ReadonlyArray<{ path: string; entry: FleetHealthPolicyAllowedWarning }>;
  skips: ReadonlyArray<{ path: string; entry: FleetHealthPolicyAllowedSkip }>;
  freshness: ReadonlyArray<{ path: string; entry: FleetHealthPolicyFreshness }>;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Read the contract's `health_policy` into the shape this module looks things up in.
 *
 * The block is already validated by `validateHealthPolicy` when it reaches
 * here, so this does no re-checking -- it only indexes. A missing block yields
 * a view whose lists are empty and whose `requiredDomains` is empty, and the
 * CALLER decides what an empty `requiredDomains` means (it treats every domain
 * as required, which is the conservative reading, never the flattering one).
 */
export function readHealthPolicy(contract: Pick<FleetContract, "health_policy">): FleetHealthPolicyView {
  const block: FleetHealthPolicy | undefined = contract.health_policy;
  if (!block) {
    return { declared: false, requiredDomains: new Set(), deferred: [], warnings: [], skips: [], freshness: [] };
  }
  return {
    declared: true,
    requiredDomains: new Set(list<string>(block.required_domains)),
    deferred: list<FleetHealthPolicyDeferredCapability>(block.deferred_capabilities)
      .map((entry, index) => ({ path: `health_policy.deferred_capabilities[${index}]`, entry })),
    warnings: list<FleetHealthPolicyAllowedWarning>(block.allowed_warnings)
      .map((entry, index) => ({ path: `health_policy.allowed_warnings[${index}]`, entry })),
    skips: list<FleetHealthPolicyAllowedSkip>(block.allowed_skips)
      .map((entry, index) => ({ path: `health_policy.allowed_skips[${index}]`, entry })),
    freshness: list<FleetHealthPolicyFreshness>(block.freshness)
      .map((entry, index) => ({ path: `health_policy.freshness[${index}]`, entry })),
  };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Whether one recorded timestamp is still current, as a BUCKET.
 *
 * NEVER an age, and never a duration: two runs milliseconds apart have to
 * produce byte-identical `data`, so the only thing that may cross into the
 * envelope is which side of the declared threshold the value falls on. The
 * reference instant is the caller's, captured once per run and never
 * serialized.
 *
 * `not_applicable` means no policy entry claims this field -- most observations
 * have no timestamp behind them at all. `unknown` means one DOES and the value
 * is absent or unparseable, which is a different problem and must not collapse
 * into the first.
 */
export function evaluateFreshness(
  field: string | null,
  isoValue: string | null,
  referenceMs: number,
  policy: FleetHealthPolicyView,
): FleetStatusFreshness {
  if (field === null) return "not_applicable";
  const declared = policy.freshness.find((item) => item.entry.field === field);
  if (!declared) return "not_applicable";
  if (isoValue === null || isoValue.trim() === "") return "unknown";
  const parsed = Date.parse(isoValue.trim());
  if (!Number.isFinite(parsed)) return "unknown";
  // A timestamp in the FUTURE is not fresh evidence, it is a clock nobody can
  // reason about. Reported `unknown` rather than silently `current`.
  if (parsed > referenceMs) return "unknown";
  return referenceMs - parsed <= declared.entry.max_age_days * DAY_MS ? "current" : "stale";
}

/** Bucket precedence when several policy entries apply to one observation. Worst wins. */
const FRESHNESS_PRECEDENCE = ["stale", "unknown", "current", "not_applicable"] as const satisfies readonly FleetStatusFreshness[];

/**
 * Fold every freshness entry that applies to one domain into a single bucket.
 *
 * Worst wins, under `FRESHNESS_PRECEDENCE`: an agent whose board was confirmed
 * within the window but whose identifier was fetched years ago is stale, and
 * reporting the better of the two readings is exactly the first-wins mask the
 * host block already had to have removed from it.
 */
export function evaluateDomainFreshness(
  domain: FleetStatusDomain,
  values: ReadonlyMap<string, string | null>,
  referenceMs: number,
  policy: FleetHealthPolicyView,
): FleetStatusFreshness {
  const buckets = policy.freshness
    .filter((item) => item.entry.applies_to === domain)
    .map((item) => evaluateFreshness(item.entry.field, values.get(item.entry.field) ?? null, referenceMs, policy));
  for (const bucket of FRESHNESS_PRECEDENCE) if (buckets.includes(bucket)) return bucket;
  return "not_applicable";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Everything the four axes and their derivations need, and nothing more. */
export interface FleetHealthObservationInput {
  domain: FleetStatusDomain;
  state: FleetStatusState;
  field: string;
  ruleId: string | null;
  ruleScope: "project" | "host" | null;
  source: string;
  /** The `health_policy.deferred_capabilities` capability this answers for, if any. */
  capability: string | null;
  /** Explicit evidence, where the construction site knows better than the source table. */
  evidence: FleetStatusEvidence | null;
  /** The audit rule's own `fixable`, verbatim. Null where no rule is behind the observation. */
  fixable: boolean | null;
  /** The `classifications.intentionally_unmanaged` entry covering this, if any. */
  exceptionId: string | null;
  exceptionReason: string | null;
  freshness: FleetStatusFreshness;
  /** The repository a `pjangler migrate` invocation would name, home-redacted. */
  repo: string | null;
  /** The command that returns this observation on its own. Always read-only. */
  retrieval: string;
  /** `activation.execution_authority.field`, read from the contract. */
  activationField: string;
  /** `activation.execution_authority.owner`, read from the contract. */
  activationOwner: string;
}

export interface FleetHealthClassification {
  applicability: FleetStatusApplicability;
  evidence: FleetStatusEvidence;
  freshness: FleetStatusFreshness;
  severity: FleetStatusSeverity;
  repair: FleetStatusRepair;
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
  justification: FleetStatusJustification | null;
}

/**
 * Evidence a source produces when the construction site declares none.
 *
 * A store read, a provenance comparison and a recipe rule all READ something;
 * a declared gap reads nothing by definition. Sites that know better -- the
 * Bloodbank routing record is a registry field nothing verified -- pass their
 * own value and this table never sees them.
 */
const SOURCE_EVIDENCE: Readonly<Record<string, FleetStatusEvidence>> = Object.freeze({
  "fleet-inventory": "direct",
  "fleet-provenance": "direct",
  "recipe-audit": "direct",
  "declared-gap": "absent",
});

/** States in which nothing was actually read, whatever the source would imply. */
const UNREAD_STATES: ReadonlySet<FleetStatusState> = new Set<FleetStatusState>(["unobserved", "unsupported", "error"]);

/**
 * Which contract entry, if any, authorizes this gap.
 *
 * Order matters and is the order the four lists are declared in: a deferred
 * capability is the strongest statement (no observer exists at all), an
 * exception is an operator ruling on a specific pair of claimants, and the two
 * rule lists are the narrowest. Nothing here is inferred from a summary, a
 * severity, or the absence of other findings.
 */
export function resolveJustification(
  input: Pick<FleetHealthObservationInput, "domain" | "state" | "ruleId" | "capability" | "exceptionId" | "exceptionReason">,
  policy: FleetHealthPolicyView,
): FleetStatusJustification | null {
  if (input.state === "unsupported") {
    const deferred = policy.deferred.find((item) => (
      item.entry.domain === input.domain
      && (item.entry.capability === undefined || item.entry.capability === input.capability)
    ));
    if (deferred) {
      return {
        kind: "deferred_capability",
        policy: deferred.path,
        reason: bounded(deferred.entry.reason),
        owner: bounded(deferred.entry.owner_story),
      };
    }
  }
  if (input.exceptionId !== null) {
    return {
      kind: "exception",
      policy: `classifications.intentionally_unmanaged.entries.${bounded(input.exceptionId, 128)}`,
      reason: bounded(input.exceptionReason ?? "a managed exception the contract records for exactly these participants"),
      owner: null,
    };
  }
  if (input.state === "warn" && input.ruleId !== null) {
    const allowed = policy.warnings.find((item) => item.entry.rule_id === input.ruleId);
    if (allowed) {
      return { kind: "allowed_warning", policy: allowed.path, reason: bounded(allowed.entry.reason), owner: bounded(allowed.entry.owner) };
    }
  }
  if (input.state === "skip") {
    const allowed = policy.skips.find((item) => (
      (item.entry.rule_id !== undefined && item.entry.rule_id === input.ruleId)
      || (item.entry.domain !== undefined && item.entry.domain === input.domain)
    ));
    if (allowed) {
      return { kind: "allowed_skip", policy: allowed.path, reason: bounded(allowed.entry.reason), owner: null };
    }
  }
  return null;
}

/** States that carry a gap somebody has to authorize before the fleet can claim proof. */
export function needsJustification(state: FleetStatusState): boolean {
  return state === "warn" || state === "skip" || state === "unsupported";
}

/**
 * The four axes, plus the severity, repair class and one exact next action.
 *
 * Every derivation reads a real field. `applicability` reads
 * `health_policy.required_domains` and the observation's own state.
 * `evidence` reads the source and the state. `severity` is `state` x
 * `applicability` and nothing else. `repair` reads the audit rule's `fixable`,
 * its `rule_scope`, and the contract's `activation.execution_authority` -- so a
 * summary can be reworded without silently changing what an operator is told to
 * do about it.
 */
export function classifyObservation(
  input: FleetHealthObservationInput,
  policy: FleetHealthPolicyView,
): FleetHealthClassification {
  const justification = resolveJustification(input, policy);

  const evidence: FleetStatusEvidence = input.evidence
    ?? (UNREAD_STATES.has(input.state) ? "absent" : SOURCE_EVIDENCE[input.source] ?? "derived");

  // A contract with NO policy block declares no required domains, and every
  // domain is then required: an aggregate that has been told nothing must not
  // infer that nothing matters.
  const domainRequired = !policy.declared || policy.requiredDomains.size === 0
    ? true
    : policy.requiredDomains.has(input.domain);

  let applicability: FleetStatusApplicability;
  if (justification?.kind === "deferred_capability") applicability = "deferred";
  else if (justification?.kind === "exception") applicability = "exception";
  else if (input.state === "skip") applicability = "not_applicable";
  else applicability = domainRequired ? "required" : "optional";

  const justified = justification !== null;
  const stale = input.freshness === "stale";
  const severity = deriveSeverity(input.state, applicability, justified, stale);
  const { repair, next_action, next_action_class } = deriveRepair(input, justification);

  return { applicability, evidence, freshness: input.freshness, severity, repair, next_action, next_action_class, justification };
}

/**
 * Severity is `state` x `applicability`, with justification and staleness as the
 * two modifiers.
 *
 * The one row worth stating out loud: an UNJUSTIFIED `unsupported` is `medium`
 * where a justified one is `low`. They are the same observation about the same
 * build; the difference is whether anybody wrote down that it was expected, and
 * that difference is the whole point of the policy block.
 */
export function deriveSeverity(
  state: FleetStatusState,
  applicability: FleetStatusApplicability,
  justified: boolean,
  stale: boolean,
): FleetStatusSeverity {
  if (state === "error") return "critical";
  if (state === "fail") return applicability === "required" ? "critical" : "high";
  if (state === "unobserved") return applicability === "required" ? "high" : "medium";
  // Staleness outranks the remaining states: a `pass` read off evidence past
  // its declared window is not a pass anybody should act on.
  if (stale) return justified ? "low" : "medium";
  if (state === "warn" || state === "unsupported") return justified ? "low" : "medium";
  if (state === "skip") return justified ? "info" : "low";
  return "info";
}

interface RepairDecision {
  repair: FleetStatusRepair;
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
}

/**
 * Who can repair this, and the one exact thing to do about it.
 *
 * The order is the derivation table, and each branch reads a field rather than
 * a phrase:
 *
 *   automatic       an audit rule, project-scoped, reporting `fixable: true`
 *   approval-gated  the observation's field IS `activation.execution_authority`
 *   blocked         a contract-declared deferred capability
 *   other-owner     `rule_scope: "host"`
 *   manual          everything else that needs a decision
 *   none            a pass, or a declared-not-applicable skip
 */
function deriveRepair(
  input: FleetHealthObservationInput,
  justification: FleetStatusJustification | null,
): RepairDecision {
  const readOnly = (next_action: string, repair: FleetStatusRepair): RepairDecision => (
    { repair, next_action: bounded(redactHome(next_action)), next_action_class: "read-only" }
  );

  if (input.state === "pass" && input.freshness !== "stale") return readOnly(input.retrieval, "none");
  if (input.state === "skip" && justification !== null) return readOnly(input.retrieval, "none");

  // The gate, and it is the contract's own field -- not a keyword and not the
  // domain. `strict: true, default: deny` means no repository change can grant
  // it, so the action has to NAME the authority that can, or the label is the
  // only thing between an operator and a command they cannot run.
  if (input.field === input.activationField) {
    return {
      repair: "approval-gated",
      next_action: bounded(
        `Request execution authority from ${input.activationOwner}: ${input.activationField} is strict with a declared default of deny, `
        + "and no change in any repository grants it",
      ),
      next_action_class: "requires-authorization",
    };
  }

  if (justification?.kind === "deferred_capability") {
    return readOnly(
      `Nothing to run in this release: ${input.capability ?? input.domain} is deferred to story ${justification.owner ?? "unnamed"}; `
      + `re-read it with ${input.retrieval}`,
      "blocked",
    );
  }

  if (input.ruleScope === "host") {
    return readOnly(
      `Repair the host condition ${input.ruleId ?? input.domain} reports on this machine; no work in any repository changes it. `
      + `Re-read it with ${input.retrieval}`,
      "other-owner",
    );
  }

  if (input.ruleScope === "project" && input.ruleId !== null && input.fixable === true) {
    // The migration recipe is addressed by rule id and repository, and it is
    // handed over as a DRY RUN: a next action a caller may run unread has to be
    // one that changes nothing.
    const repo = input.repo ?? ".";
    return readOnly(`pjangler migrate ${input.ruleId} ${repo} --dry-run`, "automatic");
  }

  return readOnly(input.retrieval, "manual");
}

// ---------------------------------------------------------------------------
// Contradiction
// ---------------------------------------------------------------------------

/** Two sources answering for one field, and disagreeing about it. */
export interface FleetStatusContradiction {
  agent_id: string | null;
  domain: FleetStatusDomain;
  field: string;
  finding_ids: string[];
  detail: string;
}

/** States that assert the thing is WRONG, as opposed to unread. */
const PROVEN_BAD: ReadonlySet<FleetStatusState> = new Set<FleetStatusState>(["fail", "error"]);

/**
 * Every `(agent_id, domain, field)` two sources answered for and disagreed about.
 *
 * A generalization of the host block's worst-wins accumulator, which already
 * proves the pattern: keep every reading, report the worst, record the
 * disagreement as data. Never resolve one by choosing the more favourable value
 * and never drop either side.
 *
 * Only observations that actually READ something take part (`evidence` is not
 * `absent`). A store read proving a symlinked profile beside an audit half that
 * was never run is not a disagreement -- it is one reading and one silence, and
 * calling it a contradiction would fire on every default run.
 */
export function detectContradictions(observations: readonly FleetStatusObservation[]): FleetStatusContradiction[] {
  const groups = new Map<string, FleetStatusObservation[]>();
  for (const observation of observations) {
    if (observation.evidence === "absent") continue;
    // `\u0000` as an ESCAPE, never a literal NUL byte: a raw NUL makes GNU grep
    // treat this source as binary, which silently no-ops the machine-wide
    // pre-commit credential scan for every commit touching the file.
    const key = [observation.agent_id ?? "", observation.domain, observation.field].join("\u0000");
    const bucket = groups.get(key);
    if (bucket) bucket.push(observation);
    else groups.set(key, [observation]);
  }

  const out: FleetStatusContradiction[] = [];
  for (const bucket of groups.values()) {
    const bad = bucket.filter((item) => PROVEN_BAD.has(item.state));
    const good = bucket.filter((item) => item.state === "pass");
    if (bad.length === 0 || good.length === 0) continue;
    const sources = [...new Set([...bad, ...good].map((item) => item.source))];
    // One source reporting both is not a contradiction between sources; it is a
    // domain with several fields under one path, which is normal.
    if (sources.length < 2) continue;
    const first = bad[0]!;
    out.push({
      agent_id: first.agent_id,
      domain: first.domain,
      field: first.field,
      finding_ids: [...bad, ...good].map((item) => item.finding_id).sort(),
      detail:
        `${bad.map((item) => `${item.source} reports ${item.state}`).join(", ")} while `
        + `${good.map((item) => `${item.source} reports pass`).join(", ")} for the same field; `
        + "both readings are kept, the worse one wins the rollup, and neither is discarded",
    });
  }
  return out.sort((a, b) => (
    (a.agent_id ?? "") < (b.agent_id ?? "") ? -1 : (a.agent_id ?? "") > (b.agent_id ?? "") ? 1
      : a.domain < b.domain ? -1 : a.domain > b.domain ? 1
        : a.field < b.field ? -1 : a.field > b.field ? 1 : 0
  ));
}

// ---------------------------------------------------------------------------
// Member classes
// ---------------------------------------------------------------------------

/**
 * Which single bucket one agent lands in.
 *
 * Every candidate class is collected first and the answer is then resolved by
 * walking `FLEET_STATUS_MEMBER_PRECEDENCE` -- so reordering that constant moves
 * behaviour, which is what makes it a rule rather than a comment.
 *
 * `exception` is reachable only for an agent whose EVERY proven failure carries
 * an exception justification. An operator ruling on one shared profile must
 * never absorb an unrelated symlinked one.
 */
export function classifyMember(
  agent: { healthy: boolean; complete: boolean },
  classification: FleetClassificationId,
  observations: readonly FleetStatusObservation[],
): FleetStatusMemberClass {
  const candidates = new Set<FleetStatusMemberClass>();

  if (classification === "unclassified") candidates.add("unclassified");

  const failures = observations.filter((item) => PROVEN_BAD.has(item.state));
  if (!agent.healthy) {
    const allExcepted = failures.length > 0 && failures.every((item) => item.justification?.kind === "exception");
    candidates.add(allExcepted ? "exception" : "unhealthy");
  } else if (classification === "intentionally_unmanaged") {
    candidates.add("exception");
  }

  if (!agent.complete) candidates.add("incomplete");

  const gaps = observations.filter((item) => item.state !== "pass" && item.state !== "skip");
  if (gaps.length > 0 && gaps.every((item) => item.justification?.kind === "deferred_capability")) {
    candidates.add("deferred");
  }

  for (const member of FLEET_STATUS_MEMBER_PRECEDENCE) if (candidates.has(member)) return member;
  return "healthy";
}

export function emptyMembers(): FleetStatusMembers {
  return { healthy: 0, unhealthy: 0, incomplete: 0, deferred: 0, exception: 0, unclassified: 0 };
}

// ---------------------------------------------------------------------------
// The finding sort
// ---------------------------------------------------------------------------

/**
 * The axes AC7's sort ranks by, whatever kind of record carries them.
 *
 * `status_severity` rather than `severity` on purpose: `FleetStatusFinding`
 * carries BOTH -- the inventory's three-value `severity`, which other commands
 * read, and the five-value status axis this sort ranks by. One name for two
 * scales is how a sort silently starts ranking by the wrong one.
 */
export interface FleetStatusSortable {
  gating: boolean;
  status_severity: FleetStatusSeverity;
  scope: "fleet" | "agent" | "host";
  agent_id: string | null;
  domain: string;
  finding_id: string;
}

/**
 * Whether one observation is a reason the fleet cannot claim proof.
 *
 * The same four conditions `evaluateFleetHealth` reads, asked of a single
 * record: a proven failure, an unread half, evidence past its window, or a gap
 * nobody authorized. Derived from the observation rather than declared beside
 * it, so the sort cannot drift away from the verdict it is sorting for.
 */
export function observationGates(observation: FleetStatusObservation): boolean {
  if (observation.state === "fail" || observation.state === "error" || observation.state === "unobserved") return true;
  if (observation.freshness === "stale") return true;
  return needsJustification(observation.state) && observation.justification === null;
}

/** One observation, as the sort sees it. */
export function observationSortKey(observation: FleetStatusObservation): FleetStatusSortable {
  return {
    gating: observationGates(observation),
    status_severity: observation.severity,
    scope: observation.agent_id === null ? "fleet" : "agent",
    agent_id: observation.agent_id,
    domain: observation.domain,
    finding_id: observation.finding_id,
  };
}

/**
 * One host finding, as the sort sees it.
 *
 * `gating` is always false, and that is not an oversight: a host-scoped finding
 * is in NEITHER verdict, so it cannot be a reason the fleet fails to claim
 * proof. It still sorts by severity among its peers.
 */
export function hostSortKey(finding: FleetStatusHostFinding): FleetStatusSortable {
  return {
    gating: false,
    status_severity: finding.severity,
    scope: "host",
    agent_id: null,
    domain: finding.domain,
    finding_id: finding.finding_id,
  };
}

function severityRank(severity: FleetStatusSeverity): number {
  const index = (FLEET_STATUS_SEVERITY_PRECEDENCE as readonly FleetStatusSeverity[]).indexOf(severity);
  return index === -1 ? FLEET_STATUS_SEVERITY_PRECEDENCE.length : index;
}

function scopeRank(scope: FleetStatusSortable["scope"]): number {
  const index = (SCOPE_ORDER as readonly string[]).indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

/**
 * Gating impact, then severity, then scope, then agent, then domain, then id.
 *
 * Applied BEFORE any cap, on both the machine and the human path. A list capped
 * at 25 in arrival order drops a gating finding at position 26 and reports the
 * remaining 25 as if they were the worst of them -- which is exactly the "one
 * high-volume domain hides a higher-priority blocker" failure the sort exists
 * to prevent.
 *
 * `finding_id` is the final tiebreak so the order is TOTAL: two findings that
 * tie on every other axis must still sort identically on both adapters, or the
 * CLI/MCP deep-equality assertion becomes a coin toss.
 */
export function compareStatusFindings(a: FleetStatusSortable, b: FleetStatusSortable): number {
  if (a.gating !== b.gating) return a.gating ? -1 : 1;
  const bySeverity = severityRank(a.status_severity) - severityRank(b.status_severity);
  if (bySeverity !== 0) return bySeverity;
  const byScope = scopeRank(a.scope) - scopeRank(b.scope);
  if (byScope !== 0) return byScope;
  const left = a.agent_id ?? "";
  const right = b.agent_id ?? "";
  if (left !== right) return left < right ? -1 : 1;
  if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
  if (a.finding_id !== b.finding_id) return a.finding_id < b.finding_id ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Baseline correlation
// ---------------------------------------------------------------------------

/** One finding as the diff sees it: an identity and the three axes that can move. */
export interface FleetStatusFindingSnapshot {
  finding_id: string;
  scope: "fleet" | "agent" | "host";
  agent_id: string | null;
  domain: FleetStatusDomain;
  state: FleetStatusState;
  severity: FleetStatusSeverity;
  evidence: FleetStatusEvidence;
}

function snapshotOf(record: {
  finding_id?: unknown; agent_id?: unknown; domain?: unknown;
  state?: unknown; severity?: unknown; evidence?: unknown; rule_id?: unknown;
}, scope: FleetStatusFindingSnapshot["scope"]): FleetStatusFindingSnapshot | null {
  const id = typeof record.finding_id === "string" ? record.finding_id : null;
  if (id === null || id === "") return null;
  const state = typeof record.state === "string" && (FLEET_STATUS_STATES as readonly string[]).includes(record.state)
    ? record.state as FleetStatusState
    : null;
  if (state === null) return null;
  const severity = typeof record.severity === "string" && (FLEET_STATUS_SEVERITY_PRECEDENCE as readonly string[]).includes(record.severity)
    ? record.severity as FleetStatusSeverity
    : "info";
  const evidence = typeof record.evidence === "string" ? record.evidence as FleetStatusEvidence : "absent";
  return {
    finding_id: id,
    scope,
    agent_id: typeof record.agent_id === "string" ? record.agent_id : null,
    domain: (typeof record.domain === "string" ? record.domain : "registry") as FleetStatusDomain,
    state,
    severity,
    evidence,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every observation and host finding of one status document, as diff input.
 *
 * Accepts either a fleet ENVELOPE or a bare `data` payload, because both are
 * things an operator plausibly has on disk: `fleet status --json > base.json`
 * writes the envelope, and a pipeline that already unwrapped it writes the
 * payload. Refusing one of them would be a papercut with no upside.
 */
export function snapshotStatusDocument(document: unknown): FleetStatusFindingSnapshot[] {
  const root = isRecord(document) && isRecord(document.data) ? document.data : document;
  if (!isRecord(root)) return [];
  const out: FleetStatusFindingSnapshot[] = [];
  for (const agent of Array.isArray(root.agents) ? root.agents : []) {
    if (!isRecord(agent)) continue;
    for (const observation of Array.isArray(agent.observations) ? agent.observations : []) {
      if (!isRecord(observation)) continue;
      const snapshot = snapshotOf(observation, "agent");
      if (snapshot) out.push(snapshot);
    }
  }
  for (const rollup of Array.isArray(root.domains) ? root.domains : []) {
    if (!isRecord(rollup)) continue;
    for (const observation of Array.isArray(rollup.observations) ? rollup.observations : []) {
      if (!isRecord(observation)) continue;
      const snapshot = snapshotOf(observation, "fleet");
      if (snapshot) out.push(snapshot);
    }
  }
  for (const finding of Array.isArray(root.host) ? root.host : []) {
    if (!isRecord(finding)) continue;
    const snapshot = snapshotOf(finding, "host");
    if (snapshot) out.push(snapshot);
  }
  return out;
}

/**
 * The CURRENT run's findings, as diff input.
 *
 * Built from every observation the run made and every host finding, not from
 * the clipped records the envelope carries: a transition is a conclusion, and a
 * bound on what the envelope carries must never move what it concludes.
 */
export function snapshotCurrent(
  observations: readonly FleetStatusObservation[],
  host: readonly FleetStatusHostFinding[],
): FleetStatusFindingSnapshot[] {
  const out: FleetStatusFindingSnapshot[] = [];
  for (const observation of observations) {
    out.push({
      finding_id: observation.finding_id,
      scope: observation.agent_id === null ? "fleet" : "agent",
      agent_id: observation.agent_id,
      domain: observation.domain,
      state: observation.state,
      severity: observation.severity,
      evidence: observation.evidence,
    });
  }
  for (const finding of host) {
    out.push({
      finding_id: finding.finding_id,
      scope: "host",
      agent_id: null,
      domain: finding.domain,
      state: finding.state,
      severity: finding.severity,
      evidence: finding.evidence,
    });
  }
  return out;
}

/**
 * Parse a `--baseline` document, or refuse it by name.
 *
 * An unreadable or unparseable baseline is `INVALID_INPUT` and nothing else: it
 * is a caller mistake, it is detectable before a single child is spawned, and
 * silently treating it as "no baseline" would report an empty `transitions[]`
 * that reads exactly like "nothing changed".
 */
export function parseBaselineDocument(text: string, shownPath: string): FleetStatusFindingSnapshot[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch {
    throw new FleetError(
      "INVALID_INPUT",
      "--baseline is not one complete JSON document",
      false,
      { baseline: bounded(shownPath) },
    );
  }
  const snapshots = snapshotStatusDocument(parsed);
  if (snapshots.length === 0 && !(isRecord(parsed) && (Array.isArray(parsed.agents) || isRecord(parsed.data)))) {
    throw new FleetError(
      "INVALID_INPUT",
      "--baseline is JSON but is not a fleet status document",
      false,
      { baseline: bounded(shownPath) },
    );
  }
  return snapshots;
}

/**
 * How every finding moved between two runs.
 *
 * Joined on `finding_id`, which is a sha256 prefix over the tuple that
 * identifies an observation -- stable across runs, across the CLI and MCP
 * adapters, and independent of arrival order. An UNCHANGED finding emits
 * nothing at all, so a byte-identical baseline produces an empty array and the
 * absence of a transition is itself the answer.
 *
 * Nothing is persisted to compute this. The baseline is a document the operator
 * supplies; this command never writes state to disk.
 */
export function diffFindings(
  baseline: readonly FleetStatusFindingSnapshot[],
  current: readonly FleetStatusFindingSnapshot[],
): FleetStatusTransition[] {
  const before = new Map<string, FleetStatusFindingSnapshot>();
  for (const item of baseline) if (!before.has(item.finding_id)) before.set(item.finding_id, item);
  const after = new Map<string, FleetStatusFindingSnapshot>();
  for (const item of current) if (!after.has(item.finding_id)) after.set(item.finding_id, item);

  const transitions: FleetStatusTransition[] = [];
  const push = (
    kind: FleetStatusTransitionKind,
    subject: FleetStatusFindingSnapshot,
    from: FleetStatusFindingSnapshot | null,
    to: FleetStatusFindingSnapshot | null,
    detail: string,
  ): void => {
    transitions.push({
      finding_id: subject.finding_id,
      kind,
      scope: subject.scope,
      agent_id: subject.agent_id,
      domain: subject.domain,
      from: from ? { state: from.state, severity: from.severity, evidence: from.evidence } : null,
      to: to ? { state: to.state, severity: to.severity, evidence: to.evidence } : null,
      detail: bounded(detail),
    });
  };

  for (const [id, now] of after) {
    const then = before.get(id);
    if (!then) { push("appeared", now, null, now, `${now.domain} ${now.state}: not present in the baseline`); continue; }
    // One finding can move on more than one axis at once, and each kind is its
    // own row: an operator filtering for `severity_changed` must not miss one
    // because the state moved in the same run.
    if (then.state !== now.state) push("state_changed", now, then, now, `${then.state} -> ${now.state}`);
    if (then.severity !== now.severity) push("severity_changed", now, then, now, `${then.severity} -> ${now.severity}`);
    if (then.evidence !== now.evidence) push("evidence_changed", now, then, now, `${then.evidence} -> ${now.evidence}`);
  }
  for (const [id, then] of before) {
    if (after.has(id)) continue;
    push("resolved", then, then, null, `${then.domain} ${then.state}: no longer reported`);
  }

  return transitions.sort((a, b) => (
    a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1
      : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  ));
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

export interface FleetHealthInput {
  /**
   * Every SELECTED agent's observations plus the fleet-scoped ones.
   *
   * NOT the emitted ones. A bound on what the envelope CARRIES must never move
   * what it CONCLUDES -- the defect story 1.4's review found twice.
   */
  observations: readonly FleetStatusObservation[];
  members: FleetStatusMembers;
  collectionErrors: number;
  contradictions: number;
  truncated: boolean;
  scope: FleetStatusScope;
  totalAgents: number;
  emittedAgents: number;
}

/**
 * The verdicts, and which of them a caller should read.
 *
 * `healthy` keeps story 1.4's meaning EXACTLY -- no `fail` and no `error` --
 * because a clean scoped slice reading `healthy: true` is a criterion 1.4 pins,
 * and because the provenance split that keeps "the fleet is wrong" apart from
 * "this run did not see all of it" is worth more than one word that means
 * neither. `complete` keeps its coverage meaning and gains exactly one new
 * conjunct, `contradictions === 0`, which can only ever make it falser.
 *
 * `verdict` is the aggregate built ON TOP of those two:
 *
 *   !healthy                                  -> "unhealthy"  drift is PROVEN
 *   !complete || stale > 0 || unjustified > 0 -> "unproven"   nothing is proven
 *   otherwise                                 -> "healthy"
 *
 * and `proven` is `verdict === "healthy" && fleet_complete`, which is the only
 * field in the document that means "we read all of it and it was right".
 */
export function evaluateFleetHealth(input: FleetHealthInput): FleetStatusHealth {
  const byState = Object.fromEntries(FLEET_STATUS_STATES.map((state) => [state, 0])) as Record<FleetStatusState, number>;
  let stale = 0;
  let unjustified = 0;
  for (const observation of input.observations) {
    byState[observation.state] += 1;
    if (observation.freshness === "stale") stale += 1;
    if (needsJustification(observation.state) && observation.justification === null) unjustified += 1;
  }

  const healthy = byState.fail === 0 && byState.error === 0;
  const complete = byState.unobserved === 0
    && byState.error === 0
    && input.collectionErrors === 0
    && !input.truncated
    && input.contradictions === 0;
  const fleetComplete = complete
    && input.scope.kind === "fleet"
    && input.scope.domain === null
    && input.scope.live
    && input.totalAgents > 0
    && input.emittedAgents === input.totalAgents;

  const verdict: FleetStatusVerdict = !healthy
    ? "unhealthy"
    : (!complete || stale > 0 || unjustified > 0) ? "unproven" : "healthy";
  // A proven failure is more actionable than an unread half, so `unhealthy`
  // outranks `incomplete` when both apply -- which the verdict has already
  // decided, because it is a single value rather than two flags.
  const exitCategory: FleetStatusExitCategory = verdict === "unhealthy"
    ? "unhealthy"
    : verdict === "unproven" ? "incomplete" : "ok";

  return {
    healthy,
    complete,
    fleet_complete: fleetComplete,
    failed: byState.fail,
    warned: byState.warn,
    skipped: byState.skip,
    unsupported: byState.unsupported,
    unobserved: byState.unobserved,
    errors: byState.error,
    collection_errors: input.collectionErrors,
    truncated: input.truncated,
    verdict,
    proven: verdict === "healthy" && fleetComplete,
    exit_category: exitCategory,
    stale,
    unjustified,
    contradictions: input.contradictions,
    members: { ...input.members },
  };
}

/** Cap the transitions an envelope carries, recording the clip rather than slicing in silence. */
export function boundTransitions(
  transitions: readonly FleetStatusTransition[],
  truncated: string[],
): FleetStatusTransition[] {
  if (transitions.length <= FLEET_STATUS_MAX_TRANSITIONS) return [...transitions];
  truncated.push(
    `transitions: ${transitions.length - FLEET_STATUS_MAX_TRANSITIONS} of ${transitions.length} transitions dropped; `
    + "narrow the run with --agent or --domain and re-diff against the same baseline",
  );
  return transitions.slice(0, FLEET_STATUS_MAX_TRANSITIONS);
}
