# Input Reconciliation — `docs/project-overview.md`

## Input role and freshness

The overview is a generated July 2026 navigation artifact. It establishes current product shape but explicitly points deeper work to architecture and code.

## Extracted evidence and coverage

- PJangler bootstraps projects, keeps parity, provisions agents, and scaffolds subsystems. Project Notebook is framed as another lifecycle-owned module, not a separate product.
- CLI aliases are `pjangler` and `pj`; the PRD uses `pj notebook` consistently.
- Central state is the Project Registry; repository state includes the Project Manifest. Both are defined in the Glossary and FR-3.
- Bootstrap, audit/migrate, recipes, and agent-native operations share plan/apply and idempotency. Covered across FR-2, FR-4, FR-15 through FR-17, and NFR-8/NFR-9.
- The package is a TypeScript monolith with thin CLI/MCP interfaces over shared core. Preserved in NFR-8 and addendum §1.

## Gaps or conflicts

- The overview predates Project Notebook and contains no notebook state model or hook contract.
- Its version and rule count are not used as acceptance criteria.

## Verdict

Reconciled. The new feature extends existing lifecycle grammar without copying stale inventory data.

