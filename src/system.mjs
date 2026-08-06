import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.mjs';

let versionCache = null;

export function runCommand(command, args = [], { cwd, env, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const add = (target, chunk) => {
      let value = target + String(chunk);
      if (Buffer.byteLength(value) > maxBytes) {
        value = value.slice(-maxBytes);
        truncated = true;
      }
      return value;
    };
    child.stdout.on('data', (chunk) => { stdout = add(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = add(stderr, chunk); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, truncated });
    });
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
    const [pi, ollama] = await Promise.all([commandVersion(cfg.piCommand), commandVersion(cfg.ollamaCommand)]);
    versionCache = { key: cacheKey, at: Date.now(), pi, ollama };
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
    gpu
  };
}

export async function getGitStatus(workspace) {
  const [status, diffStat, branch] = await Promise.all([
    runCommand('git', ['status', '--porcelain=v1', '-b'], { cwd: workspace, timeoutMs: 8000 }).catch((error) => ({ code: -1, stderr: error.message, stdout: '' })),
    runCommand('git', ['diff', '--stat'], { cwd: workspace, timeoutMs: 8000 }).catch(() => ({ stdout: '' })),
    runCommand('git', ['branch', '--show-current'], { cwd: workspace, timeoutMs: 8000 }).catch(() => ({ stdout: '' }))
  ]);
  // Parse porcelain: first line starting with ## is branch info, rest are file entries
  const lines = status.stdout.split('\n');
  const branchLine = lines.find((l) => l.startsWith('##')) || '';
  const aheadMatch = branchLine.match(/\[ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  const porcelainLines = lines.filter((l) => l.length >= 3 && !l.startsWith('##')).join('\n');
  return {
    isRepository: status.code === 0,
    branch: branch.stdout.trim(),
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    status: status.stdout,
    porcelain: porcelainLines,
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
    args = stage ? ['add', '-A'] : ['reset', 'HEAD'];
  } else {
    args = stage ? ['add', '--', filePath] : ['reset', 'HEAD', '--', filePath];
  }
  const result = await runCommand('git', args, { cwd: workspace, timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(result.stderr || 'git stage operation failed');
  return true;
}

export async function gitCommit(workspace, message) {
  if (!message || !message.trim()) throw new Error('Commit message is required');
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

export class ManagedOllama extends EventEmitter {
  #child = null;
  #logs = [];

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

  async start() {
    if (this.running) return this.status();
    const cfg = await readConfig();
    const env = {
      ...process.env,
      OLLAMA_MODELS: process.env.OLLAMA_MODELS || 'H:\\ollama-models',
      OLLAMA_HOST: '0.0.0.0:11434',
      OLLAMA_FLASH_ATTENTION: cfg.flashAttention ? '1' : '0',
      OLLAMA_KV_CACHE_TYPE: cfg.kvCacheType,
      OLLAMA_CONTEXT_LENGTH: String(cfg.defaultContextLength),
      OLLAMA_NUM_PARALLEL: String(cfg.numParallel),
      OLLAMA_MAX_LOADED_MODELS: String(cfg.maxLoadedModels),
      OLLAMA_MAX_QUEUE: String(cfg.maxQueue),
      OLLAMA_KEEP_ALIVE: cfg.keepAlive,
      OLLAMA_NO_CLOUD: cfg.noCloud ? '1' : '0'
    };
    const child = spawn(cfg.ollamaCommand, ['serve'], {
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
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
      if (this.#child === child) this.#child = null;
      this.#log('exit', `Ollama exited: code=${code}, signal=${signal}`);
      this.emit('exit', { code, signal });
    });
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 500)),
      new Promise((_, reject) => child.once('error', reject)),
      new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`Ollama exited during startup with code ${code}`))))
    ]);
    return this.status();
  }

  async stop() {
    const child = this.#child;
    if (!child) return this.status();
    this.#child = null;
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
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
  const resolved = targetPath ? path.resolve(targetPath) : process.cwd();
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
      for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
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
  const target = path.join(parentPath ? path.resolve(parentPath) : process.cwd(), cleanName);
  try {
    await fs.mkdir(target, { recursive: true });
    return { ok: true, path: target, name: cleanName };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
