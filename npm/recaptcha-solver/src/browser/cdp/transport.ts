// SPDX-License-Identifier: AGPL-3.0-only

import WebSocket, { type RawData } from "ws";

import { CdpConnectionError, CdpProtocolError } from "./errors.js";

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingCommand {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpSocket {
  readonly readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface CdpCallOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface CdpCommandTransport {
  readonly closed: boolean;
  call(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpCallOptions,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

function decodeMessage(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayWebsocketUrl(websocketUrl: string): string {
  try {
    const parsed = new URL(websocketUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid WebSocket URL>";
  }
}

export function validateBrowserWebSocketEndpoint(websocketUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(websocketUrl);
  } catch (error) {
    throw new CdpConnectionError("Invalid Chrome DevTools WebSocket URL.", { cause: error });
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (parsed.protocol !== "ws:") {
    throw new CdpConnectionError("CDP WebSocket endpoints must use ws://.");
  }
  if (!loopback.has(parsed.hostname)) {
    throw new CdpConnectionError("CDP WebSocket connections are restricted to the loopback interface.");
  }
}

export class CdpTransport implements CdpCommandTransport {
  readonly websocketUrl: string;
  readonly timeoutMs: number;
  readonly #socket: CdpSocket;
  readonly #pending = new Map<number, PendingCommand>();
  #nextCommandId = 1;
  #closed = false;

  private constructor(socket: CdpSocket, websocketUrl: string, timeoutMs: number) {
    this.#socket = socket;
    this.websocketUrl = websocketUrl;
    this.timeoutMs = timeoutMs;
    socket.on("message", (data) => this.#receive(data));
    socket.on("close", () => this.#fail(new CdpConnectionError("Chrome closed the DevTools WebSocket connection.")));
    socket.on("error", (error) => this.#fail(new CdpConnectionError(
      `Chrome DevTools WebSocket failed: ${error.message}`,
      { cause: error },
    )));
  }

  static async connect(websocketUrl: string, timeoutMs = 10_000): Promise<CdpTransport> {
    validateBrowserWebSocketEndpoint(websocketUrl);
    const displayedUrl = displayWebsocketUrl(websocketUrl);
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(websocketUrl, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => {
        candidate.terminate();
        reject(new CdpConnectionError(`Timed out opening Chrome DevTools WebSocket ${displayedUrl}.`));
      }, timeoutMs);
      candidate.once("open", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        clearTimeout(timer);
        reject(new CdpConnectionError(`Could not open Chrome DevTools WebSocket ${displayedUrl}: ${error.message}`, { cause: error }));
      });
    });
    return new CdpTransport(socket, websocketUrl, timeoutMs);
  }

  static fromSocketForTests(socket: CdpSocket, timeoutMs = 10_000): CdpTransport {
    return new CdpTransport(socket, "ws://test.invalid", timeoutMs);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpCallOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new CdpConnectionError("Chrome DevTools connection is closed.");
    }
    const id = this.#nextCommandId;
    this.#nextCommandId += 1;
    const payload: Record<string, unknown> = { id, method };
    if (Object.keys(params).length > 0) payload.params = params;
    if (options.sessionId !== undefined) payload.sessionId = options.sessionId;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpConnectionError(`Chrome DevTools command ${method} timed out after ${String(timeoutMs)} ms.`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(payload), (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(new CdpConnectionError(`Chrome DevTools command ${method} failed: ${error.message}`, { cause: error }));
        });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpConnectionError(`Chrome DevTools command ${method} failed: ${errorMessage(error)}`, { cause: error }));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new CdpConnectionError("Chrome DevTools connection was closed."));
    this.#socket.close();
  }

  #receive(data: RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(decodeMessage(data)) as CdpResponse;
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const pending = this.#pending.get(message.id as number);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id as number);
    if (message.error) {
      pending.reject(new CdpProtocolError(pending.method, message.error.message ?? "Unknown CDP error", {
        ...(message.error.code === undefined ? {} : { code: message.error.code }),
        data: message.error.data,
      }));
      return;
    }
    const result = message.result;
    pending.resolve(result !== null && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {});
  }

  #rejectPending(error: CdpConnectionError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #fail(error: CdpConnectionError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    this.#socket.close();
  }
}
