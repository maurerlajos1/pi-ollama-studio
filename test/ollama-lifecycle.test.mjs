import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOllamaRuntimeForPi, modelSelectionUsesOllama } from '../src/ollama-lifecycle.mjs';

test('model provider parsing mirrors Pi launch semantics without falling back providers', () => {
  assert.equal(modelSelectionUsesOllama('15koutput:latest'), true);
  assert.equal(modelSelectionUsesOllama('ollama/15koutput:latest'), true);
  assert.equal(modelSelectionUsesOllama('hf.co/unsloth/Qwen3-GGUF:Q4'), true);
  assert.equal(modelSelectionUsesOllama('openai/gpt-5'), false);
  assert.equal(modelSelectionUsesOllama('anything', 'openai'), false);
});

test('Pi start reuses an already-online Ollama without spawning a second process', async () => {
  let starts = 0;
  const status = { online: true, runtime: { baseUrl: 'http://127.0.0.1:11434' } };
  const result = await ensureOllamaRuntimeForPi({
    modelId: '15koutput:latest',
    baseUrl: 'http://127.0.0.1:11434',
    getStatus: async () => status,
    isLocalBaseUrl: () => true,
    managedOllama: { status: () => ({ running: false }), start: async () => { starts++; } }
  });
  assert.equal(result.started, false);
  assert.equal(starts, 0);
});

test('Pi start automatically starts a required local Ollama and waits for readiness', async () => {
  let polls = 0;
  let starts = 0;
  const result = await ensureOllamaRuntimeForPi({
    modelId: '15koutput:latest',
    baseUrl: 'http://127.0.0.1:11434',
    getStatus: async () => ({ online: ++polls >= 3 }),
    isLocalBaseUrl: () => true,
    managedOllama: { status: () => ({ running: false }), start: async () => { starts++; } },
    timeoutMs: 1000,
    pollIntervalMs: 25,
    sleep: async () => {}
  });
  assert.equal(result.started, true);
  assert.equal(starts, 1);
  assert.equal(polls, 3);
});

test('Pi start reports an offline remote Ollama and never attempts a fallback', async () => {
  let starts = 0;
  await assert.rejects(
    () => ensureOllamaRuntimeForPi({
      modelId: 'ollama/15koutput:latest',
      baseUrl: 'http://192.168.0.20:11434',
      getStatus: async () => ({ online: false }),
      isLocalBaseUrl: () => false,
      managedOllama: { status: () => ({ running: false }), start: async () => { starts++; } }
    }),
    (error) => error.statusCode === 503 && error.code === 'OLLAMA_REMOTE_OFFLINE'
  );
  assert.equal(starts, 0);
});

test('provider-backed Pi sessions do not require Ollama', async () => {
  let probes = 0;
  const result = await ensureOllamaRuntimeForPi({
    modelId: 'openai/gpt-5',
    getStatus: async () => { probes++; return { online: false }; }
  });
  assert.deepEqual(result, { required: false, started: false, status: null });
  assert.equal(probes, 0);
});
