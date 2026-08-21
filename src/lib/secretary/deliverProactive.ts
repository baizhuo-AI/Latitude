/**
 * deliverProactive.ts — AI 秘书主动消息「投递层」(Task 3.4)
 *
 * 上游(wiring.ts 3.7 接线层)拿触发候选过 gateProactive,放行一条后调本层投递。
 * 本层与 composeMorningBriefing 平行——合成一条带人设腔调的主动消息并送达,
 * 区别是服务「事件触发候选」(ProactiveCandidate),且语气受 3.3 负荷档调制。
 *
 * 职责分层(便于单测):
 *   1. resolveDeliveryChannels(channel) — 纯函数:渠道枚举 → {chat, notification, float}
 *   2. applyLoadTone(systemPrompt, tonePhrase?) — 纯函数:把负荷措辞拼进 system prompt
 *   3. composeProactiveMessage(candidate, ctx) — 合成单条文案(generateOnce,注入人设+事实+负荷措辞)
 *   4. deliverProactive(candidate, opts) — 合成 + 按渠道投递 + 打点
 *
 * 投递渠道语义:
 *   - chat(聊天冒泡):任何渠道都【先落进一个新对话】——这是主动消息的可回复载体。
 *     故 resolveDeliveryChannels 里 chat 恒为 true。新建对话 + assistant 首条消息,
 *     用户回复即进正常 sendMessage 流程(与 composeMorningBriefing 同范式)。
 *   - notification(系统通知):额外发 macOS 通知(plugin-notification),复用 reminder 范式。
 *   - float(弹悬浮窗):额外弹/聚焦 todo 悬浮窗(复用 reminder 的 openTodoFloat)。
 *
 * 铁律:
 *   - 多窗口:投递后只 emitSync("conversations"),不直接改某窗口 store(各窗口独立 chatStore)。
 *   - C6 错误降级:generateOnce 失败 → 不投递、不打点、不发通知/弹窗、不抛到调用方(静默)。
 *   - 投递层不做「该不该发」的判定(那在 gate/triggers);本层只在被放行后执行投递动作。
 *   - 纯函数(resolveDeliveryChannels/applyLoadTone)体内不读 Date.now()/Math.random()。
 */

import { generateOnce } from "../llm/index";
import { composePersonaPrompt } from "../persona/personaSpec";
import {
  dbInsertConversation,
  dbInsertMessage,
  dbTouchConversation,
  dbLogProactiveSent,
} from "../db";
import { useSettingsStore } from "../settings";
import { emitSync } from "../syncBus";
import { pushProactiveToFeishu } from "../feishuPush";
import { openTodoFloat } from "../windowLayout";
import type { Lang } from "../settings";
import type { ConversationRow, ChatMessageRow } from "../db";
import type { ProactiveCandidate, CandidateKind } from "./triggers";
import type { ProactiveChannel } from "./proactiveConfig";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 渠道解析结果:三个布尔(chat 恒 true) */
export interface DeliveryChannels {
  chat: boolean;
  notification: boolean;
  float: boolean;
}

/** composeProactiveMessage 的上下文 */
export interface ComposeProactiveCtx {
  /** 语言;不传则从 settings 读 */
  lang?: Lang;
  /** 3.3 负荷档措辞(注入 system prompt 调语气);不传则不调 */
  tonePhrase?: string;
}

/** deliverProactive 的可选项 */
export interface DeliverProactiveOpts {
  /** 语言;不传则从 settings 读 */
  lang?: Lang;
  /** 投递渠道;不传默认 "chat"(温和:只聊天冒泡) */
  channel?: ProactiveChannel;
  /** 3.3 负荷档措辞(注入合成层调语气) */
  tonePhrase?: string;
}

/** deliverProactive 成功的返回值 */
export interface DeliverResult {
  /** 投递进的对话 id */
  convId: string;
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 系统通知正文截断长度 */
const NOTIFY_BODY_MAX = 120;
/** 投递日志内容预览长度(与 composeMorningBriefing 的 previewLen 一致) */
const LOG_PREVIEW_LEN = 50;

/**
 * activity_capture 对话固定问句模板(不调 LLM,节省 token)。
 *
 * 语气轻松自然;秘书人设名在设置里可配(默认不预设专名),这里保持通用口吻,
 * 不 hardcode 人设名(否则每次改人设要改这里)。
 */
const ACTIVITY_CAPTURE_PROMPT: Record<Lang, string> = {
  zh: "最近在忙啥?一句话记一下就好 🗒️",
  en: "Hey, what've you been up to? One line is enough 🗒️",
};

// ─── 合成提示词:主动消息任务说明(按 kind 给侧重) ────────────────────────────
//   人设由 composePersonaPrompt 注入;这里只追加「现在要发一条什么样的主动消息」。

/** 各类型主动消息的语气侧重(zh/en) */
const KIND_HINT: Record<CandidateKind, Record<Lang, string>> = {
  meeting_soon: {
    zh: "用户有个会马上要开了,提醒一句,可顺带问要不要先准备点什么。",
    en: "The user has a meeting starting soon. Give a heads-up and optionally offer to help prep.",
  },
  deadline_near: {
    zh: "用户有件排程任务快到点了,提醒一句,别施压。",
    en: "A scheduled task is due soon. Nudge gently without pressure.",
  },
  task_stuck: {
    zh: "用户有件任务搁置较久了,轻轻提一下,问问是不是需要拆解或要放掉。",
    en: "A task has been stalled for a while. Mention it lightly; ask if it needs breaking down or dropping.",
  },
  just_completed: {
    zh: "用户刚完成一件事,给一句简短的正反馈,可顺势问下一步,别夸张。",
    en: "The user just finished something. Give brief positive feedback; optionally ask about next steps. Don't overdo it.",
  },
  // 活动捕获:问一句"过去这阵在忙啥"——轻松自然,一句话即可(M3 会做更完整的对话标记)
  activity_capture: {
    zh: "到活动记录的时间了,自然地问一句用户最近在忙什么,语气轻松,一句话就够。",
    en: "Time for an activity check-in. Casually ask what the user has been working on. Keep it light, one sentence.",
  },
};

/**
 * 主动消息的 system prompt 后缀(人设之后拼):告知模型在发一条主动消息。
 */
function proactiveSystemSuffix(kind: CandidateKind, lang: Lang): string {
  const hint = KIND_HINT[kind][lang];
  if (lang === "zh") {
    return `

你现在要主动给用户发一条简短的提醒/关心。${hint}
要求:
- 用你的人设腔调自然开口,一两句话即可,别套模板、别长篇大论
- 只针对下面这一件事,不要顺带罗列其他
只输出消息正文,不要解释。`;
  }
  return `

Now proactively send the user a short reminder/note. ${hint}
Requirements:
- Open naturally in your persona's voice, 1-2 sentences, no templates, no rambling
- Focus only on the single item below; don't enumerate other things
Output only the message text, no explanation.`;
}

/**
 * 候选事实 → 喂给 generateOnce 的 user 消息(确定性渲染)。
 * 候选的 title 已是按 lang 渲染好的事实摘要(triggers.renderTitle 产物),直接用。
 */
function buildProactiveUserMessage(candidate: ProactiveCandidate, lang: Lang): string {
  if (lang === "zh") {
    return `【触发事件】\n${candidate.title}`;
  }
  return `[Trigger]\n${candidate.title}`;
}

// ─── id 生成(与 composeProactive 同范式) ─────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 判断对话 id 是否来自 activity_capture 投递(M3 标记:ac 前缀)。
 *
 * 用于 ChatBar 的轻提示检测(isProactiveConvId 的 activity_capture 版本):
 *   - "ac..." → activity_capture 对话
 *   - "pa..." → 其他主动消息对话
 *   - "brief..." → 晨间简报对话
 */
export function isActivityCaptureConvId(id: string): boolean {
  return id.startsWith("ac");
}

// ─── 1. 纯函数:渠道解析 ──────────────────────────────────────────────────────

/**
 * 渠道枚举 → 三个布尔。chat 恒 true(主动消息的可回复载体,任何渠道都先落对话)。
 *
 * @param channel 渠道枚举
 */
export function resolveDeliveryChannels(channel: ProactiveChannel): DeliveryChannels {
  switch (channel) {
    case "notification":
      return { chat: true, notification: true, float: false };
    case "float":
      return { chat: true, notification: false, float: true };
    case "all":
      return { chat: true, notification: true, float: true };
    case "chat":
    default:
      return { chat: true, notification: false, float: false };
  }
}

// ─── 2. 纯函数:负荷措辞拼接 ──────────────────────────────────────────────────

/**
 * 把 3.3 负荷档措辞拼进 system prompt(末尾追加一段)。无 / 空措辞时原样返回。
 *
 * @param systemPrompt 已含人设 + 任务说明的 system prompt
 * @param tonePhrase   负荷措辞(computeLoad 产物的 tonePhrase),可空
 */
export function applyLoadTone(systemPrompt: string, tonePhrase?: string): string {
  if (!tonePhrase) return systemPrompt;
  return `${systemPrompt}\n\n${tonePhrase}`;
}

// ─── 3. 合成单条主动消息文案 ──────────────────────────────────────────────────

/**
 * 合成一条主动消息文案(人设 + 候选事实 + 负荷措辞 → generateOnce)。
 *
 * C6 降级:generateOnce 抛错 → 返回 undefined(不抛)。
 *
 * @returns 文案 string;失败返回 undefined
 */
export async function composeProactiveMessage(
  candidate: ProactiveCandidate,
  ctx: ComposeProactiveCtx = {}
): Promise<string | undefined> {
  const s = useSettingsStore.getState();
  const lang: Lang = ctx.lang ?? s.lang ?? "zh";
  const persona = s.persona ?? { presetKey: "seniorAdvisor" as const };

  const personaSection = composePersonaPrompt(persona, lang);
  const withTask = personaSection + proactiveSystemSuffix(candidate.kind, lang);
  const systemPrompt = applyLoadTone(withTask, ctx.tonePhrase);

  const userMessage = buildProactiveUserMessage(candidate, lang);

  try {
    return await generateOnce(systemPrompt, [{ role: "user", content: userMessage }]);
  } catch (err) {
    console.warn("[deliverProactive] composeProactiveMessage 失败,取消投递:", err);
    return undefined;
  }
}

// ─── 渠道副作用:系统通知 / 弹悬浮窗 ──────────────────────────────────────────

/**
 * 发 macOS 系统通知(复用 reminder.ts 的范式:动态 import + 权限检查 + 容错)。
 * 任何失败都吞掉(通知是「额外」提醒,失败不该影响已投递的聊天消息)。
 */
async function sendSystemNotification(title: string, body: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const perm = await mod.requestPermission();
      granted = perm === "granted";
    }
    if (!granted) return;
    mod.sendNotification({ title, body: body.slice(0, NOTIFY_BODY_MAX) });
  } catch (err) {
    console.warn("[deliverProactive] 系统通知失败,忽略:", err);
  }
}

/** 弹/聚焦 todo 悬浮窗(复用 reminder 范式)。失败吞掉。 */
async function popFloatWindow(): Promise<void> {
  try {
    await openTodoFloat();
  } catch (err) {
    console.warn("[deliverProactive] 弹悬浮窗失败,忽略:", err);
  }
}

// ─── 4. 投递 ──────────────────────────────────────────────────────────────────

/**
 * 投递一条主动消息:合成 → 聊天冒泡(必走)→ 可选通知/弹窗 → 打点。
 *
 * 流程:
 *   1. composeProactiveMessage 合成文案(C6 失败 → 返回 undefined,什么都不做)。
 *   2. chat 渠道(恒走):新建对话 + assistant 首条消息 + emitSync("conversations")。
 *   3. notification / float 渠道(按 channel):额外通知 / 弹窗(失败各自吞掉,不影响 chat)。
 *   4. 打点 dbLogProactiveSent:type=候选 kind、refId 透传(给 gateProactive 跨重启去重)。
 *
 * @param candidate 触发候选(已被 gateProactive 放行)
 * @param opts      语言 / 渠道 / 负荷措辞
 * @returns DeliverResult(含 convId);合成失败时 undefined
 */
export async function deliverProactive(
  candidate: ProactiveCandidate,
  opts: DeliverProactiveOpts = {}
): Promise<DeliverResult | undefined> {
  const s = useSettingsStore.getState();
  const lang: Lang = opts.lang ?? s.lang ?? "zh";
  const channel: ProactiveChannel = opts.channel ?? "chat";

  // 1. 合成(C6:失败静默)
  // activity_capture 走 composeProactiveMessage(大脑合成,拟人问候),
  // 大脑失败(返回 undefined)时降级为固定模板——保证没配大脑的用户闹钟也能响。
  let text = await composeProactiveMessage(candidate, { lang, tonePhrase: opts.tonePhrase });
  if (text === undefined && candidate.kind === "activity_capture") {
    // LLM 降级:大脑没配或失败时用固定模板
    text = ACTIVITY_CAPTURE_PROMPT[lang];
  }
  if (text === undefined) return undefined;

  const channels = resolveDeliveryChannels(channel);

  // 2. 聊天冒泡(恒走):新建对话 + assistant 消息
  // activity_capture 用 "ac" 前缀(chatStore writeback 依赖此前缀识别);其他用 "pa"
  const convId = newId(candidate.kind === "activity_capture" ? "ac" : "pa");
  const now = new Date().toISOString();
  // activity_capture 用专用 title;其他类型保持原逻辑
  const title =
    candidate.kind === "activity_capture"
      ? lang === "zh"
        ? "活动记录 · 过去这段时间"
        : "Activity Check-in"
      : lang === "zh"
        ? `提醒 · ${candidate.title}`
        : `Nudge · ${candidate.title}`;

  const conv: ConversationRow = { id: convId, title, createdAt: now, updatedAt: now };
  await dbInsertConversation(conv);

  const msg: ChatMessageRow = {
    id: newId("m"),
    convId,
    role: "assistant",
    content: text,
    createdAt: now,
  };
  await dbInsertMessage(msg);
  await dbTouchConversation(convId).catch(() => undefined);

  // 跨窗口刷新:让监听 conversations 的窗口 hydrate 出这条新对话(铁律:不直接改某窗口 store)
  emitSync("conversations");

  // 选项 A:主动消息也推到飞书单聊(电脑开着时多一个飞书落点)。fire-and-forget,不阻塞投递。
  void pushProactiveToFeishu(text);

  // 3. 额外渠道(失败各自吞掉,不影响已投递的聊天消息)
  if (channels.notification) {
    const notifyTitle =
      candidate.kind === "activity_capture"
        ? lang === "zh"
          ? "Latitude 活动记录"
          : "Latitude Activity"
        : lang === "zh"
          ? "Latitude 提醒"
          : "Latitude";
    await sendSystemNotification(notifyTitle, text);
  }
  if (channels.float) {
    await popFloatWindow();
  }

  // 4. 打点(失败不影响投递结果)
  await dbLogProactiveSent({
    type: candidate.kind,
    convId,
    contentPreview: text.slice(0, LOG_PREVIEW_LEN),
    refId: candidate.refId,
  }).catch((err) => {
    console.warn("[deliverProactive] 写 proactive_log 失败,忽略:", err);
  });

  console.info(
    `[deliverProactive] 已投递: kind=${candidate.kind}, conv=${convId}, channel=${channel}`
  );
  return { convId };
}

// ─── activity_capture 投递已合并进 deliverProactive 主路径 ──────────────────
// deliverActivityCapture 函数已删除。ACTIVITY_CAPTURE_PROMPT 保留(降级模板用)。
// isActivityCaptureConvId 保留(chatStore writeback 依赖)。
