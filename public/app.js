// ── DOM Helpers ─────────────────────────────────────────────────────────────────
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ── Application State ─────────────────────────────────────────────────────────
// Single global object for all runtime state. Mutated in place by event
// handlers and API responses; never replaced wholesale so references stay valid.
const app = {
  // Server-side config & system info (populated on bootstrap)
  config: {}, system: {}, ollama: { models: [], running: [] }, profiles: [],
  // Pi agent state (populated on connect / SSE events)
  pi: { status: {}, state: null, stats: null },
  // Workspace & session state
  workspace: '', sessions: [], attachments: [], currentFile: null, editorOriginal: '', logs: [],
  // UI streaming state
  toolCards: new Map(), streamMessage: null, currentExtensionRequest: null, extensionRequestQueue: [],
  extensionWidgets: new Map(), extensionStatuses: new Map(), currentExtensionTimer: null,
  // Misc flags
  currentBashId: null, protocolEvents: false, statusRefreshInFlight: false,
  // sendingPrompt: true while a prompt RPC is in-flight; blocks double-submit
  sendingPrompt: false,
  // Composer history (up/down arrow cycling)
  promptHistory: [], promptHistoryIndex: -1, promptDraft: ''
};

// ── Attachment Limits ─────────────────────────────────────────────────────────
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 16 * 1024 * 1024;

// ── API Helpers ─────────────────────────────────────────────────────────────────
// api: raw fetch wrapper — throws on HTTP errors or ok:false responses.
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.ok === false) throw new Error(value.error || `${response.status} ${response.statusText}`);
  return value;
}

function post(path, body = {}) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }
function put(path, body = {}) { return api(path, { method: 'PUT', body: JSON.stringify(body) }); }
function del(path, body = {}) { return api(path, { method: 'DELETE', body: JSON.stringify(body) }); }
function enc(value) { return encodeURIComponent(value ?? ''); }

// ── Formatting Utilities ──────────────────────────────────────────────────────
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let current = bytes; let unit = -1;
  do { current /= 1024; unit += 1; } while (current >= 1024 && unit < units.length - 1);
  return `${current >= 100 ? current.toFixed(0) : current >= 10 ? current.toFixed(1) : current.toFixed(2)} ${units[unit]}`;
}
function formatNumber(value) { return Number(value || 0).toLocaleString(); }
function formatTime(value) { try { return new Date(value).toLocaleString(); } catch { return String(value || ''); } }
function truncate(text, size = 100) { const value = String(text || ''); return value.length > size ? `${value.slice(0, size)}…` : value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

function markdown(text) {
  const escaped = escapeHtml(text);
  const blocks = [];
  const tokenized = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const id = blocks.length; blocks.push(`<pre><code data-lang="${lang}">${code}</code></pre>`); return `\n@@BLOCK${id}@@\n`;
  });
  let html = tokenized
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '• $1').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*@@BLOCK(\d+)@@\s*<\/p>/g, (_, id) => blocks[Number(id)]);
  html = html.replace(/@@BLOCK(\d+)@@/g, (_, id) => blocks[Number(id)]);
  return html;
}

// ── Toast & Busy Indicators ──────────────────────────────────────────────────
function toast(message, type = '') {
  const node = document.createElement('div'); node.className = `toast ${type}`; node.setAttribute('role', 'alert'); node.textContent = message;
  $('#toastHost').append(node); setTimeout(() => node.remove(), 5000);
}
function setBusy(button, busy, label) {
  if (!button) return; if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy; button.textContent = busy ? (label || 'Working…') : button.dataset.label;
}
function log(kind, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const entry = `[${new Date().toLocaleTimeString()}] ${kind}\n${text}`;
  app.logs.push(entry);
  if (app.logs.length > 1000) app.logs.splice(0, app.logs.length - 1000);
  const logNode = $('#logOutput');
  if (logNode) {
    if (logNode.textContent) logNode.textContent += `\n\n${entry}`;
    else logNode.textContent = entry;
    if (logNode.textContent.length > 200000) logNode.textContent = app.logs.join('\n\n');
    logNode.scrollTop = logNode.scrollHeight;
  }
}

async function rpc(command, { quiet = false } = {}) {
  try {
    const value = await post('/api/pi/command', command);
    if (!quiet) log(`RPC ${command.type}`, value.response || value);
    return value.response || value;
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
    throw error;
  }
}

async function checkTtsStatus(ttsUrl = 'http://localhost:7860', silent = false) {
  try {
    const value = await api(`/api/tts/health?url=${enc(ttsUrl)}`);
    if (value.online) {
      const label = value.loaded === true ? '🟢 TTS Ready' : value.loaded === false ? '🟡 TTS Loading…' : '🟢 TTS Online';
      if (!silent) toast(label, 'success');
      return { online: true, loaded: value.loaded, label };
    } else {
      const msg = `🔴 TTS Offline: ${value.error || 'Server unreachable'}`;
      if (!silent) toast(msg, 'error');
      return { online: false, label: msg };
    }
  } catch (err) {
    const msg = `🔴 TTS Error: ${err.message}`;
    if (!silent) toast(msg, 'error');
    return { online: false, label: msg };
  }
}

function option(select, value, label = value) {
  const node = document.createElement('option'); node.value = value; node.textContent = label; select.append(node);
}

// ── Model Selector ─────────────────────────────────────────────────────────────
function getSelectedModelId() {
  const val = $('#topModel').value;
  if (val === '__custom__') return $('#customModelInput').value.trim();
  return val;
}

// refreshModelSelectors: re-populates both the main model dropdown and the profile
// base-model dropdown from the current Ollama model list. Preserves the selection
// when the list changes (e.g. after a pull or profile create).
function refreshModelSelectors() {
  const models = app.ollama.models || [];
  const savedModel = localStorage.getItem('studio_selected_model') || '';
  for (const select of [$('#topModel'), $('#profileBaseModel')]) {
    const current = select.value || savedModel; select.innerHTML = '';
    option(select, '', models.length ? 'Select model…' : 'No Ollama models');
    for (const model of models) option(select, model.model || model.name, model.model || model.name);
    if (select.id === 'topModel') option(select, '__custom__', 'Custom / Type model name…');
    if (current && [...select.options].some((item) => item.value === current)) select.value = current;
  }
  const desired = app.pi.state?.model?.id || app.config.defaultModel || savedModel || '';
  if (desired && [...$('#topModel').options].some((item) => item.value === desired)) $('#topModel').value = desired;
  if (!$('#profileBaseModel').value && models[0]) $('#profileBaseModel').value = models[0].model || models[0].name;
  renderModelLibrary(); renderActiveModel();
}

function renderHealth() {
  const set = (selector, ok, error = false) => { const node = $(selector); node.classList.toggle('online', Boolean(ok)); node.classList.toggle('error', Boolean(error)); };
  set('#piHealth', app.pi.status?.running, app.pi.status?.lastError);
  set('#ollamaHealth', app.ollama.online, !app.ollama.online);

  const gpu = app.system.gpu?.gpus?.[0];
  const gpuNode = $('#gpuHealth');
  if (gpuNode) {
    if (gpu) {
      gpuNode.classList.add('online');
      const usedGiB = (gpu.memoryUsedMiB / 1024).toFixed(1);
      const totalGiB = (gpu.memoryTotalMiB / 1024).toFixed(1);
      const percent = Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100);
      gpuNode.innerHTML = `<i></i> GPU VRAM: ${usedGiB} / ${totalGiB} GB (${percent}%)`;
    } else {
      gpuNode.classList.remove('online');
      gpuNode.innerHTML = '<i></i> GPU: N/A';
    }
  }

  const activeRunning = app.ollama.running?.[0];
  const vramNode = $('#vramHealth');
  if (vramNode) {
    if (activeRunning) {
      vramNode.classList.add('online');
      const modelName = (activeRunning.model || activeRunning.name).split(':')[0];
      vramNode.innerHTML = `<i></i> Model VRAM: ${formatBytes(activeRunning.size_vram)} (${escapeHtml(modelName)})`;
    } else {
      vramNode.classList.remove('online');
      vramNode.innerHTML = '<i></i> Model VRAM: Standby';
    }
  }
}

// renderActiveModel: updates the active model card, VRAM stats, GPU badge, and model pill.
// Called whenever the Ollama model list, running list, or GPU status changes.
function renderActiveModel() {
  const id = app.pi.state?.model?.id || getSelectedModelId() || '';
  const model = app.ollama.models.find((item) => (item.model || item.name) === id);
  const running = app.ollama.running.find((item) => (item.model || item.name) === id);
  const gpu = app.system.gpu?.gpus?.[0];

  $('#activeModelCard').innerHTML = id ? `<strong>${escapeHtml(id)}</strong><span>${escapeHtml(model?.details?.parameter_size || 'Model')} · ${escapeHtml(model?.details?.quantization_level || '')}</span>` : '<strong>None</strong><span>Select or type a model</span>';
  $('#modelVram').textContent = running ? formatBytes(running.size_vram) : 'Not loaded';
  if ($('#totalGpuVram')) $('#totalGpuVram').textContent = gpu ? `${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)} GB` : '—';
  $('#runtimeContext').textContent = running?.context_length ? formatNumber(running.context_length) : '—';
  $('#offloadStatus').textContent = running ? (running.size_vram >= running.size * 0.95 ? 'GPU' : 'Partial') : '—';

  // ── GPU VRAM badge (always visible in header) ─────────────────────────────
  // Color-coded: green < 80 %, yellow < 95 %, red ≥ 95 % utilization.
  const badge = $('#gpuVramBadge');
  if (badge) {
    if (gpu) {
      const percent = Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100);
      const usedGiB = (gpu.memoryUsedMiB / 1024).toFixed(1);
      const totalGiB = (gpu.memoryTotalMiB / 1024).toFixed(1);
      badge.textContent = `GPU ${usedGiB}/${totalGiB} GB`;
      badge.title = `VRAM: ${usedGiB} / ${totalGiB} GB (${percent}%) · ${gpu.temperatureC || 0}°C`;
      badge.className = percent >= 95 ? 'hot' : percent >= 80 ? 'warn' : 'ok';
    } else {
      badge.textContent = 'GPU —';
      badge.className = '';
    }
  }

  // ── Model pill below the model dropdown ───────────────────────────────────
  // Shows: "Qwen3.6 27B · Q4_K_M · 16.4 GB" when model is loaded.
  const pill = $('#modelPill');
  if (pill) {
    if (running && model) {
      const name = (model.details?.parameter_size || id.split(':')[0].split('/').pop() || '').replace(/[\d.]+B$/i, '').trim();
      const quant = model.details?.quantization_level || '';
      const vram = formatBytes(running.size_vram);
      pill.innerHTML = `<strong>${escapeHtml(name || id.split(':')[0])}</strong> ${escapeHtml(quant ? `· ${quant}` : '')} · ${escapeHtml(vram)} VRAM`;
    } else if (id) {
      const quant = model?.details?.quantization_level || '';
      pill.innerHTML = `<strong>${escapeHtml(id.split(':')[0].split('/').pop() || id)}</strong>${quant ? ` · ${escapeHtml(quant)}` : ''} · Not loaded`;
    } else {
      pill.innerHTML = '';
    }
  }

  if (gpu && $('#vramMeterText') && $('#vramMeterFill')) {
    const percent = Math.min(100, Math.max(0, Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100)));
    const usedGiB = (gpu.memoryUsedMiB / 1024).toFixed(1);
    const totalGiB = (gpu.memoryTotalMiB / 1024).toFixed(1);
    $('#vramMeterText').textContent = `${usedGiB} / ${totalGiB} GB (${percent}%) · ${gpu.temperatureC || 0}°C`;
    const fill = $('#vramMeterFill');
    fill.style.width = `${percent}%`;
    fill.classList.toggle('warning', percent > 85);
  }
}


function modelCapabilityBadges(model) {
  const tags = [];
  const families = (model.details?.families || []).map((f) => String(f).toLowerCase());
  const name = String(model.model || model.name || '').toLowerCase();
  const slug = name.split(':')[0].split('/').pop();
  // Vision detection
  if (families.includes('clip') || name.includes('vision') || name.includes('vl') || name.includes('llava') || name.includes('pixtral') || name.includes('minicpm-v')) tags.push(['👁 Vision', 'vision']);
  // Thinking/reasoning (slug-anchored check to avoid matching llama3.1 / mistral-nemo as o1/o3)
  if (name.includes('qwq') || name.includes('deepseek-r') || name.includes('think') || name.includes('reason') || /^o[13](?:-|$)/.test(slug) || (model.details?.parameter_size || '').includes('MoE')) tags.push(['🧠 Thinking', 'thinking']);
  // Embedding
  if (families.includes('bert') || name.includes('embed') || name.includes('nomic') || name.includes('mxbai')) tags.push(['⊕ Embed', 'embed']);
  // Code
  if (name.includes('code') || name.includes('coder') || name.includes('starcoder') || name.includes('devstral')) tags.push(['</> Code', 'code']);
  return tags.map(([label, cls]) => `<span class="model-cap-badge ${cls}">${label}</span>`).join('');
}

function renderModelLibrary() {
  const host = $('#modelLibrary'); host.innerHTML = '';
  for (const model of app.ollama.models || []) {
    const id = model.model || model.name; const running = app.ollama.running.find((item) => (item.model || item.name) === id);
    const node = document.createElement('div'); node.className = 'model-item';
    const badges = modelCapabilityBadges(model);
    node.innerHTML = `<strong>${escapeHtml(id)}</strong><small>${escapeHtml(model.details?.parameter_size || '')} ${escapeHtml(model.details?.quantization_level || '')} · ${formatBytes(model.size)}${running ? ` · loaded ${formatBytes(running.size_vram)}` : ''}</small>${badges ? `<div class="model-cap-badges">${badges}</div>` : ''}<div class="model-actions"><button data-use>Use</button><button data-unload title="Unload">⏏</button><button data-delete title="Delete">×</button></div>`;
    $('[data-use]', node).onclick = () => { $('#topModel').value = id; renderActiveModel(); if (app.pi.status?.running) switchModel(id); };
    $('[data-unload]', node).onclick = () => doUnload(id);
    $('[data-delete]', node).onclick = async () => { if (!confirm(`Delete ${id} from Ollama?`)) return; try { await del('/api/ollama/model', { model: id }); await refreshOllama(); toast('Model deleted', 'success'); } catch (e) { toast(e.message, 'error'); } };
    host.append(node);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No models installed.</div>';
}

function renderSystem() {
  const host = $('#systemMetrics'); const gpu = app.system.gpu?.gpus?.[0];
  const metrics = [
    ['Pi', app.system.pi?.installed ? app.system.pi.version : 'Not found'],
    ['Ollama CLI', app.system.ollama?.installed ? app.system.ollama.version : 'Not found'],
    ['Node', app.system.node || '—'],
    ['Host memory', `${formatBytes(app.system.freeMemory)} free / ${formatBytes(app.system.totalMemory)}`],
    ['GPU', gpu ? gpu.name : 'Not detected'],
    ['GPU memory', gpu ? `${gpu.memoryUsedMiB.toLocaleString()} / ${gpu.memoryTotalMiB.toLocaleString()} MiB` : '—'],
    ['GPU utilization', gpu ? `${gpu.utilizationPercent}% · ${gpu.temperatureC}°C` : '—']
  ];
  host.innerHTML = metrics.map(([name, value]) => `<div class="system-metric"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function applyConfig() {
  const fields = {
    ollamaBaseUrl: '#ollamaBaseUrl', kvCacheType: '#kvCacheType', defaultContextLength: '#defaultContext', numParallel: '#numParallel',
    maxLoadedModels: '#maxLoadedModels', maxQueue: '#maxQueue', keepAlive: '#keepAlive', piCommand: '#piCommand', ollamaCommand: '#ollamaCommand'
  };
  for (const [key, selector] of Object.entries(fields)) $(selector).value = app.config[key] ?? '';
  $('#flashAttention').checked = Boolean(app.config.flashAttention); $('#noCloud').checked = Boolean(app.config.noCloud); $('#managedOllama').checked = Boolean(app.config.managedOllama); $('#trustProjects').checked = Boolean(app.config.trustProjects);
  if ($('#defaultAgentsMd')) $('#defaultAgentsMd').value = app.config.defaultAgentsMd ?? '';
  if (!app.workspace && app.config.defaultWorkspace) { app.workspace = app.config.defaultWorkspace; $('#workspacePath').value = app.workspace; }
}

function renderPiSnapshot() {
  const { status = {}, state, stats } = app.pi;
  $('#startPi').disabled = Boolean(status.running); $('#stopPi').disabled = !status.running;
  $('#agentStatus').textContent = state?.isStreaming ? 'Working' : state?.isCompacting ? 'Compacting' : status.running ? 'Ready' : 'Stopped';
  $('#sessionName').textContent = state?.sessionName || state?.sessionId || 'No session';
  $('#tokenStatus').textContent = `${formatNumber(stats?.tokens?.total)} tokens`;
  const context = stats?.contextUsage;
  $('#contextStatus').textContent = context ? `Context ${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow)} (${context.percent ?? '—'}%)` : 'Context —';

  // ── Topbar Active Context Token Gauge ──────────────────────────────────
  if ($('#contextGaugeBadge')) {
    if (context?.tokens && context?.contextWindow) {
      const pct = context.percent ?? Math.round((context.tokens / context.contextWindow) * 100);
      $('#contextGaugeBadge').textContent = `Context ${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow)} (${pct}%)`;
      const newClass = pct >= 85 ? 'health error clickable-gauge' : pct >= 65 ? 'health warning clickable-gauge' : 'health online';
      $('#contextGaugeBadge').className = newClass;
      $('#contextGaugeBadge').title = pct >= 65 ? `Click to compact context (${pct}% used)` : `Context usage: ${pct}%`;
    } else {
      $('#contextGaugeBadge').textContent = 'Context —';
      $('#contextGaugeBadge').className = 'health';
      $('#contextGaugeBadge').title = '';
    }
  }

  $('#toolStatus').textContent = `${formatNumber(stats?.toolCalls)} tools`;
  refreshThinkingLevels();
  $('#steeringMode').value = state?.steeringMode || 'one-at-a-time'; $('#followUpMode').value = state?.followUpMode || 'one-at-a-time';
  $('#autoCompaction').checked = state?.autoCompactionEnabled !== false;
  if (state?.model?.id && [...$('#topModel').options].some((item) => item.value === state.model.id)) $('#topModel').value = state.model.id;
  renderHealth(); renderActiveModel();
}


async function refreshThinkingLevels() {
  const select = $('#thinkingLevel');
  const defaultLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const current = app.pi.state?.thinkingLevel || select.value || 'off';

  if (!app.pi.status?.running) {
    select.innerHTML = '';
    for (const level of defaultLevels) option(select, level, level);
    select.value = defaultLevels.includes(current) ? current : 'off';
    return;
  }

  try {
    const response = await rpc({ type: 'get_available_thinking_levels' }, { quiet: true });
    const levels = Array.isArray(response.data?.levels) && response.data.levels.length ? response.data.levels : defaultLevels;
    select.innerHTML = '';
    for (const level of levels) option(select, level, level);
    select.value = levels.includes(current) ? current : levels[0];
  } catch (error) {
    log('THINKING LEVELS', error.message);
  }
}

function messageContent(message) {
  const content = message?.content;
  const result = { text: '', thinking: '', tools: [] };
  if (typeof content === 'string') {
    result.text = content;
  } else {
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text') result.text += block.text || '';
      else if (block.type === 'thinking') result.thinking += block.thinking || block.text || '';
      else if (block.type === 'toolCall' || block.type === 'tool_call') result.tools.push(block);
    }
  }
  const errorText = message?.errorMessage || message?.error || (message?.stopReason === 'error' ? 'An error occurred during generation.' : '');
  if (errorText) {
    result.text = result.text ? `${result.text}\n\n⚠️ **Error:** ${errorText}` : `⚠️ **Error:** ${errorText}`;
  } else if (!result.text && !result.thinking && !result.tools.length && (message?.role === 'assistant' || message?.type === 'assistant')) {
    result.text = '*(No output text generated)*';
  }
  return result;
}

function createCompactionCard(summary, tokensBefore, tokensAfter) {
  $('#welcome').classList.add('hidden');
  const node = document.createElement('article');
  node.className = 'message system compaction-message';
  const beforeStr = tokensBefore ? formatNumber(tokensBefore) : '';
  const afterStr = tokensAfter ? formatNumber(tokensAfter) : '';
  const tokenStats = (beforeStr && afterStr) ? ` (${beforeStr} → ${afterStr} tokens)` : '';

  node.innerHTML = `
    <div class="message-avatar">⚡</div>
    <div class="message-content">
      <div class="message-role">CONTEXT COMPACTED${tokenStats}</div>
      ${summary ? `<details open><summary>Compaction Summary</summary><div class="thinking-block">${markdown(summary)}</div></details>` : '<div class="message-text">Older context summarized to free memory.</div>'}
    </div>
  `;
  $('#messages').append(node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return node;
}

// ── Message Rendering ──────────────────────────────────────────────────────────
// createMessage: creates a new chat bubble article and appends it to #messages.
// Returns the DOM node so callers can stream text/tools into it afterward.
function createMessage(role, text = '', thinking = '', isError = false, timestamp = null, entryId = null) {
  $('#welcome').classList.add('hidden');
  const node = document.createElement('article');
  const isErr = isError || role === 'error' || String(text).includes('⚠️ **Error:**');
  const roleClass = isErr ? 'assistant error-message' : role;
  node.className = `message ${roleClass}`;
  const avatar = role === 'user' ? 'U' : isErr ? '!' : role === 'assistant' ? 'π' : 'T';
  const roleLabel = isErr ? 'ERROR' : role;
  const dateObj = timestamp ? new Date(timestamp) : new Date();
  const timeStr = isNaN(dateObj.getTime()) ? '' : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  node.innerHTML = `<div class="message-avatar">${avatar}</div><div class="message-content"><div class="message-role">${escapeHtml(roleLabel)}${timeStr ? `<span class="msg-timestamp">${timeStr}</span>` : ''}</div>${thinking ? `<details><summary>Thinking</summary><div class="thinking-block">${escapeHtml(thinking)}</div></details>` : ''}<div class="message-text">${markdown(text)}</div><div class="message-tools"></div></div>`;

  // ── Copy button (assistant messages only) ─────────────────────────────────
  if (role === 'assistant' && !isErr) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy response to clipboard';
    copyBtn.textContent = '📋';
    copyBtn.onclick = async () => {
      const msgText = $('.message-text', node);
      const plain = msgText?.innerText || msgText?.textContent || '';
      try {
        await navigator.clipboard.writeText(plain);
        copyBtn.textContent = '✔';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
      } catch {
        toast('Copy failed — check browser permissions', 'error');
      }
    };
    $('.message-role', node)?.append(copyBtn);
  }

  // ── Fork from chat (user messages only) ──────────────────────────────────
  if (role === 'user' && !isErr) {
    node.dataset.forkable = 'true';
    if (entryId) node.dataset.forkEntry = entryId;
    const forkBtn = document.createElement('button');
    forkBtn.className = 'msg-fork-btn sm-btn ghost';
    forkBtn.title = 'Fork session from this message';
    forkBtn.textContent = '🌿 Fork';
    if (entryId) forkBtn.dataset.forkEntry = entryId;
    $('.message-role', node)?.append(forkBtn);
  }

  $('#messages').append(node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return node;
}

function renderMessages(messages) {
  const host = $('#messages'); host.innerHTML = ''; app.toolCards.clear(); app.streamMessage = null;
  for (const message of messages || []) {
    const role = message.role || message.type || 'system';
    const msgTime = message.timestamp || message.createdAt || message.time || null;
    const entryId = message.id || message.entryId || null;
    if (role === 'compaction' || message.type === 'compaction' || message.type === 'compaction_summary' || message.summary) {
      const summaryText = message.summary || (typeof message.content === 'string' ? message.content : message.text) || '';
      createCompactionCard(summaryText, message.tokensBefore, message.tokensAfter);
      continue;
    }
    const parsed = messageContent(message);
    if (role === 'toolResult' || role === 'tool_result') {
      const node = createMessage('tool', parsed.text || JSON.stringify(message, null, 2), '', false, msgTime, entryId);
      node.classList.add('tool-result-message');
      continue;
    }
    const node = createMessage(role, parsed.text, parsed.thinking, false, msgTime, entryId);
    for (const tool of parsed.tools) addToolCard(node, tool.id || tool.toolCallId || crypto.randomUUID(), tool.name, tool.arguments || tool.args || {}, 'planned');
  }
  $('#welcome').classList.toggle('hidden', Boolean(host.childElementCount)); host.scrollTop = host.scrollHeight;
}

function addToolCard(messageNode, id, name, args, status = 'running') {
  const card = document.createElement('div'); card.className = 'tool-card';
  card.innerHTML = `<div class="tool-header"><span>${escapeHtml(name || 'tool')}</span><span class="status ${status}">${escapeHtml(status)}</span></div><pre class="tool-body">${escapeHtml(JSON.stringify(args ?? {}, null, 2))}</pre>`;
  $('.tool-header', card).onclick = () => $('.tool-body', card).classList.toggle('hidden');
  const toolsHost = $('.message-tools', messageNode) || messageNode; toolsHost.append(card); app.toolCards.set(id, card); return card;
}

function toolResultText(value) {
  if (typeof value === 'string') return value;
  const content = value?.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => item?.text || '').filter(Boolean).join('');
    if (text) return text;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function ensureStreamingAssistant() {
  if (app.streamMessage?.isConnected) return app.streamMessage;
  app.streamMessage = createMessage('assistant', ''); $('.message-text', app.streamMessage).innerHTML = ''; return app.streamMessage;
}

function handlePiEvent(event) {
  $('#lastEvent').textContent = JSON.stringify(event, null, 2); if (app.protocolEvents) log('PI EVENT', event);
  switch (event.type) {
    case 'agent_start': $('#agentStatus').textContent = 'Working'; break;
    case 'agent_settled': {
      $('#agentStatus').textContent = 'Ready';
      if (app.streamMessage) {
        const txt = $('.message-text', app.streamMessage)?.textContent?.trim();
        const hasTools = $('.message-tools', app.streamMessage)?.childElementCount > 0;
        const hasThinking = $('.thinking-block', app.streamMessage)?.textContent?.trim();
        if (!txt && !hasTools && !hasThinking) {
          app.streamMessage.remove();
        }
        app.streamMessage = null;
      }
      setTimeout(refreshMessages, 60);
      break;
    }
    case 'message_start':
      if (event.message?.role === 'assistant') { app.streamMessage = createMessage('assistant', ''); $('.message-text', app.streamMessage).innerHTML = ''; }
      break;
    case 'message_update': {
      const node = ensureStreamingAssistant(); const delta = event.assistantMessageEvent || {};
      if (delta.type === 'text_delta') {
        const target = $('.message-text', node);
        target.dataset.raw = (target.dataset.raw || '') + (delta.delta || '');
        if (!node._renderScheduled) {
          node._renderScheduled = true;
          requestAnimationFrame(() => {
            node._renderScheduled = false;
            target.innerHTML = markdown(target.dataset.raw);
            $('#messages').scrollTop = $('#messages').scrollHeight;
          });
        }
      } else if (delta.type === 'thinking_delta') {
        let block = $('.thinking-block', node); if (!block) { const details = document.createElement('details'); details.innerHTML = '<summary>Thinking</summary><div class="thinking-block"></div>'; $('.message-content', node).insertBefore(details, $('.message-text', node)); block = $('.thinking-block', node); }
        block.textContent += delta.delta || '';
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else if (delta.type === 'toolcall_end') {
        const tool = delta.toolCall || {}; addToolCard(node, tool.id || tool.toolCallId || crypto.randomUUID(), tool.name, tool.arguments || tool.args || {}, 'planned');
        $('#messages').scrollTop = $('#messages').scrollHeight;
      }
      break;
    }
    case 'tool_execution_start': {
      const node = ensureStreamingAssistant(); let card = app.toolCards.get(event.toolCallId);
      if (card) { $('.status', card).className = 'status running'; $('.status', card).textContent = 'running'; $('.tool-body', card).textContent = JSON.stringify(event.args || {}, null, 2); }
      else card = addToolCard(node, event.toolCallId, event.toolName, event.args, 'running');

      // ── Interactive Tool Permission Dialog ────────────────────────────────
      if ($('#confirmTools')?.checked && ['bash', 'write', 'edit', 'delete'].includes(String(event.toolName).toLowerCase())) {
        toast(`⚠️ Tool ${event.toolName} requires permission`, 'warning');
        const confirmRow = document.createElement('div'); confirmRow.className = 'tool-confirm-row';
        confirmRow.innerHTML = `<span style="font-size:11px; margin-right:8px;">Permission for <strong>${escapeHtml(event.toolName)}</strong></span> <button class="primary sm-btn" style="padding:2px 8px; font-size:11px;">Approve</button> <button class="danger ghost sm-btn" style="padding:2px 8px; font-size:11px; margin-left:4px;">Abort Turn</button>`;
        $('button.primary', confirmRow).onclick = () => confirmRow.remove();
        $('button.danger', confirmRow).onclick = () => { rpc({ type: 'abort' }); confirmRow.remove(); toast('Turn aborted', 'error'); };
        card.append(confirmRow);
      }
      break;
    }
    case 'tool_execution_update': {
      const card = app.toolCards.get(event.toolCallId);
      if (card) $('.tool-body', card).textContent = toolResultText(event.partialResult || event.delta || event);
      break;
    }
    case 'tool_execution_end': {
      const card = app.toolCards.get(event.toolCallId); if (card) { const failed = Boolean(event.isError || event.result?.isError); $('.status', card).className = `status ${failed ? 'error' : 'done'}`; $('.status', card).textContent = failed ? 'error' : 'done'; $('.tool-body', card).textContent = toolResultText(event.result || event); } break;
    }
    case 'bash_execution_update':
      if (event.id === app.currentBashId) $('#bashOutput').textContent += event.delta || '';
      else if (app.protocolEvents) log('BASH UPDATE', event);
      break;
    case 'queue_update': renderQueue(event); break;
    case 'compaction_start': $('#agentStatus').textContent = `Compacting (${event.reason || 'manual'})`; break;
    case 'compaction_end':
      if (event.summary || event.tokensBefore) {
        createCompactionCard(event.summary, event.tokensBefore, event.tokensAfter);
      }
      toast(event.errorMessage ? `Compaction failed: ${event.errorMessage}` : event.aborted ? 'Compaction aborted' : 'Context compacted', event.errorMessage || event.aborted ? 'error' : 'success');
      break;
    case 'auto_retry_start':
      toast(`Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`, 'error');
      break;
    case 'auto_retry_end':
      if (!event.success) createMessage('error', `⚠️ **Auto Retry Failed:** ${event.finalError || 'Model execution failed'}`);
      toast(event.success ? `Retry succeeded on attempt ${event.attempt}` : `Retry failed: ${event.finalError || 'unknown error'}`, event.success ? 'success' : 'error');
      break;
    case 'summarization_retry_scheduled': toast(`Summary retry ${event.attempt}/${event.maxAttempts} scheduled`, 'error'); break;
    case 'extension_error':
      createMessage('error', `⚠️ **Extension Error:** ${event.error}`);
      toast(`Extension error: ${event.error}`, 'error');
      break;
    case 'extension_ui_request': handleExtensionRequest(event); break;
    default: break;
  }
}

function renderQueue(event) {
  const items = [...(event.steering || []).map((x) => `Steer: ${x}`), ...(event.followUp || []).map((x) => `Follow-up: ${x}`)];
  $('#queueBar').classList.toggle('hidden', !items.length); $('#queueBar').textContent = items.join(' · ');
}

async function refreshMessages() {
  if (!app.pi.status?.running) return;
  try { const response = await rpc({ type: 'get_messages' }, { quiet: true }); renderMessages(response.data?.messages || []); } catch { /* process may be stopping */ }
}
async function refreshSnapshot() {
  try { const value = await api('/api/pi/snapshot'); app.pi = { status: value.status, state: value.state, stats: value.stats }; renderPiSnapshot(); } catch (e) { toast(e.message, 'error'); }
}

async function refreshOllama() {
  const value = await api('/api/ollama/status'); app.ollama = value; app.profiles = value.profiles || []; refreshModelSelectors(); renderHealth();
}

async function loadSessions() {
  if (!app.workspace) return;
  try { const value = await api(`/api/sessions?workspace=${enc(app.workspace)}`); app.sessions = value.sessions; renderSessions(); } catch (e) { $('#sessionList').textContent = e.message; }
}
function renderSessions() {
  const host = $('#sessionList'); host.innerHTML = '';
  for (const session of app.sessions) {
    const node = document.createElement('div'); node.className = 'session-item'; node.title = session.path;
    node.innerHTML = `<strong>${escapeHtml(session.name || session.id || session.fileName)}</strong><span>${formatBytes(session.size)}</span><span>${escapeHtml(formatTime(session.modifiedAt))}</span>`;
    node.onclick = () => startPi(session.path, session.name); host.append(node);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No saved sessions</div>';
}

async function applyWorkspace() {
  const workspace = $('#workspacePath').value.trim(); if (!workspace) return toast('Enter an absolute workspace path', 'error');
  app.workspace = workspace; app.config.defaultWorkspace = workspace;
  try { await put('/api/config', { defaultWorkspace: workspace }); await Promise.all([loadWorkspaceTree(), loadSessions(), loadGit()]); toast('Workspace opened', 'success'); } catch (e) { toast(e.message, 'error'); }
}

async function loadWorkspaceTree() {
  if (!app.workspace) return;
  const value = await api(`/api/workspace/tree?workspace=${enc(app.workspace)}&depth=3`); renderFileTree(value.tree.entries, $('#fileTree'));
}
function renderFileTree(entries, host) {
  host.innerHTML = '';
  const renderNodes = (items, parent) => {
    for (const item of items || []) {
      const node = document.createElement('div'); node.className = 'tree-node';
      const row = document.createElement('div'); row.className = 'tree-row'; row.innerHTML = `<span class="twisty">${item.type === 'directory' ? '▾' : ''}</span><span>${item.type === 'directory' ? '▰' : '·'}</span><span>${escapeHtml(item.name)}</span>`;
      node.append(row);
      if (item.children) { const children = document.createElement('div'); children.className = 'tree-children'; renderNodes(item.children, children); node.append(children); row.onclick = () => { children.classList.toggle('hidden'); $('.twisty', row).textContent = children.classList.contains('hidden') ? '▸' : '▾'; }; }
      else if (item.type === 'file') row.onclick = () => openFile(item.path);
      parent.append(node);
    }
  };
  renderNodes(entries, host); if (!host.childElementCount) host.innerHTML = '<div class="empty-state">Workspace is empty</div>';
}
async function loadGit() {
  if (!app.workspace) return;
  try { const value = await api(`/api/workspace/git?workspace=${enc(app.workspace)}`); $('#gitSummary').textContent = value.git.isRepository ? `${value.git.branch || 'detached'}\n${truncate(value.git.status || 'Clean', 250)}` : 'Not a Git repository'; } catch (e) { $('#gitSummary').textContent = e.message; }
}

async function openFile(filePath) {
  try {
    const value = await api(`/api/workspace/file?workspace=${enc(app.workspace)}&path=${enc(filePath)}`); app.currentFile = value.file; app.editorOriginal = value.file.content;
    $('#editorPath').textContent = value.file.path; $('#editorMeta').textContent = `${formatBytes(value.file.size)} · ${formatTime(value.file.modifiedAt)}`; $('#codeEditor').value = value.file.content; markEditorDirty(false); switchView('editor');
  } catch (e) { toast(e.message, 'error'); }
}
function markEditorDirty(dirty) { $('#editorDirty').textContent = dirty ? '●' : ''; $('#editorDirty').style.color = dirty ? 'var(--yellow)' : ''; }
async function saveFile() {
  if (!app.currentFile) return toast('No file open', 'error');
  try { await put('/api/workspace/file', { workspace: app.workspace, path: app.currentFile.path, content: $('#codeEditor').value }); app.editorOriginal = $('#codeEditor').value; markEditorDirty(false); toast('File saved', 'success'); await loadGit(); } catch (e) { toast(e.message, 'error'); }
}

async function startPi(sessionPath = null, sessionName = '') {
  const button = $('#startPi'); const modelId = getSelectedModelId();
  if (!app.workspace) return toast('Open a workspace first', 'error'); if (!modelId) return toast('Select or enter a model name', 'error');
  setBusy(button, true, 'Starting…');
  try {
    const value = await post('/api/pi/start', { workspace: app.workspace, modelId, sessionPath, sessionName: sessionName || undefined });
    app.pi.status = value.status; await refreshSnapshot(); await refreshThinkingLevels(); await refreshMessages(); await loadSessions(); toast('Pi started', 'success');
  } catch (e) { toast(e.message, 'error'); } finally { setBusy(button, false); }
}
async function stopPi() {
  try {
    await post('/api/pi/stop');
    app.pi = { status: {}, state: null, stats: null };
    app.streamMessage = null;
    app.sendingPrompt = false;
    app.toolCards.clear();
    renderPiSnapshot();
    toast('Pi stopped');
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function switchModel(modelId, provider) {
  try {
    let p = provider;
    let m = modelId;
    if (!p) {
      if (modelId.startsWith('ollama/')) { p = 'ollama'; m = modelId.slice(7); }
      else if (modelId.includes('/') && !modelId.startsWith('hf.co/')) { const parts = modelId.split('/'); p = parts[0]; m = parts.slice(1).join('/'); }
      else { p = 'ollama'; }
    }
    await rpc({ type: 'set_model', provider: p, modelId: m });
    await refreshSnapshot();
    await refreshThinkingLevels();
    toast(`Switched to ${modelId}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Prompt Submission ──────────────────────────────────────────────────────────
async function sendPrompt(mode = 'prompt') {
  const message = $('#composer').value.trim();
  if (!message) return;
  if (!app.pi.status?.running) return toast('Start Pi first', 'error');
  // Guard: prevent double-submit while a response is still streaming in
  if (app.sendingPrompt) return toast('Please wait for the current response to finish', 'error');

  const selectedMode = typeof mode === 'string' && mode ? mode : 'prompt';
  const images = app.attachments.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
  const command = { type: selectedMode, message, ...(images.length ? { images } : {}) };
  const sendBtn = $('#sendPrompt');

  // ── Store in composer history ─────────────────────────────────────────────
  if (selectedMode === 'prompt') {
    app.promptHistory.unshift(message);
    if (app.promptHistory.length > 50) app.promptHistory.length = 50;
    app.promptHistoryIndex = -1;
    app.promptDraft = '';
    try { sessionStorage.setItem('studio_prompt_history', JSON.stringify(app.promptHistory)); } catch { /* ignore */ }
  }

  app.sendingPrompt = true;
  setBusy(sendBtn, true, 'Working…');
  $('#agentStatus').textContent = 'Working';
  try {
    createMessage('user', message);
    $('#composer').value = '';
    app.attachments = [];
    renderAttachments();
    await rpc(command, { quiet: true });
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    app.sendingPrompt = false;
    setBusy(sendBtn, false);
  }
}

function switchView(name) {
  $$('.view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'terminal') loadTerminalSessions();
  if (name === 'git') loadGitPanel();
}
function switchSettings(name) { $$('.settings-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.settings === name)); $$('.settings-page').forEach((v) => v.classList.toggle('active', v.id === `settings-${name}`)); }

const HELP_TOPICS = [
  ['#topModel', 'docs-models', 'Selects the Ollama model Pi will use. Switching while Pi is running sends Pi a set_model RPC command.'],
  ['#thinkingLevel', 'docs-pi-agent', 'Controls Pi reasoning effort when the selected model and provider support it. Higher levels usually cost more time and tokens.'],
  ['#workspacePath', 'docs-safety', 'The project root for Pi tools, sessions, file browsing, Git status, and direct shell commands.'],
  ['#sendMode', 'docs-pi-agent', 'Send starts a turn, Steer injects guidance into the active turn, and Follow up queues work after it.'],
  ['#compactNow', 'docs-sessions', 'Summarizes older active context to free room. Completed file and shell side effects remain unchanged.'],
  ['#profileBaseModel', 'docs-models', 'The installed Ollama model used as the source for a persistent profile alias.'],
  ['#profileName', 'docs-models', 'The new local Ollama alias that stores your context and sampling parameters.'],
  ['#profileContext', 'docs-context', 'Maximum active context tokens for this profile. Larger values increase KV memory and prompt-processing time.'],
  ['#profileOutput', 'docs-models', 'Maximum tokens generated by one model response, not the total session length.'],
  ['#profileTemperature', 'docs-models', 'Sampling randomness. Values around 0.1–0.3 are usually suitable for coding agents.'],
  ['#profileTopP', 'docs-models', 'Nucleus sampling limit. Lower values make output more conservative.'],
  ['#profileTopK', 'docs-models', 'Limits sampling to the most likely token candidates.'],
  ['#profileMinP', 'docs-models', 'Filters very low-probability tokens relative to the best candidate. Keep near 0 for conservative coding.'],
  ['#profileSeed', 'docs-models', 'Sets deterministic sampling when supported. Use -1 for a random seed.'],
  ['#profileRepeat', 'docs-models', 'Discourages repeated output. Excessive values can reduce code consistency.'],
  ['#profileReasoning', 'docs-models', 'Marks the profile as reasoning-capable for Pi. It does not add reasoning ability to an incompatible model.'],
  ['#profileVision', 'docs-models', 'Marks the model as accepting image input. Enable only for a compatible multimodal model.'],
  ['#pullModelName', 'docs-models', 'Exact Ollama registry name to download into the local model library.'],
  ['#ollamaBaseUrl', 'docs-runtime', 'HTTP address of the Ollama API used by Studio and Pi model profiles.'],
  ['#kvCacheType', 'docs-context', 'Server-wide KV precision. q8_0 is the recommended memory/quality balance; changes require an Ollama restart.'],
  ['#flashAttention', 'docs-runtime', 'Enables Ollama Flash Attention where supported. Usually beneficial for long-context inference.'],
  ['#defaultContext', 'docs-runtime', 'Fallback Ollama server context. A named model profile can provide its own num_ctx.'],
  ['#numParallel', 'docs-runtime', 'Concurrent sequences per model. More slots multiply KV-cache pressure; use 1 for one coding agent.'],
  ['#maxLoadedModels', 'docs-runtime', 'Maximum models Ollama may keep resident at the same time.'],
  ['#maxQueue', 'docs-runtime', 'Maximum waiting requests when Ollama is already busy.'],
  ['#keepAlive', 'docs-runtime', 'How long an idle model remains loaded before Ollama releases it.'],
  ['#noCloud', 'docs-runtime', 'Prevents a managed Ollama server from using cloud-hosted models.'],
  ['#managedOllama', 'docs-runtime', 'When enabled, Studio auto-starts Ollama on its next launch if no Ollama server is already online.'],
  ['#sessionNameInput', 'docs-sessions', 'A readable name for the current persistent Pi session.'],
  ['#steeringMode', 'docs-sessions', 'Controls whether queued steering messages are delivered individually or together.'],
  ['#followUpMode', 'docs-sessions', 'Controls whether queued follow-up messages are delivered individually or together.'],
  ['#autoCompaction', 'docs-sessions', 'Allows Pi to compact old context automatically near the model limit.'],
  ['#autoRetry', 'docs-sessions', 'Retries transient provider/model failures. It does not undo or validate code changes.'],
  ['#compactInstructions', 'docs-sessions', 'Facts Pi should preserve when summarizing history, such as changed files, decisions, failures, and next steps.'],
  ['#bashCommand', 'docs-tools', 'Runs a shell command through the current Pi RPC process in the selected workspace.'],
  ['#rawRpc', 'docs-tools', 'Sends a documented Pi RPC command directly. This is intended for advanced and future commands.'],
  ['#piCommand', 'docs-troubleshooting', 'Executable or absolute path used to start the Pi CLI in RPC mode.'],
  ['#ollamaCommand', 'docs-troubleshooting', 'Executable or absolute path used when Studio starts a managed Ollama process.'],
  ['#trustProjects', 'docs-safety', 'Allows Pi to load project-level instructions and resources. Disable for unknown or untrusted repositories.'],
  ['#modelVram', 'docs-context', 'VRAM attributed to the currently loaded model by Ollama.'],
  ['#runtimeContext', 'docs-context', 'The active context allocation reported by Ollama for the loaded model.'],
  ['#kvEstimate', 'docs-context', 'An architecture-based estimate of KV memory, not an exact driver measurement.'],
  ['#offloadStatus', 'docs-context', 'Shows whether model data is mostly on GPU or partially offloaded to CPU/system RAM.']
];

function openDocumentation(targetId = 'docs-quick-start') {
  switchView('docs');
  requestAnimationFrame(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('doc-highlight');
    setTimeout(() => target.classList.remove('doc-highlight'), 1800);
  });
}

function installContextHelp() {
  for (const [selector, target, explanation] of HELP_TOPICS) {
    const control = $(selector);
    if (!control || control.dataset.helpInstalled) continue;
    control.dataset.helpInstalled = 'true';
    control.title = explanation;
    const host = control.closest('label, .metric-grid > div, .metric-card') || control.parentElement;
    if (!host || $('.help-dot', host)) continue;
    host.classList.add('has-help');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'help-dot'; button.textContent = '?';
    button.title = `${explanation} Open documentation.`;
    button.setAttribute('aria-label', `Help: ${explanation}`);
    button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openDocumentation(target); };
    host.append(button);
  }
}

function filterDocumentation(query) {
  const normalized = String(query || '').trim().toLowerCase();
  let visible = 0;
  $$('[data-doc-search]').forEach((card) => {
    const match = !normalized || card.textContent.toLowerCase().includes(normalized);
    card.classList.toggle('hidden', !match); if (match) visible += 1;
  });
  $('#docsNoResults').classList.toggle('hidden', visible > 0);
}


// ── Profile Creation ──────────────────────────────────────────────────────────
async function createProfile() {
  const button = $('#createProfile'); setBusy(button, true, 'Creating…');
  // Parse numeric fields with fallbacks to prevent NaN being sent to the API.
  // Empty form fields would produce NaN which Ollama rejects silently.
  const num = (id, fallback) => { const v = Number($(`#${id}`).value); return Number.isFinite(v) ? v : fallback; };
  const body = {
    baseModel: $('#profileBaseModel').value,
    name: $('#profileName').value,
    contextWindow: num('profileContext', 65536),
    maxTokens: num('profileOutput', 4096),
    temperature: num('profileTemperature', 0.15),
    topP: num('profileTopP', 0.9),
    topK: num('profileTopK', 40),
    minP: num('profileMinP', 0),
    repeatPenalty: num('profileRepeat', 1.1),
    seed: num('profileSeed', -1),
    mirostat: num('profileMirostat', 0),
    stop: $('#profileStop')?.value || '',
    system: $('#profileSystem')?.value || '',
    reasoning: $('#profileReasoning').checked,
    vision: $('#profileVision').checked
  };
  if (!body.baseModel) return (setBusy(button, false), toast('Select a base model first', 'error'));
  if (!body.name.trim()) return (setBusy(button, false), toast('Enter a profile name', 'error'));
  try {
    const value = await post('/api/ollama/profile', body);
    await refreshOllama();
    $('#topModel').value = value.profile.id;
    app.config.defaultModel = value.profile.id;
    await put('/api/config', { defaultModel: value.profile.id });
    toast('Profile created and added to Pi', 'success');
  } catch (e) { toast(e.message, 'error'); } finally { setBusy(button, false); }
}
async function pullModel() {
  const model = $('#pullModelName').value.trim(); if (!model) return;
  const button = $('#pullModel'); setBusy(button, true, 'Pulling…');
  try { await post('/api/ollama/pull', { model }); await refreshOllama(); toast('Model pulled', 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(button, false); }
}
async function doUnload(modelId) {
  const button = $('#unloadModel');
  setBusy(button, true, 'Unloading…');
  try {
    const activeRunning = app.ollama.running?.[0]?.model || app.ollama.running?.[0]?.name;
    const target = modelId || activeRunning || $('#topModel').value || '';
    await post('/api/ollama/unload', { model: target });
    await refreshOllama();
    toast('Model unloaded from VRAM', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
async function diagnoseModel() {
  const model = $('#topModel').value; if (!model) return;
  try { const value = await api(`/api/ollama/diagnostics?model=${enc(model)}&contextLength=${enc($('#profileContext').value || app.config.defaultContextLength)}&kvType=${enc(app.config.kvCacheType)}&parallel=${enc(app.config.numParallel)}`); const d = value.diagnostics; $('#kvEstimate').textContent = d.kv.formatted || 'Unknown'; $('#runtimeContext').textContent = d.running?.context_length ? formatNumber(d.running.context_length) : formatNumber(d.kv.contextLength); $('#modelVram').textContent = d.running ? formatBytes(d.running.size_vram) : 'Not loaded'; $('#offloadStatus').textContent = d.running ? (d.running.size_vram >= d.running.size * .95 ? 'GPU' : 'Partial') : '—'; toast(d.kv.reason || `Estimated KV cache: ${d.kv.formatted}`, d.kv.reason ? 'error' : 'success'); } catch (e) { toast(e.message, 'error'); }
}

async function saveRuntime() {
  const update = { ollamaBaseUrl: $('#ollamaBaseUrl').value, kvCacheType: $('#kvCacheType').value, flashAttention: $('#flashAttention').checked, defaultContextLength: Number($('#defaultContext').value), numParallel: Number($('#numParallel').value), maxLoadedModels: Number($('#maxLoadedModels').value), maxQueue: Number($('#maxQueue').value), keepAlive: $('#keepAlive').value, noCloud: $('#noCloud').checked, managedOllama: $('#managedOllama').checked };
  try { const value = await put('/api/config', update); app.config = value.config; toast('Runtime settings saved', 'success'); } catch (e) { toast(e.message, 'error'); }
}
async function saveCommands() { try { const value = await put('/api/config', { piCommand: $('#piCommand').value, ollamaCommand: $('#ollamaCommand').value, trustProjects: $('#trustProjects').checked }); app.config = value.config; toast('Command settings saved', 'success'); } catch (e) { toast(e.message, 'error'); } }

async function loadCommands() {
  try { const response = await rpc({ type: 'get_commands' }); const commands = response.data?.commands || []; const host = $('#commandList'); host.innerHTML = ''; for (const command of commands) { const node = document.createElement('div'); node.className = 'command-item'; node.innerHTML = `<strong>/${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description || command.source || '')}</span>`; node.onclick = () => { $('#composer').value = `/${command.name} `; switchView('chat'); $('#composer').focus(); }; host.append(node); } if (!commands.length) host.textContent = 'No extension, prompt, or skill commands found.'; } catch (e) { toast(e.message, 'error'); }
}

let sessionTreeData = null;
let currentTreeFilter = 'all';
let currentTreeMode = 'active_path';
let currentTreeSearch = '';
let treeExpandedState = false;

async function loadSessionTree(raw = false) {
  try {
    const response = await rpc({ type: raw ? 'get_entries' : 'get_tree' });
    const host = $('#sessionTree');
    host.innerHTML = '';
    if (raw) {
      host.innerHTML = `<pre style="padding:15px; font-family:var(--mono); white-space:pre-wrap;">${escapeHtml(JSON.stringify(response.data, null, 2))}</pre>`;
      if ($('#treeStatsBar')) $('#treeStatsBar').classList.add('hidden');
      return;
    }
    sessionTreeData = response.data?.tree || [];
    renderSessionTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function isNoiseEntry(entry) {
  const role = (entry.message?.role || entry.type || 'entry').toLowerCase();
  if (['model_change', 'thinking_level_change', 'system'].includes(role)) return true;
  if (role === 'tool_result') {
    const parsed = entry.message ? messageContent(entry.message) : { text: '' };
    const text = (parsed.text || '').trim();
    if (!text || text === '(no output)') return true;
  }
  return false;
}

function renderSessionTree() {
  const host = $('#sessionTree');
  host.innerHTML = '';
  host.classList.remove('empty-state');
  const statsBar = $('#treeStatsBar');
  const statsText = $('#treeStatsText');

  if (!sessionTreeData || !sessionTreeData.length) {
    host.innerHTML = '<div class="empty-state">Empty session</div>';
    if (statsBar) statsBar.classList.add('hidden');
    return;
  }

  let totalNodes = 0;
  let totalBranches = 0;
  function countStats(nodes) {
    for (const node of nodes || []) {
      totalNodes++;
      if (node.children && node.children.length > 1) totalBranches++;
      countStats(node.children);
    }
  }
  countStats(sessionTreeData);

  if (statsBar && statsText) {
    statsBar.classList.remove('hidden');
    statsText.textContent = `Total Nodes: ${totalNodes} | Branches: ${totalBranches} | Mode: ${currentTreeMode.replace('_', ' ').toUpperCase()}`;
  }

  const rootStream = document.createElement('div');
  rootStream.className = 'session-timeline-stream';

  if (currentTreeMode === 'active_path' || currentTreeMode === 'compact_noise') {
    for (const rootNode of sessionTreeData) {
      renderActivePathChain(rootNode, rootStream, currentTreeMode === 'compact_noise');
    }
  } else {
    for (const rootNode of sessionTreeData) {
      renderFullTreeChain(rootNode, rootStream, 0);
    }
  }

  host.append(rootStream);

  if (!rootStream.childElementCount) {
    host.innerHTML = '<div class="empty-state">No entries match the selected filter or view mode.</div>';
  }
}

function matchesFilter(entry) {
  const role = (entry.message?.role || entry.type || 'entry').toLowerCase();
  if (currentTreeFilter !== 'all') {
    if (currentTreeFilter === 'user' && role !== 'user') return false;
    if (currentTreeFilter === 'assistant' && role !== 'assistant') return false;
    if (currentTreeFilter === 'tool' && !['tool', 'tool_result'].includes(role)) return false;
    if (currentTreeFilter === 'compaction' && role !== 'compaction') return false;
  }

  if (currentTreeSearch) {
    const query = currentTreeSearch.toLowerCase();
    const parsed = entry.message ? messageContent(entry.message) : { text: '' };
    const text = (parsed.text + ' ' + (parsed.thinking || '') + ' ' + (entry.id || '')).toLowerCase();
    if (!text.includes(query)) return false;
  }

  return true;
}

function renderActivePathChain(node, streamContainer, hideNoise = false) {
  let current = node;
  while (current && current.entry) {
    const entry = current.entry;
    const children = current.children || [];

    if (matchesFilter(entry)) {
      if (hideNoise && isNoiseEntry(entry)) {
        streamContainer.append(createCompactChip(current));
      } else {
        const card = createSessionCard(current, { isFlatPath: true, altCount: Math.max(0, children.length - 1) });
        streamContainer.append(card);

        if (children.length > 1) {
          const altContainer = document.createElement('div');
          altContainer.className = 'session-branch-group hidden';
          altContainer.innerHTML = `<div class="session-branch-header">🌿 Alternate Forks (${children.length - 1})</div>`;

          children.slice(1).forEach((altChild, idx) => {
            const lane = document.createElement('div');
            lane.className = 'session-branch-lane';
            lane.innerHTML = `<span class="session-branch-lane-tag">Fork ${idx + 1}</span>`;
            const laneStream = document.createElement('div');
            laneStream.className = 'session-timeline-stream';
            renderActivePathChain(altChild, laneStream, hideNoise);
            lane.append(laneStream);
            altContainer.append(lane);
          });
          streamContainer.append(altContainer);

          const altBadge = card.querySelector('.tree-alt-branch-badge');
          if (altBadge) {
            altBadge.onclick = (e) => {
              e.stopPropagation();
              altContainer.classList.toggle('hidden');
              altBadge.textContent = altContainer.classList.contains('hidden') ? `🌿 +${children.length - 1} fork(s)` : `✕ Hide forks`;
            };
          }
        }
      }
    }

    current = children.length > 0 ? children[0] : null;
  }
}

function renderFullTreeChain(node, streamContainer, depth = 0) {
  if (!node || !node.entry) return;
  const entry = node.entry;
  const children = node.children || [];

  if (matchesFilter(entry)) {
    const card = createSessionCard(node, { isFlatPath: false });
    streamContainer.append(card);
  }

  if (children.length === 1) {
    renderFullTreeChain(children[0], streamContainer, depth);
  } else if (children.length > 1) {
    const branchGroup = document.createElement('div');
    branchGroup.className = 'session-branch-group';
    branchGroup.innerHTML = `<div class="session-branch-header">🌿 Branch Split (${children.length} paths)</div>`;

    children.forEach((child, idx) => {
      const lane = document.createElement('div');
      lane.className = 'session-branch-lane';
      lane.innerHTML = `<span class="session-branch-lane-tag">Branch ${idx + 1} ${idx === 0 ? '(Primary)' : '(Fork)'}</span>`;
      const laneStream = document.createElement('div');
      laneStream.className = 'session-timeline-stream';
      renderFullTreeChain(child, laneStream, depth + 1);
      lane.append(laneStream);
      branchGroup.append(lane);
    });

    streamContainer.append(branchGroup);
  }
}

function createCompactChip(node) {
  const entry = node.entry || {};
  const role = (entry.message?.role || entry.type || 'entry').toUpperCase();
  const chip = document.createElement('div');
  chip.className = 'tree-chip-compact';
  const shortId = (entry.id || '').slice(0, 8);
  const parsed = entry.message ? messageContent(entry.message) : { text: '' };
  const text = truncate(parsed.text || entry.type || '', 70);

  chip.innerHTML = `
    <div><strong>${escapeHtml(role)}</strong> <span class="muted">${escapeHtml(shortId)} ${escapeHtml(text)}</span></div>
    <small class="muted">${entry.timestamp ? formatTime(entry.timestamp) : ''}</small>
  `;
  return chip;
}

function createSessionCard(node, { isFlatPath = false, altCount = 0 } = {}) {
  const entry = node.entry || {};
  const children = node.children || [];
  const role = entry.message?.role || entry.type || 'entry';
  const isLeaf = children.length === 0;

  const card = document.createElement('div');
  card.className = `session-tree-card role-${escapeHtml(role)} ${isLeaf ? 'active-leaf' : ''}`;

  const roleBadge = `<span class="tree-node-badge ${escapeHtml(role)}">${escapeHtml(role)}</span>`;
  const leafBadge = isLeaf ? `<span class="tree-node-badge leaf">Active Tip</span>` : '';
  const altBadge = altCount > 0 ? `<span class="tree-alt-branch-badge" title="Click to view alternate forks">🌿 +${altCount} fork(s)</span>` : '';
  const shortId = (entry.id || '').slice(0, 10);
  const timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';

  const header = document.createElement('div');
  header.className = 'tree-card-header';
  header.innerHTML = `
    <div>${roleBadge} ${leafBadge} ${altBadge}</div>
    <div class="tree-card-meta">
      <span class="tree-card-id" title="Click to copy ID: ${escapeHtml(entry.id || '')}">${escapeHtml(shortId)}</span>
      ${timeStr ? `<span class="tree-card-time">${escapeHtml(timeStr)}</span>` : ''}
    </div>
  `;

  const idSpan = header.querySelector('.tree-card-id');
  if (idSpan && entry.id) {
    idSpan.onclick = () => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(entry.id);
        toast(`Copied entry ID: ${entry.id.slice(0, 8)}...`, 'success');
      }
    };
  }

  card.append(header);

  const parsed = entry.message ? messageContent(entry.message) : { text: entry.id || '' };
  const textContent = parsed.text || (typeof entry.message === 'string' ? entry.message : '');

  if (parsed.thinking) {
    const thinkingBox = document.createElement('div');
    thinkingBox.className = 'tree-card-thinking';
    thinkingBox.innerHTML = `<strong>🧠 Reasoning / Thinking:</strong>\n${escapeHtml(parsed.thinking)}`;
    thinkingBox.onclick = () => thinkingBox.classList.toggle('expanded');
    card.append(thinkingBox);
  }

  if (textContent) {
    const body = document.createElement('div');
    body.className = `tree-card-body ${treeExpandedState ? 'expanded' : ''}`;
    body.textContent = textContent;

    if (textContent.length > 200) {
      const toggle = document.createElement('div');
      toggle.className = 'tree-card-toggle';
      toggle.textContent = treeExpandedState ? '▲ Show less' : '▼ Show full message';
      toggle.onclick = () => {
        body.classList.toggle('expanded');
        toggle.textContent = body.classList.contains('expanded') ? '▲ Show less' : '▼ Show full message';
      };
      card.append(body, toggle);
    } else {
      card.append(body);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'tree-card-actions';

  if (entry.message?.role === 'user' && entry.id) {
    const forkBtn = document.createElement('button');
    forkBtn.className = 'sm-btn primary';
    forkBtn.textContent = '🌿 Fork Branch';
    forkBtn.onclick = async () => {
      try {
        await rpc({ type: 'fork', entryId: entry.id });
        await refreshMessages();
        await loadSessionTree();
        toast('Fork created at entry ' + shortId, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    actions.append(forkBtn);
  }

  const jsonBtn = document.createElement('button');
  jsonBtn.className = 'sm-btn secondary';
  jsonBtn.textContent = '{ } Raw JSON';
  const jsonBox = document.createElement('pre');
  jsonBox.className = 'tree-card-json hidden';
  jsonBox.textContent = JSON.stringify(entry, null, 2);

  jsonBtn.onclick = () => {
    jsonBox.classList.toggle('hidden');
    jsonBtn.textContent = jsonBox.classList.contains('hidden') ? '{ } Raw JSON' : '✕ Hide JSON';
  };

  actions.append(jsonBtn);
  card.append(actions, jsonBox);

  return card;
}

// ── Git Commit Panel ──────────────────────────────────────────────────────────
// State for the git panel
const gitPanel = { files: [], selectedFile: null };

async function loadGitPanel() {
  if (!app.workspace) { renderGitPanelEmpty('Open a workspace first'); return; }
  const host = $('#gitFileList');
  const statusDiv = $('#gitBranchInfo');
  if (!host) return;
  host.innerHTML = '<div class="empty-state">Loading git status…</div>';
  try {
    const value = await api(`/api/workspace/git?workspace=${enc(app.workspace)}`);
    const git = value.git;
    if (statusDiv) {
      statusDiv.textContent = git.isRepository
        ? `${git.branch || 'detached HEAD'}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
        : 'Not a git repository';
    }
    if (!git.isRepository) { renderGitPanelEmpty('Not a git repository'); return; }
    // Parse porcelain status
    const lines = String(git.porcelain || git.status || '').split('\n').filter(Boolean);
    gitPanel.files = lines.map((line) => {
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      return { xy, file, staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' };
    });
    renderGitFileList();
  } catch (e) {
    host.innerHTML = `<div class="empty-state error-text">${escapeHtml(e.message)}</div>`;
  }
}

function renderGitPanelEmpty(msg) {
  const host = $('#gitFileList');
  if (host) host.innerHTML = `<div class="empty-state">${escapeHtml(msg)}</div>`;
  const diff = $('#gitDiffContent');
  if (diff) diff.innerHTML = '<div class="empty-state">No file selected</div>';
}

function renderGitFileList() {
  const host = $('#gitFileList');
  if (!host) return;
  host.innerHTML = '';

  const stagedFiles = gitPanel.files.filter((f) => f.staged);
  const unstagedFiles = gitPanel.files.filter((f) => !f.staged || f.unstaged);

  const makeSection = (title, files, isStagedSection) => {
    if (!files.length) return;
    const header = document.createElement('div');
    header.className = 'git-file-section-header';
    header.innerHTML = `${escapeHtml(title)} <span class="git-file-count">${files.length}</span>`;
    host.append(header);
    for (const file of files) {
      const row = document.createElement('div');
      const isSelected = gitPanel.selectedFile === file.file;
      row.className = `git-file-row ${isSelected ? 'selected' : ''}`;
      const xy = file.xy;
      const statusChar = isStagedSection ? xy[0] : xy[1];
      const statusLabels = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked', '!': 'ignored', C: 'copied', U: 'conflict' };
      const statusLabel = statusLabels[statusChar] || statusChar;
      row.innerHTML = `
        <span class="git-file-status git-status-${statusLabel}">${statusChar || '?'}</span>
        <span class="git-file-name" title="${escapeHtml(file.file)}">${escapeHtml(file.file)}</span>
        <div class="git-file-actions">
          ${isStagedSection
            ? `<button class="sm-btn ghost" data-unstage="${escapeHtml(file.file)}">−</button>`
            : `<button class="sm-btn primary" data-stage="${escapeHtml(file.file)}">+</button>`}
        </div>
      `;
      row.querySelector('.git-file-name').onclick = () => loadGitFileDiff(file.file, isStagedSection);
      const stageBtn = row.querySelector('[data-stage]');
      if (stageBtn) stageBtn.onclick = (e) => { e.stopPropagation(); gitStageFile(file.file); };
      const unstageBtn = row.querySelector('[data-unstage]');
      if (unstageBtn) unstageBtn.onclick = (e) => { e.stopPropagation(); gitUnstageFile(file.file); };
      host.append(row);
    }
  };

  makeSection('Staged changes', stagedFiles, true);
  makeSection('Changed / Untracked', unstagedFiles, false);

  if (!host.childElementCount) {
    host.innerHTML = '<div class="empty-state">Working tree clean — nothing to commit</div>';
  }
}

async function loadGitFileDiff(filePath, staged = false) {
  gitPanel.selectedFile = filePath;
  const host = $('#gitDiffContent');
  if (!host) return;
  host.innerHTML = '<div class="empty-state">Loading diff…</div>';
  renderGitFileList(); // refresh selection highlight
  try {
    const value = await api(`/api/workspace/git/diff?workspace=${enc(app.workspace)}&path=${enc(filePath)}&staged=${staged ? '1' : '0'}`);
    const diff = value.diff || 'No diff available';
    const lines = diff.split('\n');
    host.innerHTML = `<div class="diff-viewer">${lines.map((line) => {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del'
        : line.startsWith('@@') ? 'hunk'
        : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') ? 'meta' : '';
      return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
    }).join('')}</div>`;
  } catch (e) { host.innerHTML = `<div class="empty-state error-text">${escapeHtml(e.message)}</div>`; }
}

async function gitStageFile(filePath) {
  try {
    await post('/api/workspace/git/stage', { workspace: app.workspace, path: filePath, stage: true });
    await loadGitPanel();
  } catch (e) { toast(e.message, 'error'); }
}

async function gitUnstageFile(filePath) {
  try {
    await post('/api/workspace/git/stage', { workspace: app.workspace, path: filePath, stage: false });
    await loadGitPanel();
  } catch (e) { toast(e.message, 'error'); }
}

async function gitCommit() {
  const msg = $('#gitCommitMessage')?.value?.trim();
  if (!msg) return toast('Enter a commit message', 'error');
  const btn = $('#gitCommitBtn');
  setBusy(btn, true, 'Committing…');
  try {
    await post('/api/workspace/git/commit', { workspace: app.workspace, message: msg });
    $('#gitCommitMessage').value = '';
    toast('Committed successfully', 'success');
    await loadGitPanel();
    await loadGit();
  } catch (e) { toast(e.message, 'error'); } finally { setBusy(btn, false); }
}

// ── Dedicated Terminal View & Session Manager ────────────────────────────────
async function loadTerminalSessions() {
  const host = $('#terminalSessionsList');
  if (!host) return;
  try {
    const value = await api('/api/terminal/sessions');
    const sessions = value.sessions || [];
    host.innerHTML = '';
    for (const session of sessions) {
      const card = document.createElement('div');
      card.className = 'terminal-card';
      const isRpc = session.type === 'rpc';
      card.innerHTML = `
        <div class="terminal-card-info">
          <strong>${escapeHtml(session.name || 'Terminal')} <span class="terminal-badge ${isRpc ? 'rpc' : ''}">${escapeHtml(session.type || 'term')}</span></strong>
          <span>PID: ${session.pid || '—'} · ${escapeHtml(session.workspace || '')} ${session.model ? `· ${escapeHtml(session.model)}` : ''}</span>
        </div>
        <div class="button-row" style="margin:0; gap:4px;">
          ${!isRpc ? `<button class="sm-btn danger ghost" data-kill="${escapeHtml(session.id)}">Kill</button>` : '<span class="muted" style="font-size:11px;">Active Engine</span>'}
        </div>
      `;
      const killBtn = $('[data-kill]', card);
      if (killBtn) {
        killBtn.onclick = () => killTerminalSession(session.id, session.pid);
      }
      host.append(card);
    }
    if (!host.childElementCount) {
      host.innerHTML = '<div class="empty-state">No active terminal sessions found. Click "+ New Terminal Window" to launch one.</div>';
    }
  } catch (e) {
    host.innerHTML = `<div class="empty-state error-text">Failed to load terminal sessions: ${escapeHtml(e.message)}</div>`;
  }
}

async function launchTerminalSession(attachPi = false) {
  try {
    const sessionFile = attachPi ? (app.pi.state?.sessionFile || null) : null;
    const model = attachPi ? (app.pi.status?.modelId || getSelectedModelId() || null) : (getSelectedModelId() || null);
    await post('/api/terminal/launch', {
      workspace: app.workspace || $('#workspacePath').value,
      model,
      sessionFile
    });
    toast(attachPi ? 'Terminal launched & attached to active Pi session' : 'New terminal window opened', 'success');
    await loadTerminalSessions();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function killTerminalSession(id, pid) {
  try {
    await post('/api/terminal/kill', { id, pid });
    toast('Terminal process killed', 'success');
    await loadTerminalSessions();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function executeWebConsoleCommand() {
  const input = $('#webConsoleInput');
  const output = $('#webConsoleOutput');
  const command = input.value.trim();
  if (!command) return;
  if (!app.pi.status?.running) return toast('Start Pi first to run Web Console commands', 'error');

  const btn = $('#runWebConsole');
  setBusy(btn, true, 'Executing…');
  output.textContent += `\n\n$ ${command}\n`;
  try {
    const id = `web-console-${Date.now()}`;
    const response = await rpc({ id, type: 'bash', command });
    const resultText = response.data?.output ?? JSON.stringify(response.data, null, 2);
    output.textContent += resultText;
    input.value = '';
    output.scrollTop = output.scrollHeight;
  } catch (e) {
    output.textContent += `Error: ${e.message}`;
    toast(e.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function renderAttachments() {
  const host = $('#attachments'); host.innerHTML = '';
  app.attachments.forEach((item, index) => { const node = document.createElement('div'); node.className = 'attachment'; node.innerHTML = `<span>${escapeHtml(item.name)}</span><button>×</button>`; $('button', node).onclick = () => { app.attachments.splice(index, 1); renderAttachments(); }; host.append(node); });
}
async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (app.attachments.length >= MAX_ATTACHMENTS) { toast(`Maximum ${MAX_ATTACHMENTS} images per message`, 'error'); break; }
    if (file.size > MAX_ATTACHMENT_BYTES) { toast(`${file.name} exceeds the 8 MB image limit`, 'error'); continue; }
    const currentBytes = app.attachments.reduce((sum, item) => sum + (item.size || 0), 0);
    if (currentBytes + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) { toast('Image attachments exceed the 16 MB total limit', 'error'); break; }
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    app.attachments.push({ name: file.name, mimeType: file.type, data: String(dataUrl).split(',')[1], size: file.size });
  }
  $('#imageInput').value = '';
  renderAttachments();
}

function renderExtensionWidgets() {
  const hosts = { aboveEditor: $('#extensionWidgets'), belowEditor: $('#extensionWidgetsBelow') };
  for (const host of Object.values(hosts)) host.innerHTML = '';
  for (const [key, widget] of app.extensionWidgets) {
    const host = hosts[widget.placement] || hosts.aboveEditor;
    const node = document.createElement('div'); node.className = 'extension-widget';
    const title = document.createElement('strong'); title.textContent = widget.title || key;
    const value = document.createElement('span'); value.textContent = widget.lines.join('\n');
    node.append(title, value); host.append(node);
  }
  for (const host of Object.values(hosts)) host.classList.toggle('hidden', !host.childElementCount);
}

function setExtensionStatus(request) {
  const key = String(request.statusKey || request.id);
  if (request.statusText === undefined) app.extensionStatuses.delete(key);
  else app.extensionStatuses.set(key, String(request.statusText));
  $('#extensionStatus').textContent = [...app.extensionStatuses.values()].join(' · ');
}

function setExtensionWidget(request) {
  const key = String(request.widgetKey || request.id);
  if (!Array.isArray(request.widgetLines)) app.extensionWidgets.delete(key);
  else app.extensionWidgets.set(key, {
    title: request.widgetKey || 'Extension',
    lines: request.widgetLines.map(String),
    placement: request.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor'
  });
  renderExtensionWidgets();
}

function showNextExtensionRequest() {
  if (app.currentExtensionRequest || !app.extensionRequestQueue.length) return;
  const request = app.extensionRequestQueue.shift();
  app.currentExtensionRequest = request;
  if (app.currentExtensionTimer) clearTimeout(app.currentExtensionTimer);
  $('#modalTitle').textContent = request.title || 'Pi extension request';
  $('#modalMessage').textContent = request.message || '';
  const host = $('#modalContent'); host.innerHTML = '';
  $('#modalConfirm').textContent = request.method === 'confirm' ? 'Confirm' : 'Submit';
  if (request.method === 'select') {
    for (const value of request.options || []) {
      const button = document.createElement('button'); button.className = 'modal-option'; button.textContent = value;
      button.onclick = () => { $$('.modal-option', host).forEach((x) => x.classList.remove('selected')); button.classList.add('selected'); };
      host.append(button);
    }
  } else if (request.method !== 'confirm') {
    const input = request.method === 'editor' ? document.createElement('textarea') : document.createElement('input');
    if (input.tagName === 'TEXTAREA') input.rows = 8;
    input.value = request.prefill || request.defaultValue || request.value || '';
    input.placeholder = request.placeholder || '';
    host.append(input);
  }
  $('#modal').classList.remove('hidden');
  if (Number(request.timeout) > 0) {
    app.currentExtensionTimer = setTimeout(() => {
      if (app.currentExtensionRequest?.id !== request.id) return;
      app.currentExtensionRequest = null;
      $('#modal').classList.add('hidden');
      toast('Extension request timed out');
      showNextExtensionRequest();
    }, Number(request.timeout));
  }
}

function handleExtensionRequest(request) {
  if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(request.method)) {
    if (request.method === 'notify') toast(request.message || request.title || 'Pi notification', request.notifyType === 'error' ? 'error' : '');
    else if (request.method === 'setTitle' && request.title) document.title = request.title;
    else if (request.method === 'set_editor_text') $('#composer').value = request.text || '';
    else if (request.method === 'setStatus') setExtensionStatus(request);
    else setExtensionWidget(request);
    return;
  }
  app.extensionRequestQueue.push(request);
  showNextExtensionRequest();
}
async function closeExtensionModal(cancelled = false) {
  const request = app.currentExtensionRequest; if (!request) return; const command = { type: 'extension_ui_response', id: request.id };
  if (cancelled) command.cancelled = true;
  else if (request.method === 'confirm') command.confirmed = true;
  else if (request.method === 'select') {
    const selected = $('.modal-option.selected', $('#modalContent'))?.textContent;
    if (selected === undefined) return toast('Select an option first', 'error');
    command.value = selected;
  }
  else command.value = $('#modalContent input, #modalContent textarea')?.value ?? '';
  try { await post('/api/pi/command', command); } catch (e) { toast(e.message, 'error'); }
  if (app.currentExtensionTimer) clearTimeout(app.currentExtensionTimer);
  app.currentExtensionTimer = null;
  app.currentExtensionRequest = null; $('#modal').classList.add('hidden');
  showNextExtensionRequest();
}

async function refreshLiveStatus() {
  if (app.statusRefreshInFlight || document.hidden) return;
  app.statusRefreshInFlight = true;
  try {
    const value = await api('/api/status');
    app.pi = value.pi;
    if (value.ollama) {
      if ((!value.ollama.models || !value.ollama.models.length) && app.ollama.models?.length && value.ollama.modelsAvailable === false) {
        value.ollama.models = app.ollama.models;
      }
      app.ollama = value.ollama;
    }
    app.system = value.system;
    renderPiSnapshot(); refreshModelSelectors(); renderSystem(); renderHealth();
  } catch (error) {
    log('STATUS', error.message);
  } finally {
    app.statusRefreshInFlight = false;
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  let lastErrorAt = 0;
  source.addEventListener('pi_event', (e) => handlePiEvent(JSON.parse(e.data)));
  source.addEventListener('pi_snapshot', (e) => { const value = JSON.parse(e.data); app.pi = value; renderPiSnapshot(); });
  source.addEventListener('pi_status', (e) => { app.pi.status = JSON.parse(e.data); renderPiSnapshot(); });
  source.addEventListener('pi_stderr', (e) => {
    const text = JSON.parse(e.data).text || '';
    log('PI STDERR', text);
    if (/error|failed|exception|oom|out of memory|panic/i.test(text)) {
      createMessage('error', `⚠️ **Pi Stderr Error:** ${text.slice(0, 500)}`);
    }
  });
  source.addEventListener('pi_protocol_error', (e) => {
    const value = JSON.parse(e.data);
    createMessage('error', `⚠️ **Protocol Error:** ${value.error || JSON.stringify(value)}`);
    log('PROTOCOL ERROR', value);
  });
  source.addEventListener('ollama_operation', (e) => { const value = JSON.parse(e.data); $('#ollamaProgress').textContent = `${value.operation} ${value.model || ''}: ${value.event?.status || JSON.stringify(value.event)}`; });
  source.addEventListener('ollama_models_changed', (e) => { app.ollama = JSON.parse(e.data); refreshModelSelectors(); renderHealth(); });
  source.addEventListener('ollama_log', (e) => log('OLLAMA', JSON.parse(e.data).text));
  source.addEventListener('server_error', (e) => {
    const value = JSON.parse(e.data);
    createMessage('error', `⚠️ **Server Error (${value.source || 'system'}):** ${value.error}`);
    toast(`${value.source}: ${value.error}`, 'error');
    log('SERVER ERROR', value);
  });
  source.onerror = () => {
    if (Date.now() - lastErrorAt > 10000) log('EVENTS', 'Connection interrupted; browser will reconnect.');
    lastErrorAt = Date.now();
  };
}

async function initialize() {
  try {
    const value = await api('/api/bootstrap'); Object.assign(app, { config: value.config, system: value.system, ollama: value.ollama, profiles: value.profiles, pi: value.pi });
    applyConfig(); refreshModelSelectors(); renderSystem(); renderHealth(); renderPiSnapshot(); installContextHelp();
    if (app.workspace) await Promise.allSettled([loadWorkspaceTree(), loadSessions(), loadGit()]); if (app.pi.status?.running) { await refreshThinkingLevels(); await refreshMessages(); }
  } catch (error) { toast(error.message, 'error'); log('BOOTSTRAP ERROR', error.message); }
  connectEvents();
  setInterval(refreshLiveStatus, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLiveStatus(); });
}

$$('.view-tabs button').forEach((button) => button.onclick = () => switchView(button.dataset.view));
$$('[data-doc-link]').forEach((button) => button.onclick = () => openDocumentation(button.dataset.docLink));
$('#docsSearch').oninput = (event) => filterDocumentation(event.target.value);
$$('.settings-tabs button').forEach((button) => button.onclick = () => switchSettings(button.dataset.settings));
$$('[data-prompt]').forEach((button) => button.onclick = () => { $('#composer').value = button.dataset.prompt; $('#composer').focus(); });
$('#applyWorkspace').onclick = applyWorkspace;
if ($('#openTerminal')) $('#openTerminal').onclick = async () => {
  try {
    const sessionFile = app.pi.state?.sessionFile || null;
    const model = app.pi.status?.modelId || getSelectedModelId() || null;
    await post('/api/workspace/terminal', {
      workspace: app.workspace || $('#workspacePath').value,
      model,
      sessionFile
    });
    toast('Terminal opened (attached to active Pi session)', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#refreshWorkspace').onclick = () => Promise.allSettled([loadWorkspaceTree(), loadGit()]); $('#refreshSessions').onclick = loadSessions;
$('#newSession').onclick = async () => { if (!app.pi.status?.running) return startPi(); try { await rpc({ type: 'new_session' }); await refreshMessages(); await loadSessions(); toast('New session started', 'success'); } catch (e) { toast(e.message, 'error'); } };
$('#startPi').onclick = () => startPi(); $('#stopPi').onclick = stopPi;
$('#topModel').onchange = () => {
  const isCustom = $('#topModel').value === '__custom__';
  $('#customModelInput').classList.toggle('hidden', !isCustom);
  renderActiveModel();
  const selected = getSelectedModelId();
  if (selected && !isCustom) localStorage.setItem('studio_selected_model', selected);
  if (app.pi.status?.running && selected && !isCustom) switchModel(selected);
};
$('#customModelInput').onchange = () => {
  const selected = getSelectedModelId();
  if (app.pi.status?.running && selected) switchModel(selected);
};
$('#thinkingLevel').onchange = () => rpc({ type: 'set_thinking_level', level: $('#thinkingLevel').value }).then(refreshSnapshot).catch(() => {});
$('#sendPrompt').onclick = () => sendPrompt('prompt');
if ($('#sendSteer')) $('#sendSteer').onclick = () => sendPrompt('steer');
if ($('#sendFollowUp')) $('#sendFollowUp').onclick = () => sendPrompt('follow_up');

$('#composer').onkeydown = (e) => {
  if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt('prompt');
    return;
  }
  // ── Composer history navigation (Up / Down arrows) ────────────────────
  if (e.key === 'ArrowUp' && !e.shiftKey) {
    const composer = $('#composer');
    if (composer.selectionStart !== 0 || composer.selectionEnd !== 0) return; // only at start of field
    if (app.promptHistory.length === 0) return;
    e.preventDefault();
    if (app.promptHistoryIndex === -1) app.promptDraft = composer.value;
    app.promptHistoryIndex = Math.min(app.promptHistoryIndex + 1, app.promptHistory.length - 1);
    composer.value = app.promptHistory[app.promptHistoryIndex];
    composer.selectionStart = composer.selectionEnd = composer.value.length;
    return;
  }
  if (e.key === 'ArrowDown' && !e.shiftKey) {
    const composer = $('#composer');
    if (app.promptHistoryIndex === -1) return;
    e.preventDefault();
    app.promptHistoryIndex -= 1;
    composer.value = app.promptHistoryIndex === -1 ? app.promptDraft : app.promptHistory[app.promptHistoryIndex];
    composer.selectionStart = composer.selectionEnd = composer.value.length;
    return;
  }
};
$('#abortAgent').onclick = () => rpc({ type: 'abort' });
$('#compactNow').onclick = async () => {
  const btn = $('#compactNow');
  setBusy(btn, true, 'Compacting…');
  try {
    const response = await rpc({ type: 'compact' });
    const data = response.data || {};
    createCompactionCard(data.summary, data.tokensBefore, data.tokensAfter);
    toast('Context compacted successfully', 'success');
    await refreshSnapshot();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(btn, false);
  }
};
$('#attachImage').onclick = () => $('#imageInput').click(); $('#imageInput').onchange = (e) => addImages(e.target.files);
$('#codeEditor').oninput = () => markEditorDirty($('#codeEditor').value !== app.editorOriginal); $('#saveFile').onclick = saveFile; $('#reloadFile').onclick = () => app.currentFile && openFile(app.currentFile.path);
$('#refreshTree').onclick = () => loadSessionTree(false);
if ($('#showDiffView')) $('#showDiffView').onclick = renderGitDiffView;
$('#refreshEntries').onclick = () => loadSessionTree(true);
$('#exportSession').onclick = async () => { try { const response = await rpc({ type: 'export_html' }); toast(`Exported: ${response.data?.path}`, 'success'); } catch {} };

if ($('#toggleExpandAllTree')) {
  $('#toggleExpandAllTree').onclick = () => {
    treeExpandedState = !treeExpandedState;
    $('#toggleExpandAllTree').textContent = treeExpandedState ? ' collapse all' : ' expand all';
    document.querySelectorAll('.tree-card-body').forEach((b) => {
      if (treeExpandedState) b.classList.add('expanded');
      else b.classList.remove('expanded');
    });
  };
}

document.querySelectorAll('#treeViewModeGroup button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#treeViewModeGroup button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTreeMode = btn.dataset.mode || 'active_path';
    renderSessionTree();
  };
});

document.querySelectorAll('#treeFilterGroup button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#treeFilterGroup button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTreeFilter = btn.dataset.filter || 'all';
    renderSessionTree();
  };
});

let treeSearchDebounce = null;
if ($('#treeSearchInput')) {
  $('#treeSearchInput').oninput = (e) => {
    currentTreeSearch = e.target.value.trim();
    clearTimeout(treeSearchDebounce);
    treeSearchDebounce = setTimeout(renderSessionTree, 150);
  };
}

try {
  const savedHistory = sessionStorage.getItem('studio_prompt_history');
  if (savedHistory) app.promptHistory = JSON.parse(savedHistory);
} catch { /* ignore */ }
$('#clearLogs').onclick = () => { app.logs = []; $('#logOutput').textContent = ''; }; $('#showProtocol').onchange = (e) => { app.protocolEvents = e.target.checked; };
$('#createProfile').onclick = createProfile; $('#pullModel').onclick = pullModel; $('#unloadModel').onclick = () => doUnload(); $('#diagnoseModel').onclick = diagnoseModel;
$('#saveRuntime').onclick = saveRuntime; $('#saveCommands').onclick = saveCommands; $('#syncModels').onclick = async () => { try { await post('/api/ollama/sync'); toast('Models synchronized to Pi', 'success'); } catch (e) { toast(e.message, 'error'); } };
if ($('#saveDefaultAgentsMd')) {
  $('#saveDefaultAgentsMd').onclick = async () => {
    try {
      const value = await put('/api/config', { defaultAgentsMd: $('#defaultAgentsMd').value });
      app.config = value.config;
      toast('Default AGENTS.md template saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}
$('#startManaged').onclick = () => post('/api/ollama/managed/start').then(async () => { await refreshLiveStatus(); toast('Managed Ollama started', 'success'); }).catch((e) => toast(e.message, 'error'));
$('#restartManaged').onclick = () => post('/api/ollama/managed/restart').then(async () => { await refreshLiveStatus(); toast('Managed Ollama restarted', 'success'); }).catch((e) => toast(e.message, 'error'));
$('#stopManaged').onclick = () => post('/api/ollama/managed/stop').then(async () => { await refreshLiveStatus(); toast('Managed Ollama stopped'); }).catch((e) => toast(e.message, 'error'));
$('#setSessionName').onclick = () => rpc({ type: 'set_session_name', name: $('#sessionNameInput').value }).then(refreshSnapshot);
$('#steeringMode').onchange = () => rpc({ type: 'set_steering_mode', mode: $('#steeringMode').value }); $('#followUpMode').onchange = () => rpc({ type: 'set_follow_up_mode', mode: $('#followUpMode').value });
$('#autoCompaction').onchange = () => rpc({ type: 'set_auto_compaction', enabled: $('#autoCompaction').checked }); $('#autoRetry').onchange = () => rpc({ type: 'set_auto_retry', enabled: $('#autoRetry').checked });
$('#compactWithInstructions').onclick = () => rpc({ type: 'compact', customInstructions: $('#compactInstructions').value || undefined }).then(refreshSnapshot); $('#loadCommands').onclick = loadCommands;
$('#runBash').onclick = async () => {
  const command = $('#bashCommand').value.trim();
  if (!command) return toast('Enter a shell command', 'error');
  const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  app.currentBashId = id;
  $('#bashOutput').textContent = '';
  setBusy($('#runBash'), true, 'Running…');
  try {
    const response = await rpc({ id, type: 'bash', command });
    const streamed = $('#bashOutput').textContent;
    if (!streamed) $('#bashOutput').textContent = response.data?.output ?? JSON.stringify(response.data, null, 2);
    if (response.data?.truncated && response.data?.fullOutputPath) $('#bashOutput').textContent += `

Full output: ${response.data.fullOutputPath}`;
  } catch (e) {
    $('#bashOutput').textContent = e.message;
  } finally {
    app.currentBashId = null;
    setBusy($('#runBash'), false);
  }
};
$('#sendRawRpc').onclick = async () => { try { const command = JSON.parse($('#rawRpc').value); const response = await rpc(command); $('#rawRpcResult').textContent = JSON.stringify(response, null, 2); } catch (e) { $('#rawRpcResult').textContent = e.message; } };
$('#modalCancel').onclick = () => closeExtensionModal(true); $('#modalConfirm').onclick = () => closeExtensionModal(false);
$('#collapseExplorer').onclick = () => { $('#fileTree').classList.toggle('hidden'); $('#collapseExplorer').textContent = $('#fileTree').classList.contains('hidden') ? '+' : '−'; };
window.addEventListener('beforeunload', (e) => { if ($('#codeEditor').value !== app.editorOriginal) { e.preventDefault(); e.returnValue = ''; } });

if ($('#launchDesktopTerminal')) $('#launchDesktopTerminal').onclick = () => launchTerminalSession(false);
if ($('#attachPiTerminal')) $('#attachPiTerminal').onclick = () => launchTerminalSession(true);
if ($('#refreshTerminalSessions')) $('#refreshTerminalSessions').onclick = () => loadTerminalSessions();
if ($('#runWebConsole')) $('#runWebConsole').onclick = executeWebConsoleCommand;
if ($('#webConsoleInput')) $('#webConsoleInput').onkeydown = (e) => { if (e.key === 'Enter') executeWebConsoleCommand(); };

// ── Context gauge click-to-compact ────────────────────────────────────────
if ($('#contextGaugeBadge')) {
  $('#contextGaugeBadge').style.cursor = 'pointer';
  $('#contextGaugeBadge').onclick = async () => {
    if (!app.pi.status?.running) return;
    const context = app.pi.stats?.contextUsage;
    const pct = context ? (context.percent ?? Math.round((context.tokens / context.contextWindow) * 100)) : 0;
    if (pct < 50) return toast('Context usage is low — compact not needed yet', '');
    if (!confirm(`Context is at ${pct}%. Compact now to free space?`)) return;
    const btn = $('#compactNow');
    setBusy(btn, true, 'Compacting…');
    try {
      const response = await rpc({ type: 'compact' });
      const data = response.data || {};
      createCompactionCard(data.summary, data.tokensBefore, data.tokensAfter);
      toast('Context compacted', 'success');
      await refreshSnapshot();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(btn, false); }
  };
}

// ── Fork from chat — right-click context menu on user messages ────────────
$('#messages').addEventListener('click', async (e) => {
  const forkTrigger = e.target.closest('[data-fork-entry]');
  if (!forkTrigger) return;
  const entryId = forkTrigger.dataset.forkEntry;
  if (!entryId || !app.pi.status?.running) return;
  try {
    await rpc({ type: 'fork', entryId });
    await refreshMessages();
    await loadSessionTree();
    toast('Branch forked from this message', 'success');
    switchView('tree');
  } catch (e) { toast(e.message, 'error'); }
});

// ── Git panel event wiring ────────────────────────────────────────────────
if ($('#gitCommitBtn')) $('#gitCommitBtn').onclick = gitCommit;
if ($('#gitRefreshBtn')) $('#gitRefreshBtn').onclick = loadGitPanel;
if ($('#gitStageAllBtn')) $('#gitStageAllBtn').onclick = async () => {
  try {
    await post('/api/workspace/git/stage', { workspace: app.workspace, path: '.', stage: true, all: true });
    await loadGitPanel();
    toast('All changes staged', 'success');
  } catch (e) { toast(e.message, 'error'); }
};
if ($('#gitCommitMessage')) {
  $('#gitCommitMessage').onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) gitCommit();
  };
}

initialize();
