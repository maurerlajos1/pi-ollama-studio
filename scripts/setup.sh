#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19+ is required by the current Pi release." >&2
  exit 1
fi

node - <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`Node.js 22.19+ is required by the current Pi release; found ${process.version}.`);
  process.exit(1);
}
NODE

if ! command -v ollama >/dev/null 2>&1; then
  echo "Warning: ollama is not on PATH. Install Ollama before using the app." >&2
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "Installing Pi coding agent..."
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
fi

npm run verify
cat <<'MSG'

Setup complete.

1. Start Ollama, or use the app's Managed Ollama controls:
   OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=65536 OLLAMA_NO_CLOUD=1 ollama serve

2. Start Pi Ollama Studio:
   npm start

3. Open http://127.0.0.1:4173
MSG
