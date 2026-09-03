// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import type { CdpFrame } from "../src/browser/cdp/index.js";
import { CaptchaHandlers } from "../src/challenge/handlers.js";
import type { ImageChallengeType } from "../src/challenge/handlers.js";
import {
  SolverTimeoutError,
  determineChallengeType,
  solveReCaptchaWithDependencies,
  validateSolveOptions,
} from "../src/solver.js";
import type {
  HandlerSolver,
  SolverBrowser,
  SolverChrome,
  SolverClock,
  SolverDependencies,
  SolverNavigation,
} from "../src/solver.js";
import type { SolveReCaptchaOptions } from "../src/types.js";

const fakePuppeteerPage = {
  createCDPSession: async (): Promise<unknown> => ({}),
  isClosed: (): boolean => false,
  url: (): string => "https://example.com/form",
};

function invalidOptions(value: unknown): SolveReCaptchaOptions {
  return value as SolveReCaptchaOptions;
}

class FakeClock implements SolverClock {
  current = 0;
  now(): number { return this.current; }
  async sleep(milliseconds: number): Promise<void> { this.current += milliseconds; }
}

class FakeBrowser implements SolverBrowser {
  currentUrl = "https://example.com/form";
  token = "";
  async url(): Promise<string> { return this.currentUrl; }
  async runJs(): Promise<unknown> { return this.token; }
  async cookies(): Promise<Array<Record<string, unknown>>> {
    return [{ name: "session", value: "cookie", httpOnly: true }, { name: 3, value: "invalid" }];
  }
}

class FakeChrome implements SolverChrome {
  closed = false;
  constructor(readonly browser: FakeBrowser) {}
  async selectTab(): Promise<SolverBrowser> { return this.browser; }
  async close(): Promise<void> { this.closed = true; }
}

class CloseAwareBrowser extends FakeBrowser {
  connectionClosed = false;

  async #afterCdpResponse<T>(value: T): Promise<T> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.connectionClosed) {
      throw new Error("Chrome DevTools connection was closed.");
    }
    return value;
  }

  override async url(): Promise<string> {
    return this.#afterCdpResponse(this.currentUrl);
  }

  override async cookies(): Promise<Array<Record<string, unknown>>> {
    return this.#afterCdpResponse([
      { name: "session", value: "cookie", httpOnly: true },
    ]);
  }
}

class CloseAwareChrome extends FakeChrome {
  constructor(readonly closeAwareBrowser: CloseAwareBrowser) {
    super(closeAwareBrowser);
  }

  override async close(): Promise<void> {
    this.closeAwareBrowser.connectionClosed = true;
    await super.close();
  }
}

class FakeNavigation implements SolverNavigation {
  solved = false;
  verifyClicked = true;
  reloads = 0;
  checkboxClicks = 0;
  title = "Select all images with buses";
  keyword: string | undefined = "buses";

  async clickCheckbox(): Promise<void> { this.checkboxClicks += 1; }
  async challengeFrame(): Promise<CdpFrame | undefined> { return {} as CdpFrame; }
  async clickVerifyButton(): Promise<boolean> { return this.verifyClicked; }
  async clickReloadButton(): Promise<boolean> { this.reloads += 1; return true; }
  async isSolved(): Promise<boolean> { return this.solved; }
  async waitForVerifyResult(): Promise<boolean> { return this.solved; }
  async targetKeyword(): Promise<string | undefined> { return this.keyword; }
  async challengeTitle(): Promise<string> { return this.title; }
  async imageUrls(): Promise<string[]> { return []; }
  async clickTile(_cell: number): Promise<boolean> { return true; }
}

class FakeHandlers implements HandlerSolver {
  readonly calls: Array<{ type: ImageChallengeType; keyword: string }> = [];
  cells = [1, 2, 3];
  async solve(type: ImageChallengeType, keyword: string): Promise<number[]> {
    this.calls.push({ type, keyword });
    return this.cells;
  }
}

function dependencies(options: {
  browser?: FakeBrowser;
  navigation?: FakeNavigation;
  handlers?: FakeHandlers;
  maxAttempts?: number;
} = {}): { dependencies: SolverDependencies; chrome: FakeChrome; navigation: FakeNavigation; handlers: FakeHandlers } {
  const browser = options.browser ?? new FakeBrowser();
  const chrome = new FakeChrome(browser);
  const navigation = options.navigation ?? new FakeNavigation();
  const fakeHandlers = options.handlers ?? new FakeHandlers();
  return {
    chrome,
    navigation,
    handlers: fakeHandlers,
    dependencies: {
      connectChrome: async () => chrome,
      loadRuntime: async () => ({
        classification: { classifyGrid: async () => [] },
        detection: { detectGridCells: async () => [] },
      }),
      createNavigation: () => navigation,
      createHandlers: () => fakeHandlers,
      clock: new FakeClock(),
      defaultTimeoutMs: 1_000,
      maxAttempts: options.maxAttempts ?? 2,
    },
  };
}

test("validates the stable public options contract", () => {
  const valid: SolveReCaptchaOptions = {
    targetUrl: "https://example.com",
    port: 9222,
    clickCheckbox: true,
  };
  assert.doesNotThrow(() => validateSolveOptions(valid));
  assert.doesNotThrow(() => validateSolveOptions({
    ...valid,
    confidence: {},
  }));
  assert.doesNotThrow(() => validateSolveOptions({
    ...valid,
    confidence: {
      classificationMinConfidence: 0,
      detectionConfidence: 1,
    },
  }));
  assert.throws(() => validateSolveOptions({ targetUrl: "", port: 9222, clickCheckbox: true }), /targetUrl/);
  assert.throws(() => validateSolveOptions({ targetUrl: "x", port: 0, clickCheckbox: true }), /port/);
  assert.throws(
    () => validateSolveOptions(invalidOptions({ targetUrl: "x", clickCheckbox: true })),
    /Exactly one/,
  );
  assert.doesNotThrow(() => validateSolveOptions({
    targetUrl: "https://example.com",
    browserWSEndpoint: "ws://localhost:3000",
    clickCheckbox: true,
  }));
  assert.doesNotThrow(() => validateSolveOptions({
    page: fakePuppeteerPage,
    clickCheckbox: true,
  }));
  assert.doesNotThrow(() => validateSolveOptions({
    page: fakePuppeteerPage,
    targetUrl: "/form",
    clickCheckbox: true,
  }));
  for (const value of [
    { targetUrl: "x", port: 9222, browserWSEndpoint: "ws://localhost:3000", clickCheckbox: true },
    { page: fakePuppeteerPage, port: 9222, clickCheckbox: true },
    { page: fakePuppeteerPage, browserWSEndpoint: "ws://localhost:3000", clickCheckbox: true },
  ]) {
    assert.throws(
      () => validateSolveOptions(invalidOptions(value)),
      /Exactly one of browserWSEndpoint, page, or port/,
    );
  }
  assert.throws(
    () => validateSolveOptions(invalidOptions({ page: {}, clickCheckbox: true })),
    /compatible Puppeteer Page/,
  );
  assert.throws(
    () => validateSolveOptions({ page: fakePuppeteerPage, targetUrl: "", clickCheckbox: true }),
    /targetUrl/,
  );
  for (const browserWSEndpoint of [
    "",
    "http://localhost:3000",
    "wss://localhost:3000",
    "ws://192.0.2.1:3000",
    "not-a-url",
  ]) {
    assert.throws(
      () => validateSolveOptions({ targetUrl: "x", browserWSEndpoint, clickCheckbox: true }),
      /browserWSEndpoint|WebSocket|loopback|ws:\/\//,
    );
  }

  const withInvalidConfidence = (confidence: unknown): SolveReCaptchaOptions => ({
    ...valid,
    confidence,
  } as SolveReCaptchaOptions);
  for (const invalid of [null, [], "0.2", 0.2, new Date()]) {
    assert.throws(
      () => validateSolveOptions(withInvalidConfidence(invalid)),
      /confidence must be an object/,
    );
  }
  for (const invalid of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.2"]) {
    assert.throws(
      () => validateSolveOptions(withInvalidConfidence({
        classificationMinConfidence: invalid,
      })),
      /classificationMinConfidence/,
    );
  }
  assert.throws(
    () => validateSolveOptions(withInvalidConfidence({ detectionConfidense: 0.7 })),
    /Unsupported confidence option: detectionConfidense/,
  );
  assert.throws(
    () => validateSolveOptions(withInvalidConfidence({ detectionConfidence: -0.01 })),
    /detectionConfidence/,
  );
});

test("determines the three supported image challenge types", () => {
  assert.equal(determineChallengeType("Select all squares with buses"), "square_4x4");
  assert.equal(determineChallengeType("Click verify once there are none left"), "dynamic_3x3");
  assert.equal(determineChallengeType("Select all images with buses"), "selection_3x3");
});

test("allows only one active solve per Puppeteer Page and releases the lock after failure", async () => {
  const fixture = dependencies();
  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const pageOptions: SolveReCaptchaOptions = {
    page: fakePuppeteerPage,
    clickCheckbox: true,
  };
  const first = solveReCaptchaWithDependencies(pageOptions, {
    ...fixture.dependencies,
    connectChrome: async () => {
      await connectGate;
      throw new Error("intentional connection failure");
    },
  });

  await Promise.resolve();
  await assert.rejects(
    solveReCaptchaWithDependencies(pageOptions, fixture.dependencies),
    /already being used by another solveReCaptcha call/,
  );

  releaseConnect();
  await assert.rejects(first, /intentional connection failure/);
  await assert.rejects(
    solveReCaptchaWithDependencies(pageOptions, {
      ...fixture.dependencies,
      connectChrome: async () => { throw new Error("second connection failure"); },
    }),
    /second connection failure/,
  );
});

test("returns immediately when the checkbox produces a new token and solved state", async () => {
  const browser = new FakeBrowser();
  const navigation = new FakeNavigation();
  navigation.clickCheckbox = async () => {
    navigation.checkboxClicks += 1;
    navigation.solved = true;
    browser.token = "token-value";
  };
  const fixture = dependencies({ browser, navigation });
  const output = await solveReCaptchaWithDependencies(
    {
      targetUrl: "https://example.com/form",
      port: 9222,
      clickCheckbox: true,
      confidence: {
        classificationMinConfidence: 0.4,
        detectionConfidence: 0.8,
      },
    },
    fixture.dependencies,
  );
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.status, "success");
  assert.equal(output.verification, "widget_and_token_confirmed");
  assert.equal(output.captchaType, "no_challenge");
  assert.equal(output.token, "token-value");
  assert.equal("confidence" in output, false);
  assert.deepEqual(output.cookies, [{ name: "session", value: "cookie", httpOnly: true }]);
  assert.equal(fixture.navigation.checkboxClicks, 1);
  assert.equal(fixture.chrome.closed, true);
});

test("finishes reading result metadata before closing the CDP connection", async () => {
  const browser = new CloseAwareBrowser();
  const chrome = new CloseAwareChrome(browser);
  const navigation = new FakeNavigation();
  navigation.clickCheckbox = async () => {
    navigation.checkboxClicks += 1;
    navigation.solved = true;
    browser.token = "token-value";
  };
  const fixture = dependencies({ browser, navigation });
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: true },
    {
      ...fixture.dependencies,
      connectChrome: async () => chrome,
    },
  );
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.status, "success");
  assert.equal(output.verification, "widget_and_token_confirmed");
  assert.equal(output.currentUrl, "https://example.com/form");
  assert.deepEqual(output.cookies, [{ name: "session", value: "cookie", httpOnly: true }]);
  assert.equal(chrome.closed, true);
});

test("orchestrates an image handler and returns the verified token", async () => {
  const browser = new FakeBrowser();
  const navigation = new FakeNavigation();
  const fixture = dependencies({ browser, navigation });
  navigation.clickVerifyButton = async () => {
    browser.token = "verified-token";
    navigation.solved = true;
    return true;
  };
  let handlerConfidence: {
    classificationMinConfidence: number;
    detectionConfidence: number;
  } | undefined;
  const output = await solveReCaptchaWithDependencies(
    {
      targetUrl: "https://example.com/form",
      port: 9222,
      clickCheckbox: false,
      confidence: { detectionConfidence: 0.75 },
    },
    {
      ...fixture.dependencies,
      createHandlers: (_navigation, _classification, _detection, confidence) => {
        handlerConfidence = confidence;
        return fixture.handlers;
      },
    },
  );
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.status, "success");
  assert.equal(output.verification, "widget_and_token_confirmed");
  assert.equal(output.captchaType, "selection_3x3");
  assert.equal(output.attempts, 1);
  assert.equal(output.token, "verified-token");
  assert.deepEqual(handlerConfidence, {
    classificationMinConfidence: 0.2,
    detectionConfidence: 0.75,
  });
  assert.deepEqual(output.confidence, { detectionConfidence: 0.75 });
  assert.deepEqual(fixture.handlers.calls, [{ type: "selection_3x3", keyword: "buses" }]);
  assert.equal(fixture.chrome.closed, true);
});

test("integrates orchestration, target mapping, ranking, and tile clicks without a worker", async () => {
  const browser = new FakeBrowser();
  const navigation = new FakeNavigation();
  const clock = new FakeClock();
  const clicked: number[] = [];
  navigation.imageUrls = async () => [
    "https://www.google.com/recaptcha/api2/payload?id=selection-grid",
  ];
  navigation.clickTile = async (cell) => {
    clicked.push(cell);
    return true;
  };
  navigation.clickVerifyButton = async () => {
    browser.token = "integrated-token";
    navigation.solved = true;
    return true;
  };
  const chrome = new FakeChrome(browser);
  const output = await solveReCaptchaWithDependencies(
    {
      targetUrl: "https://example.com/form",
      port: 9222,
      clickCheckbox: false,
      confidence: {
        classificationMinConfidence: 0.7,
        detectionConfidence: 0.77,
      },
    },
    {
      connectChrome: async () => chrome,
      loadRuntime: async () => ({
        classification: {
          classifyGrid: async () => [
            { cell: 1, confidence: 0.1 },
            { cell: 2, confidence: 0.95 },
            { cell: 3, confidence: 0.8 },
            { cell: 4, confidence: 0.75 },
          ],
        },
        detection: { detectGridCells: async () => [] },
      }),
      createNavigation: () => navigation,
      createHandlers: (activeNavigation, classification, detection, confidence) => new CaptchaHandlers(
        activeNavigation,
        classification,
        detection,
        {
          clock,
          defaultTimeoutMs: 1_000,
          minConfidence: confidence.classificationMinConfidence,
          detectionConfidence: confidence.detectionConfidence,
          downloadImage: async () => Buffer.from("fixture"),
        },
      ),
      clock,
      defaultTimeoutMs: 1_000,
      maxAttempts: 1,
    },
  );
  assert.deepEqual(clicked, [2, 3, 4]);
  assert.equal(output.token, "integrated-token");
  assert.equal(output.captchaType, "selection_3x3");
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.status, "success");
  assert.equal(output.verification, "widget_and_token_confirmed");
  assert.deepEqual(output.confidence, {
    classificationMinConfidence: 0.7,
    detectionConfidence: 0.77,
  });
  assert.equal(chrome.closed, true);
});

test("reports URL navigation as a successful completion without requiring a token", async () => {
  const browser = new FakeBrowser();
  const navigation = new FakeNavigation();
  const fixture = dependencies({ browser, navigation });
  navigation.clickVerifyButton = async () => {
    browser.currentUrl = "https://example.com/complete";
    return true;
  };
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: false },
    fixture.dependencies,
  );
  assert.equal(output.completionReason, "url_changed");
  assert.equal(output.status, "success");
  assert.equal(output.verification, "navigation_confirmed");
  assert.equal(output.token, null);
  assert.equal(output.currentUrl, "https://example.com/complete");
  assert.equal("confidence" in output, false);
  assert.equal(fixture.chrome.closed, true);
});

test("does not treat a baseline token as a newly solved response", async () => {
  const browser = new FakeBrowser();
  browser.token = "preexisting-token";
  const navigation = new FakeNavigation();
  navigation.solved = true;
  const fixture = dependencies({ browser, navigation });
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: true },
    fixture.dependencies,
  );
  assert.equal(output.status, "unverified");
  assert.equal(output.verification, "widget_observed");
  assert.equal(output.token, null);
});

test("reports a new token without solved widget state as unverified", async () => {
  const browser = new FakeBrowser();
  const navigation = new FakeNavigation();
  const fixture = dependencies({ browser, navigation, maxAttempts: 1 });
  navigation.clickVerifyButton = async () => {
    browser.token = "new-but-unconfirmed-token";
    return true;
  };
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: false },
    fixture.dependencies,
  );
  assert.equal(output.status, "unverified");
  assert.equal(output.verification, "token_observed");
  assert.equal(output.token, "new-but-unconfirmed-token");
});

test("reloads unknown targets and closes CDP when the solve times out", async () => {
  const navigation = new FakeNavigation();
  navigation.keyword = undefined;
  const fixture = dependencies({ navigation, maxAttempts: 1 });
  await assert.rejects(
    solveReCaptchaWithDependencies(
      { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: false },
      fixture.dependencies,
    ),
    SolverTimeoutError,
  );
  assert.equal(navigation.reloads, 1);
  assert.equal(fixture.chrome.closed, true);
});
