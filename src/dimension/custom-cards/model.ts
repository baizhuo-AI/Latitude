export const CUSTOM_DESKTOP_CARDS_PREFIX = "dim-custom-cards-";
export const CUSTOM_DESKTOP_CARDS_VERSION = 1;
export const MAX_CUSTOM_DESKTOP_CARDS = 200;
/** Consolidating older clue desks must not truncate their existing notes. */
export const MAX_STORED_CUSTOM_DESKTOP_CARDS = 4_000;

export interface LegacyDesktopCardOrigin { layoutId: string; cardId: string }

/** Stable UI identity; remote writes keep the original pair in legacyOrigin. */
export function legacyDesktopCardId(layoutId: string, cardId: string): string {
  const identity = JSON.stringify([layoutId, cardId]);
  const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed;
    for (let index = 0; index < identity.length; index += 1) {
      hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  });
  return `custom-card-legacy-${words.join("")}`;
}

export interface CustomDesktopCardInput {
  title: string;
  body: string;
  url?: string;
  template: "note" | "text";
}

export interface CustomDesktopCardSnapshot extends CustomDesktopCardInput {
  id: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface CustomDesktopCard extends CustomDesktopCardSnapshot {
  /** Presentation migration only: this remains the original remote resource. */
  legacyOrigin?: LegacyDesktopCardOrigin;
  domainId?: string;
  /** Explicit Domain tombstone; retain text in backups while hiding the card. */
  domainRetracted?: boolean;
  syncedRevision: number;
  syncState: "local" | "syncing" | "synced" | "error";
  /** Persist the exact first request before sending, so an uncertain write can be retried. */
  pendingWrite?: { snapshot: CustomDesktopCardSnapshot; domainId?: string };
}

export interface CustomDesktopCardsDocument {
  version: 1;
  cards: CustomDesktopCard[];
}

export function normalizeCustomDesktopCardInput(input: CustomDesktopCardInput): CustomDesktopCardInput {
  if (input.template !== "note" && input.template !== "text") throw new Error("请选择便签或文字／链接卡。");
  if (typeof input.title !== "string" || typeof input.body !== "string") throw new Error("卡片内容格式不正确。");
  const title = input.title.trim();
  if (!title) throw new Error("给卡片起个名字。");
  if (title.length > 100) throw new Error("卡片标题最多 100 个字。");
  if (input.body.length > 20_000) throw new Error("卡片正文最多 20,000 个字。");
  if (input.url !== undefined && typeof input.url !== "string") throw new Error("链接格式不正确。");
  const url = input.url?.trim();
  if (url) {
    if (url.length > 2_048) throw new Error("链接太长了。");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("请输入完整的 http 或 https 链接。"); }
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("只支持不含账号密码的 http 或 https 链接。");
    }
  }
  return { title, body: input.body, template: input.template, ...(url ? { url } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^custom-card-[A-Za-z0-9-]{8,80}$/.test(id);
}

function validateSnapshot(value: unknown): CustomDesktopCardSnapshot {
  if (!isRecord(value) || !validId(value.id) || typeof value.hidden !== "boolean" ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TypeError("本地卡片格式不完整。");
  }
  const input = normalizeCustomDesktopCardInput(value as unknown as CustomDesktopCardInput);
  return { ...input, id: value.id, hidden: value.hidden, revision: value.revision as number,
    createdAt: value.createdAt, updatedAt: value.updatedAt };
}

/** Used by both local loading and full-profile import; never accept executable card payloads. */
export function validateCustomDesktopCardsDocument(value: unknown): CustomDesktopCardsDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.cards) || value.cards.length > MAX_STORED_CUSTOM_DESKTOP_CARDS) {
    throw new TypeError("本地卡片备份格式不正确。");
  }
  const ids = new Set<string>();
  const cards = value.cards.map((raw): CustomDesktopCard => {
    const snapshot = validateSnapshot(raw);
    if (ids.has(snapshot.id)) throw new TypeError("本地卡片包含重复标识。");
    ids.add(snapshot.id);
    if (!isRecord(raw) || !Number.isSafeInteger(raw.syncedRevision) || (raw.syncedRevision as number) < 0 ||
        (raw.syncedRevision as number) > snapshot.revision ||
        !["local", "syncing", "synced", "error"].includes(String(raw.syncState)) ||
        (raw.domainRetracted !== undefined && typeof raw.domainRetracted !== "boolean") ||
        (raw.domainId !== undefined && (typeof raw.domainId !== "string" || !raw.domainId || raw.domainId.length > 200))) {
      throw new TypeError("本地卡片保存状态不正确。");
    }
    let legacyOrigin: LegacyDesktopCardOrigin | undefined;
    if (raw.legacyOrigin !== undefined) {
      const origin = raw.legacyOrigin;
      if (!isRecord(origin) || typeof origin.layoutId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(origin.layoutId) ||
          !origin.layoutId.includes("--clue-") || !validId(origin.cardId) ||
          snapshot.id !== legacyDesktopCardId(origin.layoutId, origin.cardId)) {
        throw new TypeError("旧桌面卡片来源不正确。");
      }
      legacyOrigin = { layoutId: origin.layoutId, cardId: origin.cardId };
    }
    let pendingWrite: CustomDesktopCard["pendingWrite"];
    if (raw.pendingWrite !== undefined) {
      if (!isRecord(raw.pendingWrite)) throw new TypeError("卡片待保存内容不正确。");
      const pending = validateSnapshot(raw.pendingWrite.snapshot);
      if (pending.id !== (legacyOrigin?.cardId ?? snapshot.id) || pending.revision > snapshot.revision ||
          (raw.pendingWrite.domainId !== undefined && (typeof raw.pendingWrite.domainId !== "string" || !raw.pendingWrite.domainId || raw.pendingWrite.domainId.length > 200))) {
        throw new TypeError("卡片待保存内容不正确。");
      }
      pendingWrite = { snapshot: pending, ...(raw.pendingWrite.domainId ? { domainId: raw.pendingWrite.domainId as string } : {}) };
    }
    if ((raw.syncedRevision as number) > 0 && !raw.domainId) throw new TypeError("卡片缺少保存标识。");
    if (raw.domainRetracted && !raw.domainId) throw new TypeError("卡片缺少撤回标识。");
    if (raw.syncState === "synced" && raw.syncedRevision !== snapshot.revision) throw new TypeError("卡片保存版本不一致。");
    return { ...snapshot, ...(raw.domainId ? { domainId: raw.domainId as string } : {}),
      ...(legacyOrigin ? { legacyOrigin } : {}),
      ...(raw.domainRetracted ? { domainRetracted: true } : {}),
      syncedRevision: raw.syncedRevision as number,
      syncState: raw.syncState === "syncing" ? "local" : raw.syncState as CustomDesktopCard["syncState"],
      ...(pendingWrite ? { pendingWrite } : {}) };
  });
  return { version: 1, cards };
}

export function cardSnapshot(card: CustomDesktopCard): CustomDesktopCardSnapshot {
  const { id, title, body, url, template, hidden, createdAt, updatedAt, revision } = card;
  return { id, title, body, template, hidden, createdAt, updatedAt, revision, ...(url ? { url } : {}) };
}
