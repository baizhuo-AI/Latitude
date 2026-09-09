import { describe, expect, it, vi } from "vitest";
import type { ApplyChangeRequest, ChangeReceipt, KnowledgeContext, KnowledgeContextQuery, RuntimeRequestOptions } from "../../runtime/host/DesktopRuntimePort";
import { validateAllowlistedBrowserStorage } from "../../projections/desktop/browserProfile";
import { CustomDesktopCardStore } from "./store";
import { cardSnapshot, validateCustomDesktopCardsDocument, type CustomDesktopCard } from "./model";
import { legacyDesktopCardId, readLegacyDesktopCardGeometry } from "./legacyDesktopMigration";

function storage() {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } };
}
const input = { title: "记下这个想法", body: "用户自己的便签", template: "note" as const };
function runtime() {
  return {
    getContext: vi.fn(async (_query?: KnowledgeContextQuery, _options?: RuntimeRequestOptions): Promise<KnowledgeContext> => ({ nodes: [], edges: [] })),
    applyChange: vi.fn(async (_request: ApplyChangeRequest, _options?: RuntimeRequestOptions): Promise<ChangeReceipt> => ({ ok: true, changeSetId: "change-1", value: { id: "node-1" } })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function remoteNode(card: CustomDesktopCard, layoutId = "test-layout") {
  return { id: "node-1", kind: "resource", payload: {
    ...cardSnapshot(card), resourceType: "desktop_card", schemaVersion: 1, clientCardId: card.id, layoutId,
  } };
}

describe("custom desktop card persistence", () => {
  it("creates, edits and restores an offline note across reloads without inventing domain receipts", () => {
    const disk = storage();
    const first = new CustomDesktopCardStore("test-layout", disk);
    const created = first.create(input)!;
    expect(created.syncState).toBe("local");
    expect(created.domainId).toBeUndefined();
    expect(first.update(created.id, { ...input, title: "改过的标题", url: "https://example.com/read" })).toBe(true);
    expect(first.setVisible(created.id, false)).toBe(true);
    const second = new CustomDesktopCardStore("test-layout", disk);
    expect(second.getSnapshot().cards).toMatchObject([{ id: created.id, title: "改过的标题", hidden: true, revision: 3 }]);
    second.setVisible(created.id, true);
    expect(new CustomDesktopCardStore("test-layout", disk).getSnapshot().cards[0].hidden).toBe(false);
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///etc/hosts", "https://account:secret@example.com"])("rejects unsafe links: %s", (url) => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    expect(store.create({ ...input, url })).toBeNull();
    expect(store.getSnapshot().cards).toHaveLength(0);
    expect(store.getSnapshot().error).toBeTruthy();
  });

  it("does not overwrite unreadable existing notes or claim a failed local write was saved", () => {
    const disk = storage();
    disk.setItem("dim-custom-cards-test-layout", "{broken data");
    const broken = new CustomDesktopCardStore("test-layout", disk);
    expect(broken.create(input)).toBeNull();
    expect(disk.getItem(broken.key)).toBe("{broken data");
    const full = new CustomDesktopCardStore("test-layout", {
      getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); },
    });
    expect(full.create(input)).toBeNull();
    expect(full.getSnapshot().error).toContain("本次内容尚未保存");
  });

  it("includes typed notes in profile backups and rejects invalid card entries", () => {
    const disk = storage();
    const store = new CustomDesktopCardStore("test-layout", disk);
    store.create(input);
    const raw = disk.getItem(store.key)!;
    expect(validateAllowlistedBrowserStorage({ [store.key]: raw })).toEqual({ [store.key]: raw });
    const invalid = JSON.parse(raw);
    invalid.cards[0].url = "javascript:alert(1)";
    expect(() => validateAllowlistedBrowserStorage({ [store.key]: JSON.stringify(invalid) })).toThrow();
    expect(() => validateCustomDesktopCardsDocument({ version: 1, cards: [JSON.parse(raw).cards[0], JSON.parse(raw).cards[0]] })).toThrow(/重复/);
  });

  it("rejects a stale editor revision before its storage event arrives, retaining the supplied draft", () => {
    const disk = storage();
    const first = new CustomDesktopCardStore("test-layout", disk);
    const card = first.create(input)!;
    const second = new CustomDesktopCardStore("test-layout", disk);
    expect(second.update(card.id, { ...input, body: "另一窗口已保存的新内容" }, card.revision)).toBe(true);
    const draft = { ...input, body: "当前编辑器还没有保存的草稿" };
    expect(first.update(card.id, draft, card.revision)).toBe(false);
    expect(first.getSnapshot().error).toBe("卡片已在别处更新，请保留这份草稿后重新打开最新版本。");
    expect(first.getSnapshot().cards[0]).toMatchObject({ body: "另一窗口已保存的新内容", revision: 2 });
    expect(draft.body).toBe("当前编辑器还没有保存的草稿");
    expect(new CustomDesktopCardStore("test-layout", disk).getSnapshot().cards[0].body).toBe("另一窗口已保存的新内容");
    expect(first.update(card.id, draft, 2)).toBe(true);
  });

  it("does not overwrite newly corrupted storage while checking an editor revision", () => {
    const disk = storage();
    const store = new CustomDesktopCardStore("test-layout", disk);
    const card = store.create(input)!;
    disk.setItem(store.key, "{damaged but recoverable bytes");
    expect(store.update(card.id, { ...input, body: "新草稿" }, card.revision)).toBe(false);
    expect(disk.getItem(store.key)).toBe("{damaged but recoverable bytes");
    expect(store.getSnapshot().error).toContain("本地卡片未能读取");
    expect(store.getSnapshot().cards[0].body).toBe(input.body);
  });
});

describe("custom desktop card domain outbox", () => {
  it("saves a typed user resource then updates the same node for edits and removal", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    const card = store.create(input)!;
    const host = runtime();
    await store.connect(host);
    expect(host.applyChange).toHaveBeenCalledWith(expect.objectContaining({
      operation: "remember", kind: "resource", label: input.title, statement: input.body,
      scope: { surface: "desktop", layoutId: "test-layout", clientCardId: card.id },
      payload: expect.objectContaining({ resourceType: "desktop_card", clientCardId: card.id }),
      audit: { actor: "user", authorizationMode: "automatic" },
    }), expect.objectContaining({ idempotencyKey: `${card.id}:create:1` }));
    expect(host.applyChange.mock.calls[0][0]).not.toHaveProperty("evidenceRefs");
    expect(store.getSnapshot().cards[0]).toMatchObject({ domainId: "node-1", syncState: "synced", syncedRevision: 1 });
    store.setVisible(card.id, false);
    await store.retrySync();
    expect(host.applyChange).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "update", id: "node-1",
      payload: expect.objectContaining({ hidden: true }) }), expect.objectContaining({ idempotencyKey: `${card.id}:update:2` }));
  });

  it("replays the exact uncertain create after reload, then sends a newer edit as an update", async () => {
    const disk = storage();
    const first = new CustomDesktopCardStore("test-layout", disk);
    const card = first.create(input)!;
    const failedHost = runtime();
    failedHost.applyChange.mockRejectedValueOnce(new Error("response lost after commit"));
    await first.connect(failedHost);
    expect(first.getSnapshot().cards[0].syncState).toBe("error");
    const originalRequest = failedHost.applyChange.mock.calls[0];
    first.disconnect();
    first.update(card.id, { ...input, body: "网络中断时继续编辑" });
    const second = new CustomDesktopCardStore("test-layout", disk);
    const recovered = runtime();
    await second.connect(recovered);
    expect(recovered.applyChange.mock.calls[0]).toEqual(originalRequest);
    expect(recovered.applyChange).toHaveBeenCalledTimes(2);
    expect(recovered.applyChange).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "update", id: "node-1", statement: "网络中断时继续编辑" }), expect.anything());
    expect(second.getSnapshot().cards[0]).toMatchObject({ body: "网络中断时继续编辑", syncState: "synced", revision: 2, syncedRevision: 2 });
  });

  it("serializes an edit made while creation is in flight, preserving latest text", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    const card = store.create(input)!;
    const host = runtime();
    const pending = deferred<ChangeReceipt>();
    host.applyChange.mockImplementationOnce(() => pending.promise);
    const connecting = store.connect(host);
    await vi.waitFor(() => expect(host.applyChange).toHaveBeenCalledTimes(1));
    store.update(card.id, { ...input, body: "创建尚未返回时的新内容" });
    await Promise.resolve();
    expect(host.applyChange).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, changeSetId: "change-1", value: { id: "node-1" } });
    await connecting;
    expect(host.applyChange).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().cards[0]).toMatchObject({ body: "创建尚未返回时的新内容", syncState: "synced", revision: 2 });
  });

  it("resumes a durable pending write after a disconnect retires the previous writer", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    store.create(input);
    const oldHost = runtime();
    const pending = deferred<ChangeReceipt>();
    oldHost.applyChange.mockImplementationOnce(() => pending.promise);
    const initial = store.connect(oldHost);
    await vi.waitFor(() => expect(oldHost.applyChange).toHaveBeenCalledOnce());
    store.disconnect();
    const nextHost = runtime();
    const reconnected = store.connect(nextHost);
    pending.resolve({ ok: true, changeSetId: "old-change", value: { id: "node-1" } });
    await Promise.all([initial, reconnected]);
    expect(nextHost.applyChange).toHaveBeenCalledOnce();
    expect(nextHost.applyChange.mock.calls[0]).toEqual(oldHost.applyChange.mock.calls[0]);
    expect(store.getSnapshot().cards[0].syncState).toBe("synced");
  });

  it("discovers existing typed cards through paginated resources without duplicating a timed-out create", async () => {
    const disk = storage();
    const store = new CustomDesktopCardStore("test-layout", disk);
    const card = store.create(input)!;
    const host = runtime();
    host.getContext.mockResolvedValueOnce({ nodes: [{ ...remoteNode(card), id: "other", payload: { resourceType: "ui_change_set" } }], edges: [], coverage: { nextOffset: 500 } });
    host.getContext.mockResolvedValueOnce({ nodes: [remoteNode(card)], edges: [], coverage: { nextOffset: null } });
    await store.connect(host);
    expect(host.getContext).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ["resource"], offset: 500 }), expect.anything());
    expect(store.getSnapshot().cards).toHaveLength(1);
    expect(store.getSnapshot().cards[0].domainId).toBe("node-1");
    expect(host.applyChange).not.toHaveBeenCalled();
    const empty = new CustomDesktopCardStore("test-layout", storage());
    const secondHost = runtime();
    secondHost.getContext.mockResolvedValue({ nodes: [remoteNode({ ...card, hidden: true }), remoteNode({ ...card, id: "custom-card-other-layout" }, "other-layout")], edges: [] });
    await empty.connect(secondHost);
    expect(empty.getSnapshot().cards).toMatchObject([{ id: card.id, hidden: true }]);
    expect(secondHost.applyChange).not.toHaveBeenCalled();
  });

  it("preserves a local edit when a discovered remote card has the same revision but different text", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    const card = store.create({ ...input, body: "这台电脑尚未同步的文字" })!;
    const host = runtime();
    host.getContext.mockResolvedValue({ nodes: [remoteNode({ ...card, body: "另一端原来的文字" })], edges: [] });
    await store.connect(host);
    expect(host.applyChange).toHaveBeenCalledWith(expect.objectContaining({ operation: "update", id: "node-1",
      statement: "这台电脑尚未同步的文字" }), expect.objectContaining({ idempotencyKey: `${card.id}:update:2` }));
    expect(store.getSnapshot().cards[0]).toMatchObject({ body: "这台电脑尚未同步的文字", revision: 2, syncState: "synced" });
  });

  it.each([
    { status: "revoked" }, { status: "deleted" }, { status: "active", deletedAt: "2026-09-05T10:00:00Z" },
  ])("honors an explicit Domain tombstone while preserving local text and stopping writes: %j", async (tombstone) => {
    const disk = storage();
    const store = new CustomDesktopCardStore("test-layout", disk);
    const card = store.create(input)!;
    await store.connect(runtime());
    store.disconnect();
    store.update(card.id, { ...input, body: "撤回前尚未同步的本机文字" });
    const host = runtime();
    host.getContext.mockResolvedValue({ nodes: [{ ...remoteNode(card), ...tombstone }], edges: [] });
    await store.connect(host);
    expect(host.getContext).toHaveBeenCalledWith(expect.objectContaining({ includeRetracted: true }), expect.anything());
    expect(store.getSnapshot().cards[0]).toMatchObject({ domainRetracted: true, body: "撤回前尚未同步的本机文字" });
    expect(store.getSnapshot().cards[0].pendingWrite).toBeUndefined();
    expect(store.setVisible(card.id, true)).toBe(false);
    await store.retrySync();
    expect(host.applyChange).not.toHaveBeenCalled();
    expect(new CustomDesktopCardStore("test-layout", disk).getSnapshot().cards[0]).toMatchObject({ domainRetracted: true, body: "撤回前尚未同步的本机文字" });
  });

  it("keeps a known card when a context read omits it and only clears a tombstone after an explicit active node", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    const card = store.create(input)!;
    await store.connect(runtime());
    const missing = runtime();
    await store.connect(missing);
    expect(store.getSnapshot().cards[0]).toMatchObject({ id: card.id, hidden: false });
    expect(store.getSnapshot().cards[0].domainRetracted).toBeUndefined();
    const retracted = runtime();
    retracted.getContext.mockResolvedValue({ nodes: [{ ...remoteNode(card), status: "revoked" }], edges: [] });
    await store.connect(retracted);
    await store.connect(missing);
    expect(store.getSnapshot().cards[0].domainRetracted).toBe(true);
    const ambiguous = runtime();
    ambiguous.getContext.mockResolvedValue({ nodes: [remoteNode(card)], edges: [] });
    await store.connect(ambiguous);
    expect(store.getSnapshot().cards[0].domainRetracted).toBe(true);
    const restored = runtime();
    restored.getContext.mockResolvedValue({ nodes: [{ ...remoteNode(card), status: "active", deletedAt: null }], edges: [] });
    await store.connect(restored);
    expect(store.getSnapshot().cards[0].domainRetracted).toBeUndefined();
    expect(store.getSnapshot().cards[0].body).toBe(input.body);
    expect(restored.applyChange).not.toHaveBeenCalled();
  });

  it("coalesces overlapping resource refreshes instead of reading the same pages concurrently", async () => {
    const store = new CustomDesktopCardStore("test-layout", storage());
    const host = runtime();
    const pending = deferred<KnowledgeContext>();
    host.getContext.mockImplementationOnce(() => pending.promise);
    const first = store.connect(host);
    const second = store.connect(host);
    expect(first).toBe(second);
    expect(host.getContext).toHaveBeenCalledOnce();
    pending.resolve({ nodes: [], edges: [] });
    await Promise.all([first, second]);
    await store.connect(host);
    expect(host.getContext).toHaveBeenCalledTimes(2);
  });
});

describe("single desktop legacy notes", () => {
  const rootId = "test-layout";
  const legacyId = `${rootId}--clue-delivery`;

  it("keeps equal card IDs on different desks independent and migrates once without changing old storage", () => {
    const disk = storage();
    const root = new CustomDesktopCardStore(rootId, disk);
    const note = root.create(input)!;
    const legacyKey = `dim-custom-cards-${legacyId}`;
    const otherLegacyKey = `dim-custom-cards-${rootId}--clue-project`;
    const oldRaw = JSON.stringify({ version: 1, cards: [{ ...note, body: "交付原稿", hidden: true }] });
    disk.setItem(legacyKey, oldRaw);
    disk.setItem(otherLegacyKey, JSON.stringify({ version: 1, cards: [{ ...note, body: "项目原稿" }] }));
    root.reload();
    const migratedId = legacyDesktopCardId(legacyId, note.id);
    expect(root.getSnapshot().cards).toHaveLength(3);
    expect(root.getSnapshot().cards.find((card) => card.id === migratedId)).toMatchObject({
      body: "交付原稿", hidden: true, legacyOrigin: { layoutId: legacyId, cardId: note.id },
    });
    expect(root.update(migratedId, { ...input, body: "共同桌面的最新编辑" })).toBe(true);
    root.reload();
    expect(root.getSnapshot().cards).toHaveLength(3);
    expect(root.getSnapshot().cards.find((card) => card.id === migratedId)?.body).toBe("共同桌面的最新编辑");
    expect(disk.getItem(legacyKey)).toBe(oldRaw);
    expect(validateAllowlistedBrowserStorage({ [root.key]: disk.getItem(root.key)! })).toHaveProperty(root.key);
  });

  it("replays the exact uncertain legacy request and sends later text to the same original resource", async () => {
    const disk = storage();
    const old = new CustomDesktopCardStore(legacyId, disk);
    const card = old.create(input)!;
    const failedHost = runtime();
    failedHost.applyChange.mockRejectedValueOnce(new Error("receipt lost"));
    await old.connect(failedHost);
    old.disconnect();
    old.update(card.id, { ...input, body: "请求未确认时继续写的文字" });
    const rawBefore = disk.getItem(old.key);
    const root = new CustomDesktopCardStore(rootId, disk);
    const migrated = root.getSnapshot().cards[0];
    expect(migrated.pendingWrite?.snapshot.id).toBe(card.id);
    const recovered = runtime();
    await root.connect(recovered);
    expect(recovered.applyChange.mock.calls[0]).toEqual(failedHost.applyChange.mock.calls[0]);
    expect(recovered.applyChange).toHaveBeenCalledTimes(2);
    expect(recovered.applyChange.mock.calls[1][0]).toMatchObject({ operation: "update", id: "node-1",
      statement: "请求未确认时继续写的文字", payload: { layoutId: legacyId, clientCardId: card.id } });
    expect(recovered.applyChange.mock.calls[1][1]?.idempotencyKey).toBe(`${card.id}:update:2`);
    expect(disk.getItem(old.key)).toBe(rawBefore);
    expect(root.getSnapshot().cards[0]).toMatchObject({ id: migrated.id, revision: 2, syncedRevision: 2, syncState: "synced" });
  });

  it("finds remote-only legacy cards without remembering a duplicate, including colliding client IDs", async () => {
    const card = new CustomDesktopCardStore("unrelated", storage()).create(input)!;
    const root = new CustomDesktopCardStore(rootId, storage());
    const host = runtime();
    host.getContext.mockResolvedValue({ nodes: [remoteNode(card, rootId), { ...remoteNode(card, legacyId), id: "legacy-node" },
      remoteNode(card, "test-layout-other--clue-hidden")], edges: [] });
    await root.connect(host);
    expect(root.getSnapshot().cards).toHaveLength(2);
    expect(host.applyChange).not.toHaveBeenCalled();
    const migratedId = legacyDesktopCardId(legacyId, card.id);
    root.update(migratedId, { ...input, body: "更新远端旧卡" });
    await root.retrySync();
    expect(host.applyChange).toHaveBeenCalledOnce();
    expect(host.applyChange.mock.calls[0][0]).toMatchObject({ operation: "update", id: "legacy-node",
      payload: { layoutId: legacyId, clientCardId: card.id } });
    expect(host.applyChange.mock.calls[0][1]?.idempotencyKey).toBe(`${card.id}:update:2`);
  });

  it("keeps unsynced legacy text when remote revisions conflict and honors its later tombstone", async () => {
    const disk = storage();
    const old = new CustomDesktopCardStore(legacyId, disk);
    const card = old.create({ ...input, body: "本机未同步文字" })!;
    const root = new CustomDesktopCardStore(rootId, disk);
    const host = runtime();
    host.getContext.mockResolvedValue({ nodes: [remoteNode({ ...card, body: "远端同版本文字" }, legacyId)], edges: [] });
    await root.connect(host);
    expect(host.applyChange.mock.calls[0][0]).toMatchObject({ operation: "update", statement: "本机未同步文字" });
    expect(root.getSnapshot().cards[0].revision).toBe(2);
    const tombstoneHost = runtime();
    tombstoneHost.getContext.mockResolvedValue({ nodes: [{ ...remoteNode(card, legacyId), status: "revoked" }], edges: [] });
    await root.connect(tombstoneHost);
    root.reload();
    expect(root.getSnapshot().cards[0]).toMatchObject({ domainRetracted: true, body: "本机未同步文字" });
    expect(tombstoneHost.applyChange).not.toHaveBeenCalled();
  });

  it("preserves all existing cards when several old desks exceed the new-card limit", async () => {
    const disk = storage();
    const card = new CustomDesktopCardStore("seed", storage()).create(input)!;
    for (const desk of ["one", "two"]) {
      disk.setItem(`dim-custom-cards-${rootId}--clue-${desk}`, JSON.stringify({ version: 1,
        cards: Array.from({ length: 110 }, (_, index) => ({ ...card, id: `custom-card-existing-${index.toString().padStart(8, "0")}`,
          domainId: `${desk}-${index}`, syncedRevision: 1, syncState: "synced" })) }));
    }
    const root = new CustomDesktopCardStore(rootId, disk);
    expect(root.getSnapshot().cards).toHaveLength(220);
    await root.connect(runtime());
    expect(new CustomDesktopCardStore(rootId, disk).getSnapshot().cards).toHaveLength(220);
  });

  it("returns effective legacy frames and falls back to raw offsets without touching spatial storage", () => {
    const disk = storage();
    const old = new CustomDesktopCardStore(legacyId, disk);
    const note = old.create(input)!;
    const root = new CustomDesktopCardStore(rootId, disk);
    const card = root.getSnapshot().cards[0];
    disk.setItem(`dim-desk-offsets-${legacyId}`, JSON.stringify({ [note.id]: { x: -30, y: 45 } }));
    disk.setItem(`dim-desk-sizes-${legacyId}`, JSON.stringify({ [note.id]: { width: 430, height: 300 } }));
    expect(readLegacyDesktopCardGeometry(card, disk)).toEqual({ originLayoutId: legacyId, sourceIndex: 0,
      offset: { x: -30, y: 45 }, size: { width: 430, height: 300 } });
    const raw = JSON.stringify({ version: 1, frames: { [note.id]: { x: 100, y: 200, width: 400, height: 280 } } });
    disk.setItem(`dim-desk-frames-${legacyId}`, raw);
    expect(readLegacyDesktopCardGeometry(card, disk)?.frame).toEqual({ x: 70, y: 245, width: 430, height: 300 });
    expect(disk.getItem(`dim-desk-frames-${legacyId}`)).toBe(raw);
  });

  it("keeps damaged legacy bytes and refuses forged origins while retaining readable notes", () => {
    const disk = storage();
    const card = new CustomDesktopCardStore("seed", storage()).create(input)!;
    const damagedKey = `dim-custom-cards-${legacyId}`;
    disk.setItem(damagedKey, "{damaged old draft");
    disk.setItem(`dim-custom-cards-${rootId}--clue-readable`, JSON.stringify({ version: 1, cards: [card] }));
    const root = new CustomDesktopCardStore(rootId, disk);
    expect(root.getSnapshot().cards).toHaveLength(1);
    expect(root.getSnapshot().error).toContain("原始内容已保留");
    expect(disk.getItem(damagedKey)).toBe("{damaged old draft");
    const forged = { ...card, legacyOrigin: { layoutId: legacyId, cardId: card.id } };
    expect(() => validateCustomDesktopCardsDocument({ version: 1, cards: [forged] })).toThrow(/来源/);
    const misplaced = { ...forged, id: legacyDesktopCardId(legacyId, card.id) };
    expect(() => validateAllowlistedBrowserStorage({ "dim-custom-cards-unrelated": JSON.stringify({ version: 1, cards: [misplaced] }) })).toThrow(/source/);
  });
});
