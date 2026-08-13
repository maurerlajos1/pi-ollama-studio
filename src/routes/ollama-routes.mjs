function routeError(message, statusCode = 409, code = '') {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

export function createOllamaRoutes({ readBody, json, sendEvent, readConfig, getOllamaStatus, loadProfiles, probeOllamaRuntime, showModel, modelDiagnostics, createModelProfile, pullModel, syncPiModels, deleteModel, unloadModel, setModelReasoning, isLocalOllamaBaseUrl, managedOllama }) {
  return async function handleOllamaRoutes(req, res, url) {
    const { pathname, searchParams } = url;
    if (req.method === 'GET' && pathname === '/api/ollama/status') {
      json(res, 200, { ok: true, ollama: await getOllamaStatus(), profiles: (await loadProfiles()).profiles, managedOllama: managedOllama.status() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/test') {
      const body = await readBody(req);
      json(res, 200, { ok: true, result: await probeOllamaRuntime(body) });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/ollama/show') {
      json(res, 200, { ok: true, model: await showModel(searchParams.get('model')) });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/ollama/diagnostics') {
      const cfg = await readConfig();
      const model = searchParams.get('model');
      const contextLength = Number(searchParams.get('contextLength') || cfg.defaultContextLength);
      json(res, 200, { ok: true, diagnostics: await modelDiagnostics(model, contextLength, searchParams.get('kvType') || cfg.kvCacheType, Number(searchParams.get('parallel') || cfg.numParallel)) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/profile') {
      const body = await readBody(req);
      const profile = await createModelProfile(body, (event) => sendEvent('ollama_operation', { operation: 'create', model: body.name, event }));
      sendEvent('ollama_models_changed', await getOllamaStatus());
      json(res, 200, { ok: true, profile });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/pull') {
      const body = await readBody(req);
      const cfg = await readConfig();
      const model = String(body.model || '').trim();
      if (!model) throw routeError('Model is required', 400, 'MODEL_REQUIRED');
      await pullModel(model, (event) => sendEvent('ollama_operation', { operation: 'pull', model, event, runtime: { name: cfg.ollamaRuntimeName, baseUrl: cfg.ollamaBaseUrl, kind: cfg.ollamaRuntimeKind } }));
      await syncPiModels();
      const ollama = await getOllamaStatus();
      sendEvent('ollama_models_changed', ollama);
      json(res, 200, { ok: true, model, runtime: ollama.runtime });
      return true;
    }
    if (req.method === 'DELETE' && pathname === '/api/ollama/model') {
      const body = await readBody(req);
      await deleteModel(body.model);
      sendEvent('ollama_models_changed', await getOllamaStatus());
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/unload') {
      const body = await readBody(req);
      await unloadModel(body.model);
      sendEvent('ollama_models_changed', await getOllamaStatus());
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/sync') {
      json(res, 200, { ok: true, provider: await syncPiModels() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/ollama/toggle-reasoning') {
      const body = await readBody(req);
      await setModelReasoning(body.model, body.reasoning);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && ['/api/ollama/managed/start', '/api/ollama/managed/stop', '/api/ollama/managed/restart'].includes(pathname)) {
      const cfg = await readConfig();
      if (!isLocalOllamaBaseUrl(cfg.ollamaBaseUrl)) {
        throw routeError('Managed Ollama controls are available only for a local Ollama endpoint', 409, 'OLLAMA_RUNTIME_NOT_LOCAL');
      }
      const action = pathname.split('/').pop();
      const owned = managedOllama.status().running;
      if (action === 'start' && !owned) {
        const active = await getOllamaStatus();
        if (active.online) {
          throw routeError('Ollama is already online, but it was not started by Studio. Studio will not replace or stop an external Ollama process.', 409, 'OLLAMA_EXTERNAL_PROCESS');
        }
      }
      if ((action === 'stop' || action === 'restart') && !owned) {
        throw routeError('This Ollama process was not started by Studio. Stop or restart it from the terminal or application that owns it.', 409, 'OLLAMA_NOT_MANAGED');
      }
      const status = await managedOllama[action]();
      sendEvent('ollama_managed_status', status);
      json(res, 200, { ok: true, status });
      return true;
    }
    return false;
  };
}
