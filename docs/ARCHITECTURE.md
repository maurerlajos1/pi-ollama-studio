# Pi Ollama Studio — Architectural Deep Dive

This document details the internal architecture, event system, process lifecycles, and security model of **Pi Ollama Studio**.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Browser UI                            │
│  (Vanilla ES6+, app.js, index.html, CSS Grid/Flex layout)    │
└──────────────┬──────────────────────────────▲───────────────┘
               │ HTTP API Requests            │ SSE Real-time Events
               │ (/api/pi/command, etc.)      │ (/api/events)
┌──────────────▼──────────────────────────────┴───────────────┐
│                      server.mjs                             │
│       (Node.js HTTP Server, strictly on 127.0.0.1)          │
├──────────────────────────────┬──────────────────────────────┤
│  PiRpcProcess (pi-rpc.mjs)   │  ManagedOllama (system.mjs)  │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │ stdin/stdout (JSONL)         │ HTTP REST API
┌──────────────▼───────────────┐┌─────────────▼───────────────┐
│    Pi Coding Agent CLI       ││       Ollama Server         │
│     ("pi --mode rpc")        ││    ("http://127.0.0.1:11434")│
└──────────────────────────────┘└─────────────────────────────┘
```

---

## 2. Process & Communication Protocols

### A. Pi RPC Protocol (`src/pi-rpc.mjs`)
- The backend spawns `pi` executable with `--mode rpc --session-dir <path>`.
- Communication happens via newline-delimited JSON (JSONL) over `stdin` / `stdout`.
- Requests sent via `PiRpcProcess.request(command, timeoutMs)` generate a unique ID (`studio-TIMESTAMP-COUNTER`).
- Outstanding requests are correlated using a `#pending` Map with built-in timeouts (up to 10 minutes for long context reasoning).

### B. Real-time Server-Sent Events (`/api/events`)
The backend broadcasts real-time system state to all connected browser clients via SSE:
- `connected`: Initial handshake with ISO timestamp.
- `pi_event`: Forwarded raw events from Pi RPC (`message_update`, `tool_execution_start`, `compaction_end`, etc.).
- `pi_snapshot`: Complete status, state, and context usage metrics.
- `ollama_models_changed`: Broadcast when model profiles are created, pulled, or deleted.
- `workspace_file_changed` / `workspace_git_changed`: Broadcast on file edits or git commits.

---

## 3. Storage & Environment Model

- **App Data Directory**: Defaults to `~/.pi-ollama-studio` (overridable via `PI_OLLAMA_STUDIO_DIR`).
- **Config Storage**: `~/.pi-ollama-studio/runtime.json`.
- **Model Profiles**: `~/.pi-ollama-studio/profiles.json`.
- **Ollama Models**: Hardened to store on `H:\ollama-models` via `OLLAMA_MODELS` environment variable.

---

## 4. Security Architecture

1. **Localhost Isolation**: The application serves code execution primitives and strictly binds to `127.0.0.1` / `::1`. Host headers are validated on every HTTP request.
2. **Same-Origin State Changes**: State-altering HTTP methods (PUT, POST, DELETE) validate the `Origin` header to prevent CSRF attacks from external browser tabs.
3. **Workspace Path Jails**: All file and git operations call `resolveWorkspacePath()`, which uses `fs.realpath` and `path.relative` to ensure paths do not escape the selected workspace directory.
