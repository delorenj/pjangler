#!/usr/bin/env node
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/mcp-server.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync7, mkdirSync as mkdirSync5, statSync } from "node:fs";
import { basename as basename2, dirname as dirname6, join as join9, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
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
    const { existsSync: existsSync8 } = __require("fs");
    const { join: join10 } = __require("path");
    const fullPath = join10(this.context.targetDir, filePath);
    return existsSync8(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const { writeFileSync: writeFileSync4, mkdirSync: mkdirSync6 } = __require("fs");
    const { join: join10, dirname: dirname7 } = __require("path");
    const fullPath = join10(this.context.targetDir, filePath);
    const dir = dirname7(fullPath);
    mkdirSync6(dir, { recursive: true });
    writeFileSync4(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const { mkdirSync: mkdirSync6 } = __require("fs");
    const { join: join10 } = __require("path");
    const fullPath = join10(this.context.targetDir, dirPath);
    mkdirSync6(fullPath, { recursive: true });
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

// src/commands/AgentHooksCommands.ts
import { homedir as homedir3 } from "node:os";
import { join as join6, dirname as dirname3 } from "node:path";
import { existsSync as existsSync5, cpSync, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function resolveTemplateRoot() {
  const candidates = [];
  if (process.env.PJANGLER_COMMONPROJECT_TEMPLATE) {
    candidates.push(process.env.PJANGLER_COMMONPROJECT_TEMPLATE);
  }
  try {
    let dir = dirname3(fileURLToPath2(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join6(dir, "templates", "commonproject", "template"));
      const parent = dirname3(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  candidates.push(join6(homedir3(), "code", "pjangler", "templates", "commonproject", "template"));
  for (const c of candidates) {
    if (existsSync5(join6(c, ".agents", "hooks", "hooks.master.json"))) return c;
  }
  throw new Error(
    "Could not locate the CommonProject template. Set PJANGLER_COMMONPROJECT_TEMPLATE to <repo>/templates/commonproject/template."
  );
}
var CopyAgentHooksTree = class extends Command {
  async invoke() {
    let templateRoot;
    try {
      templateRoot = resolveTemplateRoot();
    } catch (e) {
      return { success: false, message: `\u26A0\uFE0F  ${e.message}` };
    }
    const items = [
      { rel: ".agents/hooks", dir: true },
      { rel: ".agents/local.example.json", dir: false },
      { rel: ".mise/scripts/link-project-skills-to-clis.sh", dir: false },
      { rel: ".mise/scripts/unlink-project-skills-from-clis.sh", dir: false },
      { rel: ".mise/scripts/hindsight-setup.sh", dir: false }
    ];
    const created = [];
    const skipped = [];
    for (const { rel, dir } of items) {
      const src = join6(templateRoot, rel);
      const dest = join6(this.context.targetDir, rel);
      if (!existsSync5(src)) continue;
      if (existsSync5(dest) && !this.context.force) {
        skipped.push(rel);
        continue;
      }
      if (!this.context.dryRun) {
        mkdirSync3(dirname3(dest), { recursive: true });
        cpSync(src, dest, { recursive: dir, force: true });
      }
      created.push(rel);
    }
    const verb = this.context.dryRun ? "Would copy" : "Copied";
    const tail = skipped.length ? ` (${skipped.length} already present \u2014 use --force to overwrite)` : "";
    return {
      success: created.length > 0,
      message: this.formatMessage(`\u2705 ${verb} ${created.length} agent-hooks path(s)${tail}`)
    };
  }
};
var WireMiseAgentHooks = class _WireMiseAgentHooks extends Command {
  static MARKER = "# pjangler:agent-hooks";
  static CR = "{{config_root}}";
  // mise's own runtime var — emitted literally
  async invoke() {
    const misePath = join6(this.context.targetDir, "mise.toml");
    if (!existsSync5(misePath)) {
      return {
        success: false,
        message: "\u26A0\uFE0F  No mise.toml found \u2014 run `pjangler init mise` first, then re-run."
      };
    }
    let content = readFileSync2(misePath, "utf8");
    if (content.includes(_WireMiseAgentHooks.MARKER)) {
      return { success: true, message: this.formatMessage("\u2713 mise.toml already wired for agent-hooks") };
    }
    const cr = _WireMiseAgentHooks.CR;
    const enterAdds = [
      `  "${cr}/.mise/scripts/link-project-skills-to-clis.sh",`,
      `  "${cr}/.agents/hooks/sync.py --install --quiet",`
    ].join("\n");
    const leaveBlock = [
      "leave = [",
      `  "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh",`,
      `  "${cr}/.agents/hooks/sync.py --uninstall --quiet",`,
      "]"
    ].join("\n");
    let wiredHooks = false;
    const enterRe = /(enter\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
    if (enterRe.test(content)) {
      content = content.replace(enterRe, (_m, head, close) => {
        const sep = /[,[]\s*$/.test(head) ? "" : ",";
        return `${head}${sep}
${enterAdds}${close}`;
      });
      const leaveRe = /(leave\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
      if (leaveRe.test(content)) {
        content = content.replace(leaveRe, (_m, head, close) => {
          const sep = /[,[]\s*$/.test(head) ? "" : ",";
          return `${head}${sep}
  "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh",
  "${cr}/.agents/hooks/sync.py --uninstall --quiet",${close}`;
        });
      } else {
        content = content.replace(enterRe, (m) => `${m}
${leaveBlock}`);
      }
      wiredHooks = true;
    }
    const appended = [
      "",
      _WireMiseAgentHooks.MARKER + " (generated \u2014 see .agents/hooks/README.md)",
      "[[watch_files]]",
      'patterns = [".agents/hooks/hooks.master.json"]',
      'task = "hooks-sync"',
      "",
      "[tasks.hooks-sync]",
      'description = "Fan out hooks.master.json to each agent CLI (claude/codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --install"`,
      "",
      "[tasks.hooks-check]",
      'description = "Drift gate: verify generated hook configs match hooks.master.json"',
      `run = "${cr}/.agents/hooks/sync.py --check"`,
      "",
      "[tasks.hooks-uninstall]",
      'description = "Remove per-user agent-hook injections (codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --uninstall"`,
      "",
      "[tasks.link-project-skills-to-clis]",
      'description = "Fan .agents/skills out to each agent CLI (honors local.json)"',
      `run = "${cr}/.mise/scripts/link-project-skills-to-clis.sh"`,
      "",
      "[tasks.unlink-project-skills-from-clis]",
      'description = "Remove project skill symlinks from shared per-CLI dirs"',
      `run = "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh"`,
      "",
      "[tasks.skills-relink]",
      'description = "Re-fan the project skill set to all CLIs"',
      `run = "${cr}/.mise/scripts/link-project-skills-to-clis.sh"`,
      "",
      "[tasks.hindsight-setup]",
      `description = "Provision this dev's shared project Hindsight key from 1Password into .env"`,
      `run = "${cr}/.mise/scripts/hindsight-setup.sh"`,
      "",
      _WireMiseAgentHooks.MARKER + ":end",
      ""
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;
    if (!this.context.dryRun) writeFileSync2(misePath, content);
    if (wiredHooks) {
      return { success: true, message: this.formatMessage("\u2705 Wired mise.toml ([hooks] enter/leave + tasks)") };
    }
    return {
      success: true,
      message: this.formatMessage(
        `\u2705 Added agent-hooks tasks to mise.toml.
   \u26A0\uFE0F  Could not find a [hooks].enter array to extend \u2014 add these to your [hooks] block manually:
     enter += "${cr}/.mise/scripts/link-project-skills-to-clis.sh", "${cr}/.agents/hooks/sync.py --install --quiet"
     leave += "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh", "${cr}/.agents/hooks/sync.py --uninstall --quiet"`
      )
    };
  }
};

// src/recipes/AgentHooksRecipe.ts
var AgentHooksRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(CopyAgentHooksTree).addIngredient(WireMiseAgentHooks);
  }
  printNextSteps() {
    console.log("\u{1FA9D} Agent-hooks layer installed!");
    console.log("   Next steps:");
    console.log("   1. mise run hooks-sync   # generate .claude/settings.json + inject codex/kimi/hermes");
    console.log("   2. git add .claude/settings.json .agents/hooks && commit (codex/kimi/hermes are per-dev)");
    console.log("   3. mise run hindsight-setup   # set HINDSIGHT_OP_KEY_REF to your 1Password item first");
    console.log(`   4. If you run a global agent system: echo '{"skills":{"defer_to_global":true}}' > .agents/local.json`);
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
  },
  "agent-hooks": {
    name: "agent-hooks",
    description: "Retrofit the project-scoped agent-hooks + skill fan-out layer (Claude/Codex/Kimi/Hermes hooks via mise enter/leave)",
    class: AgentHooksRecipe,
    commands: ["CopyAgentHooksTree", "WireMiseAgentHooks"]
  }
};
var COMMAND_REGISTRY = {
  CopyAgentHooksTree: {
    name: "CopyAgentHooksTree",
    description: "Copy the generic agent-hooks tree (hooks SSOT + sync engine + scripts) from the CommonProject template",
    group: "agent-hooks",
    class: CopyAgentHooksTree
  },
  WireMiseAgentHooks: {
    name: "WireMiseAgentHooks",
    description: "Merge agent-hooks enter/leave + tasks into an existing mise.toml (idempotent)",
    group: "agent-hooks",
    class: WireMiseAgentHooks
  },
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
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname4, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var PJANGLER_VERSION = (() => {
  try {
    let dir = dirname4(fileURLToPath3(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync3(join7(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname4(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return "0.0.0";
})();

// src/parity/index.ts
import { existsSync as existsSync6, lstatSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3, chmodSync, copyFileSync } from "node:fs";
import { dirname as dirname5, join as join8, relative, resolve } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { homedir as homedir4 } from "node:os";
import { spawnSync as spawnSync4 } from "node:child_process";
var LINK_AGENTFILES_BLOCK = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.
[hooks]
enter = [
  "{{config_root}}/.mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env",
]

[[watch_files]]
patterns = ["AGENTS.md"]
task = "link-agentfiles"

[tasks.link-agentfiles]
description = "Symlink all agent files to AGENTS.md"
run = "{{config_root}}/.mise/scripts/link-agentfiles.sh"`;
var VERSIONING_BLOCK = `# >>> mise-versioning >>>  (managed block \u2014 do not edit by hand; re-run init to update)
[tasks."version"]
description = "Print the current version (vX.Y.Z)"
run = "{{config_root}}/.mise/scripts/versioning.sh current"

[tasks."version:bump"]
description = "Bump patch version: vX.Y.Z -> vX.Y.(Z+1)"
alias = "version:bump-patch"
run = "{{config_root}}/.mise/scripts/versioning.sh bump patch"

[tasks."version:bump-minor"]
description = "Bump minor version: vX.Y.Z -> vX.(Y+1).0"
run = "{{config_root}}/.mise/scripts/versioning.sh bump minor"

[tasks."version:bump-major"]
description = "Bump major version: vX.Y.Z -> v(X+1).0.0"
run = "{{config_root}}/.mise/scripts/versioning.sh bump major"

[tasks."version:check"]
description = "Verify every versioned file is in parity"
run = "{{config_root}}/.mise/scripts/versioning.sh check"

[tasks."version:sync"]
description = "Force every versioned file up to the highest version"
run = "{{config_root}}/.mise/scripts/versioning.sh sync"
# <<< mise-versioning <<<`;
function resolvePjanglerRoot() {
  let dir = dirname5(fileURLToPath4(import.meta.url));
  while (dir !== dirname5(dir)) {
    if (existsSync6(join8(dir, "package.json")) && existsSync6(join8(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname5(dir);
  }
  throw new Error("Unable to resolve pjangler root");
}
function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n");
}
function readText(path) {
  return normalizeNewlines(readFileSync4(path, "utf8"));
}
function safeReadText(path) {
  return existsSync6(path) ? readText(path) : null;
}
function ensureParent(path) {
  mkdirSync4(dirname5(path), { recursive: true });
}
function writeText(path, content) {
  ensureParent(path);
  writeFileSync3(path, content);
}
function tryParseJson(text3) {
  if (!text3) return null;
  try {
    return JSON.parse(text3);
  } catch {
    return null;
  }
}
function slugifyRepoName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function titleCaseSlug(slug) {
  return slug.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function readSymlinkTarget(path) {
  if (!existsSync6(path)) return null;
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
function ensureSymlink(path, target, dryRun) {
  if (existsSync6(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const current = readSymlinkTarget(path);
      if (current === target) return { changed: false };
      if (!dryRun) {
        unlinkSync3(path);
        symlinkSync(target, path);
      }
      return { changed: true };
    }
    return { changed: false, blocked: `${relative(process.cwd(), path) || path} exists and is not a symlink` };
  }
  if (!dryRun) symlinkSync(target, path);
  return { changed: true };
}
function bootstrapAgentsFile(repoRoot, dryRun) {
  const agentsPath = join8(repoRoot, "AGENTS.md");
  if (existsSync6(agentsPath)) return { changedFiles: [], details: [] };
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const source = join8(repoRoot, file);
    if (!existsSync6(source)) continue;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!dryRun) renameSync(source, agentsPath);
      return { changedFiles: [agentsPath], details: [`Moved ${file} to AGENTS.md before wiring agent-file symlinks`] };
    }
    return { changedFiles: [], details: [], blocked: `${file} exists but is not a regular file; cannot promote to AGENTS.md` };
  }
  const readmePath = join8(repoRoot, "README.md");
  if (existsSync6(readmePath)) {
    const stat = lstatSync(readmePath);
    if (!stat.isFile()) return { changedFiles: [], details: [], blocked: "README.md exists but is not a regular file; cannot copy to AGENTS.md" };
    if (!dryRun) copyFileSync(readmePath, agentsPath);
    return { changedFiles: [agentsPath], details: ["Copied README.md to AGENTS.md before wiring agent-file symlinks"] };
  }
  return { changedFiles: [], details: [], blocked: "AGENTS.md missing and no CLAUDE.md, GEMINI.md, or README.md source exists" };
}
function yamlGet(text3, keyPath) {
  const parts = keyPath.split(".");
  const lines = text3.split("\n");
  let start = 0;
  let indent = 0;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const key = parts[idx];
    let found = false;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const currentIndent = match[1].length;
      const currentKey = match[2].trim();
      const rest = match[3].trim();
      if (idx > 0 && currentIndent < indent) break;
      if (currentIndent !== indent || currentKey !== key) continue;
      found = true;
      if (idx === parts.length - 1) {
        return rest.replace(/^['"]|['"]$/g, "").trim();
      }
      start = i + 1;
      indent = currentIndent + 2;
      break;
    }
    if (!found) return "";
  }
  return "";
}
function discoverRoles(repoRoot) {
  const rolesDir = join8(repoRoot, "agents", "hermes");
  if (!existsSync6(rolesDir)) return [];
  return readdirSync(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const roleDir = join8(rolesDir, entry.name);
    const roleYamlPath = join8(roleDir, "role.yaml");
    if (!existsSync6(roleYamlPath)) return null;
    const text3 = readText(roleYamlPath);
    const runtimeRepoRaw = yamlGet(text3, "runtime.github_repo");
    return {
      role: yamlGet(text3, "role") || entry.name,
      roleDir,
      roleYamlPath,
      repo: yamlGet(text3, "repo"),
      agentId: yamlGet(text3, "agent_id"),
      profileName: yamlGet(text3, "profile") || yamlGet(text3, "agent_id"),
      displayName: yamlGet(text3, "display_name"),
      purpose: yamlGet(text3, "purpose"),
      botHandle: yamlGet(text3, "telegram.bot_username"),
      runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
      runtimeOwner: yamlGet(text3, "runtime.github_owner"),
      planeWorkspace: yamlGet(text3, "ticket_provider.workspace") || yamlGet(text3, "plane.workspace"),
      ticketProviderName: yamlGet(text3, "ticket_provider.name"),
      ticketProviderBoardId: yamlGet(text3, "ticket_provider.board_id"),
      ticketProviderBoardUrl: yamlGet(text3, "ticket_provider.board_url"),
      ticketProviderIdentifier: yamlGet(text3, "plane.identifier")
    };
  }).filter((value) => Boolean(value));
}
function registryPath(homeDir) {
  return join8(homeDir, ".hermes", "agents-registry.yaml");
}
function systemctlUser(args) {
  const result = spawnSync4("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}
function templateScript(ctx, name) {
  const source = join8(ctx.pjanglerRoot, ".mise", "scripts", name);
  return existsSync6(source) ? readText(source) : void 0;
}
function templateVersioningScript(ctx) {
  return templateScript(ctx, "versioning.sh");
}
function templateLinkAgentfilesScript(ctx) {
  return templateScript(ctx, "link-agentfiles.sh");
}
function templateVersionFilesConf(ctx, repoRoot) {
  const packageJson = join8(repoRoot, "package.json");
  return existsSync6(packageJson) ? "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\njson package.json\ngittag .\n" : "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\ngittag .\n";
}
function replaceOrAppendManagedBlock(text3, startMarker, block, beforePattern) {
  if (startMarker.test(text3)) {
    return text3.replace(/# >>> mise-versioning >>>[\s\S]*?# <<< mise-versioning <<</, block);
  }
  if (beforePattern) {
    const match = text3.match(beforePattern);
    if (match && typeof match.index === "number") {
      return `${text3.slice(0, match.index).replace(/\s*$/, "\n\n")}${block}

${text3.slice(match.index)}`;
    }
  }
  return `${text3.replace(/\s*$/, "")}

${block}
`;
}
var BASE_MISE_PATH_ENTRIES = [".mise/scripts", "agents/hermes/pm"];
var CONDITIONAL_HERMES_PATHS = ["agents/hermes/pm/hermes", "agent/hermes/pm/hermes"];
function requiredMisePathEntries(ctx) {
  const required = [...BASE_MISE_PATH_ENTRIES];
  for (const candidate of CONDITIONAL_HERMES_PATHS) {
    if (existsSync6(join8(ctx.repoRoot, candidate)) && !required.includes(candidate)) required.push(candidate);
  }
  return required;
}
function upsertMisePath(text3, required = BASE_MISE_PATH_ENTRIES) {
  const render = (values) => `_.path = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const envMatch = text3.match(/(^|\n)(\[env\][\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!envMatch || typeof envMatch.index !== "number") {
    return `[env]
${render(required)}

${text3.replace(/^\s+/, "")}`;
  }
  const prefix = text3.slice(0, envMatch.index + envMatch[1].length);
  const section = envMatch[2];
  const suffix = text3.slice(envMatch.index + envMatch[1].length + section.length);
  const pathLine = section.match(/^_\.path\s*=\s*\[([^\]]*)\]\s*$/m);
  if (!pathLine) {
    return `${prefix}${section.replace(/\n?$/, "\n")}${render(required)}${suffix}`;
  }
  const current = [...pathLine[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const merged = [...current];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  const nextLine = render(merged);
  if (pathLine[0] === nextLine) return text3;
  return `${prefix}${section.replace(pathLine[0], nextLine)}${suffix}`;
}
function upsertLinkAgentfilesBlock(text3, ctx) {
  const withPath = upsertMisePath(text3, requiredMisePathEntries(ctx));
  const existing = /# This block will handle the linking of[\s\S]*?\[tasks\.link-agentfiles\][\s\S]*?run = "\{\{config_root\}\}\/\.mise\/scripts\/link-agentfiles\.sh"/;
  if (existing.test(withPath)) {
    return withPath.replace(existing, LINK_AGENTFILES_BLOCK);
  }
  const versioningIndex = withPath.indexOf("# >>> mise-versioning >>>");
  if (versioningIndex >= 0) {
    return `${withPath.slice(0, versioningIndex).replace(/\s*$/, "\n\n")}${LINK_AGENTFILES_BLOCK}

${withPath.slice(versioningIndex)}`;
  }
  return `${withPath.replace(/\s*$/, "")}

${LINK_AGENTFILES_BLOCK}
`;
}
function readProjectJson(ctx) {
  return tryParseJson(safeReadText(join8(ctx.repoRoot, ".project.json")));
}
function canonicalProjectJson(ctx) {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = String(existing.project_slug ?? slugifyRepoName(dirname5(ctx.repoRoot) === ctx.repoRoot ? ctx.repoRoot.split("/").pop() ?? "project" : ctx.repoRoot.split("/").pop() ?? "project"));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String((existing.ticket_provider?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String((existing.ticket_provider?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String((existing.ticket_provider?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String((existing.ticket_provider?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    board_url: String((existing.ticket_provider?.board_url ?? firstRole?.ticketProviderBoardUrl ?? "") || "")
  };
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_slug: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents: Object.fromEntries(
      roles.map((role) => [
        role.agentId || `${slug}-${role.role}`,
        {
          role: role.role,
          role_dir: relative(ctx.repoRoot, role.roleDir)
        }
      ])
    )
  };
}
function projectJsonFinding(ctx) {
  const projectPath = join8(ctx.repoRoot, ".project.json");
  const planeJsonPath = join8(ctx.repoRoot, ".plane.json");
  const details = [];
  const data = readProjectJson(ctx);
  const roles = discoverRoles(ctx.repoRoot);
  if (!existsSync6(projectPath)) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json missing", details: [], fixable: true };
  }
  if (!data) {
    return { id: "sot.project-json", title: "Canonical .project.json", status: "fail", summary: ".project.json is not valid JSON", details: [], fixable: true };
  }
  for (const key of ["project_name", "project_description", "project_slug", "repo_path", "ticket_provider", "agents"]) {
    if (!(key in data)) details.push(`missing key: ${key}`);
  }
  if (data.repo_path !== ctx.repoRoot) details.push(`repo_path should be ${ctx.repoRoot}`);
  const agents = data.agents ?? {};
  for (const role of roles) {
    const agent = agents[role.agentId];
    if (!agent) {
      details.push(`agents.${role.agentId} missing`);
      continue;
    }
    if (agent.role !== role.role) details.push(`agents.${role.agentId}.role should be ${role.role}`);
    if (agent.role_dir !== relative(ctx.repoRoot, role.roleDir)) {
      details.push(`agents.${role.agentId}.role_dir should be ${relative(ctx.repoRoot, role.roleDir)}`);
    }
  }
  const ticketProvider = data.ticket_provider ?? {};
  for (const key of ["type", "workspace", "identifier", "board_id", "board_url"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if (existsSync6(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
  return {
    id: "sot.project-json",
    title: "Canonical .project.json",
    status: details.length === 0 ? "pass" : "fail",
    summary: details.length === 0 ? ".project.json matches canonical parity contract" : `${details.length} parity issue(s) detected`,
    details,
    fixable: true
  };
}
function renderSoul(role) {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm" ? `Direct and brief. Decision-forward. No throat-clearing, no apologies, no "I'll help you with that" preambles.` : role.role === "scrum-master" ? "Operational, skeptical, and schedule-aware. Prefer explicit next actions, evidence, and status transitions." : "Direct and brief.";
  const roleSpecific = role.role === "pm" ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code.` : role.role === "scrum-master" ? `You own the continuous-ticket sentinel. You watch the ticket board, enforce workflow policy, and keep work moving without inventing requirements.` : `You operate as the ${role.role} agent for this repo.`;
  const runtimeOwner = role.runtimeOwner || "delorenj";
  return `# ${role.displayName || role.agentId}

You are **${role.displayName || role.agentId}** \u2014 a Hermes agent provisioned to work inside the
\`${role.repo}\` repository.

## Identity

| | |
| --- | --- |
| Agent ID | \`${role.agentId}\` |
| Profile | \`${role.profileName || role.agentId}\` |
| Repo | \`${role.repo}\` |
| Role | \`${role.role}\` |
| Telegram | \`${telegram}\` |
| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |

## Scope

You operate only within the working directory of \`${role.repo}\`. Your HERMES_HOME resolves through the named profile \`${role.profileName || role.agentId}\`, which is symlinked to the runtime submodule at \`./runtime/\` (repo \`${runtimeOwner}/${role.runtimeRepo}\`). Your \`config.yaml\` inherits shared non-secret defaults from the fleet default profile; secrets, SOUL, memories, skills, sessions, gateway state, and runtime files remain local to this profile.

## Tone

${tone}

## Role-specific behavior

${roleSpecific}

## Memory hygiene

Your memory is the submodule at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.
`;
}
function renderHermesWrapper(role) {
  return `#!/usr/bin/env bash
# Launcher for ${role.agentId}. Resolves HERMES_HOME through the fleet profile
# when available, then falls back to the local runtime submodule.

set -euo pipefail

ROLE_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_HOME="$ROLE_DIR/runtime"

FLEET_ENV="{HERMES_FLEET_ENV:-$HOME/.hermes/fleet.env}"
if [[ -f "$FLEET_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$FLEET_ENV"
fi

HERMES_BIN="{HERMES_BIN:-{HERMES_FLEET_BIN:-/home/delorenj/code/hermes-agent/.venv/bin/hermes}}"
HERMES_OAUTH_FILE="{HERMES_OAUTH_FILE:-{HERMES_FLEET_OAUTH_FILE:-$HOME/.hermes/auth.json}}"
CODEX_HOME="{CODEX_HOME:-{HERMES_FLEET_CODEX_HOME:-$HOME/.codex}}"

FLEET_HOME="{HERMES_FLEET_HOME:-$HOME/.hermes}"
PROFILE_NAME="{HERMES_PROFILE_NAME:-${role.profileName || role.agentId}}"
PROFILE_HOME="$FLEET_HOME/profiles/$PROFILE_NAME"
if [[ -d "$PROFILE_HOME" ]]; then
  HERMES_HOME="$PROFILE_HOME"
else
  HERMES_HOME="$RUNTIME_HOME"
fi

if [[ ! -d "$RUNTIME_HOME" ]]; then
  echo "hermes: runtime submodule not initialized at $RUNTIME_HOME" >&2
  echo "  fix: git submodule update --init --recursive" >&2
  exit 1
fi

exec env HERMES_HOME="$HERMES_HOME" HERMES_FLEET_ENV="$FLEET_ENV"   HERMES_OAUTH_FILE="$HERMES_OAUTH_FILE" CODEX_HOME="$CODEX_HOME"   "$HERMES_BIN" "$@"
`.replace(/\u0010/g, "$");
}
function copyMissingRecursive(sourceDir, targetDir, changedFiles, dryRun, skip) {
  if (!existsSync6(sourceDir)) return;
  mkdirSync4(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join8(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join8(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync6(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}
function upsertSubmodule(repoRoot, role, changedFiles, dryRun) {
  const gitmodulesPath = join8(repoRoot, ".gitmodules");
  const repoName = role.runtimeRepo || `agent-hm-${role.repo}-${role.role}`;
  const owner = role.runtimeOwner || "delorenj";
  const block = `[submodule "agents/hermes/${role.role}/runtime"]
	path = agents/hermes/${role.role}/runtime
	url = git@github.com:${owner}/${repoName}.git
`;
  const current = safeReadText(gitmodulesPath) ?? "";
  const header = `[submodule "agents/hermes/${role.role}/runtime"]`;
  if (current.includes(header)) return [];
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, `${current.replace(/\s*$/, "")}${current.trim() ? "\n" : ""}${block}`);
  return [gitmodulesPath];
}
function upsertRegistryEntry(role, homeDir, changedFiles, dryRun) {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const block = `  ${role.agentId}:
    repo: ${role.repo}
    role: ${role.role}
    display_name: ${JSON.stringify(role.displayName || role.agentId)}
    project_path: ${ctxEscape(role.roleDir ? dirname5(dirname5(dirname5(role.roleDir))) : "")}
    role_dir: ${ctxEscape(role.roleDir)}
    profile_name: ${role.profileName || role.agentId}
    telegram:
      bot_username: ${ctxEscape(role.botHandle)}
    plane:
      workspace: ${ctxEscape(role.planeWorkspace)}
      project_id: ${ctxEscape(role.ticketProviderBoardId)}
      identifier: ${ctxEscape(role.ticketProviderIdentifier)}
    runtime_repo: ${ctxEscape(role.runtimeRepo)}
    systemd:
      gateway_unit: hermes-${role.agentId}-gateway.service
      consumer_unit: hermes-${role.agentId}-consumer.service
      checkpoint_timer: hermes-${role.agentId}-checkpoint.timer
`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:
${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function profileMetaInheritsDefault(path) {
  const text3 = safeReadText(path);
  return Boolean(
    text3 && /^config:\s*$/m.test(text3) && /^\s+inherit_from:\s*default\s*$/m.test(text3) && /^\s+save_mode:\s*delta\s*$/m.test(text3)
  );
}
function upsertInheritedProfileMeta(path, changedFiles, dryRun) {
  const current = safeReadText(path) ?? "";
  const lines = current.split("\n");
  let next;
  const start = lines.findIndex((line) => /^config:\s*$/.test(line));
  if (!current.trim()) {
    next = "config:\n  inherit_from: default\n  save_mode: delta\n";
  } else if (start === -1) {
    next = `${current.replace(/\s*$/, "\n")}config:
  inherit_from: default
  save_mode: delta
`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^[^#\s][^:]*:\s*/.test(lines[end] ?? "")) end++;
    let hasInherit = false;
    let hasSave = false;
    for (let idx = start + 1; idx < end; idx++) {
      if (/^\s+inherit_from:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  inherit_from: default";
        hasInherit = true;
      } else if (/^\s+save_mode:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  save_mode: delta";
        hasSave = true;
      }
    }
    const inserts = [];
    if (!hasInherit) inserts.push("  inherit_from: default");
    if (!hasSave) inserts.push("  save_mode: delta");
    if (inserts.length) lines.splice(end, 0, ...inserts);
    next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }
  if (next === current) return null;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function ctxEscape(value) {
  return JSON.stringify(value || "");
}
function checkUnit(unit) {
  const enabled = systemctlUser(["is-enabled", unit]).ok;
  const active = systemctlUser(["is-active", unit]).ok;
  return { enabled, active };
}
var RULES = [
  {
    id: "mise.config-root",
    title: "mise config_root + AGENTS link hooks",
    audit: (ctx) => {
      const misePath = join8(ctx.repoRoot, "mise.toml");
      if (!existsSync6(misePath)) {
        return { id: "mise.config-root", title: "mise config_root + AGENTS link hooks", status: "fail", summary: "mise.toml missing", details: [], fixable: true };
      }
      const text3 = readText(misePath);
      const details = [];
      const linkAgentfilesPath = join8(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      if (!existsSync6(linkAgentfilesPath)) details.push(".mise/scripts/link-agentfiles.sh missing");
      const pathValues = [...(text3.match(/^_\.path\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      const missingPathValues = requiredMisePathEntries(ctx).filter((value) => !pathValues.includes(value));
      if (missingPathValues.length) details.push(`[env]._.path should include ${missingPathValues.join(", ")}`);
      if (!text3.includes('"{{config_root}}/.mise/scripts/link-agentfiles.sh"')) details.push("link-agentfiles must use raw {{config_root}} guard");
      if (!text3.includes("op inject -i .env.op > .env")) details.push("[hooks].enter must materialize .env from .env.op");
      if (!text3.includes('patterns = ["AGENTS.md"]')) details.push("watch_files must monitor AGENTS.md");
      if (!text3.includes('task = "link-agentfiles"')) details.push("watch_files must dispatch link-agentfiles task");
      return {
        id: "mise.config-root",
        title: "mise config_root + AGENTS link hooks",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "mise AGENTS-linking parity verified" : `${details.length} issue(s) detected in mise AGENTS-linking contract`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const path = join8(ctx.repoRoot, "mise.toml");
      const changedFiles = [];
      if (!existsSync6(path)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing; initialize mise first", changedFiles, details: [] };
      }
      let text3 = readText(path);
      const next = upsertLinkAgentfilesBlock(text3, ctx);
      if (next !== text3) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, next);
        text3 = next;
      }
      const linkAgentfilesPath = join8(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      const expectedScript = templateLinkAgentfilesScript(ctx);
      if (expectedScript === void 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/link-agentfiles.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(linkAgentfilesPath) !== expectedScript) {
        changedFiles.push(linkAgentfilesPath);
        if (!ctx.dryRun) {
          writeText(linkAgentfilesPath, expectedScript);
          chmodSync(linkAgentfilesPath, 493);
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Updated mise AGENTS-linking contract" : "No changes required",
        changedFiles,
        details: changedFiles.length ? ["Normalized hooks/watch_files/tasks.link-agentfiles block and script"] : []
      };
    }
  },
  {
    id: "mise.versioning",
    title: "managed mise versioning block",
    audit: (ctx) => {
      const details = [];
      const misePath = join8(ctx.repoRoot, "mise.toml");
      const versioningPath = join8(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const manifestPath = join8(ctx.repoRoot, ".mise", "version-files.conf");
      const text3 = safeReadText(misePath);
      if (!text3?.includes("# >>> mise-versioning >>>")) details.push("mise versioning managed block missing");
      if (!existsSync6(versioningPath)) details.push(".mise/scripts/versioning.sh missing");
      if (!existsSync6(manifestPath)) details.push(".mise/version-files.conf missing");
      return {
        id: "mise.versioning",
        title: "managed mise versioning block",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "mise versioning parity verified" : `${details.length} versioning issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles = [];
      const misePath = join8(ctx.repoRoot, "mise.toml");
      if (!existsSync6(misePath)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing; cannot inject versioning block", changedFiles, details: [] };
      }
      const currentMise = readText(misePath);
      const nextMise = replaceOrAppendManagedBlock(currentMise, /# >>> mise-versioning >>>/, VERSIONING_BLOCK, /^\[tasks\.build\]/m);
      if (nextMise !== currentMise) {
        changedFiles.push(misePath);
        if (!ctx.dryRun) writeText(misePath, nextMise);
      }
      const versioningPath = join8(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const expectedScript = templateVersioningScript(ctx);
      if (expectedScript === void 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/versioning.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(versioningPath) !== expectedScript) {
        changedFiles.push(versioningPath);
        if (!ctx.dryRun) {
          writeText(versioningPath, expectedScript);
          chmodSync(versioningPath, 493);
        }
      }
      const manifestPath = join8(ctx.repoRoot, ".mise", "version-files.conf");
      const expectedManifest = templateVersionFilesConf(ctx, ctx.repoRoot);
      if (safeReadText(manifestPath) !== expectedManifest) {
        changedFiles.push(manifestPath);
        if (!ctx.dryRun) writeText(manifestPath, expectedManifest);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Versioning block/script/manifest normalized" : "No changes required",
        changedFiles,
        details: []
      };
    }
  },
  {
    id: "sot.agent-symlinks",
    title: "AGENTS/CLAUDE/GEMINI symlink contract",
    audit: (ctx) => {
      const agentsPath = join8(ctx.repoRoot, "AGENTS.md");
      if (!existsSync6(agentsPath)) {
        const fallbackSources = ["CLAUDE.md", "GEMINI.md", "README.md"].filter((file) => existsSync6(join8(ctx.repoRoot, file)));
        if (fallbackSources.length === 0) {
          return { id: "sot.agent-symlinks", title: "AGENTS/CLAUDE/GEMINI symlink contract", status: "skip", summary: "AGENTS.md missing; symlink contract not applicable", details: [], fixable: false };
        }
        return {
          id: "sot.agent-symlinks",
          title: "AGENTS/CLAUDE/GEMINI symlink contract",
          status: "fail",
          summary: "AGENTS.md missing but can be derived from existing project documentation",
          details: [`AGENTS.md can be created from ${fallbackSources[0]}`],
          fixable: true
        };
      }
      const details = [];
      for (const file of ["CLAUDE.md", "GEMINI.md"]) {
        const full = join8(ctx.repoRoot, file);
        const target = readSymlinkTarget(full);
        if (target !== "AGENTS.md") details.push(`${file} should be a symlink to AGENTS.md`);
      }
      return {
        id: "sot.agent-symlinks",
        title: "AGENTS/CLAUDE/GEMINI symlink contract",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Agent documentation symlinks are in parity" : `${details.length} symlink issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles = [];
      const details = [];
      const blockedDetails = [];
      const bootstrap = bootstrapAgentsFile(ctx.repoRoot, ctx.dryRun);
      changedFiles.push(...bootstrap.changedFiles);
      details.push(...bootstrap.details);
      if (bootstrap.blocked) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "AGENTS.md missing; cannot derive canonical agent file", changedFiles, details: [bootstrap.blocked] };
      }
      for (const file of ["CLAUDE.md", "GEMINI.md"]) {
        const full = join8(ctx.repoRoot, file);
        const result = ensureSymlink(full, "AGENTS.md", ctx.dryRun);
        if (result.blocked) blockedDetails.push(result.blocked);
        if (result.changed) changedFiles.push(full);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: blockedDetails.length ? "blocked" : changedFiles.length ? "applied" : "noop",
        summary: blockedDetails.length ? "One or more files could not be replaced safely" : changedFiles.length ? "Symlink contract repaired" : "No changes required",
        changedFiles,
        details: [...details, ...blockedDetails]
      };
    }
  },
  {
    id: "sot.project-json",
    title: "Canonical .project.json",
    audit: projectJsonFinding,
    migrate: (ctx, finding) => {
      const changedFiles = [];
      const details = [];
      const path = join8(ctx.repoRoot, ".project.json");
      const existing = readProjectJson(ctx) ?? {};
      const canonical = canonicalProjectJson(ctx);
      const merged = { ...existing, ...canonical };
      const expected = `${JSON.stringify(merged, null, 2)}
`;
      if (safeReadText(path) !== expected) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, expected);
      }
      const planeJson = join8(ctx.repoRoot, ".plane.json");
      if (existsSync6(planeJson)) {
        const backup = `${planeJson}.migrated-backup`;
        if (existsSync6(backup)) {
          details.push(`cannot back up .plane.json because ${relative(ctx.repoRoot, backup)} already exists`);
        } else {
          changedFiles.push(backup);
          if (!ctx.dryRun) renameSync(planeJson, backup);
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.length ? "blocked" : changedFiles.length ? "applied" : "noop",
        summary: details.length ? "Project SOT partially blocked" : changedFiles.length ? "Canonical .project.json written" : "No changes required",
        changedFiles,
        details
      };
    }
  },
  {
    id: "secrets.env-op",
    title: ".env.op + gitignore secrets contract",
    audit: (ctx) => {
      const details = [];
      const envOp = safeReadText(join8(ctx.repoRoot, ".env.op"));
      const gitignore = safeReadText(join8(ctx.repoRoot, ".gitignore"));
      if (!envOp) {
        details.push(".env.op missing");
      } else {
        const invalidLines = envOp.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).filter((line) => {
          const value = line.slice(line.indexOf("=") + 1).trim();
          return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value);
        });
        if (invalidLines.length) details.push(`.env.op has non-reference values that do not look like safe literals: ${invalidLines.join(", ")}`);
      }
      if (!gitignore?.includes(".env\n") && !gitignore?.includes(".env\r\n")) details.push(".gitignore should ignore .env");
      if (!gitignore?.includes(".env.*")) details.push(".gitignore should ignore .env.*");
      if (!gitignore?.includes("!.env.op")) details.push(".gitignore should unignore .env.op");
      return {
        id: "secrets.env-op",
        title: ".env.op + gitignore secrets contract",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Secret reference file and ignore rules are in parity" : `${details.length} env parity issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles = [];
      const details = [];
      const envOpPath = join8(ctx.repoRoot, ".env.op");
      if (!existsSync6(envOpPath)) {
        changedFiles.push(envOpPath);
        if (!ctx.dryRun) writeText(envOpPath, readText(join8(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op")));
      }
      const gitignorePath = join8(ctx.repoRoot, ".gitignore");
      const gitignore = safeReadText(gitignorePath) ?? "";
      const requiredBlock = `# Secrets \u2014 .env is materialized by \`op inject -i .env.op > .env\` on mise enter.
# NEVER commit it. .env.op holds only 1Password references or safe literals and IS committed.
.env
.env.*
!.env.op
`;
      if (!gitignore.includes("!.env.op") || !gitignore.includes(".env.*")) {
        changedFiles.push(gitignorePath);
        if (!ctx.dryRun) writeText(gitignorePath, `${gitignore.replace(/\s*$/, "")}${gitignore.trim() ? "\n\n" : ""}${requiredBlock}`);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.length ? "blocked" : changedFiles.length ? "applied" : "noop",
        summary: details.length ? "Manual cleanup still required" : changedFiles.length ? "Wrote .env.op/gitignore parity files" : "No changes required",
        changedFiles,
        details
      };
    }
  },
  {
    id: "provenance.copier",
    title: ".copier-answers.yml provenance + drift report",
    audit: (ctx) => {
      const details = [];
      const path = join8(ctx.repoRoot, ".copier-answers.yml");
      const text3 = safeReadText(path);
      const project = readProjectJson(ctx);
      if (!text3) {
        details.push(".copier-answers.yml missing");
      } else {
        if (!text3.startsWith("# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY")) details.push("missing Copier overwrite warning header");
        if (!text3.includes("_src_path:")) details.push("_src_path missing");
        if (project?.project_name) {
          const nameMatch = text3.match(/project_name:\s*(.+)/);
          if (!nameMatch || nameMatch[1]?.trim() !== String(project.project_name)) details.push("project_name drift between .copier-answers.yml and .project.json");
        }
        if (project?.project_description) {
          const descMatch = text3.match(/project_description:\s*([\s\S]*?)(?=\n\w|$)/);
          const yamlDesc = descMatch?.[1]?.replace(/\n\s+/g, " ").trim() ?? "";
          if (yamlDesc !== String(project.project_description)) details.push("project_description drift between .copier-answers.yml and .project.json");
        }
      }
      return {
        id: "provenance.copier",
        title: ".copier-answers.yml provenance + drift report",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Copier provenance is in parity" : `${details.length} provenance issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles = [];
      const project = canonicalProjectJson(ctx);
      const text3 = `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY
_src_path: ${join8(ctx.pjanglerRoot, "templates", "commonproject")}
project_description: ${String(project.project_description)}
project_name: ${String(project.project_name)}
ticket_provider: ${String(project.ticket_provider?.type ?? "plane")}
`;
      const path = join8(ctx.repoRoot, ".copier-answers.yml");
      if (safeReadText(path) !== text3) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, text3);
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Copier provenance file refreshed" : "No changes required",
        changedFiles,
        details: []
      };
    }
  },
  {
    id: "bmad.scaffold",
    title: "BMAD modules/docs scaffold",
    audit: (ctx) => {
      const sourceRoot = join8(ctx.pjanglerRoot, "templates", "commonproject", "_bmad");
      const targetRoot = join8(ctx.repoRoot, "_bmad");
      const sentinels = [
        join8("core", "config.yaml"),
        join8("custom", "config.yaml"),
        join8("custom", "workflows", "ticket-lifecycle", "workflow.yaml"),
        join8("bmm", "workflows", "workflow-status", "workflow.yaml")
      ];
      const missing = sentinels.filter((file) => existsSync6(join8(sourceRoot, file)) && !existsSync6(join8(targetRoot, file)));
      return {
        id: "bmad.scaffold",
        title: "BMAD modules/docs scaffold",
        status: missing.length === 0 ? "pass" : "fail",
        summary: missing.length === 0 ? "BMAD scaffold parity verified" : `${missing.length} BMAD sentinel file(s) missing`,
        details: missing.map((file) => `_bmad/${file}`),
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles = [];
      copyMissingRecursive(join8(ctx.pjanglerRoot, "templates", "commonproject", "_bmad"), join8(ctx.repoRoot, "_bmad"), changedFiles, ctx.dryRun);
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Copied missing BMAD scaffold files" : "No changes required",
        changedFiles,
        details: []
      };
    }
  },
  {
    id: "hermes.pm-scaffold",
    title: "Hermes PM scaffold parity",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      const role = roles.find((item) => item.role === "pm");
      if (!role) {
        return { id: "hermes.pm-scaffold", title: "Hermes PM scaffold parity", status: "skip", summary: "No pm role present", details: [], fixable: false };
      }
      const details = [];
      for (const rel of ["role.yaml", "SOUL.md", "hermes", ".gitignore", ".scripts/70-systemd.sh", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md", "runtime/bloodbank-consumer.py"]) {
        if (!existsSync6(join8(role.roleDir, rel))) details.push(`missing ${relative(ctx.repoRoot, join8(role.roleDir, rel))}`);
      }
      const gitmodules = safeReadText(join8(ctx.repoRoot, ".gitmodules")) ?? "";
      if (!gitmodules.includes(`agents/hermes/${role.role}/runtime`)) details.push(".gitmodules missing pm runtime submodule entry");
      if (!profileMetaInheritsDefault(join8(role.roleDir, "runtime", "profile.yaml"))) {
        details.push("runtime/profile.yaml missing inherited default config metadata");
      }
      const registry = safeReadText(registryPath(ctx.homeDir));
      if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
      return {
        id: "hermes.pm-scaffold",
        title: "Hermes PM scaffold parity",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "PM scaffold parity verified" : `${details.length} PM scaffold issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const role = discoverRoles(ctx.repoRoot).find((item) => item.role === "pm");
      const changedFiles = [];
      const details = [];
      if (!role) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No pm role present", changedFiles, details: [] };
      }
      const templateRoleDir = join8(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      writeIfDifferent(join8(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
      writeIfDifferent(join8(role.roleDir, "hermes"), renderHermesWrapper(role), ctx.dryRun, changedFiles, 493);
      writeIfDifferent(join8(role.roleDir, ".gitignore"), readText(join8(templateRoleDir, ".gitignore.jinja")).replace(/\{\{ role \}\}/g, role.role), ctx.dryRun, changedFiles);
      copyMissingRecursive(join8(templateRoleDir, ".runtime-scaffold"), join8(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join8(templateRoleDir, ".runtime-scaffold"), join8(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join8(templateRoleDir, ".scripts"), join8(role.roleDir, ".scripts"), changedFiles, ctx.dryRun, (source) => source.endsWith("continuous-ticket-sentinel.prompt.md.jinja"));
      upsertSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
      const profileMetaUpdated = upsertInheritedProfileMeta(join8(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
      if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
      const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
      if (registryUpdated) details.push(`updated ${registryUpdated}`);
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "PM scaffold normalized" : "No changes required",
        changedFiles,
        details
      };
    }
  },
  {
    id: "hermes.scrum-master-scaffold",
    title: "Hermes scrum-master scaffold parity",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      const role = roles.find((item) => item.role === "scrum-master");
      if (!role) {
        return { id: "hermes.scrum-master-scaffold", title: "Hermes scrum-master scaffold parity", status: "skip", summary: "No scrum-master role present", details: [], fixable: false };
      }
      const details = [];
      for (const rel of ["role.yaml", "SOUL.md", "hermes", ".gitignore", ".scripts/75-scrum-master.sh", ".scripts/scrum-master/continuous-ticket-sentinel.sh", "runtime/memories/MEMORY.md", "runtime/bloodbank-consumer.py"]) {
        if (!existsSync6(join8(role.roleDir, rel))) details.push(`missing ${relative(ctx.repoRoot, join8(role.roleDir, rel))}`);
      }
      const gitmodules = safeReadText(join8(ctx.repoRoot, ".gitmodules")) ?? "";
      if (!gitmodules.includes(`agents/hermes/${role.role}/runtime`)) details.push(".gitmodules missing scrum-master runtime submodule entry");
      if (!profileMetaInheritsDefault(join8(role.roleDir, "runtime", "profile.yaml"))) {
        details.push("runtime/profile.yaml missing inherited default config metadata");
      }
      const registry = safeReadText(registryPath(ctx.homeDir));
      if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
      return {
        id: "hermes.scrum-master-scaffold",
        title: "Hermes scrum-master scaffold parity",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "scrum-master scaffold parity verified" : `${details.length} scrum-master scaffold issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const role = discoverRoles(ctx.repoRoot).find((item) => item.role === "scrum-master");
      const changedFiles = [];
      const details = [];
      if (!role) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No scrum-master role present", changedFiles, details: [] };
      }
      const templateRoleDir = join8(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      writeIfDifferent(join8(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
      writeIfDifferent(join8(role.roleDir, "hermes"), renderHermesWrapper(role), ctx.dryRun, changedFiles, 493);
      writeIfDifferent(join8(role.roleDir, ".gitignore"), readText(join8(templateRoleDir, ".gitignore.jinja")).replace(/\{\{ role \}\}/g, role.role), ctx.dryRun, changedFiles);
      copyMissingRecursive(join8(templateRoleDir, ".runtime-scaffold"), join8(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join8(templateRoleDir, ".runtime-scaffold"), join8(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join8(templateRoleDir, ".scripts"), join8(role.roleDir, ".scripts"), changedFiles, ctx.dryRun, (source) => source.endsWith("continuous-ticket-sentinel.prompt.md.jinja"));
      const promptSource = join8(templateRoleDir, ".scripts", "scrum-master", "continuous-ticket-sentinel.prompt.md.jinja");
      const promptTarget = join8(role.roleDir, ".scripts", "scrum-master", "continuous-ticket-sentinel.prompt.md");
      if (!existsSync6(promptTarget)) {
        const prompt = readText(promptSource).replace(/\{\{ agent_id \}\}/g, role.agentId).replace(/\{\{ role \}\}/g, role.role).replace(/\{\{ target_repo \}\}/g, role.repo);
        writeIfDifferent(promptTarget, prompt, ctx.dryRun, changedFiles);
      }
      upsertSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
      const profileMetaUpdated = upsertInheritedProfileMeta(join8(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
      if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
      const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
      if (registryUpdated) details.push(`updated ${registryUpdated}`);
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "scrum-master scaffold normalized" : "No changes required",
        changedFiles,
        details
      };
    }
  },
  {
    id: "systemd.sentinel",
    title: "Hermes systemd/sentinel units enabled + active",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "warn", summary: "systemd --user unavailable; unit state not auditable here", details: [], fixable: false };
      }
      const details = [];
      for (const role of roles) {
        for (const unit of [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-checkpoint.timer`]) {
          const state = checkUnit(unit);
          if (!state.enabled || !state.active) details.push(`${unit} should be enabled+active`);
        }
        if (role.role === "scrum-master") {
          const state = checkUnit(`hermes-${role.agentId}-continuous-ticket-sentinel.timer`);
          if (!state.enabled || !state.active) details.push(`hermes-${role.agentId}-continuous-ticket-sentinel.timer should be enabled+active`);
        }
      }
      return {
        id: "systemd.sentinel",
        title: "Hermes systemd/sentinel units enabled + active",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Hermes user units are enabled and active" : `${details.length} systemd parity issue(s) detected`,
        details,
        fixable: true
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles = [];
      const details = [];
      if (!roles.length) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No Hermes roles present", changedFiles, details };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
      }
      for (const role of roles) {
        const sysDir = join8(ctx.homeDir, ".config", "systemd", "user");
        const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-checkpoint.timer`];
        if (role.role === "scrum-master") units.push(`hermes-${role.agentId}-continuous-ticket-sentinel.timer`);
        const allUnitsPresent = units.every((unit) => existsSync6(join8(sysDir, unit)));
        if (allUnitsPresent) {
          if (ctx.dryRun) {
            details.push(`would run: systemctl --user enable --now ${units.join(" ")}`);
          } else {
            systemctlUser(["daemon-reload"]);
            for (const unit of units) {
              systemctlUser(["enable", "--now", unit]);
            }
          }
          continue;
        }
        for (const script of [join8(role.roleDir, ".scripts", "70-systemd.sh"), role.role === "scrum-master" ? join8(role.roleDir, ".scripts", "75-scrum-master.sh") : ""]) {
          if (!script || !existsSync6(script)) continue;
          if (ctx.dryRun) {
            details.push(`would run: bash ${script}`);
          } else {
            const result = spawnSync4("bash", [script], { cwd: role.roleDir, encoding: "utf8" });
            if (result.status !== 0) details.push(`script failed: ${script}: ${result.stderr.trim() || result.stdout.trim()}`);
          }
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? ctx.dryRun ? "skipped" : "applied" : "noop",
        summary: details.length ? ctx.dryRun ? "Planned systemd remediation commands" : "Attempted systemd remediation" : "No changes required",
        changedFiles,
        details
      };
    }
  }
];
function writeIfDifferent(path, content, dryRun, changedFiles, mode) {
  const normalized = content.endsWith("\n") ? content : `${content}
`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
}
function getParityRuleIds() {
  return RULES.map((rule) => rule.id);
}
function runAudit(repoArg) {
  const pjanglerRoot = resolvePjanglerRoot();
  const ctx = {
    repoRoot: resolve(repoArg ?? process.cwd()),
    dryRun: true,
    pjanglerRoot,
    homeDir: homedir4()
  };
  const rules = RULES.map((rule) => rule.audit(ctx));
  return {
    repo: ctx.repoRoot,
    ok: rules.every((rule) => rule.status === "pass" || rule.status === "skip"),
    auditedAt: (/* @__PURE__ */ new Date()).toISOString(),
    rules
  };
}
function runMigration(selector, repoArg, dryRun, all) {
  const pjanglerRoot = resolvePjanglerRoot();
  const ctx = {
    repoRoot: resolve(repoArg ?? process.cwd()),
    dryRun,
    pjanglerRoot,
    homeDir: homedir4()
  };
  const selected = all ? RULES : RULES.filter((rule) => rule.id === selector);
  if (!selected.length) {
    throw new Error(`Unknown parity rule: ${selector}`);
  }
  const results = selected.map((rule) => {
    try {
      return rule.migrate(ctx, rule.audit(ctx));
    } catch (err) {
      return {
        id: rule.id,
        title: rule.title,
        status: "blocked",
        summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
        changedFiles: [],
        details: []
      };
    }
  });
  const changedFiles = Array.from(new Set(results.flatMap((result) => result.changedFiles))).sort();
  return {
    repo: ctx.repoRoot,
    dryRun,
    ok: results.every((result) => result.status !== "blocked"),
    selectedRules: selected.map((rule) => rule.id),
    results,
    changedFiles
  };
}
function formatAuditReport(report) {
  const lines = [`repo: ${report.repo}`, `ok: ${report.ok}`, `audited_at: ${report.auditedAt}`, "rules:"];
  for (const rule of report.rules) {
    lines.push(`- ${rule.id} [${rule.status}] ${rule.summary}`);
    for (const detail of rule.details) lines.push(`    - ${detail}`);
  }
  return `${lines.join("\n")}
`;
}

// src/mcp-server.ts
var server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION
});
var TICKET_PROVIDER_SCHEMA = z.enum(["plane", "linear", "trello"]);
function resolveTargetDir(targetDir) {
  const dir = resolve2(targetDir ?? process.cwd());
  if (!existsSync7(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}
function resolvePjanglerRoot2() {
  let dir = dirname6(fileURLToPath5(import.meta.url));
  while (dir !== dirname6(dir)) {
    if (existsSync7(join9(dir, "package.json")) && existsSync7(join9(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname6(dir);
  }
  throw new Error("Unable to resolve pjangler root");
}
function slugify(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function asText(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}
function auditSummary(report) {
  const counts = report.rules.reduce((acc, rule) => {
    acc[rule.status] = (acc[rule.status] ?? 0) + 1;
    return acc;
  }, {});
  const nextActions = report.rules.filter((rule) => (rule.status === "fail" || rule.status === "warn") && rule.fixable).map((rule) => `pjangler_migrate_project ${rule.id}`);
  return { counts, nextActions };
}
function migrationSummary(report) {
  const counts = report.results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  return { counts, changedFileCount: report.changedFiles.length };
}
function parityGuidance() {
  return {
    skill: "@33god-projects",
    guidance: "Use these tools before editing a project so the repo SOT, agent files, mise hooks, and Hermes role scaffold are current.",
    workflows: [
      "audit -> pjangler_audit_project",
      "migrate -> pjangler_migrate_project",
      "bootstrap -> pjangler_bootstrap_33god_project",
      "agent provisioning -> pjangler_deploy_hermes_agent"
    ]
  };
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
function buildCommonProjectCopierAction(input) {
  const data = {
    project_name: input.projectName,
    project_description: input.projectDescription ?? "",
    project_slug: input.projectSlug,
    ticket_provider: input.ticketProvider,
    plane_workspace: input.planeWorkspace,
    plane_project_id: input.planeProjectId ?? "",
    project_identifier: input.projectIdentifier,
    primary_language: input.primaryLanguage
  };
  const args = ["copy", "--trust", input.templateDir, input.targetDir, "--defaults"];
  for (const [key, value] of Object.entries(data)) args.push("--data", `${key}=${value}`);
  if (input.overwrite) args.push("--overwrite");
  return {
    kind: "copier.copy.commonproject",
    command: ["copier", ...args],
    data
  };
}
server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes, commands, parity rules, workflows, and @33god-projects tool guidance.",
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
      })),
      parityRules: getParityRuleIds(),
      recommendedWorkflows: {
        existingProject: ["pjangler_audit_project", "pjangler_migrate_project"],
        new33godProject: ["pjangler_bootstrap_33god_project", "pjangler_audit_project"],
        hermesAgentProvisioning: ["pjangler_deploy_hermes_agent", "pjangler_audit_project"]
      },
      skillSynergy: parityGuidance()
    };
    return asText(payload);
  }
);
server.registerTool(
  "pjangler_list_parity_rules",
  {
    title: "List pjangler parity rules",
    description: "Returns parity rule ids plus brief @33god-projects guidance.",
    inputSchema: {}
  },
  async () => asText({ parityRules: getParityRuleIds(), guidance: parityGuidance() })
);
server.registerTool(
  "pjangler_audit_project",
  {
    title: "Audit project parity",
    description: "Runs pjangler parity audit for a project and returns structured findings with summary counts and next actions.",
    inputSchema: {
      targetDir: z.string().optional(),
      json: z.boolean().optional()
    }
  },
  async ({ targetDir, json }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runAudit(resolvedTarget);
      const payload = { ...report, summary: auditSummary(report), guidance: parityGuidance() };
      return asText(json === false ? formatAuditReport(report) : payload);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_migrate_project",
  {
    title: "Migrate project parity",
    description: "Runs one pjangler parity migration rule, or all rules, against a project.",
    inputSchema: {
      targetDir: z.string().optional(),
      ruleId: z.string().optional(),
      all: z.boolean().optional(),
      dryRun: z.boolean().optional()
    }
  },
  async ({ targetDir, ruleId, all, dryRun }) => {
    try {
      const runAll = all ?? false;
      if (!runAll && !ruleId) throw new Error("Either ruleId or all=true is required");
      if (runAll && ruleId) throw new Error("Pass either ruleId or all=true, not both");
      const resolvedTarget = resolveTargetDir(targetDir);
      const report = runMigration(ruleId, resolvedTarget, dryRun ?? true, runAll);
      return asText({
        ok: report.ok,
        repo: report.repo,
        dryRun: report.dryRun,
        selectedRules: report.selectedRules,
        changedFiles: report.changedFiles,
        results: report.results,
        summary: migrationSummary(report)
      });
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_bootstrap_33god_project",
  {
    title: "Bootstrap a new @33god project",
    description: "Create a new CommonProject-based 33god repo with optional local Hermes agent provisioning. Dry-run is safe and does not require copier.",
    inputSchema: {
      parentDir: z.string().optional(),
      targetDir: z.string().optional(),
      projectName: z.string(),
      projectDescription: z.string().optional(),
      projectSlug: z.string().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional(),
      planeWorkspace: z.string().optional(),
      planeProjectId: z.string().optional(),
      projectIdentifier: z.string().optional(),
      primaryLanguage: z.string().optional(),
      skipPlane: z.boolean().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: z.string().optional(),
      agentPurpose: z.string().optional(),
      local: z.boolean().optional(),
      force: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional()
    }
  },
  async (input) => {
    try {
      const pjanglerRoot = resolvePjanglerRoot2();
      const projectSlug = input.projectSlug ?? slugify(input.projectName);
      const parentDir = resolve2(input.parentDir ?? process.cwd());
      if (!existsSync7(parentDir) || !statSync(parentDir).isDirectory()) throw new Error(`Parent directory does not exist: ${parentDir}`);
      const targetDir = resolve2(input.targetDir ?? join9(parentDir, projectSlug));
      const overwrite = input.overwrite ?? input.force ?? false;
      const dryRun = input.dryRun ?? true;
      const local = input.local ?? true;
      const skipPlane = input.skipPlane ?? true;
      const planeProjectId = input.planeProjectId ?? "";
      if (!skipPlane && !planeProjectId) {
        throw new Error("planeProjectId is required when skipPlane=false; keep skipPlane=true for safe local bootstrap");
      }
      if (existsSync7(targetDir) && !overwrite) throw new Error(`Target already exists: ${targetDir} (set force/overwrite=true to re-render)`);
      const templateDir = join9(pjanglerRoot, "templates", "commonproject");
      const copierAction = buildCommonProjectCopierAction({
        templateDir,
        targetDir,
        projectName: input.projectName,
        projectDescription: input.projectDescription,
        projectSlug,
        ticketProvider: input.ticketProvider ?? "plane",
        planeWorkspace: input.planeWorkspace ?? "33god",
        planeProjectId,
        projectIdentifier: input.projectIdentifier ?? projectSlug.slice(0, 4).toUpperCase(),
        primaryLanguage: input.primaryLanguage ?? "python",
        overwrite
      });
      const actions = [
        { kind: "ensure.parent", path: dirname6(targetDir) },
        copierAction
      ];
      if (input.provisionAgent) {
        actions.push({
          kind: "pjangler.recipe.hermes-agent",
          targetDir,
          context: {
            targetRepo: projectSlug,
            role: input.agentRole ?? "pm",
            agentPurpose: input.agentPurpose ?? `Project manager for ${input.projectName}`,
            local,
            dryRun,
            force: overwrite,
            skipTelegram: true,
            skipEmail: true,
            skipRuntimeRepo: local,
            skipPlane: skipPlane || local,
            skipBloodbank: local,
            skipSystemd: local || process.platform === "darwin"
          }
        });
      }
      if (dryRun) {
        return asText({ ok: true, dryRun, targetDir, projectSlug, actions, guidance: parityGuidance() });
      }
      const which = spawnSync5("which", ["copier"], { encoding: "utf8" });
      if (which.status !== 0) throw new Error("copier not found on PATH. Install with: uv tool install copier or pip install copier");
      mkdirSync5(dirname6(targetDir), { recursive: true });
      const result = spawnSync5(copierAction.command[0], copierAction.command.slice(1), { encoding: "utf8", cwd: pjanglerRoot });
      const logs = [result.stdout.trim()].filter(Boolean);
      const errors = [result.stderr.trim()].filter(Boolean);
      if (result.status !== 0) {
        return asText({ ok: false, dryRun, targetDir, actions, logs, errors, exitCode: result.status });
      }
      let agentResult;
      if (input.provisionAgent) {
        const context = {
          targetDir,
          yes: true,
          targetRepo: projectSlug,
          role: input.agentRole ?? "pm",
          agentPurpose: input.agentPurpose ?? `Project manager for ${input.projectName}`,
          local,
          force: overwrite,
          dryRun: false,
          skipTelegram: true,
          skipEmail: true,
          skipRuntimeRepo: local,
          skipPlane: skipPlane || local,
          skipBloodbank: local,
          skipSystemd: local || process.platform === "darwin"
        };
        agentResult = await runRecipeWithCapture("hermes-agent", context);
      }
      return asText({ ok: !agentResult || agentResult.success, dryRun, targetDir, projectSlug, actions, logs, errors, agentResult });
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
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
    return asText({
      name: info.name,
      description: info.description,
      commands: info.commands
    });
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
        ...asText({
          success: result.success,
          recipe,
          targetDir: resolvedTarget,
          logs: result.logs,
          errors: result.errors
        })
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
    description: "Provision a Hermes agent role for @33god-projects. For safe MCP use local=true defaults skip runtime repo, Plane, Bloodbank, and systemd; opt out with local=false plus explicit skip flags.",
    inputSchema: {
      targetDir: z.string(),
      targetRepo: z.string().optional(),
      role: z.string(),
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      local: z.boolean().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      skipTelegram: z.boolean().optional(),
      skipEmail: z.boolean().optional(),
      skipRuntimeRepo: z.boolean().optional(),
      skipPlane: z.boolean().optional(),
      skipBloodbank: z.boolean().optional(),
      skipSystemd: z.boolean().optional(),
      ticketProvider: TICKET_PROVIDER_SCHEMA.optional()
    }
  },
  async (input) => {
    try {
      const resolvedTarget = resolveTargetDir(input.targetDir);
      const local = input.local ?? true;
      const context = {
        targetDir: resolvedTarget,
        yes: true,
        local,
        targetRepo: input.targetRepo ?? basename2(resolvedTarget),
        role: input.role,
        agentPurpose: input.agentPurpose,
        soulTone: input.soulTone,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        ticketProvider: input.ticketProvider,
        force: input.force ?? false,
        dryRun: input.dryRun ?? false,
        skipTelegram: input.skipTelegram ?? true,
        skipEmail: input.skipEmail ?? true,
        skipRuntimeRepo: input.skipRuntimeRepo ?? local,
        skipPlane: input.skipPlane ?? local,
        skipBloodbank: input.skipBloodbank ?? local,
        skipSystemd: input.skipSystemd ?? (local || process.platform === "darwin")
      };
      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        ...asText({
          success: result.success,
          recipe: "hermes-agent",
          targetDir: resolvedTarget,
          guidance: parityGuidance(),
          context: {
            targetRepo: context.targetRepo,
            role: context.role,
            local: context.local,
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
        })
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
