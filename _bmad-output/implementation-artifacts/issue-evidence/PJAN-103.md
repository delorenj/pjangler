# PJAN-103 — delivered owner changes and bounded verification

## Outcome and owner commits

All six scoped acceptance criteria are implemented, independently reviewed (SPEC PASS,
QUALITY no blocking findings at the reviewed heads), and merged on the four owner
remote mains under operator standing approval. This is **source integration only**:
no installation/deployment, live Plane requests, board/ticket writes, employee
rollout, service restart, schedule, or assignee change occurred. The PM owns
subsequent ticket disposition.

| Owner | Review branch | Committed change |
| --- | --- | --- |
| 33GOD / canonical Krebs | `fix/PJAN-103-plane-state-map` | [af7fbc0dbb6b3e7856995824a4a44f82ad649db9](https://github.com/delorenj/33GOD/commit/af7fbc0dbb6b3e7856995824a4a44f82ad649db9): reject unknown map keys before requests; decode single-line YAML plain/single/double quoted scalars, escapes and comments using Python stdlib |
| hermes-agent-template | `fix/PJAN-103-todo-default` | [71a3a183cbe32e3d151cf6dfd16f27eb2b7f16ea](https://github.com/delorenj/hermes-agent-template/commit/71a3a183cbe32e3d151cf6dfd16f27eb2b7f16ea): sync the canonical provider through existing `KREBS_TP_ADAPTERS=... mise run tp:vendor`; fail rather than skip without Copier |
| Flume | `fix/PJAN-103-template-pin` | [d2537b04aa7e0200da21f0eb49a302ee5a352f81](https://github.com/delorenj/flume/commit/d2537b04aa7e0200da21f0eb49a302ee5a352f81): pin that template, normal-gate real generated-consumer integration, declare Copier test tool, keep excluded Linear out of scaffold audit/migration |
| PJangler | `fix/PJAN-103-regressions` | [a94e57037847dc8528dc38a8ae789fbb14dbff82](https://github.com/delorenj/pjangler/commit/a94e57037847dc8528dc38a8ae789fbb14dbff82): expand canonical owner suite from 10 to 20 checks, including true five-state board and YAML/map quality findings |

The template's generated `.scripts/lib/ticket-provider.sh` really executes the
vendored `.scripts/providers/plane.sh`; canonical-only success did not prove
adoption. The vendor now matches canonical bytes (vendoring test passes).
`hermes.pm-scaffold` sees those shipped bytes as desired, not locally-modified.
The narrowly scoped parity exclusion matches Copier's existing `linear.sh`
exclusion; it neither removes existing employee files nor expands provider retirement.

## Acceptance matrix

| AC | Implemented and tested evidence | Installed / deployed |
| --- | --- | --- |
| 1 — fresh role with two unstarted states | Real Copier `copy -T --trust --defaults`; unedited generated role/dispatcher selects Todo, one PATCH, same-ticket GET/readback. Integration check 1. | No / No |
| 2 — mapping precedence | Actual files: project Ready beats generated Todo; role Ready works without project map; empty role falls back to Todo. Canonical checks 2–3; generated checks 3–4. Project manifest board/workspace URLs asserted in every generated request. | No / No |
| 3 — invalid targets and stock board | Missing, duplicate, wrong-group refuse with no PATCH; malformed map/unknown key refuse before any request. Exactly five fixture states (no Ready) resolve all standard lanes and transition Todo; generated check 2 and canonical check 20. YAML escapes, quotes, comment markers, Unicode and invalid scalar refusals are exercised. | No / No |
| 4 — supported consumption/regeneration/parity | Existing owner→vendor→Flume gitlink path. Forced real Copier refresh retains project map plus explicit conflicting legacy role choice; real `hermes.pm-scaffold` migration/audit ends **pass**, empty details, fixed provider unchanged, no Linear. Review and hold retain other labels; hold does not move Todo; wrong-issue readback fails after one PATCH. | No / No |
| 5 — hermetic normal gates | PJangler suite remains registered in its runner. Flume registers `tests/pjan-103-generated-consumption.mjs` in `scripts/run-tests.mjs`; real Copier 9.14.0 is declared in `tests/requirements.txt` and README, fail-loud if absent, no new PJangler Copier dependency. Real adapter/dispatcher requests hit only recording curl fixtures under network isolation. | No / No |
| 6 — precise handback | Owner links above; raw commands, exits and rule JSON in [PJAN-103-verification.txt](PJAN-103-verification.txt). Independent SPEC/QUALITY reviews passed; operator-authorized main integration receipts below. | No / No |

## Execution results

Raw output is committed in `PJAN-103-verification.txt`; temporary fixtures/logs
are under active-profile `$TMPDIR/PJAN-103-repair`. Bubblewrap binds that scratch
onto `/tmp` for runners that force `/tmp`. These are focused results, not a full
suite certification.

- Canonical adapter standalone: **20 checks passed**, exit 0.
- PJangler `node scripts/run-tests.mjs pjan-103 pjan-23 pjan-50` with explicit
  `PJ_TICKET_PROVIDER_ADAPTERS` to canonical review worktree: typecheck/build OK,
  **3/3 suites passed**, exit 0.
- Template generated Plane/Trello defaults plus canonical mirror tests:
  **5 passed**, exit 0.
- Flume `node scripts/run-tests.mjs pjan-103 pjan-48 role-contract scaffold-conditional`:
  typecheck/build OK, **4/4 suites passed**, exit 0.
- Generated consumer standalone: **13 integration checks passed**, exit 0.
  Actual parity initially reports only the three expected unprovisioned `-T`
  runtime/SOUL metadata findings; supported scratch migration returns `applied`,
  post-audit returns `pass`, `1 orchestrator scaffold(s) verified`, `details: []`.
  No provider is classified locally-modified and Linear stays absent.
- Counterfactual: mounting only the old template provider from `9271e54` makes the
  same integration **exit 1**, actual `{state: 'todo'}` vs expected `{state: 'ready'}`.
  This proves the new gate catches the review's original consumer bug.
- Missing-Copier probe **exits 1** with actionable install error, not skipped green.
- Shell syntax and `git diff --check` pass for changed owners.

## Honest gate boundaries

Adding `check:hermetic-test-env` to the focused PJangler command returns **exit 1**:
3 suites pass but the existing `tests/pjan-75-regressions.mjs:55` ungranted
`PJAN75_CLI_BUILT` env read fails the repository gate. Independent review reproduced
that identical failure on parent and review head. It is not fixed in this scope.

The previous full PJangler run was interrupted at **40/124**, not completed; no
full-green claim is made. The prior release-unpublished explanation is obsolete:
current PJAN-166 with npm registry access **passes 45/45, exit 0**. An additional
network-isolated attempt failed with `ENETUNREACH`, then the real allowed-registry
rerun passed; both actual outputs are retained, not conflated with code failures.

Independent review cleared the six scoped AC and found no QUALITY blocker on the
listed review heads. Operator standing approval authorized landing, not PM merge
approval. Source is now on remote main; installed/deployed acceptance and any
fleet refresh remain unclaimed. No board write was made.

## Main integration and landed checks (2026-11-19)

| Owner | Remote main merge | Integration detail |
| --- | --- | --- |
| hermes-agent-template | [af82ef125f6cb7382f17f9e5dda596658a2784f5](https://github.com/delorenj/hermes-agent-template/commit/af82ef125f6cb7382f17f9e5dda596658a2784f5) | dedicated main worktree; shared detached submodule checkout left detached; merge contains `71a3a18` |
| Flume | [029d1b3317ec5da51b5ecf2c974bc597e6256bd4](https://github.com/delorenj/flume/commit/029d1b3317ec5da51b5ecf2c974bc597e6256bd4) | ticket-only [2497922](https://github.com/delorenj/flume/commit/2497922) advanced template gitlink from reviewed `71a3a18` to its landed merge `af82ef1`; merged over current main |
| 33GOD canonical adapter | [275b1b432a37ac7f86cc5c706f5e6af6fd0b86e4](https://github.com/delorenj/33GOD/commit/275b1b432a37ac7f86cc5c706f5e6af6fd0b86e4) | merged only canonical `krebs/adapters/tp/plane.sh`; unrelated dirty root gitlinks not staged or pinned |
| PJangler | [31d1b5d3f42d486a37a1f46533e40816c84cb426](https://github.com/delorenj/pjangler/commit/31d1b5d3f42d486a37a1f46533e40816c84cb426) | merged regression suite and original handback after concurrent PJAN-105 main advance; this evidence addendum follows |

Post-integration focused execution against landed source: template pytest **5 passed**
(canonical Krebs adapter mirror); PJangler normal runner **3/3 passed**, typecheck
and build OK with `PJ_TICKET_PROVIDER_ADAPTERS` set to canonical 33GOD main;
Flume normal runner **4/4 passed**, typecheck and build OK. Flume's registered
suite includes real Copier-generated consumer, regeneration and actual
`hermes.pm-scaffold` post-migration audit. Initially the Flume suite failed
because its shared nested template checkout still held the old detached gitlink
`3b9b7e8` despite the new committed pin; fetching and detaching **that checkout
only** at the exact main-pinned `af82ef1` made the same focused run pass. This
was a checkout materialization mismatch, not a code repair. No full PJangler
suite or clean `check:hermetic-test-env` is claimed: the pre-existing
`PJAN75_CLI_BUILT` hermetic-env finding remains out of scope.
