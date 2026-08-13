# Pi Ollama Studio v1.8.0-rc.4 — Codex Handoff

This file is the starting point for continuing development locally on Windows.

## Current verified state

- Version: `1.8.0-rc.4`
- Static syntax check: PASS (`npm run check`)
- Deterministic suite: **264 test records, 250 PASS, 0 failures, 14 explicit platform skips** (`npm test`)
- Live bundled LSP suite: **4/4 PASS** (`npm run test:lsp-live`)
- Real Pi RPC suite: **PASS** with Pi `0.83.0` (`npm run test:pi-live`)
- Windows rendered UI workflow: **PASS** (`npm run test:ui`), including genuine model runtime A→B switching, workspace/project flows, provider/MCP/package UI, manual-command Preview, and Pi/session regression paths.
- Real Ollama + Pi/RTX verification is green on Windows with `15koutput` (Qwen 3.6 27B) and no fallback: real generation, tests, Git checkpoints, second agent turn, Session Tree project creation, and historical worktree restoration all passed. The test does not silently substitute a smaller model; close unrelated GPU runners before repeating the gate.

The complete `npm run verify:v1.8:windows` gate passed on this exact final hardening tree on 2026-08-09: static checks, **264 deterministic test records**, live LSP, real Pi 0.83.0 RPC, rendered Chrome UI, and real `15koutput`/Qwen3.6 27B Ollama generation with two agent turns and historical worktree verification. The hardware harness had fallback disabled and verified the required model from Ollama's real installed-model inventory. See `docs/handoff/UI_BEHAVIOR_PROOF_MATRIX.md` for artifacts and per-workflow evidence.

The source tree in this handoff is newer than the older rc.4 archive that existed earlier in the conversation. Treat this folder as authoritative.

## Read these files first

1. `AGENTS.md` — repository rules and invariants.
2. `CODEX_HANDOFF.md` — current state and next safe implementation slice.
3. `docs/handoff/RC4_UI_WORKFLOWS.md` — intended product/UI behavior.
4. `docs/handoff/HARNESS_ARCHITECTURE.md` — current harness model and future-safe schema direction.
5. `docs/handoff/WINDOWS_RELEASE_GATE.md` — local release verification.
6. `docs/handoff/UI_BEHAVIOR_PROOF_MATRIX.md` — rendered/backend/filesystem/hardware proof for major UI workflows.
7. `docs/handoff/RC4_COMPREHENSIVE_RELEASE_CHECKLIST.md` — scored implementation/UX audit and final sign-off list.
8. `docs/ARCHITECTURE.md` and `docs/AGENT_GUIDE.md` — in-product architecture/user model.
9. `CODE_REVIEW_V1.8_DEV.md` and `RELEASE_NOTES_1.8-rc.4.md` — implementation/release history.

Research is under `docs/research/`. It is design input, not implementation authority.

## Product architecture that must not be broken

- **Pi** is the agent/session/resource kernel.
- **Git** is the source-history/checkpoint/worktree kernel.
- **Ollama** is first-class local inference, but the product remains provider-neutral.
- GUI buttons, command palette, keyboard/Neovim bindings, macros and automation should converge on semantic commands rather than duplicate behavior.
- Conversation history and source history are distinct. Exact historical code restoration uses Git checkpoints/worktrees, never tool-call replay.
- Project/global Pi resources remain ordinary Pi resources. Studio should orchestrate them, not invent a second package ecosystem.

## Immutable Windows production invariants from v1.7

Do not regress these:

1. Session/workspace comparisons use canonical real paths; Windows drive casing and aliases must not split identity.
2. Workspace selection supports Windows folder picking and canonicalization.
3. Pi session-path security resolves real paths with safe fallback.
4. Checkpoint workspace keys use canonical/lowercase Windows identity.
5. Checkpoint association accepts `entry.id || node.id || node.entryId` where applicable.
6. Hardware E2E uses production `/api/sessions` and `/api/session/inspect` endpoints.
7. Argument-based Windows subprocesses must preserve literal argv; do not revert to generic `shell:true` for `.cmd/.bat` wrappers.

## Current rc.4 capabilities already implemented

Do not re-plan or rebuild these from scratch:

- Pi RPC/session flow, compaction, session tree, checkpoint mapping and worktree creation.
- Ollama runtime profiles, LAN/local endpoints, model inventories and loaded `/api/ps` state.
- Active-vs-tested Ollama server distinction and `Use this server` flow.
- Installed/loaded model handling, runtime-bound profiles and default-model reconciliation.
- OpenAI/OpenAI-compatible providers and model capability probing/overrides.
- MCP server manager, discovery, manual calls, Pi exposure, bridge and lifecycle handling.
- Pi package/marketplace install/update/remove, provenance/trust and resource filters.
- Pi Platform resources: instructions, skills, prompts, extensions, packages, providers, themes/resources.
- Monaco/LSP, terminal, Test Explorer, Git, Preview.
- Centralized workspace A→B teardown/activation with workspace-generation guards against late A responses/events.
- Transactional Create Project from historical prompt/worktree with rollback.
- Project Manager UI: New Project, Open Folder, Recent Projects, Create from Session.
- New Project templates currently include empty, plain HTML and Node.
- Harness persistence and launch contract:
  - built-ins: `Coding · Pi Default`, `Small Local Coder`, `Read-only Review`
  - custom project/global JSON manifests
  - tool allowlist + appended system guidance
  - save/use/edit/duplicate/delete/effective-harness UI
- Web-enabled harness lifecycle:
  - built-in `Coding · Pi Default + Web` preset
  - Pi-native web extension installation/inspection remains separate from the harness
  - resource changes while Pi runs expose a restart-required notice and preserve workspace/model/harness/session on restart
- Strict corruption-preserving mutation semantics for sensitive JSON stores.
- Windows-safe process launch/process-tree cleanup and lifecycle serialization.
- Windows command resolution now prefers native `.exe/.cmd/.bat/.ps1` shims over extensionless Unix launchers, so the installed `pi.cmd` is used correctly by Pi RPC.
- The Windows real-Ollama E2E now starts Studio-managed Ollama automatically when a local loopback endpoint is offline, waits for it to become healthy, and refuses to auto-start LAN/remote runtimes.
- Runtime/model transition UI renders the active server's installed and loaded inventories, keeps Test Connection separate from Use this server, and clears stale selections when switching endpoints.
- Preview lifecycle is streamed through SSE, preserves focused command/URL edits during refresh, supports plain `index.html`, and cache-busts the editor split frame after toggling.
- Editor external-change conflicts preserve the visible conflict marker when an overwrite is declined.
- Local Qwen3-TTS lifecycle and generation proxy: status/health, manual wake, sleep, OpenAI-compatible speech generation, assistant-message Speak actions, browser voice fallback, and Advanced UI controls.
- Studio explicitly loads `extensions/pi-ollama-studio-tts.ts` when Pi starts. Its loopback-only `tts_speak` tool creates a short-lived playable Studio audio artifact without putting audio bytes into model context; bounded harness allowlists still control whether it is active.
- Long local-model generations now have truthful action state: normal Send is disabled while Steer, Follow Up, and Abort are active, then reverses after `agent_settled`.
- Pi-only Session/Advanced controls remain disabled until Pi is running.
- Provider, MCP, project, harness, package, model, terminal, test, and Preview actions expose validated readiness/busy states rather than accepting duplicate or impossible clicks.
- Provider/MCP/package/harness/model destructive actions require explicit confirmation.
- Session Fork and Clone use a validated, accessible in-app naming modal; the remaining native browser naming prompts are gone.
- Preview captures a manually edited command/URL before optimistic rendering, so clicking Start cannot replace it with an older detected suggestion.
- Documentation search supports multi-word intent queries such as `runtime switch`.

## Current harness truth

The current persisted harness schema is intentionally small and real. See `src/harnesses.mjs`.

Implemented today:

- `schemaVersion`
- `id`
- `name`
- `kind: agent | coding`
- `description`
- `tools: string[] | null`
- `appendSystemPrompt`
- `resourcePolicy: inherit-pi`
- global/project scope

Do **not** claim Kernel/RLM, persistent working memory, automatic resource discovery, self-improvement or subagents are already implemented.

## Current rc.4 validation slice

The planned UI coherence slice is implemented and covered by the current deterministic and rendered UI gates. Keep the following invariants during follow-up bug fixes; do not rebuild these subsystems:

Verified areas:

1. **Semantic command parity**
   - Project Manager / New Project / Open Folder / Create from Session
   - New Session
   - Harness workbench / Save Effective / select harness
   - Preview actions
   - expose through buttons + command palette + Keyboard/Vim layer using the same command IDs.

2. **Plain HTML Preview polish**
   - `scripts/static-preview.mjs` already exists.
   - Ensure a workspace with `index.html` gets a first-class static-preview suggestion/start path without Python or package download.
   - E2E: create HTML project → Preview → edit/save → refresh/auto-refresh → changed text visible.

3. **Model/runtime UX polish**
   Always distinguish:
   - Installed model = exists on active Ollama server.
   - Loaded model = resident according to active server `/api/ps`.
   - Selected model = next-session intent.
   - Session model = what running Pi actually uses.
   - Tested server = form connection result only.
   - Active server = persisted runtime Studio is actually using.
   A loaded model is a performance hint and must never silently override the selected/session model.

4. **Session launcher polish**
   Make Workspace + Runtime + Selected Model + Harness the visible launch contract. Show residency/VRAM as status, not selection logic.

5. **In-app documentation**
   Update the Documentation view to match the actual current behavior. Do not leave important workflows only in Markdown files.

6. **Rendered Windows E2E**
   The current Windows UI suite asserts both new state appears and old state disappears for the covered context transitions.

7. **TTS UI and agent integration**
   - TTS status, Wake, Sleep and Generate Audio are available under Advanced settings.
   - Assistant messages expose a Speak action that generates Qwen3-TTS audio.
   - The service auto-wakes on generation; manual Wake is only a VRAM-preload option.
   - The remaining TTS validation slice is the rendered workflow; the opt-in Pi-native extension/tool is now present and has a focused contract test.

The next work is release validation and bug fixes found on the target machine, not a rewrite of these subsystems.

## Explicitly defer from rc.4

These are useful research directions but belong after v1.8 is stable:

- recursive subagents / multi-agent orchestration
- Kernel/RLM execution strategy
- persistent Python working-memory snapshots
- automatic MCP/package/tool discovery for a task
- model-generated custom tools
- self-improving harness overlays
- benchmark-gated harness evolution
- full Harness Builder for all Pi resources/policies

It is okay to add schema-compatible extension points only when they are inert, validated, documented and do not complicate rc.4 behavior.

## Testing discipline

For every UI workflow:

1. unit/deterministic logic test
2. backend route contract
3. integration with temp workspace/config
4. rendered Playwright using real clicks
5. Windows real Pi/Ollama when environment-dependent

For context switches use this rule:

> Assert the new state appears **and** the old state disappears.

Never package a knowingly red tree.

## Local first commands

```powershell
npm ci
npm run check
npm test
npm run test:lsp-live
npm run test:pi-live
npm run test:ui
npm run test:ollama-e2e:windows
npm run verify:v1.8:windows
```

If `npm ci` replaces/removes platform-specific terminal assets, follow the repository's PTY setup instructions and `npm run setup:pty` as required.

## Definition of done for v1.8

- normal mouse workflow is understandable without knowing Pi internals
- existing power features remain reachable by command palette/keyboard/Vim-style commands
- Project A→B and Runtime A→B transitions are atomic/consistent
- New Project and Create-from-Session have polished destination selection and no primitive browser prompts
- Harness selection/save/reuse is understandable and real
- model residency is visible but never confused with selection
- Preview works for normal HTML and common dev servers
- in-app docs explain the above
- deterministic + live LSP + Windows rendered/hardware gates pass
