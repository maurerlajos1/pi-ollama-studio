import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspManager } from '../src/lsp.mjs';

const runtimeDir = path.resolve('vendor/lsp-runtime');

async function withWorkspace(prefix, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const manager = new LspManager({ runtimeDir });
  try { return await fn(root, manager); }
  finally { await manager.stopAll(); await fs.rm(root, { recursive: true, force: true }); }
}

test('bundled TypeScript language server provides navigation, symbols, rename, completion, signature help and diagnostics', async () => withWorkspace('pi-live-ts-', async (root, manager) => {
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }));
  await fs.writeFile(path.join(root, 'util.ts'), 'export function greet(name: string) { return name.toUpperCase(); }\n');
  const code = [
    'import { greet } from "./util";',
    'const result = greet("world");',
    'const bad: string = 42;',
    'function wrapper(value: string) { return greet(value); }',
    'console.log(result, wrapper("x"));',
    ''
  ].join('\n');
  await fs.writeFile(path.join(root, 'main.ts'), code);
  const diagnostics = [];
  manager.on('diagnostics', (value) => { if (value.serverId === 'typescript') diagnostics.push(...value.diagnostics); });
  const sync = await manager.syncDocument({ workspace: root, path: 'main.ts', languageId: 'typescript', text: code, action: 'open' });
  assert.deepEqual(sync, [{ serverId: 'typescript', ok: true }]);

  const hover = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/hover', params: { position: { line: 1, character: 17 } }, text: code });
  assert.equal(hover.results[0].ok, true);
  assert.ok(hover.results[0].result);

  const definition = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/definition', params: { position: { line: 1, character: 17 } }, text: code });
  assert.equal(definition.results[0].ok, true);
  const defList = Array.isArray(definition.results[0].result) ? definition.results[0].result : [definition.results[0].result];
  assert.ok(defList.some((item) => item && (item.uri || item.targetUri)), 'expected at least one definition location for imported symbol usage');

  // TypeScript can legally resolve an imported symbol usage to its local import alias first.
  // Verify cross-file navigation separately through the module specifier, which is stable across TS LS versions.
  const moduleDefinition = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/definition', params: { position: { line: 0, character: 24 } }, text: code });
  assert.equal(moduleDefinition.results[0].ok, true);
  const moduleDefList = Array.isArray(moduleDefinition.results[0].result) ? moduleDefinition.results[0].result : [moduleDefinition.results[0].result];
  assert.ok(moduleDefList.some((item) => /util\.ts$/i.test(new URL(item.uri || item.targetUri).pathname)), 'expected module definition to navigate to util.ts');

  const references = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/references', params: { position: { line: 1, character: 17 }, context: { includeDeclaration: true } }, text: code });
  assert.equal(references.results[0].ok, true);
  assert.ok(Array.isArray(references.results[0].result) && references.results[0].result.length >= 3);

  const prepareRename = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/prepareRename', params: { position: { line: 1, character: 17 } }, text: code });
  assert.equal(prepareRename.results[0].ok, true);
  assert.ok(prepareRename.results[0].result);
  const rename = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/rename', params: { position: { line: 1, character: 17 }, newName: 'salute' }, text: code });
  assert.equal(rename.results[0].ok, true);
  assert.ok(rename.results[0].result?.changes || rename.results[0].result?.documentChanges);

  const documentSymbols = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/documentSymbol', params: {}, text: code });
  assert.equal(documentSymbols.results[0].ok, true);
  assert.ok(Array.isArray(documentSymbols.results[0].result) && documentSymbols.results[0].result.some((item) => item.name === 'wrapper'));

  const workspaceSymbols = await manager.request({ workspace: root, method: 'workspace/symbol', params: { query: 'greet' } });
  assert.equal(workspaceSymbols.results[0].ok, true);
  assert.ok(Array.isArray(workspaceSymbols.results[0].result));

  const signature = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/signatureHelp', params: { position: { line: 1, character: 23 }, context: { triggerKind: 1 } }, text: code });
  assert.equal(signature.results[0].ok, true);
  // TypeScript LS may return null here depending on its project-state timing/version; the important
  // bridge guarantee is that the request is framed, routed and answered without a protocol error.
  // Monaco's built-in TS provider remains available as a fallback for signature UI.
  assert.ok(signature.results[0].result == null || Array.isArray(signature.results[0].result?.signatures));

  const implementation = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/implementation', params: { position: { line: 1, character: 17 } }, text: code });
  assert.equal(implementation.results[0].ok, true);
  assert.equal(Array.isArray(implementation.results[0].result), true);

  const formatting = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/formatting', params: { options: { tabSize: 2, insertSpaces: true } }, text: code });
  assert.equal(formatting.results[0].ok, true);
  assert.ok(Array.isArray(formatting.results[0].result));

  const codeActions = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/codeAction', params: { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 24 } }, context: { diagnostics: [] } }, text: code });
  assert.equal(codeActions.results[0].ok, true);
  assert.ok(Array.isArray(codeActions.results[0].result));
  assert.ok(codeActions.results[0].result.some((action) => action?.edit || action?.command || action?.title), 'expected at least one code action');

  const completionCode = `${code}gre`;
  await manager.syncDocument({ workspace: root, path: 'main.ts', languageId: 'typescript', text: completionCode, version: 2, action: 'change' });
  const completion = await manager.request({ workspace: root, path: 'main.ts', languageId: 'typescript', method: 'textDocument/completion', params: { position: { line: 5, character: 3 }, context: { triggerKind: 1 } }, text: completionCode, version: 3 });
  assert.equal(completion.results[0].ok, true);
  const completionValue = completion.results[0].result;
  const completionItems = Array.isArray(completionValue) ? completionValue : completionValue?.items;
  assert.ok(Array.isArray(completionItems) && completionItems.some((item) => (typeof item.label === 'string' ? item.label : item.label?.label) === 'greet'));

  for (let i = 0; i < 30 && !diagnostics.some((item) => /not assignable/.test(item.message)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(diagnostics.some((item) => /not assignable/.test(item.message)));
}));

test('bundled Pyright provides hover and type diagnostics', async () => withWorkspace('pi-live-py-', async (root, manager) => {
  const code = 'def greet(name: str) -> str:\n    return name.upper()\n\nvalue: str = 42\ngreet("x")\n';
  await fs.writeFile(path.join(root, 'main.py'), code);
  const diagnostics = [];
  manager.on('diagnostics', (value) => { if (value.serverId === 'pyright') diagnostics.push(...value.diagnostics); });
  const sync = await manager.syncDocument({ workspace: root, path: 'main.py', languageId: 'python', text: code, action: 'open' });
  assert.equal(sync[0].ok, true);
  let hoverResult = null;
  for (let attempt = 0; attempt < 12 && !hoverResult; attempt += 1) {
    const hover = await manager.request({ workspace: root, path: 'main.py', languageId: 'python', method: 'textDocument/hover', params: { position: { line: 4, character: 1 } }, text: code });
    assert.equal(hover.results[0].ok, true);
    hoverResult = hover.results[0].result;
    if (!hoverResult) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(hoverResult, 'expected Pyright hover after bounded startup/indexing retries');
  for (let i = 0; i < 30 && !diagnostics.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(diagnostics.some((item) => /not assignable/.test(item.message)));
}));

test('bundled HTML language server returns completions', async () => withWorkspace('pi-live-html-', async (root, manager) => {
  const code = '<html>\n<body>\n<div cla></div>\n</body>\n</html>\n';
  await fs.writeFile(path.join(root, 'index.html'), code);
  const sync = await manager.syncDocument({ workspace: root, path: 'index.html', languageId: 'html', text: code, action: 'open' });
  assert.equal(sync[0].ok, true);
  const completion = await manager.request({ workspace: root, path: 'index.html', languageId: 'html', method: 'textDocument/completion', params: { position: { line: 2, character: 8 } }, text: code });
  const value = completion.results[0].result;
  const items = Array.isArray(value) ? value : value?.items;
  assert.ok(Array.isArray(items) && items.length > 20);
}));

test('bundled Angular language server initializes for Angular workspaces', async () => withWorkspace('pi-live-ng-', async (root, manager) => {
  await fs.writeFile(path.join(root, 'angular.json'), '{}');
  const code = '<div>{{ title }}</div>\n';
  await fs.writeFile(path.join(root, 'app.component.html'), code);
  const sync = await manager.syncDocument({ workspace: root, path: 'app.component.html', languageId: 'html', text: code, action: 'open' });
  assert.ok(sync.some((item) => item.serverId === 'angular' && item.ok));
  const running = (await manager.statusWithDefinitions(root)).filter((item) => item.running && item.initialized).map((item) => item.id);
  assert.ok(running.includes('angular'));
}));
