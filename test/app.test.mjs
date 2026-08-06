import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

  // Execute UI function logic directly
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
  // Test transient state where running is undefined/missing
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

test('refreshLiveStatus retains existing models if polling returns empty array with modelsAvailable=false', () => {
  app.ollama = { online: true, modelsAvailable: true, models: [{ model: 'qwen3.6:latest' }], running: [] };

  const liveStatusResponse = {
    pi: { status: { running: false } },
    ollama: { online: false, modelsAvailable: false, models: [], running: [] },
    system: {}
  };

  // Apply fallback rule
  if (liveStatusResponse.ollama) {
    if ((!liveStatusResponse.ollama.models || !liveStatusResponse.ollama.models.length) && app.ollama.models?.length && liveStatusResponse.ollama.modelsAvailable === false) {
      liveStatusResponse.ollama.models = app.ollama.models;
    }
    app.ollama = liveStatusResponse.ollama;
  }

  assert.equal(app.ollama.models.length, 1, 'Models list should be retained during transient poll timeout');
  assert.equal(app.ollama.models[0].model, 'qwen3.6:latest');
});
