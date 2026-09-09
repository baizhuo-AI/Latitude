import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubmission, displayComposerMessage, parseAttachment } from "./attachments";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const documentMock = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {}, getDocument: documentMock.getDocument }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "pdf-worker" }));
beforeEach(() => vi.clearAllMocks());

describe("attachment extraction", () => {
  it("extracts body text from a real DOCX archive without rendering source markup", async () => {
    const bytes = readFileSync(resolve("src/dimension/composer/fixtures/body.docx"));
    const result = await parseAttachment("方案.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Uint8Array.from(bytes).buffer);
    expect(result.text).toContain("客户方案预算 900");
    expect(result.text).toContain("请先确认范围");
    expect(result.warning).toContain("修订和批注未包含");
    expect(result.text).not.toContain("<w:");
  });
  it("preserves CSV rows and Markdown as source data with a compact user message", async () => {
    const attachment = await parseAttachment("预算.csv", "text/csv", new TextEncoder().encode("名称,预算\n项目,900").buffer);
    expect(attachment.range).toBe("2 行 · UTF-8");
    const message = buildSubmission("看预算", [attachment]);
    expect(message.submission?.displayText).toBe("看预算\n\n附件：预算.csv");
    expect(message.text).toContain("名称,预算\\n项目,900");
    expect(message.submission?.attachments[0]).not.toHaveProperty("text");
    expect(displayComposerMessage(message.text)).toBe(message.submission?.displayText);
  });

  it("keeps page references and visibly flags missing PDF text", async () => {
    const destroy = vi.fn();
    documentMock.getDocument.mockReturnValue({ promise: Promise.resolve({
      numPages: 2,
      getPage: async (page: number) => ({ getTextContent: async () => ({ items: page === 1 ? [{ str: "合同金额 900", hasEOL: true }] : [] }), cleanup: vi.fn() }),
    }), destroy });
    const attachment = await parseAttachment("合同.pdf", "application/pdf", new ArrayBuffer(0));
    expect(attachment.text).toContain("第 1 页\n合同金额 900");
    expect(attachment.warning).toContain("第 2 页没有读取到文字");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not claim a scanned PDF or unsupported workbook was read", async () => {
    documentMock.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup: vi.fn() }) }), destroy: vi.fn() });
    await expect(parseAttachment("扫描件.pdf", "application/pdf", new ArrayBuffer(0))).rejects.toThrow("没有可提取的文字");
    await expect(parseAttachment("表格.xlsx", "", new ArrayBuffer(0))).rejects.toThrow("暂不支持");
  });
});
