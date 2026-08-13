import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareSpawn } from '../src/spawn-command.mjs';

function run(command, args = []) {
  const prepared = prepareSpawn(command, args, { cwd: process.cwd(), env: process.env });
  return spawnSync(prepared.command, prepared.args, { encoding: 'utf8', windowsHide: true, ...prepared.options });
}

function commandAvailable(command) {
  const probe = run(command, ['--version']);
  return !probe.error && probe.status === 0;
}

const command = process.env.PI_COMMAND || 'pi';
if (!commandAvailable(command)) {
  console.log(`SKIP: Pi command not available: ${command}`);
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-real-pi-'));
const workspace = path.join(root, 'workspace');
const appDir = path.join(root, 'studio');
const agentDir = path.join(root, 'agent');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });

process.env.PI_COMMAND = command;
process.env.PI_OLLAMA_STUDIO_DIR = appDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = process.env.PI_OFFLINE || '1';
process.env.PI_SKIP_VERSION_CHECK = '1';

const { PiRpcProcess } = await import('../src/pi-rpc.mjs');
const pi = new PiRpcProcess();
let stderr = '';
pi.on('stderr', (chunk) => { stderr += String(chunk); });

try {
  const started = await pi.start({ workspace });
  if (!started?.success || !started?.data?.sessionId) throw new Error('Real Pi get_state did not return a session');
  const commands = await pi.request({ type: 'get_commands' });
  if (!commands?.success || !Array.isArray(commands.data?.commands)) throw new Error('Real Pi get_commands failed');
  const tree = await pi.request({ type: 'get_tree' });
  if (!tree?.success || !tree.data) throw new Error('Real Pi get_tree failed');
  const stats = await pi.request({ type: 'get_session_stats' });
  if (!stats?.success || !stats.data?.sessionId) throw new Error('Real Pi get_session_stats failed');
  console.log(`PASS: Real Pi RPC ${run(command, ['--version']).stdout.trim() || 'unknown version'}`);
  console.log(`  session: ${started.data.sessionId}`);
  console.log(`  commands discovered: ${commands.data.commands.length}`);
  console.log('  get_tree: ok');
  console.log('  get_session_stats: ok');
} finally {
  await pi.stop().catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

if (stderr.trim()) console.log(`Pi stderr (non-fatal):\n${stderr.trim()}`);
