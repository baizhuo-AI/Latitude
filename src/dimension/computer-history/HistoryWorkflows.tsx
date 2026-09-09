import {useCallback, useEffect, useState} from "react";
import type {HistoryClient, HistoryWorkflow} from "./historyClient";

export function HistoryWorkflows({client, prepareGroup, onPrepared, onAsk, revision}: {
  client: HistoryClient; prepareGroup: string | null; onPrepared: () => void; onAsk: (text:string) => void;revision?:number;
}) {
  const [items,setItems]=useState<HistoryWorkflow[]>([]);
  const [editing,setEditing]=useState<HistoryWorkflow|null>(null);
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const refresh=useCallback(async()=>{
    const result=await client.workflows();setItems(result.items);
    setEditing(previous=>previous&&result.items.some(item=>item.groupId===previous.groupId)?previous:null);
  },[client,revision]);
  useEffect(()=>{let disposed=false;const update=()=>void refresh().catch(e=>{if(!disposed)setError(String(e));});update();const timer=setInterval(update,5000);return()=>{disposed=true;clearInterval(timer);};},[refresh]);
  useEffect(()=>{
    if(!prepareGroup)return;
    setBusy(true);setError("");
    void client.workflows({action:"prepare",groupId:prepareGroup}).then(result=>{
      setItems(result.items);setEditing(result.items.find(item=>item.groupId===prepareGroup)??null);setDirty(false);
    }).catch(e=>setError(String(e))).finally(()=>{setBusy(false);onPrepared();});
  },[client,prepareGroup,onPrepared]);
  async function act(action:string,item:HistoryWorkflow){
    setBusy(true);setError("");
    try{const result=await client.workflows({...item,action});setItems(result.items);
      if(action==="save"){setEditing(result.items.find(value=>value.groupId===item.groupId)??null);setDirty(false);}
      if(action==="remove")setEditing(null);
    }catch(e){setError(e instanceof Error?e.message:"操作未完成，请重试。");}finally{setBusy(false);}
  }
  const selected=items.find(item=>item.groupId===editing?.groupId);
  return <div className="history-workflows" id="history-workflows"><h4>我的工作方式</h4>
    <p className="dim-meta">根据记录与已有知识整理结果，草稿保存在维度。试用不会开启定时任务。</p>
    {error&&<p role="alert" className="history-error">{error}</p>}
    {!items.length&&<p className="history-empty">从活动建议选择「帮我准备」后，可在这里编辑、试用和管理。</p>}
    {items.map(item=><article className="history-memory" key={item.groupId}><div className="history-item-heading"><strong>{item.title}</strong><span>{item.state==="enabled"?(item.cadence==="manual"?"可随时使用":"定时运行已启用"):item.state==="disabled"?"已停用":"待审阅草稿"}</span></div><div className="history-actions"><button className="dim-btn dim-btn--quiet" onClick={()=>{setEditing(item);setDirty(false);setError("");}}>编辑与预览</button>{item.state==="enabled"&&<button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>void act("disable",item)}>停用</button>}</div>
      {item.lastRun&&<p className="dim-meta">{item.lastRun.status==="completed"?"最近结果已生成，可打开预览。":item.lastRun.status==="running"||item.lastRun.status==="queued"?"正在读取依据并准备草稿…":item.lastRun.error||"本次任务未完成，可以重新试用。"}</p>}
    </article>)}
    {editing&&<div className="history-setup" role="group" aria-label="编辑工作方式">
      <label>名称<input aria-label="工作方式名称" value={editing.title} onChange={e=>{setEditing({...editing,title:e.target.value});setDirty(true);}}/></label>
      <label>希望完成的内容<textarea aria-label="工作方式内容" value={editing.prompt} onChange={e=>{setEditing({...editing,prompt:e.target.value});setDirty(true);}}/></label>
      <p className="dim-meta">依据：这项建议对应的活动和你允许查询的后续记录。当前可生成维度内的草稿；需要外发或改动业务系统时，另行在聊天中处理。</p>
      <div className="history-rule-grid"><label>运行方式<select aria-label="工作方式运行方式" value={editing.cadence} onChange={e=>{setEditing({...editing,cadence:e.target.value as HistoryWorkflow["cadence"]});setDirty(true);}}><option value="manual">我需要时运行</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {editing.cadence!=="manual"&&<label>本机时间<input type="time" aria-label="工作方式运行时间" value={editing.at} onChange={e=>{setEditing({...editing,at:e.target.value});setDirty(true);}}/></label>}
        {editing.cadence==="weekly"&&<label>星期<select aria-label="工作方式运行星期" value={editing.weekday} onChange={e=>{setEditing({...editing,weekday:Number(e.target.value)});setDirty(true);}}>{["周日","周一","周二","周三","周四","周五","周六"].map((name,index)=><option key={name} value={index}>{name}</option>)}</select></label>}
      </div>
      {editing.cadence!=="manual"&&<p className="dim-meta">维度运行且已允许模型处理时执行；当天错过设定时间会补做一次。关闭电脑记录会暂停这些定时任务。</p>}
      <div className="history-actions"><button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>{setEditing(null);setDirty(false);}}>收起</button><button className="dim-btn" disabled={busy||!dirty||!editing.title.trim()||!editing.prompt.trim()} onClick={()=>void act("save",editing)}>保存草稿</button><button className="dim-btn" disabled={busy||dirty||selected?.lastRun?.status==="running"||selected?.lastRun?.status==="queued"} onClick={()=>void act("run",editing)}>试用并预览结果</button>
        <button className="dim-btn" disabled={busy||dirty||!selected?.trialCompleted||selected.state==="enabled"} onClick={()=>void act("enable",editing)}>{editing.cadence==="manual"?"启用这个工作方式":"启用定时运行"}</button>
      </div>
      {dirty&&<p className="dim-meta">保存修改后需要重新试用，再启用。</p>}
      {selected?.lastRun?.text&&<div className="history-evidence" role="region" aria-label="工作方式结果预览"><p>{selected.lastRun.text}</p><button className="dim-btn dim-btn--quiet" onClick={()=>onAsk(`帮我编辑这份试用草稿，核对活动 ${selected.groupId} 的来源后继续：\n${selected.lastRun!.text}`)}>在聊天中继续编辑</button></div>}
    </div>}
  </div>;
}
