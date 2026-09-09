import { useEffect, useState } from "react";
import type { AgentClient, PersonaChange, PersonaState } from "../../runtime/host/agentClient";

export function PersonaSettings({ agent }: { agent: AgentClient }) {
  const [state, setState] = useState<PersonaState | null>(null);
  const [persona, setPersona] = useState("");
  const [preferences, setPreferences] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function accept(next: PersonaState) {
    setState(next); setPersona(next.current.persona); setPreferences(next.current.preferences);
  }
  useEffect(() => {
    let active = true;
    agent.getPersona().then((next) => { if (active) accept(next); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [agent]);
  async function save(change: Omit<PersonaChange, "baseVersion">) {
    if (!state) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      accept(await agent.updatePersona({ ...change, baseVersion: state.current.version }));
      setNotice("已保存，后续对话会使用这份人设。");
    } catch (err) { setError(err instanceof Error ? err.message : "人设没有保存"); }
    finally { setBusy(false); }
  }
  return <details className="dim-persona-settings dim-paper">
    <summary>人设与相处方式</summary>
    <p className="dim-meta">可以直接修改，也可以在对话中告诉秘书。每次调整都有记录，随时能恢复。</p>
    {!state && !error && <p role="status">正在读取人设…</p>}
    {state && <>
      <label>当前人设<textarea aria-label="当前人设" rows={10} value={persona} onChange={(event) => setPersona(event.target.value)} disabled={busy} /></label>
      <label>你的补充<textarea aria-label="人设补充" rows={3} value={preferences} onChange={(event) => setPreferences(event.target.value)} disabled={busy} placeholder="称呼、语气、主动程度、做事习惯…" /></label>
      <div className="dim-persona-settings__actions">
        <button className="dim-btn" disabled={busy || !persona.trim() || (persona === state.current.persona && preferences === state.current.preferences)} onClick={() => void save({ persona, preferences, reason: "用户在设置中修改人设与偏好" })}>保存人设</button>
        <button className="dim-btn dim-btn--quiet" disabled={busy} onClick={() => void save({ restoreVersion: 0, reason: "用户恢复默认人设" })}>恢复默认</button>
      </div>
      <details><summary>调整记录（{state.history.length - 1} 次）</summary>
        <ol>{[...state.history].reverse().map((version) => <li key={version.version}>
          <p>{version.reason} · {version.actor === "model" ? "秘书调整" : version.actor === "user" ? "你调整的" : "默认版本"}</p>
          <details><summary>查看这份人设</summary><p style={{ whiteSpace: "pre-wrap" }}>{version.persona}{"\n"}{version.preferences}</p></details>
          {version.version !== state.current.version && <button className="dim-btn dim-btn--quiet" disabled={busy} onClick={() => void save({ restoreVersion: version.version, reason: "用户恢复之前的人设" })}>恢复这一版</button>}
        </li>)}</ol>
      </details>
    </>}
    {error && <p role="alert">{error} <button className="dim-btn dim-btn--quiet" onClick={() => void agent.getPersona().then((next) => { accept(next); setError(null); }).catch((err) => setError(err.message))}>重新读取</button></p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
