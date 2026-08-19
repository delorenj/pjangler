#!/usr/bin/env bash
# Put pjangler's executables on PATH in a way that survives a node upgrade.
#
# `npm i -g` under mise installs into the ACTIVE node version's bin directory
# (~/.local/share/mise/installs/node/<ver>/bin). mise hands each project its own
# node, so those bins vanish the moment you stand in a project pinned to a
# different version — and pjangler pins 26.4 while the machine default is 26.5.
#
# The failure is silent and easy to misread. `pjangler-prompt` is what starship's
# custom.pjangler module shells out to, and per that module's contract "no
# output" is how the segment hides. A missing binary therefore looks exactly like
# "not a pjangler project": the prompt line simply never appears, everywhere
# except this repo.
#
# ~/.local/bin is on PATH regardless of which node is active, so linking there
# once makes every surface — prompt segment, `board`, the MCP server — work from
# any directory.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dist="$repo_root/dist"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"

if [ ! -f "$dist/index.js" ]; then
  echo "✖ $dist/index.js is missing — run 'mise run build' first" >&2
  exit 1
fi

mkdir -p "$bin_dir"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "⚠ $bin_dir is not on PATH; the links will exist but resolve nowhere" >&2 ;;
esac

link() {
  local name="$1" target="$2"
  [ -f "$target" ] || { echo "  skip $name (no $target)"; return 0; }
  chmod +x "$target"
  ln -sfn "$target" "$bin_dir/$name"
  echo "  $name -> $target"
}

echo "Linking pjangler bins into $bin_dir"
link pjangler        "$dist/index.js"
link pj              "$dist/index.js"
link pjangler-prompt "$dist/prompt.js"
link pjangler-mcp    "$dist/mcp-server.js"

echo
echo "Verify from a directory outside this repo:"
echo "  cd ~ && pjangler-prompt --url"
