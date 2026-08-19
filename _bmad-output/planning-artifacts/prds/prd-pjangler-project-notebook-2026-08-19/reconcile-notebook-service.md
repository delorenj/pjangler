# Input Reconciliation — Live Notebook Service Reconnaissance

## Input role and freshness

Read-only live reconnaissance verified the deployed Open Notebook service on 2026-08-19. These facts may drift and are treated as adapter assumptions, not permanent product identity.

## Extracted evidence and coverage

- Deployment reports Open Notebook v1.14.0 and healthy service state. Recorded only in FR-18 context and addendum §6.
- Notes CRUD exists. This supports FR-7 but contract tests, not the version string, gate compatibility.
- Password authentication is currently disabled. FR-18 supports runtime auth modes rather than assuming a password.
- The loopback host API is automation-reachable; the public hostname is protected by interactive identity middleware. FR-18 forbids a built-in interactive-only default and hardcoded LAN address.
- Search is global and lacks a notebook filter. FR-8 and FR-20 require ownership validation before results are returned.
- Overview has no first-class Notebook Service object. FR-6/FR-11 resolve it as a stable designated Overview Note.
- The upstream service exposes no caller-controlled external idempotency contract for create. FR-4 and addendum §6 require deterministic reconciliation before retry.
- An existing standalone distribution script lacks the complete auth, source/search, and idempotency contract. The PRD requires one shared Project Notebook Module instead of blessing that script as core.

## Gaps or conflicts

- Exact endpoint payloads are intentionally absent from the PRD and belong in adapter contract fixtures after implementation validates the deployed API.
- The currently disabled password does not remove secret-handling requirements because other deployments or future configuration may enable authentication.

## Verdict

Reconciled. Current service limitations are converted into isolation, configuration, and adapter requirements without pinning product behavior to one deployment snapshot.

