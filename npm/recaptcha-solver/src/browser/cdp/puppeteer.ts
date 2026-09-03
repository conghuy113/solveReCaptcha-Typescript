// SPDX-License-Identifier: AGPL-3.0-only

import type { PuppeteerPageLike } from "../../types.js";
import { CdpBrowser } from "./adapter.js";
import { CdpConnectionError, CdpProtocolError } from "./errors.js";
import type { CdpCallOptions, CdpCommandTransport } from "./transport.js";

type JsonObject = Record<string, unknown>;

interface PuppeteerCdpSession {
  send(method: string, params?: JsonObject, options?: { timeout?: number }): Promise<unknown>;
  connection(): unknown;
  id(): string;
  detach(): Promise<void>;
}

interface PuppeteerConnection {
  send(method: string, params?: JsonObject, options?: { timeout?: number }): Promise<unknown>;
  session(sessionId: string): unknown;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function hasMethod(value: JsonObject, name: string): boolean {
  return typeof value[name] === "function";
}

function asSession(value: unknown, context: string): PuppeteerCdpSession {
  const candidate = objectValue(value);
  if (
    !candidate ||
    !hasMethod(candidate, "send") ||
    !hasMethod(candidate, "connection") ||
    !hasMethod(candidate, "id") ||
    !hasMethod(candidate, "detach")
  ) {
    throw new CdpConnectionError(`${context} did not provide a compatible Puppeteer CDPSession.`);
  }
  return candidate as unknown as PuppeteerCdpSession;
}

function asConnection(value: unknown): PuppeteerConnection {
  const candidate = objectValue(value);
  if (!candidate || !hasMethod(candidate, "send") || !hasMethod(candidate, "session")) {
    throw new CdpConnectionError(
      "The supplied Puppeteer page does not expose an underlying CDP Connection.",
    );
  }
  return candidate as unknown as PuppeteerConnection;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProtocolError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ProtocolError" ||
    error.message.startsWith("Protocol error")
  );
}

/** Adapts Puppeteer's public CDP connection without taking ownership of it. */
export class PuppeteerConnectionTransport implements CdpCommandTransport {
  readonly #connection: PuppeteerConnection;
  readonly #ownerSessionId: string;
  #released = false;

  constructor(connection: unknown, ownerSessionId: string) {
    this.#connection = asConnection(connection);
    this.#ownerSessionId = ownerSessionId;
  }

  get closed(): boolean {
    if (this.#released) return true;
    try {
      return this.#connection.session(this.#ownerSessionId) === null;
    } catch {
      return true;
    }
  }

  async call(
    method: string,
    params: JsonObject = {},
    options: CdpCallOptions = {},
  ): Promise<JsonObject> {
    if (this.#released) {
      throw new CdpConnectionError("The Puppeteer CDP adapter has been released.");
    }
    const commandOptions = options.timeoutMs === undefined
      ? undefined
      : { timeout: options.timeoutMs };
    let sender: PuppeteerCdpSession | PuppeteerConnection = this.#connection;
    if (options.sessionId !== undefined) {
      sender = asSession(
        this.#connection.session(options.sessionId),
        `CDP session ${options.sessionId}`,
      );
    }
    try {
      const response = await sender.send(method, params, commandOptions);
      return objectValue(response) ?? {};
    } catch (error) {
      if (isProtocolError(error)) {
        throw new CdpProtocolError(method, errorMessage(error), { cause: error });
      }
      throw new CdpConnectionError(
        `Chrome DevTools command ${method} failed through Puppeteer: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Releases this adapter only; the shared Puppeteer connection stays open. */
  close(): void {
    this.#released = true;
  }
}

export class PuppeteerPageChrome {
  readonly #browser: CdpBrowser;
  #closed = false;

  private constructor(browser: CdpBrowser) {
    this.#browser = browser;
  }

  static async connect(page: PuppeteerPageLike): Promise<PuppeteerPageChrome> {
    if (page.isClosed()) {
      throw new CdpConnectionError("The supplied Puppeteer page is already closed.");
    }
    const session = asSession(await page.createCDPSession(), "The supplied Puppeteer page");
    try {
      const sessionId = session.id();
      if (!sessionId) {
        throw new CdpConnectionError("Puppeteer returned a CDPSession without an id.");
      }
      const transport = new PuppeteerConnectionTransport(session.connection(), sessionId);
      const response = await transport.call("Target.getTargetInfo", {}, { sessionId });
      const targetInfo = objectValue(response.targetInfo);
      if (!targetInfo?.targetId) {
        throw new CdpConnectionError("Chrome returned no target id for the supplied Puppeteer page.");
      }
      const browser = await CdpBrowser.fromAttachedSession(
        transport,
        String(targetInfo.targetId),
        sessionId,
      );
      return new PuppeteerPageChrome(browser);
    } catch (error) {
      try {
        await session.detach();
      } catch {
        // Preserve the original setup error. The owning Puppeteer connection remains untouched.
      }
      throw error;
    }
  }

  async selectTab(targetUrl?: string): Promise<CdpBrowser> {
    if (this.#closed) {
      throw new CdpConnectionError("The Puppeteer page adapter is closed.");
    }
    const currentUrl = await this.#browser.url();
    if (targetUrl && currentUrl !== targetUrl && !currentUrl.includes(targetUrl)) {
      throw new CdpConnectionError(
        `The supplied Puppeteer page URL does not contain: ${targetUrl} (current URL: ${currentUrl})`,
      );
    }
    return this.#browser;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#browser.close();
  }
}
