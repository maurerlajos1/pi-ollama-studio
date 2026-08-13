# Pi Ollama Studio v1.8.0-rc.3

## Purpose

Adversarial hardening candidate for Windows validation. No new roadmap scope was added after rc.2; this build focuses on lifecycle, concurrency, persistence, protocol and Preview correctness discovered through stress testing.

## Additional fixes after rc.2

- Shared process-tree termination helper now protects Preview, MCP stdio and Pi package command timeout paths.
- MCP failed-connect/disconnect cleanup terminates descendants, not only the direct wrapper process.
- MCP agent resource/prompt endpoints reject disconnected servers instead of exposing stale discovered metadata.
- MCP Connect/Disconnect operations serialize per server, preventing double-click races from orphaning the first spawned server.
- Preview Start/Stop/Restart operations serialize per workspace, preventing concurrent Start races from orphaning a dev server.
- Preview URL discovery uses a rolling per-stream buffer, so localhost URLs split across stdout/stderr chunks are still detected.
- Preview CSP now permits both HTTP and HTTPS localhost/127.0.0.1 frames, matching backend URL validation.
- Pi package command timeout teardown kills descendants and waits for cleanup; timeout errors no longer race with child exit errors.
- Pi package command output capture is bounded to prevent unbounded memory growth from noisy installers.
- Marketplace version sorting now follows SemVer precedence, including stable releases versus prereleases and numeric prerelease identifiers.
- Provider `updatedAt` timestamps are preserved on read rather than being regenerated during inspection.
- Provider persistence now includes a monotonic revision counter. Slow refresh/probe results are rejected with `PROVIDER_STALE` if the provider changes while the request is in flight.
- Provider, MCP, package resource, Pi settings, config and Pi model writes serialize per target file, preventing valid-but-lost concurrent updates.
- Ollama profile mutations serialize and Ollama/custom-provider writes to Pi `models.json` share the same mutation lock.
- Ollama model sync detects runtime changes before committing stale data.
- Malformed URL encoding now returns HTTP 400 and malformed Origin headers return 403 instead of generic 500 errors.
- Windows `taskkill` fallback now falls back to direct child termination if `taskkill` itself exits unsuccessfully.

## Verification in this environment

- `npm run check`: PASS
- `npm test`: **145/145 PASS**, 0 failures
- Stateful Provider/MCP/Package/Preview stress suite: **10/10 fresh rounds PASS**
- `npm run test:lsp-live`: **4/4 PASS**
- Real Pi: remains a Windows/local installation gate when the `pi` executable is unavailable here
- Rendered Playwright UI: remains the Windows/normal-browser gate because managed Chromium cannot navigate localhost in this environment
- Real Ollama + Pi GPU workflow: remains the Windows hardware gate

## Windows validation

Run:

```powershell
npm run verify:v1.8:windows
```

Report any failures or visual/workflow problems as v1.8 RC regressions.
