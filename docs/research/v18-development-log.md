I **didn't mean merge into the RC**. I meant I was building **v1.8-dev on a separate branch/copy** while you were validating RC1. If I implied RC1 itself was being modified, that was incorrect.

Looking at your report:

**v1.7.0-rc.1 is now effectively production quality.**

The fixes you found are exactly the sort of platform-specific issues that only appear on real Windows machines:

-  ✅ realpath canonicalization 
-  ✅ drive-letter casing 
-  ✅ PowerShell folder picker 
-  ✅ session inspection 
-  ✅ checkpoint lookup 
-  ✅ chat tree association 
-  ✅ production API route updates 

And the important part:

- **79 tests** 
- **Playwright** 
- **Real LSP** 
- **Real RTX3090 Ollama** 
- **Real Pi** 
- **0 failures** 

That's the release gate we wanted.

---

## This is how I want to proceed

### Branch A (Frozen)

```
```

```
v1.7.0
```

Only receives:

-  bug fixes 
-  regressions 
-  Windows/Linux compatibility fixes 

No new features.

---

### Branch B

```
```

```
v1.8-dev
```

Everything new goes here.

Exactly like a real software project.

That means if tomorrow you discover another RC bug:

```
```

```
v1.7 fix
        ↓
merge forward
        ↓
v1.8
```

Never the opposite.

---

## I also noticed something important

This report shows the architecture is doing what we hoped.

The bugs weren't

> "the design is wrong"

They were

> "Windows path canonicalization"

> "drive letter normalization"

> "API endpoint mismatch"

Those are implementation bugs.

That's actually a very good sign.

---

## Since you uploaded the new ZIP

I'll switch my review baseline.

From now on **this** becomes the source of truth:

```
```

```
pi-ollama-studio-v1.7.0-rc-prod.1.zip
```

Everything I review, refactor and build for v1.8 will start from this exact verified production candidate, **not** the older RC.

That means the Windows fixes you've already validated won't be accidentally reintroduced.

---

## I think the roadmap is now very clear

### v1.7 Final

Freeze.

Only bugfixes.

---

### v1.8

Architecture.

Provider abstraction.

OpenAI/OpenAI-compatible.

MCP.

Module split.

No subagents yet.

---

### v1.9

Subagents.

Worktree orchestration.

Parallel execution.

---

### v2.0

Desktop IDE.

Telemetry.

Benchmarking.

Visual testing.

Plugin ecosystem.

---

I also agree with one decision you made earlier that I think is going to pay off:

> **"Don't cripple it with security restrictions. It's a local development IDE."**

I think that's the right philosophy for this project.

Studio should behave like **VS Code + Cursor + Claude Code + Pi**, where the user owns the machine and can decide what the agent is allowed to do. We can still provide guardrails (confirmation dialogs for destructive operations, clear audit logs, permission profiles), but they should be optional and not get in the way of local development.

And yes—I will now treat the uploaded **`pi-ollama-studio-v1.7.0-rc-prod.1.zip`** as the canonical production baseline for all future review and v1.8 work.

Worked for 53m 55s

Continuing from the new canonical production baseline you just uploaded. I’m first diffing that **rc-prod.1** against the separate v1.8-dev work so I can replay the provider/MCP/module-split changes forward **without losing any of your Windows fixes**; then I’ll rerun the full suite before adding anything new.

Inspected uploaded project files, branches, package roots, and versions

I found both trees cleanly: your uploaded production candidate is still labeled `1.7.0-rc.1` internally, while the parallel branch is `1.8.0-dev.1`. I’m doing a **three-way forward-port** now—production RC vs the reviewed RC base vs v1.8-dev—so only your tested Windows/session fixes are merged, rather than copying entire files and potentially deleting new provider/MCP code.

Compared canonical and v18 changes, inspected code, and ran tests

The production fixes are isolated now. I’m forward-porting the **behavior**, not every incidental diff: session/checkpoint canonicalization and the proven historical-project API flow are coming forward; I’m keeping the reviewed improvement that excludes `.pi/studio-sessions` from Git snapshots, because copying chat/session logs into code checkpoints would be a regression even though the tested ZIP happened to use a broader `git add`.

Inspected session API routes and applied path resolution patches

The tested RC fixes are now forward-ported into v1.8-dev without replacing the new provider/MCP work, and syntax is clean. I’m adding regression coverage specifically for **canonical session-path/checkpoint aliases and the production historical-project route flow**, then I’ll rerun all 114 current tests before continuing the next v1.8 feature slice.

Inspected session symlink tests and added alias-handling coverage

The forward-port is fully green: **118/118 tests pass** after adding four new regression checks for your production Windows/session fixes. I’m moving on with v1.8 now; the next slice is deliberately still low-risk: finish the MCP exposure UX/E2E and make provider capabilities/model availability first-class, so later subagents can choose providers reliably without touching the v1.7 runtime foundation.

Inspected provider profiles, MCP controls, routes, bridges, and tool registration APIs

I found a real v1.8 correctness issue before moving on: MCP exposure changes were persisted, but a tool already registered in a running Pi session could remain active after you hid it. Also the generic resource/prompt bridge could bypass “Expose this server to Pi.” I’m fixing that now using Pi’s native `getActiveTools()/setActiveTools()` plus separate **agent-only MCP endpoints**, while keeping the normal Studio/manual MCP APIs fully unrestricted.

Inspected MCP bridge tests and exposure logic

I’m also tightening MCP hot-reload semantics while I’m here: changing a tool’s schema/description on the MCP server will now refresh the registered Pi tool definition, and hiding a tool removes it from Pi’s **active** tool set immediately without restarting Pi. Registered-but-hidden tools remain dormant so re-enabling them is fast.

Patched MCP agent access controls and updated bridge tests

The MCP hot-exposure fix is green in targeted tests: hidden servers/tools disappear from Pi’s active tool set immediately, schema changes refresh in place, and manual Studio calls still work. I’ve also added rendered Playwright coverage for hiding/re-enabling MCP exposure without disconnecting the normal manual MCP workflow.

I’m running the full suite again now, then I’ll take the next provider slice: **model capability overrides/probing** so generic OpenAI-compatible servers can accurately tell Studio/Pi whether a specific model supports tools, reasoning, vision, JSON/schema output, context size and max output instead of inheriting optimistic defaults.

Ran test suite and inspected provider tests and fixtures

Searched 4 websites

Inspected provider probes and tests, then implemented model normalization helpers

I’m continuing exactly from the provider-capability slice. The code changes are already syntax-clean; I’m updating the provider mocks/assertions for **tools + JSON Schema capability probes**, then I’ll rerun targeted provider tests and the full v1.8 suite before moving on.

Inspected provider capabilities and edited deep-capture tests

The new capability logic itself passed; one UI test failed because its tiny fake DOM doesn’t aggregate child HTML the way a real browser does. I’m fixing the **test harness**, not the production UI, then I’ll run the provider slice again and the full suite.

Fixed panel tests and ran targeted checks and full tests

The capability-probing slice is now fully green: **119/119 tests pass**. It now tests both Responses and Chat Completions request shapes for streaming, function tools, and JSON Schema—not just optimistic capability flags.

I’m running real Pi + all bundled LSPs at this checkpoint, then I’ll add **manual per-model capability overrides** for servers that can’t be reliably auto-probed (vision/reasoning/context/output limits), which is important for generic OpenAI-compatible runtimes.

Ran live LSP and PI tests while inspecting model override interfaces

Real-runtime checkpoint is green too: **all four bundled LSPs pass and real Pi 0.82.1 passes** on the current v1.8 branch.

I’m adding a small **per-model override editor** now for the things generic `/v1/models` usually cannot tell us reliably: context window, max output, tools, JSON Schema, vision and reasoning. Auto-probed values remain the default; manual overrides win when you know the server/model better.

Implemented tri-state model overrides and updated normalization tests

The override editor is wired without changing provider behavior for existing profiles. I’m adding regression tests now for the important invariant: **probe results may update detected capabilities, but an explicit user override must always win**, including what gets synchronized into Pi’s model definition.

Updated provider panel override fixtures and ran full checks

The manual-override slice is now green too: **121/121 tests pass**. An explicit model override now wins over later probes and is what Pi receives for context/output/reasoning/input support.

I’m extending the Windows Playwright provider scenario to exercise those controls through the rendered UI next, then I’ll take another modularization slice instead of piling more code into `app.js`/`server.mjs`.

Inspected E2E scripts and updated Playwright capability override tests

The rendered Windows E2E script now covers the new provider override UI as well, including verifying the effective `65536 / 15000 / reasoning / no-vision` values actually land in Pi’s generated model config.

I’m taking the next architecture slice now: extracting another self-contained route family from `server.mjs`. I’m choosing **Pi Platform routes** because they’re already heavily tested and don’t touch the Pi/Ollama execution loop, so it reduces monolith risk without destabilizing agent runtime behavior.

Inspected and refactored platform routes with tests, then ran targeted E2E tests

The Pi Platform route extraction is complete and its real HTTP integration flow still passes. `server.mjs` is already shrinking without changing API behavior.

I’m doing one full regression run after that structural change. If it stays green, I’ll use the remaining parallel-work window to extract the **Pi Platform frontend controller** from `app.js` as the matching frontend modularization slice—again behavior-preserving, not a new runtime feature.

Inspected Pi Platform code and ran the full test suite

keep continue what are u doing just corius so i be able to search extensions too?

Yes — that’s part of where I’m heading. Right now I’m modularizing the **Pi Platform frontend** so extensions, skills, prompts, packages, instructions, and settings each have clean ownership instead of living inside `app.js`.

For extensions specifically, I want Studio to support **search/filter across installed project/global extensions**, inspect source/commands/tools, and then add a second search path for discoverable/installable Pi packages/extensions rather than forcing you to know exact names.

i mean also search and download from online? keep continue what you was doing

Worked for 47m 37s

Yes — I mean **online discovery and install too**, not just filtering what’s already on disk. I’ll keep the local extension manager powerful, then add an online search/install layer (likely Pi packages first, plus npm/Git sources where appropriate) with source/version metadata and a clear install target (global vs project). I’m continuing the Pi Platform frontend split first so that online discovery plugs into a clean module instead of bloating `app.js` again.

Inspected Pi workspace and located app projects and tests

Searched 1 website

Inspected project status, ran tests, and searched related code

Searching pi.dev

Inspected Pi platform integration, package management, and marketplace write logic

I checked the current Pi package system before implementing it: Pi officially discovers publishable packages through the `pi-package` npm keyword, and `pi install` supports npm, Git/HTTPS/SSH, and local sources, with `-l` for project scope. So I’m building Studio’s online browser on the **npm registry + Pi’s own installer**, not scraping a fragile webpage.

That means the Extensions/Packages area will be able to search the online Pi ecosystem, inspect what a package contains (extensions/skills/prompts/themes), and install it globally or into the current project.

Created package utilities and tested Pi marketplace routes and providers

The online package backend is now working and tested too. Studio can search the npm-backed Pi package catalog, hydrate each result’s real `pi` manifest so it knows whether it contains extensions/skills/prompts/themes, and install/remove through Pi’s own `pi install` / `pi remove` commands with Global vs Project scope. The new package tests are green inside the full suite.

I’m wiring that into the Pi Platform UI now while completing the frontend extraction, so **Extensions/Packages → Browse Online** becomes a real searchable/installable marketplace instead of a copy-command-only list.

Inspected and refactored platform panel integration with Pi controller tests

The frontend split is now complete for Pi Platform too: `app.js` dropped by \~200 lines, and the resource manager lives in its own `pi-platform-panel.js`. The full suite is still green at **127/127 test records** after that extraction.

The online marketplace UI is also wired: **Packages → Browse Online** can search Pi packages/extensions, filter by resource type, inspect the package manifest, then install to Project or Global scope; the Installed view can install direct npm/Git/URL/local sources and remove/update existing packages. I’m adding controller-level and Playwright tests for that exact UI flow now.

Ran panel, package flow, and UI tests after fixture fixes

Searched 1 website

Added online extension browsing and patched platform controls

I also made the **Extensions tab itself** link into the online marketplace, so you won’t have to mentally know that “extensions live inside packages.” You’ll have a direct **Browse Online Extensions** action plus command-palette entries for “Browse online Pi extensions” and the full package marketplace.

The implementation uses Pi’s native package mechanism rather than a separate plugin system, so anything you install through Studio remains a normal Pi package and works with `pi list`, `pi update`, project/global scope, Git sources, etc.

Added end-to-end package server integration test

Searched 1 website

Updated package approval and restart notifications

One implementation detail I tightened from Pi’s current docs: when you explicitly click **Install Project** in Studio, the command now uses Pi’s project-local `-l` flow with `--approve`, because Pi package commands participate in project-trust handling even in non-interactive use. That avoids a project install silently ignoring local resources on a fresh workspace.

Installed packages stay native Pi packages; if Pi is already running, Studio tells you a Pi restart is needed for newly installed extension/skill/prompt resources to load, since `/reload` is an interactive Pi command rather than an RPC command.

Ran release checkpoint tests

Yes — continuing from the green **131/131 v1.8-dev** checkpoint. The online Pi package/extension marketplace is already working; I’m taking the next safe slice now: **package detail/version management + per-package resource controls**, then another frontend/backend modularization pass so the marketplace doesn’t become another monolith.

Continued V18 skills integration development

Searched 1 website

Inspected package controls, filters, platform data, and normalization methods

Searched 1 website

Inspected PI package routes and tests

I’m adding two things that make the online browser much more useful in practice: **version pinning** (`npm:pkg@1.2.3`, which Pi treats as pinned) and **resource load controls** for installed packages—so you can keep a package installed but choose whether its extensions, skills, prompts, or themes load. This maps directly to Pi’s native package settings object format rather than inventing Studio-only state.

Added package metadata, configuration routes, version selection, and integration tests

The marketplace is stronger now: online results expose available versions and can install a **specific pinned version**, while installed packages get native Pi resource controls for Extensions / Skills / Prompts / Themes (`Load all`, `Load none`, or custom glob filters). These are stored directly in Pi’s `settings.json`, so Studio isn’t creating a proprietary package format. Versioned npm installs are also natively pinned by Pi.

Tested Pi package integration and added marketplace resource controls

The new package controls are now integrated and syntax-clean. I’ve kept them deliberately native to Pi: selecting a specific npm version creates a pinned Pi source, and resource toggles write the same package filters Pi documents (`[]` = load none, omitted key = load all, custom globs = filtered).

I’m running the full v1.8 regression suite now; after that I’ll continue the architecture split rather than immediately adding another large feature.

Ran the full npm test suite

Full suite after the marketplace/version/resource-control work is green: **135/135 test records, 0 failures**. So the online extension/package functionality is not just UI scaffolding anymore—it has backend, HTTP integration, controller, and package-filter tests.

I’m continuing with a behavior-preserving backend split next. I’m deliberately choosing a lower-risk route family rather than Pi/Ollama/session execution, so your production fixes remain easy to merge forward.

Inspected and patched testing route imports and boundaries

The Test Explorer/run-configuration routes are now split out of `server.mjs` into their own module, with contract tests and the existing Test Explorer integration still intact. This is the kind of refactor I want before subagents: feature ownership gets smaller while behavior remains unchanged.

I’m tightening the Windows Playwright marketplace flow now so it clicks a pinned package version and changes an installed package’s resource load mode—not merely “search and install.”

Reviewed UI tests and patched fixture resource configuration

Yes — **online search/download/install is now part of v1.8**, and I continued the other work at the same time.

What is implemented so far:

- **Online Pi marketplace** 
  -  searches the npm-backed Pi package ecosystem 
  -  specifically discovers packages published with Pi's `pi-package` mechanism 
  -  filter by Extensions / Skills / Prompts / Themes 
  -  package details and Pi manifest 
  -  repository/homepage links 
  -  Project or Global install 
  -  npm, Git, HTTPS and local package sources 
  -  remove/update installed packages 
  -  direct **Browse Online Extensions** and **Browse Online Skills** buttons 

Pi officially uses the `pi-package` npm keyword for package discovery, and packages can bundle extensions, skills, prompts and themes, so Studio is using Pi's native ecosystem rather than creating an incompatible plugin store. 

I also just added:

- **Version selection** 
  -  choose latest or a particular version 
  -  e.g. `npm:some-extension@1.2.3` 
  -  Pi treats versioned npm package sources as pinned.  
- **Installed-package resource controls** 
  -  Extensions: All / None / Custom 
  -  Skills: All / None / Custom 
  -  Prompts: All / None / Custom 
  -  Themes: All / None / Custom 
  -  custom Pi glob filters 
  -  package remains installed even when one resource type is disabled 

Those controls write Pi's native package-filter configuration. Pi itself defines an omitted resource key as “load all,” `[]` as “load none,” and supports include/exclude glob patterns. 

I added backend, HTTP-integration, controller, version-pinning and resource-filter regression tests. After those changes the full deterministic suite reached:

```
```

```
135 / 135 test records PASS
0 failures
```

I also continued the architectural cleanup. Test Explorer and run-configuration HTTP handling has now been extracted from `server.mjs` into its own route module with contract tests. Provider, MCP, Pi Platform, packages and testing therefore all have increasingly separate ownership instead of accumulating in the server monolith.

Finally, I extended the Windows Playwright scenario so it now plans to physically:

```
```

```
Open Packages
→ select installed package
→ disable its Extension resources
→ Apply
→ verify .pi/settings.json changed

→ Browse Online
→ search extension marketplace
→ inspect package manifest
→ choose an older explicit version
→ Install Project
→ verify request is npm:package@version
```

That latest Playwright **script is syntax-checked**, but I did **not** get to execute the rendered browser portion here because this environment still has the Chromium restriction. That's intentionally left for the eventual Windows v1.8 gate on your machine.

So yes: by v1.8 you'll be able to **search for extensions online, inspect them, choose versions, install/update/remove them, and control which resources they load directly from Studio.**