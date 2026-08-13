const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

function parseJsonObject(text, label) {
  if (!String(text || '').trim()) return {};
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

export function parseCommandArguments(text = '') {
  const args = [];
  let current = '';
  let quote = '';
  let started = false;
  const source = String(text);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) { quote = ''; started = true; continue; }
      if (char === '\\' && source[index + 1] === quote) { current += quote; index += 1; started = true; continue; }
      current += char; started = true; continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += char; started = true;
  }
  if (quote) throw new Error('Arguments contain an unterminated quote');
  if (started) args.push(current);
  return args;
}

function validHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value || '').trim()).protocol); }
  catch { return false; }
}

export function mcpFormState({ id = '', transport = 'stdio', command = '', url = '' } = {}) {
  const hasId = Boolean(String(id).trim());
  const hasTarget = transport === 'http' ? validHttpUrl(url) : Boolean(String(command).trim());
  return { canSave: hasId && hasTarget };
}

export function createMcpPanel({ root = document, api, post, put, del, toast = () => {}, getSnapshot, setSnapshot }) {
  const $ = (selector) => root.querySelector(selector);
  let selected = '';

  function server() {
    const list = getSnapshot()?.servers || [];
    return list.find((item) => item.id === selected) || list[0] || null;
  }

  function renderList() {
    const host = $('#mcpServerList');
    if (!host) return;
    const list = getSnapshot()?.servers || [];
    if (!selected && list[0]) selected = list[0].id;
    host.innerHTML = list.map((item) => `<button type="button" class="provider-list-item ${item.id === selected ? 'active' : ''}" data-mcp-server="${esc(item.id)}"><strong>${esc(item.name || item.id)}</strong><span>${esc(item.transport === 'http' ? item.url : `${item.command || ''} ${(item.args || []).join(' ')}`)}</span><small>${esc(item.status || 'disconnected')} · ${(item.tools || []).length} tools${item.exposeToPi ? ' · exposed to Pi' : ''}</small></button>`).join('') || '<div class="empty-state">No MCP servers configured.</div>';
    host.querySelectorAll?.('[data-mcp-server]').forEach((button) => button.addEventListener('click', () => { selected = button.dataset.mcpServer; render(); }));
  }

  function renderDetail() {
    const host = $('#mcpDetail');
    if (!host) return;
    const item = server();
    if (!item) { host.innerHTML = '<div class="empty-state">Add or select an MCP server.</div>'; return; }
    const disabled = new Set(item.disabledTools || []);
    const connected = item.status === 'connected';
    const connecting = item.status === 'connecting';
    const canDisconnect = connected || connecting || item.status === 'error';
    const manualDisabled = connected ? '' : ' disabled title="Connect this server before making a manual call"';
    host.innerHTML = `<div class="provider-detail-head"><div><strong>${esc(item.name || item.id)}</strong><span>${esc(item.status || 'disconnected')}${item.protocolVersion ? ` · ${esc(item.protocolVersion)}` : ''}</span></div><div class="button-row"><button class="sm-btn" id="mcpConnect" ${connected || connecting ? 'disabled' : ''}>${item.status === 'error' ? 'Reconnect' : 'Connect'}</button><button class="sm-btn" id="mcpDisconnect" ${canDisconnect ? '' : 'disabled'}>Disconnect</button><button class="sm-btn" id="mcpRefresh" ${connected ? '' : 'disabled'}>Refresh</button><button class="sm-btn danger ghost" id="mcpRemove">Remove</button></div></div>
      <label class="switch-row"><span>Expose this server to Pi</span><input id="mcpExpose" type="checkbox" ${item.exposeToPi ? 'checked' : ''}></label>
      ${item.lastError ? `<div class="warning-box">${esc(item.lastError)}</div>` : ''}
      <h4>Tools</h4><div class="mcp-resource-list">${(item.tools || []).map((tool) => `<div class="mcp-tool-row"><input type="checkbox" data-mcp-tool="${esc(tool.name)}" ${disabled.has(tool.name) ? '' : 'checked'}><span><strong>${esc(tool.name)}</strong><small>${esc(tool.description || '')}</small></span><button type="button" class="sm-btn" data-mcp-call-tool="${esc(tool.name)}"${manualDisabled}>Call</button></div>`).join('') || '<div class="empty-state">No tools discovered.</div>'}</div>
      <h4>Resources</h4><div class="mcp-resource-list">${(item.resources || []).map((resource) => `<div class="mcp-manual-row"><span><strong>${esc(resource.name || resource.uri)}</strong><small>${esc(resource.uri || '')}</small></span><button type="button" class="sm-btn" data-mcp-read-resource="${esc(resource.uri || '')}"${manualDisabled}>Read</button></div>`).join('') || '<div class="empty-state">No resources discovered.</div>'}</div>
      <h4>Prompts</h4><div class="mcp-resource-list">${(item.prompts || []).map((prompt) => `<div class="mcp-manual-row"><span><strong>${esc(prompt.name)}</strong><small>${esc(prompt.description || '')}</small></span><button type="button" class="sm-btn" data-mcp-get-prompt="${esc(prompt.name)}"${manualDisabled}>Get</button></div>`).join('') || '<div class="empty-state">No prompts discovered.</div>'}</div>
      <div class="mcp-manual-console"><div class="section-heading-row"><div><h4>Manual MCP call</h4><small class="muted">Studio manual calls remain available even when Pi exposure is disabled.</small></div><span id="mcpManualTarget" class="muted">Select a tool/resource/prompt above</span></div><label>Arguments JSON<textarea id="mcpManualArgs" rows="4" placeholder="{}"></textarea></label><pre id="mcpManualResult" class="rpc-result">No manual call yet.</pre></div>`;

    const action = async (path, button, pendingLabel) => {
      const label = button?.textContent;
      if (button) { button.disabled = true; button.textContent = pendingLabel; }
      try { await post(path, { serverId: item.id }); await refresh(); }
      catch (error) { toast(error.message, 'error'); }
      finally { if (button?.isConnected) { button.textContent = label; renderDetail(); } }
    };
    $('#mcpConnect')?.addEventListener('click', (event) => action('/api/mcp/connect', event.currentTarget, 'Connecting…'));
    $('#mcpDisconnect')?.addEventListener('click', (event) => action('/api/mcp/disconnect', event.currentTarget, 'Disconnecting…'));
    $('#mcpRefresh')?.addEventListener('click', (event) => action('/api/mcp/refresh', event.currentTarget, 'Refreshing…'));
    $('#mcpRemove')?.addEventListener('click', async () => {
      const view = root.defaultView || globalThis.window;
      if (typeof view?.confirm === 'function' && !view.confirm(`Remove MCP server "${item.name || item.id}"?`)) return;
      try { await del('/api/mcp/server', { serverId: item.id }); selected = ''; await refresh(); }
      catch (error) { toast(error.message, 'error'); }
    });

    const showManual = async (kind, name, button) => {
      const target = $('#mcpManualTarget');
      const result = $('#mcpManualResult');
      if (target) target.textContent = `${kind}: ${name}`;
      const label = button?.textContent;
      if (button) { button.disabled = true; button.textContent = 'Working…'; }
      try {
        let value;
        if (kind === 'tool') {
          const args = parseJsonObject($('#mcpManualArgs')?.value, 'Arguments');
          value = await post('/api/mcp/tool', { serverId: item.id, toolName: name, args });
        } else if (kind === 'resource') {
          value = await post('/api/mcp/resource', { serverId: item.id, uri: name });
        } else {
          const args = parseJsonObject($('#mcpManualArgs')?.value, 'Arguments');
          value = await post('/api/mcp/prompt', { serverId: item.id, name, args });
        }
        if (result) result.textContent = JSON.stringify(value.result, null, 2);
      } catch (error) {
        if (result) result.textContent = `ERROR: ${error.message}`;
        toast(error.message, 'error');
      } finally {
        if (button?.isConnected) { button.disabled = false; button.textContent = label; }
      }
    };
    host.querySelectorAll?.('[data-mcp-call-tool]').forEach((button) => button.addEventListener('click', () => showManual('tool', button.dataset.mcpCallTool, button)));
    host.querySelectorAll?.('[data-mcp-read-resource]').forEach((button) => button.addEventListener('click', () => showManual('resource', button.dataset.mcpReadResource, button)));
    host.querySelectorAll?.('[data-mcp-get-prompt]').forEach((button) => button.addEventListener('click', () => showManual('prompt', button.dataset.mcpGetPrompt, button)));

    const applyExposure = async () => {
      const controls = [...host.querySelectorAll('#mcpExpose,[data-mcp-tool]')];
      controls.forEach((control) => { control.disabled = true; });
      const enabled = [...host.querySelectorAll('[data-mcp-tool]')].filter((node) => node.checked).map((node) => node.dataset.mcpTool);
      const all = (item.tools || []).map((tool) => tool.name);
      try {
        await put('/api/mcp/exposure', { serverId: item.id, exposeToPi: Boolean($('#mcpExpose')?.checked), disabledTools: all.filter((name) => !enabled.includes(name)) });
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
        await refresh().catch(() => {});
      }
    };
    $('#mcpExpose')?.addEventListener('change', applyExposure);
    host.querySelectorAll?.('[data-mcp-tool]').forEach((input) => input.addEventListener('change', applyExposure));
  }

  function renderLogs() {
    const host = $('#mcpLogs');
    if (!host) return;
    const logs = getSnapshot()?.logs || [];
    host.textContent = logs.slice(-40).map((row) => `${row.at || ''} [${row.serverId || ''}/${row.stream || ''}] ${row.data || ''}`).join('\n') || 'No MCP logs yet.';
  }

  function render() { renderList(); renderDetail(); renderLogs(); }

  async function refresh() {
    const value = await api('/api/mcp');
    setSnapshot({ servers: value.servers || [], logs: value.logs || [] });
    if (selected && !(value.servers || []).some((item) => item.id === selected)) selected = '';
    render();
    return value;
  }

  function updateFormActions() {
    const transport = $('#mcpTransport')?.value || 'stdio';
    const state = mcpFormState({ id: $('#mcpId')?.value, transport, command: $('#mcpCommand')?.value, url: $('#mcpUrl')?.value });
    if ($('#mcpSave')) $('#mcpSave').disabled = !state.canSave;
  }

  $('#mcpTransport')?.addEventListener('change', () => {
    const isHttp = $('#mcpTransport').value === 'http';
    $('#mcpStdioFields')?.classList.toggle('hidden', isHttp);
    $('#mcpHttpFields')?.classList.toggle('hidden', !isHttp);
    updateFormActions();
  });
  for (const selector of ['#mcpId', '#mcpCommand', '#mcpUrl']) $(selector)?.addEventListener('input', updateFormActions);
  $('#mcpSave')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Saving…';
    try {
      const transport = $('#mcpTransport')?.value || 'stdio';
      const serverValue = { id: $('#mcpId')?.value?.trim(), name: $('#mcpName')?.value?.trim(), transport, exposeToPi: Boolean($('#mcpExposeNew')?.checked) };
      if (transport === 'stdio') {
        serverValue.command = $('#mcpCommand')?.value?.trim();
        serverValue.args = parseCommandArguments($('#mcpArgs')?.value);
        serverValue.cwd = $('#mcpCwd')?.value?.trim();
        serverValue.env = parseJsonObject($('#mcpEnv')?.value, 'Environment');
      } else {
        serverValue.url = $('#mcpUrl')?.value?.trim();
        serverValue.headers = parseJsonObject($('#mcpHeaders')?.value, 'Headers');
      }
      const value = await post('/api/mcp/server', { server: serverValue });
      selected = value.server.id;
      await refresh();
      toast('MCP server saved', 'success');
    } catch (error) { toast(error.message, 'error'); }
    finally { button.textContent = label; updateFormActions(); }
  });
  $('#mcpReload')?.addEventListener('click', () => refresh().catch((error) => toast(error.message, 'error')));

  render(); updateFormActions();
  return { render, refresh };
}

export const __test = { parseJsonObject };
