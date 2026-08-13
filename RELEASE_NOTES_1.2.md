# Pi Ollama Studio 1.2

This build extends the uploaded base application without replacing its existing Pi/Ollama architecture.

## Implemented

- Standard GUI remains the default and every core action is still mouse-accessible.
- Keyboard Enhanced and Vim/Neovim interaction profiles.
- Semantic command registry shared by keyboard actions and UI commands.
- Fuzzy command palette across commands, workspace files, sessions, and Ollama models.
- Which-Key-style leader menu.
- Vim Normal/Insert modes with `j/k`, `gg/G`, `:`, `/`, `za`, copy, tree fork/create-app actions, marks, and quickfix navigation.
- Quickfix-style Problems view populated by failed Pi tool executions.
- Automatic Git snapshots before normal prompts, optional in Settings → Keys.
- Snapshots use a temporary Git index and do not stage or modify the user's live index.
- Durable `refs/pi-studio/checkpoints/*` refs prevent snapshots being pruned by normal Git GC.
- Prompt-node ↔ Git snapshot metadata storage.
- Session Tree snapshot badges.
- Create App from Snapshot creates an isolated Git worktree at the exact pre-prompt code state.
- Session branch copying now follows parent ancestry and excludes sibling branches.
- Offline/historical session-tree fork/create-app actions use the correct inspected session file.
- Project resource trust now defaults to off.
- Hardware-only Pi test separated from the normal automated test command.
- Ollama live E2E test gracefully skips live model creation when Ollama is offline.

## Verification

`npm run verify` passes: **39/39 tests**.

A server/UI smoke test also passed with Pi and Ollama unavailable, confirming the normal interface still starts independently of the local runtimes.

## Intentionally not rewritten

The existing Pi RPC, Ollama runtime/model management, session UI, editor, Git panel, terminal, extension widgets, documentation, and existing mouse workflows were preserved and extended rather than replaced.
