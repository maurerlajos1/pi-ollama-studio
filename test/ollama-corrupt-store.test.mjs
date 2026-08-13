import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('saveProfiles refuses to overwrite corrupt profiles.json', async (t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-ollama-corrupt-'));
  process.env.PI_OLLAMA_STUDIO_DIR=root;
  const { APP_DIR }=await import(`../src/config.mjs?corrupt=${Date.now()}`);
  const file=path.join(APP_DIR,'profiles.json'); const raw='{"profiles":[ BROKEN'; await fs.mkdir(APP_DIR,{recursive:true}); await fs.writeFile(file,raw);
  const { saveProfiles }=await import(`../src/ollama.mjs?corrupt=${Date.now()}`);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await assert.rejects(()=>saveProfiles({profiles:[{id:'safe'}]}),(error)=>error?.code==='JSON_STORE_CORRUPT');
  assert.equal(await fs.readFile(file,'utf8'),raw);
});
