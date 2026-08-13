import test from 'node:test';import assert from 'node:assert/strict';import { promises as fs } from 'node:fs';import os from 'node:os';import path from 'node:path';import { PreviewManager, loadPreviewConfig, savePreviewConfig, __test } from '../src/preview.mjs';
test('preview config allows only loopback URLs and persists workspace settings',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await assert.rejects(()=>savePreviewConfig(dir,{command:'npm run dev',url:'https://example.com'}),/localhost/);const saved=await savePreviewConfig(dir,{command:'npm run dev',url:'http://127.0.0.1:5173'});assert.equal(saved.url,'http://127.0.0.1:5173/');assert.deepEqual(await loadPreviewConfig(dir),saved);});
test('preview manager launches command, detects localhost URL, captures logs and stops',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-run-'));const mgr=new PreviewManager();t.after(async()=>{await mgr.dispose();await fs.rm(dir,{recursive:true,force:true});});const script=path.join(dir,'server.mjs');await fs.writeFile(script,`console.log('ready http://127.0.0.1:45678'); setInterval(()=>{},1000);`);await mgr.start(dir,{command:`"${process.execPath}" "${script}"`});let snap;for(let i=0;i<30;i++){snap=mgr.snapshot(dir);if(snap.url)break;await new Promise(r=>setTimeout(r,50));}assert.equal(snap.url,'http://127.0.0.1:45678/');assert.match(snap.logs.map(x=>x.text).join(''),/ready/);assert.equal((await mgr.stop(dir)).removed,true);});
test('preview command validation rejects empty command',()=>assert.throws(()=>__test.cleanCommand(''),/required/));

test('preview URL normalizes wildcard local bind addresses and command suggestion prefers package dev script',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-suggest-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{dev:'vite'}}));const mod=await import('../src/preview.mjs');assert.equal(mod.__test.cleanUrl('http://0.0.0.0:5173'),'http://127.0.0.1:5173/');assert.equal(mod.__test.cleanUrl('http://[::1]:5173'),'http://127.0.0.1:5173/');assert.equal(mod.__test.cleanUrl('https://localhost:5173'),'https://localhost:5173/');assert.deepEqual(await mod.suggestPreviewCommand(dir),{command:'npm run dev',source:'package.json#scripts.dev'});});




test('plain index.html workspaces use Studio built-in static preview without npm or Python', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-static-html-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>Static Preview Works</h1>', 'utf8');
  const mod = await import('../src/preview.mjs');
  const suggestion = await mod.suggestPreviewCommand(dir);
  assert.equal(suggestion.source, 'index.html · Studio static server');
  assert.match(suggestion.command, /static-preview\.mjs/);
  const manager = new PreviewManager();
  t.after(async () => { await manager.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  await manager.start(dir, suggestion);
  let snap;
  for (let i = 0; i < 40; i++) {
    snap = manager.snapshot(dir);
    if (snap.url) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.match(snap.url || '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const body = await fetch(snap.url).then((response) => response.text());
  assert.match(body, /Static Preview Works/);
});

test('a single nested plain HTML app is detected and opened at its subfolder', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-nested-html-'));
  const appDir = path.join(dir, 'space shooter');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'index.html'), '<h1>Nested Preview Works</h1>', 'utf8');
  const mod = await import('../src/preview.mjs');
  const suggestion = await mod.suggestPreviewCommand(dir);
  assert.equal(suggestion.source, 'space shooter/index.html · Studio static server');
  assert.match(suggestion.command, /--studio-entry=space%20shooter/);
  assert.equal(mod.__test.staticEntryFromCommand(suggestion.command), 'space shooter');
  const manager = new PreviewManager();
  t.after(async () => { await manager.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  await manager.start(dir, suggestion);
  let snap;
  for (let i = 0; i < 40; i++) {
    snap = manager.snapshot(dir);
    if (snap.url) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.match(snap.url || '', /^http:\/\/127\.0\.0\.1:\d+\/space%20shooter\/$/);
  const body = await fetch(snap.url).then((response) => response.text());
  assert.match(body, /Nested Preview Works/);
});

test('multiple nested HTML apps remain an explicit user choice', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-ambiguous-html-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['app-one', 'app-two']) {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'index.html'), `<h1>${name}</h1>`, 'utf8');
  }
  const mod = await import('../src/preview.mjs');
  assert.deepEqual(await mod.suggestPreviewCommand(dir), { command: '', source: '' });
});
test('preview stop escalates when the dev server ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows uses taskkill /T /F instead of POSIX signal escalation');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'preview-stubborn-'));
  const script=path.join(root,'stubborn-preview.mjs');
  await fs.writeFile(script, `process.on('SIGTERM',()=>{}); console.log('http://127.0.0.1:45678'); setInterval(()=>{},1000);`);
  const manager=new PreviewManager();
  try {
    const started=await manager.start(root,{command:`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`});
    const pid=started.pid;
    await new Promise((resolve)=>setTimeout(resolve,100));
    await manager.stop(root);
    await new Promise((resolve)=>setTimeout(resolve,50));
    let alive=true; try { process.kill(pid,0); } catch { alive=false; }
    assert.equal(alive,false,'stubborn preview process group should be killed');
    assert.equal(manager.snapshot(root).status,'stopped');
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('preview URL detection survives URLs split across stdout chunks', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-chunk-url-')); const mgr=new PreviewManager(); t.after(async()=>{await mgr.dispose();await fs.rm(dir,{recursive:true,force:true});});
  const script=path.join(dir,'server.mjs'); await fs.writeFile(script,`process.stdout.write('ready http://127.');setTimeout(()=>process.stdout.write('0.0.1:45679\\n'),40);setInterval(()=>{},1000);`);
  await mgr.start(dir,{command:`"${process.execPath}" "${script}"`}); let snap;for(let i=0;i<30;i++){snap=mgr.snapshot(dir);if(snap.url)break;await new Promise((resolve)=>setTimeout(resolve,30));} assert.equal(snap.url,'http://127.0.0.1:45679/');
});

test('concurrent preview starts serialize per workspace and do not orphan the first server', { skip: process.platform === 'win32' }, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-double-start-'));const mgr=new PreviewManager();t.after(async()=>{await mgr.dispose();await fs.rm(dir,{recursive:true,force:true});});
  const pidFile=path.join(dir,'pids.txt');const script=path.join(dir,'server.mjs');await fs.writeFile(script,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(pidFile)},String(process.pid)+'\\n');console.log('http://127.0.0.1:45680');setInterval(()=>{},1000);`);const command=`"${process.execPath}" "${script}"`;
  await Promise.all([mgr.start(dir,{command}),mgr.start(dir,{command})]);await new Promise((resolve)=>setTimeout(resolve,120));const pids=(await fs.readFile(pidFile,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);assert.ok(pids.length>=1&&pids.length<=2);
  const state=async(pid)=>{try{return(await fs.readFile(`/proc/${pid}/stat`,'utf8')).split(' ')[2];}catch{return'gone';}};const active=[];for(const pid of pids){if(!['gone','Z'].includes(await state(pid)))active.push(pid);}assert.equal(active.length,1,'only one preview process may remain active after concurrent starts');await mgr.dispose();let final='';for(let i=0;i<30;i++){final=await state(active[0]);if(['gone','Z'].includes(final))break;await new Promise((resolve)=>setTimeout(resolve,50));}assert.ok(['gone','Z'].includes(final),'tracked preview should be stopped by dispose');
});

test('preview URL detection ignores ANSI color sequences without altering captured logs', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-ansi-url-')); const mgr=new PreviewManager(); t.after(async()=>{await mgr.dispose();await fs.rm(dir,{recursive:true,force:true});});
  const script=path.join(dir,'server.mjs');
  await fs.writeFile(script,`process.stdout.write('Local: \\u001b[36mhttp://127.0.0.1:45681/\\u001b[39m\\n');setInterval(()=>{},1000);`);
  await mgr.start(dir,{command:`"${process.execPath}" "${script}"`});
  let snap;for(let i=0;i<30;i++){snap=mgr.snapshot(dir);if(snap.url)break;await new Promise((resolve)=>setTimeout(resolve,30));}
  assert.equal(snap.url,'http://127.0.0.1:45681/');
  assert.match(snap.logs.map((row)=>row.text).join(''),/\x1b\[36m/,'raw log should retain terminal color data');
});
