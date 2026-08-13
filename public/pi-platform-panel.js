import { renderInstalledPackageControls } from './package-marketplace.js';

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

export function platformResourceTitle(item) {
  if (!item) return 'Select a resource';
  if (item.kind === 'settings') return `${item.scope[0].toUpperCase()}${item.scope.slice(1)} settings`;
  if (item.kind === 'package') return item.source || 'Pi package';
  return item.name || item.relativePath || item.path || 'Pi resource';
}

export function platformResourceMeta(item) {
  if (!item) return '';
  if (item.kind === 'package') return `${item.scope} · ${typeof item.config === 'string' ? item.config : JSON.stringify(item.config)}`;
  return [item.scope, item.origin, item.relativePath, item.estimatedTokens ? `~${Number(item.estimatedTokens).toLocaleString()} tokens` : ''].filter(Boolean).join(' · ');
}

export function platformSearchMatch(item, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [item?.name, item?.description, item?.path, item?.relativePath, item?.scope, item?.origin, item?.source, item?.kind]
    .some((value) => String(value || '').toLowerCase().includes(needle));
}

export function platformItems(snapshot, tab) {
  if (!snapshot) return [];
  if (tab === 'instructions') return snapshot.contextFiles || [];
  if (tab === 'skills') return snapshot.skills || [];
  if (tab === 'prompts') return snapshot.prompts || [];
  if (tab === 'extensions') return snapshot.extensions || [];
  if (tab === 'packages') return (snapshot.packages || []).map((item) => ({ ...item, kind: 'package', name: item.source }));
  if (tab === 'settings') return [
    { kind:'settings', scope:'global', name:'Global settings', path:snapshot.settings?.globalPath, content:JSON.stringify(snapshot.settings?.global || {}, null, 2) },
    { kind:'settings', scope:'project', name:'Project settings', path:snapshot.settings?.projectPath, content:JSON.stringify(snapshot.settings?.project || {}, null, 2) },
    { kind:'settings-effective', scope:'effective', name:'Effective settings', content:JSON.stringify(snapshot.settings?.effective || {}, null, 2) }
  ];
  return [];
}

export function createPiPlatformPanel({
  root = document,
  state,
  getWorkspace = () => '',
  getWorkspaceEpoch = () => 0,
  getResourceQuery = () => '',
  getPiStats = () => null,
  api,
  put,
  post,
  toast = () => {},
  renderPiResources = () => {},
  switchView = () => {},
  sendPrompt = () => {},
  getPackageMarketplace = () => null,
  isPiRunning = () => false,
  onPiResourceChange = () => {},
  getCommandCount = () => 0,
  loadCommands = async () => {}
}) {
  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  const formatNumber = (value) => Number(value || 0).toLocaleString();

  function activeQuery() { return String(getResourceQuery() || '').trim().toLowerCase(); }
  function items(tab = state.tab) { return platformItems(state.snapshot, tab); }
  function hasUnsavedChanges() { return Boolean(state.dirty); }
  function discardChanges() { state.dirty = false; }
  function confirmDiscardChanges() {
    if (!state.dirty) return true;
    const confirmFn = root.defaultView?.confirm || globalThis.confirm;
    return typeof confirmFn === 'function' && confirmFn('Discard unsaved Pi resource changes?');
  }

  function renderOverview() {
    const host = $('#platformOverview'); if (!host) return;
    const snapshot = state.snapshot; const workspace = getWorkspace();
    if (!workspace) { host.innerHTML = '<div class="empty-state">Open a workspace to inspect Pi resources and instruction hierarchy.</div>'; return; }
    if (!snapshot) { host.innerHTML = '<div class="empty-state">Loading Pi platform information…</div>'; return; }
    const counts = snapshot.counts || {}; const known = snapshot.contextEstimate?.combinedKnownTokens || 0; const active = Number(getPiStats()?.contextUsage?.tokens || 0);
    const ratio = active > 0 ? Math.min(100, Math.round((known / active) * 100)) : 0;
    const cards = [['Instructions',counts.contextFiles||0],['Skills',counts.skills||0],['Prompts',counts.prompts||0],['Extensions',counts.extensions||0],['Packages',counts.packages||0],['Settings',counts.settings||0]];
    host.innerHTML = `<div class="platform-summary-grid">${cards.map(([label,value])=>`<div class="platform-summary-card"><strong>${formatNumber(value)}</strong><span>${esc(label)}</span></div>`).join('')}</div>
      <div class="platform-context-card"><div><strong>Known persistent agent inputs</strong><div class="muted">~${formatNumber(known)} tokens from context files + discovered skill descriptions${active ? ` · current Pi context ${formatNumber(active)} tokens` : ''}</div></div><div class="platform-context-meter"><i style="width:${ratio}%"></i></div><span class="muted">${esc(snapshot.contextEstimate?.note || '')}</span></div>
      ${snapshot.trustSensitive ? '<div class="platform-warning">This project contains project-local Pi settings/resources. Pi only loads trusted project resources according to its project-trust rules. Extensions and packages can execute code with your user permissions; inspect them before enabling.</div>' : ''}
      <div class="platform-context-card"><strong>Resource roots</strong><code>${esc(snapshot.agentDir || '')}</code><code>${esc(`${workspace}/.pi`)}</code></div>`;
  }

  function listActionHtml(tab) {
    if (tab === 'prompts') return '<input id="platformNewName" placeholder="prompt-name"><button class="sm-btn" data-new-platform="prompt-project">+ Project Prompt</button><button class="sm-btn" data-new-platform="prompt-global">+ Global</button>';
    if (tab === 'skills') return '<input id="platformNewName" placeholder="skill-name"><button class="sm-btn" data-new-platform="skill-project">+ Project Skill</button><button class="sm-btn" data-new-platform="skill-global">+ Global</button>';
    if (tab === 'instructions') return '<button class="sm-btn" data-new-platform="context-project">+ Project AGENTS.md</button><button class="sm-btn" data-new-platform="append-project">+ APPEND_SYSTEM.md</button>';
    if (tab === 'settings') return '<span class="muted">Project values override global settings. Save writes valid JSON only.</span>';
    if (tab === 'extensions') return '<span class="muted">Extensions execute code.</span><button class="sm-btn" data-browse-packages="extensions">Browse Online Extensions</button>';
    if (tab === 'packages') return '<button class="sm-btn primary" data-browse-packages="">Browse Online</button><button class="sm-btn" data-browse-packages="skills">Browse Online Skills</button>';
    return '';
  }

  function bindListActions() {
    $$('[data-new-platform]').forEach((button) => { button.onclick = () => {
      const action = button.dataset.newPlatform; const rawName = $('#platformNewName')?.value?.trim() || '';
      if (!confirmDiscardChanges()) return;
      if (action.startsWith('prompt-')) {
        if (!rawName) return toast('Enter a prompt name first', 'error');
        selectItem({ kind:'prompt', scope:action.endsWith('global')?'global':'project', name:rawName, content:`---\ndescription: ${rawName.replace(/[-_]/g,' ')}\n---\n\nDescribe the reusable workflow here.\n`, draft:true });
      } else if (action.startsWith('skill-')) {
        if (!rawName) return toast('Enter a skill name first', 'error');
        selectItem({ kind:'skill', scope:action.endsWith('global')?'global':'project', name:rawName, content:`# ${rawName}\n\nDescribe when Pi should use this skill and the workflow it should follow.\n\n## Steps\n1. Inspect the task.\n2. Perform the workflow.\n3. Validate the result.\n`, draft:true });
      } else if (action === 'context-project') selectItem({ kind:'context', scope:'project', name:'AGENTS.md', content:'# Project Agent Guidelines\n\n- Describe project conventions, commands, architecture, and validation requirements here.\n', draft:true });
      else if (action === 'append-project') selectItem({ kind:'system-prompt', scope:'project', name:'APPEND_SYSTEM.md', content:'# Additional System Instructions\n\nAdd project-specific system guidance here.\n', draft:true });
    }; });
    $$('[data-browse-packages]').forEach((button) => { button.onclick = () => getPackageMarketplace()?.open(button.dataset.browsePackages || ''); });
  }

  function renderList() {
    const tab = state.tab; const host = $('#platformList'); if (!host) return;
    const actions = $('#platformListActions'); if (actions) { actions.innerHTML = listActionHtml(tab); bindListActions(); }
    const visible = items(tab).filter((item) => platformSearchMatch(item, activeQuery()));
    host.innerHTML = ''; host.classList.toggle('empty-state', !visible.length);
    for (const item of visible) {
      const row = root.createElement('button'); row.type='button'; row.className='platform-item';
      const selected = state.selected && platformResourceTitle(state.selected) === platformResourceTitle(item) && state.selected.scope === item.scope;
      row.classList.toggle('active', selected);
      row.innerHTML = `<div><strong>${esc(platformResourceTitle(item))}</strong><span>${esc(item.description || item.relativePath || item.path || '')}</span></div><span class="platform-scope ${esc(item.scope || '')}">${esc(item.scope || '')}</span>`;
      row.onclick = () => selectItem(item); host.append(row);
    }
    if (!visible.length) host.textContent = state.snapshot ? 'No matching resources.' : 'Load Pi platform information first.';
  }

  function editorActions(item) {
    const host = $('#platformDetailActions'); if (!host) return; host.innerHTML='';
    const add=(label,fn,cls='sm-btn')=>{const b=root.createElement('button');b.className=cls;b.textContent=label;b.onclick=fn;host.append(b);return b;};
    if (!item) return;
    const editable=['prompt','skill','context','system-prompt','settings'].includes(item.kind)&&['global','project'].includes(item.scope);
    if (editable) add('Save', saveSelected, 'sm-btn primary');
    if (item.kind === 'prompt') { add('Insert',()=>{ $('#composer').value=`/${item.name} `;switchView('chat');$('#composer').focus(); }); add('Run',()=>{ $('#composer').value=`/${item.name} `;switchView('chat');sendPrompt('prompt'); }); }
    if (item.kind === 'skill') { add('Insert',()=>{ $('#composer').value=`/skill:${item.name} `;switchView('chat');$('#composer').focus(); }); add('Run',()=>{ $('#composer').value=`/skill:${item.name} `;switchView('chat');sendPrompt('prompt'); }); }
    if (item.kind === 'package' && item.source) { add('Browse Online',()=>getPackageMarketplace()?.open('')); add('Copy install command',async()=>{await navigator.clipboard.writeText(`pi install ${item.scope==='project'?'-l ':''}${item.source}`);toast('Install command copied');}); }
  }

  function selectItem(item, { force = false } = {}) {
    const sameItem = state.selected === item || (state.selected && item && platformResourceTitle(state.selected) === platformResourceTitle(item) && state.selected.scope === item.scope);
    if (!force && sameItem && state.dirty) return true;
    if (!force && !sameItem && !confirmDiscardChanges()) return false;
    state.selected=item; state.dirty=false;
    const title=$('#platformDetailTitle'),meta=$('#platformDetailMeta'),editor=$('#platformEditor'),effective=$('#platformSettingsEffective'),note=$('#platformDetailNote');
    if(title)title.textContent=platformResourceTitle(item); if(meta)meta.textContent=platformResourceMeta(item);
    if(editor){editor.classList.remove('hidden');editor.value=item?.content ?? (item?.config?JSON.stringify(item.config,null,2):'');editor.readOnly=!(['prompt','skill','context','system-prompt','settings'].includes(item?.kind)&&['global','project'].includes(item?.scope));}
    effective?.classList.add('hidden');
    if(note){if(item?.kind==='extension')note.textContent='Read-only inspection. Pi extensions execute arbitrary TypeScript/JavaScript with your user permissions.';else if(item?.kind==='settings')note.textContent=`${item.scope} settings file · invalid JSON is rejected before writing.`;else if(item?.kind==='settings-effective')note.textContent='Merged preview only. Project settings override corresponding global values.';else if(item?.kind==='skill')note.textContent='Skills are instructions and may reference executable helper scripts. Review before use.';else note.textContent=item?.path||'';}
    if(item?.kind==='settings-effective'){editor?.classList.add('hidden');if(effective){effective.classList.remove('hidden');effective.textContent=item.content||'{}';}}
    editorActions(item);
    if(item?.kind==='package'&&note)renderInstalledPackageControls({root,host:note,item,put,post,toast,workspace:getWorkspace(),refreshPlatform:()=>load({quiet:true}),onPiResourceChange});
    renderList();
    return true;
  }

  async function saveSelected() {
    const item=state.selected, workspace=getWorkspace(), epoch=getWorkspaceEpoch();
    if(!item)return toast('Select a Pi resource first','error');
    if(!workspace)return toast('Open a workspace before saving project resources','error');
    const content=$('#platformEditor')?.value ?? '';
    try { let response;
      if(item.kind==='prompt')response=await put('/api/pi-platform/prompt',{workspace,scope:item.scope,name:item.name,content});
      else if(item.kind==='skill')response=await put('/api/pi-platform/skill',{workspace,scope:item.scope,name:item.name,content});
      else if(item.kind==='context'||item.kind==='system-prompt')response=await put('/api/pi-platform/context',{workspace,scope:item.scope,name:item.name,content});
      else if(item.kind==='settings'){let settings;try{settings=JSON.parse(content);}catch(error){throw new Error(`Invalid JSON: ${error.message}`);}response=await put('/api/pi-platform/settings',{workspace,scope:item.scope,settings});}
      else return;
      if(workspace!==getWorkspace()||epoch!==getWorkspaceEpoch()||state.selected!==item)return;
      state.snapshot=response.platform;state.selected=null;state.dirty=false;renderTab();onPiResourceChange(`Changed ${platformResourceTitle(item)}`);toast(`${platformResourceTitle(item)} saved`,'success');
    } catch(error){if(workspace===getWorkspace()&&epoch===getWorkspaceEpoch())toast(error.message,'error');}
  }

  function renderTab() {
    const tab=state.tab||'overview';
    $$('#platformTabBar button').forEach((button)=>button.classList.toggle('active',button.dataset.platformTab===tab));
    const overview=$('#platformOverview'),workspacePanel=$('#platformWorkspace'),commands=$('#commandResourcePanel');
    overview?.classList.toggle('hidden',tab!=='overview'); workspacePanel?.classList.toggle('hidden',['overview','commands'].includes(tab)); commands?.classList.toggle('hidden',tab!=='commands');
    if(tab==='overview')renderOverview(); else if(tab==='commands')renderPiResources(); else {
      renderList();
      const current=items(tab);
      // A platform_changed SSE event can refresh the snapshot immediately after
      // the user creates a new draft. Keep that draft selected and editable;
      // otherwise the refresh silently replaces it with the first read-only
      // resource and the next keystroke fails or edits the wrong file.
      const draft=state.selected?.draft && state.selected;
      const draftBelongsToTab=draft && ((tab==='prompts'&&draft.kind==='prompt') || (tab==='skills'&&draft.kind==='skill') || (tab==='instructions'&&['context','system-prompt'].includes(draft.kind)));
      if (draftBelongsToTab) selectItem(draft, { force: true });
      else if(!state.dirty&&(!state.selected||!current.some((item)=>platformResourceTitle(item)===platformResourceTitle(state.selected)&&item.scope===state.selected.scope))) selectItem(current[0]||null, { force: true });
    }
  }

  async function load({quiet=false}={}) {
    const workspace=getWorkspace(), epoch=getWorkspaceEpoch(); if(!workspace){state.snapshot=null;renderTab();return null;}
    try {
      const value=await api(`/api/pi-platform?workspace=${encodeURIComponent(workspace)}`);
      if(workspace!==getWorkspace()||epoch!==getWorkspaceEpoch())return null;
      state.snapshot=value.platform;renderTab();return value.platform;
    }catch(error){if(workspace!==getWorkspace()||epoch!==getWorkspaceEpoch())return null;if(!quiet)toast(error.message,'error');throw error;}
  }

  function bind() {
    $$('#platformTabBar button').forEach((button)=>button.addEventListener('click',()=>{
      const nextTab=button.dataset.platformTab||'overview';
      if(nextTab!==state.tab&&!confirmDiscardChanges())return;
      state.tab=nextTab;state.selected=null;state.dirty=false;renderTab();if(state.tab==='commands'&&isPiRunning()&&!getCommandCount())loadCommands().catch(()=>{});
    }));
    $('#platformEditor')?.addEventListener('input',()=>{state.dirty=true;const title=$('#platformDetailTitle');if(title&&!title.textContent.endsWith(' •'))title.textContent+=' •';});
  }

  bind();
  return { load, renderTab, selectItem, saveSelected, items, resourceTitle:platformResourceTitle, renderOverview, renderList, hasUnsavedChanges, discardChanges };
}
