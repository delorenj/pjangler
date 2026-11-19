# PJAN-75 — fail-closed agent declaration migration

## Scope and behavior

- `sot.project-json` treats a missing or identity-incomplete `role.yaml` as unprovisioned, including an empty file. Discovery does not manufacture a `${project_id}-${role}` agent ID from such a file.
- A declared non-default agent ID and every provisioning extra survive a selected migration even when unrelated `repo_path` drift requires a real `.project.json` write. The selected rule remains unresolved and exits nonzero, with a provision/restore instruction. A second migration makes no further manifest write.
- Legacy skill mapping still requires operator consent; selected migrate does not move or delete the committed skill or change its manifest, and returns nonzero with an actionable command. `--all` reports nonfixable findings. Dry-run without `mise.toml` plans the permitted repair without writes.

## Verification

- Red before fix: the newly added selected empty-`role.yaml` regression failed against the original source (missing actionable preserved-agent detail); the missing-file variant passed.
- `node tests/pjan-75-regressions.mjs` — passed (source bundle, nine checks).
- `npm run typecheck` — passed.
- `npm run build` — passed; `dist/` is generated/untracked by policy, not committed.
- `PJAN75_CLI_BUILT="$PWD/dist/index.js" node tests/pjan-75-regressions.mjs` — passed (rebuilt CLI, nine checks).
- `node tests/project-json-home-repo-path-regressions.mjs`, `node tests/pjan-17-canonical-binding-regressions.mjs`, `node tests/pjan-17-provider-parity-regressions.mjs`, `node tests/pjan-36-regressions.mjs`, `node tests/pjan-65-regressions.mjs`, `node tests/momo-lifecycle-plane-regressions.mjs` — passed.
- `git diff --check` — passed.

Independent SPEC and QUALITY reviews are pending; no main integration or board changes in this delivery.
