import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { batchEvents, syncOnce } from "./sync-computer-history.mjs";

test("batches oversized segments without dropping events or changing their content", () => {
  const events = Array.from({ length: 2_050 }, (_, id) => ({ id, text: "原始记录".repeat(20) }));
  const pages = batchEvents(events);
  assert.deepEqual(pages.map((page) => page.events.length), [1_000, 1_000, 50]);
  assert.deepEqual(pages.flatMap((page) => page.events), events);
  const bytePages = batchEvents(events.slice(0, 10), 500);
  assert.ok(bytePages.length > 1);
  assert.deepEqual(bytePages.flatMap((page) => page.events), events.slice(0, 10));
});

test("a failed segment does not stop later segments and successful chunks replay idempotently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "latitude-history-batches-"));
  const captured = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    captured.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: { importedEventCount: body.events.length } }));
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  for (const name of ["01-broken", "02-large", "03-small"]) {
    const dir = path.join(root, "segments", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ id: name, startedAt: "2026-09-03T10:00:00Z" }));
    const events = Array.from({ length: name === "02-large" ? 1_050 : 1 }, (_, id) => ({ id, timestamp: "2026-09-03T10:00:00Z", text: "full source" }));
    await writeFile(path.join(dir, "events.jsonl"), name === "01-broken" ? "invalid json" : events.map(JSON.stringify).join("\n"));
  }
  const url = new URL(`http://127.0.0.1:${server.address().port}`);
  const cache = new Set();
  const first = await syncOnce(root, url, cache);
  assert.equal(first.acceptedEvents, 1_051);
  assert.equal(first.acceptedSegments, 2);
  assert.equal(first.failures.length, 1);
  assert.deepEqual(captured.map((body) => body.events.length), [1_000, 50, 1]);
  assert.equal(captured[1].metadata.eventOffset, 1_000);
  assert.equal(captured[1].coverageStatus, "partial");
  const keys = captured.map((body) => body.clientRequestId);
  await syncOnce(root, url, new Set());
  assert.deepEqual(captured.slice(3).map((body) => body.clientRequestId), keys);
  const repeat = await syncOnce(root, url, cache);
  assert.equal(repeat.acceptedEvents, 0);
  assert.equal(repeat.failures.length, 1);
});
