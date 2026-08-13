export function createMcpRoutes({ manager, readBody, json, sendEvent }) {
  return async function handleMcpRoutes(req,res,url){
    const {pathname}=url;
    if(req.method==='GET'&&pathname==='/api/mcp'){json(res,200,{ok:true,...await manager.snapshot()});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/server'){const body=await readBody(req);const server=await manager.saveServer(body.server||body);sendEvent('mcp_changed',{serverId:server.id,action:'save'});json(res,200,{ok:true,server});return true;}
    if(req.method==='DELETE'&&pathname==='/api/mcp/server'){const body=await readBody(req);const result=await manager.removeServer(body.serverId||body.id);sendEvent('mcp_changed',{serverId:result.id,action:'remove'});json(res,200,{ok:true,...result});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/connect'){const body=await readBody(req);const server=await manager.connect(body.serverId||body.id);sendEvent('mcp_changed',{serverId:server.id,action:'connect'});json(res,200,{ok:true,server});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/disconnect'){const body=await readBody(req);const result=await manager.disconnect(body.serverId||body.id);sendEvent('mcp_changed',{serverId:result.id,action:'disconnect'});json(res,200,{ok:true,...result});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/refresh'){const body=await readBody(req);const runtime=await manager.refresh(body.serverId||body.id);sendEvent('mcp_changed',{serverId:body.serverId||body.id,action:'refresh'});json(res,200,{ok:true,runtime});return true;}
    if(req.method==='PUT'&&pathname==='/api/mcp/exposure'){const body=await readBody(req);const server=await manager.updateExposure(body.serverId||body.id,body);sendEvent('mcp_changed',{serverId:server.id,action:'exposure'});json(res,200,{ok:true,server});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/tool'){const body=await readBody(req);json(res,200,{ok:true,result:await manager.callTool(body.serverId,body.toolName,body.args||{})});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/resource'){const body=await readBody(req);json(res,200,{ok:true,result:await manager.readResource(body.serverId,body.uri)});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/prompt'){const body=await readBody(req);json(res,200,{ok:true,result:await manager.getPrompt(body.serverId,body.name,body.args||{})});return true;}
    // Agent-only bridge endpoints enforce exposure independently from manual Studio APIs.
    if(req.method==='GET'&&pathname==='/api/mcp/agent/tools'){json(res,200,{ok:true,tools:await manager.agentTools()});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/agent/call'){const body=await readBody(req);json(res,200,{ok:true,result:await manager.agentCall(body)});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/agent/resources'){const body=await readBody(req);json(res,200,{ok:true,resources:await manager.agentResources(body.serverId)});return true;}
    if(req.method==='POST'&&pathname==='/api/mcp/agent/prompts'){const body=await readBody(req);json(res,200,{ok:true,prompts:await manager.agentPrompts(body.serverId)});return true;}
    return false;
  };
}
