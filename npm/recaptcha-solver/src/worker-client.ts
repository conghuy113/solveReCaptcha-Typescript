import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { resolveWorkerBinary, WORKER_PROTOCOL_VERSION } from "./platform.js";
import { ensureModels } from "./models/manager.js";
import type {
  BrowserCookie,
  CompletionReason,
  SolveReCaptchaOptions,
  SolveReCaptchaResult,
  WorkerErrorPayload,
} from "./types.js";

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: WorkerErrorPayload;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(reason: Error): void;
}

interface RefableStream {
  ref?(): void;
  unref?(): void;
}

export class RecaptchaSolverError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(payload: WorkerErrorPayload) {
    super(payload.message);
    this.name = "RecaptchaSolverError";
    this.code = payload.code;
    this.details = payload.details;
  }
}

export class WorkerClient extends EventEmitter {
  readonly #binaryPath: string;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #lines: ReadLineInterface | undefined;
  #ready: Promise<void> | undefined;
  #nextRequestId = 1;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();
  #modelDirectory: string | undefined;

  constructor(binaryPath = resolveWorkerBinary()) {
    super();
    this.#binaryPath = binaryPath;
  }

  async solveReCaptcha(options: SolveReCaptchaOptions): Promise<SolveReCaptchaResult> {
    validateOptions(options);
    return this.#enqueue(async () => {
      const models = await ensureModels();
      this.#modelDirectory = models.directory;
      const raw = await this.#request("solveReCaptcha", {
        target_url: options.targetUrl,
        port: options.port,
        click_checkbox: options.clickCheckbox,
      });
      return mapSolveResult(raw);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    this.#closed = true;
    this.#lines?.close();
    this.#lines = undefined;
    this.#ready = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    this.#rejectAll(new Error("The reCAPTCHA solver worker was closed."));
  }

  async #request(
    command: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      throw new Error("The reCAPTCHA solver worker is closed.");
    }
    await this.#ensureReady();
    return this.#sendRequest(command, params);
  }

  async #ensureReady(): Promise<void> {
    if (!this.#ready) {
      this.#ready = this.#sendRequest("status", {}).then(validateWorkerStatus);
    }
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      throw error;
    }
  }

  #sendRequest(
    command: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const child = this.#ensureStarted();
    this.#setWorkerReferenced(child, true);
    const id = String(this.#nextRequestId++);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, command, params })}\n`, (error) => {
      if (!error) return;
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(error);
      if (this.#pending.size === 0) this.#setWorkerReferenced(child, false);
    });
    return response;
  }

  #ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) {
      return this.#child;
    }

    const child = spawn(this.#binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...(this.#modelDirectory ? { MODEL_DIR: this.#modelDirectory } : {}),
      },
    });
    this.#child = child;
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.emit("log", chunk.toString("utf8")));
    child.once("error", (error) => this.#handleWorkerExit(error));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${String(code)}`;
      this.#handleWorkerExit(new Error(`The reCAPTCHA solver worker exited with ${suffix}.`));
    });
    return child;
  }

  #setWorkerReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
    const method = referenced ? "ref" : "unref";
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as RefableStream)[method]?.();
    }
  }

  #handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch (error) {
      this.#rejectAll(new Error(`Invalid response from reCAPTCHA solver worker: ${line}`, { cause: error }));
      return;
    }

    const pending = this.#pending.get(String(response.id));
    if (!pending) return;
    this.#pending.delete(String(response.id));
    if (response.ok && response.result) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new RecaptchaSolverError(
          response.error ?? {
            code: "INVALID_WORKER_RESPONSE",
            message: "The solver worker returned neither a result nor an error.",
            type: "ProtocolError",
          },
        ),
      );
    }
    if (this.#pending.size === 0 && this.#child) {
      this.#setWorkerReferenced(this.#child, false);
    }
  }

  #handleWorkerExit(error: Error): void {
    this.#lines?.close();
    this.#lines = undefined;
    this.#child = undefined;
    this.#ready = undefined;
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function validateWorkerStatus(raw: Record<string, unknown>): void {
  if (raw.protocol_version !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `Native worker protocol ${String(raw.protocol_version)} does not match SDK protocol ` +
        `${String(WORKER_PROTOCOL_VERSION)}.`,
    );
  }
  if (raw.frozen !== true) {
    throw new Error("The configured worker is not a frozen native binary.");
  }
  if (typeof raw.worker_pid !== "number" || !Number.isInteger(raw.worker_pid)) {
    throw new Error("The native worker returned an invalid process id.");
  }
}

function validateOptions(options: SolveReCaptchaOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("solveReCaptcha options must be an object.");
  }
  if (typeof options.targetUrl !== "string" || !options.targetUrl.trim()) {
    throw new TypeError("targetUrl must be a non-empty string.");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new TypeError("port must be an integer between 1 and 65535.");
  }
  if (typeof options.clickCheckbox !== "boolean") {
    throw new TypeError("clickCheckbox must be a boolean.");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid worker field: ${field}.`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid worker field: ${field}.`);
  }
  return value;
}

export function mapSolveResult(raw: Record<string, unknown>): SolveReCaptchaResult {
  if (raw.status !== "success") throw new TypeError("Invalid worker field: status.");
  const token = raw.token;
  if (token !== null && typeof token !== "string") {
    throw new TypeError("Invalid worker field: token.");
  }
  if (!Array.isArray(raw.cookies)) throw new TypeError("Invalid worker field: cookies.");
  if (typeof raw.click_checkbox !== "boolean") {
    throw new TypeError("Invalid worker field: click_checkbox.");
  }
  const completionReason = requiredString(raw.completion_reason, "completion_reason");
  if (!["token_found", "url_changed", "checkbox_solved"].includes(completionReason)) {
    throw new TypeError("Invalid worker field: completion_reason.");
  }

  return {
    status: "success",
    message: requiredString(raw.message, "message"),
    clickCheckbox: raw.click_checkbox,
    token,
    captchaType: requiredString(
      raw.captcha_type,
      "captcha_type",
    ) as SolveReCaptchaResult["captchaType"],
    attempts: requiredNumber(raw.attempts, "attempts"),
    timeTaken: requiredNumber(raw.time_taken, "time_taken"),
    cookies: raw.cookies as BrowserCookie[],
    currentUrl: requiredString(raw.current_url, "current_url"),
    completionReason: completionReason as CompletionReason,
  };
}
