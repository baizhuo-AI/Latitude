import { useMemo } from "react";
import { ComputerHistoryPanel } from "./ComputerHistoryPanel";
import type { HistoryClient, HistorySettings, HistoryWorkflow } from "./historyClient";
import "../dimension.css";

// Synthetic review data. This story never contacts a collector or the user's database.
export function Review() {
  const client=useMemo<HistoryClient>(()=>{
    let settings:HistorySettings={revision:0,config:{enabled:false,paused:false,nativeEnabled:true,externalEnabled:false,modelProcessing:false,appMode:"exclude",apps:[],siteMode:"exclude",sites:[]},collector:{state:"stopped",permission:true}};
    let items=[{id:"activity-review",from:new Date().toISOString(),to:new Date().toISOString(),app:"预览",title:"项目评审材料",coverage:"partial",providers:["latitude"],events:[{id:"event-review",evidenceRefId:"evidence-review",observedAt:new Date().toISOString(),expired:false,content:{visibleText:"这是一条用于界面验收的虚构记录：先检查原始需求，再整理评审问题。"}}],summary:{title:"整理项目评审的问题",text:"阅读评审材料，整理了需要进一步核实的问题。",uncertainty:"这里只记录到可读的页面内容，无法据此确认评审已经完成。"}}];
    let memories=[{id:"memory-review",statement:"评审准备包含核对需求与整理待确认问题；这是这段活动中的工作步骤。",status:"observation",groupIds:["activity-review"],updatedAt:new Date().toISOString()}];
    let workflows:HistoryWorkflow[]=[];
    items=items.map(item=>({...item,summary:{...item.summary,suggestion:{kind:"skill",title:"整理评审检查清单",prompt:"根据评审活动，整理需要进一步核实的问题和来源。"}}}));
    return {
      settings:async()=>structuredClone(settings),
      configure:async(next)=>{settings={...next,revision:settings.revision+1,collector:{state:next.config.paused?"paused":next.config.enabled?"running":"stopped",permission:true,lastSeenAt:new Date().toISOString()}};return structuredClone(settings);},
      query:async(input)=>({items:items.filter(item=>!input?.query||JSON.stringify(item).includes(String(input.query))),hasMore:false,nextOffset:null}),
      clear:async()=>{items=[];memories=[];workflows=[];return {deleted:1};},
      memories:async()=>({items:memories,memoryFile:{path:"演示位置 / computer-history-memory / memories.json",recoveryPath:"演示位置 / last-valid.json"}}),
      restoreMemoryFile:async()=>({items:memories}),
      workflows:async(input)=>{
        if(input?.action==="prepare"&&!workflows.length)workflows=[{groupId:"activity-review",version:"v1",title:"整理评审检查清单",prompt:"根据评审活动，整理需要进一步核实的问题和来源。",cadence:"manual",at:"09:00",weekday:1,state:"draft"}];
        if(input?.action==="save")workflows=[{...(input as unknown as HistoryWorkflow),version:`v${Date.now()}`,state:"draft",trialCompleted:false,lastRun:undefined}];
        if(input?.action==="run")workflows=workflows.map(item=>({...item,trialCompleted:true,lastRun:{runId:"synthetic-trial",status:"completed",text:"虚构试用结果：\n待核实：测试是否完成、评审负责人是否确认。\n依据：项目评审材料。\n缺口：未读到最终确认结果。"}}));
        if(input?.action==="enable"||input?.action==="disable")workflows=workflows.map(item=>({...item,state:input.action==="enable"?"enabled":"disabled"}));
        return {items:structuredClone(workflows)};
      },
      reviewMemory:async(id,statement)=>{memories=memories.map(m=>m.id===id?{...m,statement,status:"user_corrected"}:m);return {items:memories};},
      removeMemory:async(id)=>{memories=memories.filter(m=>m.id!==id);return {items:memories};},
      dismissSuggestion:async()=>({saved:true}),
      status:async()=>({...settings,external:{available:true},processing:{}}),
    };
  },[]);
  return <main className="dimension-app" style={{display:"block",padding:24,minHeight:"100vh",height:"auto",overflow:"auto",background:"#f8f8f3"}}><div style={{maxWidth:760,margin:"0 auto"}}><p className="dim-meta">交互验收 · 以下为虚构数据，开关不触发实际采集。</p><ComputerHistoryPanel client={client} onAsk={()=>{}}/></div></main>;
}
