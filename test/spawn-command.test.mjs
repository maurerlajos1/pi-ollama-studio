import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prepareSpawn, resolveWindowsCommand, escapeWindowsArgument } from '../src/spawn-command.mjs';

test('non-Windows spawn preserves command and argv without a shell', () => {
  const value = prepareSpawn('npm', ['test', '--', 'a&b'], { platform: 'linux' });
  assert.equal(value.command, 'npm');
  assert.deepEqual(value.args, ['test', '--', 'a&b']);
  assert.deepEqual(value.options, {});
});

test('Windows command resolution searches PATH/PATHEXT and resolves relative commands against cwd', () => {
  const cwd = 'C:\\work';
  const files = new Set(['C:\\tools\\npm.cmd', 'C:\\work\\bin\\pi.cmd']);
  const exists = (value) => files.has(value);
  assert.equal(resolveWindowsCommand('npm', { cwd, env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' }, exists }), 'C:\\tools\\npm.cmd');
  assert.equal(resolveWindowsCommand('.\\bin\\pi.cmd', { cwd, env: {}, exists }), 'C:\\work\\bin\\pi.cmd');
});

test('Windows batch execution uses cmd.exe with escaped literal arguments instead of shell:true', () => {
  const files = new Set(['C:\\tools\\pi.cmd']);
  const value = prepareSpawn('pi', ['install', '-l', '.\\local & echo UI_E2E_INJECTED', '100%'], {
    platform: 'win32', cwd: 'C:\\work', env: { PATH: 'C:\\tools', PATHEXT: '.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, exists: (item) => files.has(item)
  });
  assert.equal(value.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(value.options.shell, false);
  assert.equal(value.options.windowsVerbatimArguments, true);
  assert.equal(value.args[0], '/d');
  const line = value.args.at(-1);
  assert.match(line, /\^&/);
  assert.match(line, /UI_E2E_INJECTED/);
  assert.match(line, /100\^%/);
  assert.equal(/(^|[^\^])&/.test(line), false, 'ampersand must never reach cmd.exe unescaped');
});

test('Windows direct executables do not go through cmd.exe', () => {
  const files = new Set(['C:\\tools\\ollama.exe']);
  const value = prepareSpawn('ollama', ['serve'], { platform: 'win32', cwd: 'C:\\work', env: { PATH: 'C:\\tools', PATHEXT: '.EXE' }, exists: (item) => files.has(item) });
  assert.equal(value.command, 'C:\\tools\\ollama.exe');
  assert.deepEqual(value.args, ['serve']);
  assert.equal(value.options.shell, false);
});

test('Windows PowerShell shims run through powershell.exe with literal argv', () => {
  const files = new Set(['C:\\tools\\pi.ps1']);
  const value = prepareSpawn('pi', ['--mode', 'rpc', 'local & literal'], {
    platform: 'win32', cwd: 'C:\\work', env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD', POWERSHELL_EXE: 'powershell.exe' }, exists: (item) => files.has(item)
  });
  assert.equal(value.command, 'powershell.exe');
  assert.equal(value.options.shell, false);
  assert.deepEqual(value.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(value.args[5], 'C:\\tools\\pi.ps1');
  assert.deepEqual(value.args.slice(6), ['--mode', 'rpc', 'local & literal']);
});

test('argument escaping protects shell metacharacters and trailing backslashes', () => {
  const escaped = escapeWindowsArgument('C:\\A & B\\');
  assert.match(escaped, /\^&/);
  assert.ok(escaped.startsWith('^"') || escaped.startsWith('"'));
});

test('real hardware E2E requires the selected model by default and uses literal Windows argv', async () => {
  const [script, wrapper] = await Promise.all([
    fs.readFile(new URL('../scripts/test-ollama-e2e.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/test-ollama-e2e-windows.ps1', import.meta.url), 'utf8')
  ]);
  assert.match(script, /PI_STUDIO_E2E_FALLBACK_MODEL \|\| ''/);
  assert.match(script, /fallback disabled/);
  assert.doesNotMatch(script, /available\[0\]/, 'the test must not silently choose any installed model');
  assert.match(script, /selectInstalledE2eModel/);
  assert.match(script, /runtime\.ollama\?\.models/, 'preflight must read the actual Ollama inventory from the route payload');
  assert.match(script, /timeoutMs: 60000/, 'transient Ollama inventory startup must have a bounded wait');
  assert.match(script, /prepareSpawn\('npm', \['test'\]/);
  assert.doesNotMatch(script, /shell:\s*(?:true|process\.platform)/);
  assert.match(wrapper, /else \{ '' \}/);
  assert.match(wrapper, /'disabled'/);
  assert.doesNotMatch(wrapper, /llama3\.2/i);
});
