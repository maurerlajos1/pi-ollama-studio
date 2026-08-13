const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

export function createPreviewPanel({ root = document, api, post, put, toast = () => {}, getWorkspace = () => '', getWorkspaceEpoch = () => 0 }) {
  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  let current = { config: { command: '', url: '', autoOpen: true }, preview: { status: 'stopped', url: '', logs: [] } };

  function render() {
    const cfg = current.config || {};
    const preview = current.preview || {};
    const commandInput = $('#previewCommand');
    const urlInput = $('#previewUrl');
    // A workspace refresh may finish after the user has started editing. Do
    // not overwrite a focused command/URL field with an older suggestion.
    const activeElement = root?.activeElement || (typeof document !== 'undefined' ? document.activeElement : null);
    if (commandInput && activeElement !== commandInput) commandInput.value = cfg.command || preview.command || '';
    if (urlInput && activeElement !== urlInput) urlInput.value = cfg.url || preview.url || '';
    const status = `${preview.status || 'stopped'}${preview.pid ? ` · pid ${preview.pid}` : ''}`;
    if ($('#previewStatus')) $('#previewStatus').textContent = status;
    if ($('#editorPreviewStatus')) $('#editorPreviewStatus').textContent = status;
    const url = preview.url || cfg.url || '';
    const lifecycle = String(preview.status || 'stopped');
    const starting = lifecycle === 'starting';
    const running = lifecycle === 'running';
    const stopping = lifecycle === 'stopping';
    if ($('#previewStart')) $('#previewStart').disabled = starting || running || stopping;
    if ($('#previewRestart')) $('#previewRestart').disabled = !running;
    if ($('#previewStop')) $('#previewStop').disabled = !(starting || running);
    if ($('#previewRefresh')) $('#previewRefresh').disabled = !url;
    if ($('#editorPreviewRefresh')) $('#editorPreviewRefresh').disabled = !url;
    for (const frame of $$('#previewFrame,#editorPreviewFrame')) {
      if (url && frame.dataset.url !== url) { frame.src = url; frame.dataset.url = url; }
      else if (!url) { frame.removeAttribute('src'); frame.dataset.url = ''; }
    }
    if ($('#previewOpenExternal')) $('#previewOpenExternal').disabled = !url;
    if ($('#previewLogs')) $('#previewLogs').textContent = (preview.logs || []).slice(-80).map((row) => `${row.at || ''} [${row.stream || ''}] ${String(row.text || '').trimEnd()}`).join('\n') || 'No preview logs yet.';
  }

  async function refresh() {
    const workspace = getWorkspace();
    const epoch = getWorkspaceEpoch();
    if (!workspace) { current = { config: {}, preview: { status: 'stopped', logs: [] } }; render(); return current; }
    const value = await api(`/api/preview?workspace=${encodeURIComponent(workspace)}`);
    if (workspace !== getWorkspace() || epoch !== getWorkspaceEpoch()) return current;
    current = value;
    if (!current.config?.command && current.suggestion?.command) current.config = { ...current.config, command: current.suggestion.command };
    render();
    return current;
  }

  async function start() {
    const workspace = getWorkspace();
    const epoch = getWorkspaceEpoch();
    if (!workspace) return toast('Open a workspace first', 'error');
    if (['starting', 'running', 'stopping'].includes(current.preview?.status)) return;
    // Capture the user's draft before the Start click moves focus away from
    // the inputs. The optimistic render must not replace an unsaved manual
    // command/URL with an older persisted suggestion.
    const command = $('#previewCommand')?.value?.trim();
    const url = $('#previewUrl')?.value?.trim();
    const previous = current;
    current = { ...current, config: { ...(current.config || {}), command, url, autoOpen: true }, preview: { ...(current.preview || {}), status: 'starting' } };
    render();
    try {
      const value = await post('/api/preview/start', { workspace, command, url, autoOpen: true });
      if (workspace !== getWorkspace() || epoch !== getWorkspaceEpoch()) return;
      current = { ...current, preview: value.preview, config: { command, url, autoOpen: true } };
      render();
      toast('Preview server started', 'success');
    } catch (error) { if(workspace===getWorkspace()&&epoch===getWorkspaceEpoch()){current=previous;render();toast(error.message, 'error');} }
  }
  async function stop() { const workspace = getWorkspace(); if (!workspace || !['starting','running'].includes(current.preview?.status)) return; const previous=current;current={...current,preview:{...(current.preview||{}),status:'stopping'}};render();try { await post('/api/preview/stop', { workspace }); await refresh(); } catch (error) { current=previous;render();toast(error.message, 'error'); } }
  async function restart() { const workspace = getWorkspace(), epoch = getWorkspaceEpoch(); if (!workspace || current.preview?.status!=='running') return;const previous=current;current={...current,preview:{...(current.preview||{}),status:'starting'}};render();try { const value = await post('/api/preview/restart', { workspace }); if(workspace!==getWorkspace()||epoch!==getWorkspaceEpoch())return;current = { ...current, preview: value.preview }; render(); toast('Preview server restarted', 'success'); } catch (error) { if(workspace===getWorkspace()&&epoch===getWorkspaceEpoch()){current=previous;render();toast(error.message, 'error');} } }
  async function save() {
    const workspace = getWorkspace();
    const epoch = getWorkspaceEpoch();
    if (!workspace) return toast('Open a workspace first', 'error');
    try {
      const config = { workspace, command: $('#previewCommand')?.value?.trim(), url: $('#previewUrl')?.value?.trim(), autoOpen: true };
      const value = await put('/api/preview/config', config);
      if (workspace !== getWorkspace() || epoch !== getWorkspaceEpoch()) return;
      current = { ...current, config: value.config };
      render();
      toast('Preview configuration saved', 'success');
    } catch (error) { if(workspace===getWorkspace()&&epoch===getWorkspaceEpoch())toast(error.message, 'error'); }
  }
  function reloadFrame(target) { const selector = target === 'editor' ? '#editorPreviewFrame' : '#previewFrame'; const frame = $(selector); if (!frame?.src) return; try { frame.contentWindow?.location?.reload?.(); } catch { frame.src = frame.src; } }
  async function toggleEditorSplit(force) {
    const layout = $('#editorPreviewLayout');
    const pane = $('#editorPreviewPane');
    if (!layout || !pane) return false;
    const show = typeof force === 'boolean' ? force : pane.classList.contains('hidden');
    pane.classList.toggle('hidden', !show); layout.classList.toggle('with-preview', show);
    if (show) {
      await refresh().catch(() => {});
      const frame = $('#editorPreviewFrame');
      if (frame?.src) {
        const url = frame.src;
        frame.src = `${url}${url.includes('?') ? '&' : '?'}_studioReload=${Date.now()}`;
        frame.dataset.url = url;
      }
      requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch {} });
    }
    return show;
  }
  function updatePreview(preview) { if (!preview) return current; current = { ...current, preview }; render(); return current; }

  $('#previewStart')?.addEventListener('click', start);
  $('#previewStop')?.addEventListener('click', stop);
  $('#previewRestart')?.addEventListener('click', restart);
  $('#previewSave')?.addEventListener('click', save);
  $('#previewRefresh')?.addEventListener('click', () => reloadFrame('main'));
  $('#editorPreviewRefresh')?.addEventListener('click', () => reloadFrame('editor'));
  $('#togglePreviewSplit')?.addEventListener('click', () => toggleEditorSplit());
  $('#editorPreviewClose')?.addEventListener('click', () => toggleEditorSplit(false));
  $('#previewOpenExternal')?.addEventListener('click', () => { const url = current.preview?.url || current.config?.url; if (url) window.open(url, '_blank', 'noopener,noreferrer'); });
  return { refresh, start, stop, restart, save, reloadFrame, toggleEditorSplit, updatePreview, get state() { return current; } };
}

export const __test = { esc };
