function lifecycleError(message, code) {
  return Object.assign(new Error(message), { statusCode: 503, code });
}

export function modelSelectionUsesOllama(modelId, provider = '') {
  const selectedProvider = String(provider || '').trim();
  if (selectedProvider) return selectedProvider === 'ollama';
  const selectedModel = String(modelId || '').trim();
  if (!selectedModel || selectedModel.startsWith('ollama/')) return true;
  if (selectedModel.startsWith('hf.co/')) return true;
  if (!selectedModel.includes('/')) return true;
  return selectedModel.split('/')[0] === 'ollama';
}

export async function ensureOllamaRuntimeForPi({
  modelId,
  provider = '',
  baseUrl,
  getStatus,
  isLocalBaseUrl,
  managedOllama,
  timeoutMs = 20_000,
  pollIntervalMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!modelSelectionUsesOllama(modelId, provider)) return { required: false, started: false, status: null };

  let status = await getStatus();
  if (status?.online) return { required: true, started: false, status };
  if (!isLocalBaseUrl(baseUrl)) {
    throw lifecycleError(`The selected Ollama runtime is offline: ${baseUrl}. Studio cannot start a remote or LAN Ollama server.`, 'OLLAMA_REMOTE_OFFLINE');
  }

  let started = false;
  if (!managedOllama.status().running) {
    await managedOllama.start();
    started = true;
  }

  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20_000);
  while (Date.now() < deadline) {
    await sleep(Math.max(25, Number(pollIntervalMs) || 250));
    status = await getStatus();
    if (status?.online) return { required: true, started, status };
  }
  throw lifecycleError(`Studio started Ollama, but ${baseUrl} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`, 'OLLAMA_START_TIMEOUT');
}
