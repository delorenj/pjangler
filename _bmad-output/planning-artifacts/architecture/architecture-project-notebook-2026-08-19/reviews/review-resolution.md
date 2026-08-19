# Reviewer Finding Resolution

This disposition reconciles the three independent draft-spine reviews. “Resolved” means the architecture rule is now explicit and reviewable; it is not implementation or production proof.

| Finding | Disposition | Binding added or corrected |
| --- | --- | --- |
| RW-1 durable ambiguous-create owner | Resolved | AD-6 and `Session baseline, receipt, and worker state` define XDG `RemoteMutationJournalV1`, its crash-safe transitions, operation fields, retention, reconcile-only behavior, and commit points for notebook and note creates. |
| RW-2 create/sync seam and rollback guard | Resolved | AD-2 names `runNotebookLifecycle` for create and sync without running other create-only dependencies. AD-3 and `Apply transaction and recovery` bind the unified external plan, `externalDispatchStarted`, Registry finalizer, and failure-point tests. |
| RW-3 Overview seed and Drift | Resolved | `Overview seed and Drift proof` defines `OverviewDescriptorV1`, required identity/purpose/references/digests, SessionStart comparison/warning, audit, in-place migration, and fixtures. |
| RW-4 baseline independent of Overview policy | Resolved | AD-15 and the SessionStart policy matrix require baseline when either priming or capture is enabled, gate only remote Overview on start policy, preserve first baseline on resume, and block on incomplete evidence. |
| RW-5 public user-note identity | Resolved | AD-9 and `Note model and local search` add `user-note`, UUID operation identity in the mutation journal, distinct intentional identical adds, unresolved retry reuse, and marker preservation/unmanaged behavior. |
| CT-1 one Registry-last external tail | Resolved | AD-3 and the transaction sequence define fixed-order `ProjectExternalEffectPlan`, withhold all Registry actions, stop on first failed effect, candidate audit, safe Manifest outcome, and one Registry-only finalizer even for unsuccessful commands. |
| CT-2 post-dispatch target deletion | Resolved | AD-3 and the failure table prohibit the existing recursive fresh-target rollback after the dispatch latch; recovery Manifest, journal, and Registry state survive every post-dispatch failure. |
| CT-3 packed Skillex bridge | Resolved | AD-23 and the component/topology/rollout sections define the digest-verified `dist` export, runtime precedence, XDG data installation, foreign-path conflict, package inclusion, and isolated tarball test without developer checkout. |
| CT-4 `/api/config` auth claim | Resolved | `Open Notebook v1.14 adapter boundary` now separates config health/version from the deployment auth-status response and normalizes actual 401/403 independently. |
| CT-5 Bloodbank byte claim | Resolved | Hook topology now asserts parsed foreign-object equality and relative order on a changing first sync; zero-byte equality is required only on the second identical sync. |
| Adversarial 1 external commit/journal ordering | Resolved | AD-3/AD-6 and the sequence place candidate postcondition audit before linked Manifest, Registry last, and journal commit after durable identity; earlier failure remains planned with durable possibly-dispatched evidence. |
| Adversarial 2 note/session identities | Resolved | `user-note` is canonical; AD-15/AD-17 bind one exact session-key formula for baseline, claim, receipt, and capture; baseline is exclusive and never overwritten; missing session ID fails open/blocks close. |
| Adversarial 3 lossless config/hook representation | Resolved | Registry contract binds complete notebook subtrees, exact-level extension JSONB, owned-path overlay, YAML CST preservation, PG semantic equality, and anchored canonical hook commands shared by all fixtures. |
| Adversarial 4 JSON/search/error precedence | Resolved | `JSON v1 and exit mapping` defines binding versus health, per-command data schemas, failure shape/precedence; local search fixes normalization, tokenization, AND semantics, score, excerpt, ordering, and incomplete-list errors. |

## Final architecture gate

- Unresolved blocker/critical/high/major findings: **0**
- Deferred review findings: **0**
- Three original reviews remain preserved as draft evidence.
- Mechanical lint and final reviewer rechecks are recorded separately after this disposition.
