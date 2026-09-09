import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpDesktopRuntime } from "./HttpDesktopRuntime";
import { LocalJsonHttpClient, LocalRuntimeError } from "./localHttp";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("HttpDesktopRuntime 本机边界", () => {
  it("默认等待超过旧的 330 秒仍继续，只有显式等待预算才终止", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ runId: "long-run", status: "running" }));
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });
    const controller = new AbortController();
    let finished = false;
    const waiting = runtime.agent.waitForRun("long-run", { signal: controller.signal, pollIntervalMs: 60_000 })
      .finally(() => { finished = true; });
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(finished).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
    controller.abort();
    await rejected;
  });
  it("使用构建期公开 loopback 地址连接非默认本地服务端口", async () => {
    vi.stubEnv("VITE_LATITUDE_AGENT_URL", "http://127.0.0.1:51231");
    vi.stubEnv("VITE_LATITUDE_DOMAIN_URL", "http://localhost:51232");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      jsonResponse({ status: "ready", service: String(input) })
    );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.health();

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:51231/health",
      "http://localhost:51232/health",
    ]);
  });

  it("构建期公开地址不能把 Browser transport 指向其他外网来源", () => {
    vi.stubEnv("VITE_LATITUDE_AGENT_URL", "https://example.com");
    expect(() => new HttpDesktopRuntime()).toThrowError(LocalRuntimeError);
  });

  it("只允许当前页面同源的 HTTPS 部署路径并携带同源凭据", async () => {
    vi.stubGlobal("location", { origin: "https://latitude.baizhuo.online" });
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ready" }));
    const client = new LocalJsonHttpClient(
      "https://latitude.baizhuo.online/api/domain",
      { fetchImpl: fetchMock },
    );

    await client.json("/health");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://latitude.baizhuo.online/api/domain/health",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("拒绝任何非 loopback 地址，避免把认知上下文误发到外网", () => {
    expect(
      () => new HttpDesktopRuntime({ agentBaseUrl: "https://example.com" })
    ).toThrowError(LocalRuntimeError);
  });

  it("以 POST 读取 Domain context，并发送精确的领域查询契约", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ nodes: [], edges: [], generatedAt: "2026-08-24T12:00:00Z" })
    );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await expect(
      runtime.getContext({
        query: "长期方向",
        kinds: ["claim", "action"],
        includeRetracted: true,
        limit: 20
      })
    ).resolves.toMatchObject({ nodes: [], edges: [] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43121/v1/context");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "长期方向",
      kinds: ["claim", "action"],
      includeRetracted: true,
      limit: 20
    });
    expect(init.credentials).toBe("same-origin");
  });

  it("所有 Domain 写入携带幂等键，但从不发送 Authorization 或 API key", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ changeSetId: "cs-1", status: "applied" })
    );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.applyChange(
      {
        operation: "update",
        id: "claim-1",
        statement: "上午写作更稳定",
        audit: { actor: "model", authorizationMode: "automatic" }
      },
      { idempotencyKey: "fixed-change-key" }
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("http://127.0.0.1:43121/v1/changes");
    expect(headers["Idempotency-Key"]).toBe("fixed-change-key");
    expect(Object.keys(headers).join(" ")).not.toMatch(/authorization|api.?key/i);
    expect(JSON.parse(String(init.body))).toMatchObject({
      operation: "update",
      id: "claim-1",
      clientRequestId: "fixed-change-key"
    });
  });

  it("通过 Agent Host 读取并保存 Provider，而不是写入浏览器存储", async () => {
    const settings = {
      active: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      options: [{
        id: "deepseek-official",
        label: "DeepSeek",
        configured: true,
        credentialName: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      }],
      appliesTo: "next_turn" as const,
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      jsonResponse(init?.method === "POST"
        ? { ...settings, active: { provider: "openai", model: "gpt-5.4-mini" } }
        : settings)
    );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.agent.getProviderSettings();
    await runtime.agent.updateProviderSettings({
      provider: "openai",
      model: "gpt-5.4-mini",
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:43120/v1/agent/settings/provider",
      "http://127.0.0.1:43120/v1/agent/settings/provider",
    ]);
    const secondInit = fetchMock.mock.calls[1]?.[1];
    expect(secondInit?.method).toBe("POST");
    expect(JSON.parse(String(secondInit?.body))).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("把今天做过保存为带 activity 类型的用户证据，而不是普通聊天", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/v1/scheduler/wake")) return jsonResponse({ accepted: true });
      return jsonResponse({
        ok: true,
        changeSetId: "cs-activity",
        value: {
          sourceRecordId: "source-activity",
          evidenceRefId: "evidence-activity",
          nodeId: "node-activity",
          node: { id: "node-activity", kind: "evidence_event" },
        },
      });
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.recordActivity({
      content: "把第一版服务接回原来的纸面",
      occurredAt: "2026-09-01T15:20:00.000Z",
      sensitivity: "low",
      audit: { actor: "user", sessionId: "session-1", authorizationMode: "automatic" },
    }, { idempotencyKey: "activity-1" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43121/v1/evidence/message");
    expect(JSON.parse(String(init.body))).toEqual({
      clientRequestId: "activity-1",
      content: "把第一版服务接回原来的纸面",
      occurredAt: "2026-09-01T15:20:00.000Z",
      sensitivity: "low",
      evidenceType: "activity",
      audit: { actor: "user", sessionId: "session-1", authorizationMode: "automatic" },
    });
  });

  it("action → outcome → weekly review 使用同一套 flat camelCase 领域契约", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/scheduler/wake")) return jsonResponse({ ok: true });
      if (url.endsWith("/v1/actions")) {
        return jsonResponse({ ok: true, changeSetId: "cs-a", value: { id: "action-1" } });
      }
      if (url.endsWith("/v1/outcomes")) {
        return jsonResponse({ ok: true, changeSetId: "cs-o", value: { id: "outcome-1" } });
      }
      return jsonResponse({ ok: true, changeSetId: "cs-r", value: { dueActions: [] } });
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.createAction({
      label: "验证上午写作",
      trigger: "工作日早上九点坐到书桌前",
      expectedOutcome: "连续三天完成 500 字",
      observationWindow: { duration: "3 days", timezone: "America/Los_Angeles" },
      reviewAt: "2026-08-28T17:00:00-07:00",
      audit: { actor: "model", authorizationMode: "preauthorized" }
    });
    await runtime.recordOutcome({
      actionId: "action-1",
      outcome: "三天中有两天完成",
      effect: "refutes"
    });
    await runtime.createWeeklyReview({
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23"
    });

    const domainCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("http://127.0.0.1:43121")
    );
    expect(domainCalls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:43121/v1/actions",
      "http://127.0.0.1:43121/v1/outcomes",
      "http://127.0.0.1:43121/v1/reviews"
    ]);
    expect(JSON.parse(String(domainCalls[0]?.[1]?.body))).toMatchObject({
      label: "验证上午写作",
      trigger: "工作日早上九点坐到书桌前",
      expectedOutcome: "连续三天完成 500 字",
      observationWindow: { duration: "3 days", timezone: "America/Los_Angeles" },
      reviewAt: "2026-08-28T17:00:00-07:00"
    });
    expect(JSON.parse(String(domainCalls[1]?.[1]?.body))).toMatchObject({
      actionId: "action-1",
      outcome: "三天中有两天完成",
      effect: "refutes"
    });
    expect(JSON.parse(String(domainCalls[2]?.[1]?.body))).toMatchObject({
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23"
    });
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v1/scheduler/wake")),
    ).toHaveLength(3);
  });

  it("candidate create / command / due 使用独立 typed 路由且 due 保持只读", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/scheduler/wake")) return jsonResponse({ ok: true });
      if (url.includes("/v1/candidates/due?")) {
        return jsonResponse({
          ok: true,
          dueBefore: "2026-08-28T12:00:00.000Z",
          sensitivityCeiling: "low",
          items: [],
        });
      }
      return jsonResponse({
        ok: true,
        changeSetId: "candidate-change",
        value: {
          candidate: { id: "candidate-1", kind: "experiment" },
          receipt: {
            command: "touch",
            state: "touched",
            recordedAt: "2026-08-24T12:00:00Z",
            changeSetId: "candidate-change",
          },
        },
      });
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.createCandidate({
      label: "晨间共创候选",
      statement: "先看看什么值得继续",
      sourceNodeIds: ["claim-1"],
      audit: { actor: "user", authorizationMode: "automatic" },
    }, { idempotencyKey: "candidate-create-key" });
    await runtime.commandCandidate({
      candidateId: "candidate-1",
      command: "touch",
      audit: { actor: "user", authorizationMode: "automatic" },
    }, { idempotencyKey: "candidate-touch-key" });
    await runtime.listDueCandidates({
      at: "2026-08-28T12:00:00.000Z",
      limit: 10,
      sensitivityCeiling: "low",
    });

    const domainCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("http://127.0.0.1:43121"),
    );
    expect(domainCalls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:43121/v1/candidates",
      "http://127.0.0.1:43121/v1/candidates/candidate-1/commands",
      "http://127.0.0.1:43121/v1/candidates/due?at=2026-08-28T12%3A00%3A00.000Z&limit=10&sensitivityCeiling=low",
    ]);
    expect(JSON.parse(String(domainCalls[0]?.[1]?.body))).toMatchObject({
      clientRequestId: "candidate-create-key",
      label: "晨间共创候选",
      statement: "先看看什么值得继续",
      sourceNodeIds: ["claim-1"],
    });
    expect(JSON.parse(String(domainCalls[1]?.[1]?.body))).toEqual({
      command: "touch",
      audit: { actor: "user", authorizationMode: "automatic" },
      clientRequestId: "candidate-touch-key",
    });
    expect(domainCalls[2]?.[1]?.method).toBe("GET");
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v1/scheduler/wake")),
    ).toHaveLength(2);
  });

  it("Domain 写入成功后即使 scheduler wake 失败也不回滚、不重放事实", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/scheduler/wake")) throw new TypeError("agent offline");
      return jsonResponse({ ok: true, changeSetId: "cs-domain-committed", value: null });
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await expect(runtime.applyChange({
      operation: "remember",
      label: "一条已提交的事实",
      audit: { actor: "user", authorizationMode: "automatic" },
    })).resolves.toMatchObject({ changeSetId: "cs-domain-committed" });

    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v1/changes")),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v1/scheduler/wake")),
    ).toHaveLength(1);
  });

  it("两阶段数据操作只在 commit 成功后唤醒 scheduler", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/scheduler/wake")) return jsonResponse({ accepted: true }, 202);
      if (url.endsWith("/v1/admin/dangerous/prepare")) {
        return jsonResponse({
          ok: true,
          operation: "delete_all",
          token: "delete-token",
          expiresAt: "2026-08-24T12:05:00Z",
          requiredConfirmation: "DELETE ALL LOCAL DATA",
        }, 202);
      }
      return jsonResponse({ ok: true, operation: "delete_all", status: "complete" });
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await runtime.prepareDangerousData({ operation: "delete_all" });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/v1/scheduler/wake")))
      .toBe(false);
    await runtime.commitDangerousData({
      token: "delete-token",
      confirmation: "DELETE ALL LOCAL DATA",
    });
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v1/scheduler/wake")),
    ).toHaveLength(1);
  });

  it("提交 Agent 任务后轮询到终态，不把浏览器连接当成任务生命周期", async () => {
    const statuses: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ runId: "run-1", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ runId: "run-1", status: "running" }))
      .mockResolvedValueOnce(
        jsonResponse({
          runId: "run-1",
          status: "completed",
          result: {
            runId: "run-1",
            sessionId: "session-1",
            status: "completed",
            assistantText: "已记录。",
            stepsUsed: 1,
            toolCallsUsed: 1,
            startedAt: "2026-08-24T12:00:00Z",
            finishedAt: "2026-08-24T12:00:01Z"
          }
        })
      );
    const runtime = new HttpDesktopRuntime({
      fetchImpl: fetchMock,
      pollIntervalMs: 1,
      retryBaseMs: 1
    });

    const result = await runtime.runAgentTurn(
      { sessionId: "session-1", text: "记住我更喜欢上午写作" },
      { pollIntervalMs: 1, onStatus: (run) => statuses.push(run.status) }
    );

    expect(result).toMatchObject({
      status: "completed",
      result: { assistantText: "已记录。" }
    });
    expect(statuses).toEqual(["running", "completed"]);
    const startInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = startInit.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^turn_/);
    expect(JSON.parse(String(startInit.body))).not.toHaveProperty("apiKey");
  });

  it("读取并回执 durable scheduler outbox，使秘书推送有可恢复交付边界", async () => {
    const item = {
      receiptKey: "outcome:action-1:window-1",
      runId: "scheduled-run-1",
      kind: "outcome_collection",
      domainId: "action-1",
      dueAt: "2026-08-24T12:00:00Z",
      text: "现实里发生了什么？",
      deliveryStatus: "pending",
      createdAt: "2026-08-24T12:00:01Z"
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [item] }))
      .mockResolvedValueOnce(
        jsonResponse({ ...item, deliveryStatus: "acknowledged" })
      );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await expect(runtime.agent.listSchedulerOutbox()).resolves.toEqual({ items: [item] });
    await expect(
      runtime.agent.acknowledgeSchedulerOutbox(item.receiptKey, {
        idempotencyKey: "delivery-ack-1"
      })
    ).resolves.toMatchObject({ deliveryStatus: "acknowledged" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43120/v1/scheduler/outbox"
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:43120/v1/scheduler/outbox/outcome%3Aaction-1%3Awindow-1/ack"
    );
    const ackInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(ackInit.method).toBe("POST");
    expect((ackInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "delivery-ack-1"
    );
  });

  it("通过 typed Agent admin 边界导出、检查并两阶段永久删除，不把服务令牌发给 Domain", async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      exportedAt: "2026-08-24T12:00:00Z",
      checksum: "a".repeat(64),
      files: { "jobs.jsonl": "" }
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, checksum: snapshot.checksum, fileCount: 1, issues: [] })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "agent-purge-token",
          operation: "purge_all",
          confirmationPhrase: "PERMANENTLY DELETE ALL LATITUDE DATA",
          expiresAt: "2026-08-24T12:05:00Z"
        }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          operation: "purge_all",
          checksum: "b".repeat(64),
          restartRequired: true
        })
      );
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await expect(runtime.agent.exportState()).resolves.toEqual(snapshot);
    await expect(runtime.agent.checkIntegrity()).resolves.toMatchObject({ ok: true });
    const prepared = await runtime.agent.prepareDangerousData({ operation: "purge_all" });
    await expect(
      runtime.agent.commitDangerousData({
        token: prepared.token,
        confirmation: prepared.confirmationPhrase
      })
    ).resolves.toMatchObject({ operation: "purge_all", restartRequired: true });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:43120/v1/agent/admin/export",
      "http://127.0.0.1:43120/v1/agent/admin/integrity",
      "http://127.0.0.1:43120/v1/agent/admin/dangerous/prepare",
      "http://127.0.0.1:43120/v1/agent/admin/dangerous/commit"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      operation: "purge_all"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      token: "agent-purge-token",
      confirmation: "PERMANENTLY DELETE ALL LATITUDE DATA"
    });
  });

  it("keeps Agent purge partial, recoverable and preserved-entry fields in the typed receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      ok: true,
      operation: "purge_all",
      status: "partial",
      checksum: "c".repeat(64),
      recoverable: true,
      preservedEntries: ["state/unowned-file"],
      backupCleanup: {
        removedEntries: ["owner.json"],
        preservedEntries: ["manual-copy"],
      },
      restartRequired: true,
    }));
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    await expect(runtime.agent.commitDangerousData({
      token: "agent-purge-token",
      confirmation: "PERMANENTLY DELETE ALL LATITUDE DATA",
    })).resolves.toMatchObject({
      status: "partial",
      recoverable: true,
      preservedEntries: ["state/unowned-file"],
      backupCleanup: { preservedEntries: ["manual-copy"] },
    });
  });

  it("GET 断线会自动重试，外部 Abort 会立即停止轮询", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ runId: "run-2", status: "running" }));
    const runtime = new HttpDesktopRuntime({
      fetchImpl: fetchMock,
      retries: 1,
      retryBaseMs: 1
    });

    await expect(runtime.agent.getRun("run-2")).resolves.toMatchObject({
      status: "running"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const abortFetch = vi.fn(async () =>
      jsonResponse({ runId: "run-3", status: "running" })
    );
    const abortRuntime = new HttpDesktopRuntime({ fetchImpl: abortFetch });
    const controller = new AbortController();
    const waiting = abortRuntime.agent.waitForRun("run-3", {
      signal: controller.signal,
      pollIntervalMs: 60_000,
      onStatus: () => controller.abort()
    });

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(abortFetch).toHaveBeenCalledTimes(1);
  });

  it("单次请求超时可观察，且不在错误信息中回显请求正文", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
    );
    const client = new LocalJsonHttpClient("http://127.0.0.1:43120", {
      fetchImpl: fetchMock,
      timeoutMs: 5,
      retries: 0
    });

    const request = client.json("/health");
    const assertion = expect(request).rejects.toMatchObject({
      code: "timeout",
      retryable: true
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("健康检查并发读取两项服务，并过滤返回中的敏感诊断字段", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const port = new URL(String(input)).port;
      return jsonResponse(
        port === "43120"
          ? { ok: true, version: "0.1.0", apiKeyConfigured: true }
          : { status: "ready", schemaVersion: "2" }
      );
    });
    const runtime = new HttpDesktopRuntime({ fetchImpl: fetchMock });

    const health = await runtime.health();
    expect(health.state).toBe("ready");
    expect(health.agent.details).toMatchObject({ apiKeyConfigured: true });
    expect(health.domain.details).toMatchObject({ schemaVersion: "2" });
  });
});
