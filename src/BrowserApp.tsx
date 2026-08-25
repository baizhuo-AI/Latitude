import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";

const BrowserDimensionApp = lazy(async () => {
  const module = await import("./projections/desktop/BrowserLiveDimensionApp");
  return { default: module.BrowserLiveDimensionApp };
});

/**
 * Browser-only product root. It intentionally imports no legacy Tauri stores,
 * Feishu bridge, Kiro/CLI adapter, old secretary scheduler, or SQLite plugin.
 */
export default function BrowserApp() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div role="status">维度本地产品正在加载…</div>}>
        <BrowserDimensionApp />
      </Suspense>
    </ErrorBoundary>
  );
}
