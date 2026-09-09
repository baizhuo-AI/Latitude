import { describe, expect, it } from "vitest";
import { buildBrowserProjection } from "./browserProjection";

describe("buildBrowserProjection", () => {
  it("把今天的 activity 证据投进原纸面，并让记录能力与助手能力分别降级", () => {
    const result = buildBrowserProjection({
      runtimeState: "unavailable",
      domainState: "ready",
      agentState: "unavailable",
      now: new Date("2026-09-01T16:00:00Z"),
      context: {
        nodes: [
          {
            id: "activity-today",
            kind: "evidence_event",
            statement: "把第一版服务接回原来的纸面",
            status: "active",
            payload: {
              evidenceType: "activity",
              occurredAt: "2026-09-01T15:20:00Z",
              authorship: "user",
            },
          },
          {
            id: "ordinary-message",
            kind: "evidence_event",
            statement: "这只是普通聊天",
            payload: { evidenceType: "message", occurredAt: "2026-09-01T15:30:00Z" },
          },
          {
            id: "activity-yesterday",
            kind: "evidence_event",
            statement: "昨天的记录",
            payload: { evidenceType: "activity", occurredAt: "2026-08-30T15:30:00Z" },
          },
        ],
        edges: [],
      },
    });

    const activity = result.projection.bindings["desktop.activity"];
    if (!activity || activity.kind !== "activity") throw new Error("activity projection missing");
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]).toMatchObject({
      id: "activity-today",
      text: "把第一版服务接回原来的纸面",
      lineage: { entityId: "activity-today" },
    });
    expect(activity.canCapture).toBe(true);
    expect(activity.canReflect).toBe(false);
    expect(result.projection.secretary).toMatchObject({
      state: "ready",
      gesture: "idle",
      stateCn: "未连接",
      headline: "秘书暂时没连上。",
    });
    expect(result.layout.cards.find((card) => card.id === "seed-activity")).toMatchObject({
      kind: "activity",
      binding: "desktop.activity",
      presentation: { title: "今天做过" },
    });
    expect(result.layout.cards.find((card) => card.id === "seed-schedule")).toMatchObject({
      kind: "anchors",
      binding: "desktop.schedule",
    });
  });

  it("distinguishes connecting and unavailable services from a real empty desktop without claiming work", () => {
    const starting = buildBrowserProjection({
      runtimeState: "starting",
      domainState: "starting",
      agentState: "starting",
      now: new Date("2026-09-01T16:00:00Z"),
      context: { nodes: [], edges: [] },
    });
    expect(starting.projection.secretary).toMatchObject({
      state: "ready",
      gesture: "idle",
      stateCn: "正在连接",
      headline: "秘书正在连接。",
    });
    expect(starting.projection.secretary.headline).not.toMatch(/稍等|处理|思考/);

    const unavailable = buildBrowserProjection({
      runtimeState: "unavailable",
      now: new Date("2026-09-01T16:00:00Z"),
      context: { nodes: [], edges: [] },
    });
    expect(unavailable.projection.secretary).toMatchObject({
      state: "ready",
      gesture: "idle",
      stateCn: "未连接",
      headline: "秘书暂时没连上。",
    });
    expect(unavailable.projection.bindings["desktop.feed"]).toMatchObject({
      items: [],
      emptyHint: "暂时看不到已保存的资讯。",
    });
    expect(unavailable.projection.bindings["desktop.schedule"]).toMatchObject({
      rows: [],
      emptyHint: "暂时看不到行动记录。",
    });
    expect(unavailable.projection.bindings["desktop.rhythm"]).toEqual({
      kind: "chart",
      bars: [],
      emptyHint: "暂时看不到行动的回看安排。",
    });

    const readyWithoutReviewSchedule = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-09-01T16:00:00Z"),
      context: {
        nodes: [{ id: "unscheduled-action", kind: "action", label: "还没约回看时间", status: "active" }],
        edges: [],
      },
    });
    expect(readyWithoutReviewSchedule.projection.bindings["desktop.rhythm"]).toEqual({
      kind: "chart",
      bars: [],
      emptyHint: "还没有安排需要回看的行动。",
    });
    expect(readyWithoutReviewSchedule.projection.bindings["desktop.feed"]).toMatchObject({
      emptyHint: "维度AI还没有找到值得主动递给你的新资讯。",
    });
  });

  it("routes north star, medium themes, short desktop goals and constellation claims by typed Domain payload", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "goal-north",
            kind: "goal",
            label: "实现 AGI",
            statement: "北极星目标是实现 AGI。",
            authority: "user_stated",
            payload: { horizon: "north-star", surfaceRole: "constellation.north-star" },
          },
          {
            id: "goal-medium",
            kind: "goal",
            label: "完成客户交付",
            authority: "user_stated",
            payload: {
              horizon: "medium-term",
              surfaceRole: "clue.theme",
              parentGoalId: "goal-north",
            },
          },
          {
            id: "goal-short",
            kind: "goal",
            label: "研究 DSH",
            authority: "user_stated",
            payload: {
              horizon: "short-term",
              surfaceRole: "desktop.goal",
              parentGoalId: "goal-medium",
              mediumGoalId: "goal-medium",
            },
          },
          {
            id: "claim-cognition",
            kind: "claim",
            label: "证据优先",
            authority: "imported_unverified",
            payload: { horizon: "cognition", surfaceRole: "constellation.cognition" },
          },
          {
            id: "claim-big-idea",
            kind: "claim",
            label: "让知识与行动使用同一份事实",
            authority: "imported_unverified",
            payload: { horizon: "big-idea", surfaceRole: "constellation.big-idea" },
          },
          {
            id: "action-short",
            kind: "action",
            label: "拆 DSH runtime",
            payload: {
              surfaceRole: "desktop.action",
              goalId: "goal-short",
              mediumGoalId: "goal-medium",
            },
          },
          {
            id: "action-medium",
            kind: "action",
            label: "准备客户交付一页纸",
            payload: {
              surfaceRole: "clue.action",
              goalId: "goal-medium",
              mediumGoalId: "goal-medium",
            },
          },
          {
            id: "resource-medium",
            kind: "resource",
            label: "客户交付脱敏样本",
            payload: { mediumGoalId: "goal-medium" },
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "实现 AGI",
      status: "single",
      lineage: { entityId: "goal-north" },
    });
    expect(result.projection.constellation?.cognitions.map((node) => [node.label, node.role])).toEqual([
      ["让知识与行动使用同一份事实", "big-idea"],
      ["证据优先", "cognition"],
    ]);
    expect(result.projection.clueBoard?.themes).toHaveLength(1);
    expect(result.projection.clueBoard?.themes[0]).toMatchObject({
      title: "完成客户交付",
      lineage: { entityId: "goal-medium" },
    });
    expect(result.projection.clueBoard?.themes[0].rows.map((row) => row.text)).toEqual([
      "拆 DSH runtime",
      "准备客户交付一页纸",
      "客户交付脱敏样本",
    ]);
    const schedule = result.projection.bindings["desktop.schedule"];
    if (!schedule || schedule.kind !== "anchors") throw new Error("schedule projection missing");
    expect(schedule.rows.map((row) => row.text)).toEqual(["研究 DSH", "拆 DSH runtime"]);
  });

  it("keeps legacy Host actions recoverable on the desktop while excluding explicit clue actions", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          { id: "action-legacy", kind: "action", label: "旧 Host 行动", status: "active" },
          {
            id: "action-clue",
            kind: "action",
            label: "中期线索行动",
            status: "active",
            payload: {
              surfaceRole: "clue.action",
              mediumGoalId: "goal-medium",
              goalId: "goal-medium",
            },
          },
        ],
        edges: [],
      },
    });

    const schedule = result.projection.bindings["desktop.schedule"];
    if (!schedule || schedule.kind !== "anchors") throw new Error("schedule projection missing");
    expect(schedule.rows.map((row) => row.text)).toEqual(["旧 Host 行动"]);
  });

  it("does not choose between two explicitly designated north stars", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          { id: "goal-a", kind: "goal", label: "方向 A", authority: "user_stated", payload: { horizon: "north-star", surfaceRole: "constellation.north-star" } },
          { id: "goal-b", kind: "goal", label: "方向 B", authority: "user_confirmed", payload: { horizon: "north-star", surfaceRole: "constellation.north-star" } },
          { id: "goal-short", kind: "goal", label: "阶段目标", authority: "user_stated", payload: { horizon: "short-term", surfaceRole: "desktop.goal" } },
        ],
        edges: [],
      },
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "2 个并行的长期方向",
      detail: "方向 A、方向 B",
      status: "multiple",
    });
  });

  it("fails closed when an imported or inferred goal claims the north-star surface", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "goal-imported",
            kind: "goal",
            label: "导入系统替你定的方向",
            authority: "imported_unverified",
            payload: { horizon: "north-star", surfaceRole: "constellation.north-star" },
          },
          {
            id: "goal-inferred",
            kind: "goal",
            label: "模型猜的方向",
            authority: "system_inferred",
            origin: "user",
            payload: { horizon: "north-star", surfaceRole: "constellation.north-star" },
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "还没有明确的长期方向",
      status: "empty",
    });
    expect(result.projection.constellation?.northStar.lineage).toBeUndefined();
  });

  it("projects the real evidence-action-outcome loop without demo claims", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now,
      context: {
        nodes: [
          {
            id: "goal-short-writing",
            kind: "goal",
            label: "把写作实验做完整",
            authority: "user_stated",
            payload: { horizon: "short-term", surfaceRole: "desktop.goal" },
          },
          {
            id: "claim-1",
            kind: "claim",
            label: "上午写作更稳定",
            statement: "最近三次上午写作都更快进入状态",
            authority: "system_inferred",
            payload: { horizon: "cognition", surfaceRole: "constellation.cognition" },
          },
          {
            id: "event-proposed",
            kind: "evidence_event",
            label: "只有语义相似的事件",
          },
          {
            id: "action-1",
            kind: "action",
            label: "上午九点写 25 分钟",
            expectedOutcome: "完成一段草稿",
            reviewAt: "2026-08-24T10:00:00Z",
            status: "active",
            authority: "system_inferred",
            payload: { surfaceRole: "desktop.action", goalId: "goal-short-writing" },
          },
          {
            id: "outcome-1",
            kind: "outcome",
            label: "写出了两段",
            statement: "25 分钟完成两段草稿",
            authority: "system_recorded",
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.runtimeStatus).toBe("ready");
    expect(result.projection.secretary.headline).toContain("1 个行动该看结果了");
    expect(result.projection.secretary.metrics).toMatchObject([
      { label: "熟悉", value: 0, stage: "尚未形成" },
      { label: "默契", value: 0, stage: "尚未形成" },
      { label: "权能", value: 0, stage: "未授权" },
    ]);
    expect(result.projection.constellation?.cognitions[0]).toMatchObject({
      label: "上午写作更稳定",
      epistemic: "inferred",
    });
    expect(result.projection.bindings["desktop.schedule"]).toMatchObject({
      kind: "anchors",
      rows: [
        { text: "把写作实验做完整", meta: "短期目标 · 进行中" },
        { text: "上午九点写 25 分钟", meta: "结果待回收" },
      ],
    });
    expect(result.projection.bindings["desktop.rhythm"]).toMatchObject({
      kind: "chart",
      bars: [1, 0, 0, 0, 0, 0, 0, 0],
      link: "看看该看结果的行动",
    });
    expect(
      result.layout.cards.find((card) => card.binding === "desktop.rhythm")?.presentation?.title,
    ).toBe("这些行动该看结果了");
  });

  it("reads familiarity and rapport from a typed relationship node but keeps unreceipted capability at zero", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "relationship-demo",
            kind: "insight",
            label: "秘书关系状态",
            authority: "imported_unverified",
            payload: {
              surfaceRole: "secretary.relationship",
              relationshipSchemaVersion: 1,
              metrics: {
                familiarity: {
                  value: 46,
                  stage: "初步熟悉",
                  basis: "已整理目标层级，尚未经过长期互动校准。",
                  epistemicAuthority: "imported_unverified",
                  correctable: true,
                },
                rapport: {
                  value: 32,
                  stage: "正在建立",
                  basis: "已能复述部分偏好，尚无真实行动闭环。",
                  epistemicAuthority: "imported_unverified",
                  correctable: true,
                },
                capability: {
                  value: 88,
                  stage: "白名单自动",
                  basis: "本演示没有授权凭据。",
                  epistemicAuthority: "system_recorded",
                  grantState: "granted",
                  grantReceiptIds: [],
                },
              },
            },
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.secretary.stageLabel).toBe("已连接");
    expect(result.projection.secretary.metrics).toMatchObject([
      {
        label: "熟悉",
        value: 46,
        stage: "初步熟悉",
        correctable: true,
        lineage: [{ entityId: "relationship-demo" }],
      },
      {
        label: "默契",
        value: 32,
        stage: "正在建立",
        correctable: true,
        lineage: [{ entityId: "relationship-demo" }],
      },
      {
        label: "权能",
        value: 0,
        stage: "未授权",
        correctable: false,
      },
    ]);
  });

  it("rejects familiarity and rapport scalars that do not carry a correction contract", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [{
          id: "relationship-not-correctable",
          kind: "insight",
          authority: "system_inferred",
          payload: {
            surfaceRole: "secretary.relationship",
            relationshipSchemaVersion: 1,
            metrics: {
              familiarity: {
                value: 100,
                stage: "完全了解",
                basis: "模型自行声称已经了解用户。",
                correctable: false,
              },
              rapport: {
                value: 99,
                stage: "完全默契",
                basis: "只有描述，没有纠正契约。",
              },
              capability: { value: 100, grantState: "granted", grantReceiptIds: [] },
            },
          },
        }],
        edges: [],
      },
    });

    expect(result.projection.secretary.metrics).toMatchObject([
      { label: "熟悉", value: 0, stage: "尚未形成", correctable: false },
      { label: "默契", value: 0, stage: "尚未形成", correctable: false },
      { label: "权能", value: 0, stage: "未授权" },
    ]);
  });

  it("raises capability only from a referenced active explicit grant and drops it after revocation", () => {
    const relationship = {
      id: "relationship-real",
      kind: "insight",
      label: "秘书关系状态",
      authority: "system_recorded",
      payload: {
        surfaceRole: "secretary.relationship",
        relationshipSchemaVersion: 1,
        metrics: {
          familiarity: { value: 0, basis: "尚未形成。" },
          rapport: { value: 0, basis: "尚未形成。" },
          capability: {
            value: 88,
            stage: "白名单自动",
            basis: "用户明确授予了受限能力。",
            grantState: "granted",
            grantReceiptIds: ["grant-1"],
          },
        },
      },
    };
    const grant = {
      id: "grant-1",
      kind: "insight",
      label: "秘书能力授权",
      authority: "user_confirmed",
      status: "active",
      payload: {
        surfaceRole: "secretary.capability-grant",
        authorizationMode: "explicit",
        grantState: "granted",
        capabilityValue: 64,
        stage: "白名单自动",
        expiresAt: "2026-09-01T00:00:00Z",
      },
    };
    const project = (status: string, authority = grant.authority) => buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: { nodes: [relationship, { ...grant, status, authority }], edges: [] },
    }).projection.secretary.metrics.find((metric) => metric.label === "权能");

    expect(project("active")).toMatchObject({
      value: 64,
      stage: "白名单自动",
      lineage: [
        { entityId: "relationship-real" },
        { entityId: "grant-1", label: "当前采用的授权记录" },
      ],
    });
    expect(project("revoked")).toMatchObject({ value: 0, stage: "未授权" });
    expect(project("active", "system_inferred")).toMatchObject({ value: 0, stage: "未授权" });

    const noValue = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          relationship,
          { ...grant, payload: { ...grant.payload, capabilityValue: undefined } },
        ],
        edges: [],
      },
    }).projection.secretary.metrics.find((metric) => metric.label === "权能");
    expect(noValue).toMatchObject({
      value: 0,
      stage: "未授权",
      basis: "当前没有可用的授权记录。",
    });
  });

  it("labels sanitized imported claims as unverified imports rather than AI guesses", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [{
          id: "claim-imported",
          kind: "claim",
          label: "业务结果优先",
          statement: "先验证一个业务结果。",
          authority: "imported_unverified",
          payload: { horizon: "cognition", surfaceRole: "constellation.cognition" },
        }],
        edges: [],
      },
    });

    expect(result.projection.constellation?.cognitions[0]?.detail).toBe(
      "脱敏导入，待核验：先验证一个业务结果。",
    );
  });

  it("admits only source-linked deduplicated web results and marks stale evidence", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: { nodes: [], edges: [] },
      searchReason: "因为你正在验证早晨写作是否更稳定",
      webResults: [
        {
          title: "Older primary study",
          url: "https://example.test/study",
          whyNow: "这是一条在搜索当时保存的排序理由。",
          publishedAt: "2020-01-01",
          retrievedAt: "2026-08-24T12:00:00Z",
          evidenceNodeId: "ev-1",
        },
        { title: "duplicate", url: "https://example.test/study" },
        { title: "no URL", url: "" },
      ],
    });
    const feed = result.projection.bindings["desktop.feed"];
    expect(feed).toMatchObject({
      kind: "feed",
      items: [
        {
          title: "Older primary study",
          freshness: "stale",
          why: "这是一条在搜索当时保存的排序理由。",
          lineage: { entityId: "ev-1" },
        },
      ],
    });
  });

  it("rebuilds the feed from durable web resources after browser state is gone", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "resource-web-1",
            kind: "resource",
            label: "Durable source",
            statement: "A source-backed result that survived restart.",
            authority: "imported_unverified",
            payload: {
              query: "morning writing evidence",
              whyNow: "它在 8 月 24 日的低敏策展里排在第一位。",
              url: "https://example.test/durable",
              title: "Durable source",
              snippet: "A source-backed result that survived restart.",
              publishedAt: "2026-08-20T08:00:00Z",
              retrievedAt: "2026-08-24T11:30:00Z",
              provider: "deepseek-official",
              contentHash: "hash-durable",
              evidenceRefId: "evidence-ref-durable",
              untrustedContent: true,
              promptAuthority: "none",
            },
          },
        ],
        edges: [],
      },
      // The immediate response may coexist for one render; it must not duplicate
      // the already persisted source.
      webResults: [
        {
          title: "Immediate duplicate",
          url: "https://example.test/durable",
          retrievedAt: "2026-08-24T11:30:00Z",
          provider: "deepseek-official",
          contentHash: "hash-durable",
          evidenceNodeId: "resource-web-1",
        },
      ],
    });

    const feed = result.projection.bindings["desktop.feed"];
    if (!feed || feed.kind !== "feed") throw new Error("feed projection missing");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      url: "https://example.test/durable",
      provider: "deepseek-official",
      retrievedAt: "2026-08-24T11:30:00Z",
      contentHash: "hash-durable",
      evidenceRefId: "evidence-ref-durable",
      why: "它在 8 月 24 日的低敏策展里排在第一位。",
      lineage: { entityType: "resource", entityId: "resource-web-1" },
    });
  });

  it("keeps the latest curated morning brief stable when an unrelated search is newer", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "resource-search-optical",
            kind: "resource",
            label: "Unrelated optical result",
            createdAt: "2026-08-25T11:00:00Z",
            payload: {
              query: "optical",
              whyNow: "An unrelated ad-hoc search.",
              url: "https://example.test/optical",
              title: "Unrelated optical result",
              retrievedAt: "2026-08-25T11:00:00Z",
              contentHash: "hash-optical",
              untrustedContent: true,
              promptAuthority: "none",
            },
          },
          {
            id: "resource-daily-brief",
            kind: "resource",
            label: "今日早报：2026-08-25",
            createdAt: "2026-08-25T09:00:00Z",
            payload: {
              resourceType: "daily_web_curation",
              dateKey: "2026-08-25",
              items: [
                {
                  title: "Qwen update",
                  url: "https://example.test/qwen",
                  whyNow: "模型动态",
                  retrievedAt: "2026-08-25T08:58:00Z",
                  contentHash: "hash-qwen",
                  evidenceNodeId: "resource-qwen",
                  evidenceRefId: "evidence-qwen",
                },
                {
                  title: "China AI chain",
                  url: "https://example.test/china-ai",
                  whyNow: "产业链动态",
                  retrievedAt: "2026-08-25T08:59:00Z",
                  contentHash: "hash-china-ai",
                  evidenceNodeId: "resource-china-ai",
                },
                {
                  title: "DeepSeek Harness preview",
                  url: "https://example.test/dsh",
                  whyNow: "Agent 框架动态",
                  retrievedAt: "2026-08-25T09:00:00Z",
                  contentHash: "hash-dsh",
                  evidenceNodeId: "resource-dsh",
                },
              ],
            },
          },
        ],
        edges: [],
      },
      webResults: [{
        title: "Even newer temporary result",
        url: "https://example.test/temporary",
        whyNow: "Temporary search state",
      }],
    });

    const feed = result.projection.bindings["desktop.feed"];
    if (!feed || feed.kind !== "feed") throw new Error("feed projection missing");
    expect(feed.items.map((item) => item.title)).toEqual([
      "Qwen update",
      "China AI chain",
      "DeepSeek Harness preview",
    ]);
    expect(feed.items.some((item) => item.title.includes("optical"))).toBe(false);
    expect(feed.items.some((item) => item.title.includes("temporary"))).toBe(false);
  });

  it("keeps persisted whyNow immutable when later tensions and preferences change", () => {
    const resource = {
      id: "resource-web-immutable-reason",
      kind: "resource",
      label: "Immutable ranked source",
      authority: "imported_unverified",
      payload: {
        query: "the original query",
        whyNow: "当时因低敏策展词“复盘”匹配而排第 1。",
        url: "https://example.test/immutable-reason",
        title: "Immutable ranked source",
        retrievedAt: "2026-08-24T11:30:00Z",
        contentHash: "hash-immutable-reason",
        untrustedContent: true,
        promptAuthority: "none",
      },
    } as const;
    const before = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      searchReason: "当前理由 A 不应覆盖",
      context: {
        nodes: [
          resource,
          { id: "tension-old", kind: "tension", label: "旧张力" },
        ],
        edges: [],
      },
    });
    const after = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-25T12:00:00Z"),
      searchReason: "当前理由 B 也不应覆盖",
      context: {
        nodes: [
          resource,
          { id: "tension-new", kind: "tension", label: "完全不同的新张力" },
          {
            id: "preference-new",
            kind: "interest",
            label: "新策展偏好",
            payload: {
              preferenceType: "curator_preference",
              targetResourceId: resource.id,
              signal: "positive",
              recordedAt: "2026-08-25T11:00:00Z",
            },
          },
        ],
        edges: [],
      },
    });
    const beforeFeed = before.projection.bindings["desktop.feed"];
    const afterFeed = after.projection.bindings["desktop.feed"];
    if (beforeFeed?.kind !== "feed" || afterFeed?.kind !== "feed") {
      throw new Error("feed projection missing");
    }
    expect(beforeFeed.items[0]?.why).toBe("当时因低敏策展词“复盘”匹配而排第 1。");
    expect(afterFeed.items[0]?.why).toBe(beforeFeed.items[0]?.why);
  });

  it("labels legacy web resources instead of reconstructing whyNow from current context", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      searchReason: "这个当前搜索理由不能回填旧数据",
      context: {
        nodes: [{
          id: "resource-web-legacy",
          kind: "resource",
          label: "Legacy source",
          payload: {
            query: "旧查询也不能当作当时的排序理由",
            url: "https://example.test/legacy",
            title: "Legacy source",
            untrustedContent: true,
            promptAuthority: "none",
          },
        }, {
          id: "tension-current",
          kind: "tension",
          label: "当前张力不能覆盖历史",
        }],
        edges: [],
      },
    });
    const feed = result.projection.bindings["desktop.feed"];
    if (feed?.kind !== "feed") throw new Error("feed projection missing");
    expect(feed.items[0]?.why).toBe("这条历史资讯没有保存推荐理由。");
    expect(feed.items[0]?.why).not.toContain("当前张力不能覆盖历史");
    expect(feed.items[0]?.why).not.toContain("旧查询也不能当作当时的排序理由");
  });

  it("applies the latest durable curator preference instead of reviving dismissed feed items", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "resource-web-dismissed",
            kind: "resource",
            label: "用户已经看过的资讯",
            payload: {
              url: "https://example.test/already-known",
              title: "用户已经看过的资讯",
              retrievedAt: "2026-08-24T11:00:00Z",
              provider: "deepseek-official",
              contentHash: "hash-known",
              untrustedContent: true,
              promptAuthority: "none",
            },
          },
          {
            id: "interest-known",
            kind: "interest",
            label: "Feed 策展偏好",
            recordedAt: "2026-08-24T11:05:00Z",
            payload: {
              preferenceType: "curator_preference",
              signal: "already_known",
              targetResourceId: "resource-web-dismissed",
              recordedAt: "2026-08-24T11:05:00Z",
            },
          },
        ],
        edges: [],
      },
      webResults: [
        {
          title: "即时搜索里的同一条",
          url: "https://example.test/already-known",
          contentHash: "hash-known",
          evidenceNodeId: "resource-web-dismissed",
        },
      ],
    });

    const feed = result.projection.bindings["desktop.feed"];
    if (!feed || feed.kind !== "feed") throw new Error("feed projection missing");
    expect(feed.items).toEqual([]);
  });

  it("projects structured weekly double-loop sections and real StarState orbit facts", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "goal-1",
            kind: "goal",
            label: "稳定写作",
            authority: "user_stated",
            payload: { horizon: "north-star", surfaceRole: "constellation.north-star" },
          },
          {
            id: "claim-1",
            kind: "claim",
            label: "上午更容易进入状态",
            statement: "近期证据支持上午写作",
            authority: "system_inferred",
            payload: { horizon: "cognition", surfaceRole: "constellation.cognition" },
          },
          {
            id: "review-1",
            kind: "insight",
            label: "真实周回顾",
            payload: {
              periodStart: "2026-08-17T00:00:00Z",
              periodEnd: "2026-08-24T00:00:00Z",
              sections: {
                singleLoop: {
                  dueActions: [{ id: "action-due" }],
                  outcomes: [{ id: "outcome-1" }, { id: "outcome-2" }],
                  actionsWithoutEvidence: [{ id: "action-no-evidence" }],
                  question: "哪些做法真的改变了结果？",
                },
                doubleLoop: {
                  changedClaims: [{ id: "claim-1" }],
                  contradictions: [{ id: "tension-1" }],
                  pendingRevisions: [],
                  reframePrompts: ["是不是该换一个判断框架？"],
                  candidates: {
                    open: [{ id: "candidate-open" }],
                    concluded: [{ id: "candidate-done" }],
                    parked: [],
                  },
                  question: "哪些认知应该被收窄？",
                },
              },
            },
          },
        ],
        edges: [
          {
            id: "edge-orbit-1",
            fromNodeId: "claim-1",
            toNodeId: "goal-1",
            relationType: "orbits",
            proximity: "near",
            strength: "strong",
            status: "active",
          },
          {
            id: "edge-orbit-proposed",
            fromNodeId: "event-proposed",
            toNodeId: "goal-1",
            relationType: "orbits",
            proximity: "boundary",
            strength: "weak",
            status: "proposed",
          },
        ],
        starStates: [
          {
            centerNodeId: "claim-1",
            version: 2,
            role: "active_star",
            importance: "high",
            importanceAuthority: "system_inferred",
            salience: "hot",
            organizingPower: "connecting",
            freshness: "current",
            mass: "supported",
            radius: "medium",
            auraVersion: 1,
            stateStatus: "active",
            recomputeRequired: false,
          },
        ],
      },
    });

    expect(result.projection.bindings["desktop.reviewPlan"]).toMatchObject({
      kind: "progress",
      body: expect.stringContaining("换了做法：2 个真实结果"),
      leftMeta: "周期 8月17日 → 8月24日 · 换了做法 2 · 改了看法 1",
    });
    expect(result.projection.bindings["desktop.reviewPlan"]).toMatchObject({
      body: expect.stringContaining("改了看法：1 条认知发生变化，1 处矛盾"),
    });
    expect(result.projection.bindings["desktop.reviewPlan"]).toMatchObject({
      body: expect.stringContaining(
        "共创候选：1 个进行中，1 个形成结论，0 个已搁置。 本周要问：哪些做法真的改变了结果？；哪些认知应该被收窄？",
      ),
    });
    expect(result.projection.constellation?.cognitions).toContainEqual(
      expect.objectContaining({
        id: "claim-1",
        starState: expect.objectContaining({
          version: 2,
          role: "active_star",
          organizingPower: "connecting",
          mass: "supported",
          radius: "medium",
        }),
        orbit: expect.objectContaining({
          centerNodeId: "goal-1",
          relationType: "orbits",
          proximity: "near",
          strength: "strong",
        }),
      }),
    );
    expect(result.projection.constellation?.cognitions).not.toContainEqual(
      expect.objectContaining({ id: "event-proposed" }),
    );
  });

  it("projects the real typed candidate before generic tensions without inventing a conclusion", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: {
        nodes: [
          {
            id: "candidate-1",
            kind: "experiment",
            label: "把晨间写作变成共创节律",
            statement: "先观察哪一种启动方式值得继续",
            status: "proposed",
            payload: {
              interventionType: "candidate",
              candidateState: "proposed",
              proposedSilenceDueAt: "2026-08-24T11:59:00Z",
            },
          },
          {
            id: "tension-1",
            kind: "tension",
            label: "普通张力",
            statement: "不应盖住正在共创的候选",
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.header.subtitle).toContain("1 个共创候选");
    expect(result.projection.bindings["desktop.flex"]).toEqual({
      kind: "note",
      body: "先观察哪一种启动方式值得继续",
      quote: "候选 · 等待触碰 · 已安静 3 天，只提示，不自动收起",
    });
    expect(
      result.layout.cards.find((card) => card.binding === "desktop.flex")?.presentation?.title,
    ).toBe("共创候选");
  });

  it("projects the current revised claim instead of same-transaction superseded history", () => {
    const result = buildBrowserProjection({
      runtimeState: "ready",
      now: new Date("2026-08-24T12:00:00Z"),
      context: {
        // Context ordering is deliberately old-first and both rows share the
        // Domain transaction timestamp: array order cannot decide truth.
        nodes: [
          {
            id: "claim-original",
            kind: "claim",
            label: "上午适合深度工作",
            statement: "上午总能完成预估产出",
            status: "superseded",
            updatedAt: "2026-08-24T11:30:00Z",
          },
          {
            id: "claim-revised",
            kind: "claim",
            label: "上午适合深度工作",
            statement: "上午适合深度工作，但产出估算要保守",
            status: "active",
            updatedAt: "2026-08-24T11:30:00Z",
            payload: {
              revisionEffect: "revises",
              previousClaimId: "claim-original",
              outcomeId: "outcome-1",
            },
          },
        ],
        edges: [],
      },
    });

    expect(result.projection.bindings["desktop.flex"]).toMatchObject({
      kind: "note",
      body: "上午适合深度工作，但产出估算要保守",
    });
    expect(
      result.layout.cards.find((card) => card.binding === "desktop.flex")?.presentation?.title,
    ).toBe("最近值得想一想");
  });
});
