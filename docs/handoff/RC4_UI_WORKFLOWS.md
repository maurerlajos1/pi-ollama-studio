# rc.4 UI Workflow Specification

This document describes the intended **current-release** workflow. It is deliberately narrower than the future harness/RLM research.

## 1. Project entry

Primary Project UI should make these actions obvious:

- **New Project**
- **Open Folder**
- **Create from Session**
- **Recent Projects**

### New Project

Fields:

- Project name
- Parent folder + Browse
- Exact final path preview
- Template: Empty / Plain HTML / Node
- Create & Open

Studio creates the final child folder. The user selects the parent; they should not need to pre-create the project directory.

### Open Folder

Choose an existing directory, canonicalize it, then perform the centralized workspace switch.

### Create from Session

Session Tree → select historical user prompt → Create App from Here → project wizard.

Wizard shows:

- selected prompt
- historical checkpoint if available
- fallback-copy warning if no checkpoint
- project name
- parent directory + Browse
- final path
- Create & Open

After creation:

- canonical workspace switches to the new project
- forked Pi session is bound/opened in the new project
- old workspace-owned state cannot repaint the new workspace

## 2. Workspace A → B

Treat this as a context transaction, not a textbox change.

Leave A:

- stop/detach Pi A as appropriate
- stop LSP A
- stop Preview A
- terminate/detach A-owned terminals
- clear old test results, diagnostics, Git/session selections, attachments and project-resource snapshots
- invalidate async A results using workspace generation/identity

Activate B:

- canonical path becomes authoritative
- files/Git/sessions/checkpoints/LSP/tests/Pi resources/Preview/terminal state reload for B
- secondary reload failure may produce a warning, but must not create a fake rollback after B is committed

## 3. Ollama runtime

Never conflate **Test** and **Use**.

### Test Connection

Shows a tested-server card with:

- endpoint
- installed models
- currently loaded models
- failure/error if unreachable

It must not change the active runtime or active inventory.

### Use this server

Only enabled/valid for the exact tested connection fingerprint (URL/auth-env/runtime kind). On commit:

- persist B
- clear A inventory
- fetch B `/api/tags`
- fetch B `/api/ps`
- re-evaluate runtime-bound profiles
- reconcile selected/default model
- sync Pi model config

## 4. Four model states

The UI should explicitly represent:

1. **Installed** — exists on the active runtime.
2. **Loaded** — currently resident according to `/api/ps`.
3. **Selected** — intended for the next session.
4. **Session model** — model actually used by running Pi.

Rules:

- Loaded is a performance/residency hint only.
- Never silently select a model just because it is loaded.
- If selected model is already loaded, show `Ready / loaded` and reuse it naturally.
- If selected model is not installed on the active runtime, disable/error clearly.
- A failed live model switch must not become the persisted startup default.

## 5. New Session

Visible launch contract:

- Workspace
- Runtime/provider
- Model
- Harness
- reasoning/thinking level if supported
- loaded/VRAM status for Ollama

Start should make it obvious whether Studio is:

- creating a fresh Pi session
- resuming an existing session
- switching model/harness

Harness changes selected while Pi is already running apply to the **next** session unless the implementation explicitly supports a safe live change.

During a long local generation:

- normal Send is disabled;
- Steer Now, Follow Up and Abort are enabled;
- Compact and direct Pi shell actions remain disabled until the turn settles;
- model loading/generation may take minutes without being misreported as a connection failure.

After settlement, the controls return to idle state. Pi-only Session/Advanced controls stay disabled whenever Pi is stopped.

## 6. Harness workbench

Current rc.4 harnesses are reusable Pi launch contracts, not a second plugin ecosystem.

Current UI should support:

- list built-in/global/project harnesses
- Use next
- New Session with harness
- New harness
- Save effective harness
- Edit custom harness
- Duplicate built-in/custom harness
- Delete custom harness
- inspect tool allowlist and appended system guidance
- jump to Pi resources / MCP settings

Built-in launch presets currently include:

- `Coding · Pi Default` — normal Pi coding with the inherited default tool/resource surface.
- `Coding · Pi Default + Web` — the same launch contract with web-search/fetch guidance; it uses web tools only when an enabled Pi web extension is actually installed and loaded.
- `Small Local Coder` — bounded core tools and local-model guidance.
- `Read-only Review` — read/search tools only.

The `Pi Default + Web` preset does not install or fake a web provider. The workflow is:

```text
Resources → Extensions
→ inspect/install/enable the Pi web extension
→ choose Coding · Pi Default + Web
→ start a new Pi session
```

If the resource changes while Pi is already running, Studio must show a restart-required notice. Restarting preserves the active workspace, selected/session model, harness, and session file, then starts Pi with the new resource set. A harness selected while Pi is running applies to the next Pi process/session unless the user explicitly restarts.

To make a custom harness:

```text
Settings → Harness → New harness
→ choose Project or Global scope
→ choose Coding or General agent
→ inherit Pi default tools or select a bounded allowlist
→ optionally add installed extension tool names
→ write workflow guidance
→ Save Harness
```

Use `Duplicate` on a built-in/custom preset to start from a known contract, or `Save effective` after a session to preserve the setup actually used. Resources remain ordinary Pi resources; the harness stores the launch contract and guidance rather than copying packages or extensions into a hidden Studio format.

Project/global Pi skills/extensions/prompts/packages remain inherited Pi-native resources.

## 7. Preview

Preview should support:

- detected `npm`/framework commands
- manual command
- attach/open local URL
- plain HTML via Studio-owned static server
- Start / Restart / Stop / Refresh / Open External
- raw logs with clean URL detection

When the user edits the command or URL and immediately clicks Start, the typed draft is authoritative. The optimistic `starting` render must never replace it with an older saved/detected suggestion.

Workspace switch must never leave Project A's preview presented beside Project B's editor.

## 8. Keyboard / Neovim parity

Every important visible action should have a semantic command ID. Buttons, command palette and Vim/keyboard mappings invoke the same command.

Priority commands to add/verify:

- `project.manager.open`
- `project.new`
- `project.openFolder`
- `project.createFromSession`
- `session.new`
- `harness.open`
- `harness.new`
- `harness.saveEffective`
- `harness.select`
- `preview.open`
- `preview.start`
- `preview.restart`
- `preview.stop`
- `ollama.testRuntime`
- `ollama.useTestedRuntime`

Names may differ if an existing command convention already exists; do not create duplicate semantics.

## 9. Session fork and clone

Fork/Clone naming uses an in-app dialog, not browser `prompt()`:

- the action is disabled until the name is non-empty;
- Enter submits and Escape/cancel closes without mutation;
- Fork explains that it keeps selected-node ancestry;
- Clone explains that it copies the full session;
- if the active project changes while the dialog is open, submission is rejected.

## 10. Form/action consistency

- Provider Test requires a valid HTTP(S) endpoint; Save additionally requires an ID.
- MCP Save requires an ID and a transport-specific command/URL.
- Direct package Inspect/Install requires a source; project scope additionally requires an open project.
- Package Custom glob fields are editable only in Custom mode.
- Long operations show a busy label and reject duplicate clicks.
- Destructive model/provider/MCP/package/harness actions require confirmation.
