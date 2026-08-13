import path from 'node:path';
import { APP_DIR, PI_MODELS_PATH, readJson, readJsonStrict, serializeMutation, writeJsonAtomic } from './config.mjs';

export const PROVIDERS_PATH = path.join(APP_DIR, 'providers.json');
const SUPPORTED_APIS = new Set(['auto', 'openai-responses', 'openai-completions']);
const OVERRIDE_KEYS = ['contextWindow', 'maxTokens', 'tools', 'jsonSchema', 'vision', 'reasoning'];

function cleanText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeOpenAiBaseUrl(value) {
  const raw = cleanText(value, 2048).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) throw Object.assign(new Error('Provider Base URL must use http:// or https://'), { statusCode: 400 });
  return /\/v\d+(?:beta)?$/i.test(raw) ? raw : `${raw}/v1`;
}

export function normalizeProviderId(value) {
  const id = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id === 'ollama') throw Object.assign(new Error('Provider ID is required and cannot replace the managed Ollama provider'), { statusCode: 400 });
  return id;
}

function normalizeEnvName(value) {
  const envName = cleanText(value, 120);
  if (envName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw Object.assign(new Error('API key environment variable name is invalid'), { statusCode: 400 });
  return envName;
}

function numberOrNull(value, min = 1, max = 4_000_000) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

export function normalizeModelOverrides(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    contextWindow: numberOrNull(source.contextWindow, 1024),
    maxTokens: numberOrNull(source.maxTokens, 1),
    tools: boolOrNull(source.tools),
    jsonSchema: boolOrNull(source.jsonSchema),
    vision: boolOrNull(source.vision),
    reasoning: boolOrNull(source.reasoning)
  };
}

export function normalizeProviderProfile(input = {}, prior = null) {
  const id = normalizeProviderId(input.id || prior?.id || input.name);
  const api = cleanText(input.api || prior?.api || 'auto', 40).toLowerCase();
  if (!SUPPORTED_APIS.has(api)) throw Object.assign(new Error(`Unsupported provider API: ${api}`), { statusCode: 400 });
  const profile = {
    id,
    name: cleanText(input.name || prior?.name || id, 120) || id,
    baseUrl: normalizeOpenAiBaseUrl(input.baseUrl || prior?.baseUrl),
    api,
    apiKeyEnv: normalizeEnvName(input.apiKeyEnv ?? prior?.apiKeyEnv ?? ''),
    authHeader: input.authHeader == null ? (prior?.authHeader !== false) : Boolean(input.authHeader),
    compat: {
      supportsDeveloperRole: input.compat?.supportsDeveloperRole ?? prior?.compat?.supportsDeveloperRole ?? true,
      supportsReasoningEffort: input.compat?.supportsReasoningEffort ?? prior?.compat?.supportsReasoningEffort ?? true
    },
    models: Array.isArray(input.models) ? input.models.map(normalizeProviderModel).filter((item) => item.id) : (Array.isArray(prior?.models) ? prior.models : []),
    revision: Math.max(0, Math.floor(Number(input.revision ?? prior?.revision ?? 0) || 0)),
    updatedAt: cleanText(input.updatedAt || prior?.updatedAt, 80) || new Date().toISOString()
  };
  return profile;
}

export function normalizeProviderModel(input = {}) {
  const id = cleanText(input.id || input.model, 300);
  if (!id) return { id: '' };
  const detected = input.detected && typeof input.detected === 'object' ? input.detected : {};
  const overrides = normalizeModelOverrides(input.overrides || {});
  return {
    id,
    name: cleanText(input.name || id, 300) || id,
    detected: {
      api: SUPPORTED_APIS.has(detected.api) && detected.api !== 'auto' ? detected.api : null,
      contextWindow: numberOrNull(detected.contextWindow, 1024),
      maxTokens: numberOrNull(detected.maxTokens, 1),
      tools: boolOrNull(detected.tools),
      jsonSchema: boolOrNull(detected.jsonSchema),
      vision: boolOrNull(detected.vision),
      reasoning: boolOrNull(detected.reasoning),
      probedAt: detected.probedAt || null
    },
    overrides
  };
}

export function effectiveProviderModel(model = {}, providerApi = 'auto') {
  const normalized = normalizeProviderModel(model);
  const effective = { ...normalized.detected };
  for (const key of OVERRIDE_KEYS) {
    if (normalized.overrides[key] !== null) effective[key] = normalized.overrides[key];
  }
  const api = normalized.detected.api || (providerApi === 'auto' ? 'openai-completions' : providerApi);
  return {
    id: normalized.id,
    name: normalized.name || normalized.id,
    api,
    reasoning: effective.reasoning ?? false,
    input: effective.vision ? ['text', 'image'] : ['text'],
    contextWindow: effective.contextWindow || 128000,
    maxTokens: Math.min(effective.maxTokens || 8192, effective.contextWindow || 128000),
    capabilities: {
      tools: effective.tools,
      jsonSchema: effective.jsonSchema,
      vision: effective.vision,
      reasoning: effective.reasoning
    },
    detected: normalized.detected,
    overrides: normalized.overrides
  };
}

function normalizeProviderStore(stored) {
  const providers = Array.isArray(stored?.providers) ? stored.providers.map((item) => normalizeProviderProfile(item, item)) : [];
  return { providers };
}

export async function loadProviderProfiles({ storePath = PROVIDERS_PATH } = {}) {
  return normalizeProviderStore(await readJson(storePath, { providers: [] }));
}

async function loadProviderProfilesStrict({ storePath = PROVIDERS_PATH } = {}) {
  return normalizeProviderStore(await readJsonStrict(storePath, { providers: [] }));
}

export async function saveProviderProfile(input, { storePath = PROVIDERS_PATH } = {}) {
  return serializeMutation(storePath, async () => {
    const rawStored = await readJsonStrict(storePath, { providers: [] });
    const stored = { providers: Array.isArray(rawStored?.providers) ? rawStored.providers.map((item) => normalizeProviderProfile(item, item)) : [] };
    const id = normalizeProviderId(input?.id || input?.name);
    const index = stored.providers.findIndex((item) => item.id === id);
    const profile = normalizeProviderProfile({ ...input, id }, index >= 0 ? stored.providers[index] : null);
    profile.revision = Math.max(0, Number(index >= 0 ? stored.providers[index].revision : 0) || 0) + 1;
    profile.updatedAt = new Date().toISOString();
    if (index >= 0) stored.providers[index] = profile;
    else stored.providers.push(profile);
    stored.providers.sort((a, b) => a.name.localeCompare(b.name));
    await writeJsonAtomic(storePath, stored);
    return profile;
  });
}

export async function removeProviderProfile(providerId, { storePath = PROVIDERS_PATH, modelsPath = PI_MODELS_PATH } = {}) {
  const id = normalizeProviderId(providerId);
  const removed = await serializeMutation(storePath, async () => {
    const rawStored = await readJsonStrict(storePath, { providers: [] });
    const stored = { providers: Array.isArray(rawStored?.providers) ? rawStored.providers.map((item) => normalizeProviderProfile(item, item)) : [] };
    const next = { providers: stored.providers.filter((item) => item.id !== id) };
    await writeJsonAtomic(storePath, next);
    return stored.providers.length !== next.providers.length;
  });
  await serializeMutation(modelsPath, async () => {
    const piModels = await readJsonStrict(modelsPath, { providers: {} });
    if (piModels.providers && Object.prototype.hasOwnProperty.call(piModels.providers, id)) {
      delete piModels.providers[id];
      await writeJsonAtomic(modelsPath, piModels);
    }
  });
  return { removed, id };
}


function providerHeaders(profile, env, includeJson = false) {
  const headers = {};
  if (includeJson) headers['content-type'] = 'application/json';
  const key = profile.apiKeyEnv ? env?.[profile.apiKeyEnv] : '';
  if (key && profile.authHeader !== false) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: options.signal || controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) {
      const message = body?.error?.message || body?.error || body?.message || text || `${response.status} ${response.statusText}`;
      throw Object.assign(new Error(String(message)), { statusCode: 502, upstreamStatus: response.status, responseBody: body });
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderModels(profileInput, { env = process.env } = {}) {
  const profile = normalizeProviderProfile(profileInput, profileInput);
  const started = Date.now();
  const { body } = await fetchJson(`${profile.baseUrl}/models`, { headers: providerHeaders(profile, env) }, 10000);
  const rawModels = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (rawModels === null) throw Object.assign(new Error('Provider /models returned an invalid model inventory'), { statusCode:502, code:'PROVIDER_MODELS_INVALID_RESPONSE' });
  const models = rawModels.map((item) => normalizeProviderModel({
    id: item?.id || item?.model,
    name: item?.name || item?.display_name || item?.id || item?.model,
    detected: {
      contextWindow: item?.context_window ?? item?.context_length ?? item?.max_model_len ?? item?.contextWindow,
      maxTokens: item?.max_output_tokens ?? item?.max_tokens ?? item?.maxTokens,
      reasoning: typeof item?.reasoning === 'boolean' ? item.reasoning : null,
      vision: Array.isArray(item?.input) ? item.input.includes('image') : (typeof item?.vision === 'boolean' ? item.vision : null)
    }
  })).filter((item) => item.id);
  return { profile, models, latencyMs: Date.now() - started };
}

function probePayload(api, modelId, capability) {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const tool = { type: 'function', name: 'pi_studio_probe', description: 'Pi Studio capability probe', parameters: schema };
  if (api === 'openai-responses') {
    const payload = { model: modelId, input: 'Return OK.', max_output_tokens: 8, stream: false };
    if (capability === 'tools') payload.tools = [tool];
    if (capability === 'jsonSchema') payload.text = { format: { type: 'json_schema', name: 'pi_studio_probe', schema, strict: true } };
    return payload;
  }
  const payload = { model: modelId, messages: [{ role: 'user', content: 'Return OK.' }], max_tokens: 8, stream: false };
  if (capability === 'tools') payload.tools = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: schema } }];
  if (capability === 'jsonSchema') payload.response_format = { type: 'json_schema', json_schema: { name: 'pi_studio_probe', schema, strict: true } };
  return payload;
}

async function probeRequest(profile, modelId, api, capability, env) {
  const endpoint = api === 'openai-responses' ? 'responses' : 'chat/completions';
  try {
    await fetchJson(`${profile.baseUrl}/${endpoint}`, {
      method: 'POST', headers: providerHeaders(profile, env, true), body: JSON.stringify(probePayload(api, modelId, capability))
    }, 20000);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message, status: error.upstreamStatus || null };
  }
}

export async function probeProviderModel(profileInput, modelInput, { env = process.env } = {}) {
  const profile = normalizeProviderProfile(profileInput, profileInput);
  const model = normalizeProviderModel(modelInput);
  if (!model.id) throw Object.assign(new Error('Model ID is required'), { statusCode: 400 });
  const order = profile.api === 'auto' ? ['openai-responses', 'openai-completions'] : [profile.api];
  let selectedApi = null;
  const apiResults = {};
  for (const api of order) {
    const base = await probeRequest(profile, model.id, api, 'base', env);
    apiResults[api] = { base };
    if (base.ok) { selectedApi = api; break; }
  }
  if (!selectedApi) throw Object.assign(new Error(`Model probe failed for ${model.id}`), { statusCode: 502, details: apiResults });
  const [tools, jsonSchema] = await Promise.all([
    probeRequest(profile, model.id, selectedApi, 'tools', env),
    probeRequest(profile, model.id, selectedApi, 'jsonSchema', env)
  ]);
  apiResults[selectedApi].tools = tools;
  apiResults[selectedApi].jsonSchema = jsonSchema;
  const detected = {
    ...model.detected,
    api: selectedApi,
    tools: tools.ok,
    jsonSchema: jsonSchema.ok,
    probedAt: new Date().toISOString()
  };
  return { ...model, detected, probe: apiResults };
}

export async function updateProviderModel(providerId, modelInput, { storePath = PROVIDERS_PATH, expectedRevision = null } = {}) {
  const id = normalizeProviderId(providerId);
  const model = normalizeProviderModel(modelInput);
  if (!model.id) throw Object.assign(new Error('Model ID is required'), { statusCode: 400 });
  return serializeMutation(storePath, async () => {
    const stored = await loadProviderProfilesStrict({ storePath });
    const provider = stored.providers.find((item) => item.id === id);
    if (!provider) throw Object.assign(new Error(`Provider not found: ${id}`), { statusCode: 404 });
    if (expectedRevision != null && Number(provider.revision || 0) !== Number(expectedRevision)) throw Object.assign(new Error('Provider changed while the model operation was running'), { statusCode: 409, code: 'PROVIDER_STALE' });
    const index = provider.models.findIndex((item) => item.id === model.id);
    if (index >= 0) provider.models[index] = model; else provider.models.push(model);
    provider.revision = Number(provider.revision || 0) + 1;
    provider.updatedAt = new Date().toISOString();
    await writeJsonAtomic(storePath, stored);
    return { provider, model };
  });
}

export async function refreshProviderModels(providerId, { storePath = PROVIDERS_PATH, env = process.env } = {}) {
  const id = normalizeProviderId(providerId);
  const before = await loadProviderProfilesStrict({ storePath });
  const snapshot = before.providers.find((item) => item.id === id);
  if (!snapshot) throw Object.assign(new Error(`Provider not found: ${id}`), { statusCode: 404 });
  const result = await fetchProviderModels(snapshot, { env });
  return serializeMutation(storePath, async () => {
    const stored = await loadProviderProfilesStrict({ storePath });
    const provider = stored.providers.find((item) => item.id === id);
    if (!provider) throw Object.assign(new Error(`Provider not found: ${id}`), { statusCode: 404 });
    if (Number(provider.revision || 0) !== Number(snapshot.revision || 0)) throw Object.assign(new Error('Provider changed while models were refreshing'), { statusCode: 409, code: 'PROVIDER_STALE' });
    const prior = new Map(provider.models.map((item) => [item.id, item]));
    provider.models = result.models.map((item) => {
      const old = prior.get(item.id);
      return normalizeProviderModel({ ...item, detected: { ...(old?.detected || {}), ...(item.detected || {}) }, overrides: old?.overrides || {} });
    });
    provider.revision = Number(provider.revision || 0) + 1;
    provider.updatedAt = new Date().toISOString();
    await writeJsonAtomic(storePath, stored);
    return { provider, latencyMs: result.latencyMs };
  });
}

export async function syncProvidersToPi({ storePath = PROVIDERS_PATH, modelsPath = PI_MODELS_PATH } = {}) {
  const stored = await loadProviderProfilesStrict({ storePath });
  return serializeMutation(modelsPath, async () => {
    const piModels = await readJsonStrict(modelsPath, { providers: {} });
    if (!piModels.providers || typeof piModels.providers !== 'object') piModels.providers = {};
    for (const profile of stored.providers) {
      const { apiKey: _staleApiKey, ...previous } = piModels.providers[profile.id] || {};
      piModels.providers[profile.id] = {
        ...previous,
        baseUrl: profile.baseUrl,
        api: profile.api === 'auto' ? 'openai-completions' : profile.api,
        ...(profile.apiKeyEnv ? { apiKey: `$${profile.apiKeyEnv}` } : {}),
        authHeader: profile.authHeader !== false,
        compat: { ...(profile.compat || {}) },
        models: profile.models.map((model) => {
          const effective = effectiveProviderModel(model, profile.api);
          return {
            id: effective.id, name: effective.name, api: effective.api, reasoning: effective.reasoning, input: effective.input,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: effective.contextWindow, maxTokens: effective.maxTokens
          };
        })
      };
    }
    await writeJsonAtomic(modelsPath, piModels);
    return piModels;
  });
}


export function providerPublicView(profile, env = process.env) {
  return {
    ...profile,
    apiKeyAvailable: Boolean(profile.apiKeyEnv && env?.[profile.apiKeyEnv]),
    models: profile.models.map((model) => ({ ...model, effective: effectiveProviderModel(model, profile.api) }))
  };
}

export const __test = { probePayload, normalizeEnvName };
