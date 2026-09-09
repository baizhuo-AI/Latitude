import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentClient } from "../../runtime/host/agentClient";
import type { DesktopContent, DesktopTodoUpdate } from "../../shared/desktopContent";

export interface DesktopContentState {
  data?: DesktopContent;
  status: "starting" | "ready" | "unavailable";
  error?: string;
}
export function useDesktopContent(client: AgentClient["desktop"], refreshKey?: string | null) {
  const [state, setState] = useState<DesktopContentState>({ status: "starting" });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!client) return;
    const request = ++sequence.current;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    try {
      const data = await client.read(date, { retries: 1 });
      if (request === sequence.current) setState({ data, status: "ready" });
    } catch {
      if (request === sequence.current) setState(old => ({ ...old, status: "unavailable", error: "便签记录暂时没读出来，已保存的内容不会因此清空。" }));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { sequence.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, refreshKey]);
  const updateTodo = useCallback(async (id: string, changes: Pick<DesktopTodoUpdate, "title" | "status">) => {
    const record = state.data?.todos.find(todo => todo.id === id);
    if (!client || !record) throw new Error("请先刷新待办，再重试。");
    try { await client.updateTodo({ id, expectedUpdatedAt: record.updatedAt, ...changes }); }
    finally { await refresh(); }
  }, [client, refresh, state.data]);
  return { state: client ? state : undefined, refresh, updateTodo };
}
