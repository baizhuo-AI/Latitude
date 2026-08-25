import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";
import { writeFile } from "node:fs/promises";

const BLOCKED_HOST = "203.0.113.1";
const allowedUrl = requiredUrl("--allowed-url");
const telemetryFile = requiredPath("--telemetry-file");
const blockedUnixSocket = requiredPath("--blocked-unix-socket");

const probes = [];

await expectBlocked("fetch", () => fetch(`https://${BLOCKED_HOST}/`));
await expectBlocked("node:http", () => request(http, `http://${BLOCKED_HOST}/`));
await expectBlocked("node:https", () => request(https, `https://${BLOCKED_HOST}/`));
await expectBlocked("node:net", () => connectSocket(net.connect({ host: BLOCKED_HOST, port: 80 })));
await expectBlocked(
  "node:tls",
  () => connectSocket(tls.connect({ host: BLOCKED_HOST, port: 443, rejectUnauthorized: false })),
);
await expectBlocked("global:WebSocket", () => openWebSocket(`ws://${BLOCKED_HOST}/`));
await expectBlocked("undici:request", async () => {
  const { request: undiciRequest } = await import("undici");
  await undiciRequest(`http://${BLOCKED_HOST}/`);
});
await expectBlocked("undici:Client", async () => {
  const { Client } = await import("undici");
  const client = new Client(`http://${BLOCKED_HOST}`);
  try {
    await client.request({ path: "/", method: "GET" });
  } finally {
    await client.close().catch(() => undefined);
  }
});
await expectChildBlocked();
await expectBlocked(
  "loopback:unknown-port",
  () => connectSocket(net.connect({ host: "127.0.0.1", port: 9 })),
);
await expectBlocked("dns:udp53", sendDnsQuery);
await expectBlocked(
  "unix:outbound",
  () => connectSocket(net.connect({ path: blockedUnixSocket })),
);

const response = await fetch(allowedUrl, { signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`allowed loopback probe returned HTTP ${response.status}`);
await response.arrayBuffer();

const telemetry = {
  schemaVersion: 1,
  mode: "macos-sandbox-exec-network-proof",
  osSandboxEnforced: true,
  externalNetwork: false,
  allowedLoopbackOrigin: allowedUrl.origin,
  allowedLoopbackFetch: true,
  probes,
};
await writeFile(telemetryFile, `${JSON.stringify(telemetry)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(telemetry)}\n`);

async function expectBlocked(label, attempt) {
  const startedAt = Date.now();
  try {
    await withTimeout(Promise.resolve().then(attempt), 5_000, label);
  } catch (error) {
    const code = networkDenialCode(error);
    if (code !== "EPERM" && code !== "EACCES") {
      throw new Error(`${label} failed for a non-sandbox reason: ${errorMessage(error)}`);
    }
    probes.push({ label, blocked: true, code, elapsedMs: Date.now() - startedAt });
    return;
  }
  throw new Error(`${label} unexpectedly established external network access`);
}

function request(module, url) {
  return new Promise((resolve, reject) => {
    const value = module.get(url, { timeout: 3_000 }, (response) => {
      response.resume();
      resolve();
    });
    value.once("error", reject);
    value.once("timeout", () => value.destroy(new Error("request timed out")));
  });
}

function connectSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.setTimeout(3_000, () => socket.destroy(new Error("socket timed out")));
  }).finally(() => socket.destroy());
}

function sendDnsQuery() {
  // A syntactically valid A query for offline.example.test. Using the raw DNS
  // transport keeps the assertion on the OS denial (EPERM), whereas c-ares
  // normalizes the same Seatbelt rejection into ECONNREFUSED.
  const query = Buffer.from(
    "000101000001000000000000076f66666c696e65076578616d706c6504746573740000010001",
    "hex",
  );
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.send(query, 53, "127.0.0.1", (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    let sandboxError;
    const connectErrors = channel("undici:client:connectError");
    const socketErrors = channel("undici:websocket:socket_error");
    const captureConnectError = (message) => {
      sandboxError = message?.error ?? message;
    };
    const captureSocketError = (message) => {
      sandboxError = message?.error ?? message;
    };
    connectErrors.subscribe(captureConnectError);
    socketErrors.subscribe(captureSocketError);
    const cleanup = () => {
      connectErrors.unsubscribe(captureConnectError);
      socketErrors.unsubscribe(captureSocketError);
    };
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      cleanup();
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      cleanup();
      reject(sandboxError ?? event.error ?? new Error("WebSocket was denied by the OS sandbox"));
    }, { once: true });
    setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("WebSocket timed out"));
    }, 3_000).unref();
  });
}

async function expectChildBlocked() {
  const script = [
    "const net=require('node:net');",
    `const socket=net.connect({host:${JSON.stringify(BLOCKED_HOST)},port:80});`,
    "socket.once('connect',()=>process.exit(9));",
    "socket.once('error',(error)=>{",
    "  const code=error?.code;",
    "  process.stdout.write(JSON.stringify({blocked:code==='EPERM'||code==='EACCES',code}));",
    "  process.exit(code==='EPERM'||code==='EACCES'?0:8);",
    "});",
    "setTimeout(()=>process.exit(7),3000);",
  ].join("");
  const result = await spawnResult(process.execPath, ["-e", script]);
  if (result.code !== 0) {
    throw new Error(`child_process network bypass was not OS-denied: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.blocked !== true || !["EPERM", "EACCES"].includes(parsed.code)) {
    throw new Error("child_process network bypass did not return an OS sandbox denial");
  }
  probes.push({ label: "child_process:node-net", blocked: true, code: parsed.code });
}

function spawnResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs).unref();
    }),
  ]);
}

function networkDenialCode(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (typeof value.code === "string") return value.code;
  for (const key of ["cause", "error", "reason", "errors"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const code = networkDenialCode(entry, seen);
        if (code) return code;
      }
    } else {
      const code = networkDenialCode(candidate, seen);
      if (code) return code;
    }
  }
  return undefined;
}

function requiredUrl(name) {
  const raw = requiredArgument(name);
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new TypeError(`${name} must be an explicit 127.0.0.1 HTTP URL`);
  }
  return url;
}

function requiredPath(name) {
  const value = requiredArgument(name);
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}

function requiredArgument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
