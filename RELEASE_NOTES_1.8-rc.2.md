# Pi Ollama Studio v1.8.0-rc.2

## Purpose

Second Windows release candidate for v1.8. It contains the complete v1.8 agent-platform scope from rc.1 plus additional adversarial debugging and lifecycle hardening performed before Windows validation.

## Additional fixes since rc.1

- MCP protocol metadata now derives Studio's version directly from `package.json` instead of reporting the stale `1.8.0-dev.1` development version.
- MCP stdio initialization no longer treats an `initialize` timeout as an unsupported-initialize compatibility signal.
- Failed MCP stdio connection attempts close the process they spawned instead of potentially leaving an orphan server behind.
- App Preview stop/restart now verifies and terminates the complete Unix process group rather than only the shell wrapper.
- App Preview escalates to process-group `SIGKILL` when a development server ignores `SIGTERM`, preventing hidden servers and port collisions after Restart.
- Added adversarial regression tests for MCP version metadata, failed MCP process cleanup, and stubborn Preview process cleanup.

## Verification in the managed environment

- `npm run check`: PASS
- `npm test`: 132 / 132 PASS, 0 failures
- `npm run test:lsp-live`: 4 / 4 PASS
- Stateful provider/MCP/package/Preview stress loop: 5 consecutive rounds PASS
- Rendered Chromium remains unavailable in this managed environment because localhost navigation is blocked; use the bundled Windows verification lane.
- Real Pi and real Ollama/RTX testing remain Windows-machine release gates.

## Windows verification

Run:

```powershell
npm run verify:v1.8:windows
```

This preserves the v1.7 Windows production compatibility contract and adds the v1.8 provider, MCP, marketplace, resource, and App Preview rendered workflows.
