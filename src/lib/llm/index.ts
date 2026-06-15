import type {
  LLMProvider,
  ParseTaskResult,
  LLMUsage,
  LLMCapabilities,
  ChatMessage,
  ChatOptions,
  ChatResult,
  StreamHandlers,
} from "./types";
import { DeepSeekProvider } from "./deepseek";
import { MockProvider } from "./mock";
import type { Priority, Todo, ScheduleUpdate } from "../store";
import { useTodoStore } from "../store";
import {
  onProviderConfigChange,
  useSettingsStore,
  readSettingsSnapshot,
  type ProviderName
} from "../settings";
import { dbInsertUsage, dbGetRecentDigests } from "../db";
import { toolsForLLM, runChatTool } from "../chatTools";
import { useGoalsStore, type Goal } from "../goalsStore";
import i18n from "../i18n";
import { composePersonaPrompt } from "../persona/personaSpec";
import type { Lang } from "../settings";

/** 近期纪要注入的天数上限(近 7 天)。 */
const RECENT_DIGEST_DAYS = 7;

export type { LLMProvider, ChatMessage, ChatOptions, ChatResult, StreamHandlers, LLMUsage } from "./types";

/**
 * Provider 工厂
 *
 * 数据源:Settings store(优先) → .env.local(开发兜底)。
 * Settings 改 provider/key 时,通过 onProviderConfigChange 回调失效缓存。
 */

let _provider: LLMProvider | null = null;

// 注册一次:settings 变化时把缓存清掉
onProviderConfigChange(() => {
  _provider = null;
});

export function getProvider(): LLMProvider {
  if (_provider) return _provider;

  // 直读 localStorage 真相源:provider/key 变更后缓存会被清掉并重建,
  // 重建时必须读最新配置,不能用可能是陈旧快照的 useSettingsStore.getState()。
  const s = readSettingsSnapshot();
  const name: ProviderName = s.llmProvider;

  if (name === "deepseek") {
    const cfg = s.providers.deepseek;
    if (!cfg.apiKey) {
      console.warn(
        "[LLM] DeepSeek API key 未配置,降级 Mock。在 Settings 里填入即可启用。"
      );
      _provider = new MockProvider();
    } else {
      _provider = new DeepSeekProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl ?? "https://api.deepseek.com",
        model: cfg.model ?? "deepseek-chat"
      });
    }
  } else {
    console.warn(`[LLM] provider "${name}" 暂未实现,降级 Mock`);
    _provider = new MockProvider();
  }

  return _provider;
}

export function getProviderName(): string {
  return getProvider().name;
}

/* ---------- 单一收口层(Brain seam)---------- */
/**
 * 所有「大脑调用」的唯一非流式收口。
 *
 * 为什么要这层(评审要求 + Phase 4 铺路):
 *   重构前 parseTask / generateTodayPlan / chatAgentCall 各自 getProvider().chat(...),
 *   provider 调用点散落四处。收成一个 callBrain 后,Phase 4 要抽统一适配器、加重试、
 *   加可观测、做模型路由,只改这一处即可,不必到处找。
 *
 * 无状态(C1):每次调用都由调用方传入完整 messages(系统提示词 + 历史),
 *   本层不持有任何会话状态、不依赖引擎侧 session/resume。
 *
 * @param messages 完整上下文(含 system),调用方负责拼好
 * @param opts     ChatOptions + recordAs:
 *                 - recordAs 给定 → 记一条 usage(feature=该值);
 *                 - recordAs 省略 → 不记 usage(裸调用 generateOnce 用)
 */
async function callBrain(
  messages: ChatMessage[],
  opts: ChatOptions & { recordAs?: string } = {}
): Promise<ChatResult> {
  const provider = getProvider();
  const { recordAs, ...chatOpts } = opts;
  const result = await provider.chat(messages, chatOpts);
  if (recordAs) recordUsage(provider, result.usage, recordAs, result.model);
  return result;
}

/** 流式收口(对应 callBrain 的 SSE 版);Chat 流式对话走这里。 */
async function callBrainStream(
  messages: ChatMessage[],
  opts: ChatOptions & { recordAs?: string },
  handlers: StreamHandlers
): Promise<ChatResult> {
  const provider = getProvider();
  const { recordAs, ...chatOpts } = opts;
  const result = await provider.chatStream(messages, chatOpts, handlers);
  if (recordAs) recordUsage(provider, result.usage, recordAs, result.model);
  return result;
}

/**
 * 当前 provider 在「将要使用的 model」下的能力位。
 *
 * 上层据此降级:不支持工具就别传 tools、不支持推理就别等思考链。
 * @param model 不传则按 provider 当前默认 model
 */
export function getCapabilities(model?: string): LLMCapabilities {
  return getProvider().capabilities(model);
}

/**
 * 裸调用(C3):给「试一句」和主动消息合成用。
 *
 * 特点:不绑会话、不写 DB、不记 usage、不调工具——就是「拿系统提示词 + 一段消息,
 * 同一个 provider 出一段文本」。和会话 turn(sendMessage→chatAgentCall)并列为
 * 仅有的两个对外语义入口,底层都收口到 callBrain。
 *
 * @returns 模型输出的纯文本
 */
export async function generateOnce(
  systemPrompt: string,
  messages: ChatMessage[],
  opts?: ChatOptions
): Promise<string> {
  const full: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];
  // 不传 recordAs → 不记 usage;不传 tools → 不调工具。裸到底。
  const result = await callBrain(full, {
    temperature: 0.5,
    maxTokens: 1500,
    ...opts,
  });
  return result.content;
}

/* ---------- 高层 API ---------- */

const PARSE_TASK_SYSTEM = `你是一个任务解析助手。用户会说一段中文自然语言(可能描述一个待办事项),你要把它解析成结构化 JSON。

只输出 JSON,不要解释。字段如下:
- title (string,必填):任务的简短标题,不超过 30 字。
- reason (string,可选):为什么现在/某时段做这件事。能从原文推断就填,推断不出来就别填。
- deadline (string,可选):截止时间,保留原文措辞("明天下午"/"周五前"/"今天 18:00")或转 ISO("2026-05-10")。
- priority (string,必填):"high" / "medium" / "low" / "none"。原文有"紧急/重要/必须"等给 high,有"顺便/有空"等给 low,无线索给 none。
- tags (array of string,必填):领域标签,最多 3 个,例如 ["客户 A", "方案"]、["会议"]、["阅读"]。原文里出现具体人/项目/类型就提取。无线索给 [] 。
- estTime (string,可选):预估耗时,"15m" / "1h" / "1.5h" / "2h" 等。原文有时间长度就解析,没有就别填。
- scheduledTime (string,可选):建议执行时段,"09:30-11:00" 格式。除非原文明确写了某段时间,否则别瞎猜。

例子:
输入:"明天下午给客户 A 过 Q3 营销方案,大概要一个半小时"
输出:{"title":"给客户 A 过 Q3 营销方案","priority":"medium","tags":["客户 A","方案"],"deadline":"明天下午","estTime":"1.5h"}

输入:"报销上月差旅费 18 点前必须搞完"
输出:{"title":"报销上月差旅费","priority":"high","tags":["行政"],"deadline":"今天 18:00","estTime":"15m"}`;

/**
 * 把用户输入解析成 Todo 字段
 *
 * 调用方:TopBar 的 Cmd+K 输入。
 * 失败 fallback:用原文当 title,parsed=false,UI 应该提示"解析失败,已存原文"。
 */
export async function parseTask(input: string): Promise<ParseTaskResult> {
  const provider = getProvider();

  // Mock provider 直接返回兜底
  if (provider.name === "mock") {
    return {
      title: input.slice(0, 80),
      priority: "none",
      tags: [],
      parsed: false
    };
  }

  try {
    // 收口到 callBrain;recordAs 让它顺手记 usage(feature=parseTask)
    const result = await callBrain(
      [
        { role: "system", content: PARSE_TASK_SYSTEM },
        { role: "user", content: input }
      ],
      { temperature: 0.2, responseFormat: "json", maxTokens: 400, recordAs: "parseTask" }
    );

    const json = JSON.parse(result.content) as Partial<ParseTaskResult> & {
      title?: string;
      priority?: string;
      tags?: unknown;
    };

    return {
      title: typeof json.title === "string" && json.title ? json.title : input.slice(0, 80),
      reason: typeof json.reason === "string" ? json.reason : undefined,
      deadline: typeof json.deadline === "string" ? json.deadline : undefined,
      priority: normalizePriority(json.priority),
      tags: Array.isArray(json.tags)
        ? (json.tags as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3)
        : [],
      estTime: typeof json.estTime === "string" ? json.estTime : undefined,
      scheduledTime:
        typeof json.scheduledTime === "string" ? json.scheduledTime : undefined,
      parsed: true
    };
  } catch (err) {
    console.error("[LLM] parseTask failed:", err);
    return {
      title: input.slice(0, 80),
      priority: "none",
      tags: [],
      parsed: false
    };
  }
}

function normalizePriority(v: unknown): Priority {
  return v === "high" || v === "medium" || v === "low" ? v : "none";
}

/* ---------- generateTodayPlan ---------- */

const PLAN_SYSTEM = `你是日程编排助手。

输入是一组用户今天的待办任务,你要给每个任务安排一个具体时段(scheduledTime),让一天高效不冲突。

约束:
1. 默认工作时段 09:00-18:00,非工作时段(早晨/夜晚)只在任务带"早起/夜跑"等明显时间线索时用
2. 任务时长按 estTime("15m"/"1h"/"1.5h"/"2h"),没标记按 1h
3. 时段不重叠,且每个任务至少留 5 分钟缓冲
4. 已有合理 scheduledTime 的尽量保留
5. high 优先级排在精力充沛时段(上午)
6. 12:00-13:00 留给午休,不安排任务
7. 拖延任务(标记 isProcrastinated)优先排,且早一点
8. 时段格式严格 "HH:MM-HH:MM"(24 小时制)

输出 JSON 对象,字段 plan 是 array,每项 {"id": "<原 id>", "scheduledTime": "HH:MM-HH:MM"}。
只输出 JSON,不要解释文字。`;

/**
 * AI 排今日:把 todos 重新排到具体时段,落 db,更新 store
 */
export async function generateTodayPlan(todos: Todo[]): Promise<void> {
  if (todos.length === 0) return;

  const provider = getProvider();

  let updates: ScheduleUpdate[] = [];

  if (provider.name === "mock") {
    // mock 兜底:从 09:00 开始按 estTime 顺序排,默认 1h
    let cur = 9 * 60;
    updates = todos.map((todo) => {
      const dur = parseEstMinutes(todo.estTime) ?? 60;
      const start = cur;
      const end = cur + dur;
      cur = end + 5; // 5 分钟缓冲
      // 跳午休
      if (start < 13 * 60 && end > 12 * 60) cur = 13 * 60;
      return {
        id: todo.id,
        scheduledTime: `${formatHM(start)}-${formatHM(end)}`
      };
    });
  } else {
    // 真 LLM
    const list = todos.map((t) => ({
      id: t.id,
      title: t.title,
      reason: t.reason,
      estTime: t.estTime,
      priority: t.priority,
      scheduledTime: t.scheduledTime,
      isProcrastinated: t.isProcrastinated
    }));

    try {
      const result = await callBrain(
        [
          { role: "system", content: PLAN_SYSTEM + telosContextSection() },
          { role: "user", content: JSON.stringify(list) }
        ],
        { temperature: 0.3, responseFormat: "json", maxTokens: 1200, recordAs: "generateTodayPlan" }
      );
      const parsed = JSON.parse(result.content) as
        | { plan?: Array<{ id?: string; scheduledTime?: string }> }
        | Array<{ id?: string; scheduledTime?: string }>;
      const items = Array.isArray(parsed) ? parsed : (parsed.plan ?? []);
      updates = items
        .filter(
          (x): x is { id: string; scheduledTime: string } =>
            !!x.id && !!x.scheduledTime
        )
        .map((x) => ({ id: x.id, scheduledTime: x.scheduledTime }));
    } catch (err) {
      console.error("[LLM] generateTodayPlan failed:", err);
      throw err;
    }
  }

  if (updates.length === 0) return;
  await useTodoStore.getState().applySchedules(updates);
}

/** "1.5h" → 90 / "30m" → 30 / "1h" → 60 / 不识别 → null */
function parseEstMinutes(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^([\d.]+)\s*(h|m)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return Math.round(m[2].toLowerCase() === "h" ? n * 60 : n);
}

function formatHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 把 Telos goals 拼成一段 system prompt 附加文字
 * 给 generateTodayPlan / Chat 等让 LLM "记得"用户的长期方向
 */
export function telosContextSection(): string {
  const goals = useGoalsStore.getState().goals.filter((g) => g.status === "active");
  if (goals.length === 0) return "";
  const yearly = goals.filter((g) => g.period === "year");
  const quarterly = goals.filter((g) => g.period === "quarter");
  const monthly = goals.filter((g) => g.period === "month");
  const parts: string[] = ["\n\n用户的长期目标(Telos),编排今日时尽量与之对齐:"];
  if (yearly.length) parts.push("- 年度:" + yearly.map(formatGoal).join("、"));
  if (quarterly.length) parts.push("- 本季:" + quarterly.map(formatGoal).join("、"));
  if (monthly.length) parts.push("- 本月:" + monthly.map(formatGoal).join("、"));
  return parts.join("\n");
}

function formatGoal(g: Goal): string {
  return g.description ? `${g.title}(${g.description})` : g.title;
}

/**
 * 记录一次 LLM 调用的 usage(异步,不阻塞主流程,失败不影响业务)
 * actualModel 优先,反映 ChatOptions.model 覆盖后的实际 model(比如 chat 切到 deepseek-reasoner)
 */
function recordUsage(
  provider: LLMProvider,
  usage: LLMUsage | undefined,
  feature: string,
  actualModel?: string
) {
  if (!usage) return;
  void dbInsertUsage({
    provider: provider.name,
    model: actualModel ?? provider.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    feature
  }).catch((err) => console.warn("[LLM] usage insert failed:", err));
}

/* ---------- Chat 高层 API ---------- */

/**
 * 构造一段当前上下文 system prompt:今天 todos + 当前时间 + Telos + 近期每日纪要
 *
 * 让 Chat 知道:
 *   - 用户今天在做什么(待办)
 *   - 长期想去哪里(Telos)
 *   - 最近几天发生了什么(daily_digest 注入,Task 1.3)
 *
 * 变为 async 是为了从 DB 读取 daily_digest 近期纪要。
 * 调用方(chatStreamCall / chatAgentCall / chatStore)需相应加 await。
 */
export async function buildChatSystemPrompt(): Promise<string> {
  // 必须直读 localStorage 真相源,不能用 useSettingsStore.getState()。
  // Daybreak 多窗口架构:每个窗口的 Zustand store 只在初始化时读一次 localStorage,
  // 设置页(主窗)改了人设/语言后只更新主窗 store + localStorage;对话悬浮条的 store
  // 仍是陈旧快照。readSettingsSnapshot() 直读 localStorage,跨窗口始终拿到最新值。
  const s = readSettingsSnapshot();
  const lang: Lang = s.lang ?? "zh";
  // 若 persona 未配置(旧 settings 数据/测试环境),用默认资深幕僚兜底
  const persona = s.persona ?? { presetKey: "seniorAdvisor" as const };

  // 人设片段(用户可配置字段 + 锁死核心规则段);替换原来写死的"你是 Daybreak…"
  const personaSection = composePersonaPrompt(persona, lang);

  const todos = useTodoStore.getState().todos;
  const today = new Date();
  const todayKey = formatDateKey(today);
  const todayTodos = todos.filter((t) => {
    const k = t.scheduledDate ?? formatDateKey(new Date(t.createdAt));
    return k === todayKey;
  });

  const lines: string[] = [
    personaSection,
    "",
    lang === "zh"
      ? `当前时间:${today.toLocaleString("zh-CN")}`
      : `Current time: ${today.toLocaleString("en-US")}`,
    ""
  ];

  if (todayTodos.length > 0) {
    lines.push(lang === "zh" ? "用户今天的待办:" : "Today's tasks:");
    for (const t of todayTodos) {
      const status = t.status === "done" ? (lang === "zh" ? "[已完成]" : "[done]") : "";
      const time = t.scheduledTime ? `(${t.scheduledTime})` : "";
      lines.push(`- ${status}${t.title}${time}${t.estTime ? ` · ${t.estTime}` : ""}`);
    }
  } else {
    lines.push(lang === "zh" ? "用户今天还没有安排任何待办。" : "The user has no tasks scheduled today.");
  }

  lines.push(telosContextSection());

  // Task 1.3:注入近期每日纪要(让对话能引用"最近发生了什么")
  // DB 读取失败时静默忽略(不影响对话主流程)
  try {
    const digests = await dbGetRecentDigests(RECENT_DIGEST_DAYS);
    if (digests.length > 0) {
      lines.push("");
      lines.push(lang === "zh" ? "【近期每日纪要】" : "[Recent Daily Digests]");
      for (const d of digests) {
        lines.push(`${d.date}: ${d.summary}`);
      }
    }
  } catch (err) {
    // 读取失败不影响对话功能,仅记录警告
    console.warn("[buildChatSystemPrompt] 读取 daily_digest 失败:", err);
  }

  return lines.join("\n");
}

/**
 * DeepSeek 各路径要用的 model 解析。
 *
 * 不再写死。优先读 Settings 里对应字段,缺省回退到历史内置值,保证「不配也照旧」。
 * 非 DeepSeek provider 返回 undefined(用 provider 自己的默认 model)。
 *
 * @param purpose
 *   - "agent":带工具的对话(chatAgentCall),回退 deepseek-chat
 *   - "reasoning":深度思考流式(chatStreamCall),回退 deepseek-reasoner
 */
function resolveDeepSeekModel(purpose: "agent" | "reasoning"): string | undefined {
  if (getProvider().name !== "deepseek") return undefined;
  // 直读 localStorage 真相源,原因同 buildChatSystemPrompt 的注释:
  // 对话悬浮条窗口的 store 是陈旧快照,用户在设置页改了 agentModel/reasoningModel 后
  // 须从 readSettingsSnapshot() 读才能即时生效。
  const cfg = readSettingsSnapshot().providers.deepseek;
  if (purpose === "agent") {
    return cfg.agentModel || cfg.model || "deepseek-chat";
  }
  return cfg.reasoningModel || "deepseek-reasoner";
}

/**
 * 给 ChatPage 用:发一条用户消息 + 流式接收
 *
 * 调用方负责把"用户消息"和最终的"assistant 完整内容"存进 messages 表。
 * 这一层只负责"调 LLM + token 流"。
 *
 * Chat 默认走推理模型(可在 Settings.reasoningModel 改);用户设的默认 model 仅用于
 * parseTask / 排今日 / 反思这些结构化任务,Chat 单独要思考链。
 */
export async function chatStreamCall(
  history: ChatMessage[],
  handlers: StreamHandlers
) {
  // 收口到 callBrainStream;model 由 resolveDeepSeekModel 决定(可配置,不写死)
  return callBrainStream(
    [
      { role: "system", content: await buildChatSystemPrompt() },
      ...history
    ],
    {
      temperature: 0.6,
      maxTokens: 2000,
      model: resolveDeepSeekModel("reasoning"),
      recordAs: "chat",
    },
    handlers
  );
}

const TOOL_SYSTEM_HINT = `

你能调用工具来帮用户管理任务、目标、复盘、时间日志、日历事件（增删改查、排期、标记完成等）。
- 用户意图涉及这些操作时，直接调用相应工具完成，再用简洁中文说明结果。
- 查询类需求也走工具拿最新数据，不要凭空编造。
- 删除任务/目标是可恢复的（标记放弃），放心执行。
- 对话中用户已经提供的条件（时间、对象、范围等），后续轮次直接沿用，不要重复追问已知信息。`;

/**
 * 带 function calling 的 agent 对话（非流式）。
 *
 * 模型可多轮调用工具：调工具 → 前端执行 → 结果回传 → 继续，直到给出最终答复。
 * 仅在支持工具的模型上真正生效（deepseek-chat）；mock / reasoner 不会调工具，退化为普通问答。
 * MAX_ROUNDS 防止模型在工具间反复横跳导致死循环。
 */
export async function chatAgentCall(
  history: ChatMessage[],
  opts?: { onStep?: (info: { type: "tool"; name: string }) => void }
): Promise<ChatResult> {
  // model 可配置(不再写死 deepseek-chat);非 deepseek 用 provider 默认
  const model = resolveDeepSeekModel("agent");
  // 是否带工具,改由「该 model 的能力位」决定(解 reasoner/工具互斥):
  //   - 支持工具的 model(deepseek-chat、未来 V4)→ 带 tools,走完整 agent loop;
  //   - 不支持工具的 model(reasoner)→ 不带 tools,自然退化为单轮问答,不会硬报错。
  const caps = getCapabilities(model);
  const tools = caps.supportsTools ? toolsForLLM() : undefined;
  const messages: ChatMessage[] = [
    { role: "system", content: (await buildChatSystemPrompt()) + TOOL_SYSTEM_HINT },
    ...history,
  ];
  const MAX_ROUNDS = 6;
  let last: ChatResult = { content: "" };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 每轮都收口到 callBrain,并整段重传 system+history+回灌结果(无状态 C1)
    const result = await callBrain(messages, {
      temperature: 0.5,
      maxTokens: 2000,
      tools,
      model,
      recordAs: "chat-agent",
    });
    last = result;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return result; // 模型给出最终答复，结束
    }

    // 记录 assistant 的工具调用请求
    messages.push({
      role: "assistant",
      content: result.content,
      toolCalls: result.toolCalls,
    });
    // 逐个执行工具，结果作为 tool 消息回传给模型
    for (const tc of result.toolCalls) {
      opts?.onStep?.({ type: "tool", name: tc.name });
      let args: Record<string, unknown> = {};
      try {
        args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
      } catch {
        /* 参数解析失败就传空对象，工具内部会返回字段缺失错误给模型 */
      }
      const toolResult = await runChatTool(tc.name, args);
      messages.push({ role: "tool", content: toolResult, toolCallId: tc.id });
    }
  }

  return { content: last.content || i18n.t("chat.tooManyRounds"), model };
}

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
