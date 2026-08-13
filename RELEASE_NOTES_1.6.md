# Pi Ollama Studio v1.6 — Terminal, Testing & Remote Ollama

## Highlights

- Vendored xterm.js terminal UI with terminal tabs, optional split panes, fit/resize, search, clickable links, WebGL acceleration when available, and retained terminal history.
- New `TerminalManager` with automatic `node-pty`/ConPTY use when available and a cross-platform pipe fallback.
- Test Explorer for Node/Vitest/Jest/Mocha/Pytest-style projects, including test-file discovery, static individual-case discovery, run-all/file/case execution, rerun-last-target, test output, Problems integration, and Ask Pi to Fix.
- Run Configurations discovered from npm scripts and launched in integrated terminals.
- Remote Ollama runtime support for LAN/IP, VPN/Tailscale, public IP, HTTPS reverse proxy and Cloudflare-style endpoints.
- Optional Ollama bearer authentication references an environment-variable name; Studio does not persist the secret, and Pi's generated provider configuration uses `$ENV_VAR` interpolation.
- Test Connection works against unsaved runtime settings and reports runtime version/model count/latency/auth availability.
- Managed Ollama start/stop/restart controls are restricted to local endpoints.
- Real hardware E2E harness (`npm run test:ollama-e2e`) creates a disposable project and validates real Pi + real Ollama tool use, code editing, project tests, Git changes, checkpoints, Session Tree, historical worktree restoration, Test Explorer, integrated terminal and browser UI.
- Windows helper: `npm run test:ollama-e2e:windows` defaults to `15koutput` with `llama3.2:latest` fallback.

## Real-model E2E defaults

- Ollama: `http://127.0.0.1:11434`
- Primary model: `15koutput`
- Fallback: `llama3.2:latest`
- API-key environment-variable name: `OLLAMA_API_KEY`
- Agent timeout: 20 minutes (override with `PI_STUDIO_E2E_AGENT_TIMEOUT_MS`)

The test verifies that the model does not modify protected fixture tests/package metadata, that the first implementation passes tests, and that a historical worktree created from the second prompt's pre-prompt checkpoint contains task 1 but not task 2.

## Validation design

`npm run verify` is deterministic and does not require Ollama. `npm run test:ui` is the deterministic rendered-browser E2E. `npm run test:ollama-e2e` is intentionally opt-in because it consumes real GPU/model time and depends on model behavior.

Linux and Windows use the same application code. The terminal backend chooses the OS shell/PTY implementation at runtime; final native desktop packaging will validate native `node-pty` binaries separately per platform.
