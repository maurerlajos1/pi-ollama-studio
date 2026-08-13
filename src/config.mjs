import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const APP_VERSION = String(require('../package.json')?.version || '0.0.0');

// ── Directory Paths ────────────────────────────────────────────────────────────
// PI_OLLAMA_STUDIO_DIR overrides the app data dir (useful in tests/custom installs).
// PI_CODING_AGENT_DIR points to the Pi CLI's agent directory (usually ~/.pi/agent).
export const APP_DIR = process.env.PI_OLLAMA_STUDIO_DIR || path.join(os.homedir(), '.pi-ollama-studio');
export const CONFIG_PATH = path.join(APP_DIR, 'runtime.json');
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
export const PI_MODELS_PATH = path.join(PI_AGENT_DIR, 'models.json');

// ── Default Configuration ──────────────────────────────────────────────────────
// Used on first run (no runtime.json yet). Tuned for a single-user local dev
// setup on RTX 3090 (24 GB VRAM) with Qwen 3.6 27B Q4_K_M.
//
// Key decisions:
//  keepAlive '30m'  — prevents 30-60 s model reloads during coding sessions.
//  gpuOverheadBytes 1.5 GB — safer buffer for CUDA driver + Windows desktop GPU.
//  kvCacheType 'q8_0' — best quality/memory balance for long-context coding.
//  numParallel 1 — single user; more slots multiply KV-cache with no benefit.
//  maxLoadedModels 1 — 3090 holds only one large model (≥13B) at a time.
//  defaultContextLength 65536 — matches Qwen 3.6 27B rope limit.
export const DEFAULT_CONFIG = Object.freeze({
  // ── Network ─────────────────────────────────────────────────────────────────
  bindHost: process.env.STUDIO_BIND_HOST || '127.0.0.1',
  port: Number(process.env.STUDIO_PORT || 4173),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaApiKeyEnv: process.env.PI_STUDIO_OLLAMA_API_KEY_ENV || '',
  ollamaRuntimeKind: process.env.PI_STUDIO_OLLAMA_RUNTIME_KIND || 'local',
  ollamaRuntimeName: process.env.PI_STUDIO_OLLAMA_RUNTIME_NAME || 'Local Ollama',

  // ── Executables ─────────────────────────────────────────────────────────────
  piCommand: process.env.PI_COMMAND || 'pi',
  ollamaCommand: process.env.OLLAMA_COMMAND || 'ollama',

  // ── Managed Ollama ───────────────────────────────────────────────────────────
  managedOllama: false,

  // ── Memory & Performance (RTX 3090 optimized) ────────────────────────────────
  kvCacheType: 'q8_0',        // q8_0 = half the f16 VRAM cost, minimal quality loss
  flashAttention: true,        // reduces KV memory footprint; beneficial for 3090+
  defaultContextLength: 65536, // 64 K tokens — Qwen 3.6 27B rope limit
  numParallel: 1,              // single user — more slots waste KV cache
  maxLoadedModels: 1,          // 3090 fits only one large model at a time
  maxQueue: 64,
  keepAlive: '30m',            // 30 min idle hold — avoids reload penalty (was 10m)
  gpuOverheadBytes: 1610612736, // 1.5 GB — CUDA driver + Windows desktop GPU buffer

  // ── Safety & Session ─────────────────────────────────────────────────────────
  noCloud: true,
  defaultWorkspace: '',
  defaultModel: '',
  trustProjects: false,
  sessionStorage: 'workspace',

  // ── Default AGENTS.md template injected into new workspaces ─────────────────
  defaultAgentsMd: `# Workspace Agent Guidelines

## Code Quality & Execution
- Inspect existing codebase and relevant files before editing.
- Write clean, complete, fully working code without leaving unfinished stubs or placeholder comments.
- Run tests or verify syntax whenever editing project files.
- Keep tool calls targeted and concise.
`
});

// ── Host Validation ────────────────────────────────────────────────────────────
// Studio must only bind to localhost — it exposes a code-execution API and must
// never be accessible from other machines on the network.
export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function studioLoopbackUrl(config = DEFAULT_CONFIG) {
  const raw = String(config.bindHost || '127.0.0.1').trim().replace(/^\[|\]$/g, '');
  if (!isLoopbackHost(raw)) throw new Error('Studio URL requires a loopback bind host');
  const host = raw.includes(':') ? `[${raw}]` : raw;
  return `http://${host}:${Number(config.port || 4173)}`;
}

// Explicit process environment values are launch-time overrides. This keeps
// documented invocations such as `STUDIO_PORT=5000 npm start` authoritative
// even when runtime.json was written by an earlier Studio session.
export function runtimeEnvironmentOverrides(env = process.env) {
  const overrides = {};
  const assign = (key, envKey, transform = (value) => value) => {
    if (Object.prototype.hasOwnProperty.call(env, envKey) && String(env[envKey]).trim() !== '') {
      overrides[key] = transform(env[envKey]);
    }
  };
  assign('bindHost', 'STUDIO_BIND_HOST', (value) => String(value).trim());
  assign('port', 'STUDIO_PORT', Number);
  assign('ollamaBaseUrl', 'OLLAMA_BASE_URL', (value) => String(value).trim());
  assign('ollamaApiKeyEnv', 'PI_STUDIO_OLLAMA_API_KEY_ENV', (value) => String(value).trim());
  assign('ollamaRuntimeKind', 'PI_STUDIO_OLLAMA_RUNTIME_KIND', (value) => String(value).trim());
  assign('ollamaRuntimeName', 'PI_STUDIO_OLLAMA_RUNTIME_NAME', (value) => String(value).trim());
  assign('piCommand', 'PI_COMMAND', (value) => String(value));
  assign('ollamaCommand', 'OLLAMA_COMMAND', (value) => String(value));
  return overrides;
}

// ── Config Validation ──────────────────────────────────────────────────────────
// Merges `value` over DEFAULT_CONFIG, coerces types, and validates ranges.
// Throws descriptive Error messages — never returns invalid state.
export function validateConfig(value) {
  const cfg = { ...DEFAULT_CONFIG, ...(value || {}) };

  // URL format
  if (!/^https?:\/\//.test(cfg.ollamaBaseUrl)) throw new Error('ollamaBaseUrl must be an http(s) URL');
  cfg.ollamaBaseUrl = String(cfg.ollamaBaseUrl).replace(/\/+$/, '');
  cfg.ollamaApiKeyEnv = String(cfg.ollamaApiKeyEnv || '').trim();
  if (cfg.ollamaApiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.ollamaApiKeyEnv)) {
    throw new Error('ollamaApiKeyEnv must be an environment variable name');
  }
  cfg.ollamaRuntimeKind = String(cfg.ollamaRuntimeKind || 'local').trim().toLowerCase();
  if (!['local', 'lan', 'vpn', 'remote', 'https'].includes(cfg.ollamaRuntimeKind)) throw new Error('Invalid Ollama runtime kind');
  cfg.ollamaRuntimeName = String(cfg.ollamaRuntimeName || 'Ollama').trim().slice(0, 120) || 'Ollama';

  // KV cache type enum
  if (!['f16', 'q8_0', 'q4_0'].includes(cfg.kvCacheType)) throw new Error('Invalid KV cache type');

  // Numeric coercion (handles strings from JSON or HTML form inputs)
  for (const key of ['port', 'defaultContextLength', 'numParallel', 'maxLoadedModels', 'maxQueue', 'gpuOverheadBytes']) {
    if (!Number.isFinite(Number(cfg[key])) || Number(cfg[key]) < 0) throw new Error(`Invalid numeric setting: ${key}`);
    cfg[key] = Number(cfg[key]);
  }

  // Clamp to sane ranges
  cfg.port = Math.max(1, Math.min(65535, cfg.port));
  cfg.defaultContextLength = Math.max(2048, Math.min(1048576, cfg.defaultContextLength));
  cfg.numParallel = Math.max(1, Math.min(32, cfg.numParallel));
  cfg.maxLoadedModels = Math.max(1, Math.min(32, cfg.maxLoadedModels));
  cfg.maxQueue = Math.max(1, Math.min(65536, cfg.maxQueue));

  // Boolean coercion
  cfg.managedOllama = Boolean(cfg.managedOllama);
  cfg.flashAttention = Boolean(cfg.flashAttention);
  cfg.noCloud = Boolean(cfg.noCloud);
  cfg.trustProjects = Boolean(cfg.trustProjects);

  // Host must remain loopback-only
  cfg.bindHost = String(cfg.bindHost || '127.0.0.1');
  if (!isLoopbackHost(cfg.bindHost)) {
    throw new Error('Pi Ollama Studio is a local code-execution UI and may only bind to localhost/127.0.0.1/::1');
  }

  cfg.piCommand = String(cfg.piCommand || 'pi');
  cfg.ollamaCommand = String(cfg.ollamaCommand || 'ollama');

  // keepAlive duration format: "30m", "1h", "0", "-1", etc.
  cfg.keepAlive = String(cfg.keepAlive || '30m').trim();
  if (!/^-?\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h)?$/.test(cfg.keepAlive)) {
    throw new Error('keepAlive must be a duration such as 30m, 1h, 0, or -1');
  }

  return cfg;
}

// ── Config I/O ─────────────────────────────────────────────────────────────────
// readConfig: loads and validates runtime.json.
// Falls back to DEFAULT_CONFIG on first run (ENOENT) or corrupt file (SyntaxError).
export async function readConfig() {
  try {
    return validateConfig({
      ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')),
      ...runtimeEnvironmentOverrides()
    });
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return validateConfig({ ...DEFAULT_CONFIG, ...runtimeEnvironmentOverrides() });
  }
}

// writeConfig: merges update into current config, validates, then writes atomically.
export async function writeConfig(update) {
  return serializeMutation(CONFIG_PATH, async()=>{const current=validateConfig(await readJsonStrict(CONFIG_PATH, DEFAULT_CONFIG));const next=validateConfig({...current,...(update||{})});await fs.mkdir(APP_DIR,{recursive:true});await writeJsonAtomic(CONFIG_PATH,next);return next;});
}

// ── JSON Helpers ───────────────────────────────────────────────────────────────
const mutationQueues = new Map();

export function serializeMutation(key, task) {
  const lockKey = path.resolve(String(key || '.'));
  const prior = mutationQueues.get(lockKey) || Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  mutationQueues.set(lockKey, current);
  return current.finally(() => { if (mutationQueues.get(lockKey) === current) mutationQueues.delete(lockKey); });
}

// readJson: reads a JSON file, returning `fallback` on ENOENT or parse error.
// Use for tolerant startup/display reads only. Mutations must use readJsonStrict so a
// malformed but recoverable file is never silently replaced with fallback state.
export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

export async function readJsonStrict(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`JSON store is corrupt: ${file}`), {
        code: 'JSON_STORE_CORRUPT',
        statusCode: 409,
        cause: error,
        path: file
      });
    }
    throw error;
  }
}

// writeJsonAtomic: writes to a temp file then renames it — prevents partial writes
// from corrupting the config file if the process crashes mid-write.
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// ── Canonical Workspace Paths ─────────────────────────────────────────────────
// Use real filesystem identity for state keyed by workspace. This keeps session,
// checkpoint and runtime state stable when the same project is opened through a
// symlink/junction or a differently-cased Windows drive letter.
export function normalizeCanonicalPath(value) {
  let resolved = path.resolve(String(value || ''));
  if (process.platform === 'win32') resolved = resolved.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  return resolved;
}

export async function canonicalWorkspacePath(workspace, { allowMissing = false } = {}) {
  if (!workspace) throw new Error('Workspace is required');
  const lexical = normalizeCanonicalPath(workspace);
  try {
    return normalizeCanonicalPath(await fs.realpath(lexical));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return lexical;
    throw error;
  }
}

// ── Session Directory Helpers ──────────────────────────────────────────────────
// Sessions are stored at <workspace>/.pi/studio-sessions/*.jsonl
// All helpers below verify the real (symlink-resolved) path stays inside the
// workspace root to block path-traversal attacks via attacker-controlled symlinks.
export function workspaceSessionDir(workspace) {
  if (!workspace) throw new Error('Workspace is required');
  return path.join(path.resolve(workspace), '.pi', 'studio-sessions');
}

function sessionPathError(message, statusCode = 403) {
  return Object.assign(new Error(message), { statusCode });
}

async function ensureRealDirectory(target, rootReal, { create }) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) throw error;
    await fs.mkdir(target);
    stat = await fs.lstat(target);
  }
  if (stat.isSymbolicLink()) throw sessionPathError('Workspace session storage may not be a symbolic link');
  if (!stat.isDirectory()) throw sessionPathError('Workspace session storage path is not a directory', 400);
  const real = await fs.realpath(target);
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw sessionPathError('Workspace session storage resolves outside the selected workspace');
  }
  return real;
}

/** Resolve Pi Studio's workspace-local session directory without following
 * attacker-controlled .pi or studio-sessions symlinks outside the workspace. */
export async function resolveWorkspaceSessionDir(workspace, { create = true } = {}) {
  if (!workspace) throw new Error('Workspace is required');
  const root = path.resolve(String(workspace));
  const rootReal = await fs.realpath(root).catch((error) => {
    if (error?.code === 'ENOENT') throw sessionPathError('Workspace does not exist', 404);
    throw error;
  });
  const rootStat = await fs.stat(rootReal);
  if (!rootStat.isDirectory()) throw sessionPathError('Workspace is not a directory', 400);
  const piDir = await ensureRealDirectory(path.join(rootReal, '.pi'), rootReal, { create });
  return ensureRealDirectory(path.join(piDir, 'studio-sessions'), rootReal, { create });
}
