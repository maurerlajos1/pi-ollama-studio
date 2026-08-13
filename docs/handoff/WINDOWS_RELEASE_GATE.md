# Windows Release Gate for v1.8 rc.4

Run this gate on the target Windows/UI/GPU machine before calling v1.8 stable.

**Latest exact-tree result (2026-08-09): PASS.** `npm run verify:v1.8:windows` completed static checks, 264 deterministic records, 4/4 live LSP, Pi 0.83.0, rendered UI, and `15koutput` on the RTX 3090; fallback was disabled. Detailed artifacts are indexed in `UI_BEHAVIOR_PROOF_MATRIX.md`.

## Known target environment from prior validation

- Windows 11
- Node 24.x
- Git for Windows
- Pi CLI installed
- Ollama reachable locally or over LAN
- NVIDIA RTX-class GPU / real model runtime
- For the primary `15koutput` / Qwen 3.6 27B gate, close or unload unrelated GPU model runners first. The release test does not silently terminate unrelated `llama-server.exe` processes or substitute a smaller model.

## Main command

```powershell
npm run verify:v1.8:windows
```

Use `RC4_COMPREHENSIVE_RELEASE_CHECKLIST.md` as the human sign-off companion to this command.

Also useful individually:

```powershell
npm run check
npm test
npm run test:lsp-live
npm run test:pi-live
npm run test:ui
npm run test:ollama-e2e:windows
```

## Must manually/rendered verify

### Project flows

- New Project → select parent folder → create Empty/HTML/Node project → exact final folder becomes active.
- Open Folder A→B → header, Explorer, Git, sessions, tests, LSP, terminal context, Pi resources and Preview all show B.
- Create from Session → choose prompt → choose destination → create worktree/fallback → open new workspace → bind/open forked session.
- Failed creation leaves original workspace active and no partial project/worktree/branch debris.

### Ollama runtime flows

- Active A has A-only models.
- Test B shows B installed + loaded inventories but leaves A active.
- Failed B test leaves A health/inventory untouched.
- Use tested B removes A-only model state and makes B authoritative.
- Switching back behaves correctly.
- Selected model is never replaced merely because another model is loaded in VRAM.

### Model/session flows

- Installed / Loaded / Selected / Session Model are visibly distinct.
- Starting a session with an already-loaded selected model does not cause an unnecessary logical model switch.
- A selected model unavailable on the active runtime is clearly invalid/disabled.
- Failed live switch does not persist the failed model as startup default.
- Harness selected for next session is not falsely shown as active on an already-running Pi process.
- Install/enable/change a Pi extension while a session is running → visible restart-required notice → restart Pi → same workspace/model/harness/session remains bound and the notice clears.
- Select `Coding · Pi Default + Web` with the Pi web-search extension installed → start a new session → verify the extension tools are available; if the extension is absent/disabled, verify Studio does not claim web tools are healthy.
- Start a cold `15koutput` generation and allow the full model-load/generation time; verify the UI remains Working, Send is disabled, and Steer/Follow Up/Abort are enabled rather than showing a false connection error.

### Harness flows

- Settings → Harness → New harness → choose scope/kind/tools/guidance → Save Harness → it appears in the list and can be selected for the next session.
- Duplicate a built-in preset → edit/save → verify the custom manifest is stored in the chosen global/project scope.
- Save effective → verify the current launch contract is reusable without copying Pi packages/extensions into a hidden Studio format.

### Preview

- Framework dev-server detection.
- ANSI/split URL parsing.
- Plain HTML static preview.
- Edit/save/refresh shows updated HTML.
- Workspace A→B stops/detaches A Preview before B Preview is shown.
- Type a manual Preview command and immediately click Start; verify the exact typed command runs rather than an older detected suggestion.

### UI integrity

- Session Fork/Clone naming uses the in-app dialog; Enter/Cancel/Escape and empty-name gating behave correctly.
- Provider/MCP/project/harness/direct-package forms start disabled until actionable.
- Provider/MCP/package/model/harness removal requires confirmation.
- Package Install/Inspect/Apply/Update/Remove displays a busy state and cannot be double-submitted.
- Keyboard-only navigation can reach projects, sessions, Explorer, Git files, dialogs, tests and semantic commands.

### Windows process/path invariants

- spaces and shell metacharacters in paths/package names remain literal arguments
- drive-letter case/realpath aliases do not split workspace/session/checkpoint identity
- junction/symlink containment checks hold
- Pi/LSP/Ollama/Preview/terminal stop/crash does not leak descendants

## Release rule

Do not update the final release notes to claim Windows/RTX/UI success unless these commands actually pass on the target machine.
