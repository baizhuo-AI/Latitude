/**
 * privacy.ts — Task 4.6a 隐私 + 成本辅助纯函数
 *
 * 职责:
 *   1. isCloudBackend(backend)       — 判断当前对话后端是否为云端 API
 *   2. shouldInjectMemoryToEngine    — 仅本地大脑(localOnlyBrain)开启时,决定是否注入记忆
 *   3. buildSensitiveMemoryInstruction — noSensitiveMemory 开启时生成「禁止记录敏感信息」的系统指令段
 *   4. applyLowPowerPreset           — 省电/低频模式:返回 ProactivePatch,调用方 setProactive 写入
 *
 * 设计原则:
 *   - 全部纯函数,无 IO 依赖,可直接单测
 *   - 不 import store/settings/db — 消费方(buildChatSystemPrompt / chatTools)负责读设置后传入
 *
 * 语义约定(isCloudBackend):
 *   "deepseek-api" 是唯一的「直连云端 API」后端。
 *   "claude-cli" / "codex-cli" / "kiro-cli" 走本地 CLI,用户本地凭证,不直接暴露给 Daybreak 后端。
 */

import type { ChatBackend } from "./settings";
import type { ProactivePatch } from "./settings";

// ─── 省电/低频预设常量 ──────────────────────────────────────────────────────────

/**
 * 低频模式的心跳间隔(分钟)。
 * 默认心跳 90min;低频拉到 240min(4h),大幅减少云端调用次数。
 */
export const LOW_POWER_HEARTBEAT_MIN = 240;

/**
 * 低频模式的半天打扰预算。
 * 默认 3 次/半天;低频收紧到 1 次,在必要时才打扰。
 */
export const LOW_POWER_BUDGET_PER_HALF_DAY = 1;

// ─── 1. isCloudBackend ────────────────────────────────────────────────────────

/**
 * 判断给定的对话后端是否为云端 API。
 *
 * 语义:"云端"意味着 AI 的系统提示词(含注入的记忆/上下文)会被发送到第三方 API 服务器。
 *   - deepseek-api   → 直连 DeepSeek 云端 API → true
 *   - claude-cli     → 本地 Claude Code CLI  → false
 *   - codex-cli      → 本地 Codex CLI        → false
 *   - kiro-cli       → 本地 Kiro CLI         → false
 */
export function isCloudBackend(backend: ChatBackend): boolean {
  return backend === "deepseek-api";
}

// ─── 2. shouldInjectMemoryToEngine ───────────────────────────────────────────

/**
 * 决策:当前引擎调用是否应注入用户记忆。
 *
 * 规则:
 *   - localOnlyBrain = false(默认):始终注入(不改变现有行为)
 *   - localOnlyBrain = true + 本地 CLI 后端:注入(本地引擎,无第三方数据传输)
 *   - localOnlyBrain = true + 云端 API 后端:不注入(保护记忆不发送到第三方服务器)
 *
 * @param localOnlyBrain  settings.localOnlyBrain 的当前值
 * @param backend         当前 chatBackend
 */
export function shouldInjectMemoryToEngine(
  localOnlyBrain: boolean,
  backend: ChatBackend
): boolean {
  if (!localOnlyBrain) return true; // 功能未开启:保持现有行为
  // 开启「仅本地大脑」:只有非云端后端才注入
  return !isCloudBackend(backend);
}

// ─── 3. buildSensitiveMemoryInstruction ──────────────────────────────────────

const SENSITIVE_INSTRUCTION: Record<"zh" | "en", string> = {
  zh: `\n\n【敏感信息保护】用户已开启「敏感信息不记忆」。请勿将以下类型的信息记入长期记忆(remember 工具):密码、账号凭证、身份证号、银行卡号、财务金额、私密医疗信息、私人通讯内容等隐私/敏感数据。遇到此类信息时,在当前对话内使用即可,不要调用 remember 存档。`,
  en: `\n\n[Sensitive Data Protection] The user has enabled "no sensitive memory". Do NOT store the following in long-term memory (via the remember tool): passwords, credentials, ID numbers, bank/card numbers, financial amounts, private medical details, private messages, or any other sensitive/private data. Use such information within this conversation only — do not call remember to archive it.`,
};

/**
 * 构造「敏感信息不记忆」的系统提示词补充段。
 *
 * 调用方将此段追加到系统提示词(或 remember 工具说明)。
 * noSensitiveMemory=false 时返回空字符串,不注入任何内容。
 *
 * @param noSensitiveMemory  settings.noSensitiveMemory 的当前值
 * @param lang               当前语言
 */
export function buildSensitiveMemoryInstruction(
  noSensitiveMemory: boolean,
  lang: "zh" | "en"
): string {
  if (!noSensitiveMemory) return "";
  return SENSITIVE_INSTRUCTION[lang] ?? SENSITIVE_INSTRUCTION.zh;
}

// ─── 4. applyLowPowerPreset ───────────────────────────────────────────────────

/**
 * 省电/低频模式预设:返回可直接传给 setProactive(patch) 的 patch 对象。
 *
 * 落地逻辑:
 *   - heartbeatMin ↑ 到 LOW_POWER_HEARTBEAT_MIN(240min):减少巡检频率
 *   - budgetPerHalfDay ↓ 到 LOW_POWER_BUDGET_PER_HALF_DAY(1次):收紧打扰预算
 *
 * 不改动:
 *   - mode / channel / events:功能不影响,只降频率
 *   - morningHour:晨报保持(对用户价值高)
 *
 * 调用方:UI 按钮 onClick → settings.setProactive(applyLowPowerPreset())
 */
export function applyLowPowerPreset(): ProactivePatch {
  return {
    heartbeatMin: LOW_POWER_HEARTBEAT_MIN,
    budgetPerHalfDay: LOW_POWER_BUDGET_PER_HALF_DAY,
  };
}
