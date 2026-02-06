---
title: 'Extract syncDocs into pjangler run command with git-derived docs destination'
slug: 'extract-syncdocs-pjangler-run-command-git-destination'
created: '2026-02-02T06:15:48-05:00'
status: 'Completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['TypeScript', 'Bun runtime', 'Commander CLI', 'Node fs/path APIs']
files_to_modify: ['src/index.ts', 'src/utils/registry.ts', 'src/commands/Command.ts', 'src/commands/SyncDocs.ts']
code_patterns: ['Class-based command pattern via Command.invoke()', 'Central command registry (COMMAND_REGISTRY)', 'Commander subcommand wiring in src/index.ts', 'CommandContext for shared flags (dryRun/force/targetDir)']
test_patterns: ['No dedicated automated test suite detected in repo', 'Manual CLI verification via bun/pjangler commands']
---

# Tech-Spec: Extract syncDocs into pjangler run command with git-derived docs destination

**Created:** 2026-02-02

## Overview

### Problem Statement

The current `syncDocs` behavior lives in `$ZC/helpers.zsh`, depends on a hardcoded `TTO` destination, and is not available as a reusable pjangler command.

### Solution

Implement a new pjangler command that ports the existing `syncDocs` behavior (`--since`, `--flat`, source `.`) while changing destination resolution to `/home/delorenj/code/DeLoDocs/Projects/$REPO_NAME/docs/$DATE`, where `$REPO_NAME` is derived from the nearest ancestor directory containing `.git`.

### Scope

**In Scope:**
- Create a new pjangler command class encapsulating `syncDocs` behavior.
- Add command wiring so it can be run via `pjangler run COMMAND [options] [flags]`.
- Preserve `--since` default (`24 hours ago`) and `--flat` semantics.
- Preserve source scan root as current directory (`.`).
- Implement fallback behavior when no `.git` ancestor is found (fallback to current directory name).

**Out of Scope:**
- Changes to markdown file selection logic besides preserving current behavior.
- Changes to copy mode behavior beyond current flat vs structure-preserving options.
- Broader CLI redesign outside adding the run path for custom commands.

## Context for Development

### Codebase Patterns

- `src/commands/Command.ts` defines a base abstract command with `invoke(): Promise<InvokeResult>` and shared file/directory helpers honoring `dryRun`.
- `src/utils/registry.ts` is the authoritative command registry and metadata source (`COMMAND_REGISTRY`) used by list/describe flows.
- `src/index.ts` wires CLI behavior with Commander; command execution paths are currently recipe-centric and command management-centric, so adding `run` is a new execution path.
- Existing shell behavior in `/home/delorenj/.config/zshyzsh/helpers.zsh` `syncDocs()` uses `find . -not -path '*/.git/*' -type f -name "*.md" -newermt "$since"` with two copy modes:
  - `--flat`: copy all files directly into destination root
  - default: preserve relative directory structure under destination

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `/home/delorenj/.config/zshyzsh/helpers.zsh` | Source-of-truth behavior for `syncDocs` options, filtering, and copy semantics. |
| `src/commands/Command.ts` | Base command abstraction and existing dry-run conventions. |
| `src/utils/registry.ts` | Register new command metadata and class import. |
| `src/index.ts` | Add runnable `pjangler run <command>` entrypoint and option parsing. |
| `src/recipes/Recipe.ts` | Reference execution/result handling style for command invocation loops. |
| `package.json` | Confirms Bun + Commander runtime model for CLI behavior. |

### Technical Decisions

- Destination root is fixed: `/home/delorenj/code/DeLoDocs/Projects`.
- Destination path format is exact: `/home/delorenj/code/DeLoDocs/Projects/$REPO_NAME/docs/$DATE`.
- `$REPO_NAME` resolution logic:
  - start from current working directory
  - walk upward to nearest directory containing `.git`
  - use that directory basename as repo name
  - if no `.git` ancestor exists, fallback to current directory basename
- Runtime option plumbing is explicit:
  - extend `CommandContext` with optional `args?: Record<string, unknown>`
  - `pjangler run` populates `context.args = { since, flat }`
  - `SyncDocs` reads and validates typed runtime args from `context.args`
- Runnable command naming is explicit and stable:
  - add registry resolver that maps user input to canonical runnable command IDs
  - canonical ID for this feature is `sync-docs`
  - support alias `syncDocs` for compatibility and ergonomics
- Time filtering strategy preserves current shell semantics:
  - `SyncDocs` shells out to `find ... -newermt <since>` (same behavior as current zsh function)
  - unsupported/invalid `--since` values fail fast with a clear error message
- Path safety and failure behavior are explicit:
  - preflight-check destination root existence and write access
  - create destination directory recursively only when not in `dryRun`
  - if destination creation or copy fails, return `InvokeResult.success = false` and CLI exits non-zero
- Option semantics remain unchanged from shell function:
  - default `--since` window is `24 hours ago`
  - optional `--flat` flag toggles flattening behavior
  - source scan root remains `.`

## Implementation Plan

### Tasks

- [x] Task 1: Add runnable command execution path with explicit runtime args
  - File: `src/index.ts`
  - Action: Add `run <name>` command with options `-s, --since <time>`, `--flat`, `--dry-run`, `-f, --force`; resolve runnable name, then invoke command with populated `context.args`.
  - Notes: CLI must exit non-zero on command failure and print clear errors.

- [x] Task 2: Add command-specific args channel in command context
  - File: `src/commands/Command.ts`
  - Action: Extend `CommandContext` with optional `args?: Record<string, unknown>` for command-specific runtime options.
  - Notes: Keep backwards compatibility for existing commands by making field optional.

- [x] Task 3: Add runnable name resolver and register `sync-docs`
  - File: `src/utils/registry.ts`
  - Action: Add resolver helper that maps input names/aliases to canonical runnable command IDs; register `sync-docs` entry and alias `syncDocs`.
  - Notes: Do not break existing list/describe behavior.

- [x] Task 4: Implement `SyncDocs` command class with typed args parsing
  - File: `src/commands/SyncDocs.ts`
  - Action: Create class extending `Command` that reads `since`/`flat` from `context.args`, validates types/defaults, and returns `InvokeResult`.
  - Notes: Missing/invalid args should produce actionable error text.

- [x] Task 5: Implement repo-name resolution with ancestor `.git` walk + fallback
  - File: `src/commands/SyncDocs.ts`
  - Action: Walk upward from `process.cwd()`; on nearest `.git` hit, use directory basename as repo name; if no hit, fallback to basename of `process.cwd()`.
  - Notes: Treat both `.git` directory and `.git` file as valid repo markers.

- [x] Task 6: Implement shell-equivalent file selection and copy behavior
  - File: `src/commands/SyncDocs.ts`
  - Action: Build destination `/home/delorenj/code/DeLoDocs/Projects/<repo>/docs/<YYYY-MM-DD>`; use `find . -not -path '*/.git/*' -type f -name '*.md' -newermt <since>` to select files; copy in flat or preserved-structure mode.
  - Notes: This intentionally preserves current helper semantics for relative time strings.

- [x] Task 7: Add destination safety checks and deterministic failure behavior
  - File: `src/commands/SyncDocs.ts`
  - Action: Validate destination root/writeability; create destination when not dry-run; fail fast with non-zero outcome on mkdir/copy errors.
  - Notes: Dry-run reports destination and intended count without writes.

- [x] Task 8: Validate high-risk paths manually
  - File: `src/index.ts`, `src/utils/registry.ts`, `src/commands/Command.ts`, `src/commands/SyncDocs.ts`
  - Action: Test runnable name resolution, invalid `--since`, destination permission failure, and happy-path sync behavior.
  - Notes: Include both git-repo and non-repo contexts.

### Acceptance Criteria

- [ ] AC 1: Given I am in a git repository, when I run `pjangler run sync-docs`, then files are copied to `/home/delorenj/code/DeLoDocs/Projects/<nearest-git-root-name>/docs/<today-YYYY-MM-DD>`.
- [ ] AC 2: Given I am in nested subdirectories under a git repo, when I run `pjangler run sync-docs`, then repo name comes from the nearest ancestor containing `.git` (repo root), not the current subdirectory.
- [ ] AC 3: Given I am outside any git repo, when I run `pjangler run sync-docs`, then destination uses the basename of the current directory as `<repo>`.
- [ ] AC 4: Given I provide no `--since`, when I run `pjangler run sync-docs`, then only markdown files modified since `24 hours ago` are considered.
- [ ] AC 5: Given I pass `--since "7 days ago"`, when I run `pjangler run sync-docs`, then filtering uses shell-equivalent `find -newermt` semantics for that literal value.
- [ ] AC 6: Given I pass an invalid or unsupported `--since` value, when I run `pjangler run sync-docs`, then command fails with a clear validation/error message and exits non-zero.
- [ ] AC 7: Given I do not pass `--flat`, when I run `pjangler run sync-docs`, then copied files preserve relative directory structure under destination.
- [ ] AC 8: Given I pass `--flat`, when I run `pjangler run sync-docs --flat`, then copied files are placed directly in destination root.
- [ ] AC 9: Given command is run with `--dry-run`, when sync executes, then no files or directories are created and output reports intended destination and file count.
- [ ] AC 10: Given destination root is missing or not writable, when I run `pjangler run sync-docs`, then command fails with explicit destination error and exits non-zero.
- [ ] AC 11: Given I run `pjangler run syncDocs`, when alias resolution executes, then it runs the same command as `pjangler run sync-docs`.
- [ ] AC 12: Given an unknown runnable command name, when I run `pjangler run <bad-name>`, then CLI exits with clear error and shows available runnable command names.
- [ ] AC 13: Given existing recipe and command-management commands, when I use them after this change, then their behavior remains unchanged.

## Additional Context

### Dependencies

- No new third-party libraries are required.
- Implementation depends on Node-compatible built-in modules (`fs`, `path`) and existing Commander usage.
- Runtime dependency remains `commander` as already declared in `package.json`.

### Testing Strategy

- Manual functional checks:
  - In a git repo: run `pjangler run sync-docs` and verify repo-root-based destination path.
  - In a nested repo folder: verify nearest `.git` ancestor naming.
  - Outside repo: verify fallback to current directory basename.
  - Run with `--flat` and verify flattened copy output.
  - Run with custom `--since` and verify `find -newermt` equivalent inclusion window.
  - Run with intentionally invalid `--since` and verify explicit failure + non-zero exit.
  - Run with `--dry-run` and verify no filesystem writes.
  - Run in a non-writable destination scenario and verify explicit failure + non-zero exit.
  - Run `pjangler run syncDocs` and verify alias resolves to `sync-docs` behavior.
  - Run with invalid command name and verify resolver error path.
- Regression checks:
  - `pjangler init <subsystem>` still works.
  - `pjangler recipe run <name>` still works.
  - `pjangler command list/describe` still works.

### Notes

- High-risk area (addressed by design): preserve shell time semantics by delegating `--since` handling to `find -newermt`; fail fast on invalid values or command execution errors.
- High-risk area: flattened mode may overwrite same-basename files from different directories; maintain current behavior and log collisions if practical.
- Future enhancement (out of scope): configurable destination root via env var or CLI flag.
- Future enhancement (out of scope): add automated tests once a test harness is introduced.


## Review Notes

- Adversarial review completed
- Findings: 10 total, 10 fixed, 0 skipped
- Resolution approach: auto-fix
- Adversarial review completed (pass 2)
- Findings: 10 total, 6 fixed, 4 accepted as low/noise
- Resolution approach: auto-fix
