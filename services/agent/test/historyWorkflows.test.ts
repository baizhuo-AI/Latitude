// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {HistoryWorkflows,dueScheduleKey,type HistoryWorkflow} from "../src/history/historyWorkflows.js";
import type {RunJobStore} from "../src/jobs/jobStore.js";

function fixture(){
  let workflow:HistoryWorkflow={groupId:"group",version:"v1",title:"整理周报",prompt:"根据近期评审活动整理进展与待确认事项。",cadence:"daily",at:"09:00",weekday:1,state:"draft"};
  const queue=new Map<string,any>();const creates:any[]=[];
  const jobs={create:vi.fn(async(request:any)=>{creates.push(request);const runId=`run-${queue.size}`;const job={runId,status:"queued",request};queue.set(runId,job);return {job,created:true};}),get:(id:string)=>queue.get(id),cancel:vi.fn()};
  const request=async(route:string,body:any)=>{
    if(route==="settings")return {config:{enabled:true,modelProcessing:true}};
    if(body.action==="markRun"){workflow={...workflow,lastRunId:body.runId,...(body.trial?{trialRunId:body.runId}:{}),...(body.scheduleKey?{lastScheduleKey:body.scheduleKey}:{})};}
    if(body.action==="enable")workflow={...workflow,state:"enabled"};
    if(body.action==="disable")workflow={...workflow,state:"disabled"};
    return {items:[structuredClone(workflow)]};
  };
  const service=new HistoryWorkflows(request,jobs as unknown as RunJobStore,()=>true);
  return {service,queue,creates,jobs};
}
describe("history workflow admission",()=>{
  it("a trial never schedules recurrence; only a completed reviewed version can be enabled",async()=>{
    const {service,queue,creates}=fixture();
    const action={groupId:"group",version:"v1"};
    await expect(service.act({...action,action:"enable"})).rejects.toThrow("先试用");
    await service.act({...action,action:"run"});
    expect(creates).toHaveLength(1);expect(creates[0].initiator).toBe("user");
    await service.tick(new Date(2026,8,7,10));expect(creates).toHaveLength(1);
    await expect(service.act({...action,action:"enable"})).rejects.toThrow("先试用");
    queue.get("run-0").status="completed";queue.get("run-0").result={assistantText:"带有来源的周报草稿。"};
    await service.act({...action,action:"enable"});
    await service.tick(new Date(2026,8,7,10));expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({initiator:"scheduler",clientRequestId:"history-workflow:group:v1:2026-09-07"});
    await service.tick(new Date(2026,8,7,11));expect(creates).toHaveLength(2);
    await service.act({...action,action:"disable"});
    await service.tick(new Date(2026,8,8,11));expect(creates).toHaveLength(2);
  });
  it("never enables or trials a stale version, and respects the selected local weekday",async()=>{
    const {service,creates}=fixture();
    await expect(service.act({action:"run",groupId:"group",version:"old"})).rejects.toThrow("已变化");
    expect(creates).toHaveLength(0);
    const base={state:"enabled",cadence:"weekly",weekday:1,at:"09:00"} as HistoryWorkflow;
    expect(dueScheduleKey(base,new Date(2026,8,7,8))).toBeUndefined();
    expect(dueScheduleKey(base,new Date(2026,8,8,10))).toBeUndefined();
    expect(dueScheduleKey(base,new Date(2026,8,7,10))).toBe("2026-09-07");
  });
});
