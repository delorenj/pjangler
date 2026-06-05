#!/usr/bin/env node
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/mcp-server.ts
import { resolve } from "node:path";
import { existsSync as existsSync5, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/commands/Command.ts
var Command = class {
  context;
  constructor(context) {
    this.context = context;
  }
  /**
   * Format message with [DRY RUN] prefix if in dry-run mode
   */
  formatMessage(message) {
    return this.context.dryRun ? `[DRY RUN] ${message}` : message;
  }
  fileExists(filePath) {
    const { existsSync: existsSync6 } = __require("fs");
    const { join: join7 } = __require("path");
    const fullPath = join7(this.context.targetDir, filePath);
    return existsSync6(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const { writeFileSync: writeFileSync2, mkdirSync: mkdirSync3 } = __require("fs");
    const { join: join7, dirname: dirname4 } = __require("path");
    const fullPath = join7(this.context.targetDir, filePath);
    const dir = dirname4(fullPath);
    mkdirSync3(dir, { recursive: true });
    writeFileSync2(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const { mkdirSync: mkdirSync3 } = __require("fs");
    const { join: join7 } = __require("path");
    const fullPath = join7(this.context.targetDir, dirPath);
    mkdirSync3(fullPath, { recursive: true });
  }
};

// src/recipes/Recipe.ts
var Recipe = class {
  context;
  ingredients = [];
  constructor(context) {
    this.context = context;
  }
  addIngredient(CommandClass) {
    this.ingredients.push(new CommandClass(this.context));
    return this;
  }
  async execute() {
    const dryRunPrefix = this.context.dryRun ? "[DRY RUN] " : "";
    console.log(`${dryRunPrefix}\u{1F680} Initializing ${this.constructor.name.replace("Recipe", "").toLowerCase()} subsystem...`);
    if (this.context.dryRun) {
      console.log("\u26A0\uFE0F  Dry-run mode: No files will be modified");
      console.log("");
    }
    for (const command of this.ingredients) {
      const result = await command.invoke();
      if (result.success) {
        console.log(result.message);
      } else {
        console.log(result.message);
      }
    }
    if (!this.context.dryRun) {
      this.printNextSteps();
    } else {
      console.log("");
      console.log("\u2713 Dry-run complete - no files were modified");
      console.log("  Remove --dry-run flag to apply changes");
    }
  }
};

// src/commands/AddMiseToml.ts
var AddMiseToml = class extends Command {
  async invoke() {
    const filePath = "mise.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  mise.toml already exists"),
        filePath
      };
    }
    const content = `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create mise.toml" : "\u2705 Created mise.toml"),
      filePath
    };
  }
};

// src/commands/AddDotenv.ts
var AddDotenv = class extends Command {
  async invoke() {
    const filePath = ".env";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .env already exists"),
        filePath
      };
    }
    const content = `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .env" : "\u2705 Created .env"),
      filePath
    };
  }
};

// src/commands/AddMiseTasksStructure.ts
var AddMiseTasksStructure = class extends Command {
  async invoke() {
    this.createDirectory(".mise/tasks/scripts");
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise directory structure" : "\u2705 Created .mise directory structure"),
      filePath: ".mise/tasks/scripts"
    };
  }
};

// src/commands/AddMiseBaseToml.ts
var AddMiseBaseToml = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/base.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/base.toml already exists"),
        filePath
      };
    }
    const content = `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "\u2705 Created .mise/tasks/base.toml"),
      filePath
    };
  }
};

// src/commands/AddMiseBaseScript.ts
var AddMiseBaseScript = class extends Command {
  async invoke() {
    const filePath = ".mise/tasks/scripts/base.py";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/tasks/scripts/base.py already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env python3
"""Base setup script"""
import os
import sys
from pathlib import Path

def main():
    print("\u{1F527} Setting up base environment...")

    dirs_to_create = ["logs", "temp", "data"]
    for dir_name in dirs_to_create:
        Path(dir_name).mkdir(exist_ok=True)
        print(f"  Created {dir_name}/ directory")

    print("  Base environment setup complete!")
    print("  Run 'mise run dev' to start development")

if __name__ == "__main__":
    main()
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/scripts/base.py" : "\u2705 Created .mise/tasks/scripts/base.py"),
      filePath
    };
  }
};

// src/recipes/MiseRecipe.ts
var MiseRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddMiseToml).addIngredient(AddDotenv).addIngredient(AddMiseTasksStructure).addIngredient(AddMiseBaseToml).addIngredient(AddMiseBaseScript);
  }
  printNextSteps() {
    console.log("\u{1F389} Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/commands/AddDockerfile.ts
var AddDockerfile = class extends Command {
  async invoke() {
    const filePath = "Dockerfile";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  Dockerfile already exists"),
        filePath
      };
    }
    const content = `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create Dockerfile" : "\u2705 Created Dockerfile"),
      filePath
    };
  }
};

// src/commands/AddDockerCompose.ts
var AddDockerCompose = class extends Command {
  async invoke() {
    const filePath = "docker-compose.yml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  docker-compose.yml already exists"),
        filePath
      };
    }
    const content = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create docker-compose.yml" : "\u2705 Created docker-compose.yml"),
      filePath
    };
  }
};

// src/commands/AddDockerignore.ts
var AddDockerignore = class extends Command {
  async invoke() {
    const filePath = ".dockerignore";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .dockerignore already exists"),
        filePath
      };
    }
    const content = `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .dockerignore" : "\u2705 Created .dockerignore"),
      filePath
    };
  }
};

// src/recipes/DockerRecipe.ts
var DockerRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddDockerfile).addIngredient(AddDockerCompose).addIngredient(AddDockerignore);
  }
  printNextSteps() {
    console.log("\u{1F389} Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
};

// src/commands/NodeCommands.ts
var AddPackageJson = class extends Command {
  async invoke() {
    const filePath = "package.json";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  package.json already exists",
        filePath
      };
    }
    const content = `{
  "name": "my-project",
  "version": "1.0.0",
  "description": "A new project",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created package.json",
      filePath
    };
  }
};
var AddReadme = class extends Command {
  async invoke() {
    const filePath = "README.md";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "\u26A0\uFE0F  README.md already exists",
        filePath
      };
    }
    const content = `# My Project

A new project initialized with pjangler.

## Getting Started

1. Install dependencies: \`mise install\`
2. Start development: \`mise run dev\`

## Project Structure

- \`mise.toml\` - Environment configuration
- \`.mise/tasks/\` - Task definitions
- \`src/\` - Source code
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "\u2705 Created README.md",
      filePath
    };
  }
};
var AddSrcDirectory = class extends Command {
  async invoke() {
    this.createDirectory("src");
    const indexJsPath = "src/index.js";
    const content = `console.log("Hello, World!");
`;
    this.writeFile(indexJsPath, content);
    return {
      success: true,
      message: "\u2705 Created src/ directory with index.js",
      filePath: "src/index.js"
    };
  }
};

// src/recipes/NodeRecipe.ts
var NodeRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddPackageJson).addIngredient(AddReadme).addIngredient(AddSrcDirectory);
  }
  printNextSteps() {
    console.log("\u{1F389} Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
};

// src/commands/hermes/EnsureTemplateConfig.ts
import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
function resolveTemplateConfigPath() {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "hermes-agent-template", "config.toml");
}
function detectHermesBin(home) {
  const candidates = [
    join(home, "code", "hermes-agent", "venv", "bin", "hermes"),
    join(home, "code", "hermes-agent", ".venv", "bin", "hermes"),
    join(home, ".local", "bin", "hermes")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
function renderHostConfig() {
  const home = homedir();
  const hermesBin = detectHermesBin(home);
  const hermesRepo = join(home, "code", "hermes-agent");
  const scaffoldDir = join(home, "code", "hermes-agent-template", "runtime-scaffold");
  const skillsDir = join(home, ".agents", "skills");
  return `# hermes-agent-template \u2014 host configuration
# Bootstrapped by \`pjangler config bootstrap\` for $HOME=${home} (platform=${platform()}).
#
# [fleet] paths below were derived from THIS machine. The identity values in
# [github]/[plane]/[bloodbank] are intentionally left to be confirmed before a
# CLOUD provision (\`pjangler hermes\` without --local); they are unused by the
# default local-only provision.
#
# Resolution precedence per value: env var > ~/.hermes/fleet.env > this file > fallback.

[fleet]
home = "~/.hermes"
hermes_bin = "${hermesBin}"
hermes_repo = "${hermesRepo}"
runtime_scaffold_dir = "${scaffoldDir}"
fleet_env = "~/.hermes/fleet.env"
registry_file = "~/.hermes/agents-registry.yaml"
canonical_skills_dir = "${skillsDir}"
symlinked_runtime_skills = []

[github]
# Owner of the per-agent runtime repos (creates <owner>/agent-hm-<repo>-<role>).
# REQUIRED before a cloud provision. Leave empty for local-only runs.
runtime_repo_owner = ""

[plane]
# Plane instance + workspace (one project per agent). Confirm before cloud provision.
base = "https://plane.delo.sh"
workspace = "33god"

[bloodbank]
# NATS endpoint the consumer connects to. For a remote fleet node, point this at
# the bloodbank host over Tailscale rather than localhost.
nats_host = "127.0.0.1"
nats_port = 4222
compose_dir = "~/code/33GOD/bloodbank"
`;
}
var EnsureTemplateConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();
    const exists = existsSync(path);
    if (exists && !force) {
      console.log(`\u2713 Config present: ${path}`);
      return { success: true, message: "" };
    }
    if (ctx.dryRun) {
      console.log(`[DRY RUN] Would ${exists ? "overwrite" : "create"} config: ${path}`);
      return { success: true, message: "" };
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderHostConfig());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `\u2717 Failed to write ${path}: ${msg}` };
    }
    console.log(`\u2713 Bootstrapped config: ${path}`);
    console.log("  Review [github].runtime_repo_owner + [plane] + [bloodbank] before a cloud provision.");
    return { success: true, message: "" };
  }
};

// src/commands/hermes/PromptForAgentConfig.ts
import { basename, join as join2 } from "node:path";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";

// src/commands/hermes/types.ts
var HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";
var SOUL_TONES = ["direct", "playful", "formal", "terse"];
var ROLE_CHOICES = [
  { value: "pm", label: "Project Manager (pm)", hint: "triage, planning, ticket authorship" },
  {
    value: "scrum-master",
    label: "Scrum Master (Ticket Sentinel)",
    hint: "continuous ticket sentinel + autonomous delegated review"
  },
  { value: "dev", label: "Developer (dev)", hint: "implements tickets" },
  { value: "review", label: "Reviewer (review)", hint: "adversarial code review" },
  { value: "ops", label: "Ops (ops)", hint: "deploy / infra" },
  { value: "qa", label: "QA (qa)", hint: "test authorship + verification" }
];
var TICKET_PROVIDERS = [
  { value: "plane", label: "Plane", hint: "self-hosted at plane.delo.sh (default)" },
  { value: "linear", label: "Linear", hint: "team board (created in Linear UI)" },
  { value: "trello", label: "Trello", hint: "board = project" }
];
function deriveAgentId(repo, role) {
  return `${repo}-${role}`.toLowerCase();
}
function deriveProfileName(repo, role) {
  return deriveAgentId(repo, role);
}

// src/commands/hermes/PromptForAgentConfig.ts
function detectTicketProvider(targetDir) {
  try {
    const t = JSON.parse(readFileSync(join2(targetDir, ".project.json"), "utf8"))?.ticket_provider?.type;
    return t === "plane" || t === "linear" || t === "trello" ? t : void 0;
  } catch {
    return void 0;
  }
}
var PromptForAgentConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    const defaultRepo = basename(ctx.targetDir).toLowerCase();
    const defaultRole = "pm";
    if (ctx.yes) {
      ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
      ctx.role ??= defaultRole;
      ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
      ctx.soulTone ??= "direct";
      ctx.modelProvider ??= "";
      ctx.modelName ??= "";
      ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
      ctx.withScrumMaster ??= false;
      ctx.skipTelegram ??= true;
      ctx.skipEmail ??= true;
      ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
      ctx.profileName = deriveProfileName(ctx.targetRepo, ctx.role);
      return {
        success: true,
        message: this.formatMessage(
          `\u2713 Non-interactive mode \u2014 using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        )
      };
    }
    p.intro("\u2695  hermes-agent  \xB7  add a new agent role to this repo");
    if (!ctx.targetRepo) {
      const answer = await p.text({
        message: "Target repo name",
        placeholder: defaultRepo,
        initialValue: defaultRepo,
        validate: (v) => v && v.trim() ? void 0 : "required"
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.targetRepo = String(answer).trim().toLowerCase();
    }
    if (!ctx.role) {
      const answer = await p.select({
        message: "Role",
        options: ROLE_CHOICES.map((r) => ({ value: r.value, label: r.label, hint: r.hint })),
        initialValue: defaultRole
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.role = String(answer).trim();
    }
    if (ctx.ticketProvider === void 0) {
      const detected = detectTicketProvider(ctx.targetDir);
      const answer = await p.select({
        message: "Ticket board provider",
        options: TICKET_PROVIDERS.map((t) => ({
          value: t.value,
          label: t.label,
          hint: t.value === detected ? `${t.hint} \u2014 current .project.json` : t.hint
        })),
        initialValue: detected ?? "plane"
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.ticketProvider = answer;
    }
    if (ctx.role === "pm" && ctx.withScrumMaster === void 0) {
      const answer = await p.confirm({
        message: "Also provision the paired Scrum Master (Ticket Sentinel) for this repo?",
        initialValue: true
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.withScrumMaster = answer === true;
    }
    if (!ctx.agentPurpose) {
      const answer = await p.text({
        message: "One-line purpose",
        placeholder: `${ctx.role} agent for ${ctx.targetRepo}`,
        initialValue: `${ctx.role} agent for ${ctx.targetRepo}`
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.agentPurpose = String(answer).trim();
    }
    if (!ctx.soulTone) {
      const answer = await p.select({
        message: "Personality tone",
        options: SOUL_TONES.map((t) => ({
          value: t,
          label: t,
          hint: t === "direct" ? "decision-forward, no preamble (default)" : t === "terse" ? "minimum words, conclusion-first" : t === "playful" ? "warm, mildly funny" : "precise, structured"
        })),
        initialValue: "direct"
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.soulTone = answer;
    }
    if (ctx.modelProvider === void 0) {
      const answer = await p.text({
        message: "Provider override (empty = inherit shared default profile)",
        placeholder: ""
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.modelProvider = String(answer).trim();
    }
    if (ctx.modelName === void 0) {
      const answer = await p.text({
        message: "Model name override (empty = inherit shared default profile)",
        placeholder: ""
      });
      if (p.isCancel(answer)) return this.cancelled();
      ctx.modelName = String(answer).trim();
    }
    if (ctx.skipTelegram === void 0) {
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${ctx.targetRepo}_${ctx.role}_bot) now?`,
        initialValue: true
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }
    if (ctx.skipEmail === void 0) {
      const wire = await p.confirm({
        message: `Provision the delo.sh email address (${ctx.targetRepo}-${ctx.role}@delo.sh) now?`,
        initialValue: true
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipEmail = !wire;
    }
    ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
    ctx.profileName = deriveProfileName(ctx.targetRepo, ctx.role);
    return {
      success: true,
      message: this.formatMessage(
        `\u2713 Collected agent config  (agent_id=${ctx.agentId}, profile=${ctx.profileName})`
      )
    };
  }
  cancelled() {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
};

// src/commands/hermes/RunCopierTemplate.ts
import { spawnSync } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { join as join3, dirname as dirname2 } from "node:path";
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p2 from "@clack/prompts";
function resolveVendoredTemplate(name) {
  let dir;
  try {
    dir = dirname2(fileURLToPath(import.meta.url));
  } catch {
    return void 0;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join3(dir, "templates", name);
    if (existsSync2(join3(candidate, "copier.yml"))) return candidate;
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
var RunCopierTemplate = class extends Command {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentPurpose, soulTone, modelProvider, modelName } = ctx;
    const ticketProvider = ctx.ticketProvider ?? "plane";
    const profileName = ctx.profileName ?? (targetRepo && role ? deriveProfileName(targetRepo, role) : void 0);
    const withScrumMaster = role === "pm" && ctx.withScrumMaster === true;
    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)"
      };
    }
    const roleDir = join3(ctx.targetDir, "agents", "hermes", role);
    ctx.roleDir = roleDir;
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${role}`;
    const which = spawnSync("which", ["copier"], { encoding: "utf8" });
    if (which.status !== 0) {
      return {
        success: false,
        message: "\u2717 copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`"
      };
    }
    if (existsSync2(join3(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await p2.confirm({
          message: `${role}/role.yaml already exists \u2014 re-render with --overwrite?`,
          initialValue: false
        });
        if (p2.isCancel(proceed) || !proceed) {
          return {
            success: false,
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`
          };
        }
        ctx.force = true;
      }
    }
    const env = {
      ...process.env,
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      // We DO want copier to run runtime-repo + plane + bloodbank + systemd.
      SKIP_RUNTIME_REPO: ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: ctx.skipBloodbank ? "1" : "0",
      SKIP_SYSTEMD: ctx.skipSystemd ? "1" : "0"
    };
    const LOCAL_TEMPLATE = join3(homedir2(), "code", "hermes-agent-template");
    const vendored = resolveVendoredTemplate("hermes-agent");
    const templateSrc = process.env.PJANGLER_HERMES_TEMPLATE || vendored || (existsSync2(join3(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);
    const args = [
      "copy",
      templateSrc,
      roleDir,
      "--data",
      `target_repo=${targetRepo}`,
      "--data",
      `role=${role}`,
      "--data",
      `agent_purpose=${agentPurpose ?? ""}`,
      "--data",
      `model_provider=${modelProvider ?? ""}`,
      "--data",
      `model_name=${modelName ?? ""}`,
      "--data",
      `profile_name=${profileName ?? ""}`,
      "--data",
      `soul_tone=${soulTone ?? "direct"}`,
      "--data",
      `ticket_provider=${ticketProvider}`,
      "--data",
      `with_scrum_master=${withScrumMaster}`,
      "--trust",
      "--vcs-ref=HEAD"
    ];
    if (ctx.force) args.push("--overwrite");
    if (ctx.dryRun) {
      return {
        success: true,
        message: this.formatMessage(`Would run: copier ${args.join(" ")}`)
      };
    }
    mkdirSync2(join3(ctx.targetDir, "agents", "hermes"), { recursive: true });
    const spinner4 = p2.spinner();
    spinner4.start(`Running copier copy  (target: agents/hermes/${role})`);
    const result = spawnSync("copier", args, {
      stdio: "inherit",
      // pass the interactive output through; copier prints its own progress
      env,
      cwd: ctx.targetDir
    });
    spinner4.stop(result.status === 0 ? "\u2713 copier run complete" : "\u2717 copier failed");
    if (result.status !== 0) {
      return {
        success: false,
        message: `\u2717 copier exited with status ${result.status}.  Check the output above; re-run with the same flags after fixing.`
      };
    }
    return {
      success: true,
      message: `\u2713 Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`
    };
  }
};

// src/commands/hermes/WireTelegram.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { join as join4 } from "node:path";
import { existsSync as existsSync3, unlinkSync } from "node:fs";
import * as p3 from "@clack/prompts";
var WireTelegram = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipTelegram) {
      return { success: true, message: "\u2192 Telegram wire-up skipped" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }
    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;
    const vaultTitle = `Telegram-Hermes-${targetRepo.toLowerCase()}-${role.toLowerCase()}`;
    const vaultRef = `op://DeLoSecrets/${vaultTitle}/token`;
    let token = process.env.TELEGRAM_BOT_TOKEN;
    let source = token ? "env" : null;
    if (!token) {
      const tryOp = spawnSync2("op", ["read", vaultRef], { encoding: "utf8" });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
        source = "op";
        p3.log.info(`\u2713 Telegram token loaded from ${vaultRef}`);
      }
    }
    if (!token) {
      p3.log.step("BotFather steps");
      p3.log.info(
        [
          "  1. Open Telegram, message @BotFather",
          "  2. /newbot",
          `  3. Display name:   ${displayName}`,
          `  4. Username:       ${botHandle}   (must end in _bot)`,
          "  5. Copy the HTTP API token from the reply.",
          "  6. /setjoingroups Disable",
          "  7. /setprivacy    Disable"
        ].join("\n")
      );
      const tokenAnswer = await p3.password({
        message: `Paste the bot token for @${botHandle}`,
        mask: "\u2022",
        validate: (v) => {
          const s = String(v ?? "").trim();
          if (!s) return "required";
          if (!/^[0-9]+:.+/.test(s)) return "expected '<digits>:<secret>' shape";
        }
      });
      if (p3.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Telegram skipped (no token).  Re-run later." };
      }
      token = String(tokenAnswer).trim();
      source = "prompt";
      const persist = await p3.confirm({
        message: `Save to ${vaultRef} for next time?`,
        initialValue: true
      });
      if (!p3.isCancel(persist) && persist) {
        const create = spawnSync2(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            `--title=${vaultTitle}`,
            `token=${token}`,
            `bot_handle=${botHandle}`
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p3.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const allowedAnswer = await p3.text({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v) => /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v).trim()) ? void 0 : "comma-separated numeric ids"
    });
    if (p3.isCancel(allowedAnswer)) {
      return { success: false, message: "\u2717 Aborted; Telegram step deferred." };
    }
    const script = join4(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync3(script)) {
      return {
        success: false,
        message: `\u2717 ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`
      };
    }
    const marker = join4(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync3(marker)) unlinkSync(marker);
    const spinner4 = p3.spinner();
    spinner4.start("Verifying token + wiring profile");
    const result = spawnSync2("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim()
      },
      cwd: roleDir
    });
    spinner4.stop(result.status === 0 ? "\u2713 Telegram wired" : "\u2717 Telegram step failed");
    if (result.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }
    const sourceLabel = source === "env" ? " (token: env)" : source === "op" ? " (token: op)" : "";
    return { success: true, message: `\u2713 Telegram: @${botHandle} ready${sourceLabel}` };
  }
};
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// src/commands/hermes/WireEmail.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { join as join5 } from "node:path";
import { existsSync as existsSync4, unlinkSync as unlinkSync2 } from "node:fs";
import * as p4 from "@clack/prompts";
var WireEmail = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipEmail) {
      return { success: true, message: "\u2192 Email wire-up skipped" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join5(roleDir, ".scripts", "50-email.sh");
    if (!existsSync4(script)) {
      return { success: false, message: `\u2717 ${script} not found` };
    }
    let token = process.env.CF_EMAIL_ROUTING_TOKEN;
    if (!token) {
      const tryOp = spawnSync3(
        "op",
        ["read", "op://DeLoSecrets/Cloudflare-EmailRouting/token"],
        { encoding: "utf8" }
      );
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
      }
    }
    if (!token) {
      p4.log.warn("CF Email Routing token not found.  Required scopes:");
      p4.log.info(
        [
          "  Zone (delo.sh)  \u2192  Email Routing Rules     : Edit",
          "  Zone (delo.sh)  \u2192  Email Routing Settings  : Read",
          "  Account         \u2192  Email Routing Addresses : Read",
          "Create at: https://dash.cloudflare.com/profile/api-tokens"
        ].join("\n")
      );
      const provideNow = await p4.confirm({
        message: "Paste a token now?  (skipping leaves email unwired until you re-run.)",
        initialValue: false
      });
      if (p4.isCancel(provideNow) || !provideNow) {
        return { success: true, message: "\u2192 Email skipped (no token).  Re-run later." };
      }
      const tokenAnswer = await p4.password({
        message: "CF token (will be passed via env, not stored)",
        mask: "\u2022",
        validate: (v) => String(v ?? "").trim() ? void 0 : "required"
      });
      if (p4.isCancel(tokenAnswer)) {
        return { success: true, message: "\u2192 Email skipped (cancelled)" };
      }
      token = String(tokenAnswer).trim();
      const persist = await p4.confirm({
        message: "Save to op://DeLoSecrets/Cloudflare-EmailRouting/token for next time?",
        initialValue: true
      });
      if (!p4.isCancel(persist) && persist) {
        const create = spawnSync3(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            "--title=Cloudflare-EmailRouting",
            `token=${token}`
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p4.log.warn("Could not store in 1Password \u2014 token is still set for this run.");
        }
      }
    }
    const marker = join5(roleDir, ".scripts", ".done-50-email");
    if (existsSync4(marker)) unlinkSync2(marker);
    const spinner4 = p4.spinner();
    spinner4.start("Creating Cloudflare Email Routing rule");
    const result = spawnSync3("bash", [script], {
      stdio: "inherit",
      env: { ...process.env, SKIP_EMAIL: "0", CF_EMAIL_ROUTING_TOKEN: token },
      cwd: roleDir
    });
    spinner4.stop(result.status === 0 ? "\u2713 Email rule created" : "\u2717 Email step failed");
    if (result.status !== 0) {
      return { success: false, message: "Email rule creation failed.  See output above." };
    }
    return {
      success: true,
      message: `\u2713 Email: ${targetRepo}-${role}@delo.sh  \u2192  jaradd@gmail.com`
    };
  }
};

// src/commands/hermes/PrintHermesSummary.ts
import * as p5 from "@clack/prompts";
var PrintHermesSummary = class extends Command {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentId, runtimeRepo, skipTelegram, skipEmail } = ctx;
    const botHandle = `${targetRepo?.toLowerCase().replace(/-/g, "_")}_${role?.toLowerCase()}_bot`;
    const email = `${targetRepo}-${role}@delo.sh`;
    const gw = `hermes-${agentId}-gateway.service`;
    const csm = `hermes-${agentId}-consumer.service`;
    const ckpt = `hermes-${agentId}-checkpoint.timer`;
    const lines = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    lines.push(`email        ${email}${skipEmail ? "   (NOT yet wired)" : ""}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${csm}`);
    lines.push(`  systemctl --user start ${ckpt}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram || skipEmail) {
      lines.push("");
      lines.push("Deferred \u2014 re-run pjangler hermes-agent without --yes (or with explicit flags):");
      if (skipTelegram) lines.push("  pjangler hermes-agent --skip-telegram=false   # wire just telegram");
      if (skipEmail) lines.push("  pjangler hermes-agent --skip-email=false      # wire just email");
    }
    p5.note(lines.join("\n"), `Provisioned ${agentId}`);
    p5.outro("Done.");
    return { success: true, message: "" };
  }
};

// src/recipes/HermesAgentRecipe.ts
var HermesAgentRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(EnsureTemplateConfig).addIngredient(PromptForAgentConfig).addIngredient(RunCopierTemplate).addIngredient(WireTelegram).addIngredient(WireEmail).addIngredient(PrintHermesSummary);
  }
  // Override execute() to suppress the base class's per-command logging since
  // our commands already render their own UI via @clack/prompts.
  async execute() {
    for (const command of this.ingredients) {
      const result = await command.invoke();
      if (!result.success && result.message.startsWith("\u2717")) {
        console.error(result.message);
        return;
      }
      if (result.message && !result.message.startsWith("\u2713 Collected")) {
        if (result.message.startsWith("\u2192") || result.message.startsWith("\u2713 Provisioned")) {
          console.log(result.message);
        }
      }
    }
  }
  printNextSteps() {
  }
};

// src/utils/registry.ts
var RECIPE_REGISTRY = {
  mise: {
    name: "mise",
    description: "Mise task runner and environment setup",
    class: MiseRecipe,
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript"]
  },
  docker: {
    name: "docker",
    description: "Docker containerization setup",
    class: DockerRecipe,
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"]
  },
  node: {
    name: "node",
    description: "Node.js project template",
    class: NodeRecipe,
    commands: ["NodeCommands"]
    // Placeholder - actual commands in NodeCommands.ts
  },
  "hermes-agent": {
    name: "hermes-agent",
    description: "Add a Hermes agent role to this repo (copier + BotFather + CF email + submodule)",
    class: HermesAgentRecipe,
    commands: [
      "EnsureTemplateConfig",
      "PromptForAgentConfig",
      "RunCopierTemplate",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary"
    ]
  }
};
var COMMAND_REGISTRY = {
  AddDockerfile: {
    name: "AddDockerfile",
    description: "Create Dockerfile for containerization",
    group: "docker",
    class: AddDockerfile
  },
  AddDockerCompose: {
    name: "AddDockerCompose",
    description: "Create docker-compose.yml for multi-service setup",
    group: "docker",
    class: AddDockerCompose
  },
  AddDockerignore: {
    name: "AddDockerignore",
    description: "Create .dockerignore file",
    group: "docker",
    class: AddDockerignore
  },
  AddMiseToml: {
    name: "AddMiseToml",
    description: "Create mise.toml for version management",
    group: "mise",
    class: AddMiseToml
  },
  AddMiseBaseToml: {
    name: "AddMiseBaseToml",
    description: "Create base mise configuration",
    group: "mise",
    class: AddMiseBaseToml
  },
  AddMiseTasksStructure: {
    name: "AddMiseTasksStructure",
    description: "Create .mise/tasks directory structure",
    group: "mise",
    class: AddMiseTasksStructure
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  }
};
function getRecipeNames() {
  return Object.keys(RECIPE_REGISTRY);
}
function getRecipeInfo(name) {
  return RECIPE_REGISTRY[name] || null;
}
function createRecipe(name, context) {
  const info = getRecipeInfo(name);
  if (!info) return null;
  return new info.class(context);
}

// src/utils/version.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var PJANGLER_VERSION = (() => {
  try {
    let dir = dirname3(fileURLToPath2(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync2(join6(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname3(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return "0.0.0";
})();

// src/mcp-server.ts
var server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION
});
function resolveTargetDir(targetDir) {
  const dir = resolve(targetDir ?? process.cwd());
  if (!existsSync5(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}
async function runRecipeWithCapture(recipeName, context) {
  const recipe = createRecipe(recipeName, context);
  if (!recipe) {
    return {
      success: false,
      logs: [],
      errors: [`Unknown recipe: ${recipeName}. Available: ${getRecipeNames().join(", ")}`]
    };
  }
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await recipe.execute();
    const combined = [...logs, ...errors].join("\n");
    const success = !combined.match(/(^|\n)✗/);
    return { success, logs, errors };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { success: false, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes and commands exposed by pjangler.",
    inputSchema: {}
  },
  async () => {
    const payload = {
      recipes: Object.values(RECIPE_REGISTRY).map((r) => ({
        name: r.name,
        description: r.description,
        commands: r.commands
      })),
      commands: Object.values(COMMAND_REGISTRY).map((c) => ({
        name: c.name,
        description: c.description,
        group: c.group
      }))
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    };
  }
);
server.registerTool(
  "pjangler_describe_recipe",
  {
    title: "Describe recipe",
    description: "Returns metadata for a specific pjangler recipe.",
    inputSchema: {
      recipe: z.string()
    }
  },
  async ({ recipe }) => {
    const info = getRecipeInfo(recipe);
    if (!info) {
      return {
        isError: true,
        content: [{ type: "text", text: `Recipe not found: ${recipe}` }]
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: info.name,
              description: info.description,
              commands: info.commands
            },
            null,
            2
          )
        }
      ]
    };
  }
);
server.registerTool(
  "pjangler_run_recipe",
  {
    title: "Run recipe",
    description: "Executes any pjangler recipe against a target directory.",
    inputSchema: {
      recipe: z.enum(getRecipeNames()),
      targetDir: z.string().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional()
    }
  },
  async ({ recipe, targetDir, force, dryRun }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const context = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: dryRun ?? false
      };
      const result = await runRecipeWithCapture(recipe, context);
      return {
        isError: !result.success,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                recipe,
                targetDir: resolvedTarget,
                logs: result.logs,
                errors: result.errors
              },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
      };
    }
  }
);
server.registerTool(
  "pjangler_deploy_hermes_agent",
  {
    title: "Deploy Hermes agent",
    description: "Provision a Hermes agent role with an inherited named profile and optional integrations (Telegram, email, runtime repo, Plane, Bloodbank, systemd).",
    inputSchema: {
      targetDir: z.string(),
      targetRepo: z.string(),
      role: z.string(),
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      skipTelegram: z.boolean().optional(),
      skipEmail: z.boolean().optional(),
      skipRuntimeRepo: z.boolean().optional(),
      skipPlane: z.boolean().optional(),
      skipBloodbank: z.boolean().optional(),
      skipSystemd: z.boolean().optional()
    }
  },
  async (input) => {
    try {
      const resolvedTarget = resolveTargetDir(input.targetDir);
      const context = {
        targetDir: resolvedTarget,
        yes: true,
        targetRepo: input.targetRepo,
        role: input.role,
        agentPurpose: input.agentPurpose,
        soulTone: input.soulTone,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        force: input.force ?? false,
        dryRun: input.dryRun ?? false,
        skipTelegram: input.skipTelegram ?? true,
        skipEmail: input.skipEmail ?? true,
        skipRuntimeRepo: input.skipRuntimeRepo ?? false,
        skipPlane: input.skipPlane ?? false,
        skipBloodbank: input.skipBloodbank ?? false,
        skipSystemd: input.skipSystemd ?? false
      };
      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                recipe: "hermes-agent",
                targetDir: resolvedTarget,
                context: {
                  targetRepo: context.targetRepo,
                  role: context.role,
                  dryRun: context.dryRun,
                  force: context.force,
                  skipTelegram: context.skipTelegram,
                  skipEmail: context.skipEmail,
                  skipRuntimeRepo: context.skipRuntimeRepo,
                  skipPlane: context.skipPlane,
                  skipBloodbank: context.skipBloodbank,
                  skipSystemd: context.skipSystemd
                },
                logs: result.logs,
                errors: result.errors
              },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
      };
    }
  }
);
var transport = new StdioServerTransport();
await server.connect(transport);
