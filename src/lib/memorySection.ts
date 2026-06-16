/**
 * memorySection.ts — Task 2.2 记忆事实注入段(纯函数)
 *
 * 职责:把一组记忆事实(已 active、已 pinned 优先排序)拼成注入到对话
 * system prompt 的「长期记忆」段字符串。
 *
 * 为什么单独成纯函数(不内联进 buildChatSystemPrompt):
 *   截断 + pinned 优先保留 + inferred 标注 是这一期唯一的「带取舍的逻辑」,
 *   把它抽成无 IO、无时钟依赖的纯函数,可像 personaSpec / isMemoryFactActive 那样
 *   直接单测,实现改了先红。buildChatSystemPrompt 只负责「从 DB 取数 → 调本函数」。
 *
 * 关键不变量(测试钉死):
 *   1. 空列表 → 返回空字符串(不注入头部、不产生噪声)。
 *   2. inferred 事实带试探标注(zh "(推断)" / en "(inferred)");told 不带。
 *   3. 产物受 maxChars 预算约束,超量截断【不报错】。
 *   4. 截断时 pinned 事实优先保留——被牺牲的只能是非 pinned。
 *      不依赖入参顺序:本函数自己按「pinned 先、非 pinned 后」装填。
 */

import type { MemoryFact, MemoryCategory } from "./db";

/** 注入记忆段的字符预算默认值。设保守上限,避免记忆把上下文挤爆。 */
export const DEFAULT_MEMORY_BUDGET_CHARS = 2000;

/** 段头(随 lang 切换)。zh/en 都含可被测试锚定的关键词(记忆 / Memory)。 */
const SECTION_HEADER: Record<"zh" | "en", string> = {
  zh: "【关于用户的长期记忆】",
  en: "[Long-term Memory About the User]",
};

/** inferred 来源的试探标注(逐条挂在事实末尾)。 */
const INFERRED_TAG: Record<"zh" | "en", string> = {
  zh: "(推断)",
  en: "(inferred)",
};

/** 各分类的人类可读前缀(给大脑一点结构感;未知分类回退原值)。 */
const CATEGORY_LABEL: Record<"zh" | "en", Record<MemoryCategory, string>> = {
  zh: {
    identity: "身份",
    ongoing: "在进行",
    habit: "习惯",
    people: "人际",
    preference: "偏好",
  },
  en: {
    identity: "Identity",
    ongoing: "Ongoing",
    habit: "Habit",
    people: "People",
    preference: "Preference",
  },
};

/** 把单条事实渲染成一行:`- [分类] 内容(推断)?` */
function renderFactLine(fact: MemoryFact, lang: "zh" | "en"): string {
  const label =
    CATEGORY_LABEL[lang][fact.category] ?? String(fact.category);
  const tag = fact.source === "inferred" ? ` ${INFERRED_TAG[lang]}` : "";
  return `- [${label}] ${fact.content}${tag}`;
}

/**
 * 构造记忆注入段。
 *
 * @param facts    记忆事实(调用方应传 active 的;本函数不做有效性过滤)。
 *                 入参顺序不影响 pinned 保留逻辑——本函数内部重新分组装填。
 * @param lang     "zh" | "en",决定段头/标注/分类前缀语言。
 * @param maxChars 字符预算上限(含段头)。产物长度 ≤ maxChars。
 *                 超量时优先丢非 pinned 事实;若 pinned 仍超额,尽力而为不报错。
 * @returns        记忆段字符串;无可注入内容时返回 ""。
 */
export function buildMemorySection(
  facts: MemoryFact[],
  lang: "zh" | "en",
  maxChars: number = DEFAULT_MEMORY_BUDGET_CHARS
): string {
  if (facts.length === 0) return "";

  const header = SECTION_HEADER[lang];
  // 预算连段头都放不下:直接不注入(返回空,避免产出只有半截头部的噪声)。
  if (header.length > maxChars) return "";

  // pinned 优先:本函数自己分组,不依赖入参已排序。
  // 同组内保持入参相对顺序(dbListMemoryFacts 已按 created_at DESC,新的在前)。
  const pinned = facts.filter((f) => f.pinned);
  const others = facts.filter((f) => !f.pinned);
  const ordered = [...pinned, ...others];

  const lines: string[] = [header];
  let used = header.length;

  for (const fact of ordered) {
    const line = renderFactLine(fact, lang);
    // 每条事实以 "\n" 开头拼接(join("\n") 的分隔符在 fact 前面,不是尾部)。
    // 精确模型:这条 fact 加入后的实际 join 长度 = used + 1(\n) + line.length。
    // 只有当 used + 1 + line.length ≤ maxChars 时才装填——无多余的尾换行。
    const newUsed = used + 1 + line.length;
    if (newUsed > maxChars) {
      // 超预算:停止装填后续事实。
      // 因为 pinned 排在最前,被丢的必然是靠后的非 pinned(或预算极小连
      // pinned 都装不下时的剩余 pinned)——满足「pinned 优先保留」。
      break;
    }
    lines.push(line);
    used = newUsed;
  }

  // 只剩段头、一条事实都没装下 → 不注入(纯头部无意义)。
  if (lines.length === 1) return "";

  return lines.join("\n");
}
