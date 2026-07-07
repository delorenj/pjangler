The new project registry flow can leave `.project.json` out of sync with the registry and can erase existing agent records when adding another role. These are functional data-consistency regressions that should be fixed before the patch is considered correct.

Full review comments:

- [P2] Update existing manifests during sync — /home/delorenj/code/pjangler/src/index.ts:189-189
  When syncing a repo that already has `.project.json`, this returns false solely because the file exists, so `project.write-manifest` is not selected even if the planned name, description, slug, identifier, or agents differ. The audit path only verifies shape/presence for many of those fields, so `pjangler project init --apply --yes --description ... --identifier ...` can update the central registry while leaving the repo-local projection stale.

- [P2] Merge new agents into existing registry entries — /home/delorenj/code/pjangler/src/project/index.ts:291-298
  When `--provision-agent` is used for an already registered project, this branch replaces `existing?.agents` with a one-entry map for the requested role. Running project init later to add a `review` or `dev` agent would drop the existing `pm` agent from the registry and generated manifest instead of preserving it.
