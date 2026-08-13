function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

export function providerModelValue(providerId, modelId) {
  return `${String(providerId || '').trim()}/${String(modelId || '').trim()}`;
}

export function providerModelEntries(providers = []) {
  return providers.flatMap((provider) => (provider.models || []).map((model) => ({
    providerId: provider.id,
    providerName: provider.name || provider.id,
    model,
    value: providerModelValue(provider.id, model.id)
  })));
}

export function effectiveCapability(model, key) {
  const override = model?.overrides?.[key];
  if (override !== null && override !== undefined) return override;
  const detected = model?.detected?.[key];
  if (detected !== null && detected !== undefined) return detected;
  return model?.[key];
}

function validHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value || '').trim()).protocol); }
  catch { return false; }
}

export function providerFormState({ id = '', baseUrl = '' } = {}) {
  const hasId = Boolean(String(id).trim());
  const hasEndpoint = validHttpUrl(baseUrl);
  return { canTest: hasEndpoint, canSave: hasId && hasEndpoint };
}


function triState(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return '';
}

export function createProviderPanel({ root = document, api, post, put, del, toast = () => {}, getProviders, setProviders, onProvidersChanged = () => {} }) {
  const $ = (selector) => root.querySelector(selector);
  const confirmAction = (message) => typeof globalThis.confirm === 'function' && globalThis.confirm(message);
  let selectedProviderId = '';

  function selectedProvider() {
    const providers = getProviders() || [];
    return providers.find((item) => item.id === selectedProviderId) || providers[0] || null;
  }

  function renderList() {
    const host = $('#providerList');
    if (!host) return;
    const providers = getProviders() || [];
    if (!selectedProviderId && providers[0]) selectedProviderId = providers[0].id;
    host.innerHTML = providers.map((provider) => `<button type="button" class="provider-list-item ${provider.id === selectedProviderId ? 'active' : ''}" data-provider-id="${esc(provider.id)}"><strong>${esc(provider.name || provider.id)}</strong><span>${esc(provider.baseUrl || '')}</span><small>${provider.models?.length || 0} models · ${provider.apiKeyAvailable ? 'key available' : provider.apiKeyEnv ? `missing $${esc(provider.apiKeyEnv)}` : 'no key'}</small></button>`).join('') || '<div class="empty-state">No OpenAI-compatible providers configured.</div>';
    host.querySelectorAll?.('[data-provider-id]').forEach((button) => button.addEventListener('click', () => { selectedProviderId = button.dataset.providerId; render(); }));
  }

  function modelRow(provider, model) {
    const c = (key) => effectiveCapability(model, key);
    return `<div class="provider-model-row" data-provider-model="${esc(model.id)}">
      <div class="provider-model-heading"><strong>${esc(model.name || model.id)}</strong><code>${esc(model.id)}</code><button class="sm-btn" data-provider-probe="${esc(model.id)}">Probe</button></div>
      <div class="provider-model-grid">
        <label>Context<input data-provider-field="contextWindow" type="number" min="1024" placeholder="${esc(model.detected?.contextWindow || model.contextWindow || '')}" value="${esc(model.overrides?.contextWindow ?? '')}"></label>
        <label>Max output<input data-provider-field="maxTokens" type="number" min="1" placeholder="${esc(model.detected?.maxTokens || model.maxTokens || '')}" value="${esc(model.overrides?.maxTokens ?? '')}"></label>
        ${['tools','jsonSchema','vision','reasoning'].map((key) => `<label>${key}<select data-provider-field="${key}"><option value="" ${triState(model.overrides?.[key]) === '' ? 'selected' : ''}>Auto (${c(key) == null ? '?' : c(key) ? 'yes' : 'no'})</option><option value="true" ${triState(model.overrides?.[key]) === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${triState(model.overrides?.[key]) === 'false' ? 'selected' : ''}>No</option></select></label>`).join('')}
      </div>
      <div class="button-row"><button class="sm-btn primary" data-provider-save-model="${esc(model.id)}">Apply overrides</button></div>
    </div>`;
  }

  function renderDetail() {
    const provider = selectedProvider();
    const detail = $('#providerDetail');
    if (!detail) return;
    if (!provider) {
      detail.innerHTML = '<div class="empty-state">Add a provider or select one from the list.</div>';
      return;
    }
    detail.innerHTML = `<div class="provider-detail-head"><div><strong>${esc(provider.name || provider.id)}</strong><span>${esc(provider.baseUrl)}</span></div><div class="button-row"><button class="sm-btn" id="refreshProviderModels">Refresh models</button><button class="sm-btn" id="syncProviderPi">Sync to Pi</button><button class="sm-btn danger ghost" id="removeProvider">Remove</button></div></div>
      <div class="provider-detail-meta">API: ${esc(provider.api || 'auto')} · env: ${provider.apiKeyEnv ? `$${esc(provider.apiKeyEnv)}` : 'none'} · ${provider.apiKeyAvailable ? 'credential available' : 'credential not detected'}</div>
      <div class="provider-model-list">${(provider.models || []).map((model) => modelRow(provider, model)).join('') || '<div class="empty-state">No models cached. Refresh models to discover this endpoint.</div>'}</div>`;
    $('#refreshProviderModels')?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try { const value = await post('/api/providers/models', { providerId: provider.id }); replaceProvider(value.provider); toast(`Loaded ${value.provider.models?.length || 0} models`, 'success'); }
      catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
    });
    $('#syncProviderPi')?.addEventListener('click', async () => { try { await post('/api/providers/sync'); toast('Provider models synchronized to Pi', 'success'); } catch (error) { toast(error.message, 'error'); } });
    $('#removeProvider')?.addEventListener('click', async (event) => {
      if (!confirmAction(`Remove provider "${provider.name || provider.id}" and its Studio-owned Pi model definitions?`)) return;
      const button = event.currentTarget; const label = button.textContent; button.disabled = true; button.textContent = 'Removing…';
      try { await del('/api/providers', { providerId: provider.id }); setProviders((getProviders() || []).filter((item) => item.id !== provider.id)); selectedProviderId = ''; onProvidersChanged(); render(); }
      catch (error) { toast(error.message, 'error'); button.disabled = false; button.textContent = label; }
    });
    detail.querySelectorAll?.('[data-provider-probe]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { const value = await post('/api/providers/probe-model', { providerId: provider.id, modelId: button.dataset.providerProbe }); replaceProvider(value.provider); toast(`Probed ${button.dataset.providerProbe}`, 'success'); }
      catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
    }));
    detail.querySelectorAll?.('[data-provider-save-model]').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('[data-provider-model]');
      const overrides = {};
      row.querySelectorAll('[data-provider-field]').forEach((input) => {
        const key = input.dataset.providerField;
        const raw = input.value;
        if (raw === '') return;
        if (['tools','jsonSchema','vision','reasoning'].includes(key)) overrides[key] = raw === 'true';
        else overrides[key] = Number(raw);
      });
      button.disabled = true;
      try { const value = await put('/api/providers/model', { providerId: provider.id, model: { id: row.dataset.providerModel, overrides } }); replaceProvider(value.provider); toast('Model overrides saved', 'success'); }
      catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
    }));
  }

  function replaceProvider(provider) {
    const next = [...(getProviders() || [])];
    const index = next.findIndex((item) => item.id === provider.id);
    if (index >= 0) next[index] = provider; else next.push(provider);
    setProviders(next);
    selectedProviderId = provider.id;
    onProvidersChanged();
    render();
  }

  function render() { renderList(); renderDetail(); }

  function updateFormActions() {
    const state = providerFormState({ id: $('#providerId')?.value, baseUrl: $('#providerBaseUrl')?.value });
    if ($('#testProvider')) $('#testProvider').disabled = !state.canTest;
    if ($('#saveProvider')) $('#saveProvider').disabled = !state.canSave;
  }

  async function refresh() {
    const value = await api('/api/providers');
    setProviders(value.providers || []);
    if (selectedProviderId && !(value.providers || []).some((item) => item.id === selectedProviderId)) selectedProviderId = '';
    onProvidersChanged(); render();
    return value.providers || [];
  }

  $('#saveProvider')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const provider = {
      id: $('#providerId')?.value?.trim(), name: $('#providerName')?.value?.trim(), baseUrl: $('#providerBaseUrl')?.value?.trim(),
      apiKeyEnv: $('#providerApiKeyEnv')?.value?.trim(), api: $('#providerApi')?.value || 'auto'
    };
    const label = button.textContent; button.disabled = true; button.textContent = 'Saving…';
    try { const value = await post('/api/providers/save', { provider }); replaceProvider(value.provider); toast('Provider saved', 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.textContent = label; updateFormActions(); }
  });
  $('#testProvider')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const provider = { id: $('#providerId')?.value?.trim() || 'test', name: $('#providerName')?.value?.trim(), baseUrl: $('#providerBaseUrl')?.value?.trim(), apiKeyEnv: $('#providerApiKeyEnv')?.value?.trim(), api: $('#providerApi')?.value || 'auto' };
    const label = button.textContent; button.disabled = true; button.textContent = 'Testing…';
    try { const value = await post('/api/providers/test', { provider }); toast(`Connected · ${value.modelCount} models · ${value.latencyMs} ms`, 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.textContent = label; updateFormActions(); }
  });
  $('#refreshProviders')?.addEventListener('click', () => refresh().catch((error) => toast(error.message, 'error')));
  for (const selector of ['#providerId', '#providerBaseUrl']) $(selector)?.addEventListener('input', updateFormActions);

  render(); updateFormActions();
  return { render, refresh, select(id) { selectedProviderId = id; render(); } };
}
