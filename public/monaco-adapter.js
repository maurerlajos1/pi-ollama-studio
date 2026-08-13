const LOCAL_BASE = '/vendor/monaco/vs';

export function languageForPath(filePath = '') {
  const lower = String(filePath).toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const byExt = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
    '.json': 'json', '.jsonc': 'json', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell',
    '.sql': 'sql', '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini',
    '.ini': 'ini', '.env': 'ini', '.dockerfile': 'dockerfile', '.vue': 'html', '.svelte': 'html'
  };
  if (lower.endsWith('dockerfile')) return 'dockerfile';
  if (lower.endsWith('makefile')) return 'plaintext';
  return byExt[ext] || 'plaintext';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((script) => script.src === new URL(src, location.href).href);
    if (existing?.dataset.loaded === '1') return resolve(existing);
    const script = existing || document.createElement('script');
    script.src = src;
    script.async = true;
    const timer = setTimeout(() => { if (!existing) script.remove(); reject(new Error(`Timed out loading ${src}`)); }, 5000);
    script.onload = () => { clearTimeout(timer); script.dataset.loaded = '1'; resolve(script); };
    script.onerror = () => { clearTimeout(timer); if (!existing) script.remove(); reject(new Error(`Failed to load ${src}`)); };
    if (!existing) document.head.append(script);
  });
}

async function loadFrom(base) {
  await loadScript(`${base}/loader.js`);
  const amdRequire = window.require;
  if (!amdRequire?.config) throw new Error('Monaco AMD loader did not initialize');
  amdRequire.config({ paths: { vs: base } });
  await new Promise((resolve, reject) => amdRequire(['vs/editor/editor.main'], resolve, reject));
  if (!window.monaco?.editor) throw new Error('Monaco editor API unavailable');
  return window.monaco;
}

let monacoPromise = null;
export function loadMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;
  monacoPromise = loadFrom(LOCAL_BASE);
  monacoPromise.catch(() => { monacoPromise = null; });
  return monacoPromise;
}

function modelUri(monaco, workspace, filePath) {
  const safeWorkspace = String(workspace || 'workspace').replace(/\\/g, '/').replace(/^\/+/, '');
  const safePath = String(filePath || 'untitled').replace(/\\/g, '/').replace(/^\/+/, '');
  return monaco.Uri.parse(`file:///${encodeURI(`${safeWorkspace}/${safePath}`)}`);
}

export class MonacoWorkbenchAdapter {
  constructor({ getWorkspace = () => '', onChange = () => {}, onFocus = () => {}, onViewStateChanged = () => {}, onModelChanged = () => {}, onDiagnostics = () => {} } = {}) {
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.onViewStateChanged = onViewStateChanged;
    this.onModelChanged = onModelChanged;
    this.onDiagnostics = onDiagnostics;
    this.monaco = null;
    this.editors = new Map();
    this.models = new Map();
    this.suppress = new Set();
    this.markerListener = null;
    this.ready = false;
    this.error = null;
  }

  async init(hosts, options = {}) {
    this.monaco = await loadMonaco();
    const ts = this.monaco.languages?.typescript;
    try {
      ts?.typescriptDefaults?.setEagerModelSync?.(true);
      ts?.javascriptDefaults?.setEagerModelSync?.(true);
      ts?.typescriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: false, noSyntaxValidation: false });
      // Browser-only JS projects often lack a full tsconfig/dependency graph. Keep syntax
      // diagnostics on without flooding Quickfix with unresolved-import false positives.
      ts?.javascriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
    } catch { /* Monaco versions/providers may not expose TS defaults */ }
    const defaults = {
      theme: 'vs-dark', automaticLayout: true, fontSize: 13, lineHeight: 20,
      minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true,
      renderWhitespace: 'selection', bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true }, stickyScroll: { enabled: true },
      padding: { top: 8, bottom: 8 }, wordWrap: 'off', renderValidationDecorations: 'on'
    };
    for (const [paneId, host] of Object.entries(hosts || {})) {
      if (!host) continue;
      const editor = this.monaco.editor.create(host, { ...defaults, ...(options.editorOptions || {}) });
      editor.onDidFocusEditorText(() => this.onFocus(paneId));
      // Persist caret/selection/scroll changes independently of content edits. This
      // keeps later buffer restores current without re-rendering on mouse clicks.
      editor.onDidChangeCursorPosition(() => this.onViewStateChanged(paneId));
      editor.onDidChangeCursorSelection(() => this.onViewStateChanged(paneId));
      editor.onDidScrollChange(() => this.onViewStateChanged(paneId));
      editor.onDidChangeModel(() => {
        const model = editor.getModel?.();
        if (model?.__piStudioPath) this.onModelChanged(paneId, model.__piStudioPath);
      });
      editor.onDidChangeModelContent(() => {
        if (this.suppress.has(paneId)) return;
        this.onChange(paneId, editor.getValue());
      });
      this.editors.set(paneId, editor);
    }
    this.markerListener = this.monaco.editor.onDidChangeMarkers((uris) => {
      const diagnostics = [];
      for (const uri of uris) {
        const model = this.monaco.editor.getModel(uri);
        if (!model) continue;
        const filePath = model.__piStudioPath;
        if (!filePath) continue;
        for (const marker of this.monaco.editor.getModelMarkers({ resource: uri })) {
          diagnostics.push({
            source: marker.source || 'Monaco', path: filePath, line: marker.startLineNumber,
            column: marker.startColumn, endLine: marker.endLineNumber, endColumn: marker.endColumn,
            message: marker.message, severity: marker.severity, code: marker.code ? String(marker.code) : ''
          });
        }
      }
      this.onDiagnostics(diagnostics);
    });
    this.ready = true;
    return this;
  }

  ensureModel(buffer) {
    if (!buffer?.path || !this.monaco) return null;
    let model = this.models.get(buffer.path);
    if (!model || model.isDisposed?.()) {
      const uri = modelUri(this.monaco, this.getWorkspace(), buffer.path);
      model = this.monaco.editor.getModel(uri) || this.monaco.editor.createModel(String(buffer.content ?? ''), languageForPath(buffer.path), uri);
      model.__piStudioPath = buffer.path;
      this.models.set(buffer.path, model);
    }
    if (model.getLanguageId?.() !== languageForPath(buffer.path)) this.monaco.editor.setModelLanguage(model, languageForPath(buffer.path));
    return model;
  }

  showBuffer(paneId, buffer) {
    const editor = this.editors.get(paneId);
    if (!editor) return;
    if (!buffer) { editor.setModel(null); return; }
    const model = this.ensureModel(buffer);
    if (model.getValue() !== String(buffer.content ?? '')) {
      this.suppress.add(paneId);
      try { model.setValue(String(buffer.content ?? '')); }
      finally { this.suppress.delete(paneId); }
    }
    if (editor.getModel() !== model) editor.setModel(model);
    const state = buffer.viewStates?.[paneId];
    if (state) editor.restoreViewState(state);
  }

  getModelForPath(filePath) {
    const model = this.models.get(filePath);
    return model && !model.isDisposed?.() ? model : null;
  }
  ensurePathModel(buffer) { return this.ensureModel(buffer); }
  getValue(paneId) { return this.editors.get(paneId)?.getValue?.() ?? null; }
  focus(paneId) { this.editors.get(paneId)?.focus?.(); }
  getSelectionText(paneId) {
    const editor = this.editors.get(paneId);
    const selection = editor?.getSelection?.();
    return selection && editor.getModel() ? editor.getModel().getValueInRange(selection) : '';
  }
  saveViewState(paneId) { return this.editors.get(paneId)?.saveViewState?.() || null; }
  restoreViewState(paneId, state) { if (state) this.editors.get(paneId)?.restoreViewState?.(state); }
  reveal(paneId, line = 1, column = 1) {
    const editor = this.editors.get(paneId);
    if (!editor) return;
    editor.setPosition({ lineNumber: Math.max(1, Number(line) || 1), column: Math.max(1, Number(column) || 1) });
    editor.revealPositionInCenter?.({ lineNumber: Math.max(1, Number(line) || 1), column: Math.max(1, Number(column) || 1) });
    editor.focus();
  }
  trigger(paneId, actionId) { this.editors.get(paneId)?.getAction?.(actionId)?.run?.(); }
  disposeModel(filePath) {
    const model = this.models.get(filePath);
    if (model && ![...this.editors.values()].some((editor) => editor.getModel?.() === model)) model.dispose?.();
    this.models.delete(filePath);
  }
  dispose() {
    this.markerListener?.dispose?.();
    for (const editor of this.editors.values()) editor.dispose?.();
    for (const model of this.models.values()) model.dispose?.();
    this.editors.clear(); this.models.clear(); this.ready = false;
  }
}

export class MonacoDiffAdapter {
  constructor() { this.monaco = null; this.editor = null; this.original = null; this.modified = null; this.host = null; }
  async init(host) {
    this.monaco = await loadMonaco();
    this.host = host;
    this.editor = this.monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark', automaticLayout: true, readOnly: true, originalEditable: false,
      renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true, minimap: { enabled: false },
      scrollBeyondLastLine: false, renderOverviewRuler: true, diffAlgorithm: 'advanced'
    });
    return this;
  }
  setDiff({ path = 'diff.txt', original = '', modified = '', source = 'HEAD' } = {}) {
    if (!this.editor || !this.monaco) return;
    // Monaco's diff editor keeps listeners attached to both text models. Detach
    // them before disposal or a workspace/diff switch can report that a model
    // disappeared while the DiffEditorWidget was still using it.
    this.editor.setModel(null);
    this.original?.dispose?.(); this.modified?.dispose?.();
    const language = languageForPath(path);
    this.original = this.monaco.editor.createModel(String(original), language, this.monaco.Uri.parse(`inmemory://pi-studio/original/${encodeURI(path)}?${encodeURIComponent(source)}`));
    this.modified = this.monaco.editor.createModel(String(modified), language, this.monaco.Uri.parse(`inmemory://pi-studio/modified/${encodeURI(path)}`));
    this.editor.setModel({ original: this.original, modified: this.modified });
  }
  setInline(inline) { this.editor?.updateOptions?.({ renderSideBySide: !inline }); }
  next() { this.editor?.goToDiff?.('next'); }
  previous() { this.editor?.goToDiff?.('previous'); }
  dispose() {
    this.editor?.setModel?.(null);
    this.editor?.dispose?.();
    this.original?.dispose?.();
    this.modified?.dispose?.();
    this.editor = this.original = this.modified = null;
  }
}
