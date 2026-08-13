import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  effectiveProviderModel,
  fetchProviderModels,
  loadProviderProfiles,
  normalizeOpenAiBaseUrl,
  normalizeProviderProfile,
  probeProviderModel,
  refreshProviderModels,
  removeProviderProfile,
  saveProviderProfile,
  syncProvidersToPi,
  updateProviderModel
} from '../src/providers.mjs';

async function tempPaths(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { storePath: path.join(root, 'providers.json'), modelsPath: path.join(root, 'models.json') };
}

function fakeOpenAiServer(t) {
  const captures = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : null;
    captures.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'coder-a', context_window: 65536, max_output_tokens: 15000 }] }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'responses unsupported' } })); return;
    }
    if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'missing' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, captures });
    });
  });
}

test('provider profiles normalize URLs and never persist API key values', async (t) => {
  const paths = await tempPaths(t);
  assert.equal(normalizeOpenAiBaseUrl('http://localhost:1234'), 'http://localhost:1234/v1');
  const saved = await saveProviderProfile({ id: 'Local Proxy', name: 'Local Proxy', baseUrl: 'http://localhost:1234', apiKeyEnv: 'LOCAL_PROXY_KEY' }, paths);
  assert.equal(saved.id, 'local-proxy');
  assert.equal(saved.apiKeyEnv, 'LOCAL_PROXY_KEY');
  const raw = await fs.readFile(paths.storePath, 'utf8');
  assert.doesNotMatch(raw, /sk-/);
  assert.deepEqual((await loadProviderProfiles(paths)).providers.map((item) => item.id), ['local-proxy']);
});

test('provider discovery uses /v1/models and environment-backed bearer auth', async (t) => {
  const fake = await fakeOpenAiServer(t);
  const profile = normalizeProviderProfile({ id: 'test', baseUrl: fake.baseUrl, apiKeyEnv: 'TEST_KEY' });
  const result = await fetchProviderModels(profile, { env: { TEST_KEY: 'secret-token' } });
  assert.equal(result.models[0].id, 'coder-a');
  assert.equal(result.models[0].detected.contextWindow, 65536);
  assert.equal(fake.captures[0].headers.authorization, 'Bearer secret-token');
});

test('provider capability probe prefers Responses then falls back to Chat Completions', async (t) => {
  const fake = await fakeOpenAiServer(t);
  const profile = normalizeProviderProfile({ id: 'test', baseUrl: fake.baseUrl, api: 'auto' });
  const result = await probeProviderModel(profile, { id: 'coder-a', detected: { contextWindow: 65536, maxTokens: 15000 } });
  assert.equal(result.detected.api, 'openai-completions');
  assert.equal(result.detected.tools, true);
  assert.equal(result.detected.jsonSchema, true);
  assert.ok(fake.captures.some((item) => item.url === '/v1/responses'));
  const chats = fake.captures.filter((item) => item.url === '/v1/chat/completions');
  assert.ok(chats.some((item) => Array.isArray(item.body.tools)));
  assert.ok(chats.some((item) => item.body.response_format?.type === 'json_schema'));
});

test('manual per-model capability overrides always win over detected values and Pi sync', async (t) => {
  const paths = await tempPaths(t);
  await saveProviderProfile({ id: 'proxy', baseUrl: 'http://localhost:5555/v1', api: 'auto', apiKeyEnv: 'PROXY_KEY', models: [{ id: 'coder-a', detected: { api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, tools: true, jsonSchema: true, vision: true, reasoning: false } }] }, paths);
  const { provider } = await updateProviderModel('proxy', { id: 'coder-a', detected: { api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, tools: true, jsonSchema: true, vision: true, reasoning: false }, overrides: { contextWindow: 65536, maxTokens: 15000, vision: false, reasoning: true } }, paths);
  const effective = effectiveProviderModel(provider.models[0], provider.api);
  assert.equal(effective.contextWindow, 65536);
  assert.equal(effective.maxTokens, 15000);
  assert.equal(effective.reasoning, true);
  assert.deepEqual(effective.input, ['text']);
  const synced = await syncProvidersToPi(paths);
  assert.equal(synced.providers.proxy.apiKey, '$PROXY_KEY');
  assert.equal(synced.providers.proxy.models[0].contextWindow, 65536);
  assert.equal(synced.providers.proxy.models[0].maxTokens, 15000);
  assert.equal(synced.providers.proxy.models[0].reasoning, true);
  assert.deepEqual(synced.providers.proxy.models[0].input, ['text']);
});

test('clearing a provider credential removes the old Pi apiKey reference', async (t) => {
  const paths = await tempPaths(t);
  await saveProviderProfile({ id: 'proxy', baseUrl: 'http://localhost:5555/v1', apiKeyEnv: 'OLD_KEY' }, paths);
  await syncProvidersToPi(paths);
  await saveProviderProfile({ id: 'proxy', baseUrl: 'http://localhost:5555/v1', apiKeyEnv: '' }, paths);
  const synced = await syncProvidersToPi(paths);
  assert.equal(Object.hasOwn(synced.providers.proxy, 'apiKey'), false);
});

test('removing a provider also removes its Studio-owned Pi model definition', async (t) => {
  const paths = await tempPaths(t);
  await saveProviderProfile({ id: 'proxy', baseUrl: 'http://localhost:5555/v1' }, paths);
  await syncProvidersToPi(paths);
  await removeProviderProfile('proxy', paths);
  const models = JSON.parse(await fs.readFile(paths.modelsPath, 'utf8'));
  assert.equal(models.providers.proxy, undefined);
});

test('concurrent provider mutations serialize without losing profiles', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'provider-race-')); const storePath=path.join(root,'providers.json');
  try {
    await Promise.all([
      saveProviderProfile({id:'race-a',name:'Race A',baseUrl:'http://127.0.0.1:9001'},{storePath}),
      saveProviderProfile({id:'race-b',name:'Race B',baseUrl:'http://127.0.0.1:9002'},{storePath})
    ]);
    const loaded=await loadProviderProfiles({storePath});
    assert.deepEqual(loaded.providers.map((item)=>item.id).sort(),['race-a','race-b']);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('loading provider profiles preserves persisted updatedAt timestamps', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'provider-time-')); const storePath=path.join(root,'providers.json');
  const stamp='2026-01-02T03:04:05.000Z';
  await fs.writeFile(storePath,JSON.stringify({providers:[{id:'stable-time',name:'Stable Time',baseUrl:'http://127.0.0.1:9999/v1',api:'auto',apiKeyEnv:'',authHeader:true,compat:{supportsDeveloperRole:true,supportsReasoningEffort:true},models:[],updatedAt:stamp}]}));
  try { const first=await loadProviderProfiles({storePath}); await new Promise((resolve)=>setTimeout(resolve,5)); const second=await loadProviderProfiles({storePath}); assert.equal(first.providers[0].updatedAt,stamp); assert.equal(second.providers[0].updatedAt,stamp); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('stale provider model writes are rejected after the provider revision changes', async (t) => {
  const paths=await tempPaths(t); const first=await saveProviderProfile({id:'stale',baseUrl:'http://127.0.0.1:7777/v1',models:[{id:'m'}]},paths);
  const second=await saveProviderProfile({id:'stale',name:'Changed',baseUrl:'http://127.0.0.1:7777/v1'},paths);
  assert.ok(second.revision>first.revision);
  await assert.rejects(()=>updateProviderModel('stale',{id:'m',overrides:{reasoning:true}},{...paths,expectedRevision:first.revision}),(error)=>error?.statusCode===409&&error?.code==='PROVIDER_STALE');
});

test('slow model refresh cannot overwrite a provider edited while the request is in flight', async (t) => {
  const paths=await tempPaths(t); let release; const gate=new Promise((resolve)=>{release=resolve;}); let requestSeen; const seen=new Promise((resolve)=>{requestSeen=resolve;});
  const server=http.createServer(async(req,res)=>{if(req.url==='/v1/models'){requestSeen();await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'old-endpoint-model'}]}));return;}res.statusCode=404;res.end('{}');});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise((resolve)=>server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`; await saveProviderProfile({id:'slow',baseUrl},paths);
  const pending=refreshProviderModels('slow',paths); await seen; await saveProviderProfile({id:'slow',name:'Edited During Refresh',baseUrl},paths); release();
  await assert.rejects(()=>pending,(error)=>error?.statusCode===409&&error?.code==='PROVIDER_STALE');
  const loaded=await loadProviderProfiles(paths); assert.equal(loaded.providers[0].name,'Edited During Refresh'); assert.deepEqual(loaded.providers[0].models,[]);
});


test('provider mutation refuses to overwrite a corrupt store', async (t) => {
  const paths=await tempPaths(t);const raw='{"providers":[ BROKEN';await fs.writeFile(paths.storePath,raw);
  await assert.rejects(()=>saveProviderProfile({id:'safe',baseUrl:'http://127.0.0.1:9999/v1'},paths),(error)=>error?.code==='JSON_STORE_CORRUPT');
  assert.equal(await fs.readFile(paths.storePath,'utf8'),raw);
});

test('provider model update/refresh paths also refuse to overwrite a corrupt store', async (t) => {
  const paths=await tempPaths(t);const raw='{"providers":[ BROKEN';await fs.writeFile(paths.storePath,raw);
  await assert.rejects(()=>updateProviderModel('x',{id:'m'},paths),(error)=>error?.code==='JSON_STORE_CORRUPT');
  await assert.rejects(()=>refreshProviderModels('x',paths),(error)=>error?.code==='JSON_STORE_CORRUPT');
  assert.equal(await fs.readFile(paths.storePath,'utf8'),raw);
});
