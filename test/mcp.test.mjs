import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { McpManager, buildMcpBridgeSource, ensureMcpPiBridge } from '../src/mcp.mjs';
import { APP_VERSION } from '../src/config.mjs';

async function tempRoot() { return fs.mkdtemp(path.join(os.tmpdir(),'pi-studio-mcp-')); }

async function writeFakeStdio(root) {
  const file=path.join(root,'fake-mcp.mjs');
  await fs.writeFile(file, `import readline from 'node:readline';\nconst rl=readline.createInterface({input:process.stdin});\nconst send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');\nrl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}; if(m.id==null)return; let result={}; if(m.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{},prompts:{}}}; else if(m.method==='tools/list') result={tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}; else if(m.method==='resources/list') result={resources:[{uri:'memory://one',name:'One'}]}; else if(m.method==='prompts/list') result={prompts:[{name:'hello',description:'Hello'}]}; else if(m.method==='tools/call') result={content:[{type:'text',text:'echo:'+String(m.params?.arguments?.text||'')}]}; else if(m.method==='resources/read') result={contents:[{uri:m.params.uri,text:'resource'}]}; else if(m.method==='prompts/get') result={description:'Hello',messages:[{role:'user',content:{type:'text',text:'Hi'}}]}; else return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}}); send({jsonrpc:'2.0',id:m.id,result});});\n`);
  return file;
}

test('MCP stdio manager discovers tools/resources/prompts and enforces Pi exposure separately from manual calls', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const fake=await writeFakeStdio(root);
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'local',name:'Local MCP',transport:'stdio',command:process.execPath,args:[fake],exposeToPi:false});
    const connected=await manager.connect('local');
    assert.equal(connected.status,'connected');
    assert.equal(connected.tools[0].name,'echo');
    assert.equal(connected.resources[0].uri,'memory://one');
    assert.equal(connected.prompts[0].name,'hello');
    const manual=await manager.callTool('local','echo',{text:'manual'});
    assert.equal(manual.content[0].text,'echo:manual');
    await assert.rejects(()=>manager.agentCall({serverId:'local',toolName:'echo',args:{text:'blocked'}}),/not exposed/i);
    assert.equal((await manager.agentTools())[0].active,false);
    await manager.updateExposure('local',{exposeToPi:true});
    assert.equal((await manager.agentTools())[0].active,true);
    const agent=await manager.agentCall({serverId:'local',toolName:'echo',args:{text:'agent'}});
    assert.equal(agent.content[0].text,'echo:agent');
    await manager.updateExposure('local',{disabledTools:['echo']});
    assert.equal((await manager.agentTools())[0].active,false);
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('MCP HTTP manager supports the current stateless protocol headers', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const seen=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const msg=JSON.parse(body);seen.push({method:msg.method,protocol:req.headers['mcp-protocol-version'],routeMethod:req.headers['mcp-method']});let result={};if(msg.method==='tools/list')result={tools:[{name:'remote',inputSchema:{type:'object',properties:{}}}]};else if(msg.method==='resources/list')result={resources:[]};else if(msg.method==='prompts/list')result={prompts:[]};else if(msg.method==='tools/call')result={content:[{type:'text',text:'ok'}]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve)); const address=server.address();
  const manager=new McpManager({storePath});
  try { await manager.saveServer({id:'http',transport:'http',url:`http://127.0.0.1:${address.port}/mcp`,exposeToPi:true}); await manager.connect('http'); const result=await manager.callTool('http','remote',{}); assert.equal(result.content[0].text,'ok'); assert.ok(seen.some((row)=>row.protocol==='2026-07-28'&&row.routeMethod==='tools/list')); }
  finally { await manager.dispose(); await new Promise((resolve)=>server.close(resolve)); await fs.rm(root,{recursive:true,force:true}); }
});

test('Studio managed Pi MCP bridge registers tools dynamically and hot-updates active tools', async () => {
  const source=buildMcpBridgeSource();
  assert.match(source,/from \"typebox\"/);
  assert.doesNotMatch(source,/@sinclair\/typebox/);
  assert.match(source,/pi\.registerTool/);
  assert.match(source,/pi\.getActiveTools\(\)/);
  assert.match(source,/pi\.setActiveTools/);
  assert.match(source,/\/api\/mcp\/agent\/call/);
  const root=await tempRoot(); const target=path.join(root,'extensions','bridge.ts');
  try { await ensureMcpPiBridge({bridgePath:target}); assert.equal(await fs.readFile(target,'utf8'),source); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('MCP snapshots never return literal environment or header values', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json');
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'safe-http',transport:'http',url:'http://127.0.0.1:9999/mcp',headers:{Authorization:'Bearer literal-secret','X-Tenant':'literal-tenant','X-Env':'$MCP_TEST_HEADER'},exposeToPi:false});
    await manager.saveServer({id:'safe-stdio',transport:'stdio',command:process.execPath,args:['-v'],env:{TOKEN:'literal-token',FROM_ENV:'$MCP_TEST_ENV'}});
    const snapshot=await manager.snapshot();
    const httpServer=snapshot.servers.find((item)=>item.id==='safe-http');
    const stdioServer=snapshot.servers.find((item)=>item.id==='safe-stdio');
    assert.equal(httpServer.headers.Authorization,'<literal>');
    assert.equal(httpServer.headers['X-Tenant'],'<literal>');
    assert.equal(httpServer.headers['X-Env'],'$MCP_TEST_HEADER');
    assert.equal(stdioServer.env.TOKEN,'<literal>');
    assert.equal(stdioServer.env.FROM_ENV,'$MCP_TEST_ENV');
    assert.equal(JSON.stringify(snapshot).includes('literal-secret'),false);
    assert.equal(JSON.stringify(snapshot).includes('literal-token'),false);
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});


test('MCP current-protocol requests report the package version instead of a stale development version', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const seen=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const msg=JSON.parse(body);seen.push(msg);const result=msg.method==='tools/list'?{tools:[]}:(msg.method==='resources/list'?{resources:[]}:{prompts:[]});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve)); const address=server.address();
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'versioned',transport:'http',url:`http://127.0.0.1:${address.port}/mcp`});
    await manager.connect('versioned');
    const toolList=seen.find((message)=>message.method==='tools/list');
    assert.equal(toolList?.params?._meta?.['io.modelcontextprotocol/clientInfo']?.version,APP_VERSION);
    const pkg=JSON.parse(await fs.readFile(path.join(process.cwd(),'package.json'),'utf8'));
    assert.equal(APP_VERSION,pkg.version);
  } finally { await manager.dispose(); await new Promise((resolve)=>server.close(resolve)); await fs.rm(root,{recursive:true,force:true}); }
});


test('failed MCP stdio initialization closes the spawned server process', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const pidFile=path.join(root,'pid.txt'); const fake=path.join(root,'hanging-mcp.mjs');
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid));\nprocess.stdin.resume();\n`);
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'hang',transport:'stdio',command:process.execPath,args:[fake],timeoutMs:1000});
    await assert.rejects(()=>manager.connect('hang'),/timed out/i);
    const pid=Number(await fs.readFile(pidFile,'utf8'));
    await new Promise((resolve)=>setTimeout(resolve,100));
    let alive=true; try { process.kill(pid,0); } catch { alive=false; }
    assert.equal(alive,false,'failed MCP child should be terminated');
    const snapshot=await manager.snapshot();
    assert.equal(snapshot.servers.find((item)=>item.id==='hang')?.status,'error');
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('MCP disconnect kills descendant stdio processes and blocks stale agent resources/prompts', { skip: process.platform === 'win32' }, async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const childPidFile=path.join(root,'child.pid'); const fake=path.join(root,'tree-mcp.mjs');
  await fs.writeFile(fake, `import readline from 'node:readline'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';\nconst kid=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{detached:false,stdio:'ignore'}); writeFileSync(${JSON.stringify(childPidFile)},String(kid.pid));\nconst rl=readline.createInterface({input:process.stdin}); const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n'); rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return};if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{resources:{},prompts:{}}};else if(m.method==='tools/list')result={tools:[]};else if(m.method==='resources/list')result={resources:[{uri:'memory://stale',name:'Stale'}]};else if(m.method==='prompts/list')result={prompts:[{name:'stale'}]};else return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});send({jsonrpc:'2.0',id:m.id,result});});\n`);
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'tree',transport:'stdio',command:process.execPath,args:[fake],exposeToPi:true});
    await manager.connect('tree');
    const kid=Number(await fs.readFile(childPidFile,'utf8'));
    assert.equal((await manager.agentResources('tree'))[0].uri,'memory://stale');
    assert.equal((await manager.agentPrompts('tree'))[0].name,'stale');
    await manager.disconnect('tree');
    let running=true; for(let i=0;i<40;i++){try{const stat=await fs.readFile(`/proc/${kid}/stat`,'utf8');const state=stat.split(' ')[2];running=state!=='Z';}catch{running=false;}if(!running)break;await new Promise((resolve)=>setTimeout(resolve,50));}
    assert.equal(running,false,'MCP descendant should be terminated or reaped');
    await assert.rejects(()=>manager.agentResources('tree'),/not exposed/i);
    await assert.rejects(()=>manager.agentPrompts('tree'),/not exposed/i);
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('concurrent MCP server mutations serialize without lost servers', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const manager=new McpManager({storePath});
  try {
    await Promise.all([
      manager.saveServer({id:'race-a',transport:'stdio',command:'a'}),
      manager.saveServer({id:'race-b',transport:'stdio',command:'b'})
    ]);
    assert.deepEqual((await manager.load()).servers.map((item)=>item.id).sort(),['race-a','race-b']);
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('concurrent MCP connects serialize per server and do not orphan the first stdio process', { skip: process.platform === 'win32' }, async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const pidFile=path.join(root,'pids.txt'); const fake=path.join(root,'double-connect.mjs');
  await fs.writeFile(fake, `import readline from 'node:readline'; import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(pidFile)},String(process.pid)+'\\n'); const rl=readline.createInterface({input:process.stdin}); const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n'); rl.on('line',(line)=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{}};else if(m.method==='tools/list')result={tools:[]};else if(m.method==='resources/list')result={resources:[]};else if(m.method==='prompts/list')result={prompts:[]};send({jsonrpc:'2.0',id:m.id,result});});`);
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'double',transport:'stdio',command:process.execPath,args:[fake]});
    await Promise.all([manager.connect('double'),manager.connect('double')]);
    const pids=(await fs.readFile(pidFile,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); assert.equal(pids.length,2);
    const state=async(pid)=>{try{return (await fs.readFile(`/proc/${pid}/stat`,'utf8')).split(' ')[2];}catch{return'gone';}};
    assert.ok(['gone','Z'].includes(await state(pids[0])),'first connection process should already be gone/reaped');
    assert.ok(!['gone','Z'].includes(await state(pids[1])),'second connection should remain active');
    await manager.dispose(); let final='';for(let i=0;i<30;i++){final=await state(pids[1]);if(['gone','Z'].includes(final))break;await new Promise((resolve)=>setTimeout(resolve,50));}assert.ok(['gone','Z'].includes(final),'tracked connection should be stopped by dispose');
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});


test('MCP mutation refuses to overwrite a corrupt server store', async () => {
  const root=await tempRoot();const storePath=path.join(root,'mcp.json');const raw='{"servers":[ BROKEN';await fs.writeFile(storePath,raw);const manager=new McpManager({storePath});
  try { await assert.rejects(()=>manager.saveServer({id:'safe',transport:'stdio',command:'pi'}),(error)=>error?.code==='JSON_STORE_CORRUPT');assert.equal(await fs.readFile(storePath,'utf8'),raw); }
  finally { await manager.dispose();await fs.rm(root,{recursive:true,force:true}); }
});

test('unexpected MCP stdio exit immediately clears cached exposure and reports error', async () => {
  const root=await tempRoot(); const storePath=path.join(root,'mcp.json'); const fake=path.join(root,'exit-after-connect.mjs');
  await fs.writeFile(fake, `import readline from 'node:readline';\nconst rl=readline.createInterface({input:process.stdin});const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');let listed=0;rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return};if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{}};else if(m.method==='tools/list'){result={tools:[{name:'ephemeral',inputSchema:{type:'object',properties:{}}}]};listed++;}else if(m.method==='resources/list')result={resources:[{uri:'memory://ephemeral'}]};else if(m.method==='prompts/list')result={prompts:[{name:'ephemeral'}]};else return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});send({jsonrpc:'2.0',id:m.id,result});if(listed&&m.method==='prompts/list')setTimeout(()=>process.exit(0),80);});\n`);
  const manager=new McpManager({storePath});
  try {
    await manager.saveServer({id:'ephemeral',transport:'stdio',command:process.execPath,args:[fake],exposeToPi:true});
    const connected=await manager.connect('ephemeral');
    assert.equal(connected.status,'connected');
    assert.equal((await manager.agentTools())[0].active,true);
    let snapshot;
    for(let i=0;i<40;i++){snapshot=await manager.snapshot();if(snapshot.servers[0]?.status==='error')break;await new Promise((resolve)=>setTimeout(resolve,25));}
    const server=snapshot.servers.find((item)=>item.id==='ephemeral');
    assert.equal(server.status,'error');
    assert.deepEqual(server.tools,[]);
    assert.deepEqual(server.resources,[]);
    assert.deepEqual(server.prompts,[]);
    assert.equal((await manager.agentTools()).length,0);
  } finally { await manager.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('MCP disposal aborts a connection that is still initializing', async () => {
  const root = await tempRoot(); const storePath = path.join(root, 'mcp.json');
  let signalFirstFetch;
  const firstFetchSeen = new Promise((resolve) => { signalFirstFetch = resolve; });
  const fetchImpl = async (_url, options = {}) => {
    signalFirstFetch();
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
    });
  };
  const manager = new McpManager({ storePath, fetchImpl });
  try {
    await manager.saveServer({ id: 'slow', transport: 'http', url: 'http://127.0.0.1:65530/mcp' });
    const connecting = manager.connect('slow');
    await firstFetchSeen;
    await manager.dispose();
    await assert.rejects(connecting, /closed|abort/i);
    assert.notEqual((await manager.snapshot()).servers[0].status, 'connected');
  } finally { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
