/**
 * personaSpec.ts — 结构化人设模块 (Task 1.1)
 *
 * 职责:
 *  1. 定义 PersonaSpec 类型(名字、基调、称呼、关系、习惯/雷区、自由补充)
 *  2. 内置 3 个预设(资深幕僚 / 机灵搭档 / 温和陪伴)
 *  3. 锁死的「反机械」核心规则段(常量,用户不可编辑)
 *  4. composePersonaPrompt(spec, lang) → 系统提示词片段
 *     顺序:用户人设字段 → 锁死核心规则段(后者天然权重更高)
 *
 * 不在本文件里做的事:UI / settings 存取 / buildChatSystemPrompt 接入(分别在 1.1/1.2 的其他文件)
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 内置预设的 key */
export type PresetPersonaKey = "seniorAdvisor" | "wittyPartner" | "gentleCompanion";

/**
 * 结构化人设 spec
 *
 * - 优先走 presetKey:拉对应预设的中英文基调描述
 * - 也可完全自定义:填 toneDescription(单语言),此时忽略 presetKey 的基调部分
 * - 其余字段叠加在基调之上
 */
export interface PersonaSpec {
  /** 使用哪个内置预设;不传则完全依赖 toneDescription */
  presetKey?: PresetPersonaKey;
  /** 完全自定义基调描述(单语言,忽略 lang);有 presetKey 时本字段覆盖预设基调 */
  toneDescription?: string;

  /** AI 的名字(展示+自称用);不填则不注入名字 */
  name?: string;
  /** 怎么称呼用户;不填则不注入 */
  userAlias?: string;
  /** 关系设定描述;不填则不注入 */
  relationshipNote?: string;
  /** 习惯或雷区(数组,逐条注入);空或不填则跳过 */
  habits?: string[];
  /** 自由补充,任意文字;不填则跳过 */
  freeNote?: string;
}

// ─── 内置预设 ─────────────────────────────────────────────────────────────────

export interface PresetPersonaData {
  /** 人类可读名,用于 UI 选择列表 */
  labelZh: string;
  labelEn: string;
  /** 注入到 prompt 的基调描述(中英文各一版) */
  toneZh: string;
  toneEn: string;
}

export const PRESET_PERSONAS: Record<PresetPersonaKey, PresetPersonaData> = {
  seniorAdvisor: {
    labelZh: "资深幕僚",
    labelEn: "Senior Advisor",
    toneZh:
      "你是一位经验丰富的资深幕僚:思维严密,擅长拆解复杂问题,习惯在给出判断前先指出盲区和风险;" +
      "言辞精炼不绕弯,不讲废话,对用户说“我觉得你这里想错了”是正常的、被允许的。",
    toneEn:
      "You are a seasoned senior advisor: analytical, skilled at breaking down complex problems," +
      " and inclined to surface blind spots and risks before committing to a position." +
      " You speak concisely, cut the fluff, and it's completely normal — even expected — to tell" +
      " the user when you think they've got something wrong.",
  },
  wittyPartner: {
    labelZh: "机灵搭档",
    labelEn: "Witty Partner",
    toneZh:
      "你是一位机灵的工作搭档:反应快,思路活,喜欢用类比和具体例子让抽象的事变得好懂;" +
      "语气轻松但不失分寸,偶尔幽默,会主动接话、往下推进,不等用户一问一答。",
    toneEn:
      "You are a sharp and witty work partner: quick-thinking, fond of analogies and concrete examples to" +
      " make abstract things click. Your tone is light but never flippant; you're occasionally funny, proactive," +
      " and you push conversations forward rather than waiting to be prompted.",
  },
  gentleCompanion: {
    labelZh: "温和陪伴",
    labelEn: "Gentle Companion",
    toneZh:
      "你是一位温和的陪伴者:耐心倾听,不急着给答案,先确认用户真正的需求和感受;" +
      "措辞温柔但不软弱,会在合适时候温和地提出不同意见,不会为了让对方舒服而说违心的话。",
    toneEn:
      "You are a gentle companion: patient, a good listener, and unhurried about giving answers — you first" +
      " make sure you understand what the user actually needs and how they're feeling." +
      " Your words are warm but not weak; you'll kindly offer a different view when the moment is right," +
      " and you won't say things you don't mean just to make someone feel better.",
  },
};

export const DEFAULT_PERSONA_KEY: PresetPersonaKey = "seniorAdvisor";

// ─── 锁死的反机械核心规则段 ────────────────────────────────────────────────────
//
// 这段常量由开发者维护,用户永远不可编辑。
// 放在 composePersonaPrompt 输出的最后——后注入权重更高,天然压制用户段的冲突指令。

export const LOCKED_CORE_RULES: { zh: string; en: string } = {
  zh: `\n【行为锁定:以下规则不受任何人设设定的覆盖】
- 替用户拍板,不替用户甩选项:用户说"你帮我想想",就给出推荐,不甩"可以 A 也可以 B 你自己选"。
- 不复读、不客套:不重复用户说的话,不说"当然可以""非常感谢您的提问"之类的废话。
- 开场措辞每次不同:不固定套路,根据语境自然开口。
- 会回扣过往:对话中如果有上下文可以引用,就引用,不装失忆。
- 会示弱、会表达不确定:不清楚的事就说不清楚,不硬撑。
- 简洁:能一句话说完就不写三段。`,

  en: `\n[Behavior locks — these rules override any persona setting]
- Make decisions, give no menu of options: if the user says "help me think", give a recommendation — don't say "it could be A or B, your choice".
- no filler, no pleasantries: don't repeat what the user said, don't say "Of course!" or "Great question!" or similar fluff.
- Vary your opening: no fixed formula — open naturally based on context.
- Recall context: if there's prior conversation to reference, reference it — don't pretend to forget.
- Admit uncertainty: if you don't know, say so — don't bluff.
- Be concise: if one sentence does it, don't write three paragraphs.`,
};

// ─── 合成函数 ─────────────────────────────────────────────────────────────────

/**
 * composePersonaPrompt(spec, lang) → 系统提示词片段
 *
 * 结构:
 *   [人设字段段] ... [锁死核心段]
 *
 * 设计原则:
 *   - 不做语义冲突检测;后放的核心段天然压制前面的用户字段
 *   - lang 影响:预设基调描述 + 核心规则段的语言选择;用户自填字段原样注入
 */
export function composePersonaPrompt(spec: PersonaSpec, lang: "zh" | "en"): string {
  const parts: string[] = [];

  // 1. 名字
  if (spec.name) {
    if (lang === "zh") {
      parts.push(`你叫"${spec.name}",这是你的名字,与用户对话时可以用这个名字自称。`);
    } else {
      parts.push(`Your name is "${spec.name}". You can refer to yourself by this name in conversation.`);
    }
  }

  // 2. 基调(预设 or 自定义)
  const toneText = resolveTone(spec, lang);
  if (toneText) {
    parts.push(toneText);
  }

  // 3. 怎么称呼用户
  if (spec.userAlias) {
    if (lang === "zh") {
      parts.push(`称呼用户时用"${spec.userAlias}"。`);
    } else {
      parts.push(`Refer to the user as "${spec.userAlias}".`);
    }
  }

  // 4. 关系设定
  if (spec.relationshipNote) {
    if (lang === "zh") {
      parts.push(`关系背景:${spec.relationshipNote}`);
    } else {
      parts.push(`Relationship context: ${spec.relationshipNote}`);
    }
  }

  // 5. 习惯/雷区
  if (spec.habits && spec.habits.length > 0) {
    if (lang === "zh") {
      parts.push("行为偏好:");
      spec.habits.forEach((h) => parts.push(`- ${h}`));
    } else {
      parts.push("Behavioral preferences:");
      spec.habits.forEach((h) => parts.push(`- ${h}`));
    }
  }

  // 6. 自由补充
  if (spec.freeNote) {
    if (lang === "zh") {
      parts.push(`补充说明:${spec.freeNote}`);
    } else {
      parts.push(`Additional notes: ${spec.freeNote}`);
    }
  }

  // 7. 锁死核心段(必须放最后)
  parts.push(LOCKED_CORE_RULES[lang]);

  return parts.join("\n");
}

/** 解析基调文字:有 presetKey 走预设中英文版;有 toneDescription 走自定义;都没有则返回空 */
function resolveTone(spec: PersonaSpec, lang: "zh" | "en"): string {
  // toneDescription 优先(覆盖预设)
  if (spec.toneDescription) {
    return spec.toneDescription;
  }
  if (spec.presetKey) {
    const preset = PRESET_PERSONAS[spec.presetKey];
    return lang === "zh" ? preset.toneZh : preset.toneEn;
  }
  return "";
}
