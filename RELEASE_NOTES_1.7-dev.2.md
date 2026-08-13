# Pi Ollama Studio v1.7.0-dev.2

Parallel Pi Platform development build based on v1.7-dev.1, with the real-hardware-validated
v1.6.0 fixes forward-ported from the Windows/RTX 3090 release candidate.

## Validated v1.6 fixes merged forward

- Serve vendored xterm.js assets through `/vendor/xterm/`.
- On Windows, execute `.cmd` / `.bat` commands through the shell while retaining direct spawn
  for normal executables.
- Git status includes recursive untracked files (`-u`).
- Studio Profiles are grouped above raw Ollama models in the model selector.
- Saved Studio Profiles and `:latest` short aliases are synchronized into Pi `models.json`.
- Session Tree refreshes automatically when its view is opened.
- Real Ollama E2E discovers saved Studio Profiles as valid models, handles reasoning-capability
  selection, uses the Windows-safe npm invocation, waits longer for real Pi startup, and checks
  untracked files recursively.
- Cross-platform server test path resolution uses `fileURLToPath`.
- HTTP regression coverage verifies the vendored xterm JavaScript and CSS routes.

## v1.6 hardware validation carried forward

The source fixes above originate from a v1.6.0 build that passed on Windows 11 with:

- Node.js v24.17.0
- Git 2.43.0.windows.1
- Ollama 0.30.9 at `http://192.168.0.20:11434`
- NVIDIA RTX 3090 24 GB
- Studio profile `15koutput:latest` / Qwen3.6-27B

The reported release gates all passed: syntax/module checks, unit/integration tests, live LSP,
Playwright UI E2E, and real Ollama + Pi coding E2E including checkpoint and historical worktree
restoration.

This dev build still keeps package installation/removal and other executable Pi Platform mutations
read-only until the runtime-validated v1.6 baseline is fully merged into the next stable line.
