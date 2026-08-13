# Pi Ollama Studio v1.8 rc.4 — Comprehensive Implementation and UX Checklist

**Audit date:** 2026-08-09  
**Scope:** Ollama, Pi, providers, MCP, Pi resources/packages, projects, sessions, Git, coding workbench, Preview, TTS, UI/UX, accessibility, security, reliability, and release verification.

This is the current release checklist for the authoritative rc.4 working tree. It is intentionally stricter than a feature list: a feature is considered complete only when its backend behavior, rendered state, persistence, error handling, and cross-context behavior agree.

## Status and scoring legend

- ✅ **Current pass** — verified by the current code and a current deterministic, integration, rendered, or live check.
- 🟢 **Hardware-verified** — passed the current Windows/RTX gate on the exact audited tree.
- 🟡 **Final target-machine gate** — implemented and covered deterministically, but still requires the final Windows/GPU/rendered rerun.
- ⚪ **Deferred** — deliberately outside v1.8; do not market it as implemented.
- ❌ **Release blocker** — known broken behavior. There are no open blockers at the time of this checklist.

Scores describe v1.8 release quality, not the entire long-term roadmap:

- **9–10:** release-quality implementation; only final platform verification or minor polish remains.
- **8–8.9:** strong and usable; a documented gap or deeper UX polish remains.
- **7–7.9:** functional but not yet coherent enough to freeze.
- **Below 7:** incomplete or misleading.

## Current evidence

- ✅ `npm run check` — PASS.
- ✅ `npm test` — **264 test records: 250 PASS, 0 failures, 14 explicit platform skips**.
- ✅ Full HTTP/UI-backend integration suite — PASS, including real temporary workspaces, Git, terminal, tests, LSP transport, Preview, provider, MCP, packages, and Pi Platform routes.
- ✅ `npm run test:ui` — PASS in rendered Chromium, including genuine Ollama Runtime A→B, workspace/project, provider, MCP, package, manual Preview, Pi, and session workflows.
- ✅ `npm run test:lsp-live` — **4/4 PASS** for TypeScript, Pyright, HTML, and Angular.
- ✅ `npm run test:pi-live` — PASS with Pi **0.83.0** using production-safe literal-argument process launching.
- ✅ Current rendered browser audit has no unexpected page, HTTP, or network errors. Chromium's standard local Preview sandbox warning and the two deliberate negative-path HTTP responses are documented separately.
- ✅ Current patched server stderr log is empty.
- ℹ️ npm prints an external host warning for `NPM_CONFIG_STORE_DIR`; the repository does not define `store-dir`, and this does not originate from Studio code.
- ✅ Real UI → Pi → Ollama generation passed with `15koutput` / Qwen3.6 27B, 65,536 context, `Coding · Pi Default + Web`, and no fallback. The exact requested response `UI_BUSY_STATE_OK` completed successfully.
- ✅ During that multi-minute-capable generation, Send was disabled while Steer, Follow Up, and Abort were enabled; after settlement, the state reversed correctly.
- ✅ The complete `npm run verify:v1.8:windows` gate passed on this exact tree on 2026-08-09 with Pi 0.83.0, Chrome rendering, local RTX 3090 generation, Git checkpoints, a second turn, Session Tree project creation, and historical worktree restoration.
- ✅ The hardware harness required `15koutput`, read the real nested Ollama model inventory, tolerated only a bounded startup-inventory delay, and ran with fallback disabled.

## Executive scorecard

| Area | Score | Release assessment |
| --- | ---: | --- |
| Ollama runtime lifecycle | **9.6/10** | Local auto-start, LAN safety, ownership, no fallback, long-load handling, and process cleanup are coherent. |
| Model inventory/profiles/GPU state | **9.4/10** | Installed, loaded, selected, and session model are separated and runtime-scoped. |
| Pi lifecycle/RPC/chat | **9.5/10** | Real Pi generation, streaming state, tool events, steering, follow-up, abort, compaction, and raw RPC are implemented. |
| Sessions/tree/checkpoints/worktrees | **9.4/10** | Session and Git history remain distinct; fork/clone/create-from-history are now complete UI workflows. |
| Projects/workspace transitions | **9.5/10** | New/Open/Recent/Create-from-Session and A→B teardown/generation guards are implemented. |
| Harnesses/Pi resources | **9.1/10** | Real reusable launch contracts and Pi-native resources work; advanced automatic harness building is correctly deferred. |
| Providers/MCP/packages | **9.3/10** | Discovery, probing, exposure, trust, versioning, resource controls, concurrency, and corruption safety are covered. |
| Editor/LSP/Git/terminal/tests | **9.3/10** | Strong local IDE core with real processes and path containment. |
| Preview | **9.5/10** | Framework/manual/plain-HTML Preview, split view, URL detection, and lifecycle isolation are implemented. |
| TTS | **8.6/10** | Safe loopback proxy, lifecycle, playback, and Pi tool exist; full Qwen3-TTS GPU coexistence remains a target-machine concern. |
| UI clarity and discoverability | **9.2/10** | Major workflows are visible, stateful actions are gated, and primitive prompts have been removed. |
| Accessibility/keyboard/Vim | **8.9/10** | Semantic commands, keyboard/Vim layer, accessible labels, buttons, and modal semantics exist; formal screen-reader audit remains. |
| Security/data integrity/process reliability | **9.6/10** | Loopback-only execution, canonical containment, atomic writes, corruption preservation, race protection, and process-tree cleanup are strong. |
| Documentation/release handoff | **9.3/10** | Product truth, workflows, roadmap boundaries, and Windows gates are documented in-app and in-repo. |

**Overall v1.8 implementation RC score: 9.3/10.** The implementation is feature-complete for the agreed single-agent v1.8 scope, and the current Windows/rendered/RTX gates are green. Remaining work is release packaging and regression fixes found during user acceptance, not another architecture expansion.

---

## 1. Ollama runtime and lifecycle checklist — 9.6/10

### Endpoint identity and switching

- ✅ The active Ollama endpoint is authoritative and persisted.
- ✅ **Test Connection** probes a candidate endpoint without changing the active runtime.
- ✅ A tested endpoint shows its own installed `/api/tags` and loaded `/api/ps` inventories.
- ✅ **Use this server** is bound to the exact tested URL/auth/runtime-kind fingerprint.
- ✅ A failed test cannot overwrite active runtime health or inventory.
- ✅ Runtime A→B clears A-only model state and reconciles selection against B.
- ✅ A slow result from runtime A cannot repaint runtime B.
- ✅ IPv4, IPv6 loopback, LAN IP, and HTTPS-style endpoints normalize correctly.
- ✅ API-key environment-variable names may be stored; literal key values are not returned to the browser.
- ✅ Switching runtime while Pi is active stops/rebinds Pi rather than leaving an A-bound process behind a B UI.

### Local, LAN, and process ownership

- ✅ If a required **local loopback** Ollama is offline, Studio can start it and wait for readiness.
- ✅ Studio never attempts to start a LAN/remote Ollama server.
- ✅ Studio distinguishes endpoint health from Studio process ownership.
- ✅ Stop/Restart controls are enabled only for an Ollama process Studio owns.
- ✅ An externally started local Ollama is reused and never falsely claimed as Studio-owned.
- ✅ Concurrent Managed Ollama starts are serialized.
- ✅ Unexpected parent crashes clean descendant workers.
- ✅ Managed environment variables follow the configured endpoint and do not invent a machine-specific model directory.
- ✅ The repository policy still supports `H:\ollama-models` on this target machine without hard-coding that path into portable application behavior.

### Fallback and long generation

- ✅ There is **no hidden model/provider fallback**.
- ✅ An offline remote Ollama returns a clear runtime error rather than silently substituting local Ollama or a smaller model.
- ✅ Provider-backed Pi sessions do not incorrectly require Ollama.
- ✅ Ollama stream timeouts are long enough for local large-model pulls/generation.
- ✅ The UI remains in Working state while a large local model loads/generates; it does not turn a normal warm-up delay into a fake connection error.
- ✅ Loaded residency is treated as a performance hint, never as model selection authority.

### Remaining polish

- 🟡 Verify the final visible load/residency transition once more on the RTX 3090 after a cold `15koutput` load.
- ⚪ Per-layer load progress/ETA is not promised because Ollama does not provide a reliable universal generation ETA.

---

## 2. Model inventory, profiles, and GPU state — 9.4/10

### Four distinct model states

- ✅ **Installed:** model exists on the active server.
- ✅ **Loaded:** model is resident according to active server `/api/ps`.
- ✅ **Selected:** Studio's next-session intent.
- ✅ **Session model:** model the running Pi process actually uses.
- ✅ Header, active-model card, runtime inventory, and session launcher use these definitions consistently.
- ✅ A loaded model never silently replaces the selected model.
- ✅ Selecting an already-loaded model naturally reuses it.
- ✅ Selecting an unloaded installed model leaves it selected and lets first generation/load warm it.
- ✅ An unavailable profile/model is not advertised as valid on the wrong active runtime.

### Profiles and synchronization

- ✅ Profiles store context, output, sampling, reasoning, vision, and system-prompt settings.
- ✅ Runtime-bound profiles can coexist with the same ID on different runtimes.
- ✅ A runtime-bound profile wins over a portable fallback for its own endpoint.
- ✅ A derived profile does not contaminate its base model's Pi entry.
- ✅ Vision input survives Pi synchronization.
- ✅ Reasoning toggles match exact model aliases, including intentional `foo` ↔ `foo:latest`, without substring collisions.
- ✅ Studio profiles and installed models are grouped in selectors.
- ✅ Pi `models.json` synchronization is serialized with provider/Ollama mutations.
- ✅ Corrupt profile/model stores are preserved and block mutation instead of being overwritten as empty data.

### Model actions

- ✅ Pull/download targets the **active** Ollama endpoint, including remote LAN Ollama.
- ✅ Pull is disabled until the active runtime is online and a model name is present.
- ✅ Unload targets exactly the selected/clicked loaded model.
- ✅ Unload buttons are disabled for models that are not loaded.
- ✅ Delete is explicit and confirmed.
- ✅ Diagnostics expose model metadata, context, KV estimate, VRAM, and offload state.
- ✅ Model aliases ending in `:latest` reconcile correctly with profile IDs.

---

## 3. Pi lifecycle, RPC, and chat — 9.5/10

### Process and session start

- ✅ Pi command resolution uses the native Windows shim correctly.
- ✅ Pi starts in the canonical active workspace.
- ✅ Concurrent starts are serialized; rapid double-start cannot leave an untracked Pi process.
- ✅ Stop/restart cleans descendant workers.
- ✅ Start accepts provider, model, session path/name, harness, tool allowlist, appended system prompt, extensions, and MCP bridge.
- ✅ First prompt can start Pi with the selected launch contract before sending.
- ✅ Failed start leaves the New Session launcher open with honest state.
- ✅ A stale session path is dropped during resource restart rather than poisoning startup.

### Chat and long-turn behavior

- ✅ User prompts render optimistically and roll back correctly if rejected.
- ✅ Attachments are restored if a prompt fails.
- ✅ Assistant text and thinking stream into the active message.
- ✅ Tool start/update/end events render as tool cards.
- ✅ Pi stderr/protocol/server errors are surfaced in Chat, Logs, Problems, or toasts as appropriate.
- ✅ Normal Send is disabled during an active generation.
- ✅ Steer Now, Follow Up, and Abort are enabled only during an active turn.
- ✅ Compact is enabled only when Pi is running and idle.
- ✅ A multi-minute local generation remains a valid active turn.
- ✅ Context usage is rounded and displayed against the active model context.
- ✅ Status bar says **tool calls**, not an ambiguous count.
- ✅ Assistant answers support Copy and TTS Speak.

### Pi controls and parity surfaces

- ✅ Thinking level is session state and does not mutate capability metadata.
- ✅ Session name, steering delivery, follow-up delivery, auto-compaction, and auto-retry are available.
- ✅ Pi-only controls remain disabled until Pi is running.
- ✅ Direct shell commands run through Pi rather than an unrelated hidden shell path.
- ✅ Available commands/resources can be loaded and inserted/run.
- ✅ Session HTML export is available.
- ✅ Raw Pi RPC provides an advanced escape hatch for supported RPC commands without dedicated UI.
- ✅ Pi extension UI requests support confirm, select, input/editor, status, title, and widgets.
- ✅ Risky-tool notification copy is honest: it notifies but does not claim to pause/sandbox Pi.

### Honest Pi parity limits

- ⚪ Pi's terminal TUI layout and arbitrary custom TUI component rendering do not map 1:1 through RPC.
- ⚪ Session import is not yet a first-class Studio workflow.
- ⚪ Provider OAuth/auth setup is not yet a first-class guided Studio flow; environment-backed provider credentials are supported.
- ⚪ Rich standalone system-prompt file management, external skill-repository configuration, and extension authoring assistance remain later polish.
- ⚪ `--no-session` is not a primary Studio mode because Studio's product model is session/history-centric.

---

## 4. Sessions, tree, checkpoints, and historical projects — 9.4/10

- ✅ Sessions list and inspect real Pi JSONL history.
- ✅ Session paths are restricted to the canonical workspace session directory.
- ✅ Session names display and persist.
- ✅ Resume opens the chosen session.
- ✅ Session Tree refreshes when a session starts/resumes while the view is open.
- ✅ Fork keeps only selected-node ancestry and excludes sibling branches.
- ✅ Clone copies the full session.
- ✅ Fork and Clone now use a validated, keyboard-accessible in-app modal rather than browser `prompt()`.
- ✅ Fork/Clone modal is disabled until a non-empty name exists.
- ✅ Fork/Clone abort if the active workspace changed while the dialog was open.
- ✅ Conversation branches and Git code checkpoints remain distinct concepts.
- ✅ Checkpoint associations tolerate Pi node ID shape differences.
- ✅ Checkpoint metadata mutations serialize without lost nodes.
- ✅ Create Project from a node prefers the exact Git checkpoint/worktree.
- ✅ Fallback copy excludes `.git`, dependencies, and old Studio session storage.
- ✅ Session/node validation happens before fallback filesystem creation.
- ✅ Failed worktree/project creation rolls back partial branch/worktree state.
- ✅ Canonical Windows path identity prevents drive-case/alias mismatches.

---

## 5. Project manager and workspace switching — 9.5/10

- ✅ Project Manager exposes New Project, Open Folder, Create from Session, and Recent Projects.
- ✅ New Project accepts name, parent folder, final path preview, and Empty/HTML/Node templates.
- ✅ Create is disabled until the final path is valid.
- ✅ Existing targets are refused rather than merged into.
- ✅ Folder browser supports drives, breadcrumbs, Up, New Folder, and selection.
- ✅ Folder/session/explorer items use real keyboard-focusable buttons.
- ✅ Recent project rows expose accessible Open and Remove actions.
- ✅ No project-creation flow uses browser `prompt()`.
- ✅ Dirty buffers require confirmation before switching workspace.
- ✅ Workspace A teardown covers Pi, Preview, terminals, LSP, editor models, sessions, attachments, tests, diagnostics, Git, Pi resources, and caches.
- ✅ Workspace epoch/identity guards reject late async A results after B becomes active.
- ✅ Canonical B is committed once; a secondary B reload warning cannot create a fake rollback to A.
- ✅ A running Pi workspace restores the UI correctly after browser reload.
- ✅ Nested Git workspaces scope status/diff/stage to their own subtree.

---

## 6. Harnesses and Pi resources — 9.1/10

### Implemented harness contract

- ✅ Built-ins: Coding · Pi Default, Coding · Pi Default + Web, Small Local Coder, Read-only Review.
- ✅ Global and project custom harness manifests.
- ✅ General-agent versus coding-harness kind.
- ✅ Pi default tools or explicit bounded tool allowlist.
- ✅ Additional extension tool names.
- ✅ Appended system/workflow guidance.
- ✅ Project/global Pi resources remain inherited, not copied into a proprietary package system.
- ✅ Harness selection is explicit in the header and New Session launcher.
- ✅ Active session harness and next-session harness are visually distinct.
- ✅ New, edit, duplicate, delete, select, and Save Effective workflows exist.
- ✅ Save is disabled until name/scope are actionable.
- ✅ Custom manifests are ordinary inspectable JSON files.
- ✅ Corrupt manifests are reported and cannot be silently overwritten.
- ✅ Harness launch translates to literal Pi `--tools` and `--append-system-prompt` arguments.
- ✅ Web harness guidance includes the real current date and newest-first chronology.
- ✅ The Web harness does not falsely claim tools exist; the Pi web extension must be installed/enabled.
- ✅ Pi resource changes while running show restart-required state and preserve workspace/model/harness/session on restart.

### Pi-native resources

- ✅ Instructions/context hierarchy, skills, prompts, extensions, packages, and settings are inspectable.
- ✅ Project/global/ancestor scopes remain visible.
- ✅ Prompt, skill, context, and settings writers stay inside documented roots.
- ✅ Resource search spans Pi resources, packages, providers, and MCP.
- ✅ Executable extension risk is visible.
- ✅ Settings corruption is preserved on mutation failure.

### Deliberately deferred harness platform

- ⚪ Kernel/RLM and hybrid execution.
- ⚪ Persistent external working-memory snapshots.
- ⚪ Automatic task-based MCP/package/tool discovery.
- ⚪ Model-generated tools/skills.
- ⚪ Self-improving learned overlays.
- ⚪ Benchmark-gated harness evolution.
- ⚪ Subagents and multi-agent worktrees.

These belong to v1.9/v2 and must not be described as current v1.8 behavior.

---

## 7. Providers — 9.3/10

- ✅ OpenAI/OpenAI-compatible provider profiles.
- ✅ Valid HTTP(S) endpoint required before Test; provider ID additionally required before Save.
- ✅ Environment-backed bearer credentials; literal keys are not persisted by Studio.
- ✅ `/v1/models` discovery.
- ✅ Responses API probe with Chat Completions fallback.
- ✅ Per-model tools, JSON Schema, vision, reasoning, context, and output detection/overrides.
- ✅ Explicit overrides win over detected values; Auto/null falls back correctly.
- ✅ Provider/model values cannot collide with Ollama model IDs.
- ✅ Provider sync writes Studio-owned Pi model definitions.
- ✅ Removing a provider removes its Studio-owned Pi entries.
- ✅ Removing a provider now requires confirmation and exposes Removing state.
- ✅ Concurrent writes serialize without lost profiles.
- ✅ Revision guards reject stale slow refresh/probe results.
- ✅ Provider reads do not mutate `updatedAt`.
- ✅ Corrupt provider stores are preserved.

---

## 8. MCP — 9.3/10

- ✅ Stdio and HTTP transports.
- ✅ Quoted stdio arguments are parsed without invoking a generic shell.
- ✅ Form Save is disabled until ID and transport-specific endpoint are valid.
- ✅ Connect, Disconnect, Reconnect, and Refresh have lifecycle-aware disabled/busy states.
- ✅ Tool/resource/prompt discovery.
- ✅ Manual tool call and resource/prompt read.
- ✅ Manual Studio access remains distinct from exposure to Pi.
- ✅ Per-server and per-tool exposure controls.
- ✅ Managed Pi bridge registers and hot-updates active MCP tools.
- ✅ Disconnected/crashed servers cannot leave stale tools/resources/prompts exposed.
- ✅ Literal env/header values never return to browser snapshots.
- ✅ Protocol version reports the package release version.
- ✅ Failed initialization closes the child process.
- ✅ Concurrent connects/mutations serialize.
- ✅ Removing a server requires confirmation.
- ✅ Corrupt MCP configuration is preserved.

---

## 9. Pi packages and marketplace — 9.3/10

- ✅ npm `pi-package` discovery.
- ✅ Extensions/skills/prompts/themes filters.
- ✅ Exact package details and Pi manifest resources.
- ✅ Version list and explicit npm version pinning.
- ✅ SemVer sorting handles prereleases correctly.
- ✅ Project and global installation.
- ✅ npm, Git, HTTPS/SSH, and local source support.
- ✅ Native Pi install/update/remove commands.
- ✅ Project actions use explicit local scope/approval semantics.
- ✅ npm integrity, publication, dependencies, install scripts, and executable extensions are surfaced.
- ✅ Git provenance resolves requested pinned ref.
- ✅ Local provenance hashes source files and downgrades verification for symlink/unhashed/truncated content.
- ✅ Marketplace malformed upstream responses become controlled errors.
- ✅ Installed resource controls implement Pi-native All/None/Custom semantics.
- ✅ Custom glob input is active only in Custom mode.
- ✅ Direct Inspect/Install remain disabled until a source and valid project/global scope exist.
- ✅ Install/Inspect/Apply/Update/Remove expose busy states to prevent duplicate clicks.
- ✅ Package removal requires confirmation.
- ✅ Concurrent resource edits serialize.
- ✅ Corrupt `.pi/settings.json` is preserved.

---

## 10. Coding workbench — 9.3/10

### Editor and LSP

- ✅ Vendored Monaco works offline.
- ✅ Multiple buffers, dirty indicators, split panes, close protection, and view-state persistence.
- ✅ External clean changes reload; dirty conflicts remain visible and require explicit overwrite/reload choice.
- ✅ Workspace search skips ignored/binary/oversized content and returns locations.
- ✅ TypeScript, Python/Pyright, HTML, and Angular language servers.
- ✅ Hover, completion, diagnostics, symbols, references/navigation, rename, signature help, and formatting paths.
- ✅ LSP URI containment prevents outside-workspace access.
- ✅ LSP crash clears protocol document state and restarts with `didOpen`.
- ✅ Old-workspace diagnostics cannot repaint a new workspace.

### Git

- ✅ Status, structured filenames, rename paths, diff, stage/unstage, restore, commit.
- ✅ Recursive untracked files are visible.
- ✅ Git onboarding creates safe `.gitignore`/baseline without overwriting existing ignores.
- ✅ Sensitive baseline files require confirmation.
- ✅ Git operations use canonical workspace containment and nested-workspace scoping.
- ✅ Checkpoints capture working state without mutating the live index.

### Terminal and tests

- ✅ Integrated xterm/node-pty packaging.
- ✅ Terminal create/input/history/resize/search/split/kill.
- ✅ Terminal buttons are gated by active session/workspace.
- ✅ Fallback process termination cleans descendants.
- ✅ Test Explorer discovers Node tests and run configurations.
- ✅ Run All/Rerun/Ask Pi are state-gated.
- ✅ Individual files/cases/configurations have accessible action names.
- ✅ Outside-workspace and symlinked test targets are rejected.

---

## 11. Preview — 9.5/10

- ✅ Detected package `dev`, `preview`, and `start` scripts.
- ✅ Framework/manual command support.
- ✅ Studio-owned plain HTML static server; no npm/Python dependency.
- ✅ A single nested HTML application is detected and opened at its subfolder.
- ✅ Multiple possible nested HTML apps remain an explicit choice.
- ✅ Manual loopback URL attach.
- ✅ Start, Restart, Stop, Refresh, Open External.
- ✅ Main Preview and Editor+Preview split stay synchronized.
- ✅ Preview URL validation permits loopback only.
- ✅ Wildcard local bind addresses normalize to loopback.
- ✅ URL detection handles split stdout chunks and ANSI color codes.
- ✅ Logs preserve raw output.
- ✅ Concurrent starts serialize; process trees stop cleanly.
- ✅ Workspace A Preview cannot remain displayed beside workspace B editor.
- ✅ Late Preview results are guarded by workspace epoch.

---

## 12. TTS — 8.6/10

- ✅ Loopback-only Qwen3-TTS endpoint validation.
- ✅ Status/health, Wake, Sleep.
- ✅ OpenAI-compatible speech generation proxy.
- ✅ Generation relies on service auto-wake; manual Wake is optional preloading.
- ✅ Generated binary audio is played without putting bytes into model context.
- ✅ Assistant Speak action and browser-voice fallback.
- ✅ Studio-owned `tts_speak` Pi extension/tool.
- ✅ TTS tool remains governed by the selected harness allowlist.
- ✅ Generated agent audio uses a bounded short-lived same-origin artifact.
- 🟡 Final rendered Qwen3-TTS status→wake→generate→playback→sleep should be repeated on the target machine.
- 🟡 Verify GPU coexistence policy when `15koutput` already occupies most of the RTX 3090 VRAM.
- ⚪ TTS is optional; its service being offline must not break coding sessions.

---

## 13. UI/UX and discoverability — 9.2/10

- ✅ Primary project actions are visible instead of hidden in Settings.
- ✅ New Session visibly states Workspace, Runtime/Provider, Model, Harness, Thinking, and loaded status.
- ✅ Tested runtime and active runtime use different UI states/actions.
- ✅ Installed/Loaded/Selected/Session states are explained in UI/docs.
- ✅ Model downloads state their active target runtime.
- ✅ Harness presets explain what they do and do not install.
- ✅ Resource restart notice explains when new extensions/tools become active.
- ✅ Long-running actions use disabled/busy states.
- ✅ Destructive model/provider/MCP/package/harness actions require confirmation.
- ✅ Invalid creation/provider/MCP/package forms start disabled and become actionable only when valid.
- ✅ Session Fork/Clone use an in-app modal with Enter/Escape and cancellation.
- ✅ Documentation search supports multi-word intent such as `runtime switch`.
- ✅ In-app documentation links directly to Projects, Runtime, Preview, Harnesses, and resources.
- ✅ Error states appear near the affected feature and in logs/toasts rather than disappearing silently.
- ✅ No known fake hard-coded “online” state is used for Ollama, Pi, MCP, providers, packages, or extensions.

### Minor future UX opportunities, not blockers

- ⚪ Add richer Logs filtering/export if troubleshooting volume grows.
- ⚪ Add formal onboarding tours and empty-state walkthroughs after v1.8 freezes.
- ⚪ Consider model/profile favorites and selector filtering for very large model libraries.

---

## 14. Accessibility, keyboard, and Vim — 8.9/10

- ✅ All primary workflows remain mouse-accessible.
- ✅ Command palette exposes semantic commands.
- ✅ Buttons, palette, Keyboard Enhanced, and Vim bindings converge on command IDs.
- ✅ Standard, Keyboard Enhanced, and Vim/Neovim modes persist.
- ✅ Leader menu and shortcut cheat sheet.
- ✅ Normal/Insert state, chat/tree navigation, first/last, folds, registers, marks, semantic macros, and dot-repeat groundwork.
- ✅ Explorer folders/files, sessions, recent projects, and Git files are keyboard-focusable buttons.
- ✅ Icon-only controls have accessible names.
- ✅ Test/attachment/model actions have object-specific accessible labels.
- ✅ Modal surfaces expose dialog and modal semantics with labels.
- ✅ Disabled state is present before asynchronous state loads, preventing misleading activation.
- 🟡 Run a formal keyboard-only and screen-reader pass before claiming WCAG conformance.
- ⚪ Full Neovim text objects, macros/register semantics across every surface, and native-Neovim parity are long-term power-user work, not v1.8 release claims.

---

## 15. Security, integrity, and process reliability — 9.6/10

- ✅ Studio code-execution HTTP server is loopback-only.
- ✅ Preview/TTS/MCP bridge local surfaces remain loopback-scoped.
- ✅ Workspace operations use canonical path containment.
- ✅ Session, Git, Test Explorer, LSP, and file routes reject traversal/outside paths.
- ✅ Symlink/junction/drive-case aliases are considered in security checks.
- ✅ Windows `.cmd/.bat/.ps1` launching preserves literal argv instead of generic `shell:true`.
- ✅ Shell metacharacters and trailing backslashes are regression-tested.
- ✅ Process timeouts kill descendant trees and bound captured output.
- ✅ Pi, Ollama, MCP, LSP, Preview, and terminals clean descendants on stop/crash.
- ✅ Concurrent lifecycle actions serialize.
- ✅ File saves serialize and detect stale mtimes.
- ✅ JSON mutations serialize per file.
- ✅ Atomic writes clean temporary files on failure.
- ✅ Corrupt runtime/provider/MCP/profile/models/settings/checkpoint/harness stores are preserved rather than reset.
- ✅ Sensitive provider/MCP secrets do not leak in browser snapshots.
- ✅ Package executable/install-script risk is explicit.
- ✅ No hidden fallback broadens execution beyond the selected model/provider.

---

## 16. Final Windows release gate

Run:

```powershell
npm run verify:v1.8:windows
```

The final pass must confirm:

- [ ] `npm run check` PASS.
- [ ] `npm test` PASS with zero failures; explicit platform skips reviewed.
- [ ] `npm run test:lsp-live` 4/4 PASS.
- [ ] `npm run test:pi-live` PASS with installed Pi.
- [ ] `npm run test:ui` PASS in rendered Chrome/Edge.
- [ ] Real `15koutput` Qwen3.6 27B session loads/generates with no fallback.
- [ ] Cold model load may take minutes but remains Working, not Connection Error.
- [ ] Runtime A→B→A shows only the active server's installed/loaded models.
- [ ] Pull/download goes to the active LAN/local runtime.
- [ ] Workspace A→B removes old Explorer/Git/tests/LSP/Pi/Preview/terminal/resource state.
- [ ] New HTML project opens and renders through Studio static Preview.
- [ ] Session fork/clone modal creates named sessions and cancel leaves no mutation.
- [ ] Create from historical prompt restores exact checkpoint code in an isolated worktree.
- [ ] Extension/package install enables resources only after the documented Pi restart/new session.
- [ ] Web harness with enabled web extension can perform a current-news prompt; absent extension is reported honestly.
- [ ] Browser console, Studio Logs, Pi stderr, Ollama logs, and server stderr contain no unexplained errors.
- [ ] Stop/restart leaves no leaked Pi/Ollama/MCP/LSP/Preview/terminal descendants.
- [ ] Optional Qwen3-TTS workflow passes if enough VRAM is available; TTS offline does not fail coding.

## Release decision

- **Implementation scope:** complete for v1.8 single-agent local development.
- **Known release blockers:** none.
- **Automated stable gate:** complete on this exact source tree (`ALL v1.8 WINDOWS RELEASE GATES PASSED`).
- **Next version:** v1.9 may begin only after v1.8 is frozen; subagents, Kernel/RLM, automatic harness discovery/evolution, and persistent working memory stay out of the v1.8 stable branch.
