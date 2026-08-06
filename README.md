# Pi Ollama Studio

A local, desktop-style coding workspace built on the **real Pi coding-agent RPC process** and **Ollama**. It gives Pi a Codex/Antigravity-like browser UI while keeping Pi responsible for the agent loop, tools, skills, extensions, context, compaction, retries, and session files.

The application has no project runtime dependencies. The control server, API, event stream, file editor, and UI use Node.js and browser APIs directly.

## In-app documentation

Version 1.1.2 includes a searchable **Documentation** workspace directly inside the application. It includes:

- A quick-start guide
- A visual explanation of the application’s core request and agent flow
- Pi agent controls and message-delivery behavior
- Ollama models, persistent profiles, and sampling controls
- Context-window, KV-cache, VRAM, and offload explanations
- Token/context monitoring and common context leaks
- Session trees, steering, follow-ups, retries, and compaction
- Managed Ollama runtime settings and restart requirements
- Tool, shell, skill, command, extension, and raw RPC behavior
- Workspace-security guidance and troubleshooting

Settings throughout the interface include clickable **?** markers. Hovering shows a concise explanation; clicking opens the relevant documentation section and highlights it.

## Included features

### Coding workspace

- Streaming Pi chat with text, thinking, tool calls, tool output, failures, and retries
- Workspace explorer and built-in text-file editor
- Git branch, status, and diff-stat overview
- Image attachments for models that support image input
- Send, steer, follow-up, abort, and direct Pi bash execution
- Live activity logs and a raw protocol inspector
- Searchable in-app documentation with contextual help attached to settings

### Pi features

- Start, stop, resume, and create sessions
- Pi session JSONL persistence inside the selected workspace
- Session list, message history, session tree, raw entries, forks, and HTML export
- Model switching and thinking-level selection
- Steering and follow-up delivery modes
- Manual/automatic compaction and custom compaction instructions
- Automatic retry controls
- Skills, prompt templates, and extension commands discovered by `get_commands`
- Extension UI support for `select`, `confirm`, `input`, `editor`, notifications, status, widgets, title changes, and editor-prefill requests
- Advanced JSON console for every current or future Pi RPC command
- Pi token totals, tool counts, and current context-window utilization

### Ollama features

- Installed-model and loaded-model discovery
- Model pull, delete, select, and unload
- Create model aliases/profiles with:
  - context window (`num_ctx`)
  - maximum generation (`num_predict`)
  - temperature
  - top-p, top-k, and min-p
  - repeat penalty and seed
  - reasoning and image-input metadata for Pi
- Automatic synchronization into `~/.pi/agent/models.json`
- Loaded VRAM and runtime context from Ollama
- KV-cache estimate using GGUF attention metadata
- GPU telemetry through `nvidia-smi`
- Server-wide settings for Flash Attention, KV precision, default context, parallel slots, loaded-model limit, queue size, keep-alive, and local-only cloud blocking
- Optional managed `ollama serve` process with start, stop, and restart controls

## Requirements

- **Node.js 22.19 or newer** — required by current Pi releases
- **Pi coding agent**
- **Ollama**
- A local model with dependable tool calling

For an RTX 3090 with a roughly 27B–30B quantized coding model, start with a 32K or 64K context and `q8_0` KV cache. A 128K allocation may require `q4_0`, CPU offloading, or a smaller weight quantization.

## Installation

### Linux, Ubuntu, or WSL

```bash
cd pi-ollama-studio
./scripts/setup.sh
npm start
```

Open:

```text
http://127.0.0.1:4173
```

The setup script installs Pi when it is not on `PATH`. This project itself has no packages to install.

### Manual installation

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
ollama --version
pi --version
node --version
npm run verify
npm start
```

### Windows PowerShell

Install Node.js, Ollama, and Pi, then run:

```powershell
cd pi-ollama-studio
npm run verify
.\scripts\start-studio-windows.ps1
```

Open `http://127.0.0.1:4173`.

## Recommended Ollama startup for one 24 GB GPU

Linux/WSL:

```bash
./scripts/start-ollama-linux.sh
```

Equivalent environment:

```bash
OLLAMA_FLASH_ATTENTION=1 \
OLLAMA_KV_CACHE_TYPE=q8_0 \
OLLAMA_CONTEXT_LENGTH=65536 \
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_NO_CLOUD=1 \
ollama serve
```

Windows PowerShell:

```powershell
.\scripts\start-ollama-windows.ps1
```

When the normal Ollama desktop application or service is already running, Studio treats it as an external process. It cannot change the environment of that process. To apply KV-cache precision or Flash Attention from the UI, stop the external service and use **Managed Ollama process**, or set the variables in the service configuration yourself.

## First run

1. Pull a coding model in Ollama, for example through the Model panel.
2. Enter an absolute workspace path and click **Open**.
3. Select the base Ollama model.
4. For explicit context control, create a profile such as `qwen-code:64k` with a 65,536 context window.
5. Select the profile and click **Start Pi**.
6. Give Pi a coding task in Chat.

Ollama’s OpenAI-compatible endpoint does not provide a request field for changing context size. Studio therefore creates an Ollama model profile with fixed `num_ctx`, then writes the matching `contextWindow` and `maxTokens` metadata to Pi’s model configuration.

## Context window and KV cache are different

- **Profile context (`num_ctx`)** is an Ollama model/profile setting.
- **Pi `contextWindow`** is metadata Pi uses for context accounting and compaction.
- **`OLLAMA_KV_CACHE_TYPE`** is a global Ollama server setting: `f16`, `q8_0`, or `q4_0`.
- **`OLLAMA_FLASH_ATTENTION`** is global and should be enabled for quantized KV cache.
- **`OLLAMA_NUM_PARALLEL`** multiplies KV memory because each parallel slot needs its own context allocation.
- **`OLLAMA_NO_CLOUD=1`** keeps a managed Ollama server from routing cloud-model requests outside the machine.

The KV number shown by Studio is an estimate from layer/head metadata. Ollama’s loaded-model data remains the source of truth for actual VRAM allocation.

## Files written outside this folder

```text
~/.pi/agent/models.json                 Ollama models exposed to Pi
~/.pi-ollama-studio/runtime.json        Studio runtime settings
~/.pi-ollama-studio/profiles.json       Studio-created Ollama profile metadata
<workspace>/.pi/studio-sessions/*.jsonl Pi session files
```

Existing providers and model entries in Pi’s `models.json` are preserved. If Ollama’s model-list endpoint is temporarily unavailable, Studio retains the last synchronized entries rather than deleting them.

## Useful commands

```bash
npm start       # run the server
npm run dev     # restart server on source changes
npm run check   # JavaScript syntax checks
npm test        # automated tests
npm run verify  # syntax checks + tests
```

Override server settings with environment variables:

```bash
STUDIO_PORT=5000 \
STUDIO_BIND_HOST=127.0.0.1 \
OLLAMA_BASE_URL=http://127.0.0.1:11434 \
PI_COMMAND=pi \
OLLAMA_COMMAND=ollama \
node server.mjs
```

## Architecture

```text
Browser UI
  ├── HTTP API for configuration, models, files, sessions, and Git
  └── Server-Sent Events for Pi/Ollama streaming events
          │
Node control server
  ├── pi --mode rpc
  │     └── Ollama OpenAI-compatible endpoint
  └── Ollama native API
        ├── /api/tags
        ├── /api/ps
        ├── /api/show
        ├── /api/create
        ├── /api/pull
        └── /api/delete
```

Pi runs as an isolated child process. If the agent fails, the Studio server and browser UI remain available and Pi can be restarted.

## RPC coverage and limitations

Studio exposes the complete documented Pi RPC interface through the Advanced JSON console and gives dedicated controls to the normal coding workflow.

Features that require Pi’s terminal renderer cannot be reproduced exactly in RPC mode. Pi itself marks custom TUI components, themes, terminal headers/footers, direct clipboard integration, and some editor-component functions as unavailable or degraded in RPC mode. Extension dialogs and fire-and-forget UI requests are supported.

The built-in editor intentionally handles text files up to 3 MB. Binary files and large generated files should be edited with your normal IDE while Pi continues to operate on the same workspace.

## Security

The app is restricted to loopback addresses, validates same-origin browser writes, and has no authentication. Do not expose it to a LAN or the public internet without adding authentication and TLS.

Pi can execute shell commands and modify files in the selected workspace. Project trust is enabled by default so project extensions, skills, prompts, and settings load in RPC mode. Review third-party Pi packages and untrusted repositories before starting an agent in them.


## Final review status (1.1.2)

The final review added regression coverage and fixes for:

- cumulative Pi tool-stream rendering and extension UI field compatibility
- current model-specific Pi thinking levels
- session names stored in later `session_info` entries
- workspace session-directory symlink escape prevention
- arbitrary session-file isolation and a 50 MB inspection limit
- exact same-origin enforcement for state-changing browser requests
- retention of Pi model entries when Ollama `/api/tags` is temporarily unavailable
- current Ollama `reasoning_effort` support
- `OLLAMA_NO_CLOUD` for managed and helper-script launches
- preservation of full streamed Pi bash output when the final RPC payload is truncated
- live Pi/Ollama/GPU monitoring and version consistency

Run `npm run verify` after extraction to repeat the syntax and regression suite on your machine.
