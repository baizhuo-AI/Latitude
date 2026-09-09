import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420
  },
  preview: {
    port: 4173
  },
  test: {
    // Local visual drafts can contain historical source snapshots, not runnable suites.
    exclude: [...configDefaults.exclude, "out/**"],
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.ts",
    css: true,
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
