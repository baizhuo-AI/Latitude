import type {
  AppliedUiChange,
  JsonObject,
  UiChangeSet,
  UiComponentInstance,
  UiPatchOperation,
  UiSurfaceDocumentV2,
} from "./types";
import { CompositionRegistry } from "./registry";

export class UiRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`UI revision conflict: expected ${expected}, current ${actual}`);
    this.name = "UiRevisionConflictError";
  }
}

export class InvalidUiChangeError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid UI change: ${issues.join("; ")}`);
    this.name = "InvalidUiChangeError";
    this.issues = issues;
  }
}

export interface UiDocumentSnapshot {
  document: UiSurfaceDocumentV2;
  changes: readonly AppliedUiChange[];
}

/**
 * Host-owned, deterministic UI ChangeSet engine.
 *
 * The model can propose schema data only. Trusted component code and commands
 * stay in the registry; CAS, validation, inverse generation and rollback happen
 * here before any document becomes visible.
 */
export class UiDocumentEngine {
  private document: UiSurfaceDocumentV2;
  private readonly changes: AppliedUiChange[] = [];

  constructor(
    initial: UiSurfaceDocumentV2,
    private readonly registry: CompositionRegistry,
    existingChanges: readonly AppliedUiChange[] = [],
  ) {
    assertDocument(initial, registry);
    this.document = clone(initial);
    this.changes.push(...existingChanges.map(clone));
  }

  snapshot(): UiDocumentSnapshot {
    return {
      document: clone(this.document),
      changes: this.changes.map(clone),
    };
  }

  apply(change: UiChangeSet): AppliedUiChange {
    if (change.baseRevision !== this.document.revision) {
      throw new UiRevisionConflictError(change.baseRevision, this.document.revision);
    }
    if (!change.id.trim()) throw new InvalidUiChangeError(["change id must not be empty"]);
    if (this.changes.some((existing) => existing.id === change.id)) {
      throw new InvalidUiChangeError([`duplicate change id: ${change.id}`]);
    }
    if (!change.reason.trim()) throw new InvalidUiChangeError(["reason must not be empty"]);
    if (change.operations.length === 0) {
      throw new InvalidUiChangeError(["change must contain at least one operation"]);
    }

    let next = clone(this.document);
    const inverse: UiPatchOperation[] = [];
    for (const operation of change.operations) {
      const result = applyOperation(next, operation, this.registry);
      next = result.document;
      inverse.unshift(result.inverse);
    }
    next.revision += 1;
    next.updatedAt = change.createdAt;
    assertDocument(next, this.registry);

    const receipt: AppliedUiChange = {
      id: change.id,
      actor: change.actor,
      authorization: change.authorization,
      reason: change.reason,
      ...(change.sourceRunId ? { sourceRunId: change.sourceRunId } : {}),
      beforeRevision: this.document.revision,
      afterRevision: next.revision,
      operations: clone(change.operations),
      inverse,
      appliedAt: change.createdAt,
    };
    this.document = next;
    this.changes.push(receipt);
    return clone(receipt);
  }

  rollback(changeId: string, rollbackId: string, at: string): AppliedUiChange {
    const target = this.changes.find((change) => change.id === changeId);
    if (!target) throw new InvalidUiChangeError([`unknown change: ${changeId}`]);
    if (target.rolledBackBy) {
      throw new InvalidUiChangeError([`change ${changeId} was already rolled back`]);
    }
    const receipt = this.apply({
      id: rollbackId,
      baseRevision: this.document.revision,
      actor: "user",
      authorization: "direct_user",
      reason: `Rollback ${changeId}`,
      operations: target.inverse,
      createdAt: at,
    });
    target.rolledBackBy = rollbackId;
    const storedRollback = this.changes.find((change) => change.id === rollbackId);
    if (storedRollback) storedRollback.rollbackOf = changeId;
    receipt.rollbackOf = changeId;
    return receipt;
  }
}

function applyOperation(
  document: UiSurfaceDocumentV2,
  operation: UiPatchOperation,
  registry: CompositionRegistry,
): { document: UiSurfaceDocumentV2; inverse: UiPatchOperation } {
  const next = clone(document);
  if (operation.op === "add") {
    if (next.components.some((component) => component.id === operation.component.id)) {
      throw new InvalidUiChangeError([`component already exists: ${operation.component.id}`]);
    }
    const issues = registry.validateComponent(operation.component);
    if (issues.length) throw new InvalidUiChangeError(issues);
    next.components.push(clone(operation.component));
    return {
      document: sortComponents(next),
      inverse: { op: "remove", componentId: operation.component.id },
    };
  }

  const index = next.components.findIndex((component) => component.id === operation.componentId);
  if (index < 0) throw new InvalidUiChangeError([`unknown component: ${operation.componentId}`]);
  const current = next.components[index];

  if (operation.op === "remove") {
    next.components.splice(index, 1);
    return { document: next, inverse: { op: "add", component: current } };
  }
  if (operation.op === "move") {
    const inverse: UiPatchOperation = {
      op: "move",
      componentId: current.id,
      slot: current.slot,
      order: current.order,
    };
    current.slot = operation.slot;
    current.order = operation.order;
    assertComponent(current, registry);
    return { document: sortComponents(next), inverse };
  }
  if (operation.op === "resize") {
    const inverse: UiPatchOperation = {
      op: "resize",
      componentId: current.id,
      columnSpan: current.grid.columnSpan,
      rowSpan: current.grid.rowSpan,
    };
    current.grid = {
      columnSpan: operation.columnSpan,
      rowSpan: operation.rowSpan,
    };
    assertComponent(current, registry);
    return { document: next, inverse };
  }
  if (operation.op === "setProps") {
    const inverse: UiPatchOperation = {
      op: "setProps",
      componentId: current.id,
      props: clone(current.props),
    };
    current.props = clone(operation.props);
    assertComponent(current, registry);
    return { document: next, inverse };
  }
  if (operation.op === "bindAction") {
    const previous = current.actions[operation.event] ?? null;
    const inverse: UiPatchOperation = {
      op: "bindAction",
      componentId: current.id,
      event: operation.event,
      commandId: previous,
    };
    if (operation.commandId === null) delete current.actions[operation.event];
    else current.actions[operation.event] = operation.commandId;
    assertComponent(current, registry);
    return { document: next, inverse };
  }
  const inverse: UiPatchOperation = {
    op: "setVisibility",
    componentId: current.id,
    visible: current.visible,
  };
  current.visible = operation.visible;
  return { document: next, inverse };
}

function assertDocument(document: UiSurfaceDocumentV2, registry: CompositionRegistry): void {
  const issues = registry.validateDocument(document);
  if (issues.length) throw new InvalidUiChangeError(issues);
}

function assertComponent(component: UiComponentInstance, registry: CompositionRegistry): void {
  const issues = registry.validateComponent(component);
  if (issues.length) throw new InvalidUiChangeError(issues);
}

function sortComponents(document: UiSurfaceDocumentV2): UiSurfaceDocumentV2 {
  document.components.sort((left, right) =>
    left.slot === right.slot
      ? left.order - right.order || left.id.localeCompare(right.id)
      : left.slot.localeCompare(right.slot),
  );
  return document;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Useful for command adapters that need a narrow immutable props view. */
export function mergeJsonProps(current: JsonObject, patch: JsonObject): JsonObject {
  return { ...clone(current), ...clone(patch) };
}
