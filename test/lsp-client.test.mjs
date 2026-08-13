import test from 'node:test';
import assert from 'node:assert/strict';
import { MonacoLspBridge } from '../public/lsp-client.js';

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }); }
}

function fakeMonaco() {
  const providers = {};
  const models = [];
  const disposables = [];
  const register = (name) => (language, provider) => { (providers[name] ||= new Map()).set(language, provider); const d = { dispose() {} }; disposables.push(d); return d; };
  const languages = {
    CompletionItemKind: Object.fromEntries(['Text','Method','Function','Constructor','Field','Variable','Class','Interface','Module','Property','Unit','Value','Enum','Keyword','Snippet','Color','File','Reference','Folder','EnumMember','Constant','Struct','Event','Operator','TypeParameter'].map((k,i)=>[k,i+1])),
    SymbolKind: Object.fromEntries(['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter'].map((k,i)=>[k,i+1])),
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: register('completion'),
    registerHoverProvider: register('hover'),
    registerDefinitionProvider: register('definition'),
    registerImplementationProvider: register('implementation'),
    registerReferenceProvider: register('references'),
    registerRenameProvider: register('rename'),
    registerDocumentFormattingEditProvider: register('format'),
    registerDocumentSymbolProvider: register('symbols'),
    registerSignatureHelpProvider: register('signature'),
    registerCodeActionProvider: register('codeAction')
  };
  const markerCalls = [];
  const editor = {
    getModels: () => models,
    setModelMarkers: (model, owner, markers) => markerCalls.push({ model, owner, markers })
  };
  return {
    monaco: { Range, MarkerSeverity: { Hint:1, Info:2, Warning:4, Error:8 }, languages, editor },
    providers, models, markerCalls
  };
}

function fakeModel(path = 'src/main.ts', language = 'typescript', text = 'const answer: string = 42;') {
  return {
    __piStudioPath: path,
    uri: { toString: () => `file:///workspace/${path}` },
    getLanguageId: () => language,
    getValue: () => text,
    getVersionId: () => 1,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 7 }),
    getWordAtPosition: () => ({ word: 'answer', startColumn: 7, endColumn: 13 }),
    getValueInRange: () => 'answer'
  };
}

test('MonacoLspBridge registers supported Monaco 0.55.1 providers and transforms LSP responses', async () => {
  const { monaco, providers, models, markerCalls } = fakeMonaco();
  const model = fakeModel(); models.push(model);
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/api/lsp/status')) return { ok:true, servers:[{ id:'typescript', running:true }] };
    if (path === '/api/lsp/document') return { ok:true, results:[{ serverId:'typescript', ok:true }] };
    if (body?.method === 'textDocument/completion') return { ok:true, results:[{ serverId:'typescript', ok:true, result:{ items:[{ label:'answer', kind:6, detail:'const answer: string' }] } }] };
    if (body?.method === 'textDocument/hover') return { ok:true, results:[{ serverId:'typescript', ok:true, result:{ contents:{ kind:'markdown', value:'`const answer: string`' } } }] };
    if (body?.method === 'textDocument/definition') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ uri:'file:///workspace/src/main.ts', range:{ start:{line:0,character:6}, end:{line:0,character:12} } }] }] };
    if (body?.method === 'textDocument/implementation') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ uri:'file:///workspace/src/main.ts', range:{ start:{line:0,character:6}, end:{line:0,character:12} } }] }] };
    if (body?.method === 'textDocument/references') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ uri:'file:///workspace/src/main.ts', range:{ start:{line:0,character:6}, end:{line:0,character:12} } },{ uri:'file:///workspace/src/main.ts', range:{ start:{line:0,character:20}, end:{line:0,character:26} } }] }] };
    if (body?.method === 'textDocument/formatting') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ range:{ start:{line:0,character:0}, end:{line:0,character:0} }, newText:'// formatted\n' }] }] };
    if (body?.method === 'textDocument/documentSymbol') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ name:'answer', kind:13, range:{ start:{line:0,character:0}, end:{line:0,character:26} }, selectionRange:{ start:{line:0,character:6}, end:{line:0,character:12} } }] }] };
    if (body?.method === 'textDocument/signatureHelp') return { ok:true, results:[{ serverId:'typescript', ok:true, result:{ signatures:[{ label:'answer(value: string): string', parameters:[{ label:'value: string' }] }], activeSignature:0, activeParameter:0 } }] };
    if (body?.method === 'textDocument/codeAction') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ title:'Fix answer', kind:'quickfix', isPreferred:true, edit:{ changes:{ 'file:///workspace/src/main.ts':[{ range:{ start:{line:0,character:6}, end:{line:0,character:12} }, newText:'value' }] } } }] }] };
    if (body?.method === 'textDocument/prepareRename') return { ok:true, results:[{ serverId:'typescript', ok:true, result:{ range:{ start:{line:0,character:6}, end:{line:0,character:12} }, placeholder:'answer' } }] };
    if (body?.method === 'textDocument/rename') return { ok:true, results:[{ serverId:'typescript', ok:true, result:{ changes:{ 'file:///workspace/src/main.ts':[{ range:{ start:{line:0,character:6}, end:{line:0,character:12} }, newText:'value' }] } } }] };
    if (body?.method === 'workspace/symbol') return { ok:true, results:[{ serverId:'typescript', ok:true, result:[{ name:'answer', kind:13, location:{ uri:'file:///workspace/src/main.ts', range:{ start:{line:0,character:6}, end:{line:0,character:12} } } }] }] };
    return { ok:true, results:[{ serverId:'typescript', ok:true, result:null }] };
  };
  const bridge = new MonacoLspBridge({
    monaco, request, getWorkspace: () => '/workspace', getTextForPath: async () => '',
    ensureModelForPath: async () => model
  }).registerProviders();

  assert.ok(providers.completion.get('typescript'));
  assert.ok(providers.hover.get('python'));
  assert.equal(typeof monaco.languages.registerWorkspaceSymbolProvider, 'undefined');

  const completion = await providers.completion.get('typescript').provideCompletionItems(model, { lineNumber:1, column:7 }, { triggerKind:1 });
  assert.equal(completion.suggestions[0].label, 'answer');
  const hover = await providers.hover.get('typescript').provideHover(model, { lineNumber:1, column:7 });
  assert.match(hover.contents[0].value, /answer/);
  const definition = await providers.definition.get('typescript').provideDefinition(model, { lineNumber:1, column:7 });
  assert.equal(definition[0].range.startLineNumber, 1);
  const implementation = await providers.implementation.get('typescript').provideImplementation(model, { lineNumber:1, column:7 });
  assert.equal(implementation.length, 1);
  const references = await providers.references.get('typescript').provideReferences(model, { lineNumber:1, column:7 }, { includeDeclaration:true });
  assert.equal(references.length, 2);
  const formatting = await providers.format.get('typescript').provideDocumentFormattingEdits(model, { tabSize:2, insertSpaces:true });
  assert.equal(formatting[0].text, '// formatted\n');
  const symbolsInDocument = await providers.symbols.get('typescript').provideDocumentSymbols(model);
  assert.equal(symbolsInDocument[0].name, 'answer');
  const signatureHelp = await providers.signature.get('typescript').provideSignatureHelp(model, { lineNumber:1, column:7 }, null, { triggerKind:1 });
  assert.match(signatureHelp.value.signatures[0].label, /answer/);
  const codeActionResult = await providers.codeAction.get('typescript').provideCodeActions(model, new Range(1,1,1,7), { markers:[{ startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:7,severity:8,message:'bad' }], only:'quickfix', trigger:1 });
  assert.equal(codeActionResult.actions.length, 1);
  assert.equal(codeActionResult.actions[0].edit.edits[0].textEdit.text, 'value');
  const renameLocation = await providers.rename.get('typescript').resolveRenameLocation(model, { lineNumber:1, column:7 });
  assert.equal(renameLocation.text, 'answer');
  const rename = await providers.rename.get('typescript').provideRenameEdits(model, { lineNumber:1, column:7 }, 'value');
  assert.equal(rename.edits[0].textEdit.text, 'value');

  const symbols = await bridge.workspaceSymbols('ans');
  assert.equal(symbols[0].name, 'answer');
  assert.equal(symbols[0].path, 'src/main.ts');

  let diagnosticsPayload;
  bridge.onDiagnostics = (payload) => { diagnosticsPayload = payload; };
  bridge.applyDiagnostics({ serverId:'typescript', path:'src/main.ts', diagnostics:[{ severity:1, message:'Type error', range:{ start:{line:0,character:6}, end:{line:0,character:12} } }] });
  assert.equal(markerCalls[0].owner, 'lsp:typescript');
  assert.equal(markerCalls[0].markers[0].severity, monaco.MarkerSeverity.Error);
  assert.equal(diagnosticsPayload.path, 'src/main.ts');

  await bridge.syncModel(model, 'open', { immediate:true });
  assert.ok(calls.some((call) => call.path === '/api/lsp/document'));
  bridge.dispose();
});

test('MonacoLspBridge resolves superseded debounced sync promises instead of leaking them', async () => {
  const { monaco } = fakeMonaco();
  const calls = [];
  const model = fakeModel();
  const bridge = new MonacoLspBridge({
    monaco,
    request: async (path, body) => { calls.push({ path, body }); return { ok: true, results: [] }; },
    getWorkspace: () => '/workspace',
    getTextForPath: async () => '',
    ensureModelForPath: async () => model
  });

  const first = bridge.syncModel(model, 'change');
  const second = bridge.syncModel(model, 'change');
  const firstResult = await Promise.race([
    first,
    new Promise((_, reject) => setTimeout(() => reject(new Error('superseded sync promise leaked')), 100))
  ]);
  assert.deepEqual(firstResult, []);
  await second;
  assert.equal(calls.filter((call) => call.path === '/api/lsp/document').length, 1);
  bridge.dispose();
});
