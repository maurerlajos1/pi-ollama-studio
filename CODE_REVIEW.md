# Pi Ollama Studio v1.7.0-rc.1 — Full Code Review

Review date: 2026-08-07
Authoritative baseline: user hardware-tested `pi-ollama-studio-v1.7-dev3-tested.zip`

## Review scope

The review covered the complete local IDE stack rather than only the v1.7 Pi Platform additions:

- Node HTTP/SSE server and route contracts
- Pi RPC lifecycle, session state, checkpoints and historical worktrees
- local, LAN/IP and HTTPS/reverse-proxy Ollama runtimes
- model/profile synchronization and runtime switching
- Monaco workbench, buffers, mouse/focus state, split panes and external edits
- LSP process lifecycle, debounce/sync, diagnostics and provider mappings
- xterm/node-pty terminal lifecycle and process ownership
- Test Explorer and run configurations
- Git status/diff/stage/restore/checkpoint/worktree behavior
- Pi Platform instructions, skills, prompts, extensions, packages and scoped settings
- cross-platform Windows/Linux path/process behavior
- persistence, atomic writes, race conditions and stale state
- deterministic, live-runtime and browser/hardware E2E coverage

## Important product constraint

Pi Ollama Studio is intentionally a full-power local development IDE. The review did **not** sandbox normal filesystem access, terminal access, Git access, Pi tools, or project/resource editing. Security changes were limited to accidental external attack surfaces and correctness boundaries; useful local-development capabilities were preserved.

## Confirmed issues fixed during this review

### High correctness

1. **Dirty Monaco buffer could silently overwrite a newer Pi/agent disk edit.**
   - File reads now carry disk modification time.
   - Saves use optimistic `expectedMtimeMs` checking.
   - A stale save is rejected unless the user explicitly chooses force overwrite.
   - Clean buffers auto-refresh after external/agent edits.
   - Dirty buffers retain the user's local text and surface an external-edit conflict.
   - Playwright now exercises the real dirty-buffer vs external-edit flow.

2. **Create App from Prompt fallback claimed to copy current code but did not actually reproduce the current workspace.**
   - Fallback project creation now recursively copies current workspace code.
   - `.git`, `node_modules`, and old `.pi/studio-sessions` are intentionally excluded.
   - The selected session ancestry is written as the new project's initial Studio session.

3. **Checkpoint metadata writes could race.**
   - Checkpoint updates are serialized/atomic so concurrent prompt completion cannot lose node associations.

4. **Historical worktree target could be nested inside the source repository.**
   - Worktree creation now rejects targets inside the existing repository tree.

### Medium correctness / portability

5. **Managed Ollama contained machine-specific runtime assumptions.**
   - Removed hard-coded `H:\\ollama-models` fallbacks.
   - `OLLAMA_MODELS` is preserved only when the user/environment provides it.
   - Managed Ollama follows the configured local endpoint instead of forcing `0.0.0.0`.

6. **Terminal/process kill behavior was too PID-oriented.**
   - Studio terminal lifecycle now operates on Studio-owned terminal session IDs/process objects rather than exposing arbitrary PID termination as a normal API operation.
   - Full local terminal capability remains available.

7. **Native terminal launch validation rejected legitimate Windows path characters.**
   - Valid local project paths such as folders containing `&` or `$` remain usable.

8. **Pi Platform/config/session writes could leave partial files if interrupted.**
   - Config, Pi resources and Studio session writes use temp-file + rename atomic persistence and clean temporary artifacts on failure.

9. **Ollama stale model cache leaked across runtime changes.**
   - Cached model lists are keyed by runtime URL.
   - A transient failure may reuse models only for the same endpoint, never from the previous server.

10. **Git Changes parsing was ambiguous for renames and quoted/space-containing paths.**
    - Backend now produces structured file records from NUL-delimited Git porcelain output.
    - Rename source and destination paths are preserved losslessly.
    - The UI uses destination paths for actions and displays `old → new`.

11. **Rapid LSP document changes could leave superseded debounce Promises unresolved.**
    - Superseded/closed/disposed sync operations resolve cleanly instead of leaking pending Promises.

12. **Create-App/worktree names were not fully Windows-portable.**
    - Invalid characters, trailing dots/spaces and Windows reserved basenames (`CON`, `NUL`, `COM1`, etc.) are normalized consistently for both copy and worktree flows.

13. **Project instructions still contained machine-specific drive guidance.**
    - Release instructions no longer tell Pi to assume a particular `H:` model/runtime path.

## Existing behavior reviewed and retained

- Studio server is loopback-only.
- State-changing browser requests enforce the expected local origin.
- Local IDE filesystem/terminal capability remains intentionally powerful.
- Remote Ollama supports localhost, LAN/IP, VPN/Tailscale and HTTPS proxy/tunnel endpoints.
- API credentials are referenced through environment variables rather than persisted plaintext secrets.
- Git checkpoint refs do not mutate the live Git index.
- Session storage/checkpoint metadata is excluded from code snapshots where appropriate.
- Non-Git folders offer Git initialization instead of simply failing.
- Existing `.gitignore` files are never overwritten by onboarding.
- Sensitive baseline files require explicit confirmation before automatic baseline creation.

## Regression coverage added/expanded in the reviewed RC

New review-specific checks include:

- stale editor save rejected after external modification
- clean-buffer auto reload / dirty-buffer external conflict
- concurrent checkpoint metadata writes
- nested worktree rejection
- current-workspace Create App fallback copy
- portable managed Ollama environment
- endpoint-isolated Ollama model cache
- atomic config/resource write cleanup
- Git rename + filename-with-spaces structured status
- LSP superseded debounce Promise resolution
- portable Windows/Linux project directory names
- Monaco mouse caret positioning in primary and secondary split panes

## Final automated verification in this environment

- `npm run check`: PASS
- `npm test`: **91/91 PASS**, 0 failed, 0 skipped
- `npm run test:lsp-live`: **4/4 PASS** (TypeScript, Pyright, HTML, Angular)
- `PI_COMMAND=/mnt/data/pi-real-wrapper npm run test:pi-live`: **PASS with real Pi 0.82.1**

The rendered Playwright and RTX 3090 Ollama E2E gates must still be run on the user's Windows machine because this managed environment cannot navigate localhost in Chromium and does not host the user's Ollama/GPU runtime.

## Remaining architectural debt — not release blockers

### 1. `public/app.js` is too large

It currently owns too many independent domains (chat, models, settings, Git, terminal, tests, sessions, platform resources, workbench glue). This raises regression risk as MCP/subagents are added.

**Recommendation:** modularize by feature before/while beginning the next agent-platform phase. Keep the semantic command registry as the shared integration point.

### 2. `server.mjs` route table is becoming monolithic

The backend architecture is sound, but route ownership should be split into feature routers/services before adding MCP server lifecycle and subagent orchestration.

### 3. Studio profiles are global rather than explicitly runtime-bound

The runtime model cache is now endpoint-specific, but saved Studio Profile metadata does not yet have a formal runtime ownership/migration model. A profile whose base model exists only on another Ollama server can still be selected and then fail at execution.

**Recommendation:** add optional `runtimeId/baseUrl` ownership plus a portable/global profile mode in the next runtime/settings iteration. Do not silently hide legacy profiles.

### 4. Native PTY validation is platform-dependent

The fallback backend is deterministic here and Windows ConPTY was hardware-tested by the user. Linux native `node-pty` should get an explicit Linux CI/E2E lane before desktop packaging.

### 5. Browser UI E2E remains the right place for visual interaction invariants

Do not attempt to replace Playwright with brittle DOM/unit assertions. Mouse caret, split focus, conflict dialogs, xterm behavior and platform-manager workflows should continue to grow in the real browser suite.

## Review conclusion

No foundational rewrite is required before continuing. Pi RPC, Ollama runtime abstraction, Git-backed checkpoint/worktree design, Monaco/LSP integration and the semantic command architecture are suitable foundations.

The main risk for the next phase is **codebase modularity**, not a broken core. The recommended next step is to validate this RC on Windows/RTX 3090, finalize v1.7, then modularize feature ownership as MCP/subagents are introduced rather than adding those systems directly into the existing monolithic `app.js`/`server.mjs` files.
