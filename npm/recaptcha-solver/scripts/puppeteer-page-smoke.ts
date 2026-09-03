// SPDX-License-Identifier: AGPL-3.0-only

import { solveReCaptcha } from "../src/index.js";
import type { PuppeteerPageLike } from "../src/types.js";

interface SmokePage extends PuppeteerPageLike {
  goto(url: string): Promise<unknown>;
}

interface SmokeBrowser {
  newPage(): Promise<SmokePage>;
  close(): Promise<void>;
}

interface PuppeteerModule {
  default?: { connect(options: { browserWSEndpoint: string }): Promise<SmokeBrowser> };
  connect?: (options: { browserWSEndpoint: string }) => Promise<SmokeBrowser>;
}

if (process.env.RECAPTCHA_SOLVER_LIVE_APPROVED !== "YES") {
  throw new Error(
    "Set RECAPTCHA_SOLVER_LIVE_APPROVED=YES only for a page you own or are authorized to test.",
  );
}

const targetUrl = process.env.RECAPTCHA_SOLVER_TARGET_URL?.trim();
if (!targetUrl) throw new Error("RECAPTCHA_SOLVER_TARGET_URL is required.");
const browserWSEndpoint = process.env.RECAPTCHA_SOLVER_CDP_WS_ENDPOINT?.trim();
if (!browserWSEndpoint) {
  throw new Error("RECAPTCHA_SOLVER_CDP_WS_ENDPOINT is required for the Puppeteer Page smoke test.");
}

// Keep puppeteer-core optional for the solver package. This smoke test loads the
// caller-provided installation only when explicitly run.
const puppeteerPackage = "puppeteer-core";
const loaded = await import(puppeteerPackage) as PuppeteerModule;
const connect = loaded.default?.connect ?? loaded.connect;
if (!connect) throw new Error("The installed puppeteer-core package has no connect() function.");

const browser = await connect({ browserWSEndpoint });
try {
  const page = await browser.newPage();
  await page.goto(targetUrl);
  const result = await solveReCaptcha({
    page,
    targetUrl,
    clickCheckbox: process.env.RECAPTCHA_SOLVER_CLICK_CHECKBOX !== "0",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
