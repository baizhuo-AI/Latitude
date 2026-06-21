/**
 * modelTier.ts — 模型「推荐档位」判定纯函数 (Task 3.6,R3 弱模型地板的软性引导)
 *
 * 职责:把「用户给某 provider 挂了哪个 model」算成「相对推荐档的位置」,供设置页做软性提示。
 *      这是 R3(弱模型地板)的命门——秘书的主动逻辑/记忆/闸门都是纯函数地板可证明,
 *      但「最终回话质量」仍受模型本身限制。用户若挂了明显偏弱的模型,我们温和提示一句
 *      「这低于推荐档,体验可能打折」,而不是硬性拦截(那是产品方向上的软引导,不是封锁)。
 *
 * ─── 三态语义(只地板,不封顶;温和姿态) ──────────────────────────────────────
 *   - "recommended":用户没填(走系统默认推荐档)或填的就是推荐档 → 不打扰。
 *   - "below"      :填了【已知低于推荐档】的弱模型 → 提示升档。只对显式认得的弱档报警。
 *   - "unknown"    :填了我们不认识的 model(可能更强、更新、第三方代理名)→ 返回未知,
 *                    不乱报「低于推荐」。符合「信号稀疏返回未知、宁可不说也不误判」的姿态。
 *
 * ─── 为什么是「白名单弱档」而非「白名单推荐档之外全报警」 ──────────────────────
 *   模型迭代极快(opus/4.1/o3/V4…),把「非推荐档即弱」会天天误伤用户挂的新强模型。
 *   故反过来:只维护一份「确知偏弱」的清单(BELOW_TIER_MODELS),命中才提示;
 *   其余一律 unknown。代价是新出的弱模型在补进清单前不会被提示——可接受(软引导,非硬约束)。
 *
 * ─── 纯函数铁律(与 gate / triggers / dismissDowngrade 一致) ──────────────────
 *   - evaluateModelTier 给定 (provider, model) 输出完全确定。
 *   - 本判定不依赖时间,故无 now 参数;确定性来自「只看入参 + 静态清单」。
 *   - 无副作用:不读 Date.now / Math.random / DB / store / storage。
 *   - 清单与判定都是导出常量,测试精确引用(防清单与判定逻辑漂移)。
 *   - 大小写/空白归一:用户随手填的 model 字段宽容处理(trim + toLowerCase 后比较)。
 */

/** 支持「推荐档判定」的 provider(mock 无模型概念,故排除)。与 settings ProviderName 的非 mock 子集对齐。 */
export type TierProvider = "deepseek" | "anthropic" | "openai";

export type ModelTierStatus = "recommended" | "below" | "unknown";

export interface ModelTierVerdict {
  status: ModelTierStatus;
  /** 该 provider 当前推荐的模型名(UI 用来给出明确建议,任何 status 下都带出) */
  recommendedModel: string;
}

/**
 * 每家 provider 的推荐档模型。
 * 刻意与 settings.ts defaults() 里的默认 model 保持一致——「默认即推荐档」,
 * 用户清空 model 字段回落默认时不会被自己提示。改这里时记得同步看 settings 默认值。
 */
export const RECOMMENDED_MODELS: Record<TierProvider, string> = {
  deepseek: "deepseek-chat",
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

/**
 * 「已知低于推荐档」的弱模型清单(小写规范化形式,便于大小写不敏感匹配)。
 * 命中即提示升档。只列确知偏弱的——宁缺毋滥,避免误伤。
 *
 * 选取依据(2026-06 视角):各家面向「省钱/低延迟」的轻量档,推理与长上下文明显弱于推荐档,
 * 用作秘书主脑时回话质量会肉眼可见地打折。
 */
export const BELOW_TIER_MODELS: Record<TierProvider, string[]> = {
  // DeepSeek:历史轻量/旧版小模型
  deepseek: ["deepseek-coder", "deepseek-lite", "deepseek-chat-lite"],
  // Anthropic:haiku 系(快而轻,综合能力低于 sonnet/opus)
  anthropic: [
    "claude-3-haiku-20240307",
    "claude-3-5-haiku-20241022",
    "claude-3-5-haiku-latest",
  ],
  // OpenAI:gpt-3.5 系 + 4o-mini(廉价轻量档)
  openai: ["gpt-3.5-turbo", "gpt-3.5-turbo-0125", "gpt-4o-mini"],
};

/** 预计算的小写弱档集合,judge 时 O(1) 命中。 */
const BELOW_TIER_SET: Record<TierProvider, Set<string>> = {
  deepseek: new Set(BELOW_TIER_MODELS.deepseek.map((m) => m.toLowerCase())),
  anthropic: new Set(BELOW_TIER_MODELS.anthropic.map((m) => m.toLowerCase())),
  openai: new Set(BELOW_TIER_MODELS.openai.map((m) => m.toLowerCase())),
};

/** 取某 provider 的推荐档模型名。 */
export function recommendedModelFor(provider: TierProvider): string {
  return RECOMMENDED_MODELS[provider];
}

/** 归一化用户填的 model:trim + 小写;空/纯空白 → 空串。 */
function normalizeModel(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

/**
 * 判定用户给 provider 挂的 model 相对推荐档的位置。
 *
 * @param provider 支持判定的三家之一
 * @param model    用户在设置里填的 model 字段(可空 = 用默认推荐档)
 */
export function evaluateModelTier(
  provider: TierProvider,
  model: string | undefined
): ModelTierVerdict {
  const recommendedModel = RECOMMENDED_MODELS[provider];
  const norm = normalizeModel(model);

  // 没填 → 系统兜底走推荐档 → 不打扰
  if (norm === "") {
    return { status: "recommended", recommendedModel };
  }

  // 填的就是推荐档(大小写/空白不敏感)
  if (norm === recommendedModel.toLowerCase()) {
    return { status: "recommended", recommendedModel };
  }

  // 命中已知弱档 → 软性提示升档
  if (BELOW_TIER_SET[provider].has(norm)) {
    return { status: "below", recommendedModel };
  }

  // 其余一律未知(可能更强/更新/第三方名)→ 不乱报警
  return { status: "unknown", recommendedModel };
}
