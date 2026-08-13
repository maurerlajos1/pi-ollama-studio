# Pi Ollama Studio v1.8.0-rc.1

v1.8 turns the verified v1.7 local IDE foundation into an agent platform while preserving the Windows-curated session/Git/path behavior.

## Agent platform

- OpenAI/OpenAI-compatible provider profiles with model discovery, Responses-first/Chat fallback, capability probes, manual per-model overrides, environment-backed credentials and Pi `models.json` sync.
- MCP manager for stdio and HTTP servers with tools/resources/prompts discovery, manual Studio invocation, logs/lifecycle state, Pi exposure controls and live active-tool updates.
- Unified Pi Platform manager for instructions, skills, prompts, extensions, packages and scoped settings.
- Online Pi package marketplace using the native `pi-package` npm ecosystem, exact-version pinning, project/global install/update/remove and native resource filters.
- Package trust/provenance inspection: npm integrity/version metadata, Git HEAD revision inspection, local package file hashing, manifest resources, install scripts and dependency risk.
- Universal semantic search now includes Pi resources, providers, MCP servers/tools/resources/prompts, files, sessions, models and commands.

## App Preview

- New Preview workspace tab.
- Workspace-scoped dev-server command and URL persistence in `.pi/studio-preview.json`.
- `package.json` dev/preview/start command suggestions.
- Managed process lifecycle with Windows process-tree termination and Unix process-group termination.
- Localhost URL detection/normalization, iframe preview, refresh/restart/open-external, status and logs.
- Editor + App Preview side-by-side mode keeps Monaco visible while the running application is rendered beside it.
- Semantic commands: `view.preview`, `preview.start`, `preview.restart`, `preview.refresh`, `preview.toggleSplit`.

## Runtime correctness

- Newly-created Studio Ollama profiles are bound to the Ollama runtime endpoint that created them (`runtimeId` + base URL metadata).
- Legacy profiles remain portable/visible for backward compatibility.
- Profiles bound to another runtime are shown unavailable instead of silently selected.
- Pi Ollama model sync excludes incompatible runtime-bound profile metadata.

## Modularization

Feature route ownership is split for providers, MCP, packages, Pi Platform, Test Explorer/run configurations, Preview and Ollama. Pi Platform and Preview frontend controllers are also separate modules. The hardware-verified Pi/session/Git core remains unchanged.

## Windows release gate

Run:

```powershell
npm run verify:v1.8:windows
```

This executes static checks, deterministic tests, live LSP, real Pi RPC, rendered Chrome/Edge Playwright workflows, and the real Ollama/Pi hardware E2E.

## Pre-Windows verification status

Verified in the managed Linux environment on August 7, 2026:

- `npm run check`: PASS.
- `npm test`: **129/129 tests PASS**, 0 failures, 0 skipped.
- `npm run test:lsp-live`: **4/4 PASS** (TypeScript, Pyright, HTML, Angular).
- `npm run test:pi-live`: harness executes but reports SKIP because the real `pi` executable is not installed in this environment.
- Rendered Playwright navigation to localhost is blocked by this environment's browser URL policy; the full rendered workflow remains part of the Windows release gate.
- Real Ollama/GPU inference remains part of the Windows hardware release gate.

Before promoting RC1 to final v1.8, run `npm run verify:v1.8:windows` on the production Windows test machine and report any UI/platform regressions.
