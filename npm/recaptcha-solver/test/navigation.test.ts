// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { CdpConnectionError, CdpProtocolError, type CdpBrowser } from "../src/browser/cdp/index.js";
import { CHECKBOX_SELECTOR, SOLVED_CHECKBOX_SELECTOR } from "../src/challenge/constants.js";
import { ChallengeElementNotFoundError } from "../src/challenge/errors.js";
import { ChallengeNavigation } from "../src/challenge/navigation.js";
import type { NavigationClock } from "../src/challenge/navigation.js";

class FakeElement {
  readonly attributes: Record<string, string>;
  readonly children = new Map<string, FakeElement[]>();
  readonly content: string;
  clicks = 0;
  stateVersion = 0;
  stateChangesAfterClicks = 1;
  visible = true;
  async isVisible(): Promise<boolean> { return this.visible; }
  async pin(): Promise<FakeElement> { return this; }
  async frameId(): Promise<string> { return this.attributes.name ?? "fixture-frame"; }

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
    if (this.clicks >= this.stateChangesAfterClicks) this.stateVersion += 1;
  }

  async interactionState(): Promise<string> {
    return JSON.stringify({ attributes: this.attributes, stateVersion: this.stateVersion });
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
    attributes: { title: "reCAPTCHA", src: "https://www.google.com/recaptcha/api2/anchor", name: "a-widget" },
  });
  const challengeIframe = new FakeElement({
    attributes: {
      title: "recaptcha challenge expires in two minutes",
      src: "https://www.google.com/recaptcha/api2/bframe",
      name: "c-widget",
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

  checkboxFrame.elementsBySelector.set(CHECKBOX_SELECTOR, [checkbox]);
  checkboxFrame.elementsBySelector.set(SOLVED_CHECKBOX_SELECTOR, [solved]);
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

test("retries a tile once when the first dispatched click causes no state change", async () => {
  const { browser, elements } = fixture();
  const navigator = navigation(browser);
  if (elements.secondTile) elements.secondTile.stateChangesAfterClicks = 2;
  assert.equal(await navigator.clickTile(2), true);
  assert.equal(elements.secondTile?.clicks, 2);
});

test("does not dispatch more than two clicks when a tile never changes state", async () => {
  const { browser, elements } = fixture();
  const navigator = navigation(browser);
  if (elements.secondTile) elements.secondTile.stateChangesAfterClicks = Number.POSITIVE_INFINITY;
  assert.equal(await navigator.clickTile(2), false);
  assert.equal(elements.secondTile?.clicks, 2);
});

test("retries checkbox and verify interactions once when state does not change", async () => {
  const checkboxFixture = fixture();
  checkboxFixture.checkboxFrame.elementsBySelector.delete(SOLVED_CHECKBOX_SELECTOR);
  checkboxFixture.browser.elementsBySelector.set(
    "t:iframe",
    (checkboxFixture.browser.elementsBySelector.get("t:iframe") ?? []).filter(
      (iframe) => !iframe.attributes.src?.includes("bframe"),
    ),
  );
  checkboxFixture.elements.checkbox!.stateChangesAfterClicks = 2;
  await navigation(checkboxFixture.browser).clickCheckbox();
  assert.equal(checkboxFixture.elements.checkbox?.clicks, 2);

  const verifyFixture = fixture();
  verifyFixture.checkboxFrame.elementsBySelector.delete(SOLVED_CHECKBOX_SELECTOR);
  verifyFixture.elements.verify!.stateChangesAfterClicks = 2;
  assert.equal(await navigation(verifyFixture.browser).clickVerifyButton(), true);
  assert.equal(verifyFixture.elements.verify?.clicks, 2);
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

function prependAnchor(browser: FakeBrowser, name: string, document = new FakeDocument()): FakeElement {
  const owner = new FakeElement({ attributes: {
    name, title: "reCAPTCHA", src: "https://www.google.com/recaptcha/api2/anchor",
  } });
  browser.frames.set(owner, document);
  browser.elementsBySelector.set("t:iframe", [owner, ...browser.elementsBySelector.get("t:iframe") ?? []]);
  return owner;
}

test("skips an empty anchor and hidden owners or controls before the usable checkbox", async () => {
  const { browser, elements } = fixture();
  prependAnchor(browser, "a-empty");
  const hiddenDocument = new FakeDocument();
  const hiddenCheckbox = new FakeElement();
  hiddenCheckbox.visible = false;
  hiddenDocument.elementsBySelector.set(CHECKBOX_SELECTOR, [hiddenCheckbox]);
  prependAnchor(browser, "a-hidden-control", hiddenDocument);
  const hiddenOwner = prependAnchor(browser, "a-hidden-owner");
  hiddenOwner.visible = false;
  browser.frames.get(hiddenOwner)!.element = async () => { throw new Error("Hidden iframe must not be queried"); };
  await navigation(browser).clickCheckbox();
  assert.equal(elements.checkbox?.clicks, 1);
  assert.equal(hiddenCheckbox.clicks, 0);
});

test("finds an enterprise anchor inside another visible iframe without relying on its title", async () => {
  const { browser, checkboxFrame, elements } = fixture();
  const anchor = browser.elementsBySelector.get("t:iframe")![1]!;
  anchor.attributes.title = "";
  anchor.attributes.src = "https://www.recaptcha.net/recaptcha/enterprise/anchor?k=fixture";
  const wrapper = new FakeElement({ attributes: { src: "https://example.com/embedded-form" } });
  const document = new FakeDocument();
  document.elementsBySelector.set("t:iframe", [anchor]);
  browser.frames.set(wrapper, document);
  browser.elementsBySelector.set("t:iframe", [wrapper]);
  const navigator = navigation(browser);
  assert.equal(await navigator.checkboxFrame(), checkboxFrame);
  await navigator.clickCheckbox();
  assert.equal(elements.checkbox?.clicks, 1);
});

test("prefers an unchecked widget over a previously solved checkbox", async () => {
  const { browser, elements } = fixture();
  const solvedDocument = new FakeDocument();
  const previous = new FakeElement({ attributes: { "aria-checked": "true" } });
  solvedDocument.elementsBySelector.set(CHECKBOX_SELECTOR, [previous]);
  prependAnchor(browser, "a-previous", solvedDocument);
  await navigation(browser).clickCheckbox();
  assert.equal(previous.clicks, 0);
  assert.equal(elements.checkbox?.clicks, 1);
});

test("polls DOM readiness across all candidates instead of waiting only in the first frame", async () => {
  const { browser, checkboxFrame, elements } = fixture();
  prependAnchor(browser, "a-empty");
  checkboxFrame.elementsBySelector.delete(CHECKBOX_SELECTOR);
  const clock = new FakeClock();
  const originalSleep = clock.sleep.bind(clock);
  clock.sleep = async (ms) => {
    await originalSleep(ms);
    if (clock.current >= 20) checkboxFrame.elementsBySelector.set(CHECKBOX_SELECTOR, [elements.checkbox!]);
  };
  await navigation(browser, clock).clickCheckbox(100);
  assert.equal(elements.checkbox?.clicks, 1);
  assert.deepEqual(clock.sleeps.slice(0, 2), [10, 10]);
});

test("a frame access failure does not prevent selecting a later healthy widget", async () => {
  const { browser, elements } = fixture();
  const broken = new FakeDocument();
  broken.element = async () => { throw new CdpProtocolError("Page.createIsolatedWorld", "Frame detached"); };
  prependAnchor(browser, "a-broken", broken);
  await navigation(browser).clickCheckbox();
  assert.equal(elements.checkbox?.clicks, 1);
});

test("timeout preserves the frame protocol error as the checkbox failure cause", async () => {
  const browser = new FakeBrowser();
  const broken = new FakeDocument();
  const failure = new CdpProtocolError("Page.createIsolatedWorld", "Frame not available");
  broken.element = async () => { throw failure; };
  prependAnchor(browser, "a-broken", broken);
  await assert.rejects(navigation(browser).clickCheckbox(0), (error: unknown) => {
    assert.ok(error instanceof ChallengeElementNotFoundError);
    assert.equal(error.cause, failure);
    assert.match(error.message, /Page.createIsolatedWorld/);
    return true;
  });
});

test("a lost browser connection fails immediately instead of reporting a missing checkbox", async () => {
  const browser = new FakeBrowser();
  const failure = new CdpConnectionError("Connection closed");
  browser.elements = async () => { throw failure; };
  const clock = new FakeClock();
  const navigator = navigation(browser, clock);
  await assert.rejects(navigator.clickCheckbox(), error => error === failure);
  await assert.rejects(navigator.isSolved(), error => error === failure);
  assert.deepEqual(clock.sleeps, []);
});

test("completion stays with the chosen widget when another solved anchor appears first", async () => {
  const { browser, checkboxFrame } = fixture();
  checkboxFrame.elementsBySelector.delete(SOLVED_CHECKBOX_SELECTOR);
  const navigator = navigation(browser);
  assert.equal(await navigator.checkboxFrame(), checkboxFrame);
  const other = new FakeDocument();
  other.elementsBySelector.set(CHECKBOX_SELECTOR, [new FakeElement()]);
  other.elementsBySelector.set(SOLVED_CHECKBOX_SELECTOR, [new FakeElement()]);
  prependAnchor(browser, "a-other", other);
  assert.equal(await navigator.isSolved(0), false);
  checkboxFrame.elementsBySelector.delete(CHECKBOX_SELECTOR);
  assert.equal(await navigator.isSolved(0), false, "must not switch to an unrelated widget after removal");
});

test("reacquires a replaced iframe belonging to the selected widget", async () => {
  const { browser, checkboxFrame } = fixture();
  const navigator = navigation(browser);
  await navigator.checkboxFrame();
  checkboxFrame.elementsBySelector.clear();
  const replacement = new FakeDocument();
  replacement.elementsBySelector.set(CHECKBOX_SELECTOR, [new FakeElement()]);
  replacement.elementsBySelector.set(SOLVED_CHECKBOX_SELECTOR, [new FakeElement()]);
  prependAnchor(browser, "a-widget", replacement);
  assert.equal(await navigator.isSolved(0), true);
});

test("ignores hidden and empty challenge frames until a visible Verify control exists", async () => {
  const { browser, challengeFrame } = fixture();
  const empty = new FakeElement({ attributes: { src: "https://www.google.com/recaptcha/api2/bframe" } });
  browser.frames.set(empty, new FakeDocument());
  browser.elementsBySelector.set("t:iframe", [empty, ...browser.elementsBySelector.get("t:iframe")!]);
  assert.equal(await navigation(browser).challengeFrame(0), challengeFrame);
});
