// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as delay } from "node:timers/promises";

import type { CdpBrowser, CdpElement, CdpFrame } from "../browser/cdp/index.js";
import { CdpError } from "../browser/cdp/index.js";
import {
  CHECKBOX_SELECTOR,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  IMAGE_CONTAINER_SELECTOR,
  RELOAD_BUTTON_SELECTOR,
  SOLVED_CHECKBOX_SELECTOR,
  TILE_SELECTOR,
  VERIFY_BUTTON_SELECTOR,
} from "./constants.js";
import { ChallengeElementNotFoundError } from "./errors.js";

export interface NavigationClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface ChallengeNavigationOptions {
  defaultTimeoutMs?: number;
  pollIntervalMs?: number;
  interactionAttempts?: number;
  clock?: NavigationClock;
}

const systemClock: NavigationClock = {
  now: Date.now,
  async sleep(milliseconds): Promise<void> {
    await delay(milliseconds);
  },
};

function positiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function positiveInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

export class ChallengeNavigation {
  readonly #browser: CdpBrowser;
  readonly #clock: NavigationClock;
  readonly #defaultTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #interactionAttempts: number;

  constructor(browser: CdpBrowser, options: ChallengeNavigationOptions = {}) {
    this.#browser = browser;
    this.#clock = options.clock ?? systemClock;
    this.#defaultTimeoutMs = positiveTimeout(
      options.defaultTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#pollIntervalMs = positiveInterval(options.pollIntervalMs ?? 100, "pollIntervalMs");
    this.#interactionAttempts = positiveInteger(
      options.interactionAttempts ?? 2,
      "interactionAttempts",
    );
  }

  async checkboxFrame(timeoutMs = this.#defaultTimeoutMs * 2): Promise<CdpFrame | undefined> {
    return this.#findFrame(timeoutMs, async (iframe) => {
      const title = (await iframe.attr("title") ?? "").toLowerCase();
      const source = (await iframe.attr("src") ?? "").toLowerCase();
      return title.includes("recaptcha") && !title.includes("challenge") && !source.includes("bframe");
    });
  }

  async challengeFrame(timeoutMs = this.#defaultTimeoutMs * 2): Promise<CdpFrame | undefined> {
    return this.#findFrame(timeoutMs, async (iframe) => {
      const title = (await iframe.attr("title") ?? "").toLowerCase();
      if (title.includes("challenge")) return true;
      const source = (await iframe.attr("src") ?? "").toLowerCase();
      return source.includes("bframe");
    });
  }

  async clickCheckbox(timeoutMs = this.#defaultTimeoutMs): Promise<void> {
    for (let attempt = 0; attempt < this.#interactionAttempts; attempt += 1) {
      const frame = await this.checkboxFrame(timeoutMs);
      if (!frame) throw new ChallengeElementNotFoundError("Checkbox iframe not found.");
      const checkbox = await frame.element(CHECKBOX_SELECTOR, timeoutMs);
      if (!checkbox) throw new ChallengeElementNotFoundError("Checkbox element not found.");
      const before = await checkbox.interactionState();
      await checkbox.click();
      await this.#clock.sleep(Math.min(200, timeoutMs));
      if (await this.isSolved(0) || await this.challengeFrame(0)) return;
      const refreshedFrame = await this.checkboxFrame(0);
      const refreshed = await refreshedFrame?.element(CHECKBOX_SELECTOR, 0);
      if (refreshed && await refreshed.interactionState() !== before) return;
    }
    throw new ChallengeElementNotFoundError(
      "Checkbox clicks were dispatched but produced no observable state change.",
    );
  }

  async clickVerifyButton(timeoutMs = this.#defaultTimeoutMs): Promise<boolean> {
    for (let attempt = 0; attempt < this.#interactionAttempts; attempt += 1) {
      const frame = await this.challengeFrame(timeoutMs);
      const button = await frame?.element(VERIFY_BUTTON_SELECTOR, timeoutMs);
      if (!button) return false;
      const beforeButton = await button.interactionState();
      const beforeImages = await this.imageUrls(Math.min(1_000, timeoutMs));
      await button.click();
      await this.#clock.sleep(Math.min(200, timeoutMs));
      if (await this.isSolved(0)) return true;
      const refreshedFrame = await this.challengeFrame(0);
      if (!refreshedFrame) return true;
      const refreshedButton = await refreshedFrame.element(VERIFY_BUTTON_SELECTOR, 0);
      if (!refreshedButton || await refreshedButton.interactionState() !== beforeButton) return true;
      const afterImages = await this.imageUrls(Math.min(1_000, timeoutMs));
      if (JSON.stringify(afterImages) !== JSON.stringify(beforeImages)) return true;
    }
    return false;
  }

  async clickReloadButton(timeoutMs = this.#defaultTimeoutMs): Promise<boolean> {
    return this.#clickChallengeElement(RELOAD_BUTTON_SELECTOR, timeoutMs);
  }

  async isSolved(timeoutMs = this.#defaultTimeoutMs / 2): Promise<boolean> {
    try {
      const frame = await this.checkboxFrame(timeoutMs);
      return frame ? Boolean(await frame.element(SOLVED_CHECKBOX_SELECTOR, timeoutMs)) : false;
    } catch (error) {
      if (error instanceof CdpError) return false;
      throw error;
    }
  }

  async isVerifyButtonDisabled(timeoutMs = this.#defaultTimeoutMs / 5): Promise<boolean> {
    try {
      const frame = await this.challengeFrame(timeoutMs);
      if (!frame) return false;
      const button = await frame.element(VERIFY_BUTTON_SELECTOR, timeoutMs);
      if (!button) return false;
      return await button.attr("disabled") !== null;
    } catch (error) {
      if (error instanceof CdpError) return true;
      throw error;
    }
  }

  async waitForVerifyResult(timeoutMs = this.#defaultTimeoutMs): Promise<boolean> {
    const timeout = positiveTimeout(timeoutMs, "timeoutMs");
    const deadline = this.#clock.now() + timeout;
    await this.#clock.sleep(Math.min(100, timeout));
    while (this.#clock.now() < deadline) {
      if (await this.isSolved(1_000)) return true;
      if (!await this.isVerifyButtonDisabled(1_000)) {
        await this.#clock.sleep(200);
        return this.isSolved(2_000);
      }
      await this.#clock.sleep(this.#pollIntervalMs);
    }
    return this.isSolved(2_000);
  }

  async targetKeyword(timeoutMs = this.#defaultTimeoutMs): Promise<string | undefined> {
    try {
      const frame = await this.challengeFrame(timeoutMs);
      const payload = await frame?.element(".rc-imageselect-payload", 2_000);
      const strong = await payload?.element("tag:strong", 2_000);
      const keyword = (await strong?.text())?.trim().toLowerCase();
      return keyword || undefined;
    } catch (error) {
      if (error instanceof CdpError) return undefined;
      throw error;
    }
  }

  async challengeTitle(timeoutMs = this.#defaultTimeoutMs): Promise<string> {
    try {
      const frame = await this.challengeFrame(timeoutMs);
      const element = await frame?.element(".rc-imageselect-instructions", 2_000);
      return await element?.text() ?? "";
    } catch (error) {
      if (error instanceof CdpError) return "";
      throw error;
    }
  }

  async imageUrls(timeoutMs = this.#defaultTimeoutMs): Promise<string[]> {
    try {
      const frame = await this.challengeFrame(timeoutMs);
      if (!frame) return [];
      const selectors = [
        IMAGE_CONTAINER_SELECTOR,
        "t:img",
        ".rc-image-tile-wrapper img",
        ".rc-imageselect-tile img",
        "#rc-imageselect-target .rc-image-tile-wrapper img",
      ];
      for (const selector of selectors) {
        try {
          const images = await frame.elements(selector);
          const urls: string[] = [];
          for (const image of images) {
            const source = await image.attr("src");
            if (source?.includes("payload")) urls.push(source);
          }
          if (urls.length > 0) return urls;
        } catch (error) {
          if (!(error instanceof CdpError)) throw error;
        }
      }
      return [];
    } catch (error) {
      if (error instanceof CdpError) return [];
      throw error;
    }
  }

  async clickTile(cell: number, timeoutMs = this.#defaultTimeoutMs): Promise<boolean> {
    if (!Number.isInteger(cell) || cell < 1) return false;
    try {
      const selectors = [".rc-image-tile-wrapper", "css:td.rc-imageselect-tile", TILE_SELECTOR];
      for (let attempt = 0; attempt < this.#interactionAttempts; attempt += 1) {
        try {
          const frame = await this.challengeFrame(timeoutMs);
          if (!frame) return false;
          let selector: string | undefined;
          let tile: CdpElement | undefined;
          for (const candidate of selectors) {
            tile = (await frame.elements(candidate))[cell - 1];
            if (tile) {
              selector = candidate;
              break;
            }
          }
          if (!tile || !selector) return false;
          const before = await tile.interactionState();
          await tile.click();
          await this.#clock.sleep(Math.min(300, timeoutMs));
          const refreshedFrame = await this.challengeFrame(0);
          if (!refreshedFrame) return true;
          const refreshed = (await refreshedFrame.elements(selector))[cell - 1];
          if (!refreshed || await refreshed.interactionState() !== before) return true;
        } catch (error) {
          if (!(error instanceof CdpError)) throw error;
        }
      }
      return false;
    } catch (error) {
      if (error instanceof CdpError) return false;
      throw error;
    }
  }

  async #clickChallengeElement(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      const frame = await this.challengeFrame(timeoutMs);
      const element = await frame?.element(selector, timeoutMs);
      if (!element) return false;
      await element.click();
      return true;
    } catch (error) {
      if (error instanceof CdpError) return false;
      throw error;
    }
  }

  async #findFrame(
    timeoutMs: number,
    predicate: (iframe: CdpElement) => Promise<boolean>,
  ): Promise<CdpFrame | undefined> {
    const timeout = positiveTimeout(timeoutMs, "timeoutMs");
    const deadline = this.#clock.now() + timeout;
    while (true) {
      try {
        for (const iframe of await this.#browser.elements("t:iframe")) {
          if (await predicate(iframe)) return this.#browser.frame(iframe);
        }
      } catch (error) {
        if (!(error instanceof CdpError)) throw error;
      }
      if (this.#clock.now() >= deadline) return undefined;
      await this.#clock.sleep(this.#pollIntervalMs);
    }
  }
}
