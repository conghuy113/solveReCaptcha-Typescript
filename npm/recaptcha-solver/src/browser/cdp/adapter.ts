// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as delay } from "node:timers/promises";

import { CdpConnectionError, CdpError, CdpProtocolError } from "./errors.js";
import { CdpTransport, validateBrowserWebSocketEndpoint } from "./transport.js";
import type { CdpCommandTransport } from "./transport.js";

type JsonObject = Record<string, unknown>;

interface LocatorStep {
  selector: string;
  index: number;
}

export interface CdpContext {
  sessionId: string;
  executionContextId?: number;
  offsetX: number;
  offsetY: number;
}

export interface CdpTarget {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface CdpChromeOptions {
  host?: "127.0.0.1" | "localhost" | "::1";
  timeoutMs?: number;
}

export interface CdpWebSocketOptions {
  timeoutMs?: number;
}

export function toCssSelector(selector: string): string {
  for (const prefix of ["tag:", "css:"]) {
    if (selector.startsWith(prefix)) return selector.slice(prefix.length);
  }
  return selector.startsWith("t:") ? selector.slice(2) : selector;
}

function remoteValue(remoteObject: JsonObject): unknown {
  if ("value" in remoteObject) return remoteObject.value;
  if (remoteObject.unserializableValue === "NaN") return Number.NaN;
  if (remoteObject.unserializableValue === "Infinity") return Number.POSITIVE_INFINITY;
  if (remoteObject.unserializableValue === "-Infinity") return Number.NEGATIVE_INFINITY;
  return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function poll<T>(operation: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
    }
    if (Date.now() >= deadline) return undefined;
    await delay(100);
  }
}

export class CdpPage {
  static readonly OBJECT_GROUP = "recaptcha-solver";
  static readonly ISOLATED_WORLD = "recaptcha-solver";

  readonly transport: CdpCommandTransport;
  readonly targetId: string;
  readonly sessionId: string;
  readonly #frameSessions = new Map<string, string>();
  readonly #closeTransportOnClose: boolean;
  #closed = false;

  private constructor(
    transport: CdpCommandTransport,
    targetId: string,
    sessionId: string,
    closeTransportOnClose: boolean,
  ) {
    this.transport = transport;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.#closeTransportOnClose = closeTransportOnClose;
  }

  static async create(
    transport: CdpCommandTransport,
    targetId: string,
    sessionId: string,
    closeTransportOnClose = true,
  ): Promise<CdpPage> {
    const page = new CdpPage(transport, targetId, sessionId, closeTransportOnClose);
    await page.enableSession(sessionId);
    return page;
  }

  get rootContext(): CdpContext {
    return { sessionId: this.sessionId, offsetX: 0, offsetY: 0 };
  }

  get closed(): boolean {
    return this.#closed || this.transport.closed;
  }

  async enableSession(sessionId: string): Promise<void> {
    for (const domain of ["Page", "Runtime", "DOM", "Network"]) {
      await this.transport.call(`${domain}.enable`, {}, { sessionId });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      for (const sessionId of new Set(this.#frameSessions.values())) {
        try {
          await this.transport.call("Target.detachFromTarget", { sessionId });
        } catch (error) {
          if (!(error instanceof CdpError)) throw error;
        }
      }
      this.#frameSessions.clear();
      await this.transport.call("Target.detachFromTarget", { sessionId: this.sessionId });
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
    } finally {
      if (this.#closeTransportOnClose) this.transport.close();
    }
  }

  async ping(): Promise<void> {
    await this.evaluate("1");
  }

  async sessionForFrame(frameId: string): Promise<string> {
    const cached = this.#frameSessions.get(frameId);
    if (cached) {
      try {
        await this.transport.call("Runtime.evaluate", { expression: "1" }, { sessionId: cached });
        return cached;
      } catch (error) {
        if (!(error instanceof CdpError)) throw error;
        this.#frameSessions.delete(frameId);
      }
    }
    const targets = await this.transport.call("Target.getTargets");
    const targetInfos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
    const frameTarget = targetInfos.map(objectValue).find((target) =>
      target?.type === "iframe" && String(target.targetId) === frameId,
    );
    if (!frameTarget) return this.sessionId;
    const attached = await this.transport.call("Target.attachToTarget", { targetId: frameId, flatten: true });
    if (!attached.sessionId) {
      throw new CdpProtocolError("Target.attachToTarget", `Chrome returned no session for iframe target ${frameId}.`);
    }
    const sessionId = String(attached.sessionId);
    this.#frameSessions.set(frameId, sessionId);
    await this.enableSession(sessionId);
    return sessionId;
  }

  async createFrameContext(frameId: string): Promise<CdpContext> {
    const sessionId = await this.sessionForFrame(frameId);
    let result: JsonObject;
    try {
      result = await this.transport.call("Page.createIsolatedWorld", {
        frameId,
        worldName: CdpPage.ISOLATED_WORLD,
        grantUniveralAccess: true,
      }, { sessionId });
    } catch (error) {
      if (error instanceof CdpProtocolError && sessionId !== this.sessionId) {
        return { sessionId, offsetX: 0, offsetY: 0 };
      }
      throw error;
    }
    if (!Number.isInteger(result.executionContextId)) {
      throw new CdpProtocolError("Page.createIsolatedWorld", `Chrome returned no execution context for frame ${frameId}.`);
    }
    return { sessionId, executionContextId: Number(result.executionContextId), offsetX: 0, offsetY: 0 };
  }

  async evaluate(expression: string, context = this.rootContext, returnByValue = true): Promise<unknown> {
    const params: JsonObject = {
      expression,
      awaitPromise: true,
      returnByValue,
      objectGroup: CdpPage.OBJECT_GROUP,
      userGesture: true,
    };
    if (context.executionContextId !== undefined) params.contextId = context.executionContextId;
    const response = await this.transport.call("Runtime.evaluate", params, { sessionId: context.sessionId });
    const exception = objectValue(response.exceptionDetails);
    if (exception) {
      const exceptionObject = objectValue(exception.exception);
      throw new CdpProtocolError(
        "Runtime.evaluate",
        String(exceptionObject?.description ?? exception.text ?? "JavaScript evaluation failed."),
      );
    }
    const result = objectValue(response.result);
    if (!result) return undefined;
    return returnByValue ? remoteValue(result) : result;
  }

  async callFunction(
    objectId: string,
    functionDeclaration: string,
    context: CdpContext,
    args: unknown[] = [],
  ): Promise<unknown> {
    const params: JsonObject = {
      objectId,
      functionDeclaration,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    };
    if (args.length > 0) params.arguments = args.map((value) => ({ value }));
    const response = await this.transport.call("Runtime.callFunctionOn", params, { sessionId: context.sessionId });
    const exception = objectValue(response.exceptionDetails);
    if (exception) {
      throw new CdpProtocolError("Runtime.callFunctionOn", String(exception.text ?? "JavaScript function failed."));
    }
    const result = objectValue(response.result);
    return result ? remoteValue(result) : undefined;
  }

  async releaseObject(objectId: string, context: CdpContext): Promise<void> {
    try {
      await this.transport.call("Runtime.releaseObject", { objectId }, { sessionId: context.sessionId });
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
    }
  }

  async clickObject(objectId: string, context: CdpContext): Promise<void> {
    await this.transport.call("DOM.scrollIntoViewIfNeeded", { objectId }, { sessionId: context.sessionId });
    const metrics = await this.transport.call(
      "Page.getLayoutMetrics",
      {},
      { sessionId: this.sessionId },
    );
    const viewport = objectValue(metrics.cssLayoutViewport) ?? objectValue(metrics.layoutViewport);
    if (!viewport || numberValue(viewport.clientWidth) <= 0 || numberValue(viewport.clientHeight) <= 0) {
      throw new CdpProtocolError("Page.getLayoutMetrics", "The page has no usable layout viewport.");
    }

    let localX: number | undefined;
    let localY: number | undefined;
    try {
      const quadsResponse = await this.transport.call(
        "DOM.getContentQuads",
        { objectId },
        { sessionId: context.sessionId },
      );
      const quads = Array.isArray(quadsResponse.quads) ? quadsResponse.quads : [];
      const quad = quads.find((value): value is number[] =>
        Array.isArray(value) && value.length === 8 && value.every((coordinate) =>
          typeof coordinate === "number" && Number.isFinite(coordinate),
        ),
      );
      if (quad) {
        localX = ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4;
        localY = ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4;
      }
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
    }
    if (localX === undefined || localY === undefined) {
      const geometry = objectValue(await this.callFunction(objectId, `function() {
        if (!(this instanceof Element) || this.getClientRects().length === 0) return null;
        const rect = this.getBoundingClientRect();
        return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
      }`, context));
      if (!geometry) throw new CdpProtocolError("Runtime.callFunctionOn", "Element is not visible.");
      const width = numberValue(geometry.width);
      const height = numberValue(geometry.height);
      if (width <= 0 || height <= 0) {
        throw new CdpProtocolError("Runtime.callFunctionOn", "Element has an empty box.");
      }
      localX = numberValue(geometry.left) + width / 2;
      localY = numberValue(geometry.top) + height / 2;
    }
    const hitTarget = await this.callFunction(objectId, `function(x, y) {
      if (!(this instanceof Element) || this.getClientRects().length === 0) return false;
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element)) return false;
      const target = this.closest('td') || this;
      return target === hit || target.contains(hit) || hit.contains(target);
    }`, context, [localX, localY]);
    if (hitTarget !== true) {
      throw new CdpProtocolError("DOM.getContentQuads", "The click point is covered by another element.");
    }
    const x = context.offsetX + localX;
    const y = context.offsetY + localY;
    const events: JsonObject[] = [
      { type: "mouseMoved", x, y },
      { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    ];
    for (const event of events) {
      await this.transport.call("Input.dispatchMouseEvent", event, { sessionId: this.sessionId });
    }
  }
}

export class CdpElement {
  readonly #page: CdpPage;
  readonly #contextProvider: () => Promise<CdpContext>;
  readonly #locatorPath: readonly LocatorStep[];

  constructor(page: CdpPage, contextProvider: () => Promise<CdpContext>, locatorPath: readonly LocatorStep[]) {
    this.#page = page;
    this.#contextProvider = contextProvider;
    this.#locatorPath = locatorPath;
  }

  resolveExpression(): string {
    return `(() => { const path = ${JSON.stringify(this.#locatorPath)}; let current = document; ` +
      "for (const step of path) { const matches = current.querySelectorAll(step.selector); " +
      "current = matches.item(step.index); if (!current) return null; } return current; })()";
  }

  async resolveObject(): Promise<{ objectId: string; context: CdpContext } | undefined> {
    const context = await this.#contextProvider();
    const remote = objectValue(await this.#page.evaluate(this.resolveExpression(), context, false));
    if (!remote || remote.subtype === "null" || !remote.objectId) return undefined;
    return { objectId: String(remote.objectId), context };
  }

  async waitUntilPresent(timeoutMs: number): Promise<boolean> {
    return (await poll(async () => {
      const resolved = await this.resolveObject();
      if (!resolved) return undefined;
      await this.#page.releaseObject(resolved.objectId, resolved.context);
      return true;
    }, timeoutMs)) ?? false;
  }

  async attr(name: string): Promise<string | null> {
    const value = await poll(async () => {
      const resolved = await this.resolveObject();
      if (!resolved) return undefined;
      try {
        return await this.#page.callFunction(
          resolved.objectId,
          "function(name) { const value = this.getAttribute(name); return value === null ? null : String(value); }",
          resolved.context,
          [name],
        );
      } finally {
        await this.#page.releaseObject(resolved.objectId, resolved.context);
      }
    }, 2_000);
    return value === null || value === undefined ? null : String(value);
  }

  async text(): Promise<string> {
    const value = await poll(async () => {
      const resolved = await this.resolveObject();
      if (!resolved) return undefined;
      try {
        return await this.#page.callFunction(
          resolved.objectId,
          "function() { return String(this.innerText || this.textContent || ''); }",
          resolved.context,
        );
      } finally {
        await this.#page.releaseObject(resolved.objectId, resolved.context);
      }
    }, 2_000);
    return String(value ?? "");
  }

  async interactionState(): Promise<string> {
    const resolved = await this.resolveObject();
    if (!resolved) return "missing";
    try {
      const value = await this.#page.callFunction(
        resolved.objectId,
        `function() {
          const target = this.closest('td') || this;
          const image = this.matches('img') ? this : this.querySelector('img');
          return JSON.stringify({
            connected: Boolean(this.isConnected),
            className: String(target.className || ''),
            ariaChecked: target.getAttribute('aria-checked'),
            ariaPressed: target.getAttribute('aria-pressed'),
            ariaSelected: target.getAttribute('aria-selected'),
            disabled: target.hasAttribute('disabled'),
            imageSource: image ? String(image.getAttribute('src') || '') : ''
          });
        }`,
        resolved.context,
      );
      return typeof value === "string" ? value : JSON.stringify(value ?? null);
    } finally {
      await this.#page.releaseObject(resolved.objectId, resolved.context);
    }
  }

  async click(): Promise<void> {
    let lastError: CdpError | undefined;
    const clicked = await poll(async () => {
      const resolved = await this.resolveObject();
      if (!resolved) return undefined;
      try {
        await this.#page.clickObject(resolved.objectId, resolved.context);
        return true;
      } catch (error) {
        if (!(error instanceof CdpError)) throw error;
        lastError = error;
        return undefined;
      } finally {
        await this.#page.releaseObject(resolved.objectId, resolved.context);
      }
    }, 3_000);
    if (clicked) return;
    throw new CdpError(
      lastError
        ? "Element could not be clicked after repeated DOM updates."
        : "Element was not found while clicking.",
      lastError ? { cause: lastError } : undefined,
    );
  }

  async element(selector: string, timeoutMs = 0): Promise<CdpElement | undefined> {
    const child = new CdpElement(this.#page, this.#contextProvider, [
      ...this.#locatorPath,
      { selector: toCssSelector(selector), index: 0 },
    ]);
    return await child.waitUntilPresent(timeoutMs) ? child : undefined;
  }

  async elements(selector: string): Promise<CdpElement[]> {
    const css = toCssSelector(selector);
    const resolved = await this.resolveObject();
    if (!resolved) return [];
    let count: unknown;
    try {
      count = await this.#page.callFunction(
        resolved.objectId,
        "function(selector) { return this.querySelectorAll(selector).length; }",
        resolved.context,
        [css],
      );
    } finally {
      await this.#page.releaseObject(resolved.objectId, resolved.context);
    }
    return Array.from({ length: Math.max(0, Math.trunc(numberValue(count))) }, (_, index) =>
      new CdpElement(this.#page, this.#contextProvider, [...this.#locatorPath, { selector: css, index }]),
    );
  }

  async frameId(): Promise<string> {
    const resolved = await this.resolveObject();
    if (!resolved) throw new CdpError("Iframe element is no longer present.");
    try {
      const response = await this.#page.transport.call(
        "DOM.describeNode",
        { objectId: resolved.objectId, depth: 0 },
        { sessionId: resolved.context.sessionId },
      );
      const node = objectValue(response.node);
      if (!node?.frameId) throw new CdpProtocolError("DOM.describeNode", "Selected element is not a frame owner.");
      return String(node.frameId);
    } finally {
      await this.#page.releaseObject(resolved.objectId, resolved.context);
    }
  }

  async frameContentOffset(): Promise<readonly [number, number]> {
    const resolved = await this.resolveObject();
    if (!resolved) throw new CdpError("Iframe element is no longer present.");
    try {
      await this.#page.transport.call(
        "DOM.scrollIntoViewIfNeeded",
        { objectId: resolved.objectId },
        { sessionId: resolved.context.sessionId },
      );
      const offset = objectValue(await this.#page.callFunction(resolved.objectId, `function() {
        if (!(this instanceof Element) || this.getClientRects().length === 0) return null;
        const rect = this.getBoundingClientRect(); const style = window.getComputedStyle(this);
        return { x: rect.left + parseFloat(style.borderLeftWidth || '0') + parseFloat(style.paddingLeft || '0'),
          y: rect.top + parseFloat(style.borderTopWidth || '0') + parseFloat(style.paddingTop || '0') };
      }`, resolved.context));
      if (!offset) throw new CdpError("Iframe element is not visible.");
      return [resolved.context.offsetX + numberValue(offset.x), resolved.context.offsetY + numberValue(offset.y)];
    } finally {
      await this.#page.releaseObject(resolved.objectId, resolved.context);
    }
  }
}

class CdpDocument {
  readonly page: CdpPage;
  readonly contextProvider: () => Promise<CdpContext>;

  constructor(page: CdpPage, contextProvider: () => Promise<CdpContext>) {
    this.page = page;
    this.contextProvider = contextProvider;
  }

  async elements(selector: string): Promise<CdpElement[]> {
    const css = toCssSelector(selector);
    const value = await this.page.evaluate(`document.querySelectorAll(${JSON.stringify(css)}).length`, await this.contextProvider());
    return Array.from({ length: Math.max(0, Math.trunc(numberValue(value))) }, (_, index) =>
      new CdpElement(this.page, this.contextProvider, [{ selector: css, index }]),
    );
  }

  async element(selector: string, timeoutMs = 0): Promise<CdpElement | undefined> {
    const element = new CdpElement(this.page, this.contextProvider, [{ selector: toCssSelector(selector), index: 0 }]);
    return await element.waitUntilPresent(timeoutMs) ? element : undefined;
  }
}

export class CdpFrame extends CdpDocument {
  constructor(page: CdpPage, iframe: CdpElement) {
    super(page, async () => {
      const context = await page.createFrameContext(await iframe.frameId());
      const [offsetX, offsetY] = await iframe.frameContentOffset();
      return { ...context, offsetX, offsetY };
    });
  }
}

export class CdpBrowser extends CdpDocument {
  readonly selectedPage: CdpPage;

  private constructor(page: CdpPage) {
    super(page, async () => page.rootContext);
    this.selectedPage = page;
  }

  static async connect(browserWebsocketUrl: string, targetId: string, timeoutMs = 10_000): Promise<CdpBrowser> {
    const transport = await CdpTransport.connect(browserWebsocketUrl, timeoutMs);
    return CdpBrowser.attach(transport, targetId, true);
  }

  static async attach(
    transport: CdpCommandTransport,
    targetId: string,
    closeTransportOnClose = false,
  ): Promise<CdpBrowser> {
    let sessionId: string | undefined;
    try {
      const attached = await transport.call("Target.attachToTarget", { targetId, flatten: true });
      if (!attached.sessionId) {
        throw new CdpProtocolError(
          "Target.attachToTarget",
          `Chrome returned no session for page target ${targetId}.`,
        );
      }
      sessionId = String(attached.sessionId);
      return new CdpBrowser(await CdpPage.create(
        transport,
        targetId,
        sessionId,
        closeTransportOnClose,
      ));
    } catch (error) {
      if (sessionId !== undefined) {
        try {
          await transport.call("Target.detachFromTarget", { sessionId });
        } catch (detachError) {
          if (!(detachError instanceof CdpError)) throw detachError;
        }
      }
      if (closeTransportOnClose) transport.close();
      throw error;
    }
  }

  static fromPageForTests(page: CdpPage): CdpBrowser {
    return new CdpBrowser(page);
  }

  static async fromAttachedSession(
    transport: CdpCommandTransport,
    targetId: string,
    sessionId: string,
  ): Promise<CdpBrowser> {
    return new CdpBrowser(await CdpPage.create(transport, targetId, sessionId, false));
  }

  get closed(): boolean { return this.selectedPage.closed; }
  async url(): Promise<string> { return String(await this.selectedPage.evaluate("location.href") ?? ""); }
  async title(): Promise<string> { return String(await this.selectedPage.evaluate("document.title") ?? ""); }
  async ping(): Promise<void> { await this.selectedPage.ping(); }
  async close(): Promise<void> { await this.selectedPage.close(); }
  frame(iframe: CdpElement): CdpFrame { return new CdpFrame(this.selectedPage, iframe); }
  async runJs(script: string): Promise<unknown> { return this.selectedPage.evaluate(`(function() {\n${script}\n}).call(globalThis)`); }
  async cookies(): Promise<JsonObject[]> {
    const response = await this.selectedPage.transport.call(
      "Network.getCookies",
      { urls: [await this.url()] },
      { sessionId: this.selectedPage.sessionId },
    );
    return Array.isArray(response.cookies)
      ? response.cookies.map(objectValue).filter((item): item is JsonObject => item !== undefined)
      : [];
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function assertLoopbackWebsocket(url: string): void {
  validateBrowserWebSocketEndpoint(url);
}

export class CdpChrome {
  readonly host: "127.0.0.1" | "localhost" | "::1" | undefined;
  readonly port: number | undefined;
  readonly timeoutMs: number;
  readonly address: string | undefined;
  #version: JsonObject;
  #browserWebsocketUrl: string;
  #browserTransport: CdpCommandTransport | undefined;
  #selectedTargetId: string | undefined;
  #selectedTab: CdpBrowser | undefined;

  private constructor(
    timeoutMs: number,
    version: JsonObject,
    browserWebsocketUrl: string,
    port?: number,
    host?: "127.0.0.1" | "localhost" | "::1",
    browserTransport?: CdpCommandTransport,
  ) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.address = port === undefined || host === undefined
      ? undefined
      : host === "::1" ? `[::1]:${String(port)}` : `${host}:${String(port)}`;
    this.#version = version;
    this.#browserWebsocketUrl = browserWebsocketUrl;
    this.#browserTransport = browserTransport;
    assertLoopbackWebsocket(this.#browserWebsocketUrl);
  }

  static async connect(port: number, options: CdpChromeOptions = {}): Promise<CdpChrome> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("CDP port must be between 1 and 65535.");
    const host = options.host ?? "127.0.0.1";
    if (!isLoopback(host)) throw new TypeError("CDP connections are restricted to the loopback interface.");
    const timeoutMs = options.timeoutMs ?? 5_000;
    const address = host === "::1" ? `[::1]:${String(port)}` : `${host}:${String(port)}`;
    const version = await CdpChrome.requestJson(address, "/json/version", timeoutMs);
    const versionObject = objectValue(version) ?? {};
    if (!versionObject.webSocketDebuggerUrl) {
      throw new CdpConnectionError("Chrome /json/version response has no browser WebSocket URL.");
    }
    const chrome = new CdpChrome(
      timeoutMs,
      versionObject,
      String(versionObject.webSocketDebuggerUrl),
      port,
      host,
    );
    await chrome.listTabs();
    return chrome;
  }

  static async connectWebSocket(
    browserWebsocketUrl: string,
    options: CdpWebSocketOptions = {},
  ): Promise<CdpChrome> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const transport = await CdpTransport.connect(browserWebsocketUrl, timeoutMs);
    try {
      const version = await transport.call("Browser.getVersion", {}, { timeoutMs });
      const chrome = new CdpChrome(
        timeoutMs,
        { ...version, Browser: version.product },
        browserWebsocketUrl,
        undefined,
        undefined,
        transport,
      );
      await chrome.listTabs();
      return chrome;
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  static async requestJson(address: string, path: string, timeoutMs: number): Promise<unknown> {
    const url = `http://${address}${path}`;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", connection: "close" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CdpConnectionError(
        `Could not read Chrome DevTools endpoint ${url}: ${message}`,
        { cause: error },
      );
    }
  }

  get browserVersion(): string | undefined { return this.#version.Browser ? String(this.#version.Browser) : undefined; }
  get currentTab(): CdpBrowser {
    if (!this.#selectedTab) throw new CdpConnectionError("No Chrome tab has been selected.");
    return this.#selectedTab;
  }
  async currentUrl(): Promise<string> { return this.currentTab.url(); }

  async listTabs(): Promise<CdpTarget[]> {
    const raw = this.#browserTransport
      ? (await this.#browserTransport.call("Target.getTargets", {}, { timeoutMs: this.timeoutMs })).targetInfos
      : await CdpChrome.requestJson(this.address as string, "/json/list", this.timeoutMs);
    if (!Array.isArray(raw)) {
      throw new CdpConnectionError(this.#browserTransport
        ? "Chrome Target.getTargets response has no targetInfos array."
        : "Chrome /json/list response is not an array.");
    }
    return raw.map(objectValue).filter((target): target is JsonObject =>
      target?.type === "page" && Boolean(target.targetId ?? target.id),
    ).map((target) => ({
      id: String(target.targetId ?? target.id),
      url: String(target.url ?? ""),
      title: String(target.title ?? ""),
      active: String(target.targetId ?? target.id) === this.#selectedTargetId,
    }));
  }

  async isAvailable(): Promise<boolean> {
    if (this.#browserTransport) {
      const version = await this.#browserTransport.call("Browser.getVersion", {}, { timeoutMs: this.timeoutMs });
      this.#version = { ...version, Browser: version.product };
      await this.listTabs();
      return true;
    }
    const version = objectValue(await CdpChrome.requestJson(this.address as string, "/json/version", this.timeoutMs));
    if (!version) throw new CdpConnectionError("Chrome /json/version response is not an object.");
    this.#version = version;
    if (version.webSocketDebuggerUrl) {
      const url = String(version.webSocketDebuggerUrl);
      assertLoopbackWebsocket(url);
      this.#browserWebsocketUrl = url;
    }
    await this.listTabs();
    return true;
  }

  async selectTab(targetUrl: string): Promise<CdpBrowser> {
    const tabs = await this.listTabs();
    const target = tabs.find((tab) => tab.url === targetUrl) ?? tabs.find((tab) => tab.url.includes(targetUrl));
    if (!target) throw new CdpConnectionError(`No browser tab URL contains: ${targetUrl}`);
    if (this.#selectedTargetId === target.id && this.#selectedTab && !this.#selectedTab.closed) {
      try { await this.#selectedTab.ping(); return this.#selectedTab; } catch (error) {
        if (!(error instanceof CdpError)) throw error;
        await this.#selectedTab.close();
      }
    }
    if (this.#selectedTab) await this.#selectedTab.close();
    this.#selectedTab = this.#browserTransport
      ? await CdpBrowser.attach(this.#browserTransport, target.id)
      : await CdpBrowser.connect(this.#browserWebsocketUrl, target.id, this.timeoutMs);
    this.#selectedTargetId = target.id;
    return this.#selectedTab;
  }

  async close(): Promise<void> {
    if (this.#selectedTab) await this.#selectedTab.close();
    this.#selectedTab = undefined;
    this.#selectedTargetId = undefined;
    if (this.#browserTransport) this.#browserTransport.close();
    this.#browserTransport = undefined;
  }
}
