// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopStore } from "../src/desktop/desktopStore.js";
import { DshRuntime } from "../src/runtime/dshRuntime.js";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { FakeDomain, testConfig, toolSequenceThenTextAdapter } from "./helpers.js";
import { AgentHttpServer } from "../src/http/server.js";
import { RunJobStore } from "../src/jobs/jobStore.js";
import { DurableScheduler } from "../src/scheduler/durableScheduler.js";
import { AgentAdminService } from "../src/admin/adminService.js";

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const stores: DesktopStore[] = [];
const audit = { sessionId: "test-session", runId: "test-run", toolCallId: "test-call" };
const todo = { kind: "todo", publicationKey: "todo:goal-1:write", title: "写完草稿", sourceNodeIds: ["goal-1"], scheduledDate: "2026-09-07" };
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "latitude-desktop-test-")); roots.push(root);
  const filename = path.join(root, "latitude.db");
  const store = new DesktopStore(filename); stores.push(store);
  return { root, filename, store };
}
afterEach(async () => {
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("persisted desktop business content", () => {
  it("rejects a graph database path without creating business tables in it", async () => {
    const { store, filename } = await setup();
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY)");
    expect(() => store.read()).toThrow("知识图谱");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='todos'").get()).toBeUndefined();
    db.close();
  });

  it("publishes the scheduled graph-based newspaper to daily_digest before reporting success", async () => {
    const { root, store } = await setup();
    const domain = new FakeDomain();
    domain.createToolDefinitions = () => [{ name: "knowledge_context", description: "Read fixture knowledge",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute: async () => ({ nodes: [{ id: "goal-1", kind: "goal", label: "Agent research" }] }),
    }];
    const runtime = new DshRuntime({ config: testConfig(root), ledger: new AuditLedger(root), domain,
      desktop: store, installOfficialWebSearch: false,
      webSearchProvider: { id: "test-web", available: () => true, search: async () => ({ sources: [{ title: "Agent research", url: "https://example.com/research", snippet: "Primary report" }], truncated: false }) },
      adapter: toolSequenceThenTextAdapter([
        { name: "knowledge_context", args: {} },
        { name: "daily_web_curate", args: { dateKey: "2026-09-07", query: "Agent research", rankingTerms: ["Agent"], goalNodeIds: ["goal-1"], tensionNodeIds: [], preferenceNodeIds: [] } },
      ], "日报已保存"),
    });
    try {
      const result = await runtime.runTurn({ runId: "scheduled-publish", sessionId: "latitude:scheduler:daily-curation", clientRequestId: "scheduler:curation:2026-09-07", initiator: "scheduler", text: "生成今天早报", budgets: {} }, new AbortController().signal);
      expect(result.dailyCuration).toMatchObject({ dateKey: "2026-09-07", itemCount: 1 });
      expect(domain.curations).toHaveLength(1);
      expect(store.read("2026-09-07").digests[0]).toMatchObject({ date: "2026-09-07", summary: expect.stringContaining("https://example.com/research"), sourceNodeIds: expect.arrayContaining(["goal-1"]) });
    } finally { await runtime.close(); }
  });

  it("serves committed content over the desktop HTTP route and rejects stale/foreign-origin writes", async () => {
    const { root, store } = await setup();
    const domain = new FakeDomain();
    const config = testConfig(root), ledger = new AuditLedger(root);
    const runtime = new DshRuntime({ config, ledger, domain, desktop: store, installOfficialWebSearch: false, adapter: toolSequenceThenTextAdapter([], "ok") });
    const jobs = new RunJobStore(runtime, ledger), scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
    const server = new AgentHttpServer({ config, runtime, jobs, domain, scheduler, desktop: store, admin: new AgentAdminService({ stateDir: root, ledger }) });
    try {
      const { url } = await server.start();
      store.publish(todo, audit);
      const content = await (await fetch(`${url}/v1/agent/desktop?date=2026-09-07`)).json();
      expect(content.todos).toHaveLength(1);
      const original = content.todos[0];
      const request = { id: original.id, expectedUpdatedAt: original.updatedAt, title: "修改成功" };
      const update = (body: unknown, origin = "http://localhost:1420") => fetch(`${url}/v1/agent/desktop/todo`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
      expect((await update(request, "https://untrusted.example")).status).toBe(403);
      expect((await update(request)).status).toBe(200);
      expect((await update({ ...request, title: "过期更新" })).status).toBe(409);
      expect(store.read("2026-09-07").todos[0].title).toBe("修改成功");
      expect((await fetch(`${url}/v1/agent/desktop?date=invalid`)).status).toBe(400);
    } finally { await server.close(); await scheduler.close(); await runtime.close(); }
  });

  it("commits to the original table schema, reopens, deduplicates and never reverts user edits", async () => {
    const { store, filename } = await setup();
    const receipt = store.publish(todo, audit);
    const original = store.read("2026-09-07").todos[0];
    expect(original).toMatchObject({ id: receipt.id, title: todo.title, sourceNodeIds: ["goal-1"] });
    store.updateTodo({ id: original.id, expectedUpdatedAt: original.updatedAt, title: "用户改过的标题", status: "done" });
    expect(store.publish(todo, audit)).toMatchObject({ persisted: true, deduplicated: true, id: receipt.id });
    expect(() => store.publish({ ...todo, title: "覆盖" }, audit)).toThrow("不同内容");
    expect(() => store.updateTodo({ id: original.id, expectedUpdatedAt: original.updatedAt, title: "过期覆盖" })).toThrow("已变化");
    store.close();
    const reopened = new DesktopStore(filename); stores.push(reopened);
    expect(reopened.read("2026-09-07").todos).toMatchObject([{ title: "用户改过的标题", status: "done" }]);
    const db = new DatabaseSync(filename);
    expect(db.prepare("SELECT count(*) AS n FROM todos").get()?.n).toBe(1);
    db.prepare("DELETE FROM todos WHERE id=?").run(receipt.id);
    expect(() => reopened.publish(todo, audit)).toThrow("已被移除");
    expect(db.prepare("SELECT count(*) AS n FROM todos").get()?.n).toBe(0);
    db.close();
  });

  it("preserves historical digest dates and text; conflicts roll back both receipt and business row", async () => {
    const { store, filename } = await setup();
    store.publish({ kind: "digest", publicationKey: "digest:old", date: "2026-06-16", summary: "旧整理全文", sourceNodeIds: [] }, audit);
    expect(() => store.publish({ kind: "digest", publicationKey: "digest:other", date: "2026-06-16", summary: "不应覆盖", sourceNodeIds: [] }, audit)).toThrow("已有每日整理");
    expect(store.read("2026-09-07").digests).toEqual([{ date: "2026-06-16", summary: "旧整理全文", sourceNodeIds: [] }]);
    const db = new DatabaseSync(filename);
    expect(db.prepare("SELECT count(*) AS n FROM desktop_publications").get()?.n).toBe(1);
    db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON desktop_publications BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END;");
    expect(() => store.publish(todo, audit)).toThrow("disk write rejected");
    expect(db.prepare("SELECT count(*) AS n FROM todos").get()?.n).toBe(0);
    db.close();
  });

  it("saves generated calendar entries locally without enqueueing external writes", async () => {
    const { store, filename } = await setup();
    store.publish({ kind: "calendar", publicationKey: "calendar:focus", title: "写作时段", scheduledDate: "2026-09-07", scheduledTime: "09:00", startTs: 1788786000, endTs: 1788789600, sourceNodeIds: ["goal-1"] }, audit);
    expect(store.read("2026-09-07").events).toMatchObject([{ title: "写作时段", scheduledTime: "09:00" }]);
    const db = new DatabaseSync(filename);
    expect(db.prepare("SELECT region,calendar_id,local_draft FROM calendar_events").get()).toMatchObject({ region: "local", calendar_id: "latitude-local", local_draft: 0 });
    db.close();
    expect(() => store.publish({ ...todo, scheduledDate: "2026-02-30" }, audit)).toThrow("Invalid date");
  });

  it("runs the actual DSH publication tool and reads its committed output after closing the store", async () => {
    const { root, filename, store } = await setup();
    const domain = new FakeDomain();
    const runtime = new DshRuntime({ config: testConfig(root), ledger: new AuditLedger(root), domain,
      desktop: store, installOfficialWebSearch: false,
      adapter: toolSequenceThenTextAdapter([
        { name: "desktop_read", args: { date: "2026-09-07" } },
        { name: "desktop_publish", args: todo },
        { name: "desktop_publish", args: { kind: "digest", publicationKey: "digest:2026-09-07", date: "2026-09-07", summary: "基于目标生成的日报正文", sourceNodeIds: ["goal-1"] } },
      ], "已保存到桌面"),
    });
    try {
      const result = await runtime.runTurn({ runId: "publish-run", sessionId: "publish-session", text: "根据目标生成待办和日报，并保存到桌面", budgets: {} }, new AbortController().signal);
      expect(result.status).toBe("completed");
      store.close();
      const reopened = new DesktopStore(filename); stores.push(reopened);
      expect(reopened.read("2026-09-07").todos).toHaveLength(1);
      expect(reopened.read("2026-09-07").digests[0].summary).toBe("基于目标生成的日报正文");
    } finally { await runtime.close(); }
  });
});
