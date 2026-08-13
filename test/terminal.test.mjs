import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../src/terminal.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('Timed out waiting for terminal output');
}

test('TerminalManager creates an integrated terminal, accepts input, captures history and resizes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new TerminalManager();
  t.after(() => manager.dispose());

  const caps = await manager.capabilities();
  assert.equal(typeof caps.pty, 'boolean');
  assert.ok(caps.defaultShell);

  const created = await manager.create({ workspace: root, name: 'E2E Terminal', cols: 100, rows: 24 });
  assert.equal(created.name, 'E2E Terminal');
  assert.equal(created.workspace, path.resolve(root));
  assert.ok(['pty', 'pipe'].includes(created.backend));
  assert.ok(created.pid);

  manager.write(created.id, process.platform === 'win32' ? 'Write-Output "terminal-ok"\r' : 'printf "terminal-ok\\n"\n');
  const session = await waitFor(() => {
    const value = manager.get(created.id);
    return value?.history?.includes('terminal-ok') ? value : null;
  });
  assert.match(session.history, /terminal-ok/);

  const resized = manager.resize(created.id, 132, 42);
  assert.equal(resized.cols, 132);
  assert.equal(resized.rows, 42);
  assert.equal(manager.list().length, 1);

  const removed = await manager.kill(created.id);
  assert.equal(removed.removed, true);
  assert.equal(manager.list().length, 0);
});

test('vendored xterm UI assets and node-pty payload are present for offline packaging', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [
    'vendor/xterm/xterm/lib/xterm.js',
    'vendor/xterm/xterm/css/xterm.css',
    'vendor/xterm/fit/lib/addon-fit.js',
    'vendor/xterm/search/lib/addon-search.js',
    'vendor/xterm/web-links/lib/addon-web-links.js',
    'vendor/xterm/webgl/lib/addon-webgl.js',
    'vendor/packages/node-pty-1.1.0.tgz'
  ];
  for (const relative of files) {
    const stat = await fs.stat(path.join(root, relative));
    assert.equal(stat.isFile(), true, `${relative} should be a file`);
    assert.ok(stat.size > 100, `${relative} should not be empty`);
  }
});


test('pipe fallback terminal kill terminates descendant processes', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-terminal-tree-'));
  const manager = new TerminalManager();
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const created = await manager.create({ workspace: root, shell: process.env.SHELL || '/bin/bash' });
  if (created.backend !== 'pipe') return t.skip('node-pty backend is active; fallback process-tree test is not applicable');
  const pidFile = path.join(root, 'kid.pid');
  const helper = path.join(root, 'tree-runner.mjs');
  await fs.writeFile(helper, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
  manager.write(created.id, `"${process.execPath}" "${helper}"\n`);
  let kid = 0;
  for (let i=0;i<60;i++){try{kid=Number(await fs.readFile(pidFile,'utf8'));if(kid)break;}catch{}await sleep(25);}
  assert.ok(kid > 0);
  await manager.kill(created.id);
  let running=true;for(let i=0;i<50;i++){try{const stat=await fs.readFile(`/proc/${kid}/stat`,'utf8');running=stat.split(' ')[2]!=='Z';}catch{running=false;}if(!running)break;await sleep(25);}
  assert.equal(running,false,'closing fallback terminal must terminate descendant command processes');
});
