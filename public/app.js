import { CommandRegistry, isEditableTarget, rankCommands } from './command-system.js';
import { BufferManager, RegisterStore, SemanticMacroRecorder, WorkspaceStateStore } from './workbench.js';
import { MonacoDiffAdapter, MonacoWorkbenchAdapter } from './monaco-adapter.js';
import { mergeDiagnostics, normalizeDiagnostic, parseTextDiagnostics } from './diagnostics.js';
import { MonacoLspBridge } from './lsp-client.js';
import { createProviderPanel, providerModelEntries } from './provider-panel.js';
import { createMcpPanel } from './mcp-panel.js';
import { createPackageMarketplace } from './package-marketplace.js';
import { createPiPlatformPanel } from './pi-platform-panel.js';
import { createPreviewPanel } from './preview-panel.js';

// ── DOM Helpers ─────────────────────────────────────────────────────────────────
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ── Application State ─────────────────────────────────────────────────────────
// Single global object for all runtime state. Mutated in place by event
// handlers and API responses; never replaced wholesale so references stay valid.
const app = {
  // Server-side config & system info (populated on bootstrap)
  config: {}, system: {}, ollama: { models: [], running: [] }, managedOllama: { running: false, pid: null }, testedOllama: null, profiles: [], providers: [], harnesses: [], harnessErrors: [], mcp: { servers: [], logs: [] },
  // Pi agent state (populated on connect / SSE events)
  pi: { status: {}, state: null, stats: null, resourceRestartRequired: false, resourceRestartReason: '', resourceRestartInProgress: false },
  // Workspace & session state
  workspace: '', workspaceEpoch: 0, sessions: [], attachments: [], currentFile: null, editorOriginal: '', logs: [], workspaceFiles: [],
  // UI streaming state
  toolCards: new Map(), streamMessage: null, currentExtensionRequest: null, extensionRequestQueue: [],
  extensionWidgets: new Map(), extensionStatuses: new Map(), currentExtensionTimer: null,
  // Misc flags
  currentBashId: null, protocolEvents: false, statusRefreshInFlight: false,
  // sendingPrompt: true while a prompt RPC is in-flight; blocks double-submit
  sendingPrompt: false, agentBusy: false,
  // Composer history (up/down arrow cycling)
  promptHistory: [], promptHistoryIndex: -1, promptDraft: '',
  // Keyboard-first interaction layer. Standard mode remains the default.
  interaction: { mode: 'standard', vimMode: 'normal', leaderPending: false, leaderPrefix: '', selectedIndex: -1, marks: {}, pendingMarkAction: null, pendingRegister: null, pendingMacroAction: null, lastRepeatable: null },
  checkpoints: {}, pendingCheckpoint: null, problems: [], currentProblemIndex: -1, problemSeverityFilter: 'all',
  resources: { commands: [], filter: 'all', query: '' },
  platform: { snapshot: null, tab: 'overview', selected: null, dirty: false },
  workbench: new BufferManager(), registers: new RegisterStore(), macros: new SemanticMacroRecorder(), workspaceState: new WorkspaceStateStore(),
  monaco: null, monacoDiff: null, monacoAvailable: false, lsp: null, lspStatuses: [], editorViewStates: {}, workbenchPersistTimer: null,
  gitDiffInline: false, gitDiffModel: null, gitDiffPatch: '', git: null, gitOnboardingResolve: null, workspaceSearch: { query: '', matches: [], truncated: false },
  terminals: { sessions: [], instances: new Map(), activePrimary: null, activeSecondary: null, activePane: 'primary', split: 'none', capabilities: null },
  tests: { discovery: null, runConfigurations: [], lastResult: null, lastTarget: null, statusByPath: new Map() }
};

let packageMarketplace = null;
let piPlatformPanel = null;
let previewPanel = null;

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
  if (!response.ok || value.ok === false) {
    const error = new Error(value.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.code = value.code || '';
    error.details = value.details;
    throw error;
  }
  return value;
}

function post(path, body = {}) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }
function put(path, body = {}) { return api(path, { method: 'PUT', body: JSON.stringify(body) }); }
function del(path, body = {}) { return api(path, { method: 'DELETE', body: JSON.stringify(body) }); }
function enc(value) { return encodeURIComponent(value ?? ''); }
function captureWorkspaceContext() { return { workspace: app.workspace, epoch: app.workspaceEpoch }; }
function workspaceContextIsCurrent(context) { return Boolean(context && context.epoch === app.workspaceEpoch && context.workspace === app.workspace); }
function workspacePathKey(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
function workspacePathsEquivalent(a, b) { return Boolean(a && b && workspacePathKey(a) === workspacePathKey(b)); }
function piPayloadBelongsToWorkspace(status, workspace = app.workspace) { return !status?.running || !status?.workspace || workspacePathsEquivalent(status.workspace, workspace); }

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
      const label = value.loaded === true ? '🟢 TTS Ready' : value.loaded === false ? '🟡 TTS Online · sleeping' : '🟢 TTS Online';
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

let lastTtsObjectUrl = '';
function ttsEndpoint() { return String($('#ttsUrl')?.value || 'http://localhost:7860').trim() || 'http://localhost:7860'; }
function setTtsStatusText(text, kind = '') { const node = $('#ttsStatusText'); if (node) { node.textContent = text; node.className = `muted ${kind}`; } }
async function refreshTtsStatus({ silent = false } = {}) {
  const result = await checkTtsStatus(ttsEndpoint(), silent);
  setTtsStatusText(result.label || (result.online ? 'TTS online' : 'TTS offline'), result.online ? 'success-text' : 'error-text');
  return result;
}
async function ttsLifecycle(action) {
  try {
    const result = await post(`/api/tts/${action}`, { url: ttsEndpoint() });
    const health = await refreshTtsStatus({ silent: true });
    if (!health?.online) setTtsStatusText(`TTS ${action}: ${result.status || result.state || 'ok'}`, 'success-text');
    toast(`TTS ${action} complete`, 'success');
    return result;
  } catch (error) { setTtsStatusText(`TTS ${action} failed: ${error.message}`, 'error-text'); toast(error.message, 'error'); return null; }
}
async function generateTtsAudio(text = '', { autoplay = true } = {}) {
  const input = String(text || $('#ttsText')?.value || '').trim();
  if (!input) { toast('Enter text for TTS first', 'error'); return null; }
  const button = $('#ttsGenerate'); setBusy(button, true, 'Generating…');
  try {
    const response = await fetch('/api/tts/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: ttsEndpoint(), text: input, response_format: 'wav' }) });
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || `TTS generation failed (${response.status})`); }
    const blob = await response.blob();
    if (lastTtsObjectUrl) URL.revokeObjectURL(lastTtsObjectUrl);
    lastTtsObjectUrl = URL.createObjectURL(blob);
    const audio = $('#ttsAudio'); audio.src = lastTtsObjectUrl; audio.classList.remove('hidden');
    if (autoplay) await audio.play().catch(() => null);
    setTtsStatusText(autoplay && !audio.paused ? 'Audio generated and playing.' : 'Audio generated and ready to play.', 'success-text');
    toast('TTS audio generated', 'success');
    return lastTtsObjectUrl;
  } catch (error) { setTtsStatusText(`TTS generation failed: ${error.message}`, 'error-text'); toast(error.message, 'error'); return null; }
  finally { setBusy(button, false); }
}
function speakWithBrowser(text) {
  const input = String(text || $('#ttsText')?.value || '').trim();
  if (!input) { toast('Enter text to speak first', 'error'); return; }
  if (!('speechSynthesis' in window)) { toast('This browser does not provide speech synthesis', 'error'); return; }
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(input));
}

function option(select, value, label = value) {
  const node = document.createElement('option'); node.value = value; node.textContent = label; select.append(node);
}

// ── Harness / Session Launch Contract ────────────────────────────────────────
// A harness is deliberately separate from model/runtime/workspace. Coding
// harnesses are agent harnesses with coding-specific tools and guidance.
function harnessById(id) {
  const key = String(id || '').trim();
  return (app.harnesses || []).find((item) => item.id === key) || (app.harnesses || [])[0] || null;
}

function selectedHarnessId() {
  return String($('#topHarness')?.value || localStorage.getItem('studio_selected_harness') || 'coding-default').trim() || 'coding-default';
}

function refreshHarnessSelectors(preferredId = '') {
  const preferred = String(preferredId || '').trim();
  const saved = preferred || selectedHarnessId();
  for (const select of [$('#topHarness'), $('#sessionLaunchHarness')].filter(Boolean)) {
    const current = preferred || select.value || saved;
    select.innerHTML = '';
    for (const harness of app.harnesses || []) {
      const scope = harness.source && harness.source !== 'builtin' ? ` · ${harness.scope || harness.source}` : '';
      option(select, harness.id, `${harness.name || harness.id}${scope}`);
    }
    const fallback = (app.harnesses || [])[0]?.id || 'coding-default';
    select.value = [...select.options].some((item) => item.value === current) ? current : fallback;
  }
  if ($('#topHarness')?.value) localStorage.setItem('studio_selected_harness', $('#topHarness').value);
  renderHarnessStatus();
  renderSessionHarnessDetails();
  renderHarnessWorkbench();
}

async function loadHarnesses({ quiet = false } = {}) {
  try {
    const value = await api(`/api/harnesses?workspace=${enc(app.workspace || '')}`);
    app.harnesses = value.harnesses || [];
    app.harnessErrors = value.errors || [];
    refreshHarnessSelectors();
    return app.harnesses;
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
    return app.harnesses || [];
  }
}

function harnessToolLabels(harness) {
  return Array.isArray(harness?.tools) ? harness.tools : [harness?.id === 'coding-web' ? 'Pi default tools + enabled web tools' : 'Pi default tools + extension tools'];
}

function renderHarnessWorkbench() {
  const contract = $('#effectiveHarnessContract');
  const selected = harnessById(selectedHarnessId());
  const active = app.pi.status?.running ? harnessById(app.pi.status?.harnessId || selectedHarnessId()) : null;
  const effective = active || selected;
  if (contract) {
    const model = app.pi.status?.running ? (app.pi.status?.modelId || app.pi.state?.model?.id || getSelectedModelId()) : getSelectedModelId();
    const running = runningOllamaModel(model);
    const cells = [
      ['State', app.pi.status?.running ? 'Active session' : 'Next session'],
      ['Harness', effective?.name || '—'],
      ['Scope', effective?.source === 'builtin' ? 'Built-in' : (effective?.scope || effective?.source || '—')],
      ['Model', model || '—'],
      ['GPU', isProviderModelSelection(model) ? 'Provider-managed' : running ? `Loaded · ${formatBytes(running.size_vram)} VRAM` : 'Not loaded'],
      ['Tools', Array.isArray(effective?.tools) ? `${effective.tools.length} allowed` : 'Pi default']
    ];
    contract.innerHTML = cells.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('');
  }
  const warning = $('#harnessLoadWarning');
  if (warning) {
    const errors = app.harnessErrors || [];
    warning.classList.toggle('hidden', !errors.length);
    warning.textContent = errors.length ? `${errors.length} harness manifest${errors.length === 1 ? '' : 's'} could not be loaded. Studio left the files untouched; repair or remove them before overwriting.` : '';
  }
  const host = $('#harnessPresetList');
  if (!host) return;
  host.innerHTML = '';
  for (const harness of app.harnesses || []) {
    const card = document.createElement('article');
    const isSelected = harness.id === selectedHarnessId();
    const isActive = Boolean(app.pi.status?.running && harness.id === (app.pi.status?.harnessId || 'coding-default'));
    card.className = `harness-preset-card ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`;
    const tools = harnessToolLabels(harness);
    card.innerHTML = `<div class="harness-preset-head"><div><strong>${escapeHtml(harness.name || harness.id)}</strong><small>${escapeHtml(harness.kind || 'agent')} · ${escapeHtml(harness.source === 'builtin' ? 'built-in' : harness.scope || harness.source || 'custom')}</small></div>${isActive ? '<span class="health online">ACTIVE</span>' : isSelected ? '<span class="health">NEXT</span>' : ''}</div><p class="muted">${escapeHtml(harness.description || 'Reusable Pi launch contract.')}</p><div class="harness-tool-chips">${tools.map((tool) => `<span class="harness-tool-chip ${Array.isArray(harness.tools) ? 'emphasis' : ''}">${escapeHtml(tool)}</span>`).join('')}</div><div class="harness-meta"><span>${harness.resourcePolicy === 'inherit-pi' || !harness.resourcePolicy ? 'Pi resources inherited' : escapeHtml(harness.resourcePolicy)}</span>${harness.file ? `<span title="${escapeHtml(harness.file)}">manifest file</span>` : ''}</div>${harness.appendSystemPrompt ? `<details class="harness-prompt-preview"><summary>System guidance</summary>${escapeHtml(harness.appendSystemPrompt)}</details>` : ''}<div class="harness-preset-actions"></div>`;
    const actions = $('.harness-preset-actions', card);
    const use = document.createElement('button'); use.className = 'sm-btn primary'; use.textContent = isSelected ? 'Selected' : 'Use next'; use.disabled = isSelected; use.onclick = () => selectHarnessForNextSession(harness.id); actions.append(use);
    const session = document.createElement('button'); session.className = 'sm-btn'; session.textContent = 'New Session'; session.onclick = () => { selectHarnessForNextSession(harness.id); openSessionLauncher({ title: `New Session · ${harness.name}` }); }; actions.append(session);
    const edit = document.createElement('button'); edit.className = 'sm-btn'; edit.textContent = harness.editable ? 'Edit' : 'Duplicate'; edit.onclick = () => openHarnessBuilder(harness, { duplicate: !harness.editable }); actions.append(edit);
    if (harness.editable) {
      const remove = document.createElement('button'); remove.className = 'sm-btn danger ghost'; remove.textContent = 'Delete'; remove.onclick = () => removeHarness(harness); actions.append(remove);
    }
    host.append(card);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No harnesses available.</div>';
}

function selectHarnessForNextSession(id) {
  const harness = harnessById(id);
  if (!harness) return;
  if ($('#topHarness')) $('#topHarness').value = harness.id;
  localStorage.setItem('studio_selected_harness', harness.id);
  refreshHarnessSelectors();
  toast(`${harness.name} selected for the next session`, 'success');
}

function setHarnessToolPicker(tools) {
  const inherit = tools == null;
  if ($('#harnessBuilderDefaultTools')) $('#harnessBuilderDefaultTools').checked = inherit;
  const core = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
  const selected = new Set(Array.isArray(tools) ? tools : []);
  $$('#harnessBuilderCoreTools input[type="checkbox"]').forEach((node) => { node.checked = inherit ? false : selected.has(node.value); node.disabled = inherit; });
  const extra = Array.isArray(tools) ? tools.filter((tool) => !core.has(tool)) : [];
  if ($('#harnessBuilderExtraTools')) { $('#harnessBuilderExtraTools').value = extra.join(', '); $('#harnessBuilderExtraTools').disabled = inherit; }
}

function openHarnessBuilder(harness = null, { duplicate = false, effective = false } = {}) {
  const modal = $('#harnessBuilderModal');
  if (!modal) return;
  const base = harness || (effective ? harnessById(app.pi.status?.harnessId || selectedHarnessId()) : null) || { kind: 'coding', tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] };
  const editing = Boolean(base?.editable && !duplicate && !effective);
  $('#harnessBuilderTitle').textContent = editing ? `Edit Harness · ${base.name}` : effective ? 'Save Effective Harness' : duplicate ? `Duplicate Harness · ${base.name}` : 'New Harness';
  $('#harnessBuilderId').value = editing ? base.id : '';
  $('#harnessBuilderName').value = editing ? base.name : base?.name ? `${base.name} Copy` : '';
  $('#harnessBuilderDescription').value = base?.description || '';
  $('#harnessBuilderKind').value = base?.kind === 'agent' ? 'agent' : 'coding';
  const scope = editing ? (base.scope || 'global') : app.workspace ? 'project' : 'global';
  $('#harnessBuilderScope').value = scope;
  $('#harnessBuilderScope').disabled = editing;
  $('#harnessBuilderPrompt').value = base?.appendSystemPrompt || '';
  setHarnessToolPicker(base?.tools ?? null);
  updateHarnessBuilderSaveState();
  modal.classList.remove('hidden');
  setTimeout(() => $('#harnessBuilderName')?.focus?.(), 0);
}

function closeHarnessBuilder() { $('#harnessBuilderModal')?.classList.add('hidden'); }

function updateHarnessBuilderSaveState() {
  const name = String($('#harnessBuilderName')?.value || '').trim();
  const scope = $('#harnessBuilderScope')?.value || 'global';
  if ($('#harnessBuilderSave')) $('#harnessBuilderSave').disabled = !name || (scope === 'project' && !app.workspace);
}

function collectHarnessBuilderTools() {
  if ($('#harnessBuilderDefaultTools')?.checked) return null;
  const tools = $$('#harnessBuilderCoreTools input[type="checkbox"]:checked').map((node) => node.value);
  const extras = String($('#harnessBuilderExtraTools')?.value || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const tool of extras) if (!tools.includes(tool)) tools.push(tool);
  return tools;
}

async function saveHarnessBuilder() {
  const name = String($('#harnessBuilderName')?.value || '').trim();
  if (!name) return toast('Harness name is required', 'error');
  const scope = $('#harnessBuilderScope')?.value || 'global';
  if (scope === 'project' && !app.workspace) return toast('Open a workspace before saving a project harness', 'error');
  const editingId = String($('#harnessBuilderId')?.value || '').trim();
  const editsActiveHarness = Boolean(editingId && app.pi.status?.running && editingId === (app.pi.status?.harnessId || 'coding-default'));
  const button = $('#harnessBuilderSave'); setBusy(button, true, 'Saving…');
  try {
    const value = await post('/api/harnesses', {
      workspace: app.workspace,
      scope,
      harness: {
        id: String($('#harnessBuilderId')?.value || '').trim() || undefined,
        name,
        kind: $('#harnessBuilderKind')?.value || 'agent',
        description: $('#harnessBuilderDescription')?.value || '',
        tools: collectHarnessBuilderTools(),
        appendSystemPrompt: $('#harnessBuilderPrompt')?.value || ''
      }
    });
    app.harnesses = value.harnesses || [];
    app.harnessErrors = value.errors || [];
    const saved = value.harness;
    if (saved?.id) localStorage.setItem('studio_selected_harness', saved.id);
    refreshHarnessSelectors(saved?.id || '');
    closeHarnessBuilder();
    if (editsActiveHarness) markPiResourceChange(`Harness ${saved?.name || name} changed`);
    toast(`Harness saved · ${saved?.name || name}`, 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); updateHarnessBuilderSaveState(); }
}

async function removeHarness(harness) {
  if (!harness?.editable) return;
  if (app.pi.status?.running && harness.id === (app.pi.status?.harnessId || 'coding-default')) return toast('This harness is active. Stop Pi or start a session with another harness before deleting it.', 'error');
  if (typeof window.confirm === 'function' && !window.confirm(`Delete harness "${harness.name}"? The manifest will be removed from ${harness.scope || 'its'} scope.`)) return;
  try {
    const value = await del('/api/harnesses', { workspace: app.workspace, scope: harness.scope || 'global', id: harness.id });
    app.harnesses = value.harnesses || [];
    app.harnessErrors = value.errors || [];
    if (selectedHarnessId() === harness.id) localStorage.setItem('studio_selected_harness', 'coding-default');
    refreshHarnessSelectors();
    toast(`Harness deleted · ${harness.name}`, 'success');
  } catch (error) { toast(error.message, 'error'); }
}

function renderHarnessStatus() {
  const effectiveId = app.pi.status?.running ? (app.pi.status?.harnessId || selectedHarnessId()) : selectedHarnessId();
  const harness = harnessById(effectiveId);
  const node = $('#harnessHealth');
  if (!node) return;
  node.textContent = `Harness ${harness?.name || effectiveId || '—'}`;
  node.title = app.pi.status?.running
    ? `Active session harness: ${harness?.name || effectiveId}`
    : `Harness selected for the next session: ${harness?.name || effectiveId}`;
  node.classList.toggle('online', Boolean(app.pi.status?.running));
  renderTtsAgentToolStatus(harness, effectiveId);
}

function renderTtsAgentToolStatus(harness = null, effectiveId = '') {
  const node = $('#ttsAgentToolStatus');
  if (!node) return;
  const sessionLabel = app.pi.status?.running ? 'active session' : 'next session';
  const harnessName = harness?.name || effectiveId || 'Pi default';
  const launchTools = app.pi.status?.running ? app.pi.status?.tools : harness?.tools;
  const explicitTools = Array.isArray(launchTools) ? launchTools.map((tool) => String(tool || '').trim()) : null;
  const available = explicitTools === null || explicitTools.includes('tts_speak');
  node.textContent = available
    ? `Agent tool: tts_speak is available through the ${sessionLabel} harness (${harnessName}).`
    : `Agent tool: tts_speak is not enabled in the ${sessionLabel} harness (${harnessName}). Add it under Harness > Additional extension tools, then restart or start the session.`;
  node.title = available
    ? 'The agent may call tts_speak when the local Qwen3-TTS service is online.'
    : 'The TTS controls below still work manually; only agent access is restricted by this harness allowlist.';
}

function isProviderModelSelection(modelId) {
  const value = String(modelId || '').trim();
  return providerModelEntries(app.providers || []).some((entry) => entry.value === value);
}

function selectedSessionModelId() {
  const select = $('#sessionLaunchModel');
  if (!select) return getSelectedModelId();
  if (select.value === '__custom__') return String($('#sessionLaunchCustomModel')?.value || '').trim();
  return String(select.value || '').trim();
}

function runningOllamaModel(modelId) {
  let wanted = String(modelId || '').trim();
  if (wanted.startsWith('ollama/')) wanted = wanted.slice(7);
  const aliases = modelIdAliases(wanted);
  return (app.ollama?.running || []).find((item) => {
    const current = modelIdAliases(item?.model || item?.name);
    for (const alias of aliases) if (current.has(alias)) return true;
    return false;
  }) || null;
}

function renderSessionModelState() {
  const node = $('#sessionLaunchModelState');
  if (!node) return;
  node.classList.remove('running', 'remote');
  const modelId = selectedSessionModelId();
  if (!modelId) { node.textContent = 'Select a model.'; return; }

  if (isProviderModelSelection(modelId)) {
    const providerId = modelId.split('/')[0];
    const provider = (app.providers || []).find((item) => item.id === providerId);
    node.classList.add('remote');
    node.textContent = `${provider?.name || providerId} · remote/provider model · GPU residency is managed outside Ollama.`;
    return;
  }

  const running = runningOllamaModel(modelId);
  if (running) {
    node.classList.add('running');
    const context = running.context_length ? ` · ${formatNumber(running.context_length)} context` : '';
    node.textContent = `● Already loaded on ${app.ollama?.runtime?.name || app.config?.ollamaRuntimeName || 'active Ollama'} · ${formatBytes(running.size_vram)} VRAM${context}. Starting another session with this model avoids an unnecessary model swap.`;
  } else {
    node.textContent = `○ Selected for this session · not currently loaded on ${app.ollama?.runtime?.name || app.config?.ollamaRuntimeName || 'active Ollama'}. Ollama will load it when Pi first uses it.`;
  }
}

function renderSessionHarnessDetails() {
  const select = $('#sessionLaunchHarness');
  const harness = harnessById(select?.value || selectedHarnessId());
  if (!harness) return;
  if ($('#sessionHarnessName')) $('#sessionHarnessName').textContent = harness.name || harness.id;
  if ($('#sessionHarnessDescription')) $('#sessionHarnessDescription').textContent = harness.description || '';
  const tools = $('#sessionHarnessTools');
  if (tools) {
    tools.innerHTML = '';
    const labels = Array.isArray(harness.tools) && harness.tools.length ? harness.tools : ['Pi default tools + active extension tools'];
    for (const item of labels) {
      const chip = document.createElement('span');
      chip.className = `harness-tool-chip ${Array.isArray(harness.tools) ? 'emphasis' : ''}`;
      chip.textContent = item;
      tools.append(chip);
    }
  }
}

function syncSessionModelOptions() {
  const source = $('#topModel');
  const target = $('#sessionLaunchModel');
  if (!source || !target) return;
  target.innerHTML = source.innerHTML;
  const desired = getSelectedModelId();
  if (desired && [...target.options].some((item) => item.value === desired)) target.value = desired;
  else target.value = source.value;
  const custom = target.value === '__custom__';
  $('#sessionLaunchCustomModel')?.classList.toggle('hidden', !custom);
  if (custom) $('#sessionLaunchCustomModel').value = String($('#customModelInput')?.value || '').trim();
  renderSessionModelState();
}

function openSessionLauncher({ title = 'New Pi Session', sessionName = '' } = {}) {
  if (!app.workspace) return toast('Open a workspace first', 'error');
  const modal = $('#sessionLauncherModal');
  if (!modal) return startPi(null, sessionName, { harnessId: selectedHarnessId() });
  $('#sessionLauncherTitle').textContent = title;
  $('#sessionLaunchWorkspace').textContent = app.workspace;
  $('#sessionLaunchWorkspace').title = app.workspace;
  const runtime = app.ollama?.runtime || {};
  $('#sessionLaunchRuntime').textContent = `${runtime.name || app.config?.ollamaRuntimeName || 'Ollama'} · ${runtime.baseUrl || app.config?.ollamaBaseUrl || '—'}`;
  $('#sessionLaunchRuntime').title = runtime.baseUrl || app.config?.ollamaBaseUrl || '';
  syncSessionModelOptions();
  refreshHarnessSelectors();
  if ($('#sessionLaunchHarness')) $('#sessionLaunchHarness').value = selectedHarnessId();
  if ($('#sessionLaunchThinking')) $('#sessionLaunchThinking').value = $('#thinkingLevel')?.value || 'off';
  if ($('#sessionLaunchName')) $('#sessionLaunchName').value = sessionName || '';
  renderSessionHarnessDetails();
  renderSessionModelState();
  if ($('#sessionLaunchBehavior')) {
    $('#sessionLaunchBehavior').textContent = app.pi.status?.running
      ? 'If model + harness match the active Pi process, Studio reuses it and creates a fresh session. Changing the harness restarts Pi because tool allowlists are part of the process launch contract.'
      : 'Studio starts Pi in this workspace with the selected model and harness. The currently loaded GPU model is only a performance hint, never an implicit selection.';
  }
  modal.classList.remove('hidden');
  setTimeout(() => $('#sessionLaunchName')?.focus?.(), 0);
}

function closeSessionLauncher() { $('#sessionLauncherModal')?.classList.add('hidden'); }

async function commitSessionLaunchChoices({ modelId, harnessId, thinking }) {
  if ($('#topHarness')) $('#topHarness').value = harnessId;
  localStorage.setItem('studio_selected_harness', harnessId);
  if ($('#thinkingLevel')) $('#thinkingLevel').value = thinking;
  try { localStorage.setItem('studio_thinking_level', thinking); } catch {}
  if ($('#topModel')) {
    if ([...$('#topModel').options].some((item) => item.value === modelId)) {
      $('#topModel').value = modelId;
      $('#customModelInput')?.classList.add('hidden');
    } else {
      $('#topModel').value = '__custom__';
      $('#customModelInput').value = modelId;
      $('#customModelInput').classList.remove('hidden');
    }
  }
  localStorage.setItem('studio_selected_model', modelId);
  await persistDefaultModelSelection(modelId).catch((error) => {
    log('MODEL DEFAULT', error.message);
    toast('Session started, but the model could not be saved as the next startup default.', 'warning');
  });
  refreshHarnessSelectors();
}

async function applySessionLauncherSelection() {
  const modelId = selectedSessionModelId();
  const harnessId = String($('#sessionLaunchHarness')?.value || selectedHarnessId()).trim();
  const thinking = String($('#sessionLaunchThinking')?.value || $('#thinkingLevel')?.value || 'off').trim();
  const sessionName = String($('#sessionLaunchName')?.value || '').trim();
  if (!modelId) return toast('Select a model for the new session', 'error');
  const harness = harnessById(harnessId);
  if (!harness) return toast('Select a valid harness', 'error');

  const activeHarnessId = String(app.pi.status?.harnessId || 'coding-default');
  const activeModelId = String(app.pi.status?.modelId || app.pi.state?.model?.id || '').trim();
  const sameHarness = app.pi.status?.running && activeHarnessId === harnessId;
  const sameModel = app.pi.status?.running && modelIdAliases(activeModelId).has([...modelIdAliases(modelId)][0]);

  const confirm = $('#confirmSessionLauncher');
  setBusy(confirm, true, 'Starting…');
  try {
    if (app.pi.status?.running && sameHarness) {
      if (!sameModel) {
        const switched = await switchModel(modelId);
        if (!switched) return;
      }
      await rpc({ type: 'new_session' });
      if (sessionName) await rpc({ type: 'set_session_name', name: sessionName });
      if ($('#thinkingLevel')?.value !== thinking) $('#thinkingLevel').value = thinking;
      await rpc({ type: 'set_thinking_level', level: thinking }).catch(() => {});
      await refreshSnapshot(); await refreshThinkingLevels(); await refreshMessages(); await loadSessions();
      await commitSessionLaunchChoices({ modelId, harnessId, thinking });
      closeSessionLauncher();
      renderHarnessStatus(); renderActiveModel();
      toast(`New session · ${harness.name}`, 'success');
      return;
    }

    // A different harness requires a new Pi process because --tools and system
    // guidance are process startup configuration in the current RPC host.
    if (app.pi.status?.running) await stopPi({ quiet: true });
    const started = await startPi(null, sessionName, { harnessId, modelId, thinkingLevel: thinking });
    if (!started) return;
    await commitSessionLaunchChoices({ modelId, harnessId, thinking });
    closeSessionLauncher();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(confirm, false);
  }
}

// ── Model Selector ─────────────────────────────────────────────────────────────
function getSelectedModelId() {
  const val = String($('#topModel').value || '').trim();
  if (val === '__custom__') return $('#customModelInput').value.trim();
  return val;
}

// refreshModelSelectors: re-populates both the main model dropdown and the profile
// base-model dropdown from the current Ollama model list. Preserves the selection
// when the list changes (e.g. after a pull or profile create).
function modelIdAliases(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return new Set();
  const aliases = new Set([raw]);
  if (raw.endsWith(':latest')) aliases.add(raw.slice(0, -7));
  else aliases.add(`${raw}:latest`);
  return aliases;
}

function activeOllamaHasModel(modelId) {
  if (app.ollama?.modelsAvailable !== true) return true;
  const wanted = modelIdAliases(modelId);
  return (app.ollama.models || []).some((model) => {
    const aliases = modelIdAliases(model?.model || model?.name);
    for (const alias of wanted) if (aliases.has(alias)) return true;
    return false;
  });
}

function profileRuntimeState(profile) {
  const current = String(app.ollama?.runtime?.baseUrl || app.config?.ollamaBaseUrl || '').replace(/\/+$/, '');
  const currentId = String(app.ollama?.runtime?.id || '');
  const bound = String(profile?.runtime?.baseUrl || profile?.runtimeBaseUrl || '').replace(/\/+$/, '');
  const boundId = String(profile?.runtime?.id || profile?.runtimeId || '');
  const portable = !bound && !boundId;
  const runtimeCompatible = portable || Boolean((bound && bound === current) || (boundId && currentId && boundId === currentId));
  if (!runtimeCompatible) return { compatible: false, portable, reason: 'runtime' };
  if (!activeOllamaHasModel(profile?.id || profile?.name)) return { compatible: false, portable, reason: 'missing-model' };
  return { compatible: true, portable, reason: '' };
}

function refreshModelSelectors() {
  const models = app.ollama.models || [];
  const profiles = app.profiles || [];
  // A saved profile is global metadata, but it is only a usable model on the
  // active Ollama runtime when its bound runtime and base model are present
  // there. Keep the selector scoped to the active endpoint; unavailable
  // profiles remain inspectable through the profile/resource surfaces instead
  // of making a LAN runtime look like it contains local models.
  const compatibleProfiles = profiles.filter((profile) => profileRuntimeState(profile).compatible);
  const savedModel = localStorage.getItem('studio_selected_model') || '';
  for (const select of [$('#topModel'), $('#profileBaseModel')]) {
    const current = select.value || savedModel; select.innerHTML = '';
    option(select, '', (models.length || compatibleProfiles.length) ? 'Select model…' : 'No models on active Ollama');
    if (compatibleProfiles.length) {
      const group = document.createElement('optgroup');
      group.label = `Studio Profiles · ${app.ollama?.runtime?.name || 'active Ollama'}`;
      for (const p of compatibleProfiles) {
        const val = p.id || p.name;
        const opt = document.createElement('option');
        opt.value = val;
        const runtimeState = profileRuntimeState(p);
        opt.textContent = `⭐ ${p.name || p.id} (${p.baseModel || ''})${runtimeState.portable ? ' · portable' : ''}`;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
    if (models.length) {
      const group = document.createElement('optgroup');
      group.label = `Ollama Models · ${app.ollama?.runtime?.name || 'active runtime'}`;
      for (const model of models) {
        const val = model.model || model.name;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
    if (select.id === 'topModel') {
      const providerEntries = providerModelEntries(app.providers || []);
      if (providerEntries.length) {
        const groups = new Map();
        for (const entry of providerEntries) {
          if (!groups.has(entry.providerId)) { const group = document.createElement('optgroup'); group.label = entry.providerName; groups.set(entry.providerId, group); select.appendChild(group); }
          const opt = document.createElement('option'); opt.value = entry.value; opt.textContent = `${entry.model.name || entry.model.id}`; groups.get(entry.providerId).appendChild(opt);
        }
      }
      option(select, '__custom__', 'Custom / Type model name…');
    }
    if (current && [...select.options].some((item) => item.value === current && !item.disabled)) select.value = current;
  }
  const topModel = $('#topModel');
  const stateModel = (app.pi.state?.model?.provider && app.pi.state?.model?.provider !== 'ollama' ? `${app.pi.state.model.provider}/${app.pi.state.model.id}` : app.pi.state?.model?.id) || '';
  const preferred = [stateModel, app.config.defaultModel, savedModel].map((value) => String(value || '').trim()).filter(Boolean);
  let desired = preferred.find((value) => [...topModel.options].some((item) => item.value === value && !item.disabled)) || '';
  if (!desired) {
    const firstAvailable = [...topModel.options].find((item) => item.value && item.value !== '__custom__' && !item.disabled);
    desired = firstAvailable?.value || '';
  }
  topModel.value = desired;
  if (desired) localStorage.setItem('studio_selected_model', desired);
  else localStorage.removeItem('studio_selected_model');
  if (!$('#profileBaseModel').value && models[0]) $('#profileBaseModel').value = models[0].model || models[0].name;
  renderModelLibrary(); renderActiveModel();
  if ($('#sessionLauncherModal') && !$('#sessionLauncherModal').classList.contains('hidden')) syncSessionModelOptions();
}

async function persistDefaultModelSelection(modelId, { quiet = false } = {}) {
  const selected = String(modelId || '').trim();
  if (String(app.config?.defaultModel || '').trim() === selected) return app.config;
  try {
    const value = await put('/api/config', { defaultModel: selected });
    app.config = value.config;
    return app.config;
  } catch (error) {
    if (!quiet) toast(`Could not persist default model: ${error.message}`, 'error');
    throw error;
  }
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

function renderPiResourceLifecycle() {
  const notice = $('#piRestartNotice');
  const text = $('#piRestartNoticeText');
  const restarting = Boolean(app.pi.resourceRestartInProgress);
  const required = Boolean(restarting || (app.pi.resourceRestartRequired && app.pi.status?.running));
  if (notice) notice.classList.toggle('hidden', !required);
  if (text && required) text.textContent = `${app.pi.resourceRestartReason || 'Pi resources changed'} · restart Pi to load the latest session resources.`;
  const button = $('#restartPiResources');
  if (button) button.disabled = restarting || !required;
}

function markPiResourceChange(reason = 'Pi resources changed') {
  if (!app.pi.status?.running) return false;
  const alreadyRequired = Boolean(app.pi.resourceRestartRequired);
  app.pi.resourceRestartRequired = true;
  app.pi.resourceRestartReason = String(reason || 'Pi resources changed');
  renderPiResourceLifecycle();
  if (!alreadyRequired) toast('Pi is still running with the previous resources. Restart Pi to load this change.', 'warning');
  return true;
}

function applyPiSnapshot(value = {}) {
  const lifecycle = {
    resourceRestartRequired: Boolean(app.pi.resourceRestartRequired),
    resourceRestartReason: String(app.pi.resourceRestartReason || ''),
    resourceRestartInProgress: Boolean(app.pi.resourceRestartInProgress)
  };
  app.pi = { ...(value || {}), ...lifecycle };
  return app.pi;
}

async function restartPiForResources() {
  if (!app.pi.status?.running) return startPi(null, '', { harnessId: selectedHarnessId() });
  const sessionPath = app.pi.state?.sessionFile || null;
  const sessionName = app.pi.state?.sessionName || '';
  // A previous session can be deleted or rolled back while the browser still
  // holds its path in app.pi.state. Restarting with that stale path makes Pi
  // fail before the new resource set can load. Preserve a valid session, but
  // deliberately start a fresh one when the saved session no longer exists.
  let restartSessionPath = sessionPath;
  let restartSessionName = sessionName;
  if (restartSessionPath && app.workspace) {
    try {
      await api(`/api/session/inspect?workspace=${enc(app.workspace)}&path=${enc(restartSessionPath)}`);
    } catch (error) {
      restartSessionPath = null;
      restartSessionName = '';
      log('PI', `Restart session was unavailable; starting a fresh session: ${error.message}`);
    }
  }
  const activeModel = app.pi.state?.model || {};
  const activeProvider = String(activeModel.provider || '').trim();
  const stateModelId = String(activeModel.id || '').trim();
  const modelId = String(app.pi.status?.modelId || (activeProvider && activeProvider !== 'ollama' ? `${activeProvider}/${stateModelId}` : stateModelId) || getSelectedModelId()).trim();
  const harnessId = String(app.pi.status?.harnessId || selectedHarnessId()).trim();
  const thinkingLevel = String(app.pi.state?.thinkingLevel || $('#thinkingLevel')?.value || 'off').trim();
  const button = $('#restartPiResources');
  const resourceReason = app.pi.resourceRestartReason || 'Pi resources changed';
  app.pi.resourceRestartInProgress = true;
  renderPiResourceLifecycle();
  setBusy(button, true, 'Restarting…');
  try {
    await stopPi({ quiet: true, preserveResourceRestartState: true });
    const started = await startPi(restartSessionPath, restartSessionName, { harnessId, modelId, thinkingLevel });
    if (!started || !app.pi.status?.running) throw new Error('Pi did not restart successfully');
    app.pi.resourceRestartRequired = false;
    app.pi.resourceRestartReason = '';
    renderPiResourceLifecycle();
    toast('Pi restarted with the latest resources', 'success');
    return true;
  } catch (error) {
    app.pi.resourceRestartRequired = true;
    app.pi.resourceRestartReason = resourceReason;
    toast(`Could not restart Pi: ${error.message}`, 'error');
    return false;
  } finally {
    app.pi.resourceRestartInProgress = false;
    setBusy(button, false);
    renderPiResourceLifecycle();
  }
}

function ollamaModelKey(value) {
  return String(value || '').trim().toLowerCase().replace(/:latest$/, '');
}

// renderActiveModel: updates the active model card, VRAM stats, GPU badge, and model pill.
// Called whenever the Ollama model list, running list, or GPU status changes.
function renderActiveModel() {
  const id = app.pi.state?.model?.id || getSelectedModelId() || '';
  const models = app.ollama?.models || [];
  const runningList = app.ollama?.running || [];
  // Ollama commonly reports the concrete tag (`foo:latest`) while Studio/Pi
  // may hold the profile alias (`foo`). Treat those as the same model so the
  // header and active-model card reflect the actual loaded GPU state.
  const selectedKey = ollamaModelKey(id);
  const model = models.find((item) => ollamaModelKey(item.model || item.name) === selectedKey);
  const running = runningList.find((item) => ollamaModelKey(item.model || item.name) === selectedKey);
  const gpu = app.system.gpu?.gpus?.[0];

  $('#activeModelCard').innerHTML = id ? `<strong>${escapeHtml(id)}</strong><span>${escapeHtml(model?.details?.parameter_size || 'Model')} · ${escapeHtml(model?.details?.quantization_level || '')}</span>` : '<strong>None</strong><span>Select or type a model</span>';
  $('#modelVram').textContent = running ? formatBytes(running.size_vram) : 'Not loaded';
  if ($('#totalGpuVram')) $('#totalGpuVram').textContent = gpu ? `${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)} GB` : '—';
  $('#runtimeContext').textContent = running?.context_length ? formatNumber(running.context_length) : '—';
  $('#offloadStatus').textContent = running ? (running.size_vram >= running.size * 0.95 ? 'GPU' : 'Partial') : '—';
  if ($('#unloadModel')) {
    $('#unloadModel').disabled = !running;
    $('#unloadModel').title = running ? `Unload ${id} from memory` : `${id || 'Selected model'} is not loaded`;
  }

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
  const host = $('#modelLibrary'); if (!host) return; host.innerHTML = '';
  const models = app.ollama?.models || [];
  const runningList = app.ollama?.running || [];
  for (const model of models) {
    const id = model.model || model.name; const running = runningList.find((item) => ollamaModelKey(item.model || item.name) === ollamaModelKey(id));
    const node = document.createElement('div'); node.className = 'model-item';
    const badges = modelCapabilityBadges(model);
    node.innerHTML = `<strong>${escapeHtml(id)}</strong><small>${escapeHtml(model.details?.parameter_size || '')} ${escapeHtml(model.details?.quantization_level || '')} · ${formatBytes(model.size)}${running ? ` · loaded ${formatBytes(running.size_vram)}` : ''}</small>${badges ? `<div class="model-cap-badges">${badges}</div>` : ''}<div class="model-actions"><button data-use aria-label="Use ${escapeHtml(id)}">Use</button><button data-edit title="Inspect & Edit Profile Parameters" aria-label="Inspect and edit ${escapeHtml(id)} profile parameters">✏️ Edit</button><button data-unload title="${running ? 'Unload' : 'Not loaded'}" aria-label="Unload ${escapeHtml(id)} from memory" ${running ? '' : 'disabled'}>⏏</button><button data-delete title="Delete" aria-label="Delete ${escapeHtml(id)} from the active Ollama server">×</button></div>`;
    $('[data-use]', node).onclick = () => chooseModel(id, { provider: 'ollama' });
    $('[data-edit]', node).onclick = () => loadCurrentModelIntoProfile(id);
    $('[data-unload]', node).onclick = (event) => doUnload(id, event.currentTarget);
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
    ['Git', app.system.git?.installed ? app.system.git.version : 'Not found'],
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
    ollamaBaseUrl: '#ollamaBaseUrl', ollamaApiKeyEnv: '#ollamaApiKeyEnv', ollamaRuntimeKind: '#ollamaRuntimeKind', ollamaRuntimeName: '#ollamaRuntimeName', kvCacheType: '#kvCacheType', defaultContextLength: '#defaultContext', numParallel: '#numParallel',
    maxLoadedModels: '#maxLoadedModels', maxQueue: '#maxQueue', keepAlive: '#keepAlive', piCommand: '#piCommand', ollamaCommand: '#ollamaCommand'
  };
  for (const [key, selector] of Object.entries(fields)) $(selector).value = app.config[key] ?? '';
  $('#flashAttention').checked = Boolean(app.config.flashAttention); $('#noCloud').checked = Boolean(app.config.noCloud); $('#managedOllama').checked = Boolean(app.config.managedOllama); $('#trustProjects').checked = Boolean(app.config.trustProjects);
  renderOllamaRuntimeStatus(app.ollama);
  if ($('#defaultAgentsMd')) $('#defaultAgentsMd').value = app.config.defaultAgentsMd ?? '';
  if (!app.workspace && app.config.defaultWorkspace) { app.workspace = app.config.defaultWorkspace; $('#workspacePath').value = app.workspace; }
  renderCurrentProject();
}

function renderAgentActionState() {
  const running = Boolean(app.pi.status?.running);
  const busy = Boolean(app.agentBusy || app.sendingPrompt);
  if ($('#sendPrompt')) $('#sendPrompt').disabled = busy;
  if ($('#sendSteer')) $('#sendSteer').disabled = !running || !app.agentBusy;
  if ($('#sendFollowUp')) $('#sendFollowUp').disabled = !running || !app.agentBusy;
  if ($('#abortAgent')) $('#abortAgent').disabled = !running || !app.agentBusy;
  if ($('#compactNow')) $('#compactNow').disabled = !running || busy;
  for (const selector of ['#setSessionName', '#steeringMode', '#followUpMode', '#autoCompaction', '#autoRetry', '#loadCommands', '#sendRawRpc']) {
    if ($(selector)) $(selector).disabled = !running;
  }
  if ($('#compactWithInstructions')) $('#compactWithInstructions').disabled = !running || busy;
  if ($('#runBash')) $('#runBash').disabled = !running || busy;
}

function renderPiSnapshot() {
  const { status = {}, state, stats } = app.pi;
  if (!status.running) app.agentBusy = false;
  else if (typeof state?.isStreaming === 'boolean' || typeof state?.isCompacting === 'boolean') app.agentBusy = Boolean(state?.isStreaming || state?.isCompacting);
  $('#startPi').disabled = Boolean(status.running); $('#stopPi').disabled = !status.running;
  if ($('#restartPi')) $('#restartPi').disabled = !status.running;
  if ($('#runWebConsole')) $('#runWebConsole').disabled = !status.running;
  if ($('#webConsoleInput')) $('#webConsoleInput').disabled = !status.running;
  $('#agentStatus').textContent = state?.isStreaming ? 'Working' : state?.isCompacting ? 'Compacting' : status.running ? 'Ready' : 'Stopped';
  renderAgentActionState();
  $('#sessionName').textContent = state?.sessionName || state?.sessionId || 'No session';
  $('#tokenStatus').textContent = `${formatNumber(stats?.tokens?.total)} tokens`;
  const context = stats?.contextUsage;
  const contextPercent = Number.isFinite(Number(context?.percent)) ? Math.round(Number(context.percent) * 10) / 10 : null;
  $('#contextStatus').textContent = context ? `Context ${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow)} (${contextPercent ?? '—'}%)` : 'Context —';
  renderHarnessStatus();

  // ── Topbar Active Context Token Gauge ──────────────────────────────────
  if ($('#contextGaugeBadge')) {
    if (context?.tokens && context?.contextWindow) {
      const pct = contextPercent ?? Math.round((context.tokens / context.contextWindow) * 1000) / 10;
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

  $('#toolStatus').textContent = `${formatNumber(stats?.toolCalls)} tool calls`;
  refreshThinkingLevels();
  $('#steeringMode').value = state?.steeringMode || 'one-at-a-time'; $('#followUpMode').value = state?.followUpMode || 'one-at-a-time';
  $('#autoCompaction').checked = state?.autoCompactionEnabled !== false;
  $('#autoRetry').checked = state?.autoRetryEnabled !== false;
  if (state?.model?.id && [...$('#topModel').options].some((item) => item.value === state.model.id)) $('#topModel').value = state.model.id;
  renderHealth(); renderActiveModel(); renderPiResourceLifecycle();
}


async function refreshThinkingLevels() {
  const select = $('#thinkingLevel');
  const defaultLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let saved = '';
  try { saved = localStorage.getItem('studio_thinking_level') || ''; } catch {}
  const current = app.pi.state?.thinkingLevel || (!app.pi.status?.running ? saved : '') || select.value || 'off';

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
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      result.thinking = thinkMatch[1].trim();
      result.text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    } else {
      result.text = content;
    }
  } else {
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text') {
        const textStr = block.text || '';
        const thinkMatch = textStr.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
          result.thinking += (result.thinking ? '\n' : '') + thinkMatch[1].trim();
          result.text += textStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        } else {
          result.text += textStr;
        }
      }
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
    const speakBtn = document.createElement('button');
    speakBtn.className = 'msg-copy-btn sm-btn ghost'; speakBtn.type = 'button'; speakBtn.textContent = '🔊 Speak'; speakBtn.title = 'Generate Qwen3-TTS audio for this answer';
    speakBtn.onclick = () => { const value = $('.message-text', node)?.textContent || ''; $('#ttsText').value = value; generateTtsAudio(value); };
    $('.message-role', node)?.append(speakBtn);
  }

  // ── Fork from chat (user messages only) ──────────────────────────────────
  if (role === 'user' && !isErr) {
    node.dataset.forkable = 'true';
    if (entryId) {
      node.dataset.forkEntry = entryId;
      node.dataset.id = entryId;
    }
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

function attachToolAudio(card, value) {
  const audioUrl = String(value?.details?.audioUrl || value?.audioUrl || '').trim();
  if (!card || !/^\/api\/tts\/audio\/[0-9a-f-]{36}$/i.test(audioUrl)) return false;
  card.querySelector('.tool-audio')?.remove();
  const audio = document.createElement('audio');
  audio.className = 'tool-audio'; audio.controls = true; audio.src = audioUrl;
  card.append(audio);
  audio.play().catch(() => {});
  return true;
}

function ensureStreamingAssistant() {
  if (app.streamMessage?.isConnected) return app.streamMessage;
  app.streamMessage = createMessage('assistant', ''); $('.message-text', app.streamMessage).innerHTML = ''; return app.streamMessage;
}

function handlePiEvent(event) {
  $('#lastEvent').textContent = JSON.stringify(event, null, 2); if (app.protocolEvents) log('PI EVENT', event);
  switch (event.type) {
    case 'agent_start': app.agentBusy = true; $('#agentStatus').textContent = 'Working'; renderAgentActionState(); break;
    case 'agent_settled': {
      app.agentBusy = false;
      $('#agentStatus').textContent = 'Ready';
      renderAgentActionState();
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
      setTimeout(associatePendingCheckpoint, 120);
      setTimeout(() => refreshOpenFilesFromDisk({ reason: 'agent-settled' }).catch(() => {}), 160);
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

      // Pi RPC reports this event after execution starts. This is an honest
      // notification only; it must never imply host-enforced approval.
      if ($('#confirmTools')?.checked && ['bash', 'write', 'edit', 'delete'].includes(String(event.toolName).toLowerCase())) {
        toast(`Risky tool started: ${event.toolName}. Use Abort to stop the active turn.`, 'warning');
      }
      break;
    }
    case 'tool_execution_update': {
      const card = app.toolCards.get(event.toolCallId);
      if (card) $('.tool-body', card).textContent = toolResultText(event.partialResult || event.delta || event);
      break;
    }
    case 'tool_execution_end': {
      const card = app.toolCards.get(event.toolCallId);
      const failed = Boolean(event.isError || event.result?.isError);
      const resultText = toolResultText(event.result || event);
      if (card) { $('.status', card).className = `status ${failed ? 'error' : 'done'}`; $('.status', card).textContent = failed ? 'error' : 'done'; $('.tool-body', card).textContent = resultText; }
      if (!failed) attachToolAudio(card, event.result || event);
      const diagnosticSource = `Tool:${event.toolName || 'tool'}`;
      const parsed = parseTextDiagnostics(resultText, { source: diagnosticSource });
      if (parsed.length) setProblemsForSource(diagnosticSource, parsed);
      else if (failed) addProblem({ title: `${event.toolName || 'Tool'} failed`, detail: resultText, source: diagnosticSource, toolCallId: event.toolCallId });
      break;
    }
    case 'bash_execution_update':
      if (event.id === app.currentBashId) $('#bashOutput').textContent += event.delta || '';
      else if (app.protocolEvents) log('BASH UPDATE', event);
      break;
    case 'queue_update': renderQueue(event); break;
    case 'compaction_start': app.agentBusy = true; $('#agentStatus').textContent = `Compacting (${event.reason || 'manual'})`; renderAgentActionState(); break;
    case 'compaction_end':
      app.agentBusy = false; renderAgentActionState();
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
  const context = captureWorkspaceContext();
  try {
    const [msgRes, entriesRes] = await Promise.allSettled([
      rpc({ type: 'get_messages' }, { quiet: true }),
      rpc({ type: 'get_entries' }, { quiet: true })
    ]);
    if (!workspaceContextIsCurrent(context)) return;
    const messages = msgRes.status === 'fulfilled' ? (msgRes.value?.data?.messages || []) : [];
    const entries = entriesRes.status === 'fulfilled' ? (Array.isArray(entriesRes.value?.data) ? entriesRes.value.data : (entriesRes.value?.data?.entries || [])) : [];
    if (entries.length && messages.length) {
      const userEntries = entries.filter((e) => e && (e.id || e.nodeId) && (e.message?.role === 'user' || e.role === 'user'));
      let userIdx = 0;
      for (const msg of messages) {
        if ((msg.role || msg.type) === 'user') {
          if (userEntries[userIdx]) {
            const eid = userEntries[userIdx].id || userEntries[userIdx].nodeId;
            msg.id = eid;
            msg.entryId = eid;
            userIdx++;
          }
        }
      }
    }
    renderMessages(messages);
  } catch { /* process may be stopping */ }
}
async function refreshSnapshot() {
  const context = captureWorkspaceContext();
  try {
    const value = await api('/api/pi/snapshot');
    if (!workspaceContextIsCurrent(context) || !piPayloadBelongsToWorkspace(value.status, context.workspace)) return;
    app.pi = { ...app.pi, status: value.status, state: value.state, stats: value.stats }; renderPiSnapshot();
  } catch (e) { if (workspaceContextIsCurrent(context)) toast(e.message, 'error'); }
}

function renderOllamaRuntimeStatus(result = app.ollama) {
  const runtime = result?.runtime || {};
  const node = $('#ollamaRuntimeStatus');
  if (node) {
    const auth = runtime.authenticated ? (runtime.apiKeyAvailable ? ' · auth ✓' : ' · auth key missing') : '';
    const latency = Number.isFinite(result?.latencyMs) ? ` · ${result.latencyMs} ms` : '';
    const version = result?.version ? ` · v${result.version}` : '';
    node.textContent = result?.online ? `Connected${version}${latency}${auth}` : `Offline${auth}`;
    node.classList.toggle('error-text', !result?.online || (runtime.authenticated && !runtime.apiKeyAvailable));
  }
  const local = runtime.local ?? ['local'].includes(String(app.config?.ollamaRuntimeKind || 'local'));
  const owned = Boolean(app.managedOllama?.running);
  const start = $('#startManaged');
  const restart = $('#restartManaged');
  const stop = $('#stopManaged');
  if (start) {
    start.disabled = !local || owned || Boolean(result?.online);
    start.title = !local
      ? 'Managed Ollama is available only for localhost endpoints.'
      : owned
        ? 'Studio already owns this Ollama process.'
        : result?.online
          ? 'A local Ollama server is online but is owned outside Studio.'
          : 'Start Ollama as a Studio-owned process.';
  }
  for (const button of [restart, stop]) {
    if (!button) continue;
    button.disabled = !local || !owned;
    button.title = !local
      ? 'Managed Ollama is available only for localhost endpoints.'
      : owned
        ? ''
        : 'Studio can restart or stop only an Ollama process that it started.';
  }
  const managed = $('#managedOllama');
  if (managed) { managed.disabled = !local; if (!local) managed.checked = false; }
}

async function refreshOllama() {
  const value = await api('/api/ollama/status');
  app.ollama = value.ollama || value;
  app.managedOllama = value.managedOllama || app.managedOllama;
  app.profiles = value.profiles || [];
  refreshModelSelectors(); renderHealth(); renderOllamaRuntimeStatus(); renderOllamaInventorySummary();
}

function renderOllamaInventorySummary(result = app.ollama, selector = '#activeOllamaInventory') {
  const node = $(selector); if (!node) return;
  const runtime = result?.runtime || {};
  const installed = Array.isArray(result?.models) ? result.models.map((item) => item.model || item.name).filter(Boolean) : [];
  const loaded = Array.isArray(result?.running) ? result.running.map((item) => item.model || item.name).filter(Boolean) : [];
  const runtimeLabel = runtime.name || runtime.baseUrl || 'Ollama';
  node.innerHTML = `<strong>${escapeHtml(runtimeLabel)}</strong>${runtime.baseUrl ? ` · ${escapeHtml(runtime.baseUrl)}` : ''}<br>Installed: ${installed.length ? installed.map(escapeHtml).join(', ') : 'none'}<br>Loaded now: ${loaded.length ? loaded.map(escapeHtml).join(', ') : 'none'}`;
  if (selector === '#activeOllamaInventory') {
    const target = $('#pullModelTarget');
    if (target) {
      target.textContent = runtime.baseUrl
        ? `Downloads to active runtime: ${runtimeLabel} · ${runtime.baseUrl}`
        : 'Connect an active Ollama runtime before downloading a model.';
      target.classList.toggle('error-text', result?.online === false);
    }
    updatePullModelAction(result);
  }
}

function updatePullModelAction(result = app.ollama) {
  const pullButton = $('#pullModel');
  if (pullButton) pullButton.disabled = result?.online !== true || !String($('#pullModelName')?.value || '').trim();
}

function renderTestedOllama(result = app.testedOllama) {
  const button = $('#useTestedOllama');
  const alreadyActive = testedRuntimeIsActive(result);
  if (button) {
    button.disabled = !result?.online || alreadyActive;
    button.textContent = alreadyActive ? 'Already active' : 'Use this server';
  }
  const node = $('#testedOllamaInventory');
  if (!node) return;
  if (!result) { node.textContent = 'Test a server to inspect its installed and currently loaded models before switching.'; return; }
  const version = result.version ? `v${result.version}` : 'version unknown';
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
  const stateText = alreadyActive
    ? 'This is the active Studio runtime. Its installed and loaded models are shown below.'
    : 'This is only a connection test. Click Use this server to switch Studio.';
  node.innerHTML = `<div class="tested-runtime-heading"><strong>Tested server · ${escapeHtml(version)}${escapeHtml(latency)}</strong><span>${stateText}</span></div>`;
  const inventory = document.createElement('div'); inventory.id = 'testedOllamaInventoryBody'; node.append(inventory);
  renderOllamaInventorySummary(result, '#testedOllamaInventoryBody');
}

function normalizedRuntimeUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }

function currentRuntimeTestFingerprint() {
  return JSON.stringify({
    baseUrl: normalizedRuntimeUrl($('#ollamaBaseUrl')?.value),
    apiKeyEnv: String($('#ollamaApiKeyEnv')?.value || '').trim(),
    kind: String($('#ollamaRuntimeKind')?.value || 'local').trim().toLowerCase()
  });
}

function testedRuntimeFingerprint(tested = app.testedOllama) {
  return JSON.stringify({
    baseUrl: normalizedRuntimeUrl(tested?.runtime?.baseUrl),
    apiKeyEnv: String(tested?.runtime?.apiKeyEnv || '').trim(),
    kind: String(tested?.runtime?.kind || 'local').trim().toLowerCase()
  });
}

function activeRuntimeFingerprint(runtime = app.ollama?.runtime) {
  return JSON.stringify({
    baseUrl: normalizedRuntimeUrl(runtime?.baseUrl),
    apiKeyEnv: String(runtime?.apiKeyEnv || '').trim(),
    kind: String(runtime?.kind || 'local').trim().toLowerCase()
  });
}

function testedRuntimeIsActive(tested = app.testedOllama) {
  return Boolean(tested?.online && testedRuntimeFingerprint(tested) === activeRuntimeFingerprint());
}

async function useTestedOllamaRuntime() {
  const tested = app.testedOllama;
  if (!tested?.online) return toast('Test the Ollama server first', 'error');
  if (currentRuntimeTestFingerprint() !== testedRuntimeFingerprint(tested)) {
    app.testedOllama = null; renderTestedOllama(null);
    return toast('Ollama connection fields changed after the test. Test the server again before switching.', 'error');
  }
  await saveRuntime({ requireTestedRuntime: true });
}

async function testOllamaConnection() {
  const button = $('#testOllamaConnection');
  const payload = {
    ollamaBaseUrl: $('#ollamaBaseUrl')?.value?.trim(),
    ollamaApiKeyEnv: $('#ollamaApiKeyEnv')?.value?.trim(),
    ollamaRuntimeKind: $('#ollamaRuntimeKind')?.value,
    ollamaRuntimeName: $('#ollamaRuntimeName')?.value?.trim()
  };
  setBusy(button, true, 'Testing…');
  // Clear the previous probe while the new endpoint is in flight. Keeping it
  // visible makes a stale failure/result look like it belongs to the current
  // connection fields.
  app.testedOllama = null;
  renderTestedOllama(null);
  try {
    const value = await post('/api/ollama/test', payload);
    app.testedOllama = value.result;
    // Testing another endpoint must never make the active-runtime indicator or model inventory look switched.
    renderOllamaRuntimeStatus(app.ollama); renderTestedOllama(value.result);
    const suffix = testedRuntimeIsActive(value.result) ? ' This server is already active.' : ' Click Use this server to switch.';
    toast(`Ollama test succeeded${value.result?.version ? ` · v${value.result.version}` : ''}${Number.isFinite(value.result?.latencyMs) ? ` · ${value.result.latencyMs} ms` : ''}.${suffix}`, 'success');
  } catch (error) {
    app.testedOllama = null;
    renderOllamaRuntimeStatus(app.ollama);
    const node = $('#testedOllamaInventory');
    if (node) node.innerHTML = `<div class="error-text"><strong>Test failed:</strong> ${escapeHtml(error.message)}<br><span class="muted">Active Ollama runtime was not changed.</span></div>`;
    const useButton = $('#useTestedOllama'); if (useButton) useButton.disabled = true;
    toast(error.message, 'error');
  } finally { setBusy(button, false); }
}

async function loadSessions() {
  if (!app.workspace) return;
  const context = captureWorkspaceContext();
  try {
    const value = await api(`/api/sessions?workspace=${enc(context.workspace)}`);
    if (!workspaceContextIsCurrent(context)) return;
    app.sessions = value.sessions; renderSessions();
  } catch (e) { if (workspaceContextIsCurrent(context)) $('#sessionList').textContent = e.message; }
}
function renderSessions() {
  const host = $('#sessionList');
  if (!host) return;
  host.innerHTML = '';
  for (const session of app.sessions) {
    const card = document.createElement('div');
    const displayName = session.name || session.id || session.fileName;
    card.className = `session-card ${app.pi.state?.sessionFile === session.path ? 'active' : ''}`;
    card.title = session.path;
    card.innerHTML = `
      <div class="session-name">${escapeHtml(displayName)}</div>
      <div class="session-meta muted">${escapeHtml(formatTime(session.modifiedAt))} · ${formatBytes(session.size)}</div>
      <div class="session-actions">
        <button class="sm-btn ghost fork-btn" type="button" title="Fork from a selected node">Fork</button>
        <button class="sm-btn ghost clone-btn" type="button" title="Clone the full session">Clone</button>
      </div>
    `;
    card.querySelector('.fork-btn').onclick = async (event) => {
      event.stopPropagation();
      await inspectSessionTree(session.path);
      toast('Choose the user prompt where the new branch should begin, then select Fork Branch.', 'success');
    };
    card.querySelector('.clone-btn').onclick = (event) => {
      event.stopPropagation();
      promptCloneSession(session.path);
    };
    card.onclick = () => {
      if (app.pi.status?.running) startPi(session.path, session.name);
      else inspectSessionTree(session.path);
    };
    host.append(card);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No saved sessions</div>';
}

async function leaveWorkspaceContext(previousWorkspace) {
  if (!previousWorkspace) return;
  persistWorkbenchState();
  if (app.pi.status?.running) await post('/api/pi/stop', { workspace: previousWorkspace }).catch(() => null);
  app.pi = { status: {}, state: null, stats: null, resourceRestartRequired: false, resourceRestartReason: '' };
  app.streamMessage = null; app.sendingPrompt = false; app.agentBusy = false; app.toolCards.clear(); app.currentBashId = null;
  app.currentExtensionRequest = null; app.extensionRequestQueue = [];
  app.extensionWidgets.clear(); app.extensionStatuses.clear();
  if (app.currentExtensionTimer) { clearTimeout(app.currentExtensionTimer); app.currentExtensionTimer = null; }
  $('#modal')?.classList.add('hidden');
  closeSessionOperationDialog();
  await post('/api/preview/stop', { workspace: previousWorkspace }).catch(() => null);
  const oldTerminalSnapshot = await api(`/api/terminal/sessions?workspace=${enc(previousWorkspace)}`).catch(() => ({ sessions: app.terminals.sessions || [] }));
  const oldTerminalIds = (oldTerminalSnapshot.sessions || []).filter((session) => !['rpc'].includes(session.backend || session.type)).map((session) => session.id);
  await Promise.all(oldTerminalIds.map((id) => post('/api/terminal/kill', { id }).catch(() => null)));
  for (const id of oldTerminalIds) disposeTerminalInstance(id);
  await post('/api/lsp/stop', { workspace: previousWorkspace }).catch(() => null);
  for (const buffer of app.workbench.buffers) app.monaco?.disposeModel?.(buffer.path);
  app.workbench = new BufferManager(); app.editorViewStates = {}; app.currentFile = null; app.editorOriginal = '';
  app.sessions = []; app.attachments = []; app.workspaceFiles = []; app.checkpoints = {}; app.pendingCheckpoint = null;
  app.currentInspectedSession = null; app.currentTreeSessionPath = null; sessionTreeData = [];
  app.workspaceSearch = { query: '', matches: [], truncated: false };
  app.tests = { discovery: null, runConfigurations: [], lastResult: null, lastTarget: null, statusByPath: new Map() };
  app.problems = []; app.currentProblemIndex = -1; app.lspStatuses = [];
  app.resources.commands = []; app.resources.filter = 'all'; app.resources.query = '';
  app.platform.snapshot = null; app.platform.tab = 'overview'; app.platform.selected = null; app.platform.dirty = false;
  app.gitDiffPatch = ''; app.gitDiffModel = null; app.git = null;
  gitPanel.files = []; gitPanel.selectedFile = null; gitPanel.selectedStaged = false;
  app.terminals.sessions = []; app.terminals.activePrimary = null; app.terminals.activeSecondary = null;
  renderMessages([]); renderQueue({ steering: [], followUp: [] }); renderAttachments(); renderWorkbench(); renderPiSnapshot(); renderTestsUi(); renderProblems(); renderLspStatus([]); renderPiResources(); renderTerminalTabs(); renderTerminalWorkspace();
  if ($('#bashOutput')) $('#bashOutput').textContent = '';
  if ($('#workspaceSearchResults')) { $('#workspaceSearchResults').innerHTML = ''; $('#workspaceSearchResults').classList.add('hidden'); }
  if ($('#gitDiffContent')) $('#gitDiffContent').textContent = 'Select a changed file to inspect its diff.';
  await previewPanel?.toggleEditorSplit?.(false).catch(() => {});
}

async function switchWorkspace(workspace) {
  const requestedWorkspace = String(workspace || '').trim();
  if (!requestedWorkspace) throw new Error('Enter an absolute workspace path');
  const treeProbe = await api(`/api/workspace/tree?workspace=${enc(requestedWorkspace)}&depth=0`);
  const nextWorkspace = String(treeProbe?.tree?.workspace || requestedWorkspace).trim();
  const previousWorkspace = app.workspace;
  const changingWorkspace = Boolean(previousWorkspace && previousWorkspace !== nextWorkspace);
  const dirtyEditor = app.workbench.buffers.some((buffer) => buffer.dirty);
  const dirtyPlatform = Boolean(piPlatformPanel?.hasUnsavedChanges?.());
  if (changingWorkspace && (dirtyEditor || dirtyPlatform) && typeof window.confirm === 'function') {
    const pending = [dirtyEditor ? 'editor buffers' : '', dirtyPlatform ? 'Pi resource edits' : ''].filter(Boolean).join(' and ');
    if (!window.confirm(`Switch workspace and discard unsaved ${pending}?`)) return { cancelled: true };
    piPlatformPanel?.discardChanges?.();
  }

  let gitProbe = (await api(`/api/workspace/git?workspace=${enc(nextWorkspace)}`)).git;
  if (!gitProbe.isRepository) {
    const decision = await promptGitOnboarding(nextWorkspace, gitProbe);
    if (decision === 'cancel') return { cancelled: true };
    if (decision === 'initialized') gitProbe = (await api(`/api/workspace/git?workspace=${enc(nextWorkspace)}`)).git;
  }

  if (previousWorkspace !== nextWorkspace) app.workspaceEpoch += 1;
  if (changingWorkspace) await leaveWorkspaceContext(previousWorkspace);

  // From this point onward the workspace transition is committed. Secondary
  // subsystem failures must not make the UI pretend it rolled back to A after
  // services and state have already been rebound to B.
  app.workspace = nextWorkspace; app.config.defaultWorkspace = nextWorkspace; app.git = gitProbe; $('#workspacePath').value = nextWorkspace;
  rememberRecentProject(nextWorkspace);
  updateWorkbenchStatus();
  const warnings = [];
  try { await put('/api/config', { defaultWorkspace: nextWorkspace }); }
  catch (error) { warnings.push(`Workspace preference was not persisted: ${error.message}`); }

  const reloads = await Promise.allSettled([
    loadWorkspaceTree(), loadSessions(), loadGit(), loadTerminalSessions({ preserveSelection: false }), loadCheckpoints(), loadHarnesses({ quiet: true })
  ]);
  for (const result of reloads) if (result.status === 'rejected') warnings.push(result.reason?.message || String(result.reason));
  try { await restoreWorkbenchState(nextWorkspace); } catch (error) { warnings.push(error.message); }
  await app.lsp?.refreshStatus?.().catch((error) => { warnings.push(error.message); return []; });
  syncPaneLsp('primary', 'open', true); syncPaneLsp('secondary', 'open', true);
  await loadPiPlatform({ quiet: true }).catch((error) => warnings.push(error.message));
  await previewPanel?.refresh?.().catch((error) => warnings.push(error.message));
  if (warnings.length) toast(`Workspace opened with ${warnings.length} reload warning${warnings.length === 1 ? '' : 's'}.`, 'error');
  return { cancelled: false, git: gitProbe, workspace: nextWorkspace, warnings };
}

async function applyWorkspace() {
  const workspace = $('#workspacePath').value.trim(); const previousWorkspace = app.workspace;
  try {
    const result = await switchWorkspace(workspace);
    if (result.cancelled) { $('#workspacePath').value = previousWorkspace || workspace; return; }
    toast(result.git?.isRepository ? 'Workspace opened' : 'Workspace opened without Git', result.git?.isRepository ? 'success' : '');
  } catch (e) { $('#workspacePath').value = previousWorkspace || workspace; toast(e.message, 'error'); }
}

async function loadWorkspaceTree() {
  if (!app.workspace) return;
  const context = captureWorkspaceContext();
  const value = await api(`/api/workspace/tree?workspace=${enc(context.workspace)}&depth=5`);
  if (!workspaceContextIsCurrent(context)) return;
  app.workspaceFiles = [];
  const collect = (items) => {
    for (const item of items || []) {
      if (item.type === 'file') app.workspaceFiles.push(item.path);
      if (item.children) collect(item.children);
    }
  };
  collect(value.tree.entries);
  renderFileTree(value.tree.entries, $('#fileTree'));
}
function renderFileTree(entries, host) {
  host.innerHTML = '';
  const renderNodes = (items, parent) => {
    for (const item of items || []) {
      const node = document.createElement('div'); node.className = 'tree-node';
      const row = document.createElement('button'); row.type = 'button'; row.className = 'tree-row'; row.dataset.path = item.path || ''; row.dataset.type = item.type || ''; row.setAttribute('aria-label', `${item.type === 'directory' ? 'Toggle folder' : 'Open file'} ${item.name}`); row.innerHTML = `<span class="twisty">${item.type === 'directory' ? '▾' : ''}</span><span>${item.type === 'directory' ? '▰' : '·'}</span><span>${escapeHtml(item.name)}</span>`;
      node.append(row);
      if (item.children) { const children = document.createElement('div'); children.className = 'tree-children'; renderNodes(item.children, children); node.append(children); row.onclick = () => { children.classList.toggle('hidden'); $('.twisty', row).textContent = children.classList.contains('hidden') ? '▸' : '▾'; }; }
      else if (item.type === 'file') row.onclick = () => openFile(item.path);
      parent.append(node);
    }
  };
  renderNodes(entries, host); if (!host.childElementCount) host.innerHTML = '<div class="empty-state">Workspace is empty</div>';
}
async function searchWorkspaceUi(query = $('#workspaceSearchInput')?.value || '') {
  const value = String(query || '').trim();
  const host = $('#workspaceSearchResults');
  if (!host) return;
  if (!app.workspace || !value) {
    host.classList.add('hidden');
    host.innerHTML = '';
    app.workspaceSearch = { query: value, matches: [], truncated: false };
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = '<div class="workspace-search-summary">Searching…</div>';
  const context = captureWorkspaceContext();
  try {
    const response = await api(`/api/workspace/search?workspace=${enc(context.workspace)}&q=${enc(value)}&limit=250`);
    if (!workspaceContextIsCurrent(context)) return;
    const result = response.result || { matches: [] };
    app.workspaceSearch = result;
    renderWorkspaceSearchResults();
  } catch (error) {
    host.innerHTML = `<div class="empty-state error-text">${escapeHtml(error.message)}</div>`;
  }
}

function renderWorkspaceSearchResults() {
  const host = $('#workspaceSearchResults');
  if (!host) return;
  const result = app.workspaceSearch || { matches: [] };
  host.innerHTML = `<div class="workspace-search-summary">${result.matches?.length || 0} matches · ${result.scannedFiles || 0} files${result.truncated ? ' · limited' : ''}</div>`;
  for (const match of result.matches || []) {
    const row = document.createElement('div');
    row.className = 'workspace-search-row';
    row.innerHTML = `<div><strong>${escapeHtml(match.path)}</strong><span>${escapeHtml(match.preview || '')}</span></div><div class="workspace-search-location">${match.line}:${match.column}</div>`;
    row.onclick = () => openFile(match.path, { reveal: { line: match.line, column: match.column } });
    host.append(row);
  }
  if (!(result.matches || []).length) host.insertAdjacentHTML('beforeend', '<div class="empty-state">No text matches.</div>');
}

function renderGitSummary(git = app.git) {
  const host = $('#gitSummary');
  if (!host) return;
  host.innerHTML = '';
  if (!git) {
    host.textContent = 'Git status unavailable';
    return;
  }
  if (git.isRepository) {
    const summary = document.createElement('span');
    summary.textContent = `${git.branch || 'detached'}\n${truncate(git.status || 'Clean', 250)}`;
    host.append(summary);
    return;
  }

  const label = document.createElement('span');
  label.textContent = app.system.git?.installed === false ? 'Git is not installed' : 'Git not initialized';
  const button = document.createElement('button');
  button.className = 'link-btn git-init-inline';
  button.textContent = app.system.git?.installed === false ? 'Setup help' : 'Initialize Git';
  button.onclick = async () => {
    if (app.system.git?.installed === false) {
      toast('Install Git for Windows and restart Pi Studio so Git is available in PATH.', 'error');
      return;
    }
    const result = await promptGitOnboarding(app.workspace, git, { allowCancel: false });
    if (result === 'initialized') {
      await Promise.allSettled([loadGit(), loadGitPanel(), loadCheckpoints()]);
      toast('Git repository is ready', 'success');
    }
  };
  host.append(label, document.createTextNode(' · '), button);
}

async function loadGit() {
  if (!app.workspace) return null;
  const context = captureWorkspaceContext();
  try {
    const value = await api(`/api/workspace/git?workspace=${enc(context.workspace)}`);
    if (!workspaceContextIsCurrent(context)) return null;
    app.git = value.git;
    renderGitSummary(value.git);
    return value.git;
  } catch (e) {
    if (!workspaceContextIsCurrent(context)) return null;
    app.git = { isRepository: false, error: e.message };
    $('#gitSummary').textContent = e.message;
    return app.git;
  }
}

async function initializeGitWorkspace(workspace, { confirmSensitive = false } = {}) {
  const branch = $('#gitInitBranch')?.value?.trim() || 'main';
  const createGitignore = $('#gitInitIgnore')?.checked !== false;
  const createBaseline = $('#gitInitBaseline')?.checked !== false;
  return post('/api/workspace/git/init', {
    workspace,
    initialBranch: branch,
    createGitignore,
    createBaseline,
    confirmSensitive
  });
}

function closeGitOnboarding(result = 'cancel') {
  $('#gitOnboardingModal')?.classList.add('hidden');
  const resolve = app.gitOnboardingResolve;
  app.gitOnboardingResolve = null;
  resolve?.(result);
}

async function handleGitInitialization(workspace) {
  const button = $('#gitInitConfirm');
  setBusy(button, true, 'Initializing…');
  try {
    let result = await initializeGitWorkspace(workspace);
    if (result.requiresSensitiveConfirmation) {
      const preview = (result.sensitiveFiles || []).slice(0, 12).join('\n');
      const more = (result.sensitiveFiles || []).length > 12 ? `\n…and ${(result.sensitiveFiles || []).length - 12} more` : '';
      const approved = typeof window.confirm === 'function'
        ? window.confirm(`Potentially sensitive files are not ignored:\n\n${preview}${more}\n\nInclude them in the baseline commit anyway?`)
        : false;
      if (!approved) {
        $('#gitInitStatus').textContent = 'Git was initialized, but the baseline was not created because potentially sensitive files need review.';
        return;
      }
      result = await initializeGitWorkspace(workspace, { confirmSensitive: true });
    }

    app.git = result.git || (await api(`/api/workspace/git?workspace=${enc(workspace)}`)).git;
    $('#gitInitStatus').textContent = result.baselineCreated
      ? `Ready. Baseline ${String(result.baselineCommit || '').slice(0, 12)} created.`
      : 'Git repository initialized.';
    renderGitSummary(app.git);
    closeGitOnboarding('initialized');
  } catch (error) {
    $('#gitInitStatus').textContent = error.message;
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function promptGitOnboarding(workspace, git = {}, { allowCancel = true } = {}) {
  const modal = $('#gitOnboardingModal');
  if (!modal) return Promise.resolve('without-git');
  if (app.gitOnboardingResolve) closeGitOnboarding('cancel');

  $('#gitInitWorkspace').textContent = workspace;
  $('#gitInitStatus').textContent = app.system.git?.installed === false
    ? 'Git was not found in PATH. You can still open the project, but checkpoints/worktrees will be disabled.'
    : 'Pi Studio uses Git for prompt checkpoints, historical restoration, worktrees, and Create App from Here.';
  $('#gitInitConfirm').disabled = app.system.git?.installed === false;
  $('#gitInitConfirm').textContent = app.system.git?.installed === false ? 'Git not installed' : 'Initialize Git';
  $('#gitInitCancel').classList.toggle('hidden', !allowCancel);
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    app.gitOnboardingResolve = resolve;
    $('#gitInitConfirm').onclick = () => handleGitInitialization(workspace);
    $('#gitInitWithout').onclick = () => closeGitOnboarding('without-git');
    $('#gitInitCancel').onclick = () => closeGitOnboarding('cancel');
  });
}

function paneDom(paneId = app.workbench.activePane) {
  const secondary = paneId === 'secondary';
  return {
    pane: secondary ? $('#editorPaneSecondary') : $('#editorPanePrimary'),
    editor: secondary ? $('#codeEditorSecondary') : $('#codeEditor'),
    monacoHost: secondary ? $('#monacoEditorSecondary') : $('#monacoEditorPrimary'),
    path: secondary ? $('#editorPathSecondary') : $('#editorPath'),
    meta: secondary ? $('#editorMetaSecondary') : $('#editorMeta')
  };
}

function currentEditorValue(paneId = app.workbench.activePane) {
  if (app.monacoAvailable && app.monaco?.ready) {
    const value = app.monaco.getValue(paneId);
    if (value !== null && value !== undefined) return value;
  }
  return paneDom(paneId).editor?.value ?? app.workbench.bufferForPane(paneId)?.content ?? '';
}

function captureEditorViewState(paneId = app.workbench.activePane) {
  if (!app.monacoAvailable || !app.monaco?.ready) return;
  const buffer = app.workbench.bufferForPane(paneId);
  if (!buffer?.path) return;
  const state = app.monaco.saveViewState(paneId);
  if (!state) return;
  app.editorViewStates[buffer.path] ||= {};
  app.editorViewStates[buffer.path][paneId] = state;
}

function schedulePersistWorkbenchState() {
  clearTimeout(app.workbenchPersistTimer);
  app.workbenchPersistTimer = setTimeout(persistWorkbenchState, 120);
}

function persistWorkbenchState() {
  if (!app.workspace) return;
  captureEditorViewState('primary');
  captureEditorViewState('secondary');
  const host = $('#editorWorkbench');
  const splitSize = Number.parseFloat(host?.style?.getPropertyValue('--editor-split-size')) || 50;
  const primary = app.workbench.bufferForPane('primary');
  const secondary = app.workbench.bufferForPane('secondary');
  app.workspaceState.save(app.workspace, {
    openPaths: app.workbench.buffers.map((buffer) => buffer.path),
    activePane: app.workbench.activePane, split: app.workbench.split, splitSize,
    panePaths: { primary: primary?.path || null, secondary: secondary?.path || null },
    activeView: activeViewName(), viewStates: app.editorViewStates
  });
}

async function restoreWorkbenchState(workspace = app.workspace) {
  const saved = app.workspaceState.load(workspace);
  if (!saved) return;
  app.editorViewStates = saved.viewStates || {};
  for (const filePath of saved.openPaths || []) await openFile(filePath, { paneId: 'primary', reload: true, switchToEditor: false }).catch(() => {});
  if (saved.panePaths?.primary) app.workbench.activate(saved.panePaths.primary, { paneId: 'primary' });
  if (saved.split !== 'none' && app.workbench.size) {
    app.workbench.setSplit(saved.split);
    if (saved.panePaths?.secondary) app.workbench.activate(saved.panePaths.secondary, { paneId: 'secondary' });
  } else app.workbench.closeSplit();
  app.workbench.setActivePane(saved.activePane);
  $('#editorWorkbench')?.style?.setProperty('--editor-split-size', `${saved.splitSize || 50}%`);
  renderWorkbench();
  if (saved.activeView && $(`#view-${saved.activeView}`)) switchView(saved.activeView);
}


function renderLspStatus(statuses = app.lspStatuses) {
  app.lspStatuses = statuses || [];
  const host = $('#lspStatus');
  if (!host) return;
  const running = app.lspStatuses.filter((item) => item.running && item.initialized);
  const failed = app.lspStatuses.filter((item) => item.lastError);
  const unavailable = app.lspStatuses.filter((item) => item.disabled || item.unavailableReason);
  const applicable = app.lspStatuses.filter((item) => item.applicable !== false);
  host.classList.toggle('online', running.length > 0);
  host.classList.toggle('error', failed.length > 0 && running.length === 0);
  host.textContent = running.length ? `LSP ${running.length} active` : failed.length ? 'LSP error' : applicable.length ? 'LSP ready' : 'LSP idle';
  host.title = app.lspStatuses.map((item) => `${item.label || item.id}: ${item.running && item.initialized ? 'running' : item.lastError ? item.lastError : item.disabled || item.unavailableReason ? (item.unavailableReason || 'unavailable') : item.applicable === false ? 'not applicable' : 'idle'}`).join('\n');
  const list = $('#lspServerList');
  if (list) {
    list.innerHTML = '';
    for (const item of app.lspStatuses) {
      const row = document.createElement('div');
      row.className = `lsp-server-row ${item.running && item.initialized ? 'running' : ''} ${item.lastError ? 'failed' : ''}`;
      const state = item.running && item.initialized ? '● Running' : item.lastError ? '⚠ Error' : item.disabled || item.unavailableReason ? 'Unavailable' : item.applicable === false ? 'Not applicable' : 'Idle';
      const reason = item.unavailableReason || item.lastError || '';
      row.title = reason;
      row.innerHTML = `<div><strong>${escapeHtml(item.label || item.id)}</strong><span>${escapeHtml((item.languages || []).join(', '))}</span>${reason ? `<small>${escapeHtml(reason)}</small>` : ''}</div><div><span class="lsp-server-state">${escapeHtml(state)}</span>${item.serverInfo?.version ? `<span>${escapeHtml(item.serverInfo.version)}</span>` : ''}</div>`;
      list.append(row);
    }
    if (!app.lspStatuses.length) list.innerHTML = '<div class="empty-state">Open a workspace to inspect language servers.</div>';
  }
}

function lspProblemRecords(payload = {}) {
  return (payload.diagnostics || []).map((item) => ({
    source: item.source || `LSP:${payload.serverId || 'server'}`,
    severity: Number(item.severity) === 1 ? 'error' : Number(item.severity) === 2 ? 'warning' : Number(item.severity) === 3 ? 'info' : 'hint',
    path: payload.path || '', line: Number(item.range?.start?.line || 0) + 1, column: Number(item.range?.start?.character || 0) + 1,
    endLine: Number(item.range?.end?.line || item.range?.start?.line || 0) + 1, endColumn: Number(item.range?.end?.character || item.range?.start?.character || 0) + 1,
    message: item.message || 'Language server diagnostic', code: item.code != null ? String(item.code) : ''
  }));
}

async function ensureLspModel(filePath) {
  if (!filePath || !app.monacoAvailable || !app.monaco?.ready) return null;
  const context = captureWorkspaceContext();
  let buffer = app.workbench.buffer(filePath);
  if (!buffer) {
    const value = await api(`/api/workspace/file?workspace=${enc(context.workspace)}&path=${enc(filePath)}`);
    if (!workspaceContextIsCurrent(context)) return null;
    buffer = app.workbench.open({ ...value.file, dirty: false }, { attach: false, activate: false });
    renderBufferTabs();
  }
  return app.monaco.ensurePathModel(buffer);
}

function syncPaneLsp(paneId = app.workbench.activePane, action = 'open', immediate = false) {
  if (!app.lsp || !app.monacoAvailable) return;
  const buffer = app.workbench.bufferForPane(paneId);
  if (!buffer?.path) return;
  const model = app.monaco.getModelForPath(buffer.path);
  if (model) app.lsp.syncModel(model, action, { immediate }).catch((error) => log('LSP', error.message));
}

async function initializeLspBridge() {
  if (!app.monacoAvailable || !app.monaco?.monaco) return;
  app.lsp?.dispose?.();
  app.lsp = new MonacoLspBridge({
    monaco: app.monaco.monaco,
    request: (path, body) => body === undefined || body === null ? api(path) : post(path, body),
    getWorkspace: () => app.workspace,
    ensureModelForPath: ensureLspModel,
    onDiagnostics: (payload) => setProblemsForSource(`LSP:${payload.serverId || 'server'}:${payload.path || ''}`, lspProblemRecords(payload)),
    onStatus: renderLspStatus,
    onLog: (payload) => log(`LSP ${payload.serverId || ''}`.trim(), payload.text || payload)
  });
  app.lsp.registerProviders();
  await app.lsp.refreshStatus().catch((error) => log('LSP', error.message));
  syncPaneLsp('primary', 'open', true);
  syncPaneLsp('secondary', 'open', true);
}

async function initializeMonacoEditors() {
  app.monaco = new MonacoWorkbenchAdapter({
    getWorkspace: () => app.workspace,
    // Focus/caret changes must never re-render Monaco. A full render restores the
    // last saved view state and can snap a mouse-selected caret back to its old line.
    onFocus: (paneId) => activateWorkbenchPane(paneId),
    onViewStateChanged: () => schedulePersistWorkbenchState(),
    onModelChanged: (paneId, filePath) => { if (app.workbench.buffer(filePath)) { app.workbench.activate(filePath, { paneId }); renderWorkbench(); schedulePersistWorkbenchState(); } },
    onChange: (paneId, content) => {
      app.workbench.setActivePane(paneId);
      app.workbench.updateContent(content, { paneId });
      renderBufferTabs(); syncLegacyEditorState(); updateWorkbenchStatus(); schedulePersistWorkbenchState();
      const buffer = app.workbench.bufferForPane(paneId); const model = buffer?.path ? app.monaco?.getModelForPath?.(buffer.path) : null; if (model) app.lsp?.syncModel(model, 'change').catch(() => {});
    },
    onDiagnostics: (diagnostics) => setProblemsForSource('Monaco', diagnostics)
  });
  try {
    await app.monaco.init({ primary: $('#monacoEditorPrimary'), secondary: $('#monacoEditorSecondary') });
    app.monacoAvailable = true;
    document.documentElement.dataset.monacoState = 'ready';
    for (const paneId of ['primary', 'secondary']) paneDom(paneId).pane?.classList.add('monaco-ready');
    renderWorkbench();
    await initializeLspBridge();
  } catch (error) {
    app.monacoAvailable = false;
    document.documentElement.dataset.monacoState = 'fallback';
    document.documentElement.dataset.monacoError = error.message.slice(0, 240);
    for (const paneId of ['primary', 'secondary']) paneDom(paneId).pane?.classList.add('monaco-failed');
    log('MONACO', `Falling back to textarea editor: ${error.message}`);
  }
}

function syncLegacyEditorState() {
  const buffer = app.workbench.activeBuffer;
  app.currentFile = buffer ? { path: buffer.path, size: buffer.size, modifiedAt: buffer.modifiedAt, content: buffer.content } : null;
  app.editorOriginal = buffer?.original || '';
}

function activateWorkbenchPane(paneId, { persist = true } = {}) {
  app.workbench.setActivePane(paneId);
  // Only refresh workbench chrome. Do not call renderPane/renderWorkbench here:
  // those functions may restore Monaco view state and overwrite a mouse caret move.
  for (const id of ['primary', 'secondary']) paneDom(id).pane?.classList.toggle('active-pane', app.workbench.activePane === id);
  renderBufferTabs();
  syncLegacyEditorState();
  updateWorkbenchStatus();
  if (persist) schedulePersistWorkbenchState();
}

function updateWorkbenchStatus() {
  const buffer = app.workbench.activeBuffer;
  const dirtyCount = app.workbench.buffers.filter((item) => item.dirty).length;
  if ($('#editorDirty')) {
    $('#editorDirty').textContent = dirtyCount ? `●${dirtyCount > 1 ? dirtyCount : ''}` : '';
    $('#editorDirty').style.color = dirtyCount ? 'var(--yellow)' : '';
  }
  if ($('#workspaceStatus')) $('#workspaceStatus').textContent = app.workspace ? truncate(app.workspace, 34) : 'No workspace';
  if ($('#workspaceStatus')) $('#workspaceStatus').title = app.workspace || '';
  if ($('#bufferStatus')) {
    $('#bufferStatus').textContent = buffer ? `${buffer.name}${buffer.dirty ? ' •' : ''}` : 'No buffer';
    $('#bufferStatus').title = buffer?.path || '';
  }
}

function renderBufferTabs() {
  const host = $('#bufferTabs');
  if (!host) return;
  host.innerHTML = '';
  const active = app.workbench.activeBuffer?.id;
  for (const buffer of app.workbench.buffers) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `buffer-tab ${buffer.id === active ? 'active' : ''}`;
    tab.dataset.bufferId = buffer.id;
    tab.title = buffer.path;
    tab.innerHTML = `<span class="buffer-name">${escapeHtml(buffer.name)}</span>${buffer.dirty ? '<span class="buffer-dirty">●</span>' : ''}${buffer.externalChanged ? '<span class="buffer-dirty" title="Changed on disk">⚠</span>' : ''}<span class="buffer-close" aria-label="Close">×</span>`;
    tab.onclick = (event) => {
      if (event.target?.classList?.contains('buffer-close')) {
        event.stopPropagation();
        closeBuffer(buffer.id);
        return;
      }
      captureEditorViewState(app.workbench.activePane);
      app.workbench.activate(buffer.id);
      renderWorkbench();
      schedulePersistWorkbenchState();
    };
    host.append(tab);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="buffer-tabs-empty">No open files</div>';
}

function renderPane(paneId) {
  const dom = paneDom(paneId);
  const buffer = app.workbench.bufferForPane(paneId);
  dom.pane?.classList.toggle('active-pane', app.workbench.activePane === paneId);
  if (!dom.editor || !dom.path || !dom.meta) return;
  if (!buffer) {
    dom.path.textContent = 'No file open';
    dom.meta.textContent = '';
    if (app.monacoAvailable && app.monaco?.ready) app.monaco.showBuffer(paneId, null);
    else if (dom.editor.value) dom.editor.value = '';
    return;
  }
  dom.path.textContent = buffer.path;
  dom.meta.textContent = `${formatBytes(buffer.size)} · ${formatTime(buffer.modifiedAt)} · ${buffer.language || ''}${buffer.dirty ? ' · modified' : ''}${buffer.externalChanged ? ' · changed on disk' : ''}`;
  if (app.monacoAvailable && app.monaco?.ready) {
    app.monaco.showBuffer(paneId, buffer);
    app.monaco.restoreViewState(paneId, app.editorViewStates?.[buffer.path]?.[paneId]);
  } else if (dom.editor.value !== buffer.content) dom.editor.value = buffer.content;
}

function renderWorkbench() {
  const host = $('#editorWorkbench');
  if (!host) return;
  host.classList.remove('split-none', 'split-vertical', 'split-horizontal');
  host.classList.add(`split-${app.workbench.split}`);
  const splitOpen = app.workbench.split !== 'none';
  $('#editorPaneSecondary')?.classList.toggle('hidden', !splitOpen);
  $('#editorSplitDivider')?.classList.toggle('hidden', !splitOpen);
  renderPane('primary');
  renderPane('secondary');
  renderBufferTabs();
  syncLegacyEditorState();
  updateWorkbenchStatus();
}

async function openFile(filePath, { paneId = app.workbench.activePane, reload = false, switchToEditor = true, reveal = null } = {}) {
  const context = captureWorkspaceContext();
  try {
    const existing = app.workbench.buffer(filePath);
    if (existing && !reload) {
      app.workbench.activate(existing.id, { paneId });
      renderWorkbench();
      if (switchToEditor) switchView('editor');
      if (reveal && app.monacoAvailable) app.monaco.reveal(paneId, reveal.line, reveal.column);
      syncPaneLsp(paneId, 'open', true);
      schedulePersistWorkbenchState();
      return;
    }
    const value = await api(`/api/workspace/file?workspace=${enc(context.workspace)}&path=${enc(filePath)}`);
    if (!workspaceContextIsCurrent(context)) return;
    app.workbench.open({ ...value.file, dirty: false }, { paneId });
    renderWorkbench();
    if (switchToEditor) switchView('editor');
    if (reveal && app.monacoAvailable) requestAnimationFrame(() => app.monaco.reveal(paneId, reveal.line, reveal.column));
    syncPaneLsp(paneId, 'open', true);
    schedulePersistWorkbenchState();
  } catch (e) { if (workspaceContextIsCurrent(context)) toast(e.message, 'error'); }
}

function markEditorDirty() { renderWorkbench(); }

function applySavedFileMetadata(bufferId, response, content) {
  const file = response?.file || {};
  return app.workbench.markBufferSaved(bufferId, {
    content,
    size: file.size ?? new TextEncoder().encode(content).byteLength,
    modifiedAt: file.modifiedAt ?? new Date().toISOString(),
    mtimeMs: file.mtimeMs ?? null
  });
}

async function writeEditorBuffer(buffer, content, { force = false, workspace = app.workspace } = {}) {
  try {
    return await put('/api/workspace/file', {
      workspace,
      path: buffer.path,
      content,
      expectedMtimeMs: buffer.mtimeMs,
      force
    });
  } catch (error) {
    const externalConflict = error.code === 'FILE_CHANGED_ON_DISK' || Number(error.status) === 409;
    if (!externalConflict || force) throw error;
    app.workbench.markExternalChange?.(buffer.id, { mtimeMs: error.details?.mtimeMs });
    renderBufferTabs(); updateWorkbenchStatus();
    const overwrite = typeof window.confirm === 'function'
      ? window.confirm(`${buffer.name} changed on disk after it was opened.\n\nOK: overwrite the newer disk version with your editor buffer.\nCancel: keep your unsaved buffer and use Reload to inspect the disk version.`)
      : false;
    if (!overwrite) {
      // Native confirm dialogs pause rendering on some browsers. Repaint after
      // dismissal so the conflict marker remains visible until Reload/overwrite.
      renderBufferTabs(); updateWorkbenchStatus();
      throw Object.assign(new Error('Save canceled because the file changed on disk'), { code: 'FILE_CHANGED_ON_DISK' });
    }
    return put('/api/workspace/file', { workspace, path: buffer.path, content, force: true });
  }
}

async function saveFile({ paneId = app.workbench.activePane } = {}) {
  const context = captureWorkspaceContext();
  const buffer = app.workbench.bufferForPane(paneId);
  if (!buffer) return toast('No file open', 'error');
  const content = currentEditorValue(paneId);
  try {
    const response = await writeEditorBuffer(buffer, content, { workspace: context.workspace });
    if (!workspaceContextIsCurrent(context)) return;
    app.workbench.updateContent(content, { paneId });
    applySavedFileMetadata(buffer.id, response, content);
    renderWorkbench();
    schedulePersistWorkbenchState();
    toast('File saved', 'success');
    syncPaneLsp(paneId, 'save', true);
    await loadGit();
  } catch (e) { if (workspaceContextIsCurrent(context)) toast(e.message, e.code === 'FILE_CHANGED_ON_DISK' ? '' : 'error'); }
}

async function saveAllFiles() {
  const context = captureWorkspaceContext();
  const dirty = app.workbench.buffers.filter((buffer) => buffer.dirty);
  if (!dirty.length) return toast('All open files are already saved', '');
  let saved = 0;
  const failures = [];
  for (const buffer of dirty) {
    try {
      const response = await writeEditorBuffer(buffer, buffer.content, { workspace: context.workspace });
      if (!workspaceContextIsCurrent(context)) return;
      applySavedFileMetadata(buffer.id, response, buffer.content);
      const model = app.monaco?.getModelForPath?.(buffer.path); if (model) app.lsp?.syncModel?.(model, 'save', { immediate: true }).catch(() => {});
      saved += 1;
    } catch (error) { failures.push(`${buffer.path}: ${error.message}`); }
  }
  if (!workspaceContextIsCurrent(context)) return;
  renderWorkbench();
  schedulePersistWorkbenchState();
  await Promise.allSettled([loadGit(), loadGitPanel()]);
  if (failures.length) {
    addProblem({ title: `Save All failed for ${failures.length} file(s)`, detail: failures.join('\n'), source: 'Editor', severity: 'error' });
    toast(`Saved ${saved}; ${failures.length} failed`, 'error');
  } else toast(`Saved ${saved} file${saved === 1 ? '' : 's'}`, 'success');
}

async function refreshOpenFilesFromDisk({ reason = 'manual' } = {}) {
  if (!app.workspace || !app.workbench.size) return { reloaded: 0, conflicts: 0 };
  const context = captureWorkspaceContext();
  let reloaded = 0;
  let conflicts = 0;
  for (const buffer of app.workbench.buffers) {
    try {
      const value = await api(`/api/workspace/file?workspace=${enc(context.workspace)}&path=${enc(buffer.path)}`);
      if (!workspaceContextIsCurrent(context)) return { reloaded, conflicts };
      const result = app.workbench.refreshFromDisk(buffer.id, value.file);
      if (result.action === 'reloaded') reloaded += 1;
      if (result.action === 'conflict') conflicts += 1;
    } catch (error) {
      if (!workspaceContextIsCurrent(context)) return { reloaded, conflicts };
      if (error.status === 404) {
        app.workbench.markExternalChange?.(buffer.id, { missing: true });
        conflicts += 1;
      }
    }
  }
  if (reloaded) {
    renderWorkbench();
    for (const paneId of ['primary', 'secondary']) syncPaneLsp(paneId, 'change', true);
    if (reason !== 'visibility') toast(`Reloaded ${reloaded} file${reloaded === 1 ? '' : 's'} changed on disk`, '');
  } else if (conflicts) {
    renderBufferTabs(); updateWorkbenchStatus();
  }
  if (conflicts && reason !== 'visibility') toast(`${conflicts} open file${conflicts === 1 ? '' : 's'} changed on disk while you have unsaved edits`, 'error');
  return { reloaded, conflicts };
}

async function reloadActiveFile({ paneId = app.workbench.activePane } = {}) {
  const buffer = app.workbench.bufferForPane(paneId);
  if (!buffer) return toast('No file open', 'error');
  if (buffer.dirty && typeof window.confirm === 'function' && !window.confirm(`Discard unsaved changes in ${buffer.name}?`)) return;
  await openFile(buffer.path, { paneId, reload: true });
}

function closeBuffer(bufferId = app.workbench.activeBuffer?.id) {
  if (!bufferId) return;
  const buffer = app.workbench.buffer(bufferId);
  if (buffer?.dirty && typeof window.confirm === 'function' && !window.confirm(`Close ${buffer.name} without saving?`)) return;
  captureEditorViewState(app.workbench.activePane);
  app.lsp?.closePath?.(bufferId).catch(() => {});
  app.workbench.close(bufferId, { force: true });
  app.monaco?.disposeModel?.(bufferId);
  renderWorkbench();
  schedulePersistWorkbenchState();
}

function cycleBuffer(delta) {
  captureEditorViewState(app.workbench.activePane);
  app.workbench.next(delta);
  renderWorkbench();
  schedulePersistWorkbenchState();
}

function setEditorSplit(direction) {
  const active = app.workbench.activeBuffer;
  if (!active) return toast('Open a file before splitting the editor', 'error');
  app.workbench.setSplit(direction);
  renderWorkbench();
  if (app.monacoAvailable) app.monaco.focus('secondary'); else paneDom('secondary').editor?.focus?.();
  app.workbench.setActivePane('secondary');
  renderWorkbench();
  schedulePersistWorkbenchState();
}

function closeEditorSplit() {
  captureEditorViewState('secondary');
  app.workbench.closeSplit();
  renderWorkbench();
  schedulePersistWorkbenchState();
}

function installEditorSplitDragging() {
  const divider = $('#editorSplitDivider');
  const host = $('#editorWorkbench');
  if (!divider || !host) return;
  divider.addEventListener('pointerdown', (event) => {
    if (app.workbench.split === 'none') return;
    event.preventDefault();
    divider.setPointerCapture?.(event.pointerId);
    document.body.classList.add('resizing-editor-split');
    const move = (moveEvent) => {
      const rect = host.getBoundingClientRect?.();
      if (!rect) return;
      const raw = app.workbench.split === 'vertical'
        ? ((moveEvent.clientX - rect.left) / rect.width) * 100
        : ((moveEvent.clientY - rect.top) / rect.height) * 100;
      const percent = Math.max(20, Math.min(80, raw));
      host.style.setProperty('--editor-split-size', `${percent}%`);
      schedulePersistWorkbenchState();
    };
    const up = () => {
      document.body.classList.remove('resizing-editor-split');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
}

async function startPi(sessionPath = null, sessionName = '', { harnessId = selectedHarnessId(), modelId: requestedModelId = '', thinkingLevel = '' } = {}) {
  const context = captureWorkspaceContext();
  const button = $('#startPi'); const modelId = String(requestedModelId || getSelectedModelId()).trim();
  if (!app.workspace) return toast('Open a workspace first', 'error'); if (!modelId) return toast('Select or enter a model name', 'error');
  setBusy(button, true, 'Starting…');
  try {
    const value = await post('/api/pi/start', { workspace: context.workspace, modelId, harnessId, sessionPath, sessionName: sessionName || undefined });
    if (!workspaceContextIsCurrent(context)) {
      await post('/api/pi/stop', { workspace: context.workspace }).catch(() => null);
      return;
    }
    app.pi.status = value.status;
    app.pi.resourceRestartRequired = false;
    app.pi.resourceRestartReason = '';
    if (thinkingLevel) await rpc({ type: 'set_thinking_level', level: thinkingLevel }, { quiet: true }).catch(() => {});
    await refreshSnapshot(); await refreshThinkingLevels(); await refreshMessages(); await loadSessions();
    // A session card may be resumed while Session Tree is already visible.
    // The first tree load happens before Pi is ready and intentionally fails;
    // replace that stale empty state as soon as startup has completed.
    if (activeViewName() === 'tree') await loadSessionTree().catch(() => {});
    renderHarnessStatus(); renderPiResourceLifecycle();
    toast(`Pi started · ${harnessById(harnessId)?.name || harnessId}`, 'success');
  } catch (e) { toast(e.message, 'error'); return false; } finally { setBusy(button, false); renderPiSnapshot(); }
  return true;
}
async function stopPi({ quiet = false, preserveResourceRestartState = false } = {}) {
  try {
    await post('/api/pi/stop', { workspace: app.workspace });
    const resourceRestartRequired = preserveResourceRestartState ? Boolean(app.pi.resourceRestartRequired) : false;
    const resourceRestartReason = preserveResourceRestartState ? String(app.pi.resourceRestartReason || '') : '';
    const resourceRestartInProgress = preserveResourceRestartState ? Boolean(app.pi.resourceRestartInProgress) : false;
    app.pi = { status: {}, state: null, stats: null, resourceRestartRequired, resourceRestartReason, resourceRestartInProgress };
    app.streamMessage = null;
    app.sendingPrompt = false;
    app.agentBusy = false;
    app.toolCards.clear();
    renderPiSnapshot();
    renderHarnessStatus(); renderPiResourceLifecycle();
    if (!quiet) toast('Pi stopped');
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
    else throw e;
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
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

function setModelSelectorValue(modelId) {
  const selected = String(modelId || '').trim();
  const select = $('#topModel');
  const custom = $('#customModelInput');
  if (!select || !custom) return;
  if ([...select.options].some((item) => item.value === selected && !item.disabled)) {
    select.value = selected;
    custom.classList.add('hidden');
  } else {
    select.value = '__custom__';
    custom.value = selected;
    custom.classList.remove('hidden');
  }
}

async function chooseModel(modelId, { provider = '' } = {}) {
  const rawModel = String(modelId || '').trim();
  if (!rawModel) return false;
  const selected = provider && provider !== 'ollama' ? `${provider}/${rawModel}` : rawModel.replace(/^ollama\//, '');
  // While Pi is live, its actual model is the only honest rollback target. A
  // stale browser preference must never repaint the selector after a failed
  // set_model request. When stopped, prefer the persisted startup default and
  // use localStorage only as a legacy fallback.
  let previous = String(app.pi.status?.running ? app.pi.status?.modelId : app.config?.defaultModel || '').trim();
  if (!previous) {
    try { previous = localStorage.getItem('studio_selected_model') || ''; } catch { /* noop */ }
  }

  if (app.pi.status?.running) {
    const switched = await switchModel(rawModel, provider || undefined);
    if (!switched) {
      setModelSelectorValue(previous);
      renderActiveModel();
      return false;
    }
  }

  setModelSelectorValue(selected);
  try { localStorage.setItem('studio_selected_model', selected); } catch { /* noop */ }
  await persistDefaultModelSelection(selected).catch(() => {});
  renderActiveModel();
  renderSessionModelState();
  return true;
}


async function createPromptCheckpoint(message) {
  if (!app.workspace || !message || $('#autoGitCheckpoints')?.checked === false) return null;
  try {
    const result = await post('/api/workspace/git/checkpoint', {
      workspace: app.workspace,
      label: `Pi prompt checkpoint: ${message.slice(0, 120)}`
    });
    const checkpoint = result.checkpoint || null;
    if (checkpoint?.commit) {
      app.pendingCheckpoint = { message, checkpoint };
      return checkpoint;
    }
  } catch (error) {
    // Not every workspace is a Git repository. Checkpointing is an enhancement,
    // never a blocker for normal prompting.
    log('CHECKPOINT', `Skipped pre-prompt checkpoint: ${error.message}`);
  }
  return null;
}

async function associatePendingCheckpoint() {
  const pending = app.pendingCheckpoint;
  if (!pending?.checkpoint?.commit || !app.workspace || !app.pi.status?.running) return;
  try {
    const response = await rpc({ type: 'get_entries' }, { quiet: true });
    const entries = Array.isArray(response?.data) ? response.data : (response?.data?.entries || []);
    const candidates = entries.filter((entry) => (entry.message?.role === 'user' || entry.role === 'user') && (entry.id || entry.nodeId));
    let match = null;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const entry = candidates[i];
      const parsed = entry.message ? messageContent(entry.message) : { text: entry.content || entry.text || '' };
      const text = String(parsed.text || '').trim();
      if (text === pending.message || text.includes(pending.message.slice(0, 80)) || pending.message.includes(text.slice(0, 80))) {
        match = entry;
        break;
      }
    }
    match ||= candidates[candidates.length - 1] || null;
    const nodeId = match?.id || match?.nodeId;
    if (!nodeId) return;
    await post('/api/checkpoints/associate', { workspace: app.workspace, nodeId, checkpoint: pending.checkpoint });
    app.checkpoints[nodeId] = { ...pending.checkpoint, nodeId };
    app.pendingCheckpoint = null;
    if (sessionTreeData) renderSessionTree();
  } catch (error) {
    log('CHECKPOINT', `Could not associate checkpoint with prompt: ${error.message}`);
  }
}

async function loadCheckpoints() {
  if (!app.workspace) { app.checkpoints = {}; return; }
  const context = captureWorkspaceContext();
  try {
    const value = await api(`/api/checkpoints?workspace=${enc(context.workspace)}`);
    if (!workspaceContextIsCurrent(context)) return;
    app.checkpoints = value.checkpoints || {};
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    app.checkpoints = {};
    log('CHECKPOINT', error.message);
  }
}

// ── Prompt Submission ──────────────────────────────────────────────────────────
async function sendPrompt(mode = 'prompt') {
  const message = $('#composer').value.trim();
  if (!message) return;
  const selectedMode = typeof mode === 'string' && mode ? mode : 'prompt';
  // A local generation can run for minutes. Keep ordinary prompt submission
  // separate from Pi's explicit steer/follow-up actions for the active turn.
  if (app.sendingPrompt) return toast('The previous request is still being submitted', 'error');
  if (selectedMode === 'prompt' && app.agentBusy) return toast('Pi is still working. Use Steer Now, Follow Up, or Abort.', 'error');
  if (selectedMode !== 'prompt' && !app.agentBusy) return toast('There is no active Pi turn to steer or follow up', 'error');
  const images = app.attachments.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
  const command = { type: selectedMode, message, ...(images.length ? { images } : {}) };
  const sendBtn = $('#sendPrompt');

  // ── Store in composer history ─────────────────────────────────────────────
  app.sendingPrompt = true;
  setBusy(sendBtn, true, 'Working…');
  if (!app.pi.status?.running) {
    const started = await startPi(null, '', { harnessId: selectedHarnessId(), thinkingLevel: $('#thinkingLevel')?.value || 'off' });
    if (!started || !app.pi.status?.running) {
      app.sendingPrompt = false;
      setBusy(sendBtn, false);
      return;
    }
  }
  if (selectedMode === 'prompt') await createPromptCheckpoint(message);
  if (selectedMode === 'prompt') { app.agentBusy = true; renderAgentActionState(); }
  $('#agentStatus').textContent = 'Working';
  const submittedAttachments = [...app.attachments];
  let optimisticMessage = null;
  try {
    optimisticMessage = createMessage('user', message);
    $('#composer').value = '';
    app.attachments = [];
    renderAttachments();
    await rpc(command, { quiet: true });
    if (selectedMode === 'prompt') {
      app.promptHistory.unshift(message);
      if (app.promptHistory.length > 50) app.promptHistory.length = 50;
      app.promptHistoryIndex = -1;
      app.promptDraft = '';
      try { sessionStorage.setItem('studio_prompt_history', JSON.stringify(app.promptHistory)); } catch { /* ignore */ }
    }
  } catch (e) {
    if (selectedMode === 'prompt') { app.agentBusy = false; renderAgentActionState(); }
    optimisticMessage?.remove?.();
    if (!$('#composer').value.trim()) $('#composer').value = message;
    if (!app.attachments.length) app.attachments = submittedAttachments;
    if (app.pendingCheckpoint?.message === message) app.pendingCheckpoint = null;
    renderAttachments();
    toast(e.message, 'error');
  } finally {
    app.sendingPrompt = false;
    setBusy(sendBtn, false);
    renderAgentActionState();
  }
}

function switchView(name) {
  $$('.view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'terminal') { loadTerminalSessions(); requestAnimationFrame(() => { try { activeTerminalInstance()?.fit?.fit?.(); } catch { /* noop */ } }); }
  if (name === 'tests') discoverTestsUi();
  if (name === 'git') loadGitPanel();
  if (name === 'tree' && !app.currentInspectedSession) loadSessionTree();
  if (name === 'editor') renderWorkbench();
  if (name === 'preview') previewPanel?.refresh?.().catch((error) => toast(error.message, 'error'));
  if (name === 'resources') { loadPiPlatform({ quiet: true }).catch(() => {}); if (app.pi.status?.running && !app.resources.commands.length) loadCommands().catch(() => {}); else renderPlatformTab(); }
  schedulePersistWorkbenchState();
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
  $$('[data-doc-action]').forEach((button) => {
    if (button.dataset.docActionInstalled) return;
    button.dataset.docActionInstalled = 'true';
    button.addEventListener('click', () => {
      if (button.dataset.docAction === 'resources-extensions') {
        switchView('resources');
        app.platform.tab = 'extensions';
        loadPiPlatform({ quiet: true }).catch(() => {});
        piPlatformPanel?.renderTab?.();
      }
    });
  });
}

function filterDocumentation(query) {
  const terms = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  let visible = 0;
  $$('[data-doc-search]').forEach((card) => {
    const haystack = `${card.textContent} ${card.dataset.docKeywords || ''}`.toLowerCase();
    const match = terms.length === 0 || terms.every((term) => haystack.includes(term));
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

function parseOllamaParameters(paramsText, modelfileText = '') {
  const result = {};
  if (paramsText && typeof paramsText === 'string') {
    for (const line of paramsText.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const key = parts[0].toLowerCase();
        const val = parts.slice(1).join(' ');
        result[key] = val;
      }
    }
  }
  if (modelfileText && typeof modelfileText === 'string') {
    for (const line of modelfileText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toUpperCase().startsWith('PARAMETER ')) {
        const parts = trimmed.slice(10).trim().split(/\s+/);
        if (parts.length >= 2) {
          const key = parts[0].toLowerCase();
          const val = parts.slice(1).join(' ');
          if (!result[key]) result[key] = val;
        }
      } else if (trimmed.toUpperCase().startsWith('SYSTEM ')) {
        const sysVal = trimmed.slice(7).trim().replace(/^["']|["']$/g, '');
        if (!result.system) result.system = sysVal;
      }
    }
  }
  return result;
}

async function loadCurrentModelIntoProfile(modelIdInput = null) {
  const modelId = modelIdInput || app.pi.status?.modelId || getSelectedModelId();
  if (!modelId) return toast('No model selected', 'error');

  const cleanId = modelId.startsWith('ollama/') ? modelId.slice(7) : modelId;
  const baseSelect = $('#profileBaseModel');
  if (baseSelect) {
    const opt = [...baseSelect.options].find((o) => o.value === cleanId || o.value === modelId);
    if (opt) baseSelect.value = opt.value;
    else {
      const o = document.createElement('option');
      o.value = cleanId;
      o.textContent = cleanId;
      baseSelect.prepend(o);
      baseSelect.value = cleanId;
    }
  }

  // 1. Try saved profiles in app.profiles
  const profiles = app.profiles || [];
  const profile = profiles.find((p) => p.id === modelId || p.name === modelId || p.id === cleanId || p.name === cleanId);

  if (profile) {
    if (profile.contextWindow) $('#profileContext').value = profile.contextWindow;
    if (profile.maxTokens) $('#profileOutput').value = profile.maxTokens;
    if (profile.temperature != null) $('#profileTemperature').value = profile.temperature;
    if (profile.topP != null) $('#profileTopP').value = profile.topP;
    if (profile.topK != null) $('#profileTopK').value = profile.topK;
    if (profile.minP != null) $('#profileMinP').value = profile.minP;
    if (profile.repeatPenalty != null) $('#profileRepeat').value = profile.repeatPenalty;
    if (profile.seed != null) $('#profileSeed').value = profile.seed;
    if (profile.mirostat != null) $('#profileMirostat').value = String(profile.mirostat);
    if (profile.stop) $('#profileStop').value = Array.isArray(profile.stop) ? profile.stop.join(', ') : profile.stop;
    if (profile.system) $('#profileSystem').value = profile.system;
    if (profile.reasoning != null) $('#profileReasoning').checked = Boolean(profile.reasoning);
    if (profile.vision != null) $('#profileVision').checked = Boolean(profile.vision);
    $('#profileName').value = profile.name || cleanId;
    toast(`Loaded profile parameters for ${cleanId}`, 'success');
    switchSettings('model');
    return;
  }

  // 2. Fetch parameters directly from Ollama show endpoint
  try {
    const res = await api(`/api/ollama/show?model=${encodeURIComponent(cleanId)}`);
    if (res.ok && res.model) {
      const parsed = parseOllamaParameters(res.model.parameters, res.model.modelfile);
      if (parsed.num_ctx) $('#profileContext').value = parsed.num_ctx;
      if (parsed.num_predict) $('#profileOutput').value = parsed.num_predict;
      if (parsed.temperature) $('#profileTemperature').value = parsed.temperature;
      if (parsed.top_p) $('#profileTopP').value = parsed.top_p;
      if (parsed.top_k) $('#profileTopK').value = parsed.top_k;
      if (parsed.min_p) $('#profileMinP').value = parsed.min_p;
      if (parsed.repeat_penalty) $('#profileRepeat').value = parsed.repeat_penalty;
      if (parsed.stop) $('#profileStop').value = parsed.stop;
      if (parsed.system) $('#profileSystem').value = parsed.system;

      const isReasoning = Boolean(cleanId.includes('qwen') || cleanId.includes('deepseek') || cleanId.includes('r1') || cleanId.includes('cot') || parsed.system?.includes('think'));
      $('#profileReasoning').checked = isReasoning;
      $('#profileName').value = `${cleanId.split(':')[0]}-profile`;
      toast(`Loaded Ollama model parameters for ${cleanId}`, 'success');
      switchSettings('model');
      return;
    }
  } catch (e) {
    log('MODEL_SHOW', e.message);
  }

  $('#profileName').value = `${cleanId.split(':')[0]}-profile`;
  toast(`Pre-filled base model for ${cleanId}. Adjust parameters and save.`, 'info');
  switchSettings('model');
}

function apply3090Preset() {
  const baseSelect = $('#profileBaseModel');
  const baseModel = baseSelect?.value || getSelectedModelId() || 'qwen2.5-coder:32b';
  const cleanId = baseModel.startsWith('ollama/') ? baseModel.slice(7) : baseModel;

  $('#profileContext').value = 65536;      // 64k context
  $('#profileOutput').value = 8192;        // 8k output limit
  $('#profileTemperature').value = 0.15;   // Low temperature for code accuracy
  $('#profileTopP').value = 0.90;          // Nucleus sampling
  $('#profileTopK').value = 40;            // Top-k limit
  $('#profileMinP').value = 0.05;          // Min-p cutoff
  $('#profileRepeat').value = 1.05;        // Slight repeat penalty
  $('#profileSeed').value = -1;
  $('#profileMirostat').value = '0';
  $('#profileReasoning').checked = true;
  $('#profileName').value = `${cleanId.split(':')[0]}-3090-coder`;

  toast('Applied RTX 3090 (24GB) 64K Coding Preset!', 'success');
  switchSettings('model');
}
async function pullModel() {
  const model = $('#pullModelName').value.trim(); if (!model) return;
  if (app.ollama?.online !== true) return toast('The active Ollama runtime is offline. Test and use a server before downloading a model.', 'error');
  const button = $('#pullModel'); setBusy(button, true, 'Pulling…');
  try { await post('/api/ollama/pull', { model }); await refreshOllama(); toast(`${model} pulled to ${app.ollama?.runtime?.name || 'active Ollama'}`, 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(button, false); }
}
async function doUnload(modelId, sourceButton = null) {
  const button = sourceButton || $('#unloadModel');
  const requested = String(modelId || getSelectedModelId() || '').trim();
  const running = (app.ollama.running || []).find((item) => ollamaModelKey(item.model || item.name) === ollamaModelKey(requested));
  if (!running) return toast(`${requested || 'Selected model'} is not loaded`, 'error');
  setBusy(button, true, 'Unloading…');
  try {
    const target = running.model || running.name || requested;
    await post('/api/ollama/unload', { model: target });
    await refreshOllama();
    toast('Model unloaded from VRAM', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { setBusy(button, false); renderActiveModel(); renderModelLibrary(); }
}
async function diagnoseModel() {
  const model = $('#topModel').value; if (!model) return;
  try { const value = await api(`/api/ollama/diagnostics?model=${enc(model)}&contextLength=${enc($('#profileContext').value || app.config.defaultContextLength)}&kvType=${enc(app.config.kvCacheType)}&parallel=${enc(app.config.numParallel)}`); const d = value.diagnostics; $('#kvEstimate').textContent = d.kv.formatted || 'Unknown'; $('#runtimeContext').textContent = d.running?.context_length ? formatNumber(d.running.context_length) : formatNumber(d.kv.contextLength); $('#modelVram').textContent = d.running ? formatBytes(d.running.size_vram) : 'Not loaded'; $('#offloadStatus').textContent = d.running ? (d.running.size_vram >= d.running.size * .95 ? 'GPU' : 'Partial') : '—'; toast(d.kv.reason || `Estimated KV cache: ${d.kv.formatted}`, d.kv.reason ? 'error' : 'success'); } catch (e) { toast(e.message, 'error'); }
}

async function saveRuntime({ requireTestedRuntime = false } = {}) {
  const runtimeUrl = $('#ollamaBaseUrl').value.trim();
  const candidateFingerprint = currentRuntimeTestFingerprint();
  const runtimeIdentityChanged = candidateFingerprint !== activeRuntimeFingerprint();
  if ((requireTestedRuntime || runtimeIdentityChanged) && candidateFingerprint !== testedRuntimeFingerprint(app.testedOllama)) {
    app.testedOllama = null; renderTestedOllama(null);
    return toast('Test the current Ollama connection settings, then choose Use this server before switching.', 'error');
  }
  let runtimeLocal = false; try { const u = new URL(runtimeUrl); runtimeLocal = ['localhost', '127.0.0.1', '::1'].includes(u.hostname.replace(/^\[|\]$/g, '')); } catch { /* validation happens server-side */ }
  const update = { ollamaBaseUrl: runtimeUrl, ollamaApiKeyEnv: $('#ollamaApiKeyEnv').value, ollamaRuntimeKind: $('#ollamaRuntimeKind').value, ollamaRuntimeName: $('#ollamaRuntimeName').value, kvCacheType: $('#kvCacheType').value, flashAttention: $('#flashAttention').checked, defaultContextLength: Number($('#defaultContext').value), numParallel: Number($('#numParallel').value), maxLoadedModels: Number($('#maxLoadedModels').value), maxQueue: Number($('#maxQueue').value), keepAlive: $('#keepAlive').value, noCloud: $('#noCloud').checked, managedOllama: runtimeLocal && $('#managedOllama').checked };
  const nextUrl = runtimeUrl.replace(/\/+$/, ''); const switchingRuntime = runtimeIdentityChanged;
  const previousOllama = app.ollama;
  try {
    if (switchingRuntime && app.pi.status?.running) await stopPi();
    if (switchingRuntime) { app.ollama = { online: false, models: [], running: [], runtime: { baseUrl: nextUrl, name: update.ollamaRuntimeName, kind: update.ollamaRuntimeKind } }; refreshModelSelectors(); renderHealth(); renderOllamaInventorySummary(); }

    let value;
    try { value = await put('/api/config', update); }
    catch (error) {
      if (switchingRuntime) { app.ollama = previousOllama; refreshModelSelectors(); renderHealth(); renderOllamaRuntimeStatus(); renderOllamaInventorySummary(); }
      throw error;
    }

    // The runtime switch is committed once config persistence succeeds. From here
    // on, endpoint B remains authoritative even if inventory refresh or Pi sync has
    // a transient failure.
    app.config = value.config; applyConfig();
    const warnings = [];
    await refreshOllama().catch((error) => warnings.push(error.message));
    await post('/api/ollama/sync').catch((error) => warnings.push(error.message));
    if (switchingRuntime) {
      const selectedForRuntime = getSelectedModelId();
      await persistDefaultModelSelection(selectedForRuntime, { quiet: true }).catch((error) => warnings.push(error.message));
    }
    app.testedOllama = null; renderTestedOllama(null);
    if (warnings.length) toast(`Ollama runtime switched with ${warnings.length} refresh warning${warnings.length === 1 ? '' : 's'}`, 'error');
    else toast(switchingRuntime ? 'Ollama runtime switched' : 'Runtime settings saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
async function saveCommands() { try { const value = await put('/api/config', { piCommand: $('#piCommand').value, ollamaCommand: $('#ollamaCommand').value, trustProjects: $('#trustProjects').checked }); app.config = value.config; toast('Command settings saved', 'success'); } catch (e) { toast(e.message, 'error'); } }

function classifyPiResource(command) {
  const source = String(command?.source || command?.origin || command?.type || '').toLowerCase();
  const name = String(command?.name || '').toLowerCase();
  if (source.includes('skill') || name.startsWith('skill:')) return 'skill';
  if (source.includes('prompt') || source.includes('template')) return 'prompt';
  if (source.includes('extension') || source.includes('plugin')) return 'extension';
  return 'builtin';
}

function insertPiCommand(command) {
  if (!command?.name) return;
  $('#composer').value = `/${command.name} `;
  switchView('chat');
  $('#composer').focus();
  if (app.interaction.mode === 'vim') setVimMode('insert');
}

function renderPiResources() {
  const host = $('#resourceList');
  if (!host) return;
  const query = String(app.resources.query || '').trim().toLowerCase();
  const filter = app.resources.filter || 'all';
  const items = (app.resources.commands || [])
    .map((command) => ({ command, kind: classifyPiResource(command) }))
    .filter(({ command, kind }) => filter === 'all' || kind === filter)
    .filter(({ command, kind }) => !query || [command.name, command.description, command.source, kind].some((value) => String(value || '').toLowerCase().includes(query)));

  host.innerHTML = '';
  host.classList.toggle('empty-state', !items.length);
  for (const { command, kind } of items) {
    const card = document.createElement('div');
    card.className = 'resource-card';
    const source = command.source || command.origin || 'Pi';
    card.innerHTML = `<span class="resource-kind ${escapeHtml(kind)}">${escapeHtml(kind)}</span><div class="resource-main"><strong>/${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description || source)}</span></div><div class="resource-actions"><button class="sm-btn resource-insert">Insert</button><button class="sm-btn primary resource-run">Run</button></div>`;
    $('.resource-insert', card).onclick = () => insertPiCommand(command);
    $('.resource-run', card).onclick = () => { insertPiCommand(command); sendPrompt('prompt'); };
    host.append(card);
  }
  if (!items.length) host.textContent = app.pi.status?.running ? 'No matching Pi resources.' : 'Start Pi to discover skills, prompts, extensions, and slash commands.';
  const counts = (app.resources.commands || []).reduce((acc, command) => { const kind = classifyPiResource(command); acc[kind] = (acc[kind] || 0) + 1; return acc; }, {});
  if ($('#resourceSummary')) $('#resourceSummary').textContent = `${app.resources.commands.length} resources · ${counts.skill || 0} skills · ${counts.prompt || 0} prompts · ${counts.extension || 0} extensions · ${counts.builtin || 0} built-ins`;
}

async function loadCommands() {
  const context = captureWorkspaceContext();
  try {
    const response = await rpc({ type: 'get_commands' });
    if (!workspaceContextIsCurrent(context)) return [];
    const commands = response.data?.commands || [];
    app.resources.commands = commands;
    const host = $('#commandList');
    if (host) {
      host.innerHTML = '';
      for (const command of commands) {
        const node = document.createElement('div');
        node.className = 'command-item';
        node.innerHTML = `<strong>/${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description || command.source || '')}</span>`;
        node.onclick = () => insertPiCommand(command);
        host.append(node);
      }
      if (!commands.length) host.textContent = 'No extension, prompt, or skill commands found.';
    }
    renderPiResources();
    return commands;
  } catch (e) { if (!workspaceContextIsCurrent(context)) return []; toast(e.message, 'error'); throw e; }
}


// ── Pi Platform resource manager (v1.8 modular controller) ──────────────────
function renderPlatformTab() { return piPlatformPanel?.renderTab(); }
async function loadPiPlatform(options = {}) { return piPlatformPanel?.load(options); }

let sessionTreeData = null;
let currentTreeFilter = 'all';
let currentTreeMode = 'active_path';
let currentTreeSearch = '';
let treeExpandedState = false;
let pendingSessionOperation = null;

async function loadSessionTree(raw = false) {
  const context = captureWorkspaceContext();
  try {
    if (!raw) await loadCheckpoints();
    if (!workspaceContextIsCurrent(context)) return;
    const response = await rpc({ type: raw ? 'get_entries' : 'get_tree' });
    if (!workspaceContextIsCurrent(context)) return;
    const host = $('#sessionTree');
    host.innerHTML = '';
    if (raw) {
      host.innerHTML = `<pre style="padding:15px; font-family:var(--mono); white-space:pre-wrap;">${escapeHtml(JSON.stringify(response.data, null, 2))}</pre>`;
      if ($('#treeStatsBar')) $('#treeStatsBar').classList.add('hidden');
      return;
    }
    app.currentInspectedSession = null;
    app.currentTreeSessionPath = app.pi.state?.sessionFile || null;
    sessionTreeData = response.data?.tree || [];
    renderSessionTree();
  } catch (e) {
    if (workspaceContextIsCurrent(context)) toast(e.message, 'error');
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
  card.dataset.nodeId = entry.id || entry.nodeId || '';
  card.dataset.role = role;

  const checkpoint = app.checkpoints?.[entry.id || entry.nodeId] || null;
  const roleBadge = `<span class="tree-node-badge ${escapeHtml(role)}">${escapeHtml(role)}</span>`;
  const leafBadge = isLeaf ? `<span class="tree-node-badge leaf">Active Tip</span>` : '';
  const checkpointBadge = checkpoint?.commit ? `<span class="tree-node-badge checkpoint" title="Git snapshot ${escapeHtml(checkpoint.commit)}">◈ ${escapeHtml(checkpoint.commit.slice(0, 7))}</span>` : '';
  const altBadge = altCount > 0 ? `<span class="tree-alt-branch-badge" title="Click to view alternate forks">🌿 +${altCount} fork(s)</span>` : '';
  const shortId = (entry.id || '').slice(0, 10);
  const timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';

  const header = document.createElement('div');
  header.className = 'tree-card-header';
  header.innerHTML = `
    <div>${roleBadge} ${leafBadge} ${checkpointBadge} ${altBadge}</div>
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
      const sourcePath = app.currentTreeSessionPath || app.pi.state?.sessionFile || null;
      const isLiveTree = Boolean(app.pi.status?.running && sourcePath && sourcePath === app.pi.state?.sessionFile);
      if (!isLiveTree) {
        if (!sourcePath) return toast('No session file is associated with this tree', 'error');
        return promptForkSession(sourcePath, entry.id);
      }
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

    const createAppBtn = document.createElement('button');
    createAppBtn.className = 'sm-btn secondary';
    createAppBtn.textContent = checkpoint?.commit ? '🚀 Create App from Snapshot' : '🚀 Create App from Prompt';
    createAppBtn.title = checkpoint?.commit ? 'Create an isolated Git worktree from the code snapshot captured before this prompt' : 'No historical Git snapshot is linked to this prompt';
    createAppBtn.onclick = async () => {
      await promptCreateAppFromNode(app.currentTreeSessionPath || app.pi.state?.sessionFile, entry.id, textContent);
    };
    actions.append(createAppBtn);
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
const gitPanel = { files: [], selectedFile: null, selectedStaged: false };

async function loadGitPanel() {
  if (!app.workspace) { renderGitPanelEmpty('Open a workspace first'); return; }
  const context = captureWorkspaceContext();
  const host = $('#gitFileList');
  const statusDiv = $('#gitBranchInfo');
  if (!host) return;
  host.innerHTML = '<div class="empty-state">Loading git status…</div>';
  try {
    const value = await api(`/api/workspace/git?workspace=${enc(context.workspace)}`);
    if (!workspaceContextIsCurrent(context)) return;
    const git = value.git;
    if (statusDiv) {
      statusDiv.textContent = git.isRepository
        ? `${git.branch || 'detached HEAD'}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
        : 'Not a git repository';
    }
    if (!git.isRepository) { renderGitPanelEmpty('Not a git repository'); return; }
    // Prefer backend-parsed -z status records so spaces, quotes and renames are lossless.
    if (Array.isArray(git.files)) {
      gitPanel.files = git.files.map((entry) => ({
        xy: String(entry.xy || '  ').slice(0, 2),
        file: String(entry.file || ''),
        originalPath: entry.originalPath ? String(entry.originalPath) : null,
        staged: Boolean(entry.staged),
        unstaged: Boolean(entry.unstaged)
      })).filter((entry) => entry.file);
    } else {
      const lines = String(git.porcelain || git.status || '').split('\n').filter(Boolean);
      gitPanel.files = lines.map((line) => {
        const xy = line.slice(0, 2);
        const file = line.slice(3);
        return { xy, file, originalPath: null, staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' };
      });
    }
    renderGitFileList();
  } catch (e) {
    if (workspaceContextIsCurrent(context)) host.innerHTML = `<div class="empty-state error-text">${escapeHtml(e.message)}</div>`;
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
        <button type="button" class="git-file-name" title="${escapeHtml(file.originalPath ? `${file.originalPath} → ${file.file}` : file.file)}" aria-label="Open diff for ${escapeHtml(file.file)}">${escapeHtml(file.originalPath ? `${file.originalPath} → ${file.file}` : file.file)}</button>
        <div class="git-file-actions">
          ${isStagedSection
            ? `<button class="sm-btn ghost" data-unstage="${escapeHtml(file.file)}" aria-label="Unstage ${escapeHtml(file.file)}">−</button>`
            : `<button class="sm-btn primary" data-stage="${escapeHtml(file.file)}" aria-label="Stage ${escapeHtml(file.file)}">+</button>`}
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

async function ensureGitDiffEditor() {
  if (app.monacoDiff?.editor) return true;
  app.monacoDiff ||= new MonacoDiffAdapter();
  try {
    await app.monacoDiff.init($('#gitMonacoDiff'));
    $('.git-diff-panel')?.classList.add('monaco-diff-ready');
    $('.git-diff-panel')?.classList.remove('diff-fallback');
    app.monacoDiff.setInline(app.gitDiffInline);
    return true;
  } catch (error) {
    $('.git-diff-panel')?.classList.add('diff-fallback');
    log('MONACO DIFF', `Using text diff fallback: ${error.message}`);
    return false;
  }
}

async function loadGitFileDiff(filePath, staged = false) {
  const context = captureWorkspaceContext();
  gitPanel.selectedFile = filePath;
  gitPanel.selectedStaged = staged;
  const host = $('#gitDiffContent');
  if (!host) return;
  $('#gitDiffTitle').textContent = `${staged ? 'Staged' : 'Working'} · ${filePath}`;
  host.innerHTML = '<div class="empty-state">Loading diff…</div>';
  renderGitFileList();
  try {
    const diffPromise = api(`/api/workspace/git/diff?workspace=${enc(context.workspace)}&path=${enc(filePath)}&staged=${staged ? '1' : '0'}`);
    const workingPromise = api(`/api/workspace/file?workspace=${enc(context.workspace)}&path=${enc(filePath)}`).catch(() => ({ file: { content: '' } }));
    const baseSource = staged ? 'head' : 'index';
    const basePromise = api(`/api/workspace/git/file?workspace=${enc(context.workspace)}&path=${enc(filePath)}&source=${baseSource}`).catch(() => ({ file: { content: '', exists: false } }));
    const stagedPromise = staged ? api(`/api/workspace/git/file?workspace=${enc(context.workspace)}&path=${enc(filePath)}&source=index`).catch(() => ({ file: { content: '', exists: false } })) : null;
    const [value, working, base, index] = await Promise.all([diffPromise, workingPromise, basePromise, stagedPromise]);
    if (!workspaceContextIsCurrent(context)) return;
    const diff = value.diff || 'No diff available';
    app.gitDiffPatch = value.diff || '';
    const lines = diff.split('\n');
    host.innerHTML = `<div class="diff-viewer">${lines.map((line) => {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del'
        : line.startsWith('@@') ? 'hunk'
        : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') ? 'meta' : '';
      return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
    }).join('')}</div>`;
    app.gitDiffModel = {
      path: filePath, staged,
      original: base.file?.content || '',
      modified: staged ? (index?.file?.content || '') : (working.file?.content || ''),
      source: staged ? 'HEAD' : 'Index'
    };
    if (await ensureGitDiffEditor()) app.monacoDiff.setDiff(app.gitDiffModel);
    updateGitDiffActions();
  } catch (e) {
    host.innerHTML = `<div class="empty-state error-text">${escapeHtml(e.message)}</div>`;
    $('.git-diff-panel')?.classList.add('diff-fallback');
  }
}

function selectedGitFileRecord() {
  return gitPanel.files.find((file) => file.file === gitPanel.selectedFile) || null;
}

function updateGitDiffActions() {
  const record = selectedGitFileRecord();
  const toggle = $('#gitToggleStage');
  const restore = $('#gitRestoreFile');
  const open = $('#gitOpenFile');
  const copy = $('#gitCopyPatch');
  if (toggle) { toggle.disabled = !gitPanel.selectedFile; toggle.textContent = gitPanel.selectedStaged ? 'Unstage' : 'Stage'; }
  if (open) open.disabled = !gitPanel.selectedFile || record?.xy?.includes('D');
  if (copy) copy.disabled = !gitPanel.selectedFile;
  if (restore) {
    const untracked = record?.xy === '??';
    restore.disabled = !gitPanel.selectedFile || gitPanel.selectedStaged || untracked;
    restore.title = gitPanel.selectedStaged ? 'Unstage this file instead' : untracked ? 'Untracked files are never deleted by Restore' : 'Discard working-tree changes';
  }
}

async function gitToggleSelectedStage() {
  if (!gitPanel.selectedFile) return toast('Select a changed file first', 'error');
  if (gitPanel.selectedStaged) await gitUnstageFile(gitPanel.selectedFile);
  else await gitStageFile(gitPanel.selectedFile);
  gitPanel.selectedStaged = !gitPanel.selectedStaged;
  await loadGitFileDiff(gitPanel.selectedFile, gitPanel.selectedStaged).catch(() => {});
}

async function openSelectedGitFile() {
  if (!gitPanel.selectedFile) return toast('Select a changed file first', 'error');
  await openFile(gitPanel.selectedFile);
}

async function copySelectedGitPatch() {
  if (!gitPanel.selectedFile) return toast('Select a changed file first', 'error');
  let text = app.gitDiffPatch;
  if (!text && app.gitDiffModel) {
    text = `${gitPanel.selectedStaged ? 'Staged' : 'Working'} change: ${gitPanel.selectedFile}\n\n${app.gitDiffModel.modified || ''}`;
  }
  await navigator.clipboard?.writeText?.(text || '');
  toast('Patch copied', 'success');
}

async function gitRestoreSelectedFile() {
  const filePath = gitPanel.selectedFile;
  if (!filePath) return toast('Select a changed file first', 'error');
  if (!confirm(`Restore ${filePath} to the index/HEAD version and discard working-tree changes?`)) return;
  try {
    await post('/api/workspace/git/restore', { workspace: app.workspace, path: filePath });
    const open = app.workbench.buffer(filePath);
    if (open) await openFile(filePath, { reload: true, switchToEditor: false });
    toast(`Restored ${filePath}`, 'success');
    await Promise.all([loadGitPanel(), loadGit()]);
  } catch (error) { toast(error.message, 'error'); }
}

function askAgentAboutGitDiff() {
  if (!gitPanel.selectedFile) return toast('Select a changed file first', 'error');
  const scope = gitPanel.selectedStaged ? 'staged changes' : 'working-tree changes';
  $('#composer').value = `Review the ${scope} in @${gitPanel.selectedFile}. Explain correctness risks, regressions, and the smallest safe improvements. Do not change anything until you identify the issues.`;
  switchView('chat');
  $('#composer').focus();
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

// ── Integrated xterm Terminal ───────────────────────────────────────────────
function integratedTerminalSessions() {
  return (app.terminals.sessions || []).filter((session) => !['rpc', 'desktop'].includes(session.backend || session.type));
}

function activeTerminalId(paneId = app.terminals.activePane) {
  return paneId === 'secondary' ? app.terminals.activeSecondary : app.terminals.activePrimary;
}

function terminalPaneHost(paneId) { return paneId === 'secondary' ? $('#xtermSecondary') : $('#xtermPrimary'); }

function activeTerminalInstance() { return app.terminals.instances.get(activeTerminalId()) || null; }

function xtermConstructor() { return globalThis.Terminal; }

function disposeTerminalInstance(id) {
  const instance = app.terminals.instances.get(id);
  if (!instance) return;
  try { instance.resizeObserver?.disconnect(); } catch { /* noop */ }
  try { instance.webgl?.dispose?.(); } catch { /* noop */ }
  try { instance.term?.dispose?.(); } catch { /* noop */ }
  app.terminals.instances.delete(id);
}

function mountTerminal(session, paneId = app.terminals.activePane) {
  if (!session?.id) return;
  const host = terminalPaneHost(paneId);
  if (!host) return;
  const previousId = activeTerminalId(paneId);
  if (previousId && previousId !== session.id) {
    const previous = app.terminals.instances.get(previousId);
    if (previous?.paneId === paneId) previous.paneId = null;
  }
  if (paneId === 'secondary') app.terminals.activeSecondary = session.id;
  else app.terminals.activePrimary = session.id;
  app.terminals.activePane = paneId;

  host.innerHTML = '';
  let instance = app.terminals.instances.get(session.id);
  if (!instance) {
    const TerminalCtor = xtermConstructor();
    if (!TerminalCtor) {
      host.textContent = 'xterm.js failed to load.';
      return;
    }
    const term = new TerminalCtor({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
      fontSize: 12,
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
      theme: { background: '#090b0f', foreground: '#d9e1ea', cursor: '#72d5c7', selectionBackground: '#264c55' }
    });
    const fit = globalThis.FitAddon?.FitAddon ? new globalThis.FitAddon.FitAddon() : null;
    const search = globalThis.SearchAddon?.SearchAddon ? new globalThis.SearchAddon.SearchAddon() : null;
    const links = globalThis.WebLinksAddon?.WebLinksAddon ? new globalThis.WebLinksAddon.WebLinksAddon() : null;
    if (fit) term.loadAddon(fit);
    if (search) term.loadAddon(search);
    if (links) term.loadAddon(links);
    instance = { id: session.id, term, fit, search, links, webgl: null, paneId };
    app.terminals.instances.set(session.id, instance);
    term.onData((data) => post('/api/terminal/input', { id: session.id, data }).catch((error) => toast(error.message, 'error')));
    term.onResize(({ cols, rows }) => post('/api/terminal/resize', { id: session.id, cols, rows }).catch(() => {}));
  }
  instance.paneId = paneId;
  instance.term.open(host);
  if (!instance.webgl && globalThis.WebglAddon?.WebglAddon) {
    try { instance.webgl = new globalThis.WebglAddon.WebglAddon(); instance.term.loadAddon(instance.webgl); } catch { instance.webgl = null; }
  }
  if (session.history && !instance.historyLoaded) { instance.term.write(session.history); instance.historyLoaded = true; }
  requestAnimationFrame(() => { try { instance.fit?.fit?.(); instance.term.focus(); } catch { /* noop */ } });
  installTerminalResizeObserver(instance, host);
  renderTerminalTabs();
  renderTerminalWorkspace();
}

function installTerminalResizeObserver(instance, host) {
  try { instance.resizeObserver?.disconnect(); } catch { /* noop */ }
  if (!globalThis.ResizeObserver || !host) return;
  instance.resizeObserver = new ResizeObserver(() => { try { instance.fit?.fit?.(); } catch { /* noop */ } });
  instance.resizeObserver.observe(host);
}

function renderTerminalTabs() {
  const host = $('#terminalTabs');
  if (!host) return;
  host.innerHTML = '';
  const activeId = activeTerminalId();
  for (const session of integratedTerminalSessions()) {
    const tab = document.createElement('button');
    tab.className = `terminal-tab ${session.id === activeId ? 'active' : ''}`;
    tab.innerHTML = `<span>${escapeHtml(session.name || 'Terminal')}</span><small>${escapeHtml(session.backend || '')}</small><span class="terminal-close">×</span>`;
    tab.onclick = (event) => {
      if (event.target.closest('.terminal-close')) { killTerminalSession(session.id); return; }
      mountTerminal(session, app.terminals.activePane);
    };
    host.append(tab);
  }
}

function renderTerminalWorkspace() {
  const host = $('#terminalWorkspace');
  if (!host) return;
  host.classList.remove('split-none', 'split-vertical', 'split-horizontal');
  host.classList.add(`split-${app.terminals.split}`);
  const secondary = $('[data-terminal-pane="secondary"]');
  const divider = $('#terminalSplitDivider');
  secondary?.classList.toggle('hidden', app.terminals.split === 'none');
  divider?.classList.toggle('hidden', app.terminals.split === 'none');
  $$('[data-terminal-pane]').forEach((pane) => pane.classList.toggle('active', pane.dataset.terminalPane === app.terminals.activePane));
  const session = app.terminals.sessions.find((item) => item.id === activeTerminalId());
  const hasActiveTerminal = Boolean(session);
  if ($('#newIntegratedTerminal')) $('#newIntegratedTerminal').disabled = !app.workspace;
  if ($('#splitTerminal')) $('#splitTerminal').disabled = !hasActiveTerminal;
  if ($('#closeTerminalSplit')) $('#closeTerminalSplit').disabled = app.terminals.split === 'none';
  if ($('#killIntegratedTerminal')) $('#killIntegratedTerminal').disabled = !hasActiveTerminal;
  if ($('#terminalSearchInput')) $('#terminalSearchInput').disabled = !hasActiveTerminal;
  if ($('#terminalSearchPrev')) $('#terminalSearchPrev').disabled = !hasActiveTerminal;
  if ($('#terminalSearchNext')) $('#terminalSearchNext').disabled = !hasActiveTerminal;
  if ($('#launchDesktopTerminal')) $('#launchDesktopTerminal').disabled = !app.workspace;
  if ($('#terminalActiveInfo')) $('#terminalActiveInfo').textContent = session ? `${session.name} · PID ${session.pid || '—'} · ${session.backend}` : 'No integrated terminal';
}

async function loadTerminalSessions({ preserveSelection = true } = {}) {
  const host = $('#terminalSessionsList');
  const context = captureWorkspaceContext();
  try {
    const [value, caps] = await Promise.all([api(`/api/terminal/sessions?workspace=${enc(context.workspace)}`), api('/api/terminal/capabilities').catch(() => ({ capabilities: null }))]);
    if (!workspaceContextIsCurrent(context)) return;
    app.terminals.sessions = value.sessions || [];
    app.terminals.capabilities = caps.capabilities || null;
    if ($('#terminalBackendStatus')) $('#terminalBackendStatus').textContent = app.terminals.capabilities?.pty ? 'Terminal backend: PTY / ConPTY' : 'Terminal backend: pipe fallback (install node-pty for full PTY)';
    if (host) {
      host.innerHTML = '';
      for (const session of app.terminals.sessions) {
        const card = document.createElement('div'); card.className = 'terminal-card';
        const isRpc = session.type === 'rpc' || session.backend === 'rpc';
        card.innerHTML = `<div class="terminal-card-info"><strong>${escapeHtml(session.name || 'Terminal')} <span class="terminal-badge ${isRpc ? 'rpc' : ''}">${escapeHtml(session.backend || session.type || 'term')}</span></strong><span>PID: ${session.pid || '—'} · ${escapeHtml(session.workspace || '')}</span></div><div class="button-row" style="margin:0;gap:4px;">${!isRpc ? `<button class="sm-btn danger ghost" data-kill="${escapeHtml(session.id)}">Kill</button>` : '<span class="muted" style="font-size:11px;">Active Engine</span>'}</div>`;
        $('[data-kill]', card)?.addEventListener('click', () => killTerminalSession(session.id));
        host.append(card);
      }
      if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No active sessions.</div>';
    }
    const integrated = integratedTerminalSessions();
    if ((!preserveSelection || !app.terminals.sessions.some((s) => s.id === app.terminals.activePrimary)) && integrated[0]) app.terminals.activePrimary = integrated[0].id;
    renderTerminalTabs(); renderTerminalWorkspace();
  } catch (e) {
    if (host) host.innerHTML = `<div class="empty-state error-text">${escapeHtml(e.message)}</div>`;
  }
}

async function newIntegratedTerminal(paneId = app.terminals.activePane, { name = null, command = null } = {}) {
  if (!app.workspace) return toast('Open a workspace first', 'error');
  const host = terminalPaneHost(paneId);
  const rect = host?.getBoundingClientRect?.();
  const cols = Math.max(40, Math.floor((rect?.width || 900) / 8));
  const rows = Math.max(10, Math.floor((rect?.height || 420) / 18));
  try {
    const value = await post('/api/terminal/create', { workspace: app.workspace, name: name || undefined, cols, rows });
    await loadTerminalSessions({ preserveSelection: true });
    const session = value.session;
    const existing = app.terminals.sessions.find((item) => item.id === session.id) || session;
    mountTerminal(existing, paneId);
    if (command) setTimeout(() => sendTerminalCommand(command, session.id), 120);
    return session;
  } catch (e) { toast(e.message, 'error'); return null; }
}

async function launchTerminalSession(attachPi = false) {
  try {
    const sessionFile = attachPi ? (app.pi.state?.sessionFile || null) : null;
    const model = attachPi ? (app.pi.status?.modelId || getSelectedModelId() || null) : null;
    await post('/api/terminal/launch', { workspace: app.workspace || $('#workspacePath').value, attachPi, model, sessionFile });
    toast('Native terminal window opened', 'success'); await loadTerminalSessions();
  } catch (e) { toast(e.message, 'error'); }
}

async function killTerminalSession(id = activeTerminalId()) {
  if (!id) return;
  try {
    await post('/api/terminal/kill', { id });
    disposeTerminalInstance(id);
    if (app.terminals.activePrimary === id) app.terminals.activePrimary = null;
    if (app.terminals.activeSecondary === id) app.terminals.activeSecondary = null;
    await loadTerminalSessions({ preserveSelection: false });
    const next = integratedTerminalSessions()[0];
    if (next) mountTerminal(next, 'primary');
    toast('Terminal process killed', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function sendTerminalCommand(command, id = activeTerminalId()) {
  if (!id || !String(command || '').trim()) return;
  post('/api/terminal/input', { id, data: `${String(command).trim()}\r` }).catch((error) => toast(error.message, 'error'));
}

async function splitIntegratedTerminal() {
  if (app.terminals.split === 'none') app.terminals.split = 'vertical';
  app.terminals.activePane = 'secondary'; renderTerminalWorkspace();
  if (!app.terminals.activeSecondary) await newIntegratedTerminal('secondary');
  else {
    const session = app.terminals.sessions.find((item) => item.id === app.terminals.activeSecondary);
    if (session) mountTerminal(session, 'secondary');
  }
}

function closeTerminalSplit() {
  app.terminals.split = 'none'; app.terminals.activePane = 'primary'; renderTerminalWorkspace();
  requestAnimationFrame(() => { try { activeTerminalInstance()?.fit?.fit?.(); } catch { /* noop */ } });
}

function installTerminalSplitDragging() {
  const divider = $('#terminalSplitDivider');
  const host = $('#terminalWorkspace');
  if (!divider || !host) return;
  divider.addEventListener('pointerdown', (event) => {
    if (app.terminals.split === 'none') return;
    event.preventDefault();
    divider.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const rect = host.getBoundingClientRect?.();
      if (!rect) return;
      const raw = app.terminals.split === 'vertical'
        ? ((moveEvent.clientX - rect.left) / rect.width) * 100
        : ((moveEvent.clientY - rect.top) / rect.height) * 100;
      host.style.setProperty('--terminal-split-size', `${Math.max(20, Math.min(80, raw))}%`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      requestAnimationFrame(() => {
        for (const id of [app.terminals.activePrimary, app.terminals.activeSecondary]) {
          try { app.terminals.instances.get(id)?.fit?.fit?.(); } catch { /* noop */ }
        }
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
}

function terminalSearch(direction = 1) {
  const query = $('#terminalSearchInput')?.value || '';
  const instance = activeTerminalInstance();
  if (!instance?.search || !query) return;
  direction < 0 ? instance.search.findPrevious(query) : instance.search.findNext(query);
}

function installTerminalPaneInteractions() {
  $$('[data-terminal-pane]').forEach((pane) => pane.addEventListener('pointerdown', () => { app.terminals.activePane = pane.dataset.terminalPane; renderTerminalWorkspace(); }));
}

async function executeWebConsoleCommand() {
  const input = $('#webConsoleInput'); const output = $('#webConsoleOutput'); const command = input.value.trim();
  if (!command) return;
  if (!app.pi.status?.running) return toast('Start Pi first to run Pi Bash commands', 'error');
  const btn = $('#runWebConsole'); setBusy(btn, true, 'Executing…'); output.textContent += `\n\n$ ${command}\n`;
  try {
    const id = `web-console-${Date.now()}`; const response = await rpc({ id, type: 'bash', command });
    const resultText = response.data?.output ?? JSON.stringify(response.data, null, 2); output.textContent += resultText;
    setProblemsForSource('Console', parseTextDiagnostics(resultText, { source: 'Console' })); input.value = ''; output.scrollTop = output.scrollHeight;
  } catch (e) { output.textContent += `Error: ${e.message}`; toast(e.message, 'error'); } finally { setBusy(btn, false); }
}

// ── Test Explorer / Run Configurations ──────────────────────────────────────
async function discoverTestsUi() {
  if (!app.workspace) return;
  const context = captureWorkspaceContext();
  try {
    const [testsValue, configsValue] = await Promise.all([
      api(`/api/tests/discover?workspace=${enc(context.workspace)}`),
      api(`/api/run-configurations?workspace=${enc(context.workspace)}`)
    ]);
    if (!workspaceContextIsCurrent(context)) return;
    app.tests.discovery = testsValue.discovery;
    app.tests.runConfigurations = configsValue.configurations || [];
    renderTestsUi();
  } catch (error) { if (workspaceContextIsCurrent(context)) toast(error.message, 'error'); }
}

function renderTestsUi() {
  const discovery = app.tests.discovery;
  const list = $('#testExplorerList'); const configs = $('#runConfigurationsList');
  const canRunAll = Boolean(discovery && ((discovery.tests || []).length || discovery.defaults?.testScript || discovery.defaults?.python));
  if ($('#runAllTests')) $('#runAllTests').disabled = !canRunAll;
  if ($('#rerunTests')) $('#rerunTests').disabled = !app.tests.lastResult;
  if ($('#testAskPi')) $('#testAskPi').disabled = !app.tests.lastResult || app.tests.lastResult.passed !== false;
  if (list) {
    list.innerHTML = '';
    for (const test of discovery?.tests || []) {
      const status = app.tests.statusByPath.get(test.path) || '';
      const item = document.createElement('div'); item.className = `test-item ${status}`;
      item.innerHTML = `<div class="test-item-main"><strong>${escapeHtml(test.name)}</strong><span>${escapeHtml(test.path)} · ${escapeHtml(test.framework)}${test.cases?.length ? ` · ${test.cases.length} cases` : ''}</span></div><button class="sm-btn" aria-label="Run ${escapeHtml(test.name)}">▶</button>`;
      $('button', item).onclick = () => runTestsUi(test.path); list.append(item);
      for (const testCase of test.cases || []) {
        const caseKey = `${test.path}::${testCase.name}`;
        const caseStatus = app.tests.statusByPath.get(caseKey) || '';
        const child = document.createElement('div'); child.className = `test-case-item ${caseStatus}`;
        child.innerHTML = `<div class="test-case-main"><span class="test-case-dot">•</span><span>${escapeHtml(testCase.name)}</span><small>line ${Number(testCase.line || 1)}</small></div><button class="sm-btn ghost" aria-label="Run ${escapeHtml(testCase.name)}">▶</button>`;
        $('button', child).onclick = () => runTestsUi(test.path, testCase.name); list.append(child);
      }
    }
    if (!list.childElementCount) list.innerHTML = '<div class="empty-state">No test files discovered.</div>';
  }
  if (configs) {
    configs.innerHTML = '';
    for (const config of app.tests.runConfigurations || []) {
      const item = document.createElement('div'); item.className = 'run-config-item';
      item.innerHTML = `<div><strong>${escapeHtml(config.name)}</strong><span>${escapeHtml(config.command)}</span></div><button class="sm-btn" aria-label="Run configuration ${escapeHtml(config.name)}">▶</button>`;
      $('button', item).onclick = () => runConfigurationUi(config); configs.append(item);
    }
    if (!configs.childElementCount) configs.innerHTML = '<div class="empty-state">No run configurations detected.</div>';
  }
  if ($('#testsSummary')) $('#testsSummary').textContent = discovery ? `${discovery.tests.length} test files · ${(app.tests.runConfigurations || []).length} run configs` : 'No tests discovered';
}

async function runTestsUi(target = null, testName = '') {
  if (!app.workspace) return toast('Open a workspace first', 'error');
  if (!target) {
    const discovery = app.tests.discovery;
    const canRunAll = Boolean(discovery && ((discovery.tests || []).length || discovery.defaults?.testScript || discovery.defaults?.python));
    if (!canRunAll) return toast('No runnable test suite was detected in this project', 'error');
  }
  const context = captureWorkspaceContext();
  const output = $('#testOutput'); const title = $('#testOutputTitle');
  const statusKey = target ? (testName ? `${target}::${testName}` : target) : '';
  if (statusKey) app.tests.statusByPath.set(statusKey, 'running');
  renderTestsUi();
  if (title) title.textContent = target ? `Running ${target}${testName ? ` :: ${testName}` : ''}` : 'Running all tests';
  if (output) output.textContent = 'Running…';
  try {
    const value = await post('/api/tests/run', { workspace: context.workspace, target, testName, mode: target ? 'file' : 'all', timeoutMs: 180000 });
    if (!workspaceContextIsCurrent(context)) return;
    app.tests.lastResult = value.result; app.tests.lastTarget = target; app.tests.lastTestName = testName;
    if (statusKey) app.tests.statusByPath.set(statusKey, value.result.passed ? 'pass' : 'fail');
    if ($('#testStatusBadge')) { $('#testStatusBadge').textContent = value.result.passed ? '✓' : '✗'; $('#testStatusBadge').className = value.result.passed ? 'pass' : 'fail'; }
    if (title) title.textContent = `${value.result.passed ? 'PASS' : 'FAIL'} · ${value.result.label} · ${(value.result.durationMs / 1000).toFixed(1)}s`;
    if (output) output.textContent = value.result.output || '(no output)';
    setProblemsForSource('Tests', parseTextDiagnostics(value.result.output || '', { source: 'Tests' }));
    toast(value.result.passed ? 'Tests passed' : 'Tests failed', value.result.passed ? 'success' : 'error');
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    if (statusKey) app.tests.statusByPath.set(statusKey, 'fail');
    if (output) output.textContent = error.message; toast(error.message, 'error');
  } finally { if (workspaceContextIsCurrent(context)) renderTestsUi(); }
}

async function runConfigurationUi(config) {
  switchView('terminal');
  const session = await newIntegratedTerminal('primary', { name: config.name, command: config.command });
  if (session) toast(`Started ${config.name}`, 'success');
}

function askPiAboutTestFailure() {
  const result = app.tests.lastResult;
  if (!result) return toast('Run tests first', 'error');
  const target = app.tests.lastTarget ? ` for ${app.tests.lastTarget}` : '';
  $('#composer').value = `The test run${target} failed. Diagnose the failure from this output, inspect the relevant files, implement the smallest correct fix, then rerun the tests until they pass.\n\n${truncate(result.output || '', 12000)}`;
  switchView('chat'); $('#composer').focus();
}

function renderAttachments() {
  const host = $('#attachments'); host.innerHTML = '';
  app.attachments.forEach((item, index) => { const node = document.createElement('div'); node.className = 'attachment'; node.innerHTML = `<span>${escapeHtml(item.name)}</span><button aria-label="Remove attachment ${escapeHtml(item.name)}">×</button>`; $('button', node).onclick = () => { app.attachments.splice(index, 1); renderAttachments(); }; host.append(node); });
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
  const context = captureWorkspaceContext();
  app.statusRefreshInFlight = true;
  try {
    const value = await api('/api/status');
    if (workspaceContextIsCurrent(context) && piPayloadBelongsToWorkspace(value.pi?.status, context.workspace)) applyPiSnapshot(value.pi);
    if (value.ollama) {
      const previousRuntime = String(app.ollama?.runtime?.baseUrl || '').replace(/\/+$/, '');
      const nextRuntime = String(value.ollama?.runtime?.baseUrl || '').replace(/\/+$/, '');
      const sameRuntime = Boolean(previousRuntime && nextRuntime && previousRuntime === nextRuntime);
      if (sameRuntime && (!value.ollama.models || !value.ollama.models.length) && app.ollama.models?.length && value.ollama.modelsAvailable === false) {
        value.ollama.models = app.ollama.models;
      }
      app.ollama = value.ollama;
    }
    if (value.managedOllama) app.managedOllama = value.managedOllama;
    app.system = value.system;
    renderPiSnapshot(); refreshModelSelectors(); renderSystem(); renderHealth(); renderOllamaRuntimeStatus(); renderOllamaInventorySummary();
  } catch (error) {
    log('STATUS', error.message);
  } finally {
    app.statusRefreshInFlight = false;
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  let lastErrorAt = 0;
  source.addEventListener('pi_event', (e) => { const value = JSON.parse(e.data); if (!value._studioWorkspace || workspacePathsEquivalent(value._studioWorkspace, app.workspace)) handlePiEvent(value); });
  source.addEventListener('pi_snapshot', (e) => { const value = JSON.parse(e.data); if (!piPayloadBelongsToWorkspace(value.status, app.workspace)) return; applyPiSnapshot(value); renderPiSnapshot(); });
  source.addEventListener('pi_status', (e) => { const value = JSON.parse(e.data); if (!piPayloadBelongsToWorkspace(value, app.workspace)) return; app.pi.status = value; renderPiSnapshot(); });
  source.addEventListener('pi_stderr', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return;
    const text = payload.text || '';
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
  source.addEventListener('preview_changed', (e) => {
    const value = JSON.parse(e.data);
    if (value.workspace && !workspacePathsEquivalent(value.workspace, app.workspace)) return;
    if (value.preview) previewPanel?.updatePreview?.(value.preview);
    else previewPanel?.refresh?.().catch(() => {});
  });
  source.addEventListener('ollama_models_changed', (e) => {
    const raw = JSON.parse(e.data);
    app.ollama = { models: [], running: [], ...(raw || {}) };
    refreshModelSelectors();
    renderHealth();
  });
  source.addEventListener('ollama_managed_status', (e) => {
    app.managedOllama = JSON.parse(e.data);
    renderOllamaRuntimeStatus();
  });
  source.addEventListener('ollama_log', (e) => log('OLLAMA', JSON.parse(e.data).text));
  source.addEventListener('terminal_data', (e) => {
    const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; const instance = app.terminals.instances.get(payload.id);
    if (instance) instance.term.write(payload.data || '');
  });
  source.addEventListener('terminal_exit', (e) => {
    const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; const instance = app.terminals.instances.get(payload.id);
    if (instance) instance.term.writeln(`\r\n[process exited${payload.exitCode !== null ? ` ${payload.exitCode}` : ''}]`);
    loadTerminalSessions().catch(() => {});
  });
  source.addEventListener('terminal_created', () => loadTerminalSessions().catch(() => {}));
  source.addEventListener('terminal_removed', () => loadTerminalSessions().catch(() => {}));
  source.addEventListener('test_result', (e) => { const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; log('TEST', payload.result?.label || payload); });
  source.addEventListener('pi_platform_changed', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return;
    if (app.pi.status?.running && !app.pi.resourceRestartRequired) markPiResourceChange(payload.reason || payload.action || 'Pi resources changed in another Studio tab');
    if ($('.view-tabs button.active')?.dataset.view === 'resources') loadPiPlatform({ quiet: true }).catch(() => {});
  });
  source.addEventListener('providers_changed', async () => { try { const value = await api('/api/providers'); app.providers = value.providers || []; refreshModelSelectors(); } catch {} });
  source.addEventListener('mcp_changed', async () => { try { const value = await api('/api/mcp'); app.mcp = { servers:value.servers || [], logs:value.logs || [] }; } catch {} });
  source.addEventListener('harnesses_changed', async (e) => { const payload = JSON.parse(e.data); if (payload.workspace && app.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; await loadHarnesses({ quiet: true }); });
  source.addEventListener('workspace_file_changed', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return;
    if (payload.source !== 'editor') refreshOpenFilesFromDisk({ reason: payload.source || 'external-event' }).catch(() => {});
  });
  source.addEventListener('lsp_diagnostics', (e) => { const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; app.lsp?.applyDiagnostics?.(payload); if (!app.lsp) setProblemsForSource(`LSP:${payload.serverId || 'server'}:${payload.path || ''}`, lspProblemRecords(payload)); });
  source.addEventListener('lsp_status', (e) => { const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; renderLspStatus(payload.servers || []); });
  source.addEventListener('lsp_log', (e) => { const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; log(`LSP ${payload.serverId || ''}`.trim(), payload.text || payload); });
  source.addEventListener('lsp_protocol_error', (e) => { const payload = JSON.parse(e.data); if (payload.workspace && !workspacePathsEquivalent(payload.workspace, app.workspace)) return; log('LSP PROTOCOL', payload); addProblem({ title: `${payload.serverId || 'Language server'} protocol error`, detail: payload.error || JSON.stringify(payload), source: 'LSP', severity: 'error' }); });
  source.addEventListener('server_error', (e) => {
    const value = JSON.parse(e.data);
    if (value.workspace && !workspacePathsEquivalent(value.workspace, app.workspace)) return;
    createMessage('error', `⚠️ **Server Error (${value.source || 'system'}):** ${value.error}`);
    toast(`${value.source}: ${value.error}`, 'error');
    log('SERVER ERROR', value);
  });
  source.onerror = () => {
    if (Date.now() - lastErrorAt > 10000) log('EVENTS', 'Connection interrupted; browser will reconnect.');
    lastErrorAt = Date.now();
  };
}



function problemRecord(problem = {}) {
  const normalized = normalizeDiagnostic({
    ...problem,
    message: problem.message || problem.detail || problem.title || 'Agent problem',
    source: problem.source || 'agent',
    severity: problem.severity || 'error'
  });
  return {
    ...normalized,
    id: problem.id || normalized.id || `problem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: problem.title || normalized.message.split('\n')[0].slice(0, 160),
    detail: String(problem.detail || normalized.message || ''),
    at: problem.at || new Date().toISOString(),
    toolCallId: problem.toolCallId || null
  };
}

function addProblem(problem) {
  const item = problemRecord(problem);
  app.problems.unshift(item);
  if (app.problems.length > 300) app.problems.length = 300;
  app.currentProblemIndex = 0;
  renderProblems();
  return item;
}

function setProblemsForSource(source, diagnostics = []) {
  const sourceName = String(source || 'diagnostic');
  const preserved = app.problems.filter((problem) => problem.source !== sourceName);
  const next = diagnostics.map((item) => problemRecord({ ...item, source: sourceName, title: item.message || item.title }));
  app.problems = mergeDiagnostics(...[...next, ...preserved]).map((item) => problemRecord(item));
  app.currentProblemIndex = Math.min(Math.max(0, app.currentProblemIndex), Math.max(0, visibleProblems().length - 1));
  renderProblems();
}

function visibleProblems() {
  const filter = app.problemSeverityFilter || 'all';
  return filter === 'all' ? app.problems : app.problems.filter((problem) => problem.severity === filter);
}

function renderProblems() {
  const host = $('#problemsList');
  const visible = visibleProblems();
  const badge = $('#problemCountBadge');
  if (badge) badge.textContent = app.problems.length ? String(app.problems.length) : '';
  if (!host) return;
  host.innerHTML = '';
  host.classList.toggle('empty-state', !visible.length);
  if (!visible.length) {
    host.textContent = app.problems.length ? 'No problems match the current severity filter.' : 'No problems recorded.';
    return;
  }
  app.currentProblemIndex = Math.min(Math.max(0, app.currentProblemIndex), visible.length - 1);
  visible.forEach((problem, index) => {
    const row = document.createElement('div');
    row.className = `problem-row severity-${problem.severity || 'error'} ${index === app.currentProblemIndex ? 'selected' : ''}`;
    row.dataset.problemId = problem.id;
    const icon = problem.severity === 'warning' ? '▲' : problem.severity === 'info' || problem.severity === 'hint' ? 'i' : '!';
    const location = problem.path ? `${problem.path}:${problem.line || 1}:${problem.column || 1}` : '';
    row.innerHTML = `<div class="problem-icon">${icon}</div><div class="problem-main"><strong>${escapeHtml(problem.title)}</strong>${location ? `<span class="problem-location">${escapeHtml(location)}</span>` : ''}<pre>${escapeHtml(problem.detail)}</pre></div><div class="problem-meta">${escapeHtml(problem.source)}<br>${escapeHtml(formatTime(problem.at))}<button class="sm-btn ghost problem-ask-agent">Ask Agent</button></div>`;
    $('.problem-ask-agent', row)?.addEventListener('click', (event) => {
      event.stopPropagation();
      const at = problem.path ? ` in @${problem.path} at ${problem.line || 1}:${problem.column || 1}` : '';
      $('#composer').value = `Investigate this ${problem.severity || 'error'}${at}: ${problem.title}. Explain the root cause and make the smallest safe fix, then run the most relevant test.`;
      switchView('chat'); $('#composer').focus();
    });
    row.onclick = async () => {
      app.currentProblemIndex = index;
      renderProblems();
      if (problem.path) await openFile(problem.path, { reveal: { line: problem.line, column: problem.column } });
    };
    host.append(row);
  });
  host.children[app.currentProblemIndex]?.scrollIntoView?.({ block: 'nearest' });
}

function moveProblem(delta) {
  const visible = visibleProblems();
  if (!visible.length) return;
  const start = app.currentProblemIndex < 0 ? 0 : app.currentProblemIndex;
  app.currentProblemIndex = (start + delta + visible.length) % visible.length;
  switchView('problems');
  renderProblems();
  const problem = visible[app.currentProblemIndex];
  if (problem?.path) openFile(problem.path, { reveal: { line: problem.line, column: problem.column } });
}

function clearProblems() {
  app.problems = [];
  app.currentProblemIndex = -1;
  renderProblems();
}

// ── Unified Command + Keyboard Interaction Layer ──────────────────────────────
// Buttons, the command palette, leader keys and Vim mode all execute the same
// semantic commands. Standard mouse interaction remains fully available.
const commandRegistry = new CommandRegistry();

async function executeAppCommand(id, ...args) {
  const command = commandRegistry.get(id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  const result = await commandRegistry.execute(id, { app }, ...args);
  if (result !== false && command.recordable !== false) app.macros.record(id, args);
  if (result !== false && command.repeatable) app.interaction.lastRepeatable = { id, args: JSON.parse(JSON.stringify(args || [])) };
  return result;
}

async function repeatLastSemanticAction() {
  const last = app.interaction.lastRepeatable;
  if (!last) return toast('No repeatable action yet', '');
  await executeAppCommand(last.id, ...(last.args || []));
}

let paletteItems = [];
let paletteIndex = 0;
let paletteKind = 'all';
let paletteCustomItems = [];
let leaderTimer = null;
let vimPrefix = '';
let vimPrefixTimer = null;
let vimWindowPending = false;

const LEADER_BINDINGS = [
  { keys: 'ff', label: 'Find file', command: 'palette.files', group: 'Files' },
  { keys: 'fg', label: 'Search workspace text', command: 'workspace.search', group: 'Files' },
  { keys: 'fn', label: 'Next open buffer', command: 'editor.nextBuffer', group: 'Files' },
  { keys: 'fp', label: 'Previous open buffer', command: 'editor.previousBuffer', group: 'Files' },
  { keys: 'fc', label: 'Close active buffer', command: 'editor.closeBuffer', group: 'Files' },
  { keys: 'wv', label: 'Split editor vertically', command: 'editor.splitVertical', group: 'Windows' },
  { keys: 'ws', label: 'Split editor horizontally', command: 'editor.splitHorizontal', group: 'Windows' },
  { keys: 'wq', label: 'Close editor split', command: 'editor.closeSplit', group: 'Windows' },
  { keys: 'wr', label: 'Show registers / macros', command: 'ui.powerState', group: 'Windows' },
  { keys: 'ss', label: 'Find session', command: 'palette.sessions', group: 'Sessions' },
  { keys: 'st', label: 'Session tree', command: 'view.tree', group: 'Sessions' },
  { keys: 'sc', label: 'Clone session', command: 'session.cloneCurrent', group: 'Sessions' },
  { keys: 'pm', label: 'Project manager', command: 'project.manager.open', group: 'Workspace' },
  { keys: 'pn', label: 'New project', command: 'project.new', group: 'Workspace' },
  { keys: 'po', label: 'Open project folder', command: 'project.openFolder', group: 'Workspace' },
  { keys: 'hn', label: 'New harness', command: 'harness.new', group: 'Harness' },
  { keys: 'he', label: 'Save effective harness', command: 'harness.saveEffective', group: 'Harness' },
  { keys: 'ac', label: 'Compact context', command: 'agent.compact', group: 'Agent' },
  { keys: 'aa', label: 'Abort agent', command: 'agent.abort', group: 'Agent' },
  { keys: 'af', label: 'Focus prompt', command: 'chat.focusComposer', group: 'Agent' },
  { keys: 'gs', label: 'Git status', command: 'view.git', group: 'Git' },
  { keys: 'gn', label: 'Next diff change', command: 'git.diffNext', group: 'Git' },
  { keys: 'gp', label: 'Previous diff change', command: 'git.diffPrevious', group: 'Git' },
  { keys: 'qq', label: 'Problems / quickfix', command: 'view.problems', group: 'Problems' },
  { keys: 'ca', label: 'Code actions / quick fix', command: 'editor.codeAction', group: 'Code' },
  { keys: 'rn', label: 'Rename symbol', command: 'editor.rename', group: 'Code' },
  { keys: 'cf', label: 'Format document', command: 'editor.format', group: 'Code' },
  { keys: 'ci', label: 'Go to implementation', command: 'editor.goToImplementation', group: 'Code' },
  { keys: 'cs', label: 'Document symbols', command: 'editor.documentSymbols', group: 'Code' },
  { keys: 'cw', label: 'Workspace symbols', command: 'editor.workspaceSymbols', group: 'Code' },
  { keys: 'lr', label: 'Restart language servers', command: 'lsp.restart', group: 'Code' },
  { keys: 'gc', label: 'Create checkpoint', command: 'git.checkpoint', group: 'Git' },
  { keys: 'mm', label: 'Select model', command: 'palette.models', group: 'Models' },
  { keys: 'tt', label: 'Terminal', command: 'view.terminal', group: 'Tools' },
  { keys: 'tr', label: 'Pi resources', command: 'view.resources', group: 'Tools' },
  { keys: 'pp', label: 'Command palette', command: 'palette.open', group: 'Navigate' },
  { keys: 'ww', label: 'Workspace path', command: 'workspace.focus', group: 'Navigate' },
  { keys: '??', label: 'Keyboard help', command: 'ui.keymapHelp', group: 'Help' }
];

function interactionStorage() {
  try {
    return JSON.parse(localStorage.getItem('studio_interaction') || '{}');
  } catch { return {}; }
}

function persistInteraction() {
  try {
    localStorage.setItem('studio_interaction', JSON.stringify({
      mode: app.interaction.mode,
      leaderHints: $('#leaderHints')?.checked !== false,
      autoGitCheckpoints: $('#autoGitCheckpoints')?.checked !== false,
      showModeBadge: $('#showModeBadge')?.checked !== false
    }));
  } catch { /* storage unavailable */ }
}

function setVimMode(mode = 'normal') {
  app.interaction.vimMode = mode === 'insert' ? 'insert' : 'normal';
  document.body.dataset.vimMode = app.interaction.vimMode;
  const badge = $('#interactionModeBadge');
  if (badge && app.interaction.mode === 'vim') {
    badge.textContent = app.interaction.vimMode === 'insert' ? 'Vim · Insert' : 'Vim · Normal';
    badge.classList.toggle('vim-insert', app.interaction.vimMode === 'insert');
  }
}

function setInteractionMode(mode, { persist = true } = {}) {
  const normalized = ['standard', 'keyboard', 'vim'].includes(mode) ? mode : 'standard';
  app.interaction.mode = normalized;
  document.body.dataset.interactionMode = normalized;
  const select = $('#interactionMode');
  if (select) select.value = normalized;
  const badge = $('#interactionModeBadge');
  if (badge) {
    badge.dataset.mode = normalized;
    badge.classList.remove('vim-insert');
    badge.textContent = normalized === 'keyboard' ? 'Keyboard' : normalized === 'vim' ? 'Vim · Normal' : 'Standard';
    badge.classList.toggle('hidden', $('#showModeBadge')?.checked === false);
  }
  if (normalized === 'vim') setVimMode('normal');
  else {
    document.body.dataset.vimMode = '';
    clearKeyboardSelection();
  }
  if (persist) persistInteraction();
}

function activeViewName() {
  return $('.view-tabs button.active')?.dataset?.view || 'chat';
}

function clearKeyboardSelection() {
  $$('.keyboard-selected').forEach((node) => node.classList.remove('keyboard-selected'));
  app.interaction.selectedIndex = -1;
}

function navigableItems() {
  const view = activeViewName();
  if (view === 'chat') return $$('#messages .message');
  if (view === 'tree') return $$('#sessionTree .session-tree-card, #sessionTree .tree-chip-compact');
  if (view === 'git') return $$('#gitFileList .git-file-row');
  if (view === 'problems') return $$('#problemsList .problem-row');
  if (view === 'terminal') return $$('#terminalSessionsList .terminal-card');
  return [];
}

function selectKeyboardItem(index, { center = false } = {}) {
  const items = navigableItems();
  if (!items.length) return null;
  const next = Math.max(0, Math.min(items.length - 1, index));
  items.forEach((item) => item.classList.remove('keyboard-selected'));
  const item = items[next];
  item.classList.add('keyboard-selected');
  app.interaction.selectedIndex = next;
  item.scrollIntoView?.({ block: center ? 'center' : 'nearest', behavior: 'smooth' });
  return item;
}

function moveKeyboardSelection(delta) {
  const items = navigableItems();
  if (!items.length) return;
  let index = app.interaction.selectedIndex;
  if (index < 0) index = delta > 0 ? -1 : items.length;
  selectKeyboardItem(index + delta);
}

function selectedKeyboardItem() {
  return $('.keyboard-selected') || selectKeyboardItem(0);
}

function enterVimInsertMode() {
  if (app.interaction.mode !== 'vim') return;
  setVimMode('insert');
  const view = activeViewName();
  if (view === 'editor' && app.monacoAvailable && app.monaco?.ready) { app.monaco.focus(app.workbench.activePane); return; }
  const target = view === 'editor' ? paneDom(app.workbench.activePane).editor
    : view === 'tree' ? $('#treeSearchInput')
    : view === 'terminal' ? $('#webConsoleInput')
    : $('#composer');
  target?.focus?.();
}

function exitVimInsertMode() {
  if (app.interaction.mode !== 'vim') return;
  document.activeElement?.blur?.();
  setVimMode('normal');
}

function buildPaletteItems(kind = 'all') {
  const ctx = { app };
  const commands = commandRegistry.list(ctx).map((command) => ({ ...command, itemType: 'command' }));
  const files = (app.workspaceFiles || []).map((filePath) => ({
    id: `file:${filePath}`, title: filePath.split(/[\\/]/).pop(), category: 'File', keywords: [filePath], shortcut: '',
    execute: () => openFile(filePath), itemType: 'file', subtitle: filePath
  }));
  const sessions = (app.sessions || []).map((session) => ({
    id: `session:${session.path}`, title: session.name || session.fileName, category: 'Session', keywords: [session.path, session.fileName],
    execute: () => app.pi.status?.running ? startPi(session.path, session.name || '') : inspectSessionTree(session.path), itemType: 'session', subtitle: session.modifiedAt ? formatTime(session.modifiedAt) : ''
  }));
  const platformResources = [];
  const snapshot = app.platform?.snapshot;
  if (snapshot && piPlatformPanel) {
    for (const tab of ['instructions','skills','prompts','extensions','packages','settings']) {
      for (const item of piPlatformPanel.items(tab) || []) {
        const title = piPlatformPanel.resourceTitle(item);
        platformResources.push({
          id: `resource:${tab}:${item.scope || ''}:${title}`, title, category: `Pi ${tab}`,
          keywords: [item.description || '', item.path || '', item.source || '', item.scope || ''], subtitle: `${item.scope || ''}${item.description ? ` · ${item.description}` : ''}`,
          itemType: 'resource', execute: () => { switchView('resources'); app.platform.tab = tab; piPlatformPanel.renderTab(); piPlatformPanel.selectItem(item); }
        });
      }
    }
  }
  const providerItems = (app.providers || []).flatMap((provider) => [
    { id:`provider:${provider.id}`, title:provider.name || provider.id, category:'Provider', keywords:[provider.baseUrl || '', provider.id], subtitle:provider.baseUrl || '', itemType:'provider', execute:()=>{ switchSettings('providers'); document.querySelector(`[data-provider-id="${CSS.escape(provider.id)}"]`)?.click?.(); } },
    ...(provider.models || []).map((model)=>({ id:`provider-model:${provider.id}:${model.id}`, title:model.name || model.id, category:`Provider · ${provider.name || provider.id}`, keywords:[provider.id,model.id], subtitle:model.id, itemType:'providerModel', execute:()=>chooseModel(model.id,{ provider:provider.id }) }))
  ]);
  const mcpItems = (app.mcp?.servers || []).flatMap((server) => [
    { id:`mcp:${server.id}`, title:server.name || server.id, category:'MCP Server', keywords:[server.id,server.status || ''], subtitle:`${server.status || 'disconnected'} · ${(server.tools || []).length} tools`, itemType:'mcp', execute:()=>{switchSettings('mcp');document.querySelector(`[data-mcp-server="${CSS.escape(server.id)}"]`)?.click?.();}},
    ...(server.tools || []).map((tool)=>({id:`mcp-tool:${server.id}:${tool.name}`,title:tool.name,category:`MCP Tool · ${server.name || server.id}`,keywords:[tool.description || '',server.id],subtitle:tool.description || '',itemType:'mcpTool',execute:()=>{switchSettings('mcp');document.querySelector(`[data-mcp-server="${CSS.escape(server.id)}"]`)?.click?.();document.querySelector(`[data-mcp-call-tool="${CSS.escape(tool.name)}"]`)?.focus?.();}})),
    ...(server.resources || []).map((r)=>({id:`mcp-resource:${server.id}:${r.uri}`,title:r.name || r.uri,category:`MCP Resource · ${server.name || server.id}`,keywords:[r.uri || ''],subtitle:r.uri || '',itemType:'mcpResource',execute:()=>{switchSettings('mcp');document.querySelector(`[data-mcp-server="${CSS.escape(server.id)}"]`)?.click?.();}})),
    ...(server.prompts || []).map((p)=>({id:`mcp-prompt:${server.id}:${p.name}`,title:p.name,category:`MCP Prompt · ${server.name || server.id}`,keywords:[p.description || ''],subtitle:p.description || '',itemType:'mcpPrompt',execute:()=>{switchSettings('mcp');document.querySelector(`[data-mcp-server="${CSS.escape(server.id)}"]`)?.click?.();}}))
  ]);

  const models = (app.ollama?.models || []).map((model) => {
    const modelId = model.model || model.name;
    return {
      id: `model:${modelId}`, title: modelId, category: 'Model', keywords: [model.details?.parameter_size || '', model.details?.quantization_level || ''],
      execute: async () => {
        await chooseModel(modelId, { provider: 'ollama' });
      }, itemType: 'model', subtitle: [model.details?.parameter_size, model.details?.quantization_level].filter(Boolean).join(' · ')
    };
  });
  if (kind === 'files') return files;
  if (kind === 'sessions') return sessions;
  if (kind === 'models') return models;
  if (kind === 'commands') return commands;
  if (kind === 'resources') return [...platformResources, ...providerItems, ...mcpItems];
  if (kind === 'workspaceSymbols') return paletteCustomItems;
  return [...commands, ...files, ...sessions, ...models, ...platformResources, ...providerItems, ...mcpItems];
}

function renderCommandPalette() {
  const host = $('#commandPaletteList');
  if (!host) return;
  const query = $('#commandPaletteInput')?.value || '';
  const ranked = rankCommands(buildPaletteItems(paletteKind), query).slice(0, 80);
  paletteItems = ranked.map((item) => item.command);
  paletteIndex = Math.max(0, Math.min(paletteIndex, Math.max(0, paletteItems.length - 1)));
  host.innerHTML = '';
  if (!paletteItems.length) {
    host.innerHTML = '<div class="empty-state">No matching commands, files, sessions, or models.</div>';
    return;
  }
  paletteItems.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `command-palette-item ${index === paletteIndex ? 'selected' : ''}`;
    row.innerHTML = `<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.subtitle || `${item.category || 'General'} · ${item.id}`)}</small></span><span class="command-shortcut">${escapeHtml(item.shortcut || '')}</span>`;
    row.onmouseenter = () => { paletteIndex = index; renderCommandPalette(); };
    row.onclick = () => runPaletteItem(index);
    host.append(row);
  });
  host.children[paletteIndex]?.scrollIntoView?.({ block: 'nearest' });
}

async function runPaletteItem(index = paletteIndex) {
  const item = paletteItems[index];
  if (!item) return;
  closeCommandPalette();
  try {
    if (item.itemType === 'command' && commandRegistry.get(item.id)) await executeAppCommand(item.id);
    else await item.execute({ app });
  } catch (error) { toast(error.message, 'error'); }
}

function openCommandPalette(kind = 'all', initialQuery = '', customItems = null) {
  if (Array.isArray(customItems)) paletteCustomItems = customItems;
  paletteKind = kind;
  paletteIndex = 0;
  const overlay = $('#commandPalette');
  const input = $('#commandPaletteInput');
  if (!overlay || !input) return;
  overlay.classList.remove('hidden');
  input.value = initialQuery;
  input.placeholder = kind === 'files' ? 'Find file…' : kind === 'sessions' ? 'Find session…' : kind === 'models' ? 'Select model…' : kind === 'commands' ? 'Run command…' : kind === 'workspaceSymbols' ? 'Find workspace symbol…' : kind === 'resources' ? 'Search skills, prompts, extensions, packages, providers, MCP…' : 'Search commands, files, sessions, models, resources…';
  renderCommandPalette();
  requestAnimationFrame(() => input.focus());
}

function closeCommandPalette() {
  $('#commandPalette')?.classList.add('hidden');
  if (app.interaction.mode === 'vim') setVimMode('normal');
}

function leaderEntries(prefix = '') {
  if (!prefix) {
    const groups = new Map();
    for (const binding of LEADER_BINDINGS) {
      const key = binding.keys[0];
      if (!groups.has(key)) groups.set(key, { key, label: binding.group });
    }
    return [...groups.values()];
  }
  return LEADER_BINDINGS.filter((binding) => binding.keys.startsWith(prefix)).map((binding) => ({ key: binding.keys.slice(prefix.length, prefix.length + 1), label: binding.label, command: binding.command, full: binding.keys }));
}

function showLeader(prefix = '') {
  if (app.interaction.mode === 'standard') return;
  const overlay = $('#leaderOverlay');
  const grid = $('#leaderGrid');
  if (!overlay || !grid) return;
  app.interaction.leaderPending = true;
  app.interaction.leaderPrefix = prefix;
  grid.innerHTML = '';
  for (const entry of leaderEntries(prefix)) {
    const node = document.createElement('div');
    node.className = 'leader-entry';
    node.innerHTML = `<kbd>${escapeHtml(entry.key)}</kbd><span>${escapeHtml(entry.label)}</span>`;
    grid.append(node);
  }
  if ($('#leaderHints')?.checked !== false) overlay.classList.remove('hidden');
  clearTimeout(leaderTimer);
  leaderTimer = setTimeout(closeLeader, 1800);
}

function closeLeader() {
  clearTimeout(leaderTimer);
  app.interaction.leaderPending = false;
  app.interaction.leaderPrefix = '';
  $('#leaderOverlay')?.classList.add('hidden');
}

async function handleLeaderKey(key) {
  const prefix = `${app.interaction.leaderPrefix || ''}${String(key).toLowerCase()}`;
  const exact = LEADER_BINDINGS.find((binding) => binding.keys === prefix);
  const continuations = LEADER_BINDINGS.filter((binding) => binding.keys.startsWith(prefix));
  if (exact) {
    closeLeader();
    await executeAppCommand(exact.command).catch((error) => toast(error.message, 'error'));
    return true;
  }
  if (continuations.length) {
    showLeader(prefix);
    return true;
  }
  closeLeader();
  return false;
}

function showKeymapHelp() {
  const host = $('#keymapHelpContent');
  if (!host) return;
  const groups = new Map();
  for (const binding of LEADER_BINDINGS) {
    if (!groups.has(binding.group)) groups.set(binding.group, []);
    groups.get(binding.group).push(binding);
  }
  host.innerHTML = '';
  for (const [group, bindings] of groups) {
    const heading = document.createElement('div'); heading.className = 'keymap-help-group'; heading.textContent = group; host.append(heading);
    for (const binding of bindings) {
      const row = document.createElement('div'); row.className = 'keymap-help-row'; row.innerHTML = `<span><kbd>Space</kbd> <kbd>${escapeHtml(binding.keys.split('').join(' '))}</kbd></span><span>${escapeHtml(binding.label)}</span>`; host.append(row);
    }
  }
  const heading = document.createElement('div'); heading.className = 'keymap-help-group'; heading.textContent = 'Vim Normal mode'; host.append(heading);
  for (const [keys, label] of [['j / k','Next / previous chat, tree, Changes or terminal item'],['g g / G','First / last item'],['g d / g r','Go to definition / find references in editor'],['F2','Rename symbol'],['Ctrl+.','Code actions / quick fix'],['Shift+Alt+F','Format document'],['K','Show symbol hover in editor'],['Ctrl+w h/j/k/l','Focus editor split pane'],['Ctrl+w v / s / q','Vertical split / horizontal split / close split'],['i','Insert mode / focus current editor'],['Esc','Normal mode'],[':','Command palette (commands only)'],['/','Universal search'],['Enter','Open/toggle selected item'],['y','Copy selected item to unnamed register'],['"{letter}y','Copy selected item to named register'],['q{letter} … q','Record semantic command macro'],['@{letter}','Replay semantic command macro'],['.','Repeat last repeatable semantic action'],['z a','Fold/unfold selected item'],['f','Fork selected user prompt'],['p','Create app from selected user prompt'],[']q / [q','Next / previous problem'],['m{letter}','Set mark'],["'{letter}",'Jump to mark']]) {
    const row = document.createElement('div'); row.className = 'keymap-help-row'; row.innerHTML = `<span><kbd>${escapeHtml(keys)}</kbd></span><span>${escapeHtml(label)}</span>`; host.append(row);
  }
  $('#keymapHelp')?.classList.remove('hidden');
}

function showPowerState() {
  const registerHost = $('#registerList');
  const macroHost = $('#macroList');
  if (registerHost) {
    const registers = app.registers.list();
    registerHost.innerHTML = '';
    registerHost.classList.toggle('empty-state', !registers.length);
    for (const item of registers) {
      const row = document.createElement('div');
      row.className = 'power-row';
      row.innerHTML = `<kbd>${escapeHtml(item.name)}</kbd><span>${escapeHtml(item.label ? `${item.label}\n${truncate(item.value, 180)}` : truncate(item.value, 180))}</span>`;
      registerHost.append(row);
    }
    if (!registers.length) registerHost.textContent = 'No registers yet. In Vim mode use y, or "ay to copy into register a.';
  }
  if (macroHost) {
    const macros = app.macros.list();
    macroHost.innerHTML = '';
    macroHost.classList.toggle('empty-state', !macros.length);
    for (const macro of macros) {
      const row = document.createElement('div');
      row.className = 'power-row';
      row.innerHTML = `<kbd>${escapeHtml(macro.name)}</kbd><span>${escapeHtml(macro.steps.map((step) => step.commandId).join(' → ') || 'Empty macro')}</span>`;
      macroHost.append(row);
    }
    if (!macros.length) macroHost.textContent = 'No macros yet. In Vim mode use q{letter}, run commands, q, then @{letter}.';
  }
  $('#powerStateModal')?.classList.remove('hidden');
}

function toggleSelectedFold() {
  const item = selectedKeyboardItem();
  if (!item) return;
  const body = item.matches('.message') ? $('.message-content', item) : $('.tree-card-body', item) || $('.tree-card-thinking', item) || item;
  if (!body) return;
  body.classList.toggle('vim-folded');
}

function copySelectedItem(registerName = null) {
  const item = selectedKeyboardItem();
  if (!item) return;
  const text = item.innerText || item.textContent || '';
  const register = registerName || app.interaction.pendingRegister || '"';
  app.registers.set(register, text, { type: activeViewName(), label: `${activeViewName()} selection` });
  app.interaction.pendingRegister = null;
  navigator.clipboard?.writeText?.(text);
  toast(register === '"' ? 'Copied selection' : `Copied selection to register ${register}`, 'success');
}

function activateSelectedItem() {
  const item = selectedKeyboardItem();
  if (!item) return;
  const view = activeViewName();
  if (view === 'tree') {
    const toggle = $('.tree-card-toggle', item);
    if (toggle) return toggle.click();
    const body = $('.tree-card-body', item);
    if (body) body.classList.toggle('expanded');
  } else if (view === 'git') {
    $('.git-file-name', item)?.click?.();
  } else if (view === 'terminal') {
    $('button', item)?.focus?.();
  }
}

function selectedTreeUserAction(actionText) {
  const item = selectedKeyboardItem();
  if (!item?.classList?.contains('session-tree-card')) return false;
  const button = [...item.querySelectorAll('button')].find((btn) => btn.textContent.includes(actionText));
  if (!button) return false;
  button.click();
  return true;
}

function registerAppCommands() {
  const reg = (id, title, category, execute, extra = {}) => commandRegistry.register({ id, title, category, execute, ...extra });
  reg('palette.open', 'Open command palette', 'Navigate', () => openCommandPalette('all'), { shortcut: 'Ctrl/Cmd+Shift+P', keywords: ['search', 'telescope'] });
  reg('palette.files', 'Find file', 'Files', () => openCommandPalette('files'), { shortcut: 'Ctrl/Cmd+P' });
  reg('palette.sessions', 'Find session', 'Sessions', () => openCommandPalette('sessions'));
  reg('palette.models', 'Select model', 'Models', () => openCommandPalette('models'));
  reg('palette.resources', 'Search all agent resources', 'Navigate', async () => { if (app.workspace && !app.platform.snapshot) await loadPiPlatform({ quiet: true }).catch(() => {}); openCommandPalette('resources'); }, { keywords: ['skills','prompts','extensions','packages','providers','mcp'] });
  reg('view.chat', 'Open Chat view', 'Navigate', () => switchView('chat'));
  reg('view.editor', 'Open Editor view', 'Navigate', () => switchView('editor'));
  reg('view.preview', 'Open App Preview', 'Navigate', () => switchView('preview'), { keywords: ['browser','localhost','dev server'] });
  reg('preview.start', 'Start App Preview server', 'Preview', () => { switchView('preview'); return previewPanel?.start?.(); });
  reg('preview.restart', 'Restart App Preview server', 'Preview', () => { switchView('preview'); return previewPanel?.restart?.(); });
  reg('preview.stop', 'Stop App Preview server', 'Preview', () => { switchView('preview'); return previewPanel?.stop?.(); });
  reg('preview.refresh', 'Refresh App Preview', 'Preview', () => { switchView('preview'); return previewPanel?.reloadFrame?.('main'); });
  reg('preview.toggleSplit', 'Toggle App Preview beside Editor', 'Preview', async () => { switchView('editor'); return previewPanel?.toggleEditorSplit?.(); }, { keywords: ['side by side','browser','split','live preview'] });
  reg('view.tree', 'Open Session Tree', 'Navigate', async () => { switchView('tree'); if (app.pi.status?.running) await loadSessionTree(); });
  reg('view.git', 'Open Git view', 'Navigate', () => switchView('git'));
  reg('view.problems', 'Open Problems / Quickfix', 'Navigate', () => { switchView('problems'); renderProblems(); });
  reg('view.resources', 'Open Pi Resources', 'Navigate', () => switchView('resources'));
  reg('problems.next', 'Next problem', 'Problems', () => moveProblem(1), { shortcut: ']q', repeatable: true });
  reg('problems.previous', 'Previous problem', 'Problems', () => moveProblem(-1), { shortcut: '[q', repeatable: true });
  reg('problems.clear', 'Clear problems', 'Problems', clearProblems);
  reg('view.terminal', 'Open Terminal view', 'Navigate', () => switchView('terminal'));
  reg('view.logs', 'Open Logs view', 'Navigate', () => switchView('logs'));
  reg('view.docs', 'Open Documentation', 'Navigate', () => switchView('docs'));
  reg('chat.focusComposer', 'Focus prompt composer', 'Agent', () => { switchView('chat'); $('#composer')?.focus?.(); if (app.interaction.mode === 'vim') setVimMode('insert'); });
  reg('agent.send', 'Send prompt', 'Agent', () => sendPrompt('prompt'), { shortcut: 'Enter (composer)' });
  reg('agent.steer', 'Steer active turn', 'Agent', () => sendPrompt('steer'));
  reg('agent.followUp', 'Queue follow-up', 'Agent', () => sendPrompt('follow_up'));
  reg('agent.abort', 'Abort active agent turn', 'Agent', () => $('#abortAgent')?.click?.());
  reg('agent.compact', 'Compact context', 'Context', () => $('#compactNow')?.click?.());
  reg('session.new', 'New Pi session', 'Sessions', () => $('#newSession')?.click?.());
  reg('session.refresh', 'Refresh sessions', 'Sessions', () => loadSessions());
  reg('session.cloneCurrent', 'Clone current session', 'Sessions', () => app.pi.state?.sessionFile ? promptCloneSession(app.pi.state.sessionFile) : toast('No active session', 'error'));
  reg('project.manager.open', 'Open Project Manager', 'Workspace', openProjectManager, { keywords: ['workspace', 'recent projects', 'switch project'] });
  reg('project.new', 'Create New Project', 'Workspace', openNewProjectWizard, { keywords: ['workspace', 'folder', 'html', 'node'] });
  reg('project.openFolder', 'Open Existing Project Folder', 'Workspace', () => openFolderBrowserModal(), { keywords: ['workspace', 'folder', 'open'] });
  reg('project.createFromSession', 'Create Project from Session', 'Workspace', async () => {
    closeProjectManager();
    switchView('tree');
    if (app.pi.status?.running) await loadSessionTree().catch(() => {});
    toast('Select a prompt in Session Tree, then choose Create App from Here.', '');
  }, { keywords: ['session tree', 'checkpoint', 'worktree', 'historical project'] });
  reg('harness.open', 'Open Harness Workbench', 'Harness', () => switchSettings('harness'), { keywords: ['agent', 'coding', 'tools', 'skills', 'mcp'] });
  reg('harness.new', 'Create New Harness', 'Harness', () => { switchSettings('harness'); openHarnessBuilder(); }, { keywords: ['agent', 'coding', 'tools', 'workflow'] });
  reg('harness.saveEffective', 'Save Effective Harness', 'Harness', () => { switchSettings('harness'); openHarnessBuilder(null, { effective: true }); }, { keywords: ['agent', 'coding', 'session', 'reuse'] });
  reg('harness.select', 'Select Harness for Next Session', 'Harness', (_ctx, id) => selectHarnessForNextSession(id), { keywords: ['agent', 'coding', 'profile'] });
  reg('tree.refresh', 'Refresh session tree', 'Sessions', () => loadSessionTree());
  reg('git.refresh', 'Refresh Git status', 'Git', () => loadGitPanel());
  reg('git.diffNext', 'Next Git diff change', 'Git', () => app.monacoDiff?.next?.(), { repeatable: true });
  reg('git.diffPrevious', 'Previous Git diff change', 'Git', () => app.monacoDiff?.previous?.(), { repeatable: true });
  reg('git.toggleDiffMode', 'Toggle inline / side-by-side Git diff', 'Git', () => { app.gitDiffInline = !app.gitDiffInline; app.monacoDiff?.setInline?.(app.gitDiffInline); if ($('#gitDiffMode')) $('#gitDiffMode').textContent = app.gitDiffInline ? 'Side-by-side' : 'Inline'; });
  reg('git.restoreSelected', 'Restore selected Git file', 'Git', gitRestoreSelectedFile);
  reg('git.toggleStageSelected', 'Stage / unstage selected Git file', 'Git', gitToggleSelectedStage);
  reg('git.openSelected', 'Open selected changed file', 'Git', openSelectedGitFile);
  reg('git.copyPatch', 'Copy selected Git patch', 'Git', copySelectedGitPatch);
  reg('git.askAgent', 'Ask agent about selected Git diff', 'Git', askAgentAboutGitDiff);
  reg('git.checkpoint', 'Create Git checkpoint snapshot', 'Git', async () => {
    if (!app.workspace) return toast('Open a workspace first', 'error');
    try {
      const result = await post('/api/workspace/git/checkpoint', { workspace: app.workspace, label: `Manual Pi Studio checkpoint ${new Date().toISOString()}` });
      toast(`Checkpoint ${result.checkpoint.commit.slice(0, 8)} created`, 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  reg('file.save', 'Save current file', 'Files', () => saveFile(), { shortcut: 'Ctrl/Cmd+S' });
  reg('file.saveAll', 'Save all open files', 'Files', () => saveAllFiles(), { shortcut: 'Ctrl/Cmd+Alt+S' });
  reg('workspace.search', 'Search text in workspace', 'Files', () => { $('#workspaceSearchInput')?.focus?.(); if ($('#workspaceSearchInput')?.value) searchWorkspaceUi(); }, { shortcut: 'Space f g', keywords: ['grep', 'find text', 'search files'] });
  reg('editor.find', 'Find in current editor', 'Editor', () => { switchView('editor'); if (app.monacoAvailable) app.monaco.trigger(app.workbench.activePane, 'actions.find'); else paneDom().editor?.focus?.(); }, { shortcut: 'Ctrl/Cmd+F' });
  reg('editor.replace', 'Replace in current editor', 'Editor', () => { switchView('editor'); if (app.monacoAvailable) app.monaco.trigger(app.workbench.activePane, 'editor.action.startFindReplaceAction'); else paneDom().editor?.focus?.(); }, { shortcut: 'Ctrl/Cmd+H' });
  reg('editor.goToDefinition', 'Go to definition', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.revealDefinition'); }, { shortcut: 'F12 / gd', repeatable: true });
  reg('editor.findReferences', 'Find references', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.referenceSearch.trigger'); }, { shortcut: 'Shift+F12 / gr', repeatable: true });
  reg('editor.showHover', 'Show symbol hover', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.showHover'); }, { shortcut: 'K', repeatable: true });
  reg('editor.goToImplementation', 'Go to implementation', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.goToImplementation'); }, { shortcut: 'Ctrl/Cmd+F12', repeatable: true });
  reg('editor.rename', 'Rename symbol', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.rename'); }, { shortcut: 'F2' });
  reg('editor.codeAction', 'Code actions / Quick Fix', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.quickFix'); }, { shortcut: 'Ctrl/Cmd+.' });
  reg('editor.format', 'Format document', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.formatDocument'); }, { shortcut: 'Shift+Alt+F' });
  reg('editor.documentSymbols', 'Go to symbol in file', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.quickOutline'); }, { shortcut: 'Ctrl/Cmd+Shift+O' });
  reg('editor.workspaceSymbols', 'Go to symbol in workspace', 'Editor', async () => {
    if (!app.lsp) return toast('Language services are not ready', 'error');
    const symbols = await app.lsp.workspaceSymbols('');
    if (!symbols.length) return toast('No workspace symbols from active language servers. Open a supported code file first.', '');
    const items = symbols.slice(0, 1000).map((symbol, index) => ({
      id: `workspace-symbol:${index}:${symbol.path}:${symbol.name}`, title: symbol.name || '(anonymous symbol)', category: 'Workspace Symbol',
      subtitle: `${symbol.containerName ? `${symbol.containerName} · ` : ''}${symbol.path}:${Number(symbol.range?.start?.line || 0) + 1}`,
      keywords: [symbol.path, symbol.containerName || '', symbol.serverId || ''], itemType: 'workspaceSymbol',
      execute: async () => {
        await openFile(symbol.path);
        switchView('editor');
        app.monaco?.reveal(app.workbench.activePane, Number(symbol.range?.start?.line || 0) + 1, Number(symbol.range?.start?.character || 0) + 1);
      }
    }));
    openCommandPalette('workspaceSymbols', '', items);
  });
  reg('editor.signatureHelp', 'Trigger parameter hints', 'Editor', () => { switchView('editor'); app.monaco?.trigger(app.workbench.activePane, 'editor.action.triggerParameterHints'); }, { shortcut: 'Ctrl/Cmd+Shift+Space' });
  reg('lsp.refresh', 'Refresh language-server status', 'Language', () => app.lsp?.refreshStatus?.());
  reg('lsp.restart', 'Restart language servers', 'Language', async () => { if (!app.workspace || !app.lsp) return; await app.lsp.restart(); syncPaneLsp('primary', 'open', true); syncPaneLsp('secondary', 'open', true); toast('Language servers restarted', 'success'); });
  reg('editor.nextBuffer', 'Next open buffer', 'Editor', () => cycleBuffer(1), { shortcut: 'Ctrl+Tab', repeatable: true });
  reg('editor.previousBuffer', 'Previous open buffer', 'Editor', () => cycleBuffer(-1), { shortcut: 'Ctrl+Shift+Tab', repeatable: true });
  reg('editor.closeBuffer', 'Close active buffer', 'Editor', () => closeBuffer(), { repeatable: true });
  reg('editor.splitVertical', 'Split editor vertically', 'Editor', () => setEditorSplit('vertical'));
  reg('editor.splitHorizontal', 'Split editor horizontally', 'Editor', () => setEditorSplit('horizontal'));
  reg('editor.closeSplit', 'Close editor split', 'Editor', closeEditorSplit);
  reg('editor.focusOtherPane', 'Focus other editor pane', 'Editor', () => {
    if (app.workbench.split === 'none') return;
    const pane = app.workbench.activePane === 'primary' ? 'secondary' : 'primary';
    captureEditorViewState(app.workbench.activePane); app.workbench.setActivePane(pane); renderWorkbench(); if (app.monacoAvailable) app.monaco.focus(pane); else paneDom(pane).editor?.focus?.(); schedulePersistWorkbenchState();
  }, { repeatable: true });
  reg('resources.refresh', 'Refresh Pi resources', 'Pi Resources', async () => { await loadPiPlatform({ quiet: true }); if (app.pi.status?.running) await loadCommands(); });
  reg('pi.restart', 'Restart Pi', 'Pi', () => restartPiForResources(), { keywords: ['reload', 'resources', 'extensions', 'session'] });
  for (const [tab, title] of [['overview','Pi Platform overview'],['instructions','Pi instructions'],['skills','Pi skills'],['prompts','Pi prompt templates'],['extensions','Pi extensions'],['packages','Pi packages'],['settings','Pi scoped settings']]) reg(`platform.${tab}`, `Open ${title}`, 'Pi Platform', async () => { switchView('resources'); app.platform.tab = tab; app.platform.selected = null; await loadPiPlatform({ quiet: true }); renderPlatformTab(); });
  reg('packages.browse', 'Browse online Pi packages', 'Pi Platform', async () => packageMarketplace?.open(''));
  reg('extensions.browse', 'Browse online Pi extensions', 'Pi Platform', async () => packageMarketplace?.open('extensions'));
  reg('skills.browse', 'Browse online Pi skills', 'Pi Platform', async () => packageMarketplace?.open('skills'));
  reg('ui.repeatLast', 'Repeat last semantic action', 'Keyboard', repeatLastSemanticAction, { shortcut: '.', recordable: false });
  reg('ui.powerState', 'Show Vim registers and macros', 'Keyboard', showPowerState, { recordable: false });
  reg('workspace.focus', 'Focus workspace path', 'Workspace', () => $('#workspacePath')?.focus?.());
  reg('workspace.refresh', 'Refresh workspace', 'Workspace', () => Promise.allSettled([loadWorkspaceTree(), loadGit(), loadSessions()]));
  reg('ollama.testRuntime', 'Test Ollama Connection', 'Models', testOllamaConnection, { keywords: ['runtime', 'server', 'LAN', 'health'] });
  reg('ollama.useTestedRuntime', 'Use Tested Ollama Server', 'Models', useTestedOllamaRuntime, { keywords: ['runtime', 'server', 'switch', 'LAN'] });
  reg('ui.keymapHelp', 'Open keyboard cheat sheet', 'Help', showKeymapHelp);
  reg('ui.interactionSettings', 'Open interaction settings', 'Settings', () => switchSettings('interaction'));
  reg('ui.cycleInteractionMode', 'Cycle Standard / Keyboard / Vim mode', 'Settings', () => {
    const modes = ['standard', 'keyboard', 'vim'];
    setInteractionMode(modes[(modes.indexOf(app.interaction.mode) + 1) % modes.length]);
  });
}

function installInteractionLayer() {
  registerAppCommands();
  const saved = interactionStorage();
  if ($('#leaderHints')) $('#leaderHints').checked = saved.leaderHints !== false;
  if ($('#autoGitCheckpoints')) $('#autoGitCheckpoints').checked = saved.autoGitCheckpoints !== false;
  if ($('#showModeBadge')) $('#showModeBadge').checked = saved.showModeBadge !== false;
  setInteractionMode(saved.mode || 'standard', { persist: false });

  $('#openCommandPalette')?.addEventListener('click', () => openCommandPalette('all'));
  $('#interactionModeBadge')?.addEventListener('click', () => executeAppCommand('ui.cycleInteractionMode'));
  $('#interactionMode')?.addEventListener('change', (event) => setInteractionMode(event.target.value));
  $('#leaderHints')?.addEventListener('change', persistInteraction);
  $('#autoGitCheckpoints')?.addEventListener('change', persistInteraction);
  $('#showModeBadge')?.addEventListener('change', () => { setInteractionMode(app.interaction.mode); persistInteraction(); });
  $('#openKeymapHelp')?.addEventListener('click', showKeymapHelp);
  $('#prevProblem')?.addEventListener('click', () => moveProblem(-1));
  $('#nextProblem')?.addEventListener('click', () => moveProblem(1));
  $('#clearProblems')?.addEventListener('click', clearProblems);
  $('#closeKeymapHelp')?.addEventListener('click', () => $('#keymapHelp')?.classList.add('hidden'));
  $('#keymapHelp')?.addEventListener('click', (event) => { if (event.target.id === 'keymapHelp') $('#keymapHelp').classList.add('hidden'); });
  $('#closePowerState')?.addEventListener('click', () => $('#powerStateModal')?.classList.add('hidden'));
  $('#powerStateModal')?.addEventListener('click', (event) => { if (event.target.id === 'powerStateModal') $('#powerStateModal').classList.add('hidden'); });
  $('#commandPalette')?.addEventListener('mousedown', (event) => { if (event.target.id === 'commandPalette') closeCommandPalette(); });
  $('#commandPaletteInput')?.addEventListener('input', () => { paletteIndex = 0; renderCommandPalette(); });
  $('#commandPaletteInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); renderCommandPalette(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderCommandPalette(); }
    else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); }
  });

  document.addEventListener('keydown', async (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openCommandPalette('all'); return; }
    if (meta && !event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openCommandPalette('files'); return; }
    if (meta && event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); await executeAppCommand('file.saveAll'); return; }
    if (meta && event.key.toLowerCase() === 's') { event.preventDefault(); if (app.workbench.activeBuffer) saveFile(); return; }
    if (meta && !event.shiftKey && event.key.toLowerCase() === 'f' && activeViewName() === 'editor') { event.preventDefault(); await executeAppCommand('editor.find'); return; }
    if (meta && !event.shiftKey && event.key.toLowerCase() === 'h' && activeViewName() === 'editor') { event.preventDefault(); await executeAppCommand('editor.replace'); return; }
    if (activeViewName() === 'editor' && event.key === 'F2') { event.preventDefault(); await executeAppCommand('editor.rename'); return; }
    if (activeViewName() === 'editor' && meta && event.key === '.') { event.preventDefault(); await executeAppCommand('editor.codeAction'); return; }
    if (activeViewName() === 'editor' && event.shiftKey && event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); await executeAppCommand('editor.format'); return; }
    if (activeViewName() === 'editor' && meta && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); await executeAppCommand('editor.documentSymbols'); return; }
    if (activeViewName() === 'editor' && meta && event.shiftKey && event.code === 'Space') { event.preventDefault(); await executeAppCommand('editor.signatureHelp'); return; }
    if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); await executeAppCommand(event.shiftKey ? 'editor.previousBuffer' : 'editor.nextBuffer'); return; }
    if (event.key === 'Escape' && !$('#keymapHelp')?.classList.contains('hidden')) { event.preventDefault(); $('#keymapHelp').classList.add('hidden'); return; }
    if (event.key === 'Escape' && !$('#powerStateModal')?.classList.contains('hidden')) { event.preventDefault(); $('#powerStateModal').classList.add('hidden'); return; }
    if (!$('#commandPalette')?.classList.contains('hidden') || !$('#keymapHelp')?.classList.contains('hidden') || !$('#powerStateModal')?.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
      closeLeader();
      if (app.interaction.mode === 'vim') { event.preventDefault(); exitVimInsertMode(); }
      return;
    }

    if (app.interaction.leaderPending) {
      event.preventDefault();
      await handleLeaderKey(event.key);
      return;
    }

    if ((app.interaction.mode === 'keyboard' || (app.interaction.mode === 'vim' && app.interaction.vimMode === 'normal')) && event.key === ' ' && !isEditableTarget(event.target)) {
      event.preventDefault(); showLeader(''); return;
    }

    if (app.interaction.mode !== 'vim' || app.interaction.vimMode !== 'normal' || isEditableTarget(event.target)) return;
    const key = event.key;
    if (event.ctrlKey && key.toLowerCase() === 'w') { event.preventDefault(); vimWindowPending = true; return; }
    if (vimWindowPending) {
      event.preventDefault(); vimWindowPending = false;
      if (key === 'v') return executeAppCommand('editor.splitVertical');
      if (key === 's') return executeAppCommand('editor.splitHorizontal');
      if (key === 'q') return executeAppCommand('editor.closeSplit');
      if (key === '=') { $('#editorWorkbench')?.style?.setProperty('--editor-split-size', '50%'); schedulePersistWorkbenchState(); return; }
      if (['h','k'].includes(key)) {
        if (app.workbench.split !== 'none') { app.workbench.setActivePane('primary'); renderWorkbench(); app.monacoAvailable ? app.monaco.focus('primary') : paneDom('primary').editor?.focus?.(); }
        return;
      }
      if (['l','j'].includes(key)) {
        if (app.workbench.split !== 'none') { app.workbench.setActivePane('secondary'); renderWorkbench(); app.monacoAvailable ? app.monaco.focus('secondary') : paneDom('secondary').editor?.focus?.(); }
        return;
      }
      return;
    }
    if (key === 'i') { event.preventDefault(); enterVimInsertMode(); return; }
    if (key === ':') { event.preventDefault(); openCommandPalette('commands'); return; }
    if (key === '/') { event.preventDefault(); openCommandPalette('all'); return; }
    if (key === 'j') { event.preventDefault(); moveKeyboardSelection(1); return; }
    if (key === 'k') { event.preventDefault(); moveKeyboardSelection(-1); return; }
    if (key === 'G') { event.preventDefault(); selectKeyboardItem(navigableItems().length - 1, { center: true }); return; }
    if (key === ']') { event.preventDefault(); vimPrefix = ']'; clearTimeout(vimPrefixTimer); vimPrefixTimer = setTimeout(() => { vimPrefix = ''; }, 700); return; }
    if (key === '[') { event.preventDefault(); vimPrefix = '['; clearTimeout(vimPrefixTimer); vimPrefixTimer = setTimeout(() => { vimPrefix = ''; }, 700); return; }
    if (vimPrefix === ']' && key === 'q') { event.preventDefault(); vimPrefix = ''; await executeAppCommand('problems.next'); return; }
    if (vimPrefix === '[' && key === 'q') { event.preventDefault(); vimPrefix = ''; await executeAppCommand('problems.previous'); return; }

    if (app.interaction.pendingRegister === '__await_name__') {
      event.preventDefault();
      app.interaction.pendingRegister = /^[a-z0-9+]$/i.test(key) ? key.toLowerCase() : null;
      return;
    }
    if (app.interaction.pendingMacroAction) {
      event.preventDefault();
      const action = app.interaction.pendingMacroAction;
      app.interaction.pendingMacroAction = null;
      if (!/^[a-z0-9]$/i.test(key)) return;
      if (action === 'record') {
        try { app.macros.start(key); toast(`Recording macro ${key.toLowerCase()} — press q to stop`, 'success'); } catch (error) { toast(error.message, 'error'); }
      } else {
        const count = await app.macros.replay(key, (id, ...args) => executeAppCommand(id, ...args));
        toast(count ? `Replayed macro ${key.toLowerCase()} (${count} commands)` : `Macro ${key.toLowerCase()} is empty`, count ? 'success' : '');
      }
      return;
    }
    if (app.interaction.pendingMarkAction) {
      event.preventDefault();
      const action = app.interaction.pendingMarkAction;
      app.interaction.pendingMarkAction = null;
      if (/^[a-z]$/i.test(key)) {
        if (action === 'set') {
          const selected = selectedKeyboardItem();
          if (selected) { app.interaction.marks[key.toLowerCase()] = { view: activeViewName(), index: app.interaction.selectedIndex }; toast(`Mark ${key.toLowerCase()} set`, 'success'); }
        } else {
          const mark = app.interaction.marks[key.toLowerCase()];
          if (mark) { switchView(mark.view); requestAnimationFrame(() => selectKeyboardItem(mark.index, { center: true })); }
          else toast(`Mark ${key.toLowerCase()} is empty`, '');
        }
      }
      return;
    }
    if (key === 'm') { event.preventDefault(); app.interaction.pendingMarkAction = 'set'; return; }
    if (key === "'") { event.preventDefault(); app.interaction.pendingMarkAction = 'jump'; return; }
    if (key === '"') { event.preventDefault(); app.interaction.pendingRegister = '__await_name__'; return; }
    if (key === 'q') {
      event.preventDefault();
      if (app.macros.recording) { const name = app.macros.stop(); toast(`Macro ${name} recorded`, 'success'); }
      else app.interaction.pendingMacroAction = 'record';
      return;
    }
    if (key === '@') { event.preventDefault(); app.interaction.pendingMacroAction = 'replay'; return; }
    if (key === '.') { event.preventDefault(); await repeatLastSemanticAction(); return; }
    if (key === 'K' && activeViewName() === 'editor') { event.preventDefault(); await executeAppCommand('editor.showHover'); return; }
    if (key === 'Enter') { event.preventDefault(); activateSelectedItem(); return; }
    if (key === 'y') { event.preventDefault(); copySelectedItem(); return; }
    if (key === 'f') { event.preventDefault(); if (!selectedTreeUserAction('Fork Branch')) toast('Select a user prompt in Session Tree first', ''); return; }
    if (key === 'p') { event.preventDefault(); if (!selectedTreeUserAction('Create App')) toast('Select a user prompt in Session Tree first', ''); return; }

    const nowPrefix = `${vimPrefix}${key}`;
    const resetPrefix = () => { vimPrefix = ''; clearTimeout(vimPrefixTimer); };
    if (nowPrefix === 'gg') { event.preventDefault(); selectKeyboardItem(0, { center: true }); resetPrefix(); return; }
    if (nowPrefix === 'gd' && activeViewName() === 'editor') { event.preventDefault(); resetPrefix(); await executeAppCommand('editor.goToDefinition'); return; }
    if (nowPrefix === 'gr' && activeViewName() === 'editor') { event.preventDefault(); resetPrefix(); await executeAppCommand('editor.findReferences'); return; }
    if (nowPrefix === 'za') { event.preventDefault(); toggleSelectedFold(); resetPrefix(); return; }
    if (['g', 'z'].includes(key) && !vimPrefix) {
      event.preventDefault(); vimPrefix = key; clearTimeout(vimPrefixTimer); vimPrefixTimer = setTimeout(resetPrefix, 700); return;
    }
    resetPrefix();
  }, true);
}

async function initialize() {
  try {
    const value = await api('/api/bootstrap');
    Object.assign(app, {
      config: value.config || {},
      system: value.system || {},
      ollama: { models: [], running: [], ...(value.ollama || {}) },
      managedOllama: value.managedOllama || { running: false, pid: null },
      profiles: value.profiles || [],
      providers: value.providers || [],
      harnesses: value.harnesses || [],
      harnessErrors: value.harnessErrors || [],
      mcp: value.mcp || { servers: [], logs: [] },
      pi: { resourceRestartRequired: false, resourceRestartReason: '', ...(value.pi || {}) }
    });
    // A running Pi process is the authoritative workspace owner. If the UI
    // reloads while Pi is alive and the persisted config is empty/stale, use
    // Pi's workspace to restore the workbench instead of booting into "No
    // project" while the backend continues working in another folder.
    const runningPiWorkspace = value.pi?.status?.running ? String(value.pi.status.workspace || '').trim() : '';
    if (runningPiWorkspace && runningPiWorkspace !== String(app.config.defaultWorkspace || '').trim()) {
      app.config.defaultWorkspace = runningPiWorkspace;
      put('/api/config', { defaultWorkspace: runningPiWorkspace }).catch((error) => log('WORKSPACE RESTORE', error.message));
    }
    applyConfig();
    // Upgrade/restore paths can enter Studio with a valid default workspace
    // without going through switchWorkspace(). Keep the active project visible
    // in the Project Manager instead of showing an empty recent list.
    if (app.workspace) rememberRecentProject(app.workspace);
    refreshModelSelectors(); refreshHarnessSelectors(); renderSystem(); renderHealth(); renderOllamaInventorySummary(); renderPiSnapshot(); renderWorkbench(); installContextHelp();
    createProviderPanel({ root: document, api, post, put, del, toast, getProviders: () => app.providers, setProviders: (providers) => { app.providers = providers; }, onProvidersChanged: () => refreshModelSelectors() });
    createMcpPanel({ root: document, api, post, put, del, toast, getSnapshot: () => app.mcp, setSnapshot: (snapshot) => { app.mcp = snapshot; } });
    previewPanel = createPreviewPanel({ root: document, api, post, put, toast, getWorkspace: () => app.workspace, getWorkspaceEpoch: () => app.workspaceEpoch });
packageMarketplace = createPackageMarketplace({ root: document, api, post, put, toast, getWorkspace: () => app.workspace, refreshPlatform: () => loadPiPlatform({ quiet: true }), onPiResourceChange: markPiResourceChange });
    piPlatformPanel = createPiPlatformPanel({ root: document, state: app.platform, getWorkspace: () => app.workspace, getWorkspaceEpoch: () => app.workspaceEpoch, getResourceQuery: () => app.resources.query, getPiStats: () => app.pi.stats, api, put, post, toast, renderPiResources, switchView, sendPrompt, getPackageMarketplace: () => packageMarketplace, isPiRunning: () => Boolean(app.pi.status?.running), onPiResourceChange: markPiResourceChange, getCommandCount: () => app.resources.commands.length, loadCommands });
    const monacoReady = initializeMonacoEditors();
    if (app.workspace) {
      await Promise.allSettled([loadWorkspaceTree(), loadSessions(), loadGit()]);
      await restoreWorkbenchState(app.workspace);
    }
    await monacoReady.catch(() => {});
    if (app.pi.status?.running) { await refreshThinkingLevels(); await refreshMessages(); }
  } catch (error) { toast(error.message, 'error'); log('BOOTSTRAP ERROR', error.message); }
  connectEvents();
  setInterval(refreshLiveStatus, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshLiveStatus();
      refreshOpenFilesFromDisk({ reason: 'visibility' }).catch(() => {});
    }
  });
}

$$('.view-tabs button').forEach((button) => button.onclick = () => switchView(button.dataset.view));
$$('[data-doc-link]').forEach((button) => button.onclick = () => openDocumentation(button.dataset.docLink));
$('#docsSearch').oninput = (event) => filterDocumentation(event.target.value);
$$('.settings-tabs button').forEach((button) => button.onclick = () => switchSettings(button.dataset.settings));
$$('[data-prompt]').forEach((button) => button.onclick = () => { $('#composer').value = button.dataset.prompt; $('#composer').focus(); });
$('#applyWorkspace').onclick = applyWorkspace;
if ($('#nativeFolderInput')) {
  $('#nativeFolderInput').onchange = (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const first = files[0];
      const relPath = first.webkitRelativePath || first.name;
      const folderName = relPath.split('/')[0] || relPath.split('\\')[0];
      if (folderName) {
        $('#workspacePath').value = folderName;
        applyWorkspace();
      }
    }
  };
}
if ($('#selectFolder')) $('#selectFolder').onclick = () => executeAppCommand('project.openFolder');
if ($('#newProject')) $('#newProject').onclick = () => executeAppCommand('project.new');
if ($('#openProjectManager')) $('#openProjectManager').onclick = () => executeAppCommand('project.manager.open');
if ($('#projectManagerClose')) $('#projectManagerClose').onclick = closeProjectManager;
if ($('#projectManagerNew')) $('#projectManagerNew').onclick = () => executeAppCommand('project.new');
if ($('#projectManagerOpen')) $('#projectManagerOpen').onclick = () => executeAppCommand('project.openFolder');
if ($('#projectManagerFromSession')) $('#projectManagerFromSession').onclick = () => executeAppCommand('project.createFromSession');
if ($('#projectManagerClearRecent')) $('#projectManagerClearRecent').onclick = () => { try { localStorage.removeItem(RECENT_PROJECTS_KEY); } catch {} renderRecentProjects(); };
if ($('#projectWizardClose')) $('#projectWizardClose').onclick = closeProjectWizard;
if ($('#projectWizardCancel')) $('#projectWizardCancel').onclick = closeProjectWizard;
if ($('#projectWizardCreate')) $('#projectWizardCreate').onclick = createProjectFromWizard;
if ($('#projectWizardName')) $('#projectWizardName').oninput = updateProjectWizardFinalPath;
if ($('#projectWizardParent')) $('#projectWizardParent').oninput = updateProjectWizardFinalPath;
if ($('#projectWizardBrowse')) $('#projectWizardBrowse').onclick = () => openFolderBrowserModal($('#projectWizardParent').value || defaultProjectParent(), { title: 'Choose Parent Folder', confirmLabel: 'Use This Folder', onSelect: async (chosen) => { $('#projectWizardParent').value = chosen; updateProjectWizardFinalPath(); } });
if ($('#closeFolderModal')) $('#closeFolderModal').onclick = closeFolderBrowserModal;
if ($('#cancelSelectFolder')) $('#cancelSelectFolder').onclick = closeFolderBrowserModal;
if ($('#confirmSelectFolder')) {
  $('#confirmSelectFolder').onclick = async () => {
    const chosen = $('#selectedFolderPath').value || currentBrowserState.selected || currentBrowserState.current;
    if (!chosen) return;
    const handler = folderBrowserSelectHandler;
    closeFolderBrowserModal();
    if (handler) { await handler(chosen); return; }
    $('#workspacePath').value = chosen;
    await applyWorkspace();
    if (app.workspace) rememberRecentProject(app.workspace);
  };
}

// ── Project Manager / New Project Workflow ───────────────────────────────
const RECENT_PROJECTS_KEY = 'studio_recent_projects_v1';
let projectWizardState = null;
let folderBrowserSelectHandler = null;

function projectDisplayName(workspace) {
  const value = String(workspace || '').replace(/[\\/]+$/, '');
  return value.split(/[\\/]/).filter(Boolean).pop() || value || 'No project';
}

function recentProjects() {
  try { const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) || '[]'); return Array.isArray(value) ? value.filter(Boolean).slice(0, 12) : []; }
  catch { return []; }
}

function rememberRecentProject(workspace) {
  const value = String(workspace || '').trim(); if (!value) return;
  const key = workspacePathKey(value);
  const next = [{ path: value, name: projectDisplayName(value), openedAt: Date.now() }, ...recentProjects().filter((item) => workspacePathKey(item.path) !== key)].slice(0, 12);
  try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)); } catch {}
  renderCurrentProject();
  renderRecentProjects();
}

function renderCurrentProject() {
  const host = $('#currentProjectLabel'); if (!host) return;
  if (!app.workspace) { host.innerHTML = '<strong>No project</strong><span class="muted">Open or create a workspace</span>'; return; }
  host.innerHTML = `<strong title="${escapeHtml(app.workspace)}">${escapeHtml(projectDisplayName(app.workspace))}</strong><span class="muted" title="${escapeHtml(app.workspace)}">${escapeHtml(app.workspace)}</span>`;
}

function renderRecentProjects() {
  const host = $('#recentProjectList'); if (!host) return;
  const items = recentProjects(); host.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'recent-project-row';
    const displayName = item.name || projectDisplayName(item.path);
    row.innerHTML = `<button type="button" class="recent-project-main" aria-label="Open ${escapeHtml(displayName)} at ${escapeHtml(item.path)}"><strong>${escapeHtml(displayName)}</strong><span>${escapeHtml(item.path)}</span></button><button class="sm-btn ghost" title="Remove from recent" aria-label="Remove ${escapeHtml(displayName)} from recent projects">×</button>`;
    $('.recent-project-main', row).onclick = async () => { closeProjectManager(); const previous = app.workspace; $('#workspacePath').value = item.path; try { const result = await switchWorkspace(item.path); if (!result?.cancelled) rememberRecentProject(result.workspace); } catch (error) { $('#workspacePath').value = previous || ''; toast(error.message, 'error'); } };
    $('.sm-btn', row).onclick = () => { try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects().filter((entry) => workspacePathKey(entry.path) !== workspacePathKey(item.path)))); } catch {} renderRecentProjects(); };
    host.append(row);
  }
  if (!host.childElementCount) host.innerHTML = '<div class="empty-state">No recent projects yet.</div>';
}

function openProjectManager() { renderRecentProjects(); $('#projectManagerModal')?.classList.remove('hidden'); }
function closeProjectManager() { $('#projectManagerModal')?.classList.add('hidden'); }
function closeProjectWizard() { $('#projectWizardModal')?.classList.add('hidden'); projectWizardState = null; }

function projectJoinPreview(parent, name) {
  const base = String(parent || '').replace(/[\\/]+$/, ''); const child = String(name || '').trim();
  if (!base || !child) return '—'; const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'; return `${base}${sep}${child}`;
}

function updateProjectWizardFinalPath() {
  const final = projectJoinPreview($('#projectWizardParent')?.value, $('#projectWizardName')?.value);
  if ($('#projectWizardFinalPath')) $('#projectWizardFinalPath').textContent = final;
  if ($('#projectWizardCreate')) $('#projectWizardCreate').disabled = final === '—';
}

function defaultProjectParent() {
  if (app.workspace) return app.workspace.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || app.workspace;
  const recent = recentProjects()[0]?.path || '';
  return recent ? recent.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || recent : '';
}

function openNewProjectWizard() {
  projectWizardState = { mode: 'new' };
  $('#projectWizardTitle').textContent = 'New Project';
  $('#projectWizardSubtitle').textContent = 'Choose a name, parent folder, and starting template.';
  $('#projectWizardSource').classList.add('hidden'); $('#projectWizardSource').innerHTML = '';
  $('#projectWizardTemplateRow').classList.remove('hidden');
  $('#projectWizardName').value = ''; $('#projectWizardParent').value = defaultProjectParent(); $('#projectWizardTemplate').value = 'empty';
  $('#projectWizardHint').textContent = 'Studio creates the final project folder for you. Git onboarding appears after the folder opens.';
  updateProjectWizardFinalPath(); closeProjectManager(); $('#projectWizardModal').classList.remove('hidden'); setTimeout(() => $('#projectWizardName')?.focus?.(), 0);
}

function openProjectFromSessionWizard(sessionPath, nodeId, promptText) {
  const checkpoint = app.checkpoints?.[nodeId] || null;
  if (!checkpoint?.commit && typeof window.confirm === 'function' && !window.confirm('This prompt has no historical Git checkpoint. Studio can create a new project from the CURRENT workspace code and fork the session, but cannot reconstruct the exact historical code state. Continue?')) return;
  projectWizardState = { mode: 'session', context: captureWorkspaceContext(), sessionPath, nodeId, promptText, checkpoint, wasPiRunning: Boolean(app.pi.status?.running) };
  $('#projectWizardTitle').textContent = 'Create Project from Prompt';
  $('#projectWizardSubtitle').textContent = 'Choose where the isolated project should live. Studio creates the folder for you.';
  $('#projectWizardSource').classList.remove('hidden');
  $('#projectWizardSource').innerHTML = `<strong>${escapeHtml(truncate(promptText, 120))}</strong><br><span class="muted">${checkpoint?.commit ? `Historical Git checkpoint ${escapeHtml(checkpoint.commit.slice(0, 10))} · isolated worktree` : 'No checkpoint · current-workspace fallback copy'}</span>`;
  $('#projectWizardTemplateRow').classList.add('hidden');
  $('#projectWizardName').value = `${projectDisplayName(app.workspace)}-branch`;
  $('#projectWizardParent').value = defaultProjectParent();
  $('#projectWizardHint').textContent = checkpoint?.commit ? 'The original project stays untouched. A new Git worktree and forked Pi session will be created.' : 'The original project stays untouched. Current workspace files are copied without .git, node_modules, or old Studio sessions.';
  updateProjectWizardFinalPath(); $('#projectWizardModal').classList.remove('hidden'); setTimeout(() => $('#projectWizardName')?.select?.(), 0);
}

async function createProjectFromWizard() {
  const state = projectWizardState; if (!state) return;
  const name = String($('#projectWizardName')?.value || '').trim(); const parentDir = String($('#projectWizardParent')?.value || '').trim();
  if (!name) return toast('Project name is required', 'error'); if (!parentDir) return toast('Choose a parent folder', 'error');
  const button = $('#projectWizardCreate'); setBusy(button, true, 'Creating…');
  try {
    let res;
    if (state.mode === 'session') {
      res = await post('/api/sessions/create-project', { workspace: state.context.workspace, sessionPath: state.sessionPath, targetNodeId: state.nodeId, name, parentDir, useCheckpoint: Boolean(state.checkpoint?.commit) });
      if (!workspaceContextIsCurrent(state.context)) { if (res?.workspacePath) toast(`Project created at ${res.workspacePath}; current workspace changed, so Studio did not auto-open it.`, 'success'); closeProjectWizard(); return; }
    } else {
      res = await post('/api/projects/create', { name, parentDir, template: $('#projectWizardTemplate')?.value || 'empty' });
    }
    if (!res?.workspacePath) throw new Error(res?.error || 'Project creation failed');
    closeProjectWizard();
    const switched = await switchWorkspace(res.workspacePath); if (switched?.cancelled) return;
    rememberRecentProject(switched.workspace);
    if (state.mode === 'session' && res.sessionPath) {
      if (state.wasPiRunning && getSelectedModelId()) await startPi(res.sessionPath, `${res.projectName} Initial Session`);
      else await inspectSessionTree(res.sessionPath);
    }
    toast(state.mode === 'session' ? `Project created from session · ${res.projectName}` : `Project created · ${res.projectName}`, 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); updateProjectWizardFinalPath(); }
}

// ── In-App Folder Browser Modal Controller ──────────────────────────────
let currentBrowserState = { current: '', parent: null, drives: [], folders: [], selected: '' };

async function openFolderBrowserModal(startPath = '', { onSelect = null, title = 'Select Workspace Folder', confirmLabel = 'Select Workspace' } = {}) {
  folderBrowserSelectHandler = onSelect;
  const modal = $('#folderBrowserModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const heading = $('#folderBrowserModal .modal-header h3'); if (heading) heading.textContent = `📁 ${title}`;
  if ($('#confirmSelectFolder')) $('#confirmSelectFolder').textContent = confirmLabel;
  // Start at the current workspace folder if set, otherwise load root (drives list)
  const targetPath = startPath || app.workspace || $('#workspacePath').value || 'root';
  await loadBrowseDirectory(targetPath === 'root' ? '' : targetPath);
}

function closeFolderBrowserModal() {
  const modal = $('#folderBrowserModal');
  if (modal) modal.classList.add('hidden');
  folderBrowserSelectHandler = null;
}

async function loadBrowseDirectory(targetPath = '') {
  try {
    const data = await api(`/api/workspace/browse?path=${encodeURIComponent(targetPath)}`);
    if (data.ok) {
      currentBrowserState = {
        current: data.current,
        parent: data.parent,
        drives: data.drives || [],
        folders: data.folders || [],
        selected: data.current
      };
      renderFolderBrowserModal();
    } else {
      toast(data.error || 'Failed to list directory', 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderFolderBrowserModal() {
  const { current, parent, drives, folders } = currentBrowserState;
  // The selected path is always the current directory you're browsing
  currentBrowserState.selected = current;
  if ($('#selectedFolderPath')) $('#selectedFolderPath').value = current;

  // Render Drives
  const driveBar = $('#driveBar');
  if (driveBar) {
    driveBar.innerHTML = '';
    for (const drive of drives) {
      const btn = document.createElement('button');
      btn.className = `drive-btn ${current.toLowerCase().startsWith(drive.path.toLowerCase()) ? 'active' : ''}`;
      btn.textContent = drive.name;
      btn.onclick = () => loadBrowseDirectory(drive.path);
      driveBar.append(btn);
    }
  }

  // Render Parent Up Button
  const upBtn = $('#folderNavUp');
  if (upBtn) {
    upBtn.disabled = !parent;
    upBtn.onclick = () => parent && loadBrowseDirectory(parent);
  }

  // Render New Folder Button — inline mini-form, no prompt()
  const newFolderBtn = $('#folderNavNewFolder');
  if (newFolderBtn) {
    newFolderBtn.onclick = () => {
      // Prevent double-rendering
      if ($('#inlineNewFolderForm')) return;

      const form = document.createElement('div');
      form.id = 'inlineNewFolderForm';
      form.style.cssText = 'display:flex;gap:6px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--panel-2);';
      form.innerHTML = `
        <input id="newFolderNameInput" placeholder="New folder name…" style="flex:1;padding:5px 9px;background:#090b0e;border:1px solid var(--border);border-radius:6px;font:12px var(--mono);color:var(--text);">
        <button id="newFolderCreate" class="sm-btn primary" style="white-space:nowrap;">✓ Create</button>
        <button id="newFolderCancel" class="sm-btn ghost" aria-label="Cancel new folder">✕</button>
      `;

      const modalBody = $('#folderBrowserModal .modal-body');
      if (modalBody) modalBody.prepend(form);

      const input = $('#newFolderNameInput');
      if (input) { input.focus(); }

      const cleanup = () => { form.remove(); };

      $('#newFolderCancel').onclick = cleanup;

      const doCreate = async () => {
        const name = input?.value?.trim();
        if (!name) { input?.focus(); return; }
        try {
          const res = await post('/api/workspace/mkdir', { parent: currentBrowserState.current, name });
          toast(`Folder created: ${res.name}`, 'success');
          cleanup();
          await loadBrowseDirectory(res.path);
        } catch (e) {
          toast(e.message, 'error');
        }
      };

      $('#newFolderCreate').onclick = doCreate;
      if (input) input.onkeydown = (e) => { if (e.key === 'Enter') doCreate(); if (e.key === 'Escape') cleanup(); };
    };
  }

  // Render Breadcrumbs
  const breadcrumbs = $('#folderBreadcrumbs');
  if (breadcrumbs) {
    breadcrumbs.innerHTML = '';
    const parts = current.split(/[/\\]/).filter(Boolean);
    let accumulated = current.startsWith('/') ? '/' : '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated += (accumulated.endsWith('/') || accumulated.endsWith('\\') || !accumulated ? '' : '/') + part;
      if (i === 0 && accumulated.endsWith(':')) accumulated += '/';
      const currentAcc = accumulated;
      const btn = document.createElement('button');
      btn.className = 'crumb-btn';
      btn.textContent = part;
      btn.onclick = () => loadBrowseDirectory(currentAcc);
      breadcrumbs.append(btn);
      if (i < parts.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = ' / ';
        breadcrumbs.append(sep);
      }
    }
  }

  // Render Folders Grid — single click navigates into folder (current dir = selection)
  const grid = $('#folderGrid');
  if (grid) {
    grid.innerHTML = '';
    if (!folders.length) {
      grid.innerHTML = '<div class="empty-state">No subfolders here — this folder is selected. Click "Select Workspace" to open it.</div>';
      return;
    }

    for (const folder of folders) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'folder-card';
      card.title = `Click to open: ${folder.name}`;
      card.setAttribute('aria-label', `Open folder ${folder.name}`);
      card.innerHTML = `<span class="folder-card-icon">📁</span><span class="folder-card-name">${escapeHtml(folder.name)}</span>`;
      // Single click = navigate into folder (making it the selected workspace)
      card.onclick = () => loadBrowseDirectory(folder.path);
      grid.append(card);
    }
  }
}
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
$('#newSession').onclick = () => openSessionLauncher({ title: 'New Pi Session' });
$('#startPi').onclick = () => openSessionLauncher({ title: 'Start Pi Session' }); $('#stopPi').onclick = () => stopPi(); $('#restartPi').onclick = () => restartPiForResources(); $('#restartPiResources').onclick = () => restartPiForResources();
if ($('#topHarness')) $('#topHarness').onchange = () => executeAppCommand('harness.select', $('#topHarness').value);
if ($('#sessionLaunchModel')) $('#sessionLaunchModel').onchange = () => {
  const custom = $('#sessionLaunchModel').value === '__custom__';
  $('#sessionLaunchCustomModel')?.classList.toggle('hidden', !custom);
  renderSessionModelState();
};
if ($('#sessionLaunchCustomModel')) $('#sessionLaunchCustomModel').oninput = renderSessionModelState;
if ($('#sessionLaunchHarness')) $('#sessionLaunchHarness').onchange = renderSessionHarnessDetails;
if ($('#closeSessionLauncher')) $('#closeSessionLauncher').onclick = closeSessionLauncher;
if ($('#cancelSessionLauncher')) $('#cancelSessionLauncher').onclick = closeSessionLauncher;
if ($('#confirmSessionLauncher')) $('#confirmSessionLauncher').onclick = applySessionLauncherSelection;
if ($('#sessionLauncherModal')) $('#sessionLauncherModal').addEventListener('click', (event) => { if (event.target === $('#sessionLauncherModal')) closeSessionLauncher(); });
$('#topModel').onchange = async () => {
  const isCustom = $('#topModel').value === '__custom__';
  $('#customModelInput').classList.toggle('hidden', !isCustom);
  renderActiveModel();
  const selected = getSelectedModelId();
  if (!selected || isCustom) return;
  await chooseModel(selected);
};
$('#customModelInput').onchange = async () => {
  const selected = getSelectedModelId();
  if (!selected) return;
  await chooseModel(selected);
};
$('#thinkingLevel').onchange = async () => {
  const level = $('#thinkingLevel').value;
  try { localStorage.setItem('studio_thinking_level', level); } catch {}
  if (!app.pi.status?.running) return;
  rpc({ type: 'set_thinking_level', level }, { quiet: true }).then(() => { refreshSnapshot(); refreshMessages(); }).catch((error) => { toast(error.message, 'error'); refreshMessages(); });
};
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
function bindEditorPane(paneId) {
  const dom = paneDom(paneId);
  if (!dom.editor || !dom.pane) return;
  dom.editor.addEventListener('focus', () => activateWorkbenchPane(paneId));
  // The pane wrapper sees Monaco mouse events after Monaco has positioned the caret.
  // Never re-render the editor from this handler or the saved selection can win.
  dom.pane.addEventListener('mousedown', () => activateWorkbenchPane(paneId));
  dom.editor.addEventListener('input', () => { app.workbench.setActivePane(paneId); app.workbench.updateContent(dom.editor.value, { paneId }); renderBufferTabs(); syncLegacyEditorState(); updateWorkbenchStatus(); renderPane(paneId); schedulePersistWorkbenchState(); });
}
bindEditorPane('primary');
bindEditorPane('secondary');
installEditorSplitDragging();
$('#saveFile').onclick = () => saveFile();
$('#saveAllFiles')?.addEventListener('click', () => executeAppCommand('file.saveAll')); 
$('#reloadFile').onclick = () => reloadActiveFile();
$('#prevBuffer')?.addEventListener('click', () => executeAppCommand('editor.previousBuffer'));
$('#nextBuffer')?.addEventListener('click', () => executeAppCommand('editor.nextBuffer'));
$('#splitVertical')?.addEventListener('click', () => executeAppCommand('editor.splitVertical'));
$('#splitHorizontal')?.addEventListener('click', () => executeAppCommand('editor.splitHorizontal'));
$('#closeSplit')?.addEventListener('click', () => executeAppCommand('editor.closeSplit'));
$('#editorFind')?.addEventListener('click', () => executeAppCommand('editor.find'));
$('#editorReplace')?.addEventListener('click', () => executeAppCommand('editor.replace'));
$('#restartLsp')?.addEventListener('click', () => executeAppCommand('lsp.restart'));
$('#workspaceSearchBtn')?.addEventListener('click', () => searchWorkspaceUi());
$('#workspaceSearchInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchWorkspaceUi(); } else if (event.key === 'Escape') { event.target.value = ''; searchWorkspaceUi(''); } });
$('#problemSeverityFilter')?.addEventListener('change', (event) => { app.problemSeverityFilter = event.target.value || 'all'; app.currentProblemIndex = 0; renderProblems(); });
$('#gitDiffNext')?.addEventListener('click', () => executeAppCommand('git.diffNext'));
$('#gitDiffPrevious')?.addEventListener('click', () => executeAppCommand('git.diffPrevious'));
$('#gitDiffMode')?.addEventListener('click', () => executeAppCommand('git.toggleDiffMode'));
$('#gitAskAgent')?.addEventListener('click', () => executeAppCommand('git.askAgent'));
$('#gitOpenFile')?.addEventListener('click', () => executeAppCommand('git.openSelected'));
$('#gitToggleStage')?.addEventListener('click', () => executeAppCommand('git.toggleStageSelected'));
$('#gitCopyPatch')?.addEventListener('click', () => executeAppCommand('git.copyPatch'));
$('#gitRestoreFile')?.addEventListener('click', () => executeAppCommand('git.restoreSelected'));
updateGitDiffActions();
$('#gitRefreshBtn')?.addEventListener('click', () => loadGitPanel());
$('#gitStageAllBtn')?.addEventListener('click', async () => { try { await post('/api/workspace/git/stage', { workspace: app.workspace, all: true, stage: true }); await loadGitPanel(); } catch (e) { toast(e.message, 'error'); } });
$('#gitCommitBtn')?.addEventListener('click', gitCommit);
window.addEventListener('beforeunload', persistWorkbenchState);
$('#refreshResources')?.addEventListener('click', async () => {
  await loadPiPlatform({ quiet: false }).catch(() => {});
  if (app.pi.status?.running) await loadCommands().catch(() => {});
});
$('#resourceSearch')?.addEventListener('input', (event) => { app.resources.query = event.target.value; if (app.platform.tab === 'commands') renderPiResources(); else renderPlatformTab(); });
$$('#resourceFilterBar button').forEach((button) => button.addEventListener('click', () => {
  app.resources.filter = button.dataset.resourceFilter || 'all';
  $$('#resourceFilterBar button').forEach((item) => item.classList.toggle('active', item === button));
  renderPiResources();
}));
$('#refreshTree').onclick = () => loadSessionTree(false);
if ($('#showDiffView')) $('#showDiffView').onclick = () => { switchView('git'); loadGit(); };
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
if ($('#pullModelName')) $('#pullModelName').oninput = () => updatePullModelAction();
if ($('#loadCurrentModelBtn')) $('#loadCurrentModelBtn').onclick = () => loadCurrentModelIntoProfile();
if ($('#applyPreset3090')) $('#applyPreset3090').onclick = apply3090Preset;
$('#saveRuntime').onclick = saveRuntime; $('#saveCommands').onclick = saveCommands; $('#syncModels').onclick = async () => { try { await post('/api/ollama/sync'); toast('Models synchronized to Pi', 'success'); } catch (e) { toast(e.message, 'error'); } };
$('#ttsStatus')?.addEventListener('click', () => refreshTtsStatus());
$('#ttsWake')?.addEventListener('click', () => ttsLifecycle('wake'));
$('#ttsSleep')?.addEventListener('click', () => ttsLifecycle('sleep'));
$('#ttsGenerate')?.addEventListener('click', () => generateTtsAudio());
$('#ttsBrowserSpeak')?.addEventListener('click', () => speakWithBrowser());
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
if ($('#testOllamaConnection')) $('#testOllamaConnection').onclick = () => executeAppCommand('ollama.testRuntime');
if ($('#useTestedOllama')) $('#useTestedOllama').onclick = () => executeAppCommand('ollama.useTestedRuntime');
async function runManagedOllamaAction(action) {
  const button = $(`#${action}Managed`);
  setBusy(button, true, action === 'start' ? 'Starting…' : action === 'restart' ? 'Restarting…' : 'Stopping…');
  try {
    const value = await post(`/api/ollama/managed/${action}`);
    app.managedOllama = value.status || app.managedOllama;
    await refreshLiveStatus();
    toast(`Managed Ollama ${action === 'stop' ? 'stopped' : action === 'restart' ? 'restarted' : 'started'}`, action === 'stop' ? '' : 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); renderOllamaRuntimeStatus(); }
}
$('#startManaged').onclick = () => runManagedOllamaAction('start');
$('#restartManaged').onclick = () => runManagedOllamaAction('restart');
$('#stopManaged').onclick = () => runManagedOllamaAction('stop');
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
    setProblemsForSource('Bash', parseTextDiagnostics($('#bashOutput').textContent, { source: 'Bash' }));
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
window.addEventListener('beforeunload', (e) => { if (app.workbench.buffers.some((buffer) => buffer.dirty)) { e.preventDefault(); e.returnValue = ''; } });

if ($('#newIntegratedTerminal')) $('#newIntegratedTerminal').onclick = () => newIntegratedTerminal('primary');
if ($('#splitTerminal')) $('#splitTerminal').onclick = splitIntegratedTerminal;
if ($('#closeTerminalSplit')) $('#closeTerminalSplit').onclick = closeTerminalSplit;
if ($('#killIntegratedTerminal')) $('#killIntegratedTerminal').onclick = () => killTerminalSession();
if ($('#launchDesktopTerminal')) $('#launchDesktopTerminal').onclick = () => launchTerminalSession(false);
if ($('#refreshTerminalSessions')) $('#refreshTerminalSessions').onclick = () => loadTerminalSessions();
if ($('#terminalSearchPrev')) $('#terminalSearchPrev').onclick = () => terminalSearch(-1);
if ($('#terminalSearchNext')) $('#terminalSearchNext').onclick = () => terminalSearch(1);
if ($('#terminalSearchInput')) $('#terminalSearchInput').onkeydown = (e) => { if (e.key === 'Enter') terminalSearch(e.shiftKey ? -1 : 1); };
if ($('#gitCommitMessage')) $('#gitCommitMessage').onkeydown = (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); gitCommit(); } };
if ($('#runWebConsole')) $('#runWebConsole').onclick = executeWebConsoleCommand;
if ($('#webConsoleInput')) $('#webConsoleInput').onkeydown = (e) => { if (e.key === 'Enter') executeWebConsoleCommand(); };
if ($('#runAllTests')) $('#runAllTests').onclick = () => runTestsUi(null);
if ($('#rerunTests')) $('#rerunTests').onclick = () => runTestsUi(app.tests.lastTarget, app.tests.lastTestName || '');
if ($('#refreshTests')) $('#refreshTests').onclick = discoverTestsUi;
if ($('#testAskPi')) $('#testAskPi').onclick = askPiAboutTestFailure;
if ($('#testOpenTerminal')) $('#testOpenTerminal').onclick = () => { switchView('terminal'); newIntegratedTerminal('primary'); };
installTerminalPaneInteractions();
installTerminalSplitDragging();

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

async function resolveMessageEntryId(msgNode, forkTrigger) {
  let entryId = forkTrigger?.dataset?.forkEntry || msgNode?.dataset?.forkEntry || msgNode?.dataset?.id;
  if (entryId) return entryId;
  try {
    const res = await rpc({ type: 'get_entries' }, { quiet: true });
    const entries = Array.isArray(res?.data) ? res.data : (res?.data?.entries || []);
    if (!entries.length) return null;
    const userText = ($('.message-text', msgNode)?.textContent || '').trim();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const eid = entry.id || entry.nodeId;
      if (eid && (entry.message?.role === 'user' || entry.role === 'user')) {
        const text = (entry.message?.content || entry.content || entry.text || '').trim();
        if (!userText || text === userText || text.includes(userText.slice(0, 30)) || userText.includes(text.slice(0, 30))) {
          msgNode.dataset.forkEntry = eid;
          msgNode.dataset.id = eid;
          if (forkTrigger) forkTrigger.dataset.forkEntry = eid;
          return eid;
        }
      }
    }
    const lastUserEntry = [...entries].reverse().find((e) => (e.id || e.nodeId) && (e.message?.role === 'user' || e.role === 'user'));
    if (lastUserEntry) {
      const eid = lastUserEntry.id || lastUserEntry.nodeId;
      msgNode.dataset.forkEntry = eid;
      msgNode.dataset.id = eid;
      if (forkTrigger) forkTrigger.dataset.forkEntry = eid;
      return eid;
    }
  } catch { /* fallback failed */ }
  return null;
}

// ── Fork from chat — click event on user message fork buttons ────────────
$('#messages').addEventListener('click', async (e) => {
  const forkTrigger = e.target.closest('.msg-fork-btn, [data-fork-entry]');
  if (!forkTrigger) return;

  if (!app.pi.status?.running) {
    toast('Please click "Start Pi" first before forking messages', 'error');
    return;
  }

  const msgNode = forkTrigger.closest('.message') || forkTrigger;
  let entryId = await resolveMessageEntryId(msgNode, forkTrigger);

  if (!entryId) {
    toast('Message entry ID is pending. Please wait a moment for entry to register.', 'error');
    return;
  }

  try {
    if (forkTrigger.tagName === 'BUTTON') setBusy(forkTrigger, true, 'Forking…');
    await rpc({ type: 'fork', entryId });
    await refreshMessages();
    await loadSessionTree();
    toast('Branch forked from this message', 'success');
    switchView('tree');
  } catch (e) {
    toast(e.message || 'Failed to fork branch', 'error');
  } finally {
    if (forkTrigger.tagName === 'BUTTON') setBusy(forkTrigger, false);
  }
});

// ── Session Tree & Branching Controller ────────────────────────────────────
async function inspectSessionTree(sessionPath) {
  if (!sessionPath) return;
  const context = captureWorkspaceContext();
  try {
    const data = await api(`/api/session/inspect?workspace=${encodeURIComponent(context.workspace)}&path=${encodeURIComponent(sessionPath)}`);
    if (!workspaceContextIsCurrent(context)) return;
    if (data.ok && data.session) {
      app.currentInspectedSession = { path: sessionPath, ...data.session };
      app.currentTreeSessionPath = sessionPath;
      sessionTreeData = data.session.tree || [];
      await loadCheckpoints();
      renderSessionTree();
      switchView('tree');
    }
  } catch (e) {
    if (workspaceContextIsCurrent(context)) toast(`Failed to inspect session: ${e.message}`, 'error');
  }
}

function updateSessionOperationState() {
  const button = $('#sessionOperationConfirm');
  if (button) button.disabled = !pendingSessionOperation || !String($('#sessionOperationName')?.value || '').trim();
}

function closeSessionOperationDialog() {
  pendingSessionOperation = null;
  $('#sessionOperationModal')?.classList.add('hidden');
  const button = $('#sessionOperationConfirm');
  if (button) { setBusy(button, false); button.disabled = true; }
}

function openSessionOperationDialog(kind, sessionPath, nodeId = null) {
  if (!sessionPath) return toast('No session selected', 'error');
  const isFork = kind === 'fork';
  pendingSessionOperation = { kind: isFork ? 'fork' : 'clone', sessionPath, nodeId, context: captureWorkspaceContext() };
  $('#sessionOperationTitle').textContent = isFork ? 'Fork session' : 'Clone session';
  $('#sessionOperationMessage').textContent = isFork
    ? 'Create a new session containing only the selected node ancestry, then open that branch.'
    : 'Create an independent full copy of this session in the current project.';
  $('#sessionOperationName').value = '';
  $('#sessionOperationConfirm').textContent = isFork ? 'Fork Session' : 'Clone Session';
  $('#sessionOperationModal').classList.remove('hidden');
  updateSessionOperationState();
  requestAnimationFrame(() => $('#sessionOperationName')?.focus());
}

async function submitSessionOperation() {
  const operation = pendingSessionOperation;
  const name = String($('#sessionOperationName')?.value || '').trim();
  if (!operation || !name) return updateSessionOperationState();
  if (!workspaceContextIsCurrent(operation.context)) {
    closeSessionOperationDialog();
    return toast('The project changed. Open the session dialog again in the active project.', 'error');
  }
  const button = $('#sessionOperationConfirm');
  setBusy(button, true, operation.kind === 'fork' ? 'Forking…' : 'Cloning…');
  try {
    const res = await post(operation.kind === 'fork' ? '/api/sessions/fork' : '/api/sessions/clone', {
      workspace: operation.context.workspace,
      sessionPath: operation.sessionPath,
      ...(operation.kind === 'fork' ? { targetNodeId: operation.nodeId } : {}),
      name
    });
    if (!workspaceContextIsCurrent(operation.context)) return;
    if (res.ok) {
      await loadSessions();
      if (operation.kind === 'fork') {
        const targetPath = res.path || operation.sessionPath;
        if (app.pi.status?.running) await startPi(targetPath, name);
        else await inspectSessionTree(targetPath);
      }
      toast(`${operation.kind === 'fork' ? 'Forked' : 'Cloned'} session: ${res.fileName}`, 'success');
      closeSessionOperationDialog();
    } else {
      toast(res.error || `Failed to ${operation.kind} session`, 'error');
    }
  } catch (e) {
    if (workspaceContextIsCurrent(operation.context)) toast(e.message, 'error');
  } finally {
    if (pendingSessionOperation === operation) {
      setBusy(button, false);
      updateSessionOperationState();
    }
  }
}

function promptForkSession(sessionPath, nodeId = null) { openSessionOperationDialog('fork', sessionPath, nodeId); }
function promptCloneSession(sessionPath) { openSessionOperationDialog('clone', sessionPath); }

function promptCreateAppFromNode(sessionPath, nodeId, promptText) { openProjectFromSessionWizard(sessionPath, nodeId, promptText); }

if ($('#refreshSessions')) $('#refreshSessions').onclick = loadSessions;
if ($('#refreshTree')) $('#refreshTree').onclick = () => app.currentInspectedSession?.path && inspectSessionTree(app.currentInspectedSession.path);
if ($('#harnessStartSession')) $('#harnessStartSession').onclick = () => executeAppCommand('session.new');
if ($('#harnessNew')) $('#harnessNew').onclick = () => executeAppCommand('harness.new');
if ($('#harnessSaveEffective')) $('#harnessSaveEffective').onclick = () => executeAppCommand('harness.saveEffective');
if ($('#harnessOpenResources')) $('#harnessOpenResources').onclick = () => { switchView('resources'); loadPiPlatform({ quiet: true }).catch(() => {}); };
if ($('#harnessOpenMcp')) $('#harnessOpenMcp').onclick = () => switchSettings('mcp');
if ($('#harnessOpenAdvanced')) $('#harnessOpenAdvanced').onclick = () => switchSettings('advanced');
if ($('#harnessBuilderClose')) $('#harnessBuilderClose').onclick = closeHarnessBuilder;
if ($('#harnessBuilderCancel')) $('#harnessBuilderCancel').onclick = closeHarnessBuilder;
if ($('#harnessBuilderSave')) $('#harnessBuilderSave').onclick = saveHarnessBuilder;
if ($('#harnessBuilderName')) $('#harnessBuilderName').oninput = updateHarnessBuilderSaveState;
if ($('#harnessBuilderScope')) $('#harnessBuilderScope').onchange = updateHarnessBuilderSaveState;
if ($('#harnessBuilderDefaultTools')) $('#harnessBuilderDefaultTools').onchange = (event) => setHarnessToolPicker(event.target.checked ? null : []);
if ($('#harnessBuilderResources')) $('#harnessBuilderResources').onclick = () => { closeHarnessBuilder(); switchView('resources'); loadPiPlatform({ quiet: true }).catch(() => {}); };
if ($('#harnessBuilderMcp')) $('#harnessBuilderMcp').onclick = () => { closeHarnessBuilder(); switchSettings('mcp'); };
if ($('#harnessBuilderMarketplace')) $('#harnessBuilderMarketplace').onclick = () => packageMarketplace?.open?.();
if ($('#sessionOperationName')) $('#sessionOperationName').oninput = updateSessionOperationState;
if ($('#sessionOperationName')) $('#sessionOperationName').onkeydown = (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitSessionOperation(); }
  else if (event.key === 'Escape') closeSessionOperationDialog();
};
if ($('#sessionOperationConfirm')) $('#sessionOperationConfirm').onclick = submitSessionOperation;
if ($('#sessionOperationCancel')) $('#sessionOperationCancel').onclick = closeSessionOperationDialog;
if ($('#sessionOperationClose')) $('#sessionOperationClose').onclick = closeSessionOperationDialog;
if ($('#sessionOperationModal')) $('#sessionOperationModal').onclick = (event) => { if (event.target.id === 'sessionOperationModal') closeSessionOperationDialog(); };

installInteractionLayer();
initialize();
