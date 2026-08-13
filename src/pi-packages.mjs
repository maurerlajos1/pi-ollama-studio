import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { PI_AGENT_DIR, readConfig, readJson, readJsonStrict, serializeMutation, writeJsonAtomic } from './config.mjs';
import { terminateProcessTree } from './process-tree.mjs';
import { prepareSpawn } from './spawn-command.mjs';

const DEFAULT_REGISTRY='https://registry.npmjs.org';
function packageRegistry(){return String(process.env.PI_STUDIO_PI_PACKAGE_REGISTRY||DEFAULT_REGISTRY).replace(/\/+$/,'');}
const RESOURCE_KEYS=['extensions','skills','prompts','themes'];
function cleanScope(scope){if(!['global','project'].includes(scope))throw Object.assign(new Error('Package scope must be global or project'),{statusCode:400});return scope;}
export function packageSource(name,version=''){const n=String(name||'').trim();if(!n)throw Object.assign(new Error('Package name is required'),{statusCode:400});return `npm:${n}${String(version||'').trim()?`@${String(version).trim()}`:''}`;}
export function packageIdentity(source,baseDir=process.cwd()){const raw=String(source||'').trim();if(raw.startsWith('npm:')){const spec=raw.slice(4);if(spec.startsWith('@')){const slash=spec.indexOf('/');const at=spec.indexOf('@',slash+1);return `npm:${at>0?spec.slice(0,at):spec}`;}const at=spec.lastIndexOf('@');return `npm:${at>0?spec.slice(0,at):spec}`;}if(raw.startsWith('git:')||/^(https?|ssh|git):\/\//.test(raw)){const noPrefix=raw.replace(/^git:/,'');return `git:${noPrefix.replace(/@[^/@]+$/,'')}`;}const absolute=path.resolve(baseDir,raw);return `local:${absolute}`;}
function npmNameFromSource(source){const identity=packageIdentity(source);return identity.startsWith('npm:')?identity.slice(4):'';}
function normalizeRepo(repo){if(typeof repo==='string')return repo;if(repo?.url)return String(repo.url).replace(/^git\+/,'').replace(/\.git$/,'');return '';}
function resourcesFromManifest(pkg={}){const pi=pkg.pi&&typeof pkg.pi==='object'?pkg.pi:{};return Object.fromEntries(RESOURCE_KEYS.map((key)=>[key,Array.isArray(pi[key])?pi[key].map(String):[]]));}
function canonicalPathEqual(a,b){const left=path.resolve(String(a||''));const right=path.resolve(String(b||''));return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;}
function parseSemver(value){const match=String(value||'').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);if(!match)return null;return{major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3]),pre:match[4]?match[4].split('.'):[]};}
function comparePrereleaseDesc(a,b){if(!a.length&&!b.length)return 0;if(!a.length)return-1;if(!b.length)return 1;for(let i=0;i<Math.max(a.length,b.length);i++){if(i>=a.length)return 1;if(i>=b.length)return-1;const x=a[i],y=b[i];if(x===y)continue;const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return Number(y)-Number(x);if(xn!==yn)return xn?1:-1;return String(y).localeCompare(String(x));}return 0;}
function compareVersions(a,b){const A=parseSemver(a),B=parseSemver(b);if(A&&B){for(const key of ['major','minor','patch'])if(A[key]!==B[key])return B[key]-A[key];return comparePrereleaseDesc(A.pre,B.pre);}if(A)return-1;if(B)return 1;return String(b).localeCompare(String(a),undefined,{numeric:true,sensitivity:'base'});}
function packageDetail(packument,name,requestedVersion=''){const versions=Object.keys(packument?.versions||{}).sort(compareVersions);const latest=packument?.['dist-tags']?.latest||versions[0]||'';const selected=String(requestedVersion||'').trim();const version=selected&&packument?.versions?.[selected]?selected:latest;const pkg=packument?.versions?.[version]||{};const keywords=Array.isArray(pkg.keywords)?pkg.keywords:Array.isArray(packument?.keywords)?packument.keywords:[];const scripts=pkg.scripts&&typeof pkg.scripts==='object'?pkg.scripts:{};const installScriptKeys=['preinstall','install','postinstall','prepare'];const resources=resourcesFromManifest(pkg);const dist=pkg.dist&&typeof pkg.dist==='object'?pkg.dist:{};return {name:pkg.name||name,version,description:pkg.description||packument?.description||'',keywords,pi:pkg.pi||{},resources,repository:normalizeRepo(pkg.repository||packument?.repository),homepage:pkg.homepage||packument?.homepage||'',license:pkg.license||packument?.license||'',versions:versions.slice(0,100),latest,distTags:packument?.['dist-tags']||{},publishedAt:packument?.time?.[version]||null,integrity:dist.integrity||'',shasum:dist.shasum||'',tarball:dist.tarball||'',dependencies:Object.keys(pkg.dependencies||{}),peerDependencies:Object.keys(pkg.peerDependencies||{}),scripts,trust:{hasInstallScripts:installScriptKeys.some((key)=>Boolean(scripts[key])),installScripts:Object.fromEntries(installScriptKeys.filter((key)=>scripts[key]).map((key)=>[key,scripts[key]])),dependencyCount:Object.keys(pkg.dependencies||{}).length,hasExtensions:(resources.extensions||[]).length>0}};}
async function fetchJson(url,{fetchImpl=fetch,timeoutMs=12000}={}){const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeoutMs);try{const response=await fetchImpl(url,{headers:{accept:'application/json'},signal:ctrl.signal});if(!response.ok)throw new Error(`npm registry ${response.status}`);return await response.json();}finally{clearTimeout(timer);}}
export async function fetchPackageDetails(name,{version='',fetchImpl=fetch}={}){const clean=String(name||'').trim();if(!clean)throw Object.assign(new Error('Package name is required'),{statusCode:400});const url=`${packageRegistry()}/${encodeURIComponent(clean).replace('%40','@')}`;const packument=await fetchJson(url,{fetchImpl});if(version&&!packument?.versions?.[version])throw Object.assign(new Error(`Package version not found: ${clean}@${version}`),{statusCode:404});return packageDetail(packument,clean,version);}
export async function searchPiPackages(query='',{resourceType='',limit=20,fetchImpl=fetch}={}){const size=Math.max(1,Math.min(30,Number(limit||20)));const text=`keywords:pi-package ${String(query||'').trim()}`.trim();const data=await fetchJson(`${packageRegistry()}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`,{fetchImpl});if(!Array.isArray(data?.objects))throw Object.assign(new Error('npm registry search returned an invalid package list'),{statusCode:502,code:'NPM_REGISTRY_INVALID_RESPONSE'});const candidates=data.objects.map((row)=>row?.package).filter((pkg)=>pkg&&Array.isArray(pkg.keywords)&&pkg.keywords.includes('pi-package')).slice(0,size);const details=await Promise.all(candidates.map((pkg)=>fetchPackageDetails(pkg.name,{fetchImpl}).catch((error)=>({name:pkg.name,version:pkg.version,description:pkg.description||'',keywords:pkg.keywords||[],pi:{},resources:{extensions:[],skills:[],prompts:[],themes:[]},repository:normalizeRepo(pkg.links?.repository||''),homepage:pkg.links?.homepage||'',versions:pkg.version?[pkg.version]:[],latest:pkg.version||'',distTags:pkg.version?{latest:pkg.version}:{},dependencies:[],peerDependencies:[],scripts:{},inspectionError:String(error?.message||error),inspectionUnknown:true,trust:{unknown:true,hasInstallScripts:null,installScripts:{},dependencyCount:null,hasExtensions:null}}))));const key=RESOURCE_KEYS.includes(resourceType)?resourceType:'';return key?details.filter((item)=>(item.resources?.[key]||[]).length>0):details;}

function runCommand(command,args,{cwd,env=process.env,timeoutMs=120000,maxOutputBytes=5*1024*1024}={}){return new Promise((resolve,reject)=>{const prepared=prepareSpawn(command,args,{cwd,env});const child=spawn(prepared.command,prepared.args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',...prepared.options});let stdout='',stderr='',settled=false,timingOut=false;const append=(current,chunk)=>{const next=current+String(chunk);return Buffer.byteLength(next)>maxOutputBytes?next.slice(-maxOutputBytes):next;};const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};const timer=setTimeout(async()=>{timingOut=true;await terminateProcessTree(child).catch(()=>{});finish(reject,new Error(`Command timed out: ${command} ${args.join(' ')}`));},timeoutMs);child.stdout.on('data',(c)=>stdout=append(stdout,c));child.stderr.on('data',(c)=>stderr=append(stderr,c));child.once('error',(e)=>{if(!timingOut)finish(reject,e);});child.once('exit',(code)=>{if(timingOut)return;if(code===0)finish(resolve,{code,stdout,stderr});else finish(reject,Object.assign(new Error(stderr.trim()||stdout.trim()||`${command} exited with code ${code}`),{code,stdout,stderr}));});});}
export async function runPiPackageAction(action,{source,scope='global',workspace='',version=''},{run=runCommand}={}){scope=cleanScope(scope);let resolved=String(source||'').trim();if(version&&resolved.startsWith('npm:'))resolved=packageSource(npmNameFromSource(resolved),version);if(!resolved)throw Object.assign(new Error('Package source is required'),{statusCode:400});const cfg=await readConfig();const cwd=scope==='project'?path.resolve(workspace||''):process.cwd();if(scope==='project'&&!workspace)throw Object.assign(new Error('Workspace is required for project packages'),{statusCode:400});let args;if(action==='install')args=['install',...(scope==='project'?['-l','--approve']:[]),resolved];else if(action==='update')args=['update',resolved];else if(action==='remove')args=['remove',...(scope==='project'?['-l','--approve']:[]),resolved];else throw new Error(`Unsupported package action: ${action}`);const result=await run(cfg.piCommand,args,{cwd,env:{...process.env,GIT_TERMINAL_PROMPT:process.env.GIT_TERMINAL_PROMPT||'0'}});return {...result,action,scope,source:resolved};}
function settingsPath(workspace,scope,agentDir=PI_AGENT_DIR){return scope==='global'?path.join(agentDir,'settings.json'):path.join(path.resolve(workspace),'.pi','settings.json');}
export async function configurePackageResources(workspace,{scope='project',source,resources={}},{agentDir=PI_AGENT_DIR}={}){scope=cleanScope(scope);if(scope==='project'&&!workspace)throw Object.assign(new Error('Workspace is required for project packages'),{statusCode:400});const file=settingsPath(workspace,scope,agentDir);return serializeMutation(file,async()=>{const settings=await readJsonStrict(file,{});if(!Array.isArray(settings.packages))settings.packages=[];const packageBase=scope==='project'?path.dirname(file):agentDir;const identity=packageIdentity(source,packageBase);let index=settings.packages.findIndex((entry)=>packageIdentity(typeof entry==='string'?entry:entry?.source,packageBase)===identity);if(index<0)throw Object.assign(new Error('Installed package was not found in Pi settings'),{statusCode:404});const current=settings.packages[index];const entry=typeof current==='string'?{source:current}:{...current};for(const key of RESOURCE_KEYS){const config=resources[key];if(config==null||config.mode==='all'){delete entry[key];continue;}if(config.mode==='none'){entry[key]=[];continue;}if(config.mode==='custom'){if(!Array.isArray(config.patterns))throw Object.assign(new Error(`${key} custom patterns must be an array`),{statusCode:400});entry[key]=config.patterns.map(String).map((v)=>v.trim()).filter(Boolean);continue;}if(Array.isArray(config))entry[key]=config.map(String);}
settings.packages[index]=entry;await writeJsonAtomic(file,settings);return{scope,path:file,package:entry,settings};});}
export function installedPackageView(entry,scope,index){const config=typeof entry==='string'?{source:entry}:{...entry};const filters={};for(const key of RESOURCE_KEYS){filters[key]=Object.prototype.hasOwnProperty.call(config,key)?(Array.isArray(config[key])?(config[key].length?{mode:'custom',patterns:config[key]}:{mode:'none',patterns:[]}):{mode:'all',patterns:[]}):{mode:'all',patterns:[]};}return{scope,index,source:config.source,identity:packageIdentity(config.source),pinned:/^npm:.+@[^/]+$/.test(config.source)||/^git:.+@[^/]+$/.test(config.source),autoload:config.autoload!==false,filters,config};}
export function listInstalledPackagesFromSettings(globalSettings={},projectSettings={}){return[...(globalSettings.packages||[]).map((e,i)=>installedPackageView(e,'global',i)),...(projectSettings.packages||[]).map((e,i)=>installedPackageView(e,'project',i))];}
export const __test={packageDetail,resourcesFromManifest,compareVersions,npmNameFromSource,runCommand,gitRemoteFromPiSource,splitGitSourceRef};


function splitGitSourceRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return { remote: '', ref: '' };
  const pathStart = raw.includes('://') ? raw.indexOf('/', raw.indexOf('://') + 3) : raw.indexOf('/');
  const at = raw.lastIndexOf('@');
  if (at > pathStart && pathStart >= 0) return { remote: raw.slice(0, at), ref: raw.slice(at + 1) };
  return { remote: raw, ref: '' };
}

function gitRemoteFromPiSource(source) {
  const raw = String(source || '').trim();
  let value = raw;
  if (raw.startsWith('git:') && !raw.startsWith('git://')) value = raw.slice(4);
  const parsed = splitGitSourceRef(value);
  let remote = parsed.remote;
  if (/^(https?|ssh|git):\/\//.test(remote)) return { remote, ref: parsed.ref };
  if (/^[^@\s]+@[^:\s]+:.+/.test(remote)) return { remote, ref: parsed.ref };
  if (/^[^/]+\.[^/]+\/.+/.test(remote)) {
    remote = `https://${remote.replace(/\.git$/, '')}.git`;
    return { remote, ref: parsed.ref };
  }
  return { remote: '', ref: '' };
}

async function walkLocalPackage(root,{maxFiles=300,maxBytes=5*1024*1024}={}){
  let count=0,total=0,truncated=false,unverified=false;const rows=[];
  async function walk(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      if(['node_modules','.git','.cache','dist','build'].includes(entry.name))continue;
      if(count>=maxFiles||total>=maxBytes){truncated=true;unverified=true;return;}
      const full=path.join(dir,entry.name); const relative=path.relative(root,full).split(path.sep).join('/');
      if(entry.isSymbolicLink()){
        const target=await fs.readlink(full).catch(()=>'?');
        rows.push({path:relative,size:0,hash:null,skipped:true,symlink:true,target});count++;unverified=true;continue;
      }
      if(entry.isDirectory()){await walk(full);if(truncated)return;}
      else if(entry.isFile()){
        const stat=await fs.stat(full);
        if(stat.size>1024*1024){rows.push({path:relative,size:stat.size,hash:null,skipped:true});count++;unverified=true;continue;}
        const data=await fs.readFile(full);total+=data.length;count++;rows.push({path:relative,size:data.length,hash:crypto.createHash('sha256').update(data).digest('hex')});
      }
    }
  }
  await walk(root);const aggregate=crypto.createHash('sha256');for(const row of rows)aggregate.update(`${row.path}\0${row.hash||''}\0${row.size}\n`);return{files:rows,fileCount:count,totalBytes:total,truncated,unverified,revision:aggregate.digest('hex')};
}

export async function inspectPackageSource(source,{workspace='',scope='project',run=runCommand,fetchImpl=fetch}={}){
  const raw=String(source||'').trim();if(!raw)throw Object.assign(new Error('Package source is required'),{statusCode:400});
  if(raw.startsWith('npm:')){const name=npmNameFromSource(raw);const versionMatch=raw.match(/@([^/@]+)$/);const detail=await fetchPackageDetails(name,{version:versionMatch?.[1]||'',fetchImpl});return{type:'npm',source:raw,identity:packageIdentity(raw),revision:detail.integrity||detail.shasum||detail.version,version:detail.version,integrity:detail.integrity||'',repository:detail.repository||'',trust:detail.trust,resources:detail.resources,files:[],verified:Boolean(detail.integrity||detail.shasum)};}
  const gitSource=gitRemoteFromPiSource(raw);
  if(gitSource.remote){let revision='',error='';const requestedRef=gitSource.ref||'HEAD';try{const result=await run('git',['ls-remote',gitSource.remote,requestedRef],{cwd:workspace||process.cwd(),env:{...process.env,GIT_TERMINAL_PROMPT:'0'},timeoutMs:30000});revision=String(result.stdout||'').trim().split(/\s+/)[0]||'';}catch(e){error=e.message;}return{type:'git',source:raw,identity:packageIdentity(raw),remote:gitSource.remote,requestedRef:gitSource.ref||'',revision,error,verified:Boolean(revision),files:[]};}
  const base=scope==='project'&&workspace?path.resolve(workspace):process.cwd();const local=path.resolve(base,raw);const stat=await fs.stat(local).catch(()=>null);if(!stat?.isDirectory())throw Object.assign(new Error(`Local package directory not found: ${local}`),{statusCode:404});const localLstat=await fs.lstat(local).catch(()=>null);const realPath=await fs.realpath(local).catch(()=>local);const rootSymlink=Boolean(localLstat?.isSymbolicLink())||!canonicalPathEqual(realPath,local);const scan=await walkLocalPackage(local);let manifest={};try{manifest=JSON.parse(await fs.readFile(path.join(local,'package.json'),'utf8'));}catch{}const resources=resourcesFromManifest(manifest);const scripts=manifest.scripts&&typeof manifest.scripts==='object'?manifest.scripts:{};const installKeys=['preinstall','install','postinstall','prepare'];const verified=!rootSymlink&&!scan.truncated&&!scan.unverified&&scan.files.every((row)=>Boolean(row.hash));return{type:'local',source:raw,identity:packageIdentity(raw,base),path:local,realPath,rootSymlink,revision:scan.revision,verified,...scan,manifest:{name:manifest.name||path.basename(local),version:manifest.version||'',license:manifest.license||'',resources},trust:{hasInstallScripts:installKeys.some(k=>Boolean(scripts[k])),installScripts:Object.fromEntries(installKeys.filter(k=>scripts[k]).map(k=>[k,scripts[k]])),dependencyCount:Object.keys(manifest.dependencies||{}).length,hasExtensions:(resources.extensions||[]).length>0,unverifiedContent:!verified}};
}
