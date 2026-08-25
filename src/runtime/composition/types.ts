/** JSON values are the only data an AI-authored UI document may carry. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type UiChangeActor = "user" | "model" | "system";
export type UiAuthorization = "automatic" | "preauthorized" | "direct_user";

export interface UiComponentInstance {
  id: string;
  /** Stable key resolved through trusted, host-owned component code. */
  type: string;
  moduleId: string;
  slot: string;
  order: number;
  visible: boolean;
  grid: {
    columnSpan: number;
    rowSpan: number;
  };
  props: JsonObject;
  /** UI event name -> trusted command id. */
  actions: Record<string, string>;
}

export interface UiSurfaceDocumentV2 {
  schemaVersion: 2;
  id: string;
  revision: number;
  title: string;
  components: UiComponentInstance[];
  updatedAt: string;
}

export type UiPatchOperation =
  | { op: "add"; component: UiComponentInstance }
  | { op: "remove"; componentId: string }
  | {
      op: "move";
      componentId: string;
      slot: string;
      order: number;
    }
  | {
      op: "resize";
      componentId: string;
      columnSpan: number;
      rowSpan: number;
    }
  | {
      op: "setProps";
      componentId: string;
      props: JsonObject;
    }
  | {
      op: "bindAction";
      componentId: string;
      event: string;
      commandId: string | null;
    }
  | { op: "setVisibility"; componentId: string; visible: boolean };

export interface UiChangeSet {
  id: string;
  baseRevision: number;
  actor: UiChangeActor;
  authorization: UiAuthorization;
  reason: string;
  /** Optional provenance for a successful Agent run or persisted Domain resource. */
  sourceRunId?: string;
  operations: UiPatchOperation[];
  createdAt: string;
}

export interface AppliedUiChange {
  id: string;
  actor: UiChangeActor;
  authorization: UiAuthorization;
  reason: string;
  sourceRunId?: string;
  beforeRevision: number;
  afterRevision: number;
  operations: UiPatchOperation[];
  inverse: UiPatchOperation[];
  appliedAt: string;
  rollbackOf?: string;
  rolledBackBy?: string;
}

export interface ComponentDefinition {
  type: string;
  moduleId: string;
  slots: readonly string[];
  /** Known event names this component can bind to commands. */
  events: readonly string[];
  /**
   * Optional event-level command allowlist.  A command merely being registered
   * is not enough: production surfaces use this map to prevent, for example,
   * binding an anchor mutation to a feed-feedback event.
   */
  eventCommands?: Readonly<Record<string, readonly string[]>>;
  /** Production layouts may narrow the generic 12-column engine. */
  columnSpans?: readonly number[];
  rowSpans?: readonly number[];
  validateProps?: (props: JsonObject) => readonly string[];
}

export interface CommandDefinition {
  id: string;
  moduleId: string;
  risk: "read" | "reversible-write" | "external-write" | "destructive";
  description: string;
}

export interface ModuleDefinition {
  id: string;
  title: string;
  version: string;
}
