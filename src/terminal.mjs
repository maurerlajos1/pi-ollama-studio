import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from './process-tree.mjs';

const MAX_HISTORY_BYTES = 512 * 1024;

function trimHistory(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text) <= MAX_HISTORY_BYTES) return text;
  return Buffer.from(text).subarray(-MAX_HISTORY_BYTES).toString('utf8');
}

function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.POWERSHELL_EXE || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function defaultShellArgs(shell) {
  const lower = String(shell || '').toLowerCase();
  if (process.platform === 'win32' && lower.includes('powershell')) return ['-NoLogo'];
  return [];
}

function normalizeSize(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

let cachedPty = undefined;
async function loadNodePty() {
  if (cachedPty !== undefined) return cachedPty;
  try {
    const module = await import('node-pty');
    cachedPty = module.default || module;
  } catch {
    cachedPty = null;
  }
  return cachedPty;
}

export class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async capabilities() {
    return {
      pty: Boolean(await loadNodePty()),
      platform: process.platform,
      defaultShell: defaultShell()
    };
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      backend: session.backend,
      pid: session.pid,
      workspace: session.workspace,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt || null,
      exitCode: session.exitCode ?? null,
      status: session.exitedAt ? 'exited' : 'running',
      history: session.history
    }));
  }

  get(id) {
    return this.sessions.get(String(id || '')) || null;
  }

  async create({ workspace, shell, name, cols = 120, rows = 30, env = {} } = {}) {
    const cwd = path.resolve(String(workspace || process.cwd()));
    const executable = String(shell || defaultShell());
    const normalizedCols = normalizeSize(cols, 120, 2, 1000);
    const normalizedRows = normalizeSize(rows, 30, 1, 500);
    const id = randomUUID();
    const session = {
      id,
      name: String(name || path.basename(cwd) || 'Terminal'),
      workspace: cwd,
      shell: executable,
      cols: normalizedCols,
      rows: normalizedRows,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      history: '',
      process: null,
      backend: 'pipe',
      pid: null
    };

    const childEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(env || {}) };
    const pty = await loadNodePty();
    if (pty?.spawn) {
      const terminal = pty.spawn(executable, defaultShellArgs(executable), {
        name: 'xterm-256color',
        cols: normalizedCols,
        rows: normalizedRows,
        cwd,
        env: childEnv
      });
      session.process = terminal;
      session.backend = 'pty';
      session.pid = terminal.pid;
      terminal.onData((data) => this.#recordData(session, data));
      terminal.onExit(({ exitCode, signal }) => this.#recordExit(session, exitCode, signal));
    } else {
      const child = spawn(executable, defaultShellArgs(executable), {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      session.process = child;
      session.backend = 'pipe';
      session.pid = child.pid;
      child.stdout?.on('data', (chunk) => this.#recordData(session, String(chunk)));
      child.stderr?.on('data', (chunk) => this.#recordData(session, String(chunk)));
      child.on('error', (error) => this.#recordData(session, `\r\n[terminal error] ${error.message}\r\n`));
      child.on('exit', (code, signal) => this.#recordExit(session, code, signal));
    }

    this.sessions.set(id, session);
    this.emit('created', this.#public(session));
    return this.#public(session);
  }

  write(id, data) {
    const session = this.get(id);
    if (!session) throw Object.assign(new Error('Terminal session not found'), { statusCode: 404 });
    if (session.exitedAt) throw Object.assign(new Error('Terminal session has exited'), { statusCode: 409 });
    const value = String(data ?? '');
    if (session.backend === 'pty') session.process.write(value);
    else session.process.stdin?.write(value);
    return this.#public(session);
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) throw Object.assign(new Error('Terminal session not found'), { statusCode: 404 });
    session.cols = normalizeSize(cols, session.cols, 2, 1000);
    session.rows = normalizeSize(rows, session.rows, 1, 500);
    if (session.backend === 'pty' && !session.exitedAt) {
      try { session.process.resize(session.cols, session.rows); } catch { /* terminal may be exiting */ }
    }
    return this.#public(session);
  }

  async kill(id) {
    const session = this.get(id);
    if (!session) return { ok: true, removed: false };
    if (!session.exitedAt) {
      if (session.backend === 'pipe') await terminateProcessTree(session.process).catch(() => {});
      else { try { session.process.kill(); } catch { /* ignore already-exited PTY */ } }
    }
    this.sessions.delete(session.id);
    this.emit('removed', { id: session.id });
    return { ok: true, removed: true };
  }

  async dispose() {
    for (const session of [...this.sessions.values()]) await this.kill(session.id).catch(() => {});
    this.sessions.clear();
  }

  #recordData(session, data) {
    session.history = trimHistory(session.history + String(data || ''));
    this.emit('data', { id: session.id, data: String(data || '') });
  }

  #recordExit(session, exitCode, signal) {
    if (session.exitedAt) return;
    session.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    session.exitSignal = signal || null;
    session.exitedAt = new Date().toISOString();
    this.emit('exit', {
      id: session.id,
      exitCode: session.exitCode,
      signal: session.exitSignal,
      exitedAt: session.exitedAt
    });
  }

  #public(session) {
    return {
      id: session.id,
      name: session.name,
      backend: session.backend,
      pid: session.pid,
      workspace: session.workspace,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      status: session.exitedAt ? 'exited' : 'running',
      history: session.history
    };
  }
}
