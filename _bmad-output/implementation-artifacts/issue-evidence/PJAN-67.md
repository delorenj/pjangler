# Evidence: PJAN-67 — Make MCP mutation fail closed and non-interactive

## Issue
- Ticket: PJAN-67
- Milestone / horizon: adversarial MCP remediation workstream 2 of 5
- Worker: pjan67-implementation-owner (delegated Codex worker)
- Orchestrated by: momo

## Acceptance Criteria
1. Generic recipe execution requires an explicit target and is preview-only unless `apply=true`.
2. Interactive recipes are unavailable through the generic endpoint; Hermes runs only through its dedicated non-interactive tool.
3. Every MCP Hermes path forces quiet mode and captures child output; a raw stdio framing test proves stdout contains only JSON-RPC frames.
4. Hermes deployment defaults to preview; local mutation requires `apply=true`, and external effects additionally require `live=true` plus explicit positive opt-ins; `local=false` alone arms nothing.
5. `skipPlane=true` disables the project board action even when `live=true`, with no provider invocation.
6. Consent and lifecycle failures return `isError=true` before filesystem, provider, systemd, or subprocess effects.

## Repo Changes
- Branch: `fix/PJAN-67-mcp-fail-closed`
- Base: `90529d2ea750640b0038b4033563a2dca964a0bf`
- Implementation head: `dd6f8815693d99b2d7067b2cc07877b56d9ee8d7`
- Pjangler implementation commits: `9cba7dc3776959b68c9c8232f4431c3f914df031`, `dd6f8815693d99b2d7067b2cc07877b56d9ee8d7`.
- Hermes template commit: `5df96f30e1557fece5772a30a6fca33e03872db9`, published on the template feature branch and `origin/main`.
- Concurrent ancestry disclosure: `9365625d0faa516de44ef33cd60e63491de7c9ea` tracks skill sources and is not PJAN-67 implementation. It captured the already-published Hermes gitlink while another agent committed on the shared branch; all PJAN-67 source and tests are isolated in the two implementation commits above.
- `src/mcp-server.ts` — strict explicit apply/live/effect consent, dedicated non-interactive Hermes surface, Copier/template/lifecycle preflight, failed-lifecycle MCP errors, safe target-repository identity, and project pre-effect gates.
- `src/lifecycle/preflight.ts` — no-exec Copier provenance, vendored-template attestation, rendered-role structural eligibility, and containment checks.
- `src/commands/hermes/ApplyDeferredHostEffects.ts`, `ApplyDeferredExternalEffects.ts`, `EnsureTemplateConfig.ts`, `RunCopierTemplate.ts`, `types.ts` — repo-local render first, host and external tails after eligibility, credential scrubbing, explicit project-root containment, and final deployment metadata.
- `src/recipes/HermesAgentRecipe.ts`, `ProjectRecipe.ts` — eligibility-before-effect sequencing and exactly-once project/Hermes external tails.
- `templates/hermes-agent` — pinned to `5df96f3`; the template enforces early `SKIP_PLANE`/`SKIP_HOST_STATE`, contained project-root resolution, and quoted YAML identity scalars.
- `tests/pjan-67-regressions.mjs`, `pjan-67-lifecycle-preflight-regressions.*`, `pjan-67-trusted-lifecycle-regressions.mjs` — protocol, provenance, real-template, raw-stdio, zero-effect, positive create/sync, containment, and exactly-once coverage.
- `package.json`, `dist/index.js`, `dist/mcp-server.js` — full-chain registration and regenerated runtime bundles.
- Migrations / schema: none.

## Verification
- Initial mutation proof: the PJAN-67 discovery assertion failed against the base revision before implementation.
- First independent SPEC review: `/root/pjan67_spec_review`; AC 1–3 passed and AC 4–6 failed. It reproduced the real template ignoring `SKIP_PLANE` and three lifecycle failures occurring after target, config, Copier, or provider effects.
- Remediation proof: the exact project-init, bootstrap, and dedicated-Hermes reviewer fixtures now return `isError=true` before target/config/registry/Copier/provider/systemd effects.
- Existing malformed Hermes lifecycle state is rejected before a new role render, host config change, fleet-registry write, child process, or provider call.
- Real-template `SKIP_PLANE` tests prove two no-authority paths make zero provider calls and one positively granted path calls the provider once.
- Trusted-Copier integration proves CommonProject create, existing-project sync without a Copier rerun, dedicated Hermes all-grants, and project-owned all-grants.
- Dedicated and project-owned live tails dispatch each selected external script once, invoke board creation once, run only after eligibility, and persist correct deployment metadata.
- A disposable enclosing Git-repo sentinel proves fresh-target scripts cannot climb into and mutate a parent checkout manifest.
- Raw newline-framed stdio uses the attested installed Copier and real vendored template; child stdout/stderr remain captured, MCP stdout contains JSON-RPC frames only, and provider credentials are absent from ungranted child environments.
- `pytest -q` in `templates/hermes-agent` — 83 passed.
- `npm run typecheck` — passed.
- `npm run build` and generated-bundle parity — passed.
- `node tests/pjan-67-lifecycle-preflight-regressions.mjs` — passed.
- `node tests/pjan-67-regressions.mjs` — passed.
- `node tests/pjan-67-trusted-lifecycle-regressions.mjs` — passed with the installed UV Copier.
- MCP catalog/server, project-registry, fleet-shared Bloodbank, PJAN-57 lifecycle/generated-project, PJAN-71, and Momo lifecycle focused regressions — passed.
- `npm test` full chain — exited 0 on the final implementation tree.
- `npm run check:lock`, `npm run check:tracked-secrets`, and `npm run check:submodules -- --remote --recursive --archive --npm` — passed.
- `git diff --check` — passed in parent and template repositories.
- Parent and template feature refs are synchronized with their remotes; template `origin/main` is also `5df96f3`.
- Hand-back status is `DONE` and schema validation is `VALID` at `dd6f881`.
- `_bmad-output/implementation-artifacts/diffs/PJAN-67.diff` matches `90529d2..dd6f881` with SHA-256 `048fc6c212fee5412ac29d1f437dc6892222931b8b6e79e215400a398e4a3f7d`.

## Ledger Update
- Bloodbank decision/event emitted: `2aa5c170-2e71-47b3-b15b-2544506aa43c`.
- Ledger updated: yes

## Known Gaps
- A fresh independent SPEC review and independent quality review are required before acceptance; the first SPEC review's findings are implemented and covered by regressions.

## Close Recommendation
- Close recommendation: hold
- Rationale: implementation and verification are complete at the pushed head; Momo is launching a new independent SPEC reviewer against the remediated range.
