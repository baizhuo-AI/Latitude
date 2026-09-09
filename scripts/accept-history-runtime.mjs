import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {createServer} from "node:net";
import path from "node:path";
import assert from "node:assert/strict";

const root=process.cwd();
const scratch=await mkdtemp(path.join(tmpdir(),"latitude-history-accept-"));
const children=[];
async function port(){const server=createServer();await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
const domainPort=await port(),agentPort=await port();
const domain=`http://127.0.0.1:${domainPort}`,agent=`http://127.0.0.1:${agentPort}`;
function launch(exe,args,extra){const child=spawn(exe,args,{cwd:scratch,env:{PATH:process.env.PATH,LANG:"en_US.UTF-8",...extra},stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",chunk=>{error+=chunk;});child.on("error",e=>{error=e.message;});children.push(child);return ()=>error;}
async function request(base,route,body){const response=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error(`${route}: ${response.status}`);return response.json();}
async function ready(base,diagnostics){for(let i=0;i<100;i++){try{return await request(base,"/health");}catch{await new Promise(resolve=>setTimeout(resolve,100));}}throw new Error(`Service failed to start: ${diagnostics()}`);}
try {
  const domainErrors=launch(path.join(root,"src-tauri/domain-service/target/debug/latitude-domain"),[],{LATITUDE_DOMAIN_ADDR:`127.0.0.1:${domainPort}`,LATITUDE_DB_PATH:path.join(scratch,"domain.db"),LATITUDE_BACKUP_DIR:path.join(scratch,"backups")});
  await ready(domain,domainErrors);
  const agentBundle=path.join(root,"src-tauri/resources/agent");
  const agentErrors=launch(path.join(agentBundle,"node"),[path.join(agentBundle,"agent.mjs")],{LATITUDE_AGENT_PORT:String(agentPort),LATITUDE_DOMAIN_URL:domain,LATITUDE_STATE_DIR:path.join(scratch,"agent")});
  await ready(agent,agentErrors);
  const initial=await request(domain,"/v1/history/settings");assert.equal(initial.config.enabled,false);assert.equal(initial.config.modelProcessing,false);
  const settings=await request(domain,"/v1/history/settings",{revision:initial.revision,config:{...initial.config,enabled:true}});
  const event={id:"acceptance-fiction",timestamp:new Date().toISOString(),applicationName:"Synthetic Preview",bundleIdentifier:"test.latitude.preview",windowTitle:"虚构评审材料",visibleText:"这是隔离验收记录，不是用户活动。",kind:"click",metadata:{}};
  const ingestion=await request(domain,"/v1/history/ingest",{provider:"latitude",revision:settings.revision,events:[event]});assert.equal(ingestion.accepted,1);
  const page=await request(domain,"/v1/history/query",{includeContent:true});assert.equal(page.items[0].events[0].content.visibleText,event.visibleText);
  const host=await request(agent,"/v1/agent/history/status");assert.equal(host.config.enabled,true);assert.equal(host.config.modelProcessing,false);
  await request(domain,"/v1/history/clear",{groupId:page.items[0].id,confirm:"删除记录"});
  assert.equal((await request(domain,"/v1/history/query",{})).items.length,0);
  const latest=await request(domain,"/v1/history/settings");
  assert.equal((await request(domain,"/v1/history/ingest",{provider:"latitude",revision:latest.revision,events:[event]})).accepted,0);
  console.log("PASS: bundled Node/Agent starts independently; isolated Domain defaults off, persists real API input, exposes shared settings, clears records and refuses reimport. No collector or cloud model was enabled.");
} finally {
  await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}child.once("exit",resolve);child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),2000).unref();})));
  await rm(scratch,{recursive:true,force:true});
}
