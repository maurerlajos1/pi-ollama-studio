import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewPanel } from '../public/preview-panel.js';

class FakeClassList {
  constructor(values=[]){ this.values=new Set(values); }
  contains(value){ return this.values.has(value); }
  toggle(value, force){ const on=force===undefined?!this.values.has(value):Boolean(force); if(on)this.values.add(value);else this.values.delete(value); return on; }
}
class FakeNode {
  constructor(classes=[]){ this.value='';this.textContent='';this.disabled=false;this.dataset={};this.src='';this.listeners={};this.classList=new FakeClassList(classes); }
  addEventListener(type, fn){ this.listeners[type]=fn; }
  removeAttribute(name){ if(name==='src')this.src=''; }
}

test('Preview controller syncs main/editor frames and toggles side-by-side editor preview', async () => {
  const ids=['previewCommand','previewUrl','previewStatus','editorPreviewStatus','previewFrame','editorPreviewFrame','previewOpenExternal','previewLogs','previewStart','previewStop','previewRestart','previewSave','previewRefresh','editorPreviewRefresh','togglePreviewSplit','editorPreviewClose','editorPreviewLayout','editorPreviewPane'];
  const nodes=Object.fromEntries(ids.map((id)=>[id,new FakeNode(id==='editorPreviewPane'?['hidden']:[])]));
  const root={
    querySelector(selector){ return nodes[selector.replace(/^#/,'')]||null; },
    querySelectorAll(selector){ if(selector==='#previewFrame,#editorPreviewFrame')return [nodes.previewFrame,nodes.editorPreviewFrame]; return []; }
  };
  const oldWindow=globalThis.window, oldRaf=globalThis.requestAnimationFrame;
  globalThis.window={dispatchEvent(){},open(){}}; globalThis.requestAnimationFrame=(fn)=>fn();
  try {
    const panel=createPreviewPanel({root,getWorkspace:()=>'/tmp/project',api:async()=>({config:{command:'npm run dev',url:'http://127.0.0.1:5173/',autoOpen:true},preview:{status:'running',pid:123,url:'http://127.0.0.1:5173/',logs:[]}}),post:async()=>({}),put:async()=>({}),toast(){}});
    await panel.refresh();
    assert.equal(nodes.previewFrame.src,'http://127.0.0.1:5173/');
    assert.equal(nodes.editorPreviewFrame.src,'http://127.0.0.1:5173/');
    assert.match(nodes.editorPreviewStatus.textContent,/running/);
    assert.equal(nodes.previewStart.disabled,true,'Start must be disabled while Preview is running');
    assert.equal(nodes.previewRestart.disabled,false);
    assert.equal(nodes.previewStop.disabled,false);
    assert.equal(nodes.previewRefresh.disabled,false);
    assert.equal(await panel.toggleEditorSplit(true),true);
    assert.equal(nodes.editorPreviewPane.classList.contains('hidden'),false);
    assert.equal(nodes.editorPreviewLayout.classList.contains('with-preview'),true);
    assert.equal(await panel.toggleEditorSplit(false),false);
    assert.equal(nodes.editorPreviewPane.classList.contains('hidden'),true);
    assert.equal(nodes.editorPreviewLayout.classList.contains('with-preview'),false);
  } finally {
    globalThis.window=oldWindow; globalThis.requestAnimationFrame=oldRaf;
  }
});

test('Preview controller discards a late refresh from the previous workspace generation', async () => {
  const ids=['previewCommand','previewUrl','previewStatus','editorPreviewStatus','previewFrame','editorPreviewFrame','previewOpenExternal','previewLogs','previewStart','previewStop','previewRestart','previewSave','previewRefresh','editorPreviewRefresh','togglePreviewSplit','editorPreviewClose'];
  const nodes=Object.fromEntries(ids.map((id)=>[id,new FakeNode()]));
  const root={querySelector(selector){return nodes[selector.replace(/^#/,'')]||null;},querySelectorAll(selector){if(selector==='#previewFrame,#editorPreviewFrame')return[nodes.previewFrame,nodes.editorPreviewFrame];return[];}};
  let workspace='/tmp/a', epoch=1, resolveApi;
  const pending=new Promise((resolve)=>{resolveApi=resolve;});
  const panel=createPreviewPanel({root,getWorkspace:()=>workspace,getWorkspaceEpoch:()=>epoch,api:()=>pending,post:async()=>({}),put:async()=>({}),toast(){}});
  const refresh=panel.refresh();
  workspace='/tmp/b'; epoch=2;
  resolveApi({config:{url:'http://127.0.0.1:9000/'},preview:{status:'running',url:'http://127.0.0.1:9000/',logs:[]}});
  await refresh;
  assert.notEqual(nodes.previewFrame.src,'http://127.0.0.1:9000/');
  assert.notEqual(panel.state.preview?.url,'http://127.0.0.1:9000/');
});

test('Preview controller discards a late Start response from the previous workspace generation', async () => {
  const ids=['previewCommand','previewUrl','previewStatus','editorPreviewStatus','previewFrame','editorPreviewFrame','previewOpenExternal','previewLogs','previewStart','previewStop','previewRestart','previewSave','previewRefresh','editorPreviewRefresh','togglePreviewSplit','editorPreviewClose'];
  const nodes=Object.fromEntries(ids.map((id)=>[id,new FakeNode()]));
  nodes.previewCommand.value='npm run dev';
  const root={querySelector(selector){return nodes[selector.replace(/^#/,'')]||null;},querySelectorAll(selector){if(selector==='#previewFrame,#editorPreviewFrame')return[nodes.previewFrame,nodes.editorPreviewFrame];return[];}};
  let workspace='/tmp/a', epoch=1, resolvePost;
  const pending=new Promise((resolve)=>{resolvePost=resolve;});
  const panel=createPreviewPanel({root,getWorkspace:()=>workspace,getWorkspaceEpoch:()=>epoch,api:async()=>({}),post:()=>pending,put:async()=>({}),toast(){}});
  const starting=panel.start();
  workspace='/tmp/b'; epoch=2;
  resolvePost({preview:{status:'running',url:'http://127.0.0.1:9000/',logs:[]}});
  await starting;
  assert.notEqual(nodes.previewFrame.src,'http://127.0.0.1:9000/');
  assert.notEqual(panel.state.preview?.url,'http://127.0.0.1:9000/');
});

test('Preview Start preserves an unsaved manual command after focus moves to the button', async () => {
  const ids=['previewCommand','previewUrl','previewStatus','editorPreviewStatus','previewFrame','editorPreviewFrame','previewOpenExternal','previewLogs','previewStart','previewStop','previewRestart','previewSave','previewRefresh','editorPreviewRefresh','togglePreviewSplit','editorPreviewClose'];
  const nodes=Object.fromEntries(ids.map((id)=>[id,new FakeNode()]));
  const root={activeElement:null,querySelector(selector){return nodes[selector.replace(/^#/,'')]||null;},querySelectorAll(selector){if(selector==='#previewFrame,#editorPreviewFrame')return[nodes.previewFrame,nodes.editorPreviewFrame];return[];}};
  let payload;
  const panel = createPreviewPanel({
    root,
    getWorkspace: () => 'C:/manual-preview',
    getWorkspaceEpoch: () => 1,
    api: async () => ({ config: { command: 'npm run dev', url: '' }, preview: { status: 'stopped', logs: [] } }),
    post: async (_url, body) => { payload = body; return { preview: { status: 'running', command: body.command, url: 'http://127.0.0.1:4173/', logs: [] } }; },
    put: async () => ({ config: {} })
  });
  await panel.refresh();
  nodes.previewCommand.value = 'node custom-preview.mjs';
  root.activeElement = nodes.previewStart;
  await panel.start();
  assert.equal(payload.command, 'node custom-preview.mjs');
  assert.equal(nodes.previewCommand.value, 'node custom-preview.mjs');
});
