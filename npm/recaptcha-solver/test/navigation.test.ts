// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import type { CdpBrowser } from "../src/browser/cdp/index.js";
import { ChallengeElementNotFoundError } from "../src/challenge/errors.js";
import { ChallengeNavigation } from "../src/challenge/navigation.js";
import type { NavigationClock } from "../src/challenge/navigation.js";

class FakeElement {
  readonly attributes: Record<string, string>;
  readonly children = new Map<string, FakeElement[]>();
  readonly content: string;
  clicks = 0;

  constructor(options: { attributes?: Record<string, string>; content?: string } = {}) {
    this.attributes = options.attributes ?? {};
    this.content = options.content ?? "";
  }

  async attr(name: string): Promise<string | null> {
    return this.attributes[name] ?? null;
  }

  async text(): Promise<string> {
    return this.content;
  }

  async click(): Promise<void> {
    this.clicks += 1;
  }

  async element(selector: string): Promise<FakeElement | undefined> {
    return this.children.get(selector)?.[0];
  }

  async elements(selector: string): Promise<FakeElement[]> {
    return this.children.get(selector) ?? [];
  }
}

class FakeDocument {
  readonly elementsBySelector = new Map<string, FakeElement[]>();

  async element(selector: string): Promise<FakeElement | undefined> {
    return this.elementsBySelector.get(selector)?.[0];
  }

  async elements(selector: string): Promise<FakeElement[]> {
    return this.elementsBySelector.get(selector) ?? [];
  }
}

class FakeBrowser extends FakeDocument {
  readonly frames = new Map<FakeElement, FakeDocument>();

  frame(iframe: FakeElement): FakeDocument {
    const frame = this.frames.get(iframe);
    if (!frame) throw new Error("Missing fake frame.");
    return frame;
  }
}

class FakeClock implements NavigationClock {
  current = 0;
  readonly sleeps: number[] = [];

  now(): number { return this.current; }
  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.current += milliseconds;
  }
}

function fixture(): {
  browser: FakeBrowser;
  checkboxFrame: FakeDocument;
  challengeFrame: FakeDocument;
  elements: Record<string, FakeElement>;
} {
  const browser = new FakeBrowser();
  const checkboxIframe = new FakeElement({
    attributes: { title: "reCAPTCHA", src: "https://www.google.com/recaptcha/api2/anchor" },
  });
  const challengeIframe = new FakeElement({
    attributes: {
      title: "recaptcha challenge expires in two minutes",
      src: "https://www.google.com/recaptcha/api2/bframe",
    },
  });
  // Challenge-first ordering guards against mistaking its reCAPTCHA title for the anchor frame.
  browser.elementsBySelector.set("t:iframe", [challengeIframe, checkboxIframe]);
  const checkboxFrame = new FakeDocument();
  const challengeFrame = new FakeDocument();
  browser.frames.set(checkboxIframe, checkboxFrame);
  browser.frames.set(challengeIframe, challengeFrame);

  const checkbox = new FakeElement();
  const solved = new FakeElement();
  const verify = new FakeElement();
  const reload = new FakeElement();
  const payload = new FakeElement();
  const strong = new FakeElement({ content: "  Buses  " });
  payload.children.set("tag:strong", [strong]);
  const instructions = new FakeElement({ content: "Select all images with buses" });
  const image = new FakeElement({
    attributes: { src: "https://www.google.com/recaptcha/api2/payload?id=one" },
  });
  const unrelatedImage = new FakeElement({ attributes: { src: "https://example.com/logo.png" } });
  const firstTile = new FakeElement();
  const secondTile = new FakeElement();

  checkboxFrame.elementsBySelector.set(".recaptcha-checkbox-border", [checkbox]);
  checkboxFrame.elementsBySelector.set('css:span[aria-checked="true"]', [solved]);
  challengeFrame.elementsBySelector.set("#recaptcha-verify-button", [verify]);
  challengeFrame.elementsBySelector.set("#recaptcha-reload-button", [reload]);
  challengeFrame.elementsBySelector.set(".rc-imageselect-payload", [payload]);
  challengeFrame.elementsBySelector.set(".rc-imageselect-instructions", [instructions]);
  challengeFrame.elementsBySelector.set("#rc-imageselect-target img", [image, unrelatedImage]);
  challengeFrame.elementsBySelector.set(".rc-image-tile-wrapper", [firstTile, secondTile]);

  return {
    browser,
    checkboxFrame,
    challengeFrame,
    elements: { checkbox, solved, verify, reload, payload, strong, image, firstTile, secondTile },
  };
}

function navigation(browser: FakeBrowser, clock = new FakeClock()): ChallengeNavigation {
  return new ChallengeNavigation(browser as unknown as CdpBrowser, {
    defaultTimeoutMs: 100,
    pollIntervalMs: 10,
    clock,
  });
}

test("locates checkbox and challenge frames and clicks their controls", async () => {
  const { browser, elements } = fixture();
  const navigator = navigation(browser);
  assert.ok(await navigator.checkboxFrame());
  assert.ok(await navigator.challengeFrame());
  await navigator.clickCheckbox();
  assert.equal(elements.checkbox?.clicks, 1);
  assert.equal(await navigator.clickVerifyButton(), true);
  assert.equal(await navigator.clickReloadButton(), true);
  assert.equal(elements.verify?.clicks, 1);
  assert.equal(elements.reload?.clicks, 1);
});

test("reads challenge text, payload image URLs and clicks 1-indexed tiles", async () => {
  const { browser, elements } = fixture();
  const navigator = navigation(browser);
  assert.equal(await navigator.targetKeyword(), "buses");
  assert.equal(await navigator.challengeTitle(), "Select all images with buses");
  assert.deepEqual(await navigator.imageUrls(), [
    "https://www.google.com/recaptcha/api2/payload?id=one",
  ]);
  assert.equal(await navigator.clickTile(2), true);
  assert.equal(elements.secondTile?.clicks, 1);
  assert.equal(await navigator.clickTile(0), false);
  assert.equal(await navigator.clickTile(3), false);
});

test("reports solved state and waits through the injected monotonic clock", async () => {
  const { browser } = fixture();
  const clock = new FakeClock();
  const navigator = navigation(browser, clock);
  assert.equal(await navigator.isSolved(), true);
  assert.equal(await navigator.isVerifyButtonDisabled(), false);
  assert.equal(await navigator.waitForVerifyResult(100), true);
  assert.deepEqual(clock.sleeps, [100]);
});

test("returns safe empty values when challenge elements are absent", async () => {
  const browser = new FakeBrowser();
  const navigator = navigation(browser);
  assert.equal(await navigator.checkboxFrame(0), undefined);
  assert.equal(await navigator.challengeFrame(0), undefined);
  assert.equal(await navigator.clickVerifyButton(0), false);
  assert.equal(await navigator.clickReloadButton(0), false);
  assert.equal(await navigator.isSolved(0), false);
  assert.equal(await navigator.targetKeyword(0), undefined);
  assert.equal(await navigator.challengeTitle(0), "");
  assert.deepEqual(await navigator.imageUrls(0), []);
  await assert.rejects(navigator.clickCheckbox(0), ChallengeElementNotFoundError);
});
