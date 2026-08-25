import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "./styles/index.css";

const App = React.lazy(async () => {
  if (!isTauri()) return import("./BrowserApp");

  // Legacy desktop initialization belongs only to the Tauri chunk. Keeping
  // these imports behind the runtime split prevents browser P0 from evaluating
  // settings/LLM/Feishu/Tauri module graphs before its own root mounts.
  await import("./lib/i18n");
  const [{ applyInitialLang }, { watchSystemTheme }, app] = await Promise.all([
    import("./lib/settings"),
    import("./lib/theme"),
    import("./App"),
  ]);
  applyInitialLang();
  watchSystemTheme();
  return app;
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={<div role="status">维度正在启动…</div>}>
      <App />
    </React.Suspense>
  </React.StrictMode>
);
