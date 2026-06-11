import { describe, it, expect } from "vitest";
import type Database from "@tauri-apps/plugin-sql";
import { runInTransaction } from "./db";

/**
 * 手写事务封装 runInTransaction 的单测。
 *
 * 背景：@tauri-apps/plugin-sql 的 Database 只有 execute/select，没有 transaction()，
 * 所以我们手写 BEGIN/COMMIT，catch 里 ROLLBACK 后重抛。
 *
 * 这里用一个 fake db 只实现 execute（记录每次 SQL 调用序列），断言：
 *  - 成功路径：BEGIN → fn 内部的 SQL → COMMIT
 *  - fn 抛错：BEGIN → ROLLBACK，且原错误被重抛（不被吞）
 *
 * fake 只覆盖 runInTransaction 真正用到的 execute 子集，断言时 cast 成 Database。
 */
function makeFakeDb(): { db: Database; calls: string[] } {
  const calls: string[] = [];
  const db = {
    async execute(sql: string) {
      calls.push(sql);
      return { rowsAffected: 0 };
    }
  } as unknown as Database;
  return { db, calls };
}

describe("runInTransaction", () => {
  it("成功路径：BEGIN → fn → COMMIT，顺序正确", async () => {
    const { db, calls } = makeFakeDb();
    await runInTransaction(db, async (d) => {
      await d.execute("INSERT INTO t VALUES (1)");
    });
    expect(calls).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
  });

  it("fn 抛错：BEGIN → ROLLBACK，且错误被重抛", async () => {
    const { db, calls } = makeFakeDb();
    const boom = new Error("boom");
    await expect(
      runInTransaction(db, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("fn 内 SQL 跑过后再抛错：已执行的 SQL 在 BEGIN 之后、ROLLBACK 之前", async () => {
    const { db, calls } = makeFakeDb();
    await expect(
      runInTransaction(db, async (d) => {
        await d.execute("INSERT INTO t VALUES (1)");
        throw new Error("late boom");
      })
    ).rejects.toThrow("late boom");
    expect(calls).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "ROLLBACK"]);
  });

  it("ROLLBACK 本身失败时仍重抛原始错误（不被 ROLLBACK 的错盖掉）", async () => {
    const calls: string[] = [];
    const db = {
      async execute(sql: string) {
        calls.push(sql);
        // 模拟：BEGIN/业务 SQL 正常，ROLLBACK 时连接已坏
        if (sql === "ROLLBACK") throw new Error("rollback failed");
        return { rowsAffected: 0 };
      }
    } as unknown as Database;
    const original = new Error("original boom");
    await expect(
      runInTransaction(db, async () => {
        throw original;
      })
    ).rejects.toBe(original);
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
