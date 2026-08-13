import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_DIR, PI_MODELS_PATH, readConfig, readJson, readJsonStrict, serializeMutation, writeJsonAtomic } from './config.mjs';

const PROFILE_PATH = path.join(APP_DIR, 'profiles.json');

function normalizedBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}


export function ollamaRuntimeIdentity(config) {
  const baseUrl = normalizedBase(config?.ollamaBaseUrl || '');
  return {
    id: `ollama-${crypto.createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}`,
    baseUrl,
    name: String(config?.ollamaRuntimeName || 'Ollama'),
    kind: String(config?.ollamaRuntimeKind || 'local')
  };
}

export function profileRuntimeCompatibility(profile, config) {
  const runtime = ollamaRuntimeIdentity(config);
  const boundUrl = normalizedBase(profile?.runtime?.baseUrl || profile?.runtimeBaseUrl || '');
  const boundId = String(profile?.runtime?.id || profile?.runtimeId || '');
  if (!boundUrl && !boundId) return { compatible: true, portable: true, runtime };
  return { compatible: (boundUrl && boundUrl === runtime.baseUrl) || (boundId && boundId === runtime.id), portable: false, runtime };
}

function modelAliases(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return new Set();
  const aliases = new Set([raw]);
  if (raw.endsWith(':latest')) aliases.add(raw.slice(0, -7));
  else aliases.add(`${raw}:latest`);
  return aliases;
}

function aliasesOverlap(a, b) {
  const right = b instanceof Set ? b : modelAliases(b);
  for (const value of (a instanceof Set ? a : modelAliases(a))) if (right.has(value)) return true;
  return false;
}

function profileStorageKey(profile) {
  const id = String(profile?.id || profile?.name || '').trim().toLowerCase();
  const boundUrl = normalizedBase(profile?.runtime?.baseUrl || profile?.runtimeBaseUrl || '').toLowerCase();
  const boundId = String(profile?.runtime?.id || profile?.runtimeId || '').trim().toLowerCase();
  return `${id}::runtime::${boundUrl ? `url:${boundUrl}` : boundId ? `id:${boundId}` : 'portable'}`;
}

function profilesForRuntime(profiles, config) {
  const selected = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const id = String(profile?.id || '').trim();
    if (!id) continue;
    const compatibility = profileRuntimeCompatibility(profile, config);
    if (!compatibility.compatible) continue;
    const key = id.toLowerCase();
    const score = compatibility.portable ? 1 : 2;
    const current = selected.get(key);
    if (!current || score > current.score) selected.set(key, { profile, score });
  }
  return [...selected.values()].map((item) => item.profile);
}
export function normalizeOllamaOpenAiBaseUrl(baseUrl) {
  const base = normalizedBase(baseUrl);
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function ollamaHeaders(cfg, includeJson = false) {
  const headers = {};
  if (includeJson) headers['content-type'] = 'application/json';
  const envName = String(cfg?.ollamaApiKeyEnv || '').trim();
  const apiKey = envName ? process.env[envName] : '';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return Object.keys(headers).length ? headers : undefined;
}

export function isLocalOllamaBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''));
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
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

async function ollamaJsonWithConfig(cfg, apiPath, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const response = await fetchWithTimeout(`${normalizedBase(cfg.ollamaBaseUrl)}${apiPath}`, {
    method,
    headers: ollamaHeaders(cfg, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body)
  }, timeoutMs);
  if (!response.ok) throw new Error(await parseError(response));
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function ollamaJson(apiPath, options = {}) {
  const cfg = await readConfig();
  return ollamaJsonWithConfig(cfg, apiPath, options);
}

export async function probeOllamaRuntime(input = {}) {
  const current = await readConfig();
  const cfg = {
    ...current,
    ollamaBaseUrl: String(input.ollamaBaseUrl || current.ollamaBaseUrl || '').trim(),
    ollamaApiKeyEnv: String(input.ollamaApiKeyEnv ?? current.ollamaApiKeyEnv ?? '').trim(),
    ollamaRuntimeKind: String(input.ollamaRuntimeKind || current.ollamaRuntimeKind || 'local').trim(),
    ollamaRuntimeName: String(input.ollamaRuntimeName || current.ollamaRuntimeName || 'Ollama').trim()
  };
  if (!/^https?:\/\//i.test(cfg.ollamaBaseUrl)) throw Object.assign(new Error('Ollama Base URL must use http:// or https://'), { statusCode: 400 });
  const started = Date.now();
  const [version, tags, ps] = await Promise.allSettled([
    ollamaJsonWithConfig(cfg, '/api/version', { timeoutMs: 6000 }),
    ollamaJsonWithConfig(cfg, '/api/tags', { timeoutMs: 8000 }),
    ollamaJsonWithConfig(cfg, '/api/ps', { timeoutMs: 8000 })
  ]);
  const online = version.status === 'fulfilled' || tags.status === 'fulfilled';
  if (!online) {
    const errors = [version, tags].filter((item) => item.status === 'rejected').map((item) => item.reason?.message || String(item.reason));
    throw Object.assign(new Error(errors[0] || 'Unable to reach Ollama runtime'), { statusCode: 502, details: errors });
  }
  return {
    online: true,
    latencyMs: Date.now() - started,
    version: version.status === 'fulfilled' ? version.value?.version || null : null,
    modelCount: tags.status === 'fulfilled' && Array.isArray(tags.value?.models) ? tags.value.models.length : null,
    models: tags.status === 'fulfilled' && Array.isArray(tags.value?.models) ? tags.value.models : [],
    running: ps.status === 'fulfilled' && Array.isArray(ps.value?.models) ? ps.value.models : [],
    modelsAvailable: tags.status === 'fulfilled' && Array.isArray(tags.value?.models),
    runningAvailable: ps.status === 'fulfilled' && Array.isArray(ps.value?.models),
    runtime: {
      ...ollamaRuntimeIdentity(cfg),
      local: isLocalOllamaBaseUrl(cfg.ollamaBaseUrl), authenticated: Boolean(cfg.ollamaApiKeyEnv),
      apiKeyEnv: cfg.ollamaApiKeyEnv || null, apiKeyAvailable: Boolean(cfg.ollamaApiKeyEnv && process.env[cfg.ollamaApiKeyEnv])
    }
  };
}

export async function ollamaStream(apiPath, body, onEvent = null, timeoutMs = 24 * 60 * 60 * 1000) {
  const cfg = await readConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  let reader = null;
  try {
    const response = await fetch(`${normalizedBase(cfg.ollamaBaseUrl)}${apiPath}`, {
      method: 'POST', headers: ollamaHeaders(cfg, true), body: JSON.stringify({ ...body, stream: true }), signal: controller.signal
    });
    if (!response.ok) throw new Error(await parseError(response));
    if (!response.body) return [];
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer=''; const events=[]; const collect=typeof onEvent !== 'function';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let index; while ((index=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,index).trim(); buffer=buffer.slice(index+1); if(!line)continue;
        let event; try{event=JSON.parse(line);}catch{event={status:line};}
        if(collect)events.push(event); if(typeof onEvent==='function')onEvent(event); if(event.error)throw new Error(event.error);
      }
      if(done)break;
    }
    if(buffer.trim()) { let event; try{event=JSON.parse(buffer.trim());}catch{event={status:buffer.trim()};} if(collect)events.push(event); if(typeof onEvent==='function')onEvent(event); if(event.error)throw new Error(event.error); }
    return events;
  } catch (error) {
    if (controller.signal.aborted && !/timed out/i.test(String(error?.message||''))) throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer); if (reader) await reader.cancel().catch(()=>{});
  }
}

let lastKnownModelsByRuntime = new Map();

export async function getOllamaStatus(configOverride = null) {
  const stored = await readConfig();
  const cfg = configOverride ? { ...stored, ...configOverride } : stored;
  const runtimeKey = normalizedBase(cfg.ollamaBaseUrl);
  const [version, tags, ps] = await Promise.allSettled([
    ollamaJsonWithConfig(cfg, '/api/version', { timeoutMs: 3500 }),
    ollamaJsonWithConfig(cfg, '/api/tags', { timeoutMs: 5000 }),
    ollamaJsonWithConfig(cfg, '/api/ps', { timeoutMs: 5000 })
  ]);
  const online = version.status === 'fulfilled' || tags.status === 'fulfilled';
  if (tags.status === 'fulfilled' && Array.isArray(tags.value?.models)) {
    lastKnownModelsByRuntime.set(runtimeKey, tags.value.models);
  }
  return {
    online,
    runtime: {
      ...ollamaRuntimeIdentity(cfg),
      local: isLocalOllamaBaseUrl(cfg.ollamaBaseUrl),
      authenticated: Boolean(cfg.ollamaApiKeyEnv),
      apiKeyEnv: cfg.ollamaApiKeyEnv || null,
      apiKeyAvailable: Boolean(cfg.ollamaApiKeyEnv && process.env[cfg.ollamaApiKeyEnv])
    },
    modelsAvailable: tags.status === 'fulfilled' && Array.isArray(tags.value?.models),
    runningAvailable: ps.status === 'fulfilled' && Array.isArray(ps.value?.models),
    version: version.status === 'fulfilled' ? version.value.version : null,
    models: tags.status === 'fulfilled' && Array.isArray(tags.value?.models) ? tags.value.models : (lastKnownModelsByRuntime.get(runtimeKey) || []),
    running: ps.status === 'fulfilled' && Array.isArray(ps.value?.models) ? ps.value.models : [],
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
  return serializeMutation(PROFILE_PATH, async()=>{await readJsonStrict(PROFILE_PATH,{profiles:[]});await writeJsonAtomic(PROFILE_PATH, normalized);return normalized;});
}

async function mutateProfiles(mutator) {
  return serializeMutation(PROFILE_PATH, async()=>{const raw=await readJsonStrict(PROFILE_PATH,{profiles:[]});const current={profiles:Array.isArray(raw?.profiles)?raw.profiles:[]};const next=await mutator(current)||current;const normalized={profiles:Array.isArray(next?.profiles)?next.profiles:[]};await writeJsonAtomic(PROFILE_PATH,normalized);return normalized;});
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
  const cfg = await readConfig();
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

  const profile = {
    id: model,
    name: String(input?.displayName || model),
    baseModel,
    contextWindow,
    maxTokens,
    reasoning: Boolean(input?.reasoning),
    input: input?.vision ? ['text', 'image'] : ['text'],
    parameters,
    runtime: ollamaRuntimeIdentity(cfg),
    portable: Boolean(input?.portable),
    createdAt: new Date().toISOString()
  };
  if (profile.portable) delete profile.runtime;
  await mutateProfiles((profiles) => {
    const key = profileStorageKey(profile);
    profiles.profiles = profiles.profiles.filter((item) => profileStorageKey(item) !== key);
    profiles.profiles.push(profile);
    return profiles;
  });
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
  const cfg = await readConfig();
  const result = await ollamaJson('/api/delete', { method: 'DELETE', body: { model: value }, timeoutMs: 120000 });
  await mutateProfiles((profiles) => {
    profiles.profiles = profiles.profiles.filter((item) => {
      if (!aliasesOverlap(item?.id, value)) return true;
      const compatibility = profileRuntimeCompatibility(item, cfg);
      // Deleting a model is endpoint-local. Keep portable/legacy profiles and
      // profiles owned by another Ollama runtime.
      return compatibility.portable || !compatibility.compatible;
    });
    return profiles;
  });
  await removePiModel(value);
  return result;
}

export async function unloadModel(targetModel, { request = ollamaJson } = {}) {
  const value = String(targetModel || '').trim();
  if (value) {
    await request('/api/generate', {
      method: 'POST',
      body: { model: value, prompt: '', keep_alive: 0, stream: false },
      timeoutMs: 30000
    });
    return { ok: true, unloaded: [value] };
  }
  const ps = await request('/api/ps', { timeoutMs: 5000 });
  const running = Array.isArray(ps?.models) ? ps.models : [];
  const unloaded = [];
  for (const item of running) {
    const name = item.model || item.name;
    if (name) {
      await request('/api/generate', {
        method: 'POST',
        body: { model: name, prompt: '', keep_alive: 0, stream: false },
        timeoutMs: 30000
      });
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
  const latestCfg = await readConfig();
  if (normalizedBase(latestCfg.ollamaBaseUrl) !== normalizedBase(cfg.ollamaBaseUrl)) {
    throw Object.assign(new Error('Ollama runtime changed while models were refreshing'), { statusCode: 409, code: 'OLLAMA_RUNTIME_STALE' });
  }

  // Resolve duplicate profile IDs deterministically: a profile bound to the
  // current runtime wins; a portable/legacy profile is only a fallback.
  const profiles = profilesForRuntime([...(stored.profiles || []), ...extraProfiles], cfg);
  const profileByAlias = new Map();
  for (const profile of profiles) {
    for (const alias of modelAliases(profile.id)) profileByAlias.set(alias, profile);
  }
  const installedAliases = new Set();
  for (const item of status.models || []) {
    const id = item?.model || item?.name;
    for (const alias of modelAliases(id)) installedAliases.add(alias);
  }
  const profileForModel = (id) => {
    for (const alias of modelAliases(id)) if (profileByAlias.has(alias)) return profileByAlias.get(alias);
    return null;
  };
  const profileInstalled = (profile) => {
    if (!status.modelsAvailable) return true;
    for (const alias of modelAliases(profile?.id)) if (installedAliases.has(alias)) return true;
    return false;
  };

  return serializeMutation(PI_MODELS_PATH, async () => {
    const commitCfg = await readConfig();
    if (normalizedBase(commitCfg.ollamaBaseUrl) !== normalizedBase(cfg.ollamaBaseUrl)) {
      throw Object.assign(new Error('Ollama runtime changed while models were refreshing'), { statusCode: 409, code: 'OLLAMA_RUNTIME_STALE' });
    }
    const current = await readJsonStrict(PI_MODELS_PATH, { providers: {} });
    if (!current.providers || typeof current.providers !== 'object') current.providers = {};
    const existingProvider = current.providers.ollama || {};
    const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
    const retainedModels = status.modelsAvailable
      ? existingModels.filter((item) => [...modelAliases(item.id)].some((alias) => installedAliases.has(alias)))
      : existingModels;
    const existingMap = new Map(retainedModels.map((item) => [item.id, item]));

    for (const item of status.models || []) {
      const id = String(item?.model || item?.name || '').trim();
      if (!id) continue;
      const profile = profileForModel(id);
      const prior = existingMap.get(id) || {};
      const rawInput = profile?.input || prior.input || ['text'];
      const input = Array.isArray(rawInput) ? rawInput.map(String) : typeof rawInput === 'string' ? rawInput.split(/\s+/).filter(Boolean) : ['text'];
      const entry = {
        ...prior,
        id,
        name: profile?.name || prior.name || id,
        reasoning: typeof profile?.reasoning === 'boolean' ? profile.reasoning : (typeof prior?.reasoning === 'boolean' ? prior.reasoning : /qwen3|deepseek|reason|thinking/i.test(id)),
        input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(prior.cost || {}) },
        contextWindow: profile?.contextWindow || prior.contextWindow || cfg.defaultContextLength,
        maxTokens: profile?.maxTokens || prior.maxTokens || Math.min(8192, cfg.defaultContextLength)
      };
      existingMap.set(id, entry);
      if (id.toLowerCase().endsWith(':latest')) {
        const shortId = id.slice(0, -7);
        existingMap.set(shortId, { ...entry, id: shortId });
      }
    }

    // Offline mode retains saved declarations, but when the runtime inventory is
    // available never advertise a Studio profile whose derived model is absent.
    for (const profile of profiles) {
      const id = String(profile.id || '').trim();
      if (!id || !profileInstalled(profile)) continue;
      const prior = existingMap.get(id) || {};
      const rawInput = profile.input || prior.input || ['text'];
      const input = Array.isArray(rawInput) ? rawInput.map(String) : ['text'];
      existingMap.set(id, {
        ...prior,
        id,
        name: profile.name || id,
        reasoning: typeof profile.reasoning === 'boolean' ? profile.reasoning : (typeof prior.reasoning === 'boolean' ? prior.reasoning : true),
        input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(prior.cost || {}) },
        contextWindow: profile.contextWindow || prior.contextWindow || cfg.defaultContextLength,
        maxTokens: profile.maxTokens || prior.maxTokens || Math.min(8192, cfg.defaultContextLength)
      });
    }

    current.providers.ollama = {
      ...existingProvider,
      baseUrl: normalizeOllamaOpenAiBaseUrl(cfg.ollamaBaseUrl),
      api: 'openai-completions',
      apiKey: cfg.ollamaApiKeyEnv ? `$${cfg.ollamaApiKeyEnv}` : 'ollama',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [...existingMap.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
    await writeJsonAtomic(PI_MODELS_PATH, current);
    return current.providers.ollama;
  });
}

export async function removePiModel(model) { return serializeMutation(PI_MODELS_PATH,async()=>{const current=await readJsonStrict(PI_MODELS_PATH,{providers:{}});const provider=current.providers?.ollama;if(!provider||!Array.isArray(provider.models))return;provider.models=provider.models.filter((item)=>item.id!==model);await writeJsonAtomic(PI_MODELS_PATH,current);}); }

export async function setModelReasoning(modelId, reasoningEnabled) {
  if (!modelId) return;
  const cleanId = String(modelId).startsWith('ollama/') ? String(modelId).slice(7) : String(modelId);
  const targetAliases = modelAliases(cleanId);
  const matches = (value) => aliasesOverlap(modelAliases(value), targetAliases);
  await serializeMutation(PI_MODELS_PATH, async () => {
    const current = await readJsonStrict(PI_MODELS_PATH, { providers: {} });
    const provider = current.providers?.ollama;
    if (provider && Array.isArray(provider.models)) {
      for (const item of provider.models) {
        if (matches(item.id) || matches(item.name)) item.reasoning = Boolean(reasoningEnabled);
      }
      await writeJsonAtomic(PI_MODELS_PATH, current);
    }
  });
  await mutateProfiles((stored) => {
    for (const profile of stored.profiles || []) {
      // Do not use baseModel or fuzzy substring matching: changing reasoning for
      // qwen must not mutate every derived profile that happens to use qwen.
      if (matches(profile.id) || matches(profile.name)) profile.reasoning = Boolean(reasoningEnabled);
    }
    return stored;
  });
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

export const __test = { modelAliases, aliasesOverlap, profileStorageKey, profilesForRuntime };
