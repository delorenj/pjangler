import { chmodSync } from "fs";
import { join } from "path";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseCodegraphScript extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".mise/scripts/codegraph.sh";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/scripts/codegraph.sh already exists"),
        filePath
      };
    }

    const content = `#!/usr/bin/env bash
# Mise enter hook: ensure the CodeGraph MCP Server is running via Docker.
# This containerized approach ensures zero host dependencies and live-syncs
# the graph. The agent connects to it via SSE (Server-Sent Events).

set -euo pipefail

REPO_ROOT="\${MISE_PROJECT_ROOT:-\$(cd "\$(dirname "\$0")/../.." && pwd)}"
PROJECT_NAME="\$(basename "\$REPO_ROOT")"
CONTAINER_NAME="codegraph-mcp-\$PROJECT_NAME"
CACHE_DIR="\$REPO_ROOT/.codegraph_cache"

mkdir -p "\$CACHE_DIR"

# Generate a consistent port between 8045 and 8999 based on REPO_ROOT
PORT_HASH=\$(echo -n "\$REPO_ROOT" | md5sum | awk '{print \$1}')
PORT_DEC=\$(printf "%d" "0x\${PORT_HASH:0:4}")
PORT=\$(( 8045 + (PORT_DEC % 955) ))

if ! docker ps -q -f name="^/\${CONTAINER_NAME}\$" >/dev/null 2>&1; then
  echo "[mise] Starting CodeGraph MCP Docker container..."
  
  # Remove stopped container if it exists
  docker rm -f "\$CONTAINER_NAME" >/dev/null 2>&1 || true

  # We mount the repo to the EXACT same path so absolute paths from agents match
  docker run -d \\
    --name="\$CONTAINER_NAME" \\
    --restart=unless-stopped \\
    -p "\$PORT:8045" \\
    -v "\$CACHE_DIR:/home/node/.cache" \\
    -v "\$REPO_ROOT:\$REPO_ROOT" \\
    -e PORT=8045 \\
    -e PUID="\$(id -u)" \\
    -e PGID="\$(id -g)" \\
    -e PROTOCOL=HTTP \\
    -e ENABLE_HTTPS=false \\
    mekayelanik/codegraphcontext-mcp:stable >/dev/null

  echo "[mise] CodeGraph SSE running at http://localhost:\$PORT/sse"
fi

# Run init inside the container to ensure the index is bootstrapped.
# The MCP server process will maintain live sync automatically.
docker exec "\$CONTAINER_NAME" codegraph init -i "\$REPO_ROOT" >/dev/null 2>&1 || true

# Wire up the MCP server to local agents
WIRE_SCRIPT="\$(dirname "\$0")/codegraph-wire.sh"
if [ -x "\$WIRE_SCRIPT" ]; then
  "\$WIRE_SCRIPT"
fi
`;

    this.writeFile(filePath, content);

    if (!this.context.dryRun) {
      chmodSync(join(this.context.targetDir, filePath), 0o755);
    }

    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/scripts/codegraph.sh" : "✅ Created .mise/scripts/codegraph.sh"),
      filePath
    };
  }
}
