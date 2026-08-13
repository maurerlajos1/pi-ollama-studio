# Third-party notices

## Monaco Editor

Pi Ollama Studio vendors **Monaco Editor 0.55.1** under `vendor/monaco/` for local, offline editor and diff functionality.

Monaco Editor is Copyright (c) Microsoft Corporation and distributed under the MIT License. The upstream license is included at `vendor/monaco/LICENSE`.

No Monaco CDN is required by Pi Ollama Studio.

## Language-server runtime

Pi Ollama Studio v1.5 vendors runtime files for language-server integration under `vendor/lsp-runtime/`, including TypeScript/TypeScript Language Server, Pyright, the HTML language server and Angular Language Server components supplied in the offline development bundle. Their upstream package license/notice files remain alongside the vendored package contents where provided.

## Playwright test runtime

The UI E2E harness vendors the Playwright JavaScript runtime under `vendor/e2e-runtime/`. Upstream LICENSE, NOTICE and ThirdPartyNotices files are retained in those package directories. Browser binaries are not bundled by Studio.

## xterm.js

Pi Ollama Studio v1.6 vendors xterm.js and selected official addons under `vendor/xterm/` for the local integrated terminal UI: core xterm, fit, search, web-links, and WebGL addons. Upstream license files are retained alongside the vendored packages.

## node-pty

The Microsoft `node-pty` 1.1.0 package tarball is retained under `vendor/packages/` as the native PTY/ConPTY source/prebuild payload used by the optional full terminal backend. Studio does not require it to start: when `node-pty` is unavailable, the terminal manager uses a child-process pipe fallback. Native packaging/install is platform-specific and is validated separately during desktop packaging.
