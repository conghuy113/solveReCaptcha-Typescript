// SPDX-License-Identifier: AGPL-3.0-only

import { CdpChrome, validateBrowserWebSocketEndpoint } from "./browser/cdp/index.js";
import type { CdpBrowser, CdpFrame } from "./browser/cdp/index.js";
import { LowConfidenceError } from "./challenge/errors.js";
import { CaptchaHandlers } from "./challenge/handlers.js";
import type {
  ClassificationInference,
  DetectionInference,
  HandlerNavigation,
  ImageChallengeType,
} from "./challenge/handlers.js";
import { ChallengeNavigation } from "./challenge/navigation.js";
import { ClassificationModel } from "./inference/classification.js";
import { DetectionModel } from "./inference/detection.js";
import { ensureModels } from "./models/manager.js";
import type {
  BrowserCookie,
  CaptchaType,
  CompletionReason,
  SolveReCaptchaConfidence,
  SolveReCaptchaOptions,
  SolveReCaptchaResult,
  SolveVerification,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_CLASSIFICATION_MIN_CONFIDENCE = 0.2;
const DEFAULT_DETECTION_CONFIDENCE = 0.6;
const CONFIDENCE_OPTION_KEYS = new Set([
  "classificationMinConfidence",
  "detectionConfidence",
]);

interface ResolvedConfidence {
  classificationMinConfidence: number;
  detectionConfidence: number;
}

export class SolverTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolverTimeoutError";
  }
}

export class CaptchaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaNotFoundError";
  }
}

export interface SolverClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface SolverBrowser {
  url(): Promise<string>;
  runJs(script: string): Promise<unknown>;
  cookies(): Promise<Array<Record<string, unknown>>>;
}

export interface SolverChrome {
  selectTab(targetUrl: string): Promise<SolverBrowser>;
  close(): Promise<void>;
}

export interface SolverNavigation extends HandlerNavigation {
  clickCheckbox(timeoutMs?: number): Promise<void>;
  challengeFrame(timeoutMs?: number): Promise<CdpFrame | undefined>;
  clickVerifyButton(timeoutMs?: number): Promise<boolean>;
  clickReloadButton(timeoutMs?: number): Promise<boolean>;
  isSolved(timeoutMs?: number): Promise<boolean>;
  waitForVerifyResult(timeoutMs?: number): Promise<boolean>;
  targetKeyword(timeoutMs?: number): Promise<string | undefined>;
  challengeTitle(timeoutMs?: number): Promise<string>;
}

export interface HandlerSolver {
  solve(type: ImageChallengeType, keyword: string): Promise<number[]>;
}

export interface SolverRuntime {
  classification: ClassificationInference;
  detection: DetectionInference;
}

export interface SolverDependencies {
  connectChrome(options: SolveReCaptchaOptions): Promise<SolverChrome>;
  loadRuntime(): Promise<SolverRuntime>;
  createNavigation(browser: SolverBrowser): SolverNavigation;
  createHandlers(
    navigation: SolverNavigation,
    classification: ClassificationInference,
    detection: DetectionInference,
    confidence: ResolvedConfidence,
  ): HandlerSolver;
  clock: SolverClock;
  defaultTimeoutMs: number;
  maxAttempts: number;
}

const systemClock: SolverClock = {
  now: Date.now,
  async sleep(milliseconds): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

let defaultRuntimePromise: Promise<SolverRuntime> | undefined;

function loadDefaultRuntime(): Promise<SolverRuntime> {
  defaultRuntimePromise ??= ensureModels()
    .then(async (models) => {
      const [classification, detection] = await Promise.all([
        ClassificationModel.create(models.classification),
        DetectionModel.create(models.detection),
      ]);
      return { classification, detection };
    })
    .catch((error: unknown) => {
      defaultRuntimePromise = undefined;
      throw error;
    });
  return defaultRuntimePromise;
}

const defaultDependencies: SolverDependencies = {
  async connectChrome(options): Promise<SolverChrome> {
    return options.browserWSEndpoint !== undefined
      ? CdpChrome.connectWebSocket(options.browserWSEndpoint)
      : CdpChrome.connect(options.port as number);
  },
  loadRuntime: loadDefaultRuntime,
  createNavigation(browser): SolverNavigation {
    return new ChallengeNavigation(browser as CdpBrowser, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });
  },
  createHandlers(navigation, classification, detection, confidence): HandlerSolver {
    return new CaptchaHandlers(navigation, classification, detection, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      minConfidence: confidence.classificationMinConfidence,
      detectionConfidence: confidence.detectionConfidence,
    });
  },
  clock: systemClock,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
};

export function validateSolveOptions(options: SolveReCaptchaOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("solveReCaptcha options must be an object.");
  }
  if (typeof options.targetUrl !== "string" || !options.targetUrl.trim()) {
    throw new TypeError("targetUrl must be a non-empty string.");
  }
  if (options.browserWSEndpoint !== undefined) {
    if (typeof options.browserWSEndpoint !== "string" || !options.browserWSEndpoint.trim()) {
      throw new TypeError("browserWSEndpoint must be a non-empty string when provided.");
    }
    try {
      validateBrowserWebSocketEndpoint(options.browserWSEndpoint);
    } catch (error) {
      throw new TypeError(
        error instanceof Error ? error.message : "browserWSEndpoint is invalid.",
        { cause: error },
      );
    }
  } else if (!Number.isInteger(options.port) || (options.port as number) < 1 || (options.port as number) > 65_535) {
    throw new TypeError("port must be an integer between 1 and 65535 when browserWSEndpoint is omitted.");
  }
  if (typeof options.clickCheckbox !== "boolean") {
    throw new TypeError("clickCheckbox must be a boolean.");
  }
  if (options.confidence !== undefined) {
    if (
      options.confidence === null ||
      typeof options.confidence !== "object" ||
      Array.isArray(options.confidence) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options.confidence))
    ) {
      throw new TypeError("confidence must be an object when provided.");
    }
    for (const key of Reflect.ownKeys(options.confidence)) {
      if (typeof key !== "string" || !CONFIDENCE_OPTION_KEYS.has(key)) {
        throw new TypeError(`Unsupported confidence option: ${String(key)}.`);
      }
    }
    for (const [name, value] of [
      ["classificationMinConfidence", options.confidence.classificationMinConfidence],
      ["detectionConfidence", options.confidence.detectionConfidence],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
      ) {
        throw new TypeError(`${name} must be a finite number between 0 and 1.`);
      }
    }
  }
}

function resolveConfidence(options: SolveReCaptchaOptions): ResolvedConfidence {
  return {
    classificationMinConfidence:
      options.confidence?.classificationMinConfidence ?? DEFAULT_CLASSIFICATION_MIN_CONFIDENCE,
    detectionConfidence:
      options.confidence?.detectionConfidence ?? DEFAULT_DETECTION_CONFIDENCE,
  };
}

function reportedConfidence(options: SolveReCaptchaOptions): SolveReCaptchaConfidence | undefined {
  const configured = options.confidence;
  if (!configured) return undefined;
  const reported: SolveReCaptchaConfidence = {
    ...(configured.classificationMinConfidence === undefined
      ? {}
      : { classificationMinConfidence: configured.classificationMinConfidence }),
    ...(configured.detectionConfidence === undefined
      ? {}
      : { detectionConfidence: configured.detectionConfidence }),
  };
  return Reflect.ownKeys(reported).length > 0 ? reported : undefined;
}

export function determineChallengeType(title: string): ImageChallengeType {
  const normalized = title.toLowerCase();
  if (normalized.includes("squares")) return "square_4x4";
  if (normalized.includes("none")) return "dynamic_3x3";
  return "selection_3x3";
}

async function readTokens(browser: SolverBrowser): Promise<string[]> {
  const value = await browser.runJs(`
    const values = [];
    const elements = document.querySelectorAll(
      'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
    );
    for (const element of elements) {
      if (element && typeof element.value === 'string' && element.value.trim()) {
        values.push(element.value.trim());
      }
    }
    if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.getResponse === 'function') {
      try {
        const response = grecaptcha.getResponse();
        if (typeof response === 'string' && response.trim()) values.push(response.trim());
      } catch (_) {}
    }
    return [...new Set(values)];
  `).catch(() => undefined);
  if (Array.isArray(value)) {
    return [...new Set(value.filter((token): token is string =>
      typeof token === "string" && token.length > 0,
    ))];
  }
  // Keep the injected test/runtime boundary tolerant of older adapters that
  // returned a single token value.
  return typeof value === "string" && value ? [value] : [];
}

function newToken(tokens: readonly string[], baseline: ReadonlySet<string>): string | undefined {
  return tokens.find((token) => !baseline.has(token));
}

function browserCookies(values: Array<Record<string, unknown>>): BrowserCookie[] {
  return values.flatMap((value) => {
    if (typeof value.name !== "string" || typeof value.value !== "string") return [];
    return [{ ...value, name: value.name, value: value.value } as BrowserCookie];
  });
}

async function result(
  browser: SolverBrowser,
  options: SolveReCaptchaOptions,
  startTime: number,
  clock: SolverClock,
  confidence: SolveReCaptchaConfidence | undefined,
  captchaType: CaptchaType,
  attempts: number,
  status: SolveReCaptchaResult["status"],
  completionReason: CompletionReason,
  verification: SolveVerification,
  token?: string,
): Promise<SolveReCaptchaResult> {
  const [cookies, currentUrl] = await Promise.all([browser.cookies(), browser.url()]);
  return {
    status,
    message: status === "success"
      ? "reCAPTCHA solved successfully."
      : "A reCAPTCHA signal was observed, but completion could not be fully verified.",
    clickCheckbox: options.clickCheckbox,
    token: token ?? null,
    captchaType,
    attempts,
    timeTaken: Math.round((clock.now() - startTime) / 10) / 100,
    cookies: browserCookies(cookies),
    currentUrl,
    completionReason,
    verification,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

async function reloadChallenge(
  navigation: SolverNavigation,
  clock: SolverClock,
  timeoutMs: number,
): Promise<void> {
  await navigation.clickReloadButton(timeoutMs);
  await clock.sleep(500);
  await navigation.challengeFrame(timeoutMs);
}

interface Completion {
  status: SolveReCaptchaResult["status"];
  reason: CompletionReason;
  verification: SolveVerification;
  token?: string;
}

async function waitForCompletion(
  browser: SolverBrowser,
  navigation: SolverNavigation,
  clock: SolverClock,
  previousUrl: string,
  baselineTokens: ReadonlySet<string>,
  clickCheckbox: boolean,
  timeoutMs: number,
): Promise<Completion | undefined> {
  const deadline = clock.now() + timeoutMs;
  let observedToken: string | undefined;
  let observedSolved = false;
  while (clock.now() < deadline) {
    const currentUrl = await browser.url();
    if (!clickCheckbox && currentUrl && currentUrl !== previousUrl) {
      return {
        status: "success",
        reason: "url_changed",
        verification: "navigation_confirmed",
      };
    }
    observedToken ??= newToken(await readTokens(browser), baselineTokens);
    observedSolved ||= await navigation.isSolved(Math.min(1_000, timeoutMs));
    if (observedToken && observedSolved) {
      return {
        status: "success",
        reason: "token_found",
        verification: "widget_and_token_confirmed",
        token: observedToken,
      };
    }
    await clock.sleep(200);
  }
  if (observedToken) {
    return {
      status: "unverified",
      reason: "token_found",
      verification: "token_observed",
      token: observedToken,
    };
  }
  if (observedSolved) {
    return {
      status: "unverified",
      reason: "checkbox_solved",
      verification: "widget_observed",
    };
  }
  return undefined;
}

export async function solveReCaptchaWithDependencies(
  options: SolveReCaptchaOptions,
  dependencies: SolverDependencies,
): Promise<SolveReCaptchaResult> {
  validateSolveOptions(options);
  const resolvedConfidence = resolveConfidence(options);
  const configuredConfidence = reportedConfidence(options);
  const startTime = dependencies.clock.now();
  const chrome = await dependencies.connectChrome(options);
  try {
    const browser = await chrome.selectTab(options.targetUrl);
    const navigation = dependencies.createNavigation(browser);
    const baselineTokens = new Set(await readTokens(browser));
    const initialUrl = await browser.url();

    if (options.clickCheckbox) {
      await dependencies.clock.sleep(800);
      await navigation.clickCheckbox(dependencies.defaultTimeoutMs);
      await dependencies.clock.sleep(500);
    } else if (
      !await navigation.challengeFrame(dependencies.defaultTimeoutMs) &&
      !await navigation.isSolved(2_000)
    ) {
      throw new CaptchaNotFoundError("The selected tab has no active reCAPTCHA challenge.");
    }

    if (await navigation.isSolved(2_000)) {
      const completion = await waitForCompletion(
        browser,
        navigation,
        dependencies.clock,
        initialUrl,
        baselineTokens,
        options.clickCheckbox,
        2_000,
      ) ?? {
        status: "unverified" as const,
        reason: "checkbox_solved" as const,
        verification: "widget_observed" as const,
      };
      // Await inside the try block so finally cannot close CDP while result()
      // is still reading cookies and the current URL.
      return await result(
        browser,
        options,
        startTime,
        dependencies.clock,
        undefined,
        "no_challenge",
        0,
        completion.status,
        completion.reason,
        completion.verification,
        completion.token,
      );
    }

    const runtime = await dependencies.loadRuntime();
    const handlers = dependencies.createHandlers(
      navigation,
      runtime.classification,
      runtime.detection,
      resolvedConfidence,
    );
    let lastCaptchaType: CaptchaType = "selection_3x3";

    for (let attempt = 1; attempt <= dependencies.maxAttempts; attempt += 1) {
      try {
        const captchaType = determineChallengeType(
          await navigation.challengeTitle(dependencies.defaultTimeoutMs),
        );
        lastCaptchaType = captchaType;
        const keyword = await navigation.targetKeyword(dependencies.defaultTimeoutMs);
        if (!keyword) {
          await reloadChallenge(navigation, dependencies.clock, dependencies.defaultTimeoutMs);
          continue;
        }
        const clickedCells = await handlers.solve(captchaType, keyword);
        if (clickedCells.length === 0) {
          await reloadChallenge(navigation, dependencies.clock, dependencies.defaultTimeoutMs);
          continue;
        }
        await dependencies.clock.sleep(300);
        const urlBeforeVerify = await browser.url();
        if (!await navigation.clickVerifyButton(dependencies.defaultTimeoutMs)) {
          await dependencies.clock.sleep(500);
          continue;
        }
        await navigation.waitForVerifyResult(dependencies.defaultTimeoutMs);
        const completion = await waitForCompletion(
          browser,
          navigation,
          dependencies.clock,
          urlBeforeVerify,
          baselineTokens,
          options.clickCheckbox,
          dependencies.defaultTimeoutMs,
        );
        if (completion) {
          return await result(
            browser,
            options,
            startTime,
            dependencies.clock,
            configuredConfidence,
            captchaType,
            attempt,
            completion.status,
            completion.reason,
            completion.verification,
            completion.token,
          );
        }
      } catch (error) {
        if (!(error instanceof LowConfidenceError)) throw error;
        await reloadChallenge(navigation, dependencies.clock, dependencies.defaultTimeoutMs);
      }
    }

    const finalToken = newToken(await readTokens(browser), baselineTokens);
    const finalSolved = await navigation.isSolved(2_000);
    if (finalToken && finalSolved) {
      return await result(
        browser,
        options,
        startTime,
        dependencies.clock,
        configuredConfidence,
        lastCaptchaType,
        dependencies.maxAttempts,
        "success",
        "token_found",
        "widget_and_token_confirmed",
        finalToken,
      );
    }
    if (finalToken || finalSolved) {
      return await result(
        browser,
        options,
        startTime,
        dependencies.clock,
        configuredConfidence,
        lastCaptchaType,
        dependencies.maxAttempts,
        "unverified",
        finalToken ? "token_found" : "checkbox_solved",
        finalToken ? "token_observed" : "widget_observed",
        finalToken,
      );
    }
    throw new SolverTimeoutError(
      `reCAPTCHA was not completed after ${String(dependencies.maxAttempts)} attempts.`,
    );
  } finally {
    await chrome.close();
  }
}

export function solveReCaptcha(
  options: SolveReCaptchaOptions,
): Promise<SolveReCaptchaResult> {
  return solveReCaptchaWithDependencies(options, defaultDependencies);
}
