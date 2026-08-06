import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readConfig, resolveWorkspaceSessionDir } from './config.mjs';

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

  workspace = null;
  sessionDir = null;
  modelId = null;
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
      startedAt: this.startedAt,
      pid: this.#child?.pid || null,
      lastError: this.lastError
    };
  }

  async start({ workspace, provider: inputProvider, modelId, sessionPath, sessionName } = {}) {
    await this.stop();
    const cfg = await readConfig();
    const cwd = path.resolve(workspace || cfg.defaultWorkspace || process.cwd());
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${cwd}`);

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
      if (provider === 'ollama') {
        args.push('--api-key', 'ollama');
      }
    }

    if (resolvedSessionPath) args.push('--session', resolvedSessionPath);

    const child = spawn(cfg.piCommand, args, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || '1',
        PI_OFFLINE: cfg.noCloud ? '1' : (process.env.PI_OFFLINE || '0')
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true
    });

    this.#child = child;
    this.#stdoutBuffer = '';
    this.workspace = cwd;
    this.sessionDir = sessionDir;
    this.modelId = selectedModel || null;
    this.startedAt = new Date().toISOString();
    this.lastError = null;

    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => this.#consumeStdout(decoder.write(chunk)));
    child.stdout.on('end', () => this.#consumeStdout(decoder.end(), true));
    child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));

    child.on('error', (error) => {
      if (this.#child === child) this.#child = null;
      this.lastError = error.message;
      this.emit('error', error);
      this.#rejectPending(error);
    });
    child.on('exit', (code, signal) => {
      const expected = this.#child !== child;
      if (this.#child === child) this.#child = null;
      this.emit('exit', { code, signal, expected });
      this.#rejectPending(new Error(`Pi RPC exited${code == null ? '' : ` with code ${code}`}`));
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
      if (this.#child === child) await this.stop().catch(() => {});
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
      else pending.resolve(payload);
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
    const request = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${request.type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
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

  async stop() {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2500).then(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      })
    ]);
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
