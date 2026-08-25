import { useEffect, useRef, useState } from "react";
import type {
  CardEditRequest,
  CardPresentation,
  DeskCard,
  NativeCardPayload
} from "./types";
import "./card-editor.css";

export interface CardEditorValue {
  presentation: CardPresentation;
  payload: NativeCardPayload;
}

function splitCard(card: DeskCard): CardEditorValue {
  const {
    id: _id,
    span: _span,
    eyebrow,
    title,
    tilt,
    paper,
    offsetY,
    tape,
    clip,
    dogear,
    ...payload
  } = card;
  return {
    presentation: { eyebrow, title, tilt, paper, offsetY, tape, clip, dogear },
    payload: payload as NativeCardPayload
  };
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  min,
  max
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number";
  min?: number;
  max?: number;
}) {
  return (
    <label className="dim-editor-field">
      <span>{label}</span>
      <input
        value={value}
        type={type}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 3
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className="dim-editor-field">
      <span>{label}</span>
      <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function CardEditorDialog({
  request,
  onClose,
  onSave,
  onReset
}: {
  request: CardEditRequest;
  onClose: () => void;
  onSave: (value: CardEditorValue) => void;
  onReset: () => void;
}) {
  const initial = splitCard(request.card);
  const [presentation, setPresentation] = useState(initial.presentation);
  const [payload, setPayload] = useState(initial.payload);
  const dialogRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialField = dialogRef.current?.querySelector<HTMLElement>(
      "input:not([disabled]), textarea:not([disabled]), select:not([disabled])"
    );
    initialField?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [onClose]);

  const patchPayload = (patch: Record<string, unknown>) => {
    setPayload((current) => ({ ...current, ...patch }) as NativeCardPayload);
  };

  const contentFields = (() => {
    switch (payload.kind) {
      case "cognition":
        return (
          <>
            <TextArea label="核心判断" value={payload.blindSpot} onChange={(blindSpot) => patchPayload({ blindSpot })} />
            <TextArea label="原判断" value={payload.claim} onChange={(claim) => patchPayload({ claim })} />
            <TextArea label="替代视角" value={payload.alternativeHint} onChange={(alternativeHint) => patchPayload({ alternativeHint })} />
          </>
        );
      case "feed":
        return payload.items.map((item, index) => (
          <fieldset className="dim-editor-group" key={item.id}>
            <legend>早报 {String(index + 1).padStart(2, "0")}</legend>
            <Field
              label="标题"
              value={item.title}
              onChange={(title) =>
                patchPayload({
                  items: payload.items.map((entry, i) => (i === index ? { ...entry, title } : entry))
                })
              }
            />
            <TextArea
              label="为什么给你看"
              value={item.why}
              onChange={(why) =>
                patchPayload({
                  items: payload.items.map((entry, i) => (i === index ? { ...entry, why } : entry))
                })
              }
            />
            <Field
              label="来源说明"
              value={item.source}
              onChange={(source) =>
                patchPayload({
                  items: payload.items.map((entry, i) => (i === index ? { ...entry, source } : entry))
                })
              }
            />
          </fieldset>
        ));
      case "anchors":
        return payload.rows.map((row, index) => (
          <fieldset className="dim-editor-group dim-editor-row" key={`${row.lineage?.entityId ?? "row"}-${index}`}>
            <legend>锚点 {String(index + 1).padStart(2, "0")}</legend>
            <Field
              label="内容"
              value={row.text}
              onChange={(text) =>
                patchPayload({
                  rows: payload.rows.map((entry, i) => (i === index ? { ...entry, text } : entry))
                })
              }
            />
            <Field
              label="时间 / 状态"
              value={row.meta}
              onChange={(meta) =>
                patchPayload({
                  rows: payload.rows.map((entry, i) => (i === index ? { ...entry, meta } : entry))
                })
              }
            />
          </fieldset>
        ));
      case "count":
        return (
          <>
            <div className="dim-editor-columns">
              <Field label="数字" type="number" value={payload.count} onChange={(value) => patchPayload({ count: Number(value) || 0 })} />
              <Field label="单位" value={payload.unit} onChange={(unit) => patchPayload({ unit })} />
            </div>
            <TextArea label="说明" value={payload.body} onChange={(body) => patchPayload({ body })} />
          </>
        );
      case "note":
        return (
          <>
            <TextArea label="正文" value={payload.body} onChange={(body) => patchPayload({ body })} />
            <TextArea label="手写重点" value={payload.quote} onChange={(quote) => patchPayload({ quote })} />
          </>
        );
      case "chart":
        return (
          <>
            <Field label="链接文案" value={payload.link ?? ""} onChange={(link) => patchPayload({ link })} />
            <Field
              label="柱形数据（0—1，逗号分隔）"
              value={payload.bars.join(", ")}
              onChange={(value) =>
                patchPayload({
                  bars: value
                    .split(",")
                    .map((part) => Number(part.trim()))
                    .filter((part) => Number.isFinite(part))
                    .map((part) => Math.max(0, Math.min(1, part)))
                })
              }
            />
          </>
        );
      case "text":
        return (
          <>
            <TextArea label="正文" value={payload.body} onChange={(body) => patchPayload({ body })} />
            <Field label="链接文案" value={payload.link ?? ""} onChange={(link) => patchPayload({ link })} />
          </>
        );
      case "proposal":
        return (
          <>
            <TextArea label="提案" value={payload.quote} onChange={(quote) => patchPayload({ quote })} />
            <TextArea label="会改变什么" value={payload.consequence ?? ""} onChange={(consequence) => patchPayload({ consequence })} />
          </>
        );
      case "progress":
        return (
          <>
            <TextArea label="进展说明" value={payload.body} onChange={(body) => patchPayload({ body })} />
            <div className="dim-editor-columns">
              <Field
                label="进度"
                type="number"
                min={0}
                max={100}
                value={payload.percent ?? 0}
                onChange={(value) => patchPayload({ percent: Math.max(0, Math.min(100, Number(value) || 0)) })}
              />
              <Field label="阶段" value={payload.leftMeta} onChange={(leftMeta) => patchPayload({ leftMeta })} />
            </div>
          </>
        );
    }
  })();

  const canSave = presentation.title.trim().length > 0 && presentation.eyebrow.trim().length > 0;

  return (
    <div
      className="dim-editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="dim-card-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dim-card-editor-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          onSave({
            presentation: {
              ...presentation,
              title: presentation.title.trim(),
              eyebrow: presentation.eyebrow.trim()
            },
            payload
          });
        }}
      >
        <header className="dim-editor-header">
          <div>
            <p>LOCAL DESK EDIT</p>
            <h2 id="dim-card-editor-title">编辑卡片</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭卡片编辑器">×</button>
        </header>

        <p className="dim-editor-note">
          这里调整当前桌面的呈现，可随时恢复；从线索进入时，改动只留在这条线索自己的桌面。带来源的 Todo 名称仍可直接点文字修改并写回原待办。
        </p>

        <div className="dim-editor-scroll">
          <div className="dim-editor-columns">
            <Field
              label="卡片标题"
              value={presentation.title}
              onChange={(title) => setPresentation((current) => ({ ...current, title }))}
            />
            <Field
              label="英文眉题"
              value={presentation.eyebrow}
              onChange={(eyebrow) => setPresentation((current) => ({ ...current, eyebrow }))}
            />
          </div>
          {contentFields}
        </div>

        <footer className="dim-editor-actions">
          <button type="button" className="dim-btn" onClick={onReset}>恢复来源内容</button>
          <span />
          <button type="button" className="dim-btn" onClick={onClose}>取消</button>
          <button type="submit" className="dim-btn dim-btn--accent" disabled={!canSave}>保存到桌面</button>
        </footer>
      </form>
    </div>
  );
}
