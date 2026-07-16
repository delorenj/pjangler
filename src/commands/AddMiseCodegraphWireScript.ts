import { chmodSync } from "fs";
import { join } from "path";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseCodegraphWireScript extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".mise/scripts/codegraph-wire.sh";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/scripts/codegraph-wire.sh already exists"),
        filePath
      };
    }

    const content = `#!/usr/bin/env bash
# Mise enter hook: Auto-wire CodeGraph MCP Server to local agents.
# Detects Claude Code, Codex, Gemini, Kimi, and OpenCode and configures
# them to use the local SSE endpoint for the current project.

set -euo pipefail

REPO_ROOT="\${MISE_PROJECT_ROOT:-\$(cd "\$(dirname "\$0")/../.." && pwd)}"

# Compute the same port as the container script
PORT_HASH=\$(echo -n "\$REPO_ROOT" | md5sum | awk '{print \$1}')
PORT_DEC=\$(printf "%d" "0x\${PORT_HASH:0:4}")
PORT=\$(( 8045 + (PORT_DEC % 955) ))

SSE_URL="http://localhost:\$PORT/sse"

inject_sse() {
  local target="\$1"
  local agent="\$2"
  
  if [ ! -f "\$target" ]; then
    mkdir -p "\$(dirname "\$target")"
    echo '{"mcpServers": {}}' > "\$target"
  fi
  
  # Ensure the file is valid JSON (fail gracefully if it's garbled)
  if ! jq . "\$target" >/dev/null 2>&1; then
    echo "[mise] WARNING: \$target is not valid JSON, skipping \$agent wiring" >&2
    return
  fi

  # Inject or update the codegraph server
  jq --arg url "\$SSE_URL" '.mcpServers.codegraph = {"type": "sse", "url": \$url}' "\$target" > "\$target.tmp" && mv "\$target.tmp" "\$target"
  echo "[mise] Wired CodeGraph SSE for \$agent -> \$target"
}

# 1. Claude Code (Project-scoped)
inject_sse "\$REPO_ROOT/.claude.json" "Claude Code"

# 2. Codex (Global)
inject_sse "\$HOME/.codex/mcp.json" "Codex"

# 3. Gemini (Global)
inject_sse "\$HOME/.gemini/config/mcp.json" "Gemini"

# 4. Kimi (Global)
inject_sse "\$HOME/.kimi-code/mcp.json" "Kimi"

# 5. OpenCode (Global)
inject_sse "\$HOME/.opencode/mcp.json" "OpenCode"

# 6. Cursor (Global)
inject_sse "\$HOME/.cursor/mcp.json" "Cursor"

# 7. VSCode native MCP (Global)
inject_sse "\$HOME/.vscode/mcp.json" "VSCode"

# 8. Cline (VSCode extension)
inject_sse "\$HOME/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json" "Cline"

# 9. Roo (VSCode extension)
inject_sse "\$HOME/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json" "Roo Code"
`;

    this.writeFile(filePath, content);

    if (!this.context.dryRun) {
      chmodSync(join(this.context.targetDir, filePath), 0o755);
    }

    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/scripts/codegraph-wire.sh" : "✅ Created .mise/scripts/codegraph-wire.sh"),
      filePath
    };
  }
}
