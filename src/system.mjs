import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { prepareSpawn } from './spawn-command.mjs';
import { terminateProcessTree } from './process-tree.mjs';

let versionCache = null;

async function resolveRealPathThroughNearestExisting(targetPath) {
  const absolute = path.resolve(String(targetPath));
  let current = absolute;
  const missing = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.resolve(real, ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pathWithin(parentPath, childPath) {
  const parent = process.platform === 'win32' ? path.resolve(parentPath).toLowerCase() : path.resolve(parentPath);
  const child = process.platform === 'win32' ? path.resolve(childPath).toLowerCase() : path.resolve(childPath);
  const relative = path.relative(parent, child);
  return child === parent || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function runCommand(command, args = [], { cwd, env, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  let finalArgs = args;
  if (command === 'git' && !args.some((a) => String(a).includes('safe.directory'))) finalArgs = ['-c', 'safe.directory=*', ...args];
  const mergedEnv = { ...process.env, ...(env || {}) };
  const prepared = prepareSpawn(command, finalArgs, { cwd, env: mergedEnv });
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      cwd,
      env: mergedEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...prepared.options
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timingOut = false;
    const add = (target, chunk) => {
      let value = target + String(chunk);
      if (Buffer.byteLength(value) > maxBytes) { value = value.slice(-maxBytes); truncated = true; }
      return value;
    };
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    child.stdout.on('data', (chunk) => { stdout = add(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = add(stderr, chunk); });
    const timer = setTimeout(async () => {
      timingOut = true;
      await terminateProcessTree(child).catch(() => {});
      finish(reject, new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('error', (error) => { if (!timingOut) finish(reject, error); });
    child.on('exit', (code, signal) => { if (!timingOut) finish(resolve, { code, signal, stdout, stderr, truncated }); });
  });
}

export async function commandVersion(command, args = ['--version']) {
  try {
    const result = await runCommand(command, args, { timeoutMs: 5000, maxBytes: 65536 });
    return { installed: true, version: (result.stdout || result.stderr).trim(), code: result.code };
  } catch (error) {
    return { installed: false, version: null, error: error.message };
  }
}


const RECOMMENDED_GITIGNORE = `# Pi Ollama Studio recommended ignores
node_modules/
dist/
build/
coverage/
.cache/
.tmp/
*.log

# Local environment / secrets
.env
.env.*
!.env.example
!.env.sample

# Pi Studio workspace-local session data
.pi/studio-sessions/

# OS metadata
.DS_Store
Thumbs.db
`;

const SENSITIVE_GIT_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:^|\/)id_rsa(?:\.pub)?$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:\.[^/]+)?$/i
];

function isLikelySensitiveGitPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (/\.env\.(?:example|sample)$/i.test(normalized)) return false;
  return SENSITIVE_GIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function gitHeadExists(workspace) {
  const head = await runCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace, timeoutMs: 8000 }).catch(() => ({ code: -1 }));
  return head.code === 0;
}

export async function gitInitializeRepository(workspace, {
  initialBranch = 'main',
  createGitignore = true,
  createBaseline = true,
  confirmSensitive = false
} = {}) {
  if (!String(workspace || '').trim()) throw new Error('Workspace is required');
  const root = path.resolve(String(workspace));
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Workspace directory does not exist');

  const gitVersion = await commandVersion('git');
  if (!gitVersion.installed) {
    const error = new Error('Git is not installed or is not available in PATH');
    error.statusCode = 409;
    error.code = 'GIT_NOT_INSTALLED';
    throw error;
  }

  const safeBranch = sanitizeGitBranchName(initialBranch || 'main');
  const repoProbe = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: '', stderr: '' }));
  let initializedNow = false;
  if (repoProbe.code !== 0 || repoProbe.stdout.trim() !== 'true') {
    let init = await runCommand('git', ['init', '-b', safeBranch], { cwd: root, timeoutMs: 15000 });
    if (init.code !== 0) {
      init = await runCommand('git', ['init'], { cwd: root, timeoutMs: 15000 });
      if (init.code !== 0) throw new Error(init.stderr || init.stdout || 'git init failed');
      await runCommand('git', ['symbolic-ref', 'HEAD', `refs/heads/${safeBranch}`], { cwd: root, timeoutMs: 8000 }).catch(() => null);
    }
    initializedNow = true;
  }

  let gitignoreCreated = false;
  const gitignorePath = path.join(root, '.gitignore');
  if (createGitignore) {
    const existing = await fs.stat(gitignorePath).catch(() => null);
    if (!existing) {
      await fs.writeFile(gitignorePath, RECOMMENDED_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
      gitignoreCreated = true;
    }
  }
  if (gitignoreCreated) {
    await runCommand('git', ['add', '.gitignore'], { cwd: root, timeoutMs: 15000 }).catch(() => {});
  }

  let baselineCreated = false;
  let baselineCommit = null;
  let sensitiveFiles = [];
  const hasHead = await gitHeadExists(root);

  if (createBaseline && !hasHead) {
    const untracked = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
    if (untracked.code !== 0) throw new Error(untracked.stderr || 'Failed to inspect untracked files before baseline');
    sensitiveFiles = untracked.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).filter(isLikelySensitiveGitPath);
    if (sensitiveFiles.length && !confirmSensitive) {
      return {
        ok: true,
        initialized: true,
        initializedNow,
        gitignoreCreated,
        baselineCreated: false,
        baselineCommit: null,
        requiresSensitiveConfirmation: true,
        sensitiveFiles,
        git: await getGitStatus(root),
        gitVersion: gitVersion.version
      };
    }

    const add = await runCommand('git', ['add', '-A', '--', '.'], { cwd: root, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 });
    if (add.code !== 0) throw new Error(add.stderr || add.stdout || 'Failed to stage project baseline');

    const authorEnv = {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Pi Ollama Studio',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'pi-studio@local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'Pi Ollama Studio',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'pi-studio@local'
    };
    const commit = await runCommand('git', ['-c', 'user.name=Pi Ollama Studio', '-c', 'user.email=pi-studio@local', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Initial project baseline'], {
      cwd: root, env: authorEnv, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024
    });
    if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout || 'Failed to create project baseline');
    const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 8000 });
    baselineCommit = head.code === 0 ? head.stdout.trim() : null;
    baselineCreated = true;
  }

  return {
    ok: true,
    initialized: true,
    initializedNow,
    gitignoreCreated,
    baselineCreated,
    baselineCommit,
    requiresSensitiveConfirmation: false,
    sensitiveFiles,
    git: await getGitStatus(root),
    gitVersion: gitVersion.version
  };
}

let gpuCache = null;

export async function getGpuInfo() {
  if (gpuCache && Date.now() - gpuCache.at < 2000) return gpuCache.data;
  try {
    const result = await runCommand('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,driver_version',
      '--format=csv,noheader,nounits'
    ], { timeoutMs: 5000, maxBytes: 262144 });
    if (result.code !== 0) throw new Error(result.stderr || 'nvidia-smi failed');
    const gpus = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [index, name, total, used, free, utilization, temperature, driver] = line.split(',').map((item) => item.trim());
      return {
        index: Number(index), name, memoryTotalMiB: Number(total), memoryUsedMiB: Number(used),
        memoryFreeMiB: Number(free), utilizationPercent: Number(utilization), temperatureC: Number(temperature), driver
      };
    });
    const data = { available: true, gpus };
    gpuCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    const data = { available: false, gpus: [], error: error.message };
    gpuCache = { at: Date.now(), data };
    return data;
  }
}

export async function getSystemStatus() {
  const cfg = await readConfig();
  const cacheKey = `${cfg.piCommand}\n${cfg.ollamaCommand}`;
  if (!versionCache || versionCache.key !== cacheKey || Date.now() - versionCache.at > 60000) {
    const [pi, ollama, git] = await Promise.all([commandVersion(cfg.piCommand), commandVersion(cfg.ollamaCommand), commandVersion('git')]);
    versionCache = { key: cacheKey, at: Date.now(), pi, ollama, git };
  }
  const gpu = await getGpuInfo();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: os.uptime(),
    cpus: os.cpus().length,
    pi: versionCache.pi,
    ollama: versionCache.ollama,
    git: versionCache.git,
    gpu
  };
}

async function gitWorkspaceContext(workspace) {
  const workspaceRoot = await fs.realpath(path.resolve(workspace)).catch(() => path.resolve(workspace));
  const rootResult = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, timeoutMs: 8000 });
  if (rootResult.code !== 0) throw new Error(rootResult.stderr || 'Workspace is not a Git repository');
  const root = await fs.realpath(path.resolve(rootResult.stdout.trim())).catch(() => path.resolve(rootResult.stdout.trim()));
  if (!pathWithin(root, workspaceRoot)) throw new Error('Workspace is outside the resolved Git repository');
  const prefix = path.relative(root, workspaceRoot).split(path.sep).join('/');
  return { root, workspace: workspaceRoot, prefix };
}

function workspaceRelativeGitPath(filePath, prefix = '') {
  const value = String(filePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const base = String(prefix || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!base) return value;
  if (value === base) return '';
  return value.startsWith(`${base}/`) ? value.slice(base.length + 1) : null;
}

export async function getGitStatus(workspace) {
  const gitContext = await gitWorkspaceContext(workspace).catch(() => null);
  const cwd = gitContext?.workspace || workspace;
  const [status, fileStatus, diffStat, branch] = await Promise.all([
    runCommand('git', ['status', '--porcelain=v1', '-b', '-u', '--', '.'], { cwd, timeoutMs: 8000 }).catch((error) => ({ code: -1, stderr: error.message, stdout: '' })),
    runCommand('git', ['status', '--porcelain=v1', '-z', '-uall', '--', '.'], { cwd, timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: '' })),
    runCommand('git', ['diff', '--stat', '--', '.'], { cwd, timeoutMs: 8000 }).catch(() => ({ stdout: '' })),
    runCommand('git', ['branch', '--show-current'], { cwd: workspace, timeoutMs: 8000 }).catch(() => ({ stdout: '' }))
  ]);
  // Parse porcelain: first line starting with ## is branch info, rest are file entries
  const lines = status.stdout.split('\n');
  const branchLine = lines.find((l) => l.startsWith('##')) || '';
  const aheadMatch = branchLine.match(/\[ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  const branchFromStatus = branchLine
    .replace(/^##\s*/, '')
    .replace(/^No commits yet on\s+/, '')
    .split('...')[0]
    .split(/\s+/)[0];
  const fileRecords = [];
  if (fileStatus.code === 0 && fileStatus.stdout) {
    const fields = fileStatus.stdout.split('\0');
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      if (!field || field.length < 3) continue;
      const xy = field.slice(0, 2);
      const file = workspaceRelativeGitPath(field.slice(3), gitContext?.prefix || '');
      let originalPath = null;
      if (xy.includes('R') || xy.includes('C')) originalPath = workspaceRelativeGitPath(fields[++i] || '', gitContext?.prefix || '');
      if (file === null || file === '') continue;
      fileRecords.push({
        xy,
        file,
        originalPath,
        staged: xy[0] !== ' ' && xy[0] !== '?',
        unstaged: xy[1] !== ' '
      });
    }
  }
  const porcelainLines = fileRecords.map((entry) => `${entry.xy} ${entry.originalPath ? `${entry.originalPath} -> ${entry.file}` : entry.file}`).join('\n');
  const scopedStatus = [branchLine, porcelainLines].filter(Boolean).join('\n');
  return {
    isRepository: status.code === 0,
    repositoryRoot: gitContext?.root || null,
    workspacePrefix: gitContext?.prefix || '',
    branch: branch.stdout.trim() || branchFromStatus,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    status: scopedStatus,
    porcelain: porcelainLines,
    files: fileRecords,
    error: status.code === 0 ? null : status.stderr,
    diffStat: diffStat.stdout
  };
}

export async function gitDiff(workspace, filePath, staged = false) {
  const args = staged
    ? ['diff', '--cached', '--', filePath]
    : ['diff', '--', filePath];
  const result = await runCommand('git', args, { cwd: workspace, timeoutMs: 15000, maxBytes: 1024 * 1024 });
  if (result.code !== 0 && !result.stdout) throw new Error(result.stderr || 'git diff failed');
  return result.stdout || '(no diff output)';
}

export async function gitStage(workspace, filePath, stage = true, all = false) {
  let args;
  if (all) {
    args = stage ? ['add', '-A', '--', '.'] : ['reset', 'HEAD', '--', '.'];
  } else {
    args = stage ? ['add', '--', filePath] : ['reset', 'HEAD', '--', filePath];
  }
  const result = await runCommand('git', args, { cwd: workspace, timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(result.stderr || 'git stage operation failed');
  return true;
}



function sanitizeGitBranchName(value) {
  const clean = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '');
  if (!clean || clean.includes('..') || clean.endsWith('.lock')) {
    throw new Error('Invalid Git branch name');
  }
  return clean.slice(0, 120);
}

export async function gitCreateSnapshot(workspace, label = 'Pi Studio checkpoint') {
  const { root, prefix } = await gitWorkspaceContext(workspace);
  const workspacePathspec = prefix || '.';
  const headResult = await runCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeoutMs: 8000 });
  const parent = headResult.code === 0 ? headResult.stdout.trim() : '';
  const tempIndex = path.join(os.tmpdir(), `pi-studio-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`);
  const env = { GIT_INDEX_FILE: tempIndex };

  try {
    const readTree = parent
      ? await runCommand('git', ['read-tree', parent], { cwd: root, env, timeoutMs: 10000 })
      : await runCommand('git', ['read-tree', '--empty'], { cwd: root, env, timeoutMs: 10000 });
    if (readTree.code !== 0) throw new Error(readTree.stderr || 'Failed to prepare checkpoint index');

    // The repository ignore rules already exclude .pi/studio-sessions. Do not
    // pass that ignored directory as an explicit pathspec: Git returns exit
    // code 1 for the directory even though it is intentionally not staged.
    const add = await runCommand('git', ['add', '-A', '--', workspacePathspec], { cwd: root, env, timeoutMs: 30000, maxBytes: 1024 * 1024 });
    if (add.code !== 0) throw new Error(add.stderr || 'Failed to capture workspace files');

    const tree = await runCommand('git', ['write-tree'], { cwd: root, env, timeoutMs: 10000 });
    if (tree.code !== 0) throw new Error(tree.stderr || 'Failed to write checkpoint tree');
    const treeHash = tree.stdout.trim();

    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Pi Ollama Studio',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'pi-studio@local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'Pi Ollama Studio',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'pi-studio@local'
    };
    const args = ['commit-tree', treeHash, '-m', String(label || 'Pi Studio checkpoint').slice(0, 240)];
    if (parent) args.splice(2, 0, '-p', parent);
    const commit = await runCommand('git', args, { cwd: root, env: commitEnv, timeoutMs: 10000 });
    if (commit.code !== 0) throw new Error(commit.stderr || 'Failed to create checkpoint commit');
    const commitHash = commit.stdout.trim();
    // Keep snapshots reachable so normal `git gc` cannot prune prompt history.
    const refName = `refs/pi-studio/checkpoints/${Date.now()}-${commitHash.slice(0, 12)}`;
    const keep = await runCommand('git', ['update-ref', refName, commitHash], { cwd: root, timeoutMs: 10000 });
    if (keep.code !== 0) throw new Error(keep.stderr || 'Failed to persist checkpoint ref');
    return { ok: true, root, commit: commitHash, ref: refName, parent: parent || null, tree: treeHash };
  } finally {
    await fs.rm(tempIndex, { force: true }).catch(() => {});
  }
}

export async function gitCreateWorktree(workspace, targetPath, ref, branchName = '') {
  if (!targetPath) throw new Error('Target worktree path is required');
  if (!ref) throw new Error('Git ref/checkpoint is required');
  const rootResult = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, timeoutMs: 8000 });
  if (rootResult.code !== 0) throw new Error(rootResult.stderr || 'Workspace is not a Git repository');
  const root = rootResult.stdout.trim();
  const target = path.resolve(String(targetPath));
  const rootResolved = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
  const targetResolved = await resolveRealPathThroughNearestExisting(target);
  if (pathWithin(rootResolved, targetResolved)) {
    throw new Error('Worktree target must be outside the current repository working tree');
  }
  try {
    await fs.access(target);
    throw new Error('Worktree target already exists');
  } catch (error) {
    if (error?.message === 'Worktree target already exists') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const args = ['worktree', 'add'];
  if (branchName) args.push('-b', sanitizeGitBranchName(branchName));
  else args.push('--detach');
  args.push(target, String(ref));
  const result = await runCommand('git', args, { cwd: root, timeoutMs: 30000, maxBytes: 1024 * 1024 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Failed to create Git worktree');
  return { ok: true, root, target, ref: String(ref), branch: branchName ? sanitizeGitBranchName(branchName) : null, output: result.stdout || result.stderr };
}

export async function gitRemoveWorktree(workspace, targetPath, branchName = '') {
  if (!targetPath) throw new Error('Target worktree path is required');
  const rootResult = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, timeoutMs: 8000 });
  if (rootResult.code !== 0) throw new Error(rootResult.stderr || 'Workspace is not a Git repository');
  const root = rootResult.stdout.trim();
  const target = path.resolve(String(targetPath));
  const removeResult = await runCommand('git', ['worktree', 'remove', '--force', target], { cwd: root, timeoutMs: 30000, maxBytes: 1024 * 1024 });
  if (removeResult.code !== 0) throw new Error(removeResult.stderr || removeResult.stdout || 'Failed to remove Git worktree');
  if (branchName) {
    const branch = sanitizeGitBranchName(branchName);
    const branchResult = await runCommand('git', ['branch', '-D', branch], { cwd: root, timeoutMs: 10000, maxBytes: 512 * 1024 });
    if (branchResult.code !== 0 && !/not found|not exist|unknown branch/i.test(branchResult.stderr || branchResult.stdout || '')) {
      throw new Error(branchResult.stderr || branchResult.stdout || 'Failed to remove rollback branch');
    }
  }
  return { ok: true, root, target, branch: branchName ? sanitizeGitBranchName(branchName) : null };
}

export async function gitCommit(workspace, message) {
  if (!message || !message.trim()) throw new Error('Commit message is required');
  const gitContext = await gitWorkspaceContext(workspace);
  if (gitContext.prefix) {
    const staged = await runCommand('git', ['diff', '--cached', '--name-only', '-z'], { cwd: gitContext.root, timeoutMs: 10000 });
    if (staged.code !== 0) throw new Error(staged.stderr || 'Failed to inspect staged Git changes');
    const outside = staged.stdout.split('\0').filter(Boolean).filter((file) => workspaceRelativeGitPath(file, gitContext.prefix) === null);
    if (outside.length) throw new Error(`Cannot commit while changes outside the selected workspace are staged: ${outside.slice(0, 3).join(', ')}`);
  }
  const result = await runCommand('git', ['commit', '-m', message.trim()], { cwd: workspace, timeoutMs: 15000 });
  if (result.code !== 0) {
    const err = result.stderr || result.stdout || 'git commit failed';
    if (err.includes('user.email') || err.includes('user.name')) {
      throw new Error('Git author identity unknown. Please set git user.name and user.email in your terminal.');
    }
    throw new Error(err);
  }
  return result.stdout;
}

export function managedOllamaEnvironment(cfg, baseEnv = process.env) {
  let managedHost = '127.0.0.1:11434';
  try {
    const runtimeUrl = new URL(cfg?.ollamaBaseUrl || 'http://127.0.0.1:11434');
    const rawHost = runtimeUrl.hostname.replace(/^\[|\]$/g, '');
    const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost;
    managedHost = `${host}:${runtimeUrl.port || (runtimeUrl.protocol === 'https:' ? '443' : '11434')}`;
  } catch { /* config validation normally prevents invalid URLs */ }
  return {
    ...baseEnv,
    ...(baseEnv.OLLAMA_MODELS ? { OLLAMA_MODELS: baseEnv.OLLAMA_MODELS } : {}),
    OLLAMA_HOST: managedHost,
    OLLAMA_FLASH_ATTENTION: cfg?.flashAttention ? '1' : '0',
    OLLAMA_KV_CACHE_TYPE: cfg?.kvCacheType,
    OLLAMA_CONTEXT_LENGTH: String(cfg?.defaultContextLength),
    OLLAMA_NUM_PARALLEL: String(cfg?.numParallel),
    OLLAMA_MAX_LOADED_MODELS: String(cfg?.maxLoadedModels),
    OLLAMA_MAX_QUEUE: String(cfg?.maxQueue),
    OLLAMA_KEEP_ALIVE: cfg?.keepAlive,
    OLLAMA_NO_CLOUD: cfg?.noCloud ? '1' : '0'
  };
}

export class ManagedOllama extends EventEmitter {
  #child = null;
  #logs = [];
  #lifecycle = Promise.resolve();

  get running() { return Boolean(this.#child && this.#child.exitCode === null); }

  status() {
    return { running: this.running, pid: this.#child?.pid || null, logs: this.#logs.slice(-200) };
  }

  #log(stream, chunk) {
    const record = { at: new Date().toISOString(), stream, text: String(chunk) };
    this.#logs.push(record);
    if (this.#logs.length > 1000) this.#logs.splice(0, this.#logs.length - 1000);
    this.emit('log', record);
  }

  #enqueueLifecycle(task) {
    const run = this.#lifecycle.catch(() => {}).then(task);
    this.#lifecycle = run.catch(() => {});
    return run;
  }

  async #startUnlocked() {
    if (this.running) return this.status();
    const cfg = await readConfig();
    const env = managedOllamaEnvironment(cfg);
    const prepared = prepareSpawn(cfg.ollamaCommand, ['serve'], { env });
    const child = spawn(prepared.command, prepared.args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...prepared.options
    });
    this.#child = child;
    child.stdout.on('data', (chunk) => this.#log('stdout', chunk));
    child.stderr.on('data', (chunk) => this.#log('stderr', chunk));
    child.on('error', (error) => {
      if (this.#child === child) this.#child = null;
      this.#log('error', error.message);
      this.emit('error', error);
    });
    child.on('exit', (code, signal) => {
      const expected = this.#child !== child;
      if (this.#child === child) this.#child = null;
      if (!expected) void terminateProcessTree(child, { graceMs: 600 }).catch(() => {});
      this.#log('exit', `Ollama exited: code=${code}, signal=${signal}`);
      this.emit('exit', { code, signal, expected });
    });
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 500)),
      new Promise((_, reject) => child.once('error', reject)),
      new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`Ollama exited during startup with code ${code}`))))
    ]);
    return this.status();
  }

  async #stopUnlocked() {
    const child = this.#child;
    if (!child) return this.status();
    this.#child = null;
    await terminateProcessTree(child, { graceMs: 1200 }).catch(() => {});
    return this.status();
  }

  start() {
    return this.#enqueueLifecycle(() => this.#startUnlocked());
  }

  stop() {
    return this.#enqueueLifecycle(() => this.#stopUnlocked());
  }

  restart() {
    return this.#enqueueLifecycle(async () => {
      await this.#stopUnlocked();
      return this.#startUnlocked();
    });
  }
}

export async function openNativeFolderPicker(initialPath = '') {
  const platform = os.platform();

  if (platform === 'win32') {
    const psScript = `
      try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select Workspace Folder for Pi Ollama Studio"
        $dialog.ShowNewFolderButton = $true
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          [Console]::WriteLine($dialog.SelectedPath)
        }
      } catch {
        $shell = New-Object -ComObject Shell.Application
        $folder = $shell.BrowseForFolder(0, "Select Workspace Folder for Pi Ollama Studio", 0, 0)
        if ($folder) {
          [Console]::WriteLine($folder.Self.Path)
        }
      }
    `.trim();

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        resolve({ ok: false, error: 'Folder selection timed out' });
      }, 120000);

      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      child.on('exit', () => {
        clearTimeout(timer);
        const selected = stdout.trim();
        resolve({ ok: true, path: selected || null, canceled: !selected });
      });
    });
  } else if (platform === 'linux') {
    // 1. Try zenity
    try {
      const res = await runCommand('zenity', ['--file-selection', '--directory', '--title=Select Workspace Folder for Pi Ollama Studio'], { timeoutMs: 120000 });
      const selected = (res.stdout || '').trim();
      if (res.code === 0 && selected) return { ok: true, path: selected, canceled: false };
    } catch { /* try next */ }

    // 2. Try kdialog
    try {
      const res = await runCommand('kdialog', ['--getexistingdirectory', '--title=Select Workspace Folder for Pi Ollama Studio'], { timeoutMs: 120000 });
      const selected = (res.stdout || '').trim();
      if (res.code === 0 && selected) return { ok: true, path: selected, canceled: false };
    } catch { /* try next */ }

    // 3. Try python3 tkinter
    try {
      const pyScript = `import tkinter, tkinter.filedialog; root = tkinter.Tk(); root.withdraw(); p = tkinter.filedialog.askdirectory(title="Select Workspace Folder"); print(p)`;
      const res = await runCommand('python3', ['-c', pyScript], { timeoutMs: 120000 });
      const selected = (res.stdout || '').trim();
      if (res.code === 0 && selected) return { ok: true, path: selected, canceled: false };
    } catch { /* failed */ }

    return { ok: false, error: 'No native folder picker (zenity, kdialog, or python3 tkinter) installed on Linux.' };
  } else if (platform === 'darwin') {
    try {
      const res = await runCommand('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select Workspace Folder for Pi Ollama Studio")'], { timeoutMs: 120000 });
      const selected = (res.stdout || '').trim();
      return { ok: true, path: selected || null, canceled: !selected };
    } catch (error) {
      return { ok: true, path: null, canceled: true };
    }
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

export async function browseDirectory(targetPath) {
  const resolved = targetPath ? path.resolve(targetPath) : os.homedir();
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const folders = [];
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        folders.push({ name: entry.name, path: path.join(resolved, entry.name) });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
    const drives = [];
    if (process.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        try {
          const drivePath = `${letter}:\\`;
          await fs.access(drivePath);
          drives.push({ name: `${letter}:`, path: drivePath });
        } catch { /* ignore non-existent drive */ }
      }
    } else {
      drives.push({ name: 'Root (/)', path: '/' }, { name: 'Home', path: os.homedir() });
    }

    return {
      ok: true,
      current: resolved,
      parent,
      drives,
      folders
    };
  } catch (error) {
    return { ok: false, error: error.message, current: resolved, parent: null, drives: [], folders: [] };
  }
}

export async function createDirectory(parentPath, folderName) {
  if (!folderName || typeof folderName !== 'string' || !folderName.trim()) {
    return { ok: false, error: 'Folder name cannot be empty' };
  }
  const cleanName = folderName.trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!cleanName || cleanName === '.' || cleanName === '..') return { ok: false, error: 'Folder name must be a normal directory name' };
  const target = path.join(parentPath ? path.resolve(parentPath) : process.cwd(), cleanName);
  try {
    await fs.mkdir(target, { recursive: true });
    return { ok: true, path: target, name: cleanName };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const workspaceSearchIgnored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '__pycache__', '.venv', 'venv']);

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export async function searchWorkspace(workspace, query, { limit = 200, maxFileBytes = 1024 * 1024, maxFiles = 5000 } = {}) {
  const needle = String(query || '').trim();
  if (!needle) return { query: needle, matches: [], scannedFiles: 0, skippedFiles: 0, truncated: false };
  const rootResult = await fs.realpath(path.resolve(workspace));
  const matches = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let visitedFiles = 0;
  let truncated = false;
  const lowerNeedle = needle.toLowerCase();

  const walk = async (dir) => {
    if (matches.length >= limit || visitedFiles >= maxFiles) { truncated = true; return; }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (matches.length >= limit || visitedFiles >= maxFiles) { truncated = true; break; }
      if (workspaceSearchIgnored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const real = await fs.realpath(full).catch(() => null);
        if (!real) continue;
        const relReal = path.relative(rootResult, real);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) continue;
        await walk(real);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles += 1;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > maxFileBytes) { skippedFiles += 1; continue; }
      const buffer = await fs.readFile(full).catch(() => null);
      if (!buffer || looksBinary(buffer)) { skippedFiles += 1; continue; }
      scannedFiles += 1;
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const lower = line.toLowerCase();
        let from = 0;
        while (from <= lower.length) {
          const column = lower.indexOf(lowerNeedle, from);
          if (column === -1) break;
          matches.push({
            path: path.relative(rootResult, full).split(path.sep).join('/'),
            line: index + 1,
            column: column + 1,
            preview: line.length > 300 ? `${line.slice(0, 297)}…` : line
          });
          if (matches.length >= limit) { truncated = true; break; }
          from = column + Math.max(1, lowerNeedle.length);
        }
        if (matches.length >= limit) break;
      }
    }
  };

  await walk(rootResult);
  return { query: needle, matches, scannedFiles, skippedFiles, truncated };
}

export async function gitReadFileVersion(workspace, filePath, source = 'head') {
  const mode = String(source || 'head').toLowerCase();
  const gitContext = await gitWorkspaceContext(workspace);
  const repoPath = [gitContext.prefix, String(filePath || '').replaceAll('\\', '/')].filter(Boolean).join('/');
  let args;
  if (mode === 'index' || mode === 'staged') args = ['show', `:${repoPath}`];
  else if (mode === 'head') args = ['show', `HEAD:${repoPath}`];
  else throw new Error('Unsupported Git file source');
  const result = await runCommand('git', args, { cwd: workspace, timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 });
  if (result.code !== 0) {
    const missing = /does not exist|exists on disk, but not in|Path .* does not exist|fatal: path/i.test(result.stderr || '');
    if (missing) return { content: '', exists: false, source: mode };
    throw new Error(result.stderr || 'Failed to read Git file version');
  }
  return { content: result.stdout, exists: true, source: mode };
}

export async function gitRestoreFile(workspace, filePath) {
  const tracked = await runCommand('git', ['ls-files', '--error-unmatch', '--', filePath], { cwd: workspace, timeoutMs: 8000 });
  if (tracked.code !== 0) throw new Error('Cannot restore an untracked file; delete it explicitly if that is intended');
  const result = await runCommand('git', ['restore', '--worktree', '--', filePath], { cwd: workspace, timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(result.stderr || 'Failed to restore file');
  return true;
}

// ── New project scaffolding ───────────────────────────────────────────────────
// Creates a brand-new workspace transactionally. This deliberately does not
// initialize Git here; after Studio opens the folder the existing Git onboarding
// flow handles that choice consistently for all workspaces.
export async function createNewProject(parentDir, projectName, template = 'empty') {
  const parent = path.resolve(String(parentDir || '').trim());
  const parentStat = await fs.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw Object.assign(new Error(`Parent folder does not exist: ${parent}`), { statusCode: 400, code: 'PROJECT_PARENT_INVALID' });
  }
  const rawName = String(projectName || '').trim();
  if (!rawName) throw Object.assign(new Error('Project name is required'), { statusCode: 400, code: 'PROJECT_NAME_REQUIRED' });
  const cleanName = rawName.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_').trim();
  if (!cleanName || cleanName === '.' || cleanName === '..') throw Object.assign(new Error('Project name is invalid'), { statusCode: 400, code: 'PROJECT_NAME_INVALID' });
  const kind = String(template || 'empty').trim().toLowerCase();
  if (!['empty', 'html', 'node'].includes(kind)) throw Object.assign(new Error(`Unsupported project template: ${kind}`), { statusCode: 400, code: 'PROJECT_TEMPLATE_INVALID' });

  const target = path.join(parent, cleanName);
  const existing = await fs.stat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    throw Object.assign(new Error(`Project folder already exists: ${target}`), { statusCode: 409, code: 'PROJECT_EXISTS' });
  }

  const cfg = await readConfig();
  const files = new Map();
  files.set('AGENTS.md', String(cfg.defaultAgentsMd || '# Workspace Agent Guidelines\n'));

  if (kind === 'html') {
    files.set('index.html', `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${cleanName}</title>\n  <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n  <main>\n    <h1>${cleanName}</h1>\n    <p>Edit <code>index.html</code> and open Studio Preview.</p>\n  </main>\n  <script src="./script.js"></script>\n</body>\n</html>\n`);
    files.set('styles.css', `:root { font-family: system-ui, sans-serif; color-scheme: light dark; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; }\nmain { width: min(680px, 90vw); }\n`);
    files.set('script.js', `console.log('${cleanName} ready');\n`);
  } else if (kind === 'node') {
    const packageName = cleanName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pi-studio-project';
    files.set('package.json', `${JSON.stringify({ name: packageName, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/index.mjs', test: 'node --test' } }, null, 2)}\n`);
    files.set('src/index.mjs', `console.log('${cleanName}');\n`);
    files.set('README.md', `# ${cleanName}\n\nCreated with Pi Ollama Studio.\n`);
  }

  try {
    await fs.mkdir(target, { recursive: false });
    for (const [relative, content] of files) {
      const file = path.join(target, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    }
    return { ok: true, projectName: cleanName, workspacePath: target, template: kind, files: [...files.keys()] };
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
