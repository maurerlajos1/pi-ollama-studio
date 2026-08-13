import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
function pidAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function waitUntil(predicate,timeoutMs=3000){const until=Date.now()+timeoutMs;while(Date.now()<until){if(await predicate())return true;await sleep(30);}return false;}

test('PiRpcProcess cleans descendant workers after an unexpected Pi crash', { skip: process.platform === 'win32' ? 'Negative process-group signals are POSIX-only; Windows descendant cleanup is exercised by the Windows release gate.' : false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-pi-crash-'));
  const appDir = path.join(root, 'studio');
  const workspace = path.join(root, 'workspace');
  const worker = path.join(root, 'worker.mjs');
  const mockPi = path.join(root, 'crash-pi.mjs');
  const wrapper = path.join(root, 'crash-pi');
  await fs.mkdir(workspace, { recursive:true });
  await fs.writeFile(worker, `setInterval(() => {}, 1000);\n`);
  await fs.writeFile(mockPi, `
import { spawn } from 'node:child_process';
let buffer=''; let armed=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const cmd=JSON.parse(line);if(cmd.type==='get_state'){console.log(JSON.stringify({type:'response',id:cmd.id,command:'get_state',success:true,data:{sessionId:'crash',isStreaming:false,model:{provider:'ollama',id:'m'}}}));if(!armed){armed=true;spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'ignore'});setTimeout(()=>process.exit(23),350);}}else console.log(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data:{}}));}});
setInterval(()=>{},1000);
`);
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mockPi}" "$@"\n`, { mode:0o755 });
  process.env.PI_OLLAMA_STUDIO_DIR=appDir;
  process.env.PI_CODING_AGENT_DIR=path.join(root,'pi-agent');
  process.env.PI_COMMAND=wrapper;
  const { PiRpcProcess } = await import(`../src/pi-rpc.mjs?crash=${Date.now()}`);
  const proc=new PiRpcProcess();
  t.after(async()=>{await proc.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  await proc.start({workspace,modelId:'m'});
  const groupPid=proc.status().pid;
  assert.ok(groupPid);
  assert.equal(await waitUntil(()=>!proc.running,3000),true,'Pi leader should crash');
  assert.equal(await waitUntil(()=>{try{process.kill(-groupPid,0);return false;}catch{return true;}},3000),true,'unexpected Pi exit must clean its process group');
});
