import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('PiRpcProcess translates a harness into literal Pi --tools and --append-system-prompt launch arguments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-args-'));
  const workspace = path.join(root, 'workspace');
  const appDir = path.join(root, 'studio');
  const argsFile = path.join(root, 'args.json');
  await fs.mkdir(workspace, { recursive: true });
  const mockPi = path.join(root, 'mock-pi.mjs');
  await fs.writeFile(mockPi, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PI_ARG_CAPTURE, JSON.stringify(process.argv.slice(2)));
let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',(chunk)=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const cmd=JSON.parse(line);console.log(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data:cmd.type==='get_state'?{sessionId:'harness-test',isStreaming:false,model:{provider:'ollama',id:'mock'}}:{}}));}});
`);
  const wrapper = path.join(root, `mock-pi${process.platform === 'win32' ? '.cmd' : ''}`);
  if (process.platform === 'win32') await fs.writeFile(wrapper, `@"${process.execPath}" "${mockPi}" %*\r\n`);
  else await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mockPi}" "$@"\n`, { mode: 0o755 });
  process.env.PI_OLLAMA_STUDIO_DIR = appDir;
  process.env.PI_COMMAND = wrapper;
  process.env.PI_ARG_CAPTURE = argsFile;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi-agent');
  const [{ PiRpcProcess }, { resolveHarness }] = await Promise.all([
    import(`../src/pi-rpc.mjs?harness=${Date.now()}`),
    import(`../src/harnesses.mjs?harness=${Date.now()}`)
  ]);
  const proc = new PiRpcProcess();
  t.after(async () => { await proc.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const harness = await resolveHarness('review-readonly');
  const extension = path.join(root, 'studio-tool.ts');
  await fs.writeFile(extension, 'export default function () {}\n');
  await proc.start({ workspace, modelId: 'mock', harnessId: harness.id, tools: harness.tools, appendSystemPrompt: harness.appendSystemPrompt, extensions: [extension] });
  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  const toolsAt = args.indexOf('--tools');
  const promptAt = args.indexOf('--append-system-prompt');
  assert.ok(toolsAt >= 0);
  assert.equal(args[toolsAt + 1], 'read,grep,find,ls');
  assert.ok(promptAt >= 0);
  const expectedPrompt = process.platform === 'win32' ? harness.appendSystemPrompt.replace(/\r\n?|\n/g, '\u2028') : harness.appendSystemPrompt;
  assert.equal(args[promptAt + 1], expectedPrompt);
  const extensionAt = args.indexOf('--extension');
  assert.ok(extensionAt >= 0);
  assert.equal(path.resolve(args[extensionAt + 1]), path.resolve(extension));
  assert.equal(proc.status().harnessId, 'review-readonly');
  assert.deepEqual(proc.status().tools, harness.tools);
});
