# Pi Ollama Studio v1.5 — Language Intelligence

v1.5 turns the v1.4 Monaco workbench into a multi-language IDE layer while preserving Pi, Ollama, session-tree, Git-checkpoint, normal GUI, keyboard-enhanced and Vim workflows.

## Added

### Real LSP process bridge
- Studio owns stdio language-server processes on the Node side.
- Monaco communicates with them through Studio's typed HTTP/SSE bridge.
- Document open/change/close lifecycle is synchronized from editor buffers.
- Server diagnostics are merged into the existing Problems / Quickfix model.
- Language-server status/restart APIs are exposed by Studio.

### Bundled language intelligence
Validated bundled servers:
- TypeScript / JavaScript — TypeScript Language Server
- Python — Pyright
- HTML — HTML Language Server
- Angular templates — Angular Language Server when an Angular workspace is detected

The supplied extracted web-language bundle did not contain runnable CSS/JSON/Markdown/ESLint binaries. Studio therefore reports those definitions as unavailable instead of silently failing, and Monaco's built-in CSS/JSON/JS/TS services remain active where applicable.

### Monaco language actions
The semantic command layer now exposes language operations through both conventional UI/keyboard controls and the Vim/leader layer:
- Completion
- Hover
- Go to definition
- Go to implementation
- Find references
- Prepare rename / rename
- Signature help
- Document formatting
- Code actions / quick fixes
- Document symbols
- Workspace symbols
- Diagnostic navigation

### Git onboarding for non-repositories
Opening a normal folder no longer surfaces `not a git repository` as the primary experience.
Studio can now:
- Detect Git-installed vs repository-initialized state.
- Offer **Initialize Git — Recommended**.
- Create a conservative `.gitignore` only when none exists.
- Never overwrite an existing `.gitignore`.
- Optionally create a baseline commit so prompt checkpoints/worktrees work from the first development prompt.
- Detect unignored secret-like files and refuse the automatic baseline until explicitly confirmed.
- Continue opening without Git when the user does not want version control.

This makes Pi session state + Git code state + Studio workspace state usable together from project start.

## Validation

Release-gate tests performed in the build environment:
- `npm run verify`: **66/66 passing**
- `npm run test:lsp-live`: real TypeScript, Pyright, HTML and Angular server processes pass
- `npm run test:pi-live`: real Pi **0.82.1** RPC package passes (`get_state`, `get_commands`, `get_tree`, `get_session_stats`)
- Temporary real Git repositories are used for onboarding, snapshots, worktrees, stage/diff/restore and containment tests.
- Monaco 0.55.1 provider/API contracts and vendored worker assets are verified.

### Browser E2E
`npm run test:ui` is included as a real Playwright end-to-end suite for the rendered Studio UI. It covers normal mouse operation and keyboard/Vim flows including project opening/Git onboarding, Monaco editing, workspace search, split panes, LSP diagnostics/actions, Changes/diff, and Studio navigation.

The managed Chromium available in the build environment has an enforced enterprise `URLBlocklist=["*"]`, so it blocks the first localhost navigation. The suite intentionally fails with an explicit policy message there rather than reporting a false pass. Run `npm run test:ui` on a normal Windows Chrome/Edge/Chromium installation for the final rendered-browser validation.

## Known limitations
- Real Ollama completions could not be executed in the build sandbox because Ollama is not locally installed and outbound access to the user's remote Ollama tunnel is blocked by sandbox networking.
- CSS/JSON/Markdown/ESLint external LSP definitions are shown as unavailable when the vendored payload lacks their binaries; Monaco built-ins remain usable.
- Full MCP/subagent/package-manager/container features are planned for later phases.
