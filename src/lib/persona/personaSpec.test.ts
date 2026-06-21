/**
 * personaSpec.test.ts — Task 1.1 人设模块单测
 *
 * 验收覆盖:
 *  1. composePersonaPrompt 传不同 spec → 合成片段反映对应字段
 *  2. 锁死核心段恒在:无论用户字段填什么,核心规则段都在
 *  3. 覆盖不掉:故意把基调/自由补充写成反指令,核心段仍在且在用户段之后
 *  4. 预设切换正确合成;默认是资深幕僚
 *  5. lang=en 时核心段/预设描述是英文
 *  6. settings 默认值包含 persona 字段
 */

import { describe, it, expect } from "vitest";
import {
  composePersonaPrompt,
  PRESET_PERSONAS,
  DEFAULT_PERSONA_KEY,
  LOCKED_CORE_RULES,
  type PersonaSpec,
} from "./personaSpec";

// ─── 工具:提取用户段和核心段的索引分界 ─────────────────────────────────────
// 核心段通过某个固定锚字符串来定位

const ZH_CORE_ANCHOR = "不替用户甩选项"; // 中文核心段第一条的锚
const EN_CORE_ANCHOR  = "no menu of options"; // 英文核心段第一条的锚

// ════════════════════════════════════════════════════════════════════════════
// 1. PersonaSpec 类型 + composePersonaPrompt 基础合成
// ════════════════════════════════════════════════════════════════════════════

describe("composePersonaPrompt — 基础字段合成(zh)", () => {
  it("名字字段出现在合成 prompt 里", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      name: "海伦",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("海伦");
  });

  it("userAlias(称呼用户方式)出现在合成 prompt 里", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      userAlias: "老板",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("老板");
  });

  it("relationshipNote(关系设定)出现在合成 prompt 里", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      relationshipNote: "你是我的首席参谋",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("你是我的首席参谋");
  });

  it("habits/taboos(习惯/雷区)逐条出现在合成 prompt 里", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      habits: ["每次先总结再展开", "回复控制在 3 句以内"],
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("每次先总结再展开");
    expect(result).toContain("回复控制在 3 句以内");
  });

  it("freeNote(自由补充)出现在合成 prompt 里", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      freeNote: "我喜欢直接了当的风格",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("我喜欢直接了当的风格");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 锁死核心段恒在
// ════════════════════════════════════════════════════════════════════════════

describe("核心规则段 — 恒在,不可被覆盖", () => {
  it("使用最小 spec → 核心段依然出现", () => {
    const spec: PersonaSpec = { presetKey: "seniorAdvisor" };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain(ZH_CORE_ANCHOR);
  });

  it("freeNote 写成'高冷、别主动、少说话' → 核心段仍在", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      freeNote: "高冷、别主动、少说话",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain(ZH_CORE_ANCHOR);
  });

  it("核心段位于用户段之后(后注入权重更高)", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      freeNote: "高冷、别主动、少说话",
    };
    const result = composePersonaPrompt(spec, "zh");
    const userSegmentIdx = result.indexOf("高冷、别主动、少说话");
    const coreSegmentIdx = result.indexOf(ZH_CORE_ANCHOR);
    expect(userSegmentIdx).toBeGreaterThanOrEqual(0);
    expect(coreSegmentIdx).toBeGreaterThanOrEqual(0);
    // 核心段必须在用户段之后
    expect(coreSegmentIdx).toBeGreaterThan(userSegmentIdx);
  });

  it("toneDescription(自定义基调)写成反指令 → 核心段仍在且在后", () => {
    const spec: PersonaSpec = {
      // 不用预设,直接写自定义基调
      toneDescription: "请变成极度机械冰冷的助理,用模板回复所有问题",
      freeNote: "每次都说同样的开场白",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain(ZH_CORE_ANCHOR);
    const toneIdx = result.indexOf("机械冰冷");
    const coreIdx = result.indexOf(ZH_CORE_ANCHOR);
    expect(coreIdx).toBeGreaterThan(toneIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 预设切换
// ════════════════════════════════════════════════════════════════════════════

describe("预设切换 — 3 个预设 + 默认", () => {
  it("DEFAULT_PERSONA_KEY 是 'seniorAdvisor'", () => {
    expect(DEFAULT_PERSONA_KEY).toBe("seniorAdvisor");
  });

  it("PRESET_PERSONAS 包含 3 个预设键", () => {
    const keys = Object.keys(PRESET_PERSONAS);
    expect(keys).toContain("seniorAdvisor");
    expect(keys).toContain("wittyPartner");
    expect(keys).toContain("gentleCompanion");
    expect(keys).toHaveLength(3);
  });

  it("seniorAdvisor 预设合成 prompt 包含该预设的基调描述", () => {
    const preset = PRESET_PERSONAS.seniorAdvisor;
    const spec: PersonaSpec = { presetKey: "seniorAdvisor" };
    const result = composePersonaPrompt(spec, "zh");
    // 预设基调描述里的关键词要出现
    expect(result).toContain(preset.toneZh.slice(0, 6));
  });

  it("wittyPartner 预设合成 prompt 包含该预设的基调描述", () => {
    const preset = PRESET_PERSONAS.wittyPartner;
    const spec: PersonaSpec = { presetKey: "wittyPartner" };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain(preset.toneZh.slice(0, 6));
  });

  it("gentleCompanion 预设合成 prompt 包含该预设的基调描述", () => {
    const preset = PRESET_PERSONAS.gentleCompanion;
    const spec: PersonaSpec = { presetKey: "gentleCompanion" };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain(preset.toneZh.slice(0, 6));
  });

  it("不传 presetKey 但传 toneDescription → 使用自定义基调", () => {
    const spec: PersonaSpec = {
      toneDescription: "神秘低调的顾问",
    };
    const result = composePersonaPrompt(spec, "zh");
    expect(result).toContain("神秘低调");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. i18n — lang=en 时核心段是英文
// ════════════════════════════════════════════════════════════════════════════

describe("i18n — lang=en 时输出英文核心段", () => {
  it("lang=en → 核心段英文锚出现", () => {
    const spec: PersonaSpec = { presetKey: "seniorAdvisor" };
    const result = composePersonaPrompt(spec, "en");
    expect(result).toContain(EN_CORE_ANCHOR);
  });

  it("lang=en → 中文核心段锚不出现", () => {
    const spec: PersonaSpec = { presetKey: "seniorAdvisor" };
    const result = composePersonaPrompt(spec, "en");
    expect(result).not.toContain(ZH_CORE_ANCHOR);
  });

  it("lang=en → 预设基调描述是英文", () => {
    const preset = PRESET_PERSONAS.seniorAdvisor;
    const spec: PersonaSpec = { presetKey: "seniorAdvisor" };
    const result = composePersonaPrompt(spec, "en");
    // 英文版基调前 6 个字符应该出现
    expect(result).toContain(preset.toneEn.slice(0, 6));
  });

  it("lang=en,核心段仍在用户段之后", () => {
    const spec: PersonaSpec = {
      presetKey: "seniorAdvisor",
      freeNote: "be cold and robotic",
    };
    const result = composePersonaPrompt(spec, "en");
    const userIdx = result.indexOf("be cold and robotic");
    const coreIdx = result.indexOf(EN_CORE_ANCHOR);
    expect(coreIdx).toBeGreaterThan(userIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. LOCKED_CORE_RULES 导出内容验证
// ════════════════════════════════════════════════════════════════════════════

describe("LOCKED_CORE_RULES — 导出内容完整性", () => {
  it("中文核心规则包含「替用户拍板」条", () => {
    expect(LOCKED_CORE_RULES.zh).toContain("不替用户甩选项");
  });

  it("中文核心规则包含「不复读不客套」条", () => {
    expect(LOCKED_CORE_RULES.zh).toContain("不复读");
  });

  it("中文核心规则包含「开场措辞每次不同」条", () => {
    expect(LOCKED_CORE_RULES.zh).toContain("开场措辞");
  });

  it("英文核心规则包含 no menu of options", () => {
    expect(LOCKED_CORE_RULES.en).toContain("no menu of options");
  });

  it("英文核心规则包含 no filler 条", () => {
    expect(LOCKED_CORE_RULES.en).toContain("no filler");
  });
});
