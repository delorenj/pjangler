# Input Reconciliation — `docs/architecture.md`

## Input role and freshness

The architecture document is a July 2026 navigation aid with lifecycle updates through 2026-08-11. It says live code is authoritative.

## Extracted evidence and coverage

- Thin CLI and MCP adapters dispatch through one singleton Recipe Registry. Required by NFR-8, Constraints §10, and addendum §1.
- A subsystem owns a Recipe, checks, migrations, truthful dependencies, and one catalog registration. Required by FR-2, FR-15 through FR-17, and addendum §1.
- Project init is a plan/apply transaction, dry-run by default, with final audit and Project Registry persistence last. Required by FR-2, FR-17, and Constraints §10.
- Network/cloud work is already Live Action-gated and can remain planned when unavailable. Used to resolve notebook provisioning behavior in FR-2.
- Project Record and Project Manifest are typed projections. Required by FR-3, including every supported registry backend.
- Existing hook-layer logic avoids rewriting shared global client configuration and preserves foreign records. Required by FR-10 and Constraints §10.
- Audit uses pass/fail/warn/skip; migrate uses selected owned checks and idempotent outcomes. Required by FR-15 through FR-17.
- Regression strategy uses built/packed CLI, isolated home/registry, real lifecycle, and idempotency. Extended in NFR-10 and addendum §9.

## Gaps or conflicts

- The document describes PJangler as stateless outside its Project Registry. The PRD makes Notebook Service content explicitly external and limits PJangler ownership to binding/configuration and state receipts.
- Existing dual-interface symmetry suggests MCP parity, but the user requested CLI and hooks. The PRD explicitly defers new MCP tools while requiring a reusable module.
- Global hook install and project-scoped behavior appear in tension. FR-10 resolves this as canonical global fanout assets that scope themselves at runtime by repository.

## Verdict

Reconciled. No new second execution path or implicit migrate-all is introduced.

