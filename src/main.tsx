import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "./styles/index.css";

const App = React.lazy(async () => {
  if (!isTauri()) return import("./BrowserApp");

  return import("./NativeDesktopApp");
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={<div role="status">维度正在启动…</div>}>
      <App />
    </React.Suspense>
  </React.StrictMode>
);
