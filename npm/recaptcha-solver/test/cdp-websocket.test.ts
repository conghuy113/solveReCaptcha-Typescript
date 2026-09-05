// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { WebSocketServer } from "ws";

import { CdpConnectionError, CdpTransport } from "../src/browser/cdp/index.js";

const certificatePath = fileURLToPath(new URL("./fixtures/tls/localhost-cert.pem", import.meta.url));
const tls = {
  cert: readFileSync(certificatePath),
  key: readFileSync(new URL("./fixtures/tls/localhost-key.pem", import.meta.url)),
};
const transportModule = new URL("../src/browser/cdp/transport.ts", import.meta.url).href;

// Node reads extra CAs at startup. Keep trust changes out of the main test
// process, and leave certificate and hostname verification enabled.
async function trustedClient(source: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `TLS client failed (${String(signal)}): ${output}`);
}

async function fixture(secure: boolean, mode: "cdp" | "unauthorized" | "redirect" | "stall" = "cdp") {
  const server = secure ? createHttpsServer(tls) : createHttpServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  const requests: string[] = [];
  server.on("upgrade", (request, socket, head) => {
    requests.push(request.url ?? "");
    if (mode === "stall") return;
    if (mode === "unauthorized") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "redirect") {
      socket.end("HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:1/leaked?token=secret\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, ws => {
      ws.on("message", data => {
        const command = JSON.parse(String(data));
        ws.send(JSON.stringify({ id: command.id, result: { product: "Chrome/TLS-fixture" } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${secure ? "wss://localhost" : "ws://127.0.0.1"}:${port}`,
    requests,
    async close(): Promise<void> {
      for (const ws of websocketServer.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await new Promise<void>(resolve => websocketServer.close(() => resolve()));
    },
  };
}

test("real WS and trusted WSS preserve session path and encoded token query", async () => {
  const suffix = "/devtools/browser/test-session?token=a%2Bb%2Fc%3D&launch=%7B%22headless%22%3Atrue%7D";
  for (const secure of [false, true]) {
    const server = await fixture(secure);
    try {
      if (secure) {
        await trustedClient(`
          import assert from 'node:assert/strict';
          import { CdpTransport } from ${JSON.stringify(transportModule)};
          const transport = await CdpTransport.connect(${JSON.stringify(server.url + suffix)}, 2000);
          try { assert.deepEqual(await transport.call('Browser.getVersion'), { product: 'Chrome/TLS-fixture' }); }
          finally { transport.close(); }
        `);
      } else {
        const transport = await CdpTransport.connect(server.url + suffix, 2_000);
        try {
          assert.deepEqual(await transport.call("Browser.getVersion"), { product: "Chrome/TLS-fixture" });
        } finally { transport.close(); }
      }
      assert.deepEqual(server.requests, [suffix]);
    } finally { await server.close(); }
  }
});

test("WSS rejects an untrusted certificate and hides session/auth details in the full error", async () => {
  const server = await fixture(true);
  try {
    await assert.rejects(CdpTransport.connect(`${server.url}/private-session?token=private-token`, 2_000), error => {
      assert.ok(error instanceof CdpConnectionError);
      assert.match(error.message, /SELF_SIGNED_CERT|UNABLE_TO_VERIFY/);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /private-session|private-token|BEGIN CERTIFICATE/);
      return true;
    });
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test("trusted WSS still verifies the hostname", async () => {
  const server = await fixture(true);
  try {
    await trustedClient(`
      import assert from 'node:assert/strict';
      import { CdpTransport } from ${JSON.stringify(transportModule)};
      await assert.rejects(CdpTransport.connect(${JSON.stringify(server.url.replace("localhost", "127.0.0.1"))}, 2000), /ERR_TLS_CERT_ALTNAME_INVALID/);
    `);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test("WSS reports HTTP authentication failure and refuses redirects without leaking credentials", async () => {
  for (const [mode, status] of [["unauthorized", 401], ["redirect", 302]] as const) {
    const server = await fixture(true, mode);
    try {
      await trustedClient(`
        import assert from 'node:assert/strict';
        import { inspect } from 'node:util';
        import { CdpTransport } from ${JSON.stringify(transportModule)};
        await assert.rejects(CdpTransport.connect(${JSON.stringify(server.url + "/private-session?token=private-token")}, 2000), error => {
          assert.match(error.message, /HTTP ${status}/);
          assert.doesNotMatch(inspect(error, { depth: 10 }), /private-session|private-token|leaked/);
          return true;
        });
      `);
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  }
});

test("a stalled WSS handshake times out and closes its socket", async () => {
  const server = await fixture(true, "stall");
  try {
    await trustedClient(`
      import assert from 'node:assert/strict';
      import { CdpTransport } from ${JSON.stringify(transportModule)};
      await assert.rejects(CdpTransport.connect(${JSON.stringify(server.url)}, 150), /[Tt]imed out/);
    `);
  } finally { await server.close(); }
});

test("malformed endpoint errors never retain the original token-bearing input", async () => {
  await assert.rejects(CdpTransport.connect("wss://private-user:private-password@?token=private-token"), error => {
    assert.ok(error instanceof CdpConnectionError);
    assert.doesNotMatch(inspect(error, { depth: 10 }), /private-user|private-password|private-token/);
    return true;
  });
});
