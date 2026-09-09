import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { parseAttachment } from "./attachments";

// Vitest executes the real worker in Node; Vite's browser URL needs a file URL here.
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: `file://${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs`,
}));

it("reads actual PDF bytes through the packaged PDF.js parser and worker", async () => {
  const bytes = readFileSync(resolve("src/dimension/composer/fixtures/budget.pdf"));
  const result = await parseAttachment("预算.pdf", "application/pdf", Uint8Array.from(bytes).buffer);
  expect(result.text).toContain("第 1 页\nLatitude budget 900");
  expect(result.range).toBe("1 页 · 文本层");
});
