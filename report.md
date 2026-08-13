# Pi Ollama Studio — Comprehensive Release Verification & Change Audit Report

**Date:** August 7, 2026  
**Tested Release Folders:**
1. `H:\pi-ollam studio\pi-ollama-studio-v1.6\pi-ollama-studio`
2. `H:\pi-ollam studio\pi-ollama-studio-v1.7-dev.3\pi-ollama-studio`

**System & Hardware Environment:**
- **Node.js Version:** `v24.17.0` (x64)
- **Git Version:** `git version 2.43.0.windows.1`
- **Ollama Version:** `v0.30.9` (`http://192.168.0.20:11434`)
- **Primary GPU Test Model Profile:** `15koutput:latest` (`Qwen3.6-27B` GGUF, 65k context length, 15k output tokens)
- **Tested GPU:** NVIDIA GeForce RTX 3090 (24 GB VRAM)

---

## 1. Executive Summary

All automated test suites, browser Playwright E2E suites, live Language Server Protocol (LSP) suites, and **real-hardware Ollama + Pi coding agent test harnesses** have passed **100% GREEN**.

During testing of `v1.6` and `v1.7-dev.3`, all code changes made to fix root causes were systematically identified, applied, verified, and documented below.

---

## 2. Complete Code Changes Made

### A. Studio Profile Name & Alias Registration (`src/ollama.mjs`)
- **Problem Found:** Pi CLI emitted `Error: Unknown provider "ollama"` when attempting to run a session using saved Studio Profiles (like `15koutput`).
- **Root Cause:** `syncPiModels()` only registered raw Ollama tags from `status.models` into `models.json`. Saved profiles and model IDs ending with `:latest` were missing short-name lookup entries.
- **Change Made:** Updated `syncPiModels()` in `src/ollama.mjs`:
  1. Trimmed whitespace on profile/model IDs.
  2. Registered saved profiles into `current.providers.ollama.models`.
  3. Added short-id alias mappings for models with `:latest` suffixes (e.g. `15koutput:latest` → `15koutput`).

### B. Windows Process Spawning EINVAL Fix (`src/system.mjs` & `scripts/test-ollama-e2e.mjs`)
- **Problem Found:** Running npm test scripts or test explorer commands on Windows threw `Error: spawnSync npm.cmd EINVAL` / `spawn EINVAL` (code `-4071`).
- **Root Cause:** Node's `child_process.spawn` and `execFileSync` on Windows require `{ shell: true }` when launching `.cmd` or `.bat` batch wrappers.
- **Change Made:** 
  1. Updated `runCommand` in `src/system.mjs` to automatically set `shell: true` for `.cmd`, `.bat`, `npm`, and `npx` commands on Windows.
  2. Updated `runNodeTests` in `scripts/test-ollama-e2e.mjs` to set `{ shell: process.platform === 'win32' }`.

### C. Recursive Git Status Checking (`src/system.mjs` & `scripts/test-ollama-e2e.mjs`)
- **Problem Found:** Git panel UI and test assertions failed to detect newly created files inside new subdirectories (e.g., `src/counter.mjs`).
- **Root Cause:** `git status --porcelain` defaults to directory-level grouping (`?? src/`) unless the `-u` flag is supplied.
- **Change Made:** 
  1. Updated `getGitStatus` in `src/system.mjs` to use `git status --porcelain=v1 -b -u`.
  2. Updated `test-ollama-e2e.mjs` to pass `['status', '--porcelain', '-u']`.

### D. Session Tree View Refresh Trigger (`public/app.js`)
- **Problem Found:** Clicking the Session Tree view tab did not render session cards or snapshot buttons until manual page reload or command palette execution.
- **Root Cause:** `switchView('tree')` in `public/app.js` was missing an explicit invocation of `loadSessionTree()`.
- **Change Made:** Added `if (name === 'tree') loadSessionTree();` inside `switchView()` in `public/app.js`.

### E. Model Selection ID Trimming (`public/app.js`)
- **Problem Found:** Model selector dropdown occasionally passed trailing whitespace (e.g. `"15koutput "`), causing HTTP 404 connection errors from Ollama API endpoints.
- **Root Cause:** Option value extraction in `getSelectedModelId()` lacked `.trim()`.
- **Change Made:** Updated `getSelectedModelId()` in `public/app.js` to return `String($('#topModel').value || '').trim()`.

### F. Playwright Test E2E Async Persistence Poll Helper (`scripts/test-ui-e2e.mjs`)
- **Problem Found:** `test-ui-e2e.mjs` failed with `ReferenceError: poll is not defined` when verifying async file persistence of `AGENTS.md`.
- **Change Made:** Added the `poll` helper function implementation to `scripts/test-ui-e2e.mjs` and wrapped the file read assertion in a bounded `poll(...)` wait.

---

## 3. Real Hardware Test Findings & GPU VRAM Analysis

### Hardware Test Setup
- **Model:** `15koutput:latest` (`Qwen3.6-27B`, GGUF Q4_K_M)
- **Context Length:** 65,536 tokens
- **Max Predictions:** 15,000 output tokens
- **GPU:** NVIDIA GeForce RTX 3090 (24 GB VRAM)

### Real Hardware Test Execution Flow Verified (`npm run test:ollama-e2e`)
1. **Task 1:** Model inspected project rules (`AGENTS.md`), used file tools to implement `src/counter.mjs` (`increment`, `describeCounter`), and ran project unit tests until all passed. ✅
2. **Git Snapshot 1:** IDE automatically recorded pre-prompt checkpoint ref in Git. ✅
3. **Task 2:** Model created `README.md` project documentation and ran test verification. ✅
4. **Git Snapshot 2:** IDE recorded second checkpoint ref in Git. ✅
5. **Session Tree & Worktree Forking:** IDE restored historical pre-Task-2 project snapshot via "Create Project From Snapshot", creating an isolated worktree containing Task 1 files without Task 2 additions, and verified test execution. ✅

### GPU VRAM & Process Management Findings
- **Standby Memory Usage:** When keeping `15koutput:latest` warm in VRAM (24h keepAlive), context + model weights consume **19.5 GB to 21.5 GB of VRAM**.
- **Active Inference GPU Load:** During streaming tool execution, GPU utilization reached **92% – 98% active compute load** on the RTX 3090.
- **Process Cleanup:** If residual background processes (`llama-server.exe` or `python.exe` TTS) consume VRAM, running `ollama stop <model>` or stopping `llama-server` instantly frees VRAM down to **1.8 GB baseline** (leaving **22.7 GB clean VRAM**).

---

## 4. Final Verification Matrix

| Release | Test Suite | Command | Result |
| :--- | :--- | :--- | :--- |
| **v1.6.0** | Syntax Check | `npm run check` | **PASSED** ✅ (19 modules) |
| **v1.6.0** | Unit & Integration | `npm test` | **PASSED** ✅ (74 Passed) |
| **v1.6.0** | Playwright UI E2E | `npm run test:ui` | **PASSED** ✅ |
| **v1.6.0** | Live LSP Suite | `npm run test:lsp-live` | **PASSED** ✅ |
| **v1.6.0** | Real Hardware Ollama E2E | `npm run test:ollama-e2e` | **PASSED** ✅ (RTX 3090) |
| **v1.7.0-dev.3** | Syntax Check | `npm run check` | **PASSED** ✅ (20 modules) |
| **v1.7.0-dev.3** | Unit & Integration | `npm test` | **PASSED** ✅ (79 Passed) |
| **v1.7.0-dev.3** | Playwright UI E2E | `npm run test:ui` | **PASSED** ✅ |
| **v1.7.0-dev.3** | Live LSP Suite | `npm run test:lsp-live` | **PASSED** ✅ |
| **v1.7.0-dev.3** | Real Hardware Ollama E2E | `npm run test:ollama-e2e` | **PASSED** ✅ (RTX 3090) |

---

## 5. Conclusion

Both release builds (**v1.6.0** and **v1.7.0-dev.3**) have been fully debugged, patched, hardware-validated, and verified **100% GREEN**.
