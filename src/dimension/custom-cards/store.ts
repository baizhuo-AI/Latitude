import type { ApplyChangeRequest, DesktopRuntimePort, KnowledgeNode, RuntimeJson } from "../../runtime/host/DesktopRuntimePort";
import {
  cardSnapshot, CUSTOM_DESKTOP_CARDS_PREFIX, MAX_CUSTOM_DESKTOP_CARDS, MAX_STORED_CUSTOM_DESKTOP_CARDS,
  normalizeCustomDesktopCardInput, validateCustomDesktopCardsDocument,
  type CustomDesktopCard, type CustomDesktopCardInput, type CustomDesktopCardSnapshot,
} from "./model";
import { isLegacyDesktopLayout, mergeLegacyDesktopCards, migrateLegacyDesktopCard, type LegacyDesktopStorage } from "./legacyDesktopMigration";

type CardRuntime = Pick<DesktopRuntimePort, "getContext" | "applyChange">;
interface StoreState { cards: CustomDesktopCard[]; error: string | null }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function writePayload(layoutId: string, card: CustomDesktopCardSnapshot): RuntimeJson {
  return { resourceType: "desktop_card", schemaVersion: 1, layoutId, clientCardId: card.id,
    title: card.title, body: card.body, template: card.template, hidden: card.hidden,
    createdAt: card.createdAt, updatedAt: card.updatedAt, revision: card.revision,
    ...(card.url ? { url: card.url } : {}) };
}

function writeRequest(layoutId: string, pending: NonNullable<CustomDesktopCard["pendingWrite"]>): ApplyChangeRequest {
  const card = pending.snapshot;
  const common = { label: card.title, statement: card.body, payload: writePayload(layoutId, card),
    audit: { actor: "user", authorizationMode: "automatic" as const } };
  return pending.domainId ? { ...common, operation: "update", id: pending.domainId } : {
    ...common, operation: "remember", kind: "resource", sensitivity: "medium",
    scope: { surface: "desktop", layoutId, clientCardId: card.id },
  };
}

function readDomainCard(node: KnowledgeNode, layoutId: string): CustomDesktopCard | null {
  const payload = asRecord(node.payload);
  if (node.kind !== "resource" || !payload || payload.resourceType !== "desktop_card" ||
      payload.schemaVersion !== 1 || (payload.layoutId !== layoutId && !isLegacyDesktopLayout(layoutId, payload.layoutId))) return null;
  const retracted = ["deleted", "revoked"].includes(node.status ?? "") ||
    (typeof node.deletedAt === "string" && Boolean(node.deletedAt));
  try {
    const card = validateCustomDesktopCardsDocument({ version: 1, cards: [{
      ...payload, id: payload.clientCardId, domainId: node.id, syncedRevision: payload.revision,
      syncState: "synced", domainRetracted: retracted, pendingWrite: undefined, legacyOrigin: undefined,
    }] }).cards[0];
    return payload.layoutId === layoutId ? card : migrateLegacyDesktopCard(card, payload.layoutId as string);
  } catch { return null; }
}

/** Local-first notes. Each card has one durable outbox entry and one serialized writer. */
export class CustomDesktopCardStore {
  readonly key: string;
  private state: StoreState = { cards: [], error: null };
  private listeners = new Set<() => void>();
  private runtime: CardRuntime | null = null;
  private writers = new Map<string, Promise<void>>();
  private hydration: Promise<void> = Promise.resolve();
  private connection: { runtime: CardRuntime; generation: number; task: Promise<void> } | null = null;
  private readController: AbortController | null = null;
  private generation = 0;
  private invalidStorage = false;

  constructor(readonly layoutId: string, private storage: LegacyDesktopStorage & Pick<Storage, "setItem"> = window.localStorage) {
    this.key = `${CUSTOM_DESKTOP_CARDS_PREFIX}${layoutId}`;
    this.reload();
  }

  getSnapshot = (): StoreState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: StoreState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  private fail(message: string) { this.publish({ ...this.state, error: message }); }
  clearError = () => { if (!this.invalidStorage) this.publish({ ...this.state, error: null }); };

  reload = () => {
    try {
      const raw = this.storage.getItem(this.key);
      const cards = raw ? validateCustomDesktopCardsDocument(JSON.parse(raw)).cards : [];
      // Reject a source claim for a different root rather than routing edits
      // from an imported profile to an unrelated legacy resource.
      if (cards.some((card) => card.legacyOrigin && !isLegacyDesktopLayout(this.layoutId, card.legacyOrigin.layoutId))) {
        throw new TypeError("Legacy card does not belong to this desktop");
      }
      this.invalidStorage = false;
      this.publish({ cards, error: null });
      const migration = mergeLegacyDesktopCards(this.layoutId, cards, this.storage);
      if (migration.changed && !this.save(migration.cards)) return;
      if (migration.warnings.length) this.fail(migration.warnings[0]);
    } catch {
      this.invalidStorage = true;
      this.fail("本地卡片未能读取，原有内容已保留。请先导出备份或检查浏览器存储。");
    }
  };

  private save(cards: CustomDesktopCard[]): boolean {
    if (this.invalidStorage) return false;
    if (cards.length > MAX_STORED_CUSTOM_DESKTOP_CARDS) {
      this.fail("桌面卡片较多，尚未全部读取；原有内容已保留。");
      return false;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, cards }));
      this.publish({ cards, error: null });
      return true;
    } catch {
      this.fail("浏览器没有保存成功，可能是存储空间不足。本次内容尚未保存，请复制保留后重试。");
      return false;
    }
  }

  create = (input: CustomDesktopCardInput): CustomDesktopCard | null => {
    try {
      if (this.state.cards.length >= MAX_CUSTOM_DESKTOP_CARDS) throw new Error("桌面卡片已达到 200 张，请先整理已有卡片。");
      const fields = normalizeCustomDesktopCardInput(input);
      const now = new Date().toISOString();
      const card: CustomDesktopCard = { ...fields, id: `custom-card-${crypto.randomUUID()}`, hidden: false,
        createdAt: now, updatedAt: now, revision: 1, syncedRevision: 0, syncState: "local" };
      if (!this.save([...this.state.cards, card])) return null;
      void this.sync(card.id);
      return card;
    } catch (error) { this.fail(error instanceof Error ? error.message : "卡片没有保存成功。"); return null; }
  };

  update = (id: string, input: CustomDesktopCardInput, expectedRevision?: number): boolean => {
    try {
      const fields = normalizeCustomDesktopCardInput(input);
      // Read the latest persisted version even before another window's storage
      // event has arrived. A stale editor must not overwrite that newer text.
      if (expectedRevision !== undefined) this.reload();
      return this.edit(id, (card) => ({ ...card, ...fields, url: fields.url }), expectedRevision);
    } catch (error) { this.fail(error instanceof Error ? error.message : "卡片没有保存成功。"); return false; }
  };

  setVisible = (id: string, visible: boolean): boolean => this.edit(id, (card) => ({ ...card, hidden: !visible }));

  private edit(id: string, mutate: (card: CustomDesktopCard) => CustomDesktopCard, expectedRevision?: number): boolean {
    if (this.invalidStorage) return false;
    const previous = this.state.cards.find((card) => card.id === id);
    if (expectedRevision !== undefined && previous?.revision !== expectedRevision) {
      this.fail("卡片已在别处更新，请保留这份草稿后重新打开最新版本。");
      return false;
    }
    if (!previous) { this.fail("这张卡片已不可用。"); return false; }
    if (previous.domainRetracted) { this.fail("这张卡片已在本地服务中撤回，请先保留这份草稿。"); return false; }
    const next = { ...mutate(previous), revision: previous.revision + 1,
      updatedAt: new Date().toISOString(), syncState: "local" as const };
    if (!this.save(this.state.cards.map((card) => card.id === id ? next : card))) return false;
    void this.sync(id);
    return true;
  }

  disconnect = () => {
    this.generation += 1;
    this.runtime = null;
    this.readController?.abort();
  };

  connect = (runtime: CardRuntime): Promise<void> => {
    if (this.connection?.runtime === runtime && this.connection.generation === this.generation) return this.connection.task;
    this.runtime = runtime;
    const generation = ++this.generation;
    this.readController?.abort();
    this.readController = new AbortController();
    this.hydration = this.loadDomain(runtime, generation, this.readController.signal);
    const task = (async () => {
      await this.hydration;
      if (this.generation === generation) {
        await this.retrySync();
        // StrictMode or a profile restore may retire an older in-flight writer.
        // After it settles, start any remaining current draft once; failed writes
        // remain explicit retries rather than becoming an automatic retry loop.
        if (this.generation === generation) await Promise.all(this.state.cards
          .filter((card) => card.syncedRevision < card.revision && card.syncState !== "error" && !card.domainRetracted)
          .map((card) => this.sync(card.id)));
      }
    })().finally(() => { if (this.connection?.generation === generation) this.connection = null; });
    this.connection = { runtime, generation, task };
    return task;
  };

  private async loadDomain(runtime: CardRuntime, generation: number, signal: AbortSignal) {
    try {
      const incoming = new Map<string, CustomDesktopCard>();
      const activeNodeIds = new Set<string>();
      let offset = 0;
      // The existing context endpoint supports pagination. Restrict to resources,
      // then accept this root and its legacy clue scopes without moving them.
      for (;;) {
        const query = { kinds: ["resource"], includeRetracted: true, limit: 500, sensitivityCeiling: "highest" as const, offset };
        const context = await runtime.getContext(query, { retries: 0, signal });
        if (generation !== this.generation) return;
        for (const node of context.nodes) {
          const card = readDomainCard(node, this.layoutId);
          if (card && !incoming.has(card.id)) incoming.set(card.id, card);
          if (card && node.status === "active" && !card.domainRetracted) activeNodeIds.add(node.id);
        }
        const next = asRecord(context.coverage)?.nextOffset;
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset) break;
        offset = next;
      }
      const merged = this.state.cards.map((stored) => {
        let local = stored;
        const remote = incoming.get(local.id);
        incoming.delete(local.id);
        if (!remote) return local;
        // Retraction is based on an explicit tombstone for the bound Domain
        // node. A missing resource (pagination, offline, purge) is not deletion.
        if (remote.domainRetracted) {
          if (local.domainId && local.domainId !== remote.domainId) return local;
          return { ...local, domainId: remote.domainId, domainRetracted: true, pendingWrite: undefined };
        }
        if (local.domainRetracted) {
          if (local.domainId !== remote.domainId || !activeNodeIds.has(remote.domainId!)) return local;
          local = { ...local, domainRetracted: undefined };
        }
        const differs = local.title !== remote.title || local.body !== remote.body || local.url !== remote.url ||
          local.template !== remote.template || local.hidden !== remote.hidden;
        if (local.syncedRevision < local.revision && local.revision <= remote.revision && differs) {
          // Never discard an unsynced local edit when another window reached the
          // same revision number. Keep its text and allocate a fresh update revision.
          return { ...local, domainId: remote.domainId, revision: remote.revision + 1,
            syncedRevision: remote.revision, pendingWrite: undefined, syncState: "local" as const };
        }
        // A newer local edit wins; discovering the receipt supplies its target ID.
        if (local.revision > remote.revision) return { ...local, domainId: remote.domainId,
          syncedRevision: Math.max(local.syncedRevision, remote.revision),
          ...(local.pendingWrite && (!local.pendingWrite.domainId || local.pendingWrite.snapshot.revision <= remote.revision) ? { pendingWrite: undefined } : {}) };
        return remote;
      });
      this.save([...merged, ...[...incoming.values()].filter((card) => !card.domainRetracted)]);
    } catch {
      if (generation === this.generation) this.fail("已有便签保存在本机；暂时未能读取本地服务中的卡片。");
    }
  }

  retrySync = async (id?: string): Promise<void> => {
    await Promise.all((id ? [id] : this.state.cards.map((card) => card.id)).map((cardId) => this.sync(cardId)));
  };

  private sync(id: string): Promise<void> {
    if (!this.runtime) return Promise.resolve();
    const running = this.writers.get(id);
    if (running) return running;
    const task = this.writeCard(id).finally(() => { this.writers.delete(id); });
    this.writers.set(id, task);
    return task;
  }

  private async writeCard(id: string): Promise<void> {
    const hydration = this.hydration;
    await hydration;
    if (hydration !== this.hydration) return this.writeCard(id);
    for (;;) {
      const runtime = this.runtime;
      const generation = this.generation;
      const card = this.state.cards.find((candidate) => candidate.id === id);
      if (!runtime || !card || card.domainRetracted || card.syncedRevision >= card.revision || this.invalidStorage) return;
      const sourceId = card.legacyOrigin?.cardId ?? card.id;
      const sourceLayoutId = card.legacyOrigin?.layoutId ?? this.layoutId;
      const pending = card.pendingWrite ?? { snapshot: { ...cardSnapshot(card), id: sourceId }, ...(card.domainId ? { domainId: card.domainId } : {}) };
      if (!this.save(this.state.cards.map((current) => current.id === id ? { ...current, pendingWrite: pending, syncState: "syncing" } : current))) return;
      try {
        const receipt = await runtime.applyChange(writeRequest(sourceLayoutId, pending), {
          idempotencyKey: `${sourceId}:${pending.domainId ? "update" : "create"}:${pending.snapshot.revision}`,
          retries: 0,
        });
        if (generation !== this.generation) return;
        const value = asRecord(receipt.value);
        const domainId = pending.domainId ?? value?.id ?? value?.nodeId ?? asRecord(value?.node)?.id;
        if (!receipt.ok || typeof domainId !== "string" || !domainId) throw new Error("missing_card_receipt");
        if (!this.save(this.state.cards.map((current) => current.id === id ? {
          ...current, domainId, syncedRevision: pending.snapshot.revision, pendingWrite: undefined,
          syncState: current.revision === pending.snapshot.revision ? "synced" : "local",
        } : current))) return;
      } catch {
        if (generation !== this.generation) return;
        this.save(this.state.cards.map((current) => current.id === id ? { ...current, syncState: "error" } : current));
        return;
      }
    }
  }
}
