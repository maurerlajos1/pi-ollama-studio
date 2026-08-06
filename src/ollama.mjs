import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_DIR, PI_MODELS_PATH, readConfig, readJson, writeJsonAtomic } from './config.mjs';

const PROFILE_PATH = path.join(APP_DIR, 'profiles.json');

function normalizedBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseError(response) {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text || `${response.status} ${response.statusText}`;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

export async function ollamaJson(apiPath, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const cfg = await readConfig();
  const response = await fetchWithTimeout(`${normalizedBase(cfg.ollamaBaseUrl)}${apiPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }, timeoutMs);
  if (!response.ok) throw new Error(await parseError(response));
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function ollamaStream(apiPath, body, onEvent = null, timeoutMs = 24 * 60 * 60 * 1000) {
  const cfg = await readConfig();
  const response = await fetchWithTimeout(`${normalizedBase(cfg.ollamaBaseUrl)}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true })
  }, timeoutMs);
  if (!response.ok) throw new Error(await parseError(response));
  if (!response.body) return [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const collect = typeof onEvent !== 'function';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { event = { status: line }; }
      if (collect) events.push(event);
      if (typeof onEvent === 'function') onEvent(event);
      if (event.error) throw new Error(event.error);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    let event;
    try { event = JSON.parse(buffer.trim()); } catch { event = { status: buffer.trim() }; }
    if (collect) events.push(event);
    if (typeof onEvent === 'function') onEvent(event);
    if (event.error) throw new Error(event.error);
  }
  return events;
}

export async function getOllamaStatus() {
  const [version, tags, ps] = await Promise.allSettled([
    ollamaJson('/api/version', { timeoutMs: 3500 }),
    ollamaJson('/api/tags', { timeoutMs: 5000 }),
    ollamaJson('/api/ps', { timeoutMs: 5000 })
  ]);
  const online = version.status === 'fulfilled' || tags.status === 'fulfilled';
  return {
    online,
    modelsAvailable: tags.status === 'fulfilled',
    runningAvailable: ps.status === 'fulfilled',
    version: version.status === 'fulfilled' ? version.value.version : null,
    models: tags.status === 'fulfilled' ? (tags.value.models || []) : [],
    running: ps.status === 'fulfilled' ? (ps.value.models || []) : [],
    errors: [version, tags, ps].filter((item) => item.status === 'rejected').map((item) => item.reason?.message || String(item.reason))
  };
}

export async function showModel(model) {
  if (!model) throw new Error('Model is required');
  return ollamaJson('/api/show', { method: 'POST', body: { model, verbose: true }, timeoutMs: 120000 });
}

export async function loadProfiles() {
  return readJson(PROFILE_PATH, { profiles: [] });
}

export async function saveProfiles(value) {
  const normalized = { profiles: Array.isArray(value?.profiles) ? value.profiles : [] };
  await writeJsonAtomic(PROFILE_PATH, normalized);
  return normalized;
}

function sanitizeModelName(value) {
  const result = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!result) throw new Error('Profile name is required');
  if (result.length > 180) throw new Error('Profile name is too long');
  return result;
}

function numeric(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export async function createModelProfile(input, onEvent = () => {}) {
  const baseModel = String(input?.baseModel || '').trim();
  if (!baseModel) throw new Error('Base model is required');
  const model = sanitizeModelName(input?.name || `${baseModel.split(':')[0]}-studio-${input?.contextWindow || 32768}`);
  const contextWindow = Math.round(numeric(input?.contextWindow, 32768, 2048, 1048576));
  const maxTokens = Math.round(numeric(input?.maxTokens, 8192, 256, Math.min(contextWindow, 131072)));
  const parameters = {
    num_ctx: contextWindow,
    num_predict: maxTokens,
    temperature: numeric(input?.temperature, 0.2, 0, 2),
    top_p: numeric(input?.topP, 0.9, 0, 1),
    top_k: Math.round(numeric(input?.topK, 40, 0, 1000)),
    min_p: numeric(input?.minP, 0.05, 0, 1),
    repeat_penalty: numeric(input?.repeatPenalty, 1.05, 0, 2),
    seed: Math.round(numeric(input?.seed, -1, -1, 2147483647))
  };

  // ── Advanced Modelfile Parameters ─────────────────────────────────────────
  if (input?.mirostat !== undefined && input?.mirostat !== 0 && input?.mirostat !== '0') {
    parameters.mirostat = Math.round(numeric(input.mirostat, 0, 0, 2));
    if (input?.mirostatEta) parameters.mirostat_eta = numeric(input.mirostatEta, 0.1, 0, 1);
    if (input?.mirostatTau) parameters.mirostat_tau = numeric(input.mirostatTau, 5.0, 0, 10);
  }
  if (Array.isArray(input?.stop) && input.stop.length) {
    parameters.stop = input.stop.map(String).filter(Boolean);
  } else if (typeof input?.stop === 'string' && input.stop.trim()) {
    parameters.stop = input.stop.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const modelfilePayload = {
    model,
    from: baseModel,
    parameters
  };
  if (typeof input?.system === 'string' && input.system.trim()) {
    modelfilePayload.system = input.system.trim();
  }

  await ollamaStream('/api/create', modelfilePayload, onEvent);

  const profiles = await loadProfiles();
  const profile = {
    id: model,
    name: String(input?.displayName || model),
    baseModel,
    contextWindow,
    maxTokens,
    reasoning: Boolean(input?.reasoning),
    input: input?.vision ? ['text', 'image'] : ['text'],
    parameters,
    createdAt: new Date().toISOString()
  };
  profiles.profiles = profiles.profiles.filter((item) => item.id !== model);
  profiles.profiles.push(profile);
  await saveProfiles(profiles);
  await syncPiModels({ extraProfiles: [profile] });
  return profile;
}

export async function pullModel(model, onEvent = () => {}) {
  const value = String(model || '').trim();
  if (!value) throw new Error('Model is required');
  return ollamaStream('/api/pull', { model: value }, onEvent);
}

export async function deleteModel(model) {
  const value = String(model || '').trim();
  if (!value) throw new Error('Model is required');
  const result = await ollamaJson('/api/delete', { method: 'DELETE', body: { model: value }, timeoutMs: 120000 });
  const profiles = await loadProfiles();
  profiles.profiles = profiles.profiles.filter((item) => item.id !== value);
  await saveProfiles(profiles);
  await removePiModel(value);
  return result;
}

export async function unloadModel(targetModel) {
  const value = String(targetModel || '').trim();
  if (value) {
    await ollamaJson('/api/generate', {
      method: 'POST',
      body: { model: value, prompt: '', keep_alive: 0, stream: false },
      timeoutMs: 30000
    }).catch(() => {});
    return { ok: true, unloaded: [value] };
  }
  const ps = await ollamaJson('/api/ps', { timeoutMs: 5000 }).catch(() => ({ models: [] }));
  const running = ps.models || [];
  const unloaded = [];
  for (const item of running) {
    const name = item.model || item.name;
    if (name) {
      await ollamaJson('/api/generate', {
        method: 'POST',
        body: { model: name, prompt: '', keep_alive: 0, stream: false },
        timeoutMs: 30000
      }).catch(() => {});
      unloaded.push(name);
    }
  }
  return { ok: true, unloaded };
}

function parseParameters(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const raw = match[2].trim();
    const num = Number(raw);
    result[match[1]] = Number.isFinite(num) ? num : raw;
  }
  return result;
}

function findInfo(modelInfo, suffix, architecture) {
  if (!modelInfo || typeof modelInfo !== 'object') return undefined;
  const candidates = [
    architecture ? `${architecture}.${suffix}` : null,
    ...Object.keys(modelInfo).filter((key) => key.endsWith(`.${suffix}`))
  ].filter(Boolean);
  for (const key of candidates) {
    if (modelInfo[key] !== undefined) return modelInfo[key];
  }
  return undefined;
}

export function estimateKvCache(show, contextLength, kvType = 'q8_0', parallel = 1) {
  const info = show?.model_info || show?.modelInfo || {};
  const architecture = info['general.architecture'] || show?.details?.family || '';
  const layers = Number(findInfo(info, 'block_count', architecture));
  const heads = Number(findInfo(info, 'attention.head_count', architecture));
  const kvHeads = Number(findInfo(info, 'attention.head_count_kv', architecture) || heads);
  const embedding = Number(findInfo(info, 'embedding_length', architecture));
  const keyLength = Number(findInfo(info, 'attention.key_length', architecture));
  const valueLength = Number(findInfo(info, 'attention.value_length', architecture));
  const ctx = Number(contextLength);
  const slots = Math.max(1, Number(parallel) || 1);
  const bytesPerValue = kvType === 'f16' ? 2 : kvType === 'q4_0' ? 0.5 : 1;

  if (![layers, kvHeads, ctx].every(Number.isFinite) || layers <= 0 || kvHeads <= 0 || ctx <= 0) {
    return { bytes: null, formatted: null, reason: 'Model attention metadata is incomplete', architecture };
  }

  // Hybrid SSM/Attention models (e.g. Qwen3.6, Jamba) only allocate KV cache for
  // their full-attention layers. The rest are SSM/Mamba blocks with no KV cache.
  // full_attention_interval=N means every N-th block is a full attention layer.
  const fullAttentionInterval = Number(findInfo(info, 'full_attention_interval', architecture));
  const effectiveLayers = (Number.isFinite(fullAttentionInterval) && fullAttentionInterval > 1)
    ? Math.ceil(layers / fullAttentionInterval)
    : layers;

  let dimensions;
  if (Number.isFinite(keyLength) && Number.isFinite(valueLength) && keyLength > 0 && valueLength > 0) {
    dimensions = keyLength + valueLength;
  } else if (Number.isFinite(embedding) && Number.isFinite(heads) && heads > 0) {
    dimensions = 2 * (embedding / heads);
  } else {
    return { bytes: null, formatted: null, reason: 'Head dimension metadata is incomplete', architecture };
  }
  const bytes = Math.ceil(effectiveLayers * kvHeads * dimensions * ctx * bytesPerValue * slots);
  return {
    bytes,
    formatted: formatBytes(bytes),
    architecture,
    layers,
    effectiveLayers,
    fullAttentionInterval: Number.isFinite(fullAttentionInterval) && fullAttentionInterval > 1 ? fullAttentionInterval : null,
    heads,
    kvHeads,
    dimensions,
    bytesPerValue,
    parallel: slots,
    contextLength: ctx,
    kvType
  };
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = bytes;
  let unit = -1;
  do { current /= 1024; unit += 1; } while (current >= 1024 && unit < units.length - 1);
  return `${current >= 100 ? current.toFixed(0) : current >= 10 ? current.toFixed(1) : current.toFixed(2)} ${units[unit]}`;
}

export async function syncPiModels({ extraProfiles = [] } = {}) {
  const cfg = await readConfig();
  const status = await getOllamaStatus();
  const stored = await loadProfiles();
  const profiles = [...stored.profiles, ...extraProfiles];
  const profileMap = new Map(profiles.map((item) => [item.id, item]));
  const current = await readJson(PI_MODELS_PATH, { providers: {} });
  if (!current.providers || typeof current.providers !== 'object') current.providers = {};
  const existingProvider = current.providers.ollama || {};
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
  const installedIds = new Set(status.models.map((item) => item.model || item.name).filter(Boolean));
  const retainedModels = status.modelsAvailable ? existingModels.filter((item) => installedIds.has(item.id)) : existingModels;
  const existingMap = new Map(retainedModels.map((item) => [item.id, item]));

  for (const item of status.models) {
    const id = item.model || item.name;
    if (!id) continue;
    const profile = profileMap.get(id);
    const prior = existingMap.get(id) || {};
    const rawInput = profile?.input || prior.input || ['text'];
    const input = Array.isArray(rawInput)
      ? rawInput.map(String)
      : typeof rawInput === 'string'
        ? rawInput.split(/\s+/).filter(Boolean)
        : ['text'];
    existingMap.set(id, {
      ...prior,
      id,
      name: profile?.name || prior.name || id,
      reasoning: profile?.reasoning ?? prior.reasoning ?? /qwen3|deepseek|reason|thinking/i.test(id),
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(prior.cost || {}) },
      contextWindow: profile?.contextWindow || prior.contextWindow || cfg.defaultContextLength,
      maxTokens: profile?.maxTokens || prior.maxTokens || Math.min(8192, cfg.defaultContextLength)
    });
  }

  current.providers.ollama = {
    ...existingProvider,
    baseUrl: `${normalizedBase(cfg.ollamaBaseUrl)}/v1`,
    api: 'openai-completions',
    apiKey: 'ollama',
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false
    },
    models: [...existingMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  };
  await writeJsonAtomic(PI_MODELS_PATH, current);
  return current.providers.ollama;
}

export async function removePiModel(model) {
  const current = await readJson(PI_MODELS_PATH, { providers: {} });
  const provider = current.providers?.ollama;
  if (!provider || !Array.isArray(provider.models)) return;
  provider.models = provider.models.filter((item) => item.id !== model);
  await writeJsonAtomic(PI_MODELS_PATH, current);
}

export async function modelDiagnostics(model, contextLength, kvType, parallel) {
  const [show, status] = await Promise.all([showModel(model), getOllamaStatus()]);
  const parameters = parseParameters(show.parameters);
  const effectiveContext = Number(contextLength || parameters.num_ctx || status.running.find((item) => (item.model || item.name) === model)?.context_length || 0);
  return {
    show,
    parameters,
    kv: estimateKvCache(show, effectiveContext, kvType, parallel),
    running: status.running.find((item) => (item.model || item.name) === model) || null
  };
}
