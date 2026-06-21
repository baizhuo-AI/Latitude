/**
 * PersonaPanel.tsx — 人设配置面板 (Task 1.2)
 *
 * 功能:
 *  - 名字输入
 *  - 性格基调:3 预设 chips + 基调可编辑覆盖
 *  - 怎么称呼你(输入) + 关系设定(chips)
 *  - 习惯/雷区(可加可删 chips)
 *  - 自由补充(textarea)
 *  - 改动实时写入 settings.persona(setPersona + 持久化)
 *  - 试一句:当前草稿 → composePersonaPrompt + generateOnce → 就地展示
 *  - 节流:pending 时禁用按钮(连点只调一次)
 *  - 无 key:provider=mock 或 apiKey 为空时展示引导文案,不调 generateOnce
 */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, X, Plus } from "lucide-react";
import { useSettingsStore } from "../../lib/settings";
import {
  PRESET_PERSONAS,
  composePersonaPrompt,
  type PresetPersonaKey,
} from "../../lib/persona/personaSpec";
import { generateOnce } from "../../lib/llm/index";
import { cn } from "../../lib/utils";

// ─── 预设 key 顺序 ────────────────────────────────────────────────────────────
const PRESET_KEYS: PresetPersonaKey[] = ["seniorAdvisor", "wittyPartner", "gentleCompanion"];

// ─── 预设关系设定 chips ───────────────────────────────────────────────────────
const RELATION_OPTIONS: Array<{ zh: string; en: string; value: string }> = [
  { zh: "职场搭档", en: "Work partner", value: "work_partner" },
  { zh: "贴身幕僚", en: "Personal advisor", value: "personal_advisor" },
  { zh: "思维伙伴", en: "Thinking buddy", value: "thinking_buddy" },
  { zh: "自定义", en: "Custom", value: "custom" },
];

// ─── 是否有可用的 LLM(非 mock / 有 apiKey) ────────────────────────────────────
function useHasLlmKey(): boolean {
  const llmProvider = useSettingsStore((s) => s.llmProvider);
  const providers = useSettingsStore((s) => s.providers);

  if (llmProvider === "mock") return false;
  const cfg = providers[llmProvider as keyof typeof providers];
  if (!cfg) return false;
  return !!(cfg as { apiKey?: string }).apiKey;
}

// ─── 公共 input/textarea 样式 ─────────────────────────────────────────────────
const inputCls = cn(
  "w-full px-3 py-1.5 rounded-lg text-sm outline-none transition-colors",
  "bg-zinc-50 dark:bg-zinc-950",
  "border border-zinc-200 dark:border-zinc-700",
  "focus:border-indigo-500",
  "text-zinc-900 dark:text-zinc-100",
  "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
);

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function PersonaPanel() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language?.startsWith("en") ? "en" : "zh") as "zh" | "en";

  const persona = useSettingsStore((s) => s.persona);
  const setPersona = useSettingsStore((s) => s.setPersona);
  const hasKey = useHasLlmKey();

  // Local draft state (mirrors store, committed on blur/action)
  const [name, setName] = useState(persona.name ?? "");
  const [selectedPreset, setSelectedPreset] = useState<PresetPersonaKey>(
    persona.presetKey ?? "seniorAdvisor"
  );
  const [toneDescription, setToneDescription] = useState(
    persona.toneDescription ?? PRESET_PERSONAS[persona.presetKey ?? "seniorAdvisor"][lang === "zh" ? "toneZh" : "toneEn"]
  );
  const [userAlias, setUserAlias] = useState(persona.userAlias ?? "");
  const [relationshipNote, setRelationshipNote] = useState(persona.relationshipNote ?? "");
  const [habits, setHabits] = useState<string[]>(persona.habits ?? []);
  const [habitDraft, setHabitDraft] = useState("");
  const [freeNote, setFreeNote] = useState(persona.freeNote ?? "");

  // Trial sample state
  const [trialResult, setTrialResult] = useState<string | null>(null);
  const [trialPending, setTrialPending] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [showNoKey, setShowNoKey] = useState(false);

  // Throttle ref: only one call at a time
  const pendingRef = useRef(false);

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Commit a partial persona patch to the store */
  const commit = useCallback(
    (patch: Parameters<typeof setPersona>[0]) => {
      setPersona(patch);
    },
    [setPersona]
  );

  // ── handlers ───────────────────────────────────────────────────────────────

  function handlePresetSelect(key: PresetPersonaKey) {
    setSelectedPreset(key);
    const preset = PRESET_PERSONAS[key];
    const newTone = lang === "zh" ? preset.toneZh : preset.toneEn;
    setToneDescription(newTone);
    commit({ presetKey: key, toneDescription: undefined });
  }

  function handleToneChange(val: string) {
    setToneDescription(val);
    commit({ toneDescription: val });
  }

  function handleAddHabit(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const val = habitDraft.trim();
    if (!val) return;
    const next = [...habits, val];
    setHabits(next);
    setHabitDraft("");
    commit({ habits: next });
  }

  function handleDeleteHabit(idx: number) {
    const next = habits.filter((_, i) => i !== idx);
    setHabits(next);
    commit({ habits: next });
  }

  function handleRelationChip(value: string) {
    const note = value === "custom" ? "" : RELATION_OPTIONS.find((r) => r.value === value)?.[lang === "zh" ? "zh" : "en"] ?? "";
    setRelationshipNote(note);
    commit({ relationshipNote: note });
  }

  // ── 试一句 ─────────────────────────────────────────────────────────────────

  async function handleTrySample() {
    // No-key guard
    if (!hasKey) {
      setShowNoKey(true);
      return;
    }

    // Throttle: if a request is already pending, ignore
    if (pendingRef.current) return;

    setShowNoKey(false);
    setTrialError(null);
    setTrialResult(null);
    setTrialPending(true);
    pendingRef.current = true;

    try {
      // Build current draft spec (don't read store to avoid stale)
      const draftSpec = {
        presetKey: selectedPreset,
        toneDescription: toneDescription !== PRESET_PERSONAS[selectedPreset][lang === "zh" ? "toneZh" : "toneEn"]
          ? toneDescription
          : undefined,
        name: name.trim() || undefined,
        userAlias: userAlias.trim() || undefined,
        relationshipNote: relationshipNote.trim() || undefined,
        habits: habits.length > 0 ? habits : undefined,
        freeNote: freeNote.trim() || undefined,
      };

      const systemPrompt = composePersonaPrompt(draftSpec, lang);

      const samplePrompt =
        lang === "zh"
          ? "现在是早上 9 点。请用你的风格给我一条今日简报（一两句话），再给我一条催办提醒（针对一个假设的待办「准备 Q3 汇报」）。格式自由,别套模版。"
          : "It's 9am. Give me a brief morning briefing (1-2 sentences) in your style, then a quick nudge for a hypothetical task 'Prepare Q3 report'. Free format, no templates.";

      const result = await generateOnce(systemPrompt, [
        { role: "user", content: samplePrompt },
      ]);
      setTrialResult(result);
    } catch (err) {
      setTrialError(String(err));
    } finally {
      setTrialPending(false);
      pendingRef.current = false;
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* 名字 */}
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor="persona-name"
          className="text-sm text-zinc-700 dark:text-zinc-300 flex-shrink-0"
        >
          {t("persona.name")}
        </label>
        <input
          id="persona-name"
          type="text"
          aria-label={t("persona.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => commit({ name: name.trim() || undefined })}
          placeholder={lang === "zh" ? "例如:星助" : "e.g. Nova"}
          className={cn(inputCls, "w-56")}
        />
      </div>

      {/* 性格基调 预设 chips */}
      <div className="space-y-2">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {t("persona.tone")}
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESET_KEYS.map((key) => {
            const preset = PRESET_PERSONAS[key];
            const label = lang === "zh" ? preset.labelZh : preset.labelEn;
            const isSelected = selectedPreset === key;
            return (
              <button
                key={key}
                type="button"
                aria-label={t(`persona.preset.${key}`)}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => handlePresetSelect(key)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  isSelected
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 基调描述(可编辑覆盖) */}
        <textarea
          data-testid="tone-description"
          rows={3}
          value={toneDescription}
          onChange={(e) => handleToneChange(e.target.value)}
          className={cn(inputCls, "resize-none text-xs leading-relaxed")}
          placeholder={lang === "zh" ? "可直接编辑修改基调描述…" : "Edit tone description here…"}
        />
      </div>

      {/* 怎么称呼你 */}
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor="persona-alias"
          className="text-sm text-zinc-700 dark:text-zinc-300 flex-shrink-0"
        >
          {t("persona.userAlias")}
        </label>
        <input
          id="persona-alias"
          type="text"
          aria-label={t("persona.userAlias")}
          value={userAlias}
          onChange={(e) => setUserAlias(e.target.value)}
          onBlur={() => commit({ userAlias: userAlias.trim() || undefined })}
          placeholder={lang === "zh" ? "例如:Boss / 老板 / 名字" : "e.g. Boss / Alex"}
          className={cn(inputCls, "w-56")}
        />
      </div>

      {/* 关系设定 chips */}
      <div className="space-y-2">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {t("persona.relationship")}
        </p>
        <div className="flex flex-wrap gap-2">
          {RELATION_OPTIONS.map((r) => (
            <button
              key={r.value}
              type="button"
              data-testid="relation-chip"
              onClick={() => handleRelationChip(r.value)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                relationshipNote === (lang === "zh" ? r.zh : r.en) && r.value !== "custom"
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              )}
            >
              {lang === "zh" ? r.zh : r.en}
            </button>
          ))}
        </div>
      </div>

      {/* 习惯/雷区 */}
      <div className="space-y-2">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {t("persona.habits")}
        </p>
        {/* 已有 chips */}
        {habits.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {habits.map((h, idx) => (
              <span
                key={`${h}-${idx}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
              >
                {h}
                <button
                  type="button"
                  data-testid="habit-delete"
                  aria-label={`delete habit ${h}`}
                  onClick={() => handleDeleteHabit(idx)}
                  className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* 新增输入 */}
        <div className="flex items-center gap-2">
          <Plus className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
          <input
            type="text"
            aria-label={t("persona.habitInput")}
            value={habitDraft}
            onChange={(e) => setHabitDraft(e.target.value)}
            onKeyDown={handleAddHabit}
            placeholder={
              lang === "zh"
                ? "输入习惯或雷区,回车添加"
                : "Type a habit or boundary, press Enter"
            }
            className={cn(inputCls, "flex-1")}
          />
        </div>
      </div>

      {/* 自由补充 */}
      <div className="space-y-1.5">
        <label
          htmlFor="persona-freenote"
          className="text-sm text-zinc-700 dark:text-zinc-300"
        >
          {t("persona.freeNote")}
        </label>
        <textarea
          id="persona-freenote"
          aria-label={t("persona.freeNote")}
          rows={2}
          value={freeNote}
          onChange={(e) => setFreeNote(e.target.value)}
          onBlur={() => commit({ freeNote: freeNote.trim() || undefined })}
          placeholder={
            lang === "zh"
              ? "其他想告诉 AI 的..."
              : "Anything else..."
          }
          className={cn(inputCls, "resize-none text-xs leading-relaxed")}
        />
      </div>

      {/* 试一句 */}
      <div className="space-y-2 pt-1 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t("persona.trySample")}
            disabled={trialPending}
            onClick={() => void handleTrySample()}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors",
              "bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
            )}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {trialPending
              ? t("persona.trySamplePending")
              : t("persona.trySample")}
          </button>
          {trialPending && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {lang === "zh" ? "AI 生成中…" : "Generating…"}
            </span>
          )}
        </div>

        {/* 无 key 引导文案 */}
        {showNoKey && (
          <div
            data-testid="trial-no-key"
            className="rounded-lg p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-700 dark:text-amber-300 leading-relaxed"
          >
            {t("persona.noKey")}
          </div>
        )}

        {/* 试一句结果 */}
        {trialResult && (
          <div
            data-testid="trial-result"
            className="rounded-lg p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap leading-relaxed"
          >
            {trialResult}
          </div>
        )}

        {trialError && (
          <p className="text-xs text-red-500">{trialError}</p>
        )}
      </div>

      {/* 底部锁定规则说明(C5) */}
      <p
        data-testid="locked-rules-note"
        className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed"
      >
        {t("persona.lockedRulesNote")}
      </p>
    </div>
  );
}
