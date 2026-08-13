import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { PiRpcProcess } from './src/pi-rpc.mjs';
import { readConfig, writeConfig, serializeMutation } from './src/config.mjs';
import {
  createModelProfile,
  deleteModel,
  getOllamaStatus,
  loadProfiles,
  modelDiagnostics,
  pullModel,
  setModelReasoning,
  showModel,
  syncPiModels,
  unloadModel,
  isLocalOllamaBaseUrl,
  probeOllamaRuntime
} from './src/ollama.mjs';
import { cloneSession, createProjectFromNode, forkSession, inspectSession, listSessions, sanitizeProjectDirectoryName } from './src/sessions.mjs';
import { browseDirectory, createDirectory, createNewProject, getGitStatus, getSystemStatus, gitCommit, gitCreateSnapshot, gitCreateWorktree, gitRemoveWorktree, gitDiff, gitInitializeRepository, gitReadFileVersion, gitRestoreFile, gitStage, ManagedOllama, openNativeFolderPicker, searchWorkspace } from './src/system.mjs';
import { isLoopbackHost, studioLoopbackUrl } from './src/config.mjs';
import { getCheckpoint, listCheckpoints, recordCheckpoint } from './src/checkpoints.mjs';
import { LspManager, languageIdForPath } from './src/lsp.mjs';
import { TerminalManager } from './src/terminal.mjs';
import { discoverTests, runTests, discoverRunConfigurations } from './src/testing.mjs';
import { inspectPiPlatform, writeContextFile, writePiSettings, writePromptTemplate, writeSkill } from './src/pi-platform.mjs';
import { loadProviderProfiles, providerPublicView, syncProvidersToPi } from './src/providers.mjs';
import { createProviderRoutes } from './src/routes/provider-routes.mjs';
import { createTestingRoutes } from './src/routes/testing-routes.mjs';
import { createPiPlatformRoutes } from './src/routes/pi-platform-routes.mjs';
import { McpManager, ensureMcpPiBridge } from './src/mcp.mjs';
import { createMcpRoutes } from './src/routes/mcp-routes.mjs';
import { searchPiPackages, fetchPackageDetails, runPiPackageAction, configurePackageResources, inspectPackageSource } from './src/pi-packages.mjs';
import { createPackageRoutes } from './src/routes/package-routes.mjs';
import { PreviewManager, loadPreviewConfig, savePreviewConfig, suggestPreviewCommand } from './src/preview.mjs';
import { createPreviewRoutes } from './src/routes/preview-routes.mjs';
import { createOllamaRoutes } from './src/routes/ollama-routes.mjs';
import { createTtsRoutes } from './src/routes/tts-routes.mjs';
import { terminateProcessTree } from './src/process-tree.mjs';
import { composeHarnessSystemPrompt, listHarnesses, resolveHarness, saveHarness, deleteHarness } from './src/harnesses.mjs';
import { ensureOllamaRuntimeForPi } from './src/ollama-lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MONACO_DIR = path.join(__dirname, 'vendor', 'monaco');
const LSP_RUNTIME_DIR = path.join(__dirname, 'vendor', 'lsp-runtime');
const XTERM_DIR = path.join(__dirname, 'vendor', 'xterm');
const PACKAGE = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const TTS_EXTENSION_PATH = path.join(__dirname, 'extensions', 'pi-ollama-studio-tts.ts');
const BODY_LIMIT = 25 * 1024 * 1024;
const pi = new PiRpcProcess();
const managedOllama = new ManagedOllama();
const lsp = new LspManager({ runtimeDir: LSP_RUNTIME_DIR, clientVersion: PACKAGE.version });
const terminals = new TerminalManager();
const mcp = new McpManager();
const previews = new PreviewManager();
previews.on('changed', (preview) => sendEvent('preview_changed', { workspace: preview.workspace, action: 'state', preview }));
const sseClients = new Set();
const terminalSessions = new Map();
const desktopTerminalProcesses = new Map();
// NTFS can report the same mtimeMs for edits made inside one timestamp bucket.
// Keep the revision observed by the editor-read route so same-mtime external
// edits cannot silently bypass optimistic-save protection.
const workspaceFileRevisions = new Map();
const MAX_WORKSPACE_FILE_REVISIONS = 2048;
let piCommandsInFlight = 0;
const PI_COMMAND_CONCURRENCY_LIMIT = 8;
const PI_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const state = {
  piState: null,
  piStats: null,
  lastPiEvent: null,
  lastError: null,
  startedAt: new Date().toISOString()
};

function fileContentHash(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function rememberWorkspaceFileRevision(target, revision) {
  workspaceFileRevisions.set(target, revision);
  while (workspaceFileRevisions.size > MAX_WORKSPACE_FILE_REVISIONS) {
    const oldest = workspaceFileRevisions.keys().next().value;
    if (oldest === undefined) break;
    workspaceFileRevisions.delete(oldest);
  }
}

async function readWorkspaceFileRevision(target, stat = null) {
  const fileStat = stat || await fs.stat(target);
  const content = await fs.readFile(target, 'utf8');
  return { mtimeMs: fileStat.mtimeMs, size: fileStat.size, hash: fileContentHash(content) };
}

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
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; frame-ancestors 'none'");
}

function errorJson(res, status, error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { ok: false, error: message };
  if (error?.code) payload.code = error.code;
  if (error?.details !== undefined) payload.details = error.details;
  json(res, status, payload);
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

function safeDecode(value) { try { return decodeURIComponent(value); } catch { throw Object.assign(new Error('Malformed URL encoding'), { statusCode: 400 }); } }

function routeMatch(pathname, pattern) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = safeDecode(pathParts[i]);
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
  sendEvent('pi_event', { ...event, _studioWorkspace: pi.status().workspace || '' });
  if (['agent_settled', 'message_end', 'compaction_end', 'queue_update'].includes(event?.type)) {
    setTimeout(refreshPiSnapshot, 25).unref?.();
  }
});
pi.on('stderr', (text) => sendEvent('pi_stderr', { text, workspace: pi.status().workspace || '' }));
pi.on('protocol-error', (payload) => sendEvent('pi_protocol_error', payload));
pi.on('started', (payload) => sendEvent('pi_status', payload));
pi.on('exit', (payload) => {
  // A delayed exit from a replaced Pi child must not erase the replacement's
  // cached session/stats or broadcast a misleading stop transition.
  if (payload?.stale) return;
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
terminals.on('data', (payload) => sendEvent('terminal_data', { ...payload, workspace: terminals.get(payload.id)?.workspace || '' }));
terminals.on('exit', (payload) => sendEvent('terminal_exit', { ...payload, workspace: terminals.get(payload.id)?.workspace || '' }));
terminals.on('created', (payload) => sendEvent('terminal_created', payload));
terminals.on('removed', (payload) => sendEvent('terminal_removed', payload));
lsp.on('diagnostics', (payload) => sendEvent('lsp_diagnostics', payload));
lsp.on('status', (payload) => sendEvent('lsp_status', payload));
lsp.on('log', (payload) => sendEvent('lsp_log', payload));
lsp.on('protocol-error', (payload) => sendEvent('lsp_protocol_error', payload));
lsp.on('error', (payload) => sendEvent('server_error', { source: `lsp:${payload.serverId || 'unknown'}`, workspace: payload.workspace || '', error: payload.error?.message || String(payload.error || 'Language server error') }));
mcp.on('log', (payload) => sendEvent('mcp_log', payload));
mcp.on('status', (payload) => sendEvent('mcp_status', payload));
mcp.on('changed', (payload) => sendEvent('mcp_changed', payload));

async function bootstrap() {
  const config = await readConfig();
  const [system, ollama, profiles, piSnapshot, providers, mcpSnapshot, harnessSnapshot] = await Promise.all([
    getSystemStatus(),
    getOllamaStatus(),
    loadProfiles(),
    getPiSnapshot(),
    loadProviderProfiles(),
    mcp.snapshot(),
    listHarnesses({ workspace: config.defaultWorkspace })
  ]);
  return {
    ok: true,
    config,
    system,
    ollama,
    profiles: profiles.profiles,
    providers: providers.providers.map((item) => providerPublicView(item)),
    mcp: mcpSnapshot,
    pi: piSnapshot,
    managedOllama: managedOllama.status(),
    harnesses: harnessSnapshot.harnesses,
    harnessErrors: harnessSnapshot.errors,
    app: { version: PACKAGE.version, startedAt: state.startedAt }
  };
}

const handleProviderRoutes = createProviderRoutes({ readBody, json, sendEvent });
const handleTestingRoutes = createTestingRoutes({ readBody, json, sendEvent, resolveWorkspacePath, discoverTests, runTests, discoverRunConfigurations });
const handlePiPlatformRoutes = createPiPlatformRoutes({ readBody, json, sendEvent, resolveWorkspacePath, inspectPiPlatform, writePromptTemplate, writeSkill, writeContextFile, writePiSettings });
const handleMcpRoutes = createMcpRoutes({ manager: mcp, readBody, json, sendEvent });
const handlePackageRoutes = createPackageRoutes({ readBody, json, sendEvent, resolveWorkspacePath, searchPiPackages, fetchPackageDetails, runPiPackageAction, configurePackageResources, inspectPackageSource, inspectPiPlatform });
const handlePreviewRoutes = createPreviewRoutes({ manager: previews, readBody, json, sendEvent, resolveWorkspacePath, loadPreviewConfig, savePreviewConfig, suggestPreviewCommand });
const handleOllamaRoutes = createOllamaRoutes({ readBody, json, sendEvent, readConfig, getOllamaStatus, loadProfiles, probeOllamaRuntime, showModel, modelDiagnostics, createModelProfile, pullModel, syncPiModels, deleteModel, unloadModel, setModelReasoning, isLocalOllamaBaseUrl, managedOllama });
const handleTtsRoutes = createTtsRoutes({ readBody, json });

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (await handleProviderRoutes(req, res, url)) return true;
  if (await handleTestingRoutes(req, res, url)) return true;
  if (await handlePiPlatformRoutes(req, res, url)) return true;
  if (await handleMcpRoutes(req, res, url)) return true;
  if (await handlePackageRoutes(req, res, url)) return true;
  if (await handlePreviewRoutes(req, res, url)) return true;
  if (await handleOllamaRoutes(req, res, url)) return true;
  if (await handleTtsRoutes(req, res, url)) return true;

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

  if (req.method === 'GET' && pathname === '/api/harnesses') {
    const result = await listHarnesses({ workspace: searchParams.get('workspace') || '' });
    json(res, 200, { ok: true, ...result });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/harnesses') {
    const body = await readBody(req);
    const harness = await saveHarness({ workspace: body.workspace || '', scope: body.scope || 'global', harness: body.harness || body });
    const result = await listHarnesses({ workspace: body.workspace || '' });
    sendEvent('harnesses_changed', { workspace: body.workspace || '', harnessId: harness.id, scope: harness.scope, action: 'save' });
    json(res, 200, { ok: true, harness, ...result });
    return true;
  }
  if (req.method === 'DELETE' && pathname === '/api/harnesses') {
    const body = await readBody(req);
    const removed = await deleteHarness({ workspace: body.workspace || '', scope: body.scope || 'global', id: body.id || '' });
    const result = await listHarnesses({ workspace: body.workspace || '' });
    sendEvent('harnesses_changed', { workspace: body.workspace || '', harnessId: removed.id, scope: removed.scope, action: 'delete' });
    json(res, 200, { ok: true, removed, ...result });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/pi/start') {
    const body = await readBody(req);
    const harness = await resolveHarness(body.harnessId, { workspace: body.workspace || '' });
    const cfg = await readConfig();
    const ollamaReady = await ensureOllamaRuntimeForPi({
      modelId: body.modelId || cfg.defaultModel,
      provider: body.provider,
      baseUrl: cfg.ollamaBaseUrl,
      getStatus: getOllamaStatus,
      isLocalBaseUrl: isLocalOllamaBaseUrl,
      managedOllama
    });
    if (ollamaReady.started) sendEvent('ollama_managed_status', managedOllama.status());
    await syncPiModels().catch((error) => sendEvent('server_error', { source: 'model_sync', error: error.message }));
    await syncProvidersToPi().catch((error) => sendEvent('server_error', { source: 'provider_sync', error: error.message }));
    await ensureMcpPiBridge().catch((error) => sendEvent('server_error', { source: 'mcp_bridge', error: error.message }));
    const response = await pi.start({ ...body, harnessId: harness.id, tools: harness.tools, appendSystemPrompt: composeHarnessSystemPrompt(harness), extensions: [TTS_EXTENSION_PATH], mcpBridgeUrl: studioLoopbackUrl(cfg) });
    state.piState = response.data;
    await refreshPiSnapshot();
    json(res, 200, { ok: true, response, status: pi.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/pi/stop') {
    const body = await readBody(req).catch(() => ({}));
    const expectedWorkspace = String(body.workspace || '').trim();
    const result = await pi.stop({ expectedWorkspace });
    if (result.stopped) {
      state.piState = null;
      state.piStats = null;
    }
    json(res, 200, { ok: true, ...result, status: pi.status() });
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
      // Local 20B-70B models can legitimately need 10-15 minutes for a cold,
      // tool-heavy turn. Keep one explicit model selected and wait; never fall
      // back to a different model merely because it would respond sooner.
      const timeoutMs = PI_COMMAND_TIMEOUT_MS;
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
  if (req.method === 'POST' && pathname === '/api/sessions/fork') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    json(res, 200, await forkSession(body.workspace, body.sessionPath, body.targetNodeId, body.name));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/sessions/clone') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    json(res, 200, await cloneSession(body.workspace, body.sessionPath, body.name));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/sessions/create-project') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    let worktree = null;
    const checkpoint = body.targetNodeId ? await getCheckpoint(body.workspace, body.targetNodeId) : null;
    try {
      if (checkpoint?.commit && body.useCheckpoint !== false) {
        const cleanName = sanitizeProjectDirectoryName(body.name);
        const baseDir = body.parentDir ? path.resolve(body.parentDir) : path.dirname(path.resolve(body.workspace));
        const targetPath = path.join(baseDir, cleanName);
        const slug = cleanName.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^[-/.]+|[-/.]+$/g, '') || 'branch';
        const branchName = `pi/${slug}-${Date.now().toString(36)}`;
        worktree = await gitCreateWorktree(body.workspace, targetPath, checkpoint.commit, branchName);
      }
      const project = await createProjectFromNode(body.workspace, body.sessionPath, body.targetNodeId, body.name, body.parentDir, { copyWorkspace: !worktree });
      json(res, 200, { ...project, checkpoint: checkpoint || null, worktree });
    } catch (error) {
      if (worktree?.target) await gitRemoveWorktree(body.workspace, worktree.target, worktree.branch || '').catch((rollbackError) => sendEvent('server_error', { source: 'create_project_rollback', error: rollbackError.message }));
      throw error;
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/checkpoints') {
    const workspace = searchParams.get('workspace');
    json(res, 200, { ok: true, checkpoints: await listCheckpoints(workspace) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/checkpoints/associate') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    const checkpoint = await recordCheckpoint(body.workspace, body.nodeId, body.checkpoint || {});
    json(res, 200, { ok: true, checkpoint });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/workspace/select-folder') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    const result = await openNativeFolderPicker(body.current || '');
    json(res, 200, result);
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/browse') {
    json(res, 200, await browseDirectory(searchParams.get('path')));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/workspace/mkdir') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    json(res, 200, await createDirectory(body.parent, body.name));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/projects/create') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    json(res, 200, await createNewProject(body.parentDir, body.name, body.template || 'empty'));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/workspace/tree') {
    json(res, 200, { ok: true, tree: await workspaceTree(searchParams.get('workspace'), searchParams.get('path') || '.', searchParams.get('depth') || 2) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/terminal/capabilities') {
    json(res, 200, { ok: true, capabilities: await terminals.capabilities() });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/terminal/sessions') {
    const requestedTerminalWorkspace = String(searchParams.get('workspace') || '').trim();
    const terminalWorkspaceRoot = requestedTerminalWorkspace
      ? (await resolveWorkspacePath(requestedTerminalWorkspace, '.')).root
      : '';
    const canonicalTerminalWorkspace = async (value) => {
      if (!String(value || '').trim()) return '';
      const resolved = await fs.realpath(path.resolve(String(value))).catch(() => path.resolve(String(value)));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const terminalWorkspaceKey = terminalWorkspaceRoot ? await canonicalTerminalWorkspace(terminalWorkspaceRoot) : '';
    let list = terminals.list();
    if (terminalWorkspaceKey) {
      const filtered = [];
      for (const session of list) {
        if (await canonicalTerminalWorkspace(session.workspace) === terminalWorkspaceKey) filtered.push(session);
      }
      list = filtered;
    }
    const piStatus = pi.status();
    if (piStatus.running && (!terminalWorkspaceKey || await canonicalTerminalWorkspace(piStatus.workspace) === terminalWorkspaceKey)) {
      list.unshift({
        id: `pi-rpc-${piStatus.pid}`,
        pid: piStatus.pid,
        name: 'Pi RPC Engine Process',
        type: 'rpc',
        backend: 'rpc',
        workspace: piStatus.workspace,
        model: piStatus.modelId,
        sessionFile: state.piState?.sessionFile || null,
        startedAt: piStatus.startedAt,
        status: 'running'
      });
    }
    for (const [id, item] of terminalSessions) {
      const proc = desktopTerminalProcesses.get(id);
      const isAlive = Boolean(proc && proc.exitCode == null && proc.signalCode == null);
      if (isAlive && (!terminalWorkspaceKey || await canonicalTerminalWorkspace(item.workspace) === terminalWorkspaceKey)) list.push({ id, ...item, backend: 'desktop', status: 'running' });
      else { terminalSessions.delete(id); desktopTerminalProcesses.delete(id); }
    }
    json(res, 200, { ok: true, sessions: list });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/terminal/create') {
    const body = await readBody(req);
    const cfg = await readConfig();
    const { root } = await resolveWorkspacePath(body.workspace || cfg.defaultWorkspace || process.cwd(), '.');
    const session = await terminals.create({
      workspace: root,
      shell: body.shell || undefined,
      name: body.name || undefined,
      cols: body.cols,
      rows: body.rows
    });
    json(res, 200, { ok: true, session });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/terminal/input') {
    const body = await readBody(req);
    json(res, 200, { ok: true, session: terminals.write(body.id, body.data) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/terminal/resize') {
    const body = await readBody(req);
    json(res, 200, { ok: true, session: terminals.resize(body.id, body.cols, body.rows) });
    return true;
  }


  if (req.method === 'POST' && (pathname === '/api/terminal/launch' || pathname === '/api/workspace/terminal')) {
    const body = await readBody(req);
    const cfg = await readConfig();
    const targetDir = path.resolve(body?.workspace || cfg.defaultWorkspace || process.cwd());
    const stat = await fs.stat(targetDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Workspace does not exist: ${targetDir}`);

    const attachPi = Boolean(body?.attachPi);
    const model = attachPi ? String(body?.model || cfg.defaultModel || '').trim() : '';
    const sessionFile = attachPi ? String(body?.sessionFile || '').trim() : '';
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const terminalEnv = {
      ...process.env,
      PI_STUDIO_WORKSPACE: targetDir,
      PI_STUDIO_PI_COMMAND: String(cfg.piCommand || 'pi'),
      PI_STUDIO_MODEL: model.startsWith('ollama/') ? model.slice(7) : model,
      PI_STUDIO_SESSION_FILE: sessionFile
    };

    let childPid = null;
    if (process.platform === 'win32') {
      let args = ['-NoExit'];
      if (attachPi) {
        const psScript = [
          'Set-Location -LiteralPath $env:PI_STUDIO_WORKSPACE',
          'Write-Host "=== Pi Ollama Studio — Attached Session Terminal ===" -ForegroundColor Cyan',
          '$piArgs = @()',
          'if ($env:PI_STUDIO_MODEL) { $piArgs += @("--provider", "ollama", "--model", $env:PI_STUDIO_MODEL) }',
          'if ($env:PI_STUDIO_SESSION_FILE) { $piArgs += @("--session", $env:PI_STUDIO_SESSION_FILE) }',
          '& $env:PI_STUDIO_PI_COMMAND @piArgs'
        ].join('; ');
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        args = ['-NoExit', '-EncodedCommand', encoded];
      }
      const proc = spawn('powershell.exe', args, { cwd: targetDir, env: terminalEnv, detached: true, stdio: 'ignore' });
      childPid = proc.pid;
      desktopTerminalProcesses.set(id, proc);
      proc.once('exit', () => { if (desktopTerminalProcesses.get(id) === proc) { desktopTerminalProcesses.delete(id); terminalSessions.delete(id); } });
      proc.once('error', () => { if (desktopTerminalProcesses.get(id) === proc) { desktopTerminalProcesses.delete(id); terminalSessions.delete(id); } });
      proc.unref();
    } else {
      let args = ['--working-directory', targetDir];
      if (attachPi) {
        const shell = process.env.SHELL || '/bin/bash';
        const script = 'cd -- "$PI_STUDIO_WORKSPACE"; set --; if [ -n "$PI_STUDIO_MODEL" ]; then set -- "$@" --provider ollama --model "$PI_STUDIO_MODEL"; fi; if [ -n "$PI_STUDIO_SESSION_FILE" ]; then set -- "$@" --session "$PI_STUDIO_SESSION_FILE"; fi; exec "$PI_STUDIO_PI_COMMAND" "$@"';
        args = ['-e', shell, '-lc', script];
      }
      const proc = spawn('x-terminal-emulator', args, { cwd: targetDir, env: terminalEnv, detached: true, stdio: 'ignore' });
      childPid = proc.pid;
      desktopTerminalProcesses.set(id, proc);
      proc.once('exit', () => { if (desktopTerminalProcesses.get(id) === proc) { desktopTerminalProcesses.delete(id); terminalSessions.delete(id); } });
      proc.once('error', () => { if (desktopTerminalProcesses.get(id) === proc) { desktopTerminalProcesses.delete(id); terminalSessions.delete(id); } });
      proc.unref();
    }

    const sessionInfo = {
      id,
      pid: childPid,
      name: attachPi ? `Pi Terminal ${model ? `(${model.split(':')[0]})` : ''}` : 'Terminal',
      type: 'desktop',
      workspace: targetDir,
      model,
      sessionFile,
      attachPi,
      startedAt: new Date().toISOString()
    };
    terminalSessions.set(id, sessionInfo);

    json(res, 200, { ok: true, session: sessionInfo, workspace: targetDir });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/terminal/kill') {
    const body = await readBody(req);
    const id = String(body?.id || '');
    if (!id) throw Object.assign(new Error('Terminal session ID is required'), { statusCode: 400 });

    let killed = false;
    if (terminals.get(id)) {
      await terminals.kill(id);
      killed = true;
    } else if (terminalSessions.has(id)) {
      const proc = desktopTerminalProcesses.get(id);
      if (proc) await terminateProcessTree(proc).catch(() => {});
      desktopTerminalProcesses.delete(id);
      terminalSessions.delete(id);
      killed = true;
    }
    json(res, 200, { ok: true, killed });
    return true;
  }

  // ── Language Server Protocol ─────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/lsp/status') {
    const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
    json(res, 200, { ok: true, servers: await lsp.statusWithDefinitions(root) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/lsp/document') {
    const body = await readBody(req);
    const { root, relative } = await resolveWorkspacePath(body.workspace, body.path || '.');
    const action = ['open', 'change', 'save', 'close'].includes(body.action) ? body.action : 'open';
    const languageId = body.languageId || languageIdForPath(relative);
    const results = await lsp.syncDocument({ workspace: root, path: relative, languageId, text: body.text ?? '', version: body.version, action });
    json(res, 200, { ok: true, path: relative, languageId, results });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/lsp/request') {
    const body = await readBody(req);
    const { root, relative } = body.path ? await resolveWorkspacePath(body.workspace, body.path) : await resolveWorkspacePath(body.workspace, '.');
    const result = await lsp.request({ workspace: root, path: body.path ? relative : '', languageId: body.languageId || languageIdForPath(relative), method: body.method, params: body.params || {}, text: body.text, version: body.version, serverId: body.serverId || '' });
    json(res, 200, { ok: true, ...result });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/lsp/stop') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const servers = await lsp.stopWorkspace(root, body.serverId || '');
    json(res, 200, { ok: true, servers });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/lsp/restart') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const servers = await lsp.restart(root, body.serverId || '');
    json(res, 200, { ok: true, servers });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/workspace/search') {
    const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
    const query = searchParams.get('q') || '';
    const limit = Math.max(1, Math.min(500, Number(searchParams.get('limit') || 200)));
    json(res, 200, { ok: true, result: await searchWorkspace(root, query, { limit }) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/file') {
    const { target, relative } = await resolveWorkspacePath(searchParams.get('workspace'), searchParams.get('path'));
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Path is not a file');
    if (stat.size > 3 * 1024 * 1024) throw new Error('File is larger than the 3 MB editor limit');
    const content = await fs.readFile(target, 'utf8');
    rememberWorkspaceFileRevision(target, { mtimeMs: stat.mtimeMs, size: stat.size, hash: fileContentHash(content) });
    json(res, 200, { ok: true, file: { path: relative.split(path.sep).join('/'), content, size: stat.size, modifiedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs } });
    return true;
  }
  if (req.method === 'PUT' && pathname === '/api/workspace/file') {
    const body = await readBody(req);
    const { root, target, relative } = await resolveWorkspacePath(body.workspace, body.path, { allowMissing: true });
    const content = String(body.content ?? '');
    if (Buffer.byteLength(content) > 3 * 1024 * 1024) throw new Error('File is larger than the 3 MB editor limit');
    const file = await serializeMutation(target, async () => {
      // The optimistic mtime check and write must be one transaction. Without this
      // lock, two simultaneous saves can both validate the same mtime and silently
      // overwrite each other.
      const current = await fs.stat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      const hasExpectedMtime = body.expectedMtimeMs !== null && body.expectedMtimeMs !== undefined && body.expectedMtimeMs !== '';
      const expectedMtimeMs = hasExpectedMtime ? Number(body.expectedMtimeMs) : Number.NaN;
      let revisionConflict = false;
      if (!body.force && current?.isFile() && Number.isFinite(expectedMtimeMs)) {
        revisionConflict = Math.abs(current.mtimeMs - expectedMtimeMs) > 0.5;
        if (!revisionConflict) {
          const known = workspaceFileRevisions.get(target);
          if (known && Math.abs(known.mtimeMs - expectedMtimeMs) <= 0.5) {
            const currentRevision = await readWorkspaceFileRevision(target, current);
            revisionConflict = currentRevision.size !== known.size || currentRevision.hash !== known.hash;
          }
        }
      }
      if (revisionConflict) {
        throw Object.assign(new Error('File changed on disk since it was opened'), {
          statusCode: 409,
          code: 'FILE_CHANGED_ON_DISK',
          details: { path: relative.split(path.sep).join('/'), modifiedAt: current.mtime.toISOString(), mtimeMs: current.mtimeMs, size: current.size }
        });
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      const stat = await fs.stat(target);
      rememberWorkspaceFileRevision(target, { mtimeMs: stat.mtimeMs, size: stat.size, hash: fileContentHash(content) });
      return { path: relative.split(path.sep).join('/'), size: stat.size, modifiedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
    });
    sendEvent('workspace_file_changed', { workspace: root, path: file.path, source: 'editor', mtimeMs: file.mtimeMs });
    json(res, 200, { ok: true, file });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/git') {
    const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
    json(res, 200, { ok: true, git: await getGitStatus(root) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/workspace/git/init') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const result = await gitInitializeRepository(root, {
      initialBranch: body.initialBranch || 'main',
      createGitignore: body.createGitignore !== false,
      createBaseline: body.createBaseline !== false,
      confirmSensitive: body.confirmSensitive === true
    });
    sendEvent('workspace_git_changed', { workspace: root });
    json(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/workspace/git/diff') {
    // CR-01: Validate path with workspace containment before passing to gitDiff.
    const { root, relative } = await resolveWorkspacePath(searchParams.get('workspace'), searchParams.get('path') || '.');
    const staged = searchParams.get('staged') === '1';
    json(res, 200, { ok: true, diff: await gitDiff(root, relative, staged) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/workspace/git/file') {
    const { root, relative } = await resolveWorkspacePath(searchParams.get('workspace'), searchParams.get('path') || '.');
    const source = searchParams.get('source') || 'head';
    json(res, 200, { ok: true, file: { path: relative, ...(await gitReadFileVersion(root, relative, source)) } });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/workspace/git/restore') {
    const body = await readBody(req);
    const { root, relative } = await resolveWorkspacePath(body.workspace, body.path || '.');
    await gitRestoreFile(root, relative);
    sendEvent('workspace_file_changed', { workspace: root, path: relative.split(path.sep).join('/'), source: 'git-restore' });
    sendEvent('workspace_git_changed', { workspace: root });
    json(res, 200, { ok: true });
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

  if (req.method === 'POST' && pathname === '/api/workspace/git/checkpoint') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const checkpoint = await gitCreateSnapshot(root, body.label || 'Pi Studio checkpoint');
    json(res, 200, { ok: true, checkpoint: { ...checkpoint, createdAt: new Date().toISOString() } });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/workspace/git/worktree') {
    const body = await readBody(req);
    const { root } = await resolveWorkspacePath(body.workspace, '.');
    const worktree = await gitCreateWorktree(root, body.targetPath, body.ref, body.branchName || '');
    json(res, 200, { ok: true, worktree });
    return true;
  }



  return false;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  let root = PUBLIC_DIR;
  let requested = pathname;
  let fallbackToIndex = true;
  if (pathname.startsWith('/vendor/monaco/')) {
    root = MONACO_DIR;
    requested = pathname.slice('/vendor/monaco'.length);
    fallbackToIndex = false;
  } else if (pathname.startsWith('/vendor/xterm/')) {
    root = XTERM_DIR;
    requested = pathname.slice('/vendor/xterm'.length);
    fallbackToIndex = false;
  }
  let relative = safeDecode(requested === '/' ? '/index.html' : requested);
  relative = relative.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) return false;
  let stat = await fs.stat(target).catch(() => null);
  let file = target;
  if (!stat?.isFile() && fallbackToIndex) {
    file = path.join(PUBLIC_DIR, 'index.html');
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) return false;
  const content = await fs.readFile(file);
  setSecurityHeaders(res);
  res.writeHead(200, {
    'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
    'content-length': content.length,
    'cache-control': (pathname.startsWith('/vendor/monaco/') || pathname.startsWith('/vendor/xterm/')) ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate'
  });
  res.end(req.method === 'HEAD' ? undefined : content);
  return true;
}

const server = http.createServer(async (req, res) => {
  let url = null;
  try {
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch (cause) {
      throw Object.assign(new Error('Malformed request URL'), { statusCode: 400, code: 'BAD_REQUEST_URL', cause });
    }
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
      let origin; try { origin = new URL(req.headers.origin); } catch { throw forbidden('Invalid Origin header'); }
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
    sendEvent('server_error', { source: 'http', path: url?.pathname || String(req.url || ''), error: error.message });
    // A route may fail after beginning a streamed/binary response. Never try
    // to write a second set of headers: Node treats that as an uncaught server
    // error and can terminate Studio. The original response is already the
    // only valid response at this point; logs/SSE preserve the failure detail.
    if (!res.headersSent && !res.writableEnded) errorJson(res, status, error);
    else if (!res.writableEnded) res.end();
  }
});

const config = await readConfig();
server.listen(config.port, config.bindHost, () => {
  console.log(`Pi Ollama Studio listening on http://${config.bindHost}:${config.port}`);
  if (config.managedOllama && isLocalOllamaBaseUrl(config.ollamaBaseUrl)) {
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
  await lsp.stopAll().catch(() => {});
  await mcp.dispose().catch(() => {});
  await previews.dispose().catch(() => {});
  await terminals.dispose().catch(() => {});
  await Promise.allSettled([...desktopTerminalProcesses.values()].map((proc) => terminateProcessTree(proc)));
  desktopTerminalProcesses.clear();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
