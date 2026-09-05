// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CdpBrowser,
  CdpChrome,
  CdpPage,
  CdpConnectionError,
  CdpProtocolError,
  CdpTransport,
  PuppeteerPageChrome,
  validateBrowserWebSocketEndpoint,
  toCssSelector,
} from "../src/browser/cdp/index.js";
import type { PuppeteerPageLike } from "../src/types.js";
import type { CdpCommandTransport, CdpSocket } from "../src/browser/cdp/transport.js";

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

  constructor(readonly options: { hitTarget?: boolean; usableViewport?: boolean } = {}) {}

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
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: this.options.usableViewport === false
        ? { clientWidth: 0, clientHeight: 0 }
        : { clientWidth: 1280, clientHeight: 720 } };
    }
    if (method === "DOM.getContentQuads") {
      return { quads: [[10, 20, 50, 20, 50, 40, 10, 40]] };
    }
    if (method === "DOM.describeNode") return { node: { frameId: "captcha-frame", backendNodeId: 1 } };
    if (method === "DOM.resolveNode") return { object: { type: "object", objectId: "iframe-owner" } };
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
      if (declaration.includes("this.isConnected")) return { result: { type: "boolean", value: true } };
      if (declaration.includes("getAttribute")) return { result: { type: "string", value: "reCAPTCHA challenge" } };
      if (declaration.includes("borderLeftWidth")) return { result: { type: "object", value: { x: 100, y: 200 } } };
      if (declaration.includes("getBoundingClientRect") && params.objectId === "captcha-tile") {
        return { result: { type: "object", value: { left: 10, top: 20, width: 40, height: 20 } } };
      }
      if (declaration.includes("elementFromPoint")) {
        return { result: { type: "boolean", value: this.options.hitTarget !== false } };
      }
      if (declaration.includes("innerText")) return { result: { type: "string", value: "bus" } };
      return { result: { type: "number", value: 1 } };
    }
    throw new Error(`Unexpected CDP command: ${method}`);
  }

  close(): void { this.closed = true; }
}

class FakePuppeteerConnection {
  readonly calls: Call[] = [];
  readonly sessions = new Map<string, FakePuppeteerSession>();

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.calls.push([method, params, undefined]);
    if (method === "Target.detachFromTarget") {
      const session = this.sessions.get(String(params.sessionId));
      if (session) session.detached = true;
      this.sessions.delete(String(params.sessionId));
      return {};
    }
    throw new Error(`Unexpected browser-level CDP command: ${method}`);
  }

  session(sessionId: string): FakePuppeteerSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}

class FakePuppeteerSession {
  readonly calls: Call[] = [];
  detached = false;

  constructor(
    readonly connectionValue: FakePuppeteerConnection | undefined,
    readonly sessionId = "puppeteer-page-session",
  ) {
    connectionValue?.sessions.set(sessionId, this);
  }

  connection(): FakePuppeteerConnection | undefined { return this.connectionValue; }
  id(): string { return this.sessionId; }

  async detach(): Promise<void> {
    this.detached = true;
    this.connectionValue?.sessions.delete(this.sessionId);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.calls.push([method, params, this.sessionId]);
    if (method.endsWith(".enable")) return {};
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "page-target", type: "page" } };
    }
    if (method === "Runtime.evaluate") {
      return { result: { type: "string", value: "https://example.com/sign-in" } };
    }
    throw new Error(`Unexpected session CDP command: ${method}`);
  }
}

class FakePuppeteerPage implements PuppeteerPageLike {
  closed = false;
  readonly connection = new FakePuppeteerConnection();
  readonly session = new FakePuppeteerSession(this.connection);

  async createCDPSession(): Promise<unknown> { return this.session; }
  isClosed(): boolean { return this.closed; }
  url(): string { return "https://example.com/sign-in"; }
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

test("transport accepts verified WSS endpoints and keeps unencrypted WS on loopback", async () => {
  for (const endpoint of [
    "ws://localhost:3000", "ws://127.0.0.1:9222", "ws://[::1]:9222",
    "wss://localhost:3000", "wss://192.0.2.1/devtools/browser/id",
    "wss://production-sfo.browserless.io?token=test%2Btoken%3D&launch=%7B%7D",
  ]) assert.doesNotThrow(() => validateBrowserWebSocketEndpoint(endpoint));
  await assert.rejects(CdpTransport.connect("ws://192.0.2.1/devtools/browser/id"), /loopback/);
  await assert.rejects(CdpTransport.connect("http://localhost:9222"), /must use ws/);
  await assert.rejects(CdpTransport.connect("https://example.com"), /must use ws/);
  await assert.rejects(CdpTransport.connect("wss://example.com/?token=secret#fragment"), /fragment/);
  await assert.rejects(CdpTransport.connect("wss://example.com/#"), /fragment/);
});

test("a shared page session detaches without closing its browser transport", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(
    transport as unknown as CdpTransport,
    "page-target",
    "page-session",
    false,
  );
  await page.close();
  assert.equal(transport.closed, false);
  assert.ok(transport.calls.some(([method, params]) =>
    method === "Target.detachFromTarget" && params.sessionId === "page-session",
  ));
});

test("Puppeteer Page mode reuses and preserves the caller's CDP connection", async () => {
  const page = new FakePuppeteerPage();
  const chrome = await PuppeteerPageChrome.connect(page);
  const browser = await chrome.selectTab("/sign-in");
  assert.equal(await browser.url(), "https://example.com/sign-in");
  assert.equal(page.connection.calls.length, 0);
  assert.ok(page.session.calls.some(([method]) => method === "Target.getTargetInfo"));

  await chrome.close();

  assert.equal(page.session.detached, true);
  assert.deepEqual(page.connection.calls, [[
    "Target.detachFromTarget",
    { sessionId: "puppeteer-page-session" },
    undefined,
  ]]);
});

test("Puppeteer Page mode rejects closed pages, URL mismatches, and missing CDP connections", async () => {
  const closedPage = new FakePuppeteerPage();
  closedPage.closed = true;
  await assert.rejects(PuppeteerPageChrome.connect(closedPage), /already closed/);

  const wrongPage = new FakePuppeteerPage();
  const wrongChrome = await PuppeteerPageChrome.connect(wrongPage);
  try {
    await assert.rejects(wrongChrome.selectTab("/sign-up"), /supplied Puppeteer page URL/);
  } finally {
    await wrongChrome.close();
  }

  const detachedSession = new FakePuppeteerSession(undefined);
  const missingConnectionPage: PuppeteerPageLike = {
    createCDPSession: async () => detachedSession,
    isClosed: () => false,
    url: () => "https://example.com/sign-in",
  };
  await assert.rejects(
    PuppeteerPageChrome.connect(missingConnectionPage),
    /does not expose an underlying CDP Connection/,
  );
  assert.equal(detachedSession.detached, true);
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
  assert.equal(transport.calls.some(([method]) => method === "DOM.scrollIntoViewIfNeeded"), false,
    "reading a frame must not scroll its owner or require a layout object");
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
  assert.equal(transport.calls.some(([method]) => method === "DOM.getContentQuads"), false,
    "session-relative quads must not be treated as coordinates in the checkbox document");

  await browser.close();
  assert.ok(transport.calls.some(([method, params]) =>
    method === "Target.detachFromTarget" && params.sessionId === "captcha-session",
  ));
  assert.ok(transport.calls.some(([method, params]) =>
    method === "Target.detachFromTarget" && params.sessionId === "page-session",
  ));
});

test("frame lookup preserves isolated-world failures instead of querying the default document", async () => {
  const transport = new FakeTransport();
  const original = transport.call.bind(transport);
  const failure = new CdpProtocolError("Page.createIsolatedWorld", "No frame with given id");
  transport.call = async (method, params, options) => {
    if (method === "Page.createIsolatedWorld") throw failure;
    return original(method, params, options);
  };
  const page = await CdpPage.create(transport, "page", "root");
  const browser = CdpBrowser.fromPageForTests(page);
  const owner = await browser.element("iframe");
  await assert.rejects(browser.frame(owner!).element("#recaptcha-anchor", 0), error => error === failure);
  assert.equal(transport.calls.some(([method, params, session]) =>
    method === "Runtime.evaluate" && session === "captcha-session" && String(params.expression).includes("querySelectorAll")), false);
  await browser.close();
});

test("an in-process child of an OOPIF uses its parent session", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport, "page", "root");
  const context = await page.createFrameContext("nested-local-frame", "captcha-session");
  assert.equal(context.sessionId, "captcha-session");
  assert.ok(transport.calls.some(([method, params, session]) =>
    method === "Page.createIsolatedWorld" && params.frameId === "nested-local-frame" && session === "captcha-session"));
  await page.close();
});

test("pinned frame owners resolve by backend identity after sibling locators change", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport, "page", "root");
  const browser = CdpBrowser.fromPageForTests(page);
  const owner = await browser.element("iframe");
  const pinned = await owner!.pin();
  const original = transport.call.bind(transport);
  transport.call = async (method, params = {}, options) => {
    if (method === "Runtime.evaluate" && String(params.expression).includes("querySelectorAll")) {
      throw new Error("The previous iframe index now belongs to a different widget");
    }
    return original(method, params, options);
  };
  assert.equal(await pinned.frameId(), "captcha-frame");
  assert.ok(transport.calls.some(([method, params]) => method === "DOM.resolveNode" && params.backendNodeId === 1));
  await browser.close();
});

test("DOM lookup propagates connection errors without polling until timeout", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport, "page", "root");
  const failure = new CdpConnectionError("Connection closed");
  let calls = 0;
  transport.call = async () => { calls += 1; throw failure; };
  await assert.rejects(CdpBrowser.fromPageForTests(page).element("iframe", 10_000), error => error === failure);
  assert.equal(calls, 1);
});

test("trusted clicks reject covered targets and unusable headless viewports", async () => {
  const coveredTransport = new FakeTransport({ hitTarget: false });
  const coveredPage = await CdpPage.create(
    coveredTransport as unknown as CdpTransport,
    "page-target",
    "page-session",
  );
  await assert.rejects(
    coveredPage.clickObject("captcha-tile", coveredPage.rootContext),
    /covered by another element/,
  );

  const viewportTransport = new FakeTransport({ usableViewport: false });
  const viewportPage = await CdpPage.create(
    viewportTransport as unknown as CdpTransport,
    "page-target",
    "page-session",
  );
  await assert.rejects(
    viewportPage.clickObject("captcha-tile", viewportPage.rootContext),
    /no usable layout viewport/,
  );
});

test("browser JavaScript and cookies stay on the selected page session", async () => {
  const transport = new FakeTransport();
  const page = await CdpPage.create(transport as unknown as CdpTransport, "page-target", "page-session");
  const browser = CdpBrowser.fromPageForTests(page);
  assert.equal(await browser.runJs("return location.href;"), "https://example.com/signup");
  assert.deepEqual(await browser.cookies(), [{ name: "session", value: "cookie" }]);
  assert.equal(transport.calls.find(([method]) => method === "Network.getCookies")?.[2], "page-session");
});

test("port discovery prefers an exact URL and rejects non-loopback WebSockets", async () => {
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
    for (const webSocketDebuggerUrl of [
      "ws://192.0.2.1/devtools/browser/id",
      "wss://production-sfo.browserless.io?token=test",
      "wss://localhost/devtools/browser/id",
    ]) {
      CdpChrome.requestJson = async () => ({ webSocketDebuggerUrl });
      await assert.rejects(CdpChrome.connect(9222), /loopback/);
      await assert.rejects(chrome.isAvailable(), /loopback/);
    }
  } finally {
    CdpChrome.requestJson = originalRequest;
    CdpBrowser.connect = originalConnect;
  }
});

test("direct WebSocket discovery and page attachment reuse one browser transport", async () => {
  const originalTransportConnect = CdpTransport.connect;
  const originalAttach = CdpBrowser.attach;
  const calls: string[] = [];
  let connectedUrl = "";
  let attachedTarget = "";
  let attachedTransport: CdpCommandTransport | undefined;
  let selectedPageClosed = false;
  const transport = {
    closed: false,
    async call(method: string): Promise<Record<string, unknown>> {
      calls.push(method);
      if (method === "Browser.getVersion") return { product: "Chrome/150.0" };
      if (method === "Target.getTargets") return {
        targetInfos: [
          { targetId: "worker", type: "service_worker", url: "https://example.com/sw.js" },
          { targetId: "contains", type: "page", url: "https://example.com/signup?next=1", title: "Contains" },
          { targetId: "exact", type: "page", url: "https://example.com/signup", title: "Exact" },
        ],
      };
      throw new Error(`Unexpected CDP command: ${method}`);
    },
    close(): void { this.closed = true; },
  };
  CdpTransport.connect = async (url) => {
    connectedUrl = url;
    return transport as unknown as CdpTransport;
  };
  CdpBrowser.attach = async (activeTransport, targetId) => {
    attachedTransport = activeTransport;
    attachedTarget = targetId;
    return {
      closed: false,
      ping: async () => undefined,
      close: async () => { selectedPageClosed = true; },
    } as unknown as CdpBrowser;
  };
  try {
    const endpoint = "wss://production-sfo.browserless.io/devtools/browser/session?token=test%2Btoken";
    const chrome = await CdpChrome.connectWebSocket(endpoint);
    await chrome.selectTab("https://example.com/signup");
    assert.equal(connectedUrl, endpoint);
    assert.equal(chrome.timeoutMs, 30_000);
    assert.equal(attachedTransport, transport);
    assert.equal(attachedTarget, "exact");
    assert.equal(chrome.browserVersion, "Chrome/150.0");
    assert.equal(calls.filter((method) => method === "Browser.getVersion").length, 1);
    assert.equal(calls.filter((method) => method === "Target.getTargets").length, 2);
    await assert.rejects(chrome.selectTab("https://example.com/missing"), /existing Puppeteer page.*reconnect endpoint/);
    assert.equal(calls.includes("Target.createTarget"), false);
    assert.equal(calls.includes("Page.navigate"), false);
    await chrome.close();
    assert.equal(selectedPageClosed, true);
    assert.equal(transport.closed, true);
    assert.equal(calls.includes("Browser.close"), false);
    assert.equal(calls.includes("Target.closeTarget"), false);
  } finally {
    CdpTransport.connect = originalTransportConnect;
    CdpBrowser.attach = originalAttach;
  }
});
