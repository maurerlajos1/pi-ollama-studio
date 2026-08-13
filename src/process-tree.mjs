import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function processGroupAlive(pid) {
  if (!pid || process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

export async function terminateProcessTree(child, { graceMs = 600 } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      killer.once('error', () => { try { child.kill(); } catch {} done(); });
      killer.once('exit', (code) => { if (code !== 0) try { child.kill(); } catch {} done(); });
    });
    return;
  }
  const groupAlive = () => processGroupAlive(child.pid);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  const deadline = Date.now() + graceMs;
  while (groupAlive() && Date.now() < deadline) await sleep(25);
  if (groupAlive()) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    const killDeadline = Date.now() + graceMs;
    while (groupAlive() && Date.now() < killDeadline) await sleep(25);
  }
}
