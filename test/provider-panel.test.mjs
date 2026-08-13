import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { effectiveCapability, providerFormState, providerModelEntries, providerModelValue } from '../public/provider-panel.js';

test('provider form enables test and save only for an actionable HTTP endpoint', () => {
  assert.deepEqual(providerFormState(), { canTest: false, canSave: false });
  assert.deepEqual(providerFormState({ baseUrl: 'http://127.0.0.1:8080/v1' }), { canTest: true, canSave: false });
  assert.deepEqual(providerFormState({ id: 'local', baseUrl: 'https://example.test/v1' }), { canTest: true, canSave: true });
  assert.deepEqual(providerFormState({ id: 'local', baseUrl: 'file:///tmp/models' }), { canTest: false, canSave: false });
});

test('provider model entries use provider/model values without colliding with Ollama models', () => {
  const entries = providerModelEntries([{ id:'openai', name:'OpenAI', models:[{ id:'gpt-5.4', name:'GPT 5.4' }] }]);
  assert.deepEqual(entries.map((item) => item.value), ['openai/gpt-5.4']);
  assert.equal(providerModelValue('local-vllm', 'coder/model'), 'local-vllm/coder/model');
});

test('provider capability UI resolves explicit overrides before detected values', () => {
  const model = { detected:{ tools:true, vision:false }, overrides:{ tools:false, vision:true } };
  assert.equal(effectiveCapability(model, 'tools'), false);
  assert.equal(effectiveCapability(model, 'vision'), true);
  assert.equal(effectiveCapability({ detected:{ reasoning:true } }, 'reasoning'), true);
});

test('provider capability UI ignores null auto overrides and falls back to detected values', () => {
  const model = { detected:{ tools:true, vision:false }, overrides:{ tools:null, vision:null } };
  assert.equal(effectiveCapability(model, 'tools'), true);
  assert.equal(effectiveCapability(model, 'vision'), false);
});

test('provider removal is confirmed and protected from duplicate clicks', async () => {
  const source = await fs.readFile(new URL('../public/provider-panel.js', import.meta.url), 'utf8');
  assert.match(source, /Remove provider .*Studio-owned Pi model definitions/);
  assert.match(source, /button\.disabled = true; button\.textContent = 'Removing…'/);
  assert.match(source, /await del\('\/api\/providers'/);
});
