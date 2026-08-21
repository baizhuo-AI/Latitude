import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader, CommandBar, DeskHeader, SecretaryRail } from "./Shell";
import { JournalPage } from "./JournalPage";
import { DeskGrid } from "./cards";
import { DESK, SPREADS } from "./sample";
import type { CognitionCard, DeskCard } from "./types";
import "./dimension.css";

/**
 * 维度桌面 —— 可交互原型。**尚未挂载到主应用**(main.tsx 仍渲染旧 App/BoardShell),
 * 目前只从 DimensionApp.stories.tsx 进入。挂载属于批次 0,见 ./README.md。
 *
 * 隐喻:桌面上摊着纸片,其中一张是本子,点开摊成内页,合上回到桌面。
 * 定稿见 design/Opening.dc.html,规格见 docs/specs/2026-08-19-dimension-desktop-frontend-prd.md。
 *
 * 布局上有一个和定稿不同的判断:**秘书栏和应用头不参与转场**。
 * 定稿那张画板没画秘书栏,所以本子是全屏摊开的;但秘书栏是稳定外壳,
 * 而且读认知卡的时候恰恰最需要她在场,所以这里只让主区在桌面/本子之间切。
 *
 * 当前阶段的边界:
 *  - 数据来自 sample.ts 的写死样例,不读 SQLite、不调 LLM;
 *  - 除了「打开/合上」,所有动作只给原型提示,不写库 —— 真正落库要等
 *    Proposal / ChangeSet 那套变更控制到位,现在直接写会绕开确认闸门。
 */
export function DimensionApp() {
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const opened = openedId ? DESK.cards.find((c) => c.id === openedId) : null;
  const spread = openedId ? SPREADS[openedId] : null;
  const isOpen = Boolean(opened && spread);

  // Esc 合上本子。摊开的东西必须有一个不用找按钮的退路
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  function handleOpen(card: DeskCard) {
    // 只有认知卡能摊成本子。其他卡以后是下钻到工具页,不是打开
    if (card.kind !== "cognition") {
      say("原型阶段：这里之后会下钻到对应的工具页");
      return;
    }
    if (!SPREADS[card.id]) {
      say("这张卡还没有内页内容");
      return;
    }
    setOpenedId(card.id);
  }

  return (
    <div
      className="dimension-root"
      style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <AppHeader onSettings={() => say("原型阶段：设置走这里，不占桌面位置")} />

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <SecretaryRail
          secretary={DESK.secretary}
          onReview={() => say("原型阶段：这里通往养成时间线（重构计划的「30 天」）")}
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
          <div className={`dim-stage${isOpen ? " dim-stage--open" : ""}`} style={{ flex: 1, minHeight: 0 }}>
            {/* 桌面层 */}
            <div
              className="dim-layer dim-layer--desk"
              style={{ padding: "22px 24px", overflowY: "auto" }}
              // 本子摊开时桌面整层退出可达性树,免得读屏在看不见的内容里游走
              aria-hidden={isOpen}
            >
              <DeskHeader
                breadcrumb={DESK.breadcrumb}
                title={DESK.title}
                subtitle={DESK.subtitle}
                onWhy={() => say("原型阶段：这里会逐张说明「为什么现在出现」")}
                onAdjust={() => say("原型阶段：这里会管卡片的保留 / 退出 / 钉住")}
              />
              <DeskGrid
                cards={DESK.cards}
                handlers={{
                  onOpen: handleOpen,
                  onAccept: () => say("原型阶段：接受后会记成一次 Change Set"),
                  onReject: () => say("原型阶段：拒绝的理由也会被记下来")
                }}
              />
            </div>

            {/* 本子层 */}
            <div className="dim-layer dim-layer--book" aria-hidden={!isOpen}>
              {opened && spread && opened.kind === "cognition" && (
                <JournalPage
                  card={opened as CognitionCard}
                  spread={spread}
                  onClose={() => setOpenedId(null)}
                  onCorrect={(choice) => {
                    setOpenedId(null);
                    say(`已记下「${choice}」——原型阶段还不会真的改认知模型`);
                  }}
                />
              )}
            </div>
          </div>

          <CommandBar onSend={(text) => say(`原型阶段：收到「${text}」，还没接秘书核心`)} />
        </main>
      </div>

      {/* 轻量提示。所有占位动作都要明说是原型,不能做成看着能用但静默失败 */}
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
            borderRadius: 2,
            boxShadow: "0 4px 14px rgb(70 82 31 / 30%)",
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
