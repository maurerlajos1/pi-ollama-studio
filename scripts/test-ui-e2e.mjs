import { chromium } from '../vendor/e2e-runtime/node_modules/playwright/index.mjs';
import { promises as fs, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function poll(fn, predicate, { timeoutMs = 15000, intervalMs = 100, label = 'operation' } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (predicate(result)) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

const fakePiSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const argv=process.argv.slice(2);
if (['install','remove','update'].includes(argv[0])) {
  const action=argv[0]; const local=argv.includes('-l'); const source=argv.find((v,i)=>i>0&&!['-l','--approve','-a','--no-approve','-na'].includes(v))||'';
  const settingsPath=local?path.join(process.cwd(),'.pi','settings.json'):path.join(process.env.PI_CODING_AGENT_DIR||'', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath),{recursive:true}); let settings={}; try{settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));}catch{} if(!Array.isArray(settings.packages))settings.packages=[];
  const ident=(v)=>String(v||'').replace(/@\d[^/]*$/,'');
  if(action==='install'&&!settings.packages.some((e)=>ident(typeof e==='string'?e:e.source)===ident(source))) settings.packages.push(source);
  if(action==='remove') settings.packages=settings.packages.filter((e)=>ident(typeof e==='string'?e:e.source)!==ident(source));
  fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2)); console.log('UI_E2E_PI_PACKAGE_'+action.toUpperCase()+':'+source); process.exit(0);
}
let buffer='';
let sessionName='UI E2E Session';
let autoRetryEnabled=true;
const user={id:'user-1',parentId:null,type:'message',message:{role:'user',content:[{type:'text',text:'Inspect the project'}]},children:[]};
const assistant={id:'assistant-1',parentId:'user-1',type:'message',message:{role:'assistant',content:[{type:'text',text:'Project inspected.'}]},children:[]}; user.children=[assistant];
const liveTree={entry:user,children:[{entry:assistant,children:[]}]};
const argValue=(flag)=>{const index=argv.indexOf(flag);return index>=0?String(argv[index+1]||''):'';};
let activeProvider=argValue('--provider')||'ollama';
let activeModel=argValue('--model')||'fake-model';
const sessionDir=argValue('--session-dir');
const requestedSession=argValue('--session');
const sessionFile=requestedSession||(sessionDir?path.join(sessionDir,'ui-e2e-session.jsonl'):null);
if(process.env.UI_E2E_FAKE_PI_TRACE){
  fs.appendFileSync(process.env.UI_E2E_FAKE_PI_TRACE,JSON.stringify({argv,cwd:process.cwd(),sessionDir,requestedSession,sessionFile})+'\n');
}
if(sessionFile&&!fs.existsSync(sessionFile)){
  fs.mkdirSync(path.dirname(sessionFile),{recursive:true});
  const header={type:'session_header',id:'ui-e2e',name:'UI E2E Session',cwd:process.cwd(),version:3};
  fs.writeFileSync(sessionFile,[header,user,assistant].map((entry)=>JSON.stringify(entry)).join('\n')+'\n');
}
function response(cmd,data={}) { console.log(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data})); }
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){ const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(!line.trim())continue; const cmd=JSON.parse(line);
  if(process.env.UI_E2E_FAKE_PI_TRACE) fs.appendFileSync(process.env.UI_E2E_FAKE_PI_TRACE,JSON.stringify({command:cmd.type,message:cmd.message||'',name:cmd.name||'',mode:cmd.mode||''})+'\n');
  if(cmd.type==='get_state') response(cmd,{sessionId:sessionFile?path.basename(sessionFile,'.jsonl'):'ui-e2e',sessionFile,sessionName,isStreaming:false,thinkingLevel:'medium',model:{provider:activeProvider,id:activeModel},steeringMode:'one-at-a-time',followUpMode:'one-at-a-time',autoCompactionEnabled:true,autoRetryEnabled});
  else if(cmd.type==='get_session_stats') response(cmd,{sessionId:'ui-e2e',messageCount:2,inputTokens:1200,outputTokens:240,totalTokens:1440,contextTokens:1440,contextWindow:65536});
  else if(cmd.type==='get_available_thinking_levels') response(cmd,{levels:['off','low','medium','high']});
  else if(cmd.type==='get_messages') response(cmd,{messages:[user.message,assistant.message]});
  else if(cmd.type==='get_entries') response(cmd,{entries:[user,assistant]});
  else if(cmd.type==='get_tree') response(cmd,{tree:[liveTree]});
  else if(cmd.type==='get_commands') response(cmd,{commands:[{name:'code-review',description:'Review current code',source:'skill'},{name:'fix-tests',description:'Fix failed tests',source:'prompt'}]});
  else if(cmd.type==='prompt'){ response(cmd,{}); console.log(JSON.stringify({type:'agent_start'})); setTimeout(()=>{ assistant.message.content[0].text='E2E agent response'; console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'E2E agent response'}})); console.log(JSON.stringify({type:'agent_settled'})); },1500); }
  else if(cmd.type==='set_session_name'){ sessionName=String(cmd.name||sessionName); if(sessionFile)fs.appendFileSync(sessionFile,JSON.stringify({type:'session_info',name:sessionName})+'\n'); response(cmd,{}); }
  else if(cmd.type==='set_model'){ activeProvider=String(cmd.provider||'ollama'); activeModel=String(cmd.modelId||activeModel); response(cmd,{}); }
  else if(cmd.type==='set_auto_retry'){ autoRetryEnabled=cmd.enabled!==false; response(cmd,{}); }
  else if(cmd.type==='compact') response(cmd,{summary:'UI E2E compacted context',tokensBefore:1440,tokensAfter:720});
  else if(cmd.type==='bash') response(cmd,{output:'UI_E2E_PI_BASH_OK'});
  else response(cmd,{});
}});
`;


async function createFakeOllama({ modelName = 'fake-coder:latest', loaded = false, version = '0.30.9-e2e' } = {}) {
  const requests = [];
  const models = new Set([modelName]);
  const loadedModels = new Set(loaded ? [modelName] : []);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', payload });
    if (req.headers.authorization !== 'Bearer ui-e2e-secret') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/version') return res.end(JSON.stringify({ version }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [...models].map((name) => ({ name, model: name, size: 123456789, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } })) }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [...loadedModels].map((name) => ({ name, model: name, size: 123456789, size_vram: 98765432, context_length: 65536 })) }));
    if (req.method === 'POST' && req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.parameter_count': 7000000000 }, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools'], parameters: 'num_ctx 65536\ntemperature 0.2' }));
    if (req.method === 'POST' && req.url === '/api/pull') {
      const name = String(payload?.model || '').trim();
      if (name) models.add(name);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return res.end(`${JSON.stringify({ status: 'pulling manifest' })}\n${JSON.stringify({ status: 'success' })}\n`);
    }
    if (req.method === 'POST' && req.url === '/api/create') {
      const name = String(payload?.model || '').trim();
      if (name) models.add(name);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return res.end(`${JSON.stringify({ status: 'creating model layer' })}\n${JSON.stringify({ status: 'success' })}\n`);
    }
    if (req.method === 'POST' && req.url === '/api/generate') {
      const name = String(payload?.model || '').trim();
      if (payload?.keep_alive === 0) loadedModels.delete(name);
      else if (name) loadedModels.add(name);
      return res.end(JSON.stringify({ done: true, response: '' }));
    }
    if (req.method === 'DELETE' && req.url === '/api/delete') {
      const name = String(payload?.model || '').trim();
      models.delete(name); loadedModels.delete(name);
      return res.end(JSON.stringify({ status: 'success' }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    models,
    loadedModels,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}


async function createFakeProvider() {
  const captures=[];
  const server=http.createServer(async(req,res)=>{
    let body=''; for await (const c of req) body+=c;
    captures.push({url:req.url,body:body?JSON.parse(body):null,authorization:req.headers.authorization||''});
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models') return res.end(JSON.stringify({data:[{id:'ui-provider-model',name:'UI Provider Model',context_window:32768,max_output_tokens:4096,input:['text'],reasoning:false}]}));
    if(req.url==='/v1/responses') return res.end(JSON.stringify({id:'resp-e2e',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}));
    if(req.url==='/v1/chat/completions') return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}]}));
    res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); return {server,captures,url:`http://127.0.0.1:${address.port}`,close:()=>new Promise((resolve)=>server.close(resolve))};
}

async function createFakeTts() {
  const captures = [];
  let loaded = false;
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(0, 40);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    captures.push({ method: req.method, url: req.url, payload });
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ loaded, model: 'qwen3-tts-e2e' }));
    }
    if (req.method === 'POST' && req.url === '/api/model/wake') {
      const alreadyLoaded = loaded;
      loaded = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: alreadyLoaded ? 'already_loaded' : 'loaded' }));
    }
    if (req.method === 'POST' && req.url === '/api/model/sleep') {
      loaded = false;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'unloaded' }));
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      loaded = true;
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
      return res.end(wav);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    server,
    captures,
    url: `http://127.0.0.1:${address.port}`,
    isLoaded: () => loaded,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function createFakeMcp() {
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    let body=''; for await (const c of req) body+=c; const msg=JSON.parse(body||'{}'); seen.push({method:msg.method,params:msg.params});
    let result={};
    if(msg.method==='tools/list') result={tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
    else if(msg.method==='resources/list') result={resources:[{uri:'memory://ui',name:'UI Resource'}]};
    else if(msg.method==='prompts/list') result={prompts:[{name:'ui-prompt',description:'UI Prompt'}]};
    else if(msg.method==='tools/call') result={content:[{type:'text',text:'echo:'+String(msg.params?.arguments?.text||'')}]};
    else if(msg.method==='resources/read') result={contents:[{uri:msg.params?.uri||'',text:'RESOURCE_UI_OK'}]};
    else if(msg.method==='prompts/get') result={description:'UI Prompt',messages:[{role:'user',content:{type:'text',text:'PROMPT_UI_OK:'+String(msg.params?.arguments?.topic||'')}}]};
    else if(msg.method==='initialize') result={protocolVersion:'2026-07-28',capabilities:{tools:{},resources:{},prompts:{}}};
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); return {server,seen,url:`http://127.0.0.1:${address.port}/mcp`,close:()=>new Promise((resolve)=>server.close(resolve))};
}

async function createFakePackageRegistry() {
  const requests = [];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    res.setHeader('content-type','application/json');
    if(req.url?.startsWith('/-/v1/search')) return res.end(JSON.stringify({objects:[{package:{name:'ui-e2e-market-package',version:'2.0.0',description:'UI E2E marketplace package',keywords:['pi-package']}}]}));
    if(req.url==='/ui-e2e-market-package') return res.end(JSON.stringify({'dist-tags':{latest:'2.0.0'},versions:{'1.0.0':{name:'ui-e2e-market-package',version:'1.0.0',keywords:['pi-package'],pi:{extensions:['extensions/*.ts']},dist:{integrity:'sha512-old-integrity',shasum:'oldsha'}},'2.0.0':{name:'ui-e2e-market-package',version:'2.0.0',description:'UI E2E marketplace package',keywords:['pi-package'],pi:{extensions:['extensions/*.ts'],skills:['skills/**']},scripts:{postinstall:'node setup.js'},dependencies:{dep:'1.0.0'},repository:{url:'https://example.invalid/ui-e2e-market-package.git'},dist:{integrity:'sha512-latest-integrity',shasum:'latestsha'}}}}));
    res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); return {server,url:`http://127.0.0.1:${address.port}`,requests,close:()=>new Promise((resolve)=>server.close(resolve))};
}

async function createFixture(root) {
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }, null, 2));
  await fs.writeFile(path.join(workspace, 'src', 'util.ts'), 'export function greet(name: string) { return name.toUpperCase(); }\n');
  const initial = 'import { greet } from "./util";\nconst message = greet("world");\nconsole.log(message);\n';
  await fs.writeFile(path.join(workspace, 'src', 'main.ts'), initial);
  await fs.writeFile(path.join(workspace, 'main.py'), 'def greet(name: str) -> str:\n    return name.upper()\n\nvalue: str = 42\n');
  await fs.writeFile(path.join(workspace, 'index.html'), '<html><body><main>Hello</main></body></html>\n');
  await fs.mkdir(path.join(workspace, '.pi', 'extensions'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.pi', 'extensions', 'ui-e2e-extension.mjs'), 'export default function uiE2EExtension() {}\n');
  await fs.writeFile(path.join(workspace, '.pi', 'settings.json'), JSON.stringify({ packages: ['npm:ui-e2e-package'] }, null, 2));
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node test-runner.mjs', dev: 'node src/dev.mjs' } }, null, 2));
  await fs.writeFile(path.join(workspace, 'test-runner.mjs'), "console.log('UI_TEST_EXPLORER_OK');\n");
  await fs.writeFile(path.join(workspace, 'preview-content.txt'), 'PREVIEW_UI_V1');
  await fs.writeFile(path.join(workspace, 'preview-server.mjs'), `import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; const file=path.join(process.cwd(),'preview-content.txt'); const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><body><main>'+fs.readFileSync(file,'utf8')+'</main></body></html>')}); server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));`);
  await fs.writeFile(path.join(workspace, 'test', 'basic.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('basic',()=>assert.equal(2+2,4));\n");
  const metacharPackage = path.join(workspace, 'local & echo UI_E2E_INJECTED');
  await fs.mkdir(metacharPackage, { recursive: true });
  await fs.writeFile(path.join(metacharPackage, 'package.json'), JSON.stringify({ name: 'ui-e2e-metachar-package', version: '1.0.0', pi: { extensions: [] } }, null, 2));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Pi Studio E2E'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'e2e@example.invalid'], { cwd: workspace });
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: workspace });
  const modified = 'import { greet } from "./util";\nconst message = greet("world");\nconst broken: string = 42;\nconsole.log(message, broken);\n';
  await fs.writeFile(path.join(workspace, 'src', 'main.ts'), modified);
  return workspace;
}

async function createPlainFixture(root) {
  const workspace = path.join(root, 'plain-workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'app.js'), 'console.log("plain workspace");\n');
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=ignored-by-default\n');
  return workspace;
}

async function createFakePi(root) {
  const script = path.join(root, 'fake-pi.mjs');
  await fs.writeFile(script, fakePiSource);
  const wrapper = path.join(root, process.platform === 'win32' ? 'fake-pi.cmd' : 'fake-pi');
  if (process.platform === 'win32') await fs.writeFile(wrapper, `@"${process.execPath}" "${script}" %*\r\n`);
  else { await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); await fs.chmod(wrapper, 0o755); }
  return wrapper;
}

async function waitForServer(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error(`Studio server exited early with code ${child.exitCode}`);
    try { const res = await fetch(`${url}/api/bootstrap`); if (res.ok) return; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('Studio server did not become ready');
}

function browserExecutable() {
  const explicit = process.env.PI_STUDIO_CHROMIUM || process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-ui-e2e-'));
const workspace = await createFixture(root);
const plainWorkspace = await createPlainFixture(root);
const fakePi = await createFakePi(root);
const fakeOllama = await createFakeOllama({ modelName: 'fake-coder:latest', loaded: false, version: '0.30.9-e2e' });
const fakeOllamaB = await createFakeOllama({ modelName: 'runtime-b-coder:latest', loaded: true, version: '0.31.0-e2e-b' });
const fakeProvider = await createFakeProvider();
const fakeTts = await createFakeTts();
const fakeMcp = await createFakeMcp();
const fakePackageRegistry = await createFakePackageRegistry();
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const studioDataDir = path.join(root, 'studio-data');
await fs.mkdir(studioDataDir, { recursive: true });
// Seed runtime A as persisted configuration. Do not use OLLAMA_BASE_URL or
// PI_STUDIO_OLLAMA_* launch overrides here: those are intentionally
// authoritative and would make the A→B UI switch impossible by design.
await fs.writeFile(path.join(studioDataDir, 'runtime.json'), JSON.stringify({
  ollamaBaseUrl: fakeOllama.url,
  ollamaApiKeyEnv: 'UI_E2E_OLLAMA_KEY',
  ollamaRuntimeKind: 'lan',
  ollamaRuntimeName: 'UI E2E Remote'
}, null, 2));
const serverLogs = [];
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: APP_ROOT,
  env: { ...process.env, STUDIO_PORT: String(port), STUDIO_BIND_HOST: '127.0.0.1', PI_OLLAMA_STUDIO_DIR: studioDataDir, PI_CODING_AGENT_DIR: path.join(root, 'pi-agent'), PI_COMMAND: fakePi, UI_E2E_FAKE_PI_TRACE: path.join(root, 'fake-pi-launch.jsonl'), UI_E2E_OLLAMA_KEY: 'ui-e2e-secret', PI_SKIP_VERSION_CHECK: '1', UI_E2E_PROVIDER_KEY: 'provider-secret', PI_STUDIO_PI_PACKAGE_REGISTRY: fakePackageRegistry.url },
  stdio: ['ignore','pipe','pipe']
});
server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));
let browser;
let page;
const pageErrors = [];
const browserConsole = [];
const networkErrors = [];
const expectedNetworkAborts = [];
const expectedNetworkAbortWindows = [];
const httpErrors = [];
const expectedHttpErrors = [];
const backendSnapshots = [];
try {
  await waitForServer(url, server);
  const executablePath = browserExecutable();
  check(executablePath, 'No Chromium/Chrome/Edge executable was found for UI E2E');
  const headed = /^(1|true|yes)$/i.test(String(process.env.UI_E2E_HEADED || process.env.HEADED || ''));
  const slowMo = Number(process.env.UI_E2E_SLOW_MO || 0) || 0;
  const artifactsDir = path.resolve(process.env.UI_E2E_ARTIFACTS || path.join(APP_ROOT, 'artifacts', 'ui-e2e'));
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.rm(path.join(artifactsDir, 'failure.png'), { force: true });
  browser = await chromium.launch({ headless: !headed, slowMo, executablePath, args: ['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--proxy-bypass-list=*'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  const capture = async (name) => {
    if (!headed && !/^(1|true|yes)$/i.test(String(process.env.UI_E2E_SCREENSHOTS || ''))) return;
    await page.screenshot({ path: path.join(artifactsDir, `${name}.png`), fullPage: true });
  };
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    browserConsole.push(entry);
    if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText || 'request failed';
    const entry = `${request.method()} ${request.url()} :: ${errorText}`;
    const expected = expectedNetworkAbortWindows.find((item) => item.remaining > 0
      && Date.now() <= item.until
      && request.method() === 'GET'
      && request.url() === item.url
      && errorText === 'net::ERR_ABORTED');
    if (expected) {
      expected.remaining -= 1;
      expectedNetworkAborts.push(`${entry} :: expected during ${expected.reason}`);
      return;
    }
    networkErrors.push(entry);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const expected = expectedHttpErrors.find((item) => !item.seen && item.method === response.request().method() && item.pathname === pathname && item.status === response.status());
    if (expected) expected.seen = true;
    else httpErrors.push(`${response.request().method()} ${response.url()} :: HTTP ${response.status()}`);
  });
  const captureBackend = async (label) => {
    try {
      const snapshot = await page.evaluate(async () => {
        const value = await (await fetch('/api/status')).json();
        const piStatus = value.pi?.status || {};
        return {
          pi: { running: Boolean(value.pi?.running ?? piStatus.running), workspace: value.pi?.workspace || piStatus.workspace || '', model: value.pi?.model || piStatus.modelId || '', status: piStatus },
          ollama: { online: Boolean(value.ollama?.online), baseUrl: value.ollama?.runtime?.baseUrl || '', running: (value.ollama?.running || []).map((item) => ({ name: item.name, sizeVram: item.size_vram, context: item.context_length })) },
          managedOllama: value.managedOllama || null
        };
      });
      backendSnapshots.push({ label, at: new Date().toISOString(), ...snapshot });
    } catch (error) {
      backendSnapshots.push({ label, at: new Date().toISOString(), error: String(error?.message || error) });
    }
  };
  const allowPreviewNavigationAbort = async (reason, maximum = 2) => {
    const urls = await page.evaluate(() => [...new Set([
      document.querySelector('#previewFrame')?.getAttribute('src'),
      document.querySelector('#editorPreviewFrame')?.getAttribute('src')
    ].filter((value) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(value || ''))))]);
    for (const previewUrl of urls) expectedNetworkAbortWindows.push({ url: previewUrl, reason, remaining: maximum, until: Date.now() + 5000 });
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (/ERR_BLOCKED_BY_ADMINISTRATOR/.test(String(error?.message || error))) {
      throw new Error('Chromium blocked localhost navigation by enterprise URL policy. Run npm run test:ui in a normal Chrome/Edge/Chromium environment without a global URLBlocklist.');
    }
    throw error;
  }
  await page.waitForFunction(() => ['ready','fallback'].includes(document.documentElement.dataset.monacoState), null, { timeout: 15000 });
  check(await page.evaluate(() => document.documentElement.dataset.monacoState) === 'ready', `Monaco failed to initialize: ${await page.evaluate(() => document.documentElement.dataset.monacoError || '')}`);
  await captureBackend('boot');
  await capture('01-boot');


  // Remote Ollama runtime UX: test an unsaved LAN/IP-style profile with bearer auth.
  await page.click('[data-settings="runtime"]');
  await page.fill('#ollamaRuntimeName', 'LAN Ollama E2E');
  await page.selectOption('#ollamaRuntimeKind', 'lan');
  await page.fill('#ollamaBaseUrl', fakeOllama.url);
  await page.fill('#ollamaApiKeyEnv', 'UI_E2E_OLLAMA_KEY');
  await page.click('#testOllamaConnection');
  await page.waitForFunction(() => /connected/i.test(document.querySelector('#ollamaRuntimeStatus')?.textContent || ''), null, { timeout: 10000 });
  await page.waitForFunction(() => /Tested server/i.test(document.querySelector('#testedOllamaInventory')?.textContent || ''), null, { timeout: 10000 });
  check((await page.locator('#ollamaRuntimeStatus').textContent()).includes('0.30.9-e2e'), 'Remote Ollama Test Connection did not report fake runtime version');
  check((await page.locator('#testedOllamaInventory').textContent()).includes('fake-coder:latest'), `Test Connection did not show tested server installed models: ${await page.locator('#testedOllamaInventory').textContent()}`);
  check(await page.locator('#useTestedOllama').isDisabled(), 'Testing the already-active runtime incorrectly enabled Use this server');
  check((await page.locator('#useTestedOllama').textContent()).includes('Already active'), 'Already-active runtime was not labelled clearly');
  check((await page.locator('#activeOllamaInventory').textContent()).includes('fake-coder:latest'), 'Testing the active runtime lost its authoritative inventory');

  // Failed test of another endpoint must not poison the active runtime status/inventory.
  await page.fill('#ollamaBaseUrl', 'http://127.0.0.1:1');
  expectedHttpErrors.push({ method: 'POST', pathname: '/api/ollama/test', status: 502, seen: false });
  await page.click('#testOllamaConnection');
  await page.waitForFunction(() => /Test failed:/i.test(document.querySelector('#testedOllamaInventory')?.textContent || ''), null, { timeout: 10000 });
  check((await page.locator('#activeOllamaInventory').textContent()).includes('fake-coder:latest'), 'Failed runtime test cleared the active Runtime A inventory');
  check(/connected/i.test(await page.locator('#ollamaRuntimeStatus').textContent()), 'Failed runtime test incorrectly marked active Runtime A offline');
  await page.evaluate(() => document.querySelector('#toastHost')?.replaceChildren());
  await page.click('#saveRuntime');
  await page.waitForFunction(() => /Test the current Ollama connection settings/i.test(document.querySelector('#toastHost')?.textContent || ''), null, { timeout: 5000 });
  const rejectedRuntimeConfig = await page.evaluate(async () => (await (await fetch('/api/config')).json()).config || {});
  check(rejectedRuntimeConfig.ollamaBaseUrl.replace(/\/+$/, '') === fakeOllama.url, 'Save Runtime bypassed Test → Use and replaced the active endpoint');

  // Runtime transition A -> B: tested inventory and active inventory must move together; old models must disappear.
  await page.fill('#ollamaRuntimeName', 'Runtime B E2E');
  await page.fill('#ollamaBaseUrl', fakeOllamaB.url);
  check((await page.inputValue('#ollamaBaseUrl')).replace(/\/+$/, '') === fakeOllamaB.url, `Runtime B URL field was not set before Test Connection: ${await page.inputValue('#ollamaBaseUrl')}`);
  await page.click('#testOllamaConnection');
  await page.waitForFunction(() => {
    const text = document.querySelector('#testedOllamaInventory')?.textContent || '';
    return text.includes('runtime-b-coder:latest') || /Test failed:/i.test(text);
  }, null, { timeout: 10000 });
  check((await page.locator('#testedOllamaInventory').textContent()).includes('runtime-b-coder:latest'), `Runtime B Test Connection did not show its inventory: ${await page.locator('#testedOllamaInventory').textContent()} Requests: ${JSON.stringify(fakeOllamaB.requests)} Server logs: ${serverLogs.join('')}`);
  check(!(await page.locator('#testedOllamaInventory').textContent()).includes('fake-coder:latest'), 'Tested Runtime B inventory still shows Runtime A models');
  check((await page.locator('#testedOllamaInventory').textContent()).includes('Loaded now: runtime-b-coder:latest'), 'Runtime B loaded-model inventory was not shown');
  check((await page.locator('#activeOllamaInventory').textContent()).includes('fake-coder:latest'), 'Testing Runtime B incorrectly changed the active Runtime A inventory before Use this server');
  check(!(await page.locator('#activeOllamaInventory').textContent()).includes('runtime-b-coder:latest'), 'Testing Runtime B leaked its models into the active runtime inventory');
  await page.evaluate(() => document.querySelector('#toastHost')?.replaceChildren());
  await page.click('#useTestedOllama');
  await page.waitForFunction(() => /Ollama runtime switched|Runtime settings saved/i.test(document.querySelector('#toastHost')?.textContent || ''), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#activeOllamaInventory')?.textContent?.includes('runtime-b-coder:latest'), null, { timeout: 10000 });
  check(!(await page.locator('#activeOllamaInventory').textContent()).includes('fake-coder:latest'), 'Active Runtime B inventory still shows Runtime A models');
  check((await page.locator('#modelLibrary').textContent()).includes('runtime-b-coder:latest'), 'Model library did not switch to Runtime B');
  check(!(await page.locator('#modelLibrary').textContent()).includes('fake-coder:latest'), 'Model library retained Runtime A model after switching to Runtime B');
  check(await page.locator('#topModel').inputValue() === 'runtime-b-coder:latest', 'Active model selector did not replace stale Runtime A selection with Runtime B model');
  const runtimeBConfig = await page.evaluate(async () => (await (await fetch('/api/config')).json()).config || {});
  check(runtimeBConfig.defaultModel === 'runtime-b-coder:latest', `Runtime B model selection did not persist as backend defaultModel: ${JSON.stringify({ defaultModel: runtimeBConfig.defaultModel, selected: await page.locator('#topModel').inputValue(), active: await page.locator('#activeOllamaInventory').textContent() })}`);
  await captureBackend('ollama-runtime-b-active');

  // Model Library against the active remote runtime: memory diagnostics,
  // explicit unload, pull, select/persist, and delete all use Runtime B.
  await page.click('[data-settings="model"]');
  await page.click('#diagnoseModel');
  await page.waitForFunction(() => !['', '—'].includes((document.querySelector('#kvEstimate')?.textContent || '').trim()), null, { timeout: 10000 });
  await page.click('#unloadModel');
  await poll(() => Promise.resolve([...fakeOllamaB.loadedModels]), (models) => models.length === 0, { timeoutMs: 10000, label: 'remote Ollama model unload' });
  await page.fill('#pullModelName', 'ui-pulled:latest');
  await page.click('#pullModel');
  await page.waitForFunction(() => document.querySelector('#modelLibrary')?.textContent?.includes('ui-pulled:latest'), null, { timeout: 10000 });
  check(fakeOllamaB.models.has('ui-pulled:latest'), 'Remote Ollama pull did not reach the active Runtime B server');
  const pulledModelCard = page.locator('#modelLibrary .model-item').filter({ hasText: 'ui-pulled:latest' }).first();
  await pulledModelCard.locator('[data-use]').click();
  await page.waitForFunction(() => document.querySelector('#topModel')?.value === 'ui-pulled:latest', null, { timeout: 10000 });
  const pulledConfig = await page.evaluate(async () => (await (await fetch('/api/config')).json()).config || {});
  check(pulledConfig.defaultModel === 'ui-pulled:latest', 'Model Library Use did not persist the selected remote model');
  page.once('dialog', (dialog) => dialog.accept());
  await pulledModelCard.locator('[data-delete]').click();
  await page.waitForFunction(() => !document.querySelector('#modelLibrary')?.textContent?.includes('ui-pulled:latest'), null, { timeout: 10000 });
  check(!fakeOllamaB.models.has('ui-pulled:latest'), 'Remote Ollama delete did not remove the model from Runtime B');
  check(await page.locator('#topModel').inputValue() === 'runtime-b-coder:latest', 'Deleting the selected model did not recover to an installed Runtime B model');
  await captureBackend('remote-model-library-lifecycle');
  await capture('13-remote-model-library-lifecycle');

  // Normal user workflow: create a new plain HTML project from the Project UI,
  // choose its parent folder, open it, and handle Git onboarding explicitly.
  await page.click('#newProject');
  await page.locator('#projectWizardModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#projectWizardName', 'ui-created-html');
  await page.fill('#projectWizardParent', root);
  await page.selectOption('#projectWizardTemplate', 'html');
  await page.click('#projectWizardCreate');
  await page.locator('#projectWizardModal').waitFor({ state: 'hidden', timeout: 15000 });
  const uiCreatedWorkspace = path.join(root, 'ui-created-html');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'visible', timeout: 10000 });
  check((await page.locator('#gitInitWorkspace').textContent()).toLowerCase().includes('ui-created-html'), 'New Project UI did not open Git onboarding for the created folder');
  await page.click('#gitInitWithout');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'hidden', timeout: 10000 });
  await page.waitForFunction((expected) => String(document.querySelector('#workspacePath')?.value || '').toLowerCase() === expected.toLowerCase(), uiCreatedWorkspace, { timeout: 15000 });
  await page.locator('.tree-row[data-path="index.html"]').waitFor({ state: 'visible', timeout: 15000 });
  for (const file of ['index.html', 'styles.css', 'script.js']) check(existsSync(path.join(uiCreatedWorkspace, file)), `New Project UI did not create ${file}`);
  check((await page.locator('#fileTree').textContent()).includes('index.html'), 'New Project UI did not open the created HTML workspace');
  await captureBackend('new-project-created');
  await capture('07-new-project');

  // The Plain HTML template must be previewable with no npm/Python setup.
  await page.click('[data-view="preview"]');
  await page.waitForFunction(() => /static-preview\.mjs/i.test(document.querySelector('#previewCommand')?.value || ''), null, { timeout: 10000 });
  await page.click('#previewStart');
  await page.waitForFunction(() => document.querySelector('#previewStatus')?.textContent?.includes('running') && String(document.querySelector('#previewFrame')?.getAttribute('src') || '').startsWith('http://127.0.0.1:'), null, { timeout: 15000 });
  const staticPreview = page.frameLocator('#previewFrame');
  await staticPreview.locator('h1').waitFor({ state: 'visible', timeout: 15000 });
  check((await staticPreview.locator('h1').textContent()).includes('ui-created-html'), 'Built-in static Preview did not render the New Project HTML template');
  await captureBackend('plain-html-static-preview');
  await capture('12-plain-html-static-preview');
  await allowPreviewNavigationAbort('plain HTML Preview stop');
  await page.click('#previewStop');
  await page.waitForFunction(() => /stopped/i.test(document.querySelector('#previewStatus')?.textContent || ''), null, { timeout: 10000 });

  // Git onboarding: opening a plain folder should offer initialization rather than fail.
  await page.fill('#workspacePath', plainWorkspace);
  await page.click('#applyWorkspace');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'visible', timeout: 10000 });
  check((await page.locator('#gitInitStatus').textContent()).includes('prompt checkpoints'), 'Git onboarding did not explain checkpoint/worktree benefits');
  await page.click('#gitInitConfirm');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('.tree-row[data-path="src/app.js"]').waitFor({ state: 'visible', timeout: 10000 });
  check((await page.locator('#gitSummary').textContent()).includes('main'), 'Initialized Git repository did not report the main branch');
  const gitCheck = execFileSync('git', ['status', '--porcelain=v1', '-b'], { cwd: plainWorkspace, encoding: 'utf8' });
  check(gitCheck.startsWith('## main'), 'UI Git onboarding did not create a usable main branch repository');
  const plainTerminalId = await page.evaluate(async (workspace) => { const value = await (await fetch('/api/terminal/create', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({workspace,name:'Plain workspace terminal'}) })).json(); return value.session?.id || null; }, plainWorkspace);
  check(plainTerminalId, 'Failed to create old-workspace terminal for transition test');

  // Standard mouse workflow: switch to the committed fixture and verify old workspace-owned state disappears.
  await page.fill('#workspacePath', workspace);
  await page.click('#applyWorkspace');
  await page.locator(`.tree-row[data-path="src/main.ts"]`).waitFor({ state: 'visible', timeout: 10000 });
  const activeWorkspacePath = await page.inputValue('#workspacePath');
  const expectedWorkspacePath = process.platform === 'win32' ? path.resolve(workspace).toLowerCase() : path.resolve(workspace);
  check((process.platform === 'win32' ? path.resolve(activeWorkspacePath).toLowerCase() : path.resolve(activeWorkspacePath)) === expectedWorkspacePath, `Workspace path did not switch to workspace B: expected ${workspace}, got ${activeWorkspacePath}`);
  const postSwitchSessions = await page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()).sessions || []);
  check(!postSwitchSessions.some((item) => item.id === plainTerminalId), 'Old workspace terminal survived workspace switch');
  check(!(await page.locator('#fileTree').textContent()).includes('app.js'), 'Old workspace file tree content survived workspace switch');

  // Project Manager: reopen a real recent project, prove the workspace-owned
  // UI moves to it, then return to the fixture. This catches a regression where
  // the remove-from-recent handler overwrote the main Open handler.
  await page.click('#openProjectManager');
  await page.locator('#projectManagerModal').waitFor({ state: 'visible', timeout: 10000 });
  const plainRecent = page.locator('#recentProjectList .recent-project-row').filter({ hasText: 'plain-workspace' });
  check(await plainRecent.count() === 1, 'Project Manager did not remember the previously opened plain workspace');
  await plainRecent.locator('.recent-project-main').click();
  await page.waitForFunction((expected) => String(document.querySelector('#workspacePath')?.value || '').toLowerCase() === expected.toLowerCase(), plainWorkspace, { timeout: 15000 });
  await page.locator('.tree-row[data-path="src/app.js"]').waitFor({ state: 'visible', timeout: 10000 });
  check(!(await page.locator('#fileTree').textContent()).includes('main.ts'), 'Opening a recent project retained the previous project file tree');

  await page.click('#openProjectManager');
  await page.locator('#projectManagerModal').waitFor({ state: 'visible', timeout: 10000 });
  const fixtureRecent = page.locator('#recentProjectList .recent-project-row').filter({ hasText: workspace });
  check(await fixtureRecent.count() === 1, 'Project Manager did not retain the committed fixture as a recent project');
  await fixtureRecent.locator('.recent-project-main').click();
  await page.waitForFunction((expected) => String(document.querySelector('#workspacePath')?.value || '').toLowerCase() === expected.toLowerCase(), workspace, { timeout: 15000 });
  await page.locator('.tree-row[data-path="src/main.ts"]').waitFor({ state: 'visible', timeout: 10000 });
  check(!(await page.locator('#fileTree').textContent()).includes('app.js'), 'Returning through Recent Projects retained stale files from the other workspace');
  await captureBackend('recent-project-round-trip');
  await capture('10-recent-project-round-trip');

  await page.click(`.tree-row[data-path="src/main.ts"]`);
  await page.locator('.buffer-tab', { hasText: 'main.ts' }).waitFor({ state: 'visible' });
  check(await page.locator('#monacoEditorPrimary').isVisible(), 'Primary Monaco editor is not visible');

  // Mouse caret regression: clicking another Monaco line must move the real caret there.
  const primaryLines = page.locator('#monacoEditorPrimary .view-lines .view-line');
  await primaryLines.nth(3).waitFor({ state: 'visible', timeout: 10000 });
  await primaryLines.nth(3).click();
  await page.keyboard.type('/*MOUSE_CURSOR_E2E*/');
  const mouseEditedValue = await page.evaluate(() => {
    const model = window.monaco?.editor?.getModels?.().find((item) => /\/src\/main\.ts$/.test(item.uri.path));
    return model?.getValue?.() || '';
  });
  check((mouseEditedValue.split(/\r?\n/)[3] || '').includes('MOUSE_CURSOR_E2E'), 'Mouse click did not move Monaco caret to the clicked fourth line');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => {
    const model = window.monaco?.editor?.getModels?.().find((item) => /\/src\/main\.ts$/.test(item.uri.path));
    return model && !model.getValue().includes('MOUSE_CURSOR_E2E');
  });

  // External-edit conflict regression: a stale dirty Monaco buffer must never silently overwrite a newer disk/agent edit.
  const fixtureBeforeExternalEdit = await fs.readFile(path.join(workspace, 'src', 'main.ts'), 'utf8');
  await primaryLines.nth(1).click();
  await page.keyboard.type('/*LOCAL_UNSAVED_E2E*/');
  await sleep(30);
  const externalDiskContent = `${fixtureBeforeExternalEdit}\n// EXTERNAL_AGENT_EDIT_E2E\n`;
  await fs.writeFile(path.join(workspace, 'src', 'main.ts'), externalDiskContent);
  page.once('dialog', async (dialog) => {
    check(/changed on disk/i.test(dialog.message()), 'Stale-save dialog did not explain the disk conflict');
    await dialog.dismiss();
  });
  expectedHttpErrors.push({ method: 'PUT', pathname: '/api/workspace/file', status: 409, seen: false });
  await page.click('#saveFile');
  await sleep(100);
  check((await fs.readFile(path.join(workspace, 'src', 'main.ts'), 'utf8')).includes('EXTERNAL_AGENT_EDIT_E2E'), 'Canceled stale save overwrote the newer disk version');
  const dirtyConflictValue = await page.evaluate(() => window.monaco?.editor?.getModels?.().find((item) => /\/src\/main\.ts$/.test(item.uri.path))?.getValue?.() || '');
  check(dirtyConflictValue.includes('LOCAL_UNSAVED_E2E'), 'Dirty editor content was lost during an external-file conflict');
  await page.locator('.buffer-tab [title="Changed on disk"]').waitFor({ state: 'visible', timeout: 3000 });

  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#reloadFile');
  await page.waitForFunction(() => window.monaco?.editor?.getModels?.().some((item) => /\/src\/main\.ts$/.test(item.uri.path) && item.getValue().includes('EXTERNAL_AGENT_EDIT_E2E')));
  await fs.writeFile(path.join(workspace, 'src', 'main.ts'), fixtureBeforeExternalEdit);
  await page.click('#reloadFile');
  await page.waitForFunction((expected) => window.monaco?.editor?.getModels?.().some((item) => /\/src\/main\.ts$/.test(item.uri.path) && item.getValue() === expected), fixtureBeforeExternalEdit);

  // Pi Platform manager works without Pi running: create a project prompt and AGENTS.md through normal mouse UI.
  await page.click('[data-view="resources"]');
  await page.waitForFunction(() => document.querySelector('#platformOverview')?.textContent?.includes('Known persistent agent inputs'), null, { timeout: 10000 });
  await page.click('[data-platform-tab="prompts"]');
  await page.fill('#platformNewName', 'ui-review');
  await page.click('[data-new-platform="prompt-project"]');
  await page.fill('#platformEditor', '---\ndescription: UI review prompt\n---\n\nReview the current UI changes.\n');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('[data-platform-tab="instructions"]');
  check(await page.locator('[data-platform-tab="prompts"]').evaluate((node) => node.classList.contains('active')), 'Canceling discard did not keep the dirty Pi resource tab active');
  check((await page.inputValue('#platformEditor')).includes('Review the current UI changes'), 'Canceling discard lost the dirty Pi resource editor content');
  await page.locator('#platformDetailActions').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#platformList')?.textContent?.includes('ui-review'), null, { timeout: 10000 });
  check((await fs.readFile(path.join(workspace, '.pi', 'prompts', 'ui-review.md'), 'utf8')).includes('UI review prompt'), 'Pi Platform prompt editor did not persist the project prompt');
  await page.click('[data-platform-tab="instructions"]');
  await page.click('[data-new-platform="context-project"]');
  await page.fill('#platformEditor', '# UI E2E Agent Guidelines\n\n- Always run tests.\n');
  await page.locator('#platformDetailActions').getByRole('button', { name: 'Save', exact: true }).click();
  await poll(
    () => fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8').catch(() => ''),
    (text) => text.includes('Always run tests'),
    { timeoutMs: 10000, label: 'Pi Platform instruction editor AGENTS.md persistence' }
  );
  await page.click('[data-platform-tab="skills"]');
  await page.fill('#platformNewName', 'ui-e2e-skill');
  await page.click('[data-new-platform="skill-project"]');
  await page.fill('#platformEditor', '# UI E2E Skill\n\nRun the complete verification suite.\n');
  await page.locator('#platformDetailActions').getByRole('button', { name: 'Save', exact: true }).click();
  await poll(
    () => fs.readFile(path.join(workspace, '.pi', 'skills', 'ui-e2e-skill', 'SKILL.md'), 'utf8').catch(() => ''),
    (text) => text.includes('complete verification suite'),
    { timeoutMs: 10000, label: 'Pi Platform skill persistence' }
  );
  await page.click('[data-platform-tab="extensions"]');
  check((await page.locator('#platformList').textContent()).includes('ui-e2e-extension'), 'Extension Inspector did not render the project extension');
  await page.click('[data-platform-tab="packages"]');
  check((await page.locator('#platformList').textContent()).includes('npm:ui-e2e-package'), 'Package Inspector did not render project package configuration');
  await page.click('[data-platform-tab="settings"]');
  await page.locator('.platform-item').filter({ hasText: 'Project settings' }).first().click();
  check((await page.inputValue('#platformEditor')).trim().startsWith('{'), 'Project settings editor did not load JSON');

  // Reusable coding-harness workflow: build a bounded project harness from
  // the UI, persist its manifest, select it for the next session, and later
  // prove the exact tool allowlist reached the Pi process.
  await page.click('[data-settings="harness"]');
  await page.click('#harnessNew');
  await page.locator('#harnessBuilderModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#harnessBuilderName', 'UI Minimal Coder');
  await page.selectOption('#harnessBuilderScope', 'project');
  await page.selectOption('#harnessBuilderKind', 'coding');
  await page.fill('#harnessBuilderDescription', 'Bounded real-workflow harness created by the rendered E2E.');
  await page.evaluate(() => {
    const selected = new Set(['read', 'edit', 'bash']);
    for (const input of document.querySelectorAll('#harnessBuilderCoreTools input[type="checkbox"]')) input.checked = selected.has(input.value);
  });
  await page.fill('#harnessBuilderExtraTools', 'tts_speak');
  await page.fill('#harnessBuilderPrompt', 'Inspect first, make the smallest safe edit, then run the relevant tests.');
  const harnessSaveResponse = page.waitForResponse((response) => response.url().includes('/api/harnesses') && response.request().method() === 'POST', { timeout: 30000 });
  await page.click('#harnessBuilderSave');
  check((await harnessSaveResponse).ok(), 'Harness Builder save request failed');
  await page.locator('#harnessBuilderModal').waitFor({ state: 'hidden', timeout: 10000 });
  const harnessFile = path.join(workspace, '.pi', 'harnesses', 'ui-minimal-coder.json');
  const harnessManifest = await poll(() => fs.readFile(harnessFile, 'utf8').then(JSON.parse), (value) => value?.name === 'UI Minimal Coder', { timeoutMs: 10000, label: 'project harness manifest persistence' });
  check(JSON.stringify(harnessManifest.tools) === JSON.stringify(['read', 'edit', 'bash', 'tts_speak']), `Harness tool allowlist was not persisted exactly: ${JSON.stringify(harnessManifest.tools)}`);
  check(await page.locator('#topHarness').inputValue() === 'ui-minimal-coder', 'Saved harness was not selected for the next session');
  check((await page.locator('#harnessPresetList').textContent()).includes('UI Minimal Coder'), 'Saved harness did not appear in the Harness workbench');
  await capture('08-harness-builder');


  // v1.8 Providers: create, discover, probe, override, sync to Pi and verify disk persistence.
  await page.click('[data-settings="providers"]');
  await page.fill('#providerId','ui-provider');
  await page.fill('#providerName','UI Provider');
  await page.fill('#providerBaseUrl',fakeProvider.url);
  await page.fill('#providerApiKeyEnv','UI_E2E_PROVIDER_KEY');
  await page.selectOption('#providerApi','auto');
  await page.click('#saveProvider');
  await page.locator('[data-provider-id="ui-provider"]').waitFor({state:'visible',timeout:10000});
  await page.click('#refreshProviderModels');
  await page.locator('[data-provider-model="ui-provider-model"]').waitFor({state:'visible',timeout:10000});
  await page.evaluate(() => document.querySelector('#toastHost')?.replaceChildren());
  await page.click('[data-provider-probe="ui-provider-model"]');
  await page.waitForFunction(() => /Probed ui-provider-model/i.test(document.querySelector('#toastHost')?.textContent || ''), null, { timeout: 15000 });
  await page.fill('[data-provider-model="ui-provider-model"] [data-provider-field="contextWindow"]','65536');
  await page.fill('[data-provider-model="ui-provider-model"] [data-provider-field="maxTokens"]','15000');
  await page.selectOption('[data-provider-model="ui-provider-model"] [data-provider-field="reasoning"]','true');
  await page.selectOption('[data-provider-model="ui-provider-model"] [data-provider-field="vision"]','false');
  await page.click('[data-provider-save-model="ui-provider-model"]');
  await page.click('#syncProviderPi');
  const modelsPath = path.join(root, 'pi-agent', 'models.json');
  const modelsJson=await poll(()=>fs.readFile(modelsPath,'utf8').catch(()=>''),(text)=>text.includes('ui-provider-model'),{timeoutMs:10000,label:`provider models.json sync (${modelsPath})`});
  check(modelsJson.includes('65536') && modelsJson.includes('15000'), `Provider sync did not persist configured model limits: ${modelsJson}`);
  check(modelsJson.includes('$UI_E2E_PROVIDER_KEY'),'Provider sync did not preserve env-backed credential reference');
  check(!modelsJson.includes('provider-secret'),'Provider sync leaked the API key value');

  // v1.8 MCP: configure HTTP server, connect, inspect resources, change Pi exposure and verify persistence.
  await page.click('[data-settings="mcp"]');
  await page.fill('#mcpId','ui-mcp'); await page.fill('#mcpName','UI MCP'); await page.selectOption('#mcpTransport','http');
  await page.fill('#mcpUrl',fakeMcp.url); await page.fill('#mcpHeaders','{"X-Test":"literal-ui-value"}'); await page.check('#mcpExposeNew'); await page.click('#mcpSave');
  await page.locator('[data-mcp-server="ui-mcp"]').waitFor({state:'visible',timeout:10000}); await page.click('#mcpConnect');
  await page.waitForFunction(()=>document.querySelector('#mcpDetail')?.textContent?.includes('echo')&&document.querySelector('#mcpDetail')?.textContent?.includes('UI Resource'),null,{timeout:10000});
  await page.fill('#mcpManualArgs','{"text":"manual"}'); await page.click('[data-mcp-call-tool="echo"]');
  await page.waitForFunction(()=>document.querySelector('#mcpManualResult')?.textContent?.includes('echo:manual'),null,{timeout:10000});
  await page.click('[data-mcp-read-resource="memory://ui"]'); await page.waitForFunction(()=>document.querySelector('#mcpManualResult')?.textContent?.includes('RESOURCE_UI_OK'),null,{timeout:10000});
  await page.fill('#mcpManualArgs','{"topic":"testing"}'); await page.click('[data-mcp-get-prompt="ui-prompt"]'); await page.waitForFunction(()=>document.querySelector('#mcpManualResult')?.textContent?.includes('PROMPT_UI_OK:testing'),null,{timeout:10000});
  await page.uncheck('[data-mcp-tool="echo"]');
  const mcpConfig=await poll(()=>fs.readFile(path.join(root,'studio-data','mcp.json'),'utf8').then(JSON.parse).catch(()=>null),(value)=>Array.isArray(value?.servers)&&value.servers.some((server)=>server.id==='ui-mcp'&&server.disabledTools?.includes('echo')),{timeoutMs:10000,label:'MCP exposure persistence'});
  check(JSON.stringify(mcpConfig).includes('literal-ui-value'),'MCP config did not persist configured literal header locally');
  const mcpPublic=await page.evaluate(async()=>await (await fetch('/api/mcp')).json());
  check(JSON.stringify(mcpPublic).includes('literal-ui-value')===false,'MCP public API leaked a literal header value');
  await page.check('[data-mcp-tool="echo"]');

  // v1.8 online Pi marketplace: search, inspect trust metadata, pin an explicit version, install project-local, then disable extension loading.
  await page.click('[data-view="resources"]'); await page.click('[data-platform-tab="extensions"]'); await page.click('[data-browse-packages="extensions"]');
  await page.fill('#packageMarketQuery','market'); await page.click('#packageMarketSearch');
  await page.locator('[data-market-package="ui-e2e-market-package"]').waitFor({state:'visible',timeout:10000});
  check((await page.locator('#packageMarketDetail').textContent()).includes('Review before installing'),'Marketplace did not surface install risk');
  await page.selectOption('#packageMarketVersion','1.0.0');
  try {
    await poll(() => page.locator('#packageMarketDetail').textContent(), (text) => text.includes('Selected 1.0.0') && text.includes('integrity') && !text.includes('Runs install scripts'), { timeoutMs: 30000, label: 'selected package version detail' });
  } catch (error) {
    const direct = await page.evaluate(async () => (await (await fetch('/api/pi-packages/details?name=ui-e2e-market-package&version=1.0.0')).json()).package).catch((directError) => String(directError));
    throw new Error(`${error.message}; package detail: ${await page.locator('#packageMarketDetail').textContent()}; selected input: ${await page.locator('#packageMarketVersion').inputValue()}; direct: ${JSON.stringify(direct)}; registry requests: ${JSON.stringify(fakePackageRegistry.requests)}`);
  }
  check(!(await page.locator('#packageMarketDetail').textContent()).includes('Runs install scripts'),'Marketplace kept latest-version risk metadata after selecting an older version');
  await page.click('#installPackageProject');
  await poll(()=>fs.readFile(path.join(workspace,'.pi','settings.json'),'utf8').catch(()=>''),(text)=>text.includes('npm:ui-e2e-market-package@1.0.0'),{timeoutMs:10000,label:'pinned project package install'});
  await page.click('[data-platform-tab="packages"]');
  await page.locator('.platform-item').filter({hasText:'ui-e2e-market-package'}).first().click();
  await page.selectOption('[data-package-mode="extensions"]','none');
  const packageConfigResponse = page.waitForResponse((response) => response.url().includes('/api/pi-packages/config') && response.request().method() === 'PUT', { timeout: 30000 });
  await page.click('#applyPackageFilters');
  const packageConfigResult = await packageConfigResponse;
  check(packageConfigResult.ok(), `Package resource filter request failed with HTTP ${packageConfigResult.status()}: ${await packageConfigResult.text()}`);
  let packageSettings;
  try {
    packageSettings=await poll(()=>fs.readFile(path.join(workspace,'.pi','settings.json'),'utf8').then(JSON.parse),(value)=>Array.isArray(value.packages)&&value.packages.some((entry)=>typeof entry==='object'&&entry.source==='npm:ui-e2e-market-package@1.0.0'&&Array.isArray(entry.extensions)&&entry.extensions.length===0),{timeoutMs:30000,label:'package resource filter persistence'});
  } catch (error) {
    throw new Error(`${error.message}; settings=${await fs.readFile(path.join(workspace,'.pi','settings.json'),'utf8').catch(()=>'')}; note=${await page.locator('#platformDetailNote').textContent().catch(()=>'')}; toast=${await page.locator('#toastHost').textContent().catch(()=>'')}`);
  }
  check(packageSettings.packages.some((entry)=>typeof entry==='object'&&entry.source==='npm:ui-e2e-market-package@1.0.0'),'Pinned package was not retained after resource filtering');

  // Direct/local provenance inspection from the real marketplace UI.
  await page.click('[data-browse-packages=""]'); await page.fill('#packageDirectSource','.'); await page.selectOption('#packageDirectScope','project'); await page.click('#packageDirectInspect');
  await page.waitForFunction(()=>document.querySelector('#packageDirectProvenance')?.textContent?.includes('local')&&document.querySelector('#packageDirectProvenance')?.textContent?.includes('revision'),null,{timeout:10000});
  // Windows argv regression: a legitimate local package path containing '&' must reach Pi literally, never as cmd.exe syntax.
  const metacharSource='./local & echo UI_E2E_INJECTED'; await page.fill('#packageDirectSource',metacharSource); await page.click('#packageDirectInstall');
  await poll(()=>fs.readFile(path.join(workspace,'.pi','settings.json'),'utf8').then(JSON.parse),(value)=>Array.isArray(value.packages)&&value.packages.some((entry)=>String(typeof entry==='string'?entry:entry?.source||'')===metacharSource),{timeoutMs:10000,label:'literal metacharacter package source persistence'});

  // Universal resource search includes providers, MCP and Pi resources.
  await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+P':'Control+Shift+P'); await page.fill('#commandPaletteInput','ui-provider');
  await page.waitForFunction(()=>document.querySelector('#commandPaletteList')?.textContent?.includes('UI Provider'),null,{timeout:10000}); await page.keyboard.press('Escape');

  // Live App Preview: start from UI, render, edit source through Monaco, refresh and verify changed UI.
  await page.click('[data-view="preview"]'); await page.fill('#previewCommand',`"${process.execPath}" "${path.join(workspace,'preview-server.mjs')}"`); await page.click('#previewStart');
  try {
    await poll(() => page.evaluate(() => ({ status: document.querySelector('#previewStatus')?.textContent || '', src: document.querySelector('#previewFrame')?.getAttribute('src') || '', logs: document.querySelector('#previewLogs')?.textContent || '', toast: document.querySelector('#toastHost')?.textContent || '' })), (value) => /running|error|failed/i.test(value.status) || value.src.startsWith('http://127.0.0.1:'), { timeoutMs: 15000, label: 'Preview start' });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ status: document.querySelector('#previewStatus')?.textContent || '', src: document.querySelector('#previewFrame')?.getAttribute('src') || '', logs: document.querySelector('#previewLogs')?.textContent || '', toast: document.querySelector('#toastHost')?.textContent || '' }));
    throw new Error(`${error.message}; preview=${JSON.stringify(diagnostic)}`);
  }
  check((await page.locator('#previewStatus').textContent()).includes('running') && (await page.locator('#previewFrame').getAttribute('src') || '').startsWith('http://127.0.0.1:'), `Preview did not start: status=${await page.locator('#previewStatus').textContent()} logs=${await page.locator('#previewLogs').textContent()}`);
  const previewFrame=page.frameLocator('#previewFrame'); await previewFrame.locator('main').waitFor({state:'visible',timeout:15000}); check((await previewFrame.locator('main').textContent()).includes('PREVIEW_UI_V1'),'Preview did not render fixture app');
  await captureBackend('preview-running');
  await capture('02-preview-main');
  await page.click('[data-view="editor"]'); await page.locator('.tree-row[data-path="preview-content.txt"]').click(); await page.waitForFunction(()=>document.querySelector('#editorPath')?.textContent?.includes('preview-content.txt'),null,{timeout:10000});
  await page.locator('#monacoEditorPrimary .view-lines').click(); await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A'); await page.keyboard.type('PREVIEW_UI_V2'); await page.click('#saveFile');
  await page.click('[data-view="preview"]'); await page.click('#previewRefresh'); await poll(()=>previewFrame.locator('main').textContent(),(text)=>String(text||'').includes('PREVIEW_UI_V2'),10000,200);
  await capture('03-preview-updated');
  await page.click('[data-view="editor"]'); await page.click('#togglePreviewSplit'); await page.locator('#editorPreviewPane').waitFor({state:'visible',timeout:5000});
  await page.waitForFunction(() => (document.querySelector('#editorPreviewFrame')?.getAttribute('src') || '').startsWith('http://127.0.0.1:'), null, { timeout: 15000 });
  const splitPreview=page.frameLocator('#editorPreviewFrame');
  try {
    await poll(()=>splitPreview.locator('main').textContent(),(text)=>String(text||'').includes('PREVIEW_UI_V2'),{timeoutMs:20000,label:'editor-side Preview render'});
  } catch (error) {
    throw new Error(`${error.message}; editor preview src=${await page.locator('#editorPreviewFrame').getAttribute('src')}; body=${await splitPreview.locator('body').textContent().catch(() => '')}`);
  }
  await capture('04-editor-split-preview');
  check(await page.locator('#monacoEditorPrimary').isVisible(),'Editor should remain visible beside App Preview'); await page.click('#editorPreviewClose'); check(await page.locator('#editorPreviewPane').isHidden(),'Editor App Preview split did not close');
  await page.click('[data-view="preview"]'); await allowPreviewNavigationAbort('workspace Preview stop'); await page.click('#previewStop');

  // Real LSP through the browser UI: status + diagnostics + Quickfix navigation.
  await page.waitForFunction(() => document.querySelector('#lspStatus')?.textContent?.includes('active'), null, { timeout: 15000 });
  await page.click('[data-view="problems"]');
  await page.locator('.problem-row').filter({ hasText: 'not assignable' }).first().waitFor({ state: 'visible', timeout: 15000 });
  check((await page.locator('.lsp-server-row.running').count()) >= 1, 'Language server list does not show an active server');
  await page.locator('.problem-row').filter({ hasText: 'not assignable' }).first().click();
  check(await page.locator('#view-editor').evaluate((el) => el.classList.contains('active')), 'Problem navigation did not return to editor');

  // Mouse workbench: split panes and save state primitives.
  await page.click('#splitVertical');
  check(await page.locator('#editorPaneSecondary').isVisible(), 'Vertical editor split did not open');
  const secondaryLines = page.locator('#monacoEditorSecondary .view-lines .view-line');
  await secondaryLines.nth(1).waitFor({ state: 'visible', timeout: 10000 });
  await secondaryLines.nth(1).click();
  await page.keyboard.type('/*SECONDARY_MOUSE_E2E*/');
  const secondaryEditedValue = await page.evaluate(() => {
    const model = window.monaco?.editor?.getModels?.().find((item) => /\/src\/main\.ts$/.test(item.uri.path));
    return model?.getValue?.() || '';
  });
  check((secondaryEditedValue.split(/\r?\n/)[1] || '').includes('SECONDARY_MOUSE_E2E'), 'Secondary split mouse click did not move Monaco caret');
  await page.keyboard.press('Control+z');
  await page.click('#closeSplit');
  check(!(await page.locator('#editorPaneSecondary').isVisible()), 'Editor split did not close');

  // Workspace-wide search.
  await page.fill('#workspaceSearchInput', 'greet');
  await page.click('#workspaceSearchBtn');
  await page.locator('.workspace-search-row').first().waitFor({ state: 'visible' });
  check((await page.locator('.workspace-search-row').count()) >= 2, 'Workspace search returned too few matches');

  // Changes/Diff UI using real Git fixture.
  await page.click('[data-view="git"]');
  await page.locator('.git-file-row').filter({ hasText: 'src/main.ts' }).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.git-file-row').filter({ hasText: 'src/main.ts' }).first().click();
  await page.locator('#gitDiffContent').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#gitDiffMode');
  await page.click('#gitDiffMode');
  await page.click('#gitToggleStage');
  await poll(
    () => Promise.resolve(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workspace, encoding: 'utf8' })),
    (text) => text.includes('src/main.ts'),
    { timeoutMs: 10000, label: 'Git stage from rendered UI' }
  );
  await page.fill('#gitCommitMessage', 'ui e2e commit through ctrl enter');
  await page.locator('#gitCommitMessage').press('Control+Enter');
  await poll(
    () => Promise.resolve(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: workspace, encoding: 'utf8' }).trim()),
    (text) => text === 'ui e2e commit through ctrl enter',
    { timeoutMs: 15000, label: 'Git commit through Ctrl+Enter' }
  );

  // Integrated terminal UI: create, type through the visible xterm input,
  // split/resize/close, search real history, and kill the backend process.
  await page.click('[data-view="terminal"]');
  await page.click('#newIntegratedTerminal');
  await page.waitForFunction(() => document.querySelectorAll('#terminalTabs .terminal-tab').length >= 1, null, { timeout: 10000 });
  const integratedSession = await page.evaluate(async () => {
    const value = await (await fetch('/api/terminal/sessions')).json();
    return value.sessions.find((item) => item.backend === 'pty' || item.backend === 'pipe') || null;
  });
  check(integratedSession?.id, 'Integrated terminal was not created from the UI');
  const terminalCommand = process.platform === 'win32' ? 'Write-Output "UI_TERMINAL_OK"' : 'printf "UI_TERMINAL_OK\\n"';
  const terminalInput = page.locator('#xtermPrimary textarea.xterm-helper-textarea');
  await terminalInput.click();
  await page.keyboard.type(terminalCommand);
  await page.keyboard.press('Enter');
  await page.waitForFunction(async (id) => {
    const value = await (await fetch('/api/terminal/sessions')).json();
    return value.sessions.some((item) => item.id === id && String(item.history || '').includes('UI_TERMINAL_OK'));
  }, integratedSession.id, { timeout: 15000 });
  await page.fill('#terminalSearchInput', 'UI_TERMINAL_OK');
  await page.click('#terminalSearchPrev');
  await page.click('#splitTerminal');
  await page.locator('[data-terminal-pane="secondary"]').waitFor({ state: 'visible', timeout: 10000 });
  const dividerBox = await page.locator('#terminalSplitDivider').boundingBox();
  check(dividerBox, 'Terminal split divider was not rendered');
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + 80, dividerBox.y + dividerBox.height / 2, { steps: 4 });
  await page.mouse.up();
  check((await page.locator('#terminalWorkspace').getAttribute('style') || '').includes('--terminal-split-size'), 'Dragging the terminal split divider did not update pane size');
  await page.click('#closeTerminalSplit');
  check(await page.locator('[data-terminal-pane="secondary"]').isHidden(), 'Close Split did not collapse the secondary terminal pane');
  await page.click('#killIntegratedTerminal');
  await poll(
    () => page.evaluate(async (id) => (await (await fetch('/api/terminal/sessions')).json()).sessions.some((item) => item.id === id), integratedSession.id),
    (exists) => !exists,
    { timeoutMs: 10000, label: 'terminal backend process removal' }
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const beforeCount = await page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()).sessions.filter((item) => item.backend === 'pty' || item.backend === 'pipe').length);
    if (!beforeCount) break;
    await page.locator('#killIntegratedTerminal').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#killIntegratedTerminal');
    await poll(
      () => page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()).sessions.filter((item) => item.backend === 'pty' || item.backend === 'pipe').length),
      (count) => count < beforeCount,
      { timeoutMs: 10000, label: 'next terminal process removal' }
    );
  }
  await poll(
    () => page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()).sessions.filter((item) => item.backend === 'pty' || item.backend === 'pipe').length),
    (count) => count === 0,
    { timeoutMs: 10000, label: 'all rendered terminal processes removed' }
  );

  // Test Explorer + run configurations through the normal mouse UI.
  await page.click('[data-view="tests"]');
  await page.waitForFunction(() => document.querySelector('#testExplorerList')?.textContent?.includes('basic.test.mjs'), null, { timeout: 10000 });
  check((await page.locator('#runConfigurationsList').textContent()).includes('npm: test'), 'Run configurations did not discover npm test');
  check((await page.locator('.test-case-item').filter({ hasText: 'basic' }).count()) === 1, 'Test Explorer did not discover the individual basic test case');
  await page.locator('.test-case-item').filter({ hasText: 'basic' }).getByRole('button').click();
  await page.waitForFunction(() => /PASS.*basic/i.test(document.querySelector('#testOutputTitle')?.textContent || ''), null, { timeout: 30000 });
  await page.click('#runAllTests');
  await page.waitForFunction(() => document.querySelector('#testOutput')?.textContent?.includes('UI_TEST_EXPLORER_OK'), null, { timeout: 30000 });
  check((await page.locator('#testOutput').textContent()).includes('UI_TEST_EXPLORER_OK'), 'Test Explorer did not run the fixture test command');

  // Keyboard-enhanced/Vim mode is optional and remains composable with the same UI.
  await page.evaluate(() => { const select = document.querySelector('#interactionMode'); select.value = 'vim'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('body').click({ position: { x: 900, y: 900 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await page.locator('#leaderOverlay').waitFor({ state: 'visible' });
  check((await page.locator('#leaderGrid').textContent()).includes('Files'), 'Leader-key overlay did not render command groups');
  await page.keyboard.press('Escape');

  // LSP restart from normal mouse UI.
  await page.click('[data-view="editor"]');
  await page.click('#restartLsp');
  await page.waitForFunction(() => document.querySelector('#lspStatus')?.textContent?.includes('active'), null, { timeout: 15000 });

  // Deterministic Pi RPC through the real Studio UI.
  await page.selectOption('#topModel', '__custom__');
  await page.fill('#customModelInput', 'fake-model');
  await page.click('#startPi');
  await page.locator('#sessionLauncherModal').waitFor({ state: 'visible' });
  check(await page.locator('#sessionLaunchHarness').inputValue() === 'ui-minimal-coder', 'New Session did not inherit the harness selected in the Harness Builder');
  await page.click('#confirmSessionLauncher');
  await page.waitForFunction(() => document.querySelector('#piHealth')?.classList.contains('online'), null, { timeout: 10000 });
  const activeHarnessStatus = await page.evaluate(async () => (await (await fetch('/api/status')).json()).pi?.status || {});
  check(activeHarnessStatus.harnessId === 'ui-minimal-coder', `Backend started the wrong harness: ${JSON.stringify(activeHarnessStatus)}`);
  check(JSON.stringify(activeHarnessStatus.tools) === JSON.stringify(['read', 'edit', 'bash', 'tts_speak']), `Backend Pi tool allowlist differs from the saved harness: ${JSON.stringify(activeHarnessStatus.tools)}`);
  const fakePiTrace = await poll(() => fs.readFile(path.join(root, 'fake-pi-launch.jsonl'), 'utf8'), (text) => text.includes('read,edit,bash,tts_speak'), { timeoutMs: 10000, label: 'Pi harness tool argv' });
  check(fakePiTrace.includes('--tools'), 'Pi process launch did not receive a --tools allowlist');

  // Switch the live agent to another installed Runtime B model through the
  // authoritative top selector, then edit its active harness. Restarting for
  // the harness change must preserve that live model choice and launch tools.
  await page.selectOption('#topModel', 'runtime-b-coder:latest');
  await page.waitForFunction(async () => (await (await fetch('/api/status')).json()).pi?.status?.modelId === 'runtime-b-coder:latest', null, { timeout: 10000 });
  const switchedDefault = await poll(
    () => page.evaluate(async () => (await (await fetch('/api/config')).json()).config?.defaultModel || ''),
    (value) => value === 'runtime-b-coder:latest',
    { timeoutMs: 10000, label: 'live model default persistence' }
  );
  check(switchedDefault === 'runtime-b-coder:latest', 'Live model switch did not persist as the next-session model');
  await page.click('[data-settings="harness"]');
  const activeHarnessCard = page.locator('#harnessPresetList .harness-preset-card').filter({ hasText: 'UI Minimal Coder' }).first();
  await activeHarnessCard.getByRole('button', { name: 'Edit' }).click();
  await page.fill('#harnessBuilderDescription', 'Edited while active; restart contract must remain explicit.');
  await page.click('#harnessBuilderSave');
  await page.locator('#piRestartNotice').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#restartPiResources');
  await page.locator('#piRestartNotice').waitFor({ state: 'hidden', timeout: 15000 });
  const postHarnessRestartStatus = await page.evaluate(async () => (await (await fetch('/api/status')).json()).pi?.status || {});
  check(postHarnessRestartStatus.modelId === 'runtime-b-coder:latest', `Harness restart reverted the live model: ${JSON.stringify(postHarnessRestartStatus)}`);
  check(JSON.stringify(postHarnessRestartStatus.tools) === JSON.stringify(['read', 'edit', 'bash', 'tts_speak']), 'Harness restart lost the exact tool allowlist');
  const launchRecords = (await fs.readFile(path.join(root, 'fake-pi-launch.jsonl'), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line)).filter((item) => Array.isArray(item.argv));
  const lastLaunch = launchRecords.at(-1)?.argv || [];
  check(lastLaunch[lastLaunch.indexOf('--model') + 1] === 'runtime-b-coder:latest', `Restart launched the wrong model argv: ${JSON.stringify(lastLaunch)}`);
  await page.evaluate(() => document.querySelector('#toastHost')?.replaceChildren());
  await page.locator('#harnessPresetList .harness-preset-card').filter({ hasText: 'UI Minimal Coder' }).first().getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => /This harness is active/i.test(document.querySelector('#toastHost')?.textContent || ''), null, { timeout: 5000 });
  check(existsSync(harnessFile), 'Deleting the active harness removed its manifest despite the safety guard');
  await captureBackend('live-model-and-active-harness-restart');
  await capture('14-live-model-active-harness');

  // Normal chat controls against a live Pi RPC process: submit a prompt, steer
  // the active turn, queue a follow-up, abort, then exercise persistent session
  // metadata, compaction, direct Pi bash, commands, and raw RPC.
  await page.click('[data-view="chat"]');
  await page.fill('#composer', 'Inspect the fixture and report the safest next step.');
  await page.click('#sendPrompt');
  await page.waitForFunction(() => !document.querySelector('#sendSteer')?.disabled && !document.querySelector('#sendFollowUp')?.disabled, null, { timeout: 10000 });
  await page.fill('#composer', 'Steer: keep the analysis read-only.');
  await page.click('#sendSteer');
  await page.fill('#composer', 'Follow up: summarize the evidence.');
  await page.click('#sendFollowUp');
  await page.click('#abortAgent');
  await page.waitForFunction(() => document.querySelector('#messages')?.textContent?.includes('E2E agent response'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#abortAgent')?.disabled, null, { timeout: 10000 });
  const commandTrace = await fs.readFile(path.join(root, 'fake-pi-launch.jsonl'), 'utf8');
  for (const type of ['prompt', 'steer', 'follow_up', 'abort']) check(commandTrace.includes(`"command":"${type}"`), `Chat UI did not send Pi command ${type}`);

  await page.click('[data-settings="session"]');
  await page.fill('#sessionNameInput', 'UI Session Renamed');
  await page.click('#setSessionName');
  await poll(() => fs.readFile(path.join(workspace, '.pi', 'studio-sessions', 'ui-e2e-session.jsonl'), 'utf8'), (text) => text.includes('UI Session Renamed'), { timeoutMs: 10000, label: 'session name persistence' });
  await page.selectOption('#steeringMode', 'all');
  await page.selectOption('#followUpMode', 'all');
  await page.uncheck('#autoCompaction');
  await page.uncheck('#autoRetry');
  await page.fill('#compactInstructions', 'Preserve test evidence and remaining risks.');
  await page.click('#compactWithInstructions');
  await page.click('#loadCommands');
  await page.waitForFunction(() => document.querySelector('#commandList')?.textContent?.includes('code-review'), null, { timeout: 10000 });
  await page.fill('#bashCommand', 'printf UI_E2E_PI_BASH_OK');
  await page.click('#runBash');
  await page.waitForFunction(() => document.querySelector('#bashOutput')?.textContent?.includes('UI_E2E_PI_BASH_OK'), null, { timeout: 10000 });
  await page.click('[data-settings="advanced"]');
  await page.fill('#rawRpc', '{"type":"get_state"}');
  await page.click('#sendRawRpc');
  await page.waitForFunction(() => document.querySelector('#rawRpcResult')?.textContent?.includes('runtime-b-coder:latest'), null, { timeout: 10000 });

  // Qwen3-TTS through the rendered Session settings: distinguish an online
  // sleeping model from a load in progress, wake it, release VRAM, then prove
  // generation auto-wakes it and returns a playable audio artifact.
  await page.click('[data-settings="session"]');
  await page.fill('#ttsUrl', fakeTts.url);
  await page.click('#ttsStatus');
  await page.waitForFunction(() => /online.*sleeping/i.test(document.querySelector('#ttsStatusText')?.textContent || ''), null, { timeout: 10000 });
  check(!fakeTts.isLoaded(), 'TTS status check unexpectedly changed the model residency state');
  await page.click('#ttsWake');
  await page.waitForFunction(() => /TTS Ready/i.test(document.querySelector('#ttsStatusText')?.textContent || ''), null, { timeout: 10000 });
  check(fakeTts.isLoaded(), 'Rendered TTS Wake did not load the fake model');
  await page.click('#ttsSleep');
  await page.waitForFunction(() => /online.*sleeping/i.test(document.querySelector('#ttsStatusText')?.textContent || ''), null, { timeout: 10000 });
  check(!fakeTts.isLoaded(), 'Rendered TTS Sleep did not release the fake model');
  await page.fill('#ttsText', 'UI TTS lifecycle proof');
  await page.click('#ttsGenerate');
  await page.locator('#ttsAudio').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => /Audio generated/i.test(document.querySelector('#ttsStatusText')?.textContent || ''), null, { timeout: 10000 });
  check(fakeTts.isLoaded(), 'TTS generation did not auto-wake the sleeping model');
  check(fakeTts.captures.some((item) => item.url === '/v1/audio/speech' && item.payload?.input === 'UI TTS lifecycle proof'), `TTS generation payload did not reach the configured service: ${JSON.stringify(fakeTts.captures)}`);

  // Assistant-message Speak must use the same configured local TTS endpoint,
  // not browser speech or a hidden hard-coded service.
  await page.click('[data-view="chat"]');
  const spokenAnswer = page.locator('.message').filter({ hasText: 'E2E agent response' });
  check(await spokenAnswer.count() === 1, 'Could not identify the generated assistant answer for Speak');
  const speechCountBefore = fakeTts.captures.filter((item) => item.url === '/v1/audio/speech').length;
  await spokenAnswer.getByRole('button', { name: '🔊 Speak' }).click();
  await poll(
    () => fakeTts.captures.filter((item) => item.url === '/v1/audio/speech'),
    (items) => items.length > speechCountBefore && items.some((item) => item.payload?.input === 'E2E agent response'),
    { timeoutMs: 10000, label: 'assistant Speak TTS request' }
  );
  check(await page.inputValue('#ttsText') === 'E2E agent response', 'Assistant Speak did not copy the exact answer into the TTS field');
  await captureBackend('tts-lifecycle-and-assistant-speak');
  await capture('11-tts-lifecycle');

  await captureBackend('pi-chat-and-session-controls');
  await capture('09-pi-chat-controls');

  // Complete both rendered session-operation workflows. These assertions cover
  // the dialog, route, persisted session file, list refresh, and forked-session
  // Pi rebind rather than merely checking that the buttons are clickable.
  const sessionProbe = await page.evaluate(async () => {
    const workspace = document.querySelector('#workspacePath')?.value || '';
    const [statusResponse, sessionsResponse] = await Promise.all([
      fetch('/api/status'),
      fetch(`/api/sessions?workspace=${encodeURIComponent(workspace)}`)
    ]);
    return { workspace, status: await statusResponse.json(), sessions: await sessionsResponse.json() };
  });
  if (!Array.isArray(sessionProbe.sessions?.sessions) || sessionProbe.sessions.sessions.length === 0) {
    const expectedSessionDir = path.join(sessionProbe.workspace, '.pi', 'studio-sessions');
    const diskEntries = await fs.readdir(expectedSessionDir).catch((error) => [`<${error.code || error.message}>`]);
    const launchTrace = await fs.readFile(path.join(root, 'fake-pi-launch.jsonl'), 'utf8').catch((error) => `<${error.code || error.message}>`);
    throw new Error(`Pi started without a discoverable saved session: ${JSON.stringify({ workspace: sessionProbe.workspace, pi: sessionProbe.status?.pi, sessions: sessionProbe.sessions, expectedSessionDir, diskEntries, launchTrace })}`);
  }
  await page.locator('#sessionList .session-card').first().waitFor({ state: 'visible', timeout: 10000 });

  // Live Pi branch fork: the Sessions list first opens the tree so the user
  // chooses an exact prompt. The active session then uses Pi's native fork RPC.
  await page.locator('#sessionList .session-card').first().locator('.fork-btn').click();
  await page.locator('#sessionTree .session-tree-card.role-user').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#sessionTree .session-tree-card.role-user').first().locator('.tree-card-actions .primary').click();
  await poll(
    () => fs.readFile(path.join(root, 'fake-pi-launch.jsonl'), 'utf8'),
    (text) => text.includes('"command":"fork"'),
    { timeoutMs: 10000, label: 'live Pi branch fork RPC' }
  );

  // Full clone remains independent of ancestry selection.
  const cloneName = `ui-e2e-clone-${Date.now()}`;
  await page.locator('#sessionList .session-card').first().locator('.clone-btn').click();
  await page.locator('#sessionOperationModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#sessionOperationName', cloneName);
  const cloneResponse = page.waitForResponse((response) => response.url().includes('/api/sessions/clone') && response.request().method() === 'POST', { timeout: 30000 });
  await page.click('#sessionOperationConfirm');
  const cloneHttpResponse = await cloneResponse;
  const clonePayload = await cloneHttpResponse.json().catch(() => ({}));
  check(cloneHttpResponse.ok(), `Rendered Clone Session request failed: ${JSON.stringify(clonePayload)}`);
  await page.locator('#sessionOperationModal').waitFor({ state: 'hidden', timeout: 30000 });
  try {
    await poll(
      () => page.locator('#sessionList .session-name').allTextContents(),
      (names) => names.some((name) => name.includes(cloneName)),
      { timeoutMs: 30000, label: 'cloned session list refresh' }
    );
  } catch (error) {
    const sessionState = await page.evaluate(async () => {
      const workspace = document.querySelector('#workspacePath')?.value || '';
      return { workspace, api: await (await fetch(`/api/sessions?workspace=${encodeURIComponent(workspace)}`)).json(), dom: [...document.querySelectorAll('#sessionList .session-name')].map((item) => item.textContent) };
    });
    throw new Error(`${error.message}; clone=${JSON.stringify(clonePayload)}; sessions=${JSON.stringify(sessionState)}`);
  }

  // Historical fork of the independent clone: choose a prompt in its stopped
  // tree, create only that ancestry, and rebind the active Pi process to it.
  const forkName = `ui-e2e-fork-${Date.now()}`;
  await page.locator('#sessionList .session-card').filter({ hasText: cloneName }).first().locator('.fork-btn').click();
  await page.locator('#sessionTree .session-tree-card.role-user').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#sessionTree .session-tree-card.role-user').first().locator('.tree-card-actions .primary').click();
  await page.locator('#sessionOperationModal').waitFor({ state: 'visible', timeout: 10000 });
  check(await page.locator('#sessionOperationConfirm').isDisabled(), 'Fork confirmation should remain disabled until a name is entered');
  await page.fill('#sessionOperationName', forkName);
  const forkResponse = page.waitForResponse((response) => response.url().includes('/api/sessions/fork') && response.request().method() === 'POST', { timeout: 30000 });
  await page.click('#sessionOperationConfirm');
  const forkHttpResponse = await forkResponse;
  const forkPayload = await forkHttpResponse.json().catch(() => ({}));
  check(forkHttpResponse.ok(), `Rendered Fork Session request failed: ${JSON.stringify(forkPayload)}`);
  await page.locator('#sessionOperationModal').waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForFunction((name) => [...document.querySelectorAll('#sessionList .session-name')].some((item) => item.textContent.includes(name)), forkName, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#piHealth')?.classList.contains('online'), null, { timeout: 15000 });
  const forkEntries = (await fs.readFile(forkPayload.path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const cloneEntries = (await fs.readFile(clonePayload.path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  check(forkEntries.length <= cloneEntries.length, 'Historical fork did not constrain the session to selected ancestry');

  // Resource lifecycle: changing a package resource while Pi is running must
  // produce a real restart affordance, and restarting must clear it again.
  await page.click('[data-view="resources"]');
  await page.click('[data-platform-tab="packages"]');
  await page.locator('.platform-item').filter({ hasText: 'ui-e2e-market-package' }).first().click();
  await page.selectOption('[data-package-mode="extensions"]', 'all');
  await page.click('#applyPackageFilters');
  await page.locator('#piRestartNotice').waitFor({ state: 'visible', timeout: 10000 });
  check((await page.locator('#piRestartNotice').textContent()).includes('restart Pi'), 'Pi resource change did not expose the restart workflow');
  const previousPiStart = await page.evaluate(async () => (await (await fetch('/api/status')).json()).pi?.status?.startedAt || '');
  await page.click('#restartPiResources');
  await page.waitForFunction(async (previousStartedAt) => {
    const value = await (await fetch('/api/status')).json();
    const status = value.pi?.status || {};
    return Boolean(status.running && status.startedAt && status.startedAt !== previousStartedAt);
  }, previousPiStart, { timeout: 15000 });
  await page.locator('#piRestartNotice').waitFor({ state: 'hidden', timeout: 15000 });
  await captureBackend('pi-restarted-with-resources');
  await capture('05-pi-restart-resource-lifecycle');

  await page.click('[data-view="resources"]');
  await page.click('[data-platform-tab="commands"]');
  await page.locator('#resourceList').filter({ hasText: 'code-review' }).waitFor({ state: 'visible', timeout: 10000 });
  await page.click('[data-view="tree"]');
  await page.locator('.session-tree-card, #sessionTree').first().waitFor({ state: 'visible', timeout: 10000 });
  await captureBackend('session-tree');
  await capture('06-session-tree');

  // Ask-agent affordance from a real LSP problem fills the composer through the standard UI.
  await page.click('[data-view="problems"]');
  const problem = page.locator('.problem-row').filter({ hasText: 'not assignable' }).first();
  await problem.locator('.problem-ask-agent').click();
  check((await page.inputValue('#composer')).includes('not assignable'), 'Ask Agent did not transfer diagnostic context into composer');

  const actualErrors = pageErrors.filter((e) => !String(e).includes('Canceled') && !String(e).includes('abort')
    // These are deliberate negative-path assertions above: failed runtime
    // probing and optimistic editor-save conflict handling.
    && !/Failed to load resource: the server responded with a status of (409|502)/i.test(String(e)));
  check(actualErrors.length === 0, `Browser errors detected:\n${actualErrors.join('\n')}`);
  check(networkErrors.length === 0, `Network request failures detected:\n${networkErrors.join('\n')}`);
  check(expectedHttpErrors.every((item) => item.seen), `Expected negative-path HTTP proof was not observed: ${JSON.stringify(expectedHttpErrors)}`);
  check(httpErrors.length === 0, `Unexpected HTTP errors detected:\n${httpErrors.join('\n')}`);
  await fs.writeFile(path.join(artifactsDir, 'backend-status.json'), JSON.stringify(backendSnapshots, null, 2), 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'browser-console.log'), browserConsole.join('\n'), 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'network-errors.log'), networkErrors.join('\n'), 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'expected-network-aborts.log'), expectedNetworkAborts.join('\n'), 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'http-errors.log'), httpErrors.join('\n'), 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'studio-server.log'), serverLogs.join(''), 'utf8');
  console.log('PASS: UI E2E — Monaco, real LSP, Problems, search, Git diff, integrated terminal, Test Explorer, Pi Platform resources/settings, splits, Vim leader, Pi RPC and session tree');
} catch (error) {
  const failureDir = path.resolve(process.env.UI_E2E_ARTIFACTS || path.join(APP_ROOT, 'artifacts', 'ui-e2e'));
  await fs.mkdir(failureDir, { recursive: true }).catch(() => {});
  await page?.screenshot({ path: path.join(failureDir, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(failureDir, 'backend-status.json'), JSON.stringify(backendSnapshots, null, 2), 'utf8').catch(() => {});
  await fs.writeFile(path.join(failureDir, 'browser-console.log'), browserConsole.join('\n'), 'utf8').catch(() => {});
  await fs.writeFile(path.join(failureDir, 'network-errors.log'), networkErrors.join('\n'), 'utf8').catch(() => {});
  await fs.writeFile(path.join(failureDir, 'expected-network-aborts.log'), expectedNetworkAborts.join('\n'), 'utf8').catch(() => {});
  await fs.writeFile(path.join(failureDir, 'http-errors.log'), httpErrors.join('\n'), 'utf8').catch(() => {});
  await fs.writeFile(path.join(failureDir, 'studio-server.log'), serverLogs.join(''), 'utf8').catch(() => {});
  console.error(`UI E2E failed: ${error?.stack || error}`);
  console.error(`Artifacts: ${failureDir}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2500)]).catch(() => {});
  if (server.exitCode == null) server.kill('SIGKILL');
  await fakeOllama.close().catch(() => {});
  await fakeOllamaB.close().catch(() => {});
  await fakeProvider.close().catch(() => {});
  await fakeTts.close().catch(() => {});
  await fakeMcp.close().catch(() => {});
  await fakePackageRegistry.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  if (process.exitCode) console.error(serverLogs.join(''));
}
