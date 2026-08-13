import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { APP_DIR, APP_VERSION, PI_AGENT_DIR, readJson, readJsonStrict, serializeMutation, writeJsonAtomic } from './config.mjs';
import { terminateProcessTree } from './process-tree.mjs';
import { prepareSpawn } from './spawn-command.mjs';

export const MCP_CONFIG_PATH = path.join(APP_DIR, 'mcp.json');
export const MCP_BRIDGE_PATH = path.join(PI_AGENT_DIR, 'extensions', 'pi-ollama-studio-mcp.ts');
const LEGACY_PROTOCOL = '2025-11-25';
const CURRENT_PROTOCOL = '2026-07-28';

function cleanId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw Object.assign(new Error('MCP server ID is required'), { statusCode: 400 });
  return id.slice(0, 80);
}
function stringArray(value) { return Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean) : []; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}; }
function resolveReferences(input, env = process.env) {
  return Object.fromEntries(Object.entries(object(input)).map(([key, raw]) => {
    const value = String(raw ?? '');
    if (value.startsWith('$') && /^[A-Z_][A-Z0-9_]*$/i.test(value.slice(1))) return [key, env[value.slice(1)] ?? ''];
    return [key, value];
  }));
}
function normalizeServer(input = {}) {
  const transport = input.transport === 'http' ? 'http' : 'stdio';
  const server = {
    id: cleanId(input.id || input.name),
    name: String(input.name || input.id || '').trim() || cleanId(input.id),
    transport,
    enabled: input.enabled !== false,
    exposeToPi: input.exposeToPi === true,
    disabledTools: stringArray(input.disabledTools),
    timeoutMs: Math.max(1000, Math.min(10 * 60_000, Number(input.timeoutMs || 30_000)))
  };
  if (transport === 'stdio') {
    server.command = String(input.command || '').trim();
    if (!server.command) throw Object.assign(new Error('MCP stdio command is required'), { statusCode: 400 });
    server.args = stringArray(input.args);
    server.cwd = String(input.cwd || '').trim();
    server.env = object(input.env);
  } else {
    server.url = String(input.url || '').trim();
    let parsed;
    try { parsed = new URL(server.url); } catch { throw Object.assign(new Error('MCP HTTP URL is invalid'), { statusCode: 400 }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('MCP HTTP URL must use http or https'), { statusCode: 400 });
    server.url = parsed.toString();
    server.headers = object(input.headers);
  }
  return server;
}
function publicServer(server, runtime = {}) {
  return {
    ...server,
    env: server.env ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value).startsWith('$') ? value : '<literal>'])) : undefined,
    headers: server.headers ? Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, String(value).startsWith('$') ? value : '<literal>'])) : undefined,
    status: runtime.status || 'disconnected',
    connectedAt: runtime.connectedAt || null,
    lastError: runtime.lastError || null,
    protocolVersion: runtime.protocolVersion || null,
    capabilities: runtime.capabilities || {},
    tools: runtime.tools || [],
    resources: runtime.resources || [],
    prompts: runtime.prompts || []
  };
}
function toolName(serverId, remoteName) {
  const safe = String(remoteName || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tool';
  return `mcp_${String(serverId).replace(/[^a-zA-Z0-9_-]+/g, '_')}_${safe}`.slice(0, 120);
}
function parseSse(text) {
  const records = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { records.push(JSON.parse(data)); } catch { /* ignore non-JSON SSE records */ }
  }
  return records;
}

class StdioConnection {
  constructor(server, { env = process.env, onLog = () => {}, onExit = () => {} } = {}) {
    this.server = server; this.env = env; this.onLog = onLog; this.onExit = onExit; this.child = null; this.closing = false; this.buffer = ''; this.pending = new Map(); this.id = 0; this.protocolVersion = LEGACY_PROTOCOL; this.capabilities = {};
  }
  async connect() {
    const childEnv = { ...this.env, ...resolveReferences(this.server.env, this.env) };
    const prepared = prepareSpawn(this.server.command, this.server.args || [], { cwd: this.server.cwd || undefined, env: childEnv });
    const child = spawn(prepared.command, prepared.args, {
      cwd: this.server.cwd || undefined, env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', ...prepared.options
    });
    this.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.on('data', (chunk) => this.onLog('stderr', String(chunk)));
    child.on('exit', (code, signal) => { const err = new Error(`MCP stdio server exited${code == null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`); this.#rejectAll(err); if (!this.closing) this.onExit(err); });
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 75); child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`MCP stdio server exited during startup with code ${code}`)); }); });
    try {
      const init = await this.request('initialize', { protocolVersion: LEGACY_PROTOCOL, capabilities: {}, clientInfo: { name:'pi-ollama-studio', version:APP_VERSION } }, Math.min(5000, this.server.timeoutMs));
      this.protocolVersion = init?.protocolVersion || LEGACY_PROTOCOL; this.capabilities = init?.capabilities || {};
      this.notify('notifications/initialized', {});
    } catch (error) {
      const unsupportedInitialize = error?.code === -32601 || /method not found|unsupported method/i.test(String(error.message));
      if (!unsupportedInitialize) throw error;
      this.protocolVersion = CURRENT_PROTOCOL;
    }
    return this;
  }
  #consume(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim(); this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { this.onLog('stdout', line); continue; }
      if (message.id != null && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id)); this.pending.delete(String(message.id)); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'MCP request failed'), { code: message.error.code, details: message.error.data })); else pending.resolve(message.result);
      } else if (message.id != null && message.method) {
        this.child?.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', id:message.id, error:{ code:-32601, message:'Client method not supported' } })}\n`);
      } else this.onLog('notification', message);
    }
  }
  #rejectAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  request(method, params = {}, timeoutMs = this.server.timeoutMs) {
    if (!this.child || this.child.exitCode != null) return Promise.reject(new Error('MCP stdio server is not running'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`MCP request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      const payload = { jsonrpc:'2.0', id, method, params: this.protocolVersion === CURRENT_PROTOCOL ? { ...params, _meta:{ ...(params?._meta || {}), 'io.modelcontextprotocol/clientInfo':{ name:'pi-ollama-studio', version:APP_VERSION } } } : params };
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
  notify(method, params = {}) { if (this.child && this.child.exitCode == null) this.child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', method, params })}\n`); }
  async close() { const child = this.child; this.child = null; this.closing = true; if (!child) return; this.#rejectAll(new Error('MCP stdio connection closed')); await terminateProcessTree(child).catch(() => {}); }
}

class HttpConnection {
  constructor(server, { env = process.env, fetchImpl = fetch, onLog = () => {} } = {}) { this.server=server; this.env=env; this.fetchImpl=fetchImpl; this.onLog=onLog; this.id=0; this.sessionId=''; this.protocolVersion=CURRENT_PROTOCOL; this.capabilities={}; this.legacy=false; this.controllers=new Set(); this.closed=false; }
  async connect() {
    try { await this.request('tools/list', {}, Math.min(5000, this.server.timeoutMs)); }
    catch (error) {
      if (!/initialize|session|protocol|400|404/i.test(String(error.message))) throw error;
      const init = await this.#raw('initialize', { protocolVersion:LEGACY_PROTOCOL, capabilities:{}, clientInfo:{name:'pi-ollama-studio',version:APP_VERSION} }, Math.min(5000,this.server.timeoutMs), { protocol:LEGACY_PROTOCOL });
      this.legacy=true; this.protocolVersion=init?.protocolVersion || LEGACY_PROTOCOL; this.capabilities=init?.capabilities || {};
      await this.#notifyLegacy('notifications/initialized', {});
    }
    return this;
  }
  async #notifyLegacy(method, params) { try { await this.#raw(method, params, this.server.timeoutMs, { notification:true, protocol:this.protocolVersion }); } catch {} }
  async #raw(method, params = {}, timeoutMs = this.server.timeoutMs, { notification=false, protocol=this.protocolVersion } = {}) {
    if (this.closed) throw new Error('MCP HTTP connection is closed');
    const id = notification ? undefined : ++this.id;
    const body = { jsonrpc:'2.0', ...(id == null ? {} : { id }), method, params: protocol === CURRENT_PROTOCOL ? { ...params, _meta:{ ...(params?._meta||{}), 'io.modelcontextprotocol/clientInfo':{name:'pi-ollama-studio',version:APP_VERSION} } } : params };
    const headers = { 'content-type':'application/json', accept:'application/json, text/event-stream', 'MCP-Protocol-Version':protocol, 'Mcp-Method':method, ...resolveReferences(this.server.headers, this.env) };
    const name = params?.name || params?.uri || '';
    if (name) headers['Mcp-Name'] = String(name);
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const controller = new AbortController(); this.controllers.add(controller); const timer=setTimeout(()=>controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
    let response, text;
    try {
      response = await this.fetchImpl(this.server.url, { method:'POST', headers, body:JSON.stringify(body), signal:controller.signal });
      const session = response.headers?.get?.('mcp-session-id'); if (session) this.sessionId=session;
      text = await response.text();
    } catch (error) {
      if (this.closed) throw new Error('MCP HTTP connection closed');
      if (controller.signal.aborted && !/timed out/i.test(String(error?.message||''))) throw new Error(`MCP request timed out after ${timeoutMs}ms`);
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0,500)}`);
    if (notification) return null;
    let message;
    if ((response.headers?.get?.('content-type') || '').includes('text/event-stream')) message = parseSse(text).find((item) => String(item.id) === String(id)) || parseSse(text).at(-1);
    else { try { message=JSON.parse(text); } catch { throw new Error('MCP HTTP returned invalid JSON'); } }
    if (message?.error) throw Object.assign(new Error(message.error.message || 'MCP request failed'), { code:message.error.code, details:message.error.data });
    return message?.result ?? message;
  }
  request(method, params = {}, timeoutMs = this.server.timeoutMs) { return this.#raw(method, params, timeoutMs, { protocol:this.legacy ? this.protocolVersion : CURRENT_PROTOCOL }); }
  async close() { this.closed=true; this.sessionId=''; for(const controller of this.controllers)controller.abort(new Error('MCP HTTP connection closed'));this.controllers.clear(); }
}

export class McpManager extends EventEmitter {
  constructor({ storePath = MCP_CONFIG_PATH, env = process.env, fetchImpl = fetch } = {}) { super(); this.storePath=storePath; this.env=env; this.fetchImpl=fetchImpl; this.connections=new Map(); this.connecting=new Map(); this.runtime=new Map(); this.logs=[]; this.lifecycleQueues=new Map(); this.disposed=false; }
  #serializeLifecycle(id, task) { const key=cleanId(id); const prior=this.lifecycleQueues.get(key)||Promise.resolve(); const current=prior.catch(()=>{}).then(task); this.lifecycleQueues.set(key,current); return current.finally(()=>{if(this.lifecycleQueues.get(key)===current)this.lifecycleQueues.delete(key);}); }
  async #disconnectUnlocked(clean) { const connecting=this.connecting.get(clean);this.connecting.delete(clean);const conn=this.connections.get(clean); this.connections.delete(clean); if(connecting&&connecting!==conn)await connecting.close();if(conn)await conn.close(); const runtime=this.runtime.get(clean); if(runtime)Object.assign(runtime,{status:'disconnected',connectedAt:null,lastError:null,tools:[],resources:[],prompts:[],capabilities:{},protocolVersion:null}); this.emit('status',{serverId:clean,status:'disconnected'}); this.emit('changed',{serverId:clean,action:'disconnect'}); return {id:clean}; }
  #handleConnectionExit(id, conn, error) { const clean=cleanId(id);if(this.connections.get(clean)!==conn)return;this.connections.delete(clean);const runtime=this.runtime.get(clean)||{};Object.assign(runtime,{status:'error',connectedAt:null,lastError:error?.message||'MCP connection exited',tools:[],resources:[],prompts:[],capabilities:{},protocolVersion:null});this.runtime.set(clean,runtime);this.emit('status',{serverId:clean,...runtime});this.emit('changed',{serverId:clean,action:'unexpected-exit'}); }
  #log(serverId, stream, data) { const row={ at:new Date().toISOString(), serverId, stream, data:typeof data==='string'?data:JSON.stringify(data) }; this.logs.push(row); if(this.logs.length>500)this.logs.splice(0,this.logs.length-500); this.emit('log',row); }
  async load() { const data=await readJson(this.storePath,{servers:[]}); const servers=Array.isArray(data?.servers)?data.servers.map(normalizeServer):[]; return { servers }; }
  async saveServer(input) { const server=normalizeServer(input); return serializeMutation(this.storePath,async()=>{const raw=await readJsonStrict(this.storePath,{servers:[]});const data={servers:Array.isArray(raw?.servers)?raw.servers.map(normalizeServer):[]};const index=data.servers.findIndex((item)=>item.id===server.id);if(index>=0)data.servers[index]=server;else data.servers.push(server);await writeJsonAtomic(this.storePath,data);await this.disconnect(server.id).catch(()=>{});this.emit('changed',{serverId:server.id,action:'save'});return server;}); }
  async removeServer(id) { const clean=cleanId(id); return serializeMutation(this.storePath,async()=>{await this.disconnect(clean).catch(()=>{});const raw=await readJsonStrict(this.storePath,{servers:[]});const data={servers:Array.isArray(raw?.servers)?raw.servers.map(normalizeServer):[]};data.servers=data.servers.filter((item)=>item.id!==clean);await writeJsonAtomic(this.storePath,data);this.runtime.delete(clean);this.emit('changed',{serverId:clean,action:'remove'});return{id:clean};}); }
  async updateExposure(id,{exposeToPi,disabledTools}={}) { const clean=cleanId(id); return serializeMutation(this.storePath,async()=>{const raw=await readJsonStrict(this.storePath,{servers:[]});const data={servers:Array.isArray(raw?.servers)?raw.servers.map(normalizeServer):[]};const server=data.servers.find((item)=>item.id===clean);if(!server)throw Object.assign(new Error(`MCP server not found: ${clean}`),{statusCode:404});if(typeof exposeToPi==='boolean')server.exposeToPi=exposeToPi;if(Array.isArray(disabledTools))server.disabledTools=stringArray(disabledTools);await writeJsonAtomic(this.storePath,data);this.emit('changed',{serverId:clean,action:'exposure'});return server;}); }
  async connect(id) { const clean=cleanId(id); return this.#serializeLifecycle(clean,async()=>{if(this.disposed)throw new Error('MCP manager is disposed');const data=await this.load();const server=data.servers.find((item)=>item.id===clean);if(!server)throw Object.assign(new Error(`MCP server not found: ${clean}`),{statusCode:404});if(!server.enabled)throw new Error('MCP server is disabled');await this.#disconnectUnlocked(clean).catch(()=>{});const runtime={status:'connecting',connectedAt:null,lastError:null,tools:[],resources:[],prompts:[],capabilities:{},protocolVersion:null};this.runtime.set(clean,runtime);this.emit('status',{serverId:clean,...runtime});let conn=null;try{const opts={env:this.env,fetchImpl:this.fetchImpl,onLog:(stream,data)=>this.#log(clean,stream,data)};if(server.transport==='http')conn=new HttpConnection(server,opts);else conn=new StdioConnection(server,{...opts,onExit:(error)=>this.#handleConnectionExit(clean,conn,error)});this.connecting.set(clean,conn);await conn.connect();if(this.disposed||this.connecting.get(clean)!==conn)throw new Error('MCP connection closed during startup');this.connecting.delete(clean);this.connections.set(clean,conn);Object.assign(runtime,{status:'connected',connectedAt:new Date().toISOString(),protocolVersion:conn.protocolVersion,capabilities:conn.capabilities||{}});await this.refresh(clean);this.emit('status',{serverId:clean,...runtime});return publicServer(server,runtime);}catch(error){if(this.connecting.get(clean)===conn)this.connecting.delete(clean);if(conn)await conn.close().catch(()=>{});if(this.connections.get(clean)===conn)this.connections.delete(clean);Object.assign(runtime,{status:'error',lastError:error.message,tools:[],resources:[],prompts:[]});this.emit('status',{serverId:clean,...runtime});throw error;}}); }
  async disconnect(id) { const clean=cleanId(id); return this.#serializeLifecycle(clean,()=>this.#disconnectUnlocked(clean)); }
  async #server(id) { const data=await this.load(); const clean=cleanId(id); const server=data.servers.find((item)=>item.id===clean); if(!server)throw Object.assign(new Error(`MCP server not found: ${clean}`),{statusCode:404}); return server; }
  async #connection(id,{autoConnect=true}={}) { const clean=cleanId(id); let conn=this.connections.get(clean); if(!conn&&autoConnect){await this.connect(clean);conn=this.connections.get(clean);} if(!conn)throw new Error('MCP server is not connected'); return conn; }
  async refresh(id) { const clean=cleanId(id); const conn=await this.#connection(clean,{autoConnect:false}); const runtime=this.runtime.get(clean)||{}; const list = async(method,key,{optional=true}={})=>{try{const value=await conn.request(method,{});const rows=value?.[key];if(!Array.isArray(rows))throw Object.assign(new Error(`MCP ${method} returned an invalid ${key} list`),{code:'MCP_INVALID_DISCOVERY'});return rows;}catch(error){this.#log(clean,key,error.message);if(optional&&/method not found|unsupported|-32601/i.test(String(error?.message||'')))return[];throw error;}};
    try { const [tools,resources,prompts]=await Promise.all([list('tools/list','tools'),list('resources/list','resources'),list('prompts/list','prompts')]);Object.assign(runtime,{tools,resources,prompts,status:'connected',lastError:null,protocolVersion:conn.protocolVersion,capabilities:conn.capabilities||runtime.capabilities||{}});this.runtime.set(clean,runtime);this.emit('changed',{serverId:clean,action:'refresh'});return runtime;}
    catch(error){Object.assign(runtime,{tools:[],resources:[],prompts:[],status:'error',lastError:error.message});this.runtime.set(clean,runtime);this.emit('status',{serverId:clean,...runtime});throw error;} }
  async callTool(id,name,args={}) { const conn=await this.#connection(id); return conn.request('tools/call',{name:String(name),arguments:object(args)}); }
  async readResource(id,uri) { const conn=await this.#connection(id); return conn.request('resources/read',{uri:String(uri)}); }
  async getPrompt(id,name,args={}) { const conn=await this.#connection(id); return conn.request('prompts/get',{name:String(name),arguments:object(args)}); }
  async snapshot() { const data=await this.load(); return { servers:data.servers.map((server)=>publicServer(server,this.runtime.get(server.id)||{})), logs:this.logs.slice(-100) }; }
  async agentTools() { const data=await this.load(); const result=[]; for(const server of data.servers){const runtime=this.runtime.get(server.id)||{}; const disabled=new Set(server.disabledTools||[]); for(const tool of runtime.tools||[]){result.push({serverId:server.id,remoteName:tool.name,name:toolName(server.id,tool.name),label:`${server.name}: ${tool.name}`,description:tool.description||`MCP tool ${tool.name} from ${server.name}`,inputSchema:tool.inputSchema||{type:'object',properties:{}},active:Boolean(server.enabled&&server.exposeToPi&&!disabled.has(tool.name)&&runtime.status==='connected')});}} return result; }
  async agentCall({serverId,toolName:remoteName,args}={}) { const server=await this.#server(serverId); const runtime=this.runtime.get(server.id)||{}; const disabled=new Set(server.disabledTools||[]); if(!server.enabled||!server.exposeToPi||disabled.has(String(remoteName))||runtime.status!=='connected')throw Object.assign(new Error('MCP tool is not exposed to Pi'),{statusCode:403}); return this.callTool(server.id,remoteName,args); }
  async agentResources(serverId) { const server=await this.#server(serverId); const runtime=this.runtime.get(server.id)||{}; if(!server.enabled||!server.exposeToPi||runtime.status!=='connected')throw Object.assign(new Error('MCP server is not exposed to Pi'),{statusCode:403}); return runtime.resources||[]; }
  async agentPrompts(serverId) { const server=await this.#server(serverId); const runtime=this.runtime.get(server.id)||{}; if(!server.enabled||!server.exposeToPi||runtime.status!=='connected')throw Object.assign(new Error('MCP server is not exposed to Pi'),{statusCode:403}); return runtime.prompts||[]; }
  async dispose(){this.disposed=true;await Promise.allSettled([...this.connecting.values()].map((conn)=>conn.close()));await Promise.allSettled([...this.lifecycleQueues.values()]);const ids=[...new Set([...this.connections.keys(),...this.connecting.keys(),...this.runtime.keys()])];await Promise.allSettled(ids.map((id)=>this.disconnect(id)));}
}

export function buildMcpBridgeSource() {
  return `import { Type } from "typebox";\n\nexport default async function (pi) {\n  const base = process.env.PI_OLLAMA_STUDIO_MCP_URL;\n  if (!base) return;\n  const managed = new Set();\n  const signatures = new Map();\n  async function request(path, options = {}) {\n    const response = await fetch(base + path, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });\n    const value = await response.json().catch(() => ({}));\n    if (!response.ok || value.ok === false) throw new Error(value.error || \`Studio MCP HTTP \${response.status}\`);\n    return value;\n  }\n  async function sync() {\n    const value = await request("/api/mcp/agent/tools");\n    const tools = value.tools || [];\n    for (const tool of tools) {\n      const signature = JSON.stringify([tool.description, tool.inputSchema]);\n      if (signatures.get(tool.name) !== signature) {\n        pi.registerTool({\n          name: tool.name, label: tool.label || tool.name, description: tool.description || tool.name,\n          parameters: Type.Unsafe(tool.inputSchema || { type: "object", properties: {} }),\n          async execute(_toolCallId, params) {\n            const result = await request("/api/mcp/agent/call", { method: "POST", body: JSON.stringify({ serverId: tool.serverId, toolName: tool.remoteName, args: params || {} }) });\n            const raw = result.result;\n            if (raw && Array.isArray(raw.content)) return { content: raw.content, details: raw };\n            return { content: [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) }], details: raw };\n          }\n        });\n        managed.add(tool.name); signatures.set(tool.name, signature);\n      }\n    }\n    const wanted = new Set(tools.filter((tool) => tool.active).map((tool) => tool.name));\n    const current = pi.getActiveTools();\n    const unmanagedActive = current.filter((name) => !managed.has(name));\n    pi.setActiveTools([...new Set([...unmanagedActive, ...wanted])]);\n  }\n  await sync().catch(() => {});\n  const timer = setInterval(() => sync().catch(() => {}), 1000); timer.unref?.();\n  pi.on("session_shutdown", async () => clearInterval(timer));\n}\n`;
}

export async function ensureMcpPiBridge({ bridgePath = MCP_BRIDGE_PATH } = {}) { await fs.mkdir(path.dirname(bridgePath),{recursive:true}); const source=buildMcpBridgeSource(); let current='';try{current=await fs.readFile(bridgePath,'utf8');}catch{} if(current!==source){const tmp=`${bridgePath}.${process.pid}.${Date.now()}.tmp`;try{await fs.writeFile(tmp,source,'utf8');await fs.rename(tmp,bridgePath);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}} return bridgePath; }

export const __test={cleanId,normalizeServer,resolveReferences,toolName,parseSse,StdioConnection,HttpConnection};
