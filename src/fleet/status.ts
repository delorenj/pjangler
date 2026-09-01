// Registry-wide, strictly read-only fleet STATUS.
//
// Story 1.2 answers "what is the fleet". Story 1.3 answers "which build does
// each agent run". Neither answers the question an operator actually asks:
// **is the fleet correct?** Nine observation domains existed as scattered
// per-repository audits, and nothing traversed the registry once and reported
// all of them together.
//
// This module is that traversal. One core, two thin adapters
// (`pjangler fleet status`, MCP `pjangler_fleet_status`), one aggregate plus one
// stable per-agent record covering ALL NINE domains -- each either observed or
// carrying an explicit `unobserved`/`unsupported` observation with a reason.
//
// Five disciplines make the answer trustworthy rather than merely printable:
//
//   * NO DOMAIN MAY DISAPPEAR. Every one of the nine appears on every agent
//     record and in `data.domains`, always. Silently dropping a domain is the
//     one outcome this module exists to prevent, so absence is expressed as a
//     state with a reason, never as a missing key.
//   * HOST IS NOT PROJECT. A rule whose `scope` is `host` (systemd, $HOME, the
//     fleet registry, the global skill projection) is reported ONCE, deduped by
//     rule id, in `data.host`. It never reaches a per-agent record, never makes
//     an agent or the fleet unhealthy, and is never promoted into a
//     registry-wide claim. That promotion is the exact category error PJAN-84
//     fixed; re-creating it here would undo it fleet-wide.
//   * THE RECIPE AUDIT RUNS AS A BOUNDED CHILD, NEVER IN PROCESS. `runAudit` is
//     synchronous and shells out with `spawnSync` and NO timeout --
//     `systemctl --user is-system-running` twice, `git ls-files --stage`, and
//     `npm view bmad-method`. In process, one hung `systemctl` blocks the event
//     loop, so neither the whole-run deadline nor SIGINT can be honoured and a
//     per-repository timeout is unimplementable. As a child it is killable,
//     isolated and concurrency-capped -- at the cost of depending on
//     `pjangler audit --json` being parse-safe, which is why this story fixes
//     the flush.
//   * `--live` MEANS "MAY REACH THE HOST AND THE NETWORK, READ-ONLY", AND
//     NOTHING ELSE. The bmad rule's `npm view` is a real network call, so the
//     audit is gated. `--live` does not conjure a systemd, process, or
//     Bloodbank-liveness observer -- those stay `unsupported`/`unobserved`, by
//     name, with the story that owns them.
//   * `data` IS DETERMINISTIC. No timestamp, duration, pid, hostname, or
//     ordering by completion: the child's `auditedAt` is dropped at the boundary
//     and every path goes through `redactHome`. Two runs over unchanged state
//     produce byte-identical `data`, which is what turns the CLI/MCP parity
//     assertion into an equality rather than a resemblance.
//
// What this module deliberately does NOT do: observe systemd, live processes, or
// Bloodbank liveness (stories 1.8/1.9/1.10); mutate anything, anywhere; or run
// the credentialed `momo-lifecycle-plane` profile.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadFleetContract, resolveFleetContractPath, validateFleetContract } from "./contract";
import {
  buildAuthorityIndex,
  collectFleetInventory,
  readAgentRegistryRaw,
  resolveInventoryStores,
  type FleetAuthorityIndex,
  type FleetInventoryOptions,
} from "./inventory";
import { bounded, redactHome } from "./output";
import { collectFleetProvenance } from "./provenance";
import { captureSelf, mapBounded, remainingMs, throwIfCancelled, type FleetRunContext } from "./runtime";
import {
  FLEET_STATUS_AUDIT_CONCURRENCY,
  FLEET_STATUS_DOMAINS,
  FLEET_STATUS_MAX_AGENTS,
  FLEET_STATUS_MAX_DETAILS,
  FLEET_STATUS_MAX_FINDINGS,
  FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT,
  FLEET_STATUS_STATE_PRECEDENCE,
  FLEET_STATUS_STATES,
  FleetError,
  type FleetInventoryFinding,
  type FleetInventoryRow,
  type FleetProbeRecord,
  type FleetProvenanceFact,
  type FleetStatus,
  type FleetStatusAgent,
  type FleetStatusDomain,
  type FleetStatusDomainRollup,
  type FleetStatusHealth,
  type FleetStatusHostFinding,
  type FleetStatusObservation,
  type FleetStatusScope,
  type FleetStatusState,
  type FleetStatusTotals,
} from "./types";
import { resolvePjanglerRoot } from "../project/index";
import { recipeRegistry } from "../recipes/catalog";

/**
 * Rule id -> observation domain.
 *
 * STATIC, and a table rather than a heuristic on the id's prefix: `hermes.*`
 * spans three different domains and `notebook.*` spans two, so a prefix rule
 * would file findings under a domain nobody chose. Every rule the default recipe
 * registry declares is listed; an unlisted one lands in
 * `UNMAPPED_RULE_DOMAIN` **and** raises a finding, so a rule added by a later
 * story cannot silently vanish from the fleet's status.
 */
const RULE_DOMAIN: Readonly<Record<string, FleetStatusDomain>> = Object.freeze({
  // Tracked assets the CommonProject / Hermes template owns in a repository.
  "secrets.env-op": "template_scaffold",
  "mise.config-root": "template_scaffold",
  "mise.versioning": "template_scaffold",
  "skills.project-manifest": "template_scaffold",
  "sot.agent-symlinks": "template_scaffold",
  "bmad.scaffold": "template_scaffold",
  "bmad.cli-roots": "template_scaffold",
  "hermes.pm-scaffold": "template_scaffold",
  "provenance.copier": "template_scaffold",
  "notebook.skill-installed": "template_scaffold",
  "notebook.hooks-projected": "template_scaffold",
  // Version currency of a scaffolded dependency. DELIBERATELY NOT
  // `release_provenance`: that domain is the HERMES release each agent runs, and
  // it is fed by the provenance core alone -- filing a BMAD version check there
  // would make `--live` change a domain whose whole definition is that it does
  // not.
  "bmad.version": "template_scaffold",
  // The project's identity and its binding to a board / manifest.
  "sot.project-json": "project_binding",
  "notebook.configuration": "project_binding",
  "notebook.binding": "project_binding",
  "notebook.remote-notebook": "project_binding",
  "notebook.overview-note": "project_binding",
  "notebook.capture-receipts": "project_binding",
  // Generated profile tree.
  "hermes.runtime-singleton": "profile",
  "hermes.profile-wiring": "profile",
  // Ignored role-local runtime bytes.
  "hermes.untracked-runtimes": "runtime",
  // Shared-host service topology.
  "systemd.sentinel": "systemd",
  // The fleet-shared Bloodbank gateway's own configuration.
  "hermes.fleet-config": "bloodbank",
  // Registry parity between the two canonical stores.
  "hermes.registry-parity": "registry",
});

/**
 * Where a rule nobody has classified lands.
 *
 * `template_scaffold` is the catch-all for two reasons. Most recipe rules are
 * about tracked assets in a repository, so it is the likeliest right answer.
 * And it is a domain the audit already feeds per agent, so an unmapped rule
 * reaches the report on any run that selects it rather than landing in a domain
 * that spawns no child (see `AUDIT_PER_AGENT_DOMAINS`) and therefore never
 * showing up at all.
 *
 * The choice matters less than the finding that accompanies it: an unmapped rule
 * is REPORTED as unclassified, so the gap is visible in the same run rather than
 * discovered when someone notices a domain has gone quiet.
 */
const UNMAPPED_RULE_DOMAIN: FleetStatusDomain = "template_scaffold";

/**
 * Rules this command deliberately does not consume, and why.
 *
 * `momo-lifecycle-plane` is a `skip` stub in the default registry: its real
 * checks live behind `pj audit --profile momo-lifecycle-plane --live` and are
 * CREDENTIALED (they call a Plane API with the operator's key). A read-only
 * fleet status has no business reaching a board, so the stub is dropped rather
 * than reported as a permanently-skipped domain member.
 *
 * Held apart from "unmapped" on purpose: an excluded rule is a decision, an
 * unmapped one is an omission, and collapsing the two would let the next
 * omission hide behind this decision.
 */
const EXCLUDED_RULES: ReadonlySet<string> = new Set(["momo-lifecycle-plane"]);

/**
 * Domains whose PER-AGENT record the recipe audit can change.
 *
 * Narrower than "every domain the rule table mentions", and the difference is
 * load-bearing. `registry`, `systemd` and `bloodbank` are each fed by exactly
 * one rule and that rule is HOST-scoped, so an audit run adds nothing to any
 * agent's record in those domains -- it only fills `data.host`. Spawning 28 node
 * children to answer `--domain systemd` would be collection a filter explicitly
 * forbids, so this set is what decides whether a child runs at all.
 *
 * Cross-checked at runtime rather than trusted: a project-scoped rule that maps
 * to a domain outside this set raises `audit-domain-unexpected`, so the day a
 * host-scoped rule becomes project-scoped is the day this set is told about it.
 */
const AUDIT_PER_AGENT_DOMAINS: ReadonlySet<FleetStatusDomain> = new Set<FleetStatusDomain>([
  "template_scaffold", "project_binding", "profile", "runtime",
]);

/**
 * Domains whose default observation comes from the provenance core.
 *
 * Only these two make `collectFleetProvenance` run, and that is the point:
 * `--domain registry` must spawn zero provenance probes, not spawn them and then
 * hide the results.
 */
const PROVENANCE_FED_DOMAINS: ReadonlySet<FleetStatusDomain> = new Set<FleetStatusDomain>([
  "template_scaffold",
  "release_provenance",
]);

/**
 * The contract field path each domain is ABOUT.
 *
 * A rule finding has no field path of its own -- `rule_id` identifies it -- so
 * its observation is attributed to the path its domain covers. Filing every one
 * of them under `scaffold` (the first draft) told a reader that a notebook
 * binding rule was about the role scaffold, which is worse than saying nothing.
 *
 * `processes.{agent_id}` resolves to no owner on purpose: the contract declares
 * `live_process_observations` read-only with an empty `writable_fields`, so
 * nothing may write it and nothing here invents someone who can.
 */
const DOMAIN_FIELD: Readonly<Record<FleetStatusDomain, string>> = Object.freeze({
  registry: "agents.{agent_id}",
  project_binding: "agents.{agent_id}.plane.identifier",
  template_scaffold: "scaffold",
  // `agents.{agent_id}.profile_name`, not `profiles.{profile_name}`. Both are
  // defensible and having BOTH was not: `observeFromInventory` emitted one and
  // this table the other for the same domain, so the two observations resolved
  // their fallback owner from different contract paths -- the only domain where
  // that happened.
  profile: "agents.{agent_id}.profile_name",
  runtime: "agents.{agent_id}.role_dir",
  systemd: "agents.{agent_id}.systemd.gateway_unit",
  live_process: "processes.{agent_id}",
  bloodbank: "agents.{agent_id}.bloodbank.gateway_scope",
  release_provenance: "agents.{agent_id}.hermes.bin",
});

/**
 * Provenance fact-id prefix -> observation domain.
 *
 * The same discipline `RULE_DOMAIN` gets, and for the same reason: a fact id
 * that matches nothing lands in `UNMAPPED_FACT_DOMAIN` **and** raises
 * `provenance-fact-unmapped`, so a fact a later story adds to the provenance
 * core cannot be silently dropped or silently misfiled. Before this, the
 * fleet-scoped branch was a bare `startsWith("template.") ? ... : ...`, which
 * filed every unrecognized fact under `release_provenance` and said nothing.
 */
const FACT_PREFIX_DOMAIN: ReadonlyArray<readonly [string, FleetStatusDomain]> = Object.freeze([
  ["scaffold.", "template_scaffold"],
  ["template.", "template_scaffold"],
  ["hermes.", "release_provenance"],
  ["profile.", "release_provenance"],
  // The host pin: `fleet.hermes_bin`, `fleet.hermes_repo`, `fleet.registry_file`.
  ["fleet.", "release_provenance"],
] as const);

const UNMAPPED_FACT_DOMAIN: FleetStatusDomain = "release_provenance";

/** Which domain a provenance fact belongs to, and whether anything declared it. */
function factDomain(factId: string): { domain: FleetStatusDomain; mapped: boolean } {
  for (const [prefix, domain] of FACT_PREFIX_DOMAIN) {
    if (factId.startsWith(prefix)) return { domain, mapped: true };
  }
  return { domain: UNMAPPED_FACT_DOMAIN, mapped: false };
}

/** Source ids, used as the `source` on an observation. */
const SOURCE_REGISTRY = "fleet-inventory";
const SOURCE_PROVENANCE = "fleet-provenance";
const SOURCE_AUDIT = "recipe-audit";
const SOURCE_DECLARED_GAP = "declared-gap";

/**
 * Wall-clock budget for ONE audit child, still floored by the whole-run deadline.
 *
 * Its own number, not the per-probe one. `FLEET_DEFAULT_PROBE_TIMEOUT_MS` is
 * 5 000 ms and is sized for a local `git` read; the audit child is a node
 * startup plus 25 rules, one of which (`bmad.version`) gives `npm view` an 8 000
 * ms timeout of its OWN (`src/parity/rules.ts`, 1 h disk cache). Inheriting the
 * probe budget therefore timed out every repository on a cold cache -- reported
 * as `unobserved` for a reason no operator could see. 20 s leaves the child's own
 * 8 s call room to finish and still bounds a hung `systemctl`.
 */
export const FLEET_STATUS_AUDIT_TIMEOUT_MS = 20_000;

/** The env key that redirects the audit child at a different entry point. */
const CLI_ENTRY_ENV = "PJ_FLEET_CLI_ENTRY";

/**
 * The ONLY environment keys a recipe-audit child receives.
 *
 * An allowlist, not a filter. `~/.hermes/fleet.env` and this process's own
 * environment carry live Plane API keys on the operator's host, and "no literal
 * credential in any child environment" is a guarantee that has to be structural:
 * a denylist is one new key name away from being wrong, and a redaction pass is
 * one forgotten call away from the same.
 *
 * Everything here is something `pjangler audit` genuinely needs: where HOME and
 * the XDG roots are, which registries to read, a PATH to find `git` and `npm`
 * on, a TMPDIR, and the session bus `systemctl --user` talks over.
 */
const AUDIT_CHILD_ENV_KEYS = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM",
  "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HERMES_FLEET_HOME", "HERMES_AGENTS_REGISTRY", "HERMES_FLEET_REGISTRY_FILE",
  "HERMES_FLEET_ENV", "HERMES_TEMPLATE_CONFIG",
  "HERMES_TEMPLATE_RUNTIME_SCAFFOLD", "RUNTIME_SCAFFOLD_DIR",
  "PJ_PROJECT_REGISTRY",
  "NO_COLOR",
] as const;

export interface FleetStatusOptions extends FleetInventoryOptions {
  /** The run's deadline and cancellation budget. Required: every child is bounded by it. */
  runContext: FleetRunContext;
  /** Report only this domain. Validated against `FLEET_STATUS_DOMAINS`. */
  domain?: string;
  /**
   * Authorize bounded, read-only host and network observation.
   *
   * It authorizes the recipe-audit child and nothing else. Never mutation,
   * process control, service changes, board changes, or Bloodbank activation.
   */
  live?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Mirrors the unexported `expandHome` in `src/project/index.ts`. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** A path as an operator may see it: bounded, with their home collapsed to `~`. */
function shownPath(path: string): string {
  return bounded(redactHome(path));
}

/**
 * A stable id for one observation, identical on every run and on both adapters.
 *
 * The `conflictGroupId` idiom (`inventory.ts`): a sha256 prefix over the tuple
 * that identifies the observation, NUL-joined so two components cannot run
 * together into a third spelling. Every input is a field the observation itself
 * carries, so the id is reproducible from the payload rather than from state
 * only this process had.
 *
 * `source` is one of those inputs, and it is not decoration. Two DIFFERENT
 * sources routinely answer for the same `(agent, domain, field)` -- the registry
 * row's own reading of `agents.{agent_id}.plane.identifier` and the
 * recipe-audit's "this half was not read" marker for the same path, neither
 * carrying a rule id. MEASURED: without `source` those two hashed to one id, and
 * any consumer joining on it would have silently merged an observation with the
 * statement that the observation is missing.
 */
function statusFindingId(
  scope: "fleet" | "agent" | "host",
  agentId: string | null,
  domain: FleetStatusDomain,
  ruleId: string | null,
  field: string,
  source: string,
): string {
  const key = [scope, agentId ?? "", domain, ruleId ?? "", field, source].join("\u0000");
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

/**
 * The command that returns one record on its own. Always a real invocation.
 *
 * `domain` is omitted for a whole AGENT record: naming an arbitrary one there
 * would hand a caller whose envelope was clipped a command that returns a
 * different, smaller thing than the record they were reading.
 */
function retrievalFor(agentId: string | null, domain: FleetStatusDomain | null, live: boolean): string {
  const parts = ["pjangler fleet status"];
  if (agentId) parts.push(`--agent ${agentId}`);
  if (domain) parts.push(`--domain ${domain}`);
  if (live) parts.push("--live");
  parts.push("--json");
  return bounded(parts.join(" "));
}

/**
 * The domain a clip hurt most, so a clipped record can name a narrowing that works.
 *
 * `own` minus `kept`, per domain. Ties keep the earlier domain in
 * `FLEET_STATUS_DOMAINS` order, which is fixed, so two runs over unchanged state
 * pick the same one. Falls back to the first selected domain when nothing was
 * actually dropped from any of them.
 */
function mostClippedDomain(
  own: readonly FleetStatusObservation[],
  kept: readonly FleetStatusObservation[],
  domains: readonly FleetStatusDomain[],
): FleetStatusDomain {
  const count = (list: readonly FleetStatusObservation[], domain: FleetStatusDomain): number =>
    list.reduce((total, item) => total + (item.domain === domain ? 1 : 0), 0);
  let best = domains[0]!;
  let bestDropped = -1;
  for (const domain of domains) {
    const dropped = count(own, domain) - count(kept, domain);
    if (dropped > bestDropped) { best = domain; bestDropped = dropped; }
  }
  return best;
}

/** Bound every detail line and record the clip in the line itself, never silently. */
function boundedDetails(details: readonly unknown[] | undefined): string[] {
  const all = (details ?? []).filter((item): item is string => typeof item === "string");
  const kept = all.slice(0, FLEET_STATUS_MAX_DETAILS).map((item) => bounded(redactHome(item)));
  if (all.length > FLEET_STATUS_MAX_DETAILS) {
    kept[kept.length - 1] = bounded(`... ${all.length - FLEET_STATUS_MAX_DETAILS} of ${all.length} detail line(s) dropped`);
  }
  return kept;
}

/**
 * The worst state in a set, under the declared precedence.
 *
 * Reads `FLEET_STATUS_STATE_PRECEDENCE` rather than re-spelling the order here:
 * a precedence constant that no code iterates is decoration, and reordering it
 * has to move behaviour or it is not the rule it claims to be.
 */
/** Where a state sits in the declared precedence. Lower is worse. */
function stateRank(state: FleetStatusState): number {
  const index = (FLEET_STATUS_STATE_PRECEDENCE as readonly FleetStatusState[]).indexOf(state);
  return index === -1 ? FLEET_STATUS_STATE_PRECEDENCE.length : index;
}

export function rollUp(observations: readonly { state: FleetStatusState }[]): FleetStatusState {
  // `unsupported` STEPS ASIDE when the domain produced anything else, and this
  // is the one deliberate refinement of the raw precedence.
  //
  // `unsupported` says "no adapter exists in this release" -- a statement about
  // this BUILD, not about the fleet. It outranks `fail` because for a domain
  // with nothing else (`live_process`) that is exactly right: no answer beats a
  // partial one. Applied to a MIXED domain it inverts into a lie:
  // `template_scaffold` carries one permanent "a deployed role scaffold records
  // no template ref" beside eighteen stale tracked assets, and an operator
  // reading `unsupported` there would conclude this release cannot see the
  // scaffold when it can see it and it is broken. It is also what the story's
  // own acceptance asks for -- a project-scoped `warn` must roll that agent's
  // domain up to `warn`.
  const decisive = observations.some((observation) => observation.state !== "unsupported")
    ? observations.filter((observation) => observation.state !== "unsupported")
    : observations;
  for (const state of FLEET_STATUS_STATE_PRECEDENCE) {
    if (decisive.some((observation) => observation.state === state)) return state;
  }
  // An empty set is not a pass. It is a domain nothing looked at, which is
  // exactly what `unobserved` means -- claiming `pass` here is how an aggregate
  // turns absence into agreement.
  return "unobserved";
}

/** The lifecycle status a recipe rule reports, as a status state. One-for-one. */
function ruleState(status: unknown): FleetStatusState {
  switch (status) {
    case "pass": return "pass";
    case "fail": return "fail";
    case "warn": return "warn";
    case "skip": return "skip";
    // A rule that reports something this build does not know about is a
    // collection error, not a pass: the audit contract changed under us.
    default: return "error";
  }
}

/**
 * A provenance fact's status, as a status state.
 *
 * `mismatch` and `dirty` are both proven drift, so both are `fail`. `missing` is
 * a gap rather than a proven conflict -- a registry row that records no
 * `git_sha` has not been shown to be running the wrong build, only shown to be
 * unable to confirm the right one -- so it warns. That distinction is what keeps
 * `healthy` meaningful on a fleet where 21 of 28 rows record no sha at all.
 */
function provenanceState(status: FleetProvenanceFact["status"]): FleetStatusState {
  switch (status) {
    case "match": return "pass";
    case "mismatch": return "fail";
    case "dirty": return "fail";
    case "missing": return "warn";
    case "unsupported": return "unsupported";
    case "unobserved": return "unobserved";
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface ResolvedStatusScope {
  scope: FleetStatusScope;
  agentIds: string[];
  domains: FleetStatusDomain[];
}

/**
 * Which agents and which domains this run will actually collect.
 *
 * Both filters are validated HERE, before anything spawns. DW-56 records story
 * 1.3 validating `--agent` only after the whole probe sweep had run, which made
 * a typo indistinguishable from a slow fleet (it could exit 7 rather than 3).
 * The scope also carries fleet-wide totals under a filter, so a scoped answer
 * can never read as a fleet-complete one.
 */
export function resolveStatusScope(
  options: Pick<FleetStatusOptions, "agentId" | "domain" | "live">,
  registeredIds: readonly string[],
  totalRegisteredAgents: number,
): ResolvedStatusScope {
  const live = options.live === true;

  let domains: FleetStatusDomain[] = [...FLEET_STATUS_DOMAINS];
  let selectedDomain: FleetStatusDomain | null = null;
  const wantedDomain = options.domain?.trim();
  if (wantedDomain !== undefined && wantedDomain !== "") {
    if (!(FLEET_STATUS_DOMAINS as readonly string[]).includes(wantedDomain)) {
      throw new FleetError(
        "INVALID_INPUT",
        `--domain must be one of ${FLEET_STATUS_DOMAINS.join(", ")}`,
        false,
        { domain: bounded(wantedDomain, 128) },
      );
    }
    selectedDomain = wantedDomain as FleetStatusDomain;
    domains = [selectedDomain];
  }

  let agentIds = [...registeredIds];
  let kind: FleetStatusScope["kind"] = "fleet";
  let agentId: string | null = null;
  const wantedAgent = options.agentId?.trim();
  if (wantedAgent !== undefined && wantedAgent !== "") {
    if (!registeredIds.includes(wantedAgent)) {
      throw new FleetError("NOT_FOUND", "No agent with that id is registered", false, { agent_id: bounded(wantedAgent, 128) });
    }
    agentIds = [wantedAgent];
    kind = "agent";
    agentId = bounded(wantedAgent, 128);
  }

  // The label has to say SCOPED, loudly. A one-agent, one-domain answer that
  // reads "fleet status" is the shape of an aggregate lying by omission.
  const parts: string[] = [];
  parts.push(agentId ? `scoped to agent ${agentId}` : "whole registered fleet");
  parts.push(selectedDomain ? `domain ${selectedDomain} only` : "all nine domains");
  parts.push(live ? "live host observation authorized" : "no live observation (--live not given)");

  return {
    scope: {
      kind,
      agent_id: agentId,
      domain: selectedDomain,
      live,
      label: bounded(parts.join(" · ")),
      total_registered_agents: totalRegisteredAgents,
      selected_agents: agentIds.length,
      selected_domains: domains,
    },
    agentIds,
    domains,
  };
}

// ---------------------------------------------------------------------------
// Observation builders
// ---------------------------------------------------------------------------

/**
 * What an observation builder needs, and nothing more.
 *
 * EXPORTED because `observeFromInventory` and `observeFromProvenance` are: a
 * function exported with an unexported parameter type is uncallable from typed
 * code, which is exactly the half-exported surface DW-24 records.
 */
export interface FleetStatusContext {
  authority: FleetAuthorityIndex;
  live: boolean;
  observations: FleetStatusObservation[];
  findings: FleetInventoryFinding[];
  probes: FleetProbeRecord[];
  droppedFindings: number;
  /** Rule ids already reported as unmapped, so one gap is one finding, not one per agent. */
  unmappedRules: Set<string>;
  /** Rule ids already reported as mapping outside `AUDIT_PER_AGENT_DOMAINS`. Same discipline. */
  unexpectedDomainRules: Set<string>;
  /** Provenance fact ids already reported as carrying no declared domain. Same discipline. */
  unmappedFacts: Set<string>;
}

function addFinding(ctx: FleetStatusContext, finding: FleetInventoryFinding): void {
  if (ctx.findings.length >= FLEET_STATUS_MAX_FINDINGS) { ctx.droppedFindings += 1; return; }
  ctx.findings.push({ ...finding, detail: bounded(redactHome(finding.detail)) });
}

interface ObservationInput {
  domain: FleetStatusDomain;
  agentId: string | null;
  state: FleetStatusState;
  field: string;
  summary: string;
  details?: readonly unknown[];
  source: string;
  ruleId?: string | null;
  owner?: string | null;
  ruleScope?: "project" | "host" | null;
}

function observation(ctx: FleetStatusContext, input: ObservationInput): FleetStatusObservation {
  const scope = input.agentId === null ? "fleet" : "agent";
  return {
    domain: input.domain,
    agent_id: input.agentId,
    state: input.state,
    rule_id: input.ruleId ?? null,
    owner: input.owner !== undefined ? input.owner : ctx.authority.ownerOf(input.field),
    rule_scope: input.ruleScope ?? null,
    field: bounded(input.field),
    summary: bounded(redactHome(input.summary)),
    details: boundedDetails(input.details),
    finding_id: statusFindingId(scope, input.agentId, input.domain, input.ruleId ?? null, input.field, input.source),
    source: input.source,
    retrieval: retrievalFor(input.agentId, input.domain, ctx.live),
  };
}

/**
 * The five domains the two canonical registries can answer on their own.
 *
 * `registry`, `project_binding`, `profile`, `runtime` and `bloodbank` all read
 * off story 1.2's row -- which already carries per-field authority attribution,
 * `lstat`-based path classification, and the conflict groups this row
 * participates in. Nothing is re-derived here; the row IS the observation, and
 * this function only decides which state that row implies.
 *
 * `systemd` and `live_process` are handled beside it because their honest answer
 * is a declared gap, not a read.
 */
export function observeFromInventory(
  ctx: FleetStatusContext,
  row: FleetInventoryRow,
  domains: ReadonlySet<FleetStatusDomain>,
): FleetStatusObservation[] {
  const agentId = row.agent_id.value ?? "";
  const out: FleetStatusObservation[] = [];

  if (domains.has("registry")) {
    const field = "agents.{agent_id}";
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the registry row is well formed and correlated to a project record";
    if (row.malformed) {
      state = "fail";
      summary = "the registry row is malformed; it was salvaged rather than read";
    } else if (row.conflicts.length > 0) {
      state = "fail";
      summary = `this row participates in ${row.conflicts.length} identity conflict group(s)`;
      details.push(...row.conflicts);
    } else if (row.correlation.state !== "resolved") {
      state = "warn";
      summary = "the row is not correlated to a project-registry record";
      details.push(`correlation is ${row.correlation.state}`);
    }
    if (row.findings.length) details.push(`row findings: ${row.findings.join(", ")}`);
    out.push(observation(ctx, { domain: "registry", agentId, state, field, summary, details, source: SOURCE_REGISTRY }));
  }

  if (domains.has("project_binding")) {
    const field = "agents.{agent_id}.plane.identifier";
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the row carries a board binding the repository manifest agrees with";
    if (row.board.value === null) {
      state = "warn";
      summary = "the row stores no board binding";
    } else if (row.manifest.agrees === false) {
      state = "warn";
      summary = ".project.json contradicts the registries; it is evidence, never a tiebreaker";
      details.push(...row.manifest.notes);
    } else if (row.project_id.state !== "resolved") {
      state = "warn";
      summary = `the row's project identity is ${row.project_id.state}`;
    }
    if (row.board.value) {
      details.push(`workspace=${row.board.value.workspace ?? "-"} board=${row.board.value.project_id ?? "-"} identifier=${row.board.value.identifier ?? "-"}`);
    }
    out.push(observation(ctx, { domain: "project_binding", agentId, state, field, summary, details, source: SOURCE_REGISTRY }));
  }

  if (domains.has("profile")) {
    const field = DOMAIN_FIELD.profile;
    const view = row.paths.profile_path;
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = `profile ${row.profile_name.value ?? "-"} resolves to a real directory`;
    if (row.profile_name.value === null) {
      state = "warn";
      summary = "the row names no profile";
    } else if (view?.classification === "symlink") {
      state = "fail";
      summary = `the profile directory is a symlink, and the contract declares service_model.profile_layout.symlink_allowed: false`;
      details.push(`-> ${view.link_target ?? "an unreadable target"}`);
    } else if (row.profile_path.state !== "resolved") {
      state = "warn";
      summary = `the profile directory is ${view?.classification ?? "undeclared"}`;
    }
    if (view?.declared) details.push(view.declared);
    out.push(observation(ctx, { domain: "profile", agentId, state, field, summary, details, source: SOURCE_REGISTRY }));
  }

  if (domains.has("runtime")) {
    // Attributed to `role_dir`, which is the field the runtime path is DERIVED
    // from -- the registry records no runtime path of its own, and attributing
    // it to a field nobody writes would name the wrong repair.
    const field = "agents.{agent_id}.role_dir";
    const view = row.paths.runtime_path;
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the role-local runtime directory is present and is a real directory";
    if (row.role_dir.value === null) {
      state = "warn";
      summary = "the row declares no role_dir, so no runtime directory can be derived";
    } else if (row.runtime_path.state !== "resolved") {
      state = "warn";
      summary = `the expected runtime directory is ${view?.classification ?? "undeclared"}`;
    }
    if (view?.declared) details.push(view.declared);
    out.push(observation(ctx, { domain: "runtime", agentId, state, field, summary, details, source: SOURCE_REGISTRY }));
  }

  if (domains.has("bloodbank")) {
    const field = "agents.{agent_id}.bloodbank.gateway_scope";
    const details = [
      `gateway_scope=${row.bloodbank_scope.value ?? "-"}`,
      `target_agent_id=${row.bloodbank_target.value ?? "-"}`,
      `${row.activation_field.value ?? "activation"}=${row.activation.value === true ? "true" : row.activation.value === false ? "false" : "unresolved"}`,
    ];
    let state: FleetStatusState = "pass";
    let summary = "the row records a fleet-scoped Bloodbank routing target";
    if (row.bloodbank_scope.value === null || row.bloodbank_target.value === null) {
      state = "warn";
      summary = "the row records an incomplete Bloodbank routing record";
    } else if (row.activation.value === null) {
      state = "warn";
      summary = "the strict activation flag is absent or not a boolean; the contract's declared default is deny";
    }
    out.push(observation(ctx, { domain: "bloodbank", agentId, state, field, summary, details, source: SOURCE_REGISTRY }));
    // Liveness is a SECOND observation, not a modifier on the record above: the
    // record is observed and the liveness is not, and folding them would let a
    // read of the registry pass for a read of the bus. Story 1.10 owns it.
    //
    // `unsupported`, not `unobserved`: nothing in this build can observe routing
    // readiness at all, so it is a gap in the RELEASE rather than a gap in this
    // run. Calling it `unobserved` would hold `health.complete` false forever
    // and make the flag meaningless.
    out.push(observation(ctx, {
      domain: "bloodbank", agentId, state: "unsupported",
      field: "gateways.bloodbank.command_subject",
      summary: "no Bloodbank liveness observer exists in this release; routing readiness is story 1.10",
      details: ["the routing RECORD above is observed; whether the shared gateway can dispatch to it is not"],
      source: SOURCE_DECLARED_GAP,
    }));
  }

  if (domains.has("systemd")) {
    // `unsupported` for the same reason the Bloodbank liveness observation is:
    // no adapter exists in this build, so this is a property of the release, not
    // of this run. The unit NAMES below are expectations the contract derives,
    // carried as evidence -- never mistaken for an observation of systemd.
    out.push(observation(ctx, {
      domain: "systemd", agentId, state: "unsupported",
      field: "agents.{agent_id}.systemd.gateway_unit",
      summary: "no systemd observer exists in this release; unit names are expectations, never observations",
      details: [
        ...(row.expected_units.value ?? []).map((unit) => `expected ${unit}`),
        "canonical systemd topology and service health is story 1.8",
      ],
      source: SOURCE_DECLARED_GAP,
    }));
  }

  if (domains.has("live_process")) {
    out.push(observation(ctx, {
      domain: "live_process", agentId, state: "unsupported",
      field: "processes.{agent_id}",
      summary: "no live-process observer exists in this release",
      details: ["there is no ps, pgrep, or /proc read anywhere in this build; process attribution is story 1.9"],
      source: SOURCE_DECLARED_GAP,
    }));
  }

  return out;
}

/**
 * The two domains the provenance core answers.
 *
 * `release_provenance` is every per-agent provenance fact -- which executable,
 * which checkout, which remote, which HEAD, whether it is clean -- carried
 * across with its own status rather than recomputed. `template_scaffold` is the
 * one fact this host records nothing to answer (`scaffold.template_ref`), which
 * provenance already reports `unsupported` by design.
 */
export function observeFromProvenance(
  ctx: FleetStatusContext,
  facts: readonly FleetProvenanceFact[],
  agentId: string,
  domains: ReadonlySet<FleetStatusDomain>,
): FleetStatusObservation[] {
  const out: FleetStatusObservation[] = [];
  const byDomain = new Map<FleetStatusDomain, number>();

  for (const fact of facts) {
    if (fact.agent_id !== agentId) continue;
    const { domain } = classifyFact(ctx, fact);
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
    if (!domains.has(domain)) continue;
    out.push(factObservation(ctx, fact, domain, agentId));
  }

  // A domain the provenance core answered NOTHING for is `unobserved`, not
  // absent: the domain must appear on every record even when the source that
  // feeds it returned no fact at all.
  for (const domain of ["template_scaffold", "release_provenance"] as const) {
    if (!domains.has(domain) || (byDomain.get(domain) ?? 0) > 0) continue;
    out.push(observation(ctx, {
      domain, agentId, state: "unobserved",
      field: DOMAIN_FIELD[domain],
      summary: `the provenance core reported no ${domain === "template_scaffold" ? "scaffold" : "release"} fact for this agent`,
      source: SOURCE_PROVENANCE,
    }));
  }

  return out;
}

/** One provenance fact as one observation. Shared by the per-agent and fleet paths. */
function factObservation(
  ctx: FleetStatusContext,
  fact: FleetProvenanceFact,
  domain: FleetStatusDomain,
  agentId: string | null,
): FleetStatusObservation {
  return observation(ctx, {
    domain, agentId, state: provenanceState(fact.status),
    field: fact.field, owner: fact.owner,
    ruleId: fact.id,
    summary: fact.detail,
    details: [
      `desired ${fact.desired.value ?? "-"} (${fact.desired.source ?? "no source"}/${fact.desired.state})`,
      `observed ${fact.observed.value ?? "-"} (${fact.observed.source ?? "no source"}/${fact.observed.state})`,
    ],
    source: SOURCE_PROVENANCE,
  });
}

/**
 * Which domain a fact belongs to, raising a finding the first time none does.
 *
 * The mirror of the `audit-rule-unmapped` guard. Without it a fact id a later
 * story adds -- `systemd.unit_state`, say -- would land under
 * `release_provenance` (or be dropped by a prefix filter) with nothing said, and
 * the suite's per-domain presence assertion would stay green because the
 * fallback `unobserved` observation fills the hole.
 */
function classifyFact(ctx: FleetStatusContext, fact: FleetProvenanceFact): { domain: FleetStatusDomain; mapped: boolean } {
  const resolved = factDomain(fact.id);
  if (!resolved.mapped && !ctx.unmappedFacts.has(fact.id)) {
    ctx.unmappedFacts.add(fact.id);
    addFinding(ctx, {
      code: "provenance-fact-unmapped",
      field: fact.field,
      agent_id: null,
      source: fact.owner,
      severity: "warn",
      detail: `the provenance fact ${fact.id} matches no prefix in FACT_PREFIX_DOMAIN; it is reported under ${UNMAPPED_FACT_DOMAIN} so it cannot disappear, and src/fleet/status.ts is where it should be classified`,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The recipe audit, as a bounded child
// ---------------------------------------------------------------------------

/**
 * Which built CLI the audit child runs.
 *
 * `PJ_FLEET_CLI_ENTRY` is the DOCUMENTED observation-injection seam, and it is
 * what makes this story's child-failure, child-timeout and cancellation cases
 * real subprocesses rather than mocks. Unset, the entry is this build's own
 * `dist/index.js`, resolved from the package root -- both `dist/index.js` and
 * `dist/mcp-server.js` live there, so the CLI and MCP adapters resolve the same
 * one regardless of cwd.
 *
 * A missing entry is a CATEGORIZED COLLECTION ERROR, never a crash and never a
 * silent skip: the caller gets `null` and reports every audit-fed domain
 * `unobserved` with reason `audit-cli-unavailable`.
 */
export function resolveAuditCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = nonEmptyString(env[CLI_ENTRY_ENV]);
  const entry = override ?? join(resolvePjanglerRoot(), "dist", "index.js");
  if (!isAbsolute(entry)) return null;
  return existsSync(entry) ? entry : null;
}

/** The narrow environment one audit child gets. See `AUDIT_CHILD_ENV_KEYS`. */
export function auditChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUDIT_CHILD_ENV_KEYS) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  // Bounded by construction: no pager to block on, no credential helper, no
  // terminal prompt a hung `git` could wait at forever.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.NO_COLOR = "1";
  return env;
}

/** What one audit child produced, categorized. Never an exception. */
export interface AuditObservationResult {
  /** Rule findings, or null when nothing parseable came back. */
  rules: Array<Record<string, unknown>> | null;
  /** `ok`, `timeout`, or `failed`. Mirrors the child's own outcome. */
  outcome: "ok" | "timeout" | "failed";
  /** A stable category, never a subprocess message. */
  reason: string | null;
  /** The child's exit status, null when it was killed or never ran. Reported in the finding. */
  code: number | null;
}

/**
 * Audit one repository as a bounded child of this build.
 *
 * `--live` is deliberately NEVER passed to the child. On the audit command that
 * flag only reaches the credentialed `--profile momo-lifecycle-plane` path; the
 * default audit it would decorate does not read it, and passing it would be a
 * standing invitation for a later change to make it mean something here.
 *
 * Three things are dropped at this boundary, and each for a reason `data` would
 * otherwise pay for: `auditedAt` (a timestamp makes two runs differ), the raw
 * `repo` path (home-redacted instead), and stderr (never read at all).
 */
export async function auditRepository(
  ctx: FleetRunContext,
  entry: string,
  repoPath: string,
  registryPath: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<AuditObservationResult> {
  const args = ["audit", repoPath, "--json"];
  if (registryPath) args.push("--registry", registryPath);

  const result = await captureSelf(ctx, entry, args, undefined, env, FLEET_STATUS_AUDIT_TIMEOUT_MS);
  if (result.outcome === "timeout") return { rules: null, outcome: "timeout", reason: "timeout", code: result.code };
  if (result.outcome === "cancelled") {
    // A cancellation is a COMMAND failure, not an observation outcome. It has to
    // escape rather than become one repository's downgraded domain.
    throw new FleetError("CANCELLED", "Fleet command was cancelled before it completed");
  }
  // The byte cap is its OWN category. A child killed for saying too much and a
  // child that said nothing are different problems with different repairs, and
  // the real audit report on this fleet is 3.7 MB against a 4 MiB cap -- one
  // growth spurt from making the distinction load-bearing.
  if (result.overflow) return { rules: null, outcome: "failed", reason: "audit-output-too-large", code: result.code };
  const text = result.value ?? "";
  if (text === "") {
    // `code` is what separates "ran and printed nothing" from "never ran": node
    // exits 1 for a module it cannot load and the child is killed with a null
    // code, and an operator chasing an empty report needs to know which.
    const reason = result.outcome === "ok"
      ? "audit-empty-output"
      : result.code === null ? "audit-child-killed" : "audit-no-output";
    return { rules: null, outcome: "failed", reason, code: result.code };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { rules: null, outcome: "failed", reason: "audit-unparseable-json", code: result.code }; }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return { rules: null, outcome: "failed", reason: "audit-report-shape-unknown", code: result.code };
  }
  // The child exiting 1 is NOT an error: `pjangler audit` exits 1 by design on a
  // drifted repository, with the complete report on stdout. Reporting that as a
  // collection failure would throw away exactly the findings this call exists
  // to collect.
  return { rules: parsed.rules.filter(isRecord), outcome: "ok", reason: null, code: result.code };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The whole fleet's status, as the registries, the provenance core and the
 * recipe-owned audit rules state it.
 *
 * An unhealthy fleet is DATA, not a command failure: `validateFleetEnvelope`
 * nulls `data` on `ok:false`, so reporting drift as a failure would blank the
 * report on exactly the runs that matter. A drifted or incomplete fleet is
 * `ok:true`, exit 0, `health.healthy:false`. Only a COMMAND failure -- an
 * unreadable source, an unknown `--agent`/`--domain`, a bad flag, a blown
 * deadline, a cancellation -- throws.
 */
export async function collectFleetStatus(options: FleetStatusOptions): Promise<FleetStatus> {
  const runContext = options.runContext;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const live = options.live === true;
  throwIfCancelled(runContext);

  const contractPath = resolveFleetContractPath(options.contract);
  const loaded = loadFleetContract(contractPath);
  const validation = validateFleetContract(loaded.document);
  const firstDiagnostic = validation.diagnostics[0];
  if (!validation.contract || firstDiagnostic) {
    throw new FleetError(
      firstDiagnostic?.code ?? "INVALID_INPUT",
      `fleet contract is not usable: ${firstDiagnostic ? `${firstDiagnostic.path}: ${firstDiagnostic.message}` : "validation produced no contract"}`,
      false,
      { contract_path: shownPath(contractPath) },
    );
  }
  const contract = validation.contract;

  // Story 1.2's core, called rather than reimplemented: it owns registry
  // reading, tolerant parsing, path classification, conflict detection and the
  // registered-agent count. Collected UNSCOPED so `total_registered_agents` and
  // the conflict groups stay fleet-wide under a filter -- provenance's
  // precedent, and the reason a scoped answer cannot claim a fleet verdict.
  const inventory = collectFleetInventory({ ...options, agentId: undefined, runContext });
  const rowsById = new Map<string, FleetInventoryRow>();
  for (const row of inventory.rows) {
    const id = row.agent_id.value;
    if (id !== null && !rowsById.has(id)) rowsById.set(id, row);
  }
  const registeredIds = [...rowsById.keys()].sort();

  // Both filters are resolved and REJECTED here -- before a probe, before a
  // child, before any observation is built.
  const { scope, agentIds, domains } = resolveStatusScope(options, registeredIds, inventory.totals.registered_agents);
  const domainSet = new Set<FleetStatusDomain>(domains);
  const selectedAgents = new Set(agentIds);

  const ctx: FleetStatusContext = {
    authority: buildAuthorityIndex(contract),
    live,
    observations: [], findings: [], probes: [],
    droppedFindings: 0,
    unmappedRules: new Set<string>(),
    unexpectedDomainRules: new Set<string>(),
    unmappedFacts: new Set<string>(),
  };

  // NOTHING OBSERVED IS NOT A CLEAN BILL. Measured on an `agents: {}` registry:
  // this command reported `{healthy: true, complete: true, fleet_complete: true}`
  // over zero agents -- the aggregate turning absence into agreement, which is
  // the one thing it exists not to do. `fleet_complete` now requires at least one
  // registered row (below), and the empty registry is a visible finding here.
  if (inventory.totals.registered_agents === 0) {
    addFinding(ctx, {
      code: "registry-declares-no-agents",
      field: "agents.{agent_id}",
      agent_id: null,
      source: ctx.authority.ownerOf("agents.{agent_id}"),
      severity: "error",
      detail: "the agent registry declares no agents, so nothing was observed; an empty fleet is a source this run could not read, never a healthy one",
    });
  }

  // -- the raw registry, for paths a probe can actually open -----------------
  // A ROW carries home-redacted, bounded projections for display: correct for an
  // inventory, unopenable for a child. Same split provenance documents.
  const stores = resolveInventoryStores(options);
  const agentRaw = readAgentRegistryRaw(stores.agents.inspectedPath);
  const repoByAgent = new Map<string, string>();
  for (const entry of agentRaw.entries) {
    if (!selectedAgents.has(entry.key)) continue;
    const raw = isRecord(entry.value) ? entry.value : {};
    const declared = nonEmptyString(raw.project_path);
    if (declared !== null) repoByAgent.set(entry.key, resolve(expandHome(declared, home)));
  }

  // -- provenance, only when a provenance-fed domain is selected -------------
  // `--domain registry` must spawn ZERO provenance probes. A filter that
  // collects everything and then hides it is not a filter.
  let provenanceFacts: readonly FleetProvenanceFact[] = [];
  const needsProvenance = domains.some((domain) => PROVENANCE_FED_DOMAINS.has(domain));
  if (needsProvenance) {
    throwIfCancelled(runContext);
    const provenance = await collectFleetProvenance({
      ...options,
      agentId: undefined,
      // The same rule as the domain gate, one level down: under `--agent` no
      // checkout belonging to another agent may be probed.
      probeAgentIds: scope.kind === "agent" ? agentIds : undefined,
      runContext,
    });
    provenanceFacts = provenance.facts;
    ctx.probes.push(...provenance.probes);
  }

  // -- the recipe audit, as bounded children ---------------------------------
  const auditFedSelected = domains.filter((domain) => AUDIT_PER_AGENT_DOMAINS.has(domain));
  const wantsAudit = live && auditFedSelected.length > 0;
  const auditByAgent = new Map<string, AuditObservationResult>();
  let auditsAttempted = 0;
  let auditsObserved = 0;
  let auditEntry: string | null = null;

  if (wantsAudit) {
    auditEntry = resolveAuditCli(env);
    if (auditEntry === null) {
      addFinding(ctx, {
        code: "audit-cli-unavailable",
        field: DOMAIN_FIELD.template_scaffold,
        agent_id: null,
        // A real owner, resolved from the contract like every other finding this
        // namespace emits. `source: null` printed "owner undeclared" on the
        // human path for all four of these, from a command whose whole point is
        // that every value names who owns it.
        source: ctx.authority.ownerOf(DOMAIN_FIELD.template_scaffold),
        severity: "error",
        detail: `no built CLI to audit with (${CLI_ENTRY_ENV} names a file that is not there, or dist/index.js is not built); every audit-fed domain is unobserved rather than assumed`,
      });
    } else {
      // Deduplicated by canonical repository path BEFORE spawning: two agents
      // may share one repository, and auditing it twice would be two node
      // startups and two identical finding sets.
      const targets = [...new Set(repoByAgent.values())].sort();
      auditsAttempted = targets.length;
      remainingMs(runContext);
      const childCli = auditEntry;
      // The child must read the SAME stores this run did. `pjangler audit` takes
      // `--registry` for the project registry but has no flag for the Hermes
      // one, so the resolved path is handed over as the environment key its
      // reader honours -- otherwise `--agent-registry ./copy.yaml` would change
      // what status reads and leave the registry-reading audit rules answering
      // about the operator's live fleet.
      const childEnv = {
        ...auditChildEnv(env),
        HERMES_AGENTS_REGISTRY: stores.agents.inspectedPath,
        HERMES_FLEET_REGISTRY_FILE: stores.agents.inspectedPath,
      };
      const results = await mapBounded(targets, FLEET_STATUS_AUDIT_CONCURRENCY, async (repoPath) =>
        auditRepository(runContext, childCli, repoPath, options.projectRegistry, childEnv));
      const byRepo = new Map<string, AuditObservationResult>();
      targets.forEach((repoPath, index) => {
        const result = results[index]!;
        byRepo.set(repoPath, result);
        if (result.outcome === "ok") auditsObserved += 1;
        ctx.probes.push({
          id: `audit:${shownPath(repoPath)}`,
          kind: "audit",
          target: shownPath(repoPath),
          outcome: result.outcome === "ok" ? "ok" : result.outcome === "timeout" ? "timeout" : "failed",
          reason: result.reason,
        });
        if (result.outcome !== "ok") {
          addFinding(ctx, {
            code: `audit-${result.outcome}`,
            field: DOMAIN_FIELD.template_scaffold,
            agent_id: null,
            source: ctx.authority.ownerOf(DOMAIN_FIELD.template_scaffold),
            severity: "error",
            detail: `the recipe audit of ${shownPath(repoPath)} did not produce a report (${result.reason ?? result.outcome}${result.code === null ? ", killed" : `, exit ${result.code}`}); its audit-fed domains are ${result.outcome === "timeout" ? "unobserved" : "error"} rather than assumed`,
          });
        }
      });
      for (const [agentId, repoPath] of repoByAgent) {
        const result = byRepo.get(repoPath);
        if (result) auditByAgent.set(agentId, result);
      }
    }
  }

  // -- P9: a selected domain whose ONLY observer is host-scoped --------------
  // `--domain systemd --live` spawns no child, because no per-agent observation
  // could come of it (AC6 forbids the spawn, and every systemd rule is
  // host-scoped). That is correct and it is also a gap: `data.host` comes back
  // empty for the one domain whose whole live story lives there. Said out loud
  // rather than left for the operator to infer from an empty array.
  if (live && !wantsAudit) {
    for (const domain of domains) {
      const rules = Object.entries(RULE_DOMAIN).filter(([, mapped]) => mapped === domain).map(([ruleId]) => ruleId);
      if (rules.length === 0) continue;
      addFinding(ctx, {
        code: "audit-host-rules-not-collected",
        field: DOMAIN_FIELD[domain],
        agent_id: null,
        source: ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
        severity: "warn",
        detail: `domain ${domain} is observed live only by the host-scoped rule(s) ${rules.join(", ")}, and a --domain ${domain} run spawns no audit child, so data.host is empty; run without --domain to collect them`,
      });
    }
  }

  // -- per-agent records -----------------------------------------------------
  //
  // Every selected agent's observations are BUILT and counted. Only the first
  // `FLEET_STATUS_MAX_AGENTS` get a record, and each record carries at most
  // `FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT` of them -- but neither cap may
  // move a fleet-level number. Before this, agents past the agent cap were never
  // built at all and only the CLIPPED observations reached `ctx.observations`, so
  // a >500-agent registry whose single registry failure sorted past the cap
  // reported `health.healthy: true`, `failed: 0`, `domains[registry].state:
  // "pass"` -- while the same fleet at `--agent <that id>` reported the failure.
  // MEASURED. A bound on what the envelope CARRIES must never move what it
  // CONCLUDES.
  const hostByRule = new Map<string, { finding: FleetStatusHostFinding; states: Map<FleetStatusState, number> }>();
  const agentRecords: FleetStatusAgent[] = [];
  let totalObservations = 0;
  let emittedObservations = 0;
  const truncated: string[] = [];

  if (agentIds.length > FLEET_STATUS_MAX_AGENTS) {
    truncated.push(
      `agents: ${agentIds.length - FLEET_STATUS_MAX_AGENTS} of ${agentIds.length} agent records dropped; `
      + "every one of them is still counted in totals, by_state and health; "
      + "retrieve a dropped record with `pjangler fleet status --agent <id> --json`",
    );
  }

  for (const agentId of agentIds) {
    throwIfCancelled(runContext);
    const row = rowsById.get(agentId)!;
    const own: FleetStatusObservation[] = [];
    own.push(...observeFromInventory(ctx, row, domainSet));
    if (needsProvenance) own.push(...observeFromProvenance(ctx, provenanceFacts, agentId, domainSet));

    const audit = auditByAgent.get(agentId);
    if (!live) {
      // Matrix row 1. Without `--live` the audit half was not read, so every
      // domain it feeds says so -- rather than reporting the store half as if
      // it were the whole answer.
      for (const domain of auditFedSelected) {
        own.push(observation(ctx, {
          domain, agentId, state: "unobserved",
          field: DOMAIN_FIELD[domain],
          summary: "the recipe-owned audit rules were not run; pass --live to authorize bounded read-only host observation",
          details: ["a default run makes no network call, and the bmad version rule's `npm view` is a real one"],
          source: SOURCE_AUDIT,
        }));
      }
    } else if (auditEntry === null || audit === undefined || audit.outcome !== "ok") {
      const failed = audit !== undefined && audit.outcome === "failed";
      const state: FleetStatusState = failed ? "error" : "unobserved";
      const reason = auditEntry === null
        ? "audit-cli-unavailable"
        : audit === undefined
          ? "no-project-path-recorded"
          : audit.reason ?? audit.outcome;
      for (const domain of auditFedSelected) {
        own.push(observation(ctx, {
          domain, agentId, state,
          field: DOMAIN_FIELD[domain],
          summary: `the recipe audit for this agent's repository could not be read (${reason})`,
          details: ["every other agent's record is unaffected; a collection error is never a pass and never a dropped agent"],
          source: SOURCE_AUDIT,
        }));
      }
    } else {
      for (const rule of audit.rules ?? []) {
        const ruleId = nonEmptyString(rule.id);
        if (ruleId === null || EXCLUDED_RULES.has(ruleId)) continue;
        let domain = RULE_DOMAIN[ruleId];
        if (domain === undefined) {
          domain = UNMAPPED_RULE_DOMAIN;
          if (!ctx.unmappedRules.has(ruleId)) {
            ctx.unmappedRules.add(ruleId);
            addFinding(ctx, {
              code: "audit-rule-unmapped",
              field: DOMAIN_FIELD[domain],
              agent_id: null,
              source: recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
              severity: "warn",
              detail: `the recipe rule ${ruleId} has no declared status domain; it is reported under ${UNMAPPED_RULE_DOMAIN} so it cannot disappear, and RULE_DOMAIN in src/fleet/status.ts is where it should be classified`,
            });
          }
        }
        const scopeOfRule = rule.scope === "host" ? "host" : "project";
        if (scopeOfRule === "project" && !AUDIT_PER_AGENT_DOMAINS.has(domain) && !ctx.unexpectedDomainRules.has(ruleId)) {
          // The set above decides whether a child spawns for a `--domain` run.
          // A project-scoped rule outside it would be reported on an unfiltered
          // run and silently absent on the filtered one -- so say so, once,
          // rather than let the two answers quietly disagree.
          ctx.unexpectedDomainRules.add(ruleId);
          addFinding(ctx, {
            code: "audit-domain-unexpected",
            field: DOMAIN_FIELD[domain],
            agent_id: null,
            source: recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
            severity: "warn",
            detail: `the project-scoped rule ${ruleId} maps to domain ${domain}, which AUDIT_PER_AGENT_DOMAINS in src/fleet/status.ts does not list; a --domain ${domain} run spawns no audit child and would not report it`,
          });
        }
        if (!domainSet.has(domain)) continue;
        const owner = recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? null;
        const state = ruleState(rule.status);
        if (scopeOfRule === "host") {
          // ONCE, deduped by rule id -- a host condition repeated 28 times is
          // not 28 problems, and folding it into an agent record would fail a
          // repository for something no work in that repository can change.
          //
          // WORST WINS, not first wins. The loop runs in alphabetical agent
          // order, so `if (!has(ruleId))` kept whichever repository came first
          // and a `pass` from `alpha` masked a `fail` for the same rule from
          // `zeta`. Repositories CAN disagree about a host rule (a rule that
          // reads both $HOME and the repo, or one that skips where the repo has
          // no notebook), so the reading that must survive is the worst one, and
          // the disagreement is recorded rather than resolved silently.
          const accumulated = hostByRule.get(ruleId);
          const candidate: FleetStatusHostFinding = {
            rule_id: ruleId,
            owner,
            domain,
            state,
            summary: bounded(redactHome(nonEmptyString(rule.summary) ?? nonEmptyString(rule.title) ?? ruleId)),
            details: boundedDetails(Array.isArray(rule.details) ? rule.details : []),
            finding_id: statusFindingId("host", null, domain, ruleId, DOMAIN_FIELD[domain], SOURCE_AUDIT),
            retrieval: retrievalFor(null, domain, true),
          };
          if (accumulated === undefined) {
            hostByRule.set(ruleId, { finding: candidate, states: new Map([[state, 1]]) });
          } else {
            accumulated.states.set(state, (accumulated.states.get(state) ?? 0) + 1);
            if (stateRank(state) < stateRank(accumulated.finding.state)) accumulated.finding = candidate;
          }
          continue;
        }
        own.push(observation(ctx, {
          domain, agentId, state,
          field: DOMAIN_FIELD[domain],
          owner,
          ruleId,
          ruleScope: "project",
          summary: nonEmptyString(rule.summary) ?? nonEmptyString(rule.title) ?? ruleId,
          details: Array.isArray(rule.details) ? rule.details : [],
          source: SOURCE_AUDIT,
        }));
      }
    }

    // `(agent_id, domain, rule_id)` -- the declared sort key. Byte order, never
    // locale order, and never completion order: `data` has to be byte-identical
    // across two runs and across the CLI/MCP pair.
    own.sort((a, b) => (
      a.domain < b.domain ? -1 : a.domain > b.domain ? 1
        : (a.rule_id ?? "") < (b.rule_id ?? "") ? -1 : (a.rule_id ?? "") > (b.rule_id ?? "") ? 1
          : a.field < b.field ? -1 : a.field > b.field ? 1
            : a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0
    ));

    // EVERY observation, from EVERY selected agent, counted -- including the
    // agents whose record the cap will drop.
    totalObservations += own.length;
    ctx.observations.push(...own);

    // Rolled up from the FULL set, not the clipped one.
    const byDomain: Partial<Record<FleetStatusDomain, FleetStatusState>> = {};
    for (const domain of domains) byDomain[domain] = rollUp(own.filter((item) => item.domain === domain));

    if (agentRecords.length >= FLEET_STATUS_MAX_AGENTS) continue;

    let kept = own;
    let clipped = false;
    let retrieval = retrievalFor(agentId, domains.length === 1 ? domains[0]! : null, live);
    if (own.length > FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT) {
      clipped = true;
      kept = own.slice(0, FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT);
      // A retrieval that RE-RUNS THE SAME CLIP is not a retrieval. On an
      // unfiltered run `--agent <id> --json` is exactly the invocation that just
      // clipped, so the narrowing has to be a `--domain`: the one whose
      // observations were dropped hardest. Running it returns that domain's
      // full set, because a single-domain record has no clip pressure from the
      // other eight.
      retrieval = retrievalFor(agentId, mostClippedDomain(own, kept, domains), live);
      truncated.push(
        `agents.${agentId}.observations: ${own.length - FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT} of ${own.length} `
        + `observations dropped; retrieve them with \`${retrieval}\``,
      );
    }
    emittedObservations += kept.length;

    agentRecords.push({
      agent_id: agentId,
      observations: kept,
      domains: byDomain,
      state: rollUp(own),
      healthy: !own.some((item) => item.state === "fail" || item.state === "error"),
      complete: !own.some((item) => item.state === "unobserved" || item.state === "error") && !clipped,
      truncated: clipped,
      retrieval,
    });
  }

  // -- fleet-scoped observations, emitted once, on the domain they belong to --
  const fleetObservations: FleetStatusObservation[] = [];
  if (needsProvenance) {
    for (const fact of provenanceFacts) {
      if (fact.scope !== "fleet") continue;
      const { domain } = classifyFact(ctx, fact);
      if (!domainSet.has(domain)) continue;
      fleetObservations.push(factObservation(ctx, fact, domain, null));
    }
    fleetObservations.sort((a, b) => (
      a.domain < b.domain ? -1 : a.domain > b.domain ? 1
        : a.field < b.field ? -1 : a.field > b.field ? 1
          : a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0
    ));
    ctx.observations.push(...fleetObservations);
    totalObservations += fleetObservations.length;
    emittedObservations += fleetObservations.length;
  }

  // -- domain rollups: every selected domain, always ------------------------
  const host = [...hostByRule.values()]
    .map(({ finding, states }) => {
      if (states.size <= 1) return finding;
      // The disagreement is DATA. An operator told only the worst reading would
      // have no way to know that 27 repositories reported something else.
      const spread = [...states.entries()]
        .sort((a, b) => stateRank(a[0]) - stateRank(b[0]))
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return {
        ...finding,
        details: boundedDetails([
          ...finding.details,
          `repositories disagreed on this host rule (${spread}); the worst reading is reported`,
        ]),
      };
    })
    .sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
  const domainRollups: FleetStatusDomainRollup[] = domains.map((domain) => {
    const perDomain = ctx.observations.filter((item) => item.domain === domain);
    const counts = Object.fromEntries(FLEET_STATUS_STATES.map((state) => [state, 0])) as Record<FleetStatusState, number>;
    for (const item of perDomain) counts[item.state] += 1;
    return {
      domain,
      state: rollUp(perDomain),
      counts,
      agents: new Set(perDomain.map((item) => item.agent_id).filter((id): id is string => id !== null)).size,
      observations: fleetObservations.filter((item) => item.domain === domain),
    };
  });

  if (ctx.droppedFindings > 0) {
    truncated.push(`findings: ${ctx.droppedFindings} of ${ctx.findings.length + ctx.droppedFindings} findings dropped`);
  }

  const findings = [...ctx.findings].sort((a, b) => (
    a.field < b.field ? -1 : a.field > b.field ? 1
      : a.code < b.code ? -1 : a.code > b.code ? 1
        : (a.agent_id ?? "") < (b.agent_id ?? "") ? -1 : (a.agent_id ?? "") > (b.agent_id ?? "") ? 1
          : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  ));
  const probes = [...ctx.probes].sort((a, b) => (
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0
  ));

  const byState = Object.fromEntries(FLEET_STATUS_STATES.map((state) => [state, 0])) as Record<FleetStatusState, number>;
  for (const item of ctx.observations) byState[item.state] += 1;

  // `collection_errors` is "sources this run could not read at all", and a
  // registry that declares no agents is one of them -- which is also what stops
  // `complete` from reading true over zero observations.
  const collectionErrors = probes.filter((record) => record.outcome !== "ok" && record.kind === "audit").length
    + (wantsAudit && auditEntry === null ? 1 : 0)
    + (inventory.totals.registered_agents === 0 ? 1 : 0);

  const totals: FleetStatusTotals = {
    agents: inventory.totals.registered_agents,
    emitted_agents: agentRecords.length,
    observations: totalObservations,
    emitted_observations: emittedObservations,
    host_findings: host.length,
    findings: findings.length + ctx.droppedFindings,
    audits_attempted: auditsAttempted,
    audits_observed: auditsObserved,
    by_state: byState,
  };

  // Two verdicts, provenance's split. `healthy` is about the fleet being wrong;
  // `complete` is about this run not having seen all of it. Host-scoped findings
  // are in NEITHER: a machine condition is not a fleet failure, and reporting it
  // as one is the category error PJAN-84 fixed.
  const health: FleetStatusHealth = {
    healthy: byState.fail === 0 && byState.error === 0,
    complete: byState.unobserved === 0 && byState.error === 0 && collectionErrors === 0 && truncated.length === 0,
    fleet_complete: false,
    failed: byState.fail,
    warned: byState.warn,
    skipped: byState.skip,
    unsupported: byState.unsupported,
    unobserved: byState.unobserved,
    errors: byState.error,
    collection_errors: collectionErrors,
    truncated: truncated.length > 0,
  };
  // Only an UNFILTERED, live run over every registered row can claim the fleet
  // itself was completely observed. A scoped answer never can, however clean.
  health.fleet_complete = health.complete
    && scope.kind === "fleet"
    && scope.domain === null
    && scope.live
    // A fleet of zero rows is not a completely observed fleet. Measured on the
    // pre-fix build: an `agents: {}` registry claimed `fleet_complete: true`
    // over nothing observed.
    //
    // Defence in depth, and said out loud as such: an empty registry ALSO
    // counts as a collection error above, which already forces `complete` false
    // and therefore this too. The conjunct stays because `fleet_complete` is the
    // field that means "every registered row was observed", and zero rows must
    // never satisfy it however `complete` was computed.
    && totals.agents > 0
    && totals.emitted_agents === totals.agents;

  return {
    contract_path: shownPath(contractPath),
    contract_version: contract.contract_version,
    scope,
    totals,
    health,
    agents: agentRecords,
    domains: domainRollups,
    host,
    findings,
    probes,
    truncated,
  };
}
