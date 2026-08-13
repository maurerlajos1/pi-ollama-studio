# Pi Ollama Studio

## v1.8 Agent Platform RC

v1.8 turns the Windows-verified v1.7 local IDE foundation into a broader agent platform without changing the proven Pi/session/Git execution model. It adds OpenAI/OpenAI-compatible providers, an MCP manager and Pi exposure bridge, a native Pi package/extension marketplace with trust inspection and version/resource controls, runtime-bound Ollama profiles, universal agent-resource search, further backend/frontend modularization, and a live App Preview workspace with Editor + Preview side-by-side mode.

Release validation available in any supported environment:

```bash
npm run check
npm test
npm run test:lsp-live
npm run test:pi-live
```

Full Windows release gate:

```powershell
npm run verify:v1.8:windows
```

The Windows gate runs syntax/static checks, deterministic unit/integration coverage, bundled live LSPs, real Pi RPC, rendered Chrome/Edge Playwright workflows, and the real Ollama + Pi hardware E2E. The hardware workflow uses disposable temporary projects and can preserve artifacts for inspection with the existing E2E keep-artifact options.

`test:ui` and the rendered portion of the full release gate require a normal Chrome/Edge/Chromium environment that permits localhost navigation.


A local, desktop-style coding workspace built on the **real Pi coding-agent RPC process** and **Ollama**. It gives Pi a Codex/Antigravity-like browser UI while keeping Pi responsible for the agent loop, tools, skills, extensions, context, compaction, retries, and session files.

The application has no npm runtime install step of its own. The control server and API use Node.js/browser APIs directly, and Monaco Editor 0.55.1 is vendored under `vendor/monaco/` so the coding UI remains local-first and does not require a CDN.

## In-app documentation

The application includes a searchable **Documentation** workspace directly inside the application. It includes:

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

### Dual interaction model

The application is fully usable as a conventional GUI. **Standard** mode is the default and keeps normal mouse, forms, buttons, tabs, context controls, and familiar shortcuts. Two optional power-user layers are available from **Settings → Keys** or the mode badge in the top bar:

- **Keyboard Enhanced** — command palette, fuzzy file/session/model search, leader-key shortcuts, and fast navigation without modal editing.
- **Vim / Neovim** — adds Normal/Insert modes, `j`/`k` navigation across chat/session-tree/Git items, `gg`/`G`, `za` folding, `:` command mode, `/` universal search, named registers, semantic macros, dot-repeat, marks, and keyboard actions for session forks and prompt-derived app branches.
- **Command palette** — `Ctrl/Cmd+Shift+P` searches semantic commands; `Ctrl/Cmd+P` searches workspace files. The same command registry powers buttons, leader keys, and Vim actions.
- **Leader menu** — press `Space` in Keyboard Enhanced or Vim Normal mode. Which-key style hints keep shortcuts discoverable.

The Neovim layer is intentionally optional: disabling it does not remove or hide any application capability.

### Git-backed prompt checkpoints

When **Automatic Git snapshot before prompts** is enabled, Studio creates a hidden snapshot commit before each normal prompt using a temporary Git index. This captures tracked changes plus untracked non-ignored files **without staging or modifying the user's live index**. The snapshot is kept alive under `refs/pi-studio/checkpoints/*` and is associated with the resulting Pi user-message node.

In Session Tree, checkpointed prompts show a `◈` badge. **Create App from Snapshot** creates a separate Git worktree at that exact code state and copies only the selected Pi branch ancestry into the new workspace session. Older prompts without a checkpoint still use the previous session-only fallback and clearly warn that exact historical source restoration is unavailable.

### Coding workspace

- Vendored **xterm.js 6** terminal UI with multiple terminal tabs, optional split terminal panes, search, web links, resize/fit handling, and WebGL acceleration when supported
- Integrated terminal backend automatically uses `node-pty`/ConPTY when installed and falls back to safe child-process pipes when PTY support is unavailable
- **Test Explorer** discovers test files and individual test cases, runs all/file/case targets, reruns the exact last target, feeds failures into Problems/Quickfix, and can hand failing output to Pi
- **Run Configurations** are discovered from project npm scripts and launch in integrated terminals
- Vendored **Monaco Editor 0.55.1** with local-only assets, syntax highlighting, find/replace, folding, multiple cursors, language-aware editing, and graceful textarea fallback
- Multi-buffer editor workbench with open-file tabs, dirty-state protection, Save All, next/previous buffer navigation, and vertical/horizontal two-pane splits
- Mouse-draggable split sizing plus persisted buffers, panes, split layout, active view, and Monaco cursor/scroll state
- Workspace-wide text search with ignored-directory, binary-file, file-size, and result limits
- **Changes** workspace with Monaco side-by-side/inline Git diff, next/previous change, stage/unstage, copy patch, restore tracked file, open file, and Ask Agent actions
- Unified Problems/Quickfix foundation fed by Monaco markers, Pi tool failures/output, Bash output, and Web Console diagnostics
- Dedicated Pi Resources browser for discovered skills, prompt templates, extension commands, and built-in slash commands
- Streaming Pi chat with text, thinking, tool calls, tool output, failures, and retries
- Workspace explorer with safe text-file loading/saving
- Git branch, status, diff-stat, checkpoint, and worktree controls
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

- Local and remote runtime profiles: localhost, LAN/IP, VPN/Tailscale, public IP, and HTTPS/reverse-proxy/Cloudflare endpoints
- Optional bearer authentication by **environment-variable name**; secrets are never stored in Studio config or Git, and Pi receives an environment interpolation reference in `models.json`
- Connection testing for unsaved runtime settings with latency, version, model count, and auth-availability feedback
- Local-only managed-process controls automatically disable for remote runtimes
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

## Real Ollama E2E configuration

Recommended local RTX 3090 configuration:

```powershell
$env:PI_STUDIO_E2E_OLLAMA_URL="http://127.0.0.1:11434"
$env:PI_STUDIO_E2E_MODEL="15koutput"
$env:PI_STUDIO_E2E_FALLBACK_MODEL="llama3.2:latest"
$env:PI_STUDIO_OLLAMA_API_KEY_ENV="OLLAMA_API_KEY"
npm run test:ollama-e2e
```

For an authenticated HTTPS/Cloudflare runtime, set the actual secret only in the referenced environment variable:

```powershell
$env:OLLAMA_API_KEY="<your bearer token>"
$env:PI_STUDIO_E2E_OLLAMA_URL="https://your-tunnel.example.com"
npm run test:ollama-e2e:windows
```

Studio accepts Ollama base URLs without `/v1`; it uses native `/api/*` routes for runtime management and automatically writes the corresponding `/v1` OpenAI-compatible base URL for Pi.

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

The setup script installs Pi when it is not on `PATH`. Studio's browser/runtime libraries are vendored. Full native PTY support is optional: Windows can install the bundled prebuild with `npm run setup:pty`; Linux uses the pipe fallback unless `node-pty` is installed/built for the system.

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
npm run setup:pty   # installs the bundled Windows node-pty prebuild when supported
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
~/.pi-ollama-studio/checkpoints.json    Prompt-node to Git-checkpoint metadata
<workspace>/.pi/studio-sessions/*.jsonl Pi session files
<git repo>/refs/pi-studio/checkpoints/*  Durable hidden prompt snapshot refs
```

Existing providers and model entries in Pi’s `models.json` are preserved. If Ollama’s model-list endpoint is temporarily unavailable, Studio retains the last synchronized entries rather than deleting them.

## Useful commands

```bash
npm start       # run the server
npm run dev     # restart server on source changes
npm run check   # JavaScript syntax checks
npm test        # automated tests
npm run verify  # syntax checks + tests
npm run test:pi-live # optional smoke test against an installed real Pi CLI
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
  ├── Vendored Monaco editor/diff workbench + normal GUI / optional Vim controls
  ├── HTTP API for configuration, search, diagnostics, models, files, sessions, and Git
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

The Studio file API intentionally handles text files up to 3 MB. Monaco is used for the interactive editing surface, while binary files and oversized/generated files remain outside the supported text-editing path.

## Security

The app is restricted to loopback addresses, validates same-origin browser writes, and has no authentication. Do not expose it to a LAN or the public internet without adding authentication and TLS.

Pi can execute shell commands and modify files in the selected workspace. **Project trust is disabled by default** because project-local extensions, skills, prompts, and settings may execute or influence code. Enable trusted project resources only for repositories you control or have reviewed.


## Final review status

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

## v1.8 agent-platform additions

- **Providers:** OpenAI/OpenAI-compatible profiles, `/v1/models` discovery, Responses-first/Chat fallback, capability probes, manual context/output/tool/JSON/vision/reasoning overrides, environment-backed credentials, and Pi `models.json` synchronization.
- **MCP:** stdio/HTTP servers, tools/resources/prompts inspection and manual use, logs/lifecycle state, and independent per-server/per-tool exposure to Pi with live active-tool updates.
- **Pi Platform & marketplace:** instructions, skills, prompts, extensions, packages and settings, plus online `pi-package` discovery, exact-version pinning, project/global install/update/remove, native resource filters, and npm/Git/local provenance inspection.
- **Universal resource search:** files, sessions, commands, models, Pi resources, providers, MCP entities, and packages share the semantic search/command system.
- **Ollama profile ownership:** newly-created model profiles record the runtime endpoint they belong to so models from a different Ollama server are not silently selected; legacy profiles remain visible and portable.
- **App Preview:** managed workspace dev-server process, persisted command/URL, localhost URL discovery, status/logs, refresh/restart/open-external, Preview tab, and Editor + Preview side-by-side workflow.

See `RELEASE_NOTES_1.8-rc.3.md` and `CODE_REVIEW_V1.8_DEV.md` for the full RC audit and Windows validation status.
