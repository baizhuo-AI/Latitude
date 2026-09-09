import { HistoryService } from "./history/historyService.js";
import { DesktopStore, desktopDatabasePath } from "./desktop/desktopStore.js";
import { pathToFileURL } from "node:url";
import { AgentAdminError, AgentAdminService } from "./admin/adminService.js";
import {
  hardenLocalEnvFile,
  loadAgentHostConfig,
} from "./config.js";
import { DomainClient } from "./domain/domainClient.js";
import { AgentHttpServer } from "./http/server.js";
import { RunJobStore } from "./jobs/jobStore.js";
import { AuditLedger } from "./persistence/auditLedger.js";
import {
  DshRuntime,
  type DshRuntimeOptions,
} from "./runtime/dshRuntime.js";
import { DurableScheduler } from "./scheduler/durableScheduler.js";

export interface StartAgentHostOptions {
  /**
   * Programmatic transport injection for hermetic acceptance/tests. This is
   * intentionally not read from HTTP or the environment: the production
   * entrypoint below calls startAgentHost() with no overrides.
   */
  runtime?: Pick<
    DshRuntimeOptions,
    "adapter" | "installOfficialWebSearch" | "webSearchProvider"
  >;
}

export async function startAgentHost(options: StartAgentHostOptions = {}) {
  await hardenLocalEnvFile();
  const config = loadAgentHostConfig();
  const ledger = new AuditLedger(config.stateDir);
  const domain = new DomainClient(config.domainBaseUrl, config.domainTimeoutMs);
  const history = new HistoryService(config.domainBaseUrl);
  const desktop = new DesktopStore(desktopDatabasePath(config.stateDir));
  const runtime = new DshRuntime({
    desktop,
    history,
    config,
    ledger,
    domain,
    ...options.runtime,
  });
  const jobs = new RunJobStore(runtime, ledger);
  history.attach(jobs,()=>runtime.providerConfigured,()=>({provider:runtime.provider,model:runtime.model}));
  const scheduler = new DurableScheduler(
    domain,
    jobs,
    ledger,
    config.schedulerPollMs,
  );
  const assertQuiescent = () => {
    if (jobs.hasActiveJobs() || runtime.hasActiveOperations()) {
      throw new AgentAdminError(
        409,
        "agent_runs_active",
        "Wait for active Agent runs to finish before changing or snapshotting local state",
      );
    }
  };
  const admin = new AgentAdminService({
    stateDir: config.stateDir,
    ledger,
    assertQuiescent,
    withQuiescentSnapshot: async (snapshot) => {
      // Stop scheduler admission, wait for an in-flight drain, then re-check
      // user/model activity inside the Admin snapshot fence. HTTP admission is
      // blocked by admin.isSnapshotInProgress for the same interval.
      await history.close();
      await scheduler.close();
      try {
        return await snapshot();
      } finally {
        await scheduler.start();
        await history.start();
      }
    },
    beforeSwap: async () => {
      await history.close();
      await scheduler.close();
      if (jobs.hasActiveJobs() || runtime.hasActiveOperations()) {
        await scheduler.start();
        await history.start();
        throw new AgentAdminError(
          409,
          "agent_runs_active",
          "An Agent run started before local state could be replaced",
        );
      }
      await runtime.close();
    },
  });
  const http = new AgentHttpServer({
    desktop,
    config,
    runtime,
    jobs,
    domain,
    scheduler,
    admin,
    history,
  });
  const address = await http.start();
  await history.start();

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await http.close();
      await history.close();
      await scheduler.close();
      await runtime.close();
      desktop.close();
    })();
    return closing;
  };

  return { address, config, ledger, domain, runtime, jobs, scheduler, admin, http, close };
}

async function main(): Promise<void> {
  const host = await startAgentHost();
  process.stdout.write(`${JSON.stringify({
    service: "latitude-agent-host",
    status: "listening",
    url: host.address.url,
    provider: host.runtime.provider,
    model: host.runtime.model,
    modelConfigured: host.runtime.providerConfigured,
  })}\n`);

  const shutdown = () => {
    void host.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entry === import.meta.url) {
  void main().catch((error: unknown) => {
    const code = error && typeof error === "object"
      ? (error as Record<string, unknown>).code
      : undefined;
    process.stderr.write(`${JSON.stringify({
      service: "latitude-agent-host",
      status: "failed",
      code: typeof code === "string" ? code : "startup_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
