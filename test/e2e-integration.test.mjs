import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/system.mjs';

async function waitFor(url, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const response = await fetch(url); if (response.ok) return response; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not respond at ${url}`);
}


async function listen(server) {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server.address().port;
}

test('Full E2E UI-Backend Integration Test Suite for Pi, Ollama, Git, Files, & Terminals', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-e2e-home-'));
  const workspace = path.join(home, 'test-workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.js'), 'console.log("hello e2e");\n');
  await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } }, null, 2));
  await fs.writeFile(path.join(workspace, 'main.ts'), 'const answer: string = 42;\nconsole.log(answer);\n');
  const gitEnv = { GIT_AUTHOR_NAME: 'Pi Studio Test', GIT_AUTHOR_EMAIL: 'pi-studio@example.test', GIT_COMMITTER_NAME: 'Pi Studio Test', GIT_COMMITTER_EMAIL: 'pi-studio@example.test' };
  assert.equal((await runCommand('git', ['init'], { cwd: workspace, env: gitEnv })).code, 0);
  assert.equal((await runCommand('git', ['add', 'index.js'], { cwd: workspace, env: gitEnv })).code, 0);
  assert.equal((await runCommand('git', ['commit', '-m', 'initial'], { cwd: workspace, env: gitEnv })).code, 0);

  const packageRegistry = http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url?.startsWith('/-/v1/search')) return res.end(JSON.stringify({objects:[{package:{name:'e2e-pi-package',version:'2.0.0',description:'E2E package',keywords:['pi-package']}}]}));
    if(req.url==='/e2e-pi-package') return res.end(JSON.stringify({'dist-tags':{latest:'2.0.0'},time:{'1.0.0':'2026-01-01T00:00:00.000Z','2.0.0':'2026-02-01T00:00:00.000Z'},versions:{'1.0.0':{name:'e2e-pi-package',version:'1.0.0',keywords:['pi-package'],pi:{extensions:['extensions/*.ts']},dist:{integrity:'sha512-old'}},'2.0.0':{name:'e2e-pi-package',version:'2.0.0',keywords:['pi-package'],pi:{extensions:['extensions/*.ts'],skills:['skills/**']},scripts:{postinstall:'node setup.js'},dist:{integrity:'sha512-new'}}}}));
    res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
  });
  const packageRegistryPort=await listen(packageRegistry);

  const port = 44800 + Math.floor(Math.random() * 800);
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      STUDIO_PORT: String(port),
      OLLAMA_MODELS: 'H:\\ollama-models',
      PI_OLLAMA_STUDIO_DIR: path.join(home, 'studio-data'),
      PI_CODING_AGENT_DIR: path.join(home, 'pi-agent'),
      PI_STUDIO_PI_PACKAGE_REGISTRY: `http://127.0.0.1:${packageRegistryPort}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(async () => {
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    await new Promise((resolve)=>packageRegistry.close(resolve)).catch(()=>{});
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/bootstrap`);

  // 1. Bootstrap & Server Health
  await t.test('E2E: Bootstrap returns system, Ollama, and Pi metadata', async () => {
    const res = await fetch(`${base}/api/bootstrap`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.config, 'object');
    assert.equal(typeof data.ollama, 'object');
    assert.equal(typeof data.system, 'object');
  });

  // 2. Runtime Configuration Updates
  await t.test('E2E: PUT /api/config validates and updates runtime settings', async () => {
    const updateRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ defaultContextLength: 32768, keepAlive: '15m' })
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.equal(updateData.ok, true);
    assert.equal(updateData.config.defaultContextLength, 32768);
    assert.equal(updateData.config.keepAlive, '15m');
  });


  await t.test('E2E: Pi Platform API inspects and edits project prompts, skills, instructions, and settings without starting Pi', async () => {
    const promptRes = await fetch(`${base}/api/pi-platform/prompt`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, scope: 'project', name: 'e2e-review', content: '---\ndescription: Review E2E changes\n---\nReview the current diff.\n' })
    });
    assert.equal(promptRes.status, 200);
    const promptData = await promptRes.json();
    assert.equal(promptData.ok, true);
    assert.ok(promptData.platform.prompts.some((item) => item.name === 'e2e-review' && item.scope === 'project'));

    const skillRes = await fetch(`${base}/api/pi-platform/skill`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, scope: 'project', name: 'e2e-skill', content: '# E2E Skill\n\nUse for integration checks.\n' })
    });
    assert.equal(skillRes.status, 200);

    const contextRes = await fetch(`${base}/api/pi-platform/context`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, scope: 'project', name: 'AGENTS.md', content: '# E2E Guidelines\n\n- Run npm test.\n' })
    });
    assert.equal(contextRes.status, 200);

    const settingsRes = await fetch(`${base}/api/pi-platform/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, scope: 'project', settings: { enableSkillCommands: true, packages: ['npm:e2e-package'] } })
    });
    assert.equal(settingsRes.status, 200);

    const inspect = await fetch(`${base}/api/pi-platform?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(inspect.status, 200);
    const value = await inspect.json();
    assert.equal(value.platform.settings.project.enableSkillCommands, true);
    assert.ok(value.platform.skills.some((item) => item.name === 'e2e-skill'));
    assert.ok(value.platform.contextFiles.some((item) => item.name === 'AGENTS.md' && item.scope === 'project'));
    assert.ok(value.platform.packages.some((item) => item.source === 'npm:e2e-package' && item.scope === 'project'));
    assert.ok(value.platform.contextEstimate.persistentContextTokens > 0);
  });


  await t.test('E2E: v1.8 provider routes discover, probe, override and sync an OpenAI-compatible model', async () => {
    const fake=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;res.setHeader('content-type','application/json');if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'e2e-model',context_window:32768,max_output_tokens:4096,input:['text'],reasoning:false}]}));if(req.url==='/v1/responses')return res.end(JSON.stringify({id:'r',output:[]}));res.statusCode=404;res.end(JSON.stringify({error:'not found'}));});
    const fakePort=await listen(fake);
    try {
      let response=await fetch(`${base}/api/providers/save`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({provider:{id:'e2e-provider',name:'E2E Provider',baseUrl:`http://127.0.0.1:${fakePort}`,api:'auto'}})});assert.equal(response.status,200);
      response=await fetch(`${base}/api/providers/models`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({providerId:'e2e-provider'})});let value=await response.json();assert.equal(value.provider.models[0].id,'e2e-model');
      response=await fetch(`${base}/api/providers/probe-model`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({providerId:'e2e-provider',modelId:'e2e-model'})});value=await response.json();assert.equal(value.model.detected.api,'openai-responses');assert.equal(value.model.detected.tools,true);assert.equal(value.model.detected.jsonSchema,true);
      response=await fetch(`${base}/api/providers/model`,{method:'PUT',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({providerId:'e2e-provider',model:{id:'e2e-model',overrides:{contextWindow:65536,maxTokens:15000,reasoning:true,vision:false}}})});assert.equal(response.status,200);
      response=await fetch(`${base}/api/providers/sync`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:'{}'});assert.equal(response.status,200);
      const piModels=JSON.parse(await fs.readFile(path.join(home,'pi-agent','models.json'),'utf8'));assert.equal(piModels.providers['e2e-provider'].models[0].contextWindow,65536);assert.equal(piModels.providers['e2e-provider'].models[0].maxTokens,15000);
    } finally { await new Promise((resolve)=>fake.close(resolve)); }
  });

  await t.test('E2E: v1.8 MCP routes connect, inspect and enforce agent exposure without leaking literal headers', async () => {
    const fake=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const msg=JSON.parse(body||'{}');let result={};if(msg.method==='tools/list')result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};else if(msg.method==='resources/list')result={resources:[{uri:'memory://e2e',name:'E2E'}]};else if(msg.method==='prompts/list')result={prompts:[{name:'hello',description:'Hello'}]};else if(msg.method==='tools/call')result={content:[{type:'text',text:'ok'}]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));});
    const fakePort=await listen(fake);
    try {
      let response=await fetch(`${base}/api/mcp/server`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({server:{id:'e2e-mcp',transport:'http',url:`http://127.0.0.1:${fakePort}/mcp`,headers:{'X-Literal':'do-not-return'},exposeToPi:true}})});assert.equal(response.status,200);
      response=await fetch(`${base}/api/mcp/connect`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({serverId:'e2e-mcp'})});assert.equal(response.status,200);
      let snapshot=await (await fetch(`${base}/api/mcp`)).json();const server=snapshot.servers.find((item)=>item.id==='e2e-mcp');assert.equal(server.tools[0].name,'echo');assert.equal(server.headers['X-Literal'],'<literal>');assert.equal(JSON.stringify(snapshot).includes('do-not-return'),false);
      response=await fetch(`${base}/api/mcp/exposure`,{method:'PUT',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({serverId:'e2e-mcp',exposeToPi:true,disabledTools:['echo']})});assert.equal(response.status,200);
      const agentTools=await (await fetch(`${base}/api/mcp/agent/tools`)).json();assert.equal(agentTools.tools.find((item)=>item.remoteName==='echo').active,false);
    } finally { await new Promise((resolve)=>fake.close(resolve)); }
  });

  await t.test('E2E: v1.8 package routes return exact-version trust metadata and persist native resource filters', async () => {
    let response=await fetch(`${base}/api/pi-packages/search?q=e2e&type=extensions`);assert.equal(response.status,200);let value=await response.json();assert.equal(value.packages[0].name,'e2e-pi-package');assert.equal(value.packages[0].trust.hasInstallScripts,true);
    response=await fetch(`${base}/api/pi-packages/details?name=e2e-pi-package&version=1.0.0`);assert.equal(response.status,200);value=await response.json();assert.equal(value.package.version,'1.0.0');assert.equal(value.package.trust.hasInstallScripts,false);assert.equal(value.package.integrity,'sha512-old');
    await fs.mkdir(path.join(workspace,'.pi'),{recursive:true});await fs.writeFile(path.join(workspace,'.pi','settings.json'),JSON.stringify({packages:['npm:e2e-pi-package@1.0.0']},null,2));
    response=await fetch(`${base}/api/pi-packages/config`,{method:'PUT',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({workspace,scope:'project',source:'npm:e2e-pi-package@1.0.0',resources:{extensions:{mode:'none'},skills:{mode:'custom',patterns:['skills/**']}}})});assert.equal(response.status,200);value=await response.json();assert.deepEqual(value.result.package.extensions,[]);assert.deepEqual(value.result.package.skills,['skills/**']);
  });

  await t.test('E2E: v1.8 App Preview persists config, launches a dev server, detects URL and stops the process tree', async () => {
    const previewScript=path.join(workspace,'preview-server.mjs');
    await fs.writeFile(previewScript,`import http from 'node:http'; const s=http.createServer((q,r)=>r.end('PREVIEW_E2E_OK')); s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));`);
    let response=await fetch(`${base}/api/preview/config`,{method:'PUT',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({workspace,command:`"${process.execPath}" "${previewScript}"`})});assert.equal(response.status,200);
    response=await fetch(`${base}/api/preview/start`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({workspace,command:`"${process.execPath}" "${previewScript}"`})});assert.equal(response.status,200);let value=await response.json();
    for(let i=0;i<40&&!value.preview.url;i++){await new Promise(r=>setTimeout(r,50));value=await (await fetch(`${base}/api/preview?workspace=${encodeURIComponent(workspace)}`)).json();}
    assert.match(value.preview.url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.equal(await (await fetch(value.preview.url)).text(),'PREVIEW_E2E_OK');
    response=await fetch(`${base}/api/preview/stop`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({workspace})});assert.equal(response.status,200);
    const persisted=JSON.parse(await fs.readFile(path.join(workspace,'.pi','studio-preview.json'),'utf8'));assert.match(persisted.command,/preview-server\.mjs/);
  });

  await t.test('E2E: direct local package provenance route hashes source and reports executable resources', async () => {
    const localPkg=path.join(workspace,'local-pi-package');await fs.mkdir(path.join(localPkg,'extensions'),{recursive:true});
    await fs.writeFile(path.join(localPkg,'package.json'),JSON.stringify({name:'local-e2e',version:'1.0.0',pi:{extensions:['extensions/*.mjs']},scripts:{postinstall:'node setup.mjs'}}));await fs.writeFile(path.join(localPkg,'extensions','tool.mjs'),'export default()=>{};\n');
    const response=await fetch(`${base}/api/pi-packages/inspect-source`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({workspace,scope:'project',source:'./local-pi-package'})});assert.equal(response.status,200);const value=await response.json();assert.equal(value.provenance.type,'local');assert.equal(value.provenance.trust.hasExtensions,true);assert.equal(value.provenance.trust.hasInstallScripts,true);assert.match(value.provenance.revision,/^[a-f0-9]{64}$/);
  });

  await t.test('E2E: remote Ollama connection test supports IP/HTTPS-style profiles and bearer env auth', async () => {
    const fakePort = 45900 + Math.floor(Math.random() * 500);
    const previousKey = process.env.PI_STUDIO_E2E_FAKE_OLLAMA_KEY;
    // The Studio child inherited its environment at spawn time, so update its runtime config to an unauthenticated
    // fake LAN endpoint here; bearer propagation itself is unit-tested in ollama.test.mjs.
    const fake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.30.9-test' }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake-e2e:latest' }] }));
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve, reject) => fake.listen(fakePort, '127.0.0.1', (error) => error ? reject(error) : resolve()));
    try {
      const response = await fetch(`${base}/api/ollama/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          ollamaBaseUrl: `http://127.0.0.1:${fakePort}`,
          ollamaRuntimeKind: 'lan',
          ollamaRuntimeName: 'Fake LAN Ollama',
          ollamaApiKeyEnv: ''
        })
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.result.online, true);
      assert.equal(value.result.version, '0.30.9-test');
      assert.equal(value.result.modelCount, 1);
      assert.equal(value.result.runtime.name, 'Fake LAN Ollama');
    } finally {
      await new Promise((resolve) => fake.close(resolve));
      if (previousKey === undefined) delete process.env.PI_STUDIO_E2E_FAKE_OLLAMA_KEY;
      else process.env.PI_STUDIO_E2E_FAKE_OLLAMA_KEY = previousKey;
    }
  });

  await t.test('E2E: Git onboarding API initializes a plain folder with baseline and safe ignore rules', async () => {
    const plainWorkspace = path.join(home, 'plain-workspace');
    await fs.mkdir(path.join(plainWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(plainWorkspace, 'src', 'app.js'), 'console.log("plain");\n');
    await fs.writeFile(path.join(plainWorkspace, '.env'), 'SECRET=not-tracked\n');

    const before = await fetch(`${base}/api/workspace/git?workspace=${encodeURIComponent(plainWorkspace)}`);
    assert.equal(before.status, 200);
    assert.equal((await before.json()).git.isRepository, false);

    const init = await fetch(`${base}/api/workspace/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace: plainWorkspace, initialBranch: 'main', createGitignore: true, createBaseline: true, confirmSensitive: true })
    });
    const initText = await init.text();
    assert.equal(init.status, 200, `git/init failed with status ${init.status}: ${initText}`);
    const initData = JSON.parse(initText);
    assert.equal(initData.ok, true);
    assert.equal(initData.baselineCreated, true);
    assert.equal(initData.git.isRepository, true);
    assert.equal(initData.git.branch, 'main');

    const tracked = await runCommand('git', ['ls-files'], { cwd: plainWorkspace });
    assert.match(tracked.stdout, /src\/app\.js/);
    assert.doesNotMatch(tracked.stdout, /(?:^|\n)\.env(?:\n|$)/);
  });

  // 3. Workspace File Tree & File Reading/Writing
  await t.test('E2E: Workspace tree, in-app directory browser, file reading/saving, and containment', async () => {
    const browseRes = await fetch(`${base}/api/workspace/browse?path=${encodeURIComponent(workspace)}`);
    assert.equal(browseRes.status, 200);
    const browseData = await browseRes.json();
    assert.equal(browseData.ok, true);
    assert.equal(Array.isArray(browseData.folders), true);
    const mkdirRes = await fetch(`${base}/api/workspace/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ parent: workspace, name: 'test-folder' })
    });
    assert.equal(mkdirRes.status, 200);
    const mkdirData = await mkdirRes.json();
    assert.equal(mkdirData.ok, true);
    assert.equal(mkdirData.name, 'test-folder');

    const treeRes = await fetch(`${base}/api/workspace/tree?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(treeRes.status, 200);
    const treeData = await treeRes.json();
    assert.equal(treeData.ok, true);
    assert.equal(Array.isArray(treeData.tree.entries), true);

    const fileRes = await fetch(`${base}/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=index.js`);
    assert.equal(fileRes.status, 200);
    const fileData = await fileRes.json();
    assert.equal(fileData.file.content, 'console.log("hello e2e");\n');

    assert.equal(typeof fileData.file.mtimeMs, 'number');

    // Two editor saves that validate the same disk revision must not both win.
    const concurrentSave = (content) => fetch(`${base}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content, expectedMtimeMs: fileData.file.mtimeMs })
    });
    const concurrentResponses = await Promise.all([
      concurrentSave('console.log("concurrent A");\n'),
      concurrentSave('console.log("concurrent B");\n')
    ]);
    assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 409]);
    const concurrentConflict = await concurrentResponses.find((response) => response.status === 409).json();
    assert.equal(concurrentConflict.code, 'FILE_CHANGED_ON_DISK');
    const refreshedFileData = await (await fetch(`${base}/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=index.js`)).json();

    const saveRes = await fetch(`${base}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content: 'console.log("first save");\n', expectedMtimeMs: refreshedFileData.file.mtimeMs })
    });
    assert.equal(saveRes.status, 200);
    const savedData = await saveRes.json();
    assert.equal(typeof savedData.file.mtimeMs, 'number');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(workspace, 'index.js'), 'console.log("agent changed disk");\n');
    const staleRes = await fetch(`${base}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content: 'console.log("stale overwrite");\n', expectedMtimeMs: savedData.file.mtimeMs })
    });
    assert.equal(staleRes.status, 409);
    const staleData = await staleRes.json();
    assert.equal(staleData.code, 'FILE_CHANGED_ON_DISK');
    assert.equal(await fs.readFile(path.join(workspace, 'index.js'), 'utf8'), 'console.log("agent changed disk");\n');

    const forceRes = await fetch(`${base}/api/workspace/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content: 'console.log("updated e2e");\n', force: true })
    });
    assert.equal(forceRes.status, 200);

    const searchRes = await fetch(`${base}/api/workspace/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent('updated e2e')}`);
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.result.matches[0].path, 'index.js');
    assert.equal(searchData.result.matches[0].line, 1);

    // Containment security check: Path escape rejection
    const escapeRes = await fetch(`${base}/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=../secret.txt`);
    assert.equal(escapeRes.status, 403);
  });


  await t.test('E2E: integrated terminal API creates a session, accepts input, reports history, resizes, and kills it', async () => {
    const createRes = await fetch(`${base}/api/terminal/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, name: 'Integration Terminal', cols: 100, rows: 30 })
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.ok(created.session.id);
    assert.ok(['pty', 'pipe'].includes(created.session.backend));
    const command = process.platform === 'win32' ? 'Write-Output "TERMINAL_API_OK"\r' : 'printf "TERMINAL_API_OK\\n"\n';
    const inputRes = await fetch(`${base}/api/terminal/input`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ id: created.session.id, data: command })
    });
    assert.equal(inputRes.status, 200);
    let found = false;
    for (let i = 0; i < 80; i++) {
      const sessions = await (await fetch(`${base}/api/terminal/sessions`)).json();
      const session = sessions.sessions.find((item) => item.id === created.session.id);
      if (session?.history?.includes('TERMINAL_API_OK')) { found = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(found, true, 'integrated terminal did not capture command output');
    const resizeRes = await fetch(`${base}/api/terminal/resize`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ id: created.session.id, cols: 132, rows: 44 })
    });
    assert.equal(resizeRes.status, 200);
    const resized = await resizeRes.json();
    assert.equal(resized.session.cols, 132);
    assert.equal(resized.session.rows, 44);
    const killRes = await fetch(`${base}/api/terminal/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ id: created.session.id })
    });
    assert.equal(killRes.status, 200);
    const arbitraryPidRes = await fetch(`${base}/api/terminal/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ pid: process.pid })
    });
    assert.equal(arbitraryPidRes.status, 400, 'terminal API should target Studio session IDs, not arbitrary OS PIDs');
  });

  await t.test('E2E: Test Explorer discovers and executes a real Node test through HTTP APIs', async () => {
    await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node test-runner.mjs', dev: 'node index.js' } }, null, 2));
    await fs.writeFile(path.join(workspace, 'test-runner.mjs'), "console.log('TEST_EXPLORER_OK');\n");
    await fs.writeFile(path.join(workspace, 'test', 'basic.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('basic',()=>assert.equal(2+2,4));\n");
    const discoveryRes = await fetch(`${base}/api/tests/discover?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(discoveryRes.status, 200);
    const discovery = await discoveryRes.json();
    assert.ok(discovery.discovery.tests.some((item) => item.path === 'test/basic.test.mjs'));
    const configs = await (await fetch(`${base}/api/run-configurations?workspace=${encodeURIComponent(workspace)}`)).json();
    assert.ok(configs.configurations.some((item) => item.script === 'test'));
    const runRes = await fetch(`${base}/api/tests/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, mode: 'all', timeoutMs: 30000 })
    });
    assert.equal(runRes.status, 200);
    const result = await runRes.json();
    assert.equal(result.result.passed, true, result.result.output);
    assert.match(result.result.output, /TEST_EXPLORER_OK/);
  });

  // 4. Git Integration APIs
  await t.test('E2E: Git status, diff, stage, and path safety', async () => {
    const statusRes = await fetch(`${base}/api/workspace/git?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(statusData.git.isRepository, true);

    const diffRes = await fetch(`${base}/api/workspace/git/diff?workspace=${encodeURIComponent(workspace)}&path=index.js`);
    assert.equal(diffRes.status, 200);
    assert.match((await diffRes.json()).diff, /updated e2e/);

    const headRes = await fetch(`${base}/api/workspace/git/file?workspace=${encodeURIComponent(workspace)}&path=index.js&source=head`);
    assert.equal(headRes.status, 200);
    assert.equal((await headRes.json()).file.content, 'console.log("hello e2e");\n');

    const stageRes = await fetch(`${base}/api/workspace/git/stage`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', stage: true })
    });
    assert.equal(stageRes.status, 200);
    const indexRes = await fetch(`${base}/api/workspace/git/file?workspace=${encodeURIComponent(workspace)}&path=index.js&source=index`);
    assert.equal((await indexRes.json()).file.content, 'console.log("updated e2e");\n');

    await fetch(`${base}/api/workspace/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content: 'console.log("throwaway");\n' })
    });
    const restoreRes = await fetch(`${base}/api/workspace/git/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js' })
    });
    assert.equal(restoreRes.status, 200);
    assert.equal((await fs.readFile(path.join(workspace, 'index.js'), 'utf8')).replace(/\r\n/g, '\n'), 'console.log("updated e2e");\n');

    // Diff path escape check
    const escapeDiff = await fetch(`${base}/api/workspace/git/diff?workspace=${encodeURIComponent(workspace)}&path=../../etc/passwd`);
    assert.equal(escapeDiff.status, 403);

    // Stage path escape check
    const escapeStage = await fetch(`${base}/api/workspace/git/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: '../../etc/passwd', stage: true })
    });
    assert.equal(escapeStage.status, 403);
  });

  // 5. Real LSP bridge through Studio HTTP APIs
  await t.test('E2E: LSP status, document sync, hover, diagnostics transport, and restart', async () => {
    const statusBefore = await fetch(`${base}/api/lsp/status?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(statusBefore.status, 200);
    const beforeData = await statusBefore.json();
    assert.equal(beforeData.ok, true);
    assert.equal(beforeData.servers.some((server) => server.id === 'typescript'), true);

    const text = await fs.readFile(path.join(workspace, 'main.ts'), 'utf8');
    const openRes = await fetch(`${base}/api/lsp/document`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'main.ts', languageId: 'typescript', text, version: 1, action: 'open' })
    });
    assert.equal(openRes.status, 200);
    assert.equal((await openRes.json()).ok, true);

    const uri = pathToFileURL(path.join(workspace, 'main.ts')).href;
    const hoverRes = await fetch(`${base}/api/lsp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        workspace, path: 'main.ts', languageId: 'typescript', method: 'textDocument/hover',
        params: { textDocument: { uri }, position: { line: 0, character: 6 } }
      })
    });
    assert.equal(hoverRes.status, 200);
    const hoverData = await hoverRes.json();
    assert.equal(hoverData.ok, true);
    assert.equal(hoverData.results?.[0]?.serverId, 'typescript');
    assert.equal(hoverData.results?.[0]?.ok, true);
    assert.ok(hoverData.results?.[0]?.result);

    const symbolsRes = await fetch(`${base}/api/lsp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, method: 'workspace/symbol', params: { query: 'answer' } })
    });
    assert.equal(symbolsRes.status, 200);
    const symbolsData = await symbolsRes.json();
    assert.equal(symbolsData.results?.[0]?.serverId, 'typescript');
    assert.equal(symbolsData.results?.[0]?.ok, true);
    assert.equal(Array.isArray(symbolsData.results?.[0]?.result), true);

    const statusAfter = await fetch(`${base}/api/lsp/status?workspace=${encodeURIComponent(workspace)}`);
    const afterData = await statusAfter.json();
    assert.equal(afterData.servers.some((server) => server.id === 'typescript' && server.running === true && server.initialized === true), true);

    const restartRes = await fetch(`${base}/api/lsp/restart`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, serverId: 'typescript' })
    });
    assert.equal(restartRes.status, 200);
    const restartData = await restartRes.json();
    assert.equal(restartData.ok, true);

    const reopenRes = await fetch(`${base}/api/lsp/document`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'main.ts', action: 'open', languageId: 'typescript', text: 'const answer: number = 42;\n', version: 3 })
    });
    assert.equal(reopenRes.status, 200);
    const stopRes = await fetch(`${base}/api/lsp/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace })
    });
    assert.equal(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.equal(stopData.ok, true);
    assert.equal(stopData.servers.some((server) => server.running === true), false);
  });

  // 6. Ollama Status, Diagnostics, Profiles, & Sync
  await t.test('E2E: Ollama status, profile creation, and diagnostics', async () => {
    const statusRes = await fetch(`${base}/api/ollama/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(typeof statusData.ollama.online, 'boolean');
    if (!statusData.ollama.online) {
      t.diagnostic('Ollama is offline; skipping live profile-creation assertion');
      return;
    }

    const profileRes = await fetch(`${base}/api/ollama/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        baseModel: 'llama3.2:latest',
        name: 'e2e-test-profile',
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: false
      })
    });
    assert.equal(profileRes.status, 200);
    const profileData = await profileRes.json();
    assert.equal(profileData.ok, true);
    assert.equal(profileData.profile.name, 'e2e-test-profile');
  });

  // 7. Terminal Session Management & Command Security
  await t.test('E2E: Terminal session listing and kill', async () => {
    const otherWorkspace = path.join(home, 'other-terminal-workspace');
    await fs.mkdir(otherWorkspace, { recursive: true });
    const createTerminal = async (targetWorkspace, name) => {
      const response = await fetch(`${base}/api/terminal/create`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ workspace: targetWorkspace, name })
      });
      assert.equal(response.status, 200);
      return (await response.json()).session;
    };
    const workspaceTerminal = await createTerminal(workspace, 'Workspace A terminal');
    const otherTerminal = await createTerminal(otherWorkspace, 'Workspace B terminal');

    const listRes = await fetch(`${base}/api/terminal/sessions`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.ok, true);
    assert.equal(Array.isArray(listData.sessions), true);
    assert.equal(listData.sessions.some((item) => item.id === workspaceTerminal.id), true);
    assert.equal(listData.sessions.some((item) => item.id === otherTerminal.id), true);

    const scopedRes = await fetch(`${base}/api/terminal/sessions?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(scopedRes.status, 200);
    const scopedData = await scopedRes.json();
    assert.equal(scopedData.sessions.some((item) => item.id === workspaceTerminal.id), true);
    assert.equal(scopedData.sessions.some((item) => item.id === otherTerminal.id), false);

    const killRes = await fetch(`${base}/api/terminal/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ id: 'non-existent-id' })
    });
    assert.equal(killRes.status, 200);
  });

  // 8. Real-Time Server-Sent Events (SSE) Handshake
  await t.test('E2E: SSE /api/events broadcasts initial connection handshake', async () => {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.body.cancel();
  });

  // 9. Session Branching (Fork, Clone, Create Project from Node)
  await t.test('E2E: Session fork, clone, and create project from node', async () => {
    const sessionsRes = await fetch(`${base}/api/sessions?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(sessionsRes.status, 200);
    const sessionsData = await sessionsRes.json();
    assert.equal(sessionsData.ok, true);

    if (sessionsData.sessions.length > 0) {
      const firstSession = sessionsData.sessions[0].path;

      const forkRes = await fetch(`${base}/api/sessions/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ workspace, sessionPath: firstSession, name: 'e2e-forked-session' })
      });
      assert.equal(forkRes.status, 200);
      const forkData = await forkRes.json();
      assert.equal(forkData.ok, true);

      const cloneRes = await fetch(`${base}/api/sessions/clone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ workspace, sessionPath: firstSession, name: 'e2e-cloned-session' })
      });
      assert.equal(cloneRes.status, 200);
      const cloneData = await cloneRes.json();
      assert.equal(cloneData.ok, true);
      const clonedSession = await fetch(`${base}/api/session/inspect?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(cloneData.path)}`).then((response) => response.json());
      assert.equal(clonedSession.ok, true);
      assert.equal(clonedSession.session.entries[0]?.name, 'e2e-cloned-session');

      const createProjRes = await fetch(`${base}/api/sessions/create-project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ workspace, sessionPath: firstSession, name: 'e2e-created-app' })
      });
      assert.equal(createProjRes.status, 200);
      const createProjData = await createProjRes.json();
      assert.equal(createProjData.ok, true);
      assert.equal(createProjData.projectName, 'e2e-created-app');
    }
  });
});
