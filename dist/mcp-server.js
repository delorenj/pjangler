#!/usr/bin/env node

// src/mcp-server.ts
import { existsSync as existsSync9, statSync as statSync2 } from "node:fs";
import { basename as basename4, dirname as dirname8, join as join12, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/commands/Command.ts
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
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
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
};

// src/utils/style.ts
var env = process.env;
function detectColor() {
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== void 0 && force !== "") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}
var colorEnabled = detectColor();
function sgr(open, close) {
  const prefix = `\x1B[${open}m`;
  const suffix = `\x1B[${close}m`;
  return (value) => colorEnabled ? `${prefix}${value}${suffix}` : String(value);
}
var bold = sgr(1, 22);
var dim = sgr(2, 22);
var italic = sgr(3, 23);
var underline = sgr(4, 24);
var red = sgr(31, 39);
var green = sgr(32, 39);
var yellow = sgr(33, 39);
var blue = sgr(34, 39);
var magenta = sgr(35, 39);
var cyan = sgr(36, 39);
var gray = sgr(90, 39);
var glyph = {
  pass: "\u2714",
  fail: "\u2716",
  warn: "\u26A0",
  skip: "\u25CB",
  info: "\u2139",
  arrow: "\u21B3",
  bullet: "\u2022",
  dot: "\xB7",
  add: "+",
  chevron: "\u25B8",
  pointer: "\u276F"
};
var STATUS_STYLES = {
  pass: { glyph: glyph.pass, color: green, label: "pass" },
  fail: { glyph: glyph.fail, color: red, label: "fail" },
  warn: { glyph: glyph.warn, color: yellow, label: "warn" },
  skip: { glyph: glyph.skip, color: gray, label: "skip" },
  applied: { glyph: glyph.pass, color: green, label: "applied" },
  noop: { glyph: glyph.skip, color: gray, label: "noop" },
  blocked: { glyph: glyph.fail, color: red, label: "blocked" },
  skipped: { glyph: glyph.skip, color: gray, label: "skipped" }
};
function statusStyle(status) {
  return STATUS_STYLES[status] ?? { glyph: glyph.dot, color: dim, label: status };
}
function joinDot(fragments) {
  return fragments.join(dim(` ${glyph.dot} `));
}

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
    const subsystem = this.constructor.name.replace("Recipe", "").toLowerCase();
    const dryRun = this.context.dryRun;
    console.log("");
    console.log(`  ${cyan(bold(glyph.chevron))} ${bold(`Initializing ${subsystem} subsystem`)}${dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
    console.log("");
    for (const command of this.ingredients) {
      const result = await command.invoke();
      console.log(result.message.split("\n").map((line) => line ? `  ${line}` : line).join("\n"));
    }
    if (!dryRun) {
      this.printNextSteps();
    } else {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${dim("Dry-run complete \u2014 no files were modified.")}`);
      console.log(`  ${dim("Remove --dry-run to apply changes.")}`);
      console.log("");
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

// src/commands/AddMiseCodegraphScript.ts
import { chmodSync } from "fs";
import { join as join2 } from "path";
var AddMiseCodegraphScript = class extends Command {
  async invoke() {
    const filePath = ".mise/scripts/codegraph.sh";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("\u26A0\uFE0F  .mise/scripts/codegraph.sh already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env bash
# Mise enter hook: ensure the CodeGraph CLI is available and initialize the
# project index. If \`codegraph\` is not installed, this script installs it
# non-interactively into the project-local .mise/bin directory and retries.
#
# This is intended to run from a mise enter hook so onboarding a new host is
# fully automatic.

set -euo pipefail

REPO_ROOT="\${MISE_PROJECT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJECT_BIN_DIR="$REPO_ROOT/.mise/bin"
mkdir -p "$PROJECT_BIN_DIR"

# Install the CodeGraph CLI into the project-local bin directory.
install_codegraph() {
  echo "[mise] codegraph not found. Installing non-interactively..."
  export CODEGRAPH_BIN_DIR="$PROJECT_BIN_DIR"
  curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

  if [ -x "$PROJECT_BIN_DIR/codegraph" ]; then
    export PATH="$PROJECT_BIN_DIR:$PATH"
  else
    echo "[mise] codegraph install did not place a binary at $PROJECT_BIN_DIR/codegraph" >&2
    return 1
  fi
}

# Ensure a codegraph binary is available on PATH.
ensure_codegraph() {
  if command -v codegraph >/dev/null 2>&1; then
    return 0
  fi

  # Check the project-local bin dir first (previous install from this hook).
  if [ -x "$PROJECT_BIN_DIR/codegraph" ]; then
    export PATH="$PROJECT_BIN_DIR:$PATH"
    return 0
  fi

  # Check typical user-level install locations before fetching anything.
  for d in "$HOME/.local/bin" "$HOME/.codegraph/current/bin"; do
    if [ -x "$d/codegraph" ]; then
      export PATH="$d:$PATH"
      return 0
    fi
  done

  install_codegraph
}

# Attempt to initialize the project graph. If the command is missing, install
# it and retry once.
init_project() {
  local err_file
  err_file="$(mktemp)"
  trap 'rm -f "$err_file"' RETURN

  if codegraph init -i "$REPO_ROOT" 2>"$err_file"; then
    return 0
  fi

  # If the failure looks like a missing binary, install and retry.
  if grep -qiE 'command not found|not installed|No such file|executable file not found' "$err_file" 2>/dev/null; then
    ensure_codegraph
    codegraph init -i "$REPO_ROOT"
    return 0
  fi

  cat "$err_file" >&2
  return 1
}

init_project
`;
    this.writeFile(filePath, content);
    if (!this.context.dryRun) {
      chmodSync(join2(this.context.targetDir, filePath), 493);
    }
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/scripts/codegraph.sh" : "\u2705 Created .mise/scripts/codegraph.sh"),
      filePath
    };
  }
};

// src/recipes/MiseRecipe.ts
var MiseRecipe = class extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddMiseToml).addIngredient(AddDotenv).addIngredient(AddMiseTasksStructure).addIngredient(AddMiseBaseToml).addIngredient(AddMiseBaseScript).addIngredient(AddMiseCodegraphScript);
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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3, dirname as dirname2 } from "node:path";
function resolveTemplateConfigPath() {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join3(homedir(), ".config");
  return join3(base, "hermes-agent-template", "config.toml");
}
function detectHermesBin(home) {
  const candidates = [
    join3(home, "code", "hermes-agent", "venv", "bin", "hermes"),
    join3(home, "code", "hermes-agent", ".venv", "bin", "hermes"),
    join3(home, ".local", "bin", "hermes")
  ];
  for (const c of candidates) {
    if (existsSync2(c)) return c;
  }
  return candidates[0];
}
function renderHostConfig() {
  const home = homedir();
  const hermesBin = detectHermesBin(home);
  const hermesRepo = join3(home, "code", "hermes-agent");
  const scaffoldDir = join3(home, "code", "hermes-agent-template", "runtime-scaffold");
  const skillsDir = join3(home, ".agents", "skills");
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
    const exists = existsSync2(path);
    if (exists && !force) {
      console.log(`\u2713 Config present: ${path}`);
      return { success: true, message: "" };
    }
    if (ctx.dryRun) {
      console.log(`[DRY RUN] Would ${exists ? "overwrite" : "create"} config: ${path}`);
      return { success: true, message: "" };
    }
    try {
      mkdirSync2(dirname2(path), { recursive: true });
      writeFileSync2(path, renderHostConfig());
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
import { basename, join as join4 } from "node:path";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";

// src/commands/hermes/types.ts
var HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";
function deriveAgentId(repo, role) {
  return `${repo}-${role}`.toLowerCase();
}
function deriveProfileName(repo, role) {
  return deriveAgentId(repo, role);
}

// src/commands/hermes/PromptForAgentConfig.ts
function detectTicketProvider(targetDir) {
  try {
    const t = JSON.parse(readFileSync(join4(targetDir, ".project.json"), "utf8"))?.ticket_provider?.type;
    return t === "plane" || t === "linear" || t === "trello" ? t : void 0;
  } catch {
    return void 0;
  }
}
var PromptForAgentConfig = class extends Command {
  async invoke() {
    const ctx = this.context;
    const defaultRepo = basename(ctx.targetDir).toLowerCase();
    ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
    ctx.role ??= "pm";
    ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
    ctx.soulTone ??= "direct";
    ctx.modelProvider ??= "";
    ctx.modelName ??= "";
    ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
    ctx.skipEmail ??= true;
    ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
    ctx.profileName = deriveProfileName(ctx.targetRepo, ctx.role);
    if (ctx.yes) {
      ctx.skipTelegram ??= true;
      return {
        success: true,
        message: this.formatMessage(
          `\u2713 Non-interactive mode \u2014 using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        )
      };
    }
    p.intro("\u2695  hermes-agent  \xB7  provision the PM agent for this repo");
    p.log.info(
      `agent ${ctx.agentId}   \xB7   board ${ctx.ticketProvider}   \xB7   tone ${ctx.soulTone}`
    );
    if (ctx.skipTelegram === void 0) {
      const botHandle = `${ctx.targetRepo.replace(/-/g, "_")}_${ctx.role}_bot`;
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${botHandle}) now?`,
        initialValue: true
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }
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
import { join as join5, dirname as dirname3 } from "node:path";
import { existsSync as existsSync3, mkdirSync as mkdirSync3 } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p2 from "@clack/prompts";
function resolveVendoredTemplate(name) {
  let dir;
  try {
    dir = dirname3(fileURLToPath(import.meta.url));
  } catch {
    return void 0;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join5(dir, "templates", name);
    if (existsSync3(join5(candidate, "copier.yml"))) return candidate;
    const parent = dirname3(dir);
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
    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)"
      };
    }
    const roleDir = join5(ctx.targetDir, "agents", "hermes", role);
    ctx.roleDir = roleDir;
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${role}`;
    const which = spawnSync("which", ["copier"], { encoding: "utf8" });
    if (which.status !== 0) {
      return {
        success: false,
        message: "\u2717 copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`"
      };
    }
    if (existsSync3(join5(roleDir, "role.yaml")) && !ctx.force) {
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
    const env2 = {
      ...process.env,
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      // We DO want copier to run runtime-repo + plane + bloodbank + systemd.
      SKIP_RUNTIME_REPO: ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: ctx.skipBloodbank ? "1" : "0",
      SKIP_SYSTEMD: ctx.skipSystemd ? "1" : "0"
    };
    const LOCAL_TEMPLATE = join5(homedir2(), "code", "hermes-agent-template");
    const vendored = resolveVendoredTemplate("hermes-agent");
    const templateSrc = process.env.PJANGLER_HERMES_TEMPLATE || vendored || (existsSync3(join5(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);
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
    mkdirSync3(join5(ctx.targetDir, "agents", "hermes"), { recursive: true });
    const spinner4 = p2.spinner();
    spinner4.start(`Running copier copy  (target: agents/hermes/${role})`);
    const result = spawnSync("copier", args, {
      stdio: "inherit",
      // pass the interactive output through; copier prints its own progress
      env: env2,
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
import { join as join6 } from "node:path";
import { existsSync as existsSync4, unlinkSync } from "node:fs";
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
    const script = join6(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync4(script)) {
      return {
        success: false,
        message: `\u2717 ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`
      };
    }
    const marker = join6(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync4(marker)) unlinkSync(marker);
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
import { join as join7 } from "node:path";
import { existsSync as existsSync5, unlinkSync as unlinkSync2 } from "node:fs";
import * as p4 from "@clack/prompts";
var WireEmail = class extends Command {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipEmail) {
      return { success: true, message: "" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join7(roleDir, ".scripts", "50-email.sh");
    if (!existsSync5(script)) {
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
    const marker = join7(roleDir, ".scripts", ".done-50-email");
    if (existsSync5(marker)) unlinkSync2(marker);
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
    const hb = `hermes-${agentId}-heartbeat.timer`;
    const lines = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    if (!skipEmail) lines.push(`email        ${email}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${csm}`);
    lines.push(`  systemctl --user start ${hb}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram) {
      lines.push("");
      lines.push("Wire Telegram later:");
      lines.push("  pjangler hermes-agent          # re-run and answer yes when asked");
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
import { join as join8, dirname as dirname4 } from "node:path";
import { existsSync as existsSync6, cpSync, mkdirSync as mkdirSync4, readFileSync as readFileSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function resolveTemplateRoot() {
  const candidates = [];
  if (process.env.PJANGLER_COMMONPROJECT_TEMPLATE) {
    candidates.push(process.env.PJANGLER_COMMONPROJECT_TEMPLATE);
  }
  try {
    let dir = dirname4(fileURLToPath2(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join8(dir, "templates", "commonproject", "template"));
      const parent = dirname4(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  candidates.push(join8(homedir3(), "code", "pjangler", "templates", "commonproject", "template"));
  for (const c of candidates) {
    if (existsSync6(join8(c, ".agents", "hooks", "hooks.master.json"))) return c;
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
      const src = join8(templateRoot, rel);
      const dest = join8(this.context.targetDir, rel);
      if (!existsSync6(src)) continue;
      if (existsSync6(dest) && !this.context.force) {
        skipped.push(rel);
        continue;
      }
      if (!this.context.dryRun) {
        mkdirSync4(dirname4(dest), { recursive: true });
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
    const misePath = join8(this.context.targetDir, "mise.toml");
    if (!existsSync6(misePath)) {
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
    if (!this.context.dryRun) writeFileSync3(misePath, content);
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
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript", "AddMiseCodegraphScript"]
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
  AddMiseCodegraphScript: {
    name: "AddMiseCodegraphScript",
    description: "Create .mise/scripts/codegraph.sh enter hook",
    group: "mise",
    class: AddMiseCodegraphScript
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
import { dirname as dirname5, join as join9 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var PJANGLER_VERSION = (() => {
  try {
    let dir = dirname5(fileURLToPath3(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const raw = readFileSync3(join9(dir, "package.json"), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
      } catch {
        const parent = dirname5(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return "0.0.0";
})();

// src/parity/index.ts
import { existsSync as existsSync7, lstatSync, mkdirSync as mkdirSync5, readFileSync as readFileSync4, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4, chmodSync as chmodSync2, copyFileSync } from "node:fs";
import { basename as basename2, dirname as dirname6, join as join10, relative, resolve } from "node:path";
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
var LINK_AGENTFILES_HOOK_ENTRIES = [
  "{{config_root}}/.mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env"
];
var LINK_AGENTFILES_HOOKS_BLOCK = `# This block will handle the linking of
# agent files to the main AGENTS.md file.
#
# TODO: Ensure this works for all levels of nesting.
# i.e. All linked agent files MUST be siblings at
# any given level of nesting.
[hooks]
enter = [
  "{{config_root}}/.mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env",
]`;
var LINK_AGENTFILES_WATCH_TASK_BLOCK = `[[watch_files]]
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
  let dir = dirname6(fileURLToPath4(import.meta.url));
  while (dir !== dirname6(dir)) {
    if (existsSync7(join10(dir, "package.json")) && existsSync7(join10(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname6(dir);
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
  return existsSync7(path) ? readText(path) : null;
}
function ensureParent(path) {
  mkdirSync5(dirname6(path), { recursive: true });
}
function writeText(path, content) {
  ensureParent(path);
  writeFileSync4(path, content);
}
function tryParseJson(text2) {
  if (!text2) return null;
  try {
    return JSON.parse(text2);
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
  if (!existsSync7(path)) return null;
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
function ensureSymlink(path, target, dryRun) {
  if (existsSync7(path)) {
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
  const agentsPath = join10(repoRoot, "AGENTS.md");
  if (existsSync7(agentsPath)) return { changedFiles: [], details: [] };
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const source = join10(repoRoot, file);
    if (!existsSync7(source)) continue;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!dryRun) renameSync(source, agentsPath);
      return { changedFiles: [agentsPath], details: [`Moved ${file} to AGENTS.md before wiring agent-file symlinks`] };
    }
    return { changedFiles: [], details: [], blocked: `${file} exists but is not a regular file; cannot promote to AGENTS.md` };
  }
  const readmePath = join10(repoRoot, "README.md");
  if (existsSync7(readmePath)) {
    const stat = lstatSync(readmePath);
    if (!stat.isFile()) return { changedFiles: [], details: [], blocked: "README.md exists but is not a regular file; cannot copy to AGENTS.md" };
    if (!dryRun) copyFileSync(readmePath, agentsPath);
    return { changedFiles: [agentsPath], details: ["Copied README.md to AGENTS.md before wiring agent-file symlinks"] };
  }
  return { changedFiles: [], details: [], blocked: "AGENTS.md missing and no CLAUDE.md, GEMINI.md, or README.md source exists" };
}
function yamlGet(text2, keyPath) {
  const parts = keyPath.split(".");
  const lines = text2.split("\n");
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
  const rolesDir = join10(repoRoot, "agents", "hermes");
  if (!existsSync7(rolesDir)) return [];
  return readdirSync(rolesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const roleDir = join10(rolesDir, entry.name);
    const roleYamlPath = join10(roleDir, "role.yaml");
    if (!existsSync7(roleYamlPath)) return null;
    const text2 = readText(roleYamlPath);
    const runtimeRepoRaw = yamlGet(text2, "runtime.github_repo");
    return {
      role: yamlGet(text2, "role") || entry.name,
      roleDir,
      roleYamlPath,
      repo: yamlGet(text2, "repo"),
      agentId: yamlGet(text2, "agent_id"),
      profileName: yamlGet(text2, "profile") || yamlGet(text2, "agent_id"),
      displayName: yamlGet(text2, "display_name"),
      purpose: yamlGet(text2, "purpose"),
      botHandle: yamlGet(text2, "telegram.bot_username"),
      runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
      runtimeOwner: yamlGet(text2, "runtime.github_owner"),
      planeWorkspace: yamlGet(text2, "ticket_provider.workspace") || yamlGet(text2, "plane.workspace"),
      ticketProviderName: yamlGet(text2, "ticket_provider.name"),
      ticketProviderBoardId: yamlGet(text2, "ticket_provider.board_id"),
      ticketProviderBoardUrl: yamlGet(text2, "ticket_provider.board_url"),
      ticketProviderIdentifier: yamlGet(text2, "plane.identifier")
    };
  }).filter((value) => Boolean(value));
}
function registryPath(homeDir) {
  return join10(homeDir, ".hermes", "agents-registry.yaml");
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
  const source = join10(ctx.pjanglerRoot, ".mise", "scripts", name);
  return existsSync7(source) ? readText(source) : void 0;
}
function templateVersioningScript(ctx) {
  return templateScript(ctx, "versioning.sh");
}
function templateLinkAgentfilesScript(ctx) {
  return templateScript(ctx, "link-agentfiles.sh");
}
function renderGeneratedProjectMiseToml(ctx, template) {
  const project = readProjectJson(ctx);
  const projectName = String(project?.project_name ?? basename2(ctx.repoRoot) ?? "project");
  return template.replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, "$1").replace(/\{\{\s*project_name\s*\}\}/g, projectName);
}
function ensureMiseTomlFromTemplate(ctx, changedFiles) {
  const targetPath = join10(ctx.repoRoot, "mise.toml");
  if (existsSync7(targetPath)) return false;
  const sourcePath = join10(ctx.pjanglerRoot, "templates", "commonproject", "template", "mise.toml.jinja");
  if (!existsSync7(sourcePath)) return false;
  changedFiles.push(targetPath);
  if (!ctx.dryRun) {
    writeText(targetPath, renderGeneratedProjectMiseToml(ctx, readText(sourcePath)));
  }
  return true;
}
function templateVersionFilesConf(ctx, repoRoot) {
  const packageJson = join10(repoRoot, "package.json");
  return existsSync7(packageJson) ? "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\njson package.json\ngittag .\n" : "# mise-versioning manifest: <type> <path>\n# types: json toml cargo csproj gradle plain gittag\ngittag .\n";
}
function replaceOrAppendManagedBlock(text2, startMarker, block, beforePattern) {
  if (startMarker.test(text2)) {
    return text2.replace(/# >>> mise-versioning >>>[\s\S]*?# <<< mise-versioning <<</, block);
  }
  if (beforePattern) {
    const match = text2.match(beforePattern);
    if (match && typeof match.index === "number") {
      return `${text2.slice(0, match.index).replace(/\s*$/, "\n\n")}${block}

${text2.slice(match.index)}`;
    }
  }
  return `${text2.replace(/\s*$/, "")}

${block}
`;
}
var BASE_MISE_PATH_ENTRIES = [".mise/scripts", "agents/hermes/pm"];
var CONDITIONAL_HERMES_PATHS = ["agents/hermes/pm/hermes", "agent/hermes/pm/hermes"];
function requiredMisePathEntries(ctx) {
  const required = [...BASE_MISE_PATH_ENTRIES];
  for (const candidate of CONDITIONAL_HERMES_PATHS) {
    if (existsSync7(join10(ctx.repoRoot, candidate)) && !required.includes(candidate)) required.push(candidate);
  }
  return required;
}
function upsertMisePath(text2, required = BASE_MISE_PATH_ENTRIES) {
  const render = (values) => `_.path = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const envMatch = text2.match(/(^|\n)(\[env\][\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!envMatch || typeof envMatch.index !== "number") {
    return `[env]
${render(required)}

${text2.replace(/^\s+/, "")}`;
  }
  const prefix = text2.slice(0, envMatch.index + envMatch[1].length);
  const section = envMatch[2];
  const suffix = text2.slice(envMatch.index + envMatch[1].length + section.length);
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
  if (pathLine[0] === nextLine) return text2;
  return `${prefix}${section.replace(pathLine[0], nextLine)}${suffix}`;
}
function removeTomlSection(text2, headerPattern, marker, options) {
  const lines = text2.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!headerPattern.test(lines[i])) continue;
    if (marker) {
      let hasMarker = false;
      for (let j = i + 1; j < lines.length && !/^\[[^\]]+\]/.test(lines[j]); j++) {
        if (marker.test(lines[j])) {
          hasMarker = true;
          break;
        }
      }
      if (!hasMarker) continue;
    }
    start = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\[[^\]]+\]/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end === -1) end = lines.length;
    break;
  }
  if (start === -1) return text2;
  if (options?.includePrecedingComments) {
    while (start > 0 && lines[start - 1].trim().startsWith("#")) {
      start--;
    }
  }
  const result = lines.slice(0, start).concat(lines.slice(end)).join("\n");
  return result.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
function insertTomlBlockBeforeVersioning(text2, block) {
  const versioningIndex = text2.indexOf("# >>> mise-versioning >>>");
  if (versioningIndex >= 0) {
    return `${text2.slice(0, versioningIndex).replace(/\s*$/, "\n\n")}${block}

${text2.slice(versioningIndex)}`;
  }
  return `${text2.replace(/\s*$/, "")}

${block}
`;
}
function extractTomlStrings(text2) {
  const values = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of text2.matchAll(stringPattern)) {
    if (match[1] !== void 0) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch {
        values.push(match[1]);
      }
    } else if (match[2] !== void 0) {
      values.push(match[2]);
    }
  }
  return values;
}
function isManagedHookEntry(value) {
  const trimmed = value.trim();
  return trimmed === "op inject -i .env.op > .env" || /(^|\/)link-agentfiles\.sh$/.test(trimmed);
}
function renderHookEntries(entries, indent = "") {
  return [
    `${indent}enter = [`,
    ...entries.map((entry) => `${indent}  ${JSON.stringify(entry)},`),
    `${indent}]`
  ];
}
function upsertLinkAgentfilesHooks(text2) {
  const lines = text2.split("\n");
  const hooksStart = lines.findIndex((line) => /^\[hooks\]$/.test(line.trim()));
  if (hooksStart === -1) return insertTomlBlockBeforeVersioning(text2, LINK_AGENTFILES_HOOKS_BLOCK);
  let hooksEnd = lines.length;
  for (let i = hooksStart + 1; i < lines.length; i++) {
    if (/^\[[^\]]+\]/.test(lines[i].trim())) {
      hooksEnd = i;
      break;
    }
  }
  let enterStart = -1;
  let enterEnd = -1;
  for (let i = hooksStart + 1; i < hooksEnd; i++) {
    if (!/^\s*enter\s*=/.test(lines[i])) continue;
    enterStart = i;
    enterEnd = i + 1;
    const afterEquals = lines[i].slice(lines[i].indexOf("=") + 1);
    if (afterEquals.includes("[") && !afterEquals.includes("]")) {
      while (enterEnd < hooksEnd && !lines[enterEnd].includes("]")) enterEnd++;
      if (enterEnd < hooksEnd) enterEnd++;
    }
    break;
  }
  const existingBlock = enterStart >= 0 ? lines.slice(enterStart, enterEnd).join("\n") : "";
  const preserved = extractTomlStrings(existingBlock).filter((entry) => !isManagedHookEntry(entry));
  const merged = [...LINK_AGENTFILES_HOOK_ENTRIES];
  for (const entry of preserved) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  const indent = enterStart >= 0 ? lines[enterStart].match(/^\s*/)?.[0] ?? "" : "";
  const rendered = renderHookEntries(merged, indent);
  if (enterStart >= 0) {
    return lines.slice(0, enterStart).concat(rendered, lines.slice(enterEnd)).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  }
  return lines.slice(0, hooksStart + 1).concat(rendered, lines.slice(hooksStart + 1)).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
function upsertLinkAgentfilesBlock(text2, ctx) {
  const withPath = upsertMisePath(text2, requiredMisePathEntries(ctx));
  if (withPath.includes(LINK_AGENTFILES_BLOCK)) return withPath;
  let cleaned = removeTomlSection(withPath, /^\[tasks\.link-agentfiles\]$/, /link-agentfiles/, { includePrecedingComments: false });
  cleaned = removeTomlSection(cleaned, /^\[\[watch_files\]\]$/, /AGENTS\.md/, { includePrecedingComments: false });
  cleaned = upsertLinkAgentfilesHooks(cleaned);
  return insertTomlBlockBeforeVersioning(cleaned, LINK_AGENTFILES_WATCH_TASK_BLOCK);
}
function readProjectJson(ctx) {
  return tryParseJson(safeReadText(join10(ctx.repoRoot, ".project.json")));
}
function canonicalProjectJson(ctx) {
  const roles = discoverRoles(ctx.repoRoot);
  const existing = readProjectJson(ctx) ?? {};
  const slug = String(existing.project_slug ?? slugifyRepoName(dirname6(ctx.repoRoot) === ctx.repoRoot ? ctx.repoRoot.split("/").pop() ?? "project" : ctx.repoRoot.split("/").pop() ?? "project"));
  const firstRole = roles[0];
  const ticketProvider = {
    type: String((existing.ticket_provider?.type ?? firstRole?.ticketProviderName ?? "plane") || "plane"),
    workspace: String((existing.ticket_provider?.workspace ?? firstRole?.planeWorkspace ?? "") || ""),
    identifier: String((existing.ticket_provider?.identifier ?? firstRole?.ticketProviderIdentifier ?? "") || ""),
    board_id: String((existing.ticket_provider?.board_id ?? firstRole?.ticketProviderBoardId ?? "") || ""),
    board_url: String((existing.ticket_provider?.board_url ?? firstRole?.ticketProviderBoardUrl ?? "") || ""),
    state: String((existing.ticket_provider?.state ?? "planned") || "planned")
  };
  const existingAgents = existing.agents ?? {};
  const discoveredAgents = Object.fromEntries(
    roles.map((role) => [
      role.agentId || `${slug}-${role.role}`,
      {
        role: role.role,
        role_dir: relative(ctx.repoRoot, role.roleDir)
      }
    ])
  );
  const agents = { ...existingAgents };
  for (const [agentId, discovered] of Object.entries(discoveredAgents)) {
    const existingAgent = existingAgents[agentId] ?? {};
    agents[agentId] = {
      role: discovered.role,
      role_dir: discovered.role_dir,
      provisioning_state: existingAgent.provisioning_state
    };
  }
  return {
    project_name: String(existing.project_name ?? titleCaseSlug(slug)),
    project_description: String(existing.project_description ?? ""),
    project_slug: slug,
    repo_path: ctx.repoRoot,
    ticket_provider: ticketProvider,
    agents
  };
}
function projectJsonFinding(ctx) {
  const projectPath = join10(ctx.repoRoot, ".project.json");
  const planeJsonPath = join10(ctx.repoRoot, ".plane.json");
  const details = [];
  const data = readProjectJson(ctx);
  const roles = discoverRoles(ctx.repoRoot);
  if (!existsSync7(projectPath)) {
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
  for (const key of ["type", "workspace", "identifier", "board_id", "board_url", "state"]) {
    if (!(key in ticketProvider)) details.push(`ticket_provider.${key} missing`);
  }
  if (existsSync7(planeJsonPath)) details.push(".plane.json should not exist once .project.json is canonical");
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
  const tone = role.role === "pm" ? `Direct and brief. Decision-forward. No throat-clearing, no apologies, no "I'll help you with that" preambles.` : "Direct and brief.";
  const roleSpecific = role.role === "pm" ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checkpoints your runtime; when this repo opts into reconciliation (\`reconcile.enabled\` in role.yaml), the same heartbeat also runs your continuous board-reconciliation pass out-of-band (\`.scripts/sentinel.prompt.md\`, \`--source cron\`), kept separate from your interactive session memory.` : `You operate as the ${role.role} agent for this repo.`;
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

You operate only within the working directory of \`${role.repo}\`. Your HERMES_HOME is the runtime submodule at \`./runtime/\` (repo \`${runtimeOwner}/${role.runtimeRepo}\`), which \`~/.hermes/profiles/${role.profileName || role.agentId}\` symlinks to (so \`--profile\` invocations resolve here too); Hermes loads its \`config.yaml\` directly. Secrets, SOUL, memories, skills, sessions, gateway state, and runtime files all live local to that runtime.

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
# Launcher for ${role.agentId}. Resolves HERMES_HOME to the runtime submodule.

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
HERMES_HOME="$RUNTIME_HOME"

if [[ ! -d "$RUNTIME_HOME" ]]; then
  echo "hermes: runtime submodule not initialized at $RUNTIME_HOME" >&2
  echo "  fix: git submodule update --init --recursive" >&2
  exit 1
fi

exec env HERMES_HOME="$HERMES_HOME" HERMES_FLEET_ENV="$FLEET_ENV"   HERMES_OAUTH_FILE="$HERMES_OAUTH_FILE" CODEX_HOME="$CODEX_HOME"   "$HERMES_BIN" "$@"
`.replace(/\u0010/g, "$");
}
function copyMissingRecursive(sourceDir, targetDir, changedFiles, dryRun, skip) {
  if (!existsSync7(sourceDir)) return;
  mkdirSync5(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join10(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join10(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync7(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}
function upsertSubmodule(repoRoot, role, changedFiles, dryRun) {
  const gitmodulesPath = join10(repoRoot, ".gitmodules");
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
    project_path: ${ctxEscape(role.roleDir ? dirname6(dirname6(dirname6(role.roleDir))) : "")}
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
      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer
`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:
${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}
function profileMetaInheritsDefault(path) {
  const text2 = safeReadText(path);
  return Boolean(
    text2 && /^config:\s*$/m.test(text2) && /^\s+inherit_from:\s*default\s*$/m.test(text2) && /^\s+save_mode:\s*delta\s*$/m.test(text2)
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
      const misePath = join10(ctx.repoRoot, "mise.toml");
      if (!existsSync7(misePath)) {
        return { id: "mise.config-root", title: "mise config_root + AGENTS link hooks", status: "fail", summary: "mise.toml missing", details: [], fixable: true };
      }
      const text2 = readText(misePath);
      const details = [];
      const linkAgentfilesPath = join10(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      if (!existsSync7(linkAgentfilesPath)) details.push(".mise/scripts/link-agentfiles.sh missing");
      const pathValues = [...(text2.match(/^_\.path\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      const missingPathValues = requiredMisePathEntries(ctx).filter((value) => !pathValues.includes(value));
      if (missingPathValues.length) details.push(`[env]._.path should include ${missingPathValues.join(", ")}`);
      if (!text2.includes('"{{config_root}}/.mise/scripts/link-agentfiles.sh"')) details.push("link-agentfiles must use raw {{config_root}} guard");
      if (!text2.includes("op inject -i .env.op > .env")) details.push("[hooks].enter must materialize .env from .env.op");
      if (!text2.includes('patterns = ["AGENTS.md"]')) details.push("watch_files must monitor AGENTS.md");
      if (!text2.includes('task = "link-agentfiles"')) details.push("watch_files must dispatch link-agentfiles task");
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
      const path = join10(ctx.repoRoot, "mise.toml");
      const changedFiles = [];
      const details = [];
      if (!existsSync7(path)) {
        if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
        }
        details.push("Initialized mise.toml from generated-project template");
        if (ctx.dryRun) {
          return { id: finding.id, title: finding.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
        }
      }
      let text2 = readText(path);
      const next = upsertLinkAgentfilesBlock(text2, ctx);
      if (next !== text2) {
        if (!changedFiles.includes(path)) changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, next);
        text2 = next;
      }
      const linkAgentfilesPath = join10(ctx.repoRoot, ".mise", "scripts", "link-agentfiles.sh");
      const expectedScript = templateLinkAgentfilesScript(ctx);
      if (expectedScript === void 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/link-agentfiles.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(linkAgentfilesPath) !== expectedScript) {
        changedFiles.push(linkAgentfilesPath);
        if (!ctx.dryRun) {
          writeText(linkAgentfilesPath, expectedScript);
          chmodSync2(linkAgentfilesPath, 493);
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
      const misePath = join10(ctx.repoRoot, "mise.toml");
      const versioningPath = join10(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const manifestPath = join10(ctx.repoRoot, ".mise", "version-files.conf");
      const text2 = safeReadText(misePath);
      if (!text2?.includes("# >>> mise-versioning >>>")) details.push("mise versioning managed block missing");
      if (!existsSync7(versioningPath)) details.push(".mise/scripts/versioning.sh missing");
      if (!existsSync7(manifestPath)) details.push(".mise/version-files.conf missing");
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
      const details = [];
      const misePath = join10(ctx.repoRoot, "mise.toml");
      if (!existsSync7(misePath)) {
        if (!ensureMiseTomlFromTemplate(ctx, changedFiles)) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: "mise.toml missing and no generated-project mise template available to initialize from", changedFiles, details: [] };
        }
        details.push("Initialized mise.toml from generated-project template");
        if (ctx.dryRun) {
          return { id: finding.id, title: finding.title, status: "applied", summary: "Would initialize mise.toml from generated-project template", changedFiles, details };
        }
      }
      const currentMise = readText(misePath);
      const nextMise = replaceOrAppendManagedBlock(currentMise, /# >>> mise-versioning >>>/, VERSIONING_BLOCK, /^\[tasks\.build\]/m);
      if (nextMise !== currentMise) {
        if (!changedFiles.includes(misePath)) changedFiles.push(misePath);
        if (!ctx.dryRun) writeText(misePath, nextMise);
      }
      const versioningPath = join10(ctx.repoRoot, ".mise", "scripts", "versioning.sh");
      const expectedScript = templateVersioningScript(ctx);
      if (expectedScript === void 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "pjangler install is missing .mise/scripts/versioning.sh \u2014 update @delorenj/pjangler (broken package)", changedFiles, details: [] };
      }
      if (safeReadText(versioningPath) !== expectedScript) {
        changedFiles.push(versioningPath);
        if (!ctx.dryRun) {
          writeText(versioningPath, expectedScript);
          chmodSync2(versioningPath, 493);
        }
      }
      const manifestPath = join10(ctx.repoRoot, ".mise", "version-files.conf");
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
      const agentsPath = join10(ctx.repoRoot, "AGENTS.md");
      if (!existsSync7(agentsPath)) {
        const fallbackSources = ["CLAUDE.md", "GEMINI.md", "README.md"].filter((file) => existsSync7(join10(ctx.repoRoot, file)));
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
        const full = join10(ctx.repoRoot, file);
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
        const full = join10(ctx.repoRoot, file);
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
      const path = join10(ctx.repoRoot, ".project.json");
      const existing = readProjectJson(ctx) ?? {};
      const canonical = canonicalProjectJson(ctx);
      const merged = { ...existing, ...canonical };
      const expected = `${JSON.stringify(merged, null, 2)}
`;
      if (safeReadText(path) !== expected) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, expected);
      }
      const planeJson = join10(ctx.repoRoot, ".plane.json");
      if (existsSync7(planeJson)) {
        const backup = `${planeJson}.migrated-backup`;
        if (existsSync7(backup)) {
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
      const envOp = safeReadText(join10(ctx.repoRoot, ".env.op"));
      const gitignore = safeReadText(join10(ctx.repoRoot, ".gitignore"));
      if (!envOp) {
        details.push(".env.op missing");
      } else {
        const invalidLines = envOp.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).filter((line) => {
          const value = line.slice(line.indexOf("=") + 1).trim();
          const quotedLiteral = /^"[^"\r\n]*"$/.test(value) || /^'[^'\r\n]*'$/.test(value);
          return !value.startsWith("op://") && !/^https?:\/\//.test(value) && !/^[A-Za-z0-9_.:-]+$/.test(value) && !quotedLiteral;
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
      const envOpPath = join10(ctx.repoRoot, ".env.op");
      if (!existsSync7(envOpPath)) {
        changedFiles.push(envOpPath);
        if (!ctx.dryRun) writeText(envOpPath, readText(join10(ctx.pjanglerRoot, "templates", "commonproject", "template", ".env.op")));
      }
      const gitignorePath = join10(ctx.repoRoot, ".gitignore");
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
      const path = join10(ctx.repoRoot, ".copier-answers.yml");
      const text2 = safeReadText(path);
      const project = readProjectJson(ctx);
      if (!text2) {
        details.push(".copier-answers.yml missing");
      } else {
        if (!text2.startsWith("# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY")) details.push("missing Copier overwrite warning header");
        if (!text2.includes("_src_path:")) details.push("_src_path missing");
        if (project?.project_name) {
          const nameMatch = text2.match(/project_name:\s*(.+)/);
          if (!nameMatch || nameMatch[1]?.trim() !== String(project.project_name)) details.push("project_name drift between .copier-answers.yml and .project.json");
        }
        if (project?.project_description) {
          const descMatch = text2.match(/project_description:\s*([\s\S]*?)(?=\n\w|$)/);
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
      const text2 = `# Changes here will be overwritten by Copier; NEVER EDIT MANUALLY
_src_path: ${join10(ctx.pjanglerRoot, "templates", "commonproject")}
project_description: ${String(project.project_description)}
project_name: ${String(project.project_name)}
ticket_provider: ${String(project.ticket_provider?.type ?? "plane")}
`;
      const path = join10(ctx.repoRoot, ".copier-answers.yml");
      if (safeReadText(path) !== text2) {
        changedFiles.push(path);
        if (!ctx.dryRun) writeText(path, text2);
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
      const sourceRoot = join10(ctx.pjanglerRoot, "templates", "commonproject", "_bmad");
      const targetRoot = join10(ctx.repoRoot, "_bmad");
      const sentinels = [
        join10("core", "config.yaml"),
        join10("custom", "config.yaml"),
        join10("custom", "workflows", "ticket-lifecycle", "workflow.yaml"),
        join10("bmm", "workflows", "workflow-status", "workflow.yaml")
      ];
      const missing = sentinels.filter((file) => existsSync7(join10(sourceRoot, file)) && !existsSync7(join10(targetRoot, file)));
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
      copyMissingRecursive(join10(ctx.pjanglerRoot, "templates", "commonproject", "_bmad"), join10(ctx.repoRoot, "_bmad"), changedFiles, ctx.dryRun);
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
      for (const rel of ["role.yaml", "SOUL.md", "hermes", ".gitignore", ".scripts/70-systemd.sh", ".scripts/heartbeat.sh", ".scripts/checkpoint.sh", ".runtime-scaffold/README.md", "runtime/memories/MEMORY.md", "runtime/bloodbank-consumer.py"]) {
        if (!existsSync7(join10(role.roleDir, rel))) details.push(`missing ${relative(ctx.repoRoot, join10(role.roleDir, rel))}`);
      }
      const gitmodules = safeReadText(join10(ctx.repoRoot, ".gitmodules")) ?? "";
      if (!gitmodules.includes(`agents/hermes/${role.role}/runtime`)) details.push(".gitmodules missing pm runtime submodule entry");
      if (!profileMetaInheritsDefault(join10(role.roleDir, "runtime", "profile.yaml"))) {
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
      const templateRoleDir = join10(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      writeIfDifferent(join10(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
      writeIfDifferent(join10(role.roleDir, "hermes"), renderHermesWrapper(role), ctx.dryRun, changedFiles, 493);
      writeIfDifferent(join10(role.roleDir, ".gitignore"), readText(join10(templateRoleDir, ".gitignore.jinja")).replace(/\{\{ role \}\}/g, role.role), ctx.dryRun, changedFiles);
      copyMissingRecursive(join10(templateRoleDir, ".runtime-scaffold"), join10(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join10(templateRoleDir, ".runtime-scaffold"), join10(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
      copyMissingRecursive(join10(templateRoleDir, ".scripts"), join10(role.roleDir, ".scripts"), changedFiles, ctx.dryRun, (source) => source.endsWith("sentinel.prompt.md.jinja"));
      const promptSource = join10(templateRoleDir, ".scripts", "sentinel.prompt.md.jinja");
      const promptTarget = join10(role.roleDir, ".scripts", "sentinel.prompt.md");
      if (existsSync7(promptSource) && !existsSync7(promptTarget)) {
        const prompt = readText(promptSource).replace(/\{\{ agent_id \}\}/g, role.agentId).replace(/\{\{ role \}\}/g, role.role).replace(/\{\{ target_repo \}\}/g, role.repo).replace(/\{\{ display_name \}\}/g, role.displayName || role.agentId);
        writeIfDifferent(promptTarget, prompt, ctx.dryRun, changedFiles);
      }
      upsertSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
      const profileMetaUpdated = upsertInheritedProfileMeta(join10(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
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
        for (const unit of [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-heartbeat.timer`]) {
          const state = checkUnit(unit);
          if (!state.enabled || !state.active) details.push(`${unit} should be enabled+active`);
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
        const sysDir = join10(ctx.homeDir, ".config", "systemd", "user");
        const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-consumer.service`, `hermes-${role.agentId}-heartbeat.timer`];
        const allUnitsPresent = units.every((unit) => existsSync7(join10(sysDir, unit)));
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
        for (const script of [join10(role.roleDir, ".scripts", "70-systemd.sh")]) {
          if (!script || !existsSync7(script)) continue;
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
    if (mode) chmodSync2(path, mode);
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
function runMigrationForRules(ruleIds, repoArg, dryRun) {
  const pjanglerRoot = resolvePjanglerRoot();
  const ctx = {
    repoRoot: resolve(repoArg ?? process.cwd()),
    dryRun,
    pjanglerRoot,
    homeDir: homedir4()
  };
  const selected = RULES.filter((rule) => ruleIds.includes(rule.id));
  if (!selected.length) {
    throw new Error(`Unknown parity rules: ${ruleIds.join(", ")}`);
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
function runMigration(selector, repoArg, dryRun, all) {
  const ruleIds = all ? RULES.map((rule) => rule.id) : selector ? [selector] : [];
  return runMigrationForRules(ruleIds, repoArg, dryRun);
}
function prettyTimestamp(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}
function formatAuditReport(report) {
  const counts = {};
  for (const rule of report.rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const idWidth = report.rules.reduce((width, rule) => Math.max(width, rule.id.length), 0);
  const tally = [];
  if (counts.pass) tally.push(green(`${counts.pass} passed`));
  if (counts.fail) tally.push(red(`${counts.fail} failed`));
  if (counts.warn) tally.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.skip) tally.push(gray(`${counts.skip} skipped`));
  const overall = report.ok ? `${green(glyph.pass)} ${bold("Parity audit passed")}` : `${red(glyph.fail)} ${bold("Parity audit failed")}`;
  const lines = [""];
  lines.push(`  ${overall}${tally.length ? `  ${dim(glyph.dot)}  ${joinDot(tally)}` : ""}`);
  lines.push(`  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(prettyTimestamp(report.auditedAt))}`);
  lines.push("");
  for (const rule of report.rules) {
    const style = statusStyle(rule.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(rule.id.padEnd(idWidth))}  ${rule.summary}`);
    for (const detail of rule.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// src/project/index.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync6, readFileSync as readFileSync5, renameSync as renameSync2, statSync, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { basename as basename3, dirname as dirname7, join as join11, resolve as resolve2 } from "node:path";
import YAML from "yaml";
var PROJECT_REGISTRY_ENV = "PJ_PROJECT_REGISTRY";
var PROJECT_REGISTRY_SCHEMA_VERSION = 1;
var KNOWN_SKILL_ROOTS = [
  "/home/delorenj/code/skillex/all-skills",
  "/home/delorenj/code/CoachingAgentFramework/.agents/skills",
  "/home/delorenj/code/pjangler/.agents/skills",
  join11(homedir5(), ".codex", "skills")
];
function projectRegistryPath(env2 = process.env) {
  return expandHome(env2[PROJECT_REGISTRY_ENV] || join11(homedir5(), ".config", "pjangler", "projects.yaml"));
}
function emptyProjectRegistry() {
  return { schema_version: PROJECT_REGISTRY_SCHEMA_VERSION, projects: {} };
}
function loadProjectRegistry(path = projectRegistryPath()) {
  if (!existsSync8(path)) return emptyProjectRegistry();
  const raw = YAML.parse(readFileSync5(path, "utf8"));
  if (raw == null) return emptyProjectRegistry();
  if (!isRecord(raw)) throw new Error(`Project registry must be a mapping: ${path}`);
  const registry = raw;
  const normalized = {
    schema_version: Number(registry.schema_version ?? PROJECT_REGISTRY_SCHEMA_VERSION),
    projects: isRecord(registry.projects) ? registry.projects : {}
  };
  validateProjectRegistry(normalized);
  return normalized;
}
function saveProjectRegistry(registry, path = projectRegistryPath()) {
  validateProjectRegistry(registry);
  mkdirSync6(dirname7(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync5(temp, YAML.stringify(registry, { lineWidth: 0 }), "utf8");
  renameSync2(temp, path);
}
function validateProjectRegistry(registry) {
  if (registry.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project registry schema_version: ${registry.schema_version}`);
  }
  if (!isRecord(registry.projects)) throw new Error("Project registry projects must be a mapping");
  const slugs = /* @__PURE__ */ new Set();
  const repoPaths = /* @__PURE__ */ new Map();
  const identifiers = /* @__PURE__ */ new Map();
  for (const [slug, project] of Object.entries(registry.projects)) {
    validateProjectRecord(project, slug);
    if (slugs.has(project.slug)) throw new Error(`Duplicate project slug: ${project.slug}`);
    slugs.add(project.slug);
    const repoKey = resolve2(project.repo_path);
    const existingRepoSlug = repoPaths.get(repoKey);
    if (existingRepoSlug && existingRepoSlug !== slug) {
      throw new Error(`Duplicate project repo_path: ${project.repo_path} used by ${existingRepoSlug} and ${slug}`);
    }
    repoPaths.set(repoKey, slug);
    const identifier = project.ticket_provider.identifier?.toUpperCase();
    if (identifier) {
      const existingIdentifierSlug = identifiers.get(identifier);
      if (existingIdentifierSlug && existingIdentifierSlug !== slug) {
        throw new Error(`Duplicate project identifier: ${identifier} used by ${existingIdentifierSlug} and ${slug}`);
      }
      identifiers.set(identifier, slug);
    }
  }
}
function slugifyProjectName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function deriveProjectIdentifier(value) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const identifier = compact.slice(0, 4) || "PROJ";
  return identifier.length >= 2 ? identifier : `${identifier}XX`.slice(0, 4);
}
function normalizeAgentRole(value) {
  return value?.trim() || "pm";
}
function jsonStable(value) {
  return JSON.stringify(value);
}
function projectRecordEquivalent(a, b) {
  if (!a) return false;
  const { created_at: _aCreated, updated_at: _aUpdated, ...aComparable } = a;
  const { created_at: _bCreated, updated_at: _bUpdated, ...bComparable } = b;
  return jsonStable(aComparable) === jsonStable(bComparable);
}
function defaultProjectTargetDir(name, cwd = process.cwd()) {
  const compactName = name.replace(/[^A-Za-z0-9._-]/g, "") || slugifyProjectName(name);
  return resolve2(dirname7(resolve2(cwd)), compactName);
}
function resolveSourceSkillPath(sourceSkill) {
  if (!sourceSkill) return void 0;
  const expanded = expandHome(sourceSkill);
  const direct = resolve2(expanded);
  if (existsSync8(direct)) return direct;
  const name = basename3(sourceSkill);
  for (const root of KNOWN_SKILL_ROOTS) {
    const candidate = join11(root, name);
    if (existsSync8(candidate)) return candidate;
  }
  const civilWarLetterifier = "/home/delorenj/code/skillex/all-skills/civilwar-letterifier";
  const hint = existsSync8(civilWarLetterifier) ? ` Did you mean ${civilWarLetterifier}?` : "";
  throw new Error(`Source skill not found: ${sourceSkill}.${hint}`);
}
function planProjectInit(input) {
  if (!input.name.trim()) throw new Error("Project name is required");
  const registryPath2 = resolve2(projectRegistryPath({ ...process.env, [PROJECT_REGISTRY_ENV]: input.registryPath || process.env[PROJECT_REGISTRY_ENV] }));
  const registry = loadProjectRegistry(registryPath2);
  const now = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
  const slug = input.projectSlug ?? slugifyProjectName(input.name);
  const targetDir = resolve2(input.targetDir ?? defaultProjectTargetDir(input.name, input.cwd));
  const identifier = (input.projectIdentifier ?? deriveProjectIdentifier(input.name)).toUpperCase();
  const existing = registry.projects[slug];
  const sourceSkillPath = resolveSourceSkillPath(input.sourceSkill);
  const overwrite = input.overwrite ?? input.force ?? false;
  const agentRole = normalizeAgentRole(input.agentRole);
  const agents = input.provisionAgent ? {
    ...existing?.agents ?? {},
    [agentRole]: {
      role: agentRole,
      provisioning_state: "planned"
    }
  } : existing?.agents ?? {};
  const scaffold = input.scaffold ?? true;
  const candidateProject = {
    name: input.name,
    slug,
    repo_path: targetDir,
    description: input.description ?? "",
    status: "planned",
    source_artifacts: sourceSkillPath ? [{ kind: "skill", path: sourceSkillPath, package_name: input.packageName ?? slug }] : [],
    template: {
      commonproject: {
        enabled: true,
        primary_language: input.primaryLanguage ?? "python"
      }
    },
    ticket_provider: {
      type: input.ticketProvider ?? "plane",
      workspace: input.planeWorkspace ?? "33god",
      identifier,
      board_id: input.planeProjectId ?? "",
      board_url: input.planeProjectId ? `https://plane.delo.sh/${input.planeWorkspace ?? "33god"}/projects/${input.planeProjectId}/issues/` : "",
      state: input.live ? "planned" : "planned"
    },
    agents,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  const project = {
    ...candidateProject,
    updated_at: projectRecordEquivalent(existing, candidateProject) ? existing.updated_at : now
  };
  validateNoDuplicateProject(registry, project, overwrite);
  const pjanglerRoot = resolve2(input.pjanglerRoot ?? resolvePjanglerRoot2());
  const manifest = projectManifestFromRegistryProject(project);
  const apply = input.apply ?? false;
  const live = input.live ?? false;
  const actions = [
    { kind: "registry.upsert", registryPath: registryPath2, slug, project }
  ];
  if (scaffold) {
    actions.push(buildCommonProjectCopierAction({
      pjanglerRoot,
      targetDir,
      projectName: project.name,
      projectDescription: project.description,
      projectSlug: project.slug,
      ticketProvider: project.ticket_provider.type,
      planeWorkspace: project.ticket_provider.workspace ?? "33god",
      planeProjectId: project.ticket_provider.board_id ?? "",
      projectIdentifier: identifier,
      primaryLanguage: project.template.commonproject.primary_language,
      overwrite
    }));
  }
  actions.push(
    { kind: "project.write-manifest", path: join11(targetDir, ".project.json"), manifest },
    {
      kind: "plane.create-or-link",
      enabled: live,
      live,
      workspace: project.ticket_provider.workspace ?? "33god",
      identifier,
      state: live ? "planned" : "planned",
      reason: live ? void 0 : "network/cloud actions require --live"
    },
    {
      kind: "hermes.provision-agent",
      enabled: input.provisionAgent ?? false,
      local: !live,
      targetDir,
      targetRepo: slug,
      role: agentRole,
      context: {
        skipRuntimeRepo: !live,
        skipPlane: !live,
        skipBloodbank: !live,
        skipSystemd: !live || process.platform === "darwin"
      }
    }
  );
  return { ok: true, apply, dryRun: !apply, live, registryPath: registryPath2, project, manifest, actions };
}
function executeProjectInitPlan(plan) {
  const logs = [];
  const errors = [];
  const changedFiles = [];
  if (!plan.apply) return { ok: true, plan, logs, errors, changedFiles };
  const registry = loadProjectRegistry(plan.registryPath);
  let pendingRegistryAction;
  for (const action of plan.actions) {
    if (action.kind === "copier.copy.commonproject") {
      mkdirSync6(dirname7(action.targetDir), { recursive: true });
      const result = spawnSync5(action.command[0], action.command.slice(1), { encoding: "utf8", cwd: action.cwd });
      if (result.stdout?.trim()) logs.push(result.stdout.trim());
      if (result.stderr?.trim()) logs.push(result.stderr.trim());
      if (result.error) {
        const code = result.error.code;
        errors.push(
          code === "ENOENT" ? "copier not found on PATH. Install with: uv tool install copier or pip install copier" : `copier failed: ${result.error.message}`
        );
        break;
      }
      if (result.status !== 0) {
        errors.push(`copier exited with status ${result.status ?? "unknown"}`);
        if (existsSync8(action.targetDir)) changedFiles.push(action.targetDir);
        break;
      }
      changedFiles.push(action.targetDir);
    } else if (action.kind === "project.write-manifest") {
      mkdirSync6(dirname7(action.path), { recursive: true });
      const next = `${JSON.stringify(action.manifest, null, 2)}
`;
      const current = existsSync8(action.path) ? readFileSync5(action.path, "utf8") : void 0;
      if (current !== next) {
        writeFileSync5(action.path, next, "utf8");
        changedFiles.push(action.path);
      }
    } else if (action.kind === "registry.upsert") {
      pendingRegistryAction = action;
    } else if (action.kind === "plane.create-or-link") {
      logs.push(action.enabled ? "plane.create-or-link requires a live provider integration" : "plane.create-or-link skipped (requires --live)");
    } else if (action.kind === "hermes.provision-agent") {
      logs.push(action.enabled ? "hermes.provision-agent planned for the caller to execute" : "hermes.provision-agent skipped");
    }
  }
  if (pendingRegistryAction && errors.length === 0) {
    if (!projectRecordEquivalent(registry.projects[pendingRegistryAction.slug], pendingRegistryAction.project)) {
      registry.projects[pendingRegistryAction.slug] = pendingRegistryAction.project;
      saveProjectRegistry(registry, pendingRegistryAction.registryPath);
      changedFiles.push(pendingRegistryAction.registryPath);
    }
  }
  return { ok: errors.length === 0, plan, logs, errors, changedFiles };
}
function projectManifestFromRegistryProject(project) {
  const agents = Object.fromEntries(
    Object.entries(project.agents).map(([name, agent]) => [
      `${project.slug}-${name}`,
      {
        role: agent.role,
        role_dir: agent.role_dir,
        provisioning_state: agent.provisioning_state
      }
    ])
  );
  return {
    project_name: project.name,
    project_description: project.description,
    project_slug: project.slug,
    repo_path: project.repo_path,
    ticket_provider: {
      type: project.ticket_provider.type,
      workspace: project.ticket_provider.workspace ?? "",
      identifier: project.ticket_provider.identifier ?? "",
      board_id: project.ticket_provider.board_id ?? "",
      board_url: project.ticket_provider.board_url ?? "",
      state: project.ticket_provider.state
    },
    agents
  };
}
function getProject(registry, slug) {
  const project = registry.projects[slug];
  if (!project) throw new Error(`Project not found in registry: ${slug}`);
  return project;
}
function buildCommonProjectCopierAction(input) {
  const templateDir = join11(input.pjanglerRoot, "templates", "commonproject");
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
  const command = ["copier", "copy", "--trust", templateDir, input.targetDir, "--defaults"];
  for (const [key, value] of Object.entries(data)) command.push("--data", `${key}=${value}`);
  if (input.overwrite) command.push("--overwrite");
  return {
    kind: "copier.copy.commonproject",
    cwd: input.pjanglerRoot,
    command,
    targetDir: input.targetDir,
    data,
    overwrite: input.overwrite
  };
}
function resolvePjanglerRoot2() {
  let dir = dirname7(new URL(import.meta.url).pathname);
  while (dir !== dirname7(dir)) {
    if (existsSync8(join11(dir, "package.json")) && existsSync8(join11(dir, "templates", "commonproject", "copier.yml"))) return dir;
    dir = dirname7(dir);
  }
  return resolve2(process.cwd());
}
function validateNoDuplicateProject(registry, project, overwrite) {
  const existingSameSlug = registry.projects[project.slug];
  if (existingSameSlug && !overwrite && resolve2(existingSameSlug.repo_path) !== resolve2(project.repo_path)) {
    throw new Error(`Project slug already exists in registry: ${project.slug}`);
  }
  for (const [slug, existing] of Object.entries(registry.projects)) {
    if (slug === project.slug) continue;
    if (resolve2(existing.repo_path) === resolve2(project.repo_path)) {
      throw new Error(`Project repo_path already registered by ${slug}: ${project.repo_path}`);
    }
    if (existing.ticket_provider.identifier && existing.ticket_provider.identifier.toUpperCase() === project.ticket_provider.identifier?.toUpperCase()) {
      throw new Error(`Project identifier already registered by ${slug}: ${project.ticket_provider.identifier}`);
    }
  }
}
function validateProjectRecord(project, key) {
  if (!isRecord(project)) throw new Error(`Project ${key} must be a mapping`);
  if (!project.name) throw new Error(`Project ${key} missing name`);
  if (!project.slug) throw new Error(`Project ${key} missing slug`);
  if (project.slug !== key) throw new Error(`Project key ${key} does not match slug ${project.slug}`);
  if (!project.repo_path) throw new Error(`Project ${key} missing repo_path`);
  if (!Array.isArray(project.source_artifacts)) throw new Error(`Project ${key} source_artifacts must be a list`);
  if (!isRecord(project.ticket_provider)) throw new Error(`Project ${key} ticket_provider must be a mapping`);
  if (!isRecord(project.agents)) throw new Error(`Project ${key} agents must be a mapping`);
}
function expandHome(path) {
  if (path === "~") return homedir5();
  if (path.startsWith("~/")) return join11(homedir5(), path.slice(2));
  return path;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/mcp-server.ts
var server = new McpServer({
  name: "pjangler-mcp",
  version: PJANGLER_VERSION
});
var TICKET_PROVIDER_SCHEMA = z.enum(["plane", "linear", "trello"]);
function resolveTargetDir(targetDir) {
  const dir = resolve3(targetDir ?? process.cwd());
  if (!existsSync9(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync2(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}
function resolvePjanglerRoot3() {
  let dir = dirname8(fileURLToPath5(import.meta.url));
  while (dir !== dirname8(dir)) {
    if (existsSync9(join12(dir, "package.json")) && existsSync9(join12(dir, "templates", "commonproject", "copier.yml"))) {
      return dir;
    }
    dir = dirname8(dir);
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
        new33godProject: ["pjangler_project_init", "pjangler_bootstrap_33god_project", "pjangler_audit_project"],
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
      dryRun: z.boolean().optional(),
      registryPath: z.string().optional(),
      sourceSkill: z.string().optional(),
      live: z.boolean().optional()
    }
  },
  async (input) => {
    try {
      const pjanglerRoot = resolvePjanglerRoot3();
      const projectSlug = input.projectSlug ?? slugify(input.projectName);
      const parentDir = resolve3(input.parentDir ?? process.cwd());
      if (!existsSync9(parentDir) || !statSync2(parentDir).isDirectory()) throw new Error(`Parent directory does not exist: ${parentDir}`);
      const targetDir = resolve3(input.targetDir ?? join12(parentDir, projectSlug));
      const overwrite = input.overwrite ?? input.force ?? false;
      const dryRun = input.dryRun ?? true;
      const local = input.local ?? true;
      const skipPlane = input.skipPlane ?? true;
      const planeProjectId = input.planeProjectId ?? "";
      if (!skipPlane && !planeProjectId) {
        throw new Error("planeProjectId is required when skipPlane=false; keep skipPlane=true for safe local bootstrap");
      }
      if (!dryRun && existsSync9(targetDir) && !overwrite) throw new Error(`Target already exists: ${targetDir} (set force/overwrite=true to re-render)`);
      const plan = planProjectInit({
        name: input.projectName,
        description: input.projectDescription,
        targetDir,
        projectSlug,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage ?? "python",
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole ?? "pm",
        apply: !dryRun,
        live: input.live ?? false,
        registryPath: input.registryPath,
        projectIdentifier: input.projectIdentifier ?? projectSlug.slice(0, 4).toUpperCase(),
        ticketProvider: input.ticketProvider ?? "plane",
        planeWorkspace: input.planeWorkspace ?? "33god",
        planeProjectId,
        pjanglerRoot,
        overwrite
      });
      if (dryRun) {
        return asText({ ...plan, guidance: parityGuidance() });
      }
      const result = executeProjectInitPlan(plan);
      if (!result.ok) return asText({ ...result, guidance: parityGuidance() });
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
      return asText({ ...result, ok: result.ok && (!agentResult || agentResult.success), agentResult, guidance: parityGuidance() });
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_project_init",
  {
    title: "Initialize a pjangler project",
    description: "Plan or apply a registry-backed CommonProject project init. Dry-run is the default; writes require apply=true and live actions require live=true.",
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      targetDir: z.string().optional(),
      sourceSkill: z.string().optional(),
      primaryLanguage: z.string().optional(),
      provisionAgent: z.boolean().optional(),
      agentRole: z.string().optional(),
      apply: z.boolean().optional(),
      live: z.boolean().optional(),
      slug: z.string().optional(),
      identifier: z.string().optional(),
      registryPath: z.string().optional(),
      force: z.boolean().optional()
    }
  },
  async (input) => {
    try {
      const plan = planProjectInit({
        name: input.name,
        description: input.description,
        targetDir: input.targetDir,
        sourceSkill: input.sourceSkill,
        primaryLanguage: input.primaryLanguage,
        provisionAgent: input.provisionAgent ?? false,
        agentRole: input.agentRole,
        apply: input.apply ?? false,
        live: input.live ?? false,
        projectSlug: input.slug,
        projectIdentifier: input.identifier,
        registryPath: input.registryPath,
        force: input.force ?? false,
        overwrite: input.force ?? false
      });
      if (!input.apply) return asText(plan);
      return asText(executeProjectInitPlan(plan));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);
server.registerTool(
  "pjangler_project_list",
  {
    title: "List pjangler registry projects",
    description: "Return projects from the pjangler central registry.",
    inputSchema: {
      registryPath: z.string().optional()
    }
  },
  async ({ registryPath: registryPath2 }) => asText(loadProjectRegistry(registryPath2 ?? projectRegistryPath()))
);
server.registerTool(
  "pjangler_project_show",
  {
    title: "Show a pjangler registry project",
    description: "Return one project by slug from the pjangler central registry.",
    inputSchema: {
      slug: z.string(),
      registryPath: z.string().optional()
    }
  },
  async ({ slug, registryPath: registryPath2 }) => {
    try {
      return asText(getProject(loadProjectRegistry(registryPath2 ?? projectRegistryPath()), slug));
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
      role: z.enum(["pm", "dev", "review", "ops", "qa"]),
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
        targetRepo: input.targetRepo ?? basename4(resolvedTarget),
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
