import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { PiRpcProcess } from './src/pi-rpc.mjs';
import { readConfig, writeConfig } from './src/config.mjs';
import {
  createModelProfile,
  deleteModel,
  getOllamaStatus,
  loadProfiles,
  modelDiagnostics,
  pullModel,
  showModel,
  syncPiModels,
  unloadModel
} from './src/ollama.mjs';
import { inspectSession, listSessions } from './src/sessions.mjs';
import { getGitStatus, getSystemStatus, gitCommit, gitDiff, gitStage, ManagedOllama, openNativeFolderPicker } from './src/system.mjs';
import { isLoopbackHost } from './src/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PACKAGE = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const BODY_LIMIT = 25 * 1024 * 1024;
const pi = new PiRpcProcess();
const managedOllama = new ManagedOllama();
const sseClients = new Set();
const terminalSessions = new Map();
let piCommandsInFlight = 0;
const PI_COMMAND_CONCURRENCY_LIMIT = 8;
const state = {
  piState: null,
  piStats: null,
  lastPiEvent: null,
  lastError: null,
  startedAt: new Date().toISOString()
};

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function errorJson(res, status, error) {
  const message = error instanceof Error ? error.message : String(error);
  json(res, status, { ok: false, error: message });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 }); }
}

function sendEvent(event, data) {
  const record = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(record); } catch { sseClients.delete(client); }
  }
}

function routeMatch(pathname, pattern) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}

function lexicalWorkspacePath(workspace, relative = '.') {
  if (!String(workspace || '').trim()) throw new Error('Workspace is required');
  const root = path.resolve(String(workspace));
  const target = path.resolve(root, String(relative || '.'));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw forbidden('Path escapes the selected workspace');
  return { root, target, relative: rel || '.' };
}

async function nearestExistingPath(target) {
  let current = target;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function resolveWorkspacePath(workspace, relative = '.', { allowMissing = false } = {}) {
  const lexical = lexicalWorkspacePath(workspace, relative);
  const rootReal = await fs.realpath(lexical.root).catch((error) => {
    if (error?.code === 'ENOENT') throw Object.assign(new Error('Workspace does not exist'), { statusCode: 404 });
    throw error;
  });
  const existing = allowMissing ? await nearestExistingPath(lexical.target) : lexical.target;
  const existingReal = await fs.realpath(existing).catch((error) => {
    if (error?.code === 'ENOENT') throw Object.assign(new Error('Path does not exist'), { statusCode: 404 });
    throw error;
  });
  const realRel = path.relative(rootReal, existingReal);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw forbidden('Path resolves outside the selected workspace');
  const target = allowMissing && existing !== lexical.target ? lexical.target : existingReal;
  return { root: rootReal, target, relative: path.relative(lexical.root, lexical.target) || '.' };
}

const ignoredNames = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '__pycache__', '.venv', 'venv']);

async function workspaceTree(workspace, relative = '.', depth = 2) {
  const { root, target } = await resolveWorkspacePath(workspace, relative);
  const maxDepth = Math.max(0, Math.min(5, Number(depth) || 2));
  const walk = async (dir, currentDepth) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (ignoredNames.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const item = { name: entry.name, path: rel, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        item.size = stat?.size || 0;
      } else if (entry.isDirectory() && currentDepth < maxDepth) {
        item.children = await walk(full, currentDepth + 1).catch(() => []);
      }
      results.push(item);
    }
    return results;
  };
  return { workspace: root, path: path.relative(root, target).split(path.sep).join('/') || '.', entries: await walk(target, 0) };
}

async function getPiSnapshot() {
  if (!pi.running) return { status: pi.status(), state: null, stats: null };
  const [piState, stats] = await Promise.allSettled([
    pi.request({ type: 'get_state' }, 10000),
    pi.request({ type: 'get_session_stats' }, 10000)
  ]);
  if (piState.status === 'fulfilled') state.piState = piState.value.data;
  if (stats.status === 'fulfilled') state.piStats = stats.value.data;
  return { status: pi.status(), state: state.piState, stats: state.piStats };
}

async function refreshPiSnapshot() {
  try {
    const snapshot = await getPiSnapshot();
    sendEvent('pi_snapshot', snapshot);
  } catch (error) {
    sendEvent('server_error', { source: 'pi_snapshot', error: error.message });
  }
}

pi.on('event', (event) => {
  state.lastPiEvent = event;
  sendEvent('pi_event', event);
  if (['agent_settled', 'message_end', 'compaction_end', 'queue_update'].includes(event?.type)) {
    setTimeout(refreshPiSnapshot, 25).unref?.();
  }
});
pi.on('stderr', (text) => sendEvent('pi_stderr', { text }));
pi.on('protocol-error', (payload) => sendEvent('pi_protocol_error', payload));
pi.on('started', (payload) => sendEvent('pi_status', payload));
pi.on('exit', (payload) => {
  state.piState = null;
  state.piStats = null;
  sendEvent('pi_status', { ...pi.status(), exit: payload });
});
pi.on('error', (error) => {
  state.lastError = error.message;
  sendEvent('server_error', { source: 'pi', error: error.message });
});
managedOllama.on('log', (record) => sendEvent('ollama_log', record));
managedOllama.on('exit', (payload) => sendEvent('ollama_managed_status', { ...managedOllama.status(), exit: payload }));
managedOllama.on('error', (error) => sendEvent('server_error', { source: 'managed_ollama', error: error.message }));

async function bootstrap() {
  const config = await readConfig();
  const [system, ollama, profiles, piSnapshot] = await Promise.all([
    getSystemStatus(),
    getOllamaStatus(),
    loadProfiles(),
    getPiSnapshot()
  ]);
  return {
    ok: true,
    config,
    system,
    ollama,
    profiles: profiles.profiles,
    pi: piSnapshot,
    managedOllama: managedOllama.status(),
    app: { version: PACKAGE.version, startedAt: state.startedAt }
  };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { clearInterval(heartbeat); }
    }, 15000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    json(res, 200, await bootstrap());
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/config') {
    json(res, 200, { ok: true, config: await readConfig() });
    return true;
  }
  if (req.method === 'PUT' && pathname === '/api/config') {
    const config = await writeConfig(await readBody(req));
    sendEvent('config', config);
    json(res, 200, { ok: true, config });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/system') {
    json(res, 200, { ok: true, system: await getSystemStatus() });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    json(res, 200, {
      ok: true,
      pi: await getPiSnapshot(),
      ollama: await getOllamaStatus(),
      managedOllama: managedOllama.status(),
      system: await getSystemStatus()
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/pi/start') {
    const body = await readBody(req);
    await syncPiModels().catch((error) => sendEvent('server_error', { source: 'model_sync', error: error.message }));
    const response = await pi.start(body);
    state.piState = response.data;
    await refreshPiSnapshot();
    json(res, 200, { ok: true, response, status: pi.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/pi/stop') {
    await pi.stop();
    state.piState = null;
    state.piStats = null;
    json(res, 200, { ok: true, status: pi.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/pi/command') {
    const command = await readBody(req);
    if (command?.type === 'extension_ui_response') {
      pi.respondToExtension(command);
      json(res, 200, { ok: true, sent: true });
    } else {
      if (piCommandsInFlight >= PI_COMMAND_CONCURRENCY_LIMIT) {
        return errorJson(res, 429, 'Too many concurrent Pi commands — please wait for the current turn to finish');
      }
      piCommandsInFlight++;
      const timeoutMs = 10 * 60 * 1000; // 10 minutes timeout for long context/reasoning turns
      try {
        const response = await pi.request(command, timeoutMs);
        json(res, 200, { ok: true, response });
      } finally {
        piCommandsInFlight--;
      }
    }
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/pi/snapshot') {
    json(res, 200, { ok: true, ...(await getPiSnapshot()) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const workspace = searchParams.get('workspace');
    json(res, 200, { ok: true, sessions: await listSessions(workspace) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/session/inspect') {
    json(res, 200, { ok: true, session: await inspectSession(searchParams.get('workspace'), searchParams.get('path')) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/ollama/status') {
    json(res, 200, { ok: true, ollama: await getOllamaStatus(), profiles: (await loadProfiles()).profiles });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/ollama/show') {
    json(res, 200, { ok: true, model: await showModel(searchParams.get('model')) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/ollama/diagnostics') {
    const cfg = await readConfig();
    const model = searchParams.get('model');
    const contextLength = Number(searchParams.get('contextLength') || cfg.defaultContextLength);
    json(res, 200, {
      ok: true,
      diagnostics: await modelDiagnostics(model, contextLength, searchParams.get('kvType') || cfg.kvCacheType, Number(searchParams.get('parallel') || cfg.numParallel))
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/profile') {
    const body = await readBody(req);
    const profile = await createModelProfile(body, (event) => sendEvent('ollama_operation', { operation: 'create', model: body.name, event }));
    sendEvent('ollama_models_changed', await getOllamaStatus());
    json(res, 200, { ok: true, profile });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/pull') {
    const body = await readBody(req);
    await pullModel(body.model, (event) => sendEvent('ollama_operation', { operation: 'pull', model: body.model, event }));
    await syncPiModels();
    sendEvent('ollama_models_changed', await getOllamaStatus());
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'DELETE' && pathname === '/api/ollama/model') {
    const body = await readBody(req);
    await deleteModel(body.model);
    sendEvent('ollama_models_changed', await getOllamaStatus());
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/unload') {
    const body = await readBody(req);
    await unloadModel(body.model);
    sendEvent('ollama_models_changed', await getOllamaStatus());
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/sync') {
    json(res, 200, { ok: true, provider: await syncPiModels() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/managed/start') {
    json(res, 200, { ok: true, status: await managedOllama.start() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/managed/stop') {
    json(res, 200, { ok: true, status: await managedOllama.stop() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/ollama/managed/restart') {
    json(res, 200, { ok: true, status: await managedOllama.restart() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/workspace/select-folder') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    const result = await openNativeFolderPicker(body.current || '');
    json(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/workspace/tree') {
    json(res, 200, { ok: true, tree: await workspaceTree(searchParams.get('workspace'), searchParams.get('path') || '.', searchParams.get('depth') || 2) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/terminal/sessions') {
    const list = [];
    const piStatus = pi.status();
    if (piStatus.running) {
      list.push({
        id: `pi-rpc-${piStatus.pid}`,
        pid: piStatus.pid,
        name: 'Pi RPC Engine Process',
        type: 'rpc',
        workspace: piStatus.workspace,
        model: piStatus.modelId,
        sessionFile: state.piState?.sessionFile || null,
        startedAt: piStatus.startedAt,
        status: 'running'
      });
    }
    for (const [id, item] of terminalSessions) {
      let isAlive = false;
      try {
        if (item.pid) isAlive = process.kill(item.pid, 0);
      } catch { isAlive = false; }
      if (isAlive) {
        list.push({ id, ...item, status: 'running' });
      } else {
        terminalSessions.delete(id);
      }
    }
    json(res, 200, { ok: true, sessions: list });
    return true;
  }

  if (req.method === 'POST' && (pathname === '/api/terminal/launch' || pathname === '/api/workspace/terminal')) {
    const body = await readBody(req);
    const cfg = await readConfig();
    const targetDir = path.resolve(body?.workspace || cfg.defaultWorkspace || process.cwd());
    const stat = await fs.stat(targetDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Workspace does not exist: ${targetDir}`);

    const model = String(body?.model || cfg.defaultModel || '').trim();
    const sessionFile = String(body?.sessionFile || '').trim();
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    let childPid = null;
    if (process.platform === 'win32') {
      // CR-03: Reject paths containing PowerShell injection characters (backtick, $(), &, ;)
      // before interpolating targetDir into the -Command string.
      if (/[`$&|;]/.test(targetDir)) throw new Error('Workspace path contains characters that are unsafe for terminal launch on Windows');
      const psEnv = `$env:OLLAMA_MODELS="H:\\ollama-models"; Set-Location -LiteralPath "${targetDir.replace(/"/g, '""')}"`;
      let piCmd = cfg.piCommand || 'pi';
      if (model) {
        const cleanModel = model.startsWith('ollama/') ? model.slice(7) : model;
        piCmd += ` --provider ollama --model "${cleanModel.replace(/"/g, '""')}"`;
      }
      if (sessionFile) {
        piCmd += ` --session "${sessionFile.replace(/"/g, '""')}"`;
      }
      const psScript = `${psEnv}; Write-Host "=== Pi Ollama Studio — Attached Session Terminal ===" -ForegroundColor Cyan; ${piCmd}`;
      const proc = spawn('powershell.exe', ['-NoExit', '-Command', psScript], {
        detached: true,
        stdio: 'ignore'
      });
      childPid = proc.pid;
      proc.unref();
    } else {
      const proc = spawn('x-terminal-emulator', ['--working-directory', targetDir], { detached: true, stdio: 'ignore' });
      childPid = proc.pid;
      proc.unref();
    }

    const sessionInfo = {
      id,
      pid: childPid,
      name: `Terminal ${model ? `(${model.split(':')[0]})` : ''}`,
      type: 'desktop',
      workspace: targetDir,
      model,
      sessionFile,
      startedAt: new Date().toISOString()
    };
    terminalSessions.set(id, sessionInfo);

    json(res, 200, { ok: true, session: sessionInfo, workspace: targetDir });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/terminal/kill') {
    const body = await readBody(req);
    const id = String(body?.id || '');
    const pid = Number(body?.pid);
    if (!id && !pid) throw new Error('Terminal session ID or PID is required');

    let killed = false;
    if (id && terminalSessions.has(id)) {
      const item = terminalSessions.get(id);
      if (item?.pid) {
        try { process.kill(item.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      terminalSessions.delete(id);
      killed = true;
    } else if (pid) {
      try { process.kill(pid, 'SIGKILL'); killed = true; } catch { /* ignore */ }
    }
    json(res, 200, { ok: true, killed });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/file') {
    const { target, relative } = await resolveWorkspacePath(searchParams.get('workspace'), searchParams.get('path'));
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Path is not a file');
    if (stat.size > 3 * 1024 * 1024) throw new Error('File is larger than the 3 MB editor limit');
    const content = await fs.readFile(target, 'utf8');
    json(res, 200, { ok: true, file: { path: relative.split(path.sep).join('/'), content, size: stat.size, modifiedAt: stat.mtime.toISOString() } });
    return true;
  }
  if (req.method === 'PUT' && pathname === '/api/workspace/file') {
    const body = await readBody(req);
    const { target, relative } = await resolveWorkspacePath(body.workspace, body.path, { allowMissing: true });
    const content = String(body.content ?? '');
    if (Buffer.byteLength(content) > 3 * 1024 * 1024) throw new Error('File is larger than the 3 MB editor limit');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    sendEvent('workspace_file_changed', { path: relative.split(path.sep).join('/'), source: 'editor' });
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/git') {
    const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
    json(res, 200, { ok: true, git: await getGitStatus(root) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/git/diff') {
    // CR-01: Validate path with workspace containment before passing to gitDiff.
    const { root, relative } = await resolveWorkspacePath(searchParams.get('workspace'), searchParams.get('path') || '.');
    const staged = searchParams.get('staged') === '1';
    json(res, 200, { ok: true, diff: await gitDiff(root, relative, staged) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/workspace/git/stage') {
    // CR-02: Validate path with workspace containment before passing to gitStage.
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const all = Boolean(body.all);
    let filePath = '.';
    if (!all) {
      const resolved = await resolveWorkspacePath(body.workspace, body.path || '.');
      filePath = resolved.relative;
    }
    await gitStage(root, filePath, body.stage !== false, all);
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/workspace/git/commit') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const output = await gitCommit(root, body.message);
    sendEvent('workspace_git_changed', { workspace: root });
    json(res, 200, { ok: true, output });
    return true;
  }

  // ── TTS Health & Proxy ────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/tts/health') {
    const ttsBase = searchParams.get('url') || 'http://localhost:7860';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const upstream = await fetch(`${ttsBase}/api/status`, { signal: controller.signal });
      clearTimeout(timer);
      if (!upstream.ok) {
        json(res, 200, { ok: false, online: false, status: upstream.status, error: `TTS server returned HTTP ${upstream.status}` });
      } else {
        const body = await upstream.json().catch(() => ({}));
        json(res, 200, { ok: true, online: true, status: upstream.status, loaded: body?.model_loaded ?? null, voice: body?.voices ?? null });
      }
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      json(res, 200, { ok: false, online: false, error: isTimeout ? 'TTS server timed out' : `TTS server unreachable: ${err.message}` });
    }
    return true;
  }

  return false;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  relative = relative.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== PUBLIC_DIR) return false;
  let stat = await fs.stat(target).catch(() => null);
  let file = target;
  if (!stat?.isFile()) {
    file = path.join(PUBLIC_DIR, 'index.html');
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) return false;
  const content = await fs.readFile(file);
  setSecurityHeaders(res);
  res.writeHead(200, {
    'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
    'content-length': content.length,
    'cache-control': 'no-cache, must-revalidate'
  });
  res.end(req.method === 'HEAD' ? undefined : content);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    setSecurityHeaders(res);
    let hostname = '';
    try { hostname = new URL(`http://${req.headers.host || ''}`).hostname; } catch { throw forbidden('Invalid Host header'); }
    if (!isLoopbackHost(hostname)) throw forbidden('Invalid Host header');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method || 'GET') && req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (!isLoopbackHost(origin.hostname) || origin.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
        throw forbidden('Cross-origin state-changing requests are not allowed');
      }
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) errorJson(res, 404, 'API route not found');
      return;
    }
    if (!await serveStatic(req, res, url.pathname)) errorJson(res, 404, 'Not found');
  } catch (error) {
    state.lastError = error.message;
    const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    sendEvent('server_error', { source: 'http', path: url.pathname, error: error.message });
    errorJson(res, status, error);
  }
});

const config = await readConfig();
server.listen(config.port, config.bindHost, () => {
  console.log(`Pi Ollama Studio listening on http://${config.bindHost}:${config.port}`);
  if (config.managedOllama) {
    getOllamaStatus()
      .then((status) => status.online ? null : managedOllama.start())
      .catch((error) => {
        state.lastError = error.message;
        sendEvent('server_error', { source: 'managed_ollama_autostart', error: error.message });
        console.error(`Managed Ollama auto-start failed: ${error.message}`);
      });
  }
});

async function shutdown(signal) {
  console.log(`\n${signal}: shutting down...`);
  // CR-05: Drain all open SSE connections so clients reconnect cleanly.
  for (const client of sseClients) { try { client.end(); } catch { /* ignore */ } }
  sseClients.clear();
  server.close();
  await pi.stop().catch(() => {});
  await managedOllama.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
