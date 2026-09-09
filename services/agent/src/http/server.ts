import type { HistoryService } from "../history/historyService.js";
import { DesktopContentError, type DesktopStore } from "../desktop/desktopStore.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentAdminError, type AgentAdminService } from "../admin/adminService.js";
import type { AgentHostConfig } from "../config.js";
import type { DomainClientLike } from "../domain/domainClient.js";
import { IdempotencyConflictError, type RunJobStore } from "../jobs/jobStore.js";
import { ProviderSettingsError, type DshRuntime } from "../runtime/dshRuntime.js";
import { PersonaError } from "../runtime/personaStore.js";
import type { PersonaChange } from "../../../../src/shared/agentExperience.js";
import type { DurableScheduler } from "../scheduler/durableScheduler.js";
import { normalizeRunRequest, type PublicRunJob } from "../types.js";

const MAX_BODY_BYTES = 1_048_576;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface AgentHttpServerOptions {
  desktop?: DesktopStore;
  config: AgentHostConfig;
  runtime: DshRuntime;
  jobs: RunJobStore;
  domain: DomainClientLike;
  scheduler: DurableScheduler;
  admin: AgentAdminService;
  history?: HistoryService;
}

export class AgentHttpServer {
  private server?: Server;

  constructor(private readonly options: AgentHttpServerOptions) {}

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) return this.address();
    await this.options.runtime.boot();
    await this.options.jobs.init();
    await this.options.scheduler.start();
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.writeError(request, response, error);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.config.port, this.options.config.host);
    });
    return this.address();
  }

  address(): { host: string; port: number; url: string } {
    if (!this.server) throw new Error("Agent HTTP server is not started");
    const address = this.server.address() as AddressInfo | null;
    if (!address) throw new Error("Agent HTTP server has no listening address");
    return {
      host: this.options.config.host,
      port: address.port,
      url: `http://${this.options.config.host}:${address.port}`,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/health") {
      const domainHealthy = await this.options.domain.health(AbortSignal.timeout(1_000));
      const modelConfigured = this.options.runtime.providerConfigured;
      const modelAuthentication = this.options.runtime.providerAuthentication;
      const mutationInProgress = this.options.admin.isMutationInProgress;
      const snapshotInProgress = this.options.admin.isSnapshotInProgress;
      const providerChangeInProgress = this.options.runtime.isProviderChangeInProgress;
      const restartRequired = this.options.admin.isRestartRequired;
      const status = mutationInProgress || snapshotInProgress || providerChangeInProgress
        ? "starting"
        : restartRequired || !modelConfigured ||
            modelAuthentication === "failed" || !domainHealthy
          ? "unavailable"
          : "ready";
      this.writeJson(response, 200, {
        status,
        service: "latitude-agent-host",
        apiVersion: "v1",
        model: {
          provider: this.options.runtime.provider,
          id: this.options.runtime.model,
          configured: modelConfigured,
          authentication: modelAuthentication,
        },
        domain: {
          url: this.options.config.domainBaseUrl,
          healthy: domainHealthy,
        },
        state: {
          restartRequired,
          mutationInProgress,
          snapshotInProgress,
          providerChangeInProgress,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/agent/admin/export") {
      this.writeJson(response, 200, await this.options.admin.exportSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/agent/admin/integrity") {
      const integrity = await this.options.admin.integrity();
      this.writeJson(response, integrity.ok ? 200 : 409, integrity);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/agent/admin/dangerous/prepare"
    ) {
      const prepared = this.options.admin.prepare(
        await this.readJson(request, 64 * 1_048_576),
      );
      this.writeJson(response, 202, prepared);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/agent/admin/dangerous/commit"
    ) {
      const result = await this.options.admin.commit(await this.readJson(request));
      this.writeJson(response, 200, result);
      return;
    }

    if (this.options.admin.isMutationInProgress) {
      throw new HttpError(409, "admin_mutation_in_progress", "Local state mutation is running");
    }
    if (this.options.admin.isSnapshotInProgress) {
      throw new HttpError(409, "admin_snapshot_in_progress", "Local state snapshot is running");
    }
    if (this.options.admin.isRestartRequired) {
      throw new HttpError(503, "host_restart_required", "Restart Agent Host after state change");
    }

    if (url.pathname === "/v1/agent/desktop" && request.method === "GET" && this.options.desktop) {
      this.writeJson(response, 200, this.options.desktop.read(url.searchParams.get("date") ?? undefined));
      return;
    }
    if (url.pathname === "/v1/agent/desktop/todo" && request.method === "POST" && this.options.desktop) {
      this.writeJson(response, 200, this.options.desktop.updateTodo(await this.readJson(request)));
      return;
    }
    if (url.pathname === "/v1/agent/history/status" && request.method === "GET" && this.options.history) {
      this.writeJson(response, 200, await this.options.history.status()); return;
    }
    if (url.pathname === "/v1/agent/history/workflow" && request.method === "POST" && this.options.history) {
      try { this.writeJson(response,200,await this.options.history.workflowAction(await this.readJson(request))); }
      catch(error) { throw new HttpError(409,"history_workflow_unavailable",error instanceof Error ? error.message : "工作方式暂不可用。"); }
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/agent/settings/provider"
    ) {
      this.writeJson(response, 200, await this.options.runtime.getProviderSettings());
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/agent/settings/provider"
    ) {
      this.writeJson(
        response,
        200,
        await this.options.runtime.updateProviderSettings(await this.readJson(request)),
      );
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/v1/agent/turns" || url.pathname === "/v1/agent/runs")
    ) {
      const input = normalizeRunRequest(await this.readJson(request));
      const headerKey = singleHeader(request.headers["idempotency-key"]);
      const { job, created } = await this.options.jobs.create(input, headerKey);
      this.writeJson(response, 202, {
        runId: job.runId,
        status: job.status,
        pollUrl: `/v1/agent/runs/${encodeURIComponent(job.runId)}`,
        deduplicated: !created,
      });
      return;
    }

    if (url.pathname === "/v1/agent/persona") {
      if (request.method === "GET") {
        this.writeJson(response, 200, this.options.runtime.persona.state);
        return;
      }
      if (request.method === "POST") {
        const body = await this.readJson(request) as PersonaChange;
        if (!body || typeof body !== "object") throw new HttpError(400, "invalid_persona", "人设修改必须是对象。");
        this.writeJson(response, 200, await this.options.runtime.persona.change(body, { actor: "user" }));
        return;
      }
    }
    const progressMatch = url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && progressMatch) {
      const runId = decodePath(progressMatch[1]);
      const job = this.options.jobs.get(runId);
      if (!job) throw new HttpError(404, "run_not_found", "Agent run was not found");
      const after = integerQuery(url.searchParams.get("after"), -1, -1, Number.MAX_SAFE_INTEGER);
      this.writeJson(response, 200, await this.options.runtime.readRunProgress(job.request.sessionId, runId, after));
      return;
    }

    const runMatch = url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const runId = decodePath(runMatch[1]);
      const job = this.options.jobs.get(runId);
      if (!job) throw new HttpError(404, "run_not_found", "Agent run was not found");
      this.writeJson(response, 200, publicJob(job));
      return;
    }

    const cancelMatch = url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const runId = decodePath(cancelMatch[1]);
      const job = await this.options.jobs.cancel(runId);
      if (!job) throw new HttpError(404, "run_not_found", "Agent run was not found");
      this.writeJson(response, 200, publicJob(job));
      return;
    }

    const eventsMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const sessionId = decodePath(eventsMatch[1]);
      const after = integerQuery(url.searchParams.get("after"), -1, -1, Number.MAX_SAFE_INTEGER);
      const limit = integerQuery(url.searchParams.get("limit"), 500, 1, 2_000);
      const events = await this.options.runtime.readSessionEvents(sessionId, after, limit);
      this.writeJson(response, 200, { sessionId, after, events });
      return;
    }

    const latestRunMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/latest-run$/);
    if (request.method === "GET" && latestRunMatch) {
      const job = this.options.jobs.latestForSession(decodePath(latestRunMatch[1]));
      this.writeJson(response, 200, { run: job ? publicJob(job) : null });
      return;
    }
    const messagesMatch = url.pathname.match(
      /^\/v1\/agent\/sessions\/([^/]+)\/messages$/,
    );
    if (request.method === "GET" && messagesMatch) {
      const sessionId = decodePath(messagesMatch[1]);
      const limit = integerQuery(url.searchParams.get("limit"), 100, 1, 500);
      const messages = await this.options.runtime.readSessionMessages(sessionId, limit);
      this.writeJson(response, 200, { sessionId, messages });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/web/search") {
      const body = await this.readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "invalid_request", "Search body must be an object");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.query !== "string" || !record.query.trim()) {
        throw new HttpError(400, "invalid_request", "query must be a non-empty string");
      }
      const maxResults = record.maxResults === undefined ? 5 : Number(record.maxResults);
      const freshnessDays = record.freshnessDays === undefined
        ? undefined
        : Number(record.freshnessDays);
      const result = await this.options.runtime.searchWeb(
        record.query,
        maxResults,
        freshnessDays,
      );
      const receiptByHash = new Map(
        result.ingestionReceipts.map((receipt) => [receipt.contentHash, receipt]),
      );
      const retrievedAt = result.sources[0]?.retrievedAt ?? new Date().toISOString();
      this.writeJson(response, 200, {
        query: record.query.trim(),
        retrievedAt,
        coverage: result.coverage,
        results: result.sources.map((source) => {
          const receipt = receiptByHash.get(source.contentHash);
          return {
            title: source.title,
            url: source.url,
            ...(source.snippet ? { snippet: source.snippet } : {}),
            ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
            retrievedAt: source.retrievedAt,
            provider: this.options.runtime.webProvider,
            contentHash: source.contentHash,
            whyNow: source.whyNow,
            ...(receipt?.nodeId ? { evidenceNodeId: receipt.nodeId } : {}),
            ...(receipt?.evidenceRefId ? { evidenceRefId: receipt.evidenceRefId } : {}),
          };
        }),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/scheduler/wake") {
      this.options.scheduler.wake("manual");
      this.writeJson(response, 202, { accepted: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/scheduler/receipts") {
      this.writeJson(response, 200, { receipts: this.options.scheduler.listReceipts() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/scheduler/outbox") {
      this.writeJson(response, 200, { items: this.options.scheduler.listOutbox() });
      return;
    }

    const schedulerAckMatch = url.pathname.match(
      /^\/v1\/scheduler\/outbox\/([^/]+)\/ack$/,
    );
    if (request.method === "POST" && schedulerAckMatch) {
      const receiptKey = decodePath(schedulerAckMatch[1]);
      const item = await this.options.scheduler.acknowledge(receiptKey);
      if (!item) {
        throw new HttpError(404, "outbox_item_not_found", "Scheduler outbox item was not found");
      }
      this.writeJson(response, 200, item);
      return;
    }

    throw new HttpError(404, "not_found", "Route was not found");
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = singleHeader(request.headers.origin);
    if (origin && !this.options.config.allowedOrigins.has(origin)) {
      throw new HttpError(403, "origin_forbidden", "Origin is not allowed");
    }
    response.setHeader("vary", "Origin");
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "Content-Type,Idempotency-Key",
    );
    response.setHeader("access-control-max-age", "600");
  }

  private async readJson(
    request: IncomingMessage,
    maximumBytes = MAX_BODY_BYTES,
  ): Promise<unknown> {
    const contentType = singleHeader(request.headers["content-type"]);
    if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) {
        throw new HttpError(413, "body_too_large", "Request body exceeds the route limit");
      }
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  }

  private writeError(
    request: IncomingMessage,
    response: ServerResponse,
    error: unknown,
  ): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    try {
      this.applyCors(request, response);
    } catch {
      // Preserve the original/forbidden response without reflecting the origin.
    }
    if (error instanceof HttpError) {
      this.writeJson(response, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      this.writeJson(response, 409, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof AgentAdminError) {
      this.writeJson(response, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ProviderSettingsError || error instanceof PersonaError) {
      this.writeJson(response, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof DesktopContentError) {
      this.writeJson(response, error.status, { error: { code: "desktop_content_conflict", message: error.message } });
      return;
    }
    if (error instanceof TypeError) {
      this.writeJson(response, 400, {
        error: { code: "invalid_request", message: error.message },
      });
      return;
    }
    const code = errorCode(error);
    const isUpstream = code.startsWith("WEB_")
      || code === "web_evidence_ingestion_failed"
      || code === "MISSING_CREDENTIAL"
      || code === "AUTH";
    this.writeJson(response, isUpstream ? 502 : 500, {
      error: {
        code: isUpstream ? code : "internal_error",
        message: isUpstream
          ? "Upstream search/model operation failed; no digest was generated"
          : "Agent Host request failed",
      },
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function publicJob(job: PublicRunJob) {
  const { requestFingerprint: _fingerprint, idempotencyKey: _key, ...safe } = job;
  const { systemPrompt: _systemPrompt, ...request } = safe.request;
  if (!safe.result) return { ...safe, request };
  const { events: _events, ...result } = safe.result;
  return { ...safe, request, result };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodePath(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new HttpError(400, "invalid_path", "Path contains invalid encoding");
  }
}

function integerQuery(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_query", "Query integer is out of range");
  }
  return value;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code ? code : "unknown";
}
