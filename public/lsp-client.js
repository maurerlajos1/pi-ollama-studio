const SUPPORTED_LANGUAGES = ['typescript','typescriptreact','javascript','javascriptreact','python','html','css','scss','less','json','jsonc','markdown'];

function lspPosition(position) { return { line: Math.max(0, (position?.lineNumber || 1) - 1), character: Math.max(0, (position?.column || 1) - 1) }; }
function monacoPosition(position) { return { lineNumber: Math.max(1, Number(position?.line || 0) + 1), column: Math.max(1, Number(position?.character || 0) + 1) }; }
function monacoRange(monaco, range) {
  if (!range) return null;
  return new monaco.Range(
    Number(range.start?.line || 0) + 1, Number(range.start?.character || 0) + 1,
    Number(range.end?.line || 0) + 1, Number(range.end?.character || 0) + 1
  );
}
function lspRange(range) {
  return { start: { line: Math.max(0, range.startLineNumber - 1), character: Math.max(0, range.startColumn - 1) }, end: { line: Math.max(0, range.endLineNumber - 1), character: Math.max(0, range.endColumn - 1) } };
}
function markdownValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.value === 'string') return value.value;
  return String(value);
}
function completionKind(monaco, kind) {
  const K = monaco.languages.CompletionItemKind;
  const map = { 1:K.Text,2:K.Method,3:K.Function,4:K.Constructor,5:K.Field,6:K.Variable,7:K.Class,8:K.Interface,9:K.Module,10:K.Property,11:K.Unit,12:K.Value,13:K.Enum,14:K.Keyword,15:K.Snippet,16:K.Color,17:K.File,18:K.Reference,19:K.Folder,20:K.EnumMember,21:K.Constant,22:K.Struct,23:K.Event,24:K.Operator,25:K.TypeParameter };
  return map[Number(kind)] ?? K.Text;
}
function symbolKind(monaco, kind) {
  const K = monaco.languages.SymbolKind;
  const map = { 1:K.File,2:K.Module,3:K.Namespace,4:K.Package,5:K.Class,6:K.Method,7:K.Property,8:K.Field,9:K.Constructor,10:K.Enum,11:K.Interface,12:K.Function,13:K.Variable,14:K.Constant,15:K.String,16:K.Number,17:K.Boolean,18:K.Array,19:K.Object,20:K.Key,21:K.Null,22:K.EnumMember,23:K.Struct,24:K.Event,25:K.Operator,26:K.TypeParameter };
  return map[Number(kind)] ?? K.Variable;
}
function diagnosticSeverity(monaco, severity) {
  const s = Number(severity);
  if (s === 1) return monaco.MarkerSeverity.Error;
  if (s === 2) return monaco.MarkerSeverity.Warning;
  if (s === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}
function normalizeSlash(value) { return String(value || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
function fileUriToRelative(workspace, uri) {
  if (!uri || !String(uri).startsWith('file:')) return '';
  try {
    const url = new URL(uri);
    let file = decodeURIComponent(url.pathname).replace(/\\/g, '/');
    let root = normalizeSlash(workspace);
    if (/^[A-Za-z]:\//.test(root)) root = `/${root}`;
    if (file.toLowerCase().startsWith(root.toLowerCase() + '/')) return file.slice(root.length + 1);
    if (file.toLowerCase() === root.toLowerCase()) return '.';
    return '';
  } catch { return ''; }
}
function locations(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((item) => {
    if (!item) return [];
    if (item.targetUri) return [{ uri: item.targetUri, range: item.targetSelectionRange || item.targetRange }];
    if (item.uri) return [{ uri: item.uri, range: item.range }];
    return [];
  });
}
function editEntries(edit) {
  const entries = [];
  if (!edit) return entries;
  for (const [uri, edits] of Object.entries(edit.changes || {})) for (const textEdit of edits || []) entries.push({ uri, textEdit });
  for (const change of edit.documentChanges || []) {
    if (change?.textDocument?.uri && Array.isArray(change.edits)) for (const textEdit of change.edits) entries.push({ uri: change.textDocument.uri, textEdit });
  }
  return entries;
}

export class MonacoLspBridge {
  constructor({ monaco, request, getWorkspace, getTextForPath, ensureModelForPath, onDiagnostics = () => {}, onStatus = () => {}, onLog = () => {} } = {}) {
    this.monaco = monaco;
    this.request = request;
    this.getWorkspace = getWorkspace;
    this.getTextForPath = getTextForPath;
    this.ensureModelForPath = ensureModelForPath;
    this.onDiagnostics = onDiagnostics;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.disposables = [];
    this.versions = new Map();
    this.syncTimers = new Map();
    this.status = [];
  }

  async api(path, body = null) { return this.request(path, body); }
  modelPath(model) { return model?.__piStudioPath || ''; }
  languageId(model) { return model?.getLanguageId?.() || 'plaintext'; }

  async refreshStatus() {
    const workspace = this.getWorkspace();
    if (!workspace) { this.status = []; this.onStatus([]); return []; }
    const response = await this.api(`/api/lsp/status?workspace=${encodeURIComponent(workspace)}`);
    this.status = response.servers || [];
    this.onStatus(this.status);
    return this.status;
  }

  async restart(serverId = '') {
    const workspace = this.getWorkspace(); if (!workspace) return [];
    const response = await this.api('/api/lsp/restart', { workspace, serverId });
    this.status = response.servers || [];
    this.onStatus(this.status);
    return this.status;
  }

  async syncModel(model, action = 'open', { immediate = false } = {}) {
    const workspace = this.getWorkspace(); const filePath = this.modelPath(model);
    if (!workspace || !filePath || !SUPPORTED_LANGUAGES.includes(this.languageId(model))) return [];
    const run = async () => {
      const nextVersion = (this.versions.get(filePath) || 0) + 1; this.versions.set(filePath, nextVersion);
      try {
        const response = await this.api('/api/lsp/document', { workspace, path: filePath, languageId: this.languageId(model), text: model.getValue(), version: nextVersion, action });
        return response.results || [];
      } catch (error) { this.onLog({ serverId: 'client', stream: 'error', text: error.message }); return []; }
    };
    const pending = this.syncTimers.get(filePath);
    if (pending) { clearTimeout(pending.timer); pending.resolve([]); this.syncTimers.delete(filePath); }
    if (immediate || action !== 'change') return run();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.syncTimers.delete(filePath);
        run().then(resolve);
      }, 180);
      this.syncTimers.set(filePath, { timer, resolve });
    });
  }

  async closePath(filePath) {
    const workspace = this.getWorkspace(); if (!workspace || !filePath) return;
    const pending = this.syncTimers.get(filePath);
    if (pending) { clearTimeout(pending.timer); pending.resolve([]); this.syncTimers.delete(filePath); }
    this.versions.delete(filePath);
    await this.api('/api/lsp/document', { workspace, path: filePath, action: 'close' }).catch(() => null);
  }

  async sendRequest(method, model, params = {}, { serverId = '' } = {}) {
    const workspace = this.getWorkspace(); const filePath = this.modelPath(model);
    if (!workspace) return [];
    const body = { workspace, path: filePath, languageId: this.languageId(model), method, params, serverId };
    if (model && filePath) {
      body.text = model.getValue();
      body.version = (this.versions.get(filePath) || 0) + 1; this.versions.set(filePath, body.version);
    }
    const response = await this.api('/api/lsp/request', body);
    return response.results || [];
  }
  firstResult(results) { return (results || []).find((item) => item.ok && item.result != null)?.result ?? null; }

  async workspaceSymbols(query = '') {
    const workspace = this.getWorkspace();
    if (!workspace) return [];
    const response = await this.api('/api/lsp/request', { workspace, method: 'workspace/symbol', params: { query: String(query || '') } });
    const symbols = [];
    for (const item of response.results || []) {
      if (!item.ok || !Array.isArray(item.result)) continue;
      for (const symbol of item.result) {
        const uri = symbol.location?.uri || symbol.uri;
        const range = symbol.location?.range || symbol.range;
        const path = fileUriToRelative(workspace, uri);
        if (!path || !range) continue;
        symbols.push({ serverId: item.serverId, name: symbol.name || '', kind: symbol.kind, containerName: symbol.containerName || '', path, range });
      }
    }
    return symbols;
  }

  async ensureLocationModels(result) {
    const workspace = this.getWorkspace();
    const paths = new Set();
    for (const item of locations(result)) { const rel = fileUriToRelative(workspace, item.uri); if (rel) paths.add(rel); }
    for (const entry of editEntries(result)) { const rel = fileUriToRelative(workspace, entry.uri); if (rel) paths.add(rel); }
    await Promise.all([...paths].map((filePath) => this.ensureModelForPath(filePath).catch(() => null)));
  }

  locationLinks(result) {
    const workspace = this.getWorkspace();
    return locations(result).flatMap((item) => {
      const rel = fileUriToRelative(workspace, item.uri); if (!rel) return [];
      const model = this.monaco.editor.getModels().find((candidate) => candidate.__piStudioPath === rel);
      if (!model) return [];
      return [{ uri: model.uri, range: monacoRange(this.monaco, item.range) }];
    });
  }

  async workspaceEdit(edit) {
    if (!edit) return { edits: [] };
    await this.ensureLocationModels(edit);
    const workspace = this.getWorkspace();
    const edits = [];
    for (const { uri, textEdit } of editEntries(edit)) {
      const rel = fileUriToRelative(workspace, uri); if (!rel) continue;
      const model = this.monaco.editor.getModels().find((candidate) => candidate.__piStudioPath === rel); if (!model) continue;
      edits.push({ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: monacoRange(this.monaco, textEdit.range), text: String(textEdit.newText ?? ''), insertAsSnippet: Number(textEdit.insertTextFormat) === 2 } });
    }
    return { edits };
  }

  applyDiagnostics({ serverId, path, diagnostics = [] } = {}) {
    const model = this.monaco.editor.getModels().find((candidate) => candidate.__piStudioPath === path);
    const markers = diagnostics.map((item) => ({
      severity: diagnosticSeverity(this.monaco, item.severity),
      startLineNumber: Number(item.range?.start?.line || 0) + 1, startColumn: Number(item.range?.start?.character || 0) + 1,
      endLineNumber: Number(item.range?.end?.line || item.range?.start?.line || 0) + 1, endColumn: Number(item.range?.end?.character || item.range?.start?.character || 0) + 1,
      message: String(item.message || 'Language server diagnostic'), source: item.source || serverId || 'LSP', code: item.code != null ? String(item.code) : undefined,
      tags: item.tags
    }));
    if (model) this.monaco.editor.setModelMarkers(model, `lsp:${serverId || 'server'}`, markers);
    this.onDiagnostics({ serverId, path, diagnostics });
  }

  registerProviders() {
    const m = this.monaco;
    for (const language of SUPPORTED_LANGUAGES) {
      this.disposables.push(m.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', '"', "'", '/', '@', '<', ':'],
        provideCompletionItems: async (model, position, context) => {
          const results = await this.sendRequest('textDocument/completion', model, { position: lspPosition(position), context: { triggerKind: context.triggerKind || 1, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) } });
          const result = this.firstResult(results); const items = Array.isArray(result) ? result : (result?.items || []);
          const word = model.getWordUntilPosition(position); const defaultRange = new m.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return { suggestions: items.map((item) => {
            const textEdit = item.textEdit && item.textEdit.range ? item.textEdit : null;
            const insertReplace = item.textEdit && item.textEdit.insert && item.textEdit.replace ? item.textEdit : null;
            let range = defaultRange;
            if (textEdit) range = monacoRange(m, textEdit.range);
            else if (insertReplace) range = { insert: monacoRange(m, insertReplace.insert), replace: monacoRange(m, insertReplace.replace) };
            const docs = markdownValue(item.documentation);
            return {
              label: typeof item.label === 'string' ? item.label : (item.label?.label || ''), kind: completionKind(m, item.kind), detail: item.detail || '', documentation: docs ? { value: docs } : undefined,
              insertText: textEdit?.newText ?? insertReplace?.newText ?? item.insertText ?? (typeof item.label === 'string' ? item.label : item.label?.label || ''),
              insertTextRules: Number(item.insertTextFormat) === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              sortText: item.sortText, filterText: item.filterText, preselect: item.preselect, range,
              commitCharacters: item.commitCharacters, tags: item.tags
            };
          }) };
        }
      }));

      this.disposables.push(m.languages.registerHoverProvider(language, { provideHover: async (model, position) => {
        const result = this.firstResult(await this.sendRequest('textDocument/hover', model, { position: lspPosition(position) })); if (!result) return null;
        const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
        return { range: result.range ? monacoRange(m, result.range) : undefined, contents: contents.filter(Boolean).map((value) => ({ value: markdownValue(value) })) };
      }}));

      this.disposables.push(m.languages.registerDefinitionProvider(language, { provideDefinition: async (model, position) => {
        const result = this.firstResult(await this.sendRequest('textDocument/definition', model, { position: lspPosition(position) })); await this.ensureLocationModels(result); return this.locationLinks(result);
      }}));
      this.disposables.push(m.languages.registerImplementationProvider(language, { provideImplementation: async (model, position) => {
        const result = this.firstResult(await this.sendRequest('textDocument/implementation', model, { position: lspPosition(position) })); await this.ensureLocationModels(result); return this.locationLinks(result);
      }}));
      this.disposables.push(m.languages.registerReferenceProvider(language, { provideReferences: async (model, position, context) => {
        const result = this.firstResult(await this.sendRequest('textDocument/references', model, { position: lspPosition(position), context: { includeDeclaration: context?.includeDeclaration !== false } })); await this.ensureLocationModels(result); return this.locationLinks(result);
      }}));

      this.disposables.push(m.languages.registerRenameProvider(language, {
        resolveRenameLocation: async (model, position) => {
          const result = this.firstResult(await this.sendRequest('textDocument/prepareRename', model, { position: lspPosition(position) }));
          if (!result) return { range: model.getWordAtPosition(position) ? new m.Range(position.lineNumber, model.getWordAtPosition(position).startColumn, position.lineNumber, model.getWordAtPosition(position).endColumn) : new m.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: model.getWordAtPosition(position)?.word || '' };
          const range = result.range || result; return { range: monacoRange(m, range), text: result.placeholder || model.getValueInRange(monacoRange(m, range)) };
        },
        provideRenameEdits: async (model, position, newName) => {
          const result = this.firstResult(await this.sendRequest('textDocument/rename', model, { position: lspPosition(position), newName }));
          if (!result) return { edits: [], rejectReason: 'Language server did not return rename edits.' };
          return this.workspaceEdit(result);
        }
      }));

      this.disposables.push(m.languages.registerDocumentFormattingEditProvider(language, { provideDocumentFormattingEdits: async (model, options) => {
        const result = this.firstResult(await this.sendRequest('textDocument/formatting', model, { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: true, insertFinalNewline: false, trimFinalNewlines: false } }));
        return (result || []).map((edit) => ({ range: monacoRange(m, edit.range), text: String(edit.newText ?? '') }));
      }}));

      this.disposables.push(m.languages.registerDocumentSymbolProvider(language, { provideDocumentSymbols: async (model) => {
        const result = this.firstResult(await this.sendRequest('textDocument/documentSymbol', model, {})); if (!Array.isArray(result)) return [];
        const flatten = (items, containerName = '') => items.flatMap((item) => {
          const range = monacoRange(m, item.range || item.location?.range); const selectionRange = monacoRange(m, item.selectionRange || item.location?.range || item.range);
          const current = { name: item.name || '', detail: item.detail || '', kind: symbolKind(m, item.kind), range, selectionRange, tags: item.tags, children: [] };
          if (Array.isArray(item.children)) current.children = flatten(item.children, item.name || containerName);
          return current;
        });
        return flatten(result);
      }}));

      this.disposables.push(m.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [','],
        provideSignatureHelp: async (model, position, token, context) => {
          const result = this.firstResult(await this.sendRequest('textDocument/signatureHelp', model, { position: lspPosition(position), context: { triggerKind: context?.triggerKind || 1, triggerCharacter: context?.triggerCharacter, isRetrigger: Boolean(context?.isRetrigger), activeSignatureHelp: context?.activeSignatureHelp || null } }));
          if (!result) return null;
          return { value: { signatures: (result.signatures || []).map((signature) => ({ label: signature.label, documentation: markdownValue(signature.documentation), parameters: (signature.parameters || []).map((param) => ({ label: param.label, documentation: markdownValue(param.documentation) })), activeParameter: signature.activeParameter })), activeSignature: result.activeSignature || 0, activeParameter: result.activeParameter || 0 }, dispose() {} };
        }
      }));

      this.disposables.push(m.languages.registerCodeActionProvider(language, {
        provideCodeActions: async (model, range, context) => {
          const diagnostics = (context.markers || []).map((marker) => ({ range: lspRange(marker), severity: marker.severity >= m.MarkerSeverity.Error ? 1 : marker.severity >= m.MarkerSeverity.Warning ? 2 : 3, message: marker.message, source: marker.source, code: marker.code }));
          const results = await this.sendRequest('textDocument/codeAction', model, { range: lspRange(range), context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger } });
          const actions = [];
          for (const response of results.filter((item) => item.ok && Array.isArray(item.result))) {
            for (const action of response.result) {
              if (!action?.edit) continue; // command-only actions require server-initiated applyEdit; intentionally deferred.
              actions.push({ title: action.title || 'LSP code action', kind: action.kind, diagnostics: context.markers, isPreferred: action.isPreferred, disabled: action.disabled?.reason, edit: await this.workspaceEdit(action.edit) });
            }
          }
          return { actions, dispose() {} };
        }
      }, { providedCodeActionKinds: ['quickfix','refactor','source','source.organizeImports','source.fixAll'] }));
    }

    // Monaco standalone 0.55.1 has no workspace-symbol provider registration API.
    // Workspace symbol search is exposed by Studio at the application level instead.


    return this;
  }

  dispose() {
    for (const pending of this.syncTimers.values()) { clearTimeout(pending.timer); pending.resolve([]); }
    this.syncTimers.clear();
    for (const item of this.disposables) item?.dispose?.();
    this.disposables = [];
  }
}

export const LSP_SUPPORTED_LANGUAGES = Object.freeze([...SUPPORTED_LANGUAGES]);
