# PJAN-75 — fail-closed agent declaration migration

## Scope and behavior

- `sot.project-json` treats a missing or identity-incomplete `role.yaml` as unprovisioned, including an empty file. Discovery does not manufacture a `${project_id}-${role}` agent ID from such a file.
- A declared non-default agent ID and every provisioning extra survive a selected migration even when unrelated `repo_path` drift requires a real `.project.json` write. The selected rule remains unresolved and exits nonzero, with a provision/restore instruction. A second migration makes no further manifest write.
- Legacy skill mapping still requires operator consent; selected migrate does not move or delete the committed skill or change its manifest, and returns nonzero with an actionable command. `--all` reports nonfixable findings. Dry-run without `mise.toml` plans the permitted repair without writes.

## Verification

- Red before fix: the newly added selected empty-`role.yaml` regression failed against the original source (missing actionable preserved-agent detail); the missing-file variant passed.
- `node tests/pjan-75-regressions.mjs` — passed (source bundle, nine original checks).
- `npm run typecheck` — passed.
- `npm run build` — passed; `dist/` is generated/untracked by policy, not committed.
- `PJAN75_CLI_BUILT="$PWD/dist/index.js" node tests/pjan-75-regressions.mjs` — passed (rebuilt CLI, nine original checks).
- `node tests/project-json-home-repo-path-regressions.mjs`, `node tests/pjan-17-canonical-binding-regressions.mjs`, `node tests/pjan-17-provider-parity-regressions.mjs`, `node tests/pjan-36-regressions.mjs`, `node tests/pjan-65-regressions.mjs`, `node tests/momo-lifecycle-plane-regressions.mjs` — passed.
- `git diff --check` — passed.

## Independent gates and quality repair

- Independent SPEC gate passed all nine original source and rebuilt-CLI checks on `a247f0202c33b64cb0a7732bbd85074f74bbc27f`.
- Independent QUALITY gate failed on that commit: the raw `yamlGet` regex considered `agent_id: null`, `agent_id: ~`, and `agent_id: # pending` usable identities, allowing a selected migration to delete the last declared agent and exit successfully. Equivalent invalid `role` scalars had the same flaw.
- New regressions reproduced the destructive successful migration for all six null/tilde/comment-only role/ID variants and proved inline-commented valid identities were mangled before the repair. An empty folded ID and quoted literal null are also covered.
- The repair parses only the two identity scalars with the already-installed `yaml` dependency. Discovery and declared-role validation both reject absent, non-string, or whitespace-only values; valid inline-comment values retain their identity. Unrelated `yamlGet` callers were not rewritten.
- `node tests/pjan-75-regressions.mjs` — passed (source bundle, 18 checks).
- `PJAN75_CLI_BUILT="$PWD/dist/index.js" node tests/pjan-75-regressions.mjs` — passed (rebuilt CLI, 18 checks).
- `npm run typecheck && npm run build` — passed.
- The six affected suites listed above — passed.

## Independent re-review — accepted candidate

- Independent reviewer examined the complete PJAN-75 diff and current source at candidate commit `391a66d3c71b2cd291d672396e3d78dcc8653642` (`PJAN-75-identity-preservation`): **SPEC PASS; QUALITY PASS; no findings**. The reviewer reran `node tests/pjan-75-regressions.mjs` and `PJAN75_CLI_BUILT="$PWD/dist/index.js" node tests/pjan-75-regressions.mjs`, with all 18 checks passing in each mode after a fresh build. `npm run typecheck` and `npm run build` passed; the six neighboring regression suites listed above passed.
- Negative control: running the current suite against initial candidate `a247f0202c33b64cb0a7732bbd85074f74bbc27f` failed eight identity checks. Null, tilde, comment-only, and empty-folded identities were mishandled, and valid inline-comment identities were mangled there; they pass at the reviewed commit. The reviewer confirmed real selected `repo_path` writes preserve the non-default agent declaration and provisioning metadata, while unresolved identities return an actionable nonzero outcome rather than deleting that declaration.
- Review coverage also checked the legacy skill-consent and dry-run migration cases and the six adjacent suites: `tests/project-json-home-repo-path-regressions.mjs`, `tests/pjan-17-canonical-binding-regressions.mjs`, `tests/pjan-17-provider-parity-regressions.mjs`, `tests/pjan-36-regressions.mjs`, `tests/pjan-65-regressions.mjs`, `tests/momo-lifecycle-plane-regressions.mjs`.
- Candidate commits: [`a247f0202c33b64cb0a7732bbd85074f74bbc27f`](https://github.com/delorenj/pjangler/commit/a247f0202c33b64cb0a7732bbd85074f74bbc27f) and [`391a66d3c71b2cd291d672396e3d78dcc8653642`](https://github.com/delorenj/pjangler/commit/391a66d3c71b2cd291d672396e3d78dcc8653642); source and tests are `src/parity/rules.ts` and `tests/pjan-75-regressions.mjs`. The evidence above records the independent result without depending on a transient reviewer log.
