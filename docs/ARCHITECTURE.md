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
- **Ollama Models**: Uses Ollama's platform default storage unless the user explicitly sets `OLLAMA_MODELS`. Studio does not hard-code a drive or model directory.

---

## 4. Security Architecture

1. **Localhost Isolation**: The application serves code execution primitives and strictly binds to `127.0.0.1` / `::1`. Host headers are validated on every HTTP request.
2. **Same-Origin State Changes**: State-altering HTTP methods (PUT, POST, DELETE) validate the `Origin` header to prevent CSRF attacks from external browser tabs.
3. **Workspace Path Jails**: All file and git operations call `resolveWorkspacePath()`, which uses `fs.realpath` and `path.relative` to ensure paths do not escape the selected workspace directory.


---

## 8. Semantic Command & Dual-Interaction Architecture (v1.2)

`public/command-system.js` provides the UI command registry and fuzzy ranking layer. `public/app.js` registers semantic commands such as `agent.compact`, `view.tree`, `git.checkpoint`, and `palette.files`. Conventional buttons remain intact; the command palette, leader-key layer, and Vim mode invoke those same commands instead of duplicating business logic.

Interaction profiles:

- **Standard**: conventional GUI and familiar shortcuts; default.
- **Keyboard Enhanced**: Standard plus leader shortcuts and fuzzy navigation.
- **Vim**: Keyboard Enhanced plus Normal/Insert modal navigation on chat, session tree, Git rows, and terminal-session cards.

This separation is deliberate: keyboard features are an acceleration layer, never a requirement for feature access.

## 9. Git-backed Prompt Checkpoints

Before a normal prompt, the browser may call `POST /api/workspace/git/checkpoint`. `gitCreateSnapshot()` uses an alternate temporary Git index (`GIT_INDEX_FILE`) to build a tree containing the current workspace state, then creates a commit with `git commit-tree`. It does not change the active index, branch, or working tree. The commit is kept reachable with a private ref under `refs/pi-studio/checkpoints/`.

After Pi settles, the browser resolves the generated user-message node ID and stores the association through `/api/checkpoints/associate`. Metadata lives in `~/.pi-ollama-studio/checkpoints.json`.

When **Create App from Snapshot** is selected, the server:

1. Looks up the checkpoint for the selected Pi node.
2. Creates a sibling Git worktree from that exact snapshot commit.
3. Creates a `pi/<project-name>` branch for the worktree.
4. Copies the selected session branch into the new workspace.
5. Rewrites the copied session header to use the new workspace path.

Session copying now follows `parentId` ancestry rather than slicing by JSONL file position, preventing sibling conversation branches from leaking into the forked session.

## 10. Project Trust Default

`trustProjects` now defaults to `false`. Project-local Pi resources can execute code, so trust is opt-in. Users can still enable trusted project resources from Advanced settings for repositories they control.


---

## 11. Workbench Buffers, Splits, Registers & Semantic Macros (v1.3)

`public/workbench.js` contains browser-independent state primitives used by the UI:

- `BufferManager` owns open file buffers, dirty state, active panes, buffer cycling, and vertical/horizontal split assignment.
- `RegisterStore` implements named and unnamed Vim-style text registers without replacing the system clipboard.
- `SemanticMacroRecorder` records command IDs and arguments rather than pointer coordinates or raw keystrokes. This makes macros resilient to UI layout changes.

The editor UI remains a conventional mouse-accessible workbench. File tabs can be clicked and closed normally, split buttons create a second editor pane, and the split divider is draggable. Keyboard Enhanced and Vim modes call the same semantic commands (`editor.nextBuffer`, `editor.splitVertical`, etc.).

## 12. Pi Resource Browser (v1.3)

The Resources view calls Pi `get_commands` and classifies returned commands conservatively by their reported source/name into skill, prompt, extension, or built-in groups. Classification is UI metadata only; Pi remains the source of truth for execution. Clicking **Insert** places the slash command in the composer; **Run** sends it through the normal Pi prompt path.

This keeps Studio compatible with future Pi commands even when the UI does not yet have a dedicated editor for a resource type.

## 13. IDE Core / Vendored Monaco Architecture (v1.4)

Version 1.4 deliberately keeps the v1.3 `BufferManager` as the application state layer and places Monaco behind `public/monaco-adapter.js`. This avoids coupling session/workspace state to a specific editor implementation and keeps the normal textarea fallback available if Monaco cannot initialize.

### Local Monaco loading

Studio vendors Monaco Editor 0.55.1 under `vendor/monaco/` and serves it only from `/vendor/monaco/vs`. `server.mjs` has an explicit static route for that directory and the Content Security Policy remains local-only. Monaco's packaged AMD loader maps its own hashed worker assets; Studio does not rely on a CDN or an obsolete hard-coded worker filename.

### Editor state flow

```text
Workspace file API
      │
      ▼
BufferManager ────── dirty/content/pane state
      │
      ▼
MonacoWorkbenchAdapter
      │
      ├── primary editor
      └── secondary editor
```

Monaco change events update the buffer state, while selecting a buffer attaches the appropriate Monaco text model to the active pane. Per-pane view state is captured and restored. `WorkspaceStateStore` persists open paths, pane assignments, split type/size, active view, and serializable Monaco view states.

### Changes / diff flow

`MonacoDiffAdapter` renders real original/modified file contents. The server exposes Git helpers that read a path from `HEAD` or the index with `git show`, so the UI does not need to reverse-engineer a patch to construct the original model. The Changes panel can stage/unstage, copy the raw patch, restore a tracked worktree file, open a file, and prefill an agent review request.

### Workspace search

`searchWorkspace()` walks the selected workspace under the same path-jail rules used for file access. It ignores common dependency/build/VCS directories, skips binary/oversized files, limits files/results, and returns path/line/column/preview records. This is the v1.4 project-text search foundation; ripgrep integration can replace the scanner later without changing the UI contract.

### Unified diagnostics foundation

`public/diagnostics.js` normalizes Monaco markers and compiler-style text output into a common problem record. Pi tool output, direct Bash output, Web Console output, and generic tool failures can feed the same Problems/Quickfix view. This is intentionally a normalization layer rather than a full Language Server Protocol implementation.

### Language-intelligence boundary

Monaco's browser-side JavaScript/TypeScript services are enabled conservatively: TypeScript syntax/semantic diagnostics are enabled, while JavaScript semantic diagnostics are limited to avoid false unresolved-import noise without a complete project language-server graph. Full multi-language LSP process management is deferred to the next dedicated phase.

## 14. Live Pi compatibility smoke testing (v1.4)

`scripts/test-real-pi.mjs` provides an optional runtime smoke test using the same `PiRpcProcess` class as the server. When `pi` (or `PI_COMMAND`) is available it starts a temporary offline Pi RPC session and exercises command discovery, session-tree retrieval, and session stats. The normal automated suite remains deterministic and does not require a globally installed Pi binary.
