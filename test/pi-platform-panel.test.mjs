import test from 'node:test';
import assert from 'node:assert/strict';
import { platformItems, platformResourceMeta, platformResourceTitle, platformSearchMatch } from '../public/pi-platform-panel.js';

test('Pi Platform frontend helpers preserve resource titles, search and package projection', () => {
  const snapshot={packages:[{source:'npm:demo@1.0.0',scope:'project',config:{source:'npm:demo@1.0.0'}}],skills:[{name:'review',scope:'project',description:'Review changes'}],settings:{global:{theme:'dark'},project:{packages:[]},effective:{theme:'dark'}}};
  const packages=platformItems(snapshot,'packages');
  assert.equal(packages[0].kind,'package');
  assert.equal(platformResourceTitle(packages[0]),'npm:demo@1.0.0');
  assert.match(platformResourceMeta(packages[0]),/project/);
  assert.equal(platformSearchMatch(snapshot.skills[0],'changes'),true);
  assert.equal(platformSearchMatch(snapshot.skills[0],'missing'),false);
  assert.equal(platformItems(snapshot,'settings').length,3);
});

import { createPiPlatformPanel } from '../public/pi-platform-panel.js';

function createPanelDom() {
  const nodes = new Map();
  const makeNode = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    classList: { toggle() {}, add() {}, remove() {} },
    append() {},
    appendChild() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML || ''; },
    value: '',
    readOnly: false,
    textContent: ''
  });
  return {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, makeNode());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    createElement: makeNode
  };
}

test('Pi Platform controller discards a late snapshot from the previous workspace generation', async () => {
  const state={snapshot:null,tab:'overview',selected:null,dirty:false};
  const root={querySelector(){return null;},querySelectorAll(){return[];},createElement(){return {classList:{toggle(){}},append(){}};}};
  let workspace='/tmp/a', epoch=1, resolveApi;
  const pending=new Promise((resolve)=>{resolveApi=resolve;});
  const panel=createPiPlatformPanel({root,state,getWorkspace:()=>workspace,getWorkspaceEpoch:()=>epoch,api:()=>pending,put:async()=>({}),post:async()=>({})});
  const load=panel.load({quiet:true});
  workspace='/tmp/b'; epoch=2;
  resolveApi({platform:{agentDir:'/tmp/a/.pi',counts:{skills:9}}});
  assert.equal(await load,null);
  assert.equal(state.snapshot,null);
});

test('Pi Platform controller preserves an editable draft during a refreshed snapshot', async () => {
  const root = createPanelDom();
  const state = { snapshot: { prompts: [], skills: [], contextFiles: [] }, tab: 'prompts', selected: null, dirty: false };
  const panel = createPiPlatformPanel({ root, state, getWorkspace: () => '/tmp/project', api: async () => ({ platform: { prompts: [] } }), put: async () => ({}), post: async () => ({}) });
  panel.selectItem({ kind: 'prompt', scope: 'project', name: 'draft', content: 'draft text', draft: true });
  panel.renderTab();
  assert.equal(state.selected?.draft, true);
  assert.equal(root.querySelector('#platformEditor').readOnly, false);
  assert.equal(root.querySelector('#platformEditor').value, 'draft text');
});

test('Pi Platform controller discards a late save response from the previous workspace generation', async () => {
  const root = createPanelDom();
  let workspace='/tmp/a', epoch=1, resolvePut, resourceChanges=0;
  const pending=new Promise((resolve)=>{resolvePut=resolve;});
  const selectedA={kind:'prompt',scope:'project',name:'a',content:'A'};
  const selectedB={kind:'prompt',scope:'project',name:'b',content:'B'};
  const snapshotB={prompts:[selectedB],skills:[],contextFiles:[]};
  const state={snapshot:{prompts:[selectedA]},tab:'prompts',selected:selectedA,dirty:true};
  root.querySelector('#platformEditor').value='changed A';
  const panel=createPiPlatformPanel({root,state,getWorkspace:()=>workspace,getWorkspaceEpoch:()=>epoch,api:async()=>({}),put:()=>pending,post:async()=>({}),onPiResourceChange:()=>{resourceChanges++;}});
  const saving=panel.saveSelected();
  workspace='/tmp/b'; epoch=2; state.snapshot=snapshotB; state.selected=selectedB;
  resolvePut({platform:{prompts:[{...selectedA,content:'changed A'}]}});
  await saving;
  assert.equal(state.snapshot,snapshotB);
  assert.equal(state.selected,selectedB);
  assert.equal(resourceChanges,0);
});
