import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './config.mjs';
import { terminateProcessTree } from './process-tree.mjs';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(?:\/[^\s]*)?/ig;
const CONFIG_NAME = path.join('.pi', 'studio-preview.json');
const STATIC_PREVIEW_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'static-preview.mjs');
const STATIC_SCAN_IGNORES = new Set(['.git', '.pi', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt']);
function shellQuote(value=''){return `"${String(value).replace(/"/g, '\"')}"`;}

function stripAnsi(value=''){return String(value||'').replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,'');}
function isStudioStaticCommand(value='') {
  const normalized=String(value||'').replaceAll('"','').replaceAll('\\','/').toLowerCase();
  return normalized.includes(STATIC_PREVIEW_SCRIPT.replaceAll('\\','/').toLowerCase());
}
function cleanStaticEntry(value='') {
  const raw=String(value||'').trim();
  if(!raw)return '';
  if(path.isAbsolute(raw)||raw.includes('\0'))throw new Error('Invalid static Preview entry path');
  const parts=raw.replaceAll('\\','/').replace(/^\/+|\/+$/g,'').split('/').filter(Boolean);
  if(!parts.length||parts.some((part)=>part==='.'||part==='..'||part.includes(':')))throw new Error('Invalid static Preview entry path');
  return parts.join('/');
}
function staticEntryFromCommand(value='') {
  if(!isStudioStaticCommand(value))return '';
  const match=String(value||'').match(/(?:^|\s)--studio-entry=([^\s]+)/i);
  if(!match)return '';
  try{return cleanStaticEntry(decodeURIComponent(match[1]));}catch{return '';}
}

async function findSingleNestedIndex(root,maxDepth=2) {
  const matches=[];
  async function scan(dir,relative,depth) {
    if(depth>=maxDepth||matches.length>1)return;
    const entries=await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!entry.isDirectory()||STATIC_SCAN_IGNORES.has(entry.name)||entry.name.startsWith('.'))continue;
      const childRelative=relative?path.join(relative,entry.name):entry.name;
      const child=path.join(dir,entry.name);
      if(await fs.stat(path.join(child,'index.html')).then((stat)=>stat.isFile()).catch(()=>false))matches.push(childRelative.replaceAll('\\','/'));
      if(matches.length>1)return;
      await scan(child,childRelative,depth+1);
      if(matches.length>1)return;
    }
  }
  await scan(root,'',0);
  return matches.length===1?matches[0]:'';
}

function cleanUrl(value='') {
  const raw=String(value||'').trim(); if(!raw) return '';
  let url; try { url=new URL(raw); } catch { throw Object.assign(new Error('Preview URL must be a valid http(s) URL'),{statusCode:400}); }
  if(!['http:','https:'].includes(url.protocol)) throw Object.assign(new Error('Preview URL must use http(s)'),{statusCode:400});
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(['0.0.0.0','::','::1'].includes(host)) url.hostname='127.0.0.1';
  const normalizedHost=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['localhost','127.0.0.1','::1'].includes(normalizedHost)) throw Object.assign(new Error('Preview URL must use localhost/127.0.0.1/::1'),{statusCode:400});
  return url.toString();
}
function cleanCommand(value=''){const v=String(value||'').trim();if(!v)throw Object.assign(new Error('Preview command is required'),{statusCode:400});if(v.length>1000)throw Object.assign(new Error('Preview command is too long'),{statusCode:400});return v;}
export function previewConfigPath(workspace){return path.join(path.resolve(workspace),CONFIG_NAME);}

export async function suggestPreviewCommand(workspace){
  const root=path.resolve(workspace);let pkg={};try{pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));}catch{}
  const scripts=pkg?.scripts||{};for(const name of ['dev','preview','start'])if(scripts[name])return {command:`npm run ${name}`,source:`package.json#scripts.${name}`};
  if(await fs.stat(path.join(root,'vite.config.js')).catch(()=>null)||await fs.stat(path.join(root,'vite.config.ts')).catch(()=>null))return{command:'npx vite',source:'vite config'};
  if(await fs.stat(path.join(root,'angular.json')).catch(()=>null))return{command:'npx ng serve',source:'angular.json'};
  if(await fs.stat(path.join(root,'manage.py')).catch(()=>null))return{command:'python manage.py runserver 127.0.0.1:8000',source:'manage.py'};
  if(await fs.stat(path.join(root,'index.html')).then((stat)=>stat.isFile()).catch(()=>false))return{command:`${shellQuote(process.execPath)} ${shellQuote(STATIC_PREVIEW_SCRIPT)}`,source:'index.html · Studio static server'};
  const nestedEntry=await findSingleNestedIndex(root);
  if(nestedEntry)return{command:`${shellQuote(process.execPath)} ${shellQuote(STATIC_PREVIEW_SCRIPT)} --studio-entry=${encodeURIComponent(nestedEntry)}`,source:`${nestedEntry}/index.html · Studio static server`};
  return {command:'',source:''};
}

export async function loadPreviewConfig(workspace){try{const value=JSON.parse(await fs.readFile(previewConfigPath(workspace),'utf8'));return {command:String(value.command||''),url:value.url?cleanUrl(value.url):'',autoOpen:value.autoOpen!==false};}catch(error){if(error?.code==='ENOENT'||error instanceof SyntaxError)return {command:'',url:'',autoOpen:true};throw error;}}
export async function savePreviewConfig(workspace,input={}){const value={command:String(input.command||'').trim(),url:input.url?cleanUrl(input.url):'',autoOpen:input.autoOpen!==false};await writeJsonAtomic(previewConfigPath(workspace),value);return value;}
function now(){return new Date().toISOString();}
export class PreviewManager extends EventEmitter {
  constructor(){super();this.sessions=new Map();this.lifecycleQueues=new Map();}
  #serialize(workspace,task){const key=path.resolve(workspace);const prior=this.lifecycleQueues.get(key)||Promise.resolve();const current=prior.catch(()=>{}).then(task);this.lifecycleQueues.set(key,current);return current.finally(()=>{if(this.lifecycleQueues.get(key)===current)this.lifecycleQueues.delete(key);});}
  get(workspace){return this.sessions.get(path.resolve(workspace))||null;}
  snapshot(workspace){const s=this.get(workspace);return s?this.#public(s):{workspace:path.resolve(workspace),status:'stopped',command:'',url:'',pid:null,startedAt:null,exitedAt:null,exitCode:null,logs:[]};}
  async start(workspace,{command,url='',autoOpen=true}={}){
    const root=path.resolve(workspace);return this.#serialize(root,()=>this.#startUnlocked(root,{command,url,autoOpen}));
  }
  async #startUnlocked(root,{command,url='',autoOpen=true}={}){
    await fs.access(root);await this.#stopUnlocked(root).catch(()=>{});
    const config=await savePreviewConfig(root,{command:cleanCommand(command),url,autoOpen});
    const childOptions={cwd:root,env:{...process.env,FORCE_COLOR:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',maxBuffer:10*1024*1024};
    // Preview commands are deliberately shell command strings (npm scripts, framework
    // launchers, or a user-supplied command). On Windows, pass the complete command as
    // the spawn command with shell:true so Node lets cmd.exe parse its quoted executable
    // paths. The argument-based launchers for Pi/MCP/package actions continue using
    // prepareSpawn and never use this shell path.
    const staticEntry=staticEntryFromCommand(config.command);
    const child=isStudioStaticCommand(config.command)
      ? spawn(process.execPath,[STATIC_PREVIEW_SCRIPT,...(staticEntry?['--studio-entry',staticEntry]:[])],childOptions)
      : process.platform==='win32'
        ? spawn(config.command,{...childOptions,shell:true})
        : spawn(process.env.SHELL||'/bin/sh',['-lc',config.command],childOptions);
    const session={workspace:root,status:'starting',command:config.command,url:config.url,pid:child.pid,startedAt:now(),exitedAt:null,exitCode:null,process:child,logs:[],detectBuffers:{stdout:'',stderr:''}};this.sessions.set(root,session);
    const onData=(stream,chunk)=>{const text=String(chunk||'');session.logs.push({at:now(),stream,text});if(session.logs.length>250)session.logs.splice(0,session.logs.length-250);const detectText=stripAnsi(text);const scan=`${session.detectBuffers[stream]||''}${detectText}`.slice(-4096);session.detectBuffers[stream]=scan;const matches=scan.match(URL_RE)||[];if(!session.url&&matches.length){try{session.url=cleanUrl(matches[matches.length-1]);session.status='running';}catch{}}else if(session.status==='starting')session.status='running';this.emit('changed',this.#public(session));};
    child.stdout?.on('data',(c)=>onData('stdout',c));child.stderr?.on('data',(c)=>onData('stderr',c));
    child.once('error',(error)=>{session.status='error';session.logs.push({at:now(),stream:'error',text:error.message});this.emit('changed',this.#public(session));});
    child.once('exit',(code)=>{session.status='exited';session.exitCode=Number.isInteger(code)?code:null;session.exitedAt=now();this.emit('changed',this.#public(session));});
    this.emit('changed',this.#public(session));return this.#public(session);
  }
  async #stopUnlocked(root){const s=this.sessions.get(root);if(!s)return{ok:true,removed:false};if(!s.exitedAt)await terminateProcessTree(s.process).catch(()=>{});s.status='stopped';s.exitedAt=s.exitedAt||now();this.sessions.delete(root);this.emit('changed',this.#public(s));return{ok:true,removed:true};}
  async stop(workspace){const root=path.resolve(workspace);return this.#serialize(root,()=>this.#stopUnlocked(root));}
  async restart(workspace){const root=path.resolve(workspace);const config=await loadPreviewConfig(root);return this.#serialize(root,()=>this.#startUnlocked(root,config));}
  async dispose(){for(const key of [...this.sessions.keys()])await this.stop(key).catch(()=>{});}
  #public(s){return {workspace:s.workspace,status:s.status,command:s.command,url:s.url,pid:s.pid,startedAt:s.startedAt,exitedAt:s.exitedAt,exitCode:s.exitCode,logs:s.logs.slice(-100)};}
}
export const __test={cleanUrl,cleanCommand,stripAnsi,URL_RE,cleanStaticEntry,staticEntryFromCommand};
