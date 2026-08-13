# Pi Ollama Studio v1.7.0-dev.1 — Parallel Pi Platform Build

This development build branches from the frozen v1.6 release candidate. The v1.6 runtime systems under hardware validation (Pi↔Ollama execution, PTY backend, Test Explorer execution, checkpoints/worktrees, remote Ollama authentication, and the real-model E2E harness) were intentionally left unchanged.

## Added: Pi Platform Manager

The Resources workspace is now a broader Pi Platform workspace with these tabs:

- Overview
- Commands
- Instructions
- Skills
- Prompts
- Extensions
- Packages
- Settings

### Instructions

Studio discovers the current Pi instruction hierarchy:

- global `~/.pi/agent/AGENTS.md`
- `AGENTS.md` / `CLAUDE.md` from project ancestors through the current workspace
- global/project `SYSTEM.md`
- global/project `APPEND_SYSTEM.md`

Project/global context files can be created or edited from the UI. Ancestor context is inspection-only so Studio does not unexpectedly modify parent repositories.

### Skills

Studio discovers:

- `~/.pi/agent/skills`
- `~/.agents/skills`
- project `.pi/skills`
- `.agents/skills` from the project/ancestor hierarchy

Global/project skills can be created and edited. The UI clearly warns that skills may direct the agent to execute helper scripts.

### Prompt templates

Global and project prompt templates can be inspected, created and edited. Prompt descriptions are read from frontmatter when available. Prompts can be inserted into Chat or executed from the same resource detail panel.

### Extensions

Global/project extension source files are discoverable and inspectable. Extension editing/enabling is deliberately read-only in this development branch because extensions execute arbitrary code with the user's permissions.

### Packages

Configured global/project Pi package entries are displayed with scope and filter configuration. The UI can copy the matching `pi install` or `pi install -l` command. Actual install/remove/update operations remain frozen until the v1.6 hardware validation is complete.

### Scoped settings

Studio displays global, project and merged/effective Pi settings. Global/project JSON can be edited with JSON validation. Project settings are presented as overrides of global settings.

### Context visibility

The Overview reports an intentionally conservative context estimate:

- persistent context-file token estimate
- discovered skill-description token estimate
- current Pi context usage when Pi is running

Prompt-template bodies and extension source are not falsely counted as active model context.

## Security decisions

- No extension is executed by the platform inspector.
- No Pi package is installed, updated or removed by this development build.
- Resource names are constrained to their documented Pi roots.
- Context writes are restricted to `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`.
- Settings writes require a JSON object.
- Project resources are shown with a trust warning because Pi project trust controls whether project-local executable resources are loaded.

## Verification in the development environment

- `npm run verify`: PASS
- deterministic Node test/subtest records: 80/80 PASS
- real bundled LSP matrix: PASS (TypeScript, Pyright, HTML, Angular)
- real Pi RPC 0.82.1: PASS when pointed at the uploaded offline Pi package
- Playwright UI E2E: updated to exercise Pi Platform prompt and AGENTS.md creation; rendered execution remains subject to the managed Chromium URLBlocklist in the build environment and should be run on the user's Windows machine.

## Merge policy

Do not promote this development build over v1.6 RC until the Windows/RTX 3090 v1.6 release and real-Ollama E2E gates have been run. If v1.6 finds a runtime bug, fix v1.6 first and merge that fix forward into v1.7.
