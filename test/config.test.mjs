import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';

test('validateConfig normalizes numeric and boolean settings', () => {
  const value = validateConfig({
    port: '5000', defaultContextLength: '65536', numParallel: '2', maxLoadedModels: '1', maxQueue: '128',
    gpuOverheadBytes: '1024', flashAttention: 1, managedOllama: 0, kvCacheType: 'q8_0'
  });
  assert.equal(value.port, 5000);
  assert.equal(value.defaultContextLength, 65536);
  assert.equal(value.numParallel, 2);
  assert.equal(value.flashAttention, true);
  assert.equal(value.managedOllama, false);
  assert.equal(validateConfig({ noCloud: 0 }).noCloud, false);
});

test('validateConfig rejects invalid KV cache type', () => {
  assert.throws(() => validateConfig({ kvCacheType: 'int2' }), /Invalid KV cache type/);
});

test('validateConfig keeps the code-execution server loopback-only', () => {
  assert.throws(() => validateConfig({ bindHost: '0.0.0.0' }), /may only bind/);
  assert.equal(validateConfig({ bindHost: '::1' }).bindHost, '::1');
});

test('validateConfig validates Ollama keep-alive durations', () => {
  assert.equal(validateConfig({ keepAlive: '1h' }).keepAlive, '1h');
  assert.throws(() => validateConfig({ keepAlive: 'forever please' }), /keepAlive/);
});
