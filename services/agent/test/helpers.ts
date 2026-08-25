import {
  CallId,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentHostConfig } from "../src/config.js";
import type {
  DomainAudit,
  DomainClientLike,
  DomainToolContext,
  DueWorkItem,
  MessageEvidenceReceipt,
  RankedWebSource,
  UserMessageEvidenceInput,
  WebCurationInput,
  WebCurationReceipt,
  WebIngestionReceipt,
} from "../src/domain/domainClient.js";

export function testConfig(stateDir: string): AgentHostConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    domainBaseUrl: "http://127.0.0.1:43121",
    stateDir,
    provider: "deepseek-official",
    model: "fake-model",
    allowedOrigins: new Set([
      "http://127.0.0.1:1420",
      "http://localhost:1420",
    ]),
    domainTimeoutMs: 1_000,
    schedulerPollMs: 300_000,
    compactionEventThreshold: 10_000,
  };
}

export class FakeDomain implements DomainClientLike {
  due: DueWorkItem[] = [];
  ingested: RankedWebSource[] = [];
  messages: UserMessageEvidenceInput[] = [];
  messageAudits: DomainAudit[] = [];
  curations: WebCurationInput[] = [];
  private readonly listeners = new Set<() => void>();

  async health(): Promise<boolean> {
    return true;
  }

  createToolDefinitions(_context: () => DomainToolContext | undefined): ToolDefinition[] {
    return [];
  }

  async ingestUserMessage(
    input: UserMessageEvidenceInput,
    audit: DomainAudit,
  ): Promise<MessageEvidenceReceipt> {
    this.messages.push(structuredClone(input));
    this.messageAudits.push(structuredClone(audit));
    return {
      clientRequestId: input.clientRequestId,
      messageId: input.messageId,
      changeId: `change-${input.clientRequestId}`,
      sourceRecordId: `source-${input.messageId}`,
      evidenceRefId: `evidence-${input.messageId}`,
      eventNodeId: `event-${input.messageId}`,
    };
  }

  async ingestWebSearch(
    _query: string,
    sources: readonly RankedWebSource[],
    _audit: DomainAudit,
  ): Promise<WebIngestionReceipt[]> {
    this.ingested.push(...sources);
    return sources.map((source) => ({
      contentHash: source.contentHash,
      url: source.url,
      nodeId: `node-${source.contentHash.slice(0, 8)}`,
      sourceRecordId: `source-${source.contentHash.slice(0, 8)}`,
      evidenceRefId: `evidence-${source.contentHash.slice(0, 8)}`,
    }));
  }

  async persistWebCuration(
    input: WebCurationInput,
    _audit: DomainAudit,
  ): Promise<WebCurationReceipt> {
    this.curations.push(structuredClone(input));
    return {
      clientRequestId: `daily-curation:${input.dateKey}`,
      changeId: `change-curation-${input.dateKey}`,
      nodeId: `node-curation-${input.dateKey}`,
    };
  }

  async listDueWork(): Promise<DueWorkItem[]> {
    return structuredClone(this.due);
  }

  subscribeMutations(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitMutation(): void {
    for (const listener of this.listeners) listener();
  }
}

export function textAdapter(text: string) {
  const requests: GenerateOptions[] = [];
  class TextAdapter extends LlmAdapter {
    resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 3 },
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }

  return {
    provider: "fake",
    requests,
    install(ctx: Context) {
      ctx.llm.registerAdapter(["fake"], new TextAdapter());
    },
  };
}

export function failingAdapter(code: "AUTH" | "MISSING_CREDENTIAL") {
  class FailingAdapter extends LlmAdapter {
    resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async *stream(): AsyncIterable<never> {
      throw new LlmError("synthetic provider authentication failure", code);
    }
  }

  return {
    provider: "fake",
    install(ctx: Context) {
      ctx.llm.registerAdapter(["fake"], new FailingAdapter());
    },
  };
}

export function loopingToolAdapter(toolName: string) {
  let call = 0;
  class LoopingAdapter extends LlmAdapter {
    resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      call += 1;
      const id = CallId(`fake-call-${call}`);
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id,
        name: toolName,
        argumentsDelta: "{}",
      };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id, name: toolName, arguments: "{}" },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }

  return {
    provider: "fake",
    install(ctx: Context) {
      ctx.llm.registerAdapter(["fake"], new LoopingAdapter());
    },
  };
}

export function toolThenTextAdapter(
  toolName: string,
  args: Record<string, unknown>,
  text: string,
) {
  let request = 0;
  class ToolThenTextAdapter extends LlmAdapter {
    resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      request += 1;
      if (request === 1) {
        const id = CallId("fake-ui-call");
        const serialized = JSON.stringify(args);
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id,
          name: toolName,
          argumentsDelta: serialized,
        };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "tool-call", id, name: toolName, arguments: serialized },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: 4 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }

  return {
    provider: "fake",
    install(ctx: Context) {
      ctx.llm.registerAdapter(["fake"], new ToolThenTextAdapter());
    },
  };
}

export function toolSequenceThenTextAdapter(
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  text: string,
) {
  let request = 0;
  class ToolSequenceAdapter extends LlmAdapter {
    resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      const call = calls[request];
      request += 1;
      if (call) {
        const id = CallId(`fake-sequence-${request}`);
        const serialized = JSON.stringify(call.args);
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id,
          name: call.name,
          argumentsDelta: serialized,
        };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "tool-call", id, name: call.name, arguments: serialized },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: 4 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }

  return {
    provider: "fake",
    install(ctx: Context) {
      ctx.llm.registerAdapter(["fake"], new ToolSequenceAdapter());
    },
  };
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
