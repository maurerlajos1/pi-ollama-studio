import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configurePackageResources, fetchPackageDetails, inspectPackageSource, installedPackageView, packageIdentity, packageSource, runPiPackageAction, searchPiPackages } from '../src/pi-packages.mjs';

const jsonResponse=(value)=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>value});

test('Pi package source/version identity keeps explicit npm versions pinned without changing package identity',()=>{
  assert.equal(packageSource('pi-demo','1.2.3'),'npm:pi-demo@1.2.3');
  assert.equal(packageIdentity('npm:pi-demo@1.2.3'),'npm:pi-demo');
  assert.equal(packageIdentity('npm:@scope/demo@2.0.0'),'npm:@scope/demo');
  assert.equal(installedPackageView('npm:pi-demo@1.2.3','project',0).pinned,true);
});

test('npm-backed Pi marketplace hydrates manifests, versions and package trust metadata',async()=>{
  const fetchImpl=async(url)=>{
    if(String(url).includes('/-/v1/search'))return jsonResponse({objects:[{package:{name:'pi-demo',version:'2.0.0',description:'Demo',keywords:['pi-package']}}]});
    return jsonResponse({'dist-tags':{latest:'2.0.0'},versions:{'1.0.0':{name:'pi-demo',version:'1.0.0',keywords:['pi-package']},'2.0.0':{name:'pi-demo',version:'2.0.0',description:'Demo',keywords:['pi-package'],pi:{extensions:['extensions/*.ts'],skills:['skills']},dependencies:{leftpad:'1.0.0'},scripts:{postinstall:'node setup.js'},repository:{url:'git+https://github.com/x/pi-demo.git'}}}});
  };
  const results=await searchPiPackages('demo',{resourceType:'extensions',fetchImpl});
  assert.equal(results.length,1);assert.equal(results[0].latest,'2.0.0');assert.deepEqual(results[0].resources.extensions,['extensions/*.ts']);assert.equal(results[0].trust.hasInstallScripts,true);assert.equal(results[0].trust.dependencyCount,1);assert.deepEqual(results[0].versions,['2.0.0','1.0.0']);
  const detail=await fetchPackageDetails('pi-demo',{fetchImpl});assert.equal(detail.repository,'https://github.com/x/pi-demo');
  const oldDetail=await fetchPackageDetails('pi-demo',{version:'1.0.0',fetchImpl});assert.equal(oldDetail.version,'1.0.0');assert.deepEqual(oldDetail.resources.extensions,[]);assert.equal(oldDetail.trust.hasInstallScripts,false);
  await assert.rejects(()=>fetchPackageDetails('pi-demo',{version:'9.9.9',fetchImpl}),/version not found/i);
});

test('installed package resource controls write native Pi All/None/Custom filter semantics',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-packages-'));const workspace=path.join(root,'work');const agentDir=path.join(root,'agent');await fs.mkdir(path.join(workspace,'.pi'),{recursive:true});await fs.writeFile(path.join(workspace,'.pi','settings.json'),JSON.stringify({packages:['npm:pi-demo']}));
  try{let result=await configurePackageResources(workspace,{scope:'project',source:'npm:pi-demo',resources:{extensions:{mode:'none'},skills:{mode:'custom',patterns:['skills/a/**','!skills/a/old/**']},prompts:{mode:'all'}}},{agentDir});assert.deepEqual(result.package.extensions,[]);assert.deepEqual(result.package.skills,['skills/a/**','!skills/a/old/**']);assert.equal(Object.hasOwn(result.package,'prompts'),false);result=await configurePackageResources(workspace,{scope:'project',source:'npm:pi-demo',resources:{extensions:{mode:'all'},skills:{mode:'none'}}},{agentDir});assert.equal(Object.hasOwn(result.package,'extensions'),false);assert.deepEqual(result.package.skills,[]);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});

test('project-local package identities resolve relative to the project settings file', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-packages-local-'));
  const workspace=path.join(root,'work'); const agentDir=path.join(root,'agent');
  await fs.mkdir(path.join(workspace,'.pi'),{recursive:true});
  await fs.writeFile(path.join(workspace,'.pi','settings.json'),JSON.stringify({packages:['../shared-package']}));
  try {
    const result=await configurePackageResources(workspace,{scope:'project',source:'../shared-package',resources:{extensions:{mode:'none'}}},{agentDir});
    assert.deepEqual(result.package.extensions,[]);
    assert.equal(packageIdentity('../shared-package',path.join(workspace,'.pi')),packageIdentity(result.package.source,path.join(workspace,'.pi')));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('package actions use native Pi install/remove project scope and real update command', async () => {
  const calls=[]; const run=async(command,args,options)=>{calls.push({command,args,options});return{code:0,stdout:'ok',stderr:''};};
  await runPiPackageAction('install',{source:'npm:pi-demo',scope:'project',workspace:process.cwd()},{run});
  await runPiPackageAction('remove',{source:'npm:pi-demo',scope:'project',workspace:process.cwd()},{run});
  await runPiPackageAction('update',{source:'npm:pi-demo',scope:'project',workspace:process.cwd()},{run});
  assert.deepEqual(calls[0].args,['install','-l','--approve','npm:pi-demo']);
  assert.deepEqual(calls[1].args,['remove','-l','--approve','npm:pi-demo']);
  assert.deepEqual(calls[2].args,['update','npm:pi-demo']);
});


test('local package provenance hashes inspected source files and reports executable risk', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-package-provenance-'));
  const workspace=path.join(root,'work');const pkg=path.join(workspace,'pkg');await fs.mkdir(path.join(pkg,'extensions'),{recursive:true});
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'local-pi',version:'1.0.0',pi:{extensions:['extensions/*.mjs']},scripts:{postinstall:'node setup.mjs'},dependencies:{x:'1.0.0'}}));
  await fs.writeFile(path.join(pkg,'extensions','tool.mjs'),'export default () => {};\n');
  try { const value=await inspectPackageSource('./pkg',{workspace,scope:'project'});assert.equal(value.type,'local');assert.equal(value.verified,true);assert.equal(value.trust.hasExtensions,true);assert.equal(value.trust.hasInstallScripts,true);assert.equal(value.fileCount,2);assert.match(value.revision,/^[a-f0-9]{64}$/); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('Git package provenance records resolved HEAD without cloning package code', async () => {
  const calls=[];const run=async(command,args,opts)=>{calls.push({command,args,opts});return{code:0,stdout:'0123456789abcdef\tHEAD\n',stderr:''};};
  const value=await inspectPackageSource('https://example.test/repo.git',{run});
  assert.equal(value.type,'git');assert.equal(value.revision,'0123456789abcdef');assert.equal(value.verified,true);assert.deepEqual(calls[0].args,['ls-remote','https://example.test/repo.git','HEAD']);
});

test('package command timeout kills descendants and caps captured output', { skip: process.platform === 'win32' }, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-package-command-')); const pidFile=path.join(root,'kid.pid'); const script=path.join(root,'runner.mjs');
  await fs.writeFile(script, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const kid=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(kid.pid)); process.stdout.write('x'.repeat(20000)); setInterval(()=>{},1000);`);
  try {
    await assert.rejects(()=>import('../src/pi-packages.mjs').then(({__test})=>__test.runCommand(process.execPath,[script],{cwd:root,timeoutMs:250,maxOutputBytes:1024})),/timed out/i);
    const kid=Number(await fs.readFile(pidFile,'utf8')); let running=true;for(let i=0;i<40;i++){try{const stat=await fs.readFile(`/proc/${kid}/stat`,'utf8');running=stat.split(' ')[2]!=='Z';}catch{running=false;}if(!running)break;await new Promise((resolve)=>setTimeout(resolve,50));} assert.equal(running,false,'package command descendant should be terminated or reaped');
    const outScript=path.join(root,'out.mjs'); await fs.writeFile(outScript,`process.stdout.write('a'.repeat(5000));`); const {__test}=await import('../src/pi-packages.mjs'); const result=await __test.runCommand(process.execPath,[outScript],{cwd:root,maxOutputBytes:1000}); assert.ok(Buffer.byteLength(result.stdout)<=1000);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('concurrent package resource mutations preserve changes for separate packages', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-packages-race-')); const workspace=path.join(root,'work'); const agentDir=path.join(root,'agent');
  await fs.mkdir(path.join(workspace,'.pi'),{recursive:true}); await fs.writeFile(path.join(workspace,'.pi','settings.json'),JSON.stringify({packages:['npm:a','npm:b']}));
  try {
    await Promise.all([
      configurePackageResources(workspace,{scope:'project',source:'npm:a',resources:{extensions:{mode:'none'}}},{agentDir}),
      configurePackageResources(workspace,{scope:'project',source:'npm:b',resources:{skills:{mode:'none'}}},{agentDir})
    ]);
    const settings=JSON.parse(await fs.readFile(path.join(workspace,'.pi','settings.json'),'utf8'));
    const a=settings.packages.find((entry)=>(typeof entry==='string'?entry:entry.source)==='npm:a'); const b=settings.packages.find((entry)=>(typeof entry==='string'?entry:entry.source)==='npm:b');
    assert.deepEqual(a.extensions,[]); assert.deepEqual(b.skills,[]);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('marketplace version sorting follows SemVer precedence including prereleases', async () => {
  const fetchImpl=async()=>jsonResponse({'dist-tags':{latest:'1.0.0'},versions:{'1.0.0-beta.2':{name:'pi-semver',version:'1.0.0-beta.2'},'1.0.0':{name:'pi-semver',version:'1.0.0'},'1.0.0-beta.10':{name:'pi-semver',version:'1.0.0-beta.10'},'0.9.9':{name:'pi-semver',version:'0.9.9'}}});
  const detail=await fetchPackageDetails('pi-semver',{fetchImpl});
  assert.deepEqual(detail.versions,['1.0.0','1.0.0-beta.10','1.0.0-beta.2','0.9.9']);
});


test('package resource mutation preserves a corrupt Pi settings file', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-package-corrupt-'));const workspace=path.join(root,'work');const agentDir=path.join(root,'agent');await fs.mkdir(path.join(workspace,'.pi'),{recursive:true});const file=path.join(workspace,'.pi','settings.json');const raw='{"packages":[ BROKEN';await fs.writeFile(file,raw);
  try { await assert.rejects(()=>configurePackageResources(workspace,{scope:'project',source:'npm:a',resources:{extensions:{mode:'none'}}},{agentDir}),(error)=>error?.code==='JSON_STORE_CORRUPT');assert.equal(await fs.readFile(file,'utf8'),raw); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('marketplace rejects malformed npm search payloads and marks failed detail hydration unknown', async () => {
  await assert.rejects(()=>searchPiPackages('bad',{fetchImpl:async()=>jsonResponse({objects:{not:'an array'}})}),(error)=>error?.code==='NPM_REGISTRY_INVALID_RESPONSE'&&error?.statusCode===502);
  let calls=0;const fetchImpl=async(url)=>{calls++;if(String(url).includes('/-/v1/search'))return jsonResponse({objects:[{package:{name:'pi-unknown',version:'1.0.0',description:'Unknown',keywords:['pi-package']}}]});return {ok:false,status:500,json:async()=>({})};};
  const results=await searchPiPackages('unknown',{fetchImpl});assert.equal(results.length,1);assert.equal(results[0].inspectionUnknown,true);assert.equal(results[0].trust.unknown,true);assert.equal(results[0].trust.hasInstallScripts,null);assert.match(results[0].inspectionError,/npm registry 500/i);
});

test('local package provenance downgrades verification when content is symlinked or unhashed', async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-package-symlink-trust-'));
  const workspace=path.join(root,'work');const pkg=path.join(workspace,'pkg');const outside=path.join(root,'outside.mjs');
  await fs.mkdir(path.join(pkg,'extensions'),{recursive:true});
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'linked-pi',pi:{extensions:['extensions/*.mjs']}}));
  await fs.writeFile(outside,'export default () => {};\n');
  try {
    try { await fs.symlink(outside,path.join(pkg,'extensions','tool.mjs'),'file'); }
    catch(error){ if(error?.code==='EPERM'||error?.code==='EACCES'||error?.code==='EISDIR'){t.skip('file symlink creation unavailable on this Windows filesystem');return;} throw error; }
    const value=await inspectPackageSource('./pkg',{workspace,scope:'project'});
    assert.equal(value.verified,false);
    assert.equal(value.trust.unverifiedContent,true);
    assert.equal(value.files.some((row)=>row.symlink===true&&row.hash===null),true);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('Git package provenance resolves the requested pinned ref and preserves scp-style SSH remotes', async () => {
  const calls=[];const run=async(command,args,opts)=>{calls.push({command,args,opts});return{code:0,stdout:'abcdef1234567890\trefs/tags/v1\n',stderr:''};};
  const pinned=await inspectPackageSource('git:https://example.test/repo.git@v1',{run});
  assert.equal(pinned.remote,'https://example.test/repo.git');
  assert.equal(pinned.requestedRef,'v1');
  assert.deepEqual(calls[0].args,['ls-remote','https://example.test/repo.git','v1']);
  calls.length=0;
  const ssh=await inspectPackageSource('git:git@github.com:user/repo@feature/foo',{run});
  assert.equal(ssh.remote,'git@github.com:user/repo');
  assert.equal(ssh.requestedRef,'feature/foo');
  assert.deepEqual(calls[0].args,['ls-remote','git@github.com:user/repo','feature/foo']);
});
