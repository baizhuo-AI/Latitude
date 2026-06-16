/**
 * modelTier.test.ts — Task 3.6:模型「推荐档位」判定纯函数测试
 *
 * 规格(R3 弱模型地板的软性引导命门):
 *   evaluateModelTier(provider, model) → { status, recommendedModel }
 *   - status="recommended":空 model(用默认推荐档)或填的就是推荐档 → 不打扰
 *   - status="below":填了「已知低于推荐档」的弱模型 → 软性提示用户升档
 *   - status="unknown":填了不认识的 model → 不乱报警(信号稀疏返回未知,温和姿态)
 *   - recommendedModel:该 provider 当前推荐的模型名,UI 用来给出明确建议
 *
 * 铁律2:纯函数,给定输入输出完全确定;函数体内不读 Date.now / 不读 store / 无副作用。
 *        (本判定不依赖时间,故无 now 参数;确定性来自只看入参。)
 */

import { describe, it, expect } from "vitest";
import {
  evaluateModelTier,
  recommendedModelFor,
  RECOMMENDED_MODELS,
  BELOW_TIER_MODELS,
  type TierProvider,
  type ModelTierVerdict,
} from "./modelTier";

describe("recommendedModelFor —— 每家 provider 的推荐档模型", () => {
  it("三家都有明确推荐档,且与 settings 默认值一致", () => {
    expect(recommendedModelFor("deepseek")).toBe("deepseek-chat");
    expect(recommendedModelFor("anthropic")).toBe("claude-sonnet-4-20250514");
    expect(recommendedModelFor("openai")).toBe("gpt-4o");
  });

  it("RECOMMENDED_MODELS 常量覆盖全部 TierProvider(测试可精确引用)", () => {
    const providers: TierProvider[] = ["deepseek", "anthropic", "openai"];
    for (const p of providers) {
      expect(RECOMMENDED_MODELS[p]).toBeTruthy();
    }
  });
});

describe("evaluateModelTier —— 空 model = 用默认推荐档", () => {
  it("空字符串 → recommended(用户没填,系统兜底走推荐档)", () => {
    const v: ModelTierVerdict = evaluateModelTier("deepseek", "");
    expect(v.status).toBe("recommended");
    expect(v.recommendedModel).toBe("deepseek-chat");
  });

  it("undefined → recommended", () => {
    expect(evaluateModelTier("anthropic", undefined).status).toBe("recommended");
  });

  it("纯空白 → 视同未填 → recommended", () => {
    expect(evaluateModelTier("openai", "   ").status).toBe("recommended");
  });
});

describe("evaluateModelTier —— 填的就是推荐档", () => {
  it("精确等于推荐档 → recommended", () => {
    expect(evaluateModelTier("deepseek", "deepseek-chat").status).toBe("recommended");
    expect(evaluateModelTier("anthropic", "claude-sonnet-4-20250514").status).toBe(
      "recommended"
    );
    expect(evaluateModelTier("openai", "gpt-4o").status).toBe("recommended");
  });

  it("前后空白不影响识别(trim 后比较)", () => {
    expect(evaluateModelTier("deepseek", "  deepseek-chat  ").status).toBe("recommended");
  });

  it("大小写不敏感(用户大小写随手填)", () => {
    expect(evaluateModelTier("openai", "GPT-4O").status).toBe("recommended");
  });

  it("更高档模型(非已知弱档)→ 不报警:unknown(只地板,不封顶)", () => {
    // 用户挂了个更强/更新的模型,我们不认识但不该提示「低于推荐」
    expect(evaluateModelTier("anthropic", "claude-opus-4-20250514").status).toBe(
      "unknown"
    );
    expect(evaluateModelTier("openai", "gpt-4.1").status).toBe("unknown");
  });
});

describe("evaluateModelTier —— 已知低于推荐档的弱模型 → below(软性引导命门)", () => {
  it("deepseek 已知弱档", () => {
    // 占位/最弱的小模型(从 BELOW_TIER_MODELS 取真实条目)
    const weak = BELOW_TIER_MODELS.deepseek[0];
    const v = evaluateModelTier("deepseek", weak);
    expect(v.status).toBe("below");
    expect(v.recommendedModel).toBe("deepseek-chat");
  });

  it("anthropic 已知弱档(haiku 系)→ below", () => {
    const v = evaluateModelTier("anthropic", "claude-3-haiku-20240307");
    expect(v.status).toBe("below");
    expect(v.recommendedModel).toBe("claude-sonnet-4-20250514");
  });

  it("openai 已知弱档(gpt-3.5 / mini 系)→ below", () => {
    expect(evaluateModelTier("openai", "gpt-3.5-turbo").status).toBe("below");
    expect(evaluateModelTier("openai", "gpt-4o-mini").status).toBe("below");
  });

  it("弱档识别也大小写不敏感 + trim", () => {
    expect(evaluateModelTier("openai", "  GPT-3.5-Turbo ").status).toBe("below");
  });

  it("BELOW_TIER_MODELS 里的每一项都判为 below(清单与判定一致,防漂移)", () => {
    const providers: TierProvider[] = ["deepseek", "anthropic", "openai"];
    for (const p of providers) {
      for (const m of BELOW_TIER_MODELS[p]) {
        expect(evaluateModelTier(p, m).status).toBe("below");
      }
    }
  });
});

describe("evaluateModelTier —— 不认识的 model → unknown(温和:信号稀疏不乱报警)", () => {
  it("完全陌生的串 → unknown", () => {
    expect(evaluateModelTier("deepseek", "some-random-model-x").status).toBe("unknown");
    expect(evaluateModelTier("openai", "o3-pro").status).toBe("unknown");
  });

  it("unknown 时仍带出 recommendedModel(UI 想引导时可用)", () => {
    const v = evaluateModelTier("anthropic", "totally-made-up");
    expect(v.status).toBe("unknown");
    expect(v.recommendedModel).toBe("claude-sonnet-4-20250514");
  });
});
