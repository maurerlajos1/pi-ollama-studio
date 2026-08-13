import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaRoutes } from '../src/routes/ollama-routes.mjs';

test('Ollama pull uses the active runtime and returns its identity', async () => {
  const events = [];
  const calls = [];
  const response = {};
  const route = createOllamaRoutes({
    readBody: async () => ({ model: 'qwen3.6:27b' }),
    json: (_res, status, value) => { response.status = status; response.value = value; },
    sendEvent: (name, value) => events.push({ name, value }),
    readConfig: async () => ({ ollamaBaseUrl: 'http://192.168.0.18:11436', ollamaRuntimeName: 'Remote 3090', ollamaRuntimeKind: 'lan' }),
    getOllamaStatus: async () => ({ online: true, runtime: { baseUrl: 'http://192.168.0.18:11436', name: 'Remote 3090', kind: 'lan' }, models: [{ model: 'qwen3.6:27b' }], running: [] }),
    pullModel: async (model, onEvent) => { calls.push(model); onEvent({ status: 'success' }); },
    syncPiModels: async () => ({ models: [{ id: 'qwen3.6:27b' }] })
  });

  const handled = await route({ method: 'POST' }, response, new URL('http://127.0.0.1/api/ollama/pull'));
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(calls[0], 'qwen3.6:27b');
  assert.deepEqual(response.value.runtime, { baseUrl: 'http://192.168.0.18:11436', name: 'Remote 3090', kind: 'lan' });
  assert.ok(events.some((event) => event.name === 'ollama_operation' && event.value.runtime.baseUrl === 'http://192.168.0.18:11436'));
  assert.ok(events.some((event) => event.name === 'ollama_models_changed'));
});

test('Ollama pull rejects an empty model before invoking the runtime', async () => {
  let pulled = false;
  const route = createOllamaRoutes({
    readBody: async () => ({ model: '  ' }),
    json: () => {},
    sendEvent: () => {},
    readConfig: async () => ({ ollamaBaseUrl: 'http://192.168.0.18:11436' }),
    getOllamaStatus: async () => ({}),
    pullModel: async () => { pulled = true; },
    syncPiModels: async () => ({})
  });
  await assert.rejects(() => route({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/ollama/pull')), (error) => error.statusCode === 400 && error.message === 'Model is required');
  assert.equal(pulled, false);
});

test('Ollama status reports Studio process ownership separately from endpoint health', async () => {
  const response = {};
  const route = createOllamaRoutes({
    json: (_res, status, value) => { response.status = status; response.value = value; },
    getOllamaStatus: async () => ({ online: true }),
    loadProfiles: async () => ({ profiles: [] }),
    managedOllama: { status: () => ({ running: false, pid: null }) }
  });
  assert.equal(await route({ method: 'GET' }, response, new URL('http://127.0.0.1/api/ollama/status')), true);
  assert.deepEqual(response.value.managedOllama, { running: false, pid: null });
});

test('managed controls refuse to claim ownership of an external local Ollama process', async () => {
  let started = false;
  const route = createOllamaRoutes({
    json: () => {},
    sendEvent: () => {},
    readConfig: async () => ({ ollamaBaseUrl: 'http://127.0.0.1:11434' }),
    isLocalOllamaBaseUrl: () => true,
    getOllamaStatus: async () => ({ online: true }),
    managedOllama: {
      status: () => ({ running: false, pid: null }),
      start: async () => { started = true; return { running: true, pid: 42 }; }
    }
  });
  await assert.rejects(
    () => route({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/ollama/managed/start')),
    (error) => error.statusCode === 409 && error.code === 'OLLAMA_EXTERNAL_PROCESS'
  );
  assert.equal(started, false);
});

test('managed stop and restart require a Studio-owned Ollama process', async () => {
  const route = createOllamaRoutes({
    json: () => {},
    sendEvent: () => {},
    readConfig: async () => ({ ollamaBaseUrl: 'http://127.0.0.1:11434' }),
    isLocalOllamaBaseUrl: () => true,
    managedOllama: { status: () => ({ running: false, pid: null }) }
  });
  for (const action of ['stop', 'restart']) {
    await assert.rejects(
      () => route({ method: 'POST' }, {}, new URL(`http://127.0.0.1/api/ollama/managed/${action}`)),
      (error) => error.statusCode === 409 && error.code === 'OLLAMA_NOT_MANAGED'
    );
  }
});
