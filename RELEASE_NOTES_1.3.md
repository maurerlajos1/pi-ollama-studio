# Pi Ollama Studio 1.3.0

This phase turns the single-file editor and first-pass keyboard layer into a more IDE-like workbench while preserving the normal GUI as the default interaction model.

## Editor workbench

- Added multi-buffer file tabs with dirty indicators and safe close behavior.
- Added next/previous buffer commands and `Ctrl+Tab` / `Ctrl+Shift+Tab` navigation.
- Added vertical and horizontal two-pane editor splits.
- Added mouse-draggable split sizing.
- File Explorer opens into the currently active editor pane, so split workflows work naturally with the mouse.
- Workspace switching now warns before discarding dirty buffers.
- Status bar now reports the active workspace and buffer.

## Pi resources

- Added a dedicated Resources view backed by Pi `get_commands`.
- Resources can be filtered as Skills, Prompts, Extensions, Built-ins, or All.
- Added search plus Insert and Run actions.
- Existing Settings → Pi command discovery remains available.

## Neovim-inspired power layer

- Added named/unnamed registers for selected chat/tree/tool content.
- Added semantic macro recording with `q{register}` … `q` and replay with `@{register}`.
- Macros store Studio command IDs and arguments rather than UI coordinates.
- Added `.` repeat for commands explicitly marked repeatable.
- Added an inspectable Registers / Macros modal.
- Existing marks, quickfix navigation, folding, leader menu, palette, and Normal/Insert modes remain intact.

## Architecture

- Added `public/workbench.js` with separately tested `BufferManager`, `RegisterStore`, and `SemanticMacroRecorder`.
- Continued moving stateful interaction primitives out of the large `public/app.js` file.
- Standard mouse UI, Keyboard Enhanced mode, and Vim mode still execute the same semantic command registry.

## Validation

The clean source tree passes `npm run check` and the complete Node test suite, including new workbench/register/macro tests.
