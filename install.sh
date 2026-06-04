#!/usr/bin/env bash
# Install / register the project-memory MCP server on this machine.
# Run from inside the cloned .memory-server directory:  ./install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$HERE/index.js"

# Where your projects live. Defaults to the parent of this dir (the classic
# ~/code/.memory-server layout). Override if you cloned the server elsewhere:
#   PROJECT_MEMORY_ROOT=~/work ./install.sh
ROOT="${PROJECT_MEMORY_ROOT:-$(cd "$HERE/.." && pwd)}"

echo "Server entry : $ENTRY"
echo "Projects root: $ROOT"

echo "==> Installing dependencies"
if [ -f "$HERE/package-lock.json" ]; then (cd "$HERE" && npm ci --silent); else (cd "$HERE" && npm install --silent); fi

# --- Claude Code (user scope = available in every project) ---
if command -v claude >/dev/null 2>&1; then
  echo "==> Registering with Claude Code"
  claude mcp remove project-memory -s user >/dev/null 2>&1 || true
  if [ "$ROOT" = "$(cd "$HERE/.." && pwd)" ]; then
    claude mcp add project-memory -s user -- node "$ENTRY"
  else
    claude mcp add project-memory -s user -e "PROJECT_MEMORY_ROOT=$ROOT" -- node "$ENTRY"
  fi
else
  echo "!! 'claude' CLI not found — skipping Claude Code registration"
fi

# --- Cursor (global config, merged so other MCP servers are preserved) ---
echo "==> Registering with Cursor (~/.cursor/mcp.json)"
mkdir -p "$HOME/.cursor"
CURSOR_CFG="$HOME/.cursor/mcp.json"
[ -f "$CURSOR_CFG" ] || echo '{"mcpServers":{}}' > "$CURSOR_CFG"
ENTRY="$ENTRY" ROOT="$ROOT" HERE="$HERE" node <<'NODE'
const fs = require("fs");
const cfg = process.env.HOME + "/.cursor/mcp.json";
let j = {};
try { j = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch {}
j.mcpServers = j.mcpServers || {};
const entry = { command: "node", args: [process.env.ENTRY] };
const sameDefault = process.env.ROOT === require("path").resolve(process.env.HERE, "..");
if (!sameDefault) entry.env = { PROJECT_MEMORY_ROOT: process.env.ROOT };
j.mcpServers["project-memory"] = entry;
fs.writeFileSync(cfg, JSON.stringify(j, null, 2) + "\n");
console.log("   updated " + cfg);
NODE

echo ""
echo "Done. Restart Claude Code / Cursor to pick up the server."
echo "Try: \"list my projects\" or \"search my issues for <term>\"."
