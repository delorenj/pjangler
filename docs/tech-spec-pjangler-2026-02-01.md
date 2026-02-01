# Technical Specification: PJangler

**Document Type:** Technical Specification
**Project:** pjangler
**Version:** 1.0
**Date:** 2026-02-01
**Author:** BMad Product Manager
**Status:** Draft

---

## 1. Problem & Solution

### Problem Statement

Developers waste significant time on repetitive project setup across multiple languages and frameworks. Existing tools are framework-specific (create-react-app) rather than ecosystem-specific (Mise, Docker, Bun), leading to configuration drift and manual errors. Claude AI agents lack structured interfaces for project bootstrapping, requiring ambiguous manual instructions.

### Proposed Solution

PJangler provides a command-pattern CLI that composes atomic, idempotent "commands" into "recipes" for bootstrapping project subsystems. Each command validates before execution, supports dry-run previews, and integrates with Claude AI agents through a structured skill interface. The tool maintains user control while eliminating repetitive setup boilerplate.

---

## 2. Requirements

### Functional Requirements

- **FR-1: Command Pattern Architecture**
  - Each command is an atomic operation (e.g., AddDockerfile, AddMiseToml)
  - Commands extend base Command class with invoke() method
  - Commands check file existence before writing
  - Commands return InvokeResult with success status and message

- **FR-2: Recipe Composition**
  - Recipes chain multiple commands using addIngredient()
  - Recipes execute commands sequentially
  - Recipes provide printNextSteps() guidance
  - Built-in recipes: DockerRecipe, MiseRecipe, NodeRecipe

- **FR-3: Idempotent Operations**
  - Commands detect existing files and skip (no overwrite by default)
  - Re-running commands produces same result without errors
  - `--force` flag available for intentional overwrites

- **FR-4: CLI Interface**
  - `pjangler init <subsystem>` - Initialize subsystem (docker, mise, node)
  - `pjangler list` - List available subsystems
  - `pjangler recipe list` - List available recipes
  - `pjangler recipe describe <name>` - Show recipe commands
  - `pjangler recipe run <name> [--dry-run]` - Execute recipe with optional dry-run
  - `pj command list [--group]` - List commands (shorthand alias)
  - `pj command describe <name>` - Show command details
  - `pj command create <name> <prompt>` - Generate new command from template

- **FR-5: Dry-Run Mode**
  - `--dry-run` flag previews changes without writing files
  - Output shows files to be created/modified
  - Conflict detection runs during dry-run
  - Clear visual indication of what would happen

- **FR-6: Multi-Language Support**
  - Node.js: package.json, tsconfig.json, .nvmrc, bun.lockb
  - Python: pyproject.toml, .python-version, uv.lock
  - Rust: Cargo.toml detection, multi-stage Dockerfile
  - Go: go.mod detection, mise.toml Go version
  - Auto-detection of project type from existing files

- **FR-7: Claude AI Integration**
  - `pjangler-dev` skill for command/recipe creation
  - Template-driven command generation from natural language
  - Structured error messages for agent parsing
  - Idempotent operations for safe agent retry

- **FR-8: Docker Subsystem**
  - AddDockerfile: Language-specific Dockerfiles
  - AddDockerCompose: Multi-service compose files
  - AddDockerignore: Language-specific ignore patterns
  - DockerRecipe: Combines all Docker commands

- **FR-9: Mise Subsystem**
  - AddMiseToml: Environment version management
  - AddMiseBaseToml: Base mise configuration
  - AddMiseTasksStructure: Task directory setup
  - AddMiseBaseScript: Common task scripts
  - MiseRecipe: Full mise integration

- **FR-10: Environment Files**
  - AddDotenv: .env.example template
  - Environment-specific templates (.env.local, .env.production)
  - 1Password integration hints for secret management

### Out of Scope

- Web UI for recipe composition
- Remote recipe registry/marketplace
- Automatic conflict resolution (detection only)
- Multi-project orchestration
- CI/CD pipeline generation (future recipe)
- Real-time file watching/hot reload

---

## 3. Technical Approach

### Technology Stack

- **Language/Framework:** TypeScript + Bun runtime
- **CLI Framework:** Commander.js
- **Package Manager:** Bun
- **Build Tool:** Bun bundler
- **Testing:** Bun test (native test runner)
- **Type Checking:** TypeScript strict mode
- **Template Engine:** Template literals (future: Handlebars/EJS if needed)
- **YAML Parsing:** js-yaml (for recipe definitions)

### Architecture Overview

```
┌─────────────────────────────────────────┐
│         CLI Entry Point (index.ts)      │
│  - Commander program setup              │
│  - Command routing                      │
└──────────────┬──────────────────────────┘
               │
               ├─────────────────────────────────┐
               │                                 │
       ┌───────▼────────┐             ┌─────────▼──────────┐
       │    Recipes     │             │     Commands       │
       │  (Orchestrate) │             │    (Execute)       │
       ├────────────────┤             ├────────────────────┤
       │ DockerRecipe   │────┬────────►│ AddDockerfile     │
       │ MiseRecipe     │    │        │ AddDockerCompose  │
       │ NodeRecipe     │    │        │ AddMiseToml       │
       │ [Custom]       │    │        │ AddDotenv         │
       └────────────────┘    │        │ [Custom]          │
                             │        └────────────────────┘
                             │                 │
                             │                 │
                    ┌────────▼─────────────────▼──────┐
                    │      CommandContext             │
                    │  - targetDir                    │
                    │  - force flag                   │
                    │  - dryRun flag                  │
                    └─────────────────────────────────┘
```

**Data Flow:**

1. User runs `pjangler init docker`
2. CLI routes to DockerRecipe
3. DockerRecipe adds ingredients (AddDockerfile, AddDockerCompose, AddDockerignore)
4. Recipe executes each command's invoke() method sequentially
5. Each command:
   - Checks file existence via fileExists()
   - Generates content based on project detection
   - Writes file via writeFile() or skips if exists
   - Returns InvokeResult
6. Recipe displays results and next steps

**Key Design Patterns:**

- **Command Pattern:** Encapsulates file operations as objects
- **Template Method:** Recipe.execute() defines workflow, subclasses customize
- **Strategy Pattern:** Different commands for different file types
- **Dependency Injection:** CommandContext passed to all commands

### Data Model

**Core Types:**

```typescript
// Command interface
export interface InvokeResult {
  success: boolean;
  message: string;
  filePath?: string;
  warnings?: string[];
}

export interface CommandContext {
  targetDir: string;
  force?: boolean;
  dryRun?: boolean;
  projectType?: 'node' | 'python' | 'rust' | 'go';
}

export abstract class Command {
  protected context: CommandContext;

  constructor(context: CommandContext);
  abstract invoke(): Promise<InvokeResult>;

  protected fileExists(filePath: string): boolean;
  protected writeFile(filePath: string, content: string): void;
  protected createDirectory(dirPath: string): void;
  protected detectProjectType(): string;
}

// Recipe interface
export interface AddIngredient<T extends Command> {
  new (context: CommandContext): T;
}

export abstract class Recipe {
  protected context: CommandContext;
  protected ingredients: Command[];

  constructor(context: CommandContext);
  addIngredient<T extends Command>(CommandClass: AddIngredient<T>): this;
  async execute(): Promise<void>;
  protected abstract printNextSteps(): void;
}
```

**Recipe Metadata (Future):**

```typescript
export interface RecipeMetadata {
  name: string;
  description: string;
  conflicts?: string[];  // Conflicting recipe names
  dependencies?: string[]; // Required recipes
  tags?: string[];
}
```

### API Design

**CLI Commands:**

```bash
# Core initialization
pjangler init <subsystem>
  --force          # Overwrite existing files
  --dry-run        # Preview changes without writing

# List subsystems
pjangler list

# Recipe management
pjangler recipe list
pjangler recipe describe <name>
pjangler recipe run <name> [--dry-run] [--force]

# Command management (shorthand: pj)
pj command list [--group]
pj command describe <name>
pj command create <name> <prompt> [--template <type>]

# Project description (for AI context)
pj describe
```

**Programmatic API (Future):**

```typescript
import { DockerRecipe, CommandContext } from 'pjangler';

const context: CommandContext = {
  targetDir: '/path/to/project',
  force: false,
  dryRun: false
};

const recipe = new DockerRecipe(context);
await recipe.execute();
```

---

## 4. Implementation Plan

### Story Breakdown (1-10 Stories)

1. **Enhance CLI Interface** - Add missing commands (recipe list/describe/run, command list/describe/create)
2. **Implement Dry-Run Mode** - Add --dry-run flag support across all commands
3. **Project Type Detection** - Auto-detect Node/Python/Rust/Go from existing files
4. **Conflict Detection System** - Recipe metadata and conflict validation
5. **Template Generation System** - Command creation from natural language prompts
6. **Python Recipe** - Add Python subsystem support (pyproject.toml, uv)
7. **Rust Recipe** - Add Rust subsystem support (Cargo-aware Docker)
8. **Testing Framework** - Idempotency tests, command unit tests, integration tests
9. **pjangler-dev Skill** - Claude AI skill for command/recipe creation
10. **Documentation & Examples** - README, usage examples, troubleshooting guide

### Development Phases

**Phase 1: Core Enhancement (Stories 1-2)**
- Extend CLI with missing commands
- Implement dry-run infrastructure
- Foundation for remaining features

**Phase 2: Intelligence Layer (Stories 3-5)**
- Project detection logic
- Conflict validation
- Template generation engine

**Phase 3: Language Expansion (Stories 6-7)**
- Python ecosystem support
- Rust ecosystem support
- Multi-language validation

**Phase 4: Quality & Integration (Stories 8-10)**
- Comprehensive testing
- Claude AI skill integration
- Documentation completion

---

## 5. Acceptance Criteria

### MVP Completion Criteria

- [ ] All 10 CLI commands implemented and functional
- [ ] Dry-run mode works for all recipes (no files written, shows preview)
- [ ] Idempotency verified: re-running commands produces identical result
- [ ] Project type auto-detection works for Node, Python, Rust, Go
- [ ] Conflict detection warns for mutually exclusive recipes
- [ ] Template generation creates valid command classes from prompts
- [ ] Python and Rust recipes generate appropriate configurations
- [ ] 90%+ test coverage for command and recipe classes
- [ ] pjangler-dev skill successfully creates commands via Claude Code
- [ ] Documentation includes examples for all subsystems

### User Acceptance

- [ ] User can initialize Docker in <30 seconds
- [ ] User can add Mise to existing project without breaking changes
- [ ] User can preview all changes before applying (dry-run)
- [ ] User can create custom command with natural language prompt
- [ ] Claude AI agent can successfully execute pjangler commands

---

## 6. Non-Functional Requirements

### Performance

- **Requirement:** Command execution completes in <5 seconds for typical project
- **Metric:** Time from `pjangler init` to completion message
- **Rationale:** Setup should feel instant, not slow down development workflow

- **Requirement:** Dry-run preview displays in <2 seconds
- **Metric:** Time from --dry-run flag to output display
- **Rationale:** Fast feedback loop for validation

### Security

- **Requirement:** Never commit secrets to generated files
- **Metric:** .env.example files must not contain actual secrets
- **Mitigation:** Template files use placeholder values (e.g., `YOUR_API_KEY`)

- **Requirement:** Respect existing .gitignore patterns
- **Metric:** Generated files don't override security-sensitive ignores
- **Mitigation:** Append to .gitignore, never replace

- **Requirement:** Template injection prevention
- **Metric:** User-provided prompts sanitized before code generation
- **Mitigation:** Escape special characters, validate generated code structure

### Reliability

- **Requirement:** 100% idempotency for all commands
- **Metric:** Re-running any command 10x produces identical file state
- **Testing:** Automated idempotency test suite

- **Requirement:** Graceful handling of missing dependencies
- **Metric:** Clear error messages if Bun/Mise/Docker not installed
- **Mitigation:** Check for tool availability before execution

### Usability

- **Requirement:** Error messages include actionable next steps
- **Example:** "❌ Dockerfile already exists. Use --force to overwrite or --dry-run to preview changes."
- **Metric:** Error messages answer "what do I do now?"

- **Requirement:** Success messages show what was created
- **Example:** "✓ Created Dockerfile, docker-compose.yml, .dockerignore"
- **Metric:** User knows exactly what changed

---

## 7. Dependencies, Risks, Timeline

### Dependencies

**External Dependencies:**
- Bun runtime (>= 1.2.0) - Required for execution
- Mise (optional) - For mise.toml validation
- Docker (optional) - For Dockerfile validation
- Git (optional) - For .gitignore detection

**Internal Dependencies:**
- Commander.js (CLI framework) - Already installed
- js-yaml (recipe parsing) - To be added
- Handlebars/EJS (templating) - To be added (if needed)

**Blocked By:**
- None (can start immediately)

### Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Template drift from best practices** | Medium | High | Version control templates, allow user overrides, document template structure |
| **Conflict detection false positives** | Medium | Medium | Conservative conflict rules, allow --force override, provide clear warnings |
| **Command generation produces invalid code** | High | Medium | Validate generated code structure, run linter, provide escape hatch to manual edit |
| **Bun API changes break compatibility** | Medium | Low | Pin Bun version, test against LTS releases, maintain changelog |
| **User confusion with CLI interface** | Low | Medium | Comprehensive help text, examples in docs, `pj list` shows all options |

### Timeline

**Target Completion:** End of Sprint 1 (MVP functional)

**Milestones:**

1. **CLI Enhancement Complete** - All 10 commands working (Phase 1)
2. **Intelligence Layer Complete** - Detection + conflicts + templates (Phase 2)
3. **Multi-Language Support** - Python + Rust recipes functional (Phase 3)
4. **Production Ready** - Tests pass, docs complete, skill integrated (Phase 4)

**Effort Estimates:**

- Story 1-2 (CLI + Dry-run): M-L (moderate complexity, clear path)
- Story 3-5 (Intelligence): L-XL (requires design decisions, new patterns)
- Story 6-7 (Languages): M (follows established recipe pattern)
- Story 8-10 (Quality): L (comprehensive testing takes time)

**Total:** XL effort (10 stories, full-featured CLI tool)

---

## 8. Testing Strategy

### Unit Tests

**Command Tests:**
- Test each command's invoke() method
- Verify file existence checks
- Validate content generation
- Test error handling (permission denied, disk full)

**Recipe Tests:**
- Test ingredient composition
- Verify execution order
- Test rollback on failure (future)

**Example:**
```typescript
describe('AddDockerfile', () => {
  it('creates Dockerfile when none exists', async () => {
    const context = { targetDir: '/tmp/test', force: false };
    const cmd = new AddDockerfile(context);
    const result = await cmd.invoke();

    expect(result.success).toBe(true);
    expect(result.filePath).toBe('Dockerfile');
    expect(fileExists('/tmp/test/Dockerfile')).toBe(true);
  });

  it('skips creation if file exists without --force', async () => {
    // Setup: Create existing Dockerfile
    const context = { targetDir: '/tmp/test', force: false };
    const cmd = new AddDockerfile(context);
    await cmd.invoke(); // First run

    const result = await cmd.invoke(); // Second run
    expect(result.success).toBe(false);
    expect(result.message).toContain('already exists');
  });
});
```

### Integration Tests

**Recipe Integration:**
- Test full recipe execution (init docker)
- Verify all files created
- Test dry-run mode
- Test conflict detection

**CLI Integration:**
- Test Commander routing
- Test flag parsing (--force, --dry-run)
- Test error messages

### Idempotency Tests

**Automated Re-run:**
```typescript
describe('Idempotency', () => {
  it('running DockerRecipe twice produces same result', async () => {
    const context = { targetDir: '/tmp/test' };
    const recipe = new DockerRecipe(context);

    await recipe.execute(); // First run
    const hash1 = hashDirectory('/tmp/test');

    await recipe.execute(); // Second run
    const hash2 = hashDirectory('/tmp/test');

    expect(hash1).toBe(hash2); // Directory unchanged
  });
});
```

### Manual Testing Checklist

- [ ] Run each recipe on fresh project
- [ ] Re-run each recipe (verify no errors)
- [ ] Test dry-run for all recipes
- [ ] Test --force override
- [ ] Test conflict detection
- [ ] Test command generation
- [ ] Test Claude AI skill integration

---

## 9. Open Questions & Decisions

### Resolved

✓ **Use Bun instead of Node.js** - Aligns with user's ecosystem, faster execution
✓ **Commander.js for CLI** - Already integrated, familiar API
✓ **Command pattern for extensibility** - Proven architecture in codebase

### Pending Decisions

**Q1: Template Engine Choice**
- **Options:** Template literals (current) vs Handlebars vs EJS
- **Decision by:** Story 5 (Template Generation)
- **Impact:** Complexity of template syntax, learning curve

**Q2: Recipe Definition Format**
- **Options:** TypeScript classes (current) vs YAML config vs JSON
- **Decision by:** Story 4 (Conflict Detection)
- **Impact:** How users define custom recipes, extensibility

**Q3: Conflict Resolution Strategy**
- **Options:** Warn only (current) vs Auto-merge vs Interactive prompt
- **Decision by:** Story 4 (Conflict Detection)
- **Impact:** User experience during conflicts, safety guarantees

**Q4: Command Storage Location**
- **Options:** Project-local (/project/.pjangler/commands) vs Global (~/.pjangler/commands)
- **Decision by:** Story 5 (Template Generation)
- **Impact:** Sharing custom commands across projects

---

## 10. Success Metrics

### Quantitative

- **Setup Time:** Reduce from 30+ minutes to <2 minutes (measured via user testing)
- **Idempotency:** 100% of commands pass 10x re-run test
- **Test Coverage:** 90%+ line coverage for commands and recipes
- **CLI Completeness:** All 10 planned commands implemented
- **Language Support:** 4+ languages (Node, Python, Rust, Go)

### Qualitative

- **User Feedback:** "Pjangler saves me time on every new project"
- **AI Integration:** Claude Code executes commands without errors
- **Documentation:** Users can bootstrap projects without reading source code
- **Extensibility:** Users create custom commands successfully

---

## Appendices

### A. Command Class Template

```typescript
import { Command, InvokeResult, CommandContext } from './Command';

export class Add{FileName} extends Command {
  constructor(context: CommandContext) {
    super(context);
  }

  async invoke(): Promise<InvokeResult> {
    const filePath = "{fileName}";

    // Idempotency check
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: `⚠️  ${filePath} already exists (use --force to overwrite)`
      };
    }

    // Dry-run check
    if (this.context.dryRun) {
      return {
        success: true,
        message: `[DRY RUN] Would create ${filePath}`
      };
    }

    // Generate content
    const content = this.generateContent();

    // Write file
    this.writeFile(filePath, content);

    return {
      success: true,
      message: `✓ Created ${filePath}`,
      filePath
    };
  }

  private generateContent(): string {
    // Template logic here
    return `# ${this.context.projectType} configuration`;
  }
}
```

### B. Recipe Class Template

```typescript
import { Recipe } from './Recipe';
import { CommandContext } from '../commands/Command';
import { Add{File1} } from '../commands/Add{File1}';
import { Add{File2} } from '../commands/Add{File2}';

export class {Name}Recipe extends Recipe {
  constructor(context: CommandContext) {
    super(context);

    this.addIngredient(Add{File1})
        .addIngredient(Add{File2});
  }

  protected printNextSteps(): void {
    console.log("\n✅ {Name} subsystem initialized!");
    console.log("\nNext steps:");
    console.log("  1. Review generated files");
    console.log("  2. Run: {command}");
  }
}
```

### C. Project Type Detection Logic

```typescript
protected detectProjectType(): string {
  if (this.fileExists('package.json')) return 'node';
  if (this.fileExists('pyproject.toml')) return 'python';
  if (this.fileExists('Cargo.toml')) return 'rust';
  if (this.fileExists('go.mod')) return 'go';
  return 'unknown';
}
```

---

**Document Status:** Ready for Sprint Planning
**Next Review:** Sprint 1 Kickoff
