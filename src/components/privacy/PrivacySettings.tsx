/**
 * PrivacySettings.tsx — Task 4.6a 隐私与成本设置面板
 *
 * 三个开关:
 *   1. 云端记忆披露区(展示文字 + 仅本地大脑开关 + 云端后端时警告)
 *   2. 敏感信息不记忆开关
 *   3. 省电/低频模式开关(一键写入 proactive)
 *
 * 沿用 SettingsPage 的 Field / SegmentControl 风格(复用而不引入新依赖)。
 */

import { useTranslation } from "react-i18next";
import { ShieldAlert, Info } from "lucide-react";
import {
  useSettingsStore,
} from "../../lib/settings";
import { applyLowPowerPreset, isCloudBackend } from "../../lib/privacy";
import { cn } from "../../lib/utils";

/** 与 SettingsPage 同款 Field 布局(label 左、控件右) */
function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <span className="text-sm text-zinc-700 dark:text-zinc-300">{label}</span>
          {description && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">{description}</p>
          )}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    </div>
  );
}

/** 与 SettingsPage 同款 SegmentControl */
function Toggle({
  value,
  onChange,
  labelOn,
  labelOff,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <div className="inline-flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
      {(["on", "off"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt === "on")}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-md transition-colors",
            (opt === "on") === value
              ? "bg-white dark:bg-zinc-950 shadow-sm text-zinc-900 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          )}
        >
          {opt === "on" ? labelOn : labelOff}
        </button>
      ))}
    </div>
  );
}

export function PrivacySettings() {
  const { t } = useTranslation();
  const localOnlyBrain = useSettingsStore((s) => s.localOnlyBrain);
  const noSensitiveMemory = useSettingsStore((s) => s.noSensitiveMemory);
  const lowPowerMode = useSettingsStore((s) => s.lowPowerMode);
  const chatBackend = useSettingsStore((s) => s.chatBackend);
  const setPrivacy = useSettingsStore((s) => s.setPrivacy);
  const setProactive = useSettingsStore((s) => s.setProactive);

  // 当前后端是否为云端 API(影响仅本地大脑的警告展示)
  const cloudBackend = isCloudBackend(chatBackend);

  function handleLowPower(enabled: boolean) {
    setPrivacy({ lowPowerMode: enabled });
    if (enabled) {
      // 一键写入低频预设到 proactive 配置
      setProactive(applyLowPowerPreset());
    }
    // 关闭时不自动还原 heartbeatMin(用户可能手动调过;让他自己改回去)
  }

  return (
    <div className="space-y-5">
      {/* ── 云端记忆披露 ── */}
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 p-3 space-y-1.5">
        <div className="flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
            {t("privacy.disclosureTitle")}
          </p>
        </div>
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed ml-5">
          {t("privacy.disclosureBody")}
        </p>
      </div>

      {/* ── 仅本地大脑 ── */}
      <Field
        label={t("privacy.localOnlyBrain")}
        description={t("privacy.localOnlyBrainDesc")}
      >
        <Toggle
          value={localOnlyBrain}
          onChange={(v) => setPrivacy({ localOnlyBrain: v })}
          labelOn={t("privacy.on")}
          labelOff={t("privacy.off")}
        />
      </Field>

      {/* 云端后端 + 仅本地大脑开启:显示警告 */}
      {localOnlyBrain && cloudBackend && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-3 flex items-start gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
            {t("privacy.localOnlyBrainWarning")}
          </p>
        </div>
      )}

      {/* ── 敏感不记 ── */}
      <Field
        label={t("privacy.noSensitiveMemory")}
        description={t("privacy.noSensitiveMemoryDesc")}
      >
        <Toggle
          value={noSensitiveMemory}
          onChange={(v) => setPrivacy({ noSensitiveMemory: v })}
          labelOn={t("privacy.on")}
          labelOff={t("privacy.off")}
        />
      </Field>

      {/* ── 省电/低频模式 ── */}
      <Field
        label={t("privacy.lowPowerMode")}
        description={t("privacy.lowPowerModeDesc")}
      >
        <Toggle
          value={lowPowerMode}
          onChange={handleLowPower}
          labelOn={t("privacy.on")}
          labelOff={t("privacy.off")}
        />
      </Field>
    </div>
  );
}
