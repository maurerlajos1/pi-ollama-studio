import {
  fetchProviderModels,
  loadProviderProfiles,
  normalizeProviderId,
  probeProviderModel,
  providerPublicView,
  refreshProviderModels,
  removeProviderProfile,
  saveProviderProfile,
  syncProvidersToPi,
  updateProviderModel
} from '../providers.mjs';

export function createProviderRoutes({ readBody, json, sendEvent }) {
  return async function handleProviderRoutes(req, res, url) {
    const { pathname, searchParams } = url;
    if (req.method === 'GET' && pathname === '/api/providers') {
      const stored = await loadProviderProfiles();
      json(res, 200, { ok: true, providers: stored.providers.map((item) => providerPublicView(item)) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/providers/save') {
      const body = await readBody(req);
      const provider = await saveProviderProfile(body.provider || body);
      sendEvent('providers_changed', { providerId: provider.id, action: 'save' });
      json(res, 200, { ok: true, provider: providerPublicView(provider) });
      return true;
    }
    if (req.method === 'DELETE' && pathname === '/api/providers') {
      const body = await readBody(req);
      const result = await removeProviderProfile(body.providerId || body.id);
      sendEvent('providers_changed', { providerId: result.id, action: 'remove' });
      json(res, 200, { ok: true, ...result });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/providers/models') {
      const body = await readBody(req);
      const result = await refreshProviderModels(body.providerId || body.id);
      sendEvent('providers_changed', { providerId: result.provider.id, action: 'models' });
      json(res, 200, { ok: true, provider: providerPublicView(result.provider), latencyMs: result.latencyMs });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/providers/test') {
      const body = await readBody(req);
      const result = await fetchProviderModels(body.provider || body);
      json(res, 200, { ok: true, latencyMs: result.latencyMs, modelCount: result.models.length, models: result.models });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/providers/probe-model') {
      const body = await readBody(req);
      const stored = await loadProviderProfiles();
      const id = normalizeProviderId(body.providerId);
      const provider = stored.providers.find((item) => item.id === id);
      if (!provider) throw Object.assign(new Error(`Provider not found: ${id}`), { statusCode: 404 });
      const model = await probeProviderModel(provider, body.model || { id: body.modelId });
      const updated = await updateProviderModel(id, model, { expectedRevision: provider.revision });
      sendEvent('providers_changed', { providerId: id, modelId: model.id, action: 'probe' });
      json(res, 200, { ok: true, provider: providerPublicView(updated.provider), model });
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/providers/model') {
      const body = await readBody(req);
      const result = await updateProviderModel(body.providerId, body.model || body);
      sendEvent('providers_changed', { providerId: result.provider.id, modelId: result.model.id, action: 'model-update' });
      json(res, 200, { ok: true, provider: providerPublicView(result.provider), model: result.model });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/providers/sync') {
      const models = await syncProvidersToPi();
      sendEvent('providers_changed', { action: 'sync' });
      json(res, 200, { ok: true, models });
      return true;
    }
    return false;
  };
}
