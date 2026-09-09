import type { CardPresentation, NativeCardKind } from "../../dimension/types";
import type {
  LayoutDocumentV1,
  LayoutRegion,
  LayoutSpan,
} from "../layout/types";
import { SEED_LAYOUT_DOCUMENT } from "../layout/seedLayout";
import { CompositionRegistry } from "./registry";
import type {
  JsonObject,
  JsonValue,
  UiComponentInstance,
  UiPatchOperation,
  UiSurfaceDocumentV2,
} from "./types";

export const BROWSER_COMPOSITION_MODULE_ID = "latitude.browser.desktop";

/** Browser 产品沿用原来的五纸骨架，并在最前面加一张真实活动记录纸。 */
export const BROWSER_PRODUCT_LAYOUT_DOCUMENT = (() => {
  const layout = structuredClone(
    SEED_LAYOUT_DOCUMENT,
  ) as LayoutDocumentV1<NativeCardKind, CardPresentation>;
  layout.id = "latitude-browser-live";
  layout.revision += 1;
  layout.cards.unshift({
    id: "seed-activity",
    region: "activity",
    renderer: "native",
    kind: "activity",
    span: 12,
    binding: "desktop.activity",
    presentation: {
      eyebrow: "真实记录",
      title: "今天做过",
      tilt: -0.25,
      offsetY: 0,
      paper: "plain",
      clip: true,
    },
  });
  layout.arrangement.orderedCardIds.unshift("seed-activity");
  layout.arrangement.rationale.unshift("今天做过置顶：先看真实发生，再谈计划与判断");
  return layout;
})();

export const BROWSER_COMMAND_IDS = {
  feedFeedback: "latitude.feed.feedback",
  activityCapture: "latitude.activity.capture",
  activityEdit: "latitude.activity.edit",
  activityRetract: "latitude.activity.retract",
  activityReflect: "latitude.activity.reflect",
  lineageOpen: "latitude.lineage.open",
  anchorComplete: "latitude.anchor.complete",
  anchorEdit: "latitude.anchor.edit",
  companionChat: "latitude.companion.chat",
  companionReview: "latitude.companion.review",
  companionOutcome: "latitude.companion.outcome",
  controlSearchWeb: "latitude.control.search-web",
  controlRefresh: "latitude.control.refresh",
  agentCancel: "latitude.agent.cancel",
  candidateTouch: "latitude.candidate.touch",
  candidateShape: "latitude.candidate.shape",
  candidateConclude: "latitude.candidate.conclude",
  candidatePark: "latitude.candidate.park",
  threadClose: "latitude.thread.close",
  outcomeSubmit: "latitude.outcome.submit",
  outcomeClose: "latitude.outcome.close",
  diagnosticsDataSafety: "latitude.diagnostics.data-safety",
  diagnosticsClose: "latitude.diagnostics.close",
  dataSafetyExport: "latitude.data-safety.export",
  dataSafetyIntegrity: "latitude.data-safety.integrity",
  dataSafetyRestore: "latitude.data-safety.restore",
  dataSafetyDelete: "latitude.data-safety.delete",
  dataSafetyPurge: "latitude.data-safety.purge",
  dataSafetyRollback: "latitude.data-safety.rollback",
  dataSafetyClose: "latitude.data-safety.close",
  agentSend: "latitude.agent.send",
  navigationPaper: "latitude.navigation.paper",
  navigationClue: "latitude.navigation.clue",
  navigationConstellation: "latitude.navigation.constellation",
  inspectorClose: "latitude.inspector.close",
} as const;

export type BrowserCommandId =
  (typeof BROWSER_COMMAND_IDS)[keyof typeof BROWSER_COMMAND_IDS];

export interface BrowserComponentSpec {
  id: string;
  type: string;
  slot: LayoutRegion | "overlay" | `system-${string}` | `modal-${string}` | "thread";
  surface: "layout-card" | "fixed-module";
  kind?: NativeCardKind;
  bindingRef: string;
  events: Readonly<Record<string, readonly BrowserCommandId[]>>;
  defaultActions: Readonly<Record<string, BrowserCommandId>>;
}

export const BROWSER_LAYOUT_COMPONENT_SPECS = [
  {
    id: "seed-activity",
    type: "latitude.activity",
    slot: "activity",
    kind: "activity",
    surface: "layout-card",
    bindingRef: "desktop.activity",
    events: {
      capture: [BROWSER_COMMAND_IDS.activityCapture],
      edit: [BROWSER_COMMAND_IDS.activityEdit],
      retract: [BROWSER_COMMAND_IDS.activityRetract],
      reflect: [BROWSER_COMMAND_IDS.activityReflect],
      lineage: [BROWSER_COMMAND_IDS.lineageOpen],
    },
    defaultActions: {
      capture: BROWSER_COMMAND_IDS.activityCapture,
      edit: BROWSER_COMMAND_IDS.activityEdit,
      retract: BROWSER_COMMAND_IDS.activityRetract,
      reflect: BROWSER_COMMAND_IDS.activityReflect,
      lineage: BROWSER_COMMAND_IDS.lineageOpen,
    },
  },
  {
    id: "seed-feed",
    type: "latitude.feed",
    slot: "feed",
    kind: "feed",
    surface: "layout-card",
    bindingRef: "desktop.feed",
    events: {
      feedback: [BROWSER_COMMAND_IDS.feedFeedback],
      lineage: [BROWSER_COMMAND_IDS.lineageOpen],
    },
    defaultActions: {
      feedback: BROWSER_COMMAND_IDS.feedFeedback,
      lineage: BROWSER_COMMAND_IDS.lineageOpen,
    },
  },
  {
    id: "seed-schedule",
    type: "latitude.anchors",
    slot: "schedule",
    kind: "anchors",
    surface: "layout-card",
    bindingRef: "desktop.schedule",
    events: {
      complete: [BROWSER_COMMAND_IDS.anchorComplete],
      edit: [BROWSER_COMMAND_IDS.anchorEdit],
      lineage: [BROWSER_COMMAND_IDS.lineageOpen],
    },
    defaultActions: {
      complete: BROWSER_COMMAND_IDS.anchorComplete,
      edit: BROWSER_COMMAND_IDS.anchorEdit,
      lineage: BROWSER_COMMAND_IDS.lineageOpen,
    },
  },
  {
    id: "seed-review-plan",
    type: "latitude.progress",
    slot: "review-plan",
    kind: "progress",
    surface: "layout-card",
    bindingRef: "desktop.reviewPlan",
    events: {},
    defaultActions: {},
  },
  {
    id: "seed-rhythm",
    type: "latitude.chart",
    slot: "rhythm",
    kind: "chart",
    surface: "layout-card",
    bindingRef: "desktop.rhythm",
    events: {},
    defaultActions: {},
  },
  {
    id: "seed-flex",
    type: "latitude.note",
    slot: "flex",
    kind: "note",
    surface: "layout-card",
    bindingRef: "desktop.flex",
    events: {},
    defaultActions: {},
  },
] as const satisfies readonly BrowserComponentSpec[];

export const BROWSER_COMPANION_SPEC = {
  id: "secretary-companion",
  type: "latitude.secretary-companion",
  slot: "overlay",
  surface: "fixed-module",
  bindingRef: "desktop.secretary",
  events: {
    chat: [BROWSER_COMMAND_IDS.companionChat],
    review: [BROWSER_COMMAND_IDS.companionReview],
    outcome: [BROWSER_COMMAND_IDS.companionOutcome],
  },
  defaultActions: {
    chat: BROWSER_COMMAND_IDS.companionChat,
    review: BROWSER_COMMAND_IDS.companionReview,
    outcome: BROWSER_COMMAND_IDS.companionOutcome,
  },
} as const satisfies BrowserComponentSpec;

export const BROWSER_SYSTEM_COMPONENT_IDS = {
  control: "browser-control-strip",
  candidates: "candidate-intervention-strip",
  thread: "browser-thread",
  outcome: "outcome-dialog",
  diagnostics: "diagnostics-dialog",
  dataSafety: "data-safety-dialog",
  commandBar: "command-bar",
  navigation: "dimension-navigation",
  inspector: "source-inspector-dialog",
} as const;

export const BROWSER_SYSTEM_COMPONENT_SPECS = [
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.control,
    type: "latitude.browser-control-strip",
    slot: "system-control",
    surface: "fixed-module",
    bindingRef: "desktop.control",
    events: {
      search: [BROWSER_COMMAND_IDS.controlSearchWeb],
      refresh: [BROWSER_COMMAND_IDS.controlRefresh],
      review: [BROWSER_COMMAND_IDS.companionReview],
      cancel: [BROWSER_COMMAND_IDS.agentCancel],
    },
    defaultActions: {
      search: BROWSER_COMMAND_IDS.controlSearchWeb,
      refresh: BROWSER_COMMAND_IDS.controlRefresh,
      review: BROWSER_COMMAND_IDS.companionReview,
      cancel: BROWSER_COMMAND_IDS.agentCancel,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.candidates,
    type: "latitude.candidate-intervention-strip",
    slot: "system-candidate",
    surface: "fixed-module",
    bindingRef: "desktop.candidates",
    events: {
      touch: [BROWSER_COMMAND_IDS.candidateTouch],
      shape: [BROWSER_COMMAND_IDS.candidateShape],
      conclude: [BROWSER_COMMAND_IDS.candidateConclude],
      park: [BROWSER_COMMAND_IDS.candidatePark],
    },
    defaultActions: {
      touch: BROWSER_COMMAND_IDS.candidateTouch,
      shape: BROWSER_COMMAND_IDS.candidateShape,
      conclude: BROWSER_COMMAND_IDS.candidateConclude,
      park: BROWSER_COMMAND_IDS.candidatePark,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.thread,
    type: "latitude.browser-thread",
    slot: "thread",
    surface: "fixed-module",
    bindingRef: "desktop.thread",
    events: { close: [BROWSER_COMMAND_IDS.threadClose] },
    defaultActions: { close: BROWSER_COMMAND_IDS.threadClose },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.outcome,
    type: "latitude.outcome-dialog",
    slot: "modal-outcome",
    surface: "fixed-module",
    bindingRef: "desktop.outcome",
    events: {
      submit: [BROWSER_COMMAND_IDS.outcomeSubmit],
      close: [BROWSER_COMMAND_IDS.outcomeClose],
    },
    defaultActions: {
      submit: BROWSER_COMMAND_IDS.outcomeSubmit,
      close: BROWSER_COMMAND_IDS.outcomeClose,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.diagnostics,
    type: "latitude.diagnostics-dialog",
    slot: "modal-diagnostics",
    surface: "fixed-module",
    bindingRef: "desktop.diagnostics",
    events: {
      data_safety: [BROWSER_COMMAND_IDS.diagnosticsDataSafety],
      close: [BROWSER_COMMAND_IDS.diagnosticsClose],
    },
    defaultActions: {
      data_safety: BROWSER_COMMAND_IDS.diagnosticsDataSafety,
      close: BROWSER_COMMAND_IDS.diagnosticsClose,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.dataSafety,
    type: "latitude.data-safety-dialog",
    slot: "modal-data-safety",
    surface: "fixed-module",
    bindingRef: "desktop.dataSafety",
    events: {
      export: [BROWSER_COMMAND_IDS.dataSafetyExport],
      integrity: [BROWSER_COMMAND_IDS.dataSafetyIntegrity],
      restore: [BROWSER_COMMAND_IDS.dataSafetyRestore],
      delete: [BROWSER_COMMAND_IDS.dataSafetyDelete],
      purge: [BROWSER_COMMAND_IDS.dataSafetyPurge],
      rollback: [BROWSER_COMMAND_IDS.dataSafetyRollback],
      close: [BROWSER_COMMAND_IDS.dataSafetyClose],
    },
    defaultActions: {
      export: BROWSER_COMMAND_IDS.dataSafetyExport,
      integrity: BROWSER_COMMAND_IDS.dataSafetyIntegrity,
      restore: BROWSER_COMMAND_IDS.dataSafetyRestore,
      delete: BROWSER_COMMAND_IDS.dataSafetyDelete,
      purge: BROWSER_COMMAND_IDS.dataSafetyPurge,
      rollback: BROWSER_COMMAND_IDS.dataSafetyRollback,
      close: BROWSER_COMMAND_IDS.dataSafetyClose,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.commandBar,
    type: "latitude.command-bar",
    slot: "system-command",
    surface: "fixed-module",
    bindingRef: "desktop.commandBar",
    events: { send: [BROWSER_COMMAND_IDS.agentSend] },
    defaultActions: { send: BROWSER_COMMAND_IDS.agentSend },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.navigation,
    type: "latitude.dimension-navigation",
    slot: "system-navigation",
    surface: "fixed-module",
    bindingRef: "desktop.navigation",
    events: {
      paper: [BROWSER_COMMAND_IDS.navigationPaper],
      clue: [BROWSER_COMMAND_IDS.navigationClue],
      constellation: [BROWSER_COMMAND_IDS.navigationConstellation],
    },
    defaultActions: {
      paper: BROWSER_COMMAND_IDS.navigationPaper,
      clue: BROWSER_COMMAND_IDS.navigationClue,
      constellation: BROWSER_COMMAND_IDS.navigationConstellation,
    },
  },
  {
    id: BROWSER_SYSTEM_COMPONENT_IDS.inspector,
    type: "latitude.source-inspector-dialog",
    slot: "modal-inspector",
    surface: "fixed-module",
    bindingRef: "desktop.inspector",
    events: { close: [BROWSER_COMMAND_IDS.inspectorClose] },
    defaultActions: { close: BROWSER_COMMAND_IDS.inspectorClose },
  },
] as const satisfies readonly BrowserComponentSpec[];

export const BROWSER_COMPONENT_SPECS = [
  ...BROWSER_LAYOUT_COMPONENT_SPECS,
  BROWSER_COMPANION_SPEC,
  ...BROWSER_SYSTEM_COMPONENT_SPECS,
] as const satisfies readonly BrowserComponentSpec[];

export const BROWSER_LAYOUT_COMPONENT_IDS = BROWSER_LAYOUT_COMPONENT_SPECS.map(
  (component) => component.id,
);

const LEGACY_BROWSER_LAYOUT_COMPONENT_IDS = [
  "seed-feed",
  "seed-schedule",
  "seed-review-plan",
  "seed-rhythm",
  "seed-flex",
] as const;

export const BROWSER_COMPANION_COMPONENT_ID = BROWSER_COMPANION_SPEC.id;

export const BROWSER_FIXED_COMPONENT_IDS = [
  BROWSER_COMPANION_COMPONENT_ID,
  ...BROWSER_SYSTEM_COMPONENT_SPECS.map((component) => component.id),
] as const;

export const BROWSER_COMPONENT_IDS = BROWSER_COMPONENT_SPECS.map(
  (component) => component.id,
);

const SPEC_BY_ID = new Map<string, BrowserComponentSpec>(
  BROWSER_COMPONENT_SPECS.map((spec) => [spec.id, spec]),
);
const SPEC_BY_TYPE = new Map<string, BrowserComponentSpec>(
  BROWSER_COMPONENT_SPECS.map((spec) => [spec.type, spec]),
);
const LAYOUT_SPANS = new Set<number>([4, 5, 7, 12]);

/**
 * The production registry is host-owned code.  Model output may only refer to
 * these IDs; it can never register a renderer, command or executable callback.
 */
export function createBrowserCompositionRegistry(): CompositionRegistry {
  const registry = new CompositionRegistry();
  registry.registerModule({
    id: BROWSER_COMPOSITION_MODULE_ID,
    title: "Latitude Browser Desktop",
    version: "1",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.feedFeedback,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Record typed curator feedback for one persisted feed resource",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.activityCapture,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Capture one user-authored activity as source-linked Domain evidence",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.activityEdit,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Correct one user-authored activity record",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.activityRetract,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Retract one activity record while preserving change history",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.activityReflect,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "read",
    description: "Ask the local assistant for explicitly unconfirmed observations",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.lineageOpen,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "read",
    description: "Open the source node already present in the Browser projection",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.anchorComplete,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Open typed outcome collection for one Domain action",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.anchorEdit,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Rename one Domain action through the typed update command",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.companionChat,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "read",
    description: "Open the persisted Browser conversation with the secretary",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.companionReview,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Run the typed weekly review from the secretary companion",
  });
  registry.registerCommand({
    id: BROWSER_COMMAND_IDS.companionOutcome,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    risk: "reversible-write",
    description: "Open typed result collection for the next due Domain action",
  });
  const fixedCommands: ReadonlyArray<{
    id: BrowserCommandId;
    risk: "read" | "reversible-write" | "destructive";
    description: string;
  }> = [
    { id: BROWSER_COMMAND_IDS.controlSearchWeb, risk: "read", description: "Run bounded Web Search through the local Agent Host" },
    { id: BROWSER_COMMAND_IDS.controlRefresh, risk: "read", description: "Refresh the persisted Browser projection" },
    { id: BROWSER_COMMAND_IDS.agentCancel, risk: "reversible-write", description: "Cancel the currently running Agent turn" },
    { id: BROWSER_COMMAND_IDS.candidateTouch, risk: "reversible-write", description: "Touch one typed co-creation candidate" },
    { id: BROWSER_COMMAND_IDS.candidateShape, risk: "reversible-write", description: "Move one touched candidate into shaping" },
    { id: BROWSER_COMMAND_IDS.candidateConclude, risk: "reversible-write", description: "Conclude one candidate with a typed receipt" },
    { id: BROWSER_COMMAND_IDS.candidatePark, risk: "reversible-write", description: "Park one candidate without manufacturing a conclusion" },
    { id: BROWSER_COMMAND_IDS.threadClose, risk: "read", description: "Close the visible Browser conversation sheet" },
    { id: BROWSER_COMMAND_IDS.outcomeSubmit, risk: "reversible-write", description: "Submit one typed real-world outcome" },
    { id: BROWSER_COMMAND_IDS.outcomeClose, risk: "read", description: "Close outcome collection without writing" },
    { id: BROWSER_COMMAND_IDS.diagnosticsDataSafety, risk: "read", description: "Open the deep data-safety entry from diagnostics" },
    { id: BROWSER_COMMAND_IDS.diagnosticsClose, risk: "read", description: "Close local service diagnostics" },
    { id: BROWSER_COMMAND_IDS.dataSafetyExport, risk: "read", description: "Export the complete plaintext local profile" },
    { id: BROWSER_COMMAND_IDS.dataSafetyIntegrity, risk: "read", description: "Check complete profile integrity" },
    { id: BROWSER_COMMAND_IDS.dataSafetyRestore, risk: "destructive", description: "Prepare and commit a two-stage full restore" },
    { id: BROWSER_COMMAND_IDS.dataSafetyDelete, risk: "destructive", description: "Prepare and commit a recoverable local reset" },
    { id: BROWSER_COMMAND_IDS.dataSafetyPurge, risk: "destructive", description: "Prepare and commit permanent deletion" },
    { id: BROWSER_COMMAND_IDS.dataSafetyRollback, risk: "reversible-write", description: "Rollback one reversible Domain ChangeSet" },
    { id: BROWSER_COMMAND_IDS.dataSafetyClose, risk: "read", description: "Close the data-safety dialog" },
    { id: BROWSER_COMMAND_IDS.agentSend, risk: "reversible-write", description: "Send one user message to the local Agent Host" },
    { id: BROWSER_COMMAND_IDS.navigationPaper, risk: "read", description: "Navigate to the paper desktop" },
    { id: BROWSER_COMMAND_IDS.navigationClue, risk: "read", description: "Navigate to the clue-board desktop" },
    { id: BROWSER_COMMAND_IDS.navigationConstellation, risk: "read", description: "Navigate to the constellation desktop" },
    { id: BROWSER_COMMAND_IDS.inspectorClose, risk: "read", description: "Close the source inspector" },
  ];
  for (const command of fixedCommands) {
    registry.registerCommand({
      ...command,
      moduleId: BROWSER_COMPOSITION_MODULE_ID,
    });
  }
  for (const spec of BROWSER_COMPONENT_SPECS) {
    registry.registerComponent({
      type: spec.type,
      moduleId: BROWSER_COMPOSITION_MODULE_ID,
      slots: [spec.slot],
      events: Object.keys(spec.events),
      eventCommands: spec.events,
      columnSpans: spec.surface === "fixed-module" ? [1] : [4, 5, 7, 12],
      rowSpans: [1],
      validateProps: (props) => validateBrowserComponentProps(spec, props),
    });
  }
  return registry;
}

export function browserComponentSpec(id: string): BrowserComponentSpec | undefined {
  return SPEC_BY_ID.get(id);
}

export function browserComponentSpecForType(
  type: string,
): BrowserComponentSpec | undefined {
  return SPEC_BY_TYPE.get(type);
}

export interface BrowserComponentRuntimeState {
  visible: boolean;
  actions: Readonly<Record<string, boolean>>;
}

/** Resolve one fixed production module without accepting model-defined code or props. */
export function resolveBrowserComponentRuntimeState(
  document: UiSurfaceDocumentV2,
  registry: CompositionRegistry,
  componentId: string,
): BrowserComponentRuntimeState | undefined {
  const spec = SPEC_BY_ID.get(componentId);
  const component = document.components.find((candidate) => candidate.id === componentId);
  if (
    !spec ||
    !component ||
    component.type !== spec.type ||
    component.slot !== spec.slot ||
    component.props.bindingRef !== spec.bindingRef ||
    registry.validateComponent(component).length > 0
  ) {
    return undefined;
  }
  return {
    visible: component.visible,
    actions: Object.fromEntries(
      Object.entries(spec.defaultActions).map(([event, commandId]) => [
        event,
        component.actions[event] === commandId &&
          registry.canBind(component.type, event, commandId),
      ]),
    ),
  };
}

export function createBrowserCompanionComponent(
  visible = true,
): UiComponentInstance {
  return createBrowserFixedComponent(BROWSER_COMPANION_SPEC, visible);
}

export function createBrowserSystemComponents(): UiComponentInstance[] {
  return BROWSER_SYSTEM_COMPONENT_SPECS.map((spec) =>
    createBrowserFixedComponent(spec, true),
  );
}

function createBrowserFixedComponent(
  spec: BrowserComponentSpec,
  visible: boolean,
): UiComponentInstance {
  return {
    id: spec.id,
    type: spec.type,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    slot: spec.slot,
    order: 0,
    visible,
    grid: { columnSpan: 1, rowSpan: 1 },
    props: { bindingRef: spec.bindingRef },
    actions: { ...spec.defaultActions },
  };
}

/**
 * Deterministic schema normalization for the original five-card Browser surface,
 * the detached-companion variant, and the previous full production surface.
 * Adding the host-owned activity paper keeps the same revision: this is a product
 * schema migration, not a user/Agent mutation.
 */
export function migrateLegacyBrowserSurface(
  document: UiSurfaceDocumentV2,
  companionVisible = true,
): UiSurfaceDocumentV2 {
  const ids = new Set(document.components.map((component) => component.id));
  if (
    document.components.length === BROWSER_COMPONENT_SPECS.length &&
    BROWSER_COMPONENT_IDS.every((id) => ids.has(id))
  ) {
    return structuredClone(document);
  }
  const hasFiveCards = LEGACY_BROWSER_LAYOUT_COMPONENT_IDS.every((id) => ids.has(id));
  const isFiveCardLegacy =
    document.components.length === LEGACY_BROWSER_LAYOUT_COMPONENT_IDS.length && hasFiveCards;
  const isSixComponentLegacy =
    document.components.length === LEGACY_BROWSER_LAYOUT_COMPONENT_IDS.length + 1 &&
    hasFiveCards &&
    ids.has(BROWSER_COMPANION_COMPONENT_ID);
  const isPreviousProduction =
    document.components.length === BROWSER_COMPONENT_SPECS.length - 1 &&
    hasFiveCards &&
    BROWSER_FIXED_COMPONENT_IDS.every((id) => ids.has(id));
  if (!isFiveCardLegacy && !isSixComponentLegacy && !isPreviousProduction) {
    throw new TypeError(
      "Browser UiSurfaceV2 must be a trusted legacy or current production surface",
    );
  }
  const migrated = structuredClone(document);
  for (const component of migrated.components) {
    if (LEGACY_BROWSER_LAYOUT_COMPONENT_IDS.includes(
      component.id as (typeof LEGACY_BROWSER_LAYOUT_COMPONENT_IDS)[number],
    )) {
      component.order += 1;
    }
  }
  return {
    ...migrated,
    components: [
      createBrowserActivityComponent(),
      ...migrated.components,
      ...(isFiveCardLegacy ? [createBrowserCompanionComponent(companionVisible)] : []),
      ...(isPreviousProduction ? [] : createBrowserSystemComponents()),
    ],
  };
}

/** Compatibility export for callers written before the system-module closure. */
export const migrateFiveCardBrowserSurface = migrateLegacyBrowserSurface;

function createBrowserActivityComponent(): UiComponentInstance {
  const spec = BROWSER_LAYOUT_COMPONENT_SPECS.find((candidate) => candidate.id === "seed-activity");
  const card = BROWSER_PRODUCT_LAYOUT_DOCUMENT.cards.find((candidate) => candidate.id === "seed-activity");
  if (!spec || !card?.presentation) {
    throw new TypeError("Browser activity component is not registered");
  }
  return {
    id: spec.id,
    type: spec.type,
    moduleId: BROWSER_COMPOSITION_MODULE_ID,
    slot: spec.slot,
    order: 0,
    visible: true,
    grid: { columnSpan: card.span, rowSpan: 1 },
    props: componentProps(spec.bindingRef, card.presentation),
    actions: { ...spec.defaultActions },
  };
}

export function layoutV1ToUiSurfaceV2(
  layout: LayoutDocumentV1<string, CardPresentation>,
  updatedAt = new Date().toISOString(),
  companionVisible = true,
): UiSurfaceDocumentV2 {
  const cardById = new Map(layout.cards.map((card) => [card.id, card]));
  const orderById = new Map(
    layout.arrangement.orderedCardIds.map((id, order) => [id, order]),
  );
  if (
    layout.cards.length !== BROWSER_LAYOUT_COMPONENT_SPECS.length ||
    layout.arrangement.orderedCardIds.length !== BROWSER_LAYOUT_COMPONENT_SPECS.length
  ) {
    throw new TypeError("Browser production surface must contain the six registered cards");
  }
  const components = BROWSER_LAYOUT_COMPONENT_SPECS.map((spec) => {
    const card = cardById.get(spec.id);
    const order = orderById.get(spec.id);
    if (!card || order === undefined) {
      throw new TypeError(`Browser production surface is missing ${spec.id}`);
    }
    if (
      card.renderer !== "native" ||
      card.kind !== spec.kind ||
      card.region !== spec.slot ||
      card.binding !== spec.bindingRef ||
      !card.presentation
    ) {
      throw new TypeError(`Browser production card ${spec.id} violates its trusted registry`);
    }
    const component: UiComponentInstance = {
      id: spec.id,
      type: spec.type,
      moduleId: BROWSER_COMPOSITION_MODULE_ID,
      slot: spec.slot,
      order,
      visible: card.hidden !== true,
      grid: { columnSpan: card.span, rowSpan: 1 },
      props: componentProps(spec.bindingRef, card.presentation),
      actions: { ...spec.defaultActions },
    };
    return component;
  });
  components.push(
    createBrowserCompanionComponent(companionVisible),
    ...createBrowserSystemComponents(),
  );
  const document: UiSurfaceDocumentV2 = {
    schemaVersion: 2,
    id: layout.id,
    revision: layout.revision,
    title: "Latitude Browser Desktop",
    components,
    updatedAt,
  };
  const issues = createBrowserCompositionRegistry().validateDocument(document);
  if (issues.length) throw new TypeError(issues.join("; "));
  return document;
}

export function uiSurfaceV2ToLayoutV1(
  document: UiSurfaceDocumentV2,
  baseLayout: LayoutDocumentV1<string, CardPresentation>,
  changeSetId?: string,
): LayoutDocumentV1<string, CardPresentation> {
  const registry = createBrowserCompositionRegistry();
  const issues = registry.validateDocument(document);
  if (issues.length) throw new TypeError(issues.join("; "));
  if (document.components.length !== BROWSER_COMPONENT_SPECS.length) {
    throw new TypeError("Browser production surface cannot remove registered cards; hide them instead");
  }
  const componentById = new Map(document.components.map((component) => [component.id, component]));
  const baseCardById = new Map(baseLayout.cards.map((card) => [card.id, card]));
  const ordered = document.components
    .filter((component) => SPEC_BY_ID.get(component.id)?.surface === "layout-card")
    .sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const orderedCardIds = ordered.map((component) => component.id);
  if (
    new Set(orderedCardIds).size !== BROWSER_LAYOUT_COMPONENT_SPECS.length ||
    orderedCardIds.some((id) => !BROWSER_LAYOUT_COMPONENT_IDS.includes(
      id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
    ))
  ) {
    throw new TypeError("Browser production surface contains an unknown component instance");
  }
  const cards = BROWSER_LAYOUT_COMPONENT_SPECS.map((spec) => {
    const component = componentById.get(spec.id);
    const base = baseCardById.get(spec.id);
    if (!component || !base || component.type !== spec.type || component.slot !== spec.slot) {
      throw new TypeError(`Browser production surface cannot resolve ${spec.id}`);
    }
    if (!LAYOUT_SPANS.has(component.grid.columnSpan)) {
      throw new TypeError(`Unsupported card span: ${component.grid.columnSpan}`);
    }
    return {
      ...structuredClone(base),
      span: component.grid.columnSpan as LayoutSpan,
      binding: readBindingRef(component.props),
      presentation: readPresentation(component.props),
      ...(component.visible ? { hidden: undefined } : { hidden: true }),
    };
  });
  return {
    ...structuredClone(baseLayout),
    id: document.id,
    revision: document.revision,
    ...(changeSetId
      ? { composition: { mode: "user-customized" as const, changeSetId } }
      : { composition: undefined }),
    cards,
    arrangement: {
      ...structuredClone(baseLayout.arrangement),
      orderedCardIds,
      rationale: changeSetId
        ? ["桌面顺序与纸面表现来自可回滚的 UiChangeSet"]
        : [...baseLayout.arrangement.rationale],
    },
  };
}

/** Exact, non-semantic diff used for V1 migration and product reset. */
export function diffBrowserUiDocuments(
  current: UiSurfaceDocumentV2,
  target: UiSurfaceDocumentV2,
): UiPatchOperation[] {
  const targetById = new Map(target.components.map((component) => [component.id, component]));
  const operations: UiPatchOperation[] = [];
  for (const component of current.components) {
    const next = targetById.get(component.id);
    if (!next) throw new TypeError(`Browser production target is missing ${component.id}`);
    if (component.slot !== next.slot || component.order !== next.order) {
      operations.push({
        op: "move",
        componentId: component.id,
        slot: next.slot,
        order: next.order,
      });
    }
    if (
      component.grid.columnSpan !== next.grid.columnSpan ||
      component.grid.rowSpan !== next.grid.rowSpan
    ) {
      operations.push({
        op: "resize",
        componentId: component.id,
        columnSpan: next.grid.columnSpan,
        rowSpan: next.grid.rowSpan,
      });
    }
    if (JSON.stringify(component.props) !== JSON.stringify(next.props)) {
      operations.push({ op: "setProps", componentId: component.id, props: next.props });
    }
    const events = new Set([...Object.keys(component.actions), ...Object.keys(next.actions)]);
    for (const event of events) {
      const before = component.actions[event] ?? null;
      const after = next.actions[event] ?? null;
      if (before !== after) {
        operations.push({
          op: "bindAction",
          componentId: component.id,
          event,
          commandId: after,
        });
      }
    }
    if (component.visible !== next.visible) {
      operations.push({
        op: "setVisibility",
        componentId: component.id,
        visible: next.visible,
      });
    }
  }
  return operations;
}

export function assertBrowserProductionOperations(
  operations: readonly UiPatchOperation[],
): void {
  const registry = createBrowserCompositionRegistry();
  for (const operation of operations) {
    if (operation.op === "add" || operation.op === "remove") {
      throw new TypeError("Registered Browser components use safe hide/restore, not physical add/remove");
    }
    const spec = SPEC_BY_ID.get(operation.componentId);
    if (!spec) {
      throw new TypeError(`Unknown Browser component: ${operation.componentId}`);
    }
    if (
      !["move", "resize", "setProps", "bindAction", "setVisibility"].includes(
        operation.op,
      )
    ) {
      throw new TypeError(`Unsupported Browser operation: ${String(operation.op)}`);
    }
    if (spec.surface === "fixed-module") {
      if (operation.op !== "setVisibility" && operation.op !== "bindAction") {
        throw new TypeError(
          `Browser fixed module ${spec.id} only allows visibility and trusted action bindings`,
        );
      }
    } else if (operation.op === "move") {
      if (
        operation.slot !== spec.slot ||
        !Number.isInteger(operation.order) ||
        operation.order < 0 ||
        operation.order >= BROWSER_LAYOUT_COMPONENT_SPECS.length
      ) {
        throw new TypeError(`Invalid Browser move operation for ${spec.id}`);
      }
    } else if (operation.op === "resize") {
      if (!LAYOUT_SPANS.has(operation.columnSpan) || operation.rowSpan !== 1) {
        throw new TypeError(`Invalid Browser resize operation for ${spec.id}`);
      }
    } else if (operation.op === "setProps") {
      const issues = registry.component(spec.type)?.validateProps?.(operation.props) ?? [];
      if (issues.length > 0) throw new TypeError(issues.join("; "));
    }
    if (operation.op === "bindAction") {
      if (
        !Object.prototype.hasOwnProperty.call(spec.events, operation.event) ||
        (operation.commandId !== null &&
          !registry.canBind(spec.type, operation.event, operation.commandId))
      ) {
        throw new TypeError(
          `Browser component ${spec.id}.${operation.event} cannot bind command ${String(operation.commandId)}`,
        );
      }
    }
    if (operation.op === "setVisibility" && typeof operation.visible !== "boolean") {
      throw new TypeError(`Invalid Browser visibility operation for ${spec.id}`);
    }
  }
}

export function componentProps(
  bindingRef: string,
  presentation: CardPresentation,
): JsonObject {
  return {
    bindingRef,
    presentation: structuredClone(presentation) as unknown as JsonValue,
  };
}

export function readBindingRef(props: JsonObject): string {
  if (typeof props.bindingRef !== "string") throw new TypeError("bindingRef must be a string");
  return props.bindingRef;
}

export function readPresentation(props: JsonObject): CardPresentation {
  if (!isRecord(props.presentation)) throw new TypeError("presentation must be an object");
  return structuredClone(props.presentation) as unknown as CardPresentation;
}

function validateBrowserComponentProps(
  spec: BrowserComponentSpec,
  props: JsonObject,
): string[] {
  const issues: string[] = [];
  const keys = Object.keys(props);
  if (spec.surface === "fixed-module") {
    for (const key of keys) {
      if (key !== "bindingRef") {
        issues.push(`${spec.id} props contains forbidden key ${key}`);
      }
    }
    if (props.bindingRef !== spec.bindingRef) {
      issues.push(`${spec.id} bindingRef must remain ${spec.bindingRef}`);
    }
    return issues;
  }
  for (const key of keys) {
    if (key !== "bindingRef" && key !== "presentation") {
      issues.push(`${spec.id} props contains forbidden key ${key}`);
    }
  }
  if (props.bindingRef !== spec.bindingRef) {
    issues.push(`${spec.id} bindingRef must remain ${spec.bindingRef}`);
  }
  if (!isRecord(props.presentation)) {
    issues.push(`${spec.id} presentation must be an object`);
    return issues;
  }
  issues.push(...validatePresentation(props.presentation).map((issue) => `${spec.id} ${issue}`));
  return issues;
}

function validatePresentation(value: Record<string, JsonValue>): string[] {
  const issues: string[] = [];
  const allowed = new Set([
    "eyebrow",
    "title",
    "tilt",
    "paper",
    "offsetY",
    "tape",
    "clip",
    "dogear",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`presentation contains forbidden key ${key}`);
  }
  for (const key of ["eyebrow", "title"] as const) {
    const text = value[key];
    if (typeof text !== "string" || !text.trim() || text.length > 160) {
      issues.push(`presentation.${key} must be a non-empty string up to 160 characters`);
    }
  }
  if (value.tilt !== undefined && !boundedNumber(value.tilt, -8, 8)) {
    issues.push("presentation.tilt must be between -8 and 8");
  }
  if (
    value.paper !== undefined &&
    !["plain", "sticky", "grid", "newsprint"].includes(String(value.paper))
  ) {
    issues.push("presentation.paper is invalid");
  }
  if (value.offsetY !== undefined && !boundedNumber(value.offsetY, -96, 96)) {
    issues.push("presentation.offsetY must be between -96 and 96");
  }
  for (const key of ["clip", "dogear"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      issues.push(`presentation.${key} must be boolean`);
    }
  }
  if (value.tape !== undefined) {
    if (!isRecord(value.tape)) issues.push("presentation.tape must be an object");
    else issues.push(...validateTape(value.tape));
  }
  return issues;
}

function validateTape(value: Record<string, JsonValue>): string[] {
  const issues: string[] = [];
  const allowed = new Set(["side", "offset", "width", "color", "tilt"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`presentation.tape contains forbidden key ${key}`);
  }
  if (value.side !== "left" && value.side !== "right") {
    issues.push("presentation.tape.side is invalid");
  }
  if (!boundedNumber(value.offset, -100, 500)) {
    issues.push("presentation.tape.offset is invalid");
  }
  if (!boundedNumber(value.width, 1, 400)) {
    issues.push("presentation.tape.width is invalid");
  }
  if (!boundedNumber(value.tilt, -45, 45)) {
    issues.push("presentation.tape.tilt is invalid");
  }
  if (
    typeof value.color !== "string" ||
    !value.color.trim() ||
    value.color.length > 100 ||
    /[;{}]|url\s*\(/i.test(value.color)
  ) {
    issues.push("presentation.tape.color is invalid");
  }
  return issues;
}

function boundedNumber(value: JsonValue | undefined, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
