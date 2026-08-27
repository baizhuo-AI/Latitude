import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardPresentation } from "../../dimension/types";
import {
  BROWSER_LAYOUT_COMPONENT_IDS,
  assertBrowserProductionOperations,
  browserComponentSpec,
  componentProps,
  createBrowserCompositionRegistry,
  diffBrowserUiDocuments,
  layoutV1ToUiSurfaceV2,
  migrateLegacyBrowserSurface,
  readPresentation,
  uiSurfaceV2ToLayoutV1,
} from "../../runtime/composition/browserProduction";
import type { CompositionRegistry } from "../../runtime/composition/registry";
import {
  InvalidUiChangeError,
  UiDocumentEngine,
  type UiDocumentSnapshot,
} from "../../runtime/composition/uiDocument";
import type {
  AppliedUiChange,
  JsonObject,
  UiPatchOperation,
  UiSurfaceDocumentV2,
} from "../../runtime/composition/types";
import type { LayoutDocumentV1, LayoutSpan } from "../../runtime/layout/types";
import { validateLayoutDocument } from "../../runtime/layout/validate";

export const BROWSER_UI_CHANGESET_EVENT = "latitude:ui-change-set";
export const BROWSER_UI_PROFILE_RESTORED_EVENT = "latitude:ui-profile-restored";
const STORAGE_PREFIX_V1 = "latitude.browser-ui-composition.v1";
const STORAGE_PREFIX_V2 = "latitude.browser-ui-composition.v2";
const ALLOWED_SPANS = new Set<LayoutSpan>([4, 5, 7, 12]);
const COMPANION_POSITION_STORAGE_KEY = "latitude.secretary-companion.v1";

export interface BrowserUiCardPatch {
  hidden?: boolean;
  span?: LayoutSpan;
  title?: string;
  actions?: Record<string, string | null>;
}

export type BrowserUiDraftOperation =
  | { op: "set_visibility"; componentId: string; visible: boolean }
  | { op: "move" | "set_order"; componentId: string; order: number }
  | {
      op: "resize" | "set_span";
      componentId: string;
      columnSpan?: number;
      rowSpan?: number;
      span?: number;
    }
  | {
      op: "set_props";
      componentId: string;
      props?: JsonObject;
      presentation?: Partial<CardPresentation>;
    }
  | { op: "set_title"; componentId: string; title: string }
  | {
      op: "bind_action";
      componentId: string;
      event: string;
      commandId: string | null;
    };

/**
 * Browser/Agent input schema. Legacy cards/order remain an import adapter;
 * every accepted draft is translated into V2 engine operations before commit.
 */
export interface BrowserUiChangeSetDraft {
  operations?: BrowserUiDraftOperation[];
  cards?: Record<string, BrowserUiCardPatch>;
  orderedCardIds?: string[];
  /** Mandatory CAS boundary for Agent changes; direct user edits use current revision. */
  baseRevision?: number;
  /** Mandatory production target for Agent changes. */
  surfaceId?: string;
  reason: string;
  actor: "user" | "agent";
  sourceRunId?: string;
}

/** Historical V1 shape retained only for restore/migration. */
interface LegacyBrowserUiChangeSet {
  id: string;
  createdAt: string;
  operation: "apply" | "rollback";
  reason: string;
  actor: "user" | "agent";
  sourceRunId?: string;
  rollbackOf?: string;
  before: LayoutDocumentV1<string, CardPresentation>;
  after: LayoutDocumentV1<string, CardPresentation>;
}

interface PersistedCompositionV1 {
  current: LayoutDocumentV1<string, CardPresentation>;
  history: LegacyBrowserUiChangeSet[];
}

interface PersistedCompositionV2 {
  document: UiSurfaceDocumentV2;
  changes: AppliedUiChange[];
}

export interface BrowserUiCompositionBackupV1 {
  format: "latitude.browser-ui-composition@0.1";
  exportedAt: string;
  documents: Record<string, PersistedCompositionV1>;
}

export interface BrowserUiCompositionBackupV2 {
  format: "latitude.browser-ui-composition@0.2";
  exportedAt: string;
  documents: Record<string, PersistedCompositionV2>;
}

export type BrowserUiCompositionBackup =
  | BrowserUiCompositionBackupV1
  | BrowserUiCompositionBackupV2;

export type BrowserUiChangeSet = AppliedUiChange;

export interface BrowserUiCompositionController {
  layout: LayoutDocumentV1<string, CardPresentation>;
  document: UiSurfaceDocumentV2;
  registry: CompositionRegistry;
  history: AppliedUiChange[];
  applyChangeSet: (draft: BrowserUiChangeSetDraft) => AppliedUiChange;
  rollbackChangeSet: (changeSetId: string) => AppliedUiChange | null;
  resetToProductLayout: () => AppliedUiChange | null;
}

export function useBrowserUiComposition(
  baseLayout: LayoutDocumentV1<string, CardPresentation>,
): BrowserUiCompositionController {
  const registry = useMemo(() => createBrowserCompositionRegistry(), []);
  const initial = useMemo(
    () => readPersisted(baseLayout, registry),
    [baseLayout.id, registry],
  );
  const engineRef = useRef(
    new UiDocumentEngine(initial.document, registry, initial.changes),
  );
  const [snapshot, setSnapshot] = useState<UiDocumentSnapshot>(() =>
    engineRef.current.snapshot(),
  );

  const replaceEngine = useCallback(
    (next: PersistedCompositionV2) => {
      const engine = new UiDocumentEngine(next.document, registry, next.changes);
      engineRef.current = engine;
      setSnapshot(engine.snapshot());
    },
    [registry],
  );

  useEffect(() => {
    if (snapshot.document.id === baseLayout.id) return;
    replaceEngine(readPersisted(baseLayout, registry));
  }, [baseLayout, registry, replaceEngine, snapshot.document.id]);

  const commitSnapshot = useCallback(() => {
    const next = engineRef.current.snapshot();
    setSnapshot(next);
    persistV2(baseLayout.id, {
      document: next.document,
      changes: [...next.changes],
    });
    return next;
  }, [baseLayout.id]);

  const applyChangeSet = useCallback(
    (draft: BrowserUiChangeSetDraft) => {
      const current = engineRef.current.snapshot().document;
      if (draft.actor === "agent" && draft.baseRevision === undefined) {
        throw new TypeError("Agent UI ChangeSet requires baseRevision");
      }
      if (draft.actor === "agent" && draft.surfaceId !== current.id) {
        throw new TypeError(
          `Agent UI ChangeSet targets ${draft.surfaceId || "no surface"}, current surface is ${current.id}`,
        );
      }
      const operations = operationsFromDraft(current, draft);
      assertBrowserProductionOperations(operations);
      const createdAt = new Date().toISOString();
      const receipt = engineRef.current.apply({
        id: createId(draft.actor === "agent" ? "ui-agent" : "ui-user"),
        baseRevision:
          draft.actor === "agent" ? Number(draft.baseRevision) : current.revision,
        actor: draft.actor === "agent" ? "model" : "user",
        authorization: draft.actor === "agent" ? "preauthorized" : "direct_user",
        reason: draft.reason.trim() || "调整桌面",
        ...(draft.sourceRunId ? { sourceRunId: draft.sourceRunId } : {}),
        operations,
        createdAt,
      });
      commitSnapshot();
      return receipt;
    },
    [commitSnapshot],
  );

  const rollbackChangeSet = useCallback(
    (changeSetId: string) => {
      const current = engineRef.current.snapshot();
      if (!current.changes.some((entry) => entry.id === changeSetId)) return null;
      const receipt = engineRef.current.rollback(
        changeSetId,
        createId("ui-rollback"),
        new Date().toISOString(),
      );
      commitSnapshot();
      return receipt;
    },
    [commitSnapshot],
  );

  const resetToProductLayout = useCallback(() => {
    const current = engineRef.current.snapshot().document;
    const target = layoutV1ToUiSurfaceV2(baseLayout, new Date().toISOString());
    const operations = diffBrowserUiDocuments(current, target);
    if (operations.length === 0) return null;
    assertBrowserProductionOperations(operations);
    const createdAt = new Date().toISOString();
    const receipt = engineRef.current.apply({
      id: createId("ui-reset"),
      baseRevision: current.revision,
      actor: "user",
      authorization: "direct_user",
      reason: "恢复产品默认桌面",
      operations,
      createdAt,
    });
    commitSnapshot();
    return receipt;
  }, [baseLayout, commitSnapshot]);

  useEffect(() => {
    const listener = (event: Event) => {
      const draft = (event as CustomEvent<BrowserUiChangeSetDraft>).detail;
      if (!draft || draft.actor !== "agent") return;
      try {
        applyChangeSet(draft);
      } catch {
        // Invalid or stale AI changes never become visible or persistent.
      }
    };
    window.addEventListener(BROWSER_UI_CHANGESET_EVENT, listener);
    return () => window.removeEventListener(BROWSER_UI_CHANGESET_EVENT, listener);
  }, [applyChangeSet]);

  useEffect(() => {
    const reload = () => replaceEngine(readPersisted(baseLayout, registry));
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    return () => window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
  }, [baseLayout, registry, replaceEngine]);

  const latest = snapshot.changes[snapshot.changes.length - 1];
  const layout = useMemo(
    () => uiSurfaceV2ToLayoutV1(snapshot.document, baseLayout, latest?.id),
    [baseLayout, latest?.id, snapshot.document],
  );
  return {
    layout,
    document: snapshot.document,
    registry,
    history: [...snapshot.changes],
    applyChangeSet,
    rollbackChangeSet,
    resetToProductLayout,
  };
}

export function exportBrowserUiCompositionBackup(): BrowserUiCompositionBackup {
  const documents: Record<string, PersistedCompositionV2> = {};
  const v2BaseIds = new Set<string>();
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(`${STORAGE_PREFIX_V2}:`)) continue;
    const baseId = key.slice(STORAGE_PREFIX_V2.length + 1);
    try {
      assertBaseId(baseId);
      const parsed = JSON.parse(
        window.localStorage.getItem(key) ?? "null",
      ) as PersistedCompositionV2;
      documents[baseId] = validatePersistedV2(
        parsed,
        createBrowserCompositionRegistry(),
      );
      v2BaseIds.add(baseId);
    } catch (error) {
      throw new TypeError(
        `Invalid owned V2 UI composition ${baseId || "(empty id)"}: ${readError(error)}`,
      );
    }
  }
  const legacy = exportLegacyBackup();
  const legacyBaseIds = Object.keys(legacy.documents);
  const unshadowedLegacy = legacyBaseIds.filter((baseId) => !v2BaseIds.has(baseId));
  if (Object.keys(documents).length > 0) {
    if (unshadowedLegacy.length > 0) {
      throw new TypeError(
        `UI composition storage mixes V2 with unshadowed V1 documents: ${unshadowedLegacy.join(", ")}`,
      );
    }
    return {
      format: "latitude.browser-ui-composition@0.2",
      exportedAt: new Date().toISOString(),
      documents,
    };
  }
  if (legacyBaseIds.length > 0) return legacy;
  return {
    format: "latitude.browser-ui-composition@0.2",
    exportedAt: new Date().toISOString(),
    documents: {},
  };
}

export function restoreBrowserUiCompositionBackup(value: unknown): void {
  const backup = validateBrowserUiCompositionBackup(value);
  clearBrowserUiCompositionBackup(false);
  const prefix = backup.format === "latitude.browser-ui-composition@0.2"
    ? STORAGE_PREFIX_V2
    : STORAGE_PREFIX_V1;
  for (const [baseId, document] of Object.entries(backup.documents)) {
    window.localStorage.setItem(`${prefix}:${baseId}`, JSON.stringify(document));
  }
  window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT));
}

/** Pure validation boundary used before a composite profile stages any service. */
export function validateBrowserUiCompositionBackup(
  value: unknown,
): BrowserUiCompositionBackup {
  if (!isRecord(value)) throw new TypeError("Unsupported browser UI composition backup");
  if (
    value.format !== "latitude.browser-ui-composition@0.1" &&
    value.format !== "latitude.browser-ui-composition@0.2"
  ) {
    throw new TypeError("Unsupported browser UI composition backup");
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    throw new TypeError("UI composition exportedAt is invalid");
  }
  if (!isRecord(value.documents)) throw new TypeError("UI composition documents are missing");
  if (value.format === "latitude.browser-ui-composition@0.2") {
    const registry = createBrowserCompositionRegistry();
    const documents: Record<string, PersistedCompositionV2> = {};
    for (const [baseId, candidate] of Object.entries(value.documents)) {
      assertBaseId(baseId);
      documents[baseId] = validatePersistedV2(candidate, registry);
    }
    return { format: value.format, exportedAt: value.exportedAt, documents };
  }
  const documents: Record<string, PersistedCompositionV1> = {};
  for (const [baseId, candidate] of Object.entries(value.documents)) {
    assertBaseId(baseId);
    documents[baseId] = validatePersistedV1(candidate, baseId);
  }
  return { format: value.format, exportedAt: value.exportedAt, documents };
}

export function clearBrowserUiCompositionBackup(notify = true): void {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (
      key?.startsWith(`${STORAGE_PREFIX_V1}:`) ||
      key?.startsWith(`${STORAGE_PREFIX_V2}:`)
    ) {
      keys.push(key);
    }
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
  if (notify) window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT));
}

export function dispatchAgentUiChangeSet(draft: BrowserUiChangeSetDraft): void {
  if (draft.actor !== "agent") throw new TypeError("Agent UI ChangeSet must use actor=agent");
  window.dispatchEvent(new CustomEvent(BROWSER_UI_CHANGESET_EVENT, { detail: draft }));
}

export function uiChangeSetFromAgentRun(
  run: Record<string, unknown>,
): BrowserUiChangeSetDraft | null {
  const result = run.result;
  const direct = run.uiChangeSet;
  const nested = isRecord(result) ? result.uiChangeSet : undefined;
  const candidate = direct ?? nested;
  if (!isRecord(candidate) || typeof candidate.reason !== "string") return null;
  const operations = parseBrowserUiDraftOperations(candidate.operations);
  return {
    reason: candidate.reason,
    actor: "agent",
    ...(typeof candidate.domainNodeId === "string"
      ? { sourceRunId: candidate.domainNodeId }
      : typeof candidate.sourceRunId === "string"
        ? { sourceRunId: candidate.sourceRunId }
        : {}),
    ...(typeof candidate.baseRevision === "number" && Number.isInteger(candidate.baseRevision)
      ? { baseRevision: candidate.baseRevision }
      : {}),
    ...(typeof candidate.surfaceId === "string"
      ? { surfaceId: candidate.surfaceId }
      : typeof candidate.baseLayoutId === "string"
        ? { surfaceId: candidate.baseLayoutId }
        : {}),
    ...(operations.length ? { operations } : {}),
    ...(!operations.length && isRecord(candidate.cards)
      ? { cards: candidate.cards as unknown as Record<string, BrowserUiCardPatch> }
      : {}),
    ...(!operations.length && Array.isArray(candidate.orderedCardIds)
      ? {
          orderedCardIds: candidate.orderedCardIds.filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
  };
}

export function parseBrowserUiDraftOperations(value: unknown): BrowserUiDraftOperation[] {
  return Array.isArray(value)
    ? value.map(parseDraftOperation).filter(isDraftOperation)
    : [];
}

function operationsFromDraft(
  current: UiSurfaceDocumentV2,
  draft: BrowserUiChangeSetDraft,
): UiPatchOperation[] {
  const operations: UiPatchOperation[] = [];
  const componentById = new Map(current.components.map((component) => [component.id, component]));
  const workingProps = new Map(
    current.components.map((component) => [component.id, structuredClone(component.props)]),
  );
  let order = current.components
    .filter((component) => BROWSER_LAYOUT_COMPONENT_IDS.includes(
      component.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
    ))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((component) => component.id);

  const reorder = (componentId: string, target: number) => {
    if (!Number.isInteger(target) || target < 0 || target >= order.length) {
      throw new TypeError(`UI order must be from 0 to ${order.length - 1}`);
    }
    if (!BROWSER_LAYOUT_COMPONENT_IDS.includes(
      componentId as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
    )) {
      throw new TypeError(`Browser overlay component cannot move: ${componentId}`);
    }
    if (order.indexOf(componentId) === target) return;
    order = order.filter((id) => id !== componentId);
    order.splice(target, 0, componentId);
    order.forEach((id, nextOrder) => {
      const component = componentById.get(id)!;
      operations.push({
        op: "move",
        componentId: id,
        slot: component.slot,
        order: nextOrder,
      });
    });
  };

  if (draft.operations?.length) {
    for (const operation of draft.operations) {
      const component = componentById.get(operation.componentId);
      if (!component) throw new TypeError(`Unknown Browser component: ${operation.componentId}`);
      const spec = browserComponentSpec(operation.componentId);
      if (
        spec?.surface === "fixed-module" &&
        operation.op !== "set_visibility" &&
        operation.op !== "bind_action"
      ) {
        throw new TypeError(
          `Browser fixed module ${operation.componentId} only allows visibility and trusted action bindings`,
        );
      }
      if (operation.op === "set_visibility") {
        if (component.visible !== operation.visible) {
          operations.push({
            op: "setVisibility",
            componentId: operation.componentId,
            visible: operation.visible,
          });
        }
      } else if (operation.op === "move" || operation.op === "set_order") {
        reorder(operation.componentId, operation.order);
      } else if (operation.op === "resize" || operation.op === "set_span") {
        const columnSpan = operation.columnSpan ?? operation.span;
        if (typeof columnSpan !== "number" || !ALLOWED_SPANS.has(columnSpan as LayoutSpan)) {
          throw new TypeError(`Unsupported card span: ${String(columnSpan)}`);
        }
        const rowSpan = operation.rowSpan ?? 1;
        if (
          component.grid.columnSpan !== columnSpan ||
          component.grid.rowSpan !== rowSpan
        ) {
          operations.push({
            op: "resize",
            componentId: operation.componentId,
            columnSpan,
            rowSpan,
          });
        }
      } else if (operation.op === "set_title") {
        const presentation = readPresentation(workingProps.get(operation.componentId)!);
        const props = componentProps(String(component.props.bindingRef), {
          ...presentation,
          title: operation.title.trim(),
        });
        workingProps.set(operation.componentId, props);
        if (JSON.stringify(component.props) !== JSON.stringify(props)) {
          operations.push({ op: "setProps", componentId: operation.componentId, props });
        }
      } else if (operation.op === "set_props") {
        if (!operation.props && !operation.presentation) {
          throw new TypeError("set_props requires props or a presentation patch");
        }
        const props = operation.props
          ? structuredClone(operation.props)
          : mergePresentationProps(
              workingProps.get(operation.componentId)!,
              operation.presentation ?? {},
            );
        workingProps.set(operation.componentId, props);
        if (JSON.stringify(component.props) !== JSON.stringify(props)) {
          operations.push({ op: "setProps", componentId: operation.componentId, props });
        }
      } else if (operation.op === "bind_action") {
        if ((component.actions[operation.event] ?? null) !== operation.commandId) {
          operations.push({
            op: "bindAction",
            componentId: operation.componentId,
            event: operation.event,
            commandId: operation.commandId,
          });
        }
      } else {
        throw new TypeError("Unsupported Browser UI operation");
      }
    }
  } else {
    const patches = draft.cards ?? {};
    for (const [id, patch] of Object.entries(patches)) {
      const component = componentById.get(id);
      if (!component) throw new TypeError(`Unknown Browser component: ${id}`);
      const spec = browserComponentSpec(id);
      if (
        spec?.surface === "fixed-module" &&
        (patch.span !== undefined || patch.title !== undefined)
      ) {
        throw new TypeError(
          `Browser fixed module ${id} has no card presentation or layout span`,
        );
      }
      if (patch.hidden !== undefined) {
        if (typeof patch.hidden !== "boolean") throw new TypeError(`hidden must be boolean for ${id}`);
        if (component.visible === patch.hidden) {
          operations.push({ op: "setVisibility", componentId: id, visible: !patch.hidden });
        }
      }
      if (patch.span !== undefined) {
        if (!ALLOWED_SPANS.has(patch.span)) throw new TypeError(`Unsupported card span: ${patch.span}`);
        if (component.grid.columnSpan !== patch.span) {
          operations.push({
            op: "resize",
            componentId: id,
            columnSpan: patch.span,
            rowSpan: 1,
          });
        }
      }
      if (patch.title !== undefined) {
        if (!patch.title.trim()) throw new TypeError(`title must not be empty for ${id}`);
        const presentation = readPresentation(workingProps.get(id)!);
        if (presentation.title !== patch.title.trim()) {
          const props = componentProps(String(component.props.bindingRef), {
            ...presentation,
            title: patch.title.trim(),
          });
          workingProps.set(id, props);
          operations.push({ op: "setProps", componentId: id, props });
        }
      }
      for (const [event, commandId] of Object.entries(patch.actions ?? {})) {
        if ((component.actions[event] ?? null) !== commandId) {
          operations.push({ op: "bindAction", componentId: id, event, commandId });
        }
      }
    }
    if (draft.orderedCardIds) {
      const target = draft.orderedCardIds;
      if (
        target.length !== BROWSER_LAYOUT_COMPONENT_IDS.length ||
        new Set(target).size !== BROWSER_LAYOUT_COMPONENT_IDS.length ||
        target.some((id) => !BROWSER_LAYOUT_COMPONENT_IDS.includes(
          id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
        ))
      ) {
        throw new TypeError("orderedCardIds must contain each registered layout card exactly once");
      }
      order = [...target];
      order.forEach((id, nextOrder) => {
        const component = componentById.get(id)!;
        if (component.order !== nextOrder) {
          operations.push({
            op: "move",
            componentId: id,
            slot: component.slot,
            order: nextOrder,
          });
        }
      });
    }
  }
  if (operations.length === 0) throw new InvalidUiChangeError(["change has no effective operation"]);
  return operations;
}

function mergePresentationProps(
  current: JsonObject,
  patch: Partial<CardPresentation>,
): JsonObject {
  const presentation = readPresentation(current);
  const next: CardPresentation = {
    ...presentation,
    ...structuredClone(patch),
    ...(patch.tape && presentation.tape
      ? { tape: { ...presentation.tape, ...patch.tape } }
      : {}),
  };
  return componentProps(String(current.bindingRef), next);
}

function readPersisted(
  baseLayout: LayoutDocumentV1<string, CardPresentation>,
  registry: CompositionRegistry,
): PersistedCompositionV2 {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX_V2}:${baseLayout.id}`);
    if (raw) {
      const validated = validatePersistedV2(JSON.parse(raw), registry);
      const normalized = normalizeRuntimeSurface(validated);
      if (normalized.document.components.length !== validated.document.components.length) {
        persistV2(baseLayout.id, normalized);
      }
      return normalized;
    }
  } catch {
    // Fall through to the legacy migration or product layout.
  }
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX_V1}:${baseLayout.id}`);
    if (raw) {
      const legacy = validatePersistedV1(JSON.parse(raw), baseLayout.id);
      const migrated = migratePersistedV1(
        baseLayout,
        legacy,
        registry,
        readLegacyCompanionVisible(),
      );
      persistV2(baseLayout.id, migrated);
      return migrated;
    }
  } catch {
    // A damaged preference never replaces the product layout.
  }
  return {
    document: layoutV1ToUiSurfaceV2(
      baseLayout,
      new Date().toISOString(),
      readLegacyCompanionVisible(),
    ),
    changes: [],
  };
}

function normalizeRuntimeSurface(
  persisted: PersistedCompositionV2,
): PersistedCompositionV2 {
  return {
    document: migrateLegacyBrowserSurface(
      persisted.document,
      readLegacyCompanionVisible(),
    ),
    changes: [...persisted.changes],
  };
}

function migratePersistedV1(
  baseLayout: LayoutDocumentV1<string, CardPresentation>,
  legacy: PersistedCompositionV1,
  registry: CompositionRegistry,
  companionVisible: boolean,
): PersistedCompositionV2 {
  const initialLayout = legacy.history[0]?.before ?? baseLayout;
  const engine = new UiDocumentEngine(
    layoutV1ToUiSurfaceV2(
      initialLayout,
      new Date().toISOString(),
      companionVisible,
    ),
    registry,
  );
  for (const entry of legacy.history) {
    const current = engine.snapshot().document;
    const target = layoutV1ToUiSurfaceV2(
      entry.after,
      entry.createdAt,
      companionVisible,
    );
    const operations = diffBrowserUiDocuments(current, target);
    if (!operations.length) continue;
    engine.apply({
      id: entry.id,
      baseRevision: current.revision,
      actor: entry.actor === "agent" ? "model" : "user",
      authorization: entry.actor === "agent" ? "preauthorized" : "direct_user",
      reason: entry.reason,
      ...(entry.sourceRunId ? { sourceRunId: entry.sourceRunId } : {}),
      operations,
      createdAt: entry.createdAt,
    });
  }
  const current = engine.snapshot().document;
  const expected = layoutV1ToUiSurfaceV2(
    legacy.current,
    new Date().toISOString(),
    companionVisible,
  );
  const remainder = diffBrowserUiDocuments(current, expected);
  if (remainder.length) {
    engine.apply({
      id: createId("ui-migrate"),
      baseRevision: current.revision,
      actor: "system",
      authorization: "automatic",
      reason: "迁移旧版 Browser 组件状态",
      operations: remainder,
      createdAt: new Date().toISOString(),
    });
  }
  const snapshot = engine.snapshot();
  return { document: snapshot.document, changes: [...snapshot.changes] };
}

function validatePersistedV2(
  value: unknown,
  registry: CompositionRegistry,
): PersistedCompositionV2 {
  if (!isRecord(value) || !isRecord(value.document) || !Array.isArray(value.changes)) {
    throw new TypeError("Invalid V2 UI composition document");
  }
  const document = value.document as unknown as UiSurfaceDocumentV2;
  const changes = value.changes as unknown as AppliedUiChange[];
  for (const change of changes) {
    if (
      !change ||
      typeof change.id !== "string" ||
      typeof change.reason !== "string" ||
      (change.sourceRunId !== undefined && typeof change.sourceRunId !== "string") ||
      !Array.isArray(change.operations) ||
      !Array.isArray(change.inverse)
    ) {
      throw new TypeError("Invalid V2 UI composition history");
    }
    assertBrowserProductionOperations(change.operations);
    assertBrowserProductionOperations(change.inverse);
  }
  const validated = new UiDocumentEngine(document, registry, changes).snapshot();
  return { document: validated.document, changes: [...validated.changes] };
}

function validatePersistedV1(value: unknown, baseId: string): PersistedCompositionV1 {
  if (!isRecord(value) || !Array.isArray(value.history)) {
    throw new TypeError(`Invalid UI composition document: ${baseId}`);
  }
  if (!validateLayoutDocument(value.current).valid) {
    throw new TypeError(`Invalid UI composition layout: ${baseId}`);
  }
  for (const entry of value.history) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.reason !== "string" ||
      (entry.actor !== "user" && entry.actor !== "agent") ||
      (entry.operation !== "apply" && entry.operation !== "rollback") ||
      !validateLayoutDocument(entry.before).valid ||
      !validateLayoutDocument(entry.after).valid
    ) {
      throw new TypeError(`Invalid UI composition history: ${baseId}`);
    }
  }
  return value as unknown as PersistedCompositionV1;
}

function exportLegacyBackup(): BrowserUiCompositionBackupV1 {
  const documents: Record<string, PersistedCompositionV1> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(`${STORAGE_PREFIX_V1}:`)) continue;
    const baseId = key.slice(STORAGE_PREFIX_V1.length + 1);
    try {
      assertBaseId(baseId);
      documents[baseId] = validatePersistedV1(
        JSON.parse(window.localStorage.getItem(key) ?? "null"),
        baseId,
      );
    } catch (error) {
      throw new TypeError(
        `Invalid owned V1 UI composition ${baseId || "(empty id)"}: ${readError(error)}`,
      );
    }
  }
  return {
    format: "latitude.browser-ui-composition@0.1",
    exportedAt: new Date().toISOString(),
    documents,
  };
}

function persistV2(baseId: string, value: PersistedCompositionV2): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX_V2}:${baseId}`, JSON.stringify(value));
  } catch {
    // Session state still works when private browsing refuses persistence.
  }
}

function parseDraftOperation(value: unknown): BrowserUiDraftOperation | null {
  if (!isRecord(value) || typeof value.op !== "string" || typeof value.componentId !== "string") {
    return null;
  }
  if (value.op === "set_visibility" && typeof value.visible === "boolean") {
    return { op: value.op, componentId: value.componentId, visible: value.visible };
  }
  if ((value.op === "move" || value.op === "set_order") && typeof value.order === "number") {
    return { op: value.op, componentId: value.componentId, order: value.order };
  }
  if (value.op === "resize" || value.op === "set_span") {
    return {
      op: value.op,
      componentId: value.componentId,
      ...(typeof value.columnSpan === "number" ? { columnSpan: value.columnSpan } : {}),
      ...(typeof value.rowSpan === "number" ? { rowSpan: value.rowSpan } : {}),
      ...(typeof value.span === "number" ? { span: value.span } : {}),
    };
  }
  if (value.op === "set_title" && typeof value.title === "string") {
    return { op: value.op, componentId: value.componentId, title: value.title };
  }
  if (value.op === "set_props") {
    if (!isRecord(value.props) && !isRecord(value.presentation)) return null;
    return {
      op: value.op,
      componentId: value.componentId,
      ...(isRecord(value.props) ? { props: value.props as unknown as JsonObject } : {}),
      ...(isRecord(value.presentation)
        ? { presentation: value.presentation as unknown as Partial<CardPresentation> }
        : {}),
    };
  }
  if (
    value.op === "bind_action" &&
    typeof value.event === "string" &&
    (typeof value.commandId === "string" || value.commandId === null)
  ) {
    return {
      op: value.op,
      componentId: value.componentId,
      event: value.event,
      commandId: value.commandId,
    };
  }
  return null;
}

function isDraftOperation(
  value: BrowserUiDraftOperation | null,
): value is BrowserUiDraftOperation {
  return value !== null;
}

function assertBaseId(baseId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(baseId)) {
    throw new TypeError("Invalid UI composition document id");
  }
}

function readLegacyCompanionVisible(): boolean {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(COMPANION_POSITION_STORAGE_KEY) ?? "null",
    ) as { hidden?: unknown } | null;
    return value?.hidden !== true;
  } catch {
    return true;
  }
}

function createId(prefix: string): string {
  const suffix = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
