import { useId, useState } from "react";
import { useNoticePreferences } from "./preferences";
import "./petNotices.css";

export function NoticeSettings({ className = "" }: { className?: string }) {
  const id = useId();
  const { preferences, updatePreferences } = useNoticePreferences();
  const [custom, setCustom] = useState(preferences.dismissAfterSeconds !== null && ![10, 30, 60].includes(preferences.dismissAfterSeconds));
  return (
    <fieldset className={`pet-notice-settings ${className}`}>
      <legend>提醒的显示方式</legend>
      <label htmlFor={`${id}-duration`}>气泡保留多久</label>
      <select
        id={`${id}-duration`}
        value={custom ? "custom" : preferences.dismissAfterSeconds ?? "keep"}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === "custom");
          updatePreferences({ dismissAfterSeconds: value === "custom" ? 30 : value === "keep" ? null : Number(value) });
        }}
      >
        <option value={10}>10 秒</option>
        <option value={30}>30 秒</option>
        <option value={60}>1 分钟</option>
        <option value="keep">直到我收起</option>
        <option value="custom">自定义秒数</option>
      </select>
      {custom && <>
        <label htmlFor={`${id}-seconds`}>消退前等待（秒）</label>
        <input id={`${id}-seconds`} type="number" min={1} step={1} defaultValue={preferences.dismissAfterSeconds ?? 30}
          onChange={(event) => {
            const seconds = event.currentTarget.valueAsNumber;
            if (Number.isFinite(seconds) && seconds > 0) updatePreferences({ dismissAfterSeconds: seconds });
          }} />
      </>}
      <label htmlFor={`${id}-animation`}>提醒时的动作</label>
      <select
        id={`${id}-animation`}
        value={preferences.animation}
        onChange={(event) => updatePreferences({ animation: event.target.value as "once" | "loop" })}
      >
        <option value="once">演一次就停</option>
        <option value="loop">气泡显示时重复</option>
      </select>
      <label htmlFor={`${id}-expression`}>每次动作的时长</label>
      <select
        id={`${id}-expression`}
        value={preferences.expressionSeconds}
        onChange={(event) => updatePreferences({ expressionSeconds: Number(event.target.value) })}
      >
        <option value={4}>4 秒</option>
        <option value={8}>8 秒</option>
        <option value={15}>15 秒</option>
        <option value={30}>30 秒</option>
      </select>
      <p>鼠标停在气泡上或用键盘操作时，会暂停收起计时。动作结束后，气泡仍会保留。</p>
    </fieldset>
  );
}
