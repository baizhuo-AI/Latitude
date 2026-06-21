/**
 * memoryHygiene.ts — Task 2.4 记忆卫生
 *
 * 职责:
 *   1. resolveConflict — 纯函数规则层:给定两条同 category、同主题的事实,
 *      按 created_at 时序决出"用新值 / 用旧值 / 标 conflict"。
 *      调用方(语义层或写入时去重)判断"同主题";本函数只做确定性规则。
 *
 *   2. runMemoryDedup — 日终去重归并:读全量 memory_facts → 用 generateOnce
 *      让大脑识别重复/矛盾 → 执行合并/删除动作 → emitSync('memory') 通知窗口。
 *
 * 设计约束(铁律):
 *   - resolveConflict:纯函数、无 IO、时间从参数读取(created_at 字段)。
 *   - runMemoryDedup:语义部分走 generateOnce;落库走 dbUpdateMemoryFact/dbDeleteMemoryFact;
 *     generateOnce 抛错或返回非法 JSON 时静默降级,不崩,不写库。
 *   - 写了记忆后调 emitSync('memory') 通知其他窗口(跨窗口共享不变式)。
 *   - 不做周/月压缩。
 */

import {
  dbListMemoryFacts,
  dbUpdateMemoryFact,
  dbDeleteMemoryFact,
} from "../db";
import type { MemoryFact } from "../db";
import { generateOnce } from "../llm/index";
import { emitSync } from "../syncBus";
import type { Lang } from "../settings";

// ─── resolveConflict ──────────────────────────────────────────────────────────

/**
 * resolveConflict 的决策结果。
 *
 * - decision:
 *   - 'use_new'  : newFact 的 created_at 更晚,以它为准
 *   - 'use_old'  : oldFact 的 created_at 更晚,以它为准
 *   - 'conflict' : 无法确定(时间相同、或任意一方时间脏值)
 * - winner:建议保留的那条(conflict 时取 oldFact)
 * - loser :建议丢弃或标注的那条(conflict 时取 newFact)
 */
export interface ConflictResolution {
  decision: "use_new" | "use_old" | "conflict";
  winner: MemoryFact;
  loser: MemoryFact;
}

/**
 * 规则层冲突裁决:给定两条同 category、同主题的事实(「同主题」由调用方判定),
 * 按 created_at 时序返回确定性决策。纯函数、无 IO、时间从字段读取。
 *
 * 规则:
 *   - 任意一方的 created_at 不可解析 → conflict(保守,不误删)
 *   - newFact.created_at > oldFact.created_at → use_new
 *   - oldFact.created_at > newFact.created_at → use_old
 *   - 完全相等 → conflict
 *
 * @param oldFact 「旧」事实(语义上先写入的那条,通常 DB 里已有的)
 * @param newFact 「新」事实(语义上后来发现的那条,通常候选替换的)
 */
export function resolveConflict(
  oldFact: MemoryFact,
  newFact: MemoryFact
): ConflictResolution {
  const oldTs = Date.parse(oldFact.createdAt);
  const newTs = Date.parse(newFact.createdAt);

  // 任意一方时间脏值 → 无法比较 → 保守 conflict
  if (Number.isNaN(oldTs) || Number.isNaN(newTs)) {
    return { decision: "conflict", winner: oldFact, loser: newFact };
  }

  if (newTs > oldTs) {
    return { decision: "use_new", winner: newFact, loser: oldFact };
  }
  if (oldTs > newTs) {
    return { decision: "use_old", winner: oldFact, loser: newFact };
  }
  // 完全相等 → conflict
  return { decision: "conflict", winner: oldFact, loser: newFact };
}

// ─── runMemoryDedup ───────────────────────────────────────────────────────────

/**
 * 大脑返回的归并动作形状。
 *
 * - type: 'merge'  : 合并两条:更新 keepId 的 content,删除 dropId
 * - type: 'delete' : 仅删除 dropId(keepId 内容不变)
 */
export type DedupAction =
  | { type: "merge"; keepId: string; dropId: string; mergedContent: string }
  | { type: "delete"; dropId: string };

/**
 * 大脑返回 JSON 的顶层形状。
 * `actions` 是要执行的动作列表(空列表 = 无需归并)。
 */
interface DedupResponse {
  actions: DedupAction[];
}

// ─── 去重归并提示词(zh/en 双语) ───────────────────────────────────────────────

const DEDUP_SYSTEM: Record<Lang, string> = {
  zh: `你是一个记忆事实去重助手。用户会给你一组「关于用户的长期记忆事实」列表(含 id、category、content)。

请识别其中重复或矛盾的事实，输出需要执行的归并动作。每种动作：
- merge: 把两条合并成一条——保留 keepId 那条(更新 content)，删除 dropId 那条
- delete: 直接删除 dropId 那条(keepId 那条不动)

规则：
1. 只处理「真正重复或明显矛盾」的事实；不确定的保持原样
2. 同一条 id 不能同时出现在 keepId 和 dropId
3. 不同 category 的事实通常不归并（除非跨类重复）
4. 如无需归并，输出空 actions 数组

只输出如下 JSON，不要解释：
{"actions": [
  {"type": "merge", "keepId": "mf_xxx", "dropId": "mf_yyy", "mergedContent": "合并后的内容"},
  {"type": "delete", "dropId": "mf_zzz"}
]}`,

  en: `You are a memory deduplication assistant. The user will provide a list of long-term memory facts (with id, category, content).

Identify duplicates or contradictions and output the actions needed:
- merge: combine two facts — keep keepId (update content), delete dropId
- delete: remove dropId only

Rules:
1. Only process truly duplicate or clearly contradictory facts; leave uncertain ones alone
2. An id cannot appear as both keepId and dropId
3. Facts of different categories are usually not merged (unless clearly duplicate across categories)
4. If nothing to deduplicate, return an empty actions array

Output only this JSON, no explanation:
{"actions": [
  {"type": "merge", "keepId": "mf_xxx", "dropId": "mf_yyy", "mergedContent": "merged content here"},
  {"type": "delete", "dropId": "mf_zzz"}
]}`,
};

/**
 * 把事实列表序列化为喂给 LLM 的用户消息文本。
 * 每行: [id] [category] content
 */
function buildFactsMessage(facts: MemoryFact[], lang: Lang): string {
  if (facts.length === 0) return "";
  const header =
    lang === "zh"
      ? "以下是当前所有记忆事实（id / 分类 / 内容）："
      : "Current memory facts (id / category / content):";
  const lines = facts.map(
    (f) => `[${f.id}] [${f.category}] ${f.content}`
  );
  return [header, ...lines].join("\n");
}

/**
 * 执行单条归并动作。任意 db 操作失败时静默跳过(不崩)。
 * 返回是否有任何实际写库操作(供调用方决定是否 emitSync)。
 */
async function applyAction(action: DedupAction): Promise<boolean> {
  try {
    if (action.type === "merge") {
      await dbUpdateMemoryFact(action.keepId, { content: action.mergedContent });
      await dbDeleteMemoryFact(action.dropId);
      return true;
    }
    if (action.type === "delete") {
      await dbDeleteMemoryFact(action.dropId);
      return true;
    }
  } catch (err) {
    // 目标 id 不存在或 db 故障:静默跳过,不崩
    console.warn("[memoryDedup] action failed, skipping:", action, err);
  }
  return false;
}

/**
 * 日终去重归并:读取所有 memory_facts → 用 generateOnce 识别重复/矛盾 →
 * 执行动作(update/delete)→ emitSync 通知其他窗口。
 *
 * 错误处理:
 *   - 无事实时直接 return(不调 generateOnce)
 *   - generateOnce 抛错 → catch 静默(不崩,不写库)
 *   - JSON 解析失败 → catch 静默(不崩,不写库)
 *   - 单条 action 失败 → 静默跳过,继续执行其余 action
 *
 * @param lang 提示词语言,默认 "zh"
 */
export async function runMemoryDedup(lang: Lang = "zh"): Promise<void> {
  // 1. 读全量事实(含过期的——去重不依赖 active 状态)
  const facts = await dbListMemoryFacts();
  if (facts.length === 0) return;

  // 2. 让大脑识别重复/矛盾
  let response: DedupResponse;
  try {
    const userMsg = buildFactsMessage(facts, lang);
    const raw = await generateOnce(DEDUP_SYSTEM[lang], [
      { role: "user", content: userMsg },
    ]);
    response = JSON.parse(raw) as DedupResponse;
  } catch (err) {
    // generateOnce 抛错或返回非法 JSON → 静默降级
    console.warn("[memoryDedup] generateOnce or JSON parse failed:", err);
    return;
  }

  // actions 必须是数组(容错:大脑返回格式不规范)
  const actions: DedupAction[] = Array.isArray(response?.actions)
    ? response.actions
    : [];

  if (actions.length === 0) return;

  // 3. 逐条执行动作
  let anyChanged = false;
  for (const action of actions) {
    const changed = await applyAction(action);
    if (changed) anyChanged = true;
  }

  // 4. 有任何写库操作 → 通知其他窗口刷新记忆
  if (anyChanged) {
    emitSync("memory");
  }
}
