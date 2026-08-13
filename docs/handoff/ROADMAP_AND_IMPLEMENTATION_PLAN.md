# Pi Ollama Studio — Roadmap and Implementation Plan

This is the working plan for the current rc.4 tree. The code and tests are authoritative; research and the Pi course transcript are design input.

## Current release: v1.8 rc.4

The goal is a coherent single-agent local development platform, not a partial multi-agent system.

### Implemented foundation

- Pi RPC sessions, streaming, thinking, abort, steering, follow-ups, compaction and session statistics.
- Workspace/project manager, recent projects, templates, Git checkpoints, forks and historical worktrees.
- Ollama local/LAN runtime management, installed/loaded/selected/session-model separation, model profiles and pull/unload controls.
- OpenAI-compatible providers and capability overrides.
- MCP server lifecycle, inspection, manual calls and Pi exposure bridge.
- Pi-native instructions, skills, prompts, extensions, packages and themes.
- Pi package marketplace with provenance, version pinning, scope and resource filters.
- Monaco/LSP, terminal, tests, Git, diagnostics and workspace search.
- Preview for common dev servers and plain HTML through the Studio static server.
- Reusable agent/coding harnesses with tool allowlists and system guidance.
- Keyboard/command-palette/Vim semantic command layer.

### Newly implemented TTS slice

The local Qwen3-TTS service is supported through:

- `GET /api/tts/status` and legacy `/api/tts/health`.
- `POST /api/tts/wake` → `/api/model/wake`.
- `POST /api/tts/sleep` → `/api/model/sleep`.
- `POST /api/tts/generate` → OpenAI-compatible `/v1/audio/speech`.
- Advanced UI controls for status, wake, sleep, generated audio playback and browser speech.
- `Speak` action on assistant messages.
- Studio-owned Pi extension at `extensions/pi-ollama-studio-tts.ts` registers the loopback-only `tts_speak` tool. Studio loads it explicitly without installing it into global Pi state; generated audio becomes a short-lived playable artifact rather than model-context data.

Generation relies on Qwen3-TTS automatic wake-up; manual Wake is an optional VRAM-preload action. The proxy is loopback-only by design.

### Remaining v1.8 hardening

1. Add a rendered UI workflow for TTS status → wake → generate → playback → sleep.
2. Render and verify the Pi-native `tts_speak` artifact workflow in a real Chat session, subject to the active harness/tool policy.
3. Add a documented generated-app helper for calling Studio TTS from a local Preview app without exposing Studio beyond loopback.
4. Complete the remaining Pi parity polish: session import, richer system-prompt file management, external skill-repository configuration and extension authoring workflow.
5. Fix and regression-test web-search result normalization: current-date query construction and chronological ordering.
6. Keep deterministic, LSP, rendered UI and Windows hardware gates green.

The current implementation/UX audit and final target-machine sign-off are tracked in `RC4_COMPREHENSIVE_RELEASE_CHECKLIST.md`. The latest hardening pass additionally completed truthful long-generation controls, Pi-dependent control gating, validated provider/MCP/package forms, destructive-action confirmation, an in-app Fork/Clone workflow, and preservation of manually typed Preview commands on Start.

## v1.9: orchestration and harness platform

After v1.8 is stable:

- Agent Manager with explicit model, runtime, workspace, harness, resources, permissions and lifecycle.
- Subagents using isolated sessions and Git worktrees.
- Research, coding, test and review agent presets.
- Task-level model routing and fallback policy, always visible and user-controlled.
- Delegation, review, merge and cancellation workflows.
- Harness recommendations and benchmark comparison.
- Pi extension/tool authoring assistant with reviewable generated files.

Subagents may be implemented as Pi extensions before the full manager exists, but rc.4 must not claim that capability is complete.

## Future experimental work

- Native/minimal/kernel/hybrid execution strategies.
- Persistent working memory and snapshots.
- Automatic resource discovery and package/MCP recommendations.
- Generated tools and skills in a sandbox.
- Human-reviewed harness learning and versioned improvements.
- Visual browser agent and screenshot/DOM/network regression loops.

These features require benchmarks and explicit permission design; they are not enabled by the current harness schema.

## Test rule

Every new feature requires:

1. deterministic logic tests;
2. route/contract tests;
3. temporary-workspace integration tests;
4. rendered UI workflow tests using real controls;
5. Windows/Pi/Ollama validation when platform-dependent.

For context changes, assert both that the new state appears and that the old state disappears.
