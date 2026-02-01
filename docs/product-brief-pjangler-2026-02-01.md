# Product Brief: PJangler

**Document Type:** Product Brief
**Project:** pjangler
**Version:** 1.0
**Date:** 2026-02-01
**Author:** BMad Business Analyst
**Status:** Draft

---

## Executive Summary

PJangler is an opinionated CLI tool for bootstrapping project subsystems with a focus on developer experience, repeatability, and ecosystem integration. Built on the command pattern architecture, it provides idempotent operations for adding common development subsystems (Docker, Mise, Node.js, etc.) to any project while maintaining consistency across a developer's personal ecosystem.

**Core Value Proposition:** Eliminate repetitive project setup boilerplate while maintaining control over configuration through composable, recipe-based automation that integrates seamlessly with Claude AI agents.

---

## Problem Statement

### Current Pain Points

1. **Repetitive Setup Tax**
   - Developers waste hours configuring the same tools (Docker, Mise, environment files) across multiple projects
   - Copy-paste configurations lead to drift and inconsistency
   - Manual setup is error-prone and lacks validation

2. **Ecosystem Fragmentation**
   - Different project types (Node, Python, Go, Rust) require different tooling setups
   - No single tool handles cross-language project initialization
   - Existing tools (create-react-app, etc.) are framework-specific, not ecosystem-specific

3. **AI Agent Integration Gap**
   - Claude AI agents need structured, repeatable commands for project scaffolding
   - Manual setup instructions are ambiguous and require back-and-forth clarification
   - No standardized interface for AI-driven project bootstrapping

4. **Validation and Safety**
   - Existing tools often overwrite files without confirmation
   - No dry-run capability to preview changes
   - Difficult to verify what will change before execution

### Target Users

**Primary:** Solo developers and small teams who:
- Work across multiple languages/frameworks
- Use Mise for environment management
- Leverage Docker for containerization
- Integrate Claude AI agents into workflows
- Value control and transparency over "magic"

**Secondary:** AI agents (Claude Code) that:
- Need structured project setup commands
- Require idempotent, safe operations
- Benefit from recipe-based composition

---

## Solution Overview

### Product Vision

PJangler provides a command-pattern-based CLI that composes reusable "commands" into "recipes" for bootstrapping project subsystems. Each command is atomic, idempotent, and validates before execution.

### Key Capabilities

#### 1. Command Pattern Architecture
- **Atomic Commands:** Each command handles one file/configuration (e.g., AddDockerfile, AddMiseToml)
- **Composable Recipes:** Recipes chain multiple commands (e.g., DockerRecipe = AddDockerfile + AddDockerCompose + AddDockerignore)
- **Extensibility:** New commands and recipes can be added without modifying core logic

#### 2. Idempotent Operations
- Commands check if target files exist before writing
- Safe to re-run without side effects
- Respects existing configurations (no overwrites by default)

#### 3. Dry-Run Validation
- Preview all changes before execution
- Detect conflicts (e.g., mutually exclusive recipes)
- Validate recipe composition logic

#### 4. Multi-Language Support
- Node.js/TypeScript (Bun runtime)
- Python (uv package manager)
- Go (mise integration)
- Rust (cargo integration)
- Extensible to additional ecosystems

#### 5. Claude AI Agent Integration
- Structured skill interface (`pjangler-dev` skill)
- Recipe-based commands for predictable agent behavior
- Template-driven command generation from natural language prompts

### Architecture Highlights

```
pjangler
├── Commands (Atomic operations)
│   ├── AddDockerfile
│   ├── AddMiseToml
│   ├── AddDotenv
│   └── [Extensible]
├── Recipes (Command compositions)
│   ├── DockerRecipe
│   ├── MiseRecipe
│   ├── NodeRecipe
│   └── [Extensible]
└── CLI Interface (Typer-based)
    ├── recipe list
    ├── recipe run [NAME]
    ├── command list
    └── command create [NAME]
```

**Design Principles:**
- **Transparency:** Show what will change before changing it
- **Control:** User maintains final say on all operations
- **Composability:** Build complex setups from simple, tested primitives
- **Ecosystem Alignment:** Integrate with Mise, Docker, Bun, uv (user's preferred stack)

---

## Success Metrics

### Primary KPIs

1. **Time Savings**
   - Target: Reduce project setup time from 30+ minutes to <2 minutes
   - Measure: Track time from `pjangler init` to working environment

2. **Adoption Rate**
   - Target: Used in 80%+ of new projects by primary user
   - Measure: Projects with pjangler-generated configs vs. manual configs

3. **Recipe Coverage**
   - Target: 10+ recipes covering primary project types
   - Measure: Number of recipes in `/src/recipes`

4. **Command Extensibility**
   - Target: 5+ community/user-contributed commands in 6 months
   - Measure: Commands added via `pj command create`

### Secondary Metrics

- **AI Agent Integration:** Claude Code successfully executes 95%+ of pjangler commands without errors
- **Idempotency:** 100% of commands pass re-run tests without side effects
- **Validation Accuracy:** Dry-run conflicts detected match actual execution conflicts

---

## Scope

### In Scope (MVP)

1. **Core Commands**
   - Docker subsystem (Dockerfile, docker-compose, dockerignore)
   - Mise subsystem (mise.toml, tasks structure)
   - Node.js subsystem (package.json, tsconfig, .nvmrc)
   - Environment files (.env, .env.example)

2. **Recipe System**
   - DockerRecipe, MiseRecipe, NodeRecipe
   - Recipe validation logic
   - Dry-run mode

3. **CLI Interface**
   - `pjangler init <subsystem>`
   - `pjangler list`
   - `pjangler recipe list`
   - `pjangler recipe run <name> [--dry-run]`

4. **Claude Skill Integration**
   - `pjangler-dev` skill for command/recipe creation
   - Template-based command generation

### Out of Scope (Future)

- Web UI for recipe composition
- Remote recipe sharing/registry
- Plugin marketplace
- Advanced conflict resolution (beyond detection)
- Multi-project orchestration
- CI/CD pipeline generation (separate recipe)

---

## User Stories

### Epic 1: Core Bootstrapping

**US-1.1:** As a developer, I want to initialize Docker support in my project so I can containerize my application without manual Dockerfile creation.

**Acceptance Criteria:**
- `pjangler init docker` creates Dockerfile, docker-compose.yml, .dockerignore
- Files are appropriate for detected project type (Node/Python/Go)
- Existing files are not overwritten
- Success message shows created files

**US-1.2:** As a developer, I want to add Mise configuration to my project so I can manage environment versions and tasks consistently.

**Acceptance Criteria:**
- `pjangler init mise` creates mise.toml, .mise/tasks/ structure
- Configuration includes detected language versions
- Tasks structure follows user's preferred conventions
- Existing mise.toml is preserved

### Epic 2: Safety and Validation

**US-2.1:** As a developer, I want to preview changes before applying them so I can verify what pjangler will modify.

**Acceptance Criteria:**
- `pjangler recipe run <name> --dry-run` shows planned changes
- Output lists files to be created/modified
- No files are written during dry-run
- Clear indication of conflicts

**US-2.2:** As a developer, I want pjangler to detect conflicting recipes so I don't accidentally create incompatible configurations.

**Acceptance Criteria:**
- Running incompatible recipes triggers warning
- Examples: Docker + Podman, npm + yarn + bun
- User can override with `--force`
- Conflicts are documented in recipe metadata

### Epic 3: Extensibility

**US-3.1:** As a developer, I want to create custom commands from templates so I can extend pjangler for my specific needs.

**Acceptance Criteria:**
- `pj command create <name> <prompt>` generates new command
- Command follows established pattern (extends Command base class)
- Template supports common file types (TOML, JSON, YAML, Dockerfile)
- Generated command includes inline documentation

**US-3.2:** As a Claude AI agent, I want to use pjangler recipes for project setup so I can automate bootstrapping without manual intervention.

**Acceptance Criteria:**
- `pjangler-dev` skill accessible via `/pjangler` command
- Skill documentation includes recipe list and usage
- Commands are idempotent (safe for agent retry)
- Error messages are machine-readable

### Epic 4: Multi-Language Support

**US-4.1:** As a Python developer, I want to initialize a Python project with uv so I can use modern Python tooling.

**Acceptance Criteria:**
- `pjangler init python` creates pyproject.toml, .python-version
- Configures uv as package manager
- Sets up virtual environment structure
- Includes common dev dependencies (pytest, ruff, mypy)

**US-4.2:** As a Rust developer, I want to add Docker support to my Cargo project so I can containerize Rust applications.

**Acceptance Criteria:**
- `pjangler init docker` detects Cargo.toml
- Generates multi-stage Dockerfile for Rust
- Includes cargo-chef layer caching
- Sets up appropriate .dockerignore for Rust

---

## Technical Considerations

### Architecture Decisions

1. **Command Pattern**
   - **Rationale:** Enables atomic, composable operations with clear separation of concerns
   - **Trade-off:** More classes than procedural approach, but better testability and extensibility

2. **Bun Runtime**
   - **Rationale:** Fast, TypeScript-native, aligns with user's ecosystem preferences
   - **Trade-off:** Requires Bun installation, but target users already use it

3. **Recipe Composition**
   - **Rationale:** Reusable building blocks for complex setups
   - **Trade-off:** Requires recipe design for common patterns, but highly flexible

### Dependencies

**Core:**
- Bun (runtime)
- Commander (CLI framework)
- TypeScript (type safety)

**Future:**
- YAML parser (recipe definitions)
- Template engine (command generation)
- Validation library (dry-run logic)

### Integration Points

1. **Mise:** Generate mise.toml and task structures
2. **Docker:** Create Dockerfiles, compose files, ignore patterns
3. **Claude AI:** Skill-based command interface
4. **Git:** Detect .gitignore patterns, respect existing configs

---

## Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| File overwrite without backup | High | Medium | Default to preserve existing, require `--force` |
| Recipe conflicts undetected | Medium | Medium | Build conflict detection matrix, validate before execution |
| Template drift from best practices | Medium | High | Version templates, allow template overrides |
| Limited adoption beyond creator | Low | Medium | Documentation, examples, community recipes |
| Breaking changes in dependencies | Medium | Low | Pin dependency versions, test before updates |

---

## Open Questions

1. **Recipe Distribution**
   - How should users share custom recipes? Git repos? Central registry?
   - **Decision needed by:** Sprint 1 planning

2. **Conflict Resolution**
   - Should pjangler auto-resolve simple conflicts (e.g., merge .gitignore entries)?
   - **Decision needed by:** Sprint 2 planning

3. **Template Customization**
   - Should users be able to override default templates globally or per-project?
   - **Decision needed by:** Sprint 1 planning

4. **Multi-Project Orchestration**
   - Is there demand for initializing multiple projects simultaneously (monorepo support)?
   - **Decision needed by:** Post-MVP (gather user feedback first)

---

## Next Steps

1. **Tech Spec Phase**
   - Define command interface contracts
   - Design recipe validation logic
   - Specify dry-run output format
   - Document template structure

2. **Sprint Planning**
   - Break down Epic 1 (Core Bootstrapping) into implementable stories
   - Prioritize Docker, Mise, Node.js recipes
   - Allocate S/M/L sizing

3. **Prototype**
   - Validate command pattern with 2-3 commands
   - Test recipe composition with DockerRecipe
   - Verify idempotency with re-run tests

---

## Appendices

### A. Example Usage

```bash
# Initialize Docker subsystem
pjangler init docker

# Preview Mise setup
pjangler init mise --dry-run

# List available recipes
pjangler recipe list

# Create custom command
pj command create AddTraefikConfig "Add Traefik reverse proxy config"

# Run custom recipe
pj recipe run FullStack --dry-run
```

### B. Command Pattern Example

```typescript
// AddDockerfile.ts
export class AddDockerfile extends Command {
  async invoke(): Promise<InvokeResult> {
    const dockerfilePath = "Dockerfile";

    if (this.fileExists(dockerfilePath) && !this.context.force) {
      return {
        success: false,
        message: `⚠️  ${dockerfilePath} already exists (use --force to overwrite)`
      };
    }

    const content = this.generateDockerfileContent();
    this.writeFile(dockerfilePath, content);

    return {
      success: true,
      message: `✓ Created ${dockerfilePath}`,
      filePath: dockerfilePath
    };
  }
}
```

### C. Recipe Pattern Example

```typescript
// DockerRecipe.ts
export class DockerRecipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);

    this.addIngredient(AddDockerfile)
        .addIngredient(AddDockerCompose)
        .addIngredient(AddDockerignore);
  }

  protected printNextSteps(): void {
    console.log("\n✅ Docker subsystem initialized!");
    console.log("\nNext steps:");
    console.log("  1. Review Dockerfile for customization");
    console.log("  2. Run: docker compose up");
  }
}
```

---

**Document Status:** Ready for Tech Spec Phase
**Approved By:** [Pending]
**Next Review:** Sprint Planning
