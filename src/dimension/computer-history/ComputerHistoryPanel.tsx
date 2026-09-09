import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { History, Pause, Play, Search, Settings2, Trash2, ExternalLink, ChevronDown } from "lucide-react";
import { nativePetAvailable, petCommand } from "../pet/nativePet";
import { createHistoryClient, type HistoryClient, type HistorySettings, type HistoryActivity, type HistoryMemory, type HistoryMemoryResult, type HistoryDiagnostics } from "./historyClient";
import "./computerHistory.css";
import {HistoryWorkflows} from "./HistoryWorkflows";

const time = (value:string) => new Date(value).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
const lines = (value:string) => value.split(/[\n,，]/u).map(v=>v.trim()).filter(Boolean);
const coverageLabel: Record<string,string> = {
  browser_permission_required:"需要允许维度读取浏览器的页面地址和无痕状态。",
  browser_privacy_unavailable:"当前浏览器的隐私状态无法确认，暂未记录其内容。",
  navigation_only:"部分活动只有标题，尚未读到正文。", permission_required:"请完成辅助功能授权后开始记录。",
  window_unavailable:"当前应用未提供可读取的窗口内容。",
  private_excluded:"当前处于无痕浏览，已跳过记录。",
};
export function ComputerHistoryPanel({client:provided,onAsk}: {client?:HistoryClient;onAsk:(text:string)=>void}) {
  const client=useMemo(()=>provided??createHistoryClient(),[provided]);
  const [settings,setSettings]=useState<HistorySettings|null>(null);
  const [activities,setActivities]=useState<HistoryActivity[]>([]);
  const [memories,setMemories]=useState<HistoryMemory[]>([]);
  const [memoryFile,setMemoryFile]=useState<HistoryMemoryResult["memoryFile"]>();
  const [editingMemory,setEditingMemory]=useState<{id:string;statement:string}|null>(null);
  const [prepareGroup,setPrepareGroup]=useState<string|null>(null);
  const prepared=useCallback(()=>setPrepareGroup(null),[]);
  const [nextOffset,setNextOffset]=useState<number|null>(null);
  const [customFrom,setCustomFrom]=useState("");const [customTo,setCustomTo]=useState("");
  const refreshVersion=useRef(0);
  const expandedPages=useRef(false);
  const [query,setQuery]=useState(""); const [date,setDate]=useState(""); const [app,setApp]=useState("");
  const [error,setError]=useState(""); const [notice,setNotice]=useState("");const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);const [expanded,setExpanded]=useState<string|null>(null);
  const [detail,setDetail]=useState<HistoryActivity|null>(null);
  const [setup,setSetup]=useState(false); const [clearRange,setClearRange]=useState<Record<string,unknown>|null>(null);
  const [external,setExternal]=useState<boolean|null>(null);const [processing,setProcessing]=useState("");
  const [modelLabel,setModelLabel]=useState("");const [diagnostics,setDiagnostics]=useState<HistoryDiagnostics>();
  const [rules,setRules]=useState<{appMode:"include"|"exclude";apps:string;siteMode:"include"|"exclude";sites:string}|null>(null);
  const refresh=useCallback(async()=>{
    const version=++refreshVersion.current;
    try {
      const [config,page,memory]=await Promise.all([client.settings(),client.query({query,app,...(date?{from:new Date(`${date}T00:00:00`).toISOString(),to:new Date(`${date}T23:59:59.999`).toISOString()}: {})}),client.memories()]);
      if(version!==refreshVersion.current)return;
      setSettings(config);setActivities(page.items);setNextOffset(page.nextOffset??null);setMemories(memory.items);setMemoryFile(memory.memoryFile);setError("");
    }catch(e){if(version===refreshVersion.current)setError(e instanceof Error?e.message:"暂时无法读取记录。");}finally{if(version===refreshVersion.current)setLoading(false);}
  },[client,query,date,app]);
  useEffect(()=>{expandedPages.current=false;void refresh();const timer=setInterval(()=>{if(!expandedPages.current)void refresh();},5000);return()=>{clearInterval(timer);refreshVersion.current++;};},[refresh]);
  useEffect(()=>{let done=false;const update=()=>void client.status().then(s=>{if(!done){setExternal(s.external.available);setModelLabel([s.processing.provider,s.processing.model].filter(Boolean).join(" · "));setDiagnostics(s.diagnostics);setProcessing(s.processing.error??(s.processing.active?"正在整理活动，原始记录已可查看。":""));}}).catch(()=>{if(!done)setProcessing("整理服务暂未连接，已有记录仍可本地查看。");});update();const timer=setInterval(update,5000);return()=>{done=true;clearInterval(timer);};},[client,settings?.revision]);
  useEffect(()=>{
    if(!nativePetAvailable())return;
    let disposed=false;const cleanups:Array<()=>void>=[];
    const checkClear=async()=>{try{if(await petCommand<boolean>("history_take_clear_request")){const page=await client.query();const latest=page.items[0];if(latest)setClearRange({groupId:latest.id,label:`${latest.app} · ${latest.summary?.title||latest.title}`});else setNotice("没有可清理的活动。");}}catch(e){setError(String(e));}};
    void checkClear();
    void listen("latitude://history-open",()=>void checkClear()).then(fn=>{if(disposed)fn();else cleanups.push(fn);});
    for(const name of ["latitude://history-state","latitude://history-settings"]){void listen(name,()=>{if(!expandedPages.current)void refresh();else void client.settings().then(setSettings).catch(()=>{});}).then(fn=>{if(disposed)fn();else cleanups.push(fn);});}
    return()=>{disposed=true;cleanups.forEach(fn=>fn());};
  },[refresh]);
  async function change(patch:Partial<HistorySettings["config"]>){
    if(!settings)return;setBusy(true);setError("");setNotice("");
    try{setSettings(await client.configure({...settings,config:{...settings.config,...patch}}));if(nativePetAvailable())await petCommand("history_apply_settings");setSetup(false);setNotice("设置已保存。");await refresh();return true;}
    catch(e){setError(e instanceof Error?e.message:"设置未保存，请重试。");return false;}finally{setBusy(false);}
  }
  async function reveal(item:HistoryActivity){
    if(expanded===item.id){setExpanded(null);setDetail(null);return;}
    setExpanded(item.id);setDetail(null);
    try{const page=await client.query({groupId:item.id,includeContent:true});setDetail(page.items[0]??null);}catch(e){setError(String(e));}
  }
  async function clear(){
    if(!clearRange)return;setBusy(true);
    try{await client.clear(clearRange);setClearRange(null);setExpanded(null);setDetail(null);setNotice("所选记录及相关摘要已清理。ChatGPT 原有记录和已经显示的聊天文字不受影响。");await refresh();}
    catch(e){setError(e instanceof Error?e.message:"清理未完成。");}finally{setBusy(false);}
  }
  async function memoryChange(remove=false){
    if(!editingMemory)return;setBusy(true);
    try{const result=remove?await client.removeMemory(editingMemory.id):await client.reviewMemory(editingMemory.id,editingMemory.statement);setMemories(result.items);setEditingMemory(null);setNotice(remove?"这条认识已移除，同一份依据不会自动重新生成。":"已保存你的修正，后续回答以此为准。");await refresh();}
    catch(e){setError(e instanceof Error?e.message:"认识未保存。");}finally{setBusy(false);}
  }
  const state=settings?.collector;
  const stale=!state?.lastSeenAt||Date.now()-Date.parse(state.lastSeenAt)>15000;
  const label=!settings?.config.enabled?"未开启":settings.config.paused?"已暂停":!settings.config.nativeEnabled?(settings.config.externalEnabled?(external===true?"正在读取已有历史":"等待已有历史连接"):"未选择记录来源"):stale?"等待原生记录连接":state?.state==="permission_required"?"需要系统授权":state?.state==="locked"?"系统暂停":["private_excluded","browser_permission_required","browser_privacy_unavailable","window_unavailable"].includes(state?.coverage??"")?"已开启，当前活动未记录":state?.state==="running"?"正在记录":"记录暂不可用";
  return <section className="history-panel" aria-label="电脑操作行为记录" id="computer-history-settings">
    <header className="history-heading"><div><span className="dim-eyebrow">记录与记忆</span><h3><History size={19}/>电脑操作行为记录</h3><p className="dim-meta">找回看过的资料，接着上次的工作。</p></div>
      <span className={`history-state ${label==="正在记录"?"is-running":""}`} role="status">{loading?"正在读取…":label}</span></header>
    {error&&<p role="alert" className="history-error">{error} <button className="dim-btn dim-btn--quiet" onClick={()=>void refresh()}>重试</button></p>}
    {notice&&<p role="status" className="dim-meta">{notice}</p>}
    {settings&&<>
      <div className="history-controls"><label className="history-switch"><input type="checkbox" role="switch" aria-label="开启电脑操作行为记录" checked={settings.config.enabled} disabled={busy}
        onChange={e=>e.target.checked?setSetup(true):void change({enabled:false})}/><span>记录电脑操作行为</span></label>
        {settings.config.enabled&&<button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>void change({paused:!settings.config.paused})}>{settings.config.paused?<Play size={14}/>:<Pause size={14}/>} {settings.config.paused?"恢复记录":"暂停记录"}</button>}
      </div>
      {setup&&<div className="history-setup" role="group" aria-label="开启记录说明"><h4>从现在开始，帮你记住电脑上的活动</h4><p>记录允许的应用和网站中可读取的内容，原始记录最长保留 48 小时。无痕浏览和安全输入不进入记录；不保存截图或音频。</p><p>开启下方「使用当前模型整理」后，相关内容会发送给维度当前选择的模型。摘要与记忆保存在本机，可随时清理。</p>
        {!nativePetAvailable()&&<p>原生记录需要在维度桌面版运行；这里可以管理已经连接的记录。</p>}
        <div className="history-actions"><button className="dim-btn dim-btn--quiet" onClick={()=>setSetup(false)}>暂不开启</button><button className="dim-btn" disabled={busy} onClick={async()=>{const saved=await change({enabled:true,paused:false});if(saved&&nativePetAvailable())await petCommand("history_request_permission").catch(e=>setError(String(e)));}}>开启记录</button></div></div>}
      {settings.config.enabled&&!settings.config.paused&&state?.permission===false&&nativePetAvailable()&&<button className="dim-btn" onClick={()=>void petCommand("history_request_permission").catch(e=>setError(String(e)))}>完成系统授权</button>}
      {settings.config.enabled&&coverageLabel[state?.coverage??""]&&<p className="dim-meta">{coverageLabel[state?.coverage??""]}</p>}
      {state?.error&&<p className="history-error">{state.error}</p>}
      <details className="history-rules"><summary><Settings2 size={15}/>记录范围与处理方式</summary>
        <label className="history-switch"><input type="checkbox" checked={settings.config.nativeEnabled} disabled={busy} onChange={e=>void change({nativeEnabled:e.target.checked})}/>使用维度原生记录</label>
        <label className="history-switch"><input type="checkbox" checked={settings.config.modelProcessing} disabled={busy} onChange={e=>void change({modelProcessing:e.target.checked})}/>使用当前模型整理与查询记录</label><p className="dim-meta">{modelLabel?`当前模型：${modelLabel}。`:"尚未读到当前模型配置。"}使用云模型时，相关内容会发送给该供应商。关闭后仍可在这里查看记录。</p>
        <div className="history-rule-grid"><label>应用范围<select value={rules?.appMode??settings.config.appMode} onChange={e=>setRules({...rules??{appMode:settings.config.appMode,siteMode:settings.config.siteMode,apps:settings.config.apps.join("\n"),sites:settings.config.sites.join("\n")},appMode:e.target.value as "include"|"exclude"})}><option value="exclude">排除这些应用</option><option value="include">只记录这些应用</option></select><textarea aria-label="应用名单" placeholder="每行一个应用名称或应用标识" value={rules?.apps??settings.config.apps.join("\n")} onChange={e=>setRules({...rules??{appMode:settings.config.appMode,siteMode:settings.config.siteMode,apps:"",sites:settings.config.sites.join("\n")},apps:e.target.value})}/></label>
        <label>网站范围<select value={rules?.siteMode??settings.config.siteMode} onChange={e=>setRules({...rules??{appMode:settings.config.appMode,siteMode:settings.config.siteMode,apps:settings.config.apps.join("\n"),sites:settings.config.sites.join("\n")},siteMode:e.target.value as "include"|"exclude"})}><option value="exclude">排除这些网站</option><option value="include">只记录这些网站</option></select><textarea aria-label="网站名单" placeholder="每行一个域名，如 example.com" value={rules?.sites??settings.config.sites.join("\n")} onChange={e=>setRules({...rules??{appMode:settings.config.appMode,siteMode:settings.config.siteMode,apps:settings.config.apps.join("\n"),sites:""},sites:e.target.value})}/></label></div>
        <p className="dim-meta">范围改变影响之后的记录和导入，已有记录可在下方清理。</p><button className="dim-btn" disabled={busy||!rules} onClick={async()=>{if(rules&&await change({...rules,apps:lines(rules.apps),sites:lines(rules.sites)}))setRules(null);}}>保存范围</button>
        <div className="history-external"><h4>连接已有 ChatGPT 历史</h4><p className="dim-meta">{external===true?"发现本机已有活动分段，可以连接读取。":external===false?"尚未发现可读取的本机历史，请检查 ChatGPT 是否已开启记录及文件访问权限。":"正在检查本机来源…"}</p><label className="history-switch"><input type="checkbox" checked={settings.config.externalEnabled} disabled={busy||external===false&&!settings.config.externalEnabled} onChange={e=>void change({externalEnabled:e.target.checked,externalMode:"continuous"})}/>读取已有及后续历史</label><button className="dim-btn dim-btn--quiet" disabled={busy||external!==true||!settings.config.enabled} onClick={()=>void change({externalEnabled:true,externalMode:"once"})}>仅导入目前已有的记录</button><p className="dim-meta">单次导入完成后自动断开；需要先开启上方记录开关。</p><p className="dim-meta">只读取本机已有数据，不改动 ChatGPT 的记录开关；清理维度副本不影响上游。</p></div>
      </details>
    </>}
    <div className="history-timeline-heading"><h4>活动时间线</h4><button className="dim-btn dim-btn--quiet" onClick={()=>onAsk("根据电脑操作行为记录，回顾我今天做了什么。请给出来源，并说明未读到的部分。")}>问问今天的记录</button></div>
    {processing&&<p className="dim-meta">{processing}</p>}
    {settings?.config.paused&&<p className="dim-meta">暂停期间不接收新活动；之前保存的资料仍可整理和查询。</p>}
    <div className="history-filters"><label className="history-search"><Search size={15}/><input aria-label="搜索活动" placeholder="搜索资料或活动" value={query} onChange={e=>setQuery(e.target.value)}/></label><input aria-label="活动日期" type="date" value={date} onChange={e=>setDate(e.target.value)}/><input aria-label="筛选应用" placeholder="应用名称" value={app} onChange={e=>setApp(e.target.value)}/></div>
    {!loading&&!activities.length&&<p className="history-empty">{query||date||app?"没有找到匹配的记录，可以调整筛选。":settings?.config.enabled?"真实活动保存后会显示在这里，摘要会随后整理。":"开启后，实际记录的活动会出现在这里。"}</p>}
    <ol className="history-timeline">{activities.map(item=><li key={item.id}><div className="history-item-heading"><time dateTime={item.from}>{time(item.from)}</time><span>{item.app} · {item.providers.map(p=>p==="latitude"?"维度":"ChatGPT").join("、")}</span></div><h4>{item.summary?.title||item.title||"活动记录"}</h4><p>{item.summary?.text||"尚未生成摘要，可以展开查看已记录的内容。"}</p>{item.summaryStale&&<p className="dim-meta">这段活动补充了新材料，摘要正在等待更新。</p>}{item.summary?.uncertainty&&<p className="dim-meta">{item.summary.uncertainty}</p>}
      <div className="history-actions"><button className="dim-btn dim-btn--quiet" onClick={()=>void reveal(item)}><ChevronDown size={14}/>{expanded===item.id?"收起依据":"查看依据"}</button><button className="dim-btn dim-btn--quiet" onClick={()=>onAsk(`查看活动 ${item.id} 的原文，告诉我当时在做什么、可以怎样继续。`)}>接着聊</button>{item.url&&/^(https?|file):\/\//u.test(item.url)&&<a className="dim-btn dim-btn--quiet" href={item.url} onClick={event=>{if(nativePetAvailable()){event.preventDefault();void petCommand("history_open_source",{groupId:item.id}).catch(e=>setError(String(e)));}else if(item.url?.startsWith("file:")){event.preventDefault();setError("本地文件请在维度桌面版打开。");}}} target="_blank" rel="noreferrer"><ExternalLink size={14}/>打开来源</a>}<button className="dim-btn dim-btn--quiet" aria-label={`删除${item.summary?.title||item.title||"活动"}`} onClick={()=>setClearRange({groupId:item.id})}><Trash2 size={14}/></button></div>
      {expanded===item.id&&<div className="history-evidence">{detail?detail.events.map(event=><div key={event.id}><time>{time(event.observedAt)}</time><p>{event.expired?"原始记录已到期。":event.content?.visibleText||"仅记录到页面或窗口信息，未读取到正文。"}</p></div>):<p role="status">正在读取依据…</p>}</div>}
      {item.summary?.suggestion&&!item.summary.suggestion.dismissed&&<div className="history-suggestion"><strong>{item.summary.suggestion.title}</strong><p>根据这段活动准备一个可审阅的工作方式。</p><button className="dim-btn" onClick={()=>{setPrepareGroup(item.id);setTimeout(()=>document.getElementById("history-workflows")?.scrollIntoView({block:"nearest"}),100);}}>帮我准备</button><button className="dim-btn dim-btn--quiet" onClick={async()=>{try{await client.dismissSuggestion(item.id);await refresh();}catch(e){setError(String(e));}}}>暂不需要</button></div>}
    </li>)}</ol>
    {nextOffset!==null&&<button className="dim-btn dim-btn--quiet" disabled={busy} onClick={async()=>{expandedPages.current=true;setBusy(true);try{const page=await client.query({query,app,offset:nextOffset,...(date?{from:new Date(`${date}T00:00:00`).toISOString(),to:new Date(`${date}T23:59:59.999`).toISOString()}: {})});setActivities(items=>[...items,...page.items]);setNextOffset(page.nextOffset??null);}catch(e){setError(String(e));}finally{setBusy(false);}}}>查看更早活动</button>}
    <HistoryWorkflows client={client} prepareGroup={prepareGroup} onPrepared={prepared} onAsk={onAsk} revision={settings?.revision}/>
    <div className="history-memories"><h4>从活动中整理的认识</h4><p className="dim-meta">这些认识带有活动来源，可以修正或移除。一次浏览不代表你的观点。</p>
      {memoryFile&&<details className="history-rules"><summary>本地记忆文件</summary><p className="dim-meta">可在本机编辑认识文字，或标记忘记。修改会同步到应用；来源由维度保留。</p><p className="dim-meta">{memoryFile.path}</p>{nativePetAvailable()&&<button className="dim-btn dim-btn--quiet" onClick={()=>void petCommand("history_reveal_memory").catch(e=>setError(String(e)))}>在 Finder 中显示</button>}{memoryFile.error&&<><p role="alert" className="history-error">{memoryFile.error}</p><button className="dim-btn dim-btn--quiet" onClick={async()=>{try{await client.restoreMemoryFile();await refresh();setNotice("文件已恢复为应用中的有效认识。");}catch(e){setError(String(e));}}}>用应用中的有效版本恢复文件</button></>}</details>}
      {!memories.length&&<p className="history-empty">暂时没有适合长期保留的认识。</p>}
      {memories.map(memory=><article className="history-memory" key={memory.id}><p>{memory.statement}</p><span className="dim-meta">{memory.status==="user_corrected"?"你已修正":"根据活动形成的观察"}</span><div className="history-actions"><button className="dim-btn dim-btn--quiet" onClick={()=>onAsk(`查阅这些活动的来源，解释这条认识的依据和不确定性：${memory.groupIds.join("、")}。认识：${memory.statement}`)}>查看依据</button><button className="dim-btn dim-btn--quiet" onClick={()=>setEditingMemory({id:memory.id,statement:memory.statement})}>修正或移除</button></div></article>)}
      {editingMemory&&<div className="history-setup" role="group" aria-label="修正认识"><label>你希望维度怎样理解？<textarea aria-label="认识内容" value={editingMemory.statement} onChange={e=>setEditingMemory({...editingMemory,statement:e.target.value})}/></label><div className="history-actions"><button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>setEditingMemory(null)}>取消</button><button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>void memoryChange(true)}>移除这条认识</button><button className="dim-btn" disabled={busy||!editingMemory.statement.trim()} onClick={()=>void memoryChange()}>保存修正</button></div></div>}
    </div>
    <details className="history-rules"><summary>记录覆盖与诊断</summary><p className="dim-meta">{state?.lastSeenAt?`最近检查：${time(state.lastSeenAt)}`:"尚未收到原生采集状态。"} {coverageLabel[state?.coverage??""]||"下面列出维度实际保存过的范围；日期跨度不代表连续记录。"}</p>{diagnostics?.sources.length?diagnostics.sources.map((source,index)=><p className="dim-meta" key={index}>{source.app} · {source.provider==="latitude"?"维度":"ChatGPT"} · {time(source.from)} 至 {time(source.to)} · {source.coverage==="partial"?"已读取部分正文":"只有页面定位信息"}</p>):<p className="dim-meta">尚无已保存来源。开启后，请先在允许的应用完成一段操作，再回来查看。</p>}</details>
    <details className="history-clear"><summary><Trash2 size={14}/>清理记录</summary><p className="dim-meta">清理对应原始记录及摘要，相关认识将按剩余依据处理。此操作不能撤销。</p><div className="history-actions">{[["最近 10 分钟",600000],["最近 1 小时",3600000],["最近 1 天",86400000]].map(([label,ms])=><button className="dim-btn dim-btn--quiet" key={label} onClick={()=>setClearRange({from:new Date(Date.now()-Number(ms)).toISOString()})}>{label}</button>)}<button className="dim-btn dim-btn--quiet" onClick={()=>setClearRange({})}>全部记录</button></div></details>
    <details className="history-clear"><summary>按时段或应用清理</summary><div className="history-rule-grid"><label>开始时间<input aria-label="清理开始时间" type="datetime-local" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}/></label><label>结束时间<input aria-label="清理结束时间" type="datetime-local" value={customTo} onChange={e=>setCustomTo(e.target.value)}/></label></div><p className="dim-meta">{app?`仅清理 ${app} 的活动。`:"清理全部应用；可使用上方应用筛选缩小范围。"}</p><button className="dim-btn dim-btn--quiet" disabled={!customFrom||!customTo||customFrom>customTo} onClick={()=>setClearRange({from:new Date(customFrom).toISOString(),to:new Date(customTo).toISOString(),...(app?{app}:{})})}>清理所选时段</button>{app&&<button className="dim-btn dim-btn--quiet" onClick={()=>setClearRange({app})}>清理 {app} 的已有记录</button>}</details>
    {clearRange&&<div className="history-confirm" role="alertdialog" aria-label="确认清理记录"><h4>清理{clearRange.groupId?String(clearRange.label||"这项活动"):clearRange.from?`${time(String(clearRange.from))} 至 ${clearRange.to?time(String(clearRange.to)):"现在"} 的记录`:"全部记录"}{clearRange.app?`（${clearRange.app}）`:""}？</h4><p>相关原始记录与摘要将被清理，无法撤销。记录开关保持当前状态。</p><div className="history-actions"><button className="dim-btn dim-btn--quiet" disabled={busy} onClick={()=>setClearRange(null)}>取消</button><button className="dim-btn" disabled={busy} onClick={()=>void clear()}>{busy?"正在清理…":"确认清理"}</button></div></div>}
  </section>;
}
