import { describe, expect, it } from "vitest";
import { presentFeedTitle } from "./feedTitle";

const item = (title: string, source = "example.com") => ({ title, source });

describe("presentFeedTitle", () => {
  it("优先采用上游明确 shortTitle，再采用 headline，同时保留原标题展开条件", () => {
    expect(presentFeedTitle({
      ...item("GitHub - owner/very-long-project: 完整原标题"),
      shortTitle: "明确短标题",
      headline: "次选摘要",
    })).toMatchObject({
      text: "明确短标题",
      source: "shortTitle",
      shortened: true,
      needsDisclosure: true,
    });
    expect(presentFeedTitle({
      ...item("一条用于溯源的完整原标题"),
      headline: "上游给出的标题摘要",
    })).toMatchObject({ text: "上游给出的标题摘要", source: "headline" });
  });

  it("从 GitHub 结构中保留英文项目主体，并去掉重复站点外壳", () => {
    expect(presentFeedTitle(item(
      "GitHub - openai/openai-agents-python: A lightweight framework for multi-agent workflows · GitHub",
      "github.com",
    ))).toMatchObject({
      text: "Openai Agents Python",
      source: "derived",
      shortened: true,
    });
  });

  it("Graph Memory 的中文说明来自原标题，不依赖具体 owner/repo 写死", () => {
    expect(presentFeedTitle(item(
      "GitHub - any-owner/graph-memory: 图谱记忆插件；为 Agent 保存长期上下文 · GitHub",
      "GitHub",
    )).text).toBe("Graph Memory：图谱记忆插件");
    expect(presentFeedTitle(item(
      "GitHub - another-team/context-vault: 图谱记忆插件；支持可追溯来源 · GitHub",
      "GitHub",
    )).text).toBe("Context Vault：图谱记忆插件");
  });

  it("从末尾重复 GitHub 页面标题中取仓库名，并保留前段完整功能句", () => {
    const title =
      "Graph Memory：Deepseek Harness、Openclaw知识图谱记忆插件。2026年4月受邀发布在清华大学讨论会。Knowledge Graph + Memory；Knowledge Graph Context Engine for OpenClaw — extracts structured triples from text · GitHub - GitHub - adoresever/graph-memory: Graph Memory：Deepseek Harness、Openclaw知识图谱记忆插件";
    expect(presentFeedTitle(item(title, "github.com")).text)
      .toBe("Graph Memory：知识图谱记忆插件");
  });

  it("功能句后的冒号特性列表不进入 DSH Deepmemory 短标题", () => {
    const title =
      "DSH Deepmemory：DeepSeek Harness 主体长期记忆插件：语义召回、实体图谱、状态卡、presets、可配置嵌入；任务看板已独立为 dsh-livetaskboard。 · GitHub - GitHub - UnKnownFish125/dsh-deepmemory: 重复全文";
    expect(presentFeedTitle(item(title, "GitHub")).text)
      .toBe("DSH Deepmemory：主体长期记忆插件");
  });

  it("英文功能名只去明确的 for 平台归属尾巴", () => {
    expect(presentFeedTitle(item(
      "deepmemory — Long-term Memory for DeepSeek Harness。",
      "GitHub",
    )).text).toBe("deepmemory：Long-term Memory");
    expect(presentFeedTitle(item(
      "GitHub - openai/openai-agents-python: A lightweight framework for multi-agent workflows · GitHub",
      "github.com",
    )).text).toBe("Openai Agents Python");
  });

  it("长中文标题只取首个完整语义分句", () => {
    expect(presentFeedTitle(item(
      "DeepSeek开源首个智能体运行框架Harness，补齐Vibe Coding入口；Anthropic估值或突破新高",
    )).text).toBe("DeepSeek开源首个智能体运行框架Harness");
  });

  it.each([
    "AI公司收入增长120%，但并未实现盈利且全年现金流仍为负数",
    "公司称“2026年不会裁员；仍计划招聘500人”，市场回应保持谨慎",
    "研究否认GPT-5在2026年取消API访问，并给出三组反例数据",
  ])("数字、否定、转折或引语没有被机械截成相反意思：%s", (title) => {
    const result = presentFeedTitle(item(title));
    expect(result.text).toBe(title);
    expect(result.source).toBe("original");
    expect(result.needsDisclosure).toBe(true);
  });

  it("GitHub 描述含否定时保留完整事件，只交给界面两行省略", () => {
    const result = presentFeedTitle(item(
      "GitHub - lab/risk-watch: 项目并未取消2026年发布计划，而是调整了三个测试阶段 · GitHub",
      "GitHub",
    ));
    expect(result.text).toBe("Risk Watch：项目并未取消2026年发布计划，而是调整了三个测试阶段");
    expect(result.text).toContain("并未取消2026年发布计划");
    expect(result.needsDisclosure).toBe(true);
  });

  it("本来简短的标题原样保留且不增加展开入口", () => {
    expect(presentFeedTitle(item("新模型开始支持本地工具调用"))).toEqual({
      text: "新模型开始支持本地工具调用",
      shortened: false,
      needsDisclosure: false,
      source: "original",
    });
  });
});
