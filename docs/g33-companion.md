# Optional g33 companion

`pj recipe run bmad` installs or repairs BMAD and then reconciles an optional
g33 companion through its owner's callable adapter. `pj add bmad` uses the same
recipe. Repeat runs observe and plan again; a converged owner plan applies
nothing. `--force` retains its existing recipe meaning and does not force a
companion overwrite. Fresh `pj init` reconciles automatic eligibility after
provider linking and before the final Registry mutation. Only read-only audits
follow that finalizer. Optional failures retain partial-write evidence and do
not fail required fresh initialization. An owner already attempted through an
explicit opt-in is not retried in the enrollment phase.

Existing enabled g33 projects execute a transactional pre-update preflight and
capture/restore/reconcile handoff during BMAD scaffold repairs (`bmad.scaffold`)
and version updates (`bmad.version`):

1. **Boundary and preflight**: Before retired-state eviction or upstream
   `bmad-method install` runs, PJangler checks for retained `g33` state after
   opt-out (`bmad.companion.enabled: false`), verifies that an enabled project
   has a configured adapter, and runs a read-only companion preflight (`observe`
   + `plan`). If the project opted out while retaining `_bmad/g33`,
   `_bmad/_config/g33-mapping.json`, `- name: g33` in `manifest.yaml`,
   `[modules.g33]` in `_bmad/config.toml` or `_bmad/custom/config.toml`, or a
   top-level `g33:` section in `_bmad/config.yaml`, or if no adapter is
   configured, or if preflight reports `unavailable`, `conflict`, or `error`,
   the update refuses **before** any retired-state eviction or upstream
   installer execution.
2. **Pre-update capture**: PJangler snapshots the full repository tree (bytes,
   modes, and symlinks) and records protected operator/companion surfaces:
   `_bmad/custom/**`, `_bmad/scripts/**`, `_bmad/g33/**`, `_bmad/config.yaml`,
   retained `g33` module declarations (`manifest.yaml` / `config.toml`), and
   operator-customized native BMAD skill files, extra files, modes, and symlinks
   under `.agents/skills/bmad-*/**`.
3. **Upstream install, restore, and companion reconciliation**: After running
   retired-pack symlink eviction and `bmad-method install`, PJangler restores
   the protected operator customizations, `_bmad/custom/**`, missing
   `_bmad/scripts/**`, `_bmad/g33/**`, `_bmad/config.yaml`, and retained `g33`
   declarations, then invokes the configured `g33` companion (`observe` / `plan`
   / `apply` / post-`apply` `observe`) to re-merge companion surfaces (such as
   `_bmad/_config/bmad-help.csv` or mapping files).
4. **Post-update verification and full rollback on failure**: PJangler verifies
   that the companion converged with non-empty `installed` observation evidence
   and that all operator-protected files and symlinks match their exact
   pre-update bytes, modes, and link targets. If the upstream installer,
   companion apply/observation, or preservation verification fails, PJangler
   rolls back the entire target tree to its pre-update backup and reports
   `blocked` with `changedFiles: []`.

A converged recipe still observes/plans without reinstalling BMAD. Fresh
required BMAD installs remain available even when the optional owner is
unavailable. PJangler does not copy module content or fabricate skills from a
reference-only pack.

The default is enabled only when the target `.project.json` has a valid
`project_id` and a linked Plane binding with workspace `33god` and a board ID.
Path names and execution mode do not enroll projects. Other projects default
off. Set `bmad.companion.enabled` to `true` to opt in, or `false` to opt out;
`false` wins over automatic eligibility and host adapter selection. Opt-out
preserves any previously installed content.

```json
{
  "bmad": {
    "companion": {
      "enabled": true,
      "adapter": {
        "module": "./integrations/g33-owner-adapter.mjs",
        "exportName": "reconcileCompanion",
        "options": {}
      }
    }
  }
}
```

`module` selects an existing source file relative to the target project, an
absolute local artifact, or an installed package/subpath. Packages resolve
from the project first, then from PJangler, using Node ESM import conditions.
Both resolution errors are retained when neither location resolves. `exportName` is required; PJangler
does not guess exports or provision packages. `PJ_G33_ADAPTER_MODULE` and
`PJ_G33_ADAPTER_EXPORT` supply portable host defaults for enabled projects.
`options` passes owner-specific source/version selection through unchanged.
Present `bmad`, `companion`, `adapter`, and `options` containers must be JSON
objects; false, null, strings, and arrays are errors before any owner import.
Absent optional containers remain valid.
Use the owner-provided adapter or a wrapper around its documented public API.

```sh
pj recipe run bmad --dry-run --json
pj recipe run bmad --json
pj audit --rules bmad.g33-companion --json
pj migrate bmad.g33-companion --dry-run --json
pj migrate bmad.g33-companion --json
```

Recipe JSON includes `bmadCompanion`, separate from required BMAD success.
Missing configuration/source and owner conflicts/errors remain actionable
optional outcomes. They do not fail required fresh BMAD initialization or its
preflight. Audit reports these as warnings. An explicit companion repair that
cannot establish installation reports `partial` and exits nonzero. No result
claims installation from enrollment metadata or a mutation reply alone.

## Callable boundary v1

The configured export accepts `CompanionRequest` from
`src/bmad/companion.ts`: `schemaVersion: 1`, `moduleId: "g33"`, `projectRoot`,
`operation`, `reason`, and `options`. It returns a `CompanionReply` containing
`schemaVersion: 1`, `status`, `summary`, `details: string[]`, and
`evidence: string[]`.

| Operation | Supported status | Owner obligation |
| --- | --- | --- |
| `observe` | `installed`, `missing`, `unavailable`, `conflict`, `error` | Read only; inspect actual content and mappings. `installed` needs nonempty content/mapping evidence. |
| `plan` | `planned`, `unchanged`, `unavailable`, `conflict`, `error` | Read only; `unchanged` requires an installed observation. |
| `apply` | `changed`, `unchanged`, `unavailable`, `conflict`, `error` | Convergent installation/repair/update; preserve protected BMAD, customizations, and foreign mappings. |

Preview invokes observation and planning without application. PJangler checks
target snapshots for read-only violations and reports them, without attempting
to undo an owner violation. Adapters are trusted local code and must also avoid
external writes during import/observation/planning. After application, PJangler
observes again and accepts success only when the owner proves installation.
Changed paths come from actual target byte/mode/link snapshots, including
dangling symlinks, target root permissions, import/plan violations, and
partial writes on an owner error. PJangler never changes YAML/TOML formats.

The manual installer CLI remains owned by Skillex/the module. This callable
boundary is a PJangler extension protocol, **not a claim about Skillex exports**.
The runnable `node tests/pjan-167-g33-companion.mjs` fixture proves PJangler
orchestration, pre-update preflight, preservation handoff, and failure rollback.
`node tests/pjan-167-enrollment.mjs` covers the actual ProjectRecipe
topology using filesystem-only external boundaries. Set `TMPDIR` to a scratch directory outside Git repositories for the callable
CLI suite: Skillex receipts reject any Git ancestor, including a Git-managed
operator config directory. The enrollment runner also supports the environment TMPDIR.
