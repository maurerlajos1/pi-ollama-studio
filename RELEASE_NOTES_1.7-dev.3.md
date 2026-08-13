# Pi Ollama Studio v1.7.0-dev.3

## Monaco mouse-caret regression fix

- Fixed editor pane activation so a mouse click/focus change no longer calls the full `renderWorkbench()` path.
- Full workbench rendering restored the previously saved Monaco view state and could snap the caret/active line back after clicking another line.
- Pane activation now updates only active-pane chrome, tabs, legacy active-buffer state, and status information.
- Monaco cursor-position, selection, and scroll changes now independently schedule workspace view-state persistence.
- Added deterministic regression coverage that forbids `renderWorkbench()`/`renderPane()` from pane mouse activation.
- Extended Playwright UI E2E to physically click and type on a different Monaco line in the primary editor and a split secondary editor, then verify the edit landed on the clicked line.

All v1.7-dev.2 Pi Platform features and the hardware-validated v1.6 runtime fixes remain included.
