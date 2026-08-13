# Pi Ollama Studio 1.8.0-dev.1 — recovered development checkpoint

This is an in-progress v1.8 development checkpoint, not a release candidate.

Highlights:
- OpenAI/OpenAI-compatible provider manager with capability probing and per-model overrides.
- MCP stdio/HTTP manager with Pi exposure controls and managed dynamic tool bridge.
- Online Pi package marketplace with exact-version inspection, pinning, native resource filters and trust metadata.
- Pi Platform backend route split and frontend controller extraction.
- Test Explorer/run-config route extraction.
- Expanded deterministic HTTP and Windows Playwright E2E coverage.

Verification in the managed environment:
- syntax/static check: PASS
- deterministic suite: 117/117 PASS
- live HTTP integration: 18/18 PASS
- live LSP: 4/4 PASS
- real Pi: unavailable here (test harness SKIP)
- rendered Chromium UI: blocked by environment localhost policy; Windows gate retained
- real Ollama/RTX 3090: Windows hardware gate retained

See `CODE_REVIEW_V1.8_DEV.md` for full details and next v1.8 tasks.
