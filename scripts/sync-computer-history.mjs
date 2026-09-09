import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const root = options.root ?? process.env.LATITUDE_COMPUTER_HISTORY_ROOT?.trim() ?? path.join(
    homedir(),
    "Library",
    "Group Containers",
    "2DC432GLL2.com.openai.sky.CUAService",
    "Library",
    "Caches",
    "ComputerUse",
    "Skysight",
  );
  const domainUrl = new URL(
    options.domainUrl ?? process.env.LATITUDE_DOMAIN_URL?.trim() ?? "http://127.0.0.1:43121",
  );
  const imported = new Set();

  await waitForDomain(domainUrl);
  do {
    const result = await syncOnce(root, domainUrl, imported, { skipNewest: options.watch });
    console.log(
      `[computer-history] scanned ${result.segments} segments; Domain accepted ${result.acceptedSegments} segments / ${result.acceptedEvents} events (replays are idempotent)${result.deferredSegments ? `; deferred ${result.deferredSegments} active segment` : ""}`,
    );
    if (result.failures.length) {
      console.error(`[computer-history] ${result.failures.length} segments need retry: ${result.failures.map((failure) => failure.segmentName).join(", ")}`);
      if (!options.watch) process.exitCode = 1;
    }
    if (!options.watch) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (true);
}

export async function syncOnce(skysightRoot, baseUrl, processCache, { skipNewest = false } = {}) {
  const segmentsRoot = path.join(skysightRoot, "segments");
  const entries = await readdir(segmentsRoot, { withFileTypes: true });
  const segmentNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // A running Skysight recorder appends to the newest segment. Importing that
  // mutable file would generate a new content hash on every poll and duplicate
  // its earlier events. Watch mode therefore trails by one segment and imports
  // only files that have been closed by the recorder.
  const importableSegmentNames = skipNewest ? segmentNames.slice(0, -1) : segmentNames;
  let acceptedSegments = 0;
  let acceptedEvents = 0;
  const failures = [];
  for (const segmentName of importableSegmentNames) {
    try {
      const segmentDir = path.join(segmentsRoot, segmentName);
      const metadataPath = path.join(segmentDir, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const eventsPath = typeof metadata.eventsPath === "string" && metadata.eventsPath.trim()
        ? metadata.eventsPath
        : path.join(segmentDir, "events.jsonl");
      const file = await readFile(eventsPath);
      if (file.byteLength === 0) continue;
      const contentHash = `sha256:${createHash("sha256").update(file).digest("hex")}`;
      const receiptKey = `${segmentName}:${contentHash}`;
      if (processCache.has(receiptKey)) continue;
      const events = file
        .toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch (error) {
            throw new Error(`Invalid JSON in ${eventsPath} at line ${index + 1}`, { cause: error });
          }
        });
      if (events.length === 0) continue;
      const timestamps = events
        .map((event) => typeof event?.timestamp === "string" ? event.timestamp : undefined)
        .filter(Boolean)
        .sort();
      const startedAt = typeof metadata.startedAt === "string"
        ? metadata.startedAt
        : timestamps[0];
      if (!startedAt) throw new Error(`Computer History segment has no start time: ${segmentName}`);
      const clientRequestId = `computer-history:${segmentName}:${contentHash.slice(-16)}`;
      const batches = batchEvents(events);
      for (const [batchIndex, batch] of batches.entries()) {
        // Preserve old receipt keys for ordinary segments; large segments use
        // stable per-part receipts, so interrupted imports replay without duplicates.
        const batchRequestId = batches.length === 1 ? clientRequestId : `${clientRequestId}:part:${batchIndex}`;
        const response = await fetch(new URL("/v1/evidence/computer-history", baseUrl), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": batchRequestId,
          },
          body: JSON.stringify({
            clientRequestId: batchRequestId,
            segmentId: typeof metadata.id === "string" ? metadata.id : segmentName,
            startedAt,
            endedAt: timestamps.at(-1),
            storageUri: pathToFileURL(eventsPath).href,
            contentHash,
            coverageStatus: batches.length === 1 ? "complete" : "partial",
            collectorVersion: "openai-skysight-jsonl",
            metadata: {
              metadataUri: pathToFileURL(metadataPath).href,
              sourceFileBytes: (await stat(eventsPath)).size,
              ...(batches.length > 1 ? {
                partIndex: batchIndex,
                partCount: batches.length,
                eventOffset: batch.offset,
                originalEventCount: events.length,
                originalSegmentId: segmentName,
              } : {}),
            },
            events: batch.events,
            audit: {
              actor: "importer",
              sessionId: "computer-history-sync",
              turnId: segmentName,
              authorizationMode: "preauthorized",
            },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const raw = await response.text();
        if (!response.ok) {
          throw new Error(
            `Computer History import failed for ${segmentName} (${response.status}): ${raw.slice(0, 800)}`,
          );
        }
        const result = raw ? JSON.parse(raw) : {};
        acceptedEvents += Number(result?.value?.importedEventCount ?? batch.events.length);
      }
      processCache.add(receiptKey);
      acceptedSegments += 1;
    } catch (error) {
      // One corrupt/temporarily failed segment must not hide later evidence.
      // Failed segments are not cached and are retried on the next watch pass.
      failures.push({ segmentName, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    segments: segmentNames.length,
    acceptedSegments,
    acceptedEvents,
    deferredSegments: segmentNames.length - importableSegmentNames.length,
    failures,
  };
}

/** The HTTP body remains bounded; the total segment and event count do not. */
export function batchEvents(events, maxBytes = 15 * 1024 * 1024, pageSize = 1_000) {
  const batches = [];
  let batch = [], bytes = 0, offset = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (size > maxBytes) throw new Error("One event exceeds the import request size; its full source file remains readable via local_file_read");
    if (batch.length && (bytes + size > maxBytes || batch.length >= pageSize)) {
      batches.push({ offset, events: batch });
      offset += batch.length;
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length) batches.push({ offset, events: batch });
  return batches;
}

async function waitForDomain(baseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", baseUrl), {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Latitude Domain is not ready: ${lastError}`);
}

function parseOptions(args) {
  const options = { watch: false, intervalMs: 30_000 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--watch") {
      options.watch = true;
      continue;
    }
    if (argument === "--root" || argument === "--domain-url" || argument === "--interval-ms") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--root") options.root = value;
      if (argument === "--domain-url") options.domainUrl = value;
      if (argument === "--interval-ms") {
        const intervalMs = Number(value);
        if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
          throw new Error("--interval-ms must be an integer of at least 1000");
        }
        options.intervalMs = intervalMs;
      }
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
