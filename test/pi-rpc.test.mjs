import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock Pi source — no shebang so it works cross-platform (Windows doesn't honour shebangs)
const mockSource = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'get_state') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: 'get_state', success: true, data: { sessionId: 'mock', isStreaming: false, model: { provider: 'ollama', id: 'mock-model' } } }));
    } else if (cmd.type === 'prompt') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: 'prompt', success: true }));
      console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    } else {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} }));
    }
  }
});
`;

test('PiRpcProcess starts, correlates responses and emits events', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-rpc-test-'));
  const workspace = path.join(root, 'workspace');
  const appDir = path.join(root, 'studio');
  await fs.mkdir(workspace, { recursive: true });
  // Write as .mjs and invoke with process.execPath so it works on Windows (no shebang needed)
  const mockPi = path.join(root, 'mock-pi.mjs');
  await fs.writeFile(mockPi, mockSource, { mode: 0o755 });
  // PI_COMMAND must be the node executable; pass the script as an argument via a wrapper
  const wrapper = path.join(root, 'mock-pi-wrapper' + (process.platform === 'win32' ? '.cmd' : ''));
  if (process.platform === 'win32') {
    await fs.writeFile(wrapper, `@"${process.execPath}" "${mockPi}" %*\r\n`);
  } else {
    await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mockPi}" "$@"\n`, { mode: 0o755 });
  }
  process.env.PI_OLLAMA_STUDIO_DIR = appDir;
  process.env.PI_COMMAND = wrapper;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi-agent');
  const { PiRpcProcess } = await import(`../src/pi-rpc.mjs?test=${Date.now()}`);
  const proc = new PiRpcProcess();
  t.after(async () => {
    await proc.stop().catch(() => {});
    // On Windows the child process may still hold file handles briefly after exit; retry rm
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  });
  const initial = await proc.start({ workspace, modelId: 'mock-model' });
  assert.equal(initial.data.sessionId, 'mock');
  const events = [];
  proc.on('event', (event) => events.push(event));
  const response = await proc.request({ type: 'prompt', message: 'hi' });
  assert.equal(response.success, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(events.some((event) => event.type === 'message_update'));
  assert.ok(events.some((event) => event.type === 'agent_settled'));

  const first = proc.request({ type: 'get_state', id: 'duplicate' });
  await assert.rejects(
    () => proc.request({ type: 'get_state', id: 'duplicate' }),
    (error) => error.code === 'PI_RPC_DUPLICATE_ID'
  );
  assert.equal((await first).data.sessionId, 'mock');

  await proc.request({ type: 'set_model', provider: 'ollama', modelId: 'next-model' });
  assert.equal(proc.status().modelId, 'next-model', 'a successful live model switch must update the restart contract');
  await proc.request({ type: 'set_model', provider: 'openai', modelId: 'gpt-test' });
  assert.equal(proc.status().modelId, 'openai/gpt-test');

  const staleStop = await proc.stop({ expectedWorkspace: path.join(root, 'different-workspace') });
  assert.equal(staleStop.stopped, false);
  assert.equal(staleStop.reason, 'workspace-mismatch');
  assert.equal(proc.running, true, 'a stale workspace stop must not terminate the active Pi process');
  const matchingStop = await proc.stop({ expectedWorkspace: workspace });
  assert.equal(matchingStop.stopped, true);
  assert.equal(proc.running, false);
});

test('PiRpcProcess rejects session files outside its workspace session directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-rpc-session-safe-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside.jsonl');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(outside, '{}\n');
  process.env.PI_OLLAMA_STUDIO_DIR = path.join(root, 'studio');
  process.env.PI_COMMAND = path.join(root, 'not-used');
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi-agent');
  const { PiRpcProcess } = await import(`../src/pi-rpc.mjs?safe=${Date.now()}`);
  const proc = new PiRpcProcess();
  t.after(async () => { await proc.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => proc.start({ workspace, modelId: 'mock-model', sessionPath: outside }), /outside the selected workspace/);
});
