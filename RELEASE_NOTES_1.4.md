# Pi Ollama Studio 1.4 — IDE Core

Version 1.4 turns the v1.3 workbench foundation into a substantially more IDE-like coding environment while deliberately leaving Pi/Ollama/session internals stable.

## Vendored Monaco Editor

- Monaco Editor **0.55.1** is bundled under `vendor/monaco/` and served locally by Studio.
- No CDN or npm install is required at runtime.
- The existing `BufferManager` remains the source of truth for open files and dirty state; Monaco is an editor/view adapter rather than a replacement for workspace state.
- File extensions are mapped to Monaco language modes.
- JavaScript/TypeScript browser-side diagnostics are forwarded into Studio Problems.
- Editor view state is preserved per buffer/pane.
- Existing textarea editors remain as a graceful fallback if Monaco cannot initialize.

## Workbench improvements

- Save All for dirty buffers without changing the active pane.
- Persistent open buffers, active panes, split type, split size, active workspace view, and Monaco cursor/scroll state.
- Workspace-wide text search with ignored-directory/binary/large-file protection.
- Safer dirty-buffer behavior remains intact when reopening files or switching workspaces.

## Changes / Diff workspace

- The Git workspace is now presented as **Changes**.
- Monaco Diff Editor provides side-by-side and inline views.
- Previous/next change navigation.
- Open the selected changed file.
- Stage/unstage the selected file.
- Copy the raw Git patch.
- Ask Pi about the selected change.
- Restore tracked working-tree files safely. Untracked/staged restore cases are disabled where an implicit destructive action would be ambiguous.
- Backend APIs can read a file from `HEAD` or the index so the diff UI compares real Git states instead of attempting to reconstruct them from patch text.

## Unified Problems foundation

Problems can now be produced by:

- Monaco markers
- Pi tool execution output
- direct Bash output
- Web Console output
- generic failed tool calls

Compiler-style `path:line:column` diagnostics are normalized into one Problems/Quickfix view. A problem can prefill an agent request containing the location and diagnostic text.

## Keyboard / Vim additions

The normal GUI remains the default. Keyboard Enhanced and Vim modes now also include:

- `gd` — definition action when the active Monaco language service supports it
- `gr` — references action
- `K` — hover action
- `[d` / `]d` — existing diagnostic navigation
- `Ctrl+W h/j/k/l` — pane navigation in Vim Normal mode
- `Ctrl+W v/s/q/=` — vertical split, horizontal split, close split, reset split size
- `Ctrl/Cmd+Alt+S` — Save All

All actions still call the same semantic command registry used by GUI controls.

## Local-only editor assets and security

- Monaco is served from `/vendor/monaco/vs`.
- Studio's Content Security Policy no longer needs a Monaco CDN exception.
- Project trust remains opt-in (`trustProjects: false` by default).

## Testing

The release adds coverage for:

- Monaco language mapping and vendored asset integrity
- required Monaco hashed worker files
- local-only CSP/static asset serving
- workspace state persistence
- diagnostic parsing/normalization
- workspace text search
- Git `HEAD`/index file retrieval and restore behavior
- background-buffer Save All bookkeeping
- real temporary Git repository operations

A new optional command is included:

```bash
npm run test:pi-live
```

When a real `pi` binary is available it exercises Studio's actual `PiRpcProcess` against Pi RPC (`get_commands`, `get_tree`, and `get_session_stats`). If Pi is absent, it exits cleanly as a skipped hardware/runtime smoke test.

## Scope deliberately deferred

Version 1.4 does **not** claim to provide the full external LSP phase yet. Monaco provides browser-side language features for supported languages, while the planned v1.5 language-server bridge (TypeScript language server, Pyright, Angular, HTML/CSS/JSON/ESLint servers) remains a separate phase. MCP, subagents, Docker isolation, and the full Neovim grammar are also intentionally deferred.
