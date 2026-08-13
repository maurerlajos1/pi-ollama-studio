const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const RESOURCE_KEYS = ['extensions', 'skills', 'prompts', 'themes'];
export function safeExternalUrl(value) { try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
export function packageRiskSummary(pkg = {}) { const warnings = []; if (pkg.trust?.hasInstallScripts) warnings.push(`Runs install scripts: ${Object.keys(pkg.trust.installScripts || {}).join(', ')}`); if (pkg.trust?.hasExtensions) warnings.push('Contains executable Pi extensions'); if (Number(pkg.trust?.dependencyCount || 0) > 20) warnings.push(`${pkg.trust.dependencyCount} runtime dependencies`); return warnings; }

export function createPackageMarketplace({ root = document, api, post, put, toast = () => {}, getWorkspace = () => '', refreshPlatform = async () => {}, onPiResourceChange = () => {} }) {
  const $ = (selector) => root.querySelector(selector);
  const runButtonAction = async (button, pendingLabel, action) => {
    const label = button?.textContent || '';
    if (button) { button.disabled = true; button.textContent = pendingLabel; }
    try { return await action(); }
    finally { if (button?.isConnected) { button.disabled = false; button.textContent = label; } updateDirectActions(); }
  };
  let results = [];
  let selected = null;
  let selectedVersion = '';
  let resourceType = '';
  let searchGeneration = 0;
  let detailGeneration = 0;
  function updateDirectActions() {
    const hasSource = Boolean(String($('#packageDirectSource')?.value || '').trim());
    const projectReady = ($('#packageDirectScope')?.value || 'project') !== 'project' || Boolean(getWorkspace());
    if ($('#packageDirectInspect')) $('#packageDirectInspect').disabled = !hasSource || !projectReady;
    if ($('#packageDirectInstall')) $('#packageDirectInstall').disabled = !hasSource || !projectReady;
  }
  function close() { $('#packageMarketplace')?.classList.add('hidden'); }
  function renderResults() {
    const host = $('#packageMarketResults'); if (!host) return;
    host.innerHTML = results.map((pkg) => `<button type="button" class="market-package ${selected?.name === pkg.name ? 'active' : ''}" data-market-package="${esc(pkg.name)}"><strong>${esc(pkg.name)}</strong><span>${esc(pkg.description || '')}</span><small>${esc(pkg.version || '')} · ${Object.entries(pkg.resources || {}).filter(([, v]) => v?.length).map(([k]) => k).join(', ') || 'manifest/convention package'}</small></button>`).join('') || '<div class="empty-state">No matching Pi packages.</div>';
    host.querySelectorAll?.('[data-market-package]').forEach((button) => button.addEventListener('click', () => { searchGeneration += 1; selected = results.find((pkg) => pkg.name === button.dataset.marketPackage) || null; selectedVersion = selected?.version || ''; detailGeneration += 1; render(); }));
  }
  function renderDetail() {
    const host = $('#packageMarketDetail'); if (!host) return;
    if (!selected) { host.innerHTML = '<div class="empty-state">Select a package to inspect its Pi manifest, versions and install risk.</div>'; return; }
    const risks = packageRiskSummary(selected);
    const resources = Object.entries(selected.resources || {}).filter(([, v]) => v?.length);
    const repository = safeExternalUrl(selected.repository);
    const homepage = safeExternalUrl(selected.homepage);
    const activeVersion = selectedVersion || selected.version;
    host.innerHTML = `<div class="market-detail-head"><div><h3>${esc(selected.name)}</h3><p>${esc(selected.description || '')}</p></div><span>${esc(selected.license || '')}</span></div>
      ${risks.length ? `<div class="platform-warning"><strong>Review before installing</strong><ul>${risks.map((risk) => `<li>${esc(risk)}</li>`).join('')}</ul></div>` : '<div class="success-note">No install scripts reported in the selected npm manifest. Extensions can still execute code; inspect source before enabling.</div>'}
      <div class="market-meta"><span>Selected <strong>${esc(activeVersion)}</strong>${activeVersion === selected.latest ? ' · latest' : ''}</span><span>${selected.trust?.dependencyCount || 0} dependencies</span>${selected.integrity ? `<span title="${esc(selected.integrity)}">integrity ✓</span>` : ''}${selected.publishedAt ? `<span>${esc(selected.publishedAt)}</span>` : ''}${repository ? `<a href="${esc(repository)}" target="_blank" rel="noopener noreferrer">Repository ↗</a>` : ''}${homepage ? `<a href="${esc(homepage)}" target="_blank" rel="noopener noreferrer">Homepage ↗</a>` : ''}</div>
      <h4>Pi resources</h4><div class="market-resource-grid">${resources.map(([key, items]) => `<div><strong>${esc(key)}</strong><code>${esc(items.join(', '))}</code></div>`).join('') || '<span class="muted">No explicit pi manifest resources; package may use convention directories.</span>'}</div>
      <label>Version<select id="packageMarketVersion">${(selected.versions || [selected.version]).map((version) => `<option value="${esc(version)}" ${version === activeVersion ? 'selected' : ''}>${esc(version)}${version === selected.latest ? ' (latest)' : ''}</option>`).join('')}</select></label>
      <div class="button-row"><button id="installPackageProject" class="primary" ${getWorkspace() ? '' : 'disabled title="Open a project before installing project-scoped packages"'}>Install Project</button><button id="installPackageGlobal">Install Global</button></div>`;
    const versionSelect = $('#packageMarketVersion');
    versionSelect?.addEventListener('change', async () => {
      const version = versionSelect.value;
      selectedVersion = version;
      // A package selection is now authoritative. Invalidate any older search
      // response so it cannot replace exact-version trust metadata underneath it.
      searchGeneration += 1;
      const requestGeneration = ++detailGeneration;
      const packageName = selected.name;
      try {
        const value = await api(`/api/pi-packages/details?name=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`);
        if (requestGeneration !== detailGeneration || selected?.name !== packageName) return;
        selected = value.package;
        selectedVersion = version;
        renderDetail();
        const renderedVersion = $('#packageMarketVersion'); if (renderedVersion) renderedVersion.value = version;
      } catch (error) { toast(error.message, 'error'); }
    });
    const install = async (scope, button) => {
      if (scope === 'project' && !getWorkspace()) return toast('Open a workspace first', 'error');
      const version = $('#packageMarketVersion')?.value || selectedVersion || selected.version || '';
      try {
        await runButtonAction(button, 'Installing…', async () => {
          await post('/api/pi-packages/install', { workspace: getWorkspace(), scope, source: `npm:${selected.name}`, version });
          await refreshPlatform(); onPiResourceChange(`Installed ${selected.name}@${version}`); toast(`${selected.name}@${version} installed (${scope})`); close();
        });
      } catch (error) { toast(error.message, 'error'); }
    };
    $('#installPackageProject')?.addEventListener('click', (event) => install('project', event.currentTarget));
    $('#installPackageGlobal')?.addEventListener('click', (event) => install('global', event.currentTarget));
  }
  function render() { renderResults(); renderDetail(); }
  async function search() {
    const query = $('#packageMarketQuery')?.value || '';
    const type = $('#packageMarketType')?.value || resourceType;
    const requestGeneration = ++searchGeneration;
    const value = await api(`/api/pi-packages/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=20`);
    if (requestGeneration !== searchGeneration) return value;
    const previousName = selected?.name || '';
    const previousVersion = selectedVersion;
    results = value.packages || [];
    selected = results[0] || null;
    selectedVersion = selected?.name === previousName && previousVersion && selected.versions?.includes(previousVersion)
      ? previousVersion
      : selected?.version || '';
    detailGeneration += 1;
    render();
    return value;
  }
  async function open(type = '') { resourceType = type || ''; const modal = $('#packageMarketplace'); modal?.classList.remove('hidden'); if ($('#packageMarketType')) $('#packageMarketType').value = resourceType; updateDirectActions(); await search().catch((error) => toast(error.message, 'error')); }
  $('#packageMarketClose')?.addEventListener('click', close);
  $('#packageMarketSearch')?.addEventListener('click', () => search().catch((error) => toast(error.message, 'error')));
  $('#packageMarketQuery')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search().catch((error) => toast(error.message, 'error')); } });
  $('#packageDirectSource')?.addEventListener('input', updateDirectActions);
  $('#packageDirectScope')?.addEventListener('change', updateDirectActions);
  $('#packageDirectInspect')?.addEventListener('click', async (event) => { const source = $('#packageDirectSource')?.value?.trim(); const scope = $('#packageDirectScope')?.value || 'project'; if (!source) return toast('Enter a package source', 'error'); try { await runButtonAction(event.currentTarget, 'Inspecting…', async () => { const value = await post('/api/pi-packages/inspect-source', { workspace: getWorkspace(), scope, source }); const host = $('#packageDirectProvenance'); if (host) { host.classList.remove('hidden'); host.textContent = JSON.stringify(value.provenance, null, 2); } }); } catch (error) { toast(error.message, 'error'); } });
  $('#packageDirectInstall')?.addEventListener('click', async (event) => { const source = $('#packageDirectSource')?.value?.trim(); const scope = $('#packageDirectScope')?.value || 'project'; if (!source) return toast('Enter an npm, Git, HTTPS, SSH, or local package source', 'error'); try { await runButtonAction(event.currentTarget, 'Installing…', async () => { await post('/api/pi-packages/install', { workspace: getWorkspace(), scope, source }); await refreshPlatform(); onPiResourceChange(`Installed ${source}`); toast('Pi package installed', 'success'); close(); }); } catch (error) { toast(error.message, 'error'); } });
  updateDirectActions();
  return { open, close, search, render };
}

export function renderInstalledPackageControls({ root = document, host, item, put, post, toast = () => {}, workspace, refreshPlatform = async () => {}, onPiResourceChange = () => {} }) {
  if (!host || !item) return;
  const confirmAction = (message) => typeof globalThis.confirm === 'function' && globalThis.confirm(message);
  const runButtonAction = async (button, pendingLabel, action) => {
    const label = button?.textContent || '';
    if (button) { button.disabled = true; button.textContent = pendingLabel; }
    try { return await action(); }
    finally { if (button?.isConnected) { button.disabled = false; button.textContent = label; } }
  };
  const filters = item.filters || {};
  const rows = RESOURCE_KEYS.map((key) => { const filter = filters[key] || { mode: 'all', patterns: [] }; return `<div class="package-filter-row"><strong>${key}</strong><select data-package-mode="${key}"><option value="all" ${filter.mode === 'all' ? 'selected' : ''}>Load all</option><option value="none" ${filter.mode === 'none' ? 'selected' : ''}>Load none</option><option value="custom" ${filter.mode === 'custom' ? 'selected' : ''}>Custom</option></select><input data-package-patterns="${key}" value="${esc((filter.patterns || []).join(', '))}" placeholder="glob1, !glob2"></div>`; }).join('');
  host.innerHTML = `<div class="package-installed-controls"><div class="platform-warning">Pi packages can execute extensions with your user permissions. Disable resource types you do not want loaded.</div>${rows}<div class="button-row"><button class="sm-btn" id="inspectInstalledPackage">Inspect provenance</button><button class="sm-btn primary" id="applyPackageFilters">Apply resource controls</button><button class="sm-btn" id="updateInstalledPackage">Update / reconcile</button><button class="sm-btn danger ghost" id="removeInstalledPackage">Remove</button></div><pre id="installedPackageProvenance" class="rpc-result hidden"></pre></div>`;
  for (const key of RESOURCE_KEYS) {
    const mode = host.querySelector(`[data-package-mode="${key}"]`);
    const patterns = host.querySelector(`[data-package-patterns="${key}"]`);
    const sync = () => { if (patterns) patterns.disabled = mode?.value !== 'custom'; };
    mode?.addEventListener('change', sync);
    sync();
  }
  host.querySelector('#inspectInstalledPackage')?.addEventListener('click', async (event) => { try { await runButtonAction(event.currentTarget, 'Inspecting…', async () => { const value = await post('/api/pi-packages/inspect-source', { workspace, scope: item.scope, source: item.source }); const out = host.querySelector('#installedPackageProvenance'); if (out) { out.classList.remove('hidden'); out.textContent = JSON.stringify(value.provenance, null, 2); } }); } catch (error) { toast(error.message, 'error'); } });
  const resourcePayload = () => Object.fromEntries(RESOURCE_KEYS.map((key) => { const mode = host.querySelector(`[data-package-mode="${key}"]`)?.value || 'all'; const patterns = String(host.querySelector(`[data-package-patterns="${key}"]`)?.value || '').split(',').map((v) => v.trim()).filter(Boolean); return [key, { mode, patterns }]; }));
  host.querySelector('#applyPackageFilters')?.addEventListener('click', async (event) => { try { await runButtonAction(event.currentTarget, 'Applying…', async () => { await put('/api/pi-packages/config', { workspace, scope: item.scope, source: item.source, resources: resourcePayload() }); await refreshPlatform(); onPiResourceChange(`Changed resource filters for ${item.source}`); toast('Package resource controls saved', 'success'); }); } catch (error) { toast(error.message, 'error'); } });
  host.querySelector('#updateInstalledPackage')?.addEventListener('click', async (event) => { try { await runButtonAction(event.currentTarget, 'Updating…', async () => { await post('/api/pi-packages/update', { workspace, scope: item.scope, source: item.source }); await refreshPlatform(); onPiResourceChange(`Updated ${item.source}`); toast('Package reconciled', 'success'); }); } catch (error) { toast(error.message, 'error'); } });
  host.querySelector('#removeInstalledPackage')?.addEventListener('click', async (event) => {
    if (!confirmAction(`Remove Pi package "${item.source}" from ${item.scope || 'its'} scope?`)) return;
    try { await runButtonAction(event.currentTarget, 'Removing…', async () => { await post('/api/pi-packages/remove', { workspace, scope: item.scope, source: item.source }); await refreshPlatform(); onPiResourceChange(`Removed ${item.source}`); toast('Package removed', 'success'); }); }
    catch (error) { toast(error.message, 'error'); }
  });
}
