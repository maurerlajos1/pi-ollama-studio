import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { prepareSpawn } from './spawn-command.mjs';
import { terminateProcessTree } from './process-tree.mjs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT = 15000;
const TEXT_DOCUMENT_METHODS = new Set([
  'textDocument/completion', 'textDocument/hover', 'textDocument/definition',
  'textDocument/implementation', 'textDocument/references', 'textDocument/prepareRename',
  'textDocument/rename', 'textDocument/codeAction', 'textDocument/formatting',
  'textDocument/rangeFormatting', 'textDocument/documentSymbol', 'textDocument/signatureHelp'
]);
const ALLOWED_REQUESTS = new Set([...TEXT_DOCUMENT_METHODS, 'workspace/symbol']);

function normalizePath(value) { return String(value || '').replace(/\\/g, '/'); }
function workspaceUri(workspace) { return pathToFileURL(path.resolve(workspace)).href.replace(/\/$/, ''); }
function documentUri(workspace, relativePath) { return pathToFileURL(path.resolve(workspace, relativePath)).href; }

export function uriToWorkspacePath(workspace, uri) {
  if (!uri || !String(uri).startsWith('file:')) return '';
  try {
    const file = fileURLToPath(uri);
    const root = path.resolve(workspace);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return normalizePath(rel || '.');
  } catch { return ''; }
}

export function languageIdForPath(filePath) {
  const name = String(filePath || '').toLowerCase();
  const ext = path.extname(name);
  if (name.endsWith('.d.ts')) return 'typescript';
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.scss') return 'scss';
  if (ext === '.less') return 'less';
  if (ext === '.json') return 'json';
  if (ext === '.jsonc') return 'jsonc';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  return 'plaintext';
}

export function lspServerDefinitions(runtimeDir) {
  const nm = path.join(runtimeDir, 'node_modules');
  const node = process.execPath;
  const extracted = path.join(nm, '@zed-industries', 'vscode-langservers-extracted', 'bin');
  const angularRoot = path.join(nm, '@angular', 'language-server');
  return {
    typescript: {
      id: 'typescript', label: 'TypeScript / JavaScript', languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
      command: node,
      args: [path.join(nm, 'typescript-language-server', 'lib', 'cli.mjs'), '--stdio', '--log-level', '2'],
      initializationOptions: {
        hostInfo: 'Pi Ollama Studio',
        tsserver: { path: path.join(nm, '@angular', 'language-server', 'node_modules', 'typescript', 'lib', 'tsserver.js'), fallbackPath: path.join(nm, '@angular', 'language-server', 'node_modules', 'typescript', 'lib', 'tsserver.js') },
        preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true }
      }
    },
    pyright: {
      id: 'pyright', label: 'Python / Pyright', languages: ['python'], command: node,
      args: [path.join(nm, 'pyright', 'langserver.index.js'), '--stdio'],
      initializationOptions: {}
    },
    html: {
      id: 'html', label: 'HTML', languages: ['html'], command: node,
      args: [path.join(extracted, 'vscode-html-language-server'), '--stdio'], initializationOptions: {}
    },
    css: {
      id: 'css', label: 'CSS / SCSS / LESS', languages: ['css', 'scss', 'less'], command: node,
      args: [path.join(extracted, 'vscode-css-language-server'), '--stdio'], initializationOptions: {}, disabled: true, unavailableReason: 'Bundled upstream package does not contain the CSS server payload; Monaco CSS language service remains active.'
    },
    json: {
      id: 'json', label: 'JSON / JSONC', languages: ['json', 'jsonc'], command: node,
      args: [path.join(extracted, 'vscode-json-language-server'), '--stdio'], initializationOptions: { provideFormatter: true }, disabled: true, unavailableReason: 'Bundled upstream package does not contain the JSON server payload; Monaco JSON language service remains active.'
    },
    markdown: {
      id: 'markdown', label: 'Markdown', languages: ['markdown'], command: node,
      args: [path.join(extracted, 'vscode-markdown-language-server'), '--stdio'], initializationOptions: {}, disabled: true, unavailableReason: 'Bundled upstream package does not contain the Markdown server payload.'
    },
    eslint: {
      id: 'eslint', label: 'ESLint', languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'], command: node,
      args: [path.join(extracted, 'vscode-eslint-language-server'), '--stdio'], initializationOptions: { validate: 'on', run: 'onType' }, secondary: true, disabled: true, unavailableReason: 'Bundled upstream package does not contain the ESLint server payload.'
    },
    angular: {
      id: 'angular', label: 'Angular', languages: ['html', 'typescript', 'typescriptreact'], command: node,
      args: [
        path.join(angularRoot, 'index.js'), '--stdio',
        '--ngProbeLocations', nm,
        '--tsProbeLocations', path.join(angularRoot, 'node_modules')
      ],
      initializationOptions: {}, conditional: 'angular'
    }
  };
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function clientCapabilities() {
  return {
    workspace: {
      applyEdit: true, configuration: true, workspaceFolders: true,
      symbol: { dynamicRegistration: true }, executeCommand: { dynamicRegistration: true },
      didChangeWatchedFiles: { dynamicRegistration: true }, fileOperations: {}
    },
    textDocument: {
      synchronization: { dynamicRegistration: true, willSave: false, didSave: true },
      completion: { dynamicRegistration: true, contextSupport: true, completionItem: { snippetSupport: true, commitCharactersSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true, preselectSupport: true, insertReplaceSupport: true, labelDetailsSupport: true, resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } },
      hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: { dynamicRegistration: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
      declaration: { dynamicRegistration: true, linkSupport: true }, definition: { dynamicRegistration: true, linkSupport: true }, typeDefinition: { dynamicRegistration: true, linkSupport: true }, implementation: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true }, documentHighlight: { dynamicRegistration: true }, documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true, labelSupport: true },
      codeAction: { dynamicRegistration: true, dataSupport: true, disabledSupport: true, isPreferredSupport: true, resolveSupport: { properties: ['edit', 'command'] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ['','quickfix','refactor','refactor.extract','refactor.inline','refactor.rewrite','source','source.organizeImports','source.fixAll'] } } },
      formatting: { dynamicRegistration: true }, rangeFormatting: { dynamicRegistration: true },
      rename: { dynamicRegistration: true, prepareSupport: true, prepareSupportDefaultBehavior: 1, honorsChangeAnnotations: true },
      publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true, codeDescriptionSupport: true, dataSupport: true }
    },
    window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: true } }, showDocument: { support: false } },
    general: { positionEncodings: ['utf-16'], markdown: { parser: 'marked', version: '1.0.0' } }
  };
}

export class LspProcess extends EventEmitter {
  constructor({ definition, workspace, settings = {}, requestTimeout = DEFAULT_TIMEOUT, clientVersion = 'dev' } = {}) {
    super();
    if (!definition?.id) throw new Error('LSP definition is required');
    if (!workspace) throw new Error('LSP workspace is required');
    this.definition = definition;
    this.workspace = path.resolve(workspace);
    this.settings = settings;
    this.requestTimeout = requestTimeout;
    this.clientVersion = String(clientVersion || 'dev');
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.documents = new Map();
    this.capabilities = {};
    this.serverInfo = null;
    this.startedAt = null;
    this.lastError = null;
    this.initialized = false;
    this.stopping = false;
  }

  get running() { return Boolean(this.child && !this.child.killed && this.child.exitCode == null); }
  status() {
    return {
      id: this.definition.id, label: this.definition.label, running: this.running, initialized: this.initialized,
      pid: this.child?.pid || null, workspace: this.workspace, startedAt: this.startedAt,
      lastError: this.lastError, serverInfo: this.serverInfo, languages: this.definition.languages || [], secondary: Boolean(this.definition.secondary), capabilities: this.capabilities
    };
  }

  async start() {
    if (this.running && this.initialized) return this.status();
    if (this.running) return this.waitUntilInitialized();
    // Node exposes exitCode before the asynchronous 'exit' listener runs. If a
    // caller restarts in that window, reset the dead server's protocol state
    // synchronously so the replacement cannot inherit stale open documents.
    if (this.child && this.child.exitCode != null) {
      const staleChild = this.child;
      this.child = null; this.initialized = false; this.documents.clear(); this.buffer = Buffer.alloc(0);
      this.#rejectAll(new Error(this.lastError || 'Previous language server exited'));
      if (!this.stopping) void terminateProcessTree(staleChild, { graceMs: 600 }).catch(() => {});
    }
    this.stopping = false;
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    const childEnv = { ...process.env, ...(this.definition.env || {}) };
    const prepared = prepareSpawn(this.definition.command, this.definition.args || [], { cwd: this.workspace, env: childEnv });
    const child = spawn(prepared.command, prepared.args, {
      cwd: this.workspace, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', ...prepared.options
    });
    this.child = child;
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.on('data', (chunk) => this.emit('log', { serverId: this.definition.id, stream: 'stderr', text: chunk.toString('utf8') }));
    child.on('error', (error) => {
      // A replacement process may already own this LspProcess if the old child
      // failed between the running check and its delayed error/exit callbacks.
      if (this.child !== child) return;
      this.lastError = error.message;
      this.emit('error', error);
      this.#rejectAll(error);
    });
    child.on('exit', (code, signal) => {
      const expected = this.stopping;
      const ownsCurrentChild = this.child === child;
      if (!expected) void terminateProcessTree(child, { graceMs: 600 }).catch(() => {});
      // Never let a stale process event tear down a newer replacement server
      // or reject requests that belong to that replacement.
      if (!ownsCurrentChild) {
        this.emit('exit', { serverId: this.definition.id, code, signal, expected, stale: true });
        return;
      }
      this.child = null; this.initialized = false; this.documents.clear(); this.buffer = Buffer.alloc(0);
      if (!expected && code !== 0) this.lastError = `Language server exited with code ${code}${signal ? ` (${signal})` : ''}`;
      const error = new Error(this.lastError || 'Language server exited');
      this.#rejectAll(error);
      this.emit('exit', { serverId: this.definition.id, code, signal, expected, stale: false });
    });

    try {
      const init = await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Pi Ollama Studio', version: this.clientVersion },
        locale: 'en', rootPath: this.workspace, rootUri: workspaceUri(this.workspace),
        initializationOptions: this.definition.initializationOptions || {},
        capabilities: clientCapabilities(), trace: 'off',
        workspaceFolders: [{ uri: workspaceUri(this.workspace), name: path.basename(this.workspace) || this.workspace }]
      }, 25000);
      this.capabilities = init?.capabilities || {};
      this.serverInfo = init?.serverInfo || null;
      this.notify('initialized', {});
      this.notify('workspace/didChangeConfiguration', { settings: this.settings || {} });
      this.initialized = true;
      this.emit('ready', this.status());
      return this.status();
    } catch (error) {
      this.lastError = error.message;
      this.stopping = true;
      await terminateProcessTree(child, { graceMs: 600 }).catch(() => {});
      this.child = null;
      throw error;
    }
  }

  waitUntilInitialized(timeout = 25000) {
    if (this.initialized) return Promise.resolve(this.status());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${this.definition.label} initialization timed out`)); }, timeout);
      const ready = () => { cleanup(); resolve(this.status()); };
      const failed = (error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); };
      const cleanup = () => { clearTimeout(timer); this.off('ready', ready); this.off('error', failed); };
      this.once('ready', ready); this.once('error', failed);
    });
  }

  request(method, params = {}, timeout = this.requestTimeout) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error(`${this.definition.label} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.definition.label} request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(frame({ jsonrpc: '2.0', method, params }));
    return true;
  }

  async openDocument({ path: relativePath, languageId, text = '', version = 1 } = {}) {
    await this.start();
    const rel = normalizePath(relativePath);
    const uri = documentUri(this.workspace, rel);
    const existing = this.documents.get(rel);
    if (existing) return this.changeDocument({ path: rel, text, version: Math.max(Number(version) || 1, existing.version + 1) });
    const doc = { uri, languageId: languageId || languageIdForPath(rel), version: Math.max(1, Number(version) || 1), text: String(text ?? '') };
    this.documents.set(rel, doc);
    this.notify('textDocument/didOpen', { textDocument: doc });
    return doc;
  }

  async changeDocument({ path: relativePath, text = '', version } = {}) {
    await this.start();
    const rel = normalizePath(relativePath);
    let doc = this.documents.get(rel);
    if (!doc) return this.openDocument({ path: rel, languageId: languageIdForPath(rel), text, version });
    doc = { ...doc, version: Math.max(doc.version + 1, Number(version) || 0), text: String(text ?? '') };
    this.documents.set(rel, doc);
    this.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: doc.text }] });
    return doc;
  }

  saveDocument(relativePath, text = null) {
    const rel = normalizePath(relativePath);
    const doc = this.documents.get(rel);
    if (!doc) return false;
    this.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(text == null ? {} : { text: String(text) }) });
    return true;
  }

  closeDocument(relativePath) {
    const rel = normalizePath(relativePath);
    const doc = this.documents.get(rel);
    if (!doc) return false;
    this.documents.delete(rel);
    this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
    return true;
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    try { if (this.initialized) await this.request('shutdown', null, 2500).catch(() => null); } catch { /* ignore */ }
    try { this.notify('exit', null); } catch { /* ignore */ }
    await Promise.race([
      new Promise((resolve) => { if (!child || child.exitCode != null) resolve(); else child.once('exit', resolve); }),
      new Promise((resolve) => setTimeout(resolve, 900))
    ]);
    if (child?.exitCode == null) await terminateProcessTree(child, { graceMs: 900 }).catch(() => {});
    this.child = null; this.initialized = false; this.documents.clear(); this.buffer = Buffer.alloc(0);
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        const error = new Error(`${this.definition.label} sent invalid LSP framing`);
        this.lastError = error.message; this.emit('protocol-error', { serverId: this.definition.id, header });
        this.buffer = this.buffer.subarray(boundary + 4); continue;
      }
      const length = Number(match[1]);
      const total = boundary + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(boundary + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try { this.#handle(JSON.parse(body)); }
      catch (error) { this.emit('protocol-error', { serverId: this.definition.id, error: error.message, body: body.slice(0, 2000) }); }
    }
  }

  #handle(message) {
    if (message?.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `LSP error ${message.error.code}`));
      else pending.resolve(message.result);
      return;
    }
    if (message?.id != null && message.method) {
      Promise.resolve(this.#handleServerRequest(message.method, message.params || {}))
        .then((result) => this.child?.stdin?.writable && this.child.stdin.write(frame({ jsonrpc: '2.0', id: message.id, result: result ?? null })))
        .catch((error) => this.child?.stdin?.writable && this.child.stdin.write(frame({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })));
      return;
    }
    if (!message?.method) return;
    if (message.method === 'textDocument/publishDiagnostics') {
      const rel = uriToWorkspacePath(this.workspace, message.params?.uri);
      this.emit('diagnostics', { serverId: this.definition.id, path: rel, uri: message.params?.uri, version: message.params?.version ?? null, diagnostics: message.params?.diagnostics || [] });
    } else if (message.method === 'window/logMessage' || message.method === 'window/showMessage') {
      this.emit('log', { serverId: this.definition.id, stream: message.method, text: message.params?.message || '' });
    } else {
      this.emit('notification', { serverId: this.definition.id, method: message.method, params: message.params });
    }
  }

  #handleServerRequest(method, params) {
    switch (method) {
      case 'workspace/configuration': return (params.items || []).map((item) => this.#configurationFor(item.section));
      case 'workspace/workspaceFolders': return [{ uri: workspaceUri(this.workspace), name: path.basename(this.workspace) || this.workspace }];
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/diagnostic/refresh': return null;
      case 'window/showMessageRequest': return null;
      case 'workspace/applyEdit': return { applied: false, failureReason: 'Pi Ollama Studio applies user-requested workspace edits through Monaco.' };
      default: return null;
    }
  }

  #configurationFor(section) {
    if (!section) return this.settings || {};
    const parts = String(section).split('.');
    let value = this.settings;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return {};
      value = value[part];
    }
    return value ?? {};
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export class LspManager extends EventEmitter {
  constructor({ runtimeDir, definitions, settings = {}, clientVersion = 'dev' } = {}) {
    super();
    this.runtimeDir = runtimeDir;
    this.definitions = definitions || lspServerDefinitions(runtimeDir);
    this.settings = settings;
    this.clientVersion = String(clientVersion || 'dev');
    this.instances = new Map();
    this.angularWorkspaceCache = new Map();
  }

  serverDefinitions() {
    return Object.values(this.definitions).map(({ command, args, initializationOptions, ...item }) => ({ ...item, available: Boolean(command && args?.[0] && !item.disabled) }));
  }

  serversForLanguage(languageId, { workspace = '', includeSecondary = true } = {}) {
    return Object.values(this.definitions).filter((definition) => {
      if (definition.disabled) return false;
      if (!definition.languages?.includes(languageId)) return false;
      if (!includeSecondary && definition.secondary) return false;
      if (definition.conditional === 'angular' && !this.isAngularWorkspaceSync(workspace)) return false;
      return true;
    });
  }

  isAngularWorkspaceSync(workspace) {
    if (!workspace) return false;
    if (this.angularWorkspaceCache.has(workspace)) return this.angularWorkspaceCache.get(workspace);
    // Synchronous cache default: Angular is only selected after detectAngularWorkspace() has populated it.
    return false;
  }

  async detectAngularWorkspace(workspace) {
    const fs = await import('node:fs/promises');
    const root = path.resolve(workspace);
    let found = false;
    for (const file of ['angular.json', 'project.json']) {
      try { await fs.access(path.join(root, file)); found = true; break; } catch { /* continue */ }
    }
    this.angularWorkspaceCache.set(workspace, found);
    return found;
  }

  key(workspace, serverId) { return `${path.resolve(workspace)}\u0000${serverId}`; }

  async getOrStart(workspace, serverId) {
    const definition = this.definitions[serverId];
    if (!definition) throw new Error(`Unknown language server: ${serverId}`);
    if (definition.disabled) throw new Error(definition.unavailableReason || `${definition.label} is disabled`);
    if (definition.conditional === 'angular' && !(await this.detectAngularWorkspace(workspace))) throw new Error('Angular language server is only enabled for Angular workspaces');
    const key = this.key(workspace, serverId);
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new LspProcess({ definition, workspace, settings: this.settings[serverId] || {}, clientVersion: this.clientVersion });
      instance.on('diagnostics', (payload) => this.emit('diagnostics', { workspace: path.resolve(workspace), ...payload }));
      instance.on('log', (payload) => this.emit('log', { workspace: path.resolve(workspace), ...payload }));
      instance.on('notification', (payload) => this.emit('notification', { workspace: path.resolve(workspace), ...payload }));
      instance.on('protocol-error', (payload) => this.emit('protocol-error', { workspace: path.resolve(workspace), ...payload }));
      instance.on('ready', () => this.emit('status', { workspace: path.resolve(workspace), servers: this.status(workspace) }));
      instance.on('exit', () => this.emit('status', { workspace: path.resolve(workspace), servers: this.status(workspace) }));
      instance.on('error', (error) => this.emit('error', { workspace: path.resolve(workspace), serverId, error }));
      this.instances.set(key, instance);
    }
    await instance.start();
    return instance;
  }

  status(workspace = '') {
    const root = workspace ? path.resolve(workspace) : '';
    return [...this.instances.entries()]
      .filter(([key]) => !root || key.startsWith(`${root}\u0000`))
      .map(([, instance]) => instance.status());
  }

  async statusWithDefinitions(workspace) {
    await this.detectAngularWorkspace(workspace).catch(() => false);
    const active = new Map(this.status(workspace).map((item) => [item.id, item]));
    return this.serverDefinitions().map((definition) => ({
      ...definition,
      applicable: definition.conditional === 'angular' ? this.isAngularWorkspaceSync(workspace) : true,
      ...(active.get(definition.id) || { running: false, initialized: false, pid: null, workspace: path.resolve(workspace), lastError: null, serverInfo: null, capabilities: {} })
    }));
  }

  async syncDocument({ workspace, path: relativePath, languageId, text = '', version, action = 'open' } = {}) {
    const lang = languageId || languageIdForPath(relativePath);
    await this.detectAngularWorkspace(workspace).catch(() => false);
    const definitions = this.serversForLanguage(lang, { workspace });
    const results = [];
    for (const definition of definitions) {
      try {
        const server = await this.getOrStart(workspace, definition.id);
        if (action === 'close') server.closeDocument(relativePath);
        else if (action === 'save') server.saveDocument(relativePath, text);
        else if (action === 'change') await server.changeDocument({ path: relativePath, text, version });
        else await server.openDocument({ path: relativePath, languageId: lang, text, version });
        results.push({ serverId: definition.id, ok: true });
      } catch (error) {
        results.push({ serverId: definition.id, ok: false, error: error.message });
      }
    }
    return results;
  }

  async request({ workspace, path: relativePath = '', languageId, method, params = {}, text, version, serverId } = {}) {
    if (!ALLOWED_REQUESTS.has(method)) throw new Error(`Unsupported LSP request: ${method}`);
    const lang = languageId || languageIdForPath(relativePath);
    await this.detectAngularWorkspace(workspace).catch(() => false);
    let definitions;
    if (serverId) definitions = [this.definitions[serverId]].filter(Boolean);
    else if (method === 'workspace/symbol' && !relativePath) {
      const root = path.resolve(workspace);
      const seen = new Set();
      definitions = [...this.instances.entries()]
        .filter(([key, instance]) => key.startsWith(`${root}\u0000`) && instance?.running && instance?.initialized)
        .map(([, instance]) => instance.definition)
        .filter((definition) => definition && !definition.disabled && !seen.has(definition.id) && seen.add(definition.id));
    } else definitions = this.serversForLanguage(lang, { workspace, includeSecondary: method === 'textDocument/codeAction' });
    if (!definitions.length) return { results: [] };
    // Prefer the primary language server; ESLint/Angular can contribute code actions but should not duplicate navigation/completion.
    if (method !== 'textDocument/codeAction' && method !== 'textDocument/formatting' && method !== 'textDocument/rangeFormatting') {
      const angularPreferred = lang === 'html' && this.isAngularWorkspaceSync(workspace) ? definitions.find((definition) => definition.id === 'angular') : null;
      definitions = [angularPreferred || definitions.find((definition) => !definition.secondary && definition.id !== 'angular') || definitions[0]];
    }
    const results = [];
    for (const definition of definitions) {
      try {
        const server = await this.getOrStart(workspace, definition.id);
        if (relativePath && text != null) {
          const existing = server.documents.get(normalizePath(relativePath));
          if (existing) await server.changeDocument({ path: relativePath, text, version });
          else await server.openDocument({ path: relativePath, languageId: lang, text, version });
        }
        const requestParams = structuredClone(params || {});
        if (TEXT_DOCUMENT_METHODS.has(method) && relativePath) requestParams.textDocument = { uri: documentUri(workspace, relativePath) };
        const result = await server.request(method, requestParams);
        results.push({ serverId: definition.id, ok: true, result });
      } catch (error) {
        results.push({ serverId: definition.id, ok: false, error: error.message });
      }
    }
    return { results };
  }

  async restart(workspace, serverId = '') {
    const root = path.resolve(workspace);
    const targets = [...this.instances.entries()].filter(([key]) => key.startsWith(`${root}\u0000`) && (!serverId || key.endsWith(`\u0000${serverId}`)));
    for (const [key, instance] of targets) { await instance.stop().catch(() => null); this.instances.delete(key); }
    return this.statusWithDefinitions(workspace);
  }

  async stopWorkspace(workspace, serverId = '') { return this.restart(workspace, serverId); }
  async stopAll() {
    const targets = [...this.instances.values()]; this.instances.clear();
    await Promise.allSettled(targets.map((instance) => instance.stop()));
  }
}

export const LSP_ALLOWED_REQUESTS = Object.freeze([...ALLOWED_REQUESTS]);
