import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtsRoutes } from '../src/routes/tts-routes.mjs';

function responseCapture() {
  return { status: 0, headers: {}, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = value; } };
}

function request(method, pathname, body = undefined) {
  return { method, body: body === undefined ? null : JSON.stringify(body) };
}

test('TTS status proxies local Qwen status and keeps legacy health alias', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { assert.equal(url, 'http://localhost:7860/api/status'); return new Response(JSON.stringify({ loaded: true, model: 'qwen3-tts' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const handle = createTtsRoutes({ readBody: async (req) => JSON.parse(req.body), json: (res, status, value) => { res.status = status; res.body = value; } });
    const res = {}; const handled = await handle(request('GET', '/api/tts/health'), res, new URL('http://127.0.0.1/api/tts/health'));
    assert.equal(handled, true, 'a JSON TTS response must terminate route dispatch');
    assert.deepEqual(res.body, { ok: true, online: true, loaded: true, model: 'qwen3-tts' });
  } finally { globalThis.fetch = original; }
});

test('TTS wake and sleep proxy the explicit lifecycle endpoints', async () => {
  const original = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url, options) => { urls.push([url, options?.method]); return new Response(JSON.stringify({ status: url.endsWith('/wake') ? 'loaded' : 'sleeping' }), { status: 200 }); };
  try {
    const handle = createTtsRoutes({ readBody: async (req) => JSON.parse(req.body), json: (res, status, value) => { res.status = status; res.body = value; } });
    for (const action of ['wake', 'sleep']) { const res = {}; const handled = await handle(request('POST', `/api/tts/${action}`, { url: 'http://127.0.0.1:7860' }), res, new URL(`http://127.0.0.1/api/tts/${action}`)); assert.equal(handled, true); assert.equal(res.status, 200); }
    assert.deepEqual(urls, [['http://127.0.0.1:7860/api/model/wake', 'POST'], ['http://127.0.0.1:7860/api/model/sleep', 'POST']]);
  } finally { globalThis.fetch = original; }
});

test('TTS generation proxies OpenAI-compatible audio and preserves binary response', async () => {
  const original = globalThis.fetch; let payload;
  globalThis.fetch = async (url, options) => { payload = JSON.parse(options.body); return new Response(Buffer.from('RIFF-test-audio'), { status: 200, headers: { 'content-type': 'audio/wav' } }); };
  try {
    const handle = createTtsRoutes({ readBody: async (req) => JSON.parse(req.body), json: () => { throw new Error('unexpected json'); } });
    const res = responseCapture(); const handled = await handle(request('POST', '/api/tts/generate', { url: 'http://localhost:7860', text: 'Hello', voice: 'default' }), res, new URL('http://127.0.0.1/api/tts/generate'));
    assert.equal(handled, true); assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'audio/wav'); assert.equal(res.body.toString(), 'RIFF-test-audio'); assert.equal(payload.input, 'Hello'); assert.equal(payload.model, 'qwen3-tts');
  } finally { globalThis.fetch = original; }
});

test('agent TTS generation creates a bounded same-origin playable artifact', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('RIFF-agent-audio'), { status: 200, headers: { 'content-type': 'audio/wav' } });
  try {
    const handle = createTtsRoutes({ readBody: async (req) => JSON.parse(req.body), json: (res, status, value) => { res.status = status; res.body = value; } });
    const generated = {};
    await handle(request('POST', '/api/tts/generate-artifact', { url: 'http://localhost:7860', text: 'Read this aloud' }), generated, new URL('http://127.0.0.1/api/tts/generate-artifact'));
    assert.equal(generated.status, 200);
    assert.match(generated.body.artifact.url, /^\/api\/tts\/audio\/[0-9a-f-]{36}$/i);
    assert.equal(generated.body.artifact.bytes, 16);
    const audio = responseCapture();
    const handled = await handle(request('GET', generated.body.artifact.url), audio, new URL(`http://127.0.0.1${generated.body.artifact.url}`));
    assert.equal(handled, true);
    assert.equal(audio.headers['content-type'], 'audio/wav');
    assert.equal(audio.body.toString(), 'RIFF-agent-audio');
  } finally { globalThis.fetch = original; }
});

test('TTS refuses non-local endpoints and empty text', async () => {
  const handle = createTtsRoutes({ readBody: async (req) => JSON.parse(req.body), json: () => {} });
  await assert.rejects(() => handle(request('GET', '/api/tts/status'), {}, new URL('http://127.0.0.1/api/tts/status?url=http%3A%2F%2F192.168.1.2%3A7860')), /must be local/);
  await assert.rejects(() => handle(request('POST', '/api/tts/generate', { url: 'http://localhost:7860', text: '' }), {}, new URL('http://127.0.0.1/api/tts/generate')), /TTS text is required/);
  await assert.rejects(() => handle(request('POST', '/api/tts/generate', { url: 'http://localhost:7860', text: 'hello', response_format: 'exe' }), {}, new URL('http://127.0.0.1/api/tts/generate')), /Unsupported TTS audio format/);
  await assert.rejects(() => handle(request('POST', '/api/tts/generate', { url: 'http://localhost:7860', text: 'hello', speed: 99 }), {}, new URL('http://127.0.0.1/api/tts/generate')), /speed must be between/);
});
