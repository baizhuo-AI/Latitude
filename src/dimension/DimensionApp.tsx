import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { SEED_DESKTOP_PROJECTION } from "../projections/desktop/seedProjection";
import {
  runtimeStatusLabel,
  type DesktopProjection
} from "../projections/desktop/types";
import { LayoutRenderer } from "../runtime/layout/LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "../runtime/layout/seedLayout";
import type { LayoutDocumentV1 } from "../runtime/layout/types";
import { JournalPage } from "./JournalPage";
import { AppHeader, CommandBar, DeskHeader, SecretaryRail } from "./Shell";
import type { CardPresentation, CognitionCard, DeskCard } from "./types";
import "./dimension.css";

export interface DimensionAppProps {
  layout?: LayoutDocumentV1<string, CardPresentation>;
  projection?: DesktopProjection;
}

/**
 * 维度桌面最小运行时。
 *
 * 页面只承载稳定五区和交互外壳；卡位来自 LayoutDocument，内容来自
 * DesktopProjection。默认值是明确标注的 seed，不读 SQLite、不调用 LLM，
 * 也不会把任何占位动作伪装成已经写入。
 */
export function DimensionApp({
  layout = SEED_LAYOUT_DOCUMENT,
  projection = SEED_DESKTOP_PROJECTION
}: DimensionAppProps = {}) {
  const [openedCard, setOpenedCard] = useState<DeskCard | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const deskLayer = useRef<HTMLDivElement>(null);
  const bookLayer = useRef<HTMLDivElement>(null);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const spread = openedCard
    ? projection.journalSpreads?.[openedCard.id]
    : undefined;
  const isOpen = openedCard?.kind === "cognition" && Boolean(spread);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenedCard(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // aria-hidden 不会阻止隐藏层里的按钮被 Tab 聚焦；inert 由 DOM 属性补齐。
  useEffect(() => {
    deskLayer.current?.toggleAttribute("inert", isOpen);
    bookLayer.current?.toggleAttribute("inert", !isOpen);
  }, [isOpen]);

  function handleOpen(card: DeskCard) {
    if (card.kind !== "cognition") {
      say("演示模式：这里会打开对应工具，并保留返回位置");
      return;
    }
    if (!projection.journalSpreads?.[card.id]) {
      say("这张认知沉淀还没有可展开的内页");
      return;
    }
    setOpenedCard(card);
  }

  const backgroundTokens = layout.background.tokenOverrides as
    | CSSProperties
    | undefined;

  return (
    <div
      className="dimension-root"
      style={{
        ...backgroundTokens,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}
      data-layout-document={layout.id}
      data-layout-revision={layout.revision}
    >
      <AppHeader
        runtimeLabel={runtimeStatusLabel(projection.runtimeStatus)}
        onSettings={() => say("演示模式：设置页暂未接入")}
      />

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <SecretaryRail
          secretary={projection.secretary}
          onReview={() => say("演示模式：这里会打开你们共同变化的时间线")}
        />

        <main
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            padding: "20px 22px 18px",
            gap: 14
          }}
        >
          <div
            className={`dim-stage${isOpen ? " dim-stage--open" : ""}`}
            style={{ flex: 1, minHeight: 0 }}
          >
            <div
              ref={deskLayer}
              className="dim-layer dim-layer--desk"
              style={{ padding: "22px 24px", overflowY: "auto" }}
              aria-hidden={isOpen}
            >
              <DeskHeader
                breadcrumb={projection.header.breadcrumb}
                title={projection.header.title}
                subtitle={projection.header.subtitle}
                onWhy={() => say(layout.arrangement.rationale.join("；"))}
                onAdjust={() =>
                  say("演示模式：调整桌面会先给你一份可撤销的预览")
                }
              />
              <LayoutRenderer
                document={layout}
                bindings={projection.bindings}
                handlers={{
                  onOpen: handleOpen,
                  onAccept: () =>
                    say("演示模式：已收到选择，本次不会保存"),
                  onReject: () =>
                    say("演示模式：已保持原样，本次不会保存"),
                  onFeedFeedback: (_itemId, feedback) => {
                    const label = {
                      "new-angle": "有新角度",
                      known: "已知道",
                      "not-useful": "没用"
                    }[feedback];
                    say(`演示模式：已看到“${label}”，本次不会保存`);
                  },
                  onLineage: (lineage) => say(`来源线索：${lineage.label}`)
                }}
              />
            </div>

            <div
              ref={bookLayer}
              className="dim-layer dim-layer--book"
              aria-hidden={!isOpen}
            >
              {openedCard?.kind === "cognition" && spread && (
                <JournalPage
                  card={openedCard as CognitionCard}
                  spread={spread}
                  onClose={() => setOpenedCard(null)}
                  onCorrect={(choice) => {
                    setOpenedCard(null);
                    say(`演示模式：已记下“${choice}”，本次不会保存`);
                  }}
                />
              )}
            </div>
          </div>

          <CommandBar
            onSend={(text) =>
              say(`演示模式：收到“${text}”，本次不会保存`)
            }
          />
        </main>
      </div>

      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 26,
            transform: "translateX(-50%)",
            background: "var(--dim-olive-deep)",
            color: "#f2f0dc",
            fontSize: 12,
            padding: "8px 16px",
            border: "1px solid var(--dim-line)",
            borderRadius: 2,
            zIndex: 20,
            maxWidth: "80%"
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
