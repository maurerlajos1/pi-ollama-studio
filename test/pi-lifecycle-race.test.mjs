import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitUntil(predicate, timeoutMs = 3000) { const until=Date.now()+timeoutMs; while(Date.now()<until){ if(await predicate()) return true; await sleep(30); } return false; }

test('PiRpcProcess serializes concurrent starts and never leaves an untracked Pi process', { skip: process.platform === 'win32' ? 'Windows batch-wrapper PID semantics are covered by the Windows Pi release gate.' : false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-pi-lifecycle-'));
  const appDir = path.join(root, 'studio');
  const workspace = path.join(root, 'workspace');
  const launches = path.join(root, 'launches.txt');
  const mockPi = path.join(root, 'mock-pi.mjs');
  const wrapper = path.join(root, `mock-pi${process.platform === 'win32' ? '.cmd' : ''}`);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(mockPi, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'get_state') console.log(JSON.stringify({ type:'response', id:cmd.id, command:'get_state', success:true, data:{ sessionId:'mock', isStreaming:false, model:{provider:'ollama', id:'mock-model'} } }));
    else console.log(JSON.stringify({ type:'response', id:cmd.id, command:cmd.type, success:true, data:{} }));
  }
});
setInterval(() => {}, 1000);
`);
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mockPi}" "$@"\n`, { mode: 0o755 });
  if (process.platform === 'win32') await fs.writeFile(wrapper, `@"${process.execPath}" "${mockPi}" %*\r\n`);
  process.env.PI_OLLAMA_STUDIO_DIR = appDir;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi-agent');
  process.env.PI_COMMAND = wrapper;
  const { PiRpcProcess } = await import(`../src/pi-rpc.mjs?lifecycle=${Date.now()}`);
  const proc = new PiRpcProcess();
  t.after(async () => { await proc.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });

  const [first, second] = await Promise.all([
    proc.start({ workspace, modelId: 'mock-model' }),
    proc.start({ workspace, modelId: 'mock-model' })
  ]);
  assert.equal(first.data.sessionId, 'mock');
  assert.equal(second.data.sessionId, 'mock');
  const pids = (await fs.readFile(launches, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  assert.ok(pids.length >= 1 && pids.length <= 2, `expected one serialized start or one orderly restart, got ${pids.length} launches`);
  const activePid = proc.status().pid;
  assert.equal(pidAlive(activePid), true, 'tracked Pi process should be alive');
  for (const pid of pids) if (pid !== activePid) assert.equal(await waitUntil(() => !pidAlive(pid)), true, `old Pi process ${pid} should not survive`);

  await proc.stop();
  for (const pid of pids) assert.equal(await waitUntil(() => !pidAlive(pid)), true, `Pi process ${pid} should be gone after stop`);
});
