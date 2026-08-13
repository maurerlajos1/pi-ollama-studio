import { URL } from 'node:url';
import crypto from 'node:crypto';

const MAX_TEXT_LENGTH = 20_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 8;
const ARTIFACT_TTL_MS = 15 * 60 * 1000;
const AUDIO_FORMATS = new Set(['wav', 'mp3', 'opus', 'aac', 'flac']);

function ttsUrl(value = 'http://localhost:7860') {
  const parsed = new URL(String(value || 'http://localhost:7860'));
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw Object.assign(new Error('TTS endpoint must be local (localhost, 127.0.0.1, or ::1)'), { statusCode: 400, code: 'TTS_ENDPOINT_NOT_LOCAL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('TTS endpoint must use http or https'), { statusCode: 400, code: 'TTS_ENDPOINT_INVALID' });
  }
  return parsed.toString().replace(/\/$/, '');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || value.message || `TTS server returned HTTP ${response.status}`), { statusCode: 502, code: 'TTS_UPSTREAM_ERROR' });
  return value;
}

function generationRequest(body = {}) {
  const text = String(body.text || body.input || '').trim();
  if (!text) throw Object.assign(new Error('TTS text is required'), { statusCode: 400, code: 'TTS_TEXT_REQUIRED' });
  if (text.length > MAX_TEXT_LENGTH) throw Object.assign(new Error(`TTS text exceeds ${MAX_TEXT_LENGTH.toLocaleString()} characters`), { statusCode: 413, code: 'TTS_TEXT_TOO_LARGE' });
  const responseFormat = String(body.response_format || 'wav').trim().toLowerCase();
  if (!AUDIO_FORMATS.has(responseFormat)) throw Object.assign(new Error(`Unsupported TTS audio format: ${responseFormat}`), { statusCode: 400, code: 'TTS_FORMAT_INVALID' });
  const speed = body.speed == null ? null : Number(body.speed);
  if (speed != null && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) throw Object.assign(new Error('TTS speed must be between 0.25 and 4'), { statusCode: 400, code: 'TTS_SPEED_INVALID' });
  return {
    base: ttsUrl(body.url),
    payload: {
      model: String(body.model || 'qwen3-tts'),
      input: text,
      voice: String(body.voice || 'default'),
      response_format: responseFormat,
      ...(body.instructions ? { instructions: String(body.instructions) } : {}),
      ...(speed != null ? { speed } : {})
    }
  };
}

async function generateAudio(body) {
  const { base, payload } = generationRequest(body);
  const upstream = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000)
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw Object.assign(new Error(detail || `TTS server returned HTTP ${upstream.status}`), { statusCode: 502, code: 'TTS_UPSTREAM_ERROR' });
  }
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw Object.assign(new Error('Generated TTS audio is too large'), { statusCode: 502, code: 'TTS_AUDIO_TOO_LARGE' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('Generated TTS audio is too large'), { statusCode: 502, code: 'TTS_AUDIO_TOO_LARGE' });
  return { buffer, contentType: upstream.headers.get('content-type') || `audio/${payload.response_format}`, format: payload.response_format, voice: payload.voice };
}

export function createTtsRoutes({ readBody, json }) {
  const artifacts = new Map();

  function pruneArtifacts(now = Date.now()) {
    for (const [id, artifact] of artifacts) if (artifact.expiresAt <= now) artifacts.delete(id);
    while (artifacts.size > MAX_ARTIFACTS) artifacts.delete(artifacts.keys().next().value);
  }

  return async function handleTtsRoutes(req, res, url) {
    const { pathname, searchParams } = url;
    if (req.method === 'GET' && (pathname === '/api/tts/status' || pathname === '/api/tts/health')) {
      const base = ttsUrl(searchParams.get('url') || undefined);
      try {
        const value = await requestJson(`${base}/api/status`);
        json(res, 200, { ok: true, online: true, ...value });
        return true;
      } catch (error) {
        json(res, 200, { ok: true, online: false, error: error.message, code: error.code || 'TTS_OFFLINE' });
        return true;
      }
    }
    if (req.method === 'POST' && pathname === '/api/tts/wake') {
      const body = await readBody(req).catch(() => ({}));
      const base = ttsUrl(body.url);
      json(res, 200, { ok: true, ...(await requestJson(`${base}/api/model/wake`, { method: 'POST' })) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/tts/sleep') {
      const body = await readBody(req).catch(() => ({}));
      const base = ttsUrl(body.url);
      json(res, 200, { ok: true, ...(await requestJson(`${base}/api/model/sleep`, { method: 'POST' })) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/tts/generate') {
      const body = await readBody(req);
      const { buffer, contentType } = await generateAudio(body);
      res.writeHead(200, { 'content-type': contentType, 'content-length': buffer.length, 'cache-control': 'no-store' });
      res.end(buffer);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/tts/generate-artifact') {
      const body = await readBody(req);
      const audio = await generateAudio(body);
      pruneArtifacts();
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + ARTIFACT_TTL_MS;
      artifacts.set(id, { ...audio, expiresAt });
      pruneArtifacts();
      json(res, 200, { ok: true, artifact: { id, url: `/api/tts/audio/${id}`, contentType: audio.contentType, format: audio.format, voice: audio.voice, bytes: audio.buffer.length, expiresAt: new Date(expiresAt).toISOString() } });
      return true;
    }
    if (req.method === 'GET' && pathname.startsWith('/api/tts/audio/')) {
      const id = pathname.slice('/api/tts/audio/'.length);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('Invalid TTS audio artifact ID'), { statusCode: 400, code: 'TTS_ARTIFACT_INVALID' });
      pruneArtifacts();
      const artifact = artifacts.get(id);
      if (!artifact) throw Object.assign(new Error('TTS audio artifact expired or was not found'), { statusCode: 404, code: 'TTS_ARTIFACT_NOT_FOUND' });
      res.writeHead(200, { 'content-type': artifact.contentType, 'content-length': artifact.buffer.length, 'cache-control': 'no-store' });
      res.end(artifact.buffer);
      return true;
    }
    return false;
  };
}

export { ttsUrl };
