# v1.8 rc.4 UI behavior proof matrix

**Audit date:** 2026-08-09  
**Target:** Windows 11, Node 24.17.0, Pi 0.83.0, Ollama 0.30.9, RTX 3090  
**Required hardware model:** `15koutput` / Qwen 3.6 27B, fallback disabled

This records what was actually exercised. It separates static control wiring, rendered browser behavior, backend/filesystem effects, and real Pi/Ollama hardware proof. A green static control contract is not presented as a substitute for a real user workflow.

## Current gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Syntax/static checks | PASS | `npm run check` |
| Deterministic unit/integration suite | **250 PASS, 14 documented platform skips, 0 failures** | `npm test` (264 records) |
| Live language servers | **4/4 PASS** | TypeScript, Pyright, HTML, Angular via `npm run test:lsp-live` |
| Real Pi RPC | PASS | Pi 0.83.0, session creation, command discovery, tree and stats via `npm run test:pi-live` |
| Rendered Windows browser workflow | PASS | `npm run test:ui`; real clicks, Monaco, iframes, xterm, temporary processes and disk state |
| Real Ollama + Pi coding workflow | PASS | `15koutput`, local Ollama, no fallback, two agent turns, tests, checkpoints and historical worktree |

The orchestrated `npm run verify:v1.8:windows` command completed all of those gates in one run on the exact documented tree and ended with `ALL v1.8 WINDOWS RELEASE GATES PASSED`.

The rendered workflow produced an empty `network-errors.log` and empty `http-errors.log`. It also explicitly observed the two intended negative paths: a failed candidate Ollama probe (`502`) and an optimistic editor-save conflict (`409`). Preview iframe requests canceled by an intentional Stop action are accepted only for the exact active Preview URL, during a five-second lifecycle window, and are recorded separately in `expected-network-aborts.log`.

## Rendered real-life workflows

| Surface | User workflow exercised | Proof beyond clicking | Artifact |
| --- | --- | --- | --- |
| Ollama runtime | Test active A, fail another endpoint, reject direct Save bypass, test B, choose **Use this server** | A inventory remains until activation; B `/api/tags` and `/api/ps` replace A; persisted config points to B | `13-remote-model-library-lifecycle.png`, `backend-status.json` |
| Remote model library | Diagnose, unload, pull/download, select, persist and delete a model on active Runtime B | Mutable fake remote inventory and backend `defaultModel` are asserted after each action | `13-remote-model-library-lifecycle.png` |
| New Project | Open wizard, choose parent, create Plain HTML, handle Git onboarding | Final folder and `index.html`, `styles.css`, `script.js` are verified on disk; Explorer switches to it | `07-new-project.png` |
| Plain HTML Preview | Start Studio's built-in static server without npm/Python | Real iframe renders the generated heading from the new project | `12-plain-html-static-preview.png` |
| Workspace A to B | Open plain project, create terminal, switch to fixture, use Recent Projects B to A to B | Old files disappear, old terminal backend is killed, canonical workspace input and Explorer show B | `10-recent-project-round-trip.png` |
| Editor | Open a real TypeScript file, click a Monaco line, type/undo, simulate an external agent edit | Caret location and Monaco model text are checked; stale Save receives `409`; newer disk bytes survive; Reload resolves conflict | browser workflow + empty unexpected-error logs |
| LSP/Problems | Start real LSP, inspect diagnostics, use **Ask Agent** | Diagnostic content is moved into the composer; live LSP suite independently validates navigation/completion/rename/diagnostics | `14-live-model-active-harness.png` |
| Git | Inspect diff, stage, use Ctrl+Enter to commit | Git status/index/commit state is checked through backend and real Git commands; Monaco diff lifecycle is error-free | browser workflow + deterministic Git integration |
| Terminal | Create visible xterm session, type a command, split, drag resize, close and kill | Terminal history/output and backend process removal are polled; descendant cleanup is tested | browser workflow + backend session snapshots |
| Test Explorer | Discover and run the fixture's real Node tests | Test process result and UI status are asserted | `14-live-model-active-harness.png` |
| Pi Platform | Create prompt, reject dirty-tab discard, save prompt, AGENTS.md and skill | Exact project files are read back from `.pi/` and workspace root | browser workflow + filesystem reads |
| Harness Builder | Create project harness with `read`, `edit`, `bash`, and `tts_speak`; select it | Exact JSON manifest and launch tool allowlist are verified; active edit requires explicit Pi restart; active delete is blocked | `08-harness-builder.png`, `14-live-model-active-harness.png` |
| Provider | Create OpenAI-compatible provider, discover/probe model, override capabilities and sync | `models.json` contains configured limits and env reference, never literal secret | browser workflow + disk/API assertions |
| MCP | Configure HTTP server, connect, call tool, read resource/prompt, change Pi exposure | Manual results are asserted; config persists; public API redacts literal header | browser workflow + config/API assertions |
| Pi marketplace/packages | Search, inspect trust, select older version, install project-local, disable extension resource | Exact pinned source and `extensions: []` are verified in `.pi/settings.json`; metacharacter path reaches Pi literally | browser workflow + filesystem assertions |
| Preview dev server | Start manual server, render V1, edit in Monaco, save, refresh to V2, open editor/Preview split, stop | Both iframes render changed source; server state and process stop are verified | `02-preview-main.png`, `03-preview-updated.png`, `04-editor-split-preview.png` |
| Pi chat controls | Start Pi with selected model/harness, prompt, steer, follow up and abort | Fake Pi launch trace contains exact model/harness/tools; UI busy-state transitions are asserted | `09-pi-chat-controls.png`, `backend-status.json` |
| Pi resource restart | Modify active harness/package resources, observe restart requirement, restart | Same workspace/model/harness remain bound; latest resources become active and notice clears | `05-pi-restart-resource-lifecycle.png` |
| TTS | Status, Wake, Sleep, direct generate, assistant Speak | Fake Qwen API state changes are asserted and generated blob audio is accepted by CSP | `11-tts-lifecycle.png` |
| Sessions | Live tree, session-list Fork, full Clone, historical exact-node Fork, restart/rebind | New JSONL sessions and selected ancestry are verified; tree remains historical instead of being overwritten by live tree | `06-session-tree.png` |
| Real 27B coding | Prompt agent to implement code and tests, second prompt for README, create project from first checkpoint | Real files/tests/Git checkpoints and historical worktree contents are verified with `15koutput`; no fallback | `test-results/ollama-e2e/final.png`, `trace.zip` |

## Static UI coverage

`test/ui-control-contract.test.mjs` audits the complete static DOM surface:

- every static interactive ID is unique and connected to frontend behavior;
- every static control has a visible or accessible name;
- id-less controls use an explicit delegated-action contract;
- recent-project Open and Remove retain distinct handlers;
- session cards have one authoritative Fork/Clone renderer.

Additional DOM/controller tests cover view/settings tabs, model state, composer history, message actions, busy/disabled states, accessible creation forms, session dialogs, TTS, terminal controls and command/Vim registration. Dynamic provider, MCP, package, Pi Platform and Preview controls are then exercised in the rendered workflow.

This is broad UI proof, not a claim that every possible timing, browser, extension, MCP server or third-party model combination has been exhausted.

## Bugs found by the workflow audit

- DiffEditor models could be disposed before Monaco detached them.
- Runtime Test and active-runtime inventory could diverge in the UI.
- A failed live model switch could repaint a stale browser preference.
- stopped/historical sessions could lose their reconstructed tree shape.
- session-list Fork behaved like Clone instead of requiring an exact prompt.
- a stale Workspace A Stop could terminate a newer Workspace B Pi process.
- active harness/resource edits could lose their restart-required state after a snapshot refresh.
- TTS lifecycle status could be optimistic and generated blob audio was blocked by CSP.
- terminal close/resize, Git shortcuts, overlay Escape behavior, dirty Pi resources and recent-project handlers had UI integration defects.
- intentional Preview Stop could race iframe navigation; the harness now distinguishes this exact lifecycle cancellation from real network errors.

## Remaining honest limits

- The 14 deterministic skips are explicit platform/permission cases, mainly POSIX-only signal behavior or unavailable Windows symlink creation. Equivalent Windows process-tree behavior is covered by Windows-specific paths and rendered workflows.
- Chromium reports the standard warning for a local Preview iframe using both `allow-scripts` and `allow-same-origin`. Preview is restricted to loopback URLs; this warning is documented and is not an unhandled page error.
- A formal screen-reader audit and exhaustive browser matrix are not complete.
- Kernel/RLM execution, subagents, automatic tool discovery and self-improving harnesses remain intentionally outside v1.8.

## Release conclusion

The agreed v1.8 single-agent product workflows are backed by rendered, backend, disk/process and real-hardware evidence. Future bug reports should be treated as rc.4 regressions with a new workflow reproduction, not as permission to replace these tests with superficial click checks.
