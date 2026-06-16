/**
 * AboutYouPanel.tsx — 关于你面板 (Task 2.3)
 *
 * 功能:
 *  - 按 category 分组展示 memory_facts(active 事实)
 *  - 每条显示 content + source 标签(told=中性 / inferred=橙色)
 *  - pinned 标记(置顶显示)
 *  - 每条可编辑 content / 删除
 *  - 顶部/底部手动新增一条(选 category + 填 content)
 *  - 写操作后 emitSync('memory'),让对话窗即时感知
 *  - 订阅 'memory' 同步:对话窗写了记忆后本面板自动刷新
 *
 * 架构决策:
 *  - 读写全走 DB 函数(SQLite 跨窗口共享),不用任何 store 内存态缓存
 *  - 展示所有 active 事实(onlyActive: true),用户管理视角只关心有效记忆
 *  - 编辑态在组件本地管理(editingId + editDraft)
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Check, X, Plus, Pin } from "lucide-react";
import {
  dbListMemoryFacts,
  dbInsertMemoryFact,
  dbUpdateMemoryFact,
  dbDeleteMemoryFact,
  MEMORY_CATEGORIES,
  type MemoryFact,
  type MemoryCategory,
} from "../../lib/db";
import { emitSync, onSync } from "../../lib/syncBus";
import { cn } from "../../lib/utils";

// ─── 公共 input/select 样式(与 PersonaPanel 一致) ────────────────────────────
const inputCls = cn(
  "w-full px-3 py-1.5 rounded-lg text-sm outline-none transition-colors",
  "bg-zinc-50 dark:bg-zinc-950",
  "border border-zinc-200 dark:border-zinc-700",
  "focus:border-indigo-500",
  "text-zinc-900 dark:text-zinc-100",
  "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
);

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function AboutYouPanel() {
  const { t } = useTranslation();

  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);

  // 编辑态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // 新增表单
  const [addCategory, setAddCategory] = useState<MemoryCategory>("identity");
  const [addContent, setAddContent] = useState("");
  const [addPending, setAddPending] = useState(false);

  // ── 读取 ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const rows = await dbListMemoryFacts({ onlyActive: true });
      setFacts(rows);
    } catch (err) {
      console.error("[AboutYouPanel] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 订阅 memory 同步:对话窗写了记忆 → 本面板刷新
    const off = onSync("memory", () => { void load(); });
    return off;
  }, [load]);

  // ── 编辑 ────────────────────────────────────────────────────────────────────

  function handleEditStart(fact: MemoryFact) {
    setEditingId(fact.id);
    setEditDraft(fact.content);
  }

  function handleEditCancel() {
    setEditingId(null);
    setEditDraft("");
  }

  async function handleEditConfirm(id: string) {
    const content = editDraft.trim();
    if (!content) return;
    try {
      await dbUpdateMemoryFact(id, { content });
      emitSync("memory");
      setEditingId(null);
      setEditDraft("");
      await load();
    } catch (err) {
      console.error("[AboutYouPanel] update failed:", err);
    }
  }

  // ── 删除 ────────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await dbDeleteMemoryFact(id);
      emitSync("memory");
      await load();
    } catch (err) {
      console.error("[AboutYouPanel] delete failed:", err);
    }
  }

  // ── 新增 ────────────────────────────────────────────────────────────────────

  async function handleAdd() {
    const content = addContent.trim();
    if (!content) return;
    setAddPending(true);
    try {
      await dbInsertMemoryFact({
        category: addCategory,
        content,
        source: "told",
        durability: "durable",
        pinned: false,
      });
      emitSync("memory");
      setAddContent("");
      await load();
    } catch (err) {
      console.error("[AboutYouPanel] insert failed:", err);
    } finally {
      setAddPending(false);
    }
  }

  // ── 按 category 分组 ────────────────────────────────────────────────────────

  const grouped = MEMORY_CATEGORIES.map((cat) => ({
    category: cat,
    facts: facts.filter((f) => f.category === cat),
  })).filter((g) => g.facts.length > 0);

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* 新增表单(顶部) */}
      <AddFactForm
        category={addCategory}
        content={addContent}
        pending={addPending}
        onCategoryChange={setAddCategory}
        onContentChange={setAddContent}
        onSubmit={() => void handleAdd()}
        t={t}
      />

      {/* 分组列表 */}
      {loading ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500">{t("common.loading")}</p>
      ) : facts.length === 0 ? (
        <p
          data-testid="empty-state"
          className="text-sm text-zinc-400 dark:text-zinc-500 text-center py-4"
        >
          {t("memory.empty")}
        </p>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ category, facts: catFacts }) => (
            <div key={category}>
              {/* 分组标题 */}
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                {t(`memory.category.${category}`)}
              </p>
              <div className="space-y-2">
                {catFacts.map((fact) => (
                  <FactRow
                    key={fact.id}
                    fact={fact}
                    isEditing={editingId === fact.id}
                    editDraft={editDraft}
                    onEditDraftChange={setEditDraft}
                    onEditStart={() => handleEditStart(fact)}
                    onEditConfirm={() => void handleEditConfirm(fact.id)}
                    onEditCancel={handleEditCancel}
                    onDelete={() => void handleDelete(fact.id)}
                    t={t}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 单条事实行 ───────────────────────────────────────────────────────────────

interface FactRowProps {
  fact: MemoryFact;
  isEditing: boolean;
  editDraft: string;
  onEditDraftChange: (v: string) => void;
  onEditStart: () => void;
  onEditConfirm: () => void;
  onEditCancel: () => void;
  onDelete: () => void;
  t: (key: string) => string;
}

function FactRow({
  fact,
  isEditing,
  editDraft,
  onEditDraftChange,
  onEditStart,
  onEditConfirm,
  onEditCancel,
  onDelete,
  t,
}: FactRowProps) {
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2 flex items-start gap-2",
        "bg-zinc-50 dark:bg-zinc-950",
        "border border-zinc-200 dark:border-zinc-800"
      )}
    >
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            data-testid="fact-edit-input"
            type="text"
            value={editDraft}
            onChange={(e) => onEditDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditConfirm();
              if (e.key === "Escape") onEditCancel();
            }}
            autoFocus
            className={cn(inputCls, "text-sm")}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* pinned 标记 */}
            {fact.pinned && (
              <span
                data-testid="pinned-badge"
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-400"
                title={t("memory.pinned")}
              >
                <Pin className="w-2.5 h-2.5" />
              </span>
            )}

            {/* content */}
            <span className="text-sm text-zinc-800 dark:text-zinc-200 break-all">
              {fact.content}
            </span>

            {/* source 标签 */}
            <SourceTag source={fact.source} t={t} />
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
        {isEditing ? (
          <>
            <button
              type="button"
              data-testid="fact-edit-confirm"
              aria-label={t("memory.confirm")}
              onClick={onEditConfirm}
              className="p-1 rounded text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="fact-edit-cancel"
              aria-label={t("memory.cancel")}
              onClick={onEditCancel}
              className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="fact-edit-btn"
              aria-label={t("memory.edit")}
              onClick={onEditStart}
              className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="fact-delete-btn"
              aria-label={t("memory.delete")}
              onClick={onDelete}
              className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── source 标签 ──────────────────────────────────────────────────────────────

function SourceTag({ source, t }: { source: "told" | "inferred"; t: (k: string) => string }) {
  if (source === "told") {
    return (
      <span
        data-testid="source-tag-told"
        className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
      >
        {t("memory.source.told")}
      </span>
    );
  }
  return (
    <span
      data-testid="source-tag-inferred"
      className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50"
    >
      {t("memory.source.inferred")}
    </span>
  );
}

// ─── 新增表单 ─────────────────────────────────────────────────────────────────

interface AddFactFormProps {
  category: MemoryCategory;
  content: string;
  pending: boolean;
  onCategoryChange: (c: MemoryCategory) => void;
  onContentChange: (v: string) => void;
  onSubmit: () => void;
  t: (key: string) => string;
}

function AddFactForm({
  category,
  content,
  pending,
  onCategoryChange,
  onContentChange,
  onSubmit,
  t,
}: AddFactFormProps) {
  return (
    <div className="flex flex-col gap-2 pb-4 border-b border-zinc-200 dark:border-zinc-800">
      <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        {t("memory.addTitle")}
      </p>
      <div className="flex items-center gap-2">
        {/* category 选择 */}
        <select
          data-testid="add-fact-category"
          value={category}
          onChange={(e) => onCategoryChange(e.target.value as MemoryCategory)}
          className={cn(
            "px-2 py-1.5 rounded-lg text-sm outline-none transition-colors",
            "bg-zinc-50 dark:bg-zinc-950",
            "border border-zinc-200 dark:border-zinc-700",
            "focus:border-indigo-500",
            "text-zinc-700 dark:text-zinc-200",
            "flex-shrink-0"
          )}
        >
          {MEMORY_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`memory.category.${cat}`)}
            </option>
          ))}
        </select>

        {/* content 输入 */}
        <input
          data-testid="add-fact-content"
          type="text"
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
          placeholder={t("memory.addPlaceholder")}
          className={cn(inputCls, "flex-1")}
        />

        {/* 提交按钮 */}
        <button
          type="button"
          data-testid="add-fact-submit"
          aria-label={t("memory.add")}
          onClick={onSubmit}
          disabled={pending}
          className={cn(
            "flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
            "bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
          )}
        >
          <Plus className="w-3.5 h-3.5" />
          {t("memory.add")}
        </button>
      </div>
    </div>
  );
}
