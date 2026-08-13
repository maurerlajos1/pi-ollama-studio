import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspProcess } from '../src/lsp.mjs';

const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
async function waitUntil(predicate, timeoutMs=3500){const until=Date.now()+timeoutMs;while(Date.now()<until){if(await predicate())return true;await sleep(30);}return false;}

const serverSource = String.raw`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const log=process.argv[2], marker=process.argv[3], worker=process.argv[4];
let buffer=Buffer.alloc(0);
function send(value){const body=Buffer.from(JSON.stringify(value));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]));}
function handle(msg){
  appendFileSync(log, String(msg.method || 'response')+'\n');
  if(msg.id!=null && msg.method==='initialize') send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{textDocumentSync:1},serverInfo:{name:'crash-lsp'}}});
  else if(msg.id!=null && msg.method==='shutdown') send({jsonrpc:'2.0',id:msg.id,result:null});
  else if(msg.method==='textDocument/didOpen' && !existsSync(marker)){
    writeFileSync(marker,'1'); spawn(process.execPath,[worker],{stdio:'ignore'}); setTimeout(()=>process.exit(31),120);
  } else if(msg.method==='exit') process.exit(0);
}
process.stdin.on('data',(chunk)=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length){const idx=buffer.indexOf('\r\n\r\n');if(idx<0)return;const h=buffer.subarray(0,idx).toString();const m=/Content-Length:\s*(\d+)/i.exec(h);if(!m){buffer=buffer.subarray(idx+4);continue;}const len=Number(m[1]),total=idx+4+len;if(buffer.length<total)return;const body=buffer.subarray(idx+4,total).toString();buffer=buffer.subarray(total);handle(JSON.parse(body));}});
setInterval(()=>{},1000);
`;

test('LSP crash clears protocol document state, cleans descendants, and restarts with didOpen', async (t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-lsp-crash-'));
  const server=path.join(root,'server.mjs'), log=path.join(root,'methods.log'), marker=path.join(root,'crashed.flag'), worker=path.join(root,'worker.mjs');
  await fs.writeFile(server,serverSource); await fs.writeFile(worker,'setInterval(()=>{},1000);\n');
  const proc=new LspProcess({definition:{id:'crash',label:'Crash',languages:['typescript'],command:process.execPath,args:[server,log,marker,worker],initializationOptions:{}},workspace:root,requestTimeout:3000});
  t.after(async()=>{await proc.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  await proc.start(); const firstPid=proc.status().pid; assert.ok(firstPid);
  await proc.openDocument({path:'a.ts',languageId:'typescript',text:'let a=1;'});
  assert.equal(await waitUntil(()=>!proc.running),true,'first LSP should crash');
  assert.equal(await waitUntil(()=>{try{process.kill(-firstPid,0);return false;}catch{return true;}},3000),true,'crashed LSP process group must be cleaned');

  await proc.changeDocument({path:'a.ts',text:'let a=2;'});
  assert.equal(proc.running,true);
  assert.equal(await waitUntil(async()=>{try{return (await fs.readFile(log,'utf8')).trim().split(/\s+/).filter((m)=>m==='textDocument/didOpen').length>=2;}catch{return false;}},3000),true,'replacement LSP must receive the reopened document');
  const methods=(await fs.readFile(log,'utf8')).trim().split(/\s+/);
  assert.equal(methods.filter((m)=>m==='textDocument/didOpen').length,2,'restart must send didOpen again');
  assert.equal(methods.filter((m)=>m==='textDocument/didChange').length,0,'fresh server must not receive didChange before didOpen');
});
