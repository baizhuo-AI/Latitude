import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import {
  Search,
  Plus,
  Calendar,
  Type,
  Clock,
  LayoutGrid,
  List,
  ChevronRight,
  ChevronDown,
  X,
  ArrowDownAZ,
  Pencil,
  GripVertical,
  Trash2
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTodoStore, type Todo, type Priority, type TodoStatus } from "../lib/store";
import { useFieldStore } from "../lib/fieldStore";
import type { FieldDefinition } from "../lib/db";
import { cn } from "../lib/utils";
import { NewTaskModal } from "../components/NewTaskModal";

type SortKey = "createdAt" | "deadline" | "priority" | "title";
type FilterPriority = "all" | Priority;
type ViewMode = "flat" | "grouped";

interface GroupLevel {
  field: string;
  direction: "asc" | "desc";
}

interface GroupNode {
  key: string;
  label: string;
  color?: string;
  items: Todo[];
  children?: GroupNode[];
}

const LS_VIEW_KEY = "latitude-todos-view";
const LS_GROUP_CONFIG_KEY = "latitude-todos-group-config";

const BUILTIN_GROUP_FIELDS = ["priority", "status", "tags", "deadline"] as const;

function loadView(): ViewMode {
  try { return (localStorage.getItem(LS_VIEW_KEY) as ViewMode) || "flat"; } catch { return "flat"; }
}
function loadGroupConfig(): GroupLevel[] {
  try {
    const raw = localStorage.getItem(LS_GROUP_CONFIG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function TodosPage() {
  const { t } = useTranslation();
  const todos = useTodoStore((s) => s.todos);
  const toggleComplete = useTodoStore((s) => s.toggleComplete);
  const removeTodo = useTodoStore((s) => s.removeTodo);
  const fieldDefs = useFieldStore((s) => s.fields);
  const navigate = useNavigate();

  const [view, setView] = useState<ViewMode>(loadView);
  const [groupConfig, setGroupConfig] = useState<GroupLevel[]>(loadGroupConfig);
  const [groupPopoverOpen, setGroupPopoverOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [query, setQuery] = useState("");
  const [filterPriority, setFilterPriority] = useState<FilterPriority>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");

  const groupBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { localStorage.setItem(LS_VIEW_KEY, view); }, [view]);
  useEffect(() => { localStorage.setItem(LS_GROUP_CONFIG_KEY, JSON.stringify(groupConfig)); }, [groupConfig]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return todos
      .filter((todo) => {
        if (filterPriority !== "all" && todo.priority !== filterPriority) return false;
        if (q) {
          const inTitle = todo.title.toLowerCase().includes(q);
          const inReason = todo.reason?.toLowerCase().includes(q) ?? false;
          const inTags = todo.tags.some((tag) => tag.toLowerCase().includes(q));
          if (!inTitle && !inReason && !inTags) return false;
        }
        return true;
      })
      .sort(makeSorter(sortKey));
  }, [todos, query, filterPriority, sortKey]);

  const active = visible.filter((todo) => todo.status !== "done");
  const done = visible.filter((todo) => todo.status === "done");

  const grouped = useMemo(() => {
    if (view !== "grouped" || groupConfig.length === 0) return null;
    return buildGroups(visible, groupConfig, fieldDefs, t);
  }, [visible, view, groupConfig, fieldDefs, t]);

  const toggleGrouped = useCallback(() => {
    if (view === "flat") {
      setView("grouped");
      if (groupConfig.length === 0) {
        setGroupConfig([{ field: "priority", direction: "asc" }]);
      }
      setGroupPopoverOpen(true);
    } else {
      setGroupPopoverOpen((v) => !v);
    }
  }, [view, groupConfig.length]);

  const switchToFlat = useCallback(() => {
    setView("flat");
    setGroupPopoverOpen(false);
  }, []);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); setNewTaskOpen(true); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const visibleFieldDefs = fieldDefs.slice(0, 3);

  const allGroupFields = useMemo(() => {
    const built: { value: string; label: string }[] = BUILTIN_GROUP_FIELDS.map((f) => ({
      value: f,
      label: t(`todos.grouping.field${f.charAt(0).toUpperCase() + f.slice(1)}` as any),
    }));
    fieldDefs.forEach((fd) => built.push({ value: `cf_${fd.id}`, label: fd.name }));
    return built;
  }, [fieldDefs, t]);

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md flex-shrink-0">
        <div className="px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {t("todos.title")}
          </h1>
          <div className="flex items-center gap-2">
            <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
              <button
                type="button"
                onClick={switchToFlat}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  view === "flat"
                    ? "bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
                aria-label={t("todos.viewFlat")}
              >
                <List className="w-4 h-4" />
              </button>
              <button
                ref={groupBtnRef}
                type="button"
                onClick={toggleGrouped}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  view === "grouped"
                    ? "bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
                aria-label={t("todos.viewGrouped")}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setNewTaskOpen(true)}
              title={t("todos.addTaskHint")}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors",
                "text-white bg-zinc-900 hover:bg-zinc-800",
                "dark:text-zinc-900 dark:bg-zinc-100 dark:hover:bg-white"
              )}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">{t("todos.addTask")}</span>
            </button>
          </div>
        </div>

        <div className="px-6 pb-4 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("todos.search")}
              className={cn(
                "w-full pl-9 pr-4 py-1.5 rounded-lg text-sm outline-none transition-all",
                "bg-zinc-100 dark:bg-zinc-900",
                "border border-transparent",
                "focus:bg-white dark:focus:bg-zinc-950 focus:border-zinc-300 dark:focus:border-zinc-700",
                "text-zinc-900 dark:text-zinc-100",
                "placeholder:text-zinc-500"
              )}
            />
          </div>
          <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
            {(["all", "high", "medium", "low", "none"] as FilterPriority[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setFilterPriority(p)}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                  filterPriority === p
                    ? "bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {p === "all" ? t("todos.filter.all") : t(`newTask.priority.${p}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <ArrowDownAZ className="w-3.5 h-3.5" />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className={cn(
                "bg-transparent outline-none cursor-pointer",
                "border border-zinc-200 dark:border-zinc-800 rounded-md px-2 py-1",
                "hover:border-zinc-300 dark:hover:border-zinc-700",
                "text-zinc-700 dark:text-zinc-300"
              )}
            >
              <option value="createdAt">{t("todos.sort.createdAt")}</option>
              <option value="deadline">{t("todos.sort.deadline")}</option>
              <option value="priority">{t("todos.sort.priority")}</option>
              <option value="title">{t("todos.sort.title")}</option>
            </select>
          </div>
        </div>
      </div>

      {/* 分组配置 Popover */}
      {groupPopoverOpen && view === "grouped" && (
        <GroupConfigPopover
          config={groupConfig}
          onChange={(cfg) => {
            setGroupConfig(cfg);
            setCollapsedGroups(new Set());
            if (cfg.length === 0) { setView("flat"); setGroupPopoverOpen(false); }
          }}
          onClose={() => setGroupPopoverOpen(false)}
          allFields={allGroupFields}
          t={t}
        />
      )}

      <div className="flex-1 overflow-auto px-6 py-6 scrollbar-thin">
        <div className="max-w-4xl mx-auto">
          {/* 表头 */}
          <div className="flex items-center gap-2 mb-3">
            <div className={cn(
              "flex-1 grid gap-4 px-4 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400 tracking-wider items-center",
              gridColsClass(visibleFieldDefs.length)
            )}>
              <div>{t("todos.columns.title")}</div>
              <div className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{t("todos.columns.deadline")}</div>
              <div className="flex items-center gap-1"><Type className="w-3.5 h-3.5" />{t("todos.columns.tags")}</div>
              <div className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{t("todos.columns.estTime")}</div>
              {visibleFieldDefs.map((fd) => (
                <div key={fd.id} className="truncate text-indigo-500 dark:text-indigo-400">{fd.name}</div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => navigate("/settings?scrollTo=custom-fields")}
              title={t("todos.manageFields")}
              className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {view === "grouped" && grouped ? (
            <GroupedView
              nodes={grouped}
              depth={0}
              collapsedGroups={collapsedGroups}
              toggleCollapse={toggleCollapse}
              toggleComplete={toggleComplete}
              removeTodo={removeTodo}
              setEditingTodo={setEditingTodo}
              noDeadlineLabel={t("todos.noDeadline")}
              fieldDefs={visibleFieldDefs}
            />
          ) : (
            <>
              <div className="space-y-1">
                {active.length === 0 && done.length === 0 && (
                  <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    {t("todos.empty")}
                  </div>
                )}
                {active.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    onToggle={() => void toggleComplete(todo.id)}
                    onRemove={() => void removeTodo(todo.id)}
                    onEdit={() => setEditingTodo(todo)}
                    noDeadlineLabel={t("todos.noDeadline")}
                    fieldDefs={visibleFieldDefs}
                  />
                ))}
              </div>
              {done.length > 0 && (
                <div className="mt-8">
                  <div className="flex items-center justify-between mb-3 px-4">
                    <button
                      type="button"
                      onClick={() => setDoneExpanded((v) => !v)}
                      className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                    >
                      <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", doneExpanded && "rotate-90")} />
                      {t("todos.doneSection", { count: done.length })}
                    </button>
                    {doneExpanded && (
                      <button
                        type="button"
                        onClick={() => { done.forEach((todo) => void removeTodo(todo.id)); }}
                        className="text-xs font-medium text-zinc-400 dark:text-zinc-500 hover:text-red-500 transition-colors"
                      >
                        {t("todos.clearDone")}
                      </button>
                    )}
                  </div>
                  <AnimatePresence initial={false}>
                    {doneExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-1">
                          {done.map((todo) => (
                            <TodoRow
                              key={todo.id}
                              todo={todo}
                              onToggle={() => void toggleComplete(todo.id)}
                              onRemove={() => void removeTodo(todo.id)}
                              onEdit={() => setEditingTodo(todo)}
                              noDeadlineLabel={t("todos.noDeadline")}
                              fieldDefs={visibleFieldDefs}
                            />
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <NewTaskModal
        open={newTaskOpen || !!editingTodo}
        initial={editingTodo}
        onClose={() => { setNewTaskOpen(false); setEditingTodo(null); }}
      />
    </div>
  );
}

/* ---------- Grid columns helper ---------- */

function gridColsClass(extraCols: number): string {
  switch (extraCols) {
    case 1: return "grid-cols-[1fr_120px_140px_80px_100px]";
    case 2: return "grid-cols-[1fr_120px_140px_80px_100px_100px]";
    case 3: return "grid-cols-[1fr_120px_140px_80px_100px_100px_100px]";
    default: return "grid-cols-[1fr_120px_140px_80px]";
  }
}

/* ---------- GroupConfigPopover ---------- */

function GroupConfigPopover({
  config,
  onChange,
  onClose,
  allFields,
  t,
}: {
  config: GroupLevel[];
  onChange: (c: GroupLevel[]) => void;
  onClose: () => void;
  allFields: { value: string; label: string }[];
  t: (key: string) => string;
}) {
  const usedFields = new Set(config.map((c) => c.field));

  const addLevel = () => {
    const avail = allFields.find((f) => !usedFields.has(f.value));
    if (!avail) return;
    onChange([...config, { field: avail.value, direction: "asc" }]);
  };

  const removeLevel = (idx: number) => {
    onChange(config.filter((_, i) => i !== idx));
  };

  const updateField = (idx: number, field: string) => {
    const next = [...config];
    next[idx] = { ...next[idx], field };
    onChange(next);
  };

  const toggleDirection = (idx: number) => {
    const next = [...config];
    next[idx] = { ...next[idx], direction: next[idx].direction === "asc" ? "desc" : "asc" };
    onChange(next);
  };

  return (
    <div className="mx-6 mb-2 relative">
      <div className={cn(
        "rounded-xl p-4 shadow-lg",
        "bg-white dark:bg-zinc-900",
        "border border-zinc-200 dark:border-zinc-800"
      )}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t("todos.grouping.title")}
          </h3>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-2">
          {config.map((level, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <GripVertical className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
              <select
                value={level.field}
                onChange={(e) => updateField(idx, e.target.value)}
                className={cn(
                  "flex-1 text-sm rounded-md px-2 py-1 outline-none",
                  "bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700",
                  "text-zinc-900 dark:text-zinc-100"
                )}
              >
                {allFields
                  .filter((f) => f.value === level.field || !usedFields.has(f.value))
                  .map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() => toggleDirection(idx)}
                className={cn(
                  "text-xs font-medium px-2 py-1 rounded-md",
                  "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300",
                  "hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                )}
              >
                {level.direction === "asc" ? t("todos.grouping.sortAsc") : t("todos.grouping.sortDesc")}
              </button>
              <button
                type="button"
                onClick={() => removeLevel(idx)}
                className="text-zinc-400 hover:text-red-500 p-0.5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        {config.length < allFields.length && (
          <button
            type="button"
            onClick={addLevel}
            className="mt-3 text-xs text-zinc-500 hover:text-indigo-500 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> {t("todos.grouping.addLevel")}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- GroupedView ---------- */

function GroupedView({
  nodes,
  depth,
  collapsedGroups,
  toggleCollapse,
  toggleComplete,
  removeTodo,
  setEditingTodo,
  noDeadlineLabel,
  fieldDefs,
  parentPath = "",
}: {
  nodes: GroupNode[];
  depth: number;
  collapsedGroups: Set<string>;
  toggleCollapse: (path: string) => void;
  toggleComplete: (id: string) => Promise<void>;
  removeTodo: (id: string) => Promise<void>;
  setEditingTodo: (todo: Todo) => void;
  noDeadlineLabel: string;
  fieldDefs: FieldDefinition[];
  parentPath?: string;
}) {
  return (
    <div style={{ paddingLeft: depth > 0 ? 20 : 0 }}>
      {nodes.map((node) => {
        const path = parentPath ? `${parentPath}/${node.key}` : node.key;
        const isCollapsed = collapsedGroups.has(path);
        const count = countItems(node);
        return (
          <div key={node.key} className="mb-4">
            <button
              type="button"
              onClick={() => toggleCollapse(path)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 w-full text-left transition-colors rounded-lg",
                "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
                depth === 0 ? "text-sm font-semibold text-zinc-900 dark:text-zinc-100" : "text-xs font-medium text-zinc-600 dark:text-zinc-400"
              )}
            >
              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {node.color && (
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: node.color }} />
              )}
              <span>{node.label}</span>
              <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full">
                {count}
              </span>
            </button>
            {!isCollapsed && (
              <>
                {node.children ? (
                  <GroupedView
                    nodes={node.children}
                    depth={depth + 1}
                    collapsedGroups={collapsedGroups}
                    toggleCollapse={toggleCollapse}
                    toggleComplete={toggleComplete}
                    removeTodo={removeTodo}
                    setEditingTodo={setEditingTodo}
                    noDeadlineLabel={noDeadlineLabel}
                    fieldDefs={fieldDefs}
                    parentPath={path}
                  />
                ) : (
                  <div className="space-y-1 mt-1">
                    {node.items.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        onToggle={() => void toggleComplete(todo.id)}
                        onRemove={() => void removeTodo(todo.id)}
                        onEdit={() => setEditingTodo(todo)}
                        noDeadlineLabel={noDeadlineLabel}
                        fieldDefs={fieldDefs}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function countItems(node: GroupNode): number {
  if (node.children) return node.children.reduce((s, c) => s + countItems(c), 0);
  return node.items.length;
}

/* ---------- TodoRow ---------- */

function TodoRow({
  todo,
  onToggle,
  onRemove,
  onEdit,
  noDeadlineLabel,
  fieldDefs,
}: {
  todo: Todo;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: () => void;
  noDeadlineLabel: string;
  fieldDefs: FieldDefinition[];
}) {
  const isDone = todo.status === "done";
  return (
    <div
      onDoubleClick={onEdit}
      className={cn(
        "group relative grid gap-4 items-center px-4 py-3 mr-8 transition-all rounded-xl cursor-default",
        gridColsClass(fieldDefs.length),
        "bg-white dark:bg-zinc-900",
        "border border-zinc-200 dark:border-zinc-800",
        "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
        isDone && "opacity-60"
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "w-4 h-4 rounded border flex-shrink-0 transition-colors",
            isDone
              ? "bg-emerald-500 border-emerald-500"
              : "border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:bg-emerald-500/10"
          )}
          aria-label="complete"
        />
        <span className={cn(
          "text-sm font-medium truncate",
          isDone ? "text-zinc-400 dark:text-zinc-500 line-through decoration-zinc-400" : "text-zinc-900 dark:text-zinc-100"
        )}>
          {todo.title}
        </span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
        {todo.deadline ?? noDeadlineLabel}
      </div>
      <div className="flex flex-wrap gap-1">
        {todo.tags.map((tag) => (
          <span key={tag} className="text-xs bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 px-1.5 py-0.5 rounded truncate max-w-[100px]">
            {tag}
          </span>
        ))}
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{todo.estTime ?? "-"}</div>

      {fieldDefs.map((fd) => {
        const val = todo.customFields?.[fd.id];
        if (!val) return <div key={fd.id} className="text-xs text-zinc-400">-</div>;
        if (fd.type === "single_select") {
          const opt = fd.options.find((o) => o.id === val);
          return opt ? (
            <span key={fd.id} className="text-[10px] text-white px-1.5 py-0.5 rounded-full truncate" style={{ backgroundColor: opt.color }}>
              {opt.label}
            </span>
          ) : <div key={fd.id} className="text-xs text-zinc-400">-</div>;
        }
        const arr = Array.isArray(val) ? val : [];
        return (
          <div key={fd.id} className="flex flex-wrap gap-0.5">
            {arr.map((optId) => {
              const opt = fd.options.find((o) => o.id === optId);
              return opt ? (
                <span key={optId} className="text-[10px] text-white px-1 py-0.5 rounded-full truncate" style={{ backgroundColor: opt.color }}>
                  {opt.label}
                </span>
              ) : null;
            })}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onEdit}
        className="absolute right-10 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-all"
        aria-label="edit"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-all"
        aria-label="delete"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/* ---------- Sorting ---------- */

function makeSorter(key: SortKey): (a: Todo, b: Todo) => number {
  const priWeight: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };
  switch (key) {
    case "priority": return (a, b) => priWeight[a.priority] - priWeight[b.priority];
    case "deadline": return (a, b) => (a.deadline ?? "￿").localeCompare(b.deadline ?? "￿");
    case "title": return (a, b) => a.title.localeCompare(b.title, "zh");
    case "createdAt":
    default: return (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }
}

/* ---------- Group computation ---------- */

const PRI_ORDER: Priority[] = ["high", "medium", "low", "none"];
const STATUS_ORDER: TodoStatus[] = ["todo", "doing", "done", "dropped"];
const PRI_COLORS: Record<Priority, string> = {
  high: "#ef4444", medium: "#eab308", low: "#22c55e", none: "#6b7280"
};

function getDeadlineBucket(deadline: string | undefined, t: (k: string) => string): { key: string; label: string } {
  if (!deadline) return { key: "zz_unset", label: t("todos.grouping.deadlineBuckets.unset") };
  const d = new Date(deadline);
  if (isNaN(d.getTime())) return { key: "zz_unset", label: t("todos.grouping.deadlineBuckets.unset") };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { key: "a_overdue", label: t("todos.grouping.deadlineBuckets.overdue") };
  if (diff === 0) return { key: "b_today", label: t("todos.grouping.deadlineBuckets.today") };
  if (diff === 1) return { key: "c_tomorrow", label: t("todos.grouping.deadlineBuckets.tomorrow") };
  if (diff <= 7) return { key: "d_thisWeek", label: t("todos.grouping.deadlineBuckets.thisWeek") };
  if (diff <= 14) return { key: "e_nextWeek", label: t("todos.grouping.deadlineBuckets.nextWeek") };
  return { key: "f_later", label: t("todos.grouping.deadlineBuckets.later") };
}

function buildGroups(
  items: Todo[],
  levels: GroupLevel[],
  fieldDefs: FieldDefinition[],
  t: (key: string, opts?: any) => string
): GroupNode[] {
  if (levels.length === 0) return [{ key: "all", label: "", items }];
  const [level, ...rest] = levels;
  const buckets = new Map<string, { label: string; color?: string; items: Todo[] }>();

  const addToBucket = (key: string, label: string, todo: Todo, color?: string) => {
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { label, color, items: [] }; buckets.set(key, bucket); }
    bucket.items.push(todo);
  };

  for (const todo of items) {
    if (level.field === "priority") {
      addToBucket(todo.priority, t(`newTask.priority.${todo.priority}`), todo, PRI_COLORS[todo.priority]);
    } else if (level.field === "status") {
      addToBucket(todo.status, t(`todos.status.${todo.status}`), todo);
    } else if (level.field === "tags") {
      if (todo.tags.length === 0) {
        addToBucket("zz_unset", t("todos.grouping.unset"), todo);
      } else {
        for (const tag of todo.tags) addToBucket(`tag_${tag}`, tag, todo);
      }
    } else if (level.field === "deadline") {
      const bucket = getDeadlineBucket(todo.deadline, t);
      addToBucket(bucket.key, bucket.label, todo);
    } else if (level.field.startsWith("cf_")) {
      const fieldId = level.field.slice(3);
      const fd = fieldDefs.find((f) => f.id === fieldId);
      if (!fd) { addToBucket("zz_unset", t("todos.grouping.unset"), todo); continue; }
      const val = todo.customFields?.[fieldId];
      if (!val || (Array.isArray(val) && val.length === 0)) {
        addToBucket("zz_unset", t("todos.grouping.unset"), todo);
      } else if (Array.isArray(val)) {
        for (const optId of val) {
          const opt = fd.options.find((o) => o.id === optId);
          addToBucket(optId, opt?.label ?? optId, todo, opt?.color);
        }
      } else {
        const opt = fd.options.find((o) => o.id === val);
        addToBucket(val, opt?.label ?? val, todo, opt?.color);
      }
    }
  }

  let sortedKeys = [...buckets.keys()];
  if (level.field === "priority") {
    sortedKeys.sort((a, b) => PRI_ORDER.indexOf(a as Priority) - PRI_ORDER.indexOf(b as Priority));
  } else if (level.field === "status") {
    sortedKeys.sort((a, b) => STATUS_ORDER.indexOf(a as TodoStatus) - STATUS_ORDER.indexOf(b as TodoStatus));
  } else {
    sortedKeys.sort((a, b) => a.localeCompare(b));
  }
  if (level.direction === "desc") sortedKeys.reverse();

  return sortedKeys
    .map((key) => {
      const bucket = buckets.get(key)!;
      const node: GroupNode = { key, label: bucket.label, color: bucket.color, items: bucket.items };
      if (rest.length > 0) {
        node.children = buildGroups(bucket.items, rest, fieldDefs, t);
        node.items = [];
      }
      return node;
    })
    .filter((n) => n.items.length > 0 || (n.children && n.children.length > 0));
}
