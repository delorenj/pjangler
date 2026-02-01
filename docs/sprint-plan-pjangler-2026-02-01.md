# Sprint Plan: pjangler

**Date:** 2026-02-01
**Scrum Master:** Jarad DeLorenzo (BMad Scrum Master)
**Project Level:** 1 (Small feature set, 1-10 stories)
**Total Stories:** 10
**Total Points:** 38
**Planned Sprints:** 1 (Level 1 project)
**Plane Project:** Not configured (personal tool)

---

## Executive Summary

Sprint plan for pjangler CLI tool development, focusing on enhancing the existing command-pattern architecture with dry-run mode, project detection, conflict validation, template generation, and multi-language support. Single sprint approach suitable for Level 1 project scope.

**Key Metrics:**
- Total Stories: 10
- Total Points: 38
- Sprints: 1
- Team Capacity: 40 points per sprint (1 senior dev, 2 weeks)
- Target Completion: Sprint 1 (2 weeks)
- Utilization: 95% (38/40 points)

---

## Story Inventory

### STORY-001: Enhance CLI Interface

**Priority:** Must Have
**Points:** 3
**Epic:** Core Enhancement

**User Story:**
As a developer
I want comprehensive CLI commands for managing recipes and commands
So that I can interact with pjangler beyond simple `init` operations

**Acceptance Criteria:**
- [ ] `pjangler recipe list` displays all available recipes
- [ ] `pjangler recipe describe <name>` shows recipe commands and metadata
- [ ] `pjangler recipe run <name>` executes specified recipe
- [ ] `pj command list [--group]` shows all commands (with optional grouping)
- [ ] `pj command describe <name>` displays command details
- [ ] `pj command create <name> <prompt>` scaffolds new command
- [ ] All commands have consistent help text and error messages
- [ ] Success/error messages follow established patterns

**Technical Notes:**
- Extend Commander.js program in /home/delorenj/code/pjangler/src/index.ts
- Add new command handlers for recipe and command management
- Implement grouping logic for command list
- Follow existing CLI conventions (emojis for status, clear messages)

**Dependencies:**
- None (foundation for other stories)

---

### STORY-002: Implement Dry-Run Mode

**Priority:** Must Have
**Points:** 5
**Epic:** Safety & Validation

**User Story:**
As a developer
I want to preview changes before applying them
So that I can verify what pjangler will modify without risking file overwrites

**Acceptance Criteria:**
- [ ] `--dry-run` flag supported on all recipe and init commands
- [ ] Dry-run mode shows files to be created/modified
- [ ] Dry-run mode does NOT write any files
- [ ] Output clearly indicates "[DRY RUN]" prefix for all operations
- [ ] Conflict detection runs during dry-run
- [ ] CommandContext includes dryRun boolean field
- [ ] All Command classes respect dryRun flag
- [ ] Recipe.execute() propagates dry-run through all ingredients

**Technical Notes:**
- Add `dryRun?: boolean` to CommandContext interface
- Update Command.writeFile() to check context.dryRun before writing
- Update all existing commands (AddDockerfile, AddMiseToml, etc.) to return "[DRY RUN]" messages
- Update Recipe.execute() to pass dryRun through context
- CLI flag parsing in Commander.js

**Dependencies:**
- STORY-001 (CLI interface for flags)

---

### STORY-003: Project Type Detection

**Priority:** Must Have
**Points:** 3
**Epic:** Intelligence Layer

**User Story:**
As a developer
I want pjangler to automatically detect my project type
So that it generates appropriate configurations without manual specification

**Acceptance Criteria:**
- [ ] Detects Node.js projects (package.json, bun.lockb)
- [ ] Detects Python projects (pyproject.toml, requirements.txt, .python-version)
- [ ] Detects Rust projects (Cargo.toml)
- [ ] Detects Go projects (go.mod)
- [ ] Returns "unknown" for unrecognized projects
- [ ] Detection logic is extensible for future languages
- [ ] Project type stored in CommandContext
- [ ] Commands use project type for content generation

**Technical Notes:**
- Add `detectProjectType()` method to Command base class
- Check for marker files in this order: package.json → pyproject.toml → Cargo.toml → go.mod
- Add `projectType?: 'node' | 'python' | 'rust' | 'go' | 'unknown'` to CommandContext
- Update AddDockerfile to generate language-specific Dockerfiles based on type
- Update commands to use detected type in templates

**Dependencies:**
- None (enhances existing commands)

---

### STORY-004: Conflict Detection System

**Priority:** Should Have
**Points:** 5
**Epic:** Intelligence Layer

**User Story:**
As a developer
I want pjangler to warn me about conflicting recipes
So that I don't accidentally create incompatible configurations

**Acceptance Criteria:**
- [ ] RecipeMetadata interface includes conflicts field
- [ ] Conflict validation runs before recipe execution
- [ ] Warning displayed for mutually exclusive recipes
- [ ] Examples: Docker + Podman, npm + yarn + bun conflicts detected
- [ ] `--force` flag allows override of conflict warnings
- [ ] Conflict detection works in dry-run mode
- [ ] Clear messaging: "⚠️ Conflict detected: Recipe X conflicts with existing Y. Use --force to override."

**Technical Notes:**
- Create RecipeMetadata interface with name, description, conflicts, dependencies, tags
- Add `metadata()` method to Recipe base class
- Implement conflict detection in Recipe.execute() before running ingredients
- Check for marker files that indicate conflicting tools (package-lock.json vs bun.lockb vs yarn.lock)
- Store conflict rules in recipe metadata

**Dependencies:**
- STORY-002 (dry-run infrastructure)

---

### STORY-005: Template Generation System

**Priority:** Should Have
**Points:** 8
**Epic:** Extensibility

**User Story:**
As a developer
I want to create custom commands from natural language prompts
So that I can extend pjangler for my specific needs without writing boilerplate

**Acceptance Criteria:**
- [ ] `pj command create <name> <prompt>` generates valid command class
- [ ] Generated command extends Command base class
- [ ] Template supports common file types (TOML, JSON, YAML, Dockerfile)
- [ ] Generated code includes inline documentation
- [ ] Command is created in /home/delorenj/code/pjangler/src/commands/
- [ ] Command follows naming convention (Add{FileName})
- [ ] Generated code passes TypeScript type checking
- [ ] --template flag allows specifying template type
- [ ] --model flag allows specifying LLM model (OpenRouter)

**Technical Notes:**
- Integrate with LLM API (OpenRouter) for code generation
- Create prompt templates for different file types
- Validate generated code structure (must have invoke() method, extend Command)
- Run prettier/eslint on generated code
- Provide escape hatch to manual editing if generation fails
- Store templates in /home/delorenj/code/pjangler/src/templates/

**Dependencies:**
- STORY-001 (command create CLI)
- STORY-003 (project detection for context)

---

### STORY-006: Python Recipe

**Priority:** Should Have
**Points:** 3
**Epic:** Multi-Language Support

**User Story:**
As a Python developer
I want to initialize Python projects with uv
So that I can use modern Python tooling

**Acceptance Criteria:**
- [ ] `pjangler init python` creates pyproject.toml
- [ ] Creates .python-version file
- [ ] Configures uv as package manager
- [ ] Sets up virtual environment structure (.venv/)
- [ ] Includes common dev dependencies (pytest, ruff, mypy) in pyproject.toml
- [ ] AddPyprojectToml command implemented
- [ ] AddPythonVersion command implemented
- [ ] PythonRecipe combines Python commands
- [ ] Generates appropriate .gitignore entries

**Technical Notes:**
- Create AddPyprojectToml command with uv-compatible pyproject.toml template
- Create AddPythonVersion command (detects latest stable or uses default)
- Create PythonRecipe that chains AddPyprojectToml, AddPythonVersion
- Follow uv conventions for project structure
- Template includes [build-system], [project], [tool.ruff], [tool.mypy] sections

**Dependencies:**
- STORY-003 (project detection to avoid conflicts)

---

### STORY-007: Rust Recipe

**Priority:** Could Have
**Points:** 3
**Epic:** Multi-Language Support

**User Story:**
As a Rust developer
I want to add Docker support to my Cargo project
So that I can containerize Rust applications efficiently

**Acceptance Criteria:**
- [ ] `pjangler init docker` detects Cargo.toml (Rust project)
- [ ] Generates multi-stage Dockerfile for Rust
- [ ] Includes cargo-chef layer caching for faster builds
- [ ] Sets up appropriate .dockerignore for Rust (target/, .git/, etc.)
- [ ] RustDockerfile template optimized for build time
- [ ] Handles both binary and library Cargo projects

**Technical Notes:**
- Enhance AddDockerfile to check for Rust via detectProjectType()
- Create Rust-specific Dockerfile template with cargo-chef pattern
- Multi-stage build: chef prepare → chef cook → build → runtime
- Use rust:1.75 (or latest) base image
- Runtime stage uses distroless or alpine for minimal size
- .dockerignore includes target/, Cargo.lock (for libraries)

**Dependencies:**
- STORY-003 (project detection for Rust)

---

### STORY-008: Testing Framework

**Priority:** Must Have
**Points:** 5
**Epic:** Quality Assurance

**User Story:**
As a maintainer
I want comprehensive test coverage
So that I can confidently refactor and extend pjangler

**Acceptance Criteria:**
- [ ] Unit tests for all Command classes (≥90% coverage)
- [ ] Unit tests for all Recipe classes
- [ ] Idempotency tests (re-running commands produces identical result)
- [ ] Integration tests for CLI commands
- [ ] Test utilities for filesystem mocking
- [ ] Tests run via `bun test`
- [ ] CI/CD integration (GitHub Actions) for test automation
- [ ] Coverage reports generated

**Technical Notes:**
- Use Bun's native test runner (built-in, fast)
- Create test utilities: mockContext(), mockFileSystem(), hashDirectory()
- Idempotency test pattern: run command 2x, compare file hashes
- Integration tests spawn actual CLI process and verify output
- Setup teardown for filesystem cleanup
- Store tests in /home/delorenj/code/pjangler/tests/

**Test Examples:**
```typescript
describe('AddDockerfile', () => {
  it('creates Dockerfile when none exists', async () => { ... });
  it('skips if file exists without --force', async () => { ... });
  it('overwrites with --force flag', async () => { ... });
  it('respects dry-run mode', async () => { ... });
});

describe('Idempotency', () => {
  it('DockerRecipe produces same result on re-run', async () => { ... });
});
```

**Dependencies:**
- STORY-001, 002 (CLI and dry-run to test)

---

### STORY-009: pjangler-dev Skill

**Priority:** Should Have
**Points:** 2
**Epic:** AI Integration

**User Story:**
As a Claude AI agent
I want a structured skill interface for pjangler
So that I can automate command and recipe creation

**Acceptance Criteria:**
- [ ] pjangler-dev.skill file created in /home/delorenj/code/pjangler/skills/
- [ ] Skill documentation includes usage examples
- [ ] Skill integrates with STORY-005 (template generation)
- [ ] Skill accessible via `/pjangler` command in Claude Code
- [ ] Error messages are agent-friendly (structured, parseable)
- [ ] Idempotent operations (safe for agent retry)

**Technical Notes:**
- Create skill manifest following Claude Code skill format
- Document all pjangler commands with examples
- Include recipe creation workflow
- Include command creation workflow
- Reference existing commands (Docker, Mise, Node)
- Add skill to /home/delorenj/code/pjangler/pjangler-dev.skill

**Dependencies:**
- STORY-001 (CLI interface)
- STORY-005 (template generation)

---

### STORY-010: Documentation & Examples

**Priority:** Must Have
**Points:** 1
**Epic:** Developer Experience

**User Story:**
As a new user
I want clear documentation and examples
So that I can start using pjangler without reading source code

**Acceptance Criteria:**
- [ ] README.md updated with comprehensive usage guide
- [ ] Examples for all subsystems (Docker, Mise, Node, Python, Rust)
- [ ] Troubleshooting section
- [ ] Architecture diagram (command pattern, recipes)
- [ ] API reference for programmatic usage
- [ ] Contributing guide
- [ ] Changelog

**Technical Notes:**
- Update /home/delorenj/code/pjangler/README.md
- Add examples/ directory with sample projects
- Document CLI commands with output examples
- Include Mermaid diagram for architecture
- Document extension points (creating commands, recipes)
- Add badges (build status, coverage, npm version)

**Dependencies:**
- STORY-001 through 009 (documenting completed features)

---

## Sprint 1 Allocation (Weeks 1-2)

**Sprint Goal:** Deliver enhanced pjangler CLI with dry-run validation, project detection, Python/Rust support, comprehensive testing, and AI integration

**Capacity:** 40 points (1 senior dev, 2 weeks, 6 productive hours/day = 60 hours → 30 points at 2 hours/point)

**Committed Stories:** All 10 stories (38 points, 95% utilization)

### Week 1 Focus: Core Enhancement & Intelligence

**Monday-Wednesday:**
- STORY-001: Enhance CLI Interface (3 pts)
- STORY-002: Implement Dry-Run Mode (5 pts)
- STORY-003: Project Type Detection (3 pts)

**Thursday-Friday:**
- STORY-004: Conflict Detection System (5 pts)
- Begin STORY-005: Template Generation System (8 pts)

### Week 2 Focus: Language Support & Quality

**Monday-Wednesday:**
- Complete STORY-005: Template Generation System
- STORY-006: Python Recipe (3 pts)
- STORY-007: Rust Recipe (3 pts)

**Thursday:**
- STORY-008: Testing Framework (5 pts)
- STORY-009: pjangler-dev Skill (2 pts)

**Friday:**
- STORY-010: Documentation & Examples (1 pt)
- Final testing and polish
- Sprint review

**Risks:**
- **Medium:** Template generation (STORY-005) complexity - may need more time for LLM integration
  - *Mitigation:* Start early in week, have fallback to simpler template literals
- **Low:** Testing framework setup - Bun test is well-documented
  - *Mitigation:* Leverage existing test patterns from Bun ecosystem

**Dependencies:**
- None external
- OpenRouter API access for STORY-005 (already available)

---

## Epic Traceability

| Epic | Stories | Total Points | Sprint |
|------|---------|--------------|--------|
| Core Enhancement | STORY-001, 002 | 8 pts | Sprint 1 |
| Safety & Validation | STORY-002, 004 | 10 pts | Sprint 1 |
| Intelligence Layer | STORY-003, 004, 005 | 16 pts | Sprint 1 |
| Extensibility | STORY-005 | 8 pts | Sprint 1 |
| Multi-Language Support | STORY-006, 007 | 6 pts | Sprint 1 |
| Quality Assurance | STORY-008 | 5 pts | Sprint 1 |
| AI Integration | STORY-009 | 2 pts | Sprint 1 |
| Developer Experience | STORY-010 | 1 pt | Sprint 1 |

**Coverage:** 8 epics, 10 stories, 38 points total

---

## Functional Requirements Coverage

| FR ID | FR Name | Stories | Sprint |
|-------|---------|---------|--------|
| FR-1 | Command Pattern Architecture | STORY-001, 005, 008 | 1 |
| FR-2 | Recipe Composition | STORY-001, 006, 007 | 1 |
| FR-3 | Idempotent Operations | STORY-002, 008 | 1 |
| FR-4 | CLI Interface | STORY-001 | 1 |
| FR-5 | Dry-Run Mode | STORY-002 | 1 |
| FR-6 | Multi-Language Support | STORY-003, 006, 007 | 1 |
| FR-7 | Claude AI Integration | STORY-005, 009 | 1 |
| FR-8 | Docker Subsystem | STORY-007 (Rust Docker) | 1 |
| FR-9 | Mise Subsystem | Existing (already implemented) | N/A |
| FR-10 | Environment Files | Existing (already implemented) | N/A |

**All functional requirements covered by sprint plan.**

---

## Risks and Mitigation

### High

None identified for Level 1 project scope.

### Medium

- **Template Generation Complexity (STORY-005)**
  - *Risk:* LLM integration may be more complex than estimated
  - *Impact:* Could delay sprint completion
  - *Probability:* 30%
  - *Mitigation:* Allocate 8 points (largest story), start early in sprint, have fallback to simpler template literals if LLM path blocks

- **Conflict Detection False Positives (STORY-004)**
  - *Risk:* Overly aggressive conflict rules annoy users
  - *Impact:* Poor user experience
  - *Probability:* 20%
  - *Mitigation:* Conservative conflict rules, clear messaging, easy --force override

### Low

- **Bun Test Framework Setup (STORY-008)**
  - *Risk:* Unfamiliarity with Bun's test runner
  - *Impact:* Slower test development
  - *Probability:* 10%
  - *Mitigation:* Bun test is well-documented, follows Jest-like API

- **Python/Rust Recipe Compatibility (STORY-006, 007)**
  - *Risk:* Edge cases in project detection
  - *Impact:* Incorrect config generation
  - *Probability:* 15%
  - *Mitigation:* Comprehensive testing, clear error messages, idempotency ensures safe re-runs

---

## Dependencies

### External Dependencies

- **OpenRouter API** - Required for STORY-005 (template generation)
  - Status: ✓ Available
  - API key: Configured in environment
  - Fallback: Use template literals if API unavailable

- **Bun Runtime** - Required for all development and testing
  - Status: ✓ Installed (v1.2.22+)
  - No blockers

### Internal Dependencies

- None blocking
- Story dependencies managed through sprint allocation order

---

## Definition of Done

For a story to be considered complete:

- [ ] Code implemented and committed to main branch
- [ ] Unit tests written and passing (≥80% coverage for new code)
- [ ] Integration tests passing (where applicable)
- [ ] Code follows TypeScript strict mode (no any types)
- [ ] Documentation updated (inline comments + README where needed)
- [ ] Manual testing completed (command works as expected)
- [ ] Acceptance criteria validated (all checkboxes checked)
- [ ] No regressions in existing functionality
- [ ] Git commit message follows convention (imperative, co-authored)

**Sprint 1 Complete When:**
- All 10 stories meet Definition of Done
- `bun test` passes with ≥90% coverage
- All CLI commands functional and documented
- README.md updated with examples
- No P0/P1 bugs outstanding

---

## Team Capacity & Velocity

**Team Composition:**
- 1 senior developer (Jarad DeLorenzo)
- TypeScript/Bun expertise: High
- CLI tool development experience: High
- Command pattern familiarity: High (existing codebase)

**Sprint Configuration:**
- Length: 2 weeks (10 workdays)
- Productive hours/day: 6 hours
- Total hours: 60 hours
- Points per hour: 0.5 (senior velocity)
- **Sprint Capacity: 40 points**

**Buffer:**
- Committed: 38 points (95% utilization)
- Buffer: 2 points (5%) for unknowns, bugs, refactoring

**Velocity Notes:**
- Level 1 project = single sprint feasible
- Senior dev = higher velocity (2 hours/point vs 3-4 for mid)
- Existing codebase = less setup, faster execution
- Familiar tech stack = fewer unknowns

---

## Sprint Cadence

**Sprint 1 Schedule:**

**Week 1:**
- **Monday:** Sprint planning (this document), begin STORY-001
- **Tuesday-Wednesday:** STORY-001, 002, 003 (Core + Dry-run + Detection)
- **Thursday-Friday:** STORY-004, begin STORY-005 (Conflicts + Templates)

**Week 2:**
- **Monday-Wednesday:** Complete STORY-005, STORY-006, 007 (Templates + Python + Rust)
- **Thursday:** STORY-008, 009 (Testing + Skill)
- **Friday:** STORY-010, final testing, sprint review

**Daily Routine:**
- Morning: Review progress, select next story
- Afternoon: Development + testing
- Evening: Commit with co-authored message

**Sprint Review:** Friday Week 2
- Demo all 10 stories
- Validate against acceptance criteria
- Collect feedback (self-review for solo dev)

**Sprint Retrospective:** Friday Week 2
- What went well?
- What could improve?
- Action items for next project

---

## Metrics & Success Criteria

### Sprint Success Metrics

**Completion:**
- **Target:** 38/38 points completed (100%)
- **Acceptable:** 34+/38 points (89%+)
- **Measure:** Story status in sprint-status.yaml

**Quality:**
- **Target:** ≥90% test coverage
- **Acceptable:** ≥80% test coverage
- **Measure:** `bun test --coverage`

**Velocity:**
- **Expected:** 38 points in 2 weeks
- **Measure:** Actual points completed
- **Use for:** Future sprint planning (if pjangler expands)

### Product Success Metrics

(From Tech Spec - validate during sprint)

**Performance:**
- Command execution: <5 seconds
- Dry-run preview: <2 seconds

**Reliability:**
- 100% idempotency (re-run test passes)
- 0 file overwrite errors without --force

**Usability:**
- All error messages include next steps
- Success messages show what changed

---

## Next Steps

**Immediate Actions:**

1. **Begin Sprint 1 Development**
   - Start with STORY-001 (Enhance CLI Interface)
   - Follow Definition of Done for each story
   - Commit frequently with co-authored messages

2. **Create Story Documents (Optional)**
   - Run `/bmad:create-story STORY-001` for detailed story breakdown
   - Or proceed directly to implementation

3. **Development Workflow**
   - Run `/bmad:dev-story STORY-001` to implement first story
   - Use `/bmad:dev-story STORY-XXX` for subsequent stories
   - Follow test-driven development where applicable

4. **Sprint Tracking**
   - Update sprint-status.yaml as stories progress
   - Daily progress check: `bun test` to validate no regressions
   - Weekly review: Are we on track for 38 points?

**When Sprint Completes:**
- Run final test suite: `bun test --coverage`
- Validate all acceptance criteria
- Update README.md with examples
- Tag release: `v1.0.0` (MVP complete)
- Retrospective: Document lessons learned

---

**This plan was created using BMAD Method v6 - Phase 4 (Implementation Planning)**

**Plan Status:** Ready for Implementation
**Next Workflow:** `/bmad:dev-story STORY-001` or `/bmad:create-story STORY-001`
**Sprint Start Date:** 2026-02-01
**Target Completion:** 2026-02-15 (2 weeks)
