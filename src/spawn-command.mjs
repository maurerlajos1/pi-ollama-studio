import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.PS1'];
const CMD_META = /([()%!^"<>&|;, *?])/g;

function existingFile(candidate, exists = fs.existsSync) {
  try { return exists(candidate) ? candidate : null; } catch { return null; }
}

export function resolveWindowsCommand(command, { cwd = process.cwd(), env = process.env, exists = fs.existsSync } = {}) {
  const raw = String(command || '').trim();
  if (!raw) return raw;
  const winPath = path.win32;
  const pathExt = [...new Set([...String(env.PATHEXT || DEFAULT_PATHEXT.join(';')).split(';').map((ext) => ext.trim()).filter(Boolean), '.PS1'])];
  const hasPath = winPath.isAbsolute(raw) || /[\\/]/.test(raw);
  const candidatesFor = (base) => {
    const ext = winPath.extname(base);
    if (ext) return [base];
    // Windows command shims commonly sit beside an extensionless Unix shim.
    // Prefer executable/script extensions so an extensionless shell script is
    // never handed to spawn() as if it were a native Windows executable.
    return [...pathExt.map((suffix) => `${base}${suffix.toLowerCase()}`), ...pathExt.map((suffix) => `${base}${suffix.toUpperCase()}`), base];
  };
  if (hasPath) {
    const base = winPath.isAbsolute(raw) ? raw : winPath.resolve(cwd, raw);
    for (const candidate of candidatesFor(base)) {
      const found = existingFile(candidate, exists); if (found) return found;
    }
    return base;
  }
  const pathValue = env.Path || env.PATH || process.env.Path || process.env.PATH || '';
  for (const dir of String(pathValue).split(';').filter(Boolean)) {
    for (const candidate of candidatesFor(winPath.join(dir, raw))) {
      const found = existingFile(candidate, exists); if (found) return found;
    }
  }
  return raw;
}

export function escapeWindowsCommand(value) {
  return String(value || '').replace(CMD_META, '^$1');
}

export function escapeWindowsArgument(value, { doubleEscapeMetaChars = false } = {}) {
  let arg = String(value ?? '');
  // cmd.exe treats a literal CR/LF inside a quoted batch argument as a new
  // command. U+2028 survives the batch boundary and remains a line separator
  // to Pi/model prompts, avoiding truncation without falling back to shell:true.
  arg = arg.replace(/\r\n?|\n/g, '\u2028');
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  arg = arg.replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META, '^$1');
  if (doubleEscapeMetaChars) arg = arg.replace(CMD_META, '^$1');
  return arg;
}

export function prepareSpawn(command, args = [], { cwd, env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { command, args: [...args], options: {} };
  const resolved = resolveWindowsCommand(command, { cwd: cwd || process.cwd(), env, exists });
  const ext = path.win32.extname(String(resolved)).toLowerCase();
  if (ext === '.ps1') {
    const powershell = env.POWERSHELL_EXE || 'powershell.exe';
    return {
      command: powershell,
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
      options: { shell: false }
    };
  }
  if (ext !== '.cmd' && ext !== '.bat') return { command: resolved, args: [...args], options: { shell: false } };

  const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const shellCommand = [escapeWindowsCommand(resolved), ...args.map((arg) => escapeWindowsArgument(arg))].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { shell: false, windowsVerbatimArguments: true }
  };
}
