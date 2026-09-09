import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, X } from "lucide-react";
import "./settingsFrame.css";

const sections = [
  { id: "persona", label: "人设与相处方式" },
  { id: "model", label: "对话模型" },
  { id: "history", label: "电脑操作行为记录" },
  { id: "notices", label: "提醒显示" },
  { id: "status", label: "运行状态" },
] as const;

/** Keep forms mounted while navigating so unfinished edits and history filters survive. */
export function SettingsFrame({ children, onClose, closeEnabled, onDataSafety, dataSafetyEnabled }: {
  children: ReactNode;
  onClose: () => void;
  closeEnabled: boolean;
  onDataSafety: () => void;
  dataSafetyEnabled: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [activeSection, setActiveSection] = useState<string>("persona");

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const navigate = (id: string) => {
    const content = contentRef.current;
    const target = content?.querySelector<HTMLElement>(`#settings-${id}`);
    if (!content || !target) return;
    // The persona editor is initially collapsed; its directory entry opens it directly.
    if (id === "persona") {
      const editor = target.querySelector("details");
      if (editor) editor.open = true;
    }
    setActiveSection(id);
    target.focus({ preventScroll: true });
    content.scrollTo({
      top: content.scrollTop + target.getBoundingClientRect().top - content.getBoundingClientRect().top - 22,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };

  const updateActiveSection = () => {
    const content = contentRef.current;
    if (!content) return;
    const top = content.getBoundingClientRect().top + 48;
    let current: string = sections[0].id;
    for (const section of sections) {
      const target = content.querySelector<HTMLElement>(`#settings-${section.id}`);
      if (target && target.getBoundingClientRect().top <= top) current = section.id;
    }
    if (content.scrollHeight > content.clientHeight && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) {
      current = sections[sections.length - 1].id;
    }
    setActiveSection(current);
  };

  return <section className="dim-paper dim-settings-frame" onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && closeEnabled) {
      event.stopPropagation();
      onClose();
    }
  }}>
    <header className="dim-settings-header">
      <h2>设置</h2>
      <button ref={closeRef} type="button" className="dim-settings-close" aria-label="关闭设置" title="关闭设置（Esc）" onClick={onClose} disabled={!closeEnabled}>
        <X size={20} aria-hidden="true" />
      </button>
    </header>
    <div className="dim-settings-body">
      <nav className="dim-settings-nav" aria-label="设置目录">
        <p className="dim-eyebrow">目录</p>
        <div className="dim-settings-links">
          {sections.map((section) => <button key={section.id} type="button" aria-controls={`settings-${section.id}`} aria-current={activeSection === section.id ? "location" : undefined} onClick={() => navigate(section.id)}>
            {section.label}
          </button>)}
        </div>
        <button className="dim-settings-data" type="button" onClick={onDataSafety} disabled={!dataSafetyEnabled}>
          数据与安全… <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </nav>
      <div ref={contentRef} className="dim-settings-content" onScroll={updateActiveSection}>
        {children}
      </div>
    </div>
  </section>;
}
