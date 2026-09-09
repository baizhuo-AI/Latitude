import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminalAgentRun, type AgentClient, type AgentRunResult, type AgentProgressItem } from "./agentClient";
import { abortableDelay, LocalRuntimeError } from "./localHttp";

/** Merge transport chunks for display; the Host remains the source of run state. */
export function mergeProgress(previous: AgentProgressItem[], incoming: AgentProgressItem[]) {
  const next = [...previous];
  for (const item of incoming) {
    const last = next[next.length - 1];
    if (item.kind === "reasoning" && last?.kind === "reasoning") {
      next[next.length - 1] = { ...last, text: last.text + item.text };
    } else if (item.kind === "tool" && item.callId) {
      const index = next.findIndex((entry) => entry.callId === item.callId);
      if (index < 0) next.push(item); else next[index] = { ...item, seq: next[index].seq };
    } else next.push(item);
  }
  return next;
}

export function useAgentRun(
  agent: AgentClient, sessionId: string, enabled: boolean,
  onFinished: (run: AgentRunResult, recovered: boolean) => Promise<void>,
) {
  const [tracked, setTracked] = useState<{ id: string; recovered: boolean } | null>(null);
  const [progress, setProgress] = useState<AgentProgressItem[]>([]);
  const [progressRunId, setProgressRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const finishRef = useRef(onFinished);
  const selection = useRef(0);
  finishRef.current = onFinished;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const selected = ++selection.current;
    setProgress([]);
    setProgressRunId(null);
    setConnectionError(null);
    void (async () => {
      try {
        const { run } = await agent.getLatestRun(sessionId, { signal: controller.signal });
        if (controller.signal.aborted || selected !== selection.current || !run) return;
        if (!isTerminalAgentRun(run.status)) {
          setTracked((current) => current ?? { id: run.runId, recovered: true });
        } else {
          let after = -1;
          let items: AgentProgressItem[] = [];
          let page;
          do {
            page = await agent.getProgress(run.runId, after, { signal: controller.signal });
            items = mergeProgress(items, page.items);
            after = page.next;
          } while (page.hasMore);
          if (!controller.signal.aborted && selected === selection.current) {
            setProgressRunId(run.runId);
            setProgress(items);
            await finishRef.current(run, true);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : "运行记录暂时读不到");
      }
    })();
    return () => controller.abort();
  }, [agent, sessionId, enabled, recoveryAttempt]);

  useEffect(() => {
    if (!tracked) return;
    const controller = new AbortController();
    const { signal } = controller;
    setProgressRunId(tracked.id);
    setProgress([]);
    setConnectionError(null);
    let after = -1;
    let completed = false;
    const readProgress = async () => {
      let page;
      do {
        page = await agent.getProgress(tracked.id, after, { signal });
        after = page.next;
        if (!signal.aborted) {
          const received = page.items;
          setProgress((items) => mergeProgress(items, received));
          if (page.phase === "presenting") setStatus("正在整理答复…");
        }
      } while (page.hasMore && !signal.aborted);
    };
    const progressLoop = (async () => {
      while (!signal.aborted && !completed) {
        try { await readProgress(); }
        catch (error) {
          if (!signal.aborted) setConnectionError(error instanceof Error ? error.message : "过程暂时读不到");
        }
        if (!signal.aborted && !completed) await abortableDelay(500, signal);
      }
    })().catch((error) => { if (!signal.aborted) throw error; });

    void (async () => {
      try {
        let finished: AgentRunResult;
        while (true) {
          try {
            finished = await agent.waitForRun(tracked.id, {
              signal, pollIntervalMs: 500,
              onStatus: (run) => {
                setConnectionError(null);
                if (run.status === "queued") setStatus("等待开始…");
                else setStatus((current) => current === "正在整理答复…" ? current : "正在处理…");
              },
            });
            break;
          } catch (error) {
            if (signal.aborted) return;
            setConnectionError(error instanceof Error ? error.message : "连接中断，任务可能仍在后台运行");
            if (!(error instanceof LocalRuntimeError) || !error.retryable) return;
            await abortableDelay(1000, signal);
          }
        }
        completed = true;
        await progressLoop;
        try { await readProgress(); }
        catch (error) { if (!signal.aborted) setConnectionError(error instanceof Error ? error.message : "过程读取失败"); }
        if (signal.aborted) return;
        setTracked(null);
        setStatus(null);
        await finishRef.current(finished, tracked.recovered);
      } catch (error) {
        if (!signal.aborted) setConnectionError(error instanceof Error ? error.message : "读取任务结果失败");
      }
    })();
    return () => { completed = true; controller.abort(); };
  }, [agent, tracked]);

  const follow = useCallback((id: string) => {
    ++selection.current;
    setStatus("正在处理…");
    setTracked({ id, recovered: false });
  }, []);
  return {
    activeRunId: tracked?.id ?? null, progressRunId, progress, status, connectionError,
    follow,
    reconnect: () => {
      if (tracked) setTracked({ ...tracked });
      else setRecoveryAttempt((attempt) => attempt + 1);
    },
  };
}
