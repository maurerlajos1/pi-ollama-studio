import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalWorkspacePath, readConfig, resolveWorkspaceSessionDir } from './config.mjs';
import { prepareSpawn } from './spawn-command.mjs';
import { terminateProcessTree } from './process-tree.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_AGENTS_MD = `# Workspace Agent Guidelines

## Code Quality & Execution
- Inspect existing codebase and relevant files before editing.
- Write clean, complete, fully working code without leaving unfinished stubs or placeholder comments.
- Run tests or verify syntax whenever editing project files.
- Keep tool calls targeted and concise.
`;

async function ensureWorkspaceAgentsMd(cwd, cfg = {}) {
  try {
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const dotAgentsPath = path.join(cwd, '.agents', 'AGENTS.md');
    const hasAgents = await fs.stat(agentsPath).then(() => true).catch(() => false);
    const hasDotAgents = await fs.stat(dotAgentsPath).then(() => true).catch(() => false);
    if (!hasAgents && !hasDotAgents) {
      const content = cfg.defaultAgentsMd || DEFAULT_AGENTS_MD;
      await fs.writeFile(agentsPath, content, 'utf8');
    }
  } catch {
    /* ignore permission errors */
  }
}

export class PiRpcProcess extends EventEmitter {
  #child = null;
  #stdoutBuffer = '';
  #pending = new Map();
  #counter = 0;
  #lifecycle = Promise.resolve();

  workspace = null;
  sessionDir = null;
  modelId = null;
  harnessId = null;
  tools = null;
  startedAt = null;
  lastError = null;

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null && !this.#child.killed);
  }

  status() {
    return {
      running: this.running,
      workspace: this.workspace,
      sessionDir: this.sessionDir,
      modelId: this.modelId,
      harnessId: this.harnessId,
      tools: this.tools ? [...this.tools] : null,
      startedAt: this.startedAt,
      pid: this.#child?.pid || null,
      lastError: this.lastError
    };
  }

  #enqueueLifecycle(task) {
    const run = this.#lifecycle.catch(() => {}).then(task);
    this.#lifecycle = run.catch(() => {});
    return run;
  }

  start(options = {}) {
    return this.#enqueueLifecycle(() => this.#startUnlocked(options));
  }

  async #startUnlocked({ workspace, provider: inputProvider, modelId, sessionPath, sessionName, mcpBridgeUrl, harnessId = 'coding-default', tools = null, appendSystemPrompt = '', extensions = [] } = {}) {
    await this.#stopUnlocked();
    const cfg = await readConfig();
    const requestedCwd = path.resolve(workspace || cfg.defaultWorkspace || process.cwd());
    const stat = await fs.stat(requestedCwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${requestedCwd}`);
    const cwd = await canonicalWorkspacePath(requestedCwd);

    await ensureWorkspaceAgentsMd(cwd, cfg);

    const sessionDir = await resolveWorkspaceSessionDir(cwd, { create: true });

    let resolvedSessionPath = null;
    if (sessionPath) {
      const sessionRoot = await fs.realpath(sessionDir);
      resolvedSessionPath = await fs.realpath(path.resolve(String(sessionPath)));
      const rel = path.relative(sessionRoot, resolvedSessionPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw Object.assign(new Error('Session path is outside the selected workspace session directory'), { statusCode: 403 });
      }
      const sessionStat = await fs.stat(resolvedSessionPath);
      if (!sessionStat.isFile()) throw new Error('Session path is not a file');
    }

    const selectedModel = String(modelId || cfg.defaultModel || '').trim();
    const selectedProvider = String(inputProvider || '').trim();

    const args = ['--mode', 'rpc', '--session-dir', sessionDir];
    if (cfg.trustProjects) args.push('--approve');
    else args.push('--no-approve');

    if (selectedModel) {
      let provider = selectedProvider;
      let model = selectedModel;
      if (!provider) {
        if (selectedModel.startsWith('ollama/')) {
          provider = 'ollama';
          model = selectedModel.slice(7);
        } else if (selectedModel.includes('/') && !selectedModel.startsWith('hf.co/')) {
          const parts = selectedModel.split('/');
          provider = parts[0];
          model = parts.slice(1).join('/');
        } else {
          provider = 'ollama';
        }
      }
      args.push('--provider', provider, '--model', model);
      // Ollama credentials are resolved through Pi's provider configuration in models.json.
      // Do not place bearer tokens (or placeholder keys) in process arguments: remote runtimes
      // may reference an environment variable such as $OLLAMA_API_KEY there.
    }

    if (Array.isArray(tools) && tools.length) {
      const normalizedTools = [...new Set(tools.map((item) => String(item || '').trim()).filter(Boolean))];
      if (normalizedTools.length) args.push('--tools', normalizedTools.join(','));
    }
    if (String(appendSystemPrompt || '').trim()) args.push('--append-system-prompt', String(appendSystemPrompt).trim());
    for (const extension of Array.isArray(extensions) ? extensions : []) {
      const rawExtensionPath = String(extension || '').trim();
      if (rawExtensionPath) args.push('--extension', path.resolve(rawExtensionPath));
    }
    if (resolvedSessionPath) args.push('--session', resolvedSessionPath);

    const childEnv = {
      ...process.env,
      NO_COLOR: '1', FORCE_COLOR: '0',
      PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || '1',
      PI_OFFLINE: cfg.noCloud ? '1' : (process.env.PI_OFFLINE || '0'),
      // Pi extensions such as @ollama/pi-web-search must use the same
      // runtime Studio selected for the session, not Ollama's default 11434.
      PI_OLLAMA_BASE_URL: String(cfg.ollamaBaseUrl || '').replace(/\/+$/, ''),
      ...(mcpBridgeUrl ? { PI_OLLAMA_STUDIO_MCP_URL: String(mcpBridgeUrl), PI_OLLAMA_STUDIO_URL: String(mcpBridgeUrl) } : {})
    };
    const prepared = prepareSpawn(cfg.piCommand, args, { cwd, env: childEnv });
    const child = spawn(prepared.command, prepared.args, {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', ...prepared.options
    });

    this.#child = child;
    this.#stdoutBuffer = '';
    this.workspace = cwd;
    this.sessionDir = sessionDir;
    this.modelId = selectedModel || null;
    this.harnessId = String(harnessId || 'coding-default').trim() || 'coding-default';
    this.tools = Array.isArray(tools) ? [...new Set(tools.map((item) => String(item || '').trim()).filter(Boolean))] : null;
    this.startedAt = new Date().toISOString();
    this.lastError = null;

    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => { if (this.#child === child) this.#consumeStdout(decoder.write(chunk)); });
    child.stdout.on('end', () => { if (this.#child === child) this.#consumeStdout(decoder.end(), true); });
    child.stderr.on('data', (chunk) => { if (this.#child === child) this.emit('stderr', String(chunk)); });

    child.on('error', (error) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.lastError = error.message;
      this.emit('error', error);
      this.#rejectPending(error);
    });
    child.on('exit', (code, signal) => {
      const expected = this.#child !== child;
      const stale = expected && Boolean(this.#child);
      if (!expected) {
        this.#child = null;
        void terminateProcessTree(child, { graceMs: 600 }).catch(() => {});
        this.#rejectPending(new Error(`Pi RPC exited${code == null ? '' : ` with code ${code}`}`));
      }
      this.emit('exit', { code, signal, expected, stale });
    });

    try {
      // Give the process a moment to fail fast, then verify the protocol with get_state.
      await Promise.race([
        sleep(250),
        new Promise((_, reject) => child.once('error', reject)),
        new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`Pi exited during startup with code ${code}`))))
      ]);
      let state = await this.request({ type: 'get_state' }, 15000);
      if (String(sessionName || '').trim()) {
        await this.request({ type: 'set_session_name', name: String(sessionName).trim() }, 15000);
        state = await this.request({ type: 'get_state' }, 15000);
      }
      this.emit('started', this.status());
      return state;
    } catch (error) {
      this.lastError = error.message;
      if (this.#child === child) await this.#stopUnlocked().catch(() => {});
      throw error;
    }
  }

  #consumeStdout(text, flush = false) {
    this.#stdoutBuffer += text;
    let index;
    while ((index = this.#stdoutBuffer.indexOf('\n')) >= 0) {
      let record = this.#stdoutBuffer.slice(0, index);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (record.endsWith('\r')) record = record.slice(0, -1);
      if (record) this.#handleRecord(record);
    }
    if (flush && this.#stdoutBuffer.trim()) {
      this.#handleRecord(this.#stdoutBuffer.trim());
      this.#stdoutBuffer = '';
    }
  }

  #handleRecord(record) {
    let payload;
    try {
      payload = JSON.parse(record);
    } catch (error) {
      this.emit('protocol-error', { record, error: error.message });
      return;
    }

    if (payload?.type === 'response' && payload.id && this.#pending.has(payload.id)) {
      const pending = this.#pending.get(payload.id);
      this.#pending.delete(payload.id);
      clearTimeout(pending.timer);
      if (payload.success === false) pending.reject(new Error(payload.error || `${payload.command || 'Pi command'} failed`));
      else {
        if (pending.command?.type === 'set_model') {
          const provider = String(pending.command.provider || '').trim();
          const model = String(pending.command.modelId || pending.command.model || '').trim();
          if (model) this.modelId = provider && provider !== 'ollama' ? `${provider}/${model}` : model;
        }
        pending.resolve(payload);
      }
    }
    this.emit('event', payload);
  }

  send(command) {
    if (!this.#child?.stdin?.writable) throw new Error('Pi RPC is not running');
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  request(command, timeoutMs = 60000) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Pi RPC command must be an object');
    const id = String(command.id || `studio-${Date.now()}-${++this.#counter}`);
    if (this.#pending.has(id)) {
      return Promise.reject(Object.assign(new Error(`Pi RPC request ID is already in flight: ${id}`), { code: 'PI_RPC_DUPLICATE_ID' }));
    }
    const request = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${request.type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, command: request });
      try {
        this.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  respondToExtension(command) {
    if (command?.type !== 'extension_ui_response') throw new Error('Expected extension_ui_response');
    this.send(command);
  }

  stop({ expectedWorkspace = '' } = {}) {
    return this.#enqueueLifecycle(async () => {
      const expected = String(expectedWorkspace || '').trim();
      if (expected && this.running && this.workspace) {
        const [expectedReal, activeReal] = await Promise.all([
          canonicalWorkspacePath(expected).catch(() => path.resolve(expected)),
          canonicalWorkspacePath(this.workspace).catch(() => path.resolve(this.workspace))
        ]);
        const expectedKey = process.platform === 'win32' ? expectedReal.toLowerCase() : expectedReal;
        const activeKey = process.platform === 'win32' ? activeReal.toLowerCase() : activeReal;
        if (expectedKey !== activeKey) {
          return { stopped: false, reason: 'workspace-mismatch', status: this.status() };
        }
      }
      await this.#stopUnlocked();
      return { stopped: true, status: this.status() };
    });
  }

  async #stopUnlocked() {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    try { child.stdin.end(); } catch { /* already closed */ }
    await terminateProcessTree(child, { graceMs: 1200 }).catch(() => {});
    this.#rejectPending(new Error('Pi RPC stopped'));
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
