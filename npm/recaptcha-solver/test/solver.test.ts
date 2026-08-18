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
  assert.doesNotThrow(() => validateSolveOptions({ targetUrl: "https://example.com", port: 9222, clickCheckbox: true }));
  assert.throws(() => validateSolveOptions({ targetUrl: "", port: 9222, clickCheckbox: true }), /targetUrl/);
  assert.throws(() => validateSolveOptions({ targetUrl: "x", port: 0, clickCheckbox: true }), /port/);
});

test("determines the three supported image challenge types", () => {
  assert.equal(determineChallengeType("Select all squares with buses"), "square_4x4");
  assert.equal(determineChallengeType("Click verify once there are none left"), "dynamic_3x3");
  assert.equal(determineChallengeType("Select all images with buses"), "selection_3x3");
});

test("returns immediately when the checkbox produces a token", async () => {
  const browser = new FakeBrowser();
  browser.token = "token-value";
  const navigation = new FakeNavigation();
  navigation.solved = true;
  const fixture = dependencies({ browser, navigation });
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: true },
    fixture.dependencies,
  );
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.captchaType, "no_challenge");
  assert.equal(output.token, "token-value");
  assert.deepEqual(output.cookies, [{ name: "session", value: "cookie", httpOnly: true }]);
  assert.equal(fixture.navigation.checkboxClicks, 1);
  assert.equal(fixture.chrome.closed, true);
});

test("finishes reading result metadata before closing the CDP connection", async () => {
  const browser = new CloseAwareBrowser();
  browser.token = "token-value";
  const chrome = new CloseAwareChrome(browser);
  const navigation = new FakeNavigation();
  navigation.solved = true;
  const fixture = dependencies({ browser, navigation });
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: true },
    {
      ...fixture.dependencies,
      connectChrome: async () => chrome,
    },
  );
  assert.equal(output.completionReason, "token_found");
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
    return true;
  };
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: false },
    fixture.dependencies,
  );
  assert.equal(output.completionReason, "token_found");
  assert.equal(output.captchaType, "selection_3x3");
  assert.equal(output.attempts, 1);
  assert.equal(output.token, "verified-token");
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
    return true;
  };
  const chrome = new FakeChrome(browser);
  const output = await solveReCaptchaWithDependencies(
    { targetUrl: "https://example.com/form", port: 9222, clickCheckbox: false },
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
      createHandlers: (activeNavigation, classification, detection) => new CaptchaHandlers(
        activeNavigation,
        classification,
        detection,
        {
          clock,
          defaultTimeoutMs: 1_000,
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
  assert.equal(output.token, null);
  assert.equal(output.currentUrl, "https://example.com/complete");
  assert.equal(fixture.chrome.closed, true);
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
