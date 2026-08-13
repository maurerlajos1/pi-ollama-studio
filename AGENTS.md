# Current continuation note

For v1.8.0-rc.4 continuation, read **`CODEX_HANDOFF.md` first**. It contains the current verified test state, immutable Windows invariants, implemented rc.4 capabilities, the next UI slice, and explicit deferred scope. When older notes conflict with it, the handoff and current code/tests win.

# Pi Ollama Studio — Agent Guidelines & Repository Guide

Welcome! This repository houses **Pi Ollama Studio** (v1.8.0-rc.4), a local coding agent web IDE built on top of the **Pi Agent RPC Engine** and **Ollama**.

---

## 🏛️ Architecture Overview

The app follows a decoupled Node.js server + Vanilla JS single-page web app architecture:

- **Frontend** (`public/app.js`, `public/index.html`, `public/styles.css`):
  - Pure Vanilla JS ES6+ (no heavy frontend frameworks).
  - Single global `app` state object.
  - Consumes server endpoints via `api()` / `post()` / `rpc()` helpers.
  - Listens to real-time events via Server-Sent Events (SSE) at `/api/events`.

- **Backend** (`server.mjs`):
  - Fast, dependency-free Node.js HTTP server.
  - Native ES Modules (`.mjs`).
  - Binds strictly to loopback (`127.0.0.1`) for security.
  - Spawns and manages the `PiRpcProcess` child process (`src/pi-rpc.mjs`).
  - Controls Managed Ollama (`src/system.mjs` -> `ManagedOllama`).

- **Modules** (`src/`):
  - `config.mjs`: Runtime configuration & validation (`DEFAULT_CONFIG`, `validateConfig()`).
  - `pi-rpc.mjs`: Pi RPC JSONL process wrapper (`PiRpcProcess`).
  - `ollama.mjs`: Ollama API client & model profiles management.
  - `sessions.mjs`: Pi session history loading and inspection.
  - `system.mjs`: System info (GPU, CPU, Memory) & Git operations.

---

## 🚨 Critical Security Rules & Constraints

1. **Host Binding**: The HTTP server MUST only bind to `127.0.0.1` / `localhost`. Never expose this server on `0.0.0.0` as it provides local code execution capabilities.
2. **Workspace Containment**: Always use `resolveWorkspacePath(workspace, relative)` when operating on files or git paths to prevent path traversal outside the workspace directory.
3. **PowerShell Injection Prevention**: When spawning Windows processes (e.g., terminal launch), validate paths against subexpression/injection characters (`` ` ``, `$()`, `&`, `;`).
4. **H: Drive Storage Policy**:
   - Store Ollama models on `H:\ollama-models` (`$env:OLLAMA_MODELS = "H:\ollama-models"`).
   - WSL and virtual environments belong on `H:\`. Protect the `C:` drive from large model downloads.

---

## 🛠️ Common Tasks & Workflows for Agents

### Running & Testing

```bash
# Run unit test suite (Node.js test runner)
npm test

# Start the dev server manually
$env:OLLAMA_MODELS="H:\ollama-models"; npm start
```

### Adding New API Endpoints (`server.mjs`)
1. Handle route in `handleApi(req, res, url)`.
2. Wrap request parameters using `resolveWorkspacePath()` for file operations.
3. Return JSON using `json(res, 200, payload)` or `errorJson(res, status, message)`.

### Modifying Frontend Behavior (`public/app.js`)
1. Mutate the central `app` state object in place.
2. Call small modular rendering functions (`renderMessages()`, `renderActiveModel()`, `renderSessionTree()`, `loadGitPanel()`).
3. Keep DOM operations clean and performant. Use `requestAnimationFrame` for high-frequency streaming events (`message_update`).

---

## 🧪 Testing Guidelines
- Unit tests are located in `test/`.
- Run `npm test` after making changes to core modules (`config.mjs`, `pi-rpc.mjs`, `server.mjs`, `system.mjs`).
- Keep `npm run check` and the complete `npm test` suite green; the handoff baseline is 197/197 deterministic tests. Also run the live/Windows gates documented in `docs/handoff/WINDOWS_RELEASE_GATE.md` when applicable.
