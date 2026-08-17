// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CdpBrowser,
  CdpChrome,
  CdpPage,
  CdpProtocolError,
  CdpTransport,
  toCssSelector,
} from "../src/browser/cdp/index.js";
import type { CdpSocket } from "../src/browser/cdp/transport.js";

class FakeSocket extends EventEmitter implements CdpSocket {
  readonly readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  }

  close(): void {
    this.emit("close");
  }

  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

type Call = [method: string, params: Record<string, unknown>, sessionId: string | undefined];

class FakeTransport {
  readonly calls: Call[] = [];
  closed = false;

  async call(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string } = {},
  ): Promise<Record<string, unknown>> {
    this.calls.push([method, params, options.sessionId]);
    if (method.endsWith(".enable") || [
      "Runtime.releaseObject", "DOM.scrollIntoViewIfNeeded", "Input.dispatchMouseEvent", "Target.detachFromTarget",
    ].includes(method)) return {};
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "captcha-frame", type: "iframe" }] };
    if (method === "Target.attachToTarget") return { sessionId: "captcha-session" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 17 };
    if (method === "DOM.describeNode") return { node: { frameId: "captcha-frame" } };
    if (method === "Network.getCookies") return { cookies: [{ name: "session", value: "cookie" }] };
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "");
      if (expression === "1") return { result: { type: "number", value: 1 } };
      if (expression.includes("location.href")) return { result: { type: "string", value: "https://example.com/signup" } };
      if (expression === "document.title") return { result: { type: "string", value: "Signup" } };
      if (expression.includes("querySelectorAll") && expression.endsWith(".length")) return { result: { type: "number", value: 1 } };
      return { result: { type: "object", objectId: options.sessionId === "captcha-session" ? "captcha-tile" : "iframe-owner" } };
    }
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params.functionDeclaration ?? "");
      if (declaration.includes("getAttribute")) return { result: { type: "string", value: "reCAPTCHA challenge" } };
      if (declaration.includes("borderLeftWidth")) return { result: { type: "object", value: { x: 100, y: 200 } } };
      if (declaration.includes("getBoundingClientRect") && params.objectId === "captcha-tile") {
        return { result: { type: "object", value: { left: 10, top: 20, width: 40, height: 20 } } };
      }
      if (declaration.includes("innerText")) return { result: { type: "string", value: "bus" } };
      return { result: { type: "number", value: 1 } };
    }
    throw new Error(`Unexpected CDP command: ${method}`);
  }

  close(): void { this.closed = true; }
}

test("translates the selector subset used by the solver", () => {
  assert.equal(toCssSelector("t:iframe"), "iframe");
  assert.equal(toCssSelector("tag:strong"), "strong");
  assert.equal(toCssSelector("css:td.rc-imageselect-tile"), "td.rc-imageselect-tile");
  assert.equal(toCssSelector("#recaptcha-verify-button"), "#recaptcha-verify-button");
});

test("transport multiplexes flat-session commands and ignores events", async () => {
  const socket = new FakeSocket();
  const transport = CdpTransport.fromSocketForTests(socket, 3_000);
  const first = transport.call("Runtime.evaluate", { expression: "1" }, { sessionId: "flat-session" });
  const second = transport.call("Runtime.evaluate", { expression: "2" }, { sessionId: "flat-session" });
  assert.deepEqual(socket.sent, [
    { id: 1, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "flat-session" },
    { id: 2, method: "Runtime.evaluate", params: { expression: "2" }, sessionId: "flat-session" },
  ]);
  socket.message({ method: "Runtime.executionContextCreated", params: {} });
  socket.message({ id: 2, result: { value: 8 } });
  socket.message({ id: 1, result: { value: 7 } });
  assert.deepEqual(await first, { value: 7 });
  assert.deepEqual(await second, { value: 8 });
  transport.close();
});

test("transport exposes typed protocol errors", async () => {
  const socket = new FakeSocket();
  const transport = CdpTransport.fromSocketForTests(socket);
  const resultPromise = transport.call("Page.createIsolatedWorld", { frameId: "missing" });
  socket.message({ id: 1, error: { code: -32_000, message: "No frame" } });
  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof CdpProtocolError);
    assert.equal(error.code, -32_000);
    return true;
  });
  transport.close();
});

test("transport refuses non-loopback WebSocket endpoints before connecting", async () => {
  await assert.rejects(CdpTransport.connect("ws://192.0.2.1/devtools/browser/id"), /loopback/);
});

test("OOPIF queries use child sessions while trusted clicks use the root session", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport as unknown as CdpTransport, "page-target", "page-session");
  const browser = CdpBrowser.fromPageForTests(page);
  const iframe = await browser.element("t:iframe");
  assert.ok(iframe);
  assert.equal(await iframe.attr("title"), "reCAPTCHA challenge");
  const frame = browser.frame(iframe);
  const target = await frame.element(".rc-imageselect-payload");
  assert.ok(target);
  const strong = await target.element("tag:strong");
  assert.ok(strong);
  assert.equal(await strong.text(), "bus");
  const tile = await frame.element("#rc-imageselect-target td");
  assert.ok(tile);
  await tile.click();

  assert.deepEqual(transport.calls.filter(([method]) => method === "Target.attachToTarget"), [
    ["Target.attachToTarget", { targetId: "captcha-frame", flatten: true }, undefined],
  ]);
  assert.ok(transport.calls.some(([method, , session]) => method === "Runtime.evaluate" && session === "captcha-session"));
  const mouseCalls = transport.calls.filter(([method]) => method === "Input.dispatchMouseEvent");
  assert.equal(mouseCalls.length, 3);
  assert.ok(mouseCalls.every(([, , session]) => session === "page-session"));
  assert.equal(mouseCalls[0]?.[1].x, 130);
  assert.equal(mouseCalls[0]?.[1].y, 230);
});

test("browser JavaScript and cookies stay on the selected page session", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport as unknown as CdpTransport, "page-target", "page-session");
  const browser = CdpBrowser.fromPageForTests(page);
  assert.equal(await browser.runJs("return location.href;"), "https://example.com/signup");
  assert.deepEqual(await browser.cookies(), [{ name: "session", value: "cookie" }]);
  assert.equal(transport.calls.find(([method]) => method === "Network.getCookies")?.[2], "page-session");
});

test("Chrome discovery prefers an exact URL and rejects non-loopback WebSockets", async () => {
  const originalRequest = CdpChrome.requestJson;
  const originalConnect = CdpBrowser.connect;
  let selectedTarget = "";
  CdpChrome.requestJson = async (_address, path) => path === "/json/version" ? {
    Browser: "Chrome/150.0",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/id",
  } : [
    { id: "worker", type: "service_worker", url: "https://example.com/sw.js" },
    { id: "contains", type: "page", url: "https://example.com/signup?next=1", title: "Contains" },
    { id: "exact", type: "page", url: "https://example.com/signup", title: "Exact" },
  ];
  CdpBrowser.connect = async (_url, targetId) => {
    selectedTarget = targetId;
    return { closed: false, ping: async () => undefined, close: async () => undefined } as unknown as CdpBrowser;
  };
  try {
    await assert.rejects(
      CdpChrome.connect(9222, { host: "192.0.2.1" as "127.0.0.1" }),
      /loopback/,
    );
    const chrome = await CdpChrome.connect(9222);
    await chrome.selectTab("https://example.com/signup");
    assert.equal(selectedTarget, "exact");
    assert.equal(chrome.browserVersion, "Chrome/150.0");
    assert.equal((await chrome.listTabs()).length, 2);
    CdpChrome.requestJson = async () => ({ webSocketDebuggerUrl: "ws://192.0.2.1/devtools/browser/id" });
    await assert.rejects(CdpChrome.connect(9222), /non-loopback/);
  } finally {
    CdpChrome.requestJson = originalRequest;
    CdpBrowser.connect = originalConnect;
  }
});
