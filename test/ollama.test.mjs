import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateKvCache, formatBytes } from '../src/ollama.mjs';

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
