const clone = (value) => JSON.parse(JSON.stringify(value));

export class BufferManager {
  #buffers = new Map();
  #order = [];
  #panes = new Map([
    ['primary', { id: 'primary', bufferId: null }],
    ['secondary', { id: 'secondary', bufferId: null }]
  ]);

  constructor({ split = 'none', activePane = 'primary' } = {}) {
    this.split = ['none', 'vertical', 'horizontal'].includes(split) ? split : 'none';
    this.activePane = activePane === 'secondary' ? 'secondary' : 'primary';
  }

  get size() { return this.#order.length; }
  get order() { return [...this.#order]; }
  get buffers() { return this.#order.map((id) => this.#buffers.get(id)).filter(Boolean).map(clone); }
  get activeBuffer() { return this.bufferForPane(this.activePane); }

  pane(id = this.activePane) {
    return clone(this.#panes.get(id) || this.#panes.get('primary'));
  }

  buffer(id) {
    const buffer = this.#buffers.get(id);
    return buffer ? clone(buffer) : null;
  }

  bufferForPane(paneId = this.activePane) {
    const pane = this.#panes.get(paneId);
    if (!pane?.bufferId) return null;
    return this.buffer(pane.bufferId);
  }

  open(file, { paneId = this.activePane, activate = true, attach = true } = {}) {
    if (!file?.path) throw new Error('Buffer requires a file path');
    const id = String(file.path);
    const previous = this.#buffers.get(id);
    const hasIncomingContent = Object.prototype.hasOwnProperty.call(file, 'content');
    const incomingContent = String(file.content ?? previous?.content ?? '');
    const next = {
      id,
      path: id,
      name: file.name || id.split(/[\\/]/).pop() || id,
      content: incomingContent,
      original: String(file.original ?? (hasIncomingContent ? incomingContent : previous?.original ?? '')),
      size: Number(file.size ?? previous?.size ?? 0),
      modifiedAt: file.modifiedAt ?? previous?.modifiedAt ?? null,
      mtimeMs: Number.isFinite(Number(file.mtimeMs)) ? Number(file.mtimeMs) : (previous?.mtimeMs ?? null),
      language: file.language ?? previous?.language ?? null,
      dirty: file.dirty !== undefined ? Boolean(file.dirty) : hasIncomingContent ? false : Boolean(previous?.dirty),
      externalChanged: Boolean(file.externalChanged ?? previous?.externalChanged ?? false),
      externalMtimeMs: Number.isFinite(Number(file.externalMtimeMs)) ? Number(file.externalMtimeMs) : (previous?.externalMtimeMs ?? null)
    };
    this.#buffers.set(id, next);
    if (!this.#order.includes(id)) this.#order.push(id);
    if (attach) {
      const pane = this.#panes.get(paneId) || this.#panes.get('primary');
      pane.bufferId = id;
      if (activate) this.activePane = pane.id;
    }
    return clone(next);
  }

  activate(bufferId, { paneId = this.activePane } = {}) {
    if (!this.#buffers.has(bufferId)) return null;
    const pane = this.#panes.get(paneId) || this.#panes.get('primary');
    pane.bufferId = bufferId;
    this.activePane = pane.id;
    return this.buffer(bufferId);
  }

  setActivePane(paneId) {
    if (!this.#panes.has(paneId)) return this.activePane;
    if (paneId === 'secondary' && this.split === 'none') return this.activePane;
    this.activePane = paneId;
    return paneId;
  }

  updateContent(content, { paneId = this.activePane } = {}) {
    const pane = this.#panes.get(paneId);
    if (!pane?.bufferId) return null;
    const buffer = this.#buffers.get(pane.bufferId);
    if (!buffer) return null;
    buffer.content = String(content ?? '');
    buffer.dirty = buffer.content !== buffer.original;
    return clone(buffer);
  }

  markSaved({ paneId = this.activePane, content = null, modifiedAt = null, mtimeMs = null, size = null } = {}) {
    const pane = this.#panes.get(paneId);
    if (!pane?.bufferId) return null;
    return this.markBufferSaved(pane.bufferId, { content, modifiedAt, mtimeMs, size });
  }

  markBufferSaved(bufferId, { content = null, modifiedAt = null, mtimeMs = null, size = null } = {}) {
    const buffer = this.#buffers.get(bufferId);
    if (!buffer) return null;
    if (content !== null) buffer.content = String(content);
    buffer.original = buffer.content;
    buffer.dirty = false;
    if (modifiedAt !== null) buffer.modifiedAt = modifiedAt;
    if (mtimeMs !== null && Number.isFinite(Number(mtimeMs))) buffer.mtimeMs = Number(mtimeMs);
    if (size !== null) buffer.size = Number(size);
    buffer.externalChanged = false;
    buffer.externalMtimeMs = null;
    buffer.externalMissing = false;
    return clone(buffer);
  }

  markExternalChange(bufferId, { mtimeMs = null, missing = false } = {}) {
    const buffer = this.#buffers.get(bufferId);
    if (!buffer) return null;
    buffer.externalChanged = true;
    buffer.externalMtimeMs = Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : null;
    buffer.externalMissing = Boolean(missing);
    return clone(buffer);
  }

  refreshFromDisk(bufferId, file = {}) {
    const buffer = this.#buffers.get(bufferId);
    if (!buffer) return { action: 'missing', buffer: null };
    const diskMtimeMs = Number.isFinite(Number(file.mtimeMs)) ? Number(file.mtimeMs) : null;
    const changed = (diskMtimeMs !== null && buffer.mtimeMs !== null && Math.abs(diskMtimeMs - Number(buffer.mtimeMs)) > 0.5)
      || String(file.content ?? '') !== String(buffer.original ?? '');
    if (!changed) return { action: 'unchanged', buffer: clone(buffer) };
    if (buffer.dirty) {
      buffer.externalChanged = true;
      buffer.externalMtimeMs = diskMtimeMs;
      return { action: 'conflict', buffer: clone(buffer) };
    }
    const content = String(file.content ?? '');
    buffer.content = content;
    buffer.original = content;
    buffer.size = Number(file.size ?? buffer.size ?? 0);
    buffer.modifiedAt = file.modifiedAt ?? buffer.modifiedAt ?? null;
    if (diskMtimeMs !== null) buffer.mtimeMs = diskMtimeMs;
    buffer.dirty = false;
    buffer.externalChanged = false;
    buffer.externalMtimeMs = null;
    buffer.externalMissing = false;
    return { action: 'reloaded', buffer: clone(buffer) };
  }

  close(bufferId, { force = false } = {}) {
    const buffer = this.#buffers.get(bufferId);
    if (!buffer) return { closed: false, reason: 'missing' };
    if (buffer.dirty && !force) return { closed: false, reason: 'dirty', buffer: clone(buffer) };
    const index = this.#order.indexOf(bufferId);
    this.#buffers.delete(bufferId);
    this.#order = this.#order.filter((id) => id !== bufferId);
    const fallback = this.#order[Math.min(index, this.#order.length - 1)] || this.#order[this.#order.length - 1] || null;
    for (const pane of this.#panes.values()) if (pane.bufferId === bufferId) pane.bufferId = fallback;
    if (this.split !== 'none' && !this.#panes.get('secondary').bufferId) this.closeSplit();
    return { closed: true, nextBufferId: fallback };
  }

  next(delta = 1, { paneId = this.activePane } = {}) {
    if (!this.#order.length) return null;
    const pane = this.#panes.get(paneId) || this.#panes.get('primary');
    const currentIndex = Math.max(0, this.#order.indexOf(pane.bufferId));
    const nextIndex = (currentIndex + delta + this.#order.length) % this.#order.length;
    return this.activate(this.#order[nextIndex], { paneId: pane.id });
  }

  setSplit(direction = 'vertical') {
    this.split = direction === 'horizontal' ? 'horizontal' : 'vertical';
    const primary = this.#panes.get('primary');
    const secondary = this.#panes.get('secondary');
    if (!secondary.bufferId) secondary.bufferId = primary.bufferId || this.#order[0] || null;
    return this.snapshot();
  }

  closeSplit() {
    this.split = 'none';
    this.activePane = 'primary';
    this.#panes.get('secondary').bufferId = null;
    return this.snapshot();
  }

  snapshot() {
    return {
      split: this.split,
      activePane: this.activePane,
      order: [...this.#order],
      panes: Object.fromEntries([...this.#panes].map(([id, pane]) => [id, { ...pane }])),
      buffers: this.buffers
    };
  }
}

export class RegisterStore {
  #registers = new Map();

  constructor(initial = {}) {
    for (const [name, value] of Object.entries(initial || {})) this.set(name, value);
  }

  set(name, value, meta = {}) {
    const key = String(name || '"').slice(0, 1);
    const entry = { value: String(value ?? ''), type: meta.type || 'text', label: meta.label || '', updatedAt: Date.now() };
    this.#registers.set(key, entry);
    if (key !== '"') this.#registers.set('"', { ...entry });
    return { ...entry };
  }

  get(name = '"') {
    const value = this.#registers.get(String(name || '"').slice(0, 1));
    return value ? { ...value } : null;
  }

  list() {
    return [...this.#registers.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

export class SemanticMacroRecorder {
  #macros = new Map();
  recording = null;
  replaying = false;

  start(register) {
    const key = String(register || '').slice(0, 1);
    if (!/^[a-z0-9]$/i.test(key)) throw new Error('Macro register must be a-z or 0-9');
    this.recording = key.toLowerCase();
    this.#macros.set(this.recording, []);
    return this.recording;
  }

  stop() {
    const key = this.recording;
    this.recording = null;
    return key;
  }

  record(commandId, args = []) {
    if (!this.recording || this.replaying) return;
    this.#macros.get(this.recording)?.push({ commandId, args: clone(args) });
  }

  get(register) {
    return clone(this.#macros.get(String(register || '').slice(0, 1).toLowerCase()) || []);
  }

  list() {
    return [...this.#macros.entries()].map(([name, steps]) => ({ name, steps: clone(steps) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async replay(register, executor) {
    const steps = this.get(register);
    if (!steps.length) return 0;
    this.replaying = true;
    try {
      for (const step of steps) await executor(step.commandId, ...(step.args || []));
    } finally {
      this.replaying = false;
    }
    return steps.length;
  }
}

export class WorkspaceStateStore {
  constructor(storage = typeof localStorage !== 'undefined' ? localStorage : null, { prefix = 'pi-studio:workspace:', version = 1 } = {}) {
    this.storage = storage;
    this.prefix = prefix;
    this.version = version;
  }

  key(workspace) { return `${this.prefix}${String(workspace || '').replace(/\\/g, '/')}`; }

  save(workspace, state = {}) {
    if (!this.storage || !workspace) return false;
    const payload = {
      version: this.version,
      savedAt: new Date().toISOString(),
      openPaths: [...new Set((state.openPaths || []).map(String).filter(Boolean))].slice(0, 100),
      activePane: state.activePane === 'secondary' ? 'secondary' : 'primary',
      split: ['none', 'vertical', 'horizontal'].includes(state.split) ? state.split : 'none',
      panePaths: {
        primary: state.panePaths?.primary || null,
        secondary: state.panePaths?.secondary || null
      },
      splitSize: Math.max(20, Math.min(80, Number(state.splitSize) || 50)),
      activeView: String(state.activeView || 'chat'),
      viewStates: state.viewStates && typeof state.viewStates === 'object' ? state.viewStates : {}
    };
    try { this.storage.setItem(this.key(workspace), JSON.stringify(payload)); return true; }
    catch { return false; }
  }

  load(workspace) {
    if (!this.storage || !workspace) return null;
    try {
      const raw = this.storage.getItem(this.key(workspace));
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (value?.version !== this.version || !Array.isArray(value.openPaths)) return null;
      return value;
    } catch { return null; }
  }

  clear(workspace) {
    if (!this.storage || !workspace) return;
    try { this.storage.removeItem(this.key(workspace)); } catch { /* ignore */ }
  }
}
