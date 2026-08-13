# Pi Ollama Studio v1.8.0-rc.3 — Final Pre-Windows Code Review

**rc.3 adversarial hardening:** extends rc.2 with process-tree cleanup for MCP/package commands, per-file persistence serialization, stale async provider protection, MCP/Preview lifecycle serialization, SemVer-correct marketplace ordering, split-chunk Preview URL detection, HTTPS localhost Preview CSP support, and malformed-request classification.

Review date: 2026-08-07

## Baselines and scope

This v1.8 development line is a forward continuation of the Windows-curated v1.7.0-rc.1 production baseline. The v1.7 Windows fixes are compatibility invariants, not refactor targets: canonical workspace/session paths, drive-letter normalization, native Windows folder picker behavior, RPC session containment, checkpoint workspace keys, session-tree checkpoint association, and the production historical-worktree API flow must remain intact.

The review is also constrained by the v1.8 roadmap and the two architecture research reports:

- v1.8: modular agent platform, provider abstraction, MCP, Pi resource/package platform, online marketplace, trust inspection, hardening and E2E coverage.
- v1.9: subagents, isolated worktree orchestration, routing/delegation and merge/review workflows.
- v2.0: Electron/typed IPC product shell, telemetry/benchmark lab, visual testing platform, stronger sandboxing and advanced Vim semantics.

## Current v1.8 architecture

### Stable inherited foundation

- Pi RPC lifecycle, sessions, tree navigation, compaction and checkpoints.
- Ollama local/LAN/HTTPS runtime profiles and model management.
- Monaco workbench, split panes, stale-save conflict protection and external-edit reload behavior.
- LSP process lifecycle and diagnostics/navigation providers.
- xterm/node-pty integrated terminal.
- Git status/diff/stage/restore/checkpoint/worktree flows.
- Test Explorer and run configurations.
- Pi instructions, skills, prompts, extensions, packages and scoped settings inspection/editing.

### v1.8 provider platform

Implemented and reviewed:

- OpenAI/OpenAI-compatible provider profiles.
- `/v1/models` discovery.
- Responses API first with Chat Completions fallback when provider API is `auto`.
- tool and JSON Schema capability probes.
- manual per-model overrides for context window, max output, tools, JSON Schema, vision and reasoning.
- environment-variable-backed credentials; secret values are not persisted.
- Pi-native `models.json` synchronization.
- provider settings UI and provider-aware model selector entries.

Review fix: Auto capability values previously treated explicit `null` override fields as a real override and therefore hid detected values. Null/undefined overrides now correctly fall through to detected capability values.

### v1.8 MCP platform

Implemented and reviewed:

- stdio and HTTP MCP connections.
- tools/resources/prompts discovery.
- manual Studio tool/resource/prompt APIs.
- agent-only MCP endpoints that independently enforce Pi exposure.
- managed Pi extension bridge with dynamic tool registration.
- live active-tool updates through Pi `getActiveTools()` / `setActiveTools()` semantics.
- per-server exposure plus per-tool disable controls.
- MCP status and logs UI.

Review fix: public MCP snapshots previously preserved non-sensitive literal HTTP header values. All literal env/header configuration values are now hidden from browser/API snapshots; `$ENV_VAR` references remain visible, while the local MCP config continues to retain the actual configured value.

### v1.8 package marketplace

Implemented and reviewed:

- npm-backed Pi package discovery using the `pi-package` ecosystem.
- Extensions / Skills / Prompts / Themes filtering.
- package manifest/resource inspection.
- repository/homepage metadata.
- global/project install and remove through Pi's own package commands.
- npm, Git, HTTP(S), SSH and local sources.
- explicit npm version pinning.
- installed resource filters using Pi-native All / None / Custom semantics.
- update/reconcile action using Pi's native `pi update <source>` behavior.
- install-risk summary for install scripts, executable extensions and dependency count.
- npm integrity / shasum / publication metadata when the registry provides it.

Review fixes:

1. `update` was recovered as another `install` operation. It now calls the real Pi update command.
2. Project-local relative package identity is resolved relative to `.pi/settings.json`, matching Pi settings semantics.
3. The marketplace previously showed latest-version manifest/risk data even after selecting an older pinned version. Version selection now fetches exact-version details before installation, so scripts/resources/dependencies/integrity shown in the UI correspond to the exact version being installed.
4. Package registry origin can be overridden with `PI_STUDIO_PI_PACKAGE_REGISTRY` for deterministic integration/E2E testing while defaulting to the npm registry.

### v1.8 modularization

Backend route ownership is now separated for:

- providers
- MCP
- packages
- Pi Platform
- Test Explorer / run configurations

The Pi Platform frontend resource manager has also been extracted into `public/pi-platform-panel.js`. `public/app.js` is reduced to about 4.5K lines and no longer owns the full Pi Platform editor/list/overview controller.

Review fix: recovered v1.8 UI styles were in `public/style.css`, but `index.html` loads `/styles.css`. Provider/MCP/marketplace styles are now merged into the stylesheet actually loaded by the application, with a regression test.

## Verification completed in this environment

- `npm run check`: PASS.
- `npm test`: **142/142 tests PASS**, 0 failures, 0 skipped.
- Live HTTP/integration coverage is included in the deterministic suite, including provider, MCP, exact-version package, App Preview, package provenance, Git, filesystem, terminal and Test Explorer routes.
- `npm run test:lsp-live`: **4/4 PASS** (TypeScript, Pyright, HTML, Angular).
- `npm run test:pi-live`: command harness executes, but real Pi is unavailable in this managed environment, so the script reports SKIP.
- `npm run test:ui`: the expanded Playwright suite is syntax-clean and starts, but Chromium navigation to localhost is blocked by the managed environment's URL policy. This remains a Windows/normal-browser gate.
- Real Ollama / RTX 3090 inference cannot be reproduced in this environment and remains a Windows hardware gate.

## Expanded v1.8 rendered E2E workflow

`scripts/test-ui-e2e.mjs` now drives the real Studio UI for the new v1.8 systems using local deterministic service fixtures:

### Providers

- create provider
- discover models
- capability probe
- set `65536` context / `15000` max output / reasoning on / vision off
- sync to Pi
- verify `models.json` on disk
- verify environment-backed credential reference and absence of secret value

### MCP

- create HTTP MCP server
- connect
- inspect tools/resources/prompts
- disable and re-enable tool exposure
- verify persisted exposure state
- verify public API does not return literal header value

### Pi package marketplace

- open Browse Online Extensions
- search registry
- inspect latest-version install risk
- choose explicit older version
- verify detail panel refreshes to the selected version's risk/integrity metadata
- project-local pinned install
- verify `.pi/settings.json`
- disable Extension resources
- verify Pi-native empty-array filter persists on disk

The existing rendered workflow continues to cover Monaco mouse caret, external-edit conflicts, Git onboarding/diff, integrated terminal, Test Explorer, Pi Platform prompts/skills/instructions/settings, live LSP Problems, split panes, optional Vim/leader interaction, Pi RPC and session tree.

## v1.8 implementation status

The planned v1.8 feature scope is implemented in this RC. In addition to the recovered provider/MCP/package work, the final RC now includes:

- App Preview workspace tab with managed dev-server lifecycle, persisted workspace command/URL, localhost URL detection, logs/status, refresh/restart/open-external controls and Editor + Preview side-by-side mode.
- Git/local/npm package provenance: npm integrity/publication metadata, Git resolved HEAD, local source hashing, executable-resource/install-script risk and exact-version marketplace inspection.
- Richer manual MCP tool/resource/prompt flows while preserving the separate Pi exposure boundary.
- Runtime-bound Ollama Studio profiles (`runtimeId` + base URL metadata) for newly-created profiles, while legacy profiles remain portable and visible.
- Universal semantic search across files, sessions, models, commands, Pi resources, providers, MCP entities and packages.
- Additional backend route extraction for Preview and Ollama while preserving the Windows-verified Pi/session/Git execution core.
- A one-command Windows release verifier: `npm run verify:v1.8:windows`.

### Remaining release validation (not implementation work)

The code is at **v1.8.0-rc.3**. The remaining gate before promoting it to final v1.8 is validation on the Windows production environment:

1. Run the rendered Chrome/Edge Playwright suite.
2. Run real Pi RPC with the installed Pi executable.
3. Run the real Ollama + Pi hardware E2E on the RTX-class Windows machine.
4. Report any Windows/UI regressions found during manual use; fixes should remain v1.8 bugfixes and be forward-compatible with the later v1.9 branch.

## Explicitly deferred

Do not add these to v1.8 merely because they are discussed in the research reports:

- subagents
- parallel multi-agent worktree orchestration
- model-routing/delegation policies for multiple agents
- Electron/typed IPC migration
- telemetry/benchmark lab
- full visual/browser testing platform
- advanced full Vim emulation

Those remain v1.9/v2.0 roadmap work.
