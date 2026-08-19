# Input Reconciliation — `docs/index.md`

## Input role and freshness

The index is the July 2026 brownfield documentation entry point. It routes feature work to current architecture and code; version and component counts are snapshot data, not requirements.

## Extracted evidence and coverage

- PJangler is a Node 20+ TypeScript/ESM package with CLI and MCP interfaces. Covered by NFR-8 and addendum §1.
- The architecture is layered around command/recipe composition, the Project Registry/bootstrap system, and parity. Covered by Vision, FR-2, FR-15 through FR-17, and addendum §1.
- Central state is `~/.config/pjangler/projects.yaml`. Covered by Glossary, FR-3, and Constraints §10.
- PJangler uses plan/apply and idempotent reconciliation. Covered by FR-2, FR-4, FR-16, FR-17, NFR-1, and NFR-9.
- Current CLI and MCP share a core. The PRD keeps the module reusable but explicitly defers new MCP tools in MVP.

## Gaps or conflicts

- The index contains no notebook requirements. The supplied request and PJAN-77 are the change signal.
- Its package version and inventory counts may be stale; none are copied into the PRD.

## Verdict

Reconciled. Brownfield shape is preserved without treating snapshot counts as a contract.

