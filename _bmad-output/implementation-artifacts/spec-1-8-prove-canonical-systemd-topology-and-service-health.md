---
title: 'Story 1.8: Prove Canonical systemd Topology and Service Health'
type: 'feature'
created: '2026-09-02'
status: 'in-progress'
baseline_revision: '378051d690e29c73acbb0560c35a475eb60f15a5'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-prove-generated-profile-health-and-classify-extras.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `fleet status` still reports every agent's `systemd` domain as `unsupported` (the `unit_topology`
deferral): unit names are derived expectations, never observations. On the live host that hides real drift --
a gateway enabled+active for an agent whose registry row declares Telegram `disabled` and Slack `deferred`
(`pjangler-pm`), a verified-Telegram agent whose gateway is `disabled` (`drumjangler-pm`), a heartbeat oneshot
whose latest result is `exit-code`/209 (`automatic-ai-pm`), a deferred agent whose empty delta inherits the
fleet base's `platforms.telegram.enabled: true` (`ssbnk-pm`), five heartbeat pairs on disk the registry never
recorded, a registered agent with no units at all (`delonet-director`), a retired consumer reference
(`hermes-tonnybox-pm-consumer.service`, `not-found`), and unregistered units (`hermes-dashboard`,
`hermes-coachingagentframework-pm-*`, and a fluctuating set of transient `hermes-worker-proc_*.scope`
units -- these are `systemd-run` wrappers around live `hermes ... chat` calls, so their COUNT is
ephemeral by construction and is never an assertable quantity; only their class is).

**Approach:** Add a read-only systemd observer (`src/fleet/systemd.ts`) driven by a new versioned
`service_manifest` contract block (schema 5). It derives each selected agent's canonical unit set from
`service_model.per_agent`, samples the user manager with a bounded number of fleet-wide `systemctl --user show`
calls over a declared stabilization window, derives the desired gateway capability (`active` | `deferred` |
`undeclared`) from the registry's messaging declarations, proves gateway and heartbeat health per the template's
own stability semantics, correlates the fleet-shared Bloodbank gateway, classifies unregistered `hermes-*` units,
compares itself with the legacy `systemd.sentinel`/`hermes.registry-parity` rules, and lands the result on
five per-agent leaves, three host findings, `agents[].systemd`, and `data.systemd` -- exactly the way story 1.7
integrated the profile observer.

## Boundaries & Constraints

**Always:**
- Read-only. The only `systemctl --user` verbs ever spawned are `is-system-running`, `list-units`,
  `list-unit-files`, and `show`. Children get an allowlisted env (`PATH`, `HOME`, `XDG_RUNTIME_DIR`,
  `DBUS_SESSION_BUS_ADDRESS`, `LC_ALL=C`, `SYSTEMD_PAGER=`, `SYSTEMD_COLORS=0`, `SYSTEMD_URLIFY=0`) plus
  `--no-pager --plain --no-legend`; every child runs through `probeText` with `keepStdoutOnFailure: true`
  and a per-child `timeoutMs` bounded by the run deadline; `throwIfCancelled` after each.
- Bounded child count: one manager probe, one `list-units 'hermes-*' --all --output=json`, one
  `list-unit-files 'hermes-*' --output=json` (fleet scope only), one classification `show` for
  unregistered units, and exactly `stabilization.samples` multi-unit `show` calls covering every unit of
  interest at once -- never one child per agent per sample. A failed manager probe skips sampling entirely.
- From `Environment=` parse only `HERMES_HOME=` and `HERMES_BIN=`; from `ExecStart=` only `path=` and the
  first argv token after it; from a transient unit's `Description=` only an exact `--profile <name>` token
  matching a registered profile name. Nothing else from those properties reaches `data`, notes, items,
  or diagnostics. Every path goes through `shown` (home-redacted, bounded).
- No timestamp, age, pid, duration, or completion order in `data`. Time-derived facts are BUCKETS
  (`tick: current | overdue | never | unknown`, `latest_result: success | failed | in-progress | stuck | never | unknown`).
  Monotonic comparisons use `process.hrtime.bigint()` (CLOCK_MONOTONIC, same clock as systemd's
  `*USecMonotonic` properties -- verified within 6 ms of `/proc/uptime` on this host).
- The gate is manifest-driven and domain-gated: a `--domain registry` run spawns zero `systemctl`; a
  contract without `service_manifest` reports the five leaves `unsupported` with `capability: "systemd.manifest"`.
- Unstable windows report the transition summary, never the most favourable sample; a sample set that is
  not unanimous is `unstable`, an increasing `NRestarts` is `crash-looping`, any `activating` sample of a
  gateway is not proven.
- Unregistered units are reported and left alone; never assigned to the nearest agent name.
- Deterministic: sorted unit lists, probes deduped by `id`, two consecutive runs over unchanged state
  produce byte-identical `data`.

**Block If:** the live `~/.hermes/agents-registry.yaml` or `contracts/fleet-contract.yaml` schema changes
under you during implementation (schema is no longer 4 / `contract_version` no longer 1.3.0 at start) --
HALT `blocked`, `contract moved during implementation`.

**Never:**
- Never run `daemon-reload`, `enable`, `disable`, `start`, `stop`, `restart`, `reset-failed`, `link`, `mask`,
  `edit`, `kill`, or write under `$XDG_CONFIG_HOME/systemd/user`.
- Never invent a reporter/director exemption: `delonet-company-reporter` (blank `gateway_unit`, retired
  timers) reads as topology drift until an operator writes an `agent_exceptions` ruling with `domain: systemd`.
- Never infer verification from a token's presence: a delta `op://` reference without a registry
  `provisioning_status: verified` is `undeclared`, not `active`.
- Never read `runtime/.env`, `*.env` EnvironmentFiles, `auth.json`, logs, or 1Password. The two repo-side
  reads are `<role_dir>/role.yaml` (reconcile policy) and
  `<role_dir>/runtime/continuous-ticket-sentinel-state.json` (reconcile evidence, presence of keys only).
- Never attribute processes (story 1.9): `process_reference: "unobserved"` on every unregistered item.
- Never touch `sprint-status.yaml`, the inventory's `agents.{agent_id}.profile_name` observation, or the
  lifecycle rules in `agentLifecycle`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Canonical active agent | row `telegram.provisioning_status: verified`, `bot_username`+`bot_id` set, delta has `secrets.onepassword.env.TELEGRAM_BOT_TOKEN: op://…`, generated `platforms.telegram.enabled: true`; gateway `enabled`/`active`/`running`/`success`/`0`, identical `NRestarts` + `ExecMainStartTimestampMonotonic` in all samples; launcher or `hermes.bin` entrypoint; `HERMES_HOME` = `<root>/<profile>`; timer `enabled`/`active`/`waiting`, `OnUnitInactiveUSec=1min`, `OnBootUSec=1min`, `Unit=` paired; oneshot `inactive`/`dead`/`success`/`0`, exit ≥ start | five leaves `pass`; `capability.declared: active`; `gateway.stability.stable: true`; `heartbeat.latest_result: success`, `tick: current` | none |
| Healthy deferred | no platform `verified`, both blocks `disabled`/`deferred`; gateway `disabled`+`inactive`; delta `platforms.telegram.enabled: false` and `platforms.slack.enabled: false` | gateway leaf `pass` with `capability.declared: deferred`; heartbeat still required | none |
| Deferred but inherited enablement | as above but delta `{}` (base has `platforms.telegram.enabled: true`) | gateway `fail` item `platform-enablement-inherited:telegram` | none |
| Deferred but enabled/active (live `pjangler-pm`) | declared deferred; unit `enabled`+`active` | gateway `fail` items `deferred-but-enabled`, `deferred-but-active` | none |
| Verified but disabled (live `drumjangler-pm`) | Telegram `verified`; unit `disabled`+`inactive` | gateway `fail` `verified-channel-gateway-disabled` | none |
| Undeclared legacy row (live `skillex-pm`) | no `provisioning_status` on either platform; gateway active | gateway `fail` `channel-undeclared` (`warn` when disabled+inactive) | none |
| Entrypoint unpinned (live `automatic-ai-pm`) | `ExecStart path` = versioned release binary, row `hermes.bin` = legacy checkout | gateway/heartbeat.service item `entrypoint-unpinned` (`fail`); `entrypoint.family: hermes-bin`, `pinned: false` | none |
| Crash loop | `NRestarts` 3 → 5 across samples | gateway `fail` `crash-looping`, `stability.transitions` lists `restarts 3 -> 5` | none |
| Unstable | sample 2 `activating/auto-restart` | gateway `fail` `unstable`, transitions `active/running -> activating/auto-restart` | none |
| Failed heartbeat (live `automatic-ai-pm`) | oneshot `Result=exit-code`, `ExecMainStatus=209` | heartbeat.service `fail` `latest-result-failed`, `latest_result: failed` | none |
| Heartbeat in progress vs stuck | oneshot `activating` all samples; start age < `TimeoutStartUSec` → `in-progress` (`warn`); ≥ → `stuck` (`fail`) | timer leaf `warn`/`fail` accordingly | none |
| Overdue / never | service inactive and `now - max(LastTriggerUSecMonotonic, ExecMainExit…)` > `on_unit_inactive_sec × overdue_multiplier` → `overdue`; `LastTriggerUSecMonotonic` 0 with uptime > `on_boot_sec × 2` → `never` | timer `fail` `tick-overdue` / `tick-never` | none |
| Schedule off policy | `OnUnitInactiveUSec=5min` | timer `fail` `schedule-off-policy` | none |
| Reconcile policy | role.yaml `reconcile.enabled: true` + state file lacks `last_full_run_epoch`/`last_runner_completed_at` → `fail` `checkpoint-only`; `enabled: false` without `explicit_opt_out: true` → `warn` `reconcile-opt-out-undeclared`; no block → `warn` `reconcile-undeclared` | heartbeat.service leaf | unreadable state → `reconcile.evidence: state-unreadable`, `error` |
| Topology drift | retired `hermes-<id>-consumer.service` present; second gateway-named unit; registry `systemd.checkpoint_timer` key; heartbeat units on disk but no registry `heartbeat_timer` (live: 5 agents) | topology leaf `fail` items `retired-unit:<unit>`, `duplicate-gateway:<unit>`, `registry-retired-key:checkpoint_timer`; `heartbeat_timer` leaf `fail` `registry-undeclared` / `unit-missing` | none |
| Missing units (live `delonet-director`) | no unit files, `show` → `LoadState=not-found` | topology `fail` `gateway-missing`, `heartbeat-timer-missing`, `heartbeat-service-missing`; gateway/heartbeat leaves `fail` `absent` | none |
| Shared gateway | `hermes-fleet-bloodbank-gateway.service` = `gateways.bloodbank.systemd_unit` = `service_model.fleet_shared.bloodbank_gateway_unit`; `HERMES_HOME` = `<root>/fleet-bloodbank-gateway`; enabled+active+stable | host `systemd.shared-gateway` `pass`, `data.systemd.shared.state: healthy` | name mismatch → `fail` `identity-mismatch`; `--agent` → `coverage: unobserved`, no finding |
| Unregistered units (live) | `hermes-dashboard.service` (HERMES_HOME=`~/.hermes`), `hermes-coachingagentframework-pm-*`, `hermes-tonnybox-pm-consumer.service` (`not-found`), one or more `hermes-worker-proc_*.scope` (`transient`, Description `--profile james-brennan-pm`) | `systemd.unregistered` `warn`; classes `unclassified`, `profile-correlated`, `retired`, `transient` (`correlated_profile: james-brennan-pm`); every item `process_reference: "unobserved"`, `guidance` | `--agent` → `coverage: not-swept` |
| Manager unavailable / timeout | `is-system-running` fails with empty stdout, or the probe times out | all five leaves per agent `error` `manager-unavailable` / `manager-timeout`; host `systemd.manager` `error`; zero sampling; registry/profile domains unaffected | `degraded` (exit 1, stdout `degraded`) is AVAILABLE |
| Malformed property | `NRestarts=abc`, missing `ActiveState` | that unit's leaf `error` `property-malformed:<Key>`, other units unaffected | none |
| Unsafe path | `FragmentPath` outside `$XDG_CONFIG_HOME/systemd/user` and `/usr/lib/systemd/user`, or `HERMES_HOME` not under the fleet home | item `fragment-unsafe` / `home-unsafe` (`fail`); path shown redacted | none |
| Legacy rule contradiction | unfiltered `--live`; `systemd.sentinel` `pass` for an agent whose gateway leaf is `fail` on an enablement/activity/topology code | finding `systemd-rule-disagreement` (error/high, gating) carrying both normalized claims | stability/channel/schedule codes → `not_compared` |
| Payload guarantees | `--json` through a pipe > 64 KiB; two runs; MCP | complete JSON, byte-identical `data`, `data.systemd` and every `agents[].systemd` present via MCP | none |

</intent-contract>

## Code Map

**Live evidence (2026-09-02, HEAD d8c1753, systemd 257):** `systemctl --user is-system-running` = `degraded`
(exit 1, stdout carries the word -- `probeText` with `keepStdoutOnFailure`). Registry: 28 rows, every row has
`systemd.gateway_unit` (blank on `delonet-company-reporter`, which carries retired `checkpoint_timer` +
`cron_tick_timer`/`artifact_bridge_timer`/`watchdog_timer`); `systemd.heartbeat_timer` on 11 rows; NO
`lifecycle`/`messaging`/`reconcile` block -- messaging declaration is `telegram.provisioning_status` /
`slack.provisioning_status` (`verified` | `disabled` | `deferred`; absent on legacy rows such as `skillex-pm`,
`nautilus-trader-pm`, `automatic-ai-pm`; `condaleeza` has `telegram.status: blocked-*`). Unit files: 29 as measured 2026-09-02 13:2x (VOLATILE -- 27 when the spec was drafted three hours earlier;
assert the CLASS, never this number)
`hermes-*-gateway.service` (26 registered + unregistered `coachingagentframework-pm`, `tonnybox-pm`), 15
heartbeat pairs (registry names 11; `bloodbank/candybar/candystore/holocene/voxxy` have pairs but no field;
`delonet-director` has the field and NO units), `hermes-fleet-bloodbank-gateway.service`, `hermes-dashboard.service`,
`hermes-condaleeza-gateway.service` (registered: agent id `condaleeza`), 7 transient `hermes-worker-proc_*.scope`
(`UnitFileState=transient`, `Description=[systemd-run] … hermes --profile james-brennan-pm chat …`), loaded
`not-found` `hermes-tonnybox-pm-consumer.service`. ~216 entries in `~/.config/systemd/user` (VOLATILE; 214 at
drafting), none of the `hermes-*` fragments symlinked;
26 drop-in dirs (`10-versioned-runtime.conf` ×23 overriding `ExecStart=` to
`~/.local/share/hermes-agent/releases/<sha>/.venv/bin/hermes gateway run --replace`; 17 fragments still
`~/.hermes/hermes-agent/.venv/bin/hermes`; 12 fragments use `<role_dir>/.scripts/credential-launch.sh gateway`).
No live gateway carries `StartLimitBurst` (the current template writes 5/300 s -- not observed by this story).
Heartbeat timer: `TimersMonotonic={ OnUnitInactiveUSec=1min … }` and `{ OnBootUSec=1min … }` (two lines),
`LastTriggerUSecMonotonic=1w 5d 14h…` (a DURATION string), `Unit=`/`Triggers=` the service; oneshot:
`Type=oneshot`, `ExecMainStartTimestampMonotonic=1088126115604` (raw usec), `ExecMainCode=1`, `TimeoutStartUSec=45min`,
`TriggeredBy=` the timer. `show` on a missing unit exits 0 with `LoadState=not-found` + `LoadError=…NoSuchUnit…`;
multi-unit `show` separates units with one blank line; `list-units --output=json` fields `unit,load,active,sub,description`;
`list-unit-files --output=json` fields `unit_file,state,preset`. `pjangler-pm` gateway `Environment=` carries
`HERMES_HOME=…/profiles/pjangler-pm HERMES_BIN=… CODEX_HOME=… TERMINAL_CWD=… PATH=… OP_*` -- parse two keys only.
Deltas: `ssbnk-pm` `{}`, `pjangler-pm`/`drumjangler-pm` `secrets.onepassword.env.TELEGRAM_BOT_TOKEN`, `skillex-pm`
`SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`; base `~/.hermes/config.yaml:749-751` `platforms.telegram.enabled: true`.
`agents/hermes/pm/role.yaml` (pjangler) has NO `reconcile`/`service_state` block; `ssbnk` role.yaml has
`reconcile.enabled: false` with no `explicit_opt_out`; no `continuous-ticket-sentinel-state.json` exists under
any `agents/hermes/pm/runtime/` on this host today.

**Template contract (`templates/hermes-agent/template/.scripts`, gitlink `6bc683d8…`):** `70-systemd.sh`
writes exactly `hermes-${AGENT_ID}-gateway.service` / `-heartbeat.service` / `-heartbeat.timer` (`:25-27`),
`Environment=HERMES_HOME=<fleet>/profiles/<profile>`, `ExecStart=<role_dir>/.scripts/credential-launch.sh gateway|heartbeat`,
timer `OnBootSec=1min OnUnitInactiveSec=1min Unit=<svc> Persistent=true`; gateway ready ⇔ `telegram.provisioning_status == verified`
+ profile `TELEGRAM_BOT_TOKEN` op-ref, or slack `verified` + both `SLACK_*` refs; otherwise `disable --now` and
`service_state.gateway: deferred`; reporter role: nothing installed. `_lib.sh:952-1113`: the template's own health
semantics to mirror -- `systemd_service_health_snapshot` (loaded/active/running, `Result=success`, `ExecMainStatus=0`,
numeric `NRestarts`), `systemd_timer_health_snapshot` (timer `waiting|running|elapsed`; oneshot `inactive/dead`,
`success`, `0`, monotonic start>0 and exit ≥ start -- "systemd initializes Result=success before the first exit"),
`systemd_gateway_deferred_snapshot` (`inactive` + `disabled|masked`), `systemd_wait_for_stable_health` (6 attempts,
3 identical consecutive samples, 1 s; any failure after health = unstable; never returns early).
`channel-transaction.py:2111-2117` writes `platforms.<channel>.enabled: false` into the delta on deferral.
`heartbeat.sh:20,156-241` state file `runtime/continuous-ticket-sentinel-state.json` keys `last_decision`,
`last_full_run_epoch`, `last_full_run_started_at`, `last_runner_completed_at`, `last_heartbeat_at`, `updated_at`.

**Runtime (`src/fleet/runtime.ts`):** `probeText(ctx, command, argv, {cwd, env, timeoutMs, keepStdoutOnFailure})`
`:318-332` → `{outcome, value, status}`; stderr is always ignored (`:391`), children are spawned by name (PATH shim
is the test seam), detached + group SIGKILL on timeout (`:398,:445-450`), `PROBE_MAX_BYTES` 4 MiB (`:31`);
`probeEnv()` `:233` spreads `process.env` -- do NOT use it; build the allowlist like `AUDIT_CHILD_ENV_KEYS`
(`status.ts:499-509`, already lists `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`). `mapBounded` `:500`,
`throwIfCancelled` `:97`, `remainingMs` `:109`, `FleetProbeRecord` `types.ts:817-826`, outcomes `types.ts:753`.
Add `sleepBounded(ctx, ms)` (abort-aware, capped by `remainingMs`) beside `probeText` for the sample interval.

**Collector pattern (`src/fleet/profile.ts`):** ctx `:172-201` (`run, pjanglerRoot, home, env, fleetHome, root,
manifest, classifications, gatewayProfileName, registeredProfileNames, agents[], sweep, shown`), result `:276-287` (`export interface FleetProfileHealth`),
phases `:1434-1516`, `skipped(reason)` probe `:764`, `entryStat` (`lstat`) `:323-335`, `readBounded` (`O_NOFOLLOW`,
double `fstat`) `:348-376`, `unitReferences` `:1281-1308` (`configHome = XDG_CONFIG_HOME || ~/.config`, unit dir
`join(configHome,"systemd","user")`, follows unit symlinks on purpose) -- reuse `readBounded`/`entryStat` by export
and the same `configHome` resolution. `resolveFleetHome`/`resolveProfileLayout` `inventory.ts:658-680`.

**New `src/fleet/systemd.ts`:** `collectSystemdHealth(ctx: FleetSystemdContext)` with `{ run, home, env, fleetHome,
profileRoot, configHome, manifest, serviceModel, retired (compiled), classifications, sharedGateway {unit, profile,
registryUnit}, registeredProfileNames, agents: [{agentId, profileName, roleDir, storedGatewayUnit, storedHeartbeatTimer,
storedSystemdKeys[], messaging {telegram: {status, bot_username, bot_id}, slack: {status, bot_user_id, team_id}}}],
sweep, shown, monotonicNowUs }` → `{ manager: {state, code}, window, agents: Map<agentId, FleetSystemdAgentResult>,
shared, unregistered | null, unregisteredReason, probes }`. Phases: (1) manager probe `is-system-running`
(`running|degraded|starting|maintenance` = available; otherwise `manager-unavailable`, timeout → `manager-timeout`,
short-circuit everything to `error`); (2) fleet scope: `list-units 'hermes-*' --all --output=json` and
`list-unit-files 'hermes-*' --output=json` (cap `limits.max_units`; JSON parse failure → `listing-malformed` host error);
(3) universe of interest = every selected agent's derived triple + stored names when different + retired candidates
(`hermes-<id>-consumer.service`, `hermes-<id>-checkpoint.timer/.service`) + shared unit (fleet scope); (4) `samples`
× `show -p <PROPS> <units…>` with `sleepBounded(interval_ms)` between; `PROPS` =
`Id,Names,LoadState,LoadError,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,NRestarts,FragmentPath,DropInPaths,ExecStart,Environment,Type,Restart,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,TimeoutStartUSec,Unit,Triggers,TriggeredBy,TimersMonotonic,LastTriggerUSecMonotonic,NextElapseUSecMonotonic`;
parse `Key=Value` blocks split on blank lines, repeated keys accumulate, unknown/missing → `property-malformed`;
(5) per agent (pure, over the samples): topology → capability → gateway → heartbeat (timer + oneshot + schedule +
tick + reconcile via `readBounded` of `role.yaml` and the state file) → provenance (`ExecStart path` ∈ {`<role_dir>/.scripts/credential-launch.sh`
→ family `launcher`, row `hermes.bin` → `hermes-bin`, else `other`}; `pinned` ⇔ launcher, or `hermes-bin` equal to
the row's `hermes.bin`; `HERMES_HOME` must equal `<profileRoot>/<profile_name>` after `redact`-free string compare);
(6) fleet scope: shared gateway and unregistered classification (one extra `show` over the unregistered names,
`Description` only for `.scope`/transient). Duration parser for `1w 5d 14h 16min 26.297365s` / `1min` / `45s` /
`500ms` / `12us` → microseconds (exact policy match on `OnUnitInactiveUSec`/`OnBootUSec`). Probe records `{id:
"systemd:<verb>[:<n>]", kind: "systemd", target: <verb or unit count>, outcome, reason}`.

**Contract (`contracts/fleet-contract.yaml`, schema 4 → 5, `contract_version` 1.4.0, `max_schema_version` 5):**
new optional closed root block `service_manifest`: `stabilization {samples: 3, interval_ms: 1000}`,
`probe {timeout_ms: 4000, env_allowlist: [PATH, HOME, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS], manager_available_states: [running, degraded, starting, maintenance]}`,
`entrypoint {launcher: ".scripts/credential-launch.sh", pinned_bin_field: "agents.{agent_id}.hermes.bin", home_env: HERMES_HOME}`,
`messaging {platforms: [telegram, slack], status_field: provisioning_status, verified_status: verified, deferred_statuses: [disabled, deferred], enabled_path: "platforms.{platform}.enabled", secret_env: {telegram: [TELEGRAM_BOT_TOKEN], slack: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN]}, identity_fields: {telegram: [bot_username, bot_id], slack: [bot_user_id, team_id]}}`,
`heartbeat {on_boot_sec: 60, on_unit_inactive_sec: 60, overdue_multiplier: 5, max_tick_seconds: 2700, reconcile_policy_file: role.yaml, reconcile_state_file: runtime/continuous-ticket-sentinel-state.json}`,
`unregistered {unit_glob: "hermes-*", retired_candidates: ["hermes-{agent_id}-consumer.service", "hermes-{agent_id}-checkpoint.timer", "hermes-{agent_id}-checkpoint.service"]}`,
`limits {max_units: 1000, max_unregistered_units: 200, max_file_bytes: 65536, max_show_bytes: 4194304}`.
Remove `deferred_capabilities[0]` (`systemd`/`unit_topology`, `:412-418` -- `:411` is the
`deferred_capabilities:` block key itself and MUST survive; `:418` is the entry's `owner_story`); update the header (`units.*` note `:25`),
the `health_policy` comment (`:391-396`), and the `systemd_lifecycle` notes. `service_model` stays as is.
- `src/fleet/types.ts` -- `FLEET_CONTRACT_SCHEMA_VERSION` 5 (`:19`), max 5 (`:22`), root keys (`:40-44`,`:60`) +
  `service_manifest`; `FLEET_SERVICE_MANIFEST_KEYS` + per-block key lists beside `:100-106`; `FleetServiceManifest`,
  `FleetContract.service_manifest?` (`:382-398`); `FLEET_STATUS_SYSTEMD_CONCURRENCY = 4` beside `:1041`;
  `FLEET_SYSTEMD_ITEM_KINDS`, `FLEET_SYSTEMD_UNREGISTERED_CLASSES` (`retired | transient | profile-correlated |
  managed-exception | unclassified`), `FLEET_SYSTEMD_MANAGER_CODES`, `FLEET_SYSTEMD_CAPABILITY_STATES`;
  `FleetStatusObservationItem.kind` union (`:1558`) + `FleetSystemdItemKind`; `FleetStatusAgentSystemd`,
  `FleetSystemdSummary`, `FleetStatusSystemdUnregisteredItem` (with `process_reference: "unobserved"`);
  `FleetStatusAgent.systemd` (`:1630-1650`), `FleetStatus.systemd` (`:1819-1843`), host finding `items` union (`:1704`).
- `src/fleet/contract.ts` -- `validateServiceManifest` appended after `:269`, shaped like `validateProfileManifest`
  `:1166-1345`: closed keys at every level, `samples ≥ 1`, `interval_ms ≥ 0`, `timeout_ms ≥ 100`, `platforms` unique
  safe segments with `secret_env`/`identity_fields` keys ⊆ platforms, `enabled_path` carries `{platform}`,
  `retired_candidates` each carry `{agent_id}` and none equals a `service_model.per_agent` pattern, `pinned_bin_field`
  resolves via `resolveContractPath`-style leaf check, limits ≤ build ceilings; mutate ONE rule per test negative
  (diagnostics are first-only in `fleet status`, see the contract-diagnostics memory).
- `src/fleet/health.ts` -- `SOURCE_EVIDENCE["fleet-systemd"] = "direct"` (`:262-272`).

**Status integration (`src/fleet/status.ts`):** DELETE the stub `:1235-1251` (and `CAPABILITY_SYSTEMD` `:334` if
unused) -- the observer now owns `DOMAIN_FIELD.systemd` (`:274`), so leaving it would manufacture a
`status-contradiction`. Constants beside `:400-419`: `SOURCE_SYSTEMD = "fleet-systemd"`, rule ids `systemd.manager`,
`systemd.shared-gateway`, `systemd.unregistered`, `CAPABILITY_SYSTEMD_MANIFEST = "systemd.manifest"`, leaf fields
`SYSTEMD_FIELD_TOPOLOGY = "agents.{agent_id}.systemd.gateway_unit"`, `SYSTEMD_FIELD_HEARTBEAT_TIMER_ROW =
"agents.{agent_id}.systemd.heartbeat_timer"`, `SYSTEMD_FIELD_GATEWAY = "units.hermes-{agent_id}-gateway.service"`,
`SYSTEMD_FIELD_TIMER = "units.hermes-{agent_id}-heartbeat.timer"`, `SYSTEMD_FIELD_SERVICE = "units.hermes-{agent_id}-heartbeat.service"`
(all five declared writable under `systemd_lifecycle`, `yaml:209-214`, so `ownerOf` answers `hermes-fleet-provisioner`).
Manifest gate beside `:2134` (`domainSet.has("systemd")`). Raw inputs beside `:2089-2125` from `agentRaw.entries`
(stored `systemd.*` keys, `telegram.*`, `slack.*`, `hermes.bin`, `role_dir`, `profile_name`) and `agentRaw.siblings.gateways`
(`:2369-2371`, `systemd_unit` + `profile_name`). Collection phase after the profile phase (`:2365-2398`), before the
audit children; `sweep = scope.kind === "fleet"`; push probes; counters beside `:2401-2410`. `observeFromSystemd(ctx,
input)` modelled on `observeFromProfile` `:1505-1600` (three branches: no manifest → five `unsupported`; no result →
five `unobserved`; real → `emit` with items capped at `FLEET_STATUS_MAX_ITEMS` and the `truncated` note idiom
`:1552-1557`; `agent_exceptions` with `domain: systemd` apply to `fail` only `:1563-1566`). Host findings beside
`:2578-2712` via the `hostFinding` closure: `systemd.manager` (every scope), `systemd.shared-gateway` and
`systemd.unregistered` (fleet scope, `items`). Rule agreement beside `:3070-3100`: `audit.rules` lookup of
`systemd.sentinel` (detail literals to pin from `src/parity/rules.ts:6334-6348`: `` `${unit} should be enabled+active` ``,
`` `${gatewayUnit} is deferred and should be disabled+inactive` ``, pass summary `Hermes user units match each role's declared service state`)
and `hermes.registry-parity` (`` `registry entry for ${id} carries retired systemd.${key}` `` `:6849`, `` `retired per-agent consumer unit still on disk: ${unit}` `` `:6854`);
finding code `systemd-rule-disagreement` via `addFinding` `:874-900` with the `:3087-3097` shape. `data.systemd`
beside `:3368-3406` (`null` when the domain is not selected) = `{ source, manager: {state, code}, window: {samples,
interval_ms}, units: {listed, unit_files, transient}, agents: {total_registered, selected, complete, topology_ok,
gateway_healthy, gateway_deferred, heartbeat_healthy, unstable, crash_looping, drifted, incomplete,
exception_authorized, unobserved}, capability: {active, deferred, undeclared}, shared: {coverage, unit, profile,
state, code}, unregistered: {coverage: swept|not-swept, reason?, total, by_class{5}, listed, truncated},
rule_agreement: {compared, agree, disagree, not_compared} }`; `agents[].systemd` beside `:3173` = `{ topology:
{expected[3], installed[], missing[], extra[]: [{unit, class}], state}, capability: {declared, platforms:
{telegram, slack}, delta_disabled: {telegram: bool|null, slack: bool|null}}, gateway: {state, code?, unit, load,
unit_file, active, sub, result, exec_status, restarts, entrypoint: {family, pinned}, home: matches|mismatch|absent|unsafe,
stability: {samples, stable, transitions[]}}, heartbeat: {state, code?, timer: {unit, load, unit_file, active, sub,
paired: bool}, service: {unit, load, active, sub, result, exec_status, entrypoint}, schedule: within-policy|off-policy|unknown,
latest_result, tick, reconcile: {declared, evidence}} }`. Lifecycle (`:1760-1805`) untouched: the observer's
`fail` demotes via `anyFailure` automatically. `AUDIT_PER_AGENT_DOMAINS` `:235-237` unchanged (systemd is
observer-fed, not audit-fed); update the P9 comment `:2489-2509` and retrieval comment `:2962-2965` wording only.
- `src/fleet/output.ts` -- `FLEET_COMMAND_DATA_KEYS["fleet.status"]` + `"systemd"` (`:91-94`); item painting for the
  new kinds (`:934-946`; `in-progress`/`reconcile-*`/`channel-undeclared`(disabled) soft); `agentLine` systemd cell
  after the profile cell (`:1001-1024`, e.g. `systemd gw active·stable · hb success·current`); Domains block for
  `systemd` mirroring `:1130-1176` (manager, window, capability counts, shared, unregistered by class, rule agreement).
- `src/fleet/index.ts` -- `systemd` export block between profile (`:117-139`) and status (`:141-156`); types into
  `:307-336`. `src/fleet/cli.ts:269-271` and `src/fleet/mcp.ts:206-208,:278-279` -- drop "systemd" from the
  no-observer hints (now "live-process and Bloodbank-liveness observers … (stories 1.9/1.10)").

**Tests:**
- NEW `tests/fleet-systemd-regressions.mjs` -- copy the helper set from `tests/fleet-profile-regressions.mjs`
  (`skipCase :88`, `git :117`, `seedProfile :247`, `seedFleet :294`, `agentRow :461`, `writeAgentRegistry :486`,
  `isolation :510`, `contractDocument/writeContract/policyContract :545-560`, `makePackageRoot :567`, snapshots
  `:597-650`, `cliAt :652`, `envelope :662`, `status :678`, `entry :724`, `syntheticReport :732`, `pathShim :755`).
  Add a STATEFUL fake `systemctl`: `pathShim("systemctl-<case>", …)` dir holding the real `git` symlink and an
  executable `systemctl` sh script that `exec`s `process.execPath <shimRoot>/fake-systemctl.mjs "$@"`; the fake reads
  `SYSTEMCTL_FAKE_STATE` (JSON: `manager: {stdout, exit}`, `list_units[]`, `unit_files[]`, `units: {<name>: [sample0,
  sample1, …]}` per-sample property maps, optional `delay_ms`, `malformed`), appends `argv` to
  `<shimRoot>/systemctl-invocations.log`, bumps `<shimRoot>/systemctl-sample.counter` on each `show`, and prints
  systemd-shaped output (`Key=Value`, blank line between units, `LoadState=not-found` for unknown names, JSON for
  the listings, duration strings for `LastTriggerUSecMonotonic`/`TimersMonotonic`, raw usec for `ExecMain*Monotonic`
  computed relative to the REAL `/proc/uptime` so `current`/`overdue`/`stuck` are exercised). Set
  `isolation.DBUS_SESSION_BUS_ADDRESS = "unix:path=<temp>/no-bus"` and `XDG_RUNTIME_DIR = <temp>/no-runtime` so a
  case that forgets the shim hits `manager-unavailable`, never the host manager. Cases: one per matrix row above;
  `--agent` scope (`shared.coverage: unobserved`, `unregistered.coverage: not-swept`, only the agent's units in
  the `show` argv); `--domain registry` → zero `systemctl` invocations; the invocation log contains ONLY
  `--user is-system-running|list-units|list-unit-files|show` (assert the mutation verb list absent); child env
  keys == allowlist (recording fake); per-probe timeout (`delay_ms` > `probe.timeout_ms`) → `manager-timeout`
  within the deadline; unfiltered `--live` with a `PJ_FLEET_CLI_ENTRY` synthetic report carrying a `systemd.sentinel`
  `pass` beside an observer gateway `fail` → `systemd-rule-disagreement`; `agent_exceptions` (`domain: systemd`)
  flipping a drifted agent to `exception`; contract negatives (unknown key, `samples: 0`, `enabled_path` without
  `{platform}`, `retired_candidates` colliding with `per_agent`, `secret_env` for an undeclared platform -- ONE rule
  each); schema-4 contract without the block → five `unsupported`/`systemd.manifest`; > 64 KiB pipe; two-run byte
  identity; `SECRET_SENTINEL` planted in a fake `Environment=TELEGRAM_BOT_TOKEN=…`, `ExecStart` argv, a scope
  `Description`, and the delta → absent from stdout; no `/home/<user>`, no ISO timestamp, no raw `USec` value in the
  payload; MCP parity (`pjangler_fleet_status {domain: "systemd"}` deep-equals CLI `data`); zero-write snapshots
  (temp + package root + fake unit dir); registration (runner, README `### systemd topology and service health`,
  mise `user manager`, CHANGELOG `feat(PJAN-110)`, ledger DW-97 + annotations); and ONE live-gated AC case: real
  fleet `--domain systemd --json` at `cwd: ROOT` with `process.env`, then an independent
  `systemctl --user show -p Id,LoadState,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,NRestarts` of
  `pjangler-pm`'s three units and `hermes-fleet-bloodbank-gateway.service` asserting `agents[pjangler-pm].systemd`
  and `data.systemd.shared` agree field-by-field, an independent `list-unit-files 'hermes-*'` whose every name
  appears as an owned unit, a retired candidate, the shared unit, or an `unregistered` item, and unchanged
  `~/.config/systemd/user` snapshot + unchanged `NRestarts`/`ActiveEnterTimestamp` for the four units before/after
  (`skipCase` on missing registries or an unavailable manager).
- `tests/fleet-status-regressions.mjs` -- `--domain systemd` case `:906-928` becomes an observed run against a fake
  (or `manager-unavailable` → `error`, `probes` = the manager probe only, `systemd.manager` host error);
  `health.unsupported` pin `:1602` ("three domains" → two); `isolation` gains the no-bus vars. `tests/fleet-health-regressions.mjs:866-899`
  → use the `live_process`/`process_attribution` deferral (owner `1.9`); header `:7-8`. `tests/fleet-contract-regressions.mjs:1198-1211`
  (index 0 is now `live_process`), `:1488` (`>= 2`), schema 5 loads / 1-4 still load. `tests/mcp-server-regressions.mjs:569-573`
  + `{ domain: "systemd" }` row. `tests/fleet-scaffold-regressions.mjs` / `tests/fleet-profile-regressions.mjs`
  `isolation` gain the no-bus vars. `scripts/run-tests.mjs` `SUITES` -- add after `:109`.
- Hazards already learned: `GIT_CEILING_DIRECTORIES`, `update-index --refresh` before measuring, shims outside the
  snapshotted tree, no `/home/<name>` literal, payloads > 65 536 B, `maxBuffer` explicit, `systemctl` in
  `src/parity/rules.ts:595` has no timeout and inherits `process.env` -- under `--live` the fake intercepts the
  recipe audit's calls too, so its log must show no mutation verb from either caller.

**Docs/ledger:** `README.md:283` `systemd` row rewritten; footnote `:288-293` and `:305-307` ("Story 1.8 owns…")
updated; new `### systemd topology and service health` between `:511` and `### Seven states` `:513` naming the five
leaves, the capability derivation, the stability window, heartbeat proof, shared/unregistered coverage labels, and
the allowlisted child environment; `mise.toml:59-76` comment (mention the user manager and the sample window);
`CHANGELOG.md` `## [Unreleased]` `### Added` `feat(PJAN-110)` bullet; `deferred-work.md`: next free number is
**DW-97**; annotate DW-1 (retired timers now load-bearing), DW-10 (`units.*` observed), DW-29, DW-63 (systemd
deferral removed), DW-71/DW-78 (gateway now observed), DW-93 (unit STATE observed by 1.8).

## Tasks & Acceptance

**Execution:**
- `src/fleet/runtime.ts` -- add `sleepBounded(ctx, ms)` (abort-aware, capped by `remainingMs`) -- the sample interval must respect the run deadline
- `contracts/fleet-contract.yaml` -- schema 5: `service_manifest`, remove the `unit_topology` deferral, bump versions, update comments -- the policy the observer consumes
- `src/fleet/types.ts` -- schema constants, manifest keys/types, concurrency cap, item kinds, classes, codes, `FleetStatusAgentSystemd`, `FleetSystemdSummary`, `agents[].systemd`, `data.systemd` -- one vocabulary for CLI and MCP
- `src/fleet/contract.ts` -- `validateServiceManifest` stage -- policy that names nothing real must fail to load
- `src/fleet/profile.ts` -- export `readBounded`, `entryStat`, and the `configHome` resolution -- shared read idioms
- `src/fleet/systemd.ts` -- the observer (manager probe, listings, universe, sampled `show`, parser + duration parser, topology/capability/gateway/heartbeat/provenance evaluation, shared gateway, unregistered classification, probes) -- greenfield
- `src/fleet/health.ts` -- `fleet-systemd` evidence mapping -- direct evidence, not `derived`
- `src/fleet/status.ts` -- delete the stub, raw inputs, collection phase, `observeFromSystemd`, three host findings, rule agreement, `data.systemd`, `agents[].systemd` -- the integration
- `src/fleet/output.ts` -- data key, item painting, systemd cell, Domains block -- the human surface
- `src/fleet/index.ts`, `src/fleet/cli.ts`, `src/fleet/mcp.ts` -- exports and hint strings -- typed callers, truthful hints
- `tests/fleet-systemd-regressions.mjs` -- the new suite with the stateful fake `systemctl` (matrix rows, scoping, zero mutation, env allowlist, timeouts, rule contradiction, exceptions, contract negatives, caps, secrets, byte identity, MCP parity, registration, live AC) -- proof against a real user manager and a scripted one
- `tests/fleet-status-regressions.mjs`, `tests/fleet-health-regressions.mjs`, `tests/fleet-contract-regressions.mjs`, `tests/mcp-server-regressions.mjs`, `tests/fleet-scaffold-regressions.mjs`, `tests/fleet-profile-regressions.mjs` -- flipped pins, no-bus isolation, schema 5, parity -- keep the existing truth tables green for the right reasons
- `scripts/run-tests.mjs` -- register the suite -- a suite is invisible until listed
- `README.md`, `mise.toml`, `CHANGELOG.md`, `_bmad-output/implementation-artifacts/deferred-work.md` -- docs and ledger -- parity checks assert them

**Acceptance Criteria:**
- Given a five-agent isolated fleet behind the fake `systemctl` where one agent is canonical-active, one canonical-deferred, one deferred with an empty delta, one verified-but-disabled, and one legacy-undeclared-active, when `fleet status --domain systemd --json` runs, then the gateway leaves read `pass`, `pass`, `fail` (`platform-enablement-inherited:telegram`), `fail` (`verified-channel-gateway-disabled`), `fail` (`channel-undeclared`), `data.systemd.capability` reads `{active: 2, deferred: 2, undeclared: 1}`, and exactly `1 + 2 + samples` `systemctl` invocations were recorded (one more only when an unregistered unit exists), none carrying a mutation verb.
- Given a gateway whose fake samples read `NRestarts` 3, 4, 5 and another whose second sample is `activating/auto-restart`, when the window completes, then the first is `fail` `crash-looping` with `transitions: ["restarts 3 -> 5"]`, the second is `fail` `unstable` with `transitions: ["active/running -> activating/auto-restart"]`, neither `stability.stable` is true, and no per-sample timestamp or restart value appears outside those two summaries.
- Given a heartbeat whose oneshot is `activating` with `ExecMainStartTimestampMonotonic` younger than `TimeoutStartUSec`, another older than it, a third with `Result=exit-code`, a fourth with `LastTriggerUSecMonotonic` older than `5 × 60 s` and inactive service, and a fifth with `OnUnitInactiveUSec=5min`, when heartbeat health runs, then `latest_result`/`tick`/`schedule` read `in-progress`, `stuck`, `failed`, `overdue`, `off-policy` respectively; the TIMER leaf carries the `in-progress` item (`warn`), the `stuck` item (`fail`), `tick-overdue` (`fail`) and `schedule-off-policy` (`fail`) -- it owns whether the tick is happening -- while the ONESHOT's leaf carries `latest-result-failed:exit-code` (`fail`) for the completed run that failed; and `data` contains no `USec`, `Monotonic`, or epoch value.
- Given `role.yaml` declaring `reconcile.enabled: true` with no state file, `enabled: false` without `explicit_opt_out`, `enabled: false` with `explicit_opt_out: true`, and no block, when the heartbeat.service leaf is produced, then codes are `checkpoint-only` (`fail`, `evidence: state-missing`), `reconcile-opt-out-undeclared` (`warn`), none (`declared: opted-out`), `reconcile-undeclared` (`warn`); a state file that EXISTS carrying neither key, or exactly one of the two, is also `checkpoint-only` (`fail`) while both together are `full-run` (`pass`); and sentinels planted in `runtime/.env`, `auth.json`, and `runtime/logs/heartbeat.log` never appear in stdout while the fixture tree is byte-identical before and after.
- Given a registry row with `systemd.checkpoint_timer`, a `hermes-<id>-consumer.service` on disk, a second gateway-named unit, heartbeat units on disk with no registry `heartbeat_timer`, a stored `gateway_unit` differing from the derived name, and a row whose three units are absent, when topology runs, then items `registry-retired-key:checkpoint_timer`, `retired-unit:…consumer.service`, `duplicate-gateway:…`, `misnamed-gateway:…` make the topology leaf `fail`, the `heartbeat_timer` leaf reads `fail` `registry-undeclared` / `unit-missing` as appropriate, and the absent agent's five leaves are `fail` with `gateway-missing`, `heartbeat-timer-missing`, `heartbeat-service-missing`, `absent`, `absent`.
- Given a fleet-scope run whose listings include `hermes-dashboard.service` (HERMES_HOME = fleet root), `hermes-stray-pm-gateway.service` (HERMES_HOME = an unregistered profile dir), `hermes-old-pm-consumer.service` (`not-found`), a `hermes-worker-proc_x.scope` (`transient`, `Description` with `--profile alpha-pm`), and a unit named by a `managed_shared_service` entry with `systemd` in `policy_domains`, when classification runs, then `systemd.unregistered` is `warn` listing classes `unclassified`, `profile-correlated`, `retired`, `transient` (`correlated_profile: alpha-pm`), `managed-exception`, every item carries `process_reference: "unobserved"` and `guidance`, `health.verdict` is `unproven`, and the fake unit dir is byte-identical before and after.
- Given the shared gateway unit whose `HERMES_HOME` matches `<root>/fleet-bloodbank-gateway`, is enabled+active+stable, and whose name equals both `gateways.bloodbank.systemd_unit` and `service_model.fleet_shared.bloodbank_gateway_unit`, when a fleet-scope run completes, then `systemd.shared-gateway` is `pass`; when the registry `systemd_unit` names a different unit it is `fail` `identity-mismatch`; and under `--agent alpha-pm` `data.systemd.shared.coverage` is `unobserved`, `unregistered.coverage` is `not-swept`, no `list-*` verb is invoked, and the `show` argv names only alpha-pm's units and retired candidates.
- Given `DBUS_SESSION_BUS_ADDRESS` pointing at a missing socket (no shim), a fake whose `is-system-running` sleeps past `probe.timeout_ms`, and a fake emitting `NRestarts=abc` for one unit, when status runs, then the first two produce five `error` leaves per agent with `manager-unavailable` / `manager-timeout`, a `systemd.manager` host `error`, zero `show` invocations, and intact `registry`/`profile` domains, while the third produces `error` `property-malformed:NRestarts` on that unit's leaf only. A sample that carries a unit and OMITS a required property (`LoadState`, `UnitFileState`, `ActiveState`, `SubState`) is the same class of failure -- `error` `property-malformed:<Key>` on that unit's leaf, every other unit and agent read normally out of the same window -- and is distinct from an ABSENT unit, which carries all four and reads `absent`.
- Given unfiltered `--live` with a `PJ_FLEET_CLI_ENTRY` synthetic report whose `systemd.sentinel` passes for an agent the observer reads `deferred-but-enabled`, when findings are produced, then `systemd-rule-disagreement` is present and gating carrying both claims, `data.systemd.rule_agreement.disagree` is 1, and an agent whose only divergence is `unstable` is `not_compared`.
- Given the same fake fleet run twice, through a pipe with a payload > 64 KiB, and through the MCP tool, when `data` is compared, then it is byte-identical, complete, and `data.systemd` plus every `agents[].systemd` is present in all three; a schema-4 contract without `service_manifest` reports every selected agent's five leaves `unsupported` with `capability: "systemd.manifest"` and `health.unjustified > 0`.
- Given the live fleet, when the story is closed, then `pjangler fleet status --domain systemd --json` reports 28 registered agents with `data.systemd.manager.state` = `degraded`-or-`running` (available), `pjangler-pm` gateway `fail` `deferred-but-enabled` with `stability.stable: true`, `drumjangler-pm` `verified-channel-gateway-disabled`, `automatic-ai-pm` heartbeat `latest_result: failed` and `entrypoint-unpinned`, `ssbnk-pm` `platform-enablement-inherited:telegram`, `delonet-director` `gateway-missing`, the shared gateway `pass`, `unregistered` listing `hermes-dashboard.service`, `hermes-coachingagentframework-pm-gateway.service`, `hermes-tonnybox-pm-*`, and the `hermes-worker-proc_*.scope` units (`transient`, `correlated_profile: james-brennan-pm`), and an independent `systemctl --user show` of the four pjangler/shared units recorded in the Auto Run Result agrees with the payload field-by-field.

## Spec Change Log

**2026-09-02, operator repair pass (pre-implementation).** The run that wrote this spec was killed
externally at 11:03 with its dev session mid-flight. Before re-entering implementation, six defects in the
spec itself were found and fixed -- five would have mis-instructed an implementer, one would have HALTed the
story at `## Verification`. Every claim below was re-measured on this host, not inferred.

1. **`deferred_capabilities[0]` anchor was off by one and destructive.** The spec said remove `:411-417`.
   Read at HEAD: `:411` is the `deferred_capabilities:` block KEY, `:412` is `- domain: systemd`, `:418` is
   that entry's `owner_story: "1.8"`. Following the spec literally would have deleted the block key and left
   `owner_story` orphaned, corrupting `health_policy`. Corrected to `:412-418` with both boundaries named.
2. **`src/fleet/profile.ts` result-shape anchor pointed at the wrong symbol.** The spec said `:284-295`.
   Read at HEAD: `export interface FleetProfileHealth` is `:276-287`; `:293-296` is the unrelated `gitArgv`
   helper. Corrected, and the symbol is now named so a future drift is self-evident.
3. **The transient-scope count was pinned and is not a pinnable quantity.** The spec asserted "seven
   transient `hermes-worker-proc_*.scope`" in the Intent and "7" in the I/O matrix. Re-measured three hours
   later: 10. These are `systemd-run` wrappers around live `hermes ... chat` calls; they appear and vanish
   on their own. Both occurrences now assert the CLASS and explicitly disclaim the count. (Both sit inside
   `<intent-contract>`; this is an operator correction of a stale OBSERVATION, not a change of intent -- the
   requirement, that transient scopes are classified and left alone, is untouched.)
4. **Two more live counts had already drifted.** `hermes-*-gateway.service` unit files: 27 at drafting, 29
   now. `~/.config/systemd/user` entries: 214 at drafting, 216 now. Both re-measured and marked VOLATILE so
   the new suite asserts classification rather than arithmetic.
5. **The live two-run byte-identity check was flaky by construction and would have HALTed the story.**
   `## Verification` demanded `diff` over the whole live `.data` across two runs, while the transient-scope
   set moves on its own. step-03 HALTs `blocked` on a verification failure it cannot fix, so this was the
   single most likely way for the story to die with correct code. The determinism proof now lives where it
   is actually determinate -- the fake, over fixed state -- and the live check excludes `unregistered` with
   the reason stated.
6. **The live zero-write check hashed mtimes.** `ls -la --time-style=full-iso ~/.config/systemd/user |
   sha256sum` fails on any concurrent fleet write (a heartbeat tick every 60s, another agent, `fleet:sync`)
   while proving nothing about a read-only observer. Replaced with a content hash of the `hermes-*`
   fragments, which fails only on a real write.

**Checked and NOT changed:** a review pass claimed an unregistered `hermes-openclaw-gateway.service` was
missing from the spec's enumeration. It does not exist. `~/.config/systemd/user` holds
`openclaw-gateway.service` (and an `openclaw-gateway.service.bak`) with NO `hermes-` prefix, so it falls
outside `unregistered.unit_glob: "hermes-*"` and is correctly out of this story's scope. The registry's
28-row count and the `is-system-running` = `degraded` claim both re-verified true.

**Recovered work.** The killed session's implementer subagent produced 840 on-plan insertions across
`contracts/fleet-contract.yaml` (schema 4 -> 5 + `service_manifest`), `src/fleet/contract.ts` (+244,
`validateServiceManifest`), `src/fleet/types.ts` (+423), `src/fleet/profile.ts` (+33, exports),
`src/fleet/runtime.ts` (+34, `sleepBounded`) and `src/fleet/health.ts` (+4). The diff was snapshotted before
the tree was reverted, still applies clean at HEAD, and typechecks with exactly TWO errors -- both the single
deliberate missing wire (`FleetStatusAgent.systemd` / `FleetStatus.systemd` declared required but not yet
populated in `src/fleet/status.ts`), which is the next task on the list either way. It was re-applied rather
than re-derived.

**2026-09-02, matrix test audit closure (post-implementation).** The suite was green and the Matrix Test
Audit gate still failed: green proved the code agreed with itself, not that every row of the I/O matrix had
a test that would go red if the behaviour changed. Fifteen gaps were closed. Three of them were CONTRACT
decisions -- a test disagreed with the matrix, and the rule is that the code moves, never the expectation:

1. **`in-progress` / `stuck` moved to the heartbeat TIMER leaf.** The matrix puts the `warn`/`fail` on the
   timer; the observer pushed both items onto the oneshot's leaf, and the test had been written to the code.
   The matrix is coherent rather than ambiguous: the timer leaf consistently owns whether the tick is
   HAPPENING (`tick-overdue`, `tick-never`, `schedule-off-policy`, and now a wedged or progressing
   activation) while the oneshot's leaf owns whether the last COMPLETED run succeeded
   (`latest-result-failed`). The item placement moved; the `latest_result` bucket still reports
   `in-progress`/`stuck` from the same single evaluation (`evaluateTickActivation`), and `in-progress` moved
   from `serviceRank` to `timerRank` with it.
2. **`platform-enablement-inherited` now consults the fleet base.** The row's input is a delta of `{}`
   against a base that enables telegram, and its output names ONE item. The observer read only the delta, so
   a delta-empty agent was flagged for EVERY deferred platform -- saying "inherited" about a platform nothing
   enables. It now reads `HERMES_HOME/config.yaml` once per run and reports the EFFECTIVE enablement (the
   delta's pin when it has one, the base's value when it does not). This supersedes DW-98, whose entry
   records why the original deferral no longer holds.
3. **A missing required property is `property-malformed`, not a default.** The row's second input is a
   missing `ActiveState`, which the observer coerced to `""` -- so it reported `inactive`, a VERDICT, about a
   property nobody read, and `property-malformed` could only ever fire for a numeric parse failure. Every
   unit sample is now validated against `SYSTEMD_REQUIRED_PROPERTIES` (`LoadState`, `UnitFileState`,
   `ActiveState`, `SubState` -- the four systemd prints for every unit type, and for a unit that does not
   exist), and a missing one errors THAT unit's leaf only. An absent unit still reads `absent`: it carries
   all four, with an empty `UnitFileState`, so the two readings cannot be confused.

The remaining twelve were test gaps, all closed by asserting the artifact the matrix NAMES rather than a
proxy -- the item code where the row names a code (`duplicate-gateway:<unit>`, `deferred-but-active`,
`tick-overdue`, `schedule-off-policy`, `latest-result-failed:exit-code`, `property-malformed:ExecMainStatus`),
the leaf STATE where it names a severity -- and by making the fixture actually drive the branch: a real
second `*gateway.service` for the duplicate rule (the old fixture's "second gateway" did not end in
`gateway.service`, so the duplicate loop skipped it and the misnamed branch's side effect satisfied the
assertion), `serviceExec` for the oneshot's entrypoint (no case had ever passed it), unsafe paths moved UNDER
the scratch HOME so `redactHome` actually fires, a state file that exists and evidences only a checkpoint,
and an unfiltered run with an unreachable manager to prove the registry and profile domains do not move.
Every one was verified by MUTATION: the covered line was deleted or inverted, the suite rebuilt, and the
case confirmed red.

Two host dependencies were removed rather than skipped. `tick-never` compared this host's uptime against
`on_boot_sec x 2` and would have FAILED on a box booted under 120 s ago; the case now pins `on_boot_sec: 1`
in its own contract, which any host running the suite has exceeded. The overdue threshold is proven by a
290 s / 310 s pair around `60 s x 5`, which pins the multiplier in both directions with ten seconds of margin
for the run's own duration.

## Review Triage Log

## Design Notes

**Sample the manager, not the agents.** One `show` call can carry every unit of interest; three fleet-wide
samples one second apart cost three children and about two seconds regardless of fleet size. Per-agent-per-sample
children would cost 84+ spawns and could never share one observation window, so "the same window" in AC7/AC9 would
be a fiction.

**Desired state comes from the registry's declaration, not from the unit.** `70-systemd.sh` enables the
gateway only when a platform's `provisioning_status` is `verified` and disables it otherwise. Reading the
declaration back from the same registry rows makes "enabled but deferred" and "verified but disabled" visible as
drift instead of two alternate healthy modes, and makes a legacy row with no declaration `undeclared` -- an active
gateway with no verified channel ownership is exactly the liveness theatre the epic forbids.

**Five leaves, all declared writable.** The `systemd_lifecycle` authority already names the gateway unit, the
heartbeat service, the heartbeat timer, and the two registry fields; using those as the observation leaves lets
`ownerOf` answer every finding, keeps a topology `fail` from contradicting the inventory (which sits on
`profile_name` and `expected_units`), and lets `by_state` count agents per aspect.

**Buckets, never ages.** `LastTriggerUSecMonotonic` and `ExecMain*Monotonic` are compared against
`process.hrtime.bigint()` inside the run and reduced to `current | overdue | never` and
`in-progress | stuck`. Two runs over unchanged state produce identical bytes; a tick between runs is a real change.

**The template's stability rule is the contract.** `systemd_wait_for_stable_health` rejects any window in which
a unit looked healthy and then changed; `systemd_timer_health_snapshot` refuses a oneshot that has not completed
(systemd pre-initialises `Result=success`). The observer encodes both, so a deploy's "stabilized" claim and status's
reading can never disagree about what stable means.

```yaml
service_manifest:
  stabilization: { samples: 3, interval_ms: 1000 }
  messaging: { platforms: [telegram, slack], verified_status: verified, enabled_path: "platforms.{platform}.enabled" }
  heartbeat: { on_unit_inactive_sec: 60, on_boot_sec: 60, overdue_multiplier: 5 }
```

## Verification

**Commands:**
- `npm run typecheck && npm run build` -- expected: clean
- `npm test` -- expected: every suite green including `tests/fleet-systemd-regressions.mjs`; the live case runs (not skipped) on this host
- DETERMINISM, proven where it is actually determinate -- against the FAKE, whose state cannot move under
  the run: the suite's two-run case asserts `data` is byte-identical across two invocations over one fixed
  `SYSTEMCTL_FAKE_STATE`. That is the real proof and it is the gating one.
- DETERMINISM against the LIVE manager, stated honestly: `node dist/index.js fleet status --domain systemd
  --json > /tmp/s1.json; node dist/index.js fleet status --domain systemd --json > /tmp/s2.json;
  diff <(jq -S '.data.systemd | del(.unregistered)' /tmp/s1.json) <(jq -S '.data.systemd | del(.unregistered)' /tmp/s2.json)`
  -- expected: no diff. `unregistered` is EXCLUDED deliberately, not defensively: `hermes-worker-proc_*.scope`
  units are `systemd-run` wrappers around live chat calls that appear and vanish on their own (measured 7 at
  drafting, 10 three hours later), so a live set-equality assertion over them is flaky BY CONSTRUCTION and
  would report the host's own activity as this observer's nondeterminism. A live diff outside `unregistered`
  is a real defect; re-run once before believing a diff inside it.
- `systemctl --user show hermes-pjangler-pm-gateway.service hermes-pjangler-pm-heartbeat.timer hermes-pjangler-pm-heartbeat.service hermes-fleet-bloodbank-gateway.service -p Id,LoadState,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,NRestarts` -- expected: agrees with `agents[pjangler-pm].systemd` and `data.systemd.shared`
- `node dist/index.js fleet status --domain registry --json | jq '[.data.probes[] | select(.kind=="systemd")] | length'` -- expected: 0
- `node dist/index.js fleet contract validate` -- expected: exit 0 at schema 5
- `grep -c 'USec\|Monotonic\|op://\|/home/\|TOKEN=' /tmp/s1.json` -- expected: 0
- ZERO-WRITE against the live unit directory, by CONTENT rather than by `ls` metadata:
  `find ~/.config/systemd/user -maxdepth 1 -name 'hermes-*' -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`
  before and after -- expected: identical. The original `ls -la --time-style=full-iso ... | sha256sum` is
  rejected: it hashes mtimes and the directory listing, so ANY concurrent fleet write (a heartbeat tick, a
  `fleet:sync`, another agent) fails it while proving nothing about this read-only observer. Content hashes
  fail only on a real write. The gating zero-mutation proof remains the fake's invocation log, which must
  contain no verb outside `is-system-running|list-units|list-unit-files|show`.
