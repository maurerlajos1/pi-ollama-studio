# Pi Ollama Studio v1.8.0-rc.4

RC4 focuses on cross-feature state coordination discovered during real Windows validation and continued adversarial debugging.

## Runtime switching
- Ollama **Test Connection** now inspects the typed server without pretending it is already active.
- The tested server displays its **installed models** (`/api/tags`) and **currently loaded models** (`/api/ps`).
- A dedicated **Use this server** action makes the tested endpoint authoritative.
- Switching Ollama endpoints invalidates the previous runtime inventory immediately, reloads the new installed/loaded model lists, re-evaluates runtime-bound profiles, syncs Pi models, and stops a running Pi process before changing runtime context.
- Runtime identity is exposed consistently for legacy `runtimeId` profile compatibility.

## Workspace switching
- Workspace changes now run through an explicit leave/activate transaction instead of only changing the path field.
- Leaving workspace A stops/detaches Pi, Preview, old-workspace terminals and LSP instances.
- Editor buffers/models, attachments, session-tree selection, checkpoints, workspace search, test results, Pi resources/platform snapshot and Git diff state are invalidated before workspace B becomes active.
- Workspace B then reloads files, Git, sessions, terminals, LSP status, Pi Platform resources and Preview configuration.
- Create Project from Prompt uses the same workspace switch path, preventing a newly created project from leaving panels bound to the source workspace.

## Persistence and upstream hardening
- Mutating provider, MCP, Ollama/profile, package/settings, checkpoint and config paths use strict JSON reads so a corrupt JSON store is not silently replaced with an empty store.
- Ollama runtime probes return both installed and running model inventories.
- New transition regression tests assert that the new state appears **and the old state disappears**.
- Windows Playwright workflow now covers Ollama Runtime A -> B and Workspace A -> B, including old-workspace terminal cleanup.

## Final UI/UX and workflow hardening (2026-08-09)
- Long local generations keep truthful busy state, elapsed time, Stop/Steer/Follow-up controls, and selected/session-model identity without switching to a fallback model.
- Pi-only actions are disabled until Pi is running, while provider, MCP, package, project, session and Preview forms now expose validated readiness and duplicate-click-safe busy states.
- Provider, MCP and package removal requires explicit confirmation; MCP lifecycle and exposure controls recover cleanly from errors and reconnects.
- Session Fork and Clone now use an accessible in-app dialog with validation instead of browser `prompt()` calls.
- Multi-word Documentation search requires all query terms and recognizes task language such as `runtime switch`.
- Ollama pull/unload behavior is exact, reports the active runtime clearly, and keeps installed, loaded, selected and session-model state distinct.
- Preview preserves a manually typed command or URL when Start is clicked. This fixes a rendered-UI race that could replace the user's command with an older auto-detected suggestion.
- The rendered E2E fixture now performs a genuine persisted Runtime A -> B switch instead of accidentally pinning Runtime A through an environment override.
- The real-Pi harness uses the same literal-argv Windows-safe spawning policy as production code.
- A comprehensive implementation and UX scorecard is available in `docs/handoff/RC4_COMPREHENSIVE_RELEASE_CHECKLIST.md`.

## Current verification
- `npm run check` — PASS.
- `npm test` — **264 test records: 250 PASS, 14 explicit platform skips, 0 failures**.
- `npm run test:ui` — PASS in rendered Chromium, including Runtime A -> B, workspace/project, provider, MCP, package, Preview, Pi and session workflows.
- `npm run test:lsp-live` — **4/4 PASS**.
- `npm run test:pi-live` — PASS with Pi **0.83.0**.
- A real manual UI generation passed with `15koutput:latest` (Qwen3.6 27B), 65,536 context, the `coding-web` harness and no fallback.
- `npm run verify:v1.8:windows` — **ALL GATES PASSED** on 2026-08-09, including the complete local Ollama/RTX 3090 workflow. The hardware test required `15koutput`, verified it from the real Ollama inventory, and ran with fallback disabled.
