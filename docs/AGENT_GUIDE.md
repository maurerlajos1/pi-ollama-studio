# Pi Ollama Studio — Future Agent Operational Guide

This document is written for AI Coding Assistants (e.g. Gemini, Claude, Qwen, Codex) working on this codebase.

---

## 1. Quick Reference & Core Invariants

- **Root Working Dir**: The checked-out `pi-ollama-studio` repository root. Never hard-code a developer-specific absolute path.
- **Main Server File**: `server.mjs`
- **Main UI Files**: `public/app.js` plus browser-independent primitives in `public/command-system.js` and `public/workbench.js`
- **CSS Design Token Base**: `public/styles.css`
- **Test Runner**: Node built-in test runner (`npm test`)

---

## 2. Checklist for Future Feature Additions

When tasked with adding new features, follow this checklist:

### Step 1: Backend Route Addition (`server.mjs`)
- Always add new API handlers inside `handleApi(req, res, url)` in `server.mjs`.
- For workspace-relative file paths, use:
  ```javascript
  const { root, relative, target } = await resolveWorkspacePath(workspace, path, { allowMissing: false });
  ```
- Send standard JSON responses via `json(res, 200, { ok: true, data })` or `errorJson(res, statusCode, message)`.

### Step 2: Frontend State & View (`public/app.js` & `public/index.html`)
- If adding a new main view tab:
  1. Add `<button data-view="feature">Feature</button>` in `.view-tabs` in `index.html`.
  2. Add `<section id="view-feature" class="view feature-view">...</section>` in `index.html`.
  3. In `app.js`, add `switchView('feature')` handler if lazy-loading data is needed.
- Mutate the `app` object in `app.js` for reactive state.

### Step 3: Performance & Rendering Rules
- **DOM Manipulations**: Use `escapeHtml()` on user/untrusted text before constructing HTML strings.
- **Streaming Updates**: Wrap fast-firing SSE updates in `requestAnimationFrame()` to avoid UI jank.
- **Debouncing**: Debounce text inputs (search inputs, text filtering) by 150ms.

---

## 3. How to Debug & Diagnose Issues

1. **Check Logs View**: Switch to the **Logs** tab in the UI or examine `app.logs` in dev tools console.
2. **Protocol Inspection**: Enable the "Protocol events" checkbox in the Logs tab to see raw JSONL RPC events between Pi CLI and Studio.
3. **Run Unit Tests**: Run `npm test` via terminal to ensure all 11+ automated test suites pass cleanly.

---

## 4. Git & Commit Guidelines

- Stage specific files using `git add <files>`.
- Keep commit messages descriptive: `feat: add <feature>` or `fix: resolve <issue>`.
