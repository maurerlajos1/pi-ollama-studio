import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspManager, LspProcess, languageIdForPath, uriToWorkspacePath } from '../src/lsp.mjs';

const fakeServerSource = String.raw`
let buffer = Buffer.alloc(0);
function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'), body])); }
function handle(msg) {
  if (msg.id != null && msg.method === 'initialize') {
    send({jsonrpc:'2.0', id:msg.id, result:{capabilities:{hoverProvider:true,completionProvider:{triggerCharacters:['.']},textDocumentSync:1},serverInfo:{name:'fake-lsp',version:msg.params.clientInfo && msg.params.clientInfo.version || 'missing'}}});
    send({jsonrpc:'2.0', id:900, method:'workspace/configuration', params:{items:[{section:'fake'}]}});
  } else if (msg.id != null && msg.method === 'textDocument/hover') {
    send({jsonrpc:'2.0', id:msg.id, result:{contents:{kind:'markdown',value:'**hovered**'},range:{start:{line:0,character:0},end:{line:0,character:3}}}});
  } else if (msg.id != null && msg.method === 'textDocument/completion') {
    send({jsonrpc:'2.0', id:msg.id, result:{isIncomplete:false,items:[{label:'alpha',kind:6,insertText:'alpha'}]}});
  } else if (msg.id != null && msg.method === 'shutdown') {
    send({jsonrpc:'2.0', id:msg.id, result:null});
  } else if (msg.method === 'textDocument/didOpen') {
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:msg.params.textDocument.uri,version:msg.params.textDocument.version,diagnostics:[{range:{start:{line:0,character:1},end:{line:0,character:4}},severity:1,source:'fake',message:'Fake error'}]}});
  } else if (msg.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length){ const idx=buffer.indexOf('\r\n\r\n'); if(idx<0)return; const header=buffer.subarray(0,idx).toString(); const m=/Content-Length:\s*(\d+)/i.exec(header); if(!m){buffer=buffer.subarray(idx+4);continue;} const len=Number(m[1]); const total=idx+4+len; if(buffer.length<total)return; const body=buffer.subarray(idx+4,total).toString(); buffer=buffer.subarray(total); handle(JSON.parse(body)); }
});
`;

test('languageIdForPath maps supported editor languages', () => {
  assert.equal(languageIdForPath('src/app.ts'), 'typescript');
  assert.equal(languageIdForPath('src/view.tsx'), 'typescriptreact');
  assert.equal(languageIdForPath('main.py'), 'python');
  assert.equal(languageIdForPath('index.html'), 'html');
  assert.equal(languageIdForPath('style.scss'), 'scss');
  assert.equal(languageIdForPath('README.md'), 'markdown');
});

test('uriToWorkspacePath rejects file URIs outside workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lsp-uri-'));
  try {
    const inside = new URL(`file://${path.join(root, 'src', 'x.ts')}`).href;
    assert.equal(uriToWorkspacePath(root, inside), 'src/x.ts');
    assert.equal(uriToWorkspacePath(root, new URL(`file://${path.join(os.tmpdir(), 'outside.ts')}`).href), '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('LspProcess handles initialize, client requests, diagnostics and requests', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lsp-fake-'));
  const serverFile = path.join(root, 'fake-lsp.mjs');
  await fs.writeFile(serverFile, fakeServerSource);
  const proc = new LspProcess({
    definition: { id: 'fake', label: 'Fake', languages: ['typescript'], command: process.execPath, args: [serverFile], initializationOptions: {} },
    workspace: root,
    settings: { fake: { enabled: true } },
    requestTimeout: 5000,
    clientVersion: '1.7-test'
  });
  t.after(async () => { await proc.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const diagnostics = [];
  proc.on('diagnostics', (value) => diagnostics.push(value));
  const status = await proc.start();
  assert.equal(status.initialized, true);
  assert.equal(status.serverInfo.name, 'fake-lsp');
  assert.equal(status.serverInfo.version, '1.7-test');
  await proc.openDocument({ path: 'a.ts', languageId: 'typescript', text: 'let x=1;' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(diagnostics[0].path, 'a.ts');
  assert.equal(diagnostics[0].diagnostics[0].message, 'Fake error');
  const hover = await proc.request('textDocument/hover', { textDocument: { uri: new URL(`file://${path.join(root, 'a.ts')}`).href }, position: { line: 0, character: 1 } });
  assert.equal(hover.contents.value, '**hovered**');
  const completion = await proc.request('textDocument/completion', { textDocument: { uri: new URL(`file://${path.join(root, 'a.ts')}`).href }, position: { line: 0, character: 1 } });
  assert.equal(completion.items[0].label, 'alpha');
});

test('LspManager exposes disabled upstream server payloads without starting them', async () => {
  const manager = new LspManager({ runtimeDir: path.resolve('vendor/lsp-runtime') });
  const defs = manager.serverDefinitions();
  assert.equal(defs.find((x) => x.id === 'typescript').available, true);
  const runtimeDefinitions = manager.definitions;
  assert.match(runtimeDefinitions.typescript.initializationOptions.tsserver.path, /@angular[\\/]language-server[\\/]node_modules[\\/]typescript[\\/]lib[\\/]tsserver\.js$/);
  assert.equal(defs.find((x) => x.id === 'pyright').available, true);
  assert.equal(defs.find((x) => x.id === 'html').available, true);
  assert.equal(defs.find((x) => x.id === 'css').available, false);
  assert.match(defs.find((x) => x.id === 'css').unavailableReason, /upstream package/i);
  await manager.stopAll();
});
