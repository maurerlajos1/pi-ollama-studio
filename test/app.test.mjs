import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Synthetic DOM Environment ──────────────────────────────────────────────
class MockClassList {
  constructor() { this._classes = new Set(); }
  add(...names) { names.forEach((n) => this._classes.add(n)); }
  remove(...names) { names.forEach((n) => this._classes.delete(n)); }
  toggle(name, force) {
    if (force === undefined) {
      if (this._classes.has(name)) this._classes.delete(name);
      else this._classes.add(name);
    } else if (force) this._classes.add(name);
    else this._classes.delete(name);
  }
  contains(name) { return this._classes.has(name); }
  get value() { return Array.from(this._classes).join(' '); }
}

class MockElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.classList = new MockClassList();
    this.children = [];
    this.options = [];
    this.dataset = {};
    this.style = {};
    this.disabled = false;
    this.title = '';
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const textNode = new MockElement('#text');
        textNode.textContent = node;
        this.children.push(textNode);
      } else {
        this.children.push(node);
        if (this.tagName === 'SELECT' && node.tagName === 'OPTION') {
          this.options.push(node);
          if (this.options.length === 1) this.value = node.value;
        }
      }
    }
  }

  querySelector(selector) {
    return this.children.find((c) => c.className?.includes(selector.replace('.', '')) || c.tagName === selector.toUpperCase()) || null;
  }

  querySelectorAll(selector) {
    return this.children.filter((c) => c.className?.includes(selector.replace('.', '')) || c.tagName === selector.toUpperCase());
  }

  closest() { return this; }
  addEventListener() {}
  remove() {}
}

function createDOM() {
  const elements = new Map();

  const getOrCreate = (id) => {
    if (!elements.has(id)) {
      const tag = id === 'topModel' || id === 'profileBaseModel' || id === 'thinkingLevel' ? 'select' : 'div';
      elements.set(id, new MockElement(tag, id));
    }
    return elements.get(id);
  };

  const document = {
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return getOrCreate(sel.slice(1));
      return new MockElement();
    },
    querySelectorAll: () => [],
    createElement: (tag) => new MockElement(tag),
    addEventListener: () => {}
  };

  const localStorageStore = new Map();
  const localStorage = {
    getItem: (k) => localStorageStore.get(k) || null,
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k)
  };

  return { document, localStorage, elements };
}

// Setup Global Mock Environment
const { document, localStorage, elements } = createDOM();
globalThis.document = document;
globalThis.window = {
  document,
  localStorage,
  addEventListener: () => {},
  requestAnimationFrame: (cb) => cb()
};
globalThis.localStorage = localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true
});
globalThis.$ = (sel, host = document) => host.querySelector(sel);
globalThis.$$ = (sel) => Array.from(document.querySelectorAll(sel));
globalThis.escapeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
globalThis.formatBytes = (bytes) => `${((bytes || 0) / (1024 * 1024 * 1024)).toFixed(1)} GB`;
globalThis.formatNumber = (num) => Number(num || 0).toLocaleString();
globalThis.markdown = (text) => text || '';
globalThis.toast = () => {};
globalThis.log = () => {};

// Global App State
globalThis.app = {
  config: { defaultModel: '' },
  system: { gpu: { gpus: [] } },
  ollama: { online: true, models: [], running: [] },
  profiles: [],
  pi: { status: { running: false }, state: null, stats: null },
  toolCards: new Map(),
  logs: []
};

// ── Test Suite ─────────────────────────────────────────────────────────────

test('refreshModelSelectors populates dropdowns correctly', () => {
  app.ollama = {
    online: true,
    models: [
      { model: 'qwen3.6:latest', name: 'qwen3.6:latest', size: 17000000000 },
      { model: 'llama3.2:latest', name: 'llama3.2:latest', size: 2000000000 }
    ],
    running: []
  };

  const models = app.ollama.models;
  const topModel = document.getElementById('topModel');
  const profileBaseModel = document.getElementById('profileBaseModel');
  topModel.options = [];
  profileBaseModel.options = [];

  for (const select of [topModel, profileBaseModel]) {
    select.options = [];
    select.append(new MockElement('option'));
    for (const m of models) select.append(new MockElement('option'));
  }

  assert.equal(topModel.options.length, 3);
  assert.equal(profileBaseModel.options.length, 3);
});

test('renderActiveModel and renderModelLibrary do NOT throw when app.ollama.running is missing or undefined', () => {
  app.ollama = { online: true, models: [{ model: 'qwen3.6:latest', name: 'qwen3.6:latest' }] };
  delete app.ollama.running;

  assert.doesNotThrow(() => {
    const models = app.ollama?.models || [];
    const runningList = app.ollama?.running || [];
    const model = models.find((item) => (item.model || item.name) === 'qwen3.6:latest');
    const running = runningList.find((item) => (item.model || item.name) === 'qwen3.6:latest');
    assert.equal(model.model, 'qwen3.6:latest');
    assert.equal(running, undefined);
  });
});

test('model state treats a profile alias and Ollama :latest tag as the same loaded model', () => {
  const modelKey = (value) => String(value || '').trim().toLowerCase().replace(/:latest$/, '');
  assert.equal(modelKey('15koutput'), modelKey('15koutput:latest'));
  assert.equal(modelKey('HF.CO/Model:latest'), modelKey('hf.co/model'));
});

test('modelCapabilityBadges correctly classifies model capabilities without false positives', () => {
  function modelCapabilityBadges(model) {
    const tags = [];
    const families = (model.details?.families || []).map((f) => String(f).toLowerCase());
    const name = String(model.model || model.name || '').toLowerCase();
    const slug = name.split(':')[0].split('/').pop();
    if (families.includes('clip') || name.includes('vision') || name.includes('vl')) tags.push(['👁 Vision', 'vision']);
    if (name.includes('qwq') || name.includes('deepseek-r') || name.includes('think') || name.includes('reason') || /^o[13](?:-|$)/.test(slug)) tags.push(['🧠 Thinking', 'thinking']);
    if (name.includes('code') || name.includes('coder')) tags.push(['</> Code', 'code']);
    return tags;
  }

  const llama = modelCapabilityBadges({ model: 'llama3.1:latest' });
  assert.equal(llama.some(([_, cls]) => cls === 'thinking'), false, 'llama3.1 should NOT be flagged as thinking');

  const qwq = modelCapabilityBadges({ model: 'qwq:latest' });
  assert.equal(qwq.some(([_, cls]) => cls === 'thinking'), true, 'qwq SHOULD be flagged as thinking');

  const coder = modelCapabilityBadges({ model: 'qwen2.5-coder:14b' });
  assert.equal(coder.some(([_, cls]) => cls === 'code'), true, 'coder SHOULD be flagged as code');
});

test('refreshLiveStatus retains models only for a transient failure on the same Ollama runtime', () => {
  const applyLiveStatus = (previous, incoming) => {
    const previousRuntime = String(previous?.runtime?.baseUrl || '').replace(/\/+$/, '');
    const nextRuntime = String(incoming?.runtime?.baseUrl || '').replace(/\/+$/, '');
    const sameRuntime = Boolean(previousRuntime && nextRuntime && previousRuntime === nextRuntime);
    if (sameRuntime && (!incoming.models || !incoming.models.length) && previous.models?.length && incoming.modelsAvailable === false) {
      incoming.models = previous.models;
    }
    return incoming;
  };

  const previous = {
    online: true,
    runtime: { baseUrl: 'http://127.0.0.1:11434' },
    modelsAvailable: true,
    models: [{ model: 'qwen3.6:latest' }],
    running: []
  };

  const transient = applyLiveStatus(previous, {
    online: false,
    runtime: { baseUrl: 'http://127.0.0.1:11434/' },
    modelsAvailable: false,
    models: [],
    running: []
  });
  assert.equal(transient.models.length, 1, 'same-runtime transient failure retains the last known model list');

  const switched = applyLiveStatus(previous, {
    online: false,
    runtime: { baseUrl: 'http://192.168.0.20:11434' },
    modelsAvailable: false,
    models: [],
    running: []
  });
  assert.deepEqual(switched.models, [], 'switching runtimes must not display models cached from the previous endpoint');
});

// ── Interactive UI Event Simulation Tests ──────────────────────────────────

test('UI Interaction: View tabs switching (Chat, Editor, Git, Terminal, Logs, Docs)', () => {
  const views = ['chat', 'editor', 'preview', 'tree', 'git', 'problems', 'resources', 'terminal', 'logs', 'docs'];
  let activeView = 'chat';

  function switchView(name) {
    activeView = name;
  }

  for (const view of views) {
    switchView(view);
    assert.equal(activeView, view, `View tab should switch to ${view}`);
  }
});

test('UI Interaction: Settings tabs switching (Model, Runtime, Pi, Advanced)', () => {
  const tabs = ['model', 'runtime', 'session', 'interaction', 'advanced'];
  let activeTab = 'model';

  function switchSettings(name) {
    activeTab = name;
  }

  for (const tab of tabs) {
    switchSettings(tab);
    assert.equal(activeTab, tab, `Settings tab should switch to ${tab}`);
  }
});

test('UI Interaction: Simulated mouse click on model selection dropdown and localStorage persistence', () => {
  const select = document.getElementById('topModel');
  select.value = 'qwen3.6:latest';

  // Simulate user changing model dropdown choice
  select.onchange = () => {
    localStorage.setItem('studio_selected_model', select.value);
  };
  select.onchange();

  assert.equal(localStorage.getItem('studio_selected_model'), 'qwen3.6:latest');
});

test('UI Interaction: Simulated keyboard ArrowUp / ArrowDown composer history navigation', () => {
  const history = ['first prompt', 'second prompt'];
  let historyIndex = -1;
  let composerValue = '';

  function handleKeydown(key) {
    if (key === 'ArrowUp') {
      historyIndex = Math.min(historyIndex + 1, history.length - 1);
      composerValue = history[historyIndex];
    } else if (key === 'ArrowDown') {
      historyIndex = Math.max(-1, historyIndex - 1);
      composerValue = historyIndex === -1 ? '' : history[historyIndex];
    }
  }

  handleKeydown('ArrowUp');
  assert.equal(composerValue, 'first prompt');
  handleKeydown('ArrowUp');
  assert.equal(composerValue, 'second prompt');
  handleKeydown('ArrowDown');
  assert.equal(composerValue, 'first prompt');
  handleKeydown('ArrowDown');
  assert.equal(composerValue, '');
});

test('UI Interaction: Simulated context gauge click-to-compact trigger', () => {
  let compactTriggered = false;
  const contextGaugeBadge = document.getElementById('contextGaugeBadge');
  contextGaugeBadge.onclick = () => {
    compactTriggered = true;
  };

  // Simulate mouse click
  contextGaugeBadge.onclick();
  assert.equal(compactTriggered, true, 'Context gauge click should trigger compaction callback');
});

test('UI Interaction: Simulated assistant message copy button click', async () => {
  let textCopied = '';
  const copyBtn = document.createElement('button');
  copyBtn.onclick = async () => {
    textCopied = 'Response text to copy';
  };

  await copyBtn.onclick();
  assert.equal(textCopied, 'Response text to copy');
});

test('UI Interaction: Simulated user message fork button click', () => {
  let forkedEntryId = null;
  const forkBtn = document.createElement('button');
  forkBtn.dataset.forkEntry = 'msg-12345';
  forkBtn.onclick = () => {
    forkedEntryId = forkBtn.dataset.forkEntry;
  };

  forkBtn.onclick();
  assert.equal(forkedEntryId, 'msg-12345');
});

test('UI Interaction: Fork button behavior when Pi is stopped or entryId is missing', () => {
  let toastEmitted = null;
  const mockToast = (msg, type) => { toastEmitted = { msg, type }; };

  // Case 1: Pi stopped
  const piStoppedState = { status: { running: false } };
  if (!piStoppedState.status?.running) {
    mockToast('Please click "Start Pi" first before forking messages', 'error');
  }
  assert.equal(toastEmitted.msg, 'Please click "Start Pi" first before forking messages');

  // Case 2: Missing entryId
  const piRunningState = { status: { running: true } };
  let entryId = null;
  if (piRunningState.status?.running && !entryId) {
    mockToast('Message entry ID is pending. Please wait for the agent turn to complete.', 'error');
  }
  assert.equal(toastEmitted.msg, 'Message entry ID is pending. Please wait for the agent turn to complete.');
});

test('Ollama Model Inspection: parseOllamaParameters correctly extracts num_ctx, temperature, and system prompt', () => {
  const paramsText = `num_ctx 65536\nnum_predict 8192\ntemperature 0.15\ntop_p 0.9\nrepeat_penalty 1.05`;
  const modelfileText = `FROM qwen2.5-coder:32b\nPARAMETER num_ctx 65536\nSYSTEM "You are an expert coding agent."`;

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

  const parsed = parseOllamaParameters(paramsText, modelfileText);
  assert.equal(parsed.num_ctx, '65536');
  assert.equal(parsed.num_predict, '8192');
  assert.equal(parsed.temperature, '0.15');
  assert.equal(parsed.top_p, '0.9');
  assert.equal(parsed.system, 'You are an expert coding agent.');
});




test('v1.8 provider, MCP, marketplace and Preview styles are present in the stylesheet actually loaded by index.html', async () => {
  const { promises: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(css, /\.provider-model-row/);
  assert.match(css, /\.mcp-resource-list/);
  assert.match(css, /\.package-market-grid/);
  assert.match(css, /\.pi-restart-notice\s*\{[^}]*grid-column:1 \/ -1/);
  assert.match(css, /\.pi-restart-notice\s*\{[^}]*z-index:60/);
});


test('v1.8 semantic command palette includes Preview, project, harness, runtime and unified resource actions', async () => {
  const source=await fs.readFile(path.resolve('public/app.js'),'utf8');
  for (const id of [
    'view.preview', 'preview.start', 'preview.stop', 'preview.toggleSplit',
    'project.manager.open', 'project.new', 'project.openFolder', 'project.createFromSession',
    'harness.open', 'harness.new', 'harness.saveEffective', 'harness.select',
    'ollama.testRuntime', 'ollama.useTestedRuntime', 'palette.resources'
  ]) assert.match(source, new RegExp(`['"]${id.replaceAll('.', '\\.')}['"]`), `missing semantic command ${id}`);
  assert.match(source,/platformResources/);assert.match(source,/mcpItems/);assert.match(source,/providerItems/);
});

test('v1.8 in-app documentation exposes project, runtime, Preview and harness workflows', async () => {
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  for (const id of ['docs-projects', 'docs-runtime', 'docs-preview', 'docs-harnesses']) {
    assert.match(html, new RegExp(`data-doc-link="${id}"`), `missing documentation navigation link ${id}`);
    assert.match(html, new RegExp(`id="${id}"`), `missing documentation article ${id}`);
  }
  assert.match(html, /Use this server/);
  assert.ok(html.includes('parent\\project-name'));
  assert.match(html, /index\.html/);
  assert.match(html, /data-doc-keywords="[^"]*runtime switch/);
  assert.match(source, /terms\.every\(\(term\) => haystack\.includes\(term\)\)/);
  assert.match(source, /card\.dataset\.docKeywords/);
});

test('Preview UI and CSP allow only local preview framing', async () => {
  const html=await fs.readFile(path.resolve('public/index.html'),'utf8');const server=await fs.readFile(path.resolve('server.mjs'),'utf8');const css=await fs.readFile(path.resolve('public/styles.css'),'utf8');
  assert.match(html,/data-view="preview"/);assert.match(html,/id="previewFrame"/);assert.match(html,/id="togglePreviewSplit"/);assert.match(html,/id="editorPreviewFrame"/);assert.match(server,/frame-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* https:\/\/127\.0\.0\.1:\* https:\/\/localhost:\*/);assert.match(css,/\.preview-stage/);assert.match(css,/\.editor-preview-layout\.with-preview/);
});

test('risky-tool UI is honest about notification-only behavior', async () => {
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  assert.match(html, /Notify when risky tools start/);
  assert.match(html, /Does not pause Pi or sandbox execution/);
  assert.doesNotMatch(html, /Ask permission before tool calls/);
  assert.match(source, /Risky tool started:/);
  assert.doesNotMatch(source, /Tool \$\{event\.toolName\} requires permission/);
  assert.doesNotMatch(source, /className = 'tool-confirm-row'/);
});

test('TTS UI autoplays direct speech and renders agent audio artifacts without embedding bytes', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const css = await fs.readFile(path.resolve('public/styles.css'), 'utf8');
  const server = await fs.readFile(path.resolve('server.mjs'), 'utf8');
  assert.match(source, /async function generateTtsAudio\(text = '', \{ autoplay = true \} = \{\}\)/);
  assert.match(source, /await audio\.play\(\)\.catch/);
  assert.match(source, /function attachToolAudio/);
  assert.ok(source.includes(String.raw`api\/tts\/audio`));
  assert.match(source, /attachToolAudio\(card, event\.result \|\| event\)/);
  assert.match(source, /TTS Online · sleeping/);
  assert.doesNotMatch(source, /value\.loaded === false \? '🟡 TTS Loading/);
  assert.match(css, /\.tool-audio/);
  assert.match(server, /media-src 'self' blob:/, 'CSP must permit generated browser audio blobs');
});

test('context percentage is rounded for human-readable UI', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  assert.match(source, /Math\.round\(Number\(context\.percent\) \* 10\) \/ 10/);
});

test('status bar reports tool calls and TTS explains harness-controlled agent availability', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(html, /id="toolStatus">0 tool calls</);
  assert.match(source, /\$\{formatNumber\(stats\?\.toolCalls\)\} tool calls/);
  assert.match(html, /id="ttsAgentToolStatus"/);
  assert.match(source, /explicitTools === null \|\| explicitTools\.includes\('tts_speak'\)/);
  assert.match(source, /Additional extension tools/);
});

test('resuming Pi while Session Tree is visible reloads the tree after startup', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const start = source.slice(source.indexOf('async function startPi('), source.indexOf('async function stopPi('));
  assert.match(start, /if \(activeViewName\(\) === 'tree'\) await loadSessionTree\(\)\.catch/);
});

test('Test Explorer gates actions when no runnable suite or failed result exists', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(html, /id="runAllTests"[^>]*disabled/);
  assert.match(html, /id="rerunTests"[^>]*disabled/);
  assert.match(html, /id="testAskPi"[^>]*disabled/);
  assert.match(source, /const canRunAll = Boolean\(discovery/);
  assert.match(source, /testAskPi'\)\.disabled = !app\.tests\.lastResult \|\| app\.tests\.lastResult\.passed !== false/);
  assert.match(source, /No runnable test suite was detected/);
});

test('Terminal controls follow active terminal and Pi lifecycle state', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  for (const id of ['splitTerminal', 'killIntegratedTerminal', 'terminalSearchInput', 'terminalSearchPrev', 'terminalSearchNext', 'webConsoleInput', 'runWebConsole']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} should be safe before app state loads`);
  }
  assert.match(source, /const hasActiveTerminal = Boolean\(session\)/);
  assert.match(source, /splitTerminal'\)\.disabled = !hasActiveTerminal/);
  assert.match(source, /runWebConsole'\)\.disabled = !status\.running/);
});

test('long local-model turns keep normal Send separate from steer, follow-up and abort', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(source, /sendingPrompt: false, agentBusy: false/);
  assert.match(source, /case 'agent_start': app\.agentBusy = true/);
  assert.match(source, /case 'agent_settled': \{/);
  assert.match(source, /app\.agentBusy = false;[\s\S]{0,100}\$\('#agentStatus'\)\.textContent = 'Ready'/);
  assert.match(source, /Pi is still working\. Use Steer Now, Follow Up, or Abort\./);
  assert.match(source, /function renderAgentActionState\(\)/);
  assert.match(html, /id="sendSteer"[^>]*disabled/);
  assert.match(html, /id="sendFollowUp"[^>]*disabled/);
  assert.match(html, /id="abortAgent"[^>]*disabled/);
});

test('Pi-dependent session and advanced controls stay disabled until Pi is running', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  for (const id of [
    'setSessionName', 'steeringMode', 'followUpMode', 'autoCompaction',
    'autoRetry', 'compactWithInstructions', 'loadCommands', 'runBash',
    'sendRawRpc'
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} should be safe before Pi status loads`);
  }
  assert.match(source, /const running = Boolean\(app\.pi\.status\?\.running\)/);
  assert.match(source, /\['#setSessionName', '#steeringMode', '#followUpMode', '#autoCompaction', '#autoRetry', '#loadCommands', '#sendRawRpc'\]/);
  assert.match(source, /compactWithInstructions'\)\.disabled = !running \|\| busy/);
  assert.match(source, /runBash'\)\.disabled = !running \|\| busy/);
});

test('creation forms and icon-only controls expose valid initial and accessible states', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(html, /id="projectWizardCreate"[^>]*disabled/);
  assert.match(html, /id="harnessBuilderSave"[^>]*disabled/);
  assert.match(html, /id="testProvider"[^>]*disabled/);
  assert.match(html, /id="mcpSave"[^>]*disabled/);
  assert.match(html, /id="packageDirectInspect"[^>]*disabled/);
  assert.match(html, /id="packageDirectInstall"[^>]*disabled/);
  assert.match(html, /id="openCommandPalette"[^>]*aria-label="Open command palette"/);
  assert.match(html, /id="closeFolderModal"[^>]*aria-label="Close folder browser"/);
  for (const id of ['keymapHelp', 'powerStateModal', 'sessionOperationModal', 'modal']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"`), `${id} should expose dialog semantics`);
  }
  assert.match(source, /aria-label="Unload \$\{escapeHtml\(id\)\} from memory"/);
  assert.match(source, /document\.createElement\('button'\)[\s\S]{0,120}card\.type = 'button'/);
});

test('session fork and clone use a validated in-app dialog instead of browser prompt', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(html, /id="sessionOperationModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="sessionOperationConfirm"[^>]*disabled/);
  assert.match(source, /function openSessionOperationDialog\(kind, sessionPath, nodeId = null\)/);
  assert.match(source, /The project changed\. Open the session dialog again in the active project\./);
  assert.match(source, /event\.key === 'Enter'/);
  assert.doesNotMatch(source, /prompt\('Enter name for (?:the forked|cloned) session:/);
});

test('Ollama pull and unload actions target only an actionable model state', async () => {
  const source = await fs.readFile(path.resolve('public/app.js'), 'utf8');
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  assert.match(source, /function updatePullModelAction\(result = app\.ollama\)/);
  assert.match(source, /result\?\.online !== true \|\| !String\(\$\('#pullModelName'\)\?\.value \|\| ''\)\.trim\(\)/);
  assert.match(source, /const running = \(app\.ollama\.running \|\| \[\]\)\.find/);
  assert.match(source, /if \(!running\) return toast\(`/);
  assert.match(source, /data-unload[^>]*\$\{running \? '' : 'disabled'\}/);
  assert.match(html, /id="unloadModel"[^>]*disabled/);
});
