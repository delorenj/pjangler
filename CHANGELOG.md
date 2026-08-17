# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `feat(PJAN-65)`: implement `pjangler describe`, replacing the "coming soon" placeholder with a real report of detected project type, installed subsystems, config files present, and next steps. Subsystem presence is derived from marker files and kept separate from recipe parity, so a subsystem that was never installed reads `absent` instead of `broken`. Fixable parity drift collapses into the single `migrate --all` step that covers exactly that set; manual-only findings stay itemized. `.project.json` wins over the central registry for the board binding, and any disagreement is reported as drift. Adds `--json`, an optional repo argument, and the `pjangler_describe_project` MCP tool.
- `feat(PJAN-57)`: add recipe-owned lifecycle modules and a single validated `RecipeRegistry` with duplicate, dependency, cycle, ordering, init, audit, and migration dispatch coverage.
- `test(PJAN-57)`: add dogfood env/TOML tests and a packed-CLI generated-project lifecycle test covering real Copier rendering, all six supported CLI roots, Git initialization, clean immediate audit, and idempotent re-init/migration.

### Changed

- `fix(PJAN-58)`: advance the Hermes agent template and checked-in PM profile so the Plane adapter reads only the workspace-scoped credential from shared fleet dotenv data instead of sourcing and executing the whole file.
- `refactor(PJAN-57)`: route CLI and MCP project operations through one `ProjectRecipe` transaction that composes dependencies, closes fresh output, performs the final audit, initializes and commits Git exactly once, then persists the central registry.
- `refactor(PJAN-57)`: make `MiseOpInjectRecipe` the sole owner of `.env.op` materialization through an atomic, collision-resistant managed script; a nonempty comment-only template is the intentional no-secrets opt-out.
- `refactor(PJAN-57)`: generate exactly Claude, Codex, Gemini, Copilot, OpenCode, and Kimi configuration roots from one supported-CLI matrix, with manifest-backed provenance for legacy cleanup.
- `chore(PJAN-57)`: reduce the CommonProject runtime template to deliberate source inputs and remove generated BMAD snapshots from its history and package surface.

### Fixed

- `fix(PJAN-57)`: preserve foreign mise hook records, comments, additional TOML keys, leave hooks, and non-owned env scripts while replacing only positively owned enter hooks.
- `fix(PJAN-57)`: restore fatal/cancel short-circuiting for Hermes lifecycle init and derive changed-file reports from observed filesystem changes rather than display glyphs.
- `fix(PJAN-57)`: pin fresh initialization to verified `bmad-method@6.11.1-next.1`, model its multi-module project-name behavior hermetically, and gate publication on the real package contract.

## [1.2.27] - 2026-08-09

### Added

- `feat(PJAN-18)`: enforce fleet-shared Bloodbank gateway contract in registry parity.
- `feat(PJAN-37)`: generalize skill pack provisioning with flattened pack inventory (section 3b) and hardened skill-name validation before fanout containment.
- `feat(mise)`: add `projects:backfill` / `projects:register` mise task to bulk-register existing git repos as formal pjangler projects (PR #1).
- New regression tests for pack-flatten and cross-engine pack-flatten behavior.

### Changed

- Updated `templates/commonproject` submodule pointer to `41f72c1`, incorporating PJAN-37 pack-flatten fixes in generated projects.

### Fixed

- `fix(PJAN-37)`: correct pack-layout docblock and harden skill fanout validation.
