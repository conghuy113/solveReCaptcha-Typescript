// SPDX-License-Identifier: AGPL-3.0-only

import { CdpChrome } from "./browser/cdp/index.js";
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
  SolveReCaptchaOptions,
  SolveReCaptchaResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 12;

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
  connectChrome(port: number): Promise<SolverChrome>;
  loadRuntime(): Promise<SolverRuntime>;
  createNavigation(browser: SolverBrowser): SolverNavigation;
  createHandlers(
    navigation: SolverNavigation,
    classification: ClassificationInference,
    detection: DetectionInference,
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
  async connectChrome(port): Promise<SolverChrome> {
    return CdpChrome.connect(port);
  },
  loadRuntime: loadDefaultRuntime,
  createNavigation(browser): SolverNavigation {
    return new ChallengeNavigation(browser as CdpBrowser, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });
  },
  createHandlers(navigation, classification, detection): HandlerSolver {
    return new CaptchaHandlers(navigation, classification, detection, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
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
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new TypeError("port must be an integer between 1 and 65535.");
  }
  if (typeof options.clickCheckbox !== "boolean") {
    throw new TypeError("clickCheckbox must be a boolean.");
  }
}

export function determineChallengeType(title: string): ImageChallengeType {
  const normalized = title.toLowerCase();
  if (normalized.includes("squares")) return "square_4x4";
  if (normalized.includes("none")) return "dynamic_3x3";
  return "selection_3x3";
}

async function readToken(browser: SolverBrowser): Promise<string | undefined> {
  const value = await browser.runJs(`
    const elements = document.querySelectorAll(
      'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
    );
    for (const element of elements) {
      if (element && typeof element.value === 'string' && element.value) return element.value;
    }
    if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.getResponse === 'function') {
      try {
        const response = grecaptcha.getResponse();
        if (response) return response;
      } catch (_) {}
    }
    return '';
  `).catch(() => undefined);
  return typeof value === "string" && value ? value : undefined;
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
  captchaType: CaptchaType,
  attempts: number,
  completionReason: CompletionReason,
  token?: string,
): Promise<SolveReCaptchaResult> {
  const [cookies, currentUrl] = await Promise.all([browser.cookies(), browser.url()]);
  return {
    status: "success",
    message: "reCAPTCHA solved successfully.",
    clickCheckbox: options.clickCheckbox,
    token: token ?? null,
    captchaType,
    attempts,
    timeTaken: Math.round((clock.now() - startTime) / 10) / 100,
    cookies: browserCookies(cookies),
    currentUrl,
    completionReason,
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
  reason: CompletionReason;
  token?: string;
}

async function waitForCompletion(
  browser: SolverBrowser,
  navigation: SolverNavigation,
  clock: SolverClock,
  previousUrl: string,
  timeoutMs: number,
): Promise<Completion | undefined> {
  const deadline = clock.now() + timeoutMs;
  while (clock.now() < deadline) {
    const currentUrl = await browser.url();
    if (currentUrl && currentUrl !== previousUrl) return { reason: "url_changed" };
    const token = await readToken(browser);
    if (token) return { reason: "token_found", token };
    if (await navigation.isSolved(Math.min(1_000, timeoutMs))) {
      return { reason: "checkbox_solved" };
    }
    await clock.sleep(200);
  }
  return undefined;
}

export async function solveReCaptchaWithDependencies(
  options: SolveReCaptchaOptions,
  dependencies: SolverDependencies,
): Promise<SolveReCaptchaResult> {
  validateSolveOptions(options);
  const startTime = dependencies.clock.now();
  const chrome = await dependencies.connectChrome(options.port);
  try {
    const browser = await chrome.selectTab(options.targetUrl);
    const navigation = dependencies.createNavigation(browser);

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
      const token = await readToken(browser);
      return result(
        browser,
        options,
        startTime,
        dependencies.clock,
        "no_challenge",
        0,
        token ? "token_found" : "checkbox_solved",
        token,
      );
    }

    const runtime = await dependencies.loadRuntime();
    const handlers = dependencies.createHandlers(
      navigation,
      runtime.classification,
      runtime.detection,
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
        const completion = await waitForCompletion(
          browser,
          navigation,
          dependencies.clock,
          urlBeforeVerify,
          dependencies.defaultTimeoutMs,
        );
        if (completion) {
          return result(
            browser,
            options,
            startTime,
            dependencies.clock,
            captchaType,
            attempt,
            completion.reason,
            completion.token,
          );
        }
      } catch (error) {
        if (!(error instanceof LowConfidenceError)) throw error;
        await reloadChallenge(navigation, dependencies.clock, dependencies.defaultTimeoutMs);
      }
    }

    const finalToken = await readToken(browser);
    if (finalToken) {
      return result(
        browser,
        options,
        startTime,
        dependencies.clock,
        lastCaptchaType,
        dependencies.maxAttempts,
        "token_found",
        finalToken,
      );
    }
    if (await navigation.isSolved(2_000)) {
      return result(
        browser,
        options,
        startTime,
        dependencies.clock,
        lastCaptchaType,
        dependencies.maxAttempts,
        "checkbox_solved",
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
