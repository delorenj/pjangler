---
title: 'PJAN-68 accurate MCP discovery and result contracts'
type: 'bugfix'
created: '2026-11-18'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: '5b16d1de0b566593b505baab6e47ad460d0aa8b5'
context: []
---
<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
## Intent
**Problem:** MCP clients cannot reliably plan against the current tool catalog: tool annotations and output schemas are absent/incomplete, and successful results are text-only. Some lifecycle failures look like successes.
**Approach:** Describe actual handler effects with explicit hints and per-tool object schemas, return the same structured payload alongside readable text, and flag failed lifecycle reports while retaining diagnostics.
## Boundaries & Constraints
**Always:** Cover every currently exposed tool, including optional apply/live effects and remote registry reads. Preserve the existing authorization, preview default, error and stdio behavior. Use isolated temp fixtures for protocol tests; no provider invocation.
**Ask First:** New tools, semantics beyond result/discovery contracts, or real provider provisioning.
**Never:** Change pagination/deadlines/cancellation, publish/install/deploy, re-enable Hermes provisioning, or touch the main checkout/board.
## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Discovery | tools/list | Four explicit boolean annotations and object outputSchema on every current tool | No missing tool |
| Read success | capabilities, parity, audit, registry, info, describe | Schema-valid structuredContent and readable text | Existing rejection unchanged |
| Preview | init/bootstrap/migration/recipe default preview | Schema-valid structuredContent preserves plan/report | No effect solely because of discovery |
| Apply | isolated recipe/migration/project fixture | StructuredContent preserves result and phase details | ok=false or success=false => isError=true |
| Format | json=false audit/describe | StructuredContent identical to JSON mode; text formatted | Invalid arguments still errors |
| Partial failure | lifecycle report with partial files/outcomes | isError=true and diagnostics/outcomes retained in structuredContent | Exceptions remain errors |
</frozen-after-approval>
## Code Map
- `src/mcp-server.ts:140` — asText only emits text; `:337-784` registers current 12 tools; `:421`, `:531`, `:631`, `:764` lifecycle reporting. `runAudit` may have `ok:false`; audit is a diagnostic read, not a lifecycle mutation failure.
- `src/parity/index.ts:76` — audit/migration dispatch; remote registry accesses via `src/project/index.ts:433` and `src/project/info.ts:45`; describe reads registry and repo.
- `tests/mcp-server-regressions.mjs:23-321` — SDK client, hermetic environment, existing consent/noninteractive/rejection tests; add protocol assertions there or a separate client test.
- `package.json:29-41`, `scripts/run-tests.mjs` — build and test registration.
## Tasks & Acceptance
**Execution:**
- [x] `src/mcp-server.ts` — add per-tool annotations and output schemas, central structured/text success rendering, preserve lifecycle failures and diagnostics.
- [x] `tests/mcp-server-regressions.mjs` — exercise tools/list and successful tools/call across catalog with fixture-safe preview/apply/json=false and failed lifecycle outcomes.
- [x] `_bmad-output/implementation-artifacts/issue-evidence/PJAN-68.md` — document reviewed per-tool hint rationale, evidence and boundaries.
**Acceptance Criteria:**
- Given tools/list, when a client discovers any tool, then all four hints are explicit booleans and outputSchema is present with rationale tied to handler behavior.
- Given a successful call in every supported shape, when the client validates structuredContent against advertised schema, then it passes and readable text remains.
- Given lifecycle ok=false or success=false, when the client calls the tool, then isError=true and diagnostics/outcomes survive, while successful runs are not errors.
- Given invalid params/consent/noninteractive inputs and stdio execution, when existing regression checks run, then their behavior remains unchanged.
## Spec Change Log
## Verification
**Commands:**
- `npm run typecheck && npm run build` — passed on the PJAN-68 worktree.
- `node tests/mcp-server-regressions.mjs && node tests/mcp-catalog-regressions.mjs && node tests/pjan-67-trusted-lifecycle-regressions.mjs && git diff --check` — passed, including client-advertised preview/execution variants, describe field rejection, and trusted create/sync apply.
- Earlier full-suite run encountered the unrelated published BMAD release lookup limitation; see `issue-evidence/PJAN-68.md`.
