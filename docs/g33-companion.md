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

Existing enabled g33 projects currently refuse BMAD scaffold repairs and
version updates **before** upstream installation or retired-state eviction.
The owner has not supplied a supported pre-update preservation handoff; the
v1 seam cannot protect native BMAD overrides or mappings from an upstream
rewrite. `pj migrate bmad.version` (including preview) reports `blocked` and
exits nonzero, preserving installed bytes. A retained g33 tree or module
declaration in YAML or `[modules.g33]` in `_bmad/config.toml` also triggers
this protection after opt-out. TOML evidence remains protective when YAML
selects modules without g33. A converged recipe
still observes/plans without reinstalling BMAD. Fresh required BMAD installs
remain available even when the optional owner is unavailable.

Once the owner contract is provided, update orchestration must capture/protect
native bytes and mappings before the updater, restore/reconcile afterwards,
and verify preservation or retain recoverable evidence on any failure. No
configuration flag or metadata-only claim bypasses this pending boundary.
PJangler does not copy module content or fabricate skills from a reference-only
pack.

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
At implementation time the owner result/API was unavailable. No default
package export or canonical g33 source is selected. Real owner integration
still requires its public entrypoint, immutable artifact, preservation contract,
the pre-update capture/protection/recovery handoff, and a fixture using that
actual installer. Current forced-update tests prove safe refusal and retained
native bytes, not successful owner-supported updating. The runnable
`node tests/pjan-167-g33-companion.mjs` fixture proves PJangler
orchestration only; it cannot certify the owner package.
`node tests/pjan-167-enrollment.mjs` covers the actual ProjectRecipe
topology using filesystem-only external boundaries. Set `TMPDIR` to a scratch directory outside Git repositories for the callable
CLI suite: Skillex receipts reject any Git ancestor, including a Git-managed
operator config directory. The enrollment runner also supports the environment TMPDIR. Production enrollment, owner integration, and pre-update preservation
acceptance remain pending.
