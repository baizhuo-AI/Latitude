// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {HistoryService,normalizeExternal} from "../src/history/historyService.js";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {AuditLedger} from "../src/persistence/auditLedger.js";
import {DshRuntime} from "../src/runtime/dshRuntime.js";
import {FakeDomain,testConfig,toolSequenceThenTextAdapter} from "./helpers.js";

describe("computer history model boundary",()=>{
  it("clears a startup connection error once the disabled history service is reachable",async()=>{
    let offline=true;
    const service=new HistoryService("http://127.0.0.1:43121",async(input)=>{
      const route=new URL(String(input)).pathname;
      if(offline&&route.endsWith("expire"))throw new Error("Domain is still starting");
      if(route.endsWith("settings"))return Response.json({revision:0,config:{enabled:false,modelProcessing:false}});
      return Response.json({items:[],sources:[]});
    },"/private/tmp/latitude-no-external-history-fixture");
    try{
      await service.start();
      await vi.waitFor(async()=>expect((await service.status()).processing.error).toContain("后台整理暂不可用"));
      offline=false;await service.tick();
      expect((await service.status()).processing.error).toBeNull();
    }finally{await service.close();}
  });
  it("expires only the session that actually read old raw material",async()=>{
    const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now);
    const service=new HistoryService("http://127.0.0.1:43121",async(input)=>{
      const route=new URL(String(input)).pathname;
      if(route.endsWith("settings"))return Response.json({revision:1,config:{modelProcessing:true,enabled:true}});
      if(route.endsWith("query"))return Response.json({revision:1,items:[{id:"old",events:[{id:"old-event",observedAt:new Date(now-48*3600_000+1000).toISOString(),expired:false}]}]});
      return Response.json({items:[]});
    });
    try{
      const first=await service.beginTurn("reading");const unrelated=await service.beginTurn("other");
      const read=service.tools("reading").find(t=>t.name==="history_read")!;
      await (read.execute as any)({groupId:"old"},{signal:new AbortController().signal});
      await service.assertBoundary(first.token,"reading");clock.mockReturnValue(now+2000);
      await expect(service.assertBoundary(first.token,"reading")).rejects.toThrow("已到期");
      await expect(service.assertBoundary(unrelated.token,"other")).resolves.toBeUndefined();
      expect((await service.beginTurn("reading")).token).not.toBe(first.token);
      expect((await service.beginTurn("other")).token).toBe(unrelated.token);
    }finally{clock.mockRestore();}
  });
  it("runs read → summary through DSH and drops old model context after a history revision",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"latitude-history-loop-"));let revision=1;const saved:any[]=[];
    const history=new HistoryService("http://127.0.0.1:43121",async(input,init)=>{
      const route=new URL(String(input)).pathname;
      if(route.endsWith("settings"))return Response.json({revision,config:{enabled:true,modelProcessing:true}});
      if(route.endsWith("query"))return Response.json({revision,items:[{id:"group",events:[{id:"real",expired:false,content:{visibleText:"SYNTHETIC_RAW_DO_NOT_ARCHIVE"}}]}]});
      if(route.endsWith("summary")){saved.push(JSON.parse(String(init?.body)));return Response.json({saved:true});}
      return Response.json({items:[]});
    });
    const ledger=new AuditLedger(root);
    const runtime=new DshRuntime({config:testConfig(root),ledger,domain:new FakeDomain(),history,installOfficialWebSearch:false,
      adapter:toolSequenceThenTextAdapter([{name:"history_read",args:{groupId:"group"}},{name:"history_save_summary",args:{groupId:"group",summary:{title:"准备评审",text:"整理待确认问题"}}}],"已整理。")});
    try {
      const sessionId="latitude:history:group";
      const result=await runtime.runTurn({runId:"history-test",sessionId,text:"整理这段活动",initiator:"scheduler",budgets:{}},new AbortController().signal);
      expect(result.status).toBe("completed");expect(saved[0]).toMatchObject({revision:1,eventIds:["real"]});
      const state=await ledger.loadSessionState(sessionId);expect(state.historyBoundary).toContain("1:");
      for(const file of await readdir(ledger.sessionsDir)){if(file.endsWith(".jsonl"))expect(await readFile(path.join(ledger.sessionsDir,file),"utf8")).not.toContain("SYNTHETIC_RAW_DO_NOT_ARCHIVE");}
      revision=2;
      await runtime.runTurn({runId:"history-test-2",sessionId,text:"重新开始",useHistory:false,budgets:{}},new AbortController().signal);
      const next=await ledger.loadSessionState(sessionId);expect(next.generation).toBeGreaterThan(state.generation);expect(next.historyBoundary).toContain("2:");
      expect(JSON.stringify(next.events)).not.toContain("SYNTHETIC_RAW_DO_NOT_ARCHIVE");
    }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
  });
  it("saves the revision and IDs actually read, never a fresh revision after deletion",async()=>{
    let revision=3;const writes:any[]=[];
    const fetcher=async(input:any,init?:RequestInit)=>{
      const route=new URL(String(input)).pathname;
      if(route.endsWith("/settings"))return Response.json({revision,config:{modelProcessing:true,enabled:true}});
      if(route.endsWith("/memory"))return Response.json({items:[]});
      if(route.endsWith("/query"))return Response.json({revision,items:[{id:"group",events:[{id:"real-event",expired:false}]}]});
      const body=JSON.parse(String(init?.body));writes.push(body);return Response.json({saved:true});
    };
    const service=new HistoryService("http://127.0.0.1:43121",fetcher);const session="latitude:history:group";
    await service.beginTurn(session);
    const tools=service.tools(session);const call=async(name:string,args:any)=>(tools.find(t=>t.name===name)!.execute as any)(args,{signal:new AbortController().signal});
    await expect(call("history_save_summary",{groupId:"group",summary:{title:"x",text:"y"}})).rejects.toThrow("先读取");
    await call("history_read",{groupId:"group"});revision=4;
    await call("history_save_summary",{groupId:"group",summary:{title:"评审准备",text:"整理待确认问题"}});
    expect(writes[0]).toMatchObject({revision:3,eventIds:["real-event"]});
    await service.beginTurn(session,false);await expect(call("history_read",{groupId:"group"})).rejects.toThrow("未允许");
  });
  it("makes unavailable history a closed read boundary without blocking unrelated chat",async()=>{
    const service=new HistoryService("http://127.0.0.1:1",async()=>{throw new Error("offline");});
    expect(await service.beginTurn("chat")).toEqual({allowed:false,token:"unavailable"});
    await expect(service.assertBoundary("unavailable")).resolves.toBeUndefined();
  });
  it("accepts the observed official schema and labels a diff as partial",()=>{
    const base={id:1,timestamp:new Date().toISOString(),app:{name:"Preview",bundleIdentifier:"com.apple.Preview"},window:{title:"Test"}};
    expect(normalizeExternal({...base,ax:{mode:"fullTree",text:"A synthetic visible page"}})?.visibleText).toBe("A synthetic visible page");
    expect(normalizeExternal({...base,ax:{mode:"diffFromPrevious",text:"+ changed line"}})?.visibleText).toContain("尚未还原完整页面");
    expect(normalizeExternal({...base,timestamp:"2000-01-01T00:00:00Z"})).toBeNull();
  });
});
