import { desktopFetch, nativePetAvailable } from "../pet/nativePet";
export interface HistoryConfig {
  enabled: boolean; paused: boolean; nativeEnabled: boolean; externalEnabled: boolean; modelProcessing: boolean;
  appMode: "include" | "exclude"; apps: string[]; siteMode: "include" | "exclude"; sites: string[];
  externalMode?: "once"|"continuous";
}
export interface HistorySettings { revision: number; config: HistoryConfig; collector: { state?: string; permission?: boolean; lastSeenAt?: string; error?: string; coverage?: string } }
export interface HistoryEvent { id: string; evidenceRefId: string; observedAt: string; expired: boolean; content?: {visibleText?: string; windowTitle?: string; url?: string; actorRole?: string} }
export interface HistoryActivity {
  id: string; from: string; to: string; app: string; title: string; url?: string; coverage: string; providers: string[]; events: HistoryEvent[];
  summaryStale?:boolean;
  summary?: {title: string; text: string; uncertainty?: string; suggestion?: {kind: string; title: string; prompt: string;dismissed?:boolean}};
}
export interface HistoryMemory {id:string;statement:string;status:string;groupIds:string[];updatedAt:string}
export interface HistoryMemoryResult {items:HistoryMemory[];memoryFile?:{path:string;error?:string;recoveryPath:string}}
export interface HistoryWorkflow {groupId:string;version:string;title:string;prompt:string;cadence:"manual"|"daily"|"weekly";at:string;weekday:number;state:"draft"|"enabled"|"disabled";trialCompleted?:boolean;lastRun?:{runId:string;status:string;text?:string;error?:string;finishedAt?:string}}
export interface HistoryDiagnostics {sources:{provider:string;app:string;coverage:string;from:string;to:string}[]}
export function createHistoryClient(fetchImpl: typeof fetch = nativePetAvailable() ? desktopFetch : fetch) {
  async function request<T>(route: string, body?: unknown, agent = false): Promise<T> {
    const response = await fetchImpl(`http://127.0.0.1:${agent ? 43120 : 43121}/v1/${agent ? "agent/history" : "history"}/${route}`, {
      method: body === undefined ? "GET" : "POST", headers: {"content-type":"application/json"},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message ?? data.error?.message ?? `记录服务暂不可用（${response.status}），请重试。`);
    }
    return response.json();
  }
  return {
    settings: () => request<HistorySettings>("settings"),
    configure: (settings: HistorySettings) => request<HistorySettings>("settings", {revision:settings.revision, config:settings.config}),
    query: (input: Record<string,unknown> = {}) => request<{items:HistoryActivity[]; hasMore:boolean;nextOffset?:number|null}>("query",input),
    memories:()=>request<HistoryMemoryResult>("memory",{action:"list"}),
    reviewMemory:(id:string,statement:string)=>request<HistoryMemoryResult>("memory",{action:"review",id,statement}),
    removeMemory:(id:string)=>request<HistoryMemoryResult>("memory",{action:"remove",id}),
    restoreMemoryFile:()=>request<HistoryMemoryResult>("memory",{action:"restoreFile"}),
    workflows:(input:Record<string,unknown>={action:"list"})=>request<{items:HistoryWorkflow[]}>("workflow",input,true),
    dismissSuggestion:(groupId:string)=>request<{saved:boolean}>("suggestion",{action:"dismiss",groupId}),
    clear: (input: Record<string,unknown>) => request<{deleted:number}>("clear",{...input,confirm:"删除记录"}),
    status: () => request<HistorySettings & {external:{available:boolean};diagnostics?:HistoryDiagnostics;processing:{error?:string;active?:boolean;provider?:string;model?:string}}>("status",undefined,true),
  };
}
export type HistoryClient = ReturnType<typeof createHistoryClient>;
