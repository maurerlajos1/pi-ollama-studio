import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateKvCache, formatBytes, normalizeOllamaOpenAiBaseUrl, probeOllamaRuntime, isLocalOllamaBaseUrl, getOllamaStatus, unloadModel } from '../src/ollama.mjs';

test('estimateKvCache computes grouped-query attention cache', () => {
  const show = { model_info: {
    'general.architecture': 'qwen2',
    'qwen2.block_count': 64,
    'qwen2.attention.head_count': 40,
    'qwen2.attention.head_count_kv': 8,
    'qwen2.embedding_length': 5120
  }};
  const result = estimateKvCache(show, 65536, 'q8_0', 1);
  assert.equal(result.layers, 64);
  assert.equal(result.kvHeads, 8);
  assert.equal(result.dimensions, 256);
  assert.equal(result.bytes, 64 * 8 * 256 * 65536);
  assert.match(result.formatted, /GB/);
});

test('q4 KV estimate is one quarter of f16', () => {
  const show = { model_info: {
    'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32,
    'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096
  }};
  const f16 = estimateKvCache(show, 32768, 'f16', 1).bytes;
  const q4 = estimateKvCache(show, 32768, 'q4_0', 1).bytes;
  assert.equal(q4 * 4, f16);
});

test('formatBytes formats human-readable values', () => {
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});


test('remote Ollama URL normalization supports local/IP/HTTPS and does not duplicate /v1', () => {
  assert.equal(normalizeOllamaOpenAiBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeOllamaOpenAiBaseUrl('http://192.168.1.50:11434/'), 'http://192.168.1.50:11434/v1');
  assert.equal(normalizeOllamaOpenAiBaseUrl('https://example.trycloudflare.com/v1'), 'https://example.trycloudflare.com/v1');
  assert.equal(isLocalOllamaBaseUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLocalOllamaBaseUrl('http://192.168.1.50:11434'), false);
  assert.equal(isLocalOllamaBaseUrl('https://example.trycloudflare.com'), false);
});

test('probeOllamaRuntime sends optional bearer auth from the named environment variable without receiving the secret in config', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.PI_STUDIO_TEST_OLLAMA_KEY;
  process.env.PI_STUDIO_TEST_OLLAMA_KEY = 'test-secret-value';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PI_STUDIO_TEST_OLLAMA_KEY;
    else process.env.PI_STUDIO_TEST_OLLAMA_KEY = originalKey;
  });

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const body = String(url).endsWith('/api/tags') ? { models: [{ name: 'model-a' }] } : String(url).endsWith('/api/ps') ? { models: [{ name: 'model-a', size_vram: 123 }] } : { version: '0.30.9' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await probeOllamaRuntime({
    ollamaBaseUrl: 'https://remote.example.test',
    ollamaApiKeyEnv: 'PI_STUDIO_TEST_OLLAMA_KEY',
    ollamaRuntimeKind: 'https',
    ollamaRuntimeName: 'Remote 3090'
  });
  assert.equal(result.online, true);
  assert.equal(result.version, '0.30.9');
  assert.equal(result.modelCount, 1);
  assert.equal(result.runtime.local, false);
  assert.equal(result.runtime.apiKeyAvailable, true);
  assert.equal(result.runtime.apiKeyEnv, 'PI_STUDIO_TEST_OLLAMA_KEY');
  assert.deepEqual(result.models.map((m) => m.name), ['model-a']);
  assert.deepEqual(result.running.map((m) => m.name), ['model-a']);
  assert.equal(requests.length, 3);
  for (const request of requests) assert.equal(request.options.headers.authorization, 'Bearer test-secret-value');
  assert.equal(JSON.stringify(result).includes('test-secret-value'), false);
});


test('Ollama stale model cache is isolated per runtime endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  let online = true;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (!online) throw new Error('runtime offline');
    const name = href.includes('runtime-a.test') ? 'model-a' : href.includes('runtime-b.test') ? 'model-b' : 'model-c';
    if (href.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name, model: name }] }), { status: 200 });
    if (href.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    return new Response(JSON.stringify({ version: '0.30.9' }), { status: 200 });
  };

  const baseConfig = { ollamaRuntimeKind: 'https', ollamaRuntimeName: 'Test', ollamaApiKeyEnv: '' };
  const a = await getOllamaStatus({ ...baseConfig, ollamaBaseUrl: 'https://runtime-a.test' });
  const b = await getOllamaStatus({ ...baseConfig, ollamaBaseUrl: 'https://runtime-b.test' });
  assert.equal(a.models[0].name, 'model-a');
  assert.equal(b.models[0].name, 'model-b');

  online = false;
  const staleA = await getOllamaStatus({ ...baseConfig, ollamaBaseUrl: 'https://runtime-a.test' });
  const staleB = await getOllamaStatus({ ...baseConfig, ollamaBaseUrl: 'https://runtime-b.test' });
  const neverSeen = await getOllamaStatus({ ...baseConfig, ollamaBaseUrl: 'https://runtime-c.test' });
  assert.equal(staleA.models[0].name, 'model-a');
  assert.equal(staleB.models[0].name, 'model-b');
  assert.deepEqual(neverSeen.models, [], 'an offline runtime must never inherit another endpoint\'s model list');
});

test('Studio Ollama profiles bind to runtime endpoint while legacy profiles remain portable', async () => {
  const mod = await import('../src/ollama.mjs');
  const a={ollamaBaseUrl:'http://127.0.0.1:11434',ollamaRuntimeName:'Local',ollamaRuntimeKind:'local'};
  const b={ollamaBaseUrl:'http://192.168.1.20:11434',ollamaRuntimeName:'LAN',ollamaRuntimeKind:'lan'};
  const runtime=mod.ollamaRuntimeIdentity(a);
  assert.equal(mod.profileRuntimeCompatibility({runtime},a).compatible,true);
  assert.equal(mod.profileRuntimeCompatibility({runtime},b).compatible,false);
  assert.equal(mod.profileRuntimeCompatibility({id:'legacy'},b).portable,true);
});

test('Ollama unload propagates runtime failures instead of reporting false success', async () => {
  const request = async () => { throw new Error('runtime offline'); };
  await assert.rejects(() => unloadModel('model-a', { request }), /runtime offline/);
  await assert.rejects(() => unloadModel('', { request }), /runtime offline/);
});
