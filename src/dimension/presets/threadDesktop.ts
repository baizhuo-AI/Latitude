import type { DesktopProjection } from "../../projections/desktop/types";
import type {
  LayoutDocumentV1,
  LayoutRegion,
  LayoutSpan
} from "../../runtime/layout/types";
import type {
  AnchorRow,
  CardPresentation,
  FeedItem,
  NativeCardPayload
} from "../types";
import type { ClueThread } from "./ClueBoardPreset";

/**
 * 线索纸不是总桌面的过滤器，而是一张有自己题目、纸张和信息重心的桌面。
 * 数据仍从同一份 projection 派生，因此 Todo 的 lineage 不会被复制或切断。
 */
export interface ThreadDesktop {
  projection: DesktopProjection;
  layout: LayoutDocumentV1<string, CardPresentation>;
}

interface ThreadVoice {
  breadcrumb: string;
  deskTitle: string;
  deskNoun: string;
  deskColor: string;
  texture: "linen" | "plain" | "grid";
  order: LayoutRegion[];
  spans: Partial<Record<LayoutRegion, LayoutSpan>>;
}

const BASE_ORDER: LayoutRegion[] = ["feed", "schedule", "review-plan", "rhythm", "flex"];

const THREAD_VOICES: Record<string, ThreadVoice> = {
  工作现状: {
    breadcrumb: "CLUE DESK · DELIVERY",
    deskTitle: "工作现状 · 今日交付台",
    deskNoun: "交付",
    deskColor: "#e8dfcf",
    texture: "linen",
    order: BASE_ORDER,
    spans: { feed: 5, schedule: 7 }
  },
  个人项目进度: {
    breadcrumb: "CLUE DESK · MAKING",
    deskTitle: "个人项目进度 · 创作台",
    deskNoun: "创作",
    deskColor: "#e3e2cf",
    texture: "plain",
    order: ["schedule", "feed", "flex", "review-plan", "rhythm"],
    spans: { schedule: 5, feed: 7 }
  },
  短期规划: {
    breadcrumb: "CLUE DESK · HORIZON",
    deskTitle: "短期规划 · 推演台",
    deskNoun: "规划",
    deskColor: "#dde2d9",
    texture: "grid",
    order: ["review-plan", "schedule", "feed", "rhythm", "flex"],
    spans: { "review-plan": 12, schedule: 7, feed: 5 }
  }
};

function voiceFor(title: string): ThreadVoice {
  return (
    THREAD_VOICES[title] ?? {
      breadcrumb: "CLUE DESK · FOCUS",
      deskTitle: `${title} · 专注桌面`,
      deskNoun: title,
      deskColor: "#e7e1d3",
      texture: "linen",
      order: BASE_ORDER,
      spans: { feed: 5, schedule: 7 }
    }
  );
}

function threadKey(title: string): string {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function relevantFeed(items: FeedItem[], rows: AnchorRow[], title: string): FeedItem[] {
  const entityIds = new Set(
    rows.map((row) => row.lineage?.entityId).filter((id): id is string => Boolean(id))
  );
  const related = items.filter(
    (item) => item.lineage && entityIds.has(item.lineage.entityId)
  );
  if (related.length > 0) return related;

  const first = rows.find((row) => !row.done) ?? rows[0];
  if (!first) return [];
  return [
    {
      id: `clue-summary-${threadKey(title)}`,
      title: `${title}还有 ${rows.filter((row) => !row.done).length} 件在推进`,
      why: `最近的一项是「${first.text}」（${first.meta}）。这张桌面只保留与这条线索直接相关的内容。`,
      source: "线索板 · 本地聚合",
      lineage: first.lineage
    }
  ];
}

function derivePayload(
  payload: NativeCardPayload,
  rows: AnchorRow[],
  thread: ClueThread,
  voice: ThreadVoice
): NativeCardPayload {
  const pending = rows.filter((row) => !row.done);
  const percent = rows.length === 0 ? 0 : Math.round((thread.done / rows.length) * 100);
  switch (payload.kind) {
    case "anchors":
      return {
        ...payload,
        rows,
        emptyHint: `「${thread.title}」暂时没有待处理的记录。`
      };
    case "feed":
      return {
        ...payload,
        items: relevantFeed(payload.items, rows, thread.title),
        emptyHint: `还没有与「${thread.title}」直接相关的新线索。`
      };
    case "progress":
      return {
        ...payload,
        body: `${thread.title}共 ${rows.length} 项，已收口 ${thread.done} 项；这张桌面只计算这条线的真实记录。`,
        percent,
        leftMeta: pending.length > 0 ? `${pending.length} 件在走 · 下一项 ${pending[0].meta}` : "这条线已全部收口"
      };
    case "note":
      return {
        ...payload,
        body: `${voice.deskNoun}桌面只留下与「${thread.title}」直接相关的判断和行动。`,
        quote: pending[0]?.text ?? rows[0]?.text ?? "这条线暂时没有记录"
      };
    case "chart": {
      const base = Math.max(0.16, Math.min(0.86, rows.length * 0.18));
      return {
        ...payload,
        bars: payload.bars.map((bar, index) =>
          Math.max(0.12, Math.min(0.96, bar * 0.46 + base + ((index + thread.title.length) % 3) * 0.08))
        ),
        link: `看「${thread.title}」的推进节奏`
      };
    }
    default:
      return payload;
  }
}

/** 为线索生成独立桌面；只派生表现与聚合，不改源 projection。 */
export function deriveThreadDesktop(
  projection: DesktopProjection,
  layout: LayoutDocumentV1<string, CardPresentation>,
  thread: ClueThread,
  presentationOverrides: Record<string, CardPresentation> = {}
): ThreadDesktop {
  const voice = voiceFor(thread.title);
  const rows = thread.rows.map((row) => ({ ...row, dimmed: false }));
  const bindings = Object.fromEntries(
    Object.entries(projection.bindings).map(([id, payload]) => [
      id,
      payload ? derivePayload(payload, rows, thread, voice) : payload
    ])
  );

  const titles: Record<string, { eyebrow: string; title: string }> = {
    feed: { eyebrow: "CLUE · RELATED", title: `${thread.title}的相关线索` },
    schedule: { eyebrow: "CLUE · ACTIONS", title: `${thread.title} · 行动清单` },
    "review-plan": { eyebrow: "CLUE · PROGRESS", title: `${thread.title} · 收口进度` },
    rhythm: { eyebrow: "CLUE · RHYTHM", title: `${thread.title} · 推进节奏` },
    flex: { eyebrow: "CLUE · NOTE", title: `${thread.title} · 桌边提醒` }
  };

  return {
    projection: {
      ...projection,
      header: {
        breadcrumb: voice.breadcrumb,
        title: voice.deskTitle,
        subtitle: `${thread.pending} 件仍在推进，${thread.done} 件已经收口。这里是「${thread.title}」自己的桌面。`
      },
      bindings
    },
    layout: {
      ...layout,
      id: `${layout.id}--clue-${threadKey(thread.title)}`,
      background: {
        ...layout.background,
        texture: voice.texture,
        tokenOverrides: {
          ...layout.background.tokenOverrides,
          "--dim-desk": voice.deskColor
        }
      },
      cards: layout.cards.map((card, index) => {
        const copy = titles[card.region];
        const hasUserPresentation = Boolean(presentationOverrides[card.id]);
        return {
          ...card,
          span: voice.spans[card.region] ?? card.span,
          presentation: card.presentation
            ? {
                ...card.presentation,
                ...(hasUserPresentation ? {} : copy),
                tilt: (card.presentation.tilt ?? 0) + (thread.title.length % 3 - 1) * 0.22,
                offsetY: (card.presentation.offsetY ?? 0) + ((index + thread.title.length) % 3 - 1) * 3
              }
            : card.presentation
        };
      }),
      arrangement: {
        ...layout.arrangement,
        orderedCardIds: voice.order.map((region) => {
          const card = layout.cards.find((candidate) => candidate.region === region);
          if (!card) throw new Error(`线索桌面缺少 ${region} 区域`);
          return card.id;
        }),
        rationale: [
          `这是一张从「${thread.title}」线索派生的独立桌面`,
          "只保留同标签行动与可追溯的关联资讯",
          "退出线索桌面后恢复总桌面，不改源数据"
        ]
      }
    }
  };
}
