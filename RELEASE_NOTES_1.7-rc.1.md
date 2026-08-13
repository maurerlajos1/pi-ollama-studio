# Pi Ollama Studio v1.7.0-rc.1

This release candidate is built from the user's fully hardware-tested v1.7-dev.3 source and incorporates the full pre-v1.8 code-review fixes.

## Review hardening

- protects dirty Monaco buffers from silently overwriting newer Pi/agent edits
- reloads clean buffers when files change externally
- fixes current-workspace fallback for Create App from Prompt
- serializes checkpoint persistence
- rejects nested Git worktree targets
- removes machine-specific Ollama model-directory assumptions
- keeps managed Ollama on the configured endpoint
- makes resource/session/config writes atomic
- isolates stale Ollama models by runtime endpoint
- preserves Git rename and space-containing paths through structured porcelain parsing
- resolves superseded LSP debounce operations cleanly
- normalizes project/worktree directory names for Windows and Linux portability
- retains the previously fixed Monaco mouse-caret behavior and Windows hardware fixes

## Verification before packaging

- syntax/module check: PASS
- deterministic suite: 91/91 PASS
- bundled live LSP: 4/4 PASS
- real Pi 0.82.1 RPC smoke: PASS

Run the following on the target Windows/RTX 3090 machine before promoting to v1.7.0 final:

```powershell
npm run setup:pty
npm run verify:release
npm run test:lsp-live
npm run test:ollama-e2e
# or the combined hardware gate:
npm run verify:full
```
